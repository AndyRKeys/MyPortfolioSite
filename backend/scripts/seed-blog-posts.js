// Seed script: populate blog with posts detailing the portfolio site journey.
// Run with: node backend/scripts/seed-blog-posts.js

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/portfolio_dev',
});

const blogPosts = [
    {
        title: 'Building a Personal Portfolio in 2026',
        body: `# Building a Personal Portfolio in 2026

When I decided to create a new portfolio site, I wanted something that reflected my values: **simplicity, performance, and security**.

## Why vanilla JavaScript?

No frameworks. No build step. Just HTML, CSS, and JavaScript—served directly by Nginx. This approach keeps the site lightning-fast and easy to understand. Frontend logic lives in self-contained ES modules: \`script.js\`, \`blog.js\`, \`travel.js\`, \`admin.js\`.

## The backend

Node.js with Express handles the API. PostgreSQL stores the data. Every query is parameterised—no SQL injection vulnerabilities here. Authentication uses WebAuthn (passkeys) and JWT tokens, because passwords are outdated.

## What's next?

The site is a living project. As I build new features, I'll document the journey here. From security hardening to infrastructure decisions, every step is intentional.`,
        is_published: true,
        post_date: '2026-05-01'
    },
    {
        title: 'Authentication Without Passwords: WebAuthn & JWT',
        body: `# Authentication Without Passwords: WebAuthn & JWT

Passwords are the weakest link in security. So I built a system where you sign in with your device's biometrics or PIN—no password needed.

## How it works

1. **Registration** — You create an account and register a FIDO2 passkey via WebAuthn
2. **Sign-in** — Browser runs the WebAuthn ceremony; your device confirms your identity
3. **Token issuance** — Backend verifies the ceremony and issues a JWT valid for 7 days
4. **Protected routes** — Every admin API checks for a valid JWT before executing

## Email magic links as backup

Not everyone has a passkey yet. For those users, we offer email magic links:
- Request a link → random token stored (bcrypt hashed)
- Click the link → token verified (constant-time comparison)
- JWT issued automatically

## Why this matters

WebAuthn is phishing-resistant. A malicious site can't intercept your passkey. Your device won't complete the ceremony for the wrong origin. Combined with HTTPS, this is security that actually works.`,
        is_published: true,
        post_date: '2026-05-02'
    },
    {
        title: 'Building a Travel Memory Archive',
        body: `# Building a Travel Memory Archive

Travel creates memories. A simple blog post can't capture the feeling of a place. So I built a travel feature that combines location, photos, timeline, and an interactive map.

## What you can do

- **Add a trip** — title, date, location (auto-geocoded), notes, and photos
- **Coordinate steppers** — adjust latitude/longitude with tiny buttons (0.000001° precision)
- **Geocode confirmation map** — see your marker on Leaflet before publishing
- **Timeline view** — sorted by date, with a visual timeline on the blog page
- **Lightbox gallery** — click photos to expand, swipe to navigate

## Technical highlights

- Leaflet.js for the interactive map (open-source, lightweight)
- Custom coordinate stepper UI (issue #39) — hold the button to keep adjusting
- Multi-file upload with validation (photos, videos)
- Separate storage from blog posts (both use the same \`posts\` table with a \`post_type\` column)

## Why it matters

Travel memories deserve more than a text dump. This feature celebrates the places you've been and the moments you've captured.`,
        is_published: true,
        post_date: '2026-05-03'
    },
    {
        title: 'The Admin Dashboard: CRUD for a One-Person Team',
        body: `# The Admin Dashboard: CRUD for a One-Person Team

Managing a blog, travel memories, CV uploads, and deployments from one interface—that's the admin dashboard. At 18KB of JavaScript, it's monolithic, but it works.

## Features

- **Blog posts** — create, edit, publish, draft, or delete
- **Travel memories** — same CRUD, plus geocoding and photo upload
- **CV manager** — upload a PDF, auto-scanned for private info (phone numbers, postcodes, emails)
- **Deployment console** — deploy latest code, rollback to a previous commit, view logs
- **Site stats** — visitor counts by page
- **Passkey management** — add/remove signing devices
- **Private notes** — saved to browser localStorage (not sent to server)

## Why it's monolithic

Three issues drive the size:
1. Multiple post types (blog + travel) with different form layouts
2. Form state management across edit/create/publish/draft flows
3. Deployment controls with real-time polling

Refactoring into smaller modules would help. That's a future improvement (#?).

## Security

Only authenticated users can access the dashboard. JWT is required. CV uploads are validated server-side before storage.`,
        is_published: true,
        post_date: '2026-05-04'
    },
    {
        title: 'Security First: Content Security Policy and Hardening',
        body: `# Security First: Content Security Policy and Hardening

A portfolio that handles authentication and uploads needs serious security. Here's what I implemented.

## Content Security Policy (CSP)

CSP tells the browser what resources are allowed to load. Mine is strict:

\`\`\`
default-src 'self'
script-src 'self' https://unpkg.com https://cdn.jsdelivr.net
style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com
font-src 'self' https://fonts.gstatic.com
img-src 'self' data: https://*.tile.openstreetmap.org
connect-src 'self' http://localhost:8080
frame-ancestors 'none'
\`\`\`

- No inline scripts (all extracted to external files)
- Only whitelisted CDNs for libraries
- No framing (prevents clickjacking)
- Strict referrer policy

## Other headers

- **X-Content-Type-Options: nosniff** — prevent MIME-type sniffing
- **X-Frame-Options: DENY** — no clickjacking
- **Referrer-Policy: strict-origin-when-cross-origin** — privacy-conscious

## Input validation

Every form input is validated server-side. No trusting the client. SQL queries use parameterised statements—no concatenation, ever.

## File uploads

CV files are scanned for phone numbers, UK postcodes, and email addresses. If found, the upload is rejected with a message asking the user to redact.

## What's left

No system is 100% secure. But these measures stop the most common attacks.`,
        is_published: true,
        post_date: '2026-05-05'
    },
    {
        title: 'Docker & Nginx: Local Dev That Mirrors Production',
        body: `# Docker & Nginx: Local Dev That Mirrors Production

What works locally might not work in production. So I containerised everything—backend, database, reverse proxy—in Docker Compose.

## The setup

\`docker-compose.yml\` defines three services:
- **postgres** — PostgreSQL database
- **backend** — Node.js/Express app on port 8080 (internal)
- **nginx** — reverse proxy on port 80/443 (localhost) or 3001 (dev server)

## Why Nginx?

The backend shouldn't serve static files. Nginx does that. It:
- Serves HTML, CSS, JS from the repo root
- Proxies \`/api/*\` to the backend (stripping the prefix)
- Enforces security headers (CSP, HSTS, etc.)
- Handles HTTPS in production

## Local vs. production

**Local** (\`nginx-local.conf.template\`):
- HTTP only (no SSL overhead)
- \`connect-src 'self' http://localhost:8080\`

**Production** (\`nginx-portfolio.conf.template\`):
- HTTPS with Let's Encrypt certs
- \`connect-src 'self' http://127.0.0.1:8080\`
- Larger file upload limit (25MB for multer)

## The .env file

Secrets stay out of git. \`.env\` (not in repo) defines:
- \`DATABASE_URL\` — postgres connection string
- \`JWT_SECRET\` — signing key for tokens
- \`SMTP_*\` — email credentials

Docker Compose reads from \`.env\` automatically.`,
        is_published: true,
        post_date: '2026-05-06'
    },
    {
        title: 'CI/CD and Deployment: From Dev to Raspberry Pi',
        body: `# CI/CD and Deployment: From Dev to Raspberry Pi

The site lives on a Raspberry Pi. Updating it shouldn't require SSH and manual commands. So I built a deployment system.

## The pipeline

1. **Git push** to \`dev\` or \`main\` on GitHub
2. **Admin dashboard** shows deployment status (commits ahead, last deployed SHA)
3. **Deploy button** pulls latest code, rebuilds Docker images, restarts services
4. **Health check** polls \`/api/health\` until the backend is ready
5. **Rollback** can revert to any previous commit in 30 seconds

## How it works

- \`scripts/deploy/prod-deploy.sh\` — SSH into the Pi, pull latest, rebuild, health-check
- \`scripts/config/nginx-portfolio.conf.template\` — rendered with envsubst before deploying
- PM2 (on Pi) or Docker Compose (locally) keeps services running

## Why this matters

Zero-downtime updates. Rollback on failure. No manual intervention. The site stays live.

## What's next?

Moving the Pi to an Ubuntu Server gaming PC. Same deployment script, bigger hardware.`,
        is_published: true,
        post_date: '2026-05-07'
    },
    {
        title: 'Migrating Infrastructure: Raspberry Pi to Ubuntu Server',
        body: `# Migrating Infrastructure: Raspberry Pi to Ubuntu Server

The Raspberry Pi served well for a hobby project. But with better hardware comes better possibilities: faster builds, more RAM, room to grow.

## The challenge

- **Zero downtime** — users shouldn't know the site moved
- **Dual environment** — run the \`dev\` branch on the new server alongside production
- **Same playbook** — the deployment script should work on both machines

## The solution

**Two compose stacks:**
- \`docker-compose.yml\` — production (port 80/443)
- \`docker-compose.dev-server.yml\` — development (port 3001, LAN-only)

Each has its own:
- PostgreSQL database (\`portfolio_prod\` vs \`portfolio_dev\`)
- Backend instance (\`backend\` port 8080 vs \`backend-dev\` port 8081)
- Nginx instance (\`nginx\` port 443 vs \`nginx-dev\` port 3001)

## LAN-only access

The dev server is only reachable on the local network (\`http://<LAN_IP>:3001\`). UFW firewall rules restrict access:
\`\`\`bash
sudo ufw allow from 192.168.0.0/16 to any port 3001
\`\`\`

## First-time setup

1. Find your LAN IP (\`hostname -I\`)
2. Clone the repo into \`~/MyPortfolioSite-dev\` and checkout \`dev\`
3. Copy \`.env.dev-server.example\` to \`.env\`, fill in secrets
4. Run \`docker compose -f docker-compose.dev-server.yml up -d --build\`
5. Done. Access at \`http://<LAN_IP>:3001\`

## Benefits

- Test new features on real hardware before merging to \`main\`
- Two separate databases (can't accidentally corrupt production)
- Deployment script handles both environments
- Easy to add more instances (staging, etc.) later`,
        is_published: true,
        post_date: '2026-05-09'
    }
];

async function seedBlogPosts() {
    const client = await pool.connect();
    try {
        // Check if posts already exist
        const checkResult = await client.query(
            'SELECT COUNT(*) as count FROM posts WHERE body ILIKE $1',
            ['%Building a Personal Portfolio in 2026%']
        );

        if (checkResult.rows[0].count > 0) {
            console.log('Blog posts already seeded. Skipping.');
            return;
        }

        // Insert posts
        let insertedCount = 0;
        for (const post of blogPosts) {
            const result = await client.query(
                `INSERT INTO posts (title, body, is_published, post_date, post_type)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id`,
                [post.title, post.body, post.is_published, post.post_date, 'blog']
            );
            console.log(`✓ Created post: "${post.title}" (ID: ${result.rows[0].id})`);
            insertedCount++;
        }

        console.log(`\nSuccessfully inserted ${insertedCount} blog posts.`);
    } catch (err) {
        console.error('Error seeding blog posts:', err);
        process.exit(1);
    } finally {
        await client.end();
    }
}

seedBlogPosts();
