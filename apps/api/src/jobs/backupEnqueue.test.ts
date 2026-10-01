import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock, closeMock, getJobMock } = vi.hoisted(() => ({
  addMock: vi.fn(),
  closeMock: vi.fn(),
  getJobMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = addMock;
    close = closeMock;
    getJob = getJobMock;
  }
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

const { dbSelectMock } = vi.hoisted(() => ({ dbSelectMock: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: dbSelectMock },
  assertOutsideHeldDbContext: vi.fn(),
}));
vi.mock('../db/schema', () => ({ backupConfigs: { id: 'id', approvalGeneration: 'approvalGeneration' } }));

import type { z } from 'zod';
import {
  closeBackupQueue,
  enqueueBackupDispatch,
  enqueueBackupDispatchCapabilityWait,
  enqueueBackupResults,
  removeQueuedBackupDispatch,
} from './backupEnqueue';
import { backupProcessResultSchema } from './queueSchemas';

describe('backup enqueue helpers', () => {
  beforeEach(async () => {
    addMock.mockReset();
    closeMock.mockReset();
    dbSelectMock.mockReset();
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    dbSelectMock.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ approvalGeneration: 4 }]) }) }),
    });
    await closeBackupQueue();
  });

  it('uses a stable BullMQ job id for backup dispatch', async () => {
    await enqueueBackupDispatch('job-123', 'cfg-1', 'org-1', 'dev-1');

    expect(addMock).toHaveBeenCalledWith(
      'dispatch-backup',
      expect.objectContaining({ jobId: 'job-123' }),
      expect.objectContaining({ jobId: 'backup-dispatch-job-123' }),
    );
  });

  it('snapshots the config approval_generation onto the dispatch payload (site-ceiling gate contract §3)', async () => {
    await enqueueBackupDispatch('job-123', 'cfg-1', 'org-1', 'dev-1');

    expect(addMock).toHaveBeenCalledWith(
      'dispatch-backup',
      expect.objectContaining({ configId: 'cfg-1', configGeneration: 4 }),
      expect.anything(),
    );
  });

  it('uses a stable BullMQ job id for backup result processing', async () => {
    await enqueueBackupResults('job-123', 'org-1', 'dev-1', { status: 'completed' });

    expect(addMock).toHaveBeenCalledWith(
      'process-results',
      expect.objectContaining({ jobId: 'job-123' }),
      expect.objectContaining({ jobId: 'backup-result-job-123' }),
    );
  });

  it('rejects malformed backup result payloads before enqueueing', async () => {
    await expect(
      enqueueBackupResults('job-123', 'org-1', 'dev-1', { status: '' }),
    ).rejects.toThrow();

    expect(addMock).not.toHaveBeenCalled();
  });

  // #4137: dispatch-backup is NOT idempotent — Phase 3 of processDispatchBackup
  // INSERTs a fresh `backup_jobs` child row per extra target on every run, so a
  // BullMQ retry after a Phase-4/5 failure leaves the previous attempt's
  // children orphaned at status='running' forever. It must be a one-shot.
  it('enqueues dispatch-backup with attempts:1 and no backoff (non-idempotent one-shot, #4137)', async () => {
    await enqueueBackupDispatch('job-123', 'cfg-1', 'org-1', 'dev-1');

    const opts = addMock.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts.attempts).toBe(1);
    expect(opts.backoff).toBeUndefined();
  });

  // process-results IS safely retryable (it re-applies the same agent payload
  // to the same job row) and genuinely benefits from retry on a transient DB
  // blip — it must keep the retrying options the dispatch path gives up.
  it('keeps attempts:3 + exponential backoff for process-results', async () => {
    await enqueueBackupResults('job-123', 'org-1', 'dev-1', { status: 'completed' });

    const opts = addMock.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts.attempts).toBe(3);
    expect(opts.backoff).toEqual({ type: 'exponential', delay: 1_000 });
  });

  // D18 W01 (#5429/§3.1): baseSnapshotId/formatVersion/backupIdentity must
  // survive the enqueueBackupResults -> backupQueueJobDataSchema.parse round
  // trip -- both backupSnapshotSummarySchema (queueSchemas.ts) and
  // ProcessResultsResult.snapshot (backupEnqueue.ts) were widened to declare
  // them; a regression here would silently strip/reject the lineage fields
  // before backupWorker.ts's process-results handler ever sees them.
  it('round-trips baseSnapshotId/formatVersion/backupIdentity through enqueueBackupResults', async () => {
    await enqueueBackupResults('job-1', 'org-1', 'device-1', {
      status: 'completed',
      snapshotId: 'snap-1',
      snapshot: { id: 'snap-1', baseSnapshotId: 'snap-0', formatVersion: 2, backupIdentity: 's3::e::b' },
    });

    const payload = addMock.mock.calls[0]![1] as { result: { snapshot?: Record<string, unknown> } };
    expect(payload.result.snapshot?.baseSnapshotId).toBe('snap-0');
    expect(payload.result.snapshot?.formatVersion).toBe(2);
    expect(payload.result.snapshot?.backupIdentity).toBe('s3::e::b');
  });
});

