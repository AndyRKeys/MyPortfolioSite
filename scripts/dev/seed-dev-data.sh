#!/usr/bin/env bash
# seed-dev-data.sh — Populate the dev-server database with realistic dummy data.
#
# Bash counterpart to Seed-DevData.ps1, targeting the Ubuntu dev-server stack
# (docker-compose.dev-server.yml — service backend-dev on port 8081).
#
# Inserts:
#   - 5 published blog posts, 3 drafts
#   - 6 published travel memories (with coordinates), 2 drafts
#
# Safe to run multiple times. To wipe and re-seed cleanly:
#   docker compose -f docker-compose.dev-server.yml down -v
#   bash scripts/deploy/dev-deploy.sh <branch>
# then re-run this script.
#
# Usage (from the dev-branch checkout, e.g. ~/MyPortfolioSite-dev):
#   bash scripts/dev/seed-dev-data.sh
#
# Overridable via environment:
#   COMPOSE_FILE  (default: docker-compose.dev-server.yml)
#   BACKEND_SVC   (default: backend-dev)
#   BASE_URL      (default: http://localhost:8081)  — backend direct, no /api prefix
#   TOKEN         (default: auto-generated from the running container's JWT_SECRET)

set -uo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.dev-server.yml}"
BACKEND_SVC="${BACKEND_SVC:-backend-dev}"
BASE_URL="${BASE_URL:-http://localhost:8081}"
TOKEN="${TOKEN:-}"

pass=0
fail=0

# ── Auto-generate a JWT from the running backend container ─────────────────────

if [ -z "$TOKEN" ]; then
  TOKEN=$(docker compose -f "$COMPOSE_FILE" exec -T "$BACKEND_SVC" node -e \
'const jwt=require("jsonwebtoken");if(!process.env.JWT_SECRET){process.stderr.write("NO_SECRET");process.exit(1);}console.log(jwt.sign({userId:"dev-seed-user"},process.env.JWT_SECRET,{expiresIn:"1h"}));' \
    2>/dev/null | tr -d '\r' | grep -E '^eyJ' | tail -1)
fi

if [ -z "$TOKEN" ]; then
  echo "ERROR: Could not generate JWT. Is the '$BACKEND_SVC' container running?" >&2
  echo "  Deploy first: bash scripts/deploy/dev-deploy.sh <branch>" >&2
  exit 1
fi

# ── Helpers ───────────────────────────────────────────────────────────────────

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

# ── Blog posts ────────────────────────────────────────────────────────────────

echo "Seeding blog posts..."

seed_item "Blog: Building a Portfolio with Node and Postgres (published)" "/posts" <<'JSON'
{
  "title": "Building a Portfolio with Node and Postgres",
  "body_markdown": "## Getting started\n\nEvery developer needs a portfolio. Mine started as a simple static site and grew into a full-stack project with a Node.js backend, PostgreSQL database, and passkey authentication.\n\n## The stack\n\n- **Frontend**: Vanilla HTML/CSS/JS — no framework\n- **Backend**: Node.js with Express\n- **Database**: PostgreSQL\n- **Auth**: WebAuthn passkeys\n- **Hosting**: Raspberry Pi 3\n\n## Why a Pi?\n\nRunning on a Pi keeps costs near zero, teaches real server management, and is a great conversation starter.\n\n## What I learned\n\nSchema design matters early. I went through two migrations in the first month — posts started as two separate tables before I unified them.",
  "post_date": "2026-04-10",
  "publish": true
}
JSON

seed_item "Blog: Why I Chose Passkeys Over Passwords (published)" "/posts" <<'JSON'
{
  "title": "Why I Chose Passkeys Over Passwords",
  "body_markdown": "## The problem with passwords\n\nPasswords are the worst authentication method we collectively agreed to use. They get reused, leaked, phished, and forgotten.\n\n## Enter WebAuthn\n\nWebAuthn lets users authenticate with device biometrics or a PIN. No password stored server-side — just a public key and a challenge-response.\n\n## The implementation\n\nI used `@simplewebauthn/server` on the Node backend and `@simplewebauthn/browser` on the frontend. The hardest part was managing the challenge session between registration start and finish without a session store.\n\n## The result\n\nLog in with Touch ID or Windows Hello. No passwords, no reset emails, no breaches.",
  "post_date": "2026-04-18",
  "publish": true
}
JSON

