#Requires -Version 5.1
<#
.SYNOPSIS
    Baseline regression test suite — run on every PR that touches backend code.

.DESCRIPTION
    Covers the stable, always-run checks extracted from the PR-specific test
    scripts. Run this first, then run the PR-specific Test-PR<N>.ps1 on top.

.PARAMETER Token
    JWT bearer token. If omitted, the script auto-generates one from the
    running backend container using the container's JWT_SECRET.

.PARAMETER BaseUrl
    Base URL of the running dev server. Defaults to http://localhost.

.PARAMETER SkipVitest
    Skip the Vitest unit/integration suite (useful for quick smoke runs).

.PARAMETER SkipSecurity
    Skip the security headers check (scripts/ops/security-debug-report.sh).

.EXAMPLE
    # Standard run — Vitest + security + all regression checks
    . scripts\tests\Test-Regression.ps1

    # Skip Vitest (faster)
    . scripts\tests\Test-Regression.ps1 -SkipVitest

    # Skip security check (e.g. running against non-localhost target)
    . scripts\tests\Test-Regression.ps1 -SkipSecurity
#>
param(
    [string]$Token      = '',
    [string]$BaseUrl    = 'http://localhost',
    [switch]$SkipVitest,
    [switch]$SkipSecurity
)

# ── Output capture — console AND timestamped file ─────────────────────────────────
$resultsDir = Join-Path $PSScriptRoot '..' '..' 'test-results'
if (-not (Test-Path $resultsDir)) {
    New-Item -ItemType Directory -Force -Path $resultsDir | Out-Null
}
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile   = Join-Path $resultsDir "Regression-$timestamp.txt"
Start-Transcript -Path $logFile -Append | Out-Null

# ── Auto-generate JWT if not provided ──────────────────────────────────────────
if (-not $Token) {
    try {
        Write-Host "  [INFO] No -Token provided — attempting to generate dev JWT from container..." -ForegroundColor DarkGray
        $generated = docker compose exec -T backend node -e @"
const jwt = require('jsonwebtoken');
if (!process.env.JWT_SECRET) { process.stderr.write('NO_SECRET'); process.exit(1); }
console.log(jwt.sign({ userId: 'dev-test-user' }, process.env.JWT_SECRET, { expiresIn: '1h' }));
"@ 2>&1
        $generated = ($generated | Where-Object { $_ -notmatch '^npm ' } | Select-Object -Last 1).Trim()
        if ($generated -match '^eyJ') {
            $Token = $generated
            Write-Host "  [INFO] Dev JWT generated from container JWT_SECRET (1h expiry)" -ForegroundColor DarkGray
        }
    } catch {}
}

$pass = 0; $fail = 0; $skip = 0; $results = @()

# ── Test-Endpoint helper ─────────────────────────────────────────────────────────────────
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

# ── Header ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host ("═" * 60) -ForegroundColor Cyan
Write-Host "  Regression Test Run — $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Cyan
Write-Host "  Base URL : $BaseUrl"
Write-Host "  Token    : $(if ($Token) { 'auto-generated from container' } else { 'not provided — auth tests skipped' })"
Write-Host "  Log file : $logFile"
Write-Host ("═" * 60) -ForegroundColor Cyan
Write-Host ""

# ── Vitest unit + integration suite ─────────────────────────────────────────────────
if (-not $SkipVitest) {
    Write-Host "--- Vitest unit + integration suite ---" -ForegroundColor Yellow
    Write-Host "  Running inside backend container..."
    docker compose exec -T backend npm test 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [PASS] Vitest suite" -ForegroundColor Green
        $pass++
    } else {
        Write-Host "  [FAIL] Vitest suite" -ForegroundColor Red
        $fail++
    }
    Write-Host ""
}

# ── Security headers check ──────────────────────────────────────────────────────────
if (-not $SkipSecurity) {
    Write-Host "--- Security headers check ---" -ForegroundColor Yellow
    bash scripts/ops/security-debug-report.sh $BaseUrl 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [PASS] Security headers check" -ForegroundColor Green
        $pass++
    } else {
        Write-Host "  [FAIL] Security headers check — review output above" -ForegroundColor Red
        $fail++
    }
    Write-Host ""
}

# ── No-auth baseline checks ────────────────────────────────────────────────────────────
Write-Host "--- No-auth baseline ---" -ForegroundColor Yellow

Test-Endpoint -Name "GET /api/posts returns 200" `
    -Method "GET" -Url "$BaseUrl/api/posts" `
    -ExpectStatus 200

