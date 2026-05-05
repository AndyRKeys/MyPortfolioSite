# Changelog

All notable changes to andykeys.me are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) — entries are grouped as `Added`, `Fixed`, `Changed`, `Removed` per release. Unreleased work on `dev` is listed at the top.

---

## [Unreleased] — on `dev`, not yet in production

### Added
- Travel post detail page (`travel-post.html`) with media gallery, Leaflet map, and lightbox (#78)
- Public `GET /api/travel/:id` route for individual travel memories (#78)
- Visit counter — tracks page visits per route, displayed in footer (#14)
- CV download button in About section (#4)
- Travel timeline view on `travel.html` (#25)
- EXIF GPS geocoding — reads GPS coords from uploaded photos and reverse-geocodes to a location name (#26)
- Multi-media support for travel posts — multiple photos/videos per memory, ordered gallery (#30)
- DB-backed rate limiting for contact form (#79)
- Database indexes on hot query columns (`post_type`, `published_at`, `post_date`, `post_type + published_at + post_date`) (#79)
- Shared backend utilities: `backend/utils/html.js` (escapeHtml), `backend/utils/slugify.js` (#79)
- Shared frontend utilities: `resources/java/utils/html.js`, `utils/date.js`, `utils/dom.js` (#79)
- Input validation middleware `backend/middleware/validate.js` (#79)
- Centralised error handler `backend/middleware/errorHandler.js` (#79)
- `stats` route `GET /api/stats` for admin page visit counts (#79)
- ES module migration for all frontend JavaScript (#79)
- Local Nginx dev template without SSL (`scripts/nginx-local.conf.template`) (#77)
- docs/AI.md — AI pair programmer instructions and workflow (#90)
- docs/STYLE_GUIDE.md — coding style and naming conventions
- docs/DATABASE.md — schema reference (this release)
- docs/SECURITY.md — auth model and threat model (this release)
- GitHub issue and PR templates (this release)
- All root-level docs consolidated under `docs/` — `AI.md`, `CHANGELOG.md`, `DATABASE.md`, `SECURITY.md`, `STYLE_GUIDE.md` moved from repo root (#130)
- `docs/DEPENDENCIES.md` added to AI onboarding prompt in README and When in Doubt list in `docs/AI.md` (#130)
- `.github/pull_request_template.md` — Smoke Test and Documentation checklist sections added (#130)

### Fixed
- Blog post 404 errors — corrected `API_BASE` in `blog-post.js` to always use `/api` (#81)
- Lightbox close/escape/arrow key handlers rewritten using native `addEventListener` (#82)
- Map rendering on travel detail page — initialise Leaflet after `post-body` is visible (#78)
- Travel card and timeline click targets now navigate to detail page instead of opening lightbox (#78)
- Duplicate `isAdminSession` function removed, extracted to shared `auth-utils.js` (#79)
- `header` CSS selector scoped to `body > header` to prevent gradient bleeding into post article headers (#91)
- `npm test` in `docs/DEPENDENCIES.md` replaced with Docker wrapper command — aligns with project-wide rule (#130)

### Changed
- Blog and travel post detail pages unified with consistent `.post-meta` date styling
- Travel post section order changed to: map → gallery → notes
- All cross-references in docs updated to new `docs/` paths (#130)

---

## v 2026-05-04 — Production baseline

> This is the state of `main` as of the initial CHANGELOG creation. Releases prior to this point are documented via git history.

### Fixed
- API_BASE set correctly for prod vs localhost environments (#69, #70)
- Nginx SSL template and deploy script reliability (#65, #67, #68)
- npm install always runs in deploy script
