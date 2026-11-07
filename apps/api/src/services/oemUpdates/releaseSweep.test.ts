import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  history: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  wheres: [] as unknown[],
  selects: 0,
}));

vi.mock('../../db', () => {
  const chain = (rows: () => unknown[]) => {
    const c: Record<string, unknown> = {
      from: () => c,
      innerJoin: () => c,
      leftJoin: () => c,
      where: (condition: unknown) => {
        state.wheres.push(condition);
        return c;
      },
      orderBy: () => c,
      limit: () => Promise.resolve(rows()),
    };
    return c;
  };
  return {
    db: {
      select: vi.fn((shape: Record<string, unknown>) => {
        state.selects += 1;
        return 'commandStatus' in shape ? chain(() => state.history) : chain(() => state.rows);
      }),
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            state.updates.push(values);
            return Promise.resolve();
          },
        }),
      })),
    },
    withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  };
});

vi.mock('./resolver', () => ({ resolveOemUpdatesLinksForDevices: vi.fn() }));
vi.mock('./candidates', () => ({
  maxDispatchPerTick: () => Number(process.env.OEM_UPDATES_MAX_DISPATCH_PER_TICK) || 200,
}));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
vi.mock('./dispatch', () => ({
  cancelPendingOemUpdateRelease: vi.fn(),
  dispatchOemUpdateRelease: vi.fn(),
  oemReleaseCommandFilter: vi.fn(() => 'release-filter'),
}));

import { captureException } from '../sentry';
import { cancelPendingOemUpdateRelease, dispatchOemUpdateRelease } from './dispatch';
import {
  OEM_RELEASE_GAVE_UP,
  OEM_RELEASE_MAX_ATTEMPTS,
  OEM_RELEASE_RETRY_SPACING_MS,
  runOemReleaseSweep,
} from './releaseSweep';
import { resolveOemUpdatesLinksForDevices, type ResolvedOemUpdatesLink } from './resolver';

const D1 = '00000000-0000-4000-8000-000000000001';
const D2 = '00000000-0000-4000-8000-000000000002';
const NOW = new Date('2027-03-10T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deviceId: D1,
    orgId: 'org-1',
    lane: 'dell',
    takeoverState: 'taken_over',
    reason: null,
    lastAttemptAt: new Date(NOW.getTime() - 30 * 24 * HOUR),
    ...over,
  };
}

function link(over: Record<string, unknown> = {}, vendor: Record<string, unknown> = {}): ResolvedOemUpdatesLink {
  return {
    linkId: 'link-1',
    configPolicyId: 'policy-1',
    assignedPolicyId: 'policy-1',
    invalidStoredSettings: false,
    armedAt: null,
    settings: {
      version: 1,
      enabled: true,
      schedule: { weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4 },
      catchUpNights: 7,
      reboot: 'overnight',
      vendors: { dell: { enabled: true, categories: { driver: true }, blockedUpdateIds: [], ...vendor } },
      ...over,
    },
  } as ResolvedOemUpdatesLink;
}

function seed(rows: Array<Record<string, unknown>>, resolved: ResolvedOemUpdatesLink | null = null) {
  state.rows = rows;
  vi.mocked(resolveOemUpdatesLinksForDevices).mockResolvedValue(
    new Map(resolved ? rows.map((r) => [r.deviceId as string, resolved]) : []),
  );
}

function failedRelease(hoursAgo: number, over: Record<string, unknown> = {}) {
  const at = new Date(NOW.getTime() - hoursAgo * HOUR);
  return { commandStatus: 'failed', createdAt: at, executedAt: at, ...over };
}

beforeEach(() => {
  state.rows = [];
  state.history = [];
  state.updates = [];
  state.wheres = [];
  state.selects = 0;
  vi.mocked(resolveOemUpdatesLinksForDevices).mockReset();
  vi.mocked(dispatchOemUpdateRelease).mockReset();
  vi.mocked(dispatchOemUpdateRelease).mockResolvedValue({ ok: true, commandId: 'release-1' });
  vi.mocked(cancelPendingOemUpdateRelease).mockReset();
  vi.mocked(cancelPendingOemUpdateRelease).mockResolvedValue(true);
  vi.mocked(captureException).mockClear();
});

describe('runOemReleaseSweep: the query', () => {
  it('reads only taken-over and releasing rows, leaving out ephemeral and parked devices', async () => {
    seed([]);
    await runOemReleaseSweep(NOW);
    const { sql, params } = new PgDialect().sqlToQuery(state.wheres[0] as SQL);
    expect(sql).toContain('"takeover_state" in');
    expect(params).toEqual(expect.arrayContaining(['taken_over', 'releasing']));
    expect(sql).toContain('"is_ephemeral"');
    expect(sql).toContain("'unassigned_pool'");
  });

  it('one read and no resolve when nothing is taken over', async () => {
    seed([]);
    await runOemReleaseSweep(NOW);
    expect(state.selects).toBe(1);
    expect(resolveOemUpdatesLinksForDevices).not.toHaveBeenCalled();
  });
});

