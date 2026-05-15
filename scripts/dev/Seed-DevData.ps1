# Seed the dev-server database from Windows via SSH.
# Connects to the Ubuntu dev server, switches the repo to the requested
# branch via switch-branch.sh, then runs scripts/dev/seed-dev-data.sh.
#
# Usage: .\scripts\dev\Seed-DevData.ps1 [-Hostname <name>] [-Branch <branch>] [-RepoPath <path>]
param(
    [string]$Hostname = 'ak-home-server',
    [string]$Branch   = '',
    [string]$RepoPath = '$HOME/MyPortfolioSite-dev'
)

# Detect current branch if not specified
if ([string]::IsNullOrEmpty($Branch)) {
    $Branch = git rev-parse --abbrev-ref HEAD
    Write-Host "Detected branch: $Branch" -ForegroundColor Cyan
}

Write-Host "Switching dev server to branch '$Branch'..." -ForegroundColor Green

# Step 1: switch branch via wrapper
# Note: RepoPath uses $HOME (expanded by remote bash) not ~ (not expanded in quoted SSH strings)
ssh $Hostname "bash `"`$HOME/MyPortfolioSite-dev/scripts/deploy/switch-branch.sh`" '$Branch' `"`$HOME/MyPortfolioSite-dev`""
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Branch switch failed (exit $LASTEXITCODE). Aborting seed." -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "Seeding dev-server database from branch '$Branch'..." -ForegroundColor Green

# Step 2: run seeder via a login shell so docker is in PATH
# Non-interactive SSH shells don't source /etc/profile or ~/.bashrc, so docker
# may not be on PATH. 'bash -l -c' forces a login shell that loads the full environment.
# The seeder uses relative paths for docker-compose.yml, so cd to repo root first.
$remoteCommand = @"
set -e
REPO="`$HOME/MyPortfolioSite-dev"
SEEDER="`$REPO/scripts/dev/seed-dev-data.sh"
if [ ! -f "`$SEEDER" ]; then
    echo "[ERROR] Seeder not found at `$SEEDER on branch $Branch." >&2
    exit 1
fi
cd "`$REPO"
bash -l -c "bash '`$SEEDER'"
"@

# Strip CRLF — bash on the server rejects Windows line endings
$remoteCommand = $remoteCommand -replace "`r`n", "`n"

ssh $Hostname $remoteCommand
