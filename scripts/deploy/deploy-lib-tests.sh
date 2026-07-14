#!/usr/bin/env bash
# This file is sourced by deploy-lib.sh — do not execute directly.
# set -euo pipefail is inherited from the parent shell.

# _run_browser_test <npm-script> <log-prefix> [extra dc exec flags...]
# Runs: dc exec -T [extra flags] $BACKEND_SERVICE npm run <npm-script> -- $NGINX_URL
# Sets globals: BROWSER_TEST_RC=0|N, BROWSER_TEST_SLINE=<matched summary line>
# Logs test output to LOG_FILE on failure. Returns BROWSER_TEST_RC.
_run_browser_test() {
  local npm_script="$1" log_prefix="$2"
  shift 2
  BROWSER_TEST_RC=0
  BROWSER_TEST_SLINE=""
  local test_output
  if test_output=$(dc exec -T "$@" "$BACKEND_SERVICE" \
      npm run "$npm_script" -- "${NGINX_URL}" 2>&1); then
    BROWSER_TEST_RC=0
  else
    BROWSER_TEST_RC=$?
  fi
  BROWSER_TEST_SLINE=$(printf '%s\n' "$test_output" | grep -E "^\[${log_prefix}\]" | tail -1 || true)
  if [ "$BROWSER_TEST_RC" -ne 0 ]; then
    printf '%s\n' "$test_output" | tee -a "$LOG_FILE"
  fi
  return "$BROWSER_TEST_RC"
}

# Run the backend Vitest suite inside the already-running container.
# Runs after health check so tests execute against the live deployed service.
# Non-zero exit triggers rollback — same path as a failed health check.
run_deploy_tests() {
  local service_name="$1"   # e.g. backend or backend-dev

  dsection "Phase 7: Backend tests — Vitest (unit + integration)"
  dinfo "Executing npm test inside $service_name container..."

  # Run with the default reporter (human-readable log) AND the json reporter
  # (authoritative counts written to a file inside the container). Scraping the
  # pretty "Tests N passed (N)" summary proved fragile across environments — the
  # json report is immune to ANSI/format drift. `if`-capture keeps set -e from
  # aborting before we record the exit code.
  local report_path='/tmp/vitest-deploy-report.json'
  local out rc total passed failed counts
  if out=$(dc exec -T "$service_name" \
            npm test -- --reporter=default --reporter=json \
            --outputFile.json="$report_path" 2>&1); then rc=0; else rc=$?; fi
  printf '%s\n' "$out" | _log_cmd

  # Read counts back from the json report in the same (persistent) container.
  # Falls back to "0 0 0" if the file is missing/unreadable so a parse failure
  # never aborts the deploy on its own.
  counts=$(dc exec -T "$service_name" node -e \
    'try{const r=require(process.argv[1]);process.stdout.write(`${r.numTotalTests||0} ${r.numPassedTests||0} ${r.numFailedTests||0}`)}catch(e){process.stdout.write("0 0 0")}' \
    "$report_path" 2>/dev/null || true)
  read -r total passed failed <<<"${counts:-0 0 0}" || true
  total=${total:-0}; passed=${passed:-0}; failed=${failed:-0}

  if [ "$rc" -eq 0 ]; then
    dstatus vitest suite=backend status=ok tests="$total" passed="$passed" failed="$failed"
    dok "Backend tests passed — ${passed}/${total} ✓"
  else
    dstatus vitest suite=backend status=failed tests="$total" passed="$passed" failed="$failed"
    dfail "Backend tests failed (${failed} failed of ${total}) — initiating rollback"
    _do_rollback "test suite failed post-deploy"
    ddie "Deploy failed: tests did not pass. See log at $LOG_FILE"
  fi
}

test_error_logger_all_pages() {
  dsection "Frontend tests — error-logger present on all pages (Playwright: Chromium + Firefox)"

  # NGINX_URL must be the docker-internal nginx address (e.g. https://nginx:3001)
  # so that Playwright, running inside the backend container, can reach nginx.
  local base_url="${NGINX_URL:-}"
  if [ -z "$base_url" ]; then
    dwarn "NGINX_URL not set — skipping error logger test"
    dstatus error-logger suite=frontend status=skipped reason=no-nginx-url
    return
  fi

  dinfo "Running comprehensive page coverage test (Playwright, Chromium + Firefox)..."
  dinfo "  Testing all pages for error-logger deployment"

  local passed failed total
  _run_browser_test "test:error-logger:all-pages" "error-logger-all-pages" || true
  passed=$(_kv_num "$BROWSER_TEST_SLINE" passed); failed=$(_kv_num "$BROWSER_TEST_SLINE" failed); total=$(_kv_num "$BROWSER_TEST_SLINE" total)
  if [ "$BROWSER_TEST_RC" -eq 0 ]; then
    dstatus error-logger suite=frontend status=ok tests="${total:-0}" passed="${passed:-0}" failed="${failed:-0}"
    dok "Frontend error-logger pages test passed — ${passed:-0}/${total:-0} ✓"
  else
    dstatus error-logger suite=frontend status=failed tests="${total:-0}" passed="${passed:-0}" failed="${failed:-0}"
    dwarn "Frontend error-logger pages test failed — output above"
  fi
}

