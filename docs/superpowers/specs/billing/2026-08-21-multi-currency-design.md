---
tracking_issue: LanternOps/breeze#3772
---

# Multi-Currency — Design Spec

- **Date:** 2026-08-21
- **Status:** Approved (design quorum: Fable + Codex gpt-5.6 xhigh, in agreement; owner approved product decisions and consolidated design)
- **Scope:** MSP→customer money across billing, quotes, contracts, ticketing, catalog, portal, reporting, Stripe, and the accounting seam.
- **Supersedes:** the "No multi-currency in this program" framing in `2026-06-14-billing-architecture-overview.md` §Currency and the multi-currency deferral in `2026-06-23-quickbooks-accounting-integration-design.md`.

## 1. Product decisions (owner-fixed)

1. **Currency attaches per-organization.** Each customer org has a currency; the partner has a default. One MSP can bill different customers in different currencies.
2. **No auto-conversion on billing documents, ever.** Prices are entered in the document's currency. A daily reference-rate feed converts amounts **only** for dashboards/reporting, always marked approximate.
3. **Per-currency price books.** A catalog item carries an explicit price per currency. Selling into a currency with no price is an explicit gap (manual price required), never a silent conversion.
4. **MSP→customer money only.** Breeze's own SaaS subscription pricing (breeze-billing sidecar) is out of scope and decoupled.
5. **VAT/jurisdiction tax modeling is out of scope.** The existing scalar tax-rate chain (partner → org → document snapshot) stays; proper VAT is its own future initiative.
6. **Ticket rate defaults are match-or-skip.** A partner-level category default rate applies only when the org's currency matches the currency the default was entered under; otherwise the org (or the entry) must carry an explicit rate.

## 2. Central invariant

> Every stored monetary amount has an explicit currency context, and every document line resolves against the **document header currency** — never against the org's *current* currency at read time.

Org and partner currencies are **defaults applied at creation**. After creation, snapshots rule. Nothing reinterprets a stored number by re-reading a mutable setting.

Corollaries:

- Document currency (quote/invoice/contract) is stamped at creation and becomes **immutable once the document has its first monetary line**. Changing it afterwards is an explicit atomic clear-and-reprice operation, not a field edit.
- Time entries and parts snapshot their currency at creation; org currency changes never rewrite history.
- Once all constructors stamp currency explicitly, the static `DEFAULT 'USD'` on document currency columns is **removed** — a missing stamp fails loudly rather than minting another USD document.

## 3. Current state (survey, 2026-08-21)

What already exists (do not rebuild):

- `partners.currency_code char(3) NOT NULL DEFAULT 'USD'` (`apps/api/src/db/schema/orgs.ts:69`) — the current single source of truth. Editable in `PartnerBillingSettings.tsx` and the onboarding `RegionalSetupStep.tsx`, sourced from the curated 34-code list in `apps/web/src/lib/currencies.ts`.
- `invoices.currency_code`, `quotes.currency_code`, `contracts.currency_code` (`char(3) DEFAULT 'USD'`); `invoice_stripe_payments.currency`. Lines/payments inherit the header.
- `stripeMoney.ts` — correct zero-decimal minor-unit conversion at the Stripe boundary (regression-tested against the JPY 100x overcharge).
- Web billing UI is currency-aware: `billing/shared/format.formatMoney` + `sumByCurrency` (honest mixed-currency totals, used by invoice/quote/contract lists).
- Quote flows mostly propagate currency correctly: quote→invoice (`quoteAcceptService.ts:171-177`), quote→contract (`quoteToContract.ts:99`), content-hash includes currency (`quoteContentHash.ts:50`).
- Checkout passes invoice currency into Stripe (`invoiceCheckout.ts`, `routes/portal/invoices.ts`); `stripeReconcile.ts` terminal-fails on event-vs-invoice currency mismatch.

Shipped bugs and gaps this program fixes:

