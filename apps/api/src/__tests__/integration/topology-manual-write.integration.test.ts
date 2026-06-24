/**
 * Route-level integration coverage for the Phase 4 manual-topology endpoints
 * (#1728). Exercises the REAL middleware chain (authMiddleware → requireScope →
 * requirePermission('topology','write')) against the live test DB as the
 * unprivileged `breeze_app` role under vitest.integration.config.ts.
 *
 * Guarantees:
 *   1. RBAC — an org user holding `devices:read` but NOT `topology:write` gets
 *      403 ("Permission denied") on POST /discovery/topology/manual-node. This
 *      is self-verifying: a vacuous BYPASSRLS pass cannot fake a 403 thrown by
 *      requirePermission (the gate runs before any DB query).
 *   2. Round-trip — a `topology:write` holder creates a manual node (201) and a
 *      manual edge (201, method='manual') between that node and a seeded
 *      discovered asset; GET /discovery/topology returns the manual node
 *      (kind:'manual') and the manual edge (method:'manual'); DELETE
 *      manual-node/:id cascades — a follow-up GET shows neither node nor edge.
 *   3. Tenant isolation — a second org's user does NOT see org A's manual node
 *      in GET /discovery/topology (RLS org-isolation on topology_manual_nodes).
 *
 * Harness mirrored from update-rings-partner-scope.integration.test.ts and
 * org-scope-narrowing.integration.test.ts (real authMiddleware, JWT minted by
 * setupTestEnvironment, no vi.mock). Per setup.ts cleanupDatabase() TRUNCATEs
 * tenant tables on beforeEach, so every test re-seeds fresh (no module-scope
 * fixtures — see memory: rls-forge-test-memoized-fixture-vacuous).
 *
 * GET /discovery/topology is gated on `topology:read`; the round-trip and
 * cross-org reader carry it (alongside `devices:read`). The no-permission user in
 * case 1 carries `devices:read` only and never reaches GET, so the 403 it
 * receives on POST manual-node is unambiguously from the `topology:write` gate
 * (not a missing read grant or a scope failure).
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { getTestDb } from './setup';
import { setupTestEnvironment, createSite, type TestEnvironment } from './db-utils';
import { authMiddleware } from '../../middleware/auth';
import { discoveryRoutes } from '../../routes/discovery';
import {
  discoveredAssets,
  networkTopology,
  organizationUsers,
  topologyManualNodes,
} from '../../db/schema';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/discovery', discoveryRoutes);
  return app;
}

/** Restrict the env's org user to a specific set of sites by writing
 *  organization_users.site_ids (the source getUserPermissions reads for
 *  allowedSiteIds → canAccessSite). A site-restricted caller can only touch
 *  topology in `siteIds`. */
async function restrictUserToSites(env: TestEnvironment, siteIds: string[]): Promise<void> {
  await getTestDb()
    .update(organizationUsers)
    .set({ siteIds })
    .where(eq(organizationUsers.userId, env.user.id));
}

/** Seed a manual node (superuser pool) in the given (org, site). */
async function seedManualNode(orgId: string, siteId: string): Promise<string> {
  const [row] = await getTestDb()
    .insert(topologyManualNodes)
    .values({ orgId, siteId, label: 'seed-node', role: 'switch' })
    .returning({ id: topologyManualNodes.id });
  if (!row) throw new Error('seedManualNode: no row returned');
  return row.id;
}

/** Seed a measured (method='fdb') edge between two assets in (org, site). */
async function seedMeasuredEdge(
  orgId: string,
  siteId: string,
  sourceId: string,
  targetId: string,
): Promise<string> {
  const [row] = await getTestDb()
    .insert(networkTopology)
    .values({
      orgId,
      siteId,
      sourceType: 'discovered_asset',
      sourceId,
      targetType: 'discovered_asset',
      targetId,
      connectionType: 'ethernet',
      method: 'fdb',
      confidence: 'medium',
    })
    .returning({ id: networkTopology.id });
  if (!row) throw new Error('seedMeasuredEdge: no row returned');
  return row.id;
}

