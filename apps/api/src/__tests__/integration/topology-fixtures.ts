import { type DbAccessContext } from '../../db';
import { createOrganization, createPartner, createSite } from './db-utils';

export function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

export async function createTopologyTenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  return { partnerId: partner.id, orgId: org.id, siteId: site.id };
}

export const TOPOLOGY_TABLES = [
  'topology_site_state', 'topology_nodes', 'topology_node_bindings',
  'topology_relationships', 'topology_layouts', 'topology_node_positions', 'topology_change_outbox',
] as const;

export async function createTopologyGraph() {
  const { sql } = await import('drizzle-orm');
  const { db, withDbAccessContext } = await import('../../db');
  const scope = await createTopologyTenant();
  const nodeId = crypto.randomUUID();
  const targetNodeId = crypto.randomUUID();
  const layoutId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const assetId = crypto.randomUUID();
  const manualId = crypto.randomUUID();
  await withDbAccessContext(orgContext(scope.orgId), async () => {
    await db.execute(sql`INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
      VALUES (${deviceId}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, ${deviceId}, 'fixture', 'linux', '1', 'amd64', '1')`);
    await db.execute(sql`INSERT INTO discovered_assets (id, org_id, site_id, ip_address)
      VALUES (${assetId}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, '192.0.2.1')`);
    await db.execute(sql`INSERT INTO topology_manual_nodes (id, org_id, site_id, label, role)
      VALUES (${manualId}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, 'fixture', 'switch')`);
    await db.execute(sql`INSERT INTO topology_site_state (org_id, site_id) VALUES (${scope.orgId}::uuid, ${scope.siteId}::uuid) ON CONFLICT DO NOTHING`);
    for (const id of [nodeId, targetNodeId]) {
      await db.execute(sql`INSERT INTO topology_nodes (id, org_id, site_id, identity_key, identity_material, kind)
        VALUES (${id}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, ${id},
          ${JSON.stringify({ version: 1, kind: 'endpoint', sourceKey: id })}::jsonb, 'endpoint')`);
    }
    await db.execute(sql`INSERT INTO topology_node_bindings (org_id, site_id, node_id, device_id)
      VALUES (${scope.orgId}::uuid, ${scope.siteId}::uuid, ${nodeId}::uuid, ${deviceId}::uuid)`);
    await db.execute(sql`INSERT INTO topology_relationships (org_id, site_id, canonical_key, identity_material, kind, source_node_id, target_node_id)
      VALUES (${scope.orgId}::uuid, ${scope.siteId}::uuid, 'fixture', '{"version":1,"kind":"attachment","sourceKey":"fixture"}', 'attachment', ${nodeId}::uuid, ${targetNodeId}::uuid)`);
    await db.execute(sql`INSERT INTO topology_layouts (id, org_id, site_id, view)
      VALUES (${layoutId}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, 'overview')`);
    await db.execute(sql`INSERT INTO topology_node_positions (org_id, site_id, layout_id, node_id, x, y)
      VALUES (${scope.orgId}::uuid, ${scope.siteId}::uuid, ${layoutId}::uuid, ${nodeId}::uuid, 1, 2)`);
    await db.execute(sql`INSERT INTO topology_change_outbox (org_id, site_id, event_kind, aggregate_id, idempotency_key)
      VALUES (${scope.orgId}::uuid, ${scope.siteId}::uuid, 'fixture', ${nodeId}::uuid, 'fixture')`);
  });
  return { ...scope, nodeId, targetNodeId, layoutId, deviceId, assetId, manualId };
}
