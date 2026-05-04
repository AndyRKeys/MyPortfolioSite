/**
 * Minimal HTML-escaping for use in server-generated HTML strings (e.g. email bodies).
 * Escapes &, <, >, " and ' to their HTML entity equivalents.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
