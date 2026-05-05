import { API_BASE } from './config.js';
import { formatPostDate } from './utils/date.js';
import { buildPostCard, buildTimelineItem } from './utils/dom.js';

function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len).trimEnd() + '\u2026' : str;
}

function buildBlogPostCard(post) {
    return buildPostCard('blog', {
        slug: post.slug,
        title: post.title,
        date: formatPostDate(post),
        excerpt: post.excerpt ? truncate(post.excerpt, 150) : null,
    });
}

// ── Blog view toggle ────────────────────────────────────────────────────────────────
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

            posts.forEach(function (post) { list.append(buildBlogPostCard(post)); });

            var sorted = posts.slice().sort(function (a, b) {
                var da = a.post_date ? String(a.post_date).slice(0, 10) : (a.published_at ? a.published_at.slice(0, 10) : '');
                var db = b.post_date ? String(b.post_date).slice(0, 10) : (b.published_at ? b.published_at.slice(0, 10) : '');
                return db < da ? -1 : db > da ? 1 : 0;
            });
            var timelineEl = $('#blog-timeline');
            sorted.forEach(function (post) {
                timelineEl.append(buildTimelineItem({
                    dateStr: formatPostDate(post),
                    title: post.title,
                    notes: post.excerpt ? truncate(post.excerpt, 200) : null,
                    linkHref: 'blog-post.html?slug=' + encodeURIComponent(post.slug),
                }));
            });

            // Cards and timeline must both be populated before toggle is wired.
            initBlogViewToggle();
        })
        .catch(function (err) {
            console.error('loadPosts failed:', err);
            $('#posts-list').html('<p class="hint" style="color:var(--color-error)">Could not load posts.</p>');
        });
}

// Modules are deferred by default — DOM is ready and jQuery is available.
loadPosts();
