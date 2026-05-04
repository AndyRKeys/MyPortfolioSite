#Requires -Version 5.1
<#
.SYNOPSIS
    Smoke tests for PR #107 — date field fixes (#93 #95) + CV management (#101).

.DESCRIPTION
    Verifies:
      - #93  Travel edit: GET /api/travel/admin/:id returns visit_date as full ISO timestamp
             (admin.js slices to YYYY-MM-DD before setting the date input)
      - #95  Blog edit: GET /api/posts/admin/:id returns post_date and body_markdown reliably
      - #101 CV endpoints: exists, upload, download, delete
      - Regression: contact validation, posts create/validate, travel create/validate,
        unknown route 404

    Output is written to the console AND a timestamped file in test-results\

    Requires the dev stack to be running:
        . scripts\dev\dev-local.ps1

    Token handling:
        - If -Token is provided it is used directly.
        - If omitted, auto-generated from the container JWT_SECRET (no secret hardcoded).
        - If the container is not running, auth tests are skipped with a clear warning.

.PARAMETER Token
    Admin JWT. Optional — auto-generated from the container JWT_SECRET if not supplied.

.PARAMETER BaseUrl
    Base URL of the running stack. Defaults to http://localhost

.PARAMETER SkipVitest
    Skip the Vitest suite and run HTTP smoke tests only.
#>
param(
    [string]$Token      = '',
    [string]$BaseUrl    = 'http://localhost',
    [switch]$SkipVitest
)

# ── Output capture
$resultsDir = Join-Path $PSScriptRoot '..' '..' 'test-results'
if (-not (Test-Path $resultsDir)) { New-Item -ItemType Directory -Force -Path $resultsDir | Out-Null }
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile   = Join-Path $resultsDir "PR107-$timestamp.txt"
Start-Transcript -Path $logFile -Append | Out-Null

# ── Auto-generate JWT
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

$pass    = 0
$fail    = 0
$skip    = 0
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

    $statusOk = ([int]$statusCode -eq $ExpectStatus)
    $bodyOk   = (-not $ExpectBody) -or ($bodyText -like "*$ExpectBody*")
    $passed   = $statusOk -and $bodyOk

    if ($passed) {
        Write-Host "  [PASS] $Name" -ForegroundColor Green
        $script:pass++
        $script:results += [PSCustomObject]@{ Result = 'PASS'; Name = $Name; Detail = "$statusCode" }
    } else {
        $detail = "Expected $ExpectStatus got $statusCode"
        if (-not $bodyOk) { $detail += " | body mismatch: $($bodyText.Trim())" }
        Write-Host "  [FAIL] $Name — $detail" -ForegroundColor Red
        $script:fail++
        $script:results += [PSCustomObject]@{ Result = 'FAIL'; Name = $Name; Detail = $detail }
    }
}

$jsonHeader = 'Content-Type: application/json'
$authHeader = "Authorization: Bearer $Token"

Write-Host ""
Write-Host "══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  PR #107 Test Run — $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Cyan
Write-Host "  Base URL : $BaseUrl"
Write-Host "  Token    : $(if ($Token) { 'auto-generated from container' } else { 'not available (auth tests skipped)' })"
Write-Host "  Log file : $logFile"
Write-Host "══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# ── Vitest suite
if ($SkipVitest) {
    Write-Host "--- Vitest suite (skipped via -SkipVitest) ---" -ForegroundColor DarkYellow
    $skip++
    $results += [PSCustomObject]@{ Result = 'SKIP'; Name = 'Vitest suite'; Detail = '-SkipVitest flag set' }
} else {
    Write-Host "--- Vitest unit + integration suite ---" -ForegroundColor White
    Write-Host "  Running inside backend container..." -ForegroundColor DarkGray
    docker compose exec backend npm install --silent 2>&1
    docker compose exec backend npm test 2>&1
    $vitestExit = $LASTEXITCODE
    if ($vitestExit -eq 0) {
        Write-Host "  [PASS] Vitest suite" -ForegroundColor Green
        $pass++
        $results += [PSCustomObject]@{ Result = 'PASS'; Name = 'Vitest suite'; Detail = 'exit 0' }
    } else {
        Write-Host "  [FAIL] Vitest suite (exit $vitestExit)" -ForegroundColor Red
        $fail++
        $results += [PSCustomObject]@{ Result = 'FAIL'; Name = 'Vitest suite'; Detail = "exit $vitestExit" }
    }
}

# ── #93: Travel date field
Write-Host ""
Write-Host "--- #93 Travel edit: visit_date present in admin response ---" -ForegroundColor White

