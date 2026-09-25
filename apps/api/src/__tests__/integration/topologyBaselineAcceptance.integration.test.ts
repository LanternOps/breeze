import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { graphResponseSchema, type GraphResponse, type NetworkContextFull, type TopologyDiagnosticPlan, type TopologyDiagnosticResult, type TopologyDiagnosticStep } from '@breeze/shared';
import { closeDb, db, runOutsideDbContext, withDbAccessContext, withDbTransaction, withSystemDbAccessContext } from '../../db';
import { deviceCommands, organizations } from '../../db/schema';
import { authMiddleware, type AuthContext } from '../../middleware/auth';
import { topologyGraphRoutes } from '../../routes/topology/graphs';
import { clearPermissionCache, type UserPermissions } from '../../services/permissions';
import type { TopologyRequestContext } from '../../services/topology/access';
import { negotiateTopologyContext } from '../../services/topology/collectionAuthority';
import { topologyContextDigest, topologySectionDigest } from '../../services/topology/collectionDigest';
import { ingestTopologyNetworkContext } from '../../services/topology/collectionIngest';
import type { AuthenticatedTopologyProducer } from '../../services/topology/collectionTypes';
import { upsertTopologyProbeTarget } from '../../services/topology/configurationObjects';
import { dispatchTopologyDiagnosticRun, drainTopologyDiagnosticDispatch } from '../../services/topology/diagnosticDispatch';
import { acceptTopologyDiagnosticResult } from '../../services/topology/diagnosticResults';
import { createTopologyDiagnosticRun, getTopologyDiagnosticRun } from '../../services/topology/diagnosticRuns';
import { drainTopologyOutbox, importLegacyTopologySite } from '../../services/topology/legacyImport';
import { reconcileTopologySite } from '../../services/topology/reconcile';
import { updateTopologySiteConfiguration } from '../../services/topology/siteConfiguration';
import { networkContextFixture } from '../../../../../packages/shared/src/testing/topologyFixtures';
import { setupTestEnvironment } from './db-utils';
import { orgContext } from './topology-fixtures';

afterAll(() => closeDb());

/**
 * `baseline-no-management`: one enrolled agent reporting exactly one interface,
 * one IPv4 prefix, one default route, one resolver and no neighbours, plus two
 * inventory peers that arrive the way M0 peers legitimately do — as discovered
 * assets projected by the legacy import. Nothing here seeds a canonical physical
 * edge, and no section kind in the schema can carry LLDP/SNMP/FDB/controller
 * evidence, so the fixture is management-plane free by construction.
 */

const GRANTS = [
  { resource: 'topology', action: 'read' },
  { resource: 'topology', action: 'write' },
  { resource: 'topology', action: 'execute' },
  { resource: 'devices', action: 'read' },
  { resource: 'devices', action: 'write' },
  { resource: 'devices', action: 'execute' },
];

const system = <T>(fn: () => Promise<T>) =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, 'topology baseline acceptance test'));

/** Documentation-only targets (RFC 2606 `.invalid`). Nothing resolvable. */
const DNS_TARGET = {
  kind: 'dns_name' as const, label: 'controlled dns', enabled: true, families: ['ipv4' as const],
  provider: null, independenceLabel: null, hostname: 'known-answer.example.invalid',
  expectedAddresses: ['192.0.2.80'], resolver: 'configured_dns' as const,
};
const httpsTarget = (label: string, hostname: string) => ({
  kind: 'https' as const, label, enabled: true, families: ['ipv4' as const], provider: null,
  independenceLabel: null, hostname, port: 443, path: '/', method: 'HEAD' as const,
  expectedStatus: 200, maxRedirects: 0, proxyMode: 'direct' as const,
});

type FixtureOptions = { targets?: { key: string; definition: object }[] };

