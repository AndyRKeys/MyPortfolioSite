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
$logFile   = Join-Path $resultsDir "PR122-$timestamp.txt"
Start-Transcript -Path $logFile -Append | Out-Null

# Auto-generate JWT if not provided
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
Write-Host "  PR #122 Test Run — $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Cyan
Write-Host "  Base URL : $BaseUrl"
Write-Host "  Token    : $(if ($Token) { 'auto-generated from container' } else { 'not provided — auth tests skipped' })"
Write-Host "  Log file : $logFile"
Write-Host ("═" * 54) -ForegroundColor Cyan
Write-Host ""

# ── Vitest suite
if (-not $SkipVitest) {
    Write-Host "--- Vitest unit + integration suite ---" -ForegroundColor Yellow
    Write-Host "  Running inside backend container..."
    $vitestExit = 0
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

# ── #108 stats.js: error handling via next(err)
Write-Host "--- #108 stats.js: error routing through central handler ---" -ForegroundColor Yellow

Test-Endpoint -Name "POST /api/stats/visit?page=home returns { page, count }" `
    -Method "POST" -Url "$BaseUrl/api/stats/visit?page=home" `
    -ExpectStatus 200 -ExpectBody "count"

Test-Endpoint -Name "POST /api/stats/visit?page=unknown returns 400 Invalid page" `
    -Method "POST" -Url "$BaseUrl/api/stats/visit?page=unknown" `
    -ExpectStatus 400 -ExpectBody "Invalid page"

Test-Endpoint -Name "GET /api/stats/visits with auth returns visit array" `
    -Method "GET" -Url "$BaseUrl/api/stats/visits" `
    -Headers @("Authorization: Bearer $Token") `
    -ExpectStatus 200 -ExpectBody "count" -RequiresAuth $true

Test-Endpoint -Name "GET /api/stats/visits without auth returns 401" `
    -Method "GET" -Url "$BaseUrl/api/stats/visits" `
    -ExpectStatus 401

Write-Host ""

# ── #108 upload.js: MAX_FILE_SIZE constant (behaviour unchanged)
Write-Host "--- #108 upload.js: file upload behaviour unchanged ---" -ForegroundColor Yellow

Test-Endpoint -Name "POST /api/upload without file returns 400" `
    -Method "POST" -Url "$BaseUrl/api/upload" `
    -Headers @("Authorization: Bearer $Token") `
    -ExpectStatus 400 -RequiresAuth $true

Write-Host ""

# ── #108 posts.js: blog CRUD still works (section headers only — no behaviour change)
Write-Host "--- #108 posts.js: blog CRUD regression ---" -ForegroundColor Yellow

Test-Endpoint -Name "GET /api/posts returns 200" `
    -Method "GET" -Url "$BaseUrl/api/posts" `
    -ExpectStatus 200

Test-Endpoint -Name "POST /api/posts with valid body creates post" `
    -Method "POST" -Url "$BaseUrl/api/posts" `
    -Headers @("Authorization: Bearer $Token", "Content-Type: application/json") `
    -Body "{\"title\":\"PR122 test post\",\"body_markdown\":\"test\",\"post_date\":\"$(Get-Date -Format 'yyyy-MM-dd')\",\"post_type\":\"blog\"}" `
    -ExpectStatus 201 -RequiresAuth $true

Test-Endpoint -Name "POST /api/posts missing title returns 400" `
    -Method "POST" -Url "$BaseUrl/api/posts" `
    -Headers @("Authorization: Bearer $Token", "Content-Type: application/json") `
    -Body '{"body_markdown":"test","post_date":"2026-05-05","post_type":"blog"}' `
    -ExpectStatus 400 -RequiresAuth $true

Test-Endpoint -Name "POST /api/posts invalid date format returns 400" `
    -Method "POST" -Url "$BaseUrl/api/posts" `
    -Headers @("Authorization: Bearer $Token", "Content-Type: application/json") `
    -Body '{"title":"test","body_markdown":"test","post_date":"not-a-date","post_type":"blog"}' `
    -ExpectStatus 400 -RequiresAuth $true

Write-Host ""

# ── Regression: error handler
Write-Host "--- Regression: error handler ---" -ForegroundColor Yellow

Test-Endpoint -Name "Unknown route -> 404" `
    -Method "GET" -Url "$BaseUrl/api/does-not-exist" `
    -ExpectStatus 404

Write-Host ""
Write-Host ("═" * 54) -ForegroundColor Cyan
Write-Host "  PASSED : $pass" -ForegroundColor Green
if ($skip -gt 0) { Write-Host "  SKIPPED: $skip" -ForegroundColor DarkYellow }
Write-Host "  FAILED : $fail" -ForegroundColor $(if ($fail -gt 0) { 'Red' } else { 'Green' })
Write-Host ("═" * 54) -ForegroundColor Cyan
Write-Host "  Full log: $logFile" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Manual checks (UI — not automated):" -ForegroundColor Yellow
Write-Host "  [ ] Visit home/blog/travel pages — visit counter increments as expected"
Write-Host "  [ ] Trigger a forced DB error (e.g. stop DB) — client receives JSON error, NOT a raw pg stack trace"
Write-Host "  [ ] Upload a file via travel memory form — succeeds as before"
Write-Host "  [ ] Attempt to upload a file over 20 MB — returns 400 with multer error"
Write-Host "  [ ] Blog post CRUD (create, edit, delete) — all work correctly"
Write-Host ""

Stop-Transcript | Out-Null
if ($fail -gt 0) { exit 1 } else { exit 0 }
