import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  closeMock: vi.fn(),
  processorRef: undefined as any,
  processorRefs: {} as Record<string, any>,
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = shared.getJobMock;
    add = shared.addMock;
    close = shared.closeMock;
  },
  Worker: class {
    close = shared.closeMock;
    constructor(name: string, processor: unknown) {
      shared.processorRefs[name] = processor;
      if (!shared.processorRef) {
        shared.processorRef = processor;
      }
    }
  },
  Job: class {},
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
  withSystemDbAccessContext: undefined,
}));

vi.mock('../db/schema', () => ({
  patchJobs: {
    id: 'patchJobs.id',
    status: 'patchJobs.status',
    orgId: 'patchJobs.orgId',
    patches: 'patchJobs.patches',
    targets: 'patchJobs.targets',
    devicesFailed: 'patchJobs.devicesFailed',
    devicesPending: 'patchJobs.devicesPending',
    scheduledAt: 'patchJobs.scheduledAt',
    createdAt: 'patchJobs.createdAt',
  },
  patchJobResults: {},
  patches: {
    id: 'patches.id',
    source: 'patches.source',
    externalId: 'patches.externalId',
    title: 'patches.title',
  },
  patchPolicies: {
    deferralDays: 'patchPolicies.deferralDays',
    id: 'patchPolicies.id',
    kind: 'patchPolicies.kind',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
  },
  deviceCommands: {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/patchApprovalEvaluator', () => ({
  resolveApprovedPatchesForDevice: vi.fn(),
}));

vi.mock('../services/patchRebootHandler', () => ({
  evaluateRebootPolicy: vi.fn(),
  executeReboot: vi.fn(),
}));

vi.mock('../services/commandQueue', () => ({
  queueCommandForExecution: vi.fn(),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

import { db } from '../db';
import { captureException } from '../services/sentry';
import {
  createPatchJobDeviceWorker,
  createPatchJobWorker,
  enqueuePatchJob,
  selectStaleScheduledJobIds,
  filterOrphanedJobIds,
  parseJobCategoryList,
  StaleQueueJobRemovalError,
  PatchDeviceDispatchError,
  PatchCompletionCheckError,
  __testOnly,
} from './patchJobExecutor';
import { resolveApprovedPatchesForDevice } from '../services/patchApprovalEvaluator';
import { queueCommandForExecution } from '../services/commandQueue';
import { evaluateRebootPolicy, executeReboot } from '../services/patchRebootHandler';

function createSelectChain(rows: any[] = []) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  return chain;
}

function createUpdateChain(returnedRows: any[] = []) {
  const chain: any = {};
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(returnedRows));
  return chain;
}

// Select chain whose terminal .where() resolves to the rows (no .limit()) —
// matches selectStaleScheduledJobIds' query shape.
function createWhereSelectChain(rows: any[] = []) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  return chain;
}

describe('patch job executor queueing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shared.processorRef = undefined;
    shared.processorRefs = {};
    shared.getJobMock.mockResolvedValue(null);
    shared.addMock.mockResolvedValue({ id: 'queue-job-1' });
  });

  it('uses a stable BullMQ job id for patch job execution and reuses an active one', async () => {
    shared.getJobMock.mockResolvedValueOnce({
      id: 'existing-job',
      getState: vi.fn().mockResolvedValue('waiting'),
    });

    await enqueuePatchJob('job-1');

    expect(shared.addMock).not.toHaveBeenCalled();

    shared.getJobMock.mockResolvedValueOnce(null);

    await enqueuePatchJob('job-2', 1234);

    expect(shared.addMock).toHaveBeenCalledWith(
      'execute-patch-job',
      { type: 'execute-patch-job', patchJobId: 'job-2' },
      expect.objectContaining({
        jobId: 'patch-job-job-2',
        delay: 1234,
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      }),
    );
  });

  it('claims the scheduled row before fanout and assigns stable per-device/completion job ids', async () => {
    vi.mocked(db.select)
      .mockImplementationOnce(() => createSelectChain([{
        id: 'job-1',
        orgId: 'org-1',
        status: 'scheduled',
        targets: { deviceIds: ['device-1', 'device-2'] },
      }]) as any);
    vi.mocked(db.update)
      .mockImplementationOnce(() => createUpdateChain([{ id: 'job-1' }]) as any);

    shared.getJobMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'existing-device-job',
        getState: vi.fn().mockResolvedValue('active'),
      })
      .mockResolvedValueOnce(null);

    createPatchJobWorker();
    const result = await shared.processorRef({
      data: { type: 'execute-patch-job', patchJobId: 'job-1' },
    });

    expect(shared.addMock).toHaveBeenCalledWith(
      'execute-patch-job-device',
      {
        type: 'execute-patch-job-device',
        patchJobId: 'job-1',
        deviceId: 'device-1',
        orgId: 'org-1',
      },
      {
        jobId: 'patch-job-device-job-1-device-1',
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
    );
    expect(shared.addMock).toHaveBeenCalledWith(
      'check-completion',
      { type: 'check-completion', patchJobId: 'job-1' },
      expect.objectContaining({
        jobId: 'patch-job-completion-job-1',
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 100 },
      }),
    );
    expect(result).toEqual({ dispatched: 2, dispatchFailed: 0 });
  });

  // Regression for "Custom Id cannot contain :" — BullMQ throws when a custom
  // jobId contains a single ':' (it only allows the legacy 3-part repeatable
  // form), which silently stopped scheduled patching from being enqueued
  // (observed daily on EU prod). No enqueued jobId may contain a ':'.
  it('does not use a colon in any enqueued BullMQ job id', async () => {
    // Direct enqueue path
    await enqueuePatchJob('job-2', 1234);

    // Worker fanout path (per-device + completion ids)
    vi.mocked(db.select)
      .mockImplementationOnce(() => createSelectChain([{
        id: 'job-1',
        orgId: 'org-1',
        status: 'scheduled',
        targets: { deviceIds: ['device-1'] },
      }]) as any);
    vi.mocked(db.update)
      .mockImplementationOnce(() => createUpdateChain([{ id: 'job-1' }]) as any);

    createPatchJobWorker();
    await shared.processorRef({
      data: { type: 'execute-patch-job', patchJobId: 'job-1' },
    });

    expect(shared.addMock.mock.calls.length).toBeGreaterThan(0);
    for (const call of shared.addMock.mock.calls) {
      expect(String(call[2].jobId)).not.toContain(':');
    }
  });

  it('skips fanout when another worker already claimed the job row', async () => {
    vi.mocked(db.select)
      .mockImplementationOnce(() => createSelectChain([{
        id: 'job-1',
        orgId: 'org-1',
        status: 'scheduled',
        targets: { deviceIds: ['device-1'] },
      }]) as any);
    vi.mocked(db.update)
      .mockImplementationOnce(() => createUpdateChain([]) as any);

    createPatchJobWorker();
    const result = await shared.processorRef({
      data: { type: 'execute-patch-job', patchJobId: 'job-1' },
    });

    expect(shared.addMock).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true, reason: 'Job was already claimed' });
  });

  it('rejects forged per-device patch jobs with a mismatched queued org', async () => {
    vi.mocked(db.select)
      .mockImplementationOnce(() => createSelectChain([{
        id: 'job-1',
        orgId: 'org-1',
        status: 'running',
        patches: {},
        targets: { deviceIds: ['device-1'] },
      }]) as any);

    createPatchJobDeviceWorker();
    const result = await shared.processorRefs['patch-job-devices']({
      data: {
        type: 'execute-patch-job-device',
        patchJobId: 'job-1',
        deviceId: 'device-1',
        orgId: 'org-2',
      },
    });

    expect(result).toEqual({
      skipped: true,
      reason: 'Queued org does not match patch job org',
    });
    expect(resolveApprovedPatchesForDevice).not.toHaveBeenCalled();
    expect(queueCommandForExecution).not.toHaveBeenCalled();
  });

  it('rejects forged per-device patch jobs for devices outside patch targets', async () => {
    vi.mocked(db.select)
      .mockImplementationOnce(() => createSelectChain([{
        id: 'job-1',
        orgId: 'org-1',
        status: 'running',
        patches: {},
        targets: { deviceIds: ['device-1'] },
      }]) as any);

    createPatchJobDeviceWorker();
    const result = await shared.processorRefs['patch-job-devices']({
      data: {
        type: 'execute-patch-job-device',
        patchJobId: 'job-1',
        deviceId: 'device-2',
        orgId: 'org-1',
      },
    });

    expect(result).toEqual({
      skipped: true,
      reason: 'Device is not targeted by patch job',
    });
    expect(resolveApprovedPatchesForDevice).not.toHaveBeenCalled();
    expect(queueCommandForExecution).not.toHaveBeenCalled();
  });

  it('rejects per-device patch jobs when the target device is not in the patch job org', async () => {
    vi.mocked(db.select)
      .mockImplementationOnce(() => createSelectChain([{
        id: 'job-1',
        orgId: 'org-1',
        status: 'running',
        patches: {},
        targets: { deviceIds: ['device-1'] },
      }]) as any)
      .mockImplementationOnce(() => createSelectChain([]) as any);

    createPatchJobDeviceWorker();
    const result = await shared.processorRefs['patch-job-devices']({
      data: {
        type: 'execute-patch-job-device',
        patchJobId: 'job-1',
        deviceId: 'device-1',
        orgId: 'org-1',
      },
    });

    expect(result).toEqual({
      skipped: true,
      reason: 'Device not found in patch job org',
    });
    expect(resolveApprovedPatchesForDevice).not.toHaveBeenCalled();
    expect(queueCommandForExecution).not.toHaveBeenCalled();
  });

  it('passes the job sources through to the approval evaluator', async () => {
    vi.mocked(db.select)
      // patch job row
      .mockImplementationOnce(() => createSelectChain([{
        id: 'job-1',
        orgId: 'org-1',
        status: 'running',
        patches: { ringId: null, autoApprove: {}, sources: ['third_party'] },
        targets: { deviceIds: ['device-1'] },
      }]) as any)
      // device-in-org check
      .mockImplementationOnce(() => createSelectChain([{ id: 'device-1' }]) as any)
      // checkAndFinalizeJob select (called by markDeviceSkipped)
      .mockImplementationOnce(() => createSelectChain([]) as any);

    // db.insert().values() must be thenable for markDeviceSkipped
    vi.mocked(db.insert).mockImplementationOnce(() => ({
      values: vi.fn(() => Promise.resolve()),
    }) as any);

    // db.update().set().where() must be thenable (no .returning) for markDeviceSkipped
    vi.mocked(db.update).mockImplementationOnce(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    }) as any);

    vi.mocked(resolveApprovedPatchesForDevice).mockResolvedValueOnce([]);

    createPatchJobDeviceWorker();
    const result = await shared.processorRefs['patch-job-devices']({
      data: {
        type: 'execute-patch-job-device',
        patchJobId: 'job-1',
        deviceId: 'device-1',
        orgId: 'org-1',
      },
    });

    expect(resolveApprovedPatchesForDevice).toHaveBeenCalledWith(
      'device-1',
      'org-1',
      expect.objectContaining({ sources: ['third_party'] }),
    );
    expect(result).toEqual({ skipped: true, reason: 'No approved patches' });
  });

  it('threads well-formed policyAutoApprove and apps to the evaluator', async () => {
    vi.mocked(db.select)
      .mockImplementationOnce(() => createSelectChain([{
        id: 'job-1',
        orgId: 'org-1',
        status: 'running',
        patches: {
          ringId: null,
          autoApprove: {},
          categoryRules: [],
          policyAutoApprove: { enabled: true, severities: ['critical'], deferralDays: 3 },
          apps: [{ source: 'third_party', packageId: 'A.B', action: 'block' }],
        },
        targets: { deviceIds: ['device-1'] },
      }]) as any)
      .mockImplementationOnce(() => createSelectChain([{ id: 'device-1' }]) as any)
      .mockImplementationOnce(() => createSelectChain([]) as any);

    vi.mocked(db.insert).mockImplementationOnce(() => ({
      values: vi.fn(() => Promise.resolve()),
    }) as any);
    vi.mocked(db.update).mockImplementationOnce(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
    }) as any);
    vi.mocked(resolveApprovedPatchesForDevice).mockResolvedValueOnce([]);

    createPatchJobDeviceWorker();
    await shared.processorRefs['patch-job-devices']({
      data: {
        type: 'execute-patch-job-device',
        patchJobId: 'job-1',
        deviceId: 'device-1',
        orgId: 'org-1',
      },
    });

    expect(resolveApprovedPatchesForDevice).toHaveBeenCalledWith(
      'device-1',
      'org-1',
      expect.objectContaining({
        policyAutoApprove: { enabled: true, severities: ['critical'], deferralDays: 3 },
        apps: [{ source: 'third_party', packageId: 'A.B', action: 'block' }],
      }),
    );
  });

  it('treats malformed policyAutoApprove as disabled and warns', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.mocked(db.select)
      .mockImplementationOnce(() => createSelectChain([{
        id: 'job-1',
        orgId: 'org-1',
        status: 'running',
        patches: {
          ringId: null,
          autoApprove: {},
          policyAutoApprove: { enabled: 'yes', severities: 'critical' },
        },
        targets: { deviceIds: ['device-1'] },
      }]) as any)
      .mockImplementationOnce(() => createSelectChain([{ id: 'device-1' }]) as any)
      .mockImplementationOnce(() => createSelectChain([]) as any);

    vi.mocked(db.insert).mockImplementationOnce(() => ({
      values: vi.fn(() => Promise.resolve()),
    }) as any);
    vi.mocked(db.update).mockImplementationOnce(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
    }) as any);
    vi.mocked(resolveApprovedPatchesForDevice).mockResolvedValueOnce([]);

    createPatchJobDeviceWorker();
    await shared.processorRefs['patch-job-devices']({
      data: {
        type: 'execute-patch-job-device',
        patchJobId: 'job-1',
        deviceId: 'device-1',
        orgId: 'org-1',
      },
    });

    expect(resolveApprovedPatchesForDevice).toHaveBeenCalledWith(
      'device-1',
      'org-1',
      expect.objectContaining({ policyAutoApprove: undefined }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('malformed patches.policyAutoApprove'),
      expect.any(String),
    );
    expect(captureException).toHaveBeenCalledWith(expect.any(Error));
    warnSpy.mockRestore();
  });

  it('disables the whole policyAutoApprove config when deferralDays is malformed', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.mocked(db.select)
      .mockImplementationOnce(() => createSelectChain([{
        id: 'job-1',
        orgId: 'org-1',
        status: 'running',
        patches: {
          ringId: null,
          autoApprove: {},
          // enabled/severities are valid, but deferralDays is negative — the
          // deferral safety window must NOT be silently coerced to 0.
          policyAutoApprove: { enabled: true, severities: ['critical'], deferralDays: -1 },
        },
        targets: { deviceIds: ['device-1'] },
      }]) as any)
      .mockImplementationOnce(() => createSelectChain([{ id: 'device-1' }]) as any)
      .mockImplementationOnce(() => createSelectChain([]) as any);

    vi.mocked(db.insert).mockImplementationOnce(() => ({
      values: vi.fn(() => Promise.resolve()),
    }) as any);
    vi.mocked(db.update).mockImplementationOnce(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
    }) as any);
    vi.mocked(resolveApprovedPatchesForDevice).mockResolvedValueOnce([]);

    createPatchJobDeviceWorker();
    await shared.processorRefs['patch-job-devices']({
      data: {
        type: 'execute-patch-job-device',
        patchJobId: 'job-1',
        deviceId: 'device-1',
        orgId: 'org-1',
      },
    });

    expect(resolveApprovedPatchesForDevice).toHaveBeenCalledWith(
      'device-1',
      'org-1',
      expect.objectContaining({ policyAutoApprove: undefined }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('malformed patches.policyAutoApprove'),
      expect.any(String),
    );
    expect(captureException).toHaveBeenCalledWith(expect.any(Error));
    warnSpy.mockRestore();
  });

  it('defaults deferralDays to 0 when absent from an otherwise valid policyAutoApprove', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.mocked(db.select)
      .mockImplementationOnce(() => createSelectChain([{
        id: 'job-1',
        orgId: 'org-1',
        status: 'running',
        patches: {
          ringId: null,
          autoApprove: {},
          policyAutoApprove: { enabled: true, severities: ['critical'] },
        },
        targets: { deviceIds: ['device-1'] },
      }]) as any)
      .mockImplementationOnce(() => createSelectChain([{ id: 'device-1' }]) as any)
      .mockImplementationOnce(() => createSelectChain([]) as any);

    vi.mocked(db.insert).mockImplementationOnce(() => ({
      values: vi.fn(() => Promise.resolve()),
    }) as any);
    vi.mocked(db.update).mockImplementationOnce(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
    }) as any);
    vi.mocked(resolveApprovedPatchesForDevice).mockResolvedValueOnce([]);

    createPatchJobDeviceWorker();
    await shared.processorRefs['patch-job-devices']({
      data: {
        type: 'execute-patch-job-device',
        patchJobId: 'job-1',
        deviceId: 'device-1',
        orgId: 'org-1',
      },
    });

    expect(resolveApprovedPatchesForDevice).toHaveBeenCalledWith(
      'device-1',
      'org-1',
      expect.objectContaining({
        policyAutoApprove: { enabled: true, severities: ['critical'], deferralDays: 0 },
      }),
    );
    expect(warnSpy).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('coerces identifiable malformed app rules to block and drops unusable ones', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.mocked(db.select)
      .mockImplementationOnce(() => createSelectChain([{
        id: 'job-1',
        orgId: 'org-1',
        status: 'running',
        patches: {
          ringId: null,
          autoApprove: {},
          apps: [
            // Valid block rule → passed through.
            { source: 'third_party', packageId: 'A.B', action: 'block' },
            // Identity unusable (no packageId) → dropped + Sentry.
            { source: 'third_party', action: 'block' },
            // Identifiable but malformed (pin without pinnedVersion) → coerced to block.
            { source: 'third_party', packageId: 'C.D', action: 'pin' },
          ],
        },
        targets: { deviceIds: ['device-1'] },
      }]) as any)
      .mockImplementationOnce(() => createSelectChain([{ id: 'device-1' }]) as any)
      .mockImplementationOnce(() => createSelectChain([]) as any);

    vi.mocked(db.insert).mockImplementationOnce(() => ({
      values: vi.fn(() => Promise.resolve()),
    }) as any);
    vi.mocked(db.update).mockImplementationOnce(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
    }) as any);
    vi.mocked(resolveApprovedPatchesForDevice).mockResolvedValueOnce([]);

    createPatchJobDeviceWorker();
    await shared.processorRefs['patch-job-devices']({
      data: {
        type: 'execute-patch-job-device',
        patchJobId: 'job-1',
        deviceId: 'device-1',
        orgId: 'org-1',
      },
    });

    expect(resolveApprovedPatchesForDevice).toHaveBeenCalledWith(
      'device-1',
      'org-1',
      expect.objectContaining({
        apps: [
          { source: 'third_party', packageId: 'A.B', action: 'block' },
          { source: 'third_party', packageId: 'C.D', action: 'block' },
        ],
      }),
    );
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('dropping malformed app rule'),
      expect.any(String),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('coercing malformed app rule to block (fail-closed)'),
      expect.any(String),
    );
    // Only the dropped rule goes to Sentry — the coerced one is preserved as a restriction.
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error));
    warnSpy.mockRestore();
  });

  it('ignores non-array apps with a warning and a Sentry capture', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.mocked(db.select)
      .mockImplementationOnce(() => createSelectChain([{
        id: 'job-1',
        orgId: 'org-1',
        status: 'running',
        patches: {
          ringId: null,
          autoApprove: {},
          apps: {},
        },
        targets: { deviceIds: ['device-1'] },
      }]) as any)
      .mockImplementationOnce(() => createSelectChain([{ id: 'device-1' }]) as any)
      .mockImplementationOnce(() => createSelectChain([]) as any);

    vi.mocked(db.insert).mockImplementationOnce(() => ({
      values: vi.fn(() => Promise.resolve()),
    }) as any);
    vi.mocked(db.update).mockImplementationOnce(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
    }) as any);
    vi.mocked(resolveApprovedPatchesForDevice).mockResolvedValueOnce([]);

    createPatchJobDeviceWorker();
    await shared.processorRefs['patch-job-devices']({
      data: {
        type: 'execute-patch-job-device',
        patchJobId: 'job-1',
        deviceId: 'device-1',
        orgId: 'org-1',
      },
    });

    expect(resolveApprovedPatchesForDevice).toHaveBeenCalledWith(
      'device-1',
      'org-1',
      expect.objectContaining({ apps: undefined }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('malformed patches.apps'),
      expect.any(String),
    );
    expect(captureException).toHaveBeenCalledWith(expect.any(Error));
    warnSpy.mockRestore();
  });

  it('leaves policyAutoApprove and apps undefined for legacy jobs', async () => {
    vi.mocked(db.select)
      .mockImplementationOnce(() => createSelectChain([{
        id: 'job-1',
        orgId: 'org-1',
        status: 'running',
        patches: { ringId: null, autoApprove: {} },
        targets: { deviceIds: ['device-1'] },
      }]) as any)
      .mockImplementationOnce(() => createSelectChain([{ id: 'device-1' }]) as any)
      .mockImplementationOnce(() => createSelectChain([]) as any);

    vi.mocked(db.insert).mockImplementationOnce(() => ({
      values: vi.fn(() => Promise.resolve()),
    }) as any);
    vi.mocked(db.update).mockImplementationOnce(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
    }) as any);
    vi.mocked(resolveApprovedPatchesForDevice).mockResolvedValueOnce([]);

    createPatchJobDeviceWorker();
    await shared.processorRefs['patch-job-devices']({
      data: {
        type: 'execute-patch-job-device',
        patchJobId: 'job-1',
        deviceId: 'device-1',
        orgId: 'org-1',
      },
    });

    expect(resolveApprovedPatchesForDevice).toHaveBeenCalledWith(
      'device-1',
      'org-1',
      expect.objectContaining({ policyAutoApprove: undefined, apps: undefined }),
    );
  });

  it('skips malformed sources with a warning instead of widening the filter', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.mocked(db.select)
      .mockImplementationOnce(() => createSelectChain([{
        id: 'job-1',
        orgId: 'org-1',
        status: 'running',
        patches: { ringId: null, autoApprove: {}, sources: [42, null] },
        targets: { deviceIds: ['device-1'] },
      }]) as any)
      .mockImplementationOnce(() => createSelectChain([{ id: 'device-1' }]) as any)
      // checkAndFinalizeJob select (called by markDeviceSkipped)
      .mockImplementationOnce(() => createSelectChain([]) as any);

    // db.insert().values() must be thenable for markDeviceSkipped
    vi.mocked(db.insert).mockImplementationOnce(() => ({
      values: vi.fn(() => Promise.resolve()),
    }) as any);

    // db.update().set().where() must be thenable (no .returning) for markDeviceSkipped
    vi.mocked(db.update).mockImplementationOnce(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    }) as any);

    createPatchJobDeviceWorker();
    const result = await shared.processorRefs['patch-job-devices']({
      data: {
        type: 'execute-patch-job-device',
        patchJobId: 'job-1',
        deviceId: 'device-1',
        orgId: 'org-1',
      },
    });

    expect(result).toEqual({ skipped: true, reason: 'Invalid patch source filter' });
    expect(resolveApprovedPatchesForDevice).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('malformed patches.sources'),
      expect.any(String),
    );
    expect(captureException).toHaveBeenCalledWith(expect.any(Error));
    warnSpy.mockRestore();
  });
});

