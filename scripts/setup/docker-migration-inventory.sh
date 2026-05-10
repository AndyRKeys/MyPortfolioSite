#!/usr/bin/env bash
# docker-migration-inventory.sh — Inspect current Docker packaging and env layout.
#
# This script is non-destructive. It collects information about:
# - Whether Docker is installed via snap and/or apt.
# - Where Docker data directories live.
# - Basic docker info / ps output (if available).
# - Presence of dev/prod project roots and .env files.
#
# Usage:
#   bash scripts/setup/docker-migration-inventory.sh

set -euo pipefail

LOG_DIR="logs/docker-migration"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/${TIMESTAMP}-inventory.txt"

log() {
  echo "$1" | tee -a "${LOG_FILE}"
}

log ""
log "╔══════════════════════════════════════════╗"
log "║   Docker migration inventory (host)      ║"
log "╚══════════════════════════════════════════╝"
log ""

log "[INFO] Host: $(hostname)"
log "[INFO] User: $(whoami)"
log "[INFO] Date: $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
log ""

log "[INFO] snap list docker:"
if command -v snap >/dev/null 2>&1; then
  snap list docker 2>&1 | tee -a "${LOG_FILE}"
else
  log "snap not installed"
fi
log ""

log "[INFO] dpkg -l | grep -E 'docker|containerd':"
dpkg -l 2>/dev/null | grep -E 'docker|containerd' || log "(no docker/containerd packages found)"
log ""

log "[INFO] Checking common Docker data directories:"
for dir in \
  /var/lib/docker \
  /var/snap/docker/common/var-lib-docker \
  /var/snap/docker \
; do
  if [ -d "$dir" ]; then
    log "  [FOUND] $dir"
  else
    log "  [MISS ] $dir"
  fi
done
log ""

log "[INFO] docker info (if reachable):"
if command -v docker >/dev/null 2>&1; then
  docker info 2>&1 | tee -a "${LOG_FILE}" || log "[WARN] docker info failed (daemon not reachable?)"
else
  log "docker CLI not found on PATH"
fi
log ""

log "[INFO] docker ps (if reachable):"
if command -v docker >/dev/null 2>&1; then
  docker ps 2>&1 | tee -a "${LOG_FILE}" || log "[WARN] docker ps failed (daemon not reachable?)"
fi
log ""

DEV_PROJECT_ROOT="${DEV_PROJECT_ROOT:-$HOME/MyPortfolioSite-dev}"
PROD_PROJECT_ROOT="${PROD_PROJECT_ROOT:-$HOME/MyPortfolioSite}"

log "[INFO] Checking dev project root: ${DEV_PROJECT_ROOT}"
if [ -d "${DEV_PROJECT_ROOT}" ]; then
  log "  [OK] exists"
  if [ -f "${DEV_PROJECT_ROOT}/.env" ]; then
    log "  [OK] dev .env present"
  else
    log "  [MISS] dev .env not found"
  fi
else
  log "  [MISS] dev project root not found"
fi
log ""

log "[INFO] Checking prod project root: ${PROD_PROJECT_ROOT}"
if [ -d "${PROD_PROJECT_ROOT}" ]; then
  log "  [OK] exists"
  if [ -f "${PROD_PROJECT_ROOT}/.env" ]; then
    log "  [OK] prod .env present"
  else
    log "  [MISS] prod .env not found"
  fi
else
  log "  [MISS] prod project root not found"
fi
log ""

log "[INFO] Inventory complete. Review ${LOG_FILE} for details before migration."
