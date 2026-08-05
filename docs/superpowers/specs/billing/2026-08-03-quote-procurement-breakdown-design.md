# Quote Procurement Breakdown — Vendor Snapshot + Order Tracking — Design Spec

**Date:** 2026-08-03
**Status:** Approved (advisor quorum: Fable + Codex gpt-5.6-sol xhigh, aligned on all questions)
**Author:** Todd Hebebrand + Claude

## Summary

The MSP-facing quote Detail tab now renders a **"To be ordered" breakdown**
(`QuoteOrderBreakdown.tsx`, shipped alongside this spec) for `accepted`/
`converted` quotes: SKU, part number, qty, unit/extended cost, markup. This
spec covers the three follow-on pieces:

1. **Vendor snapshot** — quote lines currently drop distributor identity
   entirely at the quote-line boundary (`part_number` is even silently NULL for
   distributor-added lines). Add snapshot columns so the breakdown can say
   *where* to order each line.
2. **Order tracking** — a separate header+lines table pair (`quote_orders` +
   `quote_order_lines`) recording what was actually ordered, received, and
   tracked. Decided: separate table, NOT columns on `quote_lines` (Todd,
   2026-08-03).
3. **Breakdown optimizations** — CSV/TSV export, Pax8 staged-order
   cross-reference badges, group-by-vendor. Live cost-drift check is designed
   but deferred (Phase 3).

**Why snapshot, not read-time join** (all three verified in code):
- `quote_lines` carries no vendor marker at all; the only trace is nullable
  `catalog_item_id` with no FK.
- `catalog_items.attributes` jsonb holds vendor identity in THREE incompatible
  shapes (`distributor.source` for EC/nightly, `distributor.provider` for
  Digital Bridge, `pax8.*`) and is untyped on the web.
- `td_synnex_price_availability` is **partner-axis RLS (shape 3)** — the
  org-scoped `getQuote` context reads zero rows from it, silently.

Snapshot-at-add-time also matches the quote's existing frozen-document
contract (`sku`/`part_number`/`unit_cost`/`item_type` are already snapshotted;
converted invoices deliberately bill frozen prices).

## Phase 1 — Vendor snapshot on `quote_lines`

### Columns (all nullable, plain varchar — no enum, no jsonb)

| column | type | notes |
|---|---|---|
| `procurement_source` | varchar(40) | `'td_synnex'` \| `'pax8'` \| null. NOT `'manual'` — absence of identity, not a pseudo-vendor. varchar so a new distributor never needs an enum migration. |
| `vendor_sku` | varchar(100) | Provider's SKU (synnexSku / pax8 vendorSku). Distinct from `sku`, which is the partner's mutable catalog SKU. UI renders `vendorSku ?? sku`. |
| `manufacturer` | varchar(255) | |

jsonb was rejected: an open container is forced into the `excludedOpen`
tenant-export bucket and is untyped on the web; plain columns classify as
`included` (matching all 25 existing `quote_lines` columns).

### Write path — server-side snapshot only

Snapshot happens in **`addCatalogLine`** (`quoteService.ts:939`), which
already loads the partner-owned catalog item. Add one **normalizer** that
reads the three `catalog_items.attributes` shapes
(`tdSynnexEcExpress.ts:552`, `tdSynnexDigitalBridge.ts:580`,
`pax8CatalogService.ts:165`) and returns
`{ procurementSource, vendorSku, manufacturer, mfgPartNo }`.
**Never trust client-supplied vendor fields on the catalog-add path** — the
web editor keeps passing only `{ catalogItemId, quantity, blockId }`.
Manual lines may set the fields via `quoteLineInputSchema` (they're the MSP's
own assertion there).

Also in this phase — three existing gaps this feature trips over:
- **Fix the dropped `part_number`**: `doAddCatalog` (`QuoteEditor.tsx:1283`)
  never passes it, so TD SYNNEX `mfgPartNo` never lands on quote lines. The
  normalizer supplies it server-side; delete the client-side `partNumber`
  plumbing from `catalogQuoteLineSchema` or leave it for manual overrides.
- **EC import contract gains `manufacturer` end-to-end** (EcProduct type,
  `ecProductSchema`, nightly adapter `nightlyProduct.ts:86` which currently
  buries it in `raw`, persisted `attributes.distributor`). Quorum verdict:
  not scope creep — required for the snapshot to be typed rather than
  scraped out of `raw`.
- **`cloneQuote` (`quoteService.ts:449`) enumerates columns explicitly** —
  add the three new columns or clones lose them.

**No backfill.** Historical accepted quotes keep null vendor fields; deriving
them from *today's* catalog state would fabricate an add-time snapshot.
Breakdown renders `—`.

