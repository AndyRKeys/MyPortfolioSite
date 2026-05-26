import { authFetch } from './auth.js';
import { escapeHtml } from '../utils/html.js';

export async function initStats() {
    const list = document.getElementById('stats-list');
    if (!list) return;
    try {
        const res = await authFetch('/stats/visits');
        if (!res.ok) throw new Error();
        const rows = await res.json();
        if (!rows.length) {
            list.innerHTML = '<p class="hint">No visits recorded yet.</p>';
            return;
        }
        list.innerHTML = rows.map(r => {
            const last = r.last_visited_at
                ? new Date(r.last_visited_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
                : '—';
            return '<div class="stat-row">'
                + '<span class="stat-page">' + escapeHtml(r.page) + '</span>'
                + '<span class="stat-count">' + Number(r.count).toLocaleString() + '</span>'
                + '<span class="stat-last">last: ' + last + '</span>'
                + '</div>';
        }).join('');
    } catch {
        list.innerHTML = '<p class="hint" style="color:var(--color-error)">Failed to load stats.</p>';
    }
}
