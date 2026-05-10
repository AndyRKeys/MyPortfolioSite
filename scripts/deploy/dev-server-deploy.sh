#!/usr/bin/env bash
# Dev server deployment script — Ubuntu Server LAN-only HTTPS dev stack
# ... (rest of file unchanged up to health check section)

# ── Section 8: Health check with self-healing ────────────────────────────────────────────

section "Waiting for site to become healthy"

ATTEMPTS=$(( HEALTH_TIMEOUT / HEALTH_INTERVAL ))

# -k to trust self-signed certificate on dev server
_health_ok() { curl -sfk --max-time 4 "${FRONTEND_URL}/api/health" > /dev/null 2>&1; }

_wait_for_health() {
    local label="$1"
    info "Polling ${FRONTEND_URL}/api/health — ${HEALTH_TIMEOUT}s timeout [$label]..."
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
    if [ "$PREV_SHA" != "none" ] && [ "$PREV_SHA" != "$NEW_SHA" ]; then
        warn "Rolling back to previous commit (${PREV_SHA:0:7})..."
        git reset --hard "$PREV_SHA" 2>&1 | tee -a "$LOG_FILE"
        docker compose -f "$COMPOSE_FILE" down 2>&1 | tee -a "$LOG_FILE" || true
        docker compose -f "$COMPOSE_FILE" up -d --build 2>&1 | tee -a "$LOG_FILE" || true
        warn "Rolled back — verify the site is healthy before investigating."
    fi
}

if _wait_for_health "initial"; then
    ok "✓ Dev site healthy at ${FRONTEND_URL}"
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
        docker compose -f "$COMPOSE_FILE" up -d 2>&1 | tee -a "$LOG_FILE" || true

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

            _rollback

            if [ "$FAILURE_COUNT" -ge 3 ]; then
                warn ""
                warn "══════════════════════════════════════════════════════"
                warn "  ⚠️  3+ consecutive failures — nuclear rebuild"
                warn ""
                warn "  bash ${DEV_REPO}/scripts/setup/nuclear-rebuild.sh"
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
                warn "  ⚠️  2 consecutive failures — Docker daemon may need restart:"
                warn "  sudo systemctl restart docker"
                warn ""
                warn "  This briefly interrupts BOTH dev and production services."
                warn "  Then re-run the deploy script."
                warn ""
            fi

            die "Deploy failed after all recovery attempts — see log at $LOG_FILE"
        fi
    fi
fi

# ── Section 9: Summary ───────────────────────────────────────────────────────────────────────────

section "Deploy complete"

ok ""
ok "  Site:    ${FRONTEND_URL}"
ok "  Branch:  $DEPLOY_BRANCH"
ok "  Commit:  $(git rev-parse --short HEAD)"
ok "  Log:     $LOG_FILE"
