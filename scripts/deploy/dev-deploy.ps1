# Trigger a dev server deploy from Windows via SSH.
# Connects to the Ubuntu Server and runs scripts/deploy/dev-deploy.sh remotely.
# Auto-detects current local git branch for deployment.
#
# On first run the bash script will clone the repo automatically.
# On subsequent runs it pulls the latest branch and rebuilds containers.
#
# Usage: .\scripts\deploy\dev-deploy.ps1 [-Hostname <name>] [-Branch <branch>]
param(
    [string]$Hostname = 'ak-home-server',
    [string]$Branch
)

# Auto-detect current branch if not specified
if (-not $Branch) {
    $Branch = git branch --show-current
    if (-not $Branch) {
        Write-Error "Could not determine current git branch. Specify -Branch explicitly."
        exit 1
    }
    Write-Host "Detected branch: $Branch" -ForegroundColor Cyan
}

$DEPLOY_SCRIPT = "~/MyPortfolioSite-dev/scripts/deploy/dev-deploy.sh"

$remoteCommand = @"
bash "$DEPLOY_SCRIPT" $Branch
"@

Write-Host "Deploying branch '$Branch' to dev server..." -ForegroundColor Green

ssh $Hostname $remoteCommand
