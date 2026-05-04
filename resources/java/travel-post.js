var API_BASE = '/api';

// ── Lightbox state ────────────────────────────────────────────────────────────
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
    if (!item) return;
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
        if (e.target.id === 'travel-lightbox') closeLightbox();
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
        } else if (e.key === 'ArrowLeft' && lightboxIndex > 0) {
            e.preventDefault();
            lightboxIndex--;
            renderLightboxItem();
        } else if (e.key === 'ArrowRight' && lightboxIndex < lightboxItems.length - 1) {
            e.preventDefault();
            lightboxIndex++;
            renderLightboxItem();
        }
    });
}

// ── Page loader ───────────────────────────────────────────────────────────────
function getId() {
    var params = new URLSearchParams(window.location.search);
    return params.get('id');
}

function formatVisitDate(d) {
    if (!d) return '';
    var dateObj = new Date(String(d).slice(0, 10) + 'T00:00:00');
    if (isNaN(dateObj)) return '';
    return dateObj.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
}

function loadTravelPost() {
    var id = getId();
    if (!id) {
        showError();
        return;
    }

    fetch(API_BASE + '/travel/' + encodeURIComponent(id))
        .then(function (res) {
            if (!res.ok) throw new Error('not found');
            return res.json();
        })
        .then(renderTravelPost)
        .catch(function () { showError(); });
}

function renderTravelPost(travel) {
    document.title = (travel.title || 'Travel Memory') + ' | AK Portfolio';
    document.getElementById('post-header-title').textContent = travel.title || 'Travel Memory';
    document.getElementById('post-title').textContent = travel.title || 'Travel Memory';

    var locationPrefix = travel.location_estimated ? '~ ' : '';
    var locationText = travel.location ? locationPrefix + travel.location : '';
    document.getElementById('post-location').textContent = locationText;

    var dateText = formatVisitDate(travel.visit_date);
    document.getElementById('post-date').textContent = dateText;

    // Render media gallery
    var allMedia = Array.isArray(travel.media) && travel.media.length
        ? travel.media
        : (travel.media_url ? [{ url: travel.media_url, type: travel.media_type }] : []);

    var gallery = $('#post-media-gallery');
    gallery.empty();
    if (allMedia.length > 0) {
        allMedia.forEach(function (item, idx) {
            var thumb = $('<div class="gallery-thumb"></div>');
            if (item.type && item.type.indexOf('video') === 0) {
                thumb.append($('<video src="' + item.url + '" muted></video>'));
            } else {
                thumb.append($('<img alt="Travel media">').attr('src', item.url));
            }
            thumb.on('click', function () {
                openLightbox(allMedia, idx, travel.title);
            });
            gallery.append(thumb);
        });
    }

    // Render notes (plain text, not markdown for travel)
    var notesEl = document.getElementById('post-notes');
    notesEl.textContent = travel.notes || '';

    // Render map if coordinates exist
    if (travel.lat != null && travel.lng != null) {
        var mapEl = document.getElementById('post-map');
        mapEl.style.display = 'block';
        var map = L.map(mapEl).setView([parseFloat(travel.lat), parseFloat(travel.lng)], 11);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors',
            maxZoom: 19,
        }).addTo(map);
        L.marker([parseFloat(travel.lat), parseFloat(travel.lng)]).addTo(map);
    }

    document.getElementById('post-loading').classList.add('hidden');
    document.getElementById('post-body').classList.remove('hidden');
}

function showError() {
    document.getElementById('post-loading').classList.add('hidden');
    document.getElementById('post-error').classList.remove('hidden');
}

$(document).ready(function () {
    initLightbox();
    loadTravelPost();
});
