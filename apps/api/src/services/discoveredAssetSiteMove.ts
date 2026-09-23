// Moves discovered network assets (`discovered_assets` rows) between sites of
// the same org, inside a caller-supplied transaction.
//
// Two BEFORE UPDATE triggers fire on a `site_id` change
// (2026-10-22-150300-topology-inventory-lifecycle.sql and
// 2026-10-24-110100-topology-m1-runtime.sql, `breeze_detach_topology_monitor_authority`):
// they delete the asset's topology node bindings, disable any
// `topology_monitoring_policies` that derived authority from it
// (`blocked_reason = 'inventory_moved'`), and set the asset's `network_monitors`
// to `is_active = false, asset_id = NULL`. The policy disablement is the
// designed authority invalidation and is left alone (only counted). The monitor
// detachment is NOT what a site move means to an operator — their ping/port
// checks must survive the move — so this service captures the monitors before
// the update and re-attaches them afterwards with their prior `is_active`.
// `breeze_topology_monitor_site` (BEFORE UPDATE OF asset_id, site_id) accepts
// the re-attach because the asset already sits in the target site by then.
//
// Batch-capable on purpose: the profile-level "move every asset this profile
// discovered" action calls it with many ids.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { db } from '../db';
import { devices, discoveredAssets, networkMonitors, sites } from '../db/schema';

export type DiscoveredAssetSiteMoveTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type DiscoveredAssetSiteMoveResult = {
  assetId: string;
  /** false = the asset already sat in the target site; nothing was written. */
  moved: boolean;
  previousSiteId: string | null;
  /** The device whose link was cleared because it is not in the target site. */
  unlinkedDeviceId: string | null;
  /** network_monitors rows re-attached after the trigger detached them. */
  monitorsReattached: number;
  /** topology_monitoring_policies the trigger disabled (blocked_reason = inventory_moved). */
  topologyPoliciesDisabled: number;
};

export type DiscoveredAssetSiteMoveErrorCode = 'site_not_found' | 'asset_not_found' | 'write_failed';

export class DiscoveredAssetSiteMoveError extends Error {
  constructor(public readonly code: DiscoveredAssetSiteMoveErrorCode, message: string) {
    super(message);
    this.name = 'DiscoveredAssetSiteMoveError';
  }
}

export type MoveDiscoveredAssetsToSiteInput = {
  tx: DiscoveredAssetSiteMoveTx;
  orgId: string;
  assetIds: readonly string[];
  targetSiteId: string;
};

/**
 * Moves `assetIds` (all in `orgId`) to `targetSiteId`. Runs entirely on `tx`;
 * throws `DiscoveredAssetSiteMoveError` so the caller's transaction rolls back.
 * Results are returned in `assetIds` order (duplicates collapsed).
 */
