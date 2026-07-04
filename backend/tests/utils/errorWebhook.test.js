/**
 * Unit tests for errorWebhook.js (#156).
 *
 * Verifies that notifyError():
 *   - is a no-op when ERROR_WEBHOOK_URL is not configured
 *   - POSTs the correct JSON payload when the URL is set
 *   - never throws — absorbs fetch failures silently
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeFetch(status = 200) {
  return vi.fn().mockResolvedValue({ status, ok: status < 400 });
}

// ── notifyError ───────────────────────────────────────────────────────────────

describe('notifyError', () => {
  let originalEnv;
  let originalFetch;

  beforeEach(() => {
    originalEnv   = process.env.ERROR_WEBHOOK_URL;
    originalFetch = global.fetch;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ERROR_WEBHOOK_URL;
    } else {
      process.env.ERROR_WEBHOOK_URL = originalEnv;
    }
    global.fetch = originalFetch;
    vi.resetModules();
  });

  it('does not call fetch when ERROR_WEBHOOK_URL is not set', async () => {
    delete process.env.ERROR_WEBHOOK_URL;
    global.fetch = makeFetch();

    // Re-import after env change so the module sees the updated env.
    const { notifyError } = await import('../../utils/errorWebhook.js');
    await notifyError(new Error('boom'));

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('POSTs to ERROR_WEBHOOK_URL with correct payload shape', async () => {
    process.env.ERROR_WEBHOOK_URL = 'https://example.com/hook';
    global.fetch = makeFetch(200);

    const { notifyError } = await import('../../utils/errorWebhook.js');
    const err = new Error('database exploded');
    await notifyError(err, { status: 500, path: '/api/posts' });

    expect(global.fetch).toHaveBeenCalledOnce();

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://example.com/hook');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({
      message: 'database exploded',
      env:     expect.any(String),
      context: { status: 500, path: '/api/posts' },
    });
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.stack).toContain('errorWebhook');
  });

  it('includes env from NODE_ENV in the payload', async () => {
    process.env.ERROR_WEBHOOK_URL = 'https://example.com/hook';
    process.env.NODE_ENV          = 'production';
    global.fetch = makeFetch(200);

    const { notifyError } = await import('../../utils/errorWebhook.js');
    await notifyError(new Error('oops'));

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.env).toBe('production');
  });

  it('does not throw when fetch rejects', async () => {
    process.env.ERROR_WEBHOOK_URL = 'https://example.com/hook';
    global.fetch = vi.fn().mockRejectedValue(new Error('network failure'));

    const { notifyError } = await import('../../utils/errorWebhook.js');
    // Must not throw
    await expect(notifyError(new Error('trigger'))).resolves.toBeUndefined();
  });

  it('does not throw when fetch returns a non-2xx status', async () => {
    process.env.ERROR_WEBHOOK_URL = 'https://example.com/hook';
    global.fetch = makeFetch(500);

    const { notifyError } = await import('../../utils/errorWebhook.js');
    await expect(notifyError(new Error('trigger'))).resolves.toBeUndefined();
  });

  it('handles a non-Error value gracefully', async () => {
    process.env.ERROR_WEBHOOK_URL = 'https://example.com/hook';
    global.fetch = makeFetch(200);

    const { notifyError } = await import('../../utils/errorWebhook.js');
    // Passing a plain string instead of an Error object
    await expect(notifyError('string error')).resolves.toBeUndefined();

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.message).toBe('string error');
  });
});
