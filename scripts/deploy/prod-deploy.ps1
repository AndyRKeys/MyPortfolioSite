# Trigger a production deploy from Windows via SSH.
# Connects to the server and runs prod-deploy.sh (which includes regression tests).
#
# IMPORTANT: If the server has rebooted, decrypt it first via Dropbear:
#   ssh -p 2222 root@ak-home-server
#   cryptroot-unlock
#   (enter disk encryption passphrase, wait for system to boot)
#
# Usage: .\scripts\deploy\prod-deploy.ps1 [-Hostname <name>] [-Branch <branch>] [-Rollback <sha>] [-SkipRegression] [-Quiet]
param(
    [string]$Hostname = 'ak-home-server',
    [string]$Branch = 'main',
    [string]$Rollback = '',
    [switch]$SkipRegression,
    [switch]$Quiet
)

$remoteArgs = @()
if ($Branch)         { $remoteArgs += "--branch $Branch" }
if ($Rollback)       { $remoteArgs += "--rollback $Rollback" }
if ($SkipRegression) { $remoteArgs += '--skip-regression' }
if ($Quiet)          { $remoteArgs += '--quiet' }

$remoteCommand = @"
cd ~/MyPortfolioSite
bash scripts/deploy/prod-deploy.sh $($remoteArgs -join ' ')
"@

Write-Host "Deploying branch '$Branch' to prod server..." -ForegroundColor Green

ssh $Hostname $remoteCommand
exit $LASTEXITCODE
