# Testing Guide

Tests are performed in two stages: **server-based integration testing** (primary) and **unit/integration tests** (supplementary).

---

## Primary: Server-Based Testing

The dev server at `http://<LAN_IP>:3001` is the canonical test environment. Deploy your feature/fix branch and test in a real environment with database, authentication, and file uploads.

### Workflow

1. **Deploy your branch** to the dev server:
   ```powershell
   git checkout fix/your-issue
   .\scripts\deploy\dev-deploy.ps1
   ```

2. **Test the feature** in a browser at `https://<SITE_HOST>:3001`
   - Test the golden path (happy case)
   - Test error cases and edge conditions
   - Check for regressions in related features

3. **View server logs** if something fails:
   ```bash
   docker compose -f ~/MyPortfolioSite-dev/docker-compose.yml logs -f backend
   ```

4. **If tests pass**, create a PR and merge to `dev`

This approach catches integration issues that unit tests cannot (database state, authentication, third-party services) and lets you test on a real environment before committing.

### Automatic tests during deploy

Dev and prod deploy scripts now run automated checks as part of every deployment to the server:

- **Backend Vitest suite** runs inside the already-deployed container (`backend` on both dev and prod). If `npm test` fails in the container, the deploy script rolls back to a known-good state and marks the deploy as failed.
- **HTTP regression smoke tests** run via `scripts/tests/test-regression.sh` against the live site (dev: `https://<SITE_HOST>:3001`, prod: `https://<SITE_HOST>`). These tests hit core public and auth-protected endpoints and will also fail the deploy if they do not pass.

You can skip the regression smoke tests (for example, during quick iteration) by passing the `-SkipRegression` boolean parameter to the PowerShell wrappers (`$true`/`$false`, defaults to `$false`):

```powershell
# Dev deploy without regression smoke tests
.\scripts\deploy\dev-deploy.ps1 -SkipRegression $true

# Prod deploy without regression smoke tests
.\scripts\deploy\prod-deploy.ps1 -SkipRegression $true
```

Vitest remains part of the normal `npm test` flow (locally and in CI), but it is now also executed automatically inside the dev/prod backend containers during every deploy.

---

## Supplementary: Unit & Integration Tests

