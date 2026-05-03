(function () {
    function applyTheme(dark) {
        document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
        var btn = document.getElementById('dark-mode-toggle');
        if (btn) {
            btn.textContent = dark ? '☀' : '☾';
            btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
        }
    }

    // Apply saved/preferred theme immediately to avoid flash
    var stored = localStorage.getItem('theme');
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(stored ? stored === 'dark' : prefersDark);

    document.addEventListener('DOMContentLoaded', function () {
        var btn = document.getElementById('dark-mode-toggle');
        if (!btn) return;
        btn.addEventListener('click', function () {
            var next = document.documentElement.getAttribute('data-theme') !== 'dark';
            localStorage.setItem('theme', next ? 'dark' : 'light');
            applyTheme(next);
        });
    });
})();
