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
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

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
