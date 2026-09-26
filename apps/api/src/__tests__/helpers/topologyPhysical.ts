/**
 * `physical-enrichment` acceptance fixture (M2 Task 10).
 *
 * Starts from M1's `baseline-no-management` shape — one enrolled agent whose
 * normalized network context publishes the logical graph, with saved pinned
 * overview positions — and then enriches the SAME site through the real
 * physical transports:
 *
 *   - SNMP adjacency through `POST /agents/:id/topology/adjacency` (the D14
 *     route, the D7 dispatch snapshot persisted by `prepareDiscoveryTopologyDispatch`,
 *     the registered discovery authority);
 *   - the UniFi controller through `POST /agents/:id/unifi-telemetry` with its
 *     `topologyV1` companion (the D16 adapter and controller-site authority);
 *   - publication through `reconcileTopologySite`, the ordered M1 publisher.
 *
 * Only the external transport is simulated (the switches' SNMP agents and the
 * controller API): every server seam — routes, authority, ingest, digests,
 * projector, publisher — is the production code. Nothing here imports vitest or
 * the integration setup, so the same fixture seeds the vertical integration
 * test and the worktree stack the Playwright spec runs against
 * (`topologyPhysicalSeed.cli.ts`).
 *
 * The deterministic variants below are the plan's named release fixture
 * (`TOPOLOGY_PHYSICAL_VARIANTS`); every variant is on by default.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import {
  canonicalizeUnifiResource, type AdjacencySection, type FdbRow, type LldpRow, type NetworkContextFull, type PhysicalInterfaceRow,
  type UnifiResource, type UnifiTopologyV1,
} from '@breeze/shared';
import { db, runOutsideDbContext, withDbAccessContext, withDbTransaction, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { discoveryProfiles, topologyLayouts } from '../../db/schema';
import { topologyAdjacencyRoutes } from '../../routes/agents/topologyAdjacency';
import { unifiTelemetryRoutes } from '../../routes/agents/unifiTelemetry';
import type { TopologyRequestContext } from '../../services/topology/access';
import { negotiateTopologyContext } from '../../services/topology/collectionAuthority';
import { topologyContextDigest, topologySectionDigest } from '../../services/topology/collectionDigest';
import { ingestTopologyNetworkContext } from '../../services/topology/collectionIngest';
import type { AuthenticatedTopologyProducer } from '../../services/topology/collectionTypes';
import { adjacencyDigestFormSection, adjacencyReportDigest, adjacencyScopeDigest } from '../../services/topology/discoveryAdjacency';
import { prepareDiscoveryTopologyDispatch } from '../../services/topology/discoveryDispatch';
import { saveTopologyLayout } from '../../services/topology/layouts';
import { drainTopologyOutbox, importLegacyTopologySite } from '../../services/topology/legacyImport';
import { registerTopologyPhysicalAuthorities } from '../../services/topology/physicalAuthorities';
import { reconcileTopologySite } from '../../services/topology/reconcile';
import { currentUnifiCollectorTopology, loadUnifiCollector, revokeUnifiMappingDrift, snapshotUnifiMappings } from '../../services/topology/unifiAuthority';
import { networkContextFixture } from '../../../../../packages/shared/src/testing/topologyFixtures';

export const TOPOLOGY_PHYSICAL_VARIANTS = [
  'fdb-only', 'qbridge-shared-fdb', 'reciprocal-parallel', 'partial-controller-page', 'source-remap', 'manual-pinned-import', 'legacy-agent-positive-only',
] as const;
export type TopologyPhysicalVariant = (typeof TOPOLOGY_PHYSICAL_VARIANTS)[number];

/** Documentation ranges only (RFC 5737). The agent's logical baseline uses 192.0.2.0/24. */
export const PHYSICAL_FIXTURE = {
  switchIp: { A: '198.51.100.1', B: '198.51.100.2' },
  switchName: { A: 'core-switch-a', B: 'access-switch-b' },
  agentHostname: 'physical-agent-01', deskHostname: 'desk-12',
  agentMac: '02:00:00:00:aa:01', deskMac: '02:00:00:00:aa:02',
  /** FDB-only: the agent's NIC is learned on A's port 24 and nowhere else. */
  fdbOnlyPort: 24,
  /** Ambiguous: the desk NIC is learned on A:3 and B:3 (neither is infrastructure). */
  competingPort: 3,
  /** Q-BRIDGE shared/upstream port: more than 16 unicast MACs (D13). */
  sharedPort: 48, sharedMacCount: 20, fdbId: 700, vlan: 10,
  /** Reciprocal LLDP on two parallel cables: A:1<->B:1 and A:2<->B:2. */
  parallelPorts: [1, 2] as const,
  unifi: { host: 'host:1', site: 'default', printerMac: '02:00:00:00:cc:01', laptopMac: '02:00:00:00:cc:02', printerPort: 4, apUplinkPort: 7 },
  manual: { a: 'Patch panel 1', b: 'Wall jack 12', pin: { x: 40, y: 60 } },
  pins: { agent: { x: 320, y: 180 }, gateway: { x: 560, y: 180 } },
} as const;