async function baseline(options: FixtureOptions = {}) {
  const env = await setupTestEnvironment({ scope: 'organization', rolePermissions: GRANTS });
  const orgId = env.organization.id;
  const siteId = env.site.id;
  const scope = { orgId, siteId };
  const scoped = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(orgId), fn);
  const deviceId = crypto.randomUUID();
  const peerIds = [crypto.randomUUID(), crypto.randomUUID()];

  await system(() =>
    db.update(organizations)
      .set({ settings: { topologyFeatureFlags: { materialization: true, diagnostics: true } } })
      .where(eq(organizations.id, orgId)),
  );

  const context: TopologyRequestContext = {
    scope,
    auth: {
      user: env.user, scope: 'organization', orgId, partnerId: env.partner.id,
      accessibleOrgIds: [orgId], allowedSiteIds: undefined, token: { mfa: true },
      canAccessOrg: (candidate: string) => candidate === orgId,
    } as unknown as AuthContext,
    permissions: {
      permissions: GRANTS, scope: 'organization', partnerId: env.partner.id, orgId, roleId: env.role.id,
    } as unknown as UserPermissions,
  };

  // The reporting agent and the two inventory peers. The legacy capture trigger
  // enqueues each insert, so these become canonical nodes through the real M0
  // import rather than through a hand-written graph row.
  await scoped(async () => {
    await db.execute(sql`INSERT INTO devices (id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version,status,last_seen_at,agent_token_hash)
      VALUES (${deviceId}::uuid,${orgId}::uuid,${siteId}::uuid,${deviceId},'baseline-origin','linux','1','amd64','1','online',now(),${'a'.repeat(64)})`);
    for (const [index, peerId] of peerIds.entries()) {
      await db.execute(sql`INSERT INTO discovered_assets (id,org_id,site_id,ip_address,hostname)
        VALUES (${peerId}::uuid,${orgId}::uuid,${siteId}::uuid,${`192.0.2.${20 + index}`},${`peer-${index}`})`);
    }
  });

  // Outbound probing and every configured destination must be settled BEFORE the
  // collector negotiates: the accepted configuration revision is part of origin
  // eligibility, so a later settings bump would make the collector ineligible.
  await scoped(() =>
    updateTopologySiteConfiguration(context, { targets: {}, policies: {}, outboundEnabled: true }, '0'),
  );
  for (const target of options.targets ?? []) {
    const [row] = await scoped(() => db.execute(sql`SELECT settings_revision::text AS revision FROM topology_site_state WHERE org_id=${orgId}::uuid AND site_id=${siteId}::uuid`));
    await scoped(() =>
      upsertTopologyProbeTarget(context, {
        expectedRevision: String(row!.revision), key: target.key, definition: target.definition,
      } as Parameters<typeof upsertTopologyProbeTarget>[1]),
    );
  }

  // Real M0 import: it both projects the inventory into canonical nodes and
  // leaves the legacy checkpoint `complete`, which is what lets the collection
  // reconciler publish at all.
  let imported = await scoped(() => importLegacyTopologySite(scope));
  for (let attempt = 0; !imported.complete && attempt < 30; attempt++) {
    imported = await scoped(() => drainTopologyOutbox(scope));
  }
  expect(imported.complete).toBe(true);

  const config = await scoped(() => withDbTransaction(() => negotiateTopologyContext(deviceId)));
  if (!('producerEpoch' in config)) throw new Error('fixture capability disabled');
  const producer: AuthenticatedTopologyProducer = {
    scope, producerId: deviceId, producerKind: 'agent', producerEpoch: config.producerEpoch!,
    configurationRevision: config.configurationRevision!, sourceIdentity: config.sourceIdentity!,
  };

  const full = (sequence: string, offsetMs: number, edit?: (report: NetworkContextFull) => void) => {
    const report = networkContextFixture();
    Object.assign(report, {
      producerEpoch: producer.producerEpoch, sequence, snapshotId: crypto.randomUUID(),
      capturedAt: new Date(Date.now() + offsetMs).toISOString(),
      // The collector advertises what the diagnostic origin check requires; the
      // baseline still carries no management-plane section of any kind.
      capabilities: [
        { name: 'interfaces', version: 1, supported: true },
        { name: 'network_diagnostic', version: 1, supported: true },
        { name: 'route_lookup', version: 1, supported: true },
        { name: 'interface_bound_probes', version: 1, supported: true },
      ],
    });
    edit?.(report);
    for (const section of report.sections) section.contentDigest = topologySectionDigest(report, section, producer.sourceIdentity);
    report.contentDigest = topologyContextDigest(report, producer.sourceIdentity);
    return report;
  };

  const reconcile = () => scoped(() => withDbTransaction(() => reconcileTopologySite(scope)));
  const relationships = () => scoped(() => db.execute(sql`SELECT r.id,r.kind,r.source_node_id,r.target_node_id,r.source_interface_id,r.lifecycle,r.evidence_class,r.confidence,r.attributes->>'method' AS method
    FROM topology_relationships r WHERE r.org_id=${orgId}::uuid AND r.site_id=${siteId}::uuid AND r.deleted_at IS NULL ORDER BY r.kind,r.id`));

  const nodeForDevice = async () => {
    const [row] = await scoped(() => db.execute(sql`SELECT node_id FROM topology_node_bindings WHERE org_id=${orgId}::uuid AND device_id=${deviceId}::uuid`));
    return String(row!.node_id);
  };
  const nodesForPeers = async () => {
    const rows = await scoped(() => db.execute(sql`SELECT node_id FROM topology_node_bindings WHERE org_id=${orgId}::uuid AND discovered_asset_id = ANY(ARRAY[${sql.join(peerIds.map(id => sql`${id}::uuid`), sql`,`)}])`));
    return rows.map(row => String(row.node_id));
  };

  return {
    env, orgId, siteId, scope, deviceId, peerIds, context, producer, scoped, full, reconcile,
    relationships, nodeForDevice, nodesForPeers,
    ingest: (value: unknown) => scoped(() => ingestTopologyNetworkContext(producer, value)),
    interfaceRow: async () => {
      const [row] = await scoped(() => db.execute(sql`SELECT id,interface_key,name FROM topology_interfaces WHERE org_id=${orgId}::uuid AND site_id=${siteId}::uuid`));
      return row ?? null;
    },
    unmaterializedRuns: async () => {
      const [row] = await scoped(() => db.execute(sql`SELECT count(*)::int AS count FROM topology_collection_runs WHERE org_id=${orgId}::uuid AND materialized_at IS NULL`));
      return Number(row!.count);
    },
    commands: () => system(() => db.select().from(deviceCommands).where(eq(deviceCommands.deviceId, deviceId))),
    create: async (recipeId: 'gateway_basic' | 'dns_basic' | 'internet_basic', key = crypto.randomUUID()) => {
      const [binding] = await scoped(() => db.execute(sql`SELECT node_id FROM topology_node_bindings WHERE org_id=${orgId}::uuid AND device_id=${deviceId}::uuid`));
      const [state] = await scoped(() => db.execute(sql`SELECT graph_revision::text AS revision FROM topology_site_state WHERE org_id=${orgId}::uuid AND site_id=${siteId}::uuid`));
      return scoped(() => createTopologyDiagnosticRun(context, {
        recipeId, recipeVersion: 1,
        subject: { kind: 'node', id: String(binding!.node_id) },
        graphRevision: String(state!.revision),
      }, key));
    },
    graph: async (query = ''): Promise<GraphResponse> => {
      clearPermissionCache();
      const app = new Hono();
      app.use('*', authMiddleware);
      app.route('/topology', topologyGraphRoutes);
      const response = await app.request(`/topology/sites/${siteId}/graph${query}`, {
        headers: { Authorization: `Bearer ${env.token}` },
      });
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      return graphResponseSchema.parse(body);
    },
  };
}