| # | Defect | Where |
|---|---|---|
| B1 | Draft invoices never set currency (DB default USD wins); `issueInvoice` then **overwrites** with partner currency | `invoiceService.ts:65,598,614,837`; `:684` |
| B2 | Contract→invoice generation drops the contract's currency (EUR contract → USD invoice) | `contractService.ts:319-370` + `jobs/contractWorker.ts:86` |
| B3 | Quotes inherit **partner** currency, not org; quote catalog lines read `catalog_items.unit_price` directly, bypassing even the org-override resolver | `quoteService.ts:318-329`, `:1084` |
| B4 | Catalog has no currency; TD SYNNEX CAD costs (region=CA) land as bare numbers, real currency demoted to advisory jsonb; Pax8 buy rates same | `catalog.ts:30-32`, `tdSynnexPriceFile.ts:272`, `tdSynnexEcExpress.ts:552`, `pax8CatalogService.ts:153` |
| B5 | Ticketing rates all currency-less | `timeTracking.ts:33,56`, `tickets.ts:27`, `ticketConfig.ts:43` |
| B6 | Document math rounds to hundredths regardless of currency → `1000.50 JPY` possible; Stripe rounds, Breeze doesn't → settlement discrepancy | `invoiceMath.ts:18`, `catalogPricing.ts:4-10`, `depositMath.ts` |
| B7 | Server-rendered money is `en-US`/`$`-only (3 hand-rolled API formatters, 4 portal copies); 4 web files use the USD-hardcoded `lib/timeFormat.formatMoney` | `invoicePdf.ts:47`, `quotePdf.ts:32`, `quoteLifecycle.ts:32`, `apps/portal/.../quoteBlocks.tsx:11` et al. |
| B8 | `accounting_connections.home_currency` is a dead column; the spec'd "block on mismatch" QBO guard was never built; provider interface is untyped varargs | `accounting/types.ts`, `quickbooksProvider.ts:158` |
| B9 | Currency validation is `z.string().length(3)` + `char(3)` — accepts `'usd'`, `'ZZZ'`; curated list is web-only | `packages/shared/src/validators/*` |
| B10 | Pre-existing concurrency holes in the exact transactions currency guards must live in: `issueInvoice` doesn't lock/revalidate (source "lock" at `invoiceService.ts:647` selects only already-billed rows — two issuers can both pass); manual payment has a check-then-insert overpay race (`:735`) | `invoiceService.ts` |

## 4. Shared currency module

New module in `packages/shared` (`src/utils/currency.ts` + `src/validators/currency.ts`), the single authority for:

- `SUPPORTED_CURRENCIES` — the curated ISO-4217 list promoted from `apps/web/src/lib/currencies.ts`. **Three-decimal currencies (BHD, KWD, OMR, JOD, TND) are excluded**; a unit test asserts none are present.
- `minorUnitExponent(code)` — 0 for the zero-decimal set (JPY, KRW, CLP, …), else 2.
- `toMinorUnits(value, code)` / `fromMinorUnits(minor, code)` — `apps/api/src/services/stripeMoney.ts` becomes a thin re-export/consumer.
- `roundToCurrency(value, code)` — **half-up to the currency's exponent**; the documented rounding mode for all persisted amounts.
- `formatMoney(value, code, locale)` — `Intl.NumberFormat` `style:'currency'` with a graceful `"1,234.50 XYZ"` fallback for unknown codes.
- `currencyCodeSchema` — Zod: trim → uppercase → refine against `SUPPORTED_CURRENCIES`. Replaces every `z.string().length(3)` currency field (invoices, quotes, contracts validators).

**Database enforcement:** a global `supported_currencies(code char(3) PRIMARY KEY)` reference table, seeded idempotently from the shared list by migration, with FKs from every currency column added by this program (and added to existing document currency columns in wave 1). Rationale over a CHECK: adding a currency is an INSERT migration, not a constraint rebuild. A contract test asserts the table's contents equal the shared list. System jobs, AI tools, and partner-API callers bypass Zod, so the DB must be the backstop.

**Rounding (wave 1, not a polish item):** every persisted/finalized monetary result — line totals, tax, deposits, quote totals, invoice totals, payment amounts — passes through `roundToCurrency` for the document currency. Internal 2-decimal accumulators may remain mid-computation, but persisted amounts must be representable in the currency's minor unit (validated at write). JPY/CLP amounts are stored with `.00` (storage stays `numeric` major units) and display as `¥1,000` via `Intl`. Formatters are never the rounding authority. This closes the Stripe settlement-discrepancy path (B6).