describe('orphaned scheduled-job reconcile (#1733)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The wedged-id dedup set is module-level (the executor is a process
    // singleton), so it must be cleared between cases.
    __testOnly.resetWedgedJobReporting();
    shared.getJobMock.mockResolvedValue(null);
    shared.addMock.mockResolvedValue({ id: 'queue-job-1' });
  });

  it('selectStaleScheduledJobIds returns id + scheduledAt of stale scheduled rows', async () => {
    const sched = new Date('2026-06-21T08:00:00Z');
    vi.mocked(db.select).mockImplementationOnce(
      () => createWhereSelectChain([
        { id: 'job-a', scheduledAt: sched },
        { id: 'job-b', scheduledAt: null },
      ]) as any,
    );

    const jobs = await selectStaleScheduledJobIds(new Date('2026-06-21T09:00:00Z'));

    expect(jobs).toEqual([
      { id: 'job-a', scheduledAt: sched },
      { id: 'job-b', scheduledAt: null },
    ]);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('filterOrphanedJobIds keeps only jobs with no active queue job (carrying scheduledAt)', async () => {
    // job-a has an active (waiting) queue job → already enqueued, drop it.
    // job-b has no queue job → orphaned, keep it (with its scheduledAt).
    shared.getJobMock.mockImplementation(async (id: string) =>
      id === 'patch-job-job-a'
        ? { id, getState: vi.fn().mockResolvedValue('waiting'), remove: vi.fn() }
        : null,
    );

    const sched = new Date('2026-06-21T08:00:00Z');
    const orphaned = await filterOrphanedJobIds([
      { id: 'job-a', scheduledAt: null },
      { id: 'job-b', scheduledAt: sched },
    ]);

    expect(orphaned).toEqual([{ id: 'job-b', scheduledAt: sched }]);
  });

  it('filterOrphanedJobIds treats a completed queue job as not active (orphan recoverable)', async () => {
    // A stable jobId left over as completed must NOT block recovery — the row is
    // still status='scheduled', so the run never actually executed.
    const removeMock = vi.fn().mockResolvedValue(undefined);
    shared.getJobMock.mockResolvedValue({
      id: 'patch-job-job-c',
      getState: vi.fn().mockResolvedValue('completed'),
      remove: removeMock,
    });

    const orphaned = await filterOrphanedJobIds([{ id: 'job-c', scheduledAt: null }]);

    expect(orphaned).toEqual([{ id: 'job-c', scheduledAt: null }]);
    expect(removeMock).toHaveBeenCalled();
  });

  it('filterOrphanedJobIds short-circuits on an empty list', async () => {
    const orphaned = await filterOrphanedJobIds([]);
    expect(orphaned).toEqual([]);
    expect(shared.getJobMock).not.toHaveBeenCalled();
  });

  // BREEZE-1A. `queue.add({ jobId })` is a silent no-op when the job hash still
  // exists, so "this id is free" has to be true or the recovery does nothing
  // while reporting success — one identical Sentry event per 60s scan forever.
  it('clears a queue job stuck in the unknown state so the id is actually free', async () => {
    // 'unknown' = the hash exists but the job is in no list. It is not reusable
    // and it is not completed/failed, so the old code left it in place and then
    // re-added onto the occupied id.
    const removeMock = vi.fn().mockResolvedValue(undefined);
    shared.getJobMock.mockResolvedValue({
      id: 'patch-job-job-u',
      getState: vi.fn().mockResolvedValue('unknown'),
      remove: removeMock,
    });

    const orphaned = await filterOrphanedJobIds([{ id: 'job-u', scheduledAt: null }]);

    expect(removeMock).toHaveBeenCalled();
    expect(orphaned).toEqual([{ id: 'job-u', scheduledAt: null }]);
  });

  it('refuses to report an id as free when the stale job could not be removed', async () => {
    // Re-adding onto an id we could not clear is the silent no-op the helper
    // exists to prevent, so a wedged id is surfaced and SKIPPED — never handed
    // back as recoverable — while the rest of the batch still recovers.
    shared.getJobMock.mockImplementation(async (id: string) =>
      id === 'patch-job-job-x'
        ? {
            id,
            // Still terminal after the failed removal → the id remains occupied.
            getState: vi.fn().mockResolvedValue('failed'),
            remove: vi.fn().mockRejectedValue(new Error('WRONGTYPE')),
          }
        : null,
    );

    const orphaned = await filterOrphanedJobIds([
      { id: 'job-x', scheduledAt: null },
      { id: 'job-ok', scheduledAt: null },
    ]);

    expect(orphaned).toEqual([{ id: 'job-ok', scheduledAt: null }]);
    // Named so the report survives Sentry's scrubber, and carrying the original
    // driver error as its cause.
    const reported = vi.mocked(captureException).mock.calls[0]?.[0] as Error;
    expect(reported).toBeInstanceOf(StaleQueueJobRemovalError);
    expect(reported.message).toContain('job-x');
    expect((reported as Error & { cause?: Error }).cause).toEqual(new Error('WRONGTYPE'));
  });

  it('does not re-add onto an occupied id when removal fails (the silent no-op path)', async () => {
    shared.getJobMock.mockResolvedValue({
      id: 'patch-job-job-x',
      getState: vi.fn().mockResolvedValue('completed'),
      remove: vi.fn().mockRejectedValue(new Error('Could not remove job')),
    });

    await expect(enqueuePatchJob('job-x')).rejects.toThrow(StaleQueueJobRemovalError);
    // The old behaviour swallowed the removal failure and called add(), which
    // BullMQ silently dropped because the hash was still there.
    expect(shared.addMock).not.toHaveBeenCalled();
  });

  it('reuses a job that raced back into the queue while it was being removed', async () => {
    // BullMQ refuses to remove a locked/active job. That outcome is correct —
    // the run is happening — so it must be reported as reusable, not as a fault.
    const getState = vi.fn()
      .mockResolvedValueOnce('completed')
      .mockResolvedValueOnce('active');
    shared.getJobMock.mockResolvedValue({
      id: 'patch-job-job-r',
      getState,
      remove: vi.fn().mockRejectedValue(new Error('job is locked')),
    });

    const orphaned = await filterOrphanedJobIds([{ id: 'job-r', scheduledAt: null }]);

    expect(orphaned).toEqual([]);
    expect(getState).toHaveBeenCalledTimes(2);
  });
});

