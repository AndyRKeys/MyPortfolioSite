import { API_BASE } from './config.js';
import { formatPostDate } from './utils/date.js';
import { buildPostCard, buildTimelineItem } from './utils/dom.js';

function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len).trimEnd() + '…' : str;
}

function buildBlogPostCard(post) {
    return buildPostCard('blog', {
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

// Fire-and-forget visit counter — swallow errors so stats never break the page
fetch(API_BASE + '/stats/visit?page=blog', { method: 'POST' }).catch(function () {});

loadPosts();
