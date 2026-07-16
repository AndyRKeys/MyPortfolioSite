/**
 * aiGenerate config tests (#522 M14) — model, max_tokens, and timeout must be
 * env-configurable rather than inline literals. Fetch is stubbed so no real
 * Ollama/Anthropic calls are made.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateAiBlogPost, getAiGenerateTimeoutMs } from '../../utils/aiGenerate.js';

const GENERATED = `TITLE: Day 1 — Config test\n---\n_Config test body._\n\n## What we worked on\n\nConfig.\n`;

/** Stub fetch: Ollama probe fails, Anthropic succeeds; captures the Anthropic request body. */
function stubFetchAnthropicOk() {
  const calls = { anthropicBody: null };
  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    if (String(url).includes('11434')) {
      return { ok: false, status: 503, text: async () => '' };
    }
    calls.anthropicBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ content: [{ text: GENERATED }] }) };
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.AI_GENERATE_TIMEOUT_MS;
});

describe('Anthropic model selection (#522 M14)', () => {
  it('defaults to claude-sonnet-4-6 with max_tokens 1024 when ANTHROPIC_MODEL is unset', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const calls = stubFetchAnthropicOk();
    await generateAiBlogPost('ctx', 'test');
    expect(calls.anthropicBody.model).toBe('claude-sonnet-4-6');
    expect(calls.anthropicBody.max_tokens).toBe(1024);
  });

  it('honours the ANTHROPIC_MODEL env var', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.ANTHROPIC_MODEL = 'claude-test-model-1';
    const calls = stubFetchAnthropicOk();
    await generateAiBlogPost('ctx', 'test');
    expect(calls.anthropicBody.model).toBe('claude-test-model-1');
  });
});

describe('getAiGenerateTimeoutMs (#522 M14)', () => {
  it('defaults to 150000 ms when AI_GENERATE_TIMEOUT_MS is unset', () => {
    expect(getAiGenerateTimeoutMs()).toBe(150_000);
  });

  it('honours a valid AI_GENERATE_TIMEOUT_MS override', () => {
    process.env.AI_GENERATE_TIMEOUT_MS = '30000';
    expect(getAiGenerateTimeoutMs()).toBe(30_000);
  });

  it('falls back to the default for invalid or non-positive values', () => {
    process.env.AI_GENERATE_TIMEOUT_MS = 'not-a-number';
    expect(getAiGenerateTimeoutMs()).toBe(150_000);
    process.env.AI_GENERATE_TIMEOUT_MS = '-5';
    expect(getAiGenerateTimeoutMs()).toBe(150_000);
  });
});
