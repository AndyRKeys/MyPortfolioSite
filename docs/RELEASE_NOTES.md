# Release Notes

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
