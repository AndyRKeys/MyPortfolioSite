import { Router } from 'express';
import nodemailer from 'nodemailer';
import { pool } from '../db/pool.js';
import { escapeHtml } from '../utils/html.js';
import { validate, ContactSchema } from '../middleware/validate.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

const router = Router();

const contactRateLimit = createRateLimiter({
  limit: 3,
  windowMs: 60 * 60 * 1000, // 1 hour
  message: 'Too many requests. Please try again later.',
});

function isSmtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

router.post('/', contactRateLimit, validate(ContactSchema), async (req, res) => {
  // Honeypot: bots fill in the hidden website field — silently accept
  if (req.body.website) {
    return res.json({ success: true });
  }

  const { name, email, message } = req.body;
  // Field presence and email format are now guaranteed by validate(ContactSchema)

  // Dev stub: when SMTP is not configured, log to console so the form is testable locally
  if (!isSmtpConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: 'Email service is not configured on this server.' });
    }
    console.log('[DEV] Contact form submission (SMTP not configured — not sent):');
    console.log(`  Name:    ${name}`);
    console.log(`  Email:   ${email}`);
    console.log(`  Message: ${message}`);
    return res.json({ success: true });
  }

  try {
    await getTransporter().sendMail({
      from:    `"AK Portfolio" <${process.env.SMTP_FROM}>`,
      to:      process.env.SMTP_FROM,
      replyTo: email,
      subject: `Portfolio contact from ${name}`,
      text:    `Name: ${name}\nEmail: ${email}\n\n${message}`,
      html:    `<p><strong>Name:</strong> ${escapeHtml(name)}</p><p><strong>Email:</strong> <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p><hr><p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>`,
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Contact email error:', err.message);
    res.status(500).json({ error: 'Failed to send message. Please email directly.' });
  }
});

export default router;
