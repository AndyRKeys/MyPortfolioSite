# ============================================================
# DEPRECATED — DO NOT USE
# ============================================================
# Pi-era SSL bootstrap: targets the old `raspberrypi3` SSH alias
# and runs host-level certbot/Nginx. Production now runs on Ubuntu
# Server (ak-home-server) with containerised Nginx; certs are
# managed via scripts/backup/certbot-renew.sh and the Docker setup.
# Use scripts/deploy/server-setup.sh for provisioning.
# Kept for historical reference only. See docs/TERMINOLOGY.md.
# ============================================================
ssh raspberrypi3 @'
set -e

echo "=== Installing certbot ==="
sudo apt-get install -y certbot python3-certbot-nginx

echo "=== Obtaining Let's Encrypt certificate for andykeys.me ==="
sudo certbot --nginx -d andykeys.me -d www.andykeys.me --non-interactive --agree-tos -m andy@logic-gg.me --redirect

echo "=== Updating backend .env ==="
sudo sed -i "s|WEBAUTHN_RP_ID=.*|WEBAUTHN_RP_ID=andykeys.me|" ~/MyPortfolioSite/backend/.env
sudo sed -i "s|WEBAUTHN_ORIGIN=.*|WEBAUTHN_ORIGIN=https://andykeys.me|" ~/MyPortfolioSite/backend/.env
sudo sed -i "s|FRONTEND_URL=.*|FRONTEND_URL=https://andykeys.me|" ~/MyPortfolioSite/backend/.env

echo "=== Restarting backend ==="
pm2 restart portfolio-backend

echo "=== Reloading Nginx ==="
sudo nginx -t && sudo systemctl reload nginx

echo "=== Setting up certbot auto-renewal ==="
sudo systemctl enable certbot.timer
sudo systemctl start certbot.timer

echo ""
echo "Done! Visit https://andykeys.me/setup.html to create your admin account."
'@
