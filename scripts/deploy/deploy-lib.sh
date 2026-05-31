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

# ── Last-good state tracking ──────────────────────────────────────────────────

_save_last_good_state() {
  local branch="$1"
  local sha="$2"
  local state_file="${LAST_GOOD_STATE_FILE:-${HOME}/.last-good-deploy}"

  if [ -z "$state_file" ]; then
    return  # State tracking disabled if file path not set
  fi

  if echo "BRANCH=$branch" > "$state_file"; then
    echo "SHA=$sha" >> "$state_file"
    dinfo "Saved last-good state: $branch@${sha:0:7}"
  else
    dwarn "Could not save last-good state to $state_file"
  fi
}

_restore_last_good_state() {
  local state_file="${LAST_GOOD_STATE_FILE:-${HOME}/.last-good-deploy}"

  if [ -z "$state_file" ] || [ ! -f "$state_file" ]; then
    return 1  # No saved state
  fi

  # Source the state file to get BRANCH and SHA variables
  set +u
  source "$state_file" 2>/dev/null || return 1
  set -u

  if [ -n "${BRANCH:-}" ] && [ -n "${SHA:-}" ]; then
    echo "$BRANCH" "$SHA"
    return 0
  fi

  return 1
}

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

show_deployment_info() {
  dsection "Deployment details"

  cd "$REPO_DIR"

  local current_branch
  current_branch=$(git rev-parse --abbrev-ref HEAD)
  dinfo "Branch: $current_branch"

  local commit_sha
  commit_sha=$(git rev-parse --short HEAD)
  dinfo "Commit: $commit_sha"

  local commit_msg
  commit_msg=$(git log -1 --pretty=%B HEAD)
  dinfo "Message: $commit_msg"
}

# ── Env helpers ────────────────────────────────────────────────────────────────

ensure_env_file() {
  dsection "Phase 3: checking .env"

  if [ -f "$ENV_FILE" ]; then
    dstatus envfile status=ok
    dok ".env present at $ENV_FILE"
    return
  fi

  if [ -n "${ENV_TEMPLATE:-}" ] && [ -f "$ENV_TEMPLATE" ]; then
    dstatus envfile status=created reason=copied-from-template
    dinfo ".env not found — copying from template: $ENV_TEMPLATE"
    cp "$ENV_TEMPLATE" "$ENV_FILE"
    dwarn ""
    dwarn "  .env created but not yet configured."
    dwarn "  Edit $ENV_FILE and set all required values before re-running."
    ddie "Configure .env then re-run this script."
  else
    dstatus envfile status=missing reason=no-template
    ddie ".env not found and ENV_TEMPLATE not available. Check your checkout or set ENV_FILE explicitly."
  fi
}

load_env() {
  # Parse .env line-by-line and export each KEY=VALUE directly. Going via
  # `source` would treat values as bash code, so any unescaped paren, space,
  # `$`, backtick, or quote in a password/display name would break the parse
  # and silently drop every variable after it. Reading raw lines avoids that
  # entirely — values are taken verbatim, exactly as written in .env.
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip blanks and comments
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    # Match KEY=VALUE (key must be uppercase/underscore/digit, value is rest of line)
    if [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      # Strip a single matched pair of surrounding quotes (single or double) —
      # common dotenv convention. Unmatched quotes are left intact.
      if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
        value="${BASH_REMATCH[1]}"
      fi
      # Expand a leading ~/ to $HOME/ for path variables. Pure substitution —
      # does not execute bash code, so complex passwords with ~ in other positions
      # are unaffected.
      [[ "$value" == "~/"* ]] && value="$HOME/${value:2}"
      export "$key=$value"
    fi
  done < "$ENV_FILE"
}

# Print the current .env with secret values masked.
# Keys matching *SECRET*|*TOKEN*|*PASS*|*KEY*|*REFRESH*|*CREDENTIAL*|*EMAIL*|*_ID have their
# value replaced with [redacted]. Safe to include in deploy logs.
redact_env() {
  local file="${1:-$ENV_FILE}"
  local sensitive_pattern='SECRET|TOKEN|PASS|KEY|REFRESH|CREDENTIAL|EMAIL|_ID'

  while IFS= read -r line; do
    # Pass through blank lines and comments unchanged
    if [[ "$line" =~ ^[[:space:]]*$ ]] || [[ "$line" =~ ^[[:space:]]*# ]]; then
      echo "$line"
      continue
    fi
    # For KEY=VALUE lines, redact the value if the key is sensitive
    if [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]]; then
      local key="${BASH_REMATCH[1]}"
      local val="${BASH_REMATCH[2]}"
      if echo "$key" | grep -qE "$sensitive_pattern"; then
        # Show that a value exists but not what it is
        if [ -n "$val" ]; then
          echo "${key}=[redacted]"
        else
          echo "${key}=(empty)"
        fi
      else
        echo "$line"
      fi
    else
      echo "$line"
    fi
  done < "$file"
}

# Rebuild .env from the template, carrying over values for any keys still
# present in the template. The template becomes the canonical structure
# (ordering, comments, section headers); the operator's existing values are
# preserved verbatim. Keys no longer in the template are dropped (but the
# previous .env is timestamped and kept as a backup).
#
# Returns 0 if the rebuilt .env contains no template placeholders for new
# keys, 1 if newly-introduced keys still hold their template default and
# need the operator's attention.
sync_env_from_template() {
  dsection "Phase 3b: rebuilding .env from template"

  if [ -z "${ENV_TEMPLATE:-}" ]; then
    dstatus envsync status=skipped reason=no-template-var
    dwarn "ENV_TEMPLATE not set — .env drift detection disabled (set ENV_TEMPLATE to enable)"
    return 0
  fi
  if [ ! -f "$ENV_TEMPLATE" ]; then
    dstatus envsync status=skipped reason=template-not-found
    dwarn "ENV_TEMPLATE '$ENV_TEMPLATE' not found — .env drift detection skipped"
    return 0
  fi

  # Load existing KEY=VALUE pairs into an associative array (raw values,
  # quotes and all). First '=' is the separator.
  declare -A existing_values
  local existing_keys_list=""
  while IFS= read -r line; do
    if [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]]; then
      local k="${BASH_REMATCH[1]}"
      local v="${BASH_REMATCH[2]}"
      existing_values["$k"]="$v"
      existing_keys_list+="${k}"$'\n'
    fi
  done < "$ENV_FILE"

  # Build the new .env in a temp file by walking the template.
  local tmp_env="${ENV_FILE}.sync.$$"
  : > "$tmp_env"

  local template_keys_list=""
  local carried_count=0
  local new_keys=()
  local placeholder_keys=()

  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]]; then
      local key="${BASH_REMATCH[1]}"
      local template_value="${BASH_REMATCH[2]}"
      template_keys_list+="${key}"$'\n'
      # Carry over only if the existing value is non-empty. An empty
      # ADMIN_EMAIL= in the old file is effectively unset, so fall back
      # to the template default so validate_env / prompt_missing_vars can
      # flag it as a placeholder rather than silently dropping the key.
      if [ -n "${existing_values[$key]:-}" ]; then
        printf '%s=%s\n' "$key" "${existing_values[$key]}" >> "$tmp_env"
        carried_count=$((carried_count + 1))
      else
        printf '%s\n' "$line" >> "$tmp_env"
        new_keys+=("$key")
        # Only flag as a placeholder requiring action if the template value
        # matches a known placeholder pattern (e.g. "change-me", "your-").
        # An empty template value (KEY=) means the key is optional —
        # add it to .env silently and do not block the deploy (#352).
        local is_ph=0
        local pat
        for pat in "${PLACEHOLDER_PATTERNS[@]}"; do
          if [[ "$template_value" == *"$pat"* ]]; then
            is_ph=1
            break
          fi
        done
        [ "$is_ph" = "1" ] && placeholder_keys+=("$key")
      fi
    else
      # Comment, blank line, section header — copy verbatim from template
      printf '%s\n' "$line" >> "$tmp_env"
    fi
  done < "$ENV_TEMPLATE"

  # Detect dropped keys (in old .env but no longer in template)
  local dropped_keys=()
  while IFS= read -r k; do
    [ -z "$k" ] && continue
    if ! printf '%s' "$template_keys_list" | grep -qx "$k"; then
      dropped_keys+=("$k")
    fi
  done <<< "$existing_keys_list"

  # If nothing would change (no new, no dropped) we still rebuild — the
  # template may have re-ordered or re-commented sections — but only swap
  # the file if it actually differs, to avoid noisy timestamps.
  if cmp -s "$tmp_env" "$ENV_FILE"; then
    rm -f "$tmp_env"
    dstatus envsync status=ok carried="$carried_count"
    dok ".env already matches template structure — no changes needed"
    return 0
  fi

  # Back up the old .env, then atomically replace.
  local backup="${ENV_FILE}.bak-$(date '+%Y%m%d-%H%M%S')"
  cp "$ENV_FILE" "$backup"
  mv "$tmp_env" "$ENV_FILE"

  dok "Rebuilt $ENV_FILE from template (backup: $backup)"
  dlog "  carried over: $carried_count keys"
  if [ "${#new_keys[@]}" -gt 0 ]; then
    # Split new keys into required-action (placeholder) vs optional (empty template value).
    local required_keys=() optional_keys=()
    local k
    for k in "${new_keys[@]}"; do
      if printf '%s\n' "${placeholder_keys[@]:-}" | grep -qx "$k"; then
        required_keys+=("$k")
      else
        optional_keys+=("$k")
      fi
    done
    if [ "${#required_keys[@]}" -gt 0 ]; then
      dwarn "  new keys (template default in place — review and set real values):"
      for k in "${required_keys[@]}"; do dwarn "    + $k"; done
    fi
    if [ "${#optional_keys[@]}" -gt 0 ]; then
      dinfo "  new optional keys added (empty by default — configure only if needed):"
      for k in "${optional_keys[@]}"; do dinfo "    + $k"; done
    fi
  fi
  if [ "${#dropped_keys[@]}" -gt 0 ]; then
    dlog "  dropped keys (not in template — preserved only in backup):"
    local k
    for k in "${dropped_keys[@]}"; do
      dlog "    - $k"
    done
  fi

  if [ "${#placeholder_keys[@]}" -gt 0 ]; then
    dstatus envsync status=keys-added carried="$carried_count" added="${#new_keys[@]}" dropped="${#dropped_keys[@]}" reason=action-required
    dwarn ""
    dwarn "  Action required: edit $ENV_FILE and set the new vars above before re-running."
    return 1
  fi

  dstatus envsync status=rebuilt carried="$carried_count" added=0 dropped="${#dropped_keys[@]}"
  return 0
}

