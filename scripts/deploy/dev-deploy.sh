#!/usr/bin/env bash
# dev-deploy.sh — Unified dev environment setup and deploy script.
#
# Handles both first-time setup and subsequent deploys.
# Run on the Ubuntu Server as the non-root user.
#
# Usage:
#   bash scripts/deploy/dev-deploy.sh [branch]
# Examples:
#   bash scripts/deploy/dev-deploy.sh              # Deploy from dev
#   bash scripts/deploy/dev-deploy.sh fix/my-fix   # Deploy from feature branch

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────────────────

REPO_DIR="${HOME}/MyPortfolioSite-dev"
REPO_URL="https://github.com/AndyRKeys/MyPortfolioSite.git"
BRANCH="${1:-dev}"
COMPOSE_FILE="${REPO_DIR}/docker-compose.dev-server.yml"
ENV_FILE="${REPO_DIR}/.env"
ENV_TEMPLATE="${REPO_DIR}/.env.dev-server.example"
LOG_FILE="${HOME}/dev-deploy.log"
LAST_GOOD_STATE_FILE="${HOME}/.last-good-deploy-dev"  # Track last successful dev deployment
HEALTH_TIMEOUT=60   # seconds to wait for the site to become healthy
HEALTH_INTERVAL=5   # seconds between health check attempts

# Required .env vars — must be present and not a placeholder value
REQUIRED_VARS=(LAN_IP DB_PASSWORD JWT_SECRET WEBAUTHN_RP_ID WEBAUTHN_ORIGIN FRONTEND_URL)

# Placeholder values that signal the var hasn't been configured
PLACEHOLDER_PATTERNS=("192.168.x.x" "change-me" "your-" "xxx")

# ── Extra env checks for dev ───────────────────────────────────────────────────────────

extra_env_checks() {
  # $1 is the name of the errors array (passed by validate_env)
  local -n _errors="$1"

  # JWT_SECRET length check (min 32 chars)
  if [ -n "${JWT_SECRET:-}" ] && [ ${#JWT_SECRET} -lt 32 ]; then
    _errors+=("JWT_SECRET is too short (${#JWT_SECRET} chars — minimum 32). Generate with: openssl rand -base64 32")
  fi

  # WebAuthn consistency — RP_ID must be just the IP, ORIGIN must include port
  if [ -n "${WEBAUTHN_RP_ID:-}" ] && [ -n "${LAN_IP:-}" ]; then
    if [ "$WEBAUTHN_RP_ID" != "$LAN_IP" ]; then
      _errors+=("WEBAUTHN_RP_ID ('$WEBAUTHN_RP_ID') must match LAN_IP ('$LAN_IP') exactly")
    fi
  fi

  if [ -n "${WEBAUTHN_ORIGIN:-}" ] && [[ "$WEBAUTHN_ORIGIN" != *":3001"* ]]; then
    _errors+=("WEBAUTHN_ORIGIN ('$WEBAUTHN_ORIGIN') should end with :3001 — passkey registration will fail otherwise")
  fi
}

# ── Load shared deploy helpers ─────────────────────────────────────────────────────────

# shellcheck source=/dev/null
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy-lib.sh"

# ── Entry point ─────────────────────────────────────────────────────────────────────────

init_log_banner "Dev Server Deploy"

require_tools docker git curl openssl

ensure_repo_cloned

ensure_env_file

load_env

validate_env

# ── UFW check (dev-specific) ───────────────────────────────────────────────────────────

dsection "Checking firewall (UFW)"

if command -v ufw &>/dev/null && sudo ufw status 2>/dev/null | grep -q "3001"; then
  dok "UFW rule for port 3001 is present"
else
  dwarn "No UFW rule found for port 3001."
  dwarn "The dev site may not be reachable from other LAN devices."
  dwarn "To open port 3001 to your LAN:"
  dwarn "  sudo ufw allow from 192.168.0.0/16 to any port 3001 comment 'Dev site LAN-only'"
  dwarn "Continuing anyway — this is a warning, not an error."
fi

# ── Git update ─────────────────────────────────────────────────────────────────────────

update_to_branch

show_deployment_info

# ── Certificates and nginx pre-flight ─────────────────────────────────────────────────
# Done after git update so we always use the latest cert generation script and
# so that cert files are verified against the working tree that will be deployed.

ensure_dev_certs "$LAN_IP"

# ── Docker build & up ─────────────────────────────────────────────────────────────────

# Health URL depends on LAN_IP, so set it after env load
HEALTH_URL="https://${LAN_IP}:3001/api/health"
HEALTH_URL_2=""       # dev doesn't use a second health URL
HEALTH_INSECURE=1     # self-signed cert — skip curl SSL verification
NGINX_SERVICE=nginx-dev
ROLLBACK_BRANCH=dev   # fall back to stable dev branch if feature branch deploy fails

check_nginx_config nginx-dev

compose_up_with_rollback backend-dev

# ── Health check ───────────────────────────────────────────────────────────────────────

wait_for_health backend-dev

# ── Post-deployment Tests ──────────────────────────────────────────────────────────────

test_error_logger_all_pages

test_csp_reporting

# ── Summary ────────────────────────────────────────────────────────────────────────────

dsection "Deploy complete"

dok "  Site:    https://${LAN_IP}:3001"
dok "  Commit:  $(cd "$REPO_DIR" && git rev-parse --short HEAD)"
dok "  Log:     $LOG_FILE"

dinfo "Container status:"
docker compose -f "$COMPOSE_FILE" ps 2>&1 | tee -a "$LOG_FILE"

dlog ""
if [ "$DEPLOY_ROLLED_BACK" = "1" ]; then
  dlog "${DEPLOY_BOLD}╔══════════════════════════════════════════╗${DEPLOY_RESET}"
  dlog "${DEPLOY_BOLD}║        Dev rolled back (recovered)       ║${DEPLOY_RESET}"
  dlog "${DEPLOY_BOLD}╚══════════════════════════════════════════╝${DEPLOY_RESET}"
else
  dlog "${DEPLOY_BOLD}╔══════════════════════════════════════════╗${DEPLOY_RESET}"
  dlog "${DEPLOY_BOLD}║           Dev deploy complete ✓          ║${DEPLOY_RESET}"
  dlog "${DEPLOY_BOLD}╚══════════════════════════════════════════╝${DEPLOY_RESET}"
fi
dlog ""