describe('waiting for a device to report its backup helper protocols', () => {
  const DATA = {
    type: 'dispatch-backup' as const, jobId: 'job-123', configId: 'cfg-1', orgId: 'org-1', deviceId: 'dev-1', configGeneration: 7,
  };
  const SINCE = '2026-09-29T10:00:00.000Z';

  beforeEach(async () => {
    addMock.mockReset();
    getJobMock.mockReset();
    dbSelectMock.mockReset();
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    await closeBackupQueue();
  });

  it('re-queues the same dispatch, delayed, under a fresh id per check, without re-reading the config generation', async () => {
    await enqueueBackupDispatchCapabilityWait(DATA, { attempt: 3, since: SINCE }, 15_000);

    expect(dbSelectMock).not.toHaveBeenCalled();
    expect(addMock).toHaveBeenCalledWith(
      'dispatch-backup',
      expect.objectContaining({
        jobId: 'job-123', configGeneration: 7, capabilityWaitAttempt: 3, capabilityWaitSince: SINCE,
      }),
      expect.objectContaining({ jobId: 'backup-dispatch-job-123-capability-wait-3', delay: 15_000, attempts: 1 }),
    );
  });

  it('cancelling a waiting backup removes whichever check is queued', async () => {
    const remove = vi.fn();
    getJobMock.mockImplementation(async (id: string) =>
      id === 'backup-dispatch-job-123-capability-wait-4' ? { getState: async () => 'delayed', remove } : undefined);

    await expect(removeQueuedBackupDispatch('job-123')).resolves.toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('still removes a dispatch that never waited', async () => {
    const remove = vi.fn();
    getJobMock.mockImplementation(async (id: string) =>
      id === 'backup-dispatch-job-123' ? { getState: async () => 'waiting', remove } : undefined);

    await expect(removeQueuedBackupDispatch('job-123')).resolves.toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

// #7466: the backup helper's Hyper-V export always sends a `warning` key, set to
// the warning list joined with newlines — so a clean run reports `warning: ""`.
// The ingress schema (routes/backup/resultSchemas.ts) accepts that, but the
// strict queue schema declares `warning` as a non-empty optional string, so the
// enqueue threw and every clean worker-dispatched Hyper-V backup ended `failed`
// with no snapshot. A blank optional string means "not reported" and must be
// treated as absent at the queue handoff, where helpers already in the field
// are covered without an agent release.
describe('enqueueBackupResults blank optional strings (#7466)', () => {
  beforeEach(async () => {
    addMock.mockReset();
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    await closeBackupQueue();
  });

  // Shaped exactly like agentWs.ts builds it from a clean Hyper-V export.
  const cleanHypervResult = (warning: string) => ({
    status: 'completed',
    snapshotId: 'hyperv-accounting-vm-20260929',
    filesBackedUp: 3,
    bytesBackedUp: 4096,
    warning,
    backupType: 'application' as const,
    metadata: {
      backupKind: 'hyperv_export',
      vmName: 'Accounting VM',
      consistencyType: 'application',
      warnings: [],
    },
    snapshot: {
      id: 'hyperv-accounting-vm-20260929',
      timestamp: '2026-09-29T12:00:00Z',
      size: 4096,
      files: [{
        sourcePath: 'Accounting VM/Virtual Hard Disks/disk.vhdx',
        backupPath: 'snapshots/hyperv-accounting-vm-20260929/files/Accounting VM/Virtual Hard Disks/disk.vhdx',
        size: 4096,
        modTime: '2026-09-29T11:59:00Z',
      }],
    },
  });

  const enqueuedResult = (): Record<string, unknown> =>
    (addMock.mock.calls[0]![1] as { result: Record<string, unknown> }).result;

  it('enqueues a clean Hyper-V result whose helper reported warning: ""', async () => {
    await expect(
      enqueueBackupResults('job-1', 'org-1', 'dev-1', cleanHypervResult('')),
    ).resolves.toBe('queue-job-1');

    const result = enqueuedResult();
    expect(result).not.toHaveProperty('warning');
    expect(result.status).toBe('completed');
    expect(result.snapshotId).toBe('hyperv-accounting-vm-20260929');
    expect((result.snapshot as { id: string }).id).toBe('hyperv-accounting-vm-20260929');
  });

  it('treats a whitespace-only warning as absent', async () => {
    await enqueueBackupResults('job-1', 'org-1', 'dev-1', cleanHypervResult(' \n\t'));

    expect(enqueuedResult()).not.toHaveProperty('warning');
  });

  it('keeps a real warning verbatim', async () => {
    const warning = 'free-space preflight skipped: access denied\nVM was running; exported a checkpoint';
    await enqueueBackupResults('job-1', 'org-1', 'dev-1', cleanHypervResult(warning));

    expect(enqueuedResult().warning).toBe(warning);
  });

  it('does not mutate the caller\'s result object', async () => {
    const input = cleanHypervResult('');
    await enqueueBackupResults('job-1', 'org-1', 'dev-1', input);

    expect(input).toHaveProperty('warning', '');
  });

  // The server-derived outer status is required, not optional: a blank one is
  // a server bug and must still be refused loudly, not normalised away.
  it('still rejects a blank required status', async () => {
    await expect(
      enqueueBackupResults('job-1', 'org-1', 'dev-1', { ...cleanHypervResult(''), status: '' }),
    ).rejects.toThrow();
    expect(addMock).not.toHaveBeenCalled();
  });

  // Completeness: EVERY optional non-empty-string field on the strict queue
  // schema gets the same treatment, discovered from the schema itself, so a
  // field added later with `z.string().min(1).optional()` cannot reintroduce
  // this failure for a helper that reports it blank.
  it('treats a blank value as absent for every optional non-empty-string field of the queue schema', async () => {
    const shape = backupProcessResultSchema.shape as Record<string, z.ZodType>;
    const optionalNonEmptyStringKeys = Object.keys(shape).filter((key) => {
      const field = shape[key]!;
      return field.safeParse(undefined).success
        && field.safeParse('x').success
        && !field.safeParse('').success;
    });
    // Sanity-check the probe so this cannot pass as an empty loop.
    expect(optionalNonEmptyStringKeys).toEqual(expect.arrayContaining(['warning', 'error', 'agentStatus', 'snapshotId']));

    for (const key of optionalNonEmptyStringKeys) {
      for (const blank of ['', '   ']) {
        addMock.mockClear();
        await expect(
          enqueueBackupResults('job-1', 'org-1', 'dev-1', { status: 'completed', [key]: blank }),
          `${key}: ${JSON.stringify(blank)} must be treated as absent, not rejected`,
        ).resolves.toBe('queue-job-1');
        expect(enqueuedResult(), key).not.toHaveProperty(key);
      }
    }
  });
});
