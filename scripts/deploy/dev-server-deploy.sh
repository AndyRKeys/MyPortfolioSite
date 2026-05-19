#!/usr/bin/env bash
# dev-server-deploy.sh — Unified dev environment setup and deploy script.
#
# Handles both first-time setup and subsequent deploys.
# Run on the Ubuntu Server as the non-root user.
#
# Usage:
#   bash scripts/deploy/dev-server-deploy.sh [branch] [--reset-failures]
# Examples:
#   bash scripts/deploy/dev-server-deploy.sh                      # Deploy from dev
#   bash scripts/deploy/dev-server-deploy.sh fix/215              # Deploy from feature branch
#   bash scripts/deploy/dev-server-deploy.sh dev --reset-failures # Reset failure counter then deploy
#
# On first run the script will clone the repo and guide you through .env setup.
# On subsequent runs it assumes the working tree is already on the desired
# branch (typically set by dev-server-deploy-wrapper.sh) and focuses purely on
# environment checks, Docker build/up, and health checks.

set -euo pipefail

# ── Branch parameter & flags ─────────────────────────────────────────────────────────────

DEPLOY_BRANCH="dev"
RESET_FAILURES=false

for arg in "$@"; do
    case "$arg" in
        --reset-failures)
            RESET_FAILURES=true
            ;;
        *)
            # First non-flag argument is treated as branch name
            if [ "$DEPLOY_BRANCH" = "dev" ] && [[ "$arg" != --* ]]; then
                DEPLOY_BRANCH="$arg"
            fi
            ;;
    esac
done

# ── Config ──────────────────────────────────────────────────────────────────────────────

DEV_REPO="${HOME}/MyPortfolioSite-dev"
REPO_URL="https://github.com/AndyRKeys/MyPortfolioSite.git"
COMPOSE_FILE="${DEV_REPO}/docker-compose.dev-server.yml"
LOG_FILE="${HOME}/dev-deploy.log"
FAILURE_COUNTER_FILE="${HOME}/.dev-deploy-failures"
HEALTH_TIMEOUT=60   # seconds to wait for the site to become healthy
HEALTH_INTERVAL=5   # seconds between health check attempts

# Required .env vars — must be present and not a placeholder value
REQUIRED_VARS=(LAN_IP DB_PASSWORD JWT_SECRET WEBAUTHN_RP_ID WEBAUTHN_ORIGIN FRONTEND_URL)

# Placeholder values that signal the var hasn't been configured
PLACEHOLDER_PATTERNS=("192.168.x.x" "change-me" "your-" "xxx")

# Dev certificates
DEV_CERT_DIR="scripts/config/certs"
DEV_CERT_FILE="${DEV_CERT_DIR}/dev-server.crt"
DEV_KEY_FILE="${DEV_CERT_DIR}/dev-server.key"
DEV_LAN_IP_FILE="${DEV_CERT_DIR}/dev-server.lan_ip"

# Backend health URL (HTTP, decoupled from HTTPS frontend)
BACKEND_HEALTH_URL="${BACKEND_HEALTH_URL:-http://localhost:8081/api/health}"

# ── Helpers ───────────────────────────────────────────────────────────────────────

# Colour support only when attached to a real terminal
if [ -t 1 ]; then
    RED='\033[0;31m'; YELLOW='\033[0;33m'; GREEN='\033[0;32m'
    CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
else
    RED=''; YELLOW=''; GREEN=''; CYAN=''; BOLD=''; RESET=''
fi

# shellcheck source=output-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/output-lib.sh"

timestamp() { date '+%Y-%m-%d %H:%M:%S'; }
log()     { echo -e "[$(timestamp)] $*" | tee -a "$LOG_FILE"; }
info()    { log "${CYAN}${BOLD}[INFO]${RESET}  $*"; }
ok()      { log "${GREEN}${BOLD}[OK]${RESET}    $*"; }
warn()    { log "${YELLOW}${BOLD}[WARN]${RESET}  $*"; }
fail()    { log "${RED}${BOLD}[ERROR]${RESET} $*"; }
section() { log ""; log "${BOLD}── $* ──────────────────────────────────────────────${RESET}"; }

