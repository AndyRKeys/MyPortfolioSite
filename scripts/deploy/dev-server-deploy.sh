#!/usr/bin/env bash
# dev-server-deploy.sh — Unified dev environment setup and deploy script.
#
# Handles both first-time setup and subsequent deploys.
# Run on the Ubuntu Server as the non-root user.
#
# Usage:
#   bash scripts/deploy/dev-server-deploy.sh
#
# On first run the script will clone the repo and guide you through .env setup.
# On subsequent runs it pulls the latest dev branch and rebuilds containers.

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────────────────

DEV_REPO="${HOME}/MyPortfolioSite-dev"
REPO_URL="https://github.com/AndyRKeys/MyPortfolioSite.git"
COMPOSE_FILE="${DEV_REPO}/docker-compose.dev-server.yml"
LOG_FILE="${HOME}/dev-deploy.log"
HEALTH_TIMEOUT=60   # seconds to wait for the site to become healthy
HEALTH_INTERVAL=5   # seconds between health check attempts

# Required .env vars — must be present and not a placeholder value
REQUIRED_VARS=(LAN_IP DB_PASSWORD JWT_SECRET WEBAUTHN_RP_ID WEBAUTHN_ORIGIN FRONTEND_URL)

# Placeholder values that signal the var hasn't been configured
PLACEHOLDER_PATTERNS=("192.168.x.x" "change-me" "your-" "xxx")

# ── Helpers ───────────────────────────────────────────────────────────────────────────

# Colour support only when attached to a real terminal
if [ -t 1 ]; then
    RED='\033[0;31m'; YELLOW='\033[0;33m'; GREEN='\033[0;32m'
    CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
else
    RED=''; YELLOW=''; GREEN=''; CYAN=''; BOLD=''; RESET=''
fi

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

# ── Entry point ─────────────────────────────────────────────────────────────────────────

log ""
log "${BOLD}╔══════════════════════════════════════════╗${RESET}"
log "${BOLD}║     Dev Server Deploy — $(timestamp)   ║${RESET}"
log "${BOLD}╚══════════════════════════════════════════╝${RESET}"
log ""

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

if [ ! -d "$DEV_REPO" ]; then
    info "Dev repo not found at $DEV_REPO — cloning..."
    git clone "$REPO_URL" "$DEV_REPO" || die "git clone failed. Check your internet connection."
    cd "$DEV_REPO"
    git checkout dev || die "Could not switch to dev branch."
    ok "Repo cloned and set to dev branch."
else
    ok "Repo found at $DEV_REPO"
fi

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
        warn "    WEBAUTHN_ORIGIN  — http://<LAN_IP>:3001"
        warn "    FRONTEND_URL     — http://<LAN_IP>:3001"
        warn ""
        die "Configure .env then re-run this script."
    else
        die ".env not found and .env.dev-server.example is missing. Check your checkout."
    fi
fi

ok ".env file present"

# ── Section 3: Environment validation ───────────────────────────────────────────────────

section "Validating .env"

# Source .env safely — only export KEY=VALUE lines
set -a
# shellcheck disable=SC1090
source <(grep -E '^[A-Z_]+=.' "${DEV_REPO}/.env" | grep -v '^#') 2>/dev/null || true
set +a

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
    ENV_ERRORS+=("WEBAUTHN_ORIGIN ('$WEBAUTHN_ORIGIN') should end with :3001 — passkey registration will fail otherwise")
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

if command -v ufw &>/dev/null; then
    UFW_STATUS=$(timeout 5 sudo ufw status 2>/dev/null || echo "Error: UFW check timed out")
    if echo "$UFW_STATUS" | grep -q "Status: active"; then
        ok "UFW is active"
        if echo "$UFW_STATUS" | grep -q "3001"; then
            ok "UFW rule for port 3001 is present"
        else
            warn "UFW is active but rule for port 3001 not found — will offer setup after deploy"
            NEED_UFW_RULE=true
        fi
    elif echo "$UFW_STATUS" | grep -q "Status: inactive"; then
        warn "UFW is installed but inactive — will offer to enable after deploy"
        NEED_UFW_ENABLE=true
    else
        warn "Could not determine UFW status (ufw may not be responding) — skipping firewall checks"
    fi
