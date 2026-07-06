# Build Step Decision: Keep No-Build vs Introduce Vite

_Written: 2026-07-06. Resolves issue #257._

---

## Recommendation: Keep no-build. Add Playwright E2E for frontend testing.

The case for a bundler rests almost entirely on unblocking frontend testing. That gap is better closed with Playwright E2E (which needs no build step) than with Vitest+jsdom (which does). The remaining arguments for a build — CDN imports, cache-busting — are either manageable or addressable without a bundler.

Revisit this decision if: (a) Playwright proves insufficient and module-level unit tests become clearly needed, or (b) TypeScript adoption on the frontend becomes a priority.

---

## Current state

- ~50 JS files, ~4,700 lines, all vanilla ES modules served directly by Nginx
- Nginx roots the repo (`${REPO_DIR}`) and serves `resources/js/` as-is
- Cache-busting: Nginx `sub_filter` appends `?v=${DEPLOY_VERSION}` to `.js` references in HTML at deploy time
- **4 CDN imports** loaded at runtime:
  - `DOMPurify` from `cdn.jsdelivr.net` (blog-post.js, ai-blog-post.js)
  - `exifr` from `esm.sh` (admin/travel.js, admin/travel/exif.js)
  - `@simplewebauthn/browser` from `esm.sh` (login.js, admin/passkeys.js)
- Zero frontend unit or integration tests; regressions caught by manual smoke test scripts (`Test-PRN.ps1`)

---

## Why each argument lands where it does

### Argument 1: Frontend testing (strongest case for a build)

The PROJECT_ASSESSMENT notes "zero frontend unit or integration tests" and flags this as the primary gap. The issue itself says to evaluate the decision primarily against the test gap.

**Vitest + jsdom/browser (needs bundler):** Would unlock module-level unit tests and component testing. Requires a build step for module resolution. High migration cost for uncertain incremental value over Playwright.

**Playwright E2E (no build step needed):** Tests the real app in a real browser. Covers the highest-value regression surface — login, blog list, travel map, admin CRUD flows — without any bundler. Can run against the existing dev server (`https://dev.andykeys.me:3001`). This is the right first frontend test layer for a site of this complexity and traffic level.

**Verdict:** The frontend test gap is best closed with Playwright first. If Playwright is in place and module-level unit tests of complex frontend logic become clearly needed, revisit the build step then.

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

1. **Add Playwright E2E** — close the frontend test gap without any architectural change. Start with core public flows: homepage, blog list, travel list, login. This is the highest-value near-term action regardless of the build decision. Open as a new issue.
2. **Import Maps for CDN dependencies** — replace hardcoded CDN URLs in import statements with a central `<script type="importmap">` block per HTML page. Reduces CSP surface and centralises version pinning. Open as a new issue if desired.
3. **Revisit build step** if: Playwright is insufficient for the test needs, or TypeScript adoption on the frontend becomes a priority, or the frontend grows significantly in complexity.

---

## Cross-references

- #178 — HTML folder reorganisation (not a reason to adopt a build)
- #228 — Repo folder tidy (same)
- #158 — Caching headers (sub_filter approach is adequate; content hashing is a nice-to-have)
- #174 — Image/video optimisation pipeline (already shipped; independent of build step)
- ROADMAP §3.4 — Automated test gate (Playwright E2E is the right next move for frontend)
- PROJECT_ASSESSMENT §2, §6 — "zero frontend unit tests" gap and agent-readiness notes
