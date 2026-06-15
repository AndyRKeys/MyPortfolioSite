import { authFetch, authFetchMultipart, todayIso } from '../auth.js';
import { setMessage } from './messages.js';
import { hideGeoconfirmMap } from './geocode.js';
import {
    getPendingFiles, getExistingMedia,
    setPendingFiles, setExistingMedia, setRemovedMediaIds,
    appendPendingFiles, renderMediaList,
} from './media.js';
import { tryAutofillGpsFromFileList, tryAutofillDateFromFile } from './exif.js';
import { loadAll } from './list.js';

// ── Form reset ────────────────────────────────────────────────────────────────

export function clearForm() {
    document.getElementById('travel-edit-id').value = '';
    document.getElementById('travel-form').reset();
    document.getElementById('travel-cancel-btn').classList.add('hidden');
    document.querySelector('.file-input-label').textContent = 'No files chosen';
    document.getElementById('travel-date').value = todayIso();
    document.getElementById('travel-preview').classList.add('hidden');
    document.querySelector('.preview-media').innerHTML = '';
    document.querySelector('.preview-text').innerHTML = '';
    setPendingFiles([]);
    setExistingMedia([]);
    setRemovedMediaIds([]);
    renderMediaList();
    setMessage('');
    hideGeoconfirmMap();
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initForm() {
    document.getElementById('travel-file').addEventListener('change', (event) => {
        const files = Array.from(event.target.files || []);
        if (!files.length) return;

        tryAutofillGpsFromFileList(files);

        const sortedImages = files
            .filter(f => f.type && f.type.startsWith('image/'))
            .sort((a, b) => a.name.localeCompare(b.name));
        if (sortedImages.length) tryAutofillDateFromFile(sortedImages[0]);

        appendPendingFiles(files);
        const pendingFiles = getPendingFiles();
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
            const pendingFiles = getPendingFiles();
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
                ...getExistingMedia().filter(m => m.id !== null).map(m => ({ url: m.url, type: m.type })),
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
            || getPendingFiles().length) {
            if (!confirm('Clear all fields and start a new memory?')) return;
        }
        clearForm();
    });
}
