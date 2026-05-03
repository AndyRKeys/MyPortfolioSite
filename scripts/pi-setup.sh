#!/bin/bash
# Portfolio site setup script for Raspberry Pi 3 (Raspberry Pi OS / Debian)
# Run as the 'pi' user: bash pi-setup.sh
set -e

REPO_DIR="$HOME/MyPortfolioSite"
DB_NAME="portfolio_db"
DB_USER="portfolio"
APP_PORT=8080

echo "=== Portfolio Pi Setup ==="

# ── 1. System packages ────────────────────────────────────────────────────────
echo "[1/7] Installing system packages..."
sudo apt-get update -qq
sudo apt-get install -y curl git nginx postgresql postgresql-contrib

# ── 2. Node.js 20 LTS ─────────────────────────────────────────────────────────
echo "[2/7] Installing Node.js 20..."
if ! command -v node &>/dev/null || [[ "$(node -e 'process.stdout.write(process.version.split(".")[0].replace("v",""))')" -lt 20 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi
echo "  Node $(node -v) / npm $(npm -v)"

# ── 3. PM2 ───────────────────────────────────────────────────────────────────
echo "[3/7] Installing PM2..."
sudo npm install -g pm2 --silent
pm2 startup systemd -u pi --hp /home/pi | tail -1 | sudo bash || true

# ── 4. PostgreSQL database + user ─────────────────────────────────────────────
echo "[4/7] Configuring PostgreSQL..."
sudo systemctl enable postgresql
sudo systemctl start postgresql

# Generate a random DB password
DB_PASS=$(openssl rand -base64 18 | tr -d '/+=')

sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';" 2>/dev/null || \
    sudo -u postgres psql -c "ALTER USER $DB_USER WITH PASSWORD '$DB_PASS';"
sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;" 2>/dev/null || true
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;"

# Run schema
sudo -u postgres psql -d $DB_NAME < "$REPO_DIR/backend/db/schema.sql"
sudo -u postgres psql -d $DB_NAME -c "GRANT ALL ON ALL TABLES IN SCHEMA public TO $DB_USER;"
sudo -u postgres psql -d $DB_NAME -c "GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO $DB_USER;"
echo "  DB password: $DB_PASS (saved to $REPO_DIR/backend/.env)"

# ── Uploads directory (served by Nginx as static files) ──────────────────────
mkdir -p "$REPO_DIR/uploads"
chmod 755 "$REPO_DIR/uploads"

# ── 5. Backend .env ───────────────────────────────────────────────────────────
echo "[5/7] Writing backend .env..."

# Prompt for values we can't generate
read -rp "  Your domain (e.g. andykeys.me) or press Enter to use raspberrypi3.local: " DOMAIN
DOMAIN=${DOMAIN:-raspberrypi3.local}

read -rp "  SMTP host (e.g. smtp.gmail.com): " SMTP_HOST
read -rp "  SMTP port (587): " SMTP_PORT
SMTP_PORT=${SMTP_PORT:-587}
read -rp "  SMTP user (your email): " SMTP_USER
read -rsp "  SMTP password / app password: " SMTP_PASS
echo ""
read -rp "  Admin email (where magic links go): " ADMIN_EMAIL

JWT_SECRET=$(openssl rand -hex 32)

cat > "$REPO_DIR/backend/.env" <<EOF
PORT=$APP_PORT
DB_HOST=localhost
DB_PORT=5432
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASS
JWT_SECRET=$JWT_SECRET
JWT_EXPIRY=7d
WEBAUTHN_RP_NAME=AK Portfolio
WEBAUTHN_RP_ID=$DOMAIN
WEBAUTHN_ORIGIN=https://$DOMAIN
FRONTEND_URL=https://$DOMAIN
SMTP_HOST=$SMTP_HOST
SMTP_PORT=$SMTP_PORT
SMTP_USER=$SMTP_USER
SMTP_PASS=$SMTP_PASS
ADMIN_EMAIL=$ADMIN_EMAIL
EOF

echo "  .env written."

# ── 6. npm install + PM2 ──────────────────────────────────────────────────────
echo "[6/7] Installing backend dependencies and starting with PM2..."
cd "$REPO_DIR/backend"
npm install --omit=dev --silent
pm2 delete portfolio-backend 2>/dev/null || true
pm2 start server.js --name portfolio-backend
pm2 save
cd "$HOME"

# ── 7. Nginx ──────────────────────────────────────────────────────────────────
echo "[7/7] Configuring Nginx..."

# envsubst lives in gettext-base; install if missing
command -v envsubst >/dev/null || sudo apt-get install -y gettext-base

export DOMAIN REPO_DIR APP_PORT
envsubst '${DOMAIN} ${REPO_DIR} ${APP_PORT}' \
    < "$REPO_DIR/scripts/nginx-portfolio.conf.template" \
    | sudo tee /etc/nginx/sites-available/portfolio > /dev/null

sudo ln -sf /etc/nginx/sites-available/portfolio /etc/nginx/sites-enabled/portfolio
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

echo ""
echo "=== Setup complete! ==="
echo ""
echo "  Backend: running on port $APP_PORT (PM2)"
echo "  Nginx:   serving on port 80"
echo "  Domain:  http://$DOMAIN"
echo ""
echo "Next steps:"
echo "  1. Clone or copy your site to: $REPO_DIR"
echo "     (if not already there — this script assumed it exists)"
echo "  2. Update resources/java/config.js: set API = ''"
echo "  3. Set up Cloudflare Tunnel for HTTPS public access"
echo "  4. Visit http://$DOMAIN/setup.html to create your admin account"
echo ""
echo "Test backend: curl http://localhost:$APP_PORT/health"
