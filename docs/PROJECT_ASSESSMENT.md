# Project Assessment

_Last updated: 2026-05-27_

This document is a frank self-assessment of the current state of MyPortfolioSite — what is working well, what is fragile, where technical debt lives, and what would benefit most from attention. It is written to be honest rather than flattering.

**Audience:** The owner and any AI agent working on the project. Treat this as a baseline for understanding what is robust versus what is risky to touch.

**This document is not a roadmap.** For planned improvements, see `ROADMAP.md`. This document describes what exists today.

---

## 1. Architecture & design

### Strengths

- **The stack is appropriate for the problem.** Node/Express + PostgreSQL + Nginx is well-understood, well-documented, and a good fit for a personal portfolio site. There is no over-engineering here.
- **Clear frontend/backend boundary.** Nginx routes `/api/*` to the backend and serves everything else as static files. This is clean and easy to reason about.
- **No build step.** Vanilla JS/HTML/CSS with ES modules means the frontend is immediately readable and debuggable without tooling knowledge. This is a genuine advantage for an AI-assisted workflow.
- **Docker for local dev is well set up.** The `dev-local.ps1` wrapper and `docker-compose.yml` make onboarding straightforward. The backend container, PostgreSQL, and Nginx all come up together.
- **Graceful shutdown handling.** The backend listens for `SIGTERM` and waits up to 10 seconds for in-flight connections to drain before exiting. This prevents request drops during rolling restarts and Docker stop cycles.
- **Non-blocking startup preflight checks.** DB connectivity and Outlook OAuth2 token validity are verified at startup; missing env vars cause an immediate exit with a clear message (`validateEnvOrExit()`), so broken config fails fast rather than silently serving broken traffic.

### Weaknesses and risks

