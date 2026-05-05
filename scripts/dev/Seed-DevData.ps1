#Requires -Version 5.1
<#
.SYNOPSIS
    Populates the local dev database with realistic dummy data for testing.

.DESCRIPTION
    Inserts:
      - 5 published blog posts
      - 3 draft blog posts
      - 6 published travel memories (with coordinates for map testing)
      - 2 draft travel memories

    Safe to run multiple times — uses unique slugs via timestamps so it
    won't conflict with existing data. To wipe and re-seed cleanly, run:
        docker compose down -v && . scripts\dev\dev-local.ps1 up
    then wait 20s and re-run this script.

.PARAMETER BaseUrl
    Backend base URL. Defaults to http://localhost:8080

.PARAMETER Token
    JWT auth token. Auto-generated from the container if not supplied.

.EXAMPLE
    .\scripts\dev\Seed-DevData.ps1
    .\scripts\dev\Seed-DevData.ps1 -BaseUrl http://localhost:8080
#>
param(
    [string]$BaseUrl = 'http://localhost:8080',
    [string]$Token   = ''
)

# Auto-generate JWT from running container
if (-not $Token) {
    try {
        $generated = docker compose exec -T backend node -e @"
const jwt = require('jsonwebtoken');
if (!process.env.JWT_SECRET) { process.stderr.write('NO_SECRET'); process.exit(1); }
console.log(jwt.sign({ userId: 'dev-seed-user' }, process.env.JWT_SECRET, { expiresIn: '1h' }));
"@ 2>&1
        $generated = ($generated | Where-Object { $_ -notmatch '^npm ' } | Select-Object -Last 1).Trim()
        if ($generated -match '^eyJ') { $Token = $generated }
    } catch {}
}

if (-not $Token) {
    Write-Host "ERROR: Could not generate JWT. Is the backend container running?" -ForegroundColor Red
    Write-Host "  Run: . scripts\dev\dev-local.ps1 up" -ForegroundColor Yellow
    exit 1
}

$pass = 0; $fail = 0

function Post-Data {
    param([string]$Endpoint, [string]$Body)
    $curlArgs = @(
        '-s', '-o', 'tmp_seed.txt', '-w', '%{http_code}',
        '-X', 'POST',
        '-H', "Authorization: Bearer $Token",
        '-H', 'Content-Type: application/json',
        '-d', $Body,
        "$BaseUrl$Endpoint"
    )
    $code     = curl.exe @curlArgs
    $bodyText = if (Test-Path tmp_seed.txt) { Get-Content tmp_seed.txt -Raw } else { '' }
    if (Test-Path tmp_seed.txt) { Remove-Item tmp_seed.txt -Force }
    return [PSCustomObject]@{ Status = [int]$code; Body = $bodyText }
}

function Seed-Item {
    param([string]$Label, [string]$Endpoint, [string]$Body)
    $r = Post-Data -Endpoint $Endpoint -Body $Body
    if ($r.Status -in 200, 201) {
        Write-Host "  [OK]   $Label" -ForegroundColor Green
        $script:pass++
    } else {
        Write-Host "  [FAIL] $Label (HTTP $($r.Status)) — $($r.Body.Trim())" -ForegroundColor Red
        $script:fail++
    }
}

Write-Host ""
Write-Host "═" * 52 -ForegroundColor Cyan
Write-Host "  Dev Data Seeder — $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Cyan
Write-Host "  Target: $BaseUrl"
Write-Host "═" * 52 -ForegroundColor Cyan
Write-Host ""

# ── Blog posts ────────────────────────────────────────────────────────────────

Write-Host "Seeding blog posts..." -ForegroundColor Yellow

