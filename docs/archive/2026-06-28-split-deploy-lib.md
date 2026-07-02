# Split deploy-lib.sh into Sub-Libraries — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Break `scripts/deploy/deploy-lib.sh` (2162 lines) into six focused sub-libraries, making `deploy-lib.sh` a thin aggregator, with no behaviour change and full backwards compatibility for all callers.

**Architecture:** `deploy-lib.sh` keeps its preamble (state vars, colours, core logging, `require_tools`, `dc`, repo helpers) and gains six `source` calls at the bottom. Each sub-lib is a pure collection of function definitions — no top-level executable code, no `set -euo pipefail` (inherited from parent). Two refactors land during the move: `_perform_rollback_containers` extracted from `_do_rollback`, and `_run_browser_test` extracted from six near-identical frontend test functions.

**Tech Stack:** bash, shellcheck (optional), `bash -n` for syntax validation.

## Global Constraints

- No behaviour change — this is a structural refactor only
- All callers (`deploy.sh`) source `deploy-lib.sh` unchanged; no caller edits required
- Sub-libs must NOT contain `set -euo pipefail` (they inherit from parent shell)
- Sub-libs must NOT contain top-level executable code (only function definitions)
- Each function moves verbatim except the two explicit refactors noted below
- Dependency: #435 (dc() wrapper) is already merged — `dc()` stays in core
- OPS branch rule: one ops branch at a time; complete + merge before starting next

---

## File Map

**Files to modify:**
- `scripts/deploy/deploy-lib.sh` — remove moved functions; add six `source` lines at bottom; keep preamble + core

**Files to create:**
- `scripts/deploy/deploy-lib-env.sh` — env loading, validation, template sync
- `scripts/deploy/deploy-lib-docker.sh` — compose, rollback, state tracking, nginx, certs
- `scripts/deploy/deploy-lib-health.sh` — health polling, outlook token check
- `scripts/deploy/deploy-lib-tests.sh` — backend + frontend test runners
- `scripts/deploy/deploy-lib-checks.sh` — disk, port, DDNS, UFW, backup, LAN IP
- `scripts/deploy/deploy-lib-report.sh` — deploy status, report, deployment info

**Function assignment:**

| Sub-lib | Functions |
|---------|-----------|
| `deploy-lib-env.sh` | `ensure_env_file`, `load_env`, `redact_env`, `sync_env_from_template`, `log_env_snapshot`, `validate_env`, `migrate_env_values`, `prompt_missing_vars` |
| `deploy-lib-docker.sh` | `_save_last_good_state`, `_restore_last_good_state`, `cleanup_stale_compose_projects`, `ensure_dev_certs`, `check_nginx_config`, `apply_schema`, `_check_rollback_health`, `_perform_rollback_containers` (NEW), `_do_rollback` (refactored), `compose_up_with_rollback` |
| `deploy-lib-health.sh` | `_poll_health`, `wait_for_health`, `check_outlook_token` |
| `deploy-lib-tests.sh` | `_run_browser_test` (NEW), `run_deploy_tests`, `test_error_logger_all_pages`, `test_error_logger_contracts`, `check_public_page_js`, `check_csp_violations`, `check_admin_e2e_csp`, `check_admin_e2e`, `test_csp_reporting`, `run_regression_tests` |
| `deploy-lib-checks.sh` | `check_port_availability`, `check_disk_space`, `prune_client_errors`, `check_ddns_sync`, `auto_detect_lan_ip`, `check_ufw_port`, `check_backup_health` |
| `deploy-lib-report.sh` | `show_deployment_info`, `log_deploy_summary`, `print_deploy_status`, `print_deploy_report` |

**Core functions staying in `deploy-lib.sh`:** everything from line 1 through `dc()` at line 277, plus `ensure_repo_cloned`, `update_to_branch`, `record_deploy_sha`.

---

## Task 1: Branch setup + scaffold empty sub-lib files

**Files:**
- Modify: `scripts/deploy/deploy-lib.sh` (append six source lines)
- Create: `scripts/deploy/deploy-lib-env.sh`
- Create: `scripts/deploy/deploy-lib-docker.sh`
- Create: `scripts/deploy/deploy-lib-health.sh`
- Create: `scripts/deploy/deploy-lib-tests.sh`
- Create: `scripts/deploy/deploy-lib-checks.sh`
- Create: `scripts/deploy/deploy-lib-report.sh`

- [ ] **Step 1: Fetch dev, create branch**

