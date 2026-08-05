import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The reaper is the only thing standing between a failed teardown and an
 * ephemeral agent living forever on an end user's machine, so every pass gets
 * its own test — plus the two properties that make it a *safety net* rather
 * than just another job: it never deletes a non-ephemeral device, and one bad
 * row cannot stop it from reaping the rest.
 */

const { endSupportSession, deleteDeviceCascade } = vi.hoisted(() => ({
  endSupportSession: vi.fn(async () => ({ ended: true, disconnect: null, commandDelivered: true })),
  deleteDeviceCascade: vi.fn(async () => undefined),
}));

vi.mock('bullmq', () => ({ Queue: class {}, Worker: class {}, Job: class {} }));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('../services/quickSupportEnd', () => ({ endSupportSession }));
vi.mock('../services/deviceDeletion', () => ({ deleteDeviceCascade }));

/**
 * Operators become inspectable tokens so the tests can assert the WHERE
 * predicates (which pass is being filtered, and with what cutoff) instead of
 * only the values written.
 */
vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
  eq: (a: unknown, b: unknown) => ({ op: 'eq', a, b }),
  lt: (a: unknown, b: unknown) => ({ op: 'lt', a, b }),
  isNull: (a: unknown) => ({ op: 'isNull', a }),
  isNotNull: (a: unknown) => ({ op: 'isNotNull', a }),
  inArray: (a: unknown, b: unknown) => ({ op: 'inArray', a, b }),
}));

vi.mock('../db/schema', () => ({
  supportSessions: {
    id: 'supportSessions.id',
    status: 'supportSessions.status',
    codeExpiresAt: 'supportSessions.codeExpiresAt',
    hardExpiresAt: 'supportSessions.hardExpiresAt',
    claimedAt: 'supportSessions.claimedAt',
    endedAt: 'supportSessions.endedAt',
    deviceId: 'supportSessions.deviceId',
  },
  devices: {
    id: 'devices.id',
    status: 'devices.status',
    lastSeenAt: 'devices.lastSeenAt',
    isEphemeral: 'devices.isEphemeral',
  },
}));

/** Result sets handed to consecutive `db.select()` calls, in order. */
const selectResults: unknown[][] = [];
/** `.set()` payloads from the two bulk-UPDATE passes, in order. */
const updates: Array<{ values: Record<string, unknown> }> = [];
/** WHERE condition of each select, in the same order as `selectResults`. */
const selectWheres: unknown[] = [];
/** WHERE condition of each update, in the same order as `updates`. */
const updateWheres: unknown[] = [];
/** Whether each select used an innerJoin (pass d is the only join). */
const selectJoins: boolean[] = [];
/** Every side-effecting step in call order, so pass ordering can be asserted. */
const callOrder: string[] = [];
/** Device ids handed to deleteDeviceCascade. */
const purgedDeviceIds: string[] = [];

vi.mock('../db', () => {
  const select = vi.fn(() => {
    const index = selectJoins.length;
    selectJoins.push(false);
    const rows = selectResults.shift() ?? [];
    const builder: Record<string, unknown> = {};
    builder.from = vi.fn(() => builder);
    builder.innerJoin = vi.fn(() => { selectJoins[index] = true; return builder; });
    builder.where = vi.fn((condition: unknown) => { selectWheres[index] = condition; return builder; });
    builder.limit = vi.fn(() => Promise.resolve(rows));
    return builder;
  });

  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      updates.push({ values });
      callOrder.push(`update:${String(values.endedReason)}`);
      return {
        where: vi.fn((condition: unknown) => { updateWheres.push(condition); return Promise.resolve([]); }),
      };
    }),
  }));

  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    callOrder.push('transaction');
    return fn({ isTx: true });
  });

  return {
    db: { select, update, transaction },
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
    runOutsideDbContext: vi.fn(<T>(fn: () => T): T => fn()),
  };
});

import { reapOnce } from './quickSupportReaper';

const NOW = new Date('2026-08-04T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60 * 1000);

/** Flatten an `and(...)` tree into its leaf comparison tokens. */
type Token = { op: string; a?: unknown; b?: unknown; conditions?: unknown[] };
function leaves(condition: unknown): Token[] {
  const token = condition as Token;
  if (!token || typeof token !== 'object') return [];
  if (token.op === 'and') return (token.conditions ?? []).flatMap(leaves);
  return [token];
}
function hasLeaf(condition: unknown, match: Partial<Token>): boolean {
  return leaves(condition).some((leaf) =>
    Object.entries(match).every(([k, v]) => (leaf as Record<string, unknown>)[k] === v));
}
function leafFor(condition: unknown, op: string, column: string): Token | undefined {
  return leaves(condition).find((leaf) => leaf.op === op && leaf.a === column);
}

/** No sessions matched anywhere — the "quiet fleet" baseline. */
function noResults() {
  selectResults.push([], [], []);
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  selectResults.length = 0;
  updates.length = 0;
  selectWheres.length = 0;
  updateWheres.length = 0;
  selectJoins.length = 0;
  callOrder.length = 0;
  purgedDeviceIds.length = 0;
  vi.clearAllMocks();
  endSupportSession.mockImplementation(async (...args: unknown[]) => {
    callOrder.push(`end:${String(args[0])}:${String(args[1])}`);
    return { ended: true, disconnect: null, commandDelivered: true };
  });
  deleteDeviceCascade.mockImplementation(async (...args: unknown[]) => {
    purgedDeviceIds.push(String(args[1]));
    return undefined;
  });
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.useRealTimers();
});