else
    info "UFW not installed (optional)"
fi

# ── Section 5: Maintenance checks ───────────────────────────────────────────────────────────

section "Checking Docker maintenance setup"

NEED_CRON=false
NEED_AUTOSTART=false

# Check for Docker system prune cron job
if sudo crontab -l 2>/dev/null | grep -q "docker system prune"; then
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

if [ "$NEED_CRON" = true ] || [ "$NEED_AUTOSTART" = true ] || [ "$NEED_UFW_ENABLE" = true ] || [ "$NEED_UFW_RULE" = true ]; then
    warn ""
    warn "Some configuration items are missing. Deploy will continue and you"
    warn "will be prompted to set them up once the site is healthy."
    warn ""
fi

# ── Section 6: Git update ───────────────────────────────────────────────────────────────────

section "Updating to latest dev branch"

cd "$DEV_REPO"

PREV_SHA=$(git rev-parse HEAD 2>/dev/null || echo "none")
info "Current commit: $PREV_SHA"

git fetch origin dev 2>&1 | tee -a "$LOG_FILE" || die "git fetch failed. Check your internet connection."
git reset --hard origin/dev 2>&1 | tee -a "$LOG_FILE"

NEW_SHA=$(git rev-parse HEAD)
if [ "$NEW_SHA" = "$PREV_SHA" ]; then
    info "Already at latest commit — no code changes."
else
    ok "Updated: ${PREV_SHA:0:7} → ${NEW_SHA:0:7}"
fi

# ── Section 7: Docker build & up ───────────────────────────────────────────────────────────

section "Building and starting dev services"

# Check if package.json changed to avoid unnecessary rebuilds
REBUILD_NEEDED="--build"
if [ "$NEW_SHA" != "$PREV_SHA" ]; then
    PREV_PACKAGE_HASH=$(git show "$PREV_SHA:backend/package.json" 2>/dev/null | sha256sum | awk '{print $1}')
    NEW_PACKAGE_HASH=$(git show "$NEW_SHA:backend/package.json" 2>/dev/null | sha256sum | awk '{print $1}')
    if [ "$PREV_PACKAGE_HASH" = "$NEW_PACKAGE_HASH" ]; then
        info "package.json unchanged — skipping rebuild (faster deploy)"
        REBUILD_NEEDED=""
    fi
fi

info "Running: docker compose up -d $REBUILD_NEEDED"
if ! docker compose -f "$COMPOSE_FILE" up -d $REBUILD_NEEDED 2>&1 | tee -a "$LOG_FILE"; then
    fail "docker compose up failed. Container logs:"
    docker compose -f "$COMPOSE_FILE" logs --tail=40 2>&1 | tee -a "$LOG_FILE"
    # Roll back to previous commit if there was one
    if [ "$PREV_SHA" != "none" ] && [ "$PREV_SHA" != "$NEW_SHA" ]; then
        warn "Rolling back to previous commit ($PREV_SHA)..."
        git reset --hard "$PREV_SHA"
        docker compose -f "$COMPOSE_FILE" up -d --build 2>&1 | tee -a "$LOG_FILE" || true
    fi
    die "Deploy failed — see above for details."
fi

# ── Section 8: Health check ───────────────────────────────────────────────────────────────────

section "Waiting for site to become healthy"

DEV_URL="http://${LAN_IP}:3001"
ATTEMPTS=$(( HEALTH_TIMEOUT / HEALTH_INTERVAL ))

info "Polling ${DEV_URL}/api/health (${HEALTH_TIMEOUT}s timeout)..."

