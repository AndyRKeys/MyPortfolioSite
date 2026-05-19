import { API_BASE } from './config.js';
import { escapeHtml } from './utils/html.js';
import { formatVisitDate } from './utils/date.js';
import { buildTimelineItem, buildPublicTravelCard } from './utils/dom.js';

// ── Travel map (Leaflet)

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
    var mapEl = $('#travel-map');
    var grid = $('#travel-grid');
    var timeline = $('#travel-timeline');

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
    var activeView = $('.travel-view-toggle .view-toggle-btn.active').data('view') || 'map-timeline';
    applyTravelView(activeView);

    $('.travel-view-toggle .view-toggle-btn').on('click', function () {
        var view = $(this).data('view');
        $('.travel-view-toggle .view-toggle-btn').removeClass('active').attr('aria-selected', 'false');
        $(this).addClass('active').attr('aria-selected', 'true');
        applyTravelView(view);
    });
}

// ── Gallery lightbox

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

// ── Travel cards

function loadPublicTravelPosts() {
    var travelGrid = $('#travel-grid');
    if (!travelGrid.length) return;

    fetch(API_BASE + '/travel')
        .then(function (res) {
            if (!res.ok) throw new Error('Failed to load');
            return res.json();
        })
        .then(function (memories) {
            if (!memories.length) {
                $('#travel-empty').removeClass('hidden');
                $('#travel-map').addClass('hidden');
                $('.travel-view-toggle').addClass('hidden');
                return;
            }

            memories.forEach(function (travel) {
                travelGrid.append(buildPublicTravelCard(travel, formatVisitDate));
            });

            var sorted = memories.slice().sort(function (a, b) {
                var da = a.visit_date ? String(a.visit_date).slice(0, 10) : '';
                var db = b.visit_date ? String(b.visit_date).slice(0, 10) : '';
                return db < da ? -1 : db > da ? 1 : 0;
            });
            var timelineEl = $('#travel-timeline');
            sorted.forEach(function (travel) {
                var allMedia = Array.isArray(travel.media) && travel.media.length ? travel.media : null;
                var firstMedia = allMedia ? allMedia[0] : null;
                var mediaUrl = (firstMedia && firstMedia.url) || travel.media_url || travel.mediaUrl;
                var mediaType = (firstMedia && firstMedia.type) || travel.media_type || travel.mediaType;

                var item = buildTimelineItem({
                    dateStr: formatVisitDate(travel.visit_date),
                    title: travel.title,
                    location: travel.location,
                    notes: travel.notes,
                    mediaUrl: mediaUrl,
                    mediaType: mediaType,
                    mediaCount: allMedia ? allMedia.length : 0,
                    linkHref: '/travel/post/?id=' + encodeURIComponent(travel.id),
                });

                item.find('.media-thumb-wrap').css('cursor', 'pointer').on('click', function () {
                    window.location.href = '/travel/post/?id=' + encodeURIComponent(travel.id);
                });

                timelineEl.append(item);
            });

            // All containers must be populated before initViewToggle wires the buttons.
            initTravelMap(memories);
            initViewToggle();
        })
        .catch(function () {
            $('#travel-empty').removeClass('hidden');
            $('#travel-map').addClass('hidden');
            $('.travel-view-toggle').addClass('hidden');
        });
}

// ── Bootstrap
fetch(API_BASE + '/stats/visit?page=travel', { method: 'POST' }).catch(function () {});
loadPublicTravelPosts();
initLightbox();
