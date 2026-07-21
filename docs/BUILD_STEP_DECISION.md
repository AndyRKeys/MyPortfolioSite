# Build Step Decision: Keep No-Build vs Introduce Vite

_Written: 2026-07-06. Updated: 2026-07-11. Resolves issue #257._

---

## Recommendation: Keep no-build. Migrate Puppeteer E2E to Playwright for cross-browser coverage.

The case for a bundler rests almost entirely on unblocking frontend testing. That gap is not a gap — six Puppeteer scripts already run against a real browser on every deploy. The missing piece is cross-browser coverage (Firefox + WebKit/Safari): Playwright closes that without any bundler. The remaining arguments for a build — CDN imports, cache-busting — are either manageable or addressable without a bundler.

Revisit this decision if: (a) module-level unit tests of complex frontend logic become clearly needed, or (b) TypeScript adoption on the frontend becomes a priority.

---

## Current state

- ~50 JS files, ~4,700 lines, all vanilla ES modules served directly by Nginx
- Nginx roots the repo (`${REPO_DIR}`) and serves `resources/js/` as-is
- Cache-busting: Nginx `sub_filter` appends `?v=${DEPLOY_VERSION}` to `.js` references in HTML at deploy time
- **4 CDN imports** loaded at runtime:
  - `DOMPurify` from `cdn.jsdelivr.net` (blog-post.js, ai-blog-post.js)
  - `exifr` from `esm.sh` (admin/travel.js)
  - `@simplewebauthn/browser` from `esm.sh` (login.js, admin/passkeys.js)
- **Existing browser-level test coverage (Puppeteer):** six scripts run inside the backend container post-deploy, covering all public pages, admin CRUD, CSP auditing, and error-logger contracts (see "Current Puppeteer suite" below)
- Zero frontend unit or integration tests; regressions caught by Puppeteer E2E (post-deploy, automatic) and manual smoke test scripts (`Test-PRN.ps1`)

---

## Current Puppeteer suite

Chromium is baked into the backend Docker image specifically for these tests. All scripts run automatically inside the deployed container on every dev/prod deploy, gated by `RUN_ERROR_LOGGER=1`.

