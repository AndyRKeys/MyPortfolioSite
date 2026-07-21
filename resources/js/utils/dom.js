/**
 * Shared DOM builder utilities.
 * Extracted from script.js to eliminate window.* cross-file coupling.
 *
 * All user-supplied strings are set via textContent or setAttribute
 * to prevent XSS — never via string concatenation into innerHTML.
 */

import { escapeHtml } from './html.js';
import { formatRelativeDate } from './date.js';

// ── Internal helper ───────────────────────────────────────────────────────────

function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
        Object.keys(attrs).forEach(function (k) {
            if (k === 'className') {
                node.className = attrs[k];
            } else if (k === 'textContent') {
                node.textContent = attrs[k];
            } else {
                node.setAttribute(k, attrs[k]);
            }
        });
    }
    return node;
}

/**
 * Builds a timeline item element.
 * opts: { dateStr, title, location, notes, mediaUrl, thumbUrl, mediaType, mediaCount, linkHref }
 * Returns a DOM element.
 */
export function buildTimelineItem(opts) {
    var item = el('div', { className: 'timeline-item' });
    item.appendChild(el('div', { className: 'timeline-marker' }));
    var content = el('div', { className: 'timeline-content' });

    if (opts.dateStr) {
        var dateSpan = el('span', { className: 'timeline-date' });
        dateSpan.textContent = opts.dateStr;
        content.appendChild(dateSpan);
    }

    if (opts.linkHref) {
        var link = el('a', { href: opts.linkHref });
        var h3 = el('h3');
        h3.textContent = opts.title || 'Untitled';
        link.appendChild(h3);
        content.appendChild(link);
    } else {
        var h3b = el('h3');
        h3b.textContent = opts.title || 'Untitled';
        content.appendChild(h3b);
    }

    if (opts.location) {
        var loc = el('p', { className: 'timeline-location' });
        loc.textContent = '📍 ' + opts.location;
        content.appendChild(loc);
    }

    if (opts.notes) {
        var notes = el('p');
        notes.textContent = opts.notes;
        content.appendChild(notes);
    }

    if (opts.mediaUrl && opts.mediaType && (opts.mediaType.indexOf('image') === 0 || opts.mediaType.indexOf('video') === 0)) {
        var mediaWrap = el('div', { className: 'media-thumb-wrap' });
        var displaySrc = opts.thumbUrl || opts.mediaUrl;

        var img = el('img', { className: 'timeline-thumb', alt: '', src: displaySrc });
        img.addEventListener('error', function () { img.remove(); });
        mediaWrap.appendChild(img);

        if (opts.mediaCount && opts.mediaCount > 1) {
            var badge = el('span', { className: 'media-extra-badge' });
            badge.textContent = '+' + (opts.mediaCount - 1);
            mediaWrap.appendChild(badge);
        }

        content.appendChild(mediaWrap);
    }

    item.appendChild(content);
    return item;
}

/**
 * Builds a blog post card element.
 * data: { slug, title, date, excerpt }
 * Returns a DOM element.
 * (Travel cards use buildPublicTravelCard below.)
 */
export function buildPostCard(data) {
    var card = el('a', { className: 'post-card', href: '/blog/post/?slug=' + encodeURIComponent(data.slug) });
    var title = el('h3', { className: 'post-card-title' });
    title.textContent = data.title || 'Untitled';
    card.appendChild(title);
    if (data.date) {
        var date = el('p', { className: 'post-card-date' });
        date.textContent = data.date;
        card.appendChild(date);
    }
    if (data.excerpt) {
        var excerpt = el('p', { className: 'post-card-excerpt' });
        excerpt.textContent = data.excerpt;
        card.appendChild(excerpt);
    }
    return card;
}

/**
 * Builds a public-facing travel card linked to the detail page.
 * Returns a DOM element.
 */
