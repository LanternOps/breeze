/**
 * topology_layout RLS — org_id-direct (Shape 1) enforcement.
 *
 * Migration under test: 2026-06-29-topology-layout.sql
 *
 * topology_layout carries a direct `org_id` column and ships the canonical
 * Shape-1 policies (breeze_org_isolation_{select,insert,update,delete}, each
 * keyed on breeze_has_org_access(org_id)). The rls-coverage contract test
 * already asserts FORCE ROW LEVEL SECURITY + policy presence via metadata, but
 * that is a structural check; these tests run the REAL postgres.js driver as
 * the unprivileged `breeze_app` role inside withDbAccessContext, so they
 * exercise actual cross-tenant enforcement.
 *
 * Non-vacuous guarantee: the seed helpers (createPartner/createOrganization/
 * createSite) insert via the BYPASSRLS superuser pool (getTestDb()), so they
 * always succeed regardless of RLS. The forge assertions, by contrast, go
 * through `db` (the breeze_app pool) under an explicit DbAccessContext, and a
 * system-scope SELECT probe confirms a hidden row physically exists — so a
 * vacuous "RLS off" pass is impossible.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { createOrganization, createPartner, createSite } from './db-utils';

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

async function seedTenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  return { partnerId: partner.id, orgId: org.id, siteId: site.id };
}

describe('topology_layout RLS (breeze_app forge, org_id-direct Shape 1)', () => {
  it('denies cross-tenant INSERT (forge org B row from org A context)', async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();

    // From org A's context, try to forge a row attributed to org B. The
    // INSERT WITH CHECK (breeze_has_org_access(org_id)) must reject it because
    // org A's context cannot access org B. drizzle's db.execute wraps the
    // driver error ("Failed query: ..."), so the RLS signal lives on the
    // underlying postgres.js cause: code 42501 (insufficient_privilege) with
    // the "new row violates row-level security policy" message.
    await expect(
      withDbAccessContext(orgContext(tenantA.orgId), async () => {
        await db.execute(sql`
          INSERT INTO topology_layout (org_id, site_id, node_type, node_id, x, y, pinned)
          VALUES (${tenantB.orgId}::uuid, ${tenantB.siteId}::uuid, 'discovered_asset', gen_random_uuid(), 1, 1, true)
        `);
      }),
    ).rejects.toMatchObject({
      cause: { code: '42501', message: expect.stringMatching(/row-level security/i) },
    });
  });

  it('allows same-tenant INSERT + SELECT, and org B cannot read org A rows', async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const nodeId = crypto.randomUUID();

    // Same-tenant INSERT under org A's context succeeds.
    await withDbAccessContext(orgContext(tenantA.orgId), async () => {
      await db.execute(sql`
        INSERT INTO topology_layout (org_id, site_id, node_type, node_id, x, y, pinned)
        VALUES (${tenantA.orgId}::uuid, ${tenantA.siteId}::uuid, 'discovered_asset', ${nodeId}::uuid, 42, 99, true)
      `);
    });

    // Org A can read its own row back.
    const visibleToA = await withDbAccessContext(orgContext(tenantA.orgId), () =>
      db.execute(sql`SELECT node_id, x, y FROM topology_layout WHERE node_id = ${nodeId}::uuid`),
    );
    expect(visibleToA).toHaveLength(1);

    // Org B cannot see org A's row (SELECT USING breeze_has_org_access filters it out).
    const visibleToB = await withDbAccessContext(orgContext(tenantB.orgId), () =>
      db.execute(sql`SELECT node_id FROM topology_layout WHERE node_id = ${nodeId}::uuid`),
    );
    expect(visibleToB).toHaveLength(0);

    // System-scope probe confirms the row physically exists — proves org B's
    // empty result is RLS filtering, not a missing row (non-vacuous).
    const systemView = await withSystemDbAccessContext(() =>
      db.execute(sql`SELECT node_id FROM topology_layout WHERE node_id = ${nodeId}::uuid`),
    );
    expect(systemView).toHaveLength(1);
  });

  it('org B cannot UPDATE or DELETE org A rows (USING filters them out silently)', async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const nodeId = crypto.randomUUID();

    await withDbAccessContext(orgContext(tenantA.orgId), async () => {
      await db.execute(sql`
        INSERT INTO topology_layout (org_id, site_id, node_type, node_id, x, y, pinned)
        VALUES (${tenantA.orgId}::uuid, ${tenantA.siteId}::uuid, 'discovered_asset', ${nodeId}::uuid, 10, 20, true)
      `);
    });

    // Org B's UPDATE matches no rows — org A's row is hidden by USING.
    await withDbAccessContext(orgContext(tenantB.orgId), async () => {
      await db.execute(sql`UPDATE topology_layout SET x = 777 WHERE node_id = ${nodeId}::uuid`);
    });

    // Org B's DELETE likewise affects nothing.
    await withDbAccessContext(orgContext(tenantB.orgId), async () => {
      await db.execute(sql`DELETE FROM topology_layout WHERE node_id = ${nodeId}::uuid`);
    });

    // The row still exists, unchanged — confirm via the owning org.
    const stillThere = await withDbAccessContext(orgContext(tenantA.orgId), () =>
      db.execute(sql`SELECT x FROM topology_layout WHERE node_id = ${nodeId}::uuid`),
    );
    expect(stillThere).toHaveLength(1);
    expect(Number((stillThere as unknown as Array<{ x: number }>)[0]!.x)).toBe(10);
  });
});
