#!/usr/bin/env bash
# Regression smoke tests — runs on the server post-deploy.
# Covers stable HTTP checks that should pass on every deploy.
#
# Usage:
#   bash scripts/tests/test-regression.sh \
#     --base-url https://dev.andykeys.me:3001 \
#     --compose-file /path/to/docker-compose.yml \
#     --service backend-dev \
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

# ── Args ────────────────────────────────────────────────────────────────────────

BASE_URL=""
TOKEN=""
COMPOSE_FILE=""
SERVICE="backend"
INSECURE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)      BASE_URL="$2";      shift 2 ;;
    --token)         TOKEN="$2";         shift 2 ;;
    --compose-file)  COMPOSE_FILE="$2";  shift 2 ;;
    --service)       SERVICE="$2";       shift 2 ;;
    --insecure)      INSECURE="-k";      shift   ;;
    *) shift ;;
  esac
done

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
    echo -e "  ${C_CYAN}${C_BOLD}ℹ  [INFO]${C_RESET}  JWT generated from $SERVICE container (1h expiry)"
  else
    echo -e "  ${C_YELLOW}${C_BOLD}⚠️  [WARN]${C_RESET}  Could not generate JWT — auth tests will be skipped"
  fi
fi

# ── Helpers ──────────────────────────────────────────────────────────────────────

PASS=0; FAIL=0; SKIP=0
TMPFILE=$(mktemp)
TMPERR=$(mktemp)
trap 'rm -f "$TMPFILE" "$TMPERR"' EXIT

check() {
  local name="$1" method="$2" url="$3" expect_status="$4" expect_body="${5:-}"
  shift $(( $# >= 5 ? 5 : $# ))
  # remaining args forwarded to curl (e.g. -H, -d)
  local extra=("$@")

  local status
  status=$(curl -s -o "$TMPFILE" -w "%{http_code}" -X "$method" $INSECURE "${extra[@]}" \
    --stderr "$TMPERR" "$url" || echo "000")
  local body curl_err
  body=$(cat "$TMPFILE" 2>/dev/null || true)
  curl_err=$(cat "$TMPERR" 2>/dev/null | head -1 || true)

  local ok=true
  [ "$status" != "$expect_status" ] && ok=false
  [ -n "$expect_body" ] && [[ "$body" != *"$expect_body"* ]] && ok=false

  if $ok; then
    echo -e "  ${C_GREEN}${C_BOLD}✅ [PASS]${C_RESET}  $name"
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
    echo -e "  ${C_YELLOW}${C_DIM}⏭  [SKIP]${C_RESET}  $name ${C_DIM}(no token)${C_RESET}"
    SKIP=$((SKIP + 1))
    return
  fi

  check "$name" "$method" "$url" "$expect_status" "$expect_body" \
    -H "Authorization: Bearer $TOKEN" "${extra[@]}"
}

# ── Header ───────────────────────────────────────────────────────────────────────

echo ""
echo -e "${C_CYAN}${C_BOLD}╔════════════════════════════════════════════════════════════╗${C_RESET}"
echo -e "${C_CYAN}${C_BOLD}║  🧪 Regression Test Run — $(date '+%Y-%m-%d %H:%M:%S')  ║${C_RESET}"
printf "${C_CYAN}${C_BOLD}║  %-60s║${C_RESET}\n" "Base URL : $BASE_URL"
printf "${C_CYAN}${C_BOLD}║  %-60s║${C_RESET}\n" "Token    : $([ -n "$TOKEN" ] && echo 'auto-generated from container' || echo 'not provided — auth tests skipped')"
echo -e "${C_CYAN}${C_BOLD}╚════════════════════════════════════════════════════════════╝${C_RESET}"
echo ""

# ── No-auth baseline ─────────────────────────────────────────────────────────────

echo -e "${C_CYAN}${C_BOLD}🔷 ── No-auth baseline ──────────────────────────────────────${C_RESET}"

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

check "GET /api/cv/exists returns 200 with exists field" \
  GET "$BASE_URL/api/cv/exists" 200 "exists"

check "POST /api/stats/visit?page=unknown returns 400" \
  POST "$BASE_URL/api/stats/visit?page=unknown" 400

check "GET /api/health returns 200 with status ok" \
  GET "$BASE_URL/api/health" 200 "ok"

check "Unknown route returns 404" \
  GET "$BASE_URL/api/does-not-exist" 404

echo ""

# ── Auth-required baseline ────────────────────────────────────────────────────────

echo -e "${C_CYAN}${C_BOLD}🔷 ── Auth-required baseline ────────────────────────────────${C_RESET}"

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
  GET "$BASE_URL/api/stats/visits" 200 "count"

check "GET /api/stats/visits without auth returns 401" \
  GET "$BASE_URL/api/stats/visits" 401

echo ""

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

echo ""
echo -e "${RESULT_COLOUR}╔════════════════════════════════════════════════════════════╗${C_RESET}"
echo -e "${RESULT_COLOUR}║  ${RESULT_ICON} Regression Results — ${STATUS}$(printf '%*s' $((36 - ${#STATUS})) '')║${C_RESET}"
echo -e "${RESULT_COLOUR}╠════════════════════════════════════════════════════════════╣${C_RESET}"
printf "${RESULT_COLOUR}║  %-60s║${C_RESET}\n" "Passed : $PASS / $TOTAL"
[ "$SKIP" -gt 0 ] && printf "${C_YELLOW}${C_BOLD}║  %-60s║${C_RESET}\n" "Skipped: $SKIP"
[ "$FAIL" -gt 0 ] && printf "${C_RED}${C_BOLD}║  %-60s║${C_RESET}\n" "Failed : $FAIL"
echo -e "${RESULT_COLOUR}╚════════════════════════════════════════════════════════════╝${C_RESET}"
echo ""

# Machine-readable summary line — parsed by print_deploy_report, no colour codes
echo "[regression] status=${STATUS} passed=${PASS} failed=${FAIL} skipped=${SKIP} total=${TOTAL} url=${BASE_URL}"

[ "$FAIL" -eq 0 ]
