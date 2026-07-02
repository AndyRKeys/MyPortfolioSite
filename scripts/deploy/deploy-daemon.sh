#!/usr/bin/env bash
# deploy-daemon.sh — Host-level deploy daemon.
# Polls ~/deploy-queue/ for JSON trigger files and calls deploy.sh on the host.
# Managed by systemd — never run directly.
set -euo pipefail

QUEUE_DIR="${HOME}/deploy-queue"
REPO_DIR_DEV="${HOME}/MyPortfolioSite-dev"
REPO_DIR_PROD="${HOME}/MyPortfolioSite"
LOCK_FILE="${HOME}/.deploy-daemon.lock"

mkdir -p "$QUEUE_DIR"
echo "[deploy-daemon] started pid=$$"

cleanup() { rm -f "$LOCK_FILE"; }
trap cleanup EXIT

while true; do
  for req in "$QUEUE_DIR"/*.json; do
    [ -f "$req" ] || continue

    if [ -f "$LOCK_FILE" ]; then
      echo "[deploy-daemon] lock held — another deploy in progress, skipping $req"
      break
    fi
    touch "$LOCK_FILE"

    env_val=$(jq -r '.env // empty' "$req")
    sha=$(jq -r '.rollback_sha // empty' "$req")
    rm -f "$req"

    if [ -z "$env_val" ]; then
      echo "[deploy-daemon] invalid trigger — missing env field, skipping"
      rm -f "$LOCK_FILE"
      continue
    fi

    case "$env_val" in
      dev)  REPO_DIR="$REPO_DIR_DEV" ;;
      prod) REPO_DIR="$REPO_DIR_PROD" ;;
      *)
        echo "[deploy-daemon] unknown env '$env_val' — skipping"
        rm -f "$LOCK_FILE"
        continue
        ;;
    esac

    args=(--env "$env_val")
    [ -n "$sha" ] && args+=(--rollback "$sha")

    echo "[deploy-daemon] triggering deploy env=$env_val sha=${sha:-none}"
    bash "$REPO_DIR/scripts/deploy/deploy.sh" "${args[@]}" || true
    rm -f "$LOCK_FILE"
    break
  done
  sleep 2
done
