import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq, and, sql, gte, lte, desc, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { requirePermission } from '../../middleware/auth';
import {
  backupConfigs,
  backupJobs,
  backupSnapshots,
  devices,
} from '../../db/schema';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../../services/permissions';
import { resolveBackupConfigForDevice, resolveAllBackupAssignedDevices } from '../../services/featureConfigResolver';
import { getNextRun, resolveScopedOrgId } from './helpers';
import { usageHistoryQuerySchema } from './schemas';

export const dashboardRoutes = new Hono();

async function resolveSiteAllowedDeviceIds(orgId: string, perms: UserPermissions | undefined): Promise<string[] | null> {
  if (!perms?.allowedSiteIds) return null;
  const orgDevices = await db.select({ id: devices.id, siteId: devices.siteId }).from(devices).where(eq(devices.orgId, orgId));
  return orgDevices.filter((d) => typeof d.siteId === 'string' && canAccessSite(perms, d.siteId)).map((d) => d.id);
}

// How many of a device's most-recent backup jobs we look at to decide
// whether it "needs attention" (last-job-failed + consecutive-failure count).
const ATTENTION_LOOKBACK_JOBS = 5;
const ATTENTION_MAX_ITEMS = 20;

type AttentionItem = {
  id: string;
  title: string;
  description: string;
  severity: 'warning' | 'critical';
};

// Result of an attention-items computation. `error: true` means we could NOT
// compute the list (transient DB failure), which is meaningfully different from
// an empty list (genuinely no failing devices). Surfacing this lets the UI show
// a degraded/error state instead of implying an all-clear — F11's whole purpose
// is surfacing failures, so a swallowed error must never render as "healthy".
type AttentionItemsResult = { items: AttentionItem[]; error: boolean };

// A device needs attention when its most-recently created backup job
// failed. Severity escalates to 'critical' once the two most recent jobs
// both failed (a single blip stays 'warning'). This is intentionally
// data-driven from real backup_jobs rows, scoped the same way the rest of
// this route scopes org/site access (see jobDeviceScope / allowedDeviceIds).
async function resolveAttentionItems(
  orgId: string,
  jobDeviceScope: ReturnType<typeof inArray> | undefined,
  allowedDeviceIds: string[] | null,
  noSiteAllowedDevices: boolean
): Promise<AttentionItemsResult> {
  if (noSiteAllowedDevices) return { items: [], error: false };

  try {
    const rankedJobs = db
      .select({
        deviceId: backupJobs.deviceId,
        status: backupJobs.status,
        errorLog: backupJobs.errorLog,
        completedAt: backupJobs.completedAt,
        createdAt: backupJobs.createdAt,
        rn: sql<number>`row_number() over (partition by ${backupJobs.deviceId} order by ${backupJobs.createdAt} desc)`.as('rn'),
      })
      .from(backupJobs)
      .where(and(eq(backupJobs.orgId, orgId), jobDeviceScope))
      .as('ranked_backup_jobs_for_attention');

    const rows = await db
      .select({
        deviceId: rankedJobs.deviceId,
        status: rankedJobs.status,
        errorLog: rankedJobs.errorLog,
        completedAt: rankedJobs.completedAt,
        createdAt: rankedJobs.createdAt,
        rn: rankedJobs.rn,
        deviceName: devices.displayName,
        deviceHostname: devices.hostname,
      })
      .from(rankedJobs)
      .leftJoin(devices, eq(rankedJobs.deviceId, devices.id))
      .where(lte(rankedJobs.rn, ATTENTION_LOOKBACK_JOBS))
      .orderBy(rankedJobs.deviceId, rankedJobs.rn);

    const scopedRows = allowedDeviceIds
      ? rows.filter((row) => allowedDeviceIds.includes(row.deviceId))
      : rows;

    const byDevice = new Map<string, typeof scopedRows>();
    for (const row of scopedRows) {
      const list = byDevice.get(row.deviceId) ?? [];
      list.push(row);
      byDevice.set(row.deviceId, list);
    }

    const items: Array<AttentionItem & { lastFailureAt: string }> = [];
    for (const [deviceId, jobs] of byDevice) {
      const sorted = [...jobs].sort((a, b) => a.rn - b.rn);
      const latest = sorted[0];
      if (!latest || latest.status !== 'failed') continue;

      let consecutiveFailures = 0;
      let reason: string | null = null;
      for (const job of sorted) {
        if (job.status !== 'failed') break;
        consecutiveFailures += 1;
        if (!reason && job.errorLog) reason = job.errorLog;
      }

      const deviceName = latest.deviceName ?? latest.deviceHostname ?? deviceId.slice(0, 8);
      const lastFailureAt = (latest.completedAt ?? latest.createdAt).toISOString();

      items.push({
        id: `backup-failing-${deviceId}`,
        title:
          consecutiveFailures > 1
            ? `${deviceName}: ${consecutiveFailures} consecutive backup failures`
            : `${deviceName}: latest backup failed`,
        description: [reason, `Last failed ${lastFailureAt}`].filter(Boolean).join(' · '),
        severity: consecutiveFailures >= 2 ? 'critical' : 'warning',
        lastFailureAt,
      });
    }

    items.sort((a, b) => new Date(b.lastFailureAt).getTime() - new Date(a.lastFailureAt).getTime());
    return {
      items: items.slice(0, ATTENTION_MAX_ITEMS).map(({ lastFailureAt: _lastFailureAt, ...item }) => item),
      error: false,
    };
  } catch (err) {
    console.error('[BackupDashboard] Failed to resolve attention items:', err instanceof Error ? err.message : err);
    // Do NOT 500 the whole dashboard for one failed sub-query, but signal the
    // degraded state so the UI does not render an all-clear it can't vouch for.
    return { items: [], error: true };
  }
}

