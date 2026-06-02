import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/authenticate.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { exemptIfServiceAccount } from '../utils/serviceKey.js';
import { sendMagicLink } from '../utils/email.js';
import { logger } from '../utils/logger.js';
import {
  validate,
  EmailSendSchema,
  PasskeyRegisterFinishSchema,
  PasskeyLoginFinishSchema,
} from '../middleware/validate.js';

const router = Router();

const RP_NAME   = process.env.WEBAUTHN_RP_NAME   || 'AK Portfolio';
const RP_ID     = process.env.WEBAUTHN_RP_ID     || 'localhost';
const ORIGIN    = process.env.WEBAUTHN_ORIGIN    || 'http://localhost:5500';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '1h';

// Rate limiters for sensitive auth endpoints (per IP)
const emailRateLimit = createRateLimiter({
  limit: 5,
  windowMs: 60 * 60 * 1000, // 5 per hour
  keyType: 'email',
  message: 'Too many login attempts. Please try again later.',
  skip: exemptIfServiceAccount,
});

const passkeyRateLimit = createRateLimiter({
  limit: 10,
  windowMs: 60 * 60 * 1000, // 10 per hour
  keyType: 'passkey',
  message: 'Too many authentication attempts. Please try again later.',
  skip: exemptIfServiceAccount,
});

function signJWT(user) {
  return jwt.sign(
    { id: user.id, email: user.email, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

// ── Setup ─────────────────────────────────────────────────────────────────────

router.get('/setup/status', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM users');
    res.json({ hasUsers: parseInt(result.rows[0].count) > 0 });
  } catch (err) {
    logger.error({ err }, '[auth] setup/status DB error');
    res.status(500).json({ error: 'Database error' });
  }
});

// Bootstrap via magic link (#282). POST /auth/setup is retired — account creation
// now happens automatically on first magic-link send. The setup page redirects
// to /login/ and this endpoint returns 410 Gone so any direct POSTs fail clearly.
router.post('/setup', (req, res) => {
  logger.info('[auth/setup] Deprecated endpoint called — returning 410');
  res.status(410).json({
    error: 'Setup endpoint retired. Visit /login/ to sign in with a magic link.',
  });
});

// ── Current user ──────────────────────────────────────────────────────────────

router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, username, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, '[auth] /me DB error');
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Passkey registration ───────────────────────────────────────────────────────

// lgtm[js/missing-rate-limiting] -- passkeyRateLimit middleware applied
router.post('/passkey/register/start', passkeyRateLimit, authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (!userResult.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = userResult.rows[0];

    const existingPasskeys = await pool.query(
      'SELECT credential_id, transports FROM passkeys WHERE user_id = $1',
      [userId]
    );

    const options = await generateRegistrationOptions({
      rpName:    RP_NAME,
      rpID:      RP_ID,
      userID:    Buffer.from(userId),
      userName:  user.email,
      userDisplayName: user.username,
      attestationType: 'none',
      excludeCredentials: existingPasskeys.rows.map(pk => ({
        id:         pk.credential_id,
        type:       'public-key',
        transports: pk.transports,
      })),
      authenticatorSelection: {
        residentKey:      'preferred',
        userVerification: 'preferred',
      },
    });

    const sessionKey = uuidv4();
    await pool.query(
      `INSERT INTO webauthn_challenges (session_key, challenge, user_id, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '5 minutes')`,
      [sessionKey, options.challenge, userId]
    );

    res.json({ options, sessionKey });
  } catch (err) {
    logger.error({ err }, '[auth] passkey register start failed');
    res.status(500).json({ error: 'Failed to start registration' });
  }
});

