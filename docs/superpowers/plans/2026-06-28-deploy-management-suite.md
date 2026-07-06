# Deploy Management Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the broken deploy history panel, replace the rollback dropdown with an inline commit browser, and add auto-scroll/copy controls to the live output panel.

**Architecture:** Six discrete changes — infrastructure (log path + volume mount), backend (parser util + history endpoint), and frontend (CSS + HTML + JS). The deploy log parser is extracted as a pure utility function (`backend/utils/deployLogParser.js`) for clean testability. All other changes are in-place modifications to existing files.

**Tech Stack:** Node.js/Express, Vitest + Supertest (tests), vanilla JS ES modules (frontend), docker-compose volume mounts, bash (deploy.sh log path)

---

## File map

| File | Action | What changes |
|------|--------|-------------|
| `scripts/deploy/deploy.sh` | Modify | Change `LOG_FILE` paths to `~/logs/`; add `mkdir -p` |
| `docker-compose.yml` | Modify | Add `${HOME}/logs:/app/logs:ro` volume under backend |
| `backend/utils/deployLogParser.js` | **Create** | Pure function `parseDeployRuns(logText, limit)` |
| `backend/tests/utils/deployLogParser.test.js` | **Create** | Unit tests for the parser |
| `backend/routes/deploy.js` | Modify | Import parser; update `DEPLOY_LOG`; use parser in `/history`; `-20` commits |
| `admin/deploy.html` | Modify | Remove rollback picker; add commit browser + output controls HTML |
| `resources/js/admin/deploy.js` | Modify | New commit browser render/rollback logic; auto-scroll/copy controls; updated `renderLog` |
| `resources/css/styles.css` | Modify | Add `.commit-browser`, `.commit-row`, `.deploy-output-controls` styles |

---

## Task 1: Fix deploy log path in deploy.sh

**Files:**
- Modify: `scripts/deploy/deploy.sh:117,137`

The log file is written to `~/dev-deploy.log` and `~/prod-deploy.log` on the host. Moving it to `~/logs/` lets us mount just that directory (read-only) into the backend container without exposing the full home dir.

- [ ] **Step 1: Update LOG_FILE paths and add mkdir**

In `scripts/deploy/deploy.sh`, find the `case "$DEPLOY_ENV" in` block (around line 111). Change the two `LOG_FILE` assignments and add a `mkdir -p` call after the case block closes:

```bash
  dev)
    # ... existing lines unchanged ...
    LOG_FILE="${HOME}/logs/dev-deploy.log"
    # ... rest unchanged ...
  prod)
    # ... existing lines unchanged ...
    LOG_FILE="${HOME}/logs/prod-deploy.log"
    # ... rest unchanged ...
```

Then after the `esac` (around line 156), add:

```bash
# Ensure log directory exists before any tee-a writes
mkdir -p "$(dirname "$LOG_FILE")"
```

- [ ] **Step 2: Verify the change looks right**

```bash
grep -n "LOG_FILE\|mkdir -p" scripts/deploy/deploy.sh | head -10
```

Expected: lines 117 and 137 show `~/logs/dev-deploy.log` and `~/logs/prod-deploy.log`; a new `mkdir -p` line appears just after `esac`.

- [ ] **Step 3: Commit**

```bash
git add scripts/deploy/deploy.sh
git commit -m "ops: write deploy logs to ~/logs/ for container mount access (#377)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Add volume mount to docker-compose.yml

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Add read-only logs volume to backend service**

In `docker-compose.yml`, find the backend `volumes:` block (around line 80). Add the logs mount after the existing volume entries:

```yaml
    volumes:
      - uploads_data:/app/uploads
      - .:/repo
      - /var/run/docker.sock:/var/run/docker.sock
      - ${HOME}/logs:/app/logs:ro   # deploy logs readable by history endpoint