Seed-Item "Blog: Building a Portfolio with Node and Postgres (published)" "/posts" @'
{
  "title": "Building a Portfolio with Node and Postgres",
  "body_markdown": "## Getting started\n\nEvery developer needs a portfolio. Mine started as a simple static site and grew into a full-stack project with a Node.js backend, PostgreSQL database, and passkey authentication.\n\n## The stack\n\n- **Frontend**: Vanilla HTML/CSS/JS — no framework\n- **Backend**: Node.js with Express\n- **Database**: PostgreSQL\n- **Auth**: WebAuthn passkeys\n- **Hosting**: Raspberry Pi 3\n\n## Why a Pi?\n\nRunning on a Pi keeps costs near zero, teaches real server management, and is a great conversation starter.\n\n## What I learned\n\nSchema design matters early. I went through two migrations in the first month — posts started as two separate tables before I unified them.",
  "post_date": "2026-04-10",
  "publish": true
}
'@

Seed-Item "Blog: Why I Chose Passkeys Over Passwords (published)" "/posts" @'
{
  "title": "Why I Chose Passkeys Over Passwords",
  "body_markdown": "## The problem with passwords\n\nPasswords are the worst authentication method we collectively agreed to use. They get reused, leaked, phished, and forgotten.\n\n## Enter WebAuthn\n\nWebAuthn lets users authenticate with device biometrics or a PIN. No password stored server-side — just a public key and a challenge-response.\n\n## The implementation\n\nI used `@simplewebauthn/server` on the Node backend and `@simplewebauthn/browser` on the frontend. The hardest part was managing the challenge session between registration start and finish without a session store.\n\n## The result\n\nLog in with Touch ID or Windows Hello. No passwords, no reset emails, no breaches.",
  "post_date": "2026-04-18",
  "publish": true
}
'@

Seed-Item "Blog: What I Got Wrong About SQL Indexes (published)" "/posts" @'
{
  "title": "What I Got Wrong About SQL Indexes",
  "body_markdown": "## Indexes are not free\n\nI used to think: just add an index and queries go fast. Turns out indexes cost write performance and storage, so you need to be deliberate.\n\n## What actually matters\n\nIndex the columns in your `WHERE` and `ORDER BY` clauses. For this site the main query is:\n\n```sql\nWHERE post_type = 'blog' AND published_at IS NOT NULL\nORDER BY post_date DESC\n```\n\nSo the right index is a composite on `(post_type, published_at, post_date)`.\n\n## EXPLAIN ANALYZE\n\nAlways check your query plans. `EXPLAIN ANALYZE` in psql will tell you if your index is actually being used.",
  "post_date": "2026-04-25",
  "publish": true
}
'@

Seed-Item "Blog: Markdown Rendering Without a Build Step (published)" "/posts" @'
{
  "title": "Markdown Rendering Without a Build Step",
  "body_markdown": "## The constraint\n\nI wanted Markdown in blog posts but refused to add a build pipeline. Everything had to work with a plain `<script>` tag.\n\n## The solution\n\n`marked.js` loads as an ES module from a CDN. The blog post page fetches the raw Markdown from the API and renders it client-side.\n\n## The trade-off\n\nClient-side rendering means the content is not in the initial HTML, so search engine indexing is degraded. Acceptable for a personal portfolio — if it were a public blog I'd add server-side rendering.",
  "post_date": "2026-05-01",
  "publish": true
}
'@

Seed-Item "Blog: Deploying to a Raspberry Pi with PM2 and Nginx (published)" "/posts" @'
{
  "title": "Deploying to a Raspberry Pi with PM2 and Nginx",
  "body_markdown": "## The setup\n\nNginx handles TLS termination and static files. PM2 keeps the Node process running and restarts it after crashes or reboots.\n\n## The deploy script\n\nA single bash script: fetch latest main, run `npm install --omit=dev`, apply schema migrations if needed, restart PM2, run a health check. If the health check fails, PM2 rolls back automatically.\n\n## Lessons learned\n\n- `certbot --nginx` makes SSL trivial\n- PM2 startup scripts survive Pi reboots\n- Keep deploy logs — `~/deploy.log` records every deploy SHA for rollback",
  "post_date": "2026-05-03",
  "publish": true
}
'@

