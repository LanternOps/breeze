import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { db } from '../db';
import { persistOfflineTransition } from '../services/offlineEffectsStore';

const { getJobMock, addMock, closeMock, getRepeatableJobsMock, workerOptions } = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  closeMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(async () => []),
  workerOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('../services/offlineEffectsStore', () => ({
  persistOfflineTransition: vi.fn(async () => ['effect-id']),
  findDueOfflineEffects: vi.fn(async () => []),
  pruneOfflineEffects: vi.fn(async () => 0),
}));
vi.mock('../services/offlineTransitionEffects', () => ({ processOfflineEffect: vi.fn() }));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    addBulk = vi.fn(async () => []);
    close = closeMock;
    getRepeatableJobs = getRepeatableJobsMock;
    removeRepeatableByKey = vi.fn();
  },
  Worker: class {
    constructor(_name: string, _processor: unknown, options: Record<string, unknown>) {
      workerOptions.push(options);
    }
    close = closeMock;
    on = vi.fn();
  },
  Job: class {},
}));

vi.mock('../db', () => ({
  db: { update: vi.fn(), select: vi.fn() },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', async () => ({
  devices: (await import('../db/schema/devices')).devices,
  alertRules: {},
  alertTemplates: {},
  alerts: {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn(),
}));

vi.mock('../services/alertService', () => ({
  // #2128: and() drops undefined, so this stub keeps the mocked rule query unchanged
  alertRuleOwnershipConditionForOrg: vi.fn(async () => undefined),
  createAlert: vi.fn(),
}));

vi.mock('../services/alertConditions', () => ({
  interpolateTemplate: vi.fn(),
}));

import {
  createOfflineWorker,
  offlineTransitionId,
  processMarkOffline,
  resolveOfflineWorkerConcurrency,
  scheduleOfflineJobs,
  shutdownOfflineDetector,
  transitionDeviceOffline,
  triggerOfflineDetection,
} from './offlineDetector';

describe('processMarkOffline timestamp precision', () => {
  it.each(['2026-09-16T10:00:00.123456Z', '2026-09-16T10:00:00.123000Z'])(
    'compares the SQL timestamp at payload precision for %s', async (rawTimestamp) => {
      const deviceId = '00000000-0000-4000-8000-000000000001';
      const orgId = '10000000-0000-4000-8000-000000000001';
      const observedLastSeenAt = new Date(rawTimestamp).toISOString();
      const transitionId = offlineTransitionId(orgId, deviceId, observedLastSeenAt);
      const device = { id: deviceId, orgId, status: 'offline' };
      const where = vi.fn((predicate: SQL) => {
        // Compile the real Drizzle predicate: a Date-only mock would hide the
        // mismatch between PostgreSQL microseconds and the serialized observation.
        const query = new PgDialect().sqlToQuery(predicate);
        expect(query.sql).toContain(`date_trunc('milliseconds', "devices"."last_seen_at") = $5`);
        expect(query.sql).toContain('"devices"."id" = $1');
        expect(query.sql).toContain('"devices"."org_id" = $2');
        expect(query.sql).toContain('"devices"."status" in ($3, $4)');
        expect(query.params).toEqual([deviceId, orgId, 'online', 'updating', observedLastSeenAt]);
        return { returning: vi.fn(async () => [device]) };
      });
      vi.mocked(db.update).mockReturnValue({ set: vi.fn(() => ({ where })) } as never);

      await expect(processMarkOffline({
        type: 'mark-offline', deviceId, orgId, observedLastSeenAt, transitionId,
      })).resolves.toEqual({ transitioned: true, alertCreated: false });
      expect(where).toHaveBeenCalledOnce();
      expect(persistOfflineTransition).toHaveBeenCalledWith(device, transitionId, observedLastSeenAt);
    },
  );
});

describe('transitionDeviceOffline (#6503 — WS close/error handlers)', () => {
  afterEach(() => {
    vi.mocked(persistOfflineTransition).mockClear();
  });

  it('persists an offline transition effect for an online device, mirroring processMarkOffline', async () => {
    const agentId = 'agent-6503';
    const deviceId = '00000000-0000-4000-8000-000000000002';
    const orgId = '10000000-0000-4000-8000-000000000002';
    const lastSeenAt = new Date('2026-09-16T10:00:00.000Z');
    const device = {
      id: deviceId, orgId, status: 'online', lastSeenAt,
      hostname: 'host-1', siteId: null, isEphemeral: false,
    };
    const observedLastSeenAt = lastSeenAt.toISOString();
    const expectedTransitionId = offlineTransitionId(orgId, deviceId, observedLastSeenAt);

    const selectLimit = vi.fn(async () => [device]);
    vi.mocked(db.select).mockReturnValue({
      from: () => ({ where: () => ({ limit: selectLimit }) }),
    } as never);

    const updateWhere = vi.fn(() => ({ returning: vi.fn(async () => [device]) }));
    vi.mocked(db.update).mockReturnValue({ set: () => ({ where: updateWhere }) } as never);

    await expect(transitionDeviceOffline(agentId, ['online'])).resolves.toEqual({ transitioned: true });

    // The bug (#6503): the old WS close/error handlers wrote status='offline'
    // directly via a bare update and NEVER called persistOfflineTransition, so
    // no offline_transition_effects row (and therefore no monitor-rule
    // evaluation via expandOfflineAlertPlan) was ever produced for an agent
    // that closed its WebSocket. This assertion is what would have failed
    // against that old code path.
    expect(persistOfflineTransition).toHaveBeenCalledWith(device, expectedTransitionId, observedLastSeenAt);
  });

  it('does not transition or persist anything when the device is not in an allowed source status', async () => {
    const selectLimit = vi.fn(async () => []);
    vi.mocked(db.select).mockReturnValue({
      from: () => ({ where: () => ({ limit: selectLimit }) }),
    } as never);
    const updateCallsBefore = vi.mocked(db.update).mock.calls.length;

    await expect(transitionDeviceOffline('agent-not-online', ['online'])).resolves.toEqual({ transitioned: false });
    expect(persistOfflineTransition).not.toHaveBeenCalled();
    expect(vi.mocked(db.update).mock.calls.length).toBe(updateCallsBefore);
  });
});

describe('triggerOfflineDetection', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
    getJobMock.mockReset();
    addMock.mockReset();
    closeMock.mockReset();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    getRepeatableJobsMock.mockClear();
    workerOptions.length = 0;
    await shutdownOfflineDetector();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a stable BullMQ job id for manual offline detection requests', async () => {
    await triggerOfflineDetection(10);

    expect(addMock).toHaveBeenCalledWith(
      'detect-offline',
      expect.objectContaining({ thresholdMinutes: 10 }),
      expect.objectContaining({
        jobId: expect.stringMatching(/^offline-detect:10:[a-z0-9]+$/),
      }),
    );
  });

  it('reuses an active offline detection job within the dedupe window', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-job',
      getState: vi.fn().mockResolvedValue('delayed'),
    });

    const jobId = await triggerOfflineDetection();

    expect(jobId).toBe('existing-job');
    expect(addMock).not.toHaveBeenCalled();
  });
});

