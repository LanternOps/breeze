import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getJobMock, addMock, closeMock, workerProcessors } = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  closeMock: vi.fn(),
  workerProcessors: [] as Array<(job: { data: unknown }) => Promise<unknown>>,
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    close = closeMock;
  },
  Worker: class {
    constructor(_name: string, processor: (job: { data: unknown }) => Promise<unknown>) {
      workerProcessors.push(processor);
    }
    close = closeMock;
    on = vi.fn();
  },
  Job: class {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../db', () => ({
  db: {},

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  organizationUsers: {},
}));

vi.mock('../services/userRiskScoring', () => ({
  appendUserRiskSignalEvent: vi.fn(),
  computeAndPersistUserRiskForUser: vi.fn(),
  computeAndPersistOrgUserRisk: vi.fn(),
  publishUserRiskScoreEvents: vi.fn(),
}));

vi.mock('../services/userRiskSignals', () => ({
  evaluateUserRiskSignalsForOrg: vi.fn(),
}));

vi.mock('../services/mlFeatureFlags', () => ({
  shouldProduceMlOutput: vi.fn(),
}));

import {
  createUserRiskWorker,
  enqueueUserRiskSignalEvent,
  shutdownUserRiskJobs,
  triggerUserRiskRecompute,
} from './userRiskJobs';
import {
  appendUserRiskSignalEvent,
  computeAndPersistOrgUserRisk,
  computeAndPersistUserRiskForUser,
  publishUserRiskScoreEvents,
} from '../services/userRiskScoring';
import { evaluateUserRiskSignalsForOrg } from '../services/userRiskSignals';
import { shouldProduceMlOutput } from '../services/mlFeatureFlags';

describe('triggerUserRiskRecompute', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
    getJobMock.mockReset();
    addMock.mockReset();
    closeMock.mockReset();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    workerProcessors.length = 0;
    vi.mocked(shouldProduceMlOutput).mockReset();
    vi.mocked(shouldProduceMlOutput).mockResolvedValue(true);
    vi.mocked(evaluateUserRiskSignalsForOrg).mockReset();
    vi.mocked(evaluateUserRiskSignalsForOrg).mockResolvedValue({
      orgId: 'org-1',
      skipped: false,
      appended: 0,
      deduped: 0,
      candidates: {
        offHoursMassScripts: 0,
        remoteSessionBursts: 0,
        privilegeElevationBursts: 0,
        newGeographyLogins: 0,
      },
    });
    vi.mocked(computeAndPersistOrgUserRisk).mockReset();
    vi.mocked(computeAndPersistOrgUserRisk).mockResolvedValue({
      usersProcessed: 0,
      changedUsers: [],
      autoTrainingAssigned: 0,
      policy: { thresholds: {}, interventions: {} },
    } as never);
    vi.mocked(computeAndPersistUserRiskForUser).mockReset();
    vi.mocked(computeAndPersistUserRiskForUser).mockResolvedValue({
      usersProcessed: 1,
      changedUsers: [],
      autoTrainingAssigned: 0,
      policy: { thresholds: {}, interventions: {} },
    } as never);
    vi.mocked(appendUserRiskSignalEvent).mockReset();
    vi.mocked(appendUserRiskSignalEvent).mockResolvedValue('event-1');
    vi.mocked(publishUserRiskScoreEvents).mockReset();
    vi.mocked(publishUserRiskScoreEvents).mockResolvedValue({
      publishedHigh: 0,
      publishedSpikes: 0,
      failed: 0,
    });
    await shutdownUserRiskJobs();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a stable BullMQ job id for org recompute requests', async () => {
    await triggerUserRiskRecompute('org-1');

    expect(addMock).toHaveBeenCalledWith(
      'compute-org',
      expect.objectContaining({ orgId: 'org-1' }),
      expect.objectContaining({
        jobId: expect.stringMatching(/^user-risk-recompute:org-1:[a-z0-9]+$/),
      }),
    );
  });

  it('reuses an active recompute job for the same org within the dedupe window', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-job',
      getState: vi.fn().mockResolvedValue('delayed'),
    });

    const jobId = await triggerUserRiskRecompute('org-1');

    expect(jobId).toBe('existing-job');
    expect(addMock).not.toHaveBeenCalled();
  });

  it('caps signal-event payload strings and drops oversized details', async () => {
    await enqueueUserRiskSignalEvent({
      orgId: 'org-1',
      userId: 'user-1',
      eventType: 'e'.repeat(300),
      description: 'd'.repeat(2000),
      details: { oversized: 'x'.repeat(20 * 1024) },
    });

    expect(addMock).toHaveBeenCalledTimes(1);
    const queued = addMock.mock.calls[0]?.[1];
    expect(queued.eventType).toHaveLength(128);
    expect(queued.description).toHaveLength(1024);
    expect(queued.details).toBeUndefined();
  });

  it('skips scheduled org recompute output when user-risk v0 is disabled', async () => {
    vi.mocked(shouldProduceMlOutput).mockResolvedValue(false);
    createUserRiskWorker();

    const result = await workerProcessors[0]!({
      data: {
        type: 'compute-org',
        orgId: 'org-1',
        queuedAt: '2026-03-31T12:00:00.000Z',
      },
    });

    expect(shouldProduceMlOutput).toHaveBeenCalledWith('org-1', 'ml.user_risk_v0.enabled');
    expect(evaluateUserRiskSignalsForOrg).not.toHaveBeenCalled();
    expect(computeAndPersistOrgUserRisk).not.toHaveBeenCalled();
    expect(publishUserRiskScoreEvents).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      orgId: 'org-1',
      skipped: true,
      usersProcessed: 0,
      changedUsers: 0,
      autoTrainingAssigned: 0,
      signalsAppended: 0,
      signalsDeduped: 0,
      publishedHigh: 0,
      publishedSpikes: 0,
      publishFailures: 0,
    });
  });

  it('skips signal-event ingestion and recompute when user-risk v0 is disabled', async () => {
    vi.mocked(shouldProduceMlOutput).mockResolvedValue(false);
    createUserRiskWorker();

    const result = await workerProcessors[0]!({
      data: {
        type: 'process-signal-event',
        orgId: 'org-1',
        userId: 'user-1',
        eventType: 'suspicious_login',
        severity: 'high',
        description: 'Suspicious login',
        queuedAt: '2026-03-31T12:00:00.000Z',
      },
    });

    expect(shouldProduceMlOutput).toHaveBeenCalledWith('org-1', 'ml.user_risk_v0.enabled');
    expect(appendUserRiskSignalEvent).not.toHaveBeenCalled();
    expect(computeAndPersistUserRiskForUser).not.toHaveBeenCalled();
    expect(publishUserRiskScoreEvents).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      orgId: 'org-1',
      userId: 'user-1',
      eventId: null,
      skipped: true,
      recomputed: false,
      changedUsers: 0,
      publishedHigh: 0,
      publishedSpikes: 0,
      publishFailures: 0,
    });
  });
});
