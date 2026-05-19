# Roadmap

_Last updated: 2026-05-19_

## 1. Vision and goals

MyPortfolioSite is my personal technical hub: a place to showcase projects, write about travel and tinkering, and experiment with an “AI lab” that orchestrates different assistants (Perplexity for research, Claude for coding) against my own code, content, and home lab.

The goals for the project are:

- Turn the site into a reliable home for my content (blog, travel, devlogs) with low-friction publishing.
- Evolve the AI Lab into a genuinely useful personal tool for research, coding, and project planning.
- Mature the infrastructure into a stable, observable service (migration off the original Raspberry Pi to Ubuntu Server is complete; see §5.1).
- Reduce operational friction (deployments, SSH, certs) so changes are safe and quick to ship.

## 2. Current state snapshot

**Architecture**

- Node/Express backend serving static HTML/CSS/JS pages.
- PostgreSQL database backing blog/travel content and admin features.
- Hosted on an Ubuntu Server (`ak-home-server`) — Docker Compose + Nginx reverse proxy + Let’s Encrypt TLS. (Migrated off the original Raspberry Pi; see §5.1.)
- Single production environment; dev work is mostly local.

**Features**

- Blog and travel pages with admin UI for managing posts.
- Deployment/admin console for triggering deploys and basic operations.
- AI Lab design and implementation planning in progress (Issue #15).
- Dual-environment hosting investigation completed (Issue #151) with implementation planned (Issue #159).

**Pain points**

- Deployments are script-driven and improving but not yet fully automated — unified deploy script and compose base are the next step (#300/#301).
- Single-server resource ceiling limits what can run concurrently (especially with future AI experiments).
- No database backups or external alerting — the biggest remaining operational risk.
- Log aggregation requires SSH; no admin-surfaced view yet.

## 3. Near-term priorities

> **Sequencing principle (ops first):** Deployment reliability, logging, and the automated test gate take precedence over new feature work (including AI Lab v1, §3.2). Recent sessions have lost significant time to deployment bugs (orphan containers, stale code, env-var gaps) and to debugging blind without structured logs. Until deploys are boringly reliable and observable, ops/deploy/logging items are pulled ahead of feature delivery. Concretely the near-term order is: **3.5 (deploy reliability & logging) → 3.4 (test gate) → 3.1 (dual-env) → 3.3 (QoL) → 3.2 (AI Lab v1)**.

### 3.1 Dual-environment hosting (LAN dev + public prod)

- Implement the dual-environment setup described in Issue #151 / #159:
  - Production on `main` via Nginx → Docker service bound to loopback.
  - Dev/staging on `dev` via LAN-only port on the server (`ak-home-server`).
- Extend the admin console to:
  - Show status for both environments.
  - Trigger “Pull & Restart” for prod and dev separately.
  - Start/stop the dev environment for resource management.

**Outcome:** Safe place to test work-in-progress on real hardware while keeping production stable.

### 3.2 AI Lab v1

- Build a private `/lab` page gated behind the existing auth token.
- Add `/api/lab` backend routes:
  - `GET /agents`, `POST /sessions`, `POST /chat`, `GET /sessions`, `GET /sessions/:id/messages`.
- Implement three initial agents:
  - Researcher (Perplexity-backed).
  - Code Companion (Claude-backed).
  - Summariser.
- Persist lab sessions and messages in Postgres, with tagging by project.
- Optional: “Save as devlog” flow that turns a lab session into a devlog draft.

**Outcome:** A working private AI playground tightly integrated with the site and workflows.

### 3.3 Quality-of-life fixes

- Fix SSH key auth from Windows to the server (`ak-home-server`) so passwordless login works reliably.
- Simplify deployment scripts and document the standard path (admin console as the primary interface).
- Tidy up small UI/UX issues in admin and public pages as they surface.

**Outcome:** Less friction around making and deploying changes, more confidence when experimenting.

### 3.4 ✅ Automated test gate — SHIPPED (Release 2026-05-18)

A GitHub Actions CI workflow runs the Vitest suite on every PR to `dev` (#260). In parallel, a server-side regression suite (`test-regression.sh`) runs automatically post-deploy with rollback on failure (#270). Both are live. The merge-time safety net and post-deploy gate are in place.

**Remaining:** The full CD half (versioned image build, GHCR, self-hosted runner) is still in §4.4 and sequences after dual-environment hosting (3.1).

### 3.5 ✅ Deployment reliability & structured logging — SHIPPED (Release 2026-05-18)

The critical blockers from this section are resolved:

- **Orphan container prevention:** `--remove-orphans` baked into all deploy scripts; orphan/port warnings surface as hard failures (#253).
- **Post-deploy verification:** `deploy-lib.sh` hits `/health`, confirms image/commit matches the intended ref, and emits a structured pass/fail report (#263/#276).
- **Structured logging:** Backend uses `pino` + `pino-http` — severity levels, per-request context, `LOG_LEVEL`, secret redaction. Log rotation via Docker's `json-file` driver (#153).

**What remains (promoted to §4.2 / new issues):**

- Unify dev/prod deploy scripts with environment-aware feature flags to prevent config drift (#300).
- Unify docker-compose files with a shared base (#301).
- Pre-flight port check and nginx config validation in the deploy pipeline (#302/#303).
- Outlook OAuth2 token validity pre-flight at startup (#304).
- Self-healing deploy with escalating recovery steps (#232).
- Log aggregation/centralised viewer (#259 closed — Pino in place; aggregation is the outstanding piece).

## 4. Medium-term directions

### 4.1 AI Lab v2

- Introduce workflow “playbooks” (e.g. Research → Plan → Devlog).
- Add a planner agent that coordinates multiple agents for multi-step tasks.
- Integrate AI Lab more deeply with devlogs and GitHub:
  - One-click “Open as GitHub issue” from a lab session (guarded, explicit).

### 4.2 Observability and reliability

- Surface basic metrics in the admin console:
  - Request counts, error counts, uptime, server CPU/RAM usage.
- Add simple health checks and status indicators:
  - App, DB, disk space, SSL status.

### 4.3 Content and polish

- Grow the blog and travel sections with more posts and richer content.
- Refine visual design (consistent components, design tokens, responsive behavior).
- Make admin flows (creating posts, editing content) smoother and more discoverable.

### 4.4 Professionalised CI/CD pipeline (GitHub + open-source tooling)

Deployments are still script-driven and manual, which has caused real incidents (e.g. orphan containers serving stale code after a compose service rename — see issue #253). The goal is a reproducible, observable pipeline using only GitHub-native and open-source tools — no paid SaaS, consistent with the self-hosted ethos.

> **Note:** The Continuous Integration test gate below has been promoted to a near-term priority as **§3.4** — it needs no extra infrastructure and lands first. §4.4 now focuses on the Continuous Delivery half (versioned image build/publish, self-hosted runner, gated prod deploy), which still sequences after dual-environment hosting (3.1) and likely alongside the mini PC migration (5.1). The CI section is retained here for completeness of the end-state picture.

**Continuous Integration (on every PR to `dev`):**

- GitHub Actions workflow running the existing Vitest suite inside the backend container, plus lint/format checks.
- Block merge on red CI; surface results on the PR.
- Optional: build the Docker images on CI to catch Dockerfile/dependency breakage before it reaches the server.

**Continuous Delivery (controlled, not fully automatic):**

- Build versioned images and publish to **GitHub Container Registry (GHCR)** — free for this use, keeps the existing Docker Compose model.
- A **self-hosted GitHub Actions runner** on the home server (it has no public ingress for cloud runners) that pulls the tagged image and runs the existing `deploy-lib.sh` flow — wrapped, not replaced.
- Promotion model mirrors the branch strategy: merge to `dev` → auto-deploy to the LAN dev environment; tagging a `release/*` / merge to `main` → gated prod deploy requiring manual approval (GitHub Environments with required reviewers — that approver is me, consistent with "only you merge to main").
- Deploy step always uses `--remove-orphans` and fails loudly on orphan/port-conflict warnings (prevention baked in, ref #253 / #232).

**Observability of the pipeline:**

- Deploy run summary (what was built, image digest, health-check result, rollback if unhealthy) posted back to the PR / release and surfaced in the admin deploy console.
- Keep the existing rollback/last-good-state logic; CI/CD wraps it rather than reinventing it.

**Open-source tool candidates (all self-hostable / free):**

- GitHub Actions + self-hosted runner (orchestration)
- GHCR (image registry)
- Trivy or Grype (image vulnerability scan in CI)
- act (local workflow testing before pushing)
- Existing Vitest + shell smoke tests (no new test framework)

**Outcome:** Push-button, auditable releases with the human gate kept for prod; stale-code/orphan classes of incident designed out; the home-lab, no-paid-SaaS philosophy preserved. Sequencing: land after dual-environment hosting (3.1) is stable and likely alongside the mini PC migration (5.1), since a beefier host makes a self-hosted runner + image builds comfortable.

### 4.5 Open-source tooling adoption

Beyond the CI/CD pipeline (§4.4), several existing pain points and open issues can be addressed with free, self-hostable, open-source tools — keeping the no-paid-SaaS principle. Grouped by area:

**Dependency & security hygiene (low effort, high value):**

- **Dependabot** or **Renovate** (free) — automated dependency PRs; reduces manual `npm audit` toil.
- **gitleaks** in CI — block commits/PRs that leak secrets (`.env`, tokens) — complements the existing "never commit secrets" rule.
- **Trivy / Grype** — container image CVE scanning (also listed in §4.4 CI).
- ✅ `/debug` routes are guarded by `IS_DEV` flag (#236, shipped). Rate limiting on all auth endpoints (#237, shipped). Remaining: scoped service-account JWTs (#275).

**Code quality gates (supports untested-route risk in #238):**

- **ESLint + Prettier** with a CI check — consistent style enforced automatically, less review nitpicking.
- **markdownlint-cli2** in CI — resolves #199 and keeps docs clean going forward.
- **axe-core / pa11y** accessibility check in CI — turns the manual a11y fixes into a regression gate. (✅ aria-label fixes shipped, #229.)
- Vitest coverage thresholds enforced in CI — directly targets the auth.js/deploy.js coverage gap (#238).

**Observability (addresses the "limited observability" pain point and §4.2):**

- **Uptime Kuma** (self-hosted, lightweight) — uptime/health dashboard for app, DB, SSL, disk; far less work than a full metrics stack.
- **Grafana + Prometheus + node_exporter**, or the lighter **Grafana + Loki + Promtail** for logs — surface request/error rates and host metrics. Pair with structured logging (Pino) to replace ad-hoc `console.log` (#152).
- **Postgres `pgBackRest`** or a documented `pg_dump` + **restic**/**rclone** routine — closes the no-automated-backup gap (#185, #240) with a tested restore path.

**Database lifecycle:**

- A lightweight open-source migration tool (**node-pg-migrate** or **dbmate**) — replaces the idempotent-`schema.sql`-only approach with versioned, reversible migrations (long-standing gap; see #169 context in CLAUDE.md).

**Outcome:** Most of these are CI-only or single-container additions — incremental, reversible, and individually shippable as their own `feature/*` issues rather than one big bang.

## 5. Longer-term ideas

### 5.1 Move off the Raspberry Pi — ✅ Completed (2026-05)

Hosting was migrated from the original Raspberry Pi to an Ubuntu Server
(`ak-home-server`, a repurposed gaming PC) and fully containerised with
Docker Compose. The Docker + Nginx + Postgres pattern and the
deployment/admin model were kept consistent. See `docs/INFRASTRUCTURE.md`
for the current host layout and `docs/RELEASE_NOTES.md` for the migration
record (#171).

Remaining follow-ups from this milestone are tracked elsewhere:

- Backup/restore hardening — see §4.5 (pgBackRest / `pg_dump` + restic/rclone).
- Monitoring/observability — see §3.5 and §4.2.

### 5.2 Local AI capabilities

- Run a local LLM on the mini PC and add a “Local” agent to the AI Lab:
  - Restricted to private data.
  - No external API calls for sensitive workflows.
- Explore using local embeddings / vector storage for personal notes and docs.

### 5.3 Public AI demo

- Consider a safe, read-only public AI feature:
  - For example, “Ask my site about my projects” powered only by public content.
  - Strictly isolated from private AI Lab and any write-capable tools.

### 5.4 Private cloud / personal file sync (Nextcloud)

- Explore running Nextcloud on the mini PC for personal file sync and storage:
  - Private alternative to commercial cloud services.
  - Leverage existing Docker and home-lab infrastructure.
  - Could integrate with AI Lab for local document processing.
- Would need dedicated Docker resources; deferred until after mini PC migration.

### 5.5 Future development suggestions

Speculative, not committed — captured so good ideas are not lost. To be promoted to issues/priorities only when there is appetite.

**Platform & architecture:**

- **Server-side rendering for blog/travel** — current client-side Markdown rendering degrades SEO; a minimal SSR or build-time pre-render (still no heavy framework) would help discoverability.
- **Modularise the monoliths** — continue the direction in #175 (`admin.js`) and #178 (HTML feature folders); pairs well with the jQuery removal in #176.
- **API versioning** (`/api/v1`) — cheap to add now, painful to retrofit later if the AI Lab API grows.
- **Typed backend** — incremental TypeScript or JSDoc-typed modules on the highest-risk files (`auth.js`, `deploy.js`) for safety without a build step everywhere.

**Content & UX:**

- **RSS/Atom feed** for the blog — trivial, high value for a personal site, no infra.
- **Full-text search** across blog/travel using Postgres `tsvector` (no external search service).
- **Image optimisation pipeline** (#174) using **sharp** — responsive sizes + modern formats on upload.
- **Draft preview links** — share unpublished posts via a signed, expiring URL (reuses the magic-link token pattern).

**AI Lab extensions (build on §3.2/§4.1):**

- **Retrieval over own content** — embed blog/devlogs into pgvector so the Code Companion/Researcher can cite the site's own history.
- **Scheduled agent runs** — e.g. a weekly "summarise what changed" devlog draft from git history + closed issues.

**Home-lab synergy:**

- **Single sign-on** across home-lab services (the passkey/JWT model could front other self-hosted apps).
- **Status page** aggregating all home-lab services (extends the Uptime Kuma idea in §4.5).

**Process:**

- **Issue/PR templates audit** and a lightweight project board reflecting this roadmap, so roadmap ↔ issues stay in sync (relates to #196, #239).
- **Release automation** — auto-generate `RELEASE_NOTES.md` entries from merged PR labels at tag time (composes with §4.4 CD).

## 6. Risks and assumptions

- **Host resource limits:** Running multiple containers and AI features concurrently on the single Ubuntu Server (`ak-home-server`) may be tight; heavier workloads could need dedicated resources. (The original Raspberry Pi has already been retired — see §5.1.)
- **Time vs scope:** The roadmap assumes part-time work; priorities may be adjusted as reality dictates.
- **External dependencies:** Perplexity and Anthropic APIs are central to AI Lab plans; changes in their pricing or features could affect direction.

## 7. Change log

- **2026-05-19** – Post Release 2026-05-18 update. §3.4 and §3.5 marked as shipped. §2 pain points revised. §4.5 cross-refs updated to reflect shipped items (#236/#237/#229). New outstanding items from deploy session added to §3.5 remainder (#300/#301/#302/#303/#304).
- **2026-05-07** – Initial roadmap drafting, based on issues #15, #151, #159 and current architecture.
- **2026-05-15** – Added §4.4 Professionalised CI/CD pipeline (GitHub Actions + GHCR + self-hosted runner), prompted by the orphan-container deploy incident (#253).
- **2026-05-15** – Added §4.5 Open-source tooling adoption (Dependabot/Renovate, gitleaks, ESLint/Prettier, Uptime Kuma, Grafana/Loki, migration tooling) and §5.5 Future development suggestions, cross-referencing existing open issues.
- **2026-05-15** – Promoted the CI test gate out of §4.4 into near-term priority §3.4 (Automated test gate); it needs no new infrastructure and lands before the full CD pipeline. §4.4 re-scoped to the Continuous Delivery half.
- **2026-05-16** – Added an ops-first sequencing principle to §3 and new near-term priority §3.5 (Deployment reliability & structured logging), pulling deploy-hardening (#253) and Pino structured logging (#152) ahead of feature work after repeated deployment-bug time sinks.
