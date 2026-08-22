import { and, asc, eq, getTableColumns, gt, ilike, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  catalogItems, catalogItemPrices, catalogItemOrgPricing, catalogBundleComponents, partners, organizations
} from '../db/schema';
import { emitCatalogEvent } from './catalogEvents';
import { isPgUniqueViolation } from '../utils/pgErrors';
import {
  deriveUnitPrice, resolvePriceFrom, isPriceGap, detectBundleProblems, computeBundleEconomicsFrom,
  type ResolvedPrice, type BundleEconomics
} from './catalogPricing';
import { isRepresentableInCurrency, roundToCurrency } from '@breeze/shared';
import type {
  CreateCatalogItemInput, UpdateCatalogItemInput, OrgPriceOverrideInput, SetItemPriceInput,
  BundleComponentInput, ListCatalogQuery
} from '@breeze/shared';

export type CatalogServiceErrorCode =
  | 'PARTNER_UNRESOLVABLE'
  | 'ITEM_NOT_FOUND'
  | 'NOT_A_BUNDLE'
  | 'ALLOCATION_CURRENCY_REQUIRED'
  | 'DUPLICATE_SKU'
  | 'ORG_DENIED'
  | 'PRICE_OUT_OF_RANGE'
  | 'BUNDLE_SELF_REFERENCE'
  | 'BUNDLE_NESTED'
  | 'BUNDLE_CROSS_PARTNER'
  | 'BUNDLE_COMPONENT_NOT_FOUND'
  | 'BUNDLE_DUPLICATE_COMPONENT'
  | 'NO_PRICE_FOR_CURRENCY'
  | 'PRICE_BOOK_INCOMPLETE'
  | 'PRICE_REQUIRED'
  | 'CURRENCY_MISMATCH'
  | 'PRICE_NOT_REPRESENTABLE';

// `db` or the `tx` handed to a db.transaction callback. Document services
// (quote/invoice/contract) resolve prices on their already-locked transaction.
type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// numeric(12,2) ceiling for any money column written by this service.
const MAX_NUMERIC_12_2 = 9_999_999_999.99;

// Escape LIKE/ILIKE metacharacters so a user-supplied search term is matched as a
// literal substring. `%` and `_` are SQL LIKE wildcards; `\` is the default escape
// char. Backslash must be escaped first so we don't double-escape the escapes we add.
export function escapeLikePattern(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export class CatalogServiceError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 = 400,
    public code?: CatalogServiceErrorCode
  ) {
    super(message);
    this.name = 'CatalogServiceError';
  }
}

export interface CatalogActor {
  /** The user who initiated the action, or null for system/background actors. */
  userId: string | null;
  partnerId: string | null;
  /**
   * auth.accessibleOrgIds — the org-axis allowlist (mirrors TimeEntryActor).
   * `null` = system scope (unrestricted). A partner user with
   * orgAccess='selected' carries only the granted org ids here, so an
   * override write/read for a non-granted org under the same partner is
   * denied here (mapped 403) rather than surfacing as a raw RLS 42501 -> 500.
   */
  accessibleOrgIds: string[] | null;
}

function requirePartner(actor: CatalogActor): string {
  if (!actor.partnerId) {
    throw new CatalogServiceError('Catalog is partner-scoped; no partner in context', 400, 'PARTNER_UNRESOLVABLE');
  }
  return actor.partnerId;
}

// Org-axis guard mirroring resolveTicketLink's TICKET_ORG_DENIED check in
// timeEntryService. Rejects a same-partner org the caller can't access before
// touching the DB. `accessibleOrgIds === null` is system scope (unrestricted).
function requireOrgAccess(actor: CatalogActor, orgId: string): void {
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(orgId)) {
    throw new CatalogServiceError('Organization not accessible', 403, 'ORG_DENIED');
  }
}

// Guard a derived/explicit money value against the numeric(12,2) column ceiling
// so an extreme cost+markup product fails as a 400, not a DB-rejection 500.
function assertPriceInRange(unitPrice: string): void {
  if (Number(unitPrice) > MAX_NUMERIC_12_2) {
    throw new CatalogServiceError('Derived unit price exceeds the maximum supported value', 400, 'PRICE_OUT_OF_RANGE');
  }
}

// Spec §4: persisted amounts must be representable in the currency's minor unit
// (100.50 JPY is refused, never silently rounded).
function assertRepresentable(value: string, currencyCode: string): void {
  if (!isRepresentableInCurrency(value, currencyCode)) {
    throw new CatalogServiceError(`${value} is not representable in ${currencyCode}`, 400, 'PRICE_NOT_REPRESENTABLE');
  }
}

