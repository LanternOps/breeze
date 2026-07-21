# Quote Deposits — Design

**Date:** 2026-07-05
**Status:** Approved design, pre-implementation
**Depends on:** Quotes/Proposals (phases 1–4, shipped), Invoice engine + partial payments (shipped), Stripe payments (shipped)

## Problem

MSPs quoting projects with significant hardware outlay don't want to front the capital. They need to collect a deposit at quote acceptance — either a percentage of the total or an amount covering specific lines (typically hardware) — then collect the remaining balance later, without breaking invoicing, payment collection, AR aging, or the future QuickBooks/Xero sync.

## Decisions (settled with Todd, 2026-07-05)

1. **Structure: one invoice, deposit-first.** Acceptance issues ONE full invoice (as today) carrying a "deposit due now" amount. The deposit is a partial payment against that invoice; it sits `partially_paid` until the balance is collected. No second invoice, no prepayment/credit subsystem.
2. **Hardware identification: per-line toggle.** A `deposit_eligible` flag on quote lines; deposit = sum of flagged lines. Catalog category pre-checks the box; techs can override any line, including manual lines. Plus: totals broken out by catalog category, shown in the editor, portal, and PDF.
3. **Accept gate: accept, then pay.** Acceptance (signature → converted → invoice issued) is not gated on payment. The customer lands on a Stripe Checkout for the deposit amount after accepting; an abandoned checkout leaves the deposit owed and chaseable.
4. **Balance: terms + editable due date.** Balance due date defaults from partner payment terms; a new carve-out lets techs edit the due date on issued deposit invoices (scheduling metadata, not signed financial content). A "Request balance payment" action emails a pay link for the remainder.

## Schema changes

### `quotes` (`apps/api/src/db/schema/quotes.ts`)

| Column | Type | Notes |
|---|---|---|
| `deposit_type` | new enum `quote_deposit_type`: `none \| percent \| selected_lines` | default `none` |
| `deposit_percent` | numeric(8,5), nullable | required iff `deposit_type = 'percent'`; 0 < x < 100 |
| `deposit_amount` | numeric(12,2), nullable | stored snapshot of computed deposit due; recomputed on every quote edit like the other total columns |

### `quote_lines`

| Column | Type | Notes |
|---|---|---|
| `deposit_eligible` | boolean, default false | the per-line "include in deposit" toggle; only consulted when `deposit_type = 'selected_lines'` |

### `invoices` (`apps/api/src/db/schema/invoices.ts`)

| Column | Type | Notes |
|---|---|---|
| `deposit_due` | numeric(12,2), nullable | snapshot of the quote's deposit amount at acceptance. `NULL` = ordinary invoice; zero behavior change for all existing invoices |

Migration: one idempotent SQL file per the standard workflow (`ADD COLUMN IF NOT EXISTS`, enum via `DO $$ ... EXCEPTION`). All three tables already carry RLS; no new tables, no allowlist changes.

## Deposit math (shared)

Lives in `computeQuoteTotals` (`packages/shared/src/utils/quoteMath.ts`) so API, web editor, portal, and PDF agree. Returns two new results:

- **`depositDueTotal`**
  - `percent`: `deposit_percent × oneTimeInvoiceTotal` (subtotal + tax of one-time, customer-visible lines). Recurring lines are excluded — they become contracts, not the invoice.
  - `selected_lines`: sum of flagged one-time line totals + tax on flagged taxable lines at the quote tax rate.
  - Rounded to cents; all comparisons in integer cents (match existing `invoiceMath` conventions).
- **`categoryBreakdown`**: per-category subtotals grouping customer-visible lines by their catalog item's category; manual/uncategorized lines under "Other". Broken out one-time vs recurring where relevant.

**Validation** (in `packages/shared/src/validators/quotes.ts` + service layer):

- Deposit types other than `none` require ≥ 1 one-time customer-visible line (recurring-only and $0 quotes rejected with a clear message).
- Deposit must be > 0 and strictly < the one-time invoice total. 100% / all-lines-flagged is "no deposit" — rejected, tell the user to use `none`.
- `deposit_percent` present iff type is `percent`; `selected_lines` requires ≥ 1 flagged line.

**Catalog defaulting:** when a catalog item is added to a quote, `deposit_eligible` defaults on iff the item's category matches the hardware-ish set (category name match on `hardware`, case-insensitive; keep the rule dumb and overridable rather than clever).

## Acceptance flow

`acceptQuote` (`apps/api/src/services/quoteAcceptService.ts`) — unchanged pipeline, three additions:

1. The issued invoice gets `deposit_due = quote.deposit_amount` (null when `deposit_type = 'none'`).
2. Deposit fields (`deposit_type`, `deposit_percent`, `deposit_amount`, per-line `deposit_eligible`) are included in the quote content hash (`quoteContentHash.ts`), so the e-signature record covers the deposit terms the customer saw.
3. The post-accept pay link charges per the pay-amount rule below (deposit first), not the full balance.

## Pay-amount rule

One rule covers every state, implemented in `createInvoicePayLink` (`invoiceCheckout.ts`) and the portal pay route (`routes/portal/invoices.ts`):

