# Quotes / Proposals — Phase 3 Implementation Plan

**Status:** Planned (not started). **Blocked on:** Phase 2 (#1468) merging — Phase 3
builds directly on its accept→convert flow and the `convertedInvoiceId` link.

## Context

Phase 1 (#1455) shipped the quotes data model + editor; Phase 2 (#1468, tracking
#1465) makes a sent quote acceptable end-to-end and converts the accepted quote's
**one-time** lines into a draft invoice. Two gaps remain from the original design
(`docs/superpowers/specs/billing/2026-06-16-quotes-proposals-design.md`) that Phase 2
explicitly deferred:

1. **Payment after acceptance** — once a quote is accepted and converted to an
   invoice, the customer has no way to pay it from the portal or a public link.
2. **Expiry** — a quote has an `expiry_date` but nothing ever transitions it to
   `expired`; an out-of-date quote can still be viewed and accepted.

Phase 3 closes both. It is **mostly orchestration over existing primitives** — the
Stripe Payments work (#1422) already built hosted-checkout + webhook settlement
for invoices, and the quotes schema already carries the `expired` enum value, the
`expiry_date` column, and an expiry-tuned partial index.

## Scope (IN)

- **Accept → pay.**
  - **Portal pay** (authed): on a converted quote / its invoice, a "Pay now" action
    that mints a Stripe hosted-checkout URL and redirects.
  - **Public pay-link** (unauthenticated): the public quote page (`/portal/quote/<token>`)
    offers payment after acceptance, via a tokized redirect to checkout — for
    prospects without a portal account.
  - Settlement is **webhook-driven** (reuse the existing `checkout.session.completed`
    handler) — never trust the client redirect for marking paid.
- **Expiry.**
  - **Sweep job** (BullMQ, scheduled): flips `status` `sent`/`viewed` → `expired`
    where `expiry_date < today`. The partial index `quotes_expiry_idx`
    (`apps/api/src/db/schema/quotes.ts:58`, `WHERE status IN ('sent','viewed')`)
    already supports this query.
  - **Read-time expiry guard**: when a quote past its `expiry_date` is loaded
    (portal/public/API), treat it as expired and **block accept/decline/pay** even
    if the sweep hasn't run yet (defense against the gap between expiry and the next
    sweep tick).
  - **`expired` transition** wired into the lifecycle state machine (terminal for
    accept; an MSP may re-issue by cloning — not in scope here).

## Out of scope (Phase 4+)

- **Recurring lines → Contract** (the monthly/annual lines Phase 2's convert
  intentionally skips) — Phase 4, per the design doc.
- Partial payments / payment plans / dunning on quote-derived invoices.
- Re-issue / clone-expired-quote UX.

## Schema

Likely **no migration needed** — `expired` is already in `quote_status`
(`apps/api/src/db/schema/quotes.ts:11-12`), `expiry_date` exists, and the converted
invoice is reachable via `quotes.converted_invoice_id`. Confirm during
implementation; if a payment-state column on the quote is wanted (vs. reading the
invoice's status), add it in one idempotent migration with the existing RLS shape
(quotes is partner+org dual-axis — match the Phase 1 policies; no new table).

## Reuse (do NOT rebuild)

- `createInvoicePayLink(invoiceId, actor)` — `apps/api/src/services/invoiceCheckout.ts:27`
  — already creates the Stripe hosted-checkout session for an invoice and persists
  the Stripe object ref. The quote pay action resolves `convertedInvoiceId` and
  calls this.
- `stripeWebhook.ts` settlement path (#1422) — already marks the invoice paid on
  `checkout.session.completed`. Confirm it fires regardless of whether checkout was
  initiated from the MSP UI, the portal, or the public link.
- `stripeConnectService.ts` / `stripeMoney.ts` — Connect account resolution + penny
  math; reuse, do not duplicate.
- Phase 2's public-token plumbing (`quote-accept` JWT, `withSystemDbAccessContext`
  public path) — the pay-link path is the same shape; extend it, don't fork it.
- BullMQ queue setup — model the sweep on an existing scheduled job; honor the
  **jobId colon rule** (0 or exactly 2 colons; use `-` separators — see
  `[[bullmq_jobid_colon_rule]]`).

## Traps to honor (from prior phases)

- **Public paths write via `withSystemDbAccessContext`** — the public pay-link
  records (e.g. payment intent ref) run pre-/cross-auth and will silently write 0
  rows under `breeze_app` RLS otherwise (the `rls_silent_zero_row_write` class).
- **Caddy carve-out** — any new public route under `/api/v1/quotes/public/*` is
  already covered by the `/api/*` block; the portal page is under `/portal/*` (shipped in
  the portal-deploy PR #1474). Verify no new top-level path needs a carve-out.
- **At-most-once settlement / no double-charge** — guard the pay action so an
  already-paid (or non-converted) quote can't mint a fresh checkout; mirror Phase 2's
  `SELECT … FOR UPDATE` at-most-once convert pattern.
- **Webhook handler must not throw → 500 → infinite Stripe retry** — the Stripe
  Payments trap (#1422): return 2xx and log on unrecoverable webhook errors.
- **Real-DB tests** in `src/__tests__/integration/*.integration.test.ts` (BLOCKING
  integration-test job): expiry sweep flips only `sent`/`viewed`, read-time guard
  blocks accept on an expired quote, pay-link rejects unconverted/expired quotes,
  webhook settles the converted invoice. Penny math via invoiceMath; web mutations
  via `runAction`.
- **Expiry is date-only** (`expiry_date` is a `date`): decide tz handling (compare
  against the org/partner's day boundary, not UTC midnight) and test the boundary.

## Final verification

- Expiry sweep: seed a `sent` quote with `expiry_date` = yesterday → after the job,
  status = `expired`; a `draft`/`accepted`/`converted` quote is untouched.
- Read-time guard: an expired quote returns expired state and rejects accept/pay
  with a clear error, even before the sweep runs.
- Pay (portal + public): accept → convert → pay returns a Stripe checkout URL;
  simulated `checkout.session.completed` webhook marks the converted invoice paid;
  re-initiating pay on a paid quote is rejected.
- No regression to Phase 2 accept/convert or the portal `/portal` routing.

## Deferred to later plans

- **Phase 4:** recurring lines → auto-create Contract.
