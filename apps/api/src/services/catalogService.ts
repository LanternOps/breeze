import { and, asc, eq, gt, ilike, inArray } from 'drizzle-orm';
import { db } from '../db';
import { catalogItems, catalogItemOrgPricing, catalogBundleComponents } from '../db/schema';
import { emitCatalogEvent } from './catalogEvents';
import { isPgUniqueViolation } from '../utils/pgErrors';
import {
  deriveUnitPrice, resolvePriceFrom, detectBundleProblems, computeBundleEconomicsFrom,
  type ResolvedPrice
} from './catalogPricing';
import type {
  CreateCatalogItemInput, UpdateCatalogItemInput, OrgPriceOverrideInput,
  BundleComponentInput, ListCatalogQuery
} from '@breeze/shared';

export type CatalogServiceErrorCode =
  | 'PARTNER_UNRESOLVABLE'
  | 'ITEM_NOT_FOUND'
  | 'NOT_A_BUNDLE'
  | 'DUPLICATE_SKU'
  | 'ORG_DENIED'
  | 'PRICE_OUT_OF_RANGE'
  | 'BUNDLE_SELF_REFERENCE'
  | 'BUNDLE_NESTED'
  | 'BUNDLE_CROSS_PARTNER'
  | 'BUNDLE_COMPONENT_NOT_FOUND'
  | 'BUNDLE_DUPLICATE_COMPONENT';

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
  userId: string;
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

export async function createCatalogItem(input: CreateCatalogItemInput, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const unitPrice = deriveUnitPrice({
    explicitPrice: input.unitPrice,
    costBasis: input.costBasis != null ? input.costBasis.toFixed(2) : null,
    markupPercent: input.markupPercent != null ? input.markupPercent.toFixed(2) : null
  });
  assertPriceInRange(unitPrice);
  try {
    const rows = await db.insert(catalogItems).values({
      partnerId,
      itemType: input.itemType,
      name: input.name,
      sku: input.sku ?? null,
      description: input.description ?? null,
      billingType: input.billingType,
      unitPrice,
      costBasis: input.costBasis != null ? input.costBasis.toFixed(2) : null,
      markupPercent: input.markupPercent != null ? input.markupPercent.toFixed(2) : null,
      unitOfMeasure: input.unitOfMeasure,
      taxable: input.taxable,
      taxCategory: input.taxCategory ?? null,
      isBundle: input.isBundle,
      attributes: input.attributes,
      createdBy: actor.userId
    }).returning();
    const item = rows[0]!;
    await emitCatalogEvent({ type: 'catalog.item.created', catalogItemId: item.id, partnerId, actorUserId: actor.userId });
    return item;
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new CatalogServiceError('An item with this SKU already exists', 409, 'DUPLICATE_SKU');
    }
    throw err;
  }
}

async function getOwnedItemOr404(id: string, partnerId: string) {
  const rows = await db.select().from(catalogItems)
    .where(and(eq(catalogItems.id, id), eq(catalogItems.partnerId, partnerId))).limit(1);
  const item = rows[0];
  if (!item) throw new CatalogServiceError('Catalog item not found', 404, 'ITEM_NOT_FOUND');
  return item;
}

export async function updateCatalogItem(id: string, input: UpdateCatalogItemInput, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const existing = await getOwnedItemOr404(id, partnerId);

  // Recompute derived price if markup/cost changed and no explicit price supplied.
  // unit_price is authoritative — a manually entered unit_price always wins, and a
  // markup/cost-only PATCH must never silently wipe the stored sell price to 0.00.
  // We therefore only (re)derive when an explicit price is supplied, or when BOTH a
  // cost basis and markup are present to actually drive the derivation; if a
  // price-driver changed but there is no cost basis to derive from, we preserve the
  // existing unit_price rather than collapsing it to deriveUnitPrice()'s '0.00' floor.
  const nextCost = input.costBasis !== undefined ? input.costBasis : (existing.costBasis != null ? Number(existing.costBasis) : null);
  const nextMarkup = input.markupPercent !== undefined ? input.markupPercent : (existing.markupPercent != null ? Number(existing.markupPercent) : null);
  // Only (re)derive when the PATCH actually touched a price driver. A benign PATCH
  // touching none of unitPrice/costBasis/markupPercent (e.g. {name}, {taxable},
  // {isActive}) must leave the stored unit_price untouched — never silently recompute
  // and overwrite a manually-set sell price.
  const driverChanged = input.unitPrice !== undefined || input.costBasis !== undefined || input.markupPercent !== undefined;
  const shouldDeriveUnitPrice = input.unitPrice !== undefined || (driverChanged && nextCost != null && nextMarkup != null);
  const unitPrice = input.unitPrice !== undefined
    ? input.unitPrice.toFixed(2)
    : deriveUnitPrice({ explicitPrice: undefined, costBasis: nextCost != null ? nextCost.toFixed(2) : null, markupPercent: nextMarkup != null ? nextMarkup.toFixed(2) : null });
  if (shouldDeriveUnitPrice) assertPriceInRange(unitPrice);

  // Flipping a plain item into a bundle (false -> true) is illegal if the item is
  // already referenced as a component of another bundle — that would create a
  // retroactive nested bundle. Only check on the actual false -> true transition.
  if (input.isBundle === true && !existing.isBundle) {
    const referenced = await db.select({ one: catalogBundleComponents.id })
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
  if (shouldDeriveUnitPrice) patch.unitPrice = unitPrice;
  if (input.costBasis !== undefined) patch.costBasis = input.costBasis != null ? input.costBasis.toFixed(2) : null;
  if (input.markupPercent !== undefined) patch.markupPercent = input.markupPercent != null ? input.markupPercent.toFixed(2) : null;
  if (input.unitOfMeasure !== undefined) patch.unitOfMeasure = input.unitOfMeasure;
  if (input.taxable !== undefined) patch.taxable = input.taxable;
  if (input.taxCategory !== undefined) patch.taxCategory = input.taxCategory;
  if (input.isBundle !== undefined) patch.isBundle = input.isBundle;
  if (input.attributes !== undefined) patch.attributes = input.attributes;
  if (input.isActive !== undefined) patch.isActive = input.isActive;

  try {
    const rows = await db.update(catalogItems).set(patch)
      .where(and(eq(catalogItems.id, id), eq(catalogItems.partnerId, partnerId))).returning();
    await emitCatalogEvent({ type: 'catalog.item.updated', catalogItemId: id, partnerId, actorUserId: actor.userId });
    return rows[0]!;
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new CatalogServiceError('An item with this SKU already exists', 409, 'DUPLICATE_SKU');
    }
    throw err;
  }
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
  const rows = await db.select().from(catalogItems)
    .where(and(...conditions)).orderBy(asc(catalogItems.id)).limit(query.limit);
  return rows;
}

