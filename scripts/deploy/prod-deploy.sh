#!/usr/bin/env bash
# prod-deploy.sh — Production deploy script for andykeys.me (Docker Compose).
#
# Fetches latest main (or specified branch), rebuilds images, and restarts containers
# with health checks and rollback behaviour shared via deploy-lib.sh.
# Run on the Ubuntu Server as the non-root deploy user.
#
# Usage:
#   bash scripts/deploy/prod-deploy.sh
#   bash scripts/deploy/prod-deploy.sh --branch main
#   bash scripts/deploy/prod-deploy.sh --rollback <sha>

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────────────────

REPO_DIR="${HOME}/MyPortfolioSite"
REPO_URL="https://github.com/AndyRKeys/MyPortfolioSite.git"
BRANCH="main"
COMPOSE_FILE="${REPO_DIR}/docker-compose.prod.yml"
ENV_FILE="${REPO_DIR}/.env"
ENV_TEMPLATE="${REPO_DIR}/.env.example"
LOG_FILE="${HOME}/prod-deploy.log"
HEALTH_TIMEOUT=60   # seconds to wait for health
HEALTH_INTERVAL=5   # seconds between health checks

# Required .env vars for prod — can be extended over time
REQUIRED_VARS=(JWT_SECRET DB_PASSWORD DOMAIN)

# Placeholder values that signal the var hasn't been configured
PLACEHOLDER_PATTERNS=("change-me" "your-" "example.com" "xxx")

# ── Optional extra env checks for prod ─────────────────────────────────────────────────

extra_env_checks() {
  local -n _errors="$1"

  # JWT_SECRET length check (min 32 chars)
  if [ -n "${JWT_SECRET:-}" ] && [ ${#JWT_SECRET} -lt 32 ]; then
    _errors+=("JWT_SECRET is too short (${#JWT_SECRET} chars — minimum 32). Generate with: openssl rand -base64 32")
  fi

  # Basic DOMAIN validation (very lightweight)
  if [ -n "${DOMAIN:-}" ]; then
    if [[ "$DOMAIN" == http*://* ]]; then
      _errors+=("DOMAIN ('$DOMAIN') should not include protocol — use just the host name (e.g. andykeys.me)")
    fi
  fi
}

# ── Load shared deploy helpers ─────────────────────────────────────────────────────────

# shellcheck source=/dev/null
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy-lib.sh"

# ── Parse arguments (rollback) ─────────────────────────────────────────────────────────

ROLLBACK_SHA=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)
      BRANCH="$2"; shift 2 ;;
    --rollback)
      ROLLBACK_SHA="$2"; shift 2 ;;
    *)
      shift ;;
  esac
done

# ── Entry point ─────────────────────────────────────────────────────────────────────────

init_log_banner "Prod Deploy"

require_tools docker git curl

ensure_repo_cloned

ensure_env_file

load_env

validate_env

cd "$REPO_DIR"

# ── Rollback-only path ─────────────────────────────────────────────────────────────────

if [ -n "$ROLLBACK_SHA" ]; then
  dsection "Rollback to specified SHA"
  PRE_SHA=$(git rev-parse HEAD 2>/dev/null || echo "none")
  dinfo "Current commit: $PRE_SHA"
  dinfo "Rolling back to $ROLLBACK_SHA"
  git reset --hard "$ROLLBACK_SHA" 2>&1 | tee -a "$LOG_FILE" || ddie "git reset to rollback SHA failed"

  compose_up_with_rollback backend

  POST_SHA=$(git rev-parse HEAD)
  dlog "$(date -u +'%Y-%m-%dT%H:%M:%SZ') rollback $PRE_SHA → $POST_SHA" >> "$LOG_FILE"

  dsection "Rollback complete"
  dok "Rollback to $POST_SHA complete."
  exit 0
fi

# ── Normal deploy: update to origin/main ────────────────────────────────────────────────

update_to_branch

show_deployment_info

# ── Ensure uploads dir exists ──────────────────────────────────────────────────────────

mkdir -p "$REPO_DIR/uploads"

# ── Build and restart containers ───────────────────────────────────────────────────────

# Primary health is backend HTTP; secondary is public HTTPS if DOMAIN + certs exist
HEALTH_URL="http://localhost:${PORT:-8080}/health"
ROLLBACK_BRANCH=main  # fall back to stable main branch if non-main deploy fails

# Only set secondary health URL if certs exist for DOMAIN
if [ -n "${DOMAIN:-}" ] && [ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
  HEALTH_URL_2="https://${DOMAIN}/health"
else
  HEALTH_URL_2=""
fi

compose_up_with_rollback backend

# ── Health checks ──────────────────────────────────────────────────────────────────────

wait_for_health backend

# Basic nginx HTTP health (localhost)
HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" http://localhost/health || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  dok "HTTP nginx proxy ✓"
else
  dwarn "HTTP returned $HTTP_CODE for http://localhost/health"
fi

# Secondary HTTPS health is already covered by HEALTH_URL_2 above when set.

# ── Summary ────────────────────────────────────────────────────────────────────────────

POST_SHA=$(git rev-parse HEAD)
dlog "$(date -u +'%Y-%m-%dT%H:%M:%SZ') deploy $PRE_SHA -> $POST_SHA" >> "$LOG_FILE"

dsection "Deploy complete"

dok "  Domain:  https://${DOMAIN:-<unset>}"
dok "  Commit:  $(git rev-parse --short HEAD)"
dok "  Log:     $LOG_FILE"

dinfo "Container status:"
docker compose -f "$COMPOSE_FILE" ps 2>&1 | tee -a "$LOG_FILE"

dlog ""
dlog "${DEPLOY_BOLD}╔══════════════════════════════════════════╗${DEPLOY_RESET}"
dlog "${DEPLOY_BOLD}║          Prod deploy complete ✓          ║${DEPLOY_RESET}"
dlog "${DEPLOY_BOLD}╚══════════════════════════════════════════╝${DEPLOY_RESET}"
dlog ""
