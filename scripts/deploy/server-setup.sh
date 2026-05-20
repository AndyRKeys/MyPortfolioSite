#!/bin/bash
# Ubuntu Server initial setup for andykeys.me
# Run once as a non-root user with sudo access after a fresh Ubuntu Server LTS install.
# Usage: bash server-setup.sh <domain>
# Example: bash server-setup.sh andykeys.me
set -e

REPO_DIR="$HOME/MyPortfolioSite"
DOMAIN="${1:-}"

if [ -z "$DOMAIN" ]; then
    echo "Usage: bash server-setup.sh <domain>"
    echo "  Example: bash server-setup.sh andykeys.me"
    exit 1
fi

echo "=== Ubuntu Server setup for $DOMAIN ==="
echo ""

# ── System packages ───────────────────────────────────────────────────────────
echo "--- Installing system packages ---"
sudo apt-get update -qq
sudo apt-get install -y -qq curl git gettext-base certbot rclone
echo "  Packages installed."

# ── Docker ────────────────────────────────────────────────────────────────────
echo "--- Installing Docker ---"
if ! command -v docker &>/dev/null; then
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker "$USER"
    echo ""
    echo "  Docker installed. You must log out and back in for the docker group"
    echo "  to take effect, then re-run this script."
    exit 0
fi
echo "  Docker $(docker --version | cut -d' ' -f3 | tr -d ',') already installed."

# ── SSH hardening ─────────────────────────────────────────────────────────────
echo "--- Hardening SSH ---"
if grep -qE "^#?PasswordAuthentication yes" /etc/ssh/sshd_config 2>/dev/null; then
    sudo sed -i 's/^#\?PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
    sudo systemctl reload sshd
    echo "  SSH password auth disabled. Ensure your public key is in ~/.ssh/authorized_keys!"
else
    echo "  SSH password auth already disabled."
fi

# ── Clone repo ────────────────────────────────────────────────────────────────
echo "--- Cloning repository ---"
if [ ! -d "$REPO_DIR" ]; then
    git clone https://github.com/AndyRKeys/MyPortfolioSite.git "$REPO_DIR"
    echo "  Cloned to $REPO_DIR"
else
    echo "  Repo already exists at $REPO_DIR — pulling latest main..."
    cd "$REPO_DIR"
    git fetch origin main
    git reset --hard origin/main
fi

# ── .env file ─────────────────────────────────────────────────────────────────
echo "--- Configuring .env ---"
cd "$REPO_DIR"
if [ ! -f ".env" ]; then
    cp .env.example .env
    sed -i "s/^DOMAIN=.*/DOMAIN=$DOMAIN/" .env
    sed -i "s/^WEBAUTHN_RP_ID=.*/WEBAUTHN_RP_ID=$DOMAIN/" .env
    sed -i "s|^WEBAUTHN_ORIGIN=.*|WEBAUTHN_ORIGIN=https://$DOMAIN|" .env
    sed -i "s|^FRONTEND_URL=.*|FRONTEND_URL=https://$DOMAIN|" .env
    echo ""
    echo "  .env created. EDIT IT NOW before continuing:"
    echo "    $REPO_DIR/.env"
    echo ""
    echo "  Required values to set:"
    echo "    JWT_SECRET    — generate with: openssl rand -base64 48"
    echo "    DB_PASSWORD   — any strong password"
    echo "    SMTP_USER / SMTP_PASS / ADMIN_EMAIL — for contact form + magic links"
    echo ""
    read -r -p "Press Enter after editing .env to continue..."
else
    echo "  .env already exists — skipping. Review it for correctness."
fi

# ── Directories ───────────────────────────────────────────────────────────────
mkdir -p "$REPO_DIR/uploads"
mkdir -p "$HOME/backups"
echo "  uploads/ and ~/backups/ directories ready."

