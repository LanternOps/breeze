import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OemCategory, OemLane, OemUpdatesInlineSettings } from '@breeze/shared';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  selects: 0,
  closedLanes: new Set<string>(),
  closedCategories: new Set<string>(),
  useRealManifest: false,
}));

vi.mock('../../db', () => {
  const chain = () => {
    const c: Record<string, unknown> = {
      from: () => c,
      innerJoin: () => c,
      leftJoin: () => c,
      where: () => Promise.resolve(state.rows),
    };
    return c;
  };
  return {
    db: {
      select: vi.fn(() => {
        state.selects += 1;
        return chain();
      }),
    },
    withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  };
});

vi.mock('./resolver', () => ({ resolveOemUpdatesLinksForDevices: vi.fn() }));
vi.mock('../featureConfigResolver', () => ({
  checkDeviceMaintenanceWindow: vi.fn(),
  partnerTimezoneFrom: (column: string | null) => column,
}));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

// Every real gate is closed until a lab wave, so these tests choose them. The last
// describe block goes back to the real manifest.
vi.mock('./toolManifest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./toolManifest')>();
  return {
    ...actual,
    isLaneOpen: (lane: OemLane, opts?: { deviceId?: string }) =>
      (state.useRealManifest ? actual.isLaneOpen(lane, opts) : !state.closedLanes.has(lane)),
    isCategoryOpen: (lane: OemLane, category: OemCategory, opts?: { deviceId?: string }) =>
      (state.useRealManifest
        ? actual.isCategoryOpen(lane, category, opts)
        : !state.closedLanes.has(lane) && !state.closedCategories.has(`${lane}:${category}`)),
  };
});

import { getVendorManagedClasses, getVendorManagedClassesForDevices } from './laneDelivery';
import { computeOccurrence } from './occurrence';
import { resolveOemUpdatesLinksForDevices, type ResolvedOemUpdatesLink } from './resolver';

const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_DEVICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PARTNER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
// Inside the occurrence's catch-up nights: third Wednesday of March 2027 is the 17th.
const NOW = new Date('2027-03-18T15:00:00.000Z');
const SCHEDULE = { weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4 } as const;
const OCCURRENCE_KEY = computeOccurrence({ ...SCHEDULE, catchUpNights: 7 }, 'UTC', NOW).occurrenceKey;

function settings(overrides: Partial<OemUpdatesInlineSettings> = {}): OemUpdatesInlineSettings {
  const categories = { bios: true, firmware: true, driver: true, application: false };
  return {
    version: 1,
    enabled: true,
    schedule: SCHEDULE,
    catchUpNights: 7,
    reboot: 'overnight',
    vendors: {
      dell: { enabled: true, categories, blockedUpdateIds: [] },
      surface: { enabled: true, categories, blockedUpdateIds: [] },
    },
    ...overrides,
  };
}

function link(overrides: Partial<OemUpdatesInlineSettings> = {}, invalidStoredSettings = false): ResolvedOemUpdatesLink {
  return {
    linkId: 'link-1',
    configPolicyId: 'policy-1',
    assignedPolicyId: 'policy-1',
    settings: settings(overrides),
    invalidStoredSettings,
  };
}

