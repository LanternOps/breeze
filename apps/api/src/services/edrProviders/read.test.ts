import { describe, expect, it } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
import {
  buildEdrStatusSummary,
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
const unrestricted = (auth: AuthContext = orgAuth): EdrReadScope => ({ auth, allowedDeviceIds: null, allowedSiteIds: null });

function partnerInput(over: Partial<CoverageInput> = {}): CoverageInput {
  return {
    syncHealthVisible: true,
    connections: [{ id: 'c1', provider: 'bitdefender', status: 'connected', lastDetectionSyncAt: minutesAgo(5), detectionIntervalMinutes: 15 }],
    tenants: [{ connectionId: 'c1', orgId: ORG, lastDetectionSyncAt: minutesAgo(5), lastDetectionSyncStatus: 'success' }],
    endpoints: [{ provider: 'bitdefender', connectionId: 'c1', orgId: ORG, endpoints: 3, linkedEndpoints: 2, unhealthyEndpoints: 1 }],
    detections: [],
    legacy: { sentinelOne: false, huntress: false },
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
    const s = buildEdrStatusSummary(partnerInput({ legacy: { sentinelOne: true, huntress: true } }));
    expect(s.coverage.notes.join(' ')).toMatch(/get_s1_threats/);
    expect(s.coverage.notes.join(' ')).toMatch(/get_huntress_incidents/);
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
