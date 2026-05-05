# Local development helper for andykeys.me (Windows PowerShell wrapper)
# Delegates all commands to scripts/dev/dev-local.sh via bash.
#
# Commands:
#   up             — build & start all containers; auto-migrates schema
#   down           — stop containers (DB volume is preserved)
#   reset          — full teardown including DB volume, then rebuild
#   logs           — tail backend container logs
#   db             — open a psql shell into the dev DB
#   test           — run the automated test suite inside the backend container
#   test:coverage  — run tests with coverage report
#
# Usage: . scripts\dev\dev-local.ps1 <command>
param([string]$Command = '')

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '../..')
Set-Location $repoRoot

if (-not $Command) {
    Write-Host "Usage: . scripts\dev\dev-local.ps1 [up|down|reset|logs|db|test|test:coverage]"
    exit 1
}

bash scripts/dev/dev-local.sh $Command