export async function getCatalogItem(id: string, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const item = await getOwnedItemOr404(id, partnerId);
  const overrides = await db.select().from(catalogItemOrgPricing).where(eq(catalogItemOrgPricing.catalogItemId, id));
  const components = item.isBundle
    ? await db.select().from(catalogBundleComponents).where(eq(catalogBundleComponents.bundleItemId, id))
    : [];
  return { item, overrides, components };
}

export async function setOrgPriceOverride(itemId: string, orgId: string, input: OrgPriceOverrideInput, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  requireOrgAccess(actor, orgId);
  await getOwnedItemOr404(itemId, partnerId); // ensures the item is this partner's
  const unitPrice = input.unitPrice.toFixed(2);
  assertPriceInRange(unitPrice);
  const rows = await db.insert(catalogItemOrgPricing)
    .values({ catalogItemId: itemId, orgId, unitPrice })
    .onConflictDoUpdate({
      target: [catalogItemOrgPricing.catalogItemId, catalogItemOrgPricing.orgId],
      set: { unitPrice, updatedAt: new Date() }
    }).returning();
  return rows[0]!;
}

export async function removeOrgPriceOverride(itemId: string, orgId: string, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  requireOrgAccess(actor, orgId);
  await getOwnedItemOr404(itemId, partnerId);
  await db.delete(catalogItemOrgPricing)
    .where(and(eq(catalogItemOrgPricing.catalogItemId, itemId), eq(catalogItemOrgPricing.orgId, orgId)));
  return { ok: true };
}

export async function setBundleComponents(bundleId: string, components: BundleComponentInput[], actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const bundle = await getOwnedItemOr404(bundleId, partnerId);
  if (!bundle.isBundle) throw new CatalogServiceError('Item is not a bundle', 400, 'NOT_A_BUNDLE');

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
      revenueAllocation: c.revenueAllocation != null ? c.revenueAllocation.toFixed(2) : null
    })));
  }
  await emitCatalogEvent({ type: 'catalog.item.updated', catalogItemId: bundleId, partnerId, actorUserId: actor.userId });
  return getCatalogItem(bundleId, actor);
}

export async function resolvePrice(catalogItemId: string, orgId: string | null, actor: CatalogActor): Promise<ResolvedPrice> {
  const partnerId = requirePartner(actor);
  if (orgId) requireOrgAccess(actor, orgId);
  const item = await getOwnedItemOr404(catalogItemId, partnerId);
  let override: { unitPrice: string } | null = null;
  if (orgId) {
    const rows = await db.select({ unitPrice: catalogItemOrgPricing.unitPrice }).from(catalogItemOrgPricing)
      .where(and(eq(catalogItemOrgPricing.catalogItemId, catalogItemId), eq(catalogItemOrgPricing.orgId, orgId))).limit(1);
    override = rows[0] ?? null;
  }
  return resolvePriceFrom(
    { unitPrice: item.unitPrice, costBasis: item.costBasis, taxable: item.taxable, taxCategory: item.taxCategory },
    override
  );
}

export async function computeBundleEconomics(bundleId: string, orgId: string | null, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  if (orgId) requireOrgAccess(actor, orgId);
  const bundle = await getOwnedItemOr404(bundleId, partnerId);
  if (!bundle.isBundle) throw new CatalogServiceError('Item is not a bundle', 400, 'NOT_A_BUNDLE');
  const headline = orgId ? (await resolvePrice(bundleId, orgId, actor)).unitPrice : bundle.unitPrice;

  const comps = await db.select({
    componentItemId: catalogBundleComponents.componentItemId,
    quantity: catalogBundleComponents.quantity,
    revenueAllocation: catalogBundleComponents.revenueAllocation,
    costBasis: catalogItems.costBasis
  }).from(catalogBundleComponents)
    .innerJoin(catalogItems, eq(catalogItems.id, catalogBundleComponents.componentItemId))
    .where(eq(catalogBundleComponents.bundleItemId, bundleId));

  return computeBundleEconomicsFrom({
    headlinePrice: headline,
    components: comps.map((c) => ({ quantity: c.quantity, costBasis: c.costBasis, revenueAllocation: c.revenueAllocation }))
  });
}