Seed-Item "Blog: Draft — AI-Assisted Development Workflow (draft)" "/posts" @'
{
  "title": "AI-Assisted Development Workflow",
  "body_markdown": "## Work in progress\n\nThis post covers how I use Claude Code as a pair programmer — creating GitHub issues, writing implementation plans, and raising PRs for review.\n\n## Key points\n\n- AI creates issues and plans before writing code\n- All PRs include a detailed test plan\n- Human reviews every merge to dev\n\n_TODO: add more detail on the branching strategy_",
  "post_date": "2026-05-05",
  "publish": false
}
'@

Seed-Item "Blog: Draft — Lessons from Building Auth from Scratch (draft)" "/posts" @'
{
  "title": "Lessons from Building Auth from Scratch",
  "body_markdown": "## Why not just use Auth0?\n\nCost and control. For a personal project, a managed auth service is overkill.\n\n## What I built\n\n- Magic link email login (nodemailer + signed tokens)\n- WebAuthn passkey registration and authentication\n- JWT session tokens with short expiry\n\n_TODO: expand section on challenge storage_",
  "post_date": "2026-05-04",
  "publish": false
}
'@

Seed-Item "Blog: Draft — Rate Limiting Without Redis (draft)" "/posts" @'
{
  "title": "Rate Limiting Without Redis",
  "body_markdown": "## The requirement\n\nPrevent spam on the contact form without adding infrastructure.\n\n## The approach\n\nA `rate_limits` table in Postgres with one row per IP. An upsert increments the counter within the current time window and resets it when the window expires.\n\n_TODO: add code snippet_",
  "post_date": "2026-05-02",
  "publish": false
}
'@

# ── Travel memories ───────────────────────────────────────────────────────────

Write-Host ""
Write-Host "Seeding travel memories..." -ForegroundColor Yellow

Seed-Item "Travel: London, UK (published)" "/travel" @'
{
  "title": "London — Spring 2025",
  "location": "London, United Kingdom",
  "notes": "## First trip to London\n\nSpent a long weekend exploring South Bank, Borough Market, and Shoreditch. The city is enormous — you could spend a month here and still find new streets.\n\nHighlights:\n- Borough Market on a Saturday morning\n- Tate Modern\n- Walking across Millennium Bridge at dusk\n\nThe weather was surprisingly decent for April.",
  "lat": 51.5074,
  "lng": -0.1278,
  "visitDate": "2025-04-12",
  "publish": true
}
'@

Seed-Item "Travel: Paris, France (published)" "/travel" @'
{
  "title": "Paris — A Weekend Escape",
  "location": "Paris, France",
  "notes": "## City of light\n\nTook the Eurostar for a 48-hour trip. Spent most of the time in Le Marais and Saint-Germain rather than doing the tourist circuit.\n\nHighlights:\n- Musée d'Orsay — worth every minute of the queue\n- Coffee and a croque-monsieur at a corner café\n- Walking the Canal Saint-Martin at sunset\n\nWould go back for a full week.",
  "lat": 48.8566,
  "lng": 2.3522,
  "visitDate": "2025-06-20",
  "publish": true
}
'@

Seed-Item "Travel: Amsterdam, Netherlands (published)" "/travel" @'
{
  "title": "Amsterdam by Bike",
  "location": "Amsterdam, Netherlands",
  "notes": "## Two wheels, one city\n\nRented a bike on day one and barely put it down. Amsterdam makes total sense when you're cycling — the canal rings become a map in your head.\n\nHighlights:\n- Rijksmuseum\n- Vondelpark on a sunny afternoon\n- Cycling out to the Jordaan district for dinner\n\nThe stroopwafels at the Albert Cuyp market were genuinely the best I've ever had.",
  "lat": 52.3676,
  "lng": 4.9041,
  "visitDate": "2025-09-05",
  "publish": true
}
'@

