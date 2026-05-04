<#
.SYNOPSIS
  Smoke test script for PR #104 — automated testing (Vitest + Supertest).

.DESCRIPTION
  Verifies the test suite runs correctly inside the Docker backend container.
  Run this after `dev-local.ps1 up` has completed successfully.

.EXAMPLE
  .\scripts\Test-PR104.ps1
#>

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$pass = @()
$fail = @()

function Test-Step {
  param([string]$Name, [scriptblock]$Block)
  Write-Host "`n--- $Name ---" -ForegroundColor Cyan
  try {
    & $Block
    $script:pass += $Name
    Write-Host "PASS: $Name" -ForegroundColor Green
  } catch {
    $script:fail += $Name
    Write-Host "FAIL: $Name `n  $_" -ForegroundColor Red
  }
}

# ── Pre-flight: containers must be running ──────────────────────────────────────────
Write-Host "═" * 60 -ForegroundColor DarkGray
Write-Host " PR #104 — Automated Testing Smoke Test" -ForegroundColor White
Write-Host "═" * 60 -ForegroundColor DarkGray

$containers = docker compose --project-directory $RepoRoot ps --format json 2>$null | ConvertFrom-Json
$backendRunning = $containers | Where-Object { $_.Service -eq 'backend' -and $_.State -eq 'running' }
if (-not $backendRunning) {
  Write-Host ""
  Write-Host "Backend container is not running. Start it first:" -ForegroundColor Yellow
  Write-Host "  .\scripts\dev-local.ps1 up" -ForegroundColor Yellow
  exit 1
}
Write-Host "Backend container is running. Proceeding...`n" -ForegroundColor Green

# ── Tests ───────────────────────────────────────────────────────────────────
Test-Step 'Install devDependencies in container' {
  docker compose --project-directory $RepoRoot exec backend npm install --silent
}

Test-Step 'npm test — all tests pass' {
  docker compose --project-directory $RepoRoot exec backend npm test
}

Test-Step 'npm run test:coverage — coverage report generated' {
  docker compose --project-directory $RepoRoot exec backend npm run test:coverage
}

Test-Step 'Health endpoint still responds (server.js unchanged)' {
  $resp = Invoke-WebRequest -Uri 'http://localhost:8080/health' -UseBasicParsing
  if ($resp.StatusCode -ne 200) { throw "Expected 200, got $($resp.StatusCode)" }
  $body = $resp.Content | ConvertFrom-Json
  if ($body.status -ne 'ok') { throw "Expected status=ok, got $($body.status)" }
}

Test-Step 'POST /contact returns 400 for missing name (validation active)' {
  try {
    Invoke-WebRequest -Uri 'http://localhost:8080/contact' -Method POST `
      -ContentType 'application/json' `
      -Body '{"email":"test@example.com","message":"Hi"}' `
      -UseBasicParsing | Out-Null
    throw 'Expected 400 but got 2xx'
  } catch {
    if ($_.Exception.Response.StatusCode.value__ -ne 400) { throw $_ }
  }
}

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "═" * 60 -ForegroundColor DarkGray
Write-Host " Results: $($pass.Count) passed, $($fail.Count) failed" -ForegroundColor $(if ($fail.Count -eq 0) { 'Green' } else { 'Red' })
Write-Host "═" * 60 -ForegroundColor DarkGray

if ($pass.Count -gt 0) {
  $pass | ForEach-Object { Write-Host "  ✓ $_" -ForegroundColor Green }
}
if ($fail.Count -gt 0) {
  $fail | ForEach-Object { Write-Host "  ✗ $_" -ForegroundColor Red }
  exit 1
}
