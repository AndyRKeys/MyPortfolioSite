# Image & Video Optimisation Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add background Sharp + ffmpeg processing to every new media upload, generating optimised WebP variants for images and JPEG thumbnails for video, with a 1 GB file size limit and an admin queue panel in the travel section.

**Architecture:** multer saves the raw file to `uploads/original/` immediately and enqueues a pg-boss job; a worker inside the same process dispatches to Sharp (images) or ffmpeg (video thumbnail); three new nullable DB columns (`full_url`, `thumb_url`, `media_status`) are populated on completion; the public travel page falls back to `media_url` when those columns are null so existing entries are unaffected.

**Tech stack:** Node.js/Express (ES modules), pg-boss (PostgreSQL-backed queue), sharp (image processing), ffmpeg (system package, video thumbnails), Vitest (tests), Docker Compose + Alpine Linux, Nginx.

**Spec:** `docs/superpowers/specs/2026-07-04-image-video-optimisation-design.md`

## Global Constraints

- Node 20, Alpine Linux base image (`node:20-alpine`) — all `apk` not `apt-get`
- ES modules throughout (`import`/`export`) — no `require()`
- Parameterised SQL queries only — no string concatenation
- Pino structured logging — no bare `console.log` in runtime code; use `import { logger } from '../utils/logger.js'`
- Log prefix format: `[area] message — key=value`
- New DB columns: `full_url TEXT`, `thumb_url TEXT`, `media_status TEXT` — nullable — on both `posts` and `post_media`
- Media file size limit: `1 * 1024 * 1024 * 1024` bytes (1 GB)
- Image full variant: ≤2400px longest side, WebP quality 85
- Image thumb variant: 400px wide, square crop, WebP quality 85
- Video thumb: JPEG frame extracted at 1 second via ffmpeg (`-ss 1 -vframes 1 -q:v 2`)
- Upload saves to `uploads/original/<filename>`, URL returned as `/uploads/original/<filename>`
- Worker matches DB rows by `media_url = '/uploads/original/<filename>'`
- pg-boss concurrency: 1
- pg-boss retries: 3 (default)
- All new API routes are auth-gated (`authenticate` middleware)
- `GET /api/upload/jobs` returns last 50 rows ordered by `created_at DESC`
- Polling interval in admin UI: 5 seconds
- Tests run inside Docker: `docker compose exec backend npm test`

---

## File Map

**New files:**
- `backend/db/migrations/002_media_processing_columns.sql` — ALTER TABLE for new columns
- `backend/utils/boss.js` — pg-boss singleton (init + export)
- `backend/workers/mediaProcessor.js` — job queue worker (Sharp + ffmpeg dispatch)
- `backend/tests/workers/mediaProcessor.test.js` — worker unit tests

**Modified files:**
- `backend/utils/constants.js` — MEDIA_MAX_FILE_SIZE → 1 GB; add SHARP_FULL_SIZE, SHARP_THUMB_SIZE, SHARP_QUALITY, MEDIA_JOB_NAME
- `backend/utils/paths.js` — add UPLOADS_ORIGINAL_DIR, UPLOADS_FULL_DIR, UPLOADS_THUMB_DIR, ensureUploadDirs()
- `backend/routes/upload.js` — save to original/, enqueue job, add /status /jobs /retry endpoints
- `backend/routes/travel.js` — include full_url, thumb_url, media_status in API responses
- `backend/server.js` — call ensureUploadDirs() + initBoss() + registerMediaWorker() at startup
- `backend/Dockerfile` — install ffmpeg and vips via apk; install sharp and pg-boss npm deps
- `backend/tests/routes/upload.test.js` — update size test; add tests for new endpoints
- `scripts/config/nginx-portfolio.conf.template` — client_max_body_size 1g
- `scripts/config/nginx-dev-server.conf.template` — client_max_body_size 1g
- `scripts/config/nginx-local.conf.template` — client_max_body_size 1g
- `resources/js/travel.js` — thumb_url ?? media_url for cards; full_url ?? media_url for lightbox
- `resources/js/utils/dom.js` — accept thumbUrl option in buildTimelineItem
- `resources/js/admin/travel.js` — processing queue panel with polling and retry
- `docs/DEPENDENCIES.md` — document sharp and pg-boss
- `docs/CHANGELOG.md` — unreleased entry

---

## Task 1: Infrastructure foundation

**Files:**
- Create: `backend/db/migrations/002_media_processing_columns.sql`
- Modify: `backend/utils/constants.js`
- Modify: `backend/utils/paths.js`
- Modify: `backend/Dockerfile`
- Modify: `scripts/config/nginx-portfolio.conf.template`
- Modify: `scripts/config/nginx-dev-server.conf.template`
- Modify: `scripts/config/nginx-local.conf.template`

**Interfaces:**
- Produces:
  - `MEDIA_MAX_FILE_SIZE` — `1 * 1024 * 1024 * 1024` (used in upload.js + tests)
  - `MEDIA_JOB_NAME` — `'process-media'` (used in upload.js + worker)
  - `SHARP_FULL_SIZE` — `2400` (used in worker)
  - `SHARP_THUMB_SIZE` — `400` (used in worker)
  - `SHARP_QUALITY` — `85` (used in worker)
  - `UPLOADS_ORIGINAL_DIR` — absolute path `<UPLOADS_DIR>/original` (used in upload.js)
  - `UPLOADS_FULL_DIR` — absolute path `<UPLOADS_DIR>/full` (used in worker)
  - `UPLOADS_THUMB_DIR` — absolute path `<UPLOADS_DIR>/thumb` (used in worker)
  - `ensureUploadDirs()` — creates all three subdirs; exported from paths.js (called by server.js)

- [ ] **Step 1: Add DB migration**

Create `backend/db/migrations/002_media_processing_columns.sql` with this exact content:

