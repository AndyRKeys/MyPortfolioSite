// API base — always /api, nginx strips prefix before forwarding to backend
var API_BASE = '/api';

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

// ── Shared timeline builder ────────────────────────────────────────────────────
// Used by both travel (script.js) and blog (blog.js via window.buildTimelineItem).
// opts: { dateStr, title, location, notes, mediaUrl, mediaType, linkHref }
//
// - All text fields are set via .text() to prevent XSS.
// - location and mediaUrl are optional.
// - linkHref wraps the title in an <a> if provided (e.g. blog post slug).

function buildTimelineItem(opts) {
    var item = $('<div class="timeline-item"></div>');
    item.append('<div class="timeline-marker"></div>');
    var content = $('<div class="timeline-content"></div>');

    if (opts.dateStr) {
        $('<span class="timeline-date"></span>').text(opts.dateStr).appendTo(content);
    }

    if (opts.linkHref) {
        var link = $('<a></a>').attr('href', opts.linkHref);
        $('<h3></h3>').text(opts.title || 'Untitled').appendTo(link);
        content.append(link);
    } else {
        $('<h3></h3>').text(opts.title || 'Untitled').appendTo(content);
    }

    if (opts.location) {
        $('<p class="timeline-location"></p>').text('\uD83D\uDCCD ' + opts.location).appendTo(content);
    }

    if (opts.notes) {
        $('<p></p>').text(opts.notes).appendTo(content);
    }

    if (opts.mediaUrl && opts.mediaType && opts.mediaType.indexOf('image') === 0) {
        var mediaWrap = $('<div class="media-thumb-wrap"></div>');
        var img = $('<img class="timeline-thumb" alt="">').attr('src', opts.mediaUrl);
        img.on('error', function () { $(this).remove(); });
        mediaWrap.append(img);

        // Show "+N more" badge if multiple media items exist
        if (opts.mediaCount && opts.mediaCount > 1) {
            var extraCount = opts.mediaCount - 1;
            mediaWrap.append('<span class="media-extra-badge">+' + extraCount + '</span>');
        }

        content.append(mediaWrap);
    }

    item.append(content);
    return item;
}

// Expose for blog.js (loaded separately on blog.html)
window.buildTimelineItem = buildTimelineItem;

// ── Shared post card builder ───────────────────────────────────────────────────
// buildPostCard(type, data) — single source of truth for card markup used by both
// blog and travel sections, preventing the two from drifting apart.
//
// type: 'blog' | 'travel'
// data (blog):   { slug, title, date, excerpt }
// data (travel): { id, title, location, date, notes, mediaUrl, mediaType }
//
// All user-supplied strings are set via .text() / .attr() — no XSS risk.

function buildPostCard(type, data) {
    if (type === 'blog') {
        var card = $('<a class="post-card"></a>');
        card.attr('href', 'blog-post.html?slug=' + encodeURIComponent(data.slug));
        $('<h3 class="post-card-title"></h3>').text(data.title || 'Untitled').appendTo(card);
        if (data.date) {
            $('<p class="post-card-date"></p>').text(data.date).appendTo(card);
        }
        if (data.excerpt) {
            $('<p class="post-card-excerpt"></p>').text(data.excerpt).appendTo(card);
        }
        return card;
    }

    // type === 'travel'
    var placeholder = './resources/img/placeholder-transparent.png';
    var card = $('<article class="travel-card box draft-card"></article>');
    card.attr('data-memory-id', data.id);

    var media = $('<div class="media"></div>');
    if (data.mediaUrl) {
        if (data.mediaType && data.mediaType.indexOf('video') === 0) {
            $('<video controls></video>').attr('src', data.mediaUrl).appendTo(media);
        } else {
            var img = $('<img alt="Travel snapshot">').attr('src', data.mediaUrl);
            img.on('error', function () { $(this).attr('src', placeholder); });
            media.append(img);
        }
    } else {
        $('<img alt="Travel snapshot">').attr('src', placeholder).appendTo(media);
    }

    var content = $('<div class="travel-content"></div>');
    $('<h3></h3>').text(data.title || 'Untitled memory').appendTo(content);

    var meta = $('<p class="meta"></p>');
    $('<span class="travel-location"></span>').text(data.location || 'Location not set').appendTo(meta);
    if (data.date) {
        $('<span class="travel-date"></span>').text(data.date).appendTo(meta);
    }
    meta.appendTo(content);
    $('<p></p>').text(data.notes || 'No notes yet.').appendTo(content);

    card.append(media).append(content);
    return card;
}

