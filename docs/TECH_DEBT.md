# Tech Debt Audit — Issue #379

**Audited:** 2026-05-31  
**Scope:** Backend routes, backend utils/middleware, frontend JS modules, shell deploy scripts, Docker/Compose  
**Methodology:** Static analysis across all layers; findings flagged by file + line with category and one-line explanation  
**Approach:** Fix by impact — bugs and confusion first, cosmetic last. Do not refactor and add features in the same PR.

---

## Priority Summary — Top 10

These are the highest-impact fixes. Address these before any cosmetic debt.

| # | Finding | File(s) | Category |
|---|---------|---------|----------|
| 1 | `isAdminSession()` always returns `false` — `config.js` reads `sessionStorage.adminToken` but every writer uses `localStorage.adminToken` | `resources/js/config.js:14-16`, `auth-utils.js:2`, `admin/auth.js:4` | DRY / Bug |
| 2 | `JWT_EXPIRY` env var is silently ignored — auth.js hardcodes `'24h'`; ops teams reading `.env.example` believe `JWT_EXPIRY=7d` works | `backend/routes/auth.js:28` | Hardcode |
| 3 | CV download filename mismatch — backend sends `Andy_Keys_CV.pdf`, frontend saves it as `Andrew_Keys_CV.pdf` | `backend/routes/cv.js:77`, `resources/js/cv-download.js:39` | Hardcode / Bug |
| 4 | Lightbox duplicated wholesale (~100 LOC copied verbatim) — any bug fix must be applied twice | `resources/js/travel.js:117-179`, `travel-post.js:8-100` | DRY |
| 5 | DB error response pattern repeated 20+ times — `errorHandler` middleware exists but routes never call `next(err)` for DB failures | `backend/routes/posts.js`, `travel.js`, `auth.js` | DRY |
| 6 | Hand-rolled HTML sanitizer — regex-based XSS filter on user-controlled markdown misses `<svg onload=...>`, mutation XSS vectors | `resources/js/blog-post.js:3-13` | Overcomplicated / Security |
| 7 | Five separate `setMessage` implementations in admin — each targets a different element; diverge over time | `resources/js/admin/cv.js`, `posts.js`, `passkeys.js`, `deploy.js`, `travel.js` | DRY |
| 8 | Slug-uniqueness logic forked three ways — `maxAttempts=100` set in only two of three copies; inconsistent retry behaviour on hard errors | `backend/routes/posts.js:12,32,130`, `travel.js:128` | DRY |
| 9 | `docker compose -f $COMPOSE_FILE` repeated 40+ times in deploy-lib.sh — missing the flag on any new line is a silent failure mode | `scripts/deploy/deploy-lib.sh` (throughout) | DRY |
| 10 | `deploy-lib.sh` is 2139 lines with no internal seams — highest-risk ops file in the repo has no testable sub-components | `scripts/deploy/deploy-lib.sh` | Overcomplicated |

**Honourable mentions (high signal-to-noise):**
- `REPO_URL` baked into 6 separate files — rename = 6 edits
- Magic-link TTL (`INTERVAL '15 minutes'`) and upload limits (`5MB`, `20MB`) belong in env config (security-sensitive)
- Deprecated files `dev-server-deploy.ps1`, `dev-server-deploy-wrapper.sh`, `dev-deploy-wrapper.sh` should be deleted

---

## Layer 1 — Backend Routes (`backend/routes/`)

### DRY violations

- `[DRY]` `backend/routes/posts.js:42-180` — `try/catch + logger.error + res.status(500).json({error:'Database error'})` block repeated 7 times; errorHandler middleware exists but routes call `res.status(500)` directly instead of `next(err)`
- `[DRY]` `backend/routes/travel.js:64-280` — same DB-error pattern repeated 11 times; identical to posts.js
- `[DRY]` `backend/routes/auth.js:55-466` — same DB-error pattern repeated 4 more times
- `[DRY]` `backend/routes/posts.js:10-38` vs `backend/routes/travel.js:140-167` — "generate unique slug by retrying up to 100 times" implemented twice with different control flow (recursive vs iterative); extract `insertWithUniqueSlug(table, baseSlug, columns)`
- `[DRY]` `backend/routes/posts.js:130-149` — slug-on-update is a third near-copy of the same append-`-N`-until-free logic
- `[DRY]` `backend/routes/cv.js:85-94` vs `backend/routes/upload.js:39-48` — identical multer error-handling wrapper; extract `wrapMulter(fieldName, multerInstance)`
- `[DRY]` `backend/routes/travel.js:10-41` — `TRAVEL_COLS` and `TRAVEL_COLS_PUBLIC` differ only in `ROUND(lat,2)`/`ROUND(lng,2)`; build from a single `travelCols({ roundCoords })` template

