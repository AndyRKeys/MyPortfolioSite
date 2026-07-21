# Deploy Branch Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dev/prod deploys fail loudly instead of silently deploying the wrong branch when the branch-switch step doesn't actually complete (issue #542).

**Architecture:** Two independent, complementary fixes. (1) A defense-in-depth check inside `deploy.sh`'s `record_deploy_sha()` that verifies the repo is actually on the requested branch before any build/test work starts, aborting with `ddie` on mismatch. (2) A fix at the orchestration layer (`dev-deploy.ps1` / `prod-deploy.ps1`) so a failed `switch-branch.sh` aborts before `deploy.sh` ever runs, and `switch-branch.sh`'s own output is captured into the persistent server-side deploy log instead of only appearing in the operator's terminal.

**Tech Stack:** Bash (`scripts/deploy/deploy-lib.sh`, `scripts/deploy/switch-branch.sh`), PowerShell (`scripts/deploy/dev-deploy.ps1`, `scripts/deploy/prod-deploy.ps1`).

## Global Constraints

- Never run `switch-branch.sh`, `deploy.sh`, or any `docker compose` command against the live `~/MyPortfolioSite-dev` (dev) or `~/MyPortfolioSite` (prod) checkouts on this server while testing — those are shared infrastructure. All functional verification must happen in a throwaway clone (e.g. under the scratchpad or `/tmp`), never the real dev-server or prod-server checkout.
- `dstatus` status keywords are validated against a fixed vocabulary for the quiet-mode tick/cross display (`deploy-lib.sh` line ~122 for success words, ~124 for failure words). The failure word `mismatch` is already in that list — use it verbatim for the new check; do not invent a new status keyword.
- PowerShell here-strings (`@"..."@`) interpolate `$variable` automatically. Any literal bash `$` that must survive into the remote command (e.g. `$?`, `$SWITCH_RC`) must be escaped with a backtick (`` `$ ``) in the PowerShell source, exactly like the existing CRLF-strip line already does (`` `r`n ``, `` `n ``).
- Do not use bash-only syntax (process substitution `>(...)`, `${PIPESTATUS[0]}`) in the outer remote command block — the remote login shell invoked by `ssh` is not guaranteed to be bash. Redirect-then-check-`$?`-then-`tail` is portable; use that pattern.
- No `.bats` or other unit-test harness exists for these deploy scripts in this repo (confirmed: only `backend/tests/routes/deploy.test.js` and `backend/tests/utils/deployLogParser.test.js` exist, and those test the Node backend's own deploy-status API, not these bash/PowerShell scripts). Verification for the bash task is a real `--dry-run` invocation against a throwaway clone, reproducing the bug then confirming the fix — this repo's established pattern for these scripts (see `deploy.sh`'s own `--dry-run` flag).

---

### Task 1: Fail loudly when the deployed branch doesn't match the requested branch

**Files:**
- Modify: `scripts/deploy/deploy-lib.sh:284-294` (`record_deploy_sha` function)

**Interfaces:**
- Consumes: `$REPO_DIR` (set earlier in `deploy.sh`), `$BRANCH` (set earlier in `deploy.sh` from `--env` / positional arg parsing), `dstatus()`, `ddie()`, `dinfo()` (all defined earlier in `deploy-lib.sh`).
- Produces: `PRE_SHA`, `NEW_SHA` globals (used by later report/rollback logic) — unchanged from current behavior when the branch matches.

- [ ] **Step 1: Reproduce the bug in a throwaway clone**

```bash
rm -rf /tmp/deploy-verify-task1 && git clone -q /home/modnar3/MyPortfolioSite-dev /tmp/deploy-verify-task1
cd /tmp/deploy-verify-task1
git checkout -q -b feature/issue-527-playwright-migration origin/feature/issue-527-playwright-migration
cp .env.dev-server.example .env
sed -i \
  -e 's/^COMPOSE_PROJECT_NAME=.*/COMPOSE_PROJECT_NAME=verify-task1-dev/' \
  -e 's/^DEPLOY_ENV=.*/DEPLOY_ENV=dev/' \
  -e 's/^SITE_HOST=.*/SITE_HOST=localhost/' \
  -e 's/^ADMIN_EMAIL=.*/ADMIN_EMAIL=test@example.com/' \
  .env
HOME=/tmp/deploy-verify-task1-home bash scripts/deploy/deploy.sh --env dev fix/issue-522-small-bugs --dry-run --quiet 2>&1 | tail -30
```

Expected (current, buggy behavior): the command exits with `DEPLOY COMPLETE`-style dry-run success output, and a line like `[deploy:git] step=N status=wrapper-managed branch=fix/issue-522-small-bugs sha=<sha of feature/issue-527's HEAD>` — i.e. it reports the *requested* branch name even though the checked-out repo is actually still on `feature/issue-527-playwright-migration`. This confirms the bug is reproduced.

Note: `HOME=/tmp/deploy-verify-task1-home` is set so `deploy.sh`'s `REPO_DIR="${HOME}/MyPortfolioSite-dev"` resolution doesn't accidentally point at the real repo — but since we're running the script directly against `/tmp/deploy-verify-task1` (not via that HOME-derived path), pass `--env dev` and rely on the script being invoked with cwd already inside the throwaway clone; confirm by checking `scripts/deploy/deploy.sh:111` (`REPO_DIR="${HOME}/MyPortfolioSite-dev"`) — if the script hardcodes the path from `$HOME` rather than using the invocation directory, adjust: `mkdir -p /tmp/deploy-verify-task1-home && ln -s /tmp/deploy-verify-task1 /tmp/deploy-verify-task1-home/MyPortfolioSite-dev` before running, so `$HOME/MyPortfolioSite-dev` resolves to the throwaway clone.

- [ ] **Step 2: Apply the fix**

Replace the current `record_deploy_sha` function body:

```bash
# Record current HEAD as the deploy SHA without performing any git update.
# Use when branch switching is handled by an external wrapper (e.g. switch-branch.sh).
# Sets PRE_SHA and NEW_SHA so rollback logic has a valid reference.
record_deploy_sha() {
  dsection "Phase 2: recording deploy SHA (branch managed by wrapper)"

  cd "$REPO_DIR"

  local actual_branch
  actual_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  if [ "$actual_branch" != "$BRANCH" ]; then
    dstatus git status=mismatch expected="$BRANCH" actual="$actual_branch"
    ddie "Repo is on '$actual_branch' but this deploy was requested for '$BRANCH' — the branch-switch step (switch-branch.sh) did not complete. Aborting before any build/test work. Check the wrapper's output/exit code."
  fi

  PRE_SHA=$(git rev-parse HEAD 2>/dev/null || echo "none")
  NEW_SHA="$PRE_SHA"

  dstatus git status=wrapper-managed branch="$BRANCH" sha="${NEW_SHA:0:7}"
  dinfo "Branch update handled by wrapper — current HEAD: ${NEW_SHA:0:7}"
}
```

- [ ] **Step 3: Verify the fix aborts on mismatch**

Re-run the exact command from Step 1 (same throwaway clone, still on `feature/issue-527-playwright-migration`, still requesting `fix/issue-522-small-bugs`):

```bash
cd /tmp/deploy-verify-task1
HOME=/tmp/deploy-verify-task1-home bash scripts/deploy/deploy.sh --env dev fix/issue-522-small-bugs --dry-run --quiet 2>&1 | tail -15
echo "exit code: $?"
```

Expected: the process now exits non-zero, output includes a line matching `[deploy:git] step=N status=mismatch expected=fix/issue-522-small-bugs actual=feature/issue-527-playwright-migration` followed by an `[ERROR]`-prefixed `ddie` message, and the run stops there — no dry-run summary box, no `DEPLOY COMPLETE`.

- [ ] **Step 4: Verify the fix does NOT block a correct (matching) branch**

```bash
cd /tmp/deploy-verify-task1
git checkout -q origin/feature/issue-527-playwright-migration
HOME=/tmp/deploy-verify-task1-home bash scripts/deploy/deploy.sh --env dev feature/issue-527-playwright-migration --dry-run --quiet 2>&1 | tail -20
echo "exit code: $?"
```

Expected: exit code `0`, output includes `[deploy:git] step=N status=wrapper-managed branch=feature/issue-527-playwright-migration sha=<7-char sha>` (no mismatch line), and the run proceeds to the dry-run summary/report. This confirms the fix doesn't false-positive on the normal path.

- [ ] **Step 5: Clean up the throwaway clone**

```bash
rm -rf /tmp/deploy-verify-task1 /tmp/deploy-verify-task1-home
```

- [ ] **Step 6: Commit**

```bash
git add scripts/deploy/deploy-lib.sh
git commit -m "fix(#542): abort deploy if repo isn't on the requested branch

record_deploy_sha() trusted the branch-switch wrapper unconditionally and
only echoed back the requested branch name in the report, without checking
git's actual state. If switch-branch.sh failed or no-op'd silently,
deploy.sh proceeded to build/test/deploy whatever was already checked out,
reporting success under the wrong branch name."
```

---

### Task 2: Chain switch-branch.sh and deploy.sh, and capture switch-branch.sh output in the server-side log

**Files:**
- Modify: `scripts/deploy/dev-deploy.ps1:40-46`
- Modify: `scripts/deploy/prod-deploy.ps1:40-46`

**Interfaces:**
- Consumes: `$RemoteHome`, `$DevRepo`/`$ProdRepo`, `$RepoUrl`, `$Branch` (dev only), `$flagStr` — all already defined earlier in each script, unchanged.
- Produces: no new interfaces; this task only changes the remote command string each script builds and sends over `ssh`.

- [ ] **Step 1: Edit `dev-deploy.ps1`'s remote command block**

Replace:

```powershell
$remoteCommand = @"
if [ ! -d "$DevRepo/.git" ]; then
    git clone "$RepoUrl" "$DevRepo"
fi
bash "$DevRepo/scripts/deploy/switch-branch.sh" "$Branch" "$DevRepo"
bash "$DevRepo/scripts/deploy/deploy.sh" --env dev "$Branch" $flagStr
"@
```

with:

```powershell
$remoteCommand = @"
if [ ! -d "$DevRepo/.git" ]; then
    git clone "$RepoUrl" "$DevRepo"
fi
mkdir -p "$RemoteHome/logs"
bash "$DevRepo/scripts/deploy/switch-branch.sh" "$Branch" "$DevRepo" >> "$RemoteHome/logs/dev-deploy.log" 2>&1
SWITCH_RC=`$?
tail -n 30 "$RemoteHome/logs/dev-deploy.log"
if [ "`$SWITCH_RC" -ne 0 ]; then
    echo "[ERROR] switch-branch.sh failed (exit `$SWITCH_RC) — aborting deploy without building. See $RemoteHome/logs/dev-deploy.log"
    exit `$SWITCH_RC
fi
bash "$DevRepo/scripts/deploy/deploy.sh" --env dev "$Branch" $flagStr
"@
```

Note the backtick before every bash `$` that must NOT be interpolated by PowerShell (`` `$? ``, `` `$SWITCH_RC `` three times) — `$RemoteHome`, `$DevRepo`, `$RepoUrl`, `$Branch`, `$flagStr` are PowerShell variables and stay un-escaped exactly as in the original.

- [ ] **Step 2: Edit `prod-deploy.ps1`'s remote command block**

Replace:

```powershell
$remoteCommand = @"
if [ ! -d "$ProdRepo/.git" ]; then
    git clone "$RepoUrl" "$ProdRepo"
fi
bash "$ProdRepo/scripts/deploy/switch-branch.sh" "main" "$ProdRepo"
bash "$ProdRepo/scripts/deploy/deploy.sh" --env prod $flagStr
"@
```

with:

```powershell
$remoteCommand = @"
if [ ! -d "$ProdRepo/.git" ]; then
    git clone "$RepoUrl" "$ProdRepo"
fi
mkdir -p "$RemoteHome/logs"
bash "$ProdRepo/scripts/deploy/switch-branch.sh" "main" "$ProdRepo" >> "$RemoteHome/logs/prod-deploy.log" 2>&1
SWITCH_RC=`$?
tail -n 30 "$RemoteHome/logs/prod-deploy.log"
if [ "`$SWITCH_RC" -ne 0 ]; then
    echo "[ERROR] switch-branch.sh failed (exit `$SWITCH_RC) — aborting deploy without building. See $RemoteHome/logs/prod-deploy.log"
    exit `$SWITCH_RC
fi
bash "$ProdRepo/scripts/deploy/deploy.sh" --env prod $flagStr
"@
```

- [ ] **Step 3: Syntax-check both PowerShell files**

Neither this session nor the implementer subagent has a Windows/PowerShell runtime available on this Linux server. Verify with `pwsh` if it happens to be installed; otherwise perform a careful manual review pass instead of skipping verification silently:

```bash
which pwsh || echo "pwsh not installed — falling back to manual review"
```

If `pwsh` is available:

```bash
pwsh -NoProfile -Command '$null = Get-Content -Raw ./scripts/deploy/dev-deploy.ps1 | Out-String | Invoke-Expression -ErrorAction Stop -WhatIf' 2>&1 || true
```

(This will likely still attempt real SSH calls since the script has no `-WhatIf` support of its own — do not let it actually SSH anywhere. If `pwsh` is unavailable, or the above isn't safely testable, do the fallback below instead and say so explicitly in the report.)

Fallback manual review (always do this regardless of `pwsh` availability):
1. Re-read both edited files in full.
2. Confirm every backtick-escaped `` `$ `` is followed by a bash-side name (`?`, `SWITCH_RC`) that should NOT be a PowerShell variable, and every un-escaped `$` (`$RemoteHome`, `$DevRepo`/`$ProdRepo`, `$RepoUrl`, `$Branch`, `$flagStr`) is a real PowerShell variable already defined earlier in the file.
3. Mentally substitute the PowerShell variables with example values (e.g. `$RemoteHome` = `/home/modnar3`, `$Branch` = `fix/issue-522-small-bugs`, `$flagStr` = `--quiet --auto-yes`) and confirm the resulting bash text is valid — no unbalanced quotes, no stray `$`.
4. Confirm the existing CRLF-strip line (`$remoteCommand = $remoteCommand -replace "` + '`' + `r` + '`' + `n", "` + '`' + `n"` + `) still runs after the here-string is built and will correctly strip line endings from the new lines too (it operates on the whole string, so this should need no change — confirm by reading the line and noting it's unconditional).

- [ ] **Step 4: Verify the reconstructed remote command against a throwaway clone (no real deploy)**

Since we cannot execute the `.ps1` files directly on this Linux server, hand-construct what the remote command *would* expand to and run that exact bash text against a throwaway clone to prove the logic works, without ever touching the real dev/prod checkouts:

```bash
rm -rf /tmp/deploy-verify-task2 && git clone -q /home/modnar3/MyPortfolioSite-dev /tmp/deploy-verify-task2
mkdir -p /tmp/deploy-verify-task2-logs
cd /tmp/deploy-verify-task2
git checkout -q -b feature/issue-527-playwright-migration origin/feature/issue-527-playwright-migration

# Simulate the mismatch scenario: request a nonexistent branch name, exactly
# like the "pr538" typo that caused the original incident.
bash scripts/deploy/switch-branch.sh "totally-nonexistent-branch" /tmp/deploy-verify-task2 >> /tmp/deploy-verify-task2-logs/dev-deploy.log 2>&1
SWITCH_RC=$?
tail -n 30 /tmp/deploy-verify-task2-logs/dev-deploy.log
echo "switch-branch.sh exit code: $SWITCH_RC"
if [ "$SWITCH_RC" -ne 0 ]; then
  echo "[ERROR] switch-branch.sh failed (exit $SWITCH_RC) — would abort deploy without building."
fi
```

Expected: `switch-branch.sh` exits `3` (per its documented exit codes — "Branch does not exist on origin"), its `[ERROR][switch-branch] Branch 'totally-nonexistent-branch' not found on origin.` line appears in `/tmp/deploy-verify-task2-logs/dev-deploy.log` (proving the capture-to-logfile works), and the final `[ERROR]` line prints, confirming that in the real `.ps1` flow `deploy.sh` would never be invoked in this scenario. Then confirm the happy path:

```bash
bash scripts/deploy/switch-branch.sh "feature/issue-527-playwright-migration" /tmp/deploy-verify-task2 >> /tmp/deploy-verify-task2-logs/dev-deploy.log 2>&1
SWITCH_RC=$?
echo "switch-branch.sh exit code: $SWITCH_RC"
```

Expected: exit code `0`.

- [ ] **Step 5: Clean up**

```bash
rm -rf /tmp/deploy-verify-task2 /tmp/deploy-verify-task2-logs
```

- [ ] **Step 6: Commit**

```bash
git add scripts/deploy/dev-deploy.ps1 scripts/deploy/prod-deploy.ps1
git commit -m "fix(#542): abort deploy if switch-branch.sh fails, log its output

dev-deploy.ps1 and prod-deploy.ps1 ran switch-branch.sh and deploy.sh as
two unchained SSH commands, so a failed branch switch (e.g. a typo'd
branch name) didn't stop deploy.sh from running against whatever was
already checked out. switch-branch.sh's own output also never reached
the server-side deploy log, only the operator's terminal.

Now switch-branch.sh's output is appended to the same dev/prod-deploy.log
deploy.sh writes to, and a non-zero exit aborts before deploy.sh runs."
```

---

### Task 3: Update docs

**Files:**
- Modify: `docs/DEV_ENVIRONMENT.md`
- Modify: `docs/PROD_ENVIRONMENT.md`
- Modify: `docs/CHANGELOG.md`

**Interfaces:**
- None (docs only).

- [ ] **Step 1: Read the current deploy-flow sections**

```bash
grep -n "switch-branch" /home/modnar3/MyPortfolioSite-dev/docs/DEV_ENVIRONMENT.md
grep -n "switch-branch" /home/modnar3/MyPortfolioSite-dev/docs/PROD_ENVIRONMENT.md
```

- [ ] **Step 2: Add a short note to `docs/DEV_ENVIRONMENT.md`**

Immediately after the existing `switch-branch.sh` example block (the one at the line found in Step 1 nearest to the "dev-deploy.ps1" description), add:

```markdown
> **Fail-loud guarantee (#542):** `dev-deploy.ps1` now aborts before `deploy.sh` runs if `switch-branch.sh` fails (e.g. an unrecognised branch name) — it no longer silently deploys whatever was already checked out. `switch-branch.sh`'s own output is appended to `~/logs/dev-deploy.log` alongside the rest of the deploy report, so a failed branch switch is visible in the same log file. `deploy.sh` also independently verifies it's on the requested branch before doing any build/test work, as a second line of defense.
```

- [ ] **Step 3: Add the matching note to `docs/PROD_ENVIRONMENT.md`**

Immediately after the existing `switch-branch.sh` example block there, add:

```markdown
> **Fail-loud guarantee (#542):** `prod-deploy.ps1` now aborts before `deploy.sh` runs if `switch-branch.sh` fails, instead of silently deploying whatever was already checked out. `switch-branch.sh`'s own output is appended to `~/logs/prod-deploy.log`. `deploy.sh` also independently verifies it's on the requested branch (always `main` for prod) before doing any build/test work.
```

- [ ] **Step 4: Add a CHANGELOG entry**

Read `docs/CHANGELOG.md`'s `[Unreleased]` → `### Fixed` section format first:

```bash
sed -n '1,30p' /home/modnar3/MyPortfolioSite-dev/docs/CHANGELOG.md
```

Add an entry matching the existing style (same heading level, same bullet format as neighboring entries), under `### Fixed`:

```markdown
- Deploy scripts (`dev-deploy.ps1`, `prod-deploy.ps1`) no longer silently deploy the wrong branch when `switch-branch.sh` fails — the deploy now aborts and logs the failure to the server-side deploy log; `deploy.sh` independently verifies the checked-out branch before building (#542)
```

- [ ] **Step 5: Commit**

```bash
git add docs/DEV_ENVIRONMENT.md docs/PROD_ENVIRONMENT.md docs/CHANGELOG.md
git commit -m "docs(#542): document deploy fail-loud branch verification"
```
