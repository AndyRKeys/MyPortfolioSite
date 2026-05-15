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
import { sendMagicLink } from '../utils/email.js';
import {
  validate,
  SetupSchema,
  EmailSendSchema,
  PasskeyRegisterFinishSchema,
  PasskeyLoginFinishSchema,
} from '../middleware/validate.js';

const router = Router();

const RP_NAME   = process.env.WEBAUTHN_RP_NAME   || 'AK Portfolio';
const RP_ID     = process.env.WEBAUTHN_RP_ID     || 'localhost';
const ORIGIN    = process.env.WEBAUTHN_ORIGIN    || 'http://localhost:5500';
const JWT_EXPIRY = '24h';

// Rate limiters for sensitive auth endpoints (per IP)
const emailRateLimit = createRateLimiter({
  limit: 5,
  windowMs: 60 * 60 * 1000, // 5 per hour
  message: 'Too many login attempts. Please try again later.',
});

const passkeyRateLimit = createRateLimiter({
  limit: 10,
  windowMs: 60 * 60 * 1000, // 10 per hour
  message: 'Too many authentication attempts. Please try again later.',
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
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/setup', validate(SetupSchema), async (req, res) => {
  try {
    const { email, username } = req.body;

    const count = await pool.query('SELECT COUNT(*) FROM users');
    if (parseInt(count.rows[0].count) > 0) {
      return res.status(403).json({ error: 'Setup already complete' });
    }

    const result = await pool.query(
      'INSERT INTO users (email, username) VALUES ($1, $2) RETURNING *',
      [email.toLowerCase().trim(), username.trim()]
    );

    const user = result.rows[0];
    res.json({ token: signJWT(user), user: { id: user.id, email: user.email, username: user.username } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create user' });
  }
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
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Passkey registration ───────────────────────────────────────────────────────

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
    console.error(err);
    res.status(500).json({ error: 'Failed to start registration' });
  }
});

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
    console.error(err);
    res.status(500).json({ error: 'Failed to finish registration' });
  }
});

// ── Passkey authentication ────────────────────────────────────────────────────

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
    console.error(err);
    res.status(500).json({ error: 'Failed to start authentication' });
  }
});

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
    console.error(err);
    res.status(500).json({ error: 'Failed to finish authentication' });
  }
});

// ── Email magic link ──────────────────────────────────────────────────────────

router.post('/email/send', emailRateLimit, validate(EmailSendSchema), async (req, res) => {
  try {
    const { email } = req.body;
    const normalizedEmail = email.toLowerCase().trim();
    const normalizedAdmin = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();

    // Debug: confirm we entered the handler
    console.log(`[auth/email/send] Request received`);
    console.log(`[auth/email/send] ADMIN_EMAIL configured: ${normalizedAdmin ? 'yes' : 'NO — blank!'}`);
    console.log(`[auth/email/send] Submitted email length: ${normalizedEmail.length}`);
    console.log(`[auth/email/send] Admin email length: ${normalizedAdmin.length}`);
    console.log(`[auth/email/send] Emails match: ${normalizedEmail === normalizedAdmin}`);

    // Gate magic link to admin email only — prevents email bombing/enumeration
    if (normalizedEmail !== normalizedAdmin) {
      console.log(`[auth/email/send] Gate blocked — submitted email does not match ADMIN_EMAIL`);
      return res.json({ sent: true });
    }

    console.log(`[auth/email/send] Gate passed — looking up user in DB`);
    const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [
      normalizedEmail,
    ]);

    console.log(`[auth/email/send] DB lookup complete — rows found: ${userResult.rows.length}`);

    if (userResult.rows.length) {
      const token = uuidv4();
      await pool.query(
        `INSERT INTO email_tokens (user_id, token, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '15 minutes')`,
        [userResult.rows[0].id, token]
      );
      console.log(`[auth/email/send] Token inserted — attempting email send`);
      await sendMagicLink(normalizedEmail, token).catch(err => {
        console.error('[auth] Failed to send magic link:', err.message);
        console.error('[auth] SMTP error stack:', err.stack);
        console.error('[auth] Check SMTP_HOST, SMTP_USER, SMTP_PASS in .env');
      });
    } else {
      console.log(`[auth/email/send] No user found for this email — skipping send`);
    }

    // Deliberate anti-enumeration: always same response regardless of whether email exists
    res.json({ sent: true });
  } catch (err) {
    console.error('[auth/email/send] Unexpected error:', err.message);
    console.error(err.stack);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

router.get('/email/verify', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const result = await pool.query(
      `SELECT et.user_id, et.token, u.email, u.username
       FROM email_tokens et JOIN users u ON et.user_id = u.id
       WHERE et.token = $1 AND et.used = FALSE AND et.expires_at > NOW()`,
      [token]
    );
    if (!result.rows.length) {
      return res.status(400).json({ error: 'Invalid or expired link' });
    }

    await pool.query('UPDATE email_tokens SET used = TRUE WHERE token = $1', [token]);

    const row = result.rows[0];
    const jwtToken = signJWT({ id: row.user_id, email: row.email, username: row.username });
    res.json({ token: jwtToken, user: { id: row.user_id, email: row.email, username: row.username } });
  } catch (err) {
    console.error(err);
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
    console.error(err);
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
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
