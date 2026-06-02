/**
 * Priority 3 — errorHandler unit tests.
 */
import { describe, it, expect, vi } from 'vitest';
import { errorHandler } from '../../middleware/errorHandler.js';

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

  it('does not log in NODE_ENV=test', () => {
    const spy = vi.spyOn(console, 'error');
    errorHandler(new Error('Quiet'), {}, makeRes(), () => {});
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
