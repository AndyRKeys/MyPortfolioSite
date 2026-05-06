import { API_BASE } from './config.js';
import { isAdminSession } from './auth-utils.js';
import { buildRepoCard } from './utils/dom.js';

// duration of scroll animation
var scrollDuration = 300;
// paddles
var leftPaddle = document.getElementsByClassName('left-paddle');
var rightPaddle = document.getElementsByClassName('right-paddle');
// get items dimensions
var itemsLength = $('.port-cont').length;
var itemSize = $('.port-cont').outerWidth(true);
// get some relevant size for the paddle triggering point
var paddleMargin = 20;

// get wrapper width
var getMenuWrapperSize = function () {
    return $('.hs-wrap').outerWidth();
};
var menuWrapperSize = getMenuWrapperSize();
$(window).on('resize', function () {
    menuWrapperSize = getMenuWrapperSize();
});
var menuVisibleSize = menuWrapperSize;

var getMenuSize = function () {
    return itemsLength * itemSize;
};
var menuSize = getMenuSize();
var menuInvisibleSize = menuSize - menuWrapperSize;

var getMenuPosition = function () {
    return $('.hs').scrollLeft();
};

$('.hs').on('scroll', function () {
    menuInvisibleSize = menuSize - menuWrapperSize;
    var menuPosition = getMenuPosition();
    var menuEndOffset = menuInvisibleSize - paddleMargin;

    if (menuPosition <= paddleMargin) {
        $(leftPaddle).addClass('hidden');
        $(rightPaddle).removeClass('hidden');
    } else if (menuPosition < menuEndOffset) {
        $(leftPaddle).removeClass('hidden');
        $(rightPaddle).removeClass('hidden');
    } else if (menuPosition >= menuEndOffset) {
        $(leftPaddle).removeClass('hidden');
        $(rightPaddle).addClass('hidden');
    }
});

$(rightPaddle).on('click', function () {
    $('.hs').animate({ scrollLeft: menuInvisibleSize }, scrollDuration);
});

$(leftPaddle).on('click', function () {
    $('.hs').animate({ scrollLeft: '0' }, scrollDuration);
});

var childDivs = document.getElementsByClassName('hs');
for (var i = 0; i < childDivs.length; i++) {
    var childHeight = getHeight(childDivs[i]);
    var parentHeight = childHeight - 20;
    var parent = childDivs[i].parentNode;
    setHeight(parent, parentHeight);
}

function getHeight(div) {
    return div.offsetHeight;
}

function setHeight(div, height) {
    div.style.height = height + 'px';
}

// ── GitHub activity widget

function loadGithubWidget() {
    var container = $('#github-repos');
    if (!container.length) return;

    fetch('https://api.github.com/users/AndyRKeys/repos?sort=pushed&per_page=6')
        .then(function (res) {
            if (res.status === 403 || res.status === 429) throw new Error('rate-limited');
            if (!res.ok) throw new Error('fetch-failed');
            return res.json();
        })
        .then(function (repos) {
            container.empty();
            repos.forEach(function (repo) { container.append(buildRepoCard(repo)); });
        })
        .catch(function (err) {
            var msg = err.message === 'rate-limited'
                ? 'GitHub API rate limit reached — <a href="https://github.com/AndyRKeys" target="_blank" rel="noopener noreferrer">view profile directly</a>.'
                : 'Could not load GitHub activity — <a href="https://github.com/AndyRKeys" target="_blank" rel="noopener noreferrer">view profile directly</a>.';
            container.html('<p class="github-fallback">' + msg + '</p>');
        });
}

// ── Contact form

function initContactForm() {
    var form = document.getElementById('contact-form');
    if (!form) return;

    form.addEventListener('submit', function (event) {
        event.preventDefault();
        var msgEl = document.getElementById('contact-form-message');
        var submitBtn = form.querySelector('button[type="submit"]');

        submitBtn.disabled = true;
        msgEl.textContent = 'Sending…';
        msgEl.className = 'contact-form-message';

        var payload = {
            name: document.getElementById('contact-name').value.trim(),
            email: document.getElementById('contact-email').value.trim(),
            message: document.getElementById('contact-message').value.trim(),
            website: document.getElementById('contact-website').value,
        };

        fetch(API_BASE + '/contact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
            .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
            .then(function (result) {
                if (result.ok) {
                    msgEl.textContent = 'Message sent — I\'ll be in touch soon.';
                    msgEl.className = 'contact-form-message success';
                    form.reset();
                } else {
                    msgEl.textContent = result.data.error || 'Something went wrong. Please try emailing directly.';
                    msgEl.className = 'contact-form-message error';
                }
            })
            .catch(function () {
                msgEl.textContent = 'Network error. Please try emailing directly.';
                msgEl.className = 'contact-form-message error';
            })
            .finally(function () { submitBtn.disabled = false; });
    });
}

// ── Visit counter

function recordVisit(page) {
    if (isAdminSession()) return;

    var counterLine = document.getElementById('visit-counter-line');
    var countEl = document.getElementById('visit-count');
    if (!counterLine || !countEl) return;

    fetch(API_BASE + '/stats/visit?page=' + encodeURIComponent(page), { method: 'POST' })
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (data.count) {
                countEl.textContent = data.count.toLocaleString();
                counterLine.style.display = '';
            }
        })
        .catch(function () {});
}

// ── Bootstrap

// Modules are deferred by default — DOM is ready when this executes.
// jQuery (<script> before this module) and Leaflet (if present) are already loaded.
loadGithubWidget();
initContactForm();
recordVisit('home');
