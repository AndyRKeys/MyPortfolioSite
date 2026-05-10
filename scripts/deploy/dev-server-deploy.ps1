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
# Usage: .\scripts\deploy\dev-server-deploy.ps1 [-Hostname <name>] [-Branch <branch>] [-ResetFailures]

# Trigger a dev server deploy from Windows via SSH.
# Usage:
#   # default: reset failures ON
#   .\scripts\deploy\dev-server-deploy.ps1
#   # reset OFF
#   .\scripts\deploy\dev-server-deploy.ps1 -ResetFailures:$false
#   # override branch
#   .\scripts\deploy\dev-server-deploy.ps1 -Branch 'feature/219-dev-server-https'

param(
    [string]$Hostname = 'ak-home-server',
    [string]$Branch = '',
    [bool]  $ResetFailures = $false
)

# Detect current branch if not specified
if ([string]::IsNullOrEmpty($Branch)) {
    $Branch = git rev-parse --abbrev-ref HEAD
    Write-Host "Detected branch: $Branch"
}

$ResetFailures = $true

# Build extra args for the wrapper based on ResetFailures
$resetArg = ''
if ($ResetFailures) {
    $resetArg = '--reset-failures'
}

# Remote command: ensure dev repo exists, update to requested branch via
# the wrapper script, then run the main deploy. The wrapper accepts an optional
# --reset-failures flag which is controlled from this PowerShell parameter.
$remoteCommand = @"
WRAPPER_SCRIPT=~/MyPortfolioSite-dev/scripts/deploy/dev-server-deploy-wrapper.sh
DEPLOY_BRANCH="$Branch"
RESET_ARG="$resetArg"
if [ -f "`$WRAPPER_SCRIPT" ]; then
    bash "`$WRAPPER_SCRIPT" "`$DEPLOY_BRANCH" `"`$RESET_ARG`"
else
    echo "[INFO] Dev repo not found — cloning for the first time..."
    git clone https://github.com/AndyRKeys/MyPortfolioSite.git ~/MyPortfolioSite-dev
    bash ~/MyPortfolioSite-dev/scripts/deploy/dev-server-deploy-wrapper.sh "`$DEPLOY_BRANCH" `"`$RESET_ARG`"
fi
"@

# Strip Windows CRLF line endings — bash on the server rejects them
$remoteCommand = $remoteCommand -replace "`r`n", "`n"

if ($ResetFailures) {
    Write-Host "bash ~/MyPortfolioSite-dev/scripts/deploy/dev-server-deploy-wrapper.sh $Branch --reset-failures"
} else {
    Write-Host "bash ~/MyPortfolioSite-dev/scripts/deploy/dev-server-deploy-wrapper.sh $Branch"
}

ssh $Hostname $remoteCommand