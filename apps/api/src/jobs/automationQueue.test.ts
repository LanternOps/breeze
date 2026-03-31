import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    getRepeatableJobs = vi.fn(async () => []);
    removeRepeatableByKey = vi.fn(async () => undefined);
  },
  Worker: class {
    close = closeMock;
    on = vi.fn();
  },
  Job: class {},
}));

vi.mock('../db', () => ({
  db: {},
}));

vi.mock('../db/schema', () => ({
  automations: {},
  configPolicyAutomations: {},
  devices: {},
  deviceGroupMemberships: {},
  organizations: {},
}));

vi.mock('../services/eventBus', () => ({
  getEventBus: vi.fn(() => ({ subscribe: vi.fn() })),
}));

vi.mock('../services/automationRuntime', () => ({
  createAutomationRunRecord: vi.fn(),
  executeAutomationRun: vi.fn(),
  executeConfigPolicyAutomationRun: vi.fn(),
  formatScheduleTriggerKey: vi.fn(),
  isCronDue: vi.fn(),
  normalizeAutomationTrigger: vi.fn(),
}));

vi.mock('../services/featureConfigResolver', () => ({
  scanScheduledAutomations: vi.fn(),
  resolveAutomationsForDevice: vi.fn(),
  resolveMaintenanceConfigForDevice: vi.fn(),
  isInMaintenanceWindow: vi.fn(),
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  isRedisAvailable: vi.fn(() => true),
}));

import {
  enqueueConfigPolicyRun,
  enqueueAutomationRun,
  shutdownAutomationWorker,
} from './automationWorker';

describe('enqueueAutomationRun', () => {
  beforeEach(async () => {
    getJobMock.mockReset();
    addMock.mockReset();
    closeMock.mockReset();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    await shutdownAutomationWorker();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses a stable BullMQ job id for automation run execution', async () => {
    const result = await enqueueAutomationRun('run-1', ['device-1']);

    expect(addMock).toHaveBeenCalledWith(
      'execute-run',
      expect.objectContaining({ runId: 'run-1', targetDeviceIds: ['device-1'] }),
      expect.objectContaining({ jobId: 'automation-run:run-1' }),
    );
    expect(result).toEqual({ enqueued: true, jobId: 'queue-job-1' });
  });

  it('reuses an active automation run job for the same run id', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-job',
      getState: vi.fn().mockResolvedValue('active'),
    });

    const result = await enqueueAutomationRun('run-1');

    expect(addMock).not.toHaveBeenCalled();
    expect(result).toEqual({ enqueued: true, jobId: 'existing-job' });
  });

  it('reuses an active config-policy execution job for the same stable job id', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-config-job',
      getState: vi.fn().mockResolvedValue('waiting'),
    });

    const result = await enqueueConfigPolicyRun(
      {
        type: 'execute-config-policy-run',
        configPolicyAutomationId: 'cp-auto-1',
        targetDeviceIds: ['device-1'],
        triggeredBy: 'schedule:2026-03-31T12:00',
      },
      'cp-automation-run:cp-auto-1:2026-03-31T12:00',
    );

    expect(addMock).not.toHaveBeenCalled();
    expect(result).toEqual({ jobId: 'existing-config-job' });
  });
});
