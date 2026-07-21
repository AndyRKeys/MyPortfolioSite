/**
 * GitHub activity proxy route (#105)
 *
 * Fetches commit, PR, and issue data from the GitHub public API for the
 * AndyRKeys/MyPortfolioSite repository and returns a shaped summary.
 * Responses are cached in memory for 10 minutes to avoid the 60 req/hr
 * unauthenticated rate limit.
 */
import { Router } from 'express';
import { logger } from '../utils/logger.js';
import { GITHUB_REPO } from '../utils/constants.js';

const router = Router();

const GITHUB_API    = 'https://api.github.com';
const CACHE_TTL_MS  = 10 * 60 * 1000; // 10 minutes
const USER_AGENT    = 'MyPortfolioSite-backend/1.0 (github-activity-proxy)';

// ── In-memory cache ──────────────────────────────────────────────────────────

/** @type {{ data: object, fetchedAt: number } | null} */
let cache = null;

function isCacheValid() {
  return cache !== null && (Date.now() - cache.fetchedAt) < CACHE_TTL_MS;
}

// ── GitHub API helpers ───────────────────────────────────────────────────────

async function ghFetch(path) {
  const url = `${GITHUB_API}${path}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept':     'application/vnd.github.v3+json',
    },
  });
  if (!res.ok) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    logger.warn(
      { status: res.status, path, rateLimitRemaining: remaining },
      '[github] GitHub API request failed',
    );
    throw Object.assign(new Error(`GitHub API ${res.status} for ${path}`), { status: 502 });
  }
  return res.json();
}

async function fetchActivity() {
  logger.info('[github] Fetching fresh data from GitHub API');

  // Fetch in parallel: commits (last 30), open PRs, closed PRs, open issues, closed issues
  const [commitsRaw, openPRs, closedPRs, openIssues, closedIssues] = await Promise.all([
    ghFetch(`/repos/${GITHUB_REPO}/commits?per_page=30`),
    ghFetch(`/repos/${GITHUB_REPO}/pulls?state=open&per_page=100`),
    ghFetch(`/repos/${GITHUB_REPO}/pulls?state=closed&per_page=100`),
    ghFetch(`/repos/${GITHUB_REPO}/issues?state=open&per_page=100`),
    ghFetch(`/repos/${GITHUB_REPO}/issues?state=closed&per_page=100`),
  ]);

  // Shape commits — pull only the fields the frontend needs
  const commits = commitsRaw.map(c => ({
    sha:     c.sha.slice(0, 7),
    message: c.commit.message.split('\n')[0], // first line only
    date:    c.commit.author.date,
    author:  c.commit.author.name,
  }));

  // GitHub issues endpoint includes PRs; filter them out for issue counts
  const openIssuesFiltered   = openIssues.filter(i => !i.pull_request);
  const closedIssuesFiltered = closedIssues.filter(i => !i.pull_request);

  // Shape PRs — merge open + closed, sort by number descending, cap at 20
  const pullRequests = [
    ...openPRs.map(pr => ({
      number:   pr.number,
      title:    pr.title,
      state:    pr.state,
      mergedAt: pr.merged_at,
    })),
    ...closedPRs.map(pr => ({
      number:   pr.number,
      title:    pr.title,
      state:    pr.state,
      mergedAt: pr.merged_at,
    })),
  ].sort((a, b) => b.number - a.number).slice(0, 20);

  const merged = closedPRs.filter(pr => pr.merged_at !== null).length;

  return {
    commits,
    pullRequests,
    issues: {
      open:   openIssuesFiltered.length,
      closed: closedIssuesFiltered.length,
      total:  openIssuesFiltered.length + closedIssuesFiltered.length,
    },
    pullRequestStats: {
      open:   openPRs.length,
      merged,
      total:  openPRs.length + closedPRs.length,
    },
    cachedAt: new Date().toISOString(),
  };
}

// ── Route ────────────────────────────────────────────────────────────────────

// Public: return shaped GitHub activity (commits, PRs, issues)
router.get('/activity', async (_req, res, next) => {
  try {
    if (isCacheValid()) {
      logger.info('[github] Serving cached GitHub activity');
      return res.json(cache.data);
    }

    const data = await fetchActivity();
    cache = { data, fetchedAt: Date.now() };
    logger.info(
      { commits: data.commits.length, cachedAt: data.cachedAt },
      '[github] GitHub activity fetched and cached',
    );
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ── Exports (test helpers) ───────────────────────────────────────────────────

export { isCacheValid, fetchActivity };
export function resetCache() { cache = null; }

export default router;