### Registration checklist (Phase 1)

- Migration: idempotent `ADD COLUMN IF NOT EXISTS` ×3; no RLS change (existing
  shape-1 policies cover new columns).
- `CORE_TENANT_EXPORT_POLICY` → `quote_lines`: 3 new `included` entries
  (hard test failure until done).
- `quoteLineInputSchema` / `updateQuoteLineSchema` (manual-line path),
  web `QuoteLine` type, `toCustomerLines` (see Traps).
- `quote_sha256` (`quoteContentHash.ts:42`) maps content explicitly — vendor
  columns stay OUT of the hash (they're procurement metadata, not billable
  content; adding them would false-positive tamper checks on old quotes).

## Phase 2 — Order tracking: `quote_orders` + `quote_order_lines`

Header+lines, mirroring `pax8_orders`/`pax8_order_lines`. One real-world
distributor order covers many lines; partial shipments exist; a future
TD SYNNEX Digital Bridge integration (transactional API: orders/shipments/
returns) would sync onto the header. Flat rows grouped by `order_ref` were
rejected: `order_ref` is editable/nullable/non-unique — not a grouping key.

### `quote_orders` (header)

`id`, `org_id` (FK orgs), `quote_id` (FK quotes ON DELETE CASCADE),
`procurement_source` varchar(40), `vendor_name` varchar(255),
`order_ref` varchar(120), `ordered_by` (FK users **ON DELETE SET NULL** —
deleting a user must not destroy the business record),
`ordered_at`, `notes` text, `created_at`/`updated_at`.

### `quote_order_lines` (allocations)

`id`, `order_id` (FK quote_orders ON DELETE CASCADE), `org_id`,
`quote_id`, `quote_line_id` (FK quote_lines ON DELETE CASCADE),
`ordered_qty` numeric(12,2) NOT NULL, `received_qty` numeric(12,2) default 0,
`tracking_number` varchar(120), `eta` date, `received_at`, `cancelled_at`,
`notes` text, `created_at`.

### Semantics (quorum-refined)

- **No persisted `not_ordered` status.** Absence of an active allocation =
  not ordered. Status is DERIVED per quote line:
  `ordered` (allocations exist), `partially_received`
  (`0 < Σreceived < Σordered`), `received` (`Σreceived ≥ Σordered`),
  ignoring cancelled allocations.
- **Multiple allocations per quote line are allowed** (split orders, partial
  fulfilment, multiple tracking numbers). CHECK constraints:
  `ordered_qty > 0`, `received_qty >= 0`, `received_qty <= ordered_qty`.
- **Cancellation is a timestamp, not a delete** — history survives.
- Tracking lives on allocations for v1 (a `quote_order_shipments` model is
  future work if per-shipment tracking is ever needed).
- Create header + allocations **in one transaction** with an idempotency key
  (client-generated UUID) so a double-clicked "Mark ordered" can't duplicate.
- Mutating fulfilment state MUST NOT touch `quote_sha256` — add a regression
  test proving order/receive/cancel leaves the hash unchanged.

### Tenancy / integrity

- Shape-1 org RLS (`breeze_has_org_access(org_id)`), enabled + forced +
  policies **in the creating migration**. Direct `org_id` ⇒ auto-discovered
  by rls-coverage (no allowlist entry).
- Composite same-tenant constraints, following the Pax8 pattern
  (`pax8Orders.ts:47,93`): allocations must provably belong to the same
  org/quote as their header and their quote line (composite FKs
  `(quote_id, org_id)` / `(quote_line_id, quote_id)` or equivalent CHECK-by-FK
  constructions).
- **Cascade registration** (both tables): `CORE_ORG_CASCADE_DELETE_ORDER` —
  note `quote_lines` sorts alphabetically BEFORE `quote_order_lines`, so the
  child-before-parent property is satisfied by the **ON DELETE CASCADE
  declarations above**, not by list order; declare them explicitly and let the
  contract test verify. Plus `CORE_TENANT_EXPORT_POLICY` entries for every
  column: all `included` except `notes`/`tracking_number`/`order_ref` which
  are still `included` (plain business data, no credential material; none are
  jsonb). Org erasure deletes tracking/refs/notes with the rows — correct for
  GDPR.

### AuthZ / audit

- New **`quotes:fulfill`** permission (register + seed like the existing
  `QUOTES_*` set; add to `RESOURCE_LABELS`-adjacent action labels — the
  permissions-catalog test enforces label parity). `quotes:write` is
  documented as draft editing and stays draft-only; viewers with
  `quotes:read` see the breakdown + fulfilment state but can't mutate it.
