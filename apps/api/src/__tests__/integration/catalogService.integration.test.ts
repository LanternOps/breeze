/**
 * Real-driver service-layer tests for the product catalog.
 *
 * Runs under vitest.integration.config.ts — the service-under-test connects
 * through the `db` proxy, which inside a `withDbAccessContext(...)` call uses
 * the unprivileged `breeze_app` role (rolbypassrls=f). So the money/derivation
 * logic AND the partner/org RLS isolation are exercised against a real
 * Postgres, not a mock. The earlier route-level test only mocked the service;
 * this file closes that gap (it would fail if the FE2 derivation guards, the
 * nested-bundle flip guard, the ORG_DENIED guard, or the bundle pre-delete
 * validation were removed).
 *
 * Fixture topology (seeded fresh per test under system scope, which bypasses
 * RLS so the seed can write across both partners):
 *   partnerA → orgA, otherOrgA (both under partnerA)
 *   partnerB → orgB           (the cross-partner foil)
 *
 * Why NO memoization: integration/setup.ts runs cleanupDatabase() in a
 * beforeEach that TRUNCATE ... CASCADEs partners/organizations before every
 * test, cascading through the catalog FKs. A cached fixture would hand later
 * tests rows that no longer exist, making the assertions vacuous. Each test
 * re-seeds — matching every sibling *-rls.integration.test.ts.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { catalogItems, catalogItemOrgPricing, catalogBundleComponents } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import {
  createCatalogItem,
  updateCatalogItem,
  setOrgPriceOverride,
  removeOrgPriceOverride,
  setBundleComponents,
  resolvePrice,
  computeBundleEconomics,
  CatalogServiceError,
  type CatalogActor,
} from '../../services/catalogService';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Fixture {
  partnerA: { id: string };
  orgA: { id: string };
  otherOrgA: { id: string };
  partnerB: { id: string };
  orgB: { id: string };
  /** A partner-A actor with system-equivalent org access (accessibleOrgIds=null). */
  actorA: CatalogActor;
  /** Partner-A DB context so service writes run under partner-A RLS. */
  ctxA: DbAccessContext;
}

async function seedFixture(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const otherOrgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });

    const actorA: CatalogActor = {
      userId: null as unknown as string, // createdBy nullable; no real user row needed
      partnerId: partnerA.id,
      accessibleOrgIds: null, // unrestricted org axis unless a test overrides it
    };

    const ctxA: DbAccessContext = {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: null,
      accessiblePartnerIds: [partnerA.id],
      userId: null,
    };

    return {
      partnerA: { id: partnerA.id },
      orgA: { id: orgA.id },
      otherOrgA: { id: otherOrgA.id },
      partnerB: { id: partnerB.id },
      orgB: { id: orgB.id },
      actorA,
      ctxA,
    };
  });
}

// Convenience: a partner-A context that grants a specific accessibleOrgIds set
// on the RLS axis (so an override write for an org in the list actually passes
// the breeze_has_org_access policy at the DB layer too, not just the service
// guard).
function ctxWithOrgs(partnerId: string, orgIds: string[] | null): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

