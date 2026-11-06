import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import { OEM_UPDATES_POLICY_DEFAULTS } from '@breeze/shared';

// #11074: the fleet route. The real display-state, policy-side and link-picking
// code runs here over mocked rows, so `counts` are checked against the rule the
// device section uses. Real RLS and a real 10,000-device plan are in
// __tests__/integration/oemUpdatesFleet.integration.test.ts.

const h = vi.hoisted(() => ({
  auth: {
    scope: 'partner' as string,
    orgId: null as string | null,
    partnerId: 'partner-1' as string | null,
    accessibleOrgIds: ['org-1', 'org-2'] as string[] | null,
  },
  allowedSiteIds: undefined as string[] | undefined,
  fleetRows: [] as Array<Record<string, unknown>>,
  candidates: [] as Array<Record<string, unknown>>,
  selects: [] as Array<Record<string, unknown>>,
  wheres: [] as unknown[],
  open: ['driver'] as string[],
  perDeviceWalk: vi.fn(),
  computeOccurrence: vi.fn(),
}));

vi.mock('../../db', () => {
  const chain = (rows: () => unknown[]) => {
    const c: Record<string, unknown> = {
      from: () => c,
      leftJoin: () => c,
      innerJoin: () => c,
      where: (condition: unknown) => { h.wheres.push(condition); return c; },
      orderBy: () => c,
      limit: () => Promise.resolve(rows()),
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows()).then(resolve),
    };
    return c;
  };
  return {
    db: {
      select: vi.fn((shape: Record<string, unknown>) => {
        h.selects.push(shape);
        return chain(() => ('hostname' in shape ? h.fleetRows : h.candidates));
      }),
    },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: vi.fn((c: any, next: any) => {
      c.set('auth', {
        user: { id: 'user-1' },
        scope: h.auth.scope,
        orgId: h.auth.orgId,
        partnerId: h.auth.partnerId,
        accessibleOrgIds: h.auth.accessibleOrgIds,
        canAccessOrg: (orgId: string) => h.auth.accessibleOrgIds === null || h.auth.accessibleOrgIds.includes(orgId),
        orgCondition: actual.buildOrgAccessClosures(h.auth.accessibleOrgIds).orgCondition,
      });
      return next();
    }),
    requireScope: vi.fn(() => async (_c: any, next: any) => next()),
    requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
      if (c.req.header('x-deny-permission') === `${resource}:${action}`) {
        return c.json({ error: 'Permission denied' }, 403);
      }
      c.set('permissions', {
        permissions: [{ resource, action }],
        ...(h.allowedSiteIds ? { allowedSiteIds: h.allowedSiteIds } : {}),
      });
      return next();
    }),
  };
});

vi.mock('../../services/oemUpdates/resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/oemUpdates/resolver')>()),
  resolveOemUpdatesLinkForDevice: h.perDeviceWalk,
}));

vi.mock('../../services/oemUpdates/occurrence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/oemUpdates/occurrence')>();
  return {
    ...actual,
    computeOccurrence: (...args: Parameters<typeof actual.computeOccurrence>) => {
      h.computeOccurrence();
      return actual.computeOccurrence(...args);
    },
  };
});

vi.mock('../../services/oemUpdates/toolManifest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/oemUpdates/toolManifest')>()),
  isLaneOpen: vi.fn(() => h.open.length > 0),
  openCategoriesForLane: vi.fn(() => h.open),
}));

vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));

import { deriveOemDisplayState, OEM_DISPLAY_STATES } from '../../services/oemUpdates/displayState';
import { computeOccurrence } from '../../services/oemUpdates/occurrence';
import { oemUpdatesFleetRoutes } from './fleet';

// Third Wednesday of February 2027 is the 17th, and 7 catch-up nights end on the
// 24th, so at this instant the 2027-02 occurrence has no night left.
const NOW = new Date('2027-03-01T12:00:00.000Z');
const LAST_NIGHT_OPENED = new Date('2027-02-24T01:00:00.000Z');
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');

const armedSettings = {
  ...OEM_UPDATES_POLICY_DEFAULTS,
  enabled: true,
  vendors: { dell: { enabled: true, categories: { driver: true }, blockedUpdateIds: [] } },
};

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    linkId: 'link-1',
    sourcePolicyId: 'policy-1',
    inlineSettings: armedSettings,
    assignedPolicyId: 'policy-1',
    policyOrgId: 'org-1',
    policyPartnerId: null,
    assignmentLevel: 'organization',
    assignmentTargetId: 'org-1',
    assignmentPriority: 0,
    assignmentCreatedAt: LONG_AGO,
    linkUpdatedAt: LONG_AGO,
    roleFilter: null,
    osFilter: null,
    ...overrides,
  };
}

