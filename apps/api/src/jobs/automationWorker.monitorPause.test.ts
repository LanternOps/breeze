/**
 * #5290 — a monitor whose recurrence latch has fired pauses its OWN compiled
 * response for the escalated device, and every response attempt is recorded on
 * the open episode.
 *
 * Mock preamble copied from automationWorker.monitorBinding.test.ts (#5289).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  closeMock,
  createAutomationRunRecordMock,
  executeAutomationRunMock,
  getJobMock,
  selectMock,
  recordEpisodeResponseMock,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  closeMock: vi.fn(),
  createAutomationRunRecordMock: vi.fn(),
  executeAutomationRunMock: vi.fn(),
  getJobMock: vi.fn(),
  selectMock: vi.fn(),
  recordEpisodeResponseMock: vi.fn(),
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
  db: { select: selectMock },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  automations: { id: 'id', enabled: 'enabled' },
  configPolicyAutomations: {},
  devices: {},
  deviceGroupMemberships: {},
  organizations: {},
  monitorDeviceState: { monitorId: 'monitor_id', deviceId: 'device_id', responsesPaused: 'responses_paused' },
}));

vi.mock('../services/eventBus', () => ({
  getEventBus: vi.fn(() => ({ subscribe: vi.fn() })),
}));

vi.mock('../services/monitors/episodeService', () => ({
  recordEpisodeResponse: recordEpisodeResponseMock,
}));

vi.mock('../services/automationRuntime', () => ({
  createAutomationRunRecord: createAutomationRunRecordMock,
  executeAutomationRun: executeAutomationRunMock,
  executeConfigPolicyAutomationRun: vi.fn(),
  formatScheduleTriggerKey: vi.fn(),
  isCronDue: vi.fn(),
  normalizeAutomationTrigger: vi.fn((trigger: Record<string, unknown>) => ({
    type: trigger.type,
    eventType: trigger.eventType ?? trigger.event,
    filter: trigger.filter,
  })),
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
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: vi.fn(),
}));

import { devices, monitorDeviceState } from '../db/schema';
import { __testOnly, shutdownAutomationWorker } from './automationWorker';

const MONITOR_AUTOMATION = {
  id: 'auto-monitor-1',
  orgId: 'org-1',
  partnerId: null,
  name: '[monitor] Disk over 80%',
  enabled: true,
  actions: [{ type: 'run_script', scriptId: 's1' }],
  managedByAgentId: null,
  managedByMonitorId: 'monitor-1',
  trigger: { type: 'event', event: 'alert.triggered', filter: { ruleId: 'rule-1' } },
};

const AGENT_AUTOMATION = {
  ...MONITOR_AUTOMATION,
  id: 'auto-agent-1',
  managedByAgentId: 'agent-1',
  managedByMonitorId: null,
};

const PLAIN_AUTOMATION = {
  ...MONITOR_AUTOMATION,
  id: 'auto-plain-1',
  managedByAgentId: null,
  managedByMonitorId: null,
};

const BASE_EVENT = {
  type: 'trigger-event' as const,
  automationId: 'auto-monitor-1',
  eventType: 'alert.triggered',
  eventId: 'evt-1',
  eventTimestamp: '2026-09-13T12:00:00.000Z',
};

const PAYLOAD = { alertId: 'alert-1', ruleId: 'rule-1', deviceId: 'dev-1', severity: 'high' };

/**
 * Queue of results for successive `db.select()` chains. The FIRST is always the
 * automation lookup; the SECOND, when the automation is monitor-managed, is the
 * pause lookup. For unmanaged device events, the SECOND is the ownership lookup.
 */
function mockSelects(...results: unknown[][]) {
  const queue = [...results];
  selectMock.mockReset();
  selectMock.mockImplementation(() => {
    const rows = queue.shift() ?? [];
    const terminal = {
      limit: vi.fn().mockResolvedValue(rows),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(res, rej),
    };
    return {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue(terminal),
    };
  });
}

