import { describe, expect, it, vi } from 'vitest';

import { devices, discoveredAssets, networkMonitors, sites } from '../db/schema';
import {
  DiscoveredAssetSiteMoveError,
  moveDiscoveredAssetsToSite,
  type DiscoveredAssetSiteMoveTx,
} from './discoveredAssetSiteMove';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE_A = '22222222-2222-4222-8222-222222222222';
const SITE_B = '33333333-3333-4333-8333-333333333333';
const ASSET_1 = '44444444-4444-4444-8444-444444444444';
const ASSET_2 = '55555555-5555-4555-8555-555555555555';
const DEVICE = '66666666-6666-4666-8666-666666666666';

type UpdateCall = { table: unknown; values: Record<string, unknown> };

/**
 * A recording transaction double. `selects` are consumed in call order (the
 * service's read order is site → assets → linked devices → monitors);
 * `returning` rows are consumed per `update().returning()` call; `execute`
 * answers the topology-policy count query.
 */
function makeTx(opts: {
  selects: unknown[][];
  returning?: unknown[][];
  executeRows?: unknown[];
}) {
  const selects = [...opts.selects];
  const returning = [...(opts.returning ?? [])];
  const updateCalls: UpdateCall[] = [];
  const order: string[] = [];

  const tx = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          order.push(`select:${tableName(table)}`);
          const rows = selects.shift() ?? [];
          return Object.assign(Promise.resolve(rows), { limit: vi.fn(() => Promise.resolve(rows)) });
        }),
      })),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(() => {
          order.push(`update:${tableName(table)}`);
          updateCalls.push({ table, values });
          const rows = returning.shift() ?? [];
          return Object.assign(Promise.resolve(rows), { returning: vi.fn(() => Promise.resolve(rows)) });
        }),
      })),
    })),
    execute: vi.fn(async () => opts.executeRows ?? []),
  };
  return { tx: tx as unknown as DiscoveredAssetSiteMoveTx, updateCalls, order, selectsLeft: selects };
}

function tableName(table: unknown): string {
  if (table === sites) return 'sites';
  if (table === discoveredAssets) return 'discovered_assets';
  if (table === devices) return 'devices';
  if (table === networkMonitors) return 'network_monitors';
  return 'unknown';
}