let nextId = 0;
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  nextId += 1;
  return {
    deviceId: `device-${nextId}`,
    hostname: `host-${String(nextId).padStart(5, '0')}`,
    orgId: 'org-1',
    orgName: 'Org One',
    partnerId: 'partner-1',
    siteId: 'site-1',
    siteName: 'Site One',
    deviceStatus: 'online',
    osType: 'windows',
    isVirtual: false,
    deviceRole: 'workstation',
    enrolledAt: LONG_AGO,
    manufacturer: 'Dell Inc.',
    model: 'Latitude 7420',
    siteTimezone: 'UTC',
    orgTimezone: null,
    partnerTimezone: 'UTC',
    partnerSettingsTimezone: null,
    groupIds: [],
    statusLane: null,
    applicability: null,
    reason: null,
    lastOutcome: null,
    occurrenceKey: null,
    attempts: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    rebootPendingSince: null,
    ...overrides,
  };
}

/** One row for each display state, under the armed org-1 link. */
function oneOfEach(): Record<string, Record<string, unknown>> {
  return {
    up_to_date: row({ applicability: 'applicable', occurrenceKey: '2027-02', lastOutcome: 'success', lastSuccessAt: LAST_NIGHT_OPENED }),
    overdue: row({ applicability: 'applicable', occurrenceKey: '2027-01', lastOutcome: 'success', lastSuccessAt: LONG_AGO }),
    failing: row({ applicability: 'applicable', occurrenceKey: '2027-02', lastOutcome: 'failed', attempts: 1 }),
    not_supported: row({ applicability: 'not_supported' }),
    not_managed: row({ manufacturer: 'Generic', model: 'Box' }),
    waiting_for_reboot: row({ applicability: 'applicable', rebootPendingSince: new Date(NOW.getTime() - 60 * 60 * 1000) }),
    reboot_overdue: row({ applicability: 'applicable', rebootPendingSince: new Date(NOW.getTime() - 4 * 24 * 60 * 60 * 1000) }),
  };
}

function app(): Hono {
  const root = new Hono();
  root.route('/oem-updates', oemUpdatesFleetRoutes);
  return root;
}

async function getFleet(query = ''): Promise<{ status: number; body: any }> {
  const response = await app().request(`/oem-updates/fleet${query}`);
  return { status: response.status, body: await response.json() };
}

const render = (condition: unknown) => new PgDialect().sqlToQuery(condition as never);

