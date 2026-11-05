/**
 * Software deployment reads shared by routes/software.ts and the AI software
 * tools: the strict parent site-scope predicate, the aggregate status
 * helpers, and the list / summary / get / results queries. Moved verbatim
 * from the GET /software/deployments* handlers so both callers run the same
 * code. `orgId` is always already resolved (resolveScopedOrgId) and the
 * caller runs inside its own request/auth DB context.
 */
import { and, eq, sql, desc, inArray, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  softwareDeployments,
  deploymentResults,
  devices,
  deviceCommands,
} from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { dateFromSqlValue } from './portal/sqlTimestamp';
import { deploymentResultRestorePointSql } from './restorePointInline';
import { canAccessSite, type UserPermissions } from './permissions';

/**
 * A software deployment is an indivisible parent: its target metadata and
 * aggregate status describe every child device. Restricted callers may see or
 * mutate it only when it has at least one result and every result still points
 * to a live device in one of their allowed sites.
 *
 * Applied by every deployment-parent route: list, summary, get-by-id, cancel,
 * retry and results. Uniformly, on purpose — a route that resolves the parent
 * without it is an existence oracle for the ones that do.
 *
 * The aliased subqueries name `deployment_id`, `device_id` and `site_id` as raw
 * SQL because Drizzle aliasing inside a `sql` template would not carry the
 * column mapping. They are the physical names declared in
 * `db/schema/software.ts:118-121` (`deployment_results.deployment_id`,
 * `.device_id`) and `db/schema/devices.ts` (`devices.site_id`); a rename there
 * must be mirrored here, and is caught by
 * `__tests__/integration/softwareDeploymentSiteScope.integration.test.ts`,
 * which runs this predicate against real Postgres.
 */
export function softwareDeploymentSiteScopePredicate(
  deploymentIdColumn: typeof softwareDeployments.id,
  permissions: UserPermissions | undefined,
): SQL | undefined {
  const allowedSiteIds = permissions?.allowedSiteIds;
  if (allowedSiteIds === undefined) return undefined;
  if (allowedSiteIds.length === 0) return sql`false`;

  const allowedSites = sql.join(allowedSiteIds.map((siteId) => sql`${siteId}::uuid`), sql`, `);
  return sql`
    EXISTS (
      SELECT 1 FROM ${deploymentResults} AS deployment_scope_result
      WHERE deployment_scope_result.deployment_id = ${deploymentIdColumn}
    )
    AND NOT EXISTS (
      SELECT 1
      FROM ${deploymentResults} AS deployment_scope_result
      LEFT JOIN ${devices} AS deployment_scope_device
        ON deployment_scope_device.id = deployment_scope_result.device_id
      WHERE deployment_scope_result.deployment_id = ${deploymentIdColumn}
        AND (
          deployment_scope_device.id IS NULL
          OR deployment_scope_device.site_id IS NULL
          OR deployment_scope_device.site_id NOT IN (${allowedSites})
        )
    )`;
}

export type SoftwareDeploymentAggregateStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled';

export function computeSoftwareDeploymentAggregateStatus(
  results: Array<{ status: string; count: number }>,
): SoftwareDeploymentAggregateStatus {
  const counts = new Map(results.map((result) => [result.status, Number(result.count)]));
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);

  if (total === 0) return 'pending';

  const pendingCount = counts.get('pending') ?? 0;
  const completedCount = counts.get('completed') ?? 0;
  const failedCount = counts.get('failed') ?? 0;
  const cancelledCount = counts.get('cancelled') ?? 0;
  const inProgressCount = (
    (counts.get('running') ?? 0) +
    (counts.get('paused') ?? 0) +
    (counts.get('downloading') ?? 0) +
    (counts.get('installing') ?? 0) +
    (counts.get('rollback') ?? 0)
  );

  if (inProgressCount > 0) return 'in_progress';
  if (failedCount > 0) {
    return completedCount > 0 ? 'completed_with_errors' : 'failed';
  }
  if (cancelledCount === total) return 'cancelled';
  if (completedCount === total) return 'completed';
  if (pendingCount === total) return 'pending';
  if (pendingCount > 0 && completedCount > 0) return 'in_progress';

  return 'in_progress';
}

/**
 * Per-status result counts for one deployment, folded into the five buckets
 * the UI progress bars care about (raw agent-side statuses like 'downloading'
 * and 'installing' land in `inProgress`). `total` is the device count.
 */
export interface SoftwareDeploymentStatusCounts {
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
}

export function emptyStatusCounts(): SoftwareDeploymentStatusCounts {
  return { pending: 0, inProgress: 0, completed: 0, failed: 0, cancelled: 0, total: 0 };
}