# Log a redacted snapshot of the current .env to the deploy log.
log_env_snapshot() {
  dsection "Active .env (secrets redacted)"
  redact_env "$ENV_FILE" | while IFS= read -r line; do
    dlog "  $line"
  done
}

validate_env() {
  dsection "Phase 4: validating .env"

  local errors=()

  for var in "${REQUIRED_VARS[@]}"; do
    local value="${!var:-}"
    if [ -z "$value" ]; then
      errors+=("$var is not set")
      continue
    fi
    for pattern in "${PLACEHOLDER_PATTERNS[@]}"; do
      if [[ "$value" == *"$pattern"* ]]; then
        errors+=("$var still contains placeholder value ('$pattern') — set a real value")
        break
      fi
    done
  done

  if declare -F extra_env_checks >/dev/null 2>&1; then
    # extra_env_checks should append to the global errors array if needed
    extra_env_checks errors
  fi

  if [ "${#errors[@]}" -gt 0 ]; then
    dstatus env status=failed
    dfail ".env validation failed:"
    for err in "${errors[@]}"; do
      dfail "  • $err"
    done
    dfail ""
    dfail "Current .env contents (secrets redacted) — for debugging:"
    dfail "  file: $ENV_FILE"
    redact_env "$ENV_FILE" | while IFS= read -r line; do
      dfail "    $line"
    done
    ddie "Fix the above .env issues then re-run."
  fi

  dstatus env status=ok
  dok "All required env vars set and valid."
}

# Detect .env values whose meaning has changed across template versions and
# offer to update them. sync_env_from_template carries existing values
# verbatim, so a variable like NGINX_SERVICE=nginx-dev (valid in the old
# split compose files) survives into a world where the unified compose file
# only knows a service called `nginx`. Each migration entry is the form
#   KEY|expected_new_value|deprecated_regex|reason
# If the live value matches the deprecated regex and differs from the
# expected new value, prompt the operator (interactive) or warn loudly
# (non-interactive) and update ENV_FILE in place. Call after load_env so
# the exported vars and ENV_FILE both end up consistent.
migrate_env_values() {
  dsection "Phase 3c: checking for outdated .env values"

  # Vars whose value must reference a real docker-compose service. If the
  # current value isn't in the compose file's actual service list, the
  # deploy will fail later with a confusing "no such service" — catch it
  # here and offer to update .env to a service that does exist.
  local service_vars=(NGINX_SERVICE BACKEND_SERVICE)
  # Preferred replacement when the current value is wrong. Falls back to
  # whatever service does exist if the preferred name isn't there either.
  declare -A preferred=(
    [NGINX_SERVICE]=nginx
    [BACKEND_SERVICE]=backend
  )

  # Pull the list of services the unified compose file actually defines.
  # docker compose config --services is the authoritative answer; if it
  # fails (e.g. compose can't parse the file) we skip this check rather
  # than block the deploy on a secondary signal.
  local available_services
  if ! available_services=$(docker compose -f "$COMPOSE_FILE" config --services 2>/dev/null); then
    dstatus envmigrate status=skipped reason=compose-config-failed
    dwarn "Could not list compose services — skipping .env migration check"
    return 0
  fi

  # Auto-yes (set by --auto-yes / -AutoYes from the PS1 wrapper) accepts every
  # suggested migration without prompting. Otherwise prompt only on a real TTY.
  local interactive=0
  if [ "${AUTO_YES:-0}" = "1" ]; then
    interactive=2  # auto-accept
  elif [ -t 0 ]; then
    interactive=1
  fi

  local migrated=0 flagged=0
  local key
  for key in "${service_vars[@]}"; do
    local current="${!key:-}"
    [ -z "$current" ] && continue
    # If the current value is a real service, nothing to do.
    if grep -qx "$current" <<< "$available_services"; then
      continue
    fi

    flagged=$((flagged + 1))
    local target="${preferred[$key]}"
    # If the preferred replacement isn't a real service either, pick the
    # first available service as a last-resort suggestion.
    if ! grep -qx "$target" <<< "$available_services"; then
      target=$(head -n1 <<< "$available_services")
    fi

    # In auto-yes mode the per-key chatter is informational only (status
    # line still records the migration); demote to dinfo so quiet mode
    # stays quiet. Otherwise the operator needs to see it — use dwarn.
    local _say
    if [ "$interactive" = "2" ]; then _say=dinfo; else _say=dwarn; fi
    $_say "$key='$current' is not a service in $COMPOSE_FILE"
    $_say "  available services: $(tr '\n' ' ' <<< "$available_services")"
    $_say "  suggested value: '$target'"

    local do_update=0
    case "$interactive" in
      2)  # --auto-yes: accept without prompting
        dinfo "  auto-accepting (--auto-yes): $key → '$target'"
        do_update=1
        ;;
      1)  # interactive TTY: prompt
        printf "  Update %s to '%s' in %s? [Y/n] " "$key" "$target" "$ENV_FILE"
        local reply
        read -r reply
        case "$reply" in
          ''|y|Y|yes|YES) do_update=1 ;;
        esac
        ;;
      *)  # non-interactive, no auto-yes: warn and leave alone
        dwarn "  non-interactive run — set $key=$target in $ENV_FILE before re-running (or pass --auto-yes)"
        ;;
    esac

    if [ "$do_update" = "1" ]; then
      if grep -qE "^${key}=" "$ENV_FILE"; then
        sed -i "s|^${key}=.*|${key}=${target}|" "$ENV_FILE"
      else
        printf '%s=%s\n' "$key" "$target" >> "$ENV_FILE"
      fi
      export "$key=$target"
      migrated=$((migrated + 1))
      dok "  $key updated to '$target'"
    fi
  done

  if [ "$flagged" -eq 0 ]; then
    dstatus envmigrate status=ok flagged=0
    dok "No outdated .env values detected"
  else
    dstatus envmigrate status=migrated flagged="$flagged" migrated="$migrated"
    if [ "$migrated" -lt "$flagged" ]; then
      dwarn "$((flagged - migrated)) outdated value(s) left in place — deploy will likely fail downstream."
    fi
  fi
}

# Tear down any compose stacks that this codebase used to use under a
# different COMPOSE_PROJECT_NAME. `docker compose up --remove-orphans` only
# cleans orphans within the current project, so containers from earlier
# project names (e.g. myportfoliosite-dev before the compose unification)
# linger forever, holding ports and confusing nginx/backend dependency
# resolution. Detect them via `docker compose ls -a` and tear them down.
cleanup_stale_compose_projects() {
  dsection "Phase 3d: cleaning up stale compose stacks"

  # Project names this codebase has used historically that are safe to tear
  # down. ONLY include names that can never be an active prod or dev stack:
  # - myportfoliosite-dev: old dev stack name before compose unification
  # Do NOT include myportfoliosite — prod still uses that name until the
  # #300 PR is merged and prod is migrated to portfolio_prod.
  local known_stale_projects=(
    myportfoliosite-dev
  )

  local active_projects
  if ! active_projects=$(docker compose ls -a --format json 2>/dev/null \
        | grep -oE '"Name":"[^"]+"' | cut -d'"' -f4 | sort -u); then
    dstatus stalecleanup status=skipped reason=compose-ls-failed
    dwarn "Could not list compose projects — skipping stale-stack cleanup"
    return 0
  fi

  local interactive=0
  if [ "${AUTO_YES:-0}" = "1" ]; then
    interactive=2
  elif [ -t 0 ]; then
    interactive=1
  fi

  local stale_found=()
  local proj
  for proj in "${known_stale_projects[@]}"; do
    # Never tear down the project this deploy is running as.
    [ "$proj" = "${COMPOSE_PROJECT_NAME:-}" ] && continue
    if grep -qx "$proj" <<< "$active_projects"; then
      stale_found+=("$proj")
    fi
  done

  if [ "${#stale_found[@]}" -eq 0 ]; then
    dstatus stalecleanup status=ok stale=0
    dok "No stale compose stacks present"
    return 0
  fi

  local _say
  if [ "$interactive" = "2" ]; then _say=dinfo; else _say=dwarn; fi
  $_say "Found ${#stale_found[@]} stale compose stack(s): ${stale_found[*]}"
  $_say "  These predate the compose unification (COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-?})"
  $_say "  and will block ports / confuse dependency resolution if left running."

  local removed=0
  for proj in "${stale_found[@]}"; do
    local do_remove=0
    case "$interactive" in
      2) dinfo "  auto-accepting (--auto-yes): tearing down project '$proj'"
         do_remove=1 ;;
      1) printf "  Tear down compose project '%s'? [Y/n] " "$proj"
         local reply
         read -r reply
         case "$reply" in
           ''|y|Y|yes|YES) do_remove=1 ;;
         esac ;;
      *) dwarn "  non-interactive run — manually run: docker compose -p $proj down --remove-orphans" ;;
    esac

    if [ "$do_remove" = "1" ]; then
      if docker compose -p "$proj" down --remove-orphans 2>&1 | _log_cmd; then
        removed=$((removed + 1))
        dok "  $proj torn down"
      else
        dwarn "  failed to tear down $proj — may need manual cleanup"
      fi
    fi
  done

  dstatus stalecleanup status=cleaned stale="${#stale_found[@]}" removed="$removed"
}

