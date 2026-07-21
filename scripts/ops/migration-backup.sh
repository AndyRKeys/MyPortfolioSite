#!/bin/bash
# Pre-migration snapshot — run immediately before Phase 2 (fresh OS install).
# Takes a fresh prod DB backup, dumps the dev DB, and archives SSL certs.
# Safe to run multiple times; does NOT rotate or prune any existing backups.
set -euo pipefail

PROD_REPO="$HOME/MyPortfolioSite"
DEV_REPO="$HOME/MyPortfolioSite-dev"
DEV_BACKUP_DIR="$HOME/backups/dev"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Starting pre-migration backup..."

# ── Prod DB + uploads ─────────────────────────────────────────────────────────
echo "  [prod] Calling db-backup.sh..."
bash "$PROD_REPO/scripts/backup/db-backup.sh"
echo "  [prod] db-backup.sh complete."

# ── Dev DB ────────────────────────────────────────────────────────────────────
echo "  [dev] Dumping dev DB..."
cd "$DEV_REPO"
set -a; source .env 2>/dev/null || true; set +a

mkdir -p "$DEV_BACKUP_DIR"
DEV_DB_BACKUP="$DEV_BACKUP_DIR/dev-$TIMESTAMP.sql.gz"

docker compose -f docker-compose.yml exec -T postgres \
    pg_dump -U "${DB_USER:-postgres}" "${DB_NAME:-portfolio_dev}" \
    | gzip > "$DEV_DB_BACKUP"
echo "  [dev] DB:  $DEV_DB_BACKUP ($(du -sh "$DEV_DB_BACKUP" | cut -f1))"

# ── SSL cert archive ──────────────────────────────────────────────────────────
echo "  [ssl] Archiving /etc/letsencrypt/..."
SSL_BACKUP="$HOME/backups/letsencrypt-${TIMESTAMP:0:8}.tar.gz"
sudo tar -czf "$SSL_BACKUP" /etc/letsencrypt/
echo "  [ssl] Certs: $SSL_BACKUP ($(du -sh "$SSL_BACKUP" | cut -f1))"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Pre-migration backup complete. Files captured:"
echo ""
echo "  Prod backups ($(ls -1 "$HOME/backups/prod/" 2>/dev/null | wc -l) files):"
ls -lh "$HOME/backups/prod/" 2>/dev/null | grep -E 'portfolio-|uploads-' | awk '{print "    " $NF " (" $5 ")"}' || true
echo ""
echo "  Dev backup:"
echo "    $DEV_DB_BACKUP ($(du -sh "$DEV_DB_BACKUP" | cut -f1))"
echo ""
echo "  SSL cert archive:"
echo "    $SSL_BACKUP ($(du -sh "$SSL_BACKUP" | cut -f1))"
echo ""
echo "  Verify the above before proceeding to Phase 2."
