# Database Reference

PostgreSQL schema for andykeys.me. All migrations are idempotent — safe to re-run on an existing database.

---

## Migration System (#169)

Schema changes are managed by a lightweight migration runner (`backend/db/migrate.js`) — no external packages required.

**How it works:**

- On every server boot, `runMigrations(pool)` runs before `app.listen()`.
- It creates a `schema_migrations` table (if absent) to track applied migrations.
- Numbered `*.sql` files in `backend/db/migrations/` are applied in order; already-recorded files are skipped.
- Each migration runs inside a transaction — a failure rolls back and terminates the boot with a fatal log and `exit(1)`.

**Adding a new migration:**

1. Create `backend/db/migrations/<NNN>_short_description.sql` (e.g. `002_add_notes_table.sql`).
2. Write idempotent SQL (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, etc.).
3. Deploy — the runner picks it up automatically on the next boot.

**Reference files:**

- `backend/db/schema.sql` — canonical schema reference (full picture; not applied at runtime).
- `backend/db/migrations/001_initial_schema.sql` — baseline migration (all tables as of #169).
- `backend/db/migrate.js` — migration runner; call `runMigrations(pool)` on startup.
- `backend/tests/utils/migrate.test.js` — Vitest suite for the runner.

---

## Conventions

- **Primary keys:** UUID, generated with `gen_random_uuid()` (requires `pgcrypto` extension)
- **Timestamps:** `TIMESTAMPTZ` (timezone-aware), defaulting to `NOW()`
- **Column naming:** `snake_case` throughout
- **Migrations:** numbered SQL files in `backend/db/migrations/`; tracked in `schema_migrations` table
- **Slugs:** `VARCHAR(255) UNIQUE NOT NULL` — uniqueness enforced at DB level; application retries with `-N` suffix on conflict

---

## Tables

### `users`

Single admin user. The site is single-user by design.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID PK` | `gen_random_uuid()` |
| `email` | `VARCHAR(255) UNIQUE NOT NULL` | Admin email, used for magic links |
| `username` | `VARCHAR(100) UNIQUE NOT NULL` | Display name |
| `created_at` | `TIMESTAMPTZ` | |

---

### `passkeys`

WebAuthn/FIDO2 passkey credentials registered to the admin user.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID PK` | |
| `user_id` | `UUID FK → users(id)` | `ON DELETE CASCADE` |
| `credential_id` | `TEXT UNIQUE NOT NULL` | Base64url-encoded WebAuthn credential ID |
| `public_key` | `TEXT NOT NULL` | COSE-encoded public key |
| `counter` | `BIGINT DEFAULT 0` | Signature counter, incremented on each use |
| `device_type` | `VARCHAR(32)` | e.g. `singleDevice`, `multiDevice` |
| `backed_up` | `BOOLEAN DEFAULT FALSE` | Whether credential is backed up to cloud |
| `transports` | `TEXT[]` | e.g. `{internal,hybrid}` |
| `name` | `VARCHAR(100) DEFAULT 'My passkey'` | User-visible label |
| `created_at` | `TIMESTAMPTZ` | |

---

### `email_tokens`

Short-lived tokens for email magic-link authentication.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID PK` | |
| `user_id` | `UUID FK → users(id)` | `ON DELETE CASCADE` |
| `token` | `VARCHAR(255) UNIQUE NOT NULL` | Bcrypt hash of the secure random token (stored via `crypt(raw_token, gen_salt('bf'))`); the raw token is sent in the email link only — see `docs/SECURITY.md` (#134) |
| `expires_at` | `TIMESTAMPTZ NOT NULL` | Checked on use; expired tokens are rejected |
| `used` | `BOOLEAN DEFAULT FALSE` | Tokens are single-use |
| `created_at` | `TIMESTAMPTZ` | |

---

### `webauthn_challenges`

Ephemeral WebAuthn challenges. Created during registration/authentication, consumed on completion.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID PK` | |
| `session_key` | `TEXT UNIQUE NOT NULL` | Session identifier linking challenge to browser session |
| `challenge` | `TEXT NOT NULL` | Base64url-encoded challenge bytes |
| `user_id` | `UUID FK → users(id)` | Nullable — null during registration before user is known |
| `expires_at` | `TIMESTAMPTZ NOT NULL` | Short-lived (typically 5 minutes) |
| `created_at` | `TIMESTAMPTZ` | |

---

### `posts`

Unified table for both blog posts and travel memories. Discriminated by `post_type`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID PK` | |
| `post_type` | `VARCHAR(20) NOT NULL DEFAULT 'blog'` | `'blog'` or `'travel'` |
| `title` | `VARCHAR(255) NOT NULL` | |
| `slug` | `VARCHAR(255) UNIQUE NOT NULL` | URL-safe, kebab-case, max 90 chars; generated from title |
| `body_markdown` | `TEXT NOT NULL DEFAULT ''` | Blog content (markdown) or travel notes (plain text) |
| `post_date` | `DATE` | Blog: display date. Travel: visit date |
| `location` | `VARCHAR(255)` | Travel only |
| `media_url` | `TEXT` | Synced to first `post_media` row (denormalised for convenience) |
| `media_type` | `VARCHAR(100)` | MIME type of `media_url` |
| `lat` | `DECIMAL(9,6)` | Travel only — 6dp precision |
| `lng` | `DECIMAL(9,6)` | Travel only |
| `location_estimated` | `BOOLEAN DEFAULT FALSE` | Travel only — shows `~` prefix in UI when true |
| `published_at` | `TIMESTAMPTZ` | `NULL` = draft. Set to `NOW()` to publish |
| `created_at` | `TIMESTAMPTZ` | |
| `updated_at` | `TIMESTAMPTZ` | Updated on every edit |

**Slug generation:** `slugify(title)` → lowercase, strip non-alphanumeric, collapse spaces to `-`, truncate at 90 chars. On UNIQUE conflict, retry with `-1`, `-2` … `-100`.

**Draft vs published:** `published_at IS NULL` = draft (hidden from public routes). Public API routes add `AND published_at IS NOT NULL` to all queries.

**Migration note — search_vector column:** Adding a `GENERATED ALWAYS AS ... STORED` column rewrites
every existing row under an `ACCESS EXCLUSIVE` lock. On first deploy to a populated database this
is automatic (schema.sql uses `ADD COLUMN IF NOT EXISTS`) but takes a moment proportional to post
count. The site has few posts so this completes in milliseconds; no manual step is needed.

---

### `post_media`

One-to-many media items for posts. Travel posts may have multiple photos/videos.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID PK` | |
| `post_id` | `UUID FK → posts(id)` | `ON DELETE CASCADE` — deleting a post removes all media |
| `media_url` | `TEXT NOT NULL` | |
| `media_type` | `VARCHAR(100)` | MIME type (e.g. `image/jpeg`, `video/mp4`) |
| `order_index` | `INTEGER NOT NULL DEFAULT 0` | Display order; lower = first |
| `created_at` | `TIMESTAMPTZ` | |

**Sync:** `posts.media_url` and `posts.media_type` are kept in sync with the first `post_media` row (ordered by `order_index`, then `created_at`). This denormalisation supports older API consumers.

---

### `page_visits`

Simple visit counter per page. One row per page slug; the row is upserted on each visit.

| Column | Type | Notes |
|--------|------|-------|
| `page` | `VARCHAR(100) PK` | Page identifier, e.g. `'blog'`, `'travel'` |
| `count` | `BIGINT NOT NULL DEFAULT 0` | Incremented on each non-admin visit |
| `last_visited_at` | `TIMESTAMPTZ` | Updated on each increment |

---

### `rate_limits`

DB-backed rate limiting for the contact form. One row per IP address.

| Column | Type | Notes |
|--------|------|-------|
| `ip` | `VARCHAR(45) PK` | IPv4 or IPv6 address |
| `count` | `INTEGER NOT NULL DEFAULT 1` | Requests in the current window |
| `window_start` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | Start of the current rate-limit window |

**Logic:** On each request, check if `window_start + window_duration > NOW()`. If yes and `count >= limit`, reject. If the window has expired, reset `count = 1` and `window_start = NOW()`. Otherwise increment `count`.

---

## Indexes

| Index | Table | Columns | Purpose |
|-------|-------|---------|---------|
| *(implicit UNIQUE)* | `posts` | `slug` | Slug uniqueness |
| `idx_posts_post_type` | `posts` | `post_type` | Filter by type |
| `idx_posts_published_at` | `posts` | `published_at DESC NULLS LAST` | Sort/filter published |
| `idx_posts_post_date` | `posts` | `post_date DESC NULLS LAST` | Sort by display date |
| `idx_posts_created_at` | `posts` | `created_at DESC` | Sort by creation |
| `idx_posts_type_published_date` | `posts` | `(post_type, published_at DESC, post_date DESC)` | Primary public list query |
| `idx_post_media_post_id` | `post_media` | `post_id` | Media lookups by post |
| `posts_search_vector_idx` | `posts` | `search_vector` (GIN) | Full-text search (#157) |
| `audit_log_created_at` | `audit_log` | `created_at DESC` | Recent-first audit queries (#154) |
| `audit_log_user_id` | `audit_log` | `user_id` | Audit queries by user (#154) |
| `cvs_one_current` | `cvs` | `is_current` WHERE true (partial unique) | Enforce one current CV (#109) |

---

## Tables (continued)

### `audit_log`

Records admin actions with user, timestamp, action type, and structured context. Powers the admin activity dashboard (#155). Sensitive fields (tokens, passwords, hashes) are never stored in `detail`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID PK` | |
| `user_id` | `UUID FK → users(id)` | `ON DELETE SET NULL` — preserved if user deleted |
| `action` | `TEXT NOT NULL` | Dot-namespaced, e.g. `post.publish`, `auth.login`, `deploy.start` |
| `entity_type` | `TEXT` | e.g. `post`, `travel`, `cv`, `deploy` |
| `entity_id` | `TEXT` | ID of the affected record |
| `detail` | `JSONB` | Structured context (title, method, sha, env). Never secrets. |
| `ip` | `TEXT` | Client IP from `x-forwarded-for` or socket |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | |

**API:** `GET /api/audit?limit=50&type=<prefix|all>` — auth required.

---

### `cvs`

Tracks every uploaded CV version with a timestamp. Only one row may have `is_current = TRUE` at a time (partial unique index). The public download endpoint always serves the current version. Older versions are kept for archival; uploads beyond 5 prune the oldest automatically (#109).

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID PK` | |
| `filename` | `TEXT NOT NULL` | Stored filename, e.g. `cv-20260604-120000.pdf` |
| `uploaded_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | |
| `is_current` | `BOOLEAN NOT NULL DEFAULT FALSE` | Only one row may be TRUE (partial unique index) |

**Endpoints:**
- `GET /api/cv` — public download (serves current)
- `GET /api/cv/exists` — public, returns `{ exists: bool }`
- `GET /api/cv/history` — auth, lists all versions
- `PUT /api/cv/:id/set-current` — auth, promotes a version
- `DELETE /api/cv/:id` — auth, removes a non-current version

---

## Migration Strategy

All schema changes use `IF NOT EXISTS` / `IF EXISTS` guards so the schema file can be re-run safely against an existing database:

- New tables: `CREATE TABLE IF NOT EXISTS`
- New columns: `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
- New indexes: `CREATE INDEX IF NOT EXISTS`
- Conditional data migrations: wrapped in `DO $$ BEGIN IF EXISTS … END $$`

**Never** use destructive DDL (`DROP TABLE`, `DROP COLUMN`, `TRUNCATE`) outside of a guarded migration block.