- Audit every transition (created/received/cancelled) with IDs, status,
  counts — **never tracking numbers, order refs, or notes** in audit details.

### Read model / API

- `GET /quotes/:id` gains `orders: QuoteOrderWithLines[]` (MSP route only).
- `POST /quotes/:id/orders` (create header + allocations, `quotes:fulfill`),
  `PATCH /quotes/:id/orders/:orderId` (header fields),
  `PATCH /quotes/:id/orders/:orderId/lines/:lineId` (receive/cancel/tracking),
  all org-scoped through the standard request context — no system context
  needed anywhere in Phase 2.

### UI (Phase 2)

On the breakdown: per-line derived status chip (Ordered / Partial /
Received), row selection + **"Mark ordered"** action (one dialog: vendor
pre-filled from `procurement_source` grouping, order ref, optional tracking),
inline receive/cancel on allocation rows. Mutations via `runAction`.

## Phase 1.5 — Breakdown optimizations (ship with or right after Phase 1)

- **CSV download + Copy as TSV.** Reuse `lib/csvExport.ts` (formula-injection
  safe) + `downloadBlob` (`reportExport.ts:32`). Export respects the
  cost-visibility toggle: cost columns included only when currently shown.
  First CSV export in `components/billing` — keep it a small shared helper.
- **Pax8 cross-reference.** Extend the `getQuote` read model (currently id +
  count only, `quoteService.ts:489-503`) to return per-line
  `{ sourceQuoteLineId, submitState, quantity }` plus order status. Badge
  wording follows state — "Staged in Pax8" (`awaiting_details`), "Ordered via
  Pax8", "Pax8 failed" — never a blanket "fulfilled". Do NOT route the web
  through `GET /pax8/orders/:id` (requires `billing:manage` + partner scope —
  wrong gate for quote readers).
- **Group by vendor** (`procurement_source`, "Unknown" group last), preserving
  quote sort order within groups; suppress grouping when only one group.

## Phase 3 — Live cost-drift check (deferred, designed)

Button on the breakdown: re-query current cost/stock/ETA for the quote's
vendor SKUs and render drift vs the snapshotted `unit_cost`. Requirements
that make this its own phase:
- Partner-scope safe: org-scoped tokens intentionally carry no accessible
  partner context (`middleware/auth.ts:358`) — the endpoint must resolve the
  partner from the quote row under a system sub-context, never silently
  elevate.
- The EC Express SOAP call must not hold a DB transaction open — register the
  route in `selfManagedDbContextRoutes.ts` (the import routes are listed;
  lookup is not).
- Batching (EC P&A is exact-SKU only), per-line failure states, freshness
  labels (nightly rows ≥48h = stale), provider timeouts.
- Fallback order: EC Express live → nightly `td_synnex_price_availability`
  by `(partner_id, synnex_sku)` → none.

## Traps (verified file:line, must survive into implementation PRs)

1. **Customer leakage:** `toCustomerLines` (`quoteService.ts:27-35`) strips
   only `unitCost` via spread. New vendor columns + all fulfilment data are
   MSP-only. Replace the strip-spread with an **allowlist DTO** so future
   columns default to hidden on portal/public paths. (`sku`/`part_number`
   remain deliberately customer-visible.)
2. **Hash:** `quote_sha256` maps fields explicitly (`quoteContentHash.ts:42`)
   — keep vendor + fulfilment out; add the regression test.
3. **Clone:** copy vendor snapshot columns in `cloneQuote`; NEVER copy
   fulfilment rows (a cloned quote is a new proposal, not a new PO).
4. **Export-policy is the registration step that gets missed** (0/5 caught in
   review historically): 3 Phase-1 column entries + 2 Phase-2 table entries,
   mechanical, enforced only by the Integration Tests job — a stale-base PR
   can go green and red main. Dispatch CI per branch for stacked PRs.
5. **Pax8 `source_quote_line_id` has no index** (`pax8Orders.ts:83`) — the
   cross-reference query filters by order id (indexed), so no new index
   needed; don't join from the quote-line side.
6. **`getQuote` runs org-scoped** — everything Phase 1/1.5/2 reads must be
   org-axis. Only the Phase-3 drift check touches partner-axis data, hence
   its system-sub-context design.

## Explicitly out of scope

- Submitting orders to TD SYNNEX via Digital Bridge (transactional API is
  live-verified but order submission is its own program of work; the
  `quote_orders` header is designed to receive its sync).
- Per-shipment tracking model (`quote_order_shipments`).
- Backfilling vendor identity onto historical quote lines.
- Invoice-side procurement (invoice_lines has no sku/part_number at all).
