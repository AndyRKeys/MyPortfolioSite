/**
 * Priority 1 — validate() middleware unit tests.
 * Tests run against the real Zod schemas; no DB or HTTP server needed.
 */
import { describe, it, expect } from 'vitest';
import {
  validate,
  ContactSchema,
  CreatePostSchema,
  UpdatePostSchema,
  CreateTravelSchema,
  UpdateTravelSchema,
  SetupSchema,
  EmailSendSchema,
  PasskeyRegisterFinishSchema,
  PasskeyLoginFinishSchema,
} from '../../middleware/validate.js';

// Helper: run validate() middleware synchronously against a mock req.body
function runValidate(schema, body) {
  const req  = { body };
  const res  = {
    _status: null,
    _json:   null,
    status(code) { this._status = code; return this; },
    json(data)   { this._json   = data; return this; },
  };
  let nextCalled = false;
  validate(schema)(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

// ── ContactSchema ─────────────────────────────────────────────────────────────

describe('ContactSchema', () => {
  it('accepts valid input', () => {
    const { nextCalled } = runValidate(ContactSchema, {
      name: 'Alice', email: 'alice@example.com', message: 'Hello',
    });
    expect(nextCalled).toBe(true);
  });

  it('rejects missing name', () => {
    const { res, nextCalled } = runValidate(ContactSchema, {
      email: 'alice@example.com', message: 'Hello',
    });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/name/i);
  });

  it('rejects invalid email', () => {
    const { res, nextCalled } = runValidate(ContactSchema, {
      name: 'Alice', email: 'not-an-email', message: 'Hello',
    });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/email/i);
  });

  it('rejects missing message', () => {
    const { res } = runValidate(ContactSchema, {
      name: 'Alice', email: 'alice@example.com',
    });
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/message/i);
  });

  it('passes through optional honeypot field', () => {
    const { nextCalled, req } = runValidate(ContactSchema, {
      name: 'Alice', email: 'alice@example.com', message: 'Hi', website: 'bot.com',
    });
    expect(nextCalled).toBe(true);
    expect(req.body.website).toBe('bot.com');
  });
});

// ── CreatePostSchema ──────────────────────────────────────────────────────────

describe('CreatePostSchema', () => {
  it('accepts valid input', () => {
    const { nextCalled } = runValidate(CreatePostSchema, {
      title: 'My Post', body_markdown: '# Hello', post_date: '2026-05-04',
    });
    expect(nextCalled).toBe(true);
  });

  it('defaults body_markdown to empty string when omitted', () => {
    const { req, nextCalled } = runValidate(CreatePostSchema, { title: 'My Post' });
    expect(nextCalled).toBe(true);
    expect(req.body.body_markdown).toBe('');
  });

  it('rejects missing title', () => {
    const { res } = runValidate(CreatePostSchema, { body_markdown: '# Hi' });
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/title/i);
  });

  it('rejects bad date format', () => {
    const { res } = runValidate(CreatePostSchema, {
      title: 'My Post', post_date: '04-05-2026',
    });
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/YYYY-MM-DD/i);
  });
});

// ── UpdatePostSchema ──────────────────────────────────────────────────────────

describe('UpdatePostSchema', () => {
  it('accepts valid input', () => {
    const { nextCalled } = runValidate(UpdatePostSchema, {
      title: 'Updated', body_markdown: '# Updated', post_date: '2026-05-04',
    });
    expect(nextCalled).toBe(true);
  });

  it('rejects missing title', () => {
    const { res } = runValidate(UpdatePostSchema, { body_markdown: '# Hi' });
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/title/i);
  });
});

// ── CreateTravelSchema ────────────────────────────────────────────────────────

describe('CreateTravelSchema', () => {
  it('accepts valid input', () => {
    const { nextCalled } = runValidate(CreateTravelSchema, {
      title: 'Paris Trip', post_date: '2026-04-01',
    });
    expect(nextCalled).toBe(true);
  });

  it('rejects missing title', () => {
    const { res } = runValidate(CreateTravelSchema, { post_date: '2026-04-01' });
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/title/i);
  });

  it('coerces lat/lng strings to numbers', () => {
    const { req, nextCalled } = runValidate(CreateTravelSchema, {
      title: 'Paris', lat: '48.8566', lng: '2.3522',
    });
    expect(nextCalled).toBe(true);
    expect(req.body.lat).toBe(48.8566);
    expect(req.body.lng).toBe(2.3522);
  });

  it('coerces empty string lat/lng to null', () => {
    const { req, nextCalled } = runValidate(CreateTravelSchema, {
      title: 'Paris', lat: '', lng: '',
    });
    expect(nextCalled).toBe(true);
    expect(req.body.lat).toBeNull();
    expect(req.body.lng).toBeNull();
  });

  it('defaults media_items to empty array', () => {
    const { req, nextCalled } = runValidate(CreateTravelSchema, { title: 'Paris' });
    expect(nextCalled).toBe(true);
    expect(req.body.media_items).toEqual([]);
  });
});

// ── SetupSchema ───────────────────────────────────────────────────────────────

describe('SetupSchema', () => {
  it('accepts valid input', () => {
    const { nextCalled } = runValidate(SetupSchema, {
      email: 'admin@example.com', username: 'admin',
    });
    expect(nextCalled).toBe(true);
  });

  it('rejects invalid email', () => {
    const { res } = runValidate(SetupSchema, { email: 'bad', username: 'admin' });
    expect(res._status).toBe(400);
  });

  it('rejects missing username', () => {
    const { res } = runValidate(SetupSchema, { email: 'admin@example.com' });
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/username/i);
  });
});

// ── EmailSendSchema ───────────────────────────────────────────────────────────

describe('EmailSendSchema', () => {
  it('accepts valid email', () => {
    const { nextCalled } = runValidate(EmailSendSchema, { email: 'user@example.com' });
    expect(nextCalled).toBe(true);
  });

  it('rejects invalid email', () => {
    const { res } = runValidate(EmailSendSchema, { email: 'not-email' });
    expect(res._status).toBe(400);
  });
});

// ── PasskeyRegisterFinishSchema ───────────────────────────────────────────────

describe('PasskeyRegisterFinishSchema', () => {
  it('accepts valid input', () => {
    const { nextCalled } = runValidate(PasskeyRegisterFinishSchema, {
      response: { id: 'abc', type: 'public-key' }, sessionKey: 'sess_123',
    });
    expect(nextCalled).toBe(true);
  });

  it('rejects missing sessionKey', () => {
    const { res } = runValidate(PasskeyRegisterFinishSchema, {
      response: { id: 'abc', type: 'public-key' },
    });
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/sessionKey/i);
  });
});

// ── PasskeyLoginFinishSchema ──────────────────────────────────────────────────

describe('PasskeyLoginFinishSchema', () => {
  it('accepts valid input', () => {
    const { nextCalled } = runValidate(PasskeyLoginFinishSchema, {
      response: { id: 'xyz' }, sessionKey: 'sess_456',
    });
    expect(nextCalled).toBe(true);
  });

  it('rejects missing sessionKey', () => {
    const { res } = runValidate(PasskeyLoginFinishSchema, {
      response: { id: 'xyz' },
    });
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/sessionKey/i);
  });
});