function fleetWhere(): { sql: string; params: unknown[] } {
  // The fleet read is the only one with a where: the links rest on RLS and joins.
  expect(h.wheres).toHaveLength(1);
  return render(h.wheres[0]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
  nextId = 0;
  h.auth = { scope: 'partner', orgId: null, partnerId: 'partner-1', accessibleOrgIds: ['org-1', 'org-2'] };
  h.allowedSiteIds = undefined;
  h.fleetRows = [];
  h.candidates = [candidate()];
  h.selects = [];
  h.wheres = [];
  h.open = ['driver'];
  h.perDeviceWalk.mockReset();
  h.computeOccurrence.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('GET /oem-updates/fleet: who can read what', () => {
  it('needs devices:read', async () => {
    const response = await app().request('/oem-updates/fleet', { headers: { 'x-deny-permission': 'devices:read' } });
    expect(response.status).toBe(403);
    expect(h.selects).toEqual([]);
  });

  it('scopes a partner caller to its orgs', async () => {
    await getFleet();
    const where = fleetWhere();
    expect(where.params).toEqual(expect.arrayContaining(['org-1', 'org-2']));
  });

  it('scopes an org caller to its own org', async () => {
    h.auth = { scope: 'organization', orgId: 'org-1', partnerId: null, accessibleOrgIds: ['org-1'] };
    await getFleet();
    const where = fleetWhere();
    expect(where.params).toContain('org-1');
    expect(where.params).not.toContain('org-2');
  });

  it('refuses an org the caller cannot reach', async () => {
    const { status } = await getFleet('?orgId=33333333-3333-4333-8333-333333333333');
    expect(status).toBe(403);
    expect(h.selects).toEqual([]);
  });

  it('asks a system caller to name an org rather than walk the whole platform', async () => {
    h.auth = { scope: 'system', orgId: null, partnerId: null, accessibleOrgIds: null };
    const { status } = await getFleet();
    expect(status).toBe(400);
    expect(h.selects).toEqual([]);
  });

  it('keeps a site-restricted caller to their sites', async () => {
    h.allowedSiteIds = ['site-1'];
    await getFleet();
    const where = fleetWhere();
    expect(where.params).toContain('site-1');
    expect(where.sql).toContain('"site_id" in');
  });

  it('shows a caller restricted to no sites nothing', async () => {
    h.allowedSiteIds = [];
    await getFleet();
    expect(fleetWhere().sql).toContain('false');
  });

  it('leaves out ephemeral, parked and decommissioned devices', async () => {
    await getFleet();
    const where = fleetWhere();
    expect(where.sql).toContain('"is_ephemeral"');
    expect(where.sql).toContain('unassigned_pool');
    expect(where.sql).toContain('"status" <>');
    expect(where.params).toEqual(expect.arrayContaining([false, 'decommissioned']));
  });
});

describe('GET /oem-updates/fleet: filters and paging', () => {
  it('rejects a state, lane or page outside the vocabulary', async () => {
    expect((await getFleet('?state=broken')).status).toBe(400);
    expect((await getFleet('?lane=acer')).status).toBe(400);
    expect((await getFleet('?limit=0')).status).toBe(400);
    expect((await getFleet('?limit=201')).status).toBe(400);
    expect((await getFleet('?offset=-1')).status).toBe(400);
    expect((await getFleet('?orgId=nope')).status).toBe(400);
  });

  it('orgId narrows the query', async () => {
    // Reachable among others, so only the filter itself can narrow to it.
    const orgId = '44444444-4444-4444-8444-444444444444';
    h.auth.accessibleOrgIds = [orgId, 'org-2'];
    await getFleet(`?orgId=${orgId}`);
    const where = fleetWhere();
    expect(where.sql).toContain('"devices"."org_id" = ');
    expect(where.params.filter((param) => param === orgId)).toHaveLength(2);
  });

  it('state narrows the list and total, and the counts still show every state', async () => {
    const rows = oneOfEach();
    h.fleetRows = [...Object.values(rows), row({ applicability: 'applicable', occurrenceKey: '2027-01', lastOutcome: 'success', lastSuccessAt: LONG_AGO })];

    const { status, body } = await getFleet('?state=overdue');

    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.devices).toHaveLength(2);
    expect(body.devices.every((device: any) => device.displayState === 'overdue')).toBe(true);
    expect(body.counts).toEqual({
      up_to_date: 1, overdue: 2, failing: 1, not_supported: 1, not_managed: 1, waiting_for_reboot: 1, reboot_overdue: 1,
    });
  });

  it('lane narrows the list and the counts', async () => {
    h.fleetRows = [
      row({ manufacturer: 'Dell Inc.' }),
      row({ manufacturer: 'HP', model: 'EliteBook' }),
      row({ manufacturer: 'Lenovo', model: 'T14' }),
    ];

    const { body } = await getFleet('?lane=hp');

    expect(body.total).toBe(1);
    expect(body.devices[0].hostname).toBe('host-00002');
    expect(body.devices[0].lane).toBe('hp');
    expect(Object.values<number>(body.counts).reduce((sum, count) => sum + count, 0)).toBe(1);
  });

  it('a lane comes from a past run when the hardware no longer offers one', async () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
    h.fleetRows = [row({ statusLane: 'dell', applicability: 'applicable', rebootPendingSince: new Date(NOW.getTime() - 60_000) })];
    const { body } = await getFleet('?lane=dell');
    expect(body.total).toBe(1);
    expect(body.devices[0].lane).toBe('dell');
  });

  it('limit and offset page the filtered list in the query order', async () => {
    h.fleetRows = Array.from({ length: 5 }, () => row());
    const { body } = await getFleet('?limit=2&offset=2');
    expect(body.total).toBe(5);
    expect(body.devices.map((device: any) => device.hostname)).toEqual(['host-00003', 'host-00004']);
  });

  it('a row carries what the view shows and no more', async () => {
    h.fleetRows = [row({ reason: 'release_gave_up', applicability: 'applicable', lastOutcome: 'failed', lastAttemptAt: LONG_AGO, statusLane: 'dell' })];
    const { body } = await getFleet();
    expect(body.devices[0]).toEqual({
      deviceId: 'device-1',
      hostname: 'host-00001',
      orgId: 'org-1',
      orgName: 'Org One',
      siteId: 'site-1',
      siteName: 'Site One',
      deviceStatus: 'online',
      lane: 'dell',
      displayState: 'failing',
      lastOutcome: 'failed',
      lastAttemptAt: LONG_AGO.toISOString(),
      lastSuccessAt: null,
      rebootPendingSince: null,
      scheduleNotHandedBack: true,
    });
  });
});

