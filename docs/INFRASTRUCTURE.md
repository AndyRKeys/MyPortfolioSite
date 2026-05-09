# Infrastructure

_Last updated: 2026-05-09 — verified against live server post-migration_

This document covers the production server setup, service architecture, operational procedures, and troubleshooting. It is written for agents and operators who need to understand the system without asking the owner for details.

---

## Production Setup (Ubuntu Server — Docker Compose)

### Hardware

- **Device:** Old gaming PC running headless Ubuntu Server LTS
- **OS:** Ubuntu 24.04.4 LTS (kernel 6.8.0-111-generic)
- **Hostname:** `ak-home-server`
- **User:** `modnar3`
- **Repo path:** `/home/modnar3/MyPortfolioSite`
- **Backups path:** `/home/modnar3/backups`
- **Storage:** Internal SSD (significantly more reliable than the previous Pi SD card)
- **Network:** Dynamic IP with DDNS (ddclient updates DNS every 5 minutes)
- **GPU:** Available for future local LLM inference (#173)

### Services (Docker Compose)

All production services run as Docker containers managed by `docker compose -f docker-compose.prod.yml`.

**Docker:** 29.4.3 | **Docker Compose:** v5.1.3

| Service | Image | Port (host) | Purpose |
|---------|-------|-------------|---------|
| **nginx** | nginx:alpine | 80, 443 → host | Reverse proxy + static file serving; terminates SSL |
| **backend** | myportfoliosite-backend (node:20-alpine, prod stage) | 8080 (internal only) | Express API; handles all `/api/*` routes |
| **postgres** | postgres:16-alpine | 5432 (internal only) | PostgreSQL database; data in named volume |

**SSL:** Let's Encrypt certs managed by host-level Certbot; `/etc/letsencrypt` bind-mounted into the nginx container read-only.

**DDNS:** ddclient runs on the host (not containerized) to update the DNS record when the IP changes. Configured via cron.

### Directory Structure (on server)

```
/home/<user>/
├── MyPortfolioSite/          ← cloned repo
│   ├── backend/              ← Node.js source code (in Docker image)
│   ├── resources/            ← frontend HTML/CSS/JS (served by nginx)
│   ├── docs/                 ← documentation (you are here)
│   ├── scripts/
│   │   ├── config/           ← nginx config templates (local + prod)
│   │   ├── deploy/           ← prod-deploy.sh, server-setup.sh
│   │   └── backup/           ← db-backup.sh, db-restore.sh, offsite-sync.sh
│   ├── docker-compose.prod.yml  ← standalone prod compose file
│   └── .env                  ← production env vars (never committed)
│
~/backups/                    ← database and uploads backups (local rotation)
/etc/letsencrypt/             ← SSL certs (managed by certbot on host)
```

### Docker Volume Names

| Volume | Purpose |
|--------|---------|
| `myportfoliosite_postgres_data` | PostgreSQL data directory (persists across deploys) |
| `myportfoliosite_uploads_data` | User-uploaded files (CVs, images) |

### Service Commands

```bash
# Status of all containers
docker compose -f docker-compose.prod.yml ps

# Start all services (with rebuild)
docker compose -f docker-compose.prod.yml up -d --build

# Stop all services
docker compose -f docker-compose.prod.yml down

# Restart one service
docker compose -f docker-compose.prod.yml restart backend

# View logs
docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml logs -f nginx
docker compose -f docker-compose.prod.yml logs --tail=50 postgres
```

### Key File Locations

| File/Directory | Path | Purpose |
|---|---|---|
| **Prod env vars** | `~/MyPortfolioSite/.env` | All production configuration (DB creds, JWT secret, SMTP, domain) |
| **Env template** | `~/MyPortfolioSite/.env.example` | Template for setting up `.env` on a new server |
| **Nginx config template** | `scripts/config/nginx-portfolio.conf.template` | Prod nginx (HTTPS + reverse proxy) — rendered by nginx container at startup |
| **SSL certs** | `/etc/letsencrypt/live/<domain>/` | Let's Encrypt certs — managed by certbot on host, bind-mounted into nginx container |
| **Uploads** | Docker volume `myportfoliosite_uploads_data` | User-uploaded files; also accessible at `/app/uploads` inside backend container |
| **Database** | Docker volume `myportfoliosite_postgres_data` | PostgreSQL data; inspect via `docker compose exec postgres psql` |
| **Deploy log** | `~/deploy.log` | Timestamped deploy history |
| **Backup log** | `~/backup.log` | Backup run history |

---

## Initial Server Setup

Run once on a fresh Ubuntu Server install:

```bash
# Clone and run setup script (pass your domain as argument)
git clone https://github.com/AndyRKeys/MyPortfolioSite.git ~/MyPortfolioSite
bash ~/MyPortfolioSite/scripts/deploy/server-setup.sh andykeys.me
```

The setup script handles:
1. System packages (curl, git, certbot, rclone)
2. Docker installation + group membership
3. SSH password auth disabled (key-only)
4. `.env` created from `.env.example` (prompts to fill in secrets)
5. SSL certificate via certbot standalone
6. `docker compose -f docker-compose.prod.yml up -d --build`
7. Cron jobs: daily backup at 02:00, cert renewal check 1st of every 2 months

**After setup:** Edit `.env`, verify all secrets are set, then run `docker compose -f docker-compose.prod.yml up -d --build` again.

---

## Disk Decryption (Dropbear SSH Agent)

The server uses **LUKS full-disk encryption** with **Dropbear SSH** in the initramfs. This allows remote decryption without physical keyboard access.

### How it works

When the server boots, the encrypted root filesystem is locked. Before the main OS starts:

1. **Dropbear SSH server** listens on port 2222 (minimal environment)
2. You SSH in and run `cryptroot-unlock`
3. Enter your disk encryption passphrase
4. System decrypts and boots normally
5. Main SSH (port 22) becomes available once booted

### Decrypt before deploying

**If the server rebooted** (scheduled reboot, power cycle, etc.), you must decrypt before deploying:

```powershell
# From Windows — connect to Dropbear on port 2222
ssh -p 2222 root@ak-home-server

# Inside Dropbear shell, type (do NOT copy-paste):
cryptroot-unlock

# Dropbear will prompt for the disk encryption passphrase
# TYPE the passphrase manually — do not copy/paste (Dropbear's terminal mangles clipboard input)
# System boots after you enter it (wait 10-15 seconds)

# Once booted, you can deploy normally:
.\scripts\deploy\prod-deploy.ps1
```

### Decryption passphrase

**IMPORTANT:** The disk encryption passphrase is **NOT** stored anywhere in the repo or `.env`. You must remember it or store it securely (password manager, not in code).

It's separate from:
- Your user login password (`modnar3`)
- The `JWT_SECRET` in `.env`
- Any other credentials

### Troubleshooting Dropbear

**Can't SSH to port 2222:**
- Server might not be booting at all (check power, lights)
- Firewall might be blocking port 2222 (unlikely on home network)
- Dropbear might not be installed — reinstall with: `sudo apt install dropbear-initramfs && sudo update-initramfs -u`

**`cryptroot-unlock` command not found:**
- Type it manually, don't copy-paste (Dropbear's terminal can mangle special characters)
- Correct command: `cryptroot-unlock` (with dash, not underscore)

