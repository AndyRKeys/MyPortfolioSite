#!/usr/bin/env node
/**
 * Shim for running Playwright tests from the deploy pipeline.
 *
 * The pipeline calls: npm run <script> -- $NGINX_URL
 * (matching the legacy Puppeteer convention of passing the base URL as a
 * positional arg). Playwright does not accept a URL as a positional arg —
 * it treats unrecognised positionals as test-file filters, matching nothing.
 *
 * This shim detects a trailing http(s) URL, captures it as NGINX_URL (which
 * playwright.config.js already reads), strips it from the arg list, then
 * delegates to `playwright test` with the remaining args intact.
 */

import { execFileSync } from 'child_process';

const args = process.argv.slice(2); // strip node + this script
const lastArg = args.at(-1) ?? '';

if (/^https?:\/\//.test(lastArg)) {
  // Propagate the URL so playwright.config.js baseURL resolves correctly
  process.env.NGINX_URL = lastArg;
  args.pop();
}

execFileSync('npx', ['playwright', 'test', ...args], {
  stdio: 'inherit',
  env: process.env,
});
