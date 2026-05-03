#!/bin/bash
# Smart deploy script for andykeys.me
# Detects what changed and only applies what's needed:
#   - Always pulls latest code
#   - Always ensures nginx config is rendered and symlinked (idempotent)
#   - npm install (if backend/package.json changed)
#   - psql -f schema.sql (if backend/db/schema.sql changed)
#   - render + reload nginx (if template changed or config missing)
#   - pm2 restart (if any backend file changed)
# Run on the Pi: bash ~/MyPortfolioSite/scripts/prod-deploy.sh
set -e

REPO_DIR="$HOME/MyPortfolioSite"
cd "$REPO_DIR"

echo "=== Fetching latest ==="
git fetch origin main

# Detect what's about to change before pulling
CHANGES=$(git diff HEAD..origin/main --name-only)
BACKEND_CHANGED=$(echo "$CHANGES" | grep -c "^backend/" || true)
PACKAGES_CHANGED=$(echo "$CHANGES" | grep -c "^backend/package" || true)
SCHEMA_CHANGED=$(echo "$CHANGES" | grep -c "^backend/db/schema.sql$" || true)
NGINX_CHANGED=$(echo "$CHANGES" | grep -c "^scripts/nginx-portfolio.conf.template$" || true)

if [ -z "$CHANGES" ]; then
    echo "Already up to date — nothing to deploy."
    pm2 status portfolio-backend
    exit 0
fi

echo ""
echo "Changes incoming:"
echo "$CHANGES"
echo ""

echo "=== Pulling ==="
git pull origin main

# Ensure uploads dir exists (covered by .gitkeep but be defensive)
mkdir -p "$REPO_DIR/uploads"

# Install deps if package.json changed
if [ "$PACKAGES_CHANGED" -gt 0 ]; then
    echo "=== package.json changed — installing dependencies ==="
    cd backend
    npm install --omit=dev --silent
    cd "$REPO_DIR"
fi

# Apply DB schema if it changed
# Schema is idempotent (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS)
if [ "$SCHEMA_CHANGED" -gt 0 ]; then
    echo "=== schema.sql changed — applying migration ==="
    if [ -f backend/.env ]; then
        DB_NAME=$(grep "^DB_NAME=" backend/.env | cut -d= -f2)
        if [ -n "$DB_NAME" ]; then
            sudo -u postgres psql -d "$DB_NAME" -f backend/db/schema.sql
            sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL ON ALL TABLES IN SCHEMA public TO $(grep '^DB_USER=' backend/.env | cut -d= -f2);"
            sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO $(grep '^DB_USER=' backend/.env | cut -d= -f2);"
        else
            echo "  WARN: DB_NAME not set in backend/.env — skipping schema apply"
        fi
    else
        echo "  WARN: backend/.env missing — skipping schema apply"
    fi
fi

# ── Nginx — always ensure config is rendered and symlinked ───────────────────
# Runs if: template changed OR config file is missing OR symlink is missing.
NGINX_CONF=/etc/nginx/sites-available/portfolio
NGINX_LINK=/etc/nginx/sites-enabled/portfolio

if [ "$NGINX_CHANGED" -gt 0 ] || [ ! -f "$NGINX_CONF" ] || [ ! -L "$NGINX_LINK" ]; then
    echo "=== Rendering and applying nginx config ==="
    if [ -f backend/.env ]; then
        DOMAIN=$(grep "^WEBAUTHN_RP_ID=" backend/.env | cut -d= -f2)
        APP_PORT=$(grep "^PORT=" backend/.env | cut -d= -f2)
        APP_PORT=${APP_PORT:-8080}

        if [ -z "$DOMAIN" ]; then
            echo "  WARN: WEBAUTHN_RP_ID not set in backend/.env — skipping nginx update"
        else
            command -v envsubst >/dev/null || sudo apt-get install -y gettext-base

            BACKEND_HOST=127.0.0.1
            export DOMAIN REPO_DIR APP_PORT BACKEND_HOST
            envsubst '${DOMAIN} ${REPO_DIR} ${APP_PORT} ${BACKEND_HOST}' \
                < "$REPO_DIR/scripts/nginx-portfolio.conf.template" \
                > /tmp/portfolio.conf

            sudo cp /tmp/portfolio.conf "$NGINX_CONF"
            rm /tmp/portfolio.conf

            # Idempotent symlink
            sudo ln -sf "$NGINX_CONF" "$NGINX_LINK"
            sudo rm -f /etc/nginx/sites-enabled/default

            if sudo nginx -t; then
                sudo systemctl reload nginx
                echo "  Nginx reloaded."
            else
                echo "  ERROR: nginx -t failed — config not reloaded. Fix the template and re-deploy." >&2
                exit 1
            fi
        fi
    else
        echo "  WARN: backend/.env missing — skipping nginx update"
    fi
else
    echo "=== Nginx config unchanged and already applied — skipping ==="
fi

# Restart backend if any backend file changed
if [ "$BACKEND_CHANGED" -gt 0 ]; then
    echo "=== Backend changed — restarting PM2 ==="
    pm2 restart portfolio-backend
    sleep 1
else
    echo "=== No backend changes — PM2 not restarted ==="
fi

echo ""
echo "=== Status ==="
pm2 status portfolio-backend

echo ""
echo "Done! https://andykeys.me"
