import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  tonightsReboots: [] as Array<{ id: string }>,
  clockRun: { trigger: 'scheduled', occurrenceKey: '2027-03' } as Record<string, unknown> | null,
  updates: [] as Array<Record<string, unknown>>,
  wheres: [] as unknown[],
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
        if ('commandId' in shape) return chain(() => state.tonightsReboots);
        if ('payload' in shape) return chain(() => (state.clockRun === undefined ? [] : [{ payload: state.clockRun }]));
        return chain(() => state.rows);
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
vi.mock('./dispatch', async () => {
  const { sql } = await import('drizzle-orm');
  return { oemRunCommandFilter: () => sql`"type" = 'run'` };
});
vi.mock('../featureConfigResolver', () => ({
  checkDeviceMaintenanceWindow: vi.fn(),
  partnerTimezoneFrom: (column: string | null) => column,
}));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
vi.mock('../patchRebootHandler', () => ({
  clampRebootDelayMinutes: (minutes: number) => minutes,
  executeReboot: vi.fn(),
  resolveRebootPlan: vi.fn(),
}));

import { checkDeviceMaintenanceWindow } from '../featureConfigResolver';
import { executeReboot, resolveRebootPlan } from '../patchRebootHandler';
import { captureException } from '../sentry';
import { deriveOemDisplayState } from './displayState';
import { resetOemRebootSightingsForTests, runOemRebootSweep } from './rebootSweep';
import { resolveOemUpdatesLinksForDevices, type ResolvedOemUpdatesLink } from './resolver';

const D1 = '00000000-0000-4000-8000-000000000001';
const D2 = '00000000-0000-4000-8000-000000000002';
const DAY = 24 * 60 * 60 * 1000;

// A night in no occurrence window: the third Wednesday of January 2027 is the 20th,
// and holds run nightly regardless. 01:30 UTC, half an hour into a 01:00 to 05:00 window.
const TONIGHT = new Date('2027-03-10T01:30:00.000Z');
const WINDOW_END = new Date('2027-03-10T05:00:00.000Z');
const DEFERRAL = { allowDeferral: true, maxDeferrals: 2, deferralMinutes: 30 };
const PROMPT = { title: 'Restart' };

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deviceId: D1,
    orgId: 'org-1',
    partnerId: 'partner-1',
    lane: 'dell',
    deviceStatus: 'online',
    agentVersion: '0.127.0',
    lastSeenAt: new Date(TONIGHT.getTime() - 60_000),
    // Up for a month: it has not restarted since the reboot became owed.
    uptimeSeconds: 30 * 24 * 60 * 60,
    rebootPendingSince: new Date(TONIGHT.getTime() - 30 * 60_000),
    rebootScheduledAt: null,
    siteTimezone: null,
    orgSettings: null,
    partnerTimezone: 'UTC',
    partnerSettings: null,
    ...over,
  };
}

function link(over: Record<string, unknown> = {}): ResolvedOemUpdatesLink {
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
      vendors: { dell: { enabled: true, categories: { driver: true }, blockedUpdateIds: [] } },
      ...over,
    },
  } as ResolvedOemUpdatesLink;
}

function seed(rows: Array<Record<string, unknown>>, resolved: ResolvedOemUpdatesLink | null = link()) {
  state.rows = rows;
  vi.mocked(resolveOemUpdatesLinksForDevices).mockResolvedValue(
    new Map(resolved ? rows.map((r) => [r.deviceId as string, resolved]) : []),
  );
}

beforeEach(() => {
  vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
  vi.stubEnv('BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST', '');
  vi.stubEnv('BREEZE_OEM_UPDATES_DISABLED_LANES', '');
  state.rows = [];
  state.tonightsReboots = [];
  state.clockRun = { trigger: 'scheduled', occurrenceKey: '2027-03' };
  resetOemRebootSightingsForTests();
  state.updates = [];
  state.wheres = [];
  vi.mocked(resolveOemUpdatesLinksForDevices).mockReset();
  vi.mocked(checkDeviceMaintenanceWindow).mockReset();
  vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({ active: false, suppressPatching: false } as never);
  vi.mocked(executeReboot).mockReset();
  vi.mocked(executeReboot).mockResolvedValue({ success: true, delayMinutes: 15 });
  vi.mocked(resolveRebootPlan).mockReset();
  vi.mocked(resolveRebootPlan).mockResolvedValue({ delayMinutes: 15, deferral: DEFERRAL, promptText: PROMPT });
  vi.mocked(captureException).mockClear();
});

