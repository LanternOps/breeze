// Typed fetch wrappers for the Product Catalog API.
//
// Mirrors the contracts/invoice web layer: there is no generic apiClient in this
// app — calls go through `fetchWithAuth` (apps/web/src/stores/auth.ts), which
// injects the active orgId, refreshes tokens, and returns a raw `Response`. Each
// wrapper returns that `Response` so callers keep control over 401 handling and
// `runAction`. Every catalog route responds with a `{ data: ... }` envelope.
//
// Money / quantity fields arrive as numeric(12,2) strings (e.g. '150.00').
// Catalog items have no per-item currency, so prices render in the app default
// (USD) via lib/timeFormat.formatMoney.

import { fetchWithAuth } from '../../stores/auth';

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
  unitPrice: string;
  costBasis: string | null;
  markupPercent: string | null;
  unitOfMeasure: string;
  taxable: boolean;
  taxCategory: string | null;
  isBundle: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
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
}

export interface OrgPriceOverride {
  id: string;
  catalogItemId: string;
  orgId: string;
  unitPrice: string;
}

/** Shape of `GET /catalog/:id` — `{ data: { item, overrides, components } }`. */
export interface CatalogItemDetail {
  item: CatalogItem;
  overrides: OrgPriceOverride[];
  components: BundleComponentRow[];
}

/** Shape of `GET /catalog/:id/economics` — `{ data: { ... } }`. */
export interface BundleEconomics {
  headlinePrice: string;
  totalCost: string;
  margin: string;
  marginPct: number;
  allocationTotal: string;
  allocationMatchesHeadline: boolean;
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

export function createCatalogItem(body: unknown): Promise<Response> {
  return fetchWithAuth('/catalog', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

export function updateCatalogItem(id: string, body: unknown): Promise<Response> {
  return fetchWithAuth(`/catalog/${id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

export function archiveCatalogItem(id: string): Promise<Response> {
  return fetchWithAuth(`/catalog/${id}/archive`, { method: 'POST' });
}

export function setBundleComponents(id: string, components: BundleComponentInput[]): Promise<Response> {
  return fetchWithAuth(`/catalog/${id}/components`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ components }),
  });
}

export function getBundleEconomics(id: string, orgId?: string): Promise<Response> {
  const qs = orgId ? `?orgId=${orgId}` : '';
  return fetchWithAuth(`/catalog/${id}/economics${qs}`);
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

/** Gross margin percent from price vs cost, or null when cost is absent / price ≤ 0. */
export function computeMargin(
  unitPrice: string | number | null | undefined,
  costBasis: string | number | null | undefined,
): number | null {
  if (costBasis == null || costBasis === '') return null;
  const price = Number(unitPrice);
  const cost = Number(costBasis);
  if (!Number.isFinite(price) || !Number.isFinite(cost) || price <= 0) return null;
  return ((price - cost) / price) * 100;
}

/** '—' when no margin, else one-decimal percent (e.g. '42.5%', '-8.0%'). */
export function formatMargin(pct: number | null): string {
  if (pct == null) return '—';
  return `${pct.toFixed(1)}%`;
}

/** Tailwind text tone for a margin value: destructive when the item loses money. */
export function marginTone(pct: number | null): string {
  if (pct == null) return 'text-muted-foreground';
  if (pct < 0) return 'text-destructive';
  return 'text-foreground';
}
