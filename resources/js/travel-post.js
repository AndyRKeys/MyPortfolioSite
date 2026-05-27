import { API_BASE } from './config.js';

// ── Lightbox state ────────────────────────────────────────────────────────────

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
    if (!item) return;
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

    if (closeBtn) {
        closeBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            closeLightbox();
        });
    }
    if (prevBtn) {
        prevBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (lightboxIndex > 0) { lightboxIndex--; renderLightboxItem(); }
        });
    }
    if (nextBtn) {
        nextBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (lightboxIndex < lightboxItems.length - 1) { lightboxIndex++; renderLightboxItem(); }
        });
    }

    lightbox.addEventListener('click', function (e) {
        if (e.target === lightbox) closeLightbox();
    });

    document.addEventListener('keydown', function (e) {
        if (lightbox.classList.contains('hidden')) return;
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
        .then(function (travel) {
            renderTravelPost(travel);
            // Fire-and-forget visit counter — only on a successful post load.
            fetch(API_BASE + '/stats/visit?page=travel', { method: 'POST' }).catch(function () {});
        })
        .catch(function () { showError(); });
}

function renderTravelPost(travel) {
    document.title = (travel.title || 'Travel Memory') + ' | AK Portfolio';
    document.getElementById('post-header-title').textContent = travel.title || 'Travel Memory';
    document.getElementById('post-title').textContent = travel.title || 'Travel Memory';

    var locationPrefix = travel.location_estimated ? '~ ' : '';
    var locationText = travel.location ? locationPrefix + travel.location : '';
    document.getElementById('post-location').textContent = locationText;

    document.getElementById('post-date').textContent = formatVisitDate(travel.post_date);

    var allMedia = Array.isArray(travel.media) && travel.media.length
        ? travel.media
        : (travel.media_url ? [{ url: travel.media_url, type: travel.media_type }] : []);

    var gallery = document.getElementById('post-media-gallery');
    gallery.innerHTML = '';
    if (allMedia.length > 0) {
        allMedia.forEach(function (item, idx) {
            var thumb = document.createElement('div');
            thumb.className = 'gallery-thumb';
            if (item.type && item.type.indexOf('video') === 0) {
                var video = document.createElement('video');
                video.muted = true;
                video.src = item.url;
                thumb.appendChild(video);
            } else {
                var img = document.createElement('img');
                img.alt = 'Travel media';
                img.src = item.url;
                thumb.appendChild(img);
            }
            thumb.addEventListener('click', function () {
                openLightbox(allMedia, idx, travel.title);
            });
            gallery.appendChild(thumb);
        });
    }

    document.getElementById('post-notes').textContent = travel.notes || '';

    document.getElementById('post-loading').classList.add('hidden');
    document.getElementById('post-body').classList.remove('hidden');

    if (travel.lat != null && travel.lng != null) {
        var lat = parseFloat(travel.lat);
        var lng = parseFloat(travel.lng);
        var mapEl = document.getElementById('post-map');
        mapEl.style.display = 'block';
        requestAnimationFrame(function () {
            var map = L.map(mapEl).setView([lat, lng], 13);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors',
                maxZoom: 19,
            }).addTo(map);
            L.marker([lat, lng]).addTo(map);
            map.invalidateSize();
        });
    }
}

function showError() {
    document.getElementById('post-loading').classList.add('hidden');
    document.getElementById('post-error').classList.remove('hidden');
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

initLightbox();
loadTravelPost();
