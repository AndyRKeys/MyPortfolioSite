import { authFetch, todayIso } from '../auth.js';
import { escapeHtml } from '../../utils/html.js';
import { setMessage } from './messages.js';
import { updateGeoconfirmMap } from './geocode.js';
import {
    setPendingFiles, setExistingMedia, setRemovedMediaIds,
    renderMediaList,
} from './media.js';

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

export async function loadAll() {
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

        setPendingFiles([]);
        setRemovedMediaIds([]);
        setExistingMedia(
            Array.isArray(full.media) && full.media.length
                ? full.media.map(m => ({ id: m.id, url: m.url, type: m.type }))
                : (full.media_url ? [{ id: null, url: full.media_url, type: full.media_type }] : [])
        );
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
