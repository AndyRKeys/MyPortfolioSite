#!/usr/bin/env bash
# deploy.sh — Unified environment-aware deploy script for dev and prod.
#
# Environment is selected with --env <dev|prod>. All environment-specific
# behaviour is controlled by feature flags set in the environment block below
# rather than maintained in separate scripts. Branch switching and git update
# are always handled by the calling wrapper (switch-branch.sh) before this
# script is invoked.
#
# Dev:  called by switch-branch.sh then dev-deploy.ps1
# Prod: called by switch-branch.sh then prod-deploy.ps1
#
# Usage:
#   deploy.sh --env dev  [branch] [--skip-regression] [--quiet] [--dry-run]
#   deploy.sh --env prod [--rollback <sha>] [--skip-regression] [--quiet] [--dry-run]
#
# --dry-run: runs all pre-flight checks (env validation, certs, nginx config,
#            disk space) then prints what would be deployed and exits without
#            rebuilding containers or running tests.

set -euo pipefail

# ── Sudo guard (#351) ─────────────────────────────────────────────────────────
# Running as root via sudo sets $HOME=/root, so REPO_DIR resolves to
# /root/MyPortfolioSite* — a fresh clone with a template .env — instead of
# the real user's configured repo. Block it unconditionally — deploy.sh is
# only ever called from the host now (via deploy-daemon.sh).
if [ "${EUID:-$(id -u)}" -eq 0 ]; then
  echo ""
  echo "ERROR: do not run deploy.sh with sudo." >&2
  echo "" >&2
  echo "  Running as root sets \$HOME=/root, so REPO_DIR and .env point to a" >&2
  echo "  fresh clone in /root/ instead of your configured repo." >&2
  echo "" >&2
  echo "  Run as your normal user — the script calls try_root internally" >&2
  echo "  for any commands that need elevated privileges (UFW, certs, etc.):" >&2
  echo "" >&2
  echo "    bash ./scripts/deploy/deploy.sh --env ${1:-dev}" >&2
  echo "" >&2
  exit 1
fi

# ── Argument parsing ──────────────────────────────────────────────────────────

DEPLOY_ENV=""
BRANCH=""
ROLLBACK_SHA=""
SKIP_REGRESSION=0
DEPLOY_QUIET=0
DRY_RUN=0
AUTO_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)             DEPLOY_ENV="$2"; shift 2 ;;
    --rollback)        ROLLBACK_SHA="$2"; shift 2 ;;
    --skip-regression) SKIP_REGRESSION=1; shift ;;
    --quiet)           DEPLOY_QUIET=1; shift ;;
    --dry-run)         DRY_RUN=1; shift ;;
    --auto-yes|--yes)  AUTO_YES=1; shift ;;
    --*)               shift ;;
    *)
      # Positional arg: branch name (dev passes branch as first positional arg)
      [ -z "$BRANCH" ] && BRANCH="$1"
      shift ;;
  esac
done

export DEPLOY_QUIET AUTO_YES

if [ -z "$DEPLOY_ENV" ]; then
  echo "[ERROR] --env <dev|prod> is required" >&2
  echo "Usage: deploy.sh --env dev  [branch] [--skip-regression] [--quiet] [--dry-run]" >&2
  echo "       deploy.sh --env prod [--rollback <sha>] [--skip-regression] [--quiet] [--dry-run]" >&2
  exit 1
fi

if [ "$DRY_RUN" = "1" ] && [ -n "$ROLLBACK_SHA" ]; then
  echo "[ERROR] --dry-run and --rollback cannot be used together" >&2
  exit 1
fi

# ── Environment config ────────────────────────────────────────────────────────
# The case block sets ONLY what's needed before .env is loaded — repo path,
# env-file path, log path, branch default, validation lists. Everything else
# (service names, ports, cert mode, rollback branch, etc.) comes from .env.

HEALTH_TIMEOUT=60
HEALTH_INTERVAL=5
HEALTH_URL_2=""
NGINX_URL=""
SITE_URL=""  # set after load_env (depends on .env vars)

REPO_URL="https://github.com/AndyRKeys/MyPortfolioSite.git"