describe('offline detector scheduling and worker bounds', () => {
  beforeEach(async () => {
    addMock.mockClear();
    getRepeatableJobsMock.mockClear();
    workerOptions.length = 0;
    delete process.env.OFFLINE_DETECTOR_WORKER_CONCURRENCY;
    await shutdownOfflineDetector();
  });

  afterEach(() => {
    delete process.env.OFFLINE_DETECTOR_WORKER_CONCURRENCY;
  });

  it('uses a fixed seven-second offset for the thirty-second root repeat', async () => {
    await scheduleOfflineJobs();

    expect(addMock).toHaveBeenCalledWith(
      'detect-offline',
      { type: 'detect-offline' },
      expect.objectContaining({ repeat: { every: 30_000, offset: 7_000 } }),
    );
  });

  it.each([
    [undefined, 5],
    ['', 5],
    ['   ', 5],
    ['1', 1],
    ['20', 20],
    ['0', 1],
    ['-4', 1],
    ['1.5', 5],
    ['nope', 5],
    ['21', 20],
  ])('resolves worker concurrency %s to %i', (raw, expected) => {
    expect(resolveOfflineWorkerConcurrency(raw)).toBe(expected);
  });

  it('passes bounded configured concurrency to BullMQ', () => {
    process.env.OFFLINE_DETECTOR_WORKER_CONCURRENCY = '200';
    createOfflineWorker();

    expect(workerOptions.at(-1)).toEqual(expect.objectContaining({ concurrency: 20 }));
  });
});