### Hardened quick-fixes

- `[QUICK-FIX]` `backend/routes/deploy.js:55,62` — `spawnPromise('git', ['fetch',...]).catch(()=>{})` silently discards fetch errors; status panel will lie about being "up to date" if remote is misconfigured
- `[QUICK-FIX]` `backend/routes/deploy.js:115` — `catch { /* log file may not exist yet */ }` swallows all filesystem errors, not just ENOENT
- `[QUICK-FIX]` `backend/routes/auth.js:68-73` — `POST /setup` returns 410 Gone for a retired endpoint; dead routing should be removed or moved to a deprecation router
- `[QUICK-FIX]` `backend/middleware/authenticate.js:12` — bare `} catch {` swallows the specific JWT error (expired vs malformed vs wrong signature); reason is never logged
- `[QUICK-FIX]` `backend/middleware/rateLimit.js:48-50` — failing open on DB error is documented as intentional but has no metric or alert (load-bearing TODO)
- `[QUICK-FIX]` `backend/routes/posts.js:32-37` — retry loop retries on ANY DB error including syntax errors and connection failures (up to 100 times before throwing)
- `[QUICK-FIX]` `backend/routes/cv.js:78` — `res.download` error callback does not log; CV download failures are invisible

### Hardcoding

- `[HARDCODE]` `backend/routes/auth.js:28` — `JWT_EXPIRY = '24h'` hardcoded; env var in `.env.example` and docker-compose.yml is silently ignored (**Priority #2**)
- `[HARDCODE]` `backend/routes/auth.js:25-27` — `RP_NAME`, `RP_ID`, `ORIGIN` default strings; validateEnv.js already requires these, so defaults are unreachable yet read like a real fallback
- `[HARDCODE]` `backend/routes/auth.js:31-43` — rate-limit windows (`60 * 60 * 1000`), limits (5/10), and message strings baked into file
- `[HARDCODE]` `backend/routes/auth.js:128,224,340` — WebAuthn challenge TTL `INTERVAL '5 minutes'` (×2) and magic-link TTL `INTERVAL '15 minutes'` are security-sensitive SQL literals; magic-link TTL should be a named env config
- `[HARDCODE]` `backend/routes/cv.js:26` — `fileSize: 5 * 1024 * 1024` hardcoded; `upload.js:25` has a separate `MAX_FILE_SIZE = 20 * 1024 * 1024`; both should come from env
- `[HARDCODE]` `backend/routes/cv.js:77` — download filename `'Andy_Keys_CV.pdf'` doesn't match frontend `'Andrew_Keys_CV.pdf'` (**Priority #3**)
- `[HARDCODE]` `backend/routes/cv.js:51-58` — regex list of "private info" patterns (SSN, card, sort code, NI) inlined in route handler; should be a scanner utility
- `[HARDCODE]` `backend/routes/deploy.js:11` — `/repo` default `REPO_DIR` hardcoded here, docker-compose.yml:49, and Dockerfile; extract a shared constant
- `[HARDCODE]` `backend/routes/deploy.js:19,26` — history length `20` and `30` poll attempts are magic numbers
- `[HARDCODE]` `backend/routes/posts.js:12,141` — `maxAttempts = 100` slug retry cap set twice independently
- `[HARDCODE]` `backend/routes/posts.js:47,63` — `LEFT(body_markdown, 300)` excerpt length hardcoded in two queries
- `[HARDCODE]` `backend/routes/stats.js:8` — `ALLOWED_PAGES = new Set(['home','blog','travel'])` should come from config if pages become dynamic
- `[HARDCODE]` `backend/routes/upload.js:20-23` — `ALLOWED_MIME` list and `MAX_FILE_SIZE = 20 * 1024 * 1024` should be env-tunable

### Poor naming

- `[NAMING]` `backend/routes/posts.js:12` — `tryInsertPost` with `attempt`/`maxAttempts` mixes concerns; name doesn't reveal it retries on any error including hard failures
- `[NAMING]` `backend/routes/travel.js:52-53` — `vals`/`params` are too generic; `placeholderRows`/`bindParams` would clarify
- `[NAMING]` `backend/routes/debug.js:29` — module-level `let _lastAlertAt = 0`; underscore-prefixed mutable state; should be an `alertState` object

### Overcomplicated code

- `[COMPLEX]` `backend/routes/auth.js:296-357` — `/email/send` does 6 distinct things (normalise, log, gate, upsert user, insert token, send email) in one handler; split into `findOrCreateAdminUser`, `issueMagicLinkToken`, thin route
- `[COMPLEX]` `backend/routes/auth.js:360-436` — `/email/verify` inlines diagnostic CTE SQL; `summariseTokenFailures()` helper with a unit test would be clearer
- `[COMPLEX]` `backend/routes/travel.js:128-240` — POST and PUT each mix transaction control, slug retry, value coercion, media replacement, and SQL (~60 lines each); extract `createTravelPost`/`updateTravelPost` service functions
- `[COMPLEX]` `backend/routes/deploy.js:31-48` — `streamToSSE` bundles header setup, SSE framing, error mapping, and end-of-stream in one function; extract as a helper

---

## Layer 2 — Backend Utils & Middleware (`backend/utils/`, `backend/middleware/`, `backend/server.js`)

### DRY violations

- `[DRY]` `backend/utils/email.js:77-176` — `sendContactEmail`, `sendErrorAlertEmail`, `sendMagicLink` each repeat the "pick transport, build subject/html/text, branch on OAuth2 vs SMTP" pattern; extract a `sendMail({ to, replyTo, subject, html, text })` core
- `[DRY]` `backend/utils/email.js:88,107-109,146-153` — three HTML email templates built by raw string concatenation
- `[DRY]` `backend/utils/html.js:8-15` vs `resources/js/utils/html.js:6-13` — identical `escapeHtml` implementation; by necessity (ESM can't cross environments), but both files should note the twin so they stay aligned
- `[DRY]` `backend/server.js:11` and `backend/app.js:80` — both compute `UPLOADS_DIR` with different relative paths (`../..` vs `..`); subtle drift
- `[DRY]` `backend/routes/cv.js:20` and `backend/routes/upload.js:10` — both define `UPLOADS_DIR` independently; extract to `backend/utils/paths.js`

### Hardened quick-fixes

- `[QUICK-FIX]` `backend/server.js:57-61` — forced `process.exit(1)` after 10 s on graceful-shutdown timeout; `10000` is a magic number with no env override
- `[QUICK-FIX]` `backend/utils/email.js:63` — `res.json().catch(()=>({}))` swallows JSON-parse errors of Graph API error responses; surfaces as "Graph API error 400" with no payload
- `[QUICK-FIX]` `backend/middleware/resolveUser.js:14-16` — bare `} catch {` consumes JWT verification errors; malformed tokens never log

### Hardcoding

- `[HARDCODE]` `backend/server.js:13` — `PORT = process.env.PORT || 3001`; validateEnv.js requires PORT, so the fallback is dead and misleads readers
- `[HARDCODE]` `backend/utils/email.js:71` — `parseInt(process.env.SMTP_PORT || '587')` missing radix and has a magic-number default
- `[HARDCODE]` `backend/app.js:78` — `express.json({ limit: '10mb' })` body-size limit hardcoded
- `[HARDCODE]` `backend/app.js:56,59` — CORS fallback `'http://localhost:5500'` hardcoded; contradicts validateEnv.js which requires `FRONTEND_URL`
- `[HARDCODE]` `backend/middleware/rateLimit.js:7-9` — defaults `limit=10`, `windowMs=60*1000`; keyGenerator reads `x-forwarded-for` without validation (trust assumption belongs at proxy layer)

### Poor naming

- `[NAMING]` `backend/utils/shell.js:13-20` — local helpers `push`/`notify`/`closed`/`error`/`onData`/`onClose`/`onError` inside async generator make control flow opaque; `enqueue`/`resolveNext`/`streamClosed`/`streamError` would clarify
- `[NAMING]` `backend/middleware/rateLimit.js:13` — missing-IP key silently = unlimited requests; `createRateLimiter` doesn't hint at this behaviour

### Overcomplicated code

- `[COMPLEX]` `backend/utils/shell.js:5-35` — async generator hand-rolls a single-slot promise queue; replaceable with `events.on(stream, 'data')` (Node 12.10+) or `Readable.from()`
- `[COMPLEX]` `backend/app.js:62-72` — CORS origin check nests an IIFE inside a regex chain inside a predicate; extract as a named `isOriginAllowed(origin)` helper for testability

---

## Layer 3 — Frontend JS Modules (`resources/js/`)

### DRY violations

- `[DRY]` `resources/js/config.js:14-16` vs `auth-utils.js:2` vs `admin/auth.js:4` — **three `getToken`/`isAdminSession` implementations disagreeing on storage backend** (`sessionStorage` vs `localStorage`); `isAdminSession()` always returns `false` in code that imports from config.js (**Priority #1 — Bug**)
- `[DRY]` `resources/js/admin/cv.js`, `posts.js`, `passkeys.js`, `deploy.js`, `travel.js` — `setMessage(msg, isError)` re-defined in 5 modules, each targeting a different element; extract `createMessenger(elementId)` factory (**Priority #7**)
- `[DRY]` `resources/js/travel.js:117-179` vs `travel-post.js:8-100` — entire lightbox (~100 LOC) duplicated verbatim between two pages (**Priority #4**)
- `[DRY]` `resources/js/admin/posts.js:50-89` vs `admin/travel.js:95-142` — `buildRow()` 90% identical; extract `buildAdminListRow({ title, statusHtml, meta, actions })`
- `[DRY]` `resources/js/travel.js:9-23` vs `utils/dom.js:165-227` — `buildPopupHtml` and `buildPublicTravelCard` render same fields differently; should share one template
- `[DRY]` `resources/js/admin/travel.js:239-242` vs `travel.js:43-46` vs `travel-post.js:187-190` — Leaflet tile-layer URL and OSM attribution copied verbatim 3 times; extract `addOsmTileLayer(map)`
- `[DRY]` `resources/js/blog.js:73-77` vs `travel.js:204-208` — identical `post_date` ISO-string sort comparator; extract `byPostDateDesc`
- `[DRY]` `resources/js/admin/posts.js:122`, `admin/travel.js:170` (and others) — `String(full.post_date).slice(0,10)` coercion for `<input type="date">` repeated throughout; extract `dateInputValue(raw)`
- `[DRY]` `resources/js/blog.js:100`, `travel.js:252`, `script.js:154`, `travel-post.js:131` — fire-and-forget `fetch(API_BASE + '/stats/visit?page=...')` call repeated 4 times; extract `recordVisit(page)`
- `[DRY]` `resources/js/script.js:147-163` vs `blog.js`/`travel.js` visit calls — admin-session guard (`isAdminSession()` check) only in script.js; blog and travel post visits are counted even when logged in as admin
- `[DRY]` `resources/js/admin/posts.js:208,215`, `admin/travel.js:512` — "confirm before clearing a form with content" guard duplicated; extract `confirmDiscardChanges(fieldIds)`
- `[DRY]` Admin modules × 5 — same `<p class="hint" style="color:var(--color-error)">Failed to load X.</p>` error markup repeated; extract one helper
- `[DRY]` `resources/js/admin/auth.js:44-48` vs `admin/cv.js:44-48` — `uploadCv` re-implements multipart fetch with Authorization header when `authFetchMultipart` is already exported from `auth.js`

### Hardened quick-fixes

- `[QUICK-FIX]` `resources/js/admin/deploy.js:101-106` — catch block assumes any SSE stream failure means "backend restarting"; a bug in the handler will still show "Backend recovered ✓" once /status returns 200
- `[QUICK-FIX]` `resources/js/admin/cv.js:30,86` — bare `} catch {` discards actual error; transient network blip and real server failure produce the same user message
- `[QUICK-FIX]` `resources/js/admin/posts.js:103,123,142,154` — all catch blocks are bare; HTTP 401 (token expiry) and HTTP 500 produce identical "Failed to ..." popup
- `[QUICK-FIX]` `resources/js/admin/travel.js:154-156,190-192,213-215,224-226,302-304,316,323-325,362-364` — 8+ bare `} catch {}` / `} catch { /* ignore */ }` blocks; several swallow save/load errors with no logging
- `[QUICK-FIX]` `resources/js/login.js:97` — `} catch {` ignores real error reason; always shows "Is the backend running?"
- `[QUICK-FIX]` `resources/js/cv-download.js:14-16` — `.catch(()=>{ btn.style.display='none'; })` silently hides the CV button on any failure

### Hardcoding

- `[HARDCODE]` `resources/js/cv-download.js:9,30` — `/api/cv/exists` and `/api/cv` hardcode `/api/` prefix instead of importing `API_BASE`
- `[HARDCODE]` `resources/js/cv-download.js:39` — download filename `'Andrew_Keys_CV.pdf'` doesn't match backend's `'Andy_Keys_CV.pdf'` (**Priority #3**)
- `[HARDCODE]` `resources/js/script.js:77` — GitHub API URL hardcodes username `AndyRKeys` and `per_page=6`
- `[HARDCODE]` `resources/js/script.js:89-90` — GitHub fallback links repeat `AndyRKeys` username twice; should be a constant
- `[HARDCODE]` `resources/js/admin/travel.js:1`, `login.js:4`, `admin/passkeys.js:1` — CDN import URLs with pinned versions (`exifr@7.1.3`, `@simplewebauthn/browser@7`) in 3 separate files; version drift is invisible
- `[HARDCODE]` `resources/js/admin/travel.js:296,375` — Nominatim URL repeated; should be a constant
- `[HARDCODE]` `resources/js/admin/travel.js:391` — `setTimeout(()=>{ ... }, 1500)` flash duration magic number
- `[HARDCODE]` `resources/js/admin/deploy.js:111,117` — `attempts > 30` and `setTimeout(r, 2000)` together make a 60 s wait via two separate magic numbers
- `[HARDCODE]` `resources/js/admin/posts.js:6-30` — large markdown template baked into JS; should be a `.md` asset or fetched
- `[HARDCODE]` `resources/js/login.js:11,35` — colour values `#c0392b`/`#27ae60` hardcoded instead of CSS vars (`var(--color-error)`/`var(--color-success)`)
- `[HARDCODE]` `resources/js/error-logger.js:67` — browser extension URL regex missing `edge-extension://`
- `[HARDCODE]` `resources/js/error-logger.js:80-81` — `BUFFER_KEY`, `BUFFER_MAX`, `MAX_STORED_ERRORS`, `10_000` ms request-id window scattered as inline constants

### Poor naming

- `[NAMING]` `resources/js/config.js:11-12` — `export const API = API_BASE` comment says "Deprecated alias remains"; verify no callers then delete
- `[NAMING]` `resources/js/admin/notes.js:1-14` — `initNotes`, DOM ids `private-notes`/`private-project-notes`/`privateProjectNotes` mix three naming styles for the same concept
- `[NAMING]` `resources/js/script.js:7-9,20-21` — `leftPaddle`, `rightPaddle`, `hsWrap`, `hs`, `portConts` are module-level globals with no comments
- `[NAMING]` `resources/js/utils/dom.js:14` — `el(tag, attrs)` is too generic; `createEl` would read better in context
- `[NAMING]` `resources/js/admin/travel.js:5-11` — module-level mutable state (`pendingFiles`, `existingMedia`, `removedMediaIds`, `geoconfirmMap`, `geoconfirmMarker`) without a namespacing object; tech-debt magnets

### Overcomplicated code

- `[COMPLEX]` `resources/js/admin/travel.js` (517 lines) — single module owns: form state, media list, geocode confirmation map, EXIF GPS, EXIF date, reverse geocoding, location normalisation, file upload orchestration, list render, edit loading, publish toggle, delete; split into `media-list.js`, `geocode.js`, `exif.js`, `travel-form.js`
- `[COMPLEX]` `resources/js/admin/deploy.js:61-107` — inline SSE parser (decoder, buffer, `parseLine`, error branch, drop-recovery polling); extract as `streamSse(authFetch, path, body, onLine)`
- `[COMPLEX]` `resources/js/blog-post.js:3-13` — hand-rolled HTML sanitizer with regex attribute-stripping; misses `<svg onload=...>`, mutation XSS vectors; replace with DOMPurify (**Priority #6 — Security**)
- `[COMPLEX]` `resources/js/script.js:5-69` — horizontal-scroll carousel mixes module-level mutable state, queried element lists, and lifecycle in one un-scoped block; wrap in `initCarousel()`
- `[COMPLEX]` `resources/js/error-logger.js` (261 lines) — buffering, dedup, recursion guard, fetch wrap, console-override, three event listeners in one file; well-commented but sub-modules would allow testing each concern independently

---

## Layer 4 — Shell Deploy Scripts (`scripts/deploy/`)

### DRY violations

- `[DRY]` `scripts/deploy/dev-deploy.ps1:40-46` vs `prod-deploy.ps1:40-45` — same heredoc-and-SSH deploy pattern; extract `Invoke-RemoteDeploy -Env -Repo -Branch -Flags` PowerShell function
- `[DRY]` `scripts/deploy/dev-deploy.ps1:48` and `prod-deploy.ps1:48` — CRLF strip `$remoteCommand -replace "\`r\`n","\`n"` duplicated
- `[DRY]` `scripts/deploy/deploy-lib.sh` (throughout) — `docker compose -f "$COMPOSE_FILE"` appears ~40 times; add `dc() { docker compose -f "$COMPOSE_FILE" "$@"; }` wrapper (**Priority #9**)
- `[DRY]` `scripts/deploy/deploy-lib.sh:1444-1625` — `test_error_logger_all_pages`, `test_error_logger_contracts`, `check_public_page_js`, `check_csp_violations`, `check_admin_e2e_csp` share the same shape (check URL → run test → grep summary → emit dstatus); extract `run_browser_test <name> <npm-script> <status-key>`
- `[DRY]` `scripts/deploy/deploy-lib.sh:1218,1236,1239` — three places run psql inside compose; add `dc_psql()` helper
- `[DRY]` `scripts/deploy/deploy-lib.sh:1026-1068` — `_do_rollback` three branches each repeat `git checkout/reset → compose down → compose up → health check`; extract `_rollback_to <branch> <sha>`
- `[DRY]` Deprecated files still present alongside active ones — remove `dev-server-deploy.ps1`, `dev-server-deploy-wrapper.sh`, `dev-deploy-wrapper.sh`
- `[DRY]` `scripts/deploy/server-setup.sh:125-126` and `deploy-lib.sh:2020` — backup cron line hardcoded in two places

### Hardened quick-fixes

- `[QUICK-FIX]` `scripts/deploy/deploy-lib.sh` — 41 instances of `|| true` / `2>/dev/null ||`; several are load-bearing:
  - Lines 1037, 1049, 1059: `compose down || true` during rollback — down failure invisible, subsequent `up --build` may hit stale state
  - Lines 1110, 1125-1126: rollback `down`/`prune`/`up` chained with `|| true` — any failure is invisible
  - Lines 1037, 1048, 1058: `git checkout/reset || true` — git failure during rollback logged but deploy continues as if succeeded
- `[QUICK-FIX]` `scripts/deploy/deploy-lib.sh:1242` — `psql ... 2>/dev/null | tail -1 || echo "?"` — if psql is broken, prune appears to succeed with `deleted=?`
- `[QUICK-FIX]` `scripts/deploy/deploy-lib.sh:71-90` — `_redact_sensitive` runs every log line through 7 `echo | sed` invocations; fragile `set -e` interaction with subshells
- `[QUICK-FIX]` `scripts/deploy/server-setup.sh:6` — `set -e` only (not `set -euo pipefail`); typo'd variable silently expands to empty, piped failures invisible
- `[QUICK-FIX]` `scripts/deploy/deploy-lib.sh:1881-1888` — LAN IP autodetect fallback returns 0 without writing `.env` if both detection methods yield 127.x.x.x; caller proceeds with unset `LAN_IP`

### Hardcoding

- `[HARDCODE]` `REPO_URL="https://github.com/AndyRKeys/MyPortfolioSite.git"` baked into 6 files: `deploy.sh:96`, `dev-deploy.ps1:37`, `prod-deploy.ps1:37`, `dev-server-deploy-wrapper.sh:34`, `dev-deploy-wrapper.sh:26`, `server-setup.sh:51`
- `[HARDCODE]` `scripts/deploy/deploy.sh:113,133` — `MyPortfolioSite-dev` and `MyPortfolioSite` repo dir names baked in
- `[HARDCODE]` `scripts/deploy/deploy.sh:90-91` — `HEALTH_TIMEOUT=60`, `HEALTH_INTERVAL=5`; should be env-overridable
- `[HARDCODE]` `scripts/deploy/dev-deploy.ps1:7` and `prod-deploy.ps1:12` — `$Hostname = 'ak-home-server'` SSH host pinned in script body (also `dev-server-deploy.ps1:23`)
- `[HARDCODE]` `scripts/deploy/deploy-lib.sh:1730-1731` — `ifconfig.me` and `8.8.8.8` baked into DDNS check
- `[HARDCODE]` `scripts/deploy/deploy-lib.sh:1223,1240` — `DB_NAME:-portfolio_prod` default used in both dev and prod contexts
- `[HARDCODE]` `scripts/deploy/deploy-lib.sh:2010` — `max_age_days=2` backup staleness threshold
- `[HARDCODE]` `scripts/deploy/check-server-ready.sh:84` — `REQUIRED_GB=10` disk requirement
- `[HARDCODE]` `scripts/deploy/output-lib.sh:49` — emoji list for visual-width calculation; new icons added elsewhere will mis-render

### Poor naming

- `[NAMING]` `scripts/deploy/deploy-lib.sh:163,180` — `_save_last_good_state`/`_restore_last_good_state` use underscore (private convention) but are called from `_do_rollback`; underscore has no meaning in bash visibility
- `[NAMING]` `scripts/deploy/deploy-lib.sh:229-230` — `_kv_num`/`_kv_str` cryptic; `parse_status_int`/`parse_status_str` would read better
- `[NAMING]` `scripts/deploy/deploy.sh:71` — `AUTO_YES` is non-standard; `INTERACTIVE=0` or `ASSUME_YES=1` are conventional
- `[NAMING]` `scripts/deploy/` — `dev-deploy.ps1` and `dev-server-deploy.ps1` (deprecated) coexist; ambiguous for a new contributor

### Overcomplicated code

- `[COMPLEX]` `scripts/deploy/deploy-lib.sh` at **2139 lines** — split into sub-libs: (**Priority #10**)
  - `deploy-lib-env.sh` — load_env, sync_env_from_template, validate_env, migrate_env_values, prompt_missing_vars, redact_env
  - `deploy-lib-docker.sh` — compose_up_with_rollback, _do_rollback, _check_rollback_health, check_nginx_config, cleanup_stale_compose_projects
  - `deploy-lib-health.sh` — wait_for_health, _poll_health, check_outlook_token
  - `deploy-lib-tests.sh` — run_deploy_tests, all browser-test functions
  - `deploy-lib-checks.sh` — check_ddns_sync, check_ufw_port, check_port_availability, check_disk_space, check_backup_health, auto_detect_lan_ip
  - `deploy-lib-report.sh` — print_deploy_status, print_deploy_report, log_deploy_summary
- `[COMPLEX]` `scripts/deploy/deploy-lib.sh:441-575` — `sync_env_from_template` does template walking, key carry-over, placeholder classification, backup-and-swap, dropped-key detection in 130 lines; warrants splitting
- `[COMPLEX]` `scripts/deploy/deploy-lib.sh:638-740` — `migrate_env_values` has nested case statements, nameref-style indirection, and heredoc greps; functional but dense
- `[COMPLEX]` `scripts/deploy/deploy-lib.sh:2006-2139` — `check_backup_health` does three distinct checks, two of which prompt the user inline; should be three sub-functions

---

## Layer 5 — Docker / Compose

### DRY violations

- `[DRY]` `docker-compose.yml:46-75` vs `docker-compose.local.yml:28-50` — backend `environment:` blocks repeat ~20 env-var entries; use YAML anchors (`&backend-env`) or rename local file to `docker-compose.override.yml`
- `[DRY]` `docker-compose.yml` and `docker-compose.local.yml` — identical `logging.options` blocks (max-size/max-file) repeated 6 times across both files; use YAML anchors
- `[DRY]` Postgres `healthcheck` block duplicated: `docker-compose.yml:30-34` and `docker-compose.local.yml:13-17`
- `[DRY]` Backend `healthcheck` block duplicated: `docker-compose.yml:83-87` and `docker-compose.local.yml:61-65`
- `[DRY]` `backend/Dockerfile:35-36` — `HEALTHCHECK` defined in Dockerfile AND both compose files; three sources of truth for "is backend healthy"

### Hardened quick-fixes

- `[QUICK-FIX]` `docker-compose.local.yml:35` — `JWT_SECRET: ${JWT_SECRET:-dev-secret-key-change-in-production}` silent fallback to a known string defeats validateEnv.js
- `[QUICK-FIX]` `docker-compose.yml:79` — `/var/run/docker.sock` mounted into backend container; required for deploy route but represents a significant privilege escalation surface; add inline comment with the trade-off and issue number for revisiting

### Hardcoding

- `[HARDCODE]` `docker-compose.yml:53,68-69` — `DB_PORT: 5432`, `SMTP_HOST: smtp.gmail.com`, `SMTP_PORT: 587` inline defaults; SMTP defaults don't match the Microsoft Graph path the codebase actually uses
- `[HARDCODE]` `docker-compose.yml:21` and `docker-compose.local.yml:3` — `postgres:16-alpine` version string in two places
- `[HARDCODE]` `docker-compose.yml:95` and `docker-compose.local.yml:73` — `nginx:alpine` image string duplicated
- `[HARDCODE]` `backend/Dockerfile:4` — `node:20-alpine` baked image version with no `ARG` declaration
- `[HARDCODE]` `backend/Dockerfile:36` — health check inline script hardcodes port `8080`; conflicts with `EXPOSE ${PORT:-8080}` (substitution doesn't apply at runtime)
- `[HARDCODE]` `docker-compose.yml:49,51` — `REPO_DIR: /repo` and `DEPLOY_REPO_DIR: /repo` repeated; same path in `backend/routes/deploy.js:11` and `Dockerfile:24`
- `[HARDCODE]` `docker-compose.local.yml:75` — `ports: "80:80"` hardcoded host port; can collide with other dev laptop apps

### Poor naming

- `[NAMING]` `docker-compose.local.yml` filename — `docker-compose.yml` is "dev or prod depending on .env" while `.local.yml` is "laptop dev"; the asymmetry is non-obvious without reading the README
- `[NAMING]` `docker-compose.yml:131-132` — nested `${A:-${B}_postgres_data}` volume name parameter expansion; add inline comment

### Overcomplicated code

- `[COMPLEX]` `docker-compose.yml:129-132` — nested variable expansion for volume names, combined with migrate history in `cleanup_stale_compose_projects`, makes "where is my data?" non-trivial to answer

---

## Suggested Fix Order

Work through findings in this order to get the most value per PR:

**Phase 1 — Bugs (do first)**
1. Fix `isAdminSession()` storage-backend mismatch (#1 above)
2. Wire `JWT_EXPIRY` env var in auth.js (#2)
3. Align CV download filename (#3)

**Phase 2 — Security**
4. Replace hand-rolled HTML sanitizer with DOMPurify in blog-post.js (#6)
5. Add comment + issue reference to docker.sock mount in docker-compose.yml

**Phase 3 — DRY / high-churn areas**
6. Extract lightbox into a shared module (#4)
7. Funnel backend DB errors through errorHandler via `next(err)` (#5)
8. `createMessenger(elementId)` factory for admin modules (#7)
9. `insertWithUniqueSlug` helper (#8)
10. `dc()` wrapper in deploy-lib.sh (#9)

**Phase 4 — Structural (highest effort, highest long-term payoff)**
11. Split `deploy-lib.sh` into sub-libs (#10)
12. Split `admin/travel.js` into `media-list.js`, `geocode.js`, `exif.js`, `travel-form.js`
13. Remove deprecated deploy scripts
14. `recordVisit(page)` util + add admin-session guard to all callers

**Leave for later / document-and-move-on:**
- CDN version pinning in ESM imports (low blast radius, tolerable)
- YAML anchors in compose files (reduces noise but risk is low)
- Renaming `AUTO_YES` to `INTERACTIVE` (cosmetic)
- `el()` → `createEl()` rename (wide search-replace, low value)