# Interactively prompt the operator for any REQUIRED_VARS that are still empty or
# contain placeholder values. Only runs when stdin is a TTY (not in CI or piped
# deploys). Writes updated values directly to ENV_FILE so validate_env sees them.
prompt_missing_vars() {
  # Skip entirely if not interactive — piped/CI runs get a clear error from validate_env
  if [ ! -t 0 ]; then
    return 0
  fi

  local needs_reload=0

  for var in "${REQUIRED_VARS[@]}"; do
    local value="${!var:-}"
    local is_placeholder=0

    if [ -z "$value" ]; then
      is_placeholder=1
    else
      for pattern in "${PLACEHOLDER_PATTERNS[@]}"; do
        if [[ "$value" == *"$pattern"* ]]; then
          is_placeholder=1
          break
        fi
      done
    fi

    if [ "$is_placeholder" = "1" ]; then
      dwarn "$var is not set or still contains a placeholder value."
      printf "  Enter value for %s: " "$var"
      local new_val
      read -r new_val
      if [ -n "$new_val" ]; then
        # Update or append KEY=VALUE in ENV_FILE
        if grep -qE "^${var}=" "$ENV_FILE" 2>/dev/null; then
          sed -i "s|^${var}=.*|${var}=${new_val}|" "$ENV_FILE"
        else
          echo "${var}=${new_val}" >> "$ENV_FILE"
        fi
        export "${var}=${new_val}"
        needs_reload=1
        dok "$var updated."
      else
        dwarn "$var left unchanged — validate_env may fail."
      fi
    fi
  done

  if [ "$needs_reload" = "1" ]; then
    dinfo "Reloading .env after interactive updates..."
    load_env
  fi
}

# ── Dev certificates (HTTPS with self-signed) ──────────────────────────────────

ensure_dev_certs() {
  local lan_ip="$1"
  local webauthn_host="${2:-}"
  local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local cert_script="${script_dir}/../setup/generate-dev-certs.sh"
  local cert_dir="${script_dir}/../config/certs"
  local cert_file="${cert_dir}/dev-server.crt"
  local key_file="${cert_dir}/dev-server.key"

  # WebAuthn needs the cert to cover the hostname (the RP ID), not the IP.
  local cert_match="${webauthn_host:-$lan_ip}"

  dsection "Checking SSL certificates for HTTPS on port 3001"

  if ! [ -f "$cert_script" ]; then
    ddie "Certificate generation script not found at $cert_script"
  fi

  # Idempotency check: only regenerate if certs are missing or the hostname
  # (or IP, when no hostname) isn't present in the cert SAN.
  local should_regenerate=false
  if [ -f "$cert_file" ] && [ -f "$key_file" ]; then
    if openssl x509 -noout -text -in "$cert_file" 2>/dev/null | grep -E "DNS:|IP Address:" | grep -q "$cert_match"; then
      dok "SSL certificates present and cover $cert_match — skipping regeneration"
    else
      dwarn "Certificate does not cover $cert_match, regenerating..."
      should_regenerate=true
    fi
  else
    dwarn "Dev certificates missing, generating fresh dev certificates..."
    should_regenerate=true
  fi

  # Generate certificates if needed
  if [ "$should_regenerate" = true ]; then
    if bash "$cert_script" "$lan_ip" "$webauthn_host" 2>&1 | _log_cmd; then
      dinfo "Certificate generation passed"
    else
      dstatus certs status=failed reason=generation-failed
      ddie "Failed to generate SSL certificates. Check LAN_IP / SITE_HOST in .env."
    fi
  fi

  # Verify certificate files exist
  if ! [ -f "$cert_file" ]; then
    dstatus certs status=failed reason=cert-file-missing
    ddie "Certificate file not found at $cert_file after generation"
  fi
  if ! [ -f "$key_file" ]; then
    dstatus certs status=failed reason=key-file-missing
    ddie "Certificate key file not found at $key_file after generation"
  fi

  # Verify certificate validity
  if ! openssl x509 -in "$cert_file" -noout >/dev/null 2>&1; then
    dstatus certs status=failed reason=invalid-cert
    ddie "Certificate at $cert_file is invalid or corrupted"
  fi

  # Verify certificate hasn't expired
  local expiry_date
  expiry_date=$(openssl x509 -enddate -noout -in "$cert_file" 2>/dev/null | cut -d= -f2)
  if [ -z "$expiry_date" ]; then
    dwarn "Could not verify certificate expiry date"
  else
    dinfo "Certificate expires: $expiry_date"
  fi

  # Verify certificate covers the WebAuthn host (or IP when no host configured)
  if ! openssl x509 -noout -text -in "$cert_file" 2>/dev/null | grep -E "DNS:|IP Address:" | grep -q "$cert_match"; then
    dwarn "Certificate may not cover $cert_match"
  fi

  # Verify file permissions (nginx needs read access)
  if ! [ -r "$cert_file" ] || ! [ -r "$key_file" ]; then
    dstatus certs status=failed reason=permissions
    ddie "Certificate files exist but are not readable (permissions issue)"
  fi

  dstatus certs status=ok host="$cert_match"
  dok "SSL certificates verified and ready for $cert_match"
}

# ── Nginx config pre-flight ────────────────────────────────────────────────────

check_nginx_config() {
  local nginx_service="${1:-nginx}"

  dsection "Pre-flight: nginx configuration test"

  # Runs nginx -t inside a throw-away container using the same compose env and
  # volume mounts, so template substitution and cert paths are tested for real.
  # Capture output so we can surface it inline on failure (in non-verbose mode
  # _log_cmd only writes to the log file, hiding the real error from the operator).
  local nginx_output nginx_failed=0
  # Wrap in `if` so set -e doesn't abort on a non-zero exit before we capture
  # and surface the output.
  if ! nginx_output=$(docker compose -f "$COMPOSE_FILE" run --rm --no-deps "$nginx_service" nginx -t 2>&1); then
    nginx_failed=1
  fi
  echo "$nginx_output" | _log_cmd
  if [ "$nginx_failed" -eq 1 ]; then
    dstatus nginx status=failed reason=config-test-failed
    dfail ""
    dfail "Nginx config test failed. Common causes:"
    dfail "  • SSL cert or key file missing at the path mounted into the container"
    dfail "  • Syntax error in nginx config template"
    dfail "  • Environment variable not set (check .env and COMPOSE_FILE)"
    dfail ""
    dfail "nginx -t output:"
    while IFS= read -r line; do
      dfail "  $line"
    done <<< "$nginx_output"
    # Return rather than ddie so the caller can trigger rollback before exiting.
    return 1
  fi

  dstatus nginx status=ok
  dok "Nginx config test passed"

  # Compare what the template renders NOW against what is live in the running
  # container. Only remove the container if they differ — or if no container is
  # running. This avoids unnecessary recreation on deploys where nginx config
  # hasn't changed, while still guaranteeing a fresh start when it has.
  local new_config current_config
  new_config=$(docker compose -f "$COMPOSE_FILE" run --rm --no-deps "$nginx_service" \
    sh -c 'cat /etc/nginx/conf.d/default.conf' 2>/dev/null || echo "")
  current_config=$(docker compose -f "$COMPOSE_FILE" exec -T "$nginx_service" \
    sh -c 'cat /etc/nginx/conf.d/default.conf' 2>/dev/null || echo "")

  if [ -n "$new_config" ] && [ "$new_config" = "$current_config" ]; then
    dok "Nginx config unchanged — container will be reused"
  else
    if [ -z "$current_config" ]; then
      dinfo "No running nginx container — will be created fresh by compose up"
    else
      dinfo "Nginx config changed — removing container for clean start"
    fi
    dinfo "Rendered nginx config:"
    echo "$new_config" | _log_cmd
    docker compose -f "$COMPOSE_FILE" rm -fs "$nginx_service" 2>/dev/null | _log_cmd || true
  fi
}

# ── Rollback helper ───────────────────────────────────────────────────────────

