# Production Server Setup

_Last updated: 2026-05-10 — verified against live server post-migration_

Production infrastructure for MyPortfolioSite running on Ubuntu Server. This document captures the configuration and operational procedures for the **production environment** (`main` branch).

For a high-level overview of both dev and prod environments, see `INFRASTRUCTURE.md`. For dev-specific setup, see `DEV_SERVER_SETUP.md`.

---

## Hardware and host OS

- **Device:** Old gaming PC running headless Ubuntu Server LTS
- **OS:** Ubuntu 24.04.4 LTS (kernel 6.8.0-111-generic)
- **Hostname:** `<server-hostname>`
- **User:** `<username>` (non-root user with sudo access)
- **Repo path:** `/home/<username>/MyPortfolioSite`
- **Backups path:** `/home/<username>/backups`
- **Storage:** Internal SSD (more reliable than the previous Pi SD card)
- **Network:** Dynamic IP with DDNS (ddclient updates DNS every 5 minutes)
- **GPU:** Available for future local LLM inference (#173)

Docker is installed via the official Docker CE apt packages. Docker via snap is not supported.

---

## Services (Docker Compose)

All production services run as Docker containers managed by:

```bash
docker compose -f docker-compose.prod.yml <command>
```

**Docker:** 29.4.3 | **Docker Compose:** v5.1.3

| Service | Image | Port (host) | Purpose |
|---------|-------|-------------|---------|
| **nginx** | nginx:alpine | 80, 443 → host | Reverse proxy + static file serving; terminates SSL |
| **backend** | myportfoliosite-backend (node:20-alpine, prod stage) | 8080 (internal only) | Express API; handles all `/api/*` routes |
| **postgres** | postgres:16-alpine | 5432 (internal only) | PostgreSQL database; data in named volume |

**SSL:** Let's Encrypt certs managed by host-level Certbot; `/etc/letsencrypt` bind-mounted into the nginx container read-only.

**DDNS:** ddclient runs on the host (not containerized) to update the DNS record when the IP changes. Configured via cron.

---

## Directory structure

On the server, the relevant directories are:

```bash
/home/<username>/
├── MyPortfolioSite/          ← cloned repo (main branch)
│   ├── backend/              ← Node.js source code (in Docker image)
│   ├── resources/            ← frontend HTML/CSS/JS (served by nginx)
│   ├── docs/                 ← documentation
│   ├── scripts/
│   │   ├── config/           ← nginx config templates
│   │   │   ├── nginx-local.conf.template (dev, HTTP only)
│   │   │   └── nginx-portfolio.conf.template (prod, HTTPS)
│   │   ├── deploy/           ← prod-deploy.sh, server-setup.sh, check-server-ready.sh
│   │   ├── ops/              ← gather-infrastructure-info.sh
│   │   └── backup/           ← db-backup.sh, db-restore.sh, offsite-sync.sh, certbot-renew.sh
│   ├── docker-compose.prod.yml  ← standalone prod compose file
│   ├── docker-compose.yml    ← local dev compose file
│   └── .env                  ← production env vars (never committed)
│
~/backups/                    ← database and uploads backups (local rotation, 7-day retention)
/etc/letsencrypt/             ← SSL certs (managed by certbot on host)
│   ├── live/                 ← symlinks to current certs
│   ├── archive/              ← cert versions
│   ├── accounts/             ← certbot accounts
│   ├── renewal/              ← cert renewal configs
│   ├── renewal-hooks/        ← renewal hook scripts
│   └── options-ssl-nginx.conf ← nginx TLS options
```

---

## Docker volumes

| Volume | Purpose |
|--------|---------|
| `myportfoliosite_postgres_data` | PostgreSQL data directory (persists across deploys) |
| `myportfoliosite_uploads_data` | User-uploaded files (CVs, images) |

---

## Key files

| File/Directory | Path | Purpose |
|----------------|------|---------|
| **Prod env vars** | `~/MyPortfolioSite/.env` | All production configuration (DB creds, JWT secret, SMTP, domain) |
| **Env template** | `~/MyPortfolioSite/.env.example` | Template for setting up `.env` on a new server |
| **Nginx config template** | `scripts/config/nginx-portfolio.conf.template` | Prod nginx (HTTPS + reverse proxy), rendered at container startup |
| **SSL certs** | `/etc/letsencrypt/live/<domain>/` | Let's Encrypt certs; bind-mounted into nginx container |
| **Uploads** | Docker volume `myportfoliosite_uploads_data` | User-uploaded files; accessible at `/app/uploads` inside backend |
| **Database** | Docker volume `myportfoliosite_postgres_data` | PostgreSQL data; inspect via `docker compose exec postgres psql` |
| **Deploy log** | `~/prod-deploy.log` | Timestamped deploy history (from prod-deploy.sh) |
| **Backup log** | `~/backup.log` | Backup run history |

---

## Initial server setup (one-time)

On a fresh Ubuntu Server install:

```bash
# Clone repo and run setup script (pass your domain as argument)
git clone https://github.com/AndyRKeys/MyPortfolioSite.git ~/MyPortfolioSite
bash ~/MyPortfolioSite/scripts/deploy/server-setup.sh yourdomain.com
```

The setup script handles:

1. Installing system packages (curl, git, certbot, rclone, etc.).
2. Docker CE installation + group membership for the deploy user.
3. SSH hardening (disables password auth; key-only).
4. Creating `.env` from `.env.example` and prompting you to fill in secrets.
5. Obtaining an initial SSL certificate via certbot standalone.
6. Running `docker compose -f docker-compose.prod.yml up -d --build`.
7. Wiring up cron jobs for backups and cert renewal.

After setup:

- Edit `~/MyPortfolioSite/.env` and ensure all required values are set.
- Re-run `docker compose -f docker-compose.prod.yml up -d --build`.

---

## Disk encryption and Dropbear unlock

The server uses **LUKS full-disk encryption** with **Dropbear SSH** in the initramfs to allow remote unlock after reboots.

### How disk unlock works

1. On boot, the encrypted root filesystem is locked.
2. A minimal Dropbear SSH server listens on port 2222.
3. You SSH in as root and run `cryptroot-unlock`.
4. Enter the disk encryption passphrase.
5. The system decrypts the disk and boots the main OS.
6. Normal SSH on port 22 becomes available.

### Remote unlock procedure

From another machine:

```powershell
# Connect to Dropbear on port 2222
ssh -p 2222 root@<server-hostname>

# In the Dropbear shell, type (do NOT copy-paste):
cryptroot-unlock
# Enter disk encryption passphrase manually

# Wait 10–15 seconds for boot, then deploy normally:
.\scripts\deploy\prod-deploy.ps1
```

The disk encryption passphrase is **not** stored in the repo or `.env`; keep it in a secure password manager.

---

## Deployment

### From Windows

```powershell
.\scripts\deploy\prod-deploy.ps1
```

- SSHes into the server and runs `scripts/deploy/prod-deploy.sh`.
- Accepts `-Rollback <sha>` to roll back to a previous commit.

### From the server

```bash
cd ~/MyPortfolioSite
bash scripts/deploy/prod-deploy.sh
# or: bash scripts/deploy/prod-deploy.sh --rollback <sha>
```

The deploy script (on the feature branch) uses the shared `deploy-lib.sh` to:

- Check prerequisites (docker, docker compose, git, curl).
- Ensure the repo exists and is on `main`.
- Validate `.env` (including `JWT_SECRET` length, domain sanity).
- Fetch and reset to `origin/main`.
- Rebuild containers via `docker compose -f docker-compose.prod.yml up -d --build`.
- Wait for backend and HTTPS health checks.
- Roll back to the previous commit if deploy/health fails.

Logs are written to `~/prod-deploy.log`.

---

## Common operational commands

### Service status and logs

```bash
# Status of all containers
docker compose -f docker-compose.prod.yml ps

# Start all services (with rebuild)
docker compose -f docker-compose.prod.yml up -d --build

# Stop all services
docker compose -f docker-compose.prod.yml down

# Restart backend only
docker compose -f docker-compose.prod.yml restart backend

# View logs
docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml logs -f nginx
docker compose -f docker-compose.prod.yml logs --tail=50 postgres
```

### Database access

```bash
# Open psql shell
docker compose -f docker-compose.prod.yml exec postgres \
    psql -U postgres portfolio_prod

# Inside psql:
\dt           -- list tables
SELECT COUNT(*) FROM posts;
\q            -- exit
```

### SSL certificate renewal

Normally handled by cron via `scripts/backup/certbot-renew.sh`. To renew manually:

```bash
docker compose -f docker-compose.prod.yml stop nginx
sudo certbot renew
docker compose -f docker-compose.prod.yml start nginx
```

---

## Backups

### Local backups (cron)

- **Script:** `scripts/backup/db-backup.sh`
- **Cron:** `0 2 * * * ~/MyPortfolioSite/scripts/backup/db-backup.sh >> ~/backup.log 2>&1`
- **Runs as:** root (via `sudo crontab -e`)

Each run:

1. Performs `pg_dump` via `docker compose exec postgres` and gzips output to `~/backups/portfolio-YYYYMMDD-HHmmss.sql.gz`.
2. Archives uploads volume to `~/backups/uploads-YYYYMMDD-HHmmss.tar.gz`.
3. Prunes local backups older than 7 days.
4. Triggers offsite sync (if configured).

### Offsite backups (Backblaze B2 via rclone)

- **Script:** `scripts/backup/offsite-sync.sh`
- **Triggered by:** `db-backup.sh` (non-blocking).

Configure with:

```bash
rclone config  # add remote named 'b2', type: b2
# Set RCLONE_REMOTE=b2 and RCLONE_BUCKET=portfolio-backups in .env
```

Then:
- DB dumps → `b2:portfolio-backups/db/` (last 30 days).
- Uploads → `b2:portfolio-backups/uploads/` (incremental).

### Restore from backup

```bash
# List backups
ls -lht ~/backups/*.sql.gz

# Restore a specific backup
bash ~/MyPortfolioSite/scripts/backup/db-restore.sh \
  ~/backups/portfolio-YYYYMMDD-HHmmss.sql.gz
```

---

## Troubleshooting

### Backend not responding (502 from nginx)

1. `docker compose -f docker-compose.prod.yml ps` — check containers are Up.
2. `docker compose -f docker-compose.prod.yml logs --tail=50 backend` — check for errors.
3. If backend is down: `docker compose -f docker-compose.prod.yml restart backend`.
4. If DB is down: `docker compose -f docker-compose.prod.yml restart postgres`.
5. After both are healthy: `docker compose -f docker-compose.prod.yml restart nginx`.

### Database connection errors

Symptoms: `Error: connect ECONNREFUSED` or `ETIMEDOUT` in backend logs.

1. Check postgres: `docker compose -f docker-compose.prod.yml ps postgres`.
2. Restart if needed: `docker compose -f docker-compose.prod.yml restart postgres`.
3. Verify `.env` DB credentials match container credentials.
4. Test from psql as shown above.

### Nginx won't start (SSL issues)

1. Logs: `docker compose -f docker-compose.prod.yml logs nginx`.
2. Check certs: `ls /etc/letsencrypt/live/<domain>/`.
3. If missing, stop nginx, obtain cert via certbot standalone, and restart nginx.

### SSL renewal failing

1. Check renewal log: `tail ~/certbot-renew.log` (if configured).
2. Manual test as shown above.
3. Ensure port 80 is reachable from the internet (router port forwarding, UFW).

### Disk space issues

```bash
df -h                           # which filesystem is full?
docker system prune -f          # remove unused images/layers
docker volume ls                # inspect volumes
sudo journalctl --vacuum=100M   # trim systemd logs
```

---

## Update discipline

Update this document when:

- Service locations change (directory layout, hostnames).
- New services are added to the Docker Compose stack.
- Operational procedures change (backup schedule, deploy process).
- A new troubleshooting pattern is discovered and resolved.

Do **not** update for every deploy or minor code change. This is a reference guide, not a changelog.
