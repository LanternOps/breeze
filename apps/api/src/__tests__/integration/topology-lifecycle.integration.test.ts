import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { executeOrgMerge } from '../../services/orgMerge';
import { cascadeDeleteOrg, cascadeDeletePartner } from '../../services/tenantCascade';
import { canonicalIdentityKey } from '../../services/topology/identity';
import { publishTopologyBuild } from '../../services/topology/publish';
import { detachTopologyInventoryBinding } from '../../services/topology/tenantLifecycle';
import { createOrganization, createSite } from './db-utils';
import { createTopologyGraph, orgContext, TOPOLOGY_TABLES } from './topology-fixtures';

// M2 view exclusions are a graph child of topology_relationships; they must
// follow every lifecycle path the M0 tables do.
const LIFECYCLE_TABLES = [...TOPOLOGY_TABLES, 'topology_view_exclusions'] as const;
const exclusionRow = (id: string) => db.execute(sql`SELECT org_id,site_id,relationship_id,view,reason,revoked_at FROM topology_view_exclusions WHERE id=${id}::uuid`);

const scopeOf = (scope: { orgId:string;siteId:string }) => ({ orgId:scope.orgId,siteId:scope.siteId });
const actor = '00000000-0000-0000-0000-000000000000';
const scoped = <T>(orgId: string, fn: () => Promise<T>) => withDbAccessContext(orgContext(orgId), fn);
async function fixture() {
  const f = await createTopologyGraph();
  const assetNode = randomUUID();
  const manualNode = randomUUID();
  const exclusionId = randomUUID();
  let relationshipId = '';
  await scoped(f.orgId, async () => {
    for (const [id, kind] of [[f.nodeId, 'endpoint'], [f.targetNodeId, 'endpoint'], [assetNode, 'endpoint'], [manualNode, 'manual']] as const) {
      const material = { version: 1, kind, sourceKey: id };
      await db.execute(sql`INSERT INTO topology_nodes (id,org_id,site_id,identity_key,identity_material,kind,label_override,attributes)
        VALUES (${id}::uuid,${f.orgId}::uuid,${f.siteId}::uuid,${canonicalIdentityKey(scopeOf(f), kind, id)},${JSON.stringify(material)}::jsonb,${kind},'Retain label','{"notes":"Retain notes"}')
        ON CONFLICT (id) DO UPDATE SET identity_key = EXCLUDED.identity_key, identity_material = EXCLUDED.identity_material,
          label_override = EXCLUDED.label_override, attributes = EXCLUDED.attributes`);
    }
    await db.execute(sql`INSERT INTO topology_node_bindings (org_id,site_id,node_id,discovered_asset_id)
      VALUES (${f.orgId}::uuid,${f.siteId}::uuid,${assetNode}::uuid,${f.assetId}::uuid)`);
    await db.execute(sql`INSERT INTO topology_node_bindings (org_id,site_id,node_id,manual_node_id)
      VALUES (${f.orgId}::uuid,${f.siteId}::uuid,${manualNode}::uuid,${f.manualId}::uuid)`);
    const [relationship] = await db.execute(sql`SELECT id FROM topology_relationships WHERE org_id=${f.orgId}::uuid`);
    relationshipId = relationship!.id as string;
    const sourceKey = `manual:${relationship!.id}`;
    await db.execute(sql`UPDATE topology_relationships SET canonical_key=${canonicalIdentityKey(scopeOf(f), 'attachment', sourceKey)},
      identity_material=${JSON.stringify({ version: 1, kind: 'attachment', sourceKey })}::jsonb WHERE id=${relationship!.id}::uuid`);
    await db.execute(sql`UPDATE topology_node_positions SET pinned=true WHERE node_id=${f.nodeId}::uuid`);
    await db.execute(sql`INSERT INTO topology_view_exclusions (id,org_id,site_id,relationship_id,view,reason,created_by)
      VALUES (${exclusionId}::uuid,${f.orgId}::uuid,${f.siteId}::uuid,${relationship!.id}::uuid,'physical','Retain exclusion',${actor}::uuid)`);
    // The foundation helper's synthetic outbox row predates the typed capture
    // protocol. Keep only real captured envelopes for merge-normalization proof.
    await db.execute(sql`DELETE FROM topology_change_outbox WHERE org_id=${f.orgId}::uuid AND event_kind='fixture'`);
  });
  return { ...f, assetNode, manualNode, exclusionId, relationshipId };
}

