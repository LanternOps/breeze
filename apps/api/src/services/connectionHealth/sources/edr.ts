import { inArray, sql, type SQLWrapper } from 'drizzle-orm';
import { db } from '../../../db';
import { edrConnections as t } from '../../../db/schema';
import { edrProviderLabel } from '../../edrProviders/providerKeys';
import { edrHealth } from '../../integrationStates';
import { PERMISSIONS } from '../../permissions';
import { cleanDisplayName } from '../sanitize';
import type { HealthObservation } from '../types';
import { defineRowSource, staleArm, toHealthObservation } from './observeRows';

// EDR consoles: connection-level reauth plus two sync streams (inventory and
// detections), each of which clears only its own error when it starts
// (jobs/edrProviderSync.ts). Partner axis: not index-backed.
// Staleness (#9127): each stream's last_*_sync_at is stamped only by its
// success (or partial) write, so a stream is stale after three of its planned
// intervals (effective_*_interval_minutes, derived from the operator override
// and the vendor budget) with no success, and never under an hour. The planned
// interval is NULL only before the first inventory success, when the row is
// due at once, so the fallback below only bounds "never synced".

const FIX_HREF = '/integrations#edr';

/** Interval assumed while the scheduler has not planned one yet. */
const EDR_UNPLANNED_INTERVAL_MINUTES = 60;

/** staleAfterMinutes(interval) per row, in SQL. */
const streamStale = (lastOk: SQLWrapper, plannedInterval: SQLWrapper, now: Date) => staleArm({
  lastOk,
  createdAt: t.createdAt,
  now,
  minutes: sql`GREATEST(3 * COALESCE(${plannedInterval}, ${sql.raw(String(EDR_UNPLANNED_INTERVAL_MINUTES))}), 60)`,
  withTimezone: true,
});

const stale = (now: Date) => sql`(${t.status} = ${sql.raw(`'connected'`)} AND (${streamStale(t.lastInventorySyncAt, t.effectiveInventoryIntervalMinutes, now)} OR ${streamStale(t.lastDetectionSyncAt, t.effectiveDetectionIntervalMinutes, now)}))`;

export type EdrRow = {
  id: string;
  partnerId: string;
  name: string;
  provider: string;
  isActive: boolean;
  status: string;
  lastInventorySyncStatus: string | null;
  lastInventorySyncError: string | null;
  lastDetectionSyncStatus: string | null;
  lastDetectionSyncError: string | null;
  createdAt: Date;
  /** Computed in SQL (#9127): connected, and either stream past its stale threshold. */
  stale: boolean;
};

export function edrObservation(row: EdrRow, now: Date): HealthObservation {
  // Only an errored stream's text: a reauth-only or stale break must not show a stale stream error.
  const detail = row.lastInventorySyncStatus === 'error'
    ? row.lastInventorySyncError
    : row.lastDetectionSyncStatus === 'error' ? row.lastDetectionSyncError : null;
  return toHealthObservation({
    kind: 'edr',
    verdict: edrHealth(row),
    now,
    createdAt: row.createdAt,
    sourceId: row.id,
    partnerId: row.partnerId,
    orgId: null,
    displayName: cleanDisplayName(row.name, edrProviderLabel(row.provider)),
    rawDetail: detail,
    fixHref: FIX_HREF,
    viewPermission: PERMISSIONS.ORGS_READ,
    repairPermission: PERMISSIONS.ORGS_WRITE,
  });
}

export const edrSource = defineRowSource<EdrRow>({
  kind: 'edr',
  intervalMinutes: 15,
  tables: ['edr_connections'],
  fixHrefs: [FIX_HREF],
  select: (where, now) => db
    .select({
      id: t.id,
      partnerId: t.partnerId,
      name: t.name,
      provider: t.provider,
      isActive: t.isActive,
      status: t.status,
      lastInventorySyncStatus: t.lastInventorySyncStatus,
      lastInventorySyncError: t.lastInventorySyncError,
      lastDetectionSyncStatus: t.lastDetectionSyncStatus,
      lastDetectionSyncError: t.lastDetectionSyncError,
      createdAt: t.createdAt,
      stale: sql<boolean>`${stale(now)}`,
    })
    .from(t)
    .where(where),
  brokenWhere: (now) => sql`${t.isActive} AND (${t.status} IN (${sql.raw(`'reauth_required', 'error'`)}) OR ${t.lastInventorySyncStatus} = ${sql.raw(`'error'`)} OR ${t.lastDetectionSyncStatus} = ${sql.raw(`'error'`)} OR ${stale(now)})`,
  trackedWhere: (ids) => inArray(t.id, ids),
  sourceIdOf: (r) => r.id,
  toObservation: edrObservation,
});
