# Trigger a dev server deploy from Windows via SSH.
# Uses switch-branch.sh to update the repo to the target branch first,
# then runs dev-deploy.sh — so the deploy always executes the current
# version of the scripts, not whatever was checked out before the pull.
#
# Usage: .\scripts\deploy\dev-deploy.ps1 [-Hostname <name>] [-Branch <branch>]
param(
    [string]$Hostname = 'ak-home-server',
    [string]$Branch = ''
)

if ([string]::IsNullOrEmpty($Branch)) {
    $Branch = git rev-parse --abbrev-ref HEAD
    Write-Host "Detected branch: $Branch" -ForegroundColor Cyan
}

Write-Host "Deploying branch '$Branch' to dev server..." -ForegroundColor Green

$remoteCommand = @"
DEV_REPO=`$~/MyPortfolioSite-dev
REPO_URL=https://github.com/AndyRKeys/MyPortfolioSite.git
BRANCH="$Branch"

# Clone on first run
if [ ! -d "`$DEV_REPO/.git" ]; then
    echo "[INFO] Dev repo not found — cloning..."
    git clone "`$REPO_URL" "`$DEV_REPO"
fi

# Switch to the requested branch (fetch + hard reset to origin)
bash "`$DEV_REPO/scripts/deploy/switch-branch.sh" "`$BRANCH" "`$DEV_REPO"

# Run the deploy with the now-current scripts
bash "`$DEV_REPO/scripts/deploy/dev-deploy.sh" "`$BRANCH"
"@

# Strip CRLF — bash on the server rejects Windows line endings
$remoteCommand = $remoteCommand -replace "`r`n", "`n"

ssh $Hostname $remoteCommand
