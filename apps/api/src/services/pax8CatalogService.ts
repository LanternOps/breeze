import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { pax8Integrations, pax8ProductMappings } from '../db/schema/pax8';
import { catalogItems } from '../db/schema/catalog';
import { createPax8ClientForIntegration } from './pax8SyncService';
import { createCatalogItem, CatalogServiceError, type CatalogActor } from './catalogService';
import type { Pax8ProductRecord, Pax8ProductPriceRecord } from './pax8Client';
import { getRedis } from './redis';
import { enrichDistributorListing } from './catalogEnrichmentService';
import type { CreateCatalogItemInput, EnrichmentProvenance } from '@breeze/shared';

const CACHE_TTL_SECONDS = 600;
const PRODUCT_FETCH_LIMIT = 5000;

export class Pax8CatalogError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code?: string) {
    super(message);
    this.name = 'Pax8CatalogError';
  }
}

function requirePartner(actor: CatalogActor): string {
  if (!actor.partnerId) throw new Pax8CatalogError('Partner scope required', 403, 'NO_PARTNER');
  return actor.partnerId;
}

async function getActiveIntegration(actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const [row] = await db
    .select()
    .from(pax8Integrations)
    .where(and(eq(pax8Integrations.partnerId, partnerId), eq(pax8Integrations.isActive, true)))
    .limit(1);
  return row ?? null;
}

export async function getPax8CatalogStatus(actor: CatalogActor): Promise<{ configured: boolean; enabled: boolean }> {
  const row = await getActiveIntegration(actor);
  return { configured: row !== null, enabled: row !== null };
}

async function loadPartnerProducts(actor: CatalogActor, vendor?: string): Promise<Pax8ProductRecord[]> {
  const integration = await getActiveIntegration(actor);
  if (!integration) throw new Pax8CatalogError('Pax8 is not connected', 400, 'PAX8_NOT_CONFIGURED');

  const partnerId = requirePartner(actor);
  const cacheKey = `pax8:products:${partnerId}${vendor ? `:${vendor.toLowerCase()}` : ''}`;
  const redis = getRedis();
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as Pax8ProductRecord[];
    } catch { /* cache is best-effort */ }
  }

  const { client } = await createPax8ClientForIntegration(integration.id);
  const products = await client.listProducts({ limit: PRODUCT_FETCH_LIMIT, vendorName: vendor });
  if (redis) {
    try { await redis.setex(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(products)); } catch { /* best-effort */ }
  }
  return products;
}

export async function searchPax8Products(
  input: { q: string; vendor?: string; limit: number },
  actor: CatalogActor,
): Promise<Pax8ProductRecord[]> {
  const needle = input.q.trim().toLowerCase();
  const products = await loadPartnerProducts(actor, input.vendor);
  const matched = products.filter((p) =>
    p.name.toLowerCase().includes(needle) ||
    (p.vendorName?.toLowerCase().includes(needle) ?? false) ||
    (p.vendorSku?.toLowerCase().includes(needle) ?? false));
  return matched.slice(0, input.limit);
}

export async function getPax8ProductPricing(productId: string, actor: CatalogActor): Promise<Pax8ProductPriceRecord[]> {
  const integration = await getActiveIntegration(actor);
  if (!integration) throw new Pax8CatalogError('Pax8 is not connected', 400, 'PAX8_NOT_CONFIGURED');
  const { client } = await createPax8ClientForIntegration(integration.id);
  return client.getProductPricing(productId);
}

export interface Pax8ImportInput {
  product: {
    source: 'pax8';
    pax8ProductId: string;
    name: string;
    vendorName: string | null;
    vendorSku: string | null;
    commitmentTerm: string | null;
    billingTerm: string | null;
    partnerBuyRate: string | null;
    currency: string | null;
    raw: Record<string, unknown>;
  };
  item: {
    name: string;
    sku?: string | null;
    description?: string | null;
    unitPrice: number;
    costBasis?: number | null;
    taxable?: boolean;
  };
  /** When true, run a best-effort web-search enrichment of the product into a
   *  tidy name + technical description before persisting. Falls back to the raw
   *  values if the AI is rate-limited/unavailable, so import never fails. */
  aiCleanup?: boolean;
}