/** A Dell that has run, finished this occurrence, and owes nothing. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deviceId: DEVICE_ID,
    partnerId: PARTNER_ID,
    osType: 'windows',
    isVirtual: false,
    deviceRole: 'workstation',
    agentVersion: '99.0.0',
    manufacturer: 'Dell Inc.',
    model: 'Latitude 7440',
    siteTimezone: 'UTC',
    orgSettings: null,
    partnerTimezone: null,
    partnerSettings: null,
    statusLane: 'dell',
    applicability: 'applicable',
    occurrenceKey: OCCURRENCE_KEY,
    attempts: 1,
    lastOutcome: 'success',
    lastSuccessAt: new Date('2027-03-17T02:00:00.000Z'),
    firstCompletedAt: new Date('2027-02-17T02:00:00.000Z'),
    rebootPendingSince: null,
    ...overrides,
  };
}

function givenDevice(rowOverrides: Record<string, unknown> = {}, resolved: ResolvedOemUpdatesLink | null = link()) {
  const device = row(rowOverrides);
  state.rows = [device];
  vi.mocked(resolveOemUpdatesLinksForDevices).mockResolvedValue(
    new Map(resolved ? [[device.deviceId as string, resolved]] : []),
  );
}

const classes = () => getVendorManagedClasses(DEVICE_ID, { now: NOW });

beforeEach(() => {
  vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
  vi.stubEnv('BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST', '');
  vi.stubEnv('BREEZE_OEM_UPDATES_DISABLED_LANES', '');
  vi.stubEnv('BREEZE_OEM_UPDATES_LAB_DEVICE_IDS', '');
  state.rows = [];
  state.selects = 0;
  state.closedLanes = new Set();
  state.closedCategories = new Set();
  state.useRealManifest = false;
  vi.mocked(resolveOemUpdatesLinksForDevices).mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getVendorManagedClasses: all of spec 4.6 true', () => {
  it('returns the classes the lane delivers', async () => {
    givenDevice();
    expect(await classes()).toEqual(new Set(['driver', 'firmware']));
  });

  it('keeps delivering while a reboot it owes has not overrun', async () => {
    givenDevice({ rebootPendingSince: new Date('2027-03-17T03:00:00.000Z') });
    expect(await classes()).toEqual(new Set(['driver', 'firmware']));
  });

  it('counts a device whose last success was an earlier occurrence, before the catch-up nights run out', async () => {
    givenDevice({ occurrenceKey: '2027-02', lastSuccessAt: new Date('2027-02-17T02:00:00.000Z') });
    expect(await classes()).toEqual(new Set(['driver', 'firmware']));
  });
});

describe('getVendorManagedClasses: each spec 4.6 condition alone false gives the empty set', () => {
  it('category off in the resolved link', async () => {
    givenDevice({}, link({
      vendors: { dell: { enabled: true, categories: { bios: false, firmware: false, driver: false }, blockedUpdateIds: [] } },
    }));
    expect(await classes()).toEqual(new Set());
  });

  it('a category absent from the link is off', async () => {
    givenDevice({}, link({ vendors: { dell: { enabled: true, categories: {}, blockedUpdateIds: [] } } }));
    expect(await classes()).toEqual(new Set());
  });

  it('lane gate closed', async () => {
    state.closedLanes.add('dell');
    givenDevice();
    expect(await classes()).toEqual(new Set());
  });

  it('both category gates closed', async () => {
    state.closedCategories = new Set(['dell:driver', 'dell:firmware']);
    givenDevice();
    expect(await classes()).toEqual(new Set());
  });

  it('not_supported', async () => {
    givenDevice({ applicability: 'not_supported' });
    expect(await classes()).toEqual(new Set());
  });

  it('no completed run', async () => {
    givenDevice({ firstCompletedAt: null });
    expect(await classes()).toEqual(new Set());
  });

  it('Overdue: past the last catch-up night with nothing finished', async () => {
    givenDevice({ occurrenceKey: '2027-02', lastSuccessAt: new Date('2027-02-17T02:00:00.000Z') });
    const lastNightGone = new Date('2027-03-26T15:00:00.000Z');
    expect(await getVendorManagedClasses(DEVICE_ID, { now: lastNightGone })).toEqual(new Set());
  });

  it('Overdue: out of attempts with nights left', async () => {
    givenDevice({ attempts: 3, lastOutcome: 'blocked_on_battery' });
    expect(await classes()).toEqual(new Set());
  });

  it('Reboot overdue: a reboot held past its nights', async () => {
    givenDevice({ rebootPendingSince: new Date('2027-03-14T03:00:00.000Z') });
    expect(await classes()).toEqual(new Set());
  });

  it('Failing', async () => {
    givenDevice({ lastOutcome: 'failed' });
    expect(await classes()).toEqual(new Set());
  });
});

describe('getVendorManagedClasses: one class without the other', () => {
  it('a Surface firmware gate closed returns no firmware while drivers are still delivered', async () => {
    state.closedCategories.add('surface:firmware');
    givenDevice({ manufacturer: 'Microsoft Corporation', model: 'Surface Laptop 5', statusLane: 'surface' });
    expect(await classes()).toEqual(new Set(['driver']));
  });

  it('a Surface with its firmware open delivers firmware, since Surface has no separate BIOS', async () => {
    state.closedCategories.add('surface:bios');
    givenDevice({ manufacturer: 'Microsoft Corporation', model: 'Surface Laptop 5', statusLane: 'surface' });
    expect(await classes()).toEqual(new Set(['driver', 'firmware']));
  });

  it('driver off leaves firmware', async () => {
    givenDevice({}, link({
      vendors: { dell: { enabled: true, categories: { bios: true, firmware: true, driver: false }, blockedUpdateIds: [] } },
    }));
    expect(await classes()).toEqual(new Set(['firmware']));
  });

  // Windows Update files a Dell system BIOS capsule as firmware, and nothing on the
  // update tells it apart. Leaving firmware to a lane with BIOS off would strand it.
  it('firmware on but BIOS off keeps firmware with Windows Update on a lane with a separate BIOS', async () => {
    givenDevice({}, link({
      vendors: { dell: { enabled: true, categories: { bios: false, firmware: true, driver: true }, blockedUpdateIds: [] } },
    }));
    expect(await classes()).toEqual(new Set(['driver']));
  });

  it('a closed BIOS gate keeps firmware with Windows Update too', async () => {
    state.closedCategories.add('dell:bios');
    givenDevice();
    expect(await classes()).toEqual(new Set(['driver']));
  });

  // The seam drops bios and firmware when Breeze does not control the reboot, so the
  // category being on does not mean the lane delivers it.
  it('a policy that never reboots delivers drivers and no firmware', async () => {
    givenDevice({}, link({ reboot: 'never' }));
    expect(await classes()).toEqual(new Set(['driver']));
  });
});

describe('getVendorManagedClasses: what makes a device have no lane delivering', () => {
  it.each([
    ['the master flag off', () => vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false')],
    ['a partner outside the allowlist', () => vi.stubEnv('BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST', 'someone-else')],
    ['the kill switch', () => vi.stubEnv('BREEZE_OEM_UPDATES_DISABLED_LANES', 'dell')],
  ])('%s', async (_label, arrange) => {
    arrange();
    givenDevice();
    expect(await classes()).toEqual(new Set());
  });

  it('no link', async () => {
    givenDevice({}, null);
    expect(await classes()).toEqual(new Set());
  });

  it('the link turned off', async () => {
    givenDevice({}, link({ enabled: false }));
    expect(await classes()).toEqual(new Set());
  });

  it('stored settings that no longer parse', async () => {
    givenDevice({}, link({}, true));
    expect(await classes()).toEqual(new Set());
  });

  it('the vendor off, or absent, in the link', async () => {
    givenDevice({}, link({ vendors: { dell: { enabled: false, categories: { driver: true }, blockedUpdateIds: [] } } }));
    expect(await classes()).toEqual(new Set());
    givenDevice({}, link({ vendors: {} }));
    expect(await classes()).toEqual(new Set());
  });

  it('an agent too old to run the lane', async () => {
    givenDevice({ agentVersion: '0.1.0' });
    expect(await classes()).toEqual(new Set());
  });

  it('a device whose manufacturer no longer matches the lane that ran', async () => {
    // A new board: the policy arms the new maker too, but that lane has not run here.
    givenDevice({ manufacturer: 'HP Inc.' }, link({
      vendors: { hp: { enabled: true, categories: { bios: true, firmware: true, driver: true }, blockedUpdateIds: [] } },
    }));
    expect(await classes()).toEqual(new Set());
  });

  it.each([
    ['a VM', { isVirtual: true }],
    ['a server', { deviceRole: 'server' }],
    ['not Windows', { osType: 'macos' }],
    ['a near-miss manufacturer', { manufacturer: 'Dell EMC' }],
  ])('%s', async (_label, overrides) => {
    givenDevice(overrides);
    expect(await classes()).toEqual(new Set());
  });

  it('a device with no status row costs one query and no link resolve', async () => {
    state.rows = [];
    expect(await classes()).toEqual(new Set());
    expect(state.selects).toBe(1);
    expect(resolveOemUpdatesLinksForDevices).not.toHaveBeenCalled();
  });

  it('the flag off costs no query at all, so a job on a dark install pays nothing', async () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
    givenDevice();
    expect(await classes()).toEqual(new Set());
    expect(state.selects).toBe(0);
    expect(resolveOemUpdatesLinksForDevices).not.toHaveBeenCalled();
  });
});

describe('getVendorManagedClassesForDevices', () => {
  it('answers each device on its own, and every asked device has an entry', async () => {
    const surface = row({
      deviceId: OTHER_DEVICE_ID,
      manufacturer: 'Microsoft Corporation',
      model: 'Surface Laptop 5',
      statusLane: 'surface',
    });
    state.rows = [row(), surface];
    state.closedCategories.add('surface:firmware');
    vi.mocked(resolveOemUpdatesLinksForDevices).mockResolvedValue(new Map([
      [DEVICE_ID, link()],
      [OTHER_DEVICE_ID, link()],
    ]));
    const noRow = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

    const result = await getVendorManagedClassesForDevices([DEVICE_ID, OTHER_DEVICE_ID, noRow], { now: NOW });

    expect(result.get(DEVICE_ID)).toEqual(new Set(['driver', 'firmware']));
    expect(result.get(OTHER_DEVICE_ID)).toEqual(new Set(['driver']));
    expect(result.get(noRow)).toEqual(new Set());
  });

  it('resolves links once for the whole page', async () => {
    state.rows = [row(), row({ deviceId: OTHER_DEVICE_ID })];
    vi.mocked(resolveOemUpdatesLinksForDevices).mockResolvedValue(new Map());

    await getVendorManagedClassesForDevices([DEVICE_ID, OTHER_DEVICE_ID], { now: NOW });

    expect(resolveOemUpdatesLinksForDevices).toHaveBeenCalledTimes(1);
    expect(resolveOemUpdatesLinksForDevices).toHaveBeenCalledWith([DEVICE_ID, OTHER_DEVICE_ID]);
  });

  it('an empty ask reads nothing', async () => {
    expect(await getVendorManagedClassesForDevices([], { now: NOW })).toEqual(new Map());
    expect(state.selects).toBe(0);
  });
});

describe('with the real manifest', () => {
  it.each([
    ['Dell Inc.', 'Latitude 7440', 'dell'],
    ['Microsoft Corporation', 'Surface Laptop 5', 'surface'],
    ['HP Inc.', 'EliteBook 840', 'hp'],
  ])('every gate is closed until a lab wave, so %s leaves everything with Windows Update', async (manufacturer, model, statusLane) => {
    state.useRealManifest = true;
    givenDevice({ manufacturer, model, statusLane }, link({
      vendors: { [statusLane]: { enabled: true, categories: { bios: true, firmware: true, driver: true }, blockedUpdateIds: [] } },
    }));
    expect(await classes()).toEqual(new Set());
  });
});
