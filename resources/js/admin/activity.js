/**
 * Admin activity log (#155)
 *
 * Fetches recent audit log entries from GET /audit and renders them
 * in a filterable, auto-refreshable table in the admin activity page.
 */
import { authFetch } from './auth.js';
import { escapeHtml } from '../utils/html.js';

// ── Colour coding by action prefix ───────────────────────────────────────────

const ACTION_CLASS = {
  'auth.login':          'activity-success',
  'auth.login_failed':   'activity-danger',
  'post.create':         'activity-success',
  'post.publish':        'activity-success',
  'post.update':         'activity-info',
  'post.unpublish':      'activity-warn',
  'post.delete':         'activity-danger',
  'travel.create':       'activity-success',
  'travel.publish':      'activity-success',
  'travel.update':       'activity-info',
  'travel.unpublish':    'activity-warn',
  'travel.delete':       'activity-danger',
  'cv.upload':           'activity-info',
  'cv.delete':           'activity-danger',
  'deploy.start':        'activity-success',
  'deploy.rollback':     'activity-warn',
  'deploy.fetch':        'activity-info',
};

function actionClass(action) {
  return ACTION_CLASS[action] || 'activity-info';
}

// ── Relative time formatter ───────────────────────────────────────────────────

function relativeTime(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60)          return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)          return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)          return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function absoluteTime(dateStr) {
  return new Date(dateStr).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ── Detail summary ────────────────────────────────────────────────────────────

function detailSummary(detail) {
  if (!detail) return '';
  if (detail.title) return escapeHtml(detail.title);
  if (detail.sha)   return escapeHtml(detail.sha.slice(0, 8));
  if (detail.env)   return escapeHtml(detail.env);
  return '';
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderRows(rows) {
  if (!rows.length) {
    return '<tr><td colspan="5" class="activity-empty">No activity recorded yet.</td></tr>';
  }
  return rows.map(r => {
    const cls     = actionClass(r.action);
    const rel     = relativeTime(r.created_at);
    const abs     = absoluteTime(r.created_at);
    const detail  = detailSummary(r.detail);
    const entity  = r.entity_type ? escapeHtml(r.entity_type) : '';
    return `<tr class="${escapeHtml(cls)}">
      <td class="activity-ts" title="${escapeHtml(abs)}">${escapeHtml(rel)}</td>
      <td class="activity-action"><code>${escapeHtml(r.action)}</code></td>
      <td class="activity-entity">${entity}</td>
      <td class="activity-detail">${detail}</td>
      <td class="activity-user">${escapeHtml(r.username || '—')}</td>
    </tr>`;
  }).join('');
}

// ── Load ──────────────────────────────────────────────────────────────────────

let _currentType   = 'all';
let _refreshTimer  = null;

async function loadActivity(type = _currentType) {
  _currentType = type;
  const tbody = document.getElementById('activity-tbody');
  if (!tbody) return;

  try {
    const qs  = new URLSearchParams({ limit: '50' });
    if (type !== 'all') qs.set('type', type);
    const res = await authFetch(`/audit?${qs}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    tbody.innerHTML = renderRows(rows);
  } catch {
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="activity-empty" style="color:var(--color-error)">Failed to load activity log.</td></tr>';
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initActivity() {
  const container = document.getElementById('activity-log');
  if (!container) return;

  // Filter buttons
  container.querySelectorAll('[data-activity-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('[data-activity-filter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadActivity(btn.dataset.activityFilter);
    });
  });

  // Refresh button
  const refreshBtn = document.getElementById('activity-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadActivity());
  }

  // Auto-refresh every 60 s
  _refreshTimer = setInterval(() => loadActivity(), 60_000);

  loadActivity();
}
