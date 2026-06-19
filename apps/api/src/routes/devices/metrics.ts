import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, gte, inArray, lte, sql, asc } from 'drizzle-orm';
import { db } from '../../db';
import { deviceMetrics, metricRollups, sites } from '../../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { metricsQuerySchema } from './schemas';

export const metricsRoutes = new Hono();

metricsRoutes.use('*', authMiddleware);

type DeviceMetricBucket = {
  bucket: Date;
  avgCpuPercent: number;
  avgRamPercent: number;
  avgRamUsedMb: number;
  avgDiskPercent: number;
  avgDiskUsedGb: number;
  diskActivityAvailable: boolean;
  totalDiskReadBytes: bigint;
  totalDiskWriteBytes: bigint;
  avgDiskReadBps: number;
  avgDiskWriteBps: number;
  totalDiskReadOps: bigint;
  totalDiskWriteOps: bigint;
  totalNetworkIn: bigint;
  totalNetworkOut: bigint;
  avgBandwidthIn: number;
  avgBandwidthOut: number;
  avgProcessCount: number;
};

const ROLLUP_METRIC_NAMES = [
  'cpu_percent',
  'ram_percent',
  'ram_used_mb',
  'disk_percent',
  'disk_used_gb',
  'disk_read_bps',
  'disk_write_bps',
  'bandwidth_in_bps',
  'bandwidth_out_bps',
  'process_count',
] as const;

function rollupWeightedAvg(metricName: (typeof ROLLUP_METRIC_NAMES)[number]) {
  return sql<number>`
    sum(${metricRollups.avgValue} * ${metricRollups.sampleCount})
      filter (where ${metricRollups.metricName} = ${metricName})
    / nullif(
      sum(${metricRollups.sampleCount})
        filter (where ${metricRollups.metricName} = ${metricName}),
      0
    )
  `;
}

function rollupBucketSeconds(interval: '1m' | '5m' | '1h' | '1d'): 3600 | 86400 | undefined {
  if (interval === '1h') return 3600;
  if (interval === '1d') return 86400;
  return undefined;
}

async function queryMetricRollups(
  orgId: string,
  deviceId: string,
  startDate: Date,
  endDate: Date,
  interval: '1m' | '5m' | '1h' | '1d'
): Promise<DeviceMetricBucket[]> {
  const bucketSeconds = rollupBucketSeconds(interval);
  if (!bucketSeconds) return [];

  return db
    .select({
      bucket: metricRollups.bucketStart,
      avgCpuPercent: rollupWeightedAvg('cpu_percent'),
      avgRamPercent: rollupWeightedAvg('ram_percent'),
      avgRamUsedMb: rollupWeightedAvg('ram_used_mb'),
      avgDiskPercent: rollupWeightedAvg('disk_percent'),
      avgDiskUsedGb: rollupWeightedAvg('disk_used_gb'),
      diskActivityAvailable: sql<boolean>`
        coalesce(
          sum(${metricRollups.sampleCount})
            filter (where ${metricRollups.metricName} in ('disk_read_bps', 'disk_write_bps')),
          0
        ) > 0
      `,
      totalDiskReadBytes: sql<bigint>`0::bigint`,
      totalDiskWriteBytes: sql<bigint>`0::bigint`,
      avgDiskReadBps: rollupWeightedAvg('disk_read_bps'),
      avgDiskWriteBps: rollupWeightedAvg('disk_write_bps'),
      totalDiskReadOps: sql<bigint>`0::bigint`,
      totalDiskWriteOps: sql<bigint>`0::bigint`,
      totalNetworkIn: sql<bigint>`0::bigint`,
      totalNetworkOut: sql<bigint>`0::bigint`,
      avgBandwidthIn: rollupWeightedAvg('bandwidth_in_bps'),
      avgBandwidthOut: rollupWeightedAvg('bandwidth_out_bps'),
      avgProcessCount: rollupWeightedAvg('process_count'),
    })
    .from(metricRollups)
    .where(
      and(
        eq(metricRollups.orgId, orgId),
        eq(metricRollups.deviceId, deviceId),
        eq(metricRollups.sourceTable, 'device_metrics'),
        eq(metricRollups.bucketSeconds, bucketSeconds),
        inArray(metricRollups.metricName, [...ROLLUP_METRIC_NAMES]),
        sql`${metricRollups.sampleCount} > 0`,
        gte(metricRollups.bucketStart, startDate),
        lte(metricRollups.bucketStart, endDate)
      )
    )
    .groupBy(metricRollups.bucketStart)
    .orderBy(asc(metricRollups.bucketStart));
}

