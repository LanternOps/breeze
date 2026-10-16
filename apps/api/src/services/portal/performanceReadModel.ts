import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { dateFromSqlValue } from './sqlTimestamp';

export const PORTAL_PERFORMANCE_RANGES = ['24h', '7d', '30d'] as const;
export type PortalPerformanceRange = (typeof PORTAL_PERFORMANCE_RANGES)[number];

const RANGE_CONFIG = {
  '24h': { milliseconds: 24 * 60 * 60 * 1000, bucketSeconds: 300 },
  '7d': { milliseconds: 7 * 24 * 60 * 60 * 1000, bucketSeconds: 3600 },
  '30d': { milliseconds: 30 * 24 * 60 * 60 * 1000, bucketSeconds: 3600 },
} as const satisfies Record<PortalPerformanceRange, { milliseconds: number; bucketSeconds: 300 | 3600 }>;

const PERFORMANCE_METRICS = [
  ['cpu_percent', 'cpuPercent'],
  ['ram_percent', 'ramPercent'],
  ['ram_used_mb', 'ramUsedMb'],
  ['disk_percent', 'diskPercent'],
  ['disk_used_gb', 'diskUsedGb'],
  ['disk_read_bps', 'diskReadBps'],
  ['disk_write_bps', 'diskWriteBps'],
  ['bandwidth_in_bps', 'bandwidthInBps'],
  ['bandwidth_out_bps', 'bandwidthOutBps'],
] as const;

type MetricName = (typeof PERFORMANCE_METRICS)[number][0];
type MetricKey = (typeof PERFORMANCE_METRICS)[number][1];

type RollupRow = {
  bucket_start: Date | string;
  metric_name: string;
  avg_value: number | string | null;
  max_value: number | string | null;
};

type VolumeRow = {
  day: Date | string;
  network_in_bytes: string | number | bigint | null;
  network_out_bytes: string | number | bigint | null;
};

type InterfaceRow = {
  bucket_start: Date | string;
  name: string;
  speed: number | string | null;
  in_bytes_per_sec: number | string | null;
  out_bytes_per_sec: number | string | null;
  in_errors: number | string | null;
  out_errors: number | string | null;
};

