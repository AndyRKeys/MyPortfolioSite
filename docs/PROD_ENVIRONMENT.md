# Production Environment

_Last updated: 2026-05-10 — verified against live server post-migration_

Production-specific configuration for MyPortfolioSite on Ubuntu Server. This document focuses on the **production Docker stack**, env vars, deploy entry points, and prod-only troubleshooting.

Host-level details (hardware/OS, disk encryption, backups, generic troubleshooting) are documented in `INFRASTRUCTURE.md`.

---

## Prod services and compose file

All production services run as Docker containers managed by `docker-compose.prod.yml` in `~/MyPortfolioSite`:

```bash
cd ~/MyPortfolioSite
docker compose -f docker-compose.prod.yml <command>
```

**Docker:** 29.4.3 | **Docker Compose:** v5.1.3

| Service | Image | Port (host) | Purpose |
|---------|-------|-------------|---------|
| **nginx** | nginx:alpine | 80, 443 → host | Reverse proxy + static file serving; terminates SSL |
| **backend** | myportfoliosite-backend (node:20-alpine, prod stage) | 8080 (internal only) | Express API; handles `/api/*` routes |
| **postgres** | postgres:16-alpine | 5432 (internal only) | PostgreSQL database; data in named volume |

**SSL:** Let's Encrypt certs managed by certbot on the host; `/etc/letsencrypt` is bind-mounted into the nginx container read-only.

---

## Prod env vars and key files

| Item | Location | Notes |
|------|----------|-------|
| Prod env vars | `~/MyPortfolioSite/.env` | All production configuration (DB creds, JWT secret, SMTP, domain, backups, etc.) |
| Env template | `~/MyPortfolioSite/.env.example` | Template used by `server-setup.sh` and docs as a starting point |
| Compose file | `~/MyPortfolioSite/docker-compose.prod.yml` | Orchestrates nginx, backend, postgres |
| Nginx config template | `~/MyPortfolioSite/scripts/config/nginx-portfolio.conf.template` | Rendered inside nginx container at startup |
| SSL certs | `/etc/letsencrypt/live/<domain>/` | Managed by certbot on host; mounted read-only into nginx |

### Critical env vars

See `.env.example` for the full reference. Important values to set correctly:

- `DOMAIN` — public domain name for the site.
- `DB_PASSWORD` — strong password for postgres.
- `JWT_SECRET` — long random value (32+ chars) for signing JWTs.
- `RCLONE_REMOTE` / `RCLONE_BUCKET` — if using offsite backups.

The prod deploy script validates required variables (including length and obvious placeholders) before starting containers.

---

## Deploy entry points

### From Windows

```powershell
.\scripts\deploy\prod-deploy.ps1
```

- Connects to the server via SSH.
- Runs `scripts/deploy/prod-deploy.sh`.
- Optional rollback:

  ```powershell
  .\scripts\deploy\prod-deploy.ps1 -Rollback <sha>
  ```

### From the server

```bash
cd ~/MyPortfolioSite
bash scripts/deploy/prod-deploy.sh
# or
bash scripts/deploy/prod-deploy.sh --rollback <sha>
```

On the feature branch, `prod-deploy.sh` uses `deploy-lib.sh` to:

- Check prerequisites (docker, docker compose plugin, git, curl).
- Ensure the repo exists and is on `main`.
- Load and validate `.env`.
- Fetch and reset to `origin/main`.
- Rebuild containers via `docker compose -f docker-compose.prod.yml up -d --build`.
- Run backend and HTTPS health checks.
- Roll back to the previous commit if deploy or health fails.

Deploy logs are written to `~/prod-deploy.log`.

---

## Prod operational commands

### Service status and logs

```bash
# Status of all prod containers
docker compose -f ~/MyPortfolioSite/docker-compose.prod.yml ps

# Start all services (with rebuild)
docker compose -f ~/MyPortfolioSite/docker-compose.prod.yml up -d --build

# Stop all services
docker compose -f ~/MyPortfolioSite/docker-compose.prod.yml down

# Restart backend only
docker compose -f ~/MyPortfolioSite/docker-compose.prod.yml restart backend

# View logs
docker compose -f ~/MyPortfolioSite/docker-compose.prod.yml logs -f backend
docker compose -f ~/MyPortfolioSite/docker-compose.prod.yml logs -f nginx
docker compose -f ~/MyPortfolioSite/docker-compose.prod.yml logs --tail=50 postgres
```

### Database access (prod)

```bash
# Open psql shell for production DB
docker compose -f ~/MyPortfolioSite/docker-compose.prod.yml exec postgres \
  psql -U postgres portfolio_prod

# Inside psql:
\dt           -- list tables
SELECT COUNT(*) FROM posts;
\q            -- exit
```

### SSL renewal (prod nginx)

Normally handled by cron via `scripts/backup/certbot-renew.sh`. To renew manually:

```bash
cd ~/MyPortfolioSite
# Stop nginx to free port 80
docker compose -f docker-compose.prod.yml stop nginx
sudo certbot renew
# Start nginx again
docker compose -f docker-compose.prod.yml start nginx
```

---

## Prod-specific troubleshooting

### Backend not responding (502 from nginx)

1. Check container status:

   ```bash
   docker compose -f ~/MyPortfolioSite/docker-compose.prod.yml ps
   ```

2. Inspect backend logs:

   ```bash
   docker compose -f ~/MyPortfolioSite/docker-compose.prod.yml logs --tail=50 backend
   ```

3. If backend is down or crash-looping:

   ```bash
   docker compose -f ~/MyPortfolioSite/docker-compose.prod.yml restart backend
   ```

4. If postgres is down:

   ```bash
   docker compose -f ~/MyPortfolioSite/docker-compose.prod.yml restart postgres
   ```

5. After both are healthy, restart nginx:

   ```bash
   docker compose -f ~/MyPortfolioSite/docker-compose.prod.yml restart nginx
   ```

### Database connection errors (prod)

Symptoms: `ECONNREFUSED` or `ETIMEDOUT` to postgres in prod backend logs.

1. Verify postgres is running:

   ```bash
   docker compose -f ~/MyPortfolioSite/docker-compose.prod.yml ps postgres
   ```

2. Restart if needed:

   ```bash
   docker compose -f ~/MyPortfolioSite/docker-compose.prod.yml restart postgres
   ```

3. Check `.env` DB credentials against container settings.
4. Test with psql as shown above.

### Nginx/SSL issues (prod)

1. Check nginx logs:

   ```bash
   docker compose -f ~/MyPortfolioSite/docker-compose.prod.yml logs nginx
   ```

2. Verify cert files exist:

   ```bash
   ls /etc/letsencrypt/live/<domain>/
   ```

3. If missing or invalid:
   - Stop nginx.
   - Obtain/renew cert with certbot.
   - Start nginx again.

### When to look at INFRASTRUCTURE instead

Use `INFRASTRUCTURE.md` when the problem is clearly **host-level**:

- Disk decryption / Dropbear unlock.
- Global backup jobs and offsite sync.
- Disk space issues, Docker daemon problems, or port conflicts affecting both dev and prod.

Use this doc when the problem is specific to the **prod environment**:

- Prod deploy failing.
- Prod-only 502s or DB errors.
- Prod SSL/HTTPS behaviour.
