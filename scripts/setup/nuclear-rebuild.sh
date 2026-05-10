#!/usr/bin/env bash
# nuclear-rebuild.sh — Last-resort recovery: tear down and rebuild the dev stack.
#
# Tears down all containers, images, and networks for the dev stack then prompts
# you to re-run the deploy script to rebuild from a clean state.
#
# DATABASE IS PRESERVED by default. Use --wipe-db only if the schema is corrupt.
#
# Usage:
#   bash scripts/setup/nuclear-rebuild.sh [--wipe-db] [--yes]
#
# Options:
#   --wipe-db   Also destroy postgres_dev_data volume (IRREVERSIBLE — ALL DATA LOST)
#   --yes       Skip confirmation prompt (for scripted use — dangerous)

set -euo pipefail

WIPE_DB=false
SKIP_CONFIRM=false
COMPOSE_FILE="${HOME}/MyPortfolioSite-dev/docker-compose.dev-server.yml"
LOG_FILE="${HOME}/dev-deploy.log"
FAILURE_COUNTER_FILE="${HOME}/.dev-deploy-failures"

for arg in "$@"; do
    case "$arg" in
        --wipe-db) WIPE_DB=true ;;
        --yes)     SKIP_CONFIRM=true ;;
    esac
done

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║         NUCLEAR REBUILD — DEV STACK                  ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "This will:"
echo "  ✓ Stop all dev containers"
echo "  ✓ Remove app images and networks"
echo "  ✓ Prune dangling Docker resources"
if [ "$WIPE_DB" = true ]; then
    echo "  ✗ DESTROY postgres_dev_data volume (ALL DATABASE DATA LOST)"
else
    echo "  ✓ Preserve postgres_dev_data volume (database kept)"
fi
echo ""
echo "After this completes, re-run the deploy script to rebuild from scratch."
echo ""

if [ "$WIPE_DB" = true ]; then
    echo "⚠️  WARNING: --wipe-db was specified."
    echo "   The postgres_dev_data volume will be PERMANENTLY DESTROYED."
    echo "   All blog posts, users, and data will be gone."
    echo ""
fi

if [ "$SKIP_CONFIRM" = false ]; then
    read -r -p "Type 'nuclear' to confirm and proceed: " _confirm
    if [ "$_confirm" != "nuclear" ]; then
        echo "Aborted — nothing was changed."
        exit 0
    fi
fi

echo ""
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Nuclear rebuild started" | tee -a "$LOG_FILE"

# Stop and remove containers, networks, and local images
echo "Stopping and removing containers..."
docker compose -f "$COMPOSE_FILE" down --remove-orphans --rmi local 2>&1 | tee -a "$LOG_FILE" || true

# Optionally wipe the database volume
if [ "$WIPE_DB" = true ]; then
    echo "Destroying postgres_dev_data volume..."
    docker volume rm myportfoliosite-dev_postgres_dev_data 2>&1 | tee -a "$LOG_FILE" || \
        echo "Volume not found or already removed — continuing."
fi

# Prune dangling images and build cache
echo "Pruning dangling images and build cache..."
docker system prune -f 2>&1 | tee -a "$LOG_FILE" || true

# Reset consecutive failure counter so next deploy starts fresh
rm -f "$FAILURE_COUNTER_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Nuclear rebuild complete — failure counter reset" | tee -a "$LOG_FILE"

echo ""
echo "✓ Nuclear rebuild complete."
echo ""
echo "Now rebuild the dev environment:"
echo "  bash ~/MyPortfolioSite-dev/scripts/deploy/dev-server-deploy.sh"
echo ""
