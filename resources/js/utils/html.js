/**
 * Shared HTML escaping utility.
 * Escapes &, <, >, ", and ' to prevent XSS in any context
 * where strings are interpolated into HTML.
 */
export function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
