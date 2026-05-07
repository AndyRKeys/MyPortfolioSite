#!/bin/bash
# Production deploy script for andykeys.me (Docker Compose).
# Fetches latest main, rebuilds images, and restarts containers.
# Run on the server: bash ~/MyPortfolioSite/scripts/deploy/prod-deploy.sh
# Rollback: bash ~/MyPortfolioSite/scripts/deploy/prod-deploy.sh --rollback <sha>
set -e

REPO_DIR="$HOME/MyPortfolioSite"
COMPOSE="docker compose -f docker-compose.prod.yml"
DEPLOY_LOG="$HOME/deploy.log"

ROLLBACK_SHA=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --rollback) ROLLBACK_SHA="$2"; shift 2 ;;
        *) shift ;;
    esac
done

cd "$REPO_DIR"
PRE_SHA=$(git rev-parse HEAD)

# ── Rollback path ─────────────────────────────────────────────────────────────
if [ -n "$ROLLBACK_SHA" ]; then
    echo "=== Rolling back to $ROLLBACK_SHA ==="
    git reset --hard "$ROLLBACK_SHA"
    $COMPOSE up -d --build
    echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') rollback $PRE_SHA → $ROLLBACK_SHA" >> "$DEPLOY_LOG"
    echo "=== Rollback complete ==="
    exit 0
fi

# ── Fetch changes ─────────────────────────────────────────────────────────────
echo "=== Fetching latest ==="
git fetch origin main

CHANGES=$(git diff HEAD..origin/main --name-only)
if [ -z "$CHANGES" ]; then
    echo "Already up to date."
    $COMPOSE ps
    exit 0
fi

echo "Changes incoming:"
echo "$CHANGES"
echo ""

echo "=== Resetting to origin/main ==="
git reset --hard origin/main
echo "  Reset to $(git rev-parse --short HEAD)."

mkdir -p "$REPO_DIR/uploads"

# ── Build and restart containers ──────────────────────────────────────────────
echo "=== Building and restarting containers ==="
$COMPOSE up -d --build

# ── Health checks ─────────────────────────────────────────────────────────────
echo ""
echo "=== Health checks ==="

MAX_WAIT=30; ELAPSED=0
until $COMPOSE exec -T backend wget -q --spider "http://localhost:${PORT:-8080}/health" 2>/dev/null; do
    if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
        echo "ERROR: Backend health check timed out after ${MAX_WAIT}s" >&2
        $COMPOSE logs --tail=30 backend
        exit 1
    fi
    sleep 2; ELAPSED=$((ELAPSED + 2))
done
echo "  Backend ✓"

HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" http://localhost/health || echo "000")
[ "$HTTP_CODE" = "200" ] && echo "  HTTP nginx proxy ✓" || echo "  WARN: HTTP returned $HTTP_CODE"

DOMAIN=$(grep "^DOMAIN=" .env 2>/dev/null | cut -d= -f2)
if [ -n "$DOMAIN" ] && [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    HTTPS_CODE=$(curl -sf -o /dev/null -w "%{http_code}" "https://$DOMAIN/health" 2>/dev/null || echo "000")
    [ "$HTTPS_CODE" = "200" ] && echo "  HTTPS $DOMAIN ✓" || echo "  WARN: HTTPS returned $HTTPS_CODE"
fi

POST_SHA=$(git rev-parse HEAD)
echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') deploy $PRE_SHA -> $POST_SHA" >> "$DEPLOY_LOG"
echo ""
echo "Done! https://$DOMAIN"
