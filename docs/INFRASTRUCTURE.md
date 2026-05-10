# Infrastructure Overview

_Last updated: 2026-05-10 — verified against live server post-migration_

This document describes the host-level infrastructure for MyPortfolioSite on Ubuntu Server and points to environment-specific setup guides.

The same physical server hosts both environments:

- **Dev environment** — `dev` branch, LAN-only, HTTP on port 3001.
- **Prod environment** — `main` branch, public site, HTTPS on the configured domain.

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

- `DEV_SERVER_SETUP.md` — dev compose, ports, dev env vars, dev deploy.
- `PROD_SERVER_SETUP.md` — prod compose, domain/SSL specifics, prod deploy.

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

---

## Backup strategy (shared)

Backups are managed via scripts under `scripts/backup/` and cron.

### Local backups

- **Script:** `scripts/backup/db-backup.sh`
- **Cron:** `0 2 * * * ~/MyPortfolioSite/scripts/backup/db-backup.sh >> ~/backup.log 2>&1`
- **Runs as:** root (via `sudo crontab -e`).

Each run:

1. Dumps the production database via `docker compose exec postgres` and gzips it to `~/backups/portfolio-YYYYMMDD-HHmmss.sql.gz`.
2. Archives the uploads volume to `~/backups/uploads-YYYYMMDD-HHmmss.tar.gz`.
3. Prunes local backups older than 7 days.
4. Triggers offsite sync (if configured).

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

- **Disk space:**

  ```bash
  df -h
  docker system prune -f
  docker volume ls
  ```

For more detailed, environment-specific troubleshooting, see:

- `DEV_SERVER_SETUP.md` (dev health, UFW, WebAuthn on LAN).
- `PROD_SERVER_SETUP.md` (nginx/SSL, prod DB connection issues).

---

## Supporting documents

- `DEV_SERVER_SETUP.md` — dev environment setup and operations.
- `PROD_SERVER_SETUP.md` — prod environment setup and operations.
- `DOCKER_MIGRATION.md` — migrating from snap-based Docker to Docker CE.
- `DEPLOYMENT_LESSONS_LEARNED.md` — lessons from the first production deployment (pre-flight checks, phase-based deploy, troubleshooting patterns).