// Expose for blog.js (loaded separately on blog.html)
window.buildPostCard = buildPostCard;

// ── Travel memories ────────────────────────────────────────────────────────────

function formatVisitDate(dateStr) {
    if (!dateStr) return null;
    // Accept "YYYY-MM-DD" or full ISO timestamps — always parse as local date
    var datePart = String(dateStr).slice(0, 10);
    var d = new Date(datePart + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ── Gallery lightbox ─────────────────────────────────────────────────────────

var lightboxItems = [];
var lightboxIndex = 0;

function openLightbox(items, startIndex, title) {
    lightboxItems = items;
    lightboxIndex = startIndex || 0;
    $('#travel-lightbox .lightbox-title').text(title || '');
    renderLightboxItem();
    $('#travel-lightbox').removeClass('hidden');
    document.body.style.overflow = 'hidden';
}

function closeLightbox() {
    $('#travel-lightbox').addClass('hidden');
    document.body.style.overflow = '';
    // Stop any playing video
    $('#travel-lightbox video').each(function () { this.pause(); });
}

function renderLightboxItem() {
    var item = lightboxItems[lightboxIndex];
    var mediaEl;
    if (item.type && item.type.indexOf('video') === 0) {
        mediaEl = $('<video controls playsinline></video>').attr('src', item.url);
    } else {
        mediaEl = $('<img alt="Gallery image">').attr('src', item.url);
    }
    $('#travel-lightbox .lightbox-media').empty().append(mediaEl);
    $('#travel-lightbox .lightbox-counter').text((lightboxIndex + 1) + ' / ' + lightboxItems.length);
    $('#travel-lightbox .lightbox-prev').toggleClass('hidden', lightboxIndex === 0);
    $('#travel-lightbox .lightbox-next').toggleClass('hidden', lightboxIndex === lightboxItems.length - 1);
}

function initLightbox() {
    $(document).on('click', '.lightbox-close', function (e) {
        e.preventDefault();
        e.stopPropagation();
        closeLightbox();
    });
    $(document).on('click', '#travel-lightbox', function (e) {
        if ($(e.target).attr('id') === 'travel-lightbox') {
            closeLightbox();
        }
    });
    $(document).on('click', '.lightbox-prev', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (lightboxIndex > 0) { lightboxIndex--; renderLightboxItem(); }
    });
    $(document).on('click', '.lightbox-next', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (lightboxIndex < lightboxItems.length - 1) { lightboxIndex++; renderLightboxItem(); }
    });
    $(document).on('keydown', function (e) {
        var lightbox = document.getElementById('travel-lightbox');
        if (!lightbox || lightbox.classList.contains('hidden')) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            closeLightbox();
        }
        if (e.key === 'ArrowLeft' && lightboxIndex > 0) { e.preventDefault(); lightboxIndex--; renderLightboxItem(); }
        if (e.key === 'ArrowRight' && lightboxIndex < lightboxItems.length - 1) { e.preventDefault(); lightboxIndex++; renderLightboxItem(); }
    });
}

// ── Travel cards ─────────────────────────────────────────────────────────────

