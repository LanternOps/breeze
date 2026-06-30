import { describe, it, expect } from 'vitest';
import { reconcileTelemetry } from './unifiTelemetryService';
import { unifiCollectors, unifiSiteMappings, unifiDeviceTelemetry, unifiClients, discoveredAssets } from '../../db/schema';
import type { DbExecutor } from './unifiConnectionService';

type WriteRecord = { table: any; values: any; conflict?: any };

// Build a DbExecutor that returns canned select rows per table and records inserts/updates.
function scriptedDb(opts: {
  collector: any; mappings: any[]; existingDevices?: any[]; existingClients?: any[];
  assetByMac?: Record<string, any>;
  assetInsertReturn?: { id: string }; // canned return for discoveredAssets insert().returning()
}) {
  const writes = { inserts: [] as WriteRecord[], updates: [] as WriteRecord[] };

  const collectStrings = (value: any, seen = new WeakSet<object>()): string[] => {
    if (typeof value === 'string') return [value];
    if (value === null || value === undefined || typeof value !== 'object') return [];
    if (seen.has(value)) return [];
    seen.add(value);
    if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item, seen));
    return Object.values(value).flatMap((item) => collectStrings(item, seen));
  };

  const selForTable = (t: any, whereArgs: any[] = []) => {
    if (t === unifiCollectors) return opts.collector ? [opts.collector] : [];
    if (t === unifiSiteMappings) return opts.mappings;
    if (t === unifiDeviceTelemetry) return opts.existingDevices ?? [];
    if (t === unifiClients) return opts.existingClients ?? [];
    if (t === discoveredAssets) {
      const strings = collectStrings(whereArgs);
      const mac = Object.keys(opts.assetByMac ?? {}).find((key) => strings.includes(key));
      return mac ? [opts.assetByMac?.[mac]] : [];
    }
    return [];
  };

  function makeChain(ctx: {
    op: 'select' | 'insert' | 'update';
    table?: any;
    whereArgs?: any[];
    insertValues?: any;
    setValues?: any;
    conflict?: any;
  }) {
    const chain: any = {
      from(table: any) {
        ctx.table = table;
        return chain;
      },
      where(...w: any[]) {
        ctx.whereArgs = w;
        return chain;
      },
      limit(_n: number) {
        return chain;
      },
      values(v: any) {
        ctx.insertValues = v;
        return chain;
      },
      onConflictDoUpdate(conflict: any) {
        ctx.conflict = conflict;
        return chain;
      },
      returning(_col: any) {
        ctx.returning = true;
        return chain;
      },
      set(v: any) {
        ctx.setValues = v;
        return chain;
      },
      then(resolve: (value: any) => void, reject: (reason?: any) => void) {
        try {
          if (ctx.op === 'insert' && ctx.insertValues !== undefined) {
            writes.inserts.push({ table: ctx.table, values: ctx.insertValues, conflict: ctx.conflict });
            if (ctx.table === discoveredAssets && opts.assetInsertReturn) {
              resolve([opts.assetInsertReturn]);
            } else {
              resolve([]);
            }
            return;
          }
          if (ctx.op === 'update' && ctx.setValues !== undefined) {
            writes.updates.push({ table: ctx.table, values: ctx.setValues });
            resolve([]);
            return;
          }
          resolve(selForTable(ctx.table, ctx.whereArgs));
        } catch (err) {
          reject(err);
        }
      },
    };
    return chain;
  }

  const db: DbExecutor = {
    select: (_cols?: any) => makeChain({ op: 'select' }),
    insert: (table: any) => makeChain({ op: 'insert', table }),
    update: (table: any) => makeChain({ op: 'update', table }),
    delete: () => makeChain({ op: 'update' }),
  };

  return { db, writes };
}

