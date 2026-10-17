import { inArray, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { unifiIntegrations as t } from '../../../db/schema';
import { unifiHealth } from '../../integrationStates';
import { PERMISSIONS } from '../../permissions';
import type { HealthObservation } from '../types';
import { defineRowSource, toHealthObservation } from './observeRows';

// UniFi syncs every 30 minutes (jobs/unifiWorker.ts). `status` carries
// reauth/error, last_sync_status 'failed'. Disconnect deletes the row.
// Partner axis: not index-backed (spec §1.3).

const FIX_HREF = '/integrations#unifi';

export type UnifiRow = {
  id: string;
  partnerId: string;
  isActive: boolean;
  status: string;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  createdAt: Date;
};

export function unifiObservation(row: UnifiRow, now: Date): HealthObservation {
  return toHealthObservation({
    kind: 'unifi',
    verdict: unifiHealth(row),
    now,
    createdAt: row.createdAt,
    sourceId: row.id,
    partnerId: row.partnerId,
    orgId: null,
    displayName: 'UniFi',
    rawDetail: row.lastSyncError,
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
  select: (where) => db
    .select({
      id: t.id,
      partnerId: t.partnerId,
      isActive: t.isActive,
      status: t.status,
      lastSyncStatus: t.lastSyncStatus,
      lastSyncError: t.lastSyncError,
      createdAt: t.createdAt,
    })
    .from(t)
    .where(where),
  brokenWhere: sql`${t.isActive} AND (${t.status} IN (${sql.raw(`'reauth_required', 'error'`)}) OR ${t.lastSyncStatus} = ${sql.raw(`'failed'`)})`,
  trackedWhere: (ids) => inArray(t.id, ids),
  sourceIdOf: (r) => r.id,
  toObservation: unifiObservation,
});
