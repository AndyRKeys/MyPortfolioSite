#!/bin/bash
# Smart deploy script for andykeys.me
# Detects what changed and only applies what's needed:
#   - Always fetches and hard-resets to origin/main (discards any local changes)
#   - Always runs npm install (ensures no missing packages)
#   - Renders nginx config from template if changed/missing (SSL-aware)
#   - Applies DB schema if changed OR if DB is empty (fresh server)
#   - Restarts PM2 if backend changed
#   - Post-deploy health check: verifies HTTP, HTTPS, and backend
# Run on the Pi: bash ~/MyPortfolioSite/scripts/deploy/prod-deploy.sh
set -e

REPO_DIR="$HOME/MyPortfolioSite"
DEPLOY_LOG="$HOME/deploy.log"

# Parse optional --rollback <sha> flag
ROLLBACK_SHA=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --rollback) ROLLBACK_SHA="$2"; shift 2 ;;
        *) shift ;;
    esac
done

cd "$REPO_DIR"

PRE_DEPLOY_SHA=$(git rev-parse HEAD)

# ── Rollback path ────────────────────────────────────────────────────────────
if [ -n "$ROLLBACK_SHA" ]; then
    echo "=== Rolling back to $ROLLBACK_SHA ==="
    git reset --hard "$ROLLBACK_SHA"
    cd "$REPO_DIR/backend" && npm install --omit=dev --silent && cd "$REPO_DIR"
    pm2 restart portfolio-backend
    echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') rollback $PRE_DEPLOY_SHA → $ROLLBACK_SHA" >> "$DEPLOY_LOG"
    echo "=== Rollback complete ==="
    pm2 status portfolio-backend
    exit 0
fi

echo "=== Fetching latest ==="
git fetch origin main

CHANGES=$(git diff HEAD..origin/main --name-only)
BACKEND_CHANGED=$(echo "$CHANGES" | grep -c "^backend/" || true)
SCHEMA_CHANGED=$(echo "$CHANGES" | grep -c "^backend/db/schema.sql$" || true)
NGINX_CHANGED=$(echo "$CHANGES" | grep -c "^scripts/deploy/nginx-portfolio.conf.template$" || true)

if [ -z "$CHANGES" ]; then
    echo "Already up to date — nothing to deploy."
    pm2 status portfolio-backend
    exit 0
fi

echo ""
echo "Changes incoming:"
echo "$CHANGES"
echo ""

echo "=== Resetting to origin/main ==="
git reset --hard origin/main
echo "  Reset to $(git rev-parse --short HEAD)."

mkdir -p "$REPO_DIR/uploads"

echo "=== Installing backend dependencies ==="
cd "$REPO_DIR/backend"
npm install --omit=dev --silent
cd "$REPO_DIR"

