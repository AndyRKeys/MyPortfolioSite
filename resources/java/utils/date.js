/**
 * Shared date-formatting utilities.
 * Extracted from script.js and blog.js to eliminate duplication.
 */

/**
 * Formats a visit date string (YYYY-MM-DD or ISO timestamp) to
 * a human-readable en-GB string, e.g. "4 May 2026".
 * Returns null if the input is falsy or unparseable.
 */
export function formatVisitDate(dateStr) {
    if (!dateStr) return null;
    var datePart = String(dateStr).slice(0, 10);
    var d = new Date(datePart + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Formats a post's date field to a human-readable en-GB string.
 * Handles both post_date (YYYY-MM-DD or ISO) and published_at fields.
 * Returns empty string if neither field is present.
 */
export function formatPostDate(post) {
    var rawDate = post.post_date
        ? String(post.post_date).slice(0, 10) + 'T00:00:00'
        : post.published_at;
    if (!rawDate) return '';
    return new Date(rawDate).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Returns a relative date string from an ISO timestamp,
 * e.g. "today", "yesterday", "3 days ago", "2 months ago", "1 year ago".
 */
export function formatRelativeDate(isoString) {
    var date = new Date(isoString);
    var now = new Date();
    var diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return 'today';
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 30) return diffDays + ' days ago';
    if (diffDays < 365) return Math.floor(diffDays / 30) + ' months ago';
    return Math.floor(diffDays / 365) + ' years ago';
}
