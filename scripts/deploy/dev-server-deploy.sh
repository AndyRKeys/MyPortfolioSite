#!/usr/bin/env bash
# Deploy the dev branch to the server dev environment (LAN-only, port 3001).
# Run on the Ubuntu Server as the non-root user.
#
# First-time setup:
#   git clone https://github.com/AndyRKeys/MyPortfolioSite.git ~/MyPortfolioSite-dev
#   cd ~/MyPortfolioSite-dev && git checkout dev
#   cp .env.dev-server.example .env   # then edit with real values
#   sudo ufw allow from 192.168.0.0/16 to any port 3001 comment 'Dev site LAN-only'
#   bash scripts/deploy/dev-server-deploy.sh
set -euo pipefail

DEV_REPO="${HOME}/MyPortfolioSite-dev"
COMPOSE_FILE="${DEV_REPO}/docker-compose.dev-server.yml"
LOG_FILE="${HOME}/dev-deploy.log"

timestamp() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(timestamp)] $*" | tee -a "$LOG_FILE"; }

log "=== Dev deploy started ==="

if [ ! -d "$DEV_REPO" ]; then
    log "ERROR: $DEV_REPO does not exist."
    log "Run: git clone https://github.com/AndyRKeys/MyPortfolioSite.git $DEV_REPO"
    log "Then: cd $DEV_REPO && git checkout dev && cp .env.dev-server.example .env"
    exit 1
fi

if [ ! -f "${DEV_REPO}/.env" ]; then
    log "ERROR: ${DEV_REPO}/.env not found."
    log "Copy .env.dev-server.example to .env and fill in values."
    exit 1
fi

cd "$DEV_REPO"

log "Fetching latest dev branch..."
git fetch origin dev
git reset --hard origin/dev

log "Building and restarting dev services..."
docker compose -f "$COMPOSE_FILE" up -d --build

log "Waiting for dev site to become healthy..."
LAN_IP=$(grep '^LAN_IP=' "${DEV_REPO}/.env" | cut -d= -f2 | tr -d '[:space:]')
DEV_URL="http://${LAN_IP:-localhost}:3001"

for i in $(seq 1 12); do
    if curl -sf "${DEV_URL}/api/health" > /dev/null 2>&1; then
        log "✓ Dev site healthy at ${DEV_URL}"
        log "=== Dev deploy complete ==="
        exit 0
    fi
    sleep 5
done

log "✗ Health check failed after 60s — check logs:"
log "  docker compose -f $COMPOSE_FILE logs --tail=50 backend-dev"
exit 1
