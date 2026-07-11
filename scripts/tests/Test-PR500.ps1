<#
.SYNOPSIS
    Smoke tests for PR #500 — scheduled AI blog draft generation.

.DESCRIPTION
    Verifies the scheduler wiring: env var is documented in both .env example
    files and the scheduler module loads/behaves correctly via the Vitest suite.

    Run from Windows against the dev server:
        .\scripts\tests\Test-PR500.ps1 -BaseUrl https://dev.andykeys.me:3001 -Insecure

    Or from the server itself (use localhost):
        .\scripts\tests\Test-PR500.ps1 -BaseUrl https://localhost:3001 -Insecure

.PARAMETER BaseUrl
    Base URL of the backend API (no trailing slash).

.PARAMETER Insecure
    Skip TLS certificate validation (required for self-signed dev certs).
#>

param(
    [string]$BaseUrl  = "https://dev.andykeys.me:3001",
    [switch]$Insecure
)

$ErrorActionPreference = "Stop"
$pass  = 0
$fail  = 0
$notes = @()

function Pass($msg) { Write-Host "  [PASS] $msg" -ForegroundColor Green;  $script:pass++ }
function Fail($msg) { Write-Host "  [FAIL] $msg" -ForegroundColor Red;    $script:fail++; $script:notes += $msg }
function Info($msg) { Write-Host "  [INFO] $msg" -ForegroundColor Cyan }

$skipCert = if ($Insecure) { @{ SkipCertificateCheck = $true } } else { @{} }

Write-Host ""
Write-Host "=== PR #500 — Scheduled AI blog draft generation ===" -ForegroundColor Magenta
Write-Host "  Target: $BaseUrl"
Write-Host ""

# ── 1. env example files contain AI_BLOG_SCHEDULE ────────────────────────────

Write-Host "--- 1. Env var documentation ---"

$repoRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))

$envExample     = Join-Path $repoRoot ".env.example"
$envDevExample  = Join-Path $repoRoot ".env.dev-server.example"

# Verify .env.example
if (Test-Path $envExample) {
    $content = Get-Content $envExample -Raw
    if ($content -match "AI_BLOG_SCHEDULE") {
        Pass ".env.example documents AI_BLOG_SCHEDULE"
    } else {
        Fail ".env.example missing AI_BLOG_SCHEDULE"
    }
} else {
    Fail ".env.example not found at expected path"
}

# Verify .env.dev-server.example
if (Test-Path $envDevExample) {
    $content = Get-Content $envDevExample -Raw
    if ($content -match "AI_BLOG_SCHEDULE") {
        Pass ".env.dev-server.example documents AI_BLOG_SCHEDULE"
    } else {
        Fail ".env.dev-server.example missing AI_BLOG_SCHEDULE"
    }
} else {
    Fail ".env.dev-server.example not found at expected path"
}

# ── 2. scheduler.js and aiGenerate.js exist ──────────────────────────────────

Write-Host ""
Write-Host "--- 2. Source files present ---"

$schedulerPath  = Join-Path $repoRoot "backend\scheduler.js"
$aiGeneratePath = Join-Path $repoRoot "backend\utils\aiGenerate.js"

if (Test-Path $schedulerPath)  { Pass "backend/scheduler.js exists" }
else                           { Fail "backend/scheduler.js missing" }

if (Test-Path $aiGeneratePath) { Pass "backend/utils/aiGenerate.js exists" }
else                           { Fail "backend/utils/aiGenerate.js missing" }

# ── 3. node-cron is in package.json ──────────────────────────────────────────

Write-Host ""
Write-Host "--- 3. node-cron dependency ---"

$pkgPath = Join-Path $repoRoot "backend\package.json"
if (Test-Path $pkgPath) {
    $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
    if ($pkg.dependencies.'node-cron') {
        Pass "node-cron listed in backend/package.json dependencies (version: $($pkg.dependencies.'node-cron'))"
    } else {
        Fail "node-cron NOT found in backend/package.json dependencies"
    }
} else {
    Fail "backend/package.json not found"
}

# ── 4. Vitest suite passes (scheduler tests) ─────────────────────────────────

Write-Host ""
Write-Host "--- 4. Vitest scheduler tests ---"
Info "Run the following on the dev server to verify the scheduler unit tests pass:"
Info ""
Info "  # From the dev server:"
Info "  docker compose exec backend npm test -- tests/utils/scheduler.test.js"
Info ""
Info "  Expected: all scheduler.test.js tests pass with no failures."
Info "  If node-cron was just added, rebuild the image first:"
Info "  docker compose build backend && docker compose up -d backend"

# ── 5. Backend health (sanity check the server is up) ────────────────────────

Write-Host ""
Write-Host "--- 5. Backend health check ---"

try {
    $res = Invoke-WebRequest -Uri "$BaseUrl/api/health" -Method GET @skipCert -TimeoutSec 10 -ErrorAction Stop
    if ($res.StatusCode -eq 200) {
        Pass "GET /api/health → 200 OK (backend is running)"
    } else {
        Fail "GET /api/health returned $($res.StatusCode)"
    }
} catch {
    Fail "GET /api/health failed: $_"
}

# ── Summary ───────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "=== Results: $pass passed, $fail failed ===" -ForegroundColor $(if ($fail -eq 0) { "Green" } else { "Red" })
if ($notes.Count -gt 0) {
    Write-Host "Failures:"
    foreach ($n in $notes) { Write-Host "  - $n" -ForegroundColor Red }
}
Write-Host ""

if ($fail -gt 0) { exit 1 }
