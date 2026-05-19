#!/usr/bin/env node

import nodemailer from 'nodemailer';

const config = {
  host: process.env.SMTP_HOST || 'smtp-mail.outlook.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
};

console.log('[SMTP Test] Testing connection to:', config.host, ':', config.port);
console.log('[SMTP Test] User:', config.auth.user ? `${config.auth.user.slice(0, 3)}***@...` : 'NOT SET');
console.log('[SMTP Test] Pass:', config.auth.pass ? '***SET***' : 'NOT SET');

if (!config.auth.user || !config.auth.pass) {
  console.error('[SMTP Test] ERROR: SMTP_USER and SMTP_PASS must be set');
  process.exit(1);
}

const transporter = nodemailer.createTransport(config);

transporter.verify((err, success) => {
  if (err) {
    console.error('[SMTP Test] ✗ Connection failed:');
    console.error('[SMTP Test]   Error:', err.message);
    console.error('[SMTP Test]   Code:', err.code);
    console.error('[SMTP Test]   Response:', err.response);
    console.error('[SMTP Test] Debugging tips:');
    console.error('[SMTP Test]   - Ensure SMTP_USER is your full email address (e.g., you@outlook.com)');
    console.error('[SMTP Test]   - Ensure SMTP_PASS is your app password, not your regular password');
    console.error('[SMTP Test]   - Outlook requires "Less secure apps" to be enabled (if not using OAuth2)');
    console.error('[SMTP Test]   - Try testing with `telnet smtp-mail.outlook.com 587` first');
    process.exit(1);
  } else {
    console.log('[SMTP Test] ✓ Connection verified successfully!');
    console.log('[SMTP Test] Transporter is ready to send emails');
    process.exit(0);
  }
});
