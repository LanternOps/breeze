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
import { catalogItems, catalogItemOrgPricing, catalogItemPrices, catalogBundleComponents } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import {
  applyImportedPricingBySku,
  createCatalogItem,
  updateCatalogItem,
  setOrgPriceOverride,
  removeOrgPriceOverride,
  setBundleComponents,
  setItemPrice,
  removeItemPrice,
  listItemPrices,
  listCatalogItems,
  getCatalogItem,
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
        resolvePrice(item.id, 'USD', fx.orgA.id, restrictedActor)
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

  runDb('setBundleComponents: a fractional allocation in a zero-decimal currency is refused, and the previous set survives', async () => {
    const fx = await seedFixture();
    const { bundle, comp1, comp2 } = await seedBundleAndComponents(fx);

    // Baseline: a representable JPY allocation persists.
    await withDbAccessContext(fx.ctxA, () =>
      setBundleComponents(
        bundle.id,
        [{ componentItemId: comp1.id, quantity: 1, showOnInvoice: true, revenueAllocation: 100 }],
        fx.actorA,
        'JPY'
      )
    );

    // Wave-6 review: an allocation is persisted money stamped with its own
    // currency and is copied verbatim onto a same-currency invoice line, so a
    // fractional yen must be a 400 — never a silent round.
    await expect(
      withDbAccessContext(fx.ctxA, () =>
        setBundleComponents(
          bundle.id,
          [{ componentItemId: comp2.id, quantity: 1, showOnInvoice: true, revenueAllocation: 100.5 }],
          fx.actorA,
          'JPY'
        )
      )
    ).rejects.toMatchObject({ status: 400, code: 'PRICE_NOT_REPRESENTABLE' });

    // The rejection happens before the replace-set delete: the baseline stands.
    const rows = await withSystemDbAccessContext(() =>
      db.select().from(catalogBundleComponents).where(eq(catalogBundleComponents.bundleItemId, bundle.id))
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.componentItemId).toBe(comp1.id);
    expect(rows[0]!.revenueAllocation).toBe('100.00');

    // The same amount in a two-decimal currency is still accepted.
    await withDbAccessContext(fx.ctxA, () =>
      setBundleComponents(
        bundle.id,
        [{ componentItemId: comp2.id, quantity: 1, showOnInvoice: true, revenueAllocation: 100.5 }],
        fx.actorA,
        'EUR'
      )
    );
    const eurRows = await withSystemDbAccessContext(() =>
      db.select().from(catalogBundleComponents).where(eq(catalogBundleComponents.bundleItemId, bundle.id))
    );
    expect(eurRows).toHaveLength(1);
    expect(eurRows[0]!.revenueAllocation).toBe('100.50');
    expect(eurRows[0]!.allocationCurrency).toBe('EUR');
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
        .values({ partnerId: fx.partnerB.id, itemType: 'service', name: 'B comp', unitPrice: '1.00', costCurrency: 'USD' })
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

    const baseResolved = await withDbAccessContext(ctx, () => resolvePrice(item.id, 'USD', fx.orgA.id, actor));
    expect(baseResolved.unitPrice).toBe('700.00');
    expect(baseResolved.source).toBe('price_book');
    expect(baseResolved.currencyCode).toBe('USD');
    expect(baseResolved.marginAvailable).toBe(true);

    await withDbAccessContext(ctx, () => setOrgPriceOverride(item.id, fx.orgA.id, { unitPrice: 555 }, actor));

    const overridden = await withDbAccessContext(ctx, () => resolvePrice(item.id, 'USD', fx.orgA.id, actor));
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

    const econ = await withDbAccessContext(fx.ctxA, () => computeBundleEconomics(bundle.id, 'USD', null, fx.actorA));
    expect(econ.headlinePrice).toBe('100.00');
    expect(econ.priceBookComplete).toBe(true);
    expect(econ.marginAvailable).toBe(true);
    expect(econ.totalCost).toBe('75.00');
    expect(econ.margin).toBe('25.00');
    expect(econ.marginPct).toBe(25);
  });

  // ---------------------------------------------------------------------------
  // (g2) Multi-currency wave 3 — price book, resolver gaps, overrides, economics
  // ---------------------------------------------------------------------------
  async function seedMultiCurrencyItem(fx: Fixture) {
    return withDbAccessContext(fx.ctxA, () =>
      createCatalogItem(
        {
          itemType: 'service',
          name: 'Multi-currency widget',
          billingType: 'one_time',
          prices: [{ currencyCode: 'EUR', unitPrice: 10 }, { currencyCode: 'USD', unitPrice: 12 }],
          unitOfMeasure: 'each',
          taxable: true,
          isBundle: false,
          attributes: {},
        },
        fx.actorA
      )
    );
  }

  const priceRowsFor = (itemId: string) =>
    withSystemDbAccessContext(() =>
      db.select().from(catalogItemPrices).where(eq(catalogItemPrices.itemId, itemId)).orderBy(catalogItemPrices.currencyCode)
    );

  runDb('createCatalogItem: prices [EUR 10, USD 12] under a USD partner → two book rows, mirror 12.00, costCurrency USD', async () => {
    const fx = await seedFixture();
    const item = await seedMultiCurrencyItem(fx);
    expect(item.unitPrice).toBe('12.00');
    expect(item.costCurrency).toBe('USD');
    const rows = await priceRowsFor(item.id);
    expect(rows.map((r) => [r.currencyCode, r.unitPrice, r.partnerId])).toEqual([
      ['EUR', '10.00', fx.partnerA.id],
      ['USD', '12.00', fx.partnerA.id],
    ]);
    const detail = await withDbAccessContext(fx.ctxA, () => getCatalogItem(item.id, fx.actorA));
    expect(detail.prices.map((p) => p.currencyCode)).toEqual(['EUR', 'USD']);
  });

  runDb('resolvePrice: EUR resolves from the price book; org override in EUR wins for EUR only; GBP is a typed gap', async () => {
    const fx = await seedFixture();
    const item = await seedMultiCurrencyItem(fx);
    const ctx = ctxWithOrgs(fx.partnerA.id, [fx.orgA.id]);
    const actor: CatalogActor = { ...fx.actorA, accessibleOrgIds: [fx.orgA.id] };

    const eur = await withDbAccessContext(ctx, () => resolvePrice(item.id, 'EUR', fx.orgA.id, actor));
    expect(eur).toMatchObject({ unitPrice: '10.00', currencyCode: 'EUR', source: 'price_book', marginAvailable: false });

    const override = await withDbAccessContext(ctx, () =>
      setOrgPriceOverride(item.id, fx.orgA.id, { unitPrice: 9, currencyCode: 'EUR' }, actor));
    expect(override.currencyCode).toBe('EUR');
    expect(override.partnerId).toBe(fx.partnerA.id);

    const eurOverridden = await withDbAccessContext(ctx, () => resolvePrice(item.id, 'EUR', fx.orgA.id, actor));
    expect(eurOverridden).toMatchObject({ unitPrice: '9.00', source: 'org_override' });
    const usd = await withDbAccessContext(ctx, () => resolvePrice(item.id, 'USD', fx.orgA.id, actor));
    expect(usd).toMatchObject({ unitPrice: '12.00', source: 'price_book' }); // EUR override skipped

    await expect(withDbAccessContext(ctx, () => resolvePrice(item.id, 'GBP', fx.orgA.id, actor)))
      .rejects.toMatchObject({ status: 409, code: 'NO_PRICE_FOR_CURRENCY' });
  });

  runDb('setItemPrice adds a GBP row (resolvable); removeItemPrice reopens the gap; partner-currency edits mirror unit_price', async () => {
    const fx = await seedFixture();
    const item = await seedMultiCurrencyItem(fx);

    const gbp = await withDbAccessContext(fx.ctxA, () => setItemPrice(item.id, 'GBP', { unitPrice: 8 }, fx.actorA));
    expect(gbp).toMatchObject({ currencyCode: 'GBP', unitPrice: '8.00', partnerId: fx.partnerA.id });
    const resolved = await withDbAccessContext(fx.ctxA, () => resolvePrice(item.id, 'GBP', null, fx.actorA));
    expect(resolved.unitPrice).toBe('8.00');
    expect((await withDbAccessContext(fx.ctxA, () => listItemPrices(item.id, fx.actorA))).map((p) => p.currencyCode)).toEqual(['EUR', 'GBP', 'USD']);

    await withDbAccessContext(fx.ctxA, () => removeItemPrice(item.id, 'GBP', fx.actorA));
    await expect(withDbAccessContext(fx.ctxA, () => resolvePrice(item.id, 'GBP', null, fx.actorA)))
      .rejects.toMatchObject({ status: 409, code: 'NO_PRICE_FOR_CURRENCY' });

    // Upsert on (item, currency) + partner-currency mirror.
    const usd = await withDbAccessContext(fx.ctxA, () => setItemPrice(item.id, 'USD', { unitPrice: 15 }, fx.actorA));
    expect(usd.unitPrice).toBe('15.00');
    expect((await priceRowsFor(item.id)).filter((r) => r.currencyCode === 'USD')).toHaveLength(1);
    let mirror = await withSystemDbAccessContext(() =>
      db.select({ unitPrice: catalogItems.unitPrice }).from(catalogItems).where(eq(catalogItems.id, item.id)).limit(1));
    expect(mirror[0]?.unitPrice).toBe('15.00');

    await withDbAccessContext(fx.ctxA, () => removeItemPrice(item.id, 'USD', fx.actorA));
    mirror = await withSystemDbAccessContext(() =>
      db.select({ unitPrice: catalogItems.unitPrice }).from(catalogItems).where(eq(catalogItems.id, item.id)).limit(1));
    expect(mirror[0]?.unitPrice).toBe('0.00');
  });

  runDb('setItemPrice: JPY 100.5 → PRICE_NOT_REPRESENTABLE; setOrgPriceOverride JPY 10.5 → PRICE_NOT_REPRESENTABLE', async () => {
    const fx = await seedFixture();
    const item = await seedMultiCurrencyItem(fx);
    await expect(withDbAccessContext(fx.ctxA, () => setItemPrice(item.id, 'JPY', { unitPrice: 100.5 }, fx.actorA)))
      .rejects.toMatchObject({ status: 400, code: 'PRICE_NOT_REPRESENTABLE' });
    const ctx = ctxWithOrgs(fx.partnerA.id, [fx.orgA.id]);
    const actor: CatalogActor = { ...fx.actorA, accessibleOrgIds: [fx.orgA.id] };
    await expect(withDbAccessContext(ctx, () =>
      setOrgPriceOverride(item.id, fx.orgA.id, { unitPrice: 10.5, currencyCode: 'JPY' }, actor)))
      .rejects.toMatchObject({ status: 400, code: 'PRICE_NOT_REPRESENTABLE' });
    expect((await priceRowsFor(item.id)).map((r) => r.currencyCode)).toEqual(['EUR', 'USD']);
  });

  runDb('resolvePrice (#3775 review #4): a forged legacy JPY 100.50 book row / 10.50 override is a typed PRICE_NOT_REPRESENTABLE gap; a fractional-yen cost voids margin', async () => {
    const fx = await seedFixture();
    const item = await seedMultiCurrencyItem(fx);
    // Forge what the 2026-08-29 backfills preserve: a sub-unit amount in a
    // zero-decimal currency, inserted under system scope past the service guard.
    await withSystemDbAccessContext(() =>
      db.insert(catalogItemPrices).values({ itemId: item.id, partnerId: fx.partnerA.id, currencyCode: 'JPY', unitPrice: '100.50' }));
    const ctx = ctxWithOrgs(fx.partnerA.id, [fx.orgA.id]);
    const actor: CatalogActor = { ...fx.actorA, accessibleOrgIds: [fx.orgA.id] };

    await expect(withDbAccessContext(ctx, () => resolvePrice(item.id, 'JPY', fx.orgA.id, actor)))
      .rejects.toMatchObject({ status: 409, code: 'PRICE_NOT_REPRESENTABLE' });
    await expect(withDbAccessContext(fx.ctxA, () => resolvePrice(item.id, 'JPY', null, fx.actorA)))
      .rejects.toMatchObject({ status: 409, code: 'PRICE_NOT_REPRESENTABLE' });

    // Repairing the row through the service makes it resolvable again.
    await withDbAccessContext(fx.ctxA, () => setItemPrice(item.id, 'JPY', { unitPrice: 101 }, fx.actorA));
    expect(await withDbAccessContext(ctx, () => resolvePrice(item.id, 'JPY', fx.orgA.id, actor)))
      .toMatchObject({ unitPrice: '101.00', source: 'price_book' });

    // A forged fractional-yen org override wins the resolution order and is
    // refused — it does NOT fall through to the (valid) book row.
    await withSystemDbAccessContext(() =>
      db.insert(catalogItemOrgPricing).values({ catalogItemId: item.id, orgId: fx.orgA.id, partnerId: fx.partnerA.id, currencyCode: 'JPY', unitPrice: '10.50' }));
    await expect(withDbAccessContext(ctx, () => resolvePrice(item.id, 'JPY', fx.orgA.id, actor)))
      .rejects.toMatchObject({ status: 409, code: 'PRICE_NOT_REPRESENTABLE' });
    // ...while an org without the override still resolves from the repaired book row.
    expect(await withDbAccessContext(fx.ctxA, () => resolvePrice(item.id, 'JPY', null, fx.actorA)))
      .toMatchObject({ unitPrice: '101.00' });

    // A forged fractional-yen legacy COST is not an error but a margin gap:
    // costBasis null / marginAvailable false, so no document snapshots 100.50.
    await withSystemDbAccessContext(() =>
      db.update(catalogItems).set({ costBasis: '100.50', costCurrency: 'JPY' }).where(eq(catalogItems.id, item.id)));
    expect(await withDbAccessContext(fx.ctxA, () => resolvePrice(item.id, 'JPY', null, fx.actorA)))
      .toMatchObject({ unitPrice: '101.00', costBasis: null, costCurrency: 'JPY', marginAvailable: false });
  });

  runDb('computeBundleEconomics (#3775 review #8): JPY economics round at the yen — cost 101 × 0.5 is 51, never 50.50; a fractional-yen cost voids margin', async () => {
    const fx = await seedFixture();
    const mk = (name: string, price: number, cost: number | undefined) => withDbAccessContext(fx.ctxA, () =>
      createCatalogItem(
        { itemType: 'hardware', name, billingType: 'one_time', prices: [{ currencyCode: 'JPY', unitPrice: price }], costBasis: cost, costCurrency: 'JPY', unitOfMeasure: 'each', taxable: true, isBundle: name === 'JPY bundle', attributes: {} },
        fx.actorA
      ));
    const bundle = await mk('JPY bundle', 1000, undefined);
    const compA = await mk('Comp A', 300, 101);
    const compB = await mk('Comp B', 700, 250);
    await withDbAccessContext(fx.ctxA, () =>
      setBundleComponents(bundle.id, [
        { componentItemId: compA.id, quantity: 0.5, showOnInvoice: true, revenueAllocation: 600 },
        { componentItemId: compB.id, quantity: 1, showOnInvoice: true, revenueAllocation: 400 },
      ], fx.actorA, 'JPY'));

    const econ = await withDbAccessContext(fx.ctxA, () => computeBundleEconomics(bundle.id, 'JPY', null, fx.actorA));
    expect(econ).toMatchObject({
      currencyCode: 'JPY', headlinePrice: '1000.00', priceBookComplete: true, marginAvailable: true,
      totalCost: '301.00', margin: '699.00', marginPct: 69.9, allocationTotal: '1000.00', allocationMatchesHeadline: true,
    });

    // Forged legacy fractional-yen component cost → margin unavailable, totals withheld.
    await withSystemDbAccessContext(() =>
      db.update(catalogItems).set({ costBasis: '250.50' }).where(eq(catalogItems.id, compB.id)));
    const legacy = await withDbAccessContext(fx.ctxA, () => computeBundleEconomics(bundle.id, 'JPY', null, fx.actorA));
    expect(legacy).toMatchObject({ priceBookComplete: true, marginAvailable: false, totalCost: null, margin: null, marginPct: null });
  });

  // #3775 review #1: the bundle's OWN headline gap is a null headline, whatever
  // its reason. A forged legacy fractional-yen headline row must not escape as a
  // raw CatalogServiceError (which reaches the route as a 500 through
  // addBundleLine, and contradicts this contract on GET /:id/economics).
  runDb('computeBundleEconomics (#3775 review #1): a non-representable headline is a typed GAP, not a throw', async () => {
    const fx = await seedFixture();
    const mk = (name: string, isBundle: boolean) => withDbAccessContext(fx.ctxA, () =>
      createCatalogItem(
        { itemType: 'hardware', name, billingType: 'one_time', prices: [{ currencyCode: 'JPY', unitPrice: 500 }], unitOfMeasure: 'each', taxable: true, isBundle, attributes: {} },
        fx.actorA
      ));
    const bundle = await mk('JPY gap bundle', true);
    const comp = await mk('JPY gap comp', false);
    await withDbAccessContext(fx.ctxA, () =>
      setBundleComponents(bundle.id, [{ componentItemId: comp.id, quantity: 1, showOnInvoice: true }], fx.actorA));

    // Sanity: a representable headline resolves with no gap.
    expect(await withDbAccessContext(fx.ctxA, () => computeBundleEconomics(bundle.id, 'JPY', null, fx.actorA)))
      .toMatchObject({ headlinePrice: '500.00', headlineGap: null, priceBookComplete: true });

    // Forge what the backfills preserve: a sub-unit amount in a zero-decimal currency.
    await withSystemDbAccessContext(() =>
      db.update(catalogItemPrices).set({ unitPrice: '100.50' })
        .where(and(eq(catalogItemPrices.itemId, bundle.id), eq(catalogItemPrices.currencyCode, 'JPY'))));

    const econ = await withDbAccessContext(fx.ctxA, () => computeBundleEconomics(bundle.id, 'JPY', null, fx.actorA));
    expect(econ).toMatchObject({
      headlinePrice: null, headlineGap: 'PRICE_NOT_REPRESENTABLE', priceBookComplete: false,
      totalCost: null, margin: null,
    });
    expect(econ.headlineGapMessage).toContain('not representable in JPY');

    // A missing row (no gap reason to state) still reports the ordinary gap.
    await withSystemDbAccessContext(() =>
      db.delete(catalogItemPrices).where(and(eq(catalogItemPrices.itemId, bundle.id), eq(catalogItemPrices.currencyCode, 'JPY'))));
    expect(await withDbAccessContext(fx.ctxA, () => computeBundleEconomics(bundle.id, 'JPY', null, fx.actorA)))
      .toMatchObject({ headlinePrice: null, headlineGap: 'NO_PRICE_FOR_CURRENCY', headlineGapMessage: null });
  });

  runDb('setBundleComponents (#3775 review #7): stamps allocation_currency on allocation rows only; refuses an allocation without a currency; the CHECK rejects a forged row', async () => {
    const fx = await seedFixture();
    const { bundle, comp1, comp2 } = await seedBundleAndComponents(fx);

    await expect(withDbAccessContext(fx.ctxA, () =>
      setBundleComponents(bundle.id, [{ componentItemId: comp1.id, quantity: 1, showOnInvoice: false, revenueAllocation: 60 }], fx.actorA)
    )).rejects.toMatchObject({ status: 400, code: 'ALLOCATION_CURRENCY_REQUIRED' });

    await withDbAccessContext(fx.ctxA, () =>
      setBundleComponents(bundle.id, [
        { componentItemId: comp1.id, quantity: 1, showOnInvoice: false, revenueAllocation: 60 },
        { componentItemId: comp2.id, quantity: 1, showOnInvoice: false },
      ], fx.actorA, 'usd'));
    const rows = await withSystemDbAccessContext(() =>
      db.select({ componentItemId: catalogBundleComponents.componentItemId, revenueAllocation: catalogBundleComponents.revenueAllocation, allocationCurrency: catalogBundleComponents.allocationCurrency })
        .from(catalogBundleComponents).where(eq(catalogBundleComponents.bundleItemId, bundle.id)));
    expect(rows.find((r) => r.componentItemId === comp1.id)).toMatchObject({ revenueAllocation: '60.00', allocationCurrency: 'USD' });
    expect(rows.find((r) => r.componentItemId === comp2.id)).toMatchObject({ revenueAllocation: null, allocationCurrency: null });

    // DB backstop: an allocation with no currency is a 23514 even from a system context.
    await expect(withSystemDbAccessContext(() =>
      db.update(catalogBundleComponents).set({ allocationCurrency: null })
        .where(and(eq(catalogBundleComponents.bundleItemId, bundle.id), eq(catalogBundleComponents.componentItemId, comp1.id)))
    )).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  runDb('computeBundleEconomics (#3775 review #7): USD-authored allocations are unavailable in EUR — never compared with or relabelled to the EUR headline', async () => {
    const fx = await seedFixture();
    const mk = (name: string, isBundle: boolean) => withDbAccessContext(fx.ctxA, () =>
      createCatalogItem(
        { itemType: 'service', name, billingType: 'one_time', prices: [{ currencyCode: 'USD', unitPrice: 100 }, { currencyCode: 'EUR', unitPrice: 100 }], costBasis: 10, costCurrency: 'EUR', unitOfMeasure: 'each', taxable: true, isBundle, attributes: {} },
        fx.actorA
      ));
    const bundle = await mk('Dual bundle', true);
    const compA = await mk('Dual A', false);
    const compB = await mk('Dual B', false);
    await withDbAccessContext(fx.ctxA, () =>
      setBundleComponents(bundle.id, [
        { componentItemId: compA.id, quantity: 1, showOnInvoice: true, revenueAllocation: 60 },
        { componentItemId: compB.id, quantity: 1, showOnInvoice: true, revenueAllocation: 40 },
      ], fx.actorA, 'USD'));

    const usd = await withDbAccessContext(fx.ctxA, () => computeBundleEconomics(bundle.id, 'USD', null, fx.actorA));
    expect(usd).toMatchObject({ headlinePrice: '100.00', allocationAvailable: true, allocationTotal: '100.00', allocationMatchesHeadline: true });

    const eur = await withDbAccessContext(fx.ctxA, () => computeBundleEconomics(bundle.id, 'EUR', null, fx.actorA));
    expect(eur).toMatchObject({
      headlinePrice: '100.00', priceBookComplete: true,
      allocationAvailable: false, allocationTotal: null, allocationMatchesHeadline: false,
      // cost economics are independent of the allocation gap
      marginAvailable: true, totalCost: '20.00', margin: '80.00',
    });
  });

  runDb('setOrgPriceOverride: an org of ANOTHER partner is ORG_DENIED 403; a forged row trips the composite FK 23503', async () => {
    const fx = await seedFixture();
    const item = await seedMultiCurrencyItem(fx);
    // Partner-A actor whose RLS axis can see orgB too — the service check, not RLS, must refuse.
    const dualCtx: DbAccessContext = { scope: 'partner', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: [fx.partnerA.id, fx.partnerB.id], userId: null };
    await expect(withDbAccessContext(dualCtx, () => setOrgPriceOverride(item.id, fx.orgB.id, { unitPrice: 5 }, fx.actorA)))
      .rejects.toMatchObject({ status: 403, code: 'ORG_DENIED' });

    await expect(withSystemDbAccessContext(() =>
      db.insert(catalogItemOrgPricing).values({ catalogItemId: item.id, orgId: fx.orgB.id, partnerId: fx.partnerA.id, currencyCode: 'USD', unitPrice: '5.00' })
    )).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  runDb('updateCatalogItem: explicit unitPrice writes the partner-currency row; cost+markup derives into costCurrency only', async () => {
    const fx = await seedFixture();
    const item = await seedMultiCurrencyItem(fx);

    const explicit = await withDbAccessContext(fx.ctxA, () => updateCatalogItem(item.id, { unitPrice: 20 }, fx.actorA));
    expect(explicit.unitPrice).toBe('20.00');
    expect((await priceRowsFor(item.id)).map((r) => [r.currencyCode, r.unitPrice])).toEqual([['EUR', '10.00'], ['USD', '20.00']]);

    // cost in CAD + markup → CAD row only; the USD mirror stays at 20.00.
    const derived = await withDbAccessContext(fx.ctxA, () =>
      updateCatalogItem(item.id, { costBasis: 100, markupPercent: 10, costCurrency: 'CAD' }, fx.actorA));
    expect(derived.costCurrency).toBe('CAD');
    expect(derived.unitPrice).toBe('20.00');
    expect((await priceRowsFor(item.id)).map((r) => [r.currencyCode, r.unitPrice])).toEqual([['CAD', '110.00'], ['EUR', '10.00'], ['USD', '20.00']]);

    // cost currency back to USD with the same drivers → USD row re-derived + mirrored.
    const usdDerived = await withDbAccessContext(fx.ctxA, () => updateCatalogItem(item.id, { costCurrency: 'USD' }, fx.actorA));
    expect(usdDerived.unitPrice).toBe('20.00'); // costCurrency alone is not a price driver
    const reDerived = await withDbAccessContext(fx.ctxA, () => updateCatalogItem(item.id, { markupPercent: 50 }, fx.actorA));
    expect(reDerived.unitPrice).toBe('150.00');
    expect((await priceRowsFor(item.id)).find((r) => r.currencyCode === 'USD')?.unitPrice).toBe('150.00');
  });

  runDb('computeBundleEconomics: a component lacking a USD price → incomplete, null totals; USD org override counts; CAD cost → margin unavailable', async () => {
    const fx = await seedFixture();
    const { bundle, comp1 } = await seedBundleAndComponents(fx); // bundle 100 USD, comp1 cost 20
    const comp3 = await withDbAccessContext(fx.ctxA, () =>
      createCatalogItem(
        { itemType: 'hardware', name: 'EUR-only comp', billingType: 'one_time', prices: [{ currencyCode: 'EUR', unitPrice: 5 }], costBasis: 10, unitOfMeasure: 'each', taxable: true, isBundle: false, attributes: {} },
        fx.actorA
      )
    );
    await withDbAccessContext(fx.ctxA, () =>
      setBundleComponents(bundle.id, [
        { componentItemId: comp1.id, quantity: 2, showOnInvoice: false },
        { componentItemId: comp3.id, quantity: 1, showOnInvoice: false },
      ], fx.actorA));

    const gap = await withDbAccessContext(fx.ctxA, () => computeBundleEconomics(bundle.id, 'USD', null, fx.actorA));
    expect(gap.headlinePrice).toBe('100.00');
    expect(gap.priceBookComplete).toBe(false);
    expect(gap.missingPriceComponentIds).toEqual([comp3.id]);
    expect(gap.totalCost).toBeNull();
    expect(gap.margin).toBeNull();

    // (i) a USD org override for orgA makes it complete for orgA only.
    const ctx = ctxWithOrgs(fx.partnerA.id, [fx.orgA.id]);
    const actor: CatalogActor = { ...fx.actorA, accessibleOrgIds: [fx.orgA.id] };
    await withDbAccessContext(ctx, () => setOrgPriceOverride(comp3.id, fx.orgA.id, { unitPrice: 7, currencyCode: 'USD' }, actor));
    const forOrg = await withDbAccessContext(ctx, () => computeBundleEconomics(bundle.id, 'USD', fx.orgA.id, actor));
    expect(forOrg.priceBookComplete).toBe(true);
    expect(forOrg.totalCost).toBe('50.00'); // 20*2 + 10
    const noOrg = await withDbAccessContext(fx.ctxA, () => computeBundleEconomics(bundle.id, 'USD', null, fx.actorA));
    expect(noOrg.priceBookComplete).toBe(false);

    // (g) add the USD book price → complete everywhere.
    await withDbAccessContext(fx.ctxA, () => setItemPrice(comp3.id, 'USD', { unitPrice: 6 }, fx.actorA));
    const complete = await withDbAccessContext(fx.ctxA, () => computeBundleEconomics(bundle.id, 'USD', null, fx.actorA));
    expect(complete.priceBookComplete).toBe(true);
    expect(complete.marginAvailable).toBe(true);
    expect(complete.totalCost).toBe('50.00');
    expect(complete.margin).toBe('50.00');

    // (h) a component whose cost is in CAD → margin unavailable even though prices are complete.
    await withDbAccessContext(fx.ctxA, () => updateCatalogItem(comp3.id, { costCurrency: 'CAD' }, fx.actorA));
    const cad = await withDbAccessContext(fx.ctxA, () => computeBundleEconomics(bundle.id, 'USD', null, fx.actorA));
    expect(cad.priceBookComplete).toBe(true);
    expect(cad.marginAvailable).toBe(false);
    expect(cad.totalCost).toBeNull();

    // Bundle itself without a price in the target currency → headline null, incomplete.
    const eur = await withDbAccessContext(fx.ctxA, () => computeBundleEconomics(bundle.id, 'EUR', null, fx.actorA));
    expect(eur.headlinePrice).toBeNull();
    expect(eur.priceBookComplete).toBe(false);
  });

  runDb('listCatalogItems: currencyCode filter keeps only items with that row; prices aggregate carries string amounts', async () => {
    const fx = await seedFixture();
    const multi = await seedMultiCurrencyItem(fx);
    const usdOnly = await seedPricedItem(fx);

    const eur = await withDbAccessContext(fx.ctxA, () =>
      listCatalogItems({ currencyCode: 'EUR', limit: 50 }, fx.actorA));
    expect(eur.map((r) => r.id)).toEqual([multi.id]);
    expect(eur[0]?.prices).toEqual([{ currencyCode: 'EUR', unitPrice: '10.00' }, { currencyCode: 'USD', unitPrice: '12.00' }]);
    expect(typeof eur[0]?.prices[0]?.unitPrice).toBe('string');

    const all = await withDbAccessContext(fx.ctxA, () => listCatalogItems({ limit: 50 }, fx.actorA));
    expect(all.map((r) => r.id).sort()).toEqual([multi.id, usdOnly.id].sort());
    expect(all.find((r) => r.id === usdOnly.id)?.prices).toEqual([{ currencyCode: 'USD', unitPrice: '700.00' }]);
  });

  // ---------------------------------------------------------------------------
  // (h) REGRESSION — duplicate SKU must 409 WITHOUT poisoning the RLS transaction
  //
  // The request path runs inside withDbAccessContext's postgres.js transaction.
  // postgres.js begin() records ANY query error as uncaughtError and re-throws
  // it when the callback resolves — even if the app caught it and mapped it to a
  // 409. So a raised unique violation used to surface as a raw PostgresError 500
  // (TD SYNNEX "Import & add" on an already-imported SKU). createCatalogItem now
  // uses ON CONFLICT DO NOTHING (no error raised); updateCatalogItem pre-checks.
  // These tests run the duplicate attempt INSIDE one context and then keep using
  // the same transaction — both fail if the conflict is allowed to raise.
  // ---------------------------------------------------------------------------
  const dupInput = (name: string, sku: string) => ({
    itemType: 'hardware' as const,
    name,
    sku,
    billingType: 'one_time' as const,
    unitPrice: 100,
    unitOfMeasure: 'each',
    taxable: true,
    isBundle: false,
    attributes: {},
  });

  runDb('createCatalogItem: duplicate partner+sku throws 409 DUPLICATE_SKU and the transaction stays usable', async () => {
    const fx = await seedFixture();

    const outcome = await withDbAccessContext(fx.ctxA, async () => {
      await createCatalogItem(dupInput('First import', 'DUP-SKU-1'), fx.actorA);

      let caught: unknown;
      try {
        await createCatalogItem(dupInput('Second import', 'DUP-SKU-1'), fx.actorA);
      } catch (err) {
        caught = err;
      }

      // The conflict must not abort the surrounding transaction: this follow-up
      // query would fail with 25P02 (and the context itself would reject at
      // commit) if the unique violation had been raised and merely caught.
      const rows = await db.select({ id: catalogItems.id }).from(catalogItems)
        .where(and(eq(catalogItems.partnerId, fx.partnerA.id), eq(catalogItems.sku, 'DUP-SKU-1')));
      return { caught, rowCount: rows.length };
    });

    expect(outcome.caught).toBeInstanceOf(CatalogServiceError);
    expect(outcome.caught).toMatchObject({ status: 409, code: 'DUPLICATE_SKU' });
    expect(outcome.rowCount).toBe(1); // only the first import persisted
  });

  runDb('applyImportedPricingBySku (#3775 review #9): a re-import adds the requested sell-currency row + feed cost to the existing item and keeps its other rows', async () => {
    const fx = await seedFixture();
    const first = await withDbAccessContext(fx.ctxA, () =>
      createCatalogItem({ ...dupInput('First import', 'REIMPORT-1'), costBasis: 80, costCurrency: 'USD' }, fx.actorA));
    expect(first.prices).toEqual([{ currencyCode: 'USD', unitPrice: '100.00' }]);

    // Second import from a quote in EUR, feed now reports a CAD cost.
    const merged = await withDbAccessContext(fx.ctxA, () =>
      applyImportedPricingBySku('REIMPORT-1', { prices: [{ currencyCode: 'EUR', unitPrice: 95 }], costBasis: 110.25, costCurrency: 'CAD' }, fx.actorA));
    expect(merged.id).toBe(first.id);
    expect(merged).toMatchObject({ costBasis: '110.25', costCurrency: 'CAD', unitPrice: '100.00' }); // mirror untouched (EUR ≠ partner currency)
    expect(merged.prices).toEqual([
      { currencyCode: 'EUR', unitPrice: '95.00' },
      { currencyCode: 'USD', unitPrice: '100.00' },
    ]);
    expect(merged.pricingApplied).toEqual({ added: ['EUR'], preserved: [] });

    const detail = await withDbAccessContext(fx.ctxA, () => getCatalogItem(first.id, fx.actorA));
    expect(detail.prices.map((p) => [p.currencyCode, p.unitPrice])).toEqual([['EUR', '95.00'], ['USD', '100.00']]);
    expect(detail.item.costCurrency).toBe('CAD');

    // Another partner cannot reach the row through its SKU (ownership + RLS).
    const actorB: CatalogActor = { userId: null as unknown as string, partnerId: fx.partnerB.id, accessibleOrgIds: null };
    const ctxB: DbAccessContext = { scope: 'partner', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: [fx.partnerB.id], userId: null };
    await expect(withDbAccessContext(ctxB, () => applyImportedPricingBySku('REIMPORT-1', { unitPrice: 1 }, actorB)))
      .rejects.toMatchObject({ status: 404, code: 'ITEM_NOT_FOUND' });
  });

  // #3775 review #3: a re-import must not reset a hand-adjusted price-book row
  // to distributor MSRP. Only a currency with no row is added; the feed COST
  // (real feed truth) still lands.
  runDb('applyImportedPricingBySku (#3775 review #3): a re-import preserves hand-adjusted rows and only adds missing currencies', async () => {
    const fx = await seedFixture();
    const first = await withDbAccessContext(fx.ctxA, () =>
      createCatalogItem({ ...dupInput('First import', 'REIMPORT-2'), costBasis: 80, costCurrency: 'USD' }, fx.actorA));
    // The partner hand-adjusts the USD row well away from the feed's 100.00.
    await withDbAccessContext(fx.ctxA, () => setItemPrice(first.id, 'USD', { unitPrice: 149.99 }, fx.actorA));

    const merged = await withDbAccessContext(fx.ctxA, () => applyImportedPricingBySku(
      'REIMPORT-2',
      { prices: [{ currencyCode: 'USD', unitPrice: 100 }, { currencyCode: 'EUR', unitPrice: 95 }], costBasis: 70.5, costCurrency: 'USD' },
      fx.actorA
    ));

    expect(merged.pricingApplied).toEqual({ added: ['EUR'], preserved: ['USD'] });
    // The operator's 149.99 survives; the missing EUR row is added.
    expect(merged.prices).toEqual([
      { currencyCode: 'EUR', unitPrice: '95.00' },
      { currencyCode: 'USD', unitPrice: '149.99' },
    ]);
    // The preserved partner-currency row leaves the deprecated mirror alone too.
    expect(merged.unitPrice).toBe('149.99');
    // Cost IS feed truth and is applied.
    expect(merged).toMatchObject({ costBasis: '70.50', costCurrency: 'USD' });

    const detail = await withDbAccessContext(fx.ctxA, () => getCatalogItem(first.id, fx.actorA));
    expect(detail.prices.map((p) => [p.currencyCode, p.unitPrice])).toEqual([['EUR', '95.00'], ['USD', '149.99']]);

    // A third import now preserves BOTH — nothing left to add.
    const again = await withDbAccessContext(fx.ctxA, () => applyImportedPricingBySku(
      'REIMPORT-2', { prices: [{ currencyCode: 'USD', unitPrice: 1 }, { currencyCode: 'EUR', unitPrice: 2 }] }, fx.actorA));
    expect(again.pricingApplied).toEqual({ added: [], preserved: ['EUR', 'USD'] });
    expect(again.prices).toEqual([
      { currencyCode: 'EUR', unitPrice: '95.00' },
      { currencyCode: 'USD', unitPrice: '149.99' },
    ]);
  });

  runDb('createCatalogItem: same sku under a DIFFERENT partner is not a conflict', async () => {
    const fx = await seedFixture();
    await withDbAccessContext(fx.ctxA, () =>
      createCatalogItem(dupInput('Partner A item', 'SHARED-SKU'), fx.actorA));

    const actorB: CatalogActor = { userId: null as unknown as string, partnerId: fx.partnerB.id, accessibleOrgIds: null };
    const ctxB: DbAccessContext = { scope: 'partner', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: [fx.partnerB.id], userId: null };
    const itemB = await withDbAccessContext(ctxB, () =>
      createCatalogItem(dupInput('Partner B item', 'SHARED-SKU'), actorB));
    expect(itemB.sku).toBe('SHARED-SKU');
  });

  runDb('updateCatalogItem: changing sku to another item\'s sku throws 409 without poisoning the transaction', async () => {
    const fx = await seedFixture();
    const [, itemB] = await withDbAccessContext(fx.ctxA, () => Promise.all([
      createCatalogItem(dupInput('Item A', 'SKU-A'), fx.actorA),
      createCatalogItem(dupInput('Item B', 'SKU-B'), fx.actorA),
    ]));

    const outcome = await withDbAccessContext(fx.ctxA, async () => {
      let caught: unknown;
      try {
        await updateCatalogItem(itemB!.id, { sku: 'SKU-A' }, fx.actorA);
      } catch (err) {
        caught = err;
      }
      const rows = await db.select({ sku: catalogItems.sku }).from(catalogItems)
        .where(eq(catalogItems.id, itemB!.id)).limit(1);
      return { caught, skuAfter: rows[0]?.sku };
    });

    expect(outcome.caught).toMatchObject({ status: 409, code: 'DUPLICATE_SKU' });
    expect(outcome.skuAfter).toBe('SKU-B'); // pre-check ran before the write
  });

  runDb('updateCatalogItem: re-submitting an item\'s own sku is not a conflict', async () => {
    const fx = await seedFixture();
    const item = await withDbAccessContext(fx.ctxA, () =>
      createCatalogItem(dupInput('Keep my sku', 'SKU-KEEP'), fx.actorA));

    const updated = await withDbAccessContext(fx.ctxA, () =>
      updateCatalogItem(item.id, { sku: 'SKU-KEEP', name: 'Renamed' }, fx.actorA));
    expect(updated.sku).toBe('SKU-KEEP');
    expect(updated.name).toBe('Renamed');
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