type Fixture = Awaited<ReturnType<typeof baseline>>;

/** Ingest the single baseline report and materialize it through reconciliation. */
async function seeded(options: FixtureOptions = {}) {
  const f = await baseline(options);
  const accepted = await f.ingest(f.full('1', -1000));
  expect(accepted.accepted).toBe(true);
  const published = await f.reconcile();
  expect(published.published).toBe(true);
  return f;
}

/** A plausible agent frame: every step succeeds with exact attribution. */
function resultFor(
  run: { id: string; attemptId: string; commandId: string | null; plan: TopologyDiagnosticPlan },
  step: (step: TopologyDiagnosticPlan['steps'][number]) => Partial<TopologyDiagnosticStep> = () => ({}),
): TopologyDiagnosticResult {
  const now = new Date().toISOString();
  const destinationAddress = (destinationId: string | null) => {
    const destination = run.plan.destinations.find(entry => entry.id === destinationId);
    if (!destination) return null;
    return destination.target.kind === 'observed_gateway' ? destination.target.address
      : destination.target.kind === 'observed_resolver' ? destination.target.address
      : '192.0.2.80';
  };
  const steps: TopologyDiagnosticStep[] = run.plan.steps.map(entry => ({
    id: entry.id,
    state: 'succeeded',
    reason: null,
    attribution: {
      originDeviceId: run.plan.origin.deviceId,
      originAgentId: run.plan.origin.agentId,
      requestedMethod: entry.method,
      actualMethod: entry.method,
      destinationId: entry.destinationId,
      resolvedIp: destinationAddress(entry.destinationId),
      family: 'ipv4',
      port: entry.method === 'tcp' || entry.method === 'tls' || entry.method === 'http' ? 443
        : entry.method === 'dns' ? 53 : null,
      interfaceId: run.plan.origin.interfaceId,
      localAddress: '192.0.2.10',
      contextKey: run.plan.origin.contextKey,
      tableKey: null,
      nextHop: null,
      proxyUsed: null,
      quality: 'observed',
      routeChanged: false,
      evidenceRefs: [],
    },
    startedAt: now,
    finishedAt: now,
    receivedAt: now,
    truncated: false,
    details: { latencyMs: 4 },
    ...step(entry),
  }));
  return {
    version: 1, runId: run.id, attemptId: run.attemptId, commandId: run.commandId!,
    planDigest: run.plan.digest, steps, truncated: false,
  };
}