export async function moveDiscoveredAssetsToSite(
  input: MoveDiscoveredAssetsToSiteInput,
): Promise<DiscoveredAssetSiteMoveResult[]> {
  const { tx, orgId, targetSiteId } = input;
  const assetIds = Array.from(new Set(input.assetIds));
  if (assetIds.length === 0) return [];

  const [targetSite] = await tx
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.id, targetSiteId), eq(sites.orgId, orgId)))
    .limit(1);
  if (!targetSite) {
    throw new DiscoveredAssetSiteMoveError('site_not_found', 'Target site not found or belongs to a different organization');
  }

  const assets = await tx
    .select({
      id: discoveredAssets.id,
      siteId: discoveredAssets.siteId,
      linkedDeviceId: discoveredAssets.linkedDeviceId,
    })
    .from(discoveredAssets)
    .where(and(inArray(discoveredAssets.id, assetIds), eq(discoveredAssets.orgId, orgId)));

  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const missing = assetIds.filter((id) => !assetById.has(id));
  if (missing.length > 0) {
    throw new DiscoveredAssetSiteMoveError('asset_not_found', `Asset not found: ${missing.join(', ')}`);
  }

  const toMove = assetIds
    .map((id) => assetById.get(id)!)
    .filter((asset) => asset.siteId !== targetSiteId);

  const results = new Map<string, DiscoveredAssetSiteMoveResult>();
  for (const id of assetIds) {
    results.set(id, {
      assetId: id,
      moved: false,
      previousSiteId: assetById.get(id)!.siteId,
      unlinkedDeviceId: null,
      monitorsReattached: 0,
      topologyPoliciesDisabled: 0,
    });
  }
  if (toMove.length === 0) return assetIds.map((id) => results.get(id)!);

  const moveIds = toMove.map((asset) => asset.id);

  // The link rule (POST /discovery/assets/:id/link) requires the device to be
  // in the asset's site, so a link to a device outside the target site cannot
  // survive the move. A link to a device already in the target site can.
  const linkedDeviceIds = toMove
    .map((asset) => asset.linkedDeviceId)
    .filter((id): id is string => typeof id === 'string');
  const deviceSiteById = new Map<string, string | null>();
  if (linkedDeviceIds.length > 0) {
    const linkedDevices = await tx
      .select({ id: devices.id, siteId: devices.siteId })
      .from(devices)
      .where(and(inArray(devices.id, Array.from(new Set(linkedDeviceIds))), eq(devices.orgId, orgId)));
    for (const device of linkedDevices) deviceSiteById.set(device.id, device.siteId);
  }
  const unlinkIds: string[] = [];
  const keepIds: string[] = [];
  for (const asset of toMove) {
    const linkedDeviceId = asset.linkedDeviceId;
    const unlink = linkedDeviceId !== null && deviceSiteById.get(linkedDeviceId) !== targetSiteId;
    if (unlink) {
      unlinkIds.push(asset.id);
      results.get(asset.id)!.unlinkedDeviceId = linkedDeviceId;
    } else {
      keepIds.push(asset.id);
    }
  }

  // Capture the monitors BEFORE the update: the trigger nulls asset_id and
  // is_active, after which nothing ties them back to the asset.
  const monitors = await tx
    .select({ id: networkMonitors.id, assetId: networkMonitors.assetId, isActive: networkMonitors.isActive })
    .from(networkMonitors)
    .where(and(inArray(networkMonitors.assetId, moveIds), eq(networkMonitors.orgId, orgId)));

  // Count the policies the trigger is about to disable, mirroring its own
  // match (subject node bound to the asset, or a policy bound to one of the
  // asset's monitors) restricted to policies that are enabled right now.
  const policyRows = await tx.execute<{ asset_id: string; disabled: number | string }>(sql`
    SELECT a.id AS asset_id, count(DISTINCT p.id)::int AS disabled
    FROM discovered_assets a
    JOIN topology_monitoring_policies p
      ON p.org_id = a.org_id AND p.site_id = a.site_id AND p.enabled = true
    WHERE a.id = ANY(${moveIds}::uuid[]) AND a.org_id = ${orgId}::uuid
      AND (
        p.subject_node_id IN (
          SELECT b.node_id FROM topology_node_bindings b
          WHERE b.org_id = a.org_id AND b.site_id = a.site_id AND b.discovered_asset_id = a.id
        )
        OR p.id IN (
          SELECT mb.policy_id FROM topology_monitor_bindings mb
          JOIN network_monitors m ON m.id = mb.monitor_id AND m.org_id = mb.org_id
          WHERE mb.org_id = a.org_id AND mb.site_id = a.site_id AND m.asset_id = a.id
        )
      )
    GROUP BY a.id
  `);
  for (const row of policyRows) {
    const result = results.get(row.asset_id);
    if (result) result.topologyPoliciesDisabled = Number(row.disabled);
  }

  const now = new Date();
  let written = 0;
  if (unlinkIds.length > 0) {
    const rows = await tx
      .update(discoveredAssets)
      .set({ siteId: targetSiteId, linkedDeviceId: null, linkSource: null, updatedAt: now })
      .where(and(inArray(discoveredAssets.id, unlinkIds), eq(discoveredAssets.orgId, orgId)))
      .returning({ id: discoveredAssets.id });
    written += rows.length;
  }
  if (keepIds.length > 0) {
    const rows = await tx
      .update(discoveredAssets)
      .set({ siteId: targetSiteId, updatedAt: now })
      .where(and(inArray(discoveredAssets.id, keepIds), eq(discoveredAssets.orgId, orgId)))
      .returning({ id: discoveredAssets.id });
    written += rows.length;
  }
  // A short write despite the prior read in the same transaction is an RLS
  // rejection or a race. Fail the transaction rather than reporting a move
  // that did not happen.
  if (written !== moveIds.length) {
    throw new DiscoveredAssetSiteMoveError('write_failed', `Site move wrote ${written} of ${moveIds.length} assets`);
  }

  // Re-attach the captured monitors, grouped by (asset, prior is_active).
  const monitorGroups = new Map<string, { assetId: string; isActive: boolean; ids: string[] }>();
  for (const monitor of monitors) {
    if (!monitor.assetId) continue;
    const key = `${monitor.assetId}:${monitor.isActive ? 1 : 0}`;
    const group = monitorGroups.get(key) ?? { assetId: monitor.assetId, isActive: monitor.isActive, ids: [] };
    group.ids.push(monitor.id);
    monitorGroups.set(key, group);
  }
  for (const group of monitorGroups.values()) {
    await tx
      .update(networkMonitors)
      .set({ assetId: group.assetId, siteId: targetSiteId, isActive: group.isActive, updatedAt: now })
      .where(and(inArray(networkMonitors.id, group.ids), eq(networkMonitors.orgId, orgId)));
    const result = results.get(group.assetId);
    if (result) result.monitorsReattached += group.ids.length;
  }

  for (const asset of toMove) results.get(asset.id)!.moved = true;
  return assetIds.map((id) => results.get(id)!);
}
