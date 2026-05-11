# Infrastructure Overview

_Last updated: 2026-05-10 — verified against live server post-migration_

This document describes the host-level infrastructure for MyPortfolioSite on Ubuntu Server and points to environment-specific guides.

The same physical server hosts both environments:

- **Dev environment** — `dev` branch, LAN-only, HTTP on port 3001 (see `DEV_ENVIRONMENT.md`).
- **Prod environment** — `main` branch, public site, HTTPS on the configured domain (see `PROD_ENVIRONMENT.md`).

Docker is installed via the official Docker CE apt packages on the server. Docker via snap is **not** supported; see `DOCKER_MIGRATION.md` for the migration story and helper scripts.

---

## Hardware and host OS

- **Device:** Old gaming PC running headless Ubuntu Server LTS
- **OS:** Ubuntu 24.04.4 LTS (kernel 6.8.0-111-generic)
- **Hostname:** `<server-hostname>`
- **User:** `<username>` (non-root user with sudo access)
- **Storage:** Internal SSD
- **Network:** Dynamic IP with DDNS (ddclient updates DNS every 5 minutes)
- **GPU:** Available for future local LLM inference (#173)

---

## Directory layout (shared)

On the server, both environments live under the same home directory:

```bash
/home/<username>/
├── MyPortfolioSite/          ← main branch (production)
│   ├── backend/
│   ├── resources/
│   ├── docs/
│   ├── scripts/
│   │   ├── config/           ← nginx config templates
│   │   ├── deploy/           ← deploy scripts (dev/prod/server-setup)
│   │   ├── ops/
│   │   └── backup/
│   ├── docker-compose.prod.yml
│   ├── docker-compose.yml    ← local dev compose
│   └── .env                  ← production env vars (never committed)
└── MyPortfolioSite-dev/      ← dev branch (LAN dev environment)
    ├── docker-compose.dev-server.yml
    └── .env                  ← dev env vars (from .env.dev-server.example)

~/backups/                    ← DB + uploads backups (local rotation)
/etc/letsencrypt/             ← SSL certs (managed by certbot on host)
```

For per-environment details, see:

- `DEV_ENVIRONMENT.md` — dev compose, ports, dev env vars, dev deploy.
- `PROD_ENVIRONMENT.md` — prod compose, domain/SSL specifics, prod deploy.

---

## Disk encryption and Dropbear unlock

The server uses **LUKS full-disk encryption** with **Dropbear SSH** in the initramfs so it can be unlocked remotely after reboots.

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

# Wait 10–15 seconds for boot, then deploy normally
.\scripts\deploy\prod-deploy.ps1
```

The disk encryption passphrase is **not** stored in the repo or `.env`; keep it in a secure password manager.
### Decryption passphrase

**IMPORTANT:** The disk encryption passphrase is **NOT** stored anywhere in the repo or `.env`. You must remember it or store it securely (password manager, not in code).

It's separate from:
- Your user login password (`<username>`)
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

SSHes into `<server-hostname>` and runs `prod-deploy.sh`. Pass `-Rollback <sha>` to roll back.

### Deploy on server (what prod-deploy.sh does)

```bash
git fetch origin main
git reset --hard origin/main
docker compose -f docker-compose.prod.yml up -d --build
# health checks backend → HTTP nginx → HTTPS nginx
```

---

## Backup strategy (shared)

Backups are managed via scripts under `scripts/backup/` and cron.

### Local backups

### Local backups (automated via cron)

**Script:** `scripts/backup/db-backup.sh`
**Cron:** `0 2 * * * ~/MyPortfolioSite/scripts/backup/db-backup.sh >> ~/backup.log 2>&1` (daily at 02:00 UTC)
**Runs as:** root (via `sudo crontab -e`)

Each run:

1. Dumps the production database via `docker compose exec postgres` and gzips it to `~/backups/portfolio-YYYYMMDD-HHmmss.sql.gz`.
2. Archives the uploads volume to `~/backups/uploads-YYYYMMDD-HHmmss.tar.gz`.
3. Prunes local backups older than 7 days.
4. Triggers offsite sync (if configured).

**Latest backup:** `portfolio-20260507-212434.sql.gz` (2.2K)

### Offsite backups (Backblaze B2 via rclone)

- **Script:** `scripts/backup/offsite-sync.sh`.
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
ls -lht ~/backups/*.sql.gz
bash ~/MyPortfolioSite/scripts/backup/db-restore.sh \
  ~/backups/portfolio-YYYYMMDD-HHmmss.sql.gz
```

---

## Generic troubleshooting

# Restore a specific backup
bash ~/MyPortfolioSite/scripts/backup/db-restore.sh ~/backups/portfolio-20260507-212434.sql.gz
```

---

## Active Services & Ports

**Verified open ports (from `lsof`):**

| Port | Service | Purpose | Internal Only |
|------|---------|---------|---|
| 22 | SSH (sshd) | Remote administration | — |
| 53 | systemd-resolve | DNS resolution (localhost) | ✓ |
| 80 | docker-proxy (nginx) | HTTP → HTTPS redirect | — |
| 443 | docker-proxy (nginx) | HTTPS public traffic | — |
| 8080 | Node.js backend | Express API (docker internal) | ✓ |
| 9090 | Prometheus | Metrics server | ✓ |
| 27019 | MongoDB | Document database (localhost) | ✓ |

**Note:** Prometheus and MongoDB are present on the system. Verify if these are part of the active deployment or legacy services that can be stopped/removed.

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

These checks apply regardless of environment:

- **Docker/compose status:**

  ```bash
  docker ps
  docker compose -f docker-compose.prod.yml ps
  docker compose -f docker-compose.dev-server.yml ps
  ```

- **Logs:**

  ```bash
  docker compose -f docker-compose.prod.yml logs --tail=50 backend
  docker compose -f docker-compose.prod.yml logs --tail=50 nginx
  docker compose -f docker-compose.dev-server.yml logs --tail=50 backend-dev
  ```

- **Port usage:**

  ```bash
  sudo lsof -i :80 -i :443 -i :3001
  ```
### SSH from Windows failing

1. Check public key in `~/.ssh/authorized_keys` on server
2. On Windows: `ssh-copy-id -i ~/.ssh/id_ed25519.pub <username>@<server-hostname>`
3. Test: `ssh <server-hostname>` — should not prompt for password
4. If hostname doesn't resolve, use IP or add to `~/.ssh/config`

### Disk space full

```bash
df -h                           # which volume is full?
docker system prune -f          # remove unused images/layers
docker volume ls                # check volume sizes
sudo journalctl --vacuum=100M   # trim systemd logs
```

---

## Dev Environment on Ubuntu Server (LAN-only)

A second environment runs the `dev` branch on the same Ubuntu Server, accessible only on the local network at `http://<LAN_IP>:3001`. This lets you test `dev` changes on real hardware without touching the live site.

### Repository layout

```
/home/<username>/
├── MyPortfolioSite/          ← main branch (production)
└── MyPortfolioSite-dev/      ← dev branch (LAN dev environment)
    ├── docker-compose.dev-server.yml
    └── .env                  ← dev env vars (from .env.dev-server.example)
```

### First-time setup

```bash
# 1. Clone the repo to a separate directory and switch to dev
git clone https://github.com/AndyRKeys/MyPortfolioSite.git ~/MyPortfolioSite-dev
cd ~/MyPortfolioSite-dev
git checkout dev

# 2. Create the env file and fill in values (especially LAN_IP)
cp .env.dev-server.example .env
nano .env

# 3. Open port 3001 to LAN only (adjust subnet to match your home network)
sudo ufw allow from 192.168.0.0/16 to any port 3001 comment 'Dev site LAN-only'

# 4. Start dev services
docker compose -f docker-compose.dev-server.yml up -d --build
```

### Deploy (update to latest dev branch)

```bash
bash ~/MyPortfolioSite-dev/scripts/deploy/dev-server-deploy.sh
```

Logs are written to `~/dev-deploy.log`.

### Service commands

```bash
# Status
docker compose -f ~/MyPortfolioSite-dev/docker-compose.dev-server.yml ps

# Logs
docker compose -f ~/MyPortfolioSite-dev/docker-compose.dev-server.yml logs -f backend-dev

# Stop dev environment (frees resources when not in use)
docker compose -f ~/MyPortfolioSite-dev/docker-compose.dev-server.yml down

# Restart one service
docker compose -f ~/MyPortfolioSite-dev/docker-compose.dev-server.yml restart backend-dev
```

### Dev services

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| **nginx-dev** | nginx:alpine | 3001 → host (LAN only) | HTTP reverse proxy + static files |
| **backend-dev** | myportfoliosite-backend (prod build) | 8081 (internal) | Express API |
| **postgres-dev** | postgres:16-alpine | internal only | Separate DB (`portfolio_dev`) |

### Key differences from production

| Aspect | Production | Dev Server |
|--------|-----------|------------|
| Branch | `main` | `dev` |
| Compose file | `docker-compose.prod.yml` | `docker-compose.dev-server.yml` |
| Port | 80 / 443 | 3001 |
| SSL | Let's Encrypt | None (HTTP only) |
| Database | `portfolio_prod` | `portfolio_dev` |
| Backend port | 8080 (internal) | 8081 (internal) |
| Access | Public internet | LAN only (UFW rule) |
| WebAuthn origin | `https://<domain>` | `http://<LAN_IP>:3001` |

### Environment variables

See `.env.dev-server.example` for the full reference. Critical values to set:
- `LAN_IP` — server's LAN IP (find with `ip -4 addr show`)
- `DB_PASSWORD` — strong random password (different from prod)
- `JWT_SECRET` — different from prod JWT secret
- `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` — must match `http://<LAN_IP>:3001`

---

## Production vs Dev Environment

With Docker Compose in production, dev and prod are now structurally aligned:

| Aspect | Production (Ubuntu Server) | Dev Server (Ubuntu Server LAN) | Local Dev (Windows) |
|--------|---|---|---|
| **Compose file** | `docker-compose.prod.yml` | `docker-compose.dev-server.yml` | `docker-compose.yml` |
| **Branch** | `main` | `dev` | any |
| **Backend image** | Prod build target (no devDeps) | Prod build target (no devDeps) | Dev build target (devDeps + hot reload) |
| **Source code** | In Docker image | In Docker image | Bind-mounted for hot reload |
| **Database** | `portfolio_prod` | `portfolio_dev` | `portfolio_dev` |
| **Nginx** | Port 80 + 443 (SSL) | Port 3001 (no SSL) | Port 80 (no SSL) |
| **SSL** | Let's Encrypt | None | None |
| **Access** | Public internet | LAN only (UFW) | localhost only |
| **Repo path** | `~/MyPortfolioSite` | `~/MyPortfolioSite-dev` | local clone |
| **Logs** | `docker compose -f docker-compose.prod.yml logs` | `docker compose -f docker-compose.dev-server.yml logs` | `docker compose logs` |

---

- **Disk space:**

  ```bash
  df -h
  docker system prune -f
  docker volume ls
  ```

For more detailed, environment-specific troubleshooting, see:

- `DEV_ENVIRONMENT.md` (dev health, UFW, WebAuthn on LAN).
- `PROD_ENVIRONMENT.md` (nginx/SSL, prod DB connection issues).

---

## Supporting documents

- `DEV_ENVIRONMENT.md` — dev environment setup and operations.
- `PROD_ENVIRONMENT.md` — production environment setup and operations.
- `DOCKER_MIGRATION.md` — migrating from snap-based Docker to Docker CE.
- `DEPLOYMENT_LESSONS_LEARNED.md` — lessons from the first production deployment (pre-flight checks, phase-based deploy, troubleshooting patterns).
