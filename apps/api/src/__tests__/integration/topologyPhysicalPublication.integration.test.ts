import './setup';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { normalizeFdbSection, type FdbRow, type LldpRow, type PhysicalInterfaceRow } from '@breeze/shared';
import { closeDb, db, withDbAccessContext, withDbTransaction } from '../../db';
import { createTopologyTenant, orgContext } from './topology-fixtures';
import { getTestDb } from './setup';
import { negotiateTopologyContext, registerTopologyProducerAuthority, resolveTopologyPhysicalProducer } from '../../services/topology/collectionAuthority';
import { ingestTopologySourceReport } from '../../services/topology/collectionIngest';
import { queueTopologyAging } from '../../services/topology/collectionAging';
import { drainTopologyOutbox, importLegacyTopologySite } from '../../services/topology/legacyImport';
import { reconcileTopologySite } from '../../services/topology/reconcile';
import { publishTopologyBuild } from '../../services/topology/publish';
import type { AdjacencyTopologySnapshot, AuthenticatedTopologyProducer } from '../../services/topology/collectionTypes';

afterAll(() => closeDb());

/**
 * M2 Task 6 invariants through the real M1 path: physical ingest ->
 * reconcileTopologySite (legacy import completed in the fixture) -> canonical
 * physical relationships with independent per-source support.
 */
const IP = { A: '192.0.2.1', B: '192.0.2.2' } as const;
type Sw = keyof typeof IP;
const auth = (sw: Sw) => `snmp:${IP[sw]}`;
const mac = (sw: Sw, port: number) => `02:00:00:0${sw === 'A' ? 1 : 2}:00:0${port}`;
const CLIENT_MAC = '02:00:00:00:cc:01';
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const lldp = (port: number, chassisMac: string, remotePort: number, timeMark = 100): LldpRow => ({
  rowKey: `${port}.1`, timeMark, remoteIndex: 1, localPort: { namespace: 'lldp_local', value: String(port), resolvedInterfaceKey: `name:Gi0/${port}` },
  remoteChassis: { subtype: 'mac_address', value: chassisMac }, remotePort: { subtype: 'interface_name', value: `Gi0/${remotePort}` },
});
const iface = (port: number, physAddress: string | null): PhysicalInterfaceRow => ({
  rowKey: String(port), interfaceKey: `name:Gi0/${port}`, ifIndex: port, ifName: `Gi0/${port}`, ifAlias: null, physAddress, lldpLocalPort: port, bridgePort: port,
});
const fdb = (port: number, address: string): FdbRow => ({ rowKey: `default|700|${address}|${port}`, bridgeContext: 'default', fdbId: 700, mac: address, bridgePort: port, ifIndex: port, status: 'learned', vlans: [10], vlanMapping: 'complete' });

let unregister: (() => void) | undefined;
beforeEach(() => {
  unregister = registerTopologyProducerAuthority('discovery', async request =>
    Object.values(IP).some(ip => request.authorityKey === `snmp:${ip}`) ? { authorized: true, configurationGeneration: 'gen-1' } : { authorized: false, reason: 'target_not_dispatched' });
});
afterEach(() => { unregister?.(); unregister = undefined; vi.useRealTimers(); });