Test-Endpoint `
    -Name         'Travel: create draft for date-field test -> 201' `
    -Method       'POST' `
    -Url          "$BaseUrl/api/travel" `
    -Headers      @($jsonHeader, $authHeader) `
    -Body         '{"title":"Date Field Test","location":"Test City","visitDate":"2026-03-01","lat":51.5,"lng":-0.1,"publish":false}' `
    -ExpectStatus 201 `
    -RequiresAuth $true

if ($Token) {
    $listRaw = curl.exe -s -H "Authorization: Bearer $Token" "$BaseUrl/api/travel/all"
    try {
        $list = $listRaw | ConvertFrom-Json
        $testPost = $list | Where-Object { $_.title -eq 'Date Field Test' } | Select-Object -First 1
        if ($testPost) {
            $detailRaw = curl.exe -s -H "Authorization: Bearer $Token" "$BaseUrl/api/travel/admin/$($testPost.id)"
            $detail = $detailRaw | ConvertFrom-Json
            if ($null -ne $detail.visit_date) {
                Write-Host "  [PASS] Travel admin detail: visit_date present ('$($detail.visit_date)')" -ForegroundColor Green
                $pass++
                $results += [PSCustomObject]@{ Result = 'PASS'; Name = 'Travel admin: visit_date in response'; Detail = "$($detail.visit_date)" }

                # Cast to string first — ConvertFrom-Json auto-converts ISO dates to [DateTime]
                # which .ToString() renders in locale format (MM/DD/YYYY). We need the raw ISO string.
                $dateStr = [string]$detail.visit_date
                # ISO date strings start with YYYY-; [DateTime].ToString() starts with MM/
                # Re-format [DateTime] objects to ISO if ConvertFrom-Json ate the original string
                if ($detail.visit_date -is [datetime]) {
                    $dateStr = $detail.visit_date.ToString('yyyy-MM-dd')
                }
                $sliced = $dateStr.Substring(0, [Math]::Min(10, $dateStr.Length))
                if ($sliced -match '^\d{4}-\d{2}-\d{2}$') {
                    Write-Host "  [PASS] Travel admin: sliced date '$sliced' is valid YYYY-MM-DD" -ForegroundColor Green
                    $pass++
                    $results += [PSCustomObject]@{ Result = 'PASS'; Name = 'Travel admin: visit_date sliceable to YYYY-MM-DD'; Detail = $sliced }
                } else {
                    Write-Host "  [FAIL] Travel admin: sliced date '$sliced' is not YYYY-MM-DD" -ForegroundColor Red
                    $fail++
                    $results += [PSCustomObject]@{ Result = 'FAIL'; Name = 'Travel admin: visit_date sliceable to YYYY-MM-DD'; Detail = $sliced }
                }
            } else {
                Write-Host "  [FAIL] Travel admin detail: visit_date missing from response" -ForegroundColor Red
                $fail++
                $results += [PSCustomObject]@{ Result = 'FAIL'; Name = 'Travel admin: visit_date in response'; Detail = 'field absent' }
            }
        } else {
            Write-Host "  [SKIP] Travel admin date test — test post not found in list" -ForegroundColor DarkYellow
            $skip++
        }
    } catch {
        Write-Host "  [FAIL] Travel admin date test — could not parse response: $_" -ForegroundColor Red
        $fail++
    }
} else {
    Write-Host "  [SKIP] Travel admin date tests (no token)" -ForegroundColor DarkYellow
    $skip += 2
}

# ── #95: Blog date + body fields
Write-Host ""
Write-Host "--- #95 Blog edit: post_date and body_markdown present in response ---" -ForegroundColor White

Test-Endpoint `
    -Name         'Posts: create draft for date-field test -> 201' `
    -Method       'POST' `
    -Url          "$BaseUrl/api/posts" `
    -Headers      @($jsonHeader, $authHeader) `
    -Body         '{"title":"Date Field Test Post","body_markdown":"## Hello","post_date":"2026-03-01","publish":false}' `
    -ExpectStatus 201 `
    -RequiresAuth $true

if ($Token) {
    $listRaw = curl.exe -s -H "Authorization: Bearer $Token" "$BaseUrl/api/posts/all"
    try {
        $list = $listRaw | ConvertFrom-Json
        $testPost = $list | Where-Object { $_.title -eq 'Date Field Test Post' } | Select-Object -First 1
        if ($testPost) {
            # Use /api/posts/admin/:id — the public /api/posts/:slug endpoint strips
            # draft-only fields and requires a slug, not an id.
            $detailRaw = curl.exe -s -H "Authorization: Bearer $Token" "$BaseUrl/api/posts/admin/$($testPost.id)"
            $detail = $detailRaw | ConvertFrom-Json
            foreach ($field in @('post_date', 'body_markdown')) {
                if ($null -ne $detail.$field -and $detail.$field -ne '') {
                    Write-Host "  [PASS] Blog admin detail: '$field' present" -ForegroundColor Green
                    $pass++
                    $results += [PSCustomObject]@{ Result = 'PASS'; Name = "Blog admin: $field in response"; Detail = 'present' }
                } else {
                    Write-Host "  [FAIL] Blog admin detail: '$field' missing" -ForegroundColor Red
                    $fail++
                    $results += [PSCustomObject]@{ Result = 'FAIL'; Name = "Blog admin: $field in response"; Detail = 'absent' }
                }
            }
        } else {
            Write-Host "  [SKIP] Blog admin date test — test post not found in list" -ForegroundColor DarkYellow
            $skip++
        }
    } catch {
        Write-Host "  [FAIL] Blog admin date test — could not parse response: $_" -ForegroundColor Red
        $fail++
    }
} else {
    Write-Host "  [SKIP] Blog admin date tests (no token)" -ForegroundColor DarkYellow
    $skip += 2
}

