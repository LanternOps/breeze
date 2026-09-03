// apps/api/src/services/portal/backupReadModel.ts
import { and, countDistinct, desc, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  backupConfigs,
  backupJobs,
  backupVerifications,
  devices,
} from '../../db/schema';

export async function backupTile(orgId: string, now: Date) {
  const [totalRows, configuredRows, latestRows] = await Promise.all([
    db
      .select({ total: countDistinct(devices.id) })
      .from(devices)
      .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false))),
    db
      .select({ configured: countDistinct(backupJobs.deviceId) })
      .from(backupJobs)
      .innerJoin(
        backupConfigs,
        and(
          eq(backupJobs.configId, backupConfigs.id),
          eq(backupConfigs.orgId, orgId),
          eq(backupConfigs.isActive, true),
        ),
      )
      .where(eq(backupJobs.orgId, orgId)),
    db
      .select({
        completedAt: backupVerifications.completedAt,
        verificationType: backupVerifications.verificationType,
      })
      .from(backupVerifications)
      .where(and(
        eq(backupVerifications.orgId, orgId),
        eq(backupVerifications.status, 'passed'),
      ))
      .orderBy(desc(backupVerifications.completedAt))
      .limit(1),
  ]);

  const total = Number(totalRows[0]?.total ?? 0);
  const configured = Number(configuredRows[0]?.configured ?? 0);
  const latest = latestRows[0];

  return {
    status:
      configured === 0
        ? 'not_configured' as const
        : latest
          ? 'ok' as const
          : 'no_data' as const,
    completedAt: latest?.completedAt?.toISOString() ?? null,
    verificationType: latest?.verificationType ?? null,
    configured,
    total,
    asOf: now.toISOString(),
  };
}

// W06 — backup overview + per-device backup evidence
import {
  backupSlaEvents,
  recoveryReadiness,
  RESTORABLE_BACKUP_JOB_STATUSES,
} from '../../db/schema';
import { asc, isNull, sql } from 'drizzle-orm';
import type {
  BackupDeviceRow,
  BackupDevicesDto,
  BackupOverviewDto,
} from '@breeze/shared';

export async function backupOverview(
  orgId: string,
  args: { timezone: string; now: Date },
): Promise<BackupOverviewDto> {
  const [tile, restoreRows, breachRows, readinessRows] = await Promise.all([
    backupTile(orgId, args.now),
    db
      .select({ completedAt: backupVerifications.completedAt })
      .from(backupVerifications)
      .where(and(
        eq(backupVerifications.orgId, orgId),
        eq(backupVerifications.verificationType, 'test_restore'),
        eq(backupVerifications.status, 'passed'),
      ))
      .orderBy(sql`${backupVerifications.completedAt} desc nulls last`)
      .limit(1),
    db
      .select({ eventType: backupSlaEvents.eventType })
      .from(backupSlaEvents)
      .where(and(
        eq(backupSlaEvents.orgId, orgId),
        isNull(backupSlaEvents.resolvedAt),
      )),
    db
      .select({
        readinessCount: sql<number>`count(*)::int`,
        meanReadinessScore: sql<number | null>`avg(${recoveryReadiness.readinessScore})::float`,
      })
      .from(recoveryReadiness)
      .where(eq(recoveryReadiness.orgId, orgId)),
  ]);

  // Mirrors apps/api/src/jobs/backupSlaWorker.ts: 'missed_backup' is an RPO-family event.
  const RPO_EVENT_TYPES = new Set(['rpo_breach', 'missed_backup']);
  const RTO_EVENT_TYPES = new Set(['rto_breach']);
  const countBreach = (family: 'rpo' | 'rto') =>
    breachRows.filter((row) =>
      (family === 'rpo' ? RPO_EVENT_TYPES : RTO_EVENT_TYPES).has(row.eventType),
    ).length;

  return {
    asOf: args.now.toISOString(),
    dataStatus: tile.status,
    protected: tile.configured,
    unprotected:
      tile.total == null || tile.configured == null
        ? null
        : tile.total - tile.configured,
    total: tile.total,
    lastPassedVerification:
      tile.completedAt && tile.verificationType
        ? { completedAt: tile.completedAt, verificationType: tile.verificationType }
        : null,
    lastTestRestoreAt: restoreRows[0]?.completedAt?.toISOString() ?? null,
    openRpoBreaches: tile.status === 'ok' ? countBreach('rpo') : null,
    openRtoBreaches: tile.status === 'ok' ? countBreach('rto') : null,
    meanReadinessScore:
      Number(readinessRows[0]?.readinessCount ?? 0) > 0 &&
      readinessRows[0]?.meanReadinessScore != null
        ? Number(readinessRows[0]?.meanReadinessScore)
        : null,
  };
}