describe('GET /oem-updates/fleet: states', () => {
  it('every row reads what deriveOemDisplayState says, and the counts add up', async () => {
    const rows = oneOfEach();
    h.fleetRows = Object.values(rows);

    const { body } = await getFleet();

    // Asked directly of the rule, per row, not of anything the route computed.
    const schedule = { ...armedSettings.schedule, catchUpNights: armedSettings.catchUpNights };
    const occurrence = computeOccurrence(schedule, 'UTC', NOW);
    expect(occurrence.isPastLastNight).toBe(true);
    const expected = Object.values(rows).map((source) => deriveOemDisplayState({
      status: source.applicability === null ? null : source as never,
      linkEnabled: source.manufacturer === 'Dell Inc.',
      rebootMode: armedSettings.reboot,
      occurrence: source.manufacturer === 'Dell Inc.' ? occurrence : null,
      now: NOW,
    }));
    expect(body.devices.map((device: any) => device.displayState)).toEqual(expected);

    // And the fixture does reach all seven, so the comparison above covers them.
    expect(expected).toEqual(Object.keys(rows));
    for (const state of OEM_DISPLAY_STATES) expect(body.counts[state]).toBe(1);
    expect(body.total).toBe(OEM_DISPLAY_STATES.length);
  });

  it('with the flag off nothing is read from policy, and only recorded facts show', async () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
    const rows = oneOfEach();
    h.fleetRows = Object.values(rows);

    const { body } = await getFleet();

    expect(h.selects).toHaveLength(1);
    expect(body.counts).toEqual({
      up_to_date: 0, overdue: 0, failing: 0, not_supported: 1, not_managed: 4, waiting_for_reboot: 1, reboot_overdue: 1,
    });
  });

  it('a partner off the allowlist reads as off, in a fleet that spans the flag', async () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST', 'partner-other');
    h.fleetRows = [row({ applicability: 'applicable', occurrenceKey: '2027-01', lastSuccessAt: LONG_AGO })];
    const { body } = await getFleet();
    expect(body.devices[0].displayState).toBe('not_managed');
    expect(body.devices[0].lane).toBeNull();
  });

  it('a closed lane reads as not managed, not overdue: nothing could have run', async () => {
    h.open = [];
    h.fleetRows = [row({ applicability: 'applicable', occurrenceKey: '2027-01', lastSuccessAt: LONG_AGO })];
    const { body } = await getFleet();
    expect(body.devices[0].displayState).toBe('not_managed');
  });

  it('a device no assignment reaches is not managed', async () => {
    h.candidates = [candidate({ assignmentLevel: 'site', assignmentTargetId: 'site-other' })];
    h.fleetRows = [row({ applicability: 'applicable', occurrenceKey: '2027-01', lastSuccessAt: LONG_AGO })];
    const { body } = await getFleet();
    expect(body.devices[0].displayState).toBe('not_managed');
  });

  it('a partner-wide link reaches its orgs, and a group assignment needs the membership', async () => {
    h.candidates = [candidate({ policyOrgId: null, policyPartnerId: 'partner-1', assignmentLevel: 'device_group', assignmentTargetId: 'group-1' })];
    h.fleetRows = [
      row({ groupIds: ['group-1'], occurrenceKey: '2027-01', applicability: 'applicable', lastSuccessAt: LONG_AGO }),
      row({ groupIds: ['group-2'], occurrenceKey: '2027-01', applicability: 'applicable', lastSuccessAt: LONG_AGO }),
    ];
    const { body } = await getFleet();
    expect(body.devices.map((device: any) => device.displayState)).toEqual(['overdue', 'not_managed']);
  });

  it('a device on a `never` policy waits for a restart without going overdue', async () => {
    h.candidates = [candidate({ inlineSettings: { ...armedSettings, reboot: 'never' } })];
    h.fleetRows = [row({ applicability: 'applicable', rebootPendingSince: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000) })];
    const { body } = await getFleet();
    expect(body.devices[0].displayState).toBe('waiting_for_reboot');
  });

  it('the zone comes from the org when the site is on the UTC default', async () => {
    // UTC's last night closed at 05:00Z. At 07:00Z it is still 23:00 on the 23rd in
    // Los Angeles, where the last night has not opened.
    vi.setSystemTime(new Date('2027-02-24T07:00:00.000Z'));
    const stale = { applicability: 'applicable', occurrenceKey: '2027-01', lastSuccessAt: null };
    h.fleetRows = [
      row({ ...stale, orgTimezone: 'America/Los_Angeles' }),
      row({ ...stale }),
    ];
    const { body } = await getFleet();
    expect(body.devices.map((device: any) => device.displayState)).toEqual(['not_managed', 'overdue']);
  });

  describe('a policy armed after the occurrence had no night left', () => {
    const stale = { applicability: 'applicable', occurrenceKey: '2027-01', lastSuccessAt: null };

    it('does not read overdue when the link came later', async () => {
      h.candidates = [candidate({ linkUpdatedAt: new Date('2027-02-26T00:00:00.000Z') })];
      h.fleetRows = [row(stale)];
      expect((await getFleet()).body.devices[0].displayState).toBe('not_managed');
    });

    it('does not read overdue when the assignment came later', async () => {
      h.candidates = [candidate({ assignmentCreatedAt: new Date('2027-02-26T00:00:00.000Z') })];
      h.fleetRows = [row(stale)];
      expect((await getFleet()).body.devices[0].displayState).toBe('not_managed');
    });

    it('does not read overdue when the device enrolled later', async () => {
      h.fleetRows = [row({ ...stale, enrolledAt: new Date('2027-02-26T00:00:00.000Z') })];
      expect((await getFleet()).body.devices[0].displayState).toBe('not_managed');
    });

    it('a link in place before the last night opened still reads overdue', async () => {
      h.candidates = [candidate({ linkUpdatedAt: new Date(LAST_NIGHT_OPENED.getTime() - 60_000) })];
      h.fleetRows = [row(stale)];
      expect((await getFleet()).body.devices[0].displayState).toBe('overdue');
    });
  });
});

