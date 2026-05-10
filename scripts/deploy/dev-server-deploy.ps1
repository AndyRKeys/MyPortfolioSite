# Trigger a dev server deploy from Windows via SSH.
# Connects to the Ubuntu Server and runs scripts/deploy/dev-server-deploy.sh remotely.
#
# On first run the bash script will clone the repo automatically.
# On subsequent runs it pulls the latest specified branch and rebuilds containers.
#
# The script automatically detects your current git branch and deploys from it.
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

# Bootstrap on first run: if the dev repo doesn't exist yet, clone it first.
# Subsequent runs just invoke the deploy script directly.
$remoteCommand = @"
DEPLOY_SCRIPT=~/MyPortfolioSite-dev/scripts/deploy/dev-server-deploy.sh
DEPLOY_BRANCH="$Branch"
if [ -f "`$DEPLOY_SCRIPT" ]; then
    bash "`$DEPLOY_SCRIPT" "`$DEPLOY_BRANCH"
else
    echo "[INFO] Dev repo not found — cloning for the first time..."
    git clone https://github.com/AndyRKeys/MyPortfolioSite.git ~/MyPortfolioSite-dev
    cd ~/MyPortfolioSite-dev && git checkout dev
    bash scripts/deploy/dev-server-deploy.sh "`$DEPLOY_BRANCH"
fi
"@

# Strip Windows CRLF line endings — bash on the server rejects them
$remoteCommand = $remoteCommand -replace "`r`n", "`n"

Write-Host "bash ~/MyPortfolioSite-dev/scripts/deploy/dev-server-deploy.sh $Branch"

ssh $Hostname $remoteCommand
