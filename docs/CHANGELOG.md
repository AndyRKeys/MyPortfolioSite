# Changelog

All notable changes to andykeys.me are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) — entries are grouped as `Added`, `Fixed`, `Changed`, `Removed` per release. Unreleased work on `dev` is listed at the top.

---

## Unreleased (dev)

### Added
- Deployment hardening (#263 A+B+C, #270): `check_disk_space`, `prompt_missing_vars`, `auto_detect_lan_ip`, `log_deploy_summary`, and `run_deploy_tests` (Vitest in the live container post-health-check; failure triggers rollback). Non-blocking backend startup preflight (DB + Outlook OAuth2) in `server.js` — warns, never crashes
- `scripts/tests/test-regression.sh` — server-side bash regression smoke suite, run as the final step of every deploy; JWT generated from the running container so it matches the server's `JWT_SECRET`. Covers public baseline, auth gating (deploy/upload/posts/travel must 401 without a token), health DB-connectivity flag, and (dev only) rate-limit enforcement
- Machine-readable deploy output (#276): `[deploy:<phase>]` checkpoint lines at every decision point plus a final AI-readable deploy-report box aggregating the current run's checkpoints; `-Quiet` mode suppresses verbose noise while keeping checkpoints, warnings, errors, and the report
- Dev-only rate-limit reset before/after the regression run (via the backend container's own pool), so repeated deploys within the rate-limit window don't false-fail contact checks; prod deliberately excluded
- Outlook OAuth2 email via Microsoft Graph API (`/v1.0/me/sendMail`); `scripts/generate-outlook-refresh-token.js` captures a long-lived refresh token (delegated `Mail.Send`, personal-account `/consumers/` endpoint) (#241)
- Rate limiting on auth endpoints: `/auth/email/send` (5/hr/IP), passkey register/login (10/hr/IP) (#237)
- Magic-link recipient gate: tokens only sent to `ADMIN_EMAIL`; other addresses get the same success response with no email (anti-enumeration) (#241)
- `OUTLOOK_*` env vars wired through all three compose files and documented in every `.env*.example`
- `docs/TERMINOLOGY.md` — canonical names for host, hostnames, environments, services, and branches; wired into the onboarding doc lists
- Structured backend logging via `pino` + `pino-http` (#153): severity levels, per-request HTTP log line (method/path/status/latency), `LOG_LEVEL` env var (default `info`), and centralised secret redaction (auth headers, tokens, passwords, refresh tokens). Shared logger at `backend/utils/logger.js`
- Docker `json-file` log rotation on all services in all three compose files: `10m / 3 files` (local dev), `20m / 5 files` (prod + dev-server) — prevents unbounded disk growth from structured log output
- Server-side admin guard on `POST /auth/setup` (#274): registration now requires `ADMIN_EMAIL` to be configured and the submitted email to match; wrong-email and not-configured both fail with a generic 403 to avoid enumeration. Registration remains a one-time operation and still refuses if any user already exists; covered by unit tests in `backend/tests/routes/auth.test.js`

### Changed
- Regression tests moved server-side: `scripts/tests/Test-Regression.ps1` replaced by `test-regression.sh`; `dev-deploy.ps1` / `prod-deploy.ps1` stripped to thin SSH wrappers. Deploy scripts reach the running site via curl `--resolve` (server can't route to its own public DNS name); regression failure now always prints the report and exits non-zero rather than aborting silently
- GitHub Actions CI disabled (`workflow_dispatch` only) — tests run in the deployed container instead (#270)
- `docs/TESTING.md`, `docs/AI.md`, `CLAUDE.md` — updated for deploy-time Vitest + regression, `-SkipRegression`/`-Quiet`, the report box, and `test-regression.sh` replacing `Test-Regression.ps1`
- Email transport: SMTP basic auth → Outlook OAuth2 (Graph API). Microsoft disabled SMTP basic auth; `nodemailer` SMTP retained only as a fallback for non-Outlook providers
- Documentation: replaced stale "Raspberry Pi" / `portfolio-server` host references with the canonical "Ubuntu Server (`ak-home-server`)" across README, CLAUDE.md, ROADMAP, PROJECT_ASSESSMENT, AI.md, and deploy/monitor script comments (migration off the Pi is complete; #171). Historical records (CHANGELOG, RELEASE_NOTES, lessons-learned) left intact. Pi-era infra scripts marked deprecated in favour of `scripts/deploy/server-setup.sh` + the containerised Nginx setup: `scripts/infra/pi-setup.sh`, `setup-nginx-ssl.ps1`, `setup-ssl.ps1`, `fix-apache.ps1`
- `.env*.example`: OAuth2 promoted to the primary email method, SMTP demoted to documented fallback
- `PROJECT_ASSESSMENT.md`: post-migration reassessment — corrected stale PM2/performance statements and removed the resolved SSH-from-Windows pain point
- Working instructions (`docs/AI.md`, `CLAUDE.md`): after opening a PR, recommend a ready-to-copy squash commit message for the owner to apply on merge
- Backend: all runtime `console.*` calls replaced with the structured logger (routes, middleware, utils, server/app entry); test/CLI scripts left as-is. `docs/DEPENDENCIES.md` and `docs/SECURITY.md` document the logging stack and redaction policy; `LOG_LEVEL` added to all `.env*.example`

### Removed
- `docker/.env.example` — duplicate of root `.env.example`; README updated to reference the canonical file

---

## Release 2026-05-07

### Added
- `/api/health` endpoint for deploy verification and uptime monitoring (#163)
- Security headers to Nginx reverse proxy configuration (X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy)
- `docs/INFRASTRUCTURE.md` — comprehensive server layout, service architecture, operational procedures, troubleshooting guide (#167)
- `docs/ARCHITECTURE.md` — system design diagrams, request flow examples, data flow walkthrough (#168)
- `docker-compose.prod.yml` — standalone production Docker Compose file with SSL support, no source code mounts (#165)
- `scripts/deploy/server-setup.sh` — one-shot Ubuntu Server initial setup script (Docker, SSH hardening, SSL, crons) (#171)
- `scripts/backup/db-backup.sh` — daily PostgreSQL backup with 7-day local rotation (#164)
- `scripts/backup/db-restore.sh` — restore from any backup file (#164)
- `scripts/backup/offsite-sync.sh` — rclone sync to Backblaze B2 for offsite backup (#172)
- `scripts/backup/certbot-renew.sh` — SSL certificate renewal with nginx container management (#172)
- `.env.example` — root-level production environment template for Docker Compose (#171)
- Dropbear SSH in initramfs for remote disk decryption on server reboot (#171)

### Fixed
- Nginx template path bug in `docker-compose.yml` (was `scripts/nginx-*.conf.template`, now `scripts/config/nginx-*.conf.template`) (#152 merged)
- SSH deploy target hostname changed from `portfolio-server` to `ak-home-server` (#179)

### Changed
- Production architecture: from PM2 on host to Docker Compose containerized services (#165)
- Nginx now reverse-proxies from Docker instead of system service (#165)
- PostgreSQL now containerized with persistent volumes (#165)
- Deploy script (`prod-deploy.sh`) rewritten for Docker Compose instead of PM2 (#179)
- `.env` now loaded by Docker Compose at repo root instead of per-service (#171)

### Removed
- `test-results/` directory from version control; added to `.gitignore` (#170)

---

## Release 2026-05-06

### Fixed
- Admin page completely non-functional — `initDeploySection()` declared twice in `admin.js` causing a `SyntaxError` that prevented the entire file from parsing (#144)
- Root cause: bad merge conflict resolution in `release/2026-05-05-2` kept both the old and new versions of the function; `type="module"` strict mode made this fatal in browsers

---

## Release 2026-05-05-2

### Added
- Git fetch button in deployment panel — retrieves latest commits from remote before deploying (#129)
- `POST /api/deploy/fetch` endpoint with SSE streaming output (#129)
- Contact form dev stub — returns success in local dev when SMTP not configured; returns 503 in production with no SMTP (#100)
- Seed-DevData.ps1 — development database seeding script with realistic test data
- docs/DEPENDENCIES.md — architectural guidance for adding, updating and removing packages
- Test-Regression.ps1 — baseline regression test script extracted from per-PR test harnesses (#130)
- All root-level docs consolidated under `docs/` (#130)

### Fixed
- Deploy script uses `git reset --hard` instead of `git pull` to prevent local change conflicts (#123)
- Blog and travel admin clear buttons now show confirmation prompt before resetting (#94)
- Date slicing — travel and blog edit forms now correctly populate date fields (#93, #95)
- Visit counters missing on stats panel (#108)
- `$Host` reserved variable error in `prod-deploy.ps1` — renamed to `$Hostname`

### Changed
- Scripts reorganised into logical subdirectories: `deploy/`, `dev/`, `infra/`, `monitoring/`, `config/`, `tests/`
- All cross-references in docs updated to new `docs/` paths (#130)
- PR template updated with smoke test and documentation checklist (#130)

---

## Release 2026-05-05

### Added
- Admin deployment panel with live status, deploy history, and rollback capability (#98, #117)
- `POST /api/deploy/` — SSE-streaming deploy endpoint
- `POST /api/deploy/rollback` — rollback to a previous commit
- `GET /api/deploy/status` — current HEAD vs remote comparison
- `GET /api/deploy/history` — deploy log and recent commits
- `backend/utils/shell.js` — shared spawn utilities for streaming child processes

### Fixed
- Unhandled `spawn` error (`ENOENT`) when git not available in dev — backend no longer crashes (#118)
- Deploy endpoints gracefully degrade when git unavailable rather than returning 500

---

## [Unreleased] — on `dev`, not yet in production

### Fixed
- Delete button size/shape inconsistency — add `.btn-danger` variant to button system; `.travel-delete-btn` now composes from it, removing `!important` overrides (#137)

### Added
- Travel post detail page (`travel-post.html`) with media gallery, Leaflet map, and lightbox (#78)
- Public `GET /api/travel/:id` route for individual travel memories (#78)
- Visit counter — tracks page visits per route, displayed in footer (#14)
- CV download button in About section (#4)
- Travel timeline view on `travel.html` (#25)
- EXIF GPS geocoding — reads GPS coords from uploaded photos and reverse-geocodes to a location name (#26)
- Multi-media support for travel posts — multiple photos/videos per memory, ordered gallery (#30)
- DB-backed rate limiting for contact form (#79)
- Database indexes on hot query columns (`post_type`, `published_at`, `post_date`, `post_type + published_at + post_date`) (#79)
- Shared backend utilities: `backend/utils/html.js` (escapeHtml), `backend/utils/slugify.js` (#79)
- Shared frontend utilities: `resources/java/utils/html.js`, `utils/date.js`, `utils/dom.js` (#79)
- Input validation middleware `backend/middleware/validate.js` (#79)
- Centralised error handler `backend/middleware/errorHandler.js` (#79)
- `stats` route `GET /api/stats` for admin page visit counts (#79)
- ES module migration for all frontend JavaScript (#79)
- Local Nginx dev template without SSL (`scripts/nginx-local.conf.template`) (#77)
- docs/AI.md — AI pair programmer instructions and workflow (#90)
- docs/STYLE_GUIDE.md — coding style and naming conventions
- docs/DATABASE.md — schema reference (this release)
- docs/SECURITY.md — auth model and threat model (this release)
- GitHub issue and PR templates (this release)
- All root-level docs consolidated under `docs/` — `AI.md`, `CHANGELOG.md`, `DATABASE.md`, `SECURITY.md`, `STYLE_GUIDE.md` moved from repo root (#130)
- `docs/DEPENDENCIES.md` added to AI onboarding prompt in README and When in Doubt list in `docs/AI.md` (#130)
- `.github/pull_request_template.md` — Smoke Test and Documentation checklist sections added (#130)

### Fixed
- Blog post 404 errors — corrected `API_BASE` in `blog-post.js` to always use `/api` (#81)
- Lightbox close/escape/arrow key handlers rewritten using native `addEventListener` (#82)
- Map rendering on travel detail page — initialise Leaflet after `post-body` is visible (#78)
- Travel card and timeline click targets now navigate to detail page instead of opening lightbox (#78)
- Duplicate `isAdminSession` function removed, extracted to shared `auth-utils.js` (#79)
- `header` CSS selector scoped to `body > header` to prevent gradient bleeding into post article headers (#91)
- `npm test` in `docs/DEPENDENCIES.md` replaced with Docker wrapper command — aligns with project-wide rule (#130)

### Changed
- Blog and travel post detail pages unified with consistent `.post-meta` date styling
- Travel post section order changed to: map → gallery → notes
- All cross-references in docs updated to new `docs/` paths (#130)
- Extract travel listing logic from `script.js` into dedicated `travel.js` (#133); fixes travel page visit counter not firing

---

## v 2026-05-04 — Production baseline

> This is the state of `main` as of the initial CHANGELOG creation. Releases prior to this point are documented via git history.

### Fixed
- API_BASE set correctly for prod vs localhost environments (#69, #70)
- Nginx SSL template and deploy script reliability (#65, #67, #68)
- npm install always runs in deploy script
