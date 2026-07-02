#!/usr/bin/env bash
# deploy-lib.sh — Shared helpers for dev/prod deploy scripts.
#
# Provides common primitives for:
# - Logging and coloured output
# - Prerequisite checks (docker, docker compose, git, curl)
# - Repo clone/update
# - .env loading and validation
# - docker compose up with rollback
# - HTTP health checks with rollback
#
# Callers should set these variables before sourcing this file:
#   REPO_DIR       — absolute path to repo on server
#   BRANCH         — git branch to deploy (e.g. dev, main)
#   REPO_URL       — origin URL (if clone is needed)
#   COMPOSE_FILE   — docker compose file path
#   ENV_FILE       — .env path
#   ENV_TEMPLATE   — example env path (optional)
#   LOG_FILE       — log file path
#   REQUIRED_VARS  — array of required env var names
#   PLACEHOLDER_PATTERNS — array of substrings that indicate placeholders
#   HEALTH_URL     — primary health URL
#   HEALTH_TIMEOUT — seconds to wait for health
#   HEALTH_INTERVAL— seconds between health checks
#   HEALTH_URL_2   — optional secondary health URL (e.g. HTTPS)
#   NGINX_SERVICE    — compose service name for nginx (enables nginx log capture + startup check)
#   HEALTH_INSECURE  — set to 1 to skip TLS cert verification (dev self-signed certs)
#   ROLLBACK_BRANCH  — branch to roll back to on failure (e.g. dev, main).
#                      If set and different from BRANCH, fetches and checks out this branch
#                      instead of reverting to PRE_SHA, giving a known-stable baseline.
#                      Falls back to PRE_SHA behaviour when ROLLBACK_BRANCH == BRANCH.
#   LAST_GOOD_STATE_FILE — (optional) path to save/restore last successful deployment state
#
#   DEPLOY_ENV     — environment name (dev|prod); used by run_regression_tests
#   SKIP_REGRESSION — set to 1 to skip regression smoke tests
#   SITE_HOST      — canonical hostname (dev/prod) used by run_regression_tests + cert generation
#   DOMAIN         — prod public domain used by run_regression_tests
#   BACKEND_SERVICE — compose service name for the backend container
#   NGINX_URL      — docker-internal nginx base URL for error-logger tests (e.g. https://nginx:3001)
#   NGINX_PORT     — external nginx port; read from .env (3001 dev, 443 prod)
#   CERT_MODE      — read from .env: self-signed | letsencrypt. Drives HEALTH_INSECURE,
#                    cert auto-generation, and DDNS-sync checks.
#   BACKUP_DIR     — read from .env: local directory where backups are written (#164)
#
# Optional, per-caller hooks:
#   extra_env_checks() — function for additional env validation per environment

set -euo pipefail

# ── Deployment state tracking ─────────────────────────────────────────────────

DEPLOY_ROLLED_BACK=0  # Set to 1 if we rolled back instead of deploying the intended branch
DEPLOY_STEP=0         # Auto-incrementing checkpoint counter (see dstatus)

# ── Colours and logging ───────────────────────────────────────────────────────

if [ -t 1 ]; then
  DEPLOY_RED='\033[0;31m'; DEPLOY_YELLOW='\033[0;33m'; DEPLOY_GREEN='\033[0;32m'
  DEPLOY_CYAN='\033[0;36m'; DEPLOY_BOLD='\033[1m'; DEPLOY_RESET='\033[0m'
else
  DEPLOY_RED=''; DEPLOY_YELLOW=''; DEPLOY_GREEN=''; DEPLOY_CYAN=''; DEPLOY_BOLD=''; DEPLOY_RESET=''
fi

_deploy_timestamp() { date '+%Y-%m-%d %H:%M:%S'; }

# shellcheck source=output-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/output-lib.sh"

