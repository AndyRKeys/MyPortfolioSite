# andykeys.me — Personal Portfolio Site

A full-stack personal portfolio site built with plain HTML/CSS/JS on the frontend and a Node.js/Express backend, self-hosted on an Ubuntu Server (`ak-home-server`) at [andykeys.me](https://andykeys.me).

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | HTML5, CSS3, vanilla JS, jQuery |
| Fonts | Space Grotesk (headings), Inter (body) via Google Fonts |
| Backend | Node.js, Express (ES modules) |
| Auth | WebAuthn/FIDO2 passkeys + email magic links, JWT |
| Database | PostgreSQL |
| Web server | Nginx (static files + reverse proxy) |
| Runtime | Docker Compose (backend + Postgres + Nginx containerised) |
| SSL | Let's Encrypt (certbot, auto-renewing) |
| DNS | Namecheap + dynamic DNS (ddclient) |
| Hosting | Self-hosted, Ubuntu Server (`ak-home-server`) |
| AI pair programmer | Claude (Anthropic) |

---

## Architecture

```
Browser → andykeys.me
       → Nginx :80/:443
           ├── /auth/*  → proxy → Node.js backend (Docker)
           │                        └── PostgreSQL
           └── /*       → static files
```

In production `config.js` exports `API = ''` so `/auth/*` calls are same-origin and Nginx proxies them to the backend. In local dev `API` auto-detects `localhost` and points directly to the backend port.

For a high-level view of where the project is heading and current priorities, see **[ROADMAP.md](./ROADMAP.md)**.

---

## Local Development

### Prerequisites
- Docker Desktop (recommended)
- A passkey-capable browser (Chrome, Safari, Edge)
- Node.js 20+ only needed if running without Docker

### Working against the dev server (preferred)

The canonical environment for development and testing is the shared dev server on `ak-home-server`. Local Docker dev via `dev-local.ps1` is kept as a fallback and may lag behind.

When working on a feature or fix:
- Use the usual git branching model (`feature/issue-N-*` / `fix/issue-N-*` from `dev`)
- Push your branch and open a PR to `dev` as soon as there is something to test
- Use the dev-server deployment scripts (see `docs/INFRASTRUCTURE.md` and `docs/DEV_ENVIRONMENT.md`) to run the latest `dev` branch on the server for manual testing

### Local Docker dev (fallback only)

Local Docker dev via `scripts\dev\dev-local.ps1` is still available but is no longer the primary path. It is useful when you cannot reach the dev server or need to debug something completely offline.

```powershell
# 1. Clone
git clone https://github.com/AndyRKeys/MyPortfolioSite.git
cd MyPortfolioSite

# 2. Copy env
cp .env.example .env

# 3. Start all services (Node backend, PostgreSQL, Nginx)
. scripts\dev\dev-local.ps1 up

# 4. Open in browser
# http://localhost
```

Services start in ~30s. PostgreSQL schema auto-initializes on first run. Backend source is volume-mounted so file changes are reflected without rebuilding.

Visit `http://localhost/setup.html` to create the admin account and register your first passkey.

### dev-local.ps1 Reference (fall-back only)

```powershell
. scripts\dev\dev-local.ps1 up             # Build & start all containers
. scripts\dev\dev-local.ps1 down           # Stop containers (DB volume preserved)
. scripts\dev\dev-local.ps1 reset          # Full teardown + rebuild — wipes local DB
. scripts\dev\dev-local.ps1 logs           # Tail backend container logs
. scripts\dev\dev-local.ps1 db             # Open a psql shell into the dev DB
. scripts\dev\dev-local.ps1 test           # Run automated test suite in container
. scripts\dev\dev-local.ps1 test:coverage  # Run tests with coverage report
```

**Troubleshooting:**
- **Port already in use**: Change `PORT`, `DB_PORT`, or Nginx port in `.env` or `docker-compose.yml`
- **Backend can't connect to DB**: Wait for PostgreSQL to be healthy — `docker compose logs postgres`
- **Schema not initialized**: `docker compose exec postgres psql -U postgres -d portfolio_dev -f /docker-entrypoint-initdb.d/01-schema.sql`
- **SMTP errors**: Leave `SMTP_*` vars blank if not testing email; the contact handler will return 500 in dev but validation tests will still pass

### Setup (Manual without Docker)

```bash
# 1. Clone
git clone https://github.com/AndyRKeys/MyPortfolioSite.git
cd MyPortfolioSite

# 2. Install backend dependencies
cd backend && npm install

# 3. Create the database and run schema
createdb <your-db-name>
psql -d <your-db-name> -f db/schema.sql

# 4. Configure environment
cp .env.example .env
# Edit .env — fill in DB credentials, JWT_SECRET, SMTP settings etc.

# 5. Start the backend
npm run dev
```

Serve the frontend with VS Code Live Server and open **http://localhost:3000** (not 127.0.0.1 — WebAuthn requires `localhost` or HTTPS).

---

## Testing

The **source of truth for tests is the dev server and CI**, not your local machine.

- For backend and integration tests, run the test suite on the dev server using the scripts documented in **[docs/TESTING.md](./docs/TESTING.md)**.
- GitHub Actions CI (`CI` workflow in `.github/workflows/ci.yml`) runs the same vitest suite defined in `backend/package.json` (`npm test`).
- Local Docker test commands via `dev-local.ps1 test` are now considered fallback only and may not match the exact dev-server configuration.

For per-PR smoke tests, run the relevant script from `scripts/tests/` on the dev server:

```powershell
.\scripts\tests\Test-PR104.ps1
```

No `-Token` flag needed — the script auto-generates a JWT from the container. See **[docs/TESTING.md](./docs/TESTING.md)** for the full guide.

---

## Branching Strategy

```
main  ←── release/YYYY-MM-DD ←── dev ←── feature/issue-N-description
                                     ←── fix/issue-N-description
main  ←── hotfix/issue-N-description (emergency fixes only)
```

| Branch | Purpose |
|--------|---------|
| `main` | Production — always deployable, mirrors what's live |
| `release/YYYY-MM-DD` | Release staging — branched from `dev`, PR'd to `main` |
| `dev` | Integration branch — features and fixes merge here first |
| `feature/issue-N-*` | Feature per GitHub Issue |
| `fix/issue-N-*` | Bug fix per GitHub Issue |
| `hotfix/issue-N-*` | Emergency production fix — branched from `main` |

### Workflow

```bash
# Start a new feature
git checkout dev
git pull origin dev
git checkout -b feature/issue-N-short-description

# Work and commit
git add <files>
git commit -m "Description of change"

# When ready — push and open a PR to dev
git push -u origin feature/issue-N-short-description
gh pr create --base dev --title "..." --body "Closes #N"

# After testing on dev — PR dev → main to deploy
gh pr create --base main --head dev --title "Release: ..."
```

### Commit style

```
Short imperative summary (50 chars max)

Optional explanation if the why isn't obvious.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

---

## Deployment

### Deploy latest changes (from Windows)

```powershell
.\scripts\deploy\prod-deploy.ps1
```

This SSHs into the server (`ak-home-server`) and runs `scripts/deploy/prod-deploy.sh`, which:
1. Fetches and lists what changed
2. Pulls the latest code
3. Pulls the target branch and rebuilds images
4. Re-runs `backend/db/schema.sql` (idempotent — `IF NOT EXISTS`)
5. Brings the stack up with `docker compose -f docker-compose.prod.yml up -d --build`
6. Reports container status via `docker compose -f docker-compose.prod.yml ps`

### What needs a restart?

The whole stack is containerised, so a deploy rebuilds and recreates the affected containers. There is no separate process manager to restart.

| Change type | Action needed |
|-------------|--------------|
| HTML / CSS / JS (frontend) | None — Nginx serves files directly |
| Backend `.js` files | Auto: image rebuild + `docker compose up -d --build` recreates the backend container |
| `package.json` / new deps | Auto: image rebuild reinstalls deps, container recreated |
| `backend/db/schema.sql` | Auto: re-runs schema (uses `IF NOT EXISTS`) on boot |
| `scripts/config/nginx-*.conf.template` | Auto: rendered + validated with `nginx -t` before the Nginx container reloads |
| `.env` | Edit on server manually, then re-run the deploy (Compose reloads env on recreate) |

### Useful server commands

> Prod uses `docker-compose.prod.yml`. SSH into the server first, then run from the repo directory.

```bash
# Check backend logs
docker compose -f docker-compose.prod.yml logs --tail=50 backend

# Check container status
docker compose -f docker-compose.prod.yml ps

# Restart the backend container
docker compose -f docker-compose.prod.yml restart backend

# Check Nginx (containerised — via Compose, not systemd)
docker compose -f docker-compose.prod.yml logs --tail=50 nginx

# Renew SSL cert (also auto-renews via systemd timer)
ssh <hostname> "sudo certbot renew"
```

---

## Scripts

```
scripts/
├── dev/
│   ├── dev-local.ps1       Windows wrapper for all local dev commands
│   ├── dev-local.sh        Bash equivalent (Linux/Mac/WSL)
│   ├── debug-network.sh    Network diagnostics helper
│   └── watch-logs.sh       Tail multiple log streams
├── deploy/
│   ├── prod-deploy.sh      Smart deploy — runs on the server, detects what changed
│   ├── prod-deploy.ps1     Trigger deploy from Windows via SSH
│   ├── pi-setup.sh         Full server setup from scratch
│   ├── install-monitor.sh  Install monitoring tooling
│   ├── monitor.sh          Runtime monitoring script
│   ├── fix-apache.ps1      Disable Apache, enable Nginx
│   ├── setup-ssl.ps1       Install certbot and obtain SSL cert
│   ├── setup-nginx-ssl.ps1 Configure Nginx for HTTPS
│   ├── nginx-local.conf.template
│   └── nginx-portfolio.conf.template
└── tests/
    ├── Test-PR96.ps1       Smoke tests for PR #96
    └── Test-PR104.ps1      Smoke tests for PR #104
```

---

## Environment Variables (`backend/.env`)

Copy `backend/.env.example` and fill in values. **Never commit `.env`.**

| Variable | Description |
|----------|-------------|
| `PORT` | Backend port |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | PostgreSQL connection |
| `JWT_SECRET` | Long random secret for signing tokens |
| `JWT_EXPIRY` | Token lifetime (e.g. `7d`) |
| `WEBAUTHN_RP_ID` | Domain for WebAuthn (e.g. `andykeys.me` or `localhost`) |
| `WEBAUTHN_ORIGIN` | Full origin (e.g. `https://andykeys.me` or `http://localhost:3000`) |
| `FRONTEND_URL` | CORS allowed origin |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Email magic link sending |
| `ADMIN_EMAIL` | Address magic links are sent to |

---

## Outstanding Issues

Feature backlog is tracked in [GitHub Issues](https://github.com/AndyRKeys/MyPortfolioSite/issues).

---

## Documentation

| Document | Purpose |
|----------|---------|
| **README.md** | Architecture, tech stack, local dev setup |
| **[docs/AI.md](./docs/AI.md)** | Pair programming instructions, scope discipline, commit conventions |
| **[docs/STYLE_GUIDE.md](./docs/STYLE_GUIDE.md)** | Naming conventions, code patterns, button variants |
| **[docs/TESTING.md](./docs/TESTING.md)** | Test suite structure, how to run tests, smoke test examples |
| **[docs/DATABASE.md](./docs/DATABASE.md)** | PostgreSQL schema reference, tables, columns, constraints |
| **[docs/SECURITY.md](./docs/SECURITY.md)** | Auth model, JWT, WebAuthn, protected routes, threat model |
| **[docs/UNTRACKED_FILES.md](./docs/UNTRACKED_FILES.md)** | Files not in git but required (`.env`, certs, uploads) |
| **[docs/INFRASTRUCTURE.md](./docs/INFRASTRUCTURE.md)** | Host-level infra, both environments, backups, Dropbear unlock |
| **[docs/DEV_ENVIRONMENT.md](./docs/DEV_ENVIRONMENT.md)** | Dev server Docker stack, dev `.env`, dev deploy scripts |
| **[docs/PROD_ENVIRONMENT.md](./docs/PROD_ENVIRONMENT.md)** | Prod Docker stack, prod `.env`, prod deploy scripts |
| **[ROADMAP.md](./ROADMAP.md)** | Current priorities, known issues, future work |

---

## AI Onboarding Prompt

Copy and paste the prompt below at the start of any new AI pair programming session. It instructs the agent to read all project documentation and familiarise itself with the codebase before doing any work.

```
You are pair programming with me on my personal portfolio site. Before we start
any work, please familiarise yourself with the project by reading the following
documents in order — do not skip any:

1. README.md                   — architecture, local dev setup, branching strategy,
                                 deploy process, and scripts reference
2. docs/AI.md                  — your working instructions: scope discipline, workflow,
                                 commit conventions, documentation hygiene rules,
                                 branching guardrails, and code style rules
3. docs/STYLE_GUIDE.md         — naming conventions, alignment, JS/CSS/HTML patterns
4. docs/TESTING.md             — test suite structure, how to run tests, PR smoke
                                 test template, and what is/isn't tested
5. docs/DATABASE.md            — full database schema reference (tables, columns, constraints)
6. docs/SECURITY.md            — auth model, JWT, protected routes, and threat model
7. docs/UNTRACKED_FILES.md     — files not in git but critical (.env, certs, uploads,
                                 how they're created, how to restore)
7. docs/DEPENDENCIES.md        — rules for adding, updating, and removing dependencies
8. backend/db/schema.sql       — raw schema SQL

Then do a quick orientation of the repo structure:
- List the top-level folders and describe the purpose of each
- Skim backend/app.js and backend/routes/ to understand the API surface
- Note any open GitHub Issues that are relevant to the work we're about to do

Once you have read all of the above and completed the orientation, confirm with
a short summary covering:
- The tech stack and how the pieces fit together
- The branching model and where new work should be branched from
- The test approach and how to run the suite
- Any documentation hygiene rules I should know you have internalised
- Any open issues or anything that looks incomplete or worth flagging

Do not write any code or propose any changes until I give you a task.
```
