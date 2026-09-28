import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type {
  CreateTopologyDiagnosticRequest,
  TopologyDiagnosticPlan,
  TopologyDiagnosticResult,
  TopologyDiagnosticStep,
  TopologyTraceHop,
} from '@breeze/shared';

import { closeDb, db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  deviceCommands,
  organizations,
  topologyDiagnosticRuns,
  topologyDiagnosticSteps,
  topologyNodeBindings,
  users,
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { clearPermissionCache, type UserPermissions } from '../../services/permissions';
import { claimPendingCommandForDelivery } from '../../services/commandDispatch';
import type { TopologyRequestContext } from '../../services/topology/access';
import type { DiagnosticPlanningRepository, DiagnosticPlanningSnapshot } from '../../services/topology/diagnosticTypes';
import { createTopologyDiagnosticRun } from '../../services/topology/diagnosticRuns';
import { dispatchTopologyDiagnosticRun, validateTopologyCommandAuthority } from '../../services/topology/diagnosticDispatch';
import { acceptTopologyDiagnosticResult } from '../../services/topology/diagnosticResults';
import { buildTopologyTraceViews } from '../../services/topology/tracerouteResults';
import { setupTestEnvironment } from './db-utils';
import { orgContext } from './topology-fixtures';

/**
 * M3 Task 9: a routed trace through the M1 durable command/outbox/journal path,
 * with the M3-D13 live requester-authority boundary at enqueue, delivery and
 * result publication. Only the PLANNING repository is faked (origin selection
 * is covered by its own suites); everything else is the real tables, triggers
 * and command transport rows.
 */
afterAll(() => closeDb());

const GRANTS = [
  { resource: 'topology', action: 'read' },
  { resource: 'topology', action: 'write' },
  { resource: 'topology', action: 'execute' },
  { resource: 'devices', action: 'read' },
  { resource: 'devices', action: 'execute' },
];
const TRACE_CAPS = [
  { name: 'network_diagnostic', version: 1, supported: true },
  { name: 'route_lookup', version: 1, supported: true },
  { name: 'network_trace', version: 1, supported: true },
];

const system = <T>(fn: () => Promise<T>) =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, 'topology trace integration test'));