**Wrong passphrase error:**
- Ensure you're entering the **disk encryption passphrase** (set during Ubuntu install), not your user login password
- Passwords are case-sensitive
- **TYPE the passphrase manually** — do NOT copy-paste, as Dropbear's minimal terminal mangles clipboard input

---

## Deployment Process

### Deploy from Windows

```powershell
.\scripts\deploy\prod-deploy.ps1
```

SSHes into `ak-home-server` and runs `prod-deploy.sh`. Pass `-Rollback <sha>` to roll back.

### Deploy on server (what prod-deploy.sh does)

```bash
git fetch origin main
git reset --hard origin/main
docker compose -f docker-compose.prod.yml up -d --build
# health checks backend → HTTP nginx → HTTPS nginx
```

---

## Common Operational Tasks

### Check logs

```bash
# Live backend log
docker compose -f docker-compose.prod.yml logs -f backend

# Last 50 lines
docker compose -f docker-compose.prod.yml logs --tail=50 backend

# Nginx access/error log
docker compose -f docker-compose.prod.yml logs -f nginx

# All services combined
docker compose -f docker-compose.prod.yml logs -f
```

### Check database

```bash
# Open psql shell
docker compose -f docker-compose.prod.yml exec postgres \
    psql -U postgres portfolio_prod

# Inside psql:
\dt           -- list tables
SELECT COUNT(*) FROM posts;
\q            -- exit
```

### Renew SSL cert

Normally runs automatically via cron (`scripts/backup/certbot-renew.sh`). To renew manually:

```bash
docker compose -f docker-compose.prod.yml stop nginx
sudo certbot renew
docker compose -f docker-compose.prod.yml start nginx
```

### Check system health

```bash
# Disk usage
df -h

# Container resource usage
docker stats --no-stream

# Volume sizes
docker system df -v | grep myportfoliosite
```

### Database backup (manual)

```bash
~/MyPortfolioSite/scripts/backup/db-backup.sh
```