/**
 * Per-currency price map for a create (spec §6). Explicit `prices` rows win;
 * a legacy `unitPrice` lands in the partner currency; cost × markup derives a
 * price ONLY in the cost's own currency and only when no explicit price exists
 * for it — deriving into another currency would be a conversion.
 */
function buildPriceMap(
  input: {
    unitPrice?: number;
    prices?: Array<{ currencyCode: string; unitPrice: number }>;
    costBasis?: number | null;
    markupPercent?: number | null;
  },
  partnerCurrency: string,
  costCurrency: string
): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of input.prices ?? []) map.set(p.currencyCode, p.unitPrice.toFixed(2));
  if (input.unitPrice !== undefined && !map.has(partnerCurrency)) {
    map.set(partnerCurrency, Number(input.unitPrice).toFixed(2));
  }
  if (!map.has(costCurrency) && input.costBasis != null && input.markupPercent != null) {
    const derived = deriveUnitPrice({
      explicitPrice: undefined,
      costBasis: input.costBasis.toFixed(2),
      markupPercent: input.markupPercent.toFixed(2)
    });
    // Round at the cost currency's minor unit so JPY cost × markup lands on a whole yen.
    map.set(costCurrency, roundToCurrency(derived, costCurrency));
  }
  for (const [code, v] of map) {
    assertPriceInRange(v);
    assertRepresentable(v, code);
  }
  if (map.size === 0) throw new CatalogServiceError('A price is required', 400, 'PRICE_REQUIRED');
  return map;
}

export async function createCatalogItem(input: CreateCatalogItemInput, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const item = await db.transaction(async (tx) => {
    const partnerCurrency = await resolvePartnerCurrency(partnerId, tx);
    const costCurrency = input.costCurrency ?? partnerCurrency;
    const costBasis = input.costBasis != null ? input.costBasis.toFixed(2) : null;
    if (costBasis !== null) assertRepresentable(costBasis, costCurrency);
    const priceMap = buildPriceMap(input, partnerCurrency, costCurrency);
    // ON CONFLICT DO NOTHING instead of catch-and-map: the request runs inside the
    // withDbAccessContext transaction, and postgres.js re-throws any query error at
    // commit time even after it was caught here (begin() records it as
    // uncaughtError), so a raised unique violation turns the mapped 409 back into a
    // raw 500. Suppressing the conflict at the statement level keeps the
    // transaction healthy; zero returned rows means the SKU already exists. It
    // stays the FIRST write so a duplicate never leaves price rows behind.
    const rows = await tx.insert(catalogItems).values({
      partnerId,
      itemType: input.itemType,
      name: input.name,
      sku: input.sku ?? null,
      description: input.description ?? null,
      billingType: input.billingType,
      billingFrequency: input.billingFrequency ?? null,
      commitmentTermMonths: input.commitmentTermMonths ?? null,
      // Deprecated mirror of the partner-currency price-book row (read by nothing).
      unitPrice: priceMap.get(partnerCurrency) ?? '0.00',
      costBasis,
      markupPercent: input.markupPercent != null ? input.markupPercent.toFixed(2) : null,
      costCurrency,
      unitOfMeasure: input.unitOfMeasure,
      taxable: input.taxable,
      taxCategory: input.taxCategory ?? null,
      isBundle: input.isBundle,
      attributes: input.attributes,
      createdBy: actor.userId
    }).onConflictDoNothing().returning();
    const created = rows[0];
    if (!created) {
      throw new CatalogServiceError('An item with this SKU already exists', 409, 'DUPLICATE_SKU');
    }
    const priceRows = [...priceMap].map(([currencyCode, unitPrice]) => ({ itemId: created.id, partnerId, currencyCode, unitPrice }));
    await tx.insert(catalogItemPrices).values(priceRows);
    // Return the same shape as list/detail so an import-and-add flow can read the
    // price book off the created item without a second fetch (codex review, T19).
    return {
      ...created,
      prices: priceRows.map(({ currencyCode, unitPrice }) => ({ currencyCode, unitPrice }))
        .sort((a, b) => a.currencyCode.localeCompare(b.currencyCode)),
    };
  });
  await emitCatalogEvent({ type: 'catalog.item.created', catalogItemId: item.id, partnerId, actorUserId: actor.userId });
  return item;
}

async function resolvePartnerCurrency(partnerId: string, dbc: DbExecutor = db): Promise<string> {
  const [row] = await dbc.select({ currencyCode: partners.currencyCode }).from(partners)
    .where(eq(partners.id, partnerId)).limit(1);
  if (!row) throw new CatalogServiceError('Partner not found', 404, 'PARTNER_UNRESOLVABLE');
  return row.currencyCode;
}

