import { describe, it, expect } from 'vitest';
import { syncIntegration } from './unifiSyncService';
import { unifiSiteMappings, unifiDevices, unifiSyncRuns, discoveredAssets } from '../../db/schema';
import type { UnifiClient } from './unifiClient';
import type { DbExecutor } from './unifiConnectionService';

// ---------------------------------------------------------------------------
// Fake client — returns canned hosts/sites/devices/metrics
// ---------------------------------------------------------------------------

function fakeClient(devices: any[]): UnifiClient {
  return {
    listHosts: async () => [{ id: 'h1', name: 'Console', type: 'console', model: 'UDM' }],
    listSites: async () => [{ id: 's1', hostId: 'h1', name: 'Site' }],
    listDevices: async () => devices,
    getIspMetrics: async () => ({
      latencyMs: 10,
      packetLoss: 0,
      uptimePercent: 99.9,
      isp: 'ACME',
      raw: {},
    }),
  };
}

// ---------------------------------------------------------------------------
// scriptedDb — fake DbExecutor that dispatches on TABLE OBJECT IDENTITY
//
// Dispatch rules (compared by reference using the imported schema objects):
//   select from unifiSiteMappings  → opts.mappings
//   select from unifiDevices       → opts.existingDevices ?? []
//   select from discoveredAssets   → opts.existingAsset ? [opts.existingAsset] : []
//   select from unifiSyncRuns      → [{id: 'run-1'}]   (shouldn't be needed, safety net)
//
//   insert into unifiSyncRuns  + .returning() → [{id: 'run-1'}]
//   insert into discoveredAssets + .returning() → [{id: 'asset-1'}]
//   all other inserts              → []
//   all updates                    → []
//
// Writes are recorded in `writes.inserts` and `writes.updates` (pushed in
// `.then()` so each awaited chain records exactly once).
// ---------------------------------------------------------------------------

type WriteRecord = { table: any; values: any };

