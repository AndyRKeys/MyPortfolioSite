/**
 * Shared DOM builder utilities.
 * Extracted from script.js to eliminate window.* cross-file coupling.
 *
 * All user-supplied strings are set via jQuery .text() or .attr()
 * to prevent XSS — never via string concatenation into HTML.
 *
 * Depends on jQuery ($) being available as a global (loaded via <script> tag
 * before any module entry point).
 */

import { escapeHtml } from './html.js';
import { formatRelativeDate } from './date.js';

/**
 * Builds a timeline item element.
 * opts: { dateStr, title, location, notes, mediaUrl, mediaType, mediaCount, linkHref }
 */
export function buildTimelineItem(opts) {
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

        if (opts.mediaCount && opts.mediaCount > 1) {
            var extraCount = opts.mediaCount - 1;
            mediaWrap.append('<span class="media-extra-badge">+' + extraCount + '</span>');
        }

        content.append(mediaWrap);
    }

    item.append(content);
    return item;
}

/**
 * Builds a post card element.
 * type: 'blog' | 'travel'
 * data (blog):   { slug, title, date, excerpt }
 * data (travel): { id, title, location, date, notes, mediaUrl, mediaType }
 */
export function buildPostCard(type, data) {
    if (type === 'blog') {
        var card = $('<a class="post-card"></a>');
        card.attr('href', '/blog/post/?slug=' + encodeURIComponent(data.slug));
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
    var placeholder = '/resources/img/placeholder-transparent.png';
    var tCard = $('<article class="travel-card box draft-card"></article>');
    tCard.attr('data-memory-id', data.id);

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

    tCard.append(media).append(content);
    return tCard;
}

/**
 * Builds a public-facing travel card linked to the detail page.
 * Uses escapeHtml for interpolated HTML fragments (meta/notes).
 */
export function buildPublicTravelCard(travel, formatVisitDateFn) {
    var card = $('<a class="travel-card box draft-card"></a>');
    card.attr('href', '/travel/post/?id=' + encodeURIComponent(travel.id));
    card.attr('data-memory-id', travel.id);
    var media = $('<div class="media"></div>');

    var allMedia = Array.isArray(travel.media) && travel.media.length
        ? travel.media
        : (travel.media_url ? [{ url: travel.media_url, type: travel.media_type }] : null);
    var firstMedia = allMedia ? allMedia[0] : null;
    var mediaUrl = firstMedia ? firstMedia.url : null;
    var mediaType = firstMedia ? firstMedia.type : null;
    var extraCount = allMedia ? allMedia.length - 1 : 0;

    var placeholder = '/resources/img/placeholder-transparent.png';
    if (mediaUrl) {
        var mediaWrap = $('<div class="media-thumb-wrap"></div>');
        if (mediaType && mediaType.indexOf('video') === 0) {
            mediaWrap.append($('<video muted></video>').attr('src', mediaUrl));
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
        $('<img alt="Travel snapshot">').attr('src', placeholder).appendTo(media);
    }

    var content = $('<div class="travel-content"></div>');
    $('<h3></h3>').text(travel.title || 'Untitled memory').appendTo(content);

    var formattedDate = formatVisitDateFn ? formatVisitDateFn(travel.visit_date) : null;
    var locationPrefix = travel.location_estimated ? '~ ' : '';
    var locationText = travel.location || 'Location not set';
    var metaHtml = '<span class="travel-location">' + escapeHtml(locationPrefix + locationText) + '</span>';
    if (formattedDate) {
        metaHtml += '<span class="travel-date">' + escapeHtml(formattedDate) + '</span>';
    }
    content.append('<p class="meta">' + metaHtml + '</p>');
    $('<p></p>').text(travel.notes || 'No notes yet.').appendTo(content);

    card.append(media).append(content);
    return card;
}

/**
 * Builds a GitHub repo card linked to the repo's URL.
 */
export function buildRepoCard(repo) {
    var card = $('<a class="github-repo-card" target="_blank" rel="noopener noreferrer"></a>');
    card.attr('href', repo.html_url);
    $('<div class="github-repo-name"></div>').text(repo.name).appendTo(card);
    $('<div class="github-repo-desc"></div>').text(repo.description || 'No description').appendTo(card);
    var meta = $('<div class="github-repo-meta"></div>');
    if (repo.language) {
        meta.append('<span class="github-repo-lang">' + escapeHtml(repo.language) + '</span>');
    }
    meta.append('<span class="github-repo-updated">Updated ' + escapeHtml(formatRelativeDate(repo.pushed_at)) + '</span>');
    card.append(meta);
    return card;
}
