#Requires -Version 5.1
<#
.SYNOPSIS
    Smoke tests for PR #96.

.DESCRIPTION
    HTTP smoke tests against the local dev stack for PR #96 changes.

    Output is written to the console AND to a timestamped file in test-results\
    No extra flags needed — Start-Transcript handles capture automatically.

    Requires the dev stack to be running:
        . scripts\dev\dev-local.ps1

    Token handling:
        - If -Token is provided it is used directly.
        - If -Token is omitted, the script auto-generates a short-lived JWT
          by running node inside the backend container using the container's
          JWT_SECRET env var.  No secret is ever hardcoded or logged.
        - If the container is not running or JWT_SECRET is absent, auth tests
          are skipped with a clear warning.

.PARAMETER Token
    Admin JWT for authenticated routes. Optional — auto-generated if not supplied.

.PARAMETER BaseUrl
    Base URL of the running stack. Defaults to http://localhost
#>
param(
    [string]$Token   = '',
    [string]$BaseUrl = 'http://localhost'
)

$resultsDir = Join-Path $PSScriptRoot '..' '..' 'test-results'
if (-not (Test-Path $resultsDir)) {
    New-Item -ItemType Directory -Force -Path $resultsDir | Out-Null
}
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile   = Join-Path $resultsDir "PR96-$timestamp.txt"
Start-Transcript -Path $logFile -Append | Out-Null

if (-not $Token) {
    Write-Host "  [INFO] No -Token provided — attempting to generate dev JWT from container..." -ForegroundColor DarkGray
    try {
        $generated = docker compose exec -T backend node -e @"
const jwt = require('jsonwebtoken');
if (!process.env.JWT_SECRET) { process.stderr.write('NO_SECRET'); process.exit(1); }
console.log(jwt.sign({ userId: 'dev-test-user' }, process.env.JWT_SECRET, { expiresIn: '1h' }));
"@ 2>&1
        $generated = $generated | Where-Object { $_ -notmatch '^npm ' } | Select-Object -Last 1
        $generated = ($generated -join '').Trim()
        if ($generated -and $generated -notmatch 'NO_SECRET' -and $generated -match '^eyJ') {
            $Token = $generated
            Write-Host "  [INFO] Dev JWT generated from container JWT_SECRET (1h expiry)" -ForegroundColor DarkGray
        } else {
            Write-Host "  [WARN] Could not generate token — auth tests will be skipped" -ForegroundColor DarkYellow
        }
    } catch {
        Write-Host "  [WARN] Token generation failed: $_ — auth tests will be skipped" -ForegroundColor DarkYellow
    }
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

$jsonHeader = 'Content-Type: application/json'
$authHeader = "Authorization: Bearer $Token"

Write-Host ""
Write-Host "═" * 54 -ForegroundColor Cyan
Write-Host "  PR #96 Test Run — $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Cyan
Write-Host "  Base URL : $BaseUrl"
Write-Host "  Token    : $(if ($Token) { 'auto-generated from container' } else { 'not available (auth tests skipped)' })"
Write-Host "  Log file : $logFile"
Write-Host "═" * 54 -ForegroundColor Cyan
Write-Host ""

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