export function summarizeStatusCounts(
  groups: Array<{ status: string; count: number }>,
): SoftwareDeploymentStatusCounts {
  const counts = emptyStatusCounts();
  for (const { status, count } of groups) {
    const n = Number(count);
    counts.total += n;
    switch (status) {
      case 'pending':
      case 'draft':
        counts.pending += n;
        break;
      case 'completed':
        counts.completed += n;
        break;
      case 'failed':
        counts.failed += n;
        break;
      case 'cancelled':
        counts.cancelled += n;
        break;
      default:
        // running / paused / downloading / installing / rollback
        counts.inProgress += n;
    }
  }
  return counts;
}

export interface DeploymentStatusEntry {
  status: SoftwareDeploymentAggregateStatus;
  counts: SoftwareDeploymentStatusCounts;
}

export async function getDeploymentStatusMap(deploymentIds: string[]) {
  if (deploymentIds.length === 0) {
    return new Map<string, DeploymentStatusEntry>();
  }

  const rows = await db
    .select({
      deploymentId: deploymentResults.deploymentId,
      status: deploymentResults.status,
      count: sql<number>`count(*)::int`,
    })
    .from(deploymentResults)
    .where(inArray(deploymentResults.deploymentId, deploymentIds))
    .groupBy(deploymentResults.deploymentId, deploymentResults.status);

  const grouped = new Map<string, Array<{ status: string; count: number }>>();
  for (const row of rows) {
    const bucket = grouped.get(row.deploymentId) ?? [];
    bucket.push({ status: row.status, count: Number(row.count) });
    grouped.set(row.deploymentId, bucket);
  }

  const statusMap = new Map<string, DeploymentStatusEntry>();
  for (const deploymentId of deploymentIds) {
    const groups = grouped.get(deploymentId) ?? [];
    statusMap.set(deploymentId, {
      status: computeSoftwareDeploymentAggregateStatus(groups),
      counts: summarizeStatusCounts(groups),
    });
  }

  return statusMap;
}
// Known deployment_results statuses (deploymentStatusEnum minus 'draft', which
// results never take — they default to 'pending' at insert).
export const DEPLOYMENT_RESULT_STATUSES = [
  'pending',
  'running',
  'paused',
  'downloading',
  'installing',
  'completed',
  'failed',
  'cancelled',
  'rollback',
] as const;

export type DeploymentResultStatus = (typeof DEPLOYMENT_RESULT_STATUSES)[number];

/** Common inputs of the deployment reads: the caller and its resolved org. */
type DeploymentReadScope = {
  auth: AuthContext;
  permissions: UserPermissions | undefined;
  orgId: string;
};

/**
 * GET /deployments — one page of the org's deployments (strict parent site
 * scope), each enriched with its computed aggregate status and counts.
 *
 * NOTE on `status`: the deployment status is a *computed aggregate* over
 * grouped deployment_results (computeSoftwareDeploymentAggregateStatus),
 * so filtering on it in SQL would mean re-expressing that derivation as a
 * correlated subquery. Server-side aggregate filtering is intentionally
 * not implemented; the param stays accepted for backwards compatibility
 * but is ignored — clients filter the returned page on the computed
 * `status` field instead. (Previously the route fetched every org row,
 * filtered in JS and sliced — SQL pagination replaces that.)
 */
export async function listSoftwareDeployments(params: DeploymentReadScope & {
  status?: SoftwareDeploymentAggregateStatus;
  page: number;
  limit: number;
}) {
  const { permissions, orgId, page, limit } = params;
  const offset = (page - 1) * limit;

  const orgCondition = and(
    eq(softwareDeployments.orgId, orgId),
    softwareDeploymentSiteScopePredicate(
      softwareDeployments.id,
      permissions,
    ),
  );
  const [items, countRows] = await Promise.all([
    db.select().from(softwareDeployments)
      .where(orgCondition)
      .orderBy(desc(softwareDeployments.createdAt), desc(softwareDeployments.id))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`count(*)::int` })
      .from(softwareDeployments)
      .where(orgCondition),
  ]);

  const statusMap = await getDeploymentStatusMap(items.map((item) => item.id));
  const enrichedItems = items.map((item) => {
    const entry = statusMap.get(item.id);
    return {
      ...item,
      status: entry?.status ?? 'pending',
      counts: entry?.counts ?? emptyStatusCounts(),
    };
  });

  return {
    data: enrichedItems,
    pagination: { page, limit, total: Number(countRows[0]?.count ?? 0) }
  };
}

/**
 * GET /deployments/summary — aggregate counts for the overview cards.
 *
 * One grouped query: deployments LEFT JOIN results, grouped by
 * (deployment, result status). A deployment with no result rows still
 * appears (status NULL, count 0). The aggregate status per deployment is
 * then derived in JS with the same computeSoftwareDeploymentAggregateStatus
 * used everywhere else — no N+1, no per-deployment queries.
 */
