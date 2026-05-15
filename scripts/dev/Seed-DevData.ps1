# Seed the dev-server database from Windows via SSH.
# Connects to the Ubuntu dev server, switches the repo to the requested
# branch via switch-branch.sh, then runs scripts/dev/seed-dev-data.sh.
#
# Usage: .\scripts\dev\Seed-DevData.ps1 [-Hostname <name>] [-Branch <branch>] [-RepoPath <path>]
param(
    [string]$Hostname = 'ak-home-server',
    [string]$Branch   = '',
    [string]$RepoPath = '~/MyPortfolioSite-dev'
)

# Detect current branch if not specified
if ([string]::IsNullOrEmpty($Branch)) {
    $Branch = git rev-parse --abbrev-ref HEAD
    Write-Host "Detected branch: $Branch" -ForegroundColor Cyan
}

Write-Host "Switching dev server to branch '$Branch'..." -ForegroundColor Green

# Step 1: switch branch via wrapper
ssh $Hostname "bash '$RepoPath/scripts/deploy/switch-branch.sh' '$Branch' '$RepoPath'"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Branch switch failed (exit $LASTEXITCODE). Aborting seed." -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "Seeding dev-server database from branch '$Branch'..." -ForegroundColor Green

# Step 2: run seeder
$seeder = "$RepoPath/scripts/dev/seed-dev-data.sh"
$remoteCommand = @"
set -e
if [ ! -f "$seeder" ]; then
    echo "[ERROR] Seeder not found at $seeder on branch $Branch." >&2
    exit 1
fi
bash "$seeder"
"@

# Strip CRLF — bash on the server rejects Windows line endings
$remoteCommand = $remoteCommand -replace "`r`n", "`n"

ssh $Hostname $remoteCommand
