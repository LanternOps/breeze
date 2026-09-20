import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn(), update: vi.fn() },
}));

vi.mock('../db/schema', () => ({
  deviceFilesystemCleanupRuns: {
    id: 'id',
    deviceId: 'device_id',
    kind: 'kind',
    status: 'status',
    scanPath: 'scan_path',
    requestedAt: 'requested_at',
    approvedAt: 'approved_at',
    bytesReclaimed: 'bytes_reclaimed',
    error: 'error',
    plan: 'plan',
    executedActions: 'executed_actions',
  },
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

  it('accepts an ISO string as well as a Date', () => {
    const token = encodeCleanupRunCursor({ requestedAt: '2026-09-19T10:00:00.000Z', id: RUN_A });
    expect(token).toBe(`2026-09-19T10:00:00.000Z|${RUN_A}`);
  });

  it('rejects malformed tokens rather than silently restarting the walk', () => {
    // A cursor that cannot be parsed must be a visible 400 at the route, not a
    // silent "page 1 again" — which is how a paginated list loops forever.
    expect(decodeCleanupRunCursor('')).toBeNull();
    expect(decodeCleanupRunCursor('nonsense')).toBeNull();
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

  it('ignores a result for a run that is still running — the route owns that finalise', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ status: 'running', executedActions: [] }]),
        }),
      }),
    } as never);

    expect(await recordLateCleanupResult({
      cleanupRunId: RUN_A, commandId: 'cmd-1', path: '/tmp/a',
      status: 'completed', completedAt: new Date(),
    })).toBe('ignored');
    expect(db.update).not.toHaveBeenCalled();
  });

  it.each(['array', 'envelope'])('appends a lateResult to a finalised %s WITHOUT changing its status', async (shape) => {
    const original = [{ path: '/tmp/a', category: 'temp_files', sizeBytes: 1, status: 'skipped_budget' }];
    const executedActions = shape === 'array' ? original : { partial: true, budgetMs: 240_000, actions: original };
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            status: 'executed',
            executedActions,
          }]),
        }),
      }),
    } as never);
    const setMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as never);

    expect(await recordLateCleanupResult({
      cleanupRunId: RUN_A, commandId: 'cmd-1', path: '/tmp/a',
      status: 'completed', completedAt: new Date('2026-09-19T11:00:00.000Z'),
    })).toBe('recorded');

    const written = setMock.mock.calls[0]![0] as { executedActions: Array<Record<string, unknown>>; status?: unknown };
    // The original action row is untouched; the late one is additive and tagged.
    const actions = shape === 'array' ? written.executedActions
      : (written.executedActions as unknown as { actions: Array<Record<string, unknown>> }).actions;
    if (shape === 'envelope') expect(written.executedActions).toMatchObject({ partial: true, budgetMs: 240_000 });
    expect(actions).toHaveLength(2);
    expect(actions[0]).toEqual(original[0]);
    expect(actions[1]).toMatchObject({
      path: '/tmp/a', status: 'completed', lateResult: true, commandId: 'cmd-1',
    });
    // Status must NOT be in the update set at all — a late `completed` cannot
    // turn a `failed` run into a success after the operator has read it.
    expect(written).not.toHaveProperty('status');
  });
});
