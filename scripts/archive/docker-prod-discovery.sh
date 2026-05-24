#!/usr/bin/env bash
# docker-prod-discovery.sh — Discover prod stack locations and env files.
#
# This script is non-destructive. It tries to infer where the prod stack
# lives on this host (project root, compose file, env file) and logs the
# findings so we can wire prod into the migration safely.
#
# Usage:
#   bash scripts/setup/docker-prod-discovery.sh

set -euo pipefail

LOG_DIR="logs/docker-migration"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/${TIMESTAMP}-prod-discovery.txt"

log() {
  echo "$1" | tee -a "${LOG_FILE}"
}

log ""
log "╔══════════════════════════════════════════╗"
log "║     Prod stack discovery (host-level)    ║"
log "╚══════════════════════════════════════════╝"
log ""

# 1) Show docker ps to see what looks like prod
log "[INFO] docker ps (looking for prod-like containers):"
docker ps | tee -a "${LOG_FILE}"
log ""

# 2) Try to find compose files that look like prod
log "[INFO] Searching for docker-compose.*.yml files under $HOME:" 
find "$HOME" -maxdepth 4 -type f \( -name 'docker-compose.yml' -o -name 'docker-compose.*.yml' \) 2>/dev/null | tee -a "${LOG_FILE}"
log ""

# 3) Try to find prod env files under $HOME and common project dirs
log "[INFO] Searching for prod env files (patterns: .env.prod*, prod.env*):"
find "$HOME" -maxdepth 5 -type f \( -name '.env.prod*' -o -name 'prod.env*' \) 2>/dev/null | tee -a "${LOG_FILE}"
log ""

# 4) Show any directories that look like prod project roots
log "[INFO] Candidate project roots under $HOME (MyPortfolioSite*, portfolio*, prod*):"
find "$HOME" -maxdepth 3 -type d \( -name 'MyPortfolioSite*' -o -name 'portfolio*' -o -name 'prod*' \) 2>/dev/null | tee -a "${LOG_FILE}"
log ""

log "[INFO] Prod discovery complete. Review ${LOG_FILE} and share relevant paths"
log "       (prod compose file, prod env file, prod project root) so scripts can"
log "       be wired to handle the prod stack explicitly."
