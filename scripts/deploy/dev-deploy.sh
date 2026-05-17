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
SKIP_REGRESSION=0
for arg in "$@"; do [[ "$arg" == "--skip-regression" ]] && SKIP_REGRESSION=1; done
COMPOSE_FILE="${REPO_DIR}/docker-compose.dev-server.yml"
ENV_FILE="${REPO_DIR}/.env"
ENV_TEMPLATE="${REPO_DIR}/.env.dev-server.example"
LOG_FILE="${HOME}/dev-deploy.log"
LAST_GOOD_STATE_FILE="${HOME}/.last-good-deploy-dev"  # Track last successful dev deployment
HEALTH_TIMEOUT=60   # seconds to wait for the site to become healthy
HEALTH_INTERVAL=5   # seconds between health check attempts

# Required .env vars — must be present and not a placeholder value
REQUIRED_VARS=(LAN_IP WEBAUTHN_HOST DB_PASSWORD JWT_SECRET WEBAUTHN_RP_ID WEBAUTHN_ORIGIN FRONTEND_URL)

# Placeholder values that signal the var hasn't been configured
PLACEHOLDER_PATTERNS=("192.168.x.x" "change-me" "your-" "xxx" "dev.example.com")

# ── Dev-specific: auto-detect LAN IP ──────────────────────────────────────────────────
# If LAN_IP is unset or still a placeholder, detect the primary non-loopback IPv4
# address and write it into .env so the operator doesn't have to look it up.

auto_detect_lan_ip() {
  local current="${LAN_IP:-}"
  local is_placeholder=0

  if [ -z "$current" ]; then
    is_placeholder=1
  else
    for pattern in "${PLACEHOLDER_PATTERNS[@]}"; do
      if [[ "$current" == *"$pattern"* ]]; then
        is_placeholder=1
        break
      fi
    done
  fi

  [ "$is_placeholder" = "0" ] && return 0

  dinfo "LAN_IP is unset or a placeholder — attempting auto-detection..."

  local detected
  # Try ip route first (most reliable on Ubuntu), fall back to hostname -I
  detected=$(ip route get 1.1.1.1 2>/dev/null | awk '/src/{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)
  if [ -z "$detected" ]; then
    detected=$(hostname -I 2>/dev/null | awk '{print $1}')
  fi

  if [ -z "$detected" ] || [[ "$detected" == "127."* ]]; then
    dwarn "Could not detect a non-loopback LAN IP — set LAN_IP manually in $ENV_FILE"
    return 0
  fi

  dinfo "Detected LAN IP: $detected"

  if grep -qE '^LAN_IP=' "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^LAN_IP=.*|LAN_IP=${detected}|" "$ENV_FILE"
  else
    echo "LAN_IP=${detected}" >> "$ENV_FILE"
  fi

  export LAN_IP="$detected"
  dok "LAN_IP set to $detected in $ENV_FILE"
}

# ── Extra env checks for dev ───────────────────────────────────────────────────────────

extra_env_checks() {
  # $1 is the name of the errors array (passed by validate_env)
  local -n _errors="$1"

  # JWT_SECRET length check (min 32 chars)
  if [ -n "${JWT_SECRET:-}" ] && [ ${#JWT_SECRET} -lt 32 ]; then
    _errors+=("JWT_SECRET is too short (${#JWT_SECRET} chars — minimum 32). Generate with: openssl rand -base64 32")
  fi

  # WebAuthn RP ID must be a domain — the spec rejects IP addresses outright.
  # An IPv4 literal as RP_ID is the single most common cause of
  # "'rp.id' cannot be used with the current origin" in the browser.
  local ipv4_re='^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$'
  if [[ "${WEBAUTHN_RP_ID:-}" =~ $ipv4_re ]]; then
    _errors+=("WEBAUTHN_RP_ID ('$WEBAUTHN_RP_ID') is an IP address. WebAuthn requires a domain name (e.g. dev.andykeys.me). Set WEBAUTHN_HOST and point it at \$LAN_IP via DNS or a hosts-file entry.")
  fi
  if [[ "${WEBAUTHN_HOST:-}" =~ $ipv4_re ]]; then
    _errors+=("WEBAUTHN_HOST ('$WEBAUTHN_HOST') is an IP address. It must be a domain name (e.g. dev.andykeys.me).")
  fi

  # RP_ID must equal the host portion of WEBAUTHN_ORIGIN, and must match
  # WEBAUTHN_HOST (the name the cert + browser use).
  if [ -n "${WEBAUTHN_RP_ID:-}" ] && [ -n "${WEBAUTHN_HOST:-}" ] \
     && [ "$WEBAUTHN_RP_ID" != "$WEBAUTHN_HOST" ]; then
    _errors+=("WEBAUTHN_RP_ID ('$WEBAUTHN_RP_ID') must equal WEBAUTHN_HOST ('$WEBAUTHN_HOST')")
  fi

  if [ -n "${WEBAUTHN_ORIGIN:-}" ] && [ -n "${WEBAUTHN_HOST:-}" ] \
     && [ "$WEBAUTHN_ORIGIN" != "https://${WEBAUTHN_HOST}:3001" ]; then
    _errors+=("WEBAUTHN_ORIGIN ('$WEBAUTHN_ORIGIN') must be exactly 'https://${WEBAUTHN_HOST}:3001'")
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

sync_env_from_template

load_env

auto_detect_lan_ip

log_env_snapshot

prompt_missing_vars

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

ensure_dev_certs "$LAN_IP" "$WEBAUTHN_HOST"

# ── Docker build & up ─────────────────────────────────────────────────────────────────

# Health URL depends on LAN_IP, so set it after env load
HEALTH_URL="https://${LAN_IP}:3001/api/health"
HEALTH_URL_2=""       # dev doesn't use a second health URL
HEALTH_INSECURE=1     # self-signed cert — skip curl SSL verification
NGINX_SERVICE=nginx-dev
ROLLBACK_BRANCH=dev   # fall back to stable dev branch if feature branch deploy fails

check_nginx_config nginx-dev

check_disk_space

compose_up_with_rollback backend-dev

# ── Health check ───────────────────────────────────────────────────────────────────────

wait_for_health backend-dev

log_deploy_summary dev

run_deploy_tests backend-dev

# ── Post-deployment Tests ──────────────────────────────────────────────────────────────

test_error_logger_all_pages

test_csp_reporting

# ── Regression smoke tests ─────────────────────────────────────────────────────────────

if [ "$SKIP_REGRESSION" = "0" ]; then
  dsection "Regression smoke tests"
  bash "${REPO_DIR}/scripts/tests/test-regression.sh" \
    --base-url "https://${WEBAUTHN_HOST}:3001" \
    --compose-file "$COMPOSE_FILE" \
    --service backend-dev \
    --insecure \
    2>&1 | tee -a "$LOG_FILE" || ddie "Regression smoke tests failed — see output above"
fi

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