// The claim UPDATE flips patch_jobs.status to 'running' BEFORE any of this
// runs. The orchestration queue sets no `attempts`, a manual retry re-runs the
// claim against `status='scheduled'` and matches 0 rows, and the #1733 sweep
// only scans `scheduled` rows — so an error escaping the fan-out strands the
// whole run in `running` forever: no devices dispatched, no completion checker,
// no visible failure. resolveActiveQueueJob now THROWS where it used to
// console.error, which is what made these two call sites load-bearing.
describe('patch job fanout survives one wedged queue id', () => {
  function thenableChain(result: unknown = undefined) {
    const c: any = {};
    c.set = vi.fn(() => c);
    c.values = vi.fn(() => Promise.resolve(result));
    c.where = vi.fn(() => Promise.resolve(result));
    return c;
  }

  /** A queue job whose hash cannot be cleared → resolveActiveQueueJob throws. */
  function wedgedJob(id: string) {
    return {
      id,
      getState: vi.fn().mockResolvedValue('failed'),
      remove: vi.fn().mockRejectedValue(new Error('WRONGTYPE')),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    shared.processorRef = undefined;
    shared.processorRefs = {};
    shared.getJobMock.mockResolvedValue(null);
    shared.addMock.mockResolvedValue({ id: 'queue-job-1' });
    __testOnly.resetWedgedJobReporting();
  });

  function primeRunningJob(deviceIds: string[], finalizeRow: any[] = [
    { status: 'running', devicesPending: deviceIds.length, devicesFailed: 1 },
  ]) {
    vi.mocked(db.select)
      .mockImplementationOnce(() => createSelectChain([{
        id: 'job-1',
        orgId: 'org-1',
        status: 'scheduled',
        targets: { deviceIds },
      }]) as any)
      // checkAndFinalizeJob, reached via the dispatch-failure bookkeeping
      .mockImplementation(() => createSelectChain(finalizeRow) as any);
    vi.mocked(db.update)
      .mockImplementationOnce(() => createUpdateChain([{ id: 'job-1' }]) as any)
      .mockImplementation(() => thenableChain() as any);
    vi.mocked(db.insert).mockImplementation(() => thenableChain() as any);
  }

  it('dispatches every other device when one device id cannot be cleared', async () => {
    primeRunningJob(['device-1', 'device-2', 'device-3']);
    shared.getJobMock.mockImplementation(async (id: string) =>
      id === 'patch-job-device-job-1-device-2' ? wedgedJob(id) : null,
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    createPatchJobWorker();
    const result = await shared.processorRef({
      data: { type: 'execute-patch-job', patchJobId: 'job-1' },
    });

    // Devices 1 and 3 were dispatched — before the guard, device-2's throw
    // escaped and neither device-3 nor the completion checker was ever queued.
    const deviceIds = shared.addMock.mock.calls
      .filter(([name]: any[]) => name === 'execute-patch-job-device')
      .map(([, data]: any[]) => data.deviceId);
    expect(deviceIds).toEqual(['device-1', 'device-3']);
    expect(result).toEqual({ dispatched: 2, dispatchFailed: 1 });
    consoleSpy.mockRestore();
  });

  it('still schedules the completion checker after a device dispatch failure', async () => {
    primeRunningJob(['device-1', 'device-2']);
    shared.getJobMock.mockImplementation(async (id: string) =>
      id === 'patch-job-device-job-1-device-1' ? wedgedJob(id) : null,
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    createPatchJobWorker();
    await shared.processorRef({ data: { type: 'execute-patch-job', patchJobId: 'job-1' } });

    expect(shared.addMock).toHaveBeenCalledWith(
      'check-completion',
      { type: 'check-completion', patchJobId: 'job-1' },
      expect.objectContaining({ jobId: 'patch-job-completion-job-1' }),
    );
    consoleSpy.mockRestore();
  });

  it('records an undispatchable device as failed so the run can still finalize', async () => {
    primeRunningJob(['device-1']);
    shared.getJobMock.mockImplementation(async (id: string) =>
      id === 'patch-job-device-job-1-device-1' ? wedgedJob(id) : null,
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    createPatchJobWorker();
    await shared.processorRef({ data: { type: 'execute-patch-job', patchJobId: 'job-1' } });

    // Without this the device's devicesPending slot never drains and only the
    // 35-minute checker could ever end the run. 'failed', not 'skipped':
    // markDeviceSkipped counts toward devicesCompleted, which would let a run
    // that never dispatched finish green.
    const inserted = vi.mocked(db.insert).mock.results[0]?.value as any;
    expect(inserted.values).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'device-1', status: 'failed' }),
    );
    const reported = vi.mocked(captureException).mock.calls
      .map(([err]) => err)
      .find((err) => err instanceof PatchDeviceDispatchError) as Error;
    expect(reported).toBeInstanceOf(PatchDeviceDispatchError);
    expect(reported.message).toContain('1 of 1');
    consoleSpy.mockRestore();
  });

  it('falls back to a unique completion-check id when the stable one is wedged', async () => {
    primeRunningJob(['device-1']);
    shared.getJobMock.mockImplementation(async (id: string) =>
      id === 'patch-job-completion-job-1' ? wedgedJob(id) : null,
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    createPatchJobWorker();
    const result = await shared.processorRef({
      data: { type: 'execute-patch-job', patchJobId: 'job-1' },
    });

    // Re-adding the stable id would be a silent no-op, so the row would sit in
    // `running` with nothing able to time it out. A duplicate checker is
    // harmless (processCheckCompletion re-reads the row); no checker is not.
    const completionCall = shared.addMock.mock.calls.find(
      ([name]: any[]) => name === 'check-completion',
    );
    expect(String(completionCall?.[2].jobId)).toMatch(/^patch-job-completion-job-1-retry-\d+$/);
    expect(result).toEqual({ dispatched: 1, dispatchFailed: 0 });
    const reported = vi.mocked(captureException).mock.calls
      .map(([err]) => err)
      .find((err) => err instanceof PatchCompletionCheckError) as Error;
    expect(reported).toBeInstanceOf(PatchCompletionCheckError);
    consoleSpy.mockRestore();
  });

  it('reports — and does not throw — when no completion check can be scheduled at all', async () => {
    primeRunningJob(['device-1']);
    shared.getJobMock.mockImplementation(async (id: string) =>
      id === 'patch-job-completion-job-1' ? wedgedJob(id) : null,
    );
    shared.addMock.mockImplementation(async (name: string) => {
      if (name === 'check-completion') throw new Error('redis down');
      return { id: 'queue-job-1' };
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    createPatchJobWorker();
    // An escaping throw here is the unrecoverable case: the row is already
    // `running`, so nothing retries it and nothing sweeps it.
    const result = await shared.processorRef({
      data: { type: 'execute-patch-job', patchJobId: 'job-1' },
    });

    expect(result).toEqual({ dispatched: 1, dispatchFailed: 0 });
    expect(captureException).toHaveBeenCalledWith(
      expect.any(PatchCompletionCheckError),
      undefined,
      { patch_reconcile_stage: 'completion_check_lost' },
    );
    consoleSpy.mockRestore();
  });
});

// BREEZE-1A, second time: a wedged id is persistent BY DEFINITION (nothing
// clears the hash that resolveActiveQueueJob just failed to clear), the
// scheduler sweeps every 60s and selectStaleScheduledJobIds keeps selecting the
// row for 45 days — up to ~64,800 error events for ONE job, all collapsing into
// a single issue because the scrubber deletes the message. The issue this whole
// change set exists to fix was 342 events.
describe('wedged reconcile ids report once per episode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shared.getJobMock.mockResolvedValue(null);
    __testOnly.resetWedgedJobReporting();
  });

  function wedged() {
    return {
      id: 'patch-job-job-x',
      getState: vi.fn().mockResolvedValue('failed'),
      remove: vi.fn().mockRejectedValue(new Error('WRONGTYPE')),
    };
  }

  it('reports a persistently wedged id once across many sweeps', async () => {
    shared.getJobMock.mockImplementation(async (id: string) =>
      id === 'patch-job-job-x' ? wedged() : null,
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    for (let sweep = 0; sweep < 20; sweep += 1) {
      await filterOrphanedJobIds([{ id: 'job-x', scheduledAt: null }]);
    }

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureException).mock.calls[0]?.[2]).toEqual({
      patch_reconcile_stage: 'wedged',
    });
    // Still visible every sweep in the logs — only the Sentry event is gated.
    expect(consoleSpy.mock.calls.length).toBe(20);
    consoleSpy.mockRestore();
  });

  it('reports again after the id clears and wedges a second time', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    shared.getJobMock.mockImplementation(async (id: string) =>
      id === 'patch-job-job-x' ? wedged() : null,
    );
    await filterOrphanedJobIds([{ id: 'job-x', scheduledAt: null }]);
    await filterOrphanedJobIds([{ id: 'job-x', scheduledAt: null }]);

    // Episode over: the id resolves cleanly (nothing occupying it).
    shared.getJobMock.mockResolvedValue(null);
    await filterOrphanedJobIds([{ id: 'job-x', scheduledAt: null }]);

    shared.getJobMock.mockImplementation(async (id: string) =>
      id === 'patch-job-job-x' ? wedged() : null,
    );
    await filterOrphanedJobIds([{ id: 'job-x', scheduledAt: null }]);

    expect(captureException).toHaveBeenCalledTimes(2);
    consoleSpy.mockRestore();
  });

  it('does not let one wedged id suppress the report for a different one', async () => {
    shared.getJobMock.mockImplementation(async (id: string) =>
      id === 'patch-job-job-x' || id === 'patch-job-job-y' ? wedged() : null,
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await filterOrphanedJobIds([
      { id: 'job-x', scheduledAt: null },
      { id: 'job-y', scheduledAt: null },
    ]);
    await filterOrphanedJobIds([
      { id: 'job-x', scheduledAt: null },
      { id: 'job-y', scheduledAt: null },
    ]);

    expect(captureException).toHaveBeenCalledTimes(2);
    consoleSpy.mockRestore();
  });
});

