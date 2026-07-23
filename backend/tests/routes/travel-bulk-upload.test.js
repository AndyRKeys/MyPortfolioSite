/**
 * Tests for POST /travel/:id/photos/bulk (#511)
 * Covers auth gate, file validation (MIME, per-request cap), 404 for unknown
 * or malformed memory ids, happy path, and partial success on DB failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt      from 'jsonwebtoken';
import fs       from 'fs';
import { createApp } from '../../app.js';

// Hoist mockClient so it is available inside the vi.mock factory below.
const { mockClient } = vi.hoisted(() => {
  const mockClient = {
    query:   vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
  return { mockClient };
});

vi.mock('../../db/pool.js', () => ({
  pool: {
    query:   vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn().mockResolvedValue(mockClient),
  },
}));

// Mock boss so the route can enqueue jobs without a real pg-boss instance.
vi.mock('../../utils/boss.js', () => ({
  getBoss: vi.fn(() => ({
    send: vi.fn().mockResolvedValue('job-id'),
  })),
}));

// The multer stub below always uses memoryStorage, so uploaded files never
// get a real `.path`/`.filename` — only `.buffer`. POST /travel/import reads
// the CSV via fs.readFileSync(csvFile.path) since it now uses disk storage
// in production. Track buffer-by-fake-path here so fs.readFileSync/fs.unlink
// can be patched to work against the in-memory buffer during tests, without
// touching the production code path (which does write real files via
// diskStorage outside tests).
const bufferByFakePath = new Map();
let fakePathCounter = 0;

// Stub multer diskStorage so tests don't write real files. Also backfills
// `.path`/`.filename` (memoryStorage leaves both undefined) so route code
// that reads via fs.readFileSync(file.path) has something to read.
vi.mock('multer', async (importOriginal) => {
  const multer = await importOriginal();
  const original = multer.default ?? multer;
  const patched = (opts) => {
    const instance = original({ ...opts, storage: original.memoryStorage() });
    const wrapHandler = (fn) => (req, res, cb) => fn(req, res, (err) => {
      const assign = (file) => {
        if (file && !file.path) {
          const fakePath = `/tmp/test-fake-${fakePathCounter++}`;
          file.path = fakePath;
          file.filename = file.filename || `test-${fakePathCounter}-${file.originalname}`;
          bufferByFakePath.set(fakePath, file.buffer);
        }
      };
      if (req.file) assign(req.file);
      if (Array.isArray(req.files)) req.files.forEach(assign);
      if (req.files && !Array.isArray(req.files)) {
        Object.values(req.files).forEach(arr => arr.forEach(assign));
      }
      cb(err);
    });
    return {
      single: (...args) => wrapHandler(instance.single(...args)),
      array: (...args) => wrapHandler(instance.array(...args)),
      fields: (...args) => wrapHandler(instance.fields(...args)),
    };
  };
  patched.memoryStorage = original.memoryStorage;
  patched.diskStorage   = original.diskStorage;
  patched.MulterError   = original.MulterError;
  return { default: patched };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  const readFileSync = (p, enc) => {
    if (bufferByFakePath.has(p)) {
      const buf = bufferByFakePath.get(p);
      return enc ? buf.toString(enc) : buf;
    }
    return actual.readFileSync(p, enc);
  };
  const unlink = (p, cb) => {
    if (bufferByFakePath.has(p)) return cb(null);
    return actual.unlink(p, cb);
  };
  return {
    ...actual,
    readFileSync,
    unlink,
    default: { ...actual.default, readFileSync, unlink },
  };
});

process.env.JWT_SECRET  = 'test-secret-test-secret-test-secret-32';
process.env.UPLOADS_DIR = '/tmp/test-uploads';

const app = createApp();

function makeToken() {
  return jwt.sign({ userId: 'test-user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

// Minimal valid JPEG buffer (same fixture as upload.test.js)
const smallJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U' +
  'HRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgN' +
  'DRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy' +
  'MjL/wAARCAABAAEDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABgUE/8QAIBAAAg' +
  'ICAgMAAAAAAAAAAAAAAQIDBAUREiFBUf/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEA' +
  'AAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwABRQAUUAf//Z',
  'base64',
);

// Valid UUIDs — the route rejects malformed ids before any DB query
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

beforeEach(async () => {
  const { pool } = await import('../../db/pool.js');
  pool.query.mockReset().mockResolvedValue({ rows: [] });
  mockClient.query.mockReset().mockResolvedValue({ rows: [] });
  mockClient.release.mockReset();
});

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('POST /travel/:id/photos/bulk — auth', () => {
  it('returns 401 without JWT', async () => {
    const res = await request(app)
      .post('/travel/123/photos/bulk')
      .attach('photos', smallJpeg, { filename: 'photo.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(401);
  });

  it('returns 401 with an invalid JWT', async () => {
    const res = await request(app)
      .post('/travel/123/photos/bulk')
      .set('Authorization', 'Bearer bad.token')
      .attach('photos', smallJpeg, { filename: 'photo.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(401);
  });
});

// ── File validation ───────────────────────────────────────────────────────────

describe('POST /travel/:id/photos/bulk — file validation', () => {
  it('returns 400 when no files are sent', async () => {
    const { pool } = await import('../../db/pool.js');
    pool.query.mockResolvedValueOnce({ rows: [{ id: '1' }] }); // memory exists check (won't be reached)

    const res = await request(app)
      .post('/travel/123/photos/bulk')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no files/i);
  });

  it('returns 400 when a file has a disallowed MIME type', async () => {
    const res = await request(app)
      .post('/travel/123/photos/bulk')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('photos', Buffer.from('hello'), { filename: 'doc.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not allowed/i);
  });

  it('returns 400 when more than the per-request file cap is sent', async () => {
    let req = request(app)
      .post(`/travel/${UUID_A}/photos/bulk`)
      .set('Authorization', `Bearer ${makeToken()}`);
    for (let i = 0; i < 21; i++) {
      req = req.attach('photos', smallJpeg, { filename: `photo${i}.jpg`, contentType: 'image/jpeg' });
    }
    const res = await req;
    expect(res.status).toBe(400); // multer LIMIT_UNEXPECTED_FILE via wrapMulter
  });
});

// ── 404 for unknown memory ────────────────────────────────────────────────────

describe('POST /travel/:id/photos/bulk — memory not found', () => {
  it('returns 404 when the travel memory does not exist', async () => {
    const { pool } = await import('../../db/pool.js');
    pool.query.mockResolvedValueOnce({ rows: [] }); // memory check returns nothing

    const res = await request(app)
      .post(`/travel/${UUID_A}/photos/bulk`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('photos', smallJpeg, { filename: 'photo.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/memory not found/i);
  });

  it('returns 404 for a malformed (non-UUID) id without querying the DB', async () => {
    const { pool } = await import('../../db/pool.js');

    const res = await request(app)
      .post('/travel/nonexistent-id-99999/photos/bulk')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('photos', smallJpeg, { filename: 'photo.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/memory not found/i);
    // Guard runs before any posts lookup — a raw non-UUID reaching Postgres
    // would raise 22P02 and surface as a 500. (pool.query is still used by
    // the rate-limit store, so filter for the posts query specifically.)
    const postsQueries = pool.query.mock.calls.filter(([sql]) => /FROM posts/i.test(sql));
    expect(postsQueries).toHaveLength(0);
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe('POST /travel/:id/photos/bulk — happy path', () => {
  it('returns uploaded array with one entry for a single valid file', async () => {
    const { pool } = await import('../../db/pool.js');

    // Call sequence: memory check → order_index query → INSERT post_media → UPDATE posts primary media → logAudit pool.query
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: UUID_A }] })      // memory exists
      .mockResolvedValueOnce({ rows: [{ max_idx: -1 }] })        // order_index
      .mockResolvedValueOnce({ rows: [] })                        // INSERT post_media
      .mockResolvedValueOnce({ rows: [] })                        // UPDATE posts primary media
      .mockResolvedValueOnce({ rows: [] });                       // logAudit INSERT

    const res = await request(app)
      .post(`/travel/${UUID_A}/photos/bulk`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('photos', smallJpeg, { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.uploaded)).toBe(true);
    expect(res.body.uploaded).toHaveLength(1);
    expect(res.body.uploaded[0].url).toMatch(/^\/uploads\/original\//);
    expect(res.body.uploaded[0].type).toBe('image/jpeg');
    expect(res.body.uploaded[0].status).toBe('pending');
    expect(res.body.errors).toHaveLength(0);
  });

  it('returns multiple uploaded entries for multiple valid files', async () => {
    const { pool } = await import('../../db/pool.js');

    // Two files: memory check, order_index, two INSERTs, UPDATE posts, logAudit
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: UUID_B }] })  // memory exists
      .mockResolvedValueOnce({ rows: [{ max_idx: 0 }] })     // order_index
      .mockResolvedValueOnce({ rows: [] })                    // INSERT #1
      .mockResolvedValueOnce({ rows: [] })                    // INSERT #2
      .mockResolvedValueOnce({ rows: [] })                    // UPDATE posts
      .mockResolvedValueOnce({ rows: [] });                   // logAudit

    const res = await request(app)
      .post(`/travel/${UUID_B}/photos/bulk`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('photos', smallJpeg, { filename: 'photo1.jpg', contentType: 'image/jpeg' })
      .attach('photos', smallJpeg, { filename: 'photo2.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.uploaded).toHaveLength(2);
    expect(res.body.errors).toHaveLength(0);
  });
});

// ── Partial success (DB-layer failure) ───────────────────────────────────────

describe("POST /travel/:id/photos/bulk — partial success", () => {
  it("returns partial success when one file inserts and one fails at the DB layer", async () => {
    const { pool } = await import('../../db/pool.js');

    // Call sequence: memory check → order_index → INSERT #1 (ok) → INSERT #2 (fail) → UPDATE posts primary media → logAudit
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: UUID_C }] })  // memory exists
      .mockResolvedValueOnce({ rows: [{ max_idx: 0 }] })     // order_index
      .mockResolvedValueOnce({ rows: [] })                    // INSERT #1 succeeds
      .mockRejectedValueOnce(new Error('DB error'))           // INSERT #2 fails
      .mockResolvedValueOnce({ rows: [] })                    // UPDATE posts primary media
      .mockResolvedValueOnce({ rows: [] });                   // logAudit

    const res = await request(app)
      .post(`/travel/${UUID_C}/photos/bulk`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('photos', smallJpeg, { filename: 'photo1.jpg', contentType: 'image/jpeg' })
      .attach('photos', smallJpeg, { filename: 'photo2.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.uploaded).toHaveLength(1);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].error).toMatch(/failed to save/i); // generic message — raw DB error stays in logs
  });
});

// ── CSV import with photos (#511) ────────────────────────────────────────────

const VALID_CSV_WITH_PHOTOS = 'title,location,notes,post_date,lat,lng,publish,photos\n' +
  '"Japan trip","Tokyo, Japan","Great city",2024-06-15,35.6762,139.6503,false,"Japan/IMG_0001.jpg"\n';

const UNMATCHED_CSV = 'title,location,notes,post_date,lat,lng,publish,photos\n' +
  '"Japan trip","Tokyo, Japan","Great city",2024-06-15,35.6762,139.6503,false,"Japan/IMG_9999.jpg"\n';

describe('POST /travel/import — with photos', () => {
  it('attaches matched photos to the newly-created memory', async () => {
    const { pool } = await import('../../db/pool.js');

    // Call sequence inside the row loop (client via pool.connect === mockClient):
    //   BEGIN -> findUniqueSlug SELECT -> INSERT posts -> COMMIT
    // then back on the outer pool: SELECT id FROM posts (slug lookup) for
    // attachMediaFiles, then attachMediaFiles' own INSERT post_media, then
    // logAudit's INSERT.
    mockClient.query
      .mockResolvedValueOnce({ rows: [] })   // BEGIN
      .mockResolvedValueOnce({ rows: [] })   // findUniqueSlug SELECT — slug free
      .mockResolvedValueOnce({ rows: [] })   // INSERT posts
      .mockResolvedValueOnce({ rows: [] });  // COMMIT

    pool.query
      .mockResolvedValueOnce({ rows: [{ id: UUID_A }] }) // SELECT id FROM posts WHERE slug
      .mockResolvedValueOnce({ rows: [] })                // attachMediaFiles INSERT post_media
      .mockResolvedValueOnce({ rows: [] });               // logAudit INSERT

    const res = await request(app)
      .post('/travel/import')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('file', Buffer.from(VALID_CSV_WITH_PHOTOS), { filename: 'travel.csv', contentType: 'text/csv' })
      .attach('photos', smallJpeg, { filename: 'IMG_0001.jpg', contentType: 'image/jpeg' })
      .field('photoManifest', JSON.stringify(['Japan/IMG_0001.jpg']));

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.errors).toHaveLength(0);

    const mediaInsertCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO post_media'),
    );
    expect(mediaInsertCall).toBeDefined();
    expect(mediaInsertCall[1]).toContain(UUID_A);
  });

  it('creates the memory but reports an error for an unmatched filename', async () => {
    const { pool } = await import('../../db/pool.js');

    mockClient.query
      .mockResolvedValueOnce({ rows: [] })   // BEGIN
      .mockResolvedValueOnce({ rows: [] })   // findUniqueSlug SELECT
      .mockResolvedValueOnce({ rows: [] })   // INSERT posts
      .mockResolvedValueOnce({ rows: [] });  // COMMIT

    pool.query.mockResolvedValueOnce({ rows: [] }); // logAudit INSERT

    const res = await request(app)
      .post('/travel/import')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('file', Buffer.from(UNMATCHED_CSV), { filename: 'travel.csv', contentType: 'text/csv' })
      .attach('photos', smallJpeg, { filename: 'IMG_0001.jpg', contentType: 'image/jpeg' })
      .field('photoManifest', JSON.stringify(['Japan/IMG_0001.jpg']));

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1); // memory still created
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].reason).toMatch(/not found among the uploaded files/i);
  });

  it('rejects the request with 400 if photoManifest length does not match uploaded file count', async () => {
    const { pool } = await import('../../db/pool.js');
    pool.query.mockClear();
    mockClient.query.mockClear();

    const res = await request(app)
      .post('/travel/import')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('file', Buffer.from(VALID_CSV_WITH_PHOTOS), { filename: 'travel.csv', contentType: 'text/csv' })
      .attach('photos', smallJpeg, { filename: 'photo1.jpg', contentType: 'image/jpeg' })
      .attach('photos', smallJpeg, { filename: 'photo2.jpg', contentType: 'image/jpeg' })
      .field('photoManifest', JSON.stringify(['Japan/IMG_0001.jpg']));

    expect(res.status).toBe(400);
    const insertCalls = mockClient.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO posts'),
    );
    expect(insertCalls).toHaveLength(0);
  });

  it('cleans up an uploaded photo file that no CSV row references', async () => {
    const { pool } = await import('../../db/pool.js');

    mockClient.query
      .mockResolvedValueOnce({ rows: [] })   // BEGIN
      .mockResolvedValueOnce({ rows: [] })   // findUniqueSlug SELECT
      .mockResolvedValueOnce({ rows: [] })   // INSERT posts
      .mockResolvedValueOnce({ rows: [] });  // COMMIT

    pool.query
      .mockResolvedValueOnce({ rows: [{ id: UUID_B }] }) // SELECT id FROM posts WHERE slug
      .mockResolvedValueOnce({ rows: [] })                // attachMediaFiles INSERT post_media
      .mockResolvedValueOnce({ rows: [] });               // logAudit INSERT

    const unlinkSpy = vi.spyOn(fs, 'unlink');

    const res = await request(app)
      .post('/travel/import')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('file', Buffer.from(VALID_CSV_WITH_PHOTOS), { filename: 'travel.csv', contentType: 'text/csv' })
      .attach('photos', smallJpeg, { filename: 'IMG_0001.jpg', contentType: 'image/jpeg' })
      .attach('photos', smallJpeg, { filename: 'IMG_0002.jpg', contentType: 'image/jpeg' })
      .field('photoManifest', JSON.stringify(['Japan/IMG_0001.jpg', 'Japan/IMG_0002.jpg']));

    expect(res.status).toBe(200);

    // The second uploaded file (IMG_0002.jpg) is never referenced by any CSV
    // row's photos column, so it should be cleaned up via fs.unlink.
    const unlinkedFilenamesArgs = unlinkSpy.mock.calls.map(([filePath]) => filePath);
    expect(unlinkedFilenamesArgs.some(p => typeof p === 'string')).toBe(true);
    expect(unlinkSpy).toHaveBeenCalled();

    unlinkSpy.mockRestore();
  });
});
