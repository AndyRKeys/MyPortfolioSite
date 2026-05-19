# Security Model

Authentication and security reference for andykeys.me. Read this before touching auth routes, session handling, or input validation.

---

## Single-User Assumption

The site has **one admin user**. There is no registration flow for the public — `/setup/` creates the account and is a one-time operation. All protected routes check for a valid JWT and assume the bearer is the admin.

**Server-side registration guard (#274):** `POST /auth/setup` is not protected by the `/setup/` redirect alone (trivially bypassed by POSTing directly). The route enforces two server-side checks before creating the account: (1) the submitted email must equal `ADMIN_EMAIL`, and (2) no user may already exist. It **fails closed** — if `ADMIN_EMAIL` is unset the route refuses all registration. Both the not-configured and wrong-email cases return the same generic `403` so a caller cannot probe whether setup has completed.

---

## Authentication Flows

Two independent methods are supported. Either can be used to obtain a JWT.

### 1. WebAuthn / FIDO2 Passkeys (primary)

1. **Registration** (`/auth/webauthn/register/*`)
   - Browser requests a challenge from the server (`/begin`)
   - Challenge is stored in `webauthn_challenges` with an expiry (~5 min)
   - Browser creates a credential using the platform authenticator (Touch ID, Face ID, Windows Hello, etc.)
   - Server verifies the response and stores the credential in `passkeys` (`/complete`)

2. **Authentication** (`/auth/webauthn/login/*`)
   - Browser requests a challenge (`/begin`)
   - Browser signs the challenge with the stored private key
   - Server verifies the signature against the stored `public_key` and checks the `counter` has incremented (`/complete`)
   - On success, a signed JWT is returned

**Replay protection:** The `counter` field in `passkeys` increments on every use. The server rejects any response where the counter has not increased, preventing cloned-credential replay attacks.

**Challenge expiry:** Challenges in `webauthn_challenges` expire after ~5 minutes and are deleted after use.

### 2. Email Magic Links (fallback)

1. Admin requests a magic link at `/auth/email/send` with their registered email
2. A secure random token (UUID) is generated, its bcrypt hash is stored in `email_tokens` via `crypt(token, gen_salt('bf'))`, and the raw token is emailed
3. Admin clicks the link; `/auth/email/verify` validates the token by re-hashing (`crypt($1, et.token) = et.token`)
4. Token is marked `used = TRUE` (single-use)
5. On success, a signed JWT is returned

**Expiry:** Tokens expire based on `expires_at`. Expired tokens are rejected regardless of `used` status.
**Single-use:** Once a token is used, `used = TRUE` and any subsequent attempt with the same token is rejected.
**At-rest protection:** Only the bcrypt hash of the token is persisted, so a stolen DB dump cannot be replayed to forge magic-link logins (#134).
**Recipient gate:** Tokens are only sent to `ADMIN_EMAIL`. Requests for any other address return the same success response (no enumeration signal) but no email is sent.
**Rate limit:** `/auth/email/send` is limited to 5 requests/hour/IP (DB-backed, survives restarts).

**Email transport:** Outlook OAuth2 via the Microsoft Graph API (`/v1.0/me/sendMail`). Microsoft has disabled SMTP basic auth, so a long-lived refresh token (delegated `Mail.Send` scope, personal-account `/consumers/` endpoint) is exchanged for a short-lived access token on each send. The refresh token is stored in `.env` only. SMTP basic auth (`nodemailer`) is retained as a fallback for non-Outlook providers.

---

## JWT

- Signed with `JWT_SECRET` (env var — must be set at startup or the server exits)
- Expiry controlled by `JWT_EXPIRY` (e.g. `7d`)
- Carried in an `Authorization: Bearer <token>` header or a `token` cookie
- Validated by the `authenticate` middleware (`backend/middleware/authenticate.js`) on all protected routes

**No refresh tokens.** Expired JWTs require re-authentication.

---

## Protected vs Public Routes

| Route pattern | Auth required | Notes |
|--------------|---------------|-------|
| `GET /api/posts` | No | Published posts only (`published_at IS NOT NULL`) |
| `GET /api/posts/:id` | No | Published only |
| `GET /api/travel` | No | Published travel memories only |
| `GET /api/travel/:id` | No | Published only |
| `GET /api/posts/all` | Yes | All posts including drafts |
| `GET /api/travel/all` | Yes | All memories including drafts |
| `GET /api/travel/admin/:id` | Yes | Includes drafts |
| `POST /api/posts` | Yes | Create post |
| `PUT /api/posts/:id` | Yes | Edit post |
| `DELETE /api/posts/:id` | Yes | Delete post |
| `POST /api/travel` | Yes | Create memory |
| `PUT /api/travel/:id` | Yes | Edit memory |
| `DELETE /api/travel/:id` | Yes | Delete memory |
| `GET /api/stats` | Yes | Page visit counts |
| `POST /api/contact` | No | Rate-limited |
| `POST /api/auth/*` | No | Auth endpoints |
| `GET /health` | No | **Internal only** — direct backend port; nginx does not proxy this path (#279) |

---

## Input Validation & Sanitization

- **SQL injection:** All database queries use parameterized queries (`$1, $2, …`). String concatenation into SQL is never used.
- **XSS — frontend:** User-supplied strings are escaped with `escapeHtml()` (`resources/js/utils/html.js`) before being set as `innerHTML`. Markdown is parsed with `marked` then sanitized with a custom `sanitizeHtml()` function that strips `<script>`, `<iframe>`, `<object>`, `<embed>`, and `on*` event handler attributes.
- **XSS — backend:** The API returns JSON; the frontend is responsible for safe rendering.
- **Input validation middleware:** `backend/middleware/validate.js` provides reusable validators for common fields (title, notes, lat/lng, dates). Used on POST/PUT routes.

---

## Logging & Secret Redaction

- Backend logging goes through a single structured logger (`backend/utils/logger.js`, pino — #153). No bare `console.log` in runtime code.
- **Secrets are never logged.** The logger redacts `authorization`/`cookie` headers, `set-cookie`, and any `token` / `refresh_token` / `password` / `jwt` field centrally. Redaction is a deliberate, reviewable choice — do not log raw tokens, JWTs, password hashes, or the Outlook refresh token, and do not bypass the shared logger.
- Magic-link verification logs token *presence* and a diagnostic count breakdown, never the raw bearer token (see `/auth/email/verify`).
- Email addresses (PII) are masked via `redactEmail()` before logging; the admin-gate logs only lengths and a match boolean, never the raw address.
- Log level is controlled by `LOG_LEVEL` (default `info`); production emits JSON, non-production pretty-prints.

---

## Rate Limiting

The contact form (`POST /api/contact`) is rate-limited using the `rate_limits` table:
- DB-backed (survives process restarts)
- Window and limit thresholds are in code comments (not public for spam prevention)

See `backend/routes/contact.js` for implementation details.

Other routes have no rate limiting. This is a known trade-off for a low-traffic personal site.

---

## Known Trade-offs / Out of Scope

| Area | Trade-off |
|------|-----------|
| Rate limiting scope | Contact form and auth endpoints (`/auth/email/send`, passkey register/login) are rate-limited; other admin routes rely on JWT expiry |
| CSRF | Not implemented — admin actions use JWT Bearer tokens (not cookies by default), so standard CSRF attacks are not applicable |
| Email delivery | Outlook OAuth2 (Graph API) credentials in `.env`; if email is unavailable, magic links fail (fallback: use passkey) |
| Refresh token | Outlook refresh token in `.env` is long-lived; if leaked it allows sending mail as the admin until revoked in Azure |
| Passkey-only deployment | WebAuthn requires HTTPS in production and `localhost` in dev — other origins will fail |
| Single user | No multi-user, role-based access control, or public signup — intentional |

---

## Environment Variables (Security-relevant)

| Variable | Purpose |
|----------|---------|
| `JWT_SECRET` | Signs all JWTs. Must be a long random string. Server exits on startup if missing. |
| `JWT_EXPIRY` | Token lifetime, e.g. `7d` |
| `WEBAUTHN_RP_ID` | Relying Party ID — must match the domain exactly (`andykeys.me` in prod, `localhost` in dev) |
| `WEBAUTHN_ORIGIN` | Full origin — must match exactly (`https://andykeys.me` or `http://localhost`) |
| `OUTLOOK_CLIENT_ID/SECRET/REFRESH_TOKEN/EMAIL` | Outlook OAuth2 (Graph API) email sending — preferred method |
| `SMTP_HOST/PORT/USER/PASS` | SMTP fallback for non-Outlook providers — used only if `OUTLOOK_*` absent |
| `ADMIN_EMAIL` | The only address magic links are sent to |

Never commit `.env`. See `backend/.env.example` for the full list.
