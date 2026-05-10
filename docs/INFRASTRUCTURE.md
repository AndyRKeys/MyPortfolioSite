# Infrastructure Overview

_Last updated: 2026-05-10 — verified against live server post-migration_

This document provides a high-level view of the MyPortfolioSite infrastructure and points to environment-specific setup guides. Detailed operational procedures remain in dedicated docs.

The project currently runs in two main environments on the same Ubuntu Server host:

- **Dev environment** — `dev` branch, LAN-only, HTTP on port 3001.
- **Prod environment** — `main` branch, public site, HTTPS on the configured domain.

Docker is installed via the official Docker CE apt packages on the server. Docker via snap is **not** supported; see `DOCKER_MIGRATION.md` for the migration story and helper scripts.

---

## Production infrastructure (summary)

For full details of the production stack (hardware, services, directory layout, backup strategy, Dropbear disk decryption, troubleshooting), see:

- `PROD_SERVER_SETUP.md`

Key points:

- Host: Ubuntu Server 24.04 LTS on an old gaming PC (LUKS full-disk encryption + Dropbear unlock on port 2222).
- Repo path: `~/MyPortfolioSite` (main branch).
- Compose file: `docker-compose.prod.yml`.
- Services: nginx, backend, postgres, plus backup/cron jobs.
- Deploy entry points:
  - From Windows: `scripts/deploy/prod-deploy.ps1`.
  - From server: `scripts/deploy/prod-deploy.sh`.

---

## Dev infrastructure (summary)

For full details of the dev environment on the same host, see:

- `DEV_SERVER_SETUP.md`

Key points:

- Repo path: `~/MyPortfolioSite-dev` (dev branch).
- Compose file: `docker-compose.dev-server.yml`.
- Endpoint: `http://<LAN_IP>:3001` (LAN-only via UFW rule).
- Separate postgres database (`portfolio_dev`) and nginx-dev reverse proxy.
- Deploy entry points:
  - From Windows: `scripts/deploy/dev-deploy.ps1`.
  - From server: `scripts/deploy/dev-deploy.sh`.

---

## Supporting documents

- `DOCKER_MIGRATION.md` — migrating from snap-based Docker to Docker CE on Ubuntu.
- `DEPLOYMENT_LESSONS_LEARNED.md` — post-mortem notes from the first production deployment, including pre-flight checklists and phase-based deployment guidance.
- `DEV_SERVER_SETUP.md` — detailed dev environment setup and operations.
- `PROD_SERVER_SETUP.md` — detailed prod environment setup and operations.
