import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { isM365TenantSyncEnabled } from '../../../config/env';
import { M365_STALE_FLOOR_MINUTES, m365Connections, m365SyncStaleAt, m365SyncState as s, organizations } from '../../../db/schema';
import { m365SyncHealth } from '../../integrationStates';
import { PERMISSIONS } from '../../permissions';
import type { HealthObservation, HealthSource } from '../types';
import { observeRows, staleAtBefore, staleCutoff, toHealthObservation } from './observeRows';

// M365 tenant sync: one m365_sync_state row per (org, domain), but one
// observation per CONNECTION (spec §3 grounding: one observation per
// connection), keyed by connection_id. Domains run every 6 or 24 hours, so an
// hourly observation matches the signal. Org-scoped table: the broken set is
// read through m365_sync_state_unhealthy_idx (spec §1.3); domain rows of those
// connections are then loaded by connection id (m365_sync_state_connection_idx).
// #10021 staleness: a scheduled domain (next_sync_at set) with no success for
// 3 x its interval (min 1 h) is stalled; m365_sync_state_stale_idx backs that
// arm. Tenant sync is dark by default (D7): with the flag off nothing is
// judged and every observation is retired.

const FIX_HREF = '/integrations#m365';

export type M365SyncDomain = {
  domain: string;
  lastStatus: string | null;
  lastError: string | null;
  /** Computed in SQL by staleAtBefore(m365SyncStaleAt) (#10021); false when the flag is off. */
  stale: boolean;
};
export type M365SyncConnectionRow = {
  connectionId: string;
  orgId: string;
  partnerId: string;
  connectionStatus: string | null;
  connectionCreatedAt: Date | null;
  domains: M365SyncDomain[];
};

export function m365SyncObservation(row: M365SyncConnectionRow, now: Date, syncEnabled = true): HealthObservation {
  const stalled = row.domains.filter((d) => d.stale).map((d) => d.domain).sort();
  const verdict = m365SyncHealth(row.connectionStatus, row.domains.map((d) => d.lastStatus), {
    anyStale: stalled.length > 0,
    syncEnabled,
  });
  const failing = row.domains.filter((d) => d.lastStatus === 'needs_consent' || d.lastStatus === 'error');
  // The worst domain's error first: needs_consent outranks error.
  failing.sort((a, b) => Number(b.lastStatus === 'needs_consent') - Number(a.lastStatus === 'needs_consent'));
  const detail = failing.length
    ? `Failing: ${failing.map((d) => d.domain).join(', ')}${failing[0]!.lastError ? `. ${failing[0]!.lastError}` : ''}`
    : verdict.state === 'broken' && verdict.condition === 'sync_stale'
      ? `Stalled: ${stalled.join(', ')}`
      : null;
  return toHealthObservation({
    kind: 'm365_sync',
    verdict,
    now,
    createdAt: row.connectionCreatedAt,
    sourceId: row.connectionId,
    partnerId: row.partnerId,
    orgId: row.orgId,
    displayName: 'Microsoft 365 tenant sync',
    rawDetail: detail,
    fixHref: FIX_HREF,
    viewPermission: PERMISSIONS.ORGS_READ,
    repairPermission: PERMISSIONS.ORGS_WRITE,
  });
}

const stale = (now: Date) => staleAtBefore(m365SyncStaleAt(s), now);

/**
 * Distinct connections with a broken or stalled domain. OR-of-ANDs so each arm
 * implies its own partial index (unhealthy_idx, stale_idx, never_succeeded_idx)
 * and the planner can BitmapOr them. Under RLS only leakproof quals reach an
 * index, so the stale arms pre-filter on plain columns and recheck the exact test. The stale arm is compiled only with the flag on.
 */
export function brokenConnectionsQuery(now: Date, syncEnabled: boolean) {
  const cutoff = staleCutoff(now, M365_STALE_FLOOR_MINUTES);
  const broken = sql`${s.lastStatus} IN (${sql.raw(`'needs_consent', 'error'`)})`;
  return db
    .selectDistinct({ connectionId: s.connectionId })
    .from(s)
    .where(syncEnabled
      ? sql`${broken}
          OR (${s.nextSyncAt} IS NOT NULL AND ${s.lastSuccessAt} < ${cutoff}::timestamptz AND ${stale(now)})
          OR (${s.nextSyncAt} IS NOT NULL AND ${s.lastSuccessAt} IS NULL AND ${s.createdAt} < ${cutoff}::timestamptz AND ${stale(now)})`
      : broken);
}

/** Every domain row of the given connections, grouped per connection. A connection with no rows is absent. */
async function loadConnections(connectionIds: string[], now: Date, syncEnabled: boolean): Promise<M365SyncConnectionRow[]> {
  if (connectionIds.length === 0) return [];
  const rows = await db
    .select({
      connectionId: s.connectionId,
      orgId: s.orgId,
      partnerId: organizations.partnerId,
      domain: s.domain,
      lastStatus: s.lastStatus,
      lastError: s.lastError,
      // Domain staleness also needs a tenant, mirroring the claim's eligibility (m365Sync/claim.ts).
      stale: syncEnabled
        ? sql<boolean>`(${s.nextSyncAt} IS NOT NULL AND ${m365Connections.tenantId} IS NOT NULL AND ${stale(now)})`
        : sql<boolean>`false`,
      connectionStatus: m365Connections.status,
      connectionCreatedAt: m365Connections.createdAt,
    })
    .from(s)
    .innerJoin(organizations, eq(organizations.id, s.orgId))
    .leftJoin(m365Connections, eq(m365Connections.id, s.connectionId))
    .where(inArray(s.connectionId, connectionIds))
    .orderBy(s.connectionId, s.domain);
  const byConnection = new Map<string, M365SyncConnectionRow>();
  for (const r of rows) {
    let c = byConnection.get(r.connectionId);
    if (!c) {
      c = {
        connectionId: r.connectionId,
        orgId: r.orgId,
        partnerId: r.partnerId,
        connectionStatus: r.connectionStatus ?? null,
        connectionCreatedAt: r.connectionCreatedAt ?? null,
        domains: [],
      };
      byConnection.set(r.connectionId, c);
    }
    c.domains.push({ domain: r.domain, lastStatus: r.lastStatus, lastError: r.lastError, stale: r.stale });
  }
  return [...byConnection.values()];
}

export const m365SyncSource: HealthSource = {
  kind: 'm365_sync',
  intervalMinutes: 60,
  tables: ['m365_sync_state'],
  fixHrefs: [FIX_HREF],
  brokenQuery: (now) => brokenConnectionsQuery(now, isM365TenantSyncEnabled()),
  // The flag is read per observe(), not at module load (D7a).
  observe: (now, trackedSourceIds) => {
    const syncEnabled = isM365TenantSyncEnabled();
    return observeRows<M365SyncConnectionRow>({
      now,
      trackedSourceIds,
      loadBroken: async () => loadConnections((await brokenConnectionsQuery(now, syncEnabled)).map((r) => r.connectionId), now, syncEnabled),
      loadTracked: (ids) => loadConnections(ids, now, syncEnabled),
      sourceIdOf: (r) => r.connectionId,
      toObservation: (r, at) => m365SyncObservation(r, at, syncEnabled),
    });
  },
};
