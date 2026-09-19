import { PgDialect } from 'drizzle-orm/pg-core';
import { captureException } from '../../services/sentry';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { commandResultSchema } from './schemas';

/**
 * Regression coverage for handleFilesystemAnalysisCommandResult — specifically
 * the baseline-completion logic and orgId threading. The whole function was
 * previously mocked everywhere, so its behavior was unguarded.
 */

const { dbMock, insertValuesMock, selectQueue, whereMock } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const shift = () => selectQueue.shift() ?? [];
  const insertValuesMock = vi.fn();

  const whereMock = vi.fn();
  const dbMock = {
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(dbMock)),
    select: vi.fn(() => {
      const rows = shift();
      const terminal = Object.assign(Promise.resolve(rows), {
        limit: vi.fn().mockResolvedValue(rows),
        orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
      });
      return { from: vi.fn().mockReturnValue({ where: vi.fn((condition: unknown) => { whereMock(condition); return terminal; }) }) };
    }),
    insert: vi.fn(() => ({
      values: vi.fn((vals: unknown) => {
        insertValuesMock(vals);
        return Object.assign(Promise.resolve(undefined), {
          returning: vi.fn().mockResolvedValue([{ id: 'row-1' }]),
        });
      }),
    })),
  };

  return { dbMock, insertValuesMock, selectQueue, whereMock };
});