async function getOwnedItemOr404(id: string, partnerId: string, dbc: DbExecutor = db) {
  const rows = await dbc.select().from(catalogItems)
    .where(and(eq(catalogItems.id, id), eq(catalogItems.partnerId, partnerId))).limit(1);
  const item = rows[0];
  if (!item) throw new CatalogServiceError('Catalog item not found', 404, 'ITEM_NOT_FOUND');
  return item;
}

// Catalog-side lock order: every writer that touches an item AND its price /
// override rows locks the catalog_items row FIRST, then mutates
// catalog_item_prices / catalog_item_org_pricing, then writes the unit_price
// mirror. An item-first/price-first split would be an AB/BA deadlock.
async function lockOwnedItemOr404(id: string, partnerId: string, tx: DbExecutor) {
  const rows = await tx.select().from(catalogItems)
    .where(and(eq(catalogItems.id, id), eq(catalogItems.partnerId, partnerId))).limit(1).for('update');
  const item = rows[0];
  if (!item) throw new CatalogServiceError('Catalog item not found', 404, 'ITEM_NOT_FOUND');
  return item;
}

async function upsertPriceRow(tx: DbExecutor, itemId: string, partnerId: string, currencyCode: string, unitPrice: string) {
  const rows = await tx.insert(catalogItemPrices)
    .values({ itemId, partnerId, currencyCode, unitPrice })
    .onConflictDoUpdate({
      target: [catalogItemPrices.itemId, catalogItemPrices.currencyCode],
      set: { unitPrice, updatedAt: new Date() }
    }).returning();
  return rows[0]!;
}

async function writeUnitPriceMirror(tx: DbExecutor, itemId: string, partnerId: string, unitPrice: string) {
  const rows = await tx.update(catalogItems).set({ unitPrice, updatedAt: new Date() })
    .where(and(eq(catalogItems.id, itemId), eq(catalogItems.partnerId, partnerId))).returning();
  return rows[0];
}

export async function setItemPrice(itemId: string, currencyCode: string, input: SetItemPriceInput, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const unitPrice = input.unitPrice.toFixed(2);
  const row = await db.transaction(async (tx) => {
    await lockOwnedItemOr404(itemId, partnerId, tx); // item lock FIRST
    const partnerCurrency = await resolvePartnerCurrency(partnerId, tx);
    assertPriceInRange(unitPrice);
    assertRepresentable(unitPrice, currencyCode);
    const price = await upsertPriceRow(tx, itemId, partnerId, currencyCode, unitPrice);
    if (currencyCode === partnerCurrency) await writeUnitPriceMirror(tx, itemId, partnerId, unitPrice); // mirror LAST
    return price;
  });
  await emitCatalogEvent({ type: 'catalog.item.price_changed', catalogItemId: itemId, partnerId, actorUserId: actor.userId });
  return row;
}

export async function removeItemPrice(itemId: string, currencyCode: string, actor: CatalogActor): Promise<{ ok: true }> {
  const partnerId = requirePartner(actor);
  await db.transaction(async (tx) => {
    await lockOwnedItemOr404(itemId, partnerId, tx);
    const partnerCurrency = await resolvePartnerCurrency(partnerId, tx);
    await tx.delete(catalogItemPrices)
      .where(and(eq(catalogItemPrices.itemId, itemId), eq(catalogItemPrices.currencyCode, currencyCode)));
    // The mirror has no source once the partner-currency row is gone.
    if (currencyCode === partnerCurrency) await writeUnitPriceMirror(tx, itemId, partnerId, '0.00');
  });
  await emitCatalogEvent({ type: 'catalog.item.price_changed', catalogItemId: itemId, partnerId, actorUserId: actor.userId });
  return { ok: true };
}

/**
 * Importer duplicate-SKU recovery (#3775 review #9). When a distributor / Pax8
 * import hits a SKU the partner already owns, the requested pricing must not be
 * silently discarded: the requested sell-currency rows (explicit `prices`, or a
 * legacy `unitPrice` in the partner currency) are upserted onto the existing
 * item and the freshly fetched feed cost + currency replaces the stored cost.
 * No cost × markup derivation here — on a re-import that would clobber a
 * price-book row the operator may have adjusted by hand; only amounts the
 * caller stated explicitly are written. A cost without a currency (the
 * importedCost gap) leaves the stored cost untouched. Runs under the
 * catalog-side lock order (item row FIRST, price rows, mirror LAST) and returns
 * the same item-plus-price-book shape createCatalogItem does.
 */