seed_item "Blog: What I Got Wrong About SQL Indexes (published)" "/posts" <<'JSON'
{
  "title": "What I Got Wrong About SQL Indexes",
  "body_markdown": "## Indexes are not free\n\nI used to think: just add an index and queries go fast. Turns out indexes cost write performance and storage, so you need to be deliberate.\n\n## What actually matters\n\nIndex the columns in your `WHERE` and `ORDER BY` clauses. For this site the main query is:\n\n```sql\nWHERE post_type = 'blog' AND published_at IS NOT NULL\nORDER BY post_date DESC\n```\n\nSo the right index is a composite on `(post_type, published_at, post_date)`.\n\n## EXPLAIN ANALYZE\n\nAlways check your query plans. `EXPLAIN ANALYZE` in psql will tell you if your index is actually being used.",
  "post_date": "2026-04-25",
  "publish": true
}
JSON

seed_item "Blog: Markdown Rendering Without a Build Step (published)" "/posts" <<'JSON'
{
  "title": "Markdown Rendering Without a Build Step",
  "body_markdown": "## The constraint\n\nI wanted Markdown in blog posts but refused to add a build pipeline. Everything had to work with a plain `<script>` tag.\n\n## The solution\n\n`marked.js` loads as an ES module from a CDN. The blog post page fetches the raw Markdown from the API and renders it client-side.\n\n## The trade-off\n\nClient-side rendering means the content is not in the initial HTML, so search engine indexing is degraded. Acceptable for a personal portfolio — if it were a public blog I'd add server-side rendering.",
  "post_date": "2026-05-01",
  "publish": true
}
JSON

seed_item "Blog: Deploying to a Raspberry Pi with PM2 and Nginx (published)" "/posts" <<'JSON'
{
  "title": "Deploying to a Raspberry Pi with PM2 and Nginx",
  "body_markdown": "## The setup\n\nNginx handles TLS termination and static files. PM2 keeps the Node process running and restarts it after crashes or reboots.\n\n## The deploy script\n\nA single bash script: fetch latest main, run `npm install --omit=dev`, apply schema migrations if needed, restart PM2, run a health check. If the health check fails, PM2 rolls back automatically.\n\n## Lessons learned\n\n- `certbot --nginx` makes SSL trivial\n- PM2 startup scripts survive Pi reboots\n- Keep deploy logs — `~/deploy.log` records every deploy SHA for rollback",
  "post_date": "2026-05-03",
  "publish": true
}
JSON

