# Roadmap

_Last updated: 2026-05-15_

## 1. Vision and goals

MyPortfolioSite is my personal technical hub: a place to showcase projects, write about travel and tinkering, and experiment with an “AI lab” that orchestrates different assistants (Perplexity for research, Claude for coding) against my own code, content, and home lab.

The goals for the project are:

- Turn the site into a reliable home for my content (blog, travel, devlogs) with low-friction publishing.
- Evolve the AI Lab into a genuinely useful personal tool for research, coding, and project planning.
- Mature the infrastructure from “Pi experiment” to a stable, observable service, eventually on a mini PC.
- Reduce operational friction (deployments, SSH, certs) so changes are safe and quick to ship.

## 2. Current state snapshot

**Architecture**

- Node/Express backend serving static HTML/CSS/JS pages.
- PostgreSQL database backing blog/travel content and admin features.
- Hosted on a Raspberry Pi (Docker + Nginx reverse proxy + Let’s Encrypt TLS).
- Single production environment; dev work is mostly local.

**Features**

- Blog and travel pages with admin UI for managing posts.
- Deployment/admin console for triggering deploys and basic operations.
- AI Lab design and implementation planning in progress (Issue #15).
- Dual-environment hosting investigation completed (Issue #151) with implementation planned (Issue #159).

**Pain points**

- Deployments are still somewhat manual and Pi-centric.
- SSH key authentication from Windows is not yet frictionless.
- Pi resource ceiling limits what can run concurrently (especially with future AI experiments).
- Limited observability (minimal metrics/logs surfaced in UI).

## 3. Near-term priorities

### 3.1 Dual-environment hosting (LAN dev + public prod)

- Implement the dual-environment setup described in Issue #151 / #159:
  - Production on `main` via Nginx → Docker service bound to loopback.
  - Dev/staging on `dev` via LAN-only port on the Pi.
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

- Fix SSH key auth from Windows to Pi so passwordless login works reliably.
- Simplify deployment scripts and document the standard path (admin console as the primary interface).
- Tidy up small UI/UX issues in admin and public pages as they surface.

**Outcome:** Less friction around making and deploying changes, more confidence when experimenting.

### 3.4 Automated test gate (CI-only — precursor to §4.4)

Promoted ahead of the full CI/CD pipeline (§4.4): the test-gate half needs no self-hosted runner, GHCR, or beefier host, so it can land now and start catching regressions immediately. Today the Vitest suite and `Test-Regression.ps1` only run when invoked manually on the dev server; nothing blocks a red change from reaching `dev`. Security-sensitive PRs (e.g. the `email_tokens` bcrypt work, #134) are exactly where an automated gate pays off.

- GitHub Actions workflow on every PR to `dev`: run the existing Vitest suite in the backend container (Postgres as a service container), plus lint/format checks.
- Block merge on red CI; surface results on the PR.
- No deployment, registry, or runner work in scope here — this is purely the merge-time safety net. The build/publish/deploy automation stays in §4.4 and still sequences after dual-environment hosting (3.1).

**Outcome:** Regressions caught at PR time instead of by hand, with zero new infrastructure — a cheap, reversible first step that de-risks everything in §4.4.

## 4. Medium-term directions

### 4.1 AI Lab v2

- Introduce workflow “playbooks” (e.g. Research → Plan → Devlog).
- Add a planner agent that coordinates multiple agents for multi-step tasks.
- Integrate AI Lab more deeply with devlogs and GitHub:
  - One-click “Open as GitHub issue” from a lab session (guarded, explicit).

### 4.2 Observability and reliability

- Surface basic metrics in the admin console:
  - Request counts, error counts, uptime, Pi CPU/RAM usage.
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
- Hardens the open `/debug` route and rate-limit work already in flight (#236, #237).

**Code quality gates (supports untested-route risk in #238):**

- **ESLint + Prettier** with a CI check — consistent style enforced automatically, less review nitpicking.
- **markdownlint-cli2** in CI — resolves #199 and keeps docs clean going forward.
- **axe-core / pa11y** accessibility check in CI — turns the manual a11y fixes (#229) into a regression gate.
- Vitest coverage thresholds enforced in CI — directly targets the auth.js/deploy.js coverage gap (#238).

**Observability (addresses the "limited observability" pain point and §4.2):**

- **Uptime Kuma** (self-hosted, lightweight) — uptime/health dashboard for app, DB, SSL, disk; far less work than a full metrics stack.
- **Grafana + Prometheus + node_exporter**, or the lighter **Grafana + Loki + Promtail** for logs — surface request/error rates and host metrics. Pair with structured logging (Pino) to replace ad-hoc `console.log` (#152).
- **Postgres `pgBackRest`** or a documented `pg_dump` + **restic**/**rclone** routine — closes the no-automated-backup gap (#185, #240) with a tested restore path.

**Database lifecycle:**

- A lightweight open-source migration tool (**node-pg-migrate** or **dbmate**) — replaces the idempotent-`schema.sql`-only approach with versioned, reversible migrations (long-standing gap; see #169 context in CLAUDE.md).

**Outcome:** Most of these are CI-only or single-container additions — incremental, reversible, and individually shippable as their own `feature/*` issues rather than one big bang.

## 5. Longer-term ideas

### 5.1 Move from Pi to mini PC

- Migrate hosting from Raspberry Pi to a more capable mini PC:
  - Reuse Docker + Nginx + Postgres pattern.
  - Keep deployment and admin model consistent.
- Take the opportunity to tighten backup/restore and monitoring.

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

- **Pi resource limits:** Running multiple containers and AI features on the Pi will be tight; the mini PC migration is assumed.
- **Time vs scope:** The roadmap assumes part-time work; priorities may be adjusted as reality dictates.
- **External dependencies:** Perplexity and Anthropic APIs are central to AI Lab plans; changes in their pricing or features could affect direction.

## 7. Change log

- **2026-05-07** – Initial roadmap drafting, based on issues #15, #151, #159 and current architecture.
- **2026-05-15** – Added §4.4 Professionalised CI/CD pipeline (GitHub Actions + GHCR + self-hosted runner), prompted by the orphan-container deploy incident (#253).
- **2026-05-15** – Added §4.5 Open-source tooling adoption (Dependabot/Renovate, gitleaks, ESLint/Prettier, Uptime Kuma, Grafana/Loki, migration tooling) and §5.5 Future development suggestions, cross-referencing existing open issues.
- **2026-05-15** – Promoted the CI test gate out of §4.4 into near-term priority §3.4 (Automated test gate); it needs no new infrastructure and lands before the full CD pipeline. §4.4 re-scoped to the Continuous Delivery half.
