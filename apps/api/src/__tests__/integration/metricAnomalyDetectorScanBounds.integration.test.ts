import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql, type SQL } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import { devices, metricAnomalies, metricRollups, organizations } from '../../db/schema';
import {
  buildBaselineDeviationsSql,
  buildGrowthTrendsSql,
  buildProcessSampleRunawaysSql,
  detectMetricAnomaliesRange,
} from '../../services/metricAnomalies';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

/**
 * #11559 — the detectors' self-joined `metric_rollups` probes now carry
 * constant superset bounds on `bucket_start`. Two halves:
 *
 * 1. Window pins. The exact per-row windows (baseline [r-24h, r-15min), growth
 *    (a-30min, a], novelty [window_start-7d, window_start)) must not move. Each
 *    case puts a bucket on both sides of every edge, crossing a monthly
 *    partition boundary, and reads the edge back from the written row.
 * 2. Plan guard. Under the RLS policy a per-row `b.bucket_start >= r.x - interval`
 *    bound is not leakproof, so it was never an index condition and every probe
 *    walked the series' whole month of history. The guard EXPLAINs each
 *    statement as `breeze_app` (system scope) with the nested-loop shape forced,
 *    and requires a lower `bucket_start` bound in every history probe's Index Cond.
 */

const RAW_BUCKET_SECONDS = 300;
const ANOMALY_SETTINGS = { 'ml.anomalies.enabled': true } as const;

type Metric = {
  sourceTable: 'device_metrics' | 'device_process_samples';
  metricType: string;
  metricName: string;
};

const CPU: Metric = { sourceTable: 'device_metrics', metricType: 'cpu', metricName: 'cpu_percent' };
const RAM: Metric = { sourceTable: 'device_metrics', metricType: 'ram', metricName: 'ram_percent' };
const PROC_CPU: Metric = {
  sourceTable: 'device_process_samples',
  metricType: 'process',
  metricName: 'top_process_cpu_percent_sum',
};

function bucketAt(base: Date, offsetBuckets: number): Date {
  return new Date(base.getTime() + offsetBuckets * RAW_BUCKET_SECONDS * 1000);
}

let agentCounter = 0;

