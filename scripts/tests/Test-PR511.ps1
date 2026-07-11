<#
.SYNOPSIS
    Smoke tests for PR #511 — bulk photo upload for travel memories.

.DESCRIPTION
    Tests the POST /api/travel/:id/photos/bulk endpoint against the dev server.
    Requires a valid JWT token (log in to the admin panel and copy from localStorage).

.PARAMETER BaseUrl
    Base URL of the backend API. Default: https://dev.andykeys.me:3001
    On the server itself, use https://localhost:3001

.PARAMETER Token
    Admin JWT token. If not provided, prompts interactively.

.PARAMETER Insecure
    Skip TLS certificate verification (needed for self-signed dev cert).

.EXAMPLE
    .\scripts\tests\Test-PR511.ps1 -BaseUrl https://dev.andykeys.me:3001 -Insecure
#>

param(
    [string]$BaseUrl = 'https://dev.andykeys.me:3001',
    [string]$Token   = '',
    [switch]$Insecure
)

# ── Setup ─────────────────────────────────────────────────────────────────────

if (-not $Token) {
    $Token = Read-Host "Enter admin JWT token (from localStorage.adminToken in browser DevTools)"
}

$headers = @{ Authorization = "Bearer $Token" }
$skipCert = $Insecure.IsPresent

$passed = 0
$failed = 0

function Assert-Status {
    param($Response, $ExpectedStatus, $Label)
    $actual = if ($Response.StatusCode) { $Response.StatusCode } else { '(no response)' }
    if ($actual -eq $ExpectedStatus) {
        Write-Host "  PASS  $Label (HTTP $actual)" -ForegroundColor Green
        $script:passed++
    } else {
        Write-Host "  FAIL  $Label — expected HTTP $ExpectedStatus, got $actual" -ForegroundColor Red
        $script:failed++
    }
}

Write-Host "`nPR #511 Smoke Tests — Bulk Photo Upload" -ForegroundColor Cyan
Write-Host "Base URL: $BaseUrl`n"

# ── Step 1: Create a test travel memory ───────────────────────────────────────

Write-Host "Step 1: Create a travel memory to test bulk upload against"

# Create a minimal travel memory to get an ID
$body = @{ title = 'PR511 Smoke Test Memory'; post_date = '2026-01-01'; location = 'Test City, Testland' } | ConvertTo-Json
try {
    if ($skipCert) {
        $createRes = Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/travel" -Headers ($headers + @{ 'Content-Type' = 'application/json' }) -Body $body -SkipCertificateCheck
    } else {
        $createRes = Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/travel" -Headers ($headers + @{ 'Content-Type' = 'application/json' }) -Body $body
    }
    $memoryId = $createRes.id
    Write-Host "  Created memory ID: $memoryId" -ForegroundColor DarkGray
} catch {
    Write-Host "  FAIL  Could not create travel memory — cannot continue. Is the server running?" -ForegroundColor Red
    exit 1
}

# ── Step 2: Auth gate — reject unauthenticated request ────────────────────────

Write-Host "`nStep 2: Auth gate — unauthenticated request must return 401"
# Expected output: HTTP 401 Unauthorized

try {
    if ($skipCert) {
        $noAuthRes = Invoke-WebRequest -Method POST -Uri "$BaseUrl/api/travel/$memoryId/photos/bulk" -SkipCertificateCheck -ErrorAction Stop
    } else {
        $noAuthRes = Invoke-WebRequest -Method POST -Uri "$BaseUrl/api/travel/$memoryId/photos/bulk" -ErrorAction Stop
    }
    Assert-Status $noAuthRes 401 "No-auth bulk upload rejected"
} catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode -eq 401) {
        Write-Host "  PASS  No-auth bulk upload rejected (HTTP 401)" -ForegroundColor Green
        $passed++
    } else {
        Write-Host "  FAIL  Expected 401 but got: $statusCode" -ForegroundColor Red
        $failed++
    }
}

# ── Step 3: 404 for unknown memory ────────────────────────────────────────────

Write-Host "`nStep 3: 404 for a nonexistent memory ID"
# Expected output: HTTP 404

# Write a tiny JPEG to a temp file for upload
$tmpImg = [System.IO.Path]::GetTempFileName() + '.jpg'
$jpegBytes = [Convert]::FromBase64String('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwAB/9k=')
[System.IO.File]::WriteAllBytes($tmpImg, $jpegBytes)

