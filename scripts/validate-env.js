#!/usr/bin/env node
/**
 * Validate .env against .env.example template
 * Reports missing variables and suggests additions
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const envPath = process.argv[2] || '.env';
const templatePath = process.argv[3] || '.env.example';

function parseEnvFile(filePath) {
  try {
    const content = readFileSync(filePath, 'utf8');
    const vars = new Set();
    content.split('\n').forEach(line => {
      const match = line.match(/^([A-Z_]+)\s*=/);
      if (match) {
        vars.add(match[1]);
      }
    });
    return vars;
  } catch (err) {
    return null;
  }
}

console.log(`[env-validate] Checking ${envPath} against ${templatePath}...`);

const envVars = parseEnvFile(envPath);
const templateVars = parseEnvFile(templatePath);

if (!envVars) {
  console.error(`[env-validate] ✗ Cannot read ${envPath}`);
  process.exit(1);
}

if (!templateVars) {
  console.error(`[env-validate] ✗ Cannot read ${templatePath}`);
  process.exit(1);
}

const missing = [...templateVars].filter(v => !envVars.has(v));
const extra = [...envVars].filter(v => !templateVars.has(v));

let hasIssues = false;

if (missing.length > 0) {
  console.warn(`[env-validate] ⚠ Missing ${missing.length} variables from template:`);
  missing.forEach(v => console.warn(`[env-validate]   - ${v}`));
  hasIssues = true;
}

if (extra.length > 0) {
  console.warn(`[env-validate] ⚠ ${extra.length} extra variables not in template:`);
  extra.forEach(v => console.warn(`[env-validate]   - ${v}`));
}

if (!hasIssues) {
  console.log(`[env-validate] ✓ All required variables present`);
  process.exit(0);
} else {
  console.warn(`[env-validate] ⚠ Please update .env with missing variables from .env.example`);
  process.exit(1);
}
