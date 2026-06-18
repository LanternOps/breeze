import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { discoveredAssets, devices, deviceMetrics, deviceProcessSamples, metricRollups, snmpDevices, snmpMetrics } from '../../db/schema';
import { rollupDeviceMetricsRange } from '../../services/metricRollups';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

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
}): Promise<void> {
  await (getTestDb() as any).insert(deviceMetrics).values({
    orgId: options.orgId,
    deviceId: options.deviceId,
    timestamp: options.timestamp,
    cpuPercent: options.cpuPercent,
    ramPercent: 50,
    ramUsedMb: 2048,
    diskPercent: 40,
    diskUsedGb: 120,
    diskReadBps: 100,
    diskWriteBps: 200,
    bandwidthInBps: 300,
    bandwidthOutBps: 400,
    processCount: 50,
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

async function runRollup(orgId: string, from: Date, to: Date): Promise<void> {
  await withSystemDbAccessContext(() =>
    rollupDeviceMetricsRange({
      orgId,
      from,
      to,
      expectedSampleSeconds: 60,
    })
  );
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

    expect(rollups.every((row) => row.metricName.startsWith('hrProcessorLoad:'))).toBe(true);
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
