# ES Module Migration Plan

**Branch:** `feature/issue-79-tech-debt-2`  
**Issue:** #79 (remaining items)  
**Author:** AI assistant  
**Date:** 2026-05-04

---

## 1. Objective

Convert all frontend JavaScript from `var` globals / plain `<script>` tags to native ES modules (`type="module"`), eliminating:

- `window.buildTimelineItem` / `window.buildPostCard` cross-file coupling
- `window.API_BASE` / `window.isAdminSession` globals
- Four duplicate `escapeHtml` implementations
- Two duplicate inline `slugify` functions (backend — already fixed in tech-debt-1)
- The `buildBlogPostCard` rename workaround caused by the globals collision

---

## 2. Inventory of Current Files

| File | Loaded on | Type | Key globals exported | Key globals consumed |
|---|---|---|---|---|
| `resources/java/config.js` | admin.html | Already `export const` | `API`, `isAdminSession` | — |
| `resources/java/auth-utils.js` | admin.html | Plain script | `isAdminSession()` | — |
| `resources/java/darkmode.js` | all pages | Plain script | — | `localStorage` |
| `resources/java/nav.js` | all pages | Plain script | — | jQuery `$` |
| `resources/java/dev-env.js` | all pages | Plain script | — | `window.location` |
| `resources/java/script.js` | index.html, travel.html, blog.html | Plain script | `buildTimelineItem`, `buildPostCard`, `escHtml`, `API_BASE` | jQuery, Leaflet `L` |
| `resources/java/blog.js` | blog.html | Plain script | — | `window.buildTimelineItem`, `window.buildPostCard`, `API_BASE` |
| `resources/java/blog-post.js` | blog-post.html | Plain script | — | `window.API_BASE` |
| `resources/java/travel-post.js` | travel-post.html | Plain script | — | jQuery, `API_BASE` (not yet shimmed) |
| `resources/java/admin.js` | admin.html | Already ES module (`import`) | — | `config.js` |
| `jquery-3.5.1.min.js` | all pages | CDN script, sets `window.$` | `$`, `jQuery` | — |

**Key cross-file dependencies to resolve:**

```
script.js  ──exports──▶  window.buildTimelineItem  ◀──consumes──  blog.js
script.js  ──exports──▶  window.buildPostCard      ◀──consumes──  blog.js
script.js  ──exports──▶  window.isAdminSession     ◀──consumes──  script.js (self)
config.js  ──exports──▶  API, isAdminSession       ◀──consumes──  admin.js
```

---

## 3. Target Module Structure

After migration, the module graph will be:

```
resources/java/
├── config.js            (already module)  export: API_BASE, isAdminSession
├── utils/
│   ├── html.js          (new)             export: escapeHtml
│   ├── date.js          (new)             export: formatRelativeDate, formatVisitDate, formatPostDate
│   └── dom.js           (new)             export: buildTimelineItem, buildPostCard, buildPublicTravelCard, buildRepoCard
├── darkmode.js          (convert)         no exports — side-effect only
├── nav.js               (convert)         no exports — side-effect only
├── dev-env.js           (convert)         no exports — side-effect only
├── script.js            (convert)         imports: config, utils/*
├── blog.js              (convert)         imports: config, utils/*, script helpers
├── blog-post.js         (convert)         imports: config
├── travel-post.js       (convert)         imports: config, utils/*
└── admin.js             (already module)  imports: config (no change needed)
```

> **Note on jQuery:** jQuery (loaded from a local file via `<script>`) is not an ES module. It sets `window.$`. All converted modules that use jQuery will access it as the global `$` — this is normal and correct when jQuery is loaded before the module entry point. No change to jQuery loading is needed.

> **Note on Leaflet:** Same pattern. `L` stays as a CDN global.

---

## 4. Migration Phases

Migration is done **page by page**, from simplest to most complex, so each step is independently testable and revertable.

### Phase 1 — Create shared utility modules (no HTML changes)

Create three new files. Nothing breaks because no HTML loads them yet.

**`resources/java/utils/html.js`**
```js
export function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
```

**`resources/java/utils/date.js`**
Extract `formatVisitDate`, `formatRelativeDate`, `formatPostDate` from `script.js` and `blog.js`.

