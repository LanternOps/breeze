import { type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn(), update: vi.fn() },
}));


import { db } from '../db';
import {
  CLEANUP_RUNS_DEFAULT_LIMIT,
  CLEANUP_RUNS_MAX_LIMIT,
  decodeCleanupRunCursor,
  encodeCleanupRunCursor,
  cancelCleanupRunForCommand,
  recordLateCleanupResult,
  getCleanupRun,
  listCleanupRuns,
} from './filesystemCleanupRuns';

const RUN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function mockRows(rows: unknown[]): void {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  } as never);
}

const row = (id: string, requestedAt: string, overrides: Record<string, unknown> = {}) => ({
  id,
  kind: 'files',
  status: 'executed',
  scanPath: 'C:\\',
  requestedAt: new Date(requestedAt),
  approvedAt: new Date(requestedAt),
  bytesReclaimed: 4096,
  error: null,
  candidateCount: 3,
  estimatedBytes: 12288,
  actionCount: 2,
  ...overrides,
});

describe('cleanup-run cursor codec', () => {
  it('round-trips a (requestedAt, id) keyset', () => {
    const token = encodeCleanupRunCursor({ requestedAt: new Date('2026-09-19T10:00:00.000Z'), id: RUN_A });
    expect(decodeCleanupRunCursor(token)).toEqual({
      requestedAt: '2026-09-19T10:00:00.000Z',
      id: RUN_A,
    });
  });

  it('preserves PostgreSQL microseconds in the cursor', () => {
    const requestedAt = '2026-09-19T10:00:00.123456Z';
    expect(decodeCleanupRunCursor(encodeCleanupRunCursor({ requestedAt, id: RUN_A })))
      .toEqual({ requestedAt, id: RUN_A });
  });

  it('accepts an ISO string as well as a Date', () => {
    const token = encodeCleanupRunCursor({ requestedAt: '2026-09-19T10:00:00.000Z', id: RUN_A });
    expect(token).toBe(`2026-09-19T10:00:00.000Z|${RUN_A}`);
  });

  it('rejects malformed tokens rather than silently restarting the walk', () => {
    // A cursor that cannot be parsed must be a visible 400 at the route, not a
    // silent "page 1 again" — which is how a paginated list loops forever.
    expect(decodeCleanupRunCursor('')).toBeNull();
    expect(decodeCleanupRunCursor('nonsense')).toBeNull();
    expect(decodeCleanupRunCursor(`1|${RUN_A}`)).toBeNull();
    expect(decodeCleanupRunCursor(`not-a-date|${RUN_A}`)).toBeNull();
    expect(decodeCleanupRunCursor('2026-09-19T10:00:00.000Z|not-a-uuid')).toBeNull();
    expect(decodeCleanupRunCursor(`2026-09-19T10:00:00.000Z|${RUN_A}|extra`)).toBeNull();
  });
});

