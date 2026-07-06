import { API_BASE } from './config.js';
import { formatPostDate } from './utils/date.js';
import { buildTimelineItem } from './utils/dom.js';
import { recordVisit } from './utils/stats.js';

function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len).trimEnd() + '…' : str;
}

async function loadEntries() {
    try {
        const res = await fetch(API_BASE + '/ai-blog');
        const entries = await res.json();

        const timelineEl = document.getElementById('ai-blog-timeline');
        const emptyEl    = document.getElementById('ai-blog-empty');

        if (!entries.length) {
            emptyEl.classList.remove('hidden');
            return;
        }

        entries.forEach(function (entry) {
            timelineEl.append(buildTimelineItem({
                dateStr:  formatPostDate(entry),
                title:    entry.title,
                notes:    entry.excerpt ? truncate(entry.excerpt, 200) : null,
                linkHref: '/ai-blog/post/?slug=' + encodeURIComponent(entry.slug),
            }));
        });
    } catch (err) {
        console.error('[ai-blog] loadEntries failed:', err && (err.message || String(err)));
        const timelineEl = document.getElementById('ai-blog-timeline');
        timelineEl.innerHTML = '<p class="hint" style="color:var(--color-error)">Could not load entries.</p>';
    }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

recordVisit('ai-blog');

loadEntries();
