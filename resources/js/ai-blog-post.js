import { API_BASE } from './config.js';
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.4.7/dist/purify.es.mjs';

function getSlug() {
    var params = new URLSearchParams(window.location.search);
    return params.get('slug');
}

function loadEntry() {
    var slug = getSlug();
    if (!slug) {
        showError();
        return;
    }

    fetch(API_BASE + '/ai-blog/' + encodeURIComponent(slug))
        .then(function (res) {
            if (!res.ok) throw new Error('not found');
            return res.json();
        })
        .then(function (entry) {
            document.title = entry.title + ' | AI Dev Blog | AK Portfolio';
            document.getElementById('post-header-title').textContent = entry.title;
            document.getElementById('post-title').textContent = entry.title;

            var rawDate = entry.post_date
                ? String(entry.post_date).slice(0, 10) + 'T00:00:00'
                : entry.published_at;
            var dateObj = rawDate ? new Date(rawDate) : null;
            document.getElementById('post-date').textContent =
                (dateObj && !isNaN(dateObj))
                    ? dateObj.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
                    : '';

            var md = entry.body_markdown || '';
            var result = marked.parse(md);
            Promise.resolve(result).then(function (html) {
                document.getElementById('post-markdown').innerHTML = DOMPurify.sanitize(html);
            });

            document.getElementById('post-loading').classList.add('hidden');
            document.getElementById('post-body').classList.remove('hidden');
        })
        .catch(function () { showError(); });
}

function showError() {
    document.getElementById('post-loading').classList.add('hidden');
    document.getElementById('post-error').classList.remove('hidden');
}

// Modules are deferred by default — DOM is ready when this executes.
loadEntry();
