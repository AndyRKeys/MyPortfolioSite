import { API_BASE } from './config.js';
import { getToken } from './auth-utils.js';
import { buildRepoCard } from './utils/dom.js';
import { recordVisit as _recordVisit } from './utils/stats.js';

// ── Horizontal scroll carousel ────────────────────────────────────────────────

var leftPaddle = document.getElementsByClassName('left-paddle');
var rightPaddle = document.getElementsByClassName('right-paddle');
var paddleMargin = 20;

function outerWidth(el) {
    var style = getComputedStyle(el);
    return el.offsetWidth + parseFloat(style.marginLeft) + parseFloat(style.marginRight);
}

var portConts = document.querySelectorAll('.port-cont');
var itemsLength = portConts.length;
var itemSize = portConts.length ? outerWidth(portConts[0]) : 0;

var hsWrap = document.querySelector('.hs-wrap');
var hs = document.querySelector('.hs');

function getMenuWrapperSize() {
    return hsWrap ? hsWrap.offsetWidth : 0;
}

var menuWrapperSize = getMenuWrapperSize();
window.addEventListener('resize', function () {
    menuWrapperSize = getMenuWrapperSize();
});

var menuSize = itemsLength * itemSize;
var menuInvisibleSize = menuSize - menuWrapperSize;

function getMenuPosition() {
    return hs ? hs.scrollLeft : 0;
}

function setPaddleVisibility(menuPosition) {
    var menuEndOffset = menuInvisibleSize - paddleMargin;
    var showLeft = menuPosition > paddleMargin;
    var showRight = menuPosition < menuEndOffset;
    Array.from(leftPaddle).forEach(function (el) { el.classList.toggle('hidden', !showLeft); });
    Array.from(rightPaddle).forEach(function (el) { el.classList.toggle('hidden', !showRight); });
}

if (hs) {
    hs.addEventListener('scroll', function () {
        menuInvisibleSize = menuSize - menuWrapperSize;
        setPaddleVisibility(getMenuPosition());
    });
}

Array.from(rightPaddle).forEach(function (el) {
    el.addEventListener('click', function () {
        if (hs) hs.scrollTo({ left: menuInvisibleSize, behavior: 'smooth' });
    });
});

Array.from(leftPaddle).forEach(function (el) {
    el.addEventListener('click', function () {
        if (hs) hs.scrollTo({ left: 0, behavior: 'smooth' });
    });
});

var childDivs = document.getElementsByClassName('hs');
for (var i = 0; i < childDivs.length; i++) {
    childDivs[i].parentNode.style.height = (childDivs[i].offsetHeight - 20) + 'px';
}

// ── GitHub activity widget ────────────────────────────────────────────────────

function loadGithubWidget() {
    var container = document.getElementById('github-repos');
    if (!container) return;

    fetch('https://api.github.com/users/AndyRKeys/repos?sort=pushed&per_page=6')
        .then(function (res) {
            if (res.status === 403 || res.status === 429) throw new Error('rate-limited');
            if (!res.ok) throw new Error('fetch-failed');
            return res.json();
        })
        .then(function (repos) {
            container.innerHTML = '';
            repos.forEach(function (repo) { container.append(buildRepoCard(repo)); });
        })
        .catch(function (err) {
            var msg = err.message === 'rate-limited'
                ? 'GitHub API rate limit reached — <a href="https://github.com/AndyRKeys" target="_blank" rel="noopener noreferrer">view profile directly</a>.'
                : 'Could not load GitHub activity — <a href="https://github.com/AndyRKeys" target="_blank" rel="noopener noreferrer">view profile directly</a>.';
            container.innerHTML = '<p class="github-fallback">' + msg + '</p>';
        });
}

// ── Contact form ──────────────────────────────────────────────────────────────

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

        var token = getToken();
        fetch(API_BASE + '/contact', {
            method: 'POST',
            headers: Object.assign(
                { 'Content-Type': 'application/json' },
                token ? { 'Authorization': 'Bearer ' + token } : {}
            ),
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

// ── Visit counter ─────────────────────────────────────────────────────────────

function recordVisit(page) {
    var counterLine = document.getElementById('visit-counter-line');
    var countEl = document.getElementById('visit-count');
    if (!counterLine || !countEl) return;
    var p = _recordVisit(page);
    if (!p) return;
    p.then(function (res) { return res ? res.json() : null; })
     .then(function (data) {
         if (data && data.count) {
             countEl.textContent = data.count.toLocaleString();
             counterLine.style.display = '';
         }
     });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

loadGithubWidget();
initContactForm();
recordVisit('home');
