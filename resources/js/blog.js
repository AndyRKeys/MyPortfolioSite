import { API_BASE } from './config.js';
import { formatPostDate } from './utils/date.js';
import { buildPostCard, buildTimelineItem } from './utils/dom.js';
import { escapeHtml, highlight } from './utils/html.js';
import { recordVisit } from './utils/stats.js';

function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len).trimEnd() + '…' : str;
}

function buildBlogPostCard(post) {
    return buildPostCard({
        slug: post.slug,
        title: post.title,
        date: formatPostDate(post),
        excerpt: post.excerpt ? truncate(post.excerpt, 150) : null,
    });
}

// ── Blog view toggle ──────────────────────────────────────────────────────────

function applyBlogView(view) {
    var postsList = document.getElementById('posts-list');
    var blogTimeline = document.getElementById('blog-timeline');
    if (!postsList || !blogTimeline) return;
    if (view === 'timeline') {
        postsList.classList.add('hidden');
        blogTimeline.classList.remove('hidden');
    } else {
        postsList.classList.remove('hidden');
        blogTimeline.classList.add('hidden');
    }
}

function initBlogViewToggle() {
    var activeBtn = document.querySelector('.blog-view-toggle .view-toggle-btn.active');
    var activeView = (activeBtn && activeBtn.dataset.view) || 'timeline';
    applyBlogView(activeView);

    document.querySelectorAll('.blog-view-toggle .view-toggle-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            document.querySelectorAll('.blog-view-toggle .view-toggle-btn').forEach(function (b) {
                b.classList.remove('active');
                b.setAttribute('aria-selected', 'false');
            });
            btn.classList.add('active');
            btn.setAttribute('aria-selected', 'true');
            applyBlogView(btn.dataset.view);
        });
    });
}

function loadPosts() {
    var activeBtn = document.querySelector('.blog-view-toggle .view-toggle-btn.active');
    var activeView = (activeBtn && activeBtn.dataset.view) || 'timeline';
    applyBlogView(activeView);

    fetch(API_BASE + '/posts')
        .then(function (res) { return res.json(); })
        .then(function (posts) {
            var list = document.getElementById('posts-list');
            list.innerHTML = '';

            if (!posts.length) {
                document.getElementById('posts-empty').classList.remove('hidden');
                list.classList.add('hidden');
                var toggle = document.querySelector('.blog-view-toggle');
                if (toggle) toggle.classList.add('hidden');
                return;
            }

            posts.forEach(function (post) { list.append(buildBlogPostCard(post)); });

            var sorted = posts.slice().sort(function (a, b) {
                var da = a.post_date ? String(a.post_date).slice(0, 10) : (a.published_at ? a.published_at.slice(0, 10) : '');
                var db = b.post_date ? String(b.post_date).slice(0, 10) : (b.published_at ? b.published_at.slice(0, 10) : '');
                return db < da ? -1 : db > da ? 1 : 0;
            });
            var timelineEl = document.getElementById('blog-timeline');
            sorted.forEach(function (post) {
                timelineEl.append(buildTimelineItem({
                    dateStr: formatPostDate(post),
                    title: post.title,
                    notes: post.excerpt ? truncate(post.excerpt, 200) : null,
                    linkHref: '/blog/post/?slug=' + encodeURIComponent(post.slug),
                }));
            });

            // Cards and timeline must both be populated before toggle is wired.
            initBlogViewToggle();
        })
        .catch(function (err) {
            console.error('loadPosts failed:', err && (err.message || String(err)), err && err.stack);
            document.getElementById('posts-list').innerHTML = '<p class="hint" style="color:var(--color-error)">Could not load posts.</p>';
        });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

recordVisit('blog');

loadPosts();

// ── Embedded listing search (#469) ────────────────────────────────────────────

(function initListingSearch() {
    var form    = document.getElementById('listing-search-form');
    var input   = document.getElementById('listing-search-input');
    var results = document.getElementById('listing-search-results');
    var list    = document.getElementById('posts-list');
    var timeline = document.getElementById('blog-timeline');
    var toggle  = document.querySelector('.blog-view-toggle');

    if (!form || !input || !results) return;

    function setListingHidden(hidden) {
        // Don't unhide #posts-list directly — its visibility is owned by the
        // view toggle (Cards vs Timeline). We hide both containers when
        // searching, then defer to applyBlogView() via the toggle when clearing.
        if (timeline) timeline.classList.toggle('hidden', hidden);
        if (list)     list.classList.toggle('hidden', hidden);
        if (toggle)   toggle.classList.toggle('hidden', hidden);
    }

    function restoreListing() {
        // Re-apply the toggle's active view so the right container is shown.
        if (toggle) toggle.classList.remove('hidden');
        var activeBtn = document.querySelector('.blog-view-toggle .view-toggle-btn.active');
        var activeView = (activeBtn && activeBtn.dataset.view) || 'timeline';
        if (activeView === 'timeline') {
            if (list)     list.classList.add('hidden');
            if (timeline) timeline.classList.remove('hidden');
        } else {
            if (list)     list.classList.remove('hidden');
            if (timeline) timeline.classList.add('hidden');
        }
    }

    var urlQ = new URLSearchParams(window.location.search).get('q') || '';
    if (urlQ) { input.value = urlQ; runSearch(urlQ); }

    form.addEventListener('submit', function (e) {
        e.preventDefault();
        var q   = input.value.trim();
        var url = new URL(window.location.href);
        if (q) url.searchParams.set('q', q); else url.searchParams.delete('q');
        history.replaceState(null, '', url);
        runSearch(q);
    });

    input.addEventListener('input', function () {
        if (!input.value.trim()) runSearch('');
    });

    async function runSearch(q) {
        if (!q) {
            results.hidden = true;
            results.innerHTML = '';
            restoreListing();
            return;
        }
        setListingHidden(true);
        results.hidden = false;
        results.innerHTML = '<p class="hint">Searching…</p>';
        try {
            var res  = await fetch(API_BASE + '/search?q=' + encodeURIComponent(q) + '&type=blog&limit=20');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var data = await res.json();
            if (!data.results || !data.results.length) {
                results.innerHTML = '<p class="search-empty">No posts found.</p>';
                return;
            }
            results.innerHTML = '<ul class="search-result-list">' + data.results.map(function (r) {
                var href    = '/blog/post/?slug=' + encodeURIComponent(r.slug || '');
                var dateStr = r.post_date || r.published_at || '';
                return '<li class="search-result-item">' +
                    '<a href="' + escapeHtml(href) + '" class="search-result-link">' +
                        '<span class="search-result-title">' + highlight(r.title, q) + '</span>' +
                        (r.excerpt ? '<p class="search-result-excerpt">' + highlight(r.excerpt, q) + '</p>' : '') +
                        '<span class="search-result-meta">' + escapeHtml(formatPostDate({ post_date: dateStr }) || '') + '</span>' +
                    '</a>' +
                '</li>';
            }).join('') + '</ul>';
        } catch (err) {
            console.error('[blog-search] failed:', err && (err.message || String(err)));
            results.innerHTML = '<p class="search-empty">Search failed — please try again.</p>';
        }
    }
})();
