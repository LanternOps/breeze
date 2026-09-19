import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { automationRunDeviceResults, automationRuns, devices } from '../db/schema';

type AutomationRun = typeof automationRuns.$inferSelect;
type DeviceResultStatus = typeof automationRunDeviceResults.$inferSelect.status;

type VisibleRunDevice = {
  runId: string;
  deviceId: string;
  status: DeviceResultStatus;
  startedAt: Date | null;
  completedAt: Date | null;
};

const RUN_PROJECTION_BATCH_SIZE = 250;

function restrictedRunStatus(rows: readonly VisibleRunDevice[]): AutomationRun['status'] {
  if (rows.some((row) => row.status === 'pending' || row.status === 'running')) return 'running';
  const failed = rows.filter((row) => row.status === 'failed').length;
  const succeeded = rows.filter((row) => row.status === 'success').length;
  const cancelled = rows.filter((row) => row.status === 'cancelled').length;
  if (failed > 0 && succeeded > 0) return 'partial';
  if (failed > 0) return 'failed';
  if (cancelled > 0) return 'cancelled';
  return 'completed';
}

function visibleLogs(logs: unknown, visibleDeviceIds: ReadonlySet<string>): unknown[] {
  if (!Array.isArray(logs)) return [];
  return logs.filter((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const deviceId = (entry as Record<string, unknown>).deviceId;
    return typeof deviceId === 'string' && visibleDeviceIds.has(deviceId);
  });
}

/**
 * Project run history onto the caller's current site grant. Run counters and
 * JSON logs are org-wide snapshots, so restricted readers may only receive
 * values recomputed from currently visible per-device rows. A run with no
 * visible child is omitted rather than becoming an existence oracle.
 */
export async function projectAutomationRunsToSites<T extends AutomationRun>(
  runs: readonly T[],
  allowedSiteIds: readonly string[] | undefined,
): Promise<T[]> {
  if (allowedSiteIds === undefined || runs.length === 0) return [...runs];

  const rows: VisibleRunDevice[] = [];
  for (let start = 0; start < runs.length; start += RUN_PROJECTION_BATCH_SIZE) {
    const runIds = runs.slice(start, start + RUN_PROJECTION_BATCH_SIZE).map((run) => run.id);
    rows.push(...await db
      .select({
        runId: automationRunDeviceResults.runId,
        deviceId: automationRunDeviceResults.deviceId,
        status: automationRunDeviceResults.status,
        startedAt: automationRunDeviceResults.startedAt,
        completedAt: automationRunDeviceResults.completedAt,
      })
      .from(automationRunDeviceResults)
      .innerJoin(devices, eq(devices.id, automationRunDeviceResults.deviceId))
      .where(and(
        inArray(automationRunDeviceResults.runId, runIds),
        inArray(devices.siteId, [...allowedSiteIds]),
      )));
  }

  const byRun = new Map<string, VisibleRunDevice[]>();
  for (const row of rows) {
    const list = byRun.get(row.runId) ?? [];
    list.push(row);
    byRun.set(row.runId, list);
  }

  return runs.flatMap((run) => {
    const visible = byRun.get(run.id);
    if (!visible?.length) return [];
    const deviceIds = new Set(visible.map((row) => row.deviceId));
    const status = restrictedRunStatus(visible);
    const started = visible.flatMap((row) => row.startedAt ? [row.startedAt.getTime()] : []);
    const completed = visible.flatMap((row) => row.completedAt ? [row.completedAt.getTime()] : []);
    return [{
      ...run,
      status,
      devicesTargeted: visible.length,
      devicesSucceeded: visible.filter((row) => row.status === 'success').length,
      devicesFailed: visible.filter((row) => row.status === 'failed').length,
      devicesCancelled: visible.filter((row) => row.status === 'cancelled').length,
      // Run-level timing is an org-wide aggregate. A restricted projection starts
      // at its first visible child and completes at its last visible child. Missing
      // terminal timestamps (or any live child) remain null rather than borrowing
      // timing from a hidden sibling.
      startedAt: started.length > 0 ? new Date(Math.min(...started)) : null,
      completedAt: status === 'running' || completed.length !== visible.length
        ? null
        : new Date(Math.max(...completed)),
      logs: visibleLogs(run.logs, deviceIds),
    }];
  });
}

export type ProjectedRunScan = {
  rows: AutomationRun[];
  total: number;
  statusCounts: Record<'completed' | 'failed' | 'partial', number>;
};

/**
 * Scan one automation's runs in fixed-size pages and retain only the requested
 * visible page. This preserves exact restricted totals without materializing an
 * unbounded run history or constructing an unbounded SQL `IN` predicate.
 */
export async function scanProjectedAutomationRuns(input: {
  automationId: string;
  allowedSiteIds: readonly string[];
  offset?: number;
  limit: number;
  status?: AutomationRun['status'];
}): Promise<ProjectedRunScan> {
  const wantedOffset = input.offset ?? 0;
  const rows: AutomationRun[] = [];
  const statusCounts = { completed: 0, failed: 0, partial: 0 };
  let total = 0;
  let databaseOffset = 0;

  while (true) {
    const batch = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.automationId, input.automationId))
      .orderBy(desc(automationRuns.startedAt), desc(automationRuns.id))
      .limit(RUN_PROJECTION_BATCH_SIZE)
      .offset(databaseOffset);
    if (batch.length === 0) break;

    const projected = await projectAutomationRunsToSites(batch, input.allowedSiteIds);
    for (const run of projected) {
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'partial') {
        statusCounts[run.status] += 1;
      }
      if (input.status && run.status !== input.status) continue;
      if (total >= wantedOffset && rows.length < input.limit) rows.push(run);
      total += 1;
    }

    databaseOffset += batch.length;
    if (batch.length < RUN_PROJECTION_BATCH_SIZE) break;
  }

  return { rows, total, statusCounts };
}
