// Real-Postgres proof for moveDiscoveredAssetsToSite. The unit suite
// (discoveredAssetSiteMove.test.ts) mocks the transaction, so nothing there
// executes the two BEFORE UPDATE triggers on discovered_assets
// (breeze_topology_inventory_lifecycle, breeze_topology_authority_detach) or
// the breeze_topology_monitor_site guard on network_monitors that the
// re-attach has to satisfy. This drives the service as breeze_app under an
// org-scoped RLS context, exactly as the route does.
import '../__tests__/integration/setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext } from '../db';
import { createOrganization, createSite } from '../__tests__/integration/db-utils';
import { createTopologyTenant, orgContext } from '../__tests__/integration/topology-fixtures';
import { DiscoveredAssetSiteMoveError, moveDiscoveredAssetsToSite } from './discoveredAssetSiteMove';

const scoped = <T>(orgId: string, action: () => Promise<T>) => withDbAccessContext(orgContext(orgId), action);

const move = (orgId: string, assetIds: string[], targetSiteId: string) =>
  scoped(orgId, () => db.transaction((tx) => moveDiscoveredAssetsToSite({ tx, orgId, assetIds, targetSiteId })));

async function insertAsset(orgId: string, siteId: string, ip: string, extra: { linkedDeviceId?: string; linkSource?: 'manual' | 'auto' } = {}) {
  const id = crypto.randomUUID();
  await scoped(orgId, () => db.execute(sql`INSERT INTO discovered_assets (id, org_id, site_id, ip_address, linked_device_id, link_source)
    VALUES (${id}::uuid, ${orgId}::uuid, ${siteId}::uuid, ${ip}::inet, ${extra.linkedDeviceId ?? null}::uuid, ${extra.linkSource ?? null})`));
  return id;
}

async function insertDevice(orgId: string, siteId: string) {
  const id = crypto.randomUUID();
  await scoped(orgId, () => db.execute(sql`INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
    VALUES (${id}::uuid, ${orgId}::uuid, ${siteId}::uuid, ${id}, 'fixture', 'linux', '1', 'amd64', '1')`));
  return id;
}

async function insertMonitor(orgId: string, assetId: string, isActive: boolean) {
  const id = crypto.randomUUID();
  // No site_id on purpose: breeze_topology_monitor_site derives it from the asset.
  await scoped(orgId, () => db.execute(sql`INSERT INTO network_monitors (id, org_id, asset_id, name, monitor_type, target, is_active)
    VALUES (${id}::uuid, ${orgId}::uuid, ${assetId}::uuid, 'fixture', 'icmp_ping', '192.0.2.1', ${isActive})`));
  return id;
}

async function assetRow(orgId: string, assetId: string) {
  const [row] = await scoped(orgId, () => db.execute<{ site_id: string; linked_device_id: string | null; link_source: string | null; notes: string | null }>(
    sql`SELECT site_id, linked_device_id, link_source, notes FROM discovered_assets WHERE id = ${assetId}::uuid`));
  if (!row) throw new Error('fixture row missing');
  return row;
}

async function monitorRow(orgId: string, monitorId: string) {
  const [row] = await scoped(orgId, () => db.execute<{ asset_id: string | null; site_id: string | null; is_active: boolean }>(
    sql`SELECT asset_id, site_id, is_active FROM network_monitors WHERE id = ${monitorId}::uuid`));
  if (!row) throw new Error('fixture row missing');
  return row;
}

/** A topology node bound to the asset, so the asset carries monitor authority. */
async function bindAssetToNode(orgId: string, siteId: string, assetId: string) {
  const nodeId = crypto.randomUUID();
  await scoped(orgId, async () => {
    await db.execute(sql`INSERT INTO topology_site_state (org_id, site_id) VALUES (${orgId}::uuid, ${siteId}::uuid) ON CONFLICT DO NOTHING`);
    await db.execute(sql`INSERT INTO topology_nodes (id, org_id, site_id, identity_key, identity_material, kind)
      VALUES (${nodeId}::uuid, ${orgId}::uuid, ${siteId}::uuid, ${nodeId},
        ${JSON.stringify({ version: 1, kind: 'endpoint', sourceKey: nodeId })}::jsonb, 'endpoint')`);
    await db.execute(sql`INSERT INTO topology_node_bindings (org_id, site_id, node_id, discovered_asset_id)
      VALUES (${orgId}::uuid, ${siteId}::uuid, ${nodeId}::uuid, ${assetId}::uuid)`);
  });
  return nodeId;
}

