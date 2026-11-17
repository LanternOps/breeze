/**
 * `service_checks` for `export_dataset` (Wisp analysis sessions W04): the
 * service/process watch results that were NOT running. The table is one row per
 * watch per tick (a planner estimate of tens of millions of rows), and the
 * running rows are the bulk of it, so v1 exports only the problem rows, served
 * by the partial index `spc_results_org_problem_ts_idx`. The `.from(...)` stays
 * inline in `createServiceChecksPager` so the scope contract scans credit it to
 * the function that calls `exportDeviceSet`.
 */
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../../db';
import { serviceProcessCheckResults } from '../../db/schema';
import {
  deviceIdIn,
  emptyExportPager,
  exportDeviceSet,
  exportText,
  keysetBefore,
  keysetPager,
  noteOn,
  runExportQuery,
  timeRangeFromFilters,
} from '../aiToolsExportShared';
import type { DatasetAdapter, DatasetRequest } from '../aiToolsExportDatasets';

const NOT_RUNNING_NOTE =
  'service_checks lists checks that were not running (stopped, not_found, error); running checks are not exported.';

async function createServiceChecksPager(req: DatasetRequest) {
  const { start, end } = timeRangeFromFilters(req.filters);
  const scope = await exportDeviceSet(req);
  noteOn(req, NOT_RUNNING_NOTE);
  if (scope.deviceIds.length === 0) return emptyExportPager;

  return keysetPager({
    pageSize: req.pageSize,
    shape: ['timestamp', 'uuid'],
    fetch: async (after, limit) => {
      const t = serviceProcessCheckResults;
      return await runExportQuery(
        db
          .select({
            id: t.id,
            deviceId: t.deviceId,
            timestamp: t.timestamp,
            // The keyset key: full microsecond precision, never a JS Date.
            timestampText: sql<string>`${t.timestamp}::text`,
            watchType: t.watchType,
            name: t.name,
            status: t.status,
            cpuPercent: t.cpuPercent,
            memoryMb: t.memoryMb,
            pid: t.pid,
            autoRestartAttempted: t.autoRestartAttempted,
            autoRestartSucceeded: t.autoRestartSucceeded,
          })
          .from(serviceProcessCheckResults)
          .where(and(
            eq(t.orgId, req.orgId),
            deviceIdIn(t.deviceId, scope.deviceIds),
            // A SQL literal, not a bound parameter: the planner can only prove
            // the partial index predicate from the literal.
            sql`${t.status} <> 'running'`,
            gte(t.timestamp, start),
            lte(t.timestamp, end),
            keysetBefore(t.timestamp, t.id, after, 'timestamp'),
          ))
          .orderBy(desc(t.timestamp), desc(t.id))
          .limit(limit),
      );
    },
    keyOf: (row) => [row.timestampText, row.id],
    toRows: (rows) => rows.map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      hostname: scope.hostnames.get(row.deviceId) ?? null,
      timestamp: row.timestamp.toISOString(),
      watchType: row.watchType,
      name: exportText(row.name),
      status: row.status,
      cpuPercent: row.cpuPercent,
      memoryMb: row.memoryMb,
      pid: row.pid,
      autoRestartAttempted: row.autoRestartAttempted,
      autoRestartSucceeded: row.autoRestartSucceeded,
    })),
  });
}

export const serviceChecksAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: false,
  createPager: createServiceChecksPager,
};
