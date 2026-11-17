/**
 * `metrics` for `export_dataset`, set-based (Wisp analysis sessions W05
 * carry-over). Replaces the per-device adapter that verified each device and
 * paged each one's samples separately (about 4 queries per device per day of
 * minute samples).
 *
 * One `exportDeviceSet` call, then one keyset page per call over
 * `device_metrics` in primary-key order, `(device_id, timestamp)` ascending:
 * the key is unique (it is the primary key) and the device set binds as one
 * `uuid[]` parameter, so the page query is a range scan of that index.
 *
 * The filter contract is unchanged: `filters.hoursBack`, 1 to 168, default 24.
 * Rows now come device by device, oldest sample first. The columns are the
 * same, all numeric.
 */
import { and, asc, eq, gt, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { deviceMetrics } from '../../db/schema';
import {
  deviceIdIn,
  emptyExportPager,
  exportDeviceSet,
  keysetPager,
  runExportQuery,
} from '../aiToolsExportShared';
import type { DatasetAdapter, DatasetRequest } from '../aiToolsExportDatasets';
import { withRequestedDevicesAsFrame } from './legacyFrame';

const HOUR_MS = 3_600_000;

/** `(device, ts) > (d, t)`: the next page after the last emitted sample. */
function afterDeviceSample(deviceCol: AnyColumn, tsCol: AnyColumn, after: string[] | null): SQL | undefined {
  if (!after) return undefined;
  const [d, t] = after;
  return sql`(${deviceCol}, ${tsCol}) > (${d}::uuid, ${t}::timestamp)`;
}

async function createMetricsPager(req: DatasetRequest) {
  const hoursBack = Math.min(Math.max(1, Number(req.filters.hoursBack) || 24), 168);
  const since = new Date(Date.now() - hoursBack * HOUR_MS);
  const scope = await exportDeviceSet(withRequestedDevicesAsFrame(req));
  if (scope.deviceIds.length === 0) return emptyExportPager;

  return keysetPager({
    pageSize: req.pageSize,
    shape: ['uuid', 'timestamp'],
    fetch: async (after, limit) => {
      const m = deviceMetrics;
      return await runExportQuery(
        db
          .select({
            deviceId: m.deviceId,
            timestamp: m.timestamp,
            // The keyset key: full microsecond precision, never a JS Date.
            timestampText: sql<string>`${m.timestamp}::text`,
            cpuPercent: m.cpuPercent,
            ramPercent: m.ramPercent,
            ramUsedMb: m.ramUsedMb,
            diskPercent: m.diskPercent,
            diskUsedGb: m.diskUsedGb,
          })
          .from(deviceMetrics)
          .where(and(
            eq(m.orgId, req.orgId),
            deviceIdIn(m.deviceId, scope.deviceIds),
            gt(m.timestamp, since),
            afterDeviceSample(m.deviceId, m.timestamp, after),
          ))
          .orderBy(asc(m.deviceId), asc(m.timestamp))
          .limit(limit),
      );
    },
    keyOf: (row) => [row.deviceId, row.timestampText],
    toRows: (rows) => rows.map((row) => ({
      deviceId: row.deviceId,
      hostname: scope.hostnames.get(row.deviceId) ?? null,
      timestamp: row.timestamp.toISOString(),
      cpuPercent: row.cpuPercent,
      ramPercent: row.ramPercent,
      ramUsedMb: row.ramUsedMb,
      diskPercent: row.diskPercent,
      diskUsedGb: row.diskUsedGb,
    })),
  });
}

export const metricsAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: false,
  createPager: createMetricsPager,
};