async function queryRawMetricBuckets(
  deviceId: string,
  startDate: Date,
  endDate: Date
): Promise<DeviceMetricBucket[]> {
  return db
    .select({
      bucket: sql<Date>`date_trunc('minute', ${deviceMetrics.timestamp})`,
      avgCpuPercent: sql<number>`avg(${deviceMetrics.cpuPercent})`,
      avgRamPercent: sql<number>`avg(${deviceMetrics.ramPercent})`,
      avgRamUsedMb: sql<number>`avg(${deviceMetrics.ramUsedMb})`,
      avgDiskPercent: sql<number>`avg(${deviceMetrics.diskPercent})`,
      avgDiskUsedGb: sql<number>`avg(${deviceMetrics.diskUsedGb})`,
      diskActivityAvailable: sql<boolean>`bool_or(coalesce(${deviceMetrics.diskActivityAvailable}, false))`,
      totalDiskReadBytes: sql<bigint>`sum(${deviceMetrics.diskReadBytes})`,
      totalDiskWriteBytes: sql<bigint>`sum(${deviceMetrics.diskWriteBytes})`,
      avgDiskReadBps: sql<number>`avg(${deviceMetrics.diskReadBps})::float8`,
      avgDiskWriteBps: sql<number>`avg(${deviceMetrics.diskWriteBps})::float8`,
      totalDiskReadOps: sql<bigint>`sum(${deviceMetrics.diskReadOps})`,
      totalDiskWriteOps: sql<bigint>`sum(${deviceMetrics.diskWriteOps})`,
      totalNetworkIn: sql<bigint>`sum(${deviceMetrics.networkInBytes})`,
      totalNetworkOut: sql<bigint>`sum(${deviceMetrics.networkOutBytes})`,
      avgBandwidthIn: sql<number>`avg(${deviceMetrics.bandwidthInBps})::float8`,
      avgBandwidthOut: sql<number>`avg(${deviceMetrics.bandwidthOutBps})::float8`,
      avgProcessCount: sql<number>`avg(${deviceMetrics.processCount})`
    })
    .from(deviceMetrics)
    .where(
      and(
        eq(deviceMetrics.deviceId, deviceId),
        gte(deviceMetrics.timestamp, startDate),
        lte(deviceMetrics.timestamp, endDate)
      )
    )
    .groupBy(sql`date_trunc('minute', ${deviceMetrics.timestamp})`)
    .orderBy(asc(sql`date_trunc('minute', ${deviceMetrics.timestamp})`));
}