## 5. Organization currency & document stamping

### Schema

- `organizations.currency_code char(3) NOT NULL` — added nullable, backfilled from the owning partner's `currency_code`, then `SET NOT NULL`. **No column DEFAULT**: every creation path stamps explicitly. Known creation paths to update: org routes, `partnerCreate.ts:154` (seed org), `quickSupportOrg.ts:37`, `aiToolsOrgs.ts:253`, `routes/partnerApi/provisioning.ts:233`.
- Document currency columns (`invoices`, `quotes`, `contracts`): `DROP DEFAULT 'USD'` **after** all constructors stamp (wave 2), plus FKs to `supported_currencies`.
- `invoices.document_locale` / `quotes.document_locale` — render-locale snapshot stamped at issue/send (see §9).

### Stamping rules

- **Quotes/invoices/contracts stamp at creation** from the org's currency; an explicit `currencyCode` override parameter is allowed at create (quotes already accept one). Drafts included — no more "drafts display USD until issued".
- `issueInvoice` **respects the stamped header currency**; the partner-currency overwrite at `invoiceService.ts:684` is removed (B1).
- Contract generation passes `contract.currencyCode` into the invoice it creates (B2); contract creation defaults from the **org**, not `'USD'`.
- Quote creation defaults from the **org** (B3); void-and-reissue/clone paths copy the original document's currency (`invoiceService.ts:837`).
- **Immutability:** once a document has a monetary line, its currency is locked. A "change currency" action exists only as an explicit atomic operation that clears/reprices lines (drafts only; issued documents never change).

### Org currency change semantics

Editing org currency ships **last** (wave 6), gated on every vertical slice working (§12). When enabled:

- Affects only future documents and future time entries/parts. Existing drafts, active contracts, and unbilled snapshots keep their stamped currency.
- The change runs in a transaction that takes a row lock on the org and surfaces a pre-flight summary: open drafts, active contracts, and unbilled billables in the old currency (with the recovery path from §7).
- No bulk restamp of anything historical. Issued documents are immutable; the wave-1 backfill produces an **anomaly report** (migration `RAISE WARNING` counts, per repo convention) rather than rewriting — existing `USD` values may be true USD or artifacts of B1.

### Concurrency hardening (B10)

The currency guards live inside `issueInvoice` and payment recording, so those transactions are made race-safe in wave 2:

1. Lock the invoice row; recheck `status='draft'`.
2. Load and lock lines; load referenced source rows `FOR UPDATE` (the current predicate at `invoiceService.ts:647` selects already-billed rows — inverted; fix).
3. Validate existence, billing status, org, **and source-currency == header currency** after locking.
4. Compute totals (currency-aware rounding), allocate number, issue, flip sources.

Manual payment recording gets the same treatment (lock invoice, recompute balance in-transaction) to close the overpay race at `:735`.

## 6. Catalog price books

### Schema