type Sw = 'A' | 'B';
const SWITCHES: Sw[] = ['A', 'B'];
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const portMac = (sw: Sw, port: number) => `02:00:00:0${sw === 'A' ? 1 : 2}:00:${port.toString(16).padStart(2, '0')}`;
const sharedMac = (index: number) => `02:00:00:00:5${Math.floor(index / 256)}:${(index % 256).toString(16).padStart(2, '0')}`;
const minutes = (n: number) => n * 60_000;

export const physicalIface = (sw: Sw, port: number): PhysicalInterfaceRow => ({
  rowKey: String(port), interfaceKey: `name:Gi0/${port}`, ifIndex: port, ifName: `Gi0/${port}`, ifAlias: port === PHYSICAL_FIXTURE.fdbOnlyPort ? 'Desk drop' : null,
  physAddress: portMac(sw, port), lldpLocalPort: port, bridgePort: port,
});
export const physicalLldp = (localPort: number, peer: Sw, peerPort: number): LldpRow => ({
  rowKey: `${localPort}.1`, timeMark: 100, remoteIndex: 1,
  localPort: { namespace: 'lldp_local', value: String(localPort), resolvedInterfaceKey: `name:Gi0/${localPort}` },
  remoteChassis: { subtype: 'mac_address', value: portMac(peer, peerPort) }, remotePort: { subtype: 'interface_name', value: `Gi0/${peerPort}` },
});
export const physicalFdb = (port: number, mac: string): FdbRow => ({
  rowKey: `default|${PHYSICAL_FIXTURE.fdbId}|${mac}|${port}`, bridgeContext: 'default', fdbId: PHYSICAL_FIXTURE.fdbId, mac, bridgePort: port, ifIndex: port,
  status: 'learned', vlans: [PHYSICAL_FIXTURE.vlan], vlanMapping: 'complete',
});
const section = (kind: AdjacencySection['kind'], rows: unknown[], extra: Record<string, unknown> = {}) =>
  ({ kind, contextKey: 'default', contentDigest: '0'.repeat(64), outcome: 'complete', rowCount: rows.length, rows, ...extra }) as unknown as AdjacencySection;

export type PhysicalSwitchReport = { lldp?: LldpRow[]; fdb?: FdbRow[]; interfaces?: PhysicalInterfaceRow[]; lldpOutcome?: 'complete' | 'partial' };

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

export type TopologyPhysicalTenant = { partnerId: string; orgId: string; siteId: string };
export type SeedTopologyPhysicalOptions = {
  /** Write-capable request context for the same site (pins + v2 manual assertions go through the real services). */
  writer: TopologyRequestContext;
  variants?: readonly TopologyPhysicalVariant[];
  /**
   * Fixture clock origin. Reports are stamped relative to it and the discovery
   * dispatch is persisted `dispatchLeadMinutes` before it, so a scenario can
   * place two complete reads minutes apart without sleeping.
   */
  now?: Date;
  dispatchLeadMinutes?: number;
  /** UniFi host id; unique per partner integration, so a stack seeded repeatedly passes its own. */
  unifiHost?: string;
};

