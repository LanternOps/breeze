import { and, countDistinct, desc, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  backupConfigs,
  backupJobs,
  backupVerifications,
  devices,
} from '../../db/schema';

export async function backupTile(orgId: string, now: Date) {
  const [totalRows, activeConfigRows, configuredRows, latestRows] = await Promise.all([
    db
      .select({ total: countDistinct(devices.id) })
      .from(devices)
      .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false))),
    db
      .select({ id: backupConfigs.id })
      .from(backupConfigs)
      .where(and(
        eq(backupConfigs.orgId, orgId),
        eq(backupConfigs.isActive, true),
      ))
      .limit(1),
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
  const hasActiveConfig = activeConfigRows.length > 0;
  const configured = Number(configuredRows[0]?.configured ?? 0);
  const latest = latestRows[0];

  return {
    status:
      !hasActiveConfig
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
