import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { commandResultSchema } from './schemas';

/**
 * Regression coverage for handleFilesystemAnalysisCommandResult — specifically
 * the baseline-completion logic and orgId threading. The whole function was
 * previously mocked everywhere, so its behavior was unguarded.
 */

const { dbMock, insertValuesMock, selectQueue } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const shift = () => selectQueue.shift() ?? [];
  const insertValuesMock = vi.fn();

  const dbMock = {
    select: vi.fn(() => {
      const rows = shift();
      const terminal = Object.assign(Promise.resolve(rows), {
        limit: vi.fn().mockResolvedValue(rows),
        orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
      });
      return { from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue(terminal) }) };
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

  return { dbMock, insertValuesMock, selectQueue };
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

import { handleFilesystemAnalysisCommandResult } from './helpers';
import {
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
  vi.mocked(parseFilesystemAnalysisStdout).mockReturnValue({ ok: true });
  vi.mocked(getFilesystemScanState).mockResolvedValue(null as never);
});

describe('handleFilesystemAnalysisCommandResult — baseline completion', () => {
  it('marks a partial (max-depth) baseline complete when no checkpoint dirs remain', async () => {
    // The headline fix: a snapshot flagged partial=true (routine max-depth
    // truncation) must NOT block completion — only pending checkpoint dirs do.
    vi.mocked(mergeFilesystemAnalysisPayload).mockReturnValue({ partial: true, scanMode: 'baseline' });
    vi.mocked(readCheckpointPendingDirectories).mockReturnValue([]);
    selectQueue.push([{ usedPercent: 42 }]); // deviceDisks read

    await handleFilesystemAnalysisCommandResult(baselineCommand(), result(), ORG_ID);

    expect(upsertFilesystemScanState).toHaveBeenCalledTimes(1);
    const [dev, org, updates] = vi.mocked(upsertFilesystemScanState).mock.calls[0];
    expect(dev).toBe(DEVICE_ID);
    expect(org).toBe(ORG_ID); // threaded, not re-queried
    expect(updates.lastBaselineCompletedAt).toBeInstanceOf(Date);
    expect(updates.aggregate).toEqual({}); // aggregate reset on completion
  });

  it('does NOT mark complete while checkpoint dirs are still pending', async () => {
    vi.mocked(mergeFilesystemAnalysisPayload).mockReturnValue({ partial: true, scanMode: 'baseline' });
    vi.mocked(readCheckpointPendingDirectories).mockReturnValue([{ path: '/a', depth: 1 }]);
    selectQueue.push([{ usedPercent: 42 }]); // deviceDisks read
    selectQueue.push([]); // no in-flight resume scan

    await handleFilesystemAnalysisCommandResult(baselineCommand(), result(), ORG_ID);

    const [, , updates] = vi.mocked(upsertFilesystemScanState).mock.calls[0];
    expect(updates.lastBaselineCompletedAt).toBeNull();
    expect(updates.aggregate).not.toEqual({}); // aggregate retained for resume
  });

  it('threads the caller orgId into the snapshot write (no device re-query)', async () => {
    vi.mocked(mergeFilesystemAnalysisPayload).mockReturnValue({ scanMode: 'baseline' });
    vi.mocked(readCheckpointPendingDirectories).mockReturnValue([]);
    selectQueue.push([{ usedPercent: 10 }]);

    await handleFilesystemAnalysisCommandResult(baselineCommand(), result(), ORG_ID);

    expect(saveFilesystemSnapshot).toHaveBeenCalledWith(DEVICE_ID, ORG_ID, 'on_demand', expect.any(Object));
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