_do_rollback() {
  local reason="$1"

  cd "$REPO_DIR"

  # Try to restore last-good state first
  if _restore_last_good_state > /dev/null 2>&1; then
    read -r rollback_branch rollback_sha < <(_restore_last_good_state)
    dstatus rollback reason="$reason" target="${rollback_branch}@${rollback_sha:0:7}" method=last-good-state
    dwarn "Rolling back to last-good state: $rollback_branch@${rollback_sha:0:7} after: $reason"
    git checkout -B "$rollback_branch" "$rollback_sha" 2>&1 | tee -a "$LOG_FILE" || true
    docker compose -f "$COMPOSE_FILE" down --remove-orphans 2>&1 | tee -a "$LOG_FILE" || true
    docker compose -f "$COMPOSE_FILE" up -d --build 2>&1 | tee -a "$LOG_FILE" || true
    DEPLOY_ROLLED_BACK=1
    _check_rollback_health

  elif [ -n "${ROLLBACK_BRANCH:-}" ] && [ "${ROLLBACK_BRANCH}" != "${BRANCH:-}" ]; then
    # Roll back to a known-stable branch (e.g. dev or main) rather than a
    # previous commit on the same potentially-broken feature branch.
    dstatus rollback reason="$reason" target="$ROLLBACK_BRANCH" method=stable-branch
    dwarn "Rolling back to stable branch '$ROLLBACK_BRANCH' after: $reason"
    git fetch origin "$ROLLBACK_BRANCH" 2>&1 | tee -a "$LOG_FILE" || true
    git checkout -B "$ROLLBACK_BRANCH" "origin/$ROLLBACK_BRANCH" 2>&1 | tee -a "$LOG_FILE" || true
    docker compose -f "$COMPOSE_FILE" down --remove-orphans 2>&1 | tee -a "$LOG_FILE" || true
    docker compose -f "$COMPOSE_FILE" up -d --build 2>&1 | tee -a "$LOG_FILE" || true
    DEPLOY_ROLLED_BACK=1
    _check_rollback_health

  elif [ "${PRE_SHA:-none}" != "none" ] && [ "${PRE_SHA:-none}" != "${NEW_SHA:-none}" ]; then
    # Same branch deploy: revert to the previous commit.
    dstatus rollback reason="$reason" target="${PRE_SHA:0:7}" method=previous-commit
    dwarn "Rolling back to previous commit (${PRE_SHA:0:7}) after: $reason"
    git reset --hard "$PRE_SHA" 2>&1 | tee -a "$LOG_FILE" || true
    docker compose -f "$COMPOSE_FILE" down --remove-orphans 2>&1 | tee -a "$LOG_FILE" || true
    docker compose -f "$COMPOSE_FILE" up -d --build 2>&1 | tee -a "$LOG_FILE" || true
    DEPLOY_ROLLED_BACK=1
    _check_rollback_health

  else
    dstatus rollback reason="$reason" method=none status=no-rollback-available
    dwarn "No automatic rollback available (already on '$ROLLBACK_BRANCH' or no prior commit)."
    dwarn "Manual intervention required — check container logs above."
  fi
}

_poll_health() {
  # Poll HEALTH_URL up to max_attempts times, returning 0 on first 200.
  local max_attempts="${1:-12}" interval="${2:-5}"
  local attempts=0
  local curl_flags=()
  [ "${HEALTH_INSECURE:-0}" = "1" ] && curl_flags+=("--insecure")
  [ -n "${HEALTH_RESOLVE:-}" ]      && curl_flags+=("--resolve" "${HEALTH_RESOLVE}")

  while [ "$attempts" -lt "$max_attempts" ]; do
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" "${curl_flags[@]}" "$HEALTH_URL" 2>/dev/null || echo "000")
    [ "$http_code" = "200" ] && return 0
    attempts=$(( attempts + 1 ))
    sleep "$interval"
  done
  return 1
}

_check_rollback_health() {
  # Confirms the rollback is serving traffic. If not, escalates through
  # increasingly aggressive recovery attempts before giving up.
  #
  # Level 1 — rollback already brought containers up; just poll health.
  # Level 2 — no-cache rebuild: stale image layers may be the problem.
  # Level 3 — docker system prune + rebuild: clears dangling images/networks.
  #           Prod stops here. Dev only — never deletes named volumes (data safe).
  # Manual  — all levels failed; print exact commands for operator.

  dwarn "Checking rollback health at $HEALTH_URL ..."

  if _poll_health 12 5; then
    dstatus rollback-health status=ok level=1
    dok "Rollback is live and healthy."
    return 0
  fi

  # ── Level 2: no-cache rebuild ─────────────────────────────────────────────
  dstatus rollback-health status=failed level=1
  dwarn "Rollback unhealthy — escalating to level 2: no-cache image rebuild..."
  docker compose -f "$COMPOSE_FILE" down --remove-orphans 2>&1 | tee -a "$LOG_FILE" || true
  docker compose -f "$COMPOSE_FILE" up -d --build --no-cache 2>&1 | tee -a "$LOG_FILE" || true

  if _poll_health 12 5; then
    dstatus rollback-health status=ok level=2
    dok "Recovered at level 2 (no-cache rebuild)."
    return 0
  fi

  # ── Level 3: docker system prune + rebuild (dev only) ────────────────────
  dstatus rollback-health status=failed level=2
  if [ "${DEPLOY_ENV:-}" = "dev" ]; then
    dwarn "Escalating to level 3: docker system prune + rebuild (dev only)..."
    dwarn "This removes dangling images and networks — named volumes (data) are preserved."
    docker compose -f "$COMPOSE_FILE" down --remove-orphans 2>&1 | tee -a "$LOG_FILE" || true
    docker system prune -f 2>&1 | tee -a "$LOG_FILE" || true
    docker compose -f "$COMPOSE_FILE" up -d --build 2>&1 | tee -a "$LOG_FILE" || true

    if _poll_health 12 5; then
      dstatus rollback-health status=ok level=3
      dok "Recovered at level 3 (system prune + rebuild)."
      return 0
    fi
    dstatus rollback-health status=failed level=3
  fi

  # ── All levels exhausted — manual intervention required ───────────────────
  dstatus rollback-health status=failed level=manual
  dfail "All automated recovery attempts failed. Manual intervention required."
  dfail ""
  dfail "Diagnostic commands:"
  dfail "  docker compose -f $COMPOSE_FILE logs --tail=50 ${BACKEND_SERVICE:-backend}"
  dfail "  docker compose -f $COMPOSE_FILE logs --tail=30 ${NGINX_SERVICE:-nginx}"
  dfail "  docker compose -f $COMPOSE_FILE ps"
  dfail ""
  dfail "To attempt a manual recovery:"
  dfail "  docker compose -f $COMPOSE_FILE down --remove-orphans"
  dfail "  docker compose -f $COMPOSE_FILE up -d --build"
}

# ── Disk space preflight ──────────────────────────────────────────────────────

# Warn if less than 1 GB free on the filesystem hosting REPO_DIR.
# Docker image builds can fail silently when space runs out, so surface this early.
check_port_availability() {
  # Checks that all ports required by nginx are free on the host before Docker
  # tries to bind them. Reports the holding process by name so the operator
  # knows exactly what to kill. Backend port is intentionally excluded — it is
  # no longer bound to the host (health checks go through nginx).
  local ports=("$@")
  local blocked=0

  dsection "Pre-flight: port availability"

  for port in "${ports[@]}"; do
    local holder
    # ss is available on all modern Ubuntu/Debian; grep the LISTEN state only.
    holder=$(ss -tlnp 2>/dev/null | awk -v p=":${port} " '$0 ~ p {match($0, /users:\(\("[^"]+/, a); gsub(/users:\(\("|".*/, "", a[0]); print a[0]; exit}')
    if [ -n "$holder" ]; then
      dstatus port-check status=blocked port="$port" process="$holder"
      dwarn "Port $port is already bound by: $holder"
      blocked=1
    else
      dstatus port-check status=free port="$port"
    fi
  done

  if [ "$blocked" -eq 1 ]; then
    dfail "One or more required ports are in use. Free them before deploying."
    dfail "Find the process: sudo lsof -i :<port>"
    return 1
  fi
}

check_disk_space() {
  local min_gb="${1:-1}"
  local min_kb=$(( min_gb * 1024 * 1024 ))
  local target_dir="${REPO_DIR:-$HOME}"
  local free_kb

  dsection "Pre-build disk space check"

  free_kb=$(df -k "$target_dir" 2>/dev/null | awk 'NR==2 {print $4}')
  if [ -z "$free_kb" ]; then
    dstatus disk status=unknown reason=df-failed
    dwarn "Could not determine free disk space — continuing anyway."
    return 0
  fi

  local free_gb=$(( free_kb / 1024 / 1024 ))
  local free_mb=$(( free_kb / 1024 ))

  if [ "$free_kb" -lt "$min_kb" ]; then
    dstatus disk status=low free="${free_mb}MB" min="${min_gb}GB"
    dwarn "Low disk space: ${free_mb}MB free (recommended ≥ ${min_gb}GB for Docker builds)."
    dwarn "Docker image builds may fail. Free space on $(df -k "$target_dir" | awk 'NR==2{print $6}') before retrying."
    dwarn "Continuing — this is a warning, not a hard stop."
  else
    dstatus disk status=ok free="${free_gb}GB"
    dok "Disk space OK: ${free_gb}GB free on $(df -k "$target_dir" | awk 'NR==2{print $6}')"
  fi
}

# ── Schema apply ─────────────────────────────────────────────────────────────
# Applies schema.sql to the running postgres container. Safe to re-run — all
# statements use IF NOT EXISTS / IF NOT. Called after compose up so the DB is
# guaranteed to be healthy before we attempt the psql connection.

apply_schema() {
  dsection "Phase 5b: applying DB schema"
  local postgres_service="${POSTGRES_SERVICE:-postgres}"

  if ! docker compose -f "$COMPOSE_FILE" exec -T "$postgres_service" \
      psql -U "${DB_USER:-postgres}" -d "${DB_NAME:-portfolio_prod}" \
      -f /docker-entrypoint-initdb.d/01-schema.sql \
      >> "$LOG_FILE" 2>&1; then
    dwarn "Schema apply failed — DB may be missing new tables. Check $LOG_FILE."
  else
    dok "Schema applied successfully"
  fi
}

# ── Client error prune ────────────────────────────────────────────────────────
# Removes client_errors rows older than 30 days. Called post-deploy to bound
# table growth without a separate cron job.

prune_client_errors() {
  local postgres_service="${POSTGRES_SERVICE:-postgres}"
  local deleted
  deleted=$(docker compose -f "$COMPOSE_FILE" exec -T "$postgres_service" \
    psql -U "${DB_USER:-postgres}" -d "${DB_NAME:-portfolio_prod}" -tAc \
    "DELETE FROM client_errors WHERE received_at < NOW() - INTERVAL '30 days'; SELECT ROW_COUNT();" \
    2>/dev/null | tail -1 || echo "?")
  dinfo "client_errors pruned — ${deleted} rows older than 30 days removed"
}