```sql
-- 002_media_processing_columns.sql
-- Adds full_url, thumb_url, media_status to posts and post_media
-- for the background image/video optimisation pipeline (#174).
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS full_url    TEXT,
  ADD COLUMN IF NOT EXISTS thumb_url   TEXT,
  ADD COLUMN IF NOT EXISTS media_status TEXT;

ALTER TABLE post_media
  ADD COLUMN IF NOT EXISTS full_url    TEXT,
  ADD COLUMN IF NOT EXISTS thumb_url   TEXT,
  ADD COLUMN IF NOT EXISTS media_status TEXT;
```

- [ ] **Step 2: Update constants**

In `backend/utils/constants.js`, replace the `MEDIA_MAX_FILE_SIZE` line and add new constants at the end of the `Media upload` section:

```js
// Maximum size (bytes) for generic media uploads (photos/videos).
// Raised to 1 GB to support DJI Osmo 4K footage (#174).
export const MEDIA_MAX_FILE_SIZE = 1 * 1024 * 1024 * 1024; // 1 GB

// ── Media processing (Sharp + ffmpeg) ─────────────────────────────────────────

// pg-boss job queue name for media processing jobs.
export const MEDIA_JOB_NAME   = 'process-media';

// Sharp output settings for image optimisation.
export const SHARP_FULL_SIZE  = 2400;  // max px on longest side
export const SHARP_THUMB_SIZE = 400;   // thumb width (square crop)
export const SHARP_QUALITY    = 85;    // WebP quality
```

- [ ] **Step 3: Update paths.js**

Replace the entire contents of `backend/utils/paths.js`:

```js
import path from 'path';
import fs   from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Single source of truth for the uploads directory.
// UPLOADS_DIR env var overrides the default so Docker can point to /app/uploads
// without the relative path varying depending on which route file resolves it.
export const UPLOADS_DIR          = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');
export const UPLOADS_ORIGINAL_DIR = path.join(UPLOADS_DIR, 'original');
export const UPLOADS_FULL_DIR     = path.join(UPLOADS_DIR, 'full');
export const UPLOADS_THUMB_DIR    = path.join(UPLOADS_DIR, 'thumb');

// Creates uploads subdirs if they do not exist. Called at server startup
// so the worker never encounters a missing destination directory.
export function ensureUploadDirs() {
  [UPLOADS_ORIGINAL_DIR, UPLOADS_FULL_DIR, UPLOADS_THUMB_DIR].forEach(dir => {
    fs.mkdirSync(dir, { recursive: true });
  });
}
```

- [ ] **Step 4: Update Dockerfile to install ffmpeg + vips**

In `backend/Dockerfile`, find the `RUN apk add --no-cache \` block and add `ffmpeg` and `vips` to it:

```dockerfile
RUN apk add --no-cache \
  ca-certificates \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ttf-freefont \
  libstdc++ \
  git \
  docker-cli \
  docker-compose \
  ffmpeg \
  vips
```

- [ ] **Step 5: Update all three nginx client_max_body_size values**

In `scripts/config/nginx-portfolio.conf.template`, change:
```nginx
client_max_body_size 25M;
```
to:
```nginx
client_max_body_size 1g;
```

In `scripts/config/nginx-dev-server.conf.template`, find the same line and change it to:
```nginx
client_max_body_size 1g;
```

In `scripts/config/nginx-local.conf.template`, find the same line and change it to:
```nginx
client_max_body_size 1g;
```

(Run `grep -n "client_max_body_size" scripts/config/nginx-*.conf.template` first to confirm the exact line in each file.)

- [ ] **Step 6: Write a constants smoke test**

Create `backend/tests/utils/constants.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  MEDIA_MAX_FILE_SIZE,
  MEDIA_JOB_NAME,
  SHARP_FULL_SIZE,
  SHARP_THUMB_SIZE,
  SHARP_QUALITY,
} from '../../utils/constants.js';

describe('media processing constants', () => {
  it('MEDIA_MAX_FILE_SIZE is 1 GB', () => {
    expect(MEDIA_MAX_FILE_SIZE).toBe(1 * 1024 * 1024 * 1024);
  });

  it('MEDIA_JOB_NAME is the expected string', () => {
    expect(MEDIA_JOB_NAME).toBe('process-media');
  });

  it('SHARP_FULL_SIZE is 2400', () => {
    expect(SHARP_FULL_SIZE).toBe(2400);
  });

  it('SHARP_THUMB_SIZE is 400', () => {
    expect(SHARP_THUMB_SIZE).toBe(400);
  });

  it('SHARP_QUALITY is 85', () => {
    expect(SHARP_QUALITY).toBe(85);
  });
});
```

- [ ] **Step 7: Run tests to confirm nothing broken**

```bash
docker compose exec backend npm test -- tests/utils/constants.test.js
```

Expected: 5 passing tests.

- [ ] **Step 8: Commit**

```bash
git add backend/db/migrations/002_media_processing_columns.sql \
        backend/utils/constants.js \
        backend/utils/paths.js \
        backend/Dockerfile \
        scripts/config/nginx-portfolio.conf.template \
        scripts/config/nginx-dev-server.conf.template \
        scripts/config/nginx-local.conf.template \
        backend/tests/utils/constants.test.js
