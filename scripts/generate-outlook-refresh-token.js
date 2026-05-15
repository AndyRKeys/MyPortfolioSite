#!/usr/bin/env node
/**
 * Generate initial OAuth2 refresh token for Outlook SMTP
 *
 * Usage:
 * node scripts/generate-outlook-refresh-token.js
 *
 * Prompts for CLIENT_ID, CLIENT_SECRET, and email interactively.
 * Then opens browser to authorize and returns the refresh token.
 */

import { createServer } from 'http';
import { parse } from 'url';
import { createInterface } from 'readline';
import { exec } from 'child_process';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(question) {
  return new Promise(resolve => {
    rl.question(question, resolve);
  });
}

const AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const SCOPE = 'https://outlook.office365.com/.default offline_access';
const REDIRECT_URI = 'http://localhost:3001/callback';

let authCode = null;

async function main() {
  console.log('\n' + '='.repeat(80));
  console.log('Outlook OAuth2 Token Generator');
  console.log('='.repeat(80));
  console.log('\nYou need three pieces from your Azure AD app registration:');
  console.log('1. Application (Client) ID');
  console.log('2. Client Secret Value');
  console.log('3. Your Outlook email address');
  console.log('\nIf you haven\'t created an app yet:');
  console.log('  https://portal.azure.com → App registrations → New registration');
  console.log('\n' + '='.repeat(80) + '\n');

  const CLIENT_ID = await prompt('Enter CLIENT_ID: ');
  const CLIENT_SECRET = await prompt('Enter CLIENT_SECRET: ');
  const EMAIL = await prompt('Enter your Outlook email: ');

  if (!CLIENT_ID || !CLIENT_SECRET || !EMAIL) {
    console.error('\n✗ All fields are required');
    rl.close();
    process.exit(1);
  }

  console.log('\n✓ Starting authorization flow...\n');

  // Create callback server
  const server = createServer(async (req, res) => {
    const { query } = parse(req.url, true);

    if (query.code) {
      authCode = query.code;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>✓ Authorization successful!</h1><p>You can close this window and return to the terminal.</p>');
      console.log('✓ Authorization code received\n');
      await exchangeCodeForToken(CLIENT_ID, CLIENT_SECRET);
      server.close();
    } else if (query.error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<h1>✗ Authorization failed</h1><p>Error: ${query.error}</p>`);
      console.error('\n✗ Authorization failed:', query.error);
      if (query.error_description) {
        console.error('Description:', query.error_description);
      }
      server.close();
      rl.close();
      process.exit(1);
    }
  });

  server.listen(3001, () => {
    const authUri = `${AUTH_URL}?client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(SCOPE)}&prompt=login&login_hint=${encodeURIComponent(EMAIL)}`;

    console.log('Opening authorization URL in your browser...\n');

    // Try to open browser
    if (process.platform === 'darwin') {
      exec(`open "${authUri}"`);
    } else if (process.platform === 'win32') {
      exec(`start "" "${authUri}"`);
    } else if (process.platform === 'linux') {
      exec(`xdg-open "${authUri}"`);
    }

    console.log('If browser didn\'t open, copy this URL:\n');
    console.log(authUri);
    console.log('\nWaiting for authorization...\n');
  });
}

async function exchangeCodeForToken(clientId, clientSecret) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
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
      console.error('✗ Token exchange failed:', data.error);
      if (data.error_description) {
        console.error('Description:', data.error_description);
      }
      rl.close();
      process.exit(1);
    }

    console.log('\n' + '='.repeat(80));
    console.log('✓ SUCCESS! Copy these to your .env:');
    console.log('='.repeat(80) + '\n');
    console.log(`OUTLOOK_CLIENT_ID=${clientId}`);
    console.log(`OUTLOOK_CLIENT_SECRET=${clientSecret}`);
    console.log(`OUTLOOK_REFRESH_TOKEN=${data.refresh_token}`);
    console.log(`OUTLOOK_EMAIL=${data.email || '(your email)'}`);
    console.log('\n' + '='.repeat(80) + '\n');

    rl.close();
    process.exit(0);
  } catch (err) {
    console.error('✗ Token exchange error:', err.message);
    rl.close();
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  rl.close();
  process.exit(1);
});
