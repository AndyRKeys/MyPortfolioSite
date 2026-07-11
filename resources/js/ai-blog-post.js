import { API_BASE } from './config.js';
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.4.7/dist/purify.es.mjs';

function getSlug() {
    const params = new URLSearchParams(window.location.search);
    return params.get('slug');
}

async function loadEntry() {
    const slug = getSlug();
    if (!slug) {
        showError();
        return;
    }

    try {
        const res = await fetch(API_BASE + '/ai-blog/' + encodeURIComponent(slug));
        if (!res.ok) throw new Error('not found');
        const entry = await res.json();

        document.title = entry.title + ' | AI Dev Blog | AK Portfolio';
        document.getElementById('post-header-title').textContent = entry.title;
        document.getElementById('post-title').textContent = entry.title;

        const rawDate = entry.post_date
            ? String(entry.post_date).slice(0, 10) + 'T00:00:00'
            : entry.published_at;
        const dateObj = rawDate ? new Date(rawDate) : null;
        document.getElementById('post-date').textContent =
            (dateObj && !isNaN(dateObj))
                ? dateObj.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
                : '';

        const md = entry.body_markdown || '';
        const html = await Promise.resolve(marked.parse(md));
        document.getElementById('post-markdown').innerHTML = DOMPurify.sanitize(html);

        document.getElementById('post-loading').classList.add('hidden');
        document.getElementById('post-body').classList.remove('hidden');
    } catch {
        showError();
    }
}

function showError() {
    document.getElementById('post-loading').classList.add('hidden');
    document.getElementById('post-error').classList.remove('hidden');
}

// Modules are deferred by default — DOM is ready when this executes.
loadEntry();
