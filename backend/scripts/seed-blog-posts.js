/**
 * Seed script — blog posts documenting the portfolio site's development journey (#202)
 *
 * Usage (inside the backend container, or with env vars set):
 *   node backend/scripts/seed-blog-posts.js
 *
 * Idempotent: checks for existing posts by slug before inserting.
 * Atomic: runs in a single transaction — all-or-nothing insert.
 * Logs inserted post IDs and count on completion.
 */
import 'dotenv/config';
import { pool } from '../db/pool.js';

// ── Slug helper (inline to avoid module-resolution issues when run standalone) ─

function slugify(str) {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 90);
}

// ── Blog posts ────────────────────────────────────────────────────────────────

const POSTS = [
  {
    title:      'Building a Portfolio Site with AI — The Setup',
    post_date:  '2025-01-15',
    published:  true,
    body: `## Starting from scratch

In early 2025, I set out to build a personal portfolio site — not from a template, but properly engineered from the ground up. The tech choices were intentional: Node.js/Express on the backend, vanilla JavaScript on the frontend (no build step), PostgreSQL for persistence, and Nginx as the reverse proxy.

The AI pair programmer — Claude Sonnet via the Anthropic API — joined as an active collaborator from day one. Every architectural decision was documented, debated, and committed with context.

## Why no build step?

The frontend loads ES modules directly via \`<script type="module">\`. No webpack, no Vite, no bundler. Nginx serves the files as-is. This keeps the development loop tight: edit a file, refresh the browser. It trades some convenience (no tree-shaking, no TypeScript) for radical simplicity.

The constraint forced discipline: shared utilities live in \`resources/js/utils/\`, modules import from each other cleanly, and there's no opaque build artefact to debug.

## Infrastructure

Self-hosted on an Ubuntu Server (a repurposed gaming PC — the original Raspberry Pi proved too underpowered for Docker). Docker Compose orchestrates the backend, PostgreSQL, and Nginx containers. A \`.env\` file controls all environment-specific behaviour.

The first working deploy happened in January 2025. It was a static page. But it deployed.`,
  },
  {
    title:      'WebAuthn and Passkeys: Building Passwordless Auth',
    post_date:  '2025-02-10',
    published:  true,
    body: `## The problem with passwords

This is a single-admin site. There's one user. Adding a traditional password system would introduce a weak point (the password) for no meaningful benefit. WebAuthn — the FIDO2 standard — lets the browser authenticate using a hardware key, platform authenticator (Touch ID, Windows Hello), or a passkey synced to the cloud.

## Implementation

The \`@simplewebauthn/server\` library handles the ceremony mechanics. The backend:

1. Generates a registration challenge and stores it in the \`webauthn_challenges\` table (ephemeral, short-lived)
2. Verifies the credential response from the browser
3. Stores the public key and counter in the \`passkeys\` table
4. Issues a JWT on successful authentication

The JWT is signed with a secret stored only in the backend environment, expires after a configurable duration, and is verified on every protected route.

## Email magic links as backup

WebAuthn requires a registered device. If the device is unavailable, email magic links provide a fallback. A secure random token is generated, its bcrypt hash stored in \`email_tokens\`, and the raw token sent in the email. On click, the backend verifies via \`crypt(raw, stored_hash)\` — constant-time comparison, no timing oracle.

This dual-method auth system — passkey-first, email-fallback — provides both security and resilience.`,
  },
  {
    title:      'Travel Memories: Maps, Timelines, and EXIF',
    post_date:  '2025-03-05',
    published:  true,
    body: `## A different kind of content

Blog posts are linear. Travel memories are spatial. The travel section needed a map view, a timeline, and support for multiple photos per memory — all without a heavy frontend framework.

## Data model

Posts and travel memories share a unified \`posts\` table, discriminated by \`post_type\`. Travel-specific columns (lat, lng, location, post_date) sit alongside the blog columns. The \`post_media\` table provides one-to-many media items for travel posts.

## Maps

Leaflet.js renders the map with OpenStreetMap tiles — no API key required. Each published travel post becomes a marker. The admin panel uses the Nominatim geocoding API (OpenStreetMap) to resolve place names to coordinates.

## EXIF extraction

When a photo is uploaded, the backend uses \`exifr\` to extract GPS coordinates from the image metadata. If coordinates are found, they pre-populate the lat/lng fields in the admin form — a small quality-of-life improvement that saves manual geocoding.

## Timeline

The public travel page renders a timeline alongside the map. Each entry shows a date marker, title, location, and thumbnail. The timeline and map are linked — clicking a timeline entry pans the map to that location.`,
  },
  {
    title:      'The Admin Panel: Modular JavaScript Without a Framework',
    post_date:  '2025-04-01',
    published:  true,
    body: `## One HTML file, many modules

The admin panel is a single-page application built without React, Vue, or any other framework. It's a single \`admin/index.html\` file that loads ES modules via \`<script type="module">\`.

Each feature has its own module under \`resources/js/admin/\`:

- \`posts.js\` — blog post CRUD
- \`travel.js\` — travel memory CRUD (the largest module at ~500 lines)
- \`deploy.js\` — deployment console
- \`cv.js\` — CV upload and version history
- \`stats.js\` — site visit statistics
- \`auth.js\` — JWT storage and logout
- \`passkeys.js\` — passkey management

\`admin.js\` is a thin entry point that imports and initialises each module. This modular structure keeps concerns separate and makes individual modules testable in isolation.

## State management

There's no state management library. Each module owns its own state. The JWT token lives in \`sessionStorage\` (not \`localStorage\` — it clears on tab close, which is the right security trade-off for an admin session). The modules communicate via DOM events where needed.

## The constraint that helped

No build step means no dead code elimination, but it also means no compilation step to debug. When something breaks, the browser console shows the actual line of actual source code. That's worth a lot.`,
  },
  {
    title:      'Security Hardening: CSP, Rate Limiting, and Error Sanitisation',
    post_date:  '2025-05-15',
    published:  true,
    body: `## Content Security Policy

The most impactful security change was implementing a strict Content Security Policy. The CSP is defined in \`scripts/config/nginx-security-headers.conf\` — a single source of truth applied to all responses via Nginx.

The policy allowlists:
- Script sources: self only (no \`unsafe-inline\`, no \`unsafe-eval\`)
- Style sources: self, Google Fonts
- Image sources: self, data URIs, OpenStreetMap tile servers
- Connect sources: self (the API)
- Font sources: Google Fonts CDN

Every external resource addition requires a corresponding CSP update. This constraint is visible at PR review time — the checklist item is mandatory.

## Rate limiting

Express rate limiting with a PostgreSQL-backed store (to survive container restarts) protects:
- The contact form (5 per hour per IP)
- Auth endpoints (login attempts)
- Blog and travel write routes (120 per minute per IP, with admin exempt)
- CV upload/delete (30 per minute per IP)

The \`ServiceKey\` pattern exempts the admin (verified via JWT inline) so legitimate use is never throttled.

## Error message sanitisation

The Express error handler catches all unhandled errors and returns a sanitised response. In production, 5xx errors return a generic message — never the raw stack trace or database error. The full error is logged via \`pino\` with structured context so it's diagnosable from logs alone.`,
  },
  {
    title:      'Docker, Nginx, and Deployment: Self-Hosting Lessons',
    post_date:  '2025-06-01',
    published:  true,
    body: `## The deployment stack

The production deployment is three Docker containers on a single host:

1. **postgres** — PostgreSQL 16, data persisted to a named volume
2. **backend** — Node.js/Express, built from a multi-stage Dockerfile
3. **nginx** — Reverse proxy for HTTPS, static file serving, and API proxying

A single \`docker-compose.yml\` handles both dev and prod environments. All environment differences (ports, cert paths, hostnames, volume names) come from a \`.env\` file. \`COMPOSE_PROJECT_NAME\` provides isolation between dev and prod on the same host.

## The deploy script

\`scripts/deploy/deploy.sh\` is the single entry point for all deployments. It:

1. Validates environment variables
2. Runs health checks before and after the deploy
3. Updates the repo via \`git pull\`
4. Rebuilds the backend image if needed
5. Runs \`docker compose up -d\` with a rollback on failure
6. Runs the Vitest suite inside the container post-deploy

The deploy script is the highest-risk file in the codebase. It has its own sub-library structure (\`deploy-lib-*.sh\`) for separation of concerns.

## Lessons learned

The biggest time sink was orphan containers — stale containers from a previous compose project lingering after a rename. The solution was explicit \`docker compose down\` before each deploy, with cleanup of any lingering project.

The second biggest: cert path mismatches. Let's Encrypt cert paths are not negotiable — they must match exactly what Nginx expects. Template variables in the Nginx config (\`CERT_MOUNT_SRC\`, \`CERT_MOUNT_DST\`) make this explicit and testable.`,
  },
  {
    title:      'Infrastructure Migration: Raspberry Pi to Ubuntu Server',
    post_date:  '2025-08-20',
    published:  true,
    body: `## Outgrowing the Pi

The original Raspberry Pi 4 ran the site in its early days — acceptable for a static page, but Docker Compose with PostgreSQL, Nginx, and a Node.js backend pushed it to its limits. Build times were measured in minutes. Container startup was slow. Memory pressure was constant.

## The new server

A repurposed gaming PC (AMD Ryzen, 32GB RAM, NVMe SSD) replaced the Pi in mid-2025. The migration was:

1. \`pg_dump\` on the Pi, \`pg_restore\` on the new server
2. Copy the uploads volume
3. Update the \`.env\` on the new server
4. Point the DDNS record at the new IP
5. Run \`./scripts/deploy/server-setup.sh\` on the new server

The migration took about two hours including DNS propagation time.

## What changed

The speed difference is dramatic. Docker builds that took 4 minutes on the Pi take under 20 seconds. The server has headroom for the AI Lab experiments and future features.

The Pi hasn't been decommissioned — it now runs Home Assistant for home automation, which is a better fit for its capabilities.

## What stayed the same

The deployment process is identical. The same \`docker-compose.yml\`, the same deploy script, the same \`.env\` structure. Infrastructure-as-code paid off here — the migration was a data move, not a reconfiguration.`,
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function seedBlogPosts() {
  const client = await pool.connect();
  let inserted = 0;
  let skipped  = 0;

  try {
    await client.query('BEGIN');

    for (const post of POSTS) {
      const slug = slugify(post.title);

      // Check for existing post with this slug
      const exists = await client.query(
        `SELECT id FROM posts WHERE slug = $1 AND post_type = 'blog'`,
        [slug]
      );

      if (exists.rows.length) {
        console.log(`[seed] SKIP — already exists: ${slug}`);
        skipped++;
        continue;
      }

      const publishedAt = post.published ? new Date(post.post_date + 'T12:00:00Z') : null;

      const result = await client.query(
        `INSERT INTO posts (post_type, title, slug, body_markdown, post_date, published_at)
         VALUES ('blog', $1, $2, $3, $4, $5)
         RETURNING id, title`,
        [post.title, slug, post.body.trim(), post.post_date, publishedAt]
      );

      const row = result.rows[0];
      console.log(`[seed] INSERT id=${row.id} — "${row.title}"`);
      inserted++;
    }

    await client.query('COMMIT');
    console.log(`\n[seed] Done — ${inserted} inserted, ${skipped} skipped.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[seed] ERROR — transaction rolled back:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seedBlogPosts();
