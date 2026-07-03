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

# The queue dir must be writable by this user: trigger files may be created by
# other users (e.g. root inside the backend container via the bind mount), and
# unlinking them requires write permission on the directory itself. A root-owned
# queue dir caused a silent crash loop where no deploy ever ran (#487).
if [ ! -w "$QUEUE_DIR" ]; then
  echo "[deploy-daemon] FATAL: queue dir $QUEUE_DIR is not writable by $(id -un) — fix with: sudo chown $(id -un):$(id -gn) $QUEUE_DIR" >&2
  exit 1
fi

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

    # Remove the trigger BEFORE deploying so a crash can't re-run the deploy.
    # If removal fails (permissions regressed), skip the deploy entirely —
    # running it would repeat forever on every poll. Fail loud, stay alive.
    if ! rm -f "$req"; then
      echo "[deploy-daemon] ERROR: cannot remove trigger $req — check ownership of $QUEUE_DIR (sudo chown $(id -un):$(id -gn) $QUEUE_DIR). Deploy NOT run." >&2
      rm -f "$LOCK_FILE"
      sleep 30
      break
    fi

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