# ── Compose and rollback ───────────────────────────────────────────────────────

compose_up_with_rollback() {
  local service_name="$1"   # e.g. backend

  dsection "Phase 5: building and starting services"
  # Warn about any containers from this compose project that are no longer
  # defined in the current compose file — these are orphans from a service
  # rename (e.g. postgres → postgres-dev). --remove-orphans below stops them,
  # but surfacing them first gives a clear record of what was cleaned up.
  local running_services defined_services
  running_services=$(docker compose -f "$COMPOSE_FILE" ps --all --format '{{.Service}}' 2>/dev/null | sort -u || true)
  defined_services=$(docker compose -f "$COMPOSE_FILE" config --services 2>/dev/null | sort -u || true)
  if [ -n "$running_services" ] && [ -n "$defined_services" ]; then
    while IFS= read -r svc; do
      [ -z "$svc" ] && continue
      if ! echo "$defined_services" | grep -qxF "$svc"; then
        dwarn "Orphan container detected: service '$svc' (not in current compose file — will be removed)"
      fi
    done <<< "$running_services"
  fi

  dinfo "Stopping existing stack before rebuild..."
  docker compose -f "$COMPOSE_FILE" down --remove-orphans 2>&1 | _log_cmd || true

  dinfo "Running: docker compose -f $COMPOSE_FILE up -d --build"

  if ! docker compose -f "$COMPOSE_FILE" up -d --build 2>&1 | _log_cmd; then
    dstatus compose status=failed service="$service_name"
    dfail "docker compose up failed. Container logs for $service_name:"
    docker compose -f "$COMPOSE_FILE" logs --tail=40 "$service_name" 2>&1 | tee -a "$LOG_FILE" || true
    _do_rollback "docker compose up failed"
    ddie "Deploy failed — see above for details."
  fi

  # If NGINX_SERVICE is set, verify it actually started — nginx exits immediately
  # on config errors, so catching it here avoids a silent 60s health check timeout.
  if [ -n "${NGINX_SERVICE:-}" ]; then
    sleep 2  # allow nginx to finish initialising or fail-fast
    local nginx_state
    nginx_state=$(docker compose -f "$COMPOSE_FILE" ps --format '{{.State}}' "$NGINX_SERVICE" 2>/dev/null \
      || docker compose -f "$COMPOSE_FILE" ps "$NGINX_SERVICE" 2>/dev/null | awk 'NR==2{print $4}' \
      || echo "unknown")

    if [[ "$nginx_state" != "running" ]]; then
      dstatus compose status=failed service="$NGINX_SERVICE" reason="nginx-not-running state=${nginx_state}"
      dfail "Nginx container is not running (state: $nginx_state)"
      dfail ""
      dfail "Nginx logs:"
      docker compose -f "$COMPOSE_FILE" logs --tail=30 "$NGINX_SERVICE" 2>&1 | tee -a "$LOG_FILE" || true
      _do_rollback "nginx failed to start"
      ddie "Nginx failed to start — check the nginx config and cert paths above."
    fi

    dok "Nginx container is running"
  fi

  dstatus compose status=ok service="$service_name"
}

# ── Health checks ─────────────────────────────────────────────────────────────

wait_for_health() {
  local backend_service="$1"    # for log dumping on failure
  local url="${HEALTH_URL:-}"
  local url2="${HEALTH_URL_2:-}"
  local timeout="${HEALTH_TIMEOUT:-60}"
  local interval="${HEALTH_INTERVAL:-5}"
  local curl_opts=""
  [ "${HEALTH_INSECURE:-0}" = "1" ] && curl_opts="--insecure"
  [ -n "${HEALTH_RESOLVE:-}" ]      && curl_opts="$curl_opts --resolve ${HEALTH_RESOLVE}"

  dsection "Phase 6: HTTP/HTTPS health checks"

  if [ -z "$url" ]; then
    dwarn "No HEALTH_URL configured; skipping HTTP health checks."
    return
  fi

  [ -n "$curl_opts" ] && dwarn "SSL verification disabled for health check (self-signed cert)"

  local attempts=$(( timeout / interval ))
  dinfo "Polling $url (${timeout}s timeout)..."

  for i in $(seq 1 "$attempts"); do
    if curl -sf --max-time 4 $curl_opts "$url" > /dev/null 2>&1; then
      dok "Primary health check OK: $url"
      if [ -n "$url2" ]; then
        local code
        code=$(curl -sf -o /dev/null -w "%{http_code}" $curl_opts "$url2" 2>/dev/null || echo "000")
        if [ "$code" = "200" ]; then
          dok "Secondary health check OK: $url2"
        else
          dwarn "Secondary health check returned $code for $url2"
        fi
      fi

      # Save this as the last-good deployment
      cd "$REPO_DIR"
      local current_branch current_sha
      current_branch=$(git rev-parse --abbrev-ref HEAD)
      current_sha=$(git rev-parse HEAD)
      _save_last_good_state "$current_branch" "$current_sha"

      dstatus health status=ok url="$url" attempts="$i"
      return
    fi

    if [ "$i" -eq "$attempts" ]; then
      dstatus health status=failed url="$url" attempts="$i" timeout="${timeout}s"
      dfail "Health check failed after ${timeout}s"
      dfail ""

      # Diagnostic curl — show HTTP code and connection error without full verbose noise
      local diag_http diag_err diag_tmp
      diag_tmp=$(mktemp)
      diag_http=$(curl -s --max-time 4 $curl_opts \
        -o /dev/null -w "%{http_code}" \
        --stderr "$diag_tmp" \
        "$url" 2>/dev/null || echo "000")
      diag_err=$(cat "$diag_tmp" 2>/dev/null || true)
      rm -f "$diag_tmp"
      dfail "Last curl attempt: HTTP $diag_http"
      if [ -n "$diag_err" ]; then
        dfail "curl error: $diag_err"
      fi
      dfail ""

      dfail "Backend logs — $backend_service (last 50 lines):"
      docker compose -f "$COMPOSE_FILE" logs --tail=50 "$backend_service" 2>&1 | tee -a "$LOG_FILE" || true

      # Nginx logs are critical for diagnosing SSL/config failures
      if [ -n "${NGINX_SERVICE:-}" ]; then
        dfail ""
        dfail "Nginx logs — $NGINX_SERVICE (last 30 lines):"
        docker compose -f "$COMPOSE_FILE" logs --tail=30 "$NGINX_SERVICE" 2>&1 | tee -a "$LOG_FILE" || true
      fi

      _do_rollback "health check timed out"

      ddie "Deploy failed — health check timed out after ${timeout}s"
    fi

    dinfo "  attempt $i/$attempts — not ready yet, retrying in ${interval}s..."
    sleep "$interval"
  done
}

# ── In-deployment test suite ──────────────────────────────────────────────────

# Run the backend Vitest suite inside the already-running container.
# Runs after health check so tests execute against the live deployed service.
# Non-zero exit triggers rollback — same path as a failed health check.
run_deploy_tests() {
  local service_name="$1"   # e.g. backend or backend-dev

  dsection "Phase 7: Backend tests — Vitest (unit + integration)"
  dinfo "Executing npm test inside $service_name container..."

  # Run with the default reporter (human-readable log) AND the json reporter
  # (authoritative counts written to a file inside the container). Scraping the
  # pretty "Tests N passed (N)" summary proved fragile across environments — the
  # json report is immune to ANSI/format drift. `if`-capture keeps set -e from
  # aborting before we record the exit code.
  local report_path='/tmp/vitest-deploy-report.json'
  local out rc total passed failed counts
  if out=$(docker compose -f "$COMPOSE_FILE" exec -T "$service_name" \
            npm test -- --reporter=default --reporter=json \
            --outputFile.json="$report_path" 2>&1); then rc=0; else rc=$?; fi
  printf '%s\n' "$out" | _log_cmd

  # Read counts back from the json report in the same (persistent) container.
  # Falls back to "0 0 0" if the file is missing/unreadable so a parse failure
  # never aborts the deploy on its own.
  counts=$(docker compose -f "$COMPOSE_FILE" exec -T "$service_name" node -e \
    'try{const r=require(process.argv[1]);process.stdout.write(`${r.numTotalTests||0} ${r.numPassedTests||0} ${r.numFailedTests||0}`)}catch(e){process.stdout.write("0 0 0")}' \
    "$report_path" 2>/dev/null || true)
  read -r total passed failed <<<"${counts:-0 0 0}" || true
  total=${total:-0}; passed=${passed:-0}; failed=${failed:-0}

  if [ "$rc" -eq 0 ]; then
    dstatus vitest suite=backend status=ok tests="$total" passed="$passed" failed="$failed"
    dok "Backend tests passed — ${passed}/${total} ✓"
  else
    dstatus vitest suite=backend status=failed tests="$total" passed="$passed" failed="$failed"
    dfail "Backend tests failed (${failed} failed of ${total}) — initiating rollback"
    _do_rollback "test suite failed post-deploy"
    ddie "Deploy failed: tests did not pass. See log at $LOG_FILE"
  fi
}

# ── Error Logger Test ──────────────────────────────────────────────────────────