```

- [ ] **Step 2: Verify no YAML syntax issues**

```bash
docker compose config --quiet 2>&1 | head -5
```

Expected: no output (silent success) or just a warning about unused variables. An error means YAML syntax is broken.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "ops: mount ~/logs into backend container for deploy history (#377)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Create deploy log parser utility (TDD)

**Files:**
- Create: `backend/utils/deployLogParser.js`
- Create: `backend/tests/utils/deployLogParser.test.js`

This is a pure function — no I/O, no dependencies. Test first.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/utils/deployLogParser.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { parseDeployRuns } from '../../utils/deployLogParser.js';

// Builds a minimal complete deploy run block matching the real log format
const makeRun = (n, status = 'ok') => {
  const pad = String(n).padStart(2, '0');
  const endBanner = status === 'ok'
    ? `║  ✅  DEPLOY COMPLETE — dev — 2026-01-${pad} 00:0${n}:00  ║`
    : `║  ❌  DEPLOY FAILED — dev — 2026-01-${pad} 00:0${n}:00  ║`;
  return [
    `║  🚀 Dev Deploy — 2026-01-${pad} 00:00:00  ║`,
    `[deploy:preflight] step=1 status=ok`,
    `[deploy:git] step=2 status=ok sha=abc123${n}`,
    endBanner,
  ].join('\n');
};

describe('parseDeployRuns', () => {
  it('returns empty array for empty log', () => {
    expect(parseDeployRuns('')).toEqual([]);
  });

  it('returns empty array when log has no deploy banners', () => {
    expect(parseDeployRuns('some random log output\nno banners here')).toEqual([]);
  });

  it('parses a single complete ok run', () => {
    const runs = parseDeployRuns(makeRun(1));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('ok');
    expect(runs[0].started_at).toBe('2026-01-01 00:00:00');
    expect(runs[0].ended_at).toBe('2026-01-01 00:01:00');
    expect(runs[0].raw).toContain('Dev Deploy');
  });

  it('parses a failed run with status "failed"', () => {
    const runs = parseDeployRuns(makeRun(1, 'failed'));
    expect(runs[0].status).toBe('failed');
    expect(runs[0].ended_at).toBe('2026-01-01 00:01:00');
  });

  it('returns the last 2 runs newest-first from a log with 3 runs', () => {
    const log = [makeRun(1), makeRun(2), makeRun(3)].join('\n');
    const runs = parseDeployRuns(log);
    expect(runs).toHaveLength(2);
    expect(runs[0].started_at).toBe('2026-01-03 00:00:00');
    expect(runs[1].started_at).toBe('2026-01-02 00:00:00');
  });

  it('discards a partial run (start banner, no end banner)', () => {
    const complete = makeRun(1);
    const partial = `║  🚀 Dev Deploy — 2026-01-02 00:00:00  ║\n[deploy:preflight] step=1 status=ok`;
    const runs = parseDeployRuns([complete, partial].join('\n'));
    expect(runs).toHaveLength(1);
    expect(runs[0].started_at).toBe('2026-01-01 00:00:00');
  });

  it('strips ANSI escape codes from raw output', () => {
    const log = `║  🚀 Dev Deploy — 2026-01-01 00:00:00  ║\n\x1b[32mGreen text\x1b[0m\n║  ✅  DEPLOY COMPLETE — dev — 2026-01-01 00:01:00  ║`;
    const runs = parseDeployRuns(log);
    expect(runs[0].raw).not.toContain('\x1b');
    expect(runs[0].raw).toContain('Green text');
  });

  it('respects a custom limit', () => {
    const log = [makeRun(1), makeRun(2), makeRun(3)].join('\n');
    expect(parseDeployRuns(log, 1)).toHaveLength(1);
    expect(parseDeployRuns(log, 3)).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run tests — expect them to FAIL (module not found)**

```bash
docker compose exec backend npm test -- tests/utils/deployLogParser.test.js
```

Expected output: `FAIL` with `Cannot find module '../../utils/deployLogParser.js'`

- [ ] **Step 3: Create the parser utility**

Create `backend/utils/deployLogParser.js`:

```js
// eslint-disable-next-line no-control-regex
const ANSI_RE    = /\x1b\[[0-9;]*m/g;
const stripAnsi  = s => s.replace(ANSI_RE, '');

const START_RE    = /║\s+🚀\s+(?:Dev|Prod) Deploy\s+—\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;
const END_OK_RE   = /║\s+✅\s+DEPLOY COMPLETE\s+—\s+\w+\s+—\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;
const END_FAIL_RE = /║\s+❌\s+DEPLOY FAILED\s+—\s+\w+\s+—\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;

export function parseDeployRuns(logText, limit = 2) {
  const lines = logText.split('\n');
  const runs  = [];
  let current = null;

  for (const line of lines) {
    const startMatch = line.match(START_RE);
    if (startMatch) {
      current = { started_at: startMatch[1], lines: [] };
    }
    if (current) {
      current.lines.push(line);
      const okMatch   = line.match(END_OK_RE);
      const failMatch = line.match(END_FAIL_RE);
      if (okMatch || failMatch) {
        const m = okMatch || failMatch;
        runs.push({
          started_at: current.started_at,
          ended_at:   m[1],
          status:     okMatch ? 'ok' : 'failed',
          raw:        stripAnsi(current.lines.join('\n')),
        });
        current = null;
      }
    }
  }

  return runs.slice(-limit).reverse();
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
docker compose exec backend npm test -- tests/utils/deployLogParser.test.js
```

Expected: `✓ 7 tests passed`

- [ ] **Step 5: Commit**

```bash
git add backend/utils/deployLogParser.js backend/tests/utils/deployLogParser.test.js
git commit -m "feat: add deploy log parser utility with tests (#377)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 4: Update backend history endpoint

**Files:**
- Modify: `backend/routes/deploy.js`

Three changes: import the parser, update `DEPLOY_LOG`, and rewrite the `/history` handler body.

- [ ] **Step 1: Add import and update DEPLOY_LOG**

At the top of `backend/routes/deploy.js`, add the parser import after the existing imports:

```js
import { parseDeployRuns } from '../utils/deployLogParser.js';
```

Change the `DEPLOY_LOG` constant (currently around line 50):

```js
// Deploy log is written to ~/logs/ on the host and mounted read-only at /app/logs
const DEPLOY_LOG = `/app/logs/${DEPLOY_ENV}-deploy.log`;
```

Remove the old comment on that line that referenced `$HOME`.

- [ ] **Step 2: Rewrite the /history handler**

Replace the entire `router.get('/history', ...)` handler (lines 123–156) with:

```js
router.get('/history', deployReadLimit, authenticateDeploy, async (req, res) => {
  try {
    const gitOut = await spawnPromise(
      'git', ['log', '--format=%H|%h|%s|%ci', '-20', 'origin/main'],
      { cwd: REPO_DIR }
    ).catch(() => '');

    const commits = gitOut.trim().split('\n').filter(Boolean).map(line => {
      const [sha, short_sha, message, date] = line.split('|');
      return { sha, short_sha, message, date };
    });

    let deploy_runs = [];
    try {
      const raw = await fs.readFile(DEPLOY_LOG, 'utf8');
      deploy_runs = parseDeployRuns(raw);
    } catch { /* log file may not exist yet */ }

    res.json({ commits, deploy_runs });
  } catch {
    res.json({ commits: [], deploy_runs: [] });
  }
});
```

- [ ] **Step 3: Run the full deploy test suite to check nothing broke**

```bash
docker compose exec backend npm test -- tests/routes/deploy.test.js
```

Expected: all existing auth tests still pass.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/deploy.js
git commit -m "feat: update deploy history endpoint — parser, 20 commits, new shape (#377)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 5: Add CSS styles

**Files:**
- Modify: `resources/css/styles.css`

Add new rules after the existing `.deploy-output` block (around line 1076).

- [ ] **Step 1: Add commit browser and output controls styles**

Insert after the `[data-theme="dark"] .deploy-output { ... }` block:

```css
/* ── Deploy commit browser (#377) ──────────────────────────────────────────── */
.commit-browser {
    margin-top: 1rem;
}

.commit-browser h3 {
    font-size: 0.9rem;
    color: var(--color-text-muted);
    margin-bottom: 0.5rem;
}

.commit-list {
    list-style: none;
    padding: 0;
    margin: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    overflow: hidden;
}

.commit-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    font-size: 0.85rem;
    border-bottom: 1px solid var(--color-border);
}

.commit-row:last-child {
    border-bottom: none;
}

.commit-row:nth-child(even) {
    background: var(--color-bg-alt);
}

.commit-sha {
    font-family: monospace;
    color: var(--color-text-muted);
    min-width: 5rem;
    flex-shrink: 0;
}

.commit-message {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.commit-date {
    color: var(--color-text-muted);
    font-size: 0.8rem;
    white-space: nowrap;
    flex-shrink: 0;
}

.commit-current {
    font-size: 0.75rem;
    color: var(--color-success);
    font-weight: 500;
    flex-shrink: 0;
}

/* ── Deploy output controls (#377) ──────────────────────────────────────────── */
.deploy-output-controls {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.75rem;
    margin-bottom: 0.25rem;
    font-size: 0.85rem;
}

.deploy-output-controls label {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    cursor: pointer;
    user-select: none;
}

/* ── Deploy history runs (#377) ──────────────────────────────────────────────── */
.deploy-run-summary {
    font-size: 0.85rem;
    font-family: monospace;
    cursor: pointer;
    padding: 0.4rem 0;
}

details.deploy-run + details.deploy-run {
    margin-top: 0.5rem;
}
```

- [ ] **Step 2: Commit**

```bash
git add resources/css/styles.css
git commit -m "style: add commit browser and deploy controls CSS (#377)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 6: Update deploy.html

**Files:**
- Modify: `admin/deploy.html`

Three changes: remove rollback picker + button, add commit browser, add output controls bar.

- [ ] **Step 1: Replace the action buttons + rollback picker section**

Find and replace the `<div class="form-actions" ...>` block and the `<div id="rollback-picker" ...>` block (lines 43–55) with:

```html
                <div class="form-actions" style="margin-top:1rem">
                    <button type="button" id="fetch-btn" class="btn-secondary" disabled>Fetch</button>
                    <button type="button" id="deploy-btn" class="btn-primary" disabled>Deploy latest</button>
                </div>
                <div id="commit-browser" class="commit-browser">
                    <h3>Recent commits</h3>
                    <ul id="commit-list" class="commit-list">
                        <li class="commit-row"><span class="hint">Loading…</span></li>
                    </ul>
                </div>
```

- [ ] **Step 2: Add output controls bar above the deploy-output pre**

Find `<pre id="deploy-output" ...>` (line 56) and insert the controls bar before it:

```html
                <div id="deploy-output-controls" class="deploy-output-controls hidden">
                    <label><input type="checkbox" id="autoscroll-toggle" checked> Auto-scroll</label>
                    <button type="button" id="copy-output-btn" class="btn-small" disabled>Copy output</button>
                </div>
                <pre id="deploy-output" class="deploy-output hidden"></pre>
```

- [ ] **Step 3: Verify the HTML is well-formed**

```bash
grep -n "rollback\|commit-browser\|autoscroll\|copy-output" admin/deploy.html
```

Expected: no `rollback` references remain; `commit-browser`, `autoscroll-toggle`, `copy-output-btn` are all present.

- [ ] **Step 4: Commit**

```bash
git add admin/deploy.html
git commit -m "feat: update deploy.html — commit browser, output controls (#377)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 7: Rewrite deploy.js frontend module

**Files:**
- Modify: `resources/js/admin/deploy.js`

Replace the entire file content. This combines all the JS changes: commit browser, rollback flow, auto-scroll toggle, copy button, updated `renderLog` for deploy history.

- [ ] **Step 1: Replace the file**

```js
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
        if (s.env)          deployEnv  = s.env;
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
        output.textContent   = '';
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
```

- [ ] **Step 2: Verify no rollback picker references remain**

```bash
grep -n "rollback-picker\|rollback-sha-select\|rollbackPicker\|rollbackSelect\|rollbackBtn\|rollbackConfirm\|rollbackCancel" resources/js/admin/deploy.js
```

Expected: no output.

- [ ] **Step 3: Run the full test suite**

```bash
docker compose exec backend npm test
```

Expected: all tests pass. (No frontend tests for this module — verified manually in Task 8.)

- [ ] **Step 4: Commit**

```bash
git add resources/js/admin/deploy.js
git commit -m "feat: commit browser, auto-scroll toggle, copy button, history panel (#377)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 8: Manual smoke test + rebuild container

The frontend changes require a container rebuild to pick up the new backend utility. Run a full smoke test against the dev server.

- [ ] **Step 1: Rebuild and restart the dev stack**

```bash
docker compose up -d --build
```

Expected: all three containers (`backend`, `postgres`, `nginx`) come up healthy. Check with:

```bash
docker compose ps
```

Expected: all services show `Up` and backend shows `(healthy)`.

- [ ] **Step 2: Verify deploy history loads**

Open `https://dev.andykeys.me:3001/admin/deploy.html` in a browser (from your Windows machine). Log in if prompted.

Check:
- The page loads without JS errors (check browser console)
- The status row shows the current commit SHA and up-to-date status
- The commit browser shows 20 rows, each with a short SHA, message, date, and "Roll back" button
- One row has `(current)` label with its Roll Back button disabled
- The deploy history section shows 1–2 `<details>` blocks with `✅` or `❌` summaries (not "Loading…" or "Could not load history")

- [ ] **Step 3: Verify output controls**

Click "Fetch". Confirm:
- The output controls bar appears above the `<pre>` panel
- "Auto-scroll" checkbox is checked and scroll follows output
- Unchecking "Auto-scroll" stops the panel from jumping
- "Copy output" button becomes enabled after the stream ends
- Clicking "Copy output" copies text to clipboard and briefly shows "Copied!"

- [ ] **Step 4: Verify rollback UI (without triggering a real rollback)**

Confirm:
- Each commit row has a "Roll back" button
- Clicking one shows a confirm dialog with the SHA and message
- Dismissing (Cancel) does nothing

- [ ] **Step 5: Verify history panel**

Click a `<details>` summary to expand it. Confirm:
- The raw deploy log appears in a dark-background scrollable `<pre>` block
- The summary shows duration correctly (e.g. `(1m 39s)`)

---

## Task 9: Open PR

- [ ] **Step 1: Apply `in progress` label to issue #377**

```bash
gh issue edit 377 --add-label "in progress" --repo AndyRKeys/MyPortfolioSite
```

- [ ] **Step 2: Push the feature branch**

```bash
git push origin feat/issue-377-deploy-management-suite
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --base dev --title "feat(#377): deployment management suite — commit browser, history, output controls" --body "$(cat <<'EOF'
## Summary

- Fixes broken deploy history panel (log file was not mounted into backend container)
- Replaces the hidden rollback dropdown with an always-visible inline commit browser (20 commits, direct roll-back-from-row UX)
- Adds auto-scroll toggle and Copy output button to the live deploy output panel
- Deploy history now shows last 2 complete/failed runs as collapsible `<details>` blocks with full raw output

## Changes

- `scripts/deploy/deploy.sh` — write logs to `~/logs/<env>-deploy.log`; `mkdir -p ~/logs` on startup
- `docker-compose.yml` — add `${HOME}/logs:/app/logs:ro` read-only volume mount under backend
- `backend/utils/deployLogParser.js` — new pure utility: `parseDeployRuns(logText, limit=2)`
- `backend/tests/utils/deployLogParser.test.js` — 7 unit tests for the parser
- `backend/routes/deploy.js` — use parser; update `DEPLOY_LOG`; increase git log to 20
- `admin/deploy.html` — remove rollback picker; add commit browser + output controls HTML
- `resources/js/admin/deploy.js` — full rewrite: commit browser, rollback flow, history panel, controls
- `resources/css/styles.css` — `.commit-browser`, `.commit-row`, `.deploy-output-controls` styles

## Test plan

### Automated

```bash
# Run inside backend container — all tests must pass
docker compose exec backend npm test
```
Expected: all tests green, including 7 new `deployLogParser` tests.

### Smoke tests

Open `https://dev.andykeys.me:3001/admin/deploy.html` (login required):

```
# 1. Deploy history loads (not empty, not "Could not load")
# Verify: 1-2 <details> blocks visible with ✅/❌ summaries and correct duration
```

```
# 2. Commit browser shows 20 rows with SHA, message, date, Roll Back button
# Verify: current commit row has (current) label and disabled Roll Back button
```

```
# 3. Click Fetch — output panel appears with controls bar
# Verify: Auto-scroll checkbox present and checked; Copy output button present
```

```
# 4. Uncheck Auto-scroll mid-stream
# Verify: panel stops jumping; output continues appending
```

```
# 5. After stream ends, click Copy output
# Verify: button briefly shows "Copied!"; clipboard contains deploy output
```

```
# 6. Expand a history <details> block
# Verify: raw log in dark-background scrollable <pre>
```

## Documentation

N/A — no changes to public API, environment variables, or operator workflows. The `DEPLOY_LOG` path change is internal to the container mount.

Closes #377

---
🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Switch issue label to `awaiting review`**

```bash
gh issue edit 377 --remove-label "in progress" --add-label "awaiting review" --repo AndyRKeys/MyPortfolioSite
```

- [ ] **Step 5: Note the squash commit message for the owner**

When merging, paste this as the squash commit message:

```
feat(#377): deployment management suite — commit browser, history, output controls

Fix broken deploy history (log not mounted into container), replace hidden
rollback dropdown with inline 20-commit browser (direct roll-back-from-row),
add auto-scroll toggle and Copy output button to live output panel, show last
2 complete/failed deploy runs as collapsible details blocks with full raw log.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```
