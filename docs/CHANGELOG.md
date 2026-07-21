# Changelog

All notable changes to andykeys.me are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) — entries are grouped as `Added`, `Fixed`, `Changed`, `Removed` per release. Unreleased work on `dev` is listed at the top.

---

## Unreleased (dev)

### Added

- `scripts/ops/migration-restore.sh` — Phase 3/4 completion script for the 1 TB SSD migration (#529): extends the root LV to use the full disk, installs Docker CE/UFW/Dropbear/Glances/ddclient, restores crontabs, rsyncs SSL certs and Docker volumes from the old disk, and starts both Compose stacks. Idempotent — safe to re-run.
- Lightweight SQL migration runner (`backend/db/migrate.js`) — tracks applied migrations in `schema_migrations` table, applies numbered files from `backend/db/migrations/` on startup; no new npm packages (#169)
- CSV bulk import for travel memories — `POST /travel/import` (auth-gated, 1 MB cap, per-row error tracking) with admin UI in the Travel page (#245)
- Image & video optimisation pipeline (#174): new uploaded images are automatically resized (≤2400px) and converted to WebP (quality 85) with a 400px square thumbnail generated alongside; video uploads (MP4, WebM, QuickTime) get a JPEG thumbnail extracted from the first frame via ffmpeg. Processing runs as a background pg-boss job — upload responses are immediate regardless of file size. File size limit raised from 20 MB to 1 GB to support DJI Osmo 4K footage. Three new DB columns (`full_url`, `thumb_url`, `media_status`) on `posts` and `post_media` tables; existing entries unaffected (columns nullable, frontend falls back to `media_url`). Admin travel section shows a processing queue panel with per-job status, age, and a Retry button for failed jobs. Public travel page uses `thumb_url` for cards/timeline and `full_url` for lightbox, falling back to `media_url`.
- Bulk photo/video upload for travel memories — new `POST /api/travel/:id/photos/bulk` endpoint accepts up to 20 files per request, applies the same MIME and size validation as single-file upload, inserts rows into `post_media`, enqueues background processing jobs, and updates the primary `media_url` if not already set. Admin travel editor gains a **Bulk upload photos / videos** section (visible only when editing a saved memory) that refreshes the media list and job queue after each batch. No schema changes; no effect on single-file upload or CSV import flows (#511).

### Fixed

- `scripts/ops/migration-restore.sh` (#529) — Ollama container existence check used `docker inspect ollama`, which matches any Docker object by that name (including the `ollama` volume left over from an earlier attempt), so it silently skipped starting the container when only the volume existed. Now checks `docker inspect --type container ollama`; the CPU-only fallback also removes any stale container left behind by a failed `--gpus all` attempt before retrying.

---

## Release 2026-06-15

### Added

- Audit log table, activity dashboard in admin stats, full-text search route, CV version history, dev seed script, compose file deduplication (#464)
- Embedded search input on public blog and travel listing pages (#469)
- Upload button to trigger GPS extraction on mobile (#466)
- Audit log UI improvements — status badges, scrollable feed, colour-coded event types (#468)
- Location field normalised to "City, Country" on geocode (#248)
- `docs/TECH_DEBT.md` — full codebase tech debt audit (#379)

### Fixed

- `ERR_ERL_INVALID_HITS` suppressed in test output (#465)
- Error alert cooldown persisted in DB across container restarts — was reset on every container cycle, allowing repeated alert storms (#371)
- CV download filename aligned to `Andy_Keys_CV.pdf` (#426)
- `isAdminSession()` removed from `config.js` (#424)
- Backup schedule check tightened to prevent false positives (#447)
- `JWT_EXPIRY` env var now wired through in `auth.js` — was ignored, causing tokens to use the hardcoded default (#425)
- Contact form now sends to `ADMIN_EMAIL` with structured delivery logging (#420)
- `docker.sock` privilege escalation risk documented (#450)
- Daily backup cron documented in `docs/BACKUP.md`; stale references corrected (#185)

### Security

- nginx `X-Forwarded-For` header stripped at proxy boundary to prevent IP spoofing; search query length capped at 200 chars (#475)
- Hand-rolled HTML sanitizer replaced with DOMPurify — eliminates entire class of XSS bypass risk (#427)
- Rate limit counters isolated per endpoint via `key_type` column — prevents one endpoint's burst from consuming another's quota (#445)
- `next(err)` used in all DB-error catch blocks; rate limiting added to posts, travel, and account routes (#453)
- Authenticated sessions exempted from rate limiting (#418)

### Changed

- `admin/travel.js` split into focused sub-modules (#438)
- `dc()` wrapper added; 37 raw `docker compose` invocations in deploy scripts replaced (#455)
- `UPLOADS_DIR`, `wrapMulter`, `findUniqueSlug` extracted as shared backend utilities (#429)
- `recordVisit()` extracted with admin-session guard (#432)
- Lightbox extracted to `utils/lightbox.js` — shared across blog and travel pages (#430)
- `createMessenger` factory extracted for admin modules (#431)
- Batch refactors: #433, #434, #150, #376, #111, #158
- Deprecated deploy files deleted; rollback hardened; `server-setup.sh` improved (#435)

---

## Release 2026-05-25

### Added

- Frontend error logger (#333, #336): `error-logger.js` captures uncaught JS errors, resource-load failures, unhandled promise rejections, CSP violations, and explicit `console.error`/`console.warn` calls. Reports delivered to `POST /api/debug/errors`, persisted to `client_errors` table, and surfaced in the admin stats panel. Resilient delivery: failed sends buffered in `localStorage` and flushed on next page load (#334). Request-ID correlation (#336) groups all errors from the same page view and links frontend reports to the exact backend log line via `X-Request-Id`.
- Error alert emails (#333): admin receives an email when 20+ frontend errors arrive within a 15-minute window (configurable via `ERROR_ALERT_THRESHOLD` / `ERROR_ALERT_WINDOW_MS`). In-memory cooldown prevents repeated emails during sustained storms. Top error types/messages included in the alert body.
- Backend startup env validation (#357): `backend/utils/validateEnv.js` asserts every required env var (`PORT`, `DB_*`, `JWT_SECRET`, `WEBAUTHN_*`, `FRONTEND_URL`, `SITE_HOST`, `ADMIN_EMAIL`) is present and non-empty at startup via `validateEnvOrExit()`. A var defined in `.env` but not bridged into the compose `environment:` block resolves to empty in the container — the backend logs each missing var and exits 1, so the deploy rolls back instead of serving traffic with broken config.
- CSP maintenance is now a standing dev-cycle rule (#339): adding or moving any external resource (script/style/font/image source, inline script, or a `fetch` to a new origin) must update `scripts/config/nginx-security-headers.conf` in the same PR. Documented in `docs/AI.md`, `CLAUDE.md`, and a new PR-template checklist item.
- Automated browser CSP violation scan on every deploy (#341): `test-csp-violations.js` loads all served pages in Puppeteer and flags any `securitypolicyviolation` event. Warn-only; machine-parseable `[csp-violations]` summary line in the deploy report.
- Authenticated admin E2E CSP scan on every deploy (#342): `test-admin-e2e-csp.js` mints a JWT, loads `/admin/`, and drives Nominatim geocode interactions. Any CSP violation during authenticated flows fails the check.
- Dev hostname redirect (#358): `dev.andykeys.me:443` redirects to `:3001` via a prod-nginx `server` block — eliminates the port-confusion support burden.
- Vitest test coverage for upload, cv, and debug routes (#335): auth gating, MIME filtering, size limits, private-info scan warnings, error ingestion/persistence, pagination, and sanitisation. `posts` tests extended with happy-path INSERT (201), PUT 404, and DELETE flows. Bug fix: `cv.js` `MulterError` now correctly returns 400 (was 500) via callback pattern.

### Fixed

- Browser-extension errors filtered from error-logger (#356): uncaught errors and resource-load failures originating from `chrome-extension://`, `moz-extension://`, or `safari-extension://` URLs are discarded before reaching `/api/debug/errors`. Deploy-time Puppeteer tests now intercept and mock `POST /api/debug/errors` to prevent headless-Chromium noise (`Couldn't load fs/zlib`) from writing to `client_errors` and triggering false alert emails.
- CORS smoke check added to regression suite (#357): `GET /api/health` with `Origin: https://<SITE_HOST>` (port omitted, as browsers send it) must succeed — catches the case where `SITE_HOST` is missing in the container and every site-origin request returns 500.
- CSP violations handler made `async` (#360): `POST /api/debug/csp-violations` handler is now correctly `async` for CodeQL rate-limit pattern recognition.
- Relative media URLs in travel cards (#266, #267): `buildPublicTravelCard` and `buildPostCard` now normalise any bare relative `media_url` from the API by prepending `/`, preventing a 404 for `/travel/resources/img/...` (resolved relative to the page path) that was captured by error-logger on every travel page load.
- Deploy script exits with a clear error if run as sudo (#351): prevents file ownership corruption in the repo directory.
- Backup bootstrap on deploy (#352): deploy now creates the backup directory, installs the cron job, and takes an initial DB dump if none exists — ensures the backup schedule is active immediately after a fresh provision.

### Security

- CSP `report-to` added alongside deprecated `report-uri` (#337): `Reporting-Endpoints` header names `/api/debug/csp-violations`; both directives present during transition.
- Debug endpoint rate limiting migrated to DB-backed `createRateLimiter` (#337): limits survive container restarts and are consistent with auth/contact limiters.
- `qs` dependency bumped (#321): resolves upstream prototype-pollution advisory.

### Changed

- Deploy test-suite reporting normalised (#366): all five test phases (`vitest`, `error-logger`, `error-logger-contracts`, `csp-violations`, `regression`) now emit consistent `suite= tests= passed= failed=` counts in the deploy report. Backend Vitest counts read from the json reporter (immune to text-summary format drift). Deploy-time Puppeteer tests use `setRequestInterception` to mock `POST /api/debug/errors` so test sessions never write to `client_errors`. DEPLOY COMPLETE banner moved to after the report box.
- Unified bash deploy scripts (#300): `dev-deploy.sh` and `prod-deploy.sh` replaced by a single `deploy.sh --env dev|prod`.
- Project structure reorg (#307): HTML pages moved into feature subfolders (`blog/`, `travel/`, `admin/`, `login/`, `setup/`) giving clean URLs. `resources/java/` renamed to `resources/js/`. All internal links and the magic link email URL updated.

---

## Release 2026-05-26

### Added

- Admin CRUD E2E test suite (#175): `test-admin-e2e.js` runs full authenticated Puppeteer CRUD flows (blog create/delete, travel create/delete, deploy panel smoke) on every deploy. Hard-fail on assertion error (triggers rollback); warn-only if Puppeteer fails to launch. Test records prefixed `[E2E]` are cleaned up at start and end of each run.

### Changed

- Admin JS modularised (#175): 1,173-line `admin.js` monolith split into eight focused modules under `resources/js/admin/` (`posts.js`, `travel.js`, `deploy.js`, `cv.js`, `auth.js`, `passkeys.js`, `stats.js`, `notes.js`). `admin.js` is now a thin entry point that imports and initialises each module.
- jQuery removed from admin panel (#176): all admin JS migrated to vanilla DOM APIs and `fetch`. No behaviour change.
- Travel date field unified (#132): `visit_date`/`visitDate` alias removed from `TRAVEL_COLS`; field is now consistently `post_date` throughout the stack (backend routes, middleware schemas, frontend JS, utils, tests).

---

## Release 2026-05-25

### Added

- Frontend error logger (#333, #336): `error-logger.js` captures uncaught JS errors, resource-load failures, unhandled promise rejections, CSP violations, and explicit `console.error`/`console.warn` calls. Reports delivered to `POST /api/debug/errors`, persisted to `client_errors` table, and surfaced in the admin stats panel. Resilient delivery: failed sends buffered in `localStorage` and flushed on next page load (#334). Request-ID correlation (#336) groups all errors from the same page view and links frontend reports to the exact backend log line via `X-Request-Id`.
- Error alert emails (#333): admin receives an email when 20+ frontend errors arrive within a 15-minute window (configurable via `ERROR_ALERT_THRESHOLD` / `ERROR_ALERT_WINDOW_MS`). In-memory cooldown prevents repeated emails during sustained storms. Top error types/messages included in the alert body.
- Backend startup env validation (#357): `backend/utils/validateEnv.js` asserts every required env var (`PORT`, `DB_*`, `JWT_SECRET`, `WEBAUTHN_*`, `FRONTEND_URL`, `SITE_HOST`, `ADMIN_EMAIL`) is present and non-empty at startup via `validateEnvOrExit()`. A var defined in `.env` but not bridged into the compose `environment:` block resolves to empty in the container — the backend logs each missing var and exits 1, so the deploy rolls back instead of serving traffic with broken config.
- CSP maintenance is now a standing dev-cycle rule (#339): adding or moving any external resource (script/style/font/image source, inline script, or a `fetch` to a new origin) must update `scripts/config/nginx-security-headers.conf` in the same PR. Documented in `docs/AI.md`, `CLAUDE.md`, and a new PR-template checklist item.
- Automated browser CSP violation scan on every deploy (#341): `test-csp-violations.js` loads all served pages in Puppeteer and flags any `securitypolicyviolation` event. Warn-only; machine-parseable `[csp-violations]` summary line in the deploy report.
- Authenticated admin E2E CSP scan on every deploy (#342): `test-admin-e2e-csp.js` mints a JWT, loads `/admin/`, and drives Nominatim geocode interactions. Any CSP violation during authenticated flows fails the check.
- Dev hostname redirect (#358): `dev.andykeys.me:443` redirects to `:3001` via a prod-nginx `server` block — eliminates the port-confusion support burden.
- Vitest test coverage for upload, cv, and debug routes (#335): auth gating, MIME filtering, size limits, private-info scan warnings, error ingestion/persistence, pagination, and sanitisation. `posts` tests extended with happy-path INSERT (201), PUT 404, and DELETE flows. Bug fix: `cv.js` `MulterError` now correctly returns 400 (was 500) via callback pattern.

### Fixed

- Browser-extension errors filtered from error-logger (#356): uncaught errors and resource-load failures originating from `chrome-extension://`, `moz-extension://`, or `safari-extension://` URLs are discarded before reaching `/api/debug/errors`. Deploy-time Puppeteer tests now intercept and mock `POST /api/debug/errors` to prevent headless-Chromium noise (`Couldn't load fs/zlib`) from writing to `client_errors` and triggering false alert emails.
- CORS smoke check added to regression suite (#357): `GET /api/health` with `Origin: https://<SITE_HOST>` (port omitted, as browsers send it) must succeed — catches the case where `SITE_HOST` is missing in the container and every site-origin request returns 500.
- CSP violations handler made `async` (#360): `POST /api/debug/csp-violations` handler is now correctly `async` for CodeQL rate-limit pattern recognition.
- Relative media URLs in travel cards (#266, #267): `buildPublicTravelCard` and `buildPostCard` now normalise any bare relative `media_url` from the API by prepending `/`, preventing a 404 for `/travel/resources/img/...` (resolved relative to the page path) that was captured by error-logger on every travel page load.
- Deploy script exits with a clear error if run as sudo (#351): prevents file ownership corruption in the repo directory.
- Backup bootstrap on deploy (#352): deploy now creates the backup directory, installs the cron job, and takes an initial DB dump if none exists — ensures the backup schedule is active immediately after a fresh provision.

### Security

- CSP `report-to` added alongside deprecated `report-uri` (#337): `Reporting-Endpoints` header names `/api/debug/csp-violations`; both directives present during transition.
- Debug endpoint rate limiting migrated to DB-backed `createRateLimiter` (#337): limits survive container restarts and are consistent with auth/contact limiters.
- `qs` dependency bumped (#321): resolves upstream prototype-pollution advisory.

### Changed

- Deploy test-suite reporting normalised (#366): all five test phases (`vitest`, `error-logger`, `error-logger-contracts`, `csp-violations`, `regression`) now emit consistent `suite= tests= passed= failed=` counts in the deploy report. Backend Vitest counts read from the json reporter (immune to text-summary format drift). Deploy-time Puppeteer tests use `setRequestInterception` to mock `POST /api/debug/errors` so test sessions never write to `client_errors`. DEPLOY COMPLETE banner moved to after the report box.
- Unified bash deploy scripts (#300): `dev-deploy.sh` and `prod-deploy.sh` replaced by a single `deploy.sh --env dev|prod`.
- Project structure reorg (#307): HTML pages moved into feature subfolders (`blog/`, `travel/`, `admin/`, `login/`, `setup/`) giving clean URLs. `resources/java/` renamed to `resources/js/`. All internal links and the magic link email URL updated.

---

## Release 2026-05-18

### Added

- Deployment hardening (#263 A+B+C, #270): `check_disk_space`, `prompt_missing_vars`, `auto_detect_lan_ip`, `log_deploy_summary`, and `run_deploy_tests` (Vitest in the live container post-health-check; failure triggers rollback). Non-blocking backend startup preflight (DB + Outlook OAuth2) in `server.js` — warns, never crashes
- `scripts/tests/test-regression.sh` — server-side bash regression smoke suite, run as the final step of every deploy; JWT generated from the running container so it matches the server's `JWT_SECRET`. Covers public baseline, auth gating (deploy/upload/posts/travel must 401 without a token), and (dev only) rate-limit enforcement
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
- `/health` endpoint made internal-only (#279): nginx no longer proxies the path; reachable only on the backend's direct port (localhost-bound in all compose files). Deploy health checks updated to use the direct port; `/api/health` alias removed

### Security

- `POST /auth/setup` now enforces `ADMIN_EMAIL` server-side — wrong email and unconfigured server both return a generic 403; guard runs before any DB access (#274)
- `/health` removed from public nginx routing — version, uptime, and DB status no longer exposed to the internet (#279)

### Changed

- Regression tests moved server-side: `scripts/tests/Test-Regression.ps1` replaced by `test-regression.sh`; `dev-deploy.ps1` / `prod-deploy.ps1` stripped to thin SSH wrappers. Deploy scripts reach the running site via curl `--resolve` (server can't route to its own public DNS name); regression failure now always prints the report and exits non-zero rather than aborting silently
- GitHub Actions CI disabled (`workflow_dispatch` only) — tests run in the deployed container instead (#270)
- `docs/TESTING.md`, `docs/AI.md`, `CLAUDE.md` — updated for deploy-time Vitest + regression, `-SkipRegression`/`-Quiet`, the report box, and `test-regression.sh` replacing `Test-Regression.ps1`
- Email transport: SMTP basic auth → Outlook OAuth2 (Graph API). Microsoft disabled SMTP basic auth; `nodemailer` SMTP retained only as a fallback for non-Outlook providers
- Documentation: replaced stale "Raspberry Pi" / `portfolio-server` host references with the canonical "Ubuntu Server (`ak-home-server`)" across README, CLAUDE.md, ROADMAP, PROJECT_ASSESSMENT, AI.md, and deploy/monitor script comments (#171)
- `.env*.example`: OAuth2 promoted to the primary email method, SMTP demoted to documented fallback
- `PROJECT_ASSESSMENT.md`: post-migration reassessment — corrected stale PM2/performance statements and removed the resolved SSH-from-Windows pain point
- Working instructions (`docs/AI.md`, `CLAUDE.md`): after opening a PR, recommend a ready-to-copy squash commit message for the owner to apply on merge
- Backend: all runtime `console.*` calls replaced with the structured logger (routes, middleware, utils, server/app entry); test/CLI scripts left as-is (#153)

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

- Admin publish/unpublish toggle could silently erase the post body — backend UPDATE now `COALESCE`s `body_markdown` instead of overwriting with an empty string on a partial PUT (#522)
- `PUT /travel/:id` left an open transaction on the pool when returning 404 — now rolls back before returning (#522)
- `WEBAUTHN_RP_NAME` is now validated at startup like the other WebAuthn env vars (#522)
- CV version pruning could delete the version just made current if it wasn't among the 5 newest uploads — now excludes the current version (#522)
- `POST /stats/visit` had no rate limiter, the only unauthenticated write endpoint without one (#522)
- Contact form's dev-fallback log no longer writes raw name/email/message — uses redaction like the rest of the app (#522)
- `errorHandler` now forwards post-headers-sent errors to `next(err)` instead of silently swallowing them (#522)
- Travel media-delete endpoint now runs its two queries in a transaction and writes an audit log entry, matching every other travel mutation (#522)
- AI Blog page visits were never recorded — `ai-blog` was missing from the stats route's page whitelist (#522)
- Admin deploy branch selector could show a stale branch list right after a successful fetch — cache is now cleared on `/fetch` (#522)
- Media upload retry no longer silently burns retries against a deleted original file — returns 404 with a clear message instead (#522)
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