describe('moveDiscoveredAssetsToSite', () => {
  it('is a no-op for an asset already in the target site', async () => {
    const { tx, updateCalls } = makeTx({
      selects: [[{ id: SITE_B }], [{ id: ASSET_1, siteId: SITE_B, linkedDeviceId: null }]],
    });

    const results = await moveDiscoveredAssetsToSite({ tx, orgId: ORG, assetIds: [ASSET_1], targetSiteId: SITE_B });

    expect(results).toEqual([{
      assetId: ASSET_1,
      moved: false,
      previousSiteId: SITE_B,
      unlinkedDeviceId: null,
      monitorsReattached: 0,
      topologyPoliciesDisabled: 0,
    }]);
    expect(updateCalls).toHaveLength(0);
  });

  it('refuses a target site outside the org before touching any row', async () => {
    const { tx, updateCalls } = makeTx({ selects: [[]] });

    await expect(
      moveDiscoveredAssetsToSite({ tx, orgId: ORG, assetIds: [ASSET_1], targetSiteId: SITE_B }),
    ).rejects.toMatchObject({ code: 'site_not_found' });
    expect(updateCalls).toHaveLength(0);
  });

  it('throws asset_not_found when an id is missing from the org', async () => {
    const { tx, updateCalls } = makeTx({
      selects: [[{ id: SITE_B }], [{ id: ASSET_1, siteId: SITE_A, linkedDeviceId: null }]],
    });

    const err = await moveDiscoveredAssetsToSite({
      tx, orgId: ORG, assetIds: [ASSET_1, ASSET_2], targetSiteId: SITE_B,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DiscoveredAssetSiteMoveError);
    expect((err as DiscoveredAssetSiteMoveError).code).toBe('asset_not_found');
    expect(updateCalls).toHaveLength(0);
  });

  it('clears the device link when the linked device sits in a different site', async () => {
    const { tx, updateCalls } = makeTx({
      selects: [
        [{ id: SITE_B }],
        [{ id: ASSET_1, siteId: SITE_A, linkedDeviceId: DEVICE }],
        [{ id: DEVICE, siteId: SITE_A }],
        [],
      ],
      returning: [[{ id: ASSET_1 }]],
    });

    const [result] = await moveDiscoveredAssetsToSite({ tx, orgId: ORG, assetIds: [ASSET_1], targetSiteId: SITE_B });

    expect(result).toMatchObject({ assetId: ASSET_1, moved: true, previousSiteId: SITE_A, unlinkedDeviceId: DEVICE });
    const assetUpdate = updateCalls.find((c) => c.table === discoveredAssets)!;
    expect(assetUpdate.values).toMatchObject({ siteId: SITE_B, linkedDeviceId: null, linkSource: null });
    expect(assetUpdate.values.updatedAt).toBeInstanceOf(Date);
  });

  it('keeps the device link when the linked device is already in the target site', async () => {
    const { tx, updateCalls } = makeTx({
      selects: [
        [{ id: SITE_B }],
        [{ id: ASSET_1, siteId: SITE_A, linkedDeviceId: DEVICE }],
        [{ id: DEVICE, siteId: SITE_B }],
        [],
      ],
      returning: [[{ id: ASSET_1 }]],
    });

    const [result] = await moveDiscoveredAssetsToSite({ tx, orgId: ORG, assetIds: [ASSET_1], targetSiteId: SITE_B });

    expect(result).toMatchObject({ moved: true, unlinkedDeviceId: null });
    const assetUpdate = updateCalls.find((c) => c.table === discoveredAssets)!;
    expect(assetUpdate.values).toMatchObject({ siteId: SITE_B });
    expect(assetUpdate.values).not.toHaveProperty('linkedDeviceId');
    expect(assetUpdate.values).not.toHaveProperty('linkSource');
  });

  it('clears the link when the linked device row is gone from the org', async () => {
    const { tx } = makeTx({
      selects: [
        [{ id: SITE_B }],
        [{ id: ASSET_1, siteId: SITE_A, linkedDeviceId: DEVICE }],
        [],
        [],
      ],
      returning: [[{ id: ASSET_1 }]],
    });

    const [result] = await moveDiscoveredAssetsToSite({ tx, orgId: ORG, assetIds: [ASSET_1], targetSiteId: SITE_B });
    expect(result?.unlinkedDeviceId).toBe(DEVICE);
  });

  it('captures the asset monitors before the move and re-attaches them with their prior is_active', async () => {
    const { tx, updateCalls, order } = makeTx({
      selects: [
        [{ id: SITE_B }],
        [{ id: ASSET_1, siteId: SITE_A, linkedDeviceId: null }],
        [
          { id: 'mon-active', assetId: ASSET_1, isActive: true },
          { id: 'mon-paused', assetId: ASSET_1, isActive: false },
          { id: 'mon-active-2', assetId: ASSET_1, isActive: true },
        ],
      ],
      returning: [[{ id: ASSET_1 }]],
    });

    const [result] = await moveDiscoveredAssetsToSite({ tx, orgId: ORG, assetIds: [ASSET_1], targetSiteId: SITE_B });

    expect(result?.monitorsReattached).toBe(3);
    // Monitors are read BEFORE the asset update (the BEFORE UPDATE trigger
    // nulls asset_id and is_active, so reading afterwards finds nothing).
    expect(order.indexOf('select:network_monitors')).toBeLessThan(order.indexOf('update:discovered_assets'));
    // ...and re-attached AFTER it, once the asset already sits in the target
    // site so breeze_topology_monitor_site accepts the new (asset, site) pair.
    const monitorUpdates = updateCalls.filter((c) => c.table === networkMonitors);
    expect(monitorUpdates).toHaveLength(2);
    expect(order.indexOf('update:network_monitors')).toBeGreaterThan(order.indexOf('update:discovered_assets'));
    expect(monitorUpdates.map((c) => c.values)).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetId: ASSET_1, siteId: SITE_B, isActive: true }),
      expect.objectContaining({ assetId: ASSET_1, siteId: SITE_B, isActive: false }),
    ]));
  });

  it('reports how many topology policies the move disables, per asset', async () => {
    const { tx } = makeTx({
      selects: [
        [{ id: SITE_B }],
        [
          { id: ASSET_1, siteId: SITE_A, linkedDeviceId: null },
          { id: ASSET_2, siteId: SITE_A, linkedDeviceId: null },
        ],
        [],
      ],
      returning: [[{ id: ASSET_1 }, { id: ASSET_2 }]],
      executeRows: [{ asset_id: ASSET_1, disabled: 2 }],
    });

    const results = await moveDiscoveredAssetsToSite({
      tx, orgId: ORG, assetIds: [ASSET_1, ASSET_2], targetSiteId: SITE_B,
    });

    expect(results.find((r) => r.assetId === ASSET_1)?.topologyPoliciesDisabled).toBe(2);
    expect(results.find((r) => r.assetId === ASSET_2)?.topologyPoliciesDisabled).toBe(0);
  });

  it('batches: moves only the assets not already in the target site and keeps input order', async () => {
    const { tx, updateCalls } = makeTx({
      selects: [
        [{ id: SITE_B }],
        [
          { id: ASSET_2, siteId: SITE_B, linkedDeviceId: null },
          { id: ASSET_1, siteId: SITE_A, linkedDeviceId: null },
        ],
        [],
      ],
      returning: [[{ id: ASSET_1 }]],
    });

    const results = await moveDiscoveredAssetsToSite({
      tx, orgId: ORG, assetIds: [ASSET_1, ASSET_2], targetSiteId: SITE_B,
    });

    expect(results.map((r) => [r.assetId, r.moved])).toEqual([[ASSET_1, true], [ASSET_2, false]]);
    expect(updateCalls.filter((c) => c.table === discoveredAssets)).toHaveLength(1);
  });

  it('fails loudly when the asset update writes fewer rows than expected (RLS or race)', async () => {
    const { tx } = makeTx({
      selects: [[{ id: SITE_B }], [{ id: ASSET_1, siteId: SITE_A, linkedDeviceId: null }], []],
      returning: [[]],
    });

    await expect(
      moveDiscoveredAssetsToSite({ tx, orgId: ORG, assetIds: [ASSET_1], targetSiteId: SITE_B }),
    ).rejects.toMatchObject({ code: 'write_failed' });
  });

  it('returns an empty list for an empty batch without reading anything', async () => {
    const { tx } = makeTx({ selects: [] });
    await expect(moveDiscoveredAssetsToSite({ tx, orgId: ORG, assetIds: [], targetSiteId: SITE_B })).resolves.toEqual([]);
    expect(tx.select).not.toHaveBeenCalled();
  });
});