# Keys required in .env regardless of environment. Per-env extras append below.
REQUIRED_VARS_COMMON=(
  SITE_HOST
  COMPOSE_PROJECT_NAME NGINX_SERVICE BACKEND_SERVICE
  PORT NGINX_PORT NGINX_HTTP_HOST_PORT NGINX_CONF_TEMPLATE
  CERT_MOUNT_SRC CERT_MOUNT_DST CERT_MODE
  ROLLBACK_BRANCH BACKUP_DIR
  DB_NAME DB_USER DB_PASSWORD
  JWT_SECRET
  WEBAUTHN_RP_ID WEBAUTHN_ORIGIN FRONTEND_URL
  ADMIN_EMAIL
)

case "$DEPLOY_ENV" in
  dev)
    REPO_DIR="${HOME}/MyPortfolioSite-dev"
    BRANCH="${BRANCH:-dev}"
    ENV_FILE="${REPO_DIR}/.env"
    ENV_TEMPLATE="${REPO_DIR}/.env.dev-server.example"
    LOG_FILE="${HOME}/logs/dev-deploy.log"
    LAST_GOOD_STATE_FILE="${HOME}/.last-good-deploy-dev"
    REQUIRED_VARS=("${REQUIRED_VARS_COMMON[@]}" LAN_IP)
    PLACEHOLDER_PATTERNS=("192.168.x.x" "change-me" "your-" "xxx" "dev.example.com")
    # Feature flags
    RUN_LAN_IP_DETECT=1  # dev .env uses LAN_IP for nginx/cert config; auto-detect saves manual setup
    RUN_UFW_CHECK=1      # both envs on same server; UFW must allow the nginx port or the site is unreachable
    RUN_DEV_CERTS=1      # dev uses self-signed certs (no certbot); must be generated before nginx starts
    RUN_VITEST=1         # unified image includes devDependencies; run tests against the live container post-deploy
    RUN_ERROR_LOGGER=1   # unified image includes Chromium/puppeteer; run error-logger checks post-deploy
    RUN_PUBLIC_PAGES=1   # puppeteer check for unhandled JS errors on all public pages (#390)
    RUN_ADMIN_E2E=1      # smoke + interaction tests for admin panel — hard fail (admin is required for content management)
    RUN_DDNS_CHECK=0     # no public DNS in dev; site is LAN-only
    RUN_BACKUP_CHECK=1   # warn if local backups are absent or stale
    ;;
  prod)
    REPO_DIR="${HOME}/MyPortfolioSite"
    BRANCH="${BRANCH:-main}"
    ENV_FILE="${REPO_DIR}/.env"
    ENV_TEMPLATE="${REPO_DIR}/.env.example"
    LOG_FILE="${HOME}/logs/prod-deploy.log"
    LAST_GOOD_STATE_FILE="${HOME}/.last-good-deploy-prod"
    REQUIRED_VARS=("${REQUIRED_VARS_COMMON[@]}" DOMAIN)
    PLACEHOLDER_PATTERNS=("change-me" "your-" "example.com" "xxx" "replace_")
    # Feature flags
    RUN_LAN_IP_DETECT=0  # prod uses a public domain (DOMAIN), not a LAN IP
    RUN_UFW_CHECK=1      # both envs on same server; UFW must allow port 443 or the site is unreachable
    RUN_DEV_CERTS=0      # prod uses Let's Encrypt certs managed by certbot, not self-signed
    RUN_VITEST=1         # unified image includes devDependencies; run tests post-deploy on prod too
    RUN_ERROR_LOGGER=1   # unified image includes Chromium/puppeteer; run error-logger on prod too
    RUN_PUBLIC_PAGES=1   # puppeteer check for unhandled JS errors on all public pages (#390)
    RUN_ADMIN_E2E=1      # smoke + interaction tests for admin panel — hard fail (admin is required for content management)
    RUN_DDNS_CHECK=1     # prod is public; verify DNS points to this server before deploying
    RUN_BACKUP_CHECK=1   # warn if local backups are absent or stale
    ;;
  *)
    echo "[ERROR] Unknown environment '${DEPLOY_ENV}' — must be 'dev' or 'prod'" >&2
    exit 1
    ;;
esac

# Ensure log directory exists before any tee-a writes
mkdir -p "$(dirname "$LOG_FILE")"

