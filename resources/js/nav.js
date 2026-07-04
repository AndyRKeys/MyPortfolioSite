(function () {
    // ── Nav items
    var NAV_ITEMS = [
        { href: '/',           label: '🏠 Home' },
        { href: '/#about',     label: '👤 About' },
        { href: '/#portfolio', label: '💼 Projects' },
        { href: '/#timeline',  label: '📅 Timeline' },
        { href: '/#skills',    label: '🛠 Skills' },
        { href: '/#contact',   label: '✉ Contact' },
        { href: '/ai-blog/',   label: '🤖 AI Dev Blog' },
        { href: '/blog/',      label: '✏ Blog' },
        { href: '/travel/',    label: '✈ Travel' },
        { href: '/github/',    label: '🐙 GitHub' },
        { href: '/search/',    label: '🔍 Search' },
        { href: '/login/',     label: '🔒 Admin' },
    ];

    // ── Build nav
    function buildNav() {
        var menu = document.querySelector('ul.nav');
        if (!menu) return;

        menu.innerHTML = '';

        var path = window.location.pathname;

        NAV_ITEMS.forEach(function (item) {
            var li = document.createElement('li');
            var a = document.createElement('a');
            a.href = item.href;
            a.textContent = item.label;
            var active = item.href === '/'
                ? path === '/'
                : (path === item.href || path.startsWith(item.href));
            if (active) a.setAttribute('aria-current', 'page');
            li.appendChild(a);
            menu.appendChild(li);
        });

        var toggleLi = document.createElement('li');
        var btn = document.createElement('button');
        btn.id = 'dark-mode-toggle';
        btn.type = 'button';
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        btn.textContent = isDark ? '☀' : '☾';
        btn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
        toggleLi.appendChild(btn);
        menu.appendChild(toggleLi);
    }

    // ── Init
    if (window.location.pathname.startsWith('/admin/')) return;

    var toggle = document.querySelector('.nav-toggle');
    var menu = document.querySelector('ul.nav');
    if (!toggle || !menu) return;

    buildNav();

    toggle.addEventListener('click', function () {
        var isOpen = menu.classList.toggle('nav-open');
        toggle.setAttribute('aria-expanded', String(isOpen));
        toggle.querySelector('.nav-toggle-icon').textContent = isOpen ? '✕' : '☰';
    });

    menu.querySelectorAll('a').forEach(function (link) {
        link.addEventListener('click', function () {
            menu.classList.remove('nav-open');
            toggle.setAttribute('aria-expanded', 'false');
            var icon = toggle.querySelector('.nav-toggle-icon');
            if (icon) icon.textContent = '☰';
        });
    });
})();