$missingNameBody = @{ email = 'test@example.com'; message = 'hello' } | ConvertTo-Json -Compress
Test-Endpoint -Name "POST /api/contact missing name returns 400" `
    -Method "POST" -Url "$BaseUrl/api/contact" `
    -Headers @('Content-Type: application/json') `
    -Body $missingNameBody `
    -ExpectStatus 400

$invalidEmailBody = @{ name = 'Test'; email = 'not-an-email'; message = 'hello' } | ConvertTo-Json -Compress
Test-Endpoint -Name "POST /api/contact invalid email returns 400" `
    -Method "POST" -Url "$BaseUrl/api/contact" `
    -Headers @('Content-Type: application/json') `
    -Body $invalidEmailBody `
    -ExpectStatus 400

Test-Endpoint -Name "GET /api/cv/exists returns 200 with 'exists' field" `
    -Method "GET" -Url "$BaseUrl/api/cv/exists" `
    -ExpectStatus 200 -ExpectBody "exists"

Test-Endpoint -Name "POST /api/stats/visit?page=unknown returns 400" `
    -Method "POST" -Url "$BaseUrl/api/stats/visit?page=unknown" `
    -ExpectStatus 400

Test-Endpoint -Name "GET /api/health returns 200 with status ok" `
    -Method "GET" -Url "$BaseUrl/api/health" `
    -ExpectStatus 200 -ExpectBody "ok"

Test-Endpoint -Name "Unknown route returns 404" `
    -Method "GET" -Url "$BaseUrl/api/does-not-exist" `
    -ExpectStatus 404

Write-Host ""

# ── Auth-required baseline checks ────────────────────────────────────────────────────────────
Write-Host "--- Auth-required baseline ---" -ForegroundColor Yellow

$missingTitleBody = @{
    body_markdown = 'test'
    post_date     = '2026-01-01'
    post_type     = 'blog'
} | ConvertTo-Json -Compress
Test-Endpoint -Name "POST /api/posts missing title returns 400" `
    -Method "POST" -Url "$BaseUrl/api/posts" `
    -Headers @("Authorization: Bearer $Token", 'Content-Type: application/json') `
    -Body $missingTitleBody `
    -ExpectStatus 400 -RequiresAuth $true

$badDateBody = @{
    title         = 'test'
    body_markdown = 'test'
    post_date     = 'not-a-date'
    post_type     = 'blog'
} | ConvertTo-Json -Compress
Test-Endpoint -Name "POST /api/posts invalid date format returns 400" `
    -Method "POST" -Url "$BaseUrl/api/posts" `
    -Headers @("Authorization: Bearer $Token", 'Content-Type: application/json') `
    -Body $badDateBody `
    -ExpectStatus 400 -RequiresAuth $true

$missingTravelTitleBody = @{
    location = 'Test'
    visit_date = '2026-01-01'
} | ConvertTo-Json -Compress
Test-Endpoint -Name "POST /api/travel missing title returns 400" `
    -Method "POST" -Url "$BaseUrl/api/travel" `
    -Headers @("Authorization: Bearer $Token", 'Content-Type: application/json') `
    -Body $missingTravelTitleBody `
    -ExpectStatus 400 -RequiresAuth $true

Test-Endpoint -Name "GET /api/stats/visits with auth returns 200" `
    -Method "GET" -Url "$BaseUrl/api/stats/visits" `
    -Headers @("Authorization: Bearer $Token") `
    -ExpectStatus 200 -ExpectBody "count" -RequiresAuth $true

Test-Endpoint -Name "GET /api/stats/visits without auth returns 401" `
    -Method "GET" -Url "$BaseUrl/api/stats/visits" `
    -ExpectStatus 401

Write-Host ""

# ── Summary ────────────────────────────────────────────────────────────────────────────
Write-Host ("═" * 60) -ForegroundColor Cyan
Write-Host "  PASSED : $pass" -ForegroundColor Green
if ($skip -gt 0) { Write-Host "  SKIPPED: $skip" -ForegroundColor DarkYellow }
Write-Host "  FAILED : $fail" -ForegroundColor $(if ($fail -gt 0) { 'Red' } else { 'Green' })
Write-Host ("═" * 60) -ForegroundColor Cyan
Write-Host "  Full log: $logFile" -ForegroundColor DarkGray
Write-Host ""

Stop-Transcript | Out-Null
if ($fail -gt 0) { exit 1 } else { exit 0 }
