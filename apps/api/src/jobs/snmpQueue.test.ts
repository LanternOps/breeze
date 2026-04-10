import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getJobMock, addMock, closeMock } = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    close = closeMock;
  },
  Worker: class {},
  Job: class {},
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  withSystemDbAccessContext: undefined,
}));

vi.mock('../db/schema', () => ({
  snmpDevices: {
    id: 'snmpDevices.id',
    orgId: 'snmpDevices.orgId',
    pollingInterval: 'snmpDevices.pollingInterval',
    lastPolled: 'snmpDevices.lastPolled',
    isActive: 'snmpDevices.isActive',
  },
  snmpMetrics: {
    deviceId: 'snmpMetrics.deviceId',
  },
  snmpTemplates: {
    oids: 'snmpTemplates.oids',
    id: 'snmpTemplates.id',
  },
  devices: {
    agentId: 'devices.agentId',
    orgId: 'devices.orgId',
    status: 'devices.status',
  },
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../routes/agentWs', () => ({
  sendCommandToAgent: vi.fn(),
  isAgentConnected: vi.fn(),
}));

import { enqueueSnmpPoll, enqueueSnmpPollResults, shutdownSnmpWorker } from './snmpWorker';

describe('snmp queue helpers', () => {
  beforeEach(async () => {
    getJobMock.mockReset();
    addMock.mockReset();
    closeMock.mockReset();
    addMock.mockResolvedValue({ id: 'job-1' });
    await shutdownSnmpWorker();
  });

  it('uses a stable BullMQ job id for device polls', async () => {
    getJobMock.mockResolvedValue(null);

    await enqueueSnmpPoll('device-1', 'org-1');

    expect(addMock).toHaveBeenCalledWith(
      'poll-device',
      expect.objectContaining({ deviceId: 'device-1', orgId: 'org-1' }),
      expect.objectContaining({ jobId: 'snmp-poll:device-1' }),
    );
  });

  it('uses a stable BullMQ job id for poll result processing', async () => {
    getJobMock.mockResolvedValue(null);

    await enqueueSnmpPollResults('device-1', [], 'snmp-device-1-123');

    expect(addMock).toHaveBeenCalledWith(
      'process-poll-results',
      expect.objectContaining({ deviceId: 'device-1', pollId: 'snmp-device-1-123' }),
      expect.objectContaining({ jobId: 'snmp-result:snmp-device-1-123' }),
    );
  });

  it('reuses an active queued poll result job for the same poll id', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-job',
      getState: vi.fn().mockResolvedValue('active'),
    });

    const jobId = await enqueueSnmpPollResults('device-1', [], 'snmp-device-1-123');

    expect(addMock).not.toHaveBeenCalled();
    expect(jobId).toBe('existing-job');
  });
});
