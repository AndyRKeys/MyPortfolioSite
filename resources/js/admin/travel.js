import exifr from 'https://esm.sh/exifr@7.1.3';
import { authFetch, authFetchMultipart, todayIso } from './auth.js';
import { escapeHtml } from '../utils/html.js';

// ── Module state ──────────────────────────────────────────────────────────────

let pendingFiles    = [];   // File objects queued for upload
let existingMedia   = [];   // {id, url, type} from post_media (on edit)
let removedMediaIds = [];   // post_media ids to delete on save
let geoconfirmMap   = null; // Leaflet map for coordinate confirmation
let geoconfirmMarker = null;

// ── Messaging ─────────────────────────────────────────────────────────────────

function setMessage(msg, isError = false, isHint = false) {
    const el = document.getElementById('travel-message');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? 'var(--color-error)' : isHint ? 'var(--color-text-muted)' : 'var(--color-success)';
}

// ── Media list ────────────────────────────────────────────────────────────────

function renderMediaList() {
    const list = document.getElementById('travel-media-list');
    list.innerHTML = '';

    const allItems = [
        ...existingMedia.map(m => ({ kind: 'existing', ...m })),
        ...pendingFiles.map((f, i) => ({ kind: 'pending', index: i, name: f.name, type: f.type })),
    ];

    if (!allItems.length) { list.classList.add('hidden'); return; }
    list.classList.remove('hidden');

    allItems.forEach(item => {
        const row = document.createElement('div');
        row.className = 'media-list-row';

        const icon = item.type && item.type.startsWith('video') ? '🎦' : '🖼';
        const labelText = item.kind === 'existing'
            ? `${icon} ${item.url.split('/').pop()}`
            : `${icon} ${item.name} (pending)`;
        const labelEl = document.createElement('span');
        labelEl.className = 'media-list-label';
        labelEl.textContent = labelText;

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn-small media-remove-btn';
        removeBtn.textContent = 'Remove';

        if (item.kind === 'existing') {
            removeBtn.addEventListener('click', () => {
                removedMediaIds.push(item.id);
                existingMedia = existingMedia.filter(m => m.id !== item.id);
                renderMediaList();
            });
        } else {
            removeBtn.addEventListener('click', () => {
                pendingFiles.splice(item.index, 1);
                renderMediaList();
                if (!pendingFiles.length && !existingMedia.length) {
                    document.querySelector('.file-input-label').textContent = 'No files chosen';
                }
            });
        }

        row.append(labelEl, removeBtn);
        list.append(row);
    });
}

// ── Form reset ────────────────────────────────────────────────────────────────

function clearForm() {
    document.getElementById('travel-edit-id').value = '';
    document.getElementById('travel-form').reset();
    document.getElementById('travel-cancel-btn').classList.add('hidden');
    document.querySelector('.file-input-label').textContent = 'No files chosen';
    document.getElementById('travel-date').value = todayIso();
    document.getElementById('travel-preview').classList.add('hidden');
    document.querySelector('.preview-media').innerHTML = '';
    document.querySelector('.preview-text').innerHTML = '';
    pendingFiles    = [];
    existingMedia   = [];
    removedMediaIds = [];
    renderMediaList();
    setMessage('');
    hideGeoconfirmMap();
}

// ── Saved memories list ───────────────────────────────────────────────────────

function buildRow(memory) {
    const div = document.createElement('div');
    div.className = 'saved-memory-row';

    const info = document.createElement('div');
    info.className = 'saved-memory-info';
    const statusLabel = memory.published_at
        ? '<span class="post-status published">Published</span>'
        : '<span class="post-status draft">Draft</span>';
    info.innerHTML = '<strong>' + escapeHtml(memory.title) + '</strong> ' + statusLabel;

    if (memory.location) {
        const loc = document.createElement('span');
        loc.className = 'saved-memory-location';
        loc.textContent = ' — ' + memory.location;
        info.append(loc);
    }

    const dateSpan = document.createElement('span');
    dateSpan.className = 'saved-memory-date';
    dateSpan.textContent = ' · ' + new Date(memory.created_at).toLocaleDateString();
    info.append(dateSpan);

    const actions = document.createElement('div');
    actions.className = 'post-admin-actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-small';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => loadForEdit(memory));

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn-small';
    toggleBtn.textContent = memory.published_at ? 'Unpublish' : 'Publish';
    toggleBtn.addEventListener('click', () => togglePublish(memory));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-small btn-danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => deleteMemory(memory.id));

    actions.append(editBtn, toggleBtn, delBtn);
    div.append(info, actions);
    return div;
}