git commit -m "feat(#174): infrastructure — 1 GB limit, subdirs, migration, ffmpeg"
```

---

## Task 2: pg-boss singleton + media processor worker

**Files:**
- Create: `backend/utils/boss.js`
- Create: `backend/workers/mediaProcessor.js`
- Create: `backend/tests/workers/mediaProcessor.test.js`
- Modify: `backend/server.js`

**Interfaces:**
- Consumes from Task 1: `MEDIA_JOB_NAME`, `SHARP_FULL_SIZE`, `SHARP_THUMB_SIZE`, `SHARP_QUALITY`, `UPLOADS_ORIGINAL_DIR`, `UPLOADS_FULL_DIR`, `UPLOADS_THUMB_DIR`, `ensureUploadDirs()`
- Consumes: `pool` from `../db/pool.js`, `logger` from `../utils/logger.js`
- Produces:
  - `boss` — the live pg-boss instance (singleton, exported from boss.js; used in upload.js to enqueue)
  - `initBoss()` — async, starts pg-boss; called once from server.js
  - `registerMediaWorker(boss)` — registers the `process-media` worker; called once from server.js
  - `processJob(job)` — exported for testing; `job.data = { filePath, mimeType }`

- [ ] **Step 1: Install npm dependencies**

```bash
docker compose exec backend npm install pg-boss@latest sharp@latest
```

Then rebuild the image so the deps are baked in:

```bash
docker compose build backend
```

Confirm both packages appear in `backend/package.json` dependencies.

- [ ] **Step 2: Create `backend/utils/boss.js`**

```js
import PgBoss from 'pg-boss';
import { logger } from './logger.js';

let boss = null;

export function getBoss() {
  return boss;
}

export async function initBoss() {
  boss = new PgBoss({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME     || 'portfolio_db',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD,
    // Keep pg-boss schema maintenance quiet in application logs.
    noSupervisor: false,
  });

  boss.on('error', (err) =>
    logger.error({ err: err.message }, '[boss] pg-boss error')
  );

  await boss.start();
  logger.info('[boss] pg-boss started');
  return boss;
}
```

- [ ] **Step 3: Write failing worker tests**

Create `backend/tests/workers/mediaProcessor.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../db/pool.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize:  vi.fn().mockReturnThis(),
    webp:    vi.fn().mockReturnThis(),
    toFile:  vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd, _args, cb) => cb(null, '', '')),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, mkdirSync: vi.fn() };
});

process.env.JWT_SECRET   = 'test-secret-test-secret-test-secret-32';
process.env.UPLOADS_DIR  = '/tmp/test-uploads';

// ── Import under test ────────────────────────────────────────────────────────

const { processJob } = await import('../../workers/mediaProcessor.js');
const { pool }       = await import('../../db/pool.js');
const sharp          = (await import('sharp')).default;
const { execFile }   = await import('child_process');

beforeEach(() => {
  vi.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [] });
});

// ── Image processing ─────────────────────────────────────────────────────────

