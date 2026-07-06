# Image & Video Optimisation Pipeline — Design Spec

**Date:** 2026-07-04  
**Issues:** #174 (image optimisation), #369 (object storage — deferred, see note)  
**Status:** Approved, pending implementation plan

---

## Scope note

Issue #369 (migrate uploads to Cloudflare R2) is **deferred indefinitely**. Originals are backed up independently (phone), and the owner plans to self-host a private cloud (Nextcloud) longer-term — object storage will be revisited then. This spec covers #174 only: an on-disk image/video optimisation pipeline.

---

## Goals

- New uploads are automatically optimised: images resized and converted to WebP, video thumbnails extracted via ffmpeg.
- Large DJI Osmo video files (up to 1 GB) are supported without blocking the upload response.
- The admin can monitor processing state from the travel section of the admin panel.
- Existing uploads and the existing public travel page are unaffected by a graceful fallback.

---

## Architecture

Three layers:

1. **Upload** — `POST /api/upload` saves the original immediately, enqueues a pg-boss job, returns straight away.
2. **Worker** — `backend/workers/mediaProcessor.js` runs inside the existing backend process, picks up jobs, dispatches to Sharp (images) or ffmpeg (video).
3. **DB** — three new nullable columns on `posts` and `post_media` track the processed URLs and job state.

### File layout on disk

```
uploads/
  original/   ← raw upload, kept permanently, never served directly to end users
  full/       ← images only: resized ≤2400px longest side, WebP quality 85
  thumb/      ← images: 400px wide square crop, WebP
                 videos: single JPEG frame extracted at 1 second by ffmpeg
```

Nginx `location /uploads/` alias is unchanged — all three subdirs are served transparently. The only nginx change is raising `client_max_body_size` to `1g`.

---

## Database schema

Two new migration files (one for `posts`, one for `post_media`):

```sql
-- posts
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS full_url TEXT,
  ADD COLUMN IF NOT EXISTS thumb_url TEXT,
  ADD COLUMN IF NOT EXISTS media_status TEXT;

-- post_media
ALTER TABLE post_media
  ADD COLUMN IF NOT EXISTS full_url TEXT,
  ADD COLUMN IF NOT EXISTS thumb_url TEXT,
  ADD COLUMN IF NOT EXISTS media_status TEXT;
```

| Column | Type | Default | Meaning |
|--------|------|---------|---------|
| `full_url` | TEXT | NULL | Optimised full-size WebP path (images); null for video |
| `thumb_url` | TEXT | NULL | Thumbnail path (WebP for images, JPEG for video) |
| `media_status` | TEXT | NULL | `pending` → `processing` → `ready` \| `error` |

Existing rows remain untouched — null `media_status` means "legacy, no processing, use `media_url` directly."

---

## Upload flow

1. `POST /api/upload` — multer saves file to `uploads/original/<timestamp>-<random>.<ext>`
2. Route enqueues pg-boss job: `{ filePath, mimeType }`
3. Returns immediately: `{ url: '/uploads/original/<filename>', type, status: 'pending' }`
4. Admin attaches URL to the post and saves — post saves with `media_url` set, `full_url`/`thumb_url` null, `media_status = 'pending'`
5. Worker matches rows by `media_url = '/uploads/original/<filename>'` — no `postId` needed at upload time

---

## Background worker

**File:** `backend/workers/mediaProcessor.js`  
**Registration:** called from `backend/server.js` at startup, before HTTP server starts listening  
**Concurrency:** 1 (DJI 4K is CPU-heavy; no benefit parallelising on a single server)  
**Retries:** 3 attempts with exponential backoff (pg-boss default)

### Image processing (JPEG, PNG, GIF, WebP)

```
original → Sharp → full/  (≤2400px longest side, WebP quality 85)
original → Sharp → thumb/ (400px wide, square crop, WebP)
```

On completion: update `full_url`, `thumb_url`, `media_status = 'ready'` in `posts` and `post_media`.

### Video processing (MP4, WebM, QuickTime)

```
original → ffmpeg → thumb/ (JPEG frame at t=1s)
full_url stays null — video served directly from original/
```

On completion: update `thumb_url`, `media_status = 'ready'`.

### Error handling

After 3 failures: set `media_status = 'error'`, log error + filename via pino. Original file always preserved — no data loss on processing failure. Failed jobs retained in pg-boss dead-letter queue for inspection.

---

## New API endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/upload/status?file=<filename>` | Required | Returns `{ status, full_url, thumb_url }` for a single file |
| GET | `/api/upload/jobs` | Required | Returns recent media jobs for the queue panel (last 50, ordered by created_at desc) |
| POST | `/api/upload/retry` | Required | Re-enqueues a failed job by filename |

---

## Frontend changes

### Public travel page (`resources/js/travel.js`)

- Travel cards and timeline: `thumb_url ?? media_url`
- Lightbox / detail view: `full_url ?? media_url`
- Video entries: `<video src=media_url poster=thumb_url>`
- No WebP `<picture>` fallback needed — all target browsers support WebP; fallback is `media_url`

### Admin travel section (`resources/js/admin/travel.js`)

**Processing queue panel** — appears below the upload UI whenever there are pending or processing jobs. Auto-refreshes every 5 seconds. Collapses when all jobs are `ready` or `error`.

Columns: File, Type, Status, Started, Duration, Retry (error rows only).

Polling stops when no jobs are `pending` or `processing`. Retry button calls `POST /api/upload/retry`.

---

## Infrastructure changes

### Dockerfile

```dockerfile
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
```

### Nginx config templates (all three)

```nginx
client_max_body_size 1g;
```

### New npm dependencies

| Package | Purpose |
|---------|---------|
| `pg-boss` | PostgreSQL-backed job queue — reuses existing DB, no new infrastructure |
| `sharp` | Image resizing and WebP conversion |

ffmpeg is a system package (no npm dep).

### Env vars

None new — pg-boss reuses the existing database connection.

---

## Observability

- Worker logs job start/complete/error via pino: `[mediaProcessor] job started — file=..., mime=...`
- Processing duration logged on completion
- Failed rows queryable: `SELECT media_url, media_status FROM post_media WHERE media_status = 'error'`
- pg-boss dead-letter queue retains failed jobs

---

## Out of scope

- Video transcoding / compression (video stored at original quality)
- Migration of existing uploads (originals backed up on device; re-upload if needed)
- Object storage / CDN (#369 deferred)
- `<picture>` WebP/JPEG fallback (WebP supported by all target browsers)
- CV uploads (single file, low risk, stays on disk unchanged)

---

## Acceptance criteria

- [ ] New image uploads generate `full/` (WebP ≤2400px) and `thumb/` (WebP 400px square) variants
- [ ] New video uploads generate a `thumb/` JPEG frame via ffmpeg
- [ ] Upload response is immediate regardless of file size
- [ ] `media_status` progresses from `pending` → `processing` → `ready` | `error`
- [ ] Public travel page uses `thumb_url` for cards and `full_url` for lightbox, falling back to `media_url`
- [ ] Admin travel section shows processing queue panel with retry support
- [ ] 1 GB file size limit enforced at Nginx and multer
- [ ] Processing failures are logged, original file preserved
- [ ] Existing travel entries with legacy `media_url` are unaffected
- [ ] `docs/DEPENDENCIES.md` updated for `pg-boss` and `sharp`
