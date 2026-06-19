import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { withSystemDbAccessContext } from '../../db';
import { alerts, devices, metricAnomalies, metricRollups, organizations } from '../../db/schema';
import { detectMetricAnomaliesRange } from '../../services/metricAnomalies';
import { promoteMetricAnomalyToAlert } from '../../services/metricAnomalyPromotion';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

// metric_rollups -> metric_anomalies detection requires ml.anomalies.* flags. They
// default OFF, so each org enables them via settings (root-level flat keys, picked
// up by flagOverrideFromSettings' flatContainers[0]).
const ANOMALY_SETTINGS = {
  'ml.anomalies.enabled': true,
  'ml.anomalies.create_alerts': true,
} as const;

const RAW_BUCKET_SECONDS = 300;
const MIN_BASELINE_BUCKETS = 12;
const MIN_TREND_BUCKETS = 6;

let agentIdCounter = 0;
async function insertDevice(options: { orgId: string; siteId: string; hostname: string }): Promise<string> {
  agentIdCounter++;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId: options.orgId,
      siteId: options.siteId,
      agentId: `metric-anomaly-test-${Date.now()}-${agentIdCounter}`,
      hostname: options.hostname,
      displayName: options.hostname,
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date('2026-06-18T00:00:00.000Z'),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('insertDevice returned no row');
  return row.id;
}

async function enableAnomalies(orgId: string): Promise<void> {
  await getTestDb()
    .update(organizations)
    .set({ settings: ANOMALY_SETTINGS })
    .where(eq(organizations.id, orgId));
}

interface RollupSeed {
  orgId: string;
  deviceId: string;
  sourceTable: 'device_metrics' | 'device_process_samples';
  metricType: string;
  metricName: string;
  bucketStart: Date;
  avgValue: number;
  maxValue?: number;
  sampleCount?: number;
}

async function insertRollup(seed: RollupSeed): Promise<void> {
  await getTestDb().insert(metricRollups).values({
    orgId: seed.orgId,
    sourceTable: seed.sourceTable,
    deviceId: seed.deviceId,
    metricType: seed.metricType,
    metricName: seed.metricName,
    bucketStart: seed.bucketStart,
    bucketSeconds: RAW_BUCKET_SECONDS,
    avgValue: seed.avgValue,
    minValue: seed.avgValue,
    maxValue: seed.maxValue ?? seed.avgValue,
    p95Value: seed.avgValue,
    sumValue: seed.avgValue,
    sampleCount: seed.sampleCount ?? 1,
    gapSeconds: 0,
    metadata: { rollupVersion: 'metric-rollups-v1', source: 'raw' },
  });
}

function bucketAt(base: Date, offsetBuckets: number): Date {
  return new Date(base.getTime() + offsetBuckets * RAW_BUCKET_SECONDS * 1000);
}

async function runDetection(orgId: string, from: Date, to: Date): Promise<void> {
  await withSystemDbAccessContext(() => detectMetricAnomaliesRange({ orgId, from, to }));
}

async function selectAnomalies(orgId: string, deviceId: string) {
  return getTestDb()
    .select()
    .from(metricAnomalies)
    .where(and(eq(metricAnomalies.orgId, orgId), eq(metricAnomalies.deviceId, deviceId)))
    .orderBy(metricAnomalies.windowStart);
}

async function selectAnomaliesByType(orgId: string, deviceId: string, anomalyType: string) {
  return getTestDb()
    .select()
    .from(metricAnomalies)
    .where(
      and(
        eq(metricAnomalies.orgId, orgId),
        eq(metricAnomalies.deviceId, deviceId),
        eq(metricAnomalies.anomalyType, anomalyType),
      ),
    );
}

