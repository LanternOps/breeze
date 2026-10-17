import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { dnsFilterIntegrations as t, organizations } from '../../../db/schema';
import { dnsFilterHealth } from '../../integrationStates';
import { PERMISSIONS } from '../../permissions';
import { cleanDisplayName } from '../sanitize';
import type { HealthObservation } from '../types';
import { defineRowSource, toHealthObservation } from './observeRows';

// DNS filtering integrations are org-owned (org_id NOT NULL, no partner_id),
// so the table grows with orgs: the broken predicate is backed by
// dns_filter_integrations_sync_error_idx (spec §1.3). last_sync_error is
// already redacted by the sync job; it still goes through the sanitizer.

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
};

export function dnsFilterObservation(row: DnsFilterRow, now: Date): HealthObservation {
  return toHealthObservation({
    kind: 'dns_filter',
    verdict: dnsFilterHealth(row),
    now,
    createdAt: row.createdAt,
    sourceId: row.id,
    partnerId: row.partnerId,
    orgId: row.orgId,
    displayName: cleanDisplayName(row.name, 'DNS filtering'),
    rawDetail: row.lastSyncError,
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
  select: (where) => db
    .select({
      id: t.id,
      orgId: t.orgId,
      partnerId: organizations.partnerId,
      name: t.name,
      isActive: t.isActive,
      lastSyncStatus: t.lastSyncStatus,
      lastSyncError: t.lastSyncError,
      createdAt: t.createdAt,
    })
    .from(t)
    .innerJoin(organizations, eq(organizations.id, t.orgId))
    .where(where),
  // Must imply dns_filter_integrations_sync_error_idx's predicate.
  brokenWhere: sql`${t.isActive} AND ${t.lastSyncStatus} = ${sql.raw(`'error'`)}`,
  trackedWhere: (ids) => inArray(t.id, ids),
  sourceIdOf: (r) => r.id,
  toObservation: dnsFilterObservation,
});
