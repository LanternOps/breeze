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
 * GET /discovery/topology is gated on `devices:read`; both the permitted and the
 * cross-org users carry it. The no-permission user carries `devices:read` too,
 * so the 403 it receives is unambiguously from the `topology:write` gate (not a
 * missing read grant or a scope failure).
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { getTestDb } from './setup';
import { setupTestEnvironment } from './db-utils';
import { authMiddleware } from '../../middleware/auth';
import { discoveryRoutes } from '../../routes/discovery';
import { discoveredAssets } from '../../db/schema';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/discovery', discoveryRoutes);
  return app;
}

/** Seed a discovered asset (real row, superuser pool) to act as a manual-edge
 *  endpoint. discovered_assets is tenant-scoped (org_id/site_id NOT NULL). */
async function seedAsset(orgId: string, siteId: string): Promise<string> {
  const [row] = await getTestDb()
    .insert(discoveredAssets)
    .values({
      orgId,
      siteId,
      ipAddress: '10.10.0.5',
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
        { resource: 'topology', action: 'write' },
      ],
    });
    const envB = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'devices', action: 'read' }],
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
