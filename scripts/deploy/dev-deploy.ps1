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
    [bool]$DryRun = $false
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
$flagStr = $flags -join ' '

$remoteCommand = @"
DEV_REPO=`$HOME/MyPortfolioSite-dev
REPO_URL=https://github.com/AndyRKeys/MyPortfolioSite.git
BRANCH="$Branch"
if [ ! -d "`$DEV_REPO/.git" ]; then
    git clone "`$REPO_URL" "`$DEV_REPO"
fi
bash "`$DEV_REPO/scripts/deploy/switch-branch.sh" "`$BRANCH" "`$DEV_REPO"
bash "`$DEV_REPO/scripts/deploy/deploy.sh" --env dev "`$BRANCH" $flagStr
"@

# Strip CRLF — bash on the server rejects Windows line endings
$remoteCommand = $remoteCommand -replace "`r`n", "`n"

ssh $Hostname $remoteCommand
exit $LASTEXITCODE
