# Issue #522 — Full Project Code Review

Reviewed on branch `dev` (up to date with origin). Scope: all HTML pages, `resources/js/**`, `backend/**` (routes, middleware, utils, workers, db, scripts), `scripts/**`, and config files (`docker-compose.yml`, `package.json`, `.env.example`, nginx templates). Criteria: DRY, YAGNI, hard-coding, general quality, over-engineering.

---

## High (correctness / security risk)

### H1. Admin publish/unpublish toggle erases the post body (data loss)
- `resources/js/admin/posts.js:124-141` (`togglePublish`) and `resources/js/admin/ai-blog.js:122-138`.
- The list endpoints `/posts/all` and `/ai-blog/all` return only `excerpt` (`left(body_markdown, 300) AS excerpt`) — **no `body_markdown` field**. `togglePublish` sends `body_markdown: post.body_markdown || ''` in a full PUT, and the backend (`backend/routes/posts.js:158`, `backend/routes/ai-blog.js:154`) writes `body_markdown || ''` unconditionally. Clicking Publish/Unpublish from the admin list therefore wipes the entire body to an empty string.
- Fix: fetch the full record (`/posts/admin/:id`) before the PUT, or better, make the backend update use `COALESCE($3, body_markdown)` when `body_markdown` is `undefined`, or add a dedicated `PATCH /:id/publish` endpoint. (The travel module avoids this because `/travel/all` returns full `notes`.)

### H2. `PUT /travel/:id` leaks an open transaction on 404
- `backend/routes/travel.js:233-241`. `BEGIN` is issued, then the 404 path does `return res.status(404)...` without `ROLLBACK`. The `finally` releases the client back to the pool **while still inside an open transaction** (idle-in-transaction connection; subsequent borrowers inherit the stale transaction state).
- Fix: `await client.query('ROLLBACK')` before the early return (mirror the pattern in `backend/routes/cv.js:233-241`, which does this correctly), or do the existence check before `BEGIN`.

