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
    echo "  [INFO] JWT generated from $SERVICE container (1h expiry)"
  else
    echo "  [WARN] Could not generate JWT — auth tests will be skipped"
  fi
fi

# ── Helpers ──────────────────────────────────────────────────────────────────────

PASS=0; FAIL=0; SKIP=0
TMPFILE=$(mktemp)
TMPERR=$(mktemp)
trap 'rm -f "$TMPFILE" "$TMPERR"' EXIT

check() {
  local name="$1" method="$2" url="$3" expect_status="$4"
  local expect_body="${5:-}"
  shift 5
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
    echo "  [PASS] $name"
    PASS=$((PASS + 1))
  else
    local detail="Expected $expect_status got $status"
    if [ "$status" = "000" ] && [ -n "$curl_err" ]; then
      detail="$detail | curl error: $curl_err"
    elif [ -n "$expect_body" ] && [[ "$body" != *"$expect_body"* ]]; then
      detail="$detail | body: $(echo "$body" | head -c 300 | tr -d '\n')"
    elif [ -n "$body" ] && [ "$status" != "$expect_status" ]; then
      detail="$detail | body: $(echo "$body" | head -c 300 | tr -d '\n')"
    fi
    echo "  [FAIL] $name — $detail"
    FAIL=$((FAIL + 1))
  fi
}

check_auth() {
  local name="$1" method="$2" url="$3" expect_status="$4"
  local expect_body="${5:-}"
  shift 5
  local extra=("$@")

  if [ -z "$TOKEN" ]; then
    echo "  [SKIP] $name (no token)"
    SKIP=$((SKIP + 1))
    return
  fi

  check "$name" "$method" "$url" "$expect_status" "$expect_body" \
    -H "Authorization: Bearer $TOKEN" "${extra[@]}"
}

# ── Header ───────────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  Regression Test Run — $(date '+%Y-%m-%d %H:%M:%S')"
echo "  Base URL : $BASE_URL"
echo "  Token    : $([ -n "$TOKEN" ] && echo 'auto-generated from container' || echo 'not provided — auth tests skipped')"
echo "════════════════════════════════════════════════════════════"
echo ""

# ── No-auth baseline ─────────────────────────────────────────────────────────────

echo "--- No-auth baseline ---"

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

echo "--- Auth-required baseline ---"

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

echo "════════════════════════════════════════════════════════════"
printf "  PASSED : %s\n" "$PASS"
[ "$SKIP" -gt 0 ] && printf "  SKIPPED: %s\n" "$SKIP"
printf "  FAILED : %s\n" "$FAIL"
echo "════════════════════════════════════════════════════════════"
echo ""

# Machine-readable summary line — easy to grep in CI logs or deploy output
echo "[regression] status=${STATUS} passed=${PASS} failed=${FAIL} skipped=${SKIP} total=${TOTAL} url=${BASE_URL}"

[ "$FAIL" -eq 0 ]
