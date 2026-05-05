# Trigger a production deploy from Windows via SSH.
# Connects to the Pi and runs scripts/deploy/prod-deploy.sh remotely.
param([string]$Hostname = 'raspberrypi3')
ssh $Hostname "bash ~/MyPortfolioSite/scripts/deploy/prod-deploy.sh"
