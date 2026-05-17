# Trigger a production deploy from Windows via SSH.
# Uses switch-branch.sh to update the repo to the target branch first,
# then runs prod-deploy.sh — so the deploy always executes the current
# version of the scripts, not whatever was checked out before the pull.
#
# IMPORTANT: If the server has rebooted, decrypt it first via Dropbear:
#   ssh -p 2222 root@ak-home-server
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

Write-Host "Deploying branch '$Branch' to prod server..." -ForegroundColor Green

$remoteCommand = @"
PROD_REPO=`$HOME/MyPortfolioSite
BRANCH="$Branch"

# Switch to the requested branch (fetch + hard reset to origin)
bash "`$PROD_REPO/scripts/deploy/switch-branch.sh" "`$BRANCH" "`$PROD_REPO"

# Run the deploy with the now-current scripts
bash "`$PROD_REPO/scripts/deploy/prod-deploy.sh" $($remoteArgs -join ' ')
"@

# Strip CRLF — bash on the server rejects Windows line endings
$remoteCommand = $remoteCommand -replace "`r`n", "`n"

ssh $Hostname $remoteCommand
