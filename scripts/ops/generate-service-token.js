#!/usr/bin/env node
// Run with: SERVICE_JWT_SECRET=<secret> node scripts/ops/generate-service-token.js [service-name] [expiry-days]
// Never commit the generated token or the secret.
import jwt from 'jsonwebtoken';

const serviceName = process.argv[2] || 'deploy-webhook';
const expiryDays  = parseInt(process.argv[3], 10) || 365;

const secret = process.env.SERVICE_JWT_SECRET;
if (!secret) {
  console.error('Error: SERVICE_JWT_SECRET env var is required');
  console.error('Usage: SERVICE_JWT_SECRET=<secret> node scripts/ops/generate-service-token.js [service-name] [expiry-days]');
  process.exit(1);
}

const token = jwt.sign(
  { role: 'service', service: serviceName, sub: `service:${serviceName}` },
  secret,
  { expiresIn: `${expiryDays}d`, algorithm: 'HS256' }
);

console.log(token);
console.error(`Generated service token for '${serviceName}', expires in ${expiryDays} days.`);