async function fixture(flags: Record<string, boolean> = { materialization: true, physical: true }) {
  const tenant = await createTopologyTenant();
  const scope = { orgId: tenant.orgId, siteId: tenant.siteId };
  const scoped = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(scope.orgId), fn);
  const collector = randomUUID(), client = randomUUID(), deviceB = randomUUID();
  const assets = { A: randomUUID(), B: randomUUID() };
  const test = getTestDb();
  await test.execute(sql`UPDATE organizations SET settings=${JSON.stringify({ topologyFeatureFlags: flags })}::jsonb WHERE id=${scope.orgId}::uuid`);
  for (const [id, name] of [[collector, 'collector'], [client, 'client'], [deviceB, 'switch-b-managed']] as const) {
    await test.execute(sql`INSERT INTO devices (id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version,agent_token_hash)
      VALUES (${id}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,${id},${name},'linux','1','amd64','1',${'a'.repeat(64)})`);
  }
  await test.execute(sql`INSERT INTO device_network (device_id,org_id,interface_name,mac_address) VALUES (${client}::uuid,${scope.orgId}::uuid,'eth0',${CLIENT_MAC})`);
  for (const sw of ['A', 'B'] as const) {
    await test.execute(sql`INSERT INTO discovered_assets (id,org_id,site_id,ip_address,hostname) VALUES (${assets[sw]}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,${IP[sw]},${`switch-${sw}`})`);
  }
  let imported = await scoped(() => importLegacyTopologySite(scope));
  for (let attempt = 0; !imported.complete && attempt < 30; attempt++) imported = await scoped(() => drainTopologyOutbox(scope));
  expect(imported.complete).toBe(true);
  const config = await scoped(() => withDbTransaction(() => negotiateTopologyContext(collector)));
  if (!('producerEpoch' in config)) throw new Error('fixture capability disabled');
  const producers = {} as Record<Sw, AuthenticatedTopologyProducer>;
  for (const sw of ['A', 'B'] as const) producers[sw] = await scoped(() => resolveTopologyPhysicalProducer({ producerKind: 'discovery', deviceId: collector, scope, authorityKey: auth(sw) }));

  const snapshot = (sw: Sw, section: Record<string, unknown> & { kind: string }, sequence: string, offsetMs: number): AdjacencyTopologySnapshot => {
    const p = producers[sw];
    const rows = (section.rows as unknown[]) ?? [];
    const withoutDigest: Record<string, unknown> = { contextKey: `${auth(sw)}/default`, outcome: 'complete', rowCount: rows.length, ...section };
    const digest = sha([p.sourceIdentity, withoutDigest]);
    const finalSection = { ...withoutDigest, contentDigest: digest } as AdjacencyTopologySnapshot['section'];
    return { key: { protocol: finalSection.kind, contextKey: finalSection.contextKey, addressFamily: 'any' }, snapshotId: randomUUID(), producerEpoch: p.producerEpoch,
      sequence, capturedAt: new Date(Date.now() + offsetMs).toISOString(), captureAgeAtSendMs: 0, expectedIntervalSeconds: 3600, contentDigest: digest,
      manifest: { contract: 'adjacency_v2', target: { sourceKey: auth(sw), address: IP[sw], zone: null },
        scopes: [{ kind: finalSection.kind === 'snmp_interfaces' ? 'interfaces' : finalSection.kind as 'lldp', contextKey: 'default', outcome: finalSection.outcome, rowCount: finalSection.rowCount, contentDigest: digest }] },
      section: finalSection };
  };
  const full = async (s: AdjacencyTopologySnapshot, sw: Sw) => {
    const receipt = await scoped(() => ingestTopologySourceReport(producers[sw], { reportKind: 'full', snapshot: s }));
    expect(receipt.accepted, JSON.stringify(receipt)).toBe(true);
    return s;
  };
  const report = {
    lldp: (sw: Sw, rows: LldpRow[], sequence: string, offsetMs: number, extra: Record<string, unknown> = {}) => full(snapshot(sw, { kind: 'lldp', rows, ...extra }, sequence, offsetMs), sw),
    interfaces: (sw: Sw, rows: PhysicalInterfaceRow[], sequence: string, offsetMs: number) => full(snapshot(sw, { kind: 'snmp_interfaces', rows }, sequence, offsetMs), sw),
    fdb: (sw: Sw, rows: FdbRow[], sequence: string, offsetMs: number) => {
      const normalized = normalizeFdbSection({ kind: 'fdb', contextKey: `${auth(sw)}/default`, contentDigest: 'a'.repeat(64), outcome: 'complete', rows, rowCount: rows.length });
      const { contentDigest: _d, ...section } = normalized;
      return full(snapshot(sw, section as never, sequence, offsetMs), sw);
    },
  };
  const unchanged = (sw: Sw, base: AdjacencyTopologySnapshot, sequence: string, capturedAt: Date) => scoped(() => ingestTopologySourceReport(producers[sw], { reportKind: 'unchanged', confirmation: {
    key: base.key, producerEpoch: producers[sw].producerEpoch, snapshotId: randomUUID(), baseSnapshotId: base.snapshotId, sequence,
    capturedAt: capturedAt.toISOString(), captureAgeAtSendMs: 0, expectedIntervalSeconds: 3600, contentDigest: base.contentDigest } }));
  const reconcile = async () => { let any = false; for (let i = 0; i < 4; i++) { const last = await scoped(() => withDbTransaction(() => reconcileTopologySite(scope))); if (!last.published) break; any = true; } return { published: any }; };
  const q = <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) => scoped(async () => (await db.execute(query)) as unknown as T[]);
  const relationships = () => q<{ id: string; kind: string; lifecycle: string; method: string; source_node_id: string; target_node_id: string; source_interface_id: string | null;
    target_interface_id: string | null; confidence: string; physical: Record<string, unknown> | null; graph_revision: string; canonical_key: string; support_count: string }>(sql`
    SELECT id,kind,lifecycle,attributes->>'method' AS method,source_node_id,target_node_id,source_interface_id,target_interface_id,confidence,attributes->'physical' AS physical,
      graph_revision::text,canonical_key,support_count::text FROM topology_relationships WHERE org_id=${scope.orgId}::uuid AND attributes->>'method' IN ('lldp','cdp','fdb') ORDER BY kind,id`);
  const support = (relationshipId: string) => q<{ source_id: string; lifecycle: string; fresh_until: Date; complete_miss_count: number; content_digest: string; producer_epoch: string; sequence: string }>(sql`
    SELECT source_id,lifecycle,fresh_until,complete_miss_count,content_digest,producer_epoch,sequence::text FROM topology_relationship_support WHERE relationship_id=${relationshipId}::uuid ORDER BY source_id`);
  const siteState = async () => (await q<{ graph_revision: string; health_revision: string; build_fence: string; dirty_revision: string; identity_revision: string; resolved_identity_revision: string }>(sql`
    SELECT graph_revision::text,health_revision::text,build_fence::text,dirty_revision::text,identity_revision::text,resolved_identity_revision::text FROM topology_site_state WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid`))[0]!;
  const nodeFor = async (column: 'device_id' | 'discovered_asset_id', id: string) => String((await q<{ node_id: string }>(sql`SELECT node_id FROM topology_node_bindings WHERE org_id=${scope.orgId}::uuid AND ${sql.raw(column)}=${id}::uuid`))[0]!.node_id);
  const interfaces = () => q<{ id: string; owner_node_id: string; interface_key: string; epoch: string; phys_address: string | null; retired_at: Date | null }>(sql`
    SELECT id,owner_node_id,interface_key,epoch,phys_address,retired_at FROM topology_interfaces WHERE org_id=${scope.orgId}::uuid AND epoch LIKE 'gen:%' ORDER BY owner_node_id,interface_key,epoch`);
  const baseInterfaces = async () => { await report.interfaces('A', [iface(1, mac('A', 1)), iface(5, mac('A', 5))], '1', -3_600_000); await report.interfaces('B', [iface(1, mac('B', 1)), iface(7, mac('B', 7))], '1', -3_600_000); };
  return { scope, scoped, assets, client, deviceB, report, unchanged, reconcile, relationships, support, siteState, nodeFor, interfaces, baseInterfaces, q, test };
}
const links = <T extends { kind: string }>(rows: T[]) => rows.filter(r => r.kind === 'physical_link');

