#!/usr/bin/env bash
# Regression smoke tests — runs on the server post-deploy.
# Covers stable HTTP checks that should pass on every deploy.
#
# Usage:
#   bash scripts/tests/test-regression.sh \
#     --base-url https://dev.andykeys.me:3001 \
#     --compose-file /path/to/docker-compose.yml \
#     --service backend \
#     [--insecure]
#
# --insecure   Pass -k to curl (required for self-signed dev certs).
# --token      JWT to use directly (skips auto-generation).
# --service    Docker Compose service name to generate JWT from (default: backend).

set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────────

if [ -t 1 ]; then
  C_RED='\033[0;31m'; C_YELLOW='\033[0;33m'; C_GREEN='\033[0;32m'
  C_CYAN='\033[0;36m'; C_BOLD='\033[1m'; C_DIM='\033[2m'; C_RESET='\033[0m'
else
  C_RED=''; C_YELLOW=''; C_GREEN=''; C_CYAN=''; C_BOLD=''; C_DIM=''; C_RESET=''
fi

# shellcheck source=../deploy/output-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../deploy/output-lib.sh"

# Honour the deploy's quiet mode (exported by dev/prod-deploy.sh). In quiet
# mode, suppress the header box, section headers, INFO lines and per-test
# PASS/SKIP rows — but ALWAYS keep FAIL rows, the final results box and the
# machine-readable [regression] line so failures stay diagnosable.
QUIET="${DEPLOY_QUIET:-0}"
say() { [ "$QUIET" = "1" ] || echo -e "$@"; }

# ── Args ────────────────────────────────────────────────────────────────────────

BASE_URL=""
TOKEN=""
COMPOSE_FILE=""
SERVICE="backend"
INSECURE=""
RESOLVE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)           BASE_URL="$2";      shift 2 ;;
    --token)              TOKEN="$2";         shift 2 ;;
    --compose-file)       COMPOSE_FILE="$2";  shift 2 ;;
    --service)            SERVICE="$2";       shift 2 ;;
    --insecure)           INSECURE="-k";      shift   ;;
    --resolve)            RESOLVE="$2";       shift 2 ;;
    --reset-rate-limits)                      shift   ;; # no-op: reset now runs unconditionally
    *) shift ;;
  esac
done

# Build curl --resolve args so the request connects to a reachable address
# (e.g. the LAN IP) while keeping the original Host/SNI for cert + routing.
# Needed because the server cannot route to its own public DNS name (no NAT
# hairpin), but the deploy must still test via the real hostname.
RESOLVE_ARGS=()
RESOLVE_IP=""
if [ -n "$RESOLVE" ]; then
  RESOLVE_ARGS=(--resolve "$RESOLVE")
  RESOLVE_IP="${RESOLVE##*:}"  # hostname:port:ip — extract the connect IP
fi

if [ -z "$BASE_URL" ]; then
  echo "Usage: $0 --base-url <url> --compose-file <file> [--service <name>] [--insecure]" >&2
  exit 1
fi

# ── JWT auto-generation ──────────────────────────────────────────────────────────

