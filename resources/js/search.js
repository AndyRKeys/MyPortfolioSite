/**
 * Search page (#157)
 *
 * Calls GET /api/search?q=<term>&type=<all|blog|travel>&limit=20
 * and renders ranked results with highlighted matched terms.
 */
import { API_BASE }   from './config.js';
import { escapeHtml } from './utils/html.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Highlight occurrences of each word in `query` within `text`.
 * Returns safe HTML with <mark> elements around matches.
 */
function highlight(text, query) {
  if (!text || !query) return escapeHtml(text || '');
  const words   = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return escapeHtml(text);
  const pattern = new RegExp(`(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return escapeHtml(text).replace(
    // Work on the escaped string — escapeHtml has already made it safe,
    // so we re-apply the pattern to the escaped result.
    // Note: escapeHtml() replaces < > & " ' — query words should not match these.
    pattern,
    '<mark>$1</mark>'
  );
}

function typeLabel(postType) {
  return postType === 'travel' ? 'Travel' : 'Blog';
}

function postUrl(result) {
  if (result.post_type === 'travel') return `/travel/post/?id=${result.id}`;
  return `/blog/post/?slug=${result.slug}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderResults(data, query) {
  if (!data.results.length) {
    return `<p class="search-empty">No results for <strong>${escapeHtml(query)}</strong>.</p>`;
  }

  const grouped = { blog: [], travel: [] };
  data.results.forEach(r => grouped[r.post_type]?.push(r));

  let html = `<p class="search-summary">${data.total} result${data.total !== 1 ? 's' : ''} for <strong>${escapeHtml(query)}</strong></p>`;

  ['blog', 'travel'].forEach(type => {
    const items = grouped[type];
    if (!items.length) return;
    html += `<h3 class="search-group-heading">${typeLabel(type)}</h3><ul class="search-result-list">`;
    items.forEach(r => {
      const excerpt    = r.excerpt || '';
      const dateStr    = r.post_date || r.published_at;
      html += `<li class="search-result-item">
        <a href="${escapeHtml(postUrl(r))}" class="search-result-link">
          <span class="search-result-title">${highlight(r.title, query)}</span>
          <span class="search-result-meta">
            <span class="search-result-type ${r.post_type === 'travel' ? 'tag-travel' : 'tag-blog'}">${typeLabel(r.post_type)}</span>
            ${dateStr ? `<span class="search-result-date">${formatDate(dateStr)}</span>` : ''}
            ${r.location ? `<span class="search-result-location">${escapeHtml(r.location)}</span>` : ''}
          </span>
          ${excerpt ? `<p class="search-result-excerpt">${highlight(excerpt, query)}</p>` : ''}
        </a>
      </li>`;
    });
    html += '</ul>';
  });

  return html;
}

// ── Search ────────────────────────────────────────────────────────────────────

async function runSearch(query, type) {
  const resultsEl = document.getElementById('search-results');
  resultsEl.innerHTML = '<p class="hint">Searching…</p>';

  try {
    const qs  = new URLSearchParams({ q: query, limit: '20' });
    if (type && type !== 'all') qs.set('type', type);
    const res = await fetch(`${API_BASE}/search?${qs}`);

    if (res.status === 400) {
      resultsEl.innerHTML = '<p class="search-empty">Please enter a search term.</p>';
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    resultsEl.innerHTML = renderResults(data, query);
  } catch {
    resultsEl.innerHTML = '<p class="hint" style="color:var(--color-error)">Search failed. Please try again.</p>';
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

const form    = document.getElementById('search-form');
const input   = document.getElementById('search-input');
const results = document.getElementById('search-results');

// Pre-fill from URL query string if present (e.g. linked search)
const urlParams = new URLSearchParams(window.location.search);
const initialQ  = urlParams.get('q');
if (initialQ) {
  input.value = initialQ;
  const initialType = urlParams.get('type') || 'all';
  const radio = form.querySelector(`input[name="type"][value="${initialType}"]`);
  if (radio) radio.checked = true;
  runSearch(initialQ, initialType);
}

form?.addEventListener('submit', (e) => {
  e.preventDefault();
  const q    = input.value.trim();
  const type = form.querySelector('input[name="type"]:checked')?.value || 'all';
  if (!q) {
    results.innerHTML = '<p class="search-empty">Please enter a search term.</p>';
    return;
  }
  // Update URL without reload for shareable links
  const url = new URL(window.location);
  url.searchParams.set('q', q);
  url.searchParams.set('type', type);
  window.history.pushState({}, '', url);
  runSearch(q, type);
});