seed_item "Blog: Goodbye Raspberry Pi, Hello Ubuntu Server (published)" "/posts" <<'JSON'
{
  "title": "Goodbye Raspberry Pi, Hello Ubuntu Server",
  "body_markdown": "## Outgrowing the Pi\n\nThe Raspberry Pi 3 served this site well for over a year, but the cracks were showing: `npm install` took minutes, image uploads were sluggish, and running tests on-device was painful.\n\n## The new home\n\nI repurposed an Ubuntu Server box (an old gaming PC) as the new host. Same site, far more headroom.\n\n## The real work was Docker\n\nProd had been running on PM2 directly on the Pi while dev used Docker Compose — a structural mismatch that caused \"works on dev, breaks on prod\" surprises. The migration was the chance to put prod in Docker too, so both environments finally run identical containers.\n\n## Lessons\n\n- A structural difference between dev and prod is technical debt, even when both \"work\"\n- Migrating hosting is a good forcing function to delete accumulated cruft\n- Keep the old host running until the new one is proven",
  "post_date": "2026-05-08",
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

seed_item "Blog: The WebAuthn Gotcha — Passkeys Need a Real Hostname (published)" "/posts" <<'JSON'
{
  "title": "The WebAuthn Gotcha — Passkeys Need a Real Hostname",
  "body_markdown": "## The error\n\n`'rp.id' cannot be used with the current origin`\n\nThis appeared the moment I tried to register a passkey on the new dev server, and only there — localhost and prod were fine.\n\n## The cause\n\nThe dev setup used the server's LAN IP as the WebAuthn Relying Party ID. The WebAuthn spec rejects IP-address RP IDs outright: an IP has no registrable domain, so the browser refuses before the ceremony even starts. The dev config could never have worked.\n\n## The fix\n\nGive dev a real hostname (e.g. `dev.example.com`) pointed at the LAN IP via a hosts-file entry or LAN DNS. The RP ID, the origin, and the certificate SAN all have to agree on that hostname. I also added deploy-time validation that rejects an IP in the RP ID with an actionable message, so this can't silently regress.\n\n## Lesson\n\nWhen a spec says \"domain name,\" it means it. An IP literal is not a shortcut.",
  "post_date": "2026-05-14",
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

seed_item "Blog: Draft — AI-Assisted Development Workflow (draft)" "/posts" <<'JSON'
{
  "title": "AI-Assisted Development Workflow",
  "body_markdown": "## Work in progress\n\nThis post covers how I use Claude Code as a pair programmer — creating GitHub issues, writing implementation plans, and raising PRs for review.\n\n## Key points\n\n- AI creates issues and plans before writing code\n- All PRs include a detailed test plan\n- Human reviews every merge to dev\n\n_TODO: add more detail on the branching strategy_",
  "post_date": "2026-05-05",
  "publish": false
}
JSON

seed_item "Blog: Draft — Lessons from Building Auth from Scratch (draft)" "/posts" <<'JSON'
{
  "title": "Lessons from Building Auth from Scratch",
  "body_markdown": "## Why not just use Auth0?\n\nCost and control. For a personal project, a managed auth service is overkill.\n\n## What I built\n\n- Magic link email login (nodemailer + signed tokens)\n- WebAuthn passkey registration and authentication\n- JWT session tokens with short expiry\n\n_TODO: expand section on challenge storage_",
  "post_date": "2026-05-04",
  "publish": false
}
JSON

seed_item "Blog: Draft — Rate Limiting Without Redis (draft)" "/posts" <<'JSON'
{
  "title": "Rate Limiting Without Redis",
  "body_markdown": "## The requirement\n\nPrevent spam on the contact form without adding infrastructure.\n\n## The approach\n\nA `rate_limits` table in Postgres with one row per IP. An upsert increments the counter within the current time window and resets it when the window expires.\n\n_TODO: add code snippet_",
  "post_date": "2026-05-02",
  "publish": false
}
JSON

# ── Travel memories ───────────────────────────────────────────────────────────

echo ""
echo "Seeding travel memories..."

seed_item "Travel: London, UK (published)" "/travel" <<'JSON'
{
  "title": "London — Spring 2025",
  "location": "London, United Kingdom",
  "notes": "## First trip to London\n\nSpent a long weekend exploring South Bank, Borough Market, and Shoreditch. The city is enormous — you could spend a month here and still find new streets.\n\nHighlights:\n- Borough Market on a Saturday morning\n- Tate Modern\n- Walking across Millennium Bridge at dusk\n\nThe weather was surprisingly decent for April.",
  "lat": 51.5074,
  "lng": -0.1278,
  "visitDate": "2025-04-12",
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
  "visitDate": "2025-06-20",
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
  "visitDate": "2025-09-05",
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
  "visitDate": "2025-10-18",
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
  "visitDate": "2026-02-14",
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
  "visitDate": "2026-03-28",
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
  "visitDate": "2026-01-09",
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
  "visitDate": "2025-12-03",
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
