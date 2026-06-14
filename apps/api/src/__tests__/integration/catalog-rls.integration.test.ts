/**
 * Real-driver cross-tenant forge tests for the product catalog.
 *
 * Runs under vitest.integration.config.ts — code-under-test connects as the
 * unprivileged `breeze_app` role (rolbypassrls=f), so RLS is actually
 * enforced. If `.env.test` is missing the symlink that pins this to the
 * breeze_app role, these tests would pass vacuously on a BYPASSRLS admin
 * connection (see memory: worktree_env_test_rls_vacuous) — the forged-insert
 * assertion (case c) is the guard that catches that.
 *
 * Fixture topology (seeded under system scope, which bypasses RLS):
 *   partnerA → orgA
 *   partnerB → orgB
 *   itemA      = catalog_items row under partnerA
 *   pricingA   = catalog_item_org_pricing override for itemA under orgA
 *
 * Required coverage (3 cases):
 *   (a) partner B context reading partner A's catalog_items row → 0 rows
 *   (b) org B context reading org A's catalog_item_org_pricing row → 0 rows
 *   (c) a forged cross-partner catalog_items INSERT (partner B context,
 *       partnerId=partnerA) is rejected with an RLS violation.
 *
 * Teardown: delete only the partners this file seeds; FK cascades remove the
 * catalog rows (catalog_item_org_pricing → catalog_items ON DELETE CASCADE;
 * catalog_items → partners via FK, deleted explicitly in order).
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
  organizations,
  partners,
} from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const seededPartnerIds: string[] = [];

interface Fixture {
  partnerA: { id: string };
  orgA: { id: string };
  partnerB: { id: string };
  orgB: { id: string };
  itemA: { id: string };
  pricingA: { id: string };
  partnerBContext: DbAccessContext;
  orgBContext: DbAccessContext;
}

let fixture: Fixture | null = null;

async function seedFixture(): Promise<Fixture> {
  if (fixture) return fixture;

  fixture = await withSystemDbAccessContext(async () => {
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
      pricingA: { id: pricingA.id },
      partnerBContext,
      orgBContext,
    };
  });

  return fixture;
}

afterAll(async () => {
  if (seededPartnerIds.length === 0) return;
  await withSystemDbAccessContext(async () => {
    const partnerList = sql.join(
      seededPartnerIds.map((id) => sql`${id}`),
      sql`, `
    );
    // catalog_item_org_pricing cascades from catalog_items (ON DELETE CASCADE)
    // and catalog_items cascades nothing into partners — delete items by
    // partner first, then orgs, then partners.
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

  // (c) A forged cross-partner insert is rejected by RLS.
  // Drizzle wraps the driver error: the top-level message becomes
  // "Failed query: insert into ...", and the original Postgres error
  // ("new row violates row-level security policy for table
  // \"catalog_items\"", code 42501 = insufficient_privilege) is carried on
  // the wrapper's `cause`. We assert on `cause.code` to match the verified
  // sibling pattern (time-entries-rls.integration.test.ts) rather than the
  // wrapper message, which does not contain the RLS phrase.
  runDb('a forged cross-partner insert is rejected by RLS', async () => {
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
});
