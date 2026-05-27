# Architecture

_Last updated: 2026-05-07_

This document describes the system architecture at a high level — how the pieces fit together, the request flow, and the overall design. Read this to understand the "big picture" before diving into code.

---

## System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         Browser                                  │
│                  (user visits andykeys.me)                      │
└────────────────────┬────────────────────────────────────────────┘
                     │ HTTPS :443
                     │
        ┌────────────▼────────────┐
        │     Nginx Reverse       │
        │   Proxy + Static Files  │
        │  (Listens on :80, :443) │
        └────────────┬────────────┘
                     │
         ┌───────────┴──────────┐
         │                      │
    (/api/*)            (everything else)
         │                      │
         │                      ▼
         │         ┌──────────────────────┐
         │         │   Static HTML/CSS/JS │
         │         │  (Nginx serves from  │
         │         │    repo root)        │
         │         └──────────────────────┘
         │
         ▼
    ┌────────────────────────┐
    │  Node.js/Express       │
    │   Backend API          │
    │  (Listens on :8080)    │
    └────────────┬───────────┘
                 │
         ┌───────┴────────┐
         │                │
         ▼                ▼
    ┌─────────────┐  ┌──────────────┐
    │ PostgreSQL  │  │ /uploads     │
    │ Database    │  │ (filesystem) │
    │             │  │              │
    │ Posts,      │  │ CVs,         │
    │ users,      │  │ photos,      │
    │ auth tokens │  │ media        │
    └─────────────┘  └──────────────┘
```

---

## Request Flow

### Public page load (e.g., user visits `/blog/index.html`)

1. Browser requests `https://andykeys.me/blog/index.html`
2. Nginx receives request on :443 (HTTPS)
3. Nginx returns static file `blog/index.html` (+ CSS, JS)
4. Browser parses HTML, finds `<script type="module" src="resources/js/blog.js">`
5. Browser loads and executes `blog.js` (ES module)
6. `blog.js` calls `fetch('/api/posts')` to load blog posts
7. Request goes back to Nginx → proxy to Node backend
8. Backend returns JSON → browser renders posts

### API call (public, no auth)

1. Frontend JS calls `fetch('/api/posts')` (or similar)
2. Nginx routes `/api/*` to Node backend (removes `/api` prefix)
3. Backend receives request for `/posts`
4. Route handler queries database, returns JSON
5. Frontend receives JSON, updates DOM

### API call (auth-required)

1. Frontend JS includes JWT in header: `Authorization: Bearer <token>`
2. Nginx proxies request to backend (headers preserved)
3. Backend middleware validates JWT
4. If valid: route executes, returns response
5. If invalid: backend returns `401 Unauthorized`

---

## File & Folder Organization

### Top-level directories

```
MyPortfolioSite/
├── backend/                ← Node.js/Express application
├── resources/              ← Frontend (HTML, CSS, JS)
├── docs/                   ← Documentation (you are here)
├── scripts/                ← Deployment, dev utilities, tests
├── uploads/                ← User-uploaded files (CVs, images)
├── docker-compose.yml      ← Local dev environment (Docker)
├── README.md               ← Project overview, setup, branching
├── ROADMAP.md              ← Future direction and planned work
├── CLAUDE.md               ← AI pair programmer instructions
└── PROJECT_ASSESSMENT.md   ← Honest assessment of current state
```

### Backend structure

```
backend/
├── server.js               ← Express app setup, middleware, route registration
├── routes/
│   ├── auth.js             ← WebAuthn, JWT, magic links (12KB, complex)
│   ├── posts.js            ← Blog/travel CRUD
│   ├── travel.js           ← Travel listing and detail
│   ├── contact.js          ← Contact form with email
│   ├── deploy.js           ← Deployment triggers, rollback, status
│   ├── upload.js           ← CV and photo upload
│   ├── cv.js               ← CV file handling
│   ├── stats.js            ← Visit counters and analytics
│   └── health.js           ← (coming) health check endpoint
├── middleware/
│   ├── errorHandler.js     ← Catches and formats errors
│   ├── validate.js         ← Schema validation for request bodies
│   └── rateLimit.js        ← Request rate limiting
├── db/
│   └── schema.sql          ← PostgreSQL schema (idempotent)
├── utils/
│   ├── shell.js            ← Child process spawning for git/shell commands
│   └── logger.js           ← (coming) structured logging
├── package.json            ← Dependencies and scripts
├── .env.example            ← Example environment variables
└── Dockerfile              ← Docker image definition
```

### Frontend structure

```
resources/
├── java/                   ← JavaScript ES modules
│   ├── config.js           ← API_BASE, environment detection
│   ├── script.js           ← Homepage only (GitHub widget, contact form, visit counter)
│   ├── blog.js             ← Blog listing page
│   ├── travel.js           ← Travel listing page (map, cards, timeline, lightbox)
│   ├── admin.js            ← Admin panel entry point (thin orchestrator)
│   ├── admin/
│   │   ├── posts.js        ← Blog post CRUD
│   │   ├── travel.js       ← Travel memory CRUD, geocoding, EXIF, map
│   │   ├── deploy.js       ← Deployment console
│   │   ├── cv.js           ← CV upload + file browser
│   │   ├── auth.js         ← Auth session handling
│   │   ├── passkeys.js     ← Passkey management
│   │   ├── stats.js        ← Visit/error stats
│   │   └── notes.js        ← Notes section
│   ├── darkmode.js         ← Theme toggle
│   ├── nav.js              ← Navigation menu toggle
│   └── utils/
│       ├── html.js         ← escapeHtml(), sanitisation
│       ├── date.js         ← formatVisitDate(), date formatting
│       ├── dom.js          ← buildTimelineItem(), buildPostCard(), etc.
│       └── auth-utils.js   ← isAdminSession(), shared auth logic
├── css/
│   ├── reset.css           ← CSS reset
│   └── styles.css          ← All styling (button variants, layout, theme)
└── img/
    └── AK.jpg              ← Favicon and logo
```

### HTML pages

```
Root level (served as static files by Nginx):
├── index.html              ← Homepage (23KB, sections for projects, timeline, contact)
├── blog/index.html               ← Blog listing page
├── blog/post/index.html          ← Individual blog post detail
├── travel/index.html             ← Travel listing page (map + cards + timeline)
├── travel/post/index.html        ← Individual travel post detail
├── admin/index.html              ← Admin console (18KB, handles blog/travel/CV/deploy/stats)
├── login/index.html              ← Login page (passkey + magic link)
├── setup/index.html              ← First-time account setup
└── 404.html                ← 404 error page (served by Nginx)
```

---

## Data Flow: Adding a Blog Post

As an example of how the system works end-to-end:

1. **User (admin) visits `/admin/index.html`** in browser
2. Browser loads `admin.js` (entry point), which imports feature modules from `admin/`
3. User fills out blog post form, clicks "Publish"
4. `admin/posts.js` calls `fetch('/api/posts', { method: 'POST', body: { title, date, content, ... } })`
5. Request includes JWT in `Authorization` header
6. Nginx routes to backend
7. Backend middleware validates JWT
8. `/api/posts` route handler validates form fields
9. Route handler inserts into `posts` table (via parameterised SQL)
10. Database returns the new post ID
11. Backend returns `{ id, title, ... }` as JSON response
12. Frontend receives response, shows success message
13. User visits `/blog/index.html` to verify post appears
14. `blog.js` calls `fetch('/api/posts')`
15. Backend queries database, returns all published posts
16. Frontend renders posts on the page

---

## Key Design Decisions

### Why no build step?

- Frontend is vanilla JS with ES modules — no transpilation needed
- Faster iteration: change code, refresh browser, see the result
- Better for AI-assisted development: code is immediately readable without build tool knowledge
- Trade-off: larger file sizes on the wire (but Nginx handles gzipping)

### Why vanilla JS only?

- jQuery fully removed (#176 admin panel, #385 public pages)
- All JS is now vanilla ES modules — no global `$` dependency
- Consistent DOM APIs throughout the codebase

### Why single `admin/index.html` instead of separate pages?

- All admin functions in one place: easier to access as a single-user dashboard
- JS logic is split across per-feature modules in `resources/js/admin/` (#175 — shipped)

### Why parameterised SQL everywhere?

- Prevents SQL injection attacks
- Clear and testable code
- Non-negotiable requirement for security

### Why JWT + passkeys instead of OAuth?

- No third-party auth service dependency
- Passkeys (WebAuthn) are hardware-bound — stronger than passwords
- Simpler architecture, full control over the auth flow

---

## Critical Paths & Bottlenecks

| Component | Risk | Impact | Mitigation |
|-----------|------|--------|-----------|
| `resources/js/admin/travel.js` | Largest admin module (495 lines); geocoding, EXIF, map | Read full file before editing; test travel CRUD + map flows |
| `auth.js` | Complex WebAuthn + JWT state machine | Auth bugs have security implications | High test coverage, careful code review |
| PostgreSQL (single instance) | No replication, no backup | Data loss if the server disk fails | Backup hardening outstanding — see ROADMAP §4.5 (#164) |
| Nginx reverse proxy | Single point of failure | If Nginx breaks, entire site is down | Keep Nginx config simple and tested |
| PM2 (process manager) | Limited visibility into errors | Crashes not always obvious | Health endpoint planned (#163) |

---

## Deployment Pipeline

```
Feature branch
    ↓
Create PR to `dev`
    ↓
Test in Docker locally
    ↓
Run smoke tests (Test-Regression.ps1)
    ↓
Merge PR to `dev`
    ↓
Create release PR: `dev` → `main`
    ↓
Code review (on `main`)
    ↓
Merge to `main`
    ↓
prod-deploy.ps1 triggers deployment
    ↓
Backend restarts, Nginx reloads
    ↓
Check health endpoint & site
    ↓
LIVE
```

---

## See Also

- `INFRASTRUCTURE.md` — server locations, service names, operational procedures
- `SECURITY.md` — auth model, threat model, what is protected
- `docs/DATABASE.md` — full schema reference
- `docs/STYLE_GUIDE.md` — code patterns, naming conventions
- `docs/TESTING.md` — test suite structure, how to run tests
