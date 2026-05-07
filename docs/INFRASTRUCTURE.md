# Infrastructure

_Last updated: 2026-05-07_

This document covers the production server setup, service architecture, operational procedures, and troubleshooting. It is written for agents and operators who need to understand the system without asking the owner for details.

---

## Current Setup (Raspberry Pi)

### Hardware

- **Device:** Raspberry Pi (model 4B recommended, 2GB+ RAM)
- **OS:** Raspbian (Debian-based)
- **Storage:** SD card (32GB recommended; failures are a known risk)
- **Network:** Dynamic IP with DDNS (updated every 5 minutes)

### Services

| Service | Technology | Port | Status | Notes |
|---------|-----------|------|--------|-------|
| **Nginx** | nginx:latest (reverse proxy + static files) | 80, 443 | Systemd service | Routes `/api/*` to Node backend; serves static HTML/CSS/JS |
| **Node backend** | Node.js 20+ (Express) | 8080 | PM2-managed | Main application; handles API routes, auth, database ops |
| **PostgreSQL** | postgres:15 (system install) | 5432 | Systemd service | Database; stores posts, users, audit log |
| **SSL/TLS** | Let's Encrypt + certbot | - | Systemd timer | Auto-renewal via cron; renews 30 days before expiry |
| **DNS** | ddclient | - | Cron job | Updates DDNS record every 5 minutes if IP changes |

### Directory Structure (on Pi)

```
/home/pi/
├── MyPortfolioSite/          ← cloned repo
│   ├── backend/              ← Node.js source code
│   ├── resources/            ← frontend (HTML/CSS/JS)
│   ├── docs/                 ← documentation (you are here)
│   ├── scripts/              ← deployment and utility scripts
│   └── docker-compose.yml    ← (dev environment; not used in prod yet)
│
├── uploads/                  ← user-uploaded files (CVs, images)
│
└── backups/                  ← (future) database backups live here
```

### Service Names & PIDs

| Service | Type | Status command | Restart command |
|---------|------|---|---|
| **Nginx** | systemd | `sudo systemctl status nginx` | `sudo systemctl restart nginx` |
| **Node backend** | PM2 | `pm2 status` | `pm2 restart portfolio-backend` |
| **PostgreSQL** | systemd | `sudo systemctl status postgresql` | `sudo systemctl restart postgresql` |
| **certbot renewal** | systemd timer | `sudo systemctl status certbot.timer` | N/A (automatic) |
| **ddclient** | cron | `sudo crontab -l` | (edit cron) |

### Key File Locations

| File/Directory | Path | Purpose |
|---|---|---|
| **Node app** | `/home/pi/MyPortfolioSite/backend/server.js` | Express entry point |
| **PM2 config** | (in-memory, no config file) | PM2 managed via `pm2 start/restart` |
| **Nginx config** | `/etc/nginx/sites-enabled/default` | Reverse proxy + static files |
| **Nginx SSL template** | `/etc/nginx/sites-available/` or generated on-disk | SSL cert paths rendered by deploy script |
| **SSL certs** | `/etc/letsencrypt/live/<domain>/` | certbot-managed Let's Encrypt certs |
| **Database** | `/var/lib/postgresql/15/main/` | PostgreSQL data directory |
| **Uploads** | `/home/pi/MyPortfolioSite/uploads/` | User-uploaded files |
| **Backend env** | `/home/pi/MyPortfolioSite/backend/.env` | Environment variables (DB credentials, JWT secret, etc.) |
| **ddclient config** | `/etc/ddclient/ddclient.conf` | Dynamic DNS client configuration |

---

## Deployment Process

### Deploy from Windows

```powershell
.\scripts\deploy\prod-deploy.ps1
```

This script:
1. SSHes into the Pi
2. Runs `bash ~/MyPortfolioSite/scripts/deploy/prod-deploy.sh`
3. Returns success/failure status

