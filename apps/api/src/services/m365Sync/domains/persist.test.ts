import { describe, expect, it, vi } from 'vitest';

// This file tests planEntityWrites/writeEntityChunks as pure logic. Neither
// `db` nor a real Postgres connection is exercised: `write` callbacks below
// never touch `db`, but writeEntityChunks still wraps every chunk in
// `withSystemDbAccessContext`, which — unmocked — opens a REAL
// `baseDb.transaction`. The `test-api` CI job (this file's runner) has no
// Postgres service, so this mock keeps the test a true unit test rather than
// an accidental integration test (same mock shape as users.test.ts et al.).
vi.mock('../../../db', () => ({
  db: {},
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

import { planEntityWrites, writeEntityChunks } from './persist';

const ctx = (existing: Array<[string, { coreHash: string; isStale: boolean }]>) => ({
  orgId: 'org-1', tenantId: 't', connectionId: 'c', generation: 1,
  existing: new Map(existing), now: new Date('2026-09-08T00:00:00.000Z'),
});
const build = (item: { id: string; hash: string }) => ({ graphId: item.id, coreHash: item.hash, row: item });

describe('planEntityWrites (spec §5.4)', () => {
  it('writes NOTHING when every fetched row hashes identically to its stored row', () => {
    const plan = planEntityWrites(ctx([['a', { coreHash: 'h1', isStale: false }]]),
      [{ id: 'a', hash: 'h1' }], true, build);
    expect(plan.rows).toEqual([]);
    expect(plan.unchanged).toBe(1);
    expect(plan.inserted).toBe(0);
    expect(plan.updated).toBe(0);
  });

  it('counts an unknown graph id as an insert and a differing hash as an update', () => {
    const plan = planEntityWrites(ctx([['a', { coreHash: 'h1', isStale: false }]]),
      [{ id: 'a', hash: 'h2' }, { id: 'b', hash: 'h9' }], true, build);
    expect(plan.inserted).toBe(1);
    expect(plan.updated).toBe(1);
    expect(plan.rows).toHaveLength(2);
  });

  it('REWRITES an unchanged row that is currently stale, so a returning object is un-tombstoned', () => {
    const plan = planEntityWrites(ctx([['a', { coreHash: 'h1', isStale: true }]]),
      [{ id: 'a', hash: 'h1' }], true, build);
    expect(plan.updated).toBe(1);
    expect(plan.rows).toHaveLength(1);
    expect(plan.unchanged).toBe(0);
  });

  it('marks vanished rows stale ONLY on a complete run', () => {
    const stored: Array<[string, { coreHash: string; isStale: boolean }]> = [
      ['a', { coreHash: 'h1', isStale: false }], ['gone', { coreHash: 'h2', isStale: false }],
    ];
    expect(planEntityWrites(ctx(stored), [{ id: 'a', hash: 'h1' }], true, build).staleIds).toEqual(['gone']);
    expect(planEntityWrites(ctx(stored), [{ id: 'a', hash: 'h1' }], false, build).staleIds).toEqual([]);
  });

  it('never re-marks an already-stale row, so stale_since is not rewritten every run', () => {
    const plan = planEntityWrites(ctx([['gone', { coreHash: 'h2', isStale: true }]]), [], true, build);
    expect(plan.staleIds).toEqual([]);
  });

  it('drops an item the builder cannot project (missing graph id) rather than writing a null key', () => {
    const plan = planEntityWrites(ctx([]), [{ id: '', hash: 'h' }], true,
      (item) => (item.id ? build(item) : null));
    expect(plan.rows).toEqual([]);
    expect(plan.inserted).toBe(0);
  });

  it('de-duplicates a graph id repeated in one response, last write wins', () => {
    const plan = planEntityWrites(ctx([]), [{ id: 'a', hash: 'h1' }, { id: 'a', hash: 'h2' }], true, build);
    expect(plan.rows).toHaveLength(1);
    expect(plan.inserted).toBe(1);
  });
});

describe('writeEntityChunks', () => {
  it('splits at 1000 and issues ONE call per chunk (spec §5.3)', async () => {
    const sizes: number[] = [];
    await writeEntityChunks(Array.from({ length: 2500 }, (_, i) => i), async (c) => { sizes.push(c.length); });
    expect(sizes).toEqual([1000, 1000, 500]);
  });

  it('issues no call at all for an empty plan', async () => {
    const write = vi.fn();
    await writeEntityChunks([], write);
    expect(write).not.toHaveBeenCalled();
  });
});
