var API_BASE = '';

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

            var rawDate = post.post_date ? post.post_date + 'T00:00:00' : post.published_at;
            var date = rawDate ? new Date(rawDate).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
            document.getElementById('post-date').textContent = date;

            var html = marked.parse(post.body_markdown || '');
            document.getElementById('post-markdown').innerHTML = html;

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
