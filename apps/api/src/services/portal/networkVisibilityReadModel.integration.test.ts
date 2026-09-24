import '../../__tests__/integration/setup';
import { describe, expect, it } from 'vitest';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import {
  discoveredAssets,
  networkMonitorResults,
  networkMonitors,
  snmpDevices,
} from '../../db/schema';
import {
  createOrganization,
  createPartner,
  createSite,
} from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { networkAssets, networkOverview } from './networkVisibilityReadModel';

const NOW = new Date('2026-09-17T12:00:00.000Z');

const NO_DATA = {
  dataStatus: 'no_data',
  totalAssets: null,
  onlineAssets: null,
  offlineAssets: null,
  snmpDevicesPolling: null,
  monitorsDown: null,
} as const;

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

describe('networkVisibilityReadModel (#5861)', () => {
  it('isolates org data, derives reachability, and uses each org latest partner-wide result', async () => {
    const testDb = getTestDb();

    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });

    const siteA = await createSite({ orgId: orgA.id });
    const siteB = await createSite({ orgId: orgB.id });

    const [assetAOnline, assetAOffline, assetAUnverified] = await testDb
      .insert(discoveredAssets)
      .values([
        {
          orgId: orgA.id,
          siteId: siteA.id,
          ipAddress: '10.10.1.10',
          hostname: 'a-core-01',
          assetType: 'switch',
          source: 'manual',
          isOnline: true,
          statusObservedAt: new Date('2026-09-17T11:59:00.000Z'),
          statusSource: 'scan',
          lastSeenAt: new Date('2026-09-17T11:59:00.000Z'),
        },
        {
          orgId: orgA.id,
          siteId: siteA.id,
          ipAddress: '10.10.1.11',
          hostname: 'a-edge-01',
          assetType: 'router',
          source: 'manual',
          isOnline: false,
          statusObservedAt: new Date('2026-09-17T11:59:00.000Z'),
          statusSource: 'scan',
          lastSeenAt: new Date('2026-09-17T11:00:00.000Z'),
        },
        {
          orgId: orgA.id,
          siteId: siteA.id,
          ipAddress: '10.10.1.12',
          hostname: 'a-unverified-01',
          assetType: 'switch',
          source: 'manual',
          // Raw false must NOT automatically become portal "offline".
          isOnline: false,
          statusObservedAt: new Date('2026-09-15T10:00:00.000Z'),
          statusSource: 'scan',
          lastSeenAt: new Date('2026-09-15T10:00:00.000Z'),
        },
      ])
      .returning();

    const [assetB] = await testDb
      .insert(discoveredAssets)
      .values({
        orgId: orgB.id,
        siteId: siteB.id,
        ipAddress: '10.20.1.10',
        hostname: 'b-core-01',
        assetType: 'switch',
        source: 'manual',
        isOnline: true,
        statusObservedAt: new Date('2026-09-17T11:59:00.000Z'),
        statusSource: 'scan',
        lastSeenAt: new Date('2026-09-17T11:59:00.000Z'),
      })
      .returning();

    await testDb.insert(snmpDevices).values([
      {
        orgId: orgA.id,
        assetId: assetAOnline!.id,
        name: 'a-core-01',
        ipAddress: '10.10.1.10',
        snmpVersion: 'v2c',
        isActive: true,
        lastStatus: 'online',
        lastPolled: new Date('2026-09-17T11:59:30.000Z'),
        lastPollAttemptedAt: new Date('2026-09-17T11:59:30.000Z'),
      },
      {
        orgId: orgA.id,
        assetId: assetAUnverified!.id,
        name: 'a-unverified-01',
        ipAddress: '10.10.1.12',
        snmpVersion: 'v2c',
        isActive: true,
        // A protocol failure is detail only. It must not make this host offline.
        lastStatus: 'offline',
        lastPollAttemptedAt: new Date('2026-09-17T11:59:30.000Z'),
      },
      {
        orgId: orgB.id,
        assetId: assetB!.id,
        name: 'b-core-01',
        ipAddress: '10.20.1.10',
        snmpVersion: 'v2c',
        isActive: true,
        lastStatus: 'online',
        lastPolled: new Date('2026-09-17T11:59:30.000Z'),
        lastPollAttemptedAt: new Date('2026-09-17T11:59:30.000Z'),
      },
    ]);

    // One shared definition fans out to both organizations.
    //
    // The shared lastStatus is intentionally offline. Org B's latest execution
    // result is online, so any implementation reading network_monitors.lastStatus
    // would incorrectly report Org B as down.
    const [monitor] = await testDb
      .insert(networkMonitors)
      .values({
        partnerId: partner.id,
        name: 'Partner ICMP health',
        monitorType: 'icmp_ping',
        target: 'gateway.example.test',
        pollingInterval: 3600,
        isActive: true,
        lastStatus: 'offline',
      })
      .returning();

    await testDb.insert(networkMonitorResults).values([
      {
        monitorId: monitor!.id,
        orgId: orgA.id,
        status: 'online',
        timestamp: new Date('2026-09-17T10:00:00.000Z'),
      },
      {
        monitorId: monitor!.id,
        orgId: orgA.id,
        status: 'offline',
        timestamp: new Date('2026-09-17T11:00:00.000Z'),
      },
      {
        monitorId: monitor!.id,
        orgId: orgB.id,
        status: 'offline',
        timestamp: new Date('2026-09-17T10:00:00.000Z'),
      },
      {
        monitorId: monitor!.id,
        orgId: orgB.id,
        status: 'online',
        timestamp: new Date('2026-09-17T11:00:00.000Z'),
      },
    ]);

    const overviewA = await withDbAccessContext(
      orgContext(orgA.id, partner.id),
      () => networkOverview(orgA.id, NOW),
    );

    const overviewB = await withDbAccessContext(
      orgContext(orgB.id, partner.id),
      () => networkOverview(orgB.id, NOW),
    );

    const orgAReadingOrgB = await withDbAccessContext(
      orgContext(orgA.id, partner.id),
      () => networkOverview(orgB.id, NOW),
    );

    const orgBReadingOrgA = await withDbAccessContext(
      orgContext(orgB.id, partner.id),
      () => networkOverview(orgA.id, NOW),
    );

    expect(overviewA).toEqual({
      dataStatus: 'ok',
      totalAssets: 3,
      // The third asset is unverified and therefore belongs to neither count.
      onlineAssets: 1,
      offlineAssets: 1,
      // Only detail.snmp.state === 'ok' counts as successfully polling.
      snmpDevicesPolling: 1,
      monitorsDown: 1,
    });

    expect(overviewB).toEqual({
      dataStatus: 'ok',
      totalAssets: 1,
      onlineAssets: 1,
      offlineAssets: 0,
      snmpDevicesPolling: 1,
      monitorsDown: 0,
    });

    expect(orgAReadingOrgB).toEqual(NO_DATA);
    expect(orgBReadingOrgA).toEqual(NO_DATA);
  });

  it('ignores paused monitors and stale offline results when counting monitorsDown', async () => {
    const testDb = getTestDb();

    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const [activeRecentMonitor, pausedRecentMonitor, activeStaleMonitor] =
      await testDb
        .insert(networkMonitors)
        .values([
          {
            partnerId: partner.id,
            name: 'Active recent offline monitor',
            monitorType: 'icmp_ping',
            target: 'active-recent.example.test',
            pollingInterval: 60,
            isActive: true,
            lastStatus: 'offline',
          },
          {
            partnerId: partner.id,
            name: 'Paused recent offline monitor',
            monitorType: 'icmp_ping',
            target: 'paused-recent.example.test',
            pollingInterval: 60,
            isActive: false,
            lastStatus: 'offline',
          },
          {
            partnerId: partner.id,
            name: 'Active stale offline monitor',
            monitorType: 'icmp_ping',
            target: 'active-stale.example.test',
            pollingInterval: 60,
            isActive: true,
            lastStatus: 'offline',
          },
        ])
        .returning();

    await testDb.insert(networkMonitorResults).values([
      {
        monitorId: activeRecentMonitor!.id,
        orgId: org.id,
        status: 'offline',
        timestamp: new Date('2026-09-17T11:59:00.000Z'),
      },
      {
        monitorId: pausedRecentMonitor!.id,
        orgId: org.id,
        status: 'offline',
        timestamp: new Date('2026-09-17T11:59:00.000Z'),
      },
      {
        monitorId: activeStaleMonitor!.id,
        orgId: org.id,
        status: 'offline',
        timestamp: new Date('2026-09-17T11:00:00.000Z'),
      },
    ]);

    const overview = await withDbAccessContext(
      orgContext(org.id, partner.id),
      () => networkOverview(org.id, NOW),
    );

    expect(overview).toEqual({
      dataStatus: 'ok',
      totalAssets: 0,
      onlineAssets: 0,
      offlineAssets: 0,
      snmpDevicesPolling: 0,
      // Only the active monitor with fresh evidence is currently down.
      // A paused monitor and stale evidence must never surface as customer
      // health failures.
      monitorsDown: 1,
    });
  });

  it('returns no_data with null metrics for an organization with no network data', async () => {
    const partner = await createPartner();
    const emptyOrg = await createOrganization({ partnerId: partner.id });

    const overview = await withDbAccessContext(
      orgContext(emptyOrg.id, partner.id),
      () => networkOverview(emptyOrg.id, NOW),
    );

    expect(overview).toEqual(NO_DATA);
  });
});