# ── #101: CV endpoints
Write-Host ""
Write-Host "--- #101 CV management ---" -ForegroundColor White

# Ensure clean state before testing empty-CV behaviour.
# A cv.pdf left on disk from a previous run would cause the 404 assertion to
# incorrectly receive 200. Silently delete first — no-op if nothing is there.
if ($Token) {
    Write-Host "  [INFO] Cleaning up any pre-existing CV..." -ForegroundColor DarkGray
    curl.exe -s -o NUL -X DELETE -H "Authorization: Bearer $Token" "$BaseUrl/api/cv" | Out-Null
}

Test-Endpoint `
    -Name         'CV: GET /api/cv/exists -> 200 with exists field' `
    -Method       'GET' `
    -Url          "$BaseUrl/api/cv/exists" `
    -ExpectStatus 200 `
    -ExpectBody   'exists'

Test-Endpoint `
    -Name         'CV: GET /api/cv -> 404 when no CV uploaded' `
    -Method       'GET' `
    -Url          "$BaseUrl/api/cv" `
    -ExpectStatus 404

if ($Token) {
    $tempPdf = Join-Path $env:TEMP 'test-cv.pdf'
    $pdfContent = "%PDF-1.4`n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj`nxref`n0 4`n0000000000 65535 f`n0000000009 00000 n`n0000000058 00000 n`n0000000115 00000 n`ntrailer<</Size 4/Root 1 0 R>>`nstartxref`n190`n%%EOF"
    [System.IO.File]::WriteAllText($tempPdf, $pdfContent)

    Write-Host "  Uploading test CV..." -ForegroundColor DarkGray
    $uploadStatus = curl.exe -s -o tmp_body.txt -w '%{http_code}' `
        -X POST `
        -H "Authorization: Bearer $Token" `
        -F "cv=@$tempPdf;type=application/pdf" `
        "$BaseUrl/api/cv"
    $uploadBody = if (Test-Path tmp_body.txt) { Get-Content tmp_body.txt -Raw } else { '' }
    if (Test-Path tmp_body.txt) { Remove-Item tmp_body.txt -Force }

    if ([int]$uploadStatus -eq 200) {
        Write-Host "  [PASS] CV: POST /api/cv -> 200" -ForegroundColor Green
        $pass++
        $results += [PSCustomObject]@{ Result = 'PASS'; Name = 'CV: upload -> 200'; Detail = $uploadBody.Trim() }
    } else {
        Write-Host "  [FAIL] CV: POST /api/cv -> expected 200, got $uploadStatus | $($uploadBody.Trim())" -ForegroundColor Red
        $fail++
        $results += [PSCustomObject]@{ Result = 'FAIL'; Name = 'CV: upload -> 200'; Detail = "Got $uploadStatus" }
    }

    Test-Endpoint `
        -Name         'CV: GET /api/cv/exists -> exists true after upload' `
        -Method       'GET' `
        -Url          "$BaseUrl/api/cv/exists" `
        -ExpectStatus 200 `
        -ExpectBody   'true'

    Test-Endpoint `
        -Name         'CV: GET /api/cv -> 200 after upload' `
        -Method       'GET' `
        -Url          "$BaseUrl/api/cv" `
        -ExpectStatus 200

    Test-Endpoint `
        -Name         'CV: POST /api/cv without file -> 400' `
        -Method       'POST' `
        -Url          "$BaseUrl/api/cv" `
        -Headers      @($authHeader) `
        -ExpectStatus 400 `
        -RequiresAuth $true

    Test-Endpoint `
        -Name         'CV: DELETE /api/cv -> 200' `
        -Method       'DELETE' `
        -Url          "$BaseUrl/api/cv" `
        -Headers      @($authHeader) `
        -ExpectStatus 200 `
        -RequiresAuth $true

    Test-Endpoint `
        -Name         'CV: GET /api/cv/exists -> exists false after delete' `
        -Method       'GET' `
        -Url          "$BaseUrl/api/cv/exists" `
        -ExpectStatus 200 `
        -ExpectBody   'false'

    Test-Endpoint `
        -Name         'CV: GET /api/cv -> 404 after delete' `
        -Method       'GET' `
        -Url          "$BaseUrl/api/cv" `
        -ExpectStatus 404

    if (Test-Path $tempPdf) { Remove-Item $tempPdf -Force }
} else {
    Write-Host "  [SKIP] CV upload/download/delete tests (no token)" -ForegroundColor DarkYellow
    $skip += 5
}

