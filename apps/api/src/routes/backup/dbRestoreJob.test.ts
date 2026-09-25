import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SNAPSHOT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function chain(resolved: unknown = []) {
  const c: Record<string, any> = {};
  for (const m of ['values', 'set', 'where', 'returning']) {
    c[m] = vi.fn(() => Object.assign(Promise.resolve(resolved), c));
  }
  return Object.assign(Promise.resolve(resolved), c);
}

const insertMock = vi.fn();
const updateMock = vi.fn();
const queueMock = vi.fn();
const metricMock = vi.fn();

vi.mock('../../db', () => ({
  db: {
    insert: (...a: unknown[]) => insertMock(...(a as [])),
    update: (...a: unknown[]) => updateMock(...(a as [])),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => any) => fn()),
}));
vi.mock('../../db/schema', () => ({
  restoreJobs: { id: 'restore_jobs.id', targetConfig: 'restore_jobs.target_config' },
}));
vi.mock('../../services/commandQueue', () => ({
  queueCommandForExecution: (...a: unknown[]) => queueMock(...(a as [])),
}));
vi.mock('../../services/backupMetrics', () => ({
  recordBackupDispatchFailure: (...a: unknown[]) => metricMock(...(a as [])),
}));

import { dispatchTrackedDbRestore } from './dbRestoreJob';

const base = {
  orgId: ORG_ID,
  snapshotId: SNAPSHOT_ID,
  deviceId: DEVICE_ID,
  userId: 'user-1',
  commandType: 'mssql_restore',
  engine: 'mssql' as const,
  targetConfig: { targetDatabase: 'AppDb_Restore' },
  buildPayload: (restoreJobId: string) => ({ restoreJobId, snapshotId: 'prov-1' }),
};

describe('dispatchTrackedDbRestore (#6974)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertMock.mockReset();
    updateMock.mockReset();
    queueMock.mockReset();
  });

  it('creates a restore_jobs row, stamps its id into the payload, and links the command id', async () => {
    const inserted = chain([{ id: JOB_ID, status: 'pending' }]);
    insertMock.mockReturnValueOnce(inserted);
    const linked = chain([{ id: JOB_ID }]);
    updateMock.mockReturnValueOnce(linked);
    queueMock.mockResolvedValueOnce({ command: { id: 'cmd-1', status: 'sent' } });

    const res = await dispatchTrackedDbRestore(base);

    expect(res).toEqual({ ok: true, command: { id: 'cmd-1', status: 'sent' }, restoreJobId: JOB_ID });
    expect(inserted.values).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID,
      snapshotId: SNAPSHOT_ID,
      deviceId: DEVICE_ID,
      restoreType: 'full',
      status: 'pending',
      initiatedBy: 'user-1',
      targetConfig: { engine: 'mssql', targetDatabase: 'AppDb_Restore' },
    }));
    expect(queueMock).toHaveBeenCalledWith(
      DEVICE_ID,
      'mssql_restore',
      { restoreJobId: JOB_ID, snapshotId: 'prov-1' },
      { userId: 'user-1' },
    );
    // The command-id link is what commandResultHandlers correlates on.
    expect(linked.set).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 'cmd-1',
      status: 'running',
    }));
  });

  it('marks the job failed and returns the error when dispatch is rejected', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: JOB_ID, status: 'pending' }]));
    const failed = chain([]);
    updateMock.mockReturnValueOnce(failed);
    queueMock.mockResolvedValueOnce({ error: 'Device is offline, cannot execute command' });

    const res = await dispatchTrackedDbRestore(base);

    expect(res).toEqual({ ok: false, error: 'Device is offline, cannot execute command' });
    expect(failed.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(metricMock).toHaveBeenCalledWith('manual_restore', 'device_offline');
  });

  it('marks the job failed when the queue throws', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: JOB_ID, status: 'pending' }]));
    const failed = chain([]);
    updateMock.mockReturnValueOnce(failed);
    queueMock.mockRejectedValueOnce(new Error('redis down'));

    const res = await dispatchTrackedDbRestore(base);

    expect(res).toEqual({ ok: false, error: 'redis down' });
    expect(failed.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('still reports success when linking the command id fails after dispatch', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: JOB_ID, status: 'pending' }]));
    updateMock.mockImplementationOnce(() => { throw new Error('pool exhausted'); });
    queueMock.mockResolvedValueOnce({ command: { id: 'cmd-1', status: 'sent' } });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await dispatchTrackedDbRestore(base);

    expect(res).toEqual({ ok: true, command: { id: 'cmd-1', status: 'sent' }, restoreJobId: JOB_ID });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining(`${JOB_ID} to command cmd-1`), expect.anything());
    errSpy.mockRestore();
  });

  it('returns the original dispatch error even if marking the job failed throws', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: JOB_ID, status: 'pending' }]));
    updateMock.mockImplementationOnce(() => { throw new Error('db down'); });
    queueMock.mockResolvedValueOnce({ error: 'Device is offline, cannot execute command' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await dispatchTrackedDbRestore(base);

    expect(res).toEqual({ ok: false, error: 'Device is offline, cannot execute command' });
    errSpy.mockRestore();
  });

  it('keeps the job pending (no startedAt) when the command is queued but not yet sent', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: JOB_ID, status: 'pending' }]));
    const linked = chain([{ id: JOB_ID }]);
    updateMock.mockReturnValueOnce(linked);
    queueMock.mockResolvedValueOnce({ command: { id: 'cmd-2', status: 'pending' } });

    await dispatchTrackedDbRestore(base);

    expect(linked.set).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 'cmd-2', status: 'pending', startedAt: null,
    }));
  });

  it('fails without dispatching when the restore job row cannot be created', async () => {
    insertMock.mockReturnValueOnce(chain([]));

    const res = await dispatchTrackedDbRestore(base);

    expect(res).toEqual({ ok: false, error: 'Failed to create restore job' });
    expect(queueMock).not.toHaveBeenCalled();
  });
});
