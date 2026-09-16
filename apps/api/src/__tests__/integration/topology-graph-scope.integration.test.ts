import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { Hono } from 'hono';
import { graphResponseSchema, type GraphResponse } from '@breeze/shared';
import { authMiddleware } from '../../middleware/auth';
import { topologyGraphRoutes } from '../../routes/topology/graphs';
import { clearPermissionCache } from '../../services/permissions';
import { topologyNodes, topologyRelationships, topologySiteState, topologyLayouts, topologyNodePositions, topologyChangeOutbox, organizationUsers } from '../../db/schema';
import { canonicalIdentityKey } from '../../services/topology/identity';
import { createOrganization, createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const READ = [{ resource: 'topology', action: 'read' }, { resource: 'devices', action: 'read' }];
function app() { const app = new Hono(); app.use('*', authMiddleware); return app.route('/topology', topologyGraphRoutes); }
function request(env: TestEnvironment, siteId: string, path: string, headers: Record<string, string> = {}) {
  return app().request(`/topology/sites/${siteId}/${path}`, { headers: { Authorization: `Bearer ${env.token}`, ...headers } });
}
async function seedOrderedFocus(orgId: string, siteId: string, neighbors: number) {
  const scope = { orgId, siteId };
  const focus = 'f0000000-0000-4000-8000-000000000009';
  const memberIds = Array.from({ length: neighbors }, (_, i) => `10000000-0000-4000-8000-00000000000${i + 1}`);
  await getTestDb().insert(topologySiteState).values({ ...scope, graphRevision: 1n }).onConflictDoNothing();
  await getTestDb().insert(topologyNodes).values([...memberIds, focus].map(id => {
    const kind = id === focus ? 'network' as const : 'endpoint' as const;
    return { ...scope, id, kind, identityKey: canonicalIdentityKey(scope, kind, id), identityMaterial: { version: 1 as const, kind, sourceKey: id }, attributes: { label: id } };
  }));
  await getTestDb().insert(topologyRelationships).values(memberIds.map(id => {
    const sourceKey = `membership:${id}`;
    return { ...scope, kind: 'network_member' as const, sourceNodeId: id, targetNodeId: focus,
      canonicalKey: canonicalIdentityKey(scope, 'network_member', sourceKey),
      identityMaterial: { version: 1 as const, kind: 'network_member' as const, sourceKey } };
  }));
  return { focus, memberIds };
}
async function seed(orgId: string, siteId: string) {
  const scope = { orgId, siteId }; const db = getTestDb();
  await db.insert(topologySiteState).values({ ...scope, graphRevision: 9007199254740993n, healthRevision: 2n }).onConflictDoUpdate({ target: [topologySiteState.orgId, topologySiteState.siteId], set: { graphRevision: 9007199254740993n, healthRevision: 2n } });
  const nodes = await db.insert(topologyNodes).values(Array.from({ length: 5 }, (_, i) => {
    const id = randomUUID(); const kind = i === 0 ? 'network' as const : 'endpoint' as const;
    return { ...scope, id, kind, identityKey: canonicalIdentityKey(scope, kind, id), identityMaterial: { version: 1 as const, kind, sourceKey: id }, attributes: { label: i === 1 ? 'literal_% host' : `Endpoint ${i}` }, lastObservedAt: new Date('2026-09-15T10:00:00Z') };
  })).returning();
  const relationships = await db.insert(topologyRelationships).values(nodes.slice(1).map((node) => {
    const id = randomUUID(); return { ...scope, id, kind: 'network_member' as const, canonicalKey: canonicalIdentityKey(scope, 'network_member', id), identityMaterial: { version: 1 as const, kind: 'network_member' as const, sourceKey: id }, sourceNodeId: node.id, targetNodeId: nodes[0]!.id, supportCount: 1n };
  })).returning();
  const [layout] = await db.insert(topologyLayouts).values({ ...scope, view: 'overview', revision: 7n, algorithm: 'legacy', algorithmVersion: '1' }).returning();
  await db.insert(topologyNodePositions).values(nodes.map((node, i) => ({ ...scope, layoutId: layout!.id, nodeId: node.id, x: i * 100, y: 42, pinned: i === 0, revision: 3n })));
  return { nodes, relationships, layout: layout! };
}
async function snapshot(siteId: string) {
  const db = getTestDb();
  return { state: await db.select().from(topologySiteState).where(eq(topologySiteState.siteId, siteId)),
    nodes: await db.select().from(topologyNodes).where(eq(topologyNodes.siteId, siteId)),
    relationships: await db.select().from(topologyRelationships).where(eq(topologyRelationships.siteId, siteId)),
    layout: await db.select().from(topologyLayouts).where(eq(topologyLayouts.siteId, siteId)),
    positions: await db.select().from(topologyNodePositions).where(eq(topologyNodePositions.siteId, siteId)),
    outbox: await db.select().from(topologyChangeOutbox).where(eq(topologyChangeOutbox.siteId, siteId)) };
}
async function graph(env: TestEnvironment, siteId: string, query = ''): Promise<GraphResponse> {
  const result = await request(env, siteId, `graph${query}`);
  const body = await result.json(); expect(result.status, JSON.stringify(body)).toBe(200);
  return graphResponseSchema.parse(body);
}
describe('passive topology graph — real request RLS and scope', () => {
  it('reveals the boundary token focus even when its UUID sorts last and the budget is one', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    const { focus, memberIds } = await seedOrderedFocus(env.organization.id, env.site.id, 1);
    const initial = await graph(env, env.site.id, '?limit=1');
    expect(initial.nodes.map(node => node.id)).toEqual(memberIds);
    const boundary = initial.presentation.edges[0]!;
    if (boundary.meaning !== 'aggregate') throw new Error('Expected an expandable boundary edge');
    const res = await request(env, env.site.id, `expansions/${boundary.frontierToken}`);
    expect(res.status).toBe(200);
    const expanded = graphResponseSchema.parse(await res.json());
    expect(expanded.nodes.map(node => node.id)).toEqual([focus]);
    const continuation = expanded.frontier.find(frontier => frontier.label === 'More devices')!;
    const next = await request(env, env.site.id, `expansions/${continuation.token}`);
    expect(next.status).toBe(200);
    const last = graphResponseSchema.parse(await next.json());
    expect(last.nodes.map(node => node.id)).toEqual(memberIds);
    expect(last.frontier.some(frontier => frontier.label === 'More devices')).toBe(false);
  });

  it('keeps the initial group focus in budget and pages every remaining member exactly once', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    const { focus, memberIds } = await seedOrderedFocus(env.organization.id, env.site.id, 4);
    let res = await request(env, env.site.id, `groups/${focus}/members?limit=2`);
    expect(res.status).toBe(200);
    let page = graphResponseSchema.parse(await res.json());
    expect(page.nodes.map(node => node.id)).toEqual([focus, memberIds[0]]);
    const seen: string[] = [];
    for (let pages = 0; pages < 4; pages++) {
      expect(page.nodes.length).toBeLessThanOrEqual(2);
      seen.push(...page.nodes.map(node => node.id));
      const next = page.frontier.find(frontier => frontier.label === 'More devices');
      if (!next) break;
      res = await request(env, env.site.id, `groups/${focus}/members?cursor=${next.token}`);
      expect(res.status).toBe(200);
      page = graphResponseSchema.parse(await res.json());
    }
    expect(seen).toEqual([focus, ...memberIds]);
    expect(new Set(seen).size).toBe(5);
    expect(page.frontier.some(frontier => frontier.label === 'More devices')).toBe(false);
  });

  it('pins nonempty bounded reads, counts, positions, boundary provenance and decimal revisions without writes', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ }); const fixture = await seed(env.organization.id, env.site.id);
    const before = await snapshot(env.site.id);
    const body = await graph(env, env.site.id, '?limit=2');
    expect(body.nodes).toHaveLength(2); expect(body.counts.totalNodes).toBe(5); expect(body.counts.omittedNodes).toBe(3);
    expect(body.counts.totalRelationships).toBe(4); expect(body.counts.visibleRelationships).toBe(body.relationships.length);
    expect(body.revisions).toEqual({ graph: '9007199254740993', health: '2', layout: '7' });
    expect(body.presentation.edges.length).toBeGreaterThan(0);
    expect(body.presentation.edges.every((edge) => edge.presentationOnly && edge.relationshipKind === null && edge.contributingRelationshipIds.length > 0)).toBe(true);
    expect(body.nodes.every((node) => node.health.status === 'unknown' && node.health.reasons.length > 0)).toBe(true);
    const paths = ['nodes?q=literal_%25', `nodes/${fixture.nodes[1]!.id}`, `relationships/${fixture.relationships[0]!.id}`, `relationships/${fixture.relationships[0]!.id}/evidence`, `groups/${fixture.nodes[0]!.id}/members?limit=2`, `health?nodeIds=${fixture.nodes[0]!.id}&relationshipIds=${fixture.relationships[0]!.id}`, `expansions/${body.frontier[0]!.token}`];
    for (const path of paths) { const res = await request(env, env.site.id, path); expect(res.status, `${path}: ${await res.text()}`).toBe(200); }
    expect(await snapshot(env.site.id)).toEqual(before);
    expect((await graph(env, env.site.id, '?view=physical')).nodes).toEqual([]);
  });

  it('searches literal wildcard text, counts with filters, and rejects changed cursor filters', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ }); await seed(env.organization.id, env.site.id);
    const res = await request(env, env.site.id, `nodes?q=${encodeURIComponent('literal_%')}`); expect(res.status).toBe(200);
    const body = await res.json(); expect(body.total).toBe(1); expect(body.nodes[0].label).toBe('literal_% host');
    const page = await (await request(env, env.site.id, 'nodes?kind=endpoint&limit=1')).json(); expect(page.total).toBe(4); expect(page.cursor).toBeTruthy();
    expect((await request(env, env.site.id, `nodes?kind=network&limit=1&cursor=${page.cursor}`)).status).toBe(400);
    const next = await (await request(env, env.site.id, `nodes?kind=endpoint&limit=1&cursor=${page.cursor}`)).json();
    expect(next.total).toBe(4); expect(next.nodes[0].id).not.toBe(page.nodes[0].id);
  });

  it('does not expose same-org site subjects through detail, evidence, health or frontier tokens', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ }); await seed(env.organization.id, env.site.id);
    const other = await createSite({ orgId: env.organization.id }); const foreign = await seed(env.organization.id, other.id);
    const foreignGraph = await graph(env, other.id, '?limit=1');
    for (const path of [`nodes/${foreign.nodes[0]!.id}`, `relationships/${foreign.relationships[0]!.id}/evidence`, `health?nodeIds=${foreign.nodes[0]!.id}`]) expect((await request(env, env.site.id, path)).status).toBe(404);
    expect((await request(env, env.site.id, `expansions/${foreignGraph.frontier[0]!.token}`)).status).toBe(400);
    await getTestDb().update(organizationUsers).set({ siteIds: [env.site.id] }).where(and(eq(organizationUsers.userId, env.user.id), eq(organizationUsers.orgId, env.organization.id)));
    await clearPermissionCache(env.user.id);
    expect((await request(env, other.id, `expansions/${foreignGraph.frontier[0]!.token}`)).status).toBe(404);
  });

  it('keeps multi-org partner projections separate and hides a foreign partner', async () => {
    const env = await setupTestEnvironment({ scope: 'partner', rolePermissions: READ }); await seed(env.organization.id, env.site.id);
    const org = await createOrganization({ partnerId: env.partner.id }); const site = await createSite({ orgId: org.id }); const other = await seed(org.id, site.id);
    const foreign = await setupTestEnvironment({ rolePermissions: READ }); await seed(foreign.organization.id, foreign.site.id);
    const a = await graph(env, env.site.id); const b = await graph(env, site.id);
    expect(a.counts.totalNodes).toBe(5); expect(b.counts.totalNodes).toBe(5);
    expect(a.nodes.some((n) => other.nodes.some((row) => row.id === n.id))).toBe(false);
    expect((await request(env, foreign.site.id, 'graph')).status).toBe(404);
  });

  it('rejects stale structural revisions and revoked permission generations before replay', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ }); await seed(env.organization.id, env.site.id);
    const before = await graph(env, env.site.id, '?limit=1');
    await getTestDb().update(topologySiteState).set({ graphRevision: 9007199254740994n }).where(eq(topologySiteState.siteId, env.site.id));
    const stale = await request(env, env.site.id, `expansions/${before.frontier[0]!.token}`); expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: 'graph_revision_changed' });
    const current = await graph(env, env.site.id, '?limit=1'); await clearPermissionCache(env.user.id);
    expect((await request(env, env.site.id, `expansions/${current.frontier[0]!.token}`)).status).toBe(400);
  });

  it('uses private conditional caching and no-store evidence with no state creation on new sites', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ }); const fixture = await seed(env.organization.id, env.site.id);
    const first = await request(env, env.site.id, 'graph'); const tag = first.headers.get('etag'); expect(tag).toBeTruthy();
    expect(first.headers.get('cache-control')).toContain('private');
    expect((await request(env, env.site.id, 'graph', { 'If-None-Match': tag! })).status).toBe(304);
    const evidence = await request(env, env.site.id, `relationships/${fixture.relationships[0]!.id}/evidence`, { 'If-None-Match': tag! });
    expect(evidence.status).toBe(200); expect(evidence.headers.get('cache-control')).toBe('private, no-store'); expect(evidence.headers.has('etag')).toBe(false);
    const emptySite = await createSite({ orgId: env.organization.id }); const empty = await graph(env, emptySite.id);
    expect(empty.revisions.graph).toBe('0'); expect(empty.nodes).toEqual([]);
    expect(await getTestDb().select().from(topologySiteState).where(eq(topologySiteState.siteId, emptySite.id))).toEqual([]);
  });
});
