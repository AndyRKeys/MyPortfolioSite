# Trigger a production deploy from Windows via SSH.
# Connects to the server and runs scripts/deploy/prod-deploy.sh remotely.
# Defaults to main branch — override with -Branch only when intentional.
#
# IMPORTANT: If the server has rebooted, decrypt it first via Dropbear:
#   ssh -p 2222 root@portfolio-server
#   cryptroot-unlock
#   (enter disk encryption passphrase, wait for system to boot)
#
# Usage: .\scripts\deploy\prod-deploy.ps1 [-Hostname <name>] [-Branch <branch>] [-Rollback <sha>]
param(
    [string]$Hostname = 'ak-home-server',
    [string]$Branch = 'main',
    [string]$Rollback = ''
)

$remoteArgs = @()
if ($Branch)   { $remoteArgs += "--branch $Branch" }
if ($Rollback) { $remoteArgs += "--rollback $Rollback" }

$remoteCommand = @"
cd ~/MyPortfolioSite
bash scripts/deploy/prod-deploy.sh $($remoteArgs -join ' ')
"@

Write-Host "Deploying branch '$Branch' to prod server..." -ForegroundColor Green

ssh $Hostname $remoteCommand
