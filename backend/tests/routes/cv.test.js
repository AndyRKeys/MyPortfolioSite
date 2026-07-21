/**
 * CV route tests (#109) — auth gate, MIME filtering, size limit, private-info scan.
 * Routes now use DB for version history; pool.query is mocked throughout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import { createApp } from '../../app.js';

// Mock DB pool — cv.js now queries `cvs` table
vi.mock('../../db/pool.js', () => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}));

import { pool } from '../../db/pool.js';

process.env.JWT_SECRET   = 'test-secret-test-secret-test-secret-32';
process.env.UPLOADS_DIR  = '/tmp/test-uploads';

const app = createApp();

function makeToken() {
  return jwt.sign({ userId: 'test-user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

// Minimal valid-looking PDF header
const minPdf = Buffer.from('%PDF-1.4 fake pdf content');

let spyExistsSync;
let spyMkdirSync;
let spyWriteFileSync;
let spyUnlinkSync;

// Fake DB client for pool.connect()
function makeFakeClient(queryFn) {
  return {
    query: queryFn || vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
}

beforeEach(() => {
  spyExistsSync    = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
  spyMkdirSync     = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
  spyWriteFileSync = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  spyUnlinkSync    = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

  // Default: no current CV in DB
  pool.query.mockResolvedValue({ rows: [] });
  pool.connect.mockResolvedValue(makeFakeClient());
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── GET /cv/exists ────────────────────────────────────────────────────────────

describe('GET /cv/exists', () => {
  it('returns { exists: false } when no current CV row in DB', async () => {
    pool.query.mockResolvedValue({ rows: [] }); // no current row
    const res = await request(app).get('/cv/exists');
    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(false);
  });

  it('returns { exists: true } when current CV row found and file on disk', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 'abc', filename: 'cv-test.pdf' }] });
    spyExistsSync.mockReturnValue(true);
    const res = await request(app).get('/cv/exists');
    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(true);
  });
});

// ── GET /cv ───────────────────────────────────────────────────────────────────

describe('GET /cv', () => {
  it('returns 404 when no current CV in DB', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const res = await request(app).get('/cv');
    expect(res.status).toBe(404);
  });
});

// ── POST /cv — auth gate ──────────────────────────────────────────────────────

describe('POST /cv — auth gate', () => {
  it('returns 401 without a JWT', async () => {
    const res = await request(app)
      .post('/cv')
      .attach('cv', minPdf, { filename: 'cv.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(401);
  });

  it('returns 401 with an invalid JWT', async () => {
    const res = await request(app)
      .post('/cv')
      .set('Authorization', 'Bearer bad.token')
      .attach('cv', minPdf, { filename: 'cv.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(401);
  });
});

// ── POST /cv — MIME filtering ─────────────────────────────────────────────────

describe('POST /cv — MIME filtering', () => {
  it('rejects a non-PDF file', async () => {
    const res = await request(app)
      .post('/cv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('cv', Buffer.from('hello'), { filename: 'cv.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
  });

  it('accepts application/pdf and writes the file', async () => {
    spyExistsSync.mockReturnValue(false);

    // Mock pool.connect() to return a client that handles the transaction steps
    let queryCount = 0;
    const fakeClient = makeFakeClient(async (sql) => {
      queryCount++;
      // INSERT INTO cvs returns new ID
      if (sql && typeof sql === 'string' && sql.includes('INSERT INTO cvs')) {
        return { rows: [{ id: 'new-cv-id' }] };
      }
      // SELECT offset for prune — no rows to prune
      return { rows: [] };
    });
    pool.connect.mockResolvedValue(fakeClient);

    const res = await request(app)
      .post('/cv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('cv', minPdf, { filename: 'cv.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(200);
    expect(res.body.uploaded).toBe(true);
    expect(spyWriteFileSync).toHaveBeenCalledOnce();
  });
});

// ── POST /cv — size limit ─────────────────────────────────────────────────────

describe('POST /cv — size limit', () => {
  it('rejects a file over 5 MB', async () => {
    const oversized = Buffer.alloc(6 * 1024 * 1024);
    const res = await request(app)
      .post('/cv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('cv', oversized, { filename: 'big.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too large|limit/i);
  });
});

// ── POST /cv — private info scan ──────────────────────────────────────────────

describe('POST /cv — private info scan', () => {
  it('returns warnings array and pending:true when private info detected', async () => {
    const cardPdf = Buffer.from('%PDF-1.4 card: 1234 5678 9012 3456 end');
    spyExistsSync.mockReturnValue(false);
    const fakeClient = makeFakeClient(async (sql) => {
      if (sql && typeof sql === 'string' && sql.includes('INSERT INTO cvs')) {
        return { rows: [{ id: 'new-cv-id' }] };
      }
      return { rows: [] };
    });
    pool.connect.mockResolvedValue(fakeClient);

    const res = await request(app)
      .post('/cv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('cv', cardPdf, { filename: 'cv.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/card/i)]));
    expect(res.body.pending).toBe(true);
    expect(res.body.uploaded).toBeUndefined();
  });

  it('returns no warnings for a clean PDF', async () => {
    spyExistsSync.mockReturnValue(false);
    const fakeClient = makeFakeClient(async (sql) => {
      if (sql && typeof sql === 'string' && sql.includes('INSERT INTO cvs')) {
        return { rows: [{ id: 'new-cv-id' }] };
      }
      return { rows: [] };
    });
    pool.connect.mockResolvedValue(fakeClient);

    const res = await request(app)
      .post('/cv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('cv', minPdf, { filename: 'cv.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(200);
    expect(res.body.warnings).toHaveLength(0);
  });
});

// ── GET /cv/history — auth gate ───────────────────────────────────────────────

describe('GET /cv/history — auth gate', () => {
  it('returns 401 without a JWT', async () => {
    const res = await request(app).get('/cv/history');
    expect(res.status).toBe(401);
  });

  it('returns version list when authenticated', async () => {
    pool.query.mockResolvedValue({
      rows: [
        { id: 'abc', filename: 'cv-20260101.pdf', uploaded_at: new Date().toISOString(), is_current: true },
      ],
    });
    const res = await request(app)
      .get('/cv/history')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].is_current).toBe(true);
  });
});

// ── DELETE /cv/:id — auth gate ────────────────────────────────────────────────

describe('DELETE /cv/:id — auth gate', () => {
  it('returns 401 without a JWT', async () => {
    const res = await request(app).delete('/cv/some-id');
    expect(res.status).toBe(401);
  });
});

describe('DELETE /cv/:id', () => {
  it('returns 404 when version not found', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .delete('/cv/nonexistent-id')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(404);
  });

  it('returns 400 when trying to delete the current version', async () => {
    const cvId = '00000000-0000-0000-0000-000000000001';
    pool.query.mockResolvedValue({ rows: [{ id: cvId, filename: 'cv.pdf', is_current: true }] });
    const res = await request(app)
      .delete(`/cv/${cvId}`)
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/current/i);
  });

  it('deletes a non-current version and returns { deleted: true }', async () => {
    const cvId = '00000000-0000-0000-0000-000000000002';
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: cvId, filename: 'cv-old.pdf', is_current: false }] })
      .mockResolvedValueOnce({ rows: [] }); // DELETE
    spyExistsSync.mockReturnValue(false);

    const res = await request(app)
      .delete(`/cv/${cvId}`)
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
});

// ── POST /cv — clean upload auto-publishes ────────────────────────────────────

describe('POST /cv — clean upload', () => {
  it('sets is_current=TRUE immediately when no warnings', async () => {
    spyExistsSync.mockReturnValue(false);
    let insertParams = null;
    const fakeClient = makeFakeClient(async (sql, params) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO cvs')) {
        insertParams = params;
        return { rows: [{ id: 'new-cv-id' }] };
      }
      return { rows: [] };
    });
    pool.connect.mockResolvedValue(fakeClient);

    const res = await request(app)
      .post('/cv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('cv', minPdf, { filename: 'cv.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(200);
    expect(res.body.uploaded).toBe(true);
    expect(res.body.pending).toBeUndefined();
    expect(insertParams[1]).toBe(true); // is_current param is boolean true, not literal 'TRUE'
  });
});

// ── POST /cv/:id/confirm ──────────────────────────────────────────────────────

describe('POST /cv/:id/confirm', () => {
  it('returns 401 without a JWT', async () => {
    const res = await request(app).post('/cv/00000000-0000-0000-0000-000000000001/confirm');
    expect(res.status).toBe(401);
  });

  it('returns 404 when the CV version does not exist', async () => {
    const fakeClient = makeFakeClient(async () => ({ rows: [] }));
    pool.connect.mockResolvedValue(fakeClient);
    const res = await request(app)
      .post('/cv/00000000-0000-0000-0000-000000000001/confirm')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(404);
  });

  it('promotes a staged CV to current and returns confirmed:true', async () => {
    const cvId = '00000000-0000-0000-0000-000000000003';
    const fakeClient = makeFakeClient(async (sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT id, filename FROM cvs WHERE id')) {
        return { rows: [{ id: cvId, filename: 'cv-20260614120000-abc123.pdf' }] };
      }
      return { rows: [] };
    });
    pool.connect.mockResolvedValue(fakeClient);
    spyExistsSync.mockReturnValue(true);

    const res = await request(app)
      .post(`/cv/${cvId}/confirm`)
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.confirmed).toBe(true);
  });

  // #522 M10 — pruning by uploaded_at alone could delete the version just
  // made current (if it's an old upload). The prune query must exclude the
  // current version so confirming an old CV never deletes it.
  it('excludes the current version from pruning when confirming an old CV', async () => {
    const cvId = '00000000-0000-0000-0000-000000000004';
    let pruneSql = null;
    const deletedIds = [];
    const fakeClient = makeFakeClient(async (sql, params) => {
      if (typeof sql === 'string' && sql.includes('SELECT id, filename FROM cvs WHERE id')) {
        return { rows: [{ id: cvId, filename: 'cv-old-but-confirmed.pdf' }] };
      }
      if (typeof sql === 'string' && sql.includes('OFFSET')) {
        pruneSql = sql;
        // DB-side filter excludes the current row; return only an old non-current row
        return { rows: [{ id: 'ancient-id', filename: 'cv-ancient.pdf' }] };
      }
      if (typeof sql === 'string' && sql.startsWith('DELETE FROM cvs')) {
        deletedIds.push(params[0]);
      }
      return { rows: [] };
    });
    pool.connect.mockResolvedValue(fakeClient);

    const res = await request(app)
      .post(`/cv/${cvId}/confirm`)
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(pruneSql).toMatch(/is_current = FALSE/);
    expect(deletedIds).toContain('ancient-id');
    expect(deletedIds).not.toContain(cvId);
  });
});

// ── POST /cv — prune excludes current version (#522 M10) ─────────────────────

describe('POST /cv — prune on upload', () => {
  it('prune query excludes the current version', async () => {
    spyExistsSync.mockReturnValue(false);
    let pruneSql = null;
    const fakeClient = makeFakeClient(async (sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO cvs')) {
        return { rows: [{ id: 'new-cv-id' }] };
      }
      if (typeof sql === 'string' && sql.includes('OFFSET')) {
        pruneSql = sql;
      }
      return { rows: [] };
    });
    pool.connect.mockResolvedValue(fakeClient);

    const res = await request(app)
      .post('/cv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('cv', minPdf, { filename: 'cv.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);
    expect(pruneSql).toMatch(/is_current = FALSE/);
  });
});
