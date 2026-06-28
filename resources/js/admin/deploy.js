import { authFetch } from './auth.js';
import { escapeHtml } from '../utils/html.js';
import { createMessenger } from '../utils/messenger.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS  = 2000;

export function initDeploy() {
    let deployEnv  = 'prod';
    let currentSha = null;

    const fetchBtn         = document.getElementById('fetch-btn');
    const deployBtn        = document.getElementById('deploy-btn');
    const output           = document.getElementById('deploy-output');
    const outputControls   = document.getElementById('deploy-output-controls');
    const autoscrollToggle = document.getElementById('autoscroll-toggle');
    const copyOutputBtn    = document.getElementById('copy-output-btn');
    const statusRow        = document.getElementById('deploy-status-row');
    const commitList       = document.getElementById('commit-list');
    const logList          = document.getElementById('deploy-log-list');

    const setMessage = createMessenger('deploy-message');

    function setBusy(busy) {
        fetchBtn.disabled  = busy;
        deployBtn.disabled = busy;
        commitList.querySelectorAll('.rollback-btn').forEach(btn => { btn.disabled = busy; });
    }

    function renderStatus(s) {
        if (s.env)            deployEnv  = s.env;
        if (s.head?.full_sha) currentSha = s.head.full_sha;
        const badge = s.up_to_date
            ? '<span style="color:var(--color-success)">✓ Up to date</span>'
            : `<span style="color:var(--color-error)">↓ ${s.behind} commit${s.behind !== 1 ? 's' : ''} behind</span>`;
        statusRow.innerHTML =
            `<strong>${escapeHtml(s.head.sha)}</strong> — ${escapeHtml(s.head.message)}&nbsp;&nbsp;${badge}`;
        if (s.can_deploy) {
            fetchBtn.disabled  = false;
            deployBtn.disabled = false;
        } else {
            setMessage('Deploy script not found — status is read-only in local dev.', true);
        }
    }

    // ── Commit browser ─────────────────────────────────────────────────────────

    function renderCommitBrowser(commits) {
        if (!commits.length) {
            commitList.innerHTML = '<li class="commit-row"><span class="hint">No commits found.</span></li>';
            return;
        }
        commitList.innerHTML = commits.map(c => {
            const isCurrent = currentSha && currentSha.startsWith(c.short_sha);
            const date      = c.date ? c.date.slice(0, 10) : '';
            return `<li class="commit-row">
                <span class="commit-sha">${escapeHtml(c.short_sha)}</span>
                <span class="commit-message">${escapeHtml(c.message)}</span>
                <span class="commit-date">${escapeHtml(date)}</span>
                ${isCurrent ? '<span class="commit-current">(current)</span>' : ''}
                <button type="button" class="btn-small btn-danger rollback-btn"
                    data-sha="${escapeHtml(c.sha)}"
                    data-msg="${escapeHtml(c.message)}"
                    ${isCurrent ? 'disabled' : ''}>Roll back</button>
            </li>`;
        }).join('');

        commitList.querySelectorAll('.rollback-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const sha = btn.dataset.sha;
                const msg = btn.dataset.msg;
                if (!confirm(`Roll back to ${sha.slice(0, 7)} — ${msg}?\n\nThe backend will restart briefly.`)) return;
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
        });
    }

    // ── Deploy history ─────────────────────────────────────────────────────────

    function formatRunSummary(run) {
        const icon = run.status === 'ok' ? '✅' : run.status === 'failed' ? '❌' : '⚠️';
        let duration = '';
        if (run.started_at && run.ended_at) {
            const start = new Date(run.started_at.replace(' ', 'T'));
            const end   = new Date(run.ended_at.replace(' ', 'T'));
            const secs  = Math.round((end - start) / 1000);
            duration = secs >= 60
                ? ` (${Math.floor(secs / 60)}m ${secs % 60}s)`
                : ` (${secs}s)`;
        }
        return `${icon} ${escapeHtml(run.started_at)} → ${escapeHtml(run.ended_at || '?')}${escapeHtml(duration)}`;
    }

    function renderLog(data) {
        renderCommitBrowser(data.commits || []);

        const runs = data.deploy_runs || [];
        if (!runs.length) {
            logList.innerHTML = '<p class="hint">No deploy history yet.</p>';
            return;
        }
        logList.innerHTML = runs.map(run =>
            `<details class="deploy-run">
                <summary class="deploy-run-summary">${formatRunSummary(run)}</summary>
                <pre class="deploy-output" style="margin-top:0.5rem">${escapeHtml(run.raw)}</pre>
            </details>`
        ).join('');
    }

    // ── Stream runner ──────────────────────────────────────────────────────────

    async function runStream(method, path, body) {
        output.textContent       = '';
        autoscrollToggle.checked = true;
        copyOutputBtn.disabled   = true;
        outputControls.classList.remove('hidden');
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
                    if (data.type === 'line') {
                        output.textContent += data.text + '\n';
                        if (autoscrollToggle.checked) output.scrollTop = output.scrollHeight;
                    }
                    if (data.type === 'error') throw new Error(data.text);
                }
            }
        } catch {
            output.textContent += '\n[Backend restarting…]\n';
            await pollUntilBack();
            output.textContent += '[Backend recovered ✓]\n';
        }

        if (output.textContent.trim()) copyOutputBtn.disabled = false;
    }

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

    // ── Data loaders ───────────────────────────────────────────────────────────

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

    // ── Event listeners ────────────────────────────────────────────────────────

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

    copyOutputBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(output.textContent);
            const prev = copyOutputBtn.textContent;
            copyOutputBtn.textContent = 'Copied!';
            setTimeout(() => { copyOutputBtn.textContent = prev; }, 1500);
        } catch {
            setMessage('Could not copy to clipboard.', true);
        }
    });

    loadStatus();
    loadHistory();
}