describe('networkAssets (#5861, PR 2)', () => {
  it('lists assets with resolved identity, site name, and derived online state, isolated per org', async () => {
    const testDb = getTestDb();

    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });

    const siteA = await createSite({ orgId: orgA.id, name: 'HQ Rio' });
    const siteB = await createSite({ orgId: orgB.id, name: 'HQ SP' });

    const [assetAOnline, assetAOffline] = await testDb
      .insert(discoveredAssets)
      .values([
        {
          orgId: orgA.id,
          siteId: siteA.id,
          ipAddress: '10.30.1.10',
          hostname: 'core-switch-01',
          macAddress: 'AA:BB:CC:00:00:01',
          assetType: 'switch',
          source: 'manual',
          isOnline: true,
          statusObservedAt: new Date('2026-09-17T11:59:00.000Z'),
          statusSource: 'scan',
          lastSeenAt: new Date('2026-09-17T11:59:00.000Z'),
          firstSeenAt: new Date('2026-09-01T09:00:00.000Z'),
          manufacturer: 'Cisco',
        },
        {
          orgId: orgA.id,
          siteId: siteA.id,
          ipAddress: '10.30.1.11',
          hostname: 'edge-router-01',
          macAddress: 'AA:BB:CC:00:00:02',
          assetType: 'router',
          source: 'manual',
          isOnline: false,
          statusObservedAt: new Date('2026-09-17T11:59:00.000Z'),
          statusSource: 'scan',
          lastSeenAt: new Date('2026-09-17T11:00:00.000Z'),
          firstSeenAt: new Date('2026-09-02T09:00:00.000Z'),
        },
      ])
      .returning();

    await testDb.insert(discoveredAssets).values({
      orgId: orgB.id,
      siteId: siteB.id,
      ipAddress: '10.40.1.10',
      hostname: 'b-core-01',
      assetType: 'switch',
      source: 'manual',
      isOnline: true,
      statusObservedAt: new Date('2026-09-17T11:59:00.000Z'),
      statusSource: 'scan',
      lastSeenAt: new Date('2026-09-17T11:59:00.000Z'),
      firstSeenAt: new Date('2026-09-03T09:00:00.000Z'),
    });

    const resultA = await withDbAccessContext(
      orgContext(orgA.id, partner.id),
      () => networkAssets(orgA.id, {}, NOW),
    );

    expect(resultA.dataStatus).toBe('ok');
    if (resultA.dataStatus !== 'ok') throw new Error('expected ok');

    expect(resultA.pagination).toEqual({ page: 1, limit: 50, total: 2 });
    expect(resultA.data).toHaveLength(2);

    const online = resultA.data.find((row) => row.hostname === 'core-switch-01');
    expect(online).toMatchObject({
      onlineState: 'online',
      siteName: 'HQ Rio',
      manufacturer: 'Cisco',
    });

    const offline = resultA.data.find((row) => row.hostname === 'edge-router-01');
    expect(offline).toMatchObject({
      onlineState: 'offline',
      siteName: 'HQ Rio',
    });

    // Cross-org isolation: orgA's context reading orgB's id gets no_data, not orgB's rows.
    const crossOrg = await withDbAccessContext(
      orgContext(orgA.id, partner.id),
      () => networkAssets(orgB.id, {}, NOW),
    );
    expect(crossOrg.dataStatus).toBe('no_data');
    expect(crossOrg.data).toEqual([]);
  });

  it('filters by siteId, assetType, and status independently', async () => {
    const testDb = getTestDb();

    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: org.id, name: 'Site A' });
    const siteB = await createSite({ orgId: org.id, name: 'Site B' });

    await testDb.insert(discoveredAssets).values([
      {
        orgId: org.id,
        siteId: siteA.id,
        ipAddress: '10.50.1.10',
        hostname: 'a-switch-online',
        assetType: 'switch',
        source: 'manual',
        isOnline: true,
        statusObservedAt: new Date('2026-09-17T11:59:00.000Z'),
        statusSource: 'scan',
        lastSeenAt: new Date('2026-09-17T11:59:00.000Z'),
      },
      {
        orgId: org.id,
        siteId: siteA.id,
        ipAddress: '10.50.1.11',
        hostname: 'a-router-offline',
        assetType: 'router',
        source: 'manual',
        isOnline: false,
        statusObservedAt: new Date('2026-09-17T11:59:00.000Z'),
        statusSource: 'scan',
        lastSeenAt: new Date('2026-09-17T11:00:00.000Z'),
      },
      {
        orgId: org.id,
        siteId: siteB.id,
        ipAddress: '10.50.1.12',
        hostname: 'b-switch-online',
        assetType: 'switch',
        source: 'manual',
        isOnline: true,
        statusObservedAt: new Date('2026-09-17T11:59:00.000Z'),
        statusSource: 'scan',
        lastSeenAt: new Date('2026-09-17T11:59:00.000Z'),
      },
    ]);

    const bySite = await withDbAccessContext(
      orgContext(org.id, partner.id),
      () => networkAssets(org.id, { siteId: siteA.id }, NOW),
    );
    expect(bySite.dataStatus).toBe('ok');
    if (bySite.dataStatus === 'ok') {
      expect(bySite.data).toHaveLength(2);
      expect(bySite.data.every((row) => row.siteName === 'Site A')).toBe(true);
    }

    const byType = await withDbAccessContext(
      orgContext(org.id, partner.id),
      () => networkAssets(org.id, { assetType: 'switch' }, NOW),
    );
    expect(byType.dataStatus).toBe('ok');
    if (byType.dataStatus === 'ok') {
      expect(byType.data).toHaveLength(2);
      expect(byType.data.every((row) => row.assetType === 'switch')).toBe(true);
    }

    const byStatus = await withDbAccessContext(
      orgContext(org.id, partner.id),
      () => networkAssets(org.id, { status: 'offline' }, NOW),
    );
    expect(byStatus.dataStatus).toBe('ok');
    if (byStatus.dataStatus === 'ok') {
      expect(byStatus.data).toHaveLength(1);
      expect(byStatus.data[0]?.hostname).toBe('a-router-offline');
    }
  });

  it('paginates results and reports the requested page/limit even when empty', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const testDb = getTestDb();

    await testDb.insert(discoveredAssets).values(
      Array.from({ length: 5 }, (_, i) => ({
        orgId: org.id,
        siteId: site.id,
        ipAddress: `10.60.1.${i + 1}`,
        hostname: `asset-${i + 1}`,
        assetType: 'switch' as const,
        source: 'manual' as const,
        isOnline: true,
        statusObservedAt: new Date('2026-09-17T11:59:00.000Z'),
        statusSource: 'scan' as const,
        lastSeenAt: new Date('2026-09-17T11:59:00.000Z'),
      })),
    );

    const page1 = await withDbAccessContext(
      orgContext(org.id, partner.id),
      () => networkAssets(org.id, { page: 1, limit: 2 }, NOW),
    );
    expect(page1.dataStatus).toBe('ok');
    if (page1.dataStatus === 'ok') {
      expect(page1.data).toHaveLength(2);
      expect(page1.pagination).toEqual({ page: 1, limit: 2, total: 5 });
    }

    const page3 = await withDbAccessContext(
      orgContext(org.id, partner.id),
      () => networkAssets(org.id, { page: 3, limit: 2 }, NOW),
    );
    expect(page3.dataStatus).toBe('ok');
    if (page3.dataStatus === 'ok') {
      expect(page3.data).toHaveLength(1);
      expect(page3.pagination).toEqual({ page: 3, limit: 2, total: 5 });
    }

    // Page far beyond the data still reports the requested page/limit and
    // dataStatus 'ok' - this is a legitimate empty result, not unavailable data.
    const pageBeyond = await withDbAccessContext(
      orgContext(org.id, partner.id),
      () => networkAssets(org.id, { page: 99, limit: 2 }, NOW),
    );
    expect(pageBeyond.dataStatus).toBe('ok');
    expect(pageBeyond.pagination).toEqual({ page: 99, limit: 2, total: 5 });
  });

  it('returns no_data with the requested page/limit for an org with no assets', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const result = await withDbAccessContext(
      orgContext(org.id, partner.id),
      () => networkAssets(org.id, { page: 2, limit: 10 }, NOW),
    );

    expect(result.dataStatus).toBe('no_data');
    expect(result.data).toEqual([]);
    expect(result.pagination).toEqual({ page: 2, limit: 10, total: 0 });
  });
});