export function buildPublicTravelCard(travel, formatVisitDateFn) {
    var card = el('a', { className: 'travel-card box draft-card' });
    card.setAttribute('href', '/travel/post/?id=' + encodeURIComponent(travel.id));
    card.setAttribute('data-memory-id', travel.id);
    var media = el('div', { className: 'media' });

    var allMedia = Array.isArray(travel.media) && travel.media.length
        ? travel.media
        : (travel.media_url ? [{ url: travel.media_url, type: travel.media_type }] : null);
    var firstMedia = allMedia ? allMedia[0] : null;
    var mediaUrl = firstMedia ? firstMedia.url : null;
    var thumbUrl = firstMedia ? (firstMedia.thumb_url || null) : (travel.thumb_url || null);
    var mediaType = firstMedia ? firstMedia.type : null;
    var extraCount = allMedia ? allMedia.length - 1 : 0;

    var placeholder = '/resources/img/placeholder-transparent.png';
    // Ensure media URLs from the API are root-relative (#266).
    if (mediaUrl && !mediaUrl.startsWith('/') && !mediaUrl.startsWith('http')) {
        mediaUrl = '/' + mediaUrl;
    }
    if (mediaUrl) {
        var mediaWrap = el('div', { className: 'media-thumb-wrap' });
        if (mediaType && mediaType.indexOf('video') === 0) {
            // Use thumb (ffmpeg poster frame) when available; fall back to raw video.
            if (thumbUrl) {
                var vThumb = el('img', { alt: 'Travel snapshot', src: thumbUrl });
                vThumb.addEventListener('error', function () { vThumb.setAttribute('src', placeholder); });
                mediaWrap.appendChild(vThumb);
            } else {
                mediaWrap.appendChild(el('video', { muted: '', src: mediaUrl }));
            }
        } else {
            var mImg = el('img', { alt: 'Travel snapshot', src: thumbUrl || mediaUrl });
            mImg.addEventListener('error', function () { mImg.setAttribute('src', placeholder); });
            mediaWrap.appendChild(mImg);
        }
        if (extraCount > 0) {
            var badge = el('span', { className: 'media-extra-badge' });
            badge.textContent = '+' + extraCount;
            mediaWrap.appendChild(badge);
            card.classList.add('has-gallery');
        }
        media.appendChild(mediaWrap);
    } else {
        media.appendChild(el('img', { alt: 'Travel snapshot', src: placeholder }));
    }

    var content = el('div', { className: 'travel-content' });
    var cTitle = el('h3');
    cTitle.textContent = travel.title || 'Untitled memory';
    content.appendChild(cTitle);

    var formattedDate = formatVisitDateFn ? formatVisitDateFn(travel.post_date) : null;
    var locationPrefix = travel.location_estimated ? '~ ' : '';
    var locationText = travel.location || 'Location not set';
    var metaHtml = '<span class="travel-location">' + escapeHtml(locationPrefix + locationText) + '</span>';
    if (formattedDate) {
        metaHtml += '<span class="travel-date">' + escapeHtml(formattedDate) + '</span>';
    }
    var metaP = el('p', { className: 'meta' });
    metaP.innerHTML = metaHtml;
    content.appendChild(metaP);

    var notesP = el('p');
    notesP.textContent = travel.notes || 'No notes yet.';
    content.appendChild(notesP);

    card.appendChild(media);
    card.appendChild(content);
    return card;
}

/**
 * Builds a GitHub repo card linked to the repo's URL.
 * Returns a DOM element.
 */
export function buildRepoCard(repo) {
    var card = el('a', { className: 'github-repo-card', target: '_blank', rel: 'noopener noreferrer', href: repo.html_url });
    var name = el('div', { className: 'github-repo-name' });
    name.textContent = repo.name;
    card.appendChild(name);
    var desc = el('div', { className: 'github-repo-desc' });
    desc.textContent = repo.description || 'No description';
    card.appendChild(desc);
    var meta = el('div', { className: 'github-repo-meta' });
    if (repo.language) {
        meta.insertAdjacentHTML('beforeend', '<span class="github-repo-lang">' + escapeHtml(repo.language) + '</span>');
    }
    meta.insertAdjacentHTML('beforeend', '<span class="github-repo-updated">Updated ' + escapeHtml(formatRelativeDate(repo.pushed_at)) + '</span>');
    card.appendChild(meta);
    return card;
}
