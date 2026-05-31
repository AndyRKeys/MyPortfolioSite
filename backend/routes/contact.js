import { Router } from 'express';
import { validate, ContactSchema } from '../middleware/validate.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { exemptIfTrusted } from '../utils/serviceKey.js';
import { isEmailConfigured, sendContactEmail } from '../utils/email.js';
import { logger } from '../utils/logger.js';

const router = Router();

const contactRateLimit = createRateLimiter({
  limit: 3,
  windowMs: 60 * 60 * 1000, // 1 hour
  message: 'Too many requests. Please try again later.',
  skip: exemptIfTrusted,
});

// lgtm[js/missing-rate-limiting] -- contactRateLimit middleware applied
router.post('/', contactRateLimit, validate(ContactSchema), async (req, res) => {
  // Honeypot: bots fill in the hidden website field — silently accept
  if (req.body.website) {
    return res.json({ success: true });
  }

  const { name, email, message } = req.body;

  if (!isEmailConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: 'Email service is not configured on this server.' });
    }
    logger.info(
      { name, email, message },
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
