import { inArray, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { edrConnections as t } from '../../../db/schema';
import { edrProviderLabel } from '../../edrProviders/providerKeys';
import { edrHealth } from '../../integrationStates';
import { PERMISSIONS } from '../../permissions';
import { cleanDisplayName } from '../sanitize';
import type { HealthObservation } from '../types';
import { defineRowSource, toHealthObservation } from './observeRows';

// EDR consoles: connection-level reauth plus two sync streams (inventory and
// detections), each of which clears only its own error when it starts
// (jobs/edrProviderSync.ts). Partner axis: not index-backed.

const FIX_HREF = '/integrations#edr';

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
};

export function edrObservation(row: EdrRow, now: Date): HealthObservation {
  const detail = row.lastInventorySyncStatus === 'error' ? row.lastInventorySyncError : row.lastDetectionSyncError;
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
  select: (where) => db
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
    })
    .from(t)
    .where(where),
  brokenWhere: sql`${t.isActive} AND (${t.status} IN (${sql.raw(`'reauth_required', 'error'`)}) OR ${t.lastInventorySyncStatus} = ${sql.raw(`'error'`)} OR ${t.lastDetectionSyncStatus} = ${sql.raw(`'error'`)})`,
  trackedWhere: (ids) => inArray(t.id, ids),
  sourceIdOf: (r) => r.id,
  toObservation: edrObservation,
});
