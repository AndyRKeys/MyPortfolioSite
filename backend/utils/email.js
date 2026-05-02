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

export async function sendMagicLink(to, token) {
  const url = `${process.env.FRONTEND_URL}/login.html?token=${token}`;
  await getTransporter().sendMail({
    from: `"AK Portfolio" <${process.env.SMTP_FROM}>`,
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
}
