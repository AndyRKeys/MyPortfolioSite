#!/bin/bash
# Offsite backup sync to Backblaze B2 (or any configured rclone remote).
# Invoked automatically by db-backup.sh after a local backup completes.
# Can also be run manually to force a sync.
#
# Setup:
#   1. Create a Backblaze B2 account at backblaze.com (free up to 10 GB)
#   2. Create a bucket and application key
#   3. Run: rclone config  — add a remote named 'b2' (type: b2)
#   4. Optionally set RCLONE_REMOTE / RCLONE_BUCKET in .env
set -e

BACKUP_DIR="$HOME/backups"
UPLOADS_DIR="$HOME/MyPortfolioSite/uploads"

# Load .env for optional overrides
REPO_DIR="$HOME/MyPortfolioSite"
set -a; source "$REPO_DIR/.env" 2>/dev/null || true; set +a

RCLONE_REMOTE="${RCLONE_REMOTE:-b2}"
RCLONE_BUCKET="${RCLONE_BUCKET:-portfolio-backups}"

if ! command -v rclone &>/dev/null; then
    echo "rclone not installed. Install: sudo apt install rclone"
    exit 1
fi

if ! rclone listremotes 2>/dev/null | grep -q "^${RCLONE_REMOTE}:"; then
    echo "rclone remote '${RCLONE_REMOTE}' not configured. Run: rclone config"
    exit 1
fi

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Offsite sync → ${RCLONE_REMOTE}:${RCLONE_BUCKET}"

# Sync DB dumps (keep last 30 days offsite)
rclone sync "$BACKUP_DIR" "${RCLONE_REMOTE}:${RCLONE_BUCKET}/db/" \
    --include "portfolio-*.sql.gz" \
    --max-age 30d \
    --transfers 2 \
    --quiet
echo "  DB dumps synced."

# Sync uploads (incremental — only new/changed files)
if [ -d "$UPLOADS_DIR" ]; then
    rclone sync "$UPLOADS_DIR" "${RCLONE_REMOTE}:${RCLONE_BUCKET}/uploads/" \
        --transfers 4 \
        --quiet
    echo "  Uploads synced."
fi

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Offsite sync complete."
