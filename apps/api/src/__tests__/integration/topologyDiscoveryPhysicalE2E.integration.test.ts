import './setup';
import { Hono } from 'hono';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { AdjacencySection, LldpRow, PhysicalInterfaceRow } from '@breeze/shared';
import { closeDb, db, withDbAccessContext, withDbTransaction, withSystemDbAccessContext } from '../../db';
import { discoveryProfiles } from '../../db/schema';
import { createTopologyTenant, orgContext } from './topology-fixtures';
import { getTestDb } from './setup';
import { topologyAdjacencyRoutes } from '../../routes/agents/topologyAdjacency';
import { negotiateTopologyContext, resetTopologyProducerAuthoritiesForTest } from '../../services/topology/collectionAuthority';
import { prepareDiscoveryTopologyDispatch } from '../../services/topology/discoveryDispatch';
import { adjacencyDigestFormSection, adjacencyReportDigest, adjacencyScopeDigest } from '../../services/topology/discoveryAdjacency';
import { drainTopologyOutbox, importLegacyTopologySite } from '../../services/topology/legacyImport';
import { reconcileTopologySite } from '../../services/topology/reconcile';
import { registerTopologyPhysicalAuthorities } from '../../services/topology/physicalAuthorities';

afterAll(() => closeDb());
afterEach(() => resetTopologyProducerAuthoritiesForTest());

/**
 * M2 Task 6b vertical: the REAL discovery authority and transport (no stub
 * authority) feed the physical projector. Asserts the authority shape is one
 * contract end to end: 4b names the target `snmp:<ip>` and namespaces every
 * source context under it; Task 6 resolves that key to the scoped discovered
 * asset's node. Two switches that see each other over LLDP publish ONE
 * measured physical_link between their inventory nodes.
 */
const IP = { A: '192.0.2.1', B: '192.0.2.2' } as const;
type Sw = keyof typeof IP;
const portMac = (sw: Sw, port: number) => `02:00:00:0${sw === 'A' ? 1 : 2}:00:0${port}`;
const iface = (sw: Sw, port: number): PhysicalInterfaceRow => ({
  rowKey: String(port), interfaceKey: `name:Gi0/${port}`, ifIndex: port, ifName: `Gi0/${port}`, ifAlias: null, physAddress: portMac(sw, port), lldpLocalPort: port, bridgePort: port,
});
const lldp = (port: number, peer: Sw, peerPort: number): LldpRow => ({
  rowKey: `${port}.1`, timeMark: 100, remoteIndex: 1, localPort: { namespace: 'lldp_local', value: String(port), resolvedInterfaceKey: `name:Gi0/${port}` },
  remoteChassis: { subtype: 'mac_address', value: portMac(peer, peerPort) }, remotePort: { subtype: 'interface_name', value: `Gi0/${peerPort}` },
});
const section = (kind: AdjacencySection['kind'], rows: unknown[]) => ({ kind, contextKey: 'default', contentDigest: '0'.repeat(64), outcome: 'complete', rowCount: rows.length, rows }) as unknown as AdjacencySection;