try {
    $form = @{ photos = Get-Item $tmpImg }
    if ($skipCert) {
        $notFoundRes = Invoke-WebRequest -Method POST -Uri "$BaseUrl/api/travel/nonexistent-id-99999/photos/bulk" -Headers $headers -Form $form -SkipCertificateCheck -ErrorAction Stop
    } else {
        $notFoundRes = Invoke-WebRequest -Method POST -Uri "$BaseUrl/api/travel/nonexistent-id-99999/photos/bulk" -Headers $headers -Form $form -ErrorAction Stop
    }
    Assert-Status $notFoundRes 404 "Nonexistent memory returns 404"
} catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode -eq 404) {
        Write-Host "  PASS  Nonexistent memory returns 404 (HTTP 404)" -ForegroundColor Green
        $passed++
    } else {
        Write-Host "  FAIL  Expected 404 but got: $statusCode" -ForegroundColor Red
        $failed++
    }
}

# ── Step 4: Invalid MIME type rejected ────────────────────────────────────────

Write-Host "`nStep 4: Reject a non-image file (text/plain)"
# Expected output: HTTP 400

$tmpTxt = [System.IO.Path]::GetTempFileName() + '.txt'
[System.IO.File]::WriteAllText($tmpTxt, 'not an image')

try {
    $form = @{ photos = Get-Item $tmpTxt }
    if ($skipCert) {
        $badMimeRes = Invoke-WebRequest -Method POST -Uri "$BaseUrl/api/travel/$memoryId/photos/bulk" -Headers $headers -Form $form -SkipCertificateCheck -ErrorAction Stop
    } else {
        $badMimeRes = Invoke-WebRequest -Method POST -Uri "$BaseUrl/api/travel/$memoryId/photos/bulk" -Headers $headers -Form $form -ErrorAction Stop
    }
    Assert-Status $badMimeRes 400 "Non-image file rejected"
} catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode -eq 400) {
        Write-Host "  PASS  Non-image file rejected (HTTP 400)" -ForegroundColor Green
        $passed++
    } else {
        Write-Host "  FAIL  Expected 400 but got: $statusCode" -ForegroundColor Red
        $failed++
    }
}

# ── Step 5: Happy path — single file upload ───────────────────────────────────

Write-Host "`nStep 5: Happy path — upload a single JPEG"
# Expected output: HTTP 200, body.uploaded has 1 entry, body.errors is empty

try {
    $form = @{ photos = Get-Item $tmpImg }
    if ($skipCert) {
        $uploadRes = Invoke-WebRequest -Method POST -Uri "$BaseUrl/api/travel/$memoryId/photos/bulk" -Headers $headers -Form $form -SkipCertificateCheck -ErrorAction Stop
    } else {
        $uploadRes = Invoke-WebRequest -Method POST -Uri "$BaseUrl/api/travel/$memoryId/photos/bulk" -Headers $headers -Form $form -ErrorAction Stop
    }
    if ($uploadRes.StatusCode -eq 200) {
        $uploadData = $uploadRes.Content | ConvertFrom-Json
        if ($uploadData.uploaded.Count -eq 1 -and $uploadData.errors.Count -eq 0) {
            Write-Host "  PASS  Single file uploaded: $($uploadData.uploaded[0].url)" -ForegroundColor Green
            $passed++
        } else {
            Write-Host "  FAIL  Unexpected response body: $($uploadRes.Content)" -ForegroundColor Red
            $failed++
        }
    } else {
        Assert-Status $uploadRes 200 "Single file upload succeeds"
    }
} catch {
    Write-Host "  FAIL  Upload threw exception: $($_.Exception.Message)" -ForegroundColor Red
    $failed++
}

# ── Step 6: Happy path — two files at once ────────────────────────────────────

Write-Host "`nStep 6: Happy path — upload two files in one request"
# Expected output: HTTP 200, body.uploaded has 2 entries

$tmpImg2 = [System.IO.Path]::GetTempFileName() + '.jpg'
[System.IO.File]::WriteAllBytes($tmpImg2, $jpegBytes)