**SSH key:** must be configured for passwordless auth (see [SSH Troubleshooting](#ssh-troubleshooting) below)

### Deploy on Pi (automated by prod-deploy.ps1)

```bash
cd ~/MyPortfolioSite
git fetch origin main
git reset --hard origin/main
npm install --omit=dev                           # if package.json changed
psql -U postgres -d portfolio_db -f backend/db/schema.sql  # if schema.sql changed
pm2 restart portfolio-backend
sudo systemctl reload nginx                      # if nginx config template changed
pm2 save
```

**Deploy output:** Logged in `pm2 logs portfolio-backend`

---

## Common Operational Tasks

### Check logs

```bash
# Backend logs (current session + history)
pm2 logs portfolio-backend

# Last 50 lines
pm2 logs portfolio-backend --lines 50

# Nginx error log
sudo tail -f /var/log/nginx/error.log

# PostgreSQL log
sudo journalctl -u postgresql -f
```

### Restart a service

```bash
# Node backend (fastest)
pm2 restart portfolio-backend

# Nginx (reload config without dropping connections)
sudo systemctl reload nginx

# Nginx (full restart)
sudo systemctl restart nginx

# PostgreSQL (rarely needed)
sudo systemctl restart postgresql
```

### Check database

```bash
# Connect to the database
psql -U postgres -d portfolio_db

# List tables
\dt

# Check a specific table
SELECT COUNT(*) FROM posts;

# Exit
\q
```

### Renew SSL cert (manual)

```bash
# Normally happens automatically via systemd timer
# But if you need to renew manually:
sudo certbot renew

# Check cert expiry
sudo certbot certificates
```

### Check system health

```bash
# Disk usage
df -h

# Memory usage
free -h

# CPU load
uptime

# Process list (find portfolio backend)
ps aux | grep node
```

### Tail all PM2 logs

```bash
pm2 logs
```

---

## Troubleshooting

### Backend not responding (HTTP 502 from Nginx)

**Symptoms:** Browser shows "Bad Gateway" or "502 Service Unavailable"

**Steps:**
1. Check if backend is running: `pm2 status`
2. If stopped, restart: `pm2 restart portfolio-backend`
3. Check logs: `pm2 logs portfolio-backend --lines 50`
4. If logs show DB errors, check PostgreSQL: `sudo systemctl status postgresql`
5. If DB is down, restart it: `sudo systemctl restart postgresql`
6. Verify port 8080 is listening: `netstat -tlnp | grep 8080` or `ss -tlnp | grep 8080`

### Database connection errors in logs

**Symptoms:** `Error: connect ECONNREFUSED 127.0.0.1:5432` or similar

**Steps:**
1. Check PostgreSQL status: `sudo systemctl status postgresql`
2. If not running: `sudo systemctl start postgresql`
3. Verify it's listening: `sudo netstat -tlnp | grep postgres`
4. Check credentials in `.env` match PostgreSQL setup
5. Try connecting manually: `psql -U postgres -d portfolio_db` (requires valid password from `.env`)

### Nginx config errors

**Symptoms:** Nginx won't start or reload; browser shows 502

**Steps:**
1. Test syntax: `sudo nginx -t`
2. Check error log: `sudo tail -f /var/log/nginx/error.log`
3. Common issues:
   - Missing SSL cert file at `/etc/letsencrypt/live/<domain>/`
   - Typo in config file
   - Port already in use by another service
4. Fix the config, then reload: `sudo systemctl reload nginx`

### SSL cert about to expire or expired

**Symptoms:** Browser HTTPS warning; `certbot certificates` shows expiry date in red

**Steps:**
1. Renew manually: `sudo certbot renew`
2. Check result: `sudo certbot certificates`
3. If renewal fails, check logs: `sudo journalctl -u certbot -n 50`
4. Common issues:
   - Port 80 not accessible (needed for renewal)
   - DNS not resolving the domain
   - Let's Encrypt rate limit (wait 1 hour)

### SSH Troubleshooting

**Problem:** Password prompt instead of key-based auth

**Steps:**
1. Verify key exists locally: `ls ~/.ssh/id_rsa` (or `id_ed25519`)
2. Copy public key to Pi: `ssh-copy-id -i ~/.ssh/id_rsa.pub pi@<pi-ip>`
3. Test: `ssh pi@<pi-ip>` (should not prompt for password)
4. Verify `~/.ssh/authorized_keys` on Pi contains your public key

**Problem:** Slow SSH connection (hangs on login)

**Steps:**
1. Check Pi disk space: `ssh pi@<pi-ip> 'df -h'` (SD card filling up is common)
2. If full, clean up old logs: `ssh pi@<pi-ip> 'sudo journalctl --vacuum=100M'`
3. Check PM2 logs for crashes: `ssh pi@<pi-ip> 'pm2 logs --lines 5'`

### PM2 crashed or unresponsive

**Symptoms:** `pm2 status` hangs or returns error

**Steps:**
1. Kill PM2 daemon: `pm2 kill`
2. Restart backend: `pm2 start ~/MyPortfolioSite/backend/server.js --name portfolio-backend`
3. Verify: `pm2 status`
4. Save config: `pm2 save`

---

## Production vs Dev Environment Differences

| Aspect | Production (Pi) | Development (Docker) |
|--------|---|---|
| **Node runtime** | PM2 on host | Docker container |
| **Database** | System PostgreSQL | Docker container |
| **Nginx** | System nginx | Docker container |
| **File serving** | Nginx on host | Nginx in container |
| **SSL** | Let's Encrypt (host-level certs) | Self-signed or none (local dev) |
| **Env vars** | `.env` file in repo root | `.env` in docker-compose |
| **Logs** | PM2 logs, systemd journal | `docker compose logs` |
| **Config changes** | Edit on server, reload/restart | Edit locally, restart container |

**Future:** Production will move to Docker Compose on the Ubuntu Server, making dev and prod identical.

---

## Update Discipline

This document should be updated when:

- Service locations change (new directory, new hostname)
- New services are added to the stack
- Operational procedures change (e.g., logging, restart commands)
- A troubleshooting issue is discovered and resolved (add it here)

It should **not** be updated for every deploy or minor log output change. It is a reference guide, not a changelog.

---

## See Also

- `ROADMAP.md` — planned infrastructure changes (Docker Compose prod, Ubuntu Server migration)
- `docs/SECURITY.md` — auth model, threat model
- `README.md` — local dev setup, branching, deployment overview
