#!/bin/bash
# PostgreSQL backup with rotation — database and uploads.
# Cron: 0 2 * * * ~/MyPortfolioSite/scripts/backup/db-backup.sh >> ~/backup.log 2>&1
# Keeps 7 daily backups locally; triggers offsite sync if rclone is configured.
set -e

REPO_DIR="$HOME/MyPortfolioSite"
BACKUP_DIR="$HOME/backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"
cd "$REPO_DIR"

# Load .env for DB credentials
set -a; source .env 2>/dev/null || true; set +a

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Starting backup..."

# ── DB dump ───────────────────────────────────────────────────────────────────
DB_BACKUP="$BACKUP_DIR/portfolio-$TIMESTAMP.sql.gz"
docker compose -f docker-compose.prod.yml exec -T postgres \
    pg_dump -U "${DB_USER:-postgres}" "${DB_NAME:-portfolio_prod}" \
    | gzip > "$DB_BACKUP"
echo "  DB:      $DB_BACKUP ($(du -sh "$DB_BACKUP" | cut -f1))"

# ── Uploads backup ────────────────────────────────────────────────────────────
if [ -d "$REPO_DIR/uploads" ] && [ "$(ls -A "$REPO_DIR/uploads" 2>/dev/null)" ]; then
    UPLOADS_BACKUP="$BACKUP_DIR/uploads-$TIMESTAMP.tar.gz"
    tar -czf "$UPLOADS_BACKUP" -C "$REPO_DIR" uploads/
    echo "  Uploads: $UPLOADS_BACKUP ($(du -sh "$UPLOADS_BACKUP" | cut -f1))"
fi

# ── Rotation: prune backups older than 7 days ─────────────────────────────────
find "$BACKUP_DIR" -name "portfolio-*.sql.gz" -mtime +7 -delete
find "$BACKUP_DIR" -name "uploads-*.tar.gz"   -mtime +7 -delete
echo "  Pruned backups older than 7 days."

# ── Offsite sync (non-blocking, if rclone is configured) ─────────────────────
if command -v rclone &>/dev/null && rclone listremotes 2>/dev/null | grep -q .; then
    "$REPO_DIR/scripts/backup/offsite-sync.sh" >> "$HOME/offsite-sync.log" 2>&1 &
    echo "  Offsite sync started in background."
fi

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Backup complete."