describe('parseJobCategoryList (#2117 category filter fail-closed parse)', () => {
  it('returns undefined for an absent field (legacy job → no filtering)', () => {
    expect(parseJobCategoryList(undefined)).toBeUndefined();
  });

  it('returns the string list for a valid array, dropping blanks', () => {
    expect(parseJobCategoryList(['driver', 'feature'])).toEqual(['driver', 'feature']);
    expect(parseJobCategoryList(['driver', '', '  '])).toEqual(['driver', '  ']);
    expect(parseJobCategoryList([])).toEqual([]);
  });

  it('returns null (malformed → caller fails closed) for a non-array value', () => {
    expect(parseJobCategoryList('driver')).toBeNull();
    expect(parseJobCategoryList({ 0: 'driver' })).toBeNull();
    expect(parseJobCategoryList(null)).toBeNull();
  });

  it('returns null when an array carries a non-string entry', () => {
    expect(parseJobCategoryList(['driver', 42])).toBeNull();
    expect(parseJobCategoryList([{ category: 'driver' }])).toBeNull();
  });
});

// ============================================================================
// #4228 — post-patch reboot policy on a partially failed job
// ============================================================================

type AgentPatchEntry = {
  id: string;
  externalId: string;
  status: 'installed' | 'failed' | 'rolled_back';
  rebootRequired?: boolean;
  error?: string;
};

