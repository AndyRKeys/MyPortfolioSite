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

# ── Argument parsing ──────────────────────────────────────────────────────────

DEPLOY_ENV=""
BRANCH=""
ROLLBACK_SHA=""
SKIP_REGRESSION=0
DEPLOY_QUIET=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)             DEPLOY_ENV="$2"; shift 2 ;;
    --rollback)        ROLLBACK_SHA="$2"; shift 2 ;;
    --skip-regression) SKIP_REGRESSION=1; shift ;;
    --quiet)           DEPLOY_QUIET=1; shift ;;
    --dry-run)         DRY_RUN=1; shift ;;
    --*)               shift ;;
    *)
      # Positional arg: branch name (dev passes branch as first positional arg)
      [ -z "$BRANCH" ] && BRANCH="$1"
      shift ;;
  esac
done

export DEPLOY_QUIET

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

HEALTH_TIMEOUT=60
HEALTH_INTERVAL=5
HEALTH_URL_2=""
NGINX_URL=""
SITE_URL=""  # set after load_env (depends on .env vars)

case "$DEPLOY_ENV" in
  dev)
    REPO_DIR="${HOME}/MyPortfolioSite-dev"
    REPO_URL="https://github.com/AndyRKeys/MyPortfolioSite.git"
    BRANCH="${BRANCH:-dev}"
    COMPOSE_FILE="${REPO_DIR}/docker-compose.dev-server.yml"
    ENV_FILE="${REPO_DIR}/.env"
    ENV_TEMPLATE="${REPO_DIR}/.env.dev-server.example"
    LOG_FILE="${HOME}/dev-deploy.log"
    LAST_GOOD_STATE_FILE="${HOME}/.last-good-deploy-dev"
    REQUIRED_VARS=(LAN_IP WEBAUTHN_HOST DB_PASSWORD JWT_SECRET WEBAUTHN_RP_ID WEBAUTHN_ORIGIN FRONTEND_URL)
    PLACEHOLDER_PATTERNS=("192.168.x.x" "change-me" "your-" "xxx" "dev.example.com")
    HEALTH_INSECURE=1
    NGINX_SERVICE=nginx-dev
    BACKEND_SERVICE=backend-dev
    ROLLBACK_BRANCH=dev
    # Feature flags
    RUN_LAN_IP_DETECT=1  # dev .env uses LAN_IP for nginx/cert config; auto-detect saves manual setup
    RUN_UFW_CHECK=1      # dev is LAN-only on port 3001; UFW must allow it or the site is unreachable
    RUN_DEV_CERTS=1      # dev uses self-signed certs (no certbot); must be generated before nginx starts
    RUN_VITEST=1         # dev image includes devDependencies; run tests against the live container post-deploy
    RUN_ERROR_LOGGER=1   # puppeteer-based; only available in dev image
    RUN_DDNS_CHECK=0     # no public DNS in dev; site is LAN-only
    RUN_UPLOADS_DIR=0    # uploads volume is managed by docker-compose on dev; no host dir needed
    ;;
  prod)
    REPO_DIR="${HOME}/MyPortfolioSite"
    REPO_URL="https://github.com/AndyRKeys/MyPortfolioSite.git"
    BRANCH="${BRANCH:-main}"
    COMPOSE_FILE="${REPO_DIR}/docker-compose.prod.yml"
    ENV_FILE="${REPO_DIR}/.env"
    ENV_TEMPLATE="${REPO_DIR}/.env.example"
    LOG_FILE="${HOME}/prod-deploy.log"
    LAST_GOOD_STATE_FILE="${HOME}/.last-good-deploy-prod"
    REQUIRED_VARS=(JWT_SECRET DB_PASSWORD DOMAIN)
    PLACEHOLDER_PATTERNS=("change-me" "your-" "example.com" "xxx")
    HEALTH_INSECURE=0
    NGINX_SERVICE=nginx
    BACKEND_SERVICE=backend
    ROLLBACK_BRANCH=main
    # Feature flags
    RUN_LAN_IP_DETECT=0  # prod uses a public domain (DOMAIN), not a LAN IP
    RUN_UFW_CHECK=0      # prod is public on 443; UFW is managed separately, not per-deploy
    RUN_DEV_CERTS=0      # prod uses Let's Encrypt certs managed by certbot, not self-signed
    RUN_VITEST=1         # unified image includes devDependencies; run tests post-deploy on prod too
    RUN_ERROR_LOGGER=1   # unified image includes Chromium/puppeteer; run error-logger on prod too
    RUN_DDNS_CHECK=1     # prod is public; verify DNS points to this server before deploying
    RUN_UPLOADS_DIR=1    # prod bind-mounts ~/MyPortfolioSite/uploads; must exist on the host
    ;;
  *)
    echo "[ERROR] Unknown environment '${DEPLOY_ENV}' — must be 'dev' or 'prod'" >&2
    exit 1
    ;;
