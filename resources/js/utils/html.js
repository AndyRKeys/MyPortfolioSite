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

/**
 * Highlight occurrences of each word in `query` within `text`.
 * Returns safe HTML with <mark> elements around matches.
 *
 * Used by both the standalone /search/ page and the embedded search
 * forms on /blog/ and /travel/ listing pages (#469).
 */
export function highlight(text, query) {
    if (!text || !query) return escapeHtml(text || '');
    const words   = query.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return escapeHtml(text);
    const pattern = new RegExp(
        `(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
        'gi'
    );
    return escapeHtml(text).replace(pattern, '<mark>$1</mark>');
}
