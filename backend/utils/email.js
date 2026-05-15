import nodemailer from 'nodemailer';

let transporter;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return transporter;
}

export function isEmailConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function redactEmail(email) {
  if (!email || !email.includes('@')) return '[invalid]';
  const [user, domain] = email.split('@');
  return `${user.slice(0, 2)}***@${domain}`;
}

export async function sendMagicLink(to, token) {
  console.log(`[email] sendMagicLink called for ${redactEmail(to)}`);

  if (!isEmailConfigured()) {
    console.warn('[email] SMTP not configured — SMTP_HOST, SMTP_USER, SMTP_PASS must all be set');
    console.warn(`[email]   SMTP_HOST: ${process.env.SMTP_HOST || 'NOT SET'}`);
    console.warn(`[email]   SMTP_USER: ${process.env.SMTP_USER ? 'set' : 'NOT SET'}`);
    console.warn(`[email]   SMTP_PASS: ${process.env.SMTP_PASS ? 'set' : 'NOT SET'}`);
    throw new Error('SMTP not configured');
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const url = `${process.env.FRONTEND_URL}/login.html?token=${token}`;

  console.log(`[email] SMTP config: host=${process.env.SMTP_HOST} port=${process.env.SMTP_PORT || 587} user=${redactEmail(process.env.SMTP_USER)}`);
  console.log(`[email] Sending from: ${redactEmail(from)} to: ${redactEmail(to)}`);
  console.log(`[email] Login URL: ${process.env.FRONTEND_URL}/login.html?token=[redacted]`);

  try {
    const info = await getTransporter().sendMail({
      from: `"AK Portfolio" <${from}>`,
      to,
      subject: 'Your login link',
      text: `Log in here: ${url}\n\nThis link expires in 15 minutes and can only be used once.`,
      html: `
        <p>Click the link below to log in to your admin dashboard:</p>
        <p>
          <a href="${url}" style="display:inline-block;padding:12px 24px;background:#1a1a2e;color:#fff;text-decoration:none;border-radius:4px;">
            Log in to AK Portfolio
          </a>
        </p>
        <p style="color:#666;font-size:12px;">This link expires in 15 minutes and can only be used once.</p>
      `,
    });
    console.log(`[email] ✓ Sent successfully — messageId: ${info.messageId}`);
    if (info.rejected && info.rejected.length > 0) {
      console.warn(`[email] ⚠ Rejected recipients: ${info.rejected.join(', ')}`);
    }
  } catch (err) {
    console.error(`[email] ✗ Send failed: ${err.message}`);
    console.error(`[email]   Code: ${err.code || 'none'}`);
    console.error(`[email]   Response: ${err.response || 'none'}`);
    throw err;
  }
}
