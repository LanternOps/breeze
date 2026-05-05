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

import { db } from '../db';
import {
  createPatchJobDeviceWorker,
  createPatchJobWorker,
  enqueuePatchJob,
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
        jobId: 'patch-job:job-2',
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
        jobId: 'patch-job-device:job-1:device-1',
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
    );
    expect(shared.addMock).toHaveBeenCalledWith(
      'check-completion',
      { type: 'check-completion', patchJobId: 'job-1' },
      expect.objectContaining({
        jobId: 'patch-job-completion:job-1',
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 100 },
      }),
    );
    expect(result).toEqual({ dispatched: 2 });
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
});
