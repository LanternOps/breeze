import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { organizations, topologyMonitoringPolicies, users } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import type { UserPermissions } from '../../services/permissions';
import { encryptSnmpCommunities } from '../../services/snmpSecrets';
import type { TopologyRequestContext } from '../../services/topology/access';
import type { DiagnosticPlanningRepository, DiagnosticPlanningSnapshot } from '../../services/topology/diagnosticTypes';
import { setupTestEnvironment } from '../integration/db-utils';
import { orgContext } from '../integration/topology-fixtures';

/**
 * M3 Task 7/8 fixture: one org/site with a collector agent (routes + root
 * sources), an SNMP switch node with two indexed ports and a discovery
 * profile, a configured tcp target and one compiled policy with activation
 * intent. The planning repository is faked (origin selection has its own
 * suites); every table, trigger and RLS policy is real.
 */
export const MONITORING_GRANTS = [
  { resource: 'topology', action: 'read' },
  { resource: 'topology', action: 'write' },
  { resource: 'topology', action: 'execute' },
  { resource: 'devices', action: 'read' },
  { resource: 'devices', action: 'write' },
  { resource: 'devices', action: 'execute' },
];
export async function pgFailure(work: Promise<unknown>): Promise<string> {
  try { await work; } catch (error) {
    const cause = (error as { cause?: { message?: string; constraint_name?: string } }).cause;
    return `${cause?.constraint_name ?? ''} ${cause?.message ?? (error as Error).message}`;
  }
  return 'no error';
}
export const system = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn, 'topology monitoring authority test'));