# Verify the deployed error-logger.js behavioural contracts against the live
# site: resource-load capture (#332), no runtime-error duplication, localStorage
# buffering + drain when the backend is unreachable (#334), and recursion safety
# under an error storm (#331). Uses Puppeteer request interception to simulate
# the backend being up/down without actually taking it down.
#
# Warn-only (matches test_error_logger_all_pages) — a frontend contract
# regression is surfaced loudly inline but does not roll back the deploy.
test_error_logger_contracts() {
  dsection "Frontend tests — error-logger behavioural contracts (browser)"

  local base_url="${NGINX_URL:-}"
  if [ -z "$base_url" ]; then
    dwarn "NGINX_URL not set — skipping error logger contract test"
    dstatus error-logger-contracts suite=frontend status=skipped reason=no-nginx-url
    return
  fi

  dinfo "Running contract test (capture, buffering, recursion safety)..."

  local passed failed total
  _run_browser_test "test:error-logger:browser" "error-logger-browser" || true
  passed=$(_kv_num "$BROWSER_TEST_SLINE" passed); failed=$(_kv_num "$BROWSER_TEST_SLINE" failed)
  total=$(( ${passed:-0} + ${failed:-0} ))
  if [ "$BROWSER_TEST_RC" -eq 0 ]; then
    dstatus error-logger-contracts suite=frontend status=ok tests="$total" passed="${passed:-0}" failed="${failed:-0}"
    dok "Frontend error-logger contracts passed — ${passed:-0}/${total} ✓"
  else
    dstatus error-logger-contracts suite=frontend status=failed tests="$total" passed="${passed:-0}" failed="${failed:-0}"
    dwarn "Frontend error-logger contracts failed — output above"
  fi
}

# Load every public page in a real browser and fail if any unhandled JS
# exception fires (null dereferences, failed imports, etc.). Catches the class
# of errors invisible to curl-based smoke tests — first caught during #389
# (jQuery removal), where page JS errors weren't surfaced until a browser ran.
# Warn-only — surfaces loudly but does not roll back the deploy.
check_public_page_js() {
  dsection "Frontend tests — public pages JS runtime errors (#390) (Playwright: Chromium + Firefox)"

  local base_url="${NGINX_URL:-}"
  if [ -z "$base_url" ]; then
    dwarn "NGINX_URL not set — skipping public page JS runtime check"
    dstatus public-pages suite=frontend status=skipped reason=no-nginx-url
    return
  fi

  dinfo "Loading public pages in Playwright (Chromium + Firefox) to check for unhandled JS errors..."

  local passed failed total
  _run_browser_test "test:public-pages" "public-pages" || true
  passed=$(_kv_num "$BROWSER_TEST_SLINE" passed); failed=$(_kv_num "$BROWSER_TEST_SLINE" failed); total=$(_kv_num "$BROWSER_TEST_SLINE" total)
  if [ "$BROWSER_TEST_RC" -eq 0 ]; then
    dstatus public-pages suite=frontend status=ok tests="${total:-0}" passed="${passed:-0}" failed="${failed:-0}"
    dok "Public pages JS check passed — ${passed:-0}/${total:-0} ✓"
  else
    dstatus public-pages suite=frontend status=failed tests="${total:-0}" passed="${passed:-0}" failed="${failed:-0}"
    dwarn "JS runtime errors detected on public pages — see output above"
  fi
}

