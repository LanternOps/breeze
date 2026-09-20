import { execFileSync } from 'node:child_process';
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
  mergeCleanupExecutedActions,
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
      .toEqual([RUN_A, 'files', 'running', 'executed', 'failed', 'cmd-1']);
    expect(dialect.sqlToQuery(where.mock.calls[0]![0]).sql).toContain('NOT EXISTS');
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

// Optional real-PostgreSQL proof: only a session-local temporary table is used.
// Set CLEANUP_TEST_POSTGRES_CONTAINER to a local PostgreSQL container to run.
describe.runIf(process.env.CLEANUP_TEST_POSTGRES_CONTAINER)('cleanup action SQL ordering', () => {
  const dialect = new PgDialect();
  function literal(value: unknown): string {
    return "'" + String(value).replaceAll("'", "''") + "'";
  }
  function expression(value: SQL): string {
    const query = dialect.sqlToQuery(value);
    return query.sql.replace(/\$(\d+)/g, (_, index) => literal(query.params[Number(index) - 1]));
  }
  async function lateUpdate(): Promise<string> {
    const where = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: RUN_A }]) });
    const set = vi.fn().mockReturnValue({ where });
    vi.mocked(db.update).mockReturnValue({ set } as never);
    await recordLateCleanupResult({ cleanupRunId: RUN_A, commandId: 'cmd-late', path: '/tmp/late', status: 'completed', completedAt: new Date() });
    return `UPDATE device_filesystem_cleanup_runs SET executed_actions = ${expression(set.mock.calls[0]![0].executedActions)} WHERE ${expression(where.mock.calls[0]![0])};`;
  }
  function finalise(actions: unknown[]): string {
    return `UPDATE device_filesystem_cleanup_runs SET executed_actions = ${expression(mergeCleanupExecutedActions({ partial: false, budgetMs: 240000, actions }))}, status = 'executed';`;
  }
  function run(updates: string[]): { actions: Array<{ commandId?: string; lateResult?: boolean }>; partial: boolean } {
    const output = execFileSync('docker', ['exec', '-i', process.env.CLEANUP_TEST_POSTGRES_CONTAINER!, 'psql', '-U', 'breeze', '-d', 'breeze', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
      input: `BEGIN; CREATE TEMP TABLE device_filesystem_cleanup_runs (id text, kind text, status text, executed_actions jsonb); INSERT INTO device_filesystem_cleanup_runs VALUES ('${RUN_A}', 'files', 'running', '{"actions":[]}'); ${updates.join(' ')} SELECT executed_actions FROM device_filesystem_cleanup_runs; ROLLBACK;`,
      encoding: 'utf8',
    });
    return JSON.parse(output.trim());
  }
  it('duplicate terminal delivery records one entry', async () => {
    const late = await lateUpdate();
    expect(run([late, late]).actions).toHaveLength(1);
  });
  it('append then finalise keeps the late entry and the finaliser action', async () => {
    const result = run([await lateUpdate(), finalise([{ commandId: 'cmd-other', status: 'completed' }])]);
    expect(result.actions.map(a => a.commandId)).toEqual(['cmd-late', 'cmd-other']);
    expect(result.partial).toBe(false);
  });
  it('finalise then append does not duplicate the finaliser action', async () => {
    const result = run([finalise([{ commandId: 'cmd-late', status: 'completed' }]), await lateUpdate()]);
    expect(result.actions).toEqual([{ commandId: 'cmd-late', status: 'completed' }]);
  });
  it('finalise dedupes against an earlier receipt but retains actions without command IDs', async () => {
    const result = run([await lateUpdate(), finalise([{ commandId: 'cmd-late', status: 'failed' }, { status: 'rejected' }, { status: 'skipped_budget' }])]);
    expect(result.actions).toHaveLength(3);
    expect(result.actions[0]).toMatchObject({ commandId: 'cmd-late', lateResult: true });
  });
});
