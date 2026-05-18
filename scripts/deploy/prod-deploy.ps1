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
    [string]$Branch = '',
    [string]$Rollback = '',
    [switch]$SkipRegression,
    [switch]$Quiet
)

$remoteArgs = @()
if ($Branch)         { $remoteArgs += "--branch $Branch" }
if ($Rollback)       { $remoteArgs += "--rollback $Rollback" }
if ($SkipRegression) { $remoteArgs += '--skip-regression' }
if ($Quiet)          { $remoteArgs += '--quiet' }
$remoteArgStr = $remoteArgs -join ' '

$label = if ($Branch) { $Branch } else { 'main' }
Write-Host "Deploying '$label' to prod..." -ForegroundColor Green

$remoteCommand = @"
REPO=~/MyPortfolioSite
TARGET_BRANCH="$Branch"
# Switch to the target branch first so the correct version of prod-deploy.sh runs
if [ -n "`$TARGET_BRANCH" ]; then
  git -C "`$REPO" fetch origin
  git -C "`$REPO" switch -C "`$TARGET_BRANCH" "origin/`$TARGET_BRANCH"
fi
bash "`$REPO/scripts/deploy/prod-deploy.sh" $remoteArgStr
"@

ssh $Hostname $remoteCommand
exit $LASTEXITCODE
