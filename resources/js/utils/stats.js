import { API_BASE } from '../config.js';
import { isAdminSession } from '../auth-utils.js';

// Returns the fetch Promise (so callers can chain .then for response data),
// or undefined when the session is admin (visit should not be counted).
export function recordVisit(page) {
    if (isAdminSession()) return;
    return fetch(API_BASE + '/stats/visit?page=' + encodeURIComponent(page), { method: 'POST' })
        .catch(function () {});
}
