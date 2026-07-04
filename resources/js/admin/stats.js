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

    await loadMetrics();
}

async function loadMetrics() {
    const container = document.getElementById('metrics-list');
    if (!container) return;
    try {
        const res = await authFetch('/stats/metrics');
        if (!res.ok) throw new Error();
        const data = await res.json();

        if (!data.length) {
            container.innerHTML = '<p class="hint">No metrics yet — they accumulate as the site receives traffic.</p>';
            return;
        }

        const totals = data.reduce((acc, b) => ({
            s2xx:     acc.s2xx     + b.s2xx,
            s4xx:     acc.s4xx     + b.s4xx,
            s5xx:     acc.s5xx     + b.s5xx,
            requests: acc.requests + b.requests,
        }), { s2xx: 0, s4xx: 0, s5xx: 0, requests: 0 });

        const latest = [...data].reverse().find(b => b.requests > 0) || {};
        const p50  = latest.p50_ms != null ? latest.p50_ms + 'ms' : '—';
        const p95  = latest.p95_ms != null ? latest.p95_ms + 'ms' : '—';
        const windowMins = data.length;

        container.innerHTML = ''
            + '<div class="stat-row">'
            +   '<span class="stat-page">Last ' + windowMins + ' min</span>'
            +   '<span class="stat-count">' + totals.requests.toLocaleString() + ' req</span>'
            +   '<span class="stat-last">'
            +     escapeHtml(String(totals.s2xx)) + ' 2xx · '
            +     escapeHtml(String(totals.s4xx)) + ' 4xx · '
            +     escapeHtml(String(totals.s5xx)) + ' 5xx'
            +   '</span>'
            + '</div>'
            + '<div class="stat-row">'
            +   '<span class="stat-page">Latency (latest min)</span>'
            +   '<span class="stat-count">p50: ' + escapeHtml(p50) + '</span>'
            +   '<span class="stat-last">p95: ' + escapeHtml(p95) + '</span>'
            + '</div>';
    } catch {
        container.innerHTML = '<p class="hint" style="color:var(--color-error)">Failed to load metrics.</p>';
    }
}
