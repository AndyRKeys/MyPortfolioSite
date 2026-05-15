# Trigger a dev server deploy from Windows via SSH.
# Connects to the Ubuntu Server and runs scripts/deploy/dev-server-deploy-wrapper.sh remotely.
# The wrapper updates the branch first, then execs dev-deploy.sh with the latest code.
#
# IMPORTANT: Use this script, not dev-deploy.ps1, to ensure the wrapper runs and
# the deploy always executes the current version of the deploy scripts.
#
# Usage: .\scripts\deploy\dev-server-deploy.ps1 [-Hostname <name>] [-Branch <branch>]
param(
    [string]$Hostname = 'ak-home-server',
    [string]$Branch = ''
)

# Detect current branch if not specified
if ([string]::IsNullOrEmpty($Branch)) {
    $Branch = git rev-parse --abbrev-ref HEAD
    Write-Host "Detected branch: $Branch" -ForegroundColor Cyan
}

Write-Host "Deploying branch '$Branch' to dev server via wrapper..." -ForegroundColor Green

$remoteCommand = @"
WRAPPER=~/MyPortfolioSite-dev/scripts/deploy/dev-server-deploy-wrapper.sh
DEPLOY_BRANCH="$Branch"
if [ -f "`$WRAPPER" ]; then
    bash "`$WRAPPER" "`$DEPLOY_BRANCH"
else
    echo "[INFO] Dev repo not found — cloning for the first time..."
    git clone https://github.com/AndyRKeys/MyPortfolioSite.git ~/MyPortfolioSite-dev
    bash ~/MyPortfolioSite-dev/scripts/deploy/dev-deploy-wrapper.sh "`$DEPLOY_BRANCH"
fi
"@

# Strip CRLF — bash on the server rejects Windows line endings
$remoteCommand = $remoteCommand -replace "`r`n", "`n"

ssh $Hostname $remoteCommand
