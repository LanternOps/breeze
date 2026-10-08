import '../../__tests__/integration/setup';
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { deviceMetrics, devices, metricRollups } from '../../db/schema';
import { createOrganization, createPartner, createSite } from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { performanceDeviceSeries, performanceOverview } from './performanceReadModel';

const NOW = new Date('2026-10-07T12:00:00.000Z');
const BUCKET = new Date('2026-10-07T11:55:00.000Z');

function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

async function seedDevice(orgId: string, siteId: string, marker: string) {
  const testDb = getTestDb();
  const [device] = await testDb.insert(devices).values({
    orgId,
    siteId,
    agentId: randomUUID().replace(/-/g, ''),
    hostname: `${marker}-host`,
    osType: 'linux',
    osVersion: '1.0',
    architecture: 'amd64',
    agentVersion: '1.0.0',
  }).returning({ id: devices.id });
  if (!device) throw new Error('device seed failed');

  await testDb.insert(metricRollups).values([
    {
      orgId,
      sourceTable: 'device_metrics',
      deviceId: device.id,
      metricType: 'cpu',
      metricName: 'cpu_percent',
      bucketStart: BUCKET,
      bucketSeconds: 300,
      avgValue: marker === 'ORG-A' ? 21 : 91,
      maxValue: marker === 'ORG-A' ? 42 : 99,
      sampleCount: 2,
      gapSeconds: 0,
    },
    {
      orgId,
      sourceTable: 'device_metrics',
      deviceId: device.id,
      metricType: 'process',
      metricName: 'process_count',
      bucketStart: BUCKET,
      bucketSeconds: 300,
      avgValue: 999,
      maxValue: 999,
      sampleCount: 2,
      gapSeconds: 0,
    },
  ]);

  await (testDb as any).insert(deviceMetrics).values({
    orgId,
    deviceId: device.id,
    timestamp: BUCKET,
    cpuPercent: marker === 'ORG-A' ? 21 : 91,
    ramPercent: 50,
    ramUsedMb: 4096,
    diskPercent: 40,
    diskUsedGb: 100,
    diskReadBytes: 123456789n,
    diskWriteBytes: 987654321n,
    diskReadOps: 123n,
    diskWriteOps: 456n,
    networkInBytes: marker === 'ORG-A' ? 1000n : 9000n,
    networkOutBytes: marker === 'ORG-A' ? 2000n : 8000n,
    bandwidthInBps: 100n,
    bandwidthOutBps: 200n,
    processCount: 777,
    customMetrics: { plantedSecret: `${marker}-CUSTOM-SECRET` },
    interfaceStats: [{
      name: `${marker}-eth0`,
      speed: 1_000_000_000,
      inBytesPerSec: 111,
      outBytesPerSec: 222,
      inErrors: 3,
      outErrors: 4,
      inBytes: 11111111,
      outBytes: 22222222,
      inPackets: 33333333,
      outPackets: 44444444,
    }],
  });

  return device.id;
}

describe('performanceReadModel org isolation (#7733)', () => {
  it('keeps org/device tenancy and the closed performance projection under real Postgres', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: orgA.id });
    const siteB = await createSite({ orgId: orgB.id });
    const deviceA = await seedDevice(orgA.id, siteA.id, 'ORG-A');
    const deviceB = await seedDevice(orgB.id, siteB.id, 'ORG-B');
    const ctxA = orgContext(orgA.id, partner.id);
    const ctxB = orgContext(orgB.id, partner.id);

    const overviewA = await withDbAccessContext(ctxA, () => performanceOverview(orgA.id, '24h', NOW));
    expect(overviewA.dataStatus).toBe('ok');
    expect(overviewA.series[0]?.metrics.cpuPercent).toEqual({ average: 21, maximum: 42 });
    expect(overviewA.networkVolume[0]).toMatchObject({ networkInBytes: 1000, networkOutBytes: 2000 });

    const detailA = await withDbAccessContext(ctxA, () => performanceDeviceSeries(orgA.id, deviceA, '24h', NOW));
    expect(detailA?.device.id).toBe(deviceA);
    expect(detailA?.interfaces[0]?.interfaces[0]).toEqual({
      name: 'ORG-A-eth0',
      speed: 1_000_000_000,
      inBytesPerSec: 111,
      outBytesPerSec: 222,
      inErrors: 3,
      outErrors: 4,
    });

    const json = JSON.stringify({ overviewA, detailA });
    expect(json).not.toContain('ORG-B');
    expect(json).not.toContain(deviceB);
    expect(json).not.toContain('CUSTOM-SECRET');
    for (const forbidden of ['processCount', 'customMetrics', 'diskReadBytes', 'diskWriteBytes', 'diskReadOps', 'diskWriteOps', 'inBytes"', 'outBytes"', 'inPackets', 'outPackets']) {
      expect(json).not.toContain(forbidden);
    }

    // Forged cross-org device ids are indistinguishable from missing devices.
    expect(await withDbAccessContext(ctxA, () => performanceDeviceSeries(orgA.id, deviceB, '24h', NOW))).toBeNull();
    expect(await withDbAccessContext(ctxB, () => performanceDeviceSeries(orgB.id, deviceA, '24h', NOW))).toBeNull();

    // Database-level proof: an org-A RLS context cannot force reads through org B.
    const forced = await withDbAccessContext(ctxA, () => performanceOverview(orgB.id, '24h', NOW));
    expect(forced.dataStatus).toBe('no_data');
    expect(forced.series).toEqual([]);
    expect(forced.networkVolume).toEqual([]);
  });
});