async function dispatched(f: Fixture, recipeId: 'gateway_basic' | 'dns_basic' | 'internet_basic') {
  const run = await f.create(recipeId);
  await dispatchTopologyDiagnosticRun(f.scope, run.id, { deliver: async () => true });
  const commands = (await f.commands()).filter(row => (row.payload as { runId?: string }).runId === run.id);
  const current = (await f.scoped(() => getTopologyDiagnosticRun(f.context, run.id)))!;
  return { run: current, commandId: commands[0]?.id ?? null, commands };
}

describe('baseline-no-management: materialized evidence', () => {
  it('attributes the default route to the reporting endpoint and interface, and leaves peers membership-only', async () => {
    const f = await seeded();
    const rows = await f.relationships();
    // Guard against a vacuous "zero physical links": the site really published.
    expect(rows.length).toBeGreaterThan(0);

    const origin = await f.nodeForDevice();
    const peers = await f.nodesForPeers();
    expect(peers).toHaveLength(2);

    const iface = await f.interfaceRow();
    expect(iface).toMatchObject({ interface_key: 'if-1', name: 'eth0' });

    const defaultRoutes = rows.filter(row => row.kind === 'default_route');
    expect(defaultRoutes).toHaveLength(1);
    expect(defaultRoutes[0]).toMatchObject({
      source_node_id: origin, source_interface_id: iface!.id,
      evidence_class: 'observed', confidence: 'high', method: 'os_network_context', lifecycle: 'active',
    });

    const osMembers = rows.filter(row => row.kind === 'network_member' && row.method === 'os_network_context');
    expect(osMembers).toHaveLength(1);
    expect(osMembers[0]).toMatchObject({ source_node_id: origin, evidence_class: 'inferred', confidence: 'low' });

    // The peers carry membership only: no route, egress, attachment or link.
    for (const peer of peers) {
      const touching = rows.filter(row => row.source_node_id === peer || row.target_node_id === peer);
      expect(touching.every(row => row.kind === 'network_member')).toBe(true);
    }
    expect(rows.some(row => ['default_route', 'egress_path', 'physical_link', 'attachment'].includes(String(row.kind))
      && peers.some(peer => [row.source_node_id, row.target_node_id].includes(peer)))).toBe(false);

    expect(rows.filter(row => row.kind === 'physical_link')).toHaveLength(0);
    expect(await f.unmaterializedRuns()).toBe(0);
    expect((await f.reconcile()).published).toBe(false);
  });

  it('carries no LLDP, SNMP, FDB or controller evidence at all', async () => {
    const f = await baseline();
    const report = f.full('1', -1000);
    expect(report.sections.map(section => section.kind).sort())
      .toEqual(['interfaces', 'neighbors', 'resolvers', 'routes', 'rules']);
    expect(report.sections.filter(section => ['neighbors', 'rules'].includes(section.kind))
      .every(section => section.rowCount === 0)).toBe(true);
    await f.ingest(report);
    await f.reconcile();
    const kinds = await f.scoped(() => db.execute(sql`SELECT DISTINCT protocol FROM topology_collection_sources WHERE org_id=${f.orgId}::uuid ORDER BY protocol`));
    expect(kinds.map(row => String(row.protocol)))
      .toEqual(['envelope', 'interfaces', 'neighbors', 'resolvers', 'routes', 'rules']);
  });
});