describe('runOemRebootSweep: the query', () => {
  it('reads only rows that owe a reboot, leaving out ephemeral and parked devices', async () => {
    seed([]);
    await runOemRebootSweep(TONIGHT);
    const { sql } = new PgDialect().sqlToQuery(state.wheres[0] as SQL);
    expect(sql).toContain('"reboot_pending_since" is not null');
    expect(sql).toContain('"is_ephemeral"');
    expect(sql).toContain("'unassigned_pool'");
  });
});

describe('runOemRebootSweep: overnight', () => {
  it('success_reboot_required with overnight dispatches in the same window', async () => {
    seed([row()]);
    await runOemRebootSweep(TONIGHT);
    expect(executeReboot).toHaveBeenCalledTimes(1);
    const [deviceId, reason, options] = vi.mocked(executeReboot).mock.calls[0]!;
    expect(deviceId).toBe(D1);
    expect(reason).toMatch(/restart/i);
    expect(options).toEqual({
      delayMinutes: 15,
      deferral: DEFERRAL,
      promptText: PROMPT,
      windowEndsAt: WINDOW_END,
      deadlineAction: 'hold',
      expectedOrgId: 'org-1',
      source: 'oem_updates',
      commitBeforeDelivery: true,
    });
  });

  it('ownership is the run that started the clock, not the latest one: a later Run Now cannot take it', async () => {
    seed([row()]);
    await runOemRebootSweep(TONIGHT);
    const ownership = state.wheres
      .map((where) => new PgDialect().sqlToQuery(where as SQL))
      .find((query) => query.sql.includes(`"type" = 'run'`));
    expect(ownership?.sql).toContain('"created_at" <=');
    expect(executeReboot).toHaveBeenCalledTimes(1);
  });

  it('the policy no longer running this vendor sends nothing', async () => {
    seed([row()], link({ vendors: { dell: { enabled: false, categories: { driver: true }, blockedUpdateIds: [] } } }));
    await runOemRebootSweep(TONIGHT);
    expect(executeReboot).not.toHaveBeenCalled();
  });

  it('a night outside any occurrence still holds nightly, not till next month', async () => {
    seed([row({ rebootPendingSince: new Date(TONIGHT.getTime() - 2 * DAY) })]);
    await runOemRebootSweep(TONIGHT);
    expect(executeReboot).toHaveBeenCalledTimes(1);
  });

  it('no room holds to tomorrow: nothing is sent in the last minutes of the window', async () => {
    seed([row()]);
    await runOemRebootSweep(new Date(WINDOW_END.getTime() - 4 * 60_000));
    expect(executeReboot).not.toHaveBeenCalled();
  });

  it('outside the window sends nothing, and spends no plan lookup', async () => {
    seed([row()]);
    await runOemRebootSweep(new Date('2027-03-10T12:00:00.000Z'));
    expect(executeReboot).not.toHaveBeenCalled();
    expect(resolveRebootPlan).not.toHaveBeenCalled();
  });

  it('the next night tries again', async () => {
    seed([row({ rebootPendingSince: TONIGHT })]);
    state.tonightsReboots = [];
    await runOemRebootSweep(new Date(TONIGHT.getTime() + DAY));
    expect(vi.mocked(executeReboot).mock.calls[0]![2]!.windowEndsAt).toEqual(new Date(WINDOW_END.getTime() + DAY));
  });

  it('one a night: a reboot already issued tonight is not issued again', async () => {
    seed([row()]);
    state.tonightsReboots = [{ id: 'c1' }];
    await runOemRebootSweep(TONIGHT);
    expect(executeReboot).not.toHaveBeenCalled();
  });

  it('a restart the agent already has scheduled is not replaced', async () => {
    seed([row({ rebootScheduledAt: new Date(TONIGHT.getTime() + 60_000) })]);
    await runOemRebootSweep(TONIGHT);
    expect(executeReboot).not.toHaveBeenCalled();
  });

  it('three nights held shows reboot_overdue, not forced: still the same hold', async () => {
    const pendingSince = new Date(TONIGHT.getTime() - 3 * DAY);
    seed([row({ rebootPendingSince: pendingSince })]);
    await runOemRebootSweep(TONIGHT);
    expect(vi.mocked(executeReboot).mock.calls[0]![2]).toMatchObject({ deadlineAction: 'hold' });
    expect(deriveOemDisplayState({
      status: { applicability: 'applicable', lastOutcome: 'success_reboot_required', occurrenceKey: '2027-03', lastSuccessAt: pendingSince, rebootPendingSince: pendingSince },
      linkEnabled: true,
      rebootMode: 'overnight',
      occurrence: { occurrenceKey: '2027-03', isPastLastNight: false },
      now: TONIGHT,
    })).toBe('reboot_overdue');
  });

  it('an agent too old to honour a hold gets nothing', async () => {
    seed([row({ agentVersion: '0.126.0' })]);
    await runOemRebootSweep(TONIGHT);
    expect(executeReboot).not.toHaveBeenCalled();
  });

  it('a refused reboot reaches Sentry and the row stays owed', async () => {
    seed([row()]);
    vi.mocked(executeReboot).mockResolvedValue({ success: false, error: 'trust denied' });
    await expect(runOemRebootSweep(TONIGHT)).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(state.updates).toEqual([]);
  });

  it('a throw for one device does not stop the others', async () => {
    seed([row({ deviceId: D1 }), row({ deviceId: D2 })]);
    vi.mocked(executeReboot).mockRejectedValueOnce(new Error('boom'));
    await expect(runOemRebootSweep(TONIGHT)).resolves.toBeUndefined();
    expect(executeReboot).toHaveBeenCalledTimes(2);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('caps the reboots per tick: the window is hours long', async () => {
    vi.stubEnv('OEM_UPDATES_MAX_DISPATCH_PER_TICK', '1');
    seed([row({ deviceId: D1 }), row({ deviceId: D2 })]);
    await runOemRebootSweep(TONIGHT);
    expect(executeReboot).toHaveBeenCalledTimes(1);
  });
});

describe('runOemRebootSweep: what it never reboots', () => {
  it('with never shows waiting_for_reboot, not failing, and sends nothing', async () => {
    const pendingSince = new Date(TONIGHT.getTime() - 5 * DAY);
    seed([row({ rebootPendingSince: pendingSince })], link({ reboot: 'never' }));
    await runOemRebootSweep(TONIGHT);
    expect(executeReboot).not.toHaveBeenCalled();
    expect(deriveOemDisplayState({
      status: { applicability: 'applicable', lastOutcome: 'blocked_reboot_pending', occurrenceKey: '2027-03', lastSuccessAt: null, rebootPendingSince: pendingSince },
      linkEnabled: true,
      rebootMode: 'never',
      occurrence: { occurrenceKey: '2027-03', isPastLastNight: false },
      now: TONIGHT,
    })).toBe('waiting_for_reboot');
  });

  it('the policy off, gone, or unreadable: no reboot', async () => {
    for (const resolved of [link({ enabled: false }), null, { ...link(), invalidStoredSettings: true }]) {
      vi.mocked(executeReboot).mockClear();
      seed([row()], resolved);
      await runOemRebootSweep(TONIGHT);
      expect(executeReboot).not.toHaveBeenCalled();
    }
  });

  it('Run Now keeps its own reboot choice: a leave-to-me run is never rebooted by the policy', async () => {
    state.clockRun = { trigger: 'on_demand', rebootControlled: false, occurrenceKey: null };
    seed([row()]);
    await runOemRebootSweep(TONIGHT);
    expect(executeReboot).not.toHaveBeenCalled();
  });

  it('an unreadable run, or none, is not consent', async () => {
    state.clockRun = null;
    seed([row()]);
    await runOemRebootSweep(TONIGHT);
    expect(executeReboot).not.toHaveBeenCalled();
    state.clockRun = undefined as never;
    await runOemRebootSweep(TONIGHT);
    expect(executeReboot).not.toHaveBeenCalled();
  });

  it('offline: nothing would reach it inside the window', async () => {
    seed([row({ deviceStatus: 'offline' })]);
    await runOemRebootSweep(TONIGHT);
    expect(executeReboot).not.toHaveBeenCalled();
  });

  it('the flag off, or the lane killed, holds new reboots', async () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
    seed([row()]);
    await runOemRebootSweep(TONIGHT);
    expect(executeReboot).not.toHaveBeenCalled();

    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
    vi.stubEnv('BREEZE_OEM_UPDATES_DISABLED_LANES', 'dell');
    await runOemRebootSweep(TONIGHT);
    expect(executeReboot).not.toHaveBeenCalled();
  });

  it('maintenance suppressing patching holds it', async () => {
    seed([row()]);
    vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({ active: true, suppressPatching: true } as never);
    await runOemRebootSweep(TONIGHT);
    expect(executeReboot).not.toHaveBeenCalled();
  });

  it('a maintenance lookup that fails holds it too', async () => {
    seed([row()]);
    vi.mocked(checkDeviceMaintenanceWindow).mockRejectedValue(new Error('boom'));
    await runOemRebootSweep(TONIGHT);
    expect(executeReboot).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});

describe('runOemRebootSweep: the reboot happened', () => {
  it('a reboot held then completed clears reboot_pending_since, once two ticks agree', async () => {
    const pendingSince = new Date(TONIGHT.getTime() - 2 * DAY);
    // Booted a day after the reboot became owed.
    const lastSeenAt = new Date(TONIGHT.getTime() - 60_000);
    const uptimeSeconds = (lastSeenAt.getTime() - (pendingSince.getTime() + DAY)) / 1000;
    seed([row({ rebootPendingSince: pendingSince, lastSeenAt, uptimeSeconds })]);
    await runOemRebootSweep(TONIGHT);
    // The first reading neither clears nor reboots again.
    expect(state.updates).toEqual([]);
    expect(executeReboot).not.toHaveBeenCalled();

    seed([row({ rebootPendingSince: pendingSince, lastSeenAt: new Date(lastSeenAt.getTime() + 600_000), uptimeSeconds: uptimeSeconds + 600 })]);
    await runOemRebootSweep(new Date(TONIGHT.getTime() + 600_000));
    expect(state.updates).toEqual([expect.objectContaining({ rebootRequired: false, rebootPendingSince: null })]);
    expect(executeReboot).not.toHaveBeenCalled();
  });

  it('a socket reopening before the first heartbeat is not a reboot', async () => {
    const pendingSince = new Date(TONIGHT.getTime() - 60 * 60_000);
    // Booted 3 hours before the reboot was owed, slept, and reconnected: last_seen_at
    // is fresh but the uptime is still the one written before it slept.
    const stale = row({ rebootPendingSince: pendingSince, lastSeenAt: TONIGHT, uptimeSeconds: 30 * 60 });
    seed([stale]);
    await runOemRebootSweep(TONIGHT);
    expect(state.updates).toEqual([]);

    // The first heartbeat brings the real uptime: the boot is from before the clock.
    const fresh = row({ rebootPendingSince: pendingSince, lastSeenAt: new Date(TONIGHT.getTime() + 600_000), uptimeSeconds: 5 * 60 * 60 });
    seed([fresh]);
    await runOemRebootSweep(new Date(TONIGHT.getTime() + 600_000));
    expect(state.updates).toEqual([]);
    expect(executeReboot).toHaveBeenCalledTimes(1);
  });

  it('clears it whatever the policy says, even with the flag off', async () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
    const lastSeenAt = new Date(TONIGHT.getTime() - 60_000);
    seed([row({ rebootPendingSince: new Date(TONIGHT.getTime() - DAY), lastSeenAt, uptimeSeconds: 60 })], null);
    await runOemRebootSweep(TONIGHT);
    seed([row({ rebootPendingSince: new Date(TONIGHT.getTime() - DAY), lastSeenAt: new Date(lastSeenAt.getTime() + 600_000), uptimeSeconds: 660 })], null);
    await runOemRebootSweep(new Date(TONIGHT.getTime() + 600_000));
    expect(state.updates).toEqual([expect.objectContaining({ rebootPendingSince: null })]);
  });

  it('a boot from before the reboot became owed clears nothing', async () => {
    const pendingSince = new Date(TONIGHT.getTime() - 60_000);
    seed([row({ rebootPendingSince: pendingSince, lastSeenAt: TONIGHT, uptimeSeconds: 3600 })]);
    await runOemRebootSweep(TONIGHT);
    expect(state.updates).toEqual([]);
  });

  it('no uptime is no evidence', async () => {
    seed([row({ uptimeSeconds: null })]);
    await runOemRebootSweep(TONIGHT);
    expect(state.updates).toEqual([]);
  });
});
