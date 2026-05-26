import { authFetch, getToken } from './auth.js';
import { API_BASE } from '../config.js';

function setMessage(msg, isError = false) {
    const el = document.getElementById('cv-message');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? 'var(--color-error)' : 'var(--color-success)';
}

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
    const deleteBtn = document.getElementById('cv-delete-btn');
    if (deleteBtn) deleteBtn.disabled = !exists;
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
                await authFetch('/cv', { method: 'DELETE' });
                setMessage('Upload cancelled — CV removed from server.', true);
                await loadStatus();
                return;
            }
        }

        setMessage('CV uploaded successfully.');
        await loadStatus();
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

async function deleteCv() {
    if (!confirm('Delete the current CV? It will no longer be available for download.')) return;
    setMessage('');
    try {
        const res = await authFetch('/cv', { method: 'DELETE' });
        if (!res.ok) throw new Error();
        setMessage('CV deleted.');
        await loadStatus();
    } catch {
        setMessage('Failed to delete CV.', true);
    }
}

export function initCv() {
    const cvFileInput = document.getElementById('cv-file-input');
    const cvUploadBtn = document.getElementById('cv-upload-btn');
    const cvDeleteBtn = document.getElementById('cv-delete-btn');

    if (!cvFileInput) return;

    // Enable upload button when a file is selected (rename notice handled by admin-init.js)
    cvFileInput.addEventListener('change', () => {
        cvUploadBtn.disabled = !cvFileInput.files[0];
    });

    cvUploadBtn.addEventListener('click', () => {
        const file = cvFileInput.files[0];
        if (file) uploadCv(file);
    });

    cvDeleteBtn.addEventListener('click', deleteCv);

    loadStatus();
}
