#!/usr/bin/env bash
# docker-migration-checklist.sh — Inspect current Docker/Snap state before migrating.
#
# Non-destructive helper to see what is running and which volumes/networks are in use
# for the MyPortfolioSite dev stack on this host.
#
# Usage:
#   bash scripts/setup/docker-migration-checklist.sh

set -euo pipefail

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   Docker / Snap migration checklist      ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Show Docker info summary
echo "[INFO] docker info (summary):"
docker info --format 'Server: {{.ServerVersion}}, Storage: {{.Driver}}, RootDir: {{.DockerRootDir}}' || echo "[WARN] docker info failed"
echo ""

# List all containers
echo "[INFO] docker ps -a:"
docker ps -a || echo "[WARN] docker ps -a failed"
echo ""

# List volumes and highlight dev volumes
echo "[INFO] docker volume ls (dev volumes marked with *):"
DEV_VOLUMES=$(docker volume ls -q | grep '^myportfoliosite-dev_' || true)
docker volume ls
if [ -n "${DEV_VOLUMES}" ]; then
  echo ""
  echo "[INFO] Volumes used by MyPortfolioSite dev stack:"
  echo "${DEV_VOLUMES}" | sed 's/^/* /'
else
  echo ""
  echo "[INFO] No volumes with myportfoliosite-dev_ prefix detected."
fi
echo ""

# List networks
echo "[INFO] docker network ls:"
docker network ls || echo "[WARN] docker network ls failed"
echo ""

echo "[INFO] Checklist complete. Review the above before removing Snap Docker or migrating to docker-ce."
