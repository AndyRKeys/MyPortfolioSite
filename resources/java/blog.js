// API base — always /api, nginx strips prefix before forwarding to backend
var API_BASE = '/api';

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len).trimEnd() + '…' : str;
}

function formatPostDate(post) {
    var rawDate = post.post_date ? post.post_date + 'T00:00:00' : post.published_at;
    if (!rawDate) return '';
    return new Date(rawDate).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
}

function buildPostCard(post) {
    var card = $('<a class="post-card"></a>');
    card.attr('href', 'blog-post.html?slug=' + encodeURIComponent(post.slug));
    var date = formatPostDate(post);
    card.append('<h3 class="post-card-title">' + escapeHtml(post.title) + '</h3>');
    card.append('<p class="post-card-date">' + escapeHtml(date) + '</p>');
    if (post.excerpt) {
        card.append('<p class="post-card-excerpt">' + escapeHtml(truncate(post.excerpt, 200)) + '</p>');
    }
    return card;
}

// ── Blog view toggle ──────────────────────────────────────────────────────────

function initBlogViewToggle() {
    $('.blog-view-toggle .view-toggle-btn').on('click', function () {
        var view = $(this).data('view');
        $('.blog-view-toggle .view-toggle-btn').removeClass('active').attr('aria-selected', 'false');
        $(this).addClass('active').attr('aria-selected', 'true');

        if (view === 'timeline') {
            $('#posts-list').addClass('hidden');
            $('#blog-timeline').removeClass('hidden');
        } else {
            $('#posts-list').removeClass('hidden');
            $('#blog-timeline').addClass('hidden');
        }
    });
}

function loadPosts() {
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

            initBlogViewToggle();
        })
        .catch(function () {
            $('#posts-list').html('<p class="hint" style="color:var(--color-error)">Could not load posts.</p>');
        });
}

$(document).ready(function () {
    loadPosts();
    if (!isAdminSession()) {
        fetch(API_BASE + '/stats/visit?page=blog', { method: 'POST' }).catch(function () {});
    }
});
