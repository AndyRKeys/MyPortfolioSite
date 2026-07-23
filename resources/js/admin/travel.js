import exifr from 'https://esm.sh/exifr@7.1.3';
import { authFetch, authFetchMultipart, todayIso } from './auth.js';
import { escapeHtml } from '../utils/html.js';
import { createMessenger } from '../utils/messenger.js';

// ── Constants ─────────────────────────────────────────────────────────────────

// Nominatim base URL — shared by reverse-geocode (reverseGeocodeToLocation)
// and forward-geocode (geocodeLocation) to avoid drift between the two calls.
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';

// Duration (ms) to flash a success outline on the location input after
// Geocode normalises the field value.
const LOCATION_FLASH_MS = 1500;

// ── Module state ──────────────────────────────────────────────────────────────

let pendingFiles    = [];   // File objects queued for upload
let existingMedia   = [];   // {id, url, type} from post_media (on edit)
let removedMediaIds = [];   // post_media ids to delete on save
let geoconfirmMap   = null; // Leaflet map for coordinate confirmation
let geoconfirmMarker = null;
let bulkFiles       = [];   // Files queued for bulk direct-upload to saved memory

// ── Messaging ─────────────────────────────────────────────────────────────────

const setMessage = createMessenger('travel-message');

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
                syncUploadBtn();
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
    syncUploadBtn();
    if (uploadStatus) uploadStatus.textContent = '';

    // Hide bulk upload section and reset its state
    resetBulkUploadSection(false);
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
        syncUploadBtn();
        if (uploadStatus) uploadStatus.textContent = '';

        // Show bulk upload section (only meaningful when editing a saved memory)
        resetBulkUploadSection(true);

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

// Build canonical "City, Country" from a Nominatim address object.
// Falls back to the first two comma-separated parts of display_name when the
// address object lacks a city-level field (e.g. Tokyo returns addresstype
// "province", not "city", so address.province must be checked explicitly).
function normaliseLocation(address, displayName) {
    if (address) {
        const city    = address.city || address.town || address.village || address.hamlet ||
                        address.municipality || address.province ||
                        address.county || address.state_district || address.state || '';
        const country = address.country || '';
        if (city && country) return `${city}, ${country}`;
    }
    const parts = displayName ? displayName.split(',').map(p => p.trim()).filter(Boolean) : [];
    return parts.slice(0, 2).join(', ') || null;
}

// Reverse geocode lat/lng to a human-readable location string using Nominatim.
// Only populates the Location field if it is currently empty.
async function reverseGeocodeToLocation(lat, lng) {
    if (document.getElementById('travel-location').value.trim()) return;
    try {
        const url = `${NOMINATIM_URL}/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10&addressdetails=1`;
        const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
        if (!res.ok) return;
        const data = await res.json();
        const locationStr = normaliseLocation(data.address, data.display_name);
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
// Returns true if GPS was found and applied, false otherwise — callers
// (e.g. the manual Upload photos button on mobile) use this to surface
// clear success/failure feedback to the user.
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
            return true;
        }
    }
    setMessage('No GPS data in any photo — enter coordinates manually or use Geocode.', false, true);
    return false;
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
        const url = `${NOMINATIM_URL}/search?format=json&limit=1&addressdetails=1&q=${encodeURIComponent(q)}`;
        const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
        const results = await res.json();
        if (!results.length) { setMessage('Location not found — try a more specific name.', true); return; }
        const { lat, lon, display_name, address } = results[0];
        const parsedLat = parseFloat(lat);
        const parsedLng = parseFloat(lon);
        document.getElementById('travel-lat').value = parsedLat.toFixed(6);
        document.getElementById('travel-lng').value = parsedLng.toFixed(6);

        // Normalise location field to canonical City, Country format
        const normalised = normaliseLocation(address, display_name);
        if (normalised) {
            const locationInput = document.getElementById('travel-location');
            locationInput.value = normalised;
            locationInput.style.outline = '2px solid var(--color-success)';
            setTimeout(() => { locationInput.style.outline = ''; }, LOCATION_FLASH_MS);
        }

        setMessage(`Coordinates set — confirm pin location on the map below (matched: ${display_name.split(',').slice(0, 3).join(',')}).`, false, true);
        updateGeoconfirmMap(parsedLat, parsedLng);
    } catch {
        setMessage('Geocode failed — check your connection and try again.', true);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Geocode';
    }
}