describe('catalogService (breeze_app, real DB)', () => {
  // ---------------------------------------------------------------------------
  // (a) createCatalogItem persistence + derivation
  // ---------------------------------------------------------------------------
  runDb('createCatalogItem: explicit unitPrice persists verbatim', async () => {
    const fx = await seedFixture();
    const item = await withDbAccessContext(fx.ctxA, () =>
      createCatalogItem(
        {
          itemType: 'service',
          name: 'Explicit price',
          billingType: 'one_time',
          unitPrice: 150,
          unitOfMeasure: 'each',
          taxable: true,
          isBundle: false,
          attributes: {},
        },
        fx.actorA
      )
    );
    expect(item.unitPrice).toBe('150.00');
    expect(item.costBasis).toBeNull();

    const persisted = await withSystemDbAccessContext(() =>
      db.select().from(catalogItems).where(eq(catalogItems.id, item.id)).limit(1)
    );
    expect(persisted[0]?.unitPrice).toBe('150.00');
  });

  runDb('createCatalogItem: cost+markup with no explicit price derives the sell price', async () => {
    const fx = await seedFixture();
    const item = await withDbAccessContext(fx.ctxA, () =>
      createCatalogItem(
        {
          itemType: 'hardware',
          name: 'Derived price',
          billingType: 'one_time',
          // 400.00 cost + 25% markup => 500.00
          unitPrice: undefined as unknown as number,
          costBasis: 400,
          markupPercent: 25,
          unitOfMeasure: 'each',
          taxable: true,
          isBundle: false,
          attributes: {},
        },
        fx.actorA
      )
    );
    expect(item.unitPrice).toBe('500.00');
    expect(item.costBasis).toBe('400.00');
    expect(item.markupPercent).toBe('25.00');
  });

  // ---------------------------------------------------------------------------
  // (b) REGRESSION FE2#1 — updateCatalogItem must not over-derive unit_price
  // ---------------------------------------------------------------------------
  async function seedPricedItem(fx: Fixture) {
    return withDbAccessContext(fx.ctxA, () =>
      createCatalogItem(
        {
          itemType: 'hardware',
          name: 'Priced widget',
          billingType: 'one_time',
          unitPrice: 700, // explicit sell price wins over cost*markup at create
          costBasis: 400,
          markupPercent: 25, // 400*1.25 = 500 — deliberately != the explicit 700
          unitOfMeasure: 'each',
          taxable: true,
          isBundle: false,
          attributes: {},
        },
        fx.actorA
      )
    );
  }

  runDb('updateCatalogItem: a {name}-only PATCH leaves unit_price at 700 (no re-derive)', async () => {
    const fx = await seedFixture();
    const item = await seedPricedItem(fx);
    expect(item.unitPrice).toBe('700.00');

    const updated = await withDbAccessContext(fx.ctxA, () =>
      updateCatalogItem(item.id, { name: 'Renamed widget' }, fx.actorA)
    );
    expect(updated.name).toBe('Renamed widget');
    expect(updated.unitPrice).toBe('700.00'); // would collapse to 500.00 if it re-derived
  });

  runDb('updateCatalogItem: an {isActive:false}-only PATCH leaves unit_price at 700', async () => {
    const fx = await seedFixture();
    const item = await seedPricedItem(fx);

    const updated = await withDbAccessContext(fx.ctxA, () =>
      updateCatalogItem(item.id, { isActive: false }, fx.actorA)
    );
    expect(updated.isActive).toBe(false);
    expect(updated.unitPrice).toBe('700.00');
  });

  runDb('updateCatalogItem: a {markupPercent} PATCH WITH cost present re-derives', async () => {
    const fx = await seedFixture();
    const item = await seedPricedItem(fx); // cost 400 stored

    // markup 50 with the existing cost 400 => 600.00
    const updated = await withDbAccessContext(fx.ctxA, () =>
      updateCatalogItem(item.id, { markupPercent: 50 }, fx.actorA)
    );
    expect(updated.markupPercent).toBe('50.00');
    expect(updated.unitPrice).toBe('600.00');
  });

  runDb('updateCatalogItem: a markup-only PATCH with NO cost preserves the price (no 0.00 collapse)', async () => {
    const fx = await seedFixture();
    // Item with an explicit price but NO cost basis at all.
    const item = await withDbAccessContext(fx.ctxA, () =>
      createCatalogItem(
        {
          itemType: 'service',
          name: 'No-cost item',
          billingType: 'one_time',
          unitPrice: 300,
          unitOfMeasure: 'each',
          taxable: true,
          isBundle: false,
          attributes: {},
        },
        fx.actorA
      )
    );
    expect(item.unitPrice).toBe('300.00');
    expect(item.costBasis).toBeNull();

    const updated = await withDbAccessContext(fx.ctxA, () =>
      updateCatalogItem(item.id, { markupPercent: 40 }, fx.actorA)
    );
    expect(updated.markupPercent).toBe('40.00');
    // With no cost to derive from, the price must be preserved, NOT collapsed to 0.00.
    expect(updated.unitPrice).toBe('300.00');
  });

  runDb('updateCatalogItem: an explicit unitPrice PATCH always wins', async () => {
    const fx = await seedFixture();
    const item = await seedPricedItem(fx);

    const updated = await withDbAccessContext(fx.ctxA, () =>
      // cost 400 + markup 25 would derive 500, but explicit 999 must win
      updateCatalogItem(item.id, { unitPrice: 999, markupPercent: 25 }, fx.actorA)
    );
    expect(updated.unitPrice).toBe('999.00');
  });

  // ---------------------------------------------------------------------------
  // (c) REGRESSION FE2#2 — flipping a referenced component to isBundle=true
  // ---------------------------------------------------------------------------
  runDb('updateCatalogItem: flipping a referenced component to isBundle=true throws 409 BUNDLE_NESTED', async () => {
    const fx = await seedFixture();
    // bundle + component, both under partner A
    const bundle = await withDbAccessContext(fx.ctxA, () =>
      createCatalogItem(
        { itemType: 'service', name: 'Outer bundle', billingType: 'one_time', unitPrice: 100, unitOfMeasure: 'each', taxable: true, isBundle: true, attributes: {} },
        fx.actorA
      )
    );
    const component = await withDbAccessContext(fx.ctxA, () =>
      createCatalogItem(
        { itemType: 'service', name: 'Inner component', billingType: 'one_time', unitPrice: 10, unitOfMeasure: 'each', taxable: true, isBundle: false, attributes: {} },
        fx.actorA
      )
    );
    await withDbAccessContext(fx.ctxA, () =>
      setBundleComponents(bundle.id, [{ componentItemId: component.id, quantity: 2, showOnInvoice: false }], fx.actorA)
    );

    // Now try to convert the referenced component itself into a bundle.
    await expect(
      withDbAccessContext(fx.ctxA, () =>
        updateCatalogItem(component.id, { isBundle: true }, fx.actorA)
      )
    ).rejects.toMatchObject({ status: 409, code: 'BUNDLE_NESTED' });

    // Guard must run before the write: the component stays a non-bundle.
    const after = await withSystemDbAccessContext(() =>
      db.select({ isBundle: catalogItems.isBundle }).from(catalogItems).where(eq(catalogItems.id, component.id)).limit(1)
    );
    expect(after[0]?.isBundle).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // (d) ORG_DENIED guard — fires before any DB write, positive case succeeds
  // ---------------------------------------------------------------------------
  runDb('setOrgPriceOverride: actor without the org in accessibleOrgIds is denied 403 before any write', async () => {
    const fx = await seedFixture();
    const item = await seedPricedItem(fx);

    // Actor can only access otherOrgA, but tries to price orgA.
    const restrictedActor: CatalogActor = { ...fx.actorA, accessibleOrgIds: [fx.otherOrgA.id] };

    await expect(
      withDbAccessContext(ctxWithOrgs(fx.partnerA.id, [fx.otherOrgA.id]), () =>
        setOrgPriceOverride(item.id, fx.orgA.id, { unitPrice: 99 }, restrictedActor)
      )
    ).rejects.toMatchObject({ status: 403, code: 'ORG_DENIED' });

    // No override row was written for orgA (guard ran before the insert).
    const rows = await withSystemDbAccessContext(() =>
      db.select().from(catalogItemOrgPricing).where(and(eq(catalogItemOrgPricing.catalogItemId, item.id), eq(catalogItemOrgPricing.orgId, fx.orgA.id)))
    );
    expect(rows).toHaveLength(0);
  });

  runDb('resolvePrice: actor without the org in accessibleOrgIds is denied 403 ORG_DENIED', async () => {
    const fx = await seedFixture();
    const item = await seedPricedItem(fx);
    const restrictedActor: CatalogActor = { ...fx.actorA, accessibleOrgIds: [fx.otherOrgA.id] };

    await expect(
      withDbAccessContext(ctxWithOrgs(fx.partnerA.id, [fx.otherOrgA.id]), () =>
        resolvePrice(item.id, fx.orgA.id, restrictedActor)
      )
    ).rejects.toMatchObject({ status: 403, code: 'ORG_DENIED' });
  });

  runDb('setOrgPriceOverride: positive case (org in accessibleOrgIds) succeeds', async () => {
    const fx = await seedFixture();
    const item = await seedPricedItem(fx);
    const actor: CatalogActor = { ...fx.actorA, accessibleOrgIds: [fx.orgA.id] };

    const row = await withDbAccessContext(ctxWithOrgs(fx.partnerA.id, [fx.orgA.id]), () =>
      setOrgPriceOverride(item.id, fx.orgA.id, { unitPrice: 88 }, actor)
    );
    expect(row.unitPrice).toBe('88.00');
    expect(row.orgId).toBe(fx.orgA.id);
  });

  // ---------------------------------------------------------------------------
  // (e) setOrgPriceOverride insert-then-upsert idempotency
  // ---------------------------------------------------------------------------
  runDb('setOrgPriceOverride: second call for same item+org updates, does not duplicate', async () => {
    const fx = await seedFixture();
    const item = await seedPricedItem(fx);
    const ctx = ctxWithOrgs(fx.partnerA.id, [fx.orgA.id]);
    const actor: CatalogActor = { ...fx.actorA, accessibleOrgIds: [fx.orgA.id] };

    const first = await withDbAccessContext(ctx, () => setOrgPriceOverride(item.id, fx.orgA.id, { unitPrice: 10 }, actor));
    const second = await withDbAccessContext(ctx, () => setOrgPriceOverride(item.id, fx.orgA.id, { unitPrice: 20 }, actor));

    expect(first.id).toBe(second.id); // same row, upserted
    expect(second.unitPrice).toBe('20.00');

    const rows = await withSystemDbAccessContext(() =>
      db.select().from(catalogItemOrgPricing).where(and(eq(catalogItemOrgPricing.catalogItemId, item.id), eq(catalogItemOrgPricing.orgId, fx.orgA.id)))
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.unitPrice).toBe('20.00');
  });

  runDb('removeOrgPriceOverride: deletes the override row', async () => {
    const fx = await seedFixture();
    const item = await seedPricedItem(fx);
    const ctx = ctxWithOrgs(fx.partnerA.id, [fx.orgA.id]);
    const actor: CatalogActor = { ...fx.actorA, accessibleOrgIds: [fx.orgA.id] };

    await withDbAccessContext(ctx, () => setOrgPriceOverride(item.id, fx.orgA.id, { unitPrice: 10 }, actor));
    await withDbAccessContext(ctx, () => removeOrgPriceOverride(item.id, fx.orgA.id, actor));

    const rows = await withSystemDbAccessContext(() =>
      db.select().from(catalogItemOrgPricing).where(and(eq(catalogItemOrgPricing.catalogItemId, item.id), eq(catalogItemOrgPricing.orgId, fx.orgA.id)))
    );
    expect(rows).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // (f) setBundleComponents — valid set, each failure mode, survival on failure
  // ---------------------------------------------------------------------------
  async function seedBundleAndComponents(fx: Fixture) {
    const bundle = await withDbAccessContext(fx.ctxA, () =>
      createCatalogItem(
        { itemType: 'service', name: 'Bundle', billingType: 'one_time', unitPrice: 100, costBasis: 0, unitOfMeasure: 'each', taxable: true, isBundle: true, attributes: {} },
        fx.actorA
      )
    );
    const comp1 = await withDbAccessContext(fx.ctxA, () =>
      createCatalogItem(
        { itemType: 'hardware', name: 'Comp 1', billingType: 'one_time', unitPrice: 30, costBasis: 20, unitOfMeasure: 'each', taxable: true, isBundle: false, attributes: {} },
        fx.actorA
      )
    );
    const comp2 = await withDbAccessContext(fx.ctxA, () =>
      createCatalogItem(
        { itemType: 'hardware', name: 'Comp 2', billingType: 'one_time', unitPrice: 50, costBasis: 35, unitOfMeasure: 'each', taxable: true, isBundle: false, attributes: {} },
        fx.actorA
      )
    );
    // A nested-bundle candidate (itself a bundle) under partner A.
    const innerBundle = await withDbAccessContext(fx.ctxA, () =>
      createCatalogItem(
        { itemType: 'service', name: 'Inner bundle', billingType: 'one_time', unitPrice: 5, unitOfMeasure: 'each', taxable: true, isBundle: true, attributes: {} },
        fx.actorA
      )
    );
    return { bundle, comp1, comp2, innerBundle };
  }

  runDb('setBundleComponents: a valid set persists the components', async () => {
    const fx = await seedFixture();
    const { bundle, comp1, comp2 } = await seedBundleAndComponents(fx);

    await withDbAccessContext(fx.ctxA, () =>
      setBundleComponents(
        bundle.id,
        [
          { componentItemId: comp1.id, quantity: 2, showOnInvoice: false },
          { componentItemId: comp2.id, quantity: 1, showOnInvoice: true },
        ],
        fx.actorA
      )
    );

    const rows = await withSystemDbAccessContext(() =>
      db.select().from(catalogBundleComponents).where(eq(catalogBundleComponents.bundleItemId, bundle.id))
    );
    expect(rows).toHaveLength(2);
  });

  runDb('setBundleComponents: failing sets map to the right code AND original components survive', async () => {
    const fx = await seedFixture();
    const { bundle, comp1, comp2, innerBundle } = await seedBundleAndComponents(fx);

    // Establish a valid baseline of 2 components first.
    await withDbAccessContext(fx.ctxA, () =>
      setBundleComponents(
        bundle.id,
        [
          { componentItemId: comp1.id, quantity: 1, showOnInvoice: false },
          { componentItemId: comp2.id, quantity: 1, showOnInvoice: false },
        ],
        fx.actorA
      )
    );

    const baselineCount = async () =>
      (await withSystemDbAccessContext(() =>
        db.select().from(catalogBundleComponents).where(eq(catalogBundleComponents.bundleItemId, bundle.id))
      )).length;
    expect(await baselineCount()).toBe(2);

    // Cross-partner component (belongs to partner B).
    const crossPartnerComp = await withSystemDbAccessContext(async () => {
      const [row] = await db
        .insert(catalogItems)
        .values({ partnerId: fx.partnerB.id, itemType: 'service', name: 'B comp', unitPrice: '1.00' })
        .returning({ id: catalogItems.id });
      return row!.id;
    });

    const NONEXISTENT = '00000000-0000-0000-0000-000000000000';

    const cases: Array<{ name: string; components: Parameters<typeof setBundleComponents>[1]; code: string; status: number }> = [
      {
        name: 'self-reference',
        components: [{ componentItemId: bundle.id, quantity: 1, showOnInvoice: false }],
        code: 'BUNDLE_SELF_REFERENCE',
        status: 400,
      },
      {
        name: 'nested bundle',
        components: [{ componentItemId: innerBundle.id, quantity: 1, showOnInvoice: false }],
        code: 'BUNDLE_NESTED',
        status: 400,
      },
      {
        name: 'duplicate component',
        components: [
          { componentItemId: comp1.id, quantity: 1, showOnInvoice: false },
          { componentItemId: comp1.id, quantity: 2, showOnInvoice: false },
        ],
        code: 'BUNDLE_DUPLICATE_COMPONENT',
        status: 400,
      },
      {
        name: 'component not found',
        components: [{ componentItemId: NONEXISTENT, quantity: 1, showOnInvoice: false }],
        code: 'BUNDLE_COMPONENT_NOT_FOUND',
        status: 404,
      },
    ];

    for (const tc of cases) {
      await expect(
        withDbAccessContext(fx.ctxA, () => setBundleComponents(bundle.id, tc.components, fx.actorA)),
        `case ${tc.name}`
      ).rejects.toMatchObject({ status: tc.status, code: tc.code });
      // detect() runs BEFORE the replace-set delete — the baseline survives.
      expect(await baselineCount(), `case ${tc.name} survival`).toBe(2);
    }

    // Cross-partner case must be exercised under a context whose RLS axis can
    // actually SEE the partner-B component — otherwise the metaRows lookup
    // returns nothing and the service reports COMPONENT_NOT_FOUND (404) before
    // ever reaching the CROSS_PARTNER branch. A partner-A actor whose
    // accessiblePartnerIds includes BOTH partners makes the foreign row visible
    // to the lookup, so detectBundleProblems sees meta.partnerId (B) !=
    // bundlePartnerId (A) and raises CROSS_PARTNER. The actor.partnerId is still
    // partner A (the bundle's owner) so getOwnedItemOr404 passes.
    const dualPartnerCtx: DbAccessContext = {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: null,
      accessiblePartnerIds: [fx.partnerA.id, fx.partnerB.id],
      userId: null,
    };
    await expect(
      withDbAccessContext(dualPartnerCtx, () =>
        setBundleComponents(bundle.id, [{ componentItemId: crossPartnerComp, quantity: 1, showOnInvoice: false }], fx.actorA)
      ),
      'case cross-partner'
    ).rejects.toMatchObject({ status: 400, code: 'BUNDLE_CROSS_PARTNER' });
    expect(await baselineCount(), 'case cross-partner survival').toBe(2);
  });

  runDb('setBundleComponents: an empty array clears the set', async () => {
    const fx = await seedFixture();
    const { bundle, comp1 } = await seedBundleAndComponents(fx);
    await withDbAccessContext(fx.ctxA, () =>
      setBundleComponents(bundle.id, [{ componentItemId: comp1.id, quantity: 1, showOnInvoice: false }], fx.actorA)
    );
    expect(
      (await withSystemDbAccessContext(() => db.select().from(catalogBundleComponents).where(eq(catalogBundleComponents.bundleItemId, bundle.id)))).length
    ).toBe(1);

    await withDbAccessContext(fx.ctxA, () => setBundleComponents(bundle.id, [], fx.actorA));
    expect(
      (await withSystemDbAccessContext(() => db.select().from(catalogBundleComponents).where(eq(catalogBundleComponents.bundleItemId, bundle.id)))).length
    ).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // (g) resolvePrice override-vs-item; computeBundleEconomics
  // ---------------------------------------------------------------------------
  runDb('resolvePrice: returns the item price with no override, the override when one exists', async () => {
    const fx = await seedFixture();
    const item = await seedPricedItem(fx); // unit_price 700, cost 400
    const ctx = ctxWithOrgs(fx.partnerA.id, [fx.orgA.id]);
    const actor: CatalogActor = { ...fx.actorA, accessibleOrgIds: [fx.orgA.id] };

    const baseResolved = await withDbAccessContext(ctx, () => resolvePrice(item.id, fx.orgA.id, actor));
    expect(baseResolved.unitPrice).toBe('700.00');
    expect(baseResolved.source).toBe('item');

    await withDbAccessContext(ctx, () => setOrgPriceOverride(item.id, fx.orgA.id, { unitPrice: 555 }, actor));

    const overridden = await withDbAccessContext(ctx, () => resolvePrice(item.id, fx.orgA.id, actor));
    expect(overridden.unitPrice).toBe('555.00');
    expect(overridden.source).toBe('org_override');
    expect(overridden.costBasis).toBe('400.00'); // cost basis always from the item
  });

  runDb('computeBundleEconomics: sums seeded component costs against the headline price', async () => {
    const fx = await seedFixture();
    const { bundle, comp1, comp2 } = await seedBundleAndComponents(fx); // bundle price 100
    await withDbAccessContext(fx.ctxA, () =>
      setBundleComponents(
        bundle.id,
        [
          // comp1 cost 20 * qty 2 = 40 ; comp2 cost 35 * qty 1 = 35 ; total 75
          { componentItemId: comp1.id, quantity: 2, showOnInvoice: false },
          { componentItemId: comp2.id, quantity: 1, showOnInvoice: false },
        ],
        fx.actorA
      )
    );

    const econ = await withDbAccessContext(fx.ctxA, () => computeBundleEconomics(bundle.id, null, fx.actorA));
    expect(econ.headlinePrice).toBe('100.00');
    expect(econ.totalCost).toBe('75.00');
    expect(econ.margin).toBe('25.00');
    expect(econ.marginPct).toBe(25);
  });

  runDb('updateCatalogItem: flipping a bundle to a plain item clears its components (no orphans)', async () => {
    const fx = await seedFixture();
    const { bundle, comp1 } = await seedBundleAndComponents(fx);
    await withDbAccessContext(fx.ctxA, () =>
      setBundleComponents(bundle.id, [{ componentItemId: comp1.id, quantity: 1, showOnInvoice: false }], fx.actorA));

    const before = await withSystemDbAccessContext(() =>
      db.select().from(catalogBundleComponents).where(eq(catalogBundleComponents.bundleItemId, bundle.id)));
    expect(before).toHaveLength(1);

    // true -> false must drop the component rows so they can't resurface later.
    await withDbAccessContext(fx.ctxA, () => updateCatalogItem(bundle.id, { isBundle: false }, fx.actorA));

    const after = await withSystemDbAccessContext(() =>
      db.select().from(catalogBundleComponents).where(eq(catalogBundleComponents.bundleItemId, bundle.id)));
    expect(after).toHaveLength(0);
  });
});
