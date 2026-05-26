#!/usr/bin/env bash
# seed-dev-data.sh — Populate the dev-server database with realistic dummy data.
#
# Bash counterpart to Seed-DevData.ps1, targeting the Ubuntu dev-server stack
# (docker-compose.yml — service name and port read from .env, default: backend:8080).
#
# Inserts:
#   - 5 published blog posts, 3 drafts
#   - 6 published travel memories (with coordinates), 2 drafts
#
# Safe to run multiple times. To wipe and re-seed cleanly:
#   docker compose -f docker-compose.yml down -v
#   bash scripts/deploy/dev-deploy.sh <branch>
# then re-run this script.
#
# Usage (from the dev-branch checkout, e.g. ~/MyPortfolioSite-dev):
#   bash scripts/dev/seed-dev-data.sh
#
# Overridable via environment:
#   COMPOSE_FILE  (default: docker-compose.yml)
#   BACKEND_SVC   (default: BACKEND_SERVICE from .env, else backend)
#   BASE_URL      (default: http://localhost:<PORT from .env>, else http://localhost:8080)
#   TOKEN         (default: auto-generated from the running container's JWT_SECRET)

set -uo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"

# Read BACKEND_SERVICE and PORT from .env if present (set by compose unification).
# Explicit env vars always win; .env is the fallback; then safe built-in defaults.
_env_backend=""
_env_port=""
if [ -f ".env" ]; then
  _env_backend=$(grep -m1 '^BACKEND_SERVICE=' .env 2>/dev/null | cut -d= -f2- | tr -d '[:space:]')
  _env_port=$(grep -m1 '^PORT=' .env 2>/dev/null | cut -d= -f2- | tr -d '[:space:]')
fi
BACKEND_SVC="${BACKEND_SVC:-${_env_backend:-backend}}"
_default_port="${_env_port:-8080}"
BASE_URL="${BASE_URL:-http://localhost:${_default_port}}"
TOKEN="${TOKEN:-}"

pass=0
fail=0

# ── Auto-generate a JWT from the running backend container ─────────────────────
# The backend is an ESM package ("type": "module"), so require() is not
# available. Use dynamic import() instead.

