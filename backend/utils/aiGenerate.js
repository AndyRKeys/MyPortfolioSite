/**
 * Shared AI blog post generation utility (#500).
 *
 * Encapsulates the LLM call logic used by both the /api/ai-blog/generate
 * HTTP route (admin UI) and the scheduled draft generation cron job.
 *
 * Provider priority:
 *   1. Ollama (local — OLLAMA_HOST / OLLAMA_MODEL env vars)
 *   2. Anthropic API fallback (ANTHROPIC_API_KEY env var)
 *
 * Returns { title, body_markdown } on success, throws on total failure
 * (both providers unavailable or erroring).
 */

import { logger } from './logger.js';

// ── Config ──────────────────────────────────────────────────────────────────────

// Default Anthropic model and generation settings. Overridable via env so the
// model can be bumped without a code change (#522 M14).
const DEFAULT_ANTHROPIC_MODEL     = 'claude-sonnet-4-6';
const ANTHROPIC_MAX_TOKENS        = 1024;
const DEFAULT_AI_GENERATE_TIMEOUT_MS = 150_000; // 150s — Ollama can be slow on cold start

/**
 * Resolve the AI generation timeout (ms) from AI_GENERATE_TIMEOUT_MS, falling
 * back to the default for unset, non-numeric, or non-positive values.
 */
