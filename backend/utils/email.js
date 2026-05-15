import nodemailer from 'nodemailer';

let transporter;

function getTransporter() {
  if (!transporter) {
    const isOAuth2 = !!(process.env.OUTLOOK_CLIENT_ID && process.env.OUTLOOK_CLIENT_SECRET && process.env.OUTLOOK_REFRESH_TOKEN);

    const config = {
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
    };

    if (isOAuth2) {
      config.auth = {
        type: 'OAuth2',
        user: process.env.OUTLOOK_EMAIL,
        clientId: process.env.OUTLOOK_CLIENT_ID,
        clientSecret: process.env.OUTLOOK_CLIENT_SECRET,
        refreshToken: process.env.OUTLOOK_REFRESH_TOKEN,
        accessUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      };
    } else {
      config.auth = {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      };
    }

    transporter = nodemailer.createTransport(config);
  }
  return transporter;
}

function isOAuth2Configured() {
  return !!(process.env.OUTLOOK_CLIENT_ID && process.env.OUTLOOK_CLIENT_SECRET && process.env.OUTLOOK_REFRESH_TOKEN && process.env.OUTLOOK_EMAIL);
}

function isBasicAuthConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export function isEmailConfigured() {
  return isOAuth2Configured() || isBasicAuthConfigured();
}

function redactEmail(email) {
  if (!email || !email.includes('@')) return '[invalid]';
  const [user, domain] = email.split('@');
  return `${user.slice(0, 2)}***@${domain}`;
}

export async function sendMagicLink(to, token) {
  console.log(`[email] sendMagicLink called for ${redactEmail(to)}`);

  if (!isEmailConfigured()) {
    console.warn('[email] Email not configured');
    if (isOAuth2Configured()) {
      console.warn('[email]   OAuth2: OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET, OUTLOOK_REFRESH_TOKEN, OUTLOOK_EMAIL must all be set');
    } else if (isBasicAuthConfigured()) {
      console.warn('[email]   Basic Auth: SMTP_HOST, SMTP_USER, SMTP_PASS must all be set');
    } else {
      console.warn('[email]   Neither OAuth2 nor Basic Auth configured');
    }
    throw new Error('Email not configured');
  }

  const from = isOAuth2Configured()
    ? process.env.OUTLOOK_EMAIL
    : (process.env.SMTP_FROM || process.env.SMTP_USER);
  const url = `${process.env.FRONTEND_URL}/login.html?token=${token}`;

  if (isOAuth2Configured()) {
    console.log(`[email] OAuth2 config: user=${redactEmail(process.env.OUTLOOK_EMAIL)}`);
  } else {
    console.log(`[email] SMTP config: host=${process.env.SMTP_HOST} port=${process.env.SMTP_PORT || 587} user=${redactEmail(process.env.SMTP_USER)}`);
  }
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