# Redact sensitive info from logs (IP addresses, usernames, service names, hostnames)
# See docs/LOGGING.md for what should be redacted and why
_redact_sensitive() {
  local text="$1"
  # Redact IP addresses (keep format readable but obscure actual IPs)
  text=$(echo "$text" | sed -E 's/([0-9]{1,3}\.){3}[0-9]{1,3}/[REDACTED_IP]/g')
  # Redact home directory usernames
  text=$(echo "$text" | sed -E "s|/home/[a-z_][a-z0-9_-]*|/home/[USER]|g")
  # Redact root home
  text=$(echo "$text" | sed -E 's|/root|/home/[USER]|g')
  # Redact URLs with IPs
  text=$(echo "$text" | sed -E 's|https?://\[REDACTED_IP\]:[0-9]+|[REDACTED_URL]|g')
  # Redact container names (myportfoliosite-*, portfolio_dev-*, portfolio_prod-*, etc.)
  text=$(echo "$text" | sed -E 's/myportfoliosite(-dev)?-[a-z0-9_-]+/[REDACTED_CONTAINER]/g')
  # Redact old split-compose service names if they appear in archived logs
  text=$(echo "$text" | sed -E 's/(backend|nginx|postgres)-(dev|prod|local)(-[0-9])?/[REDACTED_SERVICE]/g')
  # Redact hostnames (modnar3, user machines, etc.) — but keep localhost
  text=$(echo "$text" | sed -E 's|/home/[a-z_][a-z0-9_-]*@[a-z0-9.-]+|/home/[USER]@[REDACTED_HOST]|g')
  # Redact project directory names (MyPortfolioSite-dev)
  text=$(echo "$text" | sed -E 's|/[a-z_][a-z0-9_-]*/MyPortfolioSite(-dev)?|/home/[USER]/[REDACTED_PROJECT]|g')
  echo "$text"
}

_deploy_log_raw()   {
  local msg="$(_redact_sensitive "$*")"
  echo -e "[$(_deploy_timestamp)] $msg" | tee -a "$LOG_FILE";
}

dlog()     { _verbose && _deploy_log_raw "$*" || true; }
dinfo()    { _verbose && _deploy_log_raw "${DEPLOY_CYAN}${DEPLOY_BOLD}ℹ  [INFO]${DEPLOY_RESET}  $*" || true; }
dok()      { _verbose && _deploy_log_raw "${DEPLOY_GREEN}${DEPLOY_BOLD}✅ [OK]${DEPLOY_RESET}    $*" || true; }
dwarn()    { _deploy_log_raw "${DEPLOY_YELLOW}${DEPLOY_BOLD}⚠️  [WARN]${DEPLOY_RESET}  $*"; }
dfail()    { _deploy_log_raw "${DEPLOY_RED}${DEPLOY_BOLD}❌ [ERROR]${DEPLOY_RESET} $*"; }
dsection() { _verbose && { _deploy_log_raw ""; _deploy_log_raw "${DEPLOY_CYAN}${DEPLOY_BOLD}🔷 ── $* ───────────────────────────────────────────${DEPLOY_RESET}"; } || true; }

# Machine-readable checkpoint line — grep-friendly, no colour codes.
# Always printed regardless of DEPLOY_QUIET. Omits ts= to keep lines short in
# the report. Each line carries an auto-incrementing step= number so the
# phase order is visible even in quiet mode (where section headers are hidden).
# Usage: dstatus <phase> key=value [key=value ...]
# Output: [deploy:<phase>] step=<n> key=value key=value
dstatus() {
  local phase="$1"; shift
  DEPLOY_STEP=$((DEPLOY_STEP + 1))
  local msg="[deploy:${phase}] step=${DEPLOY_STEP} $*"
  # No colour codes — these lines are parsed by print_deploy_report
  echo "$msg" | tee -a "$LOG_FILE"
  if _verbose; then
    echo -e "${DEPLOY_BOLD}${DEPLOY_CYAN}📋 checkpoint:${DEPLOY_RESET} ${msg}"
  else
    # In quiet mode show a single tick/cross per step so progress is visible
    local _status; _status=$(echo "$*" | grep -oP '(?<=status=)\S+' || true)
    case "$_status" in
      ok|up-to-date|exists|cloned|created|migrated|cleaned|rebuilt|wrapper-managed|skipped|updated|installed|detected|free)
        echo -e "${DEPLOY_GREEN}${DEPLOY_BOLD}  ✔  ${DEPLOY_RESET}[${phase}] ${_status}" ;;
      failed|missing|error|blocked|low|warn|mismatch)
        echo -e "${DEPLOY_RED}${DEPLOY_BOLD}  ✘  ${DEPLOY_RESET}[${phase}] ${_status}" ;;
      *) true ;;
    esac
  fi
}

