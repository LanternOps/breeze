import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, and, sql, gte, desc } from 'drizzle-orm';
import { db } from '../../db';
import {
  backupConfigs,
  backupJobs,
  backupSnapshots,
  devices,
} from '../../db/schema';
import { resolveBackupConfigForDevice, resolveAllBackupAssignedDevices } from '../../services/featureConfigResolver';
import { getNextRun, resolveScopedOrgId } from './helpers';
import { usageHistoryQuerySchema } from './schemas';

export const dashboardRoutes = new Hono();

dashboardRoutes.get(
  '/usage-history',
  zValidator('query', usageHistoryQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { days = 14 } = c.req.valid('query');
    const today = new Date();
    const startDate = new Date(today);
    startDate.setUTCHours(0, 0, 0, 0);
    startDate.setUTCDate(startDate.getUTCDate() - (days - 1));

    // Get snapshots with their config's provider
    const snapshots = await db
      .select({
        size: backupSnapshots.size,
        timestamp: backupSnapshots.timestamp,
        provider: backupConfigs.provider,
      })
      .from(backupSnapshots)
      .leftJoin(backupConfigs, eq(backupSnapshots.configId, backupConfigs.id))
      .where(
        and(
          eq(backupSnapshots.orgId, orgId),
          gte(backupSnapshots.timestamp, startDate)
        )
      );

    const providers = new Set<string>();
    const dailyIncrements = new Map<string, Map<string, number>>();

    for (const snap of snapshots) {
      const provider = snap.provider ?? 'unknown';
      providers.add(provider);
      const dayKey = snap.timestamp.toISOString().slice(0, 10);
      const dayMap = dailyIncrements.get(dayKey) ?? new Map<string, number>();
      dayMap.set(provider, (dayMap.get(provider) ?? 0) + (snap.size ?? 0));
      dailyIncrements.set(dayKey, dayMap);
    }

    const providerList = Array.from(providers);
    if (providerList.length === 0) providerList.push('local');
    const runningByProvider = new Map(
      providerList.map((p) => [p, 0])
    );
    const points: Array<{
      timestamp: string;
      totalBytes: number;
      providers: Array<{ provider: string; bytes: number }>;
    }> = [];

    for (let offset = 0; offset < days; offset++) {
      const dayDate = new Date(startDate);
      dayDate.setUTCDate(startDate.getUTCDate() + offset);
      const dayKey = dayDate.toISOString().slice(0, 10);
      const incrementsForDay = dailyIncrements.get(dayKey);

      for (const provider of providerList) {
        const increment = incrementsForDay?.get(provider) ?? 0;
        runningByProvider.set(
          provider,
          (runningByProvider.get(provider) ?? 0) + increment
        );
      }

      const providerSeries = providerList.map((provider) => ({
        provider,
        bytes: runningByProvider.get(provider) ?? 0,
      }));
      const totalBytes = providerSeries.reduce(
        (sum, item) => sum + item.bytes,
        0
      );

      points.push({
        timestamp: dayDate.toISOString(),
        totalBytes,
        providers: providerSeries,
      });
    }

    return c.json({
      data: {
        days,
        start: startDate.toISOString(),
        end: today.toISOString(),
        providers: providerList,
        points,
      },
    });
  }
);

