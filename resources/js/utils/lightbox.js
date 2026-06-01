// ── Shared lightbox — used by travel.js and travel-post.js ───────────────────
// Operates against the fixed #travel-lightbox element present on both pages.

var lightboxItems = [];
var lightboxIndex = 0;

export function openLightbox(items, startIndex, title) {
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

export function initLightbox() {
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
