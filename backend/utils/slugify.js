/**
 * Shared slug generator.
 * Canonical rules:
 *  - trim whitespace
 *  - lowercase
 *  - strip anything that is not a-z, 0-9, space, or hyphen
 *  - collapse runs of spaces/hyphens to a single hyphen
 *  - truncate to 100 characters
 *  - fall back to `fallback` if result is empty
 *
 * @param {string} title
 * @param {string} [fallback='post']
 * @returns {string}
 */
export function slugify(title, fallback = 'post') {
  const slug = String(title)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return slug || fallback;
}

// Finds a slug not already taken by any post.
// Accepts pool or a transaction client — both expose .query().
// excludeId skips the row with that id (used when renaming an existing post).
export async function findUniqueSlug(db, baseSlug, { excludeId = null, maxAttempts = 100 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = i === 0 ? baseSlug : `${baseSlug}-${i}`;
    const { rows } = excludeId
      ? await db.query('SELECT 1 FROM posts WHERE slug = $1 AND id != $2 LIMIT 1', [candidate, excludeId])
      : await db.query('SELECT 1 FROM posts WHERE slug = $1 LIMIT 1', [candidate]);
    if (!rows.length) return candidate;
  }
  throw new Error(`Could not generate a unique slug for "${baseSlug}" after ${maxAttempts} attempts`);
}