describe('metric anomaly detector scan bounds (#11559)', () => {
  let orgId: string;
  let siteId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    const organization = await createOrganization({ partnerId: partner.id, name: 'Scan Bounds Org' });
    orgId = organization.id;
    await getTestDb().update(organizations).set({ settings: ANOMALY_SETTINGS }).where(eq(organizations.id, orgId));
    siteId = (await createSite({ orgId, name: 'Scan Bounds Site' })).id;
  });

  async function insertDevice(hostname: string): Promise<string> {
    agentCounter++;
    const [row] = await getTestDb()
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: `scan-bounds-${Date.now()}-${agentCounter}`,
        hostname,
        displayName: hostname,
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

  async function seed(deviceId: string, metric: Metric, points: Array<[Date, number]>): Promise<void> {
    await getTestDb().insert(metricRollups).values(points.map(([bucketStart, value]) => ({
      orgId,
      deviceId,
      sourceTable: metric.sourceTable,
      metricType: metric.metricType,
      metricName: metric.metricName,
      bucketStart,
      bucketSeconds: RAW_BUCKET_SECONDS,
      avgValue: value,
      minValue: value,
      maxValue: value,
      p95Value: value,
      sumValue: value,
      sampleCount: 1,
      gapSeconds: 0,
      metadata: { rollupVersion: 'metric-rollups-v1', source: 'raw' },
    })));
  }

  async function anomaliesFor(deviceId: string, anomalyType: string) {
    return getTestDb()
      .select()
      .from(metricAnomalies)
      .where(and(
        eq(metricAnomalies.orgId, orgId),
        eq(metricAnomalies.deviceId, deviceId),
        eq(metricAnomalies.anomalyType, anomalyType),
      ));
  }

  /**
   * r's baseline is [r-24h, r-15min) = bucket offsets -288..-4 (285 buckets).
   * Offset -288 (exactly r-24h) carries the baseline max, so it must be IN;
   * offset -289 and offsets -3..-1 carry larger values and must be OUT.
   */
  function baselineEdgePoints(r: Date, inside: number, edgeMax: number, outside: number, observed: number) {
    const points: Array<[Date, number]> = [];
    for (let offset = -287; offset <= -4; offset++) points.push([bucketAt(r, offset), inside]);
    points.push([bucketAt(r, -288), edgeMax]);
    points.push([bucketAt(r, -289), outside]);
    for (const offset of [-3, -2, -1]) points.push([bucketAt(r, offset), outside]);
    points.push([r, observed]);
    return points;
  }

  it('baseline: the window is exactly [r - 24h, r - 15min), across a monthly partition boundary', async () => {
    const device = await insertDevice('baseline-edges');
    const r = new Date('2026-12-01T06:00:00.000Z');
    await seed(device, CPU, baselineEdgePoints(r, 10, 20, 80, 95));

    await detectMetricAnomaliesRange({ orgId, from: r, to: bucketAt(r, 1) });

    const rows = await anomaliesFor(device, 'spike');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.windowStart.toISOString()).toBe(r.toISOString());
    expect(row.baselineMax).toBe(20);
    expect(row.baselineMin).toBe(10);
    expect((row.baselineSummary as Record<string, unknown>).baselineBuckets).toBe(285);
  });

  it('baseline: the last anchor of a production-shaped 15-minute scan keeps its full window', async () => {
    // The scan cron's window is [to - 15min, to): r is the last of three
    // anchors, so the upper scan bound (derived from `to`, not `from`) is the
    // one that must still admit r's buckets up to r - 20min.
    const device = await insertDevice('baseline-scan-window');
    const r = new Date('2026-12-01T06:00:00.000Z');
    await seed(device, CPU, baselineEdgePoints(r, 10, 20, 80, 95));

    await detectMetricAnomaliesRange({ orgId, from: bucketAt(r, -2), to: bucketAt(r, 1) });

    const row = (await anomaliesFor(device, 'spike')).find((a) => a.windowStart.toISOString() === r.toISOString());
    expect(row).toBeDefined();
    expect(row!.baselineMax).toBe(20);
    expect((row!.baselineSummary as Record<string, unknown>).baselineBuckets).toBe(285);
  });

  it('process-runaway: the same [r - 24h, r - 15min) window', async () => {
    const device = await insertDevice('process-edges');
    const r = new Date('2026-12-01T06:00:00.000Z');
    await seed(device, PROC_CPU, baselineEdgePoints(r, 10, 20, 85, 99));

    await detectMetricAnomaliesRange({ orgId, from: r, to: bucketAt(r, 1) });

    const rows = await anomaliesFor(device, 'process_runaway');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.baselineMax).toBe(20);
    expect((row.baselineSummary as Record<string, unknown>).baselineBuckets).toBe(285);
  });

  it('growth: the trend window is exactly (anchor - 30min, anchor], across a monthly partition boundary', async () => {
    const device = await insertDevice('growth-edges');
    const anchor = new Date('2026-12-01T00:10:00.000Z');
    await seed(device, RAM, [
      [bucketAt(anchor, -6), 5], // anchor - 30min: OUT
      [bucketAt(anchor, -5), 10],
      [bucketAt(anchor, -4), 14],
      [bucketAt(anchor, -3), 18],
      [bucketAt(anchor, -2), 22],
      [bucketAt(anchor, -1), 26],
      [anchor, 30],
    ]);

    await detectMetricAnomaliesRange({ orgId, from: anchor, to: bucketAt(anchor, 1) });

    const rows = await anomaliesFor(device, 'memory_growth');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.windowStart.toISOString()).toBe(bucketAt(anchor, -5).toISOString());
    expect(row.baselineValue).toBe(10);
    expect(row.observedValue).toBe(30);
    expect((row.baselineSummary as Record<string, unknown>).trendBuckets).toBe(6);
  });

  it('growth novelty: a prior high at exactly window_start - 7d suppresses; one bucket earlier does not', async () => {
    const anchor = new Date('2026-12-01T00:10:00.000Z');
    const windowStart = bucketAt(anchor, -5);
    const sevenDaysBuckets = (7 * 24 * 3600) / RAW_BUCKET_SECONDS;
    const climb: Array<[Date, number]> = [10, 14, 18, 22, 26, 30].map((v, i) => [bucketAt(windowStart, i), v]);

    const suppressed = await insertDevice('novelty-in-window');
    await seed(suppressed, RAM, [[bucketAt(windowStart, -sevenDaysBuckets), 35], ...climb]);
    const fires = await insertDevice('novelty-outside-window');
    await seed(fires, RAM, [[bucketAt(windowStart, -sevenDaysBuckets - 1), 35], ...climb]);

    await detectMetricAnomaliesRange({ orgId, from: anchor, to: bucketAt(anchor, 1) });

    expect(await anomaliesFor(suppressed, 'memory_growth')).toHaveLength(0);
    expect(await anomaliesFor(fires, 'memory_growth')).toHaveLength(1);
  });
});

