import { inArray, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { backupProviderConnections as t } from '../../../db/schema';
import { backupProviderHealth } from '../../integrationStates';
import { PERMISSIONS } from '../../permissions';
import { cleanDisplayName } from '../sanitize';
import type { HealthObservation } from '../types';
import { defineRowSource, toHealthObservation } from './observeRows';

// Backup provider connections (5-minute scheduler tick, 30-minute default
// interval). Spec §3 backup trap: a retry sets 'running' and clears the error,
// so the verdict treats running as unknown. Partner axis: not index-backed.

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
};

export function backupProviderObservation(row: BackupProviderRow, now: Date): HealthObservation {
  return toHealthObservation({
    kind: 'backup_provider',
    verdict: backupProviderHealth(row),
    now,
    createdAt: row.createdAt,
    sourceId: row.id,
    partnerId: row.partnerId,
    orgId: null,
    displayName: cleanDisplayName(row.name, 'Backup provider'),
    rawDetail: row.lastSyncError,
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
  select: (where) => db
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
    })
    .from(t)
    .where(where),
  brokenWhere: sql`${t.isActive} AND (${t.status} IN (${sql.raw(`'reauth_required', 'error'`)}) OR ${t.lastSyncStatus} = ${sql.raw(`'error'`)})`,
  trackedWhere: (ids) => inArray(t.id, ids),
  sourceIdOf: (r) => r.id,
  toObservation: backupProviderObservation,
});
