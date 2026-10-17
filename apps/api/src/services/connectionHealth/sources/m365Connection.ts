import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { m365Connections as t, organizations } from '../../../db/schema';
import { m365ConnectionHealth } from '../../integrationStates';
import { PERMISSIONS } from '../../permissions';
import { cleanDisplayName } from '../sanitize';
import type { HealthObservation } from '../types';
import { defineRowSource, toHealthObservation } from './observeRows';

// Org-axis M365 connections. User-axis rows (communications-delegated) have no
// writer today and are excluded by the org join. No periodic job writes this
// table: status moves on consent, retest and upgrade. last_error_code is a
// fixed code, carried as the condition; no free-text detail exists.
// Org-scoped table: backed by m365_connections_unhealthy_idx (spec §1.3).

const FIX_HREF = '/integrations#m365';

const PROFILE_LABELS: Record<string, string> = {
  'legacy-direct': 'Microsoft 365',
  'customer-graph-read': 'Microsoft 365 Graph read',
  'customer-graph-actions': 'Microsoft 365 Graph actions',
  'customer-exchange-powershell': 'Microsoft 365 Exchange',
};

export type M365ConnectionRow = {
  id: string;
  orgId: string;
  partnerId: string;
  profile: string;
  displayName: string | null;
  status: string;
  lastErrorCode: string | null;
  createdAt: Date;
};

export function m365ConnectionObservation(row: M365ConnectionRow, now: Date): HealthObservation {
  const label = PROFILE_LABELS[row.profile] ?? 'Microsoft 365';
  return toHealthObservation({
    kind: 'm365_connection',
    verdict: m365ConnectionHealth(row),
    now,
    createdAt: row.createdAt,
    sourceId: row.id,
    partnerId: row.partnerId,
    orgId: row.orgId,
    displayName: cleanDisplayName(row.displayName ? `${label} (${row.displayName})` : label, label),
    rawDetail: null,
    fixHref: FIX_HREF,
    viewPermission: PERMISSIONS.ORGS_READ,
    repairPermission: PERMISSIONS.ORGS_WRITE,
  });
}

export const m365ConnectionSource = defineRowSource<M365ConnectionRow>({
  kind: 'm365_connection',
  intervalMinutes: 15,
  tables: ['m365_connections'],
  fixHrefs: [FIX_HREF],
  select: (where) => db
    .select({
      id: t.id,
      // Non-null: the inner join on org_id drops user-axis rows.
      orgId: sql<string>`${t.orgId}`,
      partnerId: organizations.partnerId,
      profile: t.profile,
      displayName: t.displayName,
      status: t.status,
      lastErrorCode: t.lastErrorCode,
      createdAt: t.createdAt,
    })
    .from(t)
    .innerJoin(organizations, eq(organizations.id, t.orgId))
    .where(where),
  // Must imply m365_connections_unhealthy_idx's predicate.
  brokenWhere: sql`${t.orgId} IS NOT NULL AND ${t.status} IN (${sql.raw(`'degraded', 'suspended'`)})`,
  trackedWhere: (ids) => inArray(t.id, ids),
  sourceIdOf: (r) => r.id,
  toObservation: m365ConnectionObservation,
});
