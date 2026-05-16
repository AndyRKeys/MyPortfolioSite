# Terminology

Canonical names for this project. **Use these exact terms in all docs, comments, commit messages, and instructions.** If you find an old or inconsistent name, fix it (except in historical records — see the bottom of this file).

This file is the single source of truth for naming. `docs/INFRASTRUCTURE.md` describes the host layout in detail; this file just fixes the vocabulary.

---

## Host / hardware

| Use this | Not this | Notes |
|----------|----------|-------|
| **Ubuntu Server (`ak-home-server`)** on first mention; **"the server"** thereafter | "the Pi", "Raspberry Pi", "the gaming PC", "mini PC", "portfolio-server", "home server" | Production host: a repurposed gaming PC running headless Ubuntu Server LTS. The original Raspberry Pi has been **retired** (migration completed 2026-05; #171). |
| **`ak-home-server`** | `portfolio-server` | The SSH hostname. `portfolio-server` was the old name, removed in #179. Always `ak-home-server` in commands, scripts, and variables. |

The Raspberry Pi is only mentioned to say it is no longer used, or in historical records.

## Environments

| Use this | Meaning |
|----------|---------|
| **production** (or **prod**) | `main` branch, public, HTTPS on 80/443. Compose file `docker-compose.prod.yml`. Repo dir `~/MyPortfolioSite/`. |
| **dev environment** (or **LAN dev**) | `dev` branch, LAN-only, HTTP on port **3001**. Compose file `docker-compose.dev-server.yml`. Repo dir `~/MyPortfolioSite-dev/`. |
| **local dev** | A developer's own machine via Docker Compose (`docker-compose.yml`). Distinct from the LAN "dev environment" above. |

Do not call the LAN dev environment "staging" — there is no separate staging tier.

## Docker Compose services

| Environment | Compose file | Service names |
|-------------|--------------|---------------|
| production | `docker-compose.prod.yml` | `backend`, `postgres`, `nginx` |
| dev environment | `docker-compose.dev-server.yml` | `backend-dev`, `postgres-dev`, `nginx-dev` |
| local dev | `docker-compose.yml` | `backend`, `postgres`, `nginx` |

Production DB name: `portfolio`. Dev DB name: `portfolio_dev`.

## Branches

| Use this | Meaning |
|----------|---------|
| **`main`** | Production. Owner merges only. |
| **`dev`** | Integration branch. Features/fixes PR here first. |
| **`feature/issue-N-*`** | New feature, one per issue. |
| **`fix/issue-N-*`** | Bug fix, one per issue. |
| **`release/YYYY-MM-DD`** | Release staging, PR'd `dev` → `main`. |
| **`hotfix/issue-N-*`** | Emergency fix, branched from `main`. |

## Scripts

| Use this | Notes |
|----------|-------|
| **`scripts/deploy/server-setup.sh`** | Current one-shot Ubuntu Server provisioning (Docker). |
| ~~`scripts/infra/pi-setup.sh`~~ | **Deprecated.** Original Raspberry Pi provisioning (PM2). Historical reference only. |
| ~~`scripts/infra/setup-nginx-ssl.ps1`~~ | **Deprecated.** Pi-era host Nginx/SSL vhost (`raspberrypi3`, PM2). Nginx is containerised now. |
| ~~`scripts/infra/setup-ssl.ps1`~~ | **Deprecated.** Pi-era host certbot bootstrap. Use `scripts/backup/certbot-renew.sh`. |
| ~~`scripts/infra/fix-apache.ps1`~~ | **Deprecated.** Pi-era host Apache→Nginx swap. No host web server now. |

## Access

- Normal SSH: `ssh ak-home-server`
- Disk-decryption after reboot (Dropbear): `ssh -p 2222 root@ak-home-server` then `cryptroot-unlock`

---

## Historical records — do not rewrite

These files intentionally preserve old terms (Pi, `portfolio-server`, PM2) because they describe past events. **Do not "correct" terminology in them:**

- `docs/CHANGELOG.md`
- `docs/RELEASE_NOTES.md`
- `docs/DEPLOYMENT_LESSONS_LEARNED.md`
- Anything under `docs/archive/`
- Seed-data devlog content (`scripts/dev/seed-dev-data.sh`) that narrates the migration as a story
