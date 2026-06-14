/**
 * Real-driver cross-tenant forge tests for the product catalog.
 *
 * Runs under vitest.integration.config.ts — code-under-test connects as the
 * unprivileged `breeze_app` role (rolbypassrls=f), so RLS is actually
 * enforced. If `.env.test` is missing the symlink that pins this to the
 * breeze_app role, these tests would pass vacuously on a BYPASSRLS admin
 * connection (see memory: worktree_env_test_rls_vacuous) — the forged-insert
 * assertions (cases c, d) are the guard that catches that.
 *
 * Fixture topology (seeded fresh per test under system scope, which bypasses
 * RLS — see "why no memoization" below):
 *   partnerA → orgA
 *   partnerB → orgB
 *   itemA       = catalog_items row under partnerA
 *   componentA  = a second catalog_items row under partnerA (bundle component)
 *   pricingA    = catalog_item_org_pricing override for itemA under orgA
 *
 * Required coverage (4 cases):
 *   (a) partner B context reading partner A's catalog_items row → 0 rows
 *   (b) org B context reading org A's catalog_item_org_pricing row → 0 rows
 *   (c) a forged cross-partner catalog_items INSERT (partner B context,
 *       partnerId=partnerA) is rejected with an RLS violation (42501).
 *   (d) a forged cross-partner catalog_bundle_components INSERT (partner B
 *       context, partnerId=partnerA, referencing partner A's items) is rejected
 *       with an RLS violation (42501). This is the only behavioral guard on the
 *       flat denormalized-partner_id policy added in this same commit — the
 *       rls-coverage contract test only proves the policy exists, not that it
 *       isolates at runtime (the #1016 / custom_field_definitions blindspot).
 *
 * Why NO memoization: setup.ts runs cleanupDatabase() in a beforeEach that
 * TRUNCATE ... CASCADEs partners/organizations before every test, which
 * cascades through the catalog FKs and wipes every catalog row. A module-level
 * fixture cache would therefore hand cases (b)/(c)/(d) rows that no longer
 * exist, making the RLS assertions vacuous (a 0-row read passes even if RLS is
 * broken; a forged insert can surface an incidental FK 23503 instead of 42501).
 * Each it() re-seeds fresh — matching every sibling *-rls.integration.test.ts.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  catalogItems,
  catalogItemOrgPricing,
  catalogBundleComponents,
  organizations,
  partners,
} from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// Partner ids seeded by this file, accumulated for the best-effort afterAll
// safety net (see teardown note). setup.ts's beforeEach already wipes core
// tenant tables, so afterAll is purely defensive.
const seededPartnerIds: string[] = [];

interface Fixture {
  partnerA: { id: string };
  orgA: { id: string };
  partnerB: { id: string };
  orgB: { id: string };
  itemA: { id: string };
  componentA: { id: string };
  pricingA: { id: string };
  partnerBContext: DbAccessContext;
  orgBContext: DbAccessContext;
}

// Re-seeds fresh on every call. Intentionally NOT memoized: setup.ts's
// beforeEach cleanupDatabase() TRUNCATEs partners/organizations CASCADE before
// each test, so any cached rows would already be deleted by the time an
// assertion runs (proven by a vacuity probe during review).
async function seedFixture(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });

    seededPartnerIds.push(partnerA.id, partnerB.id);

    // catalog_items row under partner A (numeric columns insert as strings).
    const [itemA] = await db
      .insert(catalogItems)
      .values({
        partnerId: partnerA.id,
        itemType: 'service',
        name: 'A-only service',
        unitPrice: '10.00',
      })
      .returning({ id: catalogItems.id });
    if (!itemA) throw new Error('failed to seed catalog item A');

    // A second catalog_items row under partner A, used as a bundle component in
    // case (d). Both items belong to partner A so the forged bundle-component
    // insert's FK references resolve — isolating the RLS WITH CHECK as the only
    // reason the insert can fail (a 42501, never an incidental 23503 FK error).
    const [componentA] = await db
      .insert(catalogItems)
      .values({
        partnerId: partnerA.id,
        itemType: 'service',
        name: 'A-only component',
        unitPrice: '2.00',
      })
      .returning({ id: catalogItems.id });
    if (!componentA) throw new Error('failed to seed catalog component A');

    // Per-customer sell-price override for itemA under org A (shape-1 org-axis).
    const [pricingA] = await db
      .insert(catalogItemOrgPricing)
      .values({
        catalogItemId: itemA.id,
        orgId: orgA.id,
        unitPrice: '5.00',
      })
      .returning({ id: catalogItemOrgPricing.id });
    if (!pricingA) throw new Error('failed to seed org-pricing override A');

    // Partner-scoped context for partner B (mirrors authMiddleware partner scope).
    const partnerBContext: DbAccessContext = {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: null,
      accessiblePartnerIds: [partnerB.id],
      userId: null,
    };

    // Organization-scoped context for org B.
    const orgBContext: DbAccessContext = {
      scope: 'organization',
      orgId: orgB.id,
      accessibleOrgIds: [orgB.id],
      accessiblePartnerIds: [],
      userId: null,
    };

    return {
      partnerA: { id: partnerA.id },
      orgA: { id: orgA.id },
      partnerB: { id: partnerB.id },
      orgB: { id: orgB.id },
      itemA: { id: itemA.id },
      componentA: { id: componentA.id },
      pricingA: { id: pricingA.id },
      partnerBContext,
      orgBContext,
    };
  });
}

// Best-effort safety net only. setup.ts's beforeEach already TRUNCATEs
// partners/organizations CASCADE before every test (which cascades through the
// catalog FKs), so by the time this runs the catalog rows are already gone and
// these DELETEs typically match zero rows. Kept defensively in case the suite's
// cleanup contract ever changes; it does no harm and never fails the suite.
afterAll(async () => {
  if (seededPartnerIds.length === 0) return;
  await withSystemDbAccessContext(async () => {
    const partnerList = sql.join(
      seededPartnerIds.map((id) => sql`${id}`),
      sql`, `
    );
    // Delete order respects FKs: bundle components → items → orgs → partners.
    await db
      .delete(catalogBundleComponents)
      .where(sql`${catalogBundleComponents.partnerId} IN (${partnerList})`);
    await db
      .delete(catalogItems)
      .where(sql`${catalogItems.partnerId} IN (${partnerList})`);
    await db
      .delete(organizations)
      .where(sql`${organizations.partnerId} IN (${partnerList})`);
    await db.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
  });
});

describe('catalog RLS isolation (breeze_app)', () => {
  // (a) Cross-partner read isolation on catalog_items (shape 3).
  runDb('partner B context cannot read partner A catalog items', async () => {
    const { itemA, partnerBContext } = await seedFixture();

    const rowsB = await withDbAccessContext(partnerBContext, () =>
      db
        .select({ id: catalogItems.id })
        .from(catalogItems)
        .where(eq(catalogItems.id, itemA.id))
    );
    expect(rowsB).toHaveLength(0);
  });

  // (b) Cross-org read isolation on catalog_item_org_pricing (shape 1).
  runDb('org B context cannot read an org-A price override', async () => {
    const { pricingA, orgBContext } = await seedFixture();

    const rowsB = await withDbAccessContext(orgBContext, () =>
      db
        .select({ id: catalogItemOrgPricing.id })
        .from(catalogItemOrgPricing)
        .where(eq(catalogItemOrgPricing.id, pricingA.id))
    );
    expect(rowsB).toHaveLength(0);
  });

  // (b2) Cross-org WRITE isolation on catalog_item_org_pricing: the UPDATE and
  // DELETE policies both use `USING breeze_has_org_access(org_id)`, so an org-B
  // caller's UPDATE/DELETE targeting org A's override row matches zero rows
  // (RLS USING filters it out of the command's scope — no error, just 0 rows
  // affected). The row must remain intact when re-read under system scope. This
  // is the write-side complement to case (b); without the USING clause an org-B
  // caller could silently edit or delete another tenant's price override.
  runDb('org B context UPDATE/DELETE on an org-A price override affects 0 rows; row survives', async () => {
    const { pricingA, orgBContext } = await seedFixture();

    // UPDATE under org B — RLS USING filters org A's row out, so 0 rows change.
    const updated = await withDbAccessContext(orgBContext, () =>
      db
        .update(catalogItemOrgPricing)
        .set({ unitPrice: '999.99' })
        .where(eq(catalogItemOrgPricing.id, pricingA.id))
        .returning({ id: catalogItemOrgPricing.id })
    );
    expect(updated).toHaveLength(0);

    // DELETE under org B — same: 0 rows removed.
    const deleted = await withDbAccessContext(orgBContext, () =>
      db
        .delete(catalogItemOrgPricing)
        .where(eq(catalogItemOrgPricing.id, pricingA.id))
        .returning({ id: catalogItemOrgPricing.id })
    );
    expect(deleted).toHaveLength(0);

    // The override row is untouched: original price intact under system scope.
    const survivor = await withSystemDbAccessContext(() =>
      db
        .select({ id: catalogItemOrgPricing.id, unitPrice: catalogItemOrgPricing.unitPrice })
        .from(catalogItemOrgPricing)
        .where(eq(catalogItemOrgPricing.id, pricingA.id))
    );
    expect(survivor).toHaveLength(1);
    expect(survivor[0]?.unitPrice).toBe('5.00'); // seeded value, not the forged 999.99
  });

  // (c) A forged cross-partner catalog_items insert is rejected by RLS.
  // Drizzle wraps the driver error: the top-level message becomes
  // "Failed query: insert into ...", and the original Postgres error
  // ("new row violates row-level security policy for table
  // \"catalog_items\"", code 42501 = insufficient_privilege) is carried on
  // the wrapper's `cause`. We assert on `cause.code` to match the verified
  // sibling pattern (time-entries-rls.integration.test.ts) rather than the
  // wrapper message, which does not contain the RLS phrase.
  runDb('a forged cross-partner catalog_items insert is rejected by RLS', async () => {
    const { partnerA, partnerBContext } = await seedFixture();

    await expect(
      withDbAccessContext(partnerBContext, () =>
        db.insert(catalogItems).values({
          partnerId: partnerA.id, // wrong partner — RLS must reject
          itemType: 'service',
          name: 'forged',
          unitPrice: '1.00',
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  // (d) A forged cross-partner catalog_bundle_components insert is rejected by
  // RLS. This exercises the flat denormalized-partner_id WITH CHECK policy
  // (deliberately not a nested EXISTS, to avoid the #1016 bound-param bug). The
  // referenced bundle/component items both belong to partner A, so their FKs
  // resolve — the ONLY reason the insert fails is the RLS partner check, which
  // must surface as 42501 (insufficient_privilege), not a 23503 FK violation.
  runDb('a forged cross-partner catalog_bundle_components insert is rejected by RLS', async () => {
    const { partnerA, itemA, componentA, partnerBContext } = await seedFixture();

    await expect(
      withDbAccessContext(partnerBContext, () =>
        db.insert(catalogBundleComponents).values({
          partnerId: partnerA.id, // wrong partner — RLS must reject
          bundleItemId: itemA.id,
          componentItemId: componentA.id,
          quantity: '1',
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
