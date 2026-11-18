import { describe, expect, it } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
import {
  buildEdrStatusSummary,
  buildLegacyAgentCoverageQuery,
  buildListEdrDetectionsQuery,
  EdrReadError,
  SYNC_HEALTH_PARTNER_ONLY_NOTE,
  selectStatusConnections,
  type CoverageInput,
  type EdrReadScope,
} from './read';

const ORG = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const NOW = new Date('2026-10-12T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const orgAuth = { scope: 'organization', orgId: ORG, canAccessOrg: (id: string) => id === ORG } as unknown as AuthContext;
const NO_LEGACY = { orgIds: [] as string[], agents: 0 };
const unrestricted = (auth: AuthContext = orgAuth): EdrReadScope => ({ auth, allowedDeviceIds: null, allowedSiteIds: null });

function partnerInput(over: Partial<CoverageInput> = {}): CoverageInput {
  return {
    syncHealthVisible: true,
    connections: [{ id: 'c1', provider: 'bitdefender', status: 'connected', lastDetectionSyncAt: minutesAgo(5), detectionIntervalMinutes: 15 }],
    tenants: [{ connectionId: 'c1', orgId: ORG, lastDetectionSyncAt: minutesAgo(5), lastDetectionSyncStatus: 'success' }],
    endpoints: [{ provider: 'bitdefender', connectionId: 'c1', orgId: ORG, endpoints: 3, linkedEndpoints: 2, unhealthyEndpoints: 1 }],
    detections: [],
    legacy: { sentinelOne: NO_LEGACY, huntress: NO_LEGACY },
    now: NOW,
    ...over,
  };
}

describe('buildEdrStatusSummary — coverage disclosure (D6)', () => {
  it('healthy, fully mapped, recently synced partner scope is complete coverage', () => {
    const s = buildEdrStatusSummary(partnerInput());
    expect(s.coverage).toEqual({ orgsWithEdr: 1, partial: false, notes: [] });
    expect(s.providers[0]).toMatchObject({
      provider: 'bitdefender', label: 'Bitdefender GravityZone', connectionId: 'c1', connectionStatus: 'connected',
      tenantsMapped: 1, tenantsUnmapped: 0, tenantsStale: 0, tenantsFailed: 0, tenantsPending: 0,
      endpoints: 3, linkedEndpoints: 2, unhealthyEndpoints: 1, openDetections: 0,
    });
  });

  const triggers: Array<[string, Partial<CoverageInput>, RegExp]> = [
    ['failed tenant sync', { tenants: [{ connectionId: 'c1', orgId: ORG, lastDetectionSyncAt: minutesAgo(5), lastDetectionSyncStatus: 'error' }] }, /failed their last detection sync/],
    ['partial tenant sync', { tenants: [{ connectionId: 'c1', orgId: ORG, lastDetectionSyncAt: minutesAgo(5), lastDetectionSyncStatus: 'partial' }] }, /only partially/],
    ['stale tenant (older than 2x interval)', { tenants: [{ connectionId: 'c1', orgId: ORG, lastDetectionSyncAt: minutesAgo(31), lastDetectionSyncStatus: 'success' }] }, /not synced detections recently/],
    ['never-synced tenant is pending, never complete', { tenants: [{ connectionId: 'c1', orgId: ORG, lastDetectionSyncAt: null, lastDetectionSyncStatus: null }] }, /pending/],
    ['unmapped tenant', { tenants: [
      { connectionId: 'c1', orgId: ORG, lastDetectionSyncAt: minutesAgo(5), lastDetectionSyncStatus: 'success' },
      { connectionId: 'c1', orgId: null, lastDetectionSyncAt: null, lastDetectionSyncStatus: null },
    ] }, /not mapped to an organization/],
    ['reauth-required connection', { connections: [{ id: 'c1', provider: 'bitdefender', status: 'reauth_required', lastDetectionSyncAt: minutesAgo(5), detectionIntervalMinutes: 15 }] }, /re-authentication/],
    ['no connection at all', { connections: [], tenants: [], endpoints: [] }, /No active EDR provider connection/],
    ['errored connection', { connections: [{ id: 'c1', provider: 'bitdefender', status: 'error', lastDetectionSyncAt: minutesAgo(5), detectionIntervalMinutes: 15 }] }, /error state/],
    ['connection with no mapped tenant', { tenants: [{ connectionId: 'c1', orgId: null, lastDetectionSyncAt: null, lastDetectionSyncStatus: null }] }, /no vendor tenant mapped/],
  ];
  it.each(triggers)('%s ⇒ partial with a note', (_name, over, note) => {
    const s = buildEdrStatusSummary(partnerInput(over));
    expect(s.coverage.partial).toBe(true);
    expect(s.coverage.notes.some((n) => note.test(n))).toBe(true);
  });

  it('a stale tenant exactly at 2x the interval is not yet stale', () => {
    const s = buildEdrStatusSummary(partnerInput({
      tenants: [{ connectionId: 'c1', orgId: ORG, lastDetectionSyncAt: minutesAgo(30), lastDetectionSyncStatus: 'success' }],
    }));
    expect(s.coverage.partial).toBe(false);
  });

  it('legacy S1 / Huntress coverage adds a pointer note to the legacy tools', () => {
    const s = buildEdrStatusSummary(partnerInput({ legacy: { sentinelOne: { orgIds: [ORG], agents: 1 }, huntress: { orgIds: [ORG], agents: 1 } } }));
    expect(s.coverage.notes.join(' ')).toMatch(/get_s1_threats/);
    expect(s.coverage.notes.join(' ')).toMatch(/get_huntress_incidents/);
  });

  describe('legacy integration coverage counts as EDR coverage (#10394)', () => {
    const huntressOnly = (orgIds: string[], agents: number): Partial<CoverageInput> => ({
      connections: [], tenants: [], endpoints: [],
      legacy: { sentinelOne: NO_LEGACY, huntress: { orgIds, agents } },
    });

    it('partner scope, Huntress integration and no provider connection: no "no provider" note, orgs counted, integration listed', () => {
      const s = buildEdrStatusSummary(partnerInput(huntressOnly([ORG, OTHER_ORG], 135)));
      expect(s.coverage.notes.join(' ')).not.toMatch(/No active EDR provider connection/);
      expect(s.coverage.orgsWithEdr).toBe(2);
      expect(s.integrations).toEqual([{ integration: 'huntress', label: 'Huntress (integration)', orgs: 2, agents: 135 }]);
      // The provider detection list still does not carry Huntress incidents,
      // so an empty list there is not "clean" — partial stays true.
      expect(s.coverage.partial).toBe(true);
      expect(s.coverage.notes.join(' ')).toMatch(/Huntress integration/);
      expect(s.coverage.notes.join(' ')).toMatch(/get_huntress_incidents/);
      // Framework providers stay framework-only (the web "Other EDR" tab keys off them).
      expect(s.providers).toEqual([]);
    });

    it('partner scope with neither a connection nor an integration keeps the "no provider" note', () => {
      const s = buildEdrStatusSummary(partnerInput(huntressOnly([], 0)));
      expect(s.coverage.notes.join(' ')).toMatch(/No active EDR provider connection/);
      expect(s.coverage.orgsWithEdr).toBe(0);
      expect(s.integrations).toEqual([]);
    });

    it('SentinelOne integration counts the same way', () => {
      const s = buildEdrStatusSummary(partnerInput({
        connections: [], tenants: [], endpoints: [],
        legacy: { sentinelOne: { orgIds: [ORG], agents: 7 }, huntress: NO_LEGACY },
      }));
      expect(s.coverage.notes.join(' ')).not.toMatch(/No active EDR provider connection/);
      expect(s.coverage.notes.join(' ')).toMatch(/comes from the SentinelOne integration, not an EDR provider connection/);
      expect(s.coverage.orgsWithEdr).toBe(1);
      expect(s.integrations).toEqual([{ integration: 'sentinelone', label: 'SentinelOne (integration)', orgs: 1, agents: 7 }]);
    });

    it('both integrations are named in one note', () => {
      const s = buildEdrStatusSummary(partnerInput({
        connections: [], tenants: [], endpoints: [],
        legacy: { sentinelOne: { orgIds: [ORG], agents: 7 }, huntress: { orgIds: [OTHER_ORG], agents: 3 } },
      }));
      expect(s.coverage.notes.join(' ')).toMatch(/comes from the SentinelOne and Huntress integrations, not an EDR provider connection/);
      expect(s.coverage.orgsWithEdr).toBe(2);
      expect(s.integrations?.map((i) => i.integration)).toEqual(['sentinelone', 'huntress']);
    });

    it('orgsWithEdr is the union of provider-mapped and integration orgs (no double count)', () => {
      expect(buildEdrStatusSummary(partnerInput({ legacy: { sentinelOne: NO_LEGACY, huntress: { orgIds: [ORG, OTHER_ORG], agents: 4 } } }))
        .coverage.orgsWithEdr).toBe(2);
      expect(buildEdrStatusSummary(partnerInput({ legacy: { sentinelOne: { orgIds: [ORG], agents: 1 }, huntress: { orgIds: [ORG], agents: 4 } } }))
        .coverage.orgsWithEdr).toBe(1);
    });

    it('organization scope: Huntress replaces the "no provider endpoints" note and counts the org', () => {
      const s = buildEdrStatusSummary(partnerInput({ syncHealthVisible: false, ...huntressOnly([ORG], 12) }));
      expect(s.coverage.notes.join(' ')).not.toMatch(/No EDR provider endpoints are visible/);
      expect(s.coverage.notes).toContain('EDR coverage for this organization comes from the Huntress integration, not EDR provider endpoints; '
        + 'its alerts are not in the EDR provider detection list, so an empty detection list is not evidence of no threats.');
      expect(s.coverage.orgsWithEdr).toBe(1);
      expect(s.coverage.partial).toBe(true);
      expect(s.integrations).toEqual([{ integration: 'huntress', label: 'Huntress (integration)', orgs: 1, agents: 12 }]);
    });
  });

  it('organization scope: no connection/tenant fields, explicit partner-only sync-health note', () => {
    const s = buildEdrStatusSummary(partnerInput({ syncHealthVisible: false, connections: [], tenants: [] }));
    expect(s.providers).toHaveLength(1);
    for (const key of ['connectionId', 'connectionStatus', 'tenantsMapped', 'tenantsUnmapped', 'tenantsStale', 'tenantsFailed', 'tenantsPending']) {
      expect(s.providers[0]).not.toHaveProperty(key);
    }
    expect(s.coverage.notes).toContain(SYNC_HEALTH_PARTNER_ONLY_NOTE);
    // Sync health is hidden from org scope, so completeness can never be confirmed.
    expect(s.coverage.partial).toBe(true);
  });

  it('organization scope with zero endpoint rows is partial (an empty list is not "clean")', () => {
    const s = buildEdrStatusSummary(partnerInput({ syncHealthVisible: false, connections: [], tenants: [], endpoints: [] }));
    expect(s.coverage.partial).toBe(true);
    expect(s.coverage.orgsWithEdr).toBe(0);
  });

  it('notes never echo vendor-supplied text (fixed Breeze sentences only)', () => {
    const s = buildEdrStatusSummary(partnerInput({
      connections: [{ id: 'c1', provider: 'bitdefender', status: 'reauth_required', lastDetectionSyncAt: null, detectionIntervalMinutes: null }],
      tenants: [{ connectionId: 'c1', orgId: null, lastDetectionSyncAt: null, lastDetectionSyncStatus: null }],
    }));
    for (const n of s.coverage.notes) expect(n).not.toMatch(/c1|bitdefender/);
  });
});

describe('legacy agent coverage query (DB-less SQL, #10394)', () => {
  it('groups agents by org within the caller\'s org', () => {
    const { sql, params } = buildLegacyAgentCoverageQuery(unrestricted(), {}, 'huntress').toSQL();
    expect(sql).toContain('from "huntress_agents"');
    expect(sql).toMatch(/group by "huntress_agents"\."org_id"/);
    expect(sql).toContain('"huntress_agents"."org_id" = $');
    expect(params).toContain(ORG);
  });

  it('applies the site rule to a restricted caller (linked to an allowed device, or never linked)', () => {
    const { sql, params } = buildLegacyAgentCoverageQuery({ auth: orgAuth, allowedDeviceIds: ['d1'], allowedSiteIds: ['s1'] }, {}, 'sentinelone').toSQL();
    expect(sql).toContain('from "s1_agents"');
    expect(sql).toMatch(/"s1_agents"\."device_id" is null or "s1_agents"\."device_id" in \(/);
    expect(params).toContain('d1');
  });

  it('a restricted caller with no allowed devices counts only never-linked agents', () => {
    const { sql } = buildLegacyAgentCoverageQuery({ auth: orgAuth, allowedDeviceIds: [], allowedSiteIds: [] }, {}, 'huntress').toSQL();
    expect(sql).toMatch(/"huntress_agents"\."device_id" is null/);
    expect(sql).not.toMatch(/"huntress_agents"\."device_id" in/);
  });

  it('rejects an org outside an organization caller', () => {
    expect(() => buildLegacyAgentCoverageQuery(unrestricted(), { orgId: OTHER_ORG }, 'huntress')).toThrow(EdrReadError);
  });

  it('partner scope counts only agents of an ACTIVE integration (a disabled one is not coverage)', () => {
    const partnerAuth = {
      scope: 'partner', canAccessOrg: () => true, orgCondition: () => undefined,
    } as unknown as AuthContext;
    const h = buildLegacyAgentCoverageQuery(unrestricted(partnerAuth), {}, 'huntress').toSQL();
    expect(h.sql).toMatch(/exists \(select 1 from "huntress_integrations" i where i\.id = "huntress_agents"\."integration_id" and i\.is_active\)/);
    const s1 = buildLegacyAgentCoverageQuery(unrestricted(partnerAuth), {}, 'sentinelone').toSQL();
    expect(s1.sql).toMatch(/exists \(select 1 from "s1_integrations" i where i\.id = "s1_agents"\."integration_id" and i\.is_active\)/);
  });

  it('organization scope skips the integration-state filter (org tokens cannot read the partner-axis integration row under RLS)', () => {
    expect(buildLegacyAgentCoverageQuery(unrestricted(), {}, 'huntress').toSQL().sql).not.toContain('huntress_integrations');
  });
});

describe('detection query (DB-less SQL)', () => {
  const sqlOf = (scope: EdrReadScope, q: Record<string, unknown> = {}) =>
    buildListEdrDetectionsQuery(scope, { limit: 50, offset: 0, ...q }).rows.toSQL();

  it('live rows only, org-scoped, open statuses by default', () => {
    const { sql, params } = sqlOf(unrestricted());
    expect(sql).toContain('"edr_detections"."detached_at" is null');
    expect(sql).toContain('"edr_detections"."org_id" = $');
    expect(sql).toMatch(/"edr_detections"\."status" in \(/);
    expect(params).toEqual(expect.arrayContaining([ORG, 'open', 'in_progress', 'unknown']));
  });

  it("status 'all' adds no status filter; a specific status filters to it", () => {
    expect(sqlOf(unrestricted(), { status: 'all' }).sql).not.toMatch(/"edr_detections"\."status" (in|=)/);
    const one = sqlOf(unrestricted(), { status: 'resolved' });
    expect(one.sql).toMatch(/"edr_detections"\."status" = \$/);
    expect(one.params).toContain('resolved');
  });

  it('never selects vendor jsonb (details / vendor_raw)', () => {
    const { sql } = sqlOf(unrestricted());
    expect(sql).not.toContain('"details"');
    expect(sql).not.toContain('vendor_raw');
  });

  it('applies the D14 site predicate for a restricted caller', () => {
    const { sql } = sqlOf({ auth: orgAuth, allowedDeviceIds: ['d1'], allowedSiteIds: ['s1'] });
    expect(sql).toMatch(/"edr_detections"\."breeze_device_id" in \(/);
    expect(sql).toMatch(/"edr_detections"\."last_site_id" in \(/);
  });

  it('unrestricted callers get no site predicate', () => {
    expect(sqlOf(unrestricted()).sql).not.toContain('"last_site_id" in');
  });

  it('deviceIds restricts to exactly those linked devices (no never-linked rows); empty matches nothing', () => {
    const some = sqlOf(unrestricted(), { deviceIds: ['d1', 'd2'] });
    expect(some.sql).toMatch(/"edr_detections"\."breeze_device_id" in \(/);
    expect(some.params).toEqual(expect.arrayContaining(['d1', 'd2']));
    expect(sqlOf(unrestricted(), { deviceIds: [] }).sql).toContain('false');
  });

  it('clamps limit to 200', () => {
    expect(buildListEdrDetectionsQuery(unrestricted(), { limit: 5000, offset: 0 }).limit).toBe(200);
  });

  it('an org token naming a foreign orgId is refused', () => {
    expect(() => sqlOf(unrestricted(), { orgId: OTHER_ORG })).toThrow(EdrReadError);
  });

  it('a partner token naming an inaccessible org is refused', () => {
    const partnerAuth = { scope: 'partner', canAccessOrg: () => false, orgCondition: () => undefined } as unknown as AuthContext;
    expect(() => sqlOf(unrestricted(partnerAuth), { orgId: OTHER_ORG })).toThrow(EdrReadError);
  });
});

describe('selectStatusConnections — #8658 selected-org partner coverage', () => {
  const conns = [{ id: 'c1' }, { id: 'c2' }];
  // Tenant rows are already narrowed to the caller's reach (mapped) or unmapped.
  const tenants = [
    { connectionId: 'c1', orgId: ORG },
    { connectionId: 'c2', orgId: null },
  ];

  it('a selected-org partner user with no orgId sees only connections reaching their orgs', () => {
    expect(selectStatusConnections(conns, tenants, [], { narrowToReach: true }).map((c) => c.id)).toEqual(['c1']);
  });

  it('a connection with an endpoint row in reach counts even without a mapped tenant row', () => {
    expect(selectStatusConnections(conns, tenants, [{ connectionId: 'c2' }], { narrowToReach: true }).map((c) => c.id))
      .toEqual(['c1', 'c2']);
  });

  it('all-org partner users keep every connection (unchanged)', () => {
    expect(selectStatusConnections(conns, tenants, [], { narrowToReach: false }).map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('an explicit orgId keeps its existing rule (mapped to THAT org, or an endpoint row)', () => {
    expect(selectStatusConnections(conns, tenants, [], { orgId: ORG, narrowToReach: true }).map((c) => c.id)).toEqual(['c1']);
    expect(selectStatusConnections(conns, tenants, [], { orgId: OTHER_ORG, narrowToReach: false })).toEqual([]);
  });

  it('end to end: the unreachable connection no longer produces a "no vendor tenant mapped" note', () => {
    const kept = selectStatusConnections(conns, tenants, [], { narrowToReach: true });
    const s = buildEdrStatusSummary(partnerInput({
      connections: kept.map((c) => ({ id: c.id, provider: 'bitdefender', status: 'connected' as const, lastDetectionSyncAt: minutesAgo(5), detectionIntervalMinutes: 15 })),
      tenants: [{ connectionId: 'c1', orgId: ORG, lastDetectionSyncAt: minutesAgo(5), lastDetectionSyncStatus: 'success' }],
    }));
    expect(s.coverage.notes.join(' ')).not.toMatch(/no vendor tenant mapped/);
    expect(s.coverage.partial).toBe(false);
  });
});
