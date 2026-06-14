# Billing & Invoicing Architecture Overview

**Status:** Design accepted 2026-06-14. Cross-cutting frame for a multi-spec build.

This document is the shared architectural contract for the Breeze billing/invoicing
program. It is intentionally thin: it fixes the cross-cutting conventions **once** so
the four sub-projects below interlock cleanly even though each is specced, planned, and
shipped independently. Individual sub-project specs own their own detail.

## Why this exists

When the ticketing v1 roadmap landed (`2026-06-09-native-ticketing-design.md`), §8a
("Extensibility Guarantees") promised that `time_entries` and `ticket_parts` carry the
billing surface (`billing_status`, rates, `cost_basis`) needed for a future invoicing
module, that a product catalog would attach via a nullable `catalog_item_id`, and that
accounting/distributor integrations would follow the PSA connection+mapping pattern.
This program delivers on those promises. This overview keeps the four pieces consistent
with each other and with those guarantees.

## Sub-projects and dependency order

```
1. Product Catalog        catalog_items (hardware|software|service), bundles,
   (foundation)           SKU, pricing, cost basis, tax category, billing_type.
                          Referenced (optionally) by everything below.
        │
        ▼
2. Invoice Engine         invoices / invoice_lines. Lines sourced from time_entries,
   (the core)             ticket_parts, catalog items, bundles, or manual. Tax,
                          numbering, draft→sent→paid lifecycle, PDF, email,
                          portal view, manual payment recording. Org-run +
                          per-ticket assembly.
        │           │
        ▼           ▼
3. Recurring        4. Stripe Payments
   Contracts           Stripe Connect: MSP connected accounts, pay-invoice-in-portal,
   (flat +             webhook → payment record → invoice status reconcile.
   auto-quantity       Builds on #2's invoice + payment model.
   per-device/seat,
   snapshot, cadence)
   → generates invoices via #2

(later, separate spec — deferred): QB/Xero accounting sync
```

Each box is its own **spec → plan → build** cycle. Build bottom-up: catalog first
(it de-risks the rest), then the invoice engine, then contracts and Stripe (which both
build on the engine).

## Cross-cutting conventions (decided once, here)

### Money & currency
- All monetary amounts are `numeric(12,2)`.
- Currency is a **single partner-level default** (`partner` settings), not per-row. A
  per-row `currency` column can be added later without backfill pain (default from
  partner). No multi-currency in this program.

### Catalog as the canonical price source
- `catalog_items` is the canonical source of sellable things.
- Invoice lines, contract lines, and ticket parts all carry a **nullable**
  `catalog_item_id`. Referencing the catalog is always optional; free-text works
  everywhere, forever.
- A single resolver, `catalogService.resolvePrice(catalogItemId, orgId)`, returns
  `{ unitPrice, costBasis, taxable, taxCategory, source }` applying org price overrides.
  Invoice and contract line generation call this one function — pricing logic is never
  duplicated.

### Invoice line shape (owned by the Invoice Engine spec, fixed here so bundles work)
Invoice lines must support bundles with controlled customer visibility from day one:
- `source_type` enum: `time_entry | part | catalog | bundle | manual | contract`.
- `source_id` nullable (FK-by-convention to the originating row).
- **Snapshot** `description`, `quantity`, `unit_price`, `cost_basis`, `taxable` at
  generation time — later catalog/contract edits never mutate an issued invoice.
- `customer_visible boolean` — controls whether the line renders on the customer PDF /
  portal. Hidden lines still exist for accounting and external sync.
- `parent_line_id` self-FK — a bundle expands into a parent line (headline price,
  customer-visible) plus child component lines (visible or hidden per the bundle's
  component config).

**Two views of every invoice:** the *customer view* (PDF + portal) filters to
`customer_visible = true`; the *accounting view* (internal UI + QB/Xero/Stripe sync)
sees all lines, giving full revenue/COGS breakdown even for hidden bundle components.

### Tax
- Catalog items carry a `taxable` flag + optional `tax_category` text (maps to an
  external tax code later).
- Tax rate definitions live at partner/org level (Invoice Engine spec). Tax is computed
  as `sum(taxable line amounts) × rate`, shown as a tax line. Per-line taxable flag is
  honored.

### External-system integration (QB/Xero, Stripe, distributors)
- Always via dedicated **connection** tables + external-ref **mapping** tables — the
  existing `psaConnections` / `psaTicketMappings` pattern (`schema/integrations.ts`).
- **Never** add external-ref columns to core tables (`invoices`, `catalog_items`, …).
- Credentials/tokens stored encrypted (`secretCrypto`) in a jsonb `credentials` column,
  decrypted via `decryptForColumn(...)`. OAuth refresh tokens follow the existing
  `schema/oauth.ts` infrastructure where applicable.

### Service-layer-first (AI/MCP-safe)
- All logic lives in services: `catalogService.ts`, then `invoiceService.ts`,
  `contractService.ts`. REST routes, AI tools, the MCP server, and future workflow
  actions are equal, thin consumers. No business logic in Hono handlers.
- Every state change emits a lifecycle event through the single existing dispatch point
  (BullMQ + event log), so future workflows/integrations subscribe without touching
  billing code. New event families: `catalog.*`, `invoice.*`, `contract.*`,
  `payment.*`.

### Tenancy / RLS
- New tenant-scoped tables get RLS enabled + forced + policies **in the same migration
  that creates them**, added to the `rls-coverage` allowlist in the same PR, and —
  where a table has more than one tenancy axis or an override relationship — covered by
  a functional `breeze_app` cross-tenant forge test (the dual-axis contract-test
  blindspot lesson; see `memory`).
- Shapes used in this program: partner-axis (shape 3) for partner-owned master data
  (`catalog_items`, `catalog_bundle_components`, contracts); direct `org_id` (shape 1)
  for org-scoped rows (`catalog_item_org_pricing`, `invoices`).

## Guarantees this program must not break
- Free-text parts/lines remain usable forever; catalog referencing is always optional.
- Issued invoices are immutable snapshots; upstream edits never rewrite history.
- No external-ref columns on core tables — mapping tables only.
- Adding QB/Xero/distributor sync later requires **zero** changes to catalog/invoice
  core schema.

## Specs in this program
- `2026-06-14-product-catalog-design.md` — sub-project 1 (this batch).
- Invoice Engine — to be specced next.
- Recurring Contracts — to be specced after the engine.
- Stripe Payments — to be specced after the engine.
- QB/Xero accounting sync — deferred, separate spec.
