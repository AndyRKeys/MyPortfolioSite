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
