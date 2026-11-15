import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq, and, sql, gte, lte, inArray } from 'drizzle-orm';
import { db, withDbTransaction } from '../../db';
import { requirePermission } from '../../middleware/auth';
import {
  backupConfigs,
  backupJobs,
  backupSnapshots,
  devices,
  IN_FLIGHT_BACKUP_JOB_STATUSES,
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
import {
  classifyBackupFailureDetail,
  deriveBackupJobDataAccounting,
  splitReparseSkipNotice,
  stripInlineIndexDropNote,
  type ActiveBackupJob,
  type BackupFailureCategory,
  type BackupFailureCause,
} from '@breeze/shared';
import { getNextRun, loadJobResumedAt, resolveScopedOrgId } from './helpers';
import { usageHistoryQuerySchema } from './schemas';
import {
  getFirstPartyCoverageForDevices,
  getProviderAttentionItems,
  getProviderCoverageForDevices,
} from '../../services/backupHealthReadModel';
import { getStorageByProvider } from '../../services/backupStorageByProvider';
import {
  DESTINATION_LOOKBACK_MS,
  classifyDestinationOutcome,
  currentDestinationIdentity,
  evaluateBackupDestination,
  type DestinationJobOutcome,
} from '../../services/backupDestinationHealth';
import { storedSnapshotBytesByProviderSince, sumStoredSnapshotBytes } from '../../services/backupStoredBytes';

export const dashboardRoutes = new Hono();

// failureCategory and its optional finer failureCause travel together (#11768).
function failureFields(job: { status: string; errorLog: string | null | undefined }) {
  const { category, cause } = classifyBackupFailureDetail(job);
  return { failureCategory: category, failureCause: cause };
}

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

// #11768: one item for a destination that is failing for several devices. The
// web localizes it from these structured fields; title/description are only the
// fallback the item shape requires.
type DestinationAttentionItem = AttentionItem & {
  kind: 'destination_failing';
  configId: string;
  destinationName: string;
  failureCategory: BackupFailureCategory;
  failureCause: BackupFailureCause | null;
  failingDevices: number;
  totalDevices: number;
};

/** One active destination's evidence, as the request's scope can see it. */
export type DestinationEvidence = {
  configId: string;
  name: string;
  currentStorageIdentity: string;
  jobs: DestinationJobOutcome[];
};

/**
 * #11772: the item is the shared evaluator's verdict
 * (services/backupDestinationHealth.ts), the same one the connection-health
 * `backup_destination` source notifies on, so the dashboard and the notice
 * cannot disagree. Counts cover only the devices the caller can see.
 */
export function resolveDestinationAttentionItems(
  destinations: readonly DestinationEvidence[],
  now: Date
): Array<DestinationAttentionItem & { lastFailureAt: string }> {
  const items: Array<DestinationAttentionItem & { lastFailureAt: string }> = [];
  for (const d of destinations) {
    const e = evaluateBackupDestination({ currentStorageIdentity: d.currentStorageIdentity, jobs: d.jobs, now });
    if (e.state !== 'broken' || !e.lastFailureAt) continue;
    const lastFailureAt = e.lastFailureAt.toISOString();
    items.push({
      id: `backup-destination-${d.configId}`,
      kind: 'destination_failing',
      title: `${d.name}: ${e.failingDevices} of ${e.totalDevices} devices failing`,
      description: `Last unsuccessful ${lastFailureAt}`,
      severity: 'critical',
      configId: d.configId,
      destinationName: d.name,
      failureCategory: 'storage',
      failureCause: e.cause,
      failingDevices: e.failingDevices,
      totalDevices: e.totalDevices,
      lastFailureAt,
    });
  }
  return items;
}

const DESTINATION_TERMINAL_STATUSES = ['completed', 'failed', 'partial', 'completed_with_errors', 'cancelled'] as const;

/**
 * Terminal outcomes in the evaluator's lookback for the org's active
 * destinations, under the request's org and site scope, for the destinations
 * that can be broken (any destination fault in that evidence). Runs inside the
 * caller's savepoint.
 *
 * Each such config's current identity comes from a Drizzle select of the
 * sealed providerConfig column, which opens it the way every reader does (raw
 * SQL on provider_config would bypass that). Only configs with a fault are
 * opened, and only the derived identity is kept.
 */
async function loadDestinationEvidence(
  orgId: string,
  jobDeviceScope: ReturnType<typeof inArray> | undefined,
  allowedDeviceIds: string[] | null,
  now: Date
): Promise<DestinationEvidence[]> {
  const rows = await db
    .select({
      configId: backupJobs.configId,
      configName: backupConfigs.name,
      deviceId: backupJobs.deviceId,
      status: backupJobs.status,
      errorLog: backupJobs.errorLog,
      createdAt: backupJobs.createdAt,
      completedAt: backupJobs.completedAt,
      storageIdentity: backupJobs.storageIdentity,
    })
    .from(backupJobs)
    .innerJoin(backupConfigs, eq(backupJobs.configId, backupConfigs.id))
    .where(and(
      eq(backupJobs.orgId, orgId),
      eq(backupConfigs.orgId, orgId),
      eq(backupConfigs.isActive, true),
      gte(backupJobs.completedAt, new Date(now.getTime() - DESTINATION_LOOKBACK_MS)),
      inArray(backupJobs.status, [...DESTINATION_TERMINAL_STATUSES]),
      jobDeviceScope,
    ));

  const byConfig = new Map<string, { name: string; jobs: DestinationJobOutcome[] }>();
  for (const row of rows) {
    if (allowedDeviceIds && !allowedDeviceIds.includes(row.deviceId)) continue;
    let d = byConfig.get(row.configId);
    if (!d) {
      d = { name: row.configName ?? row.configId.slice(0, 8), jobs: [] };
      byConfig.set(row.configId, d);
    }
    d.jobs.push({
      deviceId: row.deviceId,
      status: row.status,
      errorLog: row.errorLog,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
      storageIdentity: row.storageIdentity,
    });
  }

  // Without a destination fault in its evidence a config cannot be broken.
  const faulted = [...byConfig.keys()].filter((id) =>
    byConfig.get(id)!.jobs.some((j) => classifyDestinationOutcome(j).outcome === 'bad'));
  if (faulted.length === 0) return [];

  const configs = await db
    .select({ id: backupConfigs.id, provider: backupConfigs.provider, providerConfig: backupConfigs.providerConfig })
    .from(backupConfigs)
    .where(and(eq(backupConfigs.orgId, orgId), inArray(backupConfigs.id, faulted)));

  return configs.flatMap((c) => {
    const d = byConfig.get(c.id);
    if (!d) return [];
    return [{
      configId: c.id,
      name: d.name,
      currentStorageIdentity: currentDestinationIdentity(String(c.provider), c.providerConfig),
      jobs: d.jobs,
    }];
  });
}

// Result of an attention-items computation. `error: true` means we could NOT
// compute the list (transient DB failure), which is meaningfully different from
// an empty list (genuinely no failing devices). Surfacing this lets the UI show
// a degraded/error state instead of implying an all-clear — F11's whole purpose
// is surfacing failures, so a swallowed error must never render as "healthy".
type AttentionItemsResult = { items: Array<AttentionItem | DestinationAttentionItem>; error: boolean };

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
        configId: backupJobs.configId,
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

    // The savepoint is what lets the catch below work: a failure of this read
    // would otherwise be rethrown when the request transaction ends (#11203).
    const rows = await withDbTransaction(async () => db
      .select({
        deviceId: rankedJobs.deviceId,
        status: rankedJobs.status,
        errorLog: rankedJobs.errorLog,
        completedAt: rankedJobs.completedAt,
        createdAt: rankedJobs.createdAt,
        rn: rankedJobs.rn,
        configId: rankedJobs.configId,
        configName: backupConfigs.name,
        deviceName: devices.displayName,
        deviceHostname: devices.hostname,
      })
      .from(rankedJobs)
      .leftJoin(devices, eq(rankedJobs.deviceId, devices.id))
      .leftJoin(backupConfigs, eq(rankedJobs.configId, backupConfigs.id))
      .where(lte(rankedJobs.rn, ATTENTION_LOOKBACK_JOBS))
      .orderBy(rankedJobs.deviceId, rankedJobs.rn));

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
      if (!latest) continue;

      // #5396: a latest run that missed files under the threshold is a
      // restore point, so it is never part of a failure streak — but the
      // operator must still see it. Its own single warning item.
      if (latest.status === 'completed_with_errors') {
        const deviceName = latest.deviceName ?? latest.deviceHostname ?? deviceId.slice(0, 8);
        const lastFailureAt = (latest.completedAt ?? latest.createdAt).toISOString();
        items.push({
          id: `backup-failing-${deviceId}`,
          title: `${deviceName}: latest backup completed with file errors`,
          description: [stripInlineIndexDropNote(latest.errorLog).warning, `Completed ${lastFailureAt}`].filter(Boolean).join(' · '),
          severity: 'warning',
          lastFailureAt,
        });
        continue;
      }

      if (!NEEDS_ATTENTION_JOB_STATUSES.has(latest.status)) continue;

      let consecutiveFailures = 0;
      let reason: string | null = null;
      // Wording only: a run of `partial` jobs is not a run of "failures", so
      // the copy has to soften when any of the counted jobs was partial.
      let sawPartial = false;
      for (const job of sorted) {
        if (!NEEDS_ATTENTION_JOB_STATUSES.has(job.status)) break;
        consecutiveFailures += 1;
        if (job.status === 'partial') sawPartial = true;
        // #9543: the agent's skipped-reparse-point note is informational, so
        // it is never the reason a device needs attention.
        // #11026: nor is a historic note that a file list did not fit in the
        // result: the list was not lost.
        if (!reason && job.errorLog) reason = splitReparseSkipNotice(stripInlineIndexDropNote(job.errorLog).warning).diagnostic;
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
    // #11768: a destination failing for several devices outranks the per-device
    // items it explains; those stay, after it.
    // #11772: the destination items come from their own read. If it fails, the
    // per-device items above still stand; the list is flagged as degraded so
    // the UI does not present it as complete.
    const now = new Date();
    let destinationItems: Array<DestinationAttentionItem & { lastFailureAt: string }> = [];
    let destinationError = false;
    try {
      const evidence = await withDbTransaction(() => loadDestinationEvidence(orgId, jobDeviceScope, allowedDeviceIds, now));
      destinationItems = resolveDestinationAttentionItems(evidence, now)
        .sort((a, b) => b.failingDevices - a.failingDevices);
    } catch (err) {
      console.error(`[BackupDashboard] Failed to resolve destination attention items for org ${orgId}:`, err instanceof Error ? err.message : err);
      destinationError = true;
    }
    return {
      items: [...destinationItems, ...items]
        .slice(0, ATTENTION_MAX_ITEMS)
        .map(({ lastFailureAt: _lastFailureAt, ...item }) => item),
      error: destinationError,
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
  const firstParty = await getFirstPartyCoverageForDevices(orgId, assignedDeviceIds);
  const provider = await getProviderCoverageForDevices(orgId, assignedDeviceIds);
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

    // Stored bytes (#9631), not each snapshot's logical size. Snapshots
    // captured before the window form the starting level, so the series
    // ends at the same figure as Storage Used.
    // Same site narrowing as /dashboard's Storage Used: RLS does not see
    // the site axis, and the two figures must agree.
    const perms = c.get('permissions') as UserPermissions | undefined;
    const allowedDeviceIds = await resolveSiteAllowedDeviceIds(orgId, perms);
    const usageRows = allowedDeviceIds !== null && allowedDeviceIds.length === 0
      ? []
      : await storedSnapshotBytesByProviderSince(
          and(
            eq(backupSnapshots.orgId, orgId),
            allowedDeviceIds ? inArray(backupSnapshots.deviceId, allowedDeviceIds) : undefined
          ),
          startDate
        );

    const providers = new Set<string>();
    const baselineByProvider = new Map<string, number>();
    const dailyIncrements = new Map<string, Map<string, number>>();

    for (const row of usageRows) {
      const provider = row.provider ?? 'unknown';
      providers.add(provider);
      if (row.day === null) {
        baselineByProvider.set(provider, (baselineByProvider.get(provider) ?? 0) + row.bytes);
        continue;
      }
      const dayMap = dailyIncrements.get(row.day) ?? new Map<string, number>();
      dayMap.set(provider, (dayMap.get(provider) ?? 0) + row.bytes);
      dailyIncrements.set(row.day, dayMap);
    }

    const providerList = Array.from(providers);
    if (providerList.length === 0) providerList.push('local');
    const runningByProvider = new Map(
      providerList.map((p) => [p, baselineByProvider.get(p) ?? 0])
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

  // Run the required aggregation queries in parallel. A failure in any of them
  // is a 500. The optional reads that degrade instead run after this block.
  const [configCount, jobCount, snapshotCount, last24hStats, storageStats, recentJobsRaw, storageProviders] =
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
      noSiteAllowedDevices ? Promise.resolve({ completed: 0, completedWithErrors: 0, failed: 0, partial: 0, running: 0, pending: 0 }) : db
        .select({
          completed: sql<number>`count(*) filter (where ${backupJobs.status} = 'completed')::int`,
          // #5396: restore points that missed files under the threshold. Own
          // counter so the web success rate counts them without greening them.
          completedWithErrors: sql<number>`count(*) filter (where ${backupJobs.status} = 'completed_with_errors')::int`,
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
        .then((r) => r[0] ?? { completed: 0, completedWithErrors: 0, failed: 0, partial: 0, running: 0, pending: 0 }),
      // Stored bytes, not the sum of logical snapshot sizes (#9631).
      noSiteAllowedDevices
        ? Promise.resolve({ totalBytes: 0, count: 0 })
        : sumStoredSnapshotBytes(and(eq(backupSnapshots.orgId, orgId), snapshotDeviceScope)),
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
      getStorageByProvider(orgId, allowedDeviceIds),
    ]);

  // Optional reads, each in a savepoint so a failure degrades the panel rather
  // than ending the request in a 500 (#11203). They must not join the
  // Promise.all above: every statement here shares one connection, so while a
  // failed savepoint waits for its rollback, a sibling's next statement lands
  // in the aborted transaction and fails on the outer scope.
  let assignedError = false;
  const assignedDevicesRaw = await withDbTransaction(() => resolveAllBackupAssignedDevices(orgId)).catch((err) => {
    console.error(`[BackupDashboard] Failed to resolve assigned devices:`, err instanceof Error ? err.message : err);
    assignedError = true;
    return [];
  });
  const attention = await resolveAttentionItems(orgId, jobDeviceScope, allowedDeviceIds, noSiteAllowedDevices);

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

  // One try/catch and one savepoint for the whole provider block, all or
  // nothing: a transient failure here must degrade the panel, not 500 the
  // dashboard — and must SAY it degraded, so the UI never renders "no devices
  // need backup" it cannot vouch for. There is one flag for the three reads, so
  // partial results have nothing to report them with.
  let overdueDevices: Array<{ id: string; name: string; lastBackup: string | null }> = [];
  let providerCoverage = new Map<string, { covered: boolean; health: string }>();
  let providerAttention: AttentionItem[] = [];
  let providerError = false;
  try {
    // In sequence, not Promise.all: a read still running when a sibling fails
    // would carry on after the savepoint has rolled back.
    [overdueDevices, providerCoverage, providerAttention] = await withDbTransaction(async () => [
      await resolveOverdueDevices(orgId, assignedDeviceIds, nameByDeviceId),
      await getProviderCoverageForDevices(orgId, assignedDeviceIds),
      noSiteAllowedDevices
        ? ([] as AttentionItem[])
        : ((await getProviderAttentionItems(orgId, {
            allowedDeviceIds,
            limit: ATTENTION_MAX_ITEMS,
          })) as AttentionItem[]),
    ] as const);
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
    ...failureFields(r.job),
    dataAccounting: deriveBackupJobDataAccounting(r.job),
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
        completedWithErrors: last24hStats.completedWithErrors,
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
      // The UI must treat this as "unknown", not "all clear". A failed assigned-
      // devices read counts: with none known, the overdue list is empty too.
      attentionError: attention.error || providerError || assignedError,
    },
  });
});

