/**
 * GitHub project history page (#105)
 *
 * Fetches activity data from the backend proxy (/api/github/activity)
 * and renders: stat cards, a commit-activity bar chart (pure CSS/JS,
 * no library), a commit timeline, and a PR list.
 */
import { API_BASE } from './config.js';
import { escapeHtml } from './utils/html.js';
import { formatVisitDate } from './utils/date.js';

// ── Data fetch ───────────────────────────────────────────────────────────────

async function loadActivity() {
    var res = await fetch(API_BASE + '/github/activity');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
}

// ── Stats cards ──────────────────────────────────────────────────────────────

function renderStats(data) {
    var loading = document.getElementById('gh-stats-loading');
    var grid    = document.getElementById('gh-stats-grid');
    if (!loading || !grid) return;

    document.getElementById('gh-stat-commits').textContent    = data.commits.length;
    document.getElementById('gh-stat-prs-merged').textContent = data.pullRequestStats.merged;
    document.getElementById('gh-stat-prs-open').textContent   = data.pullRequestStats.open;
    document.getElementById('gh-stat-issues-open').textContent   = data.issues.open;
    document.getElementById('gh-stat-issues-closed').textContent = data.issues.closed;

    loading.hidden = true;
    grid.hidden    = false;
}

// ── Activity bar chart ───────────────────────────────────────────────────────

/**
 * Builds a pure CSS bar chart showing commit counts per day for the last
 * 30 days. Each bar's height is set via a CSS custom property so the
 * bars scale proportionally to the maximum in the window.
 */
function renderActivityChart(commits) {
    var chartEl = document.getElementById('gh-activity-chart');
    var loadEl  = document.getElementById('gh-chart-loading');
    if (!chartEl) return;

    // Build a map: YYYY-MM-DD → count
    var counts = {};
    commits.forEach(function (c) {
        var day = c.date.slice(0, 10);
        counts[day] = (counts[day] || 0) + 1;
    });

    // Generate last 30 days (oldest first)
    var days = [];
    for (var i = 29; i >= 0; i--) {
        var d = new Date();
        d.setDate(d.getDate() - i);
        var key = d.toISOString().slice(0, 10);
        days.push({ key: key, count: counts[key] || 0 });
    }

    var maxCount = Math.max(1, Math.max.apply(null, days.map(function (d) { return d.count; })));

    if (loadEl) loadEl.hidden = true;

    var bars = days.map(function (d) {
        var pct = (d.count / maxCount) * 100;
        var label = d.count + ' commit' + (d.count === 1 ? '' : 's') + ' on ' + escapeHtml(d.key);
        return '<div class="gh-chart-bar-wrap" title="' + label + '">' +
            '<div class="gh-chart-bar" style="height:' + pct.toFixed(1) + '%"' +
                (d.count > 0 ? ' data-count="' + d.count + '"' : '') + '>' +
            '</div>' +
            '<span class="gh-chart-day-label">' + escapeHtml(d.key.slice(5)) + '</span>' +
        '</div>';
    }).join('');

    chartEl.innerHTML = '<div class="gh-chart-bars">' + bars + '</div>';
}

// ── Commit timeline ───────────────────────────────────────────────────────────

function renderCommits(commits) {
    var loading  = document.getElementById('gh-commits-loading');
    var timeline = document.getElementById('gh-commit-timeline');
    if (!loading || !timeline) return;

    if (!commits.length) {
        loading.textContent = 'No commits found.';
        return;
    }

    var items = commits.map(function (c) {
        var dateStr = formatVisitDate(c.date.slice(0, 10)) || c.date.slice(0, 10);
        return '<div class="timeline-item">' +
            '<div class="timeline-marker"></div>' +
            '<div class="timeline-content">' +
                '<span class="timeline-date">' + escapeHtml(dateStr) + '</span>' +
                '<h3 class="gh-commit-message">' + escapeHtml(c.message) + '</h3>' +
                '<p class="gh-commit-meta">' +
                    '<code class="gh-commit-sha">' + escapeHtml(c.sha) + '</code>' +
                    ' &middot; ' + escapeHtml(c.author) +
                '</p>' +
            '</div>' +
        '</div>';
    }).join('');

    loading.hidden   = true;
    timeline.innerHTML = items;
    timeline.hidden  = false;
}

// ── PR list ──────────────────────────────────────────────────────────────────

function renderPRs(prs) {
    var loading = document.getElementById('gh-prs-loading');
    var list    = document.getElementById('gh-pr-list');
    if (!loading || !list) return;

    if (!prs.length) {
        loading.textContent = 'No pull requests found.';
        return;
    }

    var items = prs.map(function (pr) {
        var stateClass = pr.state === 'open' ? 'gh-pr-state--open' : (pr.mergedAt ? 'gh-pr-state--merged' : 'gh-pr-state--closed');
        var stateLabel = pr.state === 'open' ? 'open' : (pr.mergedAt ? 'merged' : 'closed');
        var dateStr    = pr.mergedAt ? ('Merged ' + (formatVisitDate(pr.mergedAt.slice(0, 10)) || pr.mergedAt.slice(0, 10))) : '';
        return '<li class="gh-pr-item">' +
            '<span class="gh-pr-state ' + stateClass + '">' + escapeHtml(stateLabel) + '</span>' +
            '<span class="gh-pr-number">#' + escapeHtml(String(pr.number)) + '</span>' +
            '<span class="gh-pr-title">' + escapeHtml(pr.title) + '</span>' +
            (dateStr ? '<span class="gh-pr-date">' + escapeHtml(dateStr) + '</span>' : '') +
        '</li>';
    }).join('');

    loading.hidden = true;
    list.innerHTML = items;
    list.hidden    = false;
}

// ── Error state ───────────────────────────────────────────────────────────────

function renderError(message) {
    ['gh-stats-loading', 'gh-chart-loading', 'gh-commits-loading', 'gh-prs-loading'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) {
            el.textContent = message;
            el.style.color = 'var(--color-error, #e53e3e)';
            el.hidden = false;
        }
    });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

loadActivity()
    .then(function (data) {
        renderStats(data);
        renderActivityChart(data.commits);
        renderCommits(data.commits);
        renderPRs(data.pullRequests);
    })
    .catch(function (err) {
        console.error('[github] loadActivity failed:', err && (err.message || String(err)));
        renderError('Could not load GitHub activity. Please try again later.');
    });
