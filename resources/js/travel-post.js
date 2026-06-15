import { API_BASE } from './config.js';
import { openLightbox, initLightbox } from './utils/lightbox.js';
import { recordVisit } from './utils/stats.js';

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
            recordVisit('travel');
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
