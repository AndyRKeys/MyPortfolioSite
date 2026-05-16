# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Quick Orientation (2 minutes)

**What is this?** A personal portfolio site at andykeys.me — blog, travel posts, admin console for managing content, and AI lab experiments. Hosted on a Raspberry Pi (moving to Ubuntu Server gaming PC).

**Tech stack:**
- Frontend: vanilla JS/HTML/CSS (no build step), jQuery for legacy compatibility
- Backend: Node.js/Express (ES modules), WebAuthn + JWT auth
- Database: PostgreSQL
- Web server: Nginx (reverse proxy + static files)
- Dev: Docker Compose (backend + postgres + nginx all containerised)
- AI pair programmer: Claude Sonnet via Anthropic API

**Key files:**
- `backend/server.js` — Express app entry point, middleware, route registration
- `backend/routes/` — API endpoints (auth, posts, travel, deploy, etc.)
- `backend/db/schema.sql` — PostgreSQL schema (idempotent, uses IF NOT EXISTS)
- `resources/java/` — frontend ES modules (one per feature: script.js, blog.js, travel.js, admin.js, etc.)
- `docs/AI.md` — your working instructions (scope, commits, documentation, code style)
- `docker-compose.yml` — local dev setup; prod uses same file with .env.prod overrides

---

## Before You Start

1. **Read the onboarding docs in this order:**
   - README.md — architecture, local setup, branching, deployment
   - docs/AI.md — working instructions, scope discipline, commit conventions
   - docs/STYLE_GUIDE.md — naming, code patterns, button variants
   - docs/TESTING.md — test suite, how to run, PR smoke tests
   - docs/DATABASE.md — schema reference
   - docs/SECURITY.md — auth model, JWT, threat model
   - docs/DEPENDENCIES.md — dependency rules

2. **Project orientation:**
   - Branching: `main` (prod) ← `dev` (integration) ← `feature/issue-N-*` (your work)
   - Code style: ES modules on frontend, parameterised queries always, imperative commit messages
   - No build step — frontend is vanilla JS with imports; Nginx serves directly
   - All tests run in Docker: `docker compose exec backend npm test` or use dev-local.ps1

3. **Current state:** See `PROJECT_ASSESSMENT.md` and `ROADMAP.md` for what's working, what's fragile, and what's planned.

---

## Common Commands

### Local Development (Docker — Recommended)

```powershell
# Start all services (backend, postgres, nginx)
. scripts\dev\dev-local.ps1 up

# Run tests
. scripts\dev\dev-local.ps1 test

# Stop services (DB persists)
. scripts\dev\dev-local.ps1 down

# Full reset (wipes local DB)
. scripts\dev\dev-local.ps1 reset

# View backend logs
. scripts\dev\dev-local.ps1 logs

# Open psql shell into dev DB
. scripts\dev\dev-local.ps1 db

# Run tests with coverage
. scripts\dev\dev-local.ps1 test:coverage
```

### Testing

```bash
# Inside the running backend container:
npm test                          # Full suite
npm test -- tests/routes/posts    # Single file
npm test -- --reporter=verbose    # Verbose output

# From Windows (runs inside container):
. scripts\dev\dev-local.ps1 test

# Smoke tests for a PR:
.\scripts\tests\Test-Regression.ps1
.\scripts\tests\Test-PR148.ps1     # Example for PR #148
```

### Git Workflow

```bash
# Start new work
git checkout dev
git pull origin dev
git checkout -b fix/issue-N-short-description

# Commit (follow style: imperative, short summary, Co-Authored-By footer)
git add <files>
git commit -m "fix: correct nginx template path

The volume mount in docker-compose.yml pointed to a non-existent path.
Files moved to scripts/config/ in #130 but compose file wasn't updated.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"

# One branch at a time for OPS and SECURITY work — do not run multiple
# ops/infra or security (auth/tokens/secrets/rate-limit) branches in
# parallel; finish + PR + merge one before starting the next. Unrelated
# low-risk work may still parallelise.

# Push and create PR
# PR creation is the DEFAULT: once the branch is pushed and the work is
# complete, open the PR to dev automatically — do not ask first. You still
# never merge it (owner reviews + merges). Skip only if explicitly told to,
# or the work is incomplete/experimental (and say so).
git push -u origin fix/issue-N-short-description
gh pr create --base dev --title "Title" --body "Description. Closes #N"

# After review, merge to dev (user does this, not you)
# User will then create a release PR: dev → main for deploy
```