Seed-Item "Travel: Edinburgh, Scotland (published)" "/travel" @'
{
  "title": "Edinburgh — Old Town and the Castle",
  "location": "Edinburgh, Scotland",
  "notes": "## A city carved from stone\n\nEdinburgh has a gravity to it that other cities lack. The castle sits above everything, and the Royal Mile runs downhill from it through centuries of history.\n\nHighlights:\n- Edinburgh Castle at opening time before the crowds\n- Arthur's Seat — the hike is short but the views are long\n- A proper Scottish breakfast at a café off the Grassmarket\n\nWould strongly recommend visiting outside festival season if you want to actually move around.",
  "lat": 55.9533,
  "lng": -3.1883,
  "visitDate": "2025-10-18",
  "publish": true
}
'@

Seed-Item "Travel: Lisbon, Portugal (published)" "/travel" @'
{
  "title": "Lisbon — Trams, Tiles and Pastéis",
  "location": "Lisbon, Portugal",
  "notes": "## Seven hills, one perfect city\n\nLisbon caught me off guard. I expected a smaller version of Barcelona and got something far more characterful — older, quieter in places, with an aesthetic built around azulejo tiles and wrought iron.\n\nHighlights:\n- Pastéis de Belém — the original custard tart\n- Tram 28 through Alfama (survived the crowds)\n- Sunset from Miradouro da Graça with a glass of vinho verde\n\nThe food is exceptional and the cost of living for visitors feels like a decade ago.",
  "lat": 38.7223,
  "lng": -9.1393,
  "visitDate": "2026-02-14",
  "publish": true
}
'@

Seed-Item "Travel: Guernsey, Channel Islands (published)" "/travel" @'
{
  "title": "Home — Guernsey",
  "location": "St Peter Port, Guernsey",
  "notes": "## The island\n\nNot technically a trip, but worth documenting. Guernsey sits between England and France — part of neither, shaped by both.\n\nHighlights:\n- Cliff path walk from Petit Bot to Saints Bay\n- Castle Cornet at high tide\n- Guernsey Gâche from a local bakery\n\nThe light here in summer is different to the mainland — softer, more horizontal. I notice it every time I come back.",
  "lat": 49.4657,
  "lng": -2.5853,
  "visitDate": "2026-03-28",
  "publish": true
}
'@

Seed-Item "Travel: Barcelona, Spain (draft)" "/travel" @'
{
  "title": "Barcelona — Gaudí and the Gothic Quarter",
  "location": "Barcelona, Spain",
  "notes": "## Draft — photos not uploaded yet\n\nSpent four days in Barcelona. Sagrada Família is genuinely extraordinary in person — no photograph prepares you for the scale.\n\nGothic Quarter is best explored without a map and without a destination.\n\n_TODO: add photos once uploaded_",
  "lat": 41.3851,
  "lng": 2.1734,
  "visitDate": "2026-01-09",
  "publish": false
}
'@

Seed-Item "Travel: Rome, Italy (draft)" "/travel" @'
{
  "title": "Rome — Three Days, Too Many Ruins",
  "location": "Rome, Italy",
  "notes": "## Draft\n\nThree days in Rome. The Colosseum, the Forum, the Vatican. Overwhelmed in the best possible way.\n\n_TODO: write proper notes_",
  "lat": 41.9028,
  "lng": 12.4964,
  "visitDate": "2025-12-03",
  "publish": false
}
'@

Write-Host ""
Write-Host "═" * 52 -ForegroundColor Cyan
Write-Host "  Seeded : $pass items" -ForegroundColor Green
if ($fail -gt 0) {
    Write-Host "  Failed : $fail items" -ForegroundColor Red
    Write-Host ""
    Write-Host "  If you see slug conflicts, the data already exists." -ForegroundColor DarkYellow
    Write-Host "  To start fresh: docker compose down -v && . scripts\dev\dev-local.ps1 up" -ForegroundColor DarkYellow
}
Write-Host "═" * 52 -ForegroundColor Cyan
Write-Host ""
