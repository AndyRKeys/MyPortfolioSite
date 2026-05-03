import { startRegistration } from 'https://esm.sh/@simplewebauthn/browser@7';
import exifr from 'https://esm.sh/exifr@7.1.3';
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
    if (!isAuthenticated()) location.replace('login.html');
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

// For multipart uploads — lets the browser set the correct Content-Type boundary
function authFetchMultipart(path, formData) {
    return fetch(`${API}${path}`, {
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

// ── Travel memories ───────────────────────────────────────────────────────────

let currentFile = null;
let editingTravelMedia = null; // preserved existing media when editing

function showPreview(travel) {
    const previewMedia = $('.preview-media');
    const previewText = $('.preview-text');
    previewMedia.empty();
    previewText.empty();
    if (travel.mediaUrl) {
        previewMedia.append(
            travel.mediaType && travel.mediaType.startsWith('video')
                ? `<video controls src="${travel.mediaUrl}"></video>`
                : `<img src="${travel.mediaUrl}" alt="Preview image">`
        );
    }
    previewText.append('<p><strong>' + escapeHtml(travel.title || 'Untitled memory') + '</strong></p>');
    previewText.append('<p>' + escapeHtml(travel.location || 'No location provided') + '</p>');
    previewText.append('<p>' + escapeHtml(travel.notes || 'No notes yet.') + '</p>');
    $('#travel-preview').removeClass('hidden');
}

function clearTravelForm() {
    $('#travel-edit-id').val('');
    $('#travel-form')[0].reset();
    $('#travel-cancel-btn').addClass('hidden');
    $('.file-input-label').text('No file chosen');
    $('#travel-date').val(todayIso());
    $('#travel-preview').addClass('hidden');
    $('.preview-media').empty();
    $('.preview-text').empty();
    currentFile = null;
    editingTravelMedia = null;
    setTravelMessage('');
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

async function loadTravelForEdit(memory) {
    try {
        const res = await authFetch(`/travel/admin/${memory.id}`);
        if (!res.ok) throw new Error();
        const full = await res.json();

        $('#travel-edit-id').val(full.id);
        $('#travel-title').val(full.title || '');
        $('#travel-location').val(full.location || '');
        $('#travel-notes').val(full.notes || '');
        $('#travel-date').val(full.visit_date || todayIso());
        $('#travel-lat').val(full.lat != null ? full.lat : '');
        $('#travel-lng').val(full.lng != null ? full.lng : '');

        editingTravelMedia = full.media_url ? { url: full.media_url, type: full.media_type } : null;
        currentFile = null;
        $('.file-input-label').text('No file chosen');

        if (full.media_url) {
            showPreview({ title: full.title, location: full.location, notes: full.notes, mediaUrl: full.media_url, mediaType: full.media_type });
        } else {
            $('#travel-preview').addClass('hidden');
        }

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
                mediaUrl: memory.media_url || null,
                mediaType: memory.media_type || null,
                lat: memory.lat,
                lng: memory.lng,
                publish: !memory.published_at,
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

function setTravelMessage(msg, isError = false) {
    const el = document.getElementById('travel-message');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? 'var(--color-error)' : 'var(--color-success)';
}

// Try to read GPS coords from image EXIF and populate the lat/lng inputs.
async function tryAutofillGpsFromFile(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return;
    if ($('#travel-lat').val() || $('#travel-lng').val()) return;
    try {
        const gps = await exifr.gps(file);
        if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
            $('#travel-lat').val(gps.latitude.toFixed(6));
            $('#travel-lng').val(gps.longitude.toFixed(6));
            setTravelMessage('Location auto-filled from photo EXIF.');
        }
    } catch {
        // EXIF parsing failed — not a problem, just continue
    }
}

// Try to read DateTimeOriginal from image EXIF and populate the date input.
// Only fills if the current value is today's default (i.e. not deliberately set).
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
    $('#travel-file').on('change', function (event) {
        const file = event.target.files && event.target.files[0];
        if (!file) { currentFile = null; return; }
        currentFile = file;

        tryAutofillGpsFromFile(file);
        tryAutofillDateFromFile(file);

        const reader = new FileReader();
        reader.onload = function (e) {
            showPreview({
                title: $('#travel-title').val(),
                location: $('#travel-location').val(),
                notes: $('#travel-notes').val(),
                mediaUrl: e.target.result,
                mediaType: file.type,
            });
        };
        reader.readAsDataURL(file);
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
            let mediaUrl = editingTravelMedia ? editingTravelMedia.url : null;
            let mediaType = editingTravelMedia ? editingTravelMedia.type : null;

            if (currentFile) {
                setTravelMessage('Uploading file…');
                const fd = new FormData();
                fd.append('file', currentFile);
                const upRes = await authFetchMultipart('/upload', fd);
                const upData = await upRes.json();
                if (!upRes.ok) throw new Error(upData.error || 'Upload failed');
                mediaUrl = upData.url;
                mediaType = upData.type;
            }

            const editId = $('#travel-edit-id').val();
            const travel = {
                title,
                location: $('#travel-location').val().trim(),
                notes: $('#travel-notes').val().trim(),
                visitDate: $('#travel-date').val() || null,
                mediaUrl,
                mediaType,
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
    $('#travel-clear').on('click', clearTravelForm);
}

// ── Blog posts ────────────────────────────────────────────────────────────────

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

End with a takeaway, a question, or a link to what's next.
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
    $('#post-date').val('');
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

function loadPostForEdit(post) {
    $('#post-edit-id').val(post.id);
    $('#post-title').val(post.title);
    // Fetch full body via admin route so drafts (published_at IS NULL) are included
    authFetch(`/posts/admin/${post.id}`).then(async r => {
        if (r.ok) {
            const full = await r.json();
            $('#post-body').val(full.body_markdown);
            $('#post-date').val(full.post_date || '');
        }
    });
    $('#post-cancel-btn').removeClass('hidden');
    setPostMessage('Editing: ' + post.title);
    document.getElementById('post-title').scrollIntoView({ behavior: 'smooth' });
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

    $('#post-template-btn').on('click', function () {
        const body = $('#post-body');
        const current = body.val();
        if (current.trim() && !confirm('The body has content — replace it with the template?')) return;
        body.val(POST_TEMPLATE);
        body.focus();
    });
}

// ── Private notes ─────────────────────────────────────────────────────────────

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

// ── Bootstrap ─────────────────────────────────────────────────────────────────

requireAuth();
setLogout();
initTravelForm();
initPrivateNotes();
initPostForm();
loadTravelMemories();
loadAdminPosts();
loadPasskeys();
document.getElementById('add-passkey-btn').addEventListener('click', addPasskey);
