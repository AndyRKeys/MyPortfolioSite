-- 002_media_processing_columns.sql
-- Adds full_url, thumb_url, media_status to posts and post_media
-- for the background image/video optimisation pipeline (#174).
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS full_url    TEXT,
  ADD COLUMN IF NOT EXISTS thumb_url   TEXT,
  ADD COLUMN IF NOT EXISTS media_status TEXT;

ALTER TABLE post_media
  ADD COLUMN IF NOT EXISTS full_url    TEXT,
  ADD COLUMN IF NOT EXISTS thumb_url   TEXT,
  ADD COLUMN IF NOT EXISTS media_status TEXT;
