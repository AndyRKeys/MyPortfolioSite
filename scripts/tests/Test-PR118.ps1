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
$logFile   = Join-Path $resultsDir "PR118-$timestamp.txt"
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
Write-Host "  PR #118 Test Run — $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Cyan
Write-Host "  Base URL : $BaseUrl"
Write-Host "  Token    : $(if ($Token) { 'auto-generated from container' } else { 'not available (auth tests skipped)' })"
Write-Host "  Log file : $logFile"
Write-Host "═" * 54 -ForegroundColor Cyan
Write-Host ""

# First, check that the dev environment is running
Write-Host "Checking backend health..." -ForegroundColor Yellow
Test-Endpoint -Name "Backend health check" -Method "GET" -Url "$BaseUrl/api/health" -ExpectStatus 200

Write-Host ""
Write-Host "Testing deployment endpoints (auth required):" -ForegroundColor Yellow

# Test deploy status endpoint
Test-Endpoint -Name "GET /api/deploy/status" -Method "GET" -Url "$BaseUrl/api/deploy/status" `
    -Headers @("Authorization: Bearer $Token") -ExpectStatus 200 -ExpectBody "branch" -RequiresAuth $true

# Test deploy history endpoint
Test-Endpoint -Name "GET /api/deploy/history" -Method "GET" -Url "$BaseUrl/api/deploy/history" `
    -Headers @("Authorization: Bearer $Token") -ExpectStatus 200 -ExpectBody "commits" -RequiresAuth $true

# Test without auth (should be 401)
Write-Host ""
Write-Host "Testing auth protection:" -ForegroundColor Yellow
Test-Endpoint -Name "GET /api/deploy/status without auth (expect 401)" -Method "GET" -Url "$BaseUrl/api/deploy/status" `
    -ExpectStatus 401

Test-Endpoint -Name "POST /api/deploy without auth (expect 401)" -Method "POST" -Url "$BaseUrl/api/deploy" `
    -ExpectStatus 401

# Test that deploy/rollback endpoints exist and require auth
Write-Host ""
Write-Host "Testing deploy/rollback endpoints exist:" -ForegroundColor Yellow
Test-Endpoint -Name "POST /api/deploy requires auth" -Method "POST" -Url "$BaseUrl/api/deploy" `
    -ExpectStatus 401

Test-Endpoint -Name "POST /api/deploy/rollback requires auth" -Method "POST" -Url "$BaseUrl/api/deploy/rollback" `
    -ExpectStatus 401

# Test invalid SHA rejection
Write-Host ""
Write-Host "Testing rollback SHA validation:" -ForegroundColor Yellow
Test-Endpoint -Name "POST /api/deploy/rollback with invalid SHA format" -Method "POST" -Url "$BaseUrl/api/deploy/rollback" `
    -Headers @("Authorization: Bearer $Token", "Content-Type: application/json") `
    -Body '{"sha":"../../etc/passwd"}' -ExpectStatus 400 -ExpectBody "Invalid SHA" -RequiresAuth $true

Test-Endpoint -Name "POST /api/deploy/rollback with unknown SHA" -Method "POST" -Url "$BaseUrl/api/deploy/rollback" `
    -Headers @("Authorization: Bearer $Token", "Content-Type: application/json") `
    -Body '{"sha":"deadbeefdeadbeef"}' -ExpectStatus 400 -ExpectBody "not found" -RequiresAuth $true

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