export async function applyImportedPricingBySku(
  sku: string,
  input: Pick<CreateCatalogItemInput, 'unitPrice' | 'prices' | 'costBasis' | 'costCurrency' | 'markupPercent'>,
  actor: CatalogActor
) {
  const partnerId = requirePartner(actor);
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(catalogItems)
      .where(and(eq(catalogItems.partnerId, partnerId), eq(catalogItems.sku, sku))).limit(1).for('update');
    if (!existing) throw new CatalogServiceError('Catalog item not found', 404, 'ITEM_NOT_FOUND');
    const partnerCurrency = await resolvePartnerCurrency(partnerId, tx);

    const priceMap = new Map<string, string>();
    for (const p of input.prices ?? []) priceMap.set(p.currencyCode, p.unitPrice.toFixed(2));
    if (input.unitPrice !== undefined && !priceMap.has(partnerCurrency)) {
      priceMap.set(partnerCurrency, Number(input.unitPrice).toFixed(2));
    }
    for (const [code, v] of priceMap) {
      assertPriceInRange(v);
      assertRepresentable(v, code);
    }
    const costPatch: Partial<typeof catalogItems.$inferInsert> = {};
    if (input.costBasis != null && input.costCurrency) {
      const costBasis = input.costBasis.toFixed(2);
      assertRepresentable(costBasis, input.costCurrency);
      costPatch.costBasis = costBasis;
      costPatch.costCurrency = input.costCurrency;
      if (input.markupPercent != null) costPatch.markupPercent = input.markupPercent.toFixed(2);
    }

    let item: typeof catalogItems.$inferSelect = existing;
    for (const [currencyCode, unitPrice] of priceMap) {
      await upsertPriceRow(tx, existing.id, partnerId, currencyCode, unitPrice);
    }
    if (Object.keys(costPatch).length > 0) {
      const rows = await tx.update(catalogItems).set({ ...costPatch, updatedAt: new Date() })
        .where(and(eq(catalogItems.id, existing.id), eq(catalogItems.partnerId, partnerId))).returning();
      item = rows[0] ?? item;
    }
    const mirror = priceMap.get(partnerCurrency);
    if (mirror !== undefined) item = (await writeUnitPriceMirror(tx, existing.id, partnerId, mirror)) ?? item; // mirror LAST
    const prices = await tx.select({ currencyCode: catalogItemPrices.currencyCode, unitPrice: catalogItemPrices.unitPrice })
      .from(catalogItemPrices).where(eq(catalogItemPrices.itemId, existing.id)).orderBy(asc(catalogItemPrices.currencyCode));
    return { ...item, prices };
  });
  await emitCatalogEvent({ type: 'catalog.item.price_changed', catalogItemId: result.id, partnerId, actorUserId: actor.userId });
  return result;
}

export async function listItemPrices(itemId: string, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  await getOwnedItemOr404(itemId, partnerId);
  return db.select().from(catalogItemPrices)
    .where(eq(catalogItemPrices.itemId, itemId)).orderBy(asc(catalogItemPrices.currencyCode));
}

