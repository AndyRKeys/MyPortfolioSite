# Release Notes

## 🔥 Hotfix 2026-05-06

**Released:** 2026-05-06
**Branch:** hotfix/duplicate-initDeploySection
**PR:** #144

### Bug Fixes
- fix(#144): remove duplicate `initDeploySection()` declaration in `admin.js` — caused a fatal `SyntaxError` in ES module strict mode, breaking every admin panel section on page load
- Root cause: bad merge conflict resolution in `release/2026-05-05-2` kept both the old and new versions of the function

### Breaking Changes / Deployment Notes
- None — frontend-only fix; no backend restart or DB changes required

---

## 2026-05-05-2

**Released:** 2026-05-05
**Branch:** release/2026-05-05-2
**PR:** #126

### Features
- feat(#129): git fetch button in deployment panel — retrieves latest commits from remote before deploying
- feat(#129): `POST /api/deploy/fetch` endpoint with SSE streaming output
- feat(#100): contact form dev stub — returns `{ success: true }` in local dev when SMTP not configured; returns 503 in production
- chore: `Seed-DevData.ps1` development database seeding script
- chore(#130): `docs/DEPENDENCIES.md` — architectural guidance for adding, updating, and removing packages
- chore(#130): `Test-Regression.ps1` — baseline regression test script extracted from per-PR test harnesses
- chore(#130): all root-level docs consolidated under `docs/`

### Bug Fixes
- fix(#123): deploy script uses `git reset --hard` instead of `git pull` to prevent local change conflicts
- fix(#94): blog and travel admin clear buttons now show confirmation prompt before resetting
- fix(#93, #95): date slicing — travel and blog edit forms now correctly populate date fields
- fix(#108): visit counters missing on admin stats panel
- fix: `$Host` reserved variable error in `prod-deploy.ps1` — renamed to `$Hostname`

### Breaking Changes / Deployment Notes
- None — `npm install` runs automatically in the deploy script if `package.json` changed

---

## 2026-05-05

**Released:** 2026-05-05
**Branch:** release/2026-05-05
**PR:** #113

### Features
- feat(#98, #117): admin deployment panel with live status, deploy history, and rollback capability
- feat(#98): `POST /api/deploy/` — SSE-streaming deploy endpoint
- feat(#98): `POST /api/deploy/rollback` — rollback to a previous commit
- feat(#98): `GET /api/deploy/status` — current HEAD vs remote comparison
- feat(#98): `GET /api/deploy/history` — deploy log and recent commits
- chore: `backend/utils/shell.js` — shared spawn utilities for streaming child processes

### Bug Fixes
- fix(#118): unhandled `spawn` error (`ENOENT`) when git not available in dev — backend no longer crashes
- fix(#118): deploy endpoints gracefully degrade when git unavailable rather than returning 500

### Breaking Changes / Deployment Notes
- None — deploy script handles `npm install` automatically

---

## 2026-05-04-2

**Released:** 2026-05-04  
**Branch:** release/2026-05-04-2  
**PR:** #114

### Features
- feat(#97): automated testing — Vitest + Supertest integration suite wired into the backend container (`npm test`)
- feat(#101): CV management — `GET /api/cv/exists`, `GET /api/cv`, `POST /api/cv`, `DELETE /api/cv`; multer PDF-only upload (5 MB cap); pdf-parse private-content scan with warnings modal in admin UI
- feat(#110): CV download button on `index.html` — hidden when no CV present, fetched via blob URL, updates reactively on `visibilitychange` without a page reload

### Bug Fixes
- fix(#93): travel edit form — `visit_date` sliced to `YYYY-MM-DD` before populating the date input
- fix(#95): blog edit form — `loadPostForEdit` converted to `async/await` so `post_date` and `body_markdown` always populate before user interaction; new post defaults date to today

### Process / Docs
- docs(AI.md): documentation hygiene rule — stale paths and added/removed files must be updated in the same commit
- docs(STYLE_GUIDE.md): section-header comment convention (`// ── Label`); stale test script paths corrected
- docs(README.md): AI onboarding prompt section added
- test(Test-PR107.ps1): idempotent CV cleanup step before empty-CV 404 assertion to prevent false failures on repeat runs

### Breaking Changes / Deployment Notes
- `pdf-parse` npm dependency added — run `npm install` inside the backend container after deploy
- CV uploads are stored at `uploads/cv.pdf` on the server — ensure the `uploads/` directory exists and is writable by the Node process

### Known Issues
- #100: contact form returns 500 in dev — SMTP credentials not configured; fails open, no data lost
- #111: CV private-content scanner does not detect phone numbers or home addresses — manual redaction required until resolved

---
