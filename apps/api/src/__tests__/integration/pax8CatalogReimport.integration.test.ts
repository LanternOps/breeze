/**
 * Real-database proof for #12527: re-importing a Pax8 product must update the
 * catalog item its pax8_product_mappings row already points at, not create a
 * second one.
 *
 * importPax8CatalogItem runs for real here (aiCleanup off, so no AI call; the
 * Pax8 client and Redis are not used by the importer), against the unprivileged
 * breeze_app role, so partner RLS is active exactly as it is for a request.
 * The cross-partner case calls applyImportedPricing directly: the importer
 * cannot be handed another partner's item id, because the mapping table's
 * (catalog_item_id, partner_id) foreign key refuses such a mapping.
 *
 * Every test re-seeds (setup.ts truncates the core tables before each test).
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { catalogItems, catalogItemPrices } from '../../db/schema';
import { pax8Integrations, pax8ProductMappings } from '../../db/schema/pax8';
import { createPartner } from './db-utils';
import { applyImportedPricing, createCatalogItem, updateCatalogItem, type CatalogActor } from '../../services/catalogService';
import { importPax8CatalogItem, type Pax8ImportInput } from '../../services/pax8CatalogService';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const PRODUCT_ID = 'pax8-prod-cfq7';
const JSON_SKU = '{"sku":"CFQ7"}'; // what an import from before #12524 stored as the SKU
const REAL_SKU = 'CFQ7';

const ctxFor = (partnerId: string): DbAccessContext => ({
  scope: 'partner',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: [partnerId],
  userId: null,
});
const actorFor = (partnerId: string): CatalogActor => ({
  userId: null as unknown as string,
  partnerId,
  accessibleOrgIds: null,
});

const catalogInput = (name: string, sku: string) => ({
  itemType: 'software' as const,
  name,
  sku,
  billingType: 'recurring' as const,
  billingFrequency: 'monthly' as const,
  unitPrice: 100,
  costBasis: 80,
  costCurrency: 'USD',
  unitOfMeasure: 'each',
  taxable: true,
  isBundle: false,
  attributes: {},
});

// A re-import from the picker: the real SKU, a EUR sell price, a CAD feed cost.
const reimport = (over: Partial<Pax8ImportInput['item']> = {}): Pax8ImportInput => ({
  product: {
    source: 'pax8',
    pax8ProductId: PRODUCT_ID,
    name: 'Microsoft 365 Business Standard',
    vendorName: 'Microsoft',
    vendorSku: REAL_SKU,
    commitmentTerm: 'Annual',
    billingTerm: 'Monthly',
    partnerBuyRate: '110.25',
    currency: 'CAD',
    raw: { sku: REAL_SKU, vendorSku: JSON_SKU }, // the Pax8 record: before #12524 the importer stored its vendorSku
  },
  item: { name: 'Microsoft 365 Business Standard', sku: REAL_SKU, unitPrice: 95, sellCurrency: 'EUR', ...over },
  aiCleanup: false,
});

async function seed() {
  const { partnerA, partnerB, integrationA } = await withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const [integrationA] = await db.insert(pax8Integrations).values({
      partnerId: partnerA.id,
      name: 'Pax8',
      clientIdEncrypted: 'enc:client-id',
      clientSecretEncrypted: 'enc:client-secret',
      tokenUrl: 'https://api.pax8.com/v1/token',
    }).returning();
    return { partnerA, partnerB, integrationA: integrationA! };
  });
  return {
    partnerA, partnerB, integrationA,
    ctxA: ctxFor(partnerA.id), actorA: actorFor(partnerA.id),
    ctxB: ctxFor(partnerB.id), actorB: actorFor(partnerB.id),
  };
}
type Fx = Awaited<ReturnType<typeof seed>>;

/** The state #12527 describes: an item whose SKU is the JSON string, mapped to the Pax8 product. */
async function seedLegacyMappedItem(fx: Fx) {
  const legacy = await withDbAccessContext(fx.ctxA, () =>
    createCatalogItem(catalogInput('Microsoft 365 (old import)', JSON_SKU), fx.actorA));
  await withSystemDbAccessContext(() => db.insert(pax8ProductMappings).values({
    integrationId: fx.integrationA.id,
    partnerId: fx.partnerA.id,
    pax8ProductId: PRODUCT_ID,
    vendorSkuId: JSON_SKU,
    productName: 'Old name',
    catalogItemId: legacy.id,
  }));
  return legacy;
}

