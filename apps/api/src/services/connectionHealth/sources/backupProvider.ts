import { inArray, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { backupProviderConnections as t } from '../../../db/schema';
import { backupProviderHealth } from '../../integrationStates';
import { PERMISSIONS } from '../../permissions';
import { cleanDisplayName } from '../sanitize';
import type { HealthObservation } from '../types';
import { defineRowSource, staleArm, toHealthObservation } from './observeRows';

// Backup provider connections (5-minute scheduler tick, 30-minute default
// interval). Spec §3 backup trap: a retry sets 'running' and clears the error,
// so the verdict treats running as unknown. Partner axis: not index-backed.
// W4 staleness: last_sync_at is stamped only on success; the threshold is
// max(3 × the row's own sync_interval_minutes, 60). `reauth_required` rows are
// never scheduled, and are already a permanent break.

const FIX_HREF = '/integrations#backup';

export type BackupProviderRow = {
  id: string;
  partnerId: string;
  name: string;
  provider: string;
  isActive: boolean;
  status: string;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  createdAt: Date;
  /** Computed in SQL by staleArm (W4). */
  stale: boolean;
};

// staleAfterMinutes(), per row, in SQL.
const stale = (now: Date) => staleArm({
  lastOk: t.lastSyncAt,
  createdAt: t.createdAt,
  now,
  minutes: sql`GREATEST(3 * ${t.syncIntervalMinutes}, 60)`,
  withTimezone: true,
});

export function backupProviderObservation(row: BackupProviderRow, now: Date): HealthObservation {
  const verdict = backupProviderHealth(row);
  return toHealthObservation({
    kind: 'backup_provider',
    verdict,
    now,
    createdAt: row.createdAt,
    sourceId: row.id,
    partnerId: row.partnerId,
    orgId: null,
    displayName: cleanDisplayName(row.name, 'Backup provider'),
    // A stale sync has no current error; the last one may be old.
    rawDetail: verdict.state === 'broken' && verdict.condition === 'sync_stale' ? null : row.lastSyncError,
    fixHref: FIX_HREF,
    viewPermission: PERMISSIONS.BACKUP_READ,
    repairPermission: PERMISSIONS.BACKUP_WRITE,
  });
}

export const backupProviderSource = defineRowSource<BackupProviderRow>({
  kind: 'backup_provider',
  intervalMinutes: 15,
  tables: ['backup_provider_connections'],
  fixHrefs: [FIX_HREF],
  select: (where, now) => db
    .select({
      id: t.id,
      partnerId: t.partnerId,
      name: t.name,
      provider: t.provider,
      isActive: t.isActive,
      status: t.status,
      lastSyncStatus: t.lastSyncStatus,
      lastSyncError: t.lastSyncError,
      createdAt: t.createdAt,
      stale: sql<boolean>`${stale(now)}`,
    })
    .from(t)
    .where(where),
  brokenWhere: (now) => sql`${t.isActive} AND (${t.status} IN (${sql.raw(`'reauth_required', 'error'`)}) OR ${t.lastSyncStatus} = ${sql.raw(`'error'`)} OR ${stale(now)})`,
  trackedWhere: (ids) => inArray(t.id, ids),
  sourceIdOf: (r) => r.id,
  toObservation: backupProviderObservation,
});