/**
 * Builds the command row exactly as a Windows agent produces it.
 *
 * The shape is load-bearing for #4228: `executePatchInstallCommand`
 * (agent/internal/heartbeat/heartbeat.go) returns `Status: "failed"` /
 * `ExitCode: 1` the moment ONE patch fails, while still emitting the full
 * install summary on stdout — so `rebootRequired: true` and
 * `installedCount > 0` arrive on a command the server reads as failed. Anything
 * keyed off overall success therefore misses the reboot the successful installs
 * need.
 */
function agentCommandRow(summary: {
  success: boolean;
  installedCount: number;
  failedCount: number;
  rebootRequired: boolean;
  results: AgentPatchEntry[];
}) {
  return {
    status: summary.failedCount > 0 ? 'failed' : 'completed',
    result: {
      stdout: JSON.stringify(summary),
      exitCode: summary.failedCount > 0 ? 1 : 0,
      error: summary.failedCount > 0 ? `${summary.failedCount} patch operations failed` : undefined,
    },
  };
}

/**
 * Drives the real per-device worker processor end to end (prepare → poll →
 * record) so the reboot decision is exercised through the shipped code path
 * rather than a hand-called internal.
 */
async function runDeviceExecution(opts: {
  approvedPatches: Array<{ patchId: string; externalId: string; requiresReboot: boolean }>;
  rebootPolicy?: string;
  command: { status: string; result: unknown } | null;
  /** When provided, every `patchJobResults.values(...)` call is pushed here
   *  (#4267 — asserting the per-row status the executor actually wrote). */
  insertedRows?: any[];
}) {
  const { approvedPatches, rebootPolicy = 'if_required', command, insertedRows } = opts;

  vi.mocked(db.select)
    // 1. patch job row
    .mockImplementationOnce(() => createSelectChain([{
      id: 'job-1',
      orgId: 'org-1',
      status: 'running',
      patches: { ringId: null, autoApprove: {} },
      targets: { deviceIds: ['device-1'], deployment: { rebootPolicy } },
    }]) as any)
    // 2. device-in-org check
    .mockImplementationOnce(() => createSelectChain([{ id: 'device-1' }]) as any)
    // 3. patch records for the install command (terminal .where(), no .limit())
    .mockImplementationOnce(() => createWhereSelectChain(
      approvedPatches.map((p) => ({
        id: p.patchId,
        source: 'windows_update',
        externalId: p.externalId,
        title: p.externalId,
      })),
    ) as any)
    // 4. completion poll on device_commands
    .mockImplementationOnce(() => createSelectChain(command ? [command] : []) as any)
    // 5. checkAndFinalizeJob — no row, so it returns early
    .mockImplementationOnce(() => createSelectChain([]) as any);

  vi.mocked(db.insert).mockImplementation(() => ({
    values: vi.fn((v: any) => {
      insertedRows?.push(v);
      return Promise.resolve();
    }),
  }) as any);
  vi.mocked(db.update).mockImplementation(() => ({
    set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
  }) as any);

  vi.mocked(resolveApprovedPatchesForDevice).mockResolvedValueOnce(approvedPatches as any);
  vi.mocked(queueCommandForExecution).mockResolvedValueOnce({ command: { id: 'cmd-1' } } as any);

  createPatchJobDeviceWorker();
  const running = shared.processorRefs['patch-job-devices']({
    data: {
      type: 'execute-patch-job-device',
      patchJobId: 'job-1',
      deviceId: 'device-1',
      orgId: 'org-1',
    },
  });
  // pollForPatchCommandResult sleeps 5s before its first read of device_commands.
  await vi.advanceTimersByTimeAsync(5_000);
  return running;
}

