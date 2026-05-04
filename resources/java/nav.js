(function () {
    var toggle = document.querySelector('.nav-toggle');
    var menu = document.querySelector('ul.nav');
    if (!toggle || !menu) return;

    toggle.addEventListener('click', function () {
        var isOpen = menu.classList.toggle('nav-open');
        toggle.setAttribute('aria-expanded', String(isOpen));
        toggle.querySelector('.nav-toggle-icon').textContent = isOpen ? '✕' : '☰';
    });

    // Close the menu when any nav link is clicked (single-page anchor nav)
    menu.querySelectorAll('a').forEach(function (link) {
        link.addEventListener('click', function () {
            menu.classList.remove('nav-open');
            toggle.setAttribute('aria-expanded', 'false');
            var icon = toggle.querySelector('.nav-toggle-icon');
            if (icon) icon.textContent = '☰';
        });
    });
})();
