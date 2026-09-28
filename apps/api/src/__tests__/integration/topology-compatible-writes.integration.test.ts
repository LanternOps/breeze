import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { closeDb, db, withDbAccessContext } from '../../db';
import type { AuthContext } from '../../middleware/auth';
import { createTopologyRoutes } from '../../routes/topology';
import { discoveryRoutes } from '../../routes/discovery';
import { importLegacyTopologySite, drainTopologyOutbox, compareLegacyTopology } from '../../services/topology/legacyImport';
import { canonicalIdentityKey } from '../../services/topology/identity';
import { topologyNodes, topologyRelationships, topologySiteState, topologyManualNodes, topologyLayout, topologyLayouts, topologyNodePositions, topologyChangeOutbox, organizationUsers, organizations, auditLogs } from '../../db/schema';
import { clearPermissionCache, type UserPermissions } from '../../services/permissions';
import { withTopologyWrite } from '../../services/topology/writes';
import type { TopologyRequestContext } from '../../services/topology/access';
import { createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';
import { orgContext } from './topology-fixtures';
import { getTestDb } from './setup';

afterAll(() => closeDb());

const grants = [{ resource: 'topology', action: 'read' }, { resource: 'topology', action: 'write' }, { resource: 'devices', action: 'read' }];
const app = new Hono().route('/topology', createTopologyRoutes()).route('/discovery', discoveryRoutes);
const scope = (env: TestEnvironment) => ({ orgId: env.organization.id, siteId: env.site.id });
const state = async (env: TestEnvironment) => (await getTestDb().select().from(topologySiteState).where(eq(topologySiteState.siteId, env.site.id)))[0]!;
const request = (env: TestEnvironment, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { Authorization: `Bearer ${env.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const v2 = (env: TestEnvironment, method: string, path: string, body?: unknown) => request(env, method, `/topology/sites/${env.site.id}/${path}`, body);
async function fixture(ready = true) {
  const env = await setupTestEnvironment({ scope: 'organization', rolePermissions: grants });
  await getTestDb().update(organizations).set({ settings: { topologyFeatureFlags: { materialization: true } } }).where(eq(organizations.id, env.organization.id));
  if (ready) await withDbAccessContext(orgContext(env.organization.id), () => importLegacyTopologySite(scope(env)));
  return env;
}
async function createNode(env: TestEnvironment, label = 'Router') {
  const response = await v2(env, 'POST', 'manual-nodes', { label, role: 'router', notes: 'Keep this note' });
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
  return await response.json() as { id: string; legacyId: string; revision: string; graphRevision: string };
}
const position = (nodeId: string, x = 10, pinned = true) => ({ nodeId, x, y: 20, pinned });
async function layout(env: TestEnvironment, expectedRevision: string, positions: ReturnType<typeof position>[], view = 'overview') {
  return v2(env, 'PATCH', `layouts/${view}`, { expectedRevision, positions });
}

describe('manual/layout compatibility writes — real request RLS and atomic replay', () => {
  it('requires explicit import for v2 but preserves capture-only legacy clients', async () => {
    const env = await fixture(false);
    const rejected = await v2(env, 'POST', 'manual-nodes', { label: 'Not created', role: 'router' });
    expect(rejected.status).toBe(409);
    expect(await getTestDb().select().from(topologyManualNodes)).toHaveLength(0);
    const old = await request(env, 'POST', '/discovery/topology/manual-node', { siteId: env.site.id, label: 'Legacy', role: 'switch' });
    expect(old.status, JSON.stringify(await old.clone().json())).toBe(201);
    expect(await getTestDb().select().from(topologyNodes)).toHaveLength(0);
    expect((await getTestDb().select().from(topologyChangeOutbox))).toHaveLength(1);
    expect((await state(env)).materializedInputRevision).toBe(0n);
  });

  it('imports populated legacy snapshots and keeps v2 prefix metadata across advancing legacy edits', async () => {
    const env = await fixture(false);
    const old = await request(env, 'POST', '/discovery/topology/manual-node', { siteId: env.site.id, label: 'Existing switch', role: 'switch', notes: 'Existing note' });
    expect(old.status).toBe(201); const legacy = await old.json() as { id: string };
    await getTestDb().insert(topologyLayout).values({ ...scope(env), nodeType: 'manual_node', nodeId: legacy.id, x: 2, y: 3, pinned: true });
    const imported = await withDbAccessContext(orgContext(env.organization.id), () => importLegacyTopologySite(scope(env)));
    expect(imported.complete).toBe(true); expect(imported.counts.manual).toBeGreaterThan(0); expect(imported.counts.pin).toBeGreaterThan(0);
    expect((await getTestDb().select().from(topologyNodes))[0]).toMatchObject({ labelOverride: 'Existing switch', attributes: { notes: 'Existing note' } });
    expect((await getTestDb().select().from(topologyNodePositions))[0]).toMatchObject({ x: 2, y: 3, pinned: true });
    const created = await v2(env, 'POST', 'manual-nodes', { label: 'Subnet gear', role: 'router', prefix: '192.0.2.0/24' });
    expect(created.status).toBe(201); const node = await created.json() as { id: string; legacyId: string };
    await getTestDb().update(topologyManualNodes).set({ label: 'Legacy rename' }).where(eq(topologyManualNodes.id, node.legacyId));
    await withDbAccessContext(orgContext(env.organization.id), () => drainTopologyOutbox(scope(env)));
    expect((await getTestDb().select().from(topologyNodes).where(eq(topologyNodes.id, node.id)))[0]).toMatchObject({ labelOverride: 'Legacy rename', attributes: { prefix: '192.0.2.0/24', addressFamily: 4 } });
  });

  it('preserves canonical/legacy identity and one structural revision per edit', async () => {
    const env = await fixture(); const before = await state(env); const node = await createNode(env);
    expect((await state(env)).graphRevision).toBe(before.graphRevision + 1n);
    const changed = await v2(env, 'PATCH', `manual-nodes/${node.id}`, { expectedRevision: node.revision, label: 'Renamed' });
    expect(changed.status).toBe(200);
    expect((await changed.json()).revision).toBe('2');
    expect((await getTestDb().select().from(topologyManualNodes))[0]!.label).toBe('Renamed');
    expect((await getTestDb().select().from(topologyNodes))[0]).toMatchObject({ id: node.id, labelOverride: 'Renamed', revision: 2n });
    expect((await state(env)).graphRevision).toBe(before.graphRevision + 2n);
    expect((await state(env)).materializedInputRevision).toBe((await state(env)).dirtyRevision);
    expect(await getTestDb().select().from(topologyChangeOutbox).where(isNull(topologyChangeOutbox.deliveredAt))).toHaveLength(0);
    const stale = await v2(env, 'PATCH', `manual-nodes/${node.id}`, { expectedRevision: '1', label: 'Lost edit' });
    expect(stale.status).toBe(409); expect((await stale.json()).currentRevision).toBe('2');
  });

  it('serializes two editors: exactly one layout CAS wins with no partial positions', async () => {
    const env = await fixture(); const a = await createNode(env); const b = await createNode(env, 'Switch'); const structural = (await state(env)).graphRevision;
    const responses = await Promise.all([layout(env, '0', [position(a.id, 1), position(b.id, 2)]), layout(env, '0', [position(a.id, 30), position(b.id, 40)])]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    const rows = await getTestDb().select().from(topologyNodePositions);
    const first = rows.find(r => r.nodeId === a.id)!; const second = rows.find(r => r.nodeId === b.id)!;
    expect([[1, 2], [30, 40]]).toContainEqual([first.x, second.x]);
    expect((await getTestDb().select().from(topologyLayouts))[0]!.revision).toBe(1n);
    expect((await state(env)).graphRevision).toBe(structural);
    expect(rows.every(r => r.positionSource === 'user' && r.revision === 1n)).toBe(true);
  });

  it('validates every batch member before changing any position or revision', async () => {
    const env = await fixture(); const a = await createNode(env); expect((await layout(env, '0', [position(a.id)])).status).toBe(200);
    const other = await fixture(); const foreign = await createNode(other);
    const rejected = await layout(env, '1', [position(a.id, 99), position(foreign.id)]);
    expect(rejected.status).toBe(404);
    const own = await getTestDb().select().from(topologyNodePositions).where(eq(topologyNodePositions.siteId, env.site.id));
    expect(own).toHaveLength(1); expect(own[0]!.x).toBe(10);
    expect((await getTestDb().select().from(topologyLayouts).where(eq(topologyLayouts.siteId, env.site.id)))[0]!.revision).toBe(1n);
  });

  it('explicit unpin retains coordinates, returns only accepted rows, and never writes another view to legacy', async () => {
    const env = await fixture(); const a = await createNode(env); const b = await createNode(env, 'Switch');
    expect((await layout(env, '0', [position(a.id), position(b.id)])).status).toBe(200);
    const unpin = await layout(env, '1', [position(a.id, 10, false)]);
    expect(unpin.status).toBe(200); expect(await unpin.json()).toMatchObject({ layoutRevision: '2', positions: [{ nodeId: a.id, x: 10, y: 20, pinned: false, source: 'user', rowRevision: '2' }] });
    expect((await layout(env, '0', [position(a.id, 700)], 'physical')).status).toBe(200);
    const legacy = await getTestDb().select().from(topologyLayout).where(eq(topologyLayout.nodeId, a.legacyId));
    expect(legacy[0]).toMatchObject({ x: 10, y: 20, pinned: false });
    const rows = await getTestDb().select().from(topologyNodePositions);
    expect(rows).toHaveLength(3); expect(rows.find(r => r.nodeId === b.id)?.pinned).toBe(true);
  });

  it('replays revisionless legacy edits immediately for ready sites without automatic backfill', async () => {
    const env = await fixture(); const node = await createNode(env);
    const response = await request(env, 'PATCH', '/discovery/topology/layout', { siteId: env.site.id, positions: [{ nodeType: 'manual_node', nodeId: node.legacyId, x: 70, y: 80 }] });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(await response.json()).toEqual({ upserted: 1 });
    expect((await getTestDb().select().from(topologyNodePositions))[0]).toMatchObject({ nodeId: node.id, x: 70, y: 80, pinned: true });
    const oldNode = await request(env, 'POST', '/discovery/topology/manual-node', { siteId: env.site.id, label: 'Old client switch', role: 'switch' });
    expect(oldNode.status).toBe(201);
    const second = await oldNode.json() as { id: string };
    const edge = await request(env, 'POST', '/discovery/topology/manual-edge', { siteId: env.site.id, source: { type: 'manual_node', id: node.legacyId }, target: { type: 'manual_node', id: second.id } });
    expect(edge.status, JSON.stringify(await edge.clone().json())).toBe(201);
    expect((await getTestDb().select().from(topologyRelationships))[0]).toMatchObject({ evidenceClass: 'manual', confidence: 'asserted' });
    expect((await state(env)).dirtyRevision).toBe((await state(env)).materializedInputRevision);
  });

  it('rejects same-org other-site legacy positions and preserves the original layout', async () => {
    const env = await fixture(); const node = await createNode(env); const otherSite = await createSite({ orgId: env.organization.id });
    const [foreign] = await getTestDb().insert(topologyManualNodes).values({ orgId: env.organization.id, siteId: otherSite.id, label: 'Other site', role: 'switch' }).returning();
    const response = await request(env, 'PATCH', '/discovery/topology/layout', { siteId: env.site.id, positions: [{ nodeType: 'manual_node', nodeId: node.legacyId, x: 10, y: 10 }, { nodeType: 'manual_node', nodeId: foreign!.id, x: 20, y: 20 }] });
    expect(response.status).toBe(404); expect(await getTestDb().select().from(topologyLayout)).toHaveLength(0);
  });

  it('keeps manual/observed supports separate and preserves v2-only relationships during rollback', async () => {
    const env = await fixture(); const a = await createNode(env); const b = await createNode(env, 'Switch');
    const edge = await v2(env, 'POST', 'manual-relationships', { sourceNodeId: a.id, targetNodeId: b.id, kind: 'attachment', label: 'Uplink', notes: 'Asserted by operator' });
    expect(edge.status).toBe(201); const manual = await edge.json() as { id: string; legacyId: string; revision: string };
    expect((await getTestDb().select().from(topologyRelationships).where(eq(topologyRelationships.id, manual.id)))[0]!.attributes).toMatchObject({ label: 'Uplink', notes: 'Asserted by operator' });
    const observedId = randomUUID(); const sourceKey = `collector:${observedId}`;
    await getTestDb().insert(topologyRelationships).values({ ...scope(env), id: observedId, canonicalKey: canonicalIdentityKey(scope(env), 'attachment', sourceKey), identityMaterial: { version: 1, kind: 'attachment', sourceKey }, kind: 'attachment', sourceNodeId: a.id, targetNodeId: b.id, evidenceClass: 'observed', confidence: 'high', supportCount: 1n });
    expect((await v2(env, 'DELETE', `manual-relationships/${manual.id}`, { expectedRevision: manual.revision })).status).toBe(200);
    expect((await getTestDb().select().from(topologyRelationships).where(eq(topologyRelationships.id, observedId)))[0]!.deletedAt).toBeNull();
    expect((await v2(env, 'DELETE', `manual-relationships/${observedId}`, { expectedRevision: '0' })).status).toBe(404);
    const synthetic = await v2(env, 'POST', 'manual-relationships', { sourceNodeId: a.id, targetNodeId: b.id, kind: 'network_member', notes: 'Retain on rollback' });
    expect(synthetic.status).toBe(201); const syntheticBody = await synthetic.json() as { id: string; legacyId: string | null }; expect(syntheticBody.legacyId).toBeNull();
    expect((await v2(env, 'POST', 'manual-relationships', { sourceNodeId: a.id, targetNodeId: b.id, kind: 'network_member' })).status).toBe(409);
    expect((await getTestDb().select().from(topologyRelationships).where(and(eq(topologyRelationships.kind, 'network_member'), isNull(topologyRelationships.deletedAt))))).toHaveLength(1);
    await getTestDb().update(organizations).set({ settings: { topologyFeatureFlags: { materialization: false } } }).where(eq(organizations.id, env.organization.id));
    expect((await getTestDb().select().from(topologyRelationships).where(and(eq(topologyRelationships.kind, 'network_member'), isNull(topologyRelationships.deletedAt))))).toHaveLength(1);
    const retainedRead = await v2(env, 'GET', `relationships/${syntheticBody.id}`);
    expect(retainedRead.status).toBe(200); expect(await retainedRead.json()).toMatchObject({ relationship: { id: syntheticBody.id, kind: 'network_member' } });
    expect((await state(env)).dirtyRevision).toBe((await state(env)).materializedInputRevision);
  });

  it.each(['legacy', 'v2'] as const)('tombstones all manual dependencies and pins with fences and audit on %s node deletion', async source => {
    const env = await fixture(); const a = await createNode(env); const b = await createNode(env, 'Switch');
    const relationship = await v2(env, 'POST', 'manual-relationships', { sourceNodeId: a.id, targetNodeId: b.id, kind: 'network_member' });
    expect(relationship.status).toBe(201); const rel = await relationship.json() as { id: string };
    expect((await layout(env, '0', [position(a.id)])).status).toBe(200);
    expect((await layout(env, '0', [position(a.id, 300)], 'logical')).status).toBe(200);
    const response = source === 'legacy'
      ? await request(env, 'DELETE', `/discovery/topology/manual-node/${a.legacyId}`)
      : await v2(env, 'DELETE', `manual-nodes/${a.id}`, { expectedRevision: a.revision });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    const [node] = await getTestDb().select().from(topologyNodes).where(eq(topologyNodes.id, a.id));
    expect(node!.deletedAt).not.toBeNull(); expect(node!.legacySourceRevision).toBeGreaterThan(0n);
    expect((await getTestDb().select().from(topologyRelationships).where(eq(topologyRelationships.id, rel.id)))[0]!.deletedAt).not.toBeNull();
    expect((await getTestDb().select().from(topologyNodePositions)).every(p => p.deletedAt !== null && p.legacySourceRevision !== null)).toBe(true);
    expect(await getTestDb().select().from(auditLogs).where(and(eq(auditLogs.resourceId, a.id), eq(auditLogs.action, 'topology.node.deleted')))).toHaveLength(1);
  });

  it('forbids measured-node deletion and hides an unknown interface binding as not found', async () => {
    const env = await fixture(); const a = await createNode(env); const b = await createNode(env);
    const rejected = await v2(env, 'POST', 'manual-relationships', { sourceNodeId: a.id, targetNodeId: b.id, kind: 'physical_link', sourceInterfaceId: randomUUID() });
    expect(rejected.status).toBe(404); expect(await rejected.json()).toMatchObject({ code: 'topology_entity_not_found' });
    expect(await getTestDb().select().from(topologyRelationships)).toHaveLength(0);
    const sourceKey = `inventory:${randomUUID()}`; const id = randomUUID();
    await getTestDb().insert(topologyNodes).values({ ...scope(env), id, kind: 'endpoint', identityKey: canonicalIdentityKey(scope(env), 'endpoint', sourceKey), identityMaterial: { version: 1, kind: 'endpoint', sourceKey } });
    expect((await v2(env, 'DELETE', `manual-nodes/${id}`, { expectedRevision: '0' })).status).toBe(404);
    expect((await getTestDb().select().from(topologyNodes).where(eq(topologyNodes.id, id)))[0]!.deletedAt).toBeNull();
  });

  it('rolls a late SQL failure back while the authorized outer transaction can continue', async () => {
    const env = await fixture();
    const ctx: TopologyRequestContext = {
      scope: scope(env),
      auth: { user: env.user, scope: 'organization', orgId: env.organization.id, partnerId: env.partner.id, accessibleOrgIds: [env.organization.id], canAccessOrg: (orgId: string) => orgId === env.organization.id } as AuthContext,
      permissions: { permissions: grants, scope: 'organization', partnerId: env.partner.id, orgId: env.organization.id, roleId: env.role.id } as UserPermissions,
    };
    await withDbAccessContext(orgContext(env.organization.id), async () => {
      await expect(withTopologyWrite(ctx, true, async () => {
        await db.insert(topologyLayouts).values({ ...scope(env), view: 'logical' });
        await db.execute(sql`SELECT 1/0`);
      })).rejects.toThrow();
      await db.update(topologySiteState).set({ settingsRevision: 17n }).where(eq(topologySiteState.siteId, env.site.id));
    });
    expect(await getTestDb().select().from(topologyLayouts)).toHaveLength(0);
    expect((await state(env)).settingsRevision).toBe(17n);
  });

  it.each(['organization', 'deployment'] as const)('keeps initialized legacy writes capture-only during %s rollback and drains after reenable', async disabledBy => {
    const env = await fixture(); const node = await createNode(env);
    expect((await layout(env, '0', [position(node.id)])).status).toBe(200);
    const before = await state(env);
    // An older committed edit must remain pending while materialization is off,
    // even when a newer legacy request enters the compatible write adapter.
    await getTestDb().update(topologyManualNodes).set({ label: 'Pending before rollback' }).where(eq(topologyManualNodes.id, node.legacyId));
    const positionsBefore = await getTestDb().select().from(topologyNodePositions);
    if (disabledBy === 'organization') await getTestDb().update(organizations).set({ settings: { topologyFeatureFlags: { materialization: false } } }).where(eq(organizations.id, env.organization.id));
    else vi.stubEnv('TOPOLOGY_DISABLED', 'true');
    try {
      const old = await request(env, 'PATCH', '/discovery/topology/layout', { siteId: env.site.id, positions: [{ nodeType: 'manual_node', nodeId: node.legacyId, x: 90, y: 100 }] });
      expect(old.status).toBe(200);
      const rejected = await v2(env, 'POST', 'manual-nodes', { label: 'Must not create', role: 'router' });
      expect(rejected.status).toBe(409); expect(await rejected.json()).toMatchObject({ code: 'topology_materialization_disabled' });
      expect(await getTestDb().select().from(topologyNodePositions)).toEqual(positionsBefore);
      expect(await getTestDb().select().from(topologyManualNodes)).toHaveLength(1);
      expect((await getTestDb().select().from(topologyNodes).where(eq(topologyNodes.id, node.id)))[0]).toMatchObject({ labelOverride: 'Router' });
      expect(await state(env)).toMatchObject({ graphRevision: before.graphRevision, materializedInputRevision: before.materializedInputRevision, dirtyRevision: before.dirtyRevision + 2n });
      expect(await getTestDb().select().from(topologyChangeOutbox).where(isNull(topologyChangeOutbox.deliveredAt))).toHaveLength(2);
    } finally { vi.unstubAllEnvs(); }
    await getTestDb().update(organizations).set({ settings: { topologyFeatureFlags: { materialization: true } } }).where(eq(organizations.id, env.organization.id));
    await withDbAccessContext(orgContext(env.organization.id), async () => {
      expect((await drainTopologyOutbox(scope(env))).complete).toBe(true);
      const parity = await compareLegacyTopology(scope(env));
      expect(parity).toMatchObject({ pendingThroughBarrier: 0, unexplainedManualDifferenceCount: 0, unexplainedPinDifferenceCount: 0, resurrectedTombstoneCount: 0 });
    });
    expect((await getTestDb().select().from(topologyNodePositions))[0]).toMatchObject({ x: 90, y: 100 });
    expect((await getTestDb().select().from(topologyNodes).where(eq(topologyNodes.id, node.id)))[0]).toMatchObject({ labelOverride: 'Pending before rollback' });
  });

  it('site ceiling revocation blocks writes even within a visible org', async () => {
    const env = await fixture(); const node = await createNode(env);
    await getTestDb().update(organizationUsers).set({ siteIds: [] }).where(and(eq(organizationUsers.userId, env.user.id), eq(organizationUsers.orgId, env.organization.id)));
    await clearPermissionCache(env.user.id);
    expect((await layout(env, '0', [position(node.id)])).status).toBe(404);
    expect((await v2(env, 'DELETE', `manual-nodes/${node.id}`, { expectedRevision: node.revision })).status).toBe(404);
    expect(await getTestDb().select().from(topologyNodePositions)).toHaveLength(0);
  });
});