if [ -z "$TOKEN" ] && [ -n "$COMPOSE_FILE" ]; then
  TOKEN=$(docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE" node --input-type=module -e "
    import jwt from 'jsonwebtoken';
    if (!process.env.JWT_SECRET) { process.stderr.write('NO_SECRET\n'); process.exit(1); }
    console.log(jwt.sign({ userId: 'regression-test' }, process.env.JWT_SECRET, { expiresIn: '1h' }));
  " 2>/dev/null | grep '^eyJ' | tail -1 || true)
  if [ -n "$TOKEN" ]; then
    say "  ${C_CYAN}${C_BOLD}ℹ  [INFO]${C_RESET}  JWT generated from $SERVICE container (1h expiry)"
  else
    echo -e "  ${C_YELLOW}${C_BOLD}⚠️  [WARN]${C_RESET}  Could not generate JWT — auth tests will be skipped"
  fi
fi

# ── Service key auto-derivation (#406) ───────────────────────────────────────────
# Read SERVICE_KEY from the container so contact baseline tests can identify as
# the trusted service account and be exempt from rate limiting. Without this,
# back-to-back contact requests risk a 429 if prior test runs consumed slots.

SERVICE_KEY=""
if [ -n "$COMPOSE_FILE" ]; then
  SERVICE_KEY=$(docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE" \
    printenv SERVICE_KEY 2>/dev/null | tr -d '\r\n' || true)
  if [ -n "$SERVICE_KEY" ]; then
    say "  ${C_CYAN}${C_BOLD}ℹ  [INFO]${C_RESET}  Service key loaded from $SERVICE container"
  else
    echo -e "  ${C_YELLOW}${C_BOLD}⚠️  [WARN]${C_RESET}  SERVICE_KEY not set in container — service account not authenticated; contact tests may be rate-limited; add SERVICE_KEY to .env"
  fi
fi

# Array form so it expands to nothing when SERVICE_KEY is empty
SKEY_HEADER=()
[ -n "$SERVICE_KEY" ] && SKEY_HEADER=(-H "X-Service-Key: $SERVICE_KEY")

# ── Docker bridge gateway detection (#410) ───────────────────────────────────────
# When curl connects to the host via loopback (e.g. 127.0.0.1:443 on prod),
# Docker's NAT rewrites the source IP before the nginx container sees it, so
# the backend stores the bridge gateway (e.g. 172.20.0.1) rather than loopback.
# Detect it by reading the default route inside the container.
DOCKER_GW=""
if [ -n "$COMPOSE_FILE" ]; then
  DOCKER_GW=$(docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE" \
    sh -c "ip route show default 2>/dev/null | awk '/default/ {print \$3}' | head -1" \
    2>/dev/null | tr -d '\r\n' || true)
  if [ -n "$DOCKER_GW" ]; then
    say "  ${C_CYAN}${C_BOLD}ℹ  [INFO]${C_RESET}  Docker bridge gateway detected: $DOCKER_GW"
  else
    echo -e "  ${C_YELLOW}${C_BOLD}⚠️  [WARN]${C_RESET}  Could not detect Docker bridge gateway — rate-limit reset may be incomplete"
  fi
fi

# ── Helpers ──────────────────────────────────────────────────────────────────────

PASS=0; FAIL=0; SKIP=0
TMPFILE=$(mktemp)
TMPERR=$(mktemp)

# Deletes rate-limit rows for all IPs the regression runner may appear as:
# loopback (127.0.0.1 / ::1 / ::ffff:127.0.0.1), RESOLVE_IP (LAN IP on dev),
# and the Docker bridge gateway (the IP nginx sees when curl connects via
# loopback NAT on prod). Real user counters on other IPs are left intact.
# Called before and after the rate-limit section. Failing open matches the
# rate-limit middleware's own behaviour.
reset_rate_limits() {
  [ -n "$COMPOSE_FILE" ] || return 0
  if docker compose -f "$COMPOSE_FILE" exec -T \
      -e "RESOLVE_IP=${RESOLVE_IP}" \
      -e "DOCKER_GW=${DOCKER_GW}" \
      "$SERVICE" node --input-type=module -e "
    import('./db/pool.js')
      .then(async ({ pool }) => {
        const ips = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
        if (process.env.RESOLVE_IP) ips.push(process.env.RESOLVE_IP);
        if (process.env.DOCKER_GW)  ips.push(process.env.DOCKER_GW);
        await pool.query('DELETE FROM rate_limits WHERE ip = ANY(\$1)', [ips]);
        await pool.end();
      })
      .then(() => process.exit(0))
      .catch((e) => { process.stderr.write(String(e) + '\n'); process.exit(1); });
  " >/dev/null 2>&1; then
    say "  ${C_CYAN}${C_BOLD}ℹ  [INFO]${C_RESET}  Rate-limit counters reset"
  else
    echo -e "  ${C_YELLOW}${C_BOLD}⚠️  [WARN]${C_RESET}  Could not reset rate-limit counters — continuing"
  fi
}

trap 'rm -f "$TMPFILE" "$TMPERR"; reset_rate_limits' EXIT

check() {
  local name="$1" method="$2" url="$3" expect_status="$4" expect_body="${5:-}"
  shift $(( $# >= 5 ? 5 : $# ))
  # remaining args forwarded to curl (e.g. -H, -d)
  local extra=("$@")

  # curl -w prints the HTTP code (000 on connection failure) and exits non-zero
  # on failure; capture the printed code without appending a second one.
  local status
  status=$(curl -s -o "$TMPFILE" -w "%{http_code}" -X "$method" $INSECURE \
    "${RESOLVE_ARGS[@]}" "${extra[@]}" --stderr "$TMPERR" "$url" 2>/dev/null) || true
  [ -z "$status" ] && status="000"
  local body curl_err
  body=$(cat "$TMPFILE" 2>/dev/null || true)
  curl_err=$(cat "$TMPERR" 2>/dev/null | head -1 || true)

  local ok=true
  [ "$status" != "$expect_status" ] && ok=false
  [ -n "$expect_body" ] && [[ "$body" != *"$expect_body"* ]] && ok=false

  if $ok; then
    say "  ${C_GREEN}${C_BOLD}✅ [PASS]${C_RESET}  $name"
    PASS=$((PASS + 1))
  else
    local detail="expected $expect_status got $status"
    if [ "$status" = "000" ] && [ -n "$curl_err" ]; then
      detail="$detail | curl error: $curl_err"
    elif [ -n "$expect_body" ] && [[ "$body" != *"$expect_body"* ]]; then
      detail="$detail | body: $(echo "$body" | head -c 300 | tr -d '\n')"
    elif [ -n "$body" ] && [ "$status" != "$expect_status" ]; then
      detail="$detail | body: $(echo "$body" | head -c 300 | tr -d '\n')"
    fi
    echo -e "  ${C_RED}${C_BOLD}❌ [FAIL]${C_RESET}  $name — ${C_DIM}${detail}${C_RESET}"
    FAIL=$((FAIL + 1))
  fi
}

check_auth() {
  local name="$1" method="$2" url="$3" expect_status="$4" expect_body="${5:-}"
  shift $(( $# >= 5 ? 5 : $# ))
  local extra=("$@")

  if [ -z "$TOKEN" ]; then
    say "  ${C_YELLOW}${C_DIM}⏭  [SKIP]${C_RESET}  $name ${C_DIM}(no token)${C_RESET}"
    SKIP=$((SKIP + 1))
    return
  fi

  check "$name" "$method" "$url" "$expect_status" "$expect_body" \
    -H "Authorization: Bearer $TOKEN" "${extra[@]}"
}

# ── Header ───────────────────────────────────────────────────────────────────────

if [ "$QUIET" != "1" ]; then
  _reg_token_text=$([ -n "$TOKEN" ] && echo 'auto-generated from container' || echo 'not provided — auth tests skipped')
  _reg_skey_text=$([ -n "$SERVICE_KEY" ] && echo 'loaded from container' || echo 'not set — contact tests may be flaky')
  _reg_gw_text=$([ -n "$DOCKER_GW" ] && echo "$DOCKER_GW" || echo 'not detected — reset may be incomplete')
  _print_multi_box "${C_CYAN}${C_BOLD}" 60 \
    "🧪 Regression Test Run — $(date '+%Y-%m-%d %H:%M:%S')" \
    "Base URL    : $BASE_URL" \
    "Token       : $_reg_token_text" \
    "Service key : $_reg_skey_text" \
    "Bridge GW   : $_reg_gw_text"
fi

# ── Rate limiting ────────────────────────────────────────────────────────────────
# Runs first, without the service account header, so the real limiter is exercised
# against an anonymous caller. /api/contact is limited to 3 requests/hour; the limiter
# fires before validation so invalid payloads still increment the counter (no
# emails sent). Targeted reset before (clean window) and after (leave prod clean —
# only loopback IPs deleted, real user counters are untouched).

say "${C_CYAN}${C_BOLD}🔷 ── Rate limiting ─────────────────────────────────────────${C_RESET}"
reset_rate_limits

for n in 1 2 3; do
  check "POST /api/contact #$n within limit returns 400" \
    POST "$BASE_URL/api/contact" 400 "" \
    -H "Content-Type: application/json" \
    -d '{"email":"bad","message":"x"}'
done

check "POST /api/contact #4 over limit returns 429" \
  POST "$BASE_URL/api/contact" 429 "Too many requests" \
  -H "Content-Type: application/json" \
  -d '{"email":"bad","message":"x"}'

reset_rate_limits  # targeted cleanup — loopback rows only

say ""

# ── No-auth baseline ─────────────────────────────────────────────────────────────
# Service key is active for contact checks so they are never rate-limited by prior
# test runs or real traffic sharing the same window.

say "${C_CYAN}${C_BOLD}🔷 ── No-auth baseline ──────────────────────────────────────${C_RESET}"

check "GET /api/posts returns 200" \
  GET "$BASE_URL/api/posts" 200

check "POST /api/contact missing name returns 400" \
  POST "$BASE_URL/api/contact" 400 "" \
  "${SKEY_HEADER[@]}" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","message":"hello"}'

check "POST /api/contact invalid email returns 400" \
  POST "$BASE_URL/api/contact" 400 "" \
  "${SKEY_HEADER[@]}" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","email":"not-an-email","message":"hello"}'

check "GET /api/travel returns 200" \
  GET "$BASE_URL/api/travel" 200

check "GET /api/cv/exists returns 200 with exists field" \
  GET "$BASE_URL/api/cv/exists" 200 "exists"

check "POST /api/stats/visit?page=unknown returns 400" \
  POST "$BASE_URL/api/stats/visit?page=unknown" 400

check "Unknown route returns 404" \
  GET "$BASE_URL/api/does-not-exist" 404

# CORS: a browser at the canonical site host omits the non-standard port from
# the Origin header (e.g. https://dev.andykeys.me, not :3001). The backend must
# allow it via its SITE_HOST check. This is the exact failure from #357 —
# SITE_HOST was undefined in the container and every such origin was rejected
# with a 500. Derive the host from BASE_URL and assert the request is NOT
# rejected. Use /api/health (read-only, no DB write) rather than /api/debug/errors
# so the smoke test doesn't pollute the error log and trigger false alerts.
CORS_HOST="${BASE_URL#*://}"   # strip scheme
CORS_HOST="${CORS_HOST%%/*}"   # strip any path
CORS_HOST="${CORS_HOST%%:*}"   # strip port → bare hostname
check "GET /api/health with site-host Origin is not CORS-rejected" \
  GET "$BASE_URL/api/health" 200 "ok" \
  -H "Origin: https://${CORS_HOST}"

say ""

# ── Auth gating (protected routes must reject anonymous requests) ─────────────────
# One cheap request each — catches the worst regression: a protected mutating
# route going public. No token sent; all must be 401.

say "${C_CYAN}${C_BOLD}🔷 ── Auth gating ───────────────────────────────────────────${C_RESET}"

check "GET /api/deploy/status without auth returns 401" \
  GET "$BASE_URL/api/deploy/status" 401

check "POST /api/upload without auth returns 401" \
  POST "$BASE_URL/api/upload" 401

check "DELETE /api/posts/1 without auth returns 401" \
  DELETE "$BASE_URL/api/posts/1" 401

check "DELETE /api/travel/1 without auth returns 401" \
  DELETE "$BASE_URL/api/travel/1" 401

say ""

# ── Auth-required baseline ────────────────────────────────────────────────────────

say "${C_CYAN}${C_BOLD}🔷 ── Auth-required baseline ────────────────────────────────${C_RESET}"

check_auth "POST /api/posts missing title returns 400" \
  POST "$BASE_URL/api/posts" 400 "" \
  -H "Content-Type: application/json" \
  -d '{"body_markdown":"test","post_date":"2026-01-01","post_type":"blog"}'

check_auth "POST /api/posts invalid date format returns 400" \
  POST "$BASE_URL/api/posts" 400 "" \
  -H "Content-Type: application/json" \
  -d '{"title":"test","body_markdown":"test","post_date":"not-a-date","post_type":"blog"}'

check_auth "POST /api/travel missing title returns 400" \
  POST "$BASE_URL/api/travel" 400 "" \
  -H "Content-Type: application/json" \
  -d '{"location":"Test","visit_date":"2026-01-01"}'

check_auth "GET /api/stats/visits with auth returns 200" \
  GET "$BASE_URL/api/stats/visits" 200 "["

check "GET /api/stats/visits without auth returns 401" \
  GET "$BASE_URL/api/stats/visits" 401

say ""

# ── Summary ───────────────────────────────────────────────────────────────────────

TOTAL=$((PASS + FAIL + SKIP))
STATUS=$([ "$FAIL" -eq 0 ] && echo "OK" || echo "FAIL")

if [ "$FAIL" -eq 0 ]; then
  RESULT_COLOUR="${C_GREEN}${C_BOLD}"
  RESULT_ICON="✅"
else
  RESULT_COLOUR="${C_RED}${C_BOLD}"
  RESULT_ICON="❌"
fi

_res_content_w=60
_res_title="${RESULT_ICON} Regression Results — ${STATUS}"
_res_title_w=$(_visual_width "$_res_title")
_res_title_pad=$(( _res_content_w - _res_title_w ))  # leading 2 spaces already in format string
_res_border=$(printf '═%.0s' $(seq 1 $(( _res_content_w + 2 ))))
echo ""
echo -e "${RESULT_COLOUR}╔${_res_border}╗${_OUT_RESET}"
printf "${RESULT_COLOUR}║  %s%*s║${_OUT_RESET}\n" "$_res_title" "$_res_title_pad" ""
echo -e "${RESULT_COLOUR}╠${_res_border}╣${_OUT_RESET}"
printf "${RESULT_COLOUR}║  %-${_res_content_w}s║${_OUT_RESET}\n" "Passed : $PASS / $TOTAL"
[ "$SKIP" -gt 0 ] && printf "${C_YELLOW}${C_BOLD}║  %-${_res_content_w}s║${_OUT_RESET}\n" "Skipped: $SKIP"
[ "$FAIL" -gt 0 ] && printf "${C_RED}${C_BOLD}║  %-${_res_content_w}s║${_OUT_RESET}\n" "Failed : $FAIL"
echo -e "${RESULT_COLOUR}╚${_res_border}╝${C_RESET}"
echo ""

# Machine-readable summary line — parsed by print_deploy_report, no colour codes
echo "[regression] status=${STATUS} passed=${PASS} failed=${FAIL} skipped=${SKIP} total=${TOTAL} url=${BASE_URL}"

[ "$FAIL" -eq 0 ]
