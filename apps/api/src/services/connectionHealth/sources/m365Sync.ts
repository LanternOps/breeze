import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { m365Connections, m365SyncState as s, organizations } from '../../../db/schema';
import { m365SyncHealth } from '../../integrationStates';
import { PERMISSIONS } from '../../permissions';
import type { HealthObservation, HealthSource } from '../types';
import { observeRows, toHealthObservation } from './observeRows';

// M365 tenant sync: one m365_sync_state row per (org, domain), but one
// observation per CONNECTION (spec §3 grounding: one observation per
// connection), keyed by connection_id. Domains run every 6 or 24 hours, so an
// hourly observation matches the signal. Org-scoped table: the broken set is
// read through m365_sync_state_unhealthy_idx (spec §1.3); domain rows of those
// connections are then loaded by connection id (m365_sync_state_connection_idx).

const FIX_HREF = '/integrations#m365';

export type M365SyncDomain = { domain: string; lastStatus: string | null; lastError: string | null };
export type M365SyncConnectionRow = {
  connectionId: string;
  orgId: string;
  partnerId: string;
  connectionStatus: string | null;
  connectionCreatedAt: Date | null;
  domains: M365SyncDomain[];
};

export function m365SyncObservation(row: M365SyncConnectionRow, now: Date): HealthObservation {
  const verdict = m365SyncHealth(row.connectionStatus, row.domains.map((d) => d.lastStatus));
  const failing = row.domains.filter((d) => d.lastStatus === 'needs_consent' || d.lastStatus === 'error');
  // The worst domain's error first: needs_consent outranks error.
  failing.sort((a, b) => Number(b.lastStatus === 'needs_consent') - Number(a.lastStatus === 'needs_consent'));
  const detail = failing.length
    ? `Failing: ${failing.map((d) => d.domain).join(', ')}${failing[0]!.lastError ? `. ${failing[0]!.lastError}` : ''}`
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

/** Distinct connections with a broken domain. Must imply m365_sync_state_unhealthy_idx's predicate. */
function brokenConnectionsQuery() {
  return db
    .selectDistinct({ connectionId: s.connectionId })
    .from(s)
    .where(sql`${s.lastStatus} IN (${sql.raw(`'needs_consent', 'error'`)})`);
}

/** Every domain row of the given connections, grouped per connection. A connection with no rows is absent. */
async function loadConnections(connectionIds: string[]): Promise<M365SyncConnectionRow[]> {
  if (connectionIds.length === 0) return [];
  const rows = await db
    .select({
      connectionId: s.connectionId,
      orgId: s.orgId,
      partnerId: organizations.partnerId,
      domain: s.domain,
      lastStatus: s.lastStatus,
      lastError: s.lastError,
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
    c.domains.push({ domain: r.domain, lastStatus: r.lastStatus, lastError: r.lastError });
  }
  return [...byConnection.values()];
}

export const m365SyncSource: HealthSource = {
  kind: 'm365_sync',
  intervalMinutes: 60,
  tables: ['m365_sync_state'],
  fixHrefs: [FIX_HREF],
  brokenQuery: () => brokenConnectionsQuery(),
  observe: (now, trackedSourceIds) => observeRows<M365SyncConnectionRow>({
    now,
    trackedSourceIds,
    loadBroken: async () => loadConnections((await brokenConnectionsQuery()).map((r) => r.connectionId)),
    loadTracked: loadConnections,
    sourceIdOf: (r) => r.connectionId,
    toObservation: m365SyncObservation,
  }),
};
