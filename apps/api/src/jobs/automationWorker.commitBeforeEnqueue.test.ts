import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #7187 — a trigger handler must not enqueue `execute-run` before the
 * transaction that created the automation_runs row has committed.
 *
 * `trigger-schedule` and `trigger-event` create the run inside a system
 * transaction. If the `execute-run` job is added to the queue inside that same
 * transaction, the execute-run worker (its own connection) can pick it up
 * before commit, find no run, and throw `Automation run not found`. If the
 * transaction rolls back instead, the queue holds a job for a run that never
 * existed. Same class as #3445 / #7103 / #7109 for Run Script.
 *
 * The contract proven here, through the real BullMQ processor: the run row is
 * created with a transaction open, the enqueue happens with none open, and a
 * transaction that fails to commit enqueues nothing.
 */

// `depth`: the ambient context as AsyncLocalStorage would report it.
// `open`: transactions still uncommitted anywhere in the process.
// `failNextCommit`: the next outermost transaction throws after `fn` settles,
// i.e. it rolls back instead of committing.
const txState = vi.hoisted(() => ({ depth: 0, open: 0, failNextCommit: false }));

const {
  addMock,
  getJobMock,
  selectMock,
  createAutomationRunRecordMock,
  recordEpisodeResponseMock,
  drainSubjectResponseOutboxMock,
  captured,
  events,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  getJobMock: vi.fn(),
  selectMock: vi.fn(),
  createAutomationRunRecordMock: vi.fn(),
  recordEpisodeResponseMock: vi.fn(),
  drainSubjectResponseOutboxMock: vi.fn(),
  captured: { processor: null as null | ((job: unknown) => Promise<unknown>) },
  events: [] as Array<{ event: string; depth: number; open: number }>,
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    close = vi.fn();
    getRepeatableJobs = vi.fn(async () => []);
    removeRepeatableByKey = vi.fn(async () => undefined);
  },
  Worker: class {
    constructor(_name: string, processor: (job: unknown) => Promise<unknown>) {
      captured.processor = processor;
    }
    close = vi.fn();
    on = vi.fn();
  },
  Job: class {},
}));

vi.mock('../db', () => ({
  db: { select: selectMock },
  // Hides the ambient context for the whole (async) call — it does NOT commit
  // anything, so `open` is left alone.
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => {
    const saved = txState.depth;
    txState.depth = 0;
    try {
      return await fn();
    } finally {
      txState.depth = saved;
    }
  }),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    const opensTransaction = txState.depth === 0;
    txState.depth += 1;
    if (opensTransaction) txState.open += 1;
    try {
      const result = await fn();
      if (opensTransaction && txState.failNextCommit) {
        txState.failNextCommit = false;
        throw new Error('commit failed');
      }
      return result;
    } finally {
      txState.depth -= 1;
      if (opensTransaction) txState.open -= 1;
    }
  }),
}));

vi.mock('../db/schema', () => ({
  automations: { id: 'id', enabled: 'enabled', retiredAt: 'retiredAt' },
  configPolicyAutomations: {},
  configPolicyEffectiveFeatureLinks: {},
  configurationPolicies: {},
  devices: {},
  deviceGroupMemberships: {},
  deviceGroups: {},
  monitorDeviceState: {},
  organizations: {},
}));

vi.mock('../services/eventBus', () => ({
  getEventBus: vi.fn(() => ({ subscribe: vi.fn() })),
}));

vi.mock('../services/automationRuntime', () => ({
  createAutomationRunRecord: createAutomationRunRecordMock,
  executeAutomationRun: vi.fn(),
  executeConfigPolicyAutomationRun: vi.fn(),
  formatScheduleTriggerKey: vi.fn(),
  isCronDue: vi.fn(() => true),
  normalizeAutomationTrigger: vi.fn((trigger) => trigger),
  checkAutomationTargetsWithinSiteScope: vi.fn(),
  resolveAutomationTargetDeviceIds: vi.fn(),
}));

vi.mock('../services/featureConfigResolver', () => ({
  scanScheduledAutomations: vi.fn(),
  resolveAutomationsForDevice: vi.fn(),
  resolveAutomationsForDeviceWithPolicy: vi.fn(),
  resolveMaintenanceConfigForDevice: vi.fn(),
  isInMaintenanceWindow: vi.fn(),
}));

vi.mock('../services/monitors/episodeService', () => ({
  recordEpisodeResponse: recordEpisodeResponseMock,
}));

vi.mock('../services/subjectResponseOutbox', () => ({
  admitSubjectResponse: vi.fn(),
  drainSubjectResponseOutbox: drainSubjectResponseOutboxMock,
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  isRedisAvailable: vi.fn(() => true),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

vi.mock('../services/permissions', () => ({
  getUserPermissions: vi.fn(),
  canAccessSite: vi.fn(),
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(() => ({})),
}));

import { createAutomationWorker } from './automationWorker';

const SCHEDULE_AUTOMATION = {
  id: 'auto-sched-1',
  orgId: 'org-1',
  partnerId: null,
  enabled: true,
  managedByAgentId: null,
  managedByMonitorId: null,
  createdBy: null,
  trigger: { type: 'schedule', cronExpression: '0 * * * *', timezone: 'UTC' },
  actions: [],
};

const EVENT_AUTOMATION = {
  id: 'auto-event-1',
  orgId: 'org-1',
  partnerId: null,
  enabled: true,
  managedByAgentId: null,
  managedByMonitorId: null,
  createdBy: null,
  trigger: { type: 'event', eventType: 'device.offline' },
  actions: [],
};

const MONITOR_AUTOMATION = {
  ...EVENT_AUTOMATION,
  id: 'auto-monitor-1',
  managedByMonitorId: 'monitor-1',
  trigger: { type: 'event', eventType: 'alert.triggered' },
  actions: [{ type: 'run_script', scriptId: 'script-1' }],
};

function mockSelectRows(...rowSets: unknown[][]) {
  for (const rows of rowSets) {
    selectMock.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
      }),
    });
  }
}