async function loadAll() {
    const list = document.getElementById('saved-memories-list');
    list.innerHTML = '<p class="hint">Loading…</p>';
    try {
        const res = await authFetch('/travel/all');
        if (!res.ok) throw new Error();
        const memories = await res.json();
        if (!memories.length) { list.innerHTML = '<p class="hint">No travel memories saved yet.</p>'; return; }
        list.innerHTML = '';
        memories.forEach(m => list.append(buildRow(m)));
    } catch {
        list.innerHTML = '<p class="hint" style="color:var(--color-error)">Failed to load memories.</p>';
    }
}

// #93 fix: slice ISO timestamp to YYYY-MM-DD before setting <input type="date">
async function loadForEdit(memory) {
    try {
        const res = await authFetch(`/travel/admin/${memory.id}`);
        if (!res.ok) throw new Error();
        const full = await res.json();

        document.getElementById('travel-edit-id').value    = full.id;
        document.getElementById('travel-title').value      = full.title || '';
        document.getElementById('travel-location').value   = full.location || '';
        document.getElementById('travel-notes').value      = full.notes || '';
        document.getElementById('travel-date').value       = full.post_date ? String(full.post_date).slice(0, 10) : todayIso();
        document.getElementById('travel-lat').value        = full.lat != null ? full.lat : '';
        document.getElementById('travel-lng').value        = full.lng != null ? full.lng : '';

        pendingFiles    = [];
        removedMediaIds = [];
        existingMedia   = Array.isArray(full.media) && full.media.length
            ? full.media.map(m => ({ id: m.id, url: m.url, type: m.type }))
            : (full.media_url ? [{ id: null, url: full.media_url, type: full.media_type }] : []);
        document.querySelector('.file-input-label').textContent = 'No files chosen';
        renderMediaList();

        if (full.lat != null && full.lng != null) {
            updateGeoconfirmMap(parseFloat(full.lat), parseFloat(full.lng));
        }

        document.getElementById('travel-preview').classList.add('hidden');
        document.getElementById('travel-cancel-btn').classList.remove('hidden');
        setMessage('Editing: ' + full.title);
        document.getElementById('travel-title').scrollIntoView({ behavior: 'smooth' });
    } catch {
        setMessage('Failed to load memory for editing.', true);
    }
}

async function togglePublish(memory) {
    try {
        const res = await authFetch(`/travel/${memory.id}`, {
            method: 'PUT',
            body: JSON.stringify({
                title:     memory.title,
                location:  memory.location || '',
                notes:     memory.notes || '',
                // Slice to YYYY-MM-DD — list response returns full ISO timestamp (#93)
                post_date: memory.post_date ? String(memory.post_date).slice(0, 10) : null,
                lat:       memory.lat,
                lng:       memory.lng,
                publish:   !memory.published_at,
                // media_items undefined → backend leaves existing post_media untouched
            }),
        });
        if (!res.ok) throw new Error();
        await loadAll();
    } catch {
        alert('Failed to update memory.');
    }
}