function buildPublicTravelCard(travel) {
    var card = $('<article class="travel-card box draft-card"></article>');
    card.attr('data-memory-id', travel.id);
    var media = $('<div class="media"></div>');

    // Prefer post_media array; fall back to legacy media_url field
    var allMedia = Array.isArray(travel.media) && travel.media.length
        ? travel.media
        : (travel.media_url ? [{ url: travel.media_url, type: travel.media_type }] : null);
    var firstMedia = allMedia ? allMedia[0] : null;
    var mediaUrl = firstMedia ? firstMedia.url : null;
    var mediaType = firstMedia ? firstMedia.type : null;
    var extraCount = allMedia ? allMedia.length - 1 : 0;

    var placeholder = './resources/img/placeholder-transparent.png';
    if (mediaUrl) {
        var mediaWrap = $('<div class="media-thumb-wrap"></div>');
        if (mediaType && mediaType.indexOf('video') === 0) {
            mediaWrap.append('<video controls src="' + mediaUrl + '"></video>');
        } else {
            var img = $('<img alt="Travel snapshot">').attr('src', mediaUrl);
            img.on('error', function () { $(this).attr('src', placeholder); });
            mediaWrap.append(img);
        }
        if (extraCount > 0) {
            mediaWrap.append('<span class="media-extra-badge">+' + extraCount + '</span>');
            card.addClass('has-gallery');
        }
        media.append(mediaWrap);
    } else {
        media.append('<img src="' + placeholder + '" alt="Travel snapshot">');
    }

    // Click on card media opens lightbox when multiple items exist
    if (allMedia && allMedia.length > 1) {
        media.on('click', function () {
            openLightbox(allMedia, 0, travel.title);
        });
    }

    var content = $('<div class="travel-content"></div>');
    content.append('<h3>' + (travel.title || 'Untitled memory') + '</h3>');
    var formattedDate = formatVisitDate(travel.visit_date);
    var locationText = travel.location || 'Location not set';
    var locationPrefix = travel.location_estimated ? '~ ' : '';
    var metaHtml = '<span class="travel-location">' + locationPrefix + locationText + '</span>';
    if (formattedDate) {
        metaHtml += '<span class="travel-date">' + formattedDate + '</span>';
    }
    content.append('<p class="meta">' + metaHtml + '</p>');
    content.append('<p>' + (travel.notes || 'No notes yet.') + '</p>');
    card.append(media).append(content);
    return card;
}

// ── Travel map (Leaflet) ───────────────────────────────────────────────────────

var travelMap = null;

function escHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildPopupHtml(memory) {
    var mediaUrl = memory.media_url || memory.mediaUrl;
    var mediaType = memory.media_type || memory.mediaType;
    var thumb = '';
    if (mediaUrl && mediaType && mediaType.indexOf('image') === 0) {
        thumb = '<img class="popup-thumb" src="' + escHtml(mediaUrl) + '" alt="">';
    }
    return (
        '<div class="popup-content">' +
        thumb +
        '<strong>' + escHtml(memory.title) + '</strong>' +
        (memory.location ? '<div class="popup-location">' + escHtml(memory.location) + '</div>' : '') +
        '</div>'
    );
}

function initTravelMap(memories) {
    if (typeof L === 'undefined') return;
    var mapEl = document.getElementById('travel-map');
    if (!mapEl) return;

    var withCoords = memories.filter(function (m) {
        return m.lat !== null && m.lng !== null && m.lat !== undefined && m.lng !== undefined;
    });

    if (!withCoords.length) {
        mapEl.classList.add('hidden');
        $('.travel-view-toggle').addClass('hidden');
        return;
    }

    travelMap = L.map('travel-map', { scrollWheelZoom: false }).setView([20, 0], 2);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '\u00a9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(travelMap);

    var markers = [];
    withCoords.forEach(function (m) {
        var lat = parseFloat(m.lat);
        var lng = parseFloat(m.lng);
        if (Number.isNaN(lat) || Number.isNaN(lng)) return;
        var marker = L.marker([lat, lng]).addTo(travelMap).bindPopup(buildPopupHtml(m));
        markers.push(marker);
    });

    if (markers.length === 1) {
        travelMap.setView(markers[0].getLatLng(), 6);
    } else if (markers.length > 1) {
        var group = L.featureGroup(markers);
        travelMap.fitBounds(group.getBounds().pad(0.2));
    }
}

function applyTravelView(view) {
    var mapEl   = $('#travel-map');
    var grid    = $('#travel-grid');
    var timeline = $('#travel-timeline');

    // Hide all first, then reveal only what this view needs
    mapEl.addClass('hidden');
    grid.addClass('hidden');
    timeline.addClass('hidden');

    if (view === 'map-timeline') {
        mapEl.removeClass('hidden');
        timeline.removeClass('hidden');
    } else if (view === 'both') {
        mapEl.removeClass('hidden');
        grid.removeClass('hidden');
    } else if (view === 'map') {
        mapEl.removeClass('hidden');
    } else if (view === 'cards') {
        grid.removeClass('hidden');
    } else if (view === 'timeline') {
        timeline.removeClass('hidden');
    }

    if (travelMap && (view === 'map-timeline' || view === 'map' || view === 'both')) {
        setTimeout(function () { travelMap.invalidateSize(); }, 50);
    }
}

