import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { OemCategory, OemLane } from '@breeze/shared';

const state = vi.hoisted(() => ({
  results: [] as unknown[][],
  wheres: [] as unknown[],
  selects: 0,
  openLanes: new Set<string>(['dell', 'hp', 'surface']),
  openCategories: ['bios', 'firmware', 'driver', 'application'] as string[],
}));

vi.mock('../../db', () => {
  const chainFor = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: (condition: unknown) => {
        state.wheres.push(condition);
        return chain;
      },
      orderBy: () => chain,
      limit: () => chain,
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return chain;
  };
  return {
    db: {
      select: vi.fn(() => {
        state.selects += 1;
        return chainFor(state.results.shift() ?? []);
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
vi.mock('./toolManifest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./toolManifest')>();
  return {
    ...actual,
    isLaneOpen: vi.fn((lane: string) => state.openLanes.has(lane)),
    openCategoriesForLane: vi.fn(() => state.openCategories),
    getLaneManifest: vi.fn(() => ({ tool: { version: '5.7.2' } })),
  };
});

import { checkDeviceMaintenanceWindow } from '../featureConfigResolver';
import { captureException } from '../sentry';
import {
  decideScheduledRun,
  maxDispatchPerTick,
  selectDueDevices,
  type CandidateRow,
} from './candidates';
import { stableOffsetMinutes } from './occurrence';
import { resolveOemUpdatesLinksForDevices, type ResolvedOemUpdatesLink } from './resolver';

// Third Wednesday of January 2027, an hour into a 01:00 to 05:00 UTC window.
const NOW = new Date('2027-01-20T02:00:00.000Z');
const OCCURRENCE = '2027-01';
const D1 = '00000000-0000-4000-8000-000000000001';

function device(over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    deviceId: D1,
    orgId: 'org-1',
    partnerId: 'partner-1',
    osType: 'windows',
    isVirtual: false,
    deviceRole: 'workstation',
    agentVersion: '0.127.0',
    manufacturer: 'Dell Inc.',
    model: 'Latitude 5450',
    siteTimezone: null,
    orgSettings: null,
    partnerTimezone: 'UTC',
    partnerSettings: null,
    occurrenceKey: null,
    attempts: null,
    lastOutcome: null,
    lastAttemptAt: null,
    applicability: null,
    notSupportedToolVersion: null,
    notSupportedModel: null,
    rebootPendingSince: null,
    takeoverState: null,
    commandStatus: null,
    ...over,
  } as CandidateRow;
}

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
      vendors: {
        dell: {
          enabled: true,
          categories: { bios: true, driver: true },
          blockedUpdateIds: ['BLOCKED-1'],
          ...vendor,
        },
      },
      ...over,
    },
  } as ResolvedOemUpdatesLink;
}

const ARMED_POLICY = {
  orgId: null,
  partnerId: 'partner-1',
  inlineSettings: { enabled: true, vendors: { dell: { enabled: true, categories: { driver: true } } } },
};

/** The scope query, then one page of devices. */
function seed(rows: CandidateRow[], resolved: ResolvedOemUpdatesLink | null = link()) {
  state.results = [[ARMED_POLICY], rows];
  vi.mocked(resolveOemUpdatesLinksForDevices).mockResolvedValue(
    new Map(resolved ? rows.map((row) => [row.deviceId, resolved]) : []),
  );
}

beforeEach(() => {
  process.env.BREEZE_OEM_UPDATES_ENABLED = 'true';
  delete process.env.BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST;
  delete process.env.BREEZE_OEM_UPDATES_DISABLED_LANES;
  delete process.env.OEM_UPDATES_MAX_DISPATCH_PER_TICK;
  state.results = [];
  state.wheres = [];
  state.selects = 0;
  state.openLanes = new Set(['dell', 'hp', 'surface']);
  state.openCategories = ['bios', 'firmware', 'driver', 'application'];
  vi.mocked(resolveOemUpdatesLinksForDevices).mockReset();
  vi.mocked(checkDeviceMaintenanceWindow).mockReset();
  vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({ active: false, suppressPatching: false } as never);
  vi.mocked(captureException).mockClear();
});

afterEach(() => {
  delete process.env.BREEZE_OEM_UPDATES_ENABLED;
  delete process.env.OEM_UPDATES_MAX_DISPATCH_PER_TICK;
});