vi.mock('../../db', () => ({
  db: dbMock,
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => new Proxy({}, {
  get: (_t, prop: string) => (prop === 'then' ? undefined : { $inferSelect: {}, name: prop }),
  has: () => true,
}));

vi.mock('../../services/redis', () => ({ getRedis: vi.fn(() => null) }));
vi.mock('../../services/eventBus', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/softwareComplianceWorker', () => ({ scheduleSoftwareComplianceCheck: vi.fn() }));
vi.mock('../../services/softwarePolicyService', () => ({ recordSoftwarePolicyAudit: vi.fn() }));
vi.mock('../../services/commandQueue', () => ({
  queueCommandForExecution: vi.fn().mockResolvedValue({ command: { id: 'resume-1' } }),
}));
vi.mock('../../services/filesystemAnalysis', () => ({
  claimFilesystemScanGeneration: vi.fn(async () => 'claimed'),
  setFilesystemScanGeneration: vi.fn(),
  getFilesystemScanState: vi.fn(),
  mergeFilesystemAnalysisPayload: vi.fn(),
  parseFilesystemAnalysisStdout: vi.fn(),
  readCheckpointPendingDirectories: vi.fn(),
  readHotDirectories: vi.fn(() => []),
  saveFilesystemSnapshot: vi.fn(),
  upsertFilesystemScanState: vi.fn(),
}));
vi.mock('../../services/cloudflareMtls', () => ({ CloudflareMtlsService: vi.fn() }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../metrics', () => ({ recordSoftwareRemediationDecision: vi.fn() }));

import { queueCommandForExecution } from '../../services/commandQueue';

import { handleFilesystemAnalysisCommandResult } from './helpers';
import {
  claimFilesystemScanGeneration,
  setFilesystemScanGeneration,
  getFilesystemScanState,
  mergeFilesystemAnalysisPayload,
  parseFilesystemAnalysisStdout,
  readCheckpointPendingDirectories,
  saveFilesystemSnapshot,
  upsertFilesystemScanState,
} from '../../services/filesystemAnalysis';

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const ORG_ID = '00000000-0000-4000-8000-0000000000aa';

function baselineCommand() {
  return {
    id: '00000000-0000-4000-8000-0000000000cc',
    deviceId: DEVICE_ID,
    payload: { scanMode: 'baseline', trigger: 'on_demand', autoContinue: true, resumeAttempt: 0 },
    createdBy: null,
  } as never;
}

function result(): z.infer<typeof commandResultSchema> {
  return { commandId: 'c', status: 'completed', exitCode: 0, stdout: '{"x":1}' } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  dbMock.transaction.mockImplementation(async (fn) => fn(dbMock));
  vi.mocked(claimFilesystemScanGeneration).mockResolvedValue('claimed');
  vi.mocked(parseFilesystemAnalysisStdout).mockReturnValue({ ok: true });
  vi.mocked(getFilesystemScanState).mockResolvedValue(null as never);
});

describe('handleFilesystemAnalysisCommandResult — baseline completion', () => {
  it('marks a partial (max-depth) baseline complete when no checkpoint dirs remain', async () => {
    // The headline fix: a snapshot flagged partial=true (routine max-depth
    // truncation) must NOT block completion — only pending checkpoint dirs do.
    vi.mocked(mergeFilesystemAnalysisPayload).mockReturnValue({ partial: true, scanMode: 'baseline' });
    vi.mocked(readCheckpointPendingDirectories).mockReturnValue([]);
    selectQueue.push([{ osType: 'linux' }]);
    selectQueue.push([{ mountPoint: '/', usedPercent: 42 }]); // deviceDisks read

    await handleFilesystemAnalysisCommandResult(baselineCommand(), result(), ORG_ID);

    expect(upsertFilesystemScanState).toHaveBeenCalledTimes(1);
    const call = vi.mocked(upsertFilesystemScanState).mock.calls[0];
    expect(call).toBeDefined();
    const [dev, org, , updates] = call!;
    expect(dev).toBe(DEVICE_ID);
    expect(org).toBe(ORG_ID); // threaded, not re-queried
    expect(updates.lastBaselineCompletedAt).toBeInstanceOf(Date);
    expect(updates.aggregate).toEqual({}); // aggregate reset on completion
  });

  it('does NOT mark complete while checkpoint dirs are still pending', async () => {
    vi.mocked(mergeFilesystemAnalysisPayload).mockReturnValue({ partial: true, scanMode: 'baseline' });
    vi.mocked(readCheckpointPendingDirectories).mockReturnValue([{ path: '/a', depth: 1 }]);
    selectQueue.push([{ osType: 'linux' }]);
    selectQueue.push([{ mountPoint: '/', usedPercent: 42 }]); // deviceDisks read
    selectQueue.push([]); // no in-flight resume scan

    await handleFilesystemAnalysisCommandResult(baselineCommand(), result(), ORG_ID);

    const call = vi.mocked(upsertFilesystemScanState).mock.calls[0];
    expect(call).toBeDefined();
    const updates = call![3];
    expect(updates.lastBaselineCompletedAt).toBeNull();
    expect(updates.aggregate).not.toEqual({}); // aggregate retained for resume
  });

  it('threads the caller orgId into the snapshot write (OS-only device query)', async () => {
    vi.mocked(mergeFilesystemAnalysisPayload).mockReturnValue({ scanMode: 'baseline' });
    vi.mocked(readCheckpointPendingDirectories).mockReturnValue([]);
    selectQueue.push([{ osType: 'linux' }]);
    selectQueue.push([{ mountPoint: '/', usedPercent: 10 }]);

    await handleFilesystemAnalysisCommandResult(baselineCommand(), result(), ORG_ID);

    expect(saveFilesystemSnapshot).toHaveBeenCalledWith(DEVICE_ID, ORG_ID, 'on_demand', '/', expect.any(Object), dbMock);
  });

  it('drops a non-completed result without writing anything', async () => {
    await handleFilesystemAnalysisCommandResult(
      baselineCommand(),
      { commandId: 'c', status: 'failed', exitCode: 1 } as never,
      ORG_ID,
    );
    expect(saveFilesystemSnapshot).not.toHaveBeenCalled();
    expect(upsertFilesystemScanState).not.toHaveBeenCalled();
  });
});

describe('handleFilesystemAnalysisCommandResult — scan-path keying (spec §5.1)', () => {
  function windowsCommand(path: unknown, autoContinue = false) {
    return {
      id: '00000000-0000-4000-8000-0000000000cc',
      deviceId: DEVICE_ID,
      payload: { scanMode: 'baseline', trigger: 'on_demand', autoContinue, resumeAttempt: 0, path },
      createdBy: null,
    } as never;
  }

  it('keys the snapshot and the scan state on the normalised command path', async () => {
    vi.mocked(mergeFilesystemAnalysisPayload).mockReturnValue({ scanMode: 'baseline' });
    vi.mocked(readCheckpointPendingDirectories).mockReturnValue([]);
    selectQueue.push([{ osType: 'windows' }]);                       // devices read
    selectQueue.push([{ mountPoint: 'D:\\', usedPercent: 5 }]);      // deviceDisks read

    await handleFilesystemAnalysisCommandResult(windowsCommand('d:/'), result(), ORG_ID);

    expect(saveFilesystemSnapshot).toHaveBeenCalledWith(
      DEVICE_ID, ORG_ID, 'on_demand', 'D:\\', expect.any(Object), dbMock,
    );
    expect(getFilesystemScanState).toHaveBeenCalledWith(DEVICE_ID, 'D:\\', dbMock);
    const [dev, org, scanPath] = vi.mocked(upsertFilesystemScanState).mock.calls[0]!;
    expect(dev).toBe(DEVICE_ID);
    expect(org).toBe(ORG_ID);
    expect(scanPath).toBe('D:\\');
  });

  it('falls back to the OS root when the command carried no path', async () => {
    vi.mocked(mergeFilesystemAnalysisPayload).mockReturnValue({ scanMode: 'baseline' });
    vi.mocked(readCheckpointPendingDirectories).mockReturnValue([]);
    selectQueue.push([{ osType: 'windows' }]);
    selectQueue.push([{ mountPoint: 'C:\\', usedPercent: 80 }]);

    await handleFilesystemAnalysisCommandResult(windowsCommand(undefined), result(), ORG_ID);

    expect(saveFilesystemSnapshot).toHaveBeenCalledWith(
      DEVICE_ID, ORG_ID, 'on_demand', 'C:\\', expect.any(Object), dbMock,
    );
  });

  it('takes the disk percent from the disk whose mount point IS the scanned volume (defect 8)', async () => {
    vi.mocked(mergeFilesystemAnalysisPayload).mockReturnValue({ scanMode: 'baseline' });
    vi.mocked(readCheckpointPendingDirectories).mockReturnValue([]);
    selectQueue.push([{ osType: 'windows' }]);
    // C: is listed first and is 80% full. The old code took `LIMIT 1` — an
    // arbitrary row — and recorded 80 as D:'s baseline.
    selectQueue.push([
      { mountPoint: 'C:\\', usedPercent: 80 },
      { mountPoint: 'd:/', usedPercent: 5 },
    ]);

    await handleFilesystemAnalysisCommandResult(windowsCommand('D:\\'), result(), ORG_ID);

    const updates = vi.mocked(upsertFilesystemScanState).mock.calls[0]![3];
    expect(updates.lastDiskUsedPercent).toBe(5);
  });

  it('records no disk percent when the scanned volume has no matching disk row', async () => {
    vi.mocked(mergeFilesystemAnalysisPayload).mockReturnValue({ scanMode: 'baseline' });
    vi.mocked(readCheckpointPendingDirectories).mockReturnValue([]);
    vi.mocked(getFilesystemScanState).mockResolvedValue(null as never);
    selectQueue.push([{ osType: 'linux' }]);
    selectQueue.push([{ mountPoint: '/', usedPercent: 91 }]);

    await handleFilesystemAnalysisCommandResult(windowsCommand('/data'), result(), ORG_ID);

    const updates = vi.mocked(upsertFilesystemScanState).mock.calls[0]![3];
    // Never inherit an unrelated disk's figure — null means the next scan
    // takes a baseline, which is the safe answer.
    expect(updates.lastDiskUsedPercent).toBeNull();
  });

  it('drops a result whose command is no longer this volume\u2019s generation', async () => {
    // Amendment 18 / spec §13 #18. A continuation and a user-triggered rescan
    // of the same volume can both be in flight; without this the older result
    // overwrites the newer run's checkpoint with a stale frontier.
    vi.mocked(mergeFilesystemAnalysisPayload).mockReturnValue({ scanMode: 'baseline' });
    vi.mocked(claimFilesystemScanGeneration).mockResolvedValue('superseded' as never);
    selectQueue.push([{ osType: 'windows' }]);

    await handleFilesystemAnalysisCommandResult(windowsCommand('D:\\'), result(), ORG_ID);

    expect(saveFilesystemSnapshot).not.toHaveBeenCalled();
    expect(upsertFilesystemScanState).not.toHaveBeenCalled();
  });

  it('drops a DUPLICATE delivery of the same command (idempotent application)', async () => {
    vi.mocked(mergeFilesystemAnalysisPayload).mockReturnValue({ scanMode: 'baseline' });
    vi.mocked(claimFilesystemScanGeneration).mockResolvedValue('already_applied' as never);
    selectQueue.push([{ osType: 'windows' }]);

    await handleFilesystemAnalysisCommandResult(windowsCommand('D:\\'), result(), ORG_ID);

    expect(saveFilesystemSnapshot).not.toHaveBeenCalled();
    expect(upsertFilesystemScanState).not.toHaveBeenCalled();
  });

  it('APPLIES a result when no scan-state row exists yet, rather than losing the scan', async () => {
    vi.mocked(mergeFilesystemAnalysisPayload).mockReturnValue({ scanMode: 'baseline' });
    vi.mocked(readCheckpointPendingDirectories).mockReturnValue([]);
    vi.mocked(claimFilesystemScanGeneration).mockResolvedValue('absent' as never);
    selectQueue.push([{ osType: 'windows' }]);
    selectQueue.push([{ mountPoint: 'D:\\', usedPercent: 5 }]);

    await handleFilesystemAnalysisCommandResult(windowsCommand('D:\\'), result(), ORG_ID);

    expect(saveFilesystemSnapshot).toHaveBeenCalled();
  });

  it('claims the generation for the SCANNED volume, not the device', async () => {
    vi.mocked(mergeFilesystemAnalysisPayload).mockReturnValue({ scanMode: 'baseline' });
    vi.mocked(readCheckpointPendingDirectories).mockReturnValue([]);
    vi.mocked(claimFilesystemScanGeneration).mockResolvedValue('claimed' as never);
    selectQueue.push([{ osType: 'windows' }]);
    selectQueue.push([{ mountPoint: 'D:\\', usedPercent: 5 }]);

    await handleFilesystemAnalysisCommandResult(windowsCommand('d:/'), result(), ORG_ID);

    expect(claimFilesystemScanGeneration).toHaveBeenCalledWith(
      DEVICE_ID, 'D:\\', '00000000-0000-4000-8000-0000000000cc', dbMock, ORG_ID,
    );
  });

  it('suppresses an auto-resume only on an in-flight scan of the SAME volume', async () => {
    // Found while wiring the generation (amendment 18): the continuation
    // check matched any in-flight filesystem_analysis on the DEVICE, so a
    // running C:\ scan silently cancelled a D:\ baseline's auto-resume and
    // the D:\ baseline never finished.
    vi.mocked(mergeFilesystemAnalysisPayload).mockReturnValue({ scanMode: 'baseline' });
    vi.mocked(readCheckpointPendingDirectories).mockReturnValue([{ path: 'D:\\media', depth: 1 }]);
    vi.mocked(claimFilesystemScanGeneration).mockResolvedValue('claimed' as never);
    selectQueue.push([{ osType: 'windows' }]);
    selectQueue.push([{ mountPoint: 'D:\\', usedPercent: 5 }]);
    selectQueue.push([]); // the path-scoped in-flight probe finds nothing for D:\

    await handleFilesystemAnalysisCommandResult(windowsCommand('D:\\', true), result(), ORG_ID);

    expect(queueCommandForExecution).toHaveBeenCalledWith(
      DEVICE_ID,
      'filesystem_analysis',
      expect.objectContaining({ path: 'D:\\', resumeAttempt: 1 }),
      expect.anything(),
    );
    const probe = new PgDialect().sqlToQuery(whereMock.mock.calls[2]![0]);
    expect(probe.sql).toContain("->>'path' =");
    expect(probe.params).toContain('D:\\');
    // And the continuation records its OWN generation, or its result is
    // dropped as superseded the moment it comes back.
    expect(setFilesystemScanGeneration).toHaveBeenCalledWith(DEVICE_ID, ORG_ID, 'D:\\', 'resume-1');
  });

  it('writes nothing at all when the device row cannot be resolved', async () => {
    vi.mocked(mergeFilesystemAnalysisPayload).mockReturnValue({ scanMode: 'baseline' });
    selectQueue.push([]); // devices read returns nothing

    await handleFilesystemAnalysisCommandResult(windowsCommand('D:\\'), result(), ORG_ID);

    expect(saveFilesystemSnapshot).not.toHaveBeenCalled();
    expect(upsertFilesystemScanState).not.toHaveBeenCalled();
  });
});

 describe('result persistence transaction and drop telemetry', () => {
  it('rolls back a failed write and permits redelivery', async () => {
    let applied = false;
    const tx = { marker: 'transaction', select: dbMock.select };
    dbMock.transaction.mockImplementation(async (fn) => {
      const before = applied;
      try { return await fn(tx); } catch (error) { applied = before; throw error; }
    });
    vi.mocked(claimFilesystemScanGeneration).mockImplementation(async () => {
      if (applied) return 'already_applied';
      applied = true;
      return 'claimed';
    });
    vi.mocked(mergeFilesystemAnalysisPayload).mockReturnValue({ summary: {} });
    vi.mocked(readCheckpointPendingDirectories).mockReturnValue([]);
    vi.mocked(saveFilesystemSnapshot).mockRejectedValueOnce(new Error('write failed')).mockResolvedValue(null);
    selectQueue.push([{ osType: 'linux' }], [], [{ osType: 'linux' }], []);
    await expect(handleFilesystemAnalysisCommandResult(baselineCommand(), result(), ORG_ID)).rejects.toThrow('write failed');
    await handleFilesystemAnalysisCommandResult(baselineCommand(), result(), ORG_ID);
    expect(saveFilesystemSnapshot).toHaveBeenCalledTimes(2);
    expect(claimFilesystemScanGeneration).toHaveBeenLastCalledWith(DEVICE_ID, '/', expect.any(String), tx, ORG_ID);
    expect(saveFilesystemSnapshot).toHaveBeenLastCalledWith(DEVICE_ID, ORG_ID, 'on_demand', '/', expect.any(Object), tx);
    expect(upsertFilesystemScanState).toHaveBeenLastCalledWith(DEVICE_ID, ORG_ID, '/', expect.any(Object), tx);
  });

  it.each(['superseded', 'already_applied', 'unknown device', 'unparseable stdout'])(
    'captures %s with the command id', async (reason) => {
      selectQueue.push(reason === 'unknown device' ? [] : [{ osType: 'linux' }]);
      if (reason === 'unparseable stdout') vi.mocked(parseFilesystemAnalysisStdout).mockReturnValue({});
      if (reason === 'superseded' || reason === 'already_applied') vi.mocked(claimFilesystemScanGeneration).mockResolvedValue(reason);
      await handleFilesystemAnalysisCommandResult(baselineCommand(), result(), ORG_ID);
      expect(captureException).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('00000000-0000-4000-8000-0000000000cc') }));
    },
  );
 });
