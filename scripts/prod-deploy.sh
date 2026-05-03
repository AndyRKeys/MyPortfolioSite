#!/bin/bash
# Production deploy script — runs ON the Raspberry Pi.
# Triggered remotely via: ssh raspberrypi3 "bash ~/MyPortfolioSite/scripts/prod-deploy.sh"
# Or run directly on the Pi from the repo root: bash scripts/prod-deploy.sh

set -e

REPO_DIR="$HOME/MyPortfolioSite"
cd "$REPO_DIR"

echo "==> Pulling latest from main..."
git pull origin main

echo "==> Checking for schema changes..."
if git diff HEAD~1 HEAD -- backend/db/schema.sql | grep -q '^[+-]' 2>/dev/null; then
  echo "==> Schema changes detected — applying migrations..."
  docker compose exec -T db psql -U "${DB_USER:-portfolio_user}" -d "${DB_NAME:-portfolio}" -f /docker-entrypoint-initdb.d/schema.sql
else
  echo "==> No schema changes."
fi

echo "==> Rebuilding and restarting containers..."
docker compose up --build -d

echo "==> Deploy complete."
