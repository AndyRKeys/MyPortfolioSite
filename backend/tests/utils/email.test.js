/**
 * Email copy tests (#522 L9) — the magic-link expiry copy must be derived from
 * MAGIC_LINK_TTL in constants.js so email text can never drift from the real TTL.
 */
import { describe, it, expect, vi } from 'vitest';
import { MAGIC_LINK_TTL } from '../../utils/constants.js';

// email.js imports nodemailer at module load — mock so no real SMTP setup runs.
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn() },
}));

const { buildMagicLinkEmail } = await import('../../utils/email.js');

describe('buildMagicLinkEmail', () => {
  const url = 'https://example.com/login/?token=abc';

  it('derives the expiry copy from MAGIC_LINK_TTL in both html and text', () => {
    const { html, text } = buildMagicLinkEmail(url);
    expect(html).toContain(`expires in ${MAGIC_LINK_TTL}`);
    expect(text).toContain(`expires in ${MAGIC_LINK_TTL}`);
  });

  it('includes the login URL in both html and text', () => {
    const { html, text } = buildMagicLinkEmail(url);
    expect(html).toContain(url);
    expect(text).toContain(url);
  });
});
