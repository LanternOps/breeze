import './setup';
import { writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  graphResponseSchema, relationshipDetailResponseSchema, type GraphResponse, type RelationshipDetailResponse,
} from '@breeze/shared';
import { closeDb, db } from '../../db';
import { organizations, topologyLayout, topologyManualNodes } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { createTopologyRoutes } from '../../routes/topology';
import { clearPermissionCache, type UserPermissions } from '../../services/permissions';
import type { TopologyRequestContext } from '../../services/topology/access';
import { compareLegacyTopology } from '../../services/topology/legacyParity';
import { drainTopologyOutbox } from '../../services/topology/legacyImport';
import { PHYSICAL_FIXTURE, seedTopologyPhysicalFixture, TOPOLOGY_PHYSICAL_VARIANTS, type TopologyPhysicalFixture } from '../helpers/topologyPhysical';
import { topologyGraphFixture } from '../../../../../packages/shared/src/testing/topologyFleet';
import { createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';
import { getTestDb } from './setup';

// The legacy UniFi telemetry queue is a separate consumer; the topology
// companion under test is ingested synchronously before it (unifiTelemetry.ts).
const legacyTelemetry = vi.hoisted(() => ({ enqueued: 0 }));
vi.mock('../../jobs/unifiTelemetryWorker', async (original) => ({
  ...await original<object>(), enqueueUnifiTelemetry: vi.fn(async () => { legacyTelemetry.enqueued += 1; }),
}));

afterAll(() => closeDb());

/**
 * M2 Task 10 vertical acceptance (`physical-enrichment`). Starts from the M1
 * no-management graph with saved pinned positions, ingests SNMP adjacency
 * through the discovery route and the UniFi controller through the telemetry
 * route (real adapters, real authority), publishes through the ordered M1
 * publisher, and inspects the result ONLY through the authenticated graph
 * routes. The six-field release `report` is computed from real SQL counts and
 * the M0 parity comparison — never from expected values.
 */
const GRANTS = [
  { resource: 'topology', action: 'read' }, { resource: 'topology', action: 'write' }, { resource: 'devices', action: 'read' },
];
type Env = TestEnvironment;
const app = () => new Hono().route('/topology', createTopologyRoutes());
const call = (env: Env, method: string, path: string, body?: unknown) => {
  clearPermissionCache();
  return app().request(`/topology/sites/${env.site.id}/${path}`, {
    method, headers: { Authorization: `Bearer ${env.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
};
async function read<T>(env: Env, path: string, parse: (value: unknown) => T): Promise<T> {
  const response = await call(env, 'GET', path);
  const body = await response.json();
  expect(response.status, `${path}: ${JSON.stringify(body)}`).toBe(200);
  return parse(body);
}
const graph = (env: Env, query = 'view=overview&limit=500'): Promise<GraphResponse> => read(env, `graph?${query}`, (v) => graphResponseSchema.parse(v));
const detail = (env: Env, id: string): Promise<RelationshipDetailResponse> => read(env, `relationships/${id}`, (v) => relationshipDetailResponseSchema.parse(v));

function writerFor(env: Env): TopologyRequestContext {
  const orgId = env.organization.id;
  return {
    scope: { orgId, siteId: env.site.id },
    auth: { user: env.user, scope: 'organization', orgId, partnerId: env.partner.id, accessibleOrgIds: [orgId], allowedSiteIds: undefined,
      token: { mfa: true }, canAccessOrg: (candidate: string) => candidate === orgId } as unknown as AuthContext,
    permissions: { permissions: GRANTS, scope: 'organization', partnerId: env.partner.id, orgId, roleId: env.role.id } as unknown as UserPermissions,
  };
}

async function physical(options: { variants?: typeof TOPOLOGY_PHYSICAL_VARIANTS[number][] } = {}) {
  const env = await setupTestEnvironment({ scope: 'organization', rolePermissions: GRANTS });
  const f = await seedTopologyPhysicalFixture({ partnerId: env.partner.id, orgId: env.organization.id, siteId: env.site.id },
    { writer: writerFor(env), variants: options.variants });
  return { env, f };
}

/** Rows a read must never create: commands, discovery jobs, diagnostic runs/steps, exclusions, outbox events, revisions. */
async function sideEffects(f: TopologyPhysicalFixture) {
  const [row] = await getTestDb().execute<Record<string, string>>(sql`SELECT
    (SELECT count(*) FROM device_commands WHERE device_id IN (SELECT id FROM devices WHERE org_id=${f.scope.orgId}::uuid))::text AS commands,
    (SELECT count(*) FROM discovery_jobs WHERE org_id=${f.scope.orgId}::uuid)::text AS jobs,
    (SELECT count(*) FROM topology_diagnostic_runs WHERE org_id=${f.scope.orgId}::uuid)::text AS runs,
    (SELECT count(*) FROM topology_diagnostic_steps WHERE org_id=${f.scope.orgId}::uuid)::text AS steps,
    (SELECT count(*) FROM topology_view_exclusions WHERE org_id=${f.scope.orgId}::uuid)::text AS exclusions,
    (SELECT count(*) FROM topology_change_outbox WHERE org_id=${f.scope.orgId}::uuid)::text AS outbox,
    (SELECT count(*) FROM topology_collection_runs WHERE org_id=${f.scope.orgId}::uuid)::text AS collection_runs,
    (SELECT graph_revision::text || '/' || health_revision::text || '/' || dirty_revision::text FROM topology_site_state WHERE org_id=${f.scope.orgId}::uuid LIMIT 1) AS revisions,
    (SELECT max(updated_at)::text FROM topology_relationships WHERE org_id=${f.scope.orgId}::uuid) AS relationships,
    (SELECT max(updated_at)::text FROM topology_node_positions WHERE org_id=${f.scope.orgId}::uuid) AS positions`);
  return row!;
}
const commandCount = async (f: TopologyPhysicalFixture) => Number((await sideEffects(f)).commands) + Number((await sideEffects(f)).runs);
const runCount = async (f: TopologyPhysicalFixture) => Number((await sideEffects(f)).collection_runs);
const graphRevision = async (f: TopologyPhysicalFixture) => (await sideEffects(f)).revisions!.split('/')[0]!;

type RelRow = { id: string; kind: string; lifecycle: string; method: string | null; source_node_id: string; target_node_id: string;
  source_interface_id: string | null; target_interface_id: string | null; support_count: string; evidence_class: string; legacy: boolean;
  association: string | null; fdb_selection: string | null; directness: string };
const relationships = (f: TopologyPhysicalFixture) => f.q<RelRow>(sql`SELECT id, kind, lifecycle, attributes->>'method' AS method, source_node_id, target_node_id,
  source_interface_id, target_interface_id, support_count::text, evidence_class, (legacy_source_id IS NOT NULL) AS legacy, directness,
  attributes->'physical'->>'association' AS association, attributes->'physical'->>'fdbSelection' AS fdb_selection
  FROM topology_relationships WHERE org_id=${f.scope.orgId}::uuid AND site_id=${f.scope.siteId}::uuid AND deleted_at IS NULL ORDER BY kind, id`);
const supportOf = (f: TopologyPhysicalFixture, relationshipId: string) => f.q<{ lifecycle: string; protocol: string; context_key: string }>(sql`
  SELECT s.lifecycle, c.protocol, c.context_key FROM topology_relationship_support s JOIN topology_collection_sources c ON c.id=s.source_id
  WHERE s.relationship_id=${relationshipId}::uuid ORDER BY c.context_key, c.protocol`);
const positions = (f: TopologyPhysicalFixture) => f.q<{ node_id: string; x: number; y: number; pinned: boolean }>(sql`
  SELECT p.node_id, p.x, p.y, p.pinned FROM topology_node_positions p JOIN topology_layouts l ON l.id=p.layout_id
  WHERE p.org_id=${f.scope.orgId}::uuid AND l.view='overview' AND p.deleted_at IS NULL ORDER BY p.node_id`);
const pairOf = (row: { source_node_id: string; target_node_id: string }) => [row.source_node_id, row.target_node_id].sort().join('|');
const pair = (a: string, b: string) => [a, b].sort().join('|');

describe('physical enrichment vertical (M2 Task 10)', () => {
  it('enriches the no-management baseline without losing logical facts, pins or passivity', async () => {
    const { env, f } = await physical();
    const before = await relationships(f);
    const logicalBefore = before.filter(r => ['network_member', 'default_route', 'egress_path'].includes(r.kind)).map(r => ({ id: r.id, kind: r.kind, lifecycle: r.lifecycle }));
    // The M1 baseline: the agent's default route and its own subnet membership (os_network_context).
    expect(logicalBefore.map(r => r.kind).sort()).toEqual(['default_route', 'network_member']);
    expect(logicalBefore.every(r => r.lifecycle === 'active')).toBe(true);
    expect(before.filter(r => ['physical_link', 'attachment'].includes(r.kind) && !r.legacy)).toEqual([]);
    const pinsBefore = await positions(f);
    expect(pinsBefore.filter(p => p.pinned).length).toBeGreaterThanOrEqual(2);

    await f.publishPhysical(f.at(-9));
    const rows = await relationships(f);
    const active = rows.filter(r => r.lifecycle === 'active');

    // Baseline logical facts retained, same ids, still active.
    for (const fact of logicalBefore) expect(rows.find(r => r.id === fact.id)).toMatchObject({ kind: fact.kind, lifecycle: 'active' });

    // Reciprocal LLDP combined: ONE link per cable, both switches supporting it; parallel cables stay distinct.
    const links = active.filter(r => r.kind === 'physical_link' && r.method === 'lldp');
    expect(links, JSON.stringify(active)).toHaveLength(2);
    for (const link of links) {
      expect(pairOf(link)).toBe(pair(f.nodes.A, f.nodes.B));
      expect(link.support_count).toBe('2');
      expect((await supportOf(f, link.id)).map(s => s.lifecycle)).toEqual(['active', 'active']);
    }
    expect(new Set(links.map(l => [l.source_interface_id, l.target_interface_id].sort().join('|'))).size).toBe(2);

    // FDB-only attachment: learned through A:24, directness not established, the only candidate so selected.
    const fdb = active.filter(r => r.method === 'fdb');
    const fdbOnly = fdb.find(r => pairOf(r) === pair(f.nodes.A, f.nodes.agent))!;
    expect(fdbOnly).toMatchObject({ kind: 'attachment', directness: 'unknown', fdb_selection: 'selected', evidence_class: 'inferred' });
    // Ambiguity visible: the desk NIC behind A:3 and B:3 competes; neither is selected. The shared A:48 is never a third.
    const desk = fdb.filter(r => [r.source_node_id, r.target_node_id].includes(f.nodes.desk));
    expect(desk.map(r => r.fdb_selection).sort()).toEqual(['competing', 'competing']);
    expect(desk.map(r => r.source_node_id).sort()).toEqual([f.nodes.A, f.nodes.B].sort());
    // Q-BRIDGE shared/upstream port: aggregate only — none of its 20 MACs becomes a per-MAC attachment.
    const mintedForShared = await f.q<{ n: number }>(sql`SELECT count(*)::int AS n FROM topology_nodes WHERE org_id=${f.scope.orgId}::uuid
      AND identity_material->>'sourceKey' LIKE 'mac-endpoint:%02%3A00%3A00%3A00%3A5%'`);
    expect(mintedForShared[0]!.n).toBe(0);
    const [fdbSource] = await f.q<{ rows: { kind?: string; rowKind?: string }[] }>(sql`SELECT current_baseline->'section'->'rows' AS rows FROM topology_collection_sources
      WHERE org_id=${f.scope.orgId}::uuid AND protocol='fdb' AND context_key LIKE ${`snmp:${PHYSICAL_FIXTURE.switchIp.A}/%`}`);
    expect(JSON.stringify(fdbSource!.rows)).toMatch(/shared_port/);

    // UniFi: VPN is a remote-access association — never a cable and never a radio (direct) link.
    const unifi = active.filter(r => r.method === 'unifi');
    expect(unifi.every(r => r.kind === 'attachment')).toBe(true);
    const vpn = unifi.find(r => r.association === 'vpn')!;
    expect(vpn).toMatchObject({ kind: 'attachment', directness: 'unknown' });
    expect(unifi.find(r => r.association === 'wireless')).toMatchObject({ directness: 'direct' });

    // Inspect only through the graph routes.
    const physicalView = await graph(env, 'view=physical&limit=500');
    const visible = new Map(physicalView.relationships.map(r => [r.id, r]));
    for (const link of links) expect(visible.get(link.id)).toMatchObject({ kind: 'physical_link', directness: 'direct' });
    expect(visible.get(fdbOnly.id)).toMatchObject({ kind: 'attachment', directness: 'unknown' });
    for (const d of desk) expect(visible.get(d.id)).toMatchObject({ confidence: 'low' });
    expect(physicalView.relationships.every(r => r.kind === 'physical_link' || r.kind === 'attachment')).toBe(true);
    const overview = await graph(env);
    for (const fact of logicalBefore) expect(overview.relationships.map(r => r.id)).toContain(fact.id);

    const [a, b] = await Promise.all(links.map(l => detail(env, l.id)));
    for (const d of [a!, b!]) {
      expect(d.physical).toMatchObject({ method: 'lldp', portRole: 'identified', association: 'wired' });
      expect([d.endpoints.source.port?.name, d.endpoints.target.port?.name].sort()).toEqual(expect.arrayContaining([expect.stringMatching(/^Gi0\/[12]$/)]));
    }
    expect(new Set([a!, b!].map(d => d.endpoints.source.port?.name)).size).toBe(2);
    const fdbDetail = await detail(env, fdbOnly.id);
    expect(fdbDetail.physical).toMatchObject({ method: 'fdb', portRole: 'learned', fdbSelection: 'selected' });
    const competing = await detail(env, desk[0]!.id);
    expect(competing.physical?.fdbSelection).toBe('competing');
    expect(competing.alternatives.map(x => x.relationshipId)).toContain(desk[1]!.id);
    const vpnDetail = await detail(env, vpn.id);
    expect(vpnDetail.physical).toMatchObject({ method: 'unifi', association: 'vpn' });
    expect(vpnDetail.relationship.kind).toBe('attachment');

    // legacy-agent-positive-only: the pre-M2 agent's port-less adjacency row stays as its own legacy
    // relationship beside the measured cables (no port-level equivalence, so no suppression, D5).
    const legacy = rows.filter(r => r.legacy && pairOf(r) === pair(f.nodes.A, f.nodes.B));
    expect(legacy, JSON.stringify(rows.filter(r => r.legacy))).toHaveLength(1);
    expect(legacy[0]).toMatchObject({ lifecycle: 'active', source_interface_id: null, target_interface_id: null });
    expect(links.map(l => l.id)).not.toContain(legacy[0]!.id);
    // manual-pinned-import: the imported legacy pin and the saved v2 pins are all present.
    expect(pinsBefore).toEqual(expect.arrayContaining([
      { node_id: f.nodes.manualA, ...PHYSICAL_FIXTURE.manual.pin, pinned: true },
      { node_id: f.nodes.agent, ...PHYSICAL_FIXTURE.pins.agent, pinned: true },
      { node_id: f.nodes.gateway, ...PHYSICAL_FIXTURE.pins.gateway, pinned: true },
    ]));

    // Pins survived enrichment byte-for-byte, and reads dispatched nothing.
    expect(await positions(f)).toEqual(expect.arrayContaining(pinsBefore));
    const quiet = await sideEffects(f);
    await graph(env, 'view=physical&limit=500'); await graph(env); await detail(env, links[0]!.id);
    await read(env, `relationships/${fdbOnly.id}/evidence`, (v) => v); await read(env, 'exclusions?view=physical', (v) => v);
    expect(await sideEffects(f)).toEqual(quiet);
  });

  it('keeps other sources through a protocol timeout and a partial controller page; complete-empty twice withdraws only that source; a crash before commit loses nothing', async () => {
    const { env, f } = await physical();
    await f.publishPhysical(f.at(-9));
    const links = (await relationships(f)).filter(r => r.kind === 'physical_link' && r.lifecycle === 'active');
    expect(links).toHaveLength(2);
    const laptop = (await relationships(f)).find(r => r.method === 'unifi' && r.association === 'wireless')!;
    const others = (await relationships(f)).filter(r => r.lifecycle === 'active' && !links.some(l => l.id === r.id));

    // One protocol timeout: B's LLDP walk times out after its first neighbour (partial), and the
    // controller's client page times out without the laptop. Neither erases any support.
    const b = f.switchContent('B');
    expect((await f.adjacency('B', { ...b, lldp: b.lldp!.slice(0, 1), lldpOutcome: 'partial' }, f.at(-8))).body.accepted).toBe(true);
    const partialPage = await f.unifi(f.at(-8), { clientOutcome: 'partial', clients: f.unifiRows.client_list.filter(c => c.rowKey !== 'client-laptop') });
    expect(partialPage.body.topology?.accepted, JSON.stringify(partialPage.body)).toBe(true);
    await f.reconcile();
    for (const link of links) expect((await supportOf(f, link.id)).map(s => s.lifecycle)).toEqual(['active', 'active']);
    expect((await relationships(f)).find(r => r.id === laptop.id)).toMatchObject({ lifecycle: 'active' });

    // Complete-empty from A (6 minutes before the confirmation below), then the same empty body again.
    const a = f.switchContent('A');
    expect((await f.adjacency('A', { ...a, lldp: [] }, f.at(-6))).body.accepted).toBe(true);
    await f.reconcile();
    for (const link of links) expect((await supportOf(f, link.id)).map(s => s.lifecycle)).toEqual(['active', 'active']);
    const confirmed = await f.unchanged('A', f.at(0));
    expect(confirmed.body.accepted, JSON.stringify(confirmed.body)).toBe(true);

    // The reconcile worker dies after publishing, before COMMIT: nothing it did is visible...
    const revision = await graphRevision(f);
    expect(await f.crashBeforeCommit()).toBe('rolled_back');
    for (const link of links) expect((await supportOf(f, link.id)).map(s => s.lifecycle)).toEqual(['active', 'active']);
    expect(await graphRevision(f)).toBe(revision);
    // ...and the retry applies every transition exactly once.
    expect((await f.reconcile()).published).toBe(true);
    for (const link of links) {
      const support = await supportOf(f, link.id);
      expect(support.find(s => s.context_key.startsWith(`snmp:${PHYSICAL_FIXTURE.switchIp.A}/`))?.lifecycle).toBe('withdrawn');
      expect(support.find(s => s.context_key.startsWith(`snmp:${PHYSICAL_FIXTURE.switchIp.B}/`))?.lifecycle).toBe('active');
    }
    const after = await relationships(f);
    for (const link of links) expect(after.find(r => r.id === link.id)).toMatchObject({ lifecycle: 'active', support_count: '1' });
    // Only that source withdrew: every other relationship keeps its lifecycle.
    for (const other of others) expect(after.find(r => r.id === other.id)?.lifecycle, `${other.kind}/${other.method}`).toBe('active');
    expect((await graph(env, 'view=physical&limit=500')).relationships.filter(r => r.kind === 'physical_link').map(r => r.id).sort())
      .toEqual(links.map(l => l.id).sort());
    expect(legacyTelemetry.enqueued).toBeGreaterThan(0);
  });

  it('a controller-site remap withdraws only the UniFi source and a remap back re-baselines the same associations', async () => {
    const { env, f } = await physical();
    await f.publishPhysical(f.at(-9));
    const before = await relationships(f);
    const unifi = before.filter(r => r.method === 'unifi' && r.lifecycle === 'active');
    expect(unifi.length).toBeGreaterThanOrEqual(4);
    const rest = before.filter(r => r.lifecycle === 'active' && r.method !== 'unifi');
    const otherSite = (await createSite({ orgId: env.organization.id })).id;

    expect(await f.remapUnifi(otherSite)).toBeGreaterThan(0);
    await f.reconcile();
    let rows = await relationships(f);
    for (const r of unifi) expect(rows.find(x => x.id === r.id)?.lifecycle, r.association ?? '').toBe('withdrawn');
    for (const r of rest) expect(rows.find(x => x.id === r.id)?.lifecycle, `${r.kind}/${r.method}`).toBe('active');

    await f.remapUnifi(env.site.id);
    const back = await f.unifi(f.at(-1));
    expect(back.body.topology?.accepted, JSON.stringify(back.body)).toBe(true);
    await f.reconcile();
    rows = await relationships(f);
    for (const r of unifi) expect(rows.find(x => x.id === r.id)?.lifecycle, r.association ?? '').toBe('active');
    const epochs = await f.q<{ n: number }>(sql`SELECT count(DISTINCT producer_epoch)::int AS n FROM topology_collection_sources
      WHERE org_id=${f.scope.orgId}::uuid AND site_id=${f.scope.siteId}::uuid AND producer_kind='unifi'`);
    expect(epochs[0]!.n).toBe(1);
  });


  it('produces the physical-enrichment release report: flag off -> on with capture continuing drops nothing, repeats insert nothing, reads dispatch nothing', async () => {
    const { env, f } = await physical();
    const effectsAtStart = await sideEffects(f);
    await f.publishPhysical(f.at(-9));
    const links = (await relationships(f)).filter(r => r.kind === 'physical_link' && r.lifecycle === 'active').map(r => r.id).sort();
    expect(links).toHaveLength(2);

    // Unchanged repeats of every collector: identical full bodies and `unchanged` confirmations.
    const runsBefore = await runCount(f);
    const revisionBefore = await graphRevision(f);
    expect((await f.adjacency('A', f.switchContent('A'), f.at(-8))).body.accepted).toBe(true);
    expect((await f.unchanged('B', f.at(-8))).body.accepted).toBe(true);
    expect((await f.unifi(f.at(-8))).body.topology?.accepted).toBe(true);
    expect((await f.agentContext('2', f.at(-8))).accepted).toBe(true);
    await f.reconcile();
    const unchangedCollectionRunInserts = (await runCount(f)) - runsBefore;
    expect(await graphRevision(f)).toBe(revisionBefore);

    // A v2-only manual fact (no legacy row): an asserted cable from B:Gi0/3 to the desk.
    const [port] = await f.q<{ id: string }>(sql`SELECT id FROM topology_interfaces WHERE org_id=${f.scope.orgId}::uuid AND owner_node_id=${f.nodes.B}::uuid
      AND interface_key='name:Gi0/3' AND retired_at IS NULL`);
    const created = await call(env, 'POST', 'manual-relationships', { sourceNodeId: f.nodes.B, targetNodeId: f.nodes.desk, kind: 'physical_link', sourceInterfaceId: port!.id, label: 'Desk 12 patch' });
    const manual = await created.json() as { id: string; legacyId: string | null };
    expect(created.status, JSON.stringify(manual)).toBe(201);
    expect(manual.legacyId).toBeNull();

    // Physical OFF (deployment rollback). Capture and collection keep running.
    const setPhysical = (on: boolean) => getTestDb().update(organizations).set({ settings: { topologyFeatureFlags: { materialization: true, ui: true, physical: on } } })
      .where(eq(organizations.id, f.scope.orgId));
    await setPhysical(false);
    const off = await graph(env, 'view=physical&limit=500');
    // Collected physical evidence is hidden everywhere; manual and legacy rows are never gated (D9/D15.4).
    expect(off.relationships.filter(r => r.evidence.methods.some(m => ['lldp', 'cdp', 'fdb', 'unifi'].includes(m)))).toEqual([]);
    for (const id of links) expect(off.relationships.map(r => r.id)).not.toContain(id);
    expect(off.relationships.map(r => r.id)).toContain(manual.id);
    expect(off.coverage.reasons.map(r => r.code)).toContain('physical_disabled');
    expect((await graph(env)).relationships.map(r => r.id)).toContain(manual.id);
    // Legacy writers edit through the capture triggers while exposure is off: a manual rename, a pin move, a deletion.
    const renamed = `${PHYSICAL_FIXTURE.manual.a} (moved)`;
    await getTestDb().update(topologyManualNodes).set({ label: renamed }).where(eq(topologyManualNodes.id, f.ids.manualA));
    await getTestDb().update(topologyLayout).set({ x: PHYSICAL_FIXTURE.manual.pin.x + 25 }).where(eq(topologyLayout.nodeId, f.ids.manualA));
    await getTestDb().execute(sql`DELETE FROM network_topology WHERE id=${f.ids.manualEdge}::uuid`);
    // A v2 layout edit while off (the editor refreshes first: the captured legacy pin move advanced the layout), and collection continuing.
    await f.scoped(() => drainTopologyOutbox(f.scope));
    const [layout] = await f.q<{ revision: string }>(sql`SELECT revision::text FROM topology_layouts WHERE org_id=${f.scope.orgId}::uuid AND view='overview'`);
    const moved = { x: PHYSICAL_FIXTURE.pins.agent.x + 10, y: PHYSICAL_FIXTURE.pins.agent.y + 10 };
    const saved = await call(env, 'PATCH', 'layouts/overview', { expectedRevision: layout!.revision, positions: [{ nodeId: f.nodes.agent, ...moved, pinned: true }] });
    expect(saved.status, JSON.stringify(await saved.clone().json())).toBe(200);
    expect((await f.unchanged('B', f.at(-4))).body.accepted).toBe(true);
    await f.reconcile();

    // Physical back ON: no reprojection, nothing dropped.
    await setPhysical(true);
    await f.reconcile();
    await f.scoped(async () => { for (let i = 0; i < 20 && !(await drainTopologyOutbox(f.scope)).complete; i++); });
    const parity = await f.scoped(() => compareLegacyTopology(f.scope));
    expect({ complete: parity.complete, sameBarrier: parity.sameBarrier, ok: parity.ok }, JSON.stringify(parity)).toEqual({ complete: true, sameBarrier: true, ok: true });
    // Non-vacuous: every edit made while off actually reached the canonical graph.
    const [manualNode] = await f.q<{ label_override: string }>(sql`SELECT label_override FROM topology_nodes WHERE id=${f.nodes.manualA}::uuid`);
    expect(manualNode!.label_override).toBe(renamed);
    expect((await positions(f)).find(p => p.node_id === f.nodes.manualA)).toMatchObject({ x: PHYSICAL_FIXTURE.manual.pin.x + 25, pinned: true });
    expect((await positions(f)).find(p => p.node_id === f.nodes.agent)).toMatchObject({ ...moved, pinned: true });
    const [legacyManual] = await getTestDb().execute<{ deleted: boolean }>(sql`SELECT deleted_at IS NOT NULL AS deleted FROM topology_relationships
      WHERE org_id=${f.scope.orgId}::uuid AND legacy_source_id=${f.ids.manualEdge}::uuid`);
    expect(legacyManual!.deleted).toBe(true);
    const on = await graph(env, 'view=physical&limit=500');
    const visible = on.relationships.map(r => r.id);
    for (const id of [...links, manual.id]) expect(visible).toContain(id);
    const [v2] = await f.q<{ deleted: boolean; evidence_class: string }>(sql`SELECT deleted_at IS NOT NULL AS deleted, evidence_class FROM topology_relationships WHERE id=${manual.id}::uuid`);
    expect(v2).toMatchObject({ deleted: false, evidence_class: 'manual' });

    // Reads never dispatch: count every command/job/diagnostic row created across ALL reads above plus a final burst.
    const beforeReads = await sideEffects(f);
    for (const view of ['overview', 'physical', 'logical']) await graph(env, `view=${view}&limit=500`);
    for (const id of links) { await detail(env, id); await read(env, `relationships/${id}/evidence`, (v) => v); }
    await read(env, 'exclusions?view=physical', (v) => v); await read(env, 'nodes?limit=100', (v) => v);
    const afterReads = await sideEffects(f);
    expect(afterReads).toEqual(beforeReads);
    // Everything that ran since the fixture started: only the one discovery job the fixture itself dispatched.
    const readTriggeredCommands = (Number(afterReads.commands) - Number(effectsAtStart.commands)) + (Number(afterReads.runs) - Number(effectsAtStart.runs))
      + (Number(afterReads.jobs) - Number(effectsAtStart.jobs));

    const report = {
      manualParityMismatches: parity.unexplainedManualDifferenceCount,
      pinParityMismatches: parity.unexplainedPinDifferenceCount,
      deletionParityMismatches: parity.resurrectedTombstoneCount,
      undeliveredAtComparisonBarrier: parity.pendingThroughBarrier,
      unchangedCollectionRunInserts,
      readTriggeredCommands,
    };
    console.info(`[physical-enrichment report] ${JSON.stringify({ ...report, barrierRevision: parity.barrierRevision, variants: f.variants })}`);
    if (process.env.TOPOLOGY_PHYSICAL_REPORT) writeFileSync(process.env.TOPOLOGY_PHYSICAL_REPORT, `${JSON.stringify({ ...report, barrierRevision: parity.barrierRevision, variants: f.variants }, null, 2)}\n`);
    expect(report.manualParityMismatches).toBe(0);
    expect(report.pinParityMismatches).toBe(0);
    expect(report.deletionParityMismatches).toBe(0);
    expect(report.undeliveredAtComparisonBarrier).toBe(0);
    expect(report.unchangedCollectionRunInserts).toBe(0);
    expect(report.readTriggeredCommands).toBe(0);
  });


  it('keeps the physical view bounded at G10K scale (1,000 nodes / 2,000 edges visible) with accurate omitted counts', async () => {
    const env = await setupTestEnvironment({ scope: 'organization', rolePermissions: GRANTS });
    const scope = { orgId: env.organization.id, siteId: env.site.id };
    const g = topologyGraphFixture('G10K');
    const test = getTestDb();
    await test.update(organizations).set({ settings: { topologyFeatureFlags: { materialization: true, ui: true, physical: true } } }).where(eq(organizations.id, scope.orgId));
    await test.execute(sql`INSERT INTO topology_site_state (org_id, site_id, graph_revision) VALUES (${scope.orgId}::uuid, ${scope.siteId}::uuid, 1)`);
    const array = (values: string[]) => `{${values.map(v => `"${v.replace(/"/g, '\\"')}"`).join(',')}}`;
    await test.execute(sql`INSERT INTO topology_nodes (id, org_id, site_id, identity_key, identity_material, kind, attributes)
      SELECT n.id, ${scope.orgId}::uuid, ${scope.siteId}::uuid, n.id::text, jsonb_build_object('version', 1, 'kind', n.kind, 'sourceKey', n.id::text), n.kind, jsonb_build_object('label', n.label)
      FROM unnest(${array(g.nodes.map(n => n.id))}::uuid[], ${array(g.nodes.map(n => n.kind))}::text[], ${array(g.nodes.map(n => n.label))}::text[]) AS n(id, kind, label)`);
    // Rich physical data: physical_link rows are measured LLDP cables, attachments are FDB candidates.
    await test.execute(sql`INSERT INTO topology_relationships (id, org_id, site_id, canonical_key, identity_material, kind, source_node_id, target_node_id,
        directness, confidence, evidence_class, support_count, last_supported_at, attributes)
      SELECT r.id, ${scope.orgId}::uuid, ${scope.siteId}::uuid, r.id::text, jsonb_build_object('version', 1, 'kind', r.kind, 'sourceKey', r.id::text), r.kind, r.s, r.t,
        CASE r.kind WHEN 'physical_link' THEN 'direct' ELSE 'unknown' END, CASE r.kind WHEN 'attachment' THEN 'low' ELSE 'high' END,
        CASE r.kind WHEN 'attachment' THEN 'inferred' ELSE 'observed' END, 4, now(),
        CASE r.kind WHEN 'physical_link' THEN '{"method":"lldp","physical":{"resolution":"resolved"}}'::jsonb
          WHEN 'attachment' THEN '{"method":"fdb","physical":{"resolution":"resolved","fdbSelection":"selected"}}'::jsonb ELSE '{}'::jsonb END
      FROM unnest(${array(g.edges.map(e => e.id))}::uuid[], ${array(g.edges.map(e => e.kind))}::text[], ${array(g.edges.map(e => e.sourceNodeId))}::uuid[],
        ${array(g.edges.map(e => e.targetNodeId))}::uuid[]) AS r(id, kind, s, t)`);
    // A bulk load leaves the planner without statistics; a real site's tables are auto-analyzed as they grow.
    await test.execute(sql`ANALYZE topology_nodes, topology_relationships`);
    const physicalEdges = g.edges.filter(e => e.kind === 'physical_link' || e.kind === 'attachment');
    const physicalNodes = new Set(physicalEdges.flatMap(e => [e.sourceNodeId, e.targetNodeId]));
    expect(physicalEdges).toHaveLength(4_000);

    const view = await graph(env, 'view=physical&limit=1000');
    expect(view.nodes).toHaveLength(1_000);
    expect(view.relationships.length).toBeGreaterThan(0);
    expect(view.relationships.length).toBeLessThanOrEqual(2_000);
    expect(view.relationships.every(r => r.kind === 'physical_link' || r.kind === 'attachment')).toBe(true);
    const shown = new Set(view.nodes.map(n => n.id));
    expect(view.relationships.every(r => shown.has(r.sourceNodeId) && shown.has(r.targetNodeId))).toBe(true);
    // Omitted counts are exact, not estimates: totals equal the fixture's own physical sub-graph.
    expect(view.counts).toEqual({
      totalNodes: physicalNodes.size, visibleNodes: 1_000, omittedNodes: physicalNodes.size - 1_000,
      totalRelationships: physicalEdges.length, visibleRelationships: view.relationships.length, omittedRelationships: physicalEdges.length - view.relationships.length,
    });
    expect(view.frontier.length).toBeGreaterThan(0);
    const overview = await graph(env, 'view=overview&limit=1000');
    expect(overview.counts).toMatchObject({ totalNodes: 10_000, visibleNodes: 1_000, omittedNodes: 9_000, totalRelationships: 20_000 });
    expect(overview.relationships.length).toBeLessThanOrEqual(2_000);
    expect(overview.counts.omittedRelationships).toBe(20_000 - overview.relationships.length);
  }, 120_000);

});