Backups land in `~/backups/`. See [Backups](#backups) section.

---

## Backups

### Local backups (automated via cron)

**Script:** `scripts/backup/db-backup.sh`
**Cron:** `0 2 * * *` (daily at 02:00)

Each run:
1. `pg_dump` via `docker compose exec postgres` → gzip → `~/backups/portfolio-YYYYMMDD-HHmmss.sql.gz`
2. `tar -czf` of the uploads volume → `~/backups/uploads-YYYYMMDD-HHmmss.tar.gz`
3. Prunes local backups older than 7 days
4. Triggers offsite sync if rclone is configured

### Offsite backups (Backblaze B2 via rclone)

**Script:** `scripts/backup/offsite-sync.sh`
**Triggered by:** `db-backup.sh` (non-blocking background job)

Setup:
```bash
rclone config  # add remote named 'b2', type: b2
# Set RCLONE_REMOTE=b2 and RCLONE_BUCKET=portfolio-backups in .env
```

Syncs:
- DB dumps → `b2:portfolio-backups/db/` (last 30 days)
- Uploads → `b2:portfolio-backups/uploads/` (incremental)

### Restore from backup

```bash
# List available backups
ls -lht ~/backups/*.sql.gz

# Restore a specific backup
bash ~/MyPortfolioSite/scripts/backup/db-restore.sh ~/backups/portfolio-20260507-020000.sql.gz
```

---

## Troubleshooting

### Backend not responding (502 from nginx)

1. `docker compose -f docker-compose.prod.yml ps` — check all containers are Up
2. `docker compose -f docker-compose.prod.yml logs --tail=50 backend` — check for errors
3. If backend is down: `docker compose -f docker-compose.prod.yml restart backend`
4. If DB is down: `docker compose -f docker-compose.prod.yml restart postgres`
5. After both are healthy: `docker compose -f docker-compose.prod.yml restart nginx`

### Database connection errors

Symptoms: `Error: connect ECONNREFUSED` in backend logs

1. Check postgres container is running: `docker compose -f docker-compose.prod.yml ps postgres`
2. Restart if needed: `docker compose -f docker-compose.prod.yml restart postgres`
3. Verify `.env` credentials match the container's `POSTGRES_USER` / `POSTGRES_PASSWORD`
4. Test connection: `docker compose -f docker-compose.prod.yml exec postgres psql -U postgres portfolio_prod`

### Nginx won't start (SSL cert issues)

Symptoms: nginx container exits immediately

1. Check logs: `docker compose -f docker-compose.prod.yml logs nginx`
2. Verify cert files exist: `ls /etc/letsencrypt/live/<domain>/`
3. If missing: stop all containers, run `sudo certbot certonly --standalone -d <domain>`, restart nginx
4. Check template renders correctly: `sudo nginx -t` inside the nginx container

### SSL cert renewal failing

1. Check cron log: `tail ~/certbot-renew.log`
2. Manual test: `docker compose -f docker-compose.prod.yml stop nginx && sudo certbot renew && docker compose -f docker-compose.prod.yml start nginx`
3. If port 80 is blocked: check firewall `sudo ufw status` / router port forwarding

### SSH from Windows failing

1. Check public key in `~/.ssh/authorized_keys` on server
2. On Windows: `ssh-copy-id -i ~/.ssh/id_ed25519.pub <user>@<server-ip>`
3. Test: `ssh ak-home-server` — should not prompt for password
4. If hostname doesn't resolve, use IP or add to `~/.ssh/config`

### Disk space full

```bash
df -h                           # which volume is full?
docker system prune -f          # remove unused images/layers
docker volume ls                # check volume sizes
sudo journalctl --vacuum=100M   # trim systemd logs
```

---

## Production vs Dev Environment

With Docker Compose in production, dev and prod are now structurally aligned:

| Aspect | Production (Ubuntu Server) | Development (local Docker) |
|--------|---|---|
| **Compose file** | `docker-compose.prod.yml` | `docker-compose.yml` |
| **Backend image** | Prod build target (no devDeps) | Dev build target (devDeps + hot reload) |
| **Source code** | In Docker image | Bind-mounted for hot reload |
| **Database** | Named volume (persists) | Named volume (persists) |
| **Nginx** | Port 80 + 443 (SSL) | Port 80 only (no SSL) |
| **SSL** | Let's Encrypt (host certbot, volume-mounted) | None |
| **Env vars** | `.env` in repo root | `.env` in repo root |
| **Logs** | `docker compose -f docker-compose.prod.yml logs` | `docker compose logs` |

---

## Update Discipline

Update this document when:

- Service locations change (new directory, new hostname)
- New services added to the Docker Compose stack
- Operational procedures change (backup schedule, deploy process)
- A troubleshooting issue is discovered and resolved

Do **not** update for every deploy or minor change. This is a reference guide, not a changelog.

---

## See Also

- `ROADMAP.md` — planned work (dual-environment, local LLM, schema migrations)
- `docs/ARCHITECTURE.md` — system design, request flow diagrams
- `docs/SECURITY.md` — auth model, JWT, threat model
- `README.md` — local dev setup, branching, deployment overview