export function getAiGenerateTimeoutMs() {
  const raw = parseInt(process.env.AI_GENERATE_TIMEOUT_MS, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AI_GENERATE_TIMEOUT_MS;
}

// ── System prompt ─────────────────────────────────────────────────────────────

export const AI_GENERATE_SYSTEM_PROMPT = `You are writing an AI dev blog post for a personal portfolio site. The owner (Andy) documents pair-programming sessions with Claude AI. Write in first person plural ("we") — Andy and Claude working together.

The post should follow this exact structure:
_One-line summary of the session._

## What we worked on

Brief description of the issue or feature tackled.

## What we built

- Key change one (be specific)
- Key change two
- Key change three

## What we broke / what was tricky

Honest note about obstacles, wrong turns, or surprising complexity. If nothing broke, write something like "Smooth session — no major obstacles."

## What we learned

An insight worth capturing — about the codebase, the tools, or the AI-assisted workflow.

## Next up

What's logically next based on what we just built.

Keep it concise and honest. No marketing language. Write as if explaining to a fellow developer reading your dev diary. The one-line summary at the top is in italics (wrapped in _underscores_).`;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse the raw LLM response into a title and body_markdown.
 *
 * Strategy 1 (preferred): TITLE: <title>\n---\n<body>
 * Strategy 2 (fallback):  # Markdown heading on the first non-empty line
 * Strategy 3 (fallback):  body returned as-is, title empty
 *
 * Caller is responsible for substituting a sensible default title when empty.
 */
export function parseAiResponse(raw) {
  const text = raw.trim();

  // Strategy 1: TITLE: ... \n---\n separator (case-insensitive; first line only)
  const separatorIdx = text.indexOf('\n---\n');
  if (separatorIdx !== -1) {
    const beforeSep  = text.slice(0, separatorIdx);
    const firstLine  = beforeSep.split('\n').map(l => l.trim()).find(l => l.length > 0) || '';
    const titleMatch = firstLine.match(/^title:\s*(.+)/i);
    const title      = titleMatch ? titleMatch[1].trim() : firstLine;
    if (title) {
      return { title, body_markdown: text.slice(separatorIdx + 5).trim() };
    }
  }

  // Strategy 2: # Markdown heading at the top
  const headingMatch = text.match(/^#\s+(.+)/m);
  if (headingMatch && text.indexOf(headingMatch[0]) < 120) {
    const title         = headingMatch[1].trim();
    const body_markdown = text.slice(text.indexOf(headingMatch[0]) + headingMatch[0].length).trim();
    return { title, body_markdown };
  }

  // Strategy 3: response starts with --- (model inverted the format)
  // Find the first non-empty, non-italic line before the first ## section heading
  if (text.startsWith('---')) {
    const afterSep = text.replace(/^---\s*\n/, '').trim();
    const firstSectionIdx = afterSep.search(/^##\s/m);
    const preamble = firstSectionIdx !== -1 ? afterSep.slice(0, firstSectionIdx) : afterSep.slice(0, 200);
    const titleCandidate = preamble.split('\n')
      .map(l => l.trim())
      .find(l => l.length > 0 && !l.startsWith('_') && !l.startsWith('#'));
    if (titleCandidate) {
      const body_markdown = firstSectionIdx !== -1
        ? afterSep.slice(firstSectionIdx).trim()
        : afterSep.replace(titleCandidate, '').trim();
      return { title: titleCandidate, body_markdown };
    }
  }

  // Strategy 4: no title found — return full text as body
  return { title: '', body_markdown: text };
}

/**
 * Build the user prompt for the AI, with optional developer context.
 */
export function buildUserMessage(context = null) {
  return `Write an AI dev blog post about today's session.
${context ? `Context from the developer:\n${context}` : 'No specific context provided — generate a plausible draft based on common portfolio site development tasks.'}

Your response MUST follow this exact format — the TITLE line and --- separator are required:

TITLE: Day N — [short description]
---
_One-line italic summary of the session._

## What we worked on

Brief description of the issue or feature tackled.

## What we built

- Key change one
- Key change two

## What we broke / what was tricky

Honest note about obstacles. If nothing broke, write "Smooth session — no major obstacles."

## What we learned

One insight worth capturing.

## Next up

What is logically next based on what was built.

Output ONLY the formatted response above. No preamble, no explanation.`;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Generate an AI blog post draft.
 *
 * @param {string|null} context   Optional developer context for the post.
 * @param {string}      caller    Log prefix for the caller (e.g. 'route', 'scheduler').
 * @returns {Promise<{title: string, body_markdown: string}>}
 * @throws  {Error} when all providers fail.
 */
export async function generateAiBlogPost(context = null, caller = 'generate') {
  const logPrefix   = `[ai-blog-generate/${caller}]`;
  const userMessage = buildUserMessage(context);

  // ── Priority 1: Ollama ────────────────────────────────────────────────────
  const ollamaHost  = process.env.OLLAMA_HOST  || 'http://host.docker.internal:11434';
  const ollamaModel = process.env.OLLAMA_MODEL || 'llama3.1:8b';

  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), getAiGenerateTimeoutMs());
    let ollamaRes;
    try {
      ollamaRes = await fetch(`${ollamaHost}/api/chat`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        signal:  controller.signal,
        body: JSON.stringify({
          model:    ollamaModel,
          stream:   false,
          messages: [
            { role: 'system', content: AI_GENERATE_SYSTEM_PROMPT },
            { role: 'user',   content: userMessage },
          ],
        }),
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!ollamaRes.ok) {
      const errBody = await ollamaRes.text().catch(() => '');
      logger.warn({ status: ollamaRes.status, body: errBody }, `${logPrefix} Ollama unavailable, trying Anthropic fallback`);
    } else {
      const data = await ollamaRes.json();
      const raw  = data?.message?.content || '';
      const result = parseAiResponse(raw);
      logger.info(
        { provider: 'ollama', model: ollamaModel, context: context || null, titleExtracted: !!result.title },
        `${logPrefix} Draft generated successfully`,
      );
      return result;
    }
  } catch (err) {
    logger.warn({ err: err.message }, `${logPrefix} Ollama unavailable, trying Anthropic fallback`);
  }

  // ── Priority 2: Anthropic API fallback ────────────────────────────────────
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('No AI provider available. Ollama is not running or Anthropic API key is not set.');
  }

  const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system:     AI_GENERATE_SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userMessage }],
    }),
  });

  if (!apiRes.ok) {
    const errBody = await apiRes.text().catch(() => '');
    logger.error({ status: apiRes.status, body: errBody }, `${logPrefix} Anthropic API error`);
    throw new Error('AI generation failed — upstream API error.');
  }

  const apiData = await apiRes.json();
  const raw     = apiData?.content?.[0]?.text || '';
  const result  = parseAiResponse(raw);
  logger.info(
    { provider: 'anthropic', context: context || null, titleExtracted: !!result.title },
    `${logPrefix} Draft generated successfully`,
  );
  return result;
}