**`resources/java/utils/dom.js`**
Extract `buildTimelineItem`, `buildPostCard`, `buildPublicTravelCard`, `buildRepoCard` from `script.js`.

Also update `config.js` to export `API_BASE` (it currently exports `API` — rename for consistency):
```js
export const API_BASE = '/api';
export function isAdminSession() { ... }
```

### Phase 2 — `blog-post.html` / `blog-post.js`

Simplest page: one JS file, no cross-file dependencies, no jQuery.

Changes:
- `blog-post.js`: add `import { API_BASE } from './config.js';`, remove `var API_BASE` shim, convert to module
- `blog-post.html`: change `<script src="...">` to `<script type="module" src="...">`
- Remove `<script src="jquery-3.5.1.min.js">` if not used (verify first)

### Phase 3 — `travel-post.html` / `travel-post.js`

One JS file, uses jQuery and `API_BASE`.

Changes:
- `travel-post.js`: `import { API_BASE } from './config.js';`, `import { escapeHtml } from './utils/html.js';`, convert to module
- `travel-post.html`: `<script type="module">`
- jQuery `<script>` tag stays as plain script (loaded before the module)

### Phase 4 — `blog.html` / `blog.js`

`blog.html` loads both `script.js` and `blog.js`. `blog.js` currently calls `window.buildTimelineItem` and `window.buildPostCard` (set by `script.js`).

Changes:
- `blog.js`: `import { buildTimelineItem, buildPostCard } from './utils/dom.js';`, `import { API_BASE } from './config.js';`, remove `window.*` references, convert to module
- `script.js`: convert to module, remove `window.buildTimelineItem = ...` and `window.buildPostCard = ...` exports, `import` from `utils/*`
- `blog.html`: both script tags get `type="module"`
- Remove `buildBlogPostCard` rename workaround — call `buildPostCard` directly

### Phase 5 — `index.html` / `script.js` (standalone)

`index.html` loads `script.js` (already converted in Phase 4) but doesn't load `blog.js`. Verify no `window.*` references remain.

### Phase 6 — `travel.html`

Loads `script.js` only. Should work after Phase 4 converts `script.js`. Verify `initTravelMap`, lightbox, and view toggle all work.

### Phase 7 — `login.html` / `setup.html`

Verify these pages load no custom JS that needs converting (currently they appear script-free beyond `darkmode.js` and `nav.js`). Convert `darkmode.js` and `nav.js` to modules or verify they work as-is.

### Phase 8 — `admin.html` / `admin.js`

`admin.js` is already a module. `config.js` changes in Phase 1 (`API` → `API_BASE`) require updating the one `import` line in `admin.js`. Otherwise no changes needed.

---

## 5. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| jQuery not available when module runs | Medium | High | Ensure jQuery `<script>` tag appears before `<script type="module">` in all HTML files. Modules are deferred by default — jQuery will have run first as long as it's a synchronous `<script>` |
| Leaflet `L` not available when `initTravelMap` runs | Low | Medium | Same as above — Leaflet CDN tag stays as plain `<script>` before the module entry point |
| `script.js` loaded on both `index.html` and `blog.html` — double `$(document).ready()` bootstrap | Low | Medium | The bootstrap block calls page-specific functions guarded by element existence checks (`if (!travelGrid.length) return`). This is already safe and remains unchanged |
| Module CORS error during local file:// development | High | Medium | ES modules require a server (not `file://`). Document in README that `npm start` / Docker must be used for local dev. `file://` was already broken by the existing `fetch()` calls |
| `blog.js` and `script.js` both `import` from `utils/dom.js` — no double-initialisation | Low | Low | ES modules are cached by the browser after first load. `utils/dom.js` only exports pure functions, no side effects, so shared import is safe |
| `admin.js` `import { API }` breaks after rename to `API_BASE` | High | Low | Caught in Phase 8 — update the import name in admin.js at the same time as config.js changes |

---

## 6. Files Changed Summary

### New files
- `resources/java/utils/html.js`
- `resources/java/utils/date.js`
- `resources/java/utils/dom.js`

