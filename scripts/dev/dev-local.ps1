<#
.SYNOPSIS
  Windows wrapper for scripts/dev/dev-local.sh.
  Passes all arguments through to the bash script via Git Bash.

.DESCRIPTION
  The `test` and `test:coverage` commands are handled directly via
  `docker compose exec` to avoid WSL/bash path issues on Windows.

.EXAMPLE
  .\scripts\dev\dev-local.ps1 up
  .\scripts\dev\dev-local.ps1 down
  .\scripts\dev\dev-local.ps1 reset
  .\scripts\dev\dev-local.ps1 logs
  .\scripts\dev\dev-local.ps1 db
  .\scripts\dev\dev-local.ps1 test
  .\scripts\dev\dev-local.ps1 test:coverage
#>
param(
  [Parameter(Position = 0)]
  [string]$Command = 'up'
)

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

# Point bare `docker compose` calls at the laptop-local compose file. The
# repo's docker-compose.yml is the unified SERVER compose; local dev uses
# docker-compose.local.yml (bind-mounted source, exposed DB port).
$env:COMPOSE_FILE = 'docker-compose.local.yml'

switch ($Command) {

  'test' {
    Write-Host '=== Installing devDependencies inside backend container ===' -ForegroundColor Cyan
    docker compose --project-directory $RepoRoot exec backend npm install --silent
    Write-Host '=== Running test suite ===' -ForegroundColor Cyan
    docker compose --project-directory $RepoRoot exec backend npm test
  }

  'test:coverage' {
    Write-Host '=== Installing devDependencies inside backend container ===' -ForegroundColor Cyan
    docker compose --project-directory $RepoRoot exec backend npm install --silent
    Write-Host '=== Running tests with coverage ===' -ForegroundColor Cyan
    docker compose --project-directory $RepoRoot exec backend npm run test:coverage
  }

  default {
    # All other commands (up, down, reset, logs, db) delegate to the bash script via Git Bash
    $BashExe = 'C:\Program Files\Git\bin\bash.exe'
    if (-not (Test-Path $BashExe)) {
      Write-Error "Git Bash not found at $BashExe. Install Git for Windows or run dev-local.sh directly in WSL."
      exit 1
    }
    & $BashExe -c "bash '$RepoRoot/scripts/dev/dev-local.sh' $Command"
  }

}
