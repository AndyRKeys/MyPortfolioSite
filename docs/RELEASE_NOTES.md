# Release Notes

## Release 2026-06-15

**Released:** 2026-06-15
**Branch:** release/2026-06-15
**PR:** [#477](https://github.com/AndyRKeys/MyPortfolioSite/pull/477)
**Closes:** #475, #469, #466, #468, #465, #464, #438, #371, #429, #432, #435, #185, #455, #453, #450, #426, #430, #424, #447, #425, #445, #427, #431, #379, #248, #418, #420, #433, #434, #150, #376, #111, #158

### Summary

Security hardening, new features, and a large batch of code quality refactors. 29 commits bundled from `dev` since the 2026-05-31-3 release. Highlights: nginx `X-Forwarded-For` spoofing closed (#475), DOMPurify replaces hand-rolled XSS sanitizer (#427), rate-limit counter isolation (#445), embedded search on public pages (#469), audit log UI overhaul (#464, #468), mobile GPS upload button (#466), and a comprehensive code quality sweep.

### Features

- **feat(#469):** Embed search input on blog and travel listing pages — users can filter posts without navigating away
- **feat(#466):** Upload button to trigger GPS coordinate extraction on mobile — restores one-tap GPS import when drag-and-drop is unavailable
- **feat(#468):** Audit log UI improvements — status badges, scrollable feed, colour-coded event types
- **feat(#464):** Audit log table, activity dashboard in admin stats, full-text search route, CV version history, dev seed script, compose file deduplication
- **feat(#248):** Location field normalised to "City, Country" format on geocode — consistent presentation across all travel memories
- **feat(#418):** Authenticated sessions exempted from rate limiting — admin workflows no longer blocked by rate limits
- **fix(#420):** Contact form now delivers to `ADMIN_EMAIL` with structured delivery logging — was silently sending to a hardcoded address

### Security

- **fix(#475):** nginx `X-Forwarded-For` header stripped at the proxy boundary to prevent IP spoofing; search query length capped at 200 chars
- **fix(#427):** Hand-rolled HTML sanitizer replaced with DOMPurify — eliminates entire class of XSS bypass risk
- **fix(#445):** Rate limit counters isolated per endpoint via `key_type` column — prevents one endpoint's burst from consuming another's quota
- **refactor+security(#453):** `next(err)` used in all DB-error catch blocks; rate limiting added to posts, travel, and account management routes

### Bug Fixes

- **fix(#465):** `ERR_ERL_INVALID_HITS` suppressed in test output
- **fix(#371):** Error alert cooldown persisted in DB across container restarts — was reset on every container cycle, allowing repeated alert storms
- **fix(#426):** CV download filename aligned to `Andy_Keys_CV.pdf`
- **fix(#424):** `isAdminSession()` removed from `config.js`
- **fix(#447):** Backup schedule check tightened to prevent false positives
- **fix(#425):** `JWT_EXPIRY` env var now wired through in `auth.js` — was ignored, causing tokens to use the hardcoded default
- **fix(#450):** `docker.sock` privilege escalation risk documented

### Refactoring

- **refactor(#438):** `admin/travel.js` split into focused sub-modules
- **refactor(#455):** `dc()` wrapper added; 37 raw `docker compose` invocations in deploy scripts replaced
- **refactor(#429):** `UPLOADS_DIR`, `wrapMulter`, `findUniqueSlug` extracted as shared backend utilities
- **refactor(#432):** `recordVisit()` extracted with admin-session guard
- **refactor(#430):** Lightbox extracted to `utils/lightbox.js` — shared across blog and travel pages
- **refactor(#431):** `createMessenger` factory extracted for admin modules
- **refactor:** Batch refactors closing #433, #434, #150, #376, #111, #158

### Ops / Docs

- **ops(#435):** Deprecated deploy files deleted; `|| true` on rollback fixed; `server-setup.sh` hardened
- **docs(#185):** Daily backup cron documented in `docs/BACKUP.md`; stale references corrected
- **docs(#379):** `docs/TECH_DEBT.md` added — full codebase tech debt audit

### Deployment Notes

- No breaking changes
- DB schema: `audit_log` table added (`CREATE TABLE IF NOT EXISTS` — safe on existing DB, no data at risk)
- No new required env vars

---

## Release 2026-05-31-3

**Released:** 2026-05-31
**Branch:** release/2026-05-31-3
**PR:** [#415](https://github.com/AndyRKeys/MyPortfolioSite/pull/415)
**Closes:** [#410](https://github.com/AndyRKeys/MyPortfolioSite/issues/410), [#413](https://github.com/AndyRKeys/MyPortfolioSite/issues/413)

### Summary

Second follow-up mini-release to 2026-05-31. Fixes the regression rate-limit reset on prod (the Docker bridge gateway IP was never being cleared, causing 429s in the no-auth baseline despite a reset running), wires `SERVICE_KEY` into `docker-compose.yml` so the service account exemption actually reaches the backend container, and reframes all "bypass" language to "service account exemption" to reflect the correct mental model (rate limiting applies to untrusted callers; authenticated service accounts are simply not in scope).

### Bug Fixes

- **fix(#410):** Regression rate-limit reset now detects the Docker bridge gateway IP (`172.20.x.x`) dynamically via `ip route show default` inside the container and includes it in the targeted DELETE. Previously loopback-only deletes missed the gateway IP that Docker NAT writes when curl connects via loopback, leaving stale counters that caused 429s in the no-auth baseline.
- **fix(#410):** `SERVICE_KEY` added to `docker-compose.yml` backend `environment:` block — it was set in `.env` but never passed through to the container, silently disabling the service account exemption on all Docker-deployed environments.

### Refactoring

- **refactor(#413):** `skipIfServiceKey` renamed to `exemptIfServiceAccount` across all routes, tests, and the regression script. Surrounding comments and log messages updated to reflect the correct model: rate limits protect against untrusted callers; authenticated service accounts are exempt by identity, not by circumventing a control.

### Deployment Notes

- No `.env` changes required — `SERVICE_KEY` was already added in the 2026-05-31-2 deployment.
- No DB schema changes. No new dependencies.

---

## Release 2026-05-31-2

**Released:** 2026-05-31
**Branch:** release/2026-05-31-2
**Closes:** [#406](https://github.com/AndyRKeys/MyPortfolioSite/issues/406)

### Summary

Mini-release following the 2026-05-31 prod rollback. The regression suite caused a false failure by hitting the contact form rate limit during the post-deploy smoke tests, triggering an automatic rollback. This release adds a service account key bypass to all rate limiters and redesigns the regression test order so rate-limit behaviour is tested deliberately (with a clean reset) rather than accidentally. All 2026-05-31 changes are included via the base branch.

### Bug Fixes

- **fix(#406):** `SERVICE_KEY` env var + `X-Service-Key` header bypass added to all four rate limiters (contact, email auth, passkey auth, debug) via shared `skipIfServiceKey()` utility. Regression tests auto-derive the key from the container and send it on baseline contact checks.

### Ops / Testing

- **ops(#406):** Rate-limit test section runs first in the regression suite (no service key, real limiter exercised), followed by a targeted reset that deletes only loopback/runner IP rows — real user counters are never cleared. Previously the reset cleared the entire `rate_limits` table.
- **ops(#406):** `RESOLVE_IP` extracted from `--resolve` so the targeted reset covers the LAN IP used by dev (not just `127.0.0.1`, which only applies to prod).

### Deployment Notes

- **Required:** add `SERVICE_KEY=$(openssl rand -hex 32)` to the prod `.env` before deploying — the regression script warns if it is missing but degrades gracefully.
- No DB schema changes. No new dependencies.

---

## Release 2026-05-31

**Released:** 2026-05-31
**Branch:** release/2026-05-31
**Closes:** [#244](https://github.com/AndyRKeys/MyPortfolioSite/issues/244), [#282](https://github.com/AndyRKeys/MyPortfolioSite/issues/282), [#283](https://github.com/AndyRKeys/MyPortfolioSite/issues/283), [#322](https://github.com/AndyRKeys/MyPortfolioSite/issues/322), [#346](https://github.com/AndyRKeys/MyPortfolioSite/issues/346), [#378](https://github.com/AndyRKeys/MyPortfolioSite/issues/378), [#385](https://github.com/AndyRKeys/MyPortfolioSite/issues/385), [#387](https://github.com/AndyRKeys/MyPortfolioSite/issues/387), [#390](https://github.com/AndyRKeys/MyPortfolioSite/issues/390), [#391](https://github.com/AndyRKeys/MyPortfolioSite/issues/391), [#399](https://github.com/AndyRKeys/MyPortfolioSite/issues/399)

### Summary

Frontend modernisation, admin UX, auth hardening, and deploy reliability release. Removes jQuery from all public pages (87KB, −1,575 lines), refactors the admin panel into dedicated sub-pages with responsive navigation, retires the POST /auth/setup endpoint in favour of magic-link bootstrapping, and adds JS runtime checks for all pages on every deploy. Also reduces public travel coordinate precision to ~1km for privacy, fixes stale JS after deploys, protects dev certs from branch-switch deletions, and corrects a regression-script bug that was rate-locking the admin IP after every deploy.

### Features

**Admin sub-pages with responsive subnav (#378)**

- Monolithic `admin/index.html` replaced with a dashboard and six dedicated sub-pages (posts, travel, deploy, CV, stats, notes/auth/passkeys)
- `admin-subnav.js` injects a shared responsive horizontal navigation bar across all admin pages
- Each page loads only its own JS module entry point — no unrelated code runs on load
- E2E test updated to navigate sub-pages; JS runtime check extended to cover all admin pages

**Puppeteer JS runtime check for all public pages (#390)**

- `test-public-pages.js` added to the deploy pipeline: loads `/`, `/blog/`, `/travel/`, `/login/`, `/setup/`, and dynamically discovered blog/travel post pages after every deploy
- Fails the deploy (warn-only) on any unhandled JS exception on public pages
- `test-admin-e2e.js` extended with `pageerror` tracking during CRUD interactions
- All Puppeteer API calls use browser-page fetch so `--ignore-certificate-errors` covers self-signed dev certs without Node-level overrides

**Travel coordinate privacy (#244)**

- Public endpoints `GET /travel` and `GET /travel/:id` now return coordinates rounded to 2 decimal places (~1km precision)
- Admin endpoints (`GET /travel/all`, `GET /travel/admin/:id`) retain full 6-decimal precision for editing
- Query-layer only via `TRAVEL_COLS_PUBLIC` constant — no schema changes

### Changed

**jQuery removed from all public pages (#385)**

- `script.js`, `blog.js`, `travel.js`, `travel-post.js`, and `utils/dom.js` migrated to vanilla DOM APIs
- `jquery-3.5.1.min.js` (87KB) removed from all public pages — no external JS dependency on the public site
- Net: −1,575 lines; no behaviour change
- Also adds hover lift to timeline cards and improves error logging in blog/travel catch handlers

**Auth setup endpoint retired (#282, #283)**

- `POST /auth/setup` returns 410 Gone; account creation now happens automatically on the first magic-link send via the existing upsert in `POST /api/auth/email/send`
- `setup/index.html` replaces the account-creation form with a redirect to `/login/`
- Deleting the last passkey now shows a warning that magic-link sign-in remains available

### Bug Fixes

- **fix(#391, #346, PR #395):** Three deploy-hygiene fixes: (1) `Cache-Control: no-cache` added for `*.js` in all nginx templates — browsers revalidate JS after every deploy, eliminating stale-module bugs; (2) `scripts/config/certs/` gitignored so `git clean -fd` during branch switches no longer deletes dev certs; (3) leading `~/` in `BACKUP_DIR` now expanded to `$HOME/` in `load_env`, preventing a literal `~/` directory from being created inside the repo
- **fix(#387, PR #388):** Rate-limit reset and JWT generation in the regression test script were silently failing because `node -e` inline scripts were missing `--input-type=module`; rate-limit counters now clear correctly after the smoke suite, preventing admin IP lockout after every deploy
- **fix(#399, PR #400):** Overflow cards (`.projects-grid`, `.ai-dev-points`, `.github-repos-grid`) converted from auto-fit grid to flexbox with `justify-content: center`; consistent hover lift added to `.skill-category`, `.ai-point`, and `.cert-card`
- **fix(#322, PR #401):** `.projects-grid` constrained with `width: 100%` and `padding: 0 1rem` to prevent horizontal overflow inside the column-flex container at narrow viewports

### Breaking Changes / Deployment Notes

- `POST /api/auth/setup` is removed and returns 410 Gone; admin bootstrap now goes through `POST /api/auth/email/send` followed by the magic-link flow at `/login/`
- No DB schema changes required

---

## Release 2026-05-26

**Released:** 2026-05-26
**Branch:** release/2026-05-26
**PR:** #376
**Closes:** [#132](https://github.com/AndyRKeys/MyPortfolioSite/issues/132), [#175](https://github.com/AndyRKeys/MyPortfolioSite/issues/175), [#176](https://github.com/AndyRKeys/MyPortfolioSite/issues/176)

### Summary

Admin panel refactoring release. Deconstructs the 1,173-line `admin.js` monolith into eight focused ES modules, removes jQuery from the admin panel entirely, unifies the travel date field naming throughout the stack, and adds a full CRUD E2E test suite wired into the deploy pipeline as a hard-fail phase.

### Changed

**Admin JS modularised (#175)**

- 1,173-line `admin.js` split into per-feature ES modules under `resources/js/admin/`: `posts.js`, `travel.js`, `deploy.js`, `cv.js`, `auth.js`, `passkeys.js`, `stats.js`, `notes.js`
- `admin.js` is now a thin entry point (~20 lines) that imports and initialises each module
- Agents and maintainers can now target individual modules rather than reasoning about the full monolith

**jQuery removed from admin panel (#176)**

- All admin JS migrated to vanilla DOM APIs and `fetch`
- No behaviour change; eliminates the jQuery/vanilla ambiguity in the admin codebase

**Travel date field unified (#132)**

- `visit_date`/`visitDate` alias removed from `TRAVEL_COLS`
- Field is now consistently `post_date` throughout: backend routes, middleware schemas, frontend JS, utils, and tests

### Added

**Admin CRUD E2E test suite (#175)**

- `test-admin-e2e.js` — Puppeteer script covering authenticated blog create/delete, travel create/delete, and deploy panel smoke
- Wired into `deploy.sh` as a hard-fail phase (triggers rollback on assertion failure)
- Test records prefixed `[E2E]` cleaned up at start and end of each run
- Console error check resets between unauthenticated first load and authenticated reload to avoid false failures

---

## Release 2026-05-25

**Released:** 2026-05-25
**Branch:** release/2026-05-25
**Closes:** [#266](https://github.com/AndyRKeys/MyPortfolioSite/issues/266), [#267](https://github.com/AndyRKeys/MyPortfolioSite/issues/267), [#300](https://github.com/AndyRKeys/MyPortfolioSite/issues/300), [#307](https://github.com/AndyRKeys/MyPortfolioSite/issues/307), [#321](https://github.com/AndyRKeys/MyPortfolioSite/issues/321), [#333](https://github.com/AndyRKeys/MyPortfolioSite/issues/333), [#334](https://github.com/AndyRKeys/MyPortfolioSite/issues/334), [#335](https://github.com/AndyRKeys/MyPortfolioSite/issues/335), [#336](https://github.com/AndyRKeys/MyPortfolioSite/issues/336), [#337](https://github.com/AndyRKeys/MyPortfolioSite/issues/337), [#339](https://github.com/AndyRKeys/MyPortfolioSite/issues/339), [#341](https://github.com/AndyRKeys/MyPortfolioSite/issues/341), [#342](https://github.com/AndyRKeys/MyPortfolioSite/issues/342), [#351](https://github.com/AndyRKeys/MyPortfolioSite/issues/351), [#352](https://github.com/AndyRKeys/MyPortfolioSite/issues/352), [#356](https://github.com/AndyRKeys/MyPortfolioSite/issues/356), [#357](https://github.com/AndyRKeys/MyPortfolioSite/issues/357), [#358](https://github.com/AndyRKeys/MyPortfolioSite/issues/358), [#360](https://github.com/AndyRKeys/MyPortfolioSite/issues/360), [#366](https://github.com/AndyRKeys/MyPortfolioSite/issues/366)

### Summary

Observability and deploy-hardening release. Adds a frontend error logger with alert emails, automated CSP scanning on every deploy, backend startup env validation, and unified bash deploy scripts with normalised test reporting. Fixes travel card 404s caused by relative `media_url` paths, browser-extension noise polluting the error table, and a CORS smoke check that wrote live DB entries on every deploy.

### Features

**Frontend error logger (#333, #334, #336)**

- feat(#333): `error-logger.js` captures uncaught JS errors, resource-load failures, unhandled promise rejections, CSP violations, and `console.error`/`console.warn` calls; reports to `POST /api/debug/errors`, persisted to `client_errors` table, surfaced in admin stats panel
- feat(#333): admin alert email when 20+ frontend errors arrive within 15 minutes (`ERROR_ALERT_THRESHOLD` / `ERROR_ALERT_WINDOW_MS`); in-memory cooldown prevents repeated emails during sustained storms
- feat(#334): failed error sends buffered in `localStorage` and flushed on next page load — delivery resilient across page navigations
- feat(#336): request-ID correlation — `X-Request-Id` links every frontend error report to the exact backend log line for the same page view

**Backend startup env validation (#357)**

- feat(#357): `backend/utils/validateEnv.js` asserts every required env var at startup via `validateEnvOrExit()`; logs each missing var and exits 1, triggering deploy rollback instead of serving traffic with broken config
- feat(#357): CORS smoke check added to regression suite — `GET /api/health` with `Origin: https://<SITE_HOST>` must succeed; catches the case where `SITE_HOST` is absent in the container

**CSP scanning on every deploy (#341, #342)**

- feat(#341): `test-csp-violations.js` loads all served pages (`/`, `/blog/`, `/travel/`, `/login/`, `/admin/`, `/setup/`) in Puppeteer after each deploy, flags any `securitypolicyviolation` event; warn-only with machine-parseable `[csp-violations]` summary line in the deploy report
- feat(#342): `test-admin-e2e-csp.js` mints a JWT, injects it into `localStorage.adminToken`, loads `/admin/`, and drives Nominatim geocode interactions — catches auth-path CSP breaks like the original #330 incident

**Dev hostname redirect (#358)**

- feat(#358): `dev.andykeys.me:443` now redirects to `dev.andykeys.me:3001` via a prod-nginx `server` block, eliminating the port-confusion support burden

**Vitest coverage (#335)**

- feat(#335): upload, cv, and debug route test coverage — auth gating, MIME filtering, size limits, private-info scan warnings, error ingestion/persistence, pagination, sanitisation; posts tests extended with INSERT (201), PUT 404, and DELETE flows
- fix(#335): `cv.js` `MulterError` now correctly returns 400 (was 500) via multer callback pattern

**Unified deploy scripts (#300)**

- feat(#300): `dev-deploy.sh` and `prod-deploy.sh` merged into `deploy.sh --env dev|prod`; env-specific behaviour gated by feature flags; PowerShell wrappers updated to match

**Project structure reorg (#307)**

- feat(#307): HTML pages moved into feature subfolders (`blog/`, `travel/`, `admin/`, `login/`, `setup/`) for clean URLs; `resources/java/` renamed to `resources/js/`; all internal links and magic-link email URL updated; Nginx `try_files` handles directory routing with no config changes

### Bug Fixes

- fix(#266, #267): `buildPublicTravelCard` and `buildPostCard` in `resources/js/utils/dom.js` now normalise any bare relative `media_url` by prepending `/`, preventing a 404 at `/travel/resources/img/placeholder-transparent.png` (resolved relative to the travel page path) that error-logger captured on every travel page load
- fix(#356): browser-extension errors (`chrome-extension://`, `moz-extension://`, `safari-extension://`) filtered before reaching `/api/debug/errors`; deploy-time Puppeteer tests intercept and mock `POST /api/debug/errors` so headless-Chromium noise (`Couldn't load fs/zlib`) never writes to `client_errors` or triggers false alert emails
- fix(#360): `POST /api/debug/csp-violations` handler made `async` for CodeQL rate-limit pattern recognition
- fix(#351): deploy script exits with a clear error if run as `sudo`, preventing file ownership corruption in the repo directory
- fix(#352): deploy creates the backup directory, installs the cron job, and takes an initial DB dump on first provision if none exists

### Security

- security(#337): `Reporting-Endpoints` header and CSP `report-to` directive added alongside deprecated `report-uri` — both present during transition
- security(#337): debug endpoint rate limiting migrated to DB-backed `createRateLimiter`, consistent with auth/contact limiters and surviving container restarts
- security(#321): `qs` dependency bumped — resolves upstream prototype-pollution advisory
- docs(#339): CSP maintenance is now a standing dev-cycle rule — any PR adding/moving an external resource must update `scripts/config/nginx-security-headers.conf` in the same PR; documented in `docs/AI.md`, `CLAUDE.md`, and the PR template checklist

### Deploy Test Reporting (#366)

All five deploy test phases now emit consistent `suite= tests= passed= failed=` counts in the deploy report:

- **vitest** — counts read from json reporter output file (immune to text-summary format drift)
- **error-logger** — Puppeteer page-load checks for `[error-logger] Initializing`
- **error-logger-contracts** — API contract checks for `POST /api/debug/errors` and `GET /api/debug/errors`
- **csp-violations** — browser CSP scan across all public pages
- **regression** — server-side curl smoke suite

DEPLOY COMPLETE banner moved to after the report box so the structured report is the final machine-readable output.

### Documentation

- `docs/INFRASTRUCTURE.md` — server health monitoring section updated to reflect Glances integration is live but HA dashboard/alerting configuration is pending (#370)
- `docs/TESTING.md` — Puppeteer scripts table updated; rule added that new page-loading scripts must intercept and mock `/api/debug/errors` before `page.goto()`; CORS smoke check references `GET /api/health`

### Breaking Changes / Deployment Notes

- `ERROR_ALERT_THRESHOLD` and `ERROR_ALERT_WINDOW_MS` env vars are optional (defaults: 20 errors / 15 min); add to `.env` only to tune
- `deploy.sh --env dev|prod` replaces `dev-deploy.sh` / `prod-deploy.sh`; PowerShell wrappers call the new script automatically
- Clean URL paths for feature subfolders (`/blog/`, `/travel/`, `/admin/`, `/login/`, `/setup/`) require Nginx `try_files` — no Nginx config change needed as existing templates already handle this
- No DB schema changes required

---

## Release 2026-05-11 — Docker CE Migration

**Released:** 2026-05-11
**Branch:** release/2026-05-11
**Closes:** [#221](https://github.com/AndyRKeys/MyPortfolioSite/issues/221), [#213](https://github.com/AndyRKeys/MyPortfolioSite/issues/213)

### Summary

Migrates both the dev and prod servers from snap-based Docker to Docker CE (apt), eliminating the AppArmor `permission denied` errors that caused repeated deploy failures. Aligns the prod deploy script with the dev deploy script via a new shared library, and restructures the infrastructure docs into per-environment files.

### Scripts

- **`scripts/setup/migrate-from-snap-docker.sh`** — guided interactive migration: inventory, env backup, stop stacks, stop snap daemon, install Docker CE, add user to docker group, recreate stacks, optionally remove snap
- **`scripts/setup/docker-migration-inventory.sh`** — non-destructive host inspection; logs snap vs apt Docker, data dirs, conflicting services, port usage
- **`scripts/setup/docker-env-discovery.sh`** — locates dev/prod project roots and `.env` files
- **`scripts/setup/docker-env-backup.sh`** — backs up and restores dev/prod `.env` files to `~/docker-migration-backup/<timestamp>/`
- **`scripts/setup/docker-migration-checklist.sh`** — captures Docker volume/network/container state before migration
- **`scripts/deploy/deploy-lib.sh`** — new shared library used by both `dev-deploy.sh` and `prod-deploy.sh`; provides coloured logging, prerequisite checks, `.env` validation (placeholder detection, length checks), `compose_up_with_rollback`, and `wait_for_health`
- **`scripts/deploy/dev-deploy.sh`** + **`dev-deploy.ps1`** — rewritten to use `deploy-lib.sh`; replaces old `dev-server-deploy.sh`
- **`scripts/deploy/prod-deploy.sh`** — rewritten to use `deploy-lib.sh`; now matches dev deploy in terms of env validation, structured phase logging, and automatic rollback

### Documentation

- **`docs/INFRASTRUCTURE.md`** — slimmed down to host-level concerns only (hardware, Dropbear disk unlock, shared backup strategy, generic troubleshooting); points to per-environment docs
- **`docs/DEV_ENVIRONMENT.md`** *(new)* — dev environment setup, compose file, ports, env vars, deploy entry points, useful commands, troubleshooting
- **`docs/PROD_ENVIRONMENT.md`** *(new)* — production environment setup, compose file, SSL, env vars, deploy entry points, operational commands
- **`docs/DOCKER_MIGRATION.md`** *(new)* — explains the snap vs apt situation, migration script walkthrough, recommended 7-step sequence, and post-migration checks
- **`docs/DEV_SERVER_SETUP.md`** — updated to reflect HTTP-only dev environment (no self-signed cert); references new `DOCKER_MIGRATION.md`

### Migration performed on live server

On 2026-05-11, `ak-home-server` was migrated from snap Docker to Docker CE:

1. Ran `migrate-from-snap-docker.sh` — inventoried host, backed up `.env` files, stopped both stacks, stopped `snap.docker.dockerd`
2. Docker CE 29.4.3 confirmed installed via apt; daemon started via `systemctl start/restart docker.socket docker`
3. Prod stack brought up: `docker compose -f docker-compose.prod.yml up -d --build` ✓
4. Dev stack brought up: `docker compose -f docker-compose.dev-server.yml up -d --build` ✓
5. Both stacks confirmed healthy via `docker ps` and `curl` health checks
6. Duplicate Docker apt source removed; `sudo snap remove --purge docker` completed

| Stack | Health check | Result |
|---|---|---|
| Prod | `curl http://localhost/health` | 301 → HTTPS (expected) ✓ |
| Dev | `curl http://localhost:3001/health` | Security headers returned ✓ |

### Breaking Changes / Deployment Notes

- Deploy scripts renamed: `dev-server-deploy.sh` → `dev-deploy.sh`, `dev-server-deploy.ps1` → `dev-deploy.ps1`
- Docker via snap is no longer supported on this project; use Docker CE (apt) only
- No application code changes; no DB migration required

---

## Release 2026-06-10

**Released:** 2026-06-10  
**Branch:** release/2026-06-10  
**PR:** #206  
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
