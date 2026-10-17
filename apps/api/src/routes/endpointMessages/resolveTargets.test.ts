import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; orgId: string; siteId: string; agentVersion: string; status: string }>,
  select: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {
    select: () => {
      const node: Record<string, unknown> = {};
      for (const m of ['from', 'where', 'innerJoin']) node[m] = vi.fn(() => node);
      // Counted when AWAITED (executed): the group selector is an unexecuted
      // sub-select builder, which must not count as a second round trip.
      node.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
        h.select();
        return Promise.resolve(h.rows).then(ok, bad);
      };
      return node;
    },
  },
}));
vi.mock('../../db/schema', () => ({
  devices: { id: 'd.id', orgId: 'd.orgId', siteId: 'd.siteId', agentVersion: 'd.agentVersion', status: 'd.status' },
  deviceGroupMemberships: { deviceId: 'm.deviceId', groupId: 'm.groupId' },
}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn(() => ({})),
  or: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  ne: vi.fn(() => ({})),
  inArray: vi.fn(() => ({})),
}));

import { resolveTargets, resolveTargetsDetailed } from './resolveTargets';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SITE_1 = '10000000-0000-4000-8000-000000000001';
const SITE_2 = '10000000-0000-4000-8000-000000000002';
const devA1 = '0a000000-0000-4000-8000-000000000001';
const devA2 = '0a000000-0000-4000-8000-000000000002';
const devB1 = '0b000000-0000-4000-8000-000000000001';
const devC1 = '0c000000-0000-4000-8000-000000000001';

const row = (id: string, orgId: string, siteId = SITE_1) =>
  ({ id, orgId, siteId, agentVersion: '1.0.0', status: 'online' });

function makeAuth(opts: {
  scope: 'organization' | 'partner' | 'system';
  orgId?: string | null;
  accessibleOrgIds?: string[] | null;
}) {
  const accessible = opts.accessibleOrgIds === undefined ? null : opts.accessibleOrgIds;
  return {
    scope: opts.scope,
    orgId: opts.orgId ?? null,
    accessibleOrgIds: accessible,
    canAccessOrg: (id: string) => (accessible === null ? true : accessible.includes(id)),
  } as never;
}

describe('resolveTargets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.rows = [];
  });

  it('splits a selected-access partner user\'s cross-org selection into per-org groups and rejects orgs they cannot access', async () => {
    h.rows = [row(devA1, ORG_A), row(devB1, ORG_B), row(devC1, ORG_C)];
    const selectedPartnerAuth = makeAuth({ scope: 'partner', accessibleOrgIds: [ORG_A, ORG_B] });

    const { groups, denied } = await resolveTargetsDetailed(selectedPartnerAuth, { deviceIds: [devA1, devB1, devC1] });

    expect(groups.map((g) => g.orgId).sort()).toEqual([ORG_A, ORG_B].sort());
    expect(groups.flatMap((g) => g.deviceIds)).not.toContain(devC1);
    expect(groups.find((g) => g.orgId === ORG_A)!.deviceIds).toEqual([devA1]);
    expect(groups.find((g) => g.orgId === ORG_B)!.deviceIds).toEqual([devB1]);
    // The explicitly named device in the inaccessible org is reported, not silently dropped.
    expect(denied).toEqual([{ deviceId: devC1, orgId: ORG_C }]);
  });

  it('resolveTargets returns just the groups', async () => {
    h.rows = [row(devA1, ORG_A), row(devB1, ORG_B)];
    const groups = await resolveTargets(makeAuth({ scope: 'partner', accessibleOrgIds: [ORG_A, ORG_B] }), { deviceIds: [devA1, devB1] });
    expect(groups.map((g) => g.orgId).sort()).toEqual([ORG_A, ORG_B].sort());
  });

  it('an org-scoped user only reaches their own org even if the query returns rows from another', async () => {
    h.rows = [row(devA1, ORG_A), row(devB1, ORG_B)];
    const { groups, denied } = await resolveTargetsDetailed(makeAuth({ scope: 'organization', orgId: ORG_A }), { deviceIds: [devA1, devB1] });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ orgId: ORG_A, deviceIds: [devA1] });
    expect(denied).toEqual([{ deviceId: devB1, orgId: ORG_B }]);
  });

  it('explicitly named devices the query never returned are denied with no org (no existence oracle)', async () => {
    h.rows = [row(devA1, ORG_A)];
    const { groups, denied } = await resolveTargetsDetailed(makeAuth({ scope: 'system' }), { deviceIds: [devA1, devB1] });
    expect(groups.flatMap((g) => g.deviceIds)).toEqual([devA1]);
    expect(denied).toEqual([{ deviceId: devB1, orgId: null }]);
  });

  it('drops devices at sites outside the caller\'s site allowlist and reports named ones as denied', async () => {
    h.rows = [row(devA1, ORG_A, SITE_1), row(devA2, ORG_A, SITE_2)];
    const { groups, denied } = await resolveTargetsDetailed(
      makeAuth({ scope: 'organization', orgId: ORG_A }),
      { deviceIds: [devA1, devA2] },
      { permissions: { allowedSiteIds: [SITE_1] } as never },
    );
    expect(groups[0]!.deviceIds).toEqual([devA1]);
    expect(denied).toEqual([{ deviceId: devA2, orgId: ORG_A }]);
  });

  it('de-duplicates a device matched by several selectors', async () => {
    h.rows = [row(devA1, ORG_A), row(devA1, ORG_A), row(devA2, ORG_A)];
    const groups = await resolveTargets(makeAuth({ scope: 'system' }), { siteIds: [SITE_1], deviceIds: [devA1] });
    expect(groups[0]!.deviceIds.sort()).toEqual([devA1, devA2].sort());
  });

  it('resolves once (a snapshot): exactly one query regardless of selector count', async () => {
    h.rows = [row(devA1, ORG_A)];
    await resolveTargets(makeAuth({ scope: 'system' }), {
      deviceIds: [devA1], siteIds: [SITE_1], deviceGroupIds: ['20000000-0000-4000-8000-000000000001'], orgId: ORG_A,
    });
    expect(h.select).toHaveBeenCalledTimes(1);
  });

  it('an orgId alongside other selectors is a scope restriction, never a widening', async () => {
    h.rows = [row(devA1, ORG_A), row(devB1, ORG_B)];
    const groups = await resolveTargets(makeAuth({ scope: 'system' }), { deviceIds: [devA1, devB1], orgId: ORG_A });
    expect(groups.flatMap((g) => g.deviceIds)).toEqual([devA1]);
  });

  it('carries the per-device facts the sender needs (site, agent version) and never a partner-owned artifact', async () => {
    h.rows = [{ id: devA1, orgId: ORG_A, siteId: SITE_1, agentVersion: '2.3.4', status: 'online' }];
    const groups = await resolveTargets(makeAuth({ scope: 'system' }), { orgId: ORG_A });
    expect(groups).toEqual([
      { orgId: ORG_A, deviceIds: [devA1], devices: [{ id: devA1, siteId: SITE_1, agentVersion: '2.3.4' }] },
    ]);
  });
});
