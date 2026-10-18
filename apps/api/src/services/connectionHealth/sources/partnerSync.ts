import { inArray, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { huntressIntegrations, pax8Integrations, s1Integrations } from '../../../db/schema';
import { staleAfterMinutes, type HealthVerdict } from '../../integrationStates';
import { PERMISSIONS } from '../../permissions';
import type { ConnectionSourceKind, HealthObservation, HealthSource } from '../types';
import { defineRowSource, staleArm, toHealthObservation } from './observeRows';

// Huntress, SentinelOne and Pax8 share one table shape: a partner-owned row
// with is_active + last_sync_status/error. Partner axis (rows grow with
// partners), so the broken predicate is not index-backed (spec §1.3).
//
// W4 staleness: `last_sync_at` older than staleAfterMinutes(sync interval),
// or never set on a row older than that. Huntress and SentinelOne stamp it
// only on success; Pax8 stamps it on every completed attempt, and a completed
// failure is already `sync_failed`, so for Pax8 the arm reads "no attempt
// finished" (a dead nightly job or a stuck `running`).

export type PartnerSyncRow = {
  id: string;
  partnerId: string;
  isActive: boolean;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  createdAt: Date;
  /** Computed in SQL by staleArm (W4). */
  stale: boolean;
};

type PartnerSyncTable = typeof huntressIntegrations | typeof s1Integrations | typeof pax8Integrations;

export function partnerSyncObservation(
  def: { kind: ConnectionSourceKind; displayName: string; fixHref: string; verdict: (r: PartnerSyncRow) => HealthVerdict },
  row: PartnerSyncRow,
  now: Date,
): HealthObservation {
  const verdict = def.verdict(row);
  return toHealthObservation({
    kind: def.kind,
    verdict,
    now,
    createdAt: row.createdAt,
    sourceId: row.id,
    partnerId: row.partnerId,
    orgId: null,
    displayName: def.displayName,
    // A stale sync has no current error; the last one may be weeks old.
    rawDetail: isStale(verdict) ? null : row.lastSyncError,
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
  /** How often the sync itself runs; drives the stale threshold (W4). */
  syncIntervalMinutes: number;
  /** last_sync_at / created_at are timestamptz (Pax8) rather than timestamp. */
  withTimezone: boolean;
  displayName: string;
  fixHref: string;
  verdict: (r: PartnerSyncRow) => HealthVerdict;
}): { source: HealthSource; toObservation: (row: PartnerSyncRow, now: Date) => HealthObservation } {
  const t = def.table;
  const toObservation = (row: PartnerSyncRow, now: Date) => partnerSyncObservation(def, row, now);
  const stale = (now: Date) => staleArm({
    lastOk: t.lastSyncAt,
    createdAt: t.createdAt,
    now,
    minutes: staleAfterMinutes(def.syncIntervalMinutes),
    withTimezone: def.withTimezone,
  });
  const source = defineRowSource<PartnerSyncRow>({
    kind: def.kind,
    intervalMinutes: def.intervalMinutes,
    tables: [def.tableName],
    fixHrefs: [def.fixHref],
    select: (where, now) => db
      .select({
        id: t.id,
        partnerId: t.partnerId,
        isActive: t.isActive,
        lastSyncStatus: t.lastSyncStatus,
        lastSyncError: t.lastSyncError,
        createdAt: t.createdAt,
        stale: sql<boolean>`${stale(now)}`,
      })
      .from(t)
      .where(where),
    brokenWhere: (now) => sql`${t.isActive} AND (${t.lastSyncStatus} = ${sql.raw(`'${def.failedValue}'`)} OR ${stale(now)})`,
    trackedWhere: (ids) => inArray(t.id, ids),
    sourceIdOf: (r) => r.id,
    toObservation,
  });
  return { source, toObservation };
}

const isStale = (v: HealthVerdict) => v.state === 'broken' && v.condition === 'sync_stale';