describe('selectDueDevices: the early exits', () => {
  it('reads nothing with the flag off', async () => {
    process.env.BREEZE_OEM_UPDATES_ENABLED = 'false';
    await expect(selectDueDevices(NOW, { limit: 200 })).resolves.toEqual([]);
    expect(state.selects).toBe(0);
  });

  it('stops after one read when no active link exists', async () => {
    state.results = [[]];
    await expect(selectDueDevices(NOW, { limit: 200 })).resolves.toEqual([]);
    expect(state.selects).toBe(1);
  });

  it('stops after one read when no active link arms anything', async () => {
    state.results = [[{ orgId: 'org-1', partnerId: null, inlineSettings: { enabled: false } }]];
    await expect(selectDueDevices(NOW, { limit: 200 })).resolves.toEqual([]);
    expect(state.selects).toBe(1);
  });

  it('flag off for the partner: an allowlist that leaves out the only armed partner reads no devices', async () => {
    process.env.BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST = 'partner-2';
    state.results = [[ARMED_POLICY]];
    await expect(selectDueDevices(NOW, { limit: 200 })).resolves.toEqual([]);
    expect(state.selects).toBe(1);
  });

  it('flag off for the partner: an org-owned policy in another partner still leaves this device out', async () => {
    process.env.BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST = 'partner-2';
    state.results = [[{ ...ARMED_POLICY, orgId: 'org-1', partnerId: null }], [device()]];
    vi.mocked(resolveOemUpdatesLinksForDevices).mockResolvedValue(new Map([[D1, link()]]));
    await expect(selectDueDevices(NOW, { limit: 200 })).resolves.toEqual([]);
  });
});

describe('selectDueDevices: the device query', () => {
  async function deviceWhere(): Promise<{ sql: string; params: unknown[] }> {
    seed([]);
    await selectDueDevices(NOW, { limit: 200 });
    const query = new PgDialect().sqlToQuery(state.wheres[1] as SQL);
    return { sql: query.sql, params: query.params };
  }

  it('is Windows and online', async () => {
    const { sql, params } = await deviceWhere();
    expect(sql).toContain('"devices"."os_type" =');
    expect(params).toContain('windows');
    expect(sql).toContain('"devices"."status" =');
    expect(params).toContain('online');
  });

  it('excludes ephemeral devices', async () => {
    expect((await deviceWhere()).sql).toContain('"devices"."is_ephemeral" =');
  });

  it('excludes parked devices', async () => {
    expect((await deviceWhere()).sql).toContain("'unassigned_pool'");
  });

  it('excludes virtual machines', async () => {
    expect((await deviceWhere()).sql).toContain('"devices"."is_virtual" =');
  });

  it('excludes the server role', async () => {
    const { sql, params } = await deviceWhere();
    expect(sql).toContain('"devices"."device_role" <>');
    expect(params).toContain('server');
  });

  it('reads only the orgs and partners an armed policy can reach', async () => {
    const { sql, params } = await deviceWhere();
    expect(sql).toContain('"organizations"."partner_id" in');
    expect(params).toContain('partner-1');
  });
});

describe('selectDueDevices: what a due device carries', () => {
  it('carries the decision: org, occurrence, notAfter, the policy side', async () => {
    seed([device()]);
    const [due] = await selectDueDevices(NOW, { limit: 200 });
    expect(due).toMatchObject({
      deviceId: D1,
      orgId: 'org-1',
      lane: 'dell',
      timezone: 'UTC',
      occurrenceKey: OCCURRENCE,
      requestedCategories: ['bios', 'driver'],
      blockedUpdateIds: ['BLOCKED-1'],
      rebootControlled: true,
      // An hour before the 05:00 close.
      notAfter: new Date('2027-01-20T04:00:00.000Z'),
    });
  });

  it('reads the window in the device site timezone', async () => {
    seed([device({ siteTimezone: 'America/New_York' })]);
    // 02:00 UTC is 21:00 the evening before in New York: not in a window.
    await expect(selectDueDevices(NOW, { limit: 200 })).resolves.toEqual([]);
  });
});

