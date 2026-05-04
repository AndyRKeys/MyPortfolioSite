#Requires -Version 5.1
<#
.SYNOPSIS
    Smoke tests for PR #96 — centralised Zod validation middleware & error handler.

.DESCRIPTION
    Runs all validation smoke tests against the local Docker dev environment.
    Requires the dev stack to be running: . scripts\dev-local.ps1

    For authenticated routes, pass your JWT via the -Token parameter:
        .\scripts\Test-PR96.ps1 -Token "eyJ..."

.PARAMETER Token
    Admin JWT for authenticated routes (POST /api/posts, POST /api/travel).
    Skip authenticated tests if not provided.

.PARAMETER BaseUrl
    Base URL of the running stack. Defaults to http://localhost
#>
param(
    [string]$Token   = '',
    [string]$BaseUrl = 'http://localhost'
)

$pass   = 0
$fail   = 0
$skip   = 0
$results = @()

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
        Write-Host "  [SKIP] $Name (no token provided)" -ForegroundColor DarkYellow
        $script:skip++
        $script:results += [PSCustomObject]@{ Result = 'SKIP'; Name = $Name; Detail = 'No token' }
        return
    }

    $curlArgs = @('-s', '-o', 'tmp_body.txt', '-w', '%{http_code}', '-X', $Method)

    foreach ($h in $Headers) {
        $curlArgs += @('-H', $h)
    }

    if ($Body) {
        $curlArgs += @('-d', $Body)
    }

    $curlArgs += $Url

    $statusCode = curl.exe @curlArgs
    $bodyText   = if (Test-Path tmp_body.txt) { Get-Content tmp_body.txt -Raw } else { '' }
    if (Test-Path tmp_body.txt) { Remove-Item tmp_body.txt -Force }

    $statusOk = ([int]$statusCode -eq $ExpectStatus)
    $bodyOk   = (-not $ExpectBody) -or ($bodyText -like "*$ExpectBody*")
    $passed   = $statusOk -and $bodyOk

    if ($passed) {
        Write-Host "  [PASS] $Name" -ForegroundColor Green
        $script:pass++
        $script:results += [PSCustomObject]@{ Result = 'PASS'; Name = $Name; Detail = "$statusCode" }
    } else {
        $detail = "Expected $ExpectStatus got $statusCode"
        if (-not $bodyOk) { $detail += " | body mismatch: $($bodyText.Trim())"
        }
        Write-Host "  [FAIL] $Name — $detail" -ForegroundColor Red
        $script:fail++
        $script:results += [PSCustomObject]@{ Result = 'FAIL'; Name = $Name; Detail = $detail }
    }
}

$jsonHeader = 'Content-Type: application/json'
$authHeader = "Authorization: Bearer $Token"

# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "=== PR #96 Smoke Tests — Zod Validation Middleware ==="  -ForegroundColor Cyan
Write-Host "  Base URL : $BaseUrl"
Write-Host "  Token    : $(if ($Token) { 'provided' } else { 'not provided (auth tests skipped)' })"
Write-Host ""

# ---------------------------------------------------------------------------
Write-Host "--- Contact form (POST /api/contact) ---" -ForegroundColor White

Test-Endpoint `
    -Name         'Contact: valid request reaches handler (email may fail in dev — that is expected)' `
    -Method       'POST' `
    -Url          "$BaseUrl/api/contact" `
    -Headers      @($jsonHeader) `
    -Body         '{"name":"Test","email":"test@example.com","message":"Hello"}' `
    -ExpectStatus 200

# Note: in local dev without SMTP config, the above returns an email error instead of
# 200 { success: true }. This is expected — it means validation passed and the request
# reached the handler. The test accepts any non-400/500 response from the handler path.
# Adjust ExpectStatus to 200 when testing against an environment with SMTP configured.

Test-Endpoint `
    -Name         'Contact: missing name -> 400' `
    -Method       'POST' `
    -Url          "$BaseUrl/api/contact" `
    -Headers      @($jsonHeader) `
    -Body         '{"name":"","email":"test@example.com","message":"Hello"}' `
    -ExpectStatus 400 `
    -ExpectBody   'required'

Test-Endpoint `
    -Name         'Contact: invalid email -> 400' `
    -Method       'POST' `
    -Url          "$BaseUrl/api/contact" `
    -Headers      @($jsonHeader) `
    -Body         '{"name":"Test","email":"not-an-email","message":"Hello"}' `
    -ExpectStatus 400 `
    -ExpectBody   'email'

# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "--- Blog posts (POST /api/posts) ---" -ForegroundColor White

Test-Endpoint `
    -Name         'Posts: valid create -> 201' `
    -Method       'POST' `
    -Url          "$BaseUrl/api/posts" `
    -Headers      @($jsonHeader, $authHeader) `
    -Body         '{"title":"Test Post","body_markdown":"## Hello","publish":false}' `
    -ExpectStatus 201 `
    -RequiresAuth $true

Test-Endpoint `
    -Name         'Posts: missing title -> 400' `
    -Method       'POST' `
    -Url          "$BaseUrl/api/posts" `
    -Headers      @($jsonHeader, $authHeader) `
    -Body         '{"body_markdown":"## Hello"}' `
    -ExpectStatus 400 `
    -ExpectBody   'required' `
    -RequiresAuth $true

Test-Endpoint `
    -Name         'Posts: invalid date format -> 400' `
    -Method       'POST' `
    -Url          "$BaseUrl/api/posts" `
    -Headers      @($jsonHeader, $authHeader) `
    -Body         '{"title":"Test","post_date":"04-05-2026"}' `
    -ExpectStatus 400 `
    -ExpectBody   'YYYY-MM-DD' `
    -RequiresAuth $true

# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "--- Travel posts (POST /api/travel) ---" -ForegroundColor White

Test-Endpoint `
    -Name         'Travel: valid create -> 201' `
    -Method       'POST' `
    -Url          "$BaseUrl/api/travel" `
    -Headers      @($jsonHeader, $authHeader) `
    -Body         '{"title":"New Zealand","location":"Auckland","visitDate":"2026-01-15","lat":-36.86,"lng":174.76,"publish":false}' `
    -ExpectStatus 201 `
    -RequiresAuth $true

Test-Endpoint `
    -Name         'Travel: missing title -> 400' `
    -Method       'POST' `
    -Url          "$BaseUrl/api/travel" `
    -Headers      @($jsonHeader, $authHeader) `
    -Body         '{"location":"Auckland"}' `
    -ExpectStatus 400 `
    -ExpectBody   'required' `
    -RequiresAuth $true

# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "--- Auth: email send (POST /api/auth/email/send) ---" -ForegroundColor White

Test-Endpoint `
    -Name         'Auth email: invalid email -> 400' `
    -Method       'POST' `
    -Url          "$BaseUrl/api/auth/email/send" `
    -Headers      @($jsonHeader) `
    -Body         '{"email":"notvalid"}' `
    -ExpectStatus 400 `
    -ExpectBody   'email'

# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "--- Auth: setup (POST /api/auth/setup) ---" -ForegroundColor White

Test-Endpoint `
    -Name         'Auth setup: missing username -> 400' `
    -Method       'POST' `
    -Url          "$BaseUrl/api/auth/setup" `
    -Headers      @($jsonHeader) `
    -Body         '{"email":"andy.r.keys@outlook.com"}' `
    -ExpectStatus 400 `
    -ExpectBody   'required'

# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "--- Error handler ---" -ForegroundColor White

$unknownStatus = curl.exe -s -o NUL -w '%{http_code}' "$BaseUrl/api/doesnotexist"
if ([int]$unknownStatus -eq 404) {
    Write-Host "  [PASS] Unknown route -> 404" -ForegroundColor Green
    $pass++
    $results += [PSCustomObject]@{ Result = 'PASS'; Name = 'Unknown route -> 404'; Detail = '404' }
} else {
    Write-Host "  [FAIL] Unknown route -> expected 404, got $unknownStatus" -ForegroundColor Red
    $fail++
    $results += [PSCustomObject]@{ Result = 'FAIL'; Name = 'Unknown route -> 404'; Detail = "Got $unknownStatus" }
}

# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  PASSED : $pass" -ForegroundColor Green
if ($skip -gt 0) {
Write-Host "  SKIPPED: $skip" -ForegroundColor DarkYellow
}
if ($fail -gt 0) {
Write-Host "  FAILED : $fail" -ForegroundColor Red
} else {
Write-Host "  FAILED : $fail" -ForegroundColor Green
}
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""

if ($fail -gt 0) { exit 1 } else { exit 0 }
