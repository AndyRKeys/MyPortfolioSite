#!/bin/bash
# Smart deploy script for andykeys.me
# Detects what changed and only restarts what's needed.
# Run on the Pi: bash ~/MyPortfolioSite/scripts/deploy.sh
set -e

REPO_DIR="$HOME/MyPortfolioSite"
cd "$REPO_DIR"

echo "=== Fetching latest ==="
git fetch origin main

# Detect what's about to change before pulling
BACKEND_CHANGED=$(git diff HEAD..origin/main --name-only | grep -c "^backend/" || true)
PACKAGES_CHANGED=$(git diff HEAD..origin/main --name-only | grep -c "^backend/package" || true)
FRONTEND_CHANGED=$(git diff HEAD..origin/main --name-only | grep -cE "\.(html|css|js)$" | grep -v "^backend/" || true)
CHANGES=$(git diff HEAD..origin/main --name-only)

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

# Install deps if package.json changed
if [ "$PACKAGES_CHANGED" -gt 0 ]; then
    echo "=== package.json changed — installing dependencies ==="
    cd backend
    npm install --omit=dev --silent
    cd "$REPO_DIR"
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
