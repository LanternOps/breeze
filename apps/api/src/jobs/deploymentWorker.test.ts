import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  addBulkMock: vi.fn(),
  closeMock: vi.fn(),
  processorRefs: {
    deployment: undefined as any,
    device: undefined as any,
  },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = shared.getJobMock;
    add = shared.addMock;
    addBulk = shared.addBulkMock;
    close = shared.closeMock;
  },
  Worker: class {
    close = shared.closeMock;
    on = vi.fn();
    constructor(queueName: string, processor: unknown) {
      if (queueName === 'deployments') {
        shared.processorRefs.deployment = processor;
      } else if (queueName === 'deployment-devices') {
        shared.processorRefs.device = processor;
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
}));

vi.mock('../db/schema', () => ({
  deployments: {
    id: 'deployments.id',
    status: 'deployments.status',
  },
  deploymentDevices: {
    deploymentId: 'deploymentDevices.deploymentId',
    deviceId: 'deploymentDevices.deviceId',
    batchNumber: 'deploymentDevices.batchNumber',
    status: 'deploymentDevices.status',
  },
  devices: {},
  deviceCommands: {},
  scripts: {},
  users: {
    email: 'users.email',
    name: 'users.name',
    status: 'users.status',
    id: 'users.id',
  },
  organizationUsers: {
    userId: 'organizationUsers.userId',
    orgId: 'organizationUsers.orgId',
  },
  patches: {},
}));

vi.mock('../services/deploymentEngine', () => ({
  getDeploymentProgress: vi.fn(),
  shouldPauseDeployment: vi.fn(),
  updateDeploymentDeviceStatus: vi.fn(),
  incrementRetryCount: vi.fn(),
  getRetryBackoffMs: vi.fn(),
  pauseDeployment: vi.fn(),
  isDeviceInMaintenanceWindow: vi.fn(),
  filterEligibleDevices: vi.fn(),
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
}));

vi.mock('../services/notifications', () => ({
  getUsersForAlert: vi.fn(async () => []),
  sendPushToUser: vi.fn(async () => undefined),
}));

vi.mock('../services/email', () => ({
  getEmailService: vi.fn(() => null),
}));

import { db } from '../db';
import {
  filterEligibleDevices,
  isDeviceInMaintenanceWindow,
} from '../services/deploymentEngine';
import {
  createDeploymentDeviceWorker,
  createDeploymentWorker,
  isSuccessfulAgentCommand,
  startDeployment,
} from './deploymentWorker';

function createSelectChain(rows: any[] = []) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  chain.orderBy = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  return chain;
}

function createUpdateChain(rows: any[] = []) {
  const chain: any = {};
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(rows));
  return chain;
}

describe('deployment worker queueing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shared.processorRefs.deployment = undefined;
    shared.processorRefs.device = undefined;
    shared.addMock.mockResolvedValue({ id: 'queue-job-1' });
    shared.addBulkMock.mockResolvedValue([]);
    shared.getJobMock.mockResolvedValue(null);
    vi.mocked(filterEligibleDevices).mockResolvedValue([
      'device-1',
      'device-2',
    ]);
    vi.mocked(isDeviceInMaintenanceWindow).mockResolvedValue(true);
    vi.mocked(db.update).mockImplementation(() => createUpdateChain() as any);
  });

  it('uses a stable BullMQ job id for deployment start and reuses an active one', async () => {
    shared.getJobMock.mockResolvedValueOnce({
      id: 'existing-process-job',
      getState: vi.fn().mockResolvedValue('waiting'),
    });

    await startDeployment('deployment-1');

    expect(shared.addMock).not.toHaveBeenCalled();

    shared.getJobMock.mockResolvedValueOnce(null);

    await startDeployment('deployment-2');

    expect(shared.addMock).toHaveBeenCalledWith(
      'process-deployment',
      { deploymentId: 'deployment-2' },
      { jobId: 'deployment-process:deployment-2' },
    );
  });

  it('adds stable per-device job ids and skips devices already queued', async () => {
    vi.mocked(db.select)
      .mockImplementationOnce(() => createSelectChain([{
        id: 'deployment-1',
        status: 'pending',
        startedAt: null,
        rolloutConfig: {
          type: 'staggered',
          staggered: { batchDelayMinutes: 5 },
          respectMaintenanceWindows: false,
        },
      }]) as any)
      .mockImplementationOnce(() => createSelectChain([
        { deviceId: 'device-1', batchNumber: 1 },
        { deviceId: 'device-2', batchNumber: 1 },
      ]) as any);

    shared.getJobMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'existing-device-job',
        getState: vi.fn().mockResolvedValue('delayed'),
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    createDeploymentWorker();
    const result = await shared.processorRefs.deployment({
      data: { deploymentId: 'deployment-1' },
    });

    expect(shared.addBulkMock).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'process-device',
        data: {
          deploymentId: 'deployment-1',
          deviceId: 'device-1',
          batchNumber: 1,
        },
        opts: expect.objectContaining({
          jobId: 'deployment-device:deployment-1:device-1',
        }),
      }),
    ]);
    expect(shared.addMock).toHaveBeenCalledWith(
      'check-next-batch',
      { deploymentId: 'deployment-1', currentBatch: 1 },
      expect.objectContaining({
        jobId: 'deployment-next-batch:deployment-1:1',
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({ processed: 2, skipped: 0, batch: 1 })
    );
  });

  it('uses a deferred stable job id for maintenance-window requeues', async () => {
    vi.mocked(db.select).mockImplementationOnce(() => createSelectChain([{
      id: 'deployment-1',
      name: 'Deploy 1',
      orgId: 'org-1',
      status: 'running',
      payload: { type: 'script', scriptId: 'script-1' },
      rolloutConfig: {
        type: 'immediate',
        respectMaintenanceWindows: true,
      },
    }]) as any);
    vi.mocked(isDeviceInMaintenanceWindow).mockResolvedValue(false);
    shared.getJobMock.mockResolvedValueOnce(null);

    createDeploymentDeviceWorker();
    const result = await shared.processorRefs.device({
      data: {
        deploymentId: 'deployment-1',
        deviceId: 'device-1',
        batchNumber: 1,
      },
    });

    expect(shared.addMock).toHaveBeenCalledWith(
      'process-device',
      {
        deploymentId: 'deployment-1',
        deviceId: 'device-1',
        batchNumber: 1,
      },
      expect.objectContaining({
        jobId: 'deployment-device-deferred:deployment-1:device-1',
      }),
    );
    expect(result).toEqual({
      delayed: true,
      reason: 'waiting for maintenance window',
    });
  });
});

describe('isSuccessfulAgentCommand', () => {
  it('treats completed command with exitCode 0 as success', () => {
    expect(isSuccessfulAgentCommand('completed', { exitCode: 0 })).toBe(true);
  });

  it('treats completed command with non-zero exitCode as failure', () => {
    expect(isSuccessfulAgentCommand('completed', { exitCode: 1 })).toBe(false);
  });

  it('falls back to legacy success field when exitCode is missing', () => {
    expect(isSuccessfulAgentCommand('completed', { success: true })).toBe(true);
    expect(isSuccessfulAgentCommand('completed', { success: false })).toBe(false);
  });

  it('treats non-completed statuses as failure', () => {
    expect(isSuccessfulAgentCommand('failed', { exitCode: 0 })).toBe(false);
  });
});