test_error_logger_all_pages() {
  dsection "Frontend tests — error-logger present on all pages (browser)"

  # NGINX_URL must be the docker-internal nginx address (e.g. https://nginx:3001)
  # so that puppeteer, running inside the backend container, can reach nginx.
  local base_url="${NGINX_URL:-}"
  if [ -z "$base_url" ]; then
    dwarn "NGINX_URL not set — skipping error logger test"
    dstatus error-logger suite=frontend status=skipped reason=no-nginx-url
    return
  fi

  dinfo "Running comprehensive page coverage test..."
  dinfo "  Testing all pages for error-logger deployment"

  # Run comprehensive test inside the backend container — capture output and
  # surface it inline so failures are visible without SSHing to read the log.
  local test_output rc total passed failed
  if test_output=$(docker compose -f "$COMPOSE_FILE" exec -T "$BACKEND_SERVICE" npm run test:error-logger:all-pages -- "$base_url" 2>&1); then rc=0; else rc=$?; fi
  local sline; sline=$(printf '%s\n' "$test_output" | grep -E '^\[error-logger-all-pages\]' | tail -1 || true)
  passed=$(_kv_num "$sline" passed); failed=$(_kv_num "$sline" failed); total=$(_kv_num "$sline" total)
  if [ "$rc" -eq 0 ]; then
    dstatus error-logger suite=frontend status=ok tests="${total:-0}" passed="${passed:-0}" failed="${failed:-0}"
    dok "Frontend error-logger pages test passed — ${passed:-0}/${total:-0} ✓"
  else
    dstatus error-logger suite=frontend status=failed tests="${total:-0}" passed="${passed:-0}" failed="${failed:-0}"
    dwarn "Error logger test output:"
    echo "$test_output" | tee -a "$LOG_FILE"
    dwarn "Frontend error-logger pages test failed — output above"
  fi
}

# ── Error Logger Contract Test ──────────────────────────────────────────────────

# Verify the deployed error-logger.js behavioural contracts against the live
# site: resource-load capture (#332), no runtime-error duplication, localStorage
# buffering + drain when the backend is unreachable (#334), and recursion safety
# under an error storm (#331). Uses Puppeteer request interception to simulate
# the backend being up/down without actually taking it down.
#
# Warn-only (matches test_error_logger_all_pages) — a frontend contract
# regression is surfaced loudly inline but does not roll back the deploy.
test_error_logger_contracts() {
  dsection "Frontend tests — error-logger behavioural contracts (browser)"

  local base_url="${NGINX_URL:-}"
  if [ -z "$base_url" ]; then
    dwarn "NGINX_URL not set — skipping error logger contract test"
    dstatus error-logger-contracts suite=frontend status=skipped reason=no-nginx-url
    return
  fi

  dinfo "Running contract test (capture, buffering, recursion safety)..."

  local test_output rc total passed failed
  if test_output=$(docker compose -f "$COMPOSE_FILE" exec -T "$BACKEND_SERVICE" npm run test:error-logger:browser -- "$base_url" 2>&1); then rc=0; else rc=$?; fi
  local sline; sline=$(printf '%s\n' "$test_output" | grep -E '^\[error-logger-browser\]' | tail -1 || true)
  passed=$(_kv_num "$sline" passed); failed=$(_kv_num "$sline" failed)
  total=$(( ${passed:-0} + ${failed:-0} ))
  if [ "$rc" -eq 0 ]; then
    dstatus error-logger-contracts suite=frontend status=ok tests="$total" passed="${passed:-0}" failed="${failed:-0}"
    dok "Frontend error-logger contracts passed — ${passed:-0}/${total} ✓"
  else
    dstatus error-logger-contracts suite=frontend status=failed tests="$total" passed="${passed:-0}" failed="${failed:-0}"
    dwarn "Error logger contract test output:"
    echo "$test_output" | tee -a "$LOG_FILE"
    dwarn "Frontend error-logger contracts failed — output above"
  fi
}

# ── CSP Browser Violation Detection (#341) ────────────────────────────────────

# Load every served page in a real browser and listen for securitypolicyviolation
# events. Filters known ISP-injected noise and flags any blocked resource that
# indicates a missing or stale CSP allowlist entry. Runs inside the backend
# container (Chromium available) using NGINX_URL (docker-internal address) so
# Puppeteer can reach nginx directly.
# Warn-only — violations are surfaced loudly but do not roll back the deploy.
check_csp_violations() {
  dsection "Frontend scans — CSP violations across pages (#341)"

  local base_url="${NGINX_URL:-}"
  if [ -z "$base_url" ]; then
    dwarn "NGINX_URL not set — skipping CSP violation scan"
    dstatus csp-violations suite=frontend status=skipped reason=no-nginx-url
    return
  fi

  dinfo "Loading all pages in headless browser to detect CSP violations..."

  # Scan metric is pages/violations (a violation isn't a 1:1 test), so report
  # those native counts rather than forcing pass/fail semantics.
  local test_output rc pages violations
  if test_output=$(docker compose -f "$COMPOSE_FILE" exec -T "$BACKEND_SERVICE" \
      npm run test:csp-violations -- "$base_url" 2>&1); then rc=0; else rc=$?; fi
  local sline; sline=$(printf '%s\n' "$test_output" | grep -E '^\[csp-violations\]' | tail -1 || true)
  pages=$(_kv_num "$sline" pages); violations=$(_kv_num "$sline" violations)
  if [ "$rc" -eq 0 ]; then
    dstatus csp-violations suite=frontend status=ok pages="${pages:-0}" violations="${violations:-0}"
    dok "CSP scan passed — ${pages:-0} pages, no first-party violations ✓"
  else
    dstatus csp-violations suite=frontend status=failed pages="${pages:-0}" violations="${violations:-0}"
    dwarn "CSP violation scan output:"
    echo "$test_output" | tee -a "$LOG_FILE"
    dwarn "CSP violations detected — update nginx-security-headers.conf and re-deploy"
  fi
}

# ── Authenticated Admin E2E CSP Test (#342) ───────────────────────────────────

# Drives the admin panel as an authenticated session and triggers all
# interactions that call external origins (Nominatim forward/reverse geocoding).
# Mints a JWT from JWT_SECRET — same technique as the regression suite — and
# injects it into localStorage.adminToken so the admin page is fully authed
# without a passkey ceremony. Listens for securitypolicyviolation events and
# fails if any first-party violation fires.
# Warn-only — a failure is surfaced in the deploy report but does not roll back.
check_admin_e2e_csp() {
  dsection "Frontend scans — authenticated admin E2E CSP (#342)"

  local base_url="${NGINX_URL:-}"
  if [ -z "$base_url" ]; then
    dwarn "NGINX_URL not set — skipping admin E2E CSP scan"
    dstatus admin-e2e-csp suite=frontend status=skipped reason=no-nginx-url
    return
  fi

  dinfo "Running authenticated admin interactions to detect CSP violations..."

  # Scan metric is interactions/violations — report those native counts.
  local test_output rc interactions violations
  if test_output=$(docker compose -f "$COMPOSE_FILE" exec -T \
      -e JWT_SECRET="${JWT_SECRET:-}" \
      "$BACKEND_SERVICE" \
      npm run test:admin-e2e-csp -- "$base_url" 2>&1); then rc=0; else rc=$?; fi
  local sline; sline=$(printf '%s\n' "$test_output" | grep -E '^\[admin-e2e-csp\]' | tail -1 || true)
  interactions=$(_kv_num "$sline" interactions); violations=$(_kv_num "$sline" violations)
  if [ "$rc" -eq 0 ]; then
    dstatus admin-e2e-csp suite=frontend status=ok interactions="${interactions:-0}" violations="${violations:-0}"
    dok "Admin E2E CSP scan passed — ${interactions:-0} interactions, no violations ✓"
  else
    dstatus admin-e2e-csp suite=frontend status=failed interactions="${interactions:-0}" violations="${violations:-0}"
    echo "$test_output" | tee -a "$LOG_FILE"
    _do_rollback "CSP violations detected in admin interactions"
    ddie "Deploy failed: CSP violations detected — update nginx-security-headers.conf. See log at $LOG_FILE"
  fi
}

check_admin_e2e() {
  dsection "Frontend tests — admin E2E smoke + interactions (hard fail)"

  local base_url="${NGINX_URL:-}"
  if [ -z "$base_url" ]; then
    dwarn "NGINX_URL not set — skipping admin E2E tests"
    dstatus admin-e2e suite=frontend status=skipped reason=no-nginx-url
    return
  fi

  dinfo "Running admin E2E smoke and interaction tests..."

  local test_output rc smoke interactions
  if test_output=$(docker compose -f "$COMPOSE_FILE" exec -T \
      -e JWT_SECRET="${JWT_SECRET:-}" \
      "$BACKEND_SERVICE" \
      npm run test:admin-e2e -- "$base_url" 2>&1); then rc=0; else rc=$?; fi
  local sline; sline=$(printf '%s\n' "$test_output" | grep -E '^\[admin-e2e\]' | tail -1 || true)
  smoke=$(_kv_str "$sline" smoke); interactions=$(_kv_str "$sline" interactions)
  if [ "$rc" -eq 0 ]; then
    dstatus admin-e2e suite=frontend status=ok smoke="${smoke:-?}" interactions="${interactions:-?}"
    dok "Admin E2E passed — smoke ${smoke:-?}, interactions ${interactions:-?} ✓"
  else
    dstatus admin-e2e suite=frontend status=failed smoke="${smoke:-?}" interactions="${interactions:-?}"
    echo "$test_output" | tee -a "$LOG_FILE"
    _do_rollback "admin E2E tests failed — admin panel non-functional"
    ddie "Deploy failed: admin E2E tests did not pass. See log at $LOG_FILE"
  fi
}

# ── CSP Violation Test ────────────────────────────────────────────────────────