export async function updateCatalogItem(id: string, input: UpdateCatalogItemInput, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const updated = await db.transaction(async (tx) => {
    // Lock order: catalog_items row FIRST, then price rows, then the mirror.
    const existing = await lockOwnedItemOr404(id, partnerId, tx);
    const partnerCurrency = await resolvePartnerCurrency(partnerId, tx);

    // Pre-check a SKU change instead of relying on the unique index raising: a
    // raised violation aborts the surrounding withDbAccessContext transaction and
    // postgres.js re-throws it at commit even when caught, clobbering the mapped
    // 409 with a raw 500 (same reasoning as createCatalogItem's onConflictDoNothing).
    // The isPgUniqueViolation catch below stays as a concurrent-writer backstop.
    if (input.sku != null && input.sku !== existing.sku) {
      const dup = await tx.select({ one: catalogItems.id }).from(catalogItems)
        .where(and(eq(catalogItems.partnerId, partnerId), eq(catalogItems.sku, input.sku), ne(catalogItems.id, id)))
        .limit(1);
      if (dup.length > 0) {
        throw new CatalogServiceError('An item with this SKU already exists', 409, 'DUPLICATE_SKU');
      }
    }

    // Price-book write rules (spec §6). An explicit unitPrice is authoritative for
    // the PARTNER-currency row. Otherwise (re)derive cost × markup into the row for
    // the cost's own currency — only when the PATCH touched a price driver AND both
    // drivers are present; a benign PATCH ({name}, {isActive}, {costCurrency}) or a
    // markup-only PATCH with no cost must never collapse a stored price to 0.00.
    const nextCost = input.costBasis !== undefined ? input.costBasis : (existing.costBasis != null ? Number(existing.costBasis) : null);
    const nextMarkup = input.markupPercent !== undefined ? input.markupPercent : (existing.markupPercent != null ? Number(existing.markupPercent) : null);
    const nextCostCurrency = input.costCurrency ?? existing.costCurrency;
    if (nextCost != null) assertRepresentable(nextCost.toFixed(2), nextCostCurrency);
    // "Touched" means the VALUE changed, not merely that the field was present:
    // the web drawer (and any PATCH that echoes the stored cost) must not
    // re-derive over an explicitly adjusted price-book row (codex review, T19).
    const prevCost = existing.costBasis != null ? Number(existing.costBasis) : null;
    const prevMarkup = existing.markupPercent != null ? Number(existing.markupPercent) : null;
    const driverChanged = input.unitPrice !== undefined
      || (input.costBasis !== undefined && nextCost !== prevCost)
      || (input.markupPercent !== undefined && nextMarkup !== prevMarkup);
    let priceWrite: { currencyCode: string; unitPrice: string } | null = null;
    if (input.unitPrice !== undefined) {
      const unitPrice = input.unitPrice.toFixed(2);
      assertPriceInRange(unitPrice);
      assertRepresentable(unitPrice, partnerCurrency);
      priceWrite = { currencyCode: partnerCurrency, unitPrice };
    } else if (driverChanged && nextCost != null && nextMarkup != null) {
      const derived = roundToCurrency(
        deriveUnitPrice({ explicitPrice: undefined, costBasis: nextCost.toFixed(2), markupPercent: nextMarkup.toFixed(2) }),
        nextCostCurrency
      );
      assertPriceInRange(derived);
      priceWrite = { currencyCode: nextCostCurrency, unitPrice: derived };
    }

    // Flipping a plain item into a bundle (false -> true) is illegal if the item is
    // already referenced as a component of another bundle — that would create a
    // retroactive nested bundle. Only check on the actual false -> true transition.
    if (input.isBundle === true && !existing.isBundle) {
      const referenced = await tx.select({ one: catalogBundleComponents.id })
        .from(catalogBundleComponents)
        .where(eq(catalogBundleComponents.componentItemId, id)).limit(1);
      if (referenced.length > 0) {
        throw new CatalogServiceError('Cannot convert to a bundle: this item is a component of another bundle', 409, 'BUNDLE_NESTED');
      }
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.itemType !== undefined) patch.itemType = input.itemType;
    if (input.name !== undefined) patch.name = input.name;
    if (input.sku !== undefined) patch.sku = input.sku;
    if (input.description !== undefined) patch.description = input.description;
    if (input.billingType !== undefined) patch.billingType = input.billingType;
    if (input.billingFrequency !== undefined) patch.billingFrequency = input.billingFrequency;
    if (input.commitmentTermMonths !== undefined) patch.commitmentTermMonths = input.commitmentTermMonths;
    if (input.costBasis !== undefined) patch.costBasis = input.costBasis != null ? input.costBasis.toFixed(2) : null;
    if (input.costCurrency !== undefined) patch.costCurrency = input.costCurrency;
    if (input.markupPercent !== undefined) patch.markupPercent = input.markupPercent != null ? input.markupPercent.toFixed(2) : null;
    if (input.unitOfMeasure !== undefined) patch.unitOfMeasure = input.unitOfMeasure;
    if (input.taxable !== undefined) patch.taxable = input.taxable;
    if (input.taxCategory !== undefined) patch.taxCategory = input.taxCategory;
    if (input.isBundle !== undefined) patch.isBundle = input.isBundle;
    if (input.attributes !== undefined) patch.attributes = input.attributes;
    if (input.isActive !== undefined) patch.isActive = input.isActive;

    try {
      const rows = await tx.update(catalogItems).set(patch)
        .where(and(eq(catalogItems.id, id), eq(catalogItems.partnerId, partnerId))).returning();
      let row = rows[0]!;
      if (priceWrite) {
        await upsertPriceRow(tx, id, partnerId, priceWrite.currencyCode, priceWrite.unitPrice);
        if (priceWrite.currencyCode === partnerCurrency) {
          row = (await writeUnitPriceMirror(tx, id, partnerId, priceWrite.unitPrice)) ?? row; // mirror LAST
        }
      }
      // Flipping a bundle back to a plain item (true -> false) must drop its
      // component rows — otherwise they linger orphaned and would resurface if the
      // item is later re-flagged as a bundle.
      if (input.isBundle === false && existing.isBundle) {
        await tx.delete(catalogBundleComponents).where(eq(catalogBundleComponents.bundleItemId, id));
      }
      return row;
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        throw new CatalogServiceError('An item with this SKU already exists', 409, 'DUPLICATE_SKU');
      }
      throw err;
    }
  });
  await emitCatalogEvent({ type: 'catalog.item.updated', catalogItemId: id, partnerId, actorUserId: actor.userId });
  return updated;
}