// lgtm[js/missing-rate-limiting] -- passkeyRateLimit middleware applied
router.post('/passkey/register/finish', passkeyRateLimit, authenticate, validate(PasskeyRegisterFinishSchema), async (req, res) => {
  try {
    const { response, sessionKey, passkeyName } = req.body;

    const challengeRow = await pool.query(
      `SELECT * FROM webauthn_challenges
       WHERE session_key = $1 AND user_id = $2 AND expires_at > NOW()`,
      [sessionKey, req.user.id]
    );
    if (!challengeRow.rows.length) {
      return res.status(400).json({ error: 'Invalid or expired challenge' });
    }
    await pool.query('DELETE FROM webauthn_challenges WHERE session_key = $1', [sessionKey]);

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challengeRow.rows[0].challenge,
      expectedOrigin:    ORIGIN,
      expectedRPID:      RP_ID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Verification failed' });
    }

    const { credentialPublicKey, credentialID, counter, credentialDeviceType, credentialBackedUp } =
      verification.registrationInfo;

    await pool.query(
      `INSERT INTO passkeys (user_id, credential_id, public_key, counter, device_type, backed_up, transports, name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        req.user.id,
        Buffer.from(credentialID).toString('base64url'),
        Buffer.from(credentialPublicKey).toString('base64url'),
        counter,
        credentialDeviceType,
        credentialBackedUp,
        response.response?.transports ?? [],
        passkeyName || 'My passkey',
      ]
    );

    res.json({ verified: true });
  } catch (err) {
    logger.error({ err }, '[auth] passkey register finish failed');
    res.status(500).json({ error: 'Failed to finish registration' });
  }
});

// ── Passkey authentication ────────────────────────────────────────────────────

// lgtm[js/missing-rate-limiting] -- passkeyRateLimit middleware applied
router.post('/passkey/login/start', passkeyRateLimit, async (req, res) => {
  try {
    const { email } = req.body;
    let allowCredentials = [];

    if (email) {
      const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [
        email.toLowerCase().trim(),
      ]);
      if (userResult.rows.length) {
        const passkeys = await pool.query(
          'SELECT credential_id, transports FROM passkeys WHERE user_id = $1',
          [userResult.rows[0].id]
        );
        allowCredentials = passkeys.rows.map(pk => ({
          id:         pk.credential_id,
          type:       'public-key',
          transports: pk.transports,
        }));
      }
    }

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials,
      userVerification: 'preferred',
    });

    const sessionKey = uuidv4();
    await pool.query(
      `INSERT INTO webauthn_challenges (session_key, challenge, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '5 minutes')`,
      [sessionKey, options.challenge]
    );

    res.json({ options, sessionKey });
  } catch (err) {
    logger.error({ err }, '[auth] passkey login start failed');
    res.status(500).json({ error: 'Failed to start authentication' });
  }
});

// lgtm[js/missing-rate-limiting] -- passkeyRateLimit middleware applied
router.post('/passkey/login/finish', passkeyRateLimit, validate(PasskeyLoginFinishSchema), async (req, res) => {
  try {
    const { response, sessionKey } = req.body;

    const challengeRow = await pool.query(
      'SELECT * FROM webauthn_challenges WHERE session_key = $1 AND expires_at > NOW()',
      [sessionKey]
    );
    if (!challengeRow.rows.length) {
      return res.status(400).json({ error: 'Invalid or expired challenge' });
    }
    await pool.query('DELETE FROM webauthn_challenges WHERE session_key = $1', [sessionKey]);

    const credentialId = Buffer.from(response.id, 'base64url').toString('base64url');

    const passkeyRow = await pool.query(
      `SELECT p.*, u.id AS user_id, u.email, u.username
       FROM passkeys p JOIN users u ON p.user_id = u.id
       WHERE p.credential_id = $1`,
      [credentialId]
    );
    if (!passkeyRow.rows.length) {
      return res.status(400).json({ error: 'Unknown credential' });
    }

    const passkey = passkeyRow.rows[0];

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge:  challengeRow.rows[0].challenge,
      expectedOrigin:     ORIGIN,
      expectedRPID:       RP_ID,
      authenticator: {
        credentialID:        Buffer.from(passkey.credential_id, 'base64url'),
        credentialPublicKey: Buffer.from(passkey.public_key, 'base64url'),
        counter:             passkey.counter,
        transports:          passkey.transports,
      },
    });

    if (!verification.verified) {
      return res.status(401).json({ error: 'Authentication failed' });
    }

    await pool.query('UPDATE passkeys SET counter = $1 WHERE credential_id = $2', [
      verification.authenticationInfo.newCounter,
      passkey.credential_id,
    ]);

    const token = signJWT({ id: passkey.user_id, email: passkey.email, username: passkey.username });
    res.json({ token, user: { id: passkey.user_id, email: passkey.email, username: passkey.username } });
  } catch (err) {
    logger.error({ err }, '[auth] passkey login finish failed');
    res.status(500).json({ error: 'Failed to finish authentication' });
  }
});

// ── Email magic link ──────────────────────────────────────────────────────────

// lgtm[js/missing-rate-limiting] -- emailRateLimit middleware applied
router.post('/email/send', emailRateLimit, validate(EmailSendSchema), async (req, res) => {
  try {
    const { email } = req.body;
    const normalizedEmail = email.toLowerCase().trim();
    const normalizedAdmin = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();

    // Never log raw emails (PII) — only lengths/match so the admin-gate is
    // diagnosable without leaking the address.
    logger.info(
      {
        adminConfigured: Boolean(normalizedAdmin),
        submittedLen: normalizedEmail.length,
        adminLen: normalizedAdmin.length,
        match: normalizedEmail === normalizedAdmin,
      },
      '[auth/email/send] Request received'
    );

    // Gate magic link to admin email only — prevents email bombing/enumeration
    if (normalizedEmail !== normalizedAdmin) {
      logger.info('[auth/email/send] Gate blocked — submitted email does not match ADMIN_EMAIL');
      return res.json({ sent: true });
    }

    logger.info('[auth/email/send] Gate passed — looking up user in DB');

    // Find or create the admin user. Magic links are gated to ADMIN_EMAIL above,
    // so auto-creating here is safe and allows bootstrapping a fresh DB (e.g. dev
    // environment) without needing to go through /setup/ first.
    const upsertResult = await pool.query(
      `INSERT INTO users (email, username)
       VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id, (xmax = 0) AS created`,
      [normalizedEmail, normalizedEmail.split('@')[0]]
    );
    const userId = upsertResult.rows[0].id;
    const wasCreated = upsertResult.rows[0].created;

    logger.info({ wasCreated }, '[auth/email/send] User resolved');

    const token = uuidv4();
    await pool.query(
      `INSERT INTO email_tokens (user_id, token, expires_at)
       VALUES ($1, crypt($2, gen_salt('bf')), NOW() + INTERVAL '15 minutes')`,
      [userId, token]
    );
    logger.info('[auth/email/send] Token inserted — attempting email send');
    await sendMagicLink(normalizedEmail, token).catch(err => {
      logger.error(
        { err },
        '[auth/email/send] Failed to send magic link — check OUTLOOK_*/SMTP_* in .env'
      );
    });

    // Deliberate anti-enumeration: always same response regardless of whether email exists
    res.json({ sent: true });
  } catch (err) {
    logger.error({ err }, '[auth/email/send] Unexpected error');
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// lgtm[js/missing-rate-limiting] -- emailRateLimit middleware applied
router.get('/email/verify', emailRateLimit, async (req, res) => {
  try {
    const { token } = req.query;
    // Never log the raw token — it is a bearer credential.
    logger.info({ tokenPresent: Boolean(token) }, '[auth/email/verify] Request received');
    if (!token) {
      logger.info('[auth/email/verify] Rejected — no token in query');
      return res.status(400).json({ error: 'Token required' });
    }

    // Filter to unused, unexpired, bcrypt-shaped rows BEFORE calling crypt().
    // pgcrypto's crypt() raises a hard "invalid salt" error if et.token is not
    // a valid bcrypt hash (e.g. a legacy plaintext token). A single such row
    // would otherwise break verification for every token. The CTE narrows the
    // candidate set so crypt() only ever sees valid bcrypt hashes (#134).
    const result = await pool.query(
      `WITH candidates AS (
         SELECT et.id, et.user_id, et.token
         FROM email_tokens et
         WHERE et.used = FALSE
           AND et.expires_at > NOW()
           AND et.token LIKE '$2%'
       )
       SELECT c.id, c.user_id, u.email, u.username
       FROM candidates c
       JOIN users u ON c.user_id = u.id
       WHERE c.token = crypt($1, c.token)`,
      [token]
    );

    if (!result.rows.length) {
      // Diagnostic breakdown so a failed login is explainable from logs
      // alone: distinguishes "no valid candidates" (expired/used/none) from
      // "candidates exist but none match" (wrong/forged token), and surfaces
      // legacy non-bcrypt rows that should have been purged on boot.
      const diag = await pool.query(
        `SELECT
           count(*)                                                          AS total,
           count(*) FILTER (WHERE token NOT LIKE '$2%')                       AS legacy_plaintext,
           count(*) FILTER (WHERE used = TRUE)                                AS used,
           count(*) FILTER (WHERE expires_at <= NOW())                        AS expired,
           count(*) FILTER (WHERE used = FALSE AND expires_at > NOW()
                                  AND token LIKE '$2%')                       AS valid_candidates
         FROM email_tokens`
      );
      const d = diag.rows[0];
      logger.warn(
        {
          total: Number(d.total),
          valid_candidates: Number(d.valid_candidates),
          expired: Number(d.expired),
          used: Number(d.used),
          legacy_plaintext: Number(d.legacy_plaintext),
        },
        '[auth/email/verify] No match'
      );
      if (Number(d.legacy_plaintext) > 0) {
        logger.warn(
          { legacy_plaintext: Number(d.legacy_plaintext) },
          '[auth/email/verify] Legacy non-bcrypt row(s) present — boot cleanup may not have run (#134)'
        );
      }
      return res.status(400).json({ error: 'Invalid or expired link' });
    }

    const row = result.rows[0];
    await pool.query('UPDATE email_tokens SET used = TRUE WHERE id = $1', [row.id]);
    logger.info({ userId: row.user_id }, '[auth/email/verify] Match — token consumed; issuing JWT');

    const jwtToken = signJWT({ id: row.user_id, email: row.email, username: row.username });
    res.json({ token: jwtToken, user: { id: row.user_id, email: row.email, username: row.username } });
  } catch (err) {
    // Log the failure reason (not the token) so crypt/DB errors are diagnosable.
    logger.error({ err }, '[auth/email/verify] Verification failed');
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ── Passkey management ────────────────────────────────────────────────────────

router.get('/passkeys', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, device_type, backed_up, created_at
       FROM passkeys WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, '[auth] list passkeys DB error');
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/passkeys/:id', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM passkeys WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Passkey not found' });
    res.json({ deleted: true });
  } catch (err) {
    logger.error({ err }, '[auth] delete passkey DB error');
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
