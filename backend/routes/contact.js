import { Router } from 'express';
import { validate, ContactSchema } from '../middleware/validate.js';
import { rateLimit } from 'express-rate-limit';
import { rateLimiterOptions } from '../middleware/rateLimiter.js';
import { resolveUser } from '../middleware/resolveUser.js';
import { isEmailConfigured, sendContactEmail, redactEmail } from '../utils/email.js';
import { logger } from '../utils/logger.js';

const router = Router();

const contactRateLimit = rateLimit(rateLimiterOptions({
  windowMs: 60 * 60 * 1000, // 3 per hour
  limit:    3,
  keyType:  'contact',
}));

router.post('/', contactRateLimit, resolveUser, validate(ContactSchema), async (req, res) => {
  // Honeypot: bots fill in the hidden website field — silently accept
  if (req.body.website) {
    return res.json({ success: true });
  }

  const { name, email, message } = req.body;

  if (!isEmailConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: 'Email service is not configured on this server.' });
    }
    // Never log raw PII — redact the email and log only the message length (#522 M18).
    logger.info(
      { email: redactEmail(email), messageLength: message?.length ?? 0 },
      '[contact] DEV: form submission received but email not configured — not sent'
    );
    return res.json({ success: true });
  }

  try {
    await sendContactEmail({ name, email, message });
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, '[contact] Failed to send contact email');
    res.status(500).json({ error: 'Failed to send message. Please email directly.' });
  }
});

export default router;