# Load every served page in a real browser and listen for securitypolicyviolation
# events. Filters known ISP-injected noise and flags any blocked resource that
# indicates a missing or stale CSP allowlist entry. Runs inside the backend
# container (Chromium available) using NGINX_URL (docker-internal address) so
# Puppeteer can reach nginx directly.
# Warn-only — violations are surfaced loudly but do not roll back the deploy.
check_csp_violations() {
  dsection "Frontend scans — CSP violations across pages (#341)"

  local base_url="${NGINX_URL:-}"
  if [ -z "$base_url" ]; then
    dwarn "NGINX_URL not set — skipping CSP violation scan"
    dstatus csp-violations suite=frontend status=skipped reason=no-nginx-url
    return
  fi

  dinfo "Loading all pages in headless browser to detect CSP violations..."

  # Scan metric is pages/violations (a violation isn't a 1:1 test), so report
  # those native counts rather than forcing pass/fail semantics.
  local pages violations
  _run_browser_test "test:csp-violations" "csp-violations" || true
  pages=$(_kv_num "$BROWSER_TEST_SLINE" pages); violations=$(_kv_num "$BROWSER_TEST_SLINE" violations)
  if [ "$BROWSER_TEST_RC" -eq 0 ]; then
    dstatus csp-violations suite=frontend status=ok pages="${pages:-0}" violations="${violations:-0}"
    dok "CSP scan passed — ${pages:-0} pages, no first-party violations ✓"
  else
    dstatus csp-violations suite=frontend status=failed pages="${pages:-0}" violations="${violations:-0}"
    dwarn "CSP violations detected — update nginx-security-headers.conf and re-deploy"
  fi
}

# Drives the admin panel as an authenticated session and triggers all
# interactions that call external origins (Nominatim forward/reverse geocoding).
# Mints a JWT from JWT_SECRET — same technique as the regression suite — and
# injects it into localStorage.adminToken so the admin page is fully authed
# without a passkey ceremony. Listens for securitypolicyviolation events and
# fails if any first-party violation fires.
# Warn-only — a failure is surfaced in the deploy report but does not roll back.
check_admin_e2e_csp() {
  dsection "Frontend scans — authenticated admin E2E CSP (#342)"

  local base_url="${NGINX_URL:-}"
  if [ -z "$base_url" ]; then
    dwarn "NGINX_URL not set — skipping admin E2E CSP scan"
    dstatus admin-e2e-csp suite=frontend status=skipped reason=no-nginx-url
    return
  fi

  dinfo "Running authenticated admin interactions to detect CSP violations..."

  # Scan metric is interactions/violations — report those native counts.
  local interactions violations
  _run_browser_test "test:admin-e2e-csp" "admin-e2e-csp" -e "JWT_SECRET=${JWT_SECRET:-}" || true
  interactions=$(_kv_num "$BROWSER_TEST_SLINE" interactions); violations=$(_kv_num "$BROWSER_TEST_SLINE" violations)
  if [ "$BROWSER_TEST_RC" -eq 0 ]; then
    dstatus admin-e2e-csp suite=frontend status=ok interactions="${interactions:-0}" violations="${violations:-0}"
    dok "Admin E2E CSP scan passed — ${interactions:-0} interactions, no violations ✓"
  else
    dstatus admin-e2e-csp suite=frontend status=failed interactions="${interactions:-0}" violations="${violations:-0}"
    _do_rollback "CSP violations detected in admin interactions"
    ddie "Deploy failed: CSP violations detected — update nginx-security-headers.conf. See log at $LOG_FILE"
  fi
}

check_admin_e2e() {
  dsection "Frontend tests — admin E2E smoke + interactions (hard fail)"

  local base_url="${NGINX_URL:-}"
  if [ -z "$base_url" ]; then
    dwarn "NGINX_URL not set — skipping admin E2E tests"
    dstatus admin-e2e suite=frontend status=skipped reason=no-nginx-url
    return
  fi

  dinfo "Running admin E2E smoke and interaction tests..."

  local smoke interactions
  _run_browser_test "test:admin-e2e" "admin-e2e" -e "JWT_SECRET=${JWT_SECRET:-}" || true
  smoke=$(_kv_str "$BROWSER_TEST_SLINE" smoke); interactions=$(_kv_str "$BROWSER_TEST_SLINE" interactions)
  if [ "$BROWSER_TEST_RC" -eq 0 ]; then
    dstatus admin-e2e suite=frontend status=ok smoke="${smoke:-?}" interactions="${interactions:-?}"
    dok "Admin E2E passed — smoke ${smoke:-?}, interactions ${interactions:-?} ✓"
  else
    dstatus admin-e2e suite=frontend status=failed smoke="${smoke:-?}" interactions="${interactions:-?}"
    _do_rollback "admin E2E tests failed — admin panel non-functional"
    ddie "Deploy failed: admin E2E tests did not pass. See log at $LOG_FILE"
  fi
}

