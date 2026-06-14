// Inject the admin sub-navigation bar and mark the active link (#378).
// Non-module script — runs synchronously so the nav appears before main content.
(function () {
    var NAV_ITEMS = [
        { href: '/admin/',              label: 'Dashboard', icon: '⊞' },
        { href: '/admin/posts.html',    label: 'Posts',     icon: '✏' },
        { href: '/admin/travel.html',   label: 'Travel',    icon: '✈' },
        { href: '/admin/deploy.html',   label: 'Deploy',    icon: '⚡' },
        { href: '/admin/media.html',    label: 'Media',     icon: '📁' },
        { href: '/admin/activity.html', label: 'Activity',  icon: '📋' },
        { href: '/admin/stats.html',    label: 'Stats',     icon: '📊' },
        { href: '/admin/settings.html', label: 'Settings',  icon: '⚙' },
    ];

    var pathname = window.location.pathname;

    var nav = document.createElement('nav');
    nav.className = 'admin-subnav';
    nav.setAttribute('aria-label', 'Admin sections');

    NAV_ITEMS.forEach(function (item) {
        var a = document.createElement('a');
        a.href = item.href;
        a.className = 'admin-subnav-item';

        // Match dashboard only on exact path; other items on pathname match.
        var isActive = item.href === '/admin/'
            ? (pathname === '/admin/' || pathname === '/admin/index.html')
            : pathname === item.href;

        if (isActive) {
            a.classList.add('active');
            a.setAttribute('aria-current', 'page');
        }

        a.innerHTML = '<span aria-hidden="true">' + item.icon + '</span>' +
                      '<span class="admin-subnav-label">' + item.label + '</span>';
        nav.appendChild(a);
    });

    // Insert immediately after the main <nav> element.
    var mainNav = document.querySelector('body > nav');
    if (mainNav) {
        mainNav.insertAdjacentElement('afterend', nav);
    } else {
        document.body.insertAdjacentElement('afterbegin', nav);
    }
}());