export async function seedTopologyMonitoringFixture() {
  const env = await setupTestEnvironment({ scope: 'organization', rolePermissions: MONITORING_GRANTS });
  const orgId = env.organization.id, siteId = env.site.id;
  const deviceId = crypto.randomUUID(), nodeId = crypto.randomUUID(), switchNodeId = crypto.randomUUID(), assetId = crypto.randomUUID();
  const sourceId = crypto.randomUUID(), rootId = crypto.randomUUID(), profileId = crypto.randomUUID(), policyId = crypto.randomUUID(), targetId = crypto.randomUUID();
  const ifaceA = crypto.randomUUID(), ifaceB = crypto.randomUUID();
  await system(() => db.update(organizations)
    .set({ settings: { topologyFeatureFlags: { materialization: true, diagnostics: true, interfaceHealth: true } } })
    .where(eq(organizations.id, orgId)));
  const [user] = await system(() => db.select({ authEpoch: users.authEpoch, mfaEpoch: users.mfaEpoch }).from(users).where(eq(users.id, env.user.id)));
  await withDbAccessContext(orgContext(orgId), async () => {
    await db.execute(sql`INSERT INTO devices (id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version)
      VALUES (${deviceId}::uuid,${orgId}::uuid,${siteId}::uuid,${deviceId},'collector','linux','1','amd64','1')`);
    await db.execute(sql`INSERT INTO topology_site_state (org_id,site_id) VALUES (${orgId}::uuid,${siteId}::uuid) ON CONFLICT DO NOTHING`);
    for (const [id, kind] of [[nodeId, 'endpoint'], [switchNodeId, 'network']] as const) {
      await db.execute(sql`INSERT INTO topology_nodes (id,org_id,site_id,identity_key,identity_material,kind)
        VALUES (${id}::uuid,${orgId}::uuid,${siteId}::uuid,${id},${JSON.stringify({ version: 1, kind, sourceKey: id })}::jsonb,${kind})`);
    }
    await db.execute(sql`INSERT INTO topology_node_bindings (org_id,site_id,node_id,device_id) VALUES (${orgId}::uuid,${siteId}::uuid,${nodeId}::uuid,${deviceId}::uuid)`);
    await db.execute(sql`INSERT INTO discovered_assets (id,org_id,site_id,ip_address,asset_type) VALUES (${assetId}::uuid,${orgId}::uuid,${siteId}::uuid,'192.0.2.10','switch')`);
    await db.execute(sql`INSERT INTO topology_node_bindings (org_id,site_id,node_id,discovered_asset_id) VALUES (${orgId}::uuid,${siteId}::uuid,${switchNodeId}::uuid,${assetId}::uuid)`);
    await db.execute(sql`INSERT INTO topology_interfaces (id,org_id,site_id,owner_node_id,interface_key,epoch,os_index)
      VALUES (${ifaceA}::uuid,${orgId}::uuid,${siteId}::uuid,${switchNodeId}::uuid,'ifIndex:1','gen:1',1),
             (${ifaceB}::uuid,${orgId}::uuid,${siteId}::uuid,${switchNodeId}::uuid,'ifIndex:2','gen:1',2)`);
    await db.execute(sql`INSERT INTO topology_collection_sources (id,org_id,site_id,producer_id,producer_kind,producer_epoch,protocol,context_key,address_family,fresh_until)
      VALUES (${sourceId}::uuid,${orgId}::uuid,${siteId}::uuid,${deviceId}::uuid,'agent','epoch-1','routes','default','ipv4',now()+interval '15 minutes')`);
    await db.execute(sql`INSERT INTO topology_collection_sources (id,org_id,site_id,producer_id,producer_kind,producer_epoch,protocol,context_key,address_family,configuration_revision)
      VALUES (${rootId}::uuid,${orgId}::uuid,${siteId}::uuid,${deviceId}::uuid,'agent','root-epoch','envelope','root','any','cfg-1')`);
    await db.execute(sql`INSERT INTO discovery_profiles (id,org_id,site_id,name,methods,snmp_communities)
      VALUES (${profileId}::uuid,${orgId}::uuid,${siteId}::uuid,'snmp','{snmp}',ARRAY[${encryptSnmpCommunities(['s3cret-community'])![0]!}]::text[])`);
    await db.execute(sql`INSERT INTO topology_probe_targets (id,org_id,site_id,key,label,kind,definition,enabled)
      VALUES (${targetId}::uuid,${orgId}::uuid,${siteId}::uuid,'web','web','tcp',${JSON.stringify({ label: 'web', enabled: true, families: ['ipv4'], provider: null, independenceLabel: null, kind: 'tcp', host: '198.51.100.7', port: 443 })}::jsonb,true)`);
    await db.execute(sql`INSERT INTO topology_monitoring_policies (id,org_id,site_id,key,definition,activation_intent)
      VALUES (${policyId}::uuid,${orgId}::uuid,${siteId}::uuid,'web-check',${JSON.stringify({ kind: 'policy', enabled: true, recipeId: 'target_connectivity', recipeVersion: 1,
        subject: 'configured_target', targetKeys: ['web'], families: ['ipv4'], origin: 'eligible_collector', intervalSeconds: 300, jitterPercent: 10,
        alertsEnabled: true, failureThreshold: 3, recoveryThreshold: 2 })}::jsonb,true)`);
    await db.execute(sql`INSERT INTO topology_policy_targets (org_id,site_id,policy_id,target_id,target_revision,purpose)
      VALUES (${orgId}::uuid,${siteId}::uuid,${policyId}::uuid,${targetId}::uuid,1,'configured_target')`);
  });

  const auth = {
    user: env.user, scope: 'organization', orgId, partnerId: env.partner.id, accessibleOrgIds: [orgId], allowedSiteIds: undefined,
    principal: { kind: 'user_session' }, token: { mfa: true, aep: user!.authEpoch, mep: user!.mfaEpoch, sid: 'session-1' },
    canAccessOrg: (candidate: string) => candidate === orgId,
  } as unknown as AuthContext;
  const ctx: TopologyRequestContext = {
    scope: { orgId, siteId },
    auth,
    permissions: { permissions: MONITORING_GRANTS, scope: 'organization', partnerId: env.partner.id, orgId, roleId: env.role.id } as unknown as UserPermissions,
  };
  const origin = { deviceId, agentId: deviceId, nodeId, bindingId: crypto.randomUUID(), siteId, contextKey: 'default', interfaceId: null, interfaceEpoch: null, interfaceKey: null, sourceId, producerEpoch: 'epoch-1', sequence: '1' };
  const repository: DiagnosticPlanningRepository = {
    load: async () => ({ graphRevision: '0', settings: {}, targets: [], candidates: [{ eligibility: { origin, eligible: true, reasons: [], families: ['ipv4'], rank: 0 } }] }) as unknown as DiagnosticPlanningSnapshot,
  };
  const inOrg = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(orgId), fn);
  const policy = () => system(async () => (await db.select().from(topologyMonitoringPolicies).where(eq(topologyMonitoringPolicies.id, policyId)))[0]!);
  return { env, orgId, siteId, deviceId, nodeId, switchNodeId, profileId, policyId, targetId, ifaceA, ifaceB, ctx, repository, inOrg, policy };
}