test_csp_reporting() {
  dsection "Testing CSP violation reporting"

  # SITE_URL must be the external nginx URL (e.g. https://dev.andykeys.me:3001)
  # so curl reaches nginx and checks the real CSP headers.
  local test_url="${SITE_URL:-}"
  if [ -z "$test_url" ]; then
    dwarn "SITE_URL not set — skipping CSP test"
    dstatus csp status=skipped reason=no-site-url
    return
  fi

  dinfo "CSP report-uri configured at /api/debug/csp-violations"
  dinfo "CSP violations will be logged when resources violate policy"

  # Check if CSP header includes report-uri
  local curl_opts=""
  if [ "$HEALTH_INSECURE" = "1" ]; then
    curl_opts="-sk"
  else
    curl_opts="-s"
  fi

  # The dev server can't reach its own public hostname (no hairpin NAT),
  # so without --resolve the curl times out silently and we wrongly report
  # CSP as missing. Force hostname → LAN_IP when LAN_IP is set (dev).
  local resolve_opt=""
  if [ -n "${LAN_IP:-}" ] && [ -n "${SITE_HOST:-}" ]; then
    resolve_opt="--resolve ${SITE_HOST}:${NGINX_PORT}:${LAN_IP}"
  fi

  local csp_header=$(curl $curl_opts $resolve_opt -I --max-time 5 "$test_url" 2>/dev/null | grep -i "content-security-policy" | head -1 || echo "")

  if [ -n "$csp_header" ]; then
    if echo "$csp_header" | grep -q "report-uri"; then
      dstatus csp status=ok report-uri=present
      dok "CSP report-uri is configured ✓"
    else
      dstatus csp status=warn report-uri=missing
      dwarn "CSP header present but report-uri not found"
      dinfo "  Full CSP header:"
      echo "$csp_header" | _log_cmd | sed 's/^/    /'
    fi
  else
    dstatus csp status=warn header=missing
    dwarn "CSP header not found (not being sent by server)"
  fi
}

# ── DDNS sync check ───────────────────────────────────────────────────────────

# Warn if the public DNS A record for DOMAIN doesn't match the server's current
# public IP. Runs as a warning-only preflight — a mismatch means traffic is
# going to the wrong server but it shouldn't block the deploy itself.
# Requires: DOMAIN env var set, dig available (dnsutils), curl available.
check_ddns_sync() {
  local domain="${DOMAIN:-}"

  if [ -z "$domain" ]; then
    dwarn "DDNS check skipped — DOMAIN not set"
    return 0
  fi

  dsection "DDNS sync check"

  if ! command -v dig >/dev/null 2>&1; then
    dwarn "dig not found — install dnsutils to enable DDNS check: sudo apt install dnsutils"
    return 0
  fi

  local public_ip dns_ip
  public_ip=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || echo "")
  dns_ip=$(dig +short "$domain" @8.8.8.8 2>/dev/null | tail -1 || echo "")

  if [ -z "$public_ip" ]; then
    dwarn "Could not determine server public IP — skipping DDNS check"
    return 0
  fi

  if [ -z "$dns_ip" ]; then
    dwarn "Could not resolve DNS for $domain — skipping DDNS check"
    return 0
  fi

  dinfo "Server public IP : $public_ip"
  dinfo "DNS A record     : $dns_ip (for $domain)"

  if [ "$public_ip" = "$dns_ip" ]; then
    dstatus ddns status=ok domain="$domain"
    dok "DDNS in sync: $domain → $public_ip ✓"
  else
    dstatus ddns status=mismatch domain="$domain"
    dwarn "DDNS out of sync: $domain resolves to $dns_ip but server IP is $public_ip"
    dwarn "Traffic may be going to the wrong server."
    dwarn "Run: sudo ddclient -daemon=0 -verbose -noquiet"
    dwarn "Or update manually in Namecheap Advanced DNS."
    dwarn "Continuing deploy — site may be unreachable externally until DNS is fixed."
  fi
}

# ── Structured deploy summary ─────────────────────────────────────────────────

check_outlook_token() {
  local backend_service="${1:-backend}"

  # Grep the startup logs for the preflight result emitted by server.js.
  # Non-blocking: a missing or invalid token is a warning, not a deploy failure.
  local log_output
  log_output=$(docker compose -f "$COMPOSE_FILE" logs --no-log-prefix --tail=50 "$backend_service" 2>&1)

  if echo "$log_output" | grep -q "\[startup:preflight\] Outlook OAuth2 not configured"; then
    dstatus outlook status=skipped reason=not-configured
  elif echo "$log_output" | grep -q "\[startup:preflight\] Outlook token invalid\|\[startup:preflight\] Outlook OAuth2 token invalid"; then
    dstatus outlook status=warn reason=token-invalid
    dwarn "Outlook OAuth2 token is invalid — magic link emails will not send."
    dwarn "Refresh the token: node scripts/generate-outlook-refresh-token.js"
  elif echo "$log_output" | grep -q "\[startup:preflight\] Outlook OAuth2 token valid"; then
    dstatus outlook status=ok
  else
    dstatus outlook status=unknown reason=log-not-found
    dwarn "Could not find Outlook preflight log line — check backend logs manually."
  fi
}

log_deploy_summary() {
  local env_name="${1:-unknown}"
  local branch sha ts

  ts=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
  branch=$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  sha=$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")

  dstatus summary status=ok env="${env_name}" branch="${branch}" sha="${sha}"
}

# Loud final verdict banner printed immediately before the report box so the
# overall outcome is unmissable. Always printed (not gated by DEPLOY_QUIET).
# Usage: print_deploy_status <COMPLETE|ROLLED BACK|FAILED> <env-label>
print_deploy_status() {
  local status="$1" label="${2:-unknown}"
  local colour icon
  case "$status" in
    COMPLETE)      colour="${DEPLOY_GREEN}${DEPLOY_BOLD}";  icon="✅" ;;
    "DRY RUN")     colour="${DEPLOY_GREEN}${DEPLOY_BOLD}";  icon="🧪" ;;
    "ROLLED BACK") colour="${DEPLOY_YELLOW}${DEPLOY_BOLD}"; icon="↩️ " ;;
    *)             colour="${DEPLOY_RED}${DEPLOY_BOLD}";    icon="❌" ;;
  esac
  _print_box "$colour" "${icon}  DEPLOY ${status} — ${label} — $(_deploy_timestamp)"
}

