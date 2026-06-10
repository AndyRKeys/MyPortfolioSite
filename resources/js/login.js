// Login page authentication handler — extracted from inline script to satisfy CSP script-src.
// Handles: passkey registration, email magic links, auto-verification from URL token.

// Version pin: keep in sync with admin/passkeys.js (#434).
import { startAuthentication } from 'https://esm.sh/@simplewebauthn/browser@7';
import { API_BASE } from './config.js';
import { isAdminSession } from './auth-utils.js';

function setMessage(msg, isError = false) {
    const el = document.getElementById('login-message');
    el.textContent = msg;
    el.style.color = isError ? 'var(--color-error)' : 'var(--color-success)';
}

if (isAdminSession()) {
    location.replace('/admin/');
}

// Auto-verify email magic link token from URL
const params = new URLSearchParams(location.search);
const emailToken = params.get('token');
if (emailToken) {
    const statusEl = document.getElementById('verify-status');
    statusEl.style.display = '';
    statusEl.textContent = 'Verifying your login link…';

    fetch(`${API_BASE}/auth/email/verify?token=${encodeURIComponent(emailToken)}`)
        .then(r => r.json().then(data => ({ ok: r.ok, data })))
        .then(({ ok, data }) => {
            if (!ok) throw new Error(data.error || 'Verification failed');
            localStorage.setItem('adminToken', data.token);
            location.replace('/admin/');
        })
        .catch(err => {
            statusEl.textContent = err.message;
            statusEl.style.color = 'var(--color-error)';
        });
}

// Passkey sign-in
document.getElementById('passkey-btn').addEventListener('click', async () => {
    const btn = document.getElementById('passkey-btn');
    btn.disabled = true;
    btn.textContent = 'Waiting for passkey…';
    setMessage('');

    try {
        const startRes = await fetch(`${API_BASE}/auth/passkey/login/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        const { options, sessionKey } = await startRes.json();

        const response = await startAuthentication(options);

        const finishRes = await fetch(`${API_BASE}/auth/passkey/login/finish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ response, sessionKey }),
        });
        const data = await finishRes.json();
        if (!finishRes.ok) throw new Error(data.error || 'Authentication failed');

        localStorage.setItem('adminToken', data.token);
        location.replace('/admin/');
    } catch (err) {
        if (err.name === 'NotAllowedError') {
            setMessage('Passkey sign-in was cancelled.', true);
        } else {
            setMessage(err.message || 'Sign-in failed. Try the magic link instead.', true);
        }
    } finally {
        btn.disabled = false;
        btn.textContent = 'Sign in with passkey';
    }
});

// Email magic link
document.getElementById('email-form').addEventListener('submit', async event => {
    event.preventDefault();
    const email = document.getElementById('email-input').value.trim();
    if (!email) return setMessage('Please enter your email.', true);

    const btn = event.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    setMessage('');

    try {
        const res = await fetch(`${API_BASE}/auth/email/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
        });
        const data = await res.json();
        setMessage(data.message || 'Check your inbox for the login link.');
    } catch {
        setMessage('Failed to send email. Is the backend running?', true);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Send magic link';
    }
});
