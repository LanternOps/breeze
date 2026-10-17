import { describe, expect, it, vi, beforeEach } from 'vitest';

const dbm = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('../../db', () => ({ db: dbm, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() }));

import { withTrustPageRevision } from './revision';

/** Thenable query-builder stand-in: every builder method returns itself; awaiting it yields `result`. */
function chain(result: unknown): unknown {
  const proxy: unknown = new Proxy(function () { /* target */ }, {
    get(_t, prop) {
      if (prop === 'then') return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
      return () => proxy;
    },
  });
  return proxy;
}

function txLockedAt(rev: number, updates: unknown[]) {
  dbm.transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn({
    select: () => chain([{ rev }]),
    update: () => ({ set: (v: unknown) => { updates.push(v); return chain([{ publicationRevision: rev + 1 }]); } }),
  }));
}

beforeEach(() => dbm.transaction.mockReset());

describe('withTrustPageRevision', () => {
  it('a stale expectedRevision is 409 REVISION_MISMATCH and the write never runs', async () => {
    const updates: unknown[] = [];
    txLockedAt(5, updates);
    const fn = vi.fn();
    await expect(withTrustPageRevision({ pageId: 'pg', expectedRevision: 4, actorUserId: 'u' }, fn))
      .rejects.toMatchObject({ status: 409, code: 'REVISION_MISMATCH' });
    expect(fn).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('an undefined expectedRevision runs the write and bumps the revision by one', async () => {
    const updates: unknown[] = [];
    txLockedAt(5, updates);
    const out = await withTrustPageRevision({ pageId: 'pg', expectedRevision: undefined, actorUserId: 'u' }, async () => 'wrote');
    expect(out).toEqual({ result: 'wrote', publicationRevision: 6 });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ updatedByUserId: 'u' });
  });

  it('a matching expectedRevision runs the write', async () => {
    txLockedAt(5, []);
    await expect(withTrustPageRevision({ pageId: 'pg', expectedRevision: 5, actorUserId: 'u' }, async () => 1)).resolves.toMatchObject({ publicationRevision: 6 });
  });

  it('a missing page is a 404', async () => {
    dbm.transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn({ select: () => chain([]) }));
    await expect(withTrustPageRevision({ pageId: 'pg', expectedRevision: undefined, actorUserId: 'u' }, async () => 1)).rejects.toMatchObject({ status: 404 });
  });
});