# Apply schema if DB is empty (fresh server) OR schema.sql changed
if [ -f backend/.env ]; then
    DB_NAME=$(grep "^DB_NAME=" backend/.env | cut -d= -f2)
    DB_USER=$(grep "^DB_USER=" backend/.env | cut -d= -f2)
    if [ -n "$DB_NAME" ]; then
        TABLE_COUNT=$(sudo -u postgres psql -d "$DB_NAME" -tAc \
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';" \
            2>/dev/null || echo "0")
        TABLE_COUNT=$(echo "$TABLE_COUNT" | tr -d '[:space:]')

        if [ "$TABLE_COUNT" -eq 0 ]; then
            echo "=== Fresh DB detected — applying full schema ==="
            sudo -u postgres psql -d "$DB_NAME" -f backend/db/schema.sql
            sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL ON ALL TABLES IN SCHEMA public TO $DB_USER;"
            sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO $DB_USER;"
            echo "  Schema applied."
        elif [ "$SCHEMA_CHANGED" -gt 0 ]; then
            echo "=== schema.sql changed — applying migration ==="
            sudo -u postgres psql -d "$DB_NAME" -f backend/db/schema.sql
            sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL ON ALL TABLES IN SCHEMA public TO $DB_USER;"
            sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO $DB_USER;"
            echo "  Schema applied."
        else
            echo "=== DB already populated and schema.sql unchanged — skipping migration ==="
        fi
    else
        echo "  WARN: DB_NAME not set in backend/.env — skipping schema apply"
    fi
else
    echo "  WARN: backend/.env missing — skipping schema apply"
fi

NGINX_CONF=/etc/nginx/sites-available/portfolio
NGINX_LINK=/etc/nginx/sites-enabled/portfolio
CERT_PATH=/etc/letsencrypt/live

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

            if [ -f "$CERT_PATH/$DOMAIN/fullchain.pem" ]; then
                echo "  SSL cert found for $DOMAIN — rendering with HTTPS"
                TEMPLATE="$REPO_DIR/scripts/deploy/nginx-portfolio.conf.template"
            else
                echo "  WARN: No SSL cert found at $CERT_PATH/$DOMAIN — rendering HTTP-only"
                echo "  Run: sudo certbot --nginx -d $DOMAIN -d www.$DOMAIN"
                TEMPLATE=$(mktemp)
                cat > "$TEMPLATE" <<'HTTPONLY'
server {
    listen 80;
    server_name ${DOMAIN} www.${DOMAIN} raspberrypi3.local;
    root ${REPO_DIR};
    index index.html;
    client_max_body_size 25M;
    location /api/ {
        proxy_pass http://${BACKEND_HOST}:${APP_PORT}/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location /health {
        proxy_pass http://${BACKEND_HOST}:${APP_PORT}/health;
        proxy_set_header Host $host;
    }
    location /uploads/ {
        alias ${REPO_DIR}/uploads/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
    location / {
        try_files $uri $uri/ $uri.html =404;
    }
}
HTTPONLY
            fi

            envsubst '${DOMAIN} ${REPO_DIR} ${APP_PORT} ${BACKEND_HOST}' \
                < "$TEMPLATE" > /tmp/portfolio.conf
            [ -f "$TEMPLATE" ] && [[ "$TEMPLATE" == /tmp/* ]] && rm -f "$TEMPLATE"

            sudo cp /tmp/portfolio.conf "$NGINX_CONF"
            rm /tmp/portfolio.conf
            sudo ln -sf "$NGINX_CONF" "$NGINX_LINK"
            sudo rm -f /etc/nginx/sites-enabled/default

            if sudo nginx -t; then
                sudo systemctl reload nginx
                echo "  Nginx reloaded."
            else
                echo "  ERROR: nginx -t failed — config not reloaded." >&2
                exit 1
            fi
        fi
    else
        echo "  WARN: backend/.env missing — skipping nginx update"
    fi
else
    echo "=== Nginx config unchanged and already applied — skipping ==="
fi

if [ "$BACKEND_CHANGED" -gt 0 ]; then
    echo "=== Backend changed — restarting PM2 ==="
    pm2 restart portfolio-backend
else
    echo "=== No backend changes — reloading PM2 ==="
    pm2 reload portfolio-backend
fi

echo ""
echo "=== Health checks ==="
MAX_WAIT=20; ELAPSED=0
until curl -sf http://localhost:8080/health > /dev/null 2>&1; do
    if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
        echo "ERROR: Backend did not respond on :8080 after ${MAX_WAIT}s" >&2
        pm2 logs portfolio-backend --lines 30 --nostream
        exit 1
    fi
    sleep 2; ELAPSED=$((ELAPSED + 2))
done
echo "  Backend :8080        ✓"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost/health)
[ "$HTTP_CODE" = "200" ] && echo "  HTTP nginx proxy     ✓" || echo "  WARN: HTTP nginx returned $HTTP_CODE" >&2

DOMAIN=$(grep "^WEBAUTHN_RP_ID=" backend/.env 2>/dev/null | cut -d= -f2)
if [ -n "$DOMAIN" ] && [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    HTTPS_CODE=$(curl -sf -o /dev/null -w "%{http_code}" https://$DOMAIN/health 2>/dev/null || echo "000")
    [ "$HTTPS_CODE" = "200" ] && echo "  HTTPS $DOMAIN ✓" || echo "  WARN: HTTPS returned $HTTPS_CODE" >&2
fi

echo ""
echo "=== PM2 Status ==="
pm2 status portfolio-backend
POST_SHA=$(git rev-parse HEAD)
echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') deploy $POST_SHA" >> "$DEPLOY_LOG"

echo ""
echo "Done! https://$DOMAIN"
