# Infrastructure Overview

_Last updated: 2026-05-25 — verified against live server post-migration and basic health monitoring setup_

This document describes the host-level infrastructure for MyPortfolioSite on Ubuntu Server and points to environment-specific guides.

The same physical server hosts both environments:

- **Dev environment** — `dev` branch, LAN-only, HTTP on port 3001 (see `DEV_ENVIRONMENT.md`).
- **Prod environment** — `main` branch, public site, HTTPS on the configured domain (see `PROD_ENVIRONMENT.md`).

Docker is installed via the official Docker CE apt packages on the server. Docker via snap is **not** supported; see `DOCKER_MIGRATION.md` for the migration story and helper scripts.

A separate Raspberry Pi running Home Assistant OS (HAOS) provides host-level **health monitoring** for the Ubuntu server via the Glances integration (see [Server health monitoring](#server-health-monitoring-with-home-assistant)).

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

## Server health monitoring with Home Assistant

A separate Raspberry Pi running Home Assistant OS (HAOS) monitors `ak-home-server` using the **Glances** integration. This provides a lightweight health dashboard (CPU, memory, disk, uptime, Docker load) and basic alerts when the host goes offline or reboots unexpectedly.

### Glances on ak-home-server

On the Ubuntu server:

```bash
sudo apt update
sudo apt install glances
# Run in web mode during initial setup
glances -w
```

Once verified, configure Glances as a systemd service in web mode (port `61208` by default) so it starts at boot and is reachable from the HAOS Pi.

### Home Assistant integration

On the HAOS Raspberry Pi:

1. Add the Glances integration (Settings → Devices & services → Add integration → **Glances**).
2. Point it at the Ubuntu server LAN IP and Glances port (e.g. `http://ak-home-server:61208`).
3. Confirm that sensors for CPU, memory, disk usage, and uptime appear (for example: `sensor.ak_home_server_cpu_use_percent`, `sensor.ak_home_server_memory_use_percent`, `sensor.ak_home_server_uptime`).

Create a dedicated **Server Health** dashboard in Home Assistant with:

- An entities card for key metrics (CPU, memory, disk, uptime, Docker container count where available).
- A history-graph card for CPU and memory over 24 hours.
- Optional gauge(s) for temperature if exposed by Glances.

### Example Home Assistant automations

These examples live in Home Assistant’s `automations.yaml`, not in this repo, but are shown here for reference.

**Alert if ak-home-server is offline for 5+ minutes:**

```yaml
alias: "ak-home-server offline alert"
mode: single
trigger:
  - platform: state
    entity_id: sensor.ak_home_server_uptime
    to: "unavailable"
    for: "00:05:00"  # offline for 5 minutes
condition: []
action:
  - service: notify.mobile_app_your_phone  # replace with your notifier
    data:
      title: "ak-home-server offline"
      message: "Glances sensors are unavailable. The server might be down or unreachable."
```

**Alert on unexpected reboot (uptime reset):**

```yaml
alias: "ak-home-server rebooted"
mode: single
trigger:
  - platform: numeric_state
    entity_id: sensor.ak_home_server_uptime
    below: 600  # uptime less than 10 minutes
condition: []
action:
  - service: notify.mobile_app_your_phone
    data:
      title: "ak-home-server rebooted"
      message: "ak-home-server uptime just reset. Check PSU and Docker stack if this was not planned."
```

These automations are a complement to (not a replacement for) investigating the suspected PSU issue in #323.

---

## Generic troubleshooting

These checks apply regardless of environment:

- **Docker/compose status:**

  ```bash
  docker ps
  # Prod (from ~/MyPortfolioSite):
  docker compose ps
  # Dev (from ~/MyPortfolioSite-dev):
  docker compose ps
  ```

- **Logs:**

  ```bash
  # Prod (from ~/MyPortfolioSite):
  docker compose logs --tail=50 backend
  docker compose logs --tail=50 nginx
  # Dev (from ~/MyPortfolioSite-dev):
  docker compose logs --tail=50 backend
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

- `DEV_ENVIRONMENT.md` (dev health, UFW, WebAuthn on LAN).
- `PROD_ENVIRONMENT.md` (nginx/SSL, prod DB connection issues).

---

## Supporting documents

- `DEV_ENVIRONMENT.md` — dev environment setup and operations.
- `PROD_ENVIRONMENT.md` — production environment setup and operations.
- `DOCKER_MIGRATION.md` — migrating from snap-based Docker to Docker CE.
- `DEPLOYMENT_LESSONS_LEARNED.md` — lessons from the first production deployment (pre-flight checks, phase-based deploy, troubleshooting patterns).
- `MONITORING.md` (future) — optional dedicated doc for monitoring and alerting patterns once more checks are added.
