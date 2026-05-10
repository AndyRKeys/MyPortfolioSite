# Docker Migration: Snap → Docker CE

This document describes how to migrate the MyPortfolioSite dev/prod servers from Docker installed via **snap** to Docker CE installed via **apt**, using the helper scripts under `scripts/setup/`.

The goals are:
- Eliminate snap/AppArmor-related `permission denied` issues when stopping containers.
- Standardise on Docker CE using `/var/lib/docker`.
- Preserve dev and prod environment configuration files (`.env`).
- Make the migration repeatable and observable.

## Overview of scripts

### Inventory and discovery

- `scripts/setup/docker-migration-inventory.sh`
  - Non-destructive host inspection.
  - Logs to `logs/docker-migration/<timestamp>-inventory.txt`:
    - Whether Docker is installed via snap and/or apt.
    - Docker data directories (`/var/lib/docker`, `/var/snap/docker/...`).
    - `docker info` and `docker ps` output (if reachable).
    - Presence of dev/prod project roots and `.env` files.
    - Conflicting packages/snaps/services (apache2/nginx/httpd, Nextcloud, etc.).
    - Listeners on ports 80/443/3001/8081.

- `scripts/setup/docker-env-discovery.sh`
  - Logs where the dev and prod project roots and env files live (e.g. `~/MyPortfolioSite-dev/.env`, `~/MyPortfolioSite/.env`).

- `scripts/setup/docker-env-backup.sh`
  - `backup` mode:
    - Copies dev/prod `.env` files into `~/docker-migration-backup/<timestamp>/` (or `$BACKUP_ROOT`).
  - `restore` mode:
    - Restores `.env` files from the latest backup **only if** they do not already exist at the target paths.

### Guided migration helper

- `scripts/setup/migrate-from-snap-docker.sh`
  - High-level, guided, **interactive** migration.
  - Uses the inventory and env scripts and then walks through:
    - Stopping dev/prod stacks.
    - Stopping the snap Docker daemon.
    - Installing Docker CE from the official apt repo.
    - Adding the deploy user to the `docker` group.
    - Verifying Docker CE.
    - Showing port/service conflicts before recreating stacks.
    - Recreating dev and prod stacks under Docker CE.
    - (Optionally) removing the Docker snap package once CE is healthy.
  - Every step is gated by a `y/N` confirmation and prints the exact commands it will run.

## Migration prerequisites

Before running the migration on a host:

- Ensure you can SSH into the server as the non-root deploy user.
- Ensure you have a working backup of any data you care about.
- For MyPortfolioSite specifically:
  - Dev and prod databases are currently disposable; env files are the main state to preserve.

## Recommended migration sequence

### 1. Run inventory

On the server:

```bash
cd ~/MyPortfolioSite-dev
bash scripts/setup/docker-migration-inventory.sh
```

- Review the log under `logs/docker-migration/` for:
  - Whether Docker is currently provided by snap.
  - Any conflicting web servers/snaps/services.
  - Current port usage on 80/443/3001/8081.

### 2. Discover and back up env files

You can run the steps manually or use the migration helper.

Using the helper:

```bash
cd ~/MyPortfolioSite-dev
bash scripts/setup/migrate-from-snap-docker.sh
```

- In **Step 1**, the script calls:
  - `docker-env-discovery.sh` to log current paths.
  - `docker-env-backup.sh backup` to copy `.env` files into `~/docker-migration-backup/<timestamp>/`.

You can also run backups directly if needed:

```bash
bash scripts/setup/docker-env-backup.sh backup
```

### 3. Stop existing stacks and snap Docker

The migration helper will:

- Stop the dev stack with:
  - `docker compose -f docker-compose.dev-server.yml down --remove-orphans` in `~/MyPortfolioSite-dev`.
- Stop the prod stack with:
  - `docker compose -f docker-compose.prod.yml down --remove-orphans` in `~/MyPortfolioSite`.
- Stop the snap Docker daemon:
  - `sudo systemctl stop snap.docker.dockerd`.

Each step is confirmed interactively and warns if commands fail.

### 4. Install Docker CE via apt

The helper then walks through the Docker CE installation using the official Docker repository:

- Install prerequisites (ca-certificates, curl, gnupg).
- Set up the Docker GPG key and apt source.
- Install `docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-buildx-plugin`, `docker-compose-plugin`.
- Add your user to the `docker` group and suggest logging out/in or using `newgrp docker`.
- Optionally run `docker info`, `docker ps`, and `docker compose version` to verify the installation.

### 5. Check for port/service conflicts

Before recreating stacks, the migration helper includes a step to **log** potential conflicts:

- Shows listeners on ports 80/443/3001/8081 using `ss` or `lsof`.
- Shows active `apache/httpd/nginx/nextcloud` services using `systemctl`.

This step is informational only; it does not stop or remove services. Use it to decide whether you need to remove or stop anything before bringing your stacks back up.

### 6. Recreate dev and prod stacks under Docker CE

The helper then offers to:

- Recreate the dev stack:

  - `cd ~/MyPortfolioSite-dev && docker compose -f docker-compose.dev-server.yml up -d --build`.

- Recreate the prod stack:

  - `cd ~/MyPortfolioSite && docker compose -f docker-compose.prod.yml up -d --build`.

If you have moved `.env` files or restored them from backup, ensure they are in the expected locations before running these steps.

### 7. Remove Docker snap (optional)

Once you are satisfied that the stacks are healthy and running under Docker CE, the helper offers to remove the Docker snap package:

- `sudo snap remove --purge docker` if `snap list docker` shows it is still installed.

This is optional but recommended to avoid future confusion.

## Post-migration checks

After migration:

- Verify Docker is using `/var/lib/docker` for data.
- Use the dev/prod deploy scripts to perform normal deployments:
  - Dev: `scripts/deploy/dev-deploy.ps1` from Windows or `dev-deploy.sh` from the server.
  - Prod: `scripts/deploy/prod-deploy.ps1` from Windows or `prod-deploy.sh` from the server.
- Confirm that the previous `permission denied` behaviour when stopping containers no longer occurs.

If Docker enters a bad permission/state again, prefer a full system reboot over incremental daemon restarts, as described in `DEPLOYMENT_LESSONS_LEARNED.md`.
