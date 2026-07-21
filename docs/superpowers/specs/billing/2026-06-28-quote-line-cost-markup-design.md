# Quote builder — per-line cost, markup%, and net profit

**Status:** Approved design (2026-06-28)
**Surface:** Quote builder (`QuoteEditor`) only. Internal-facing. Never customer-facing.

## Problem

A builder pricing a quote can't see the economics of what they're building. The pricing table shows description / qty / unit / tax / total, but not **cost**, **markup%**, or **net profit** — per line or in aggregate. There's also no SKU / part number on a line for lookup and comparison. Today a `quote_line` stores no cost and no identifiers; it only links to a catalog item via `catalogItemId`, and manual lines have neither.

## Goals

- Per line, the builder sees **cost**, an editable **markup%**, **net profit**, **SKU**, and **part #**.
- Markup% is a pricing tool: typing a target markup sets the unit price.
- The rail shows **net profit** in aggregate (by cadence).
- None of this ever reaches the customer (document, PDF, portal payload).

## Non-goals (explicitly deferred)

- A manufacturer-part-number field on `catalog_items` (catalog has `sku` only today; part# lives on the line for now).
- Margin display on `QuoteDetail` (internal summary) — possible follow-up; this spec touches the editor only.
- A separate "view margin" permission — margin shows to anyone who can view the editor.
- Showing SKU/part# on the customer-facing document — separate later choice.

## Decisions (locked)

1. **Snapshot on the line.** Cost and identifiers are stored on `quote_lines`, seeded at add-time, editable thereafter. Not derived live from the catalog (catalog edits don't retro-change a quote's economics).
2. **Markup%, editable, drives price.** Cost is the fixed base; `markup% = (price − cost) / cost`. Editing markup% recomputes unit price; editing price or cost re-derives the markup% readout.
3. **Internal strip under each line.** A compact, visually-distinct band beneath each pricing row: `SKU · PN · cost · markup% · net`. Not extra columns; not a separate view mode.
4. **Snapshot SKU + editable Part#.** SKU snapshots from the catalog item; part# is editable on the line and auto-fills from a distributor import's mfg part# when present.
5. **Net excludes tax.** Tax is pass-through, not profit.

## 1. Data model

New nullable columns on `quote_lines`:

| Column | Type | Meaning |
|---|---|---|
| `unit_cost` | `numeric(12,2)` null | Per-unit cost snapshot. `null` = unknown (manual line, no cost entered). |
| `sku` | `varchar(100)` null | SKU snapshot from the catalog item at add-time. |
| `part_number` | `varchar(100)` null | Manufacturer part #; editable; auto-filled from distributor mfg part# when available. |

Snapshot rules:
- **Catalog add** (`addCatalogLine`): server copies `catalog_items.cost_basis → unit_cost` and `catalog_items.sku → sku`. `part_number` stays null (catalog has no PN field).
- **Distributor import → add**: the import path already creates/finds a catalog item; capture the distributor `mfgPartNo` into the line's `part_number` when available.
- **Manual add** (`addManualLine`): optional `unitCost`, `sku`, `partNumber` from the form.
- **Edit** (`updateLine`): all three editable; plus `unitPrice` (driven by markup).

`null` cost is a first-class state: such a line contributes revenue but is **excluded from net** and flagged.

## 2. Shared math (`packages/shared/src/utils/quoteMath.ts`)

Pure helpers, cent-accurate via the existing `toCents`/`fromCents`/round-half-up utilities:

- `markupPct(price, cost): number | null` — `(price − cost) / cost · 100`; `null` when cost is `0`/absent.
- `priceFromMarkup(cost, markupPct): string` — `cost · (1 + markup/100)`, cent-rounded.
- `computeQuoteProfit(lines): QuoteProfit` — net = revenue − cost, **excluding tax**, over **billed (`customerVisible`) lines only** (mirroring `computeQuoteTotals`' subtotal handling), split by cadence:
  ```
  { oneTimeNet, monthlyRecurringNet, annualRecurringNet, totalCost,
    linesMissingCost: number }
  ```
  Lines with `unit_cost == null` are excluded from cost/net and counted in `linesMissingCost` so the UI can flag an incomplete figure.

`QuoteLineForMath` gains an optional `unitCost` field so the rail's optimistic recompute (already in the editor) can preview net while editing.

## 3. API + validators

- `packages/shared/src/validators/quotes.ts`:
  - Manual-add line schema: add optional `unitCost` (≥ 0), `sku` (≤ 100), `partNumber` (≤ 100).
  - Update-line schema: add the same three as optional.
- Service (`quoteService`): snapshot cost/sku on catalog add; persist cost/sku/part# on manual add; allow updates. Recompute on `updateLine` is unaffected (cost doesn't enter quote totals — only the new profit calc, which is presentational).
- **Serialization guardrail:** the public/portal + accept-flow quote payloads must NOT include `unit_cost` (and markup/net are never persisted, only derived). Add/confirm an explicit field selection or omit so internal cost never leaks to the customer surface.

## 4. Editor UI (`QuoteEditor.tsx`)

**Per-line internal strip** under each `EditableLineRow` (and the read-only row), shown to anyone viewing the editor:
- Visually distinct: muted/tinted band with a small "internal" tag, so it's unmistakably not on the proposal.
- Fields (editable when `canWrite`, else read-only text): `SKU`, `PN`, `Cost`, `Markup%`; `Net` is computed read-only.
- Interaction: markup% → sets unit price; price/cost edits → re-derive markup readout. Net = `(unitPrice − unitCost) · qty`, "—" when cost is null.
- Reuses the existing optimistic blur-save, amber dirty-ring, and "Unsaved/Saved" cue patterns. Markup% and cost participate in the existing per-line draft → rail recompute.
- **Manual-add form:** add `Cost`, `SKU`, `Part#` inputs.

**Rail (live totals card), `canWrite` only:** an internal "Margin" section — total cost and **net profit**, split one-time / monthly / annual to match the revenue lines, with a subtle note when `linesMissingCost > 0`. Clearly labeled internal.

## 5. Guardrails

- `QuoteDocument` (customer view + PDF) and `QuoteDetail` (internal summary) unchanged by this spec; cost/markup/net appear only in the editor.
- Test that the portal/accept serialization omits `unit_cost`.

## 6. Migration & sequencing

- New idempotent migration adding the three columns to `quote_lines`, dated to sort **after** the in-flight `2026-07-03-quote-invoice-line-name.sql` (e.g. `2026-07-04-quote-line-cost-identifiers.sql`).
- `quote_lines` already has RLS policies; adding columns needs no new policy.
- This change shares files (`quoteTypes.ts`, `QuoteEditor.tsx`, schema, validators) with the in-flight line-name feature. **Land it after that feature settles** (or in a dedicated worktree rebased on it) to avoid clobbering.

## 7. Testing

- **shared/quoteMath:** `markupPct`, `priceFromMarkup`, `computeQuoteProfit` (table-driven; cadence split, tax-excluded, customerVisible filter, null-cost handling).
- **validators:** cost ≥ 0; optional sku/partNumber length bounds.
- **API:** catalog-add snapshots cost+sku; distributor-add captures part#; manual-add accepts cost/sku/part#; update edits them; **portal/accept payload excludes `unit_cost`**.
- **web (QuoteEditor):** strip renders; markup% drives price; price/cost edits update markup readout; net computes (and "—" on null cost); rail net by cadence + missing-cost note; manual-add cost/sku/part# inputs.
