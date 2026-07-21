# Pax8 Catalog Search — Design

**Date:** 2026-06-28
**Status:** Approved (design), pending implementation plan
**Author:** Todd Hebebrand (with Claude)

## Summary

Let partners search the Pax8 product catalog and import products into the Breeze
catalog as catalog items, mirroring the existing TD SYNNEX import-into-catalog
flow. Reachable from three entry points: the catalog add flow, the quote editor,
and the contract editor.

Pax8 is already integrated for **companies** and **subscriptions**
(`pax8Client.ts` → `listCompanies()`, `listSubscriptions()`). This feature adds a
third data stream — **products** — and an import path into `catalogItems`. It
reuses the existing per-partner Pax8 OAuth credentials (`pax8Integrations`); there
is **no new credential/config surface**.

## Goals

- Free-text search of the Pax8 product catalog, scoped to the partner's Pax8
  account, returning normalized product results.
- Per-product, per-term pricing surfaced from Pax8: **cost** (`partnerBuyRate`)
  and **list/suggested-retail price** (the price charged to the end customer).
- One-click import into `catalogItems`, defaulting `costBasis` and `unitPrice`
  directly from Pax8's pricing (no markup guesswork), with the sell price
  user-editable before import.
- Dedup + linkage via the existing `pax8ProductMappings` table.
- Available from the catalog add flow, the quote editor, and the contract editor
  via one shared lookup component.

## Non-Goals

- No synced/local product-catalog table or background sync worker (search is a
  live proxy with a short-lived cache — see Search caching).
- No AI title cleanup. Pax8 product names are already clean (unlike raw TD SYNNEX
  titles), so the `aiCleanup` flag used by the TD SYNNEX EC Express import is
  intentionally omitted. Easy to add later if needed.
- No new Pax8 credential/config UI — reuse the existing `pax8Integrations` row.
- No changes to the existing Pax8 subscription-linking flows.

## Architecture & Data Flow

Mirror the TD SYNNEX distributor pattern (`/distributors/td-synnex-ec/*`).

```
Web (3 entry points)
  → GET  /distributors/pax8/search
  → GET  /distributors/pax8/pricing
  → POST /distributors/pax8/import
      → pax8CatalogService
          → Pax8Client (searchProducts / getProductPricing)  → Pax8 API
          → createCatalogItem()  + upsert pax8ProductMappings
```

- **Search** is read-only, gated on an active `pax8Integrations` row.
- **Import** creates a catalog item — write permission + MFA, exactly like
  `importEcExpressCatalogItem`.
- Everything runs partner-axis under `withDbAccessContext`.

## Components

### 1. Pax8 client additions — `apps/api/src/services/pax8Client.ts`

Follows the existing client style (OAuth via `getAccessToken()`, `requestJson`,
`firstString`/`firstNumber`/`normalizeMoney` helpers, paginated `fetchPaged`).

New types:

```ts
interface Pax8ProductRecord {
  pax8ProductId: string;
  name: string;
  vendorName: string | null;
  vendorSku: string | null;
  sku: string | null;
  shortDescription: string | null;
  raw: JsonRecord;
}

interface Pax8ProductPriceRecord {
  commitmentTerm: string | null;   // e.g. "Annual", "Monthly"
  billingTerm: string | null;
  partnerBuyRate: string | null;   // OUR cost (normalizeMoney)
  suggestedRetailPrice: string | null; // end-customer list price (normalizeMoney)
  currencyCode: string | null;
  raw: JsonRecord;
}
```

New methods:

- `searchProducts({ query, vendorName?, limit }): Promise<Pax8ProductRecord[]>`
  — calls `GET /v1/products` (passing `vendorName` server-side where supported),
  substring-filters on product name client-side, bounded fetch via `fetchPaged`.
- `getProductPricing(productId): Promise<Pax8ProductPriceRecord[]>` — calls
  `GET /v1/products/{id}/pricing`, normalizes each commitment/billing entry.
- `normalizeProduct` / `normalizeProductPrice` helpers in the existing style.