function scriptedDb(opts: { mappings: any[]; existingDevices?: any[]; existingAsset?: any }) {
  const writes: { inserts: WriteRecord[]; updates: WriteRecord[] } = {
    inserts: [],
    updates: [],
  };

  function makeChain(ctx: {
    op: 'select' | 'insert' | 'update' | 'delete';
    table?: any;
    insertValues?: any;
    setValues?: any;
    hasReturning?: boolean;
  }) {
    const chain: any = {
      // select chain
      from(table: any) {
        ctx.table = table;
        return chain;
      },
      where(..._args: any[]) {
        return chain;
      },
      limit(_n: number) {
        return chain;
      },
      // insert chain
      values(v: any) {
        ctx.insertValues = v;
        return chain;
      },
      onConflictDoUpdate(_opts: any) {
        return chain;
      },
      returning(_cols?: any) {
        ctx.hasReturning = true;
        return chain;
      },
      // update chain
      set(v: any) {
        ctx.setValues = v;
        return chain;
      },

      // Thenable: called once when `await chain` is evaluated.
      // We record the write and resolve with canned rows here so context is
      // fully populated (all builder methods have already run).
      then(resolve: (v: any) => void, reject: (e: any) => void) {
        try {
          // Record writes
          if (ctx.op === 'insert' && ctx.insertValues !== undefined) {
            writes.inserts.push({ table: ctx.table, values: ctx.insertValues });
          } else if (ctx.op === 'update' && ctx.setValues !== undefined) {
            writes.updates.push({ table: ctx.table, values: ctx.setValues });
          }

          // Compute return value
          let result: any;
          switch (ctx.op) {
            case 'select':
              if (ctx.table === unifiSiteMappings) {
                result = opts.mappings;
              } else if (ctx.table === unifiDevices) {
                result = opts.existingDevices ?? [];
              } else if (ctx.table === discoveredAssets) {
                result = opts.existingAsset ? [opts.existingAsset] : [];
              } else {
                // unifiSyncRuns select, or any other table
                result = [];
              }
              break;

            case 'insert':
              if (ctx.table === unifiSyncRuns && ctx.hasReturning) {
                result = [{ id: 'run-1' }];
              } else if (ctx.table === discoveredAssets && ctx.hasReturning) {
                result = [{ id: 'asset-1' }];
              } else {
                result = [];
              }
              break;

            default:
              // update, delete
              result = [];
          }

          resolve(result);
        } catch (e) {
          reject(e as Error);
        }
      },
    };
    return chain;
  }

  const db: DbExecutor = {
    select: (..._args: any[]) => makeChain({ op: 'select' }),
    insert: (table: any) => makeChain({ op: 'insert', table }),
    update: (table: any) => makeChain({ op: 'update', table }),
    delete: (..._args: any[]) => makeChain({ op: 'delete' }),
  };

  return { writes, db };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_MAPPING = {
  id: 'map-1',
  integrationId: 'int-1',
  orgId: 'org-1',
  siteId: 'site-1',
  unifiHostId: 'h1',
  unifiSiteId: 's1',
};

const BASE_INTEGRATION = { id: 'int-1', partnerId: 'partner-1' };

const NET_NEW_DEVICE = {
  unifiDeviceId: 'd1',
  mac: 'aa:bb:cc:dd:ee:ff',
  name: 'AP-1',
  model: 'U6-Pro',
  deviceType: 'uap',
  ip: '10.0.0.5',
  firmwareVersion: '6.6',
  firmwareUpdatable: false,
  adoptionState: 'CONNECTED',
  uptimeSeconds: 100,
  raw: { id: 'd1', type: 'uap' },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('unifiSyncService.syncIntegration', () => {
  it('creates a unifi_device and a linked discovered_asset for a net-new device', async () => {
    const { writes, db } = scriptedDb({ mappings: [BASE_MAPPING] });
    const client = fakeClient([NET_NEW_DEVICE]);

    const result = await syncIntegration({ db, client }, BASE_INTEGRATION, 'manual');

    // Counters
    expect(result.devicesCreated).toBe(1);
    expect(result.devicesUpdated).toBe(0);
    expect(result.devicesUnchanged).toBe(0);
    expect(result.devicesRemoved).toBe(0);
    expect(result.status).toBe('success');

    // A discoveredAssets row must have been inserted with correct fields
    const assetInserts = writes.inserts.filter((w) => w.table === discoveredAssets);
    expect(assetInserts).toHaveLength(1);
    expect(assetInserts[0]!.values.ipAddress).toBe('10.0.0.5');
    expect(assetInserts[0]!.values.assetType).toBe('access_point'); // 'uap' maps to 'access_point'
    expect(assetInserts[0]!.values.orgId).toBe('org-1');
    expect(assetInserts[0]!.values.manufacturer).toBe('Ubiquiti');

    // A unifiDevices row must have been inserted, linked to the new asset
    const deviceInserts = writes.inserts.filter((w) => w.table === unifiDevices);
    expect(deviceInserts).toHaveLength(1);
    expect(deviceInserts[0]!.values.unifiDeviceId).toBe('d1');
    expect(deviceInserts[0]!.values.discoveredAssetId).toBe('asset-1'); // returned by scriptedDb
    expect(deviceInserts[0]!.values.deviceType).toBe('ap'); // 'uap' maps to 'ap'
  });

  it('classifies an unchanged device as unchanged (no update churn)', async () => {
    // raw is shared by reference so JSON.stringify comparison is trivially equal
    const raw = { id: 'd1', type: 'usw', uptime: 500 };
    const existingDevice = { id: 'dev-1', raw, unifiDeviceId: 'd1' };
    // Provide a matched existing asset so reconcileDiscoveredAsset takes the UPDATE path,
    // not the INSERT path (realistic for a device seen in a previous run).
    const existingAsset = { id: 'asset-existing' };

    const { writes, db } = scriptedDb({
      mappings: [BASE_MAPPING],
      existingDevices: [existingDevice],
      existingAsset,
    });
    const client = fakeClient([
      {
        unifiDeviceId: 'd1',
        mac: 'aa:bb:cc:dd:ee:ff',
        name: 'SW-1',
        model: 'USW-Lite-8-PoE',
        deviceType: 'usw',
        ip: '10.0.0.2',
        firmwareVersion: '6.5',
        firmwareUpdatable: false,
        adoptionState: 'CONNECTED',
        uptimeSeconds: 500,
        raw, // same raw object → JSON.stringify equal → unchanged
      },
    ]);

    const result = await syncIntegration({ db, client }, BASE_INTEGRATION, 'scheduled');

    expect(result.devicesUnchanged).toBe(1);
    expect(result.devicesCreated).toBe(0);
    expect(result.devicesUpdated).toBe(0);
    expect(result.status).toBe('success');

    // No new unifiDevices row should be inserted (only an update)
    const deviceInserts = writes.inserts.filter((w) => w.table === unifiDevices);
    expect(deviceInserts).toHaveLength(0);

    // The unchanged path must UPDATE unifiDevices (it does not skip)
    const deviceUpdates = writes.updates.filter((w) => w.table === unifiDevices);
    expect(deviceUpdates).toHaveLength(1);

    // No discoveredAssets INSERT — existing asset matched by mac → UPDATE path
    const assetInserts = writes.inserts.filter((w) => w.table === discoveredAssets);
    expect(assetInserts).toHaveLength(0);
  });

  it('marks stale only devices on sites that successfully synced; leaves failed-site devices untouched', async () => {
    const MAP_2 = {
      id: 'map-2',
      integrationId: 'int-1',
      orgId: 'org-1',
      siteId: 'site-2',
      unifiHostId: 'h2',
      unifiSiteId: 's2',
    };

    // dev-1 on map-1 (successful, 0 devices returned) → should be marked stale
    // dev-2 on map-2 (failed)                         → must NOT be marked stale
    const existingDevices = [
      { id: 'dev-1', unifiDeviceId: 'ud-1', mappingId: 'map-1' },
      { id: 'dev-2', unifiDeviceId: 'ud-2', mappingId: 'map-2' },
    ];

    const { writes, db } = scriptedDb({
      mappings: [BASE_MAPPING, MAP_2],
      existingDevices,
    });

    // map-1 (h1): succeeds with no devices this run
    // map-2 (h2): listDevices throws → failedMappingIds captures 'map-2'
    const staledClient: UnifiClient = {
      listHosts: async () => [{ id: 'h1', name: 'C1', type: 'console', model: null }, { id: 'h2', name: 'C2', type: 'console', model: null }],
      listSites: async () => [],
      listDevices: async (hostId) => {
        if (hostId === 'h2') throw new Error('timeout');
        return [];
      },
      getIspMetrics: async () => null,
    };

    const result = await syncIntegration({ db, client: staledClient }, BASE_INTEGRATION, 'manual');

    // Only dev-1 (map-1, succeeded) should be stale
    const staleUpdates = writes.updates.filter(
      (w) => w.table === unifiDevices && w.values.isStale === true,
    );
    expect(staleUpdates).toHaveLength(1);
    expect(result.devicesRemoved).toBe(1);

    // dev-2 (map-2, failed) must not have been touched
    expect(result.status).toBe('partial');

    // No devices were created (listDevices returned empty / threw)
    const deviceInserts = writes.inserts.filter((w) => w.table === unifiDevices);
    expect(deviceInserts).toHaveLength(0);
  });

  it('skips discovered_asset creation for a device with no IP but still upserts unifi_device', async () => {
    const { writes, db } = scriptedDb({ mappings: [BASE_MAPPING] });
    const client = fakeClient([
      {
        ...NET_NEW_DEVICE,
        ip: null, // no IP → cannot insert to discovered_assets (NOT NULL constraint)
      },
    ]);

    const result = await syncIntegration({ db, client }, BASE_INTEGRATION, 'manual');

    expect(result.devicesCreated).toBe(1);
    expect(result.status).toBe('success');

    // No discoveredAssets insert — ip_address is NOT NULL, guard returns null
    const assetInserts = writes.inserts.filter((w) => w.table === discoveredAssets);
    expect(assetInserts).toHaveLength(0);

    // unifiDevices insert still happens, with discoveredAssetId: null
    const deviceInserts = writes.inserts.filter((w) => w.table === unifiDevices);
    expect(deviceInserts).toHaveLength(1);
    expect(deviceInserts[0]!.values.discoveredAssetId).toBeNull();
  });
});