export async function archiveCatalogItem(id: string, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  await getOwnedItemOr404(id, partnerId);
  const rows = await db.update(catalogItems).set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(catalogItems.id, id), eq(catalogItems.partnerId, partnerId))).returning();
  await emitCatalogEvent({ type: 'catalog.item.archived', catalogItemId: id, partnerId, actorUserId: actor.userId });
  return rows[0]!;
}

export async function listCatalogItems(query: ListCatalogQuery, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const conditions = [eq(catalogItems.partnerId, partnerId)];
  if (query.itemType) conditions.push(eq(catalogItems.itemType, query.itemType));
  if (query.isActive !== undefined) conditions.push(eq(catalogItems.isActive, query.isActive));
  if (query.isBundle !== undefined) conditions.push(eq(catalogItems.isBundle, query.isBundle));
  if (query.search) conditions.push(ilike(catalogItems.name, `%${escapeLikePattern(query.search)}%`));
  if (query.cursor) conditions.push(gt(catalogItems.id, query.cursor));
  if (query.currencyCode) {
    conditions.push(sql`EXISTS (SELECT 1 FROM catalog_item_prices p
      WHERE p.item_id = ${catalogItems.id} AND p.currency_code = ${query.currencyCode})`);
  }
  // The aggregated price book rides along so list consumers (items tab, pickers)
  // never read the deprecated unit_price mirror and never N+1 the detail route.
  // `::text` keeps numeric amounts as strings inside the JSON. The outer column
  // is spelled out (`catalog_items.id`): inside a SELECT-list sql`` chunk Drizzle
  // renders `${catalogItems.id}` unqualified, which would bind to `p.id`.
  const rows = await db.select({
    ...getTableColumns(catalogItems),
    prices: sql<Array<{ currencyCode: string; unitPrice: string }>>`COALESCE((SELECT json_agg(json_build_object(
      'currencyCode', p.currency_code, 'unitPrice', p.unit_price::text) ORDER BY p.currency_code)
      FROM catalog_item_prices p WHERE p.item_id = catalog_items.id), '[]'::json)`
  }).from(catalogItems)
    .where(and(...conditions)).orderBy(asc(catalogItems.id)).limit(query.limit);
  return rows;
}

export async function getCatalogItem(id: string, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const item = await getOwnedItemOr404(id, partnerId);
  const prices = await db.select().from(catalogItemPrices)
    .where(eq(catalogItemPrices.itemId, id)).orderBy(asc(catalogItemPrices.currencyCode));
  const overrides = await db.select().from(catalogItemOrgPricing).where(eq(catalogItemOrgPricing.catalogItemId, id));
  const components = item.isBundle
    ? await db.select().from(catalogBundleComponents).where(eq(catalogBundleComponents.bundleItemId, id))
    : [];
  return { item, prices, overrides, components };
}

export async function setOrgPriceOverride(itemId: string, orgId: string, input: OrgPriceOverrideInput, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  requireOrgAccess(actor, orgId);
  const unitPrice = input.unitPrice.toFixed(2);
  assertPriceInRange(unitPrice);
  return db.transaction(async (tx) => {
    const item = await lockOwnedItemOr404(itemId, partnerId, tx); // item lock FIRST
    // Overrides carry an explicit currency (default: the org's) + the
    // denormalized partner_id the composite same-partner FKs require. A
    // cross-partner org is refused here as 403 rather than surfacing as 23503.
    const [org] = await tx.select({ partnerId: organizations.partnerId, currencyCode: organizations.currencyCode })
      .from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (!org || org.partnerId !== item.partnerId) {
      throw new CatalogServiceError('Organization not found for this partner', 403, 'ORG_DENIED');
    }
    const currencyCode = input.currencyCode ?? org.currencyCode;
    assertRepresentable(unitPrice, currencyCode);
    const rows = await tx.insert(catalogItemOrgPricing)
      .values({ catalogItemId: itemId, orgId, partnerId: item.partnerId, currencyCode, unitPrice })
      .onConflictDoUpdate({
        target: [catalogItemOrgPricing.catalogItemId, catalogItemOrgPricing.orgId],
        set: { unitPrice, currencyCode, updatedAt: new Date() }
      }).returning();
    return rows[0]!;
  });
}

export async function removeOrgPriceOverride(itemId: string, orgId: string, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  requireOrgAccess(actor, orgId);
  await db.transaction(async (tx) => {
    await lockOwnedItemOr404(itemId, partnerId, tx);
    await tx.delete(catalogItemOrgPricing)
      .where(and(eq(catalogItemOrgPricing.catalogItemId, itemId), eq(catalogItemOrgPricing.orgId, orgId)));
  });
  return { ok: true };
}