const TWO_PATCHES = [
  { patchId: 'patch-1', externalId: 'KB5000001', requiresReboot: true },
  { patchId: 'patch-2', externalId: 'KB5000002', requiresReboot: false },
];

describe('post-patch reboot policy is independent of overall job success (#4228)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    shared.processorRef = undefined;
    shared.processorRefs = {};
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(executeReboot).mockResolvedValue({ success: true, delayMinutes: 15 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('dispatches the reboot when one patch fails but an installed patch requires one', async () => {
    vi.mocked(evaluateRebootPolicy).mockResolvedValue({
      shouldReboot: true,
      reason: 'Installed patch requires reboot',
      deferred: false,
    });

    await runDeviceExecution({
      approvedPatches: TWO_PATCHES,
      rebootPolicy: 'if_required',
      command: agentCommandRow({
        success: false,
        installedCount: 1,
        failedCount: 1,
        rebootRequired: true,
        results: [
          { id: 'patch-1', externalId: 'KB5000001', status: 'installed', rebootRequired: true },
          { id: 'patch-2', externalId: 'KB5000002', status: 'failed', error: '0x80070005' },
        ],
      }),
    });

    // The reboot requirement the agent reported must reach the policy even
    // though the job's aggregate status is "failed".
    expect(evaluateRebootPolicy).toHaveBeenCalledWith('device-1', 'if_required', true);
    expect(executeReboot).toHaveBeenCalledWith(
      'device-1',
      'Installed patch requires reboot',
      { expectedOrgId: 'org-1' },
    );
  });

  it('records that the dispatched reboot followed a partially failed job', async () => {
    vi.mocked(evaluateRebootPolicy).mockResolvedValue({
      shouldReboot: true,
      reason: 'Installed patch requires reboot',
      deferred: false,
    });

    await runDeviceExecution({
      approvedPatches: TWO_PATCHES,
      command: agentCommandRow({
        success: false,
        installedCount: 1,
        failedCount: 1,
        rebootRequired: true,
        results: [
          { id: 'patch-1', externalId: 'KB5000001', status: 'installed', rebootRequired: true },
          { id: 'patch-2', externalId: 'KB5000002', status: 'failed', error: '0x80070005' },
        ],
      }),
    });

    const logged = logSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
    expect(logged).toContain('device-1');
    expect(logged).toContain('scheduled reboot');
    expect(logged).toMatch(/partial/i);
  });

  it('records why the reboot was skipped when the policy declines it', async () => {
    vi.mocked(evaluateRebootPolicy).mockResolvedValue({
      shouldReboot: false,
      reason: 'Reboot policy is never',
      deferred: false,
    });

    await runDeviceExecution({
      approvedPatches: TWO_PATCHES,
      rebootPolicy: 'never',
      command: agentCommandRow({
        success: false,
        installedCount: 1,
        failedCount: 1,
        rebootRequired: true,
        results: [
          { id: 'patch-1', externalId: 'KB5000001', status: 'installed', rebootRequired: true },
          { id: 'patch-2', externalId: 'KB5000002', status: 'failed', error: '0x80070005' },
        ],
      }),
    });

    expect(evaluateRebootPolicy).toHaveBeenCalledWith('device-1', 'never', true);
    expect(executeReboot).not.toHaveBeenCalled();
    const logged = logSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
    expect(logged).toContain('Reboot policy is never');
  });

  it('does not reboot when every patch failed and nothing was installed', async () => {
    await runDeviceExecution({
      // Both patches statically claim to require a reboot — neither installed.
      approvedPatches: [
        { patchId: 'patch-1', externalId: 'KB5000001', requiresReboot: true },
        { patchId: 'patch-2', externalId: 'KB5000002', requiresReboot: true },
      ],
      command: agentCommandRow({
        success: false,
        installedCount: 0,
        failedCount: 2,
        rebootRequired: false,
        results: [
          { id: 'patch-1', externalId: 'KB5000001', status: 'failed', error: '0x80070005' },
          { id: 'patch-2', externalId: 'KB5000002', status: 'failed', error: '0x80070005' },
        ],
      }),
    });

    expect(evaluateRebootPolicy).not.toHaveBeenCalled();
    expect(executeReboot).not.toHaveBeenCalled();
    const logged = logSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
    expect(logged).toMatch(/no patch installed/i);
  });

  it('does not manufacture a reboot from static flags when a failed run is unparsable', async () => {
    // Agent returned a failed command with non-JSON stdout: we know nothing about
    // what installed, so the `approvedPatches.some(p => p.requiresReboot)`
    // fallback — which assumes a success-shaped run — must not fire.
    await runDeviceExecution({
      approvedPatches: [
        { patchId: 'patch-1', externalId: 'KB5000001', requiresReboot: true },
      ],
      command: {
        status: 'failed',
        result: { stdout: 'Access is denied.', exitCode: 1, error: 'install failed' },
      },
    });

    expect(evaluateRebootPolicy).not.toHaveBeenCalled();
    expect(executeReboot).not.toHaveBeenCalled();
    // ...but an unparsable result is an anomaly, not a shrug: it is the one way a
    // real partial success can still read as "nothing installed", so it has to
    // leave a trail rather than silently taking the conservative branch.
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('unparsable patch install result') }),
    );
    const logged = logSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
    expect(logged).toMatch(/unparsable/i);
    // Must NOT claim the stronger "no patch installed successfully" — we do not know that.
    expect(logged).not.toContain('no patch installed successfully');
  });

  it('records that a declined reboot was deferred by the maintenance window', async () => {
    vi.mocked(evaluateRebootPolicy).mockResolvedValue({
      shouldReboot: false,
      reason: 'Outside maintenance window — reboot deferred',
      deferred: true,
    });

    await runDeviceExecution({
      approvedPatches: TWO_PATCHES,
      rebootPolicy: 'maintenance_window',
      command: agentCommandRow({
        success: false,
        installedCount: 1,
        failedCount: 1,
        rebootRequired: true,
        results: [
          { id: 'patch-1', externalId: 'KB5000001', status: 'installed', rebootRequired: true },
          { id: 'patch-2', externalId: 'KB5000002', status: 'failed', error: '0x80070005' },
        ],
      }),
    });

    expect(executeReboot).not.toHaveBeenCalled();
    const logged = logSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
    expect(logged).toContain('Outside maintenance window');
    expect(logged).toContain('(deferred)');
  });

  it('does not reboot when the install command never came back', async () => {
    await runDeviceExecution({
      approvedPatches: [
        { patchId: 'patch-1', externalId: 'KB5000001', requiresReboot: true },
      ],
      command: null,
    });

    expect(evaluateRebootPolicy).not.toHaveBeenCalled();
    expect(executeReboot).not.toHaveBeenCalled();
  });

  it('still falls back to static requiresReboot flags on a fully successful unparsable run', async () => {
    // Behaviour preserved from before #4228: a completed, exit-0 command whose
    // stdout we cannot parse means every approved patch installed, so the static
    // flags are a sound description of what landed.
    vi.mocked(evaluateRebootPolicy).mockResolvedValue({
      shouldReboot: true,
      reason: 'Installed patch requires reboot',
      deferred: false,
    });

    await runDeviceExecution({
      approvedPatches: TWO_PATCHES,
      command: {
        status: 'completed',
        result: { stdout: 'Installation successful.', exitCode: 0 },
      },
    });

    expect(evaluateRebootPolicy).toHaveBeenCalledWith('device-1', 'if_required', true);
    expect(executeReboot).toHaveBeenCalled();
  });

  it('honors a reported rebootRequired: false over the static patch flags', async () => {
    // The approved set statically claims patch-1 requires a reboot, but the agent
    // installed it and reported `rebootRequired: false` — Windows does not always
    // need the restart the catalog advertises. The agent observed the real
    // machine, so its `false` wins. Drop the `??` and read the static flags
    // directly and this device gets an unnecessary reboot.
    vi.mocked(evaluateRebootPolicy).mockResolvedValue({
      shouldReboot: false,
      reason: 'No installed patch requires reboot',
      deferred: false,
    });

    await runDeviceExecution({
      approvedPatches: TWO_PATCHES, // patch-1 has requiresReboot: true
      rebootPolicy: 'if_required',
      command: agentCommandRow({
        success: true,
        installedCount: 2,
        failedCount: 0,
        rebootRequired: false,
        results: [
          { id: 'patch-1', externalId: 'KB5000001', status: 'installed', rebootRequired: false },
          { id: 'patch-2', externalId: 'KB5000002', status: 'installed', rebootRequired: false },
        ],
      }),
    });

    expect(evaluateRebootPolicy).toHaveBeenCalledWith('device-1', 'if_required', false);
    expect(executeReboot).not.toHaveBeenCalled();
  });

  it('treats a per-patch installed entry as an install even when installedCount is 0', async () => {
    // The two signals disagree: the summary counter says nothing installed, the
    // per-patch array says patch-1 did. `anyPatchInstalled` ORs them, so the
    // reboot still gets evaluated. Reading only `installedCount` would silently
    // reinstate #4228 for any agent whose counter is absent, stale, or wrong.
    vi.mocked(evaluateRebootPolicy).mockResolvedValue({
      shouldReboot: true,
      reason: 'Installed patch requires reboot',
      deferred: false,
    });

    await runDeviceExecution({
      approvedPatches: TWO_PATCHES,
      rebootPolicy: 'if_required',
      command: agentCommandRow({
        success: false,
        installedCount: 0,
        failedCount: 1,
        rebootRequired: true,
        results: [
          { id: 'patch-1', externalId: 'KB5000001', status: 'installed', rebootRequired: true },
          { id: 'patch-2', externalId: 'KB5000002', status: 'failed', error: '0x80070005' },
        ],
      }),
    });

    expect(evaluateRebootPolicy).toHaveBeenCalledWith('device-1', 'if_required', true);
    expect(executeReboot).toHaveBeenCalled();
  });

  it('evaluates the reboot policy for a rollback-only run with no net installs', async () => {
    // Deliberate: `rolled_back` counts as "the device changed". Uninstalling a
    // patch can require a restart just as installing one can, so a rollback that
    // reports rebootRequired must reach the policy even though nothing was
    // installed. Pinned because it is the least obvious arm of anyPatchInstalled
    // and reads like a copy-paste at a glance.
    vi.mocked(evaluateRebootPolicy).mockResolvedValue({
      shouldReboot: true,
      reason: 'Installed patch requires reboot',
      deferred: false,
    });

    await runDeviceExecution({
      approvedPatches: TWO_PATCHES,
      rebootPolicy: 'if_required',
      command: agentCommandRow({
        success: false,
        installedCount: 0,
        failedCount: 1,
        rebootRequired: true,
        results: [
          { id: 'patch-1', externalId: 'KB5000001', status: 'rolled_back', rebootRequired: true },
          { id: 'patch-2', externalId: 'KB5000002', status: 'failed', error: '0x80070005' },
        ],
      }),
    });

    expect(evaluateRebootPolicy).toHaveBeenCalledWith('device-1', 'if_required', true);
    expect(executeReboot).toHaveBeenCalled();
  });
});

