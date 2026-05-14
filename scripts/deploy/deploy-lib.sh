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
#
# Optional, per-caller hooks:
#   extra_env_checks() — function for additional env validation per environment

set -euo pipefail

# ── Colours and logging ───────────────────────────────────────────────────────

if [ -t 1 ]; then
  DEPLOY_RED='\033[0;31m'; DEPLOY_YELLOW='\033[0;33m'; DEPLOY_GREEN='\033[0;32m'
  DEPLOY_CYAN='\033[0;36m'; DEPLOY_BOLD='\033[1m'; DEPLOY_RESET='\033[0m'
else
  DEPLOY_RED=''; DEPLOY_YELLOW=''; DEPLOY_GREEN=''; DEPLOY_CYAN=''; DEPLOY_BOLD=''; DEPLOY_RESET=''
fi

_deploy_timestamp() { date '+%Y-%m-%d %H:%M:%S'; }
_deploy_log_raw()   { echo -e "[$(_deploy_timestamp)] $*" | tee -a "$LOG_FILE"; }

dlog()     { _deploy_log_raw "$*"; }
dinfo()    { _deploy_log_raw "${DEPLOY_CYAN}${DEPLOY_BOLD}[INFO]${DEPLOY_RESET}  $*"; }
dok()      { _deploy_log_raw "${DEPLOY_GREEN}${DEPLOY_BOLD}[OK]${DEPLOY_RESET}    $*"; }
dwarn()    { _deploy_log_raw "${DEPLOY_YELLOW}${DEPLOY_BOLD}[WARN]${DEPLOY_RESET}  $*"; }
dfail()    { _deploy_log_raw "${DEPLOY_RED}${DEPLOY_BOLD}[ERROR]${DEPLOY_RESET} $*"; }
dsection() { _deploy_log_raw ""; _deploy_log_raw "${DEPLOY_BOLD}── $* ──────────────────────────────────────────────${DEPLOY_RESET}"; }

ddie() {
  dfail "$*"
  dlog "See full log at: $LOG_FILE"
  exit 1
}

init_log_banner() {
  local title="$1"
  dlog ""
  dlog "${DEPLOY_BOLD}╔══════════════════════════════════════════╗${DEPLOY_RESET}"
  dlog "${DEPLOY_BOLD}║  ${title} — $(_deploy_timestamp)  ║${DEPLOY_RESET}"
  dlog "${DEPLOY_BOLD}╚══════════════════════════════════════════╝${DEPLOY_RESET}"
  dlog ""
}

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
    dfail "Missing required tools:"
    for t in "${missing[@]}"; do
      dfail "  • $t"
    done
    ddie "Install missing tools then re-run this script."
  fi

  if ! docker info >/dev/null 2>&1; then
    ddie "Docker daemon is not running. Start it with: sudo systemctl start docker"
  fi

  dok "All prerequisites satisfied (${*})"
}

# ── Repo helpers ───────────────────────────────────────────────────────────────

ensure_repo_cloned() {
  dsection "Phase 1: ensuring repository exists"

  if [ ! -d "$REPO_DIR" ]; then
    dinfo "Repo not found at $REPO_DIR — cloning..."
    git clone "$REPO_URL" "$REPO_DIR" || ddie "git clone failed. Check your internet connection."
    cd "$REPO_DIR"
    git checkout "$BRANCH" || ddie "Could not switch to $BRANCH branch."
    dok "Repo cloned and set to $BRANCH branch."
  else
    dok "Repo found at $REPO_DIR"
  fi
}

