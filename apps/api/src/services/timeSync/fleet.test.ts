import { beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../../middleware/auth';
const m = vi.hoisted(() => ({
  select: vi.fn(),
  view: vi.fn(),
  queue: [] as unknown[][],
}));
vi.mock('../../db', () => ({ db: { select: m.select } }));
vi.mock('./view', () => ({ getDeviceTimeStatusView: m.view }));
import {
  fleetScope,
  fleetTimeFiltersSchema,
  listFleetTimeStatus,
  FleetTimeForbidden,
} from './fleet';
const org = '11111111-1111-4111-8111-111111111111',
  site = '22222222-2222-4222-8222-222222222222';
const device = '33333333-3333-4333-8333-333333333333',
  pdc = '44444444-4444-4444-8444-444444444444';
function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    scope: 'organization',
    orgId: org,
    accessibleOrgIds: [org],
    orgCondition: (column) => eq(column, org),
    canAccessOrg: (id) => id === org,
    ...overrides,
  } as AuthContext;
}
const header = (id: string) => ({
  deviceId: id,
  hostname: id === pdc ? 'PDC' : 'Member',
  orgId: org,
  orgName: 'Customer',
  siteId: site,
  siteName: 'Main',
});
const view = (id: string) => ({
  deviceId: id,
  state: 'reported',
  stale: false,
  receivedAt: '2026-09-28T12:00:00Z',
  collectedAt: '2026-09-28T12:00:00Z',
  health: 'healthy',
  findings: [],
  config: null,
  status: null,
  domain: {
    joinType: 'on_prem_ad',
    role: id === pdc ? 'pdc_emulator' : 'member',
    domainDns: 'example.com',
    forestDns: 'example.com',
    pdcName: 'PDC',
  },
  timezone: null,
  recentEvents: [],
  enforcement: null,
});
beforeEach(() => {
  m.queue = [];
  m.select.mockReset();
  m.view.mockReset().mockImplementation(async (id: string) => view(id));
  m.select.mockImplementation(() => {
    const rows = m.queue.shift() ?? [];
    const chain: any = {
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve),
    };
    for (const key of [
      'from',
      'innerJoin',
      'leftJoin',
      'where',
      'orderBy',
      'limit',
      'offset',
      'groupBy',
    ])
      chain[key] = vi.fn(() => chain);
    return chain;
  });
});
it('intersects organization, site, device and explicit filters', () => {
  const query = new PgDialect().sqlToQuery(
    fleetScope(
      { siteId: site, deviceId: device },
      auth({ allowedSiteIds: [site], allowedDeviceIds: [device] }),
    )!,
  );
  expect(query.params).toContain(org);
  expect(query.params.filter((p) => p === site)).toHaveLength(2);
  expect(query.params.filter((p) => p === device)).toHaveLength(2);
  expect(query.sql).toContain('"devices"."org_id"');
  // Devices parked in the unassigned-pool holding org never reach the fleet
  // report or list_time_sync_issues (parkedFanout contract).
  expect(query.sql).toContain("parked_org.type = 'unassigned_pool'");
  expect(
    new PgDialect().sqlToQuery(fleetScope({}, auth({ allowedSiteIds: [] }))!)
      .sql,
  ).toContain('false');
  expect(
    new PgDialect().sqlToQuery(fleetScope({}, auth({ allowedDeviceIds: [] }))!)
      .sql,
  ).toContain('false');
  expect(() => fleetScope({ orgId: pdc }, auth())).toThrow(FleetTimeForbidden);
});
it('validates vocabulary and bounded pages', () => {
  for (const q of [
    { health: 'bad' },
    { finding: 'invented' },
    { role: 'administrator' },
    { page: 0 },
    { limit: 101 },
    { orgId: 'invalid' },
  ])
    expect(fleetTimeFiltersSchema.safeParse(q).success).toBe(false);
  expect(fleetTimeFiltersSchema.parse({})).toMatchObject({
    page: 1,
    limit: 50,
  });
});
it('finds a PDC beyond the filtered page', async () => {
  m.queue.push(
    [{ total: 20 }],
    [header(device)],
    [{ orgId: org, domainDns: 'example.com', pdcExpected: true, pdcId: pdc }],
    [header(pdc)],
  );
  expect(
    await listFleetTimeStatus(
      { finding: 'sync_stale', role: 'member', page: 2, limit: 1 },
      auth(),
    ),
  ).toMatchObject({
    total: 20,
    page: 2,
    limit: 1,
    data: [{ deviceId: device }],
    domains: [
      {
        orgId: org,
        domainDns: 'example.com',
        pdcExpected: true,
        pdcEnrolled: true,
        pdc: { deviceId: pdc },
      },
    ],
  });
  const query = new PgDialect().sqlToQuery(
    m.select.mock.results[2]!.value.where.mock.calls[0][0],
  );
  expect(query.params).toContain(org);
  expect(query.params).not.toContain('sync_stale');
  expect(query.params).not.toContain('member');
  expect(m.view.mock.calls).toEqual([[device], [pdc]]);
});
it('keeps equal DNS names in different organizations separate', async () => {
  const other = pdc;
  m.queue.push(
    [{ total: 2 }],
    [header(device), { ...header(site), orgId: other }],
    [
      { orgId: org, domainDns: 'example.com', pdcExpected: true, pdcId: null },
      {
        orgId: other,
        domainDns: 'example.com',
        pdcExpected: true,
        pdcId: null,
      },
    ],
  );
  const result = await listFleetTimeStatus(
    {},
    auth({
      scope: 'partner',
      orgCondition: () => undefined,
      canAccessOrg: () => true,
    }),
  );
  expect(result.domains.map((d) => d.orgId)).toEqual([org, other]);
});
it('reports an expected missing PDC without inventing a device', async () => {
  m.queue.push(
    [{ total: 1 }],
    [header(device)],
    [{ orgId: org, domainDns: 'example.com', pdcExpected: true, pdcId: null }],
  );
  expect((await listFleetTimeStatus({}, auth())).domains).toEqual([
    {
      orgId: org,
      domainDns: 'example.com',
      pdcExpected: true,
      pdcEnrolled: false,
      pdc: null,
    },
  ]);
});
it('recomputes timezone filtering from the live site mapping', () => {
  const query = new PgDialect().sqlToQuery(
    fleetScope({ finding: 'timezone_mismatch' }, auth())!,
  );
  expect(query.sql).toContain('array_remove');
  expect(query.sql).toContain('IS DISTINCT FROM');
  expect(query.sql).toContain('"sites"."timezone"');
  expect(
    query.params.some(
      (p) => typeof p === 'string' && p.includes('Eastern Standard Time'),
    ),
  ).toBe(true);
});
it('returns an empty report with no visible devices', async () => {
  m.queue.push([{ total: 0 }], []);
  expect(await listFleetTimeStatus({}, auth({ allowedSiteIds: [] }))).toEqual({
    data: [],
    total: 0,
    page: 1,
    limit: 50,
    domains: [],
  });
  expect(m.view).not.toHaveBeenCalled();
});