describe('baseline-no-management: graph response', () => {
  it('keeps schematic identity presentation-only and reports Internet reachability as unmeasured', async () => {
    const f = await seeded();
    const body = await f.graph();
    expect(body.nodes.length).toBeGreaterThan(0);

    for (const entity of [...body.presentation.nodes, ...body.presentation.edges]) {
      expect(entity.id).toMatch(/^presentation:/);
      expect(entity.authority).toBe(false);
      expect((entity as { presentationOnly?: boolean }).presentationOnly ?? true).toBe(true);
    }
    for (const id of [...body.nodes.map(node => node.id), ...body.relationships.map(edge => edge.id)]) {
      expect(id).not.toMatch(/^presentation:/);
    }

    // Nothing measured egress, so every node is unknown with a stated reason and
    // the graph's own coverage never claims completeness.
    expect(body.nodes.every(node => node.health.status === 'unknown'
      && node.health.reasons.length > 0
      && node.health.coverage !== 'monitored')).toBe(true);
    expect(body.coverage.state).not.toBe('complete');
    expect(body.coverage.reasons.length).toBeGreaterThan(0);
  });
});

describe('baseline-no-management: explicit gateway diagnostics', () => {
  it('plans route/neighbor/ICMP against the observed gateway and dispatches exactly one command', async () => {
    const f = await seeded();
    const { run, commands } = await dispatched(f, 'gateway_basic');

    expect(run.plan.reasons).toEqual([]);
    expect(run.plan.steps.map(step => step.method)).toEqual(['route_lookup', 'neighbor_lookup', 'icmp']);
    expect(run.plan.destinations).toHaveLength(1);
    const destination = run.plan.destinations[0]!.target;
    expect(destination).toMatchObject({ kind: 'observed_gateway', address: '192.0.2.1' });
    expect(run.plan.origin.deviceId).toBe(f.deviceId);
    expect(run.plan.origin.interfaceKey).toBe('if-1');
    expect((destination as { interfaceId: string }).interfaceId).toBe(run.plan.origin.interfaceId);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: 'network_diagnostic', status: 'pending' });
  });

  it('keeps a silent gateway at icmp_no_response instead of failing the node', async () => {
    const f = await seeded();
    const { run, commandId } = await dispatched(f, 'gateway_basic');

    await acceptTopologyDiagnosticResult(
      { deviceId: f.deviceId, agentId: f.deviceId, commandId: commandId! },
      resultFor(run, step => (step.method === 'icmp' ? { state: 'timeout', details: {} } : {})),
    );

    const settled = (await f.scoped(() => getTopologyDiagnosticRun(f.context, run.id)))!;
    expect(settled.state).toBe('completed');
    expect(settled.reasons).toContain('icmp_no_response');
    expect(settled.assessment).not.toBe('healthy');
    // An unanswered ICMP probe is an absence of an answer, never a verdict that
    // the gateway node itself failed.
    expect(settled.assessment).not.toBe('failed_check');
  });
});

