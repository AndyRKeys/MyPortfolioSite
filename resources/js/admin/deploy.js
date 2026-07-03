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
            : `<span style="color:var(--color-error)">↓ ${escapeHtml(String(s.behind))} commit${s.behind !== 1 ? 's' : ''} behind</span>`;
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
                    setBusy(false);
                    await loadStatus();
                    await loadHistory();
                } catch (e) {
                    setBusy(false);
                    setMessage(e.message, true);
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
        return `${icon} ${escapeHtml(run.started_at)} → ${escapeHtml(run.ended_at || '?')}${duration}`;
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

    // Shared by runStream and streamDeployResume — must live at this scope.
    // (It used to be local to runStream; streamDeployResume's reference threw a
    // ReferenceError that was swallowed by its bare catch, so resume after a
    // container restart silently rendered nothing.)
    function parseLine(line) {
        if (!line.startsWith('data: ')) return null;
        try { return JSON.parse(line.slice(6)); } catch { return null; }
    }

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
        let   deployFromByte = 0;
        let   sawStarted = false; // only deploy/rollback streams send 'started'
        let   linesSeen  = 0;   // 'line' events rendered — resume skips this many
        let   finished   = false; // saw a {type:'done'} event → deploy really ended

        let disconnected = false;
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
                    if (data.type === 'started') { sawStarted = true; deployFromByte = data.fromByte; continue; }
                    if (data.type === 'done')    { finished = true; continue; }
                    if (data.type === 'line' || data.type === 'info') {
                        if (data.type === 'line') linesSeen++; // 'info' is synthetic — not in the log
                        output.textContent += data.text + '\n';
                        if (autoscrollToggle.checked) output.scrollTop = output.scrollHeight;
                    }
                    if (data.type === 'error') throw new Error(data.text);
                }
            }
        } catch {
            disconnected = true;
        }

        // A container restart can surface either as a read error (caught above)
        // or as a clean stream end without a 'done' event — resume in both cases.
        // Only deploy/rollback streams (which send 'started') can be resumed;
        // a dropped /fetch stream must not tail the deploy log from byte 0.
        if (sawStarted && (disconnected || !finished)) {
            output.textContent += '\n[Backend restarting…]\n';
            await pollUntilBack();
            output.textContent += '[Backend recovered ✓]\n';
            await streamDeployResume(deployFromByte, linesSeen);
        }

        if (output.textContent.trim()) copyOutputBtn.disabled = false;
    }

    // Resume tails the log from the deploy's starting byte offset, which replays
    // everything already shown — skipLines drops the lines rendered pre-restart
    // so output continues seamlessly instead of duplicating.
    async function streamDeployResume(fromByte = 0, skipLines = 0) {
        const res = await authFetch(`/deploy/stream?fromByte=${fromByte}`).catch(() => null);
        if (!res?.ok) return;
        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let   buf     = '';
        let   skipped = 0;
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
                        if (skipped < skipLines) { skipped++; continue; }
                        output.textContent += data.text + '\n';
                        if (autoscrollToggle.checked) output.scrollTop = output.scrollHeight;
                    }
                }
            }
        } catch { /* stream ended or backend restarted again — leave output as-is */ }
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
            commitList.innerHTML = '<li class="commit-row"><span class="hint">Could not load commits.</span></li>';
        }
    }

    // ── Event listeners ────────────────────────────────────────────────────────

    fetchBtn.addEventListener('click', async () => {
        setMessage('');
        try {
            await runStream('POST', '/deploy/fetch');
            setMessage('Fetch complete.');
            setBusy(false);
            await loadStatus();
        } catch (e) {
            setBusy(false);
            setMessage(e.message, true);
        }
    });

    deployBtn.addEventListener('click', async () => {
        if (!confirm(`Deploy latest to ${deployEnv}?\n\nThe backend will restart briefly.`)) return;
        setMessage('');
        try {
            await runStream('POST', '/deploy/');
            setMessage('Deploy complete.');
            setBusy(false);
            await loadStatus();
            await loadHistory();
        } catch (e) {
            setBusy(false);
            setMessage(e.message, true);
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

    loadStatus().then(() => loadHistory());
}
