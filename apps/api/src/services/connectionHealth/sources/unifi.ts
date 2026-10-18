import { inArray, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { unifiIntegrations as t } from '../../../db/schema';
import { staleAfterMinutes, unifiHealth } from '../../integrationStates';
import { PERMISSIONS } from '../../permissions';
import type { HealthObservation } from '../types';
import { defineRowSource, staleArm, toHealthObservation } from './observeRows';

// UniFi syncs every 30 minutes (jobs/unifiWorker.ts). `status` carries
// reauth/error, last_sync_status 'failed'. Disconnect deletes the row.
// Partner axis: not index-backed (spec §1.3).
// W4 staleness: markSynced stamps last_sync_at on every completed attempt and
// a completed failure is already `sync_failed`, so the stale arm reads "no
// attempt finished in 90 minutes" (a dead scheduler or a hung run).

const FIX_HREF = '/integrations#unifi';

export type UnifiRow = {
  id: string;
  partnerId: string;
  isActive: boolean;
  status: string;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  createdAt: Date;
  /** Computed in SQL by staleArm (W4). */
  stale: boolean;
};

const SYNC_INTERVAL_MINUTES = 30;
const stale = (now: Date) => staleArm({
  lastOk: t.lastSyncAt,
  createdAt: t.createdAt,
  now,
  minutes: staleAfterMinutes(SYNC_INTERVAL_MINUTES),
  withTimezone: false,
});

export function unifiObservation(row: UnifiRow, now: Date): HealthObservation {
  const verdict = unifiHealth(row);
  return toHealthObservation({
    kind: 'unifi',
    verdict,
    now,
    createdAt: row.createdAt,
    sourceId: row.id,
    partnerId: row.partnerId,
    orgId: null,
    displayName: 'UniFi',
    // A stale sync has no current error; the last one may be old.
    rawDetail: verdict.state === 'broken' && verdict.condition === 'sync_stale' ? null : row.lastSyncError,
    fixHref: FIX_HREF,
    viewPermission: PERMISSIONS.ORGS_READ,
    repairPermission: PERMISSIONS.ORGS_WRITE,
  });
}

export const unifiSource = defineRowSource<UnifiRow>({
  kind: 'unifi',
  intervalMinutes: 30,
  tables: ['unifi_integrations'],
  fixHrefs: [FIX_HREF],
  select: (where, now) => db
    .select({
      id: t.id,
      partnerId: t.partnerId,
      isActive: t.isActive,
      status: t.status,
      lastSyncStatus: t.lastSyncStatus,
      lastSyncError: t.lastSyncError,
      createdAt: t.createdAt,
      stale: sql<boolean>`${stale(now)}`,
    })
    .from(t)
    .where(where),
  brokenWhere: (now) => sql`${t.isActive} AND (${t.status} IN (${sql.raw(`'reauth_required', 'error'`)}) OR ${t.lastSyncStatus} = ${sql.raw(`'failed'`)} OR (${t.status} = ${sql.raw(`'connected'`)} AND ${stale(now)}))`,
  trackedWhere: (ids) => inArray(t.id, ids),
  sourceIdOf: (r) => r.id,
  toObservation: unifiObservation,
});
