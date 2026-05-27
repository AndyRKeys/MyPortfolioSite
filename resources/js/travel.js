import { API_BASE } from './config.js';
import { escapeHtml } from './utils/html.js';
import { formatVisitDate } from './utils/date.js';
import { buildTimelineItem, buildPublicTravelCard } from './utils/dom.js';

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

// ── Gallery lightbox ──────────────────────────────────────────────────────────

var lightboxItems = [];
var lightboxIndex = 0;

function openLightbox(items, startIndex, title) {
    lightboxItems = items;
    lightboxIndex = startIndex || 0;
    var titleEl = document.querySelector('#travel-lightbox .lightbox-title');
    if (titleEl) titleEl.textContent = title || '';
    renderLightboxItem();
    document.getElementById('travel-lightbox').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closeLightbox() {
    document.getElementById('travel-lightbox').classList.add('hidden');
    document.body.style.overflow = '';
    document.querySelectorAll('#travel-lightbox video').forEach(function (v) { v.pause(); });
}

function renderLightboxItem() {
    var item = lightboxItems[lightboxIndex];
    var mediaContainer = document.querySelector('#travel-lightbox .lightbox-media');
    var mediaEl;
    if (item.type && item.type.indexOf('video') === 0) {
        mediaEl = document.createElement('video');
        mediaEl.controls = true;
        mediaEl.playsInline = true;
        mediaEl.src = item.url;
    } else {
        mediaEl = document.createElement('img');
        mediaEl.alt = 'Gallery image';
        mediaEl.src = item.url;
    }
    mediaContainer.innerHTML = '';
    mediaContainer.appendChild(mediaEl);

    var counter = document.querySelector('#travel-lightbox .lightbox-counter');
    if (counter) counter.textContent = (lightboxIndex + 1) + ' / ' + lightboxItems.length;

    var prevBtn = document.querySelector('#travel-lightbox .lightbox-prev');
    var nextBtn = document.querySelector('#travel-lightbox .lightbox-next');
    if (prevBtn) prevBtn.classList.toggle('hidden', lightboxIndex === 0);
    if (nextBtn) nextBtn.classList.toggle('hidden', lightboxIndex === lightboxItems.length - 1);
}

function initLightbox() {
    var lightbox = document.getElementById('travel-lightbox');
    if (!lightbox) return;

    var closeBtn = lightbox.querySelector('.lightbox-close');
    var prevBtn = lightbox.querySelector('.lightbox-prev');
    var nextBtn = lightbox.querySelector('.lightbox-next');

    if (closeBtn) closeBtn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); closeLightbox(); });
    if (prevBtn) prevBtn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); if (lightboxIndex > 0) { lightboxIndex--; renderLightboxItem(); } });
    if (nextBtn) nextBtn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); if (lightboxIndex < lightboxItems.length - 1) { lightboxIndex++; renderLightboxItem(); } });

    lightbox.addEventListener('click', function (e) { if (e.target === lightbox) closeLightbox(); });

    document.addEventListener('keydown', function (e) {
        if (lightbox.classList.contains('hidden')) return;
        if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
        else if (e.key === 'ArrowLeft' && lightboxIndex > 0) { e.preventDefault(); lightboxIndex--; renderLightboxItem(); }
        else if (e.key === 'ArrowRight' && lightboxIndex < lightboxItems.length - 1) { e.preventDefault(); lightboxIndex++; renderLightboxItem(); }
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
                var allMedia = Array.isArray(travel.media) && travel.media.length ? travel.media : null;
                var firstMedia = allMedia ? allMedia[0] : null;
                var mediaUrl = (firstMedia && firstMedia.url) || travel.media_url || travel.mediaUrl;
                var mediaType = (firstMedia && firstMedia.type) || travel.media_type || travel.mediaType;

                var item = buildTimelineItem({
                    dateStr: formatVisitDate(travel.post_date),
                    title: travel.title,
                    location: travel.location,
                    notes: travel.notes,
                    mediaUrl: mediaUrl,
                    mediaType: mediaType,
                    mediaCount: allMedia ? allMedia.length : 0,
                    linkHref: '/travel/post/?id=' + encodeURIComponent(travel.id),
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
        .catch(function () {
            document.getElementById('travel-empty').classList.remove('hidden');
            document.getElementById('travel-map').classList.add('hidden');
            document.querySelectorAll('.travel-view-toggle').forEach(function (el) { el.classList.add('hidden'); });
        });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

fetch(API_BASE + '/stats/visit?page=travel', { method: 'POST' }).catch(function () {});
loadPublicTravelPosts();
initLightbox();