die() {
    fail "$*"
    log "See full log at: $LOG_FILE"
    exit 1
}

get_failure_count() { cat "$FAILURE_COUNTER_FILE" 2>/dev/null || echo "0"; }
increment_failure_count() { echo $(( $(get_failure_count) + 1 )) > "$FAILURE_COUNTER_FILE"; }
reset_failure_count() { rm -f "$FAILURE_COUNTER_FILE"; }

ask_yes_no() {
    local prompt="$1"
    local default="${2:-N}"

    local suffix="[y/n]"
    if [[ "$default" =~ ^[Yy]$ ]]; then
        suffix="[y/n]"
    fi

    while true; do
        read -r -p "$prompt $suffix " reply
        reply="${reply:-$default}"
        case "$reply" in
            [Yy]*) return 0 ;;
            [Nn]*) return 1 ;;
            *) echo "Please answer y or n." ;;
        esac
    done
}

_wait_for_docker() {
    local timeout=30
    local interval=3
    local attempts=$(( timeout / interval ))

    info "Waiting for Docker daemon to become ready (up to ${timeout}s)..."
    for i in $(seq 1 "$attempts"); do
        if docker ps >/dev/null 2>&1; then
            ok "Docker daemon is ready"
            return 0
        fi
        sleep "$interval"
    done

    fail "Docker daemon did not become ready within ${timeout}s after restart"
    return 1
}

_check_or_generate_dev_certs() {
    mkdir -p "${DEV_CERT_DIR}"

    # Extract LAN_IP from .env for certificate generation
    local lan_ip_for_certs
    lan_ip_for_certs=$(grep "^LAN_IP=" "${DEV_REPO}/.env" | cut -d'=' -f2 | tr -d ' ')

    if [ -z "$lan_ip_for_certs" ]; then
        warn "LAN_IP not yet configured in .env — skipping cert generation for now"
        return 0
    fi

    if [ -f "${DEV_CERT_FILE}" ] && [ -f "${DEV_KEY_FILE}" ] && [ -f "${DEV_LAN_IP_FILE}" ]; then
        local prev_lan_ip
        prev_lan_ip=$(cat "${DEV_LAN_IP_FILE}" 2>/dev/null || true)
        if [ "$prev_lan_ip" = "$lan_ip_for_certs" ]; then
            ok "SSL certificates present and LAN_IP unchanged (${lan_ip_for_certs}) — skipping regeneration"
            return 0
        else
            warn "LAN_IP changed (${prev_lan_ip} -> ${lan_ip_for_certs}), regenerating dev certs..."
        fi
    else
        warn "Dev certs or metadata missing, generating fresh dev certs..."
    fi

    if bash "${DEV_REPO}/scripts/setup/generate-dev-certs.sh" "$lan_ip_for_certs" 2>&1 | tee -a "$LOG_FILE"; then
        echo "$lan_ip_for_certs" > "${DEV_LAN_IP_FILE}"
        ok "SSL certificates ready"
    else
        die "Failed to generate SSL certificates. Check LAN_IP in .env."
    fi
}

# ── Entry point ─────────────────────────────────────────────────────────────────────────

log ""
_print_box "${BOLD}" "Dev Server Deploy — $(timestamp)"
log ""
# log "[DEBUG] Script header: DEPLOY_BRANCH='$DEPLOY_BRANCH' DEV_REPO='$DEV_REPO' COMPOSE_FILE='$COMPOSE_FILE'" | tee -a "$LOG_FILE"

if [ "$RESET_FAILURES" = true ]; then
    info "Resetting consecutive failure counter on user request (--reset-failures)"
    reset_failure_count
fi

# ── Section 1: Prerequisites ───────────────────────────────────────────────────────────

section "Checking prerequisites"

MISSING_PREREQS=()

if ! command -v docker &>/dev/null; then
    MISSING_PREREQS+=("docker")
fi

if ! docker compose version &>/dev/null 2>&1; then
    MISSING_PREREQS+=("docker-compose-plugin (run: sudo apt install docker-compose-plugin)")
fi

if ! command -v git &>/dev/null; then
    MISSING_PREREQS+=("git")
fi

if ! command -v curl &>/dev/null; then
    MISSING_PREREQS+=("curl")