### Modified JS files
- `resources/java/config.js` — rename `API` → `API_BASE`
- `resources/java/script.js` — convert to module, remove `window.*` exports, import from utils
- `resources/java/blog.js` — convert to module, import from utils, remove `window.*` calls
- `resources/java/blog-post.js` — convert to module, import `API_BASE`
- `resources/java/travel-post.js` — convert to module, import `API_BASE`, `escapeHtml`
- `resources/java/admin.js` — update `import { API }` → `import { API_BASE }`
- `resources/java/darkmode.js` — add `export {}` or keep as plain script (TBD)
- `resources/java/nav.js` — add `export {}` or keep as plain script (TBD)

### Modified HTML files (script tag changes only)
- `blog-post.html`
- `travel-post.html`
- `blog.html`
- `index.html`
- `travel.html`
- `admin.html`
- `login.html`
- `setup.html`

---

## 7. Out of Scope for This Branch

- Bundling / build tooling (Vite, Rollup) — pure native modules, no bundler
- TypeScript conversion
- jQuery removal — jQuery stays as a CDN global
- Backend changes
- Error response shape standardisation — separate task in issue #79
- Request validation middleware — separate task in issue #79

---

# Test Plan

## Environment

- Run via `docker compose up` or `npm start` (not `file://`)
- Test in: Chrome (latest), Firefox (latest), Safari (latest)
- Mobile: Chrome Android, Safari iOS

---

## Pre-Migration Baseline (do before any code changes)

Run through every manual test below and note the current pass/fail state. Any pre-existing failures are **not** in scope for this branch.

---

## Test Cases

### T01 — `index.html` (home page)

| # | Test | Expected | Notes |
|---|---|---|---|
| T01-01 | Page loads, no console errors | ✅ Zero errors | Check DevTools Console |
| T01-02 | Dark mode toggle works | ✅ Theme switches, persists on reload | |
| T01-03 | Navigation links work | ✅ All nav items navigate correctly | |
| T01-04 | Travel cards grid renders | ✅ Cards visible with title, date, location | Requires backend |
| T01-05 | Travel timeline renders | ✅ Timeline items visible and in date order | |
| T01-06 | Travel map renders with pins | ✅ Leaflet map loads, markers placed | Requires entries with lat/lng |
| T01-07 | View toggle (cards / map / timeline / both) | ✅ Each view shows correct containers | |
| T01-08 | Lightbox opens on travel card with image | ✅ Overlay appears, image loads | |
| T01-09 | Lightbox prev/next navigation | ✅ Cycles through media | |
| T01-10 | Lightbox closes via × button, backdrop click, Escape | ✅ All three dismiss it | |
| T01-11 | Horizontal scroll paddles (portfolio section) | ✅ Left/right paddles scroll carousel | |
| T01-12 | GitHub repos widget loads | ✅ Up to 6 repo cards visible | |
| T01-13 | Contact form submits | ✅ Success message shown | Requires backend |
| T01-14 | Contact form honeypot field hidden | ✅ `#contact-website` not visible | |
| T01-15 | Visit counter increments | ✅ Counter displays on page | Requires backend |
| T01-16 | `API_BASE` resolves to `/api` | ✅ Network requests go to `/api/...` | Check DevTools Network |

### T02 — `blog.html`

| # | Test | Expected |
|---|---|---|
| T02-01 | Page loads, no console errors | ✅ Zero errors |
| T02-02 | Blog post cards render | ✅ Title, date, excerpt visible |
| T02-03 | Blog timeline renders | ✅ Timeline items in date order |
| T02-04 | Cards / Timeline view toggle | ✅ Correct container shown |
| T02-05 | Clicking post card navigates to `blog-post.html?slug=...` | ✅ Correct URL |
| T02-06 | Clicking timeline entry navigates to `blog-post.html?slug=...` | ✅ Correct URL |
| T02-07 | Empty state shown if no posts | ✅ Empty state element visible |

### T03 — `blog-post.html`

| # | Test | Expected |
|---|---|---|
| T03-01 | Page loads with `?slug=valid-slug`, no console errors | ✅ Zero errors |
| T03-02 | Post title, content, date render | ✅ Correct post content |
| T03-03 | Invalid slug shows error state | ✅ Error message, no crash |
| T03-04 | `API_BASE` resolves correctly | ✅ Fetches from `/api/posts/:slug` |

### T04 — `travel.html`