# Suppress verbose output when DEPLOY_QUIET=1. Only dstatus, dwarn, dfail, and ddie
# produce output in quiet mode — dinfo, dok, dlog, dsection are silenced.
_verbose() { [ "${DEPLOY_QUIET:-0}" != "1" ]; }

ddie() {
  dfail "$*"
  dlog "See full log at: $LOG_FILE"
  exit 1
}

# Run a command with root privileges WITHOUT ever blocking on a password
# prompt — deploys run non-interactively over SSH, so a plain `sudo` would
# hang or silently fail. Resolution order: already root → run directly;
# passwordless sudo available → `sudo -n`; otherwise return 126 (root
# required but unavailable) so callers can skip gracefully rather than
# emit a misleading failure/warning.
# Usage:
#   out=$(try_root ufw status) && echo "$out" | grep ...
#   if try_root systemctl is-active docker; then ...; fi
#   try_root returns 126 → caller should dinfo-skip, not dwarn
try_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif sudo -n true 2>/dev/null; then
    sudo -n "$@"
  else
    return 126
  fi
}

# ── Docker / compose / rollback — see deploy-lib-docker.sh ───────────────────

init_log_banner() {
  local title="$1"
  # Record where this run starts in the (append-only) log so the final report
  # only includes checkpoints from THIS deploy, not every prior run.
  DEPLOY_LOG_START=$([ -f "$LOG_FILE" ] && wc -l < "$LOG_FILE" || echo 0)
  # Always printed regardless of DEPLOY_QUIET — provides run context in all modes
  _print_box "${DEPLOY_CYAN}${DEPLOY_BOLD}" "🚀 ${title} — $(_deploy_timestamp)"
}

# Pipe command output to the log. In verbose mode also echoes to terminal.
# Usage: some_command 2>&1 | _log_cmd
_log_cmd() {
  if _verbose; then
    tee -a "$LOG_FILE"
  else
    cat >> "$LOG_FILE"
  fi
}

# ── Test-output parsing helpers ───────────────────────────────────────────────
# Normalise the wildly different summary formats each test runner prints into a
# consistent "tests / passed / failed" triple, so the deploy report shows the
# three test suites (backend / frontend / regression) in a comparable shape.
# Backend (vitest) counts come from its json reporter (see run_deploy_tests),
# not from scraping the pretty summary, which drifts across environments.

# Extract a numeric `key=N` value from a single summary line. Echoes the number
# (or nothing if absent). Anchored on a leading space/start so `passed` doesn't
# also match e.g. `skipped`. `|| true` keeps a no-match from aborting under set -e.
_kv_num() { printf '%s' "$1" | grep -oE "(^| )$2=[0-9]+" | head -1 | grep -oE '[0-9]+' || true; }
_kv_str() { printf '%s' "$1" | grep -oE "(^| )$2=[^ ]+" | head -1 | sed "s/.*$2=//" || true; }

# ── Prerequisites ─────────────────────────────────────────────────────────────

require_tools() {
  dsection "Phase 0: checking prerequisites"

  local missing=()
  for tool in "$@"; do
    case "$tool" in
      docker)
        if ! command -v docker >/dev/null 2>&1; then
          missing+=("docker")
        fi
        if ! docker compose version >/dev/null 2>&1; then
          missing+=("docker-compose-plugin (sudo apt install docker-compose-plugin)")
        fi
        ;;
      *)
        if ! command -v "$tool" >/dev/null 2>&1; then
          missing+=("$tool")
        fi
        ;;
    esac
  done

  if [ "${#missing[@]}" -gt 0 ]; then
    dstatus preflight status=failed missing="${missing[*]}"
    dfail "Missing required tools:"
    for t in "${missing[@]}"; do
      dfail "  • $t"
    done
    ddie "Install missing tools then re-run this script."
  fi

  if ! docker info >/dev/null 2>&1; then
    dstatus preflight status=failed reason=docker-daemon-not-running
    ddie "Docker daemon is not running. Start it with: sudo systemctl start docker"
  fi

  dstatus preflight status=ok tools="$*"
  dok "All prerequisites satisfied (${*})"
}