const itemsOf = (partnerId: string) => withSystemDbAccessContext(() =>
  db.select().from(catalogItems).where(eq(catalogItems.partnerId, partnerId)));
const itemById = async (id: string) => (await withSystemDbAccessContext(() =>
  db.select().from(catalogItems).where(eq(catalogItems.id, id))))[0];
const pricesOf = async (itemId: string) => (await withSystemDbAccessContext(() =>
  db.select({ c: catalogItemPrices.currencyCode, p: catalogItemPrices.unitPrice }).from(catalogItemPrices)
    .where(eq(catalogItemPrices.itemId, itemId)))).map((r) => [r.c, r.p]).sort();
const mappingsOf = (fx: Fx) => withSystemDbAccessContext(() =>
  db.select().from(pax8ProductMappings).where(and(
    eq(pax8ProductMappings.integrationId, fx.integrationA.id),
    eq(pax8ProductMappings.pax8ProductId, PRODUCT_ID))));

describe('Pax8 re-import (#12527, breeze_app, real DB)', () => {
  runDb('a product imported under its JSON-string SKU is updated in place: one item, SKU corrected, mapping unchanged, pricing applied', async () => {
    const fx = await seed();
    const legacy = await seedLegacyMappedItem(fx);

    const result = await importPax8CatalogItem(reimport(), fx.actorA, fx.ctxA);

    const items = await itemsOf(fx.partnerA.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: legacy.id, sku: REAL_SKU, costBasis: '110.25', costCurrency: 'CAD' });
    expect(result).toMatchObject({ id: legacy.id, sku: REAL_SKU });
    // The old USD row survives, the requested EUR row is added.
    expect(await pricesOf(legacy.id)).toEqual([['EUR', '95.00'], ['USD', '100.00']]);

    const mappings = await mappingsOf(fx);
    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toMatchObject({ catalogItemId: legacy.id, vendorSkuId: REAL_SKU, productName: 'Microsoft 365 Business Standard' });

    // Importing it a third time changes nothing further.
    const again = await importPax8CatalogItem(reimport(), fx.actorA, fx.ctxA);
    expect(again.id).toBe(legacy.id);
    expect(await itemsOf(fx.partnerA.id)).toHaveLength(1);
    expect(await mappingsOf(fx)).toHaveLength(1);
  });

  runDb('a SKU the partner edited by hand survives a re-import: one item, SKU kept, pricing still applied', async () => {
    const fx = await seed();
    const legacy = await seedLegacyMappedItem(fx);
    await withDbAccessContext(fx.ctxA, () => updateCatalogItem(legacy.id, { sku: 'MY-CUSTOM' }, fx.actorA));

    const result = await importPax8CatalogItem(reimport(), fx.actorA, fx.ctxA);

    const items = await itemsOf(fx.partnerA.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: legacy.id, sku: 'MY-CUSTOM', costBasis: '110.25', costCurrency: 'CAD' });
    expect(result).toMatchObject({ id: legacy.id, sku: 'MY-CUSTOM' });
    expect(await pricesOf(legacy.id)).toEqual([['EUR', '95.00'], ['USD', '100.00']]);
    expect((await mappingsOf(fx))[0]).toMatchObject({ catalogItemId: legacy.id });
  });

  runDb('the real SKU is already held by another item of the partner: the mapped item keeps its SKU, pricing still lands, nothing aborts', async () => {
    const fx = await seed();
    const legacy = await seedLegacyMappedItem(fx);
    const holder = await withDbAccessContext(fx.ctxA, () =>
      createCatalogItem(catalogInput('Hand-made CFQ7', REAL_SKU), fx.actorA));

    const result = await importPax8CatalogItem(reimport(), fx.actorA, fx.ctxA);

    expect(result).toMatchObject({ id: legacy.id, sku: JSON_SKU });
    expect(await itemById(legacy.id)).toMatchObject({ sku: JSON_SKU, costBasis: '110.25', costCurrency: 'CAD' });
    expect(await pricesOf(legacy.id)).toEqual([['EUR', '95.00'], ['USD', '100.00']]);
    // The other item is untouched.
    expect(await itemById(holder.id)).toMatchObject({ sku: REAL_SKU, costBasis: '80.00', costCurrency: 'USD' });
    expect(await pricesOf(holder.id)).toEqual([['USD', '100.00']]);
    expect(await itemsOf(fx.partnerA.id)).toHaveLength(2);
    // The mapping upsert runs after the pricing step, in the same request
    // transaction. It only lands if that transaction was not aborted.
    const [mapping] = await mappingsOf(fx);
    expect(mapping).toMatchObject({ catalogItemId: legacy.id, productName: 'Microsoft 365 Business Standard' });
  });

  runDb('applyImportedPricing by id: when the SKU is taken, the request transaction stays usable afterwards', async () => {
    const fx = await seed();
    const legacy = await seedLegacyMappedItem(fx);
    await withDbAccessContext(fx.ctxA, () => createCatalogItem(catalogInput('Hand-made CFQ7', REAL_SKU), fx.actorA));

    const outcome = await withDbAccessContext(fx.ctxA, async () => {
      let caught: unknown;
      let applied: Awaited<ReturnType<typeof applyImportedPricing>> | undefined;
      try {
        applied = await applyImportedPricing({ itemId: legacy.id, sku: REAL_SKU, replacesSku: JSON_SKU }, { unitPrice: 95, costBasis: 70, costCurrency: 'USD' }, fx.actorA);
      } catch (err) {
        caught = err;
      }
      // Any statement in an aborted transaction fails with 25P02.
      const rows = await db.select({ sku: catalogItems.sku }).from(catalogItems).where(eq(catalogItems.id, legacy.id));
      return { caught, applied, skuSeenAfter: rows[0]?.sku };
    });

    expect(outcome.caught).toBeUndefined();
    expect(outcome.applied).toMatchObject({ id: legacy.id, sku: JSON_SKU, costBasis: '70.00' });
    expect(outcome.skuSeenAfter).toBe(JSON_SKU);
  });

  runDb('applyImportedPricing by id: another partner\'s item id is not found and that partner\'s row is unchanged', async () => {
    const fx = await seed();
    const itemB = await withDbAccessContext(fx.ctxB, () =>
      createCatalogItem(catalogInput('Partner B product', 'B-ONLY'), fx.actorB));
    const before = await itemById(itemB.id);
    const pricesBefore = await pricesOf(itemB.id);

    await expect(withDbAccessContext(fx.ctxA, () =>
      applyImportedPricing({ itemId: itemB.id, sku: 'STOLEN', replacesSku: 'B-ONLY' }, { prices: [{ currencyCode: 'EUR', unitPrice: 1 }], costBasis: 1, costCurrency: 'USD' }, fx.actorA)))
      .rejects.toMatchObject({ status: 404, code: 'ITEM_NOT_FOUND' });

    expect(await itemById(itemB.id)).toEqual(before); // sku, cost and updatedAt all unchanged
    expect(await pricesOf(itemB.id)).toEqual(pricesBefore);
    // The database itself hides the row from partner A, apart from the service's own filter.
    const seenByA = await withDbAccessContext(fx.ctxA, () =>
      db.select({ id: catalogItems.id }).from(catalogItems).where(eq(catalogItems.id, itemB.id)));
    expect(seenByA).toEqual([]);
  });

  runDb('first import (no mapping) still creates the item and its mapping', async () => {
    const fx = await seed();

    const result = await importPax8CatalogItem(reimport({ sellCurrency: undefined }), fx.actorA, fx.ctxA);

    const items = await itemsOf(fx.partnerA.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: result.id, sku: REAL_SKU });
    expect((await mappingsOf(fx))[0]).toMatchObject({ catalogItemId: result.id });
  });

  runDb('the mapped item was deleted (mapping points at nothing): a new item is created and the mapping repointed', async () => {
    const fx = await seed();
    const legacy = await seedLegacyMappedItem(fx);
    await withSystemDbAccessContext(() => db.delete(catalogItems).where(eq(catalogItems.id, legacy.id)));
    expect((await mappingsOf(fx))[0]!.catalogItemId).toBeNull();

    const result = await importPax8CatalogItem(reimport({ sellCurrency: undefined }), fx.actorA, fx.ctxA);

    expect(result.id).not.toBe(legacy.id);
    expect(await itemsOf(fx.partnerA.id)).toHaveLength(1);
    expect((await mappingsOf(fx))[0]).toMatchObject({ catalogItemId: result.id });
  });
});