dashboardRoutes.get(
  '/usage-history',
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('query', usageHistoryQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
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

dashboardRoutes.get('/dashboard', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const perms = c.get('permissions') as UserPermissions | undefined;
  const allowedDeviceIds = await resolveSiteAllowedDeviceIds(orgId, perms);
  const noSiteAllowedDevices = allowedDeviceIds !== null && allowedDeviceIds.length === 0;
  const jobDeviceScope = allowedDeviceIds && allowedDeviceIds.length > 0
    ? inArray(backupJobs.deviceId, allowedDeviceIds)
    : undefined;
  const snapshotDeviceScope = allowedDeviceIds && allowedDeviceIds.length > 0
    ? inArray(backupSnapshots.deviceId, allowedDeviceIds)
    : undefined;

  // Run aggregation queries in parallel
  const [configCount, jobCount, snapshotCount, last24hStats, storageStats, assignedDevicesRaw, recentJobsRaw, attention] =
    await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(backupConfigs)
        .where(eq(backupConfigs.orgId, orgId))
        .then((r) => r[0]?.count ?? 0),
      noSiteAllowedDevices ? Promise.resolve(0) : db
        .select({ count: sql<number>`count(*)::int` })
        .from(backupJobs)
        .where(and(eq(backupJobs.orgId, orgId), jobDeviceScope))
        .then((r) => r[0]?.count ?? 0),
      noSiteAllowedDevices ? Promise.resolve(0) : db
        .select({ count: sql<number>`count(*)::int` })
        .from(backupSnapshots)
        .where(and(eq(backupSnapshots.orgId, orgId), snapshotDeviceScope))
        .then((r) => r[0]?.count ?? 0),
      noSiteAllowedDevices ? Promise.resolve({ completed: 0, failed: 0, running: 0, pending: 0 }) : db
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
            gte(backupJobs.createdAt, dayAgo),
            jobDeviceScope
          )
        )
        .then((r) => r[0] ?? { completed: 0, failed: 0, running: 0, pending: 0 }),
      noSiteAllowedDevices ? Promise.resolve({ totalBytes: 0, count: 0 }) : db
        .select({
          totalBytes: sql<number>`coalesce(sum(${backupSnapshots.size}), 0)::bigint`,
          count: sql<number>`count(*)::int`,
        })
        .from(backupSnapshots)
        .where(and(eq(backupSnapshots.orgId, orgId), snapshotDeviceScope))
        .then((r) => r[0] ?? { totalBytes: 0, count: 0 }),
      resolveAllBackupAssignedDevices(orgId).catch((err) => {
        console.error(`[BackupDashboard] Failed to resolve assigned devices:`, err instanceof Error ? err.message : err);
        return [];
      }),
      noSiteAllowedDevices ? Promise.resolve([]) : db
        .select({
          job: backupJobs,
          deviceName: devices.displayName,
          deviceHostname: devices.hostname,
          configName: backupConfigs.name,
        })
        .from(backupJobs)
        .leftJoin(devices, eq(backupJobs.deviceId, devices.id))
        .leftJoin(backupConfigs, eq(backupJobs.configId, backupConfigs.id))
        .where(and(eq(backupJobs.orgId, orgId), jobDeviceScope))
        .orderBy(desc(backupJobs.createdAt))
        .limit(5),
      resolveAttentionItems(orgId, jobDeviceScope, allowedDeviceIds, noSiteAllowedDevices),
    ]);

  const assignedDevices = allowedDeviceIds
    ? assignedDevicesRaw.filter((a) => allowedDeviceIds.includes(a.deviceId))
    : assignedDevicesRaw;
  const recentJobs = allowedDeviceIds
    ? recentJobsRaw.filter((r) => allowedDeviceIds.includes(r.job.deviceId))
    : recentJobsRaw;
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
    errorLog: r.job.errorLog ?? null,
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
      attentionItems: attention.items,
      // Additive, backward-compatible degraded signal: true when the
      // attention-items sub-query failed and the list could not be computed.
      // The UI must treat this as "unknown", not "all clear".
      attentionError: attention.error,
    },
  });
});

dashboardRoutes.get('/status/:deviceId', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const deviceId = c.req.param('deviceId')!;

  const [device] = await db
    .select({ id: devices.id, siteId: devices.siteId })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  // Site-scope gate: `requirePermission` populated `permissions` in context;
  // enforce `allowedSiteIds` here since RLS does not defend the site axis.
  // Mirrors the SP2 launch-readiness sweep (PR #864/#868).
  const userPerms = c.get('permissions') as UserPermissions | undefined;
  if (userPerms?.allowedSiteIds && (typeof device.siteId !== 'string' || !canAccessSite(userPerms, device.siteId))) {
    return c.json({ error: 'Access to this site denied' }, 403);
  }

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
      timezone: resolved?.resolvedTimezone ?? null,
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
      lastFailureError: lastFailure?.errorLog ?? null,
      nextScheduledAt: (() => {
        // Prefer normalized settings; fall back to inline_settings on the feature link
        const schedule = (resolved?.settings?.schedule ?? resolved?.inlineSettings) as Record<string, unknown> | null;
        if (!schedule) return null;
        // Normalized settings use { frequency, time }; inline uses { scheduleFrequency, scheduleTime }
        const frequency = (schedule.frequency ?? schedule.scheduleFrequency) as string | undefined;
        const time = (schedule.time ?? schedule.scheduleTime) as string | undefined;
        if (typeof frequency !== 'string' || typeof time !== 'string') return null;
        return getNextRun({ ...schedule, frequency, time } as any, resolved?.resolvedTimezone);
      })(),
    },
  });
});