- **New table `catalog_item_prices`**: `(id, item_id, partner_id, currency_code, unit_price numeric(12,2), created_at, updated_at)`, `UNIQUE(item_id, currency_code)`, composite ownership FK `(item_id, partner_id) → catalog_items(id, partner_id)`, FK to `supported_currencies`. Tenancy: **shape 3 partner-axis** (flat `breeze_has_partner_access`), registered in `PARTNER_TENANT_TABLES` + a dedicated partner-RLS integration suite, per the CLAUDE.md tenant-table workflow (cascade/export registration included).
- **All sell prices move into the price book.** The wave-3 migration seeds one row per item in the partner's current currency from `catalog_items.unit_price`; the column then becomes a deprecated read-mirror and is dropped in a cleanup migration once all readers are cut over. Rationale: an implicit "base price in partner currency" reinterprets every price if the partner default ever changes — the exact bug class this program exists to kill.
- `catalog_item_org_pricing` gains `currency_code NOT NULL` (backfilled from the org's currency) — same reinterpretation bug otherwise — plus a same-partner integrity FK (today it references item and org independently with no structural proof they share a partner, `catalog.ts:69`).
- **Cost is one authority:** `catalog_items.cost_basis` stays, joined by `cost_currency char(3)` (backfilled to partner currency). Costs do not vary per price-book row.

### Resolution

`resolvePrice(itemId, targetCurrency, orgId, actor)` — the **target document currency** is the input, org currency is merely what callers pass when creating a new document:

1. Org-specific override row **in the target currency** (mismatched-currency overrides are skipped);
2. Price-book row for the target currency;
3. Otherwise **NoPriceForCurrency** — a typed gap the caller must surface; document lines then require a manual `unitPrice`. Never converts, never falls through to another currency's number.

Quote catalog lines route through this resolver (killing the direct `catalog_items.unit_price` read at `quoteService.ts:1084`); contract catalog lines and invoice `addContractLine` likewise.

### Margins, bundles, imports

- Margin math computes only when `cost_currency` matches the sell currency; otherwise the UI shows "cost in CAD — margin unavailable" instead of a wrong number.
- Bundle economics (`catalogPricing.ts:74`) computes per currency: only components with prices in the target currency participate; mixed availability renders "incomplete price book" rather than a partial sum.
- **Import seams record real currency** (fixes B4, a live bug for Canadian partners today): TD SYNNEX (all three feeds) and Pax8 write `cost_currency` from the feed instead of demoting it to jsonb. Imported costs in a currency ≠ partner currency are stored truthfully and surface the margin guard above.

## 7. Ticketing

### Schema

- `time_entries.currency_code char(3)` — nullable **only while `org_id` is null** (standalone timesheet entries); attaching an entry to an org/ticket stamps it. Enforced by CHECK `(org_id IS NULL OR currency_code IS NOT NULL)`.
- `ticket_parts.currency_code char(3) NOT NULL` (parts are always ticket-linked → org known).
- `org_ticket_settings.rate_currency char(3) NOT NULL` — the currency of `default_hourly_rate`, stamped from the org.
- `ticket_categories.rate_currency char(3)` — snapshot of the partner currency the default rate was entered under (nullable when no rate). Prevents a partner-currency change from reinterpreting the number.
- Backfills: all from the owning org (entries/parts/org settings) or partner (categories), with `RAISE WARNING` counts.

### Behavior

- **Rate chain (D6 + match-or-skip):** entry override → `org_ticket_settings` rate *iff `rate_currency` == org currency* → category default *iff `rate_currency` == org currency* → none (entry requires explicit rate). The resolver (`timeEntryService.resolveTicketLink`, `:154-178`) returns the rate **with its currency**; a wrong-currency rate never lands on an entry. The org-settings UI nudges setting a local rate when an org's currency differs from the partner's.
- **Snapshots are permanent:** editing an entry's amount/rate never restamps its currency; org currency changes never touch existing rows.
- **Invoice assembly** (`invoiceAssembly.ts`) returns structured `{included, blockedByCurrency: Map<code, items>}` groups against the draft's header currency — never a silent filter. The assembly UI offers "assemble a draft in <old currency>" so pre-change billables are always invoiceable, not stranded.
- **Ticket org-moves** (`ticketService.ts:1327` move-org): when the destination org's currency differs and the ticket carries unbilled monetary rows, the move is blocked with the same recovery guidance (bill first, or explicitly accept that snapshots keep the old currency and will only assemble into an old-currency draft).
- **Exports/summaries:** billables CSV (`routes/tickets/export.ts:12`) gains a `currency` column; `getTicketBillingSummary` and timesheet money return per-currency groups (`sumByCurrency` pattern), as does `listBillables`.

## 8. FX — reporting only

- **New global table `exchange_rates`**: `(rate_date, base_code, quote_code, rate numeric(18,8), source, fetched_at)`, PK `(rate_date, base_code, quote_code)`. Non-tenant reference data: added to `INTENTIONAL_UNSCOPED`, **but RLS still enabled + forced** — tenant-context `SELECT USING (true)` (rates are public), writes only under system context; a dedicated integration test proves tenant-read-ok / tenant-write-denied / system-write-ok. Same treatment for `supported_currencies`.
- **Daily BullMQ job** fetches from Frankfurter **with the ECB provider filter** (v2 blends providers by default — do not rely on the default being ECB). Coverage is checked per currency; a pair Frankfurter doesn't cover is **unavailable**, never 1:1.
- **Manual rates** are separate rows (`source='manual'`) with deterministic precedence over the feed — the daily job can never overwrite them. This is the self-host/air-gapped path.
- **Staleness:** lookups resolve "latest rate on or before the requested date" with a max-staleness ceiling (default 7 days); beyond it the conversion result is explicitly `unavailable` and the UI shows the segmented totals only.
- `convertForReporting(amount, from, to, date)` (cross-rate via the base) is consumed **only** by dashboards/reports: every money rollup shows honest per-currency segmentation (extend the `sumByCurrency` pattern to `PartnerDashboard` MRR, ticket summaries, any future revenue widget) plus an optional "≈ X <partner currency>" line labeled approximate with the rate date. FX never touches document math and is never persisted onto documents.

## 9. Formatting & locale

- **One formatter.** The shared `formatMoney(value, code, locale)` replaces: the three API copies (`invoicePdf.ts:47`, `quotePdf.ts:32`, `quoteLifecycle.ts:32` — all `en-US`/`$`-only), the four duplicated portal `money()` helpers (`en-US`-hardcoded), and the USD-only `apps/web/src/lib/timeFormat.formatMoney` used by the four ticketing/catalog files (`TicketTimeBilling`, `TicketPartsCard`, `CatalogItemsTab`, `CatalogItemPicker`). Web billing's `billing/shared/format.ts` delegates to it.
- **Locale sources:** web keeps its resolved-locale chain; the portal uses the browser locale; **server-rendered documents snapshot their render locale at issue/send** (`document_locale`, defaulting from the partner's language setting) so a regenerated PDF never changes because the partner later switched language. Contract-template rendering (`contractTemplateRender.ts`) follows the same path.
- **Locale catalogs:** the `($)` hourly-rate labels across all 8 locales become currency-neutral interpolations (the `"{{rate}}/h"` pattern at `settings.json:2259`). **AI-budget labels stay `$`** — provider spend is genuinely USD and outside this program.
- **AI tools:** `aiToolsBilling` / `aiToolsTicketing` / `aiToolsQuotes` descriptions and outputs expose `currencyCode` explicitly and instruct grouping over summing across currencies; `hourlyRate` params documented as "in the org's currency".
- Layout note for implementers: `Intl` renders many codes as prefixes (`CHF 1,234,567.89`) — the web already guards this (issue #3318, `QuoteLineRows.tsx:95-110`); PDF money columns (`quotePdf.ts:435`) need width headroom re-checked for non-`$` currencies.

## 10. Stripe

- Cache the connected account's `default_currency` and `country` **when the API key is saved** (account retrieval already happens at `partnerStripe.ts:54`), with a `refreshed_at` stamp, an explicit refresh action, and a TTL-based re-check.
- **Warn, don't block**, when a document/checkout currency differs from the account default (many accounts can present multiple currencies; the partner eats the FX spread — surface that in the warning copy).
- Map `checkout.sessions.create` currency failures to a friendly, actionable error instead of the raw Stripe message.
- Checkout already passes invoice currency and `stripeReconcile` already guards mismatch — unchanged. Zero-decimal correctness at this boundary is inherited from the shared module (§4).

## 11. Accounting seam (QBO / future Xero)

- **Type the `AccountingProvider` interface now** — `pushInvoice`/`upsertCustomer`/`upsertItem`/`voidInvoice` get real payload types including `currencyCode` (they are untyped varargs today; nothing shipped, so no migration cost).
- At connect, fetch the realm's home currency from **`Preferences.CurrencyPrefs.HomeCurrency`** (not CompanyInfo) and persist it to the existing-but-dead `accounting_connections.home_currency`.
- **Implement the documented-but-never-built guard:** invoice push (when Phase C ships) hard-blocks with a clear error when `invoice.currencyCode !== connection.homeCurrency`. The guard's unit contract is written now against the typed interface; its integration test lands with the push entrypoint.
- Foreign-currency QBO push (`CurrencyRef` + `ExchangeRate`) remains **deferred beyond this program**.
- Payment pull-back (`ChangeSet.payments[]` — minor units + own currency) must convert via `fromMinorUnits` and assert currency equality with the invoice before applying.

## 12. Explicit non-goals

- Invoice numbering stays `(partner, year)` — no per-currency sequences.
- Storage stays `numeric` major units (no integer-cents migration).
- VAT/jurisdiction tax, credit memos, cross-currency payments (a payment always matches its invoice's currency), 3-decimal currencies, Breeze's own SaaS pricing, and FX gain/loss accounting: all out of scope.
- Mobile has no money surface — not a target.

## 13. Waves

Each wave is its own PR chain with its own implementation plan (`writing-plans`), tracked via feature-lifecycle sub-issues.

1. **Foundations** — shared currency module + validators; `supported_currencies` + FKs; currency-aware rounding through `invoiceMath`/`catalogPricing`/`depositMath`; `organizations.currency_code` added + audited backfill (**editing not exposed**); `exchange_rates`-style RLS treatment for the reference table.
2. **Document correctness** — stamping on every create/clone/reissue path (B1–B3), drop USD column defaults, header-currency authority + draft-currency immutability, contract propagation, race-safe issue/payment transactions (B10).
3. **Price books & costs** — `catalog_item_prices` migration + RLS suites, org-override currency, `resolvePrice(item, targetCurrency, org)`, bundles, margin guards, TD SYNNEX + Pax8 import currency (B4).
4. **Ticketing** — currency snapshots on entries/parts, rate-setting currencies + match-or-skip chain, assembly included/blocked grouping + old-currency draft recovery, ticket-move guard, billables export + summaries (B5).
5. **Formatting & checkout readiness** — shared formatter adoption across API PDFs/emails, portal, web ticketing/catalog files; `document_locale` snapshots; locale-catalog label fixes; AI tool currency exposure; Stripe warning/error mapping + account-currency cache (B7, §10).
6. **Enable org currency selection/change** — org billing-settings UI + change-flow with pre-flight summary. **Release gate:** every non-default-currency vertical slice proven end-to-end first — manual invoice, quote→acceptance→invoice, recurring contract billing run, ticket labor + part → assembly, void/reissue, Stripe payment, PDF render.
7. **FX + reporting** — `exchange_rates` + Frankfurter/ECB job + manual rates + staleness; dashboard segmentation + approximate conversions (`PartnerDashboard` MRR et al.).
8. **Stripe metadata polish + QBO seam** — refresh lifecycle, typed provider interface, `CurrencyPrefs` capture, mismatch-guard contract (B8).

Waves 1–2 are sequential prerequisites. 3, 4, 5 can proceed in parallel after 2. 6 gates on 3–5. 7 and 8 are independent of 6.

## 14. Testing requirements (program-level)

- Shared module: exhaustive unit tests — rounding per exponent, zero-decimal round-trips, no-3-decimal assertion, formatter fallbacks.
- Contract tests: `supported_currencies` table ↔ shared list parity; document-constructor tests asserting **the real browser payload shapes** (the Recurring Contracts `null`-vs-`undefined`/money-string trap).
- RLS: `catalog_item_prices` partner-axis suite (cross-partner forge 42501); dedicated `exchange_rates`/`supported_currencies` tests (tenant read ok, tenant write denied, system write ok); all new tenant tables through the full CLAUDE.md registration workflow (cascade lists + export policy — including the **new columns** added to registered tables, which the export-policy contract fires on).
- Integration (real DB): contract→invoice currency propagation; issue-race regression (two concurrent issuers); assembly blocked-group behavior after an org currency change; backfill anomaly counts.
- E2E: the wave-6 release-gate slices, run against a non-USD org on a USD partner.

## 15. Follow-ups this program deliberately creates

- VAT/tax-code initiative (expected fast-follow demand from non-USD partners).
- QBO foreign-currency push (`CurrencyRef`) once real demand exists.
- Per-currency invoice numbering if a jurisdiction requires it (schema note: `partner_invoice_sequences` PK change).
- Portal i18n (locale plumbing beyond browser default).
