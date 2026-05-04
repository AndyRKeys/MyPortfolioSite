# Testing Guide

The backend test suite uses [Vitest](https://vitest.dev/) as the test runner and [Supertest](https://github.com/ladjs/supertest) for HTTP-layer integration tests. No live server, database, or network connection is required — the `pg` pool and `nodemailer` are mocked at the module level.

---

## Running Tests

The dev environment runs inside Docker. Tests must be run **inside the backend container** — not directly on your local machine. The source directory is volume-mounted into the container, so any local file changes are immediately reflected without rebuilding.

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

### Manual (if you prefer)

```powershell
# Run tests
docker compose exec backend npm install --silent
docker compose exec backend npm test

# Watch mode (re-runs on file save)
docker compose exec backend npm run test:watch

# Coverage report
docker compose exec backend npm run test:coverage
```

> **Note:** Do not run `npm test` directly on your local machine unless you have Node 20 installed locally. The canonical test environment is the Docker container.

---

## Capturing Test Output

Test output is verbose and scrolls quickly. There are two patterns depending on context:

### Ad-hoc commands — use `Tee-Object`

Pipe any command through `Tee-Object` to write output to a timestamped file **and** keep it visible in the terminal simultaneously:

```powershell
. scripts\dev\dev-local.ps1 test | Tee-Object -FilePath "test-results\run-$(Get-Date -Format 'yyyyMMdd-HHmmss').txt"
```

### PR validation scripts — use `Start-Transcript` (built in)

All `scripts/tests/Test-PR*.ps1` scripts use `Start-Transcript` internally, so output is captured automatically — no extra flags needed. Token generation is also automatic:

```powershell
# Output goes to console AND test-results\PR104-<timestamp>.txt automatically
# JWT is auto-generated from the container — no -Token flag required
.\scripts\tests\Test-PR104.ps1
```

The log file path is printed in the script header and footer so you always know where to find it.

### Setup (one-time)

Create the `test-results\` folder if it doesn't exist. It is gitignored so logs never get committed:

```powershell
New-Item -ItemType Directory -Force -Path test-results
```

---

## PR Validation Script Template

When creating a `Test-PR<N>.ps1` script for a new PR, place it in `scripts/tests/` and use this as the starting point. The key requirements are:
1. **`Start-Transcript` / `Stop-Transcript`** — output always captured without the caller needing flags
2. **Auto-generate JWT** from the container — no hardcoded secrets, no manual token passing
3. **`$PSScriptRoot '../..' 'test-results'`** path — resolves correctly from `scripts/tests/`

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
Write-Host "═" * 54 -ForegroundColor Cyan
Write-Host "  PR #<N> Test Run — $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Cyan
Write-Host "  Base URL : $BaseUrl"
Write-Host "  Token    : $(if ($Token) { 'auto-generated from container' } else { 'not available (auth tests skipped)' })"
Write-Host "  Log file : $logFile"
Write-Host "═" * 54 -ForegroundColor Cyan

# --- add Test-Endpoint calls here ---

Write-Host ""
Write-Host "═" * 54 -ForegroundColor Cyan
Write-Host "  PASSED : $pass" -ForegroundColor Green
if ($skip -gt 0) { Write-Host "  SKIPPED: $skip" -ForegroundColor DarkYellow }
Write-Host "  FAILED : $fail" -ForegroundColor $(if ($fail -gt 0) { 'Red' } else { 'Green' })
Write-Host "═" * 54 -ForegroundColor Cyan
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