describe('runOemReleaseSweep: no enabled lane', () => {
  it('takeover_state taken_over and no enabled lane queues one release', async () => {
    seed([row()]);
    await runOemReleaseSweep(NOW);
    expect(dispatchOemUpdateRelease).toHaveBeenCalledTimes(1);
    expect(dispatchOemUpdateRelease).toHaveBeenCalledWith({ deviceId: D1, expectedOrgId: 'org-1', lane: 'dell', actorUserId: null });
    expect(state.updates).toEqual([expect.objectContaining({ takeoverState: 'releasing' })]);
  });

  it.each<[string, ResolvedOemUpdatesLink | null]>([
    ['the link gone', null],
    ['the policy off', link({ enabled: false })],
    ['the vendor off', link({}, { enabled: false })],
    ['the vendor removed', link({ vendors: {} })],
  ])('%s releases', async (_name, resolved) => {
    seed([row()], resolved);
    await runOemReleaseSweep(NOW);
    expect(dispatchOemUpdateRelease).toHaveBeenCalledTimes(1);
  });

  it('unreadable settings are not a decision to stop: no release', async () => {
    seed([row()], { ...link({ enabled: false }), invalidStoredSettings: true });
    await runOemReleaseSweep(NOW);
    expect(dispatchOemUpdateRelease).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it('not re-queued while pending', async () => {
    seed([row({ takeoverState: 'releasing' })]);
    state.history = [{ commandStatus: 'pending', createdAt: NOW, executedAt: null }];
    await runOemReleaseSweep(NOW);
    expect(dispatchOemUpdateRelease).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it('not re-queued while sent', async () => {
    seed([row({ takeoverState: 'releasing' })]);
    state.history = [{ commandStatus: 'sent', createdAt: NOW, executedAt: NOW }];
    await runOemReleaseSweep(NOW);
    expect(dispatchOemUpdateRelease).not.toHaveBeenCalled();
  });

  it('the seam finding one in flight moves the row to releasing', async () => {
    seed([row()]);
    vi.mocked(dispatchOemUpdateRelease).mockResolvedValue({ ok: false, refusal: 'release_in_flight' });
    await runOemReleaseSweep(NOW);
    expect(state.updates).toEqual([expect.objectContaining({ takeoverState: 'releasing' })]);
  });

  it('any other refusal leaves the row to try again next tick', async () => {
    for (const refusal of ['agent_too_old', 'offline', 'cancelled_at_claim', 'trust_denied'] as const) {
      state.updates = [];
      seed([row()]);
      vi.mocked(dispatchOemUpdateRelease).mockResolvedValue({ ok: false, refusal });
      await runOemReleaseSweep(NOW);
      expect(state.updates, refusal).toEqual([]);
    }
    expect(captureException).not.toHaveBeenCalled();
  });

  it('a throw for one device does not stop the others', async () => {
    seed([row({ deviceId: D1 }), row({ deviceId: D2 })]);
    vi.mocked(dispatchOemUpdateRelease).mockRejectedValueOnce(new Error('boom'));
    await expect(runOemReleaseSweep(NOW)).resolves.toBeUndefined();
    expect(dispatchOemUpdateRelease).toHaveBeenCalledTimes(2);
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});

describe('runOemReleaseSweep: a lane is still enabled', () => {
  it('nothing to do for a takeover still wanted', async () => {
    seed([row()], link());
    await runOemReleaseSweep(NOW);
    expect(dispatchOemUpdateRelease).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it('re-enabling before ack keeps the takeover and cancels the release', async () => {
    seed([row({ takeoverState: 'releasing' })], link());
    state.history = [{ commandStatus: 'pending', createdAt: NOW, executedAt: null }];
    await runOemReleaseSweep(NOW);
    expect(cancelPendingOemUpdateRelease).toHaveBeenCalledWith(D1, NOW);
    expect(dispatchOemUpdateRelease).not.toHaveBeenCalled();
    expect(state.updates).toEqual([expect.objectContaining({ takeoverState: 'taken_over' })]);
  });

  it('a release the agent already claimed cannot be cancelled: its ack decides', async () => {
    seed([row({ takeoverState: 'releasing' })], link());
    state.history = [{ commandStatus: 'pending', createdAt: NOW, executedAt: null }];
    vi.mocked(cancelPendingOemUpdateRelease).mockResolvedValue(false);
    await runOemReleaseSweep(NOW);
    expect(state.updates).toEqual([]);
  });

  it('a release already running is not cancelled either', async () => {
    seed([row({ takeoverState: 'releasing' })], link());
    state.history = [{ commandStatus: 'sent', createdAt: NOW, executedAt: NOW }];
    await runOemReleaseSweep(NOW);
    expect(cancelPendingOemUpdateRelease).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it('releasing with nothing in flight goes back to taken over', async () => {
    seed([row({ takeoverState: 'releasing' })], link());
    state.history = [failedRelease(1)];
    await runOemReleaseSweep(NOW);
    expect(state.updates).toEqual([expect.objectContaining({ takeoverState: 'taken_over' })]);
  });

  it('org move does not release when the new org policy also resolves', async () => {
    // The resolver reads the device's org as it is now, and that is all the sweep asks.
    seed([row({ orgId: 'org-moved-to' })], link());
    await runOemReleaseSweep(NOW);
    expect(dispatchOemUpdateRelease).not.toHaveBeenCalled();
  });

  it('an org move with no policy in the new org releases under the new org', async () => {
    seed([row({ orgId: 'org-moved-to' })]);
    await runOemReleaseSweep(NOW);
    expect(vi.mocked(dispatchOemUpdateRelease).mock.calls[0]![0].expectedOrgId).toBe('org-moved-to');
  });
});

describe('runOemReleaseSweep: the retry cap', () => {
  it('is three delivered failures, a day apart', () => {
    expect(OEM_RELEASE_MAX_ATTEMPTS).toBe(3);
    expect(OEM_RELEASE_RETRY_SPACING_MS).toBe(24 * HOUR);
  });

  it('retries a failure once a day has passed', async () => {
    seed([row({ takeoverState: 'releasing' })]);
    state.history = [failedRelease(25)];
    await runOemReleaseSweep(NOW);
    expect(dispatchOemUpdateRelease).toHaveBeenCalledTimes(1);
  });

  it('waits out the day after a failure', async () => {
    seed([row({ takeoverState: 'releasing' })]);
    state.history = [failedRelease(23)];
    await runOemReleaseSweep(NOW);
    expect(dispatchOemUpdateRelease).not.toHaveBeenCalled();
    // Back to taken over, so the row is not read as having one in flight.
    expect(state.updates).toEqual([expect.objectContaining({ takeoverState: 'taken_over' })]);
  });

  it('a timeout that was delivered counts', async () => {
    seed([row()]);
    state.history = [failedRelease(25, { commandStatus: 'timeout' }), failedRelease(50), failedRelease(75)];
    await runOemReleaseSweep(NOW);
    expect(dispatchOemUpdateRelease).not.toHaveBeenCalled();
  });

  it('gives up after the third: says so once, and marks the row', async () => {
    seed([row()]);
    state.history = [failedRelease(25), failedRelease(50), failedRelease(75)];
    await runOemReleaseSweep(NOW);
    expect(dispatchOemUpdateRelease).not.toHaveBeenCalled();
    expect(state.updates).toEqual([expect.objectContaining({ reason: OEM_RELEASE_GAVE_UP })]);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('a row that already gave up stays quiet and sends nothing', async () => {
    seed([row({ reason: OEM_RELEASE_GAVE_UP })]);
    state.history = [failedRelease(25), failedRelease(50), failedRelease(75)];
    await runOemReleaseSweep(NOW);
    expect(dispatchOemUpdateRelease).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('a queued release that expired undelivered is not an attempt', async () => {
    seed([row()]);
    state.history = [
      failedRelease(25, { commandStatus: 'timeout', executedAt: null }),
      failedRelease(50, { commandStatus: 'timeout', executedAt: null }),
      failedRelease(75),
    ];
    await runOemReleaseSweep(NOW);
    expect(dispatchOemUpdateRelease).toHaveBeenCalledTimes(1);
  });

  it('a release that completed but left the takeover standing counts: its answer did not parse', async () => {
    seed([row()]);
    state.history = [
      failedRelease(25, { commandStatus: 'completed' }),
      failedRelease(50, { commandStatus: 'completed' }),
      failedRelease(75, { commandStatus: 'completed' }),
    ];
    await runOemReleaseSweep(NOW);
    expect(dispatchOemUpdateRelease).not.toHaveBeenCalled();
    expect(state.updates).toEqual([expect.objectContaining({ reason: OEM_RELEASE_GAVE_UP })]);
  });

  it('caps releases per tick', async () => {
    vi.stubEnv('OEM_UPDATES_MAX_DISPATCH_PER_TICK', '1');
    try {
      seed([row({ deviceId: D1 }), row({ deviceId: D2 })]);
      await runOemReleaseSweep(NOW);
      expect(dispatchOemUpdateRelease).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('failures from before the last run do not count: a run since is a new takeover', async () => {
    seed([row({ lastAttemptAt: new Date(NOW.getTime() - HOUR) })]);
    state.history = [failedRelease(25), failedRelease(50), failedRelease(75)];
    await runOemReleaseSweep(NOW);
    expect(dispatchOemUpdateRelease).toHaveBeenCalledTimes(1);
  });

  it('a release still pending from before the last run is still in flight', async () => {
    seed([row({ lastAttemptAt: new Date(NOW.getTime() - HOUR) })]);
    state.history = [{ commandStatus: 'pending', createdAt: new Date(NOW.getTime() - 2 * HOUR), executedAt: null }];
    await runOemReleaseSweep(NOW);
    expect(dispatchOemUpdateRelease).not.toHaveBeenCalled();
    expect(state.updates).toEqual([expect.objectContaining({ takeoverState: 'releasing' })]);
  });
});
