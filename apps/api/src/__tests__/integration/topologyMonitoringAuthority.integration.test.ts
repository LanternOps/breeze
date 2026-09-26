import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { deviceCommands, organizations, topologyMonitoringPolicies, topologyTelemetryArms, users } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import type { UserPermissions } from '../../services/permissions';
import { claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { decryptCommandForDelivery } from '../../services/sensitiveCommandPayload';
import { encryptSnmpCommunities } from '../../services/snmpSecrets';
import type { TopologyRequestContext } from '../../services/topology/access';
import type { DiagnosticPlanningRepository, DiagnosticPlanningSnapshot } from '../../services/topology/diagnosticTypes';
import { armTopologyMonitoringPolicy, disarmTopologyMonitoringPolicy } from '../../services/topology/monitoringArming';
import { withTopologyArmAuthority } from '../../services/topology/monitoringAuthority';
import {
  armTopologyTelemetry,
  dispatchDueTopologyTelemetryArms,
  revokeTopologyTelemetryArm,
  topologyTelemetryArmAuthority,
} from '../../services/topology/telemetryArms';
import { setupTestEnvironment } from './db-utils';
import { orgContext } from './topology-fixtures';

/**
 * M3 Task 7 (M3-D2/D3/D4/D13) against real Postgres/Redis: policy arming pins
 * contexts + a frozen actor; telemetry arms are the only `snmp` telemetry
 * authority; the poll command is encrypted, delivery-revalidated and fenced
 * by credential/generation/actor drift; the new schema refuses malformed
 * state and cross-tenant writes.
 */
afterAll(() => closeDb());

const GRANTS = [
  { resource: 'topology', action: 'read' },
  { resource: 'topology', action: 'write' },
  { resource: 'topology', action: 'execute' },
  { resource: 'devices', action: 'read' },
  { resource: 'devices', action: 'write' },
  { resource: 'devices', action: 'execute' },
];
async function pgFailure(work: Promise<unknown>): Promise<string> {
  try { await work; } catch (error) {
    const cause = (error as { cause?: { message?: string; constraint_name?: string } }).cause;
    return `${cause?.constraint_name ?? ''} ${cause?.message ?? (error as Error).message}`;
  }
  return 'no error';
}
const system = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn, 'topology monitoring authority test'));

async function fixture() {
  const env = await setupTestEnvironment({ scope: 'organization', rolePermissions: GRANTS });
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
    permissions: { permissions: GRANTS, scope: 'organization', partnerId: env.partner.id, orgId, roleId: env.role.id } as unknown as UserPermissions,
  };
  const origin = { deviceId, agentId: deviceId, nodeId, bindingId: crypto.randomUUID(), siteId, contextKey: 'default', interfaceId: null, interfaceEpoch: null, interfaceKey: null, sourceId, producerEpoch: 'epoch-1', sequence: '1' };
  const repository: DiagnosticPlanningRepository = {
    load: async () => ({ graphRevision: '0', settings: {}, targets: [], candidates: [{ eligibility: { origin, eligible: true, reasons: [], families: ['ipv4'], rank: 0 } }] }) as unknown as DiagnosticPlanningSnapshot,
  };
  const inOrg = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(orgId), fn);
  const policy = () => system(async () => (await db.select().from(topologyMonitoringPolicies).where(eq(topologyMonitoringPolicies.id, policyId)))[0]!);
  return { env, orgId, siteId, deviceId, nodeId, switchNodeId, profileId, policyId, targetId, ifaceA, ifaceB, ctx, repository, inOrg, policy };
}

