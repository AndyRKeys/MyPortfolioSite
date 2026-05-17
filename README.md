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
- A passkey-capable browser (Chrome, Safari, Edge)
- Node.js 20+ only needed if running without Docker

### Working against the dev server (preferred)

The canonical environment for development and testing is the shared dev server on `ak-home-server`. Local Docker dev via `dev-local.ps1` is kept as a fallback and may lag behind.

When working on a feature or fix:
- Use the usual git branching model (`feature/issue-N-*` / `fix/issue-N-*` from `dev`)
- Push your branch to GitHub
- Use the dev-server deployment scripts (see `docs/INFRASTRUCTURE.md` and `docs/DEPLOY_HOUSEKEEPING.md`) to run the latest `dev` branch on the server for manual testing

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

### dev-local.ps1 Reference

```powershell
. scripts\dev\dev-local.ps1 up             # Build & start all containers
. scripts\dev\dev-local.ps1 down           # Stop containers (DB volume preserved)
. scripts\dev\dev-local.ps1 reset          # Full teardown + rebuild — wipes local DB
. scripts\dev\dev-local.ps1 logs           # Tail backend container logs
. scripts\dev\dev-local.ps1 db             # Open a psql shell into the dev DB
. scripts\dev\dev-local.ps1 test           # Run automated test suite in container (fallback only)
. scripts\dev\dev-local.ps1 test:coverage  # Run tests with coverage report (fallback only)
```

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

# When ready — push your branch (no PR yet)
git push -u origin feature/issue-N-short-description

# Once work and testing on the branch are complete, open a PR to dev
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

... (rest of README unchanged) ...
