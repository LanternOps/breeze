import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { DNS_STALE_FLOOR_MINUTES, dnsFilterIntegrations as t, dnsFilterStaleAt, organizations } from '../../../db/schema';
import { dnsFilterHealth } from '../../integrationStates';
import { PERMISSIONS } from '../../permissions';
import { cleanDisplayName } from '../sanitize';
import type { HealthObservation } from '../types';
import { defineRowSource, staleAtBefore, staleCutoff, toHealthObservation } from './observeRows';

// DNS filtering integrations are org-owned (org_id NOT NULL, no partner_id),
// so the table grows with orgs: the broken predicate is backed by
// dns_filter_integrations_sync_error_idx (spec §1.3). last_sync_error is
// already redacted by the sync job; it still goes through the sanitizer.
// #10021 staleness: last_sync advances only with a successful slice, so the
// stale arm reads "no success for 3 x the row's own sync interval (min 60 min)".
// Under RLS only leakproof quals reach an index, so each stale arm pre-filters
// on a plain column (last_sync, or created_at while never synced; served by
// dns_filter_integrations_stale_idx / _never_synced_idx) and rechecks the exact
// interval-based test on what is left. Three OR-ed arms of ANDs, so the
// planner can BitmapOr one index per arm.

const FIX_HREF = '/dns-security';

export type DnsFilterRow = {
  id: string;
  orgId: string;
  partnerId: string;
  name: string;
  isActive: boolean;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  createdAt: Date;
  /** Computed in SQL by staleAtBefore(dnsFilterStaleAt) (#10021). */
  stale: boolean;
};

const stale = (now: Date) => staleAtBefore(dnsFilterStaleAt(t), now);

export function dnsFilterObservation(row: DnsFilterRow, now: Date): HealthObservation {
  const verdict = dnsFilterHealth(row);
  return toHealthObservation({
    kind: 'dns_filter',
    verdict,
    now,
    createdAt: row.createdAt,
    sourceId: row.id,
    partnerId: row.partnerId,
    orgId: row.orgId,
    displayName: cleanDisplayName(row.name, 'DNS filtering'),
    // A stale sync has no current error; the last one may be old.
    rawDetail: verdict.state === 'broken' && verdict.condition === 'sync_stale' ? null : row.lastSyncError,
    fixHref: FIX_HREF,
    viewPermission: PERMISSIONS.ORGS_READ,
    repairPermission: PERMISSIONS.ORGS_WRITE,
  });
}

export const dnsFilterSource = defineRowSource<DnsFilterRow>({
  kind: 'dns_filter',
  intervalMinutes: 15,
  tables: ['dns_filter_integrations'],
  fixHrefs: [FIX_HREF],
  select: (where, now) => db
    .select({
      id: t.id,
      orgId: t.orgId,
      partnerId: organizations.partnerId,
      name: t.name,
      isActive: t.isActive,
      lastSyncStatus: t.lastSyncStatus,
      lastSyncError: t.lastSyncError,
      createdAt: t.createdAt,
      stale: sql<boolean>`${stale(now)}`,
    })
    .from(t)
    .innerJoin(organizations, eq(organizations.id, t.orgId))
    .where(where),
  // Each arm must imply its partial index's predicate.
  brokenWhere: (now) => {
    const cutoff = staleCutoff(now, DNS_STALE_FLOOR_MINUTES);
    return sql`(${t.isActive} AND ${t.lastSyncStatus} = ${sql.raw(`'error'`)})
      OR (${t.isActive} AND ${t.lastSync} < ${cutoff}::timestamp AND ${stale(now)})
      OR (${t.isActive} AND ${t.lastSync} IS NULL AND ${t.createdAt} < ${cutoff}::timestamp AND ${stale(now)})`;
  },
  trackedWhere: (ids) => inArray(t.id, ids),
  sourceIdOf: (r) => r.id,
  toObservation: dnsFilterObservation,
});