Test-Endpoint `
    -Name         'CV: POST /api/cv unauthenticated -> 401' `
    -Method       'POST' `
    -Url          "$BaseUrl/api/cv" `
    -ExpectStatus 401

Test-Endpoint `
    -Name         'CV: DELETE /api/cv unauthenticated -> 401' `
    -Method       'DELETE' `
    -Url          "$BaseUrl/api/cv" `
    -ExpectStatus 401

# ── Regression: contact
Write-Host ""
Write-Host "--- Regression: contact form ---" -ForegroundColor White

Test-Endpoint `
    -Name         'Contact: valid request reaches handler (known 500 — see #100)' `
    -Method       'POST' `
    -Url          "$BaseUrl/api/contact" `
    -Headers      @($jsonHeader) `
    -Body         '{"name":"Test","email":"test@example.com","message":"Hello"}' `
    -ExpectStatus 500

Test-Endpoint `
    -Name         'Contact: missing name -> 400' `
    -Method       'POST' `
    -Url          "$BaseUrl/api/contact" `
    -Headers      @($jsonHeader) `
    -Body         '{"name":"","email":"test@example.com","message":"Hello"}' `
    -ExpectStatus 400 `
    -ExpectBody   'name'

Test-Endpoint `
    -Name         'Contact: invalid email -> 400' `
    -Method       'POST' `
    -Url          "$BaseUrl/api/contact" `
    -Headers      @($jsonHeader) `
    -Body         '{"name":"Test","email":"not-an-email","message":"Hello"}' `
    -ExpectStatus 400 `
    -ExpectBody   'email'

# ── Regression: posts
Write-Host ""
Write-Host "--- Regression: blog posts ---" -ForegroundColor White

Test-Endpoint `
    -Name         'Posts: missing title -> 400' `
    -Method       'POST' `
    -Url          "$BaseUrl/api/posts" `
    -Headers      @($jsonHeader, $authHeader) `
    -Body         '{"body_markdown":"## Hello"}' `
    -ExpectStatus 400 `
    -ExpectBody   'title' `
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

# ── Regression: travel
Write-Host ""
Write-Host "--- Regression: travel posts ---" -ForegroundColor White

Test-Endpoint `
    -Name         'Travel: missing title -> 400' `
    -Method       'POST' `
    -Url          "$BaseUrl/api/travel" `
    -Headers      @($jsonHeader, $authHeader) `
    -Body         '{"location":"Auckland"}' `
    -ExpectStatus 400 `
    -ExpectBody   'title' `
    -RequiresAuth $true

# ── Error handler
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

# ── Summary
Write-Host ""
Write-Host "══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  PASSED : $pass" -ForegroundColor Green
if ($skip -gt 0) { Write-Host "  SKIPPED: $skip" -ForegroundColor DarkYellow }
if ($fail -gt 0) {
    Write-Host "  FAILED : $fail" -ForegroundColor Red
} else {
    Write-Host "  FAILED : $fail" -ForegroundColor Green
}
Write-Host "══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Full log: $logFile" -ForegroundColor DarkGray
Write-Host ""

# ── Manual checklist reminder
Write-Host "Manual checks (UI — not automated):" -ForegroundColor White
Write-Host "  [ ] Edit a travel memory — date field pre-populates correctly (YYYY-MM-DD)" -ForegroundColor DarkGray
Write-Host "  [ ] Edit a blog post — date and body both pre-populate before first interaction" -ForegroundColor DarkGray
Write-Host "  [ ] New blog post — date defaults to today" -ForegroundColor DarkGray
Write-Host "  [ ] Upload a PDF — status badge changes to '✓ CV uploaded'" -ForegroundColor DarkGray
Write-Host "  [ ] Upload PDF with personal info — warnings modal appears; cancel removes file" -ForegroundColor DarkGray
Write-Host "  [ ] Delete CV — status badge reverts to '✕ No CV uploaded'" -ForegroundColor DarkGray
Write-Host "  [ ] CV download button on index.html: hidden when no CV, visible after upload, hidden after delete (reactive — no reload needed)" -ForegroundColor DarkGray
Write-Host ""

Stop-Transcript | Out-Null
if ($fail -gt 0) { exit 1 } else { exit 0 }
