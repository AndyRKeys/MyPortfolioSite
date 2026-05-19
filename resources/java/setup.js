import { startRegistration } from 'https://esm.sh/@simplewebauthn/browser@7';
import { API_BASE } from './config.js'; // note the relative path from resources/java/

function setMessage(msg, isError = false) {
  const el = document.getElementById('setup-message');
  el.textContent = msg;
  el.style.color = isError ? '#c0392b' : '#27ae60';
}

// Redirect if setup is already done
fetch(`${API_BASE}/auth/setup/status`)
  .then(r => r.json())
  .then(({ hasUsers }) => {
    if (hasUsers) {
      setMessage('Setup already complete — redirecting to login…');
      setTimeout(() => location.replace('login.html'), 2000);
    }
  })
  .catch(() => {
    setMessage(
      'Cannot reach the backend. Make sure the server is running on port 3001.',
      true
    );
  });

document.getElementById('setup-form').addEventListener('submit', async event => {
  event.preventDefault();

  const email = document.getElementById('setup-email').value.trim();
  const username = document.getElementById('setup-username').value.trim();
  if (!email || !username) return setMessage('Both fields are required.', true);

  const btn = event.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  setMessage('Creating account…');

  try {
    const setupRes = await fetch(`${API_BASE}/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, username }),
    });
    const setupData = await setupRes.json();
    if (!setupRes.ok) {
      console.error('Setup failed:', setupRes.status, setupData);
      throw new Error(setupData.error || `Account creation failed (${setupRes.status})`);
    }

    const token = setupData.token;
    localStorage.setItem('adminToken', token);

    setMessage('Account created. Follow the passkey prompt on your device…');

    console.log('Requesting WebAuthn registration options from', `${API_BASE}/auth/passkey/register/start`);
    const startRes = await fetch(`${API_BASE}/auth/passkey/register/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });
    const startData = await startRes.json();
    if (!startRes.ok) {
      console.error('Passkey registration start failed:', startRes.status, startData);
      throw new Error(startData.error || `Failed to start passkey registration (${startRes.status})`);
    }
    const { options, sessionKey } = startData;

    const response = await startRegistration(options);
    console.log('WebAuthn registration response received');

    const finishRes = await fetch(`${API_BASE}/auth/passkey/register/finish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        response,
        sessionKey,
        passkeyName: 'Primary passkey',
      }),
    });
    const finishData = await finishRes.json();
    if (!finishRes.ok) {
      console.error('Passkey registration finish failed:', finishRes.status, finishData);
      throw new Error(finishData.error || `Passkey registration failed (${finishRes.status})`);
    }

    setMessage('All done — redirecting to dashboard…');
    setTimeout(() => location.replace('admin.html'), 1200);
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      setMessage(
        'Passkey prompt was cancelled. You are logged in but have no passkey yet — add one from the admin dashboard.',
        true
      );
      setTimeout(() => location.replace('admin.html'), 3500);
    } else {
      setMessage(err.message || 'Setup failed.', true);
      btn.disabled = false;
    }
  }
});