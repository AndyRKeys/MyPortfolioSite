#!/bin/bash
# Restore PostgreSQL database from a local backup file.
# Usage: bash db-restore.sh <backup-file.sql.gz>
# WARNING: Drops and recreates the target database.
set -e

REPO_DIR="$HOME/MyPortfolioSite"

BACKUP_FILE="${1:-}"
if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
    echo "Usage: bash db-restore.sh <backup-file.sql.gz>"
    echo ""
    echo "Available backups:"
    ls -lht "$HOME/backups/"*.sql.gz 2>/dev/null || echo "  (none found in ~/backups/)"
    exit 1
fi

cd "$REPO_DIR"
set -a; source .env 2>/dev/null || true; set +a

DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-portfolio_prod}"

echo "=== Restore: $BACKUP_FILE ==="
echo "  Target database: $DB_NAME (user: $DB_USER)"
echo ""
read -r -p "WARNING: This will DROP and recreate $DB_NAME. Continue? [y/N] " CONFIRM
[ "$CONFIRM" = "y" ] || { echo "Aborted."; exit 0; }

echo "Stopping backend..."
docker compose -f docker-compose.prod.yml stop backend

echo "Dropping database..."
docker compose -f docker-compose.prod.yml exec -T postgres \
    psql -U "$DB_USER" postgres \
    -c "DROP DATABASE IF EXISTS \"$DB_NAME\";"

echo "Creating database..."
docker compose -f docker-compose.prod.yml exec -T postgres \
    psql -U "$DB_USER" postgres \
    -c "CREATE DATABASE \"$DB_NAME\";"

echo "Restoring data..."
gunzip -c "$BACKUP_FILE" | \
    docker compose -f docker-compose.prod.yml exec -T postgres \
    psql -U "$DB_USER" "$DB_NAME"

echo "Restarting backend..."
docker compose -f docker-compose.prod.yml start backend

echo ""
echo "=== Restore complete ==="
