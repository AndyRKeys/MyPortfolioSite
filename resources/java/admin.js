import { startRegistration } from 'https://esm.sh/@simplewebauthn/browser@7';
import { API } from './config.js';

// ── Auth helpers ──────────────────────────────────────────────────────────────

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
    if (!isAuthenticated()) {
        location.replace('login.html');
    }
}

function authFetch(path, opts = {}) {
    return fetch(`${API}${path}`, {
        ...opts,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${getToken()}`,
            ...(opts.headers || {}),
        },
    });
}

// ── Passkey management ────────────────────────────────────────────────────────

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
        container.innerHTML = '<p class="hint" style="color:#c0392b;">Failed to load passkeys.</p>';
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
        const startRes = await authFetch('/auth/passkey/register/start', {
            method: 'POST',
            body: JSON.stringify({}),
        });
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
        if (err.name === 'NotAllowedError') {
            setPasskeyMessage('Passkey prompt was cancelled.', true);
        } else {
            setPasskeyMessage(err.message || 'Failed to add passkey.', true);
        }
    } finally {
        btn.disabled = false;
    }
}

function setPasskeyMessage(msg, isError = false) {
    const el = document.getElementById('passkey-message');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? '#c0392b' : '#27ae60';
}

// ── Travel memories ───────────────────────────────────────────────────────────

let currentFile = null;

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function showPreview(travel) {
    const previewMedia = $('.preview-media');
    const previewText = $('.preview-text');
    previewMedia.empty();
    previewText.empty();
    if (travel.mediaUrl) {
        if (travel.mediaType && travel.mediaType.indexOf('video') === 0) {
            previewMedia.append('<video controls src="' + travel.mediaUrl + '"></video>');
        } else {
            previewMedia.append('<img src="' + travel.mediaUrl + '" alt="Preview image">');
        }
    }
    previewText.append('<p><strong>' + escapeHtml(travel.title || 'Untitled memory') + '</strong></p>');
    previewText.append('<p>' + escapeHtml(travel.location || 'No location provided') + '</p>');
    previewText.append('<p>' + escapeHtml(travel.notes || 'No notes yet.') + '</p>');
    $('#travel-preview').removeClass('hidden');
}

function clearTravelForm() {
    $('#travel-form')[0].reset();
    $('#travel-preview').addClass('hidden');
    $('.preview-media').empty();
    $('.preview-text').empty();
    currentFile = null;
    $('#travel-file').val('');
}

function buildSavedMemoryRow(memory) {
    const div = $('<div class="saved-memory-row"></div>');
    const info = $('<div class="saved-memory-info"></div>');
    info.append('<strong>' + escapeHtml(memory.title) + '</strong>');
    if (memory.location) info.append('<span class="saved-memory-location"> — ' + escapeHtml(memory.location) + '</span>');
    info.append('<span class="saved-memory-date"> · ' + new Date(memory.created_at).toLocaleDateString() + '</span>');
    const delBtn = $('<button type="button" class="travel-delete-btn">Delete</button>');
    delBtn.on('click', function () { deleteTravelMemory(memory.id); });
    div.append(info).append(delBtn);
    return div;
}

async function loadTravelMemories() {
    const list = $('#saved-memories-list');
    list.html('<p class="hint">Loading…</p>');
    try {
        const res = await authFetch('/travel');
        if (!res.ok) throw new Error('Failed to fetch');
        const memories = await res.json();
        if (!memories.length) {
            list.html('<p class="hint">No travel memories saved yet.</p>');
            return;
        }
        list.empty();
        memories.forEach(m => list.append(buildSavedMemoryRow(m)));
    } catch {
        list.html('<p class="hint" style="color:#c0392b;">Failed to load memories.</p>');
    }
}

async function deleteTravelMemory(id) {
    if (!confirm('Delete this travel memory? This cannot be undone.')) return;
    try {
        const res = await authFetch(`/travel/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Delete failed');
        await loadTravelMemories();
    } catch {
        alert('Failed to delete memory.');
    }
}

function setTravelMessage(msg, isError = false) {
    const el = document.getElementById('travel-message');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? '#c0392b' : '#27ae60';
}

function initTravelForm() {
    $('#travel-file').on('change', function (event) {
        const file = event.target.files && event.target.files[0];
        if (!file) { currentFile = null; return; }
        const reader = new FileReader();
        reader.onload = function (e) {
            currentFile = { mediaUrl: e.target.result, mediaType: file.type };
            showPreview({
                title: $('#travel-title').val(),
                location: $('#travel-location').val(),
                notes: $('#travel-notes').val(),
                ...currentFile,
            });
        };
        reader.readAsDataURL(file);
    });

    $('#travel-form').on('submit', async function (event) {
        event.preventDefault();
        const submitBtn = $(this).find('button[type="submit"]');
        submitBtn.prop('disabled', true);
        setTravelMessage('Saving…');

        const travel = {
            title: $('#travel-title').val().trim(),
            location: $('#travel-location').val().trim(),
            notes: $('#travel-notes').val().trim(),
            mediaUrl: currentFile ? currentFile.mediaUrl : null,
            mediaType: currentFile ? currentFile.mediaType : null,
        };

        if (!travel.title) {
            setTravelMessage('Title is required.', true);
            submitBtn.prop('disabled', false);
            return;
        }

        try {
            const res = await authFetch('/travel', {
                method: 'POST',
                body: JSON.stringify(travel),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Save failed');
            setTravelMessage('Memory saved.');
            clearTravelForm();
            await loadTravelMemories();
        } catch (err) {
            setTravelMessage(err.message || 'Failed to save memory.', true);
        } finally {
            submitBtn.prop('disabled', false);
        }
    });

    $('#travel-clear').on('click', clearTravelForm);
}

// ── Private notes ─────────────────────────────────────────────────────────────

function loadPrivateNotes() {
    const notes = localStorage.getItem('privateProjectNotes');
    if (notes) $('#private-notes').val(notes);
}

function initPrivateNotes() {
    loadPrivateNotes();
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

// ── Bootstrap ─────────────────────────────────────────────────────────────────

requireAuth();
setLogout();
initTravelForm();
initPrivateNotes();
loadTravelMemories();
loadPasskeys();
document.getElementById('add-passkey-btn').addEventListener('click', addPasskey);
