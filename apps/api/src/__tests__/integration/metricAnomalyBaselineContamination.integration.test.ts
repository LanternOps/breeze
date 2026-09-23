import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { devices, metricAnomalies, metricAnomalyEpisodes, metricRollups, organizations } from '../../db/schema';
import { detectMetricAnomaliesRange } from '../../services/metricAnomalies';
import { BASELINE_FALLBACK_METRIC } from '../../services/metricAnomalyEpisodeMetrics';
import { metricsRegistry } from '../../services/metricsRegistry';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const BUCKET_MS = 5 * 60_000;
const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60_000);
const floorToBucket = (value: Date) => new Date(Math.floor(value.getTime() / BUCKET_MS) * BUCKET_MS);
const bucketsFrom = (start: Date, count: number) => Array.from({ length: count }, (_, i) => at(start, i * 5));

let deviceCounter = 0;
async function insertDevice(orgId: string, siteId: string): Promise<string> {
  deviceCounter += 1;
  const [row] = await getTestDb().insert(devices).values({
    orgId, siteId, agentId: `contamination-${Date.now()}-${deviceCounter}`, hostname: `contamination-${deviceCounter}`,
    displayName: `contamination-${deviceCounter}`, osType: 'linux', osVersion: 'test', architecture: 'x86_64',
    agentVersion: '0.0.0-test', status: 'online', enrolledAt: new Date('2026-06-18T00:00:00.000Z'), lastSeenAt: new Date(),
  }).returning({ id: devices.id });
  return row!.id;
}

async function insertRollups(orgId: string, deviceId: string, metricName: string, metricType: string, starts: Date[], value: (i: number) => number) {
  await getTestDb().insert(metricRollups).values(starts.map((bucketStart, i) => ({
    orgId, sourceTable: 'device_metrics', deviceId, metricType, metricName, bucketStart, bucketSeconds: 300,
    avgValue: value(i), minValue: value(i), maxValue: value(i), p95Value: value(i), sumValue: value(i),
    sampleCount: 1, gapSeconds: 0, metadata: { rollupVersion: 'metric-rollups-v1', source: 'raw' },
  })));
}

async function insertOpenEpisode(orgId: string, deviceId: string, metricName: string, family: string, firstSeenAt: Date, lastSeenAt: Date): Promise<string> {
  const [row] = await getTestDb().insert(metricAnomalyEpisodes).values({
    orgId, deviceId, episodeKey: `device_metrics:spike:${family}`, sourceTable: 'device_metrics', anomalyType: 'spike',
    metricFamily: family, metricNames: [metricName], firstSeenAt, lastSeenAt, bucketCount: 1, peakValue: 1,
    peakMetricName: metricName, peakScore: 1, peakAt: firstSeenAt,
  }).returning({ id: metricAnomalyEpisodes.id });
  return row!.id;
}

async function insertMember(orgId: string, deviceId: string, episodeId: string, windowStart: Date) {
  await getTestDb().insert(metricAnomalies).values({
    orgId, deviceId, sourceTable: 'device_metrics', metricType: 'cpu', metricName: 'cpu_percent', anomalyType: 'spike',
    status: 'open', windowStart, windowEnd: at(windowStart, 5), bucketSeconds: 300, observedValue: 95, baselineValue: 40,
    score: 5, confidence: 0.9, sampleCount: 1, baselineSummary: {}, evidence: {}, episodeId,
  });
}

async function readFallbackCount(detector: string): Promise<number> {
  const metric = metricsRegistry.getSingleMetric(BASELINE_FALLBACK_METRIC);
  if (!metric) return 0;
  const { values } = await metric.get();
  return values.find((value) => value.labels.detector === detector)?.value ?? 0;
}

