# Trigger a production deploy from Windows via SSH.
# Connects to the Ubuntu Server, switches to main via switch-branch.sh,
# then runs deploy.sh --env prod.
#
# IMPORTANT: If the server has rebooted, decrypt it first via Dropbear:
#   ssh -p 2222 root@ak-home-server
#   cryptroot-unlock
#   (enter disk encryption passphrase, wait for system to boot)
#
# Usage: .\scripts\deploy\prod-deploy.ps1 [-Hostname <name>] [-Rollback <sha>] [-SkipRegression $true] [-Quiet $true]
param(
    [string]$Hostname = 'ak-home-server',
    [string]$Rollback = '',
    [bool]$SkipRegression = $false,
    [bool]$Quiet = $false,
    [bool]$DryRun = $false
)

if ($DryRun) {
    Write-Host "Dry-run: checking pre-flights for main on prod server..." -ForegroundColor Cyan
} else {
    Write-Host "Deploying main to prod server..." -ForegroundColor Green
}

$flags = @()
if ($Rollback)       { $flags += "--rollback $Rollback" }
if ($SkipRegression) { $flags += '--skip-regression' }
if ($Quiet)          { $flags += '--quiet' }
if ($DryRun)         { $flags += '--dry-run' }
$flagStr = $flags -join ' '

$remoteCommand = @"
PROD_REPO=`$HOME/MyPortfolioSite
REPO_URL=https://github.com/AndyRKeys/MyPortfolioSite.git
if [ ! -d "`$PROD_REPO/.git" ]; then
    git clone "`$REPO_URL" "`$PROD_REPO"
fi
bash "`$PROD_REPO/scripts/deploy/switch-branch.sh" "main" "`$PROD_REPO"
bash "`$PROD_REPO/scripts/deploy/deploy.sh" --env prod $flagStr
"@

# Strip CRLF — bash on the server rejects Windows line endings
$remoteCommand = $remoteCommand -replace "`r`n", "`n"

ssh $Hostname $remoteCommand
exit $LASTEXITCODE
