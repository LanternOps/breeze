import { inArray, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { huntressIntegrations, pax8Integrations, s1Integrations } from '../../../db/schema';
import type { HealthVerdict } from '../../integrationStates';
import { PERMISSIONS } from '../../permissions';
import type { ConnectionSourceKind, HealthObservation, HealthSource } from '../types';
import { defineRowSource, toHealthObservation } from './observeRows';

// Huntress, SentinelOne and Pax8 share one table shape: a partner-owned row
// with is_active + last_sync_status/error. Partner axis (rows grow with
// partners), so the broken predicate is not index-backed (spec §1.3).

export type PartnerSyncRow = {
  id: string;
  partnerId: string;
  isActive: boolean;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  createdAt: Date;
};

type PartnerSyncTable = typeof huntressIntegrations | typeof s1Integrations | typeof pax8Integrations;

export function partnerSyncObservation(
  def: { kind: ConnectionSourceKind; displayName: string; fixHref: string; verdict: (r: PartnerSyncRow) => HealthVerdict },
  row: PartnerSyncRow,
  now: Date,
): HealthObservation {
  return toHealthObservation({
    kind: def.kind,
    verdict: def.verdict(row),
    now,
    createdAt: row.createdAt,
    sourceId: row.id,
    partnerId: row.partnerId,
    orgId: null,
    displayName: def.displayName,
    rawDetail: row.lastSyncError,
    fixHref: def.fixHref,
    viewPermission: PERMISSIONS.ORGS_READ,
    repairPermission: PERMISSIONS.ORGS_WRITE,
  });
}

export function partnerSyncSource(def: {
  kind: ConnectionSourceKind;
  table: PartnerSyncTable;
  tableName: string;
  intervalMinutes: number;
  /** The value the sync worker writes on failure ('error', or 'failed' for Pax8). */
  failedValue: 'error' | 'failed';
  displayName: string;
  fixHref: string;
  verdict: (r: PartnerSyncRow) => HealthVerdict;
}): { source: HealthSource; toObservation: (row: PartnerSyncRow, now: Date) => HealthObservation } {
  const t = def.table;
  const toObservation = (row: PartnerSyncRow, now: Date) => partnerSyncObservation(def, row, now);
  const source = defineRowSource<PartnerSyncRow>({
    kind: def.kind,
    intervalMinutes: def.intervalMinutes,
    tables: [def.tableName],
    fixHrefs: [def.fixHref],
    select: (where) => db
      .select({
        id: t.id,
        partnerId: t.partnerId,
        isActive: t.isActive,
        lastSyncStatus: t.lastSyncStatus,
        lastSyncError: t.lastSyncError,
        createdAt: t.createdAt,
      })
      .from(t)
      .where(where),
    brokenWhere: sql`${t.isActive} AND ${t.lastSyncStatus} = ${sql.raw(`'${def.failedValue}'`)}`,
    trackedWhere: (ids) => inArray(t.id, ids),
    sourceIdOf: (r) => r.id,
    toObservation,
  });
  return { source, toObservation };
}