describe('baseline-no-management: unconfigured destinations', () => {
  it.each(['dns_basic', 'internet_basic'] as const)(
    '%s is accepted as target_not_configured and dispatches nothing',
    async recipeId => {
      const f = await seeded();
      const run = await f.create(recipeId);
      expect(run.plan.reasons).toEqual(['target_not_configured']);
      expect(run.plan.steps).toEqual([]);
      expect(run.plan.destinations).toEqual([]);

      // The only layer the API controls is command emission: with no command row
      // there is nothing for any agent to execute, so no packet can leave.
      await drainTopologyDiagnosticDispatch({ deliver: async () => true });
      expect(await f.commands()).toHaveLength(0);

      // …and the run settles locally instead of waiting out its deadline.
      const settled = (await f.scoped(() => getTopologyDiagnosticRun(f.context, run.id)))!;
      expect(settled.state).toBe('completed');
      expect(settled.failureReason).toBe('target_not_configured');
      expect(settled.coverage).toBe('none');
      expect(settled.assessment).toBe('unknown');
    },
  );
});

describe('baseline-no-management: configured controlled destinations', () => {
  const targets = [
    { key: 'controlled_dns', definition: DNS_TARGET },
    { key: 'controlled_a', definition: httpsTarget('controlled a', 'a.example.invalid') },
    { key: 'controlled_b', definition: httpsTarget('controlled b', 'b.example.invalid') },
  ];

  it('binds a DNS step to the observed resolver and the configured name', async () => {
    const f = await seeded({ targets });
    const run = await f.create('dns_basic');
    expect(run.plan.reasons).toEqual([]);

    const resolver = run.plan.destinations.find(entry => entry.target.kind === 'observed_resolver');
    expect(resolver?.target).toMatchObject({ kind: 'observed_resolver', address: '192.0.2.53', port: 53 });
    const configured = run.plan.destinations.find(entry => entry.target.kind === 'configured_target');
    expect((configured?.target as { definition: { hostname: string } }).definition.hostname)
      .toBe('known-answer.example.invalid');

    const dns = run.plan.steps.find(step => step.method === 'dns')!;
    expect(dns.destinationId).toBe(configured!.id);
    expect((dns as { resolverDestinationIds: string[] }).resolverDestinationIds).toEqual([resolver!.id]);
  });

  it('compiles both HTTPS targets and round-trips exact per-step attribution', async () => {
    const f = await seeded({ targets });
    const { run, commandId } = await dispatched(f, 'internet_basic');

    const configured = run.plan.destinations.filter(entry => entry.target.kind === 'configured_target');
    expect(configured).toHaveLength(2);
    expect(run.plan.steps.filter(step => step.method === 'route_lookup')).toHaveLength(1);
    for (const method of ['tcp', 'tls', 'http'] as const) {
      expect(run.plan.steps.filter(step => step.method === method)).toHaveLength(2);
    }

    const frame = resultFor(run);
    await acceptTopologyDiagnosticResult({ deviceId: f.deviceId, agentId: f.deviceId, commandId: commandId! }, frame);
    const settled = (await f.scoped(() => getTopologyDiagnosticRun(f.context, run.id)))!;

    expect(settled.steps).toHaveLength(frame.steps.length);
    for (const sent of frame.steps) {
      const stored = settled.steps.find(step => step.id === sent.id)!;
      expect(stored.attribution).toEqual(sent.attribution);
    }
  });

  it('reports a single failing HTTPS chain as partial degradation, naming the failed method', async () => {
    const f = await seeded({ targets });
    const { run, commandId } = await dispatched(f, 'internet_basic');

    const failing = run.plan.destinations.filter(entry => entry.target.kind === 'configured_target')[0]!.id;
    await acceptTopologyDiagnosticResult(
      { deviceId: f.deviceId, agentId: f.deviceId, commandId: commandId! },
      resultFor(run, step =>
        step.method === 'tcp' && step.destinationId === failing
          ? { state: 'failed_check', reason: 'tcp_refused' }
          : {}),
    );

    const settled = (await f.scoped(() => getTopologyDiagnosticRun(f.context, run.id)))!;
    expect(settled.reasons).toContain('tcp_check_failed');
    expect(settled.reasons).toContain('tcp_succeeded');
    // One dead chain beside a working one is degradation, not a dead path.
    expect(settled.assessment).toBe('degraded');
    expect(settled.coverage).toBe('complete');
  });
});