try {
    # Invoke-WebRequest -Form doesn't support duplicate keys; use multipart manually via curl.exe
    $curlArgs = @(
        '-s', '-o', '-', '-w', "`n%{http_code}",
        '-X', 'POST',
        '-H', "Authorization: Bearer $Token"
    )
    if ($skipCert) { $curlArgs += '-k' }
    $curlArgs += @(
        '-F', "photos=@$tmpImg",
        '-F', "photos=@$tmpImg2",
        "$BaseUrl/api/travel/$memoryId/photos/bulk"
    )
    $curlOut  = curl.exe @curlArgs
    $lines    = $curlOut -split "`n"
    $httpCode = $lines[-1].Trim()
    $body2    = ($lines[0..($lines.Length - 2)] -join "`n") | ConvertFrom-Json

    if ($httpCode -eq '200' -and $body2.uploaded.Count -eq 2 -and $body2.errors.Count -eq 0) {
        Write-Host "  PASS  Two files uploaded (HTTP 200, 2 entries in uploaded)" -ForegroundColor Green
        $passed++
    } else {
        Write-Host "  FAIL  Expected 200 with 2 uploads, got HTTP $httpCode, uploaded=$($body2.uploaded.Count)" -ForegroundColor Red
        $failed++
    }
} catch {
    Write-Host "  FAIL  Two-file upload threw exception: $($_.Exception.Message)" -ForegroundColor Red
    $failed++
}

# ── Step 7: Memory media list reflects the uploads ────────────────────────────

Write-Host "`nStep 7: GET /travel/admin/:id shows the newly uploaded media"
# Expected output: memory.media has at least 3 entries (from steps 5 and 6)

try {
    if ($skipCert) {
        $memRes = Invoke-RestMethod -Method GET -Uri "$BaseUrl/api/travel/admin/$memoryId" -Headers $headers -SkipCertificateCheck
    } else {
        $memRes = Invoke-RestMethod -Method GET -Uri "$BaseUrl/api/travel/admin/$memoryId" -Headers $headers
    }
    $mediaCount = $memRes.media.Count
    if ($mediaCount -ge 3) {
        Write-Host "  PASS  Memory has $mediaCount media items after bulk uploads" -ForegroundColor Green
        $passed++
    } else {
        Write-Host "  FAIL  Expected >= 3 media items, got $mediaCount" -ForegroundColor Red
        $failed++
    }
} catch {
    Write-Host "  FAIL  Could not fetch memory: $($_.Exception.Message)" -ForegroundColor Red
    $failed++
}

# ── Step 8: Regression — single-file upload unaffected ───────────────────────

Write-Host "`nStep 8: Regression — existing single-file POST /upload still works"
# Expected output: HTTP 200 with url and status fields

try {
    $form = @{ file = Get-Item $tmpImg }
    if ($skipCert) {
        $singleRes = Invoke-WebRequest -Method POST -Uri "$BaseUrl/api/upload" -Headers $headers -Form $form -SkipCertificateCheck -ErrorAction Stop
    } else {
        $singleRes = Invoke-WebRequest -Method POST -Uri "$BaseUrl/api/upload" -Headers $headers -Form $form -ErrorAction Stop
    }
    if ($singleRes.StatusCode -eq 200) {
        $singleData = $singleRes.Content | ConvertFrom-Json
        if ($singleData.url -and $singleData.status) {
            Write-Host "  PASS  Single-file upload still works (url=$($singleData.url))" -ForegroundColor Green
            $passed++
        } else {
            Write-Host "  FAIL  Response missing url/status fields: $($singleRes.Content)" -ForegroundColor Red
            $failed++
        }
    } else {
        Assert-Status $singleRes 200 "Single-file upload regression"
    }
} catch {
    Write-Host "  FAIL  Single-file upload threw exception: $($_.Exception.Message)" -ForegroundColor Red
    $failed++
}

# ── Cleanup ───────────────────────────────────────────────────────────────────

Write-Host "`nCleaning up test memory…"
try {
    if ($skipCert) {
        Invoke-RestMethod -Method DELETE -Uri "$BaseUrl/api/travel/$memoryId" -Headers $headers -SkipCertificateCheck | Out-Null
    } else {
        Invoke-RestMethod -Method DELETE -Uri "$BaseUrl/api/travel/$memoryId" -Headers $headers | Out-Null
    }
    Write-Host "  Deleted test memory $memoryId" -ForegroundColor DarkGray
} catch {
    Write-Host "  WARNING: Could not delete test memory $memoryId — delete manually via admin UI" -ForegroundColor Yellow
}

Remove-Item $tmpImg,  $tmpImg2, $tmpTxt -ErrorAction SilentlyContinue

# ── Summary ───────────────────────────────────────────────────────────────────

Write-Host "`n─────────────────────────────────────────"
Write-Host "Results: $passed passed, $failed failed" -ForegroundColor $(if ($failed -eq 0) { 'Green' } else { 'Red' })
if ($failed -gt 0) { exit 1 }