describe('policy arming (M3-D3/D4)', () => {
  it('pins contexts, the narrowed frozen actor and the effect digest; disarm clears them', async () => {
    const f = await fixture();
    const before = await f.policy();
    const armed = await f.inOrg(() => armTopologyMonitoringPolicy(f.ctx, f.policyId, { expectedRevision: before.revision.toString(), extendedContexts: false }, { repository: f.repository }));
    expect(armed.enabled).toBe(true);
    expect(armed.contexts).toEqual([{ contextKey: 'default', family: 'ipv4' }]);
    const row = await f.policy();
    expect(row.enabled).toBe(true);
    expect(row.authorityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect((row.authorityActor as { actor: { accessibleOrgIds: string[] } }).actor.accessibleOrgIds).toEqual([f.orgId]);
    expect(row.routingContexts[0]).toMatchObject({ contextKey: 'default', originDeviceId: f.deviceId, originNodeId: f.nodeId });
    expect(row.alertState.entries).toHaveLength(1);
    expect(row.nextScheduledAt!.getTime()).toBeGreaterThan(Date.now());

    // The stored arm is live authority only while its actor still is.
    expect(await withTopologyArmAuthority(row.authorityActor, f.ctx.scope, ['diagnostics'], async () => 'ok')).toEqual({ ok: true, value: 'ok' });
    await system(() => db.update(users).set({ mfaEpoch: sql`${users.mfaEpoch}+1` }).where(eq(users.id, f.env.user.id)));
    expect(await withTopologyArmAuthority(row.authorityActor, f.ctx.scope, ['diagnostics'], async () => 'ok')).toEqual({ ok: false, reason: 'permission_changed' });

    const disarmed = await f.inOrg(() => disarmTopologyMonitoringPolicy(f.ctx, f.policyId, row.revision.toString()));
    expect(disarmed.enabled).toBe(false);
    const after = await f.policy();
    expect(after.authorityActor).toBeNull();
    expect(after.routingContexts).toEqual([]);
  });

  it('refuses a stale revision, a policy without activation intent and drifted targets', async () => {
    const f = await fixture();
    await expect(f.inOrg(() => armTopologyMonitoringPolicy(f.ctx, f.policyId, { expectedRevision: '99', extendedContexts: false }, { repository: f.repository })))
      .rejects.toMatchObject({ code: 'revision_conflict' });
    await system(() => db.execute(sql`UPDATE topology_probe_targets SET revision = revision + 1 WHERE id = ${f.targetId}::uuid`));
    const row = await f.policy();
    await expect(f.inOrg(() => armTopologyMonitoringPolicy(f.ctx, f.policyId, { expectedRevision: row.revision.toString(), extendedContexts: false }, { repository: f.repository })))
      .rejects.toMatchObject({ code: 'target_changed' });
    await system(() => db.execute(sql`UPDATE topology_monitoring_policies SET activation_intent = false WHERE id = ${f.policyId}::uuid`));
    await expect(f.inOrg(() => armTopologyMonitoringPolicy(f.ctx, f.policyId, { expectedRevision: row.revision.toString(), extendedContexts: false }, { repository: f.repository })))
      .rejects.toMatchObject({ code: 'activation_intent_required' });
    expect((await f.policy()).enabled).toBe(false);
  });

  it('refuses an API-key principal before touching the row', async () => {
    const f = await fixture();
    const ctx = { ...f.ctx, auth: { ...f.ctx.auth, principal: { kind: 'api_key' } } as unknown as AuthContext };
    await expect(f.inOrg(() => armTopologyMonitoringPolicy(ctx, f.policyId, { expectedRevision: '1', extendedContexts: false }, { repository: f.repository })))
      .rejects.toMatchObject({ code: 'interactive_session_required' });
  });
});

describe('telemetry arms (M3-D2/D3)', () => {
  const armRequest = (f: Awaited<ReturnType<typeof fixture>>) => ({
    targetNodeId: f.switchNodeId, collectorDeviceId: f.deviceId, credentialProfileId: f.profileId,
    interfaceIds: [f.ifaceA, f.ifaceB], intervalSeconds: 60, ttlDays: 30,
  });

  it('mints an encrypted, revalidated poll that is the only snmp telemetry authority', async () => {
    const f = await fixture();
    const arm = await f.inOrg(() => armTopologyTelemetry(f.ctx, armRequest(f)));
    expect(arm).toMatchObject({ state: 'armed', authorityKey: 'snmp:192.0.2.10', interfaceCount: 2, generation: '1' });

    expect(await dispatchDueTopologyTelemetryArms({ now: new Date(Date.now() + 1000) })).toEqual({ dispatched: 1, skipped: 0, blocked: 0 });
    // One in flight per arm: a second tick while the first is pending is a skip, not a second batch.
    await system(() => db.update(topologyTelemetryArms).set({ nextPollAt: new Date(0) }).where(eq(topologyTelemetryArms.id, arm.id)));
    expect(await dispatchDueTopologyTelemetryArms({ now: new Date(Date.now() + 2000) })).toEqual({ dispatched: 0, skipped: 1, blocked: 0 });

    const [command] = await system(() => db.select().from(deviceCommands).where(and(eq(deviceCommands.deviceId, f.deviceId), eq(deviceCommands.type, 'topology_interface_poll'))));
    const stored = command!.payload as Record<string, unknown>;
    expect(JSON.stringify(stored)).not.toContain('s3cret-community');
    expect(stored).toMatchObject({ armId: arm.id, generation: '1', target: { address: '192.0.2.10', port: 161 } });

    const request = { family: 'if_metrics' as const, producerKind: 'snmp' as const, scope: f.ctx.scope, device: { id: f.deviceId, orgId: f.orgId, siteId: f.siteId }, authorityKey: 'snmp:192.0.2.10', commandId: command!.id };
    const decision = await system(() => topologyTelemetryArmAuthority(request));
    expect(decision).toMatchObject({ authorized: true });
    expect(decision.authorized && [...decision.interfaceIds].sort()).toEqual([f.ifaceA, f.ifaceB].sort());
    expect(await system(() => topologyTelemetryArmAuthority({ ...request, commandId: null }))).toMatchObject({ authorized: false });

    // A retired interface generation drops out of the allowlist; the rest keep flowing.
    await system(() => db.execute(sql`UPDATE topology_interfaces SET retired_at = now() WHERE id = ${f.ifaceB}::uuid`));
    const narrowed = await system(() => topologyTelemetryArmAuthority(request));
    expect(narrowed.authorized && narrowed.interfaceIds).toEqual([f.ifaceA]);

    // Delivery decrypts just-in-time and only while the arm is intact.
    const delivered = await system(() => claimPendingCommandsForDevice(f.deviceId, 10, 'agent'));
    const polled = delivered.find((row) => row.id === command!.id);
    expect(polled).toBeTruthy();
    expect(JSON.stringify(decryptCommandForDelivery({ id: polled!.id, type: polled!.type, deviceId: f.deviceId, payload: polled!.payload })!.payload)).toContain('s3cret-community');

    // A credential change fences publication immediately.
    await system(() => db.execute(sql`UPDATE discovery_profiles SET snmp_communities = ARRAY[${encryptSnmpCommunities(['rotated'])![0]!}]::text[] WHERE id = ${f.profileId}::uuid`));
    expect(await system(() => topologyTelemetryArmAuthority(request))).toEqual({ authorized: false, reason: 'credential_changed' });
  });

  it('refuses delivery of a poll whose arm was revoked and never lets a foreign interface in', async () => {
    const f = await fixture();
    const arm = await f.inOrg(() => armTopologyTelemetry(f.ctx, armRequest(f)));
    await dispatchDueTopologyTelemetryArms({ now: new Date(Date.now() + 1000) });
    await f.inOrg(() => revokeTopologyTelemetryArm(f.ctx, arm.id));
    const delivered = await system(() => claimPendingCommandsForDevice(f.deviceId, 10, 'agent'));
    expect(delivered.filter((row) => row.type === 'topology_interface_poll')).toEqual([]);
    const [command] = await system(() => db.select().from(deviceCommands).where(and(eq(deviceCommands.deviceId, f.deviceId), eq(deviceCommands.type, 'topology_interface_poll'))));
    expect(command!.status).toBe('cancelled');
    expect((command!.payload as Record<string, unknown>).credentials).toBeUndefined();

    const other = await fixture();
    await expect(f.inOrg(() => armTopologyTelemetry(f.ctx, { ...armRequest(f), interfaceIds: [other.ifaceA] })))
      .rejects.toMatchObject({ code: 'interface_not_armable' });
  });
});

describe('monitoring schema contracts', () => {
  it('rejects an armed policy without authority, malformed alert state and partial occurrences', async () => {
    const f = await fixture();
    expect(await pgFailure(system(() => db.execute(sql`UPDATE topology_monitoring_policies SET enabled = true, authority_digest = ${'a'.repeat(64)} WHERE id = ${f.policyId}::uuid`))))
      .toMatch(/topology_monitoring_policies_armed_chk/);
    const entry = { contextKey: 'default', family: 'ipv4', policyRevision: '1', lastClaimedScheduledFor: null, lastClaimedOccurrenceKey: null, lastAppliedScheduledFor: null,
      lastAppliedOccurrenceKey: null, continuityKey: null, originDeviceId: null, originAgentId: null, consecutiveFailures: 0, consecutiveSuccesses: 0, activeAlertId: null, lastNotifiedAt: null };
    expect(await pgFailure(system(() => db.execute(sql`UPDATE topology_monitoring_policies SET alert_state = ${JSON.stringify({ schemaVersion: 1, entries: [entry, entry] })}::jsonb WHERE id = ${f.policyId}::uuid`))))
      .toMatch(/duplicate topology policy alert state entry/);
    expect(await pgFailure(system(() => db.execute(sql`UPDATE topology_monitoring_policies SET alert_state = ${JSON.stringify({ schemaVersion: 1, entries: [{ ...entry, smuggled: true }] })}::jsonb WHERE id = ${f.policyId}::uuid`))))
      .toMatch(/malformed topology policy alert state entry/);
  });

  it('isolates telemetry arms by org under RLS', async () => {
    const f = await fixture();
    const other = await fixture();
    await f.inOrg(() => armTopologyTelemetry(f.ctx, { targetNodeId: f.switchNodeId, collectorDeviceId: f.deviceId, credentialProfileId: f.profileId, interfaceIds: [f.ifaceA], intervalSeconds: 60, ttlDays: 1 }));
    const visible = await withDbAccessContext(orgContext(other.orgId), () => db.select({ id: topologyTelemetryArms.id }).from(topologyTelemetryArms));
    expect(visible).toEqual([]);
    expect(await pgFailure(withDbAccessContext(orgContext(other.orgId), () => db.execute(sql`INSERT INTO topology_telemetry_arms
      (org_id,site_id,target_node_id,collector_device_id,credential_profile_id,authority_key,target_address,credential_digest,interfaces,armed_by,authority_actor,authority_permission_version,effect_digest,expires_at)
      VALUES (${f.orgId}::uuid,${f.siteId}::uuid,${f.switchNodeId}::uuid,${f.deviceId}::uuid,${f.profileId}::uuid,'snmp:192.0.2.99','192.0.2.99',${'a'.repeat(64)},'[{}]'::jsonb,
        ${f.env.user.id}::uuid,'{}'::jsonb,'v',${'b'.repeat(64)},now()+interval '1 day')`))))
      .toMatch(/row-level security/);
  });
});