describe('reapOnce — pass (a) expired codes', () => {
  it('expires pending sessions whose code lapsed, with no teardown', async () => {
    noResults();

    await reapOnce();

    expect(updates[0]?.values).toEqual({
      status: 'expired',
      endedAt: NOW,
      endedReason: 'expired',
    });
    expect(hasLeaf(updateWheres[0], { op: 'eq', a: 'supportSessions.status', b: 'pending' })).toBe(true);
    expect(leafFor(updateWheres[0], 'lt', 'supportSessions.codeExpiresAt')?.b).toEqual(NOW);
    // No device exists yet, so nothing may be torn down for this pass.
    expect(endSupportSession).not.toHaveBeenCalled();
    expect(deleteDeviceCascade).not.toHaveBeenCalled();
  });
});

describe('reapOnce — pass (b) claimed limbo', () => {
  it("expires claimed sessions stuck without a device for 20 minutes as 'error'", async () => {
    noResults();

    await reapOnce();

    expect(updates[1]?.values).toEqual({
      status: 'expired',
      endedAt: NOW,
      endedReason: 'error',
    });
    expect(hasLeaf(updateWheres[1], { op: 'eq', a: 'supportSessions.status', b: 'claimed' })).toBe(true);
    // deviceId IS NULL is what makes this "enrollment never completed" rather
    // than a live session — without it this pass would kill working sessions.
    expect(hasLeaf(updateWheres[1], { op: 'isNull', a: 'supportSessions.deviceId' })).toBe(true);
    expect(leafFor(updateWheres[1], 'lt', 'supportSessions.claimedAt')?.b).toEqual(minutesAgo(20));
  });
});

describe('reapOnce — pass (c) hard cap', () => {
  it('ends every claimed/ready session past its hard expiry through endSupportSession', async () => {
    selectResults.push([{ id: 'sess-a' }, { id: 'sess-b' }], [], []);

    await reapOnce();

    expect(endSupportSession).toHaveBeenCalledWith('sess-a', 'expired');
    expect(endSupportSession).toHaveBeenCalledWith('sess-b', 'expired');
    expect(hasLeaf(selectWheres[0], { op: 'inArray', a: 'supportSessions.status' })).toBe(true);
    expect(leaves(selectWheres[0]).find((l) => l.op === 'inArray')?.b).toEqual(['claimed', 'ready']);
    expect(leafFor(selectWheres[0], 'lt', 'supportSessions.hardExpiresAt')?.b).toEqual(NOW);
  });

  it('runs after the bulk expiry passes', async () => {
    selectResults.push([{ id: 'sess-a' }], [], []);

    await reapOnce();

    expect(callOrder).toEqual(['update:expired', 'update:error', 'end:sess-a:expired']);
  });
});

describe('reapOnce — pass (d) end-user stop', () => {
  it("ends ready sessions whose device went offline 5 minutes ago as 'end_user'", async () => {
    selectResults.push([], [{ id: 'sess-c' }], []);

    await reapOnce();

    expect(endSupportSession).toHaveBeenCalledTimes(1);
    expect(endSupportSession).toHaveBeenCalledWith('sess-c', 'end_user');
    // Joined to devices — offline detection is a device property, not a
    // session one, since v1 has no explicit stop API.
    expect(selectJoins[1]).toBe(true);
    expect(hasLeaf(selectWheres[1], { op: 'eq', a: 'supportSessions.status', b: 'ready' })).toBe(true);
    expect(hasLeaf(selectWheres[1], { op: 'eq', a: 'devices.status', b: 'offline' })).toBe(true);
    expect(leafFor(selectWheres[1], 'lt', 'devices.lastSeenAt')?.b).toEqual(minutesAgo(5));
  });
});

