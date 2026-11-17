/**
 * `boot_performance` for `export_dataset` (Wisp analysis sessions W04): one row
 * per recorded boot, with the startup items kept as a (redacted, bounded) JSON
 * array. The `.from(deviceBootMetrics)` stays inline in `createBootPerformancePager`
 * so the scope contract scans credit it to the function that calls `exportDeviceSet`.
 */
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../../db';
import { deviceBootMetrics } from '../../db/schema';
import { STARTUP_ITEM_TYPES } from '../startupItems';
import {
  deviceIdIn,
  emptyExportPager,
  exportDeviceSet,
  exportEnum,
  exportKey,
  exportText,
  keysetBefore,
  keysetPager,
  runExportQuery,
  timeRangeFromFilters,
} from '../aiToolsExportShared';
import type { DatasetAdapter, DatasetRequest } from '../aiToolsExportDatasets';

/** A whole list is far over the 2000-character cell cap and cutting it would
 *  leave invalid JSON, so the cap is on the item count instead. */
const STARTUP_ITEM_LIMIT = 100;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const asBoolean = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

function startupItemsForExport(orgId: string, value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const items = value.filter(isRecord);
  const impact = (item: Record<string, unknown>) => asNumber(item.impactScore) ?? Number.NEGATIVE_INFINITY;
  return items
    .map((item, index) => ({ item, index }))
    // Highest impact first; ties keep the agent's own order.
    .sort((a, b) => impact(b.item) - impact(a.item) || a.index - b.index)
    .slice(0, STARTUP_ITEM_LIMIT)
    .map(({ item }) => ({
      // The server builds `itemId` as `type|path`, lowercased with forward
      // slashes (computeStartupItemId), so it carries the item's path; it is
      // exported only as a stable hash. `name` falls back to the path at ingest.
      itemKey: exportKey(orgId, item.itemId),
      name: exportText(item.name, { paths: true }),
      type: exportEnum(item.type, STARTUP_ITEM_TYPES),
      path: exportText(item.path, { paths: true }),
      enabled: asBoolean(item.enabled),
      cpuTimeMs: asNumber(item.cpuTimeMs),
      diskIoBytes: asNumber(item.diskIoBytes),
      impactScore: asNumber(item.impactScore),
    }));
}

async function createBootPerformancePager(req: DatasetRequest) {
  const { start, end } = timeRangeFromFilters(req.filters);
  const scope = await exportDeviceSet(req);
  if (scope.deviceIds.length === 0) return emptyExportPager;

  return keysetPager({
    pageSize: req.pageSize,
    shape: ['timestamp', 'uuid'],
    fetch: async (after, limit) => {
      const t = deviceBootMetrics;
      return await runExportQuery(
        db
          .select({
            id: t.id,
            deviceId: t.deviceId,
            bootTimestamp: t.bootTimestamp,
            // The keyset key: full microsecond precision, never a JS Date.
            bootTimestampText: sql<string>`${t.bootTimestamp}::text`,
            biosSeconds: t.biosSeconds,
            osLoaderSeconds: t.osLoaderSeconds,
            desktopReadySeconds: t.desktopReadySeconds,
            totalBootSeconds: t.totalBootSeconds,
            startupItemCount: t.startupItemCount,
            startupItems: t.startupItems,
          })
          .from(deviceBootMetrics)
          .where(and(
            eq(t.orgId, req.orgId),
            deviceIdIn(t.deviceId, scope.deviceIds),
            gte(t.bootTimestamp, start),
            lte(t.bootTimestamp, end),
            keysetBefore(t.bootTimestamp, t.id, after, 'timestamp'),
          ))
          .orderBy(desc(t.bootTimestamp), desc(t.id))
          .limit(limit),
      );
    },
    keyOf: (row) => [row.bootTimestampText, row.id],
    toRows: (rows) => rows.map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      hostname: scope.hostnames.get(row.deviceId) ?? null,
      bootTimestamp: row.bootTimestamp.toISOString(),
      biosSeconds: row.biosSeconds,
      osLoaderSeconds: row.osLoaderSeconds,
      desktopReadySeconds: row.desktopReadySeconds,
      totalBootSeconds: row.totalBootSeconds,
      startupItemCount: row.startupItemCount,
      startupItems: startupItemsForExport(req.orgId, row.startupItems),
    })),
  });
}

export const bootPerformanceAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: false,
  createPager: createBootPerformancePager,
};
