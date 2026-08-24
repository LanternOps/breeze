// Typed fetch wrappers for the Product Catalog API.
//
// Mirrors the contracts/invoice web layer: there is no generic apiClient in this
// app — calls go through `fetchWithAuth` (apps/web/src/stores/auth.ts), which
// injects the active orgId, refreshes tokens, and returns a raw `Response`. Each
// wrapper returns that `Response` so callers keep control over 401 handling and
// `runAction`. Every catalog route responds with a `{ data: ... }` envelope.
//
// Money / quantity fields arrive as numeric(12,2) strings (e.g. '150.00').
// Sell prices live in a per-currency price book (`prices`, multi-currency wave 3,
// #3775): an item has zero or more `{ currencyCode, unitPrice }` rows and a
// missing currency is a gap — never converted. Render amounts with the
// currency-aware `components/billing/shared/format.formatMoney`, never the
// USD-only lib/timeFormat one.

import { fetchWithAuth } from '../../stores/auth';
import type { PolishTextResponse } from '@breeze/shared';
import { formatPercent } from '../i18n/format';

export type CatalogItemType = 'hardware' | 'software' | 'service';
export type CatalogBillingType = 'one_time' | 'recurring';

/** A row from `GET /catalog` / `GET /catalog/:id`.`item`. */
export interface CatalogItem {
  id: string;
  partnerId: string;
  itemType: CatalogItemType;
  name: string;
  sku: string | null;
  description: string | null;
  billingType: CatalogBillingType;
  /** @deprecated server mirror of the partner-currency price-book row — web code
   *  must not read it (Task 19 grep); removed with the cleanup migration. */
  unitPrice: string;
  costBasis: string | null;
  /** ISO 4217 code `costBasis` is denominated in (NOT NULL server-side). */
  costCurrency: string;
  markupPercent: string | null;
  unitOfMeasure: string;
  taxable: boolean;
  taxCategory: string | null;
  isBundle: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  /** Aggregated price book — list and detail both carry it (ordered by currency).
   *  The list aggregate carries only the two value columns. */
  prices: PriceBookEntry[];
}

/** One price-book row from `GET /catalog/:id/prices` / `PUT /catalog/:id/prices/:code`. */
export interface ItemPrice {
  id: string;
  itemId: string;
  currencyCode: string;
  unitPrice: string;
}

/** The value columns of a price-book row, as aggregated onto list rows. */
export type PriceBookEntry = Pick<ItemPrice, 'currencyCode' | 'unitPrice'>;

/** AI-enrichment draft returned by `POST /catalog/enrich` (descriptive fields only — never a price). */
export interface EnrichDraft {
  name: string;
  description: string | null;
  itemType: CatalogItemType;
  unitOfMeasure: string;
  taxable: boolean;
  taxCategory: string | null;
}

/** Provenance recorded for an AI-enriched item; stored under `attributes.enrichment` on save. */
export interface EnrichmentProvenance {
  source: 'ai_enrich';
  model: string;
  query: string;
  suggestion: Record<string, unknown>;
  enrichedAt: string;
  enrichedBy: string;
}

/** Shape of `POST /catalog/enrich` — `{ data: EnrichResult }`. */
export interface EnrichResult {
  draft: EnrichDraft;
  priceGuidance: string | null;
  /** Best-effort single-unit acquisition-cost estimate (what the MSP would pay); null when unknown. */
  estimatedCost: number | null;
  provenance: EnrichmentProvenance;
}

/** A row from `catalog_bundle_components` (returned by `GET /catalog/:id`.`components`). */
export interface BundleComponentRow {
  id: string;
  partnerId: string;
  bundleItemId: string;
  componentItemId: string;
  quantity: string;
  showOnInvoice: boolean;
  revenueAllocation: string | null;
  /** Currency the allocation was authored in; null iff revenueAllocation is null. */
  allocationCurrency: string | null;
}

export interface OrgPriceOverride {
  id: string;
  catalogItemId: string;
  orgId: string;
  currencyCode: string;
  unitPrice: string;
}

/** Shape of `GET /catalog/:id/resolve` — the server's spec-§6 resolution for one
 *  org + currency: an org override in that currency wins, else the price-book
 *  row, else the endpoint answers 409 `NO_PRICE_FOR_CURRENCY` (a gap — never a
 *  converted or other-currency number). Document editors gate on THIS, not on
 *  `item.prices`, which cannot see org overrides. */
export interface ResolvedCatalogPrice {
  unitPrice: string;
  currencyCode: string;
  costBasis: string | null;
  costCurrency: string;
  marginAvailable: boolean;
  taxable: boolean;
  taxCategory: string | null;
  source: 'org_override' | 'price_book';
}

/** Shape of `GET /catalog/:id` — `{ data: { item, prices, overrides, components } }`. */
export interface CatalogItemDetail {
  item: CatalogItem;
  prices: ItemPrice[];
  overrides: OrgPriceOverride[];
  components: BundleComponentRow[];
}

