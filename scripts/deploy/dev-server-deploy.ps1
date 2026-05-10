# Trigger a dev server deploy from Windows via SSH.
# Connects to the Ubuntu Server and runs scripts/deploy/dev-server-deploy.sh remotely.
#
# On first run the bash script will clone the repo automatically.
# On subsequent runs it pulls the latest dev branch and rebuilds containers.
#
# Usage: .\scripts\deploy\dev-server-deploy.ps1 [-Hostname <name>]
param(
    [string]$Hostname = 'ak-home-server'
)

# Bootstrap on first run: if the dev repo doesn't exist yet, clone it first.
# Subsequent runs just invoke the deploy script directly.
$remoteCommand = @'
DEPLOY_SCRIPT=~/MyPortfolioSite-dev/scripts/deploy/dev-server-deploy.sh
if [ -f "$DEPLOY_SCRIPT" ]; then
    bash "$DEPLOY_SCRIPT"
else
    echo "[INFO] Dev repo not found — cloning for the first time..."
    git clone https://github.com/AndyRKeys/MyPortfolioSite.git ~/MyPortfolioSite-dev
    cd ~/MyPortfolioSite-dev && git checkout dev
    bash scripts/deploy/dev-server-deploy.sh
fi
'@

ssh $Hostname $remoteCommand