dashboardRoutes.get('/dashboard', async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Run aggregation queries in parallel
  const [configCount, jobCount, snapshotCount, last24hStats, storageStats, assignedDevices, recentJobs] =
    await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(backupConfigs)
        .where(eq(backupConfigs.orgId, orgId))
        .then((r) => r[0]?.count ?? 0),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(backupJobs)
        .where(eq(backupJobs.orgId, orgId))
        .then((r) => r[0]?.count ?? 0),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(backupSnapshots)
        .where(eq(backupSnapshots.orgId, orgId))
        .then((r) => r[0]?.count ?? 0),
      db
        .select({
          completed: sql<number>`count(*) filter (where ${backupJobs.status} = 'completed')::int`,
          failed: sql<number>`count(*) filter (where ${backupJobs.status} = 'failed')::int`,
          running: sql<number>`count(*) filter (where ${backupJobs.status} = 'running')::int`,
          pending: sql<number>`count(*) filter (where ${backupJobs.status} = 'pending')::int`,
        })
        .from(backupJobs)
        .where(
          and(
            eq(backupJobs.orgId, orgId),
            gte(backupJobs.createdAt, dayAgo)
          )
        )
        .then((r) => r[0] ?? { completed: 0, failed: 0, running: 0, pending: 0 }),
      db
        .select({
          totalBytes: sql<number>`coalesce(sum(${backupSnapshots.size}), 0)::bigint`,
          count: sql<number>`count(*)::int`,
        })
        .from(backupSnapshots)
        .where(eq(backupSnapshots.orgId, orgId))
        .then((r) => r[0] ?? { totalBytes: 0, count: 0 }),
      resolveAllBackupAssignedDevices(orgId).catch((err) => {
        console.error(`[BackupDashboard] Failed to resolve assigned devices:`, err instanceof Error ? err.message : err);
        return [];
      }),
      db
        .select({
          job: backupJobs,
          deviceName: devices.displayName,
          deviceHostname: devices.hostname,
          configName: backupConfigs.name,
        })
        .from(backupJobs)
        .leftJoin(devices, eq(backupJobs.deviceId, devices.id))
        .leftJoin(backupConfigs, eq(backupJobs.configId, backupConfigs.id))
        .where(eq(backupJobs.orgId, orgId))
        .orderBy(desc(backupJobs.createdAt))
        .limit(5),
    ]);

  const protectedDevices = new Set(assignedDevices.map((a) => a.deviceId));

  const latestJobs = recentJobs.map((r) => ({
    id: r.job.id,
    type: r.job.type,
    deviceId: r.job.deviceId,
    deviceName: r.deviceName ?? r.deviceHostname ?? null,
    configId: r.job.configId,
    configName: r.configName ?? null,
    status: r.job.status,
    startedAt: r.job.startedAt?.toISOString() ?? null,
    completedAt: r.job.completedAt?.toISOString() ?? null,
    createdAt: r.job.createdAt.toISOString(),
    totalSize: r.job.totalSize ?? null,
    errorCount: r.job.errorCount ?? null,
  }));

  return c.json({
    data: {
      totals: {
        configs: configCount,
        policies: assignedDevices.length,
        jobs: jobCount,
        snapshots: snapshotCount,
      },
      jobsLast24h: {
        completed: last24hStats.completed,
        failed: last24hStats.failed,
        running: last24hStats.running,
        queued: last24hStats.pending,
      },
      storage: {
        totalBytes: Number(storageStats.totalBytes),
        snapshots: storageStats.count,
      },
      coverage: {
        protectedDevices: protectedDevices.size,
      },
      latestJobs,
    },
  });
});

dashboardRoutes.get('/status/:deviceId', async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const deviceId = c.req.param('deviceId');

  // Resolve backup config via configuration policy system
  const resolved = await resolveBackupConfigForDevice(deviceId);

  // Get recent jobs for this device
  const jobs = await db
    .select()
    .from(backupJobs)
    .where(
      and(eq(backupJobs.orgId, orgId), eq(backupJobs.deviceId, deviceId))
    )
    .orderBy(desc(backupJobs.createdAt));

  const lastJob = jobs[0] ?? null;
  const lastSuccess =
    jobs.find((j) => j.status === 'completed') ?? null;
  const lastFailure =
    jobs.find((j) => j.status === 'failed') ?? null;

  return c.json({
    data: {
      deviceId,
      protected: Boolean(resolved),
      featureLinkId: resolved?.featureLinkId ?? null,
      configId: resolved?.configId ?? null,
      lastJob: lastJob
        ? {
            id: lastJob.id,
            status: lastJob.status,
            createdAt: lastJob.createdAt.toISOString(),
            completedAt: lastJob.completedAt?.toISOString() ?? null,
          }
        : null,
      lastSuccessAt: lastSuccess?.completedAt?.toISOString() ?? null,
      lastFailureAt: lastFailure?.completedAt?.toISOString() ?? null,
      nextScheduledAt: (() => {
        // Prefer normalized settings; fall back to inline_settings on the feature link
        const schedule = (resolved?.settings?.schedule ?? resolved?.inlineSettings) as Record<string, unknown> | null;
        if (!schedule) return null;
        // Normalized settings use { frequency, time }; inline uses { scheduleFrequency, scheduleTime }
        const frequency = (schedule.frequency ?? schedule.scheduleFrequency) as string | undefined;
        const time = (schedule.time ?? schedule.scheduleTime) as string | undefined;
        if (typeof frequency !== 'string' || typeof time !== 'string') return null;
        return getNextRun({ ...schedule, frequency, time } as any);
      })(),
    },
  });
});
