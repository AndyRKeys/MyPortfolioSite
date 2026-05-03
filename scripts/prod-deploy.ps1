# Production deploy — SSH to Pi and run prod-deploy.sh
# Requires Git Bash on Windows and SSH host alias 'raspberrypi3' configured.
#
# Usage: .\scripts\prod-deploy.ps1

& 'C:\Program Files\Git\bin\bash.exe' -c "ssh raspberrypi3 'bash ~/MyPortfolioSite/scripts/prod-deploy.sh'"