function numberOrNull(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function retentionDaysFromEnv(): number {
  const parsed = Number.parseInt(process.env.DEVICE_METRICS_RETENTION_DAYS ?? '', 10);
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  return Math.min(365, Math.max(1, value));
}

export function performanceRange(range: PortalPerformanceRange, now: Date) {
  const config = RANGE_CONFIG[range];
  const requestedFrom = new Date(now.getTime() - config.milliseconds);
  const retentionDays = retentionDaysFromEnv();
  const retentionFrom = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const coveredFrom = retentionFrom > requestedFrom ? retentionFrom : requestedFrom;
  return {
    bucketSeconds: config.bucketSeconds,
    requestedFrom,
    coveredFrom,
    rawCoverage: {
      complete: retentionFrom <= requestedFrom,
      retentionDays,
      requestedFrom: requestedFrom.toISOString(),
      coveredFrom: coveredFrom.toISOString(),
    },
  };
}

function metricNameSql() {
  return sql.join(PERFORMANCE_METRICS.map(([name]) => sql`${name}`), sql`, `);
}

async function rollups(
  orgId: string,
  range: PortalPerformanceRange,
  now: Date,
  deviceId?: string,
): Promise<RollupRow[]> {
  const cfg = performanceRange(range, now);
  const bucket = sql.raw(String(cfg.bucketSeconds));
  const deviceClause = deviceId ? sql`AND mr.device_id = ${deviceId}` : sql``;
  return [...await db.execute<RollupRow>(sql`
    SELECT
      mr.bucket_start,
      mr.metric_name,
      (
        sum(mr.avg_value * mr.sample_count)
        / nullif(sum(mr.sample_count), 0)
      )::double precision AS avg_value,
      max(mr.max_value)::double precision AS max_value
    FROM metric_rollups mr
    INNER JOIN devices d ON d.id = mr.device_id AND d.org_id = mr.org_id
    WHERE mr.org_id = ${orgId}
      ${deviceClause}
      AND d.org_id = ${orgId}
      AND d.is_ephemeral = false
      AND mr.source_table = 'device_metrics'
      AND mr.bucket_seconds = ${bucket}
      AND mr.metric_name IN (${metricNameSql()})
      AND mr.sample_count > 0
      AND mr.bucket_start >= ${cfg.requestedFrom.toISOString()}::timestamp
      AND mr.bucket_start < ${now.toISOString()}::timestamp
    GROUP BY mr.bucket_start, mr.metric_name
    ORDER BY mr.bucket_start, mr.metric_name
  `)];
}

async function dailyNetworkVolume(
  orgId: string,
  range: PortalPerformanceRange,
  now: Date,
  deviceId?: string,
): Promise<VolumeRow[]> {
  const cfg = performanceRange(range, now);
  const deviceClause = deviceId ? sql`AND dm.device_id = ${deviceId}` : sql``;
  return [...await db.execute<VolumeRow>(sql`
    SELECT
      date_bin(interval '1 day', dm.timestamp, timestamp 'epoch') AS day,
      coalesce(sum(dm.network_in_bytes), 0)::text AS network_in_bytes,
      coalesce(sum(dm.network_out_bytes), 0)::text AS network_out_bytes
    FROM device_metrics dm
    INNER JOIN devices d ON d.id = dm.device_id AND d.org_id = dm.org_id
    WHERE dm.org_id = ${orgId}
      ${deviceClause}
      AND d.org_id = ${orgId}
      AND d.is_ephemeral = false
      AND dm.timestamp >= ${cfg.coveredFrom.toISOString()}::timestamp
      AND dm.timestamp < ${now.toISOString()}::timestamp
    GROUP BY day
    ORDER BY day
  `)];
}

async function deviceInterfaceSeries(
  orgId: string,
  deviceId: string,
  range: PortalPerformanceRange,
  now: Date,
): Promise<InterfaceRow[]> {
  const cfg = performanceRange(range, now);
  const bucket = sql.raw(String(cfg.bucketSeconds));
  return [...await db.execute<InterfaceRow>(sql`
    WITH expanded AS (
      SELECT
        date_bin(make_interval(secs => ${bucket}), dm.timestamp, timestamp 'epoch') AS bucket_start,
        dm.timestamp,
        stat.value
      FROM device_metrics dm
      INNER JOIN devices d ON d.id = dm.device_id AND d.org_id = dm.org_id
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(dm.interface_stats) = 'array' THEN dm.interface_stats ELSE '[]'::jsonb END
      ) AS stat(value)
      WHERE dm.org_id = ${orgId}
        AND dm.device_id = ${deviceId}
        AND d.org_id = ${orgId}
        AND d.is_ephemeral = false
        AND dm.timestamp >= ${cfg.coveredFrom.toISOString()}::timestamp
        AND dm.timestamp < ${now.toISOString()}::timestamp
        AND jsonb_typeof(stat.value -> 'name') = 'string'
    ), ranked AS (
      SELECT
        bucket_start,
        value,
        row_number() OVER (
          PARTITION BY bucket_start, value ->> 'name'
          ORDER BY timestamp DESC
        ) AS rn
      FROM expanded
    )
    SELECT
      bucket_start,
      value ->> 'name' AS name,
      CASE WHEN jsonb_typeof(value -> 'speed') = 'number' THEN (value ->> 'speed')::double precision END AS speed,
      CASE WHEN jsonb_typeof(value -> 'inBytesPerSec') = 'number' THEN (value ->> 'inBytesPerSec')::double precision END AS in_bytes_per_sec,
      CASE WHEN jsonb_typeof(value -> 'outBytesPerSec') = 'number' THEN (value ->> 'outBytesPerSec')::double precision END AS out_bytes_per_sec,
      CASE WHEN jsonb_typeof(value -> 'inErrors') = 'number' THEN (value ->> 'inErrors')::double precision END AS in_errors,
      CASE WHEN jsonb_typeof(value -> 'outErrors') = 'number' THEN (value ->> 'outErrors')::double precision END AS out_errors
    FROM ranked
    WHERE rn = 1 AND nullif(value ->> 'name', '') IS NOT NULL
    ORDER BY bucket_start, name
  `)];
}

function emptyMetricPoint() {
  return Object.fromEntries(PERFORMANCE_METRICS.map(([, key]) => [key, { average: null, maximum: null }])) as Record<
    MetricKey,
    { average: number | null; maximum: number | null }
  >;
}

function buildSeries(rows: RollupRow[]) {
  const byBucket = new Map<string, ReturnType<typeof emptyMetricPoint>>();
  const keyByName = new Map<MetricName, MetricKey>(PERFORMANCE_METRICS);
  for (const row of rows) {
    const timestamp = dateFromSqlValue(row.bucket_start).toISOString();
    const metricKey = keyByName.get(row.metric_name as MetricName);
    if (!metricKey) continue;
    const metrics = byBucket.get(timestamp) ?? emptyMetricPoint();
    metrics[metricKey] = {
      average: numberOrNull(row.avg_value),
      maximum: numberOrNull(row.max_value),
    };
    byBucket.set(timestamp, metrics);
  }
  return [...byBucket.entries()].map(([timestamp, metrics]) => ({ timestamp, metrics }));
}

function buildVolumes(rows: VolumeRow[]) {
  return rows.map((row) => ({
    day: dateFromSqlValue(row.day).toISOString(),
    networkInBytes: Number(row.network_in_bytes ?? 0),
    networkOutBytes: Number(row.network_out_bytes ?? 0),
  }));
}

function buildInterfaces(rows: InterfaceRow[]) {
  const byBucket = new Map<string, Array<{
    name: string;
    speed: number | null;
    inBytesPerSec: number | null;
    outBytesPerSec: number | null;
    inErrors: number | null;
    outErrors: number | null;
  }>>();
  for (const row of rows) {
    const timestamp = dateFromSqlValue(row.bucket_start).toISOString();
    const interfaces = byBucket.get(timestamp) ?? [];
    interfaces.push({
      name: row.name,
      speed: numberOrNull(row.speed),
      inBytesPerSec: numberOrNull(row.in_bytes_per_sec),
      outBytesPerSec: numberOrNull(row.out_bytes_per_sec),
      inErrors: numberOrNull(row.in_errors),
      outErrors: numberOrNull(row.out_errors),
    });
    byBucket.set(timestamp, interfaces);
  }
  return [...byBucket.entries()].map(([timestamp, interfaces]) => ({ timestamp, interfaces }));
}

export async function performanceOverview(orgId: string, range: PortalPerformanceRange, now: Date) {
  const cfg = performanceRange(range, now);
  const [rollupRows, volumeRows] = await Promise.all([
    rollups(orgId, range, now),
    dailyNetworkVolume(orgId, range, now),
  ]);
  const series = buildSeries(rollupRows);
  const networkVolume = buildVolumes(volumeRows);
  return {
    asOf: now.toISOString(),
    range,
    bucketSeconds: cfg.bucketSeconds,
    dataStatus: series.length > 0 || networkVolume.length > 0 ? ('ok' as const) : ('no_data' as const),
    rawCoverage: cfg.rawCoverage,
    series,
    networkVolume,
  };
}

export async function performanceDeviceSeries(
  orgId: string,
  deviceId: string,
  range: PortalPerformanceRange,
  now: Date,
) {
  const deviceRows = await db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      displayName: devices.displayName,
      osType: devices.osType,
    })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId), eq(devices.isEphemeral, false)))
    .limit(1);
  const device = deviceRows[0];
  if (!device) return null;

  const cfg = performanceRange(range, now);
  const [rollupRows, volumeRows, interfaceRows] = await Promise.all([
    rollups(orgId, range, now, deviceId),
    dailyNetworkVolume(orgId, range, now, deviceId),
    deviceInterfaceSeries(orgId, deviceId, range, now),
  ]);
  const series = buildSeries(rollupRows);
  const networkVolume = buildVolumes(volumeRows);
  const interfaces = buildInterfaces(interfaceRows);

  return {
    asOf: now.toISOString(),
    range,
    bucketSeconds: cfg.bucketSeconds,
    dataStatus: series.length > 0 || networkVolume.length > 0 || interfaces.length > 0 ? ('ok' as const) : ('no_data' as const),
    rawCoverage: cfg.rawCoverage,
    device,
    series,
    networkVolume,
    interfaces,
  };
}
