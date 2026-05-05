import { startRegistration } from 'https://esm.sh/@simplewebauthn/browser@7';
import exifr from 'https://esm.sh/exifr@7.1.3';
import { API_BASE } from './config.js';

// ── Auth helpers ────────────────────────────────────────────────────────────────────────────────

function getToken() {
    return localStorage.getItem('adminToken');
}

function isAuthenticated() {
    const token = getToken();
    if (!token) return false;
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        return payload.exp * 1000 > Date.now();
    } catch {
        return false;
    }
}

function requireAuth() {
    if (!isAuthenticated()) location.replace('login.html');
}

function authFetch(path, opts = {}) {
    return fetch(`${API_BASE}${path}`, {
        ...opts,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${getToken()}`,
            ...(opts.headers || {}),
        },
    });
}

// For multipart uploads — lets the browser set the correct Content-Type boundary
function authFetchMultipart(path, formData) {
    return fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${getToken()}` },
        body: formData,
    });
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function todayIso() {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

// ── Passkey management ──────────────────────────────────────────────────────────────────

async function loadPasskeys() {
    const container = document.getElementById('passkey-list');
    try {
        const res = await authFetch('/auth/passkeys');
        const passkeys = await res.json();
        if (!passkeys.length) {
            container.innerHTML = '<p class="hint">No passkeys registered yet.</p>';
            return;
        }
        container.innerHTML = passkeys.map(pk => `
            <div class="passkey-row" data-id="${pk.id}">
                <span class="passkey-name">${escapeHtml(pk.name)}</span>
                <span class="passkey-meta">${pk.device_type || 'unknown'} &mdash; added ${new Date(pk.created_at).toLocaleDateString()}</span>
                <button class="passkey-delete-btn" data-id="${pk.id}" type="button">Remove</button>
            </div>
        `).join('');
        container.querySelectorAll('.passkey-delete-btn').forEach(btn => {
            btn.addEventListener('click', () => deletePasskey(btn.dataset.id));
        });
    } catch {
        container.innerHTML = '<p class="hint" style="color:var(--color-error)">Failed to load passkeys.</p>';
    }
}

async function deletePasskey(id) {
    if (!confirm('Remove this passkey? You will not be able to use it to sign in.')) return;
    setPasskeyMessage('');
    try {
        const res = await authFetch(`/auth/passkeys/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Delete failed');
        await loadPasskeys();
    } catch {
        setPasskeyMessage('Failed to remove passkey.', true);
    }
}

async function addPasskey() {
    const btn = document.getElementById('add-passkey-btn');
    btn.disabled = true;
    setPasskeyMessage('Follow the passkey prompt on your device…');
    try {
        const startRes = await authFetch('/auth/passkey/register/start', { method: 'POST', body: JSON.stringify({}) });
        const { options, sessionKey } = await startRes.json();
        const response = await startRegistration(options);
        const name = prompt('Give this passkey a name (e.g. "MacBook", "iPhone"):') || 'My passkey';
        const finishRes = await authFetch('/auth/passkey/register/finish', {
            method: 'POST',
            body: JSON.stringify({ response, sessionKey, passkeyName: name }),
        });
        const data = await finishRes.json();
        if (!finishRes.ok) throw new Error(data.error || 'Registration failed');
        setPasskeyMessage('Passkey added successfully.');
        await loadPasskeys();
    } catch (err) {
        setPasskeyMessage(
            err.name === 'NotAllowedError' ? 'Passkey prompt was cancelled.' : (err.message || 'Failed to add passkey.'),
            true
        );
    } finally {
        btn.disabled = false;
    }
}

function setPasskeyMessage(msg, isError = false) {
    const el = document.getElementById('passkey-message');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? 'var(--color-error)' : 'var(--color-success)';
}

// ── Travel memories ─────────────────────────────────────────────────────────────────────

let pendingFiles = [];         // File objects queued for upload
let existingMedia = [];        // {id, url, type} from post_media (on edit)
let removedMediaIds = [];      // post_media ids to delete on save
let geoconfirmMap = null;      // Leaflet map for coordinate confirmation
let geoconfirmMarker = null;   // Leaflet marker on confirmation map

function renderMediaList() {
    const list = $('#travel-media-list');
    list.empty();

    const allItems = [
        ...existingMedia.map(m => ({ kind: 'existing', ...m })),
        ...pendingFiles.map((f, i) => ({ kind: 'pending', index: i, name: f.name, type: f.type })),
    ];

    if (!allItems.length) { list.addClass('hidden'); return; }
    list.removeClass('hidden');

    allItems.forEach(item => {
        const row = $('<div class="media-list-row"></div>');
        const icon = item.type && item.type.startsWith('video') ? '🎦' : '🖼';
        const label = item.kind === 'existing'
            ? `${icon} ${item.url.split('/').pop()}`
            : `${icon} ${item.name} (pending)`;
        row.append('<span class="media-list-label">' + escapeHtml(label) + '</span>');
        const removeBtn = $('<button type="button" class="btn-small media-remove-btn">Remove</button>');
        if (item.kind === 'existing') {
            removeBtn.on('click', () => {
                removedMediaIds.push(item.id);
                existingMedia = existingMedia.filter(m => m.id !== item.id);
                renderMediaList();
            });
        } else {
            removeBtn.on('click', () => {
                pendingFiles.splice(item.index, 1);
                renderMediaList();
                if (!pendingFiles.length && !existingMedia.length) {
                    $('.file-input-label').text('No files chosen');
                }
            });
        }
        row.append(removeBtn);
        list.append(row);
    });
}

function clearTravelForm() {
    $('#travel-edit-id').val('');
    $('#travel-form')[0].reset();
    $('#travel-cancel-btn').addClass('hidden');
    $('.file-input-label').text('No files chosen');
    $('#travel-date').val(todayIso());
    $('#travel-preview').addClass('hidden');
    $('.preview-media').empty();
    $('.preview-text').empty();
    pendingFiles = [];
    existingMedia = [];
    removedMediaIds = [];
    renderMediaList();
    setTravelMessage('');
    hideGeoconfirmMap();
}

function buildSavedMemoryRow(memory) {
    const div = $('<div class="saved-memory-row"></div>');
    const info = $('<div class="saved-memory-info"></div>');
    const statusLabel = memory.published_at
        ? '<span class="post-status published">Published</span>'
        : '<span class="post-status draft">Draft</span>';
    info.append('<strong>' + escapeHtml(memory.title) + '</strong> ' + statusLabel);
    if (memory.location) info.append('<span class="saved-memory-location"> — ' + escapeHtml(memory.location) + '</span>');
    info.append('<span class="saved-memory-date"> · ' + new Date(memory.created_at).toLocaleDateString() + '</span>');

    const actions = $('<div class="post-admin-actions"></div>');
    const editBtn = $('<button type="button" class="btn-small">Edit</button>');
    editBtn.on('click', () => loadTravelForEdit(memory));

    const toggleBtn = $('<button type="button" class="btn-small">' + (memory.published_at ? 'Unpublish' : 'Publish') + '</button>');
    toggleBtn.on('click', () => toggleTravelPublish(memory));

    const delBtn = $('<button type="button" class="travel-delete-btn">Delete</button>');
    delBtn.on('click', () => deleteTravelMemory(memory.id));

    actions.append(editBtn).append(toggleBtn).append(delBtn);
    div.append(info).append(actions);
    return div;
}

async function loadTravelMemories() {
    const list = $('#saved-memories-list');
    list.html('<p class="hint">Loading…</p>');
    try {
        const res = await authFetch('/travel/all');
        if (!res.ok) throw new Error();
        const memories = await res.json();
        if (!memories.length) { list.html('<p class="hint">No travel memories saved yet.</p>'); return; }
        list.empty();
        memories.forEach(m => list.append(buildSavedMemoryRow(m)));
    } catch {
        list.html('<p class="hint" style="color:var(--color-error)">Failed to load memories.</p>');
    }
}

// #93 fix: slice ISO timestamp to YYYY-MM-DD before setting date input
async function loadTravelForEdit(memory) {
    try {
        const res = await authFetch(`/travel/admin/${memory.id}`);
        if (!res.ok) throw new Error();
        const full = await res.json();

        $('#travel-edit-id').val(full.id);
        $('#travel-title').val(full.title || '');
        $('#travel-location').val(full.location || '');
        $('#travel-notes').val(full.notes || '');
        // Slice to YYYY-MM-DD — full ISO timestamps like 2026-05-04T00:00:00.000Z
        // are not accepted by <input type="date"> and silently clear the field (#93)
        $('#travel-date').val(full.visit_date ? String(full.visit_date).slice(0, 10) : todayIso());
        $('#travel-lat').val(full.lat != null ? full.lat : '');
        $('#travel-lng').val(full.lng != null ? full.lng : '');

        pendingFiles = [];
        removedMediaIds = [];
        existingMedia = Array.isArray(full.media) && full.media.length
            ? full.media.map(m => ({ id: m.id, url: m.url, type: m.type }))
            : (full.media_url ? [{ id: null, url: full.media_url, type: full.media_type }] : []);
        $('.file-input-label').text('No files chosen');
        renderMediaList();

        // Show confirmation map if coords already exist on this memory
        if (full.lat != null && full.lng != null) {
            updateGeoconfirmMap(parseFloat(full.lat), parseFloat(full.lng));
        }

        $('#travel-preview').addClass('hidden');
        $('#travel-cancel-btn').removeClass('hidden');
        setTravelMessage('Editing: ' + full.title);
        document.getElementById('travel-title').scrollIntoView({ behavior: 'smooth' });
    } catch {
        setTravelMessage('Failed to load memory for editing.', true);
    }
}

async function toggleTravelPublish(memory) {
    try {
        const res = await authFetch(`/travel/${memory.id}`, {
            method: 'PUT',
            body: JSON.stringify({
                title: memory.title,
                location: memory.location || '',
                notes: memory.notes || '',
                visitDate: memory.visit_date || null,
                lat: memory.lat,
                lng: memory.lng,
                publish: !memory.published_at,
                // mediaItems undefined → backend leaves existing post_media untouched
            }),
        });
        if (!res.ok) throw new Error();
        await loadTravelMemories();
    } catch {
        alert('Failed to update memory.');
    }
}

async function deleteTravelMemory(id) {
    if (!confirm('Delete this travel memory? This cannot be undone.')) return;
    try {
        const res = await authFetch(`/travel/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error();
        await loadTravelMemories();
    } catch {
        alert('Failed to delete memory.');
    }
}

function setTravelMessage(msg, isError = false, isHint = false) {
    const el = document.getElementById('travel-message');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? 'var(--color-error)' : isHint ? 'var(--color-text-muted)' : 'var(--color-success)';
}

// ── Geocode confirmation map ─────────────────────────────────────────────────────────────────────────

function updateGeoconfirmMap(lat, lng) {
    if (!window.L) return;
    const mapEl = document.getElementById('geoconfirm-map');
    if (!mapEl) return;

    mapEl.classList.remove('hidden');

    if (!geoconfirmMap) {
        geoconfirmMap = L.map('geoconfirm-map', { scrollWheelZoom: false, zoomControl: true });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 18,
            attribution: '\u00a9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(geoconfirmMap);
    }

    const latlng = [lat, lng];
    geoconfirmMap.setView(latlng, 10);

    if (geoconfirmMarker) {
        geoconfirmMarker.setLatLng(latlng);
    } else {
        geoconfirmMarker = L.marker(latlng).addTo(geoconfirmMap);
    }

    // Leaflet needs a size nudge after becoming visible
    setTimeout(() => geoconfirmMap.invalidateSize(), 50);
}

function hideGeoconfirmMap() {
    const mapEl = document.getElementById('geoconfirm-map');
    if (mapEl) mapEl.classList.add('hidden');
    if (geoconfirmMarker && geoconfirmMap) {
        geoconfirmMap.removeLayer(geoconfirmMarker);
        geoconfirmMarker = null;
    }
}

// ── EXIF GPS autofill ──────────────────────────────────────────────────────────────────────────────

// Returns true only if coords are finite numbers and not the null-island 0,0
// that DJI and some cameras emit when GPS is unavailable.
function hasValidGps(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);
}

// Reverse geocode lat/lng to a human-readable location string using Nominatim.
// Only populates the Location field if it is currently empty.
async function reverseGeocodeToLocation(lat, lng) {
    if ($('#travel-location').val().trim()) return; // don't overwrite manual input
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10&addressdetails=1`;
        const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
        if (!res.ok) return;
        const data = await res.json();
        if (!data.address) return;

        // Build a compact "City, Country" style string from available address parts
        const a = data.address;
        const city = a.city || a.town || a.village || a.hamlet || a.county || a.state_district || a.state || '';
        const country = a.country || '';
        const locationStr = [city, country].filter(Boolean).join(', ');

        if (locationStr) {
            $('#travel-location').val(locationStr);
        }
    } catch {
        // Reverse geocode failure is non-fatal — silently ignore
    }
}

// Extract GPS from a single file without setting the form.
async function extractGpsFromFile(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return null;
    try {
        let gps = null;
        try {
            const tags = await exifr.parse(file, { gps: true });
            if (tags && hasValidGps(tags.latitude, tags.longitude)) {
                gps = { latitude: tags.latitude, longitude: tags.longitude };
            }
        } catch { /* fall through to exifr.gps() */ }

        if (!gps) {
            const raw = await exifr.gps(file);
            if (raw && hasValidGps(raw.latitude, raw.longitude)) {
                gps = raw;
            }
        }
        return gps;
    } catch {
        return null;
    }
}

// Try to read GPS coords from image EXIF and populate the lat/lng inputs.
async function tryAutofillGpsFromFile(file) {
    const gps = await extractGpsFromFile(file);
    if (gps) {
        $('#travel-lat').val(gps.latitude.toFixed(6));
        $('#travel-lng').val(gps.longitude.toFixed(6));
        setTravelMessage('GPS auto-filled from photo EXIF.');
        updateGeoconfirmMap(gps.latitude, gps.longitude);
        await reverseGeocodeToLocation(gps.latitude, gps.longitude);
    } else {
        setTravelMessage('No GPS data in photo — enter coordinates manually or use Geocode.', false, true);
    }
}

// Loop through sorted files to find the first one with valid GPS coords.
async function tryAutofillGpsFromFileList(files) {
    // Sort by filename for consistent results across different selection orders
    const sortedImages = files
        .filter(f => f.type && f.type.startsWith('image/'))
        .sort((a, b) => a.name.localeCompare(b.name));

    for (const file of sortedImages) {
        const gps = await extractGpsFromFile(file);
        if (gps) {
            $('#travel-lat').val(gps.latitude.toFixed(6));
            $('#travel-lng').val(gps.longitude.toFixed(6));
            setTravelMessage(`GPS auto-filled from ${file.name}.`);
            updateGeoconfirmMap(gps.latitude, gps.longitude);
            await reverseGeocodeToLocation(gps.latitude, gps.longitude);
            return; // Stop after finding the first valid one
        }
    }

    // None of the images had valid GPS
    setTravelMessage('No GPS data in any photo — enter coordinates manually or use Geocode.', false, true);
}

async function geocodeLocation() {
    const q = $('#travel-location').val().trim();
    if (!q) {
        setTravelMessage('Enter a location name first.', true);
        return;
    }
    const btn = document.getElementById('geocode-btn');
    btn.disabled = true;
    btn.textContent = 'Looking up…';
    setTravelMessage('');
    try {
        const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q);
        const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
        const results = await res.json();
        if (!results.length) {
            setTravelMessage('Location not found — try a more specific name.', true);
            return;
        }
        const { lat, lon, display_name } = results[0];
        const parsedLat = parseFloat(lat);
        const parsedLng = parseFloat(lon);
        $('#travel-lat').val(parsedLat.toFixed(6));
        $('#travel-lng').val(parsedLng.toFixed(6));
        setTravelMessage(`Coordinates set — confirm pin location on the map below (matched: ${display_name.split(',').slice(0, 3).join(',')}).`, false, true);
        updateGeoconfirmMap(parsedLat, parsedLng);
    } catch {
        setTravelMessage('Geocode failed — check your connection and try again.', true);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Geocode';
    }
}

// Try to read DateTimeOriginal from image EXIF and populate the date input.
async function tryAutofillDateFromFile(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return;
    const currentVal = $('#travel-date').val();
    if (currentVal && currentVal !== todayIso()) return;
    try {
        const tags = await exifr.parse(file, ['DateTimeOriginal']);
        if (tags && tags.DateTimeOriginal instanceof Date) {
            const d = tags.DateTimeOriginal;
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            $('#travel-date').val(`${yyyy}-${mm}-${dd}`);
        }
    } catch {
        // EXIF date unavailable — ignore
    }
}

function initTravelForm() {
    $('#geocode-btn').on('click', function () {
        geocodeLocation();
    });

    // Update confirmation map when coords are changed manually
    $('#travel-lat, #travel-lng').on('change input', function () {
        const lat = parseFloat($('#travel-lat').val());
        const lng = parseFloat($('#travel-lng').val());
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            updateGeoconfirmMap(lat, lng);
        } else {
            hideGeoconfirmMap();
        }
    });

    $('#travel-file').on('change', function (event) {
        const files = Array.from(event.target.files || []);
        if (!files.length) return;

        // EXIF auto-fill: loop through sorted images to find first with valid GPS
        tryAutofillGpsFromFileList(files);

        // Date auto-fill from first image by filename (for consistency)
        const sortedImages = files
            .filter(f => f.type && f.type.startsWith('image/'))
            .sort((a, b) => a.name.localeCompare(b.name));
        if (sortedImages.length) {
            tryAutofillDateFromFile(sortedImages[0]);
        }

        pendingFiles = pendingFiles.concat(files);
        $('.file-input-label').text(pendingFiles.length + ' file' + (pendingFiles.length !== 1 ? 's' : '') + ' selected');
        // Reset the input so the same file can be re-added if removed
        event.target.value = '';
        renderMediaList();
    });

    $('#travel-form').on('submit', async function (event) {
        event.preventDefault();
        const clickedBtn = document.activeElement;
        const publish = clickedBtn && clickedBtn.id === 'travel-publish-btn';
        const submitBtns = $(this).find('button[type="submit"]');
        submitBtns.prop('disabled', true);
        setTravelMessage('Saving…');

        const title = $('#travel-title').val().trim();
        if (!title) {
            setTravelMessage('Title is required.', true);
            submitBtns.prop('disabled', false);
            return;
        }

        try {
            // Upload all pending files
            const uploadedItems = [];
            for (let i = 0; i < pendingFiles.length; i++) {
                setTravelMessage(`Uploading file ${i + 1} of ${pendingFiles.length}…`);
                const fd = new FormData();
                fd.append('file', pendingFiles[i]);
                const upRes = await authFetchMultipart('/upload', fd);
                const upData = await upRes.json();
                if (!upRes.ok) throw new Error(upData.error || 'Upload failed');
                uploadedItems.push({ url: upData.url, type: upData.type });
            }

            // Combine: remaining existing media first, then newly uploaded
            const mediaItems = [
                ...existingMedia.filter(m => m.id !== null).map(m => ({ url: m.url, type: m.type })),
                ...uploadedItems,
            ];

            const editId = $('#travel-edit-id').val();
            const travel = {
                title,
                location: $('#travel-location').val().trim(),
                notes: $('#travel-notes').val().trim(),
                visitDate: $('#travel-date').val() || null,
                mediaItems,
                lat: $('#travel-lat').val(),
                lng: $('#travel-lng').val(),
                publish,
            };

            const method = editId ? 'PUT' : 'POST';
            const path = editId ? `/travel/${editId}` : '/travel';
            const res = await authFetch(path, { method, body: JSON.stringify(travel) });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Save failed');
            setTravelMessage(publish ? 'Memory published.' : 'Draft saved.');
            clearTravelForm();
            await loadTravelMemories();
        } catch (err) {
            setTravelMessage(err.message || 'Failed to save memory.', true);
        } finally {
            submitBtns.prop('disabled', false);
        }
    });

    $('#travel-cancel-btn').on('click', clearTravelForm);
    $('#travel-clear').on('click', function () {
        if ($('#travel-edit-id').val() || $('#travel-title').val() || $('#travel-location').val() || $('#travel-notes').val() || pendingFiles.length) {
            if (!confirm('Clear all fields and start a new memory?')) return;
        }
        clearTravelForm();
    });
}

// ── Blog posts ─────────────────────────────────────────────────────────────────────────────────

const POST_TEMPLATE = `_Short tagline or subtitle._

## Introduction

Open with the why — what prompted this post and what the reader will get out of it.

## Main idea

The core of the piece. Use **bold** for emphasis, _italics_ for nuance, and short paragraphs for rhythm.

> A pull quote or callout that anchors the section.

\`\`\`js
// inline code samples render in a monospaced block
function example() { return 'hello'; }
\`\`\`

- Bullet one
- Bullet two
- Bullet three

## Wrap-up

End with a takeaway, a question, or a link to what\'s next.
`;

function setPostMessage(msg, isError = false) {
    const el = document.getElementById('post-message');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? 'var(--color-error)' : 'var(--color-success)';
}

function clearPostForm() {
    $('#post-edit-id').val('');
    $('#post-title').val('');
    $('#post-body').val('');
    // #93 fix: default to today so the date field is never blank on a new post
    $('#post-date').val(todayIso());
    $('#post-cancel-btn').addClass('hidden');
    setPostMessage('');
}

function buildPostAdminRow(post) {
    const div = $('<div class="saved-memory-row"></div>');
    const info = $('<div class="saved-memory-info"></div>');
    const statusLabel = post.published_at
        ? '<span class="post-status published">Published</span>'
        : '<span class="post-status draft">Draft</span>';
    info.append('<strong>' + escapeHtml(post.title) + '</strong> ' + statusLabel);
    info.append('<span class="saved-memory-date"> · ' + new Date(post.created_at).toLocaleDateString() + '</span>');

    const actions = $('<div class="post-admin-actions"></div>');
    const editBtn = $('<button type="button" class="btn-small">Edit</button>');
    editBtn.on('click', () => loadPostForEdit(post));

    const toggleBtn = $('<button type="button" class="btn-small">' + (post.published_at ? 'Unpublish' : 'Publish') + '</button>');
    toggleBtn.on('click', () => togglePublish(post));

    const delBtn = $('<button type="button" class="travel-delete-btn">Delete</button>');
    delBtn.on('click', () => deletePost(post.id));

    actions.append(editBtn).append(toggleBtn).append(delBtn);
    div.append(info).append(actions);
    return div;
}

async function loadAdminPosts() {
    const list = $('#posts-admin-list');
    list.html('<p class="hint">Loading…</p>');
    try {
        const res = await authFetch('/posts/all');
        if (!res.ok) throw new Error();
        const posts = await res.json();
        if (!posts.length) { list.html('<p class="hint">No posts yet.</p>'); return; }
        list.empty();
        posts.forEach(p => list.append(buildPostAdminRow(p)));
    } catch {
        list.html('<p class="hint" style="color:var(--color-error)">Failed to load posts.</p>');
    }
}

// #95 fix: converted to async/await so body_markdown and post_date always
// populate before the user can interact with the form.
// #93 fix: slice ISO timestamp to YYYY-MM-DD before setting the date input.
async function loadPostForEdit(post) {
    $('#post-edit-id').val(post.id);
    $('#post-title').val(post.title);
    $('#post-cancel-btn').removeClass('hidden');
    setPostMessage('Editing: ' + post.title);
    document.getElementById('post-title').scrollIntoView({ behavior: 'smooth' });

    try {
        const r = await authFetch(`/posts/admin/${post.id}`);
        if (!r.ok) throw new Error();
        const full = await r.json();
        $('#post-body').val(full.body_markdown || '');
        // Slice to YYYY-MM-DD — full ISO timestamps silently clear <input type="date"> (#93)
        $('#post-date').val(full.post_date ? String(full.post_date).slice(0, 10) : todayIso());
    } catch {
        setPostMessage('Failed to load post body — please try again.', true);
    }
}

async function togglePublish(post) {
    try {
        const res = await authFetch(`/posts/${post.id}`, {
            method: 'PUT',
            body: JSON.stringify({
                title: post.title,
                body_markdown: post.body_markdown || '',
                publish: !post.published_at,
            }),
        });
        if (!res.ok) throw new Error();
        await loadAdminPosts();
    } catch {
        alert('Failed to update post.');
    }
}

async function deletePost(id) {
    if (!confirm('Delete this post? This cannot be undone.')) return;
    try {
        const res = await authFetch(`/posts/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error();
        clearPostForm();
        await loadAdminPosts();
    } catch {
        alert('Failed to delete post.');
    }
}

function initPostForm() {
    $('#post-form').on('submit', async function (event) {
        event.preventDefault();
        const clickedBtn = document.activeElement;
        const publish = clickedBtn && clickedBtn.id === 'post-publish-btn';
        const submitBtns = $(this).find('button[type="submit"]');
        submitBtns.prop('disabled', true);
        setPostMessage('Saving…');

        const id = $('#post-edit-id').val();
        const title = $('#post-title').val().trim();
        const body_markdown = $('#post-body').val();
        const post_date = $('#post-date').val() || null;

        if (!title) {
            setPostMessage('Title is required.', true);
            submitBtns.prop('disabled', false);
            return;
        }

        try {
            const method = id ? 'PUT' : 'POST';
            const path = id ? `/posts/${id}` : '/posts';
            const res = await authFetch(path, {
                method,
                body: JSON.stringify({ title, body_markdown, post_date, publish }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Save failed');
            setPostMessage(publish ? 'Post published.' : 'Draft saved.');
            clearPostForm();
            await loadAdminPosts();
        } catch (err) {
            setPostMessage(err.message || 'Failed to save post.', true);
        } finally {
            submitBtns.prop('disabled', false);
        }
    });

    $('#post-cancel-btn').on('click', clearPostForm);
    $('#post-clear-btn').on('click', function () {
        if ($('#post-edit-id').val() || $('#post-title').val() || $('#post-body').val()) {
            if (!confirm('Clear all fields and start a new post?')) return;
        }
        clearPostForm();
    });

    $('#post-template-btn').on('click', function () {
        const body = $('#post-body');
        const current = body.val();
        if (current.trim() && !confirm('The body has content — replace it with the template?')) return;
        body.val(POST_TEMPLATE);
        body.focus();
    });
}

// ── CV management (#101) ──────────────────────────────────────────────────────────────────

function setCvMessage(msg, isError = false) {
    const el = document.getElementById('cv-message');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? 'var(--color-error)' : 'var(--color-success)';
}

function updateCvStatusBadge(exists) {
    const badge = document.getElementById('cv-status-badge');
    if (!badge) return;
    if (exists) {
        badge.textContent = '✓ CV uploaded';
        badge.className = 'cv-status-badge uploaded';
    } else {
        badge.textContent = '✕ No CV uploaded';
        badge.className = 'cv-status-badge not-uploaded';
    }
    const deleteBtn = document.getElementById('cv-delete-btn');
    if (deleteBtn) deleteBtn.disabled = !exists;
}

async function loadCvStatus() {
    try {
        const res = await fetch(`${API_BASE}/cv/exists`);
        const { exists } = await res.json();
        updateCvStatusBadge(exists);
    } catch {
        setCvMessage('Could not check CV status.', true);
    }
}

async function uploadCv(file) {
    const uploadBtn = document.getElementById('cv-upload-btn');
    uploadBtn.disabled = true;
    setCvMessage('Uploading…');

    const fd = new FormData();
    fd.append('cv', file);

    try {
        const res = await fetch(`${API_BASE}/cv`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${getToken()}` },
            body: fd,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');

        if (data.warnings && data.warnings.length) {
            // Surface private-info scan warnings before confirming success
            const warningList = data.warnings.join('\n• ');
            const proceed = confirm(
                `The scan found potential private information in this PDF:\n\u2022 ${warningList}\n\nDo you still want to publish it?`
            );
            if (!proceed) {
                // Delete the file we just uploaded so it isn't accidentally served
                await authFetch('/cv', { method: 'DELETE' });
                setCvMessage('Upload cancelled — CV removed from server.', true);
                await loadCvStatus();
                return;
            }
        }

        setCvMessage('CV uploaded successfully.');
        await loadCvStatus();
    } catch (err) {
        setCvMessage(err.message || 'Upload failed.', true);
    } finally {
        uploadBtn.disabled = false;
        // Reset file input so the same file can be re-selected
        const input = document.getElementById('cv-file-input');
        if (input) input.value = '';
        const label = document.getElementById('cv-file-label');
        if (label) label.textContent = 'No file chosen';
    }
}

async function deleteCv() {
    if (!confirm('Delete the current CV? It will no longer be available for download.')) return;
    setCvMessage('');
    try {
        const res = await authFetch('/cv', { method: 'DELETE' });
        if (!res.ok) throw new Error();
        setCvMessage('CV deleted.');
        await loadCvStatus();
    } catch {
        setCvMessage('Failed to delete CV.', true);
    }
}

function initCvSection() {
    const cvFileInput = document.getElementById('cv-file-input');
    const cvFileBtn   = document.getElementById('cv-file-btn');
    const cvFileLabel = document.getElementById('cv-file-label');
    const cvUploadBtn = document.getElementById('cv-upload-btn');
    const cvDeleteBtn = document.getElementById('cv-delete-btn');

    if (!cvFileInput) return;

    // Wire styled button to hidden native file input
    cvFileBtn.addEventListener('click', () => cvFileInput.click());
    cvFileInput.addEventListener('change', () => {
        const file = cvFileInput.files[0];
        cvFileLabel.textContent = file ? file.name : 'No file chosen';
        cvUploadBtn.disabled = !file;
    });

    cvUploadBtn.addEventListener('click', () => {
        const file = cvFileInput.files[0];
        if (file) uploadCv(file);
    });

    cvDeleteBtn.addEventListener('click', deleteCv);

    loadCvStatus();
}

// ── Private notes ───────────────────────────────────────────────────────────────────────────

function initPrivateNotes() {
    const notes = localStorage.getItem('privateProjectNotes');
    if (notes) $('#private-notes').val(notes);
    $('#save-private').on('click', function () {
        localStorage.setItem('privateProjectNotes', $('#private-notes').val());
        alert('Private notes saved locally.');
    });
    $('#clear-private').on('click', function () {
        $('#private-notes').val('');
        localStorage.removeItem('privateProjectNotes');
    });
}

function setLogout() {
    $('#logout-link').on('click', function (event) {
        event.preventDefault();
        localStorage.removeItem('adminToken');
        location.replace('login.html');
    });
}

// ── Site stats ────────────────────────────────────────────────────────────────────────

async function loadStats() {
    const list = document.getElementById('stats-list');
    if (!list) return;
    try {
        const res = await authFetch('/stats/visits');
        if (!res.ok) throw new Error();
        const rows = await res.json();
        if (!rows.length) {
            list.innerHTML = '<p class="hint">No visits recorded yet.</p>';
            return;
        }
        list.innerHTML = rows.map(function (r) {
            var last = r.last_visited_at
                ? new Date(r.last_visited_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
                : '—';
            return '<div class="stat-row"><span class="stat-page">' + escapeHtml(r.page) + '</span>'
                + '<span class="stat-count">' + Number(r.count).toLocaleString() + '</span>'
                + '<span class="stat-last">last: ' + last + '</span></div>';
        }).join('');
    } catch {
        list.innerHTML = '<p class="hint" style="color:var(--color-error)">Failed to load stats.</p>';
    }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────────────────────

requireAuth();
setLogout();
initTravelForm();
initPrivateNotes();
initPostForm();
initCvSection();
loadTravelMemories();
loadAdminPosts();
loadPasskeys();
loadStats();
document.getElementById('add-passkey-btn').addEventListener('click', addPasskey);