// Helper function to aggregate metrics by interval
function aggregateMetricsByInterval(
  data: DeviceMetricBucket[],
  interval: string,
  bucketSeconds: number
): Array<{
  timestamp: string;
  cpu: number;
  ram: number;
  ramUsedMb: number;
  disk: number;
  diskUsedGb: number;
  diskActivityAvailable: boolean;
  diskReadBytes: number;
  diskWriteBytes: number;
  diskReadBps: number;
  diskWriteBps: number;
  diskReadOps: number;
  diskWriteOps: number;
  networkIn: number;
  networkOut: number;
  bandwidthInBps: number;
  bandwidthOutBps: number;
  processCount: number;
}> {
  if (data.length === 0) return [];

  // For 1m interval, return data as-is
  if (interval === '1m') {
    return data.map(d => ({
      timestamp: new Date(d.bucket).toISOString(),
      cpu: Number(d.avgCpuPercent?.toFixed(2) ?? 0),
      ram: Number(d.avgRamPercent?.toFixed(2) ?? 0),
      ramUsedMb: Math.round(d.avgRamUsedMb ?? 0),
      disk: Number(d.avgDiskPercent?.toFixed(2) ?? 0),
      diskUsedGb: Number(d.avgDiskUsedGb?.toFixed(2) ?? 0),
      diskActivityAvailable: Boolean(d.diskActivityAvailable),
      diskReadBytes: Number(d.totalDiskReadBytes ?? 0),
      diskWriteBytes: Number(d.totalDiskWriteBytes ?? 0),
      diskReadBps: Math.round(d.avgDiskReadBps ?? 0),
      diskWriteBps: Math.round(d.avgDiskWriteBps ?? 0),
      diskReadOps: Number(d.totalDiskReadOps ?? 0),
      diskWriteOps: Number(d.totalDiskWriteOps ?? 0),
      networkIn: Number(d.totalNetworkIn ?? 0),
      networkOut: Number(d.totalNetworkOut ?? 0),
      bandwidthInBps: Math.round(d.avgBandwidthIn ?? 0),
      bandwidthOutBps: Math.round(d.avgBandwidthOut ?? 0),
      processCount: Math.round(d.avgProcessCount ?? 0)
    }));
  }

  // Group data into buckets
  const buckets = new Map<number, typeof data>();

  for (const point of data) {
    const timestamp = new Date(point.bucket).getTime();
    const bucketKey = Math.floor(timestamp / (bucketSeconds * 1000)) * (bucketSeconds * 1000);

    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, []);
    }
    buckets.get(bucketKey)!.push(point);
  }

  // Aggregate each bucket
  const result: Array<{
    timestamp: string;
    cpu: number;
    ram: number;
    ramUsedMb: number;
    disk: number;
    diskUsedGb: number;
    diskActivityAvailable: boolean;
    diskReadBytes: number;
    diskWriteBytes: number;
    diskReadBps: number;
    diskWriteBps: number;
    diskReadOps: number;
    diskWriteOps: number;
    networkIn: number;
    networkOut: number;
    bandwidthInBps: number;
    bandwidthOutBps: number;
    processCount: number;
  }> = [];

  for (const [bucketKey, points] of Array.from(buckets.entries()).sort((a, b) => a[0] - b[0])) {
    const count = points.length;
    const avgCpu = points.reduce((sum, p) => sum + (p.avgCpuPercent ?? 0), 0) / count;
    const avgRam = points.reduce((sum, p) => sum + (p.avgRamPercent ?? 0), 0) / count;
    const avgRamUsed = points.reduce((sum, p) => sum + Number(p.avgRamUsedMb ?? 0), 0) / count;
    const avgDisk = points.reduce((sum, p) => sum + (p.avgDiskPercent ?? 0), 0) / count;
    const avgDiskUsed = points.reduce((sum, p) => sum + (p.avgDiskUsedGb ?? 0), 0) / count;
    const diskActivityAvailable = points.some((p) => p.diskActivityAvailable);
    const totalDiskReadBytes = points.reduce((sum, p) => sum + Number(p.totalDiskReadBytes ?? 0), 0);
    const totalDiskWriteBytes = points.reduce((sum, p) => sum + Number(p.totalDiskWriteBytes ?? 0), 0);
    const avgDiskReadBps = points.reduce((sum, p) => sum + (p.avgDiskReadBps ?? 0), 0) / count;
    const avgDiskWriteBps = points.reduce((sum, p) => sum + (p.avgDiskWriteBps ?? 0), 0) / count;
    const totalDiskReadOps = points.reduce((sum, p) => sum + Number(p.totalDiskReadOps ?? 0), 0);
    const totalDiskWriteOps = points.reduce((sum, p) => sum + Number(p.totalDiskWriteOps ?? 0), 0);
    const totalIn = points.reduce((sum, p) => sum + Number(p.totalNetworkIn ?? 0), 0);
    const totalOut = points.reduce((sum, p) => sum + Number(p.totalNetworkOut ?? 0), 0);
    const avgBwIn = points.reduce((sum, p) => sum + (p.avgBandwidthIn ?? 0), 0) / count;
    const avgBwOut = points.reduce((sum, p) => sum + (p.avgBandwidthOut ?? 0), 0) / count;
    const avgProcess = points.reduce((sum, p) => sum + Number(p.avgProcessCount ?? 0), 0) / count;

    result.push({
      timestamp: new Date(bucketKey).toISOString(),
      cpu: Number(avgCpu.toFixed(2)),
      ram: Number(avgRam.toFixed(2)),
      ramUsedMb: Math.round(avgRamUsed),
      disk: Number(avgDisk.toFixed(2)),
      diskUsedGb: Number(avgDiskUsed.toFixed(2)),
      diskActivityAvailable,
      diskReadBytes: totalDiskReadBytes,
      diskWriteBytes: totalDiskWriteBytes,
      diskReadBps: Math.round(avgDiskReadBps),
      diskWriteBps: Math.round(avgDiskWriteBps),
      diskReadOps: totalDiskReadOps,
      diskWriteOps: totalDiskWriteOps,
      networkIn: totalIn,
      networkOut: totalOut,
      bandwidthInBps: Math.round(avgBwIn),
      bandwidthOutBps: Math.round(avgBwOut),
      processCount: Math.round(avgProcess)
    });
  }

  return result;
}