export async function getSoftwareDeploymentSummary(params: DeploymentReadScope): Promise<{
  active: number;
  scheduled: number;
  completedLast7d: number;
  failedLast7d: number;
}> {
  const { permissions, orgId } = params;

  const rows = await db
    .select({
      deploymentId: softwareDeployments.id,
      dispatchedAt: softwareDeployments.dispatchedAt,
      createdAt: softwareDeployments.createdAt,
      status: deploymentResults.status,
      count: sql<number>`count(${deploymentResults.id})::int`,
      lastCompletedAt: sql<string | Date | null>`max(${deploymentResults.completedAt})`,
    })
    .from(softwareDeployments)
    .leftJoin(deploymentResults, eq(deploymentResults.deploymentId, softwareDeployments.id))
    .where(and(
      eq(softwareDeployments.orgId, orgId),
      softwareDeploymentSiteScopePredicate(
        softwareDeployments.id,
        permissions,
      ),
    ))
    .groupBy(
      softwareDeployments.id,
      softwareDeployments.dispatchedAt,
      softwareDeployments.createdAt,
      deploymentResults.status,
    );

  type SummaryAccumulator = {
    dispatchedAt: unknown;
    createdAt: unknown;
    groups: Array<{ status: string; count: number }>;
    /** epoch ms of max(deployment_results.completed_at); 0 = none */
    lastCompletedAt: number;
  };
  const byDeployment = new Map<string, SummaryAccumulator>();
  for (const row of rows) {
    let entry = byDeployment.get(row.deploymentId);
    if (!entry) {
      entry = { dispatchedAt: row.dispatchedAt, createdAt: row.createdAt, groups: [], lastCompletedAt: 0 };
      byDeployment.set(row.deploymentId, entry);
    }
    if (row.status != null) {
      entry.groups.push({ status: row.status, count: Number(row.count) });
    }
    if (row.lastCompletedAt) {
      const t = dateFromSqlValue(row.lastCompletedAt as string | Date).getTime();
      if (Number.isFinite(t) && t > entry.lastCompletedAt) entry.lastCompletedAt = t;
    }
  }

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let active = 0;
  let scheduled = 0;
  let completedLast7d = 0;
  let failedLast7d = 0;
  for (const entry of byDeployment.values()) {
    const aggregate = computeSoftwareDeploymentAggregateStatus(entry.groups);
    const terminal =
      aggregate === 'completed' ||
      aggregate === 'completed_with_errors' ||
      aggregate === 'failed' ||
      aggregate === 'cancelled';

    if (!entry.dispatchedAt) {
      // Awaiting the scheduler. A deployment cancelled before it ever
      // dispatched is terminal and must not count as "scheduled" forever.
      if (!terminal) scheduled++;
      continue;
    }
    if (!terminal) {
      // Dispatched with at least one pending/in-progress result.
      active++;
      continue;
    }
    // Terminal reference time: max(deployment_results.completed_at) is the
    // moment the last device finished — the cheapest correct "when did this
    // deployment end" already produced by the grouped query. Fallback to
    // createdAt for degenerate rows that never got a completed_at.
    const refTime = entry.lastCompletedAt
      || new Date(entry.createdAt as string | Date).getTime();
    if (refTime >= sevenDaysAgo) {
      if (aggregate === 'completed') completedLast7d++;
      else if (aggregate === 'failed' || aggregate === 'completed_with_errors') failedLast7d++;
      // 'cancelled' deliberately counts in neither 7d bucket.
    }
  }

  return { active, scheduled, completedLast7d, failedLast7d };
}

/**
 * Load one deployment parent under the strict site-scope predicate. Null when
 * it does not exist, belongs to another org, or is outside the caller's sites
 * — every deployment-parent route treats all three as 404.
 */
export async function loadScopedSoftwareDeployment(params: {
  permissions: UserPermissions | undefined;
  orgId: string;
  deploymentId: string;
}): Promise<typeof softwareDeployments.$inferSelect | null> {
  const { permissions, orgId, deploymentId: id } = params;
  const [deployment] = await db.select().from(softwareDeployments)
    .where(and(
      eq(softwareDeployments.id, id),
      eq(softwareDeployments.orgId, orgId),
      softwareDeploymentSiteScopePredicate(
        softwareDeployments.id,
        permissions,
      ),
    ));
  return deployment ?? null;
}

/**
 * GET /deployments/:id — the deployment with its computed aggregate status and
 * counts, or null when not found / out of scope.
 */