type BackupJobRow = typeof backupJobs.$inferSelect;

function isInFlight(status: string): status is ActiveBackupJob['status'] {
  return (IN_FLIGHT_BACKUP_JOB_STATUSES as readonly string[]).includes(status);
}

/**
 * Running before pending (a pending job behind a running one is waiting its
 * turn on the device), then startedAt ascending (never-started last), then
 * createdAt ascending: the order the device works them in.
 */
function compareActiveJobs(a: BackupJobRow, b: BackupJobRow): number {
  if (a.status !== b.status) return a.status === 'running' ? -1 : 1;
  if (a.startedAt && b.startedAt) {
    const started = a.startedAt.getTime() - b.startedAt.getTime();
    if (started !== 0) return started;
  } else if (a.startedAt || b.startedAt) {
    return a.startedAt ? -1 : 1;
  }
  return a.createdAt.getTime() - b.createdAt.getTime();
}

/**
 * In-flight backups for the device page (#11027): what is running or queued
 * right now, with enough progress fields for the web to derive a phase, speed,
 * ETA and stall state.
 */
async function loadActiveBackupJobs(jobs: BackupJobRow[]): Promise<ActiveBackupJob[]> {
  const active = jobs.filter((j) => isInFlight(j.status)).sort(compareActiveJobs);
  if (active.length === 0) return [];

  const resumedByJob = await loadJobResumedAt(active.map((j) => j.id));

  return active.map((j) => ({
    id: j.id,
    status: j.status as ActiveBackupJob['status'],
    backupMode: j.backupMode ?? null,
    backupType: j.backupType ?? null,
    createdAt: j.createdAt.toISOString(),
    startedAt: j.startedAt?.toISOString() ?? null,
    totalSize: j.totalSize ?? null,
    transferredSize: j.transferredSize ?? null,
    fileCount: j.fileCount ?? null,
    totalFiles: j.totalFiles ?? null,
    lastProgressAt: j.lastProgressAt?.toISOString() ?? null,
    lastKeepaliveAt: j.lastKeepaliveAt?.toISOString() ?? null,
    resumedAt: resumedByJob.get(j.id)?.toISOString() ?? null,
  }));
}

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
  const lastFailureDetail = lastFailure ? classifyBackupFailureDetail(lastFailure) : null;

  const activeJobs = await loadActiveBackupJobs(jobs);

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
            ...failureFields(lastJob),
            dataAccounting: deriveBackupJobDataAccounting(lastJob),
          }
        : null,
      lastSuccessAt: lastSuccess?.completedAt?.toISOString() ?? null,
      lastFailureAt: lastFailure?.completedAt?.toISOString() ?? null,
      lastFailureError: lastFailure?.errorLog ?? null,
      lastFailureCategory: lastFailureDetail?.category ?? null,
      lastFailureCause: lastFailureDetail?.cause ?? null,
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
      activeJobs,
    },
  });
});
