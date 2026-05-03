var API_BASE = '';

function initDarkMode() {
    var toggleBtn = document.getElementById('dark-mode-toggle');
    if (!toggleBtn) return;
    function applyTheme(dark) {
        document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
        toggleBtn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
        toggleBtn.textContent = dark ? '☀' : '☾';
    }
    var stored = localStorage.getItem('theme');
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(stored ? stored === 'dark' : prefersDark);
    toggleBtn.addEventListener('click', function () {
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        localStorage.setItem('theme', isDark ? 'light' : 'dark');
        applyTheme(!isDark);
    });
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

            var date = post.published_at
                ? new Date(post.published_at).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
                : '';
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
    initDarkMode();
    loadPost();
});