# ── SSL certificate ───────────────────────────────────────────────────────────
echo ""
echo "--- Requesting SSL certificate ---"
echo "  Ensure DNS A record for $DOMAIN points to this server's public IP."
echo "  Ensure port 80 is open in firewall/router."
echo ""

if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    ADMIN_EMAIL_VAL=$(grep "^ADMIN_EMAIL=" "$REPO_DIR/.env" 2>/dev/null | cut -d= -f2)
    if [ -z "$ADMIN_EMAIL_VAL" ]; then
        read -r -p "  Enter email for Let's Encrypt notifications: " ADMIN_EMAIL_VAL
    fi
    sudo certbot certonly --standalone \
        -d "$DOMAIN" -d "www.$DOMAIN" \
        --non-interactive --agree-tos \
        --email "$ADMIN_EMAIL_VAL" || {
        echo ""
        echo "  WARN: certbot failed. Check DNS propagation and port 80, then run:"
        echo "    sudo certbot certonly --standalone -d $DOMAIN -d www.$DOMAIN"
        echo "  Then re-run this script to continue."
        exit 1
    }
    echo "  SSL cert issued for $DOMAIN."
else
    echo "  SSL cert already exists for $DOMAIN."
fi

# ── Start production services ─────────────────────────────────────────────────
echo ""
echo "--- Starting production containers ---"
cd "$REPO_DIR"
docker compose -f docker-compose.yml up -d --build
echo "  Containers started."

# ── Cron jobs ─────────────────────────────────────────────────────────────────
echo ""
echo "--- Installing cron jobs ---"
CRON_BACKUP="0 2 * * * $REPO_DIR/scripts/backup/db-backup.sh >> $HOME/backup.log 2>&1"
CRON_CERTBOT="0 3 1 */2 * $REPO_DIR/scripts/backup/certbot-renew.sh >> $HOME/certbot-renew.log 2>&1"

(crontab -l 2>/dev/null | grep -v "db-backup.sh\|certbot-renew.sh"; \
 echo "$CRON_BACKUP"; echo "$CRON_CERTBOT") | crontab -
echo "  DB backup cron: daily at 02:00"
echo "  Cert renewal cron: 1st of every other month at 03:00"

# ── Wait for services to be healthy ──────────────────────────────────────────
echo ""
echo "--- Waiting for services to be healthy ---"
MAX_WAIT=60; ELAPSED=0
cd "$REPO_DIR"
until docker compose -f docker-compose.yml exec -T backend \
    wget -q --spider http://localhost:8080/health 2>/dev/null; do
    if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
        echo "ERROR: Backend not healthy after ${MAX_WAIT}s"
        docker compose -f docker-compose.yml logs --tail=30 backend
        exit 1
    fi
    sleep 3; ELAPSED=$((ELAPSED + 3))
done
echo "  Backend healthy."

HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" "http://$DOMAIN/api/health" || echo "000")
[ "$HTTP_CODE" = "200" ] && echo "  HTTP proxy ✓" || echo "  WARN: HTTP /api/health returned $HTTP_CODE"

HTTPS_CODE=$(curl -sf -o /dev/null -w "%{http_code}" "https://$DOMAIN/api/health" 2>/dev/null || echo "000")
[ "$HTTPS_CODE" = "200" ] && echo "  HTTPS proxy ✓" || echo "  WARN: HTTPS /api/health returned $HTTPS_CODE"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════"
echo "  Setup complete — https://$DOMAIN"
echo "════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Test the site: https://$DOMAIN"
echo "  2. Set up rclone for offsite backups:"
echo "       rclone config"
echo "       # Add remote named 'b2' pointing to Backblaze B2"
echo "       # Then set RCLONE_REMOTE=b2 and RCLONE_BUCKET in .env"
echo "  3. Verify backup works: $REPO_DIR/scripts/backup/db-backup.sh"
echo "  4. Decommission the old Pi once you've confirmed the new server is stable."
echo ""