function job(data: Record<string, unknown>) {
  return { name: data.type, id: 'job-1', data };
}

const SCHEDULE_JOB = job({
  type: 'trigger-schedule',
  automationId: SCHEDULE_AUTOMATION.id,
  slotKey: '2026-09-28T00:00',
  scanAt: '2026-09-28T00:00:00.000Z',
});

const EVENT_JOB = job({
  type: 'trigger-event',
  automationId: EVENT_AUTOMATION.id,
  eventType: 'device.offline',
  eventId: 'event-1',
  eventPayload: {},
  eventTimestamp: '2026-09-28T00:00:00.000Z',
});

function executeRunAdds() {
  return addMock.mock.calls.filter(([name]) => name === 'execute-run');
}

beforeEach(() => {
  vi.clearAllMocks();
  selectMock.mockReset();
  txState.depth = 0;
  txState.open = 0;
  txState.failNextCommit = false;
  events.length = 0;
  getJobMock.mockResolvedValue(null);
  addMock.mockImplementation(async (name: string) => {
    events.push({ event: `enqueue:${name}`, depth: txState.depth, open: txState.open });
    return { id: 'queue-job-1' };
  });
  createAutomationRunRecordMock.mockImplementation(async () => {
    events.push({ event: 'run_created', depth: txState.depth, open: txState.open });
    return { run: { id: 'run-1' }, targetDeviceIds: ['device-1'], reused: false };
  });
  recordEpisodeResponseMock.mockImplementation(async () => {
    events.push({ event: 'episode_recorded', depth: txState.depth, open: txState.open });
  });
  drainSubjectResponseOutboxMock.mockResolvedValue(undefined);
  createAutomationWorker();
});

describe('automation trigger handlers enqueue execute-run only after the run commits (#7187)', () => {
  it.each([
    ['trigger-schedule', SCHEDULE_AUTOMATION, SCHEDULE_JOB],
    ['trigger-event', EVENT_AUTOMATION, EVENT_JOB],
  ])('%s: creates the run inside the transaction and enqueues after it commits', async (_name, automation, queueJob) => {
    mockSelectRows([automation]);

    const result = await captured.processor!(queueJob);

    expect(result).toEqual({ runId: 'run-1' });
    const created = events.find((e) => e.event === 'run_created');
    const enqueued = events.find((e) => e.event === 'enqueue:execute-run');
    expect(created?.open).toBe(1);
    expect(enqueued).toBeDefined();
    expect(enqueued?.depth).toBe(0);
    expect(enqueued?.open).toBe(0);
    expect(events.indexOf(enqueued!)).toBeGreaterThan(events.indexOf(created!));
    expect(executeRunAdds()).toEqual([[
      'execute-run',
      expect.objectContaining({ type: 'execute-run', runId: 'run-1', targetDeviceIds: ['device-1'] }),
      expect.objectContaining({ jobId: 'automation-run-run-1' }),
    ]]);
  });

  it.each([
    ['trigger-schedule', SCHEDULE_AUTOMATION, SCHEDULE_JOB],
    ['trigger-event', EVENT_AUTOMATION, EVENT_JOB],
  ])('%s: a transaction that rolls back enqueues nothing', async (_name, automation, queueJob) => {
    mockSelectRows([automation]);
    txState.failNextCommit = true;

    await expect(captured.processor!(queueJob)).rejects.toThrow('commit failed');

    expect(createAutomationRunRecordMock).toHaveBeenCalledTimes(1);
    expect(executeRunAdds()).toEqual([]);
  });

  it('trigger-event (monitor-managed): records the episode response in the run transaction, enqueues after commit', async () => {
    mockSelectRows([MONITOR_AUTOMATION], [{ paused: false }]);

    const result = await captured.processor!(job({
      type: 'trigger-event',
      automationId: MONITOR_AUTOMATION.id,
      eventType: 'alert.triggered',
      eventId: 'event-2',
      eventPayload: { deviceId: 'device-1', alertId: 'alert-1', severity: 'high' },
      eventTimestamp: '2026-09-28T00:00:00.000Z',
    }));

    expect(result).toEqual({ runId: 'run-1' });
    const recorded = events.find((e) => e.event === 'episode_recorded');
    const enqueued = events.find((e) => e.event === 'enqueue:execute-run');
    expect(recorded?.open).toBe(1);
    expect(enqueued?.open).toBe(0);
    expect(events.indexOf(enqueued!)).toBeGreaterThan(events.indexOf(recorded!));
    expect(executeRunAdds()[0]?.[1]).toEqual(expect.objectContaining({
      runId: 'run-1',
      targetDeviceIds: ['device-1'],
      triggerContext: expect.objectContaining({ alertId: 'alert-1', eventId: 'event-2', severity: 'high' }),
    }));
  });

  it('a skipped trigger enqueues nothing and returns the skip unchanged', async () => {
    mockSelectRows([]);

    const result = await captured.processor!(EVENT_JOB);

    expect(result).toEqual({ skipped: 'automation_not_found_or_disabled' });
    expect(addMock).not.toHaveBeenCalled();
  });
});