```bash
git fetch origin dev
git checkout dev
git pull origin dev
git checkout -b ops/issue-436-split-deploy-lib
```

- [ ] **Step 2: Apply `in progress` label to issue #436**

```bash
gh issue edit 436 --add-label "in progress"
```

- [ ] **Step 3: Create six empty sub-lib files**

Each file gets the same header. Create all six:

```bash
for name in env docker health tests checks report; do
cat > "scripts/deploy/deploy-lib-${name}.sh" << 'HEADER'
#!/usr/bin/env bash
# This file is sourced by deploy-lib.sh — do not execute directly.
# set -euo pipefail is inherited from the parent shell.
HEADER
done
```

- [ ] **Step 4: Append source lines to deploy-lib.sh**

Add at the very bottom of `scripts/deploy/deploy-lib.sh`:

```bash
# ── Sub-libraries ─────────────────────────────────────────────────────────────
# Sourced in dependency order. All callers source deploy-lib.sh; these files
# are never sourced directly.
_DEPLOY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy-lib-env.sh
. "${_DEPLOY_LIB_DIR}/deploy-lib-env.sh"
# shellcheck source=deploy-lib-checks.sh
. "${_DEPLOY_LIB_DIR}/deploy-lib-checks.sh"
# shellcheck source=deploy-lib-health.sh
. "${_DEPLOY_LIB_DIR}/deploy-lib-health.sh"
# shellcheck source=deploy-lib-docker.sh
. "${_DEPLOY_LIB_DIR}/deploy-lib-docker.sh"
# shellcheck source=deploy-lib-tests.sh
. "${_DEPLOY_LIB_DIR}/deploy-lib-tests.sh"
# shellcheck source=deploy-lib-report.sh
. "${_DEPLOY_LIB_DIR}/deploy-lib-report.sh"
```

- [ ] **Step 5: Syntax check**

```bash
bash -n scripts/deploy/deploy-lib.sh
```

Expected: no output (silent pass).

- [ ] **Step 6: Verify sourcing works**

```bash
bash -c 'source scripts/deploy/deploy-lib.sh' 2>&1
```