# ── Compose shorthand ─────────────────────────────────────────────────────────
# Wraps `docker compose -f "$COMPOSE_FILE"` so callers stay concise.
# COMPOSE_FILE is set by each deploy script before sourcing this file.
dc() { docker compose -f "$COMPOSE_FILE" "$@"; }

# ── Repo helpers ───────────────────────────────────────────────────────────────

ensure_repo_cloned() {
  dsection "Phase 1: ensuring repository exists"

  if [ ! -d "$REPO_DIR" ]; then
    dinfo "Repo not found at $REPO_DIR — cloning..."
    git clone "$REPO_URL" "$REPO_DIR" 2>&1 | _log_cmd || ddie "git clone failed. Check your internet connection."
    cd "$REPO_DIR"
    git checkout "$BRANCH" 2>&1 | _log_cmd || ddie "Could not switch to $BRANCH branch."
    dstatus repo status=cloned branch="$BRANCH"
    dok "Repo cloned and set to $BRANCH branch."
  else
    dstatus repo status=exists
    dok "Repo found at $REPO_DIR"
  fi
}

update_to_branch() {
  dsection "Phase 2: updating to latest $BRANCH branch"

  cd "$REPO_DIR"

  PRE_SHA=$(git rev-parse HEAD 2>/dev/null || echo "none")
  dinfo "Current commit: $PRE_SHA"

  git fetch origin "$BRANCH" 2>&1 | _log_cmd || ddie "git fetch failed. Check your internet connection."
  git reset --hard "origin/$BRANCH" 2>&1 | _log_cmd

  NEW_SHA=$(git rev-parse HEAD)
  if [ "$NEW_SHA" = "$PRE_SHA" ]; then
    dinfo "Already at latest commit — no code changes."
    dstatus git status=up-to-date branch="$BRANCH" sha="${NEW_SHA:0:7}"
  else
    dok "Updated: ${PRE_SHA:0:7} → ${NEW_SHA:0:7}"
    dstatus git status=updated branch="$BRANCH" pre="${PRE_SHA:0:7}" sha="${NEW_SHA:0:7}"
  fi
}

# Record current HEAD as the deploy SHA without performing any git update.
# Use when branch switching is handled by an external wrapper (e.g. switch-branch.sh).
# Sets PRE_SHA and NEW_SHA so rollback logic has a valid reference.
record_deploy_sha() {
  dsection "Phase 2: recording deploy SHA (branch managed by wrapper)"

  cd "$REPO_DIR"

  PRE_SHA=$(git rev-parse HEAD 2>/dev/null || echo "none")
  NEW_SHA="$PRE_SHA"

  dstatus git status=wrapper-managed branch="$BRANCH" sha="${NEW_SHA:0:7}"
  dinfo "Branch update handled by wrapper — current HEAD: ${NEW_SHA:0:7}"
}

# ── Reporting — see deploy-lib-report.sh ──────────────────────────────────────

# ── Env helpers — see deploy-lib-env.sh ─────────────────────────────────────

# ── Health checks — see deploy-lib-health.sh ────────────────────────────────

# ── Pre-flight checks — see deploy-lib-checks.sh ───────────────────────────

# ── Deploy tests — see deploy-lib-tests.sh ──────────────────────────────────

# ── Sub-libraries ─────────────────────────────────────────────────────────────
# Sourced in dependency order. All callers source deploy-lib.sh; these files
# are never sourced directly.
_DEPLOY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy-lib-env.sh
. "${_DEPLOY_LIB_DIR}/deploy-lib-env.sh"
# shellcheck source=deploy-lib-checks.sh
. "${_DEPLOY_LIB_DIR}/deploy-lib-checks.sh"
# shellcheck source=deploy-lib-health.sh
. "${_DEPLOY_LIB_DIR}/deploy-lib-health.sh"
# shellcheck source=deploy-lib-docker.sh
. "${_DEPLOY_LIB_DIR}/deploy-lib-docker.sh"
# shellcheck source=deploy-lib-tests.sh
. "${_DEPLOY_LIB_DIR}/deploy-lib-tests.sh"
# shellcheck source=deploy-lib-report.sh
. "${_DEPLOY_LIB_DIR}/deploy-lib-report.sh"
