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
 * Expects the model to return:
 *   TITLE: <title>
 *   ---
 *   <body starting with _italic summary_>
 *
 * Tolerates missing separator — returns empty title and full text as body.
 */
export function parseAiResponse(raw) {
  const separatorIdx = raw.indexOf('\n---\n');
  let title         = '';
  let body_markdown = raw.trim();
  if (separatorIdx !== -1) {
    const titleLine = raw.slice(0, separatorIdx).trim();
    title           = titleLine.startsWith('TITLE:') ? titleLine.slice(6).trim() : titleLine;
    body_markdown   = raw.slice(separatorIdx + 5).trim();
  }
  return { title, body_markdown };
}

/**
 * Build the user prompt for the AI, with optional developer context.
 */
export function buildUserMessage(context = null) {
  return `Write an AI dev blog post about today's session.
${context ? `Context from the developer: ${context}` : 'No specific context provided — generate a plausible draft based on common portfolio site development tasks.'}

Return ONLY the blog post content — start with the italic one-line summary, then the sections. Do not include a title heading like "# Title" at the top. The first line is the italicized summary.

For the post title (a separate field in the form), suggest: "Day N — [short description]" where N is a reasonable session number.

Format your response as:
TITLE: <suggested title here>
---
<blog post body starting with _italic summary_>`;
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
    const timeout    = setTimeout(() => controller.abort(), 150_000);
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
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
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
