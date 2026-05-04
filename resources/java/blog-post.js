var API_BASE = '';

function sanitizeHtml(html) {
    var temp = document.createElement('div');
    temp.innerHTML = html;
    var remove = temp.querySelectorAll('script, iframe, object, embed, [onclick], [onload], [onerror]');
    remove.forEach(function(el) { el.remove(); });
    temp.querySelectorAll('[href*="javascript:"], [src*="javascript:"]').forEach(function(el) {
        el.removeAttribute('href');
        el.removeAttribute('src');
    });
    return temp.innerHTML;
}

function getSlug() {
    var params = new URLSearchParams(window.location.search);
    return params.get('slug');
}

function loadPost() {
    var slug = getSlug();
    if (!slug) {
        showError();
        return;
    }

    fetch(API_BASE + '/posts/' + encodeURIComponent(slug))
        .then(function (res) {
            if (!res.ok) throw new Error('not found');
            return res.json();
        })
        .then(function (post) {
            document.title = post.title + ' | AK Portfolio';
            document.getElementById('post-header-title').textContent = post.title;
            document.getElementById('post-title').textContent = post.title;

            var rawDate = post.post_date ? String(post.post_date).slice(0, 10) + 'T00:00:00' : post.published_at;
            var dateObj = rawDate ? new Date(rawDate) : null;
            document.getElementById('post-date').textContent = (dateObj && !isNaN(dateObj))
                ? dateObj.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
                : '';

            var md = post.body_markdown || '';
            var result = marked.parse(md);
            Promise.resolve(result).then(function (html) {
                document.getElementById('post-markdown').innerHTML = sanitizeHtml(html);
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

document.addEventListener('DOMContentLoaded', function () {
    loadPost();
});