The backend test suite uses [Vitest](https://vitest.dev/) as the test runner and [Supertest](https://github.com/ladjs/supertest) for HTTP-layer integration tests. No live server, database, or network connection is required — the `pg` pool and `nodemailer` are mocked at the module level.

These tests catch regressions quickly but **do not replace server-based testing**.

### Quick start

```powershell
# 1. Make sure the dev environment is running
. scripts\dev\dev-local.ps1 up

# 2. Run the test suite
. scripts\dev\dev-local.ps1 test

# 3. Run tests with a coverage report
. scripts\dev\dev-local.ps1 test:coverage
```

The `test` command installs devDependencies inside the container (vitest, supertest) then runs `npm test`. This is safe to run repeatedly — `npm install` is a no-op if nothing has changed.

### Manual test commands

```powershell
# Run tests
docker compose exec backend npm install --silent
docker compose exec backend npm test

# Watch mode (re-runs on file save)
docker compose exec backend npm run test:watch

# Coverage report
docker compose exec backend npm run test:coverage
```

> **Note:** The Vitest suite runs automatically inside the deployed container on every dev/prod deploy (see "Automatic tests during deploy" above) — that is the canonical path. The suite mocks `pg` and `nodemailer` so it needs no database, which is also what lets CI run it host-side (`cd backend && npm install && npm test`, see [CI](#ci)). Day-to-day verification is done by deploying to the dev server, not by running tests locally.

---

## Browser-Level Tests

Puppeteer scripts run automatically inside the backend container after every dev/prod deploy (gated by `RUN_ERROR_LOGGER=1`; the backend image ships Chromium). They reach nginx by its docker-internal service name (`NGINX_URL`).

| Script | npm script | What it verifies |
|---|---|---|
| `test-error-logger.js` | `test:error-logger` | Error logger initialises and reports on the `/api/debug/test-errors` page |
| `test-error-logger-all-pages.js` | `test:error-logger:all-pages` | Logger initialises on every public page (`/`, `/blog/`, `/travel/`, `/login/`) |
| `test-error-logger-browser.js` | `test:error-logger:browser` | Behavioural **contracts** (see below) via request interception |
| `test-csp-violations.js` | `test:csp-violations` | No first-party CSP violations on any page — catches missing allowlist entries (#341) |

### Contract test (`test-error-logger-browser.js`)

Uses Puppeteer request interception to capture POSTs to `/api/debug/errors` and simulate the backend being up/down — so buffering can be exercised without actually taking the backend down. Verifies the *deployed* `error-logger.js`:

| # | Contract | Related issue |
|---|------|---------------|
| 1 | Resource-load failures (broken `<script src>`) captured via the capture-phase listener | #332 |
| 2 | Runtime errors logged exactly once — capture-phase listener does not duplicate them | #332 |
| 3 | Reports persisted to `localStorage` when the backend is unreachable | #334 |
| 4 | Buffered reports flushed and `localStorage` cleared once the backend returns | #334 |
| 5 | No browser hang when five errors fire against a failing backend | #331 |

It prints a machine-parseable summary line collected into the deploy report:
```
[error-logger-browser] status=OK passed=8 failed=0
```

### Failure policy

The error-logger tests are **warn-only** — a failure is surfaced loudly inline in the deploy report but does **not** roll the deploy back (unlike Vitest, which does). This avoids a frontend timing flake blocking a deploy. Treat a `status=failed` line as a must-fix even though the deploy proceeded.

### Running manually

These tests need a base URL (the running site). Run them on the dev server from the deployed checkout, or against any reachable instance:

```bash
# Dev: NGINX_SERVICE=nginx, NGINX_PORT=3001 → docker-internal URL https://nginx:3001
cd ~/MyPortfolioSite-dev
docker compose -f docker-compose.yml -p portfolio_dev exec -T backend \
  npm run test:error-logger:browser -- https://nginx:3001
```

### CSP violation scan (`test-csp-violations.js`)

Loads every served page (`/`, `/blog/`, `/travel/`, `/login/`, `/admin/`, `/setup/`) in a real browser and listens for `securitypolicyviolation` events (#341). Reports any blocked resource with the directive, source, and remediation instruction. ISP-injected inline-script noise is expected; maintainers can record known-noise patterns in the `KNOWN_NOISE` array inside the script to suppress specific entries.

Machine-parseable summary:
```
[csp-violations] status=OK pages=6 violations=0
```

### When to run

- Automatically: every dev/prod deploy
- Manually after any change to `resources/js/error-logger.js` or `backend/routes/debug.js`
- Manually after adding or moving any external resource (script, style, font, image, API origin) — verifies the CSP allowlist update is correct
- Run against the dev server before raising a PR that touches CSP or external resources:
  ```bash
  cd ~/MyPortfolioSite-dev
  docker compose -f docker-compose.yml exec -T backend \
    npm run test:csp-violations -- https://nginx:3001
  ```

---

## Fallback: Local Testing (Windows)

If you cannot access the dev server, you can still validate code changes locally with the test suite and smoke tests.

### Capturing Test Output

Test output is verbose and scrolls quickly. There are two patterns depending on context:

### Ad-hoc commands — use `Tee-Object`

Pipe any command through `Tee-Object` to write output to a timestamped file **and** keep it visible in the terminal simultaneously:

```powershell
. scripts\dev\dev-local.ps1 test | Tee-Object -FilePath "test-results\run-$(Get-Date -Format 'yyyyMMdd-HHmmss').txt"
```

### Regression smoke tests

Regression tests run automatically at the end of every deploy (inside `deploy.sh`). They are defined in `scripts/tests/test-regression.sh` and execute on the server against the live site. On failure, each test prints `[FAIL] <name> — Expected N got M | body: ...` or `| curl error: ...` for connection-level failures.

To skip regression tests during a quick iteration deploy, or suppress verbose step output:

```powershell
.\scripts\deploy\dev-deploy.ps1 -SkipRegression $true              # skip regression tests only
.\scripts\deploy\dev-deploy.ps1 -Quiet $true                       # suppress verbose logs; show only checkpoints + report
.\scripts\deploy\dev-deploy.ps1 -Quiet $true -SkipRegression $true # both

.\scripts\deploy\prod-deploy.ps1 -SkipRegression $true
.\scripts\deploy\prod-deploy.ps1 -Quiet $true
```

In quiet mode, `dinfo`/`dok`/`dsection` output is suppressed on-screen. Warnings, errors, rollback events, and the final deploy report always print regardless.

To run them manually on the server:

```bash
bash ~/MyPortfolioSite-dev/scripts/tests/test-regression.sh \
  --base-url https://dev.andykeys.me:3001 \
  --compose-file ~/MyPortfolioSite-dev/docker-compose.yml \
  --service backend \
  --insecure
```

### Deploy report

Every deploy ends with a structured report block that collects all `[deploy:*]` and `[regression]` checkpoint lines:

```
╔════════════════════════════════════════════════════════════════════════════╗
║  Deploy Report — dev — 2026-05-17 13:30:00                                 ║
╠════════════════════════════════════════════════════════════════════════════╣
║  [deploy:preflight] status=ok tools=docker git curl openssl                ║
║  [deploy:git] status=updated branch=feat/x pre=abc1234 sha=def5678         ║
║  [deploy:compose] status=ok service=backend                                ║
║  [deploy:health] status=ok url=https://dev.andykeys.me:3001/api/h… attem… ║
║  [deploy:vitest] status=ok service=backend                                 ║
║  [deploy:summary] status=ok env=dev branch=feat/x sha=def5678              ║
║  [regression] status=OK passed=12 failed=0 skipped=0 total=12              ║
╚════════════════════════════════════════════════════════════════════════════╝
```

This block is the canonical answer to "what happened?" — paste it into PR comments or AI prompts. Full verbose output is still written to the log file.

### PR smoke tests

Every PR that touches backend code should also have a `Test-PR<N>.ps1` script covering the new or changed endpoints. These still run from Windows against the dev server:

```powershell
# Output goes to console AND test-results\PR<N>-<timestamp>.txt automatically
.\scripts\tests\Test-PR<N>.ps1 -BaseUrl https://dev.andykeys.me:3001 -Insecure
```

### Setup (one-time)

Create the `test-results\` folder if it doesn't exist. It is gitignored so logs never get committed:

```powershell
New-Item -ItemType Directory -Force -Path test-results
```

### PR Smoke Tests (Fallback)

If you're testing locally without access to the dev server, every PR that touches backend code should still be covered by a `Test-PR<N>.ps1` script before requesting review:

```powershell
. scripts\tests\Test-PR<N>.ps1
```

The regression baseline is now handled server-side by `test-regression.sh` as part of the dev/prod deploys. PR-specific scripts should focus only on the endpoints and behaviour introduced or changed by the PR.

### What each script covers

| Script | Purpose |
|---|---|
| `test-regression.sh` | Stable always-run baseline: core public endpoints, key auth checks, 404 handler — runs server-side post-deploy |
| `Test-PR<N>.ps1` | Endpoints and behaviour introduced or changed by PR #N only — run from Windows when dev server access is available or as a local fallback |

### Script template — Test-PR\<N\>.ps1

When creating a `Test-PR<N>.ps1` script for a new PR, place it in `scripts/tests/` and use this as the starting point. The key requirements are:
1. **`Start-Transcript` / `Stop-Transcript`** — output always captured without the caller needing flags
2. **Auto-generate JWT** from the container — no hardcoded secrets, no manual token passing
3. **`$PSScriptRoot '../..' 'test-results'`** path — resolves correctly from `scripts/tests/`
4. **All POST bodies** use `@{} | ConvertTo-Json -Compress` — avoids PowerShell/curl escaping failures on Windows

```powershell
#Requires -Version 5.1
param(
    [string]$Token      = '',
    [string]$BaseUrl    = 'http://localhost',
    [switch]$SkipVitest
)

# Output capture — console AND timestamped file
$resultsDir = Join-Path $PSScriptRoot '..' '..' 'test-results'
if (-not (Test-Path $resultsDir)) {
    New-Item -ItemType Directory -Force -Path $resultsDir | Out-Null
}
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile   = Join-Path $resultsDir "PR<N>-$timestamp.txt"
Start-Transcript -Path $logFile -Append | Out-Null

# Auto-generate JWT if not provided
if (-not $Token) {
    try {
        $generated = docker compose exec -T backend node -e @"
const jwt = require('jsonwebtoken');
if (!process.env.JWT_SECRET) { process.stderr.write('NO_SECRET'); process.exit(1); }
console.log(jwt.sign({ userId: 'dev-test-user' }, process.env.JWT_SECRET, { expiresIn: '1h' }));
"@ 2>&1
        $generated = ($generated | Where-Object { $_ -notmatch '^npm ' } | Select-Object -Last 1).Trim()
        if ($generated -match '^eyJ') { $Token = $generated }
    } catch {}
}

$pass = 0; $fail = 0; $skip = 0; $results = @()

function Test-Endpoint {
    param(
        [string]$Name,
        [string]$Method,
        [string]$Url,
        [string]$Body       = '',
        [string[]]$Headers  = @(),
        [int]$ExpectStatus,
        [string]$ExpectBody = '',
        [bool]$RequiresAuth = $false
    )
    if ($RequiresAuth -and -not $Token) {
        Write-Host "  [SKIP] $Name (no token available)" -ForegroundColor DarkYellow
        $script:skip++
        $script:results += [PSCustomObject]@{ Result = 'SKIP'; Name = $Name; Detail = 'No token' }
        return
    }
    $curlArgs = @('-s', '-o', 'tmp_body.txt', '-w', '%{http_code}', '-X', $Method)
    foreach ($h in $Headers) { $curlArgs += @('-H', $h) }
    if ($Body) { $curlArgs += @('-d', $Body) }
    $curlArgs += $Url
    $statusCode = curl.exe @curlArgs
    $bodyText   = if (Test-Path tmp_body.txt) { Get-Content tmp_body.txt -Raw } else { '' }
    if (Test-Path tmp_body.txt) { Remove-Item tmp_body.txt -Force }
    $passed = ([int]$statusCode -eq $ExpectStatus) -and ((-not $ExpectBody) -or ($bodyText -like "*$ExpectBody*"))
    if ($passed) {
        Write-Host "  [PASS] $Name" -ForegroundColor Green
        $script:pass++
        $script:results += [PSCustomObject]@{ Result = 'PASS'; Name = $Name; Detail = "$statusCode" }
    } else {
        $detail = "Expected $ExpectStatus got $statusCode"
        if ($bodyText -notlike "*$ExpectBody*") { $detail += " | body: $($bodyText.Trim())" }
        Write-Host "  [FAIL] $Name — $detail" -ForegroundColor Red
        $script:fail++
        $script:results += [PSCustomObject]@{ Result = 'FAIL'; Name = $Name; Detail = $detail }
    }
}

Write-Host ""
Write-Host ("═" * 54) -ForegroundColor Cyan
Write-Host "  PR #<N> Test Run — $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Cyan
Write-Host "  Base URL : $BaseUrl"
Write-Host "  Token    : $(if ($Token) { 'auto-generated from container' } else { 'not available (auth tests skipped)' })"
Write-Host "  Log file : $logFile"
Write-Host ("═" * 54) -ForegroundColor Cyan

# --- add Test-Endpoint calls here (new/changed endpoints for this PR only) ---
# Do NOT duplicate checks already covered by test-regression.sh

Write-Host ""
Write-Host ("═" * 54) -ForegroundColor Cyan
Write-Host "  PASSED : $pass" -ForegroundColor Green
if ($skip -gt 0) { Write-Host "  SKIPPED: $skip" -ForegroundColor DarkYellow }
Write-Host "  FAILED : $fail" -ForegroundColor $(if ($fail -gt 0) { 'Red' } else { 'Green' })
Write-Host ("═" * 54) -ForegroundColor Cyan
Write-Host "  Full log: $logFile" -ForegroundColor DarkGray
Write-Host ""

Stop-Transcript | Out-Null
if ($fail -gt 0) { exit 1 } else { exit 0 }
```

Name the script `scripts/tests/Test-PR<N>.ps1` and replace the two `<N>` placeholders.

---

## Test Structure

All test files live under `backend/tests/`, mirroring the source structure.

```
backend/
└── tests/
    ├── middleware/
    │   ├── validate.test.js      ← Zod schema unit tests (all schemas)
    │   └── errorHandler.test.js  ← Error handler unit tests
    └── routes/
        ├── contact.test.js       ← Contact route integration tests
        ├── posts.test.js         ← Posts route integration tests
        └── travel.test.js        ← Travel route integration tests
```

New test files should follow the same path convention: `tests/<layer>/<source-file>.test.js`.

---

## What Is Tested

### Priority 1 — Validation middleware (`validate.test.js`)

Unit tests for every Zod schema exported from `middleware/validate.js`. Each schema is tested with:
- A valid input that should pass through with `next()` called
- Invalid inputs that should return `400 { error }` with a meaningful message
- Coercion and default behaviour (e.g. lat/lng string → number, `body_markdown` defaulting to `''`)

### Priority 2 — Route integration tests

Mounts each router against the full Express app via Supertest with the `pg` pool mocked. Verifies:
- `401` is returned for missing or invalid JWT on all protected routes
- `400` is returned with the correct `{ error }` shape when required fields are missing
- The DB query spy is **not** called when validation rejects a request (proves validation fires before DB)

### Priority 3 — Error handler (`errorHandler.test.js`)

- Returns `{ error }` JSON with the correct status code
- Respects `err.status` and `err.statusCode`
- Falls back to 500 when no status is set
- Skips `console.error` when `NODE_ENV=test`
- Does not respond if `res.headersSent` is true

---

## What Is Intentionally Not Tested

| Area | Reason |
|---|---|
| WebAuthn passkey registration/login | Requires a real browser authenticator; the `@simplewebauthn/server` library call is mocked at the boundary |
| Email delivery (nodemailer) | Requires real SMTP credentials; nodemailer is mocked — the send path is covered by the contact route tests |
| Contact form in local dev | When `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` are not set, the route logs the submission to the backend console and returns `{ success: true }` — no email is sent. This is the expected behaviour in the Docker dev environment; the form UI will appear to succeed. Check the backend container logs (`docker compose logs backend`) to see the submitted values. |
| Database queries | Integration tests mock the pg pool; real DB behaviour is covered by manual smoke testing against the dev Docker DB |
| Frontend JavaScript | Out of scope for the backend suite; covered by manual browser testing |

---

## Adding New Tests

When adding a new route or middleware:

1. Create `backend/tests/<layer>/<filename>.test.js`
2. Mock `pg` at the top of the file with `vi.mock('pg', ...)`
3. Import `createApp` from `../../app.js` and pass it to `supertest()`
4. Use `jwt.sign({ userId: 'test-user' }, process.env.JWT_SECRET, ...)` for authenticated requests — `JWT_SECRET` is injected by `vitest.config.js`
5. Run `. scripts\dev\dev-local.ps1 test` to verify

### Test file template

```js
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import jwt     from 'jsonwebtoken';
import { createApp } from '../../app.js';

vi.mock('pg', () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const Pool  = vi.fn(() => ({ query }));
  return { default: { Pool }, Pool };
});

const app = createApp();

function makeToken() {
  return jwt.sign({ userId: 'test-user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('GET /your-route', () => {
  it('returns 401 without JWT', async () => {
    const res = await request(app).get('/your-route');
    expect(res.status).toBe(401);
  });
});
```

---

## CI

Once a CI pipeline is added (tracked in issue #98), the test command will be:

```yaml
- name: Run tests
  run: |
    cd backend
    npm install
    npm test
```

In CI, Node runs directly (no Docker wrapper needed) so `npm install` and `npm test` are called directly in the workflow step.
