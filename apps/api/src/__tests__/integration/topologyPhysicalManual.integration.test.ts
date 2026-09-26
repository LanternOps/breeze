import './setup';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { LldpRow, PhysicalInterfaceRow } from '@breeze/shared';
import { closeDb, withDbAccessContext, withDbTransaction } from '../../db';
import { createTopologyRoutes } from '../../routes/topology';
import { alerts, auditLogs, deviceCommands, organizations, topologyChangeOutbox, topologyInterfaces, topologyNodes, topologyRelationshipSupport, topologyRelationships, topologySiteState, topologyViewExclusions } from '../../db/schema';
import { negotiateTopologyContext, registerTopologyProducerAuthority, resolveTopologyPhysicalProducer } from '../../services/topology/collectionAuthority';
import { ingestTopologySourceReport } from '../../services/topology/collectionIngest';
import { drainTopologyOutbox, importLegacyTopologySite } from '../../services/topology/legacyImport';
import { compareLegacyTopology } from '../../services/topology/legacyParity';
import { reconcileTopologySite } from '../../services/topology/reconcile';
import { loadActiveExclusions } from '../../services/topology/exclusions';
import { canonicalIdentityKey } from '../../services/topology/identity';
import type { AdjacencyTopologySnapshot, AuthenticatedTopologyProducer } from '../../services/topology/collectionTypes';
import { createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';
import { orgContext } from './topology-fixtures';
import { getTestDb } from './setup';

afterAll(() => closeDb());

/**
 * M2 Task 8 (amendments D6 + D17) through the real routes, real auth
 * middleware and a canonical physical link produced by the real M1/M2
 * ingest → reconcile path (independent per-source support rows).
 */
const IP = { A: '192.0.2.1', B: '192.0.2.2' } as const;
type Sw = keyof typeof IP;
const auth = (sw: Sw) => `snmp:${IP[sw]}`;
const mac = (sw: Sw, port: number) => `02:00:00:0${sw === 'A' ? 1 : 2}:00:0${port}`;
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const lldp = (port: number, chassisMac: string, remotePort: number): LldpRow => ({
  rowKey: `${port}.1`, timeMark: 100, remoteIndex: 1, localPort: { namespace: 'lldp_local', value: String(port), resolvedInterfaceKey: `name:Gi0/${port}` },
  remoteChassis: { subtype: 'mac_address', value: chassisMac }, remotePort: { subtype: 'interface_name', value: `Gi0/${remotePort}` },
});
const iface = (port: number, physAddress: string): PhysicalInterfaceRow => ({
  rowKey: String(port), interfaceKey: `name:Gi0/${port}`, ifIndex: port, ifName: `Gi0/${port}`, ifAlias: null, physAddress, lldpLocalPort: port, bridgePort: port,
});
const grants = [{ resource: 'topology', action: 'read' }, { resource: 'topology', action: 'write' }, { resource: 'devices', action: 'read' }];
const app = new Hono().route('/topology', createTopologyRoutes());

let unregister: (() => void) | undefined;
beforeEach(() => {
  unregister = registerTopologyProducerAuthority('discovery', async request =>
    Object.values(IP).some(ip => request.authorityKey === `snmp:${ip}`) ? { authorized: true, configurationGeneration: 'gen-1' } : { authorized: false, reason: 'target_not_dispatched' });
});
afterEach(() => { unregister?.(); unregister = undefined; });

async function fixture() {
  const env = await setupTestEnvironment({ scope: 'organization', rolePermissions: grants });
  const scope = { orgId: env.organization.id, siteId: env.site.id };
  const scoped = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(scope.orgId), fn);
  const test = getTestDb();
  await test.update(organizations).set({ settings: { topologyFeatureFlags: { materialization: true, physical: true } } }).where(eq(organizations.id, scope.orgId));
  const collector = randomUUID(); const assets = { A: randomUUID(), B: randomUUID() };
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
  const producers = {} as Record<Sw, AuthenticatedTopologyProducer>;
  for (const sw of ['A', 'B'] as const) producers[sw] = await scoped(() => resolveTopologyPhysicalProducer({ producerKind: 'discovery', deviceId: collector, scope, authorityKey: auth(sw) }));
  const report = async (sw: Sw, section: Record<string, unknown> & { kind: string }, offsetMs: number) => {
    const p = producers[sw]; const rows = (section.rows as unknown[]) ?? [];
    const withoutDigest: Record<string, unknown> = { contextKey: `${auth(sw)}/default`, outcome: 'complete', rowCount: rows.length, ...section };
    const digest = sha([p.sourceIdentity, withoutDigest]);
    const finalSection = { ...withoutDigest, contentDigest: digest } as AdjacencyTopologySnapshot['section'];
    const snapshot: AdjacencyTopologySnapshot = { key: { protocol: finalSection.kind, contextKey: finalSection.contextKey, addressFamily: 'any' }, snapshotId: randomUUID(), producerEpoch: p.producerEpoch,
      sequence: '1', capturedAt: new Date(Date.now() + offsetMs).toISOString(), captureAgeAtSendMs: 0, expectedIntervalSeconds: 3600, contentDigest: digest,
      manifest: { contract: 'adjacency_v2', target: { sourceKey: auth(sw), address: IP[sw], zone: null },
        scopes: [{ kind: finalSection.kind === 'snmp_interfaces' ? 'interfaces' : finalSection.kind as 'lldp', contextKey: 'default', outcome: finalSection.outcome, rowCount: finalSection.rowCount, contentDigest: digest }] },
      section: finalSection };
    const receipt = await scoped(() => ingestTopologySourceReport(p, { reportKind: 'full', snapshot }));
    expect(receipt.accepted, JSON.stringify(receipt)).toBe(true);
  };
  await report('A', { kind: 'snmp_interfaces', rows: [iface(1, mac('A', 1)), iface(5, mac('A', 5))] }, -3_600_000);
  await report('B', { kind: 'snmp_interfaces', rows: [iface(1, mac('B', 1)), iface(7, mac('B', 7))] }, -3_600_000);
  await report('A', { kind: 'lldp', rows: [lldp(1, mac('B', 1), 1)] }, -1_800_000);
  await report('B', { kind: 'lldp', rows: [lldp(1, mac('A', 1), 1)] }, -1_800_000);
  const reconcile = async () => { for (let i = 0; i < 4; i++) { const last = await scoped(() => withDbTransaction(() => reconcileTopologySite(scope))); if (!last.published) break; } };
  await reconcile();
  const [observed] = await test.select().from(topologyRelationships).where(and(eq(topologyRelationships.siteId, scope.siteId), eq(topologyRelationships.kind, 'physical_link'), eq(topologyRelationships.evidenceClass, 'observed')));
  if (!observed) throw new Error('fixture produced no observed physical link');
  expect(observed.supportCount).toBe(2n);
  const nodeOf = async (asset: string) => String((await test.execute<{ node_id: string }>(sql`SELECT node_id FROM topology_node_bindings WHERE discovered_asset_id=${asset}::uuid`))[0]!.node_id);
  const nodes = { A: await nodeOf(assets.A), B: await nodeOf(assets.B) };
  const ifaces = await test.select().from(topologyInterfaces).where(eq(topologyInterfaces.siteId, scope.siteId));
  const port = (sw: Sw, n: number) => ifaces.find(i => i.ownerNodeId === nodes[sw] && i.interfaceKey === `name:Gi0/${n}` && !i.retiredAt)!.id;
  return { env, scope, scoped, test, observed, nodes, port, reconcile };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const call = (env: TestEnvironment, method: string, path: string, body?: unknown) => app.request(`/topology/sites/${env.site.id}/${path}`, {
  method, headers: { Authorization: `Bearer ${env.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const cable = (f: Fixture, a: string | null, b: string | null, extra: Record<string, unknown> = {}) => call(f.env, 'POST', 'manual-relationships', {
  sourceNodeId: f.nodes.A, targetNodeId: f.nodes.B, kind: 'physical_link', ...(a ? { sourceInterfaceId: a } : {}), ...(b ? { targetInterfaceId: b } : {}), ...extra });
const supportSnapshot = (f: Fixture) => f.test.select().from(topologyRelationshipSupport).where(eq(topologyRelationshipSupport.siteId, f.scope.siteId))
  .orderBy(asc(topologyRelationshipSupport.relationshipId), asc(topologyRelationshipSupport.sourceId));
const relationshipRow = async (f: Fixture, id: string) => (await f.test.select().from(topologyRelationships).where(eq(topologyRelationships.id, id)))[0]!;
const graphRevision = async (f: Fixture) => (await f.test.select().from(topologySiteState).where(eq(topologySiteState.siteId, f.scope.siteId)))[0]!.graphRevision;
const audits = (f: Fixture, action: string) => f.test.select().from(auditLogs).where(and(eq(auditLogs.orgId, f.scope.orgId), eq(auditLogs.action, action)));
const parity = (f: Fixture) => f.scoped(async () => { await drainTopologyOutbox(f.scope); return compareLegacyTopology(f.scope); });

describe('manual physical assertions (M2 D6)', () => {
  it('a manual cable on the observed pair is a separate assertion; deleting it leaves the observed link and support identical', async () => {
    const f = await fixture();
    const supportBefore = await supportSnapshot(f);
    const observedBefore = await relationshipRow(f, f.observed.id);
    const created = await cable(f, f.port('A', 1), f.port('B', 1), { label: 'Patch 12' });
    expect(created.status, JSON.stringify(await created.clone().json())).toBe(201);
    const manual = await created.json() as { id: string; legacyId: string | null; revision: string };
    expect(manual.legacyId).toBeNull();
    const row = await relationshipRow(f, manual.id);
    expect(row).toMatchObject({ kind: 'physical_link', evidenceClass: 'manual', confidence: 'asserted', sourceInterfaceId: f.port('A', 1), targetInterfaceId: f.port('B', 1), supportCount: 0n, deletedAt: null });
    expect(row.identityMaterial.sourceKey).toMatch(/^manual-link-v1:/);
    expect(row.canonicalKey).not.toBe(f.observed.canonicalKey);
    // Same cable in the other orientation is a duplicate.
    const reversed = await call(f.env, 'POST', 'manual-relationships', { sourceNodeId: f.nodes.B, targetNodeId: f.nodes.A, kind: 'physical_link', sourceInterfaceId: f.port('B', 1), targetInterfaceId: f.port('A', 1) });
    expect(reversed.status).toBe(409);
    // Publication keeps both the observed link and the manual assertion.
    await f.reconcile();
    expect((await relationshipRow(f, manual.id)).deletedAt).toBeNull();
    const deleted = await call(f.env, 'DELETE', `manual-relationships/${manual.id}`, { expectedRevision: manual.revision });
    expect(deleted.status, JSON.stringify(await deleted.clone().json())).toBe(200);
    expect(await relationshipRow(f, f.observed.id)).toEqual(observedBefore);
    expect(await supportSnapshot(f)).toEqual(supportBefore);
    expect(await audits(f, 'topology.relationship.created')).toHaveLength(1);
    expect(await audits(f, 'topology.relationship.deleted')).toHaveLength(1);
    // Recreate after delete: a new generation, no collision with the retained tombstone.
    const recreated = await cable(f, f.port('A', 1), f.port('B', 1));
    expect(recreated.status, JSON.stringify(await recreated.clone().json())).toBe(201);
    const second = await recreated.json() as { id: string };
    expect(second.id).not.toBe(manual.id);
    expect((await relationshipRow(f, manual.id)).deletedAt).not.toBeNull();
    const parityReport = await parity(f);
    expect(parityReport).toMatchObject({ pendingThroughBarrier: 0, unexplainedManualDifferenceCount: 0, unexplainedPinDifferenceCount: 0, resurrectedTombstoneCount: 0 });
  });

  it('allows parallel cables on different ports and keeps unknown-port assertions distinct', async () => {
    const f = await fixture();
    expect((await cable(f, f.port('A', 1), f.port('B', 1))).status).toBe(201);
    expect((await cable(f, f.port('A', 5), f.port('B', 7))).status).toBe(201);
    const unknown = await cable(f, null, null);
    expect(unknown.status).toBe(201);
    expect((await cable(f, null, null)).status).toBe(409);
    expect((await cable(f, f.port('A', 5), null)).status).toBe(201);
    const manual = await f.test.select().from(topologyRelationships).where(and(eq(topologyRelationships.siteId, f.scope.siteId), eq(topologyRelationships.evidenceClass, 'manual'), isNull(topologyRelationships.deletedAt)));
    expect(manual).toHaveLength(4);
    expect(new Set(manual.map(r => r.canonicalKey)).size).toBe(4);
    const unknownRow = manual.find(r => r.sourceInterfaceId === null && r.targetInterfaceId === null)!;
    expect(unknownRow.canonicalKey).not.toBe(f.observed.canonicalKey);
    expect(f.observed.sourceInterfaceId).not.toBeNull();
  });

  it('projects only a port-less attachment to legacy; port-bearing assertions stay v2-only', async () => {
    const f = await fixture();
    const legacy = await call(f.env, 'POST', 'manual-relationships', { sourceNodeId: f.nodes.A, targetNodeId: f.nodes.B, kind: 'attachment' });
    expect(legacy.status).toBe(201); const legacyBody = await legacy.json() as { id: string; legacyId: string | null; revision: string };
    expect(legacyBody.legacyId).not.toBeNull();
    const v2Only = await call(f.env, 'POST', 'manual-relationships', { sourceNodeId: f.nodes.A, targetNodeId: f.nodes.B, kind: 'attachment', sourceInterfaceId: f.port('A', 5) });
    expect(v2Only.status).toBe(201); expect((await v2Only.json()).legacyId).toBeNull();
    expect(await parity(f)).toMatchObject({ pendingThroughBarrier: 0, unexplainedManualDifferenceCount: 0, resurrectedTombstoneCount: 0 });
    expect((await call(f.env, 'DELETE', `manual-relationships/${legacyBody.id}`, { expectedRevision: legacyBody.revision })).status).toBe(200);
    expect(await parity(f)).toMatchObject({ pendingThroughBarrier: 0, unexplainedManualDifferenceCount: 0, resurrectedTombstoneCount: 0 });
    // Legacy-backed recreate uses a fresh legacy row id.
    expect((await call(f.env, 'POST', 'manual-relationships', { sourceNodeId: f.nodes.A, targetNodeId: f.nodes.B, kind: 'attachment' })).status).toBe(201);
  });

  it('rejects an interface from another endpoint, another site or a retired generation without writing', async () => {
    const f = await fixture();
    const before = await f.test.select().from(topologyRelationships).where(eq(topologyRelationships.siteId, f.scope.siteId));
    const revision = await graphRevision(f);
    // Owner mismatch: B's port offered as A's.
    const owner = await cable(f, f.port('B', 7), f.port('B', 1));
    expect(owner.status).toBe(404); expect(await owner.json()).toMatchObject({ code: 'topology_entity_not_found' });
    // Same-org other site.
    const other = await createSite({ orgId: f.scope.orgId });
    const foreignNode = randomUUID(); const foreignIface = randomUUID();
    await f.test.insert(topologyNodes).values({ id: foreignNode, orgId: f.scope.orgId, siteId: other.id, kind: 'endpoint', identityKey: canonicalIdentityKey({ orgId: f.scope.orgId, siteId: other.id }, 'endpoint', `inventory:${foreignNode}`), identityMaterial: { version: 1, kind: 'endpoint', sourceKey: `inventory:${foreignNode}` } });
    await f.test.insert(topologyInterfaces).values({ id: foreignIface, orgId: f.scope.orgId, siteId: other.id, ownerNodeId: foreignNode, interfaceKey: 'name:Gi0/9', epoch: 'gen:1' });
    expect((await cable(f, foreignIface, f.port('B', 1))).status).toBe(404);
    // Retired generation.
    await f.test.update(topologyInterfaces).set({ retiredAt: new Date() }).where(eq(topologyInterfaces.id, f.port('A', 5)));
    expect((await cable(f, f.port('A', 5), f.port('B', 7))).status).toBe(404);
    expect(await f.test.select().from(topologyRelationships).where(eq(topologyRelationships.siteId, f.scope.siteId))).toEqual(before);
    expect(await graphRevision(f)).toBe(revision);
  });
});

describe('reversible view exclusions (M2 D17)', () => {
  it('hides a relationship in one view only, changes no evidence and restores through revoke', async () => {
    const f = await fixture();
    const supportBefore = await supportSnapshot(f);
    const observedBefore = await relationshipRow(f, f.observed.id);
    const outboxBefore = await f.test.select().from(topologyChangeOutbox).where(eq(topologyChangeOutbox.siteId, f.scope.siteId));
    const commandsBefore = await f.test.select().from(deviceCommands);
    const alertsBefore = await f.test.select().from(alerts);
    const revision = await graphRevision(f);
    const hidden = await call(f.env, 'POST', `relationships/${f.observed.id}/exclusions`, { view: 'physical', reason: 'Port mapping awaiting verification' });
    expect(hidden.status, JSON.stringify(await hidden.clone().json())).toBe(201);
    const { id: exclusionId, graphRevision: hiddenRevision } = await hidden.json() as { id: string; graphRevision: string };
    expect(BigInt(hiddenRevision)).toBe(revision + 1n);
    expect(await f.scoped(() => loadActiveExclusions(f.scope, 'physical'))).toEqual(new Set([f.observed.id]));
    expect(await f.scoped(() => loadActiveExclusions(f.scope, 'overview'))).toEqual(new Set());
    const listed = await call(f.env, 'GET', 'exclusions?view=physical');
    expect(listed.status, JSON.stringify(await listed.clone().json())).toBe(200);
    expect(await listed.json()).toMatchObject({ view: 'physical', graphRevision: hiddenRevision, nextCursor: null,
      items: [{ id: exclusionId, relationshipId: f.observed.id, reason: 'Port mapping awaiting verification', active: true, relationship: { id: f.observed.id, kind: 'physical_link', evidenceClass: 'observed' } }] });
    expect((await (await call(f.env, 'GET', 'exclusions?view=overview')).json()).items).toEqual([]);
    // Active uniqueness: a duplicate is a conflict and neither revises nor audits.
    const duplicate = await call(f.env, 'POST', `relationships/${f.observed.id}/exclusions`, { view: 'physical', reason: 'Again' });
    expect(duplicate.status).toBe(409);
    expect(await graphRevision(f)).toBe(BigInt(hiddenRevision));
    expect(await audits(f, 'topology.exclusion.created')).toHaveLength(1);
    // A different view is independent.
    expect((await call(f.env, 'POST', `relationships/${f.observed.id}/exclusions`, { view: 'overview', reason: 'Clutter' })).status).toBe(201);
    const restored = await call(f.env, 'DELETE', `relationships/${f.observed.id}/exclusions/${exclusionId}`);
    expect(restored.status, JSON.stringify(await restored.clone().json())).toBe(200);
    expect(await restored.json()).toMatchObject({ id: exclusionId, active: false });
    expect(await f.scoped(() => loadActiveExclusions(f.scope, 'physical'))).toEqual(new Set());
    expect(await f.scoped(() => loadActiveExclusions(f.scope, 'overview'))).toEqual(new Set([f.observed.id]));
    expect((await call(f.env, 'DELETE', `relationships/${f.observed.id}/exclusions/${exclusionId}`)).status).toBe(409);
    const [history] = await f.test.select().from(topologyViewExclusions).where(eq(topologyViewExclusions.id, exclusionId));
    expect(history).toMatchObject({ revokedBy: f.env.user.id, createdBy: f.env.user.id });
    expect(history!.revokedAt).not.toBeNull();
    expect(await audits(f, 'topology.exclusion.revoked')).toHaveLength(1);
    // Nothing but presentation state changed.
    expect(await supportSnapshot(f)).toEqual(supportBefore);
    expect(await relationshipRow(f, f.observed.id)).toEqual(observedBefore);
    expect(await f.test.select().from(topologyChangeOutbox).where(eq(topologyChangeOutbox.siteId, f.scope.siteId))).toEqual(outboxBefore);
    expect(await f.test.select().from(deviceCommands)).toEqual(commandsBefore);
    expect(await f.test.select().from(alerts)).toEqual(alertsBefore);
  });

  it('pages hidden connections with a revision-bound cursor', async () => {
    const f = await fixture();
    const ids = [f.observed.id];
    for (const [a, b] of [[f.port('A', 5), f.port('B', 7)], [null, null]] as const) ids.push((await (await cable(f, a, b)).json() as { id: string }).id);
    for (const id of ids) expect((await call(f.env, 'POST', `relationships/${id}/exclusions`, { view: 'logical', reason: `hide ${id}` })).status).toBe(201);
    const first = await (await call(f.env, 'GET', 'exclusions?view=logical&limit=2')).json() as { items: { relationshipId: string }[]; nextCursor: string };
    expect(first.items).toHaveLength(2); expect(first.nextCursor).toEqual(expect.any(String));
    const second = await (await call(f.env, 'GET', `exclusions?view=logical&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).json() as { items: { relationshipId: string }[]; nextCursor: string | null };
    expect(second.items).toHaveLength(1); expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map(i => i.relationshipId))).toEqual(new Set(ids));
    // A graph revision change invalidates the cursor.
    expect((await call(f.env, 'POST', `relationships/${f.observed.id}/exclusions`, { view: 'overview', reason: 'x' })).status).toBe(201);
    expect((await call(f.env, 'GET', `exclusions?view=logical&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).status).toBe(409);
  });

  it('never reaches another tenant or site relationship', async () => {
    const f = await fixture();
    const intruder = await setupTestEnvironment({ scope: 'organization', rolePermissions: grants });
    await getTestDb().update(organizations).set({ settings: { topologyFeatureFlags: { materialization: true, physical: true } } }).where(eq(organizations.id, intruder.organization.id));
    await withDbAccessContext(orgContext(intruder.organization.id), () => importLegacyTopologySite({ orgId: intruder.organization.id, siteId: intruder.site.id }));
    expect((await call(intruder, 'POST', `relationships/${f.observed.id}/exclusions`, { view: 'overview', reason: 'x' })).status).toBe(404);
    // The victim site itself is hidden from the intruder.
    const direct = await app.request(`/topology/sites/${f.env.site.id}/relationships/${f.observed.id}/exclusions`, { method: 'POST', headers: { Authorization: `Bearer ${intruder.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ view: 'overview', reason: 'x' }) });
    expect(direct.status).toBe(404);
    expect(await getTestDb().select().from(topologyViewExclusions)).toHaveLength(0);
  });
});
