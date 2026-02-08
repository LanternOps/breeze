import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, gte, lte, sql, asc } from 'drizzle-orm';
import { db } from '../../db';
import { deviceMetrics, sites } from '../../db/schema';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { getDeviceWithOrgCheck } from './helpers';
import { metricsQuerySchema } from './schemas';

export const metricsRoutes = new Hono();

metricsRoutes.use('*', authMiddleware);

// Helper function to aggregate metrics by interval
function aggregateMetricsByInterval(
  data: Array<{
    bucket: Date;
    avgCpuPercent: number;
    avgRamPercent: number;
    avgRamUsedMb: number;
    avgDiskPercent: number;
    avgDiskUsedGb: number;
    totalNetworkIn: bigint;
    totalNetworkOut: bigint;
    avgBandwidthIn: number;
    avgBandwidthOut: number;
    avgProcessCount: number;
  }>,
  interval: string,
  bucketSeconds: number
): Array<{
  timestamp: string;
  cpu: number;
  ram: number;
  ramUsedMb: number;
  disk: number;
  diskUsedGb: number;
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
      timestamp: d.bucket.toISOString(),
      cpu: Number(d.avgCpuPercent?.toFixed(2) ?? 0),
      ram: Number(d.avgRamPercent?.toFixed(2) ?? 0),
      ramUsedMb: Math.round(d.avgRamUsedMb ?? 0),
      disk: Number(d.avgDiskPercent?.toFixed(2) ?? 0),
      diskUsedGb: Number(d.avgDiskUsedGb?.toFixed(2) ?? 0),
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
    const avgRamUsed = points.reduce((sum, p) => sum + (p.avgRamUsedMb ?? 0), 0) / count;
    const avgDisk = points.reduce((sum, p) => sum + (p.avgDiskPercent ?? 0), 0) / count;
    const avgDiskUsed = points.reduce((sum, p) => sum + (p.avgDiskUsedGb ?? 0), 0) / count;
    const totalIn = points.reduce((sum, p) => sum + Number(p.totalNetworkIn ?? 0), 0);
    const totalOut = points.reduce((sum, p) => sum + Number(p.totalNetworkOut ?? 0), 0);
    const avgBwIn = points.reduce((sum, p) => sum + (p.avgBandwidthIn ?? 0), 0) / count;
    const avgBwOut = points.reduce((sum, p) => sum + (p.avgBandwidthOut ?? 0), 0) / count;
    const avgProcess = points.reduce((sum, p) => sum + (p.avgProcessCount ?? 0), 0) / count;

    result.push({
      timestamp: new Date(bucketKey).toISOString(),
      cpu: Number(avgCpu.toFixed(2)),
      ram: Number(avgRam.toFixed(2)),
      ramUsedMb: Math.round(avgRamUsed),
      disk: Number(avgDisk.toFixed(2)),
      diskUsedGb: Number(avgDiskUsed.toFixed(2)),
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
  zValidator('query', metricsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const query = c.req.valid('query');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
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

    // Query with time bucket aggregation
    const metricsData = await db
      .select({
        bucket: sql<Date>`date_trunc('minute', ${deviceMetrics.timestamp})`,
        avgCpuPercent: sql<number>`avg(${deviceMetrics.cpuPercent})`,
        avgRamPercent: sql<number>`avg(${deviceMetrics.ramPercent})`,
        avgRamUsedMb: sql<number>`avg(${deviceMetrics.ramUsedMb})`,
        avgDiskPercent: sql<number>`avg(${deviceMetrics.diskPercent})`,
        avgDiskUsedGb: sql<number>`avg(${deviceMetrics.diskUsedGb})`,
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
