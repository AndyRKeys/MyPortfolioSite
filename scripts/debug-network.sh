#!/bin/bash
# Network and deployment debug script for andykeys.me
# Run on the Pi: bash ~/MyPortfolioSite/scripts/debug-network.sh
# Paste the full output when reporting issues.

BAR="======================================="

echo "$BAR"
echo "DEBUG REPORT — $(date)"
echo "$BAR"

echo ""
echo "--- Network Interfaces ---"
ip addr show

echo ""
echo "--- Routing Table ---"
ip route show

echo ""
echo "--- Default Gateway ---"
ip route | grep default

echo ""
echo "--- Public IP (as seen from internet) ---"
curl -s --max-time 5 https://api.ipify.org && echo ""

echo ""
echo "--- DNS resolution for andykeys.me ---"
nslookup andykeys.me 2>&1 || host andykeys.me 2>&1 || echo "nslookup/host not available"

echo ""
echo "--- Nginx status ---"
sudo systemctl status nginx --no-pager -l

echo ""
echo "--- Nginx config test ---"
sudo nginx -t 2>&1

echo ""
echo "--- Active nginx sites ---"
ls -la /etc/nginx/sites-enabled/

echo ""
echo "--- Rendered nginx config ---"
cat /etc/nginx/sites-available/portfolio 2>/dev/null || echo "MISSING: /etc/nginx/sites-available/portfolio"

echo ""
echo "--- Local HTTP test (nginx root) ---"
curl -s -o /dev/null -w "HTTP %{http_code} — %{url_effective}\n" http://localhost/

echo ""
echo "--- Local API health check (via nginx /api/) ---"
curl -s -w "\nHTTP %{http_code}" http://localhost/api/health
echo ""

echo ""
echo "--- Direct backend health check (bypassing nginx) ---"
APP_PORT=$(grep "^PORT=" ~/MyPortfolioSite/backend/.env 2>/dev/null | cut -d= -f2)
APP_PORT=${APP_PORT:-8080}
curl -s -w "\nHTTP %{http_code}" http://localhost:$APP_PORT/health
echo ""

echo ""
echo "--- PM2 status ---"
pm2 status

echo ""
echo "--- PM2 backend logs (last 30 lines) ---"
pm2 logs portfolio-backend --lines 30 --nostream 2>&1

echo ""
echo "--- Port listeners ---"
sudo ss -tlnp | grep -E ':(80|443|8080)'

echo ""
echo "--- WiFi status ---"
rfkill list wifi
ip link show wlan0 2>/dev/null || echo "wlan0 not present"

echo ""
echo "--- backend .env (secrets redacted) ---"
if [ -f ~/MyPortfolioSite/backend/.env ]; then
    sed 's/=.*/=***/' ~/MyPortfolioSite/backend/.env
else
    echo "MISSING: backend/.env"
fi

echo ""
echo "$BAR"
echo "END OF REPORT"
echo "$BAR"