| # | Test | Expected |
|---|---|---|
| T04-01 | Page loads, no console errors | ✅ Zero errors |
| T04-02 | Travel cards render | ✅ Cards with title, location, date |
| T04-03 | Travel map renders | ✅ Map visible |
| T04-04 | Timeline renders | ✅ Items in date order |
| T04-05 | View toggle works | ✅ All five views correct |
| T04-06 | Travel card links to `travel-post.html?id=...` | ✅ Correct URL |

### T05 — `travel-post.html`

| # | Test | Expected |
|---|---|---|
| T05-01 | Page loads with `?id=valid-id`, no console errors | ✅ Zero errors |
| T05-02 | Memory title, notes, location, date render | ✅ Correct content |
| T05-03 | Media gallery renders | ✅ Images/videos visible |
| T05-04 | Invalid id shows error state | ✅ Error message, no crash |

### T06 — `admin.html`

| # | Test | Expected |
|---|---|---|
| T06-01 | Redirects to `login.html` if not authenticated | ✅ Redirect occurs |
| T06-02 | Post CRUD (create, edit, delete) | ✅ All operations work |
| T06-03 | Travel memory CRUD | ✅ All operations work |
| T06-04 | Media upload | ✅ File uploads, appears in gallery |
| T06-05 | `API_BASE` resolves correctly in admin | ✅ Requests go to `/api/...` |
| T06-06 | `isAdminSession()` returns true after login | ✅ Admin session recognised |
| T06-07 | No console errors | ✅ Zero errors |

### T07 — `login.html`

| # | Test | Expected |
|---|---|---|
| T07-01 | Page loads, no console errors | ✅ Zero errors |
| T07-02 | Valid credentials redirect to `admin.html` | ✅ Redirect occurs |
| T07-03 | Invalid credentials show error message | ✅ Error visible, no redirect |

### T08 — Shared utility correctness

| # | Test | Expected |
|---|---|---|
| T08-01 | `escapeHtml('&<>"\'' )` → `&amp;&lt;&gt;&quot;&#039;` | ✅ All five entities escaped |
| T08-02 | `escapeHtml(null)` returns empty string | ✅ No crash |
| T08-03 | `formatVisitDate('2026-05-04')` → `'4 May 2026'` | ✅ en-GB format |
| T08-04 | `formatVisitDate(null)` returns `null` | ✅ No crash |
| T08-05 | `buildTimelineItem` renders title via `.text()` (XSS test) | ✅ `<script>alert(1)</script>` rendered as literal text |
| T08-06 | `buildPostCard('blog', {...})` renders without crash | ✅ Returns jQuery element |

### T09 — Module loading order

| # | Test | Expected |
|---|---|---|
| T09-01 | jQuery accessible as `$` inside modules on all pages | ✅ `$` is defined |
| T09-02 | Leaflet `L` accessible inside `initTravelMap` | ✅ `L` is defined on pages that load Leaflet |
| T09-03 | No `ReferenceError: $ is not defined` in console | ✅ Zero reference errors |
| T09-04 | No `ReferenceError: L is not defined` in console | ✅ Zero reference errors |
| T09-05 | No `ReferenceError: API_BASE is not defined` in console | ✅ Zero reference errors |

### T10 — Regression: XSS prevention

| # | Test | Expected |
|---|---|---|
| T10-01 | Create travel memory with title `<img onerror="alert(1)">` | ✅ Rendered as escaped text, no alert |
| T10-02 | Create blog post with title `<script>alert(1)</script>` | ✅ Rendered as escaped text |
| T10-03 | Travel map popup with malicious location | ✅ Escaped in popup HTML |

---

## Commit Strategy

Each phase = one commit, named:

```
refactor(modules): phase 1 — create utils/html, utils/date, utils/dom
refactor(modules): phase 2 — convert blog-post.js and blog-post.html
refactor(modules): phase 3 — convert travel-post.js and travel-post.html
refactor(modules): phase 4 — convert blog.js, script.js, blog.html
refactor(modules): phase 5 — verify index.html after script.js conversion
refactor(modules): phase 6 — verify travel.html
refactor(modules): phase 7 — convert darkmode.js, nav.js; verify login/setup
refactor(modules): phase 8 — update admin.js import after config.js rename
```

This means any phase can be individually reverted with `git revert` without undoing other phases.
