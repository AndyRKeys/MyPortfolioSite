# Trigger a dev server deploy from Windows via SSH.
# Connects to the Ubuntu Server and runs dev-deploy.sh (which includes regression tests).
#
# Usage: .\scripts\deploy\dev-deploy.ps1 [-Hostname <name>] [-Branch <branch>] [-SkipRegression] [-Quiet]
param(
    [string]$Hostname = 'ak-home-server',
    [string]$Branch = '',
    [switch]$SkipRegression,
    [switch]$Quiet
)

# Detect current branch if not specified
if ([string]::IsNullOrEmpty($Branch)) {
    $Branch = git rev-parse --abbrev-ref HEAD
    Write-Host "Detected branch: $Branch" -ForegroundColor Cyan
}

Write-Host "Deploying branch '$Branch' to dev server..." -ForegroundColor Green

$flags = @()
if ($SkipRegression) { $flags += '--skip-regression' }
if ($Quiet)          { $flags += '--quiet' }
$flagStr = $flags -join ' '

$remoteCommand = @"
DEV_REPO=`$HOME/MyPortfolioSite-dev
REPO_URL=https://github.com/AndyRKeys/MyPortfolioSite.git
BRANCH="$Branch"
if [ ! -d "`$DEV_REPO/.git" ]; then
    git clone "`$REPO_URL" "`$DEV_REPO"
fi
bash "`$DEV_REPO/scripts/deploy/switch-branch.sh" "`$BRANCH" "`$DEV_REPO"
bash "`$DEV_REPO/scripts/deploy/dev-deploy.sh" "`$BRANCH" $flagStr
"@

# Strip CRLF — bash on the server rejects Windows line endings
$remoteCommand = $remoteCommand -replace "`r`n", "`n"

ssh $Hostname $remoteCommand
exit $LASTEXITCODE