describe('metric anomalies integration', () => {
  let orgA: string;
  let siteA: string;

  beforeEach(async () => {
    const partner = await createPartner();
    const organizationA = await createOrganization({ partnerId: partner.id, name: 'Anomaly Org A' });
    orgA = organizationA.id;
    await enableAnomalies(orgA);
    siteA = (await createSite({ orgId: orgA, name: 'Anomaly Site A' })).id;
  });

  it('fires a baseline spike against a zero-stddev baseline via the greatest(...,1) z-score guard', async () => {
    const device = await insertDevice({ orgId: orgA, siteId: siteA, hostname: 'zero-stddev-device' });

    // Baseline window: MIN_BASELINE_BUCKETS identical buckets (stddev_samp = 0).
    // The observed bucket must clear the spike floor of 90 for cpu_percent since
    // the stddev-derived term collapses to baseline + 3*greatest(0,1) = 13.
    const anchor = new Date('2026-06-18T18:00:00.000Z');
    // Baseline buckets must sit in [anchor - 24h, anchor - 15min). Place them 30+ min back.
    for (let i = 0; i < MIN_BASELINE_BUCKETS + 2; i++) {
      await insertRollup({
        orgId: orgA,
        deviceId: device,
        sourceTable: 'device_metrics',
        metricType: 'cpu',
        metricName: 'cpu_percent',
        // 6 buckets (30 min) before the anchor, walking further back.
        bucketStart: bucketAt(anchor, -(6 + i)),
        avgValue: 10,
      });
    }
    // Observed bucket inside [from, to): a hard spike well above the 90 floor.
    await insertRollup({
      orgId: orgA,
      deviceId: device,
      sourceTable: 'device_metrics',
      metricType: 'cpu',
      metricName: 'cpu_percent',
      bucketStart: anchor,
      avgValue: 99,
    });

    await runDetection(orgA, anchor, bucketAt(anchor, 1));

    const spikes = await selectAnomaliesByType(orgA, device, 'spike');
    expect(spikes).toHaveLength(1);
    const spike = spikes[0]!;
    expect(spike.observedValue).toBe(99);
    expect(spike.baselineValue).toBe(10);
    // z-score guard: |99 - 10| / greatest(0, 1) = 89, never a divide-by-zero.
    expect(spike.score).toBeCloseTo(89, 5);
    expect(Number.isFinite(spike.score)).toBe(true);
    expect((spike.baselineSummary as Record<string, unknown>).baselineStddev).toBe(0);
  });

  it('does not divide by zero when the baseline collapses to a single distinct value (NULL/zero stddev)', async () => {
    // A baseline of all-identical values is the realistic stddev-edge: stddev_samp
    // is 0 (not NULL, since >=2 rows are required to clear MIN_BASELINE_BUCKETS),
    // and the coalesce(stddev,0)+greatest(...,1) guard keeps the score finite. Here
    // the observed value stays under threshold, so NO anomaly should be emitted —
    // proving the guard does not manufacture a spurious spike from a flat baseline.
    const device = await insertDevice({ orgId: orgA, siteId: siteA, hostname: 'flat-baseline-device' });
    const anchor = new Date('2026-06-18T18:00:00.000Z');
    for (let i = 0; i < MIN_BASELINE_BUCKETS + 2; i++) {
      await insertRollup({
        orgId: orgA,
        deviceId: device,
        sourceTable: 'device_metrics',
        metricType: 'cpu',
        metricName: 'cpu_percent',
        bucketStart: bucketAt(anchor, -(6 + i)),
        avgValue: 40,
      });
    }
    // Observed slightly above baseline but below the 90 floor -> no spike.
    await insertRollup({
      orgId: orgA,
      deviceId: device,
      sourceTable: 'device_metrics',
      metricType: 'cpu',
      metricName: 'cpu_percent',
      bucketStart: anchor,
      avgValue: 55,
    });

    await runDetection(orgA, anchor, bucketAt(anchor, 1));

    const anomalies = await selectAnomalies(orgA, device);
    expect(anomalies).toHaveLength(0);
  });

  it('detects a growth trend at exactly MIN_TREND_BUCKETS with first_value=0', async () => {
    const device = await insertDevice({ orgId: orgA, siteId: siteA, hostname: 'growth-trend-device' });
    const base = new Date('2026-06-18T18:00:00.000Z');

    // Exactly MIN_TREND_BUCKETS consecutive disk_percent buckets, first_value = 0,
    // rising past the +15 absolute-growth gate (0 -> 30).
    const values = [0, 5, 10, 15, 22, 30];
    expect(values).toHaveLength(MIN_TREND_BUCKETS);
    for (let i = 0; i < values.length; i++) {
      await insertRollup({
        orgId: orgA,
        deviceId: device,
        sourceTable: 'device_metrics',
        metricType: 'disk',
        metricName: 'disk_percent',
        bucketStart: bucketAt(base, i),
        avgValue: values[i]!,
      });
    }

    // The anchor (window end) is the last bucket; scan [base, lastBucket + 1).
    await runDetection(orgA, base, bucketAt(base, MIN_TREND_BUCKETS));

    const trends = await selectAnomaliesByType(orgA, device, 'disk_growth');
    expect(trends).toHaveLength(1);
    const trend = trends[0]!;
    expect(trend.baselineValue).toBe(0); // first_value
    expect(trend.observedValue).toBe(30); // last_value
    expect(trend.score).toBeCloseTo(30, 5);
    expect((trend.baselineSummary as Record<string, unknown>).trendBuckets).toBe(MIN_TREND_BUCKETS);
  });

  it('does not fire a growth trend below MIN_TREND_BUCKETS', async () => {
    const device = await insertDevice({ orgId: orgA, siteId: siteA, hostname: 'short-trend-device' });
    const base = new Date('2026-06-18T18:00:00.000Z');

    // One bucket short of MIN_TREND_BUCKETS, even though growth clears the gate.
    const values = [0, 6, 12, 18, 30];
    expect(values).toHaveLength(MIN_TREND_BUCKETS - 1);
    for (let i = 0; i < values.length; i++) {
      await insertRollup({
        orgId: orgA,
        deviceId: device,
        sourceTable: 'device_metrics',
        metricType: 'disk',
        metricName: 'disk_percent',
        bucketStart: bucketAt(base, i),
        avgValue: values[i]!,
      });
    }

    await runDetection(orgA, base, bucketAt(base, values.length));

    const trends = await selectAnomaliesByType(orgA, device, 'disk_growth');
    expect(trends).toHaveLength(0);
  });

  it('scans interior trend windows across a wide backfill range (per-anchor windowing)', async () => {
    // Regression for "detectGrowthTrends ignores its from": a wide range must scan
    // every interior MIN_TREND_BUCKETS window, not only the one ending at `to`.
    const device = await insertDevice({ orgId: orgA, siteId: siteA, hostname: 'wide-range-device' });
    const base = new Date('2026-06-18T18:00:00.000Z');

    // First MIN_TREND_BUCKETS buckets grow 0 -> 30 (an interior window). Then flatten
    // so the window ending at `to` shows no growth. Old code only looked at `to`.
    const values = [0, 5, 10, 15, 22, 30, 30, 30, 30, 30, 30, 30];
    for (let i = 0; i < values.length; i++) {
      await insertRollup({
        orgId: orgA,
        deviceId: device,
        sourceTable: 'device_metrics',
        metricType: 'disk',
        metricName: 'disk_percent',
        bucketStart: bucketAt(base, i),
        avgValue: values[i]!,
      });
    }

    await runDetection(orgA, base, bucketAt(base, values.length));

    const trends = await selectAnomaliesByType(orgA, device, 'disk_growth');
    // The interior 0 -> 30 window is caught even though the tail window is flat.
    expect(trends.length).toBeGreaterThanOrEqual(1);
    const interior = trends.find((t) => t.baselineValue === 0 && t.observedValue === 30);
    expect(interior).toBeDefined();
  });

  it('promotes two metric_name rows of one incident into a single alert', async () => {
    const device = await insertDevice({ orgId: orgA, siteId: siteA, hostname: 'dedup-promote-device' });
    const windowStart = new Date('2026-06-18T18:00:00.000Z');
    const windowEnd = bucketAt(windowStart, 1);

    // Two rows, same device/anomaly_type/window, differing only by metric_name:
    // the baseline 'network_egress' (bandwidth_out_bps) and the process-runaway
    // 'network_egress' (top_process_net_bps_sum). Insert directly to mimic both
    // detectors emitting for the same event.
    const [baselineRow] = await getTestDb()
      .insert(metricAnomalies)
      .values({
        orgId: orgA,
        deviceId: device,
        sourceTable: 'device_metrics',
        metricType: 'network',
        metricName: 'bandwidth_out_bps',
        anomalyType: 'network_egress',
        status: 'open',
        windowStart,
        windowEnd,
        bucketSeconds: RAW_BUCKET_SECONDS,
        observedValue: 5_000_000,
        baselineValue: 1_000_000,
        baselineMin: 900_000,
        baselineMax: 1_100_000,
        score: 6,
        confidence: 0.8,
        sampleCount: 5,
        baselineSummary: { modelVersion: 'metric-anomalies-v1' },
        evidence: {},
      })
      .returning({ id: metricAnomalies.id });

    const [processRow] = await getTestDb()
      .insert(metricAnomalies)
      .values({
        orgId: orgA,
        deviceId: device,
        sourceTable: 'device_process_samples',
        metricType: 'process',
        metricName: 'top_process_net_bps_sum',
        anomalyType: 'network_egress',
        status: 'open',
        windowStart,
        windowEnd,
        bucketSeconds: RAW_BUCKET_SECONDS,
        observedValue: 4_800_000,
        baselineValue: 1_000_000,
        baselineMin: 900_000,
        baselineMax: 1_050_000,
        // Higher confidence so this row is the canonical alert driver.
        score: 9,
        confidence: 0.95,
        sampleCount: 5,
        baselineSummary: { modelVersion: 'metric-anomalies-v1' },
        evidence: {},
      })
      .returning({ id: metricAnomalies.id });

    if (!baselineRow || !processRow) throw new Error('failed to seed anomaly rows');

    // Promote the first row.
    const first = await withSystemDbAccessContext(() =>
      promoteMetricAnomalyToAlert({
        orgId: orgA,
        deviceId: device,
        anomalyId: baselineRow.id,
        requireCreateAlertsFlag: false,
      }),
    );
    expect(first.status).toBe('promoted');
    if (first.status !== 'promoted') throw new Error('expected promotion');
    expect(first.created).toBe(true);

    // Promote the sibling row: must reuse the same alert, not create a second.
    const second = await withSystemDbAccessContext(() =>
      promoteMetricAnomalyToAlert({
        orgId: orgA,
        deviceId: device,
        anomalyId: processRow.id,
        requireCreateAlertsFlag: false,
      }),
    );
    expect(second.status).toBe('promoted');
    if (second.status !== 'promoted') throw new Error('expected promotion');
    expect(second.created).toBe(false);
    expect(second.alertId).toBe(first.alertId);

    // Exactly one alert exists for this device.
    const deviceAlerts = await getTestDb()
      .select()
      .from(alerts)
      .where(and(eq(alerts.orgId, orgA), eq(alerts.deviceId, device)));
    expect(deviceAlerts).toHaveLength(1);
    // The canonical (higher-confidence process) row drove the alert content.
    const alertContext = deviceAlerts[0]!.context as Record<string, unknown>;
    expect(alertContext.anomalyId).toBe(processRow.id);
    expect(alertContext.metricName).toBe('top_process_net_bps_sum');

    // Both anomaly rows are linked to the single alert.
    const all = await selectAnomalies(orgA, device);
    expect(all).toHaveLength(2);
    expect(all.every((a) => a.linkedAlertId === first.alertId)).toBe(true);
    expect(all.every((a) => a.status === 'promoted')).toBe(true);
  });
});
