# Release Notes

## Release 2026-05-09-3

**Released:** 2026-05-09  
**Branch:** release/2026-05-09-3  
**PR:** #TBD  
**Closes:** #159

### Features

**Dev environment on Ubuntu Server — LAN-only, port 3001 (PR #201)**
- feat(#159): `docker-compose.dev-server.yml` — separate Docker stack running the `dev` branch alongside production; services: `postgres-dev` (`portfolio_dev` DB), `backend-dev` (port 8081 internal), `nginx-dev` (port 3001, LAN-only)
- feat(#159): `scripts/config/nginx-dev-server.conf.template` — HTTP-only nginx on port 3001 with full security headers (CSP, X-Frame-Options, Referrer-Policy, Permissions-Policy)
- feat(#159): `.env.dev-server.example` — env template documenting `LAN_IP`, separate DB and JWT secrets, and WebAuthn origin pointing at `http://<LAN_IP>:3001`
- feat(#159): `scripts/deploy/dev-server-deploy.sh` — unified setup and deploy script; handles first-time clone, `.env` creation and validation (required vars, placeholder detection, JWT length, WebAuthn consistency), UFW check, git update with rollback on failure, Docker build, health polling with auto log-dump, and deploy summary
- feat(#159): `scripts/deploy/dev-server-deploy.ps1` — Windows PowerShell wrapper; SSHes into `ak-home-server` and invokes the bash deploy script (mirrors `prod-deploy.ps1` pattern)
- docs(#159): `docs/DEV_SERVER_SETUP.md` — first-time setup guide: find LAN IP, open UFW port, run the deploy script (3 steps; script handles the rest)
- docs(#159): `docs/INFRASTRUCTURE.md` — new dev server section and updated 3-way environment comparison table (prod / dev-server / local)

### Breaking Changes / Deployment Notes

- No changes to production — the dev stack is fully isolated (separate compose file, DB, ports, and repo directory `~/MyPortfolioSite-dev`)
- No backend restart or DB migration required for the live site
- To start the dev environment on the server for the first time: open UFW port 3001, then run `dev-server-deploy.ps1` from Windows (or the bash script directly on the server)

---

## Release 2026-05-09-2

**Released:** 2026-05-09  
**Branch:** release/2026-05-09-2  
**PR:** #204  
**Closes:** #197

### Bug Fixes

**Content Security Policy fix (PR #198)**
- fix(#197): extract inline scripts to external modules to satisfy CSP (`admin-init.js`, `login-init.js`)
- fix(#197): add `cdn.jsdelivr.net` to CSP `script-src` (Leaflet maps dependency)
- fix(#197): update `API_BASE` handling and add CSP policy headers
- fix(#197): add `.gitattributes` to enforce LF line endings for shell scripts
- fix(#197): normalise `Test-Regression.ps1` line endings in git object
- fix(#197): add security headers check to regression test suite
- fix(#197): pipe security debug script via bash stdin to avoid Windows path issues

### Breaking Changes / Deployment Notes

- None — frontend changes only; no backend restart or DB migration required

---

## Release 2026-05-09-docs

**Released:** 2026-05-09  
**Branch:** release/2026-05-09-docs  
**PR:** #191

### Ops

- ops: expand `scripts/ops/gather-infrastructure-info.sh` with comprehensive system checks — CPU, memory, disk, Docker container status, network interfaces, cron jobs, and service health

### Breaking Changes / Deployment Notes

- None — ops script only; no application changes

---

## Release 2026-05-09

**Released:** 2026-05-09  
**Branch:** release/2026-05-09-docs  
**PR:** #189  
**Closes:** #182, #186

### Docs / Ops

- docs(#182): `docs/DEPLOYMENT_LESSONS_LEARNED.md` — post-migration lessons learned from the 2026-05-07 Docker Compose production migration; pre-deployment checklist with detailed server setup procedures
- ops(#186): `scripts/ops/gather-infrastructure-info.sh` — automated server information gathering script for documentation and diagnostics
- docs(#186): `docs/INFRASTRUCTURE.md` updated with verified server inventory (sensitive details replaced with placeholders)

### Breaking Changes / Deployment Notes

- None — documentation and ops scripts only; no application changes

---

## Release 2026-05-07

**Released:** 2026-05-07  
**Branch:** release/2026-05-07  
**PR:** #180  
**Closes:** #163, #164, #165, #167, #168, #170, #171, #172

### Features & Improvements

**Infrastructure Quick Wins (PR #177)**
- feat(#163): `/api/health` endpoint returns status + DB connectivity + uptime + version
- security: MIME sniffing prevention, clickjacking protection, Referrer-Policy, Permissions-Policy headers
- docs(#167): `docs/INFRASTRUCTURE.md` — server layout, service architecture, operational procedures, troubleshooting, Dropbear remote decryption workflow
- docs(#168): `docs/ARCHITECTURE.md` — system diagram, request flows, file structure, data flow examples

**Docker Compose Production Migration (PR #179)**
- feat(#165): `docker-compose.prod.yml` — production-grade containerization with postgres, backend (prod target), nginx, named volumes, SSL cert mounting
- feat(#165): Production architecture now entirely containerized: postgres 16, Node.js backend, nginx reverse proxy
- feat(#171): `scripts/deploy/server-setup.sh` — one-shot Ubuntu Server LTS initialization script
  - Installs Docker + docker-compose, certbot, rclone, hardens SSH, creates `.env`, provisions SSL cert, starts services, configures cron jobs
  - Includes Dropbear SSH in initramfs for remote disk decryption on reboot
- feat(#164): `scripts/backup/db-backup.sh` — automated daily PostgreSQL backups with 7-day local rotation
- feat(#164): `scripts/backup/db-restore.sh` — interactive database restoration from any backup file
- feat(#172): `scripts/backup/offsite-sync.sh` — Rclone sync to Backblaze B2 with 30-day DB retention
- feat(#172): `scripts/backup/certbot-renew.sh` — SSL certificate renewal without downtime (nginx container management)
- feat(#171): `.env.example` — production environment template for Docker Compose
- feat(#171): Dropbear SSH in initramfs for remote unlocking of LUKS-encrypted disks on server reboot
- fix(#179): `prod-deploy.sh` rewritten for Docker Compose — git fetch/reset, `docker compose up -d --build`, health checks (backend + HTTP + HTTPS)
- fix(#179): SSH deploy target hostname changed from `portfolio-server` to `ak-home-server`
- fix(#152): Nginx template path bug — `scripts/nginx-local.conf.template` → `scripts/config/nginx-local.conf.template` in docker-compose.yml
- chore(#170): `test-results/` directory removed from version control, added to `.gitignore`

### Breaking Changes / Deployment Notes

**⚠️ MAJOR: Docker Compose production deployment**
- Production now runs entirely via Docker Compose instead of PM2 on host
- No more system-level PostgreSQL, Nginx, or Node.js services
- Requires fresh server setup via `scripts/deploy/server-setup.sh` on Ubuntu Server LTS 22.04+
- `.env` file at repo root (loaded by docker-compose) replaces per-service configuration
- Uploads stored in named volume `uploads_data` instead of host directory
- Backups automated via cron: `db-backup.sh` at 02:00 daily, `certbot-renew.sh` monthly
- SSL certificates must be provisioned via Let's Encrypt (certbot) on initial setup
- Rollback syntax unchanged: `bash prod-deploy.sh --rollback <sha>`

### Migration Path

1. Provision fresh Ubuntu Server LTS 22.04+ (or later)
2. Run `scripts/deploy/server-setup.sh` — handles Docker, certbot, rclone, cron, initial deploy
3. For disk encryption on reboot: `ssh -p 2222 root@ak-home-server; cryptroot-unlock; <enter passphrase>`
4. Subsequent deploys via `./prod-deploy.ps1` from Windows (or `bash prod-deploy.sh` on server directly)

---

## 🔥 Hotfix 2026-05-06 (PR #144)

**Released:** 2026-05-06  
**Branch:** hotfix/duplicate-initDeploySection  
**PR:** #144

### Bug Fixes
- fix(#144): remove duplicate `initDeploySection()` declaration in `admin.js` — caused a fatal `SyntaxError` in ES module strict mode, breaking every admin panel section on page load
- Root cause: bad merge conflict resolution in `release/2026-05-05-2` kept both the old and new versions of the function

### Breaking Changes / Deployment Notes
- None — frontend-only fix; no backend restart or DB changes required

---

## 🔥 Hotfix 2026-05-06 (PR #140)

**Released:** 2026-05-06  
**Branch:** hotfix/deploy-section-missing  
**PR:** #140

### Bug Fixes
- fix(#140): restore missing deployment section HTML in `admin.html` — the deployment panel tab content was absent after the `release/2026-05-05-2` merge, making the deploy console inaccessible

### Breaking Changes / Deployment Notes
- None — frontend-only fix; no backend restart or DB changes required

---

## 2026-05-05-2

**Released:** 2026-05-05  
**Branch:** release/2026-05-05-2  
**PR:** #126

### Features
- feat(#129): git fetch button in deployment panel — retrieves latest commits from remote before deploying
- feat(#129): `POST /api/deploy/fetch` endpoint with SSE streaming output
- feat(#100): contact form dev stub — returns `{ success: true }` in local dev when SMTP not configured; returns 503 in production
- chore: `Seed-DevData.ps1` development database seeding script
- chore(#130): `docs/DEPENDENCIES.md` — architectural guidance for adding, updating, and removing packages
- chore(#130): `Test-Regression.ps1` — baseline regression test script extracted from per-PR test harnesses
- chore(#130): all root-level docs consolidated under `docs/`

### Bug Fixes
- fix(#123): deploy script uses `git reset --hard` instead of `git pull` to prevent local change conflicts
- fix(#94): blog and travel admin clear buttons now show confirmation prompt before resetting
- fix(#93, #95): date slicing — travel and blog edit forms now correctly populate date fields
- fix(#108): visit counters missing on admin stats panel
- fix: `$Host` reserved variable error in `prod-deploy.ps1` — renamed to `$Hostname`

### Breaking Changes / Deployment Notes
- None — `npm install` runs automatically in the deploy script if `package.json` changed

---

## 2026-05-05

**Released:** 2026-05-05  
**Branch:** release/2026-05-05  
**PR:** #113

### Features
- feat(#98, #117): admin deployment panel with live status, deploy history, and rollback capability
- feat(#98): `POST /api/deploy/` — SSE-streaming deploy endpoint
- feat(#98): `POST /api/deploy/rollback` — rollback to a previous commit
- feat(#98): `GET /api/deploy/status` — current HEAD vs remote comparison
- feat(#98): `GET /api/deploy/history` — deploy log and recent commits
- chore: `backend/utils/shell.js` — shared spawn utilities for streaming child processes

### Bug Fixes
- fix(#118): unhandled `spawn` error (`ENOENT`) when git not available in dev — backend no longer crashes
- fix(#118): deploy endpoints gracefully degrade when git unavailable rather than returning 500

### Breaking Changes / Deployment Notes
- None — deploy script handles `npm install` automatically

---

## 2026-05-04-2

**Released:** 2026-05-04  
**Branch:** release/2026-05-04-2  
**PR:** #114

### Features
- feat(#97): automated testing — Vitest + Supertest integration suite wired into the backend container (`npm test`)
- feat(#101): CV management — `GET /api/cv/exists`, `GET /api/cv`, `POST /api/cv`, `DELETE /api/cv`; multer PDF-only upload (5 MB cap); pdf-parse private-content scan with warnings modal in admin UI
- feat(#110): CV download button on `index.html` — hidden when no CV present, fetched via blob URL, updates reactively on `visibilitychange` without a page reload

### Bug Fixes
- fix(#93): travel edit form — `visit_date` sliced to `YYYY-MM-DD` before populating the date input
- fix(#95): blog edit form — `loadPostForEdit` converted to `async/await` so `post_date` and `body_markdown` always populate before user interaction; new post defaults date to today

### Process / Docs
- docs(AI.md): documentation hygiene rule — stale paths and added/removed files must be updated in the same commit
- docs(STYLE_GUIDE.md): section-header comment convention (`// ── Label`); stale test script paths corrected
- docs(README.md): AI onboarding prompt section added
- test(Test-PR107.ps1): idempotent CV cleanup step before empty-CV 404 assertion to prevent false failures on repeat runs

### Breaking Changes / Deployment Notes
- `pdf-parse` npm dependency added — run `npm install` inside the backend container after deploy
- CV uploads are stored at `uploads/cv.pdf` on the server — ensure the `uploads/` directory exists and is writable by the Node process

### Known Issues
- #100: contact form returns 500 in dev — SMTP credentials not configured; fails open, no data lost
- #111: CV private-content scanner does not detect phone numbers or home addresses — manual redaction required until resolved

---
