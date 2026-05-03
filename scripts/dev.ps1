<#
.SYNOPSIS
    Local development helper for andykeys.me (PowerShell equivalent of dev.sh)

.DESCRIPTION
    Mirrors dev.sh behaviour for the Docker dev environment.
    Run from the repo root: .\scripts\dev.ps1 <command>

.PARAMETER Command
    up     - Build & start all containers; auto-applies schema.sql if changed
    down   - Stop containers (DB volume is preserved)
    reset  - Full teardown including DB volume, then rebuild (clean slate)
    logs   - Tail backend container logs
    db     - Open a psql shell into the dev DB

.EXAMPLE
    .\scripts\dev.ps1 up
    .\scripts\dev.ps1 reset
#>

param(
    [Parameter(Position = 0)]
    [string]$Command
)

$ErrorActionPreference = 'Stop'

# Resolve repo root regardless of where the script is called from
$RepoDir = Split-Path -Parent $PSScriptRoot
Set-Location $RepoDir

$DbUser = if ($env:DB_USER) { $env:DB_USER } else { 'postgres' }
$DbName = if ($env:DB_NAME) { $env:DB_NAME } else { 'portfolio_dev' }

switch ($Command) {

    'up' {
        # Detect schema changes (matches deploy.sh detection pattern)
        $schemaChanged = (git diff HEAD -- backend/db/schema.sql | Measure-Object -Line).Lines

        Write-Host '=== Starting containers ===' -ForegroundColor Cyan
        docker compose up --build -d

        # Wait for Postgres to be healthy
        Write-Host '=== Waiting for Postgres to be ready ===' -ForegroundColor Cyan
        do {
            Start-Sleep -Seconds 1
            $ready = docker compose exec -T postgres pg_isready -U $DbUser 2>$null
        } until ($LASTEXITCODE -eq 0)

        if ($schemaChanged -gt 0) {
            Write-Host '=== schema.sql changed — applying to dev DB ===' -ForegroundColor Yellow
            docker compose exec -T postgres psql `
                -U $DbUser `
                -d $DbName `
                -f /docker-entrypoint-initdb.d/01-schema.sql
            Write-Host '  Schema applied.' -ForegroundColor Green
        } else {
            Write-Host '=== schema.sql unchanged — skipping migration ===' -ForegroundColor Gray
        }

        Write-Host ''
        docker compose ps
        Write-Host ''
        Write-Host 'Dev environment running at http://localhost' -ForegroundColor Green
    }

    'down' {
        Write-Host '=== Stopping containers (DB volume preserved) ===' -ForegroundColor Cyan
        docker compose down
    }

    'reset' {
        Write-Host '=== Full reset — removing containers and DB volume ===' -ForegroundColor Cyan
        Write-Host 'WARNING: All local dev data will be lost.' -ForegroundColor Yellow
        $confirm = Read-Host 'Continue? [y/N]'
        if ($confirm -match '^[Yy]$') {
            docker compose down -v
            Write-Host '=== Rebuilding from scratch ===' -ForegroundColor Cyan
            docker compose up --build -d
            Write-Host ''
            Write-Host 'Clean dev environment running at http://localhost' -ForegroundColor Green
        } else {
            Write-Host 'Reset cancelled.' -ForegroundColor Gray
        }
    }

    'logs' {
        docker compose logs -f backend
    }

    'db' {
        Write-Host "=== Opening psql shell ($DbName) ===" -ForegroundColor Cyan
        docker compose exec postgres psql -U $DbUser -d $DbName
    }

    default {
        Write-Host 'Usage: .\scripts\dev.ps1 [up|down|reset|logs|db]' -ForegroundColor White
        Write-Host ''
        Write-Host '  up     Build & start all containers; auto-migrates schema if changed'
        Write-Host '  down   Stop containers (DB volume preserved)'
        Write-Host '  reset  Full teardown + rebuild — wipes local DB data'
        Write-Host '  logs   Tail backend container logs'
        Write-Host '  db     Open a psql shell into the dev DB'
        exit 1
    }
}