esac

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
    if [[ "${WEBAUTHN_RP_ID:-}" =~ $ipv4_re ]]; then
      _errors+=("WEBAUTHN_RP_ID ('$WEBAUTHN_RP_ID') is an IP address. WebAuthn requires a domain name (e.g. dev.andykeys.me).")
    fi
    if [[ "${WEBAUTHN_HOST:-}" =~ $ipv4_re ]]; then
      _errors+=("WEBAUTHN_HOST ('$WEBAUTHN_HOST') is an IP address. It must be a domain name (e.g. dev.andykeys.me).")
    fi
    if [ -n "${WEBAUTHN_RP_ID:-}" ] && [ -n "${WEBAUTHN_HOST:-}" ] \
       && [ "$WEBAUTHN_RP_ID" != "$WEBAUTHN_HOST" ]; then
      _errors+=("WEBAUTHN_RP_ID ('$WEBAUTHN_RP_ID') must equal WEBAUTHN_HOST ('$WEBAUTHN_HOST')")
    fi
    if [ -n "${WEBAUTHN_ORIGIN:-}" ] && [ -n "${WEBAUTHN_HOST:-}" ] \
       && [ "$WEBAUTHN_ORIGIN" != "https://${WEBAUTHN_HOST}:3001" ]; then
      _errors+=("WEBAUTHN_ORIGIN ('$WEBAUTHN_ORIGIN') must be exactly 'https://${WEBAUTHN_HOST}:3001'")
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

# ── Post-env config (vars that depend on loaded .env values) ──────────────────

if [ "$DEPLOY_ENV" = "dev" ]; then
  HEALTH_URL="http://localhost:${PORT:-8081}/health"
  NGINX_URL="https://nginx-dev:3001"
  SITE_URL="https://${WEBAUTHN_HOST:-localhost}:3001"
else
  HEALTH_URL="http://localhost:${PORT:-8080}/health"
  SITE_URL="https://${DOMAIN:-}"
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

# ── UFW check (dev only) ──────────────────────────────────────────────────────

[ "$RUN_UFW_CHECK" = "1" ] && check_ufw_port 3001

# ── Record deploy SHA ────────────────────────────────────────────────────────
# Branch update is always handled by switch-branch.sh before this script runs.

record_deploy_sha

show_deployment_info

# ── Uploads directory (prod only) ─────────────────────────────────────────────

[ "$RUN_UPLOADS_DIR" = "1" ] && mkdir -p "$REPO_DIR/uploads"

# ── Certificates and nginx pre-flight ─────────────────────────────────────────
# Cert check runs after the working tree is confirmed so we use the latest
# cert generation script from the deployed branch.

if [ "$RUN_DEV_CERTS" = "1" ]; then
  ensure_dev_certs "$LAN_IP" "${WEBAUTHN_HOST:-}"
fi

check_nginx_config "$NGINX_SERVICE"

check_disk_space

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
  [ "$RUN_VITEST"       = "1" ] && dinfo "  vitest:       would run after health check"
  [ "$RUN_ERROR_LOGGER" = "1" ] && dinfo "  error-logger: would run after vitest"
  [ "$SKIP_REGRESSION"  = "0" ] && dinfo "  regression:   would run smoke tests"
  dinfo ""
  dinfo "Re-run without --dry-run to perform the actual deploy."
  print_deploy_status "DRY RUN" "$DEPLOY_ENV"
  exit 0
fi

compose_up_with_rollback "$BACKEND_SERVICE"

# ── Health check ──────────────────────────────────────────────────────────────

wait_for_health "$BACKEND_SERVICE"

log_deploy_summary "$DEPLOY_ENV"

# ── In-container test suite (dev only — prod image built without devDependencies) ──

[ "$RUN_VITEST" = "1" ] && run_deploy_tests "$BACKEND_SERVICE"

# ── Post-deployment tests ─────────────────────────────────────────────────────

[ "$RUN_ERROR_LOGGER" = "1" ] && test_error_logger_all_pages

test_csp_reporting

# ── Regression smoke tests ────────────────────────────────────────────────────

run_regression_tests

# ── Summary ───────────────────────────────────────────────────────────────────

dinfo "Container status:"
docker compose -f "$COMPOSE_FILE" ps 2>&1 | tee -a "$LOG_FILE"

if [ "$DEPLOY_ROLLED_BACK" = "1" ]; then
  print_deploy_status "ROLLED BACK" "$DEPLOY_ENV"
  print_deploy_report "$DEPLOY_ENV — ROLLED BACK"
elif [ "$REGRESSION_RC" -ne 0 ]; then
  print_deploy_status "FAILED" "$DEPLOY_ENV"
  print_deploy_report "$DEPLOY_ENV — REGRESSION FAILED"
else
  print_deploy_status "COMPLETE" "$DEPLOY_ENV"
  print_deploy_report "$DEPLOY_ENV"
fi
dlog ""

[ "$REGRESSION_RC" -eq 0 ] || ddie "Regression smoke tests failed — rolled back; see report above"
