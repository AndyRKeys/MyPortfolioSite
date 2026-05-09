#!/bin/bash

# Security debugging report for local dev environment.
# Run from repo root against a running local Docker stack.
# Usage: bash scripts/ops/security-debug-report.sh [host]
# Default host: http://localhost

HOST="${1:-http://localhost}"

PASS=0
FAIL=0
WARN=0

green()  { echo -e "\033[0;32m✓  $*\033[0m"; ((PASS++)); }
red()    { echo -e "\033[0;31m✗  $*\033[0m"; ((FAIL++)); }
yellow() { echo -e "\033[1;33m⚠  $*\033[0m"; ((WARN++)); }
section(){ echo ""; echo "──────────────────────────────────────────────"; echo "  $*"; echo "──────────────────────────────────────────────"; }

echo "╔══════════════════════════════════════════════╗"
echo "║  SECURITY DEBUG REPORT                       ║"
echo "║  Target: $HOST"
echo "╚══════════════════════════════════════════════╝"

# ── Fetch headers from each page ──────────────────────────────────────────────
section "1. HTTP Response Headers"

HEADERS=$(curl -sI "$HOST/" 2>/dev/null)
if [ -z "$HEADERS" ]; then
  red "Cannot reach $HOST — is Docker running? (docker compose up)"
  exit 1
fi

check_header() {
  local name="$1"
  local value
  value=$(echo "$HEADERS" | grep -i "^$name:" | head -1)
  if [ -n "$value" ]; then
    green "$value"
  else
    red "MISSING: $name"
  fi
}

check_header "Content-Security-Policy"
check_header "X-Content-Type-Options"
check_header "X-Frame-Options"
check_header "Referrer-Policy"
check_header "Permissions-Policy"

HSTS=$(echo "$HEADERS" | grep -i "Strict-Transport-Security")
if [ -n "$HSTS" ]; then
  green "$HSTS"
else
  yellow "MISSING: Strict-Transport-Security (expected on HTTP dev, required on prod HTTPS)"
fi

# ── Parse CSP and check against known external resources ─────────────────────
section "2. CSP vs External Resources"

CSP=$(echo "$HEADERS" | grep -i "Content-Security-Policy:" | sed 's/.*Content-Security-Policy: //i' | tr -d '\r')
if [ -z "$CSP" ]; then
  red "No CSP header found — skipping CSP checks"
else
  echo "CSP: $CSP"
  echo ""

  # Build list of external resources used in HTML files
  echo "External resources found in HTML files:"
  EXTERNALS=$(grep -rh 'src="https://\|href="https://' *.html 2>/dev/null \
    | grep -oE 'https://[^"]+' \
    | sed 's|/[^/]*$||' \
    | sort -u)

  while IFS= read -r url; do
    domain=$(echo "$url" | grep -oE 'https://[^/]+')
    directive=""
    # Determine which CSP directive applies
    case "$url" in
      *.js) directive="script-src" ;;
      *.css) directive="style-src" ;;
      *fonts.googleapis.com*|*fonts.gstatic.com*) directive="font-src / style-src" ;;
      *) directive="default-src" ;;
    esac

    if echo "$CSP" | grep -q "$domain"; then
      green "$domain — whitelisted in CSP ($directive)"
    else
      red "$domain — NOT in CSP ($directive) → WILL BE BLOCKED"
    fi
  done <<< "$EXTERNALS"
fi

# ── Check each page for inline scripts ───────────────────────────────────────
section "3. Inline Scripts (blocked by CSP unless 'unsafe-inline')"

for html in *.html; do
  inline_count=$(grep -c "<script>" "$html" 2>/dev/null || echo 0)
  if [ "$inline_count" -gt 0 ]; then
    red "$html: $inline_count inline <script> block(s) — blocked unless CSP has 'unsafe-inline'"
  else
    green "$html: no inline scripts"
  fi
done

# ── Check backend API headers ─────────────────────────────────────────────────
section "4. Backend API Headers (/api/health)"

API_HEADERS=$(curl -sI "$HOST/api/health" 2>/dev/null)
if [ -n "$API_HEADERS" ]; then
  STATUS=$(echo "$API_HEADERS" | head -1)
  green "Backend reachable: $STATUS"

  CORS=$(echo "$API_HEADERS" | grep -i "Access-Control-Allow-Origin")
  if [ -n "$CORS" ]; then
    if echo "$CORS" | grep -q "\*"; then
      yellow "CORS: $CORS — wildcard origin (fine for dev, check prod)"
    else
      green "CORS: $CORS"
    fi
  else
    yellow "No CORS headers on /api/health (may be fine if same-origin)"
  fi
else
  red "Backend /api/health not reachable"
fi

# ── Check for mixed content ───────────────────────────────────────────────────
section "5. Mixed Content Check (http:// resources in HTML)"

MIXED=$(grep -rh 'src="http://\|href="http://' *.html 2>/dev/null | grep -v "localhost\|127.0.0.1")
if [ -n "$MIXED" ]; then
  red "Mixed content found (http:// external resources):"
  echo "$MIXED"
else
  green "No mixed content found"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
section "Summary"
echo ""
echo "  Pass:     $PASS"
echo "  Fail:     $FAIL"
echo "  Warnings: $WARN"
echo ""

if [ $FAIL -gt 0 ]; then
  echo -e "\033[0;31m✗ Security issues found — review failures above\033[0m"
  exit 1
else
  echo -e "\033[0;32m✓ No critical security issues found\033[0m"
  if [ $WARN -gt 0 ]; then
    echo -e "\033[1;33m⚠ Review warnings above\033[0m"
  fi
  exit 0
fi
