/**
 * Route-level integration coverage for the PATCH /discovery/topology/layout site
 * axis (#1728, P3-layout-perms fix). Exercises the REAL middleware chain
 * (authMiddleware → requireScope → requirePermission('topology','write')) and the
 * handler's app-layer site-belongs-to-org check against the live test DB as the
 * unprivileged `breeze_app` role under vitest.integration.config.ts.
 *
 * Why this is needed: topology_layout is org_id-direct (Shape 1), so RLS scopes
 * writes by org but NOT by site. Without the handler's explicit
 * (sites.id = siteId AND sites.org_id = resolvedOrg) lookup, a partner caller
 * could target another org's site — the INSERT would either match 0 rows under
 * RLS (silent cross-tenant "success") or persist under the wrong key. The fix
 * 404s when the site does not belong to the resolved org.
 *
 * Non-vacuous: the seed helpers insert via the BYPASSRLS superuser pool, so the
 * sites always exist physically. The 404 is produced by the handler's app-layer
 * lookup running on the breeze_app `db` pool — a vacuous RLS-off pass cannot fake
 * a 404 thrown before any layout write, and we additionally confirm via a
 * superuser SELECT that no topology_layout row was written.
 *
 * Harness mirrors topology-manual-write.integration.test.ts. Per setup.ts
 * cleanupDatabase() TRUNCATEs tenant tables on beforeEach, so every test re-seeds
 * fresh (no module-scope fixtures).
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { getTestDb } from './setup';
import {
  setupTestEnvironment,
  createOrganization,
  createSite,
} from './db-utils';
import { authMiddleware } from '../../middleware/auth';
import { discoveryRoutes } from '../../routes/discovery';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const JSON_HEADERS = { 'Content-Type': 'application/json' };

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/discovery', discoveryRoutes);
  return app;
}

const TOPOLOGY_RW = [
  { resource: 'devices', action: 'read' },
  { resource: 'topology', action: 'read' },
  { resource: 'topology', action: 'write' },
];

async function countLayoutRows(siteId: string): Promise<number> {
  const rows = (await getTestDb().execute(
    sql`SELECT count(*)::int AS n FROM topology_layout WHERE site_id = ${siteId}::uuid`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

function layoutBody(siteId: string, orgId?: string) {
  return {
    siteId,
    ...(orgId ? { orgId } : {}),
    positions: [
      {
        nodeType: 'discovered_asset' as const,
        nodeId: crypto.randomUUID(),
        x: 1,
        y: 2,
      },
    ],
  };
}

describe('PATCH /discovery/topology/layout — site-belongs-to-org (#1728)', () => {
  // Happy path: an org user upserts layout for its OWN site → 200, row persisted.
  runDb('org user upserts layout for its own site → 200', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: TOPOLOGY_RW,
    });
    const app = buildApp();

    const res = await app.request('/discovery/topology/layout', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${env.token}`, ...JSON_HEADERS },
      body: JSON.stringify(layoutBody(env.site.id)),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ upserted: 1 });
    expect(await countLayoutRows(env.site.id)).toBe(1);
  });

  // Core fix: a PARTNER caller (org_access='all') resolves to its own org but
  // targets a site under a DIFFERENT partner's org. The site-belongs-to-org
  // lookup returns nothing → 404, and NO layout row is written for that site.
  runDb(
    'partner caller cannot upsert layout for another org\'s site → 404, no row written',
    async () => {
      // Partner P with one org + site (the org the caller legitimately resolves).
      const envP = await setupTestEnvironment({
        scope: 'partner',
        rolePermissions: TOPOLOGY_RW,
      });
      // A wholly separate tenant (different partner) owns the target site.
      const otherEnv = await setupTestEnvironment({
        scope: 'organization',
        rolePermissions: [{ resource: 'devices', action: 'read' }],
      });

      const app = buildApp();

      // Partner P passes its own (accessible) orgId but the OTHER org's siteId.
      // resolveOrgId accepts orgId=envP.org (canAccessOrg true), then the site
      // lookup (sites.id = otherSite AND sites.org_id = envP.org) finds nothing.
      const res = await app.request('/discovery/topology/layout', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${envP.token}`, ...JSON_HEADERS },
        body: JSON.stringify(layoutBody(otherEnv.site.id, envP.organization.id)),
      });

      expect(res.status).toBe(404);
      // The cross-tenant site got zero layout rows — the write never ran.
      expect(await countLayoutRows(otherEnv.site.id)).toBe(0);
    },
  );

  // Same-partner, wrong-org pairing: a partner with TWO orgs targets org A's
  // siteId while resolving to org B (both accessible). The site does not belong
  // to the resolved org → 404. Proves the check keys off (site, resolvedOrg),
  // not merely "can the caller reach the site's org".
  runDb(
    'partner with two orgs: siteId of org A under resolved org B → 404',
    async () => {
      const envP = await setupTestEnvironment({
        scope: 'partner',
        rolePermissions: TOPOLOGY_RW,
      });
      // Second org + site under the SAME partner.
      const orgA = await createOrganization({ partnerId: envP.partner.id });
      const siteA = await createSite({ orgId: orgA.id });

      // The partner-scope role from setup grants org_access='all', so envP can
      // reach both its base org (org B) and orgA. Re-assert org_access='all'
      // (already set by setupTestEnvironment) is in effect; both orgs accessible.
      const app = buildApp();

      // Resolve org B (envP.organization) but pass org A's siteId.
      const res = await app.request('/discovery/topology/layout', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${envP.token}`, ...JSON_HEADERS },
        body: JSON.stringify(layoutBody(siteA.id, envP.organization.id)),
      });

      expect(res.status).toBe(404);
      expect(await countLayoutRows(siteA.id)).toBe(0);

      // And targeting org A's site WITH org A resolved is the legit path → 200.
      const ok = await app.request('/discovery/topology/layout', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${envP.token}`, ...JSON_HEADERS },
        body: JSON.stringify(layoutBody(siteA.id, orgA.id)),
      });
      expect(ok.status).toBe(200);
      expect(await countLayoutRows(siteA.id)).toBe(1);
    },
  );
});