### Deployment (From Windows)

```powershell
# (Not for agents — user triggers this, we just ensure code is ready)
.\scripts\deploy\prod-deploy.ps1
```

---

## Architecture & Key Concepts

### Frontend Architecture

No build step. HTML pages load ES modules directly via `<script type="module">`.

**Frontend JS structure:**
- `resources/java/config.js` — exports `API_BASE` (empty string for same-origin, auto-detects localhost in dev)
- `resources/java/script.js` — homepage only: GitHub widget, contact form, home visit counter
- `resources/java/blog.js` — blog listing page
- `resources/java/travel.js` — travel listing page (map, cards, timeline, lightbox)
- `resources/java/admin.js` — admin panel (18KB, monolithic, highest-risk file to modify)
- `resources/java/utils/` — shared utilities (escapeHtml, formatVisitDate, buildTimelineItem, etc.)

**Key pattern:** jQuery used only for legacy compatibility (DOM queries, $.ajax for API calls). New code uses vanilla DOM APIs and fetch.

**Shared utilities are intentional tech debt paydown** — they exist because earlier sessions paid down this debt. Reuse them.

### Backend Architecture

Express app in `backend/server.js`. Routes are well-separated by concern.

**Key routes:**
- `backend/routes/auth.js` (12KB) — WebAuthn registration/auth, JWT issuance, email magic links, passkey verification. Highest-risk route to modify.
- `backend/routes/posts.js` — blog and travel CRUD
- `backend/routes/travel.js` — travel listing + detail
- `backend/routes/deploy.js` — deployment triggers (gated by auth), rollback, status
- `backend/routes/upload.js` — CV + photo upload with validation
- `backend/routes/contact.js` — contact form with nodemailer

**Middleware:**
- `backend/middleware/errorHandler.js` — catches and formats errors
- `backend/middleware/validate.js` — schema validation for request bodies
- JWT auth check: routes check for valid JWT before running

**Database:**
- `schema.sql` is idempotent (IF NOT EXISTS throughout) — safe to re-run
- Tables: users, passkeys, email_tokens, posts (blog and travel unified), uploads, audit_log (coming), stats
- No migration tool yet — uses raw SQL applied at boot

### Request Flow

1. **Public page load** → Nginx serves static HTML/CSS/JS → Browser runs ES module
2. **API call (public)** → Browser fetch → Nginx reverse-proxies `/api/*` to backend (port 8080 in docker-compose)
3. **API call (auth)** → Browser includes JWT in Authorization header → Backend validates JWT → Route executes

### Auth Model

- **Signup:** User visits `/setup.html` → creates account → registers FIDO2 passkey via WebAuthn
- **Login:** User visits `/login.html` → chooses passkey or email magic link → WebAuthn ceremony or email click → JWT issued
- **Protected routes:** Check `Authorization: Bearer <JWT>` header; JWT contains user ID + issued-at timestamp

**JWT structure:**
- Signed with `JWT_SECRET` (backend only)
- 7-day expiry (configurable)
- Contains userId
- Verified on every protected route

**Email magic links:**
- User requests link at `/api/auth/email/send`
- Backend generates random token, stores bcrypt hash in email_tokens table
- Email contains `/login.html?token=<raw-token>`
- On click: verify via `crypt(raw, stored_hash) = stored_hash` (constant-time comparison)
- Sets JWT, marks token as used

### Admin Panel

Single HTML file (`admin.html`) with inline JS (`admin.js`). Handles:
- Blog post CRUD
- Travel memory CRUD
- CV upload + file browser
- Deployment console (show status, trigger deploy, rollback)
- Stats (visit counts, error counts)