describe('baseline anti-contamination (spec §10)', () => {
  let orgId: string;
  let siteId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    orgId = (await createOrganization({ partnerId: partner.id, name: 'Contamination Org' })).id;
    await getTestDb().update(organizations).set({ settings: { 'ml.anomalies.enabled': true } }).where(eq(organizations.id, orgId));
    siteId = (await createSite({ orgId, name: 'Contamination Site' })).id;
  });

  it('still detects a 6-hour burst at 4x baseline in hour 5, and the open episode spans all 72 buckets', async () => {
    const device = await insertDevice(orgId, siteId);
    const burstStart = at(floorToBucket(new Date()), -6 * 60);
    // 24 h of baseline at 1.5 MB/s (stddev 0.1 MB/s), then 72 buckets at 6 MB/s.
    await insertRollups(orgId, device, 'disk_write_bps', 'disk', bucketsFrom(at(burstStart, -24 * 60), 288), (i) => (i % 2 === 0 ? 1.4e6 : 1.6e6));
    await insertRollups(orgId, device, 'disk_write_bps', 'disk', bucketsFrom(burstStart, 72), () => 6e6);
    const episodeId = await insertOpenEpisode(orgId, device, 'disk_write_bps', 'disk_write', burstStart, at(burstStart, 5));

    // Tick bucket by bucket, like the cron, attaching each tick's rows to the
    // open episode so the next tick's baseline excludes them.
    for (let i = 0; i < 72; i++) {
      const from = at(burstStart, i * 5);
      await detectMetricAnomaliesRange({ orgId, from, to: at(from, 5) });
      await getTestDb()
        .update(metricAnomalies)
        .set({ episodeId })
        .where(and(eq(metricAnomalies.deviceId, device), eq(metricAnomalies.metricName, 'disk_write_bps'), isNull(metricAnomalies.episodeId)));
    }

    const hourFive = await getTestDb().select().from(metricAnomalies).where(and(
      eq(metricAnomalies.deviceId, device),
      eq(metricAnomalies.metricName, 'disk_write_bps'),
      eq(metricAnomalies.anomalyType, 'spike'),
      eq(metricAnomalies.windowStart, at(burstStart, 5 * 60)),
    ));
    expect(hourFive).toHaveLength(1);

    const [spanned] = await getTestDb()
      .select({ buckets: sql<number>`count(DISTINCT ${metricAnomalies.windowStart})::integer` })
      .from(metricAnomalies)
      .where(eq(metricAnomalies.episodeId, episodeId));
    expect(spanned?.buckets).toBe(72);
  }, 180_000);

  it('falls back to the unfiltered baseline, and counts it, when exclusion leaves fewer than 12 buckets', async () => {
    const device = await insertDevice(orgId, siteId);
    const anchor = new Date('2026-06-18T18:00:00.000Z');
    const baselineStarts = Array.from({ length: 14 }, (_, i) => at(anchor, -(6 + i) * 5)); // anchor-30 .. anchor-95
    await insertRollups(orgId, device, 'cpu_percent', 'cpu', baselineStarts, () => 10);
    await insertRollups(orgId, device, 'cpu_percent', 'cpu', [anchor], () => 99);
    // 10 of the 14 baseline buckets belong to an OPEN episode, leaving 4 clean.
    const episodeId = await insertOpenEpisode(orgId, device, 'cpu_percent', 'cpu', at(anchor, -75), at(anchor, -25));
    for (const windowStart of baselineStarts.slice(0, 10)) await insertMember(orgId, device, episodeId, windowStart);

    const before = await readFallbackCount('baseline');
    await detectMetricAnomaliesRange({ orgId, from: anchor, to: at(anchor, 5) });

    const [spike] = await getTestDb()
      .select()
      .from(metricAnomalies)
      .where(and(eq(metricAnomalies.deviceId, device), eq(metricAnomalies.windowStart, anchor), eq(metricAnomalies.anomalyType, 'spike')));
    expect(spike).toBeDefined();
    expect(spike!.baselineValue).toBe(10);
    expect(spike!.baselineSummary as Record<string, unknown>).toMatchObject({
      baselineFallback: true,
      baselineBuckets: 14,
      baselineExcludedBuckets: 10,
    });
    expect(await readFallbackCount('baseline')).toBe(before + 1);
  });
});