async function fixture() {
  const env = await setupTestEnvironment({ scope: 'organization', rolePermissions: GRANTS });
  const orgId = env.organization.id;
  const siteId = env.site.id;
  const deviceId = crypto.randomUUID();
  const nodeId = crypto.randomUUID();
  const interfaceId = crypto.randomUUID();
  const sourceId = crypto.randomUUID();
  const envelopeId = crypto.randomUUID();
  const evidenceId = crypto.randomUUID();

  await system(() => db.update(organizations)
    .set({ settings: { topologyFeatureFlags: { materialization: true, diagnostics: true } } })
    .where(eq(organizations.id, orgId)));

  const bindingId = await withDbAccessContext(orgContext(orgId), async () => {
    await db.execute(sql`INSERT INTO devices (id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version)
      VALUES (${deviceId}::uuid,${orgId}::uuid,${siteId}::uuid,${deviceId},'trace-origin','linux','1','amd64','1')`);
    await db.execute(sql`INSERT INTO topology_site_state (org_id,site_id) VALUES (${orgId}::uuid,${siteId}::uuid) ON CONFLICT DO NOTHING`);
    await db.execute(sql`INSERT INTO topology_nodes (id,org_id,site_id,identity_key,identity_material,kind)
      VALUES (${nodeId}::uuid,${orgId}::uuid,${siteId}::uuid,${nodeId},${JSON.stringify({ version: 1, kind: 'endpoint', sourceKey: nodeId })}::jsonb,'endpoint')`);
    await db.execute(sql`INSERT INTO topology_node_bindings (org_id,site_id,node_id,device_id)
      VALUES (${orgId}::uuid,${siteId}::uuid,${nodeId}::uuid,${deviceId}::uuid)`);
    await db.execute(sql`INSERT INTO topology_interfaces (id,org_id,site_id,owner_node_id,interface_key,epoch)
      VALUES (${interfaceId}::uuid,${orgId}::uuid,${siteId}::uuid,${nodeId}::uuid,'eth0','epoch-1')`);
    await db.execute(sql`INSERT INTO topology_collection_sources (id,org_id,site_id,producer_id,producer_kind,producer_epoch,protocol,context_key,address_family)
      VALUES (${sourceId}::uuid,${orgId}::uuid,${siteId}::uuid,${deviceId}::uuid,'agent','epoch-1','routes','default','ipv4')`);
    await db.execute(sql`INSERT INTO topology_collection_sources (id,org_id,site_id,producer_id,producer_kind,producer_epoch,protocol,context_key,address_family,current_baseline)
      VALUES (${envelopeId}::uuid,${orgId}::uuid,${siteId}::uuid,${deviceId}::uuid,'agent','epoch-1','envelope','default','any',${JSON.stringify({ capabilities: TRACE_CAPS })}::jsonb)`);
    const [binding] = await db.select({ id: topologyNodeBindings.id }).from(topologyNodeBindings)
      .where(and(eq(topologyNodeBindings.orgId, orgId), eq(topologyNodeBindings.nodeId, nodeId)));
    return binding!.id;
  });

  const origin: TopologyDiagnosticPlan['origin'] = {
    deviceId, agentId: deviceId, nodeId, bindingId, siteId, contextKey: 'default', interfaceId,
    interfaceEpoch: 'epoch-1', interfaceKey: 'eth0', sourceId, producerEpoch: 'epoch-1', sequence: '1',
  };
  const snapshot = {
    graphRevision: '0',
    settings: {
      binding: { orgId, siteId },
      layers: { partner: null, organization: null, defaultsVersion: 1, resolverVersion: 1 },
      resolved: { settings: { outboundEnabled: true } },
      settingsRevision: '0',
      templateRevisions: {},
    },
    targets: [],
    candidates: [{
      eligibility: { origin, eligible: true, reasons: [], families: ['ipv4'], rank: 0 },
      routes: [], resolvers: [],
      gatewayEvidence: [{ address: '192.0.2.1', zone: null, interfaceId, evidenceId }],
      resolverEvidence: {},
      capabilities: new Set(TRACE_CAPS.map((cap) => cap.name)),
    }],
  } as unknown as DiagnosticPlanningSnapshot;
  const repository: DiagnosticPlanningRepository = { load: async () => snapshot };
  const context: TopologyRequestContext = {
    scope: { orgId, siteId },
    auth: {
      user: env.user, scope: 'organization', orgId, partnerId: env.partner.id, accessibleOrgIds: [orgId], allowedSiteIds: undefined,
      principal: { kind: 'user_session' }, token: { mfa: true }, canAccessOrg: (candidate: string) => candidate === orgId,
    } as unknown as AuthContext,
    permissions: { permissions: GRANTS, scope: 'organization', partnerId: env.partner.id, orgId, roleId: env.role.id } as unknown as UserPermissions,
  };
  const request: CreateTopologyDiagnosticRequest = {
    recipeId: 'trace_route', recipeVersion: 1, subject: { kind: 'node', id: nodeId }, graphRevision: '0', trace: { maxHops: 4, probesPerHop: 1 },
  };

  const row = (runId: string) => system(async () => (await db.select().from(topologyDiagnosticRuns).where(eq(topologyDiagnosticRuns.id, runId)).limit(1))[0] ?? null);
  const command = async (runId: string) => {
    const rows = await system(() => db.select().from(deviceCommands)
      .where(and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.type, 'network_diagnostic'))));
    return rows.find((candidate) => (candidate.payload as { runId?: string }).runId === runId) ?? null;
  };
  const topologyCounts = () => system(async () => {
    const [counts] = await db.execute<{ nodes: string; relationships: string; health: string }>(sql`
      SELECT (SELECT count(*) FROM topology_nodes WHERE org_id = ${orgId}::uuid)::text AS nodes,
             (SELECT count(*) FROM topology_relationships WHERE org_id = ${orgId}::uuid)::text AS relationships,
             (SELECT health_revision::text FROM topology_site_state WHERE org_id = ${orgId}::uuid AND site_id = ${siteId}::uuid) AS health`);
    return counts!;
  });

  return {
    env, orgId, siteId, deviceId, nodeId, origin, request,
    scope: { orgId, siteId },
    create: (overrides: Partial<CreateTopologyDiagnosticRequest> = {}) =>
      withDbAccessContext(orgContext(orgId), () =>
        createTopologyDiagnosticRun(context, { ...request, ...overrides }, crypto.randomUUID(), { repository })),
    dispatch: (runId: string) => dispatchTopologyDiagnosticRun({ orgId, siteId }, runId, { deliver: async () => true }),
    row,
    command,
    topologyCounts,
    revalidate: async (runId: string) => {
      const cmd = await command(runId);
      return system(() => validateTopologyCommandAuthority(
        { id: cmd!.id, type: cmd!.type, deviceId, payload: cmd!.payload } as never, cmd!.payload));
    },
    producer: (commandId: string) => ({ deviceId, agentId: deviceId, commandId }),
    withdrawTrace: () => system(() => db.execute(sql`UPDATE topology_collection_sources SET current_baseline = ${JSON.stringify({ capabilities: TRACE_CAPS.map((cap) => ({ ...cap, supported: cap.name !== 'network_trace' })) })}::jsonb WHERE id = ${envelopeId}::uuid`)),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function traceFrame(
  run: { id: string; attemptId: string; commandId: string | null; plan: TopologyDiagnosticPlan },
  hops: TopologyTraceHop[] = [
    { ttl: 1, attempt: 1, address: '198.51.100.1', rttMs: 1.2, outcome: 'reply', attributionQuality: 'observed' },
    { ttl: 2, attempt: 1, address: null, rttMs: null, outcome: 'timeout', attributionQuality: 'unknown' },
    { ttl: 3, attempt: 1, address: '192.0.2.1', rttMs: 3.4, outcome: 'reply', attributionQuality: 'observed' },
  ],
): TopologyDiagnosticResult {
  const steps: TopologyDiagnosticStep[] = run.plan.steps.map((step) => ({
    id: step.id,
    state: 'succeeded',
    reason: null,
    attribution: {
      originDeviceId: run.plan.origin.deviceId, originAgentId: run.plan.origin.agentId, requestedMethod: step.method, actualMethod: step.method,
      destinationId: step.destinationId, resolvedIp: '192.0.2.1', family: 'ipv4', port: null, interfaceId: run.plan.origin.interfaceId,
      localAddress: '192.0.2.50', contextKey: run.plan.origin.contextKey, tableKey: null, nextHop: '192.0.2.1', proxyUsed: false,
      quality: 'observed', routeChanged: false, evidenceRefs: [],
    },
    startedAt: null, finishedAt: null, receivedAt: null, truncated: false,
    details: step.method === 'trace'
      ? { trace: { protocol: 'icmp_echo', destinationReached: true, maxHops: step.maxHops, probesPerHop: step.probesPerHop, hopsOmitted: 0, hops } }
      : {},
  }));
  return { version: 1, runId: run.id, attemptId: run.attemptId, commandId: run.commandId!, planDigest: run.plan.digest, steps, truncated: false };
}

async function dispatched(f: Fixture) {
  const run = await f.create();
  await f.dispatch(run.id);
  const row = await f.row(run.id);
  expect(row?.commandId).toBeTruthy();
  return { ...run, commandId: row!.commandId };
}

describe('bounded routed trace through the durable executor', () => {
  it('plans one bounded trace step and freezes the requester authority on the run', async () => {
    const f = await fixture();
    const run = await f.create();
    expect(run.plan.recipeId).toBe('trace_route');
    expect(run.plan.steps.map((step) => step.method)).toEqual(['route_lookup', 'trace']);
    expect(run.plan.steps[1]).toMatchObject({ maxHops: 4, probesPerHop: 1, hopTimeoutMs: 1000 });
    expect(run.plan.limits.executionTimeoutSeconds).toBe(60);
    const row = await f.row(run.id);
    expect(row?.requesterAuthority).toMatchObject({ version: 1, userId: f.env.user.id });
    // An M1 recipe keeps its NULL authority; nothing about it changed.
    const gateway = await f.create({ recipeId: 'gateway_basic', trace: undefined });
    expect((await f.row(gateway.id))?.requesterAuthority).toBeNull();
  });

  it('keeps the frozen authority immutable and mandatory for traces', async () => {
    const f = await fixture();
    const run = await f.create();
    await expect(system(() => db.execute(sql`UPDATE topology_diagnostic_runs SET requester_authority = '{"version":1}'::jsonb WHERE id = ${run.id}::uuid`)))
      .rejects.toMatchObject({ cause: expect.objectContaining({ code: '23514' }) });
  });

  it('delivers, accepts and reads back a trace as evidence only — no topology mutation', async () => {
    const f = await fixture();
    const run = await dispatched(f);
    expect((await f.revalidate(run.id)).allow).toBe(true);
    const before = await f.topologyCounts();

    const outcome = await acceptTopologyDiagnosticResult(f.producer(run.commandId!), traceFrame(run));
    expect(outcome).toEqual({ accepted: true, historicalOnly: false });

    const row = await f.row(run.id);
    expect(row).toMatchObject({ state: 'completed', assessment: 'healthy' });
    const after = await f.topologyCounts();
    expect({ nodes: after.nodes, relationships: after.relationships }).toEqual({ nodes: before.nodes, relationships: before.relationships });
    const responders = await system(() => db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM topology_nodes WHERE org_id = ${f.orgId}::uuid AND identity_material::text LIKE '%198.51.100.1%'`));
    expect(responders[0]!.n).toBe('0');

    const steps = await system(() => db.select().from(topologyDiagnosticSteps).where(eq(topologyDiagnosticSteps.runId, run.id)));
    const [view] = buildTopologyTraceViews(run.plan, steps.map((step) => step.result));
    expect(view).toMatchObject({ kind: 'observed_routed_path', destinationReached: true });
    expect(view!.hops.map((hop) => [hop.ttl, hop.responders.map((r) => r.address), hop.gaps.length])).toEqual([
      [1, ['198.51.100.1'], 0], [2, [], 1], [3, ['192.0.2.1'], 0],
    ]);
  });

  it('refuses a trace result wider than its accepted plan', async () => {
    const f = await fixture();
    const run = await dispatched(f);
    const wide = traceFrame(run, [{ ttl: 9, attempt: 1, address: '192.0.2.1', rttMs: 1, outcome: 'reply', attributionQuality: 'observed' }]);
    const trace = wide.steps.find((step) => step.details.trace)!;
    trace.details.trace!.maxHops = 9;
    await expect(acceptTopologyDiagnosticResult(f.producer(run.commandId!), wide)).rejects.toMatchObject({ code: 'diagnostic_result_unauthorized' });
    expect((await f.row(run.id))?.state).not.toBe('completed');
  });

  it('fences at enqueue: a requester signed out everywhere never gets a command minted', async () => {
    const f = await fixture();
    const run = await f.create();
    await system(() => db.update(users).set({ authEpoch: sql`${users.authEpoch} + 1` }).where(eq(users.id, f.env.user.id)));
    await f.dispatch(run.id);
    expect(await f.command(run.id)).toBeNull();
    expect(await f.row(run.id)).toMatchObject({ state: 'cancelled', failureReason: 'authority_requester_changed' });
  });

  it('fences at delivery: a permission change cancels the queued command on the socket leg', async () => {
    const f = await fixture();
    const run = await dispatched(f);
    await clearPermissionCache(f.env.user.id);
    expect(await f.revalidate(run.id)).toEqual({ allow: false, reason: 'scope_changed' });
    const commandId = (await f.command(run.id))!.id;
    expect(await claimPendingCommandForDelivery(commandId)).toBeNull();
    expect((await f.command(run.id))?.status).toBe('cancelled');
  });

  it('fences at delivery when the origin stops advertising trace support', async () => {
    const f = await fixture();
    const run = await dispatched(f);
    await f.withdrawTrace();
    expect(await f.revalidate(run.id)).toEqual({ allow: false, reason: 'scope_changed' });
  });

  it('fences at result publication: evidence is kept as history but never published', async () => {
    const f = await fixture();
    const run = await dispatched(f);
    const before = await f.topologyCounts();
    await system(() => db.update(organizations)
      .set({ settings: { topologyFeatureFlags: { materialization: true, diagnostics: false } } })
      .where(eq(organizations.id, f.orgId)));

    const outcome = await acceptTopologyDiagnosticResult(f.producer(run.commandId!), traceFrame(run));
    expect(outcome).toEqual({ accepted: true, historicalOnly: true });
    expect(await f.row(run.id)).toMatchObject({ state: 'cancelled', failureReason: 'authority_diagnostics_disabled', assessment: 'unknown' });
    const steps = await system(() => db.select().from(topologyDiagnosticSteps).where(eq(topologyDiagnosticSteps.runId, run.id)));
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((step) => step.historicalOnly)).toBe(true);
    expect((await f.topologyCounts()).health).toBe(before.health);
  });
});