// Pax8 billing terms map onto the catalog's billing_frequency enum. The schema
// only allows 'monthly' | 'annual'; quarterly falls back to monthly as the
// conservative default (shorter commitment, avoids over-committing). The raw
// billingTerm is preserved in attributes.pax8.billingTerm for future quarterly support.
function mapBillingFrequency(billingTerm: string | null): 'monthly' | 'annual' {
  const t = (billingTerm ?? '').toLowerCase();
  if (t.includes('year') || t.includes('annual')) return 'annual';
  return 'monthly';
}

export async function importPax8CatalogItem(input: Pax8ImportInput, actor: CatalogActor): Promise<typeof catalogItems.$inferSelect> {
  const integration = await getActiveIntegration(actor);
  if (!integration) throw new Pax8CatalogError('Pax8 is not connected', 400, 'PAX8_NOT_CONFIGURED');
  const { product, item } = input;

  // Optional web-search enrichment: turn the raw vendor listing into a clean name
  // + a real description. On any failure keep the raw values (enriched == null).
  let name = item.name;
  let description = item.description ?? null;
  let aiProvenance: EnrichmentProvenance | undefined;
  if (input.aiCleanup) {
    const query = product.vendorName ? `${product.vendorName} ${product.name}` : product.name;
    const enriched = await enrichDistributorListing(query, 'software', {
      userId: actor.userId,
      orgId: actor.accessibleOrgIds?.[0] ?? null,
    });
    if (enriched) {
      name = enriched.name;
      if (enriched.description) description = enriched.description;
      aiProvenance = enriched.provenance;
    }
  }

  const payload: CreateCatalogItemInput = {
    itemType: 'software',
    name,
    sku: item.sku ?? product.vendorSku ?? null,
    description,
    billingType: 'recurring',
    billingFrequency: mapBillingFrequency(product.billingTerm),
    unitPrice: item.unitPrice,
    costBasis: item.costBasis ?? (product.partnerBuyRate != null ? Number(product.partnerBuyRate) : undefined),
    unitOfMeasure: 'each',
    taxable: item.taxable ?? true,
    isBundle: false,
    attributes: {
      pax8: {
        source: product.source,
        pax8ProductId: product.pax8ProductId,
        vendorName: product.vendorName,
        vendorSku: product.vendorSku,
        commitmentTerm: product.commitmentTerm,
        billingTerm: product.billingTerm,
        currency: product.currency,
        raw: product.raw,
        importedAt: new Date().toISOString(),
        rawName: product.name,
        aiEnriched: aiProvenance != null,
        ...(aiProvenance ? { aiProvenance } : {}),
      },
    },
  };

  let created: typeof catalogItems.$inferSelect;
  try {
    created = await createCatalogItem(payload, actor);
  } catch (err) {
    const sku = payload.sku;
    if (err instanceof CatalogServiceError && err.code === 'DUPLICATE_SKU' && sku) {
      const [existing] = await db.select().from(catalogItems)
        .where(and(eq(catalogItems.partnerId, integration.partnerId), eq(catalogItems.sku, sku)))
        .limit(1);
      if (!existing) throw err;
      created = existing;
    } else {
      throw err;
    }
  }

  // Dedup + linkage so subscription pricing-sync can later reconcile this product.
  await db
    .insert(pax8ProductMappings)
    .values({
      integrationId: integration.id,
      partnerId: integration.partnerId,
      pax8ProductId: product.pax8ProductId,
      vendorSkuId: product.vendorSku,
      productName: product.name,
      catalogItemId: created.id,
    })
    .onConflictDoUpdate({
      target: [pax8ProductMappings.integrationId, pax8ProductMappings.pax8ProductId],
      set: { catalogItemId: created.id, productName: product.name, vendorSkuId: product.vendorSku, updatedAt: new Date() },
    });

  return created;
}