/** Seed the no-management baseline, then attach the physical transports. Does not post any physical report yet. */
export async function seedTopologyPhysicalFixture(tenant: TopologyPhysicalTenant, options: SeedTopologyPhysicalOptions) {
  registerTopologyPhysicalAuthorities();
  const variants = new Set<TopologyPhysicalVariant>(options.variants ?? TOPOLOGY_PHYSICAL_VARIANTS);
  const has = (variant: TopologyPhysicalVariant) => variants.has(variant);
  const t0 = options.now ?? new Date();
  const at = (offsetMinutes: number) => new Date(t0.getTime() + minutes(offsetMinutes)).toISOString();
  const scope = { orgId: tenant.orgId, siteId: tenant.siteId };
  const unifiHost = options.unifiHost ?? PHYSICAL_FIXTURE.unifi.host;
  const scoped = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(scope.orgId), fn);
  const system = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn, 'topology physical fixture'));
  const q = <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) => scoped(async () => (await db.execute(query)) as unknown as T[]);

  const ids = {
    agentDevice: randomUUID(), deskDevice: randomUUID(), assets: { A: randomUUID(), B: randomUUID() } as Record<Sw, string>,
    manualA: randomUUID(), manualB: randomUUID(), manualEdge: randomUUID(), legacyEdge: randomUUID(),
    profile: randomUUID(), job: randomUUID(), integration: randomUUID() as string, collector: randomUUID(), mapping: randomUUID(),
  };

  await system(() => db.execute(sql`UPDATE organizations SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{topologyFeatureFlags}',
    coalesce(settings->'topologyFeatureFlags', '{}'::jsonb) || '{"materialization":true,"ui":true,"physical":true}'::jsonb) WHERE id = ${scope.orgId}::uuid`));

  // Inventory the M0 legacy import will project (capture triggers enqueue every insert).
  await scoped(async () => {
    for (const [id, host] of [[ids.agentDevice, PHYSICAL_FIXTURE.agentHostname], [ids.deskDevice, PHYSICAL_FIXTURE.deskHostname]] as const) {
      await db.execute(sql`INSERT INTO devices (id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version,status,last_seen_at,agent_token_hash)
        VALUES (${id}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,${id},${host},'linux','1','amd64','1','online',now(),${'a'.repeat(64)})`);
    }
    await db.execute(sql`INSERT INTO device_network (device_id,org_id,interface_name,mac_address) VALUES
      (${ids.agentDevice}::uuid,${scope.orgId}::uuid,'eth0',${PHYSICAL_FIXTURE.agentMac}),
      (${ids.deskDevice}::uuid,${scope.orgId}::uuid,'eth0',${PHYSICAL_FIXTURE.deskMac})`);
    for (const sw of SWITCHES) {
      await db.execute(sql`INSERT INTO discovered_assets (id,org_id,site_id,ip_address,hostname,asset_type)
        VALUES (${ids.assets[sw]}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,${PHYSICAL_FIXTURE.switchIp[sw]},${PHYSICAL_FIXTURE.switchName[sw]},'switch')`);
    }
    if (has('manual-pinned-import')) {
      await db.execute(sql`INSERT INTO topology_manual_nodes (id,org_id,site_id,label,role) VALUES
        (${ids.manualA}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,${PHYSICAL_FIXTURE.manual.a},'patch_panel'),
        (${ids.manualB}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,${PHYSICAL_FIXTURE.manual.b},'other')`);
      await db.execute(sql`INSERT INTO network_topology (id,org_id,site_id,source_type,source_id,target_type,target_id,connection_type,method,confidence)
        VALUES (${ids.manualEdge}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,'manual_node',${ids.manualA}::uuid,'manual_node',${ids.manualB}::uuid,'wired','manual','asserted')`);
      await db.execute(sql`INSERT INTO topology_layout (org_id,site_id,node_type,node_id,x,y,pinned)
        VALUES (${scope.orgId}::uuid,${scope.siteId}::uuid,'manual_node',${ids.manualA}::uuid,${PHYSICAL_FIXTURE.manual.pin.x},${PHYSICAL_FIXTURE.manual.pin.y},true)`);
    }
    if (has('legacy-agent-positive-only')) {
      // What a pre-M2 agent's discovery produced: a positive-only legacy adjacency row with no ports.
      await db.execute(sql`INSERT INTO network_topology (id,org_id,site_id,source_type,source_id,target_type,target_id,connection_type,method,confidence)
        VALUES (${ids.legacyEdge}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,'discovered_asset',${ids.assets.A}::uuid,'discovered_asset',${ids.assets.B}::uuid,'ethernet','lldp','high')`);
    }
  });

  let imported = await scoped(() => importLegacyTopologySite(scope));
  for (let attempt = 0; !imported.complete && attempt < 30; attempt++) imported = await scoped(() => drainTopologyOutbox(scope));
  if (!imported.complete) throw new Error('physical fixture: legacy import did not complete');

  // M1 no-management baseline: the enrolled agent's own network context.
  const config = await scoped(() => withDbTransaction(() => negotiateTopologyContext(ids.agentDevice)));
  if (!('producerEpoch' in config) || !config.producerEpoch) throw new Error('physical fixture: topology capability disabled');
  const agent: AuthenticatedTopologyProducer = {
    scope, producerId: ids.agentDevice, producerKind: 'agent', producerEpoch: config.producerEpoch,
    configurationRevision: config.configurationRevision!, sourceIdentity: config.sourceIdentity!,
  };
  const context = (sequence: string, capturedAt: string): NetworkContextFull => {
    const report = networkContextFixture();
    Object.assign(report, { producerEpoch: agent.producerEpoch, sequence, snapshotId: randomUUID(), capturedAt });
    for (const s of report.sections) s.contentDigest = topologySectionDigest(report, s, agent.sourceIdentity);
    report.contentDigest = topologyContextDigest(report, agent.sourceIdentity);
    return report;
  };
  const baseline = await scoped(() => ingestTopologyNetworkContext(agent, context('1', at(-30))));
  if (!baseline.accepted) throw new Error(`physical fixture: baseline rejected ${JSON.stringify(baseline)}`);

  const reconcile = async () => {
    let published = false;
    for (let i = 0; i < 6; i++) {
      const result = await scoped(() => withDbTransaction(() => reconcileTopologySite(scope)));
      if (!result.published) break;
      published = true;
    }
    return { published };
  };
  /** A reconcile worker that dies after publishing but before COMMIT: everything it did rolls back. */
  const crashBeforeCommit = async () => {
    const crash = new Error('simulated reconcile worker crash before commit');
    const outcome = await scoped(async () => {
      await withDbTransaction(() => reconcileTopologySite(scope));
      throw crash;
    }).then(() => 'committed', (error: unknown) => (error === crash ? 'rolled_back' : Promise.reject(error)));
    return outcome;
  };
  await reconcile();

  const nodeWhere = async (where: ReturnType<typeof sql>) => {
    const [row] = await q<{ id: string }>(sql`SELECT n.id FROM topology_nodes n WHERE n.org_id=${scope.orgId}::uuid AND n.site_id=${scope.siteId}::uuid
      AND n.deleted_at IS NULL AND n.alias_target_id IS NULL AND ${where} ORDER BY n.id LIMIT 1`);
    return row?.id ?? null;
  };
  const boundNode = (column: 'device_id' | 'discovered_asset_id' | 'manual_node_id', id: string) =>
    nodeWhere(sql`EXISTS (SELECT 1 FROM topology_node_bindings b WHERE b.node_id=n.id AND b.${sql.raw(column)}=${id}::uuid)`);
  const nodes = {
    agent: (await boundNode('device_id', ids.agentDevice))!, desk: (await boundNode('device_id', ids.deskDevice))!,
    A: (await boundNode('discovered_asset_id', ids.assets.A))!, B: (await boundNode('discovered_asset_id', ids.assets.B))!,
    gateway: (await nodeWhere(sql`n.kind='gateway'`))!,
    manualA: has('manual-pinned-import') ? await boundNode('manual_node_id', ids.manualA) : null,
    manualB: has('manual-pinned-import') ? await boundNode('manual_node_id', ids.manualB) : null,
  };
  for (const [name, id] of Object.entries(nodes)) if (id === null && !name.startsWith('manual')) throw new Error(`physical fixture: missing ${name} node`);

  // Saved, pinned overview positions (the real layout service; dual-writes the legacy canvas).
  const [layout] = await scoped(() => db.select({ revision: topologyLayouts.revision }).from(topologyLayouts)
    .where(and(eq(topologyLayouts.orgId, scope.orgId), eq(topologyLayouts.siteId, scope.siteId), eq(topologyLayouts.view, 'overview'))));
  await scoped(() => saveTopologyLayout(options.writer, 'overview', { expectedRevision: (layout?.revision ?? 0n).toString(), positions: [
    { nodeId: nodes.agent, ...PHYSICAL_FIXTURE.pins.agent, pinned: true }, { nodeId: nodes.gateway, ...PHYSICAL_FIXTURE.pins.gateway, pinned: true },
  ] }));

  // D7 discovery dispatch for both switches, persisted before any report.
  const dispatchedAt = new Date(t0.getTime() - minutes(options.dispatchLeadMinutes ?? 10));
  await scoped(async () => {
    await db.execute(sql`INSERT INTO discovery_profiles (id, org_id, site_id, name, subnets, exclude_ips, methods)
      VALUES (${ids.profile}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, 'physical-enrichment', ARRAY['198.51.100.0/24'], ARRAY[]::text[], ARRAY['ping','snmp']::discovery_method[])`);
  });
  const dispatch = async (jobId: string, now: Date) => {
    await scoped(() => db.execute(sql`INSERT INTO discovery_jobs (id, profile_id, org_id, site_id, status) VALUES (${jobId}::uuid, ${ids.profile}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, 'scheduled')`));
    const [profile] = await scoped(() => db.select().from(discoveryProfiles).where(eq(discoveryProfiles.id, ids.profile)));
    const block = await system(() => prepareDiscoveryTopologyDispatch({ jobId, orgId: scope.orgId, siteId: scope.siteId, profile: profile!, agentId: ids.agentDevice, now }));
    if (!block) throw new Error('physical fixture: discovery dispatch not prepared');
    await scoped(() => db.execute(sql`UPDATE discovery_jobs SET status='running', agent_id=${ids.agentDevice} WHERE id=${jobId}::uuid`));
    return block;
  };
  let job = { id: ids.job, block: await dispatch(ids.job, dispatchedAt) };

  // UniFi controller site mapped to this site; the enrolled agent is the collector.
  await system(async () => {
    // One active integration per partner: reuse the partner's own when a previous seed created it.
    const [existing] = await db.execute<{ id: string }>(sql`SELECT id FROM unifi_integrations WHERE partner_id=${tenant.partnerId}::uuid AND is_active LIMIT 1`);
    if (existing) ids.integration = existing.id;
    else await db.execute(sql`INSERT INTO unifi_integrations (id, partner_id, api_key_encrypted) VALUES (${ids.integration}::uuid, ${tenant.partnerId}::uuid, 'fixture-key')`);
    await db.execute(sql`INSERT INTO unifi_collectors (id, integration_id, org_id, site_id, unifi_host_id, collector_device_id, controller_url, local_api_key_encrypted)
      VALUES (${ids.collector}::uuid, ${ids.integration}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, ${unifiHost}, ${ids.agentDevice}::uuid, 'https://controller.example.invalid', 'fixture-key')`);
    await db.execute(sql`INSERT INTO unifi_site_mappings (id, integration_id, org_id, site_id, unifi_host_id, unifi_site_id)
      VALUES (${ids.mapping}::uuid, ${ids.integration}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, ${unifiHost}, ${PHYSICAL_FIXTURE.unifi.site})`);
  });

  // The agent transport: token-resolved agent context in front of the real routes.
  const agentApp = new Hono();
  agentApp.use('*', async (c, next) => {
    c.set('agent' as never, { role: 'agent', partnerId: tenant.partnerId, deviceId: ids.agentDevice, orgId: scope.orgId, siteId: scope.siteId } as never);
    await next();
  });
  agentApp.route('/agents', topologyAdjacencyRoutes);
  agentApp.route('/agents', unifiTelemetryRoutes);

  const sequence: Record<Sw, number> = { A: 0, B: 0 };
  const lastFull: Partial<Record<Sw, { baseSnapshotId: string; contentDigest: string }>> = {};
  const switchIdentity = (sw: Sw) => ({ sourceIdentity: job.block.sourceIdentity, producerEpoch: job.block.producerEpoch,
    source: { sourceKey: `snmp:${PHYSICAL_FIXTURE.switchIp[sw]}`, address: PHYSICAL_FIXTURE.switchIp[sw], zone: null } });
  const postAdjacency = async (report: Record<string, unknown>) => {
    const response = await agentApp.request(`/agents/${ids.agentDevice}/topology/adjacency`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parentJobId: job.id, report }) });
    return { status: response.status, body: await response.json() as { accepted?: boolean; reason?: string; error?: string; baseSnapshotId?: string; contentDigest?: string; receipts?: unknown[] } };
  };

  /** One full per-target adjacency report (all four requested scopes), as the agent builds it. */
  const adjacency = async (sw: Sw, content: PhysicalSwitchReport, capturedAt: string) => {
    const identity = switchIdentity(sw);
    const sections = [
      section('lldp', content.lldp ?? [], content.lldpOutcome === 'partial' ? { outcome: 'partial', reasonCode: 'timeout' } : {}),
      section('cdp', []), section('fdb', content.fdb ?? []), section('interfaces', content.interfaces ?? []),
    ];
    const forms = sections.map(adjacencyDigestFormSection);
    for (const [i, s] of sections.entries()) s.contentDigest = adjacencyScopeDigest(identity, forms[i]!);
    const contentDigest = adjacencyReportDigest(identity, forms);
    const report = {
      version: 2, parentJobId: job.id, parentCommandId: job.id, producerEpoch: job.block.producerEpoch, snapshotId: randomUUID(), sequence: String(++sequence[sw]),
      capturedAt, captureAgeAtSendMs: 5, expectedIntervalSeconds: job.block.expectedIntervalSeconds, contentDigest, source: identity.source, reportKind: 'full', sections,
      finalManifest: { scopes: sections.map(s => ({ kind: s.kind, contextKey: s.contextKey, outcome: s.outcome, rowCount: s.rowCount, contentDigest: s.contentDigest })) },
    };
    const result = await postAdjacency(report);
    if (result.status === 200 && result.body.accepted && result.body.baseSnapshotId) lastFull[sw] = { baseSnapshotId: result.body.baseSnapshotId, contentDigest };
    return result;
  };
  /** D2/D14 `unchanged`: the same per-target content confirmed later without a body. */
  const unchanged = async (sw: Sw, capturedAt: string) => {
    const base = lastFull[sw];
    if (!base) throw new Error(`physical fixture: no accepted full report for ${sw}`);
    const identity = switchIdentity(sw);
    return postAdjacency({
      version: 2, parentJobId: job.id, parentCommandId: job.id, producerEpoch: job.block.producerEpoch, snapshotId: randomUUID(), sequence: String(++sequence[sw]),
      capturedAt, captureAgeAtSendMs: 5, expectedIntervalSeconds: job.block.expectedIntervalSeconds, contentDigest: base.contentDigest, source: identity.source,
      reportKind: 'unchanged', baseSnapshotId: base.baseSnapshotId,
    });
  };

  /** The standard per-switch content of the `physical-enrichment` fixture. */
  const switchContent = (sw: Sw): PhysicalSwitchReport => {
    const peer: Sw = sw === 'A' ? 'B' : 'A';
    const ports = new Set<number>([...PHYSICAL_FIXTURE.parallelPorts, PHYSICAL_FIXTURE.competingPort]);
    if (sw === 'A') { ports.add(PHYSICAL_FIXTURE.fdbOnlyPort); ports.add(PHYSICAL_FIXTURE.sharedPort); }
    const fdb: FdbRow[] = [];
    if (has('fdb-only') && sw === 'A') fdb.push(physicalFdb(PHYSICAL_FIXTURE.fdbOnlyPort, PHYSICAL_FIXTURE.agentMac));
    if (has('qbridge-shared-fdb')) {
      fdb.push(physicalFdb(PHYSICAL_FIXTURE.competingPort, PHYSICAL_FIXTURE.deskMac));
      if (sw === 'A') {
        // The desk MAC is also behind the shared uplink: the shared port must never make it a third competitor.
        fdb.push(physicalFdb(PHYSICAL_FIXTURE.sharedPort, PHYSICAL_FIXTURE.deskMac));
        for (let i = 0; i < PHYSICAL_FIXTURE.sharedMacCount; i++) fdb.push(physicalFdb(PHYSICAL_FIXTURE.sharedPort, sharedMac(i)));
      }
    }
    return {
      interfaces: [...ports].sort((a, b) => a - b).map(port => physicalIface(sw, port)),
      lldp: has('reciprocal-parallel') ? PHYSICAL_FIXTURE.parallelPorts.map(port => physicalLldp(port, peer, port)) : [],
      fdb: fdb.sort((a, b) => a.rowKey.localeCompare(b.rowKey)),
    };
  };

  // ---- UniFi controller transport ----
  const unifiRows = {
    device_list: [
      { rowKey: 'dev-gw', deviceId: 'dev-gw', mac: '02:00:00:00:0b:01', name: 'Gateway', model: 'UXG', ipAddress: null, state: 'ONLINE' },
      { rowKey: 'dev-sw', deviceId: 'dev-sw', mac: '02:00:00:00:0b:02', name: 'USW Lite 8', model: 'USL8LP', ipAddress: null, state: 'ONLINE' },
      { rowKey: 'dev-ap', deviceId: 'dev-ap', mac: '02:00:00:00:0b:03', name: 'U6 Lite', model: 'UAL6', ipAddress: null, state: 'ONLINE' },
    ],
    client_list: [
      { rowKey: 'client-printer', clientId: 'client-printer', mac: PHYSICAL_FIXTURE.unifi.printerMac, clientType: 'WIRED', uplinkDeviceId: 'dev-sw', name: 'printer',
        ipAddress: null, uplinkPortIndex: PHYSICAL_FIXTURE.unifi.printerPort, ssid: null, vlan: null, signalDbm: null },
      { rowKey: 'client-laptop', clientId: 'client-laptop', mac: PHYSICAL_FIXTURE.unifi.laptopMac, clientType: 'WIRELESS', uplinkDeviceId: 'dev-ap', name: 'laptop',
        ipAddress: null, uplinkPortIndex: null, ssid: 'office', vlan: null, signalDbm: -55 },
      { rowKey: 'client-vpn', clientId: 'client-vpn', mac: null, clientType: 'VPN', uplinkDeviceId: 'dev-gw', name: 'remote-user',
        ipAddress: null, uplinkPortIndex: null, ssid: null, vlan: null, signalDbm: null },
    ],
    device_details: [
      { rowKey: 'dev-ap', deviceId: 'dev-ap', uplinkDeviceId: 'dev-sw', uplinkPortIndex: PHYSICAL_FIXTURE.unifi.apUplinkPort, ports: [] },
    ],
  };
  let unifiSequence = 0;
  type UnifiEdit = { clientOutcome?: 'complete' | 'partial'; clients?: typeof unifiRows.client_list };
  const unifiReport = async (capturedAt: string, edit: UnifiEdit = {}): Promise<UnifiTopologyV1> => {
    const collector = (await system(() => loadUnifiCollector(ids.collector)))!;
    const current = await system(() => currentUnifiCollectorTopology(ids.agentDevice, collector));
    if (!current) throw new Error('physical fixture: UniFi collector has no current topology authority');
    const clients = edit.clients ?? unifiRows.client_list;
    const resources = [
      { kind: 'device_list', outcome: 'complete', rows: unifiRows.device_list },
      { kind: 'client_list', outcome: edit.clientOutcome ?? 'complete', rows: clients, ...(edit.clientOutcome === 'partial' ? { reasonCode: 'page_timeout' } : {}) },
      { kind: 'device_details', outcome: 'complete', rows: unifiRows.device_details },
      { kind: 'statistics', outcome: 'unsupported', rows: [] },
    ].map(r => ({ controllerSiteId: PHYSICAL_FIXTURE.unifi.site, contentDigest: '0'.repeat(64), rowCount: r.rows.length, ...r }) as unknown as UnifiResource);
    for (const r of resources) r.contentDigest = sha256(canonicalizeUnifiResource(current, r));
    return { version: 1, producerEpoch: current.producerEpoch, snapshotId: randomUUID(), sequence: String(++unifiSequence), capturedAt, captureAgeAtSendMs: 0,
      expectedIntervalSeconds: 300, resources } as UnifiTopologyV1;
  };
  const unifi = async (capturedAt: string, edit: UnifiEdit = {}) => {
    const topologyV1 = await unifiReport(capturedAt, edit);
    const response = await agentApp.request(`/agents/${ids.agentDevice}/unifi-telemetry`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ collectorId: ids.collector, polledAt: capturedAt, firmwareOk: true, devices: [], clients: [], topologyV1 }) });
    const body = await response.json() as { accepted?: boolean; topology?: { accepted: boolean; reason?: string; resources?: unknown[] } };
    return { status: response.status, body };
  };
  /** Controller-site remap (D1 revocation trigger), then optionally back. */
  const remapUnifi = async (siteId: string) => system(async () => {
    const before = await snapshotUnifiMappings(ids.integration);
    await db.execute(sql`UPDATE unifi_site_mappings SET site_id=${siteId}::uuid WHERE id=${ids.mapping}::uuid`);
    return revokeUnifiMappingDrift(ids.integration, before);
  });

  /** The whole standard fixture posted and published once. */
  const publishPhysical = async (capturedAt: string) => {
    const receipts = { A: await adjacency('A', switchContent('A'), capturedAt), B: await adjacency('B', switchContent('B'), capturedAt), unifi: await unifi(capturedAt) };
    for (const [name, r] of Object.entries(receipts)) {
      const accepted = name === 'unifi' ? (r.body as { topology?: { accepted: boolean } }).topology?.accepted : (r.body as { accepted?: boolean }).accepted;
      if (r.status >= 300 || !accepted) throw new Error(`physical fixture: ${name} report not accepted ${JSON.stringify(r)}`);
    }
    await reconcile();
    return receipts;
  };
  const redispatch = async (now: Date) => {
    const id = randomUUID();
    job = { id, block: await dispatch(id, now) };
    return job;
  };

  return {
    scope, tenant, ids, nodes, variants: [...variants], agent, t0, at, scoped, system, q,
    reconcile, crashBeforeCommit, adjacency, unchanged, switchContent, unifi, unifiRows, remapUnifi, publishPhysical, redispatch,
    job: () => job,
    /** Next agent network-context report with identical content (M1 unchanged path through a full body). */
    agentContext: (sequenceValue: string, capturedAt: string) => scoped(() => ingestTopologyNetworkContext(agent, context(sequenceValue, capturedAt))),
  };
}
export type TopologyPhysicalFixture = Awaited<ReturnType<typeof seedTopologyPhysicalFixture>>;
