import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { discoveredAssets, devices, deviceMetrics, deviceProcessSamples, metricRollups, snmpDevices, snmpMetrics } from '../../db/schema';
import {
  buildRawProcessSampleRollupStatement,
  rollupDeviceMetricsRange,
  type MetricRollupRange,
} from '../../services/metricRollups';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

/** The slice of an `EXPLAIN (FORMAT JSON)` node the #12583 plan-shape test reads. */
type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Cond'?: string;
  'Recheck Cond'?: string;
  Filter?: string;
  Plans?: PlanNode[];
};

const ORG_B_USER = '99999999-9999-4999-8999-999999999999';

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: ORG_B_USER,
    currentPartnerId: null,
  };
}

let agentIdCounter = 0;
async function insertDevice(options: { orgId: string; siteId: string; hostname: string }): Promise<string> {
  agentIdCounter++;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId: options.orgId,
      siteId: options.siteId,
      agentId: `metric-rollup-test-${Date.now()}-${agentIdCounter}`,
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

async function insertMetric(options: {
  orgId: string;
  deviceId: string;
  timestamp: Date;
  cpuPercent: number;
  /** #4341: leave every nullable column NULL, as an agent that reports no disk/network/process counters does. */
  nullableColumnsNull?: boolean;
}): Promise<void> {
  const nullable = options.nullableColumnsNull
    ? {
      diskReadBps: null, diskWriteBps: null,
      bandwidthInBps: null, bandwidthOutBps: null, processCount: null,
    }
    : {
      diskReadBps: 100, diskWriteBps: 200,
      bandwidthInBps: 300, bandwidthOutBps: 400, processCount: 50,
    };
  await (getTestDb() as any).insert(deviceMetrics).values({
    orgId: options.orgId,
    deviceId: options.deviceId,
    timestamp: options.timestamp,
    cpuPercent: options.cpuPercent,
    ramPercent: 50,
    ramUsedMb: 2048,
    diskPercent: 40,
    diskUsedGb: 120,
    ...nullable,
  });
}

async function insertProcessSample(options: {
  orgId: string;
  deviceId: string;
  timestamp: Date;
  cpu: number;
  ramMb: number;
  diskBps?: number;
  netBps?: number;
}): Promise<void> {
  await getTestDb().insert(deviceProcessSamples).values({
    orgId: options.orgId,
    deviceId: options.deviceId,
    timestamp: options.timestamp,
    agentTimestamp: options.timestamp,
    topProcesses: [{
      name: 'test-process',
      pid: 42,
      cpu: options.cpu,
      ramMb: options.ramMb,
      diskBps: options.diskBps,
      netBps: options.netBps,
    }],
  });
}

let ipCounter = 10;
async function insertSnmpDevice(options: {
  orgId: string;
  siteId?: string;
  linkedDeviceId?: string | null;
  name: string;
}): Promise<string> {
  ipCounter++;
  let assetId: string | null = null;
  if (options.siteId) {
    const [asset] = await getTestDb()
      .insert(discoveredAssets)
      .values({
        orgId: options.orgId,
        siteId: options.siteId,
        ipAddress: `10.60.0.${ipCounter}`,
        hostname: options.name,
        assetType: 'switch',
        approvalStatus: 'approved',
        isOnline: true,
        linkedDeviceId: options.linkedDeviceId ?? null,
        discoveryMethods: ['snmp'],
      })
      .returning({ id: discoveredAssets.id });
    if (!asset) throw new Error('insert discovered asset returned no row');
    assetId = asset.id;
  }

  const [device] = await getTestDb()
    .insert(snmpDevices)
    .values({
      orgId: options.orgId,
      assetId,
      name: options.name,
      ipAddress: `10.60.0.${ipCounter}`,
      snmpVersion: '2c',
      port: 161,
      pollingInterval: 300,
      isActive: true,
    })
    .returning({ id: snmpDevices.id });
  if (!device) throw new Error('insert SNMP device returned no row');
  return device.id;
}

async function insertSnmpMetric(options: {
  orgId: string;
  snmpDeviceId: string;
  oid: string;
  name: string;
  value: string;
  timestamp: Date;
}): Promise<void> {
  await getTestDb().insert(snmpMetrics).values({
    orgId: options.orgId,
    deviceId: options.snmpDeviceId,
    oid: options.oid,
    name: options.name,
    value: options.value,
    valueType: 'Gauge',
    timestamp: options.timestamp,
  });
}

async function runRollup(
  orgId: string,
  from: Date,
  to: Date,
  dayRollups?: MetricRollupRange['dayRollups'],
): Promise<void> {
  // Deliberately NO outer context wrap: this must exercise the same call shape
  // as jobs/metricRollups.ts — rollupDeviceMetricsRange opens its own labeled
  // context per statement. If a refactor ever drops that (e.g. removes the
  // runOutsideDbContext escape or the per-statement contexts), the statements
  // here would run contextless against forced RLS and fail loudly, instead of
  // an outer wrap silently absorbing them.
  await rollupDeviceMetricsRange({
    orgId,
    from,
    to,
    expectedSampleSeconds: 60,
    // Fixtures are dated 2026-06-18. Evaluate the #7531 5-minute retention
    // floor as of the window, not the wall clock, or the raw passes would be
    // (correctly) skipped once that date is more than 90 days old.
    now: to,
    ...(dayRollups === undefined ? {} : { dayRollups }),
  });
}

async function selectCpuRollups(orgId: string, deviceId: string) {
  return selectCpuRollupsForBucket(orgId, deviceId, 300);
}

async function selectCpuRollupsForBucket(orgId: string, deviceId: string, bucketSeconds: number) {
  return getTestDb()
    .select()
    .from(metricRollups)
    .where(and(
      eq(metricRollups.orgId, orgId),
      eq(metricRollups.deviceId, deviceId),
      eq(metricRollups.sourceTable, 'device_metrics'),
      eq(metricRollups.metricName, 'cpu_percent'),
      eq(metricRollups.bucketSeconds, bucketSeconds)
    ))
    .orderBy(metricRollups.bucketStart);
}

async function selectProcessRollups(orgId: string, deviceId: string, metricName: string) {
  return getTestDb()
    .select()
    .from(metricRollups)
    .where(and(
      eq(metricRollups.orgId, orgId),
      eq(metricRollups.deviceId, deviceId),
      eq(metricRollups.sourceTable, 'device_process_samples'),
      eq(metricRollups.metricName, metricName),
      eq(metricRollups.bucketSeconds, 300)
    ))
    .orderBy(metricRollups.bucketStart);
}

async function selectSnmpRollups(orgId: string, deviceId: string) {
  return getTestDb()
    .select()
    .from(metricRollups)
    .where(and(
      eq(metricRollups.orgId, orgId),
      eq(metricRollups.deviceId, deviceId),
      eq(metricRollups.sourceTable, 'snmp_metrics'),
      eq(metricRollups.metricType, 'snmp'),
      eq(metricRollups.bucketSeconds, 300)
    ))
    .orderBy(metricRollups.bucketStart);
}

describe('metric rollups integration', () => {
  let orgA: string;
  let orgB: string;
  let siteA: string;
  let siteB: string;

  beforeEach(async () => {
    const partner = await createPartner();
    const organizationA = await createOrganization({ partnerId: partner.id, name: 'Rollup Org A' });
    const organizationB = await createOrganization({ partnerId: partner.id, name: 'Rollup Org B' });
    orgA = organizationA.id;
    orgB = organizationB.id;
    siteA = (await createSite({ orgId: orgA, name: 'Rollup Site A' })).id;
    siteB = (await createSite({ orgId: orgB, name: 'Rollup Site B' })).id;
  });

  it('handles empty windows without writing rollups', async () => {
    const device = await insertDevice({ orgId: orgA, siteId: siteA, hostname: 'empty-window-device' });

    await runRollup(orgA, new Date('2026-06-18T12:00:00.000Z'), new Date('2026-06-18T12:15:00.000Z'));

    await expect(selectCpuRollups(orgA, device)).resolves.toHaveLength(0);
  });

  it('materializes sparse buckets and replay-updates late-arriving samples', async () => {
    const device = await insertDevice({ orgId: orgA, siteId: siteA, hostname: 'sparse-device' });
    await insertMetric({ orgId: orgA, deviceId: device, timestamp: new Date('2026-06-18T12:00:00.000Z'), cpuPercent: 10 });
    await insertMetric({ orgId: orgA, deviceId: device, timestamp: new Date('2026-06-18T12:10:00.000Z'), cpuPercent: 50 });

    const from = new Date('2026-06-18T12:00:00.000Z');
    const to = new Date('2026-06-18T12:15:00.000Z');
    await runRollup(orgA, from, to);

    const firstPass = await selectCpuRollups(orgA, device);
    expect(firstPass.map((row) => ({
      bucketStart: row.bucketStart.toISOString(),
      avgValue: row.avgValue,
      sampleCount: row.sampleCount,
      gapSeconds: row.gapSeconds,
      isGap: (row.metadata as Record<string, unknown>).isGap,
    }))).toEqual([
      { bucketStart: '2026-06-18T12:00:00.000Z', avgValue: 10, sampleCount: 1, gapSeconds: 240, isGap: false },
      { bucketStart: '2026-06-18T12:05:00.000Z', avgValue: null, sampleCount: 0, gapSeconds: 300, isGap: true },
      { bucketStart: '2026-06-18T12:10:00.000Z', avgValue: 50, sampleCount: 1, gapSeconds: 240, isGap: false },
    ]);

    await insertMetric({ orgId: orgA, deviceId: device, timestamp: new Date('2026-06-18T12:06:00.000Z'), cpuPercent: 30 });
    await runRollup(orgA, from, to);

    const secondPass = await selectCpuRollups(orgA, device);
    expect(secondPass).toHaveLength(3);
    const updatedGapBucket = secondPass[1];
    if (!updatedGapBucket) throw new Error('expected replay to preserve the middle bucket');
    expect(updatedGapBucket).toEqual(expect.objectContaining({
      avgValue: 30,
      sampleCount: 1,
      gapSeconds: 240,
    }));
    expect((updatedGapBucket.metadata as Record<string, unknown>).isGap).toBe(false);
  });

  it('recomputes derived buckets from the full target window on overlapping replays', async () => {
    const device = await insertDevice({ orgId: orgA, siteId: siteA, hostname: 'derived-replay-device' });
    await insertMetric({ orgId: orgA, deviceId: device, timestamp: new Date('2026-06-18T12:00:00.000Z'), cpuPercent: 10 });
    await insertMetric({ orgId: orgA, deviceId: device, timestamp: new Date('2026-06-18T12:05:00.000Z'), cpuPercent: 20 });
    await insertMetric({ orgId: orgA, deviceId: device, timestamp: new Date('2026-06-18T12:10:00.000Z'), cpuPercent: 30 });
    await insertMetric({ orgId: orgA, deviceId: device, timestamp: new Date('2026-06-18T12:15:00.000Z'), cpuPercent: 40 });

    await runRollup(orgA, new Date('2026-06-18T12:00:00.000Z'), new Date('2026-06-18T12:15:00.000Z'));

    const firstHourly = await selectCpuRollupsForBucket(orgA, device, 3600);
    expect(firstHourly).toHaveLength(1);
    expect(firstHourly[0]).toEqual(expect.objectContaining({
      bucketStart: new Date('2026-06-18T12:00:00.000Z'),
      avgValue: 20,
      sampleCount: 3,
      gapSeconds: 720,
    }));

    await runRollup(orgA, new Date('2026-06-18T12:05:00.000Z'), new Date('2026-06-18T12:20:00.000Z'));

    const replayedHourly = await selectCpuRollupsForBucket(orgA, device, 3600);
    expect(replayedHourly).toHaveLength(1);
    expect(replayedHourly[0]).toEqual(expect.objectContaining({
      bucketStart: new Date('2026-06-18T12:00:00.000Z'),
      avgValue: 25,
      sampleCount: 4,
      gapSeconds: 960,
    }));
  });

  // #4276 direction 1 — day buckets are re-derived only on the hourly :15 run,
  // which reaches back past midnight. A sample for the previous day's last hour
  // that lands on a skip run after midnight must still reach that day's bucket.
  it('folds a late sample from the previous day into its day bucket on the next day run', async () => {
    const device = await insertDevice({ orgId: orgA, siteId: siteA, hostname: 'day-boundary-device' });
    await insertMetric({ orgId: orgA, deviceId: device, timestamp: new Date('2026-06-18T23:05:00.000Z'), cpuPercent: 20 });

    // The 23:15 day run: the 18th's day bucket sees the one sample.
    await runRollup(
      orgA,
      new Date('2026-06-18T23:00:00.000Z'),
      new Date('2026-06-18T23:15:00.000Z'),
      { from: new Date('2026-06-18T20:00:00.000Z') },
    );
    const firstDay = await selectCpuRollupsForBucket(orgA, device, 86400);
    expect(firstDay).toHaveLength(1);
    expect(firstDay[0]).toEqual(expect.objectContaining({
      bucketStart: new Date('2026-06-18T00:00:00.000Z'),
      avgValue: 20,
      sampleCount: 1,
    }));

    // A sample at 23:58 is rolled up by the 00:10 run, which skips day passes:
    // the hour bucket moves, the day bucket must not (yet).
    await insertMetric({ orgId: orgA, deviceId: device, timestamp: new Date('2026-06-18T23:58:00.000Z'), cpuPercent: 40 });
    await runRollup(
      orgA,
      new Date('2026-06-18T23:55:00.000Z'),
      new Date('2026-06-19T00:10:00.000Z'),
      'skip',
    );
    const lateHour = await selectCpuRollupsForBucket(orgA, device, 3600);
    expect(lateHour.find((row) => row.bucketStart.getTime() === Date.parse('2026-06-18T23:00:00.000Z')))
      .toEqual(expect.objectContaining({ avgValue: 30, sampleCount: 2 }));
    const skippedDay = await selectCpuRollupsForBucket(orgA, device, 86400);
    expect(skippedDay).toHaveLength(1);
    expect(skippedDay[0]).toEqual(expect.objectContaining({ avgValue: 20, sampleCount: 1 }));

    // The 00:15 day run: its raw window is entirely on the 19th, but its day
    // window reaches back into the 18th and folds the late sample in.
    await runRollup(
      orgA,
      new Date('2026-06-19T00:00:00.000Z'),
      new Date('2026-06-19T00:15:00.000Z'),
      { from: new Date('2026-06-18T21:00:00.000Z') },
    );
    const foldedDay = await selectCpuRollupsForBucket(orgA, device, 86400);
    expect(foldedDay.find((row) => row.bucketStart.getTime() === Date.parse('2026-06-18T00:00:00.000Z')))
      .toEqual(expect.objectContaining({ avgValue: 30, sampleCount: 2 }));
  });

  it('materializes process sample buckets and replay-updates late process samples', async () => {
    const device = await insertDevice({ orgId: orgA, siteId: siteA, hostname: 'process-sample-device' });
    await insertProcessSample({
      orgId: orgA,
      deviceId: device,
      timestamp: new Date('2026-06-18T12:00:00.000Z'),
      cpu: 12,
      ramMb: 512,
      diskBps: 1000,
      netBps: 2000,
    });
    await insertProcessSample({
      orgId: orgA,
      deviceId: device,
      timestamp: new Date('2026-06-18T12:10:00.000Z'),
      cpu: 24,
      ramMb: 768,
      diskBps: 3000,
      netBps: 4000,
    });

    const from = new Date('2026-06-18T12:00:00.000Z');
    const to = new Date('2026-06-18T12:15:00.000Z');
    await runRollup(orgA, from, to);

    const cpuSumRollups = await selectProcessRollups(orgA, device, 'top_process_cpu_percent_sum');
    expect(cpuSumRollups.map((row) => ({
      bucketStart: row.bucketStart.toISOString(),
      avgValue: row.avgValue,
      sampleCount: row.sampleCount,
      gapSeconds: row.gapSeconds,
      isGap: (row.metadata as Record<string, unknown>).isGap,
    }))).toEqual([
      { bucketStart: '2026-06-18T12:00:00.000Z', avgValue: 12, sampleCount: 1, gapSeconds: 240, isGap: false },
      { bucketStart: '2026-06-18T12:05:00.000Z', avgValue: null, sampleCount: 0, gapSeconds: 300, isGap: true },
      { bucketStart: '2026-06-18T12:10:00.000Z', avgValue: 24, sampleCount: 1, gapSeconds: 240, isGap: false },
    ]);

    const ramMaxRollups = await selectProcessRollups(orgA, device, 'top_process_ram_mb_max');
    expect(ramMaxRollups.map((row) => row.avgValue)).toEqual([512, null, 768]);

    await insertProcessSample({
      orgId: orgA,
      deviceId: device,
      timestamp: new Date('2026-06-18T12:06:00.000Z'),
      cpu: 90,
      ramMb: 2048,
      diskBps: 5000,
      netBps: 6000,
    });
    await runRollup(orgA, from, to);

    const replayedCpuRollups = await selectProcessRollups(orgA, device, 'top_process_cpu_percent_sum');
    expect(replayedCpuRollups).toHaveLength(3);
    const updatedGapBucket = replayedCpuRollups[1];
    if (!updatedGapBucket) throw new Error('expected replay to preserve the middle process bucket');
    expect(updatedGapBucket).toEqual(expect.objectContaining({
      avgValue: 90,
      sampleCount: 1,
      gapSeconds: 240,
    }));
    expect((updatedGapBucket.metadata as Record<string, unknown>).isGap).toBe(false);
  });

  // #12583 — the process-sample statement used to read its window twice and,
  // under forced RLS, could not seek it: the timestamptz column was compared
  // to `::timestamp` bounds, a cross-type operator that is not leakproof, so
  // Postgres kept it out of the index condition and every scan walked the org's
  // whole retained history. These pin the outputs across the rewrite and the
  // plan shape that makes the window a single index range read.
  describe('#12583 process-sample window read', () => {
    const from = new Date('2026-06-18T12:00:00.000Z');
    const to = new Date('2026-06-18T12:15:00.000Z');

    async function insertPayload(orgId: string, deviceId: string, timestamp: string, topProcesses: unknown): Promise<void> {
      await getTestDb().insert(deviceProcessSamples).values({
        orgId,
        deviceId,
        timestamp: new Date(timestamp),
        agentTimestamp: new Date(timestamp),
        topProcesses: topProcesses as never,
      });
    }

    async function processRows(orgId: string) {
      const rows = await getTestDb()
        .select()
        .from(metricRollups)
        .where(and(
          eq(metricRollups.orgId, orgId),
          eq(metricRollups.sourceTable, 'device_process_samples'),
          eq(metricRollups.bucketSeconds, 300)
        ));
      return rows;
    }

    it('keeps window edges, empty and non-numeric payloads, gap rows and org scoping unchanged', async () => {
      const busy = await insertDevice({ orgId: orgA, siteId: siteA, hostname: 'edges-busy' });
      const sparse = await insertDevice({ orgId: orgA, siteId: siteA, hostname: 'edges-sparse' });
      const outside = await insertDevice({ orgId: orgA, siteId: siteA, hostname: 'edges-outside' });
      const otherOrg = await insertDevice({ orgId: orgB, siteId: siteB, hostname: 'edges-other-org' });

      // Excluded on both sides: [from, to) is half-open.
      await insertPayload(orgA, busy, '2026-06-18T11:59:59.000Z', [{ cpu: 999, ramMb: 999 }]);
      await insertPayload(orgA, busy, '2026-06-18T12:15:00.000Z', [{ cpu: 999, ramMb: 999 }]);
      // Bucket 12:00 — a sample exactly at `from` and one just before the bucket edge.
      await insertPayload(orgA, busy, '2026-06-18T12:00:00.000Z', [
        { cpu: 10, ramMb: 100, diskBps: 1, netBps: 2 },
        { cpu: 5, ramMb: 50 },
      ]);
      await insertPayload(orgA, busy, '2026-06-18T12:04:59.999Z', [{ cpu: 20, ramMb: 300 }]);
      // Bucket 12:05 — an empty process list still counts as a sample of zeros.
      await insertPayload(orgA, busy, '2026-06-18T12:05:00.000Z', []);
      // Bucket 12:10 — non-numeric values and non-object elements are skipped.
      await insertPayload(orgA, busy, '2026-06-18T12:10:00.000Z', [
        { cpu: '12.5', ramMb: null, diskBps: 7 },
        7,
        'x',
      ]);
      // One populated bucket: the other two become gap rows.
      await insertPayload(orgA, sparse, '2026-06-18T12:00:00.000Z', [{ cpu: 1, ramMb: 1 }]);
      // Only samples outside the window: the device gets no rows at all.
      await insertPayload(orgA, outside, '2026-06-18T12:15:00.000Z', [{ cpu: 1, ramMb: 1 }]);
      // Another org's sample inside the window is never read by orgA's pass.
      await insertPayload(orgB, otherOrg, '2026-06-18T12:05:00.000Z', [{ cpu: 1, ramMb: 1 }]);

      await runRollup(orgA, from, to);

      const rows = await processRows(orgA);
      expect(rows).toHaveLength(2 * 7 * 3);
      expect(new Set(rows.map((row) => row.deviceId))).toEqual(new Set([busy, sparse]));
      await expect(processRows(orgB)).resolves.toHaveLength(0);

      const pick = (deviceId: string, metricName: string) => rows
        .filter((row) => row.deviceId === deviceId && row.metricName === metricName)
        .sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime())
        .map((row) => ({
          bucket: row.bucketStart.toISOString().slice(11, 16),
          avg: row.avgValue, min: row.minValue, max: row.maxValue, p95: row.p95Value,
          sum: row.sumValue, count: row.sampleCount, gap: row.gapSeconds,
          isGap: (row.metadata as Record<string, unknown>).isGap,
        }));

      expect(pick(busy, 'top_process_count')).toEqual([
        { bucket: '12:00', avg: 1.5, min: 1, max: 2, p95: 1.95, sum: 3, count: 2, gap: 180, isGap: false },
        { bucket: '12:05', avg: 0, min: 0, max: 0, p95: 0, sum: 0, count: 1, gap: 240, isGap: false },
        { bucket: '12:10', avg: 3, min: 3, max: 3, p95: 3, sum: 3, count: 1, gap: 240, isGap: false },
      ]);
      expect(pick(busy, 'top_process_cpu_percent_sum')).toEqual([
        { bucket: '12:00', avg: 17.5, min: 15, max: 20, p95: 19.75, sum: 35, count: 2, gap: 180, isGap: false },
        { bucket: '12:05', avg: 0, min: 0, max: 0, p95: 0, sum: 0, count: 1, gap: 240, isGap: false },
        { bucket: '12:10', avg: 0, min: 0, max: 0, p95: 0, sum: 0, count: 1, gap: 240, isGap: false },
      ]);
      expect(pick(busy, 'top_process_ram_mb_max').map((row) => row.avg)).toEqual([200, 0, 0]);
      expect(pick(busy, 'top_process_disk_bps_sum').map((row) => row.avg)).toEqual([0.5, 0, 7]);
      expect(pick(busy, 'top_process_net_bps_sum').map((row) => row.avg)).toEqual([1, 0, 0]);

      expect(pick(sparse, 'top_process_cpu_percent_max')).toEqual([
        { bucket: '12:00', avg: 1, min: 1, max: 1, p95: 1, sum: 1, count: 1, gap: 240, isGap: false },
        { bucket: '12:05', avg: null, min: null, max: null, p95: null, sum: null, count: 0, gap: 300, isGap: true },
        { bucket: '12:10', avg: null, min: null, max: null, p95: null, sum: null, count: 0, gap: 300, isGap: true },
      ]);
    });

    it('reads the window once, as an (org_id, timestamp) index range, under forced RLS', async () => {
      const device = await insertDevice({ orgId: orgA, siteId: siteA, hostname: 'plan-shape-device' });
      await insertPayload(orgA, device, '2026-06-18T12:00:00.000Z', [{ cpu: 1, ramMb: 1 }]);

      // The app pool (breeze_app, RLS forced) under system scope, as the worker
      // runs it — the superuser test client has no RLS qual and would never
      // show the leak-proofness problem. The tables are tiny, so turn off
      // sequential scans to make the planner show which predicates an index
      // can take. EXPLAIN without ANALYZE: the INSERT is planned, not run.
      const plan = await withSystemDbAccessContext(async () => {
        await db.execute(sql`SET LOCAL enable_seqscan = off`);
        const result = await db.execute(
          sql`EXPLAIN (FORMAT JSON) ${buildRawProcessSampleRollupStatement({ orgId: orgA, from, to })}`
        );
        const first = (result as unknown as Array<Record<string, unknown>>)[0]!;
        const raw = first['QUERY PLAN'];
        return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>;
      });

      const scans: PlanNode[] = [];
      const visit = (node: PlanNode) => {
        if (node['Relation Name'] === 'device_process_samples') scans.push(node);
        for (const child of node.Plans ?? []) visit(child);
      };
      visit(plan[0]!.Plan);

      expect(scans).toHaveLength(1);
      const scan = scans[0]!;
      const indexCondition = scan['Node Type'] === 'Bitmap Heap Scan'
        ? scan['Recheck Cond']
        : scan['Index Cond'];
      expect(scan['Node Type']).not.toBe('Seq Scan');
      expect(indexCondition).toMatch(/org_id = /);
      expect(indexCondition).toMatch(/"timestamp" >= /);
      expect(indexCondition).toMatch(/"timestamp" < /);
      expect(scan.Filter ?? '').not.toMatch(/"timestamp"/);
    });
  });

  // #4341 — the raw passes went from one statement per metric (10 over
  // device_metrics, 7 over device_process_samples) to one statement per source
  // table. These two pin the properties that a single shared bucket grid could
  // most plausibly break: that every series is still emitted, and that a series
  // whose column is NULL for the whole window is still emitted for NO buckets
  // rather than a window's worth of `isGap` rows.
  describe('#4341 single-pass raw rollups', () => {
    it('emits every device_metrics and process-sample series from one pass per source table', async () => {
      const device = await insertDevice({ orgId: orgA, siteId: siteA, hostname: 'all-series-device' });
      await insertMetric({ orgId: orgA, deviceId: device, timestamp: new Date('2026-06-18T12:00:00.000Z'), cpuPercent: 10 });
      await insertMetric({ orgId: orgA, deviceId: device, timestamp: new Date('2026-06-18T12:01:00.000Z'), cpuPercent: 30 });
      await insertProcessSample({
        orgId: orgA, deviceId: device, timestamp: new Date('2026-06-18T12:00:00.000Z'),
        cpu: 12, ramMb: 512, diskBps: 1000, netBps: 2000,
      });

      await runRollup(orgA, new Date('2026-06-18T12:00:00.000Z'), new Date('2026-06-18T12:05:00.000Z'));

      const rows = await getTestDb()
        .select()
        .from(metricRollups)
        .where(and(
          eq(metricRollups.orgId, orgA),
          eq(metricRollups.deviceId, device),
          eq(metricRollups.bucketSeconds, 300)
        ));

      const byName = new Map(rows.map((row) => [row.metricName, row]));
      expect([...byName.keys()].sort()).toEqual([
        'bandwidth_in_bps', 'bandwidth_out_bps', 'cpu_percent', 'disk_percent',
        'disk_read_bps', 'disk_used_gb', 'disk_write_bps', 'process_count',
        'ram_percent', 'ram_used_mb',
        'top_process_count', 'top_process_cpu_percent_max', 'top_process_cpu_percent_sum',
        'top_process_disk_bps_sum', 'top_process_net_bps_sum',
        'top_process_ram_mb_max', 'top_process_ram_mb_sum',
      ]);

      // metric_type still travels with its own series, not the first one's.
      expect(byName.get('cpu_percent')?.metricType).toBe('cpu');
      expect(byName.get('ram_used_mb')?.metricType).toBe('memory');
      expect(byName.get('bandwidth_in_bps')?.metricType).toBe('network');
      expect(byName.get('process_count')?.metricType).toBe('process');
      expect(byName.get('top_process_ram_mb_sum')?.sourceTable).toBe('device_process_samples');

      // Each series aggregates its OWN column, so every aggregate must carry
      // that column's numbers — not the first series', and not a mix.
      expect(byName.get('cpu_percent')).toEqual(expect.objectContaining({
        avgValue: 20,      // (10 + 30) / 2
        minValue: 10,
        maxValue: 30,
        p95Value: 29,      // percentile_cont(0.95) over [10, 30]
        sumValue: 40,
        sampleCount: 2,
        gapSeconds: 180,   // 300 - 2 * expectedSampleSeconds(60)
      }));
      expect(byName.get('cpu_percent')?.metadata).toEqual({
        rollupVersion: 'metric-rollups-v1',
        source: 'raw',
        expectedSampleSeconds: 60,
        isGap: false,
      });

      expect(byName.get('ram_used_mb')).toEqual(expect.objectContaining({
        avgValue: 2048, minValue: 2048, maxValue: 2048, sumValue: 4096, sampleCount: 2,
      }));

      expect(byName.get('top_process_ram_mb_sum')).toEqual(expect.objectContaining({
        avgValue: 512, minValue: 512, maxValue: 512, p95Value: 512, sumValue: 512,
        sampleCount: 1,
        gapSeconds: 240,   // 300 - 1 * 60
      }));
      expect(byName.get('top_process_net_bps_sum')?.avgValue).toBe(2000);
      expect(byName.get('top_process_disk_bps_sum')?.avgValue).toBe(1000);
      expect(byName.get('top_process_cpu_percent_max')?.avgValue).toBe(12);
      expect(byName.get('top_process_count')?.avgValue).toBe(1);
      expect(byName.get('top_process_count')?.metadata).toEqual({
        rollupVersion: 'metric-rollups-v1',
        source: 'raw',
        sourceTable: 'device_process_samples',
        expectedSampleSeconds: 60,
        isGap: false,
      });
    });

    it('emits no rollups for a device_metrics column that is NULL across the whole window', async () => {
      const device = await insertDevice({ orgId: orgA, siteId: siteA, hostname: 'null-columns-device' });
      await insertMetric({
        orgId: orgA, deviceId: device, timestamp: new Date('2026-06-18T12:00:00.000Z'),
        cpuPercent: 10, nullableColumnsNull: true,
      });

      await runRollup(orgA, new Date('2026-06-18T12:00:00.000Z'), new Date('2026-06-18T12:10:00.000Z'));

      const names = (await getTestDb()
        .select()
        .from(metricRollups)
        .where(and(
          eq(metricRollups.orgId, orgA),
          eq(metricRollups.deviceId, device),
          eq(metricRollups.sourceTable, 'device_metrics'),
          eq(metricRollups.bucketSeconds, 300)
        )))
        .map((row) => row.metricName);

      // The NOT NULL columns still roll up (two 300s buckets each, one of them a gap).
      expect(names.filter((name) => name === 'cpu_percent')).toHaveLength(2);
      // The nullable ones must produce nothing at all — not gap rows.
      for (const name of ['disk_read_bps', 'disk_write_bps', 'bandwidth_in_bps', 'bandwidth_out_bps', 'process_count']) {
        expect(names).not.toContain(name);
      }
    });
  });

  it('materializes linked SNMP metric buckets and ignores unlinked or non-numeric SNMP series', async () => {
    const device = await insertDevice({ orgId: orgA, siteId: siteA, hostname: 'snmp-linked-device' });
    const linkedSnmpDevice = await insertSnmpDevice({
      orgId: orgA,
      siteId: siteA,
      linkedDeviceId: device,
      name: 'linked-switch',
    });
    const unlinkedSnmpDevice = await insertSnmpDevice({
      orgId: orgA,
      siteId: siteA,
      linkedDeviceId: null,
      name: 'unlinked-switch',
    });
    const assetlessSnmpDevice = await insertSnmpDevice({
      orgId: orgA,
      name: 'assetless-switch',
    });

    await insertSnmpMetric({
      orgId: orgA,
      snmpDeviceId: linkedSnmpDevice,
      oid: '1.3.6.1.2.1.25.3.3.1.2',
      name: 'hrProcessorLoad',
      value: '12.5',
      timestamp: new Date('2026-06-18T12:00:00.000Z'),
    });
    await insertSnmpMetric({
      orgId: orgA,
      snmpDeviceId: linkedSnmpDevice,
      oid: '1.3.6.1.2.1.25.3.3.1.2',
      name: 'hrProcessorLoad',
      value: '40',
      timestamp: new Date('2026-06-18T12:10:00.000Z'),
    });
    await insertSnmpMetric({
      orgId: orgA,
      snmpDeviceId: linkedSnmpDevice,
      oid: '1.3.6.1.2.1.1.5.0',
      name: 'sysName',
      value: 'switch-a',
      timestamp: new Date('2026-06-18T12:00:00.000Z'),
    });
    await insertSnmpMetric({
      orgId: orgA,
      snmpDeviceId: unlinkedSnmpDevice,
      oid: '1.3.6.1.2.1.25.3.3.1.2',
      name: 'hrProcessorLoad',
      value: '99',
      timestamp: new Date('2026-06-18T12:00:00.000Z'),
    });
    await insertSnmpMetric({
      orgId: orgA,
      snmpDeviceId: assetlessSnmpDevice,
      oid: '1.3.6.1.2.1.25.3.3.1.2',
      name: 'hrProcessorLoad',
      value: '88',
      timestamp: new Date('2026-06-18T12:00:00.000Z'),
    });

    const from = new Date('2026-06-18T12:00:00.000Z');
    const to = new Date('2026-06-18T12:15:00.000Z');
    await runRollup(orgA, from, to);

    const rollups = await selectSnmpRollups(orgA, device);
    expect(rollups.map((row) => ({
      bucketStart: row.bucketStart.toISOString(),
      avgValue: row.avgValue,
      sampleCount: row.sampleCount,
      gapSeconds: row.gapSeconds,
      isGap: (row.metadata as Record<string, unknown>).isGap,
      oid: (row.metadata as Record<string, unknown>).oid,
      displayName: (row.metadata as Record<string, unknown>).displayName,
    }))).toEqual([
      {
        bucketStart: '2026-06-18T12:00:00.000Z',
        avgValue: 12.5,
        sampleCount: 1,
        gapSeconds: 240,
        isGap: false,
        oid: '1.3.6.1.2.1.25.3.3.1.2',
        displayName: 'hrProcessorLoad',
      },
      {
        bucketStart: '2026-06-18T12:05:00.000Z',
        avgValue: null,
        sampleCount: 0,
        gapSeconds: 300,
        isGap: true,
        oid: '1.3.6.1.2.1.25.3.3.1.2',
        displayName: 'hrProcessorLoad',
      },
      {
        bucketStart: '2026-06-18T12:10:00.000Z',
        avgValue: 40,
        sampleCount: 1,
        gapSeconds: 240,
        isGap: false,
        oid: '1.3.6.1.2.1.25.3.3.1.2',
        displayName: 'hrProcessorLoad',
      },
    ]);

    expect(rollups.every((row) => row.metricName.startsWith('1.3.6.1.2.1.25.3.3.1.2:'))).toBe(true);
    expect(rollups.some((row) => (row.metadata as Record<string, unknown>).displayName === 'sysName')).toBe(false);
  });

  it('enforces org RLS for metric rollup reads and forged writes', async () => {
    const deviceA = await insertDevice({ orgId: orgA, siteId: siteA, hostname: 'org-a-device' });
    const deviceB = await insertDevice({ orgId: orgB, siteId: siteB, hostname: 'org-b-device' });
    await insertMetric({ orgId: orgA, deviceId: deviceA, timestamp: new Date('2026-06-18T12:00:00.000Z'), cpuPercent: 42 });
    await runRollup(orgA, new Date('2026-06-18T12:00:00.000Z'), new Date('2026-06-18T12:05:00.000Z'));

    const visibleToOrgB = await withDbAccessContext(orgContext(orgB), () =>
      db
        .select()
        .from(metricRollups)
        .where(eq(metricRollups.metricName, 'cpu_percent'))
    );
    expect(visibleToOrgB).toHaveLength(0);

    await expect(async () => {
      try {
        await withDbAccessContext(orgContext(orgB), () =>
          db.insert(metricRollups).values({
            orgId: orgA,
            sourceTable: 'device_metrics',
            deviceId: deviceB,
            metricType: 'cpu',
            metricName: 'cpu_percent',
            bucketStart: new Date('2026-06-18T12:00:00.000Z'),
            bucketSeconds: 300,
            avgValue: 99,
            minValue: 99,
            maxValue: 99,
            sampleCount: 1,
            gapSeconds: 0,
            metadata: { forged: true },
          })
        );
      } catch (error) {
        expect((error as { cause?: { code?: string } }).cause?.code).toBe('42501');
        throw error;
      }
    }).rejects.toThrow(/metric_rollups/);
  });
});