describe('processTriggerEvent — monitor response pause (#5290)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    createAutomationRunRecordMock.mockResolvedValue({
      run: { id: 'run-1' },
      targetDeviceIds: ['dev-1'],
    });
    executeAutomationRunMock.mockResolvedValue({ status: 'completed' });
    recordEpisodeResponseMock.mockResolvedValue(undefined);
    await shutdownAutomationWorker();
  });

  it('skips a monitor-managed automation when responses_paused is true', async () => {
    mockSelects([MONITOR_AUTOMATION], [{ paused: true }]);

    const result = await __testOnly.processTriggerEvent({ ...BASE_EVENT, eventPayload: PAYLOAD });

    expect(result).toEqual({ skipped: 'monitor_responses_paused' });
    expect(createAutomationRunRecordMock).not.toHaveBeenCalled();
  });

  it('records skipped_paused on the open episode when it skips', async () => {
    mockSelects([MONITOR_AUTOMATION], [{ paused: true }]);

    await __testOnly.processTriggerEvent({ ...BASE_EVENT, eventPayload: PAYLOAD });

    expect(recordEpisodeResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        monitorId: 'monitor-1',
        deviceId: 'dev-1',
        outcome: 'skipped_paused',
      }),
    );
  });

  it('runs the automation and records queued + the run id when responses are not paused', async () => {
    mockSelects([MONITOR_AUTOMATION], [{ paused: false }]);

    const result = await __testOnly.processTriggerEvent({ ...BASE_EVENT, eventPayload: PAYLOAD });

    expect(result).toEqual({ runId: 'run-1' });
    expect(recordEpisodeResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        monitorId: 'monitor-1',
        deviceId: 'dev-1',
        runId: 'run-1',
        outcome: 'queued',
      }),
    );
  });

  it('records skipped_no_response when the monitor automation has no actions', async () => {
    mockSelects([{ ...MONITOR_AUTOMATION, actions: [] }], [{ paused: false }]);

    await __testOnly.processTriggerEvent({ ...BASE_EVENT, eventPayload: PAYLOAD });

    expect(recordEpisodeResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'skipped_no_response' }),
    );
  });

  it('does not consult the pause table for an agent-managed automation', async () => {
    mockSelects([AGENT_AUTOMATION]);

    await __testOnly.processTriggerEvent({
      ...BASE_EVENT,
      automationId: 'auto-agent-1',
      eventPayload: PAYLOAD,
    });

    // Exactly one select: the automation lookup. No pause read, no episode write.
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(recordEpisodeResponseMock).not.toHaveBeenCalled();
  });

  it('does not consult the pause table for an ordinary customer automation', async () => {
    mockSelects([PLAIN_AUTOMATION], [{ orgId: PLAIN_AUTOMATION.orgId, partnerId: null }]);

    await __testOnly.processTriggerEvent({
      ...BASE_EVENT,
      automationId: 'auto-plain-1',
      eventPayload: PAYLOAD,
    });

    expect(createAutomationRunRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({ boundDeviceIds: ['dev-1'] }),
    );
    expect('triggerContext' in addMock.mock.calls[0]?.[1]).toBe(false);
    // Automation lookup + event-device ownership lookup; no pause read.
    expect(selectMock).toHaveBeenCalledTimes(2);
    expect(selectMock.mock.results[1]?.value.from).toHaveBeenCalledWith(devices);
    for (const query of selectMock.mock.results) {
      expect(query.value.from).not.toHaveBeenCalledWith(monitorDeviceState);
    }
    expect(recordEpisodeResponseMock).not.toHaveBeenCalled();
  });

  it('treats a missing state row as not paused', async () => {
    mockSelects([MONITOR_AUTOMATION], []);

    const result = await __testOnly.processTriggerEvent({ ...BASE_EVENT, eventPayload: PAYLOAD });

    expect(result).toEqual({ runId: 'run-1' });
  });
});