function initViewToggle() {
    // Scoped to .travel-view-toggle to avoid colliding with .blog-view-toggle
    // when both script.js and blog.js are loaded on blog.html.
    // All containers must be populated before this is called.
    var activeView = $('.travel-view-toggle .view-toggle-btn.active').data('view') || 'map-timeline';
    applyTravelView(activeView);

    $('.travel-view-toggle .view-toggle-btn').on('click', function () {
        var view = $(this).data('view');
        $('.travel-view-toggle .view-toggle-btn').removeClass('active').attr('aria-selected', 'false');
        $(this).addClass('active').attr('aria-selected', 'true');
        applyTravelView(view);
    });
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
                $('#travel-map').addClass('hidden');
                $('.travel-view-toggle').addClass('hidden');
                return;
            }

            memories.forEach(function(travel) {
                travelGrid.append(buildPublicTravelCard(travel));
            });

            var sorted = memories.slice().sort(function(a, b) {
                var da = a.visit_date ? String(a.visit_date).slice(0, 10) : '';
                var db = b.visit_date ? String(b.visit_date).slice(0, 10) : '';
                return db < da ? -1 : db > da ? 1 : 0;
            });
            var timelineEl = $('#travel-timeline');
            sorted.forEach(function(travel) {
                // Use first image from media array if available, fall back to legacy media_url
                var allMedia = Array.isArray(travel.media) && travel.media.length ? travel.media : null;
                var firstMedia = allMedia ? allMedia[0] : null;
                var mediaUrl = (firstMedia && firstMedia.url) || travel.media_url || travel.mediaUrl;
                var mediaType = (firstMedia && firstMedia.type) || travel.media_type || travel.mediaType;

                var item = buildTimelineItem({
                    dateStr:   formatVisitDate(travel.visit_date),
                    title:     travel.title,
                    location:  travel.location,
                    notes:     travel.notes,
                    mediaUrl:  mediaUrl,
                    mediaType: mediaType,
                    mediaCount: allMedia ? allMedia.length : 0,
                });

                // Wire up lightbox for timeline image if media array exists
                if (allMedia && allMedia.length > 0) {
                    item.find('.timeline-thumb').css('cursor', 'pointer').on('click', function(e) {
                        e.preventDefault();
                        var mediaItems = allMedia.map(function(m) { return { url: m.url, type: m.type }; });
                        openLightbox(mediaItems, 0, travel.title);
                    });
                }

                timelineEl.append(item);
            });

            // All containers must be populated before initViewToggle wires the buttons.
            initTravelMap(memories);
            initViewToggle();
        })
        .catch(function() {
            $('#travel-empty').removeClass('hidden');
            $('#travel-map').addClass('hidden');
            $('.travel-view-toggle').addClass('hidden');
        });
}

// ── GitHub activity widget ─────────────────────────────────────────────────────

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

// ── Contact form ───────────────────────────────────────────────────────────────

function initContactForm() {
    var form = document.getElementById('contact-form');
    if (!form) return;

    form.addEventListener('submit', function(event) {
        event.preventDefault();
        var msgEl = document.getElementById('contact-form-message');
        var submitBtn = form.querySelector('button[type="submit"]');

        submitBtn.disabled = true;
        msgEl.textContent = 'Sending\u2026';
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
                    msgEl.textContent = 'Message sent \u2014 I\'ll be in touch soon.';
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

// ── Visit counter ──────────────────────────────────────────────────────────────

function recordVisit(page) {
    if (isAdminSession()) return;

    var counterLine = document.getElementById('visit-counter-line');
    var countEl = document.getElementById('visit-count');
    if (!counterLine || !countEl) return;

    fetch(API_BASE + '/stats/visit?page=' + encodeURIComponent(page), { method: 'POST' })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.count) {
                countEl.textContent = data.count.toLocaleString();
                counterLine.style.display = '';
            }
        })
        .catch(function() {});
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────

$(document).ready(function() {
    loadPublicTravelPosts();
    loadGithubWidget();
    initContactForm();
    recordVisit('home');
    if (document.getElementById('travel-lightbox')) initLightbox();
});
