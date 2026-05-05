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

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  deployments: {
    id: 'deployments.id',
    orgId: 'deployments.orgId',
    status: 'deployments.status',
  },
  deploymentDevices: {
    deploymentId: 'deploymentDevices.deploymentId',
    deviceId: 'deploymentDevices.deviceId',
    batchNumber: 'deploymentDevices.batchNumber',
    status: 'deploymentDevices.status',
    startedAt: 'deploymentDevices.startedAt',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
  },
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
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
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
  updateDeploymentDeviceStatus,
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

const ORG_A_ID = '00000000-0000-4000-8000-000000000001';
const ORG_B_ID = '00000000-0000-4000-8000-000000000002';
const DEPLOYMENT_ID = '10000000-0000-4000-8000-000000000001';
const DEVICE_A_ID = '20000000-0000-4000-8000-000000000001';
const DEVICE_B_ID = '20000000-0000-4000-8000-000000000002';

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
      id: DEPLOYMENT_ID,
      name: 'Deploy 1',
      orgId: ORG_A_ID,
      status: 'running',
      payload: { type: 'script', scriptId: 'script-1' },
      rolloutConfig: {
        type: 'immediate',
        respectMaintenanceWindows: true,
      },
    }]) as any);
    vi.mocked(db.update)
      .mockImplementationOnce(() => createUpdateChain([{ deviceId: DEVICE_A_ID }]) as any)
      .mockImplementation(() => createUpdateChain() as any);
    vi.mocked(isDeviceInMaintenanceWindow).mockResolvedValue(false);
    shared.getJobMock.mockResolvedValueOnce(null);

    createDeploymentDeviceWorker();
    const result = await shared.processorRefs.device({
      data: {
        deploymentId: DEPLOYMENT_ID,
        deviceId: DEVICE_A_ID,
        batchNumber: 1,
      },
    });

    expect(shared.addMock).toHaveBeenCalledWith(
      'process-device',
      {
        deploymentId: DEPLOYMENT_ID,
        deviceId: DEVICE_A_ID,
        batchNumber: 1,
      },
      expect.objectContaining({
        jobId: `deployment-device-deferred:${DEPLOYMENT_ID}:${DEVICE_A_ID}`,
      }),
    );
    expect(result).toEqual({
      delayed: true,
      reason: 'waiting for maintenance window',
    });
  });
});

describe('deployment device worker claim validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shared.processorRefs.device = undefined;
    shared.getJobMock.mockResolvedValue(null);
    shared.addMock.mockResolvedValue({ id: 'queue-job-1' });
    vi.mocked(isDeviceInMaintenanceWindow).mockResolvedValue(true);
    vi.mocked(db.update).mockImplementation(() => createUpdateChain() as any);
  });

  function mockRunningDeployment() {
    vi.mocked(db.select).mockImplementationOnce(() => createSelectChain([{
      id: DEPLOYMENT_ID,
      name: 'Deploy 1',
      orgId: ORG_A_ID,
      status: 'running',
      payload: { type: 'software', packageId: 'pkg-1', action: 'install' },
      rolloutConfig: {
        type: 'immediate',
        respectMaintenanceWindows: false,
      },
    }]) as any);
  }

  it('rejects malformed queue job data before database access', async () => {
    createDeploymentDeviceWorker();

    await expect(shared.processorRefs.device({
      data: {
        deploymentId: 'not-a-uuid',
        deviceId: DEVICE_A_ID,
        batchNumber: 1,
      },
    })).rejects.toThrow('Invalid deployment device job data');

    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects a forged queue job for a device outside the deployment', async () => {
    mockRunningDeployment();
    vi.mocked(db.update).mockImplementationOnce(() => createUpdateChain([]) as any);
    vi.mocked(db.select).mockImplementationOnce(() => createSelectChain([]) as any);

    createDeploymentDeviceWorker();

    await expect(shared.processorRefs.device({
      data: {
        deploymentId: DEPLOYMENT_ID,
        deviceId: DEVICE_A_ID,
        batchNumber: 1,
      },
    })).rejects.toThrow(`Device ${DEVICE_A_ID} is not part of deployment ${DEPLOYMENT_ID}`);

    expect(db.insert).not.toHaveBeenCalled();
    expect(updateDeploymentDeviceStatus).not.toHaveBeenCalled();
  });

  it('rejects a deployment-device row whose device belongs to another org', async () => {
    mockRunningDeployment();
    vi.mocked(db.update).mockImplementationOnce(() => createUpdateChain([]) as any);
    vi.mocked(db.select).mockImplementationOnce(() => createSelectChain([{
      status: 'pending',
      batchNumber: 1,
      deviceOrgId: ORG_B_ID,
    }]) as any);

    createDeploymentDeviceWorker();

    await expect(shared.processorRefs.device({
      data: {
        deploymentId: DEPLOYMENT_ID,
        deviceId: DEVICE_B_ID,
        batchNumber: 1,
      },
    })).rejects.toThrow(`Device ${DEVICE_B_ID} does not belong to deployment organization ${ORG_A_ID}`);

    expect(db.insert).not.toHaveBeenCalled();
    expect(updateDeploymentDeviceStatus).not.toHaveBeenCalled();
  });

  it('skips stale duplicate jobs after the deployment-device row has left pending', async () => {
    mockRunningDeployment();
    vi.mocked(db.update).mockImplementationOnce(() => createUpdateChain([]) as any);
    vi.mocked(db.select).mockImplementationOnce(() => createSelectChain([{
      status: 'completed',
      batchNumber: 1,
      deviceOrgId: ORG_A_ID,
    }]) as any);

    createDeploymentDeviceWorker();

    const result = await shared.processorRefs.device({
      data: {
        deploymentId: DEPLOYMENT_ID,
        deviceId: DEVICE_A_ID,
        batchNumber: 1,
      },
    });

    expect(result).toEqual({
      skipped: true,
      reason: 'Deployment device status is completed',
    });
    expect(db.insert).not.toHaveBeenCalled();
    expect(updateDeploymentDeviceStatus).not.toHaveBeenCalled();
  });

  it('skips a duplicate job while another worker owns the running claim', async () => {
    mockRunningDeployment();
    vi.mocked(db.update).mockImplementationOnce(() => createUpdateChain([]) as any);
    vi.mocked(db.select).mockImplementationOnce(() => createSelectChain([{
      status: 'running',
      batchNumber: 1,
      deviceOrgId: ORG_A_ID,
    }]) as any);

    createDeploymentDeviceWorker();

    const result = await shared.processorRefs.device({
      data: {
        deploymentId: DEPLOYMENT_ID,
        deviceId: DEVICE_A_ID,
        batchNumber: 1,
      },
    });

    expect(result).toEqual({
      skipped: true,
      reason: 'Deployment device status is running',
    });
    expect(db.insert).not.toHaveBeenCalled();
    expect(updateDeploymentDeviceStatus).not.toHaveBeenCalled();
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