async function fixture() {
  registerTopologyPhysicalAuthorities();
  const tenant = await createTopologyTenant();
  const scope = { orgId: tenant.orgId, siteId: tenant.siteId };
  const scoped = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(scope.orgId), fn);
  const test = getTestDb();
  const collector = crypto.randomUUID(), profileId = crypto.randomUUID(), jobId = crypto.randomUUID();
  const assets = { A: crypto.randomUUID(), B: crypto.randomUUID() };
  await test.execute(sql`UPDATE organizations SET settings=${JSON.stringify({ topologyFeatureFlags: { materialization: true, physical: true } })}::jsonb WHERE id=${scope.orgId}::uuid`);
  await test.execute(sql`INSERT INTO devices (id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version,agent_token_hash)
    VALUES (${collector}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,${collector},'collector','linux','1','amd64','1',${'a'.repeat(64)})`);
  for (const sw of ['A', 'B'] as const) {
    await test.execute(sql`INSERT INTO discovered_assets (id,org_id,site_id,ip_address,hostname) VALUES (${assets[sw]}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,${IP[sw]},${`switch-${sw}`})`);
  }
  let imported = await scoped(() => importLegacyTopologySite(scope));
  for (let attempt = 0; !imported.complete && attempt < 30; attempt++) imported = await scoped(() => drainTopologyOutbox(scope));
  expect(imported.complete).toBe(true);
  const config = await scoped(() => withDbTransaction(() => negotiateTopologyContext(collector)));
  if (!('producerEpoch' in config)) throw new Error('fixture capability disabled');

  await scoped(async () => {
    await db.execute(sql`INSERT INTO discovery_profiles (id, org_id, site_id, name, subnets, exclude_ips, methods)
      VALUES (${profileId}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, 'e2e', ARRAY['192.0.2.0/24'], ARRAY[]::text[], ARRAY['ping','snmp']::discovery_method[])`);
    await db.execute(sql`INSERT INTO discovery_jobs (id, profile_id, org_id, site_id, status) VALUES (${jobId}::uuid, ${profileId}::uuid, ${scope.orgId}::uuid, ${scope.siteId}::uuid, 'scheduled')`);
  });
  const [profile] = await scoped(() => db.select().from(discoveryProfiles).where(eq(discoveryProfiles.id, profileId)));
  const block = await withSystemDbAccessContext(() => prepareDiscoveryTopologyDispatch({ jobId, orgId: scope.orgId, siteId: scope.siteId, profile: profile!, agentId: collector }));
  if (!block) throw new Error('fixture dispatch not prepared');
  await scoped(() => db.execute(sql`UPDATE discovery_jobs SET status='running', agent_id=${collector} WHERE id=${jobId}::uuid`));

  const app = new Hono();
  app.use('*', async (c, next) => { c.set('agent' as never, { role: 'agent', partnerId: null, deviceId: collector, orgId: scope.orgId, siteId: scope.siteId } as never); await next(); });
  app.route('/agents', topologyAdjacencyRoutes);
  let sequence = 1;
  const post = async (sw: Sw, sections: AdjacencySection[]) => {
    const source = { sourceKey: `snmp:${IP[sw]}`, address: IP[sw], zone: null };
    const identity = { sourceIdentity: block.sourceIdentity, producerEpoch: block.producerEpoch, source };
    const forms = sections.map(adjacencyDigestFormSection);
    for (const [i, s] of sections.entries()) s.contentDigest = adjacencyScopeDigest(identity, forms[i]!);
    const report = {
      version: 2, parentJobId: jobId, parentCommandId: jobId, producerEpoch: block.producerEpoch, snapshotId: crypto.randomUUID(), sequence: String(sequence++),
      capturedAt: new Date().toISOString(), captureAgeAtSendMs: 5, expectedIntervalSeconds: block.expectedIntervalSeconds,
      contentDigest: adjacencyReportDigest(identity, forms), source, reportKind: 'full', sections,
      finalManifest: { scopes: sections.map(s => ({ kind: s.kind, contextKey: s.contextKey, outcome: s.outcome, rowCount: s.rowCount, contentDigest: s.contentDigest })) },
    };
    const res = await app.request(`/agents/${collector}/topology/adjacency`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parentJobId: jobId, report }) });
    const body = await res.json() as Record<string, unknown>;
    expect({ status: res.status, accepted: body.accepted }, JSON.stringify(body)).toEqual({ status: 200, accepted: true });
  };
  const reconcile = async () => { for (let i = 0; i < 4; i++) { const r = await scoped(() => withDbTransaction(() => reconcileTopologySite(scope))); if (!r.published) break; } };
  const q = <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) => scoped(async () => (await db.execute(query)) as unknown as T[]);
  const nodeFor = async (assetId: string) => String((await q<{ node_id: string }>(sql`SELECT node_id FROM topology_node_bindings WHERE org_id=${scope.orgId}::uuid AND discovered_asset_id=${assetId}::uuid`))[0]!.node_id);
  return { scope, assets, post, reconcile, q, nodeFor };
}

describe('discovery transport -> physical publication (M2 Task 6b)', () => {
  it('two switches reporting each other over the real route publish one physical_link between their asset nodes', async () => {
    const f = await fixture();
    const reportFor = (sw: Sw, peer: Sw) => [section('lldp', [lldp(1, peer, 1)]), section('cdp', []), section('fdb', []), section('interfaces', [iface(sw, 1), iface(sw, 5)])];
    await f.post('A', reportFor('A', 'B'));
    await f.post('B', reportFor('B', 'A'));

    const sources = await f.q<{ context_key: string; protocol: string }>(sql`SELECT protocol, context_key FROM topology_collection_sources
      WHERE org_id=${f.scope.orgId}::uuid AND producer_kind='discovery' ORDER BY context_key, protocol`);
    // The authority shape Task 6 resolves: `<snmp:ip>/<wire context>`.
    expect(new Set(sources.map(s => s.context_key))).toEqual(new Set([`snmp:${IP.A}/default`, `snmp:${IP.B}/default`]));

    await f.reconcile();
    const rows = await f.q<{ id: string; kind: string; lifecycle: string; source_node_id: string; target_node_id: string; source_interface_id: string | null; target_interface_id: string | null; support_count: string }>(sql`
      SELECT id, kind, lifecycle, source_node_id, target_node_id, source_interface_id, target_interface_id, support_count::text FROM topology_relationships
      WHERE org_id=${f.scope.orgId}::uuid AND attributes->>'method'='lldp' AND lifecycle='active'`);
    const links = rows.filter(r => r.kind === 'physical_link');
    expect(links, JSON.stringify(rows)).toHaveLength(1);
    expect(links[0]!.support_count).toBe('2');
    expect(new Set([links[0]!.source_node_id, links[0]!.target_node_id])).toEqual(new Set([await f.nodeFor(f.assets.A), await f.nodeFor(f.assets.B)]));
    expect(links[0]!.source_interface_id).not.toBeNull();
    expect(links[0]!.target_interface_id).not.toBeNull();
    // No unresolved candidate is left active beside the measured link.
    expect(rows.filter(r => r.kind === 'attachment')).toEqual([]);
  });
});