// GET /devices/:id/metrics - Get device metrics history
metricsRoutes.get(
  '/:id/metrics',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', metricsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const query = c.req.valid('query');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Get site timezone
    const [site] = await db
      .select({ timezone: sites.timezone })
      .from(sites)
      .where(eq(sites.id, device.siteId))
      .limit(1);
    const timezone = site?.timezone || 'UTC';

    // Handle range parameter for simpler time range queries
    const rangeToMs: Record<string, number> = {
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000
    };

    const rangeToInterval: Record<string, '1m' | '5m' | '1h' | '1d'> = {
      '1h': '1m',
      '6h': '5m',
      '24h': '5m',
      '7d': '1h',
      '30d': '1d'
    };

    // Default to last 24 hours
    const endDate = query.endDate ? new Date(query.endDate) : new Date();
    const rangeMs = query.range ? rangeToMs[query.range] : undefined;
    const startDate = query.startDate
      ? new Date(query.startDate)
      : rangeMs
        ? new Date(endDate.getTime() - rangeMs)
        : new Date(endDate.getTime() - 24 * 60 * 60 * 1000);

    let interval: '1m' | '5m' | '1h' | '1d' = query.interval || '5m';
    const rangeInterval = query.range ? rangeToInterval[query.range] : undefined;
    if (rangeInterval && !query.interval) {
      interval = rangeInterval;
    }

    // Map interval to seconds for aggregation
    const intervalSeconds: Record<string, number> = {
      '1m': 60,
      '5m': 300,
      '1h': 3600,
      '1d': 86400
    };

    const bucketSeconds = intervalSeconds[interval] ?? 300; // default to 5 minutes

    let metricsData = await queryMetricRollups(device.orgId, deviceId, startDate, endDate, interval);
    if (metricsData.length === 0) {
      metricsData = await queryRawMetricBuckets(deviceId, startDate, endDate);
    }

    // Further aggregate based on requested interval
    const aggregatedData = aggregateMetricsByInterval(metricsData, interval, bucketSeconds);

    return c.json({
      data: aggregatedData,
      metrics: aggregatedData, // Alias for frontend compatibility
      interval,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      timezone
    });
  }
);
