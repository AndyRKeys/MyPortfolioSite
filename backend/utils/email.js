import nodemailer from 'nodemailer';
import { escapeHtml } from './html.js';
import { logger } from './logger.js';
import { MAGIC_LINK_TTL } from './constants.js';

const GRAPH_TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const GRAPH_SEND_URL  = 'https://graph.microsoft.com/v1.0/me/sendMail';

export function isOAuth2Configured() {
  return !!(process.env.OUTLOOK_CLIENT_ID && process.env.OUTLOOK_CLIENT_SECRET && process.env.OUTLOOK_REFRESH_TOKEN && process.env.OUTLOOK_EMAIL);
}

function isSmtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export function isEmailConfigured() {
  return isOAuth2Configured() || isSmtpConfigured();
}

export function redactEmail(email) {
  if (!email || !email.includes('@')) return '[invalid]';
  const [user, domain] = email.split('@');
  return `${user.slice(0, 2)}***@${domain}`;
}

export async function getGraphAccessToken() {
  const res = await fetch(GRAPH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.OUTLOOK_CLIENT_ID,
      client_secret: process.env.OUTLOOK_CLIENT_SECRET,
      refresh_token: process.env.OUTLOOK_REFRESH_TOKEN,
      grant_type:    'refresh_token',
      scope:         'https://graph.microsoft.com/Mail.Send',
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`${data.error}: ${data.error_description}`);
  return data.access_token;
}

async function sendViaGraph({ from, to, replyTo, subject, text, html }) {
  const accessToken = await getGraphAccessToken();
  const body = {
    message: {
      subject,
      body: { contentType: 'HTML', content: html },
      toRecipients: [{ emailAddress: { address: to } }],
      ...(replyTo && { replyTo: [{ emailAddress: { address: replyTo } }] }),
    },
    saveToSentItems: true,
  };
  const res = await fetch(GRAPH_SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Graph API error ${res.status}`);
  }
}

function getSmtpTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

export async function sendContactEmail({ name, email, message }) {
  const from = isOAuth2Configured()
    ? process.env.OUTLOOK_EMAIL
    : (process.env.SMTP_FROM || process.env.SMTP_USER);
  const to = process.env.ADMIN_EMAIL || from;

  logger.info(
    { provider: isOAuth2Configured() ? 'graph' : 'smtp', to: redactEmail(to) },
    `[contact] Sending contact email from ${redactEmail(email)}`
  );

  const html = `<p><strong>Name:</strong> ${escapeHtml(name)}</p><p><strong>Email:</strong> <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p><hr><p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>`;
  const text = `Name: ${name}\nEmail: ${email}\n\n${message}`;

  if (isOAuth2Configured()) {
    await sendViaGraph({ from, to, replyTo: email, subject: `Portfolio contact from ${name}`, text, html });
  } else {
    await getSmtpTransporter().sendMail({ from: `"AK Portfolio" <${from}>`, to, replyTo: email, subject: `Portfolio contact from ${name}`, text, html });
  }

  logger.info({ to: redactEmail(to) }, '[contact] Contact email sent successfully');
}

export async function sendErrorAlertEmail({ count, windowMinutes, topErrors, adminEmail }) {
  if (!isEmailConfigured()) return;

  const from = isOAuth2Configured()
    ? process.env.OUTLOOK_EMAIL
    : (process.env.SMTP_FROM || process.env.SMTP_USER);

  const errorRows = topErrors.map(e =>
    `<tr><td style="padding:4px 8px">${escapeHtml(e.type)}</td><td style="padding:4px 8px">${escapeHtml(e.message.slice(0, 120))}</td><td style="padding:4px 8px;text-align:right">${e.count}</td></tr>`
  ).join('');

  const html = `
    <p><strong>${count} frontend errors</strong> received in the last ${windowMinutes} minutes on ${escapeHtml(process.env.SITE_HOST || 'the site')}.</p>
    <table border="1" cellspacing="0" style="border-collapse:collapse;font-size:13px">
      <thead><tr><th style="padding:4px 8px">Type</th><th style="padding:4px 8px">Message</th><th style="padding:4px 8px">Count</th></tr></thead>
      <tbody>${errorRows}</tbody>
    </table>
    <p style="color:#666;font-size:12px">Check /debug/errors for the full log.</p>
  `;
  const subject = `[${process.env.SITE_HOST || 'portfolio'}] ${count} frontend errors in ${windowMinutes} min`;
  const text = `${count} frontend errors in the last ${windowMinutes} minutes.\n\n${topErrors.map(e => `${e.type}: ${e.message} (×${e.count})`).join('\n')}`;

  try {
    if (isOAuth2Configured()) {
      await sendViaGraph({ from, to: adminEmail, subject, text, html });
    } else {
      await getSmtpTransporter().sendMail({ from: `"AK Portfolio" <${from}>`, to: adminEmail, subject, text, html });
    }
    logger.info(`[email] Error alert sent — ${count} errors in ${windowMinutes} min`);
  } catch (err) {
    logger.error({ err }, '[email] Failed to send error alert email');
  }
}

/**
 * Build the magic-link email bodies. The expiry copy is derived from
 * MAGIC_LINK_TTL (constants.js) so it can never drift from the real token TTL.
 *
 * @param {string} url  The full login URL including the token.
 * @returns {{ html: string, text: string }}
 */
export function buildMagicLinkEmail(url) {
  const html = `
    <p>Click the link below to log in to your admin dashboard:</p>
    <p>
      <a href="${url}" style="display:inline-block;padding:12px 24px;background:#1a1a2e;color:#fff;text-decoration:none;border-radius:4px;">
        Log in to AK Portfolio
      </a>
    </p>
    <p style="color:#666;font-size:12px;">This link expires in ${MAGIC_LINK_TTL} and can only be used once.</p>
  `;
  const text = `Log in here: ${url}\n\nThis link expires in ${MAGIC_LINK_TTL} and can only be used once.`;
  return { html, text };
}

export async function sendMagicLink(to, token) {
  logger.info(`[email] sendMagicLink called for ${redactEmail(to)}`);

  if (!isEmailConfigured()) {
    logger.warn('[email] Email not configured — set OUTLOOK_* or SMTP_* vars');
    throw new Error('Email not configured');
  }

  const from = isOAuth2Configured()
    ? process.env.OUTLOOK_EMAIL
    : (process.env.SMTP_FROM || process.env.SMTP_USER);
  const url  = `${process.env.FRONTEND_URL}/login/?token=${token}`;
  const { html, text } = buildMagicLinkEmail(url);

  if (isOAuth2Configured()) {
    logger.info(`[email] OAuth2 (Graph): user=${redactEmail(process.env.OUTLOOK_EMAIL)}`);
  } else {
    logger.info(`[email] SMTP: host=${process.env.SMTP_HOST} user=${redactEmail(process.env.SMTP_USER)}`);
  }
  logger.info(`[email] Sending from: ${redactEmail(from)} to: ${redactEmail(to)}`);

  try {
    if (isOAuth2Configured()) {
      await sendViaGraph({ from, to, subject: 'Your login link', text, html });
    } else {
      const info = await getSmtpTransporter().sendMail({ from: `"AK Portfolio" <${from}>`, to, subject: 'Your login link', text, html });
      if (info.rejected?.length) logger.warn(`[email] Rejected recipients: ${info.rejected.join(', ')}`);
    }
    logger.info('[email] Sent successfully');
  } catch (err) {
    logger.error({ err }, '[email] Send failed');
    throw err;
  }
}