for i in $(seq 1 "$ATTEMPTS"); do
    if curl -sf --max-time 4 "${DEV_URL}/api/health" > /dev/null 2>&1; then
        ok "✓ Dev site healthy at ${DEV_URL}"
        break
    fi
    if [ "$i" -eq "$ATTEMPTS" ]; then
        fail "✗ Health check failed after ${HEALTH_TIMEOUT}s"
        fail ""
        fail "Backend logs (last 50 lines):"
        docker compose -f "$COMPOSE_FILE" logs --tail=50 backend-dev 2>&1 | tee -a "$LOG_FILE"
        fail ""
        fail "Postgres logs (last 20 lines):"
        docker compose -f "$COMPOSE_FILE" logs --tail=20 postgres-dev 2>&1 | tee -a "$LOG_FILE"
        # Roll back if the code changed
        if [ "$PREV_SHA" != "none" ] && [ "$PREV_SHA" != "$NEW_SHA" ]; then
            warn "Rolling back to previous commit (${PREV_SHA:0:7})..."
            git reset --hard "$PREV_SHA" 2>&1 | tee -a "$LOG_FILE"
            docker compose -f "$COMPOSE_FILE" up -d --build 2>&1 | tee -a "$LOG_FILE" || true
            warn "Rolled back — verify the site is healthy before investigating the failed update."
        fi
        die "Deploy failed — see log at $LOG_FILE"
    fi
    info "  attempt $i/$ATTEMPTS — not ready yet, retrying in ${HEALTH_INTERVAL}s..."
    sleep "$HEALTH_INTERVAL"
done

# ── Section 9: Summary ───────────────────────────────────────────────────────────────────────────

section "Deploy complete"

ok ""
ok "  Site:    ${DEV_URL}"
ok "  Commit:  $(git rev-parse --short HEAD)"
ok "  Log:     $LOG_FILE"
ok ""

info "Container status:"
docker compose -f "$COMPOSE_FILE" ps 2>&1 | tee -a "$LOG_FILE"

log ""
log "${BOLD}╔══════════════════════════════════════════╗${RESET}"
log "${BOLD}║           Dev deploy complete ✓          ║${RESET}"
log "${BOLD}╚══════════════════════════════════════════╝${RESET}"
log ""

# ── Section 10: Post-deploy configuration setup ──────────────────────────────────────────────

if [ "$NEED_CRON" = true ] || [ "$NEED_AUTOSTART" = true ] || [ "$NEED_UFW_ENABLE" = true ] || [ "$NEED_UFW_RULE" = true ]; then
    section "Optional configuration setup"

    if [ "$NEED_UFW_ENABLE" = true ] && [ -t 0 ]; then
        echo ""
        echo -e "${YELLOW}${BOLD}[SETUP]${RESET} UFW firewall is installed but not active."
        echo "        It must be enabled for the firewall rules to take effect."
        read -r -p "        Enable UFW now? [y/N] " _ufw_enable_resp
        if [[ "$_ufw_enable_resp" =~ ^[Yy]$ ]]; then
            if sudo ufw enable 2>&1 | tee -a "$LOG_FILE"; then
                ok "UFW enabled"
                log "[$(timestamp)] UFW enabled by deploy script" | tee -a "$LOG_FILE"
                NEED_UFW_RULE=true
            else
                warn "UFW enable failed — run manually: sudo ufw enable"
            fi
        else
            warn "Skipped — run manually when ready: sudo ufw enable"
        fi
    fi

    if [ "$NEED_UFW_RULE" = true ] && [ -t 0 ]; then
        echo ""
        echo -e "${YELLOW}${BOLD}[SETUP]${RESET} UFW rule for port 3001 is not configured."
        echo "        The dev site won't be reachable from other LAN devices without this rule."
        read -r -p "        Set up UFW rule now? [y/N] " _ufw_rule_resp
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
        read -r -p "        Set up weekly Docker cleanup cron now? [y/N] " _cron_resp
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
        read -r -p "        Install autostart service now? [y/N] " _autostart_resp
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
        [ "$NEED_UFW_ENABLE" = true ] && warn "  UFW enable:   sudo ufw allow 22/tcp && sudo ufw enable"
        [ "$NEED_UFW_RULE" = true ]  && warn "  UFW rule:     sudo ufw allow from 192.168.0.0/16 to any port 3001 comment 'Dev site LAN-only'"
        [ "$NEED_CRON" = true ]      && warn "  Cron:         sudo crontab -e  (add: 0 2 * * 0 /usr/bin/docker system prune -f --volumes >> /var/log/docker-prune.log 2>&1)"
        [ "$NEED_AUTOSTART" = true ] && warn "  Autostart:    sudo bash $DEV_REPO/scripts/setup/install-dev-autostart.sh"
    fi
fi
