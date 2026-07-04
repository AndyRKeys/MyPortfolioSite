import { API_BASE } from './config.js';
import { escapeHtml, highlight } from './utils/html.js';
import { formatVisitDate } from './utils/date.js';
import { buildTimelineItem, buildPublicTravelCard } from './utils/dom.js';
import { initLightbox } from './utils/lightbox.js';
import { recordVisit } from './utils/stats.js';

// ── Travel map (Leaflet) ──────────────────────────────────────────────────────

var travelMap = null;

function buildPopupHtml(memory) {
    var mediaUrl = memory.media_url || memory.mediaUrl;
    var mediaType = memory.media_type || memory.mediaType;
    var thumb = '';
    if (mediaUrl && mediaType && mediaType.indexOf('image') === 0) {
        thumb = '<img class="popup-thumb" src="' + escapeHtml(mediaUrl) + '" alt="">';
    }
    return (
        '<div class="popup-content">' +
        thumb +
        '<strong>' + escapeHtml(memory.title) + '</strong>' +
        (memory.location ? '<div class="popup-location">' + escapeHtml(memory.location) + '</div>' : '') +
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
        document.querySelectorAll('.travel-view-toggle').forEach(function (el) { el.classList.add('hidden'); });
        return;
    }

    travelMap = L.map('travel-map', { scrollWheelZoom: false }).setView([20, 0], 2);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
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
    var mapEl = document.getElementById('travel-map');
    var grid = document.getElementById('travel-grid');
    var timeline = document.getElementById('travel-timeline');

    if (!mapEl || !grid || !timeline) return;
    mapEl.classList.add('hidden');
    grid.classList.add('hidden');
    timeline.classList.add('hidden');

    if (view === 'map-timeline') {
        mapEl.classList.remove('hidden');
        timeline.classList.remove('hidden');
    } else if (view === 'both') {
        mapEl.classList.remove('hidden');
        grid.classList.remove('hidden');
    } else if (view === 'map') {
        mapEl.classList.remove('hidden');
    } else if (view === 'cards') {
        grid.classList.remove('hidden');
    } else if (view === 'timeline') {
        timeline.classList.remove('hidden');
    }

    if (travelMap && (view === 'map-timeline' || view === 'map' || view === 'both')) {
        setTimeout(function () { travelMap.invalidateSize(); }, 50);
    }
}

function initViewToggle() {
    var activeBtn = document.querySelector('.travel-view-toggle .view-toggle-btn.active');
    var activeView = (activeBtn && activeBtn.dataset.view) || 'map-timeline';
    applyTravelView(activeView);

    document.querySelectorAll('.travel-view-toggle .view-toggle-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            document.querySelectorAll('.travel-view-toggle .view-toggle-btn').forEach(function (b) {
                b.classList.remove('active');
                b.setAttribute('aria-selected', 'false');
            });
            btn.classList.add('active');
            btn.setAttribute('aria-selected', 'true');
            applyTravelView(btn.dataset.view);
        });
    });
}

// ── Travel cards ──────────────────────────────────────────────────────────────

