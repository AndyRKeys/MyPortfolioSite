# Backup and Recovery

Daily PostgreSQL + uploads backups run automatically on `ak-home-server` via cron. Offsite cloud sync is scaffolded (rclone → Backblaze B2) but **not currently configured** — local-only retention is the deliberate choice for now (see [Offsite sync](#offsite-sync-deferred)).

This document describes the automated flow, how to verify it, how to take ad-hoc backups, and how to restore.

---

## Automated daily backup

`scripts/backup/db-backup.sh` runs daily at 02:00 via user cron on `ak-home-server`:

```text
0 2 * * * /home/modnar3/MyPortfolioSite/scripts/backup/db-backup.sh >> /home/modnar3/backup.log 2>&1
```

What it does:

- Dumps `portfolio_prod` via `docker compose exec postgres pg_dump` (plain SQL, gzipped)
- Archives `~/MyPortfolioSite/uploads/` (tar + gzip) if non-empty
- Writes to `~/backups/prod/portfolio-YYYYMMDD-HHMMSS.sql.gz` and `uploads-YYYYMMDD-HHMMSS.tar.gz`
- Rotates: deletes files older than 7 days
- If rclone is configured, fires `offsite-sync.sh` in the background (currently a no-op — see [Offsite sync](#offsite-sync-deferred))

Log: `~/backup.log` — check here if a daily run appears to be missing.

### Verify the cron is installed

```bash
crontab -l | grep db-backup
```

If empty, install:

```bash
(crontab -l 2>/dev/null; \
  echo "0 2 * * * /home/modnar3/MyPortfolioSite/scripts/backup/db-backup.sh >> /home/modnar3/backup.log 2>&1") \
  | crontab -
```

### Run an ad-hoc backup

Useful before a risky deploy, schema change, or content migration:

```bash
/home/modnar3/MyPortfolioSite/scripts/backup/db-backup.sh
```

---

## What's backed up

| Asset | How | Where | Retention |
|---|---|---|---|
| `portfolio_prod` DB | `pg_dump` + gzip (daily cron) | `~/backups/prod/portfolio-*.sql.gz` | 7 days local |
| `~/MyPortfolioSite/uploads/` (CVs, images) | tar + gzip (daily cron) | `~/backups/prod/uploads-*.tar.gz` | 7 days local |

**Not backed up automatically:**

- `portfolio_dev` database — take ad-hoc snapshots if needed
- `.env` files — see [docs/UNTRACKED_FILES.md](./UNTRACKED_FILES.md); take a manual copy when secrets change
- Nginx config templates — checked into git (`scripts/config/`)
- Application code — lives in GitHub

---

## Offsite sync (deferred)

`scripts/backup/offsite-sync.sh` is ready to sync to Backblaze B2 via rclone (DB dumps + uploads, 30-day retention offsite), but rclone is **not currently configured** on `ak-home-server`. Local backups are the current intended protection — they cover database corruption and accidental deletions, but not a host loss.

If/when offsite is wanted later, the setup is:

1. Create a Backblaze B2 account, bucket, and application key (free up to 10 GB).
2. `sudo apt install rclone && rclone config` — add a remote named `b2`.
3. Optionally override `RCLONE_REMOTE` / `RCLONE_BUCKET` in `~/MyPortfolioSite/.env`.
4. The next daily backup will fire `offsite-sync.sh` automatically.

---

## Restoring after a host failure

Recovery path if `ak-home-server` is lost or `portfolio_prod` is corrupted.

### 1. Rebuild base environment (new host only)

Install Docker, Docker Compose, Git, and rclone (if restoring from offsite). Clone the prod and dev repos:

```bash
git clone https://github.com/AndyRKeys/MyPortfolioSite.git ~/MyPortfolioSite
git clone -b dev https://github.com/AndyRKeys/MyPortfolioSite.git ~/MyPortfolioSite-dev
```

### 2. Restore `.env` files

```bash
cp /path/to/saved/prod.env ~/MyPortfolioSite/.env
cp /path/to/saved/dev.env  ~/MyPortfolioSite-dev/.env
```

### 3. Bring the stack up so the DB container exists

```bash
cd ~/MyPortfolioSite
docker compose -f docker-compose.yml up -d
```

### 4. Restore the database

Backups are plain-SQL dumps (`.sql.gz`). Use the helper:

```bash
bash ~/MyPortfolioSite/scripts/backup/db-restore.sh ~/backups/prod/portfolio-YYYYMMDD-HHMMSS.sql.gz
```

This stops the backend, drops + recreates `portfolio_prod`, restores via `gunzip | psql`, then restarts the backend. It prompts for confirmation before dropping.

### 5. Restore uploads

```bash
cd ~/MyPortfolioSite
tar xzf ~/backups/prod/uploads-YYYYMMDD-HHMMSS.tar.gz
```

### 6. Smoke test

Use the runbook and testing docs to verify:

- Homepage and key pages load
- Basic API calls work
- Admin login and deployment flows succeed

---

## Related

- **[docs/INFRASTRUCTURE.md](./INFRASTRUCTURE.md)** — host-level details
- **[docs/UNTRACKED_FILES.md](./UNTRACKED_FILES.md)** — non-git files (`.env`, etc.) you will need at restore time
- Issue **#185** — offsite sync deferred; revisit if cloud redundancy becomes required
