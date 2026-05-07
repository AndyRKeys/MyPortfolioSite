# Trigger a production deploy from Windows via SSH.
# Connects to the server and runs scripts/deploy/prod-deploy.sh remotely.
# Usage: .\prod-deploy.ps1 [-Hostname <name>] [-Rollback <sha>]
param(
    [string]$Hostname = 'portfolio-server',
    [string]$Rollback = ''
)
$remoteArgs = if ($Rollback) { "--rollback $Rollback" } else { "" }
ssh $Hostname "bash ~/MyPortfolioSite/scripts/deploy/prod-deploy.sh $remoteArgs"
