import { authFetch, todayIso } from './auth.js';
import { escapeHtml } from '../utils/html.js';
import { createMessenger } from '../utils/messenger.js';

// ── Entry body template ───────────────────────────────────────────────────────

const ENTRY_TEMPLATE = `_One-line summary of today's session._

## What we worked on

Brief description of the issue or feature tackled this session.

## What we built

- Key change one
- Key change two
- Key change three

## What broke / what was tricky

Honest note about any obstacles, wrong turns, or surprising complexity.

## What we learned

Any insight worth capturing — about the codebase, the tools, or the process.

## Next up

What's queued for the next session.
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

const setMessage    = createMessenger('ai-blog-message');
const setGenMessage = createMessenger('ai-blog-gen-message');

function clearForm() {
    document.getElementById('ai-blog-edit-id').value = '';
    document.getElementById('ai-blog-title').value = '';
    document.getElementById('ai-blog-body').value = '';
    document.getElementById('ai-blog-date').value = todayIso();
    document.getElementById('ai-blog-cancel-btn').classList.add('hidden');
    setMessage('');
}

function buildRow(entry) {
    const div = document.createElement('div');
    div.className = 'saved-memory-row';

    const info = document.createElement('div');
    info.className = 'saved-memory-info';
    const statusLabel = entry.published_at
        ? '<span class="post-status published">Published</span>'
        : '<span class="post-status draft">Draft</span>';
    info.innerHTML = '<strong>' + escapeHtml(entry.title) + '</strong> ' + statusLabel;
    const dateSpan = document.createElement('span');
    dateSpan.className = 'saved-memory-date';
    dateSpan.textContent = ' · ' + new Date(entry.created_at).toLocaleDateString();
    info.append(dateSpan);

    const actions = document.createElement('div');
    actions.className = 'post-admin-actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-small';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => loadForEdit(entry));

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn-small';
    toggleBtn.textContent = entry.published_at ? 'Unpublish' : 'Publish';
    toggleBtn.addEventListener('click', () => togglePublish(entry));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-small btn-danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => deleteEntry(entry.id));

    actions.append(editBtn, toggleBtn, delBtn);
    div.append(info, actions);
    return div;
}

// ── Data operations ───────────────────────────────────────────────────────────

async function loadAll() {
    const list = document.getElementById('ai-blog-admin-list');
    list.innerHTML = '<p class="hint">Loading…</p>';
    try {
        const res = await authFetch('/ai-blog/all');
        if (!res.ok) throw new Error();
        const entries = await res.json();
        if (!entries.length) { list.innerHTML = '<p class="hint">No entries yet.</p>'; return; }
        list.innerHTML = '';
        entries.forEach(e => list.append(buildRow(e)));
    } catch {
        list.innerHTML = '<p class="hint" style="color:var(--color-error)">Failed to load entries.</p>';
    }
}

async function loadForEdit(entry) {
    document.getElementById('ai-blog-edit-id').value = entry.id;
    document.getElementById('ai-blog-title').value = entry.title;
    document.getElementById('ai-blog-cancel-btn').classList.remove('hidden');
    setMessage('Editing: ' + entry.title);
    document.getElementById('ai-blog-title').scrollIntoView({ behavior: 'smooth' });

    try {
        const r = await authFetch(`/ai-blog/admin/${entry.id}`);
        if (!r.ok) throw new Error();
        const full = await r.json();
        document.getElementById('ai-blog-body').value = full.body_markdown || '';
        document.getElementById('ai-blog-date').value = full.post_date ? String(full.post_date).slice(0, 10) : todayIso();
    } catch {
        setMessage('Failed to load entry body — please try again.', true);
    }
}

async function togglePublish(entry) {
    try {
        const res = await authFetch(`/ai-blog/${entry.id}`, {
            method: 'PUT',
            body: JSON.stringify({
                title:         entry.title,
                body_markdown: entry.body_markdown || '',
                post_date:     entry.post_date ? String(entry.post_date).slice(0, 10) : null,
                publish:       !entry.published_at,
            }),
        });
        if (!res.ok) throw new Error();
        await loadAll();
    } catch {
        alert('Failed to update entry.');
    }
}

async function deleteEntry(id) {
    if (!confirm('Delete this entry? This cannot be undone.')) return;
    try {
        const res = await authFetch(`/ai-blog/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error();
        clearForm();
        await loadAll();
    } catch {
        alert('Failed to delete entry.');
    }
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initAiBlog() {
    // Set date field default to today on page load
    document.getElementById('ai-blog-date').value = todayIso();

    loadAll();

    document.getElementById('ai-blog-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const clickedBtn = document.activeElement;
        const publish = clickedBtn && clickedBtn.id === 'ai-blog-publish-btn';
        const submitBtns = event.currentTarget.querySelectorAll('button[type="submit"]');
        submitBtns.forEach(b => b.disabled = true);
        setMessage('Saving…');

        const id            = document.getElementById('ai-blog-edit-id').value;
        const title         = document.getElementById('ai-blog-title').value.trim();
        const body_markdown = document.getElementById('ai-blog-body').value;
        const post_date     = document.getElementById('ai-blog-date').value || null;

        if (!title) {
            setMessage('Title is required.', true);
            submitBtns.forEach(b => b.disabled = false);
            return;
        }

        try {
            const method = id ? 'PUT' : 'POST';
            const path   = id ? `/ai-blog/${id}` : '/ai-blog';
            const res = await authFetch(path, {
                method,
                body: JSON.stringify({ title, body_markdown, post_date, publish }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Save failed');
            setMessage(publish ? 'Entry published.' : 'Draft saved.');
            clearForm();
            await loadAll();
        } catch (err) {
            setMessage(err.message || 'Failed to save entry.', true);
        } finally {
            submitBtns.forEach(b => b.disabled = false);
        }
    });

    document.getElementById('ai-blog-cancel-btn').addEventListener('click', clearForm);

    document.getElementById('ai-blog-clear-btn').addEventListener('click', () => {
        if (document.getElementById('ai-blog-edit-id').value
            || document.getElementById('ai-blog-title').value
            || document.getElementById('ai-blog-body').value) {
            if (!confirm('Clear all fields and start a new entry?')) return;
        }
        clearForm();
    });

    document.getElementById('ai-blog-template-btn').addEventListener('click', () => {
        const body = document.getElementById('ai-blog-body');
        if (body.value.trim() && !confirm('The body has content — replace it with the template?')) return;
        body.value = ENTRY_TEMPLATE;
        body.focus();
    });

    document.getElementById('ai-blog-gen-btn').addEventListener('click', async () => {
        const genBtn = document.getElementById('ai-blog-gen-btn');
        const context = document.getElementById('ai-blog-gen-context').value.trim();
        genBtn.disabled = true;
        setGenMessage('Generating…');

        try {
            const res = await authFetch('/ai-blog/generate', {
                method: 'POST',
                body: JSON.stringify({ context }),
            });

            if (res.status === 503) {
                setGenMessage('AI generation not configured (ANTHROPIC_API_KEY not set).', true);
                return;
            }
            if (!res.ok) {
                setGenMessage('Generation failed — try again.', true);
                return;
            }

            const data = await res.json();
            document.getElementById('ai-blog-title').value = data.title || '';
            document.getElementById('ai-blog-body').value  = data.body_markdown || '';
            setGenMessage('Draft generated — review and save.');
        } catch {
            setGenMessage('Generation failed — try again.', true);
        } finally {
            genBtn.disabled = false;
        }
    });
}