fi

if [ ${#MISSING_PREREQS[@]} -gt 0 ]; then
    fail "Missing required tools:"
    for tool in "${MISSING_PREREQS[@]}"; do
        fail "  • $tool"
    done
    die "Install missing tools then re-run this script."
fi

if ! docker info &>/dev/null 2>&1; then
    die "Docker daemon is not running. Start it with: sudo systemctl start docker"
fi

ok "All prerequisites satisfied (docker, git, curl)"

# ── Section 2: First-time setup ─────────────────────────────────────────────────────────

section "Checking repository"

# echo "[DEBUG] PWD before repo checks: $(pwd)" | tee -a "$LOG_FILE"

# echo "[DEBUG] Checking DEV_REPO at '$DEV_REPO'" | tee -a "$LOG_FILE"
if [ ! -d "$DEV_REPO" ]; then
    info "Dev repo not found at $DEV_REPO — cloning..."
    git clone "$REPO_URL" "$DEV_REPO" || die "git clone failed. Check your internet connection."
    cd "$DEV_REPO"
    git checkout "$DEPLOY_BRANCH" || die "Could not switch to $DEPLOY_BRANCH branch."
    ok "Repo cloned and set to $DEPLOY_BRANCH branch."
else
    ok "Repo found at $DEV_REPO"
    cd "$DEV_REPO"
fi

# echo "[DEBUG] After cd DEV_REPO, PWD=$(pwd), HEAD=$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')" | tee -a "$LOG_FILE"

if [ ! -f "${DEV_REPO}/.env" ]; then
    if [ -f "${DEV_REPO}/.env.dev-server.example" ]; then
        info ".env not found — copying from .env.dev-server.example"
        cp "${DEV_REPO}/.env.dev-server.example" "${DEV_REPO}/.env"
        warn ""
        warn "  .env created but not yet configured."
        warn "  Edit ${DEV_REPO}/.env and set these values:"
        warn "    LAN_IP           — your server LAN IP (ip -4 addr show)"
        warn "    DB_PASSWORD      — strong random password"
        warn "    JWT_SECRET       — random string, min 32 chars (openssl rand -base64 32)"
        warn "    WEBAUTHN_RP_ID   — same as LAN_IP (bare IP, no protocol/port)"
        warn "    WEBAUTHN_ORIGIN  — https://<LAN_IP>:3001"
        warn "    FRONTEND_URL     — https://<LAN_IP>:3001"
        warn ""
        die "Configure .env then re-run this script."
    else
        die ".env not found and .env.dev-server.example is missing. Check your checkout."
    fi
fi

ok ".env file present"

# ── Section 2.5: Generate SSL certificates ──────────────────────────────────────────────────

section "Checking SSL certificates for HTTPS"

_check_or_generate_dev_certs

# ── Section 3: Environment validation ───────────────────────────────────────────────────

section "Validating .env"

# Source .env safely — only export KEY=VALUE lines
set -a
# shellcheck disable=SC1090
source <(grep -E '^[A-Z_]+=.' "${DEV_REPO}/.env" | grep -v '^#') 2>/dev/null || true
set +a

# echo "[DEBUG] After sourcing .env: LAN_IP='${LAN_IP:-}' WEBAUTHN_ORIGIN='${WEBAUTHN_ORIGIN:-}' FRONTEND_URL='${FRONTEND_URL:-}'" | tee -a "$LOG_FILE"

# env | grep -E '^(LAN_IP|WEBAUTHN_ORIGIN|FRONTEND_URL)=' | sed 's/^/[DEBUG][env] /' | tee -a "$LOG_FILE"

ENV_ERRORS=()

for var in "${REQUIRED_VARS[@]}"; do
    value="${!var:-}"

    if [ -z "$value" ]; then
        ENV_ERRORS+=("$var is not set")
        continue
    fi

    for pattern in "${PLACEHOLDER_PATTERNS[@]}"; do
        if [[ "$value" == *"$pattern"* ]]; then
            ENV_ERRORS+=("$var still contains placeholder value ('$pattern') — set a real value")
            break
        fi
    done
done

# JWT_SECRET length check (min 32 chars)
if [ -n "${JWT_SECRET:-}" ] && [ ${#JWT_SECRET} -lt 32 ]; then
    ENV_ERRORS+=("JWT_SECRET is too short (${#JWT_SECRET} chars — minimum 32). Generate with: openssl rand -base64 32")
fi

# WebAuthn consistency — RP_ID must be just the IP, ORIGIN must include port
if [ -n "${WEBAUTHN_RP_ID:-}" ] && [ -n "${LAN_IP:-}" ]; then
    if [ "$WEBAUTHN_RP_ID" != "$LAN_IP" ]; then
        ENV_ERRORS+=("WEBAUTHN_RP_ID ('$WEBAUTHN_RP_ID') must match LAN_IP ('$LAN_IP') exactly")
    fi
fi

if [ -n "${WEBAUTHN_ORIGIN:-}" ] && [[ "$WEBAUTHN_ORIGIN" != *":3001"* ]]; then
    ENV_ERRORS+=("WEBAUTHN_ORIGIN ('$WEBAUTHN_ORIGIN}') should end with :3001 — passkey registration will fail otherwise")
fi

if [ ${#ENV_ERRORS[@]} -gt 0 ]; then
    fail ".env validation failed:"
    for err in "${ENV_ERRORS[@]}"; do
        fail "  • $err"
    done
    die "Fix the above .env issues then re-run."
fi

ok "All required env vars set and valid (LAN_IP=${LAN_IP})"

# ── Section 4: UFW check ───────────────────────────────────────────────────────────────────

section "Checking firewall (UFW)"

NEED_UFW_ENABLE=false
NEED_UFW_RULE=false
UFW_INSTALLED=false

# Checking UFW status requires sudo which can prompt for a password mid-deploy.
# Just detect if UFW is installed here; actual status check happens post-deploy
# in Section 10 where interactive sudo is already expected.
if command -v ufw &>/dev/null; then
    UFW_INSTALLED=true
    info "UFW is installed — status will be checked after deploy"
else
    info "UFW not installed (optional for LAN access control)"
fi

# ── Section 5: Maintenance checks ───────────────────────────────────────────────────────────

section "Checking Docker maintenance setup"

NEED_CRON=false
NEED_AUTOSTART=false

# Check for Docker system prune cron job (check user crontab without sudo)
if crontab -l 2>/dev/null | grep -q "docker system prune"; then
    ok "Docker cleanup cron job is scheduled"
else
    warn "Docker cleanup cron job not found — will offer setup after deploy"
    NEED_CRON=true
fi

# Check for autostart service
if systemctl is-enabled myportfolio-dev.service &>/dev/null 2>&1; then
    ok "Dev autostart service is enabled"
else
    warn "Dev autostart service not enabled — will offer setup after deploy"
    NEED_AUTOSTART=true
fi

if [ "$NEED_CRON" = true ] || [ "$NEED_AUTOSTART" = true ]; then
    warn ""
    warn "Some configuration items are missing. Deploy will continue and you"
    warn "will be prompted to set them up once the site is healthy."
    warn ""
fi

# ── Section 5.5: Snap Docker self-healing info ───────────────────────────────────────────

SNAP_DOCKER_UNIT="snap.docker.dockerd"

# ── Section 6: Docker build & up ───────────────────────────────────────────────────────────

section "Building and starting dev services"

REBUILD_NEEDED="--build"

if git rev-parse HEAD^ &>/dev/null; then
    PREV_SHA=$(git rev-parse HEAD^)
    NEW_SHA=$(git rev-parse HEAD)
    # echo "[DEBUG] PREV_SHA='$PREV_SHA' NEW_SHA='$NEW_SHA'" | tee -a "$LOG_FILE"

    PREV_PACKAGE_HASH=$(git show "$PREV_SHA:backend/package.json" 2>/dev/null | sha256sum | awk '{print $1}')
    NEW_PACKAGE_HASH=$(git show "$NEW_SHA:backend/package.json" 2>/dev/null | sha256sum | awk '{print $1}')
    # echo "[DEBUG] PREV_PACKAGE_HASH='$PREV_PACKAGE_HASH' NEW_PACKAGE_HASH='$NEW_PACKAGE_HASH'" | tee -a "$LOG_FILE"

    if [ "$PREV_PACKAGE_HASH" = "$NEW_PACKAGE_HASH" ]; then
        info "package.json unchanged — skipping rebuild (faster deploy)"
        REBUILD_NEEDED=""
    fi
else
    # echo "[DEBUG] No previous commit available for package.json hash comparison" | tee -a "$LOG_FILE"
    :
fi

# Clean shutdown before rebuild to avoid port conflicts and stale state
if [ -n "$REBUILD_NEEDED" ]; then
    info "Stopping existing containers before rebuild..."
    docker compose -f "$COMPOSE_FILE" down 2>&1 | tee -a "$LOG_FILE" || true
    info "Containers stopped — proceeding with clean rebuild"
fi

info "Running: docker compose up -d $REBUILD_NEEDED"
if ! docker compose -f "$COMPOSE_FILE" up -d $REBUILD_NEEDED 2>&1 | tee -a "$LOG_FILE"; then
    fail "docker compose up failed. Container logs:"
    docker compose -f "$COMPOSE_FILE" logs --tail=40 2>&1 | tee -a "$LOG_FILE"
    increment_failure_count
    die "Deploy failed — see above for details."
fi

# ── Section 7: Health check with self-healing ────────────────────────────────────────────

section "Waiting for site to become healthy"

ATTEMPTS=$(( HEALTH_TIMEOUT / HEALTH_INTERVAL ))

_health_ok() {
    curl -sf --max-time 4 "${BACKEND_HEALTH_URL}" > /dev/null 2>&1
}

_wait_for_health() {
    local label="$1"
    info "Polling ${BACKEND_HEALTH_URL} — ${HEALTH_TIMEOUT}s timeout [$label]..."
    for i in $(seq 1 "$ATTEMPTS"); do
        if _health_ok; then return 0; fi
        if [ "$i" -eq "$ATTEMPTS" ]; then return 1; fi
        info "  attempt $i/$ATTEMPTS — not ready, retrying in ${HEALTH_INTERVAL}s..."
        sleep "$HEALTH_INTERVAL"
    done
    return 1
}

_dump_logs() {
    fail "Backend logs (last 50 lines):"
    docker compose -f "$COMPOSE_FILE" logs --tail=50 backend-dev 2>&1 | tee -a "$LOG_FILE"
    fail "Postgres logs (last 20 lines):"
    docker compose -f "$COMPOSE_FILE" logs --tail=20 postgres-dev 2>&1 | tee -a "$LOG_FILE"
}

_rollback() {
    if [ -n "${PREV_SHA:-}" ] && [ -n "${NEW_SHA:-}" ] && [ "$PREV_SHA" != "none" ] && [ "$PREV_SHA" != "$NEW_SHA" ]; then
        warn "Rolling back to previous commit (${PREV_SHA:0:7})..."
        git reset --hard "$PREV_SHA" 2>&1 | tee -a "$LOG_FILE"
        docker compose -f "$COMPOSE_FILE" down 2>&1 | tee -a "$LOG_FILE" || true
        docker compose -f "$COMPOSE_FILE" up -d --build 2>&1 | tee -a "$LOG_FILE" || true
        warn "Rolled back — verify the site is healthy before investigating."
    fi
}

if _wait_for_health "initial"; then
    ok "✓ Dev backend healthy at ${BACKEND_HEALTH_URL}"
    reset_failure_count
else
    warn "Initial health check failed — attempting self-healing..."

    # ── Self-heal Tier 1: restart backend container only
    info "Self-heal Tier 1: restarting backend container..."
    docker compose -f "$COMPOSE_FILE" restart backend-dev 2>&1 | tee -a "$LOG_FILE" || true

    if _wait_for_health "after backend restart"; then
        ok "✓ Recovered after backend restart"
        reset_failure_count
    else
        # ── Self-heal Tier 2: full stack down + up (no rebuild)
        warn "Self-heal Tier 2: full stack restart (no rebuild)..."
        docker compose -f "$COMPOSE_FILE" down 2>&1 | tee -a "$LOG_FILE" || true

        # Extra cleanup for stuck or orphaned containers, including Snap-managed daemons
        warn "Self-heal Tier 2a: removing dev stack orphans (if any)..."
        docker compose -f "$COMPOSE_FILE" down --remove-orphans 2>&1 | tee -a "$LOG_FILE" || true

        warn "Self-heal Tier 2b: checking for stuck dev containers..."
        docker ps -a --format '{{.ID}} {{.Names}} {{.Status}}' | grep 'myportfoliosite-dev-' || true

        if ask_yes_no "Snap-based Docker may need a daemon restart (this will briefly stop all containers). Restart ${SNAP_DOCKER_UNIT}?" "N"; then
            warn "Restarting Snap Docker daemon unit: ${SNAP_DOCKER_UNIT}..."
            if sudo systemctl restart "$SNAP_DOCKER_UNIT" 2>&1 | tee -a "$LOG_FILE"; then
                ok "Snap Docker daemon restarted successfully"
                if ! _wait_for_docker; then
                    increment_failure_count
                    die "Aborting deploy because Docker never became ready after Snap daemon restart"
                fi
            else
                warn "Failed to restart ${SNAP_DOCKER_UNIT}. Check systemctl status and logs."
            fi
        else
            warn "Skipped Snap Docker daemon restart at user request."
        fi

        # ── Self-heal Tier 2c: handle container ID conflicts after daemon restart
        if ask_yes_no "Docker may have stale dev containers (ID conflicts). Run 'docker compose down --remove-orphans' and re-create the dev stack?" "N"; then
            warn "Running docker compose down --remove-orphans to clear dev stack..."
            docker compose -f "$COMPOSE_FILE" down --remove-orphans 2>&1 | tee -a "$LOG_FILE" || true

            info "Re-creating dev stack after cleanup..."
            if ! docker compose -f "$COMPOSE_FILE" up -d 2>&1 | tee -a "$LOG_FILE"; then
                fail "docker compose up failed even after cleanup."
                _dump_logs
                increment_failure_count
                die "Deploy failed after Snap cleanup and re-create — see log at $LOG_FILE"
            fi
        else
            warn "Skipped container cleanup; dev stack may still have stale containers."
        fi

        if _wait_for_health "after full restart"; then
            ok "✓ Recovered after full stack restart"
            reset_failure_count
        else
            # All self-healing failed
            fail "✗ Health check failed after all self-healing attempts"
            _dump_logs
            increment_failure_count
            FAILURE_COUNT=$(get_failure_count)
            warn "Consecutive deployment failures: $FAILURE_COUNT"

            _rollback()

            if [ "$FAILURE_COUNT" -ge 3 ]; then
                warn ""
                warn "══════════════════════════════════════════════════════"
                warn "  ⚠️  3+ consecutive failures — nuclear rebuild"
                warn ""
                if ask_yes_no "Run nuclear rebuild script now? (bash ${DEV_REPO}/scripts/setup/nuclear-rebuild.sh)" "N"; then
                    warn "Running nuclear rebuild script..."
                    if bash "${DEV_REPO}/scripts/setup/nuclear-rebuild.sh" 2>&1 | tee -a "$LOG_FILE"; then
                        ok "Nuclear rebuild completed. Re-run this deploy script to start fresh."
                    else
                        warn "Nuclear rebuild script exited with errors. Check the log above and ${DEV_REPO}/scripts/setup/nuclear-rebuild.sh."
                    fi
                else
                    warn "Skipped automatic nuclear rebuild. When ready, run:"
                    warn "  bash ${DEV_REPO}/scripts/setup/nuclear-rebuild.sh"
                fi
                warn ""
                warn "  This script:"
                warn "    • Stops and removes DEV containers, images, networks"
                warn "    • Preserves DEV database (use --wipe-db to reset it)"
                warn "    • Does NOT affect production site"
                warn ""
                warn "  Persistent failures suggest deeper issues (disk space,"
                warn "  Docker daemon problems, or infrastructure issues)."
                warn "  Monitor system resources after nuclear rebuild."
                warn "══════════════════════════════════════════════════════"
            elif [ "$FAILURE_COUNT" -ge 2 ]; then
                warn ""
                warn "  2 consecutive failures — Docker daemon may need restart."
                if ask_yes_no "Restart docker.service now?" "N"; then
                    if sudo systemctl restart docker 2>&1 | tee -a "$LOG_FILE"; then
                        if ! _wait_for_docker; then
                            increment_failure_count
                            die "Aborting deploy because Docker never became ready after docker.service restart"
                        fi
                    else
                        warn "docker.service restart failed"
                    fi
                fi
                if ask_yes_no "Restart Snap Docker unit ${SNAP_DOCKER_UNIT} now (if using Snap)?" "N"; then
                    if sudo systemctl restart "$SNAP_DOCKER_UNIT" 2>&1 | tee -a "$LOG_FILE"; then
                        if ! _wait_for_docker; then
                            increment_failure_count
                            die "Aborting deploy because Docker never became ready after Snap daemon restart"
                        fi
                    else
                        warn "${SNAP_DOCKER_UNIT} restart failed"
                    fi
                fi
                warn "  If you restarted any daemon, re-run this deploy script."
                warn ""
            fi

            die "Deploy failed after all recovery attempts — see log at $LOG_FILE"
        fi
    fi
fi

# ── Section 8: Summary ───────────────────────────────────────────────────────────────────────────

section "Deploy complete"

ok ""
ok "  Site:    ${FRONTEND_URL}"
ok "  Health:  ${BACKEND_HEALTH_URL}"
ok "  Branch:  $DEPLOY_BRANCH"
ok "  Commit:  $(git rev-parse --short HEAD)"
ok "  Log:     $LOG_FILE"
ok ""

info "Container status:"
docker compose -f "$COMPOSE_FILE" ps 2>&1 | tee -a "$LOG_FILE"

log ""
_print_box "${BOLD}" "Dev deploy complete ✓"
log ""

# ── Section 9: Post-deploy configuration setup ──────────────────────────────────────────────

if [ "$NEED_CRON" = true ] || [ "$NEED_AUTOSTART" = true ] || [ "$UFW_INSTALLED" = true ]; then
    section "Optional configuration setup"

    # UFW status check happens here, post-deploy, where interactive sudo is expected
    if [ "$UFW_INSTALLED" = true ] && [ -t 0 ]; then
        _ufw_status=$(sudo ufw status 2>/dev/null)
        if echo "$_ufw_status" | grep -q "Status: active"; then
            # Check SSH rule (port 2222) — warn if missing to prevent lockout on next enable
            if ! echo "$_ufw_status" | grep -q "2222"; then
                warn "UFW is active but SSH port 2222 has no rule — add it to avoid future lockout:"
                warn "  sudo ufw allow 2222/tcp comment 'SSH'"
            else
                ok "UFW is active and SSH port 2222 rule is present"
            fi
            if echo "$_ufw_status" | grep -q "3001"; then
                ok "UFW is active and port 3001 rule is present"
            else
                NEED_UFW_RULE=true
            fi
        elif echo "$_ufw_status" | grep -q "Status: inactive"; then
            NEED_UFW_ENABLE=true
        else
            warn "Could not determine UFW status — verify manually: sudo ufw status"
        fi
    fi

    if [ "$NEED_UFW_ENABLE" = true ] && [ -t 0 ]; then
        echo ""
        echo -e "${YELLOW}${BOLD}[SETUP]${RESET} UFW firewall is installed but not active."
        echo "        It must be enabled for the firewall rules to take effect."
        echo ""
        echo -e "        ${RED}${BOLD}IMPORTANT:${RESET} SSH (port 2222) will be allowed before enabling UFW"
        echo "        to ensure you are not locked out of the server."
        read -r -p "        Enable UFW now? [y/n] " _ufw_enable_resp
        if [[ "$_ufw_enable_resp" =~ ^[Yy]$ ]]; then
            # Always allow SSH before enabling UFW to prevent lockout
            sudo ufw allow 2222/tcp comment 'SSH' 2>&1 | tee -a "$LOG_FILE"
            ok "SSH port 2222 rule added"
            if sudo ufw enable 2>&1 | tee -a "$LOG_FILE"; then
                ok "UFW enabled"
                log "[$(timestamp)] UFW enabled by deploy script" | tee -a "$LOG_FILE"
                NEED_UFW_RULE=true
            else
                warn "UFW enable failed — run manually: sudo ufw allow 2222/tcp && sudo ufw enable"
            fi
        else
            warn "Skipped — when ready: sudo ufw allow 2222/tcp && sudo ufw enable"
        fi
    fi

    if [ "$NEED_UFW_RULE" = true ] && [ -t 0 ]; then
        echo ""
        echo -e "${YELLOW}${BOLD}[SETUP]${RESET} UFW rule for port 3001 is not configured."
        echo "        The dev site won't be reachable from other LAN devices without this rule."
        read -r -p "        Set up UFW rule now? [y/n] " _ufw_rule_resp
        if [[ "$_ufw_rule_resp" =~ ^[Yy]$ ]]; then
            if sudo ufw allow from 192.168.0.0/16 to any port 3001 comment 'Dev site LAN-only' 2>&1 | tee -a "$LOG_FILE"; then
                ok "UFW rule added for 192.168.0.0/16 on port 3001"
                log "[$(timestamp)] UFW rule added by deploy script" | tee -a "$LOG_FILE"
                warn "Note: If your LAN uses a different subnet (e.g. 10.x.x.x), run:"
                warn "  sudo ufw allow from YOUR_SUBNET to any port 3001 comment 'Dev site LAN-only'"
            else
                warn "UFW rule setup failed — run manually: sudo ufw allow from 192.168.0.0/16 to any port 3001 comment 'Dev site LAN-only'"
            fi
        else
            warn "Skipped — run manually when ready: sudo ufw allow from 192.168.0.0/16 to any port 3001 comment 'Dev site LAN-only'"
        fi
    fi

    if [ "$NEED_CRON" = true ] && [ -t 0 ]; then
        echo ""
        echo -e "${YELLOW}${BOLD}[SETUP]${RESET} Docker cleanup cron job is not scheduled."
        echo "        Running 'docker system prune' weekly prevents disk issues over time."
        read -r -p "        Set up weekly Docker cleanup cron now? [y/n] " _cron_resp
        if [[ "$_cron_resp" =~ ^[Yy]$ ]]; then
            (sudo crontab -l 2>/dev/null; echo "0 2 * * 0 /usr/bin/docker system prune -f --volumes >> /var/log/docker-prune.log 2>&1") | sudo crontab -
            ok "Weekly Docker cleanup cron scheduled (Sundays at 2 AM)"
            log "[$(timestamp)] Cron job added by deploy script" | tee -a "$LOG_FILE"
        else
            warn "Skipped — run 'sudo crontab -e' to add it manually when ready."
        fi
    fi

    if [ "$NEED_AUTOSTART" = true ] && [ -t 0 ]; then
        echo ""
        echo -e "${YELLOW}${BOLD}[SETUP]${RESET} Dev autostart service is not installed."
        echo "        Without it, the dev stack won't come back up automatically after a reboot."
        read -r -p "        Install autostart service now? [y/n] " _autostart_resp
        if [[ "$_autostart_resp" =~ ^[Yy]$ ]]; then
            if sudo bash "$DEV_REPO/scripts/setup/install-dev-autostart.sh"; then
                ok "Dev autostart service installed and enabled"
                log "[$(timestamp)] Autostart service installed by deploy script" | tee -a "$LOG_FILE"
            else
                warn "Autostart install failed — run manually: sudo bash $DEV_REPO/scripts/setup/install-dev-autostart.sh"
            fi
        else
            warn "Skipped — run 'sudo bash $DEV_REPO/scripts/setup/install-dev-autostart.sh' when ready."
        fi
    fi

    if [ ! -t 0 ]; then
        warn "Running non-interactively — skipping setup prompts."
        warn "Set up missing items manually:"
        [ "$UFW_INSTALLED" = true ]  && warn "  UFW:          sudo ufw status | grep 3001  (verify port 3001 is allowed from LAN)"
        [ "$NEED_CRON" = true ]      && warn "  Cron:         sudo crontab -e  (add: 0 2 * * 0 /usr/bin/docker system prune -f --volumes >> /var/log/docker-prune.log 2>&1)"
        [ "$NEED_AUTOSTART" = true ] && warn "  Autostart:    sudo bash $DEV_REPO/scripts/setup/install-dev-autostart.sh"
    fi
fi
