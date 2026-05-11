# Trigger a dev server deploy from Windows via SSH.
# Connects to the Ubuntu Server and runs scripts/deploy/dev-deploy.sh remotely.
#
# On first run the bash script will clone the repo automatically.
# On subsequent runs it pulls the latest dev branch and rebuilds containers.
#
# Usage: .\scripts\deploy\dev-deploy.ps1 [-Hostname <name>]
param(
    [string]$Hostname = 'ak-home-server'
)

$remoteCommand = @'
DEPLOY_SCRIPT=~/MyPortfolioSite-dev/scripts/deploy/dev-deploy.sh
bash "$DEPLOY_SCRIPT"
'@

ssh $Hostname $remoteCommand
