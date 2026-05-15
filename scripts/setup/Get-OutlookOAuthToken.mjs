#!/usr/bin/env node
/**
 * One-time script to capture an Outlook OAuth2 refresh token.
 *
 * Run this once on your local machine, then copy the refresh token into .env.
 * The backend uses the refresh token silently from that point on.
 *
 * Prerequisites:
 *   - Azure App Registration with Delegated permissions: Mail.Send, offline_access
 *   - Redirect URI http://localhost:3333/callback added to the app registration
 *
 * Usage:
 *   node scripts/setup/Get-OutlookOAuthToken.mjs \
 *     --tenant <TENANT_ID> \
 *     --client <CLIENT_ID> \
 *     --secret <CLIENT_SECRET>
 */

import http from 'http';
import { exec } from 'child_process';

const args = process.argv.slice(2);
const get  = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const tenantId     = get('--tenant');
const clientId     = get('--client');
const clientSecret = get('--secret');

if (!tenantId || !clientId || !clientSecret) {
  console.error('Usage: node Get-OutlookOAuthToken.mjs --tenant <id> --client <id> --secret <secret>');
  process.exit(1);
}

const REDIRECT_URI = 'http://localhost:3333/callback';
const SCOPES       = 'https://graph.microsoft.com/Mail.Send offline_access';

const authUrl =
  `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize` +
  `?client_id=${clientId}` +
  `&response_type=code` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&response_mode=query`;

console.log('\nOpening browser for Microsoft login...');
console.log('If it does not open automatically, visit:\n');
console.log(authUrl);
console.log();

// Try to open browser (works on Windows/Mac/Linux)
const opener = process.platform === 'win32' ? 'start' :
               process.platform === 'darwin' ? 'open' : 'xdg-open';
exec(`${opener} "${authUrl}"`);

// Local callback server
const server = http.createServer(async (req, res) => {
  const url    = new URL(req.url, 'http://localhost:3333');
  const code   = url.searchParams.get('code');
  const error  = url.searchParams.get('error');

  if (error) {
    res.end(`<h2>Error: ${error}</h2><p>${url.searchParams.get('error_description')}</p>`);
    console.error(`\n✗ Authorization failed: ${error}`);
    console.error(`Description: ${url.searchParams.get('error_description')}`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.end('<h2>Waiting for authorization...</h2>');
    return;
  }

  res.end('<h2>Authorization successful. You can close this tab.</h2>');

  console.log('\nExchanging code for tokens...');

  const tokenRes = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        code,
        redirect_uri:  REDIRECT_URI,
        grant_type:    'authorization_code',
        scope:         SCOPES,
      }),
    }
  );

  const tokens = await tokenRes.json();

  if (tokens.error) {
    console.error(`\n✗ Token exchange failed: ${tokens.error}`);
    console.error(`Description: ${tokens.error_description}`);
    server.close();
    process.exit(1);
  }

  console.log('\n✓ Success! Add these to your .env:\n');
  console.log(`OUTLOOK_CLIENT_ID=${clientId}`);
  console.log(`OUTLOOK_CLIENT_SECRET=${clientSecret}`);
  console.log(`OUTLOOK_TENANT_ID=${tenantId}`);
  console.log(`OUTLOOK_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log(`OUTLOOK_FROM=andy.r.keys@outlook.com`);
  console.log();
  console.log('The refresh token does not expire unless unused for 90 days or revoked.');

  server.close();
});

server.listen(3333, () => {
  console.log('Waiting for authorization on http://localhost:3333/callback ...');
});
