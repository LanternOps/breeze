import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq, and, sql, gte, lte, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { requirePermission } from '../../middleware/auth';
import {
  backupConfigs,
  backupJobs,
  backupSnapshots,
  devices,
  RESTORABLE_BACKUP_JOB_STATUSES,
} from '../../db/schema';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../../services/permissions';
import { resolveBackupConfigForDevice, resolveAllBackupAssignedDevices } from '../../services/featureConfigResolver';
import {
  backupJobHistoryOrderBy,
  compareBackupRunRecency,
  latestBackupRunOrderBy,
  latestBackupRunWindowOrder,
} from '../../services/backupJobOrdering';
import { getNextRun, resolveScopedOrgId } from './helpers';
import { usageHistoryQuerySchema } from './schemas';
import {
  getFirstPartyCoverageForDevices,
  getProviderAttentionItems,
  getProviderCoverageForDevices,
} from '../../services/backupHealthReadModel';
import { getStorageByProvider } from '../../services/backupStorageByProvider';

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

// Terminal job statuses that mean "this device did NOT get a good backup".
// `partial` belongs here alongside `failed` (#3000): a run that stored a
// fraction of its data is not a success, and before this it was reported with
// the same green status as a clean run, so nothing keyed on job status ever
// fired for it. `cancelled` is deliberately absent — that one is a user action,
// not a fault.
const NEEDS_ATTENTION_JOB_STATUSES: ReadonlySet<string> = new Set(['failed', 'partial']);

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
        // rn=1 must be the device's most recent RUN, not the most recently
        // inserted row — see backupJobOrdering. Ordering this window by
        // created_at alone let a queued job (or the loser of a same-transaction
        // fan-out tie) take rn=1 and mask the failed run underneath it, so the
        // device never showed up in attention items at all.
        rn: sql<number>`row_number() over (partition by ${backupJobs.deviceId} order by ${latestBackupRunWindowOrder})`.as('rn'),
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
      // #3000: `partial` counts as needing attention. A device whose latest run
      // stored a sliver of its data is exactly the case the issue reported as
      // invisible — it is not a success, and a dashboard that only surfaces
      // hard failures never mentions it.
      if (!latest || !NEEDS_ATTENTION_JOB_STATUSES.has(latest.status)) continue;

      let consecutiveFailures = 0;
      let reason: string | null = null;
      // Wording only: a run of `partial` jobs is not a run of "failures", so
      // the copy has to soften when any of the counted jobs was partial.
      let sawPartial = false;
      for (const job of sorted) {
        if (!NEEDS_ATTENTION_JOB_STATUSES.has(job.status)) break;
        consecutiveFailures += 1;
        if (job.status === 'partial') sawPartial = true;
        if (!reason && job.errorLog) reason = job.errorLog;
      }

      const deviceName = latest.deviceName ?? latest.deviceHostname ?? deviceId.slice(0, 8);
      const lastFailureAt = (latest.completedAt ?? latest.createdAt).toISOString();
      const singularTitle =
        latest.status === 'partial'
          ? `${deviceName}: latest backup only partially completed`
          : `${deviceName}: latest backup failed`;

      items.push({
        id: `backup-failing-${deviceId}`,
        title:
          consecutiveFailures > 1
            ? sawPartial
              ? `${deviceName}: ${consecutiveFailures} consecutive unsuccessful backups`
              : `${deviceName}: ${consecutiveFailures} consecutive backup failures`
            : singularTitle,
        description: [reason, `Last unsuccessful ${lastFailureAt}`].filter(Boolean).join(' · '),
        // `critical` requires a real failure in the streak: two consecutive
        // partial runs are two consecutive restore points, degraded but usable,
        // and escalating them like two hard failures would dilute the signal.
        severity: consecutiveFailures >= 2 && !sawPartial ? 'critical' : 'warning',
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

/**
 * "Devices needing backup" — assigned devices with no fresh restore point from
 * EITHER source.
 *
 * Coverage is the OR of the two sources (spec D4): a customer whose servers are
 * protected by Cove is protected, full stop, and listing them here — under a
 * button that dispatches a first-party backup job — is exactly the false
 * negative this integration exists to remove. Both lookups go through the
 * unified read model so this panel, the overview bars, the portal and the
 * posture report cannot disagree about the word "covered".
 */
const OVERDUE_MAX_ITEMS = 20;

async function resolveOverdueDevices(
  orgId: string,
  assignedDeviceIds: string[],
  nameByDeviceId: ReadonlyMap<string, string>,
): Promise<Array<{ id: string; name: string; lastBackup: string | null }>> {
  if (assignedDeviceIds.length === 0) return [];
  const [firstParty, provider] = await Promise.all([
    getFirstPartyCoverageForDevices(orgId, assignedDeviceIds),
    getProviderCoverageForDevices(orgId, assignedDeviceIds),
  ]);
  const overdue: Array<{ id: string; name: string; lastBackup: string | null }> = [];
  for (const deviceId of assignedDeviceIds) {
    if (firstParty.get(deviceId)?.covered) continue;
    if (provider.get(deviceId)?.covered) continue;
    overdue.push({
      id: deviceId,
      name: nameByDeviceId.get(deviceId) ?? deviceId.slice(0, 8),
      lastBackup: firstParty.get(deviceId)?.lastSuccessAt ?? null,
    });
    if (overdue.length >= OVERDUE_MAX_ITEMS) break;
  }
  return overdue;
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
  const [configCount, jobCount, snapshotCount, last24hStats, storageStats, assignedDevicesRaw, recentJobsRaw, attention, storageProviders] =
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
      noSiteAllowedDevices ? Promise.resolve({ completed: 0, failed: 0, partial: 0, running: 0, pending: 0 }) : db
        .select({
          completed: sql<number>`count(*) filter (where ${backupJobs.status} = 'completed')::int`,
          failed: sql<number>`count(*) filter (where ${backupJobs.status} = 'failed')::int`,
          // #3000: without its own counter a partial job vanishes from BOTH
          // sides of the dashboard's success-rate fraction, so a device whose
          // every run is partial reads as having no runs at all.
          partial: sql<number>`count(*) filter (where ${backupJobs.status} = 'partial')::int`,
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
        .then((r) => r[0] ?? { completed: 0, failed: 0, partial: 0, running: 0, pending: 0 }),
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
        // Activity feed, so created_at stays primary (a job queued seconds ago
        // belongs at the top) — but the order has to be TOTAL, or a
        // same-transaction fan-out reshuffles the top 5 between refreshes.
        .orderBy(...backupJobHistoryOrderBy)
        .limit(5),
      resolveAttentionItems(orgId, jobDeviceScope, allowedDeviceIds, noSiteAllowedDevices),
      getStorageByProvider(orgId, allowedDeviceIds),
    ]);

  const assignedDevices = allowedDeviceIds
    ? assignedDevicesRaw.filter((a) => allowedDeviceIds.includes(a.deviceId))
    : assignedDevicesRaw;
  const recentJobs = allowedDeviceIds
    ? recentJobsRaw.filter((r) => allowedDeviceIds.includes(r.job.deviceId))
    : recentJobsRaw;

  const assignedDeviceIds = assignedDevices.map((a) => a.deviceId);
  const nameByDeviceId = new Map<string, string>(
    recentJobs.map((r) => [r.job.deviceId, r.deviceName ?? r.deviceHostname ?? r.job.deviceId]),
  );

  // One try/catch for the whole provider block: a transient failure here must
  // degrade the panel, not 500 the dashboard — and must SAY it degraded, so the
  // UI never renders "no devices need backup" it cannot vouch for.
  let overdueDevices: Array<{ id: string; name: string; lastBackup: string | null }> = [];
  let providerCoverage = new Map<string, { covered: boolean; health: string }>();
  let providerAttention: AttentionItem[] = [];
  let providerError = false;
  try {
    [overdueDevices, providerCoverage, providerAttention] = await Promise.all([
      resolveOverdueDevices(orgId, assignedDeviceIds, nameByDeviceId),
      getProviderCoverageForDevices(orgId, assignedDeviceIds),
      noSiteAllowedDevices
        ? Promise.resolve([] as AttentionItem[])
        : (getProviderAttentionItems(orgId, {
            allowedDeviceIds,
            limit: ATTENTION_MAX_ITEMS,
          }) as Promise<AttentionItem[]>),
    ]);
  } catch (err) {
    console.error('[BackupDashboard] provider coverage failed:', err instanceof Error ? err.message : err);
    providerError = true;
  }

  // A device the vendor protects counts as protected even when no first-party
  // policy is assigned to it (spec D4).
  const protectedDevices = new Set(assignedDeviceIds);
  for (const [deviceId, coverage] of providerCoverage) {
    if (coverage.covered) protectedDevices.add(deviceId);
  }

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
        // Must be serialized, not just counted: the web success-rate fraction
        // reads `partial` off this object, and omitting it here silently makes
        // that fix inert while every unit test still passes (#3000).
        partial: last24hStats.partial,
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
      // #2562: the Overview "Storage by Provider" panel read this key from the
      // start, but it was never sent, so the panel always showed its
      // "no storage providers configured" empty state.
      storageProviders,
      // NEW (D-13): the web has rendered this panel from an absent key since it
      // was written. Provider-covered devices are excluded — dispatching a
      // first-party job to a machine Cove already backed up is the false
      // negative this integration removes.
      overdueDevices,
      attentionItems: [...attention.items, ...providerAttention].slice(0, ATTENTION_MAX_ITEMS),
      // Additive, backward-compatible degraded signal: true when the
      // attention-items sub-query failed and the list could not be computed.
      // The UI must treat this as "unknown", not "all clear".
      attentionError: attention.error || providerError,
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

  // Get recent jobs for this device, most-recent RUN first.
  //
  // `created_at` is only the insert timestamp: the profile fan-out writes a
  // whole occurrence's jobs in one transaction, so they share it exactly and
  // `ORDER BY created_at DESC` is not a total order. QA hit that tie and the
  // planner handed back the OLDER run, which silently hid the VSS Status panel
  // (it renders only when the chosen lastJob carries vss_metadata).
  const jobRows = await db
    .select()
    .from(backupJobs)
    .where(
      and(eq(backupJobs.orgId, orgId), eq(backupJobs.deviceId, deviceId))
    )
    .orderBy(...latestBackupRunOrderBy);

  // This one array answers three questions below (last job / last success /
  // last failure), so recency is applied once here through the comparator that
  // mirrors latestBackupRunOrderBy — the three answers can't drift apart, and
  // the rule is unit-testable without a live planner.
  const jobs = [...jobRows].sort(compareBackupRunRecency);

  const lastJob = jobs[0] ?? null;
  // A partial run counts here for the same reason it counts for RPO: it left a
  // real restore point. Reporting "last successful backup: never" for a device
  // that demonstrably has a snapshot would be a worse lie than the one #3000
  // set out to fix. Its degraded-ness is carried by the job's own status.
  const lastSuccess =
    jobs.find((j) => (RESTORABLE_BACKUP_JOB_STATUSES as readonly string[]).includes(j.status)) ?? null;
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
            // #3027: the device tab's VSS panel keys off this. Bounded and
            // secret-redacted at write time (sanitizeVssMetadata), and only
            // ever present on Windows runs that actually started a VSS
            // session — null on every other run, which is why the panel is
            // hidden rather than shown empty.
            vssMetadata: lastJob.vssMetadata ?? null,
            // #3027: the companion channel, and the ONLY one that exists for
            // the worst VSS outcome — when the shadow copy could not be created
            // at all there is no vssMetadata to send, so the degradation rides
            // the run's warning text into error_log. Without this the device
            // tab showed a clean, green backup for a run that read every file
            // off the live volume. Already secret-redacted at write time.
            errorLog: lastJob.errorLog ?? null,
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
