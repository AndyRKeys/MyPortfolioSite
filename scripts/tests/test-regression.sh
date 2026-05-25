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
RESET_RL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)           BASE_URL="$2";      shift 2 ;;
    --token)              TOKEN="$2";         shift 2 ;;
    --compose-file)       COMPOSE_FILE="$2";  shift 2 ;;
    --service)            SERVICE="$2";       shift 2 ;;
    --insecure)           INSECURE="-k";      shift   ;;
    --resolve)            RESOLVE="$2";       shift 2 ;;
    --reset-rate-limits)  RESET_RL=1;         shift   ;;
    *) shift ;;
  esac
done

# Build curl --resolve args so the request connects to a reachable address
# (e.g. the LAN IP) while keeping the original Host/SNI for cert + routing.
# Needed because the server cannot route to its own public DNS name (no NAT
# hairpin), but the deploy must still test via the real hostname.
RESOLVE_ARGS=()
if [ -n "$RESOLVE" ]; then
  RESOLVE_ARGS=(--resolve "$RESOLVE")
fi

if [ -z "$BASE_URL" ]; then
  echo "Usage: $0 --base-url <url> --compose-file <file> [--service <name>] [--insecure]" >&2
  exit 1
fi

# ── JWT auto-generation ──────────────────────────────────────────────────────────

if [ -z "$TOKEN" ] && [ -n "$COMPOSE_FILE" ]; then
  TOKEN=$(docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE" node -e "
    const jwt = require('jsonwebtoken');
    if (!process.env.JWT_SECRET) { process.stderr.write('NO_SECRET\n'); process.exit(1); }
    console.log(jwt.sign({ userId: 'regression-test' }, process.env.JWT_SECRET, { expiresIn: '1h' }));
  " 2>/dev/null | grep '^eyJ' | tail -1 || true)
  if [ -n "$TOKEN" ]; then
    say "  ${C_CYAN}${C_BOLD}ℹ  [INFO]${C_RESET}  JWT generated from $SERVICE container (1h expiry)"
  else
    echo -e "  ${C_YELLOW}${C_BOLD}⚠️  [WARN]${C_RESET}  Could not generate JWT — auth tests will be skipped"
  fi
fi

# ── Helpers ──────────────────────────────────────────────────────────────────────

PASS=0; FAIL=0; SKIP=0
TMPFILE=$(mktemp)
TMPERR=$(mktemp)

# Best-effort reset of the DB-backed rate-limit counters via the backend
# container's own pool (same mechanism as JWT generation). Dev-only — never
# called for prod, where clearing real visitors' counters is undesirable.
# Failing open (warn + continue) matches the rate-limit middleware itself.
reset_rate_limits() {
  [ "$RESET_RL" = "1" ] || return 0
  [ -n "$COMPOSE_FILE" ] || return 0
  if docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE" node -e "
    import('./db/pool.js')
      .then(async ({ pool }) => { await pool.query('DELETE FROM rate_limits'); await pool.end(); })
      .then(() => process.exit(0))
      .catch((e) => { process.stderr.write(String(e) + '\n'); process.exit(1); });
  " >/dev/null 2>&1; then
    say "  ${C_CYAN}${C_BOLD}ℹ  [INFO]${C_RESET}  Rate-limit counters reset (dev)"
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
  _print_multi_box "${C_CYAN}${C_BOLD}" 60 \
    "🧪 Regression Test Run — $(date '+%Y-%m-%d %H:%M:%S')" \
    "Base URL : $BASE_URL" \
    "Token    : $_reg_token_text"
fi

# Clean slate so contact validation checks aren't tripped by counters left
# over from earlier deploys within the rate-limit window (dev only).
reset_rate_limits

# ── No-auth baseline ─────────────────────────────────────────────────────────────

say "${C_CYAN}${C_BOLD}🔷 ── No-auth baseline ──────────────────────────────────────${C_RESET}"

check "GET /api/posts returns 200" \
  GET "$BASE_URL/api/posts" 200

check "POST /api/contact missing name returns 400" \
  POST "$BASE_URL/api/contact" 400 "" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","message":"hello"}'

check "POST /api/contact invalid email returns 400" \
  POST "$BASE_URL/api/contact" 400 "" \
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
# with a 500. Derive the host from BASE_URL and assert the POST is NOT rejected.
CORS_HOST="${BASE_URL#*://}"   # strip scheme
CORS_HOST="${CORS_HOST%%/*}"   # strip any path
CORS_HOST="${CORS_HOST%%:*}"   # strip port → bare hostname
check "POST /api/debug/errors with site-host Origin is not CORS-rejected" \
  POST "$BASE_URL/api/debug/errors" 200 "received" \
  -H "Origin: https://${CORS_HOST}" \
  -H "Content-Type: application/json" \
  -d '{"type":"smoke-test","message":"cors check"}'

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

# ── Rate limiting (dev only) ──────────────────────────────────────────────────────
# /api/contact is limited to 3 requests/hour. The limiter runs BEFORE validation,
# so invalid payloads still increment the counter (no emails sent). Reset first
# for a deterministic window, then prove the 4th request is blocked with 429.
# Gated on --reset-rate-limits so it only runs where we can reset (dev).

if [ "$RESET_RL" = "1" ]; then
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

  say ""
fi

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
