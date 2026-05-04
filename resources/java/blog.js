// API base — /api in production (Nginx proxy strips prefix), empty string in dev
var API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? '' : '/api';

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len).trimEnd() + '…' : str;
}

function buildPostCard(post) {
    var card = $('<a class="post-card"></a>');
    card.attr('href', 'blog-post.html?slug=' + encodeURIComponent(post.slug));
    var rawDate = post.post_date ? post.post_date + 'T00:00:00' : post.published_at;
    var date = rawDate ? new Date(rawDate).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
    card.append('<h3 class="post-card-title">' + escapeHtml(post.title) + '</h3>');
    card.append('<p class="post-card-date">' + escapeHtml(date) + '</p>');
    if (post.excerpt) {
        card.append('<p class="post-card-excerpt">' + escapeHtml(truncate(post.excerpt, 200)) + '</p>');
    }
    return card;
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
                return;
            }
            posts.forEach(function (post) { list.append(buildPostCard(post)); });
        })
        .catch(function () {
            $('#posts-list').html('<p class="hint" style="color:var(--color-error)">Could not load posts.</p>');
        });
}

function isAdminSession() {
    var token = localStorage.getItem('adminToken');
    if (!token) return false;
    try {
        var payload = JSON.parse(atob(token.split('.')[1]));
        return payload.exp * 1000 > Date.now();
    } catch (e) { return false; }
}

$(document).ready(function () {
    loadPosts();
    if (!isAdminSession()) {
        fetch(API_BASE + '/stats/visit?page=blog', { method: 'POST' }).catch(function () {});
    }
});
