# ============================================================
# DEPRECATED — DO NOT USE
# ============================================================
# Pi-era one-shot SSL/Nginx setup: it targets the old `raspberrypi3`
# SSH alias, writes a HOST Nginx vhost, hardcodes /home/pi/, and
# restarts PM2 (`pm2 restart portfolio-backend`). None of that
# reflects the current setup: production runs on Ubuntu Server
# (ak-home-server) with Nginx + backend in Docker Compose
# (docker-compose.prod.yml), and the repo lives at ~/MyPortfolioSite
# (prod) / ~/MyPortfolioSite-dev (dev).
#
# Use scripts/deploy/server-setup.sh for provisioning and the
# containerised Nginx config under scripts/config/ instead.
# Kept for historical reference only. See docs/TERMINOLOGY.md
# and docs/INFRASTRUCTURE.md.
# ============================================================
ssh raspberrypi3 @'
set -e

echo "=== Writing Nginx SSL config ==="
sudo tee /etc/nginx/sites-available/portfolio > /dev/null <<'NGINX'
server {
    listen 80;
    server_name andykeys.me www.andykeys.me;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name andykeys.me www.andykeys.me;

    ssl_certificate /etc/letsencrypt/live/andykeys.me/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/andykeys.me/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    root /home/pi/MyPortfolioSite;
    index index.html;

    location /auth/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /health {
        proxy_pass http://127.0.0.1:8080;
    }

    location / {
        try_files $uri $uri/ $uri.html =404;
    }
}
NGINX

echo "=== Updating backend .env ==="
sed -i "s|WEBAUTHN_RP_ID=.*|WEBAUTHN_RP_ID=andykeys.me|" ~/MyPortfolioSite/backend/.env
sed -i "s|WEBAUTHN_ORIGIN=.*|WEBAUTHN_ORIGIN=https://andykeys.me|" ~/MyPortfolioSite/backend/.env
sed -i "s|FRONTEND_URL=.*|FRONTEND_URL=https://andykeys.me|" ~/MyPortfolioSite/backend/.env

echo "=== Restarting backend ==="
pm2 restart portfolio-backend

echo "=== Reloading Nginx ==="
sudo nginx -t && sudo systemctl reload nginx

echo "=== Enabling cert auto-renewal ==="
sudo systemctl enable certbot.timer
sudo systemctl start certbot.timer

echo ""
echo "Done! Visit https://andykeys.me/setup.html"
'@
