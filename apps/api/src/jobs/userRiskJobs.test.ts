import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getJobMock, addMock, addBulkMock, closeMock, selectMock, fromMock, whereMock, groupByMock, workerProcessors } = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  addBulkMock: vi.fn(),
  closeMock: vi.fn(),
  selectMock: vi.fn(),
  fromMock: vi.fn(),
  whereMock: vi.fn(),
  groupByMock: vi.fn(),
  workerProcessors: [] as Array<(job: { data: unknown }) => Promise<unknown>>,
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    addBulk = addBulkMock;
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
  db: {
    select: selectMock,
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  organizationUsers: { orgId: 'organizationUsers.orgId' },
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

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

import {
  buildUserRiskSignalEventJobId,
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
    addBulkMock.mockReset();
    closeMock.mockReset();
    selectMock.mockReset();
    fromMock.mockReset();
    whereMock.mockReset();
    groupByMock.mockReset();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    addBulkMock.mockResolvedValue([]);
    selectMock.mockReturnValue({ from: fromMock });
    fromMock.mockReturnValue({ where: whereMock });
    whereMock.mockReturnValue({ groupBy: groupByMock });
    groupByMock.mockResolvedValue([{ orgId: 'org-1' }]);
    workerProcessors.length = 0;
    vi.mocked(shouldProduceMlOutput).mockReset();
    vi.mocked(shouldProduceMlOutput).mockResolvedValue(true);
    vi.mocked(evaluateUserRiskSignalsForOrg).mockReset();
    vi.mocked(evaluateUserRiskSignalsForOrg).mockResolvedValue({
      orgId: 'org-1',
      skipped: false,
      appended: 0,
      deduped: 0,
      failed: 0,
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
    expect(addMock.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      // #1118: jobId uses hyphen separators (0 colons) so BullMQ does not drop
      // the enqueue — a 3-colon id silently throws.
      jobId: expect.stringMatching(/^user-risk-signal-org-1-user-1-[a-f0-9]{24}$/),
    }));
  });

  it('uses a stable BullMQ job id for signal-event ingestion', async () => {
    const input = {
      orgId: 'org-1',
      userId: 'user-1',
      eventType: 'suspicious_login',
      severity: 'high' as const,
      scoreImpact: 12,
      description: 'Suspicious login',
      details: { ip: '203.0.113.10', signals: ['new_geo', 'off_hours'] },
      occurredAt: '2026-03-31T12:00:00.000Z',
    };

    const first = buildUserRiskSignalEventJobId(input);
    const second = buildUserRiskSignalEventJobId({
      ...input,
      details: { signals: ['new_geo', 'off_hours'], ip: '203.0.113.10' },
    });

    expect(first).toBe(second);
    // #1118: BullMQ drops enqueues whose jobId has 1 or 3+ colons. This id must
    // contain zero colons (hyphen-separated).
    expect(first).not.toContain(':');
    await enqueueUserRiskSignalEvent(input);

    expect(getJobMock).toHaveBeenCalledWith(first);
    expect(addMock).toHaveBeenCalledWith(
      'process-signal-event',
      expect.objectContaining({
        type: 'process-signal-event',
        orgId: 'org-1',
        userId: 'user-1',
        eventType: 'suspicious_login',
      }),
      expect.objectContaining({ jobId: first }),
    );
  });

  it('reuses an active signal-event job with the same fingerprint', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-signal-job',
      getState: vi.fn().mockResolvedValue('active'),
    });

    const jobId = await enqueueUserRiskSignalEvent({
      orgId: 'org-1',
      userId: 'user-1',
      eventType: 'suspicious_login',
      description: 'Suspicious login',
      occurredAt: '2026-03-31T12:00:00.000Z',
    });

    expect(jobId).toBe('existing-signal-job');
    expect(addMock).not.toHaveBeenCalled();
  });

  it('uses worker execution time when scheduled scans fan out org recompute jobs', async () => {
    vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
    createUserRiskWorker();

    vi.setSystemTime(new Date('2026-03-31T18:30:00.000Z'));
    const result = await workerProcessors[0]!({
      data: {
        type: 'scan-orgs',
        queuedAt: '2026-03-31T12:00:00.000Z',
      },
    });

    expect(result).toEqual({ queued: 1 });
    expect(addBulkMock).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'compute-org',
        data: expect.objectContaining({
          type: 'compute-org',
          orgId: 'org-1',
          queuedAt: '2026-03-31T18:30:00.000Z',
        }),
        opts: expect.objectContaining({
          jobId: 'user-risk-org-1-2026-03-31T18',
        }),
      }),
    ]);
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

  it('computes org user risk and publishes when enabled (happy path)', async () => {
    vi.mocked(shouldProduceMlOutput).mockResolvedValue(true);
    vi.mocked(evaluateUserRiskSignalsForOrg).mockResolvedValue({
      orgId: 'org-1',
      skipped: false,
      appended: 2,
      deduped: 1,
      failed: 0,
      candidates: {
        offHoursMassScripts: 1,
        remoteSessionBursts: 1,
        privilegeElevationBursts: 1,
        newGeographyLogins: 0,
      },
    });
    vi.mocked(computeAndPersistOrgUserRisk).mockResolvedValue({
      usersProcessed: 5,
      changedUsers: [{ userId: 'user-1' }],
      autoTrainingAssigned: 2,
      policy: { thresholds: { high: 70 }, interventions: {} },
    } as never);
    vi.mocked(publishUserRiskScoreEvents).mockResolvedValue({
      publishedHigh: 1,
      publishedSpikes: 0,
      failed: 0,
    });

    createUserRiskWorker();
    const result = await workerProcessors[0]!({
      data: { type: 'compute-org', orgId: 'org-1', queuedAt: '2026-03-31T12:00:00.000Z' },
    });

    expect(evaluateUserRiskSignalsForOrg).toHaveBeenCalledWith('org-1');
    expect(computeAndPersistOrgUserRisk).toHaveBeenCalledWith('org-1');
    expect(publishUserRiskScoreEvents).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      orgId: 'org-1',
      usersProcessed: 5,
      changedUsers: 1,
      autoTrainingAssigned: 2,
      signalsAppended: 2,
      signalsDeduped: 1,
      publishedHigh: 1,
      publishedSpikes: 0,
      publishFailures: 0,
    });
  });

  it('runs the org DB compute inside runOutsideDbContext, publishes after it closes (#1105)', async () => {
    const dbModule = await import('../db');
    const calls: string[] = [];
    vi.mocked(dbModule.runOutsideDbContext).mockImplementation(((fn: () => unknown) => {
      calls.push('runOutsideDbContext');
      return fn();
    }) as never);
    vi.mocked(computeAndPersistOrgUserRisk).mockImplementation((async () => {
      calls.push('computeAndPersistOrgUserRisk');
      return {
        usersProcessed: 1,
        changedUsers: [],
        autoTrainingAssigned: 0,
        policy: { thresholds: {}, interventions: {} },
      };
    }) as never);
    vi.mocked(publishUserRiskScoreEvents).mockImplementation((async () => {
      calls.push('publishUserRiskScoreEvents');
      return { publishedHigh: 0, publishedSpikes: 0, failed: 0 };
    }) as never);

    createUserRiskWorker();
    await workerProcessors[0]!({
      data: { type: 'compute-org', orgId: 'org-1', queuedAt: '2026-03-31T12:00:00.000Z' },
    });

    // The DB compute must be wrapped by runOutsideDbContext, and the Redis
    // publish must happen AFTER (not inside) the held context.
    expect(calls.indexOf('runOutsideDbContext')).toBeLessThan(calls.indexOf('computeAndPersistOrgUserRisk'));
    expect(calls.indexOf('computeAndPersistOrgUserRisk')).toBeLessThan(calls.indexOf('publishUserRiskScoreEvents'));
  });

  it('throws when compute-org publishing partially fails (forces BullMQ retry)', async () => {
    const { captureException } = await import('../services/sentry');
    vi.mocked(captureException).mockClear();
    vi.mocked(publishUserRiskScoreEvents).mockResolvedValue({
      publishedHigh: 1,
      publishedSpikes: 0,
      failed: 2,
    });

    createUserRiskWorker();
    await expect(
      workerProcessors[0]!({
        data: { type: 'compute-org', orgId: 'org-1', queuedAt: '2026-03-31T12:00:00.000Z' },
      }),
    ).rejects.toThrow(/failed to publish 2 risk event/);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('throws when signal-event publishing partially fails (forces BullMQ retry)', async () => {
    const { captureException } = await import('../services/sentry');
    vi.mocked(captureException).mockClear();
    vi.mocked(computeAndPersistUserRiskForUser).mockResolvedValue({
      usersProcessed: 1,
      changedUsers: [{ userId: 'user-1' }],
      autoTrainingAssigned: 0,
      policy: { thresholds: {}, interventions: {} },
    } as never);
    vi.mocked(publishUserRiskScoreEvents).mockResolvedValue({
      publishedHigh: 0,
      publishedSpikes: 0,
      failed: 1,
    });

    createUserRiskWorker();
    await expect(
      workerProcessors[0]!({
        data: {
          type: 'process-signal-event',
          orgId: 'org-1',
          userId: 'user-1',
          eventType: 'suspicious_login',
          severity: 'high',
          description: 'Suspicious login',
          queuedAt: '2026-03-31T12:00:00.000Z',
        },
      }),
    ).rejects.toThrow(/failed to publish 1 risk event/);
    expect(appendUserRiskSignalEvent).toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