**Highest-risk file to touch.** Modifying it risks breaking multiple features. Read the full file before making changes. Test thoroughly.

---

## Common Patterns & Conventions

### Code style

**Naming:**
- Camel case for JS variables and functions
- Kebab case for HTML IDs, CSS classes
- Underscore case for database columns (post_date, user_id, etc.)

**Button variants (CSS):**
- `.btn-primary` — large blue (0.8rem padding, 1.5rem horizontal)
- `.btn-secondary` — large outlined (same padding, transparent bg, border)
- `.btn-small` — compact dark (0.35rem padding, 0.85rem horizontal)
- `.btn-danger` — red modifier (use with size class: `class="btn-small btn-danger"`)

**Section headers (JS comments):**
```js
// ── Section name (two em-dashes, space, label, NO trailing fill)
function doSomething() { ... }
```

**Database:** Always parameterised queries. Never string concatenation.
```js
// Good
const result = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
// Never
const result = await pool.query(`SELECT * FROM posts WHERE id = ${postId}`);
```

**DRY principle (Don't Repeat Yourself):**
- **Frontend:** Reuse utility functions from `resources/java/utils/`. Don't duplicate escapeHtml, formatDate, buildDOM patterns across modules.
- **Backend:** Extract common logic into middleware or route helpers. Don't repeat validation, error handling, or CORS logic.
- **Deployment scripts:** Extract reusable functions into `scripts/deploy/deploy-lib.sh` (shared helpers like `ensure_repo_cloned()`, `update_to_branch()`, `validate_env()`, `ensure_dev_certs()`). Each `*-deploy.sh` focuses on environment-specific logic only. PowerShell wrappers (`.ps1`) are thin — mostly SSH + arg passing.
- **Configuration:** Use single source of truth for CSP headers (nginx-security-headers.conf), environment templates (.env.*.example), and docker-compose settings.
- **When you find the same code in two places, extract it into a shared location.** Examples:
  - Same validation logic → create a validator utility
  - Same nginx headers → consolidate into a snippet
  - Same deploy step → move to deploy-lib.sh function
  - Same HTML structure → extract to a shared template or builder function

### Debugging & Logging

**Build observability into every change — it is part of the implementation, not a follow-up.** Deployment bugs and blind debugging have been the biggest recent time sink (ops-first priority — `ROADMAP.md` §3.5).

- Add structured log lines at meaningful decision points (entry, external-call outcomes, branch taken, failure reasons) — not just the happy path. Use a unique, greppable `[area] message — context` prefix.
- Log the *why* of a failure (error + relevant inputs + expectation), never secrets (`.env`, tokens, JWTs, hashes).
- A change isn't done until you can answer: "if this breaks in prod, how would we diagnose it from logs alone?" If you can't, add the logging before the PR.
- Deploy/infra changes: fail loud, not silent — surface orphan/port/env warnings as hard failures.
- Full rule: see **[docs/AI.md](docs/AI.md) → Debugging & Logging**.

### Testing

**Vitest suite:**
- `tests/` folder mirrors `backend/` structure
- Tests for middleware, validators, route handlers
- Run via `npm test` inside the backend container
- Coverage tracked; aim for routes and middleware, not 100% everywhere

**Smoke tests (per-PR):**
- `scripts/tests/Test-Regression.ps1` — baseline (all basic flows)
- `scripts/tests/Test-PRNNN.ps1` — specific PR tests (created as needed)
- Run on your machine to verify no regressions before merging

### Documentation

**When to write docs:**
- Adding a new database table → update `docs/DATABASE.md`
- Changing auth → update `docs/SECURITY.md`
- Adding a dependency → update `docs/DEPENDENCIES.md`
- New feature in deployment → update README or `docs/INFRASTRUCTURE.md` (coming)

**When NOT to add docs:**
- Generic "what this function does" — good naming is better than comments
- Obvious code patterns
- Implementation details that don't affect future work

**Commit messages:**
- Imperative present tense: "fix", "add", "refactor", not "fixed", "added", "refactored"
- Short summary (50 chars), blank line, optional explanation
- Always include `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>` footer

---

## High-Risk Areas

| File | Why | Mitigation |
|------|-----|----------|
| `admin.html` (18KB) | Monolithic, handles blog + travel + CV + deploy; one mistake breaks multiple features | Read full file before edits; test admin flows thoroughly |
| `backend/routes/auth.js` (12KB) | WebAuthn state machine is complex; JWT + magic links state must be correct | High test coverage; read full file; don't eyeball auth logic |
| `resources/java/admin.js` | Mirrors admin.html complexity; form logic for multiple post types | Test CRUD flows for blog + travel; check date field handling |
| `docker-compose.yml` | Volume mounts, env vars, networking — errors break the entire dev environment | Test `docker compose up/down/reset` after changes |
| `backend/db/schema.sql` | Idempotent, no migration tool — altering existing columns requires careful planning | Always use IF NOT EXISTS / IF NOT; test schema changes on a clean DB |

---

## Fragile / Incomplete Areas (from PROJECT_ASSESSMENT.md)

- **No backups:** Database and uploads have no automated backup. (#164)
- **No structured logging:** `console.log` used throughout; no severity levels or request context. (#152)
- **Admin.html monolithic:** 18KB single file; refactoring needed. (No issue yet; low priority)
- **No schema migration tool:** schema.sql is idempotent but has no version tracking. (#169)
- **PM2 in prod, Docker in dev:** Structural difference; moving prod to Docker is next big task. (#165)

---

## What's Not Here (But Is Documented Elsewhere)

- **Full test suite guide** → `docs/TESTING.md`
- **Database schema** → `docs/DATABASE.md`
- **Auth deep-dive** → `docs/SECURITY.md`
- **Naming & code patterns** → `docs/STYLE_GUIDE.md`
- **Branching rules** → README.md
- **Dependency rules** → `docs/DEPENDENCIES.md`
- **AI working instructions** → `docs/AI.md` (scope discipline, commit hygiene, workflow)

---

## Server Administration

### Text Editor

**micro** is the standard text editor for server-side work. It's modern, lightweight, and uses familiar shortcuts:

- **Install:** `sudo apt install micro`
- **Edit a file:** `micro ~/MyPortfolioSite-dev/.env`
- **Key shortcuts:**
  - `Ctrl+S` — save
  - `Ctrl+Q` — quit
  - `Ctrl+X/C/V` — cut/copy/paste
  - `Ctrl+F` — find & replace
  - `Ctrl+Z/Y` — undo/redo
  - Mouse support for selection and clicking

Set as your default editor:
```bash
echo 'export EDITOR=micro' >> ~/.bashrc
source ~/.bashrc
```

---

## Questions to Clarify Before Starting

- **Branching:** Are you working from `dev`? (Always. Only hotfix/* branches from main.)
- **Scope:** Is this a small bug fix, a feature, or refactoring? (Affects test strategy and commit style.)
- **Downtime:** Is some downtime acceptable? (For hobby project, yes. Affects deployment approach.)
- **Data:** Is any existing data being migrated, or is this a fresh setup? (Affects schema/backup concerns.)

---

## TL;DR — Just Starting Work?

1. Pull latest `dev`: `git fetch origin dev && git checkout dev && git pull`
2. Create branch: `git checkout -b fix/issue-N-short-desc`
3. Start Docker: `. scripts\dev\dev-local.ps1 up`
4. Make changes, test: `. scripts\dev\dev-local.ps1 test`
5. Commit: `git commit -m "imperative summary" && git add Co-Authored-By line`
6. Push and PR: `git push -u origin fix/issue-N-...` then `gh pr create --base dev`
   - Add `Closes #N` in PR body
   - Apply `awaiting review` tag to the issue
   - After merge to dev: apply `awaiting release` tag to the issue

Ask if anything is unclear.
