CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  username VARCHAR(100) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS passkeys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT UNIQUE NOT NULL,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  device_type VARCHAR(32),
  backed_up BOOLEAN DEFAULT FALSE,
  transports TEXT[],
  name VARCHAR(100) DEFAULT 'My passkey',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL, -- bcrypt hash via crypt(raw_token, gen_salt('bf')); raw token sent in email link only (#134)
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- One-time, idempotent cleanup: purge legacy plaintext tokens left over from
-- before #134. Any non-bcrypt row (token not starting with '$2') is a stale
-- pre-hash token — already useless for login — and would make crypt() raise
-- "invalid salt" during verification. Safe to run on every boot.
DELETE FROM email_tokens WHERE token NOT LIKE '$2%';

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key TEXT UNIQUE NOT NULL,
  challenge TEXT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Unified posts table — covers both blog posts and travel memories.
-- post_type: 'blog' | 'travel'
-- post_date: display/visit date (travel uses this as visit date, blog as display date)
-- location, media_url, media_type, lat, lng, location_estimated: travel-specific (optional for blog)
-- published_at NULL = draft for both types
CREATE TABLE IF NOT EXISTS posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_type VARCHAR(20) NOT NULL DEFAULT 'blog',
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  body_markdown TEXT NOT NULL DEFAULT '',
  post_date DATE,
  location VARCHAR(255),
  media_url TEXT,
  media_type VARCHAR(100),
  lat DECIMAL(9,6),
  lng DECIMAL(9,6),
  location_estimated BOOLEAN DEFAULT FALSE,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Migrations: add unified fields to existing posts tables
ALTER TABLE posts ADD COLUMN IF NOT EXISTS post_type VARCHAR(20) NOT NULL DEFAULT 'blog';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS post_date DATE;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS location VARCHAR(255);
ALTER TABLE posts ADD COLUMN IF NOT EXISTS media_url TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS media_type VARCHAR(100);
ALTER TABLE posts ADD COLUMN IF NOT EXISTS lat DECIMAL(9,6);
ALTER TABLE posts ADD COLUMN IF NOT EXISTS lng DECIMAL(9,6);
ALTER TABLE posts ADD COLUMN IF NOT EXISTS location_estimated BOOLEAN DEFAULT FALSE;

-- Migrate travel_memories into posts (idempotent: only runs if table still exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'travel_memories'
  ) THEN
    INSERT INTO posts (
      post_type, title, slug, body_markdown, post_date, published_at,
      location, media_url, media_type, lat, lng, created_at, updated_at
    )
    SELECT
      'travel',
      title,
      lower(
        regexp_replace(
          regexp_replace(
            regexp_replace(trim(title), '[^a-zA-Z0-9\s-]', '', 'g'),
            '\s+', '-', 'g'
          ),
          '-+', '-', 'g'
        )
      ) || '-' || substr(id::text, 1, 8),
      COALESCE(notes, ''),
      visit_date,
      created_at,
      location,
      media_url,
      media_type,
      lat,
      lng,
      created_at,
      created_at
    FROM travel_memories
    ON CONFLICT (slug) DO NOTHING;

    DROP TABLE travel_memories;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS page_visits (
  page VARCHAR(100) PRIMARY KEY,
  count BIGINT NOT NULL DEFAULT 0,
  last_visited_at TIMESTAMPTZ DEFAULT NOW()
);

-- One-to-many media for travel posts (#30)
CREATE TABLE IF NOT EXISTS post_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  media_url TEXT NOT NULL,
  media_type VARCHAR(100),
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Migrate existing single-media travel posts into post_media (idempotent)
INSERT INTO post_media (post_id, media_url, media_type, order_index)
SELECT id, media_url, media_type, 0
FROM posts
WHERE post_type = 'travel'
  AND media_url IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM post_media pm WHERE pm.post_id = posts.id
  );

-- DB-backed rate limiting for contact form (#79)
-- One row per IP; window_start resets when the window expires.
CREATE TABLE IF NOT EXISTS rate_limits (
  ip VARCHAR(45) NOT NULL,
  key_type VARCHAR(64) NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ip, key_type)
);

-- Idempotent migration: add key_type to existing single-column PK installs (#445)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'rate_limits' AND column_name = 'key_type'
  ) THEN
    ALTER TABLE rate_limits ADD COLUMN key_type VARCHAR(64) NOT NULL DEFAULT 'legacy';
    ALTER TABLE rate_limits DROP CONSTRAINT rate_limits_pkey;
    ALTER TABLE rate_limits ADD PRIMARY KEY (ip, key_type);
  END IF;
END $$;

-- ── Indexes on hot query columns (#79) ───────────────────────────────────────
-- slug is already covered by the UNIQUE constraint (implicit index).
-- These cover the ORDER BY / WHERE clauses used by the public and admin list routes.

CREATE INDEX IF NOT EXISTS idx_posts_post_type
  ON posts (post_type);

CREATE INDEX IF NOT EXISTS idx_posts_published_at
  ON posts (published_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_posts_post_date
  ON posts (post_date DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_posts_created_at
  ON posts (created_at DESC);

-- Composite index for the most common public query pattern:
-- WHERE post_type = ? AND published_at IS NOT NULL ORDER BY post_date DESC
CREATE INDEX IF NOT EXISTS idx_posts_type_published_date
  ON posts (post_type, published_at DESC NULLS LAST, post_date DESC NULLS LAST);

-- post_media is always queried by post_id
CREATE INDEX IF NOT EXISTS idx_post_media_post_id
  ON post_media (post_id);

-- ── Client error persistence (#333) ──────────────────────────────────────────
-- Stores frontend error reports forwarded by error-logger.js via /debug/errors.
-- Retention is bounded: a cron prune in deploy-lib.sh removes rows older than
-- 30 days; the table never grows without limit.
CREATE TABLE IF NOT EXISTS client_errors (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  type        VARCHAR(50) NOT NULL,
  message     TEXT        NOT NULL,
  url         TEXT,
  filename    TEXT,
  lineno      INTEGER,
  colno       INTEGER,
  stack       TEXT,
  session_id  UUID,
  request_id  UUID,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_errors_received_at
  ON client_errors (received_at DESC);
