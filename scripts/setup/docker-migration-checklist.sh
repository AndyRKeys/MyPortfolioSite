#!/usr/bin/env bash
# docker-migration-checklist.sh — Inspect and log current Docker/Snap state before migrating.
#
# This script is non-destructive. It collects and logs information about the
# current Docker setup on this host to help you migrate safely.
#
# Usage:
#   bash scripts/setup/docker-migration-checklist.sh

set -euo pipefail

LOG_DIR="logs/docker-migration"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "${LOG_DIR}"
LOG_PREFIX="${LOG_DIR}/${TIMESTAMP}"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   Docker / Snap migration checklist      ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "[INFO] Logs will be written under: ${LOG_DIR}" \
     "(prefix: ${TIMESTAMP})"

echo ""
echo "[INFO] docker info (summary):"
if docker info --format 'Server: {{.ServerVersion}}, Storage: {{.Driver}}, RootDir: {{.DockerRootDir}}' | tee "${LOG_PREFIX}-docker-info-summary.txt"; then
  :
else
  echo "[WARN] docker info failed" | tee -a "${LOG_PREFIX}-errors.txt"
fi

echo ""
echo "[INFO] Full docker info (logged only)"
if docker info > "${LOG_PREFIX}-docker-info-full.txt" 2>>"${LOG_PREFIX}-errors.txt"; then
  echo "[OK] Full docker info logged to ${LOG_PREFIX}-docker-info-full.txt"
else
  echo "[WARN] Failed to capture full docker info" | tee -a "${LOG_PREFIX}-errors.txt"
fi

echo ""
echo "[INFO] docker ps -a:"
if docker ps -a | tee "${LOG_PREFIX}-docker-ps-a.txt"; then
  :
else
  echo "[WARN] docker ps -a failed" | tee -a "${LOG_PREFIX}-errors.txt"
fi

echo ""
echo "[INFO] docker volume ls (dev volumes marked with *):"
if docker volume ls | tee "${LOG_PREFIX}-docker-volumes.txt"; then
  :
else
  echo "[WARN] docker volume ls failed" | tee -a "${LOG_PREFIX}-errors.txt"
fi

echo ""
DEV_VOLUMES=$(docker volume ls -q 2>/dev/null | grep '^myportfoliosite-dev_' || true)
if [ -n "${DEV_VOLUMES}" ]; then
  echo "[INFO] Volumes used by MyPortfolioSite dev stack:" | tee "${LOG_PREFIX}-dev-volumes.txt"
  echo "${DEV_VOLUMES}" | sed 's/^/* /' | tee -a "${LOG_PREFIX}-dev-volumes.txt"
else
  echo "[INFO] No volumes with myportfoliosite-dev_ prefix detected." | tee "${LOG_PREFIX}-dev-volumes.txt"
fi

echo ""
echo "[INFO] docker network ls:"
if docker network ls | tee "${LOG_PREFIX}-docker-networks.txt"; then
  :
else
  echo "[WARN] docker network ls failed" | tee -a "${LOG_PREFIX}-errors.txt"
fi

echo ""
echo "[INFO] Checklist complete. Review the logs in ${LOG_DIR} before removing Snap Docker or migrating to docker-ce."
