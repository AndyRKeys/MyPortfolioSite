import { Router } from 'express';
import nodemailer from 'nodemailer';
import { pool } from '../db/pool.js';
import { escapeHtml } from '../utils/html.js';

const router = Router();

const RATE_LIMIT = 3;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * DB-backed rate limiter using the rate_limits table.
 * Falls back to allowing the request if the DB call fails, so a DB hiccup
 * doesn't silently block legitimate contact form submissions.
 *
 * @param {string} ip
 * @returns {Promise<boolean>} true = allow, false = block
 */
async function checkRateLimit(ip) {
  try {
    const now = new Date();
    const windowStart = new Date(now.getTime() - RATE_WINDOW_MS);

    // Upsert: if no row for this IP, create one with count=1.
    // If an existing row's window has expired, reset it.
    // Otherwise increment the counter and return it.
    const result = await pool.query(
      `INSERT INTO rate_limits (ip, count, window_start)
       VALUES ($1, 1, $2)
       ON CONFLICT (ip) DO UPDATE
         SET
           count = CASE
             WHEN rate_limits.window_start < $3 THEN 1
             ELSE rate_limits.count + 1
           END,
           window_start = CASE
             WHEN rate_limits.window_start < $3 THEN $2
             ELSE rate_limits.window_start
           END
       RETURNING count`,
      [ip, now, windowStart]
    );

    return result.rows[0].count <= RATE_LIMIT;
  } catch (err) {
    // Fail open: log and allow so a DB issue doesn't break the contact form.
    console.error('Rate limit DB error (failing open):', err.message);
    return true;
  }
}

function getTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

router.post('/', async (req, res) => {
  // Honeypot: bots fill in the hidden website field
  if (req.body.website) {
    return res.json({ message: 'Message sent.' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (!await checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  const { name, email, message } = req.body;
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email, and message are required.' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  try {
    await getTransporter().sendMail({
      from: `"AK Portfolio" <${process.env.SMTP_FROM}>`,
      to: process.env.SMTP_FROM,
      replyTo: email,
      subject: `Portfolio contact from ${name}`,
      text: `Name: ${name}\nEmail: ${email}\n\n${message}`,
      html: `<p><strong>Name:</strong> ${escapeHtml(name)}</p><p><strong>Email:</strong> <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p><hr><p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>`,
    });
    res.json({ message: 'Message sent successfully.' });
  } catch (err) {
    console.error('Contact email error:', err.message);
    res.status(500).json({ error: 'Failed to send message. Please email directly.' });
  }
});

export default router;