async function insertPolicy(orgId: string, siteId: string, key: string, opts: { enabled: boolean; subjectNodeId?: string }) {
  const id = crypto.randomUUID();
  // An ENABLED (armed) policy carries its complete authority: a digest
  // (topology_monitoring_policies_authority_chk) and the M3 arm — frozen actor,
  // permission witness, armed_at, requester, routing contexts
  // (topology_monitoring_policies_armed_chk).
  const armed = opts.enabled;
  await scoped(orgId, () => db.execute(sql`INSERT INTO topology_monitoring_policies (id, org_id, site_id, key, enabled, authority_digest, subject_node_id, definition,
      authority_actor, authority_permission_version, armed_at, requester_id, routing_contexts)
    VALUES (${id}::uuid, ${orgId}::uuid, ${siteId}::uuid, ${key}, ${opts.enabled}, ${armed ? '0'.repeat(64) : null}, ${opts.subjectNodeId ?? null}::uuid, '{}',
      ${armed ? '{}' : null}::jsonb, ${armed ? 'v' : null}, ${armed ? new Date().toISOString() : null}::timestamptz,
      ${armed ? crypto.randomUUID() : null}::uuid, ${armed ? '[{}]' : '[]'}::jsonb)`));
  return id;
}

async function policyRow(orgId: string, policyId: string) {
  const [row] = await scoped(orgId, () => db.execute<{ enabled: boolean; blocked_reason: string | null }>(
    sql`SELECT enabled, blocked_reason FROM topology_monitoring_policies WHERE id = ${policyId}::uuid`));
  if (!row) throw new Error('fixture row missing');
  return row;
}

