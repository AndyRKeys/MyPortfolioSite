#!/usr/bin/env node
/**
 * Generate initial OAuth2 refresh token for Outlook SMTP
 *
 * Usage:
 * 1. Set CLIENT_ID and CLIENT_SECRET below (from Azure AD app registration)
 * 2. Run: node scripts/generate-outlook-refresh-token.js
 * 3. Open the displayed URL in a browser and authorize
 * 4. Copy the refresh token to your .env as OUTLOOK_REFRESH_TOKEN
 */

import { createServer } from 'http';
import { parse } from 'url';

// ── REPLACE THESE WITH YOUR AZURE AD CREDENTIALS ──────────────────────────────
const CLIENT_ID = 'YOUR_CLIENT_ID_HERE';
const CLIENT_SECRET = 'YOUR_CLIENT_SECRET_HERE';
const EMAIL = 'your.email@outlook.com'; // your Outlook email
// ─────────────────────────────────────────────────────────────────────────────

const REDIRECT_URI = 'http://localhost:3001/callback';
const AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const SCOPE = 'https://outlook.office365.com/SMTP.Send offline_access';

let authCode = null;

// Create callback server to capture auth code
const server = createServer(async (req, res) => {
  const { query } = parse(req.url, true);

  if (query.code) {
    authCode = query.code;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>✓ Authorization successful!</h1><p>You can close this window and return to the terminal.</p>');
    console.log('[Token Gen] ✓ Authorization code received');
    await exchangeCodeForToken();
    server.close();
  } else if (query.error) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<h1>✗ Authorization failed</h1><p>Error: ${query.error}</p><p>${query.error_description}</p>`);
    console.error('[Token Gen] ✗ Authorization failed:', query.error, query.error_description);
    server.close();
    process.exit(1);
  }
});

server.listen(3001, () => {
  console.log('[Token Gen] ℹ Callback server listening on http://localhost:3001');

  const authUri = `${AUTH_URL}?client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(SCOPE)}&prompt=login&login_hint=${encodeURIComponent(EMAIL)}`;

  console.log('[Token Gen] ℹ Open this URL in your browser to authorize:');
  console.log('[Token Gen] ');
  console.log(authUri);
  console.log('[Token Gen] ');
  console.log('[Token Gen] Waiting for authorization...');
});

async function exchangeCodeForToken() {
  console.log('[Token Gen] Exchanging code for token...');

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code: authCode,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
    scope: SCOPE,
  });

  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await response.json();

    if (data.error) {
      console.error('[Token Gen] ✗ Token exchange failed:', data.error, data.error_description);
      process.exit(1);
    }

    console.log('\n' + '='.repeat(80));
    console.log('[Token Gen] ✓ SUCCESS! Copy the refresh token below to your .env file:');
    console.log('='.repeat(80));
    console.log('\nOUTLOOK_REFRESH_TOKEN=' + data.refresh_token);
    console.log('\nAlso add to .env:');
    console.log('OUTLOOK_CLIENT_ID=' + CLIENT_ID);
    console.log('OUTLOOK_CLIENT_SECRET=' + CLIENT_SECRET);
    console.log('OUTLOOK_EMAIL=' + EMAIL);
    console.log('\n' + '='.repeat(80));

    process.exit(0);
  } catch (err) {
    console.error('[Token Gen] ✗ Token exchange error:', err.message);
    process.exit(1);
  }
}
