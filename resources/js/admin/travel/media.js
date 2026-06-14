// ── Module state ──────────────────────────────────────────────────────────────

let pendingFiles    = [];   // File objects queued for upload
let existingMedia   = [];   // {id, url, type} from post_media (on edit)
let removedMediaIds = [];   // post_media ids to delete on save

export const getPendingFiles    = () => pendingFiles;
export const getExistingMedia   = () => existingMedia;
export const getRemovedMediaIds = () => removedMediaIds;

export function setPendingFiles(files)    { pendingFiles    = files; }
export function setExistingMedia(media)   { existingMedia   = media; }
export function setRemovedMediaIds(ids)   { removedMediaIds = ids; }
export function appendPendingFiles(files) { pendingFiles    = pendingFiles.concat(files); }

// ── Media list renderer ───────────────────────────────────────────────────────

export function renderMediaList() {
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
