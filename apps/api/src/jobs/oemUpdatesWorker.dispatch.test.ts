import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedOemUpdatesLink } from '../services/oemUpdates/resolver';

vi.mock('../db', () => {
  const chain: Record<string, unknown> = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve([]),
  };
  return {
    db: { select: vi.fn(() => chain) },
    withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  };
});

vi.mock('bullmq', () => ({ Worker: vi.fn(), Queue: vi.fn(), Job: vi.fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/oemUpdates/alerts', () => ({
  emitDeviceNotReturnedAlert: vi.fn(),
  resolveReturnedDeviceAlerts: vi.fn(),
}));
vi.mock('../services/oemUpdates/dispatch', () => ({ dispatchOemUpdateRun: vi.fn() }));
vi.mock('../services/oemUpdates/resolver', () => ({
  resolveOemUpdatesLinkForDevice: vi.fn(),
  resolveOemUpdatesLinksForDevices: vi.fn(),
}));
vi.mock('../services/oemUpdates/rebootSweep', () => ({ runOemRebootSweep: vi.fn(async () => undefined) }));
vi.mock('../services/oemUpdates/overdueSweep', () => ({ runOemOverdueSweep: vi.fn(async () => undefined) }));
vi.mock('../services/oemUpdates/releaseSweep', () => ({ runOemReleaseSweep: vi.fn(async () => undefined) }));
vi.mock('../services/oemUpdates/toolManifest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/oemUpdates/toolManifest')>()),
  openCategoriesForLane: vi.fn(() => ['bios', 'firmware', 'driver', 'application']),
}));
vi.mock('../services/oemUpdates/candidates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/oemUpdates/candidates')>()),
  selectDueDevices: vi.fn(),
}));

import { captureException } from '../services/sentry';
import { selectDueDevices, type DueDevice } from '../services/oemUpdates/candidates';
import { dispatchOemUpdateRun } from '../services/oemUpdates/dispatch';
import { runOemOverdueSweep } from '../services/oemUpdates/overdueSweep';
import { runOemRebootSweep } from '../services/oemUpdates/rebootSweep';
import { runOemReleaseSweep } from '../services/oemUpdates/releaseSweep';
import { resolveOemUpdatesLinkForDevice } from '../services/oemUpdates/resolver';
import { resetOemDispatchCursorForTests, runOemUpdatesTick } from './oemUpdatesWorker';

// Third Wednesday of January 2027, an hour into a 01:00 to 05:00 UTC window.
const NOW = new Date('2027-01-20T02:00:00.000Z');
const D1 = '00000000-0000-4000-8000-000000000001';
const D2 = '00000000-0000-4000-8000-000000000002';

function link(over: Record<string, unknown> = {}, vendor: Record<string, unknown> = {}): ResolvedOemUpdatesLink {
  return {
    linkId: 'link-1',
    configPolicyId: 'policy-1',
    assignedPolicyId: 'policy-1',
    invalidStoredSettings: false,
    settings: {
      version: 1,
      enabled: true,
      schedule: { weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4 },
      catchUpNights: 7,
      reboot: 'overnight',
      vendors: { dell: { enabled: true, categories: { bios: true, driver: true }, blockedUpdateIds: ['B-1'], ...vendor } },
      ...over,
    },
  } as ResolvedOemUpdatesLink;
}

function due(over: Partial<DueDevice> = {}): DueDevice {
  return {
    due: true,
    deviceId: D1,
    orgId: 'org-decided',
    lane: 'dell',
    timezone: 'UTC',
    status: {},
    occurrenceKey: '2027-01',
    windowStart: new Date('2027-01-20T01:00:00.000Z'),
    windowEnd: new Date('2027-01-20T05:00:00.000Z'),
    notAfter: new Date('2027-01-20T04:00:00.000Z'),
    requestedCategories: ['bios', 'driver'],
    blockedUpdateIds: ['B-1'],
    rebootControlled: true,
    ...over,
  };
}

