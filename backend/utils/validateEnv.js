/**
 * Startup environment validation (#357).
 *
 * The original incident: SITE_HOST was present in .env and validated host-side
 * by validate_env() in deploy-lib.sh, but missing from the docker-compose.yml
 * `environment` block — so it was undefined inside the container and the CORS
 * check silently failed. Nothing in the pipeline caught the gap between
 * "defined on host" and "actually bridged into the container".
 *
 * This closes that gap from the container's side: on startup the backend
 * asserts every var it actually reads is present and non-empty, and fails loud
 * (exit 1) rather than booting with broken config and serving traffic.
 */

// Vars the app genuinely reads at runtime. Keep in sync with usage in
// app.js (CORS/FRONTEND_URL/SITE_HOST), db/pool.js (DB_*), auth.js
// (JWT_SECRET, WEBAUTHN_*, ADMIN_EMAIL), and server.js (PORT).
export const REQUIRED_ENV = [
  'PORT',
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'JWT_SECRET',
  'WEBAUTHN_RP_ID',
  'WEBAUTHN_ORIGIN',
  'FRONTEND_URL',
  'SITE_HOST',
  'ADMIN_EMAIL',
];

/**
 * Return the list of required vars that are missing or empty in `env`.
 * A var set to '' (e.g. compose `${SITE_HOST:-}` with nothing in .env) counts
 * as missing — an empty value is exactly the silent-failure case we're guarding.
 */
export function findMissingEnv(env = process.env, required = REQUIRED_ENV) {
  return required.filter((key) => {
    const val = env[key];
    return val === undefined || val === null || String(val).trim() === '';
  });
}

/**
 * Validate required env at startup. On any missing var, log each one via the
 * provided logger and exit(1) so the deploy fails fast before serving traffic.
 * Pure-ish: logger and exit are injected so it can be unit-tested.
 */
export function validateEnvOrExit(logger, env = process.env, exit = process.exit) {
  const missing = findMissingEnv(env);
  if (missing.length === 0) return;

  for (const key of missing) {
    logger.fatal(`[startup] Required env var ${key} is missing or empty`);
  }
  logger.fatal(
    `[startup] ${missing.length} required env var(s) missing: ${missing.join(', ')} — refusing to start. ` +
    'Check the service `environment:` block in docker-compose.yml bridges them from .env.',
  );
  exit(1);
}