> **Verification item (implementation):** confirm the exact `/v1/products`
> query-param support against Pax8 docs (free-text product-name filter vs.
> `vendorName`-only). The service is written to degrade to client-side substring
> filtering over a bounded page fetch if server-side text search is unavailable.

### 2. Service — `apps/api/src/services/pax8CatalogService.ts`

New file. Exports:

- `getPax8CatalogStatus(actor)` → `{ configured: boolean, enabled: boolean }`
  derived from the partner's `pax8Integrations` row (no secrets).
- `searchPax8Products({ q, vendor?, limit }, actor)` → `Pax8ProductRecord[]`
- `getPax8ProductPricing(productId, actor)` → `Pax8ProductPriceRecord[]`
- `importPax8CatalogItem({ product, item }, actor)` → created `CatalogItem`
- `class Pax8CatalogError extends Error { code; status }` for typed route mapping.

Reuses `createPax8ClientForIntegration()` from `pax8SyncService.ts` to obtain a
credentialed client.

#### Search caching

Per-partner Redis cache of the normalized product list, ~10 min TTL, key
`pax8:products:{partnerId}`. First search warms the cache (one bounded fetch from
Pax8); subsequent searches filter the cached list in-memory. Keeps the live-proxy
model responsive over a large vendor catalog without a synced table or worker.
Cache miss → fetch from Pax8 and populate. Pricing lookups are not cached (small,
per-product, on demand).

#### Import behavior

`importPax8CatalogItem`:

1. Calls `createCatalogItem()` with:
   - `itemType` mapped from the Pax8 product (default `software`).
   - `costBasis` = chosen term's `partnerBuyRate` (our cost).
   - `unitPrice` = user-submitted sell price (pre-filled from the term's
     `suggestedRetailPrice`, editable before import).
   - `markupPercent` = derived/optional (not the source of truth).
   - `attributes` = `{ source: 'pax8', pax8ProductId, vendorName, vendorSku,
     commitmentTerm, billingTerm, currencyCode }`.
2. **Upserts `pax8ProductMappings`** (Pax8 product → new catalog item id) so
   re-imports dedup and subscription pricing-sync can reconcile.

### 3. API routes — `apps/api/src/routes/catalog/distributors.ts`

Add alongside the TD SYNNEX routes, reusing `scopes` / `readPerm` / `writePerm`.

| Method | Path | Guards | Handler |
|---|---|---|---|
| GET | `/distributors/pax8/status` | scopes, readPerm | `getPax8CatalogStatus` |
| GET | `/distributors/pax8/search?q=&vendor=&limit=` | scopes, readPerm | `searchPax8Products` |
| GET | `/distributors/pax8/pricing?productId=` | scopes, readPerm | `getPax8ProductPricing` |
| POST | `/distributors/pax8/import` | scopes, writePerm, `requireMfa()` | `importPax8CatalogItem` |

- `searchQuerySchema`-style validation: `q` min 2 / max 200, `vendor` optional
  max 200, `limit` 1–50 default 20.
- `pax8ProductSchema` (typed + bounded, mirrors `ecProductSchema`):
  `source: z.literal('pax8')`, `pax8ProductId`, `name`, `vendorName`,
  `vendorSku`, `sku`, `description`, plus the selected term's `commitmentTerm` /
  `billingTerm` / `partnerBuyRate` (normalized money string) / `currency`, and a
  size-bounded `raw` passthrough (≤200KB).
- `pax8ImportSchema` = `{ product: pax8ProductSchema, item: {...} }` — `item`
  block identical to `ecImportSchema.item` (name, sku, description, `unitPrice`,
  `costBasis`, `markupPercent`, `taxable`); **no `aiCleanup` flag**.
- Error handling: new `handlePax8Error` mapping `Pax8CatalogError` and reusing the
  `CatalogServiceError` mapping (duplicate-SKU / price-range), else log + rethrow
  to the global handler — same shape as `handleEcError`.

### 4. Web — one shared component, three mounts