describe('moveDiscoveredAssetsToSite (real Postgres)', () => {
  it('re-attaches the asset monitors the detach trigger nulled, keeping their prior is_active', async () => {
    const t = await createTopologyTenant();
    const target = await createSite({ orgId: t.orgId });
    const assetId = await insertAsset(t.orgId, t.siteId, '192.0.2.10');
    const activeId = await insertMonitor(t.orgId, assetId, true);
    const inactiveId = await insertMonitor(t.orgId, assetId, false);
    // The BEFORE INSERT guard derived site_id from the asset.
    expect(await monitorRow(t.orgId, activeId)).toEqual({ asset_id: assetId, site_id: t.siteId, is_active: true });

    const [result] = await move(t.orgId, [assetId], target.id);

    expect(result).toMatchObject({ assetId, moved: true, previousSiteId: t.siteId, unlinkedDeviceId: null, monitorsReattached: 2, topologyPoliciesDisabled: 0 });
    expect((await assetRow(t.orgId, assetId)).site_id).toBe(target.id);
    expect(await monitorRow(t.orgId, activeId)).toEqual({ asset_id: assetId, site_id: target.id, is_active: true });
    expect(await monitorRow(t.orgId, inactiveId)).toEqual({ asset_id: assetId, site_id: target.id, is_active: false });
  });

  it('lets the trigger drop the node binding and disable the enabled policies, and counts exactly those', async () => {
    const t = await createTopologyTenant();
    const target = await createSite({ orgId: t.orgId });
    const assetId = await insertAsset(t.orgId, t.siteId, '192.0.2.20');
    const nodeId = await bindAssetToNode(t.orgId, t.siteId, assetId);
    const monitorId = await insertMonitor(t.orgId, assetId, true);
    // Three policies reach the asset: one through the subject node, one through
    // a binding on the asset's monitor, and one already-disabled one through
    // the node. Only the two enabled ones are "disabled by the move".
    const nodePolicy = await insertPolicy(t.orgId, t.siteId, 'node', { enabled: true, subjectNodeId: nodeId });
    const monitorPolicy = await insertPolicy(t.orgId, t.siteId, 'monitor', { enabled: true });
    const alreadyOff = await insertPolicy(t.orgId, t.siteId, 'off', { enabled: false, subjectNodeId: nodeId });
    await scoped(t.orgId, () => db.execute(sql`INSERT INTO topology_monitor_bindings (org_id, site_id, node_id, monitor_id, policy_id, context_key, family, metric_role)
      VALUES (${t.orgId}::uuid, ${t.siteId}::uuid, ${nodeId}::uuid, ${monitorId}::uuid, ${monitorPolicy}::uuid, 'default', 'ipv4', 'connectivity')`));

    const [result] = await move(t.orgId, [assetId], target.id);

    expect(result).toMatchObject({ moved: true, monitorsReattached: 1, topologyPoliciesDisabled: 2 });
    expect(await scoped(t.orgId, () => db.execute(sql`SELECT id FROM topology_node_bindings WHERE discovered_asset_id = ${assetId}::uuid`))).toHaveLength(0);
    expect(await scoped(t.orgId, () => db.execute(sql`SELECT id FROM topology_monitor_bindings WHERE monitor_id = ${monitorId}::uuid`))).toHaveLength(0);
    expect(await policyRow(t.orgId, nodePolicy)).toEqual({ enabled: false, blocked_reason: 'inventory_moved' });
    expect(await policyRow(t.orgId, monitorPolicy)).toEqual({ enabled: false, blocked_reason: 'inventory_moved' });
    // The trigger's UPDATE does not filter on `enabled`, so it re-stamps the
    // already-disabled policy too. The service's count above (2, not 3) is what
    // proves it only reports policies the move actually turned off.
    expect(await policyRow(t.orgId, alreadyOff)).toEqual({ enabled: false, blocked_reason: 'inventory_moved' });
    // The SQL detach disarms exactly like disarmPolicyRow: no frozen actor,
    // permission witness, arm time, routing contexts or next slot survives on a
    // disabled row, so it can never read as armed and re-enabling needs a fresh arm.
    for (const policyId of [nodePolicy, monitorPolicy]) {
      const [arm] = await scoped(t.orgId, () => db.execute<Record<string, unknown>>(sql`SELECT authority_actor, authority_permission_version, armed_at,
          jsonb_array_length(routing_contexts) AS contexts, next_scheduled_at FROM topology_monitoring_policies WHERE id = ${policyId}::uuid`));
      expect(arm).toEqual({ authority_actor: null, authority_permission_version: null, armed_at: null, contexts: 0, next_scheduled_at: null });
    }
    // The node itself stays in its original site; only the binding went.
    expect(await scoped(t.orgId, () => db.execute(sql`SELECT id FROM topology_nodes WHERE id = ${nodeId}::uuid AND site_id = ${t.siteId}::uuid`))).toHaveLength(1);
    // The monitor survived the authority detach with its asset and new site.
    expect(await monitorRow(t.orgId, monitorId)).toEqual({ asset_id: assetId, site_id: target.id, is_active: true });
  });

  it('clears a link to a device left behind in the old site and keeps one to a device already in the target', async () => {
    const t = await createTopologyTenant();
    const target = await createSite({ orgId: t.orgId });
    const oldSiteDevice = await insertDevice(t.orgId, t.siteId);
    const targetSiteDevice = await insertDevice(t.orgId, target.id);
    const leftBehind = await insertAsset(t.orgId, t.siteId, '192.0.2.30', { linkedDeviceId: oldSiteDevice, linkSource: 'manual' });
    const alreadyThere = await insertAsset(t.orgId, t.siteId, '192.0.2.31', { linkedDeviceId: targetSiteDevice, linkSource: 'auto' });

    const results = await move(t.orgId, [leftBehind, alreadyThere], target.id);

    expect(results.map((r) => [r.assetId, r.moved, r.unlinkedDeviceId])).toEqual([
      [leftBehind, true, oldSiteDevice],
      [alreadyThere, true, null],
    ]);
    expect(await assetRow(t.orgId, leftBehind)).toMatchObject({ site_id: target.id, linked_device_id: null, link_source: null });
    expect(await assetRow(t.orgId, alreadyThere)).toMatchObject({ site_id: target.id, linked_device_id: targetSiteDevice, link_source: 'auto' });
  });

  it('refuses a target site in another org and rolls the caller transaction back untouched', async () => {
    const t = await createTopologyTenant();
    const otherOrg = await createOrganization({ partnerId: t.partnerId });
    const foreignSite = await createSite({ orgId: otherOrg.id });
    const assetId = await insertAsset(t.orgId, t.siteId, '192.0.2.40');
    const monitorId = await insertMonitor(t.orgId, assetId, true);

    // A caller-side write in the same transaction must vanish with the throw.
    await expect(scoped(t.orgId, () => db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE discovered_assets SET notes = 'caller write' WHERE id = ${assetId}::uuid`);
      await moveDiscoveredAssetsToSite({ tx, orgId: t.orgId, assetIds: [assetId], targetSiteId: foreignSite.id });
    }))).rejects.toMatchObject({ name: 'DiscoveredAssetSiteMoveError', code: 'site_not_found' } satisfies Partial<DiscoveredAssetSiteMoveError>);

    expect(await assetRow(t.orgId, assetId)).toMatchObject({ site_id: t.siteId, notes: null });
    expect(await monitorRow(t.orgId, monitorId)).toEqual({ asset_id: assetId, site_id: t.siteId, is_active: true });
  });

  it('keeps the moved asset findable by (org, ip) so a rescan of the old site upserts onto it', async () => {
    const t = await createTopologyTenant();
    const target = await createSite({ orgId: t.orgId });
    const ip = '192.0.2.50';
    const assetId = await insertAsset(t.orgId, t.siteId, ip);

    await move(t.orgId, [assetId], target.id);

    // The scan's identity upsert (partial unique index discovered_assets_org_ip_unique):
    // it must land on the existing row, not raise 23505 and not mint a second one.
    const rows = await scoped(t.orgId, () => db.execute<{ id: string; site_id: string }>(sql`
      INSERT INTO discovered_assets (org_id, site_id, ip_address, last_seen_at, is_online)
      VALUES (${t.orgId}::uuid, ${t.siteId}::uuid, ${ip}::inet, now(), true)
      ON CONFLICT (org_id, ip_address) WHERE ip_address IS NOT NULL
      DO UPDATE SET last_seen_at = excluded.last_seen_at, is_online = excluded.is_online
      RETURNING id, site_id`));
    expect(rows).toEqual([{ id: assetId, site_id: target.id }]);
    expect(await scoped(t.orgId, () => db.execute(sql`SELECT id FROM discovered_assets WHERE org_id = ${t.orgId}::uuid AND ip_address = ${ip}::inet`))).toHaveLength(1);
  });
});
