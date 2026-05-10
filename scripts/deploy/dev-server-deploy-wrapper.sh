#!/usr/bin/env bash
# dev-server-deploy-wrapper.sh — Wrapper to update branch then run dev deploy.
#
# This script lives in MyPortfolioSite-dev and should be the main entrypoint
# for dev deploys. It ensures the working tree is updated to the requested
# branch *before* invoking the main dev-server-deploy.sh script, so the
# deploy script never updates itself mid-run.
#
# Usage:
#   bash scripts/deploy/dev-server-deploy-wrapper.sh [branch]
# Examples:
#   bash scripts/deploy/dev-server-deploy-wrapper.sh              # default branch
#   bash scripts/deploy/dev-server-deploy-wrapper.sh feature/219-dev-server-https

set -euo pipefail

DEPLOY_BRANCH="${1:-dev}"
DEV_REPO="${HOME}/MyPortfolioSite-dev"
REPO_URL="https://github.com/AndyRKeys/MyPortfolioSite.git"

echo "[DEBUG][wrapper] DEPLOY_BRANCH='$DEPLOY_BRANCH' DEV_REPO='$DEV_REPO'" >&2

# Ensure dev repo exists
if [ ! -d "$DEV_REPO/.git" ]; then
  echo "[INFO] Dev repo not found at $DEV_REPO — cloning..."
  git clone "$REPO_URL" "$DEV_REPO"
fi

cd "$DEV_REPO"

# Update working tree to the requested branch
# If the branch does not exist locally, try to create it tracking origin.
if ! git show-ref --verify --quiet "refs/heads/$DEPLOY_BRANCH"; then
  echo "[DEBUG][wrapper] Local branch '$DEPLOY_BRANCH' missing — creating from origin" >&2
  git fetch origin
  git checkout -B "$DEPLOY_BRANCH" "origin/$DEPLOY_BRANCH"
else
  echo "[DEBUG][wrapper] Updating existing branch '$DEPLOY_BRANCH' from origin" >&2
  git fetch origin "$DEPLOY_BRANCH"
  git checkout "$DEPLOY_BRANCH"
  git reset --hard "origin/$DEPLOY_BRANCH"
fi

echo "[DEBUG][wrapper] HEAD is now at $(git rev-parse --short HEAD) on branch '$DEPLOY_BRANCH'" >&2

# Now run the actual deploy script from the updated working tree
exec bash "$DEV_REPO/scripts/deploy/dev-server-deploy.sh" "$DEPLOY_BRANCH"