/** Shape of `GET /catalog/:id/economics` — `{ data: { ... } }`. Money totals are
 *  null unless the price book is complete in `currencyCode` AND every component
 *  cost is in that currency — never a partial sum. */
export interface BundleEconomics {
  currencyCode: string;
  headlinePrice: string | null;
  priceBookComplete: boolean;
  marginAvailable: boolean;
  totalCost: string | null;
  margin: string | null;
  marginPct: number | null;
  /** false when a component allocation was authored in another currency — the
   *  split is then unavailable in `currencyCode` (allocationTotal null). */
  allocationAvailable: boolean;
  allocationTotal: string | null;
  allocationMatchesHeadline: boolean;
  missingPriceComponentIds: string[];
}

/** One component as sent to `PUT /catalog/:id/components`. */
export interface BundleComponentInput {
  componentItemId: string;
  quantity: number;
  showOnInvoice: boolean;
  revenueAllocation?: number | null;
}

export interface ListCatalogQuery {
  itemType?: CatalogItemType;
  isActive?: boolean;
  isBundle?: boolean;
  search?: string;
  limit?: number;
  cursor?: string;
}

/** Server caps a single page at 200 rows (listCatalogQuerySchema). */
export const CATALOG_PAGE_LIMIT = 200;

function buildQuery(q: ListCatalogQuery): string {
  const params = new URLSearchParams();
  if (q.itemType) params.set('itemType', q.itemType);
  if (q.isActive != null) params.set('isActive', String(q.isActive));
  if (q.isBundle != null) params.set('isBundle', String(q.isBundle));
  if (q.search) params.set('search', q.search);
  if (q.limit != null) params.set('limit', String(q.limit));
  if (q.cursor) params.set('cursor', q.cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function listCatalog(query: ListCatalogQuery = {}): Promise<Response> {
  return fetchWithAuth(`/catalog${buildQuery(query)}`);
}

export function getCatalogItem(id: string): Promise<Response> {
  return fetchWithAuth(`/catalog/${id}`);
}

/** Resolve an item's price for `currencyCode` as `orgId` would be billed (org
 *  override → price book). `orgId` is sent explicitly — or injection is skipped
 *  for a partner-level lookup — so the active-org auto-injection can never swap
 *  in a different org's overrides. 409 `NO_PRICE_FOR_CURRENCY` is the gap. */
export function resolveCatalogPrice(id: string, currencyCode: string, orgId: string | null): Promise<Response> {
  const params = new URLSearchParams({ currencyCode: currencyCode.trim().toUpperCase() });
  if (orgId) {
    params.set('orgId', orgId);
    return fetchWithAuth(`/catalog/${id}/resolve?${params.toString()}`);
  }
  return fetchWithAuth(`/catalog/${id}/resolve?${params.toString()}`, { skipOrgIdInjection: true });
}

export function createCatalogItem(body: unknown): Promise<Response> {
  return fetchWithAuth('/catalog', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

export function enrichCatalogItemRequest(
  query: string,
  hint?: CatalogItemType,
): Promise<Response> {
  return fetchWithAuth('/catalog/enrich', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ query, ...(hint ? { hint } : {}) }),
  });
}

/** Shape of `POST /catalog/polish` — `{ data: PolishResult }`. Derived from the
 *  shared schema so the web contract can't silently drift from the API's. */
export type PolishResult = PolishTextResponse;

/** Presentation-only AI polish of a name and/or description. Send only the
 *  fields you want polished; omitted/blank fields come back null. */
export function polishTextRequest(
  input: { name?: string | null; description?: string | null },
): Promise<Response> {
  return fetchWithAuth('/catalog/polish', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
}

export function updateCatalogItem(id: string, body: unknown): Promise<Response> {
  return fetchWithAuth(`/catalog/${id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

export function archiveCatalogItem(id: string): Promise<Response> {
  return fetchWithAuth(`/catalog/${id}/archive`, { method: 'POST' });
}

// Product image (one per item). Multipart upload — no JSON Content-Type so the
// browser sets the multipart boundary itself. Responds { data: { imageId, ... } }.
export function uploadCatalogItemImage(id: string, file: File): Promise<Response> {
  const form = new FormData();
  form.append('file', file);
  return fetchWithAuth(`/catalog/${id}/image`, { method: 'POST', body: form });
}

// Server-side image import from a URL. The server downloads + validates (SSRF-
// guarded) and stores it. Responds { data: { imageId, ... } }.
export function importCatalogItemImageFromUrl(id: string, url: string): Promise<Response> {
  return fetchWithAuth(`/catalog/${id}/image/from-url`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ url }),
  });
}

/** Path for the auth'd image GET. A bare <img src> would 401, so callers
 *  fetchWithAuth this then objectURL the blob (see CatalogImagePreview). */
export function catalogItemImagePath(id: string): string {
  return `/catalog/${id}/image`;
}

export function deleteCatalogItemImageRequest(id: string): Promise<Response> {
  return fetchWithAuth(`/catalog/${id}/image`, { method: 'DELETE' });
}

/** `allocationCurrency` names the currency any `revenueAllocation` amounts are
 *  authored in (required by the server when one is present). */
export function setBundleComponents(id: string, components: BundleComponentInput[], allocationCurrency?: string): Promise<Response> {
  return fetchWithAuth(`/catalog/${id}/components`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ components, ...(allocationCurrency ? { allocationCurrency } : {}) }),
  });
}

// Economics are computed in ONE currency: `currencyCode` when given, else the
// org's currency (with orgId), else the partner's — the server never converts.
export function getBundleEconomics(
  id: string,
  opts: { orgId?: string; currencyCode?: string } = {},
): Promise<Response> {
  const params = new URLSearchParams();
  if (opts.orgId) params.set('orgId', opts.orgId);
  if (opts.currencyCode) params.set('currencyCode', opts.currencyCode);
  const qs = params.toString();
  return fetchWithAuth(`/catalog/${id}/economics${qs ? `?${qs}` : ''}`);
}

// Price book (multi-currency wave 3). One row per currency; PUT upserts.
export function listItemPrices(id: string): Promise<Response> {
  return fetchWithAuth(`/catalog/${id}/prices`);
}

export function setItemPrice(id: string, currencyCode: string, unitPrice: number): Promise<Response> {
  return fetchWithAuth(`/catalog/${id}/prices/${currencyCode}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ unitPrice }),
  });
}

