import { and, asc, eq, gt, ilike, inArray, sql } from 'drizzle-orm';
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
  | 'BUNDLE_SELF_REFERENCE'
  | 'BUNDLE_NESTED'
  | 'BUNDLE_CROSS_PARTNER'
  | 'BUNDLE_COMPONENT_NOT_FOUND'
  | 'BUNDLE_DUPLICATE_COMPONENT';

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
}

function requirePartner(actor: CatalogActor): string {
  if (!actor.partnerId) {
    throw new CatalogServiceError('Catalog is partner-scoped; no partner in context', 400, 'PARTNER_UNRESOLVABLE');
  }
  return actor.partnerId;
}

export async function createCatalogItem(input: CreateCatalogItemInput, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const unitPrice = deriveUnitPrice({
    explicitPrice: input.unitPrice,
    costBasis: input.costBasis != null ? input.costBasis.toFixed(2) : null,
    markupPercent: input.markupPercent != null ? input.markupPercent.toFixed(2) : null
  });
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
  const nextCost = input.costBasis !== undefined ? input.costBasis : (existing.costBasis != null ? Number(existing.costBasis) : null);
  const nextMarkup = input.markupPercent !== undefined ? input.markupPercent : (existing.markupPercent != null ? Number(existing.markupPercent) : null);
  const unitPrice = input.unitPrice !== undefined
    ? input.unitPrice.toFixed(2)
    : deriveUnitPrice({ explicitPrice: undefined, costBasis: nextCost != null ? nextCost.toFixed(2) : null, markupPercent: nextMarkup != null ? nextMarkup.toFixed(2) : null });

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.itemType !== undefined) patch.itemType = input.itemType;
  if (input.name !== undefined) patch.name = input.name;
  if (input.sku !== undefined) patch.sku = input.sku;
  if (input.description !== undefined) patch.description = input.description;
  if (input.billingType !== undefined) patch.billingType = input.billingType;
  if (input.unitPrice !== undefined || input.costBasis !== undefined || input.markupPercent !== undefined) patch.unitPrice = unitPrice;
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
  if (query.search) conditions.push(ilike(catalogItems.name, `%${query.search}%`));
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
  await getOwnedItemOr404(itemId, partnerId); // ensures the item is this partner's
  const unitPrice = input.unitPrice.toFixed(2);
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
