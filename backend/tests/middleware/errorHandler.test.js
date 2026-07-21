/**
 * Priority 3 — errorHandler unit tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock errorWebhook before importing errorHandler so the module picks it up.
vi.mock('../../utils/errorWebhook.js', () => ({
  notifyError: vi.fn().mockResolvedValue(undefined),
}));

import { errorHandler } from '../../middleware/errorHandler.js';
import { notifyError } from '../../utils/errorWebhook.js';

function makeRes() {
  const res = {
    _status: null,
    _json:   null,
    headersSent: false,
    status(code) { this._status = code; return this; },
    json(data)   { this._json   = data; return this; },
  };
  return res;
}

describe('errorHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns generic message for 5xx to avoid leaking DB details', () => {
    const res = makeRes();
    errorHandler(new Error('Something broke'), {}, res, () => {});
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal server error' });
  });

  it('uses err.status when set', () => {
    const res = makeRes();
    const err = Object.assign(new Error('Not found'), { status: 404 });
    errorHandler(err, {}, res, () => {});
    expect(res._status).toBe(404);
    expect(res._json).toEqual({ error: 'Not found' });
  });

  it('sends err.message to client for 4xx errors', () => {
    const res = makeRes();
    const err = Object.assign(new Error('Validation failed'), { status: 422 });
    errorHandler(err, {}, res, () => {});
    expect(res._status).toBe(422);
    expect(res._json).toEqual({ error: 'Validation failed' });
  });

  it('uses err.statusCode when err.status is absent', () => {
    const res = makeRes();
    const err = Object.assign(new Error('Forbidden'), { statusCode: 403 });
    errorHandler(err, {}, res, () => {});
    expect(res._status).toBe(403);
  });

  it('falls back to 500 when no status is set', () => {
    const res = makeRes();
    errorHandler(new Error('Oops'), {}, res, () => {});
    expect(res._status).toBe(500);
  });

  it('returns a generic message when err.message is empty', () => {
    const res = makeRes();
    errorHandler(new Error(''), {}, res, () => {});
    expect(res._json.error).toBe('Internal server error');
  });

  it('does not respond if headers already sent', () => {
    const res = { ...makeRes(), headersSent: true };
    errorHandler(new Error('Too late'), {}, res, () => {});
    expect(res._json).toBeNull();
  });

  // #522 L15 — Express convention: once headers are sent, delegate to the
  // default handler via next(err) so the connection is torn down instead of
  // the error being silently swallowed.
  it('delegates to next(err) when headers already sent', () => {
    const res = { ...makeRes(), headersSent: true };
    const next = vi.fn();
    const err = new Error('Too late');
    errorHandler(err, {}, res, next);
    expect(res._json).toBeNull();
    expect(next).toHaveBeenCalledWith(err);
  });

  it('does not log in NODE_ENV=test', () => {
    const spy = vi.spyOn(console, 'error');
    errorHandler(new Error('Quiet'), {}, makeRes(), () => {});
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  // ── webhook notification (#156) ───────────────────────────────────────────

  it('calls notifyError for 5xx errors', () => {
    const err = new Error('Server blew up');
    errorHandler(err, { method: 'GET', path: '/api/posts' }, makeRes(), () => {});
    expect(notifyError).toHaveBeenCalledOnce();
    expect(notifyError).toHaveBeenCalledWith(err, {
      status: 500,
      method: 'GET',
      path:   '/api/posts',
    });
  });

  it('does not call notifyError for 4xx errors', () => {
    const err = Object.assign(new Error('Bad request'), { status: 400 });
    errorHandler(err, {}, makeRes(), () => {});
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('does not call notifyError for 422 validation errors', () => {
    const err = Object.assign(new Error('Unprocessable'), { status: 422 });
    errorHandler(err, {}, makeRes(), () => {});
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('calls notifyError with req context including method and path', () => {
    const err = new Error('DB error');
    const req = { method: 'POST', path: '/api/travel' };
    errorHandler(err, req, makeRes(), () => {});
    expect(notifyError).toHaveBeenCalledWith(err, {
      status: 500,
      method: 'POST',
      path:   '/api/travel',
    });
  });

  it('does not throw if notifyError itself rejects', async () => {
    notifyError.mockRejectedValueOnce(new Error('webhook down'));
    const res = makeRes();
    // Should not throw synchronously
    expect(() => errorHandler(new Error('Oops'), {}, res, () => {})).not.toThrow();
    // Give the rejected promise a tick to settle without crashing
    await new Promise(r => setTimeout(r, 0));
    expect(res._status).toBe(500);
  });
});
