#!/usr/bin/env bash
# dev-server-deploy-wrapper.sh — Bootstrap wrapper for dev deploys.
#
# Solves the self-updating script problem: updates the working tree to the
# requested branch BEFORE invoking dev-deploy.sh, so the deploy always runs
# the latest version of the script, not the version that was loaded before the pull.
#
# This is the correct entrypoint for dev deploys. Call this, not dev-deploy.sh directly.
#
# Usage:
#   bash scripts/deploy/dev-server-deploy-wrapper.sh [branch]
# Examples:
#   bash scripts/deploy/dev-server-deploy-wrapper.sh                 # defaults to dev
#   bash scripts/deploy/dev-server-deploy-wrapper.sh fix/my-branch   # feature branch

set -euo pipefail

DEPLOY_BRANCH="${1:-dev}"
DEV_REPO="${HOME}/MyPortfolioSite-dev"
REPO_URL="https://github.com/AndyRKeys/MyPortfolioSite.git"

# Ensure dev repo exists
if [ ! -d "$DEV_REPO/.git" ]; then
  echo "[INFO] Dev repo not found at $DEV_REPO — cloning..."
  git clone "$REPO_URL" "$DEV_REPO"
fi

cd "$DEV_REPO"

# Switch working tree to requested branch before running the deploy script.
# If the branch does not exist locally, create it tracking origin.
if ! git show-ref --verify --quiet "refs/heads/$DEPLOY_BRANCH"; then
  echo "[INFO] Branch '$DEPLOY_BRANCH' not found locally — fetching from origin..."
  git fetch origin
  git checkout -B "$DEPLOY_BRANCH" "origin/$DEPLOY_BRANCH"
else
  git fetch origin "$DEPLOY_BRANCH"
  git checkout "$DEPLOY_BRANCH"
  git reset --hard "origin/$DEPLOY_BRANCH"
fi

echo "[INFO] HEAD is now at $(git rev-parse --short HEAD) on branch '$DEPLOY_BRANCH'"

# exec replaces this shell process — dev-deploy.sh runs with the updated code,
# deploy-lib.sh functions and any new additions are all picked up correctly.
exec bash "$DEV_REPO/scripts/deploy/dev-deploy.sh" "$DEPLOY_BRANCH"
