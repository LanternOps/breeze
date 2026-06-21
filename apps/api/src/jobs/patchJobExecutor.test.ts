import { beforeEach, describe, expect, it, vi } from 'vitest';

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
} from './patchJobExecutor';
import { resolveApprovedPatchesForDevice } from '../services/patchApprovalEvaluator';
import { queueCommandForExecution } from '../services/commandQueue';

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
    expect(result).toEqual({ dispatched: 2 });
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
});
