# Trigger a production deploy from Windows via SSH.
# Connects to the server, runs prod-deploy.sh, then runs regression smoke tests
# from this machine against the live site.
#
# IMPORTANT: If the server has rebooted, decrypt it first via Dropbear:
#   ssh -p 2222 root@ak-home-server
#   cryptroot-unlock
#   (enter disk encryption passphrase, wait for system to boot)
#
# Usage: .\scripts\deploy\prod-deploy.ps1 [-Hostname <name>] [-Branch <branch>] [-Rollback <sha>] [-SkipRegression]
param(
    [string]$Hostname = 'ak-home-server',
    [string]$Branch = 'main',
    [string]$Rollback = '',
    [switch]$SkipRegression
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

if ($LASTEXITCODE -ne 0) {
    Write-Host "Deploy failed — skipping regression tests." -ForegroundColor Red
    exit $LASTEXITCODE
}

if (-not $SkipRegression -and -not $Rollback) {
    Write-Host ""
    Write-Host "Fetching DOMAIN from prod server for regression tests..." -ForegroundColor Cyan
    $domain = ssh $Hostname "grep '^DOMAIN=' ~/MyPortfolioSite/.env 2>/dev/null | cut -d= -f2 | head -1"
    $domain = $domain.Trim()

    if ($domain) {
        $baseUrl = "https://${domain}"

        # Generate JWT on the remote server so it is signed with the server's actual JWT_SECRET
        $token = ssh $Hostname @'
source <(grep -E '^JWT_SECRET=' ~/MyPortfolioSite/.env 2>/dev/null)
docker compose -f ~/MyPortfolioSite/docker-compose.prod.yml exec -T backend \
  node -e "
    const jwt = require('jsonwebtoken');
    if (!process.env.JWT_SECRET) { process.stderr.write('NO_SECRET\n'); process.exit(1); }
    console.log(jwt.sign({ userId: 'prod-test-user' }, process.env.JWT_SECRET, { expiresIn: '1h' }));
  " 2>/dev/null
'@
        $token = ($token -split "`n" | Where-Object { $_ -match '^eyJ' } | Select-Object -Last 1).Trim()
        $tokenArgs = if ($token) { @('-Token', $token) } else { @() }

        Write-Host "Running regression tests against $baseUrl..." -ForegroundColor Cyan
        & "$PSScriptRoot\..\tests\Test-Regression.ps1" -BaseUrl $baseUrl @tokenArgs
        if ($LASTEXITCODE -ne 0) {
            Write-Host ""
            Write-Host "Regression tests failed — site is live but smoke checks did not pass." -ForegroundColor Red
            Write-Host "Run .\scripts\tests\Test-Regression.ps1 -BaseUrl $baseUrl for details." -ForegroundColor Yellow
            exit 1
        }
    } else {
        Write-Host "Could not read DOMAIN from prod server .env — skipping regression tests." -ForegroundColor Yellow
    }
}
