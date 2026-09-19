/**
 * alertVerdictScheduler (P2-1 wave B, Task 13).
 *
 * Mocked-DB unit tests for the ungrouped-alert delayed verdict job. Covers:
 *  - `scheduleUngroupedVerdict` — stable jobId, 10-minute delay, job options,
 *    and the `!AI_AGENTS_ENABLED` no-op gate;
 *  - `processUngroupedVerdictJob` — the three re-check conditions (alert
 *    still active, no correlation-group membership, no live verdict) each
 *    skip without throwing, and admission fires `enqueueVerdictRunForAlert`
 *    with `reason: 'ungrouped'` only when all three clear;
 *  - `handleAlertTriggeredEvent` — the subscriber-side routing function
 *    `eventSubscribers.ts` dynamically imports for `alert.triggered`.
 *
 * `enqueueVerdictRunForAlert` itself (dedupe, kill switch, verdict-profile
 * caps) is covered in alertVerdictSubscriber.test.ts / runService.test.ts —
 * mocked here, same as that suite mocks `createAndEnqueueAgentRun`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  addMock,
  queueCloseMock,
  workerCloseMock,
  capturedWorkerProcessor,
  attachWorkerObservabilityMock,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  capturedWorkerProcessor: { current: null as null | ((job: { data: unknown }) => Promise<unknown>) },
  attachWorkerObservabilityMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = (...args: unknown[]) => addMock(...(args as []));
    close = () => queueCloseMock();
  },
  Worker: class {
    constructor(_name: string, processor: (job: { data: unknown }) => Promise<unknown>) {
      capturedWorkerProcessor.current = processor;
    }
    on = vi.fn();
    close = () => workerCloseMock();
  },
  Job: class {},
}));

const shared = vi.hoisted(() => ({ aiAgentsEnabled: true }));

vi.mock('../config/env', () => ({
  get AI_AGENTS_ENABLED() { return shared.aiAgentsEnabled; },
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: (...args: unknown[]) => attachWorkerObservabilityMock(...(args as [])),
}));

vi.mock('../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  getCurrentDbAccessContext: vi.fn(() => undefined),
}));

vi.mock('../db/schema/alerts', () => ({
  alerts: { id: 'id', orgId: 'org_id', status: 'status' },
  alertCorrelationMembers: { id: 'id', orgId: 'org_id', alertId: 'alert_id' },
}));

const latestVerdictsForAlerts = vi.hoisted(() => vi.fn());
vi.mock('../services/aiAgents/alertVerdicts', () => ({ latestVerdictsForAlerts }));

const enqueueVerdictRunForAlert = vi.hoisted(() => vi.fn());
vi.mock('../services/aiAgents/alertVerdictSubscriber', () => ({ enqueueVerdictRunForAlert }));

import { db } from '../db';
import type { BreezeEvent } from '../services/eventBus';
import {
  UNGROUPED_VERDICT_DELAY_MINUTES,
  scheduleUngroupedVerdict,
  processUngroupedVerdictJob,
  handleAlertTriggeredEvent,
  createUngroupedVerdictWorker,
  initializeAlertVerdictScheduler,
  shutdownAlertVerdictScheduler,
} from './alertVerdictScheduler';

const ORG_ID = '00000000-0000-4000-8000-0000000000f1';
const ALERT_ID = '00000000-0000-4000-8000-0000000000f2';

function queueSelect(rows: unknown[]) {
  const whereMock = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) });
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ where: whereMock }),
  } as never);
}

function triggeredEvent(payload: Record<string, unknown> = {}, over: Partial<BreezeEvent> = {}): BreezeEvent {
  return {
    id: 'evt-triggered-1',
    type: 'alert.triggered',
    orgId: ORG_ID,
    source: 'alert-service',
    priority: 'normal',
    payload: { alertId: ALERT_ID, ruleId: 'rule-1', deviceId: 'device-1', severity: 'high', ...payload },
    metadata: { timestamp: '2026-08-29T00:00:00.000Z' },
    ...over,
  } as BreezeEvent;
}

beforeEach(() => {
  shared.aiAgentsEnabled = true;
  addMock.mockReset().mockResolvedValue(undefined);
  queueCloseMock.mockReset().mockResolvedValue(undefined);
  workerCloseMock.mockReset().mockResolvedValue(undefined);
  attachWorkerObservabilityMock.mockReset();
  capturedWorkerProcessor.current = null;
  vi.mocked(db.select).mockReset();
  latestVerdictsForAlerts.mockReset().mockResolvedValue(new Map());
  enqueueVerdictRunForAlert.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('UNGROUPED_VERDICT_DELAY_MINUTES', () => {
  it('is 10 (spec §4.1)', () => {
    expect(UNGROUPED_VERDICT_DELAY_MINUTES).toBe(10);
  });
});

describe('scheduleUngroupedVerdict', () => {
  it('adds a job with a stable jobId, name, and the 10-minute delay', async () => {
    await scheduleUngroupedVerdict(ORG_ID, ALERT_ID);

    expect(addMock).toHaveBeenCalledWith(
      'ungrouped-verdict',
      { orgId: ORG_ID, alertId: ALERT_ID },
      expect.objectContaining({
        jobId: `alert-verdict-${ALERT_ID}`,
        delay: 10 * 60_000,
        removeOnComplete: true,
        removeOnFail: 50,
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
      }),
    );
  });

  it('jobId is hyphen-only (no colon)', async () => {
    await scheduleUngroupedVerdict(ORG_ID, ALERT_ID);
    const [, , opts] = addMock.mock.calls[0] as [string, unknown, { jobId: string }];
    expect(opts.jobId).not.toContain(':');
  });

  it('is a no-op when AI_AGENTS_ENABLED is false', async () => {
    shared.aiAgentsEnabled = false;
    await scheduleUngroupedVerdict(ORG_ID, ALERT_ID);
    expect(addMock).not.toHaveBeenCalled();
  });
});

describe('processUngroupedVerdictJob', () => {
  it('enqueues a verdict run when the alert is active, ungrouped, and unverdicted', async () => {
    queueSelect([{ id: ALERT_ID, status: 'active' }]); // alert lookup
    queueSelect([]); // no correlation-member row
    latestVerdictsForAlerts.mockResolvedValue(new Map());

    await processUngroupedVerdictJob({ orgId: ORG_ID, alertId: ALERT_ID });

    expect(enqueueVerdictRunForAlert).toHaveBeenCalledWith(ORG_ID, ALERT_ID, 'ungrouped');
  });

  it('skips when the alert is not found (or not in org)', async () => {
    queueSelect([]); // alert lookup: no row

    await processUngroupedVerdictJob({ orgId: ORG_ID, alertId: ALERT_ID });

    expect(enqueueVerdictRunForAlert).not.toHaveBeenCalled();
  });

  it('skips when the alert is no longer active', async () => {
    queueSelect([{ id: ALERT_ID, status: 'resolved' }]);

    await processUngroupedVerdictJob({ orgId: ORG_ID, alertId: ALERT_ID });

    expect(enqueueVerdictRunForAlert).not.toHaveBeenCalled();
  });

  it('skips when a correlation-group membership row already exists', async () => {
    queueSelect([{ id: ALERT_ID, status: 'active' }]);
    queueSelect([{ id: 'member-1' }]); // membership row present

    await processUngroupedVerdictJob({ orgId: ORG_ID, alertId: ALERT_ID });

    expect(enqueueVerdictRunForAlert).not.toHaveBeenCalled();
    expect(latestVerdictsForAlerts).not.toHaveBeenCalled();
  });

  it('skips when the alert already carries a live verdict', async () => {
    queueSelect([{ id: ALERT_ID, status: 'active' }]);
    queueSelect([]); // no membership
    latestVerdictsForAlerts.mockResolvedValue(new Map([[ALERT_ID, { id: 'verdict-1' }]]));

    await processUngroupedVerdictJob({ orgId: ORG_ID, alertId: ALERT_ID });

    expect(enqueueVerdictRunForAlert).not.toHaveBeenCalled();
  });

  it('propagates a rejection from enqueueVerdictRunForAlert so BullMQ retries the job', async () => {
    queueSelect([{ id: ALERT_ID, status: 'active' }]);
    queueSelect([]);
    latestVerdictsForAlerts.mockResolvedValue(new Map());
    enqueueVerdictRunForAlert.mockRejectedValue(new Error('enqueue boom'));

    await expect(processUngroupedVerdictJob({ orgId: ORG_ID, alertId: ALERT_ID })).rejects.toThrow('enqueue boom');
  });
});

describe('worker wiring', () => {
  it('createUngroupedVerdictWorker wires its processor to processUngroupedVerdictJob', async () => {
    queueSelect([{ id: ALERT_ID, status: 'active' }]);
    queueSelect([]);
    latestVerdictsForAlerts.mockResolvedValue(new Map());

    createUngroupedVerdictWorker();
    await capturedWorkerProcessor.current!({ data: { orgId: ORG_ID, alertId: ALERT_ID } });

    expect(enqueueVerdictRunForAlert).toHaveBeenCalledWith(ORG_ID, ALERT_ID, 'ungrouped');
  });

  it('initializeAlertVerdictScheduler attaches observability and shutdown closes the queue/worker', async () => {
    await initializeAlertVerdictScheduler();
    expect(attachWorkerObservabilityMock).toHaveBeenCalledWith(expect.anything(), 'alertVerdictScheduler');

    await scheduleUngroupedVerdict(ORG_ID, ALERT_ID); // opens the queue singleton
    await shutdownAlertVerdictScheduler();

    expect(workerCloseMock).toHaveBeenCalled();
    expect(queueCloseMock).toHaveBeenCalled();
  });
});

describe('handleAlertTriggeredEvent (subscriber routing, controller decision 1)', () => {
  it('schedules an ungrouped verdict for a well-formed alert.triggered event', async () => {
    await handleAlertTriggeredEvent(triggeredEvent());

    expect(addMock).toHaveBeenCalledWith(
      'ungrouped-verdict',
      { orgId: ORG_ID, alertId: ALERT_ID },
      expect.objectContaining({ jobId: `alert-verdict-${ALERT_ID}` }),
    );
  });

  it('drops (no throw, no schedule) a malformed event missing alertId', async () => {
    await expect(
      handleAlertTriggeredEvent(triggeredEvent({ alertId: undefined })),
    ).resolves.toBeUndefined();
    expect(addMock).not.toHaveBeenCalled();
  });

  it('is a no-op when AI_AGENTS_ENABLED is false', async () => {
    shared.aiAgentsEnabled = false;
    await handleAlertTriggeredEvent(triggeredEvent());
    expect(addMock).not.toHaveBeenCalled();
  });
});
