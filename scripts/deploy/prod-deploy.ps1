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
    [string]$RemoteHome = '/home/ak',
    [string]$Rollback = '',
    [bool]$SkipRegression = $false,
    [bool]$Quiet = $false,
    [bool]$DryRun = $false,
    [bool]$AutoYes = $false
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
if ($AutoYes)        { $flags += '--auto-yes' }
$flagStr = $flags -join ' '

$RepoUrl  = 'https://github.com/AndyRKeys/MyPortfolioSite.git'
$ProdRepo = "$RemoteHome/MyPortfolioSite"

$remoteCommand = @"
if [ ! -d "$ProdRepo/.git" ]; then
    git clone "$RepoUrl" "$ProdRepo"
fi
bash "$ProdRepo/scripts/deploy/switch-branch.sh" "main" "$ProdRepo"
bash "$ProdRepo/scripts/deploy/deploy.sh" --env prod $flagStr
"@

# Strip CRLF — bash on the server rejects Windows line endings
$remoteCommand = $remoteCommand -replace "`r`n", "`n"

Write-Host "Executing remote command on $Hostname" -ForegroundColor Yellow
Write-Host $remoteCommand -ForegroundColor Yellow

ssh $Hostname $remoteCommand
exit $LASTEXITCODE