async function deleteMemory(id) {
    if (!confirm('Delete this travel memory? This cannot be undone.')) return;
    try {
        const res = await authFetch(`/travel/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error();
        await loadAll();
    } catch {
        alert('Failed to delete memory.');
    }
}

// ── Geocode confirmation map ──────────────────────────────────────────────────

function updateGeoconfirmMap(lat, lng) {
    if (!window.L) return;
    const mapEl = document.getElementById('geoconfirm-map');
    if (!mapEl) return;
    mapEl.classList.remove('hidden');

    if (!geoconfirmMap) {
        geoconfirmMap = L.map('geoconfirm-map', { scrollWheelZoom: false, zoomControl: true });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 18,
            attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
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

// ── EXIF GPS autofill ─────────────────────────────────────────────────────────

// Returns true only if coords are finite numbers and not the null-island 0,0
// that DJI and some cameras emit when GPS is unavailable.
function hasValidGps(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);
}

// Reverse geocode lat/lng to a human-readable location string using Nominatim.
// Only populates the Location field if it is currently empty.
async function reverseGeocodeToLocation(lat, lng) {
    if (document.getElementById('travel-location').value.trim()) return;
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10&addressdetails=1`;
        const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
        if (!res.ok) return;
        const data = await res.json();
        if (!data.address) return;
        const a = data.address;
        const city    = a.city || a.town || a.village || a.hamlet || a.county || a.state_district || a.state || '';
        const country = a.country || '';
        const locationStr = [city, country].filter(Boolean).join(', ');
        if (locationStr) document.getElementById('travel-location').value = locationStr;
    } catch {
        // Reverse geocode failure is non-fatal — silently ignore
    }
}

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
            if (raw && hasValidGps(raw.latitude, raw.longitude)) gps = raw;
        }
        return gps;
    } catch {
        return null;
    }
}

// Loop through sorted files to find the first one with valid GPS coords.
async function tryAutofillGpsFromFileList(files) {
    const sortedImages = files
        .filter(f => f.type && f.type.startsWith('image/'))
        .sort((a, b) => a.name.localeCompare(b.name));

    for (const file of sortedImages) {
        const gps = await extractGpsFromFile(file);
        if (gps) {
            document.getElementById('travel-lat').value = gps.latitude.toFixed(6);
            document.getElementById('travel-lng').value = gps.longitude.toFixed(6);
            setMessage(`GPS auto-filled from ${file.name}.`);
            updateGeoconfirmMap(gps.latitude, gps.longitude);
            await reverseGeocodeToLocation(gps.latitude, gps.longitude);
            return;
        }
    }
    setMessage('No GPS data in any photo — enter coordinates manually or use Geocode.', false, true);
}

// Try to read DateTimeOriginal from image EXIF and populate the date input.
async function tryAutofillDateFromFile(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return;
    const currentVal = document.getElementById('travel-date').value;
    if (currentVal && currentVal !== todayIso()) return;
    try {
        const tags = await exifr.parse(file, ['DateTimeOriginal']);
        if (tags && tags.DateTimeOriginal instanceof Date) {
            const d  = tags.DateTimeOriginal;
            const yyyy = d.getFullYear();
            const mm   = String(d.getMonth() + 1).padStart(2, '0');
            const dd   = String(d.getDate()).padStart(2, '0');
            document.getElementById('travel-date').value = `${yyyy}-${mm}-${dd}`;
        }
    } catch {
        // EXIF date unavailable — ignore
    }
}

