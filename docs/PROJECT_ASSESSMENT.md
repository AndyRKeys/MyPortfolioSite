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
- **Idempotent schema migrations.** Using `IF NOT EXISTS` throughout `backend/db/schema.sql` means re-running the schema does not destroy data. This is the right approach for a project without a proper migration tool.

### Weaknesses and risks

- **Single-node, single-point-of-failure production.** Everything runs on one Ubuntu Server (`ak-home-server`). There is no redundancy, no failover, and no easy rollback if a deploy breaks the server. A bad deploy to `main` means the site is down until manually fixed over SSH.
- **Production is containerised (migration complete).** Both dev and prod now run on Docker Compose, closing the structural dev/prod gap that previously caused "works locally, breaks in prod" risk. The original Raspberry Pi + PM2 setup has been retired (#165/#171/#179); residual risk is now operational (script-driven deploys — see ROADMAP §3.5) rather than architectural.
- **No database backups.** There is no automated backup of the PostgreSQL data on the server. If the disk dies or the server is lost, all blog posts, travel entries, and user data are gone permanently.
- **Uploads are stored on the server filesystem.** User-uploaded images (`/uploads`) live directly on the server with no backup, no CDN, and no size/type validation beyond what multer provides. This is fine for now but will become a problem as content grows.
- ✅ **Staging environment now live.** A dev stack runs permanently on `ak-home-server` at `dev.andykeys.me:3001` (LAN-only, self-signed TLS). The `dev` branch is deployed there after every merge, giving real-hardware, real-auth testing before anything reaches `main`. (Dual-env implementation #151/#159 shipped ~Release 2026-05-18.)
- **The schema has no migration versioning.** Re-running `schema.sql` is safe but there is no record of what version the live database is at. As the schema grows, this becomes harder to manage without a tool like `node-postgres-migrate` or Flyway.

**Overall architecture rating: Amber.** Solid for a personal project at this stage; the single-server + no-backup + no-staging combination is the biggest real risk.

---

## 2. Codebase health

### What is in good shape

- **Backend routes are well separated.** `auth.js`, `posts.js`, `travel.js`, `contact.js`, `deploy.js`, `upload.js`, `cv.js`, `stats.js` — each route has a single clear responsibility. This is the right pattern.
- **Parameterised queries throughout.** SQL injection risk is well managed. No string concatenation in queries found in recent audits.
- **Shared frontend utilities exist.** `resources/js/utils/` contains `escapeHtml()`, `formatVisitDate()`, and similar helpers. These exist because technical debt was explicitly paid down in earlier sessions (PR #85). This is good practice.
- **ES modules on the frontend.** The codebase has been migrated to ES modules, which means imports are explicit and dependencies are traceable.
- **`docs/` is unusually complete for a personal project.** Having `AI.md`, `STYLE_GUIDE.md`, `TESTING.md`, `DATABASE.md`, `SECURITY.md`, and `DEPENDENCIES.md` all present is genuinely above average. Most solo projects have none of these.

### Where it is less healthy

- **`admin/index.html` JS is now modularised (#175).** The admin panel JS has been split into per-feature modules under `resources/js/admin/` (`posts.js`, `travel.js`, `deploy.js`, `cv.js`, `auth.js`, `passkeys.js`, `stats.js`, `notes.js`). `admin.js` is now a thin entry point. `admin/travel.js` remains the largest module (495 lines) and warrants care when modifying.
- **`index.html` is also large (23KB).** The main page has grown by accretion. Some of this is unavoidable (it is a portfolio page with many sections), but it is worth periodically reviewing whether JavaScript logic belongs in a separate module.
- **Legacy jQuery partially removed.** The admin panel no longer uses jQuery (#176, Release 2026-05-26) — all admin JS is now vanilla DOM APIs and `fetch`. jQuery is still present in `script.js`, `blog.js`, and `travel-post.js`. The jQuery/vanilla coexistence creates inconsistency for agents working on those files; `docs/AI.md` documents the rule ("jQuery only for legacy compatibility") but the uncertainty won't fully resolve until those files are migrated too.
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

- **Production deploy now has a visible outcome.** The deploy script emits a structured final report (pass/fail, health-check result, git ref) back to the terminal. Post-deploy verification hits `/health` internally and confirms the running image matches the intended ref. (Shipped Release 2026-05-18.)
- **Health check endpoint exists and is internal-only.** `/health` returns `{ status, db, version, uptime }` and is bound to `127.0.0.1` — reachable by Docker health checks and the deploy script but not from the public internet. (`/api/health` alias removed.) (Shipped Release 2026-05-18.)
- **The admin panel has grown without a clear UX model.** It handles blog posts, travel posts, CV upload, deploy triggers, and stats in one page. Functionally fine for one user; but navigating it is increasingly "just knowing where things are" rather than following an obvious structure.
- **Agent context resets every session.** Each new Claude session must re-read all the docs from scratch. The onboarding prompt handles this well, but long sessions where the context fills up risk agents losing track of earlier decisions. Devlogs (Issues linked in earlier sessions) help mitigate this but require discipline to maintain.

**Overall DX rating: Amber-Green.** The process is good; the operational tooling around it (health checks, deploy feedback, SSH reliability) needs polish.

---

## 4. Reliability, observability & performance

### Reliability

- **Docker Compose provides process supervision.** Since the migration off PM2 (#165/#171/#179), the backend runs under Docker with a restart policy — if the container exits, Docker restarts it. This is the minimum viable reliability for a personal site and is now consistent between dev and prod.
- **Nginx handles static files independently.** The Nginx container serves static pages even if the backend container is down. In practice, most pages rely on API calls, so this is limited comfort.
- **No automated SSL renewal monitoring.** Let's Encrypt auto-renews via a systemd timer, but there is no alert if renewal silently fails. The first sign of a problem would be a browser HTTPS warning — not ideal.
- **No automated host health monitoring.** There is no alerting on CPU, memory, disk space, or process health. If the server disk fills up, nothing will warn you before the site goes down.

### Observability

- **Structured logging in place; rotation/centralisation still open.** The backend logs through `pino` + `pino-http` (#153): severity levels, per-request context, `LOG_LEVEL`, and secret redaction. Log rotation is configured via Docker's `json-file` driver. What remains is centralisation — production diagnosis still requires SSH + tailing container logs; no aggregated view yet. (Remaining work: ROADMAP §4.2.)
- **No metrics.** There is no tracking of request counts, error rates, response times, or API usage. The `stats.js` route exists but its scope is limited.
- **The admin deploy console is the nearest thing to an ops dashboard.** This is a good foundation but it currently only shows deploy output, not runtime health.

### Performance

- **Performance is not a concern, and the previous resource ceiling is gone.** The migration from the Raspberry Pi to the Ubuntu Server (`ak-home-server`) removed the constrained-hardware worry that dominated earlier assessments. Traffic is low, the stack is efficient (Nginx serves static files directly, Node only handles API calls), PostgreSQL is not under load, and the server now has substantial CPU/RAM headroom relative to the workload. Resource exhaustion is no longer a realistic risk for current or foreseeable usage.
- **No image optimisation.** Uploaded images are stored and served at their original size. With ample server headroom this is no longer a performance risk, but it still wastes bandwidth and slows page loads for visitors as content grows — a UX concern rather than a capacity one.
- **No caching headers on static assets.** Nginx likely serves static files without long-lived cache headers, meaning repeat visitors re-download assets on every visit.

**Overall reliability/observability rating: Amber.** Structured logging and internal health checks are now in place. What remains: no automated database backups, no external alerting, no log aggregation/viewer. For a personal site this is acceptable; for anything more important it would not be.

---

## 5. Security posture

### Strengths

- **WebAuthn/FIDO2 passkeys are a genuinely strong auth choice.** No password to phish or leak, no third-party auth dependency, hardware-bound credentials. This is better security than most production applications.
- **JWT is validated on every protected route.** No unprotected admin endpoints found in audits.
- **No third-party auth services.** No OAuth flow means no risk of a third-party breach compromising access.
- **Parameterised queries prevent SQL injection.** Verified consistently across all route files.
- **XSS mitigations are in place.** `escapeHtml()` is used in frontend rendering; this was shored up as part of PR #85.
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

**Overall AI-readiness rating: Amber-Green.** The admin JS modularisation (#175) and the addition of `docs/ARCHITECTURE.md` (#308) have removed the two biggest practical friction points. Remaining friction: jQuery/vanilla JS coexistence in non-admin files (`script.js`, `blog.js`, `travel-post.js`), and context window pressure in long sessions. These are real but not session-blockers.

---

## 7. Top improvement opportunities

These are ordered by impact-to-effort ratio, considering both operational risk and agent friction.

**High priority (operational + agent enablement):**
1. ✅ **Done — `docs/INFRASTRUCTURE.md` written** (Compose service names, Nginx config paths, cert locations, ddclient config and other server-specific facts). Now complemented by `docs/TERMINOLOGY.md`. Keep both current.
2. ✅ **Done — production containerised** (migrated off the Raspberry Pi to Ubuntu Server, Docker Compose; #165/#171/#179). Dev and prod environments are now aligned. Residual risk is operational (script-driven deploys — ROADMAP §3.5).
3. ✅ **Done — `/health` endpoint** (internal-only, `/api/health` public alias removed; health check used by Docker and deploy verification script; #279, Release 2026-05-18).

**High priority (security + agent friction):**
4. ✅ **Done — CSP and security headers** (`nginx-security-headers.conf`; CSP, HSTS, X-Frame-Options, Referrer-Policy all set; #210/#211, Release 2026-05-18).

**Note on backups:** Database backups are critically important. The Ubuntu Server migration (#171) is complete, but a hardened backup + offsite strategy is still outstanding — tracked in ROADMAP §4.5 (pgBackRest / `pg_dump` + restic/rclone).

---

## 8. Update discipline

This document should be updated when:

- The architecture changes meaningfully (e.g. a major hosting change, introducing a new major component).
- A significant area of technical debt is resolved (mark it as addressed, update the rating).
- A new risk is identified that is not captured here.

It should **not** be updated for every PR or minor fix. It is a baseline snapshot, not a changelog. The roadmap (`ROADMAP.md`) and release notes (`docs/RELEASE_NOTES.md`) cover incremental progress.

---

## 9. Change log

- **2026-05-27** — Post Release 2026-05-26 audit. §1: staging environment marked resolved (dev server live at dev.andykeys.me:3001). §2: jQuery note updated — removed from admin (#176), still present in blog/travel/script. §6: architecture diagram friction point marked resolved (docs/ARCHITECTURE.md added #308); AI-readiness rating summary updated to reflect both resolutions.
- **2026-05-26** — Admin JS modularisation (#175) shipped. Updated §2 codebase health (admin monolith resolved), §6 agent friction (admin friction substantially resolved), AI-readiness rating upgraded Amber → Amber-Green. High-risk table updated to reflect modular structure.
- **2026-05-19** — Post Release 2026-05-18 audit. Marked as resolved: health endpoint (#279), structured logging (#153), rate limiting on auth endpoints (#237), CSP/security headers (#210/#211), deploy output/verification (#276/#263), WebAuthn registration guard (#274), Outlook OAuth2 email (#241). Updated §4 (reliability/observability) rating from Red-Amber to Amber. Updated §5 (security) rating from Amber to Amber-Green. §3 pain points revised to reflect deploy improvements. §7 improvement opportunities #3 and #4 marked complete.
- **2026-05-16** — Post-migration reassessment. Corrected statements that the earlier terminology pass left factually stale: §4 now describes Docker Compose (not PM2) as the process supervisor, consistent with the completed migration; the performance subsection now reflects that the Raspberry Pi resource ceiling is gone and the Ubuntu Server has substantial headroom, downgrading image-optimisation from a capacity risk to a UX/bandwidth concern. Removed the "SSH from Windows is not frictionless" DX pain point — key auth has stabilised and is now reliable.
- **2026-05-07 (updated)** — Refined AI-readiness rating from Green-Amber to Amber based on real-world friction observed in agent sessions. Elevated priority of infrastructure docs and clarified frontend testing constraints. Updated improvement opportunities ordering to reflect agent friction alongside operational risk.
- **2026-05-07** — Initial assessment written based on `dev` branch state, covering architecture, codebase health, DX, reliability, security, and AI readiness.
