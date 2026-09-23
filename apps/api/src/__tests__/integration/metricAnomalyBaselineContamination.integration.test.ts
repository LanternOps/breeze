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

type SourceTable = 'device_metrics' | 'device_process_samples';

async function insertRollups(orgId: string, deviceId: string, metricName: string, metricType: string, starts: Date[], value: (i: number) => number, sourceTable: SourceTable = 'device_metrics') {
  await getTestDb().insert(metricRollups).values(starts.map((bucketStart, i) => ({
    orgId, sourceTable, deviceId, metricType, metricName, bucketStart, bucketSeconds: 300,
    avgValue: value(i), minValue: value(i), maxValue: value(i), p95Value: value(i), sumValue: value(i),
    sampleCount: 1, gapSeconds: 0, metadata: { rollupVersion: 'metric-rollups-v1', source: 'raw' },
  })));
}

interface EpisodeShape {
  sourceTable?: SourceTable;
  anomalyType?: string;
  /** Default open. A closed episode's buckets must rejoin the baseline. */
  closed?: boolean;
}

async function insertOpenEpisode(orgId: string, deviceId: string, metricName: string, family: string, firstSeenAt: Date, lastSeenAt: Date, shape: EpisodeShape = {}): Promise<string> {
  const sourceTable = shape.sourceTable ?? 'device_metrics';
  const anomalyType = shape.anomalyType ?? 'spike';
  const [row] = await getTestDb().insert(metricAnomalyEpisodes).values({
    orgId, deviceId, episodeKey: `${sourceTable}:${anomalyType}:${family}`, sourceTable, anomalyType,
    metricFamily: family, metricNames: [metricName], firstSeenAt, lastSeenAt, bucketCount: 1, peakValue: 1,
    peakMetricName: metricName, peakScore: 1, peakAt: firstSeenAt,
    ...(shape.closed ? { status: 'resolved', closeReason: 'cleared', resolvedAt: lastSeenAt } : {}),
  }).returning({ id: metricAnomalyEpisodes.id });
  return row!.id;
}

interface MemberShape {
  sourceTable?: SourceTable;
  metricType?: string;
  metricName?: string;
  anomalyType?: string;
}

async function insertMember(orgId: string, deviceId: string, episodeId: string, windowStart: Date, shape: MemberShape = {}) {
  await getTestDb().insert(metricAnomalies).values({
    orgId, deviceId, sourceTable: shape.sourceTable ?? 'device_metrics', metricType: shape.metricType ?? 'cpu',
    metricName: shape.metricName ?? 'cpu_percent', anomalyType: shape.anomalyType ?? 'spike',
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

  /**
   * 14 cpu_percent baseline buckets at 10 before `anchor`, a 99 at `anchor`,
   * and `members` of those buckets attached to one episode of the given shape.
   * Returns the spike's baseline_summary and the fallback-counter delta.
   */
  async function runCpuScenario(members: number, episode: EpisodeShape, memberShape: MemberShape = {}) {
    const device = await insertDevice(orgId, siteId);
    const anchor = new Date('2026-06-18T18:00:00.000Z');
    const baselineStarts = Array.from({ length: 14 }, (_, i) => at(anchor, -(6 + i) * 5));
    await insertRollups(orgId, device, 'cpu_percent', 'cpu', baselineStarts, () => 10);
    await insertRollups(orgId, device, 'cpu_percent', 'cpu', [anchor], () => 99);
    const episodeId = await insertOpenEpisode(orgId, device, 'cpu_percent', 'cpu', at(anchor, -100), at(anchor, -25), episode);
    for (const windowStart of baselineStarts.slice(0, members)) await insertMember(orgId, device, episodeId, windowStart, memberShape);

    const before = await readFallbackCount('baseline');
    await detectMetricAnomaliesRange({ orgId, from: anchor, to: at(anchor, 5) });
    const [spike] = await getTestDb()
      .select()
      .from(metricAnomalies)
      .where(and(eq(metricAnomalies.deviceId, device), eq(metricAnomalies.windowStart, anchor), eq(metricAnomalies.anomalyType, 'spike')));
    expect(spike).toBeDefined();
    return { summary: spike!.baselineSummary as Record<string, unknown>, counterDelta: (await readFallbackCount('baseline')) - before };
  }

  it('uses the filtered baseline (no fallback) when exactly MIN_BASELINE_BUCKETS clean buckets remain', async () => {
    const { summary, counterDelta } = await runCpuScenario(2, {});
    expect(summary).toMatchObject({ baselineFallback: false, baselineBuckets: 12, baselineExcludedBuckets: 2 });
    expect(counterDelta).toBe(0);
  });

  it('does not exclude buckets of a CLOSED episode', async () => {
    const { summary, counterDelta } = await runCpuScenario(10, { closed: true });
    expect(summary).toMatchObject({ baselineFallback: false, baselineBuckets: 14, baselineExcludedBuckets: 0 });
    expect(counterDelta).toBe(0);
  });

  it('does not exclude buckets whose open-episode member is a growth row (plan deviation 6)', async () => {
    const { summary } = await runCpuScenario(10, { anomalyType: 'memory_growth' }, { anomalyType: 'memory_growth' });
    expect(summary).toMatchObject({ baselineFallback: false, baselineBuckets: 14, baselineExcludedBuckets: 0 });
  });

  it('applies the same exclusion and fallback to the process-sample runaway detector', async () => {
    const device = await insertDevice(orgId, siteId);
    const anchor = new Date('2026-06-18T18:00:00.000Z');
    const metricName = 'top_process_cpu_percent_sum';
    const baselineStarts = Array.from({ length: 14 }, (_, i) => at(anchor, -(6 + i) * 5));
    await insertRollups(orgId, device, metricName, 'process', baselineStarts, () => 10, 'device_process_samples');
    await insertRollups(orgId, device, metricName, 'process', [anchor], () => 99, 'device_process_samples');
    const episodeId = await insertOpenEpisode(orgId, device, metricName, 'process_cpu', at(anchor, -100), at(anchor, -25), {
      sourceTable: 'device_process_samples', anomalyType: 'process_runaway',
    });
    for (const windowStart of baselineStarts.slice(0, 10)) {
      await insertMember(orgId, device, episodeId, windowStart, {
        sourceTable: 'device_process_samples', metricType: 'process', metricName, anomalyType: 'process_runaway',
      });
    }

    const before = await readFallbackCount('process-runaway');
    await detectMetricAnomaliesRange({ orgId, from: anchor, to: at(anchor, 5) });

    const [runaway] = await getTestDb()
      .select()
      .from(metricAnomalies)
      .where(and(eq(metricAnomalies.deviceId, device), eq(metricAnomalies.windowStart, anchor), eq(metricAnomalies.anomalyType, 'process_runaway')));
    expect(runaway).toBeDefined();
    expect(runaway!.baselineSummary as Record<string, unknown>).toMatchObject({
      baselineFallback: true,
      baselineBuckets: 14,
      baselineExcludedBuckets: 10,
      sourceTable: 'device_process_samples',
    });
    expect(await readFallbackCount('process-runaway')).toBe(before + 1);
  });
});