export async function backupDevicesPage(
  orgId: string,
  args: { page: number; limit: number; timezone: string; now: Date },
): Promise<BackupDevicesDto> {
  const offset = (args.page - 1) * args.limit;
  const restorableStatuses = sql.join(
    RESTORABLE_BACKUP_JOB_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  const [countRows, rows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(devices)
      .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false))),
    db
      .select({
        id: devices.id,
        hostname: devices.hostname,
        displayName: devices.displayName,
        configured: sql<boolean>`
          exists (
            select 1
            from backup_jobs bj
            join backup_configs bc
              on bc.id = bj.config_id
             and bc.org_id = ${orgId}
             and bc.is_active = true
            where bj.org_id = ${orgId}
              and bj.device_id = ${devices.id}
          )
        `,
        lastBackupAt: sql<Date | null>`(
          select max(bj.completed_at)
          from backup_jobs bj
          where bj.org_id = ${orgId}
            and bj.device_id = ${devices.id}
            and bj.status in (${restorableStatuses})
        )`,
        lastBackupStatus: sql<string | null>`(
          select bj.status
          from backup_jobs bj
          where bj.org_id = ${orgId}
            and bj.device_id = ${devices.id}
            and bj.status in (${restorableStatuses})
          order by bj.completed_at desc nulls last
          limit 1
        )`,
        testRestoreStatus: sql<string | null>`(
          select bv.status
          from backup_verifications bv
          where bv.org_id = ${orgId}
            and bv.device_id = ${devices.id}
            and bv.verification_type = 'test_restore'
          order by bv.completed_at desc nulls last
          limit 1
        )`,
        testRestoreAt: sql<Date | null>`(
          select max(bv.completed_at)
          from backup_verifications bv
          where bv.org_id = ${orgId}
            and bv.device_id = ${devices.id}
            and bv.verification_type = 'test_restore'
        )`,
        restoreTimeSeconds: sql<number | null>`(
          select bv.restore_time_seconds
          from backup_verifications bv
          where bv.org_id = ${orgId}
            and bv.device_id = ${devices.id}
            and bv.verification_type = 'test_restore'
          order by bv.completed_at desc nulls last
          limit 1
        )`,
        openBreaches: sql<string[]>`
          coalesce((
            select array_agg(distinct bse.event_type)
            from backup_sla_events bse
            where bse.org_id = ${orgId}
              and bse.device_id = ${devices.id}
              and bse.resolved_at is null
          ), array[]::text[])
        `,
        readinessScore: recoveryReadiness.readinessScore,
        estimatedRtoMinutes: recoveryReadiness.estimatedRtoMinutes,
        estimatedRpoMinutes: recoveryReadiness.estimatedRpoMinutes,
      })
      .from(devices)
      .leftJoin(
        recoveryReadiness,
        and(
          eq(recoveryReadiness.deviceId, devices.id),
          eq(recoveryReadiness.orgId, orgId),
        ),
      )
      .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false)))
      .orderBy(asc(devices.hostname), asc(devices.id))
      .limit(args.limit)
      .offset(offset),
  ]);

  const data: BackupDeviceRow[] = rows.map((row) => ({
    id: row.id,
    name: row.displayName ?? row.hostname,
    configured: row.configured,
    lastRestorePointAt: row.lastBackupAt?.toISOString() ?? null,
    lastRestorePointDegraded: row.lastBackupStatus === 'partial',
    lastTestRestore: row.testRestoreStatus
      ? {
          status: row.testRestoreStatus,
          completedAt: row.testRestoreAt?.toISOString() ?? null,
          restoreTimeSeconds: row.restoreTimeSeconds,
        }
      : null,
    openBreaches: row.openBreaches,
    readinessScore: row.readinessScore,
    estimatedRtoMinutes: row.estimatedRtoMinutes,
    estimatedRpoMinutes: row.estimatedRpoMinutes,
  }));
  const total = Number(countRows[0]?.count ?? 0);

  return {
    dataStatus: total === 0 ? 'no_data' : 'ok',
    asOf: args.now.toISOString(),
    data,
    pagination: {
      page: args.page,
      limit: args.limit,
      total,
    },
  };
}
