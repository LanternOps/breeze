/**
 * topology_manual_nodes RLS — org_id-direct (Shape 1) enforcement (#1728 phase 4).
 *
 * Migration under test: 2026-06-30-topology-manual-nodes.sql
 *
 * topology_manual_nodes carries a direct `org_id` column and ships the canonical
 * Shape-1 policies (breeze_org_isolation_{select,insert,update,delete}, each
 * keyed on breeze_has_org_access(org_id)). The rls-coverage contract test
 * already asserts FORCE ROW LEVEL SECURITY + policy presence via metadata, but
 * that is a structural check; these tests run the REAL postgres.js driver as
 * the unprivileged `breeze_app` role inside withDbAccessContext, so they
 * exercise actual cross-tenant enforcement.
 *
 * Non-vacuous guarantee: the seed helpers (createPartner/createOrganization/
 * createSite) insert via the BYPASSRLS superuser pool, so they always succeed
 * regardless of RLS. The forge assertions, by contrast, go through `db` (the
 * breeze_app pool) under an explicit DbAccessContext, and a system-scope SELECT
 * probe confirms a hidden row physically exists — so a vacuous "RLS off" pass
 * is impossible.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { topologyManualNodes } from '../../db/schema/discovery';
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

describe('topology_manual_nodes RLS (breeze_app forge, org_id-direct Shape 1) (#1728 phase 4)', () => {
  it('rejects an org-B INSERT into org-A scope (cross-tenant forge)', async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();

    // From org B's context, try to forge a row attributed to org A. The
    // INSERT WITH CHECK (breeze_has_org_access(org_id)) must reject it because
    // org B's context cannot access org A. The Drizzle insert wraps the driver
    // error; the RLS signal lives on the underlying postgres.js cause: code
    // 42501 (insufficient_privilege) with "new row violates row-level security".
    let caught: unknown;
    try {
      await withDbAccessContext(orgContext(tenantB.orgId), async () =>
        db
          .insert(topologyManualNodes)
          .values({
            orgId: tenantA.orgId, // forging another tenant's org
            siteId: tenantA.siteId,
            label: 'rogue-switch',
            role: 'switch',
          }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const c = caught as { cause?: { message?: string; code?: string }; message?: string } | undefined;
    const msg = c?.cause?.message ?? c?.message ?? '';
    expect(c?.cause?.code).toBe('42501');
    expect(msg).toMatch(
      /new row violates row-level security policy for table "topology_manual_nodes"/,
    );
  });

  it('allows a same-org INSERT under matching context, and isolates SELECT', async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();

    const [row] = await withDbAccessContext(orgContext(tenantA.orgId), async () =>
      db
        .insert(topologyManualNodes)
        .values({
          orgId: tenantA.orgId,
          siteId: tenantA.siteId,
          label: 'core-sw',
          role: 'switch',
        })
        .returning(),
    );
    expect(row?.id).toBeDefined();

    // Org A reads its own row back.
    const asOrgA = await withDbAccessContext(orgContext(tenantA.orgId), () =>
      db.select().from(topologyManualNodes),
    );
    expect(asOrgA.find((r) => r.id === row!.id)).toBeDefined();

    // Org B cannot see org A's row (SELECT USING breeze_has_org_access filters it out).
    const asOrgB = await withDbAccessContext(orgContext(tenantB.orgId), () =>
      db.select().from(topologyManualNodes),
    );
    expect(asOrgB.find((r) => r.id === row!.id)).toBeUndefined();

    // System-scope probe confirms the row physically exists — proves org B's
    // empty result is RLS filtering, not a missing row (non-vacuous).
    const systemView = await withSystemDbAccessContext(() =>
      db.execute(sql`SELECT id FROM topology_manual_nodes WHERE id = ${row!.id}::uuid`),
    );
    expect(systemView).toHaveLength(1);
  });

  it('org B cannot UPDATE or DELETE org A rows (USING filters them out silently)', async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();

    const [row] = await withDbAccessContext(orgContext(tenantA.orgId), async () =>
      db
        .insert(topologyManualNodes)
        .values({
          orgId: tenantA.orgId,
          siteId: tenantA.siteId,
          label: 'edge-sw',
          role: 'switch',
        })
        .returning(),
    );
    expect(row?.id).toBeDefined();

    // Org B's UPDATE matches no rows — org A's row is hidden by USING.
    await withDbAccessContext(orgContext(tenantB.orgId), async () => {
      await db.execute(
        sql`UPDATE topology_manual_nodes SET label = 'hijacked' WHERE id = ${row!.id}::uuid`,
      );
    });

    // Org B's DELETE likewise affects nothing.
    await withDbAccessContext(orgContext(tenantB.orgId), async () => {
      await db.execute(sql`DELETE FROM topology_manual_nodes WHERE id = ${row!.id}::uuid`);
    });

    // The row still exists, unchanged — confirm via the owning org.
    const stillThere = await withDbAccessContext(orgContext(tenantA.orgId), () =>
      db.select().from(topologyManualNodes),
    );
    const found = stillThere.find((r) => r.id === row!.id);
    expect(found).toBeDefined();
    expect(found!.label).toBe('edge-sw');
  });
});
