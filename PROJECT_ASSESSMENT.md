# Project Assessment

_Last updated: 2026-05-07_

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

- **Single-node, single-point-of-failure production.** Everything runs on one Raspberry Pi. There is no redundancy, no failover, and no easy rollback if a deploy breaks the server. A bad deploy to `main` means the site is down until manually fixed over SSH.
- **Production is not containerised.** Local dev uses Docker Compose cleanly, but production runs PM2 directly on the Pi. This means the dev and prod environments are structurally different, which is a source of "works locally, breaks in prod" risk. Moving prod to Docker is the right next step.
- **No database backups.** There is no automated backup of the PostgreSQL data on the Pi. If the SD card dies or the Pi is lost, all blog posts, travel entries, and user data are gone permanently.
- **Uploads are stored on the Pi filesystem.** User-uploaded images (`/uploads`) live directly on the Pi with no backup, no CDN, and no size/type validation beyond what multer provides. This is fine for now but will become a problem as content grows.
- **No staging environment.** `dev` branch is tested locally in Docker but there is no equivalent of the prod environment to test against before merging to `main`. The dual-environment work in the roadmap (Issues #151/#159) directly addresses this.
- **The schema has no migration versioning.** Re-running `schema.sql` is safe but there is no record of what version the live database is at. As the schema grows, this becomes harder to manage without a tool like `node-postgres-migrate` or Flyway.

**Overall architecture rating: Amber.** Solid for a personal project at this stage; the Pi + no-backup + no-staging combination is the biggest real risk.

---

## 2. Codebase health

### What is in good shape

- **Backend routes are well separated.** `auth.js`, `posts.js`, `travel.js`, `contact.js`, `deploy.js`, `upload.js`, `cv.js`, `stats.js` — each route has a single clear responsibility. This is the right pattern.
- **Parameterised queries throughout.** SQL injection risk is well managed. No string concatenation in queries found in recent audits.
- **Shared frontend utilities exist.** `resources/java/utils/` contains `escapeHtml()`, `formatVisitDate()`, and similar helpers. These exist because technical debt was explicitly paid down in earlier sessions (PR #85). This is good practice.
- **ES modules on the frontend.** The codebase has been migrated to ES modules, which means imports are explicit and dependencies are traceable.
- **`docs/` is unusually complete for a personal project.** Having `AI.md`, `STYLE_GUIDE.md`, `TESTING.md`, `DATABASE.md`, `SECURITY.md`, and `DEPENDENCIES.md` all present is genuinely above average. Most solo projects have none of these.

### Where it is less healthy

- **`admin.html` is large (18KB) and monolithic.** The admin panel is a single HTML file with significant inline logic. It works, but it is difficult for an agent to safely modify one part without risk of breaking another. This is the single file most likely to cause regressions.
- **`index.html` is also large (23KB).** The main page has grown by accretion. Some of this is unavoidable (it is a portfolio page with many sections), but it is worth periodically reviewing whether JavaScript logic belongs in a separate module.
- **Legacy jQuery is still present.** Some files use jQuery for DOM manipulation alongside vanilla ES modules. The two styles coexist but this creates inconsistency — a new agent reading the codebase may not know which pattern to follow in a given file. `docs/AI.md` addresses this ("jQuery only for legacy compatibility") but the legacy files themselves have not been cleaned up.
- **`backend/routes/auth.js` is the most complex file at 12KB.** WebAuthn + JWT + magic links in one file is a lot of state to hold. It works correctly and is tested, but it is the highest-risk file to modify. Agents should treat it with extra caution and read it fully before any changes.
- **Frontend test coverage is essentially zero.** The Vitest suite covers backend utilities and some API routes, but there are no frontend tests at all. UI regressions are caught manually via smoke test scripts (`Test-PRN.ps1`), which is better than nothing, but fragile for a codebase growing in complexity.
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

- **SSH from Windows to Pi is not frictionless.** Key authentication sometimes fails, requiring password fallback. This breaks the automation story — `prod-deploy.ps1` should be a one-command operation, and any time it requires manual intervention it erodes confidence in the workflow.
- **Production deploy has no visible outcome.** After running `prod-deploy.ps1`, you have to separately SSH to the Pi to check PM2 status and Nginx logs to confirm the deploy worked. There is no success/failure signal back to the developer's terminal in a clear, structured way.
- **There is no health check URL.** There is no `/api/health` endpoint that returns a structured response (app status, DB connectivity, version). This means the only way to confirm a deploy succeeded is to manually test the site. A health check would take 10 minutes to add and dramatically improve deploy confidence.
- **The admin panel has grown without a clear UX model.** It handles blog posts, travel posts, CV upload, deploy triggers, and stats in one page. Functionally fine for one user; but navigating it is increasingly "just knowing where things are" rather than following an obvious structure.
- **Agent context resets every session.** Each new Claude session must re-read all the docs from scratch. The onboarding prompt handles this well, but long sessions where the context fills up risk agents losing track of earlier decisions. Devlogs (Issues linked in earlier sessions) help mitigate this but require discipline to maintain.

**Overall DX rating: Amber-Green.** The process is good; the operational tooling around it (health checks, deploy feedback, SSH reliability) needs polish.

---

## 4. Reliability, observability & performance

### Reliability

- **PM2 provides basic process supervision.** If the Node process crashes, PM2 restarts it. This is the minimum viable reliability for a personal site.
- **Nginx handles static files independently.** Even if the Node backend crashes, static pages would theoretically still be served by Nginx. In practice, most pages rely on API calls, so this is limited comfort.
- **No automated SSL renewal monitoring.** Let's Encrypt auto-renews via a systemd timer, but there is no alert if renewal silently fails. The first sign of a problem would be a browser HTTPS warning — not ideal.
- **No automated Pi health monitoring.** There is no alerting on CPU, memory, disk space, or process health. If the Pi SD card fills up (a known Raspberry Pi failure mode), nothing will warn you before the site goes down.

### Observability

- **Logging is minimal.** PM2 captures stdout/stderr, but there is no structured logging, no log rotation policy, and no centralised view. Debugging a production issue requires SSHing to the Pi and tailing logs manually.
- **No metrics.** There is no tracking of request counts, error rates, response times, or API usage. The `stats.js` route exists but its scope is limited.
- **The admin deploy console is the nearest thing to an ops dashboard.** This is a good foundation but it currently only shows deploy output, not runtime health.

### Performance

- **Performance is not currently a concern.** Traffic is low, the stack is efficient (Nginx serves static files directly, Node only handles API calls), and PostgreSQL is not under load. The Pi is adequate for current usage.
- **No image optimisation.** Uploaded images are stored and served at their original size. For a travel site with multiple photos per post, this will become noticeable as content grows.
- **No caching headers on static assets.** Nginx likely serves static files without long-lived cache headers, meaning repeat visitors re-download assets on every visit.

**Overall reliability/observability rating: Red-Amber.** The site works but is flying blind in production. No backups, no health checks, no alerting, no log strategy. For a personal site this is acceptable risk; for anything more important it would not be.

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

- **Rate limiting is minimal.** The `backend/middleware/` directory has some rate limiting, but it has not been audited thoroughly. The contact form, magic link endpoint, and any future AI Lab endpoints are potential abuse surfaces.
- **The deploy endpoint (`/api/deploy`) is high-value and must remain tightly protected.** A compromise of the JWT that gates this route would give an attacker the ability to trigger deploys. This endpoint should be audited specifically as part of any security review.
- **No Content Security Policy (CSP) headers.** Nginx does not appear to set CSP headers. This is a meaningful XSS mitigation that is missing.
- **Uploaded files are served from the same origin.** If a malicious file were uploaded (e.g., an SVG with embedded script), it could be served directly. Input validation on uploads should be reviewed.
- **The Pi itself is the weakest link.** The Pi is a home-hosted server with a dynamic IP. Physical access, SD card health, and home network security are all outside the application's control but affect the overall security posture.
- **AI Lab will add new attack surface.** Once implemented, the AI Lab introduces API keys for Perplexity and Anthropic, prompt injection risk, and potential for resource abuse. The auth-token gating planned in Issue #15 is necessary but not sufficient — the Lab endpoints will need their own threat model.

**Overall security rating: Amber.** Auth is solid; infrastructure and headers need attention; AI Lab will require a dedicated security review before launch.

---

## 6. AI & agent readiness

This is an unusual section for a project assessment, but it is directly relevant given the workflow.

### What works well for agents

- **Documentation depth is high.** `AI.md`, `STYLE_GUIDE.md`, `TESTING.md`, `DATABASE.md`, `SECURITY.md`, and `DEPENDENCIES.md` together give an agent enough context to work without constantly asking questions. This is the project's biggest DX asset.
- **Branching model is explicit and enforced.** Agents are unlikely to accidentally commit to `dev` or `main` because the rules are clearly stated and the PR-only workflow is consistent.
- **Test suite gives agents a safety net.** Vitest + smoke test scripts mean an agent can make a change and have a concrete way to verify it did not break anything.
- **The onboarding prompt works well in practice.** Sessions that start with the full doc-reading process produce noticeably better results than those that do not.

### Where agent friction exists

- **No architecture diagram.** There is no visual representation of how the pieces fit together. Agents (and new humans) must construct a mental model from reading code. A simple `docs/ARCHITECTURE.md` with an ASCII or Mermaid diagram of Nginx → Node → PostgreSQL and the file structure would reduce onboarding time.
- **`admin.html` is hard for agents to modify safely.** Its size and mixed concerns mean agents often request clarification or make overly conservative changes. Splitting it into logical sections or extracting JS modules would help.
- **Implicit Pi-specific knowledge.** Several operational facts are not written down: the exact PM2 service name, where Nginx config files live on the Pi, how `ddclient` is configured, where the Let's Encrypt certs are. An agent asked to diagnose a production issue would be guessing at these. A short `docs/INFRASTRUCTURE.md` would close this gap.
- **Context window pressure in long sessions.** The doc suite is thorough but also long. In extended sessions, earlier context (especially specific file contents read at the start) can be lost. This is a fundamental LLM constraint, not a fixable problem, but it means breaking work into smaller issues (which the project already does well) is especially important here.
- **No structured way for agents to flag "I am not sure about this."** When an agent is uncertain, it either proceeds (risky) or asks (slows things down). A convention like "if in doubt, raise a GitHub issue with the `needs-decision` label and stop" would help, but this is aspirational rather than current practice.

**Overall AI-readiness rating: Green-Amber.** Better than almost any personal project I have seen; the gaps are well-defined and addressable.

---

## 7. Top improvement opportunities

These are ordered by impact-to-effort ratio, not by technical interest.

1. **Add a `/api/health` endpoint** — 30 minutes of work, dramatically improves deploy confidence and sets the foundation for future monitoring. Should return `{ status: "ok", db: "ok", version: "..." }`.
2. **Automate database backups on the Pi** — a cron job running `pg_dump` and rotating files is an afternoon of work; losing all site content because an SD card failed is an unacceptable risk for the effort required to prevent it.
3. **Containerise production (move prod to Docker Compose on Pi)** — aligns dev and prod environments, makes deploys predictable, and is a prerequisite for the dual-environment setup in the roadmap.
4. **Add CSP and security headers to Nginx config** — one Nginx config block; meaningfully improves XSS and clickjacking protection with minimal risk.
5. **Write `docs/INFRASTRUCTURE.md`** — a short document covering PM2 service name, Nginx config paths, cert locations, ddclient config, and any other Pi-specific facts that currently live only in someone's head. Directly improves agent effectiveness in production debugging scenarios.

---

## 8. Update discipline

This document should be updated when:

- The architecture changes meaningfully (e.g. moving from Pi to mini PC, adding Docker to prod, introducing a new major component).
- A significant area of technical debt is resolved (mark it as addressed, update the rating).
- A new risk is identified that is not captured here.

It should **not** be updated for every PR or minor fix. It is a baseline snapshot, not a changelog. The roadmap (`ROADMAP.md`) and release notes (`docs/RELEASE_NOTES.md`) cover incremental progress.

---

## 9. Change log

- **2026-05-07** — Initial assessment written based on `dev` branch state, covering architecture, codebase health, DX, reliability, security, and AI readiness.
