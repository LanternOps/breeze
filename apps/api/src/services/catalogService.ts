import { and, asc, eq, getTableColumns, gt, ilike, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import { tightenLockTimeout, tightenStatementTimeout, lockTimeoutWasChanged } from '../db/lockTimeout';
import {
  catalogItems, catalogItemPrices, catalogItemOrgPricing, catalogBundleComponents, partners, organizations
} from '../db/schema';
import { emitCatalogEvent } from './catalogEvents';
import { isPgUniqueViolation, pgErrorCode } from '../utils/pgErrors';
import { readOrgStampingDefaults, OrgCurrencyServiceError } from './orgCurrencyCore';
import {
  deriveUnitPrice, resolvePriceFrom, isPriceGap, detectBundleProblems, computeBundleEconomicsFrom,
  type BundleHeadlineGap,
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
  // Someone else holds the item rows this write needs. Transient and
  // RETRYABLE — the request was valid and nothing was mutated.
  | 'ITEM_BUSY'
  // The locking step did not finish. DISTINCT FROM `ITEM_BUSY` on purpose:
  // SQLSTATE 57014 is plain `query_canceled` and names no cause. Contention is
  // the common one, but a slow plan, an I/O stall, expensive RLS evaluation or
  // an administrative `pg_cancel_backend` produce exactly the same code with
  // nothing held by anyone — and a cancel can arrive immediately, so this is
  // not even always a timeout. Usually retryable; a persistent plan regression
  // or a repeated admin cancel is not, so it is not safe to hammer.
  //
  // STATUS IS 409, and that is a deliberate choice against the strict reading.
  // RFC 9110 scopes 409 to a conflict with the resource's current state, which
  // this cannot establish — so SOME 5xx is the stricter answer. (Not cleanly
  // 503 either: RFC 9110 frames that as temporary overload or maintenance,
  // which does not describe an administrative cancel.)
  //
  // 409 is kept because the status class drives alert SEVERITY:
  // `monitoring/rules/breeze-rules.yml` classifies HighErrorRate **critical**
  // at 5xx > 5% for 5m, against High4xxRate **warning** at > 20% for 10m — a
  // 4x lower threshold and half the window for ordinary catalog contention.
  // And because the route returns this status directly rather than raising, it
  // never reaches Sentry, so that alert would fire with no exception behind it.
  // (Where the alert actually GOES is deployment-specific and NOT established
  // by this repo: the tracked `monitoring/alertmanager.yml` has its Slack,
  // PagerDuty and email receivers commented out and sends critical alerts to a
  // webhook with no matching route in `apps/api/src`.)
  //
  // The distinct CODE gives clients the distinction without reclassifying the
  // response. Worth revisiting as 5xx plus a dedicated rule for this code.
  | 'ITEM_LOCK_NOT_ACQUIRED'
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
 * item, and the freshly fetched feed cost + currency replaces the stored cost.
 *
 * A re-import NEVER overwrites an existing price-book row (#3775 review #3).
 * The distributor feed is authoritative for COST, never for the partner's sell
 * price: an operator who hand-adjusted the EUR row would otherwise have it
 * silently reset to Pax8 MSRP by a re-import, reported as a plain "Imported"
 * toast. Only a currency with no row at all is added; existing rows are left
 * alone (and reported back as `preserved` so the caller can say so), and the
 * deprecated unit_price mirror is rewritten only when the partner-currency row
 * is one of the ADDED ones. No cost × markup derivation here either. A cost
 * without a currency (the importedCost gap) leaves the stored cost untouched.
 *
 * Runs under the catalog-side lock order (item row FIRST, price rows, mirror
 * LAST) and returns the same item-plus-price-book shape createCatalogItem does,
 * plus `pricingApplied`.
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

    // Which currencies already have a row? Read under the item lock, before any
    // write, so the add/preserve split is decided against a stable price book.
    const existingRows = await tx.select({ currencyCode: catalogItemPrices.currencyCode })
      .from(catalogItemPrices).where(eq(catalogItemPrices.itemId, existing.id));
    const existingCodes = new Set(existingRows.map((r) => r.currencyCode));
    const added: string[] = [];
    const preserved: string[] = [];
    for (const code of priceMap.keys()) (existingCodes.has(code) ? preserved : added).push(code);
    added.sort(); preserved.sort();

    let item: typeof catalogItems.$inferSelect = existing;
    for (const currencyCode of added) {
      await upsertPriceRow(tx, existing.id, partnerId, currencyCode, priceMap.get(currencyCode)!);
    }
    if (Object.keys(costPatch).length > 0) {
      const rows = await tx.update(catalogItems).set({ ...costPatch, updatedAt: new Date() })
        .where(and(eq(catalogItems.id, existing.id), eq(catalogItems.partnerId, partnerId))).returning();
      item = rows[0] ?? item;
    }
    // Mirror only a row we actually added — rewriting it for a PRESERVED row
    // would reset the mirror to the feed price the price book just refused.
    const mirror = added.includes(partnerCurrency) ? priceMap.get(partnerCurrency) : undefined;
    if (mirror !== undefined) item = (await writeUnitPriceMirror(tx, existing.id, partnerId, mirror)) ?? item; // mirror LAST
    const prices = await tx.select({ currencyCode: catalogItemPrices.currencyCode, unitPrice: catalogItemPrices.unitPrice })
      .from(catalogItemPrices).where(eq(catalogItemPrices.itemId, existing.id)).orderBy(asc(catalogItemPrices.currencyCode));
    return { ...item, prices, pricingApplied: { added, preserved } };
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
    // Lock order (#3778): `organizations FOR SHARE` is the FIRST statement of
    // this transaction, BEFORE the catalog item lock — this call site used to
    // lock the item first and then read the org unlocked, which both inverted
    // the wave-6 global order (organizations -> contracts/catalog_items) and let
    // a concurrent changeOrgCurrency stamp an override with a stale currency.
    // A cross-partner (or otherwise invisible) org must keep this service's own
    // 403 ORG_DENIED contract — the barrier's neutral 404 would otherwise
    // pre-empt the same-partner check below now that the org lock runs first.
    // Narrow (#3778 finding 5): only a MISSING org becomes this service's 403.
    // A blanket `.catch()` also swallowed 40001/40P01 — plausible precisely
    // because this read now takes a row lock contending with changeOrgCurrency's
    // FOR UPDATE — and reported a retriable failure as a permanent authorization
    // error, while hiding genuine helper bugs.
    const lockedOrg = await readOrgStampingDefaults(tx, orgId).catch((err: unknown) => {
      if (err instanceof OrgCurrencyServiceError && err.code === 'ORG_NOT_FOUND') {
        throw new CatalogServiceError('Organization not found for this partner', 403, 'ORG_DENIED');
      }
      throw err;
    });
    const item = await lockOwnedItemOr404(itemId, partnerId, tx);
    // Overrides carry an explicit currency (default: the org's) + the
    // denormalized partner_id the composite same-partner FKs require. A
    // cross-partner org is refused here as 403 rather than surfacing as 23503.
    const [org] = await tx.select({ partnerId: organizations.partnerId })
      .from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (!org || org.partnerId !== item.partnerId) {
      throw new CatalogServiceError('Organization not found for this partner', 403, 'ORG_DENIED');
    }
    const currencyCode = input.currencyCode ?? lockedOrg.currencyCode;
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
 * Render a caller-supplied id the way Postgres will, so a JS Map key and a
 * `uuid` column agree.
 *
 * Postgres accepts more spellings than the canonical one — upper case, braces,
 * and hyphens omitted or placed differently — and normalises all of them on
 * output (verified: both `{550e8400-…}` and the unhyphenated form select back
 * as `550e8400-e29b-41d4-a716-446655440000`). That never mattered while every
 * identity comparison lived in UUID-typed SQL. It matters now that the locked
 * rows are held in a Map: SQL would find and LOCK the row, then `map.get()`
 * would miss and report ITEM_NOT_FOUND for a row this transaction is holding.
 *
 * The HTTP route is not the exposure — `z.string().guid()` pins it to canonical
 * 8-4-4-4-12. The AI tool is: `manage_catalog` passes `String(input.catalogId)`
 * with no GUID parse at all (its `setBundleComponentsSchema.parse` covers only
 * `components`/`allocationCurrency`), so a braced or unhyphenated id reaches
 * here intact.
 *
 * Anything Postgres would not accept is returned UNCHANGED on purpose, so a
 * malformed id still reaches the column and still raises 22P02 exactly as it
 * did before. This normalises; it does not validate, and it must not ACCEPT
 * more than the database does — see the body.
 */
function canonicalUuid(value: string): string {
  // Match Postgres's grammar EXACTLY, then normalise — never the other way
  // round. Stripping braces and hyphens first and hex-testing the remainder is
  // strictly MORE permissive than the database, which turns strings Postgres
  // REFUSES into a valid id pointing at a real row. All of these were verified
  // against a live Postgres 16: `{uuid` and `uuid}` (one brace), a leading or
  // trailing space, `5-50e8400-…` (hyphen off a 4-boundary), a doubled hyphen,
  // and a leading hyphen are all rejected by the server, while `{uuid}`,
  // `550e-8400-…` (hyphen after any group of four) and the hyphen-less form are
  // all accepted and rendered canonically.
  let body = value;
  if (body.startsWith('{')) {
    if (!body.endsWith('}')) return value;
    body = body.slice(1, -1);
  } else if (body.endsWith('}')) {
    return value;
  }
  // An optional hyphen after each group of four hex digits — Postgres's rule.
  // No trim(): the server does not accept surrounding whitespace either.
  if (!/^(?:[0-9A-Fa-f]{4}-?){7}[0-9A-Fa-f]{4}$/.test(body)) return value;
  const hex = body.replace(/-/g, '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Lock every named item THIS PARTNER OWNS as one globally ordered set, and read
 * foreign metadata WITHOUT locking it.
 *
 * Two queries, and only the FIRST takes row locks — that is what keeps this
 * deadlock-free, not the fact that it is a single statement. Parent-first-then-
 * components deadlocks: `set(A,[B])` takes A then wants B while `set(B,[A])`
 * takes B then wants A, and the cycle forms BEFORE the under-lock validation can
 * reject either, so two requests that should both be a clean 400 become a 40P01.
 * Sorting each component list does not help, because the already-held parent
 * sits outside that ordering. Deduplicating and sorting the UNION of
 * {parent, ...components} puts every caller on one global order.
 *
 * Only OWNED rows are locked. A row this partner does not own is rejected
 * before any edge DML whatever it does concurrently, so locking it buys no
 * correctness and lets an invalid request block another tenant's writer. Which
 * error it gets is not one thing, and this comment used to claim it was: a
 * normal partner context cannot SEE the row at all and gets
 * BUNDLE_COMPONENT_NOT_FOUND; an RLS-visible foreign plain item gets
 * BUNDLE_CROSS_PARTNER; an RLS-visible foreign BUNDLE trips both problems and
 * the throw order below returns BUNDLE_NESTED first; a foreign parent gets
 * ITEM_NOT_FOUND. Foreign rows must still be READ, because telling
 * CROSS_PARTNER from COMPONENT_NOT_FOUND depends on whether the row exists at
 * all. The pre-fix code read component metadata unlocked, and this preserves
 * that for everything the actor does not own.
 *
 * `ORDER BY id` is load-bearing and must not be dropped: Postgres sorts the
 * qualifying tuples before the locking node takes the row locks, which is what
 * gives every caller the same order. `= ANY(...)` argument order guarantees
 * nothing by itself.
 *
 * FOR NO KEY UPDATE, not FOR UPDATE. It is the weakest mode that still conflicts
 * with itself and with `updateCatalogItem` (which pre-locks the row FOR UPDATE,
 * and whose plain UPDATE would take NO KEY UPDATE anyway), so the serialisation
 * this fix depends on is unchanged. FOR SHARE would be too weak — two SHARE
 * holders are compatible. The gain is that an FK's KEY SHARE lock stays
 * compatible, so inserting an edge that merely REFERENCES one of these items is
 * no longer blocked.
 *
 * Locking `catalog_items` — not the `catalog_bundle_components` edge rows — is
 * what closes the conversion race in `updateCatalogItem`. That check searches
 * for the ABSENCE of an edge, and an ordinary row lock cannot lock a row that
 * does not exist yet. (Absence IS lockable via SERIALIZABLE predicate locks, an
 * advisory lock, or a table lock; none of those is used here, and none is needed
 * once both writers contend on the component's own item row, which must already
 * exist because the edge has an FK to it.)
 */
/**
 * Bound on how long the item lock below may wait.
 *
 * Without it this can block indefinitely on up to 201 rows from a request path,
 * holding its pooled connection the whole time — the recurring production
 * failure here, and the same reason the device cascade grew a bound. A deadlock
 * resolves in milliseconds; a wait behind a long-running catalog import does
 * not. Bounded, it fails fast and retryably instead of pinning the connection —
 * as 55P03 when a single acquisition times out, or as 57014 when the whole
 * statement runs out of budget first (see the mapping below; both become 409).
 */
const CATALOG_LOCK_TIMEOUT_MS = 3000;

/**
 * Hard cap for the whole locking statement, DELIBERATELY LOOSER than the
 * per-lock bound above.
 *
 * They are not interchangeable and must not be equal. `lock_timeout` fires per
 * lock ACQUISITION, so it is the one that means "a specific row is contended" —
 * that is the retryable, reportable case. `statement_timeout` is a deadline for
 * the entire statement and exists only so a RUN of staggered blockers cannot
 * add up to an unbounded wait; its 57014 is generic `query_canceled` and says
 * nothing about why.
 *
 * If they were equal the statement deadline would always fire first and the
 * per-lock signal would be dead code, so ordinary contention would surface as
 * an uninformative cancellation instead of ITEM_BUSY. Keeping this looser means
 * the common case (one blocked row) still reports contention, and this only
 * takes over when the per-lock bound cannot.
 *
 * Only 1s of separation, deliberately. Anything above the per-lock bound makes
 * 55P03 reachable, and the gap buys nothing beyond that: this is an indexed
 * lookup of at most 201 primary keys plus a sort, so a statement that has
 * burned a second before reaching the contested lock is already abnormally
 * slow and 57014 is the more honest answer. The ceiling matters because the
 * request pool is 30 connections and this module already warns at a 2s held
 * context — a looser cap would let a handful of contended composes pin the
 * pool. Tune from measured production lock waits, not from this comment.
 */
const CATALOG_LOCK_STATEMENT_TIMEOUT_MS = 4000;

async function lockOwnedItemsInGlobalOrder(
  tx: DbExecutor,
  ids: readonly string[],
  partnerId: string
) {
  const ordered = [...new Set(ids)].sort();

  // Tighten BEFORE the locking query, never widening a stricter caller.
  //
  // BOTH bounds, deliberately. `lock_timeout` alone does NOT bound this
  // statement: it applies per lock ACQUISITION, so a query taking up to 201
  // locks gets a fresh interval for every row and a run of staggered blockers
  // can hold the connection for N x the bound. Measured on PG16 — two rows,
  // `lock_timeout='1000ms'`, staggered holders: the statement ran 1214ms and
  // SUCCEEDED. `statement_timeout` is the actual deadline; `lock_timeout` stays
  // as the per-lock backstop so a single long blocker still fails faster.
  const priorMs = await tightenLockTimeout(tx, CATALOG_LOCK_TIMEOUT_MS);
  const priorStmtMs = await tightenStatementTimeout(tx, CATALOG_LOCK_STATEMENT_TIMEOUT_MS);
  if (priorStmtMs === null) {
    // Fail here rather than proceed. Unlike lock_timeout, an unrestorable
    // statement_timeout is NOT behaviour-neutral: on the success path it would
    // govern the caller's remaining work — the unlocked read, the replace DML,
    // and everything after this nested scope returns. (postgres-js does not
    // issue RELEASE SAVEPOINT on nested success — the scope simply returns —
    // so a SET LOCAL taken inside it goes on applying to the outer
    // transaction.) Throwing instead rolls back to the savepoint, which is what
    // undoes both SET LOCALs automatically.
    // A plain Error on purpose: CatalogServiceError is the client-facing domain
    // type (400/403/404/409 only), and this is an internal fault, not something
    // the caller did wrong.
    throw new Error('setBundleComponents: could not read the prior statement_timeout to restore it');
  }
  const cols = { id: catalogItems.id, isBundle: catalogItems.isBundle, partnerId: catalogItems.partnerId };

  // ONE locking query, not one per id. The validator permits 200 components, so
  // a loop here would be up to 201 serial round trips with every earlier row
  // lock held open across all of them.
  //
  // 57014 from THIS statement is OFTEN contention, and must not be a 500.
  //
  // `lock_timeout` fires per ACQUISITION, so a statement taking N locks gets a
  // fresh interval per row and the statement deadline can land first even though
  // every millisecond of the wait was lock contention. Measured on PG16 16.14 —
  // two rows, holders released 700ms apart, `lock_timeout='1000ms'` and
  // `statement_timeout='1400ms'`: the second acquisition's fresh timer would have
  // expired at ~1700ms, so the statement was cancelled at 1412ms with 57014 and
  // 55P03 never happened. Mapping only 55P03 therefore leaves ordinary
  // multi-row contention surfacing as a 500.
  //
  // The two SQLSTATEs mean DIFFERENT things and get different codes.
  //
  // An earlier draft tried to decide whether a 57014 "was really contention" by
  // checking whether THIS code had installed the deadline. That is not a sound
  // signal in either direction, so it is gone:
  //   - false positive: with no prior timeout the flag is true, so an
  //     `pg_cancel_backend`, an I/O stall, a plan regression or simply an
  //     expensive RLS evaluation would all have been reported as "another
  //     operation is modifying it" with nothing held by anyone;
  //   - false negative: a ROLE- or DATABASE-level `statement_timeout` stricter
  //     than the bound (`ALTER ROLE ... SET statement_timeout`) is preserved,
  //     so the flag is false and genuine staggered contention escaped raw.
  // Those are server-side configuration, not "a caller", and `pg_settings`
  // reports only the effective value — it cannot say who set it.
  //
  // What IS known is the statement: this catch wraps exactly the locking SELECT
  // and nothing else (drizzle's builder defers execution to the await, so no
  // other statement can run inside the try). That is enough to say WHICH
  // statement failed. It is NOT enough to say why — an administrative cancel
  // can arrive immediately, so it need not be a timeout at all — and nothing
  // below claims otherwise: the message says only that the locks could not be
  // acquired, which holds for a lock wait, a slow plan and a cancel alike.
  let owned;
  try {
    owned = await tx.select(cols).from(catalogItems)
      .where(and(inArray(catalogItems.id, [...ordered]), eq(catalogItems.partnerId, partnerId)))
      .orderBy(asc(catalogItems.id))
      .for('no key update');
  } catch (err) {
    // 55P03 is also mapped by `withBundleLockTimeoutMapped` around the whole
    // transaction, so this arm is behaviourally redundant TODAY. Kept on
    // purpose: this helper installs the bounds, so it owns what they raise, and
    // handling only 57014 here would leave the two SQLSTATEs mapped in two
    // different places — a later caller that used the helper without the outer
    // wrapper would then get a clean 409 for one and a raw 500 for the other.
    const code = pgErrorCode(err);
    // 55P03 is `lock_not_available`: a lock this statement needed was held and
    // the wait hit `lock_timeout`. Usually one of the item ROWS, though the
    // same code covers the table and index locks the SELECT also takes — an
    // ACCESS EXCLUSIVE table lock (a migration, a VACUUM FULL) raises it before
    // row locking begins. Either way the advice is the same, and unlike 57014
    // it is unambiguously "something was locked".
    if (code === '55P03') {
      throw new CatalogServiceError(
        'Catalog item is busy: another operation is modifying it. Try again in a moment.',
        409,
        'ITEM_BUSY',
      );
    }
    // 57014 is `query_canceled` — NOT necessarily a timeout at all, since an
    // administrative cancel can arrive at any moment. Reachable on the ordinary contention path
    // because `lock_timeout` is per ACQUISITION: locking N rows behind blockers
    // that release at staggered times restarts the per-lock timer each time, so
    // the STATEMENT deadline can land first even though every millisecond was
    // spent waiting on locks. Measured on PG16 16.14 — two rows, holders
    // released 700ms apart under lock_timeout=1000ms/statement_timeout=1400ms:
    // cancelled at 1412ms with 57014, and 55P03 never happened.
    if (code === '57014') {
      throw new CatalogServiceError(
        'Could not acquire the catalog item locks for this change. Try again in a moment.',
        409,
        'ITEM_LOCK_NOT_ACQUIRED',
      );
    }
    throw err;
  }

  // Restored only on the success path, deliberately. A 55P03 aborts the
  // (sub)transaction, so any statement after it fails 25P02 — restoring in a
  // `finally` would mask the timeout the caller needs to see. Nothing leaks:
  // rolling back to the savepoint that precedes a SET LOCAL undoes it.
  if (lockTimeoutWasChanged(priorMs, CATALOG_LOCK_TIMEOUT_MS)) {
    await tx.execute(sql`select set_config('lock_timeout', ${`${priorMs}ms`}, true)`);
  }
  // Restore the statement deadline immediately: left in force it would govern
  // the unlocked read and the replace DML below too, which is a broader promise
  // than this bound is making.
  if (lockTimeoutWasChanged(priorStmtMs, CATALOG_LOCK_STATEMENT_TIMEOUT_MS)) {
    await tx.execute(sql`select set_config('statement_timeout', ${`${priorStmtMs}ms`}, true)`);
  }

  // Anything not returned above is either foreign or absent. Read it unlocked so
  // detectBundleProblems can tell those two apart. Rows invisible under RLS are
  // simply missing from the map, so it raises COMPONENT_NOT_FOUND rather than
  // this helper leaking whether a foreign id exists.
  const ownedIds = new Set(owned.map((r) => r.id));
  const rest = ordered.filter((id) => !ownedIds.has(id));
  const unlocked = rest.length
    ? await tx.select(cols).from(catalogItems).where(inArray(catalogItems.id, rest))
    : [];

  // Drop anything the SECOND statement reports as ours. Read Committed gives
  // each statement its own snapshot, so a row that was absent or foreign during
  // the locking query can be owned by the time this one runs — and it would then
  // enter the map indistinguishable from a locked row, which is exactly the
  // unlocked-validation hole this fix exists to close. Excluding it makes the id
  // simply missing, so validation refuses the request instead of trusting an
  // is_bundle flag nothing is holding. (This is only sound because ids are normalised before the
  // locking query: otherwise the SAME row, locked by query 1 under one spelling,
  // would come back from query 2 under another and be dropped as if unlocked.)
  const foreign = unlocked.filter((r) => r.partnerId !== partnerId);

  // A row that became OURS between the two statements is a retryable race, not
  // a missing component. Dropping it silently (the previous behaviour here)
  // would fail the request COMPONENT_NOT_FOUND for an id that demonstrably
  // exists and is owned by the caller — fail-closed for the locking invariant,
  // but a wrong and unactionable answer.
  //
  // NOT REACHABLE through either production caller today, and this does not
  // pretend otherwise: the create validator exposes no `id` and the update
  // validator no `partnerId` (`packages/shared/src/validators/catalog.ts`), so
  // ids are always `defaultRandom()` and nothing moves ownership. It is a
  // guard on the helper's own invariant rather than a fix for a live bug —
  // kept because the invariant is what makes the second, UNLOCKED read safe to
  // trust, and an id source or an ownership transfer added later would
  // otherwise reopen the hole silently. Cheap: one length comparison.
  if (unlocked.length !== foreign.length) {
    throw new CatalogServiceError(
      'Catalog item is busy: another operation is modifying it. Try again in a moment.',
      409,
      'ITEM_BUSY',
    );
  }

  return new Map([...owned, ...foreign].map((r) => [r.id, { isBundle: r.isBundle, partnerId: r.partnerId }]));
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

  // Canonicalise every id ONCE, here, before dedup / locking / self-reference /
  // duplicate detection / map lookup / DML. See `canonicalUuid` for why the
  // spelling can differ from what Postgres renders.
  //
  // Every JS-side comparison in this function and in `detectBundleProblems`
  // (Map.get, the `seen` Set, `=== bundleId`) is exact-string. Un-normalised, a
  // non-canonical parent misses the locked map and 404s a row this transaction
  // has already locked; a non-canonical component becomes a phantom
  // BUNDLE_COMPONENT_NOT_FOUND; and the same component sent under two spellings
  // slips past both the duplicate and the self-reference check. None of this
  // could happen before the fix, because the parent was resolved by a SQL `eq`
  // that compared 128 bits and never saw the spelling.
  const bundleKey = canonicalUuid(bundleId);

  // Snapshot the caller's array before the backstop below and before any await.
  // `components` is caller-owned and mutable, and it is read at four points
  // separated by awaits (backstop, id list, validation, insert). Without this,
  // a caller that mutates the array while the lock query is in flight could get
  // one shape validated and a different one written — adding a revenueAllocation
  // after the backstop ran, or swapping a componentItemId for one that was
  // never locked, never nesting-checked and never ownership-checked. No current
  // caller shares the parsed object with another actor, so this is a contract
  // guarantee rather than a live bug, but every comment below depends on it.
  const items = components.map((c) => ({
    componentItemId: canonicalUuid(c.componentItemId),
    quantity: c.quantity,
    showOnInvoice: c.showOnInvoice,
    revenueAllocation: c.revenueAllocation ?? null
  }));

  // #3775 review #7's backstop, deliberately BEFORE the transaction. It reads
  // nothing from the database, so running it under the row locks would mean
  // locking every named catalog_items row only to reject on shape. The
  // maintainer's version ran it after ITEM_NOT_FOUND and NOT_A_BUNDLE, so
  // hoisting it changes the code a DIRECT service caller gets whenever an
  // uncurrencied allocation coincides with a bad parent: NOT_A_BUNDLE, and
  // equally ITEM_NOT_FOUND (missing, foreign, or RLS-invisible parent) or a raw
  // invalid-uuid error, now all answer ALLOCATION_CURRENCY_REQUIRED first.
  // PARTNER_UNRESOLVABLE still precedes it. Nothing observable changes over HTTP
  // or through the AI tool: apps/api/src/routes/catalog/bundles.ts and
  // aiToolsCatalog's set_bundle_components both parse `setBundleComponentsSchema`
  // first, and its refine already rejects an allocation with no currency — those
  // are the only two production callers of this function.
  const allocCurrency = allocationCurrency?.trim().toUpperCase() || null;
  if (!allocCurrency && items.some((c) => c.revenueAllocation != null)) {
    throw new CatalogServiceError('allocationCurrency is required when a component carries a revenueAllocation', 400, 'ALLOCATION_CURRENCY_REQUIRED');
  }
  // Wave-6 review: an allocation is persisted money carrying its own stamped
  // currency (`allocation_currency`) and is copied verbatim onto a same-currency
  // invoice line (invoiceService.addCatalogLine), so it must be representable in
  // that currency — a fractional-yen allocation is a 400, never a silent round.

  // One transaction for the whole read-validate-replace.
  //
  // NOT because the old code was non-atomic on the request path — it was not.
  // `db` is already the outer `withDbAccessContext` transaction there, so the
  // previous bare `db.delete` / `db.insert` were inside it and a failure between
  // them rolled both back. What this buys is a SCOPE for the row locks taken
  // below — nothing more. It is not extra atomicity for some context-less
  // caller: this function accepts no executor, and outside `withDbAccessContext`
  // the breeze_app role has no RLS GUCs set, so the parent lookup finds nothing
  // and the function throws before deleting anything. Both production callers
  // establish an access context, so on both paths this is a SAVEPOINT within
  // their transaction, not a new transaction.
  // Translate a lock/statement timeout into a TYPED domain error, here rather
  // than at the route.
  //
  // Mapping raw 55P03 in the route's shared handleServiceError was too broad —
  // that handler also serves GET /:id/economics, so any 55P03 arising anywhere
  // in the catalog surface would have been reported as "this item is busy". It
  // also missed a caller: aiToolsCatalog converts CatalogServiceError only, so
  // the AI path would still have surfaced a raw driver error. A domain error
  // fixes both, because every caller already understands CatalogServiceError.
  const id = await withBundleLockTimeoutMapped(async () => db.transaction(async (tx) => {
    const componentIds = items.map((c) => c.componentItemId);
    const locked = await lockOwnedItemsInGlobalOrder(tx, [bundleKey, ...componentIds], partnerId);

    // Re-read the parent from the LOCKED set: its is_bundle flag is exactly what
    // a concurrent updateCatalogItem flips, so validating an unlocked copy is
    // the race. Ownership is enforced here, not by the lock helper.
    const bundle = locked.get(bundleKey);
    if (!bundle || bundle.partnerId !== partnerId) {
      throw new CatalogServiceError('Catalog item not found', 404, 'ITEM_NOT_FOUND');
    }
    if (!bundle.isBundle) throw new CatalogServiceError('Item is not a bundle', 400, 'NOT_A_BUNDLE');

    // #3874's representability guard, kept HERE rather than hoisted with the
    // ALLOCATION_CURRENCY_REQUIRED backstop above.
    //
    // It needs no database state, so it does not need the locks — it needs this
    // POSITION. Wave 6 shipped it after the parent lookup, so `ITEM_NOT_FOUND`
    // and `NOT_A_BUNDLE` win over `PRICE_NOT_REPRESENTABLE`. Running it before
    // the transaction inverted that for ordinary HTTP requests: the shared
    // schema accepts `100.50` as plain two-decimal money and does not enforce
    // per-currency minor units, so a request naming a missing parent AND a
    // fractional-yen allocation would have started answering
    // PRICE_NOT_REPRESENTABLE where main answers ITEM_NOT_FOUND.
    //
    // Reads `items`, not `components`. That is load-bearing precisely because of
    // this position: the lock query above is an `await`, so a caller holding the
    // array really can mutate it before this runs, and the insert below writes
    // the snapshot — checking the live array would validate values that are
    // never persisted while persisting values that were never checked.
    if (allocCurrency) {
      for (const c of items) {
        if (c.revenueAllocation != null) assertRepresentable(c.revenueAllocation.toFixed(2), allocCurrency);
      }
    }

    const componentMeta = new Map(
      componentIds
        .filter((id) => id !== bundleKey && locked.has(id))
        .map((id) => [id, locked.get(id)!])
    );

    const problems = detectBundleProblems({
      bundleId: bundleKey, bundlePartnerId: partnerId,
      components: items.map((c) => ({ componentItemId: c.componentItemId, quantity: c.quantity })),
      componentMeta
    });
    if (problems.includes('SELF_REFERENCE')) throw new CatalogServiceError('A bundle cannot contain itself', 400, 'BUNDLE_SELF_REFERENCE');
    if (problems.includes('NESTED_BUNDLE')) throw new CatalogServiceError('A bundle component cannot itself be a bundle', 400, 'BUNDLE_NESTED');
    if (problems.includes('CROSS_PARTNER')) throw new CatalogServiceError('Components must belong to the same partner', 400, 'BUNDLE_CROSS_PARTNER');
    if (problems.includes('COMPONENT_NOT_FOUND')) throw new CatalogServiceError('One or more components were not found', 404, 'BUNDLE_COMPONENT_NOT_FOUND');
    if (problems.includes('DUPLICATE_COMPONENT')) throw new CatalogServiceError('Duplicate component in bundle', 400, 'BUNDLE_DUPLICATE_COMPONENT');

    // Replace-set, now atomic with the validation above.
    await tx.delete(catalogBundleComponents).where(eq(catalogBundleComponents.bundleItemId, bundleKey));
    if (items.length) {
      await tx.insert(catalogBundleComponents).values(items.map((c) => ({
        partnerId,
        bundleItemId: bundleKey,
        componentItemId: c.componentItemId,
        quantity: c.quantity.toFixed(2),
        showOnInvoice: c.showOnInvoice,
        revenueAllocation: c.revenueAllocation != null ? c.revenueAllocation.toFixed(2) : null,
        allocationCurrency: c.revenueAllocation != null ? allocCurrency : null
      })));
    }
    return bundleKey;
  }));

  // NOT an after-commit hook, and deliberately not labelled as one. Request
  // handlers already run inside `withDbAccessContext`, which opens the real
  // transaction, so the `db.transaction` above is a SAVEPOINT within it — this
  // line still executes before the outer commit, exactly as the old code did.
  // Emitting here is unchanged behaviour, not an improvement. What this
  // codebase lacks is a GENERIC after-commit callback usable from a
  // request-scoped transaction (it does have hand-rolled post-commit flows
  // elsewhere); building one is out of scope for a lock fix. Note the row locks
  // taken above are still held across this enqueue.
  await emitCatalogEvent({ type: 'catalog.item.updated', catalogItemId: id, partnerId, actorUserId: actor.userId });
  return getCatalogItem(id, actor);
}

/**
 * Runs `fn`, converting a lock-wait abort into ITEM_BUSY (409).
 *
 * ONLY 55P03, which Postgres defines as `lock_not_available` — it genuinely
 * identifies contention on these rows, so "retry" is sound advice.
 *
 * 57014 is deliberately excluded even though the statement deadline raises it:
 * it is generic `query_canceled` and identifies no source. The SQLSTATE is read
 * with `pgErrorCode` because Drizzle wraps the driver error and puts the code
 * on `.cause`.
 */
async function withBundleLockTimeoutMapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    // ONLY 55P03. It is specifically `lock_not_available`, so it genuinely
    // means "another writer holds these rows, retry".
    //
    // 57014 is deliberately NOT mapped: it is generic `query_canceled` and
    // carries no evidence of its source. It is equally what an administrative
    // cancel, a client disconnect, or a slow uncontended write under a
    // stricter caller's own deadline raises — and this wrapper spans the whole
    // transaction, so claiming any of those as ITEM_BUSY would tell an operator
    // to retry a request that was never contended.
    if (pgErrorCode(err) === '55P03') {
      throw new CatalogServiceError(
        'Catalog item is busy: another operation is modifying it. Try again in a moment.',
        409,
        'ITEM_BUSY',
      );
    }
    throw err;
  }
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

  // The bundle's own gap is a null headline (economics unavailable), not an
  // error — for EVERY gap reason, including a legacy non-representable row
  // (#3775 review #1). Letting PRICE_NOT_REPRESENTABLE escape here made
  // GET /catalog/:id/economics answer 409 (contradicting this contract) and
  // reached addBundleLine as an unmapped CatalogServiceError → HTTP 500. The
  // reason travels on the payload so a document caller can still refuse with a
  // typed 409 that repeats the resolver's actionable text.
  let headlinePrice: string | null;
  let headlineGap: BundleHeadlineGap | null = null;
  let headlineGapMessage: string | null = null;
  try {
    headlinePrice = (await resolvePrice(bundleId, targetCurrency, orgId, actor, dbc)).unitPrice;
  } catch (err) {
    if (err instanceof CatalogServiceError && (err.code === 'NO_PRICE_FOR_CURRENCY' || err.code === 'PRICE_NOT_REPRESENTABLE')) {
      headlinePrice = null;
      headlineGap = err.code;
      // The plain missing-row gap needs no message; a stated reason carries the
      // resolver's "correct the <CUR> price" text through to the operator.
      headlineGapMessage = err.code === 'PRICE_NOT_REPRESENTABLE' ? err.message : null;
    } else throw err;
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
    headlineGap,
    headlineGapMessage,
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

/**
 * Deliberately narrow test seam. `canonicalUuid` is a private normaliser whose
 * correctness is defined by the DATABASE's grammar, so it needs a test that
 * compares it against a live server; exporting it outright would invite callers
 * to treat it as a validator, which it is not.
 */
export const __testables = { canonicalUuid, lockOwnedItemsInGlobalOrder };