function loadPublicTravelPosts() {
    var travelGrid = document.getElementById('travel-grid');
    if (!travelGrid) return;

    fetch(API_BASE + '/travel')
        .then(function (res) {
            if (!res.ok) throw new Error('Failed to load');
            return res.json();
        })
        .then(function (memories) {
            if (!memories.length) {
                document.getElementById('travel-empty').classList.remove('hidden');
                document.getElementById('travel-map').classList.add('hidden');
                document.querySelectorAll('.travel-view-toggle').forEach(function (el) { el.classList.add('hidden'); });
                return;
            }

            memories.forEach(function (travel) {
                travelGrid.append(buildPublicTravelCard(travel, formatVisitDate));
            });

            var sorted = memories.slice().sort(function (a, b) {
                var da = a.post_date ? String(a.post_date).slice(0, 10) : '';
                var db = b.post_date ? String(b.post_date).slice(0, 10) : '';
                return db < da ? -1 : db > da ? 1 : 0;
            });
            var timelineEl = document.getElementById('travel-timeline');
            sorted.forEach(function (travel) {
                var allMedia  = Array.isArray(travel.media) && travel.media.length ? travel.media : null;
                var firstMedia = allMedia ? allMedia[0] : null;
                var mediaUrl  = (firstMedia && firstMedia.url)       || travel.media_url  || travel.mediaUrl;
                var thumbUrl  = (firstMedia && firstMedia.thumb_url) || travel.thumb_url  || null;
                var mediaType = (firstMedia && firstMedia.type)      || travel.media_type || travel.mediaType;

                var item = buildTimelineItem({
                    dateStr:    formatVisitDate(travel.post_date),
                    title:      travel.title,
                    location:   travel.location,
                    notes:      travel.notes,
                    mediaUrl:   mediaUrl,
                    thumbUrl:   thumbUrl,
                    mediaType:  mediaType,
                    mediaCount: allMedia ? allMedia.length : 0,
                    linkHref:   '/travel/post/?id=' + encodeURIComponent(travel.id),
                });

                var thumb = item.querySelector('.media-thumb-wrap');
                if (thumb) {
                    thumb.style.cursor = 'pointer';
                    thumb.addEventListener('click', function () {
                        window.location.href = '/travel/post/?id=' + encodeURIComponent(travel.id);
                    });
                }

                timelineEl.append(item);
            });

            // All containers must be populated before initViewToggle wires the buttons.
            initTravelMap(memories);
            initViewToggle();
        })
        .catch(function (err) {
            console.error('loadPublicTravelPosts failed:', err && (err.message || String(err)), err && err.stack);
            document.getElementById('travel-empty').classList.remove('hidden');
            document.getElementById('travel-map').classList.add('hidden');
            document.querySelectorAll('.travel-view-toggle').forEach(function (el) { el.classList.add('hidden'); });
        });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

recordVisit('travel');
loadPublicTravelPosts();
initLightbox();

// ── Embedded listing search (#469) ────────────────────────────────────────────

(function initListingSearch() {
    var form    = document.getElementById('listing-search-form');
    var input   = document.getElementById('listing-search-input');
    var results = document.getElementById('listing-search-results');
    var mapEl   = document.getElementById('travel-map');
    var grid    = document.getElementById('travel-grid');
    var timeline = document.getElementById('travel-timeline');
    var toggle  = document.querySelector('.travel-view-toggle');

    if (!form || !input || !results) return;

    function setListingHidden(hidden) {
        if (mapEl)    mapEl.classList.toggle('hidden', hidden);
        if (grid)     grid.classList.toggle('hidden', hidden);
        if (timeline) timeline.classList.toggle('hidden', hidden);
        if (toggle)   toggle.classList.toggle('hidden', hidden);
    }

    function restoreListing() {
        // Re-apply the active view so the right containers are shown.
        if (toggle) toggle.classList.remove('hidden');
        var activeBtn = document.querySelector('.travel-view-toggle .view-toggle-btn.active');
        var activeView = (activeBtn && activeBtn.dataset.view) || 'map-timeline';
        applyTravelView(activeView);
    }

    var urlQ = new URLSearchParams(window.location.search).get('q') || '';
    if (urlQ) { input.value = urlQ; runSearch(urlQ); }

    form.addEventListener('submit', function (e) {
        e.preventDefault();
        var q   = input.value.trim();
        var url = new URL(window.location.href);
        if (q) url.searchParams.set('q', q); else url.searchParams.delete('q');
        history.replaceState(null, '', url);
        runSearch(q);
    });

    input.addEventListener('input', function () {
        if (!input.value.trim()) runSearch('');
    });

    async function runSearch(q) {
        if (!q) {
            results.hidden = true;
            results.innerHTML = '';
            restoreListing();
            return;
        }
        setListingHidden(true);
        results.hidden = false;
        results.innerHTML = '<p class="hint">Searching…</p>';
        try {
            var res  = await fetch(API_BASE + '/search?q=' + encodeURIComponent(q) + '&type=travel&limit=20');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var data = await res.json();
            if (!data.results || !data.results.length) {
                results.innerHTML = '<p class="search-empty">No travel memories found.</p>';
                return;
            }
            results.innerHTML = '<ul class="search-result-list">' + data.results.map(function (r) {
                var href    = '/travel/post/?id=' + encodeURIComponent(r.id);
                var dateStr = r.post_date || r.published_at || '';
                return '<li class="search-result-item">' +
                    '<a href="' + escapeHtml(href) + '" class="search-result-link">' +
                        '<span class="search-result-title">' + highlight(r.title, q) + '</span>' +
                        (r.location ? '<span class="search-result-meta">' + escapeHtml(r.location) + '</span>' : '') +
                        (r.excerpt ? '<p class="search-result-excerpt">' + highlight(r.excerpt, q) + '</p>' : '') +
                        '<span class="search-result-meta">' + escapeHtml(formatVisitDate(dateStr) || '') + '</span>' +
                    '</a>' +
                '</li>';
            }).join('') + '</ul>';
        } catch (err) {
            console.error('[travel-search] failed:', err && (err.message || String(err)));
            results.innerHTML = '<p class="search-empty">Search failed — please try again.</p>';
        }
    }
})();
