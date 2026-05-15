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

## 6. Risks and assumptions

- **Pi resource limits:** Running multiple containers and AI features on the Pi will be tight; the mini PC migration is assumed.
- **Time vs scope:** The roadmap assumes part-time work; priorities may be adjusted as reality dictates.
- **External dependencies:** Perplexity and Anthropic APIs are central to AI Lab plans; changes in their pricing or features could affect direction.

## 7. Change log

- **2026-05-07** – Initial roadmap drafting, based on issues #15, #151, #159 and current architecture.
- **2026-05-15** – Added §4.4 Professionalised CI/CD pipeline (GitHub Actions + GHCR + self-hosted runner), prompted by the orphan-container deploy incident (#253).