describe('reapOnce — pass (e) purge', () => {
  it('purges the ephemeral device of a session ended over 6 hours ago', async () => {
    selectResults.push([], [], [{ id: 'sess-d', deviceId: 'dev-1' }]);
    selectResults.push([{ id: 'dev-1', isEphemeral: true }]);

    await reapOnce();

    expect(purgedDeviceIds).toEqual(['dev-1']);
    expect(deleteDeviceCascade).toHaveBeenCalledWith({ isTx: true }, 'dev-1');
    // Runs inside a transaction so a device is never half-deleted.
    expect(callOrder).toContain('transaction');
    expect(hasLeaf(selectWheres[2], { op: 'isNotNull', a: 'supportSessions.deviceId' })).toBe(true);
    expect(leaves(selectWheres[2]).find((l) => l.op === 'inArray')?.b).toEqual(['ended', 'expired']);
    expect(leafFor(selectWheres[2], 'lt', 'supportSessions.endedAt')?.b).toEqual(minutesAgo(6 * 60));
  });

  it('does not re-run teardown for already-terminal sessions', async () => {
    selectResults.push([], [], [{ id: 'sess-d', deviceId: 'dev-1' }]);
    selectResults.push([{ id: 'dev-1', isEphemeral: true }]);

    await reapOnce();

    expect(endSupportSession).not.toHaveBeenCalled();
  });

  it('skips a session whose device row is already gone', async () => {
    selectResults.push([], [], [{ id: 'sess-d', deviceId: 'dev-1' }]);
    selectResults.push([]); // device lookup returns nothing

    await reapOnce();

    expect(deleteDeviceCascade).not.toHaveBeenCalled();
  });
});

describe('reapOnce — non-ephemeral purge guard', () => {
  it('REFUSES to delete a real customer device referenced by a support session', async () => {
    selectResults.push([], [], [{ id: 'sess-evil', deviceId: 'real-device' }]);
    selectResults.push([{ id: 'real-device', isEphemeral: false }]);

    await reapOnce();

    expect(deleteDeviceCascade).not.toHaveBeenCalled();
    expect(purgedDeviceIds).toEqual([]);
    expect(callOrder).not.toContain('transaction');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('REFUSING to purge non-ephemeral device'));
  });

  it('still purges genuinely ephemeral devices in the same batch', async () => {
    selectResults.push([], [], [
      { id: 'sess-evil', deviceId: 'real-device' },
      { id: 'sess-ok', deviceId: 'ephemeral-device' },
    ]);
    selectResults.push([{ id: 'real-device', isEphemeral: false }]);
    selectResults.push([{ id: 'ephemeral-device', isEphemeral: true }]);

    await reapOnce();

    expect(purgedDeviceIds).toEqual(['ephemeral-device']);
  });
});

describe('reapOnce — one bad session cannot stop the run', () => {
  it('keeps hard-capping the remaining sessions when one end throws', async () => {
    selectResults.push([{ id: 'sess-1' }, { id: 'sess-boom' }, { id: 'sess-3' }], [], []);
    endSupportSession.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === 'sess-boom') throw new Error('socket exploded');
      callOrder.push(`end:${String(args[0])}`);
      return { ended: true, disconnect: null, commandDelivered: true };
    });

    await reapOnce();

    expect(callOrder).toContain('end:sess-1');
    expect(callOrder).toContain('end:sess-3');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Hard-cap end failed for session sess-boom'),
      expect.any(Error),
    );
  });

  it('keeps reaping later passes when an earlier pass throws', async () => {
    selectResults.push([{ id: 'sess-boom' }], [{ id: 'sess-ready' }], []);
    endSupportSession.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === 'sess-boom') throw new Error('socket exploded');
      callOrder.push(`end:${String(args[0])}`);
      return { ended: true, disconnect: null, commandDelivered: true };
    });

    await reapOnce();

    expect(callOrder).toContain('end:sess-ready');
  });

  it('keeps purging the remaining devices when one purge throws', async () => {
    selectResults.push([], [], [
      { id: 'sess-boom', deviceId: 'dev-boom' },
      { id: 'sess-ok', deviceId: 'dev-ok' },
    ]);
    selectResults.push([{ id: 'dev-boom', isEphemeral: true }]);
    selectResults.push([{ id: 'dev-ok', isEphemeral: true }]);
    deleteDeviceCascade.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === 'dev-boom') throw new Error('fk violation');
      purgedDeviceIds.push(String(args[1]));
      return undefined;
    });

    await reapOnce();

    expect(purgedDeviceIds).toEqual(['dev-ok']);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Purge failed for session sess-boom'),
      expect.any(Error),
    );
  });
});

describe('reapOnce — DB context', () => {
  it('runs the whole pass outside any request context, under system access', async () => {
    noResults();
    const dbModule = await import('../db');

    await reapOnce();

    expect(dbModule.runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(dbModule.withSystemDbAccessContext).toHaveBeenCalledTimes(1);
  });
});