- **Single-node, single-point-of-failure production.** Everything runs on one Ubuntu Server (`ak-home-server`). There is no redundancy, no failover, and no easy rollback if a deploy breaks the server. A bad deploy to `main` means the site is down until manually fixed over SSH.
- **Production is containerised (migration complete).** Both dev and prod now run on Docker Compose, closing the structural dev/prod gap that previously caused "works locally, breaks in prod" risk. The original Raspberry Pi + PM2 setup has been retired (#165/#171/#179); residual risk is now operational (script-driven deploys — see ROADMAP §3.5) rather than architectural.
- **Database backups are local-only with no offsite redundancy.** `scripts/backup/db-backup.sh` runs via cron at 02:00 daily, creating a gzip'd `pg_dump` with 7-day rotation. But all backups live on the same disk as the database — a disk failure or host loss still means permanent data loss. Offsite sync via rclone is supported but not configured.
- **Uploads are stored on the server filesystem.** User-uploaded images (`/uploads`) live directly on the server with no backup, no CDN, and no size/type validation beyond what multer provides. This is fine for now but will become a problem as content grows.
- ✅ **Staging environment now live.** A dev stack runs permanently on `ak-home-server` at `dev.andykeys.me:3001` (LAN-only, self-signed TLS). The `dev` branch is deployed there after every merge, giving real-hardware, real-auth testing before anything reaches `main`. (Dual-env implementation #151/#159 shipped ~Release 2026-05-18.)
- **The schema has no migration versioning.** Re-running `schema.sql` is safe but there is no record of what version the live database is at. As the schema grows, this becomes harder to manage without a tool like `node-postgres-migrate` or Flyway.

**Overall architecture rating: Amber.** Solid for a personal project at this stage. Staging environment and containerisation are resolved. The remaining real risk is the single-server setup with local-only backups — a disk failure is still a full data loss event.

---

## 2. Codebase health

### What is in good shape

- **Backend routes are well separated.** `auth.js`, `posts.js`, `travel.js`, `contact.js`, `deploy.js`, `upload.js`, `cv.js`, `stats.js` — each route has a single clear responsibility. This is the right pattern.
- **Parameterised queries throughout.** SQL injection risk is well managed. No string concatenation in queries found in recent audits.
- **Shared frontend utilities exist.** `resources/js/utils/` contains `escapeHtml()`, `formatVisitDate()`, and similar helpers. These exist because technical debt was explicitly paid down in earlier sessions (PR #85). This is good practice.
- **ES modules on the frontend.** The codebase has been migrated to ES modules, which means imports are explicit and dependencies are traceable.
- **`docs/` is unusually complete for a personal project.** 24 markdown files covering architecture, security, database schema, infrastructure, testing, deployment lessons, logging, style, AI onboarding, terminology, runbook, and release notes. Most solo projects have none of these. This is a genuine Green-rated project strength.

### Where it is less healthy

- **`admin/index.html` JS is now modularised (#175).** The admin panel JS has been split into per-feature modules under `resources/js/admin/` (`posts.js`, `travel.js`, `deploy.js`, `cv.js`, `auth.js`, `passkeys.js`, `stats.js`, `notes.js`). `admin.js` is now a thin entry point. `admin/travel.js` remains the largest module (495 lines) and warrants care when modifying.
- **`index.html` is also large (23KB).** The main page has grown by accretion. Some of this is unavoidable (it is a portfolio page with many sections), but it is worth periodically reviewing whether JavaScript logic belongs in a separate module.
- **jQuery fully removed (#176, #385).** All JS is now vanilla DOM APIs and `fetch`. Admin panel migrated in Release 2026-05-26 (#176); public pages (`script.js`, `blog.js`, `travel.js`, `travel-post.js`, `utils/dom.js`) migrated in #385. No jQuery/vanilla coexistence friction remains.
- **`backend/routes/auth.js` is the most complex file at 12KB.** WebAuthn + JWT + magic links in one file is a lot of state to hold. It works correctly and is tested, but it is the highest-risk file to modify. Agents should treat it with extra caution and read it fully before any changes.
- **Frontend test coverage is essentially zero.** The Vitest suite covers backend utilities and some API routes, but there are no frontend tests at all. UI regressions are caught manually via smoke test scripts (`Test-PRN.ps1`), which is better than nothing, but fragile for a codebase growing in complexity. Adding frontend tests (e.g., Playwright) would help but requires a significant architectural decision — no build step means test infrastructure needs careful thought.
- **`test-results/` is committed to the repo.** Test output artefacts should not be in version control. This is minor but messy.

**Overall codebase health rating: Amber-Green.** Better than most personal projects of this age; the known debt is identified and tracked, which is more important than having zero debt.

---

## 3. Developer experience

### What works well

- **The Docker dev workflow is solid.** `dev-local.ps1 up` starts everything; `test` runs the suite inside the container; `reset` gives a clean slate. This is genuinely good.
- **Branching and PR discipline is high.** The three-tier model (`main` / `dev` / `feature|fix/*`) with per-issue branches is rigorous. Most personal projects have no process at all. This one has a well-documented, consistently followed workflow.
- **AI onboarding prompt in README is a real differentiator.** Having a structured "read these docs in order, then orient, then wait for a task" prompt means agents start each session with the right context. This is not common and makes agent-assisted development meaningfully more reliable.
- **PowerShell-first tooling is consistent.** All developer-facing commands and examples are in PowerShell. There is no confusion about which shell to use.

### Pain points

- **The deploy pipeline is comprehensive but complex.** `deploy.sh` (20KB) + `deploy-lib.sh` (2,000+ lines) is a significant bash codebase. It handles sudo guards, dry-run, rollback, structured output, secret redaction, and seven test phases — all correct behaviour, but maintaining this is a real burden. Bash string handling at this scale is brittle to edge cases.
- **The admin panel has grown without a clear UX model.** It handles blog posts, travel posts, CV upload, deploy triggers, and stats in one page. Functionally fine for one user; navigating it is increasingly "just knowing where things are" rather than following an obvious structure.
- **Agent context resets every session.** Each new Claude session must re-read all the docs from scratch. The onboarding prompt handles this well, but long sessions where the context fills up risk agents losing track of earlier decisions. Devlogs (Issues linked in earlier sessions) help mitigate this but require discipline to maintain.

**Overall DX rating: Amber-Green.** The process is good; the operational tooling around it (health checks, deploy feedback, SSH reliability) needs polish.

---

## 4. Reliability, observability & performance

### Reliability

- **Docker Compose provides process supervision.** Since the migration off PM2 (#165/#171/#179), the backend runs under Docker with a restart policy — if the container exits, Docker restarts it. This is the minimum viable reliability for a personal site and is now consistent between dev and prod.
- **Nginx handles static files independently.** The Nginx container serves static pages even if the backend container is down. In practice, most pages rely on API calls, so this is limited comfort.
- **No automated SSL renewal monitoring.** Let's Encrypt auto-renews via a systemd timer, but there is no alert if renewal silently fails. The first sign of a problem would be a browser HTTPS warning — not ideal.
- **Basic host monitoring via cron.** `scripts/monitoring/monitor.sh` runs every 5 minutes via cron: tracks CPU/memory/disk/swap, logs to `~/logs/monitor.log`, and applies graduated responses at thresholds (drop caches, restart app/postgres/nginx). This is better than nothing, but it is local-only — no external alert or dashboard; you only know there's a problem if you SSH in and read the log.

### Observability

- **Structured logging in place; rotation/centralisation still open.** The backend logs through `pino` + `pino-http` (#153): severity levels, per-request context, `LOG_LEVEL`, and secret redaction. Log rotation is configured via Docker's `json-file` driver. What remains is centralisation — production diagnosis still requires SSH + tailing container logs; no aggregated view yet. (Remaining work: ROADMAP §4.2.)
- **No metrics.** There is no tracking of request counts, error rates, response times, or API usage. The `stats.js` route exists but its scope is limited.
- **The admin deploy console is the nearest thing to an ops dashboard.** This is a good foundation but it currently only shows deploy output, not runtime health.

### Performance

- **Performance is not a concern, and the previous resource ceiling is gone.** The migration from the Raspberry Pi to the Ubuntu Server (`ak-home-server`) removed the constrained-hardware worry that dominated earlier assessments. Traffic is low, the stack is efficient (Nginx serves static files directly, Node only handles API calls), PostgreSQL is not under load, and the server now has substantial CPU/RAM headroom relative to the workload. Resource exhaustion is no longer a realistic risk for current or foreseeable usage.
- **No image optimisation.** Uploaded images are stored and served at their original size. With ample server headroom this is no longer a performance risk, but it still wastes bandwidth and slows page loads for visitors as content grows — a UX concern rather than a capacity one.
- **No caching headers on static assets.** Nginx likely serves static files without long-lived cache headers, meaning repeat visitors re-download assets on every visit.

**Overall reliability/observability rating: Amber.** Structured logging, internal health checks, local daily backups, and a basic host monitor are all now in place. What remains: offsite backup redundancy (most critical gap), no external alerting, no log aggregation/viewer. For a personal site this is acceptable; for anything more important it would not be.

---

## 5. Security posture

### Strengths

- **WebAuthn/FIDO2 passkeys are a genuinely strong auth choice.** No password to phish or leak, no third-party auth dependency, hardware-bound credentials. This is better security than most production applications.
- **JWT is validated on every protected route.** No unprotected admin endpoints found in audits.
- **No third-party auth services.** No OAuth flow means no risk of a third-party breach compromising access.
- **Parameterised queries prevent SQL injection.** Verified consistently across all route files.
- **XSS mitigations are in place.** `escapeHtml()` is used in frontend rendering; this was shored up as part of PR #85.
- **Secret redaction in logs is comprehensive.** `deploy-lib.sh` and `pino` both redact a defined list of sensitive fields (auth headers, cookies, all `*token` and `*password` patterns) before writing to disk. Deliberate and reviewable.
- **`docs/SECURITY.md` exists and documents the threat model.** Having this written down means agents and the owner have a shared reference for what is and is not protected.

### Gaps

- **Rate limiting is in place on all sensitive endpoints.** Auth routes (magic-link send/verify, WebAuthn registration/auth start) and the contact form all have per-IP rate limiting via `backend/middleware/rateLimit.js` (#237, shipped Release 2026-05-18). Future AI Lab endpoints will need their own limits when added.
- **The deploy endpoint (`/api/deploy`) is high-value and must remain tightly protected.** A compromise of the JWT that gates this route would give an attacker the ability to trigger deploys. This endpoint should be audited specifically as part of any security review.
- **CSP and security headers are in place.** `nginx-security-headers.conf` sets Content-Security-Policy, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, and HSTS. The CSP `connect-src` was extended to include `nominatim.openstreetmap.org` for geocoding (#234). Continued hardening may be needed as new endpoints are added.
- **Uploaded files are served from the same origin.** If a malicious file were uploaded (e.g., an SVG with embedded script), it could be served directly. Input validation on uploads should be reviewed.
- **The server itself is the weakest link.** It is a home-hosted machine (`ak-home-server`) with a dynamic IP. Physical access, disk health, and home network security are all outside the application's control but affect the overall security posture.
- **AI Lab will add new attack surface.** Once implemented, the AI Lab introduces API keys for Perplexity and Anthropic, prompt injection risk, and potential for resource abuse. The auth-token gating planned in Issue #15 is necessary but not sufficient — the Lab endpoints will need their own threat model.

**Overall security rating: Amber-Green.** Auth is solid, CSP/security headers are in place, rate limiting covers all auth endpoints. Remaining gaps: no scoped service-account JWTs for internal services (#275), passkey re-registration UX (#283), uploaded file serving from the same origin. AI Lab will require a dedicated security review before launch.

---

## 6. AI & agent readiness

This is an unusual section for a project assessment, but it is directly relevant given the workflow.

### What works well for agents

- **Documentation depth is high.** `AI.md`, `STYLE_GUIDE.md`, `TESTING.md`, `DATABASE.md`, `SECURITY.md`, and `DEPENDENCIES.md` together give an agent enough context to work without constantly asking questions. This is the project's biggest DX asset.
- **Branching model is explicit and enforced.** Agents are unlikely to accidentally commit to `dev` or `main` because the rules are clearly stated and the PR-only workflow is consistent.
- **Test suite gives agents a safety net.** Vitest + smoke test scripts mean an agent can make a change and have a concrete way to verify it did not break anything.
- **The onboarding prompt works well in practice.** Sessions that start with the full doc-reading process produce noticeably better results than those that do not.

### Where agent friction exists

- ✅ **Architecture diagram now exists.** `docs/ARCHITECTURE.md` was added in the project structure reorg (#308). It covers the Nginx → Node → PostgreSQL flow, the file tree, request lifecycle, ADR trade-offs, and critical code paths. Keep it current when the structure changes meaningfully.
- **Admin JS is now modularised (#175 — shipped).** `resources/js/admin/` contains per-feature modules (`posts.js`, `travel.js`, `deploy.js`, etc.) with `admin.js` as a thin entry point. Agents can now target the correct module directly rather than reading an 18KB monolith. This was a significant friction point; it is now substantially resolved.
- **Implicit server-specific knowledge.** Several operational facts (Compose service names, where Nginx config files live on the server, how `ddclient` is configured, where the Let's Encrypt certs are) were previously undocumented. This is now captured in `docs/INFRASTRUCTURE.md` and `docs/TERMINOLOGY.md`; keep them current so agents can diagnose production issues without asking the owner for facts.
- **Context window pressure in long sessions.** The doc suite is thorough but also long. In extended sessions, earlier context (especially specific file contents read at the start) can be lost. This is a fundamental LLM constraint, not a fixable problem, but it means breaking work into smaller issues (which the project already does well) is especially important here.
- **No structured way for agents to flag "I am not sure about this."** When an agent is uncertain, it either proceeds (risky) or asks (slows things down). A convention like "if in doubt, raise a GitHub issue with the `needs-decision` label and stop" would help, but this is aspirational rather than current practice.

**Overall AI-readiness rating: Amber-Green → Green.** The admin JS modularisation (#175), `docs/ARCHITECTURE.md` (#308), and full jQuery removal (#385) have cleared the three biggest practical friction points. Remaining friction: context window pressure in long sessions (fundamental LLM constraint). The codebase is now fully consistent vanilla ES modules throughout.

---

## 7. Top improvement opportunities

These are ordered by impact-to-effort ratio, considering both operational risk and agent friction.

**Resolved (no longer blocking):**

1. ✅ **Done — `docs/INFRASTRUCTURE.md` written** (Compose service names, Nginx config paths, cert locations, ddclient config and other server-specific facts). Now complemented by `docs/TERMINOLOGY.md`. Keep both current.
2. ✅ **Done — production containerised** (migrated off the Raspberry Pi to Ubuntu Server, Docker Compose; #165/#171/#179). Dev and prod environments are now aligned.
3. ✅ **Done — `/health` endpoint** (internal-only; #279, Release 2026-05-18).
4. ✅ **Done — CSP and security headers** (`nginx-security-headers.conf`; #210/#211, Release 2026-05-18).
5. ✅ **Done — staging environment live** (`dev.andykeys.me:3001`, LAN-only; #151/#159).

**Still outstanding (in priority order):**

1. **Offsite database backups** — Local daily `pg_dump` cron exists, but all backups live on the same disk as the data. A disk failure or host loss loses everything. Configure rclone offsite sync and add restore verification. This is the single most important remaining operational risk. Tracked in ROADMAP §4.5.

2. **Uploaded files served from same origin** — A malicious SVG upload could execute script in the browser. Consider serving uploads from a separate origin or enforcing a `Content-Security-Policy` sandbox on the uploads path.

3. ✅ **Done — jQuery fully removed (#385).** `script.js`, `blog.js`, `travel.js`, `travel-post.js`, and `utils/dom.js` migrated to vanilla DOM APIs. No jQuery remains anywhere in the codebase.

4. **Frontend test coverage** — Zero frontend unit or integration tests. UI regressions are caught by manual smoke test scripts only. Adding Playwright E2E for the core public flows (blog list, travel list, login) would close the most important gap without requiring a build step.

---

## 8. Update discipline

This document should be updated when:

- The architecture changes meaningfully (e.g. a major hosting change, introducing a new major component).
- A significant area of technical debt is resolved (mark it as addressed, update the rating).
- A new risk is identified that is not captured here.

It should **not** be updated for every PR or minor fix. It is a baseline snapshot, not a changelog. The roadmap (`ROADMAP.md`) and release notes (`docs/RELEASE_NOTES.md`) cover incremental progress.

---

## 9. Change log

- **2026-05-27 (updated)** — jQuery fully removed (#385): §1 jQuery note updated to "fully removed", §6 AI-readiness rating upgraded to Green, §7 opportunity #3 marked done. README, AI.md, ARCHITECTURE.md updated to remove jQuery references.
- **2026-05-27** — Full codebase reassessment (read architecture, routes, deploy scripts, tests, security config, backups, monitoring). §1: staging resolved; backup description corrected (local daily cron exists, offsite missing); graceful shutdown + env preflight noted as strengths. §2: docs rated Green explicitly. §3: deploy pipeline complexity noted as a DX pain point. §4: host monitor.sh documented; backup status corrected; overall rating updated. §5: secret redaction noted as a strength; uploaded-file risk called out specifically. §7: improvement opportunities reordered with offsite backups as #1. Earlier: staging environment marked resolved; jQuery note scoped to non-admin; ARCHITECTURE.md friction point resolved.
- **2026-05-26** — Admin JS modularisation (#175) shipped. Updated §2 codebase health (admin monolith resolved), §6 agent friction (admin friction substantially resolved), AI-readiness rating upgraded Amber → Amber-Green. High-risk table updated to reflect modular structure.
- **2026-05-19** — Post Release 2026-05-18 audit. Marked as resolved: health endpoint (#279), structured logging (#153), rate limiting on auth endpoints (#237), CSP/security headers (#210/#211), deploy output/verification (#276/#263), WebAuthn registration guard (#274), Outlook OAuth2 email (#241). Updated §4 (reliability/observability) rating from Red-Amber to Amber. Updated §5 (security) rating from Amber to Amber-Green. §3 pain points revised to reflect deploy improvements. §7 improvement opportunities #3 and #4 marked complete.
- **2026-05-16** — Post-migration reassessment. Corrected statements that the earlier terminology pass left factually stale: §4 now describes Docker Compose (not PM2) as the process supervisor, consistent with the completed migration; the performance subsection now reflects that the Raspberry Pi resource ceiling is gone and the Ubuntu Server has substantial headroom, downgrading image-optimisation from a capacity risk to a UX/bandwidth concern. Removed the "SSH from Windows is not frictionless" DX pain point — key auth has stabilised and is now reliable.
- **2026-05-07 (updated)** — Refined AI-readiness rating from Green-Amber to Amber based on real-world friction observed in agent sessions. Elevated priority of infrastructure docs and clarified frontend testing constraints. Updated improvement opportunities ordering to reflect agent friction alongside operational risk.
- **2026-05-07** — Initial assessment written based on `dev` branch state, covering architecture, codebase health, DX, reliability, security, and AI readiness.
