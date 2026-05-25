/**
 * CV route tests — auth gate, MIME filtering, size limit, private-info scan.
 * Uses vi.spyOn on fs to avoid real disk I/O.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import { createApp } from '../../app.js';

vi.mock('../../db/pool.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

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

beforeEach(() => {
  spyExistsSync    = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
  spyMkdirSync     = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
  spyWriteFileSync = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  spyUnlinkSync    = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /cv/exists', () => {
  it('returns { exists: false } when no CV is present', async () => {
    spyExistsSync.mockReturnValue(false);
    const res = await request(app).get('/cv/exists');
    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(false);
  });

  it('returns { exists: true } when CV is on disk', async () => {
    spyExistsSync.mockReturnValue(true);
    const res = await request(app).get('/cv/exists');
    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(true);
  });
});

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

describe('POST /cv — MIME filtering', () => {
  it('rejects a non-PDF file', async () => {
    const res = await request(app)
      .post('/cv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('cv', Buffer.from('hello'), { filename: 'cv.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
  });

  it('accepts application/pdf and writes the file', async () => {
    // UPLOADS_DIR does not exist → mkdirSync + writeFileSync should be called
    spyExistsSync.mockReturnValue(false);
    const res = await request(app)
      .post('/cv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('cv', minPdf, { filename: 'cv.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(200);
    expect(res.body.uploaded).toBe(true);
    expect(spyWriteFileSync).toHaveBeenCalledOnce();
  });
});

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

describe('POST /cv — private info scan', () => {
  it('returns warnings for a PDF containing a card-number pattern', async () => {
    const cardPdf = Buffer.from('%PDF-1.4 card: 1234 5678 9012 3456 end');
    const res = await request(app)
      .post('/cv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('cv', cardPdf, { filename: 'cv.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/card/i)]));
  });

  it('returns no warnings for a clean PDF', async () => {
    const res = await request(app)
      .post('/cv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('cv', minPdf, { filename: 'cv.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(200);
    expect(res.body.warnings).toHaveLength(0);
  });
});

describe('DELETE /cv — auth gate', () => {
  it('returns 401 without a JWT', async () => {
    const res = await request(app).delete('/cv');
    expect(res.status).toBe(401);
  });
});

describe('DELETE /cv', () => {
  it('returns 404 when no CV exists', async () => {
    spyExistsSync.mockReturnValue(false);
    const res = await request(app)
      .delete('/cv')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(404);
  });

  it('deletes the file and returns { deleted: true }', async () => {
    spyExistsSync.mockReturnValue(true);
    const res = await request(app)
      .delete('/cv')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(spyUnlinkSync).toHaveBeenCalledOnce();
  });
});