### H3. `docker.sock` mount justification is stale — likely removable attack surface
- `docker-compose.yml` backend volumes: `- /var/run/docker.sock:/var/run/docker.sock` with a comment saying it is "Required by the deploy route ... to run docker compose commands". The deploy route (`backend/routes/deploy.js`) no longer runs any docker commands — it only runs `git` via `spawnPromise` and writes queue-trigger files consumed by the host-side `deploy-daemon.sh`. Nothing in `backend/` references docker.
- If confirmed unused, remove the mount: it grants a compromised backend container root-equivalent control of the host. At minimum the comment is dangerously outdated (#450 is referenced but the queue refactor already landed).

### H4. `WEBAUTHN_RP_NAME` not validated at startup despite the code claiming it is
- `backend/utils/validateEnv.js:20-34` (`REQUIRED_ENV`) omits `WEBAUTHN_RP_NAME`, but `backend/routes/auth.js:34-36` comments "validateEnv.js requires WEBAUTHN_RP_ID, WEBAUTHN_ORIGIN, and WEBAUTHN_RP_NAME at startup — no fallback defaults here (#433)". If the var is missing from `.env`/compose, boot succeeds and passkey registration fails at runtime (`generateRegistrationOptions({ rpName: undefined })`) — exactly the silent-failure class #357 was meant to close.
- Fix: add `WEBAUTHN_RP_NAME` to `REQUIRED_ENV` (compose already bridges it).

---

## Medium (maintainability / real bugs of lower impact)

### M1. Dead code: entire `resources/js/admin/travel/` directory (~600 lines)
- `resources/js/admin/travel/{exif,form,geocode,list,media,messages}.js` duplicate the content of the monolithic `resources/js/admin/travel.js`, but nothing imports them (`admin-travel-page.js` imports `./admin/travel.js`; no `from './travel/…'` anywhere). This is an abandoned modularisation attempt — dangerous because a future edit could land in the dead copy. Delete the directory (or finish the migration and delete the monolith).

### M2. Rate-limiter boilerplate duplicated ~15×
- Every route file (`posts.js`, `travel.js`, `ai-blog.js`, `auth.js` ×3, `cv.js`, `upload.js`, `contact.js`, `stats.js`, `search.js`, `audit.js`, `debug.js`, `deploy.js` ×2) repeats the same 10-line `rateLimit({...})` block: identical `keyGenerator`, `message`, `standardHeaders`, `legacyHeaders`, `validate`, and a `PostgresStore`. Only `windowMs`/`limit`/`keyType`/`skip` vary.
- Fix: add `makeRateLimiter({ windowMs, limit, keyType, skip })` in `backend/middleware/` or `utils/`, per the project's own DRY rule in CLAUDE.md.

### M3. `routes/posts.js` and `routes/ai-blog.js` are near-clones
- ~190 vs ~205 lines, identical query shapes, helpers (`insertPost`/`insertAiBlogPost`), publish/unpublish audit logic — differing only in `post_type`, audit prefixes, and the `/generate` endpoint. Extract a `makePostTypeRouter(postType, opts)` factory (or shared handler helpers); ai-blog then only adds `/generate`.

### M4. Admin modules `admin/posts.js` and `admin/ai-blog.js` are ~95% identical
- Same `buildRow`, `loadAll`, `loadForEdit`, `togglePublish`, `deleteX`, form-submit and clear/template handlers with different element-ID prefixes. Parameterise by a config object (`{ prefix, apiBase, labels, template }`). Fixing H1 once instead of twice is the immediate payoff.

### M5. `TRAVEL_COLS` vs `TRAVEL_COLS_PUBLIC` — 20-line SQL fragment duplicated
- `backend/routes/travel.js:37-70`. The two blocks differ only in `lat, lng` vs `ROUND(lat,2), ROUND(lng,2)`. Build via a template function `travelCols({ publicCoords })` so a new column can't be added to one and missed in the other.

### M6. Embedded listing-search IIFE duplicated between blog and travel pages
- `resources/js/blog.js:107-190` and `resources/js/travel.js:238-315` contain a near-identical ~80-line `initListingSearch` block (URL sync, hide/restore listing, fetch `/search`, render result list). Extract to `resources/js/utils/` with a small options object (type, result URL builder, empty message). The date-sort comparator is also duplicated between the two files.

### M7. `recordVisit('ai-blog')` always fails with 400 — visits never counted
- `resources/js/ai-blog.js:41` sends `page=ai-blog`, but `backend/routes/stats.js:24` whitelists only `['home','blog','travel']`. The error is swallowed by `.catch(function(){})` in `utils/stats.js`, so this is silent. Add `'ai-blog'` to `ALLOWED_PAGES` (and a matching test), or drop the call.

### M8. `POST /stats/visit` has no rate limiter
- `backend/routes/stats.js:29` — the only unauthenticated **write** endpoint in the file, yet `statsRateLimit` is applied only to the two admin GETs. Anyone can inflate counters at line speed. Apply the limiter (or a dedicated one) to `/visit`.

### M9. Two token/auth utility modules on the frontend
- `resources/js/auth-utils.js` (`getToken`, `isAdminSession`) vs `resources/js/admin/auth.js` (`getToken`, `isAuthenticated` — identical logic). Both read `localStorage.adminToken` and decode JWT exp. Consolidate into one module; the duplicate invites drift (e.g. one adding clock-skew handling).

### M10. CV prune-on-confirm can delete the version just made current
- `backend/routes/cv.js:260-289` (`POST /:id/confirm`): after setting the chosen version current, it deletes everything beyond the 5 newest by `uploaded_at`. If the confirmed version is older than the 5 newest uploads, it is pruned in the same transaction — the file is unlinked and the "current" row deleted. Exclude `is_current = TRUE` from the prune query (both here and in `POST /`).

### M11. Dead schema + dead deps
- `SetupSchema` in `backend/middleware/validate.js:94-97` — the `/setup` endpoint was retired (#282, returns 410) and the schema is referenced only by its own test. Remove both.
- `backend/package.json`: `body-parser` (app uses `express.json()`), `nodemon` (scripts use `node --watch`) — unused dependencies.

### M12. `resources/js/config.js` dead code and deprecated alias
- Unused `isDev` const, a commented-out "Before:" implementation, and `export const API = API_BASE` labelled "Deprecated alias remains" with zero importers. Reduce to the single `API_BASE` export.

### M13. GitHub repo/user hard-coded in three places
- `backend/routes/github.js:14` (`GITHUB_REPO = 'AndyRKeys/MyPortfolioSite'`), `backend/scheduler.js:50` (full API URL inline), `resources/js/script.js:78` (`users/AndyRKeys/repos?...per_page=6`). Extract a `GITHUB_REPO` env var / shared constant; make the widget's `per_page=6` a named constant (explicitly called out in issue #522).

### M14. AI generation hard-codes model, endpoints, and timeout
- `backend/utils/aiGenerate.js:156-161, 203-215`: Anthropic model `'claude-sonnet-4-6'`, `max_tokens: 1024`, and the 150 s Ollama timeout are inline literals (Ollama host/model at least honour env vars). Add `ANTHROPIC_MODEL` (and optionally `AI_GENERATE_TIMEOUT_MS`) env vars — model IDs churn faster than deploys.

### M15. SQL `INTERVAL '${…}'` string interpolation pattern
- `backend/routes/auth.js:166, 260, 378` interpolate `WEBAUTHN_CHALLENGE_TTL` / `MAGIC_LINK_TTL` constants into SQL literals. Safe today (module constants), but the codebase's own rule is "always parameterised". Use `NOW() + $n::interval` with the TTL as a bound parameter so a future move to env-configured TTLs can't introduce injection.

### M16. `GET /debug/errors` auth depends on `NODE_ENV` at module load
- `backend/routes/debug.js:14, 215`: `IS_DEV ? passthrough : authenticate`. A prod container accidentally started without `NODE_ENV=production` exposes the full client-error store (URLs, stacks, session IDs) unauthenticated. `NODE_ENV` is not in `REQUIRED_ENV`. Prefer default-deny: require auth unless an explicit `DEBUG_OPEN=1` style flag is set, or add `NODE_ENV` to startup validation.

### M17. `deploy.js` branch cache never invalidated by `POST /fetch`
- `backend/routes/deploy.js:17, 137-161, 265-268`: after a `git fetch`, `/branches` can serve a stale 60 s cache, so a just-pushed branch doesn't appear in the admin selector even though fetch "succeeded". Clear `branchCache` in the `/fetch` handler.

### M18. Contact form logs raw PII in dev fallback
- `backend/routes/contact.js:36-39` logs `{ name, email, message }` at info level when email is unconfigured. The project's own logging rule (and the careful redaction elsewhere, e.g. `redactEmail`) says never log raw emails. Log lengths/redacted values instead.

### M19. Repeated HTML boilerplate across ~20 pages
- Every page (`index.html`, `blog/`, `travel/`, `github/`, `search/`, `ai-blog/`, `login/`, 9 admin pages, post pages) repeats the same `<head>` block (fonts, favicon, css, error-logger), header, `<nav>` skeleton, and footer; the travel lightbox markup is duplicated on two pages. With the no-build-step constraint, full templating isn't free — but nav/footer are already JS-injected (`nav.js`, `admin-subnav.js`); the same pattern could inject head-adjacent boilerplate or at least the lightbox. Otherwise document the duplication as accepted and add a checklist item for cross-page HTML edits.

### M20. Confusing near-duplicate util names: `audit.js` vs `auditLog.js`
- `backend/utils/audit.js` (`logAudit` — writes rows) and `backend/utils/auditLog.js` (`pruneAuditLog` — retention). Two files, one domain, names that read as synonyms. Merge into one `audit.js` module.

---

## Low (style / minor cleanup)

### L1. `backend/routes/health.js` — unused variable, misleading name
- `const result` from `SELECT NOW()` is never used (query alone suffices, but drop the binding); `healthRouter` is a plain handler, not a Router. Rename `healthHandler`.

### L2. `buildPostCard`'s `'travel'` branch is dead
- `resources/js/utils/dom.js:98-161`: only `blog.js` calls it, always with `'blog'`. The 45-line travel branch (and its placeholder logic) is unreachable — `buildPublicTravelCard` is the live path. Remove the branch and simplify the signature.

### L3. `travel-post.js` re-implements `formatVisitDate`
- `resources/js/travel-post.js:12-17` duplicates `resources/js/utils/date.js:formatVisitDate` with slightly different month formatting. Import the shared one (accepting the format difference, or add an options arg).

### L4. Docs drift: jQuery and sessionStorage claims
- CLAUDE.md says "jQuery for legacy compatibility / $.ajax for API calls" — there is no jQuery anywhere in the codebase. `backend/scripts/seed-blog-posts.js` (published blog content) claims the JWT lives in `sessionStorage`; it's actually `localStorage` (`admin/auth.js:4`). Fix the docs (and consider whether localStorage vs sessionStorage is still the intended trade-off).

### L5. Admin subnav omits AI Blog
- `resources/js/admin-subnav.js:4-13` lists 8 sections; `admin/ai-blog.html` exists and is reachable only via a dashboard card (`admin/index.html:69`). Add it to `NAV_ITEMS` or note the omission as deliberate.

### L6. Deploy route rate-limit values inline instead of in `constants.js`
- `backend/routes/deploy.js:21-43` and `debug.js:17-27`, `stats.js`, `search.js`, `audit.js` hard-code `60*1000`/limits inline while posts/travel/cv/upload use named constants from `utils/constants.js`. Pick one convention (constants.js) for all.

### L7. Async style inconsistency in frontend
- Older modules (`script.js`, `blog.js`, `travel.js`, `blog-post.js`, `cv-download.js`) use `var` + `.then()` chains; newer ones (`search.js`, admin modules, `ai-blog.js`) use `const` + async/await. Not a bug, but the mixed styles double the patterns a reader must hold. Migrate opportunistically when files are touched.

### L8. `login.js` success message field mismatch
- `resources/js/login.js:97`: `setMessage(data.message || 'Check your inbox…')` — the backend returns `{ sent: true }` with no `message`, so the fallback always fires. Drop the dead `data.message` read.

### L9. Magic-link expiry duplicated in email copy
- `backend/utils/email.js:153-155` hard-codes "expires in 15 minutes" in two strings while the actual TTL is `MAGIC_LINK_TTL` in `constants.js`. Derive the copy from the constant to avoid drift.

### L10. CV filename literal duplicated
- `'Andy_Keys_CV.pdf'` appears in `backend/routes/cv.js:145` and `resources/js/cv-download.js:39`. Single-source in a constant (or have the frontend honour `Content-Disposition`).

### L11. `travel.js` media-delete endpoint lacks audit logging
- `backend/routes/travel.js:463-484` (`DELETE /:id/media/:mediaId`) is the only travel mutation without `logAudit`, and it also skips the transactional pattern used elsewhere (two sequential queries; a failure between them leaves `posts.media_url` stale).

### L12. `upload.js` `/retry` doesn't check the file exists
- `backend/routes/upload.js:116-142` re-enqueues a job for `path.join(UPLOADS_ORIGINAL_DIR, file)` without an `fs.access` check — a deleted original just fails 3 more retries. Cheap pre-check + 404 improves operator feedback.

### L13. `scripts/archive/` retains 8 obsolete scripts
- Pi-era and Apache-era scripts (`pi-setup.sh`, `fix-apache.ps1`, snap-docker migration, etc.). If they're kept deliberately as history, a one-line README in the folder saying so would stop future reviewers auditing them; otherwise delete (git history preserves them).

### L14. `dev-env.js` hard-codes port `3001` as the dev heuristic
- `resources/js/dev-env.js:12`. Fine today, but the "which env am I in" heuristic exists in two flavours (`config.js` checks hostname only; `dev-env.js` adds port). Consolidate the isDev detection into `config.js` and export it.

### L15. `errorHandler` swallows post-headers errors
- `backend/middleware/errorHandler.js:20`: `if (res.headersSent) return;` — Express convention is `return next(err)` so the connection is torn down rather than silently hung. Minor, mostly affects SSE routes which already handle their own errors.

---

## Summary

| Severity | Count |
|----------|-------|
| High     | 4     |
| Medium   | 20    |
| Low      | 15    |
| **Total**| **39**|

Top priorities: **H1** (publish toggle data loss — fixable in one small backend change), **H2** (open transaction on travel 404), **H3** (verify and remove the docker.sock mount), **H4** (one-line `REQUIRED_ENV` addition). The largest maintainability wins are deleting the dead `admin/travel/` directory (M1), the rate-limiter factory (M2), and the posts/ai-blog route+admin unification (M3/M4) — which also collapses the H1 fix into a single place.