```
chargeNow = (deposit_due != null && amount_paid < deposit_due)
          ? deposit_due − amount_paid
          : balance
```

- Deposit unpaid/partially paid → charge the deposit remainder.
- Deposit satisfied → charge the full remaining balance (existing behavior).
- Stripe Checkout `unit_amount = toMinorUnits(chargeNow)`; the idempotency key gains the charge amount (`inv_${id}_${chargeNowMinor}`), and the line description says "Deposit — Invoice INV-xxx" vs "Invoice INV-xxx".
- Manual payments (`recordPayment` — cash/check/transfer) are untouched: any amount up to balance, existing overpayment guard, existing status math (`partially_paid` etc.) already does the right thing.
- Settlement/webhook paths (`stripeSettle.ts`, `stripeReconcile.ts`) are amount-agnostic already (they record what Stripe settled); no changes beyond the pending-mapping amount.

## Balance collection

- **Due date**: set from partner terms at issue, as today.
- **Due-date edit carve-out**: `PATCH /invoices/:id/due-date` allowed on issued invoices with `status ∈ {sent, partially_paid, overdue}`. Due date is scheduling metadata, not signed financial content, so this does not violate the issued-documents-are-immutable rule. The change is audit-logged (old → new). Editing a due date on an `overdue` invoice re-derives status (may return to `partially_paid`/`sent`). Web UI: inline edit on invoice detail.
- **Request balance payment**: `POST /invoices/:id/request-payment` — emails the customer the invoice PDF + a pay link for the current `chargeNow` amount. Reuses the existing invoice email + pay-link plumbing. Available whenever the invoice is payable with balance > 0 (works for chasing an unpaid deposit too).
- Overdue sweep and dunning: unchanged, keyed off due date.

## Visibility

- **Quote PDF** (`quotePdf.ts` summary footer) and **portal quote view**: when a deposit is set, the bold emphasized figure becomes **"Deposit due on acceptance: $X"**, with "Remaining balance: $Y due per terms" beneath it (replacing the plain due-on-acceptance figure); the recurring summary (monthly/annual) is unchanged. Add the per-category subtotal breakdown to the summary.
- **Quote editor** (web): deposit controls in the totals sidebar (type selector, percent input or per-line checkboxes), live deposit figure, category breakdown.
- **Invoice detail + portal invoice view**: "Deposit $X of $T paid · balance $B" strip; Pay button charges per the rule.
- **MSP quotes/invoices lists**: `Deposit unpaid` / `Deposit paid` badge derived from `deposit_due` vs `amount_paid` (no new status enum values).
- **MCP/AI tools**: `manage_quotes` gains the deposit fields on create/update and in reads; invoice read tools expose `deposit_due` and the derived deposit-paid state.

## Accounting (future-proofing only)

QuickBooks/Xero invoice push is unimplemented (Phase B/C stubs), so nothing is wired now. The single-invoice model was chosen so the future mapping is trivial: one Invoice object + N Payment objects — no deposit-specific QB entities. **Out of scope:** liability accounting for deposits (prepayment → revenue on delivery/completion). In this design a deposit is simply the first payment against an issued invoice; partners needing true deferred-revenue treatment handle it in their accounting package.

## Edge cases

- **Recurring-only / $0 one-time quote**: deposit types rejected at validation (see math section).
- **Abandoned Stripe checkout after accept**: invoice stands issued with deposit unpaid; badge shows it; chaseable via Request payment. This is by design (accept-then-pay decision).
- **Manual deposit payment** (check/transfer): recorded via existing `recordPayment`; once `amount_paid ≥ deposit_due` the pay link naturally switches to charging the balance.
- **Void + reissue**: `deposit_due` does not auto-copy to the replacement invoice — the reissue starts clean and the tech sets terms; payments stay with the void chain per existing behavior.
- **Quote edits after send**: impossible today (issue-once), so no drift between signed deposit terms and the invoiced deposit.
- **Overpayment of deposit via Stripe**: impossible — Checkout charges exactly `chargeNow`; concurrent manual payment + Stripe settle can exceed `deposit_due` but never `total` (existing guard), and status math handles it.

## Testing

Per the breeze-testing checklist:

- **Shared**: `quoteMath` unit tests — percent/selected-lines deposit math, tax handling, rounding, category breakdown, all validation rejections.
- **API**: `quoteAcceptService` tests — `deposit_due` snapshot, content-hash inclusion, pay-link amount; `invoiceCheckout`/portal-pay tests for the pay-amount rule across states (deposit unpaid / partly / satisfied / no deposit); due-date PATCH guards + audit; request-payment route.
- **Web/portal**: editor deposit controls, portal deposit strip + accept flow rendering.
- **Integration**: one accept-to-paid happy path against real Postgres (accept → deposit Stripe settle → `partially_paid` → balance payment → `paid`).

## Out of scope (candidates for later)

- Fixed-dollar deposit amounts (trivial enum addition once wanted).
- Partner-level default deposit percent (billing settings).
- Payment plans / installments beyond deposit + balance.
- Prepayment/liability accounting; deposit handling in the (future) QB/Xero push.