async function geocodeLocation() {
    const q = document.getElementById('travel-location').value.trim();
    if (!q) { setMessage('Enter a location name first.', true); return; }
    const btn = document.getElementById('geocode-btn');
    btn.disabled = true;
    btn.textContent = 'Looking up…';
    setMessage('');
    try {
        const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q);
        const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
        const results = await res.json();
        if (!results.length) { setMessage('Location not found — try a more specific name.', true); return; }
        const { lat, lon, display_name } = results[0];
        const parsedLat = parseFloat(lat);
        const parsedLng = parseFloat(lon);
        document.getElementById('travel-lat').value = parsedLat.toFixed(6);
        document.getElementById('travel-lng').value = parsedLng.toFixed(6);
        setMessage(`Coordinates set — confirm pin location on the map below (matched: ${display_name.split(',').slice(0, 3).join(',')}).`, false, true);
        updateGeoconfirmMap(parsedLat, parsedLng);
    } catch {
        setMessage('Geocode failed — check your connection and try again.', true);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Geocode';
    }
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initTravel() {
    loadAll();

    document.getElementById('geocode-btn').addEventListener('click', () => geocodeLocation());

    // Update confirmation map when coords are changed manually
    const coordHandler = () => {
        const lat = parseFloat(document.getElementById('travel-lat').value);
        const lng = parseFloat(document.getElementById('travel-lng').value);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            updateGeoconfirmMap(lat, lng);
        } else {
            hideGeoconfirmMap();
        }
    };
    ['travel-lat', 'travel-lng'].forEach(id => {
        const el = document.getElementById(id);
        el.addEventListener('change', coordHandler);
        el.addEventListener('input', coordHandler);
    });

    document.getElementById('travel-file').addEventListener('change', (event) => {
        const files = Array.from(event.target.files || []);
        if (!files.length) return;

        tryAutofillGpsFromFileList(files);

        const sortedImages = files
            .filter(f => f.type && f.type.startsWith('image/'))
            .sort((a, b) => a.name.localeCompare(b.name));
        if (sortedImages.length) tryAutofillDateFromFile(sortedImages[0]);

        pendingFiles = pendingFiles.concat(files);
        document.querySelector('.file-input-label').textContent =
            pendingFiles.length + ' file' + (pendingFiles.length !== 1 ? 's' : '') + ' selected';
        event.target.value = ''; // reset so same file can be re-added if removed
        renderMediaList();
    });

    document.getElementById('travel-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const clickedBtn = document.activeElement;
        const publish    = clickedBtn && clickedBtn.id === 'travel-publish-btn';
        const submitBtns = event.currentTarget.querySelectorAll('button[type="submit"]');
        submitBtns.forEach(b => b.disabled = true);
        setMessage('Saving…');

        const title = document.getElementById('travel-title').value.trim();
        if (!title) {
            setMessage('Title is required.', true);
            submitBtns.forEach(b => b.disabled = false);
            return;
        }

        try {
            const uploadedItems = [];
            for (let i = 0; i < pendingFiles.length; i++) {
                setMessage(`Uploading file ${i + 1} of ${pendingFiles.length}…`);
                const fd = new FormData();
                fd.append('file', pendingFiles[i]);
                const upRes  = await authFetchMultipart('/upload', fd);
                const upData = await upRes.json();
                if (!upRes.ok) throw new Error(upData.error || 'Upload failed');
                uploadedItems.push({ url: upData.url, type: upData.type });
            }

            // Combine: remaining existing media first, then newly uploaded
            const mediaItems = [
                ...existingMedia.filter(m => m.id !== null).map(m => ({ url: m.url, type: m.type })),
                ...uploadedItems,
            ];

            const editId = document.getElementById('travel-edit-id').value;
            const travel = {
                title,
                location:    document.getElementById('travel-location').value.trim(),
                notes:       document.getElementById('travel-notes').value.trim(),
                post_date:   document.getElementById('travel-date').value || null,
                media_items: mediaItems,
                lat:         document.getElementById('travel-lat').value,
                lng:         document.getElementById('travel-lng').value,
                publish,
            };

            const method = editId ? 'PUT' : 'POST';
            const path   = editId ? `/travel/${editId}` : '/travel';
            const res    = await authFetch(path, { method, body: JSON.stringify(travel) });
            const data   = await res.json();
            if (!res.ok) throw new Error(data.error || 'Save failed');
            setMessage(publish ? 'Memory published.' : 'Draft saved.');
            clearForm();
            await loadAll();
        } catch (err) {
            setMessage(err.message || 'Failed to save memory.', true);
        } finally {
            submitBtns.forEach(b => b.disabled = false);
        }
    });

    document.getElementById('travel-cancel-btn').addEventListener('click', clearForm);

    document.getElementById('travel-clear').addEventListener('click', () => {
        if (document.getElementById('travel-edit-id').value
            || document.getElementById('travel-title').value
            || document.getElementById('travel-location').value
            || document.getElementById('travel-notes').value
            || pendingFiles.length) {
            if (!confirm('Clear all fields and start a new memory?')) return;
        }
        clearForm();
    });
}