beforeEach(() => {
  // The worker compares notAfter with the real clock, so the clock is pinned to NOW:
  // without it these tests would start failing once the real date passes 2027-01-20.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  resetOemDispatchCursorForTests();
  vi.mocked(selectDueDevices).mockReset();
  vi.mocked(selectDueDevices).mockResolvedValue([]);
  vi.mocked(dispatchOemUpdateRun).mockReset();
  vi.mocked(dispatchOemUpdateRun).mockResolvedValue({ ok: true, commandId: 'c1', categories: ['driver'], skippedCategories: [] });
  vi.mocked(resolveOemUpdatesLinkForDevice).mockReset();
  vi.mocked(resolveOemUpdatesLinkForDevice).mockResolvedValue(link());
  vi.mocked(runOemRebootSweep).mockReset();
  vi.mocked(runOemReleaseSweep).mockReset();
  vi.mocked(captureException).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runOemUpdatesTick: scheduled dispatch', () => {
  it('re-resolves the winning link immediately before dispatch', async () => {
    vi.mocked(selectDueDevices).mockResolvedValue([due()]);
    await runOemUpdatesTick(NOW);
    expect(resolveOemUpdatesLinkForDevice).toHaveBeenCalledWith(D1);
    expect(vi.mocked(resolveOemUpdatesLinkForDevice).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(dispatchOemUpdateRun).mock.invocationCallOrder[0]!);
  });

  it.each<[string, ResolvedOemUpdatesLink | null]>([
    ['the policy turned off', link({ enabled: false })],
    ['the vendor turned off', link({}, { enabled: false })],
    ['the link gone', null],
    ['the settings unreadable', { ...link(), invalidStoredSettings: true }],
    ['every category turned off', link({}, { categories: {} })],
    ['a schedule moved so this is no longer in the window', link({ schedule: { weekOfMonth: 'first', dayOfWeek: 'mon', windowStart: '01:00', windowHours: 4 } })],
  ])('between select and send, %s: no command', async (_name, fresh) => {
    vi.mocked(selectDueDevices).mockResolvedValue([due()]);
    vi.mocked(resolveOemUpdatesLinkForDevice).mockResolvedValue(fresh);
    await runOemUpdatesTick(NOW);
    expect(dispatchOemUpdateRun).not.toHaveBeenCalled();
  });

  it('a stale selection sends what the fresh link says, not what it said', async () => {
    vi.mocked(selectDueDevices).mockResolvedValue([due()]);
    vi.mocked(resolveOemUpdatesLinkForDevice).mockResolvedValue(link({}, { categories: { driver: true }, blockedUpdateIds: ['B-1', 'B-2'] }));
    await runOemUpdatesTick(NOW);
    expect(vi.mocked(dispatchOemUpdateRun).mock.calls[0]![0]).toMatchObject({
      requestedCategories: ['driver'],
      blockedUpdateIds: ['B-1', 'B-2'],
    });
  });

  it('passes expectedOrgId from the decision', async () => {
    vi.mocked(selectDueDevices).mockResolvedValue([due({ orgId: 'org-decided' })]);
    await runOemUpdatesTick(NOW);
    expect(vi.mocked(dispatchOemUpdateRun).mock.calls[0]![0].expectedOrgId).toBe('org-decided');
  });

  it('occurrence and notAfter are in the input, as a scheduled run with no actor', async () => {
    vi.mocked(selectDueDevices).mockResolvedValue([due()]);
    await runOemUpdatesTick(NOW);
    expect(vi.mocked(dispatchOemUpdateRun).mock.calls[0]![0]).toEqual({
      deviceId: D1,
      expectedOrgId: 'org-decided',
      trigger: 'scheduled',
      requestedCategories: ['bios', 'driver'],
      blockedUpdateIds: ['B-1'],
      rebootControlled: true,
      occurrenceKey: '2027-01',
      notAfter: new Date('2027-01-20T04:00:00.000Z'),
      actorUserId: null,
    });
  });

  it('reboot never passes a reboot Breeze does not control, so the seam skips bios and firmware', async () => {
    vi.mocked(selectDueDevices).mockResolvedValue([due()]);
    vi.mocked(resolveOemUpdatesLinkForDevice).mockResolvedValue(link({ reboot: 'never' }));
    await runOemUpdatesTick(NOW);
    expect(vi.mocked(dispatchOemUpdateRun).mock.calls[0]![0].rebootControlled).toBe(false);
  });

  it('a finished occurrence stays quiet: the decision re-reads the status it was selected on', async () => {
    vi.mocked(selectDueDevices).mockResolvedValue([due({ status: { occurrenceKey: '2027-01', lastOutcome: 'success', lastTrigger: 'scheduled', attempts: 1 } })]);
    await runOemUpdatesTick(NOW);
    expect(dispatchOemUpdateRun).not.toHaveBeenCalled();
  });

  it('a throw for one device does not stop the tick', async () => {
    vi.mocked(selectDueDevices).mockResolvedValue([due({ deviceId: D1 }), due({ deviceId: D2 })]);
    vi.mocked(dispatchOemUpdateRun).mockRejectedValueOnce(new Error('boom'));
    await expect(runOemUpdatesTick(NOW)).resolves.toBeUndefined();
    expect(dispatchOemUpdateRun).toHaveBeenCalledTimes(2);
    expect(vi.mocked(captureException).mock.calls).toHaveLength(1);
    expect(vi.mocked(captureException).mock.calls[0]![2]).toMatchObject({ worker: 'oemUpdatesWorker', org_id: 'org-decided' });
  });

  it('a resolve that throws for one device does not stop the tick, and sends it nothing', async () => {
    vi.mocked(selectDueDevices).mockResolvedValue([due({ deviceId: D1 }), due({ deviceId: D2 })]);
    vi.mocked(resolveOemUpdatesLinkForDevice).mockRejectedValueOnce(new Error('boom'));
    await runOemUpdatesTick(NOW);
    expect(dispatchOemUpdateRun).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchOemUpdateRun).mock.calls[0]![0].deviceId).toBe(D2);
  });

  it('a seam refusal is an answer, not an error', async () => {
    vi.mocked(selectDueDevices).mockResolvedValue([due()]);
    vi.mocked(dispatchOemUpdateRun).mockResolvedValue({ ok: false, refusal: 'lane_closed' });
    await expect(runOemUpdatesTick(NOW)).resolves.toBeUndefined();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('a deadline the real clock has passed is skipped, not thrown at the seam', async () => {
    vi.mocked(selectDueDevices).mockResolvedValue([due()]);
    // A long tick: selected inside the window, and the clock has moved past notAfter.
    vi.setSystemTime(new Date('2027-01-20T04:00:00.001Z'));
    await runOemUpdatesTick(NOW);
    expect(dispatchOemUpdateRun).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('asks for the cap and resumes after the last device when it hit it', async () => {
    process.env.OEM_UPDATES_MAX_DISPATCH_PER_TICK = '2';
    try {
      vi.mocked(selectDueDevices).mockResolvedValueOnce([due({ deviceId: D1 }), due({ deviceId: D2 })]);
      await runOemUpdatesTick(NOW);
      expect(vi.mocked(selectDueDevices).mock.calls[0]![1]).toEqual({ limit: 2, startAfter: null });

      vi.mocked(selectDueDevices).mockResolvedValueOnce([due({ deviceId: D1 })]);
      await runOemUpdatesTick(NOW);
      expect(vi.mocked(selectDueDevices).mock.calls[1]![1]).toEqual({ limit: 2, startAfter: D2 });

      await runOemUpdatesTick(NOW);
      // The last tick came back short of the cap, so the next starts over.
      expect(vi.mocked(selectDueDevices).mock.calls[2]![1]).toEqual({ limit: 2, startAfter: null });
    } finally {
      delete process.env.OEM_UPDATES_MAX_DISPATCH_PER_TICK;
    }
  });
});

describe('runOemUpdatesTick: the stages', () => {
  it('runs the sweeps with the tick time, before the runs', async () => {
    vi.mocked(selectDueDevices).mockResolvedValue([due()]);
    await runOemUpdatesTick(NOW);
    expect(runOemReleaseSweep).toHaveBeenCalledWith(NOW);
    expect(runOemRebootSweep).toHaveBeenCalledWith(NOW);
    const dispatched = vi.mocked(dispatchOemUpdateRun).mock.invocationCallOrder[0]!;
    expect(vi.mocked(runOemReleaseSweep).mock.invocationCallOrder[0]!).toBeLessThan(dispatched);
    expect(vi.mocked(runOemRebootSweep).mock.invocationCallOrder[0]!).toBeLessThan(dispatched);
  });

  it('one stage failing does not stop the others, and reaches Sentry', async () => {
    vi.mocked(runOemReleaseSweep).mockRejectedValue(new Error('release down'));
    vi.mocked(runOemRebootSweep).mockRejectedValue(new Error('reboot down'));
    vi.mocked(selectDueDevices).mockResolvedValue([due()]);
    await expect(runOemUpdatesTick(NOW)).resolves.toBeUndefined();
    expect(dispatchOemUpdateRun).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it('the overdue alerts run after the runs, with the tick time', async () => {
    vi.mocked(runOemOverdueSweep).mockClear();
    vi.mocked(selectDueDevices).mockResolvedValue([due()]);
    await runOemUpdatesTick(NOW);
    expect(runOemOverdueSweep).toHaveBeenCalledWith(NOW);
    expect(vi.mocked(runOemOverdueSweep).mock.invocationCallOrder[0]!)
      .toBeGreaterThan(vi.mocked(dispatchOemUpdateRun).mock.invocationCallOrder[0]!);
  });

  it('the overdue alerts failing costs nothing else, and reaches Sentry', async () => {
    vi.mocked(runOemOverdueSweep).mockRejectedValueOnce(new Error('alerts down'));
    vi.mocked(selectDueDevices).mockResolvedValue([due()]);
    await expect(runOemUpdatesTick(NOW)).resolves.toBeUndefined();
    expect(dispatchOemUpdateRun).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('selection failing does not stop the overdue alerts', async () => {
    vi.mocked(runOemOverdueSweep).mockClear();
    vi.mocked(selectDueDevices).mockRejectedValue(new Error('select down'));
    await runOemUpdatesTick(NOW);
    expect(runOemOverdueSweep).toHaveBeenCalledTimes(1);
  });

  it('selection failing does not stop the sweeps either', async () => {
    vi.mocked(selectDueDevices).mockRejectedValue(new Error('select down'));
    await expect(runOemUpdatesTick(NOW)).resolves.toBeUndefined();
    expect(runOemReleaseSweep).toHaveBeenCalledTimes(1);
    expect(runOemRebootSweep).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