describe('listCleanupRuns', () => {
  beforeEach(() => vi.clearAllMocks());

  it('over-fetches by one and returns a nextCursor built from the last kept row', async () => {
    mockRows([
      row(RUN_A, '2026-09-19T10:00:00.000Z'),
      row(RUN_B, '2026-09-19T09:00:00.000Z'),
    ]);

    const result = await listCleanupRuns(DEVICE, { limit: 1 });

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]!.id).toBe(RUN_A);
    expect(result.nextCursor).toBe(`2026-09-19T10:00:00.000Z|${RUN_A}`);
  });

  it('selects and compares full database precision with the column timestamp type', async () => {
    const where = vi.fn().mockReturnValue({
      orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
    });
    vi.mocked(db.select).mockReturnValue({ from: vi.fn().mockReturnValue({ where }) } as never);
    const requestedAt = '2026-09-19T10:00:00.123456Z';
    await listCleanupRuns(DEVICE, { limit: 1, cursor: `${requestedAt}|${RUN_A}` });
    const dialect = new PgDialect();
    const projection = vi.mocked(db.select).mock.calls[0]![0] as Record<string, SQL>;
    expect(dialect.sqlToQuery(projection.requestedAt!).sql)
      .toBe(`to_char("device_filesystem_cleanup_runs"."requested_at", 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
    const condition = dialect.sqlToQuery(where.mock.calls[0]![0]);
    expect(condition.params).toEqual([DEVICE, requestedAt, requestedAt, RUN_A]);
    expect(condition.sql.match(/::timestamp\b/g)).toHaveLength(2);
    expect(condition.sql).not.toContain('::timestamptz');
  });

  it('returns a null nextCursor on a short page', async () => {
    mockRows([row(RUN_A, '2026-09-19T10:00:00.000Z')]);
    const result = await listCleanupRuns(DEVICE, { limit: 20 });
    expect(result.runs).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  it('serialises timestamps as ISO strings and never leaks the blobs', async () => {
    mockRows([row(RUN_A, '2026-09-19T10:00:00.000Z')]);
    const result = await listCleanupRuns(DEVICE, { limit: 20 });
    expect(result.runs[0]).toEqual({
      id: RUN_A,
      kind: 'files',
      status: 'executed',
      scanPath: 'C:\\',
      requestedAt: '2026-09-19T10:00:00.000Z',
      approvedAt: '2026-09-19T10:00:00.000Z',
      bytesReclaimed: 4096,
      error: null,
      candidateCount: 3,
      estimatedBytes: 12288,
      actionCount: 2,
    });
    expect(result.runs[0]).not.toHaveProperty('plan');
    expect(result.runs[0]).not.toHaveProperty('executedActions');
  });

  it('clamps the limit to the hard maximum', async () => {
    const limitFn = vi.fn().mockResolvedValue([]);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({ limit: limitFn }),
        }),
      }),
    } as never);

    await listCleanupRuns(DEVICE, { limit: 10_000 });
    expect(limitFn).toHaveBeenCalledWith(CLEANUP_RUNS_MAX_LIMIT + 1);
  });

  it('falls back to the default limit for a non-positive value', async () => {
    const limitFn = vi.fn().mockResolvedValue([]);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({ limit: limitFn }),
        }),
      }),
    } as never);

    await listCleanupRuns(DEVICE, { limit: 0 });
    expect(limitFn).toHaveBeenCalledWith(CLEANUP_RUNS_DEFAULT_LIMIT + 1);
  });
});

describe('getCleanupRun', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the full row including the plan and executed actions', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: RUN_A,
            kind: 'files',
            status: 'executed',
            scanPath: '/',
            requestedAt: new Date('2026-09-19T10:00:00.000Z'),
            approvedAt: null,
            bytesReclaimed: 0,
            error: null,
            plan: { preview: { candidates: [{ path: '/tmp/a' }] } },
            executedActions: [{ path: '/tmp/a', status: 'completed' }],
          }]),
        }),
      }),
    } as never);

    const run = await getCleanupRun(DEVICE, RUN_A);

    expect(run).toMatchObject({
      id: RUN_A,
      requestedAt: '2026-09-19T10:00:00.000Z',
      approvedAt: null,
      plan: { preview: { candidates: [{ path: '/tmp/a' }] } },
      executedActions: [{ path: '/tmp/a', status: 'completed' }],
    });
  });

  it('returns null when the run belongs to another device', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    } as never);

    expect(await getCleanupRun(DEVICE, RUN_B)).toBeNull();
  });
});

describe('cancelCleanupRunForCommand', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fails only a RUNNING file run, and says so in the error column', async () => {
    const whereMock = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: RUN_A }]) });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as never);

    const cancelled = await cancelCleanupRunForCommand({
      cleanupRunId: RUN_A,
      reason: 'cancelled: device moved',
      completedAt: new Date('2026-09-19T10:00:00.000Z'),
    });

    expect(cancelled).toBe(true);
    expect(new PgDialect().sqlToQuery(whereMock.mock.calls[0]![0]).params).toEqual([RUN_A, 'running', 'files']);
    expect(setMock.mock.calls[0]![0]).toMatchObject({
      status: 'failed',
      error: 'cancelled: device moved',
    });
  });

  it('returns false when the run was already terminal', async () => {
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
      }),
    } as never);

    expect(await cancelCleanupRunForCommand({
      cleanupRunId: RUN_A, reason: 'cancelled: device moved', completedAt: new Date(),
    })).toBe(false);
  });
});

describe('recordLateCleanupResult', () => {
  beforeEach(() => vi.clearAllMocks());

  it('atomically appends to the current array or envelope without reading stale actions or writing status', async () => {
    const where = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: RUN_A }]) });
    const set = vi.fn().mockReturnValue({ where });
    vi.mocked(db.update).mockReturnValue({ set } as never);
    expect(await recordLateCleanupResult({
      cleanupRunId: RUN_A, commandId: 'cmd-1', path: '/tmp/a',
      status: 'completed', completedAt: new Date('2026-09-19T11:00:00.000Z'),
    })).toBe('recorded');
    expect(db.select).not.toHaveBeenCalled();
    const written = set.mock.calls[0]![0];
    expect(written).not.toHaveProperty('status');
    const dialect = new PgDialect();
    const append = dialect.sqlToQuery(written.executedActions);
    const column = '"device_filesystem_cleanup_runs"."executed_actions"';
    expect(append.sql).toContain(`jsonb_typeof(${column}) = 'object'`);
    expect(append.sql).toContain(`jsonb_set(${column}, '{actions}'`);
    expect(append.sql).toContain(`${column} -> 'actions'`);
    expect(append.sql).toContain(`jsonb_typeof(${column}) = 'array'`);
    expect(append.sql.match(/\|\|/g)).toHaveLength(2);
    expect(append.params.map(value => JSON.parse(value as string))).toEqual([
      [{ path: '/tmp/a', status: 'completed', commandId: 'cmd-1', lateResult: true, receivedAt: '2026-09-19T11:00:00.000Z' }],
      [{ path: '/tmp/a', status: 'completed', commandId: 'cmd-1', lateResult: true, receivedAt: '2026-09-19T11:00:00.000Z' }],
    ]);
    expect(dialect.sqlToQuery(where.mock.calls[0]![0]).params)
      .toEqual([RUN_A, 'files', 'running', 'executed', 'failed']);
  });

  it('ignores absent, previewed, or system runs when the conditional update finds no row', async () => {
    const where = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) });
    vi.mocked(db.update).mockReturnValue({ set: vi.fn().mockReturnValue({ where }) } as never);
    expect(await recordLateCleanupResult({
      cleanupRunId: RUN_A, commandId: 'cmd-1', path: '/tmp/a', status: 'failed',
      error: 'device refused', completedAt: new Date(),
    })).toBe('ignored');
    expect(db.select).not.toHaveBeenCalled();
  });
});