test_csp_reporting() {
  dsection "Testing CSP violation reporting"

  # SITE_URL must be the external nginx URL (e.g. https://dev.andykeys.me:3001)
  # so curl reaches nginx and checks the real CSP headers.
  local test_url="${SITE_URL:-}"
  if [ -z "$test_url" ]; then
    dwarn "SITE_URL not set — skipping CSP test"
    dstatus csp status=skipped reason=no-site-url
    return
  fi

  dinfo "CSP report-uri configured at /api/debug/csp-violations"
  dinfo "CSP violations will be logged when resources violate policy"

  # Check if CSP header includes report-uri
  local curl_opts=""
  if [ "$HEALTH_INSECURE" = "1" ]; then
    curl_opts="-sk"
  else
    curl_opts="-s"
  fi

  # The dev server can't reach its own public hostname (no hairpin NAT),
  # so without --resolve the curl times out silently and we wrongly report
  # CSP as missing. Force hostname → LAN_IP when LAN_IP is set (dev).
  local resolve_opt=""
  if [ -n "${LAN_IP:-}" ] && [ -n "${SITE_HOST:-}" ]; then
    resolve_opt="--resolve ${SITE_HOST}:${NGINX_PORT}:${LAN_IP}"
  fi

  local csp_header=$(curl $curl_opts $resolve_opt -I --max-time 5 "$test_url" 2>/dev/null | grep -i "content-security-policy" | head -1 || echo "")

  if [ -n "$csp_header" ]; then
    if echo "$csp_header" | grep -q "report-uri"; then
      dstatus csp status=ok report-uri=present
      dok "CSP report-uri is configured ✓"
    else
      dstatus csp status=warn report-uri=missing
      dwarn "CSP header present but report-uri not found"
      dinfo "  Full CSP header:"
      echo "$csp_header" | _log_cmd | sed 's/^/    /'
    fi
  else
    dstatus csp status=warn header=missing
    dwarn "CSP header not found (not being sent by server)"
  fi
}

# Run the regression smoke suite against the live site.
# Reads globals: DEPLOY_ENV, SKIP_REGRESSION, REPO_DIR, COMPOSE_FILE,
#                BACKEND_SERVICE, LOG_FILE, SITE_HOST, NGINX_PORT, LAN_IP, DOMAIN.
# Sets REGRESSION_RC=0 on pass, 1 on failure. Triggers rollback on failure.
run_regression_tests() {
  REGRESSION_RC=0

  if [ "${SKIP_REGRESSION:-0}" = "1" ]; then
    dstatus regression status=skipped reason=skip-flag
    dinfo "Regression smoke tests skipped (--skip-regression)"
    return 0
  fi

  dsection "Regression tests — HTTP smoke suite (live site)"

  # Capture so we can parse the [regression] summary and emit a normalised
  # suite=regression status line alongside the script's own output.
  local reg_out=""
  if [ "${DEPLOY_ENV:-}" = "dev" ]; then
    reg_out=$(bash "${REPO_DIR}/scripts/tests/test-regression.sh" \
      --base-url "https://${SITE_HOST}:${NGINX_PORT}" \
      --resolve "${SITE_HOST}:${NGINX_PORT}:${LAN_IP}" \
      --compose-file "$COMPOSE_FILE" \
      --service "$BACKEND_SERVICE" \
      --insecure \
      2>&1) || REGRESSION_RC=1
  elif [ -n "${DOMAIN:-}" ]; then
    reg_out=$(bash "${REPO_DIR}/scripts/tests/test-regression.sh" \
      --base-url "https://${DOMAIN}" \
      --resolve "${DOMAIN}:443:127.0.0.1" \
      --compose-file "$COMPOSE_FILE" \
      --service "$BACKEND_SERVICE" \
      2>&1) || REGRESSION_RC=1
  fi

  printf '%s\n' "$reg_out" | _log_cmd

  # Normalised summary line, consistent with the backend/frontend suites.
  local sline passed failed total
  sline=$(printf '%s\n' "$reg_out" | grep -E '^\[regression\]' | tail -1 || true)
  passed=$(_kv_num "$sline" passed); failed=$(_kv_num "$sline" failed); total=$(_kv_num "$sline" total)
  if [ "$REGRESSION_RC" -eq 0 ]; then
    dstatus regression suite=regression status=ok tests="${total:-0}" passed="${passed:-0}" failed="${failed:-0}"
  else
    dstatus regression suite=regression status=failed tests="${total:-0}" passed="${passed:-0}" failed="${failed:-0}"
  fi

  if [ "$REGRESSION_RC" -ne 0 ]; then
    _do_rollback "regression smoke tests failed"
  fi
}
