#!/bin/bash
# Certbot renewal — stops Nginx container, renews, restarts.
# Cron: 0 3 1 */2 * ~/MyPortfolioSite/scripts/backup/certbot-renew.sh
# Certbot skips renewal automatically if cert has >30 days remaining.
set -e

REPO_DIR="$HOME/MyPortfolioSite"
cd "$REPO_DIR"

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Checking SSL cert renewal..."

docker compose -f docker-compose.prod.yml stop nginx
sudo certbot renew --quiet
docker compose -f docker-compose.prod.yml start nginx

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Cert renewal check complete."