| Script | npm script | What it covers |
|---|---|---|
| `test-error-logger.js` | `test:error-logger` | Error logger initialises and reports on `/api/debug/test-errors` |
| `test-error-logger-all-pages.js` | `test:error-logger:all-pages` | Logger initialises on every public page (`/`, `/blog/`, `/travel/`, `/login/`) |
| `test-error-logger-browser.js` | `test:error-logger:browser` | Behavioural contracts via request interception: buffering, flushing, deduplication, hang-resistance |
| `test-csp-violations.js` | `test:csp-violations` | No first-party CSP violations on any public page — catches missing allowlist entries (#341) |
| `test-admin-e2e-csp.js` | `test:admin-e2e-csp` | Authenticated admin interactions (Nominatim geocoding, static assets) produce no CSP violations (#342) |
| `test-admin-e2e.js` | `test:admin-e2e` | Full authenticated CRUD E2E — blog create/delete, travel create/delete, deploy panel smoke (#175); checks for unhandled JS exceptions during interactions (#397) |
| `test-public-pages.js` | `test:public-pages` | All public + admin pages load without unhandled JS exceptions — catches null dereferences and import failures invisible to curl (#390, #397) |

**Key implementation note:** every script that loads live pages intercepts and mocks `POST /api/debug/errors` using `page.setRequestInterception(true)`. Headless Chromium generates internal noise errors that would otherwise pollute the `client_errors` table and trigger false alert emails. Any new E2E script that loads pages must do the same.

---

## Why each argument lands where it does

### Argument 1: Frontend testing (strongest case for a build)

The PROJECT_ASSESSMENT notes "zero frontend unit or integration tests" as the primary gap. That gap is substantially closed by the existing Puppeteer suite — the suite exercises real browser JS, catches null dereferences, import failures, CSP regressions, and full admin CRUD flows. What is missing is _cross-browser_ coverage: the suite runs only against Chromium (bundled in the Docker image). Firefox and WebKit/Safari are untested.

**Vitest + jsdom/browser (needs bundler):** Would unlock module-level unit tests. Requires a build step for module resolution. High migration cost for uncertain incremental value over the existing Puppeteer suite.

**Playwright (no build step needed):** Same approach as Puppeteer — tests the real app in a real browser — but with built-in support for Chromium, Firefox, and WebKit. Playwright also brings auto-waiting (eliminating most manual `waitForSelector` calls), a first-class test runner (`@playwright/test`), and traces/screenshots on failure. The right move is to migrate the existing Puppeteer scripts to Playwright rather than running two frameworks in parallel. See "Migration plan" below.

**Verdict:** The cross-browser coverage gap is best closed by migrating Puppeteer to Playwright. If Playwright is in place and module-level unit tests of complex frontend logic become clearly needed, revisit the build step then.

### Argument 2: CDN imports (legitimate concern, not a build-step problem)

Four packages are loaded from external CDNs at runtime. This means:
- Page load has a network dependency on jsDelivr and esm.sh
- CSP must allowlist those origins
- Version pinning requires manual URL maintenance

However, the correct fix is **Import Maps** — a browser-native feature that maps bare specifier names to URLs, centralising version control without requiring a bundler. For example:

```html
<script type="importmap">
{
  "imports": {
    "dompurify": "https://cdn.jsdelivr.net/npm/dompurify@3.4.7/dist/purify.es.mjs",
    "exifr": "https://esm.sh/exifr@7.1.3"
  }
}
</script>
```

This lets the import statements read as `import DOMPurify from 'dompurify'` (no URL) and keeps version control in one HTML file per page. It does not require a bundler. Tracked separately as a potential follow-up, not a blocker for this decision.

### Argument 3: Cache-busting (already solved)

The Nginx `sub_filter` appending `?v=${DEPLOY_VERSION}` is functional. It is not content-addressed (a file change in one module doesn't invalidate only that module's cache), but for this traffic level it is adequate. A bundler with hashed filenames would be cleaner, but the current approach has caused no incidents.

### Argument 4: Folder reorganisation (#178, #228)

The issue explicitly says this should not be the primary driver, and it is not. The folder pain comes from Nginx rooting the repo, which is fixable independently by adjusting the Nginx `root` to point at a subdirectory (e.g. `resources/`) without a bundler. This is tracked in #178/#228 and is out of scope here.

### Argument 5: "Source = served file" AI-agent advantage (strongest case against)

The current model means the file that runs in the browser IS the file in the repo. During debugging, agents and the owner inspect production output directly — no sourcemaps, no bundler output, no dist/ directory to reason about. This has measurably helped agent sessions (noted in PROJECT_ASSESSMENT §6). Introducing a build step adds a layer of indirection that increases cognitive overhead in every debugging session.

---

## Migration plan: Puppeteer → Playwright

### Why migrate

The existing Puppeteer suite is valuable and runs on every deploy — it should not be discarded. The motivation to migrate is specifically **cross-browser support**:

- Puppeteer is Chromium-only. The backend Docker image ships Chromium for this purpose.
- Playwright supports Chromium, Firefox, and WebKit (Safari's rendering engine) with a single API.
- The owner wants cross-browser coverage. Playwright is the straightforward path to it without adding a second framework or a build step.

### Playwright advantages relevant to this project

| Puppeteer pattern | Playwright equivalent | Advantage |
|---|---|---|
| Manual `await page.waitForSelector(sel)` before interactions | Auto-waiting built into `page.click()`, `page.fill()`, `page.locator()` etc. | Eliminates most explicit waits; less flaky |
| `page.setRequestInterception(true)` + `page.on('request', ...)` | `page.route(urlPattern, handler)` | Simpler API; pattern matching built in |
| `puppeteer.launch({ args: ['--no-sandbox', ...] })` | `chromium.launch()` / `firefox.launch()` / `webkit.launch()` | Native multi-browser; same script runs all three |
| No built-in assertion library | `expect(locator).toBeVisible()` etc. via `@playwright/test` | First-class assertions with helpful error messages |
| No failure artefacts | Automatic screenshots + traces on failure | Dramatically faster debugging of deploy-time test failures |
| No test isolation primitives | `browser.newContext()` per test | Isolated state without launching a new browser process |

### Migration approach

**Incremental — one script at a time.** Keep every Puppeteer script in place and passing until its Playwright replacement is proven on a deploy. Remove Puppeteer only after all scripts are migrated.

1. Add `@playwright/test` as a `devDependency` in `backend/package.json`.
2. Install Playwright browsers in the Docker image (see "Docker changes" below). Keep Chromium from the apk until migration is complete.
3. Create a `backend/scripts/tests/playwright/` directory for the new scripts.
4. Convert scripts in the order below (simplest to most complex).
5. Wire each new Playwright script into the deploy pipeline as the parallel replacement for its Puppeteer counterpart. Run both briefly to verify parity, then remove the Puppeteer script.
6. Once all scripts are migrated, remove the `puppeteer` dependency from `package.json` and remove Chromium from the Docker image apk install.

### Suggested migration order

| Order | Script | Complexity | Reason |
|---|---|---|---|
| 1 | `test-error-logger.js` | Low | Single page load, no auth, no request interception |
| 2 | `test-error-logger-all-pages.js` | Low | Loop over static pages, no auth, straightforward interception |
| 3 | `test-public-pages.js` | Medium | Dynamic slug discovery via API calls, page error listening, many pages |
| 4 | `test-csp-violations.js` | Medium | `securitypolicyviolation` event listening, known-noise filtering |
| 5 | `test-error-logger-browser.js` | Medium-high | Request interception to simulate backend up/down; buffering contracts |
| 6 | `test-admin-e2e-csp.js` | Medium-high | Auth via JWT injection, Nominatim interactions, CSP event listening |
| 7 | `test-admin-e2e.js` | High | Full CRUD flows, cleanup logic, deploy panel, JS exception detection |

### Docker image changes

The backend `Dockerfile` currently installs Chromium via `apk add chromium`. Playwright manages its own browser binaries via `npx playwright install`.

During migration:

```dockerfile
# Keep both during migration
RUN apk add --no-cache chromium  # for Puppeteer (remove once migration complete)
RUN npx playwright install --with-deps chromium firefox webkit
```

After migration is complete:

```dockerfile
# Remove apk chromium; Playwright manages all browsers
RUN npx playwright install --with-deps chromium firefox webkit
```

Note: `--with-deps` installs the OS-level libraries each browser needs. This adds image size but is required for Firefox and WebKit to run in Alpine/Debian containers.

### Gotchas specific to this codebase

**Request interception is required on every page-loading script.**

Every current Puppeteer script that loads live pages intercepts `POST /api/debug/errors` to prevent headless-browser noise from polluting the `client_errors` table. This pattern carries over to Playwright but uses a different API:

```js
// Puppeteer (current)
await page.setRequestInterception(true);
page.on('request', (req) => {
  if (req.method() === 'POST' && req.url().includes('/api/debug/errors')) {
    req.respond({ status: 200, contentType: 'application/json', body: '{"received":true}' });
    return;
  }
  req.continue();
});

// Playwright (replacement)
await page.route('**/api/debug/errors', (route) => {
  if (route.request().method() === 'POST') {
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"received":true}' });
    return;
  }
  route.continue();
});
```

Any new Playwright script that loads pages must call `page.route()` to mock this endpoint before the first `page.goto()`. This is enforced by the same policy as the Puppeteer scripts.

**JWT injection for authenticated tests.**

`test-admin-e2e.js` and `test-admin-e2e-csp.js` mint a JWT from `JWT_SECRET` and inject it into `localStorage.adminToken`. This technique works identically in Playwright:

```js
// Playwright equivalent
await page.goto(baseUrl + '/admin/');
await page.evaluate((token) => {
  localStorage.setItem('adminToken', token);
}, testToken);
await page.reload();
```

**Self-signed certificate on dev.**

Puppeteer uses `--ignore-certificate-errors` in launch args. The Playwright equivalent: pass `ignoreHTTPSErrors: true` to `browser.newContext()` or set it in the Playwright config.

**Machine-parseable summary lines.**

The deploy pipeline collects `[deploy:*]` lines from each test script's output. Playwright scripts should emit the same `[script-name] status=OK|FAIL tests=N passed=N failed=N` format so the deploy report structure is unchanged.

### Suggested issue title

> "Migrate Puppeteer E2E scripts to Playwright for cross-browser coverage (Firefox + WebKit)"

Label with `ops`, `feature`. No security or auth impact — this is test infrastructure only.

---

## Blast radius if the decision were reversed (for reference)

If a build step were introduced (Vite recommended as the lightest option), the affected surfaces would be:

| Surface | Change required |
|---------|----------------|
| `docker-compose.yml` (all 3 variants) | Add a build stage or build step before `up` |
| Nginx config templates (3 files) | Change `root ${REPO_DIR}` to `root ${REPO_DIR}/dist` |
| Deploy scripts | Add `npm run build` before compose up; include dist/ in image or volume |
| All HTML `<script src>` attributes | Point to dist/ output, not `resources/js/` |
| `nginx-security-headers.conf` (CSP) | Remove CDN allowlist entries once packages are bundled |
| `docs/` (CLAUDE.md, AI.md, PROJECT_ASSESSMENT, README) | Remove "no build step" claims |
| Agent onboarding | Adds tooling knowledge requirement for frontend work |

Estimated effort: 1–2 days of careful migration, plus ongoing CI complexity.

---

## Recommended next steps (in order)

1. **Migrate Puppeteer → Playwright** — incrementally, one script at a time, starting with `test-error-logger.js` and ending with `test-admin-e2e.js`. Adds Firefox + WebKit coverage to the existing deploy pipeline without disrupting it. Open as a new issue (see suggested title above).
2. **Import Maps for CDN dependencies** — replace hardcoded CDN URLs in import statements with a central `<script type="importmap">` block per HTML page. Reduces CSP surface and centralises version pinning. Open as a new issue if desired.
3. **Revisit build step** if: the Playwright suite is insufficient for the test needs, or TypeScript adoption on the frontend becomes a priority, or the frontend grows significantly in complexity.

---

## Cross-references

- #178 — HTML folder reorganisation (not a reason to adopt a build)
- #228 — Repo folder tidy (same)
- #158 — Caching headers (sub_filter approach is adequate; content hashing is a nice-to-have)
- #174 — Image/video optimisation pipeline (already shipped; independent of build step)
- ROADMAP §3.4 — Automated test gate (Playwright migration is the right next move for frontend)
- PROJECT_ASSESSMENT §2, §6 — frontend test coverage and agent-readiness notes
- `docs/TESTING.md` — full documentation of the current Puppeteer suite and deploy pipeline integration
