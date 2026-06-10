import { authFetch } from './auth.js';
import { escapeHtml } from '../utils/html.js';
import { createMessenger } from '../utils/messenger.js';

// ── Constants ─────────────────────────────────────────────────────────────────

// Together these encode a ~60 s recovery window after a backend restart.
const MAX_POLL_ATTEMPTS  = 30;
const POLL_INTERVAL_MS   = 2000;

export function initDeploy() {
    let deployEnv = 'prod'; // fallback until status loads

    const fetchBtn        = document.getElementById('fetch-btn');
    const deployBtn       = document.getElementById('deploy-btn');
    const rollbackBtn     = document.getElementById('rollback-btn');
    const rollbackPicker  = document.getElementById('rollback-picker');
    const rollbackSelect  = document.getElementById('rollback-sha-select');
    const rollbackConfirm = document.getElementById('rollback-confirm-btn');
    const rollbackCancel  = document.getElementById('rollback-cancel-btn');
    const output          = document.getElementById('deploy-output');
    const message         = document.getElementById('deploy-message');
    const statusRow       = document.getElementById('deploy-status-row');
    const logList         = document.getElementById('deploy-log-list');

    const setMessage = createMessenger('deploy-message');

    function setBusy(busy) {
        fetchBtn.disabled        = busy;
        deployBtn.disabled       = busy;
        rollbackBtn.disabled     = busy;
        rollbackConfirm.disabled = busy;
    }

    function renderStatus(s) {
        if (s.env) deployEnv = s.env;
        const badge = s.upToDate
            ? '<span style="color:var(--color-success)">✓ Up to date</span>'
            : `<span style="color:var(--color-error)">↓ ${s.behind} commit${s.behind !== 1 ? 's' : ''} behind</span>`;
        statusRow.innerHTML =
            `<strong>${escapeHtml(s.head.sha)}</strong> — ${escapeHtml(s.head.message)}&nbsp;&nbsp;${badge}`;
        if (s.canDeploy) {
            fetchBtn.disabled    = false;
            deployBtn.disabled   = false;
            rollbackBtn.disabled = false;
        } else {
            setMessage('Deploy script not found — status is read-only in local dev.', true);
        }
    }

    function renderLog(data) {
        const rows = data.deployLog.map(e =>
            `<p style="font-size:0.85rem;font-family:monospace">${escapeHtml(e.ts ? '[' + e.ts + '] ' : '')}${escapeHtml(e.detail)}</p>`
        ).join('');
        logList.innerHTML = rows || '<p class="hint">No deploy log entries yet.</p>';

        rollbackSelect.innerHTML = data.commits.map(c =>
            `<option value="${escapeHtml(c.sha)}">${escapeHtml(c.shortSha)} — ${escapeHtml(c.message)}</option>`
        ).join('');
    }

    // Uses fetch streaming (supports Authorization header, works with POST).
    // Reads SSE-formatted lines from the response body and appends to output panel.
    // On connection drop (backend restart), polls /deploy/status until backend recovers.
    async function runStream(method, path, body) {
        output.textContent = '';
        output.classList.remove('hidden');
        setBusy(true);

        const res = await authFetch(path, {
            method,
            body:    body ? JSON.stringify(body) : undefined,
            headers: body ? { 'Content-Type': 'application/json' } : {},
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || res.statusText);
        }

        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let   buf     = '';

        const parseLine = (line) => {
            if (!line.startsWith('data: ')) return null;
            try { return JSON.parse(line.slice(6)); } catch { return null; }
        };

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const line of lines) {
                    const data = parseLine(line);
                    if (!data) continue;
                    if (data.type === 'line')  { output.textContent += data.text + '\n'; output.scrollTop = output.scrollHeight; }
                    if (data.type === 'error') throw new Error(data.text);
                    // 'done' event falls through — stream naturally ends
                }
            }
        } catch {
            // Connection drop = backend restarting — poll until backend is back
            output.textContent += '\n[Backend restarting…]\n';
            await pollUntilBack();
            output.textContent += '[Backend recovered ✓]\n';
        }
    }

    // Poll /deploy/status until the backend responds (up to 60s)
    async function pollUntilBack(attempts = 0) {
        if (attempts > MAX_POLL_ATTEMPTS) throw new Error('Backend did not recover within 60s');
        try {
            const r = await authFetch('/deploy/status');
            if (!r.ok) throw new Error();
            renderStatus(await r.json());
        } catch {
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
            return pollUntilBack(attempts + 1);
        }
    }

    async function loadStatus() {
        try {
            const r = await authFetch('/deploy/status');
            if (!r.ok) throw new Error(await r.text());
            renderStatus(await r.json());
        } catch (e) {
            statusRow.innerHTML =
                `<span style="color:var(--color-error)">Status unavailable: ${escapeHtml(e.message)}</span>`;
        }
    }

    async function loadHistory() {
        try {
            const r = await authFetch('/deploy/history');
            if (!r.ok) throw new Error();
            renderLog(await r.json());
        } catch {
            logList.innerHTML = '<p class="hint">Could not load history.</p>';
        }
    }

    fetchBtn.addEventListener('click', async () => {
        setMessage('');
        try {
            await runStream('POST', '/deploy/fetch');
            setMessage('Fetch complete.');
            await loadStatus();
        } catch (e) {
            setMessage(e.message, true);
        } finally {
            setBusy(false);
        }
    });

    deployBtn.addEventListener('click', async () => {
        if (!confirm(`Deploy latest to ${deployEnv}?\n\nThe backend will restart briefly.`)) return;
        setMessage('');
        try {
            await runStream('POST', '/deploy/');
            setMessage('Deploy complete.');
            await loadStatus();
            await loadHistory();
        } catch (e) {
            setMessage(e.message, true);
        } finally {
            setBusy(false);
        }
    });

    rollbackBtn.addEventListener('click', () => rollbackPicker.classList.toggle('hidden'));
    rollbackCancel.addEventListener('click', () => rollbackPicker.classList.add('hidden'));

    rollbackConfirm.addEventListener('click', async () => {
        const sha   = rollbackSelect.value;
        const label = rollbackSelect.options[rollbackSelect.selectedIndex]?.text || sha;
        if (!sha) return;
        if (!confirm(`Roll back to:\n${label}\n\nThis will restart the backend.`)) return;
        rollbackPicker.classList.add('hidden');
        setMessage('');
        try {
            await runStream('POST', '/deploy/rollback', { sha });
            setMessage('Rollback complete.');
            await loadStatus();
            await loadHistory();
        } catch (e) {
            setMessage(e.message, true);
        } finally {
            setBusy(false);
        }
    });

    loadStatus();
    loadHistory();
}
