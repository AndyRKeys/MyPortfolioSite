# Trigger a dev server deploy from Windows via SSH.
# Connects to the Ubuntu Server, runs dev-deploy.sh via switch-branch.sh,
# then runs the regression smoke tests from this machine against the live site.
#
# Usage: .\scripts\deploy\dev-deploy.ps1 [-Hostname <name>] [-Branch <branch>] [-SkipRegression]
param(
    [string]$Hostname = 'ak-home-server',
    [string]$Branch = '',
    [switch]$SkipRegression
)

# Detect current branch if not specified
if ([string]::IsNullOrEmpty($Branch)) {
    $Branch = git rev-parse --abbrev-ref HEAD
    Write-Host "Detected branch: $Branch" -ForegroundColor Cyan
}

Write-Host "Deploying branch '$Branch' to dev server..." -ForegroundColor Green

$remoteCommand = @"
DEV_REPO=`$HOME/MyPortfolioSite-dev
REPO_URL=https://github.com/AndyRKeys/MyPortfolioSite.git
BRANCH="$Branch"
if [ ! -d "`$DEV_REPO/.git" ]; then
    git clone "`$REPO_URL" "`$DEV_REPO"
fi
bash "`$DEV_REPO/scripts/deploy/switch-branch.sh" "`$BRANCH" "`$DEV_REPO"
bash "`$DEV_REPO/scripts/deploy/dev-deploy.sh" "`$BRANCH"
"@

# Strip CRLF — bash on the server rejects Windows line endings
$remoteCommand = $remoteCommand -replace "`r`n", "`n"

ssh $Hostname $remoteCommand

if ($LASTEXITCODE -ne 0) {
    Write-Host "Deploy failed — skipping regression tests." -ForegroundColor Red
    exit $LASTEXITCODE
}

if (-not $SkipRegression) {
    Write-Host ""
    Write-Host "Fetching WEBAUTHN_HOST and JWT from dev server for regression tests..." -ForegroundColor Cyan

    $devHost = ssh $Hostname "grep '^WEBAUTHN_HOST=' ~/MyPortfolioSite-dev/.env 2>/dev/null | cut -d= -f2 | head -1"
    $devHost = $devHost.Trim()

    # Generate JWT on the remote server so it is signed with the server's actual JWT_SECRET
    $token = ssh $Hostname @'
source <(grep -E '^JWT_SECRET=' ~/MyPortfolioSite-dev/.env 2>/dev/null)
docker compose -f ~/MyPortfolioSite-dev/docker-compose.dev-server.yml exec -T backend-dev \
  node -e "
    const jwt = require('jsonwebtoken');
    if (!process.env.JWT_SECRET) { process.stderr.write('NO_SECRET\n'); process.exit(1); }
    console.log(jwt.sign({ userId: 'dev-test-user' }, process.env.JWT_SECRET, { expiresIn: '1h' }));
  " 2>/dev/null
'@
    $token = ($token -split "`n" | Where-Object { $_ -match '^eyJ' } | Select-Object -Last 1).Trim()

    if ($devHost) {
        $baseUrl = "https://${devHost}:3001"
        Write-Host "Running regression tests against $baseUrl..." -ForegroundColor Cyan
        $tokenArgs = if ($token) { @('-Token', $token) } else { @() }
        & "$PSScriptRoot\..\tests\Test-Regression.ps1" -BaseUrl $baseUrl -Insecure -SkipSecurity @tokenArgs
        if ($LASTEXITCODE -ne 0) {
            Write-Host ""
            Write-Host "Regression tests failed — site is live but smoke checks did not pass." -ForegroundColor Red
            Write-Host "Run .\scripts\tests\Test-Regression.ps1 -BaseUrl $baseUrl -Insecure for details." -ForegroundColor Yellow
            exit 1
        }
    } else {
        Write-Host "Could not read WEBAUTHN_HOST from dev server .env — skipping regression tests." -ForegroundColor Yellow
    }
}
