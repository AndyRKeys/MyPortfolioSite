/**
 * GitHub activity proxy route tests (#105)
 * GET /github/activity
 *
 * The GitHub API fetch is mocked so no real HTTP calls are made.
 * Tests verify: shape of response, 10-minute cache behaviour, and
 * upstream failure handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';

// ── Mock global fetch ────────────────────────────────────────────────────────

// We mock the global fetch used by the github route.
// Each ghFetch call goes to a different GitHub API path — we match on path.

function makeCommit(i) {
  return {
    sha: `abc123${i}deadbeef0123456789`,
    commit: {
      message: `feat: commit number ${i}\n\nBody paragraph.`,
      author: { date: '2026-06-01T12:00:00Z', name: 'Andy Keys' },
    },
  };
}

function makePR(number, state, mergedAt = null) {
  return { number, title: `PR ${number}`, state, merged_at: mergedAt, pull_request: {} };
}

function makeIssue(number, state) {
  // Issues without a pull_request key are real issues
  return { number, title: `Issue ${number}`, state };
}

const FAKE_COMMITS  = [makeCommit(1), makeCommit(2), makeCommit(3)];
const FAKE_OPEN_PRS = [makePR(10, 'open')];
const FAKE_CLOSED_PRS = [
  makePR(9, 'closed', '2026-05-01T00:00:00Z'),
  makePR(8, 'closed', null), // closed but not merged
];
const FAKE_OPEN_ISSUES   = [makeIssue(5, 'open'), makeIssue(6, 'open')];
// One of the closed "issues" is actually a PR (has pull_request key) — should be filtered
const FAKE_CLOSED_ISSUES = [makeIssue(3, 'closed'), { ...makePR(7, 'closed'), pull_request: {} }];

function mockFetch(overrides = {}) {
  return vi.fn(async (url) => {
    const path = new URL(url).pathname + new URL(url).search;
    let data;
    if (path.includes('/commits'))                        data = FAKE_COMMITS;
    else if (path.includes('/pulls') && path.includes('state=open'))   data = FAKE_OPEN_PRS;
    else if (path.includes('/pulls') && path.includes('state=closed')) data = FAKE_CLOSED_PRS;
    else if (path.includes('/issues') && path.includes('state=open'))  data = FAKE_OPEN_ISSUES;
    else if (path.includes('/issues') && path.includes('state=closed')) data = FAKE_CLOSED_ISSUES;
    else data = [];

    if (overrides[path]) return overrides[path];

    return {
      ok:      true,
      headers: { get: () => '59' },
      json:    async () => data,
    };
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /github/activity', () => {
  let app;

  beforeEach(async () => {
    // Reset module + cache before each test so tests don't bleed into each other
    vi.resetModules();
    global.fetch = mockFetch();
    const { resetCache } = await import('../../routes/github.js');
    resetCache();
    // Re-import app so it picks up the reset module state
    const { createApp: freshApp } = await import('../../app.js');
    app = freshApp();
  });

  it('returns 200 with the expected top-level shape', async () => {
    const res = await request(app).get('/github/activity');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      commits:          expect.any(Array),
      pullRequests:     expect.any(Array),
      issues:           expect.objectContaining({ open: expect.any(Number), closed: expect.any(Number), total: expect.any(Number) }),
      pullRequestStats: expect.objectContaining({ open: expect.any(Number), merged: expect.any(Number), total: expect.any(Number) }),
      cachedAt:         expect.any(String),
    });
  });

  it('shapes commits correctly — 7-char SHA, first-line message, date, author', async () => {
    const res = await request(app).get('/github/activity');
    expect(res.status).toBe(200);
    const commit = res.body.commits[0];
    expect(commit.sha).toHaveLength(7);
    expect(commit.message).toBe('feat: commit number 1'); // first line only
    expect(commit.date).toBe('2026-06-01T12:00:00Z');
    expect(commit.author).toBe('Andy Keys');
  });

  it('filters out PRs from the issues count', async () => {
    const res = await request(app).get('/github/activity');
    // FAKE_CLOSED_ISSUES has 2 items; 1 has pull_request key so is filtered → 1 real closed issue
    expect(res.body.issues.closed).toBe(1);
    expect(res.body.issues.open).toBe(2); // FAKE_OPEN_ISSUES has 2 real issues
  });

  it('counts merged PRs correctly', async () => {
    const res = await request(app).get('/github/activity');
    // FAKE_CLOSED_PRS: PR 9 has merged_at, PR 8 does not
    expect(res.body.pullRequestStats.merged).toBe(1);
    expect(res.body.pullRequestStats.open).toBe(1);
    expect(res.body.pullRequestStats.total).toBe(3); // 1 open + 2 closed
  });

  it('requests GitHub API paths built from the shared GITHUB_REPO constant (#522 M13)', async () => {
    const { GITHUB_REPO } = await import('../../utils/constants.js');
    const res = await request(app).get('/github/activity');
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalled();
    for (const [url] of global.fetch.mock.calls) {
      expect(String(url)).toContain(`/repos/${GITHUB_REPO}/`);
    }
  });

  it('caches the response — second request does not call fetch again', async () => {
    await request(app).get('/github/activity');
    const fetchCallsAfterFirst = global.fetch.mock.calls.length;
    await request(app).get('/github/activity');
    // fetch call count must not increase on the cached hit
    expect(global.fetch.mock.calls.length).toBe(fetchCallsAfterFirst);
  });

  it('returns 502 when GitHub API returns non-200', async () => {
    global.fetch = vi.fn(async () => ({
      ok:      false,
      status:  403,
      headers: { get: () => '0' },
    }));
    const res = await request(app).get('/github/activity');
    expect(res.status).toBe(502);
  });
});