# Single unified compose file — env-specific behaviour comes from .env, not
# from selecting a different compose file.
COMPOSE_FILE="${REPO_DIR}/docker-compose.yml"

# ── Environment-specific validation ──────────────────────────────────────────
# extra_env_checks is called by validate_env in deploy-lib.sh

extra_env_checks() {
  local -n _errors="$1"

  # JWT_SECRET length check (both envs)
  if [ -n "${JWT_SECRET:-}" ] && [ ${#JWT_SECRET} -lt 32 ]; then
    _errors+=("JWT_SECRET is too short (${#JWT_SECRET} chars — minimum 32). Generate with: openssl rand -base64 32")
  fi

  if [ "$DEPLOY_ENV" = "dev" ]; then
    local ipv4_re='^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$'
    if [[ "${SITE_HOST:-}" =~ $ipv4_re ]]; then
      _errors+=("SITE_HOST ('$SITE_HOST') is an IP address. WebAuthn requires a domain name (e.g. dev.andykeys.me).")
    fi
    if [ -n "${WEBAUTHN_RP_ID:-}" ] && [ -n "${SITE_HOST:-}" ] \
       && [ "$WEBAUTHN_RP_ID" != "$SITE_HOST" ]; then
      _errors+=("WEBAUTHN_RP_ID ('$WEBAUTHN_RP_ID') must equal SITE_HOST ('$SITE_HOST')")
    fi
    local expected_origin="https://${SITE_HOST}:${NGINX_PORT}"
    if [ -n "${WEBAUTHN_ORIGIN:-}" ] && [ -n "${SITE_HOST:-}" ] \
       && [ "$WEBAUTHN_ORIGIN" != "$expected_origin" ]; then
      _errors+=("WEBAUTHN_ORIGIN ('$WEBAUTHN_ORIGIN') must be exactly '$expected_origin'")
    fi
  fi

  if [ "$DEPLOY_ENV" = "prod" ]; then
    if [ -n "${DOMAIN:-}" ] && [[ "$DOMAIN" == http*://* ]]; then
      _errors+=("DOMAIN ('$DOMAIN') should not include protocol — use just the host name (e.g. andykeys.me)")
    fi
  fi
}

# ── Load shared deploy helpers ────────────────────────────────────────────────

# shellcheck source=/dev/null
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy-lib.sh"

# ── Exit trap — always print deploy report ────────────────────────────────────
# ddie() calls exit 1 directly, bypassing the report block at the bottom.
# This trap ensures the boxed report is always printed, including on unexpected
# exits from set -e, so failures are never silent.
_DEPLOY_REPORT_PRINTED=0
_deploy_exit_handler() {
  if [ "$_DEPLOY_REPORT_PRINTED" = "0" ]; then
    print_deploy_report "${DEPLOY_ENV:-unknown} — FAILED"
    print_deploy_status "FAILED" "${DEPLOY_ENV:-unknown}"
  fi
}
trap '_deploy_exit_handler' EXIT

# ── Entry point ───────────────────────────────────────────────────────────────

init_log_banner "${DEPLOY_ENV^} Deploy"

if [ "$DEPLOY_ENV" = "dev" ]; then
  require_tools docker git curl openssl
else
  require_tools docker git curl dig
fi

ensure_repo_cloned

ensure_env_file

sync_env_from_template

load_env

migrate_env_values

cleanup_stale_compose_projects

# Make COMPOSE_PROJECT_NAME visible to every `docker compose` call below.
# load_env exports anything declared in .env, but it's worth being explicit:
# this single env var is what namespaces dev vs prod containers and volumes
# (along with the optional POSTGRES_VOLUME_NAME / UPLOADS_VOLUME_NAME overrides).
export COMPOSE_PROJECT_NAME

# ── Post-env config (derived from loaded .env values) ────────────────────────
# All values below are derived from .env — no env-specific branching here.

# HEALTH_INSECURE is derived from CERT_MODE rather than being declared per-env:
# self-signed certs require --insecure for curl to accept them; Let's Encrypt
# certs are valid so we verify them properly.
if [ "${CERT_MODE:-}" = "self-signed" ]; then
  HEALTH_INSECURE=1
else
  HEALTH_INSECURE=0
fi

# Health check URL and curl flags.
# - self-signed (dev): curl localhost with --insecure (cert isn't trusted)
# - letsencrypt (prod): curl via SITE_HOST so the cert CN matches; use
#   --resolve to force local resolution and avoid hairpin NAT
if [ "${CERT_MODE:-}" = "self-signed" ]; then
  HEALTH_URL="https://localhost:${NGINX_PORT}/api/health"
  HEALTH_INSECURE=1
elif [ "${NGINX_PORT}" = "443" ]; then
  HEALTH_URL="https://${SITE_HOST}/api/health"
  HEALTH_RESOLVE="${SITE_HOST}:443:127.0.0.1"
  HEALTH_INSECURE=0
else
  HEALTH_URL="http://localhost:${NGINX_PORT}/api/health"
  HEALTH_INSECURE=0
fi

# Docker-internal nginx URL used by the error-logger test (puppeteer inside the
# backend container reaches nginx by service name). Omit the port for 443 since
# https:// implies it; include it otherwise.
if [ "${NGINX_PORT}" = "443" ]; then
  NGINX_URL="https://${NGINX_SERVICE}"
else
  NGINX_URL="https://${NGINX_SERVICE}:${NGINX_PORT}"
fi

# External site URL used by smoke tests. SITE_HOST comes from .env in both
# environments now; fall back to DOMAIN or localhost only if .env is malformed.
SITE_HOST="${SITE_HOST:-${DOMAIN:-localhost}}"
if [ "${NGINX_PORT}" = "443" ]; then
  SITE_URL="https://${SITE_HOST}"
else
  SITE_URL="https://${SITE_HOST}:${NGINX_PORT}"
fi

# ── LAN IP detection (dev only) ───────────────────────────────────────────────

[ "$RUN_LAN_IP_DETECT" = "1" ] && auto_detect_lan_ip

log_env_snapshot

prompt_missing_vars

validate_env

# ── DDNS sync check (prod only) ───────────────────────────────────────────────

[ "$RUN_DDNS_CHECK" = "1" ] && check_ddns_sync

cd "$REPO_DIR"

# ── Rollback-only path ────────────────────────────────────────────────────────

if [ -n "$ROLLBACK_SHA" ]; then
  dsection "Rollback to specified SHA"
  PRE_SHA=$(git rev-parse HEAD 2>/dev/null || echo "none")
  dinfo "Current commit: $PRE_SHA"
  dinfo "Rolling back to $ROLLBACK_SHA"
  git reset --hard "$ROLLBACK_SHA" 2>&1 | tee -a "$LOG_FILE" || ddie "git reset to rollback SHA failed"

  compose_up_with_rollback "$BACKEND_SERVICE"
  POST_SHA=$(git rev-parse HEAD)
  dlog "$(date -u +'%Y-%m-%dT%H:%M:%SZ') rollback $PRE_SHA → $POST_SHA" >> "$LOG_FILE"
  dsection "Rollback complete"
  dok "Rollback to $POST_SHA complete."
  exit 0
fi

# ── UFW check ────────────────────────────────────────────────────────────────

[ "$RUN_UFW_CHECK" = "1" ] && check_ufw_port "$NGINX_PORT"

# ── Record deploy SHA ────────────────────────────────────────────────────────
# Branch update is always handled by switch-branch.sh before this script runs.

record_deploy_sha

show_deployment_info

# ── Certificates and nginx pre-flight ─────────────────────────────────────────
# Cert check runs after the working tree is confirmed so we use the latest
# cert generation script from the deployed branch.

if [ "$RUN_DEV_CERTS" = "1" ]; then
  ensure_dev_certs "$LAN_IP" "${SITE_HOST:-}"
fi

if ! check_nginx_config "$NGINX_SERVICE"; then
  compose_up_with_rollback "$BACKEND_SERVICE" "nginx config test failed"
  print_deploy_status "FAILED" "$DEPLOY_ENV"
  exit 1
fi

check_disk_space

# Port pre-flight: verify nginx ports are free before Docker tries to bind them.
# Backend port is excluded — it is no longer bound to the host.
if [ "${NGINX_PORT}" = "443" ]; then
  check_port_availability 80 443 || { print_deploy_status "FAILED" "$DEPLOY_ENV"; exit 1; }
else
  check_port_availability "${NGINX_PORT}" || { print_deploy_status "FAILED" "$DEPLOY_ENV"; exit 1; }
fi

# ── Dry-run exit ──────────────────────────────────────────────────────────────
# All pre-flight checks have passed. In dry-run mode, print what would be
# deployed and exit without touching containers or running any tests.

if [ "$DRY_RUN" = "1" ]; then
  dsection "Dry-run complete — pre-flight checks passed"
  dstatus dry-run status=ok env="$DEPLOY_ENV" branch="$BRANCH" sha="${NEW_SHA:0:7}"
  dok "All pre-flight checks passed. Would deploy:"
  dinfo "  env:          $DEPLOY_ENV"
  dinfo "  branch:       $BRANCH"
  dinfo "  commit:       ${NEW_SHA:0:7}"
  dinfo "  compose file: $COMPOSE_FILE"
  dinfo "  service:      $BACKEND_SERVICE"
  dinfo "  health URL:   $HEALTH_URL"
  [ "$RUN_VITEST"        = "1" ] && dinfo "  vitest:        would run after health check"
  [ "$RUN_ERROR_LOGGER"  = "1" ] && dinfo "  error-logger:  would run after vitest (incl. CSP violation scan)"
  [ "$RUN_PUBLIC_PAGES"  = "1" ] && dinfo "  public-pages:  would check all public pages for JS runtime errors"
  [ "$SKIP_REGRESSION"   = "0" ] && dinfo "  regression:    would run smoke tests"
  [ "$RUN_BACKUP_CHECK"  = "1" ] && dinfo "  backup check:  would warn if backups absent/stale"
  dinfo ""
  dinfo "Re-run without --dry-run to perform the actual deploy."
  print_deploy_status "DRY RUN" "$DEPLOY_ENV"
  exit 0
fi

compose_up_with_rollback "$BACKEND_SERVICE"

# ── Schema + maintenance ──────────────────────────────────────────────────────

apply_schema
prune_client_errors

# ── Health check ──────────────────────────────────────────────────────────────

wait_for_health "$BACKEND_SERVICE"

log_deploy_summary "$DEPLOY_ENV"

check_outlook_token "$BACKEND_SERVICE"

# ── In-container test suite ───────────────────────────────────────────────────

[ "$RUN_VITEST" = "1" ] && run_deploy_tests "$BACKEND_SERVICE"

# ── Post-deployment tests ─────────────────────────────────────────────────────

[ "$RUN_ERROR_LOGGER" = "1" ] && test_error_logger_all_pages
[ "$RUN_ERROR_LOGGER" = "1" ] && test_error_logger_contracts
[ "$RUN_PUBLIC_PAGES" = "1" ] && check_public_page_js
[ "$RUN_ERROR_LOGGER" = "1" ] && check_csp_violations
[ "$RUN_ERROR_LOGGER" = "1" ] && check_admin_e2e_csp
[ "$RUN_ADMIN_E2E"    = "1" ] && check_admin_e2e

test_csp_reporting

# ── Regression smoke tests ────────────────────────────────────────────────────

run_regression_tests

# ── Backup health check ───────────────────────────────────────────────────────

[ "$RUN_BACKUP_CHECK" = "1" ] && check_backup_health

# ── Summary ───────────────────────────────────────────────────────────────────

dinfo "Container status:"
docker compose -f "$COMPOSE_FILE" ps 2>&1 | tee -a "$LOG_FILE"

_DEPLOY_REPORT_PRINTED=1  # suppress exit trap — we're printing explicitly below
if [ "$DEPLOY_ROLLED_BACK" = "1" ]; then
  print_deploy_report "$DEPLOY_ENV — ROLLED BACK"
  print_deploy_status "ROLLED BACK" "$DEPLOY_ENV"
elif [ "$REGRESSION_RC" -ne 0 ]; then
  print_deploy_report "$DEPLOY_ENV — REGRESSION FAILED"
  print_deploy_status "FAILED" "$DEPLOY_ENV"
else
  print_deploy_report "$DEPLOY_ENV"
  print_deploy_status "COMPLETE" "$DEPLOY_ENV"
fi
dlog ""

[ "$REGRESSION_RC" -eq 0 ] || ddie "Regression smoke tests failed — rolled back; see report above"
