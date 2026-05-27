import { startRegistration } from 'https://esm.sh/@simplewebauthn/browser@7';
import { authFetch } from './auth.js';
import { escapeHtml } from '../utils/html.js';

function setMessage(msg, isError = false) {
    const el = document.getElementById('passkey-message');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? 'var(--color-error)' : 'var(--color-success)';
}

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
    setMessage('');
    try {
        const res = await authFetch(`/auth/passkeys/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Delete failed');
        await loadPasskeys();
        // Warn if the user has removed all passkeys — they can still sign in via magic link (#283)
        const remaining = document.querySelectorAll('#passkey-list .passkey-row');
        if (remaining.length === 0) {
            setMessage('No passkeys registered. You can still sign in with a magic link from the login page.');
        }
    } catch {
        setMessage('Failed to remove passkey.', true);
    }
}

async function addPasskey() {
    const btn = document.getElementById('add-passkey-btn');
    btn.disabled = true;
    setMessage('Follow the passkey prompt on your device…');
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
        setMessage('Passkey added successfully.');
        await loadPasskeys();
    } catch (err) {
        setMessage(
            err.name === 'NotAllowedError' ? 'Passkey prompt was cancelled.' : (err.message || 'Failed to add passkey.'),
            true
        );
    } finally {
        btn.disabled = false;
    }
}

export function initPasskeys() {
    loadPasskeys();
    document.getElementById('add-passkey-btn').addEventListener('click', addPasskey);
}