update_to_branch() {
  dsection "Phase 2: updating to latest $BRANCH branch"

  cd "$REPO_DIR"

  PRE_SHA=$(git rev-parse HEAD 2>/dev/null || echo "none")
  dinfo "Current commit: $PRE_SHA"

  git fetch origin "$BRANCH" 2>&1 | tee -a "$LOG_FILE" || ddie "git fetch failed. Check your internet connection."
  git reset --hard "origin/$BRANCH" 2>&1 | tee -a "$LOG_FILE"

  NEW_SHA=$(git rev-parse HEAD)
  if [ "$NEW_SHA" = "$PRE_SHA" ]; then
    dinfo "Already at latest commit — no code changes."
  else
    dok "Updated: ${PRE_SHA:0:7} → ${NEW_SHA:0:7}"
  fi
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
    dok ".env present at $ENV_FILE"
    return
  fi

  if [ -n "${ENV_TEMPLATE:-}" ] && [ -f "$ENV_TEMPLATE" ]; then
    dinfo ".env not found — copying from template: $ENV_TEMPLATE"
    cp "$ENV_TEMPLATE" "$ENV_FILE"
    dwarn ""
    dwarn "  .env created but not yet configured."
    dwarn "  Edit $ENV_FILE and set all required values before re-running."
    ddie "Configure .env then re-run this script."
  else
    ddie ".env not found and ENV_TEMPLATE not available. Check your checkout or set ENV_FILE explicitly."
  fi
}

load_env() {
  # Export only KEY=VALUE lines, ignore comments
  set -a
  # shellcheck disable=SC1090
  source <(grep -E '^[A-Z_]+=.' "$ENV_FILE" | grep -v '^#') 2>/dev/null || true
  set +a
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
    dfail ".env validation failed:"
    for err in "${errors[@]}"; do
      dfail "  • $err"
    done
    ddie "Fix the above .env issues then re-run."
  fi

  dok "All required env vars set and valid."
}

# ── Dev certificates (HTTPS with self-signed) ──────────────────────────────────

ensure_dev_certs() {
  local lan_ip="$1"
  local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local cert_script="${script_dir}/../setup/generate-dev-certs.sh"
  local cert_dir="${script_dir}/../config/certs"
  local cert_file="${cert_dir}/dev-server.crt"
  local key_file="${cert_dir}/dev-server.key"

  dsection "Checking SSL certificates for HTTPS on port 3001"

  if ! [ -f "$cert_script" ]; then
    ddie "Certificate generation script not found at $cert_script"
  fi

  # Generate certificates if needed
  if bash "$cert_script" "$lan_ip" 2>&1 | tee -a "$LOG_FILE"; then
    dinfo "Certificate generation passed"
  else
    ddie "Failed to generate SSL certificates. Check LAN_IP in .env."
  fi

  # Verify certificate files exist
  if ! [ -f "$cert_file" ]; then
    ddie "Certificate file not found at $cert_file after generation"
  fi
  if ! [ -f "$key_file" ]; then
    ddie "Certificate key file not found at $key_file after generation"
  fi

  # Verify certificate validity
  if ! openssl x509 -in "$cert_file" -noout >/dev/null 2>&1; then
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

  # Verify certificate CN/SAN matches LAN_IP
  if ! openssl x509 -noout -text -in "$cert_file" 2>/dev/null | grep -E "DNS:|IP:" | grep -q "$lan_ip"; then
    dwarn "Certificate may not have correct CN/SAN for $lan_ip"
  fi

  # Verify file permissions (nginx needs read access)
  if ! [ -r "$cert_file" ] || ! [ -r "$key_file" ]; then
    ddie "Certificate files exist but are not readable (permissions issue)"
  fi

  dok "SSL certificates verified and ready for $lan_ip"
}

# ── Nginx config pre-flight ────────────────────────────────────────────────────

check_nginx_config() {
  local nginx_service="${1:-nginx}"

  dsection "Pre-flight: nginx configuration test"

  # Runs nginx -t inside a throw-away container using the same compose env and
  # volume mounts, so template substitution and cert paths are tested for real.
  if ! docker compose -f "$COMPOSE_FILE" run --rm --no-deps "$nginx_service" nginx -t \
      2>&1 | tee -a "$LOG_FILE"; then
    dfail ""
    dfail "Nginx config test failed. Common causes:"
    dfail "  • SSL cert or key file missing at the path mounted into the container"
    dfail "  • Syntax error in nginx config template"
    dfail "  • Environment variable not set (check .env and COMPOSE_FILE)"
    ddie "Fix the nginx config then re-run."
  fi

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
    echo "$new_config" | tee -a "$LOG_FILE"
    docker compose -f "$COMPOSE_FILE" rm -fs "$nginx_service" 2>/dev/null | tee -a "$LOG_FILE" || true
  fi
}

