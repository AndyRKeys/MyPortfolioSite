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

const travelStorageKey = 'travelMemoryDrafts';
let travelDrafts = [];
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
    previewText.append('<p><strong>' + (travel.title || 'Untitled memory') + '</strong></p>');
    previewText.append('<p>' + (travel.location || 'No location provided') + '</p>');
    previewText.append('<p>' + (travel.notes || 'No notes yet.') + '</p>');
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

function loadDrafts() {
    if (!window.localStorage) return;
    const saved = localStorage.getItem(travelStorageKey);
    if (saved) {
        try { travelDrafts = JSON.parse(saved) || []; } catch { /* ignore */ }
    }
    const notes = localStorage.getItem('privateProjectNotes');
    if (notes) $('#private-notes').val(notes);
}

function saveDrafts() {
    if (window.localStorage) {
        localStorage.setItem(travelStorageKey, JSON.stringify(travelDrafts));
    }
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

    $('#travel-form').on('submit', function (event) {
        event.preventDefault();
        const travel = {
            title: $('#travel-title').val().trim(),
            location: $('#travel-location').val().trim(),
            notes: $('#travel-notes').val().trim(),
            mediaUrl: currentFile ? currentFile.mediaUrl : null,
            mediaType: currentFile ? currentFile.mediaType : null,
            createdAt: new Date().toISOString(),
        };
        travelDrafts.unshift(travel);
        saveDrafts();
        clearTravelForm();
        alert('Travel memory saved.');
    });

    $('#travel-clear').on('click', clearTravelForm);
}

function initPrivateNotes() {
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
loadDrafts();
initTravelForm();
initPrivateNotes();
loadPasskeys();
document.getElementById('add-passkey-btn').addEventListener('click', addPasskey);
