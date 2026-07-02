#!/usr/bin/env bash
# This file is sourced by deploy-lib.sh — do not execute directly.
# set -euo pipefail is inherited from the parent shell.

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
  dc down --remove-orphans 2>&1 | tee -a "$LOG_FILE" || true
  dc up -d --build --no-cache 2>&1 | tee -a "$LOG_FILE" || true

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
    dc down --remove-orphans 2>&1 | tee -a "$LOG_FILE" || true
    docker system prune -f 2>&1 | tee -a "$LOG_FILE" || true
    dc up -d --build 2>&1 | tee -a "$LOG_FILE" || true

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

# _perform_rollback_containers
# Runs dc down + dc up + sets DEPLOY_ROLLED_BACK=1 + checks rollback health.
# Assumes git has already been set to the target state.
# Returns 0 on success, 1 if dc up fails (health check may still recover).
_perform_rollback_containers() {
  dc down --remove-orphans 2>&1 | tee -a "$LOG_FILE" || true
  dc up -d --build 2>&1 | tee -a "$LOG_FILE"
  [ "${PIPESTATUS[0]}" -eq 0 ] \
    || { dfail "[rollback] dc up failed — manual recovery required"; return 1; }
  DEPLOY_ROLLED_BACK=1
  _check_rollback_health
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
    git checkout -B "$rollback_branch" "$rollback_sha" 2>&1 | tee -a "$LOG_FILE"; [ "${PIPESTATUS[0]}" -eq 0 ] \
      || { dfail "[rollback] git checkout to ${rollback_sha:0:7} failed — manual recovery required"; return 1; }
    _perform_rollback_containers

  elif [ -n "${ROLLBACK_BRANCH:-}" ] && [ "${ROLLBACK_BRANCH}" != "${BRANCH:-}" ]; then
    # Roll back to a known-stable branch (e.g. dev or main) rather than a
    # previous commit on the same potentially-broken feature branch.
    dstatus rollback reason="$reason" target="$ROLLBACK_BRANCH" method=stable-branch
    dwarn "Rolling back to stable branch '$ROLLBACK_BRANCH' after: $reason"
    git fetch origin "$ROLLBACK_BRANCH" 2>&1 | tee -a "$LOG_FILE"; [ "${PIPESTATUS[0]}" -eq 0 ] \
      || { dfail "[rollback] git fetch for '$ROLLBACK_BRANCH' failed — manual recovery required"; return 1; }
    git checkout -B "$ROLLBACK_BRANCH" "origin/$ROLLBACK_BRANCH" 2>&1 | tee -a "$LOG_FILE"; [ "${PIPESTATUS[0]}" -eq 0 ] \
      || { dfail "[rollback] git checkout to '$ROLLBACK_BRANCH' failed — manual recovery required"; return 1; }
    _perform_rollback_containers

  elif [ "${PRE_SHA:-none}" != "none" ] && [ "${PRE_SHA:-none}" != "${NEW_SHA:-none}" ]; then
    # Same branch deploy: revert to the previous commit.
    dstatus rollback reason="$reason" target="${PRE_SHA:0:7}" method=previous-commit
    dwarn "Rolling back to previous commit (${PRE_SHA:0:7}) after: $reason"
    git reset --hard "$PRE_SHA" 2>&1 | tee -a "$LOG_FILE"; [ "${PIPESTATUS[0]}" -eq 0 ] \
      || { dfail "[rollback] git reset to ${PRE_SHA:0:7} failed — manual recovery required"; return 1; }
    _perform_rollback_containers

  else
    dstatus rollback reason="$reason" method=none status=no-rollback-available
    dwarn "No automatic rollback available (already on '$ROLLBACK_BRANCH' or no prior commit)."
    dwarn "Manual intervention required — check container logs above."
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
  if ! nginx_output=$(dc run --rm --no-deps "$nginx_service" nginx -t 2>&1); then
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
  new_config=$(dc run --rm --no-deps "$nginx_service" \
    sh -c 'cat /etc/nginx/conf.d/default.conf' 2>/dev/null || echo "")
  current_config=$(dc exec -T "$nginx_service" \
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
    dc rm -fs "$nginx_service" 2>/dev/null | _log_cmd || true
  fi
}

# ── Schema apply ─────────────────────────────────────────────────────────────
# Applies schema.sql to the running postgres container. Safe to re-run — all
# statements use IF NOT EXISTS / IF NOT. Called after compose up so the DB is
# guaranteed to be healthy before we attempt the psql connection.

apply_schema() {
  dsection "Phase 5b: applying DB schema"
  local postgres_service="${POSTGRES_SERVICE:-postgres}"

  if ! dc exec -T "$postgres_service" \
      psql -U "${DB_USER:-postgres}" -d "${DB_NAME:-portfolio_prod}" \
      -f /docker-entrypoint-initdb.d/01-schema.sql \
      >> "$LOG_FILE" 2>&1; then
    dwarn "Schema apply failed — DB may be missing new tables. Check $LOG_FILE."
  else
    dok "Schema applied successfully"
  fi
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
  running_services=$(dc ps --all --format '{{.Service}}' 2>/dev/null | sort -u || true)
  defined_services=$(dc config --services 2>/dev/null | sort -u || true)
  if [ -n "$running_services" ] && [ -n "$defined_services" ]; then
    while IFS= read -r svc; do
      [ -z "$svc" ] && continue
      if ! echo "$defined_services" | grep -qxF "$svc"; then
        dwarn "Orphan container detected: service '$svc' (not in current compose file — will be removed)"
      fi
    done <<< "$running_services"
  fi

  dinfo "Stopping existing stack before rebuild..."
  dc down --remove-orphans 2>&1 | _log_cmd || true

  # Pass commit SHA to nginx container so sub_filter can cache-bust JS module imports in HTML
  DEPLOY_VERSION=$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo "dev")
  export DEPLOY_VERSION
  dinfo "DEPLOY_VERSION=$DEPLOY_VERSION"

  dinfo "Running: docker compose -f $COMPOSE_FILE up -d --build"

  if ! dc up -d --build 2>&1 | _log_cmd; then
    dstatus compose status=failed service="$service_name"
    dfail "docker compose up failed. Container logs for $service_name:"
    dc logs --tail=40 "$service_name" 2>&1 | tee -a "$LOG_FILE" || true
    _do_rollback "docker compose up failed"
    ddie "Deploy failed — see above for details."
  fi

  # If NGINX_SERVICE is set, verify it actually started — nginx exits immediately
  # on config errors, so catching it here avoids a silent 60s health check timeout.
  if [ -n "${NGINX_SERVICE:-}" ]; then
    sleep 2  # allow nginx to finish initialising or fail-fast
    local nginx_state
    nginx_state=$(dc ps --format '{{.State}}' "$NGINX_SERVICE" 2>/dev/null \
      || dc ps "$NGINX_SERVICE" 2>/dev/null | awk 'NR==2{print $4}' \
      || echo "unknown")

    if [[ "$nginx_state" != "running" ]]; then
      dstatus compose status=failed service="$NGINX_SERVICE" reason="nginx-not-running state=${nginx_state}"
      dfail "Nginx container is not running (state: $nginx_state)"
      dfail ""
      dfail "Nginx logs:"
      dc logs --tail=30 "$NGINX_SERVICE" 2>&1 | tee -a "$LOG_FILE" || true
      _do_rollback "nginx failed to start"
      ddie "Nginx failed to start — check the nginx config and cert paths above."
    fi

    dok "Nginx container is running"
  fi

  dstatus compose status=ok service="$service_name"
}
