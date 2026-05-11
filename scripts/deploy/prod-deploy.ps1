# Trigger a production deploy from Windows via SSH.
# Connects to the server and runs scripts/deploy/prod-deploy.sh remotely.
#
# IMPORTANT: If the server has rebooted, decrypt it first via Dropbear:
#   ssh -p 2222 root@portfolio-server
#   cryptroot-unlock
#   (enter disk encryption passphrase, wait for system to boot)
#
# Usage: .\scripts\deploy\prod-deploy.ps1 [-Hostname <name>] [-Rollback <sha>]
param(
    [string]$Hostname = 'ak-home-server',
    [string]$Rollback = ''
)

$remoteArgs = if ($Rollback) { "--rollback $Rollback" } else { "" }

$remoteCommand = @"
cd ~/MyPortfolioSite
bash scripts/deploy/prod-deploy.sh $remoteArgs
"@

ssh $Hostname $remoteCommand