// ============================================================================
// #4267 — patch_job_results per-patch status must not collapse to the batch's
// overall status
// ============================================================================

const THREE_PATCHES = [
  { patchId: 'patch-1', externalId: 'KB5000001', requiresReboot: true },
  { patchId: 'patch-2', externalId: 'KB5000002', requiresReboot: false },
  { patchId: 'patch-3', externalId: 'KB5000003', requiresReboot: false },
];

describe('per-patch patch_job_results status is not collapsed to the batch status (#4267)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    shared.processorRef = undefined;
    shared.processorRefs = {};
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(executeReboot).mockResolvedValue({ success: true, delayMinutes: 15 });
    vi.mocked(evaluateRebootPolicy).mockResolvedValue({
      shouldReboot: false,
      reason: 'no reboot needed for this test',
      deferred: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('records a mixed batch (one failed, two installed) with per-patch status, not all-failed', async () => {
    const insertedRows: any[] = [];

    await runDeviceExecution({
      approvedPatches: THREE_PATCHES,
      command: agentCommandRow({
        success: false,
        installedCount: 2,
        failedCount: 1,
        rebootRequired: true,
        results: [
          { id: 'patch-1', externalId: 'KB5000001', status: 'installed', rebootRequired: true },
          { id: 'patch-2', externalId: 'KB5000002', status: 'failed', error: '0x80070005' },
          { id: 'patch-3', externalId: 'KB5000003', status: 'installed', rebootRequired: false },
        ],
      }),
      insertedRows,
    });

    expect(insertedRows).toHaveLength(3);
    const byPatchId = Object.fromEntries(insertedRows.map((r: any) => [r.patchId, r]));

    // The batch's aggregate status is "failed" (one patch failed) — the two
    // patches that installed cleanly must NOT inherit that.
    expect(byPatchId['patch-1'].status).toBe('completed');
    expect(byPatchId['patch-1'].errorMessage).toBeNull();

    expect(byPatchId['patch-2'].status).toBe('failed');
    expect(byPatchId['patch-2'].errorMessage).toBe('0x80070005');

    expect(byPatchId['patch-3'].status).toBe('completed');
    expect(byPatchId['patch-3'].errorMessage).toBeNull();
  });

  it('matches each per-patch result on the agent-reported `id` field, not a `patchId` field the agent never sends', async () => {
    const insertedRows: any[] = [];

    await runDeviceExecution({
      // Single patch, fully successful — if the lookup silently fails (because
      // it keys off a `patchId` field the agent never sends), `perPatchResult`
      // is undefined and this falls back to `overallSuccess`, which happens to
      // also be true here — so exercise a case where the fallback would be
      // WRONG: a failed batch whose lone patch actually installed.
      approvedPatches: [{ patchId: 'patch-1', externalId: 'KB5000001', requiresReboot: false }],
      command: agentCommandRow({
        success: false,
        installedCount: 1,
        failedCount: 0,
        rebootRequired: false,
        results: [
          { id: 'patch-1', externalId: 'DIFFERENT-EXTERNAL-ID', status: 'installed' },
        ],
      }),
      insertedRows,
    });

    expect(insertedRows).toHaveLength(1);
    // externalId doesn't match, so only the `id` branch can have found this
    // entry. If it had fallen back to `overallSuccess`, this would be
    // 'completed' too by coincidence — assert the row content that only the
    // real per-patch match can produce.
    expect(insertedRows[0].status).toBe('completed');
    expect(insertedRows[0].rebootRequired).toBe(false);
  });

  it('falls back to the batch status only when no per-patch entry matches at all', async () => {
    const insertedRows: any[] = [];

    await runDeviceExecution({
      approvedPatches: [{ patchId: 'patch-1', externalId: 'KB5000001', requiresReboot: true }],
      command: agentCommandRow({
        success: true,
        installedCount: 1,
        failedCount: 0,
        rebootRequired: false,
        // No results array at all — an omitted/legacy payload.
        results: [],
      }),
      insertedRows,
    });

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].status).toBe('completed');
    expect(insertedRows[0].rebootRequired).toBe(true);
  });
});