describe('processJob — image', () => {
  const imageJob = {
    data: { filePath: '/tmp/test-uploads/original/test.jpg', mimeType: 'image/jpeg' },
  };

  it('calls sharp twice (full + thumb)', async () => {
    await processJob(imageJob);
    expect(sharp).toHaveBeenCalledTimes(2);
  });

  it('updates both posts and post_media with full_url, thumb_url, and ready status', async () => {
    await processJob(imageJob);
    const calls = pool.query.mock.calls;
    const updateCalls = calls.filter(c => String(c[0]).includes('full_url'));
    expect(updateCalls.length).toBe(2); // posts + post_media
    updateCalls.forEach(([_sql, params]) => {
      expect(params[0]).toMatch(/^\/uploads\/full\//);
      expect(params[1]).toMatch(/^\/uploads\/thumb\//);
      expect(params[2]).toBe('ready');
    });
  });

  it('does not call ffmpeg for images', async () => {
    await processJob(imageJob);
    expect(execFile).not.toHaveBeenCalled();
  });
});

// ── Video processing ─────────────────────────────────────────────────────────

describe('processJob — video', () => {
  const videoJob = {
    data: { filePath: '/tmp/test-uploads/original/clip.mp4', mimeType: 'video/mp4' },
  };

  it('calls ffmpeg to extract a frame', async () => {
    await processJob(videoJob);
    expect(execFile).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining(['-ss', '1', '-vframes', '1']),
      expect.any(Function),
    );
  });

  it('does not call sharp for video', async () => {
    await processJob(videoJob);
    expect(sharp).not.toHaveBeenCalled();
  });

  it('sets thumb_url but leaves full_url null in DB', async () => {
    await processJob(videoJob);
    const calls = pool.query.mock.calls;
    const updateCalls = calls.filter(c => String(c[0]).includes('thumb_url'));
    expect(updateCalls.length).toBe(2);
    updateCalls.forEach(([_sql, params]) => {
      expect(params[0]).toBeNull();                    // full_url
      expect(params[1]).toMatch(/^\/uploads\/thumb\//); // thumb_url
      expect(params[2]).toBe('ready');
    });
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe('processJob — error handling', () => {
  it('sets media_status to error when sharp throws', async () => {
    sharp.mockImplementationOnce(() => ({
      resize: vi.fn().mockReturnThis(),
      webp:   vi.fn().mockReturnThis(),
      toFile: vi.fn().mockRejectedValue(new Error('sharp failed')),
    }));

    await processJob({
      data: { filePath: '/tmp/test-uploads/original/bad.jpg', mimeType: 'image/jpeg' },
    });

    const errorCalls = pool.query.mock.calls.filter(c => String(c[0]).includes("'error'") || (c[1] && c[1].includes('error')));
    expect(errorCalls.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 4: Run tests — confirm they fail**

```bash
docker compose exec backend npm test -- tests/workers/mediaProcessor.test.js
```

Expected: all tests FAIL with "Cannot find module" or similar — the worker doesn't exist yet.

- [ ] **Step 5: Create `backend/workers/mediaProcessor.js`**

```js
import path       from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import sharp      from 'sharp';
import { pool }   from '../db/pool.js';
import { logger } from '../utils/logger.js';
import {
  UPLOADS_FULL_DIR,
  UPLOADS_THUMB_DIR,
} from '../utils/paths.js';
import {
  MEDIA_JOB_NAME,
  SHARP_FULL_SIZE,
  SHARP_THUMB_SIZE,
  SHARP_QUALITY,
} from '../utils/constants.js';

const execFileAsync = promisify(execFile);

// ── Image processing ──────────────────────────────────────────────────────────

async function processImage(filePath, basename) {
  const fullPath  = path.join(UPLOADS_FULL_DIR,  basename + '.webp');
  const thumbPath = path.join(UPLOADS_THUMB_DIR, basename + '.webp');

  await sharp(filePath)
    .resize(SHARP_FULL_SIZE, SHARP_FULL_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: SHARP_QUALITY })
    .toFile(fullPath);

  await sharp(filePath)
    .resize(SHARP_THUMB_SIZE, SHARP_THUMB_SIZE, { fit: 'cover' })
    .webp({ quality: SHARP_QUALITY })
    .toFile(thumbPath);

  return {
    fullUrl:  '/uploads/full/'  + basename + '.webp',
    thumbUrl: '/uploads/thumb/' + basename + '.webp',
  };
}

// ── Video processing ──────────────────────────────────────────────────────────

async function extractVideoThumb(filePath, basename) {
  const thumbPath = path.join(UPLOADS_THUMB_DIR, basename + '.jpg');

  await execFileAsync('ffmpeg', [
    '-i', filePath,
    '-ss', '1',
    '-vframes', '1',
    '-q:v', '2',
    thumbPath,
  ]);

  return { thumbUrl: '/uploads/thumb/' + basename + '.jpg' };
}

// ── DB update ─────────────────────────────────────────────────────────────────

async function updateMediaRows(mediaUrl, fullUrl, thumbUrl, status) {
  await pool.query(
    'UPDATE posts SET full_url = $1, thumb_url = $2, media_status = $3 WHERE media_url = $4',
    [fullUrl, thumbUrl, status, mediaUrl],
  );
  await pool.query(
    'UPDATE post_media SET full_url = $1, thumb_url = $2, media_status = $3 WHERE media_url = $4',
    [fullUrl, thumbUrl, status, mediaUrl],
  );
}

// ── Job handler (exported for testing) ───────────────────────────────────────

export async function processJob(job) {
  const { filePath, mimeType } = job.data;
  const basename  = path.basename(filePath, path.extname(filePath));
  const mediaUrl  = '/uploads/original/' + path.basename(filePath);
  const startedAt = Date.now();

  logger.info({ file: path.basename(filePath), mime: mimeType },
    '[mediaProcessor] job started');

  try {
    const isImage = mimeType.startsWith('image/');
    const { fullUrl = null, thumbUrl } = isImage
      ? await processImage(filePath, basename)
      : await extractVideoThumb(filePath, basename);

    await updateMediaRows(mediaUrl, fullUrl, thumbUrl, 'ready');

    logger.info(
      { file: path.basename(filePath), durationMs: Date.now() - startedAt },
      '[mediaProcessor] job complete',
    );
  } catch (err) {
    await updateMediaRows(mediaUrl, null, null, 'error').catch(() => {});
    logger.error(
      { file: path.basename(filePath), err: err.message },
      '[mediaProcessor] job failed',
    );
    throw err; // let pg-boss handle retries
  }
}

// ── Worker registration ───────────────────────────────────────────────────────

export async function registerMediaWorker(boss) {
  await boss.work(MEDIA_JOB_NAME, { teamSize: 1, teamConcurrency: 1 }, processJob);
  logger.info('[mediaProcessor] worker registered');
}
```

- [ ] **Step 6: Run tests — confirm they pass**

```bash
docker compose exec backend npm test -- tests/workers/mediaProcessor.test.js
```

Expected: all tests PASS.

- [ ] **Step 7: Wire pg-boss into server.js**

In `backend/server.js`, add these imports at the top (after existing imports):

```js
import { initBoss }             from './utils/boss.js';
import { registerMediaWorker }  from './workers/mediaProcessor.js';
import { ensureUploadDirs }     from './utils/paths.js';
```

After the `await runMigrations(pool)` block and before `app.listen(...)`, add:

```js
// Ensure upload subdirectories exist before the server accepts traffic.
ensureUploadDirs();

// Start pg-boss and register the media processing worker (#174).
let boss;
try {
  boss = await initBoss();
  await registerMediaWorker(boss);
} catch (err) {
  logger.fatal({ err: err.message }, '[startup] pg-boss failed to start — aborting boot');
  process.exit(1);
}
```

Also add pg-boss shutdown to the SIGTERM handler, inside `server.close(() => { ... })`:

```js
server.close(async () => {
  logger.info('[shutdown] Server closed, exiting');
  if (boss) await boss.stop().catch(() => {});
  process.exit(0);
});
```

- [ ] **Step 8: Commit**

```bash
git add backend/utils/boss.js \
        backend/workers/mediaProcessor.js \
        backend/tests/workers/mediaProcessor.test.js \
        backend/server.js \
        backend/package.json \
        backend/package-lock.json
git commit -m "feat(#174): pg-boss worker — Sharp image + ffmpeg video thumbnail"
```

---

## Task 3: Upload route refactor + new endpoints

**Files:**
- Modify: `backend/routes/upload.js`
- Modify: `backend/tests/routes/upload.test.js`

**Interfaces:**
- Consumes from Task 1: `UPLOADS_ORIGINAL_DIR`, `MEDIA_MAX_FILE_SIZE`, `MEDIA_JOB_NAME`
- Consumes from Task 2: `getBoss()` from `../utils/boss.js`
- Produces:
  - `POST /upload` — saves to `uploads/original/`, enqueues job; returns `{ url, type, status: 'pending' }`
  - `GET /upload/status?file=<filename>` — returns `{ status, full_url, thumb_url }` from `post_media`
  - `GET /upload/jobs` — returns last 50 `post_media` rows with non-null `media_status`, ordered by `created_at DESC`
  - `POST /upload/retry` — takes `{ file }`, re-enqueues job, resets `media_status = 'pending'`

- [ ] **Step 1: Write failing tests for new behaviour**

Replace `backend/tests/routes/upload.test.js` with:

```js
/**
 * Upload route tests — multer size limit, MIME filtering, auth gate,
 * status/jobs/retry endpoints. (#174)
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import jwt     from 'jsonwebtoken';
import { createApp } from '../../app.js';

vi.mock('../../db/pool.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

// Mock boss so upload.js can enqueue without a real pg-boss instance.
vi.mock('../../utils/boss.js', () => ({
  getBoss: vi.fn(() => ({
    send: vi.fn().mockResolvedValue('job-id'),
  })),
}));

// Stub multer diskStorage to avoid real file I/O in tests.
vi.mock('multer', async (importOriginal) => {
  const multer = await importOriginal();
  const original = multer.default ?? multer;
  const patched = (opts) => original({ ...opts, storage: original.memoryStorage() });
  patched.memoryStorage = original.memoryStorage;
  patched.diskStorage   = original.diskStorage;
  patched.MulterError   = original.MulterError;
  return { default: patched };
});

process.env.JWT_SECRET  = 'test-secret-test-secret-test-secret-32';
process.env.UPLOADS_DIR = '/tmp/test-uploads';

const app = createApp();

function makeToken() {
  return jwt.sign({ userId: 'test-user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

const smallJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U' +
  'HRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgN' +
  'DRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy' +
  'MjL/wAARCAABAAEDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABgUE/8QAIBAAAg' +
  'ICAgMAAAAAAAAAAAAAAQIDBAUREiFBUf/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEA' +
  'AAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwABRQAUUAf//Z',
  'base64'
);

// ── Auth gate ─────────────────────────────────────────────────────────────────

describe('POST /upload — auth gate', () => {
  it('returns 401 without a JWT', async () => {
    const res = await request(app)
      .post('/upload')
      .attach('file', smallJpeg, { filename: 'test.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(401);
  });

  it('returns 401 with an invalid JWT', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', 'Bearer bad.token')
      .attach('file', smallJpeg, { filename: 'test.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(401);
  });
});

// ── MIME filtering ────────────────────────────────────────────────────────────

describe('POST /upload — MIME filtering', () => {
  it('rejects a disallowed MIME type (text/plain)', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('file', Buffer.from('hello'), { filename: 'test.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not allowed/i);
  });

  it('accepts image/jpeg and returns status pending', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('file', smallJpeg, { filename: 'photo.jpg', contentType: 'image/jpeg' });
    // 200 or 500 (tmp dir may not exist in test env) — not 400/401
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.url).toMatch(/^\/uploads\/original\//);
      expect(res.body.status).toBe('pending');
    }
  });
});

// ── Size limit ────────────────────────────────────────────────────────────────

describe('POST /upload — size limit', () => {
  it('accepts a 20 MB file (well under the 1 GB limit)', async () => {
    // 20 MB was previously rejected; 1 GB limit means this must now succeed
    const twentyMb = Buffer.alloc(20 * 1024 * 1024);
    const res = await request(app)
      .post('/upload')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('file', twentyMb, { filename: 'large.jpg', contentType: 'image/jpeg' });
    // 200 or 500 (disk write fails in test env) — not 400
    expect(res.status).not.toBe(400);
  });
});

// ── Missing file ──────────────────────────────────────────────────────────────

describe('POST /upload — missing file', () => {
  it('returns 400 when no file field is sent', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no file/i);
  });
});

// ── Status endpoint ───────────────────────────────────────────────────────────

describe('GET /upload/status', () => {
  it('returns 401 without JWT', async () => {
    const res = await request(app).get('/upload/status?file=test.jpg');
    expect(res.status).toBe(401);
  });

  it('returns status for a known file', async () => {
    const { pool } = await import('../../db/pool.js');
    pool.query.mockResolvedValueOnce({
      rows: [{ media_status: 'ready', full_url: '/uploads/full/test.webp', thumb_url: '/uploads/thumb/test.webp' }],
    });
    const res = await request(app)
      .get('/upload/status?file=test.jpg')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.full_url).toBe('/uploads/full/test.webp');
    expect(res.body.thumb_url).toBe('/uploads/thumb/test.webp');
  });

  it('returns 404 when file not found in DB', async () => {
    const { pool } = await import('../../db/pool.js');
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get('/upload/status?file=missing.jpg')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(404);
  });
});

// ── Jobs endpoint ─────────────────────────────────────────────────────────────

describe('GET /upload/jobs', () => {
  it('returns 401 without JWT', async () => {
    const res = await request(app).get('/upload/jobs');
    expect(res.status).toBe(401);
  });

  it('returns array of jobs', async () => {
    const { pool } = await import('../../db/pool.js');
    pool.query.mockResolvedValueOnce({
      rows: [
        { media_url: '/uploads/original/a.jpg', media_type: 'image/jpeg', media_status: 'ready', full_url: '/uploads/full/a.webp', thumb_url: '/uploads/thumb/a.webp', created_at: new Date().toISOString() },
      ],
    });
    const res = await request(app)
      .get('/upload/jobs')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].media_status).toBe('ready');
  });
});

// ── Retry endpoint ────────────────────────────────────────────────────────────

describe('POST /upload/retry', () => {
  it('returns 401 without JWT', async () => {
    const res = await request(app).post('/upload/retry').send({ file: 'a.jpg' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when file param is missing', async () => {
    const res = await request(app)
      .post('/upload/retry')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('re-enqueues the job and returns ok', async () => {
    const { pool } = await import('../../db/pool.js');
    pool.query.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .post('/upload/retry')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ file: 'test.jpg', mimeType: 'image/jpeg' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
docker compose exec backend npm test -- tests/routes/upload.test.js
```

Expected: several tests fail because upload.js still saves to flat `uploads/`, still returns the old response shape, and the new endpoints don't exist.

- [ ] **Step 3: Rewrite `backend/routes/upload.js`**

```js
import { Router }   from 'express';
import multer       from 'multer';
import path         from 'path';
import { rateLimit } from 'express-rate-limit';
import { authenticate }   from '../middleware/authenticate.js';
import { PostgresStore }  from '../middleware/postgresStore.js';
import { exemptIfTrusted } from '../utils/serviceKey.js';
import { pool }           from '../db/pool.js';
import { getBoss }        from '../utils/boss.js';
import { logger }         from '../utils/logger.js';
import { UPLOADS_ORIGINAL_DIR } from '../utils/paths.js';
import { wrapMulter }           from '../utils/wrapMulter.js';
import {
  UPLOAD_RATE_WINDOW_MS, UPLOAD_RATE_LIMIT,
  MEDIA_MAX_FILE_SIZE, MEDIA_ALLOWED_MIME,
  MEDIA_JOB_NAME,
} from '../utils/constants.js';

// Per-IP backstop on media uploads. Limiter precedes authenticate so
// CodeQL's js/missing-rate-limiting detector sees it before auth.
const uploadRateLimit = rateLimit({
  windowMs:        UPLOAD_RATE_WINDOW_MS,
  limit:           UPLOAD_RATE_LIMIT,
  keyGenerator:    (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress,
  skip:            exemptIfTrusted,
  message:         { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders:   false,
  validate:        { positiveHits: false },
  store:           new PostgresStore({ windowMs: UPLOAD_RATE_WINDOW_MS, keyType: 'upload' }),
});

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_ORIGINAL_DIR),
  filename:    (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits:     { fileSize: MEDIA_MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    MEDIA_ALLOWED_MIME.has(file.mimetype)
      ? cb(null, true)
      : cb(new Error('File type not allowed'));
  },
});

const router = Router();

// ── POST / ────────────────────────────────────────────────────────────────────

router.post('/', uploadRateLimit, authenticate, wrapMulter(upload.single('file')), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });

  const url = `/uploads/original/${req.file.filename}`;

  try {
    const boss = getBoss();
    if (boss) {
      await boss.send(MEDIA_JOB_NAME, { filePath: req.file.path, mimeType: req.file.mimetype });
      logger.info({ file: req.file.filename, mime: req.file.mimetype }, '[upload] job enqueued');
    } else {
      logger.warn({ file: req.file.filename }, '[upload] boss not ready — skipping job enqueue');
    }
  } catch (err) {
    // Non-fatal: file is saved; job enqueue failure is logged but upload still succeeds.
    logger.error({ err: err.message, file: req.file.filename }, '[upload] failed to enqueue job');
  }

  res.json({ url, type: req.file.mimetype, status: 'pending' });
});

// ── GET /status ───────────────────────────────────────────────────────────────

router.get('/status', authenticate, async (req, res) => {
  const { file } = req.query;
  if (!file) return res.status(400).json({ error: 'file query param required' });

  const mediaUrl = `/uploads/original/${file}`;
  const result = await pool.query(
    'SELECT media_status, full_url, thumb_url FROM post_media WHERE media_url = $1 LIMIT 1',
    [mediaUrl],
  );

  if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
  const row = result.rows[0];
  res.json({ status: row.media_status, full_url: row.full_url, thumb_url: row.thumb_url });
});

// ── GET /jobs ─────────────────────────────────────────────────────────────────

router.get('/jobs', authenticate, async (req, res) => {
  const result = await pool.query(
    `SELECT media_url, media_type, media_status, full_url, thumb_url, created_at
     FROM post_media
     WHERE media_status IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 50`,
  );
  res.json(result.rows);
});

// ── POST /retry ───────────────────────────────────────────────────────────────

router.post('/retry', authenticate, async (req, res) => {
  const { file, mimeType } = req.body;
  if (!file) return res.status(400).json({ error: 'file is required' });

  const mediaUrl  = `/uploads/original/${file}`;
  const filePath  = path.join(UPLOADS_ORIGINAL_DIR, file);

  await pool.query(
    'UPDATE posts      SET media_status = $1 WHERE media_url = $2',
    ['pending', mediaUrl],
  );
  await pool.query(
    'UPDATE post_media SET media_status = $1 WHERE media_url = $2',
    ['pending', mediaUrl],
  );

  try {
    const boss = getBoss();
    if (boss) {
      await boss.send(MEDIA_JOB_NAME, { filePath, mimeType: mimeType || 'application/octet-stream' });
      logger.info({ file }, '[upload/retry] job re-enqueued');
    }
  } catch (err) {
    logger.error({ err: err.message, file }, '[upload/retry] failed to re-enqueue job');
  }

  res.json({ ok: true });
});

export default router;
```

**Note:** The file already imports `path` at the top (`import path from 'path';`) — `path.join()` is used directly above.

- [ ] **Step 4: Run tests — confirm they pass**

```bash
docker compose exec backend npm test -- tests/routes/upload.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/upload.js \
        backend/tests/routes/upload.test.js
git commit -m "feat(#174): upload route — original/ subdir, job enqueue, status/jobs/retry"
```

---

## Task 4: Public travel frontend + travel route query

**Files:**
- Modify: `backend/routes/travel.js`
- Modify: `resources/js/travel.js`
- Modify: `resources/js/utils/dom.js`

**Interfaces:**
- Consumes: travel API response now includes `full_url`, `thumb_url`, `media_status` on both post and post_media items
- Produces: public travel page uses `thumb_url ?? media_url` for card/timeline thumbnails; `full_url ?? media_url` for lightbox; `<video poster=thumb_url>` for video entries

- [ ] **Step 1: Set `media_status = 'pending'` on post_media INSERT in travel route**

In `backend/routes/travel.js`, find the `INSERT INTO post_media` statement (used when saving a travel post with media). Add `media_status` to the column list and `'pending'` to the values, but only when the media URL uses the new `original/` path (indicating it needs processing):

```sql
INSERT INTO post_media (post_id, media_url, media_type, order_index, media_status)
VALUES ($1, $2, $3, $4, $5)
```

Pass `url.startsWith('/uploads/original/') ? 'pending' : null` as the fifth parameter. This means existing/legacy URLs (flat `uploads/`) get `null` (no processing), while new uploads get `'pending'`.

Run `grep -n "INSERT INTO post_media" backend/routes/travel.js` to find the exact statement before editing.

- [ ] **Step 2: Update travel route query to include new columns**

In `backend/routes/travel.js`, find the `json_build_object` calls that build the `media` array from `post_media`. They currently look like:

```sql
json_build_object('id', pm.id, 'url', pm.media_url, 'type', pm.media_type)
```

Change all occurrences to include the new columns:

```sql
json_build_object('id', pm.id, 'url', pm.media_url, 'type', pm.media_type,
  'full_url', pm.full_url, 'thumb_url', pm.thumb_url, 'media_status', pm.media_status)
```

Also add `p.full_url, p.thumb_url, p.media_status` to the `SELECT` column list in both the listing and detail queries (wherever `p.media_url, p.media_type` appear, add the three new columns beside them).

Run: `grep -n "json_build_object\|p\.media_url" backend/routes/travel.js` to find all occurrences before editing.

- [ ] **Step 4: Update `buildTimelineItem` in `resources/js/utils/dom.js`**

The function currently uses `opts.mediaUrl` for the image `src`. Add support for `opts.thumbUrl` as a preferred thumbnail:

Find the block starting with:
```js
if (opts.mediaUrl && opts.mediaType && opts.mediaType.indexOf('image') === 0) {
    var mediaWrap = el('div', { className: 'media-thumb-wrap' });
    var img = el('img', { className: 'timeline-thumb', alt: '', src: opts.mediaUrl });
```

Change the `img` src to use thumbUrl when available:
```js
if (opts.mediaUrl && opts.mediaType && (opts.mediaType.indexOf('image') === 0 || opts.mediaType.indexOf('video') === 0)) {
    var mediaWrap = el('div', { className: 'media-thumb-wrap' });
    var displaySrc = opts.thumbUrl || opts.mediaUrl;
    var isVideo = opts.mediaType.indexOf('video') === 0;

    var img = el('img', { className: 'timeline-thumb', alt: '', src: displaySrc });
    img.addEventListener('error', function () { img.remove(); });
    mediaWrap.appendChild(img);
```

This shows a thumbnail for video entries (using the ffmpeg-extracted frame) in addition to the existing image support.

- [ ] **Step 5: Update `resources/js/travel.js` to use thumb/full fallbacks**

In `loadPublicTravelPosts`, where the timeline item is built (around line 144-156), the code extracts `mediaUrl` and `mediaType` from `firstMedia`. Add `thumbUrl` extraction:

```js
var allMedia  = Array.isArray(travel.media) && travel.media.length ? travel.media : null;
var firstMedia = allMedia ? allMedia[0] : null;
var mediaUrl  = (firstMedia && firstMedia.url)       || travel.media_url  || travel.mediaUrl;
var thumbUrl  = (firstMedia && firstMedia.thumb_url) || travel.thumb_url  || null;
var mediaType = (firstMedia && firstMedia.type)      || travel.media_type || travel.mediaType;
```

Then pass `thumbUrl` into `buildTimelineItem`:

```js
var item = buildTimelineItem({
    dateStr:    formatVisitDate(travel.post_date),
    title:      travel.title,
    location:   travel.location,
    notes:      travel.notes,
    mediaUrl:   mediaUrl,
    thumbUrl:   thumbUrl,    // add this line
    mediaType:  mediaType,
    mediaCount: allMedia ? allMedia.length : 0,
    linkHref:   '/travel/post/?id=' + encodeURIComponent(travel.id),
});
```

For the card grid, find `buildPublicTravelCard` calls and check if that utility also renders an image — if so, apply the same `thumb_url ?? media_url` pattern there.

- [ ] **Step 6: Run backend tests to confirm travel route still passes**

```bash
docker compose exec backend npm test -- tests/routes/travel.test.js
```

Expected: all existing tests still PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/routes/travel.js \
        resources/js/travel.js \
        resources/js/utils/dom.js
git commit -m "feat(#174): travel page — thumb_url/full_url fallbacks in cards and timeline"
```

---

## Task 5: Admin processing queue panel

**Files:**
- Modify: `resources/js/admin/travel.js`

**Interfaces:**
- Consumes: `GET /api/upload/jobs` (returns array of job rows)
- Consumes: `POST /api/upload/retry` (takes `{ file, mimeType }`)
- Consumes: `authFetch` from `./auth.js` (already imported in this file)

- [ ] **Step 1: Add the queue panel HTML builder**

In `resources/js/admin/travel.js`, add this function before `initTravel()`:

```js
// ── Processing queue panel ────────────────────────────────────────────────────

let jobPollInterval = null;

function formatDuration(createdAt) {
    const ms = Date.now() - new Date(createdAt).getTime();
    if (ms < 60000) return Math.round(ms / 1000) + 's';
    return Math.round(ms / 60000) + 'm';
}

function renderJobRow(job) {
    const filename = job.media_url ? job.media_url.split('/').pop() : '—';
    const isImage  = job.media_type && job.media_type.startsWith('image');
    const typeIcon = isImage ? '🖼' : '🎦';
    const statusClass = job.media_status === 'ready'
        ? 'queue-status-ready'
        : job.media_status === 'error'
            ? 'queue-status-error'
            : 'queue-status-pending';

    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td>${typeIcon} ${escapeHtml(filename)}</td>
        <td>${escapeHtml(job.media_type || '—')}</td>
        <td class="${escapeHtml(statusClass)}">${escapeHtml(job.media_status || '—')}</td>
        <td>${formatDuration(job.created_at)}</td>
        <td></td>
    `;

    if (job.media_status === 'error') {
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'btn-small';
        retryBtn.textContent = 'Retry';
        retryBtn.addEventListener('click', () => retryJob(filename, job.media_type));
        tr.querySelector('td:last-child').appendChild(retryBtn);
    }

    return tr;
}

async function retryJob(file, mimeType) {
    try {
        await authFetch('/api/upload/retry', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ file, mimeType }),
        });
        refreshJobQueue();
    } catch (err) {
        setMessage('Retry failed: ' + (err.message || 'unknown error'), 'error');
    }
}

async function refreshJobQueue() {
    const panel = document.getElementById('travel-queue-panel');
    if (!panel) return;

    try {
        const jobs = await authFetch('/api/upload/jobs').then(r => r.json());

        if (!jobs.length) {
            panel.classList.add('hidden');
            stopJobPolling();
            return;
        }

        panel.classList.remove('hidden');
        const tbody = panel.querySelector('tbody');
        tbody.innerHTML = '';
        jobs.forEach(job => tbody.appendChild(renderJobRow(job)));

        const hasActive = jobs.some(j => j.media_status === 'pending' || j.media_status === 'processing');
        if (!hasActive) stopJobPolling();

    } catch (_err) {
        // Non-fatal — panel just won't update
    }
}

function startJobPolling() {
    if (jobPollInterval) return;
    jobPollInterval = setInterval(refreshJobQueue, 5000);
}

function stopJobPolling() {
    if (jobPollInterval) {
        clearInterval(jobPollInterval);
        jobPollInterval = null;
    }
}
```

- [ ] **Step 2: Add queue panel HTML to the travel admin page**

In `admin/travel.html` (or wherever the travel admin form lives — check the file that contains the upload UI for the admin travel section), add the queue panel HTML below the file upload section:

```html
<!-- Processing queue panel (#174) -->
<div id="travel-queue-panel" class="hidden" style="margin-top: 1.5rem;">
    <h3 style="margin-bottom: 0.5rem;">Processing queue</h3>
    <table style="width:100%; border-collapse: collapse; font-size: 0.875rem;">
        <thead>
            <tr>
                <th style="text-align:left; padding: 0.25rem 0.5rem;">File</th>
                <th style="text-align:left; padding: 0.25rem 0.5rem;">Type</th>
                <th style="text-align:left; padding: 0.25rem 0.5rem;">Status</th>
                <th style="text-align:left; padding: 0.25rem 0.5rem;">Age</th>
                <th style="text-align:left; padding: 0.25rem 0.5rem;"></th>
            </tr>
        </thead>
        <tbody></tbody>
    </table>
</div>
```

Find the HTML file with `grep -rl "travel-media-list\|travel-upload" admin/` and add the snippet after the upload card.

- [ ] **Step 3: Wire the panel into `initTravel()`**

At the end of `initTravel()` in `resources/js/admin/travel.js`, add:

```js
// Start queue panel with initial poll; polling continues if active jobs exist.
refreshJobQueue();
startJobPolling();
```

Also, after a successful travel post save/create (where `pendingFiles` are uploaded), call `startJobPolling()` again to catch any new jobs:

Find the upload loop (where `authFetchMultipart` is called per file) and after all uploads complete, add:

```js
startJobPolling();
refreshJobQueue();
```

- [ ] **Step 4: Run full backend test suite to confirm nothing broken**

```bash
docker compose exec backend npm test
```

Expected: all existing tests PASS (queue panel is frontend-only, no backend tests needed for this task).

- [ ] **Step 5: Commit**

```bash
git add resources/js/admin/travel.js \
        admin/travel.html
git commit -m "feat(#174): admin travel — processing queue panel with polling and retry"
```

---

## Task 6: Documentation

**Files:**
- Modify: `docs/DEPENDENCIES.md`
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Update DEPENDENCIES.md**

Add entries for the two new npm packages. Find the `## Runtime Dependencies` (or equivalent) section and add:

```markdown
### sharp

- **Version:** latest stable (`^0.x.x` — check `package.json` after install)
- **Purpose:** Image resizing and WebP conversion in the media processing pipeline (#174)
- **Why chosen:** Standard Node.js image processing library; fast, well-maintained, ships pre-built Alpine binaries (no native build toolchain needed at runtime)
- **Usage:** `backend/workers/mediaProcessor.js` — processes image uploads into `full/` and `thumb/` variants

### pg-boss

- **Version:** latest stable (`^9.x.x` — check `package.json` after install)
- **Purpose:** PostgreSQL-backed job queue for background media processing (#174)
- **Why chosen:** Reuses the existing PostgreSQL DB with no new infrastructure; provides retries, concurrency control, and dead-letter queue out of the box
- **Usage:** `backend/utils/boss.js` (singleton), `backend/workers/mediaProcessor.js` (worker registration), `backend/routes/upload.js` (job enqueue)
```

- [ ] **Step 2: Update CHANGELOG.md**

Add an entry under the `## [Unreleased]` section (or prepend one if it doesn't exist):

```markdown
### Added — #174 Image & video optimisation pipeline

- New uploaded images are automatically resized (≤2400px) and converted to WebP (quality 85) with a 400px square thumbnail generated alongside
- New video uploads (MP4, WebM, QuickTime) get a JPEG thumbnail extracted from the first frame via ffmpeg
- Processing runs as a background pg-boss job — upload responses are immediate regardless of file size
- File size limit raised from 20 MB to 1 GB to support DJI Osmo 4K footage
- Three new DB columns (`full_url`, `thumb_url`, `media_status`) on `posts` and `post_media`; existing entries unaffected (columns nullable, frontend falls back to `media_url`)
- Admin travel section shows a processing queue panel with per-job status, age, and a Retry button for failed jobs
- Public travel page uses `thumb_url` for cards/timeline and `full_url` for lightbox, falling back to `media_url`
```

- [ ] **Step 3: Run full test suite one final time**

```bash
docker compose exec backend npm test
```

Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/DEPENDENCIES.md docs/CHANGELOG.md
git commit -m "docs(#174): update DEPENDENCIES.md and CHANGELOG for optimisation pipeline"
```
