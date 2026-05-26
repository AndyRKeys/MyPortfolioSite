import { authFetch, todayIso } from './auth.js';
import { escapeHtml } from '../utils/html.js';

// ── Post body template ────────────────────────────────────────────────────────

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

End with a takeaway, a question, or a link to what\'s next.
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function setMessage(msg, isError = false) {
    const el = document.getElementById('post-message');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? 'var(--color-error)' : 'var(--color-success)';
}

function clearForm() {
    document.getElementById('post-edit-id').value = '';
    document.getElementById('post-title').value = '';
    document.getElementById('post-body').value = '';
    document.getElementById('post-date').value = todayIso();
    document.getElementById('post-cancel-btn').classList.add('hidden');
    setMessage('');
}

function buildRow(post) {
    const div = document.createElement('div');
    div.className = 'saved-memory-row';

    const info = document.createElement('div');
    info.className = 'saved-memory-info';
    const statusLabel = post.published_at
        ? '<span class="post-status published">Published</span>'
        : '<span class="post-status draft">Draft</span>';
    info.innerHTML = '<strong>' + escapeHtml(post.title) + '</strong> ' + statusLabel;
    const dateSpan = document.createElement('span');
    dateSpan.className = 'saved-memory-date';
    dateSpan.textContent = ' · ' + new Date(post.created_at).toLocaleDateString();
    info.append(dateSpan);

    const actions = document.createElement('div');
    actions.className = 'post-admin-actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-small';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => loadForEdit(post));

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn-small';
    toggleBtn.textContent = post.published_at ? 'Unpublish' : 'Publish';
    toggleBtn.addEventListener('click', () => togglePublish(post));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-small btn-danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => deletePost(post.id));

    actions.append(editBtn, toggleBtn, delBtn);
    div.append(info, actions);
    return div;
}

// ── Data operations ───────────────────────────────────────────────────────────

async function loadAll() {
    const list = document.getElementById('posts-admin-list');
    list.innerHTML = '<p class="hint">Loading…</p>';
    try {
        const res = await authFetch('/posts/all');
        if (!res.ok) throw new Error();
        const posts = await res.json();
        if (!posts.length) { list.innerHTML = '<p class="hint">No posts yet.</p>'; return; }
        list.innerHTML = '';
        posts.forEach(p => list.append(buildRow(p)));
    } catch {
        list.innerHTML = '<p class="hint" style="color:var(--color-error)">Failed to load posts.</p>';
    }
}

// #95 fix: async so body_markdown and post_date always populate before user interaction.
// #93 fix: slice ISO timestamp to YYYY-MM-DD before setting <input type="date">.
async function loadForEdit(post) {
    document.getElementById('post-edit-id').value = post.id;
    document.getElementById('post-title').value = post.title;
    document.getElementById('post-cancel-btn').classList.remove('hidden');
    setMessage('Editing: ' + post.title);
    document.getElementById('post-title').scrollIntoView({ behavior: 'smooth' });

    try {
        const r = await authFetch(`/posts/admin/${post.id}`);
        if (!r.ok) throw new Error();
        const full = await r.json();
        document.getElementById('post-body').value = full.body_markdown || '';
        document.getElementById('post-date').value = full.post_date ? String(full.post_date).slice(0, 10) : todayIso();
    } catch {
        setMessage('Failed to load post body — please try again.', true);
    }
}

async function togglePublish(post) {
    try {
        const res = await authFetch(`/posts/${post.id}`, {
            method: 'PUT',
            body: JSON.stringify({
                title: post.title,
                body_markdown: post.body_markdown || '',
                // Slice to YYYY-MM-DD — list response returns full ISO timestamp (#93)
                post_date: post.post_date ? String(post.post_date).slice(0, 10) : null,
                publish: !post.published_at,
            }),
        });
        if (!res.ok) throw new Error();
        await loadAll();
    } catch {
        alert('Failed to update post.');
    }
}

async function deletePost(id) {
    if (!confirm('Delete this post? This cannot be undone.')) return;
    try {
        const res = await authFetch(`/posts/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error();
        clearForm();
        await loadAll();
    } catch {
        alert('Failed to delete post.');
    }
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initPosts() {
    loadAll();

    document.getElementById('post-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const clickedBtn = document.activeElement;
        const publish = clickedBtn && clickedBtn.id === 'post-publish-btn';
        const submitBtns = event.currentTarget.querySelectorAll('button[type="submit"]');
        submitBtns.forEach(b => b.disabled = true);
        setMessage('Saving…');

        const id            = document.getElementById('post-edit-id').value;
        const title         = document.getElementById('post-title').value.trim();
        const body_markdown = document.getElementById('post-body').value;
        const post_date     = document.getElementById('post-date').value || null;

        if (!title) {
            setMessage('Title is required.', true);
            submitBtns.forEach(b => b.disabled = false);
            return;
        }

        try {
            const method = id ? 'PUT' : 'POST';
            const path   = id ? `/posts/${id}` : '/posts';
            const res = await authFetch(path, {
                method,
                body: JSON.stringify({ title, body_markdown, post_date, publish }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Save failed');
            setMessage(publish ? 'Post published.' : 'Draft saved.');
            clearForm();
            await loadAll();
        } catch (err) {
            setMessage(err.message || 'Failed to save post.', true);
        } finally {
            submitBtns.forEach(b => b.disabled = false);
        }
    });

    document.getElementById('post-cancel-btn').addEventListener('click', clearForm);

    document.getElementById('post-clear-btn').addEventListener('click', () => {
        if (document.getElementById('post-edit-id').value
            || document.getElementById('post-title').value
            || document.getElementById('post-body').value) {
            if (!confirm('Clear all fields and start a new post?')) return;
        }
        clearForm();
    });

    document.getElementById('post-template-btn').addEventListener('click', () => {
        const body = document.getElementById('post-body');
        if (body.value.trim() && !confirm('The body has content — replace it with the template?')) return;
        body.value = POST_TEMPLATE;
        body.focus();
    });
}
