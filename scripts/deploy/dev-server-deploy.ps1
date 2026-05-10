# Trigger a dev server deploy from Windows via SSH.
# Connects to the Ubuntu Server and runs scripts/deploy/dev-server-deploy-wrapper.sh remotely.
#
# On first run the wrapper will clone the dev repo automatically.
# On subsequent runs it updates the specified branch and then invokes
# the main dev-server-deploy.sh script on the server.
#
# The script automatically detects your current git branch if -Branch is not set.
# This enables rapid testing of feature/fix branches without creating a PR.
#
# Usage: .\scripts\deploy\dev-server-deploy.ps1 [-Hostname <name>] [-Branch <branch>]

param(
    [string]$Hostname = 'ak-home-server',
    [string]$Branch = ''
)

# Detect current branch if not specified
if ([string]::IsNullOrEmpty($Branch)) {
    $Branch = git rev-parse --abbrev-ref HEAD
    Write-Host "Detected branch: $Branch"
}

# Remote command: ensure dev repo exists, update to requested branch via
# the wrapper script, then run the main deploy. The wrapper is responsible for
# resetting the failure counter (via --reset-failures) so the PowerShell caller
# does not need to manage that flag.
$remoteCommand = @"
WRAPPER_SCRIPT=~/MyPortfolioSite-dev/scripts/deploy/dev-server-deploy-wrapper.sh
DEPLOY_BRANCH="$Branch"
if [ -f "`$WRAPPER_SCRIPT" ]; then
    bash "`$WRAPPER_SCRIPT" "`$DEPLOY_BRANCH"
else
    echo "[INFO] Dev repo not found — cloning for the first time..."
    git clone https://github.com/AndyRKeys/MyPortfolioSite.git ~/MyPortfolioSite-dev
    bash ~/MyPortfolioSite-dev/scripts/deploy/dev-server-deploy-wrapper.sh "`$DEPLOY_BRANCH"
fi
"@

# Strip Windows CRLF line endings — bash on the server rejects them
$remoteCommand = $remoteCommand -replace "`r`n", "`n"

Write-Host "bash ~/MyPortfolioSite-dev/scripts/deploy/dev-server-deploy-wrapper.sh $Branch"

ssh $Hostname $remoteCommand
