# Deploy Management Suite — Design Spec

_Issue: #377 | Date: 2026-06-28 | Approach: A (minimal delta, single-card layout)_

---

## Overview

Expand the deploy dashboard (`admin/deploy.html`) into a genuinely useful deployment management suite. The current page has a broken history panel (log file not mounted into the container), a hidden rollback dropdown with poor UX, and a live output panel with no usability controls. This spec covers four discrete improvements shipped as a single PR.

---

## Section 1: Infrastructure — log file volume mount

**Problem:** Deploy logs are written by `deploy.sh` to `~/dev-deploy.log` / `~/prod-deploy.log` on the host. The backend container has no volume mount for these paths, so `DEPLOY_LOG` resolves to `/root/<env>-deploy.log` inside the container — a path that never exists. The history panel silently loads empty every time.

**Fix:**

1. Update `deploy-lib.sh` to write logs to `~/logs/<env>-deploy.log` instead of `~/<env>-deploy.log`. Add `mkdir -p ~/logs` near the start of the deploy script.
2. Add a read-only volume mount to `docker-compose.yml` under the backend service:
   ```yaml
   - ${HOME}/logs:/app/logs:ro
   ```
3. Update `DEPLOY_LOG` in `backend/routes/deploy.js`:
   ```js
   const DEPLOY_LOG = `/app/logs/${DEPLOY_ENV}-deploy.log`;
   ```
4. No change to prod deploy script path logic — `HOME` on the host is `/home/modnar3`; the new `~/logs/` directory applies to both envs.

---

## Section 2: Backend — `GET /api/deploy/history` changes

**Commits:** Increase `git log` limit from `-10` to `-20`. Response shape for commits is unchanged: `{ sha, short_sha, message, date }`.

**Deploy runs — new parser:**

Replace the flat "last 20 lines" slice with a parser that reads the log file from the end and extracts the last 2 completed or failed runs.

- **Start marker:** line containing `║  🚀`
- **End marker:** line containing `DEPLOY COMPLETE` (status `ok`) or `DEPLOY FAILED` (status `failed`)
- **Partial runs** (start marker found, no end marker) are skipped — an in-progress deploy should not appear in history
- Parse `started_at` from the start banner text: `🚀 Dev Deploy — 2026-06-28 17:43:39`
- Parse `ended_at` from the end banner text: `DEPLOY COMPLETE — dev — 2026-06-28 17:45:18`
- Return full raw text of each run as a single string (ANSI codes stripped, same stripping logic already in the file)

**Response shape:**

```json
{
  "commits": [
    { "sha": "abc1234...", "short_sha": "abc1234", "message": "fix: ...", "date": "2026-06-28 ..." }
  ],
  "deploy_runs": [
    {
      "started_at": "2026-06-28 17:43:39",
      "ended_at":   "2026-06-28 17:45:18",
      "status":     "ok",
      "raw":        "...full stripped log text..."
    },
    {
      "started_at": "2026-06-28 17:35:09",
      "ended_at":   "2026-06-28 17:36:49",
      "status":     "failed",
      "raw":        "...full stripped log text..."
    }
  ]
}
```

**Status values:** `"ok"` | `"failed"` | `"unknown"` (end banner present but unrecognised pattern).

**No new routes.** All changes are within the existing `GET /history` handler.

---

## Section 3: Frontend — commit browser

**Remove:**
- `<div id="rollback-picker">` (dropdown + confirm/cancel buttons)
- `#rollback-btn` ("Rollback…" button)
- `#rollback-sha-select`, `#rollback-confirm-btn`, `#rollback-cancel-btn` elements and all JS references

**Add:** An always-visible commit list below the action buttons.

**HTML structure:**
```html
<div id="commit-browser">
  <h3>Recent commits</h3>
  <ul id="commit-list"></ul>
</div>
```

**Each row rendered by JS:**
```
[abc1234]  fix: correct nginx template path    2026-06-28  [Roll back]
```
- Short SHA in monospace
- Commit message (escaped)
- Date (formatted to `YYYY-MM-DD`)
- `btn-small btn-danger` "Roll back" button, right-aligned
- If `commit.sha` starts with `status.head.full_sha.slice(0,7)`: add a `(current)` label and disable the Roll Back button for that row

**Rollback flow:**
- Click "Roll back" → `confirm('Roll back to abc1234 — fix: correct nginx template path?\n\nThe backend will restart briefly.')` 
- On confirm → call existing `runStream('POST', '/deploy/rollback', { sha })` 
- On complete → `loadStatus()` + `loadHistory()`

---

## Section 4: Frontend — live output panel enhancements

**Controls bar** (rendered above `#deploy-output` once a stream starts, or always visible):
- **Auto-scroll toggle:** `<label><input type="checkbox" id="autoscroll-toggle" checked> Auto-scroll</label>`
  - When checked: `output.scrollTop = output.scrollHeight` on each new line (existing behaviour)
  - When unchecked: no scroll on new lines
  - Reset to checked automatically when a new stream starts
- **Copy button:** `<button class="btn-small" id="copy-output-btn">Copy output</button>`
  - Copies `output.textContent` to clipboard via `navigator.clipboard.writeText()`
  - Disabled when panel is empty; enabled once content exists
  - Brief label change to "Copied!" for 1.5s on success

**Panel visibility:** Once a stream has run in the session, the panel remains visible (not re-hidden between actions).

---

## Section 5: Frontend — deploy history panel

**Replace** `<div id="deploy-log-list">` content with two `<details>` blocks, newest run first.

**Summary line format:**
- Success: `✅ 2026-06-28 17:43:39 → 17:45:18 (1m 39s)`
- Failed:  `❌ 2026-06-28 16:22:46 → 16:22:47 (1s)`
- Unknown: `⚠️ 2026-06-28 ... (status unknown)`

**Expanded content:** `<pre>` block with the full `raw` string, styled with `.deploy-output` class (dark background, monospace, max-height 320px, scrollable).

**Default state:** Both `<details>` blocks collapsed.

**Empty state:** `<p class="hint">No deploy history yet.</p>` if `deploy_runs` is empty.

---

## Files changed

| File | Change |
|------|--------|
| `scripts/deploy/deploy-lib.sh` | Change log path to `~/logs/<env>-deploy.log`; add `mkdir -p ~/logs` |
| `docker-compose.yml` | Add `${HOME}/logs:/app/logs:ro` volume mount under backend service |
| `backend/routes/deploy.js` | Update `DEPLOY_LOG` constant; replace flat log-line slice with run parser; increase git log to `-20` |
| `admin/deploy.html` | Remove rollback picker; add commit browser `<div>`; add output controls bar |
| `resources/js/admin/deploy.js` | Remove rollback picker logic; add commit browser render + rollback flow; add auto-scroll toggle + copy button |
| `resources/css/styles.css` | Add `.commit-browser`, `.commit-row` styles; add output controls bar styles |

---

## Out of scope

- No new backend routes
- No changes to `POST /deploy/`, `POST /deploy/fetch`, `POST /deploy/rollback` handlers
- No tab/panel layout restructuring
- No author column in commit list
- No per-step structured summary in history (full raw only)
