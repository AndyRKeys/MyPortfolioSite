import { describe, it, expect, vi } from 'vitest';
import { slugify, findUniqueSlug } from '../../utils/slugify.js';

// ── slugify ───────────────────────────────────────────────────────────────────

describe('slugify', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('strips non-alphanumeric characters', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
  });

  it('collapses multiple spaces/hyphens', () => {
    expect(slugify('hello   ---   world')).toBe('hello-world');
  });

  it('truncates to 100 characters', () => {
    const long = 'a'.repeat(150);
    expect(slugify(long)).toHaveLength(100);
  });

  it('returns fallback when result is empty', () => {
    expect(slugify('!!!', 'travel')).toBe('travel');
    expect(slugify('', 'post')).toBe('post');
  });
});

// ── findUniqueSlug ────────────────────────────────────────────────────────────

function makeDb(...taken) {
  // Mock db.query that returns a row when the slug is in the taken set.
  return {
    query: vi.fn(async (sql, [candidate, excludeId]) => {
      const match = taken.includes(candidate);
      return { rows: match ? [{ 1: 1 }] : [] };
    }),
  };
}

describe('findUniqueSlug', () => {
  it('returns baseSlug immediately when not taken', async () => {
    const db = makeDb(); // nothing taken
    expect(await findUniqueSlug(db, 'my-post')).toBe('my-post');
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('appends an incrementing suffix when base is taken', async () => {
    const db = makeDb('my-post', 'my-post-1');
    expect(await findUniqueSlug(db, 'my-post')).toBe('my-post-2');
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  it('passes excludeId to the query when provided', async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    await findUniqueSlug(db, 'my-post', { excludeId: 42 });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('id != $2');
    expect(params).toContain(42);
  });

  it('does not pass excludeId when not provided', async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    await findUniqueSlug(db, 'my-post');
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).not.toContain('id != $2');
    expect(params).toEqual(['my-post']);
  });

  it('throws after maxAttempts without finding a free slug', async () => {
    // All candidates are taken.
    const db = { query: vi.fn(async () => ({ rows: [{ 1: 1 }] })) };
    await expect(findUniqueSlug(db, 'taken', { maxAttempts: 5 })).rejects.toThrow(
      'Could not generate a unique slug'
    );
    expect(db.query).toHaveBeenCalledTimes(5);
  });

  it('does NOT retry on DB errors — propagates immediately', async () => {
    const db = {
      query: vi.fn().mockRejectedValue(new Error('connection refused')),
    };
    await expect(findUniqueSlug(db, 'my-post')).rejects.toThrow('connection refused');
    // Only one attempt — the old tryInsertPost bug retried 100 times on any error.
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
