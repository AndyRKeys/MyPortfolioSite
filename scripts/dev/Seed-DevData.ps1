# Seed the dev-server database from Windows via SSH.
# Connects to the Ubuntu dev server, checks out + syncs the requested branch
# in ~/MyPortfolioSite-dev, then runs scripts/dev/seed-dev-data.sh remotely.
#
# The localhost/Windows seeding path is retired — the bash seeder
# (scripts/dev/seed-dev-data.sh) is the single source of truth and runs on
# the dev server, which is where the dev database lives.
#
# Usage: .\scripts\dev\Seed-DevData.ps1 [-Hostname <name>] [-Branch <branch>]
param(
    [string]$Hostname = 'ak-home-server',
    [string]$Branch = ''
)

# Detect current branch if not specified
if ([string]::IsNullOrEmpty($Branch)) {
    $Branch = git rev-parse --abbrev-ref HEAD
    Write-Host "Detected branch: $Branch" -ForegroundColor Cyan
}

Write-Host "Seeding dev-server database from branch '$Branch' via SSH..." -ForegroundColor Green

$remoteCommand = @"
set -e
REPO=~/MyPortfolioSite-dev
SEEDER="`$REPO/scripts/dev/seed-dev-data.sh"
if [ ! -d "`$REPO/.git" ]; then
    echo "[ERROR] Dev repo not found at `$REPO. Run a dev deploy first." >&2
    exit 1
fi
cd "`$REPO"
git fetch origin "$Branch"
git checkout "$Branch"
git pull origin "$Branch"
if [ ! -f "`$SEEDER" ]; then
    echo "[ERROR] Seeder not found at `$SEEDER on branch $Branch." >&2
    exit 1
fi
bash "`$SEEDER"
"@

# Strip CRLF — bash on the server rejects Windows line endings
$remoteCommand = $remoteCommand -replace "`r`n", "`n"

ssh $Hostname $remoteCommand
