/**
 * Admin CV management (#109)
 *
 * Supports versioned CV uploads: every upload creates a new version.
 * The version history table lets the admin set any previous version as current
 * or delete old versions.
 */
import { authFetch, getToken } from './auth.js';
import { API_BASE } from '../config.js';
import { createMessenger } from '../utils/messenger.js';
import { escapeHtml } from '../utils/html.js';

const setMessage = createMessenger('cv-message');

// ── Status badge ──────────────────────────────────────────────────────────────

function updateStatusBadge(exists) {
    const badge = document.getElementById('cv-status-badge');
    if (!badge) return;
    if (exists) {
        badge.textContent = '✓ CV uploaded';
        badge.className = 'cv-status-badge uploaded';
    } else {
        badge.textContent = '✕ No CV uploaded';
        badge.className = 'cv-status-badge not-uploaded';
    }
}

async function loadStatus() {
    try {
        const res = await fetch(`${API_BASE}/cv/exists`);
        const { exists } = await res.json();
        updateStatusBadge(exists);
    } catch {
        setMessage('Could not check CV status.', true);
    }
}

// ── Version history table ─────────────────────────────────────────────────────

function formatDate(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

async function loadHistory() {
    const container = document.getElementById('cv-history');
    if (!container) return;

    try {
        const res  = await authFetch('/cv/history');
        if (!res.ok) throw new Error();
        const rows = await res.json();

        if (!rows.length) {
            container.innerHTML = '<p class="hint">No CV versions uploaded yet.</p>';
            return;
        }

        container.innerHTML = `
            <table class="cv-history-table">
                <thead>
                    <tr>
                        <th>Filename</th>
                        <th>Uploaded</th>
                        <th>Status</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map(r => `
                    <tr class="${r.is_current ? 'cv-row-current' : ''}">
                        <td><code>${escapeHtml(r.filename)}</code></td>
                        <td>${formatDate(r.uploaded_at)}</td>
                        <td>${r.is_current ? '<strong>Current</strong>' : '<span class="hint">Archive</span>'}</td>
                        <td class="cv-row-actions">
                            ${!r.is_current ? `
                            <button type="button" class="btn-small cv-set-current" data-id="${escapeHtml(r.id)}">Set current</button>
                            <button type="button" class="btn-small btn-danger cv-delete-version" data-id="${escapeHtml(r.id)}">Delete</button>
                            ` : '<span class="hint">—</span>'}
                        </td>
                    </tr>`).join('')}
                </tbody>
            </table>`;

        // Bind actions
        container.querySelectorAll('.cv-set-current').forEach(btn => {
            btn.addEventListener('click', () => setCurrent(btn.dataset.id));
        });
        container.querySelectorAll('.cv-delete-version').forEach(btn => {
            btn.addEventListener('click', () => deleteVersion(btn.dataset.id));
        });
    } catch {
        container.innerHTML = '<p class="hint" style="color:var(--color-error)">Failed to load CV history.</p>';
    }
}

async function setCurrent(id) {
    setMessage('');
    try {
        const res = await authFetch(`/cv/${id}/set-current`, { method: 'PUT' });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Failed to set current');
        }
        setMessage('CV version set as current.');
        await Promise.all([loadStatus(), loadHistory()]);
    } catch (err) {
        setMessage(err.message || 'Failed to set current.', true);
    }
}

async function deleteVersion(id) {
    if (!confirm('Delete this CV version? This cannot be undone.')) return;
    setMessage('');
    try {
        const res = await authFetch(`/cv/${id}`, { method: 'DELETE' });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Failed to delete');
        }
        setMessage('CV version deleted.');
        await Promise.all([loadStatus(), loadHistory()]);
    } catch (err) {
        setMessage(err.message || 'Failed to delete.', true);
    }
}

// ── Upload ────────────────────────────────────────────────────────────────────

async function uploadCv(file) {
    const uploadBtn = document.getElementById('cv-upload-btn');
    uploadBtn.disabled = true;
    setMessage('Uploading…');

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
            const warningList = data.warnings.join('\n• ');
            const proceed = confirm(
                `The scan found potential private information in this PDF:\n• ${warningList}\n\nDo you still want to publish it?`
            );
            if (!proceed) {
                // Delete the just-uploaded version
                await authFetch(`/cv/${data.id}`, { method: 'DELETE' });
                setMessage('Upload cancelled — CV removed from server.', true);
                await Promise.all([loadStatus(), loadHistory()]);
                return;
            }
        }

        setMessage('CV uploaded successfully — now set as current.');
        await Promise.all([loadStatus(), loadHistory()]);
    } catch (err) {
        setMessage(err.message || 'Upload failed.', true);
    } finally {
        uploadBtn.disabled = false;
        const input = document.getElementById('cv-file-input');
        if (input) input.value = '';
        const label = document.getElementById('cv-file-label');
        if (label) label.textContent = 'No file chosen';
    }
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initCv() {
    const cvFileInput = document.getElementById('cv-file-input');
    const cvUploadBtn = document.getElementById('cv-upload-btn');

    if (!cvFileInput) return;

    cvFileInput.addEventListener('change', () => {
        cvUploadBtn.disabled = !cvFileInput.files[0];
    });

    cvUploadBtn.addEventListener('click', () => {
        const file = cvFileInput.files[0];
        if (file) uploadCv(file);
    });

    loadStatus();
    loadHistory();
}