# Print a human-readable final deploy report by extracting all [deploy:*] and
# [regression] checkpoint lines written to LOG_FILE during this run.
# Always printed — not suppressed by DEPLOY_QUIET.
# Call as the very last step of a deploy script (after regression tests).
print_deploy_report() {
  local label="${1:-unknown}"
  local _title
  _title="Deploy Report — ${label} — $(date '+%Y-%m-%d %H:%M:%S')"

  # Collect checkpoint lines for this run, strip ANSI and ts= field.
  local lines=()
  while IFS= read -r line; do
    lines+=("$line")
  done < <(
    tail -n +"$(( ${DEPLOY_LOG_START:-0} + 1 ))" "$LOG_FILE" 2>/dev/null \
      | grep -E '^\[deploy:' \
      | sed 's/\x1b\[[0-9;]*m//g' \
      | sed 's/ ts=[^ ]*$//'
  )

  # Compute width from longest content line (title or any checkpoint line).
  local width=${#_title}
  for line in "${lines[@]}"; do
    [ "${#line}" -gt "$width" ] && width=${#line}
  done
  # Minimum 60, add 2 padding chars each side (handled by printf %-Ns below).
  [ "$width" -lt 60 ] && width=60

  local border; border=$(printf '═%.0s' $(seq 1 $((width + 4))))
  local _title_pad=$(( width + 2 - ${#_title} ))

  echo ""
  echo "╔${border}╗"
  printf "║  %s%*s║\n" "$_title" "$_title_pad" ""
  echo "╠${border}╣"
  for line in "${lines[@]}"; do
    printf "║  %-${width}s  ║\n" "$line"
  done
  echo "╚${border}╝"
  echo ""
}

# ── LAN IP auto-detection ─────────────────────────────────────────────────────

# Detect the primary non-loopback IPv4 address and write it into ENV_FILE when
# LAN_IP is unset or still a placeholder. Dev-only: prod uses a public domain.
# Reads: LAN_IP, PLACEHOLDER_PATTERNS, ENV_FILE. Exports LAN_IP on success.
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

  if [ "$is_placeholder" = "0" ]; then
    dstatus lan-ip status=ok reason=already-configured
    return 0
  fi

  dinfo "LAN_IP is unset or a placeholder — attempting auto-detection..."

  local detected
  # ip route is most reliable on Ubuntu; hostname -I is the fallback
  detected=$(ip route get 1.1.1.1 2>/dev/null | awk '/src/{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)
  if [ -z "$detected" ]; then
    detected=$(hostname -I 2>/dev/null | awk '{print $1}')
  fi

  if [ -z "$detected" ] || [[ "$detected" == "127."* ]]; then
    dstatus lan-ip status=failed reason=no-non-loopback-ip
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
  dstatus lan-ip status=detected reason=written-to-env
  dok "LAN_IP set to $detected in $ENV_FILE"
}

# ── UFW port check ────────────────────────────────────────────────────────────

# Warn if UFW is active but has no rule allowing the given port.
# Non-fatal — missing a rule is surfaced as a warning, not a deploy failure,
# since UFW may simply not be installed or the rule may use a different subnet.
# Usage: check_ufw_port <port>
check_ufw_port() {
  local port="${1:?check_ufw_port requires a port argument}"

  dsection "Checking firewall (UFW) for port $port"

  if ! command -v ufw &>/dev/null; then
    dstatus firewall status=skipped reason=ufw-not-installed
    dinfo "UFW not installed — skipping firewall check"
    return 0
  fi

  local ufw_status
  if ! ufw_status=$(try_root ufw status 2>/dev/null); then
    dstatus firewall status=skipped reason=needs-root-no-passwordless-sudo
    dinfo "Skipping UFW check — needs root and passwordless sudo is unavailable in this non-interactive deploy."
    dinfo "To enable the check, allow just this read-only command without a password:"
    dinfo "  echo \"\$USER ALL=(root) NOPASSWD: /usr/sbin/ufw status\" | sudo tee /etc/sudoers.d/deploy-ufw-status"
    return 0
  fi

  if echo "$ufw_status" | grep -q "$port"; then
    dstatus firewall status=ok port="$port"
    dok "UFW rule for port $port is present"
  else
    dstatus firewall status=warn port="$port" reason=no-rule
    dwarn "No UFW rule found for port $port."
    dwarn "The dev site may not be reachable from other LAN devices."
    dwarn "To open port $port to your LAN:"
    dwarn "  sudo ufw allow from 192.168.0.0/16 to any port $port comment 'Dev site LAN-only'"
    dwarn "Continuing anyway — this is a warning, not an error."
  fi
}

# ── Regression smoke tests ────────────────────────────────────────────────────

# Run the regression smoke suite against the live site.
# Reads globals: DEPLOY_ENV, SKIP_REGRESSION, REPO_DIR, COMPOSE_FILE,
#                BACKEND_SERVICE, LOG_FILE, SITE_HOST, NGINX_PORT, LAN_IP, DOMAIN.
# Sets REGRESSION_RC=0 on pass, 1 on failure. Triggers rollback on failure.
run_regression_tests() {
  REGRESSION_RC=0

  if [ "${SKIP_REGRESSION:-0}" = "1" ]; then
    dstatus regression status=skipped reason=skip-flag
    dinfo "Regression smoke tests skipped (--skip-regression)"
    return 0
  fi

  dsection "Regression tests — HTTP smoke suite (live site)"

  # Capture so we can parse the [regression] summary and emit a normalised
  # suite=regression status line alongside the script's own output.
  local reg_out=""
  if [ "${DEPLOY_ENV:-}" = "dev" ]; then
    reg_out=$(bash "${REPO_DIR}/scripts/tests/test-regression.sh" \
      --base-url "https://${SITE_HOST}:${NGINX_PORT}" \
      --resolve "${SITE_HOST}:${NGINX_PORT}:${LAN_IP}" \
      --compose-file "$COMPOSE_FILE" \
      --service "$BACKEND_SERVICE" \
      --insecure \
      --reset-rate-limits \
      2>&1) || REGRESSION_RC=1
  elif [ -n "${DOMAIN:-}" ]; then
    reg_out=$(bash "${REPO_DIR}/scripts/tests/test-regression.sh" \
      --base-url "https://${DOMAIN}" \
      --resolve "${DOMAIN}:443:127.0.0.1" \
      --compose-file "$COMPOSE_FILE" \
      --service "$BACKEND_SERVICE" \
      2>&1) || REGRESSION_RC=1
  fi

  printf '%s\n' "$reg_out" | _log_cmd

  # Normalised summary line, consistent with the backend/frontend suites.
  local sline passed failed total
  sline=$(printf '%s\n' "$reg_out" | grep -E '^\[regression\]' | tail -1 || true)
  passed=$(_kv_num "$sline" passed); failed=$(_kv_num "$sline" failed); total=$(_kv_num "$sline" total)
  if [ "$REGRESSION_RC" -eq 0 ]; then
    dstatus regression suite=regression status=ok tests="${total:-0}" passed="${passed:-0}" failed="${failed:-0}"
  else
    dstatus regression suite=regression status=failed tests="${total:-0}" passed="${passed:-0}" failed="${failed:-0}"
  fi

  if [ "$REGRESSION_RC" -ne 0 ]; then
    _do_rollback "regression smoke tests failed"
  fi
}

# ── Backup Health Check ───────────────────────────────────────────────────────
# Non-fatal: warns if scheduled backups are not configured or recent backup
# files are missing. Runs post-deploy so it surfaces in every deploy log.
# Checks:
#   1. A cron job or systemd timer referencing a backup script exists.
#   2. Recent backup files exist under ~/backups (within 2 days).
# Both checks are warn-only — missing backups don't block a deploy, but the
# warning is logged loudly so it cannot be silently ignored. (#164)

check_backup_health() {
  dsection "Backup health check"
  local ok=1
  local backup_dir="${BACKUP_DIR:-${HOME}/backups}"
  local max_age_days=2

  # ── Check 1: cron/systemd timer configured ───────────────────────────────
  local cron_found=0
  if crontab -l 2>/dev/null | grep -qi "backup"; then
    cron_found=1
  elif systemctl list-timers --all 2>/dev/null | grep -qi "backup"; then
    cron_found=1
  fi

  local cron_entry="0 2 * * * ${REPO_DIR}/scripts/backup/db-backup.sh >> ${HOME}/backup.log 2>&1"

  if [ "$cron_found" = "1" ]; then
    dstatus backup-schedule status=ok
    dok "Backup schedule: cron/timer found ✓"
  else
    local install_cron=0
    if [ "${AUTO_YES:-0}" = "1" ]; then
      install_cron=1
    elif [ -t 0 ]; then
      printf "\n[backup] No backup cron job found. Install one now? [Y/n] "
      read -r answer
      [[ "$answer" =~ ^[Yy]?$ ]] && install_cron=1
    fi

    if [ "$install_cron" = "1" ]; then
      (crontab -l 2>/dev/null; echo "$cron_entry") | crontab -
      dstatus backup-schedule status=installed
      dok "Installed backup cron: ${cron_entry}"
    else
      dstatus backup-schedule status=warn
      dwarn "No backup cron job found — add manually: crontab -e"
      dwarn "  ${cron_entry}"
      ok=0
    fi
  fi

  # ── Check 2: backup directory exists (create if missing) (#352) ─────────
  # Sanity check: BACKUP_DIR must be under the current user's home. A path
  # like /home/ak/backups synced from a template with a hardcoded username
  # will fail mkdir for any other SSH user — catch it early with a clear fix.
  if [[ "$backup_dir" == /home/* ]] && [[ "$backup_dir" != "$HOME"* ]]; then
    dstatus backup-files status=warn dir="$backup_dir"
    dwarn "BACKUP_DIR (${backup_dir}) belongs to a different user (running as: $(whoami))."
    dwarn "Update BACKUP_DIR in .env — suggested value: ${HOME}/backups"
    ok=0
  elif [ ! -d "$backup_dir" ]; then
    local create=0
    if [ "${AUTO_YES:-0}" = "1" ]; then
      create=1
    elif [ -t 0 ]; then
      printf "\n[backup] Backup directory %s does not exist. Create it now? [Y/n] " "$backup_dir"
      read -r answer
      [[ "$answer" =~ ^[Yy]?$ ]] && create=1
    fi

    if [ "$create" = "1" ]; then
      if mkdir -p "$backup_dir" 2>/dev/null; then
        dstatus backup-files status=created dir="$backup_dir"
        dok "Created backup directory: ${backup_dir}"
        dinfo "Add the backup cron job if not already present:"
        dinfo "  crontab -e"
        dinfo "  ${cron_entry}"
      else
        dstatus backup-files status=warn dir="$backup_dir"
        dwarn "Could not create ${backup_dir} — permission denied."
        dwarn "Set BACKUP_DIR to a writable path in .env, e.g. ${HOME}/backups"
        ok=0
      fi
    else
      dstatus backup-files status=warn dir="$backup_dir"
      dwarn "Backup directory ${backup_dir} does not exist — backups not configured (#164)"
      ok=0
    fi
  fi

  # ── Check 3: recent backup files exist ───────────────────────────────────
  if [ -d "$backup_dir" ]; then
    local recent
    recent=$(find "$backup_dir" -maxdepth 2 -name "*.sql*" -o -name "*.dump" -o -name "*.tar*" \
      2>/dev/null | xargs -r ls -t 2>/dev/null | head -1)
    if [ -n "$recent" ]; then
      local age_days
      age_days=$(( ( $(date +%s) - $(stat -c %Y "$recent" 2>/dev/null || echo 0) ) / 86400 ))
      if [ "$age_days" -le "$max_age_days" ]; then
        dstatus backup-files status=ok age_days="$age_days"
        dok "Most recent backup: $(basename "$recent") (${age_days}d ago) ✓"
      else
        dstatus backup-files status=warn age_days="$age_days"
        dwarn "Most recent backup is ${age_days} days old (threshold: ${max_age_days}d) — check backup job (#164)"
        ok=0
      fi
    else
      local run_backup=0
      if [ "${AUTO_YES:-0}" = "1" ]; then
        run_backup=1
      elif [ -t 0 ]; then
        printf "\n[backup] No backup files found. Run an initial backup now? [Y/n] "
        read -r answer
        [[ "$answer" =~ ^[Yy]?$ ]] && run_backup=1
      fi

      if [ "$run_backup" = "1" ]; then
        dinfo "Running initial backup..."
        local timestamp
        timestamp=$(date +%Y%m%d-%H%M%S)
        local db_backup="${backup_dir}/portfolio-${timestamp}.sql.gz"
        if docker compose -f "$COMPOSE_FILE" exec -T postgres \
            pg_dump -U "${DB_USER:-postgres}" "${DB_NAME:-portfolio}" \
            2>/dev/null | gzip > "$db_backup" && [ -s "$db_backup" ]; then
          dstatus backup-files status=ok dir="$backup_dir"
          dok "Initial backup created: $(basename "$db_backup") ($(du -sh "$db_backup" | cut -f1))"
        else
          rm -f "$db_backup"
          dstatus backup-files status=warn dir="$backup_dir"
          dwarn "Initial backup failed — check containers are healthy and DB credentials are correct"
          ok=0
        fi
      else
        dstatus backup-files status=warn dir="$backup_dir"
        dwarn "No backup files found in ${backup_dir} — backups may never have run (#164)"
        ok=0
      fi
    fi
  fi

  if [ "$ok" = "0" ]; then
    dwarn "Backup health: one or more checks failed — see RUNBOOK.md §Backups to set up automated backups"
  fi
}
