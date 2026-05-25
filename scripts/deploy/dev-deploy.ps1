# Trigger a dev server deploy from Windows via SSH.
# Connects to the Ubuntu Server, switches to the requested branch via
# switch-branch.sh, then runs deploy.sh --env dev.
#
# Usage: .\scripts\deploy\dev-deploy.ps1 [-Hostname <name>] [-Branch <branch>] [-SkipRegression $true] [-Quiet $true]
param(
    [string]$Hostname = 'ak-home-server',
    [string]$Branch = '',
    [bool]$SkipRegression = $false,
    [bool]$Quiet = $true,
    [bool]$DryRun = $false,
    [bool]$AutoYes = $true
)

# Detect current branch if not specified
if ([string]::IsNullOrEmpty($Branch)) {
    $Branch = git rev-parse --abbrev-ref HEAD
    Write-Host "Detected branch: $Branch" -ForegroundColor Cyan
}

if ($DryRun) {
    Write-Host "Dry-run: checking pre-flights for branch '$Branch' on dev server..." -ForegroundColor Cyan
} else {
    Write-Host "Deploying branch '$Branch' to dev server..." -ForegroundColor Green
}

$flags = @()
if ($SkipRegression) { $flags += '--skip-regression' }
if ($Quiet)          { $flags += '--quiet' }
if ($DryRun)         { $flags += '--dry-run' }
if ($AutoYes)        { $flags += '--auto-yes' }
$flagStr = $flags -join ' '

# Resolve the remote home directory for the SSH user so paths in the
# printed command are exact — avoids the opaque $HOME bash variable.
$RemoteHome = (ssh $Hostname 'echo $HOME').Trim()
$RepoUrl    = 'https://github.com/AndyRKeys/MyPortfolioSite.git'
$DevRepo    = "$RemoteHome/MyPortfolioSite-dev"

$remoteCommand = @"
if [ ! -d "$DevRepo/.git" ]; then
    git clone "$RepoUrl" "$DevRepo"
fi
bash "$DevRepo/scripts/deploy/switch-branch.sh" "$Branch" "$DevRepo"
bash "$DevRepo/scripts/deploy/deploy.sh" --env dev "$Branch" $flagStr
"@

# Strip CRLF — bash on the server rejects Windows line endings
$remoteCommand = $remoteCommand -replace "`r`n", "`n"

Write-Host "Executing remote command on $Hostname" -ForegroundColor Yellow
Write-Host $remoteCommand -ForegroundColor Yellow

ssh $Hostname $remoteCommand
exit $LASTEXITCODE