beforeEach(() => { vi.stubEnv('ORG_MERGE_FENCE_DRAIN_MS', '0'); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('topology inventory and tenant lifecycle', () => {
  it('detaches before a direct device site update and generic denormalization, retaining history and pins', async () => {
    const f = await fixture(); const destination = await createSite({ orgId: f.orgId });
    await scoped(f.orgId, async () => {
      await db.execute(sql`UPDATE devices SET site_id=${destination.id}::uuid WHERE id=${f.deviceId}::uuid`);
      // The same denormalization the PATCH route executes must find no binding
      // left to drag away from its historical canonical node.
      await db.execute(sql`UPDATE topology_node_bindings SET site_id=${destination.id}::uuid WHERE device_id=${f.deviceId}::uuid`);
      expect(await db.execute(sql`SELECT id FROM topology_node_bindings WHERE device_id=${f.deviceId}::uuid`)).toHaveLength(0);
      expect((await db.execute(sql`SELECT site_id,label_override FROM topology_nodes WHERE id=${f.nodeId}::uuid`))[0])
        .toEqual({ site_id: f.siteId, label_override: 'Retain label' });
      expect((await db.execute(sql`SELECT x,y,pinned FROM topology_node_positions WHERE node_id=${f.nodeId}::uuid`))[0])
        .toEqual({ x: 1, y: 2, pinned: true });
      expect(await exclusionRow(f.exclusionId)).toEqual([{ org_id:f.orgId,site_id:f.siteId,relationship_id:f.relationshipId,view:'physical',reason:'Retain exclusion',revoked_at:null }]);
      expect(await db.execute(sql`SELECT id FROM audit_logs WHERE action='topology.binding_detached' AND resource_id=${f.nodeId}::uuid`)).toHaveLength(1);
      const events = await db.execute(sql`SELECT site_id,payload->'data' AS data FROM topology_change_outbox WHERE aggregate_id=${f.deviceId}::uuid ORDER BY created_at`);
      expect(events.filter(e => e.site_id === f.siteId && e.data === null)).toHaveLength(1);
      expect(events.filter(e => e.site_id === destination.id)).toHaveLength(1);
      expect(await publishTopologyBuild(scopeOf(f), { buildFence:'0', inputRevision:'1', nodes:[],relationships:[],bindings:[] }))
        .toMatchObject({ published:false });
    });
  });

  it('uses the same idempotent helper for app asset moves, without touching another tenant', async () => {
    const f = await fixture(); const destination = await createSite({ orgId:f.orgId }); const foreign = await fixture();
    await scoped(f.orgId, () => db.transaction(async tx => {
      expect(await detachTopologyInventoryBinding(tx, { kind:'asset',id:foreign.assetId,oldScope:scopeOf(foreign),newScope:null })).toBe(0);
      const move = { kind:'asset' as const,id:f.assetId,oldScope:scopeOf(f),newScope:{ orgId:f.orgId,siteId:destination.id } };
      expect(await detachTopologyInventoryBinding(tx, move)).toBe(1);
      await tx.execute(sql`UPDATE discovered_assets SET site_id=${destination.id}::uuid WHERE id=${f.assetId}::uuid`);
      expect(await detachTopologyInventoryBinding(tx, move)).toBe(0);
      expect(await tx.execute(sql`SELECT id FROM audit_logs WHERE action='topology.binding_detached' AND resource_id=${f.assetNode}::uuid`)).toHaveLength(1);
    }));
    expect(await scoped(foreign.orgId, () => db.execute(sql`SELECT id FROM topology_node_bindings WHERE discovered_asset_id=${foreign.assetId}::uuid`))).toHaveLength(1);
  });

  it.each(['device','asset','manual'] as const)('direct %s deletion detaches its current binding without deleting the canonical node', async kind => {
    const f = await fixture();
    const [table,column,id,nodeId] = kind==='device' ? ['devices','device_id',f.deviceId,f.nodeId]
      : kind==='asset' ? ['discovered_assets','discovered_asset_id',f.assetId,f.assetNode]
      : ['topology_manual_nodes','manual_node_id',f.manualId,f.manualNode];
    await scoped(f.orgId, async () => {
      await db.execute(sql`DELETE FROM ${sql.identifier(table!)} WHERE id=${id}::uuid`);
      expect(await db.execute(sql`SELECT id FROM topology_node_bindings WHERE ${sql.identifier(column!)}=${id}::uuid`)).toHaveLength(0);
      expect(await db.execute(sql`SELECT id FROM topology_nodes WHERE id=${nodeId}::uuid`)).toHaveLength(1);
      expect(await db.execute(sql`SELECT id FROM audit_logs WHERE action='topology.binding_detached' AND resource_id=${nodeId}::uuid`)).toHaveLength(1);
    });
  });

  it('real executeOrgMerge preserves sites, canonical IDs, manual work and pins while rekeying and fencing pending work', async () => {
    const f = await fixture(); const survivor = await createOrganization({ partnerId:f.partnerId });
    const result = await executeOrgMerge({ loserOrgId:f.orgId,survivorOrgId:survivor.id,partnerId:f.partnerId,performedBy:actor });
    expect(result.topology).toEqual({ rekeyed:5,fenced:1 });
    await scoped(survivor.id, async () => {
      const newScope = { orgId:survivor.id,siteId:f.siteId };
      expect((await db.execute(sql`SELECT id FROM topology_nodes WHERE org_id=${survivor.id}::uuid AND site_id=${f.siteId}::uuid
        AND identity_key=${canonicalIdentityKey(newScope, 'endpoint', f.nodeId)}`))[0]!.id).toBe(f.nodeId);
      expect(await db.execute(sql`SELECT id FROM topology_node_bindings WHERE org_id=${survivor.id}::uuid AND site_id=${f.siteId}::uuid`)).toHaveLength(3);
      expect((await db.execute(sql`SELECT label_override,attributes FROM topology_nodes WHERE id=${f.nodeId}::uuid`))[0])
        .toEqual({ label_override:'Retain label',attributes:{ notes:'Retain notes' } });
      expect((await db.execute(sql`SELECT layout_id,x,y,pinned FROM topology_node_positions WHERE node_id=${f.nodeId}::uuid`))[0])
        .toEqual({ layout_id:f.layoutId,x:1,y:2,pinned:true });
      // Relationship UUIDs survive the merge (only canonical keys are re-keyed),
      // so the exclusion keeps its UUID, view and reason under the survivor org.
      expect(await exclusionRow(f.exclusionId)).toEqual([{ org_id:survivor.id,site_id:f.siteId,relationship_id:f.relationshipId,view:'physical',reason:'Retain exclusion',revoked_at:null }]);
      const events = await db.execute(sql`SELECT source_revision::text,payload FROM topology_change_outbox WHERE org_id=${survivor.id}::uuid`);
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        const payload = event.payload as { newIdentity:{orgId:string};sourceRevision:string };
        expect(payload.newIdentity.orgId).toBe(survivor.id);
        expect(payload.sourceRevision).toBe(event.source_revision);
      }
      expect(await publishTopologyBuild(newScope,{buildFence:'0',inputRevision:'1',nodes:[],relationships:[],bindings:[]})).toMatchObject({published:false});
      expect((await db.execute(sql`SELECT graph_revision::text,settings_revision::text FROM topology_site_state WHERE site_id=${f.siteId}::uuid`))[0])
        .toEqual({graph_revision:'1',settings_revision:'1'});
    });
  });

  it('resolves a same-IP asset collision without moving its historical canonical association to the other site', async () => {
    const f = await fixture(); const survivor = await createOrganization({partnerId:f.partnerId});
    const survivorSite = await createSite({orgId:survivor.id}); const survivorAsset = randomUUID();
    await scoped(survivor.id, () => db.execute(sql`INSERT INTO discovered_assets (id,org_id,site_id,ip_address)
      VALUES (${survivorAsset}::uuid,${survivor.id}::uuid,${survivorSite.id}::uuid,'192.0.2.1')`));
    await executeOrgMerge({loserOrgId:f.orgId,survivorOrgId:survivor.id,partnerId:f.partnerId,performedBy:actor});
    await scoped(survivor.id, async () => {
      expect(await db.execute(sql`SELECT id FROM topology_node_bindings WHERE discovered_asset_id=${f.assetId}::uuid`)).toHaveLength(0);
      expect((await db.execute(sql`SELECT id,site_id FROM topology_nodes WHERE id=${f.assetNode}::uuid`))[0]).toEqual({id:f.assetNode,site_id:f.siteId});
      expect(await db.execute(sql`SELECT id FROM topology_node_bindings WHERE node_id=${f.assetNode}::uuid AND discovered_asset_id=${survivorAsset}::uuid`)).toHaveLength(0);
    });
  });

  it.each(['organization','partner'] as const)('erases all %s topology rows despite source deletion capture, preserving another tenant', async kind => {
    const f = await fixture(); const keep = await fixture();
    if (kind==='organization') await cascadeDeleteOrg(f.orgId,actor);
    else await cascadeDeletePartner(f.partnerId,actor);
    await withSystemDbAccessContext(async () => {
      for (const name of LIFECYCLE_TABLES) {
        expect(await db.execute(sql`SELECT * FROM ${sql.identifier(name)} WHERE org_id=${f.orgId}::uuid`)).toHaveLength(0);
        expect((await db.execute(sql`SELECT * FROM ${sql.identifier(name)} WHERE org_id=${keep.orgId}::uuid`)).length).toBeGreaterThan(0);
      }
    });
  });
});