/**
 * Replace a bundle's component set. `allocationCurrency` is the currency the
 * revenueAllocation amounts were authored in (the bundle price being edited,
 * #3775 review #7) and is stamped on every row that carries an allocation; it
 * is required whenever any does (the shared schema enforces it at the edge,
 * this is the backstop). Allocations are later used ONLY in that currency.
 */
export async function setBundleComponents(
  bundleId: string,
  components: BundleComponentInput[],
  actor: CatalogActor,
  allocationCurrency?: string
) {
  const partnerId = requirePartner(actor);
  const bundle = await getOwnedItemOr404(bundleId, partnerId);
  if (!bundle.isBundle) throw new CatalogServiceError('Item is not a bundle', 400, 'NOT_A_BUNDLE');
  const allocCurrency = allocationCurrency?.trim().toUpperCase() || null;
  if (!allocCurrency && components.some((c) => c.revenueAllocation != null)) {
    throw new CatalogServiceError('allocationCurrency is required when a component carries a revenueAllocation', 400, 'ALLOCATION_CURRENCY_REQUIRED');
  }

  const ids = components.map((c) => c.componentItemId);
  const metaRows = ids.length
    ? await db.select({ id: catalogItems.id, isBundle: catalogItems.isBundle, partnerId: catalogItems.partnerId })
        .from(catalogItems).where(inArray(catalogItems.id, ids))
    : [];
  const componentMeta = new Map(metaRows.map((r) => [r.id, { isBundle: r.isBundle, partnerId: r.partnerId }]));

  const problems = detectBundleProblems({
    bundleId, bundlePartnerId: partnerId,
    components: components.map((c) => ({ componentItemId: c.componentItemId, quantity: c.quantity })),
    componentMeta
  });
  if (problems.includes('SELF_REFERENCE')) throw new CatalogServiceError('A bundle cannot contain itself', 400, 'BUNDLE_SELF_REFERENCE');
  if (problems.includes('NESTED_BUNDLE')) throw new CatalogServiceError('A bundle component cannot itself be a bundle', 400, 'BUNDLE_NESTED');
  if (problems.includes('CROSS_PARTNER')) throw new CatalogServiceError('Components must belong to the same partner', 400, 'BUNDLE_CROSS_PARTNER');
  if (problems.includes('COMPONENT_NOT_FOUND')) throw new CatalogServiceError('One or more components were not found', 404, 'BUNDLE_COMPONENT_NOT_FOUND');
  if (problems.includes('DUPLICATE_COMPONENT')) throw new CatalogServiceError('Duplicate component in bundle', 400, 'BUNDLE_DUPLICATE_COMPONENT');

  // Replace-set: delete existing, insert new.
  await db.delete(catalogBundleComponents).where(eq(catalogBundleComponents.bundleItemId, bundleId));
  if (components.length) {
    await db.insert(catalogBundleComponents).values(components.map((c) => ({
      partnerId,
      bundleItemId: bundleId,
      componentItemId: c.componentItemId,
      quantity: c.quantity.toFixed(2),
      showOnInvoice: c.showOnInvoice,
      revenueAllocation: c.revenueAllocation != null ? c.revenueAllocation.toFixed(2) : null,
      allocationCurrency: c.revenueAllocation != null ? allocCurrency : null
    })));
  }
  await emitCatalogEvent({ type: 'catalog.item.updated', catalogItemId: bundleId, partnerId, actorUserId: actor.userId });
  return getCatalogItem(bundleId, actor);
}

/**
 * Spec §6 resolution: org override in the target currency → price-book row for
 * the target currency → typed NO_PRICE_FOR_CURRENCY gap. A winning row whose
 * amount is not representable in the target currency (legacy backfill, e.g.
 * JPY 100.50 — the migrations keep such rows as-is, snapshots rule) is the
 * typed PRICE_NOT_REPRESENTABLE gap (409, #3775 review #4): it never enters a
 * new document, is never rounded, and is never skipped in favour of the next
 * candidate. Fix it with PUT /catalog/:id/prices/:code. Never converts and
 * NEVER reads the deprecated catalog_items.unit_price mirror. Runs on `dbc` so
 * document services resolve inside their already-locked transaction (document
 * row → lines → sources); every catalog read here is a plain SELECT — no
 * FOR UPDATE on the document path.
 */