New client functions in `apps/web/src/lib/api/distributors.ts`: `pax8Status()`,
`pax8Search(q, vendor?)`, `pax8Pricing(productId)`, `pax8Import(body)`, plus
`Pax8Product` / `Pax8PriceOption` / `Pax8ImportItem` types. Import calls wrapped
in `runAction` per the web mutation convention.

**`Pax8ProductLookup.tsx`** (modeled on `DistributorLookup.tsx`):

- Search box → results.
- Per result: a **term dropdown** populated from `pax8Pricing(productId)` (lazy
  on expand/select). Selecting a term sets `costBasis` = `partnerBuyRate` and
  pre-fills the sell-price field with `suggestedRetailPrice`.
- Sell-price editor (editable) + margin summary via the existing
  `computeMarginBreakdown` / `formatMarginSummary` from `marginMath`.
- "Import & add" → `onImportAdd(product, selectedTerm, sellPrice)`.
- `data-testid` conventions consistent with `DistributorLookup`
  (`pax8-product-search-*`, `pax8-product-result-*`, etc.).

Mounts:

- **Catalog add flow:** `Pax8CatalogDrawer.tsx` (like `CatalogDistributorDrawer`),
  button in `CatalogItemsTab` gated on `pax8Status().enabled`. On import →
  `onImported(catalogItem)`.
- **Quote editor:** mount `Pax8ProductLookup` alongside the existing TD SYNNEX
  `DistributorLookup`; import drops a quote line.
- **Contract editor:** an "Add from Pax8 catalog" drawer that imports the product
  and adds a contract line. Distinct from the existing
  `ContractPax8Drawer`/`LinkSubscriptionPicker` subscription-linking flow; gated
  on the same `pax8IntegrationId` presence already loaded by `ContractEditor`.

## Tenancy / RLS

- All operations partner-axis. **No new tables** — `pax8ProductMappings` already
  exists with partner RLS (per `apps/api/src/db/schema/pax8.ts`).
- Search/import run under `withDbAccessContext`; no RLS migration required.
- No allowlist change in `rls-coverage.integration.test.ts` (no new tenant table).

## Error Handling

- Pax8 API failures → `Pax8ApiError` (existing) surfaced by the service as
  `Pax8CatalogError` with an appropriate status; mapped to a typed JSON error by
  `handlePax8Error`.
- Import duplicate-SKU / price-range → `CatalogServiceError` (existing mapping).
- Missing/disabled integration → `status.enabled = false`; web hides the entry
  points. Direct API calls return a typed 4xx, not a 500.
- Web mutations use `runAction`; non-401 errors toasted, 401 defers to auth
  redirect (per CLAUDE.md convention).

## Testing

API (Vitest):

- `pax8Client`: table-driven `normalizeProduct` / `normalizeProductPrice` over raw
  fixtures (nested vendor objects, snake/camel keys, missing fields, money
  normalization) — mirror the `normalizeSubscription` coverage.
- `pax8CatalogService`: search cache hit/miss; import → `createCatalogItem` call
  args + `pax8ProductMappings` upsert; status derivation.
- Route tests: auth/scope/permission, MFA gate on import, query/body validation,
  error mapping (Pax8ApiError → status, CatalogServiceError → status).

Web (Vitest + jsdom):

- `Pax8ProductLookup`: search render, term-select updates cost + sell defaults,
  import callback payload, error display. Mock the distributor client.

Reuse existing Drizzle-mock + `runAction` test patterns; follow the
`breeze-testing` skill conventions.

## Open Verification Items (implementation-time)

1. Exact Pax8 `/v1/products` query-param support (free-text vs `vendorName`).
2. Exact shape of `/v1/products/{id}/pricing` (commitment/billing term fields and
   the `partnerBuyRate` / suggested-retail field names) — normalization helpers
   are written defensively (`firstString`/`firstNumber` over candidate keys).
3. `catalogItems.billingType` enum value to use for a recurring Pax8 license
   (confirm against the schema; likely a subscription/recurring value).
