import { beforeEach, describe, expect, it, vi } from 'vitest';

// #5128 W3 — the next-occurrence clock and the supersession sweep.
//
// Separate from patchSchedulerWorker.test.ts because that suite's `db` double is
// shaped for exactly one query (loadDeviceSchedulingContexts' join chain); the
// supersession sweep issues three different shapes and needs its own.

let selectQueue: Array<() => unknown> = [];
const recordedUpdates: Array<{ values: Record<string, unknown>; returned: unknown[] }> = [];
let updateReturns: unknown[][] = [];

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      const next = selectQueue.shift();
      if (!next) throw new Error('unexpected db.select call');
      return next();
    }),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => {
            const returned = updateReturns.shift() ?? [];
            recordedUpdates.push({ values, returned });
            return Promise.resolve(returned);
          }),
        })),
      })),
    })),
    insert: vi.fn(),
  },
  withSystemDbAccessContext: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../db/schema', () => ({
  configurationPolicies: {},
  configPolicyEffectiveFeatureLinks: {},
  configPolicyAssignments: {},
  deviceCommands: {
    id: 'deviceCommands.id',
    deviceId: 'deviceCommands.deviceId',
    type: 'deviceCommands.type',
    status: 'deviceCommands.status',
    payload: 'deviceCommands.payload',
  },
  patchJobs: {
    id: 'patchJobs.id',
    orgId: 'patchJobs.orgId',
    configPolicyId: 'patchJobs.configPolicyId',
    status: 'patchJobs.status',
  },
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
  deviceGroupMemberships: {},
  deviceGroups: {},
  organizations: {},
  partners: {},
  sites: {},
}));

vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/featureConfigResolver', () => ({ checkDeviceMaintenanceWindow: vi.fn() }));
vi.mock('./patchJobExecutor', () => ({
  enqueuePatchJob: vi.fn(),
  selectStaleScheduledJobIds: vi.fn(),
  filterOrphanedJobIds: vi.fn(),
}));
vi.mock('../services/patchJobFinalizer', () => ({ finalizePatchJobDevice: vi.fn() }));
vi.mock('../services/sensitiveCommandPayload', () => ({
  terminalPayloadErasureSet: vi.fn(() => ({ payload: null })),
}));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/patchJobSnapshot', () => ({ buildPatchesSnapshot: vi.fn() }));
vi.mock('../services/configPolicyPatching', () => ({
  backfillMissingPatchSettings: vi.fn(),
  listAllPatchInventory: vi.fn(),
  loadPolicyLocalPatchConfig: vi.fn(),
  summarizePatchInventory: vi.fn(),
}));
vi.mock('bullmq', () => ({ Queue: class {}, Worker: class {}, Job: class {} }));

import { getNextOccurrenceAt, __testOnly } from './patchSchedulerWorker';
import { finalizePatchJobDevice } from '../services/patchJobFinalizer';

const { supersedePreviousOccurrenceInstalls } = __testOnly;

function whereChain(rows: unknown[]) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  return chain;
}

type Settings = Parameters<typeof getNextOccurrenceAt>[0];

const BASE_SETTINGS = {
  scheduleFrequency: 'daily',
  scheduleTime: '02:00',
  scheduleDayOfWeek: 'sun',
  scheduleDayOfMonth: 1,
};

function make(overrides: Record<string, unknown>): Settings {
  return { ...BASE_SETTINGS, ...overrides } as unknown as Settings;
}

describe('getNextOccurrenceAt (#5128 W3)', () => {
  it('returns tomorrow for a daily schedule whose time has already passed today', () => {
    // 2026-03-10 09:00 UTC; the 02:00 UTC run is behind us.
    const now = new Date('2026-03-10T09:00:00.000Z');
    const next = getNextOccurrenceAt(make({ scheduleFrequency: 'daily' }), 'UTC', now);
    expect(next?.toISOString()).toBe('2026-03-11T02:00:00.000Z');
  });

  it('returns later today for a daily schedule whose time is still ahead', () => {
    const now = new Date('2026-03-10T01:00:00.000Z');
    const next = getNextOccurrenceAt(make({ scheduleFrequency: 'daily' }), 'UTC', now);
    expect(next?.toISOString()).toBe('2026-03-10T02:00:00.000Z');
  });

  it('never returns the occurrence firing right now (strictly after)', () => {
    // Exactly on the schedule instant — the job being created right now must not
    // become its own deadline, or every queued install would expire immediately.
    const now = new Date('2026-03-10T02:00:00.000Z');
    const next = getNextOccurrenceAt(make({ scheduleFrequency: 'daily' }), 'UTC', now);
    expect(next?.toISOString()).toBe('2026-03-11T02:00:00.000Z');
  });

  it('walks to the next matching weekday for a weekly schedule', () => {
    // 2026-03-10 is a Tuesday; next Sunday is 2026-03-15.
    const now = new Date('2026-03-10T09:00:00.000Z');
    const next = getNextOccurrenceAt(
      make({ scheduleFrequency: 'weekly', scheduleDayOfWeek: 'sun' }),
      'UTC',
      now,
    );
    expect(next?.toISOString()).toBe('2026-03-15T02:00:00.000Z');
  });

  it('rolls a monthly schedule into the following month', () => {
    // Day-of-month 5, already past on 2026-03-10 → 2026-04-05.
    const now = new Date('2026-03-10T09:00:00.000Z');
    const next = getNextOccurrenceAt(
      make({ scheduleFrequency: 'monthly', scheduleDayOfMonth: 5 }),
      'UTC',
      now,
    );
    expect(next?.toISOString()).toBe('2026-04-05T02:00:00.000Z');
  });

  it('rolls a monthly schedule across a year boundary', () => {
    const now = new Date('2026-12-20T09:00:00.000Z');
    const next = getNextOccurrenceAt(
      make({ scheduleFrequency: 'monthly', scheduleDayOfMonth: 5 }),
      'UTC',
      now,
    );
    expect(next?.toISOString()).toBe('2027-01-05T02:00:00.000Z');
  });

  it('resolves the wall-clock time in the policy timezone, not UTC', () => {
    // 02:00 America/New_York on 2026-03-10 (EDT, UTC-4) = 06:00 UTC.
    const now = new Date('2026-03-10T09:00:00.000Z');
    const next = getNextOccurrenceAt(make({ scheduleFrequency: 'daily' }), 'America/New_York', now);
    expect(next?.toISOString()).toBe('2026-03-11T06:00:00.000Z');
  });

  it('lands on the correct wall-clock time across a DST spring-forward', () => {
    // US DST starts 2026-03-08. On 2026-03-07 the offset is still EST (UTC-5);
    // the next 02:00 local run is on the 8th, by which time it is EDT (UTC-4).
    const now = new Date('2026-03-07T12:00:00.000Z');
    const next = getNextOccurrenceAt(make({ scheduleFrequency: 'daily' }), 'America/New_York', now);
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(next!);
    // 02:00 does not exist on a spring-forward day. The window must shift
    // FORWARD into the gap (03:00), never backward: a convergence loop settles
    // on 01:00, an hour before the window the admin asked for.
    expect(local).toBe('03:00');
  });

  it('returns null for a frequency the due-check would never fire on', () => {
    const next = getNextOccurrenceAt(
      make({ scheduleFrequency: 'hourly' as unknown as 'daily' }),
      'UTC',
      new Date(),
    );
    expect(next).toBeNull();
  });
});

