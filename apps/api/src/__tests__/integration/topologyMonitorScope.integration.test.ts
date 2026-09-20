import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { createSite } from './db-utils';
import { createTopologyGraph, createTopologyTenant, orgContext } from './topology-fixtures';
const scoped = <T>(orgId: string, action: () => Promise<T>) => withDbAccessContext(orgContext(orgId), action);

describe('topology runtime scope', () => {
  it('enforces org RLS and same-site target/policy references as breeze_app', async () => {
    const a = await createTopologyGraph(), b = await createTopologyTenant();
    const targetId = crypto.randomUUID(), policyId = crypto.randomUUID();
    await scoped(a.orgId, () => db.execute(sql`INSERT INTO topology_probe_targets(id,org_id,site_id,key,label,kind,definition)
      VALUES(${targetId}::uuid,${a.orgId}::uuid,${a.siteId}::uuid,'target','Target','tcp','{}')`));
    expect(await scoped(b.orgId, () => db.execute(sql`SELECT * FROM topology_probe_targets WHERE id=${targetId}::uuid`))).toHaveLength(0);
    await expect(scoped(b.orgId, () => db.execute(sql`INSERT INTO topology_probe_targets(org_id,site_id,key,label,kind,definition)
      VALUES(${a.orgId}::uuid,${a.siteId}::uuid,'forge','Target','tcp','{}')`))).rejects.toMatchObject({cause:{code:'42501'}});
    const second = await createSite({ orgId: a.orgId });
    await scoped(a.orgId, () => db.execute(sql`INSERT INTO topology_monitoring_policies(id,org_id,site_id,key,definition)
      VALUES(${policyId}::uuid,${a.orgId}::uuid,${second.id}::uuid,'policy','{}')`));
    await expect(scoped(a.orgId, () => db.execute(sql`INSERT INTO topology_policy_targets(org_id,site_id,policy_id,target_id,target_revision,purpose)
      VALUES(${a.orgId}::uuid,${second.id}::uuid,${policyId}::uuid,${targetId}::uuid,1,'primary')`))).rejects.toMatchObject({cause:{code:'23503'}});
  });
  it('binds old asset-monitor writers and detaches before an individual asset move', async () => {
    const a = await createTopologyGraph(); const next = await createSite({ orgId: a.orgId }); const monitorId = crypto.randomUUID();
    await scoped(a.orgId, async () => {
      await db.execute(sql`INSERT INTO network_monitors(id,org_id,asset_id,name,monitor_type,target)
        VALUES(${monitorId}::uuid,${a.orgId}::uuid,${a.assetId}::uuid,'fixture','icmp_ping','192.0.2.1')`);
      expect((await db.execute(sql`SELECT site_id,is_active FROM network_monitors WHERE id=${monitorId}::uuid`))[0]).toMatchObject({site_id:a.siteId,is_active:true});
      await db.execute(sql`INSERT INTO topology_monitor_bindings(org_id,site_id,node_id,monitor_id,context_key,family,metric_role)
        VALUES(${a.orgId}::uuid,${a.siteId}::uuid,${a.nodeId}::uuid,${monitorId}::uuid,'default','ipv4','connectivity')`);
      await db.execute(sql`UPDATE discovered_assets SET site_id=${next.id}::uuid WHERE id=${a.assetId}::uuid`);
      expect((await db.execute(sql`SELECT site_id,asset_id,is_active FROM network_monitors WHERE id=${monitorId}::uuid`))[0]).toMatchObject({site_id:a.siteId,asset_id:null,is_active:false});
      expect(await db.execute(sql`SELECT * FROM topology_monitor_bindings WHERE monitor_id=${monitorId}::uuid`)).toHaveLength(0);
      expect(await db.execute(sql`SELECT id FROM topology_nodes WHERE id=${a.nodeId}::uuid AND site_id=${a.siteId}::uuid`)).toHaveLength(1);
    });
  });
  it('retains assetless legacy monitor scope as unknown and rejects foreign-site monitor bindings', async () => {
    const a = await createTopologyGraph(); const second = await createSite({orgId:a.orgId}); const monitorId=crypto.randomUUID();
    await scoped(a.orgId, async () => {
      await db.execute(sql`INSERT INTO network_monitors(id,org_id,name,monitor_type,target) VALUES(${monitorId}::uuid,${a.orgId}::uuid,'legacy','icmp_ping','192.0.2.2')`);
      expect((await db.execute(sql`SELECT site_id FROM network_monitors WHERE id=${monitorId}::uuid`))[0]?.site_id).toBeNull();
      await db.execute(sql`UPDATE network_monitors SET site_id=${second.id}::uuid WHERE id=${monitorId}::uuid`);
    });
    await expect(scoped(a.orgId, () => db.execute(sql`INSERT INTO topology_monitor_bindings(org_id,site_id,node_id,monitor_id,context_key,family,metric_role)
        VALUES(${a.orgId}::uuid,${a.siteId}::uuid,${a.nodeId}::uuid,${monitorId}::uuid,'default','ipv4','connectivity')`))).rejects.toMatchObject({cause:{code:'23503'}});
  });
  it('fences queued execution before inventory leaves while retaining original accepted history', async () => {
    const a=await createTopologyGraph(); const next=await createSite({orgId:a.orgId});
    const runId=crypto.randomUUID(), commandId=crypto.randomUUID();
    await scoped(a.orgId, async () => {
      await db.execute(sql`INSERT INTO device_commands(id,device_id,type,status) VALUES(${commandId}::uuid,${a.deviceId}::uuid,'network_diagnostic','pending')`);
      await db.execute(sql`INSERT INTO topology_diagnostic_runs(id,org_id,site_id,recipe_id,recipe_version,requester_id,subject_node_id,origin_node_id,origin_snapshot,plan,plan_digest,idempotency_key,body_hash,attempt_id,command_id,queue_deadline,deadline)
        VALUES(${runId}::uuid,${a.orgId}::uuid,${a.siteId}::uuid,'gateway_basic',1,${crypto.randomUUID()}::uuid,${a.nodeId}::uuid,${a.nodeId}::uuid,
        ${JSON.stringify({deviceId:a.deviceId})}::jsonb,'{}',${'0'.repeat(64)},'fixture',${'1'.repeat(64)},${crypto.randomUUID()}::uuid,${commandId}::uuid,now()+interval '30 seconds',now()+interval '120 seconds')`);
      await db.execute(sql`UPDATE devices SET site_id=${next.id}::uuid WHERE id=${a.deviceId}::uuid`);
      expect((await db.execute(sql`SELECT state,site_id,origin_snapshot FROM topology_diagnostic_runs WHERE id=${runId}::uuid`))[0]).toMatchObject({state:'cancelled',site_id:a.siteId,origin_snapshot:{deviceId:a.deviceId}});
      expect((await db.execute(sql`SELECT status FROM device_commands WHERE id=${commandId}::uuid`))[0]?.status).toBe('cancelled');
    });
    await expect(scoped(a.orgId,() => db.execute(sql`UPDATE topology_diagnostic_runs SET state='running' WHERE id=${runId}::uuid`))).rejects.toMatchObject({cause:{code:'23514'}});
    await expect(scoped(a.orgId,() => db.execute(sql`UPDATE topology_diagnostic_runs SET plan='{"forged":true}' WHERE id=${runId}::uuid`))).rejects.toMatchObject({cause:{code:'23514'}});
  });

});
