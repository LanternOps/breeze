import { inArray, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { tdSynnexSftpIntegrations as t } from '../../../db/schema';
import { staleAfterMinutes, tdSynnexSftpHealth } from '../../integrationStates';
import { PERMISSIONS } from '../../permissions';
import type { HealthObservation } from '../types';
import { defineRowSource, staleArm, toHealthObservation } from './observeRows';

// TD SYNNEX nightly price file (#9127). The cron enqueues one sync per enabled
// row each night (jobs/scheduleRegistry.ts 'tdsynnex-sftp-sync'). It is the only
// TD SYNNEX feed with a schedule; EC Express and Digital Bridge stay exempt.
// Partner axis (one row per partner): not index-backed (spec §1.3).
//
// Staleness: last_sync_at is stamped on success AND failure, and a finished
// failure is already `sync_failed`, so the arm reads "no attempt finished"
// (the Pax8 shape). Rows are created disabled and enabling one does not
// enqueue a sync, so the baseline also takes updated_at: every config save,
// toggle, connection test and sync write bumps it, and a row enabled today on
// an old created_at is not stale at once. updated_at is NOT NULL, so the
// created_at fallback in staleArm never applies here.

const FIX_HREF = '/integrations#tdsynnex-sftp';
const SYNC_INTERVAL_MINUTES = 1440;

export type TdSynnexSftpRow = {
  id: string;
  partnerId: string;
  enabled: boolean;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  createdAt: Date;
  /** Computed in SQL by staleArm. */
  stale: boolean;
};

const stale = (now: Date) => staleArm({
  lastOk: sql`GREATEST(${t.lastSyncAt}, ${t.updatedAt})`,
  createdAt: t.createdAt,
  now,
  minutes: staleAfterMinutes(SYNC_INTERVAL_MINUTES),
  withTimezone: false,
});

export function tdSynnexSftpObservation(row: TdSynnexSftpRow, now: Date): HealthObservation {
  const verdict = tdSynnexSftpHealth(row);
  return toHealthObservation({
    kind: 'td_synnex_sftp',
    verdict,
    now,
    createdAt: row.createdAt,
    sourceId: row.id,
    partnerId: row.partnerId,
    orgId: null,
    displayName: 'TD SYNNEX price file',
    // A stale sync has no current error; the last one may be old.
    rawDetail: verdict.state === 'broken' && verdict.condition === 'sync_stale' ? null : row.lastSyncError,
    fixHref: FIX_HREF,
    viewPermission: PERMISSIONS.CATALOG_READ,
    repairPermission: PERMISSIONS.CATALOG_WRITE,
  });
}

export const tdSynnexSftpSource = defineRowSource<TdSynnexSftpRow>({
  kind: 'td_synnex_sftp',
  intervalMinutes: 60,
  tables: ['td_synnex_sftp_integrations'],
  fixHrefs: [FIX_HREF],
  select: (where, now) => db
    .select({
      id: t.id,
      partnerId: t.partnerId,
      enabled: t.enabled,
      lastSyncStatus: t.lastSyncStatus,
      lastSyncError: t.lastSyncError,
      createdAt: t.createdAt,
      stale: sql<boolean>`${stale(now)}`,
    })
    .from(t)
    .where(where),
  brokenWhere: (now) => sql`${t.enabled} AND (${t.lastSyncStatus} = ${sql.raw(`'error'`)} OR ${stale(now)})`,
  trackedWhere: (ids) => inArray(t.id, ids),
  sourceIdOf: (r) => r.id,
  toObservation: tdSynnexSftpObservation,
});