describe('selectDueDevices: one exclusion each', () => {
  async function selected(row: CandidateRow, resolved: ResolvedOemUpdatesLink | null = link(), now = NOW) {
    seed([row], resolved);
    return (await selectDueDevices(now, { limit: 200 })).map((due) => due.deviceId);
  }

  it('the control: a plain due device is selected', async () => {
    await expect(selected(device())).resolves.toEqual([D1]);
  });

  it('virtual, in case the query ever widens', async () => {
    await expect(selected(device({ isVirtual: true }))).resolves.toEqual([]);
  });

  it('server role, in case the query ever widens', async () => {
    await expect(selected(device({ deviceRole: 'server' }))).resolves.toEqual([]);
  });

  it('a manufacturer near-miss', async () => {
    await expect(selected(device({ manufacturer: 'Dell EMC' }))).resolves.toEqual([]);
  });

  it('not_supported for this tool version and model', async () => {
    await expect(selected(device({
      applicability: 'not_supported',
      notSupportedToolVersion: '5.7.2',
      notSupportedModel: 'Latitude 5450',
    }))).resolves.toEqual([]);
  });

  it('not_supported for an older tool version asks again', async () => {
    await expect(selected(device({
      applicability: 'not_supported',
      notSupportedToolVersion: '5.6.0',
      notSupportedModel: 'Latitude 5450',
    }))).resolves.toEqual([D1]);
  });

  it('finished this occurrence', async () => {
    for (const lastOutcome of ['success', 'success_reboot_required', 'no_updates'] as const) {
      await expect(selected(device({ occurrenceKey: OCCURRENCE, lastOutcome, lastTrigger: 'scheduled', attempts: 1 })), lastOutcome).resolves.toEqual([]);
    }
  });

  it('a Run Now success does not finish the occurrence: it may have skipped bios and firmware', async () => {
    await expect(selected(device({ occurrenceKey: OCCURRENCE, lastOutcome: 'success', lastTrigger: 'on_demand', attempts: 1 })))
      .resolves.toEqual([D1]);
  });

  it('a site left on its UTC default does not hide the org zone', async () => {
    // 02:00 UTC is 13:00 in Sydney: working hours, not the 01:00 window.
    await expect(selected(device({ siteTimezone: 'UTC', orgSettings: { timezone: 'Australia/Sydney' } }))).resolves.toEqual([]);
    // 14:30 UTC on the 20th is 01:30 on the 21st in Sydney: catch-up night 1 is open there.
    await expect(selected(
      device({ siteTimezone: 'UTC', orgSettings: { timezone: 'Australia/Sydney' } }),
      link(),
      new Date('2027-01-20T14:30:00.000Z'),
    )).resolves.toEqual([D1]);
  });

  it('a site, org and partner all on UTC is UTC', async () => {
    await expect(selected(device({ siteTimezone: 'utc', orgSettings: { timezone: 'UTC' }, partnerTimezone: 'UTC' }))).resolves.toEqual([D1]);
  });

  it('a finish from last month does not count', async () => {
    await expect(selected(device({ occurrenceKey: '2026-12', lastOutcome: 'success', lastTrigger: 'scheduled', attempts: 1 }))).resolves.toEqual([D1]);
  });

  it('run in flight', async () => {
    for (const commandStatus of ['pending', 'sent']) {
      await expect(selected(device({ commandStatus })), commandStatus).resolves.toEqual([]);
    }
  });

  it('a settled last command is not in flight', async () => {
    await expect(selected(device({ commandStatus: 'completed' }))).resolves.toEqual([D1]);
  });

  it('attempts at 3', async () => {
    await expect(selected(device({ occurrenceKey: OCCURRENCE, attempts: 3, lastOutcome: 'failed' }))).resolves.toEqual([]);
  });

  it('attempts at 3 from last month do not count', async () => {
    await expect(selected(device({ occurrenceKey: '2026-12', attempts: 3, lastOutcome: 'failed' }))).resolves.toEqual([D1]);
  });

  it('already attempted tonight: one run a night, the next night retries', async () => {
    const tonight = new Date('2027-01-20T01:20:00.000Z');
    await expect(selected(device({
      occurrenceKey: OCCURRENCE,
      attempts: 1,
      lastOutcome: 'failed',
      lastAttemptAt: tonight,
    }))).resolves.toEqual([]);
    await expect(selected(device({
      occurrenceKey: OCCURRENCE,
      attempts: 1,
      lastOutcome: 'failed',
      lastAttemptAt: tonight,
    }), link(), new Date('2027-01-21T02:00:00.000Z'))).resolves.toEqual([D1]);
  });

  it('not in window', async () => {
    await expect(selected(device(), link(), new Date('2027-01-20T12:00:00.000Z'))).resolves.toEqual([]);
  });

  it('a scheduled run never starts after its notAfter, inside the last of the window', async () => {
    await expect(selected(device(), link(), new Date('2027-01-20T04:00:00.000Z'))).resolves.toEqual([]);
  });

  it('offset not reached', async () => {
    const id = Array.from({ length: 50 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
      .find((candidate) => stableOffsetMinutes(candidate, 240) >= 5)!;
    const offset = stableOffsetMinutes(id, 240);
    const start = new Date('2027-01-20T01:00:00.000Z').getTime();
    await expect(selected(device({ deviceId: id }), link(), new Date(start + (offset - 1) * 60_000))).resolves.toEqual([]);
    await expect(selected(device({ deviceId: id }), link(), new Date(start + offset * 60_000))).resolves.toEqual([id]);
  });

  it('maintenance suppressed', async () => {
    vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({ active: true, suppressPatching: true } as never);
    await expect(selected(device())).resolves.toEqual([]);
  });

  it('a maintenance window that does not suppress patching runs', async () => {
    vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({ active: true, suppressPatching: false } as never);
    await expect(selected(device())).resolves.toEqual([D1]);
  });

  it('a maintenance lookup that fails leaves the device out and says so', async () => {
    vi.mocked(checkDeviceMaintenanceWindow).mockRejectedValue(new Error('boom'));
    await expect(selected(device())).resolves.toEqual([]);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('flag off for the partner', async () => {
    process.env.BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST = 'partner-2';
    state.results = [[{ ...ARMED_POLICY, partnerId: 'partner-1', orgId: 'org-1' }], [device()]];
    vi.mocked(resolveOemUpdatesLinksForDevices).mockResolvedValue(new Map([[D1, link()]]));
    await expect(selectDueDevices(NOW, { limit: 200 })).resolves.toEqual([]);
  });

  it('no link reaches it', async () => {
    await expect(selected(device(), null)).resolves.toEqual([]);
  });

  it('policy off, vendor off, or stored settings unreadable', async () => {
    await expect(selected(device(), link({ enabled: false }))).resolves.toEqual([]);
    await expect(selected(device(), link({}, { enabled: false }))).resolves.toEqual([]);
    await expect(selected(device(), { ...link(), invalidStoredSettings: true })).resolves.toEqual([]);
  });

  it('a vendor the policy does not name', async () => {
    await expect(selected(device({ manufacturer: 'HP' }))).resolves.toEqual([]);
  });

  it('the agent is too old, so it cannot use up the tick', async () => {
    await expect(selected(device({ agentVersion: '0.126.0' }))).resolves.toEqual([]);
  });

  it('a closed lane, so it cannot use up the tick', async () => {
    state.openLanes = new Set();
    await expect(selected(device())).resolves.toEqual([]);
  });

  it('a lane kill switch', async () => {
    process.env.BREEZE_OEM_UPDATES_DISABLED_LANES = 'dell';
    await expect(selected(device())).resolves.toEqual([]);
  });

  it('no asked-for category is open', async () => {
    state.openCategories = ['application'];
    await expect(selected(device())).resolves.toEqual([]);
  });

  it('reboot never with only bios and firmware asked for has nothing to send', async () => {
    await expect(selected(device(), link({ reboot: 'never' }, { categories: { bios: true, firmware: true } }))).resolves.toEqual([]);
  });

  it('a pending reboot under overnight waits for the reboot', async () => {
    await expect(selected(device({ rebootPendingSince: new Date('2027-01-19T02:00:00.000Z') }))).resolves.toEqual([]);
  });

  it('a pending reboot under never keeps asking the tool', async () => {
    await expect(selected(
      device({ rebootPendingSince: new Date('2027-01-19T02:00:00.000Z') }),
      link({ reboot: 'never' }),
    )).resolves.toEqual([D1]);
  });

  it('a release still on its way to the agent', async () => {
    await expect(selected(device({ takeoverState: 'releasing' }))).resolves.toEqual([]);
  });
});

describe('selectDueDevices: paging', () => {
  it('reads the next page after the last id of a full one, and selects from it', async () => {
    const full = Array.from({ length: 500 }, (_, i) =>
      device({ deviceId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, agentVersion: '0.126.0' }));
    const last = full[full.length - 1]!.deviceId;
    const onPageTwo = '00000000-0000-4000-9000-000000000001';
    state.results = [[ARMED_POLICY], full, [device({ deviceId: onPageTwo })]];
    vi.mocked(resolveOemUpdatesLinksForDevices).mockImplementation(async (deviceIds) =>
      new Map(deviceIds.map((deviceId) => [deviceId, link()])));

    const due = await selectDueDevices(NOW, { limit: 200 });

    expect(due.map((d) => d.deviceId)).toEqual([onPageTwo]);
    const second = new PgDialect().sqlToQuery(state.wheres[2] as SQL);
    expect(second.sql).toContain('"devices"."id" >');
    expect(second.params).toContain(last);
  });

  it('the wrap-round pass stops at the cursor it started from', async () => {
    state.results = [[ARMED_POLICY], [], []];
    await selectDueDevices(NOW, { limit: 200, startAfter: D1 });
    const wrap = new PgDialect().sqlToQuery(state.wheres[2] as SQL);
    expect(wrap.sql).toContain('"devices"."id" <=');
    expect(wrap.params).toContain(D1);
  });

  it('an org-owned policy scopes the query to that org', async () => {
    state.results = [[{ ...ARMED_POLICY, orgId: 'org-1', partnerId: null }], []];
    await selectDueDevices(NOW, { limit: 200 });
    const { sql, params } = new PgDialect().sqlToQuery(state.wheres[1] as SQL);
    expect(sql).toContain('"devices"."org_id" in');
    expect(params).toContain('org-1');
  });
});

describe('selectDueDevices: the cap', () => {
  const ids = ['1', '2', '3', '4'].map((n) => `00000000-0000-4000-8000-00000000000${n}`);

  it('stops at the limit', async () => {
    seed(ids.map((deviceId) => device({ deviceId })));
    const due = await selectDueDevices(NOW, { limit: 2 });
    expect(due.map((d) => d.deviceId)).toEqual(ids.slice(0, 2));
  });

  it('checks maintenance only for devices that are otherwise due', async () => {
    seed([device({ deviceId: ids[0] }), device({ deviceId: ids[1], commandStatus: 'sent' })]);
    await selectDueDevices(NOW, { limit: 200 });
    expect(checkDeviceMaintenanceWindow).toHaveBeenCalledTimes(1);
    expect(checkDeviceMaintenanceWindow).toHaveBeenCalledWith(ids[0], NOW);
  });

  it('resumes after the cursor, then wraps round to the start', async () => {
    state.results = [[ARMED_POLICY], [device({ deviceId: ids[2] })], [device({ deviceId: ids[0] })]];
    vi.mocked(resolveOemUpdatesLinksForDevices).mockImplementation(async (deviceIds) =>
      new Map(deviceIds.map((deviceId) => [deviceId, link()])));
    const due = await selectDueDevices(NOW, { limit: 200, startAfter: ids[1] });
    expect(due.map((d) => d.deviceId)).toEqual([ids[2], ids[0]]);
  });

  it('defaults to 200 and takes the env', () => {
    expect(maxDispatchPerTick()).toBe(200);
    process.env.OEM_UPDATES_MAX_DISPATCH_PER_TICK = '50';
    expect(maxDispatchPerTick()).toBe(50);
  });

  it('an unusable env value keeps the default', () => {
    for (const value of ['0', '-1', 'lots', '1.5']) {
      process.env.OEM_UPDATES_MAX_DISPATCH_PER_TICK = value;
      expect(maxDispatchPerTick(), value).toBe(200);
    }
  });
});

describe('decideScheduledRun', () => {
  const lane: OemLane = 'dell';
  const base = { deviceId: D1, lane, status: {}, timezone: 'UTC', now: NOW };

  it('asks for what the policy turned on, in the fixed order', () => {
    const decision = decideScheduledRun({
      ...base,
      link: link({}, { categories: { driver: true, firmware: false, bios: true } }),
    });
    expect(decision).toMatchObject({ due: true, requestedCategories: ['bios', 'driver'] satisfies OemCategory[] });
  });

  it('reboot never is not a reboot Breeze controls', () => {
    expect(decideScheduledRun({ ...base, link: link({ reboot: 'never' }) })).toMatchObject({ due: true, rebootControlled: false });
  });

  it('names why a device is not due', () => {
    expect(decideScheduledRun({ ...base, link: null })).toEqual({ due: false, reason: 'no_link' });
    expect(decideScheduledRun({ ...base, link: link({ enabled: false }) })).toEqual({ due: false, reason: 'link_disabled' });
    expect(decideScheduledRun({ ...base, link: link({}, { enabled: false }) })).toEqual({ due: false, reason: 'vendor_disabled' });
    expect(decideScheduledRun({ ...base, link: link(), now: new Date('2027-01-20T12:00:00.000Z') }))
      .toEqual({ due: false, reason: 'not_in_window' });
  });
});
