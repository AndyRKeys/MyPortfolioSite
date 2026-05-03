<#
.SYNOPSIS
    Local development helper for andykeys.me (Windows/Git Bash wrapper for dev-local.sh)

.DESCRIPTION
    Passes the command through to dev-local.sh via Git Bash.
    Requires Git for Windows to be installed.
    Run from the repo root: .\scripts\dev-local.ps1 <command>

.PARAMETER Command
    up     - Build & start all containers; auto-applies schema.sql if changed
    down   - Stop containers (DB volume is preserved)
    reset  - Full teardown including DB volume, then rebuild (clean slate)
    logs   - Tail backend container logs
    db     - Open a psql shell into the dev DB

.EXAMPLE
    .\scripts\dev-local.ps1 up
    .\scripts\dev-local.ps1 reset
#>

param(
    [Parameter(Position = 0)]
    [string]$Command
)

$ErrorActionPreference = 'Stop'

$gitBash = 'C:\Program Files\Git\bin\bash.exe'

if (-not (Test-Path $gitBash)) {
    Write-Error "Git Bash not found at '$gitBash'. Please install Git for Windows."
    exit 1
}

if (-not $Command) {
    Write-Host 'Usage: .\scripts\dev-local.ps1 [up|down|reset|logs|db]' -ForegroundColor White
    Write-Host ''
    Write-Host '  up     Build & start all containers; auto-migrates schema if changed'
    Write-Host '  down   Stop containers (DB volume preserved)'
    Write-Host '  reset  Full teardown + rebuild — wipes local DB data'
    Write-Host '  logs   Tail backend container logs'
    Write-Host '  db     Open a psql shell into the dev DB'
    exit 1
}

# Git Bash accepts Windows paths with forward slashes (C:/...) — not WSL-style (/mnt/c/...)
$repoRoot = (Split-Path -Parent $PSScriptRoot) -replace '\\', '/'

& $gitBash -c "bash '$repoRoot/scripts/dev-local.sh' $Command"