export async function getSoftwareDeployment(params: DeploymentReadScope & { deploymentId: string }) {
  const deployment = await loadScopedSoftwareDeployment(params);
  if (!deployment) return null;

  const statusMap = await getDeploymentStatusMap([deployment.id]);
  const entry = statusMap.get(deployment.id);

  return {
    ...deployment,
    status: entry?.status ?? 'pending',
    counts: entry?.counts ?? emptyStatusCounts(),
  };
}

/**
 * GET /deployments/:id/results — one page of per-device results (hostname,
 * restore point, queued-offline and in-flight signals), or null when the
 * parent is not found / out of scope.
 */
export async function listSoftwareDeploymentResults(params: DeploymentReadScope & {
  deploymentId: string;
  status?: DeploymentResultStatus;
  limit: number;
  offset: number;
}) {
  const { permissions, orgId, deploymentId: id, limit, offset } = params;

  // Strict parent, same as list/summary/get/cancel. The per-device result
  // narrowing below is not sufficient on its own: without this the parent
  // still resolves for a site-restricted caller, so a deployment that
  // `GET /deployments/:id` refuses to show is still confirmed to exist here
  // (returning 200 with an empty page) — an existence oracle around the
  // gate.
  const deployment = await loadScopedSoftwareDeployment(params);
  if (!deployment) return null;

  const conditions: SQL[] = [eq(deploymentResults.deploymentId, id)];
  if (params.status) {
    conditions.push(eq(deploymentResults.status, params.status));
  }
  // Site is an app-layer concept only — RLS doesn't defend it — so a
  // site-restricted caller must not see per-device results (hostname, exit
  // code, output) for devices in sites outside their allowlist (#864/#868).
  if (permissions?.allowedSiteIds) {
    const orgDevices = await db
      .select({ id: devices.id, siteId: devices.siteId })
      .from(devices)
      .where(eq(devices.orgId, orgId));
    const siteAllowedDeviceIds = orgDevices
      .filter((device) => typeof device.siteId === 'string' && canAccessSite(permissions, device.siteId))
      .map((device) => device.id);
    if (siteAllowedDeviceIds.length === 0) {
      return { data: [], total: 0 };
    }
    conditions.push(inArray(deploymentResults.deviceId, siteAllowedDeviceIds));
  }
  const whereClause = and(...conditions);

  // Single joined page query: devices for hostname (the UI must not render
  // UUIDs or N+1-fetch device names), device_commands for the derived
  // queuedOffline flag — a result still 'pending' whose offline-queued
  // command has not been claimed by the agent yet ("queued — device
  // offline", not a misleading in-progress spinner). COALESCE folds the
  // NULLs from the left joins (WS-dispatched rows have no linked command)
  // to false.
  const [results, countRows] = await Promise.all([
    db.select({
      id: deploymentResults.id,
      deploymentId: deploymentResults.deploymentId,
      deviceId: deploymentResults.deviceId,
      status: deploymentResults.status,
      startedAt: deploymentResults.startedAt,
      completedAt: deploymentResults.completedAt,
      exitCode: deploymentResults.exitCode,
      output: deploymentResults.output,
      errorMessage: deploymentResults.errorMessage,
      retryCount: deploymentResults.retryCount,
      deviceCommandId: deploymentResults.deviceCommandId,
      hostname: devices.hostname,
      // #4759 — newest System Restore ledger row for this device's install
      // (NULL when Breeze never asked). Drives the inline badge.
      restorePoint: deploymentResultRestorePointSql(deploymentResults.deploymentId, deploymentResults.deviceId),
      queuedOffline: sql<boolean>`coalesce(${deploymentResults.status} = 'pending' and ${deploymentResults.deviceCommandId} is not null and ${deviceCommands.status} = 'pending', false)`,
      // #3578 in-flight signals, read off the same join. sentAt is when the
      // command was handed to the agent (WS push or poll claim) — the
      // server's own stamp, so it works for every agent version. agentStage/
      // agentStageAt are the last stage the agent reported
      // (services/commandProgress.ts); NULL from agents that predate it.
      sentAt: deviceCommands.executedAt,
      agentStage: deviceCommands.progressStage,
      agentStageAt: deviceCommands.progressAt,
    })
      .from(deploymentResults)
      .leftJoin(devices, eq(deploymentResults.deviceId, devices.id))
      .leftJoin(deviceCommands, eq(deploymentResults.deviceCommandId, deviceCommands.id))
      .where(whereClause)
      .orderBy(devices.hostname, deploymentResults.deviceId, deploymentResults.id)
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`count(*)::int` })
      .from(deploymentResults)
      .where(whereClause),
  ]);

  return { data: results, total: Number(countRows[0]?.count ?? 0) };
}