describe('canonical physical publication (M2 Task 6)', () => {
  it('merges reciprocal LLDP into one link with independent supports; interfaces and relationships publish atomically; health stays unknown', async () => {
    const f = await fixture();
    await f.baseInterfaces();
    await f.report.lldp('A', [lldp(1, mac('B', 1), 1)], '1', -1_800_000);
    await f.report.lldp('B', [lldp(1, mac('A', 1), 1)], '1', -1_800_000);
    expect((await f.reconcile()).published).toBe(true);
    const rows = await f.relationships();
    expect(links(rows)).toHaveLength(1);
    const link = links(rows)[0]!;
    expect(link).toMatchObject({ lifecycle: 'active', confidence: 'high', support_count: '2' });
    expect(new Set([link.source_node_id, link.target_node_id])).toEqual(new Set([await f.nodeFor('discovered_asset_id', f.assets.A), await f.nodeFor('discovered_asset_id', f.assets.B)]));
    expect((await f.support(link.id)).map(s => s.lifecycle)).toEqual(['active', 'active']);
    const state = await f.siteState();
    // Readers never see new interfaces with an old relationship revision: one commit.
    expect(link.graph_revision).toBe(state.graph_revision);
    expect((await f.interfaces()).map(i => i.epoch)).toEqual(['gen:1', 'gen:1', 'gen:1', 'gen:1']);
    // Physical discovery is not a successful probe.
    expect(state.health_revision).toBe('0');
  });

  it('publishes nothing through a stale build fence', async () => {
    const f = await fixture();
    await f.baseInterfaces();
    await f.report.lldp('A', [lldp(1, mac('B', 1), 1)], '1', -1_800_000);
    // Legacy import leaves outbox events; drain so the fence is the only reason to refuse.
    await f.scoped(() => drainTopologyOutbox(f.scope));
    const state = await f.siteState();
    const result = await f.scoped(() => withDbTransaction(() => publishTopologyBuild(f.scope, { buildFence: String(BigInt(state.build_fence) + 7n), inputRevision: state.dirty_revision, nodes: [], relationships: [], bindings: [] })));
    expect(result.published).toBe(false);
    expect(await f.relationships()).toEqual([]);
    expect(await f.interfaces()).toEqual([]);
    const [pending] = await f.q<{ n: number }>(sql`SELECT count(*)::int AS n FROM topology_collection_runs WHERE org_id=${f.scope.orgId}::uuid AND materialized_at IS NULL`);
    expect(pending!.n).toBe(3);
  });

  it('keeps A after complete{A} -> partial{B}; complete-empty twice withdraws only that source', async () => {
    const f = await fixture();
    await f.baseInterfaces();
    await f.report.lldp('A', [lldp(1, mac('B', 1), 1)], '1', -3_000_000);
    await f.report.lldp('B', [lldp(1, mac('A', 1), 1)], '1', -3_000_000);
    await f.reconcile();
    const link = links(await f.relationships())[0]!;
    // B: partial read that omits the link row and reports another neighbour.
    await f.report.lldp('B', [lldp(7, '02:00:00:00:ee:01', 3)], '2', -2_400_000, { outcome: 'partial', reasonCode: 'timeout' });
    await f.reconcile();
    expect((await f.support(link.id)).map(s => s.lifecycle)).toEqual(['active', 'active']);
    // A: complete-empty, then the same empty body >= 5 minutes later.
    const empty = await f.report.lldp('A', [], '2', -1_800_000);
    await f.reconcile();
    expect((await f.support(link.id)).map(s => s.lifecycle)).toEqual(['active', 'active']);
    expect((await f.unchanged('A', empty, '3', new Date(Date.now() - 600_000))).accepted).toBe(true);
    await f.reconcile();
    const after = await f.support(link.id);
    expect(after.map(s => s.lifecycle).sort()).toEqual(['active', 'withdrawn']);
    expect(links(await f.relationships())[0]).toMatchObject({ id: link.id, lifecycle: 'active', support_count: '1' });
  });

  it('moves support to the resolved link when identity arrives later, without renewing freshness', async () => {
    const f = await fixture();
    await f.report.interfaces('A', [iface(1, mac('A', 1))], '1', -3_600_000);
    await f.report.lldp('A', [lldp(1, mac('B', 1), 1)], '1', -1_800_000);
    await f.reconcile();
    const [candidate] = await f.relationships();
    expect(candidate).toMatchObject({ kind: 'attachment', lifecycle: 'active', physical: expect.objectContaining({ resolution: 'unresolved' }) });
    const [before] = await f.support(candidate!.id);
    await f.report.interfaces('B', [iface(1, mac('B', 1))], '1', -1_000_000);
    await f.reconcile();
    const rows = await f.relationships();
    const link = links(rows)[0]!;
    expect(link.lifecycle).toBe('active');
    expect(rows.find(r => r.id === candidate!.id)).toMatchObject({ lifecycle: 'archived', support_count: '0' });
    expect(await f.support(candidate!.id)).toEqual([]);
    const [moved] = await f.support(link.id);
    expect(moved).toEqual(before);
    const state = await f.siteState();
    expect(state.resolved_identity_revision).toBe(state.identity_revision);
    // The source's row mapping now names the link: a later miss withdraws the link.
    const [source] = await f.q<{ published_baseline: { _rowRelationships: Record<string, string[]> } }>(sql`SELECT published_baseline FROM topology_collection_sources WHERE org_id=${f.scope.orgId}::uuid AND protocol='lldp'`);
    expect(source!.published_baseline._rowRelationships).toEqual({ '1.1': [link.id] });
  });

  it('archived candidate -> identity resolves -> same-digest confirmation revives the RESOLVED relationship', async () => {
    const f = await fixture();
    await f.report.interfaces('A', [iface(1, mac('A', 1))], '1', -3_600_000);
    const base = await f.report.lldp('A', [lldp(1, mac('B', 1), 1)], '1', -1_800_000);
    await f.reconcile();
    const future = new Date(Date.now() + 8 * 86400_000);
    expect(await f.scoped(() => withDbTransaction(() => queueTopologyAging(f.scope, future)))).toBe(1);
    await f.reconcile();
    const [candidate] = await f.relationships();
    expect(candidate!.lifecycle).toBe('archived');
    await f.report.interfaces('B', [iface(1, mac('B', 1))], '1', -1_000_000);
    await f.reconcile();
    const link = links(await f.relationships())[0]!;
    expect(link.lifecycle).toBe('archived');
    expect((await f.support(link.id)).map(s => s.lifecycle)).toEqual(['archived']);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(future);
    expect((await f.unchanged('A', base, '2', future)).accepted).toBe(true);
    await f.reconcile();
    vi.useRealTimers();
    expect(links(await f.relationships())[0]).toMatchObject({ id: link.id, lifecycle: 'active' });
    expect((await f.relationships()).find(r => r.id === candidate!.id)!.lifecycle).toBe('archived');
  });

  it('a new interface generation does not inherit the old link', async () => {
    const f = await fixture();
    await f.baseInterfaces();
    await f.report.lldp('A', [lldp(1, mac('B', 1), 1)], '1', -3_000_000);
    await f.reconcile();
    const old = links(await f.relationships())[0]!;
    // B's Gi0/1 comes back with another MAC: conflicting identity.
    await f.report.interfaces('B', [iface(1, '02:00:00:00:99:01'), iface(7, mac('B', 7))], '2', -2_400_000);
    await f.reconcile();
    const generations = (await f.interfaces()).filter(i => i.interface_key === 'name:Gi0/1' && i.phys_address?.startsWith('02:00:00:0'));
    expect(generations.some(i => i.epoch === 'gen:2' && !i.retired_at)).toBe(true);
    expect(generations.some(i => i.epoch === 'gen:1' && i.retired_at && i.phys_address === mac('B', 1))).toBe(true);
    // A re-learns the neighbour (new timeMark) on the new generation.
    await f.report.lldp('A', [lldp(1, '02:00:00:00:99:01', 1, 200)], '2', -1_800_000);
    await f.reconcile();
    const rows = links(await f.relationships());
    const fresh = rows.find(r => r.id !== old.id)!;
    expect(fresh.lifecycle).toBe('active');
    expect(rows.find(r => r.id === old.id)!.lifecycle).toBe('withdrawn');
    const gen2 = (await f.interfaces()).find(i => i.interface_key === 'name:Gi0/1' && i.epoch === 'gen:2')!;
    expect([fresh.source_interface_id, fresh.target_interface_id]).toContain(gen2.id);
    expect(new Set([fresh.source_interface_id, fresh.target_interface_id])).not.toEqual(new Set([old.source_interface_id, old.target_interface_id]));
  });

  it('competing FDB selects no parent; after the second miss of one competitor the other is selected', async () => {
    const f = await fixture();
    await f.baseInterfaces();
    await f.report.fdb('A', [fdb(5, CLIENT_MAC)], '1', -3_000_000);
    await f.report.fdb('B', [fdb(7, CLIENT_MAC)], '1', -3_000_000);
    await f.reconcile();
    const clientNode = await f.nodeFor('device_id', f.client);
    let fdbRows = (await f.relationships()).filter(r => r.method === 'fdb');
    expect(fdbRows).toHaveLength(2);
    for (const row of fdbRows) expect(row).toMatchObject({ target_node_id: clientNode, confidence: 'low', physical: expect.objectContaining({ fdbSelection: 'competing' }) });
    const empty = await f.report.fdb('A', [], '2', -1_800_000);
    await f.reconcile();
    expect((await f.relationships()).filter(r => r.method === 'fdb').every(r => r.physical?.fdbSelection === 'competing')).toBe(true);
    expect((await f.unchanged('A', empty, '3', new Date(Date.now() - 600_000))).accepted).toBe(true);
    await f.reconcile();
    fdbRows = (await f.relationships()).filter(r => r.method === 'fdb');
    const bNode = await f.nodeFor('discovered_asset_id', f.assets.B);
    expect(fdbRows.find(r => r.source_node_id === bNode)).toMatchObject({ lifecycle: 'active', confidence: 'medium', physical: expect.objectContaining({ fdbSelection: 'selected' }) });
    expect(fdbRows.find(r => r.source_node_id !== bNode)).toMatchObject({ lifecycle: 'withdrawn', physical: expect.objectContaining({ fdbSelection: 'none' }) });
  });

  it('node merge re-owns interfaces, keeps the link id and pins, and rekeys the link to the survivor', async () => {
    const f = await fixture();
    await f.baseInterfaces();
    await f.report.lldp('A', [lldp(1, mac('B', 1), 1)], '1', -3_000_000);
    await f.reconcile();
    const link = links(await f.relationships())[0]!;
    const assetNode = await f.nodeFor('discovered_asset_id', f.assets.B);
    const deviceNode = await f.nodeFor('device_id', f.deviceB);
    await f.test.execute(sql`UPDATE topology_nodes SET created_at='2020-01-01' WHERE id=${deviceNode}::uuid`);
    await f.test.execute(sql`UPDATE topology_nodes SET created_at='2022-01-01' WHERE id=${assetNode}::uuid`);
    const [layout] = await f.test.execute(sql`INSERT INTO topology_layouts (org_id,site_id,view) VALUES (${f.scope.orgId}::uuid,${f.scope.siteId}::uuid,'physical') RETURNING id`);
    await f.test.execute(sql`INSERT INTO topology_node_positions (org_id,site_id,layout_id,node_id,x,y,pinned,position_source) VALUES (${f.scope.orgId}::uuid,${f.scope.siteId}::uuid,${String(layout!.id)}::uuid,${assetNode}::uuid,11,22,true,'user')`);
    await f.test.execute(sql`UPDATE discovered_assets SET linked_device_id=${f.deviceB}::uuid, link_source='manual' WHERE id=${f.assets.B}::uuid`);
    await f.reconcile();
    const [merged] = await f.q<{ alias_target_id: string }>(sql`SELECT alias_target_id FROM topology_nodes WHERE id=${assetNode}::uuid`);
    expect(merged!.alias_target_id).toBe(deviceNode);
    const after = links(await f.relationships());
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: link.id, lifecycle: 'active' });
    expect([after[0]!.source_node_id, after[0]!.target_node_id]).toContain(deviceNode);
    expect(after[0]!.canonical_key).not.toBe(link.canonical_key);
    expect((await f.interfaces()).filter(i => i.owner_node_id === assetNode)).toEqual([]);
    expect((await f.interfaces()).filter(i => i.owner_node_id === deviceNode).map(i => i.interface_key).sort()).toEqual(['name:Gi0/1', 'name:Gi0/7']);
    const [pin] = await f.q<{ x: number; y: number; pinned: boolean }>(sql`SELECT x,y,pinned FROM topology_node_positions WHERE node_id=${deviceNode}::uuid AND layout_id=${String(layout!.id)}::uuid`);
    expect(pin).toMatchObject({ x: 11, y: 22, pinned: true });
    expect((await f.support(link.id)).map(s => s.lifecycle)).toEqual(['active']);
    // B's own report now resolves to the survivor and converges on the same link.
    await f.report.lldp('B', [lldp(1, mac('A', 1), 1)], '1', -1_800_000);
    await f.reconcile();
    expect(links(await f.relationships())).toEqual([expect.objectContaining({ id: link.id, support_count: '2' })]);
  });

  it('keeps publishing canonical support with physical off and materialization on', async () => {
    const f = await fixture({ materialization: true, physical: false });
    await f.baseInterfaces();
    await f.report.lldp('A', [lldp(1, mac('B', 1), 1)], '1', -1_800_000);
    await f.reconcile();
    const link = links(await f.relationships())[0]!;
    expect(link.lifecycle).toBe('active');
    expect(await f.support(link.id)).toHaveLength(1);
  });
});
