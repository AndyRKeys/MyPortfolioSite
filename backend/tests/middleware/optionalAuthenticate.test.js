/**
 * optionalAuthenticate middleware unit tests.
 * No DB or HTTP server required — tests the middleware function directly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { optionalAuthenticate } from '../../middleware/optionalAuthenticate.js';

const JWT_SECRET = 'test-secret-test-secret-test-secret-32';

function makeReq(authHeader) {
  return { headers: { authorization: authHeader } };
}

function run(req) {
  let nextCalled = false;
  const res = {};
  optionalAuthenticate(req, res, () => { nextCalled = true; });
  return { nextCalled };
}

beforeEach(() => {
  process.env.JWT_SECRET = JWT_SECRET;
});

afterEach(() => {
  delete process.env.JWT_SECRET;
});

describe('optionalAuthenticate', () => {
  it('always calls next()', () => {
    const req = makeReq(undefined);
    const { nextCalled } = run(req);
    expect(nextCalled).toBe(true);
  });

  it('does not set req.user when no Authorization header', () => {
    const req = makeReq(undefined);
    run(req);
    expect(req.user).toBeUndefined();
  });

  it('does not set req.user when header is not Bearer', () => {
    const req = makeReq('Basic dXNlcjpwYXNz');
    run(req);
    expect(req.user).toBeUndefined();
  });

  it('sets req.user when a valid JWT is provided', () => {
    const token = jwt.sign({ userId: 1 }, JWT_SECRET);
    const req = makeReq(`Bearer ${token}`);
    run(req);
    expect(req.user).toBeDefined();
    expect(req.user.userId).toBe(1);
  });

  it('does not set req.user and still calls next() when JWT is expired', () => {
    const token = jwt.sign({ userId: 1 }, JWT_SECRET, { expiresIn: -1 });
    const req = makeReq(`Bearer ${token}`);
    const { nextCalled } = run(req);
    expect(req.user).toBeUndefined();
    expect(nextCalled).toBe(true);
  });

  it('does not set req.user and still calls next() when JWT has wrong secret', () => {
    const token = jwt.sign({ userId: 1 }, 'wrong-secret');
    const req = makeReq(`Bearer ${token}`);
    const { nextCalled } = run(req);
    expect(req.user).toBeUndefined();
    expect(nextCalled).toBe(true);
  });

  it('does not set req.user and still calls next() for a malformed token', () => {
    const req = makeReq('Bearer not.a.jwt');
    const { nextCalled } = run(req);
    expect(req.user).toBeUndefined();
    expect(nextCalled).toBe(true);
  });
});
