import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Wave 5A Task 2 (#3827). Same db-mock shape as ipAllowlist.test.ts: a
// controllable `limit`/`update`+`returning` pair exposed off the mocked `db`
// so each test can script exactly one query's result.
vi.mock('../db', () => {
  const limit = vi.fn();
  const returning = vi.fn();
  // `from()` answers BOTH chain shapes in this module: the hot-path
  // `selectGlobalRow` goes straight to `.where()`, while `readAiKillStateRow`
  // joins `users` first to resolve the actor's UUID (#4931).
  const leftJoin = vi.fn(() => ({ where: () => ({ limit }) }));
  return {
    db: {
      select: () => ({ from: () => ({ leftJoin, where: () => ({ limit }) }) }),
      update: () => ({ set: () => ({ where: () => ({ returning }) }) }),
      __limit: limit,
      __returning: returning,
      __leftJoin: leftJoin,
    },
    getCurrentDbAccessContext: vi.fn(() => undefined),
    runOutsideDbContext: vi.fn(<T,>(fn: () => T): T => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

import {
  _resetAiKillStateCacheForTest,
  bumpAiKillState,
  getCachedAiKillStateSnapshot,
  readAiKillState,
  readAiKillStateRow,
} from './aiKillState';

async function getLimitMock() {
  const mod = await import('../db');
  return (mod.db as unknown as { __limit: ReturnType<typeof vi.fn> }).__limit;
}

async function getReturningMock() {
  const mod = await import('../db');
  return (mod.db as unknown as { __returning: ReturnType<typeof vi.fn> }).__returning;
}

async function getLeftJoinMock() {
  const mod = await import('../db');
  return (mod.db as unknown as { __leftJoin: ReturnType<typeof vi.fn> }).__leftJoin;
}

beforeEach(async () => {
  _resetAiKillStateCacheForTest();
  (await getLimitMock()).mockReset();
  (await getReturningMock()).mockReset();
  (await getLeftJoinMock()).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getCachedAiKillStateSnapshot — default (inertness)', () => {
  it('defaults to not-killed, epoch 0, before any read has ever happened', () => {
    expect(getCachedAiKillStateSnapshot()).toEqual({ killed: false, epoch: 0 });
  });
});

describe('readAiKillState', () => {
  it('reads the seeded not-killed row and updates the sync snapshot', async () => {
    const limit = await getLimitMock();
    limit.mockResolvedValueOnce([{ killed: false, epoch: 0 }]);

    expect(await readAiKillState()).toEqual({ killed: false, epoch: 0 });
    expect(getCachedAiKillStateSnapshot()).toEqual({ killed: false, epoch: 0 });
  });

  it('reads a killed row and updates the sync snapshot with its epoch', async () => {
    const limit = await getLimitMock();
    limit.mockResolvedValueOnce([{ killed: true, epoch: 3 }]);

    expect(await readAiKillState()).toEqual({ killed: true, epoch: 3 });
    expect(getCachedAiKillStateSnapshot()).toEqual({ killed: true, epoch: 3 });
  });

  it('stays join-free: the actor resolution belongs to the admin read only (#4931)', async () => {
    // readAiKillState is the guardrail hot path (every run admission and every
    // act-mode dispatch). Resolving a display name there would add a users join
    // to a query whose only job is killed/epoch — and a deleted actor must
    // never be able to affect the kill state it returns.
    const limit = await getLimitMock();
    const leftJoin = await getLeftJoinMock();
    limit.mockResolvedValueOnce([{ killed: true, epoch: 3 }]);

    expect(await readAiKillState()).toEqual({ killed: true, epoch: 3 });
    expect(leftJoin).not.toHaveBeenCalled();
  });

  it('fails closed on a DB read error: caches { killed: true, epoch: -1 }, never throws', async () => {
    const limit = await getLimitMock();
    limit.mockRejectedValueOnce(new Error('connection reset'));

    await expect(readAiKillState()).resolves.toEqual({ killed: true, epoch: -1 });
    expect(getCachedAiKillStateSnapshot()).toEqual({ killed: true, epoch: -1 });
  });

  it('fails closed when the seed row is unexpectedly missing', async () => {
    const limit = await getLimitMock();
    limit.mockResolvedValueOnce([]);

    expect(await readAiKillState()).toEqual({ killed: true, epoch: -1 });
  });

  it('caches within the 5s TTL: a second call within the window issues no DB read', async () => {
    const limit = await getLimitMock();
    limit.mockResolvedValueOnce([{ killed: false, epoch: 0 }]);

    expect(await readAiKillState()).toEqual({ killed: false, epoch: 0 });
    expect(await readAiKillState()).toEqual({ killed: false, epoch: 0 });
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it('re-reads once the 5s TTL has elapsed', async () => {
    vi.useFakeTimers();
    try {
      const limit = await getLimitMock();
      limit.mockResolvedValueOnce([{ killed: false, epoch: 0 }]);
      expect(await readAiKillState()).toEqual({ killed: false, epoch: 0 });
      expect(limit).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(4_999);
      expect(await readAiKillState()).toEqual({ killed: false, epoch: 0 });
      expect(limit).toHaveBeenCalledTimes(1); // still within the TTL

      vi.advanceTimersByTime(2);
      limit.mockResolvedValueOnce([{ killed: true, epoch: 1 }]);
      expect(await readAiKillState()).toEqual({ killed: true, epoch: 1 });
      expect(limit).toHaveBeenCalledTimes(2); // TTL elapsed, re-read
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('bumpAiKillState', () => {
  it('writes killed + reason + updatedBy and eagerly refreshes the cache', async () => {
    const returning = await getReturningMock();
    returning.mockResolvedValueOnce([{ killed: true, epoch: 5 }]);

    const result = await bumpAiKillState(true, 'manual stop', 'user-1');
    expect(result).toEqual({ killed: true, epoch: 5 });
    // Refreshed eagerly — no need to wait out the TTL or call readAiKillState.
    expect(getCachedAiKillStateSnapshot()).toEqual({ killed: true, epoch: 5 });
  });

  it('throws when the UPDATE affects no row (the seed row is missing)', async () => {
    const returning = await getReturningMock();
    returning.mockResolvedValueOnce([]);

    await expect(bumpAiKillState(true)).rejects.toThrow(/seed row/);
  });
});

describe('readAiKillStateRow', () => {
  it('returns the full row without touching the TTL cache', async () => {
    const limit = await getLimitMock();
    const row = {
      killed: true,
      epoch: 7,
      reason: 'incident 42',
      updatedBy: 'admin-1',
      updatedAt: new Date('2026-08-28T12:00:00Z'),
    };
    limit.mockResolvedValueOnce([row]);

    await expect(readAiKillStateRow()).resolves.toEqual(row);
    // The admin read is a side-channel: the guardrail cache must stay at its
    // default until readAiKillState() itself runs.
    expect(getCachedAiKillStateSnapshot()).toEqual({ killed: false, epoch: 0 });
  });

  it('resolves the actor UUID to a name + email in the same system-scoped read (#4931)', async () => {
    // The admin page used to render `updatedBy` raw, so the one platform-wide
    // control whose audit trail justifies its mandatory reason field showed a
    // UUID as its actor. The resolution rides the existing system-scoped read
    // (one round trip, and system scope is what makes an actor from ANOTHER
    // partner's user row visible — `breeze_has_partner_access` short-circuits).
    const limit = await getLimitMock();
    const leftJoin = await getLeftJoinMock();
    limit.mockResolvedValueOnce([{
      killed: true,
      epoch: 7,
      reason: 'incident 42',
      updatedBy: 'admin-1',
      updatedByName: 'Ada Lovelace',
      updatedByEmail: 'ada@breeze.test',
      updatedAt: new Date('2026-08-28T12:00:00Z'),
    }]);

    await expect(readAiKillStateRow()).resolves.toMatchObject({
      updatedBy: 'admin-1',
      updatedByName: 'Ada Lovelace',
      updatedByEmail: 'ada@breeze.test',
    });
    expect(leftJoin).toHaveBeenCalledTimes(1);
  });

  it('passes an unresolvable actor through as nulls — no synthesized fallback (#4931)', async () => {
    // A deleted user, or a row flipped by ops via SQL (updated_by left NULL),
    // must still return the kill state: the join is a LEFT one, and the service
    // does not invent a display string. Falling back to the raw UUID is the
    // UI's job (AiKillSwitch.tsx), which keeps "unresolved" distinguishable
    // from "a user actually named like a UUID" for every other consumer.
    const limit = await getLimitMock();
    limit.mockResolvedValueOnce([{
      killed: false,
      epoch: 2,
      reason: 'sql fallback flip',
      updatedBy: 'admin-gone',
      updatedByName: null,
      updatedByEmail: null,
      updatedAt: new Date('2026-08-28T12:00:00Z'),
    }]);

    await expect(readAiKillStateRow()).resolves.toMatchObject({
      killed: false,
      epoch: 2,
      updatedBy: 'admin-gone',
      updatedByName: null,
      updatedByEmail: null,
    });
  });

  it('escapes a request-scoped ambient context via runOutsideDbContext (load-bearing)', async () => {
    // In a real admin request the ambient context is org/partner-scoped, and
    // ai_kill_state's system-only RLS policy returns ZERO rows under it — the
    // read only works because runOutsideDbContext exits the request context
    // first. Dropping that call keeps a pass-through mock green, so pin it.
    const dbMod = await import('../db');
    vi.mocked(dbMod.runOutsideDbContext).mockClear();
    vi.mocked(dbMod.getCurrentDbAccessContext).mockReturnValue({ scope: 'org' } as never);
    const limit = await getLimitMock();
    limit.mockResolvedValueOnce([{
      killed: false, epoch: 1, reason: null, updatedBy: null, updatedAt: new Date(),
    }]);

    await readAiKillStateRow();
    expect(dbMod.runOutsideDbContext).toHaveBeenCalledTimes(1);
    vi.mocked(dbMod.getCurrentDbAccessContext).mockReturnValue(undefined as never);
  });

  it('reads directly (no context escape) when the ambient scope is already system', async () => {
    const dbMod = await import('../db');
    vi.mocked(dbMod.runOutsideDbContext).mockClear();
    vi.mocked(dbMod.getCurrentDbAccessContext).mockReturnValue({ scope: 'system' } as never);
    const limit = await getLimitMock();
    limit.mockResolvedValueOnce([{
      killed: false, epoch: 1, reason: null, updatedBy: null, updatedAt: new Date(),
    }]);

    await readAiKillStateRow();
    expect(dbMod.runOutsideDbContext).not.toHaveBeenCalled();
    vi.mocked(dbMod.getCurrentDbAccessContext).mockReturnValue(undefined as never);
  });

  it('throws (no fail-closed synthesis) when the seed row is missing', async () => {
    const limit = await getLimitMock();
    limit.mockResolvedValueOnce([]);

    await expect(readAiKillStateRow()).rejects.toThrow(/seed row/);
  });
});

describe('_resetAiKillStateCacheForTest', () => {
  it('resets the cached snapshot back to the not-killed default', async () => {
    const limit = await getLimitMock();
    limit.mockResolvedValueOnce([{ killed: true, epoch: 9 }]);
    await readAiKillState();
    expect(getCachedAiKillStateSnapshot()).toEqual({ killed: true, epoch: 9 });

    _resetAiKillStateCacheForTest();
    expect(getCachedAiKillStateSnapshot()).toEqual({ killed: false, epoch: 0 });
  });
});