Expected: no output (LOG_FILE unbound warning is acceptable since DEPLOY_* vars not set; if `set -u` fires on `LOG_FILE`, that's the existing behaviour and not a regression).

If the source fails due to `LOG_FILE` being unbound, that's pre-existing — not introduced by this task. Note it and move on.

- [ ] **Step 7: Commit**

```bash
git add scripts/deploy/deploy-lib.sh scripts/deploy/deploy-lib-{env,docker,health,tests,checks,report}.sh
git commit -m "ops: scaffold deploy-lib sub-lib files (#436)

Six empty sub-library files created; deploy-lib.sh sources them at the
bottom. No behaviour change — files are empty function stubs at this point.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Extract deploy-lib-env.sh

**Functions to move from deploy-lib.sh (current line numbers):**
- `ensure_env_file` (353–374)
- `load_env` (376–402)
- `redact_env` (407–435)
- `sync_env_from_template` (446–580) — add `# ── Phase` markers + extract `_envsync_backup_and_replace`
- `log_env_snapshot` (583–588)
- `validate_env` (590–642)
- `migrate_env_values` (643–752)
- `prompt_missing_vars` (833–884)

**Refactor during move — `sync_env_from_template`:**

`sync_env_from_template` does 5 things in 130 lines. While moving it, add `# ── Phase` comment markers and extract the atomic-replace logic into a private helper so each concern is scannable:

```bash
# Extract this private helper (place before sync_env_from_template in the file):
# _envsync_backup_and_replace <tmp_env> <carried_count> <new_keys_arr_name> <dropped_keys_arr_name> <placeholder_keys_arr_name>
# Backs up ENV_FILE, replaces it atomically with tmp_env, logs the diff summary.
# Returns 1 if placeholder keys require operator action, 0 otherwise.
```

The body of `sync_env_from_template` stays structurally unchanged except for:
1. Adding `# ── Phase 1: guard` / `# ── Phase 2: load existing` / `# ── Phase 3: walk template` / `# ── Phase 4: detect dropped keys` / `# ── Phase 5: apply` comment headers
2. The Phase 5 (backup + mv + logging) block is replaced with a call to `_envsync_backup_and_replace`

**Files:**
- Modify: `scripts/deploy/deploy-lib.sh` (remove those functions; leave a `# Functions moved to deploy-lib-env.sh` placeholder comment at the section boundary)
- Modify: `scripts/deploy/deploy-lib-env.sh` (add those functions)

- [ ] **Step 1: Move functions into deploy-lib-env.sh**

Cut the 8 functions (lines ~351–884 in the original, which also includes the `# ── Env helpers ──` section header) from `deploy-lib.sh` and paste them into `scripts/deploy/deploy-lib-env.sh` below the header comment.

While pasting `sync_env_from_template`, add the 5 `# ── Phase` markers and extract `_envsync_backup_and_replace` as described above. Place `_envsync_backup_and_replace` immediately before `sync_env_from_template` in the file.

Leave in `deploy-lib.sh` at the section boundary:

```bash
# ── Env helpers — see deploy-lib-env.sh ───────────────────────────────────────
```

- [ ] **Step 2: Syntax check both files**

```bash
bash -n scripts/deploy/deploy-lib-env.sh
bash -n scripts/deploy/deploy-lib.sh
```

Expected: no output.

- [ ] **Step 3: Spot-check a function is callable**

```bash
bash -c '
  LOG_FILE=/dev/null
  source scripts/deploy/deploy-lib.sh
  redact_env /dev/null
'
```

Expected: no output or errors (redacting an empty file is a no-op).

- [ ] **Step 4: Commit**

```bash
git add scripts/deploy/deploy-lib.sh scripts/deploy/deploy-lib-env.sh
git commit -m "ops: extract deploy-lib-env.sh (#436)

Moves env loading, validation, template sync, and migration into a
focused sub-library. sync_env_from_template gains phase markers and
_envsync_backup_and_replace helper. No behaviour change.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Extract deploy-lib-checks.sh

**Functions to move from deploy-lib.sh:**
- `check_port_availability` (1166–1194)
- `check_disk_space` (1196–1223)
- `prune_client_errors` (1248–1256)
- `check_ddns_sync` (1726–1772)
- `auto_detect_lan_ip` (1868–1921)
- `check_ufw_port` (1922–1960)
- `check_backup_health` (2018–end)

Note: these functions reference line numbers in the *original* file. After Task 2 removed ~500 lines, the actual line numbers will have shifted — use the function names to find them with `grep -n "^check_port_availability\|^prune_client_errors\|^check_ddns_sync\|^auto_detect_lan_ip\|^check_ufw_port\|^check_backup_health\|^check_disk_space" scripts/deploy/deploy-lib.sh`.

**Files:**
- Modify: `scripts/deploy/deploy-lib.sh`
- Modify: `scripts/deploy/deploy-lib-checks.sh`

- [ ] **Step 1: Find current line numbers**

```bash
grep -n "^check_port_availability\|^prune_client_errors\|^check_ddns_sync\|^auto_detect_lan_ip\|^check_ufw_port\|^check_backup_health\|^check_disk_space" scripts/deploy/deploy-lib.sh
```

- [ ] **Step 2: Move functions into deploy-lib-checks.sh**

Cut the 7 functions from `deploy-lib.sh` and paste into `scripts/deploy/deploy-lib-checks.sh`. Leave a comment at the section boundary in `deploy-lib.sh`:

```bash
# ── Pre-flight checks — see deploy-lib-checks.sh ─────────────────────────────
```

- [ ] **Step 3: Syntax check**

```bash
bash -n scripts/deploy/deploy-lib-checks.sh
bash -n scripts/deploy/deploy-lib.sh
```

Expected: no output.

- [ ] **Step 4: Spot-check**

```bash
bash -c '
  LOG_FILE=/dev/null
  REPO_DIR=/tmp
  source scripts/deploy/deploy-lib.sh
  check_disk_space 0
'
```

Expected: runs without error (disk space check against /tmp with 0 GB minimum always passes).

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy/deploy-lib.sh scripts/deploy/deploy-lib-checks.sh
git commit -m "ops: extract deploy-lib-checks.sh (#436)

Moves pre-flight and runtime checks (disk, port, DDNS, UFW, backup
health, LAN IP) into a focused sub-library. No behaviour change.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 4: Extract deploy-lib-health.sh

**Functions to move from deploy-lib.sh:**
- `_poll_health` (originally 1083)
- `wait_for_health` (originally 1325)
- `check_outlook_token` (originally 1773)

Note: `_check_rollback_health` stays in the file for now — it moves in Task 5 with docker functions (it's only called by `_do_rollback`).

**Files:**
- Modify: `scripts/deploy/deploy-lib.sh`
- Modify: `scripts/deploy/deploy-lib-health.sh`

- [ ] **Step 1: Find current line numbers**

```bash
grep -n "^_poll_health\|^wait_for_health\|^check_outlook_token" scripts/deploy/deploy-lib.sh
```

- [ ] **Step 2: Move functions into deploy-lib-health.sh**

Cut the 3 functions from `deploy-lib.sh` and paste into `scripts/deploy/deploy-lib-health.sh`. Leave section comment:

```bash
# ── Health checks — see deploy-lib-health.sh ──────────────────────────────────
```

- [ ] **Step 3: Syntax check**

```bash
bash -n scripts/deploy/deploy-lib-health.sh
bash -n scripts/deploy/deploy-lib.sh
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add scripts/deploy/deploy-lib.sh scripts/deploy/deploy-lib-health.sh
git commit -m "ops: extract deploy-lib-health.sh (#436)

Moves _poll_health, wait_for_health, and check_outlook_token into a
focused health sub-library. No behaviour change.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 5: Extract deploy-lib-docker.sh + rollback refactor

**Functions to move from deploy-lib.sh:**
- `_save_last_good_state` (originally 163)
- `_restore_last_good_state` (originally 180)
- `cleanup_stale_compose_projects` (originally 753)
- `ensure_dev_certs` (originally 885)
- `check_nginx_config` (originally 970)
- `_check_rollback_health` (originally 1101)
- `apply_schema` (originally 1230)
- `_do_rollback` (originally 1031) — refactored (see below)
- `compose_up_with_rollback` (originally 1260)

**Refactor during move — `_do_rollback`:**

`_do_rollback` has 3 branches, each doing: `dc down --remove-orphans` → `dc up -d --build` → `DEPLOY_ROLLED_BACK=1` → `_check_rollback_health`. Extract that repeated block into `_perform_rollback_containers`:

```bash
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
```

Then each branch of `_do_rollback` replaces its repeated `dc down` + `dc up` + `DEPLOY_ROLLED_BACK=1` + `_check_rollback_health` block with a single `_perform_rollback_containers` call:

```bash
# Branch 1 (last-good-state):
git checkout -B "$rollback_branch" "$rollback_sha" 2>&1 | tee -a "$LOG_FILE"
[ "${PIPESTATUS[0]}" -eq 0 ] \
  || { dfail "[rollback] git checkout to ${rollback_sha:0:7} failed — manual recovery required"; return 1; }
_perform_rollback_containers

# Branch 2 (stable-branch):
git fetch origin "$ROLLBACK_BRANCH" 2>&1 | tee -a "$LOG_FILE"
[ "${PIPESTATUS[0]}" -eq 0 ] \
  || { dfail "[rollback] git fetch for '$ROLLBACK_BRANCH' failed — manual recovery required"; return 1; }
git checkout -B "$ROLLBACK_BRANCH" "origin/$ROLLBACK_BRANCH" 2>&1 | tee -a "$LOG_FILE"
[ "${PIPESTATUS[0]}" -eq 0 ] \
  || { dfail "[rollback] git checkout to '$ROLLBACK_BRANCH' failed — manual recovery required"; return 1; }
_perform_rollback_containers

# Branch 3 (previous-commit):
git reset --hard "$PRE_SHA" 2>&1 | tee -a "$LOG_FILE"
[ "${PIPESTATUS[0]}" -eq 0 ] \
  || { dfail "[rollback] git reset to ${PRE_SHA:0:7} failed — manual recovery required"; return 1; }
_perform_rollback_containers
```

Place `_perform_rollback_containers` immediately before `_do_rollback` in `deploy-lib-docker.sh`.

**Files:**
- Modify: `scripts/deploy/deploy-lib.sh`
- Modify: `scripts/deploy/deploy-lib-docker.sh`

- [ ] **Step 1: Find current line numbers**

```bash
grep -n "^_save_last_good_state\|^_restore_last_good_state\|^cleanup_stale_compose_projects\|^ensure_dev_certs\|^check_nginx_config\|^_check_rollback_health\|^apply_schema\|^_do_rollback\|^compose_up_with_rollback" scripts/deploy/deploy-lib.sh
```

- [ ] **Step 2: Move functions + apply refactor**

1. Cut all 9 functions from `deploy-lib.sh`.
2. Paste into `scripts/deploy/deploy-lib-docker.sh` with this ordering:
   - `_save_last_good_state`
   - `_restore_last_good_state`
   - `_check_rollback_health`
   - `_perform_rollback_containers` (NEW — write from scratch using the code above)
   - `_do_rollback` (refactored — 3 branches now call `_perform_rollback_containers`)
   - `cleanup_stale_compose_projects`
   - `ensure_dev_certs`
   - `check_nginx_config`
   - `apply_schema`
   - `compose_up_with_rollback`

3. Leave section comment in `deploy-lib.sh`:

```bash
# ── Docker / compose / rollback — see deploy-lib-docker.sh ───────────────────
```

- [ ] **Step 3: Syntax check**

```bash
bash -n scripts/deploy/deploy-lib-docker.sh
bash -n scripts/deploy/deploy-lib.sh
```

Expected: no output.

- [ ] **Step 4: Verify rollback refactor compiles**

```bash
bash -c 'source scripts/deploy/deploy-lib.sh; declare -f _perform_rollback_containers'
```

Expected: prints the function body (confirming it's defined and callable).

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy/deploy-lib.sh scripts/deploy/deploy-lib-docker.sh
git commit -m "ops: extract deploy-lib-docker.sh with rollback refactor (#436)

Moves compose, rollback, state tracking, nginx and cert helpers into a
focused docker sub-library. Extracts _perform_rollback_containers from
_do_rollback's 3 near-identical branches (git → dc down → dc up → health
check). No behaviour change.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 6: Extract deploy-lib-tests.sh + _run_browser_test

**Functions to move from deploy-lib.sh:**
- `run_deploy_tests` (originally 1416)
- `test_error_logger_all_pages` (originally 1456)
- `test_error_logger_contracts` (originally 1498)
- `check_public_page_js` (originally 1533)
- `check_csp_violations` (originally 1569)
- `check_admin_e2e_csp` (originally 1608)
- `check_admin_e2e` (originally 1639)
- `test_csp_reporting` (originally 1671)
- `run_regression_tests` (originally 1961)

**Refactor during move — `_run_browser_test` helper:**

Six of the browser test functions share the same shape: check `NGINX_URL`, run `dc exec`, extract a `[<prefix>]` summary line. Extract a private helper:

```bash
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
```

Place `_run_browser_test` at the top of `deploy-lib-tests.sh` (before the other functions).

**Refactored callers** — replace the dc exec + sline extraction pattern in these functions:

`test_error_logger_all_pages` (no extra dc flags, kv: passed/failed/total):
```bash
test_error_logger_all_pages() {
  dsection "Frontend tests — error-logger present on all pages (browser)"
  local base_url="${NGINX_URL:-}"
  if [ -z "$base_url" ]; then
    dwarn "NGINX_URL not set — skipping error logger test"
    dstatus error-logger suite=frontend status=skipped reason=no-nginx-url; return
  fi
  dinfo "Running comprehensive page coverage test..."
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
```

`test_error_logger_contracts` (no extra dc flags, kv: passed/failed, total=passed+failed):
```bash
test_error_logger_contracts() {
  dsection "Frontend tests — error-logger behavioural contracts (browser)"
  local base_url="${NGINX_URL:-}"
  if [ -z "$base_url" ]; then
    dwarn "NGINX_URL not set — skipping error logger contract test"
    dstatus error-logger-contracts suite=frontend status=skipped reason=no-nginx-url; return
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
```

`check_public_page_js` (no extra dc flags, kv: passed/failed/total):
```bash
check_public_page_js() {
  dsection "Frontend tests — public pages JS runtime errors (#390)"
  local base_url="${NGINX_URL:-}"
  if [ -z "$base_url" ]; then
    dwarn "NGINX_URL not set — skipping public page JS runtime check"
    dstatus public-pages suite=frontend status=skipped reason=no-nginx-url; return
  fi
  dinfo "Loading public pages in headless browser to check for unhandled JS errors..."
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
```

`check_csp_violations` (no extra dc flags, kv: pages/violations):
```bash
check_csp_violations() {
  dsection "Frontend scans — CSP violations across pages (#341)"
  local base_url="${NGINX_URL:-}"
  if [ -z "$base_url" ]; then
    dwarn "NGINX_URL not set — skipping CSP violation scan"
    dstatus csp-violations suite=frontend status=skipped reason=no-nginx-url; return
  fi
  dinfo "Loading all pages in headless browser to detect CSP violations..."
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
```

`check_admin_e2e_csp` (extra flag: `-e JWT_SECRET=...`, kv: interactions/violations — calls `_do_rollback` on failure):
```bash
check_admin_e2e_csp() {
  dsection "Frontend scans — authenticated admin E2E CSP (#342)"
  local base_url="${NGINX_URL:-}"
  if [ -z "$base_url" ]; then
    dwarn "NGINX_URL not set — skipping admin E2E CSP scan"
    dstatus admin-e2e-csp suite=frontend status=skipped reason=no-nginx-url; return
  fi
  dinfo "Running authenticated admin interactions to detect CSP violations..."
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
```

`check_admin_e2e` (extra flag: `-e JWT_SECRET=...`, kv: smoke/interactions via `_kv_str` — calls `_do_rollback` on failure):
```bash
check_admin_e2e() {
  dsection "Frontend tests — admin E2E smoke + interactions (hard fail)"
  local base_url="${NGINX_URL:-}"
  if [ -z "$base_url" ]; then
    dwarn "NGINX_URL not set — skipping admin E2E tests"
    dstatus admin-e2e suite=frontend status=skipped reason=no-nginx-url; return
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
```

`test_csp_reporting` does not match the pattern (it uses `curl`, not `dc exec`/`NGINX_URL`) — move verbatim, no refactor.

`run_deploy_tests` and `run_regression_tests` do not match the pattern either — move verbatim.

**Files:**
- Modify: `scripts/deploy/deploy-lib.sh`
- Modify: `scripts/deploy/deploy-lib-tests.sh`

- [ ] **Step 1: Find current line numbers**

```bash
grep -n "^run_deploy_tests\|^test_error_logger_all_pages\|^test_error_logger_contracts\|^check_public_page_js\|^check_csp_violations\|^check_admin_e2e_csp\|^check_admin_e2e\|^test_csp_reporting\|^run_regression_tests" scripts/deploy/deploy-lib.sh
```

- [ ] **Step 2: Add `_run_browser_test` to deploy-lib-tests.sh**

Write `_run_browser_test` from the code block above at the top of `scripts/deploy/deploy-lib-tests.sh`, immediately after the header comment.

- [ ] **Step 3: Move functions into deploy-lib-tests.sh**

Cut the 9 functions from `deploy-lib.sh`. For the 6 browser-test functions listed above, paste the refactored versions (from the code blocks in this task). For `run_deploy_tests`, `test_csp_reporting`, `run_regression_tests`, paste verbatim.

Leave section comment in `deploy-lib.sh`:

```bash
# ── Deploy tests — see deploy-lib-tests.sh ────────────────────────────────────
```

- [ ] **Step 4: Syntax check**

```bash
bash -n scripts/deploy/deploy-lib-tests.sh
bash -n scripts/deploy/deploy-lib.sh
```

Expected: no output.

- [ ] **Step 5: Verify _run_browser_test is callable**

```bash
bash -c 'LOG_FILE=/dev/null COMPOSE_FILE=/dev/null source scripts/deploy/deploy-lib.sh; declare -f _run_browser_test'
```

Expected: prints the function body.

- [ ] **Step 6: Commit**

```bash
git add scripts/deploy/deploy-lib.sh scripts/deploy/deploy-lib-tests.sh
git commit -m "ops: extract deploy-lib-tests.sh with _run_browser_test helper (#436)

Moves all deploy test functions into a focused sub-library. Extracts
_run_browser_test to eliminate repeated dc exec + sline-parse pattern
shared by 6 browser test functions. No behaviour change.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 7: Extract deploy-lib-report.sh

**Functions to move from deploy-lib.sh:**
- `show_deployment_info` (originally 333)
- `log_deploy_summary` (originally 1795)
- `print_deploy_status` (originally 1809)
- `print_deploy_report` (originally 1825)

- [ ] **Step 1: Find current line numbers**

```bash
grep -n "^show_deployment_info\|^log_deploy_summary\|^print_deploy_status\|^print_deploy_report" scripts/deploy/deploy-lib.sh
```

- [ ] **Step 2: Move functions into deploy-lib-report.sh**

Cut all 4 functions from `deploy-lib.sh` and paste into `scripts/deploy/deploy-lib-report.sh`. Leave section comment:

```bash
# ── Reporting — see deploy-lib-report.sh ──────────────────────────────────────
```

- [ ] **Step 3: Syntax check**

```bash
bash -n scripts/deploy/deploy-lib-report.sh
bash -n scripts/deploy/deploy-lib.sh
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add scripts/deploy/deploy-lib.sh scripts/deploy/deploy-lib-report.sh
git commit -m "ops: extract deploy-lib-report.sh (#436)

Moves deploy reporting functions (status banner, summary log,
print_deploy_report, show_deployment_info) into a focused sub-library.
No behaviour change.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 8: Final verification

- [ ] **Step 1: Count what remains in deploy-lib.sh**

```bash
wc -l scripts/deploy/deploy-lib.sh
grep -n "^[a-zA-Z_].*() {" scripts/deploy/deploy-lib.sh
```

Expected: deploy-lib.sh should now be ~120–200 lines. Functions remaining in core: `_deploy_timestamp`, `_redact_sensitive`, `_deploy_log_raw`, `dlog`, `dinfo`, `dok`, `dwarn`, `dfail`, `dsection`, `dstatus`, `_verbose`, `ddie`, `try_root`, `init_log_banner`, `_log_cmd`, `_kv_num`, `_kv_str`, `require_tools`, `dc`, `ensure_repo_cloned`, `update_to_branch`, `record_deploy_sha`.

- [ ] **Step 2: Syntax-check all 7 files**

```bash
for f in scripts/deploy/deploy-lib.sh scripts/deploy/deploy-lib-{env,docker,health,tests,checks,report}.sh; do
  echo -n "bash -n $f: "
  bash -n "$f" && echo "OK" || echo "FAIL"
done
```

Expected: all 7 lines print `OK`.

- [ ] **Step 3: Verify the full sourcing chain loads cleanly**

```bash
bash -c '
  LOG_FILE=/dev/null
  source scripts/deploy/deploy-lib.sh
  echo "Functions from core: $(declare -f dc | head -1)"
  echo "Functions from env:  $(declare -f load_env | head -1)"
  echo "Functions from docker: $(declare -f compose_up_with_rollback | head -1)"
  echo "Functions from health: $(declare -f wait_for_health | head -1)"
  echo "Functions from tests: $(declare -f run_deploy_tests | head -1)"
  echo "Functions from checks: $(declare -f check_disk_space | head -1)"
  echo "Functions from report: $(declare -f print_deploy_report | head -1)"
'
```

Expected: 7 lines, each naming a function (not blank/error).

- [ ] **Step 4: Count functions per sub-lib (sanity check)**

```bash
for f in scripts/deploy/deploy-lib-{env,docker,health,tests,checks,report}.sh; do
  echo "$f: $(grep -c "^[a-zA-Z_].*() {" "$f") functions"
done
```

Expected counts (approximate):
- `deploy-lib-env.sh`: 9 functions (8 originals + `_envsync_backup_and_replace`)
- `deploy-lib-docker.sh`: 11 functions (9 originals + `_perform_rollback_containers` + `_check_rollback_health`)
- `deploy-lib-health.sh`: 3 functions
- `deploy-lib-tests.sh`: 10 functions (9 originals + `_run_browser_test`)
- `deploy-lib-checks.sh`: 7 functions
- `deploy-lib-report.sh`: 4 functions

- [ ] **Step 5: Syntax-check the main caller**

```bash
bash -n scripts/deploy/deploy.sh
```

Expected: no output.

- [ ] **Step 6: Commit (if there are any fixup changes from verification)**

Only commit if there are changes from the verification steps. Otherwise proceed to Task 9.

```bash
git add scripts/deploy/
git commit -m "ops: fix sub-lib extraction issues from verification (#436)"
```

---

## Task 9: Documentation + PR

**Files to check for references to deploy-lib.sh:**
- `CLAUDE.md` — mentions `deploy-lib.sh` in the DRY section
- `docs/AI.md` — may mention deploy-lib.sh
- `README.md` — may list deploy scripts
- `docs/RUNBOOK.md` / `docs/INFRASTRUCTURE.md` — may reference the file

- [ ] **Step 1: Find all doc references to deploy-lib.sh**

```bash
grep -rn "deploy-lib" docs/ README.md CLAUDE.md 2>/dev/null
```

- [ ] **Step 2: Update CLAUDE.md DRY section**

The CLAUDE.md DRY principle section says:
> "Deployment scripts: Extract reusable functions into `scripts/deploy/deploy-lib.sh` (shared helpers like `ensure_repo_cloned()`, `update_to_branch()`, `validate_env()`, `ensure_dev_certs()`). Each `*-deploy.sh` focuses on environment-specific logic only."

Update to reflect the sub-lib structure:
> "Deployment scripts: Shared helpers live in `scripts/deploy/deploy-lib.sh` (thin aggregator) and six sub-libraries (`deploy-lib-env.sh`, `deploy-lib-docker.sh`, `deploy-lib-health.sh`, `deploy-lib-tests.sh`, `deploy-lib-checks.sh`, `deploy-lib-report.sh`). Add new functions to whichever sub-lib matches their concern. Each `*-deploy.sh` focuses on environment-specific logic only."

- [ ] **Step 3: Update any other doc files found in Step 1**

For each reference found, update the description to note that `deploy-lib.sh` is now a thin aggregator that sources the six sub-libs.

- [ ] **Step 4: Apply `awaiting review` label to issue, remove `in progress`**

```bash
gh issue edit 436 --add-label "awaiting review" --remove-label "in progress"
```

- [ ] **Step 5: Push and create PR**

```bash
git add CLAUDE.md docs/
git commit -m "docs: update deploy-lib.sh references for sub-lib split (#436)

CLAUDE.md DRY section and any other doc references updated to describe
the new aggregator + sub-library structure.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"

git push -u origin ops/issue-436-split-deploy-lib
gh pr create --base dev \
  --title "ops: split deploy-lib.sh into focused sub-libraries (#436)" \
  --body "$(cat <<'EOF'
## Summary
- Splits `scripts/deploy/deploy-lib.sh` (2162 lines) into six focused sub-libraries sourced by a thin aggregator
- Extracts `_perform_rollback_containers` from `_do_rollback`'s three near-identical git+dc+health branches
- Extracts `_run_browser_test` from six repeated dc-exec + sline-parse patterns in browser test functions
- Adds `# ── Phase` markers to `sync_env_from_template` + `_envsync_backup_and_replace` helper
- No behaviour change — `deploy.sh` continues to source `deploy-lib.sh` unchanged

## Sub-library assignments
| Sub-lib | Responsibility |
|---------|---------------|
| `deploy-lib-env.sh` | .env loading, validation, template sync, migration |
| `deploy-lib-docker.sh` | compose, rollback, state tracking, nginx, certs |
| `deploy-lib-health.sh` | HTTP health polling, outlook token check |
| `deploy-lib-tests.sh` | backend Vitest runner, browser test runners |
| `deploy-lib-checks.sh` | disk, port, DDNS, UFW, backup health, LAN IP |
| `deploy-lib-report.sh` | deploy status banner, checkpoint report, deployment info |

## Test plan

### Verify syntax — all 7 files
```bash
for f in scripts/deploy/deploy-lib.sh scripts/deploy/deploy-lib-{env,docker,health,tests,checks,report}.sh; do
  echo -n "bash -n $f: "
  bash -n "$f" && echo "OK" || echo "FAIL"
done
```
Expected: all 7 lines print `OK`.

### Verify sourcing chain
```bash
bash -c '
  LOG_FILE=/dev/null
  source scripts/deploy/deploy-lib.sh
  declare -f dc load_env compose_up_with_rollback wait_for_health run_deploy_tests check_disk_space print_deploy_report | grep "^[a-z]"
'
```
Expected: 7 function name lines (one per sub-lib + core).

### Verify deploy.sh still passes syntax check
```bash
bash -n scripts/deploy/deploy.sh
```
Expected: no output.

### Smoke test: functions from each sub-lib are callable
```bash
bash -c '
  LOG_FILE=/dev/null
  REPO_DIR=/tmp
  source scripts/deploy/deploy-lib.sh
  check_disk_space 0
  redact_env /dev/null
  echo "All sub-lib functions accessible ✓"
'
```
Expected: `All sub-lib functions accessible ✓`

## Documentation
- Updated `CLAUDE.md` DRY section to describe aggregator + sub-lib structure
- Updated any other references found by `grep -rn "deploy-lib" docs/ README.md CLAUDE.md`

Closes #436

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage check:**

| Requirement | Task |
|---|---|
| Split into 6 named sub-libs | Tasks 2–7 |
| deploy-lib.sh becomes thin aggregator | Tasks 2–7 (functions removed) + Task 1 (source lines) |
| Backwards-compatible for deploy.sh | Verified in Task 8 (bash -n deploy.sh) |
| `_do_rollback` → `_perform_rollback_containers` | Task 5 |
| `run_browser_test` DRY extraction | Task 6 |
| `sync_env_from_template` split (5 concerns) | Task 2 |
| No `set -euo pipefail` in sub-libs | Enforced by header comment in Task 1 |
| Docs updated | Task 9 |
| `in progress` → `awaiting review` label | Tasks 1 + 9 |

**Placeholder scan:** No TBD, TODO, or incomplete steps found.

**Type consistency:** No cross-task function signatures — all functions either move verbatim or are fully specified inline.