// ── Processing queue panel ────────────────────────────────────────────────────

let jobPollInterval = null;

function formatDuration(createdAt) {
    const ms = Date.now() - new Date(createdAt).getTime();
    if (ms < 60000) return Math.round(ms / 1000) + 's';
    return Math.round(ms / 60000) + 'm';
}

function renderJobRow(job) {
    const filename = job.media_url ? job.media_url.split('/').pop() : '—';
    const isImage  = job.media_type && job.media_type.startsWith('image');
    const typeIcon = isImage ? '🖼' : '🎦';
    const statusClass = job.media_status === 'ready'
        ? 'queue-status-ready'
        : job.media_status === 'error'
            ? 'queue-status-error'
            : 'queue-status-pending';

    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td>${typeIcon} ${escapeHtml(filename)}</td>
        <td>${escapeHtml(job.media_type || '—')}</td>
        <td class="${escapeHtml(statusClass)}">${escapeHtml(job.media_status || '—')}</td>
        <td>${formatDuration(job.created_at)}</td>
        <td></td>
    `;

    if (job.media_status === 'error') {
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'btn-small';
        retryBtn.textContent = 'Retry';
        retryBtn.addEventListener('click', () => retryJob(filename, job.media_type));
        tr.querySelector('td:last-child').appendChild(retryBtn);
    }

    return tr;
}

async function retryJob(file, mimeType) {
    try {
        await authFetch('/upload/retry', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ file, mimeType }),
        });
        refreshJobQueue();
    } catch (err) {
        setMessage('Retry failed: ' + (err.message || 'unknown error'), true);
    }
}

async function refreshJobQueue() {
    const panel = document.getElementById('travel-queue-panel');
    if (!panel) return;

    try {
        const jobs = await authFetch('/upload/jobs').then(r => r.json());

        if (!jobs.length) {
            panel.classList.add('hidden');
            stopJobPolling();
            return;
        }

        panel.classList.remove('hidden');
        const tbody = panel.querySelector('tbody');
        tbody.innerHTML = '';
        jobs.forEach(job => tbody.appendChild(renderJobRow(job)));

        const hasActive = jobs.some(j => j.media_status === 'pending' || j.media_status === 'processing');
        if (!hasActive) stopJobPolling();

    } catch (_err) {
        // Non-fatal — panel just won't update
    }
}

function startJobPolling() {
    if (jobPollInterval) return;
    jobPollInterval = setInterval(refreshJobQueue, 5000);
}

function stopJobPolling() {
    if (jobPollInterval) {
        clearInterval(jobPollInterval);
        jobPollInterval = null;
    }
}

// ── Upload-button helpers (#466) ──────────────────────────────────────────────

// Module-scoped so non-init callers (renderMediaList remove handlers,
// clearForm, loadForEdit) can keep the button's disabled state in sync
// with pendingFiles.length.
let uploadBtn    = null;
let uploadStatus = null;

function syncUploadBtn() {
    if (!uploadBtn) return;
    uploadBtn.disabled = pendingFiles.length === 0;
}

function syncBulkUploadBtn() {
    const btn = document.getElementById('travel-bulk-upload-btn');
    if (btn) btn.disabled = bulkFiles.length === 0;
}

// Reset the bulk upload section state and show/hide it. Hidden when creating
// a new memory (no id to upload against); shown when editing a saved one.
function resetBulkUploadSection(visible) {
    bulkFiles = [];
    const bulkSection = document.getElementById('travel-bulk-upload-section');
    if (bulkSection) bulkSection.classList.toggle('hidden', !visible);
    const bulkLabel = document.getElementById('travel-bulk-file-label');
    if (bulkLabel) bulkLabel.textContent = 'No files chosen';
    const bulkStatus = document.getElementById('travel-bulk-status');
    if (bulkStatus) bulkStatus.textContent = '';
    syncBulkUploadBtn();
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initTravel() {
    loadAll();

    uploadBtn    = document.getElementById('travel-upload-btn');
    uploadStatus = document.getElementById('travel-upload-status');
    syncUploadBtn();

    uploadBtn?.addEventListener('click', async () => {
        if (!pendingFiles.length) return;
        uploadBtn.disabled = true;
        uploadBtn.textContent = 'Extracting GPS…';
        if (uploadStatus) uploadStatus.textContent = '';

        const found = await tryAutofillGpsFromFileList(pendingFiles);

        uploadBtn.disabled = false;
        uploadBtn.textContent = 'Upload photos';
        if (uploadStatus) {
            uploadStatus.textContent = found
                ? 'GPS location auto-filled from photo.'
                : 'No GPS data found — enter location manually.';
        }
    });

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
        syncUploadBtn();
        if (uploadStatus) uploadStatus.textContent = '';
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
            startJobPolling();
            refreshJobQueue();
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

    // ── CSV bulk import ───────────────────────────────────────────────────────

    const csvFileLabel   = document.getElementById('csv-file-label');
    const csvFileBtn     = document.getElementById('csv-file-btn');
    const csvImportBtn   = document.getElementById('travel-csv-import-btn');
    const csvTemplateBtn = document.getElementById('travel-csv-template-btn');
    const csvMessage     = document.getElementById('travel-csv-message');
    const csvPhotosBtn   = document.getElementById('csv-photos-btn');
    const csvPhotosLabel = document.getElementById('csv-photos-label');

    function setCsvMessage(text, isError = false) {
        if (!csvMessage) return;
        csvMessage.textContent = text;
        csvMessage.style.color = isError ? 'var(--color-error)' : '';
    }

    // Wraps a file <input> so every open() starts a brand-new native dialog
    // session — the element is replaced with a fresh clone before each click
    // instead of reusing the same one repeatedly. Windows' common file dialog
    // can retain per-element state (e.g. last-typed search-box text) across
    // repeated opens of the same <input>, producing a false "No items match
    // your search" on a later attempt (#511). window.showDirectoryPicker()
    // would avoid this more cleanly (no persistent element at all), but
    // Brave disables it by default (throws instead of prompting), so this
    // sticks with the classic <input webkitdirectory> approach.
    function filePicker(id, onChange) {
        let el = document.getElementById(id);
        const attach = () => el.addEventListener('change', () => onChange(el));
        attach();
        return {
            open() {
                const clone = el.cloneNode(false);
                el.replaceWith(clone);
                el = clone;
                attach();
                el.click();
            },
            get element() { return el; },
        };
    }

    const csvFilePicker = filePicker('travel-csv-file', (input) => {
        const file = input.files[0];
        if (csvFileLabel) csvFileLabel.textContent = file ? file.name : 'No file chosen';
        if (csvImportBtn) csvImportBtn.disabled = !file;
        setCsvMessage('');
    });

    const csvPhotosPicker = filePicker('travel-csv-photos', (input) => {
        const count = input.files?.length || 0;
        if (csvPhotosLabel) {
            csvPhotosLabel.textContent = count
                ? `${count} file${count !== 1 ? 's' : ''} selected`
                : 'No folder chosen';
        }
    });

    if (csvFileBtn) csvFileBtn.addEventListener('click', () => csvFilePicker.open());
    if (csvPhotosBtn) csvPhotosBtn.addEventListener('click', () => csvPhotosPicker.open());

    if (csvImportBtn) {
        csvImportBtn.addEventListener('click', async () => {
            const file = csvFilePicker.element.files[0];
            if (!file) return;

            csvImportBtn.disabled = true;
            setCsvMessage('Importing…');

            try {
                const fd = new FormData();
                fd.append('file', file);

                const photoFiles = Array.from(csvPhotosPicker.element.files || []);
                if (photoFiles.length) {
                    const manifest = photoFiles.map(f => f.webkitRelativePath || f.name);
                    for (const f of photoFiles) fd.append('photos', f);
                    fd.append('photoManifest', JSON.stringify(manifest));
                }

                const res  = await authFetchMultipart('/travel/import', fd);
                const data = await res.json();

                if (!res.ok) {
                    setCsvMessage(data.error || 'Import failed.', true);
                    return;
                }

                const { imported, skipped, errors } = data;
                let msg = `Imported ${imported} row${imported !== 1 ? 's' : ''}`;
                if (skipped) msg += `, skipped ${skipped}`;
                if (errors && errors.length) {
                    msg += '. Errors: ' + errors.map(e => `row ${e.row}: ${e.reason}`).join('; ');
                }
                setCsvMessage(msg, skipped > 0 && imported === 0);

                // Reset the file inputs and reload the list if anything was imported
                csvFilePicker.element.value = '';
                if (csvFileLabel) csvFileLabel.textContent = 'No file chosen';
                csvPhotosPicker.element.value = '';
                if (csvPhotosLabel) csvPhotosLabel.textContent = 'No folder chosen';
                csvImportBtn.disabled = true;
                if (imported > 0) await loadAll();
            } catch {
                setCsvMessage('Import failed — check your connection and try again.', true);
            } finally {
                csvImportBtn.disabled = false;
            }
        });
    }

    if (csvTemplateBtn) {
        csvTemplateBtn.addEventListener('click', () => {
            const header  = 'title,location,notes,post_date,lat,lng,publish,photos';
            const example = '"My trip","Paris, France","A wonderful visit",2024-06-15,48.8566,2.3522,false,"Paris/IMG_0001.jpg;Paris/IMG_0002.jpg"';
            const blob    = new Blob([header + '\n' + example + '\n'], { type: 'text/csv' });
            const url     = URL.createObjectURL(blob);
            const a       = document.createElement('a');
            a.href        = url;
            a.download    = 'travel-import-template.csv';
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    // ── Bulk photo/video upload (edit mode) ───────────────────────────────────

    const bulkFileInput = document.getElementById('travel-bulk-file');
    const bulkFileBtn   = document.getElementById('travel-bulk-file-btn');
    const bulkUploadBtn = document.getElementById('travel-bulk-upload-btn');
    const bulkFileLabel = document.getElementById('travel-bulk-file-label');
    const bulkStatusEl  = document.getElementById('travel-bulk-status');

    function setBulkStatus(text, isError = false) {
        if (!bulkStatusEl) return;
        bulkStatusEl.textContent = text;
        bulkStatusEl.style.color = isError ? 'var(--color-error)' : '';
    }

    if (bulkFileBtn && bulkFileInput) {
        bulkFileBtn.addEventListener('click', () => bulkFileInput.click());
    }

    if (bulkFileInput) {
        bulkFileInput.addEventListener('change', () => {
            const files = Array.from(bulkFileInput.files || []);
            if (!files.length) return;
            bulkFiles = bulkFiles.concat(files);
            if (bulkFileLabel) {
                bulkFileLabel.textContent = bulkFiles.length + ' file' + (bulkFiles.length !== 1 ? 's' : '') + ' selected';
            }
            bulkFileInput.value = ''; // allow re-selecting the same file
            setBulkStatus('');
            syncBulkUploadBtn();
        });
    }

    if (bulkUploadBtn) {
        bulkUploadBtn.addEventListener('click', async () => {
            const editId = document.getElementById('travel-edit-id').value;
            if (!editId || !bulkFiles.length) return;

            bulkUploadBtn.disabled = true;
            setBulkStatus(`Uploading ${bulkFiles.length} file${bulkFiles.length !== 1 ? 's' : ''}…`);

            const fd = new FormData();
            for (const f of bulkFiles) fd.append('photos', f);

            try {
                const res  = await authFetchMultipart(`/travel/${editId}/photos/bulk`, fd);
                const data = await res.json();

                if (!res.ok) {
                    setBulkStatus(data.error || 'Upload failed.', true);
                    return;
                }

                const { uploaded, errors } = data;
                let msg = `Uploaded ${uploaded.length} file${uploaded.length !== 1 ? 's' : ''}`;
                if (errors && errors.length) {
                    msg += `, ${errors.length} failed: ` + errors.map(e => e.file).join(', ');
                }
                setBulkStatus(msg, errors && errors.length > 0 && uploaded.length === 0);

                // Reset file list after upload
                bulkFiles = [];
                if (bulkFileLabel) bulkFileLabel.textContent = 'No files chosen';
                syncBulkUploadBtn();

                // Refresh the media list by reloading the current memory from the API
                if (uploaded.length) {
                    try {
                        const memRes = await authFetch(`/travel/admin/${editId}`);
                        if (memRes.ok) {
                            const full = await memRes.json();
                            existingMedia = Array.isArray(full.media) && full.media.length
                                ? full.media.map(m => ({ id: m.id, url: m.url, type: m.type }))
                                : (full.media_url ? [{ id: null, url: full.media_url, type: full.media_type }] : []);
                            renderMediaList();
                            startJobPolling();
                            refreshJobQueue();
                        }
                    } catch {
                        // Non-fatal — media list will refresh on next form load
                    }
                }
            } catch {
                setBulkStatus('Upload failed — check connection and try again.', true);
            } finally {
                syncBulkUploadBtn();
            }
        });
    }

    // Start queue panel with initial poll; polling continues if active jobs exist.
    refreshJobQueue();
    startJobPolling();
}
