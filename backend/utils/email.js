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

export async function sendMagicLink(to, token) {
  if (!isEmailConfigured()) {
    console.warn('[email] SMTP not configured — SMTP_HOST, SMTP_USER, SMTP_PASS must all be set');
    throw new Error('SMTP not configured');
  }

  // Fall back to SMTP_USER if SMTP_FROM not explicitly set (common for Gmail)
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const url = `${process.env.FRONTEND_URL}/login.html?token=${token}`;

  console.log(`[email] Sending magic link to ${to} via ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587}`);

  await getTransporter().sendMail({
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

  console.log(`[email] Magic link sent successfully to ${to}`);
}
