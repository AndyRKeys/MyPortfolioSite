# Backup and Recovery

This document captures a **manual** backup and restore process for andykeys.me. Automation can be added later; for now, this is the minimum set of steps to avoid data loss if `ak-home-server` fails.

> Always test these steps on the dev stack before relying on them for prod.

---

## What Needs Backing Up

At minimum:

- **PostgreSQL data** — the `portfolio_dev` and `portfolio_prod` databases
- **Uploads** — files in the `uploads/` directory on the server (CVs, images)
- **Critical config** — `.env` files for dev and prod, Nginx config templates, any non-checked-in secrets notes (see **docs/UNTRACKED_FILES.md**)

Most application code lives in GitHub and is not backed up here.

---

## Taking a Manual Backup

All commands run on `ak-home-server`.

### 1. Create a backup directory

```bash
mkdir -p ~/backups/$(date +"%Y-%m-%d")
cd ~/backups/$(date +"%Y-%m-%d")
```

### 2. Dump PostgreSQL databases

```bash
# Adjust DB names as needed
pg_dump -Fc -d portfolio_prod -f portfolio_prod.dump
pg_dump -Fc -d portfolio_dev  -f portfolio_dev.dump
```

`-Fc` creates a compressed, pg_restore-compatible dump.

### 3. Archive uploads

```bash
cd ~
tar czf "backups/$(date +"%Y-%m-%d")/uploads.tgz" uploads/
```

### 4. Copy critical config

```bash
cp ~/MyPortfolioSite/.env "backups/$(date +"%Y-%m-%d")/prod.env"
cp ~/MyPortfolioSite-dev/.env  "backups/$(date +"%Y-%m-%d")/dev.env"
```

Consider copying any other non-git configuration files referenced in **docs/UNTRACKED_FILES.md**.

### 5. Offload backups

For real resilience, copy the `~/backups/YYYY-MM-DD` folder off the server (e.g. to your NAS or cloud storage) using `scp` or another tool.

---

## Restoring After a Host Failure

This is a high-level outline for rebuilding on a new Ubuntu host if `ak-home-server` dies.

1. **Rebuild base environment**
   - Install Docker, Docker Compose, and Git.
   - Clone the repositories into `~/MyPortfolioSite` and `~/MyPortfolioSite-dev`.

2. **Restore uploads and config**

```bash
# On the new host
mkdir -p ~/MyPortfolioSite/uploads
# Copy uploads.tgz from your backup location
cd ~/MyPortfolioSite
tar xzf ~/uploads.tgz -C .

# Restore .env files
cp ~/backups/YYYY-MM-DD/prod.env ~/MyPortfolioSite/.env
cp ~/backups/YYYY-MM-DD/dev.env  ~/MyPortfolioSite-dev/.env
```

3. **Restore PostgreSQL data**

After bringing up the stacks once to create the DB containers:

```bash
# Prod
docker compose -f ~/MyPortfolioSite/docker-compose.prod.yml exec -T postgres pg_restore \
  -d portfolio_prod --clean --if-exists < ~/backups/YYYY-MM-DD/portfolio_prod.dump

# Dev
docker compose -f ~/MyPortfolioSite-dev/docker-compose.yml exec -T postgres pg_restore \
  -d portfolio_dev --clean --if-exists < ~/backups/YYYY-MM-DD/portfolio_dev.dump
```

Adjust service names if they differ (see **docs/DEV_ENVIRONMENT.md** and **docs/PROD_ENVIRONMENT.md**).

4. **Bring services up**

```bash
# Prod
cd ~/MyPortfolioSite
docker compose -f docker-compose.prod.yml up -d --build

# Dev
cd ~/MyPortfolioSite-dev
docker compose -f docker-compose.dev-server.yml up -d --build
```

5. **Smoke test**

Use the runbook and testing docs to verify:
- Homepage and key pages load
- Basic API calls work
- Admin login and deployment flows succeed

---

## Future Improvements

When backup automation is added (cron job, offsite sync, etc.), document it here and link to any scripts or systemd units that manage it.

For now, aim to run the manual backup steps before major changes and periodically (e.g. monthly).

See also:
- **[docs/INFRASTRUCTURE.md](./INFRASTRUCTURE.md)** for host-level details
- **[docs/UNTRACKED_FILES.md](./UNTRACKED_FILES.md)** for other files not in git but required
