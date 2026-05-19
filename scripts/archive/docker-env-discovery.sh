#!/usr/bin/env bash
# docker-env-discovery.sh — Discover dev/prod stack locations and env files.
#
# This script is non-destructive. It tries to infer where the dev and prod
# stacks live on this host (project roots, compose files, env files) and logs
# the findings so scripts can be wired safely.
#
# Usage:
#   bash scripts/setup/docker-env-discovery.sh

set -euo pipefail

LOG_DIR="logs/docker-migration"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/${TIMESTAMP}-env-discovery.txt"

log() {
  echo "$1" | tee -a "${LOG_FILE}"
}

log ""
log "╔══════════════════════════════════════════╗"
log "║  Dev/Prod stack discovery (host-level)   ║"
log "╚══════════════════════════════════════════╝"
log ""

# 1) Show docker ps to see running containers
log "[INFO] docker ps (for context):"
docker ps | tee -a "${LOG_FILE}"
log ""

# 2) Find compose files under $HOME
log "[INFO] Searching for docker-compose.*.yml files under $HOME (dev/prod candidates):"
find "$HOME" -maxdepth 5 -type f \( -name 'docker-compose.yml' -o -name 'docker-compose.*.yml' \) 2>/dev/null | tee -a "${LOG_FILE}"
log ""

# 3) Find dev env files under $HOME
log "[INFO] Searching for DEV env files (patterns: .env.dev*, dev.env*):"
find "$HOME" -maxdepth 6 -type f \( -name '.env.dev*' -o -name 'dev.env*' \) 2>/dev/null | tee -a "${LOG_FILE}"
log ""

# 4) Find prod env files under $HOME
log "[INFO] Searching for PROD env files (patterns: .env.prod*, prod.env*):"
find "$HOME" -maxdepth 6 -type f \( -name '.env.prod*' -o -name 'prod.env*' \) 2>/dev/null | tee -a "${LOG_FILE}"
log ""

# 5) Candidate dev project roots
log "[INFO] Candidate DEV project roots under $HOME (MyPortfolioSite-dev*, *-dev, portfolio-dev*):"
find "$HOME" -maxdepth 4 -type d \( -name 'MyPortfolioSite-dev*' -o -name '*-dev' -o -name 'portfolio-dev*' \) 2>/dev/null | tee -a "${LOG_FILE}"
log ""

# 6) Candidate prod project roots
log "[INFO] Candidate PROD project roots under $HOME (MyPortfolioSite*, portfolio*, prod*):"
find "$HOME" -maxdepth 4 -type d \( -name 'MyPortfolioSite' -o -name 'MyPortfolioSite-prod*' -o -name 'portfolio*' -o -name 'prod*' \) 2>/dev/null | tee -a "${LOG_FILE}"
log ""

log "[INFO] Env discovery complete. Review ${LOG_FILE} and confirm:"
log "       - Dev project root, dev compose file, dev env file(s)"
log "       - Prod project root, prod compose file, prod env file(s)"