export async function resolvePrice(
  catalogItemId: string,
  targetCurrency: string,
  orgId: string | null,
  actor: CatalogActor,
  dbc: DbExecutor = db
): Promise<ResolvedPrice> {
  const partnerId = requirePartner(actor);
  if (orgId) requireOrgAccess(actor, orgId);
  const item = await getOwnedItemOr404(catalogItemId, partnerId, dbc);
  let override: { unitPrice: string; currencyCode: string } | null = null;
  if (orgId) {
    const rows = await dbc.select({ unitPrice: catalogItemOrgPricing.unitPrice, currencyCode: catalogItemOrgPricing.currencyCode })
      .from(catalogItemOrgPricing)
      .where(and(eq(catalogItemOrgPricing.catalogItemId, catalogItemId), eq(catalogItemOrgPricing.orgId, orgId))).limit(1);
    override = rows[0] ?? null;
  }
  const bookRows = await dbc.select({ unitPrice: catalogItemPrices.unitPrice }).from(catalogItemPrices)
    .where(and(eq(catalogItemPrices.itemId, catalogItemId), eq(catalogItemPrices.currencyCode, targetCurrency))).limit(1);
  const resolved = resolvePriceFrom(
    { costBasis: item.costBasis, costCurrency: item.costCurrency, taxable: item.taxable, taxCategory: item.taxCategory },
    override,
    bookRows[0] ?? null,
    targetCurrency
  );
  if (isPriceGap(resolved)) {
    if (resolved.gap === 'PRICE_NOT_REPRESENTABLE') {
      throw new CatalogServiceError(
        `${resolved.source === 'org_override' ? 'Org override' : 'Price-book'} price ${resolved.unitPrice} for "${item.name}" is not representable in ${targetCurrency} — correct the ${targetCurrency} price before using this item`,
        409,
        'PRICE_NOT_REPRESENTABLE'
      );
    }
    throw new CatalogServiceError(
      `No price for "${item.name}" in ${targetCurrency} — add a price-book entry or enter a manual line`,
      409,
      'NO_PRICE_FOR_CURRENCY'
    );
  }
  return resolved;
}

export async function computeBundleEconomics(
  bundleId: string,
  targetCurrency: string,
  orgId: string | null,
  actor: CatalogActor,
  dbc: DbExecutor = db
): Promise<BundleEconomics> {
  const partnerId = requirePartner(actor);
  if (orgId) requireOrgAccess(actor, orgId);
  const bundle = await getOwnedItemOr404(bundleId, partnerId, dbc);
  if (!bundle.isBundle) throw new CatalogServiceError('Item is not a bundle', 400, 'NOT_A_BUNDLE');

  // The bundle's own gap is a null headline (economics unavailable), not an error.
  let headlinePrice: string | null;
  try {
    headlinePrice = (await resolvePrice(bundleId, targetCurrency, orgId, actor, dbc)).unitPrice;
  } catch (err) {
    if (err instanceof CatalogServiceError && err.code === 'NO_PRICE_FOR_CURRENCY') headlinePrice = null;
    else throw err;
  }

  // A component "has a price" in the target currency when the price book has a
  // row OR (for an org-scoped view) the org carries an override in that currency
  // — the same resolution order resolvePrice applies.
  let query = dbc.select({
    componentItemId: catalogBundleComponents.componentItemId,
    quantity: catalogBundleComponents.quantity,
    revenueAllocation: catalogBundleComponents.revenueAllocation,
    allocationCurrency: catalogBundleComponents.allocationCurrency,
    costBasis: catalogItems.costBasis,
    costCurrency: catalogItems.costCurrency,
    priceId: catalogItemPrices.id,
    overrideId: orgId ? catalogItemOrgPricing.id : sql<string | null>`NULL`
  }).from(catalogBundleComponents)
    .innerJoin(catalogItems, eq(catalogItems.id, catalogBundleComponents.componentItemId))
    .leftJoin(catalogItemPrices, and(
      eq(catalogItemPrices.itemId, catalogBundleComponents.componentItemId),
      eq(catalogItemPrices.currencyCode, targetCurrency)
    ))
    .$dynamic();
  if (orgId) {
    query = query.leftJoin(catalogItemOrgPricing, and(
      eq(catalogItemOrgPricing.catalogItemId, catalogBundleComponents.componentItemId),
      eq(catalogItemOrgPricing.orgId, orgId),
      eq(catalogItemOrgPricing.currencyCode, targetCurrency)
    ));
  }
  const comps = await query.where(eq(catalogBundleComponents.bundleItemId, bundleId));

  return computeBundleEconomicsFrom({
    currencyCode: targetCurrency,
    headlinePrice,
    components: comps.map((c) => ({
      componentItemId: c.componentItemId,
      quantity: c.quantity,
      costBasis: c.costBasis,
      costCurrency: c.costCurrency,
      revenueAllocation: c.revenueAllocation,
      allocationCurrency: c.allocationCurrency,
      hasPriceInCurrency: c.priceId !== null || c.overrideId !== null
    }))
  });
}
