var API_BASE = API_BASE || '/api';

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len).trimEnd() + '\u2026' : str;
}

function formatPostDate(post) {
    var rawDate = post.post_date ? post.post_date + 'T00:00:00' : post.published_at;
    if (!rawDate) return '';
    return new Date(rawDate).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
}

function buildPostCard(post) {
    // Delegate to the shared buildPostCard helper in script.js (window.buildPostCard)
    // so blog and travel cards share the same structure and cannot drift apart.
    return window.buildPostCard('blog', {
        slug:    post.slug,
        title:   post.title,
        date:    formatPostDate(post),
        excerpt: post.excerpt ? truncate(post.excerpt, 150) : null,
    });
}

// ── Blog view toggle ───────────────────────────────────────────────────────────

function applyBlogView(view) {
    if (view === 'timeline') {
        $('#posts-list').addClass('hidden');
        $('#blog-timeline').removeClass('hidden');
    } else {
        $('#posts-list').removeClass('hidden');
        $('#blog-timeline').addClass('hidden');
    }
}

function initBlogViewToggle() {
    // Scoped to .blog-view-toggle to avoid colliding with .travel-view-toggle
    // when both script.js and blog.js are loaded on blog.html.
    // Cards and timeline must both be populated before this is called.
    var activeView = $('.blog-view-toggle .view-toggle-btn.active').data('view') || 'timeline';
    applyBlogView(activeView);

    $('.blog-view-toggle .view-toggle-btn').on('click', function () {
        var view = $(this).data('view');
        $('.blog-view-toggle .view-toggle-btn').removeClass('active').attr('aria-selected', 'false');
        $(this).addClass('active').attr('aria-selected', 'true');
        applyBlogView(view);
    });
}

function loadPosts() {
    // Enforce the active view immediately so containers are correctly
    // hidden/shown from the very start of the load — before any data arrives.
    var activeView = $('.blog-view-toggle .view-toggle-btn.active').data('view') || 'timeline';
    applyBlogView(activeView);

    fetch(API_BASE + '/posts')
        .then(function (res) { return res.json(); })
        .then(function (posts) {
            var list = $('#posts-list');
            list.empty();

            if (!posts.length) {
                $('#posts-empty').removeClass('hidden');
                list.addClass('hidden');
                $('.blog-view-toggle').addClass('hidden');
                return;
            }

            // Cards view
            posts.forEach(function (post) { list.append(buildPostCard(post)); });

            // Timeline view — sorted descending by post_date / published_at
            var sorted = posts.slice().sort(function (a, b) {
                var da = a.post_date || (a.published_at ? a.published_at.slice(0, 10) : '');
                var db = b.post_date || (b.published_at ? b.published_at.slice(0, 10) : '');
                return db < da ? -1 : db > da ? 1 : 0;
            });
            var timelineEl = $('#blog-timeline');
            sorted.forEach(function (post) {
                // buildTimelineItem is defined in script.js and exposed on window
                timelineEl.append(window.buildTimelineItem({
                    dateStr:  formatPostDate(post),
                    title:    post.title,
                    notes:    post.excerpt ? truncate(post.excerpt, 200) : null,
                    linkHref: 'blog-post.html?slug=' + encodeURIComponent(post.slug),
                }));
            });

            // Wire toggle buttons — cards and timeline must both be populated first.
            initBlogViewToggle();
        })
        .catch(function () {
            $('#posts-list').html('<p class="hint" style="color:var(--color-error)">Could not load posts.</p>');
        });
}

$(document).ready(function () {
    loadPosts();
});
