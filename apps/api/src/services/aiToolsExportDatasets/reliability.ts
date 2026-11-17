/**
 * Reliability datasets for `export_dataset` (Wisp analysis sessions W04):
 * `reliability_scores`, `reliability_history`, `reliability_events`.
 *
 * Each adapter resolves the run's frozen device set once, then pages one keyset
 * query per call. The `.from(<table>)` of every query sits lexically inside its
 * `create<X>Pager` (an inline arrow passed to `keysetPager`), because the
 * site/device-scope contract scans credit a table read only to the named
 * function that also calls `exportDeviceSet`. Do not extract the query.
 */
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../../db';
import { deviceReliabilityHistory } from '../../db/schema';
import { reliabilityExportPageQuery } from '../reliabilityScoring';
import {
  deviceIdIn,
  emptyExportPager,
  exportDeviceSet,
  keysetBefore,
  keysetPager,
  noteOn,
  runExportQuery,
  timeRangeFromFilters,
} from '../aiToolsExportShared';
import type { DatasetAdapter, DatasetRequest } from '../aiToolsExportDatasets';

async function createReliabilityScoresPager(req: DatasetRequest) {
  // Validate a supplied range first so a bad one fails before any query, even
  // though a snapshot has no time axis to apply it to.
  timeRangeFromFilters(req.filters);
  const scope = await exportDeviceSet(req);
  if (req.filters.timeRange !== undefined && req.filters.timeRange !== null) {
    noteOn(req, 'reliability_scores is current state; timeRange was not applied.');
  }
  if (scope.deviceIds.length === 0) return emptyExportPager;

  return keysetPager({
    pageSize: req.pageSize,
    shape: ['uuid'],
    // `reliabilityExportPageQuery` reuses `reliabilityListWhere`, which carries
    // the org and exact-device narrowing; the device set rides in as
    // `filter.deviceIds` (at most a frame: 5000 rows, 11 pages).
    fetch: async (after, limit) => await runExportQuery(
      reliabilityExportPageQuery({ orgId: req.orgId, deviceIds: scope.deviceIds }, after?.[0] ?? null, limit),
    ),
    keyOf: (row) => [row.deviceId],
    toRows: (rows) => rows.map((row) => ({
      deviceId: row.deviceId,
      hostname: scope.hostnames.get(row.deviceId) ?? null,
      siteId: row.siteId,
      osType: row.osType,
      status: row.status,
      computedAt: row.computedAt.toISOString(),
      reliabilityScore: row.reliabilityScore,
      uptimeScore: row.uptimeScore,
      crashScore: row.crashScore,
      hangScore: row.hangScore,
      serviceFailureScore: row.serviceFailureScore,
      hardwareErrorScore: row.hardwareErrorScore,
      uptime7d: row.uptime7d,
      uptime30d: row.uptime30d,
      uptime90d: row.uptime90d,
      crashCount7d: row.crashCount7d,
      crashCount30d: row.crashCount30d,
      crashCount90d: row.crashCount90d,
      hangCount7d: row.hangCount7d,
      hangCount30d: row.hangCount30d,
      hangCount90d: row.hangCount90d,
      serviceFailureCount7d: row.serviceFailureCount7d,
      serviceFailureCount30d: row.serviceFailureCount30d,
      hardwareErrorCount7d: row.hardwareErrorCount7d,
      hardwareErrorCount30d: row.hardwareErrorCount30d,
      mtbfHours: row.mtbfHours,
      trendDirection: row.trendDirection,
      trendConfidence: row.trendConfidence,
      provisional: Boolean(row.provisional),
      topIssues: Array.isArray(row.topIssues) ? row.topIssues : [],
    })),
  });
}

export const reliabilityScoresAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: false,
  createPager: createReliabilityScoresPager,
};

async function createReliabilityHistoryPager(req: DatasetRequest) {
  const { start, end } = timeRangeFromFilters(req.filters);
  const scope = await exportDeviceSet(req);
  if (scope.deviceIds.length === 0) return emptyExportPager;

  return keysetPager({
    pageSize: req.pageSize,
    shape: ['timestamp', 'uuid'],
    fetch: async (after, limit) => {
      const t = deviceReliabilityHistory;
      // A bare `jsonb_array_length` raises on a non-array: a malformed row
      // counts 0 instead of failing the page.
      const count = (col: typeof t.crashEvents) =>
        sql<number>`CASE WHEN jsonb_typeof(${col}) = 'array' THEN jsonb_array_length(${col}) ELSE 0 END`;
      return await runExportQuery(
        db
          .select({
            id: t.id,
            deviceId: t.deviceId,
            collectedAt: t.collectedAt,
            // The keyset key: full microsecond precision, never a JS Date.
            collectedAtText: sql<string>`${t.collectedAt}::text`,
            bootTime: t.bootTime,
            uptimeSeconds: t.uptimeSeconds,
            crashCount: count(t.crashEvents),
            appHangCount: count(t.appHangs),
            serviceFailureCount: count(t.serviceFailures),
            hardwareErrorCount: count(t.hardwareErrors),
          })
          .from(deviceReliabilityHistory)
          .where(and(
            eq(t.orgId, req.orgId),
            deviceIdIn(t.deviceId, scope.deviceIds),
            gte(t.collectedAt, start),
            lte(t.collectedAt, end),
            keysetBefore(t.collectedAt, t.id, after, 'timestamp'),
          ))
          .orderBy(desc(t.collectedAt), desc(t.id))
          .limit(limit),
      );
    },
    keyOf: (row) => [row.collectedAtText, row.id],
    toRows: (rows) => rows.map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      hostname: scope.hostnames.get(row.deviceId) ?? null,
      collectedAt: row.collectedAt.toISOString(),
      bootTime: row.bootTime.toISOString(),
      uptimeSeconds: row.uptimeSeconds,
      crashCount: Number(row.crashCount),
      appHangCount: Number(row.appHangCount),
      serviceFailureCount: Number(row.serviceFailureCount),
      hardwareErrorCount: Number(row.hardwareErrorCount),
    })),
  });
}

export const reliabilityHistoryAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: false,
  createPager: createReliabilityHistoryPager,
};
