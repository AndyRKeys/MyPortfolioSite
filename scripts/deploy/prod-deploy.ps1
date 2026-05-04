# Trigger a production deploy from Windows via SSH.
# Connects to the Pi and runs scripts/deploy/prod-deploy.sh remotely.
param([string]$Host = 'raspberrypi3.local')
ssh $Host "bash ~/MyPortfolioSite/scripts/deploy/prod-deploy.sh"
