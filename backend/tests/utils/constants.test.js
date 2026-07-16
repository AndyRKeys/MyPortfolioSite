import { describe, it, expect } from 'vitest';
import {
  MEDIA_MAX_FILE_SIZE,
  MEDIA_JOB_NAME,
  SHARP_FULL_SIZE,
  SHARP_THUMB_SIZE,
  SHARP_QUALITY,
  GITHUB_REPO,
  CV_PUBLIC_FILENAME,
  DEPLOY_READ_RATE_WINDOW_MS,  DEPLOY_READ_RATE_LIMIT,
  DEPLOY_WRITE_RATE_WINDOW_MS, DEPLOY_WRITE_RATE_LIMIT,
  DEBUG_RATE_WINDOW_MS,        DEBUG_RATE_LIMIT,
  STATS_RATE_WINDOW_MS,        STATS_RATE_LIMIT,
  SEARCH_RATE_WINDOW_MS,       SEARCH_RATE_LIMIT,
  AUDIT_RATE_WINDOW_MS,        AUDIT_RATE_LIMIT,
} from '../../utils/constants.js';

describe('media processing constants', () => {
  it('MEDIA_MAX_FILE_SIZE is 1 GB', () => {
    expect(MEDIA_MAX_FILE_SIZE).toBe(1 * 1024 * 1024 * 1024);
  });

  it('MEDIA_JOB_NAME is the expected string', () => {
    expect(MEDIA_JOB_NAME).toBe('process-media');
  });

  it('SHARP_FULL_SIZE is 2400', () => {
    expect(SHARP_FULL_SIZE).toBe(2400);
  });

  it('SHARP_THUMB_SIZE is 400', () => {
    expect(SHARP_THUMB_SIZE).toBe(400);
  });

  it('SHARP_QUALITY is 85', () => {
    expect(SHARP_QUALITY).toBe(85);
  });
});

describe('GitHub repo constant (#522 M13)', () => {
  it('GITHUB_REPO defaults to AndyRKeys/MyPortfolioSite when env is unset', () => {
    // Test env does not set GITHUB_REPO — the shared default must apply.
    expect(GITHUB_REPO).toBe('AndyRKeys/MyPortfolioSite');
  });
});

describe('CV public filename (#522 L10)', () => {
  it('CV_PUBLIC_FILENAME is the canonical download name', () => {
    expect(CV_PUBLIC_FILENAME).toBe('Andy_Keys_CV.pdf');
  });
});

describe('route rate-limit constants (#522 L6)', () => {
  it('deploy read/write limits match previous inline values', () => {
    expect(DEPLOY_READ_RATE_WINDOW_MS).toBe(60 * 1000);
    expect(DEPLOY_READ_RATE_LIMIT).toBe(60);
    expect(DEPLOY_WRITE_RATE_WINDOW_MS).toBe(60 * 1000);
    expect(DEPLOY_WRITE_RATE_LIMIT).toBe(10);
  });

  it('debug/stats/search/audit limits match previous inline values', () => {
    expect(DEBUG_RATE_WINDOW_MS).toBe(60 * 1000);
    expect(DEBUG_RATE_LIMIT).toBe(50);
    expect(STATS_RATE_WINDOW_MS).toBe(60 * 1000);
    expect(STATS_RATE_LIMIT).toBe(60);
    expect(SEARCH_RATE_WINDOW_MS).toBe(60 * 1000);
    expect(SEARCH_RATE_LIMIT).toBe(60);
    expect(AUDIT_RATE_WINDOW_MS).toBe(60 * 1000);
    expect(AUDIT_RATE_LIMIT).toBe(120);
  });
});