type PlanNode = {
  'Node Type'?: string;
  'Relation Name'?: string;
  Alias?: string;
  'Index Cond'?: string;
  Plans?: PlanNode[];
};

function collectNodes(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
  out.push(node);
  for (const child of node.Plans ?? []) collectNodes(child, out);
  return out;
}

/**
 * EXPLAIN `statement` as breeze_app (system scope) with the probe shape forced
 * — a parameterized nested loop into an index scan, the shape production runs —
 * and return every scan of a `metric_rollups` partition under one of `aliases`.
 */
async function historyProbes(statement: SQL, aliases: string[]): Promise<PlanNode[]> {
  const plan = await withSystemDbAccessContext(async () => {
    await db.execute(sql`SET LOCAL enable_hashjoin = off`);
    await db.execute(sql`SET LOCAL enable_mergejoin = off`);
    await db.execute(sql`SET LOCAL enable_seqscan = off`);
    await db.execute(sql`SET LOCAL enable_bitmapscan = off`);
    const result = await db.execute(sql`EXPLAIN (FORMAT JSON) ${statement}`);
    const raw = (result as unknown as Array<Record<string, unknown>>)[0]?.['QUERY PLAN'];
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>;
  }, 'metricAnomalyScanBounds.explain');

  const aliasPattern = new RegExp(`^(${aliases.join('|')})(_\\d+)?$`);
  return collectNodes(plan[0]!.Plan).filter(
    (node) => node['Relation Name']?.startsWith('metric_rollups') && aliasPattern.test(node.Alias ?? ''),
  );
}

const LOWER_BUCKET_BOUND = /\bbucket_start >=? /;

describe('metric anomaly detector plan guard (#11559)', () => {
  const range = {
    orgId: '00000000-0000-4000-8000-000000000001',
    from: new Date('2026-11-23T11:45:00.000Z'),
    to: new Date('2026-11-23T12:00:00.000Z'),
  };

  it.each([
    ['baseline', () => buildBaselineDeviationsSql(range), ['b']],
    ['process-runaway', () => buildProcessSampleRunawaysSql(range), ['b']],
    ['growth-trend window + novelty', () => buildGrowthTrendsSql(range), ['w', 'p']],
  ] as const)('%s: every history probe bounds bucket_start from below in its Index Cond', async (_name, build, aliases) => {
    const probes = await historyProbes(build(), [...aliases]);

    // Non-vacuous: each probed alias is actually present in the plan.
    for (const alias of aliases) {
      expect(probes.some((node) => node.Alias === alias || node.Alias?.startsWith(`${alias}_`))).toBe(true);
    }
    for (const node of probes) {
      expect(node['Node Type'], `${node.Alias} on ${node['Relation Name']}`).toMatch(/Index/);
      expect(node['Index Cond'] ?? '', `${node.Alias} on ${node['Relation Name']}`).toMatch(LOWER_BUCKET_BOUND);
    }
  });
});