if [ -z "$TOKEN" ]; then
  echo "[SEED] Generating JWT from backend container '$BACKEND_SVC'..." >&2

  JWT_DEBUG=$(mktemp)
  TOKEN=$(docker compose -f "$COMPOSE_FILE" exec -T "$BACKEND_SVC" node --input-type=module <<'JSEOF' \
    2>"$JWT_DEBUG" | tr -d '\r' | grep -E '^eyJ' | tail -1
import jwt from 'jsonwebtoken';
if (!process.env.JWT_SECRET) {
  console.error('[SEED JWT] ERROR: JWT_SECRET is not set in backend container');
  process.stderr.write('NO_SECRET\n');
  process.exit(1);
}
console.error(`[SEED JWT] Generated token with secret length: ${process.env.JWT_SECRET.length} chars`);
const token = jwt.sign({ userId: 'dev-seed-user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
console.log(token);
JSEOF
  )
  JWT_EXIT=$?

  if [ -f "$JWT_DEBUG" ] && [ -s "$JWT_DEBUG" ]; then
    echo "[SEED JWT] Backend messages:" >&2
    cat "$JWT_DEBUG" | sed 's/^/  /' >&2
  fi

  if [ $JWT_EXIT -ne 0 ]; then
    echo "[SEED JWT] JWT generation failed with exit code $JWT_EXIT" >&2
  elif [ -z "$TOKEN" ]; then
    echo "[SEED JWT] WARNING: Got exit 0 but no token (output grep failed)" >&2
  else
    echo "[SEED JWT] ✓ Token generated (${#TOKEN} chars, expires in 1h)" >&2
  fi

  rm -f "$JWT_DEBUG"
fi

if [ -z "$TOKEN" ]; then
  echo "" >&2
  echo "ERROR: Could not generate JWT. Troubleshooting checklist:" >&2
  echo "" >&2
  echo "  1. Container running?" >&2
  docker compose -f "$COMPOSE_FILE" ps "$BACKEND_SVC" 2>/dev/null | tail -1 >&2
  echo "" >&2
  echo "  2. JWT_SECRET set?" >&2
  docker compose -f "$COMPOSE_FILE" exec -T "$BACKEND_SVC" env 2>/dev/null | grep JWT_SECRET || echo "    [NOT SET]" >&2
  echo "" >&2
  echo "  3. Deploy first:" >&2
  echo "    .\\scripts\\deploy\\dev-deploy.ps1 -Branch <branch>" >&2
  echo "" >&2
  exit 1
fi

# ── Helpers ───────────────────────────────────────────────────────────────────────────────

# seed_item LABEL ENDPOINT  (JSON body read from stdin)
seed_item() {
  local label="$1" endpoint="$2" body code
  body=$(cat)
  code=$(curl -s -o /tmp/seed_resp.$$ -w '%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "$body" \
    "${BASE_URL}${endpoint}")
  if [ "$code" = "200" ] || [ "$code" = "201" ]; then
    echo "  [OK]   $label"
    pass=$((pass + 1))
  else
    echo "  [FAIL] $label (HTTP ${code}) — $(tr -d '\n' < /tmp/seed_resp.$$ 2>/dev/null)"
    fail=$((fail + 1))
  fi
  rm -f /tmp/seed_resp.$$
  return 0
}

echo ""
printf '%0.s=' {1..52}; echo ""
echo "  Dev Data Seeder — $(date '+%Y-%m-%d %H:%M:%S')"
echo "  Target: ${BASE_URL}"
printf '%0.s=' {1..52}; echo ""
echo ""

# ── Blog posts ───────────────────────────────────────────────────────────────────────────────
#
# ┌────────────────────────────────────────────────────────────────────────────┐
# │ CURATION NOTES — read before running.                                       │
# │ This merges three post sets into one journey:                               │
# │   [#203] = posts ported from PR #203 (project-journey narrative)            │
# │   [.sh]  = original seed posts from this script                             │
# │   [new]  = continuation posts (dev-server / HTTPS / CSP arc)                │
# │ DECISION 1-4 each hold a near-duplicate pair — KEEP ONE, delete the other.  │
# │ REVIEW A-B are related-but-distinct — probably keep both; trim if you want  │
# │ a single post on that theme. Grep "DECISION", "CHOOSE ONE", "REVIEW".       │
# └────────────────────────────────────────────────────────────────────────────┘

echo "Seeding blog posts..."

# ╔═══ DECISION 1 — PORTFOLIO INTRO — CHOOSE ONE, delete the other ════════════════════╗
# Both are the “why I built this / vanilla JS / Node+Postgres” opener.
# ── 1A  [#203]  "Building a Personal Portfolio in 2026" (2026-05-01) ──
# seed_item "Blog: Building a Personal Portfolio in 2026 (published)" "/posts" <<'JSON'
# {
#   "title": "Building a Personal Portfolio in 2026",
#   "body_markdown": "# Building a Personal Portfolio in 2026\n\nWhen I decided to create a new portfolio site, I wanted something that reflected my values: **simplicity, performance, and security**.\n\n## Why vanilla JavaScript?\n\nNo frameworks. No build step. Just HTML, CSS, and JavaScript—served directly by Nginx. This approach keeps the site lightning-fast and easy to understand. Frontend logic lives in self-contained ES modules: `script.js`, `blog.js`, `travel.js`, `admin.js`.\n\n## The backend\n\nNode.js with Express handles the API. PostgreSQL stores the data. Every query is parameterised—no SQL injection vulnerabilities here. Authentication uses WebAuthn (passkeys) and JWT tokens, because passwords are outdated.\n\n## What's next?\n\nThe site is a living project. As I build new features, I'll document the journey here. From security hardening to infrastructure decisions, every step is intentional.",
#   "post_date": "2026-05-01",
#   "publish": true
# }
# JSON
# ── 1B  [.sh]   "Building a Portfolio with Node and Postgres" (2026-04-10) ──
seed_item "Blog: Building a Portfolio with Node and Postgres (published)" "/posts" <<'JSON'
{
  "title": "Building a Portfolio with Node and Postgres",
  "body_markdown": "## Getting started\n\nEvery developer needs a portfolio. Mine started as a simple static site and grew into a full-stack project with a Node.js backend, PostgreSQL database, and passkey authentication.\n\n## The stack\n\n- **Frontend**: Vanilla HTML/CSS/JS — no framework\n- **Backend**: Node.js with Express\n- **Database**: PostgreSQL\n- **Auth**: WebAuthn passkeys\n- **Hosting**: Raspberry Pi 3\n\n## Why a Pi?\n\nRunning on a Pi keeps costs near zero, teaches real server management, and is a great conversation starter.\n\n## What I learned\n\nSchema design matters early. I went through two migrations in the first month — posts started as two separate tables before I unified them. Every query is parameterised—no SQL injection vulnerabilities here. Authentication uses WebAuthn (passkeys) and JWT tokens, because passwords are outdated.\n\n## What's next?\n\nThe site is a living project. As I build new features, I'll document the journey here. From security hardening to infrastructure decisions, every step is intentional.",
  "post_date": "2026-05-01",
  "publish": true
}
JSON
# ╚═══ END DECISION 1 ════════════════════════════════════════════════════════════════════════════╝

# ╔═══ DECISION 2 — PASSWORDLESS AUTH — CHOOSE ONE ═════════════════════════════╗
# ── 2A  [#203]  "Authentication Without Passwords: WebAuthn & JWT" (2026-05-02) ──
# seed_item "Blog: Authentication Without Passwords: WebAuthn & JWT (published)" "/posts" <<'JSON'
# {
#   "title": "Authentication Without Passwords: WebAuthn & JWT",
#   ...
# }
# JSON
# ── 2B  [.sh]   "Why I Chose Passkeys Over Passwords" (2026-04-18) ──
seed_item "Blog: Why I Chose Passkeys Over Passwords (published)" "/posts" <<'JSON'
{
  "title": "Why I Chose Passkeys Over Passwords",
  "body_markdown": "## The problem with passwords\n\nPasswords are the worst authentication method we collectively agreed to use. They get reused, leaked, phished, and forgotten.\n\n## Enter WebAuthn\n\nWebAuthn lets users authenticate with device biometrics or a PIN. No password stored server-side — just a public key and a challenge-response.\n\n## The implementation\n\nI used `@simplewebauthn/server` on the Node backend and `@simplewebauthn/browser` on the frontend. The hardest part was managing the challenge session between registration start and finish without a session store.\n\n## The result\n\nLog in with Touch ID or Windows Hello. No passwords, no reset emails, no breaches.",
  "post_date": "2026-04-18",
  "publish": true
}
JSON
# ╚═══ END DECISION 2 ════════════════════════════════════════════════════════════════════════════╝

seed_item "Blog: Markdown Rendering Without a Build Step (published)" "/posts" <<'JSON'
{
  "title": "Markdown Rendering Without a Build Step",
  "body_markdown": "## The constraint\n\nI wanted Markdown in blog posts but refused to add a build pipeline. Everything had to work with a plain `<script>` tag.\n\n## The solution\n\n`marked.js` loads as an ES module from a CDN. The blog post page fetches the raw Markdown from the API and renders it client-side.\n\n## The trade-off\n\nClient-side rendering means the content is not in the initial HTML, so search engine indexing is degraded. Acceptable for a personal portfolio — if it were a public blog I'd add server-side rendering.",
  "post_date": "2026-05-01",
  "publish": true
}
JSON

seed_item "Blog: Building a Travel Memory Archive (published)" "/posts" <<'JSON'
{
  "title": "Building a Travel Memory Archive",
  "body_markdown": "# Building a Travel Memory Archive\n\nTravel creates memories. A simple blog post can't capture the feeling of a place. So I built a travel feature that combines location, photos, timeline, and an interactive map.\n\n## What you can do\n\n- **Add a trip** — title, date, location (auto-geocoded), notes, and photos\n- **Coordinate steppers** — adjust latitude/longitude with tiny buttons (0.000001 degree precision)\n- **Geocode confirmation map** — see your marker on Leaflet before publishing\n- **Timeline view** — sorted by date, with a visual timeline on the blog page\n- **Lightbox gallery** — click photos to expand, swipe to navigate\n\n## Technical highlights\n\n- Leaflet.js for the interactive map (open-source, lightweight)\n- Custom coordinate stepper UI — hold the button to keep adjusting\n- Multi-file upload with validation (photos, videos)\n- Separate storage from blog posts (both use the same `posts` table with a `post_type` column)\n\n## Why it matters\n\nTravel memories deserve more than a text dump. This feature celebrates the places you've been and the moments you've captured.",
  "post_date": "2026-05-03",
  "publish": true
}
JSON

seed_item "Blog: The Admin Dashboard — CRUD for a One-Person Team (published)" "/posts" <<'JSON'
{
  "title": "The Admin Dashboard: CRUD for a One-Person Team",
  "body_markdown": "# The Admin Dashboard: CRUD for a One-Person Team\n\nManaging a blog, travel memories, CV uploads, and deployments from one interface—that's the admin dashboard. At 18KB of JavaScript, it's monolithic, but it works.\n\n## Features\n\n- **Blog posts** — create, edit, publish, draft, or delete\n- **Travel memories** — same CRUD, plus geocoding and photo upload\n- **CV manager** — upload a PDF, auto-scanned for private info (phone numbers, postcodes, emails)\n- **Deployment console** — deploy latest code, rollback to a previous commit, view logs\n- **Site stats** — visitor counts by page\n- **Passkey management** — add/remove signing devices\n- **Private notes** — saved to browser localStorage (not sent to server)\n\n## Why it's monolithic\n\nThree factors drive the size: multiple post types with different form layouts, form state across edit/create/publish/draft flows, and deployment controls with real-time polling. Refactoring into smaller modules would help — that's a future improvement.\n\n## Security\n\nOnly authenticated users can access the dashboard. JWT is required. CV uploads are validated server-side before storage.",
  "post_date": "2026-05-04",
  "publish": true
}
JSON

seed_item "Blog: Security First — CSP and Hardening (published)" "/posts" <<'JSON'
{
  "title": "Security First: Content Security Policy and Hardening",
  "body_markdown": "# Security First: Content Security Policy and Hardening\n\nA portfolio that handles authentication and uploads needs serious security. Here's what I implemented.\n\n## Content Security Policy (CSP)\n\nCSP tells the browser what resources are allowed to load. Mine is strict:\n\n```\ndefault-src 'self'\nscript-src 'self' https://unpkg.com https://cdn.jsdelivr.net\nstyle-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com\nfont-src 'self' https://fonts.gstatic.com\nimg-src 'self' data: https://*.tile.openstreetmap.org\nconnect-src 'self' http://localhost:8080\nframe-ancestors 'none'\n```\n\n- No inline scripts (all extracted to external files)\n- Only whitelisted CDNs for libraries\n- No framing (prevents clickjacking)\n- Strict referrer policy\n\n## Other headers\n\n- **X-Content-Type-Options: nosniff** — prevent MIME-type sniffing\n- **X-Frame-Options: DENY** — no clickjacking\n- **Referrer-Policy: strict-origin-when-cross-origin** — privacy-conscious\n\n## Input validation\n\nEvery form input is validated server-side. No trusting the client. SQL queries use parameterised statements—no concatenation, ever.\n\n## File uploads\n\nCV files are scanned for phone numbers, UK postcodes, and email addresses. If found, the upload is rejected with a message asking the user to redact.\n\n## What's left\n\nNo system is 100% secure. But these measures stop the most common attacks.",
  "post_date": "2026-05-05",
  "publish": true
}
JSON

seed_item "Blog: One Source of Truth for Security Headers (published)" "/posts" <<'JSON'
{
  "title": "One Source of Truth for Security Headers",
  "body_markdown": "## Three configs, three policies\n\nLocal, dev, and prod each had their own nginx config — and each had drifted to a slightly different Content-Security-Policy. Dev was missing the CDN that serves the WebAuthn library, which silently blocked passkeys. Classic copy-paste divergence.\n\n## The consolidation\n\nAll CSP and security headers now live in a single `nginx-security-headers.conf` snippet that every environment includes. One place to change, no drift.\n\n## A nasty sub-bug\n\nThe CSP had been written across multiple lines for readability. nginx bakes literal newlines into the header value, which truncates it on the wire — so the policy silently evaluated to almost nothing. Reformatting to a single line fixed it. Readability now lives in the comment block above the directive instead.\n\n## Plus: self-hosted error tracking\n\nWhile in there I added a lightweight error logger — uncaught errors, promise rejections, and CSP violations get POSTed to a backend route and logged to the container. No external service, full visibility.\n\n## Lesson\n\nDuplicated configuration is a bug waiting for the moment you forget one copy.",
  "post_date": "2026-05-15",
  "publish": true
}
JSON

seed_item "Blog: Docker & Nginx — Local Dev That Mirrors Production (published)" "/posts" <<'JSON'
{
  "title": "Docker & Nginx: Local Dev That Mirrors Production",
  "body_markdown": "# Docker & Nginx: Local Dev That Mirrors Production\n\nWhat works locally might not work in production. So I containerised everything—backend, database, reverse proxy—in Docker Compose.\n\n## The setup\n\n`docker-compose.yml` defines three services:\n- **postgres** — PostgreSQL database\n- **backend** — Node.js/Express app on port 8080 (internal)\n- **nginx** — reverse proxy on port 80/443 (localhost) or 3001 (dev server)\n\n## Why Nginx?\n\nThe backend shouldn't serve static files. Nginx does that. It serves HTML/CSS/JS from the repo root, proxies `/api/*` to the backend (stripping the prefix), enforces security headers, and handles HTTPS in production.\n\n## Local vs. production\n\n**Local** (`nginx-local.conf.template`): HTTP only, `connect-src 'self' http://localhost:8080`.\n\n**Production** (`nginx-portfolio.conf.template`): HTTPS with Let's Encrypt certs, `connect-src 'self' http://127.0.0.1:8080`, larger upload limit (25MB for multer).\n\n## The .env file\n\nSecrets stay out of git. `.env` (not in repo) defines `DATABASE_URL`, `JWT_SECRET`, and `SMTP_*`. Docker Compose reads from `.env` automatically.",
  "post_date": "2026-05-06",
  "publish": true
}
JSON

seed_item "Blog: A LAN-Only HTTPS Dev Environment (published)" "/posts" <<'JSON'
{
  "title": "A LAN-Only HTTPS Dev Environment",
  "body_markdown": "## Why dev needs HTTPS\n\nWebAuthn passkeys only work over a secure context. A plain-HTTP dev server can't exercise the single most important auth flow on the site, so dev needed real HTTPS — not just localhost.\n\n## The setup\n\nA second Docker Compose stack runs on the Ubuntu box, LAN-only on port 3001, behind nginx with a self-signed certificate. A deploy script handles cert generation, env validation, health checks, and automatic rollback to the last-good commit if a deploy fails.\n\n## Self-signed, but real\n\nThe browser still warns about the self-signed cert, but the connection is genuinely TLS — enough for passkeys to work and for the dev environment to mirror prod's security model.\n\n## Takeaway\n\nDev should be as close to prod as you can afford. The closer it is, the fewer surprises ship.",
  "post_date": "2026-05-11",
  "publish": true
}
JSON

seed_item "Blog: CI/CD and Deployment — From Dev to Raspberry Pi (published)" "/posts" <<'JSON'
{
  "title": "CI/CD and Deployment: From Dev to Raspberry Pi",
  "body_markdown": "# CI/CD and Deployment: From Dev to Raspberry Pi\n\nThe site lives on a Raspberry Pi. Updating it shouldn't require SSH and manual commands. So I built a deployment system.\n\n## The pipeline\n\n1. **Git push** to `dev` or `main` on GitHub\n2. **Admin dashboard** shows deployment status (commits ahead, last deployed SHA)\n3. **Deploy button** pulls latest code, rebuilds Docker images, restarts services\n4. **Health check** polls `/api/health` until the backend is ready\n5. **Rollback** can revert to any previous commit in 30 seconds\n\n## How it works\n\n- `scripts/deploy/prod-deploy.sh` — SSH into the Pi, pull latest, rebuild, health-check\n- `scripts/config/nginx-portfolio.conf.template` — rendered with envsubst before deploying\n- PM2 (on Pi) or Docker Compose (locally) keeps services running\n\n## Why this matters\n\nZero-downtime updates. Rollback on failure. No manual intervention. The site stays live.\n\n## What's next?\n\nMoving the Pi to an Ubuntu Server gaming PC. Same deployment script, bigger hardware.",
  "post_date": "2026-05-07",
  "publish": true
}
JSON

seed_item "Blog: Migrating Infrastructure — Raspberry Pi to Ubuntu Server (published)" "/posts" <<'JSON'
{
  "title": "Migrating Infrastructure: Raspberry Pi to Ubuntu Server",
  "body_markdown": "# Migrating Infrastructure: Raspberry Pi to Ubuntu Server\n\nThe Raspberry Pi served well for a hobby project. But with better hardware comes better possibilities: faster builds, more RAM, room to grow.\n\n## The challenge\n- **Dual environment** — run the `dev` branch on the new server alongside production\n- **Same playbook** — the deployment script should work on both machines\n\n## The solution\n\n**Two compose stacks:**\n- `docker-compose.yml` — production (port 80/443)\n- `docker-compose.yml` — development (port 3001, LAN-only)\n\nEach has its own PostgreSQL database (`portfolio_prod` vs `portfolio_dev`) and nginx instance (`nginx` port 443 vs port 3001). Both use the same `docker-compose.yml` with identical service names (`backend`, `postgres`, `nginx`) — environment isolation comes from `COMPOSE_PROJECT_NAME` and `.env` overrides, not service renaming.\n\n## LAN-only access\n\nThe dev server is only reachable on the local network. UFW firewall rules restrict access.\n\n## Benefits\n\n- Test new features on real hardware before merging to `main`\n- Two separate databases (can't accidentally corrupt production)\n- Deployment script handles both environments\n- Easy to add more instances (staging, etc.) later",
  "post_date": "2026-05-09",
  "publish": true
}
JSON

seed_item "Blog: The WebAuthn Gotcha — Passkeys Need a Real Hostname (published)" "/posts" <<'JSON'
{
  "title": "The WebAuthn Gotcha — Passkeys Need a Real Hostname",
  "body_markdown": "## The error\n\n`'rp.id' cannot be used with the current origin`\n\nThis appeared the moment I tried to register a passkey on the new dev server, and only there — localhost and prod were fine.\n\n## The cause\n\nThe dev setup used the server's LAN IP as the WebAuthn Relying Party ID. The WebAuthn spec rejects IP-address RP IDs outright: an IP has no registrable domain, so the browser refuses before the ceremony even starts. The dev config could never have worked.\n\n## The fix\n\nGive dev a real hostname (e.g. `dev.example.com`) pointed at the LAN IP via a hosts-file entry or LAN DNS. The RP ID, the origin, and the certificate SAN all have to agree on that hostname. I also added deploy-time validation that rejects an IP in the RP ID with an actionable message, so this can't silently regress.\n\n## Lesson\n\nWhen a spec says \"domain name,\" it means it. An IP literal is not a shortcut.",
  "post_date": "2026-05-14",
  "publish": true
}
JSON

# ── Drafts ──
seed_item "Blog: Draft — AI-Assisted Development Workflow" "/posts" <<'JSON'
{
  "title": "AI-Assisted Development Workflow",
  "body_markdown": "## Work in progress\n\nThis post covers how I use Claude as a pair programmer — creating GitHub issues, writing implementation plans, and raising PRs for review.\n\n## Key points\n\n- AI creates issues and plans before writing code\n- All PRs include a detailed test plan\n- Human reviews every merge to dev\n\n_TODO: add more detail on the branching strategy_",
  "post_date": "2026-05-05",
  "publish": false
}
JSON

seed_item "Blog: Draft — Lessons from Building Auth from Scratch" "/posts" <<'JSON'
{
  "title": "Lessons from Building Auth from Scratch",
  "body_markdown": "## Why not just use Auth0?\n\nCost and control. For a personal project, a managed auth service is overkill.\n\n## What I built\n\n- Magic link email login (nodemailer + signed tokens)\n- WebAuthn passkey registration and authentication\n- JWT session tokens with short expiry\n\n_TODO: expand section on challenge storage_",
  "post_date": "2026-05-04",
  "publish": false
}
JSON

seed_item "Blog: Draft — Rate Limiting Without Redis" "/posts" <<'JSON'
{
  "title": "Rate Limiting Without Redis",
  "body_markdown": "## The requirement\n\nPrevent spam on the contact form without adding infrastructure.\n\n## The approach\n\nA `rate_limits` table in Postgres with one row per IP. An upsert increments the counter within the current time window and resets it when the window expires.\n\n_TODO: add code snippet_",
  "post_date": "2026-05-02",
  "publish": false
}
JSON

seed_item "Blog: Migrating Email to Outlook OAuth2 (published)" "/posts" <<'JSON'
{
  "title": "Migrating Email to Outlook OAuth2",
  "body_markdown": "# Migrating Email to Outlook OAuth2\n\nMicrosoft disabled SMTP basic authentication on Outlook accounts. Overnight, the magic-link login and contact form stopped sending: `535 5.7.139 Authentication unsuccessful, basic authentication is disabled`. Time to move to OAuth2.\n\n## The wrong turns\n\nThe migration was a tour of every way OAuth2 can go sideways:\n\n- **Wrong Azure section.** I started in *Expose an API* (for apps that *are* an API). Email sending needs *API permissions* instead.\n- **Wrong scope.** The first token script requested `https://outlook.office365.com/.default` — Azure rejected it with `invalid_scope`. The correct scope is `https://graph.microsoft.com/Mail.Send`.\n- **Wrong endpoint.** A personal `outlook.com` account can't use the `/common/` token endpoint — it needs `/consumers/`.\n- **Wrong transport.** `nodemailer`'s SMTP OAuth2 wants a token scoped for `smtp.office365.com`, but my refresh token was scoped for Graph. Different resources, can't mix.\n\n## The fix that worked\n\nDrop SMTP entirely. Exchange the refresh token for a Graph access token and POST straight to `https://graph.microsoft.com/v1.0/me/sendMail`. One delegated `Mail.Send` permission, a one-time browser consent to capture a long-lived refresh token, and the backend sends mail silently forever after.\n\n## The infrastructure gotcha\n\nEven with correct code, emails failed — because the `OUTLOOK_*` variables were in `.env` but never passed through `docker-compose` to the container. And a tangle of orphaned containers from an old service rename meant my tests were hitting *stale code* the whole time. Lesson: when debugging \"impossible\" behaviour, verify *which container* is actually serving the request.\n\n## The payoff\n\nWorking OAuth2 email, plus a confirmed rate limiter (the `429` that finally proved requests were reaching the new code). No more basic-auth dependency, and the refresh token never expires unless unused for 90 days.",
  "post_date": "2026-05-15",
  "publish": true
}
JSON

# ── Travel memories ───────────────────────────────────────────────────────────────────────────────

echo ""
echo "Seeding travel memories..."

seed_item "Travel: London, UK (published)" "/travel" <<'JSON'
{
  "title": "London — Spring 2025",
  "location": "London, United Kingdom",
  "notes": "## First trip to London\n\nSpent a long weekend exploring South Bank, Borough Market, and Shoreditch. The city is enormous — you could spend a month here and still find new streets.\n\nHighlights:\n- Borough Market on a Saturday morning\n- Tate Modern\n- Walking across Millennium Bridge at dusk\n\nThe weather was surprisingly decent for April.",
  "lat": 51.5074,
  "lng": -0.1278,
  "post_date": "2025-04-12",
  "publish": true
}
JSON

seed_item "Travel: Paris, France (published)" "/travel" <<'JSON'
{
  "title": "Paris — A Weekend Escape",
  "location": "Paris, France",
  "notes": "## City of light\n\nTook the Eurostar for a 48-hour trip. Spent most of the time in Le Marais and Saint-Germain rather than doing the tourist circuit.\n\nHighlights:\n- Musée d'Orsay — worth every minute of the queue\n- Coffee and a croque-monsieur at a corner café\n- Walking the Canal Saint-Martin at sunset\n\nWould go back for a full week.",
  "lat": 48.8566,
  "lng": 2.3522,
  "post_date": "2025-06-20",
  "publish": true
}
JSON

seed_item "Travel: Amsterdam, Netherlands (published)" "/travel" <<'JSON'
{
  "title": "Amsterdam by Bike",
  "location": "Amsterdam, Netherlands",
  "notes": "## Two wheels, one city\n\nRented a bike on day one and barely put it down. Amsterdam makes total sense when you're cycling — the canal rings become a map in your head.\n\nHighlights:\n- Rijksmuseum\n- Vondelpark on a sunny afternoon\n- Cycling out to the Jordaan district for dinner\n\nThe stroopwafels at the Albert Cuyp market were genuinely the best I've ever had.",
  "lat": 52.3676,
  "lng": 4.9041,
  "post_date": "2025-09-05",
  "publish": true
}
JSON

seed_item "Travel: Edinburgh, Scotland (published)" "/travel" <<'JSON'
{
  "title": "Edinburgh — Old Town and the Castle",
  "location": "Edinburgh, Scotland",
  "notes": "## A city carved from stone\n\nEdinburgh has a gravity to it that other cities lack. The castle sits above everything, and the Royal Mile runs downhill from it through centuries of history.\n\nHighlights:\n- Edinburgh Castle at opening time before the crowds\n- Arthur's Seat — the hike is short but the views are long\n- A proper Scottish breakfast at a café off the Grassmarket\n\nWould strongly recommend visiting outside festival season if you want to actually move around.",
  "lat": 55.9533,
  "lng": -3.1883,
  "post_date": "2025-10-18",
  "publish": true
}
JSON

seed_item "Travel: Lisbon, Portugal (published)" "/travel" <<'JSON'
{
  "title": "Lisbon — Trams, Tiles and Pastéis",
  "location": "Lisbon, Portugal",
  "notes": "## Seven hills, one perfect city\n\nLisbon caught me off guard. I expected a smaller version of Barcelona and got something far more characterful — older, quieter in places, with an aesthetic built around azulejo tiles and wrought iron.\n\nHighlights:\n- Pastéis de Belém — the original custard tart\n- Tram 28 through Alfama (survived the crowds)\n- Sunset from Miradouro da Graça with a glass of vinho verde\n\nThe food is exceptional and the cost of living for visitors feels like a decade ago.",
  "lat": 38.7223,
  "lng": -9.1393,
  "post_date": "2026-02-14",
  "publish": true
}
JSON

seed_item "Travel: Guernsey, Channel Islands (published)" "/travel" <<'JSON'
{
  "title": "Home — Guernsey",
  "location": "St Peter Port, Guernsey",
  "notes": "## The island\n\nNot technically a trip, but worth documenting. Guernsey sits between England and France — part of neither, shaped by both.\n\nHighlights:\n- Cliff path walk from Petit Bot to Saints Bay\n- Castle Cornet at high tide\n- Guernsey Gâche from a local bakery\n\nThe light here in summer is different to the mainland — softer, more horizontal. I notice it every time I come back.",
  "lat": 49.4657,
  "lng": -2.5853,
  "post_date": "2026-03-28",
  "publish": true
}
JSON

seed_item "Travel: Barcelona, Spain (draft)" "/travel" <<'JSON'
{
  "title": "Barcelona — Gaudí and the Gothic Quarter",
  "location": "Barcelona, Spain",
  "notes": "## Draft — photos not uploaded yet\n\nSpent four days in Barcelona. Sagrada Família is genuinely extraordinary in person — no photograph prepares you for the scale.\n\nGothic Quarter is best explored without a map and without a destination.\n\n_TODO: add photos once uploaded_",
  "lat": 41.3851,
  "lng": 2.1734,
  "post_date": "2026-01-09",
  "publish": false
}
JSON

seed_item "Travel: Rome, Italy (draft)" "/travel" <<'JSON'
{
  "title": "Rome — Three Days, Too Many Ruins",
  "location": "Rome, Italy",
  "notes": "## Draft\n\nThree days in Rome. The Colosseum, the Forum, the Vatican. Overwhelmed in the best possible way.\n\n_TODO: write proper notes_",
  "lat": 41.9028,
  "lng": 12.4964,
  "post_date": "2025-12-03",
  "publish": false
}
JSON

echo ""
printf '%0.s=' {1..52}; echo ""
echo "  Seeded : $pass items"
if [ "$fail" -gt 0 ]; then
  echo "  Failed : $fail items"
  echo ""
  echo "  If you see slug conflicts, the data already exists."
  echo "  To start fresh: docker compose -f ${COMPOSE_FILE} down -v, redeploy, re-run."
fi
printf '%0.s=' {1..52}; echo ""
echo ""