# ── Rollback helper ───────────────────────────────────────────────────────────

_do_rollback() {
  local reason="$1"

  cd "$REPO_DIR"

  if [ -n "${ROLLBACK_BRANCH:-}" ] && [ "${ROLLBACK_BRANCH}" != "${BRANCH:-}" ]; then
    # Roll back to a known-stable branch (e.g. dev or main) rather than a
    # previous commit on the same potentially-broken feature branch.
    dwarn "Rolling back to stable branch '$ROLLBACK_BRANCH' after: $reason"
    git fetch origin "$ROLLBACK_BRANCH" 2>&1 | tee -a "$LOG_FILE" || true
    git checkout -B "$ROLLBACK_BRANCH" "origin/$ROLLBACK_BRANCH" 2>&1 | tee -a "$LOG_FILE" || true
    docker compose -f "$COMPOSE_FILE" up -d --build 2>&1 | tee -a "$LOG_FILE" || true
    dwarn "Rolled back to '$ROLLBACK_BRANCH' — verify service health before investigating the failed update."

  elif [ "${PRE_SHA:-none}" != "none" ] && [ "${PRE_SHA:-none}" != "${NEW_SHA:-none}" ]; then
    # Same branch deploy: revert to the previous commit.
    dwarn "Rolling back to previous commit (${PRE_SHA:0:7}) after: $reason"
    git reset --hard "$PRE_SHA" 2>&1 | tee -a "$LOG_FILE" || true
    docker compose -f "$COMPOSE_FILE" up -d --build 2>&1 | tee -a "$LOG_FILE" || true
    dwarn "Rolled back to ${PRE_SHA:0:7} — verify service health before investigating the failed update."

  else
    dwarn "No automatic rollback available (already on '$ROLLBACK_BRANCH' or no prior commit)."
    dwarn "Manual intervention required — check container logs above."
  fi
}

# ── Compose and rollback ───────────────────────────────────────────────────────

compose_up_with_rollback() {
  local service_name="$1"   # e.g. backend-dev or backend

  dsection "Phase 5: building and starting services"
  dinfo "Running: docker compose -f $COMPOSE_FILE up -d --build"

  if ! docker compose -f "$COMPOSE_FILE" up -d --build 2>&1 | tee -a "$LOG_FILE"; then
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
      dfail "Nginx container is not running (state: $nginx_state)"
      dfail ""
      dfail "Nginx logs:"
      docker compose -f "$COMPOSE_FILE" logs --tail=30 "$NGINX_SERVICE" 2>&1 | tee -a "$LOG_FILE" || true
      _do_rollback "nginx failed to start"
      ddie "Nginx failed to start — check the nginx config and cert paths above."
    fi

    dok "Nginx container is running"
  fi
}

# ── Health checks ─────────────────────────────────────────────────────────────

wait_for_health() {
  local backend_service="$1"    # for log dumping on failure
  local url="${HEALTH_URL:-}"
  local url2="${HEALTH_URL_2:-}"
  local timeout="${HEALTH_TIMEOUT:-60}"
  local interval="${HEALTH_INTERVAL:-5}"
  # Set HEALTH_INSECURE=1 in caller to skip SSL cert verification (e.g. dev self-signed certs)
  local curl_opts=""
  [ "${HEALTH_INSECURE:-0}" = "1" ] && curl_opts="--insecure"

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
      return
    fi

    if [ "$i" -eq "$attempts" ]; then
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

      ddie "Deploy failed — see log at $LOG_FILE"
    fi

    dinfo "  attempt $i/$attempts — not ready yet, retrying in ${interval}s..."
    sleep "$interval"
  done
}
