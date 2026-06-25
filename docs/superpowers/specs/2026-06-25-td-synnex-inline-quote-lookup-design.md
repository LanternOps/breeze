# TD SYNNEX EC Express — inline lookup in the quote editor

**Date:** 2026-06-25
**Status:** Design approved
**Area:** apps/web (billing / quotes), reuses existing apps/api distributor routes

## Problem

The TD SYNNEX EC Express connector (#1848) can look up a SKU's live price &
availability and import it into `catalog_items`, but that flow lives **only** in
Settings → Distributors. When a tech is building a quote, the pricing-table
block offers just two add-line modes — **Catalog item** (search the org's own
catalog) and **Manual line**. There is no way to look up a distributor SKU and
pull it into the quote without leaving the editor, importing in Settings, then
coming back.

## Goal

While editing a quote's pricing table, a tech can:
1. Search TD SYNNEX EC Express by SKU,
2. see live cost / MSRP / availability,
3. set a sell price (prefilled, editable),
4. and with one click **import the item to the partner catalog** and **add it as
   a catalog-sourced quote line**.

## Locked decisions

- **Connector:** EC Express only. Digital Bridge is transactional-only with no
  reliable price/availability surface (verified in #1848). The mode is gated on
  the org having EC Express configured **and** enabled.
- **Add action:** Import to catalog → add catalog line (single "Import & add"
  button). The item becomes a durable, reusable `catalog_items` row and the
  quote line keeps its catalog linkage. No one-off / non-catalog add path.
- **Pricing:** prefill the suggested sell price (`msrp`, else
  `cost × (1 + defaultMarkupPercent)`), editable before add. Cost basis is
  always captured from the lookup.

## Architecture

Entirely frontend. Every backend route already exists and is **unchanged**:

| Route | Method | Purpose | Auth |
|---|---|---|---|
| `/distributors/td-synnex-ec/status` | GET | gate (`{ configured, enabled }`) | partner/system + `catalog:read` |
| `/distributors/td-synnex-ec/lookup?q=` | GET | live SKU lookup → `TdSynnexEcProduct[]` | partner/system + `catalog:read` |
| `/distributors/td-synnex-ec/import` | POST | create `catalog_items` row → `CatalogItem` | partner/system + `catalog:write` + **MFA** |
| `/quotes/:id/lines/catalog` | POST | add catalog-sourced quote line | quotes:write |

(Routes defined in `apps/api/src/routes/catalog/distributors.ts`; lookup/import
service logic in `apps/api/src/services/tdSynnexEcExpress.ts`.)

### New web pieces

1. **`apps/web/src/lib/api/distributors.ts`** — thin client over `fetchWithAuth`:
   - `ecExpressStatus(): Promise<{ configured: boolean; enabled: boolean }>`
   - `ecExpressLookup(q: string): Promise<TdSynnexEcProduct[]>`
   - `ecExpressImport(body: { product: TdSynnexEcProduct; item: ImportItem }): Promise<CatalogItem>`

   The `TdSynnexEcExpressPanel` settings component currently inlines these calls;
   centralizing them here is a small win. Migrating the panel to this client is
   **out of scope** (noted as a follow-up).

2. **Third mode `'distributor'`** in `BlockCard`'s mode switch
   (`apps/web/src/components/billing/quotes/QuoteEditor.tsx`). A "Search
   distributor" button alongside "Catalog item" and "Manual line", rendered
   **only** when `ecActive === true` (see gate below). When inactive the editor
   is byte-identical to today.

3. **`DistributorLookup` subcomponent** (new file under
   `apps/web/src/components/billing/quotes/`): SKU input (min 1 char) → results
   list. Each result row shows name, SKU, status, cost, MSRP, availability, an
   **editable prefilled sell-price field**, and an **"Import & add"** button.

### Gate

The distributor mode renders only when **all** hold:
`status.configured && status.enabled && can('catalog', 'write')`.

Status is fetched once on editor mount (alongside the existing catalog load) and
cached in `ecActive`. Hiding (not disabling) the mode avoids a dead-end for users
who can't import.

## Data flow (happy path)

1. Editor mounts → `ecExpressStatus()` → set `ecActive`.
2. Tech selects "Search distributor", types a SKU, submits → `ecExpressLookup(q)`
   → render `TdSynnexEcProduct[]`.
3. Sell price defaults to `product.msrp ?? product.cost` (editable). The EC
   `defaultMarkupPercent` setting is **not** returned by the `status` route
   today, so applying it client-side would require a one-field additive change
   to `getEcExpressStatus` (return `defaultMarkupPercent`). **Decision:** ship
   v1 with `msrp ?? cost` and leave markup to the tech; the markup default is a
   noted follow-up so the backend stays untouched for this change.
4. "Import & add" builds:
   ```
   item = {
     name: product.name,
     sku: product.synnexSku,
     description: product.description ?? null,
     unitPrice: sellPrice,
     costBasis: product.cost ?? null,
     taxable: true,
   }
   ```
   → `ecExpressImport({ product, item })` → new `CatalogItem`.
5. Reuse the existing `addCatalog(blockId, newItem)` handler →
   `addCatalogLine(quoteId, { catalogItemId, quantity: 1, blockId })`.
6. `refresh()` the quote + `loadCatalog()` again so the new item also appears in
   the Catalog-item picker.

## Edge cases & error handling

- **Duplicate SKU.** `import` surfaces a typed `CatalogServiceError`
  (duplicate-SKU) which the route already maps to a 4xx. On that specific code,
  resolve the existing catalog item by SKU (from the loaded catalog list, or a
  targeted `listCatalog({ sku })`) and add **that** line instead — re-importing a
  known SKU just adds it, no error toast. If it can't be resolved, surface the
  error.
- **MFA required (403).** `import` is MFA-gated server-side. Mirror the Pax8
  pattern: `runAction` surfaces a friendly "MFA required" hint; the tech
  re-authenticates and retries.
- **EC errors** (`EC_AUTH_FAILED` 401, `EC_NOT_CONFIGURED`) — surface the
  response message.
- All mutations go through `runAction` (CLAUDE.md requirement), keeping
  `no-silent-mutations` green.

## Testing

- **Component** (`QuoteEditor` / `DistributorLookup`):
  - distributor mode hidden when `ecActive` false / `catalog:write` absent;
    shown when active.
  - lookup renders results.
  - "Import & add" calls `ecExpressImport` then `addCatalogLine` with the
    returned id.
  - duplicate-SKU path falls back to adding the existing item (no error toast).
  - 403 surfaces the MFA hint.
- **Web client** (`distributors.ts`): unit test mocking `fetchWithAuth` for
  status / lookup / import happy + error paths.
- `no-silent-mutations` test stays green.

## Out of scope

- Digital Bridge inline lookup.
- One-off (non-catalog) distributor line.
- Bulk catalog browse / FTP product feed.
- Migrating `TdSynnexEcExpressPanel` to the new `distributors.ts` client.

## Follow-up (feature b, separate spec)

Pax8 subscription → contract-line picker UI (the deferred `POST
/pax8/subscriptions/link` surface). Tracked separately; this spec is quoting-only.