describe('reconcileTelemetry', () => {
  it('upserts device + client telemetry and resolves site via mapping', async () => {
    const { db, writes } = scriptedDb({
      // unifiHostId: null = self-hosted; sentinel mapping row carries unifiHostId = collector.id ('c1').
      collector: { id: 'c1', orgId: 'org-fallback', siteId: 'site-fallback', integrationId: 'int-1', unifiHostId: null },
      mappings: [{ unifiSiteId: 's1', siteId: 'site-mapped', orgId: 'org-mapped', unifiHostId: 'c1' }],
      assetByMac: { 'cc:dd': { id: 'asset-1' } },
    });

    const res = await reconcileTelemetry(db, {
      collectorId: 'c1', polledAt: '2026-06-29T00:00:00Z', firmwareOk: true,
      devices: [{ unifiDeviceId: 'd1', unifiSiteId: 's1', mac: 'aa:bb', name: 'AP', uptimeSeconds: 10, cpuPct: 1, memPct: 2, txBytes: 3, rxBytes: 4, numClients: 1, poePorts: [], raw: {} }],
      clients: [{ mac: 'cc:dd', unifiSiteId: 's1', hostname: 'phone', ip: '10.0.0.9', connectedDeviceId: 'd1', uplinkPortIdx: null, isWired: false, ssid: 'wifi', vlan: 10, signalDbm: -50, txBytes: 1, rxBytes: 1, uptimeSeconds: 5, raw: {} }],
    });

    expect(res.devicesUpserted).toBe(1);
    expect(res.clientsUpserted).toBe(1);
    expect(res.devicesStaled).toBe(0);
    expect(res.clientsStaled).toBe(0);

    const deviceInserts = writes.inserts.filter((w) => w.table === unifiDeviceTelemetry);
    expect(deviceInserts).toHaveLength(1);
    expect(deviceInserts[0]!.values.orgId).toBe('org-mapped');
    expect(deviceInserts[0]!.values.siteId).toBe('site-mapped');
    expect(deviceInserts[0]!.values.unifiDeviceId).toBe('d1');
    expect(deviceInserts[0]!.values.isStale).toBe(false);

    const clientInserts = writes.inserts.filter((w) => w.table === unifiClients);
    expect(clientInserts).toHaveLength(1);
    expect(clientInserts[0]!.values.orgId).toBe('org-mapped');
    expect(clientInserts[0]!.values.siteId).toBe('site-mapped');
    expect(clientInserts[0]!.values.mac).toBe('cc:dd');
    expect(clientInserts[0]!.values.discoveredAssetId).toBe('asset-1');
    expect(clientInserts[0]!.values.isStale).toBe(false);

    const assetInserts = writes.inserts.filter((w) => w.table === discoveredAssets);
    expect(assetInserts).toHaveLength(0);
  });

  it('marks devices/clients not seen this poll as stale', async () => {
    const { db, writes } = scriptedDb({
      collector: { id: 'c1', orgId: 'org-a', siteId: 'site-a', integrationId: 'int-1' },
      mappings: [{ unifiSiteId: 's1', siteId: 'site-a', orgId: 'org-a' }],
      existingDevices: [{ id: 'old-dev', unifiDeviceId: 'gone', isStale: false }],
      existingClients: [{ id: 'old-cli', mac: 'ff:ff', isStale: false }],
    });

    const res = await reconcileTelemetry(db, {
      collectorId: 'c1', polledAt: '2026-06-29T00:00:00Z', firmwareOk: true, devices: [], clients: [],
    });

    expect(res.devicesStaled).toBe(1);
    expect(res.clientsStaled).toBe(1);
    expect(res.devicesUpserted).toBe(0);
    expect(res.clientsUpserted).toBe(0);

    const deviceUpdates = writes.updates.filter((u) => u.table === unifiDeviceTelemetry);
    expect(deviceUpdates).toHaveLength(1);
    expect(deviceUpdates[0]!.values.isStale).toBe(true);

    const clientUpdates = writes.updates.filter((u) => u.table === unifiClients);
    expect(clientUpdates).toHaveLength(1);
    expect(clientUpdates[0]!.values.isStale).toBe(true);
  });

  it('does not stale existing rows when markStale=false (partial poll)', async () => {
    const { db, writes } = scriptedDb({
      collector: { id: 'c1', orgId: 'org-a', siteId: 'site-a', integrationId: 'int-1' },
      mappings: [{ unifiSiteId: 's1', siteId: 'site-a', orgId: 'org-a' }],
      existingDevices: [{ id: 'old-dev', unifiDeviceId: 'gone', isStale: false }],
      existingClients: [{ id: 'old-cli', mac: 'ff:ff', isStale: false }],
    });

    const res = await reconcileTelemetry(db, {
      collectorId: 'c1', polledAt: '2026-06-29T00:00:00Z', firmwareOk: true, devices: [], clients: [],
    }, { markStale: false });

    expect(res.devicesStaled).toBe(0);
    expect(res.clientsStaled).toBe(0);
    expect(writes.updates).toHaveLength(0);
  });

  it('coalesces a null raw to {} so the NOT NULL jsonb column never sees null', async () => {
    const { db, writes } = scriptedDb({
      collector: { id: 'c1', orgId: 'org-a', siteId: 'site-a', integrationId: 'int-1' },
      mappings: [{ unifiSiteId: 's1', siteId: 'site-a', orgId: 'org-a' }],
    });

    // The agent's rawOf returns JSON null on a decode failure/overflow; the wire
    // schema (z.unknown()) lets it through, but raw is jsonb NOT NULL.
    await reconcileTelemetry(db, {
      collectorId: 'c1', polledAt: '2026-06-29T00:00:00Z', firmwareOk: true,
      devices: [{ unifiDeviceId: 'd1', unifiSiteId: 's1', mac: 'aa:bb', name: 'AP', raw: null }],
      clients: [{ mac: 'cc:dd', unifiSiteId: 's1', raw: null }],
    });

    const deviceInsert = writes.inserts.find((w) => w.table === unifiDeviceTelemetry);
    expect(deviceInsert?.values.raw).toEqual({});
    expect(deviceInsert?.values.raw).not.toBeNull();
    const clientInsert = writes.inserts.find((w) => w.table === unifiClients);
    expect(clientInsert?.values.raw).toEqual({});
    expect(clientInsert?.values.raw).not.toBeNull();
  });

  it('normalizes client MAC (uppercase/hyphen) for asset linking and storage', async () => {
    const { db, writes } = scriptedDb({
      collector: { id: 'c1', orgId: 'org-a', siteId: 'site-a', integrationId: 'int-1' },
      mappings: [{ unifiSiteId: 's1', siteId: 'site-a', orgId: 'org-a' }],
      assetByMac: { 'aa:bb:cc:dd:ee:ff': { id: 'asset-9' } },
    });

    const res = await reconcileTelemetry(db, {
      collectorId: 'c1', polledAt: '2026-06-29T00:00:00Z', firmwareOk: true,
      devices: [],
      clients: [{ mac: 'AA-BB-CC-DD-EE-FF', unifiSiteId: 's1', hostname: 'h', ip: null, connectedDeviceId: null, uplinkPortIdx: null, isWired: true, ssid: null, vlan: null, signalDbm: null, txBytes: null, rxBytes: null, uptimeSeconds: null, raw: {} }],
    });

    expect(res.clientsUpserted).toBe(1);
    const clientInserts = writes.inserts.filter((w) => w.table === unifiClients);
    expect(clientInserts).toHaveLength(1);
    // Stored canonical (lowercase, colon-separated) and linked despite the source casing.
    expect(clientInserts[0]!.values.mac).toBe('aa:bb:cc:dd:ee:ff');
    expect(clientInserts[0]!.values.discoveredAssetId).toBe('asset-9');
  });

  it('reconciles device ip+mac into discovered_assets and stamps discoveredAssetId on the telemetry row', async () => {
    const { db, writes } = scriptedDb({
      collector: { id: 'c1', orgId: 'org-a', siteId: 'site-a', integrationId: 'int-1' },
      mappings: [],
      assetInsertReturn: { id: 'asset-new-1' },
    });

    await reconcileTelemetry(db, {
      collectorId: 'c1', polledAt: '2026-06-29T00:00:00Z', firmwareOk: true,
      devices: [{ unifiDeviceId: 'd1', mac: 'AA:BB:CC:00:11:22', raw: { ipAddress: '10.0.0.5', name: 'sw1' } }],
      clients: [],
    });

    const assetInserts = writes.inserts.filter((w) => w.table === discoveredAssets);
    expect(assetInserts).toHaveLength(1);
    expect(assetInserts[0]!.values.orgId).toBe('org-a');
    expect(assetInserts[0]!.values.ipAddress).toBe('10.0.0.5');
    expect(assetInserts[0]!.values.manufacturer).toBe('Ubiquiti');

    const deviceInserts = writes.inserts.filter((w) => w.table === unifiDeviceTelemetry);
    expect(deviceInserts).toHaveLength(1);
    expect(deviceInserts[0]!.values.discoveredAssetId).toBe('asset-new-1');
    expect(deviceInserts[0]!.conflict.set.discoveredAssetId).toBe('asset-new-1');
  });

  it('REGRESSION: per-controller isolation — identical local site id on two self-hosted controllers routes to the correct org', async () => {
    // Pre-fix: siteByUnifi.set("default", …) is called for BOTH mapping rows; last-write-wins
    // picks collA's row (it is last in iteration order), so collB's device is mis-routed to org-A.
    // Post-fix: the filter `m.unifiHostId === hostKey` limits the map to collB's own row only.
    //
    // Mapping rows ordered [B first, A last] so that without the host-axis filter the last write
    // (A) wins — proving the test is RED on pre-fix code.
    const { db, writes } = scriptedDb({
      collector: { id: 'collB', orgId: 'org-Bhome', siteId: 'site-Bhome', integrationId: 'int-1', unifiHostId: null },
      mappings: [
        { unifiHostId: 'collB', unifiSiteId: 'default', orgId: 'org-B', siteId: 'site-B' },
        { unifiHostId: 'collA', unifiSiteId: 'default', orgId: 'org-A', siteId: 'site-A' },
      ],
    });

    await reconcileTelemetry(db, {
      collectorId: 'collB', polledAt: '2026-06-30T00:00:00Z', firmwareOk: true,
      devices: [{ unifiDeviceId: 'dev-1', unifiSiteId: 'default', raw: {} }],
      clients: [],
    });

    const deviceInserts = writes.inserts.filter((w) => w.table === unifiDeviceTelemetry);
    expect(deviceInserts).toHaveLength(1);
    // Must resolve to collB's org/site, NOT collA's — cross-tenant mis-routing would write org-A here.
    expect(deviceInserts[0]!.values.orgId).toBe('org-B');
    expect(deviceInserts[0]!.values.siteId).toBe('site-B');
  });

  it('skips asset creation and leaves discoveredAssetId null when device raw has no ip', async () => {
    const { db, writes } = scriptedDb({
      collector: { id: 'c1', orgId: 'org-a', siteId: 'site-a', integrationId: 'int-1' },
      mappings: [],
    });

    await reconcileTelemetry(db, {
      collectorId: 'c1', polledAt: '2026-06-29T00:00:00Z', firmwareOk: true,
      devices: [{ unifiDeviceId: 'd1', mac: 'AA:BB:CC:00:11:22', raw: { name: 'sw1' } }],
      clients: [],
    });

    const assetInserts = writes.inserts.filter((w) => w.table === discoveredAssets);
    expect(assetInserts).toHaveLength(0);

    const deviceInserts = writes.inserts.filter((w) => w.table === unifiDeviceTelemetry);
    expect(deviceInserts).toHaveLength(1);
    expect(deviceInserts[0]!.values.discoveredAssetId).toBeNull();
  });
});
