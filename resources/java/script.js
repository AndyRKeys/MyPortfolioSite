// API base — empty string in production (Nginx proxy), backend URL in dev
var API_BASE = '';

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
var getMenuWrapperSize = function() {
    return $('.hs-wrap').outerWidth();
}
var menuWrapperSize = getMenuWrapperSize();
// the wrapper is responsive
$(window).on('resize', function() {
    menuWrapperSize = getMenuWrapperSize();
});
// size of the visible part of the menu is equal as the wrapper size
var menuVisibleSize = menuWrapperSize;

// get total width of all menu items
var getMenuSize = function() {
    return itemsLength * itemSize;
};
var menuSize = getMenuSize();
// get how much of menu is invisible
var menuInvisibleSize = menuSize - menuWrapperSize;

// get how much have we scrolled to the left
var getMenuPosition = function() {
    return $('.hs').scrollLeft();
};

// finally, what happens when we are actually scrolling the menu
$('.hs').on('scroll', function() {

    // get how much of menu is invisible
    menuInvisibleSize = menuSize - menuWrapperSize;
    // get how much have we scrolled so far
    var menuPosition = getMenuPosition();

    var menuEndOffset = menuInvisibleSize - paddleMargin;

    // show & hide the paddles
    // depending on scroll position
    if (menuPosition <= paddleMargin) {
        $(leftPaddle).addClass('hidden');
        $(rightPaddle).removeClass('hidden');
    } else if (menuPosition < menuEndOffset) {
        // show both paddles in the middle
        $(leftPaddle).removeClass('hidden');
        $(rightPaddle).removeClass('hidden');
    } else if (menuPosition >= menuEndOffset) {
        $(leftPaddle).removeClass('hidden');
        $(rightPaddle).addClass('hidden');
    }

});

// scroll to left
$(rightPaddle).on('click', function() {
    $('.hs').animate({ scrollLeft: menuInvisibleSize }, scrollDuration);
});

// scroll to right
$(leftPaddle).on('click', function() {
    $('.hs').animate({ scrollLeft: '0' }, scrollDuration);
});

/*
dynamically set height of elements so scroll bar is hidden
*/
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
    div.style.height = height + "px";
}

// ── Travel memories ───────────────────────────────────────────────────────────

function buildPublicTravelCard(travel) {
    var card = $('<article class="travel-card box draft-card"></article>');
    var media = $('<div class="media"></div>');
    var mediaUrl = travel.media_url || travel.mediaUrl;
    var mediaType = travel.media_type || travel.mediaType;
    if (mediaUrl) {
        if (mediaType && mediaType.indexOf('video') === 0) {
            media.append('<video controls src="' + mediaUrl + '"></video>');
        } else {
            media.append('<img src="' + mediaUrl + '" alt="Travel snapshot">');
        }
    } else {
        media.append('<img src="./resources/img/placeholder-transparent.png" alt="Travel snapshot">');
    }
    var content = $('<div class="travel-content"></div>');
    content.append('<h3>' + (travel.title || 'Untitled memory') + '</h3>');
    content.append('<p class="meta">' + (travel.location || 'Location not set') + '</p>');
    content.append('<p>' + (travel.notes || 'No notes yet.') + '</p>');
    card.append(media).append(content);
    return card;
}

function loadPublicTravelPosts() {
    var travelGrid = $('#travel-grid');
    if (!travelGrid.length) {
        return;
    }

    fetch(API_BASE + '/travel')
        .then(function(res) {
            if (!res.ok) throw new Error('Failed to load');
            return res.json();
        })
        .then(function(memories) {
            if (!memories.length) {
                $('#travel-empty').removeClass('hidden');
                return;
            }
            memories.forEach(function(travel) {
                travelGrid.append(buildPublicTravelCard(travel));
            });
        })
        .catch(function() {
            $('#travel-empty').removeClass('hidden');
        });
}

// ── GitHub activity widget ────────────────────────────────────────────────────

function buildRepoCard(repo) {
    var card = $('<a class="github-repo-card" target="_blank" rel="noopener noreferrer"></a>');
    card.attr('href', repo.html_url);
    var name = $('<div class="github-repo-name"></div>').text(repo.name);
    var desc = $('<div class="github-repo-desc"></div>').text(repo.description || 'No description');
    var meta = $('<div class="github-repo-meta"></div>');
    if (repo.language) {
        meta.append('<span class="github-repo-lang">' + repo.language + '</span>');
    }
    meta.append('<span class="github-repo-updated">Updated ' + formatRelativeDate(repo.pushed_at) + '</span>');
    card.append(name).append(desc).append(meta);
    return card;
}

function formatRelativeDate(isoString) {
    var date = new Date(isoString);
    var now = new Date();
    var diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return 'today';
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 30) return diffDays + ' days ago';
    if (diffDays < 365) return Math.floor(diffDays / 30) + ' months ago';
    return Math.floor(diffDays / 365) + ' years ago';
}

function loadGithubWidget() {
    var container = $('#github-repos');
    if (!container.length) return;

    fetch('https://api.github.com/users/AndyRKeys/repos?sort=pushed&per_page=6')
        .then(function(res) {
            if (res.status === 403 || res.status === 429) {
                throw new Error('rate-limited');
            }
            if (!res.ok) throw new Error('fetch-failed');
            return res.json();
        })
        .then(function(repos) {
            container.empty();
            repos.forEach(function(repo) {
                container.append(buildRepoCard(repo));
            });
        })
        .catch(function(err) {
            var msg = err.message === 'rate-limited'
                ? 'GitHub API rate limit reached — <a href="https://github.com/AndyRKeys" target="_blank" rel="noopener noreferrer">view profile directly</a>.'
                : 'Could not load GitHub activity — <a href="https://github.com/AndyRKeys" target="_blank" rel="noopener noreferrer">view profile directly</a>.';
            container.html('<p class="github-fallback">' + msg + '</p>');
        });
}

// ── Contact form ──────────────────────────────────────────────────────────────

function initContactForm() {
    var form = document.getElementById('contact-form');
    if (!form) return;

    form.addEventListener('submit', function(event) {
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
            website: document.getElementById('contact-website').value, // honeypot
        };

        fetch(API_BASE + '/contact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
            .then(function(res) { return res.json().then(function(d) { return { ok: res.ok, data: d }; }); })
            .then(function(result) {
                if (result.ok) {
                    msgEl.textContent = 'Message sent — I\'ll be in touch soon.';
                    msgEl.className = 'contact-form-message success';
                    form.reset();
                } else {
                    msgEl.textContent = result.data.error || 'Something went wrong. Please try emailing directly.';
                    msgEl.className = 'contact-form-message error';
                }
            })
            .catch(function() {
                msgEl.textContent = 'Network error. Please try emailing directly.';
                msgEl.className = 'contact-form-message error';
            })
            .finally(function() {
                submitBtn.disabled = false;
            });
    });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

$(document).ready(function() {
    loadPublicTravelPosts();
    loadGithubWidget();
    initContactForm();
});