describe('supersedePreviousOccurrenceInstalls (#5128 W3)', () => {
  const NOW = new Date('2026-03-15T02:00:00.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue = [];
    updateReturns = [];
    recordedUpdates.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('cancels only the pending installs that belong to a previous job of the same policy', async () => {
    selectQueue = [
      // previous jobs for this policy
      () => whereChain([{ id: 'job-prev' }]),
      // pending install_patches rows for the targeted devices
      () =>
        whereChain([
          { id: 'cmd-a', deviceId: 'device-1', payload: { patchJobId: 'job-prev' } },
          // A different policy's job — must be left alone.
          { id: 'cmd-b', deviceId: 'device-2', payload: { patchJobId: 'job-other' } },
          // No patchJobId at all (pre-W3 command) — left alone.
          { id: 'cmd-c', deviceId: 'device-3', payload: { patchIds: ['p1'] } },
        ]),
    ];
    updateReturns = [[{ id: 'cmd-a' }]];

    const count = await supersedePreviousOccurrenceInstalls({
      configPolicyId: 'policy-1',
      orgId: 'org-1',
      newJobId: 'job-new',
      deviceIds: ['device-1', 'device-2', 'device-3'],
      now: NOW,
    });

    expect(count).toBe(1);
    expect(recordedUpdates).toHaveLength(1);
    expect(recordedUpdates[0]!.values.status).toBe('cancelled');
    expect(recordedUpdates[0]!.values.result).toMatchObject({
      status: 'cancelled',
      reason: 'superseded_by_next_occurrence',
    });
    expect(finalizePatchJobDevice).toHaveBeenCalledTimes(1);
    expect(finalizePatchJobDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        patchJobId: 'job-prev',
        deviceId: 'device-1',
        commandId: 'cmd-a',
        terminal: { kind: 'superseded', byJobId: 'job-new' },
      }),
    );
  });

  it('does not finalise a row that lost the pending CAS to a concurrent claim', async () => {
    selectQueue = [
      () => whereChain([{ id: 'job-prev' }]),
      () => whereChain([{ id: 'cmd-a', deviceId: 'device-1', payload: { patchJobId: 'job-prev' } }]),
    ];
    // The UPDATE matched nothing: the heartbeat claimed it between SELECT and here.
    updateReturns = [[]];

    const count = await supersedePreviousOccurrenceInstalls({
      configPolicyId: 'policy-1',
      orgId: 'org-1',
      newJobId: 'job-new',
      deviceIds: ['device-1'],
      now: NOW,
    });

    expect(count).toBe(0);
    // Terminalising the patch result here would close out an install that is on
    // its way to the machine right now.
    expect(finalizePatchJobDevice).not.toHaveBeenCalled();
  });

  it('short-circuits when the policy has no earlier open job', async () => {
    selectQueue = [() => whereChain([])];

    const count = await supersedePreviousOccurrenceInstalls({
      configPolicyId: 'policy-1',
      orgId: 'org-1',
      newJobId: 'job-new',
      deviceIds: ['device-1'],
      now: NOW,
    });

    expect(count).toBe(0);
    expect(recordedUpdates).toHaveLength(0);
  });

  it('does no work at all for an empty device set', async () => {
    const count = await supersedePreviousOccurrenceInstalls({
      configPolicyId: 'policy-1',
      orgId: 'org-1',
      newJobId: 'job-new',
      deviceIds: [],
      now: NOW,
    });

    expect(count).toBe(0);
    expect(selectQueue).toHaveLength(0);
  });
});
