/**
 * Shared backend constants.
 *
 * Extract magic numbers and config literals here rather than scattering them
 * across route files. Values that are operationally significant or
 * security-sensitive belong either here (as named constants) or in .env
 * (for values that need per-environment tuning at deploy time).
 */

// ── Post excerpts ─────────────────────────────────────────────────────────────

// Characters of body_markdown to return in listing queries. Keeping all
// listing consumers in sync requires a single source of truth (#433).
export const EXCERPT_LENGTH = 300;

// ── Auth ──────────────────────────────────────────────────────────────────────

// Rate-limit windows (milliseconds)
export const EMAIL_RATE_WINDOW_MS   = 60 * 60 * 1000; // 1 hour
export const PASSKEY_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
export const ACCOUNT_RATE_WINDOW_MS = 60 * 1000;       // 1 minute

// Rate-limit request caps
export const EMAIL_RATE_LIMIT   = 5;  // per EMAIL_RATE_WINDOW_MS
export const PASSKEY_RATE_LIMIT = 10; // per PASSKEY_RATE_WINDOW_MS
export const ACCOUNT_RATE_LIMIT = 60; // per ACCOUNT_RATE_WINDOW_MS

// WebAuthn challenge TTL — how long the browser has to complete a ceremony.
// Read by auth.js INSERT ... NOW() + INTERVAL '...' SQL literals.
export const WEBAUTHN_CHALLENGE_TTL = '5 minutes';

// Magic-link token TTL — security-sensitive: determines how long a stolen link
// is valid. Changing this requires updating auth.js email/verify query too.
export const MAGIC_LINK_TTL = '15 minutes';

// ── CV upload ─────────────────────────────────────────────────────────────────

// Maximum size (bytes) for CV PDF uploads.
export const CV_MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

// ── Media upload ──────────────────────────────────────────────────────────────

// Maximum size (bytes) for generic media uploads (photos/videos).
export const MEDIA_MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

// Allowed MIME types for generic media uploads.
export const MEDIA_ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'video/quicktime',
]);

// ── Posts / travel rate limits ────────────────────────────────────────────────

export const POSTS_RATE_WINDOW_MS  = 60 * 1000; // 1 minute
export const POSTS_RATE_LIMIT      = 120;

export const TRAVEL_RATE_WINDOW_MS = 60 * 1000; // 1 minute
export const TRAVEL_RATE_LIMIT     = 120;

export const UPLOAD_RATE_WINDOW_MS = 60 * 1000; // 1 minute
export const UPLOAD_RATE_LIMIT     = 30;

export const CV_RATE_WINDOW_MS     = 60 * 1000; // 1 minute
export const CV_RATE_LIMIT         = 30;