/** Seed a discovered asset (real row, superuser pool) to act as a manual-edge
 *  endpoint. discovered_assets is tenant-scoped (org_id/site_id NOT NULL). */
async function seedAsset(orgId: string, siteId: string, ip = '10.10.0.5'): Promise<string> {
  const [row] = await getTestDb()
    .insert(discoveredAssets)
    .values({
      orgId,
      siteId,
      ipAddress: ip,
      hostname: 'seed-asset',
      assetType: 'unknown',
    })
    .returning({ id: discoveredAssets.id });
  if (!row) throw new Error('seedAsset: no row returned');
  return row.id;
}

describe('topology manual-mapping routes — RBAC + round-trip + isolation (#1728 phase 4)', () => {
  // Case 1: RBAC denial. An org user with devices:read but NOT topology:write
  // is blocked by requirePermission('topology','write') → 403.
  runDb('org user lacking topology:write → 403 on POST manual-node', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'devices', action: 'read' }],
    });
    const app = buildApp();

    const res = await app.request('/discovery/topology/manual-node', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.token}`, ...JSON_HEADERS },
      body: JSON.stringify({
        siteId: env.site.id,
        label: 'denied-switch',
        role: 'switch',
      }),
    });

    expect(res.status).toBe(403);
    // HTTPException renders a plain-text body ("Permission denied"), not JSON.
    const body = await res.text();
    expect(body).toContain('Permission denied');
  });

  // Case 2: full round-trip for a topology:write holder.
  runDb(
    'topology:write holder: create node + edge → visible in GET → DELETE node cascades edge',
    async () => {
      const env = await setupTestEnvironment({
        scope: 'organization',
        rolePermissions: [
          { resource: 'devices', action: 'read' },
          { resource: 'topology', action: 'read' },
          { resource: 'topology', action: 'write' },
        ],
      });
      const app = buildApp();
      const authHeader = { Authorization: `Bearer ${env.token}` };

      const assetId = await seedAsset(env.organization.id, env.site.id);

      // Create a manual node.
      const nodeRes = await app.request('/discovery/topology/manual-node', {
        method: 'POST',
        headers: { ...authHeader, ...JSON_HEADERS },
        body: JSON.stringify({ siteId: env.site.id, label: 'core-sw', role: 'switch' }),
      });
      expect(nodeRes.status).toBe(201);
      const node = await nodeRes.json();
      expect(node.id).toBeDefined();
      expect(node.role).toBe('switch');
      expect(node.orgId).toBe(env.organization.id);

      // Draw a manual edge from the placeholder node to the discovered asset.
      const edgeRes = await app.request('/discovery/topology/manual-edge', {
        method: 'POST',
        headers: { ...authHeader, ...JSON_HEADERS },
        body: JSON.stringify({
          siteId: env.site.id,
          source: { type: 'manual_node', id: node.id },
          target: { type: 'discovered_asset', id: assetId },
        }),
      });
      expect(edgeRes.status).toBe(201);
      const edge = await edgeRes.json();
      expect(edge.id).toBeDefined();
      expect(edge.method).toBe('manual');
      expect(edge.confidence).toBe('asserted');

      // GET /topology surfaces the manual node + manual edge.
      const getRes = await app.request('/discovery/topology', { headers: authHeader });
      expect(getRes.status).toBe(200);
      const topo = await getRes.json();
      const manualNode = topo.nodes.find(
        (n: { id: string; kind?: string }) => n.id === node.id,
      );
      expect(manualNode).toBeDefined();
      expect(manualNode.kind).toBe('manual');
      expect(manualNode.type).toBe('switch');
      const manualEdge = topo.edges.find((e: { id: string }) => e.id === edge.id);
      expect(manualEdge).toBeDefined();
      expect(manualEdge.method).toBe('manual');

      // DELETE the manual node — its manual edge must cascade away.
      const delRes = await app.request(`/discovery/topology/manual-node/${node.id}`, {
        method: 'DELETE',
        headers: authHeader,
      });
      expect(delRes.status).toBe(200);
      expect(await delRes.json()).toEqual({ success: true });

      const afterRes = await app.request('/discovery/topology', { headers: authHeader });
      expect(afterRes.status).toBe(200);
      const after = await afterRes.json();
      expect(after.nodes.find((n: { id: string }) => n.id === node.id)).toBeUndefined();
      expect(after.edges.find((e: { id: string }) => e.id === edge.id)).toBeUndefined();
    },
  );

  // Case 3: tenant isolation. A second org (different partner) user does NOT see
  // org A's manual node in GET /topology (RLS org-isolation on the table).
  runDb('a second org does NOT see org A manual node in GET /topology', async () => {
    const envA = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [
        { resource: 'devices', action: 'read' },
        { resource: 'topology', action: 'read' },
        { resource: 'topology', action: 'write' },
      ],
    });
    const envB = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [
        { resource: 'devices', action: 'read' },
        { resource: 'topology', action: 'read' },
      ],
    });
    const app = buildApp();

    // Org A creates a manual node.
    const nodeRes = await app.request('/discovery/topology/manual-node', {
      method: 'POST',
      headers: { Authorization: `Bearer ${envA.token}`, ...JSON_HEADERS },
      body: JSON.stringify({ siteId: envA.site.id, label: 'a-only-sw', role: 'router' }),
    });
    expect(nodeRes.status).toBe(201);
    const node = await nodeRes.json();

    // Org A sees it.
    const getA = await app.request('/discovery/topology', {
      headers: { Authorization: `Bearer ${envA.token}` },
    });
    expect(getA.status).toBe(200);
    const topoA = await getA.json();
    expect(topoA.nodes.find((n: { id: string }) => n.id === node.id)).toBeDefined();

    // Org B (different tenant) must NOT see org A's manual node.
    const getB = await app.request('/discovery/topology', {
      headers: { Authorization: `Bearer ${envB.token}` },
    });
    expect(getB.status).toBe(200);
    const topoB = await getB.json();
    expect(topoB.nodes.find((n: { id: string }) => n.id === node.id)).toBeUndefined();
  });
});

/**
 * Site-axis IDOR + provenance + duplicate guards on the DELETE/POST endpoints
 * (#1728 review fixes). RLS scopes topology by ORG, not SITE, so a same-org but
 * site-restricted caller is the threat model these cases pin down. The forge is
 * self-verifying: the node/edge live in siteA, the caller is restricted to siteB,
 * and a 404 (not a vacuous 200) is the only acceptable result. If the app-layer
 * canAccessSite gate were missing, RLS would happily let the same-org delete
 * through (200) and the test would fail.
 */
describe('topology manual DELETE — site-axis IDOR + provenance + duplicate (#1728 review)', () => {
  // A same-org, site-restricted caller must NOT delete a manual node in a site
  // they cannot access (cross-site IDOR; RLS does not defend the site axis).
  runDb('site-restricted caller → 404 on DELETE manual-node in an out-of-scope site', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [
        { resource: 'topology', action: 'read' },
        { resource: 'topology', action: 'write' },
      ],
    });
    const app = buildApp();

    // siteA = env.site (where the node lives); siteB = the only site the caller
    // may touch.
    const siteB = await createSite({ orgId: env.organization.id });
    await restrictUserToSites(env, [siteB.id]);

    const nodeId = await seedManualNode(env.organization.id, env.site.id);

    const res = await app.request(`/discovery/topology/manual-node/${nodeId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${env.token}` },
    });
    expect(res.status).toBe(404);

    // The node still exists (the cascade transaction never ran).
    const [still] = await getTestDb()
      .select({ id: topologyManualNodes.id })
      .from(topologyManualNodes)
      .where(eq(topologyManualNodes.id, nodeId));
    expect(still).toBeDefined();
  });

  // Same for a manual edge.
  runDb('site-restricted caller → 404 on DELETE manual-edge in an out-of-scope site', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [
        { resource: 'topology', action: 'read' },
        { resource: 'topology', action: 'write' },
      ],
    });
    const app = buildApp();

    const siteB = await createSite({ orgId: env.organization.id });

    // Build a manual edge in siteA while UNRESTRICTED, then restrict to siteB.
    const a1 = await seedAsset(env.organization.id, env.site.id, '10.20.0.1');
    const nodeId = await seedManualNode(env.organization.id, env.site.id);
    const [edge] = await getTestDb()
      .insert(networkTopology)
      .values({
        orgId: env.organization.id,
        siteId: env.site.id,
        sourceType: 'manual_node',
        sourceId: nodeId,
        targetType: 'discovered_asset',
        targetId: a1,
        connectionType: 'manual',
        method: 'manual',
        confidence: 'asserted',
      })
      .returning({ id: networkTopology.id });
    if (!edge) throw new Error('seed manual edge failed');

    await restrictUserToSites(env, [siteB.id]);

    const res = await app.request(`/discovery/topology/manual-edge/${edge.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${env.token}` },
    });
    expect(res.status).toBe(404);

    const [still] = await getTestDb()
      .select({ id: networkTopology.id })
      .from(networkTopology)
      .where(eq(networkTopology.id, edge.id));
    expect(still).toBeDefined();
  });

  // A measured (method='fdb') edge is scan-owned and read-only: DELETE
  // manual-edge filters to method='manual', so a measured edge id 404s and the
  // row survives.
  runDb('DELETE manual-edge refuses a measured (fdb) edge → 404, row survives', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [
        { resource: 'topology', action: 'read' },
        { resource: 'topology', action: 'write' },
      ],
    });
    const app = buildApp();

    const a1 = await seedAsset(env.organization.id, env.site.id, '10.30.0.1');
    const a2 = await seedAsset(env.organization.id, env.site.id, '10.30.0.2');
    const measuredId = await seedMeasuredEdge(env.organization.id, env.site.id, a1, a2);

    const res = await app.request(`/discovery/topology/manual-edge/${measuredId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${env.token}` },
    });
    expect(res.status).toBe(404);

    const [still] = await getTestDb()
      .select({ id: networkTopology.id })
      .from(networkTopology)
      .where(eq(networkTopology.id, measuredId));
    expect(still).toBeDefined();
  });

  // Re-drawing the same manual edge trips the provenance unique index — the
  // route maps the 23505 to a clean 409 (not a raw 500).
  runDb('duplicate manual edge → 409', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [
        { resource: 'topology', action: 'read' },
        { resource: 'topology', action: 'write' },
      ],
    });
    const app = buildApp();
    const authHeader = { Authorization: `Bearer ${env.token}` };

    const assetId = await seedAsset(env.organization.id, env.site.id, '10.40.0.1');
    const nodeRes = await app.request('/discovery/topology/manual-node', {
      method: 'POST',
      headers: { ...authHeader, ...JSON_HEADERS },
      body: JSON.stringify({ siteId: env.site.id, label: 'sw', role: 'switch' }),
    });
    expect(nodeRes.status).toBe(201);
    const node = await nodeRes.json();

    const edgeBody = JSON.stringify({
      siteId: env.site.id,
      source: { type: 'manual_node', id: node.id },
      target: { type: 'discovered_asset', id: assetId },
    });

    const first = await app.request('/discovery/topology/manual-edge', {
      method: 'POST',
      headers: { ...authHeader, ...JSON_HEADERS },
      body: edgeBody,
    });
    expect(first.status).toBe(201);

    const dup = await app.request('/discovery/topology/manual-edge', {
      method: 'POST',
      headers: { ...authHeader, ...JSON_HEADERS },
      body: edgeBody,
    });
    expect(dup.status).toBe(409);
    const dupBody = await dup.json();
    expect(dupBody.error).toMatch(/already/i);
  });
});