describe('GET /oem-updates/fleet: 10,000 devices', () => {
  it('stays two queries, with no per-device resolver walk', async () => {
    h.candidates = [
      candidate(),
      candidate({ linkId: 'link-2', assignedPolicyId: 'policy-2', sourcePolicyId: 'policy-2', policyOrgId: 'org-2', assignmentTargetId: 'org-2' }),
    ];
    h.fleetRows = Array.from({ length: 10_000 }, (_, index) => row({
      orgId: index % 2 === 0 ? 'org-1' : 'org-2',
      applicability: 'applicable',
      occurrenceKey: index % 3 === 0 ? '2027-02' : '2027-01',
      lastOutcome: 'success',
      lastSuccessAt: LONG_AGO,
      siteTimezone: index % 5 === 0 ? 'America/New_York' : 'UTC',
    }));

    const { status, body } = await getFleet('?limit=50');

    expect(status).toBe(200);
    expect(body.total).toBe(10_000);
    expect(body.devices).toHaveLength(50);
    expect(Object.values<number>(body.counts).reduce((sum, count) => sum + count, 0)).toBe(10_000);

    expect(h.selects).toHaveLength(2);
    expect(h.perDeviceWalk).not.toHaveBeenCalled();
    // Once per link and zone, not per device.
    expect(h.computeOccurrence.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('asks for group ids only when a group assignment could use them', async () => {
    h.fleetRows = [row()];
    await getFleet();
    expect(h.selects.find((shape) => 'hostname' in shape)).not.toHaveProperty('groupIds');

    h.selects = [];
    h.candidates = [candidate({ assignmentLevel: 'device_group', assignmentTargetId: 'group-1' })];
    await getFleet();
    expect(h.selects.find((shape) => 'hostname' in shape)).toHaveProperty('groupIds');
  });

  it('reads no policy at all when the query has nothing to resolve against', async () => {
    h.candidates = [];
    h.fleetRows = [row()];
    const { body } = await getFleet();
    expect(body.devices[0].displayState).toBe('not_managed');
  });
});
