#!/usr/bin/env bash
# This file is sourced by deploy-lib.sh — do not execute directly.
# set -euo pipefail is inherited from the parent shell.

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
      dc logs --tail=50 "$backend_service" 2>&1 | tee -a "$LOG_FILE" || true

      # Nginx logs are critical for diagnosing SSL/config failures
      if [ -n "${NGINX_SERVICE:-}" ]; then
        dfail ""
        dfail "Nginx logs — $NGINX_SERVICE (last 30 lines):"
        dc logs --tail=30 "$NGINX_SERVICE" 2>&1 | tee -a "$LOG_FILE" || true
      fi

      _do_rollback "health check timed out"

      ddie "Deploy failed — health check timed out after ${timeout}s"
    fi

    dinfo "  attempt $i/$attempts — not ready yet, retrying in ${interval}s..."
    sleep "$interval"
  done
}

check_outlook_token() {
  local backend_service="${1:-backend}"

  # Grep the startup logs for the preflight result emitted by server.js.
  # Non-blocking: a missing or invalid token is a warning, not a deploy failure.
  local log_output
  log_output=$(dc logs --no-log-prefix --tail=50 "$backend_service" 2>&1)

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