export function removeItemPrice(id: string, currencyCode: string): Promise<Response> {
  return fetchWithAuth(`/catalog/${id}/prices/${currencyCode}`, { method: 'DELETE' });
}

// Per-org price overrides (#1368). The route is partner/system-scoped: an MSP
// sets a customer-specific price distinct from the catalog base. unitPrice is a
// number (money) to match orgPriceOverrideSchema. `currencyCode` is the currency
// the override is written in (defaults server-side to the org's currency).
export function setOrgPriceOverride(
  id: string,
  orgId: string,
  unitPrice: number,
  currencyCode?: string,
): Promise<Response> {
  return fetchWithAuth(`/catalog/${id}/pricing/${orgId}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ unitPrice, ...(currencyCode ? { currencyCode } : {}) }),
  });
}

export function removeOrgPriceOverride(id: string, orgId: string): Promise<Response> {
  return fetchWithAuth(`/catalog/${id}/pricing/${orgId}`, { method: 'DELETE' });
}

// ---- presentation helpers -------------------------------------------------

export const CATALOG_TYPE_LABELS: Record<CatalogItemType, string> = {
  hardware: 'Hardware',
  software: 'Software',
  service: 'Service',
};

export const CATALOG_TYPE_ORDER: CatalogItemType[] = ['hardware', 'software', 'service'];

// Quiet tinted chips, one hue per type (mirrors the contract status badge style).
// Restrained: the chip carries category, not decoration.
export const CATALOG_TYPE_CHIP: Record<CatalogItemType, string> = {
  hardware: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400',
  software: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400',
  service: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
};

/** The item's price-book row for `currencyCode` (case-insensitive), or null when
 *  the book has no row in that currency. Never falls back to another currency
 *  or to the deprecated `unitPrice` mirror — a gap is a gap (no conversion, ever). */
export function priceFor(
  item: Pick<CatalogItem, 'prices'> | { prices?: PriceBookEntry[] | null },
  currencyCode: string | null | undefined,
): string | null {
  if (!currencyCode) return null;
  const code = currencyCode.trim().toUpperCase();
  const row = (item.prices ?? []).find((p) => p.currencyCode.toUpperCase() === code);
  return row ? row.unitPrice : null;
}

/** Gross margin percent from price vs cost. Null when cost is absent, price ≤ 0,
 *  OR the price and cost currencies differ — margin is never computed across
 *  currencies (no conversion, ever). */
export function computeMargin(
  unitPrice: string | number | null | undefined,
  costBasis: string | number | null | undefined,
  priceCurrency: string | null | undefined,
  costCurrency: string | null | undefined,
): number | null {
  if (costBasis == null || costBasis === '') return null;
  if (!priceCurrency || !costCurrency) return null;
  if (priceCurrency.trim().toUpperCase() !== costCurrency.trim().toUpperCase()) return null;
  const price = Number(unitPrice);
  const cost = Number(costBasis);
  if (!Number.isFinite(price) || !Number.isFinite(cost) || price <= 0) return null;
  return ((price - cost) / price) * 100;
}

/** '—' when no margin, else one-decimal percent (e.g. '42.5%', '-8.0%'). */
export function formatMargin(pct: number | null): string {
  if (pct == null) return '—';
  return formatPercent(pct / 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** Tailwind text tone for a margin value: destructive when the item loses money. */
export function marginTone(pct: number | null): string {
  if (pct == null) return 'text-muted-foreground';
  if (pct < 0) return 'text-destructive';
  return 'text-foreground';
}
