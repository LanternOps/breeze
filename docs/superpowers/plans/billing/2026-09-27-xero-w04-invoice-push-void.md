---
spec: docs/superpowers/specs/billing/2026-09-26-xero-accounting-integration-design.md
index: docs/superpowers/plans/billing/2026-09-26-xero-accounting-integration-index.md
tracking_issue: LanternOps/breeze#7167
wave_issue: LanternOps/breeze#7171
---

# Xero W04: Invoice Push and Void Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A partner connected to Xero can push issued Breeze invoices to Xero as approved sales invoices (ACCREC), automatically on issue or by hand, with the tax total placed on the lines so Xero's totals equal Breeze's, and can void them. After this wave Xero declares `invoicePush`.

**Architecture:** The provider-neutral invoice coordinator (`accountingInvoicePush.ts`), its routes, the sync worker and the web sync card already exist, with QuickBooks as the reference. W04 fills the two Xero stubs W02a left (`pushInvoice`, `voidInvoice`) through a new Xero-only module, `xeroInvoices.ts`, built on W03's write helper (`xeroApiWrite`, request-derived `Idempotency-Key`). Adoption is the primary duplicate guard: before every create, and after every uncertain outcome, the provider looks the invoice up by `Reference = breeze:<invoiceId>`. The core gains only neutral pieces: an optional synchronous `invoicePushPreflight` hook (so a missing Xero setting fails before any token refresh or network call), a pure tax-allocation module, five terminal push error codes, one more refusal code (`remote_locked`), and provider-labelled operator messages (QuickBooks text byte-identical). The capability flips only in the last PR, after the lab proves a real push, the duplicate-number fallback and the per-line tax override against the Xero Demo Company.

**Tech Stack:** TypeScript, Hono, Drizzle ORM on PostgreSQL (partner-axis RLS), BullMQ + ioredis, Vitest, React (Astro islands) + react-i18next.

**Spec:** `docs/superpowers/specs/billing/2026-09-26-xero-accounting-integration-design.md` (the "W04 — Invoice push + void" section, "Invoice totals invariant", "Rate limiting", "Open verification items" 1–2, and the cross-wave adoption rule). W01 contract: `2026-09-26-xero-w01-core-neutralization.md`. W02 contract: `2026-09-26-xero-w02-connection.md`. W03 contract: `2026-09-27-xero-w03-contacts-items-import.md` (PR #7236, not merged when this plan was written).

---

## Preconditions (hard gates, check before Task 0)

1. **W02 (a, b, c) and W03 (a, b) are merged to `main`.** W04a builds on W02a's `xeroHttp.ts`/`xeroProvider.ts`, W02b's registration of Xero in `providerRegistry.ts`, W03a's `xeroApiWrite`, `xeroIdempotencyKey`, `xeroQuery`, `parseXeroDate`, `requireXeroBody`, `xeroArray`, `classifyXeroValidation`, refusal codes and `xeroItems.ts`, and W03b's capability flip (Xero must already declare `mapping`, or no org can be mapped to a contact and no invoice can reach the create path in the lab). W04 does **not** stack on any of them.
2. **W02c's lab document exists** (`docs/integrations/xero-demo-verification.md`) with W03's section 3 appended. W04b appends section 4.
3. **Feature-lifecycle:** run `get_feature_status` for #7167; branch `feature/7167-xero/wave-7171-a-server` (then `…-b-web`); run `start_wave` for #7171 when W04a starts — **not before** (this plan's author did not start the wave).
4. **W03's open scope question is settled.** W03b's lab step X16 decided whether the pinned `accounting.invoices` scope can write Items. If it forced a scope change (`accounting.settings`), that change is on `main` before W04 starts; W04 changes no scopes. Invoices themselves are covered by `accounting.invoices` in both Xero's Scopes page and the granular-scopes FAQ (W02 refinement 12).

```bash
git fetch origin main
git log origin/main --oneline | grep -iE 'xero w0[23]|#716[9]|#7170' | head -20
git ls-tree --name-only origin/main apps/api/src/services/accounting/ | grep -E '^.*/(xeroHttp|xeroProvider|xeroContacts|xeroItems|retryAfter)\.ts$'
```

Expected: the W02a, W02b, W02c, W03a and W03b squash commits are listed; all five files exist on `main`. Anything missing: stop — the premise does not hold.

## Interface assumptions (re-verify every line in Task 0)

W04 calls these by the exact names below. **M** rows were read from `main` (`c171f67d76`, 2026-09-27). **A** rows were read from W02a's branch (`feature/7167-xero/wave-7169-a-foundation` @ `d4e421056e`, PR #7226, open). **B** rows come from the W02 plan text for W02b (being implemented in parallel). **C** rows come from the W03 plan text (PR #7236, branch `docs/xero-w03-plan`, not merged). If a name or shape differs on `main`, follow `main`: adapt the task's code and record the difference in the PR body. Never rename the upstream symbol back.

| # | Symbol (file) | Shape W04 relies on | Source |
|---|---|---|---|
| M1 | `AccountingProvider.pushInvoice(conn, invoice, lineMappings)` / `.voidInvoice(conn, invoice, mapping)` (`services/accounting/types.ts:394-403`) | returns `InvoicePushResult` / `InvoiceVoidResult`; obligations 1–2 in the interface doc comment (only `AccountingProviderError`; duplicate doc number absorbed by the provider) | main |
| M2 | `AccountingInvoicePayload`, `AccountingInvoiceLinePayload`, `AccountingInvoiceLineMapping`, `InvoicePushResult`, `InvoiceVoidResult` (`types.ts:125-194`) | as quoted in Tasks 5–7; `lines[].quantity/unitPrice/lineTotal` are decimal strings; `mapping: { remoteEntityId, remoteSyncToken } \| null`; `remoteTaxTotal`/`remoteTotal` major-unit strings | main |
| M3 | `pushInvoiceToAccounting` / `voidInvoiceInAccounting` (`accountingInvoicePush.ts:659`, `:981`) | Phase 1 (`runInDbContext`) → dependency syncs → Phase 1b pending claim → `resolveLiveConnection` → `runOutsideDbContext(provider.pushInvoice)` → Phase 2; the push `catch` at `:854-872`; the void `catch` at `:1047-1081` | main |
| M4 | `PERSISTED_PREFLIGHT_CODES` (`accountingInvoicePush.ts:250`), `persistInvoicePreflightErrorInOwnContext`, `markInvoiceMappingErrorInOwnContext`, `logProviderFault` | as named | main |
| M5 | The 11 `QuickBooks`-worded operator strings in `accountingInvoicePush.ts` (`:518`, `:546`, `:582`, `:695`, `:711`, `:737`, `:747`, `:775`, `:825`, `:892`, `:1008`) | Task 1 rebuilds each from the provider label | main |
| M6 | `AccountingInvoicePushErrorCode`, `AccountingInvoicePushError(code, status, message, opts)` (`accountingInvoicePushErrors.ts`) | status `404 \| 409 \| 429 \| 502` | main |
| M7 | `assertPushedLinesMatchSubtotal`, `computeRemoteVariance`, `pushedLineAmounts` (`accountingInvoiceTotals.ts`) | unchanged; W04 relies on them | main |
| M8 | `TERMINAL_CODES` and the invoice-job catch (`jobs/accountingSyncWorker.ts:141-153`, `:318-337`) | every terminal code is captured to Sentry today | main |
| M9 | `accountingInvoicePush.test.ts` harness: hoisted `pushInvoiceMock`/`voidInvoiceMock`/`captureExceptionMock`/`resolveConnectionMock`/`resolveLiveConnectionMock`, `conn()`, `liveConn()`, `setup({ invoice, lines, mappings })`, `orgMappingRow()`, `runCtx`, `currentMappings`, `updatedPatches`, the `./providerRegistry` mock at `:106-115` | as named | main |
| M10 | `accountingInvoicePushCallSites.test.ts` | counts call expressions named `pushInvoice`/`voidInvoice`/`createPayment`/`deletePayment` repo-wide; only `accountingInvoicePush.ts` and `accountingPaymentPush.ts` may call them. Xero helpers must use other names | main |
| M11 | `quickbooksIdempotency.test.ts` | pins `requestid = invoiceId` for a QuickBooks invoice create | main |
| M12 | `loadConnectedConnection` (`accountingPaymentPush.ts:485-506`) | returns null unless `providerSupports(provider, 'paymentPush')` — so `fanOutOwedPayments` creates no payment mapping for a Xero invoice until W05 | main |
| M13 | `listPayments` payment `accountingSync` (`services/invoiceService.ts:2145-2156`) | `{ status, lastError }`; the joined `provider` column is already selected (`:2126`) | main |
| M14 | Web `InvoicePayment.accountingSync` (`components/billing/invoiceTypes.ts:249`); payment badge (`InvoiceDetail.tsx:713-727`, test id `invoice-payment-qbosync-<id>`); `syncProviderName` (`:78`) | as quoted in Task 9 | main |
| M15 | Bulk push route (`routes/accounting/index.ts`, `POST /:provider/invoices/push-bulk`) | answers 200 `{ enqueued: 0, skipped: N, failed: 0 }` when the partner has no connection (W01d R14) | main |
| M16 | `computeLineTotal(quantity, unitPrice, currency)` (`services/invoiceMath.ts:19`) — half-up at the currency's minor unit; `minorUnitExponent(currency)` (`@breeze/shared`) — `0 \| 2` | as named | main |
| A1 | `xeroApiGet<T>(ctx, path, operation)`, `XeroCallContext { connectionId, tenantId, accessToken, rate, timeoutMs? }` (`xeroHttp.ts`) | as named | W02a |
| A2 | `xeroProvider.ts` private `callContext(conn, timeoutMs?)` (throws `AccountingProviderError{validation}` without tenant/token); stubs `pushInvoice`/`voidInvoice` with `_`-prefixed params calling `notYet('invoice push' \| 'invoice void', 'W04')` | as named | W02a |
| A3 | `AccountingConnection.defaultIncomeAccountRef` (Xero Account `Code`), `.defaultTaxCodeRef` (Xero `TaxType`), `.defaultExemptTaxCodeRef` (Xero `TaxType`) | set by W02c's settings step | W02a |
| A4 | `xeroProvider.test.ts`: `conn()` factory, `json()` helper, the `describe('methods behind later waves')` `it.each` table | as named | W02a |
| B1 | `providerRegistry.ts` registers `xero: xeroProvider`; `providerRegistry.test.ts` pins Xero's capability list (W03b's version: `['connect','mapping','customerImport']`) | W04b edits the pin | W02b Task 10 |
| B2 | `upsertConnection(db, partnerId, 'xero', { realmId, accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, environment, homeCurrency })` accepts a Xero row | used by the Task 10 real-DB suite | W02b |
| C1 | `xeroApiWrite<T>(ctx, method: 'PUT' \| 'POST', path, body, operation, opts?: { idempotencyKey?: string })`; a `PUT` without an explicit key gets a request-derived one | as named | W03 Task 2 |
| C2 | `xeroIdempotencyKey(tenantId, method, path, body): string` (`'breeze-' + 64 hex`; W04 does **not** use it for invoices — refinement 2), `xeroQuery(params)`, `parseXeroDate(value)`, `requireXeroBody(body, operation)`, `xeroArray(value)` | as named | W03 Task 2 |
| C3 | `xeroHttp.ts` private `allValidationMessages(text)`, `apiKindFor(status, headers)`, `xeroApiError(operation, status, headers, text)` (400 → `validation` + `providerCode = classifyXeroValidation(text)`) | Task 4 extends `apiKindFor` | W03 Task 2 |
| C4 | `ACCOUNTING_REFUSAL_CODES` (`accountingProviderError.ts`) = `['duplicate_name','duplicate_key','remote_archived','remote_missing','insufficient_scope']`; `refusalCodeOf(err)` (kinds `validation` and `not_found` only); `providerPermissionMessage(label)` | Task 1 appends `remote_locked` | W03 Tasks 1, 5 |
| C5 | `xeroItems.ts`: exported `XeroItem` (`ItemID`, `Code`, `SalesDetails.AccountCode`), private `readAllItems(ctx, operation)` (one unpaged `GET Items?unitdp=4`) | Task 4 exports `readXeroItemRefs` | W03 Task 4 |
| C6 | `MAPPING_USER_RESOLVABLE_CODES` in `jobs/accountingSyncWorker.ts` (terminal, no Sentry) | Task 2 adds the invoice twin next to it | W03 Task 5 |
| C7 | W03's `providerRefusal` switch in `accountingMappingService.ts` (maps refusal codes to mapping errors) | adding `remote_locked` must not break its exhaustiveness (Task 1 Step 3) | W03 Task 5 |
| C8 | `docs/integrations/xero-demo-verification.md` sections 0–3, rows X1–X31, `## Change log` | Task 11 appends section 4 (X32–X46) | W02c Task 13 + W03 Task 11 |

**That is 16 main, 4 W02a, 2 W02b and 8 W03 assumptions (30).**

## Where this plan refines the spec (read before implementing)

Each item was checked against the code on `main`/W02a, or against Xero's published documentation, on 2026-09-27. Xero sources: Invoices <https://developer.xero.com/documentation/api/accounting/invoices>, Requests and responses <https://developer.xero.com/documentation/api/accounting/requests-and-responses>, Response codes <https://developer.xero.com/documentation/api/accounting/responsecodes>, Idempotency <https://developer.xero.com/documentation/guides/idempotent-requests/idempotency>, Limits <https://developer.xero.com/documentation/guides/oauth2/limits>, Rounding <https://developer.xero.com/documentation/guides/how-to-guides/rounding-in-xero>, Tax <https://developer.xero.com/documentation/guides/how-to-guides/tax-in-xero>, Creating invoices (best practice) <https://developer.xero.com/documentation/best-practices/data-integrity/creating-invoices>, OpenAPI <https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero_accounting.yaml>. (developer.xero.com renders client-side; the pages were read in a browser. Quotes below are verbatim.)

1. **Creates use `PUT`, never `POST`.** Xero: PUT "you can only create new invoices with this method"; POST "will either create new data or update existing data". Vendors report that a `POST /Invoices` carrying an existing `InvoiceNumber` *edits that invoice* instead of failing. So a create is `PUT Invoices`, an update is `POST Invoices/{InvoiceID}` and **never sends `InvoiceNumber`** (Xero keeps the number it has). Lab **X41** records whether a POST with a foreign number really edits.
2. **The idempotency key names the request's identity, not its bytes (quorum finding 1).** The spec's key is `sha256(invoiceId, pushGeneration, variant)`. On `main`, invoice mappings never change `push_generation` (only the payment coordinator bumps it; `grep -rn pushGeneration apps/api/src/services apps/api/src/jobs` finds no invoice writer), so the spec's inputs reduce to `(invoiceId, variant)`. W04 keeps that shape — `xeroInvoiceIdempotencyKey(tenantId, invoiceId, variant, supersededIds)` — and deliberately does **not** use W03's request-derived key: the invoice body carries mutable inputs (connection settings, a mapped item's sales account), and two concurrent pushes of one invoice (an auto job and a manual click; Phase 1b re-claims a `pending` row) whose bodies differ would get two keys, both miss the adoption lookup and — when the number is taken — both create numberless invoices. With one key per variant, the second request either replays the first (same body) or gets Xero's `"Idempotency Key: … is used with a different request."` 400, which `xeroHttp` classifies as `transient` (an uncertain outcome) so the provider looks again and adopts the first request's invoice. The price is the 6-minute window after a settings change: a retry whose body changed gets that 400 until the window lapses — a delay, never a duplicate. The spec's `pushGeneration` intent (a new key for a re-owned push) is kept by the fourth input: the sorted InvoiceIDs of our own VOIDED/DELETED invoices, as found by the **latest** lookup (quorum finding 2), so a create after a voided predecessor can never replay the predecessor's cached response.
3. **Xero is told the exact line amount; its rounding is never relied on.** Xero computes `LineAmount = Quantity × UnitAmount` and documents neither the rounding mode nor what happens when a supplied `LineAmount` disagrees. Breeze's `lineTotal` is `computeLineTotal` (half-up), and hidden or bundle-component lines carry `lineTotal = 0.00` with a non-zero price. Each line is therefore sent as: (a) `Quantity`, `UnitAmount` as stored when their product is **exactly** the line total; else (b) `Quantity` and a 4-decimal `UnitAmount` (`unitdp=4`) when `lineTotal ÷ quantity` is exact to 4 places; else (c) `Quantity: 1`, `UnitAmount: lineTotal`, with ` (<qty> × <price>)` appended to the description. `LineAmount` is never sent. Money is exact in every case; only (c) changes what Xero shows as the quantity, and it says so in the text. Lab **X36** records Xero's rounding of `1.5 × 10.95` for the record.
4. **Tax placement follows what Breeze actually taxed.** Breeze stores one invoice tax figure, computed on taxable, customer-visible lines. A line is *taxed* when it is `taxable` **and** the invoice's `taxTotal` is non-zero. Taxed lines use `default_tax_code_ref`; every other line — non-taxable lines, and all lines of a zero-tax invoice (a tax-exempt organisation's lines are still flagged taxable) — uses `default_exempt_tax_code_ref`. Otherwise a tax-exempt customer's invoice would show a 20% VAT rate with a zero amount. The pre-flight asks for the exempt tax rate only when an untaxed line exists, and for the taxable one only when a taxed line exists.
5. **`TaxAmount` per line is allocated in the currency's minor unit, with a fallback switch.** `accountingTaxAllocation.ts` spreads `taxTotal` over taxed lines pro rata to `lineTotal`, largest remainder, in minor units (cents; whole units for JPY), with BigInt so a large invoice cannot lose precision; the shares sum exactly to `taxTotal`. Xero: `TaxAmount` "can be overriden if the calculated TaxAmount is not correct", and Xero computes tax "on a per line basis, rounding to two decimal places, and then sums". But the Invoices page also says "TaxAmount specified cannot be greater than the UnitAmount", which, read literally, would reject an override on a many-unit, low-price line. `xeroInvoices.ts` exports `XERO_SEND_LINE_TAX_AMOUNT = true`. Lab **X34/X35** settles open item 1: if Xero rejects overrides (or the quantity case), set it to `false` in a one-line commit before the flip — Xero then calculates, and the existing post-push drift check marks any difference `synced_with_tax_variance` (the spec's stated fallback). Both modes are unit-tested.
6. **Missing settings fail before any network call.** The spec's push preconditions (no income account; a taxed line without `default_tax_code_ref`; an untaxed line without `default_exempt_tax_code_ref`) are provider knowledge, so they cannot live in the core. `AccountingProvider` gains an **optional, synchronous** `invoicePushPreflight(conn, invoice)`. The coordinator calls it in Phase 1, right after the totals guard, so a refusal fires before the dependency syncs, the token refresh and the provider call, and is persisted on the invoice's mapping row exactly like `currency_mismatch` (new code `push_settings_incomplete`). A tax total that cannot be placed on any line (tax recorded but no taxed line carries an amount) is the same kind of Breeze-side refusal as #7161 and reuses `invoice_totals_mismatch`. QuickBooks declares no pre-flight, so its path is unchanged.
7. **A re-push reads first, then resends Breeze's content unless Xero forbids it (quorum finding 4).** The spec says "a re-push resends identical content", but Xero will not change the lines of an invoice with a payment or credit applied (Invoices: once paid, "you can only update" Reference, DueDate, InvoiceNumber, BrandingThemeID, Contact, Url and line Description/AccountCode/Tracking). So when an invoice already exists in Xero (mapped, or adopted by `Reference`), the provider reads it (`GET Invoices/{id}`): VOIDED/DELETED or 404 → `remote_missing`; no money applied → `POST Invoices/{id}` with the full body and `Status: AUTHORISED` (this also approves an adopted DRAFT/SUBMITTED invoice, and restores any field someone edited in Xero — comparing totals alone would miss a changed due date, account or tax type); money applied (`AmountPaid` or `AmountCredited` > 0, or `PAID`) and the same currency, contact, subtotal, tax and total → **no write**, the read is the result (the lines cannot be edited, and they already carry Breeze's amounts); money applied and different amounts → `remote_locked`. An update carries no `LineItemID`s, so Xero replaces the lines — harmless on an unpaid invoice, and the only way to resend them.
8. **Void reads first, too.** Xero's status rules: DRAFT/SUBMITTED → `DELETED`, AUTHORISED → `VOIDED`, and a void is refused while payments or credit notes are allocated ("The status VOIDED cannot be applied to the invoice because it has payments or credit notes allocated to it." — reported text, lab **X39**). The provider reads the invoice: 404 → success with no version (the invoice is already gone — the desired end state, like `deletePayment`'s `already_absent`); VOIDED/DELETED → success with its version (idempotent; voiding a VOIDED invoice is undocumented, so it is never sent); PAID or money applied → `payment_linked` (the core's existing void-with-payments flow, #5180); otherwise the right target status. A 400 whose messages name an allocated payment/credit note is still classified `payment_linked` (race between the read and the write).
9. **Duplicate invoice numbers get one adoption look, then one numberless retry.** Xero's OpenAPI example for this validation error is `"Invoice # must be unique."` (lab **X38** confirms the call path). The 400 is classified `kind: 'duplicate_doc_number'`. Our own earlier create may own that number (a lost response), so the provider first looks up `Reference = breeze:<invoiceId>`; a hit is adopted. On a miss, it retries once without `InvoiceNumber` (Xero auto-numbers "from your Organisation Invoice Settings"), which is a different body and so a different key. The core already persists a differing `docNumber` as `remote_doc_number`, which the sync card shows ("Xero document INV-0042") — the "recorded in sync status" the spec asks for.
10. **`Reference` lookup uses `where`, re-checked client-side.** Xero lists `Reference` among the optimised `where` filters for Invoices. The lookup is `GET Invoices?where=Reference=="breeze:<id>"&unitdp=4` (the documented example writes a single `=`; the plan uses Xero's general `==` syntax and lab **X37** confirms it). Results are filtered client-side to `Type === 'ACCREC'` (absent `Type` is treated as ACCREC) and an exact `Reference` match, then split into *live* (DRAFT, SUBMITTED, AUTHORISED, PAID) and *superseded* (VOIDED, DELETED). Two or more live hits → `validation` + `duplicate_key` → terminal `remote_ambiguous` ("never guess").
11. **`Reference` is customer-visible.** The spec fixes `Reference = breeze:<invoiceId>` as the adoption key (no Xero invoice field is API-only). Whether it prints on the PDF or online invoice depends on the organisation's branding theme and is undocumented; lab **X46** records it. Changing the key is out of scope for W04 (it is a cross-wave contract).
12. **Mapped items contribute `ItemCode` and their own sales account; a missing item does not block the invoice.** The mapping row stores Xero's `ItemID`, but an invoice line takes `ItemCode`. When any line has a mapped item, the provider reads the price list once (`GET Items`, one unpaged call — W03's `readAllItems`) and maps `ItemID → { Code, SalesDetails.AccountCode }`. Each line always sends an explicit `AccountCode`: the item's sales account when it has one, else `default_income_account_ref` (Xero's docs disagree on whether an `ItemCode` alone supplies the account, so it is never relied on). A mapped item no longer in Xero is sent **without** `ItemCode` (description, quantity, price, account and tax are complete) and logged; the item mapping's own `remote_missing` surfaces in the workbench on its next sync. Money is never withheld over a reporting link.
13. **Errors come back as a 400, explicitly.** The OpenAPI spec lists `summarizeErrors` with `default: false` (200 with per-element errors), while the docs describe a 400 on error. Every invoice write sends `summarizeErrors=true`, and a 2xx element carrying `HasErrors: true` is still treated as a `validation` failure. Lab **X44** records the real default.
14. **Provider refusals the operator must resolve are terminal and quiet.** From an invoice push: `remote_missing` → `remote_missing`, `duplicate_key` → `remote_ambiguous`, the new refusal code `remote_locked` → `remote_locked`, `insufficient_scope` → `provider_permission` (W03's `providerPermissionMessage`). Each is 409, persisted as the mapping's `last_error`, terminal in the worker, and — except `remote_ambiguous`, which should never happen — not sent to Sentry. QuickBooks never sets these codes on an invoice, so its errors keep their current handling (a pinned test proves a QuickBooks `6240` still becomes the retryable 502).
15. **Operator messages are labelled by provider.** The 11 `QuickBooks`-worded strings in `accountingInvoicePush.ts` (M5; W01d deferral R3) move to `accountingInvoicePushMessages.ts` as functions of the display name. With `'QuickBooks'` each returns the exact pre-W04 literal; a table test pins all 11.
16. **Bulk push with no connection stays as it is** (W01d R14 remains parked; quorum finding 6). Answering 404 would change a shared QuickBooks route and drop its audit row for a case the web already hides; W04 has no QuickBooks-visible change at all.
17. **The payment sync badge names its own provider** (W01d deferral "Invoice badge"). `listPayments` already joins the mapping's connection; the badge now reads `accountingSync.provider` and falls back to the invoice-level name only when absent, so a transient failure of the invoice-level sync read no longer renders "In ".
18. **Payments stay out.** `fanOutOwedPayments` and `requestPaymentPush` both go through `loadConnectedConnection`, which returns null unless the provider supports `paymentPush` (M12). So flipping `invoicePush` creates no payment mapping rows for Xero until W05. Task 10 proves it against Postgres.
19. **Export/erasure/RLS registries: nothing to add.** No table, column, index or migration. Invoice mappings keep `remote_entity_type = 'Invoice'` (spec D6). If an executor finds a column is needed after all, stop and amend the plan first; the migration would have to sort after `git ls-tree --name-only origin/main apps/api/migrations/ | sed 's#.*/##' | grep '^20' | sort | tail -1` (on 2026-09-27: `2026-11-05-101500-command-requester-active-resolver.sql`; W02a adds `2026-11-05-120000-accounting-connections-xero-columns.sql`).
20. **Call budget.** A first push costs 2 calls (reference lookup + `PUT`), 3 with mapped items; a re-push costs 1 (read, no-op) to 3; a void costs 2. Pushes keep priority over background work (spec "Rate limiting"): they never call `shouldDeferBackgroundWork`. A throttle anywhere in the sequence is a `rate_limited` delay (W01c); because the pre-create lookup runs on every attempt, a create that landed before the throttle is adopted on the retry.
21. **Known limitation: Xero replays a cached error under the same key for 6 minutes.** Xero: "If an idempotent request errors out internally, the error will be cached". The sync job's 5 attempts (exponential from 5 s, about 75 s in all) fall inside one window, so a genuine Xero 5xx on a create fails every attempt and the invoice mapping reads `error`; nothing sweeps invoice pushes, so a tech's **Push to Xero** after 6 minutes succeeds (its pre-create lookup adopts anything that did land). The same holds for a create refused because of Xero-side state the MSP fixes within 6 minutes (an archived contact). This is W03's accepted limitation (its refinement 9), and it matches QuickBooks today (no invoice re-push sweep). Lab **X42** exercises the adopt-after-loss half.
22. **A void finds a create Breeze never recorded (quorum finding 3).** A create can land in Xero while both its response and the recovery lookup fail; the mapping then reads `error` with no remote id, and `voidInvoiceInAccounting` treats such a row as "never reached the provider" — a Breeze void would leave a live Xero invoice. `AccountingProvider` gains an **optional** `findRemoteInvoice(conn, invoiceId)`; when the invoice mapping is `error` with no remote id and the provider declares it, the void looks the invoice up (outside any DB context, after the token is resolved), voids what it finds, and records the remote id and version on the row. QuickBooks declares none (it has no adoption key for invoices), so its void is unchanged; the same gap for QuickBooks is noted in "Deliberately not in W04".

## Global Constraints

- Xero's capabilities after W04 are exactly `{ connect: true, mapping: true, customerImport: true, invoicePush: true, paymentPull: false, paymentPush: false }`, flipped **only** in Task 10 (W04b). Through W04a they stay W03's.
- **QuickBooks is byte-identical.** `git diff origin/main -- apps/api/src/services/accounting/quickbooks*.ts` is empty at the end of every PR. `quickbooksIdempotency.test.ts` (invoice `requestid = invoiceId`), `quickbooksProvider*.test.ts`, and every QuickBooks message assertion in `accountingInvoicePush.test.ts`, `routes/accounting/invoicePush.test.ts` and `jobs/accountingSyncWorker.test.ts` pass **without edits**. W04 has no intended QuickBooks-visible change (refinement 16).
- Invoice adoption key: `Reference = 'breeze:' + invoiceId`, looked up before every create and after every uncertain outcome (`transient`, `duplicate_doc_number`). A live hit is adopted (read, then no-op or update), never re-created.
- Idempotency: creates (`PUT`) carry `xeroInvoiceIdempotencyKey(tenantId, invoiceId, variant, supersededIds)` (refinement 2); updates and voids (`POST`) carry none. Xero's key-reuse 400 is `transient` (look again, never a new key).
- Every Xero invoice write sends `unitdp=4&summarizeErrors=true`. `LineAmount` is never sent (refinement 3). `LineAmountTypes: 'Exclusive'`, `Status: 'AUTHORISED'`, `Type: 'ACCREC'`, `DueDate = dueDate ?? txnDate`.
- No Xero module calls `fetch` directly except `xeroHttp.ts`. No new function may be *named* `pushInvoice`/`voidInvoice`/`createPayment`/`deletePayment` outside the provider classes (M10): the Xero helpers are `pushXeroInvoice` / `voidXeroInvoice`.
- The neutral-core guard stays green. New Xero wire logic lives only in `xeroHttp.ts`, `xeroItems.ts`, `xeroInvoices.ts`, `xeroProvider.ts`. New core files (`accountingInvoicePushMessages.ts`, `accountingTaxAllocation.ts`) contain no `'quickbooks'` or `'xero'` literal.
- No new tables, columns, migrations, env vars, scopes, Sentry tags or `SELF_MANAGED_DB_CONTEXT_ROUTES` entries.
- `routes/accounting/index.ts` must not grow: `wc -l` at the end of each PR ≤ its Task 0 count.
- Every provider HTTP call runs with no held DB context (the coordinator's existing `runOutsideDbContext` contract).
- Web: every mutation goes through `runAction`. Every QuickBooks `data-testid` and English string stays byte-identical. No new i18n keys (the badge reuses `invoiceDetail.payments.*`).
- Tests: one file with `cd apps/api && npx vitest run <path>` (never `pnpm … test -- --run`). Integration: `pnpm test-stack up`, `cd apps/api && npx vitest run -c vitest.integration.config.ts <path>`, `pnpm test-stack down`.
- Every PR runs, before opening: the full API unit suite, `npx tsc --noEmit -p apps/api`, the accounting integration set (`src/__tests__/integration/accounting*` + `tenantCascade`), `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`; W04b also runs `cd apps/web && npx vitest run` and `npx astro check` in `apps/web`.

## Review Focus

The failure modes most likely to bite a real partner that no single task tests by itself, most likely first. Each has a pinned test in the task that owns the code.

1. **A push whose response is lost (timeout, 5xx) and is retried — by the job, or by a tech clicking Push again.** Expected: exactly one Xero invoice. The retry's pre-create lookup finds `Reference = breeze:<invoiceId>` and adopts it (read, then an update that resends the same content — never a second `PUT`); a replay inside 6 minutes carries the same `Idempotency-Key`, and a concurrent push whose body differs gets Xero's key-reuse 400 and adopts too. *(Task 6 "adopts after a timed-out create" / "a second push adopts instead of creating" / "one key per variant" / "a concurrent push with a different body adopts"; Task 10 "a lost create response is adopted…".)*
2. **An invoice number Xero already holds (an MSP that invoiced from Xero before Breeze, with overlapping numbering).** Expected: one adoption look; on a miss, one retry without `InvoiceNumber`; the Breeze invoice is `synced` and the card shows "Xero document INV-0042". Never an endless retry, never a second invoice. *(Task 4 classification; Task 6 "duplicate number → numberless retry" / "duplicate number owned by our lost create is adopted"; lab X38.)*
3. **Xero's totals differing from Breeze's by a cent.** Expected: never, for money Breeze controls — each line carries its exact amount (refinement 3) and the tax shares sum exactly to Breeze's tax total (refinement 5). If Xero still differs by more than a cent (it recalculated, or the override is off), the mapping reads `synced_with_tax_variance`. A difference of exactly 1¢ stays `synced`: that is the existing tolerance of `computeRemoteVariance`, shared with QuickBooks and deliberately not changed here (quorum finding 5); lab X34–X36 check the totals are exact. *(Task 3 property test; Task 5 line-representation table; Task 6 variance passthrough; lab X34–X36.)*
4. **A missing Xero setting (no exempt tax rate chosen) with auto-push on.** Expected: the invoice issues normally; the push refuses **before** any Xero call or token refresh with "Choose a tax rate for non-taxable lines in Integrations → Accounting → Xero, then push again"; the sync card shows it; the worker does not retry and does not page Sentry. *(Task 2 "preflight settings refusal"; Task 5 preflight table; Task 10 real-DB "no fetch on a settings refusal".)*
5. **Voiding in Breeze an invoice that was paid, or already voided, in Xero.** Expected: paid → the existing "Xero will not void this invoice because a payment is applied to it there — remove or unapply that payment in Xero, then void the invoice again" message, terminal; already VOIDED/DELETED or absent → success, no write; an adopted DRAFT → `DELETED`, not `VOIDED`. *(Task 7 void table; Task 2 "void refusal" pins.)*

---

## PR split

| PR | Branch | Tasks | What ships | Stands alone because |
|---|---|---|---|---|
| **W04a** Server | `feature/7167-xero/wave-7171-a-server` | 0–8 (9 tasks) | provider-labelled messages, preflight hook, new push codes + refusal mapping, worker terminal/quiet sets; tax allocation; Xero 400 kind classification + item refs; `xeroInvoices.ts` (preflight, body, lookup, push, re-push, void); provider wiring | Xero's `invoicePush` stays false, so no route (`providerGateResponse`), producer (`resolveActiveConnectionFor(…,'invoicePush')` in `invoiceService`/`quoteAcceptService`), worker (`resolveJobConnection`) or UI reaches the new methods. QuickBooks output is byte-identical (pinned). |
| **W04b** Web, flip, lab | `feature/7167-xero/wave-7171-b-web` | 9–11 (3 tasks) | payment badge provider (API + web), capability flip + real-DB proof, lab section 4 | The server contract is complete and proven; the flip is gated on lab X32, X34/X35 and X38. |

Merge order a → b. Each targets `main`; W04b is rebased after W04a merges. **Do not stack** (a stacked PR runs no CI).

No settings-rule-9 statement is needed: W04 adds no setting and moves none (it reads W02c's three settings).

---

## File structure

**Created**

| File | Responsibility | PR |
|---|---|---|
| `apps/api/src/services/accounting/accountingInvoicePushMessages.ts` (+ `.test.ts`) | Provider-labelled operator text of the invoice coordinator; QuickBooks byte-identical | a |
| `apps/api/src/services/accounting/accountingTaxAllocation.ts` (+ `.test.ts`) | Pure largest-remainder tax allocation in minor units | a |
| `apps/api/src/services/accounting/xeroInvoices.ts` (+ `.test.ts`) | Xero ACCREC wire mapping, pre-flight, reference lookup, push with adoption, re-push, void | a |
| `apps/api/src/__tests__/integration/accountingXeroInvoicePush.integration.test.ts` | Real-DB proof: push, adoption on retry, settings refusal, void, no payment fan-out | b |

**Modified:** see each task's **Files** block.

---

## Task 0: Baseline and interface re-verification (every PR starts here)

**Files:** none.

- [ ] **Step 1: Confirm the branch and preconditions**

```bash
cd <worktree>
git fetch origin main && git status -sb
git log origin/main --oneline | grep -iE 'xero w0[123]|#716[89]|#7170' | head -20
```

Expected: a clean tree on the W04 branch, based on current `origin/main`; W01 (4 PRs), W02 (a, b, c) and W03 (a, b) listed.

- [ ] **Step 2: Re-verify every assumption (M1–C8)**

```bash
cd apps/api/src
grep -n "pushInvoice(\|voidInvoice(\|interface AccountingInvoicePayload\|interface InvoicePushResult\|interface InvoiceVoidResult\|invoicePushPreflight" services/accounting/types.ts
grep -n "QuickBooks" services/accounting/accountingInvoicePush.ts | grep -v "^\s*[0-9]*:\s*//\|^\s*[0-9]*:\s*\*"
grep -n "PERSISTED_PREFLIGHT_CODES\|async function persistInvoicePreflightErrorInOwnContext\|async function markInvoiceMappingErrorInOwnContext\|function logProviderFault" services/accounting/accountingInvoicePush.ts
grep -n "const TERMINAL_CODES\|MAPPING_USER_RESOLVABLE_CODES\|terminal failure, not retrying" jobs/accountingSyncWorker.ts
grep -n "EXPECTED_CALL_SITES\|GUARDED_METHODS" services/accounting/accountingInvoicePushCallSites.test.ts
grep -rn "pushGeneration" services jobs routes | grep -v "\.test\." | grep -v "accountingPaymentPush\|quickbooksProvider\|types.ts"
grep -n "async function loadConnectedConnection" -A22 services/accounting/accountingPaymentPush.ts | grep -n "paymentPush"
grep -n "accountingSync: mapping && mapping.breezeOrigin" -A2 services/invoiceService.ts
grep -n "No connection\|!conn) { skipped" routes/accounting/index.ts
grep -n "export async function xeroApiGet\|export async function xeroApiWrite\|export function xeroIdempotencyKey\|export function xeroQuery\|export function parseXeroDate\|export function requireXeroBody\|export function xeroArray\|function allValidationMessages\|function apiKindFor\|export function xeroApiError\|export function classifyXeroValidation" services/accounting/xeroHttp.ts
grep -n "export const ACCOUNTING_REFUSAL_CODES\|export function refusalCodeOf\|export function providerPermissionMessage" services/accounting/accountingProviderError.ts
grep -n "export interface XeroItem\|async function readAllItems" services/accounting/xeroItems.ts
grep -n "function callContext\|notYet('invoice\|readonly capabilities" -A2 services/accounting/xeroProvider.ts
grep -n "xero: xeroProvider\|providerSupports('xero'" services/accounting/providerRegistry.ts services/accounting/providerRegistry.test.ts
grep -n "function providerRefusal\|case 'remote_missing'\|assertNever\|: never" services/accounting/accountingMappingService.ts | head
cd ../../web/src
grep -n "accountingSync?: {" -A3 components/billing/invoiceTypes.ts
grep -n "invoice-payment-qbosync\|syncProviderName =" components/billing/InvoiceDetail.tsx
ls ../../../docs/integrations/xero-demo-verification.md && grep -n "^## \|X31" ../../../docs/integrations/xero-demo-verification.md
```

Expected: every symbol found. The `QuickBooks` grep lists 13 lines: the 11 in M5 plus the doc comments at `:93` and `:150` (write any difference into the PR body). The `pushGeneration` grep prints nothing (refinement 2 — if it prints an invoice writer, stop and amend refinement 2). `loadConnectedConnection` contains `providerSupports(…, 'paymentPush')` (refinement 18 — if not, stop: flipping `invoicePush` would create Xero payment mappings). For each other difference, note it in the PR body and adapt the task that uses it.

- [ ] **Step 3: Record the baseline**

```bash
cd apps/api && npx vitest run src/services/accounting src/jobs/accountingSyncWorker.test.ts src/routes/accounting src/services/invoiceService.test.ts 2>&1 | tail -4
wc -l src/routes/accounting/index.ts src/services/accounting/accountingInvoicePush.ts src/services/accounting/xeroProvider.ts
```

Expected: all pass. Write down the `Test Files` count and the three line counts. `index.ts` must never exceed its count.

- [ ] **Step 4: File the manual-mode bulk-push issue (do not fix it here)**

While verifying M15, confirm this pre-existing behaviour: `POST /:provider/invoices/push-bulk` enqueues `push-invoice` jobs regardless of `push_mode`, and the worker drops every `push-invoice` job when `pushMode !== 'auto'` (`jobs/accountingSyncWorker.ts:305`). So in manual mode a bulk push reports `enqueued: N` and pushes nothing — for QuickBooks today, and for Xero after W04b.

```bash
grep -n "data.type === 'push-invoice' && resolution.conn.pushMode !== 'auto'" apps/api/src/jobs/accountingSyncWorker.ts
gh issue list --search "bulk push manual mode" --state open
```

If the line is present and no issue exists, file one (`gh issue create --title "Bulk invoice push is a silent no-op in manual push mode" --label bug`) with the two file references, and link it in the W04a PR body. W04 does not change it (QuickBooks behaviour, out of scope).

---

# PR W04a — Server (Xero `invoicePush` stays false)

### Task 1: Neutral seams — provider-labelled messages, preflight hook, push codes, `remote_locked`

**Files:**
- Create: `apps/api/src/services/accounting/accountingInvoicePushMessages.ts`, `accountingInvoicePushMessages.test.ts`
- Modify: `apps/api/src/services/accounting/accountingInvoicePushErrors.ts`
- Modify: `apps/api/src/services/accounting/types.ts` (`AccountingInvoicePreflightRefusal`, `AccountingProvider.invoicePushPreflight?`)
- Modify: `apps/api/src/services/accounting/accountingProviderError.ts` (`ACCOUNTING_REFUSAL_CODES`)
- Test: `types.test.ts`, `accountingProviderError.test.ts`

**Interfaces:**
- Consumes: M2, M5, M6, C4.
- Produces:
  ```ts
  // accountingInvoicePushMessages.ts
  export const invoicePushMessages: {
    notPushable(label: string): string;
    remoteDeleted(label: string): string;
    customerNotMapped(label: string): string;
    customerCurrencyMismatch(label: string, remoteCurrency: string, invoiceCurrency: string): string;
    customerSyncNoRemoteId(label: string): string;
    concurrentSync(label: string): string;
    persistNoRow(label: string, mappingId: string): string;
    recordFailed(label: string, remoteId: string): string;
    voidPushInFlight(label: string): string;
    remoteMissing(label: string): string;
    remoteAmbiguous(label: string): string;
    remoteLocked(label: string): string;
  };
  // accountingInvoicePushErrors.ts — AccountingInvoicePushErrorCode gains:
  //   'push_settings_incomplete' | 'remote_missing' | 'remote_ambiguous' | 'remote_locked' | 'provider_permission'
  // types.ts
  export interface AccountingInvoicePreflightRefusal { reason: 'settings' | 'totals'; message: string }
  // AccountingProvider gains (OPTIONAL; QuickBooks declares none):
  invoicePushPreflight?(
    conn: AccountingConnection,
    invoice: Pick<AccountingInvoicePayload, 'currencyCode' | 'taxTotal' | 'lines'>,
  ): AccountingInvoicePreflightRefusal | null;
  findRemoteInvoice?(conn: AccountingConnection, invoiceId: string): Promise<{ id: string; remoteVersion?: string } | null>;
  // accountingProviderError.ts — ACCOUNTING_REFUSAL_CODES gains 'remote_locked'
  ```

- [ ] **Step 1: Write the failing tests**

`accountingInvoicePushMessages.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { invoicePushMessages as m } from './accountingInvoicePushMessages';

describe('invoice push operator messages', () => {
  // Every string below is copied verbatim from accountingInvoicePush.ts on main
  // before Xero W04. QuickBooks operators must see byte-identical text.
  it.each<[string, string, string]>([
    ['notPushable', m.notPushable('QuickBooks'), 'Invoice must be issued and not void before it can be pushed to QuickBooks'],
    ['remoteDeleted', m.remoteDeleted('QuickBooks'), 'QuickBooks reports this invoice as deleted — pushing again would create a duplicate. Resolve it in QuickBooks, or unlink and re-map the invoice, before pushing again.'],
    ['customerNotMapped', m.customerNotMapped('QuickBooks'), 'This organization is not mapped to a QuickBooks customer yet — confirm or create a mapping first'],
    ['customerCurrencyMismatch', m.customerCurrencyMismatch('QuickBooks', 'CAD', 'USD'), "The QuickBooks customer for this organization is stamped in CAD, which does not match this invoice's USD currency"],
    ['customerSyncNoRemoteId', m.customerSyncNoRemoteId('QuickBooks'), 'QuickBooks customer sync did not return a remote id'],
    ['concurrentSync', m.concurrentSync('QuickBooks'), 'A concurrent QuickBooks sync for this invoice is already in progress; retry shortly'],
    ['persistNoRow', m.persistNoRow('QuickBooks', 'map-1'), 'persistInvoiceRemoteRef matched no accounting_entity_mappings row (id=map-1); refusing to lose the QuickBooks sync result'],
    ['recordFailed', m.recordFailed('QuickBooks', 'qb-9'), 'QuickBooks accepted the invoice sync (remote id qb-9) but Breeze failed to record it — do not retry; contact support to reconcile'],
    ['voidPushInFlight', m.voidPushInFlight('QuickBooks'), 'A QuickBooks push for this invoice is still in flight; the void will be retried once it completes'],
  ])('%s is byte-identical for QuickBooks', (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('labels every message by the provider it is given', () => {
    expect(m.customerNotMapped('Xero')).toBe('This organization is not mapped to a Xero customer yet — confirm or create a mapping first');
    expect(m.remoteDeleted('Xero')).not.toMatch(/QuickBooks/);
    expect(m.notPushable('Xero')).toBe('Invoice must be issued and not void before it can be pushed to Xero');
  });

  it('names the remedy for each Xero W04 refusal', () => {
    expect(m.remoteMissing('Xero')).toBe(
      'The Xero invoice for this invoice no longer exists or was voided there — pushing again cannot restore it. Check the invoice in Xero; to send it again, void and re-issue it in Breeze.',
    );
    expect(m.remoteAmbiguous('Xero')).toBe(
      'Xero holds more than one invoice for this Breeze invoice — void or delete the extra one in Xero, then push again',
    );
    expect(m.remoteLocked('Xero')).toBe(
      'Xero will not update this invoice because a payment or credit is applied to it there, and its amounts differ from Breeze — remove or unapply it in Xero, then push again',
    );
  });
});
```

Append to `types.test.ts` (add `AccountingInvoicePreflightRefusal` and `AccountingInvoicePayload` to its `./types` import if absent):

```ts
describe('invoice push preflight (Xero W04)', () => {
  it('declares an optional synchronous preflight', () => {
    expectTypeOf<AccountingProvider['invoicePushPreflight']>().toEqualTypeOf<
      | ((
        conn: AccountingConnection,
        invoice: Pick<AccountingInvoicePayload, 'currencyCode' | 'taxTotal' | 'lines'>,
      ) => AccountingInvoicePreflightRefusal | null)
      | undefined
    >();
  });
  it('declares an optional lookup of a pushed invoice by its Breeze id (refinement 22)', () => {
    expectTypeOf<AccountingProvider['findRemoteInvoice']>().toEqualTypeOf<
      ((conn: AccountingConnection, invoiceId: string) => Promise<{ id: string; remoteVersion?: string } | null>) | undefined
    >();
  });
  it('a refusal carries a reason and an operator message', () => {
    expectTypeOf<AccountingInvoicePreflightRefusal>().toEqualTypeOf<{ reason: 'settings' | 'totals'; message: string }>();
  });
});
```

Append to `accountingProviderError.test.ts`:

```ts
describe('remote_locked refusal code (Xero W04)', () => {
  it('is a neutral refusal code on a validation error', () => {
    expect(ACCOUNTING_REFUSAL_CODES).toContain('remote_locked');
    expect(refusalCodeOf(new AccountingProviderError({ kind: 'validation', provider: 'xero', operation: 'op', providerCode: 'remote_locked' })))
      .toBe('remote_locked');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingInvoicePushMessages.test.ts src/services/accounting/accountingProviderError.test.ts && npx tsc --noEmit -p .`
Expected: FAIL — vitest: `./accountingInvoicePushMessages` cannot be resolved; `remote_locked` is not in the list. tsc: the `expectTypeOf` pins fail (vitest does not typecheck them at runtime, so tsc is their red).

- [ ] **Step 3: Implement**

`accountingInvoicePushMessages.ts`:

```ts
/**
 * Operator-visible text of the invoice push/void coordinator
 * (`accountingInvoicePush.ts`), labelled by the provider's display name
 * (`accountingProviderDisplayName`) — Xero W04, W01d deferral R3. With the
 * label 'QuickBooks' every string is byte-identical to the literal it
 * replaced; accountingInvoicePushMessages.test.ts pins each one.
 */
export const invoicePushMessages = {
  notPushable: (label: string) =>
    `Invoice must be issued and not void before it can be pushed to ${label}`,
  remoteDeleted: (label: string) =>
    `${label} reports this invoice as deleted — pushing again would create a duplicate. Resolve it in ${label}, or unlink and re-map the invoice, before pushing again.`,
  customerNotMapped: (label: string) =>
    `This organization is not mapped to a ${label} customer yet — confirm or create a mapping first`,
  customerCurrencyMismatch: (label: string, remoteCurrency: string, invoiceCurrency: string) =>
    `The ${label} customer for this organization is stamped in ${remoteCurrency}, which does not match this invoice's ${invoiceCurrency} currency`,
  customerSyncNoRemoteId: (label: string) =>
    `${label} customer sync did not return a remote id`,
  concurrentSync: (label: string) =>
    `A concurrent ${label} sync for this invoice is already in progress; retry shortly`,
  persistNoRow: (label: string, mappingId: string) =>
    `persistInvoiceRemoteRef matched no accounting_entity_mappings row (id=${mappingId}); refusing to lose the ${label} sync result`,
  recordFailed: (label: string, remoteId: string) =>
    `${label} accepted the invoice sync (remote id ${remoteId}) but Breeze failed to record it — do not retry; contact support to reconcile`,
  voidPushInFlight: (label: string) =>
    `A ${label} push for this invoice is still in flight; the void will be retried once it completes`,
  // --- Xero W04 refusals (terminal; see accountingInvoicePush.ts `invoicePushRefusal`) ---
  remoteMissing: (label: string) =>
    `The ${label} invoice for this invoice no longer exists or was voided there — pushing again cannot restore it. Check the invoice in ${label}; to send it again, void and re-issue it in Breeze.`,
  remoteAmbiguous: (label: string) =>
    `${label} holds more than one invoice for this Breeze invoice — void or delete the extra one in ${label}, then push again`,
  remoteLocked: (label: string) =>
    `${label} will not update this invoice because a payment or credit is applied to it there, and its amounts differ from Breeze — remove or unapply it in ${label}, then push again`,
} as const;
```

`accountingInvoicePushErrors.ts` — insert before `| 'rate_limited'`:

```ts
  // Xero W04: the provider needs a connection setting that is not set (Xero: a
  // revenue account, or a tax rate for taxed / untaxed lines). Decided by the
  // provider's synchronous `invoicePushPreflight` in Phase 1 — before any
  // dependency sync, token refresh or provider call — and persisted on the
  // invoice's mapping row like `currency_mismatch`. Terminal: every retry would
  // refuse the same way until someone fills in the setting.
  | 'push_settings_incomplete'
  // Xero W04: the remote invoice this push would update is gone, or voided or
  // deleted there. Terminal — a push cannot resurrect it (Phase D decision 2).
  | 'remote_missing'
  // Xero W04: more than one live remote invoice carries this Breeze invoice's
  // adoption key. Terminal — never guess which one is ours.
  | 'remote_ambiguous'
  // Xero W04: the remote invoice exists but has a payment or credit applied, so
  // the provider will not change its lines, and its amounts differ. Terminal.
  | 'remote_locked'
  // Xero W04: the grant does not cover this call; reconnecting is the fix. Terminal.
  | 'provider_permission'
```

`types.ts` — add before `export interface AccountingProvider`:

```ts
/**
 * A provider's local refusal to push an invoice, decided without any I/O
 * (Xero W04). `settings` → the connection lacks a setting this provider needs
 * (coordinator code `push_settings_incomplete`); `totals` → Breeze's own
 * figures cannot be expressed to this provider (`invoice_totals_mismatch`).
 * `message` is operator-facing and persisted as the mapping's last_error.
 */
export interface AccountingInvoicePreflightRefusal {
  reason: 'settings' | 'totals';
  message: string;
}
```

and inside `AccountingProvider`, directly after `voidInvoice`:

```ts
  /**
   * OPTIONAL, synchronous, no I/O (Xero W04). Called by the invoice coordinator
   * in Phase 1 — after the currency and totals guards, before any dependency
   * sync, token refresh or provider call — with the exact line payloads it will
   * push. Null means "no objection". QuickBooks declares none.
   */
  invoicePushPreflight?(
    conn: AccountingConnection,
    invoice: Pick<AccountingInvoicePayload, 'currencyCode' | 'taxTotal' | 'lines'>,
  ): AccountingInvoicePreflightRefusal | null;
  /**
   * OPTIONAL (Xero W04, refinement 22). The remote invoice a push of this Breeze
   * invoice created, found by the provider's adoption key, or null. Lets a void
   * reach a create whose response was lost. A provider without an adoption key
   * for invoices (QuickBooks) declares none.
   */
  findRemoteInvoice?(conn: AccountingConnection, invoiceId: string): Promise<{ id: string; remoteVersion?: string } | null>;
```

`accountingProviderError.ts` — append `'remote_locked'` to `ACCOUNTING_REFUSAL_CODES` and add to its doc comment:

```ts
 *  - remote_locked      — the remote record exists but the provider will not change
 *                         it (Xero: an invoice with a payment or credit applied whose
 *                         content differs). Surfaced; never retried.
```

If `npx tsc` then reports W03's `providerRefusal` switch in `accountingMappingService.ts` as non-exhaustive (C7), add `case 'remote_locked': return null;` there — a contact or item write never raises it, so the mapping service keeps its generic handling.

- [ ] **Step 4: Run to verify they pass, then typecheck**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingInvoicePushMessages.test.ts src/services/accounting/accountingProviderError.test.ts src/services/accounting/types.test.ts src/services/accounting/accountingMappingService.test.ts && npx tsc --noEmit -p .`
Expected: PASS; tsc clean (the preflight is optional, so both providers still satisfy the interface).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/accounting/accountingInvoicePushMessages.ts apps/api/src/services/accounting/accountingInvoicePushMessages.test.ts apps/api/src/services/accounting/accountingInvoicePushErrors.ts apps/api/src/services/accounting/types.ts apps/api/src/services/accounting/types.test.ts apps/api/src/services/accounting/accountingProviderError.ts apps/api/src/services/accounting/accountingProviderError.test.ts apps/api/src/services/accounting/accountingMappingService.ts
git commit -m "feat(accounting): provider-labelled invoice push messages, preflight hook, push refusal codes (Xero W04)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Coordinator — labels, Phase 1 preflight, refusal mapping; worker terminal and quiet sets

**Files:**
- Modify: `apps/api/src/services/accounting/accountingInvoicePush.ts`
- Modify: `apps/api/src/jobs/accountingSyncWorker.ts` (`TERMINAL_CODES`, new `INVOICE_USER_RESOLVABLE_CODES`, the invoice-job catch)
- Test: `accountingInvoicePush.test.ts`, `jobs/accountingSyncWorker.test.ts`

**Interfaces:**
- Consumes: Task 1 (`invoicePushMessages`, the five codes, `invoicePushPreflight?`), C4 (`refusalCodeOf`, `providerPermissionMessage`), M3, M4, M8, M9.
- Produces (private to `accountingInvoicePush.ts`): `function invoicePushRefusal(err: unknown, label: string): { code: AccountingInvoicePushErrorCode; message: string } | null`. Behaviour: a Xero provider refusal on push becomes a 409 with the codes of refinement 14, persisted on the mapping row, no Sentry; `insufficient_scope` on a void becomes `provider_permission`; a void of an `error` row with no remote id asks `findRemoteInvoice` when the provider declares it (refinement 22).

- [ ] **Step 1: Write the failing tests**

In `accountingInvoicePush.test.ts`:

1. Make the mocked provider extensible. Add `providerExtras: {} as Record<string, unknown>` to the first `vi.hoisted` block's returned object (and to its destructured names), change the `./providerRegistry` mock's `getAccountingProvider` to `() => ({ pushInvoice: pushInvoiceMock, voidInvoice: voidInvoiceMock, ...providerExtras })`, and in the top-level `beforeEach` add `for (const k of Object.keys(providerExtras)) delete providerExtras[k];`.

2. Append:

```ts
describe('Xero W04: labels, preflight and provider refusals', () => {
  const xeroConn = (over: Record<string, unknown> = {}) => conn({ provider: 'xero', ...over });
  const refusal = (providerCode: string, kind: 'validation' | 'not_found' = 'validation') =>
    new AccountingProviderError({ kind, provider: 'xero', operation: 'Xero invoice push', httpStatus: kind === 'not_found' ? 404 : 400, providerCode });

  beforeEach(() => {
    resolveConnectionMock.mockResolvedValue(xeroConn());
    resolveLiveConnectionMock.mockResolvedValue(liveConn({ provider: 'xero' }));
  });

  it('labels coordinator refusals with the connection\'s provider', async () => {
    setup({ mappings: [] });
    await expect(pushInvoiceToAccounting(INVOICE, PARTNER, runCtx)).rejects.toMatchObject({
      code: 'customer_not_mapped',
      message: 'This organization is not mapped to a Xero customer yet — confirm or create a mapping first',
    });
  });

  it('a preflight settings refusal is persisted and stops before any sync, token refresh or provider call', async () => {
    const preflight = vi.fn(() => ({ reason: 'settings' as const, message: 'Choose a tax rate for non-taxable lines in Integrations → Accounting → Xero, then push again' }));
    providerExtras.invoicePushPreflight = preflight;
    setup({ lines: [{ taxable: false }] });

    await expect(pushInvoiceToAccounting(INVOICE, PARTNER, runCtx)).rejects.toMatchObject({
      code: 'push_settings_incomplete', status: 409,
      message: 'Choose a tax rate for non-taxable lines in Integrations → Accounting → Xero, then push again',
    });
    expect(preflight).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'xero' }),
      { currencyCode: 'USD', taxTotal: '7.00', lines: [expect.objectContaining({ invoiceLineId: 'line-1', lineTotal: '100.00', taxable: false })] },
    );
    expect(syncMappedEntityMock).not.toHaveBeenCalled();
    expect(resolveLiveConnectionMock).not.toHaveBeenCalled();
    expect(pushInvoiceMock).not.toHaveBeenCalled();
    const row = currentMappings.find((m) => m.breezeEntityType === 'invoice');
    expect(row).toMatchObject({ syncStatus: 'error', lastError: 'Choose a tax rate for non-taxable lines in Integrations → Accounting → Xero, then push again' });
  });

  it('a preflight totals refusal reuses invoice_totals_mismatch', async () => {
    providerExtras.invoicePushPreflight = () => ({ reason: 'totals' as const, message: 'no taxed line' });
    await expect(pushInvoiceToAccounting(INVOICE, PARTNER, runCtx)).rejects.toMatchObject({ code: 'invoice_totals_mismatch', status: 409, message: 'no taxed line' });
    expect(pushInvoiceMock).not.toHaveBeenCalled();
  });

  it('a provider without a preflight still pushes (QuickBooks regression guard)', async () => {
    resolveConnectionMock.mockResolvedValue(conn());
    resolveLiveConnectionMock.mockResolvedValue(liveConn());
    await expect(pushInvoiceToAccounting(INVOICE, PARTNER, runCtx)).resolves.toMatchObject({ syncStatus: 'synced' });
  });

  it.each<[string, 'validation' | 'not_found', string, string]>([
    ['remote_missing', 'not_found', 'remote_missing', 'The Xero invoice for this invoice no longer exists or was voided there — pushing again cannot restore it. Check the invoice in Xero; to send it again, void and re-issue it in Breeze.'],
    ['duplicate_key', 'validation', 'remote_ambiguous', 'Xero holds more than one invoice for this Breeze invoice — void or delete the extra one in Xero, then push again'],
    ['remote_locked', 'validation', 'remote_locked', 'Xero will not update this invoice because a payment or credit is applied to it there, and its amounts differ from Breeze — remove or unapply it in Xero, then push again'],
    ['insufficient_scope', 'validation', 'provider_permission', 'Xero did not grant Breeze access to this data — reconnect Xero and approve every requested permission'],
  ])('provider refusal %s → terminal %s, persisted, no Sentry', async (providerCode, kind, code, message) => {
    pushInvoiceMock.mockRejectedValueOnce(refusal(providerCode, kind));
    await expect(pushInvoiceToAccounting(INVOICE, PARTNER, runCtx)).rejects.toMatchObject({ code, status: 409, message });
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(currentMappings.find((m) => m.breezeEntityType === 'invoice')).toMatchObject({ syncStatus: 'error', lastError: message });
  });

  it('a QuickBooks validation fault (e.g. 6240) is still the retryable 502 with Sentry — QuickBooks unchanged', async () => {
    resolveConnectionMock.mockResolvedValue(conn());
    resolveLiveConnectionMock.mockResolvedValue(liveConn());
    pushInvoiceMock.mockRejectedValueOnce(new AccountingProviderError({ kind: 'validation', provider: 'quickbooks', operation: 'QuickBooks invoice push', httpStatus: 400, providerCode: '6240' }));
    await expect(pushInvoiceToAccounting(INVOICE, PARTNER, runCtx)).rejects.toMatchObject({ code: 'provider_error', status: 502, message: 'QuickBooks rejected the invoice sync (HTTP 400)' });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it('an insufficient_scope void is provider_permission; a payment_linked void keeps its existing message', async () => {
    setup({ mappings: [orgMappingRow(), { ...orgMappingRow({ id: 'map-inv-1', breezeEntityType: 'invoice', breezeEntityId: INVOICE, remoteEntityType: 'Invoice', remoteEntityId: 'xi-inv-1', remoteSyncToken: null }) }] });
    voidInvoiceMock.mockRejectedValueOnce(refusal('insufficient_scope'));
    await expect(voidInvoiceInAccounting(INVOICE, PARTNER, runCtx)).rejects.toMatchObject({ code: 'provider_permission', status: 409 });
    voidInvoiceMock.mockRejectedValueOnce(new AccountingProviderError({ kind: 'payment_linked', provider: 'xero', operation: 'Xero invoice void' }));
    await expect(voidInvoiceInAccounting(INVOICE, PARTNER, runCtx)).rejects.toMatchObject({
      code: 'void_blocked_by_payments',
      message: 'Xero will not void this invoice because a payment is applied to it there — remove or unapply that payment in Xero, then void the invoice again',
    });
  });

  describe('void of a create Breeze never recorded (refinement 22)', () => {
    const errorRow = () => orgMappingRow({
      id: 'map-inv-1', breezeEntityType: 'invoice', breezeEntityId: INVOICE, remoteEntityType: 'Invoice',
      remoteEntityId: null, remoteSyncToken: null, linkStatus: 'create_new', syncStatus: 'error', lastError: 'Xero rejected the invoice sync (HTTP 504)',
    });

    it('finds the invoice by its Breeze id with no DB context held, voids it, and records the remote id and version', async () => {
      const findRemoteInvoice = vi.fn(async () => {
        expect(ctx.depth).toBe(0);
        return { id: 'xi-lost', remoteVersion: 'v1' };
      });
      providerExtras.findRemoteInvoice = findRemoteInvoice;
      setup({ mappings: [orgMappingRow(), errorRow()] });
      voidInvoiceMock.mockResolvedValueOnce({ remoteVersion: 'v2' });

      await voidInvoiceInAccounting(INVOICE, PARTNER, runCtx);

      expect(findRemoteInvoice).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'fresh-token' }), INVOICE);
      expect(voidInvoiceMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ invoiceId: INVOICE }), { remoteEntityId: 'xi-lost', remoteSyncToken: 'v1' });
      expect(currentMappings.find((m) => m.id === 'map-inv-1')).toMatchObject({ remoteEntityId: 'xi-lost', remoteSyncToken: 'v2', linkStatus: 'confirmed' });
    });

    it('nothing found → no void call and no write (today\'s no-op)', async () => {
      providerExtras.findRemoteInvoice = vi.fn(async () => null);
      setup({ mappings: [orgMappingRow(), errorRow()] });
      await voidInvoiceInAccounting(INVOICE, PARTNER, runCtx);
      expect(voidInvoiceMock).not.toHaveBeenCalled();
      expect(updatedPatches).toHaveLength(0);
    });

    it('a provider without the lookup keeps today\'s no-op, with no token refresh (QuickBooks unchanged)', async () => {
      resolveConnectionMock.mockResolvedValue(conn());
      setup({ mappings: [orgMappingRow(), errorRow()] });
      await voidInvoiceInAccounting(INVOICE, PARTNER, runCtx);
      expect(resolveLiveConnectionMock).not.toHaveBeenCalled();
      expect(voidInvoiceMock).not.toHaveBeenCalled();
    });
  });
});
```

(`orgMappingRow` spreads its overrides, so the invoice row above is an invoice mapping with a Xero remote id; if the file's `MappingRow` type complains, build it with `remoteDeletedInvoiceMappingRow({ syncStatus: 'synced', lastError: null, remoteEntityId: 'xi-inv-1' })` instead.)

In `jobs/accountingSyncWorker.test.ts`, next to the existing `it.each(terminalCodes)` block (`:201`; it uses the same names — `getConnectionMock`, `connectionRow`, `pushInvoiceMock` (the mocked coordinator), `processAccountingSyncJob`, `INV_ID`, `PARTNER_ID`, `captureExceptionMock`). The connection setup is load-bearing: without it the worker drops the job before the coordinator runs, and the "not reported" cases would pass without reaching the new code.

```ts
it.each(['push_settings_incomplete', 'remote_missing', 'remote_locked', 'provider_permission'] as const)(
  'a %s push failure is terminal and not reported to Sentry (Xero W04)',
  async (code) => {
    getConnectionMock.mockResolvedValue(connectionRow());
    pushInvoiceMock.mockRejectedValue(new AccountingInvoicePushError(code, 409, 'user must act'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      processAccountingSyncJob({ type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID }),
    ).resolves.toBeUndefined();

    expect(pushInvoiceMock).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith('[AccountingSyncWorker] terminal failure, not retrying', expect.anything(), expect.anything(), `code=${code}`, 'user must act');
    expect(captureExceptionMock).not.toHaveBeenCalled();
    errSpy.mockRestore();
  },
);

it('remote_ambiguous is terminal and IS reported (it should never happen)', async () => {
  getConnectionMock.mockResolvedValue(connectionRow());
  pushInvoiceMock.mockRejectedValue(new AccountingInvoicePushError('remote_ambiguous', 409, 'two invoices'));
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  await expect(
    processAccountingSyncJob({ type: 'push-invoice', invoiceId: INV_ID, partnerId: PARTNER_ID }),
  ).resolves.toBeUndefined();

  expect(pushInvoiceMock).toHaveBeenCalledTimes(1);
  expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  errSpy.mockRestore();
});
```

Add the five new codes to the file's `terminalCodes` table only if it is meant to list every terminal code; its existing rows stay unedited (they still assert capture).

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingInvoicePush.test.ts src/jobs/accountingSyncWorker.test.ts`
Expected: FAIL — messages still say QuickBooks, the preflight is never called, refusals come back as `provider_error` 502, the worker rethrows the new codes.

- [ ] **Step 3: Implement the coordinator changes**

In `accountingInvoicePush.ts`:

a. Imports: add `import { invoicePushMessages } from './accountingInvoicePushMessages';` and extend the `./accountingProviderError` import with `providerPermissionMessage, refusalCodeOf`.

b. Replace each of the 11 literals (M5) with its message function. The label is `accountingProviderDisplayName(conn.provider)`:
   - in `pushInvoiceToAccounting` Phase 1, add `const label = accountingProviderDisplayName(conn.provider);` right after `resolveConnection`, and use it for `notPushable`, both `remoteDeleted` sites (Phase 1 and Phase 1b), `customerNotMapped`, `customerCurrencyMismatch(label, orgMapping.remoteCurrencyCode, inv.currencyCode)`; return `label` in `prep` — and add `label: string` to the explicit `let prep: { … }` annotation (`:676-683`), or `prep.label` fails with TS2339 — so the later sites (`customerSyncNoRemoteId`, `recordFailed(label, result.id)`) use it too;
   - `upsertInvoiceMappingPending` gains a `label: string` param (passed from Phase 1b) for `remoteDeleted(label)` and `concurrentSync(label)`;
   - `persistInvoiceRemoteRef` gains a `label: string` param for `persistNoRow(label, params.mappingId)`;
   - in `voidInvoiceInAccounting` Phase 1: `invoicePushMessages.voidPushInFlight(accountingProviderDisplayName(conn.provider))`.
   Keep `assertPushedLinesMatchSubtotal(inv, linePayloads, label)` using the same variable.

c. Phase 1 preflight — directly after `assertPushedLinesMatchSubtotal(…)`:

```ts
      // Xero W04: provider-specific refusals that need no I/O (a missing Xero
      // tax rate or revenue account; tax that cannot be placed on any line).
      // Same placement and persistence as the currency and totals guards: it
      // fires before any dependency sync, token refresh or provider call.
      // QuickBooks declares no preflight.
      const preflight = getAccountingProvider(conn.provider).invoicePushPreflight?.(conn, {
        currencyCode: inv.currencyCode, taxTotal: inv.taxTotal, lines: linePayloads,
      }) ?? null;
      if (preflight) {
        throw new AccountingInvoicePushError(
          preflight.reason === 'settings' ? 'push_settings_incomplete' : 'invoice_totals_mismatch',
          409,
          preflight.message,
        );
      }
```

and add `'push_settings_incomplete'` to `PERSISTED_PREFLIGHT_CODES` (update its doc comment: "…or `push_settings_incomplete` (Xero W04) pre-flight refusal…").

d. The refusal mapper — add above `pushInvoiceToAccounting`:

```ts
/**
 * Provider refusals the operator must resolve (Xero W04, refinement 14):
 * terminal 409s, persisted on the mapping row, never reported to Sentry.
 * Null for anything else. QuickBooks never sets these neutral codes on an
 * invoice (its providerCode is Intuit's numeric fault code), so its errors
 * keep the generic retryable handling below.
 */
function invoicePushRefusal(err: unknown, label: string): { code: AccountingInvoicePushErrorCode; message: string } | null {
  switch (refusalCodeOf(err)) {
    case 'remote_missing': return { code: 'remote_missing', message: invoicePushMessages.remoteMissing(label) };
    case 'duplicate_key': return { code: 'remote_ambiguous', message: invoicePushMessages.remoteAmbiguous(label) };
    case 'remote_locked': return { code: 'remote_locked', message: invoicePushMessages.remoteLocked(label) };
    case 'insufficient_scope': return { code: 'provider_permission', message: providerPermissionMessage(label) };
    default: return null;
  }
}
```

(If the switch trips an exhaustiveness lint on the other refusal codes, list them explicitly as `case 'duplicate_name': case 'remote_archived': return null;`.)

e. In the push `catch`, directly after the throttle branch and before the generic sanitize:

```ts
    const label = accountingProviderDisplayName(conn.provider);
    const refusal = invoicePushRefusal(err, label);
    if (refusal) {
      logProviderFault('pushInvoice', mappingRow.id, err);
      await markInvoiceMappingErrorInOwnContext(runInDbContext, mappingRow.id, partnerId, refusal.message);
      throw new AccountingInvoicePushError(refusal.code, 409, refusal.message, { cause: err });
    }
```

(Remove the now-duplicate `const label = …` line of the generic path, reusing this one.)

f. In the void `catch`, directly after the throttle branch:

```ts
    // Xero W04: a scope refusal is terminal. A missing remote invoice never
    // reaches here — the provider treats "already gone" as a successful void.
    if (refusalCodeOf(err) === 'insufficient_scope') {
      const message = providerPermissionMessage(accountingProviderDisplayName(conn.provider));
      logProviderFault('voidInvoice', mappingRow.id, err);
      await markInvoiceMappingErrorInOwnContext(runInDbContext, mappingRow.id, partnerId, message);
      throw new AccountingInvoicePushError('provider_permission', 409, message, { cause: err });
    }
```

g. Void of an unrecorded create (refinement 22). In `voidInvoiceInAccounting`'s Phase 1, replace the `return null;` that ends the no-remote-id branch (after the `pending` → `sync_in_progress` check) with:

```ts
      // Refinement 22: an `error` row can hide a create whose response AND
      // recovery lookup were lost. Only a provider that can find its invoice by
      // the Breeze id (Xero's Reference) is asked; QuickBooks keeps the no-op.
      if (mappingRow.syncStatus === 'error' && getAccountingProvider(conn.provider).findRemoteInvoice) {
        const inv = await loadOwnedInvoice(invoiceId, partnerId);
        return { conn, mappingRow, inv, recover: true };
      }
      return null;
```

and make the normal return `return { conn, mappingRow, inv, recover: false };`. After `liveConn`, build the seam from a `let` and move the lookup into the same guarded provider call, so a throttle or failure there is handled exactly like one from the void itself:

```ts
  let mappingSeam: AccountingEntityMappingSeam | null = prep.recover ? null : {
    remoteEntityId: mappingRow.remoteEntityId as string,
    remoteSyncToken: mappingRow.remoteSyncToken ?? null,
  };

  let voidResult: InvoiceVoidResult | null;
  try {
    voidResult = await runOutsideDbContext(async () => {
      if (!mappingSeam) {
        const found = await providerImpl.findRemoteInvoice!(liveConn, inv.id);
        if (!found) return null; // nothing in the provider: the no-op it always was
        mappingSeam = { remoteEntityId: found.id, remoteSyncToken: found.remoteVersion ?? null };
      }
      return providerImpl.voidInvoice(liveConn, voidPayload, mappingSeam);
    });
  } catch (err) {
    /* the existing catch, unchanged */
  }
  if (!voidResult || !mappingSeam) return;
```

Then, in place of the existing remote-version persist, when `prep.recover` write `{ remoteEntityId: mappingSeam.remoteEntityId, remoteSyncToken: voidResult.remoteVersion ?? mappingSeam.remoteSyncToken, linkStatus: 'confirmed', updatedAt: new Date() }` with the same partner-scoped `WHERE`, the same best-effort `try`/`captureException` and the same zero-row capture as the SyncToken persist; otherwise run the existing SyncToken persist unchanged. (`sync_status`/`last_error` stay as they were — the row still records why the push failed; the void does not change that, exactly as for a synced row.) The `voidInvoice` call count in this file stays 1 (M10).

- [ ] **Step 4: Implement the worker changes**

In `jobs/accountingSyncWorker.ts`, add the five codes to `TERMINAL_CODES` (after `'invoice_totals_mismatch'`), then add below it:

```ts
/**
 * Terminal invoice codes an operator resolves in Xero or in Breeze's settings
 * (Xero W04). Each is already persisted on the invoice's mapping row with the
 * remedy, so a Sentry event per job would only be noise. `remote_ambiguous`
 * is deliberately absent: two remote invoices for one Breeze invoice should be
 * impossible and deserves an alert. The pre-W04 terminal codes keep their
 * capture, so QuickBooks telemetry is unchanged.
 */
const INVOICE_USER_RESOLVABLE_CODES: ReadonlySet<AccountingInvoicePushErrorCode> = new Set([
  'push_settings_incomplete',
  'remote_missing',
  'remote_locked',
  'provider_permission',
]);
```

and in the invoice-job catch wrap the capture: `if (!INVOICE_USER_RESOLVABLE_CODES.has(err.code)) captureException(err, undefined, { … });` (the `console.error` line stays). Update the file-header comment's list of terminal codes with the five new ones.

- [ ] **Step 5: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingInvoicePush.test.ts src/jobs/accountingSyncWorker.test.ts src/routes/accounting/invoicePush.test.ts src/services/accounting/accountingInvoicePushMessages.test.ts && npx tsc --noEmit -p .`
Expected: PASS, with every pre-existing QuickBooks assertion unedited (`git diff origin/main -- '*.test.ts' | grep '^-' | grep -c QuickBooks` prints `0`).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/accounting/accountingInvoicePush.ts apps/api/src/services/accounting/accountingInvoicePush.test.ts apps/api/src/jobs/accountingSyncWorker.ts apps/api/src/jobs/accountingSyncWorker.test.ts
git commit -m "feat(accounting): invoice push preflight, provider-labelled messages and terminal Xero refusals (Xero W04)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: `accountingTaxAllocation.ts` — largest-remainder allocation in minor units

**Files:**
- Create: `apps/api/src/services/accounting/accountingTaxAllocation.ts`, `accountingTaxAllocation.test.ts`

**Interfaces:**
- Consumes: M16 (`minorUnitExponent`).
- Produces:
  ```ts
  export interface TaxAllocationLine { lineTotal: string; taxed: boolean }
  /** One decimal string per line (untaxed lines '0.00'; JPY '0'), summing exactly to taxTotal; null when it cannot be placed. */
  export function allocateInvoiceTax(taxTotal: string, lines: readonly TaxAllocationLine[], currencyCode: string): string[] | null;
  /** True when the decimal string is a zero amount ('0', '0.00', '-0.00'). Unreadable → false. */
  export function isZeroAmount(value: string): boolean;
  ```

Why neutral: the math is pure and provider-free (no literal, no I/O); a future per-line-tax provider reuses it. Only Xero calls it in W04.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { allocateInvoiceTax, isZeroAmount } from './accountingTaxAllocation';

const t = (lineTotal: string, taxed = true) => ({ lineTotal, taxed });
const cents = (v: string) => Math.round(Number(v) * 100);

describe('allocateInvoiceTax', () => {
  it('splits pro rata to line totals', () => {
    expect(allocateInvoiceTax('20.00', [t('100.00'), t('100.00')], 'GBP')).toEqual(['10.00', '10.00']);
  });

  it('gives the rounding cent to the largest remainder, earliest line on a tie', () => {
    // 10.00 over three equal lines: 3.333… each → remainders tie → first line gets the extra cent
    expect(allocateInvoiceTax('10.00', [t('1.00'), t('1.00'), t('1.00')], 'USD')).toEqual(['3.34', '3.33', '3.33']);
    // 1.00 over 1:2 → 0.333 / 0.666 → floors 0.33 + 0.66 = 0.99; the larger remainder (0.666…) takes the cent
    expect(allocateInvoiceTax('1.00', [t('10.00'), t('20.00')], 'USD')).toEqual(['0.33', '0.67']);
  });

  it('untaxed lines get zero and no weight', () => {
    expect(allocateInvoiceTax('7.00', [t('100.00'), t('50.00', false)], 'USD')).toEqual(['7.00', '0.00']);
  });

  it('a zero tax total allocates zero to every line (even taxed ones)', () => {
    expect(allocateInvoiceTax('0.00', [t('100.00'), t('0.00')], 'USD')).toEqual(['0.00', '0.00']);
  });

  it('works in whole units for a zero-decimal currency', () => {
    expect(allocateInvoiceTax('100', [t('1000.00'), t('1000.00'), t('1000.00')], 'JPY')).toEqual(['34', '33', '33']);
  });

  it('handles a negative (discount) taxed line', () => {
    expect(allocateInvoiceTax('18.00', [t('100.00'), t('-10.00')], 'GBP')).toEqual(['20.00', '-2.00']);
  });

  it('refuses when tax exists but no taxed line carries weight', () => {
    expect(allocateInvoiceTax('5.00', [t('100.00', false)], 'USD')).toBeNull();
    expect(allocateInvoiceTax('5.00', [t('0.00'), t('0.00')], 'USD')).toBeNull();
    expect(allocateInvoiceTax('5.00', [t('10.00'), t('-10.00')], 'USD')).toBeNull();
  });

  it('refuses unreadable or over-precise amounts (fail closed)', () => {
    expect(allocateInvoiceTax('abc', [t('1.00')], 'USD')).toBeNull();
    expect(allocateInvoiceTax('1.00', [t('1.005')], 'USD')).toBeNull();
    expect(allocateInvoiceTax('1.50', [t('1000.00')], 'JPY')).toBeNull(); // JPY tax must be whole
  });

  it('stays exact on very large invoices (no float, no 2^53 overflow)', () => {
    const out = allocateInvoiceTax('9999999999.99', [t('9999999999.99'), t('9999999999.99'), t('0.01')], 'USD');
    expect(out).not.toBeNull();
    const sum = out!.reduce((acc, v) => acc + BigInt(v.replace('.', '')), 0n);
    expect(sum).toBe(999999999999n);
  });

  it('property: shares always sum exactly to the tax total and stay within one minor unit of the exact pro-rata share', () => {
    let seed = 42;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    for (let run = 0; run < 500; run++) {
      const n = 1 + Math.floor(rand() * 8);
      const lines = Array.from({ length: n }, () => t((Math.floor(rand() * 500000) / 100).toFixed(2), rand() < 0.75));
      const weight = lines.filter((l) => l.taxed).reduce((a, l) => a + cents(l.lineTotal), 0);
      const tax = (Math.floor(rand() * 100000) / 100).toFixed(2);
      const out = allocateInvoiceTax(tax, lines, 'USD');
      if (weight === 0 && cents(tax) !== 0) { expect(out).toBeNull(); continue; }
      expect(out).not.toBeNull();
      expect(out!.reduce((a, v) => a + cents(v), 0)).toBe(cents(tax));
      out!.forEach((share, i) => {
        if (!lines[i]!.taxed) { expect(cents(share)).toBe(0); return; }
        const exact = weight === 0 ? 0 : (cents(tax) * cents(lines[i]!.lineTotal)) / weight;
        expect(Math.abs(cents(share) - exact)).toBeLessThan(1);
      });
    }
  });
});

describe('isZeroAmount', () => {
  it.each([['0', true], ['0.00', true], ['-0.00', true], ['0.01', false], ['', false], ['abc', false]] as const)('%s → %s', (v, expected) => {
    expect(isZeroAmount(v)).toBe(expected);
  });
});
```

(In the property test, `weight === 0` with `tax === 0` returns all zeros, which the sum check covers. The seeded LCG keeps the run deterministic.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingTaxAllocation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Spreads an invoice-level tax total over its lines (Xero W04, spec "Tax
 * allocation"). Breeze stores tax as ONE figure computed on the taxable,
 * customer-visible lines (invoiceMath.computeInvoiceTotals); a provider that
 * records tax per line needs each line's share, and the shares must sum to
 * exactly the figure the customer was billed.
 *
 * Method: pro rata to each taxed line's total, in the currency's MINOR unit
 * (cents; whole units for zero-decimal currencies), largest remainder, ties to
 * the earliest line. BigInt throughout, so neither float rounding nor a 2^53
 * overflow (tax × weight on a large invoice) can move a cent.
 *
 * Returns null — never a best guess — when the tax cannot be placed: a
 * non-zero tax with no taxed weight (or weights that net to zero), or an
 * amount that is unreadable or finer than the currency's minor unit.
 */
import { minorUnitExponent } from '@breeze/shared';

export interface TaxAllocationLine {
  lineTotal: string;
  /** The line carries tax (the caller decides: taxable AND the invoice's tax is non-zero). */
  taxed: boolean;
}

function toMinor(value: string, exp: 0 | 2): bigint | null {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return null;
  const frac = m[3] ?? '';
  if (/[1-9]/.test(frac.slice(exp))) return null; // finer than the currency's minor unit
  const minor = BigInt(`${m[2]}${frac.slice(0, exp).padEnd(exp, '0')}`);
  return m[1] ? -minor : minor;
}

function fromMinor(minor: bigint, exp: 0 | 2): string {
  const sign = minor < 0n ? '-' : '';
  const abs = minor < 0n ? -minor : minor;
  if (exp === 0) return `${sign}${abs}`;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** Floor division for BigInt (the `/` operator truncates toward zero). */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b !== 0n) && ((a < 0n) !== (b < 0n)) ? q - 1n : q;
}

export function isZeroAmount(value: string): boolean {
  return /^-?0+(?:\.0+)?$/.test(value.trim());
}

export function allocateInvoiceTax(
  taxTotal: string,
  lines: readonly TaxAllocationLine[],
  currencyCode: string,
): string[] | null {
  const exp = minorUnitExponent(currencyCode);
  const tax = toMinor(taxTotal, exp);
  // Line totals are numeric(12,2) in every currency; their scale only sets the weights.
  const weights = lines.map((l) => (l.taxed ? toMinor(l.lineTotal, 2) : 0n));
  if (tax === null || weights.some((w) => w === null)) return null;
  if (tax === 0n) return lines.map(() => fromMinor(0n, exp));

  const w = weights as bigint[];
  const total = w.reduce((a, b) => a + b, 0n);
  if (total === 0n) return null;

  // Normalise to a positive divisor; the math is sign-agnostic after that.
  const sign = total < 0n ? -1n : 1n;
  const divisor = total * sign;
  const floors = w.map((wi) => floorDiv(tax * wi * sign, divisor));
  const remainders = w.map((wi, i) => tax * wi * sign - floors[i]! * divisor);
  let left = tax - floors.reduce((a, b) => a + b, 0n); // 0 ≤ left < number of taxed lines
  const order = w
    .map((_, i) => i)
    .filter((i) => lines[i]!.taxed)
    .sort((a, b) => (remainders[b]! > remainders[a]! ? 1 : remainders[b]! < remainders[a]! ? -1 : a - b));
  const shares = [...floors];
  for (const i of order) {
    if (left <= 0n) break;
    shares[i] = shares[i]! + 1n;
    left -= 1n;
  }
  return shares.map((s) => fromMinor(s, exp));
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingTaxAllocation.test.ts src/services/accounting/neutralCore.guard.test.ts`
Expected: PASS (the guard sees no provider literal in the new file).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/accounting/accountingTaxAllocation.ts apps/api/src/services/accounting/accountingTaxAllocation.test.ts
git commit -m "feat(accounting): exact largest-remainder tax allocation in minor units (Xero W04)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `xeroHttp.ts` invoice refusal kinds; `xeroItems.ts` item refs

**Files:**
- Modify: `apps/api/src/services/accounting/xeroHttp.ts` (`classifyXeroInvoiceKind`, `apiKindFor`)
- Modify: `apps/api/src/services/accounting/xeroItems.ts` (`XeroItemRef`, `readXeroItemRefs`)
- Test: `xeroHttp.test.ts`, `xeroItems.test.ts`

**Interfaces:**
- Consumes: C1–C3, C5.
- Produces:
  ```ts
  // xeroHttp.ts
  export function classifyXeroInvoiceKind(text: string): 'duplicate_doc_number' | 'payment_linked' | 'transient' | undefined;
  // apiKindFor: a 400 whose messages match → that kind (else 'validation', unchanged)
  // xeroItems.ts
  export interface XeroItemRef { code: string; accountCode: string | null }
  export async function readXeroItemRefs(ctx: XeroCallContext): Promise<Map<string, XeroItemRef>>; // ItemID → ref
  ```

- [ ] **Step 1: Write the failing tests**

Append to `xeroHttp.test.ts` (reuse its `json`, `SPEC` helpers; add `classifyXeroInvoiceKind` to the file's existing `./xeroHttp` import — a second import of the same module is a duplicate declaration):

```ts
describe('classifyXeroInvoiceKind (Xero W04)', () => {
  const body = (...messages: string[]) => JSON.stringify({
    ErrorNumber: 10, Type: 'ValidationException', Message: 'A validation exception occurred',
    Elements: [{ ValidationErrors: messages.map((Message) => ({ Message })) }],
  });
  it.each([
    ['Invoice # must be unique.', 'duplicate_doc_number'],
    ['The status VOIDED cannot be applied to the invoice because it has payments or credit notes allocated to it.', 'payment_linked'],
    ['This document cannot be edited as it has a payment or credit note allocated to it.', 'payment_linked'],
    ['Idempotency Key: breeze-inv-abc is used with a different request.', 'transient'],
    ["Account code '999' is not a valid code for this document.", undefined],
  ] as const)('%s → %s', (message, expected) => {
    expect(classifyXeroInvoiceKind(body(message))).toBe(expected);
  });
  it('also reads a top-level Message (Xero may report key reuse outside Elements)', () => {
    expect(classifyXeroInvoiceKind(JSON.stringify({ Message: 'Idempotency Key: k is used with a different request.' }))).toBe('transient');
  });
  it('finds the verdict in any message', () => {
    expect(classifyXeroInvoiceKind(body('Email address must be valid.', 'Invoice # must be unique.'))).toBe('duplicate_doc_number');
  });
  it('is undefined for a non-JSON body', () => {
    expect(classifyXeroInvoiceKind('<html>')).toBeUndefined();
  });
});

describe('invoice refusals through the write helper (Xero W04)', () => {
  const ctx = { connectionId: 'c1', tenantId: 'ten-A', accessToken: 'at', rate: SPEC };
  const failing = (message: string) => json({ Elements: [{ ValidationErrors: [{ Message: message }] }] }, 400);

  it('a duplicate invoice number is kind duplicate_doc_number', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(failing('Invoice # must be unique.'));
    await expect(xeroApiWrite(ctx, 'PUT', 'Invoices', {}, 'Xero invoice create'))
      .rejects.toMatchObject({ kind: 'duplicate_doc_number', httpStatus: 400, providerCode: undefined });
  });
  it('a void refused for an allocated payment is kind payment_linked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(failing('The status VOIDED cannot be applied to the invoice because it has payments or credit notes allocated to it.'));
    await expect(xeroApiWrite(ctx, 'POST', 'Invoices/x', {}, 'Xero invoice void')).rejects.toMatchObject({ kind: 'payment_linked', httpStatus: 400 });
  });
  it('a reused key with a different body is an uncertain (transient) outcome, never a validation refusal (refinement 2)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(failing('Idempotency Key: breeze-inv-abc is used with a different request.'));
    await expect(xeroApiWrite(ctx, 'PUT', 'Invoices', {}, 'Xero invoice create', { idempotencyKey: 'breeze-inv-abc' }))
      .rejects.toMatchObject({ kind: 'transient', httpStatus: 400 });
  });
  it('W03 classifications are unchanged (a duplicate contact name stays validation + duplicate_name)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(failing('The contact name Acme is already assigned to another contact.'));
    await expect(xeroApiWrite(ctx, 'PUT', 'Contacts', {}, 'op')).rejects.toMatchObject({ kind: 'validation', providerCode: 'duplicate_name' });
  });
});
```

Append to `xeroItems.test.ts` (reuse its `ctx`, `json`, `urlOf` helpers and the rate-limit mock; add `readXeroItemRefs` to its `./xeroItems` import):

```ts
describe('readXeroItemRefs (Xero W04)', () => {
  it('maps ItemID to Code and the sales account, in one unpaged call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Items: [
      { ItemID: 'xi-1', Code: 'fw-100-3fa9c1b2d4', SalesDetails: { AccountCode: '200' } },
      { ItemID: 'xi-2', Code: 'MSP-OWN' },
      { ItemID: 'xi-3' },
      { Code: 'NO-ID' },
    ] }));
    const refs = await readXeroItemRefs(ctx);
    expect([...refs.entries()]).toEqual([
      ['xi-1', { code: 'fw-100-3fa9c1b2d4', accountCode: '200' }],
      ['xi-2', { code: 'MSP-OWN', accountCode: null }],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urlOf(fetchMock, 0)).toBe('https://api.xero.com/api.xro/2.0/Items?unitdp=4');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroHttp.test.ts src/services/accounting/xeroItems.test.ts`
Expected: FAIL — `classifyXeroInvoiceKind` / `readXeroItemRefs` are not exported; the two 400s come back as `validation`.

- [ ] **Step 3: Implement**

In `xeroHttp.ts`, after `classifyXeroValidation`:

```ts
/**
 * 400s that are not plain validation refusals (Xero W04):
 *  - duplicate_doc_number — Xero's OpenAPI example text "Invoice # must be unique."
 *    The provider absorbs it (adoption look, then one numberless retry).
 *  - payment_linked — a void (or a line edit) refused because a payment or credit
 *    note is allocated. Texts reported by Xero integrators; lab X39 confirms.
 *  - transient — "Idempotency Key: … is used with a different request." The same
 *    request identity was sent earlier with other bytes (a concurrent push, or a
 *    settings change inside the 6-minute window): an UNCERTAIN outcome, so the
 *    caller looks again instead of treating it as a refusal (refinement 2).
 * Runs over every validation message, untruncated, and the top-level Message.
 */
export function classifyXeroInvoiceKind(text: string): 'duplicate_doc_number' | 'payment_linked' | 'transient' | undefined {
  let topLevel: string | null = null;
  try {
    const parsed = JSON.parse(text) as { Message?: unknown } | null;
    topLevel = typeof parsed?.Message === 'string' ? parsed.Message : null;
  } catch { /* not JSON: no verdict from the top level */ }
  for (const message of [...allValidationMessages(text), ...(topLevel ? [topLevel] : [])]) {
    if (/^Invoice # must be unique/i.test(message)) return 'duplicate_doc_number';
    if (/(has|have) (payments? or credit notes?|a payment or credit note) allocated/i.test(message)) return 'payment_linked';
    if (/^Idempotency Key: .* is used with a different request/i.test(message)) return 'transient';
  }
  return undefined;
}
```

Give `apiKindFor` the body text and consult it for a 400 (update its one caller in `xeroApiError` to `apiKindFor(status, headers, text)`):

```ts
function apiKindFor(status: number, headers: Headers, text: string): AccountingProviderErrorKind {
  if (status === 429) return 'rate_limited';
  if ((status === 401 || status === 403) && INSUFFICIENT_SCOPE_RE.test(headers.get('www-authenticate') ?? '')) return 'validation';
  if (status === 400) return classifyXeroInvoiceKind(text) ?? 'validation';
  if (status === 404) return 'not_found';
  return 'transient'; // 401/403 (link removed), 5xx, anything else
}
```

`xeroApiError`'s `providerCode` expression is unchanged: it sets a refusal code only when `kind === 'validation'`, so the three new outcomes carry none. The key-reuse `transient` affects W03 writes too, correctly: W03's contact/item creates already treat `transient` as "look again".

In `xeroItems.ts`, after `listXeroItems`:

```ts
/** What an invoice line needs from a mapped item: its Code, and its sales account if it has one (Xero W04). */
export interface XeroItemRef { code: string; accountCode: string | null }

/**
 * ItemID → { Code, SalesDetails.AccountCode } for the whole price list, in one
 * unpaged call (Xero W04). The mapping row stores Xero's ItemID; an invoice
 * line takes ItemCode. Items without an ItemID or a Code are skipped.
 */
export async function readXeroItemRefs(ctx: XeroCallContext): Promise<Map<string, XeroItemRef>> {
  const refs = new Map<string, XeroItemRef>();
  for (const item of await readAllItems(ctx, 'Xero item codes')) {
    if (item.ItemID && item.Code) refs.set(item.ItemID, { code: item.Code, accountCode: item.SalesDetails?.AccountCode ?? null });
  }
  return refs;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroHttp.test.ts src/services/accounting/xeroItems.test.ts src/services/accounting/xeroContacts.test.ts src/services/accounting/xeroProvider.test.ts && npx tsc --noEmit -p .`
Expected: PASS — the W02/W03 tests are unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/accounting/xeroHttp.ts apps/api/src/services/accounting/xeroHttp.test.ts apps/api/src/services/accounting/xeroItems.ts apps/api/src/services/accounting/xeroItems.test.ts
git commit -m "feat(accounting): Xero invoice refusal kinds and item code lookup (Xero W04)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `xeroInvoices.ts` — pre-flight, exact line amounts, request body, result mapping

**Files:**
- Create: `apps/api/src/services/accounting/xeroInvoices.ts`, `xeroInvoices.test.ts`

**Interfaces:**
- Consumes: Task 1 (`AccountingInvoicePreflightRefusal`), Task 3 (`allocateInvoiceTax`, `isZeroAmount`), Task 4 (`XeroItemRef`), M2, C2 (`parseXeroDate`).
- Produces (`xeroInvoices.ts`):
  ```ts
  export const XERO_INVOICE_REFERENCE_PREFIX = 'breeze:';
  export const XERO_SEND_LINE_TAX_AMOUNT: boolean;               // true; lab X34/X35 may flip it (refinement 5)
  export function xeroInvoiceReference(invoiceId: string): string;
  export type XeroInvoiceSettings = Pick<AccountingConnection, 'defaultIncomeAccountRef' | 'defaultTaxCodeRef' | 'defaultExemptTaxCodeRef'>;
  export interface XeroInvoiceLine { Description: string; Quantity: number; UnitAmount: number; AccountCode: string; TaxType: string; TaxAmount?: number; ItemCode?: string }
  export interface XeroInvoice { InvoiceID?; Type?; InvoiceNumber?; Reference?; Status?; Contact?: { ContactID? }; Date?; DueDate?;
    CurrencyCode?; LineAmountTypes?; LineItems?: XeroInvoiceLine[]; SubTotal?: number; TotalTax?: number; Total?: number;
    AmountPaid?: number; AmountCredited?: number; UpdatedDateUTC?; HasErrors?: boolean; ValidationErrors?: Array<{ Message?: string }> }
  export function xeroInvoicePreflight(conn: XeroInvoiceSettings, invoice: Pick<AccountingInvoicePayload, 'currencyCode' | 'taxTotal' | 'lines'>): AccountingInvoicePreflightRefusal | null;
  export function xeroLineAmounts(line: Pick<AccountingInvoiceLinePayload, 'description' | 'quantity' | 'unitPrice' | 'lineTotal'>): { Description: string; Quantity: number; UnitAmount: number };
  export function buildXeroInvoice(invoice: AccountingInvoicePayload, lineMappings: readonly AccountingInvoiceLineMapping[],
    items: ReadonlyMap<string, XeroItemRef>, conn: XeroInvoiceSettings, opts: { includeNumber: boolean; sendLineTax?: boolean }): XeroInvoice;
  export function toXeroPushResult(invoice: XeroInvoice | undefined, operation: string): InvoicePushResult;
  ```

- [ ] **Step 1: Write the failing tests**

`xeroInvoices.test.ts` (this task's part; Tasks 6–7 append to the same file):

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

const { slotMock } = vi.hoisted(() => ({
  slotMock: vi.fn((_p: unknown, _s: unknown, _c: unknown, fn: () => unknown) => fn()),
}));
vi.mock('./accountingRateLimit', async (orig) => ({
  ...(await orig<typeof import('./accountingRateLimit')>()),
  withProviderCallSlot: slotMock,
  noteDailyRemaining: vi.fn(async () => {}),
}));

import {
  buildXeroInvoice, toXeroPushResult, xeroInvoicePreflight, xeroInvoiceReference, xeroLineAmounts,
} from './xeroInvoices';
import type { AccountingInvoiceLinePayload, AccountingInvoicePayload } from './types';

const INVOICE = '0f0e0d0c-0b0a-4908-8706-050403020100';
const SETTINGS = { defaultIncomeAccountRef: '200', defaultTaxCodeRef: 'OUTPUT2', defaultExemptTaxCodeRef: 'EXEMPTOUTPUT' } as {
  defaultIncomeAccountRef: string | null; defaultTaxCodeRef: string | null; defaultExemptTaxCodeRef: string | null;
};
const line = (over: Partial<AccountingInvoiceLinePayload> = {}): AccountingInvoiceLinePayload => ({
  invoiceLineId: 'l1', description: 'Managed Firewall', quantity: '1.00', unitPrice: '100.00', lineTotal: '100.00', taxable: true, ...over,
});
const invoice = (over: Partial<AccountingInvoicePayload> = {}): AccountingInvoicePayload => ({
  invoiceId: INVOICE, docNumber: 'INV-2026-0001', txnDate: '2026-09-01', dueDate: '2026-10-01',
  customerRef: { id: 'xc-1' }, currencyCode: 'GBP', subtotal: '100.00', taxTotal: '20.00', total: '120.00',
  lines: [line()], mapping: null, ...over,
});

/** The value a synchronous call throws (fails the test if it returns). */
function thrown(fn: () => unknown): unknown {
  try { fn(); } catch (err) { return err; }
  throw new Error('expected the call to throw');
}

afterEach(() => { vi.restoreAllMocks(); slotMock.mockClear(); });

describe('xeroInvoicePreflight', () => {
  it('passes a fully configured connection', () => {
    expect(xeroInvoicePreflight(SETTINGS, invoice())).toBeNull();
  });

  it.each<[string, Partial<typeof SETTINGS>, AccountingInvoiceLinePayload[], string]>([
    ['no revenue account', { defaultIncomeAccountRef: null }, [line()], 'Choose a revenue account in Integrations → Accounting → Xero, then push again'],
    ['taxed line without a tax rate', { defaultTaxCodeRef: null }, [line()], 'Choose a tax rate for taxable lines in Integrations → Accounting → Xero, then push again'],
    ['untaxed line without an exempt rate', { defaultExemptTaxCodeRef: null }, [line(), line({ invoiceLineId: 'l2', taxable: false })], 'Choose a tax rate for non-taxable lines in Integrations → Accounting → Xero, then push again'],
    ['everything missing', { defaultIncomeAccountRef: null, defaultTaxCodeRef: null, defaultExemptTaxCodeRef: null }, [line(), line({ invoiceLineId: 'l2', taxable: false })], 'Choose a revenue account, a tax rate for taxable lines and a tax rate for non-taxable lines in Integrations → Accounting → Xero, then push again'],
  ])('%s → settings refusal', (_name, settings, lines, message) => {
    expect(xeroInvoicePreflight({ ...SETTINGS, ...settings }, invoice({ lines })))
      .toEqual({ reason: 'settings', message });
  });

  it('a zero-tax invoice needs only the exempt rate, even for lines flagged taxable (refinement 4)', () => {
    expect(xeroInvoicePreflight({ ...SETTINGS, defaultTaxCodeRef: null }, invoice({ taxTotal: '0.00', total: '100.00' }))).toBeNull();
    expect(xeroInvoicePreflight({ ...SETTINGS, defaultExemptTaxCodeRef: null }, invoice({ taxTotal: '0.00', total: '100.00' })))
      .toEqual({ reason: 'settings', message: 'Choose a tax rate for non-taxable lines in Integrations → Accounting → Xero, then push again' });
  });

  it('tax with no taxed weight is a totals refusal', () => {
    expect(xeroInvoicePreflight(SETTINGS, invoice({ lines: [line({ taxable: false })] }))).toEqual({
      reason: 'totals',
      message: 'This invoice records 20.00 of tax, but none of its taxable lines carries an amount, so Xero cannot place that tax on a line. Review the invoice lines and tax, then push again.',
    });
  });
});

describe('xeroLineAmounts (refinement 3)', () => {
  it.each<[string, Partial<AccountingInvoiceLinePayload>, { Description: string; Quantity: number; UnitAmount: number }]>([
    ['exact product → as stored', { quantity: '2.00', unitPrice: '12.50', lineTotal: '25.00' }, { Description: 'Managed Firewall', Quantity: 2, UnitAmount: 12.5 }],
    ['rounded product, exact 4dp unit → quantity kept, 4dp unit', { quantity: '4.00', unitPrice: '0.33', lineTotal: '1.33' }, { Description: 'Managed Firewall', Quantity: 4, UnitAmount: 0.3325 }],
    ['1.5 × 10.95 = 16.425 → half-up 16.43, no exact 4dp unit → quantity 1', { quantity: '1.50', unitPrice: '10.95', lineTotal: '16.43' }, { Description: 'Managed Firewall (1.50 × 10.95)', Quantity: 1, UnitAmount: 16.43 }],
    ['hidden/bundle line: price but zero total → unit 0', { quantity: '2.00', unitPrice: '40.00', lineTotal: '0.00' }, { Description: 'Managed Firewall', Quantity: 2, UnitAmount: 0 }],
    ['zero quantity with a total → quantity 1', { quantity: '0.00', unitPrice: '5.00', lineTotal: '5.00' }, { Description: 'Managed Firewall (0.00 × 5.00)', Quantity: 1, UnitAmount: 5 }],
    ['negative discount line', { quantity: '1.00', unitPrice: '-10.00', lineTotal: '-10.00' }, { Description: 'Managed Firewall', Quantity: 1, UnitAmount: -10 }],
    ['empty description gets a placeholder', { description: '  ' }, { Description: 'Invoice line', Quantity: 1, UnitAmount: 100 }],
  ])('%s', (_name, over, expected) => {
    expect(xeroLineAmounts(line(over))).toEqual(expected);
  });

  it("never exceeds Xero's 4000-character description", () => {
    expect(xeroLineAmounts(line({ description: 'x'.repeat(5000), quantity: '1.50', unitPrice: '10.95', lineTotal: '16.43' })).Description).toHaveLength(4000);
  });
});

describe('buildXeroInvoice', () => {
  it('maps the spec table: ACCREC, AUTHORISED, Exclusive, Reference, DueDate, CurrencyCode, per-line account, tax type and allocated tax', () => {
    const body = buildXeroInvoice(
      invoice({ lines: [line(), line({ invoiceLineId: 'l2', description: 'Setup', taxable: false, lineTotal: '50.00', unitPrice: '50.00' })], subtotal: '150.00', total: '170.00' }),
      [{ invoiceLineId: 'l1', remoteItemRef: { id: 'xi-1' } }, { invoiceLineId: 'l2', remoteItemRef: null }],
      new Map([['xi-1', { code: 'fw-100-3fa9c1b2d4', accountCode: '210' }]]),
      SETTINGS,
      { includeNumber: true },
    );
    expect(body).toEqual({
      Type: 'ACCREC',
      Contact: { ContactID: 'xc-1' },
      Date: '2026-09-01',
      DueDate: '2026-10-01',
      InvoiceNumber: 'INV-2026-0001',
      Reference: `breeze:${INVOICE}`,
      CurrencyCode: 'GBP',
      Status: 'AUTHORISED',
      LineAmountTypes: 'Exclusive',
      LineItems: [
        { Description: 'Managed Firewall', Quantity: 1, UnitAmount: 100, AccountCode: '210', TaxType: 'OUTPUT2', TaxAmount: 20, ItemCode: 'fw-100-3fa9c1b2d4' },
        { Description: 'Setup', Quantity: 1, UnitAmount: 50, AccountCode: '200', TaxType: 'EXEMPTOUTPUT', TaxAmount: 0 },
      ],
    });
    expect(body.LineItems?.every((l) => !('LineAmount' in l))).toBe(true);
  });

  it('the without-number variant omits InvoiceNumber only', () => {
    const withNo = buildXeroInvoice(invoice(), [], new Map(), SETTINGS, { includeNumber: true });
    const without = buildXeroInvoice(invoice(), [], new Map(), SETTINGS, { includeNumber: false });
    expect(without).not.toHaveProperty('InvoiceNumber');
    expect({ ...without, InvoiceNumber: 'INV-2026-0001' }).toEqual(withNo);
  });

  it('DueDate falls back to the invoice date', () => {
    expect(buildXeroInvoice(invoice({ dueDate: null }), [], new Map(), SETTINGS, { includeNumber: true }).DueDate).toBe('2026-09-01');
  });

  it('a mapped item missing from Xero is sent without ItemCode, on the default account (refinement 12)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = buildXeroInvoice(invoice(), [{ invoiceLineId: 'l1', remoteItemRef: { id: 'xi-gone' } }], new Map(), SETTINGS, { includeNumber: true });
    expect(body.LineItems?.[0]).toEqual({ Description: 'Managed Firewall', Quantity: 1, UnitAmount: 100, AccountCode: '200', TaxType: 'OUTPUT2', TaxAmount: 20 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('xi-gone'));
  });

  it('a zero-tax invoice puts every line on the exempt rate (refinement 4)', () => {
    const body = buildXeroInvoice(invoice({ taxTotal: '0.00', total: '100.00' }), [], new Map(), SETTINGS, { includeNumber: true });
    expect(body.LineItems?.[0]).toMatchObject({ TaxType: 'EXEMPTOUTPUT', TaxAmount: 0 });
  });

  it('with the override off, TaxAmount is omitted and Xero calculates (refinement 5 fallback)', () => {
    const body = buildXeroInvoice(invoice(), [], new Map(), SETTINGS, { includeNumber: true, sendLineTax: false });
    expect(body.LineItems?.[0]).not.toHaveProperty('TaxAmount');
    expect(body.LineItems?.[0]).toMatchObject({ TaxType: 'OUTPUT2' });
  });

  it('refuses (validation) when called without the settings the preflight requires', () => {
    expect(thrown(() => buildXeroInvoice(invoice(), [], new Map(), { ...SETTINGS, defaultTaxCodeRef: null }, { includeNumber: true })))
      .toMatchObject({ kind: 'validation', provider: 'xero' });
  });
});

describe('toXeroPushResult', () => {
  it('maps id, number, version and both totals as 2dp strings', () => {
    expect(toXeroPushResult({
      InvoiceID: 'xi-9', InvoiceNumber: 'INV-2026-0001', Status: 'AUTHORISED', TotalTax: 20, Total: 120,
      UpdatedDateUTC: '/Date(1790000000000+0000)/',
    }, 'Xero invoice create')).toEqual({
      id: 'xi-9', docNumber: 'INV-2026-0001', remoteVersion: new Date(1790000000000).toISOString(),
      remoteTaxTotal: '20.00', remoteTotal: '120.00',
    });
  });
  it('null totals when Xero omits them (the drift check then skips)', () => {
    expect(toXeroPushResult({ InvoiceID: 'xi-9' }, 'op')).toEqual({ id: 'xi-9', remoteTaxTotal: null, remoteTotal: null });
  });
  it('an element with HasErrors is a validation failure carrying the first message (refinement 13)', () => {
    expect(thrown(() => toXeroPushResult({ InvoiceID: 'xi-9', HasErrors: true, ValidationErrors: [{ Message: 'Account code is invalid' }] }, 'Xero invoice create')))
      .toMatchObject({ kind: 'validation', providerMessage: 'Account code is invalid' });
  });
  it('no InvoiceID is a transient failure (the caller re-looks before any retry)', () => {
    expect(thrown(() => toXeroPushResult(undefined, 'Xero invoice create'))).toMatchObject({ kind: 'transient' });
  });
  it('the reference is breeze:<invoiceId>', () => {
    expect(xeroInvoiceReference(INVOICE)).toBe(`breeze:${INVOICE}`);
  });
});
```

(The "4 × 0.33" row: 4 × 0.33 = 1.32 ≠ 1.33, and 1.33 ÷ 4 = 0.3325 is exact at 4 places. The "1.5 × 10.95" row: 16.43 ÷ 1.5 = 10.9533… is not exact, so it falls to quantity 1.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroInvoices.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Xero sales invoices (ACCREC) for invoice push and void (Xero W04). Owns these
 * refinements of plan 2026-09-27-xero-w04-invoice-push-void.md:
 *   3  each line's exact amount, never Xero's rounding
 *   4  "taxed" = taxable AND the invoice's tax is non-zero
 *   5  per-line TaxAmount from accountingTaxAllocation (switchable)
 *   6  the synchronous pre-flight
 *   12 ItemCode plus the item's own sales account; a missing item is not fatal
 *   13 summarizeErrors=true, and a HasErrors element is a failure
 * The I/O half (lookup, push, re-push, void) follows the pure half.
 */
import { AccountingProviderError } from './accountingProviderError';
import { allocateInvoiceTax, isZeroAmount } from './accountingTaxAllocation';
import { parseXeroDate } from './xeroHttp';
import type { XeroItemRef } from './xeroItems';
import type { AccountingConnection } from './accountingConnectionService';
import type {
  AccountingInvoiceLineMapping, AccountingInvoiceLinePayload, AccountingInvoicePayload, AccountingInvoicePreflightRefusal,
  InvoicePushResult,
} from './types';

export const XERO_INVOICE_REFERENCE_PREFIX = 'breeze:';
/**
 * Send the allocated tax per line (spec W04 "Tax allocation"). Lab X34/X35
 * settles spec open item 1; if Xero rejects overrides, set this to false:
 * Xero then calculates, and the post-push drift check flags any difference.
 */
export const XERO_SEND_LINE_TAX_AMOUNT = true;
const DESCRIPTION_MAX = 4000;
const EMPTY_DESCRIPTION = 'Invoice line';
const SETTINGS_HOME = 'Integrations → Accounting → Xero';

export type XeroInvoiceSettings = Pick<AccountingConnection, 'defaultIncomeAccountRef' | 'defaultTaxCodeRef' | 'defaultExemptTaxCodeRef'>;

export interface XeroInvoiceLine {
  Description: string; Quantity: number; UnitAmount: number; AccountCode: string; TaxType: string;
  TaxAmount?: number; ItemCode?: string;
}

export interface XeroInvoice {
  InvoiceID?: string; Type?: string; InvoiceNumber?: string; Reference?: string; Status?: string;
  Contact?: { ContactID?: string }; Date?: string; DueDate?: string; CurrencyCode?: string; LineAmountTypes?: string;
  LineItems?: XeroInvoiceLine[]; SubTotal?: number; TotalTax?: number; Total?: number;
  AmountPaid?: number; AmountCredited?: number; UpdatedDateUTC?: string;
  HasErrors?: boolean; ValidationErrors?: Array<{ Message?: string }>;
}

export function xeroInvoiceReference(invoiceId: string): string {
  return `${XERO_INVOICE_REFERENCE_PREFIX}${invoiceId}`;
}

function validation(operation: string, message: string, providerMessage?: string): AccountingProviderError {
  return new AccountingProviderError({ kind: 'validation', provider: 'xero', operation, message, providerMessage });
}

/** Refinement 4: a line is taxed only if it is taxable AND the invoice actually carries tax. */
function taxedFlags(invoice: Pick<AccountingInvoicePayload, 'taxTotal' | 'lines'>): boolean[] {
  const invoiceTaxed = !isZeroAmount(invoice.taxTotal);
  return invoice.lines.map((l) => l.taxable && invoiceTaxed);
}

function taxShares(invoice: Pick<AccountingInvoicePayload, 'currencyCode' | 'taxTotal' | 'lines'>, taxed: boolean[]): string[] | null {
  return allocateInvoiceTax(invoice.taxTotal, invoice.lines.map((l, i) => ({ lineTotal: l.lineTotal, taxed: taxed[i]! })), invoice.currencyCode);
}

function joinList(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function xeroInvoicePreflight(
  conn: XeroInvoiceSettings,
  invoice: Pick<AccountingInvoicePayload, 'currencyCode' | 'taxTotal' | 'lines'>,
): AccountingInvoicePreflightRefusal | null {
  const taxed = taxedFlags(invoice);
  if (!taxShares(invoice, taxed)) {
    return {
      reason: 'totals',
      message: `This invoice records ${invoice.taxTotal} of tax, but none of its taxable lines carries an amount, so Xero cannot place that tax on a line. Review the invoice lines and tax, then push again.`,
    };
  }
  const missing: string[] = [];
  if (!conn.defaultIncomeAccountRef) missing.push('a revenue account');
  if (taxed.some(Boolean) && !conn.defaultTaxCodeRef) missing.push('a tax rate for taxable lines');
  if (taxed.some((t) => !t) && !conn.defaultExemptTaxCodeRef) missing.push('a tax rate for non-taxable lines');
  return missing.length
    ? { reason: 'settings', message: `Choose ${joinList(missing)} in ${SETTINGS_HOME}, then push again` }
    : null;
}

/** Exact scaled integer of a decimal string (no significant digit past `scale`), else null. */
function scaled(value: string, scale: number): bigint | null {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return null;
  const frac = m[3] ?? '';
  if (/[1-9]/.test(frac.slice(scale))) return null;
  const n = BigInt(`${m[2]}${frac.slice(0, scale).padEnd(scale, '0')}`);
  return m[1] ? -n : n;
}

function unscaled(n: bigint, scale: number): number {
  return Number(n) / 10 ** scale;
}

function description(text: string, suffix = ''): string {
  const base = text.trim() || EMPTY_DESCRIPTION;
  return `${base.slice(0, DESCRIPTION_MAX - suffix.length)}${suffix}`;
}

/**
 * Refinement 3: Quantity and UnitAmount whose product is EXACTLY the Breeze
 * line total, so Xero's LineAmount can never differ through its own rounding.
 */
export function xeroLineAmounts(
  line: Pick<AccountingInvoiceLinePayload, 'description' | 'quantity' | 'unitPrice' | 'lineTotal'>,
): { Description: string; Quantity: number; UnitAmount: number } {
  const q = scaled(line.quantity, 4);  // 1e-4 units
  const u = scaled(line.unitPrice, 4); // 1e-4 units
  const t = scaled(line.lineTotal, 2); // cents
  if (t !== null && q !== null) {
    const target = t * 1_000_000n;     // cents → 1e-8 units, the scale of q × u
    if (u !== null && q * u === target) {
      return { Description: description(line.description), Quantity: unscaled(q, 4), UnitAmount: unscaled(u, 4) };
    }
    if (q !== 0n && target % q === 0n) {
      return { Description: description(line.description), Quantity: unscaled(q, 4), UnitAmount: unscaled(target / q, 4) };
    }
  }
  const suffix = ` (${line.quantity} × ${line.unitPrice})`;
  return { Description: description(line.description, suffix), Quantity: 1, UnitAmount: Number(line.lineTotal) };
}

export function buildXeroInvoice(
  invoice: AccountingInvoicePayload,
  lineMappings: readonly AccountingInvoiceLineMapping[],
  items: ReadonlyMap<string, XeroItemRef>,
  conn: XeroInvoiceSettings,
  opts: { includeNumber: boolean; sendLineTax?: boolean },
): XeroInvoice {
  // Defence in depth: the coordinator ran the same pre-flight in Phase 1, but a
  // setting can change between then and now.
  const blocked = xeroInvoicePreflight(conn, invoice);
  if (blocked) throw validation('Xero invoice payload', blocked.message);
  const taxed = taxedFlags(invoice);
  const shares = taxShares(invoice, taxed) as string[]; // non-null: the pre-flight passed
  const sendLineTax = opts.sendLineTax ?? XERO_SEND_LINE_TAX_AMOUNT;
  const itemRefByLine = new Map(lineMappings.map((m) => [m.invoiceLineId, m.remoteItemRef]));

  const LineItems = invoice.lines.map((line, i): XeroInvoiceLine => {
    const remoteItemId = itemRefByLine.get(line.invoiceLineId)?.id;
    const item = remoteItemId ? items.get(remoteItemId) : undefined;
    if (remoteItemId && !item) {
      console.warn(`[xeroInvoices] mapped item ${remoteItemId} is not in Xero; line ${line.invoiceLineId} sent without ItemCode`);
    }
    return {
      ...xeroLineAmounts(line),
      AccountCode: item?.accountCode ?? (conn.defaultIncomeAccountRef as string),
      TaxType: (taxed[i] ? conn.defaultTaxCodeRef : conn.defaultExemptTaxCodeRef) as string,
      ...(sendLineTax ? { TaxAmount: Number(shares[i]) } : {}),
      ...(item ? { ItemCode: item.code } : {}),
    };
  });

  return {
    Type: 'ACCREC',
    Contact: { ContactID: invoice.customerRef.id },
    Date: invoice.txnDate,
    DueDate: invoice.dueDate ?? invoice.txnDate,
    ...(opts.includeNumber && invoice.docNumber ? { InvoiceNumber: invoice.docNumber } : {}),
    Reference: xeroInvoiceReference(invoice.invoiceId),
    CurrencyCode: invoice.currencyCode,
    Status: 'AUTHORISED',
    LineAmountTypes: 'Exclusive',
    LineItems,
  };
}

function money(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : null;
}

export function toXeroPushResult(invoice: XeroInvoice | undefined, operation: string): InvoicePushResult {
  if (invoice?.HasErrors) {
    const first = invoice.ValidationErrors?.find((v) => typeof v?.Message === 'string')?.Message;
    throw validation(operation, `${operation} was rejected by Xero`, first);
  }
  if (!invoice?.InvoiceID) {
    throw new AccountingProviderError({ kind: 'transient', provider: 'xero', operation, message: `${operation} returned no invoice` });
  }
  const remoteVersion = parseXeroDate(invoice.UpdatedDateUTC);
  return {
    id: invoice.InvoiceID,
    ...(invoice.InvoiceNumber ? { docNumber: invoice.InvoiceNumber } : {}),
    ...(remoteVersion ? { remoteVersion } : {}),
    remoteTaxTotal: money(invoice.TotalTax),
    remoteTotal: money(invoice.Total),
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroInvoices.test.ts && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/accounting/xeroInvoices.ts apps/api/src/services/accounting/xeroInvoices.test.ts
git commit -m "feat(accounting): Xero invoice pre-flight, exact line amounts and ACCREC body (Xero W04)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: `xeroInvoices.ts` — reference lookup, create with adoption, duplicate-number fallback, re-push

**Files:**
- Modify: `apps/api/src/services/accounting/xeroInvoices.ts` (append the I/O half)
- Test: `xeroInvoices.test.ts` (append)

**Interfaces:**
- Consumes: Task 4 (`readXeroItemRefs`, the new 400 kinds), Task 5, C1–C2, B3 of W02 (`providerErrorKindOf`: a non-provider error is `'transient'`).
- Produces (`xeroInvoices.ts`):
  ```ts
  export async function findXeroInvoicesByReference(ctx: XeroCallContext, invoiceId: string): Promise<{ live: XeroInvoice[]; supersededIds: string[] }>;
  export async function pushXeroInvoice(ctx: XeroCallContext, conn: XeroInvoiceSettings, invoice: AccountingInvoicePayload,
    lineMappings: readonly AccountingInvoiceLineMapping[]): Promise<InvoicePushResult>;
  export function xeroInvoiceIdempotencyKey(tenantId: string, invoiceId: string, variant: 'with-number' | 'without-number', supersededIds: readonly string[]): string; // 'breeze-inv-' + 64 hex
  export async function findPushedXeroInvoice(ctx: XeroCallContext, invoiceId: string): Promise<{ id: string; remoteVersion?: string } | null>;
  ```
  Thrown refusals (all `AccountingProviderError`, provider `xero`): `not_found` + `remote_missing`; `validation` + `remote_locked`; `validation` + `duplicate_key` (two live invoices). `duplicate_doc_number` never escapes (refinement 9).

- [ ] **Step 1: Write the failing tests**

Append to `xeroInvoices.test.ts` (add `findXeroInvoicesByReference, pushXeroInvoice, xeroInvoiceIdempotencyKey` to the file's `./xeroInvoices` import, and add `import { AccountingProviderError } from './accountingProviderError';` at the top):

```ts
const ctx = {
  connectionId: 'c1', tenantId: 'ten-A', accessToken: 'at',
  rate: { perConnection: { limit: 60, windowSeconds: 60 }, maxConcurrentPerConnection: 5, appWide: null, dailyPerConnection: null },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
/** Typed view of a fetch spy's calls (vi.spyOn's generic return type would leave the tuple `any`). */
const callsOf = (fetchMock: { mock: { calls: unknown[][] } }) => fetchMock.mock.calls.map((call) => {
  const [url, init] = call as [string, RequestInit];
  return { url, method: init.method, init };
});
const bodyOf = (init: RequestInit) => JSON.parse(init.body as string) as { Invoices: Array<Record<string, unknown>> };
const keyOf = (init: RequestInit) => (init.headers as Record<string, string>)['Idempotency-Key'];
const LOOKUP_URL = `https://api.xero.com/api.xro/2.0/Invoices?where=Reference%3D%3D%22breeze%3A${INVOICE}%22&unitdp=4`;
const CREATE_URL = 'https://api.xero.com/api.xro/2.0/Invoices?unitdp=4&summarizeErrors=true';
const UPDATE_URL = 'https://api.xero.com/api.xro/2.0/Invoices/xi-1?unitdp=4&summarizeErrors=true';
const remote = (over: Record<string, unknown> = {}) => ({
  InvoiceID: 'xi-1', Type: 'ACCREC', InvoiceNumber: 'INV-2026-0001', Reference: `breeze:${INVOICE}`, Status: 'AUTHORISED',
  Contact: { ContactID: 'xc-1' }, CurrencyCode: 'GBP', SubTotal: 100, TotalTax: 20, Total: 120, AmountPaid: 0, AmountCredited: 0,
  UpdatedDateUTC: '/Date(1790000000000+0000)/', ...over,
});
const timeout = () => new DOMException('t', 'TimeoutError');
const failing400 = (message: string) => json({ ErrorNumber: 10, Type: 'ValidationException', Elements: [{ ValidationErrors: [{ Message: message }] }] }, 400);
const mapped = (over: Partial<AccountingInvoicePayload> = {}) => invoice({ mapping: { remoteEntityId: 'xi-1', remoteSyncToken: null }, ...over });

describe('xeroInvoiceIdempotencyKey (refinement 2)', () => {
  it('depends on tenant, invoice, variant and superseded ids — never on the body', () => {
    const k = xeroInvoiceIdempotencyKey('ten-A', INVOICE, 'with-number', []);
    expect(k).toMatch(/^breeze-inv-[0-9a-f]{64}$/);
    expect(xeroInvoiceIdempotencyKey('ten-A', INVOICE, 'with-number', [])).toBe(k);
    expect(xeroInvoiceIdempotencyKey('ten-B', INVOICE, 'with-number', [])).not.toBe(k);
    expect(xeroInvoiceIdempotencyKey('ten-A', 'other', 'with-number', [])).not.toBe(k);
    expect(xeroInvoiceIdempotencyKey('ten-A', INVOICE, 'without-number', [])).not.toBe(k);
    expect(xeroInvoiceIdempotencyKey('ten-A', INVOICE, 'with-number', ['xi-old'])).not.toBe(k);
    expect(xeroInvoiceIdempotencyKey('ten-A', INVOICE, 'with-number', ['b', 'a'])).toBe(xeroInvoiceIdempotencyKey('ten-A', INVOICE, 'with-number', ['a', 'b']));
  });
});

describe('findXeroInvoicesByReference', () => {
  it('filters to exact ACCREC matches and splits live from superseded', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Invoices: [
      remote(),
      remote({ InvoiceID: 'xi-old2', Status: 'VOIDED' }),
      remote({ InvoiceID: 'xi-old1', Status: 'DELETED' }),
      remote({ InvoiceID: 'bill', Type: 'ACCPAY' }),
      remote({ InvoiceID: 'near', Reference: `breeze:${INVOICE}-x` }),
      remote({ InvoiceID: 'no-type', Type: undefined }),
    ] }));
    const found = await findXeroInvoicesByReference(ctx, INVOICE);
    expect(found.live.map((i) => i.InvoiceID)).toEqual(['xi-1', 'no-type']);
    expect(found.supersededIds).toEqual(['xi-old1', 'xi-old2']);
    expect(callsOf(fetchMock)[0]).toMatchObject({ url: LOOKUP_URL, method: 'GET' });
  });
});

describe('pushXeroInvoice — first push', () => {
  it('looks up the reference, then PUTs the with-number body under the with-number key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(json({ Invoices: [remote()] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).resolves.toEqual({
      id: 'xi-1', docNumber: 'INV-2026-0001', remoteVersion: new Date(1790000000000).toISOString(),
      remoteTaxTotal: '20.00', remoteTotal: '120.00',
    });
    const [lookup, create] = callsOf(fetchMock);
    expect(lookup).toMatchObject({ url: LOOKUP_URL, method: 'GET' });
    expect(create).toMatchObject({ url: CREATE_URL, method: 'PUT' });
    expect(bodyOf(create!.init).Invoices[0]).toMatchObject({ InvoiceNumber: 'INV-2026-0001', Reference: `breeze:${INVOICE}`, Status: 'AUTHORISED' });
    expect(keyOf(create!.init)).toBe(xeroInvoiceIdempotencyKey('ten-A', INVOICE, 'with-number', []));
  });

  it('a second push adopts instead of creating: read, then resend by POST, never a PUT (Review Focus 1)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [remote()] }))
      .mockResolvedValueOnce(json({ Invoices: [remote()] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).resolves.toMatchObject({ id: 'xi-1' });
    expect(callsOf(fetchMock).map((c) => [c.method, c.url])).toEqual([['GET', LOOKUP_URL], ['POST', UPDATE_URL]]);
  });

  it('adopts after a timed-out create (Review Focus 1)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce(json({ Invoices: [remote()] }))
      .mockResolvedValueOnce(json({ Invoices: [remote()] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).resolves.toMatchObject({ id: 'xi-1' });
    expect(callsOf(fetchMock).map((c) => c.method)).toEqual(['GET', 'PUT', 'GET', 'POST']);
  });

  it('a timed-out create that left nothing rethrows the transient (the retry looks first)', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce(json({ Invoices: [] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).rejects.toMatchObject({ kind: 'transient', provider: 'xero' });
  });

  it('a concurrent push with a different body gets the key-reuse 400 and adopts the first push\'s invoice (quorum finding 1)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(failing400(`Idempotency Key: ${xeroInvoiceIdempotencyKey('ten-A', INVOICE, 'with-number', [])} is used with a different request.`))
      .mockResolvedValueOnce(json({ Invoices: [remote()] }))
      .mockResolvedValueOnce(json({ Invoices: [remote()] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).resolves.toMatchObject({ id: 'xi-1' });
    expect(callsOf(fetchMock).filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('a voided predecessor changes the key but not the body (refinement 2)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] })).mockResolvedValueOnce(json({ Invoices: [remote()] }))
      .mockResolvedValueOnce(json({ Invoices: [remote({ InvoiceID: 'xi-old', Status: 'VOIDED' })] }))
      .mockResolvedValueOnce(json({ Invoices: [remote({ InvoiceID: 'xi-2' })] }));
    await pushXeroInvoice(ctx, SETTINGS, invoice(), []);
    await pushXeroInvoice(ctx, SETTINGS, invoice(), []);
    const puts = callsOf(fetchMock).filter((c) => c.method === 'PUT');
    expect(keyOf(puts[1]!.init)).toBe(xeroInvoiceIdempotencyKey('ten-A', INVOICE, 'with-number', ['xi-old']));
    expect(keyOf(puts[1]!.init)).not.toBe(keyOf(puts[0]!.init));
    expect(puts[1]!.init.body).toBe(puts[0]!.init.body);
  });

  it('a duplicate number owned by our own lost create is adopted', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(failing400('Invoice # must be unique.'))
      .mockResolvedValueOnce(json({ Invoices: [remote()] }))
      .mockResolvedValueOnce(json({ Invoices: [remote()] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).resolves.toMatchObject({ id: 'xi-1' });
    expect(callsOf(fetchMock).map((c) => c.method)).toEqual(['GET', 'PUT', 'GET', 'POST']);
  });

  it('a duplicate number held by someone else → one numberless retry under the without-number key (Review Focus 2)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(failing400('Invoice # must be unique.'))
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(json({ Invoices: [remote({ InvoiceNumber: 'INV-0042' })] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).resolves.toMatchObject({ id: 'xi-1', docNumber: 'INV-0042' });
    const puts = callsOf(fetchMock).filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(bodyOf(puts[0]!.init).Invoices[0]).toHaveProperty('InvoiceNumber', 'INV-2026-0001');
    expect(bodyOf(puts[1]!.init).Invoices[0]).not.toHaveProperty('InvoiceNumber');
    expect(keyOf(puts[1]!.init)).toBe(xeroInvoiceIdempotencyKey('ten-A', INVOICE, 'without-number', []));
  });

  it('the numberless retry keys on the superseded ids of the LATEST lookup (quorum finding 2)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(failing400('Invoice # must be unique.'))
      .mockResolvedValueOnce(json({ Invoices: [remote({ InvoiceID: 'xi-v', Status: 'VOIDED' })] }))
      .mockResolvedValueOnce(json({ Invoices: [remote({ InvoiceID: 'xi-2', InvoiceNumber: 'INV-0043' })] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).resolves.toMatchObject({ id: 'xi-2' });
    const puts = callsOf(fetchMock).filter((c) => c.method === 'PUT');
    expect(keyOf(puts[1]!.init)).toBe(xeroInvoiceIdempotencyKey('ten-A', INVOICE, 'without-number', ['xi-v']));
  });

  it('a validation failure on the numberless retry is not retried again', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(failing400('Invoice # must be unique.'))
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(failing400("Account code '999' is not a valid code for this document."));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).rejects.toMatchObject({ kind: 'validation', httpStatus: 400 });
    expect(callsOf(fetchMock)).toHaveLength(4);
  });

  it('two live invoices with our reference → duplicate_key, nothing written (never guess)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Invoices: [remote(), remote({ InvoiceID: 'xi-2' })] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).rejects.toMatchObject({ kind: 'validation', providerCode: 'duplicate_key' });
    expect(callsOf(fetchMock)).toHaveLength(1);
  });

  it('reads the price list once, only when a line has a mapped item', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(json({ Items: [{ ItemID: 'xi-item', Code: 'fw-100-3fa9c1b2d4' }] }))
      .mockResolvedValueOnce(json({ Invoices: [remote()] }));
    await pushXeroInvoice(ctx, SETTINGS, invoice(), [{ invoiceLineId: 'l1', remoteItemRef: { id: 'xi-item' } }]);
    expect(callsOf(fetchMock).map((c) => c.url.split('?')[0]!.split('/').pop())).toEqual(['Invoices', 'Items', 'Invoices']);
    expect(bodyOf(callsOf(fetchMock)[2]!.init).Invoices[0]).toMatchObject({ LineItems: [expect.objectContaining({ ItemCode: 'fw-100-3fa9c1b2d4' })] });
  });

  it('a throttle during the pre-create lookup propagates untouched', async () => {
    const refusal = new AccountingProviderError({ kind: 'rate_limited', provider: 'xero', operation: 'slot', retryAfterMs: 1000, throttleSource: 'local' });
    slotMock.mockImplementationOnce(async () => { throw refusal; });
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).rejects.toBe(refusal);
  });
});

describe('pushXeroInvoice — re-push of an invoice already in Xero (refinement 7)', () => {
  it.each(['AUTHORISED', 'DRAFT', 'SUBMITTED'])('an unpaid %s invoice is resent by POST: Status AUTHORISED, no InvoiceNumber, no Idempotency-Key', async (Status) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [remote({ Status })] }))
      .mockResolvedValueOnce(json({ Invoices: [remote()] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, mapped(), [])).resolves.toMatchObject({ id: 'xi-1', remoteTotal: '120.00' });
    const [read, post] = callsOf(fetchMock);
    expect(read).toMatchObject({ url: 'https://api.xero.com/api.xro/2.0/Invoices/xi-1?unitdp=4', method: 'GET' });
    expect(post).toMatchObject({ url: UPDATE_URL, method: 'POST' });
    expect(bodyOf(post!.init).Invoices[0]).toMatchObject({ InvoiceID: 'xi-1', Status: 'AUTHORISED' });
    expect(bodyOf(post!.init).Invoices[0]).not.toHaveProperty('InvoiceNumber');
    expect(post!.init.headers).not.toHaveProperty('Idempotency-Key');
  });

  it.each([{ Status: 'PAID', AmountPaid: 120 }, { AmountPaid: 10 }, { AmountCredited: 5 }])(
    'money applied (%o) with Breeze\'s amounts → read only, no write',
    async (money) => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Invoices: [remote(money)] }));
      await expect(pushXeroInvoice(ctx, SETTINGS, mapped(), [])).resolves.toMatchObject({ id: 'xi-1', remoteTotal: '120.00' });
      expect(callsOf(fetchMock)).toHaveLength(1);
    },
  );

  it.each([{ Total: 108, AmountPaid: 10 }, { CurrencyCode: 'USD', AmountCredited: 5 }])(
    'money applied (%o) with different content → remote_locked, no write',
    async (over) => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Invoices: [remote(over)] }));
      await expect(pushXeroInvoice(ctx, SETTINGS, mapped(), [])).rejects.toMatchObject({ kind: 'validation', providerCode: 'remote_locked' });
      expect(callsOf(fetchMock)).toHaveLength(1);
    },
  );

  it('a payment applied between the read and the write → remote_locked', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [remote()] }))
      .mockResolvedValueOnce(failing400('This document cannot be edited as it has a payment or credit note allocated to it.'));
    await expect(pushXeroInvoice(ctx, SETTINGS, mapped(), [])).rejects.toMatchObject({ kind: 'validation', providerCode: 'remote_locked' });
  });

  it.each(['VOIDED', 'DELETED'])('%s in Xero → remote_missing', async (Status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Invoices: [remote({ Status })] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, mapped(), [])).rejects.toMatchObject({ kind: 'not_found', providerCode: 'remote_missing' });
  });

  it('404 → remote_missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(pushXeroInvoice(ctx, SETTINGS, mapped(), [])).rejects.toMatchObject({ kind: 'not_found', providerCode: 'remote_missing' });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroInvoices.test.ts`
Expected: FAIL — `findXeroInvoicesByReference` / `pushXeroInvoice` / `xeroInvoiceIdempotencyKey` are not exported.

- [ ] **Step 3: Implement**

Extend the imports at the top of `xeroInvoices.ts` (merge with Task 5's lines):

```ts
import { createHash } from 'node:crypto';
import { AccountingProviderError, isAccountingProviderError, providerErrorKindOf } from './accountingProviderError';
import { parseXeroDate, requireXeroBody, xeroApiGet, xeroApiWrite, xeroArray, xeroQuery, type XeroCallContext } from './xeroHttp';
import { readXeroItemRefs, type XeroItemRef } from './xeroItems';
```

Then append:

```ts
// ---------------------------------------------------------------------------
// I/O: lookup, push (create with adoption, re-push), void
// ---------------------------------------------------------------------------

interface InvoicesBody { Invoices?: XeroInvoice[] }
type CreateVariant = 'with-number' | 'without-number';

const READ_QUERY = xeroQuery({ unitdp: 4 });
const WRITE_QUERY = xeroQuery({ unitdp: 4, summarizeErrors: true });
const LIVE_STATUSES: ReadonlySet<string> = new Set(['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID']);
const GONE_STATUSES: ReadonlySet<string> = new Set(['VOIDED', 'DELETED']);

/**
 * Refinement 2: one key per request IDENTITY — tenant, Breeze invoice, variant
 * and the voided predecessors the latest lookup saw — never per request bytes,
 * so two concurrent pushes whose bodies differ cannot mint two creates: the
 * second replays the first, or gets Xero's key-reuse 400 (transient → look again).
 */
export function xeroInvoiceIdempotencyKey(
  tenantId: string, invoiceId: string, variant: CreateVariant, supersededIds: readonly string[],
): string {
  const input = ['invoice', tenantId, invoiceId, variant, [...supersededIds].sort().join(',')].join('\n');
  return `breeze-inv-${createHash('sha256').update(input).digest('hex')}`;
}

function refusal(kind: 'validation' | 'not_found', providerCode: string, operation: string, message: string, cause?: unknown): AccountingProviderError {
  return new AccountingProviderError({
    kind, provider: 'xero', operation, message, providerCode, ...(kind === 'not_found' ? { httpStatus: 404 } : {}), cause,
  });
}
const remoteMissing = (operation: string, cause?: unknown) =>
  refusal('not_found', 'remote_missing', operation, `${operation} found the invoice gone or voided in Xero`, cause);
const remoteLocked = (operation: string, cause?: unknown) =>
  refusal('validation', 'remote_locked', operation, `${operation} refused: a payment or credit is applied in Xero and the amounts differ`, cause);

/** Refinement 10: every Xero invoice carrying our adoption key, split into live and superseded. */
export async function findXeroInvoicesByReference(
  ctx: XeroCallContext,
  invoiceId: string,
): Promise<{ live: XeroInvoice[]; supersededIds: string[] }> {
  const operation = 'Xero invoice lookup';
  const reference = xeroInvoiceReference(invoiceId);
  const body = requireXeroBody(
    await xeroApiGet<InvoicesBody | null>(ctx, `Invoices${xeroQuery({ where: `Reference=="${reference}"`, unitdp: 4 })}`, operation),
    operation,
  );
  const ours = xeroArray<XeroInvoice>(body.Invoices)
    .filter((i) => i.InvoiceID && (i.Type ?? 'ACCREC') === 'ACCREC' && i.Reference === reference);
  return {
    live: ours.filter((i) => LIVE_STATUSES.has(i.Status ?? '')),
    supersededIds: ours.filter((i) => GONE_STATUSES.has(i.Status ?? '')).map((i) => i.InvoiceID as string).sort(),
  };
}

/** One invoice by id, or null on a 404. */
async function readXeroInvoice(ctx: XeroCallContext, invoiceId: string): Promise<XeroInvoice | null> {
  const operation = 'Xero invoice read';
  let body: InvoicesBody | null;
  try {
    body = await xeroApiGet<InvoicesBody | null>(ctx, `Invoices/${encodeURIComponent(invoiceId)}${READ_QUERY}`, operation);
  } catch (err) {
    if (isAccountingProviderError(err) && err.kind === 'not_found') return null;
    throw err;
  }
  return xeroArray<XeroInvoice>(requireXeroBody(body, operation).Invoices)[0] ?? null;
}

/** The single live invoice, null for none, and a refusal for two or more (never guess). */
function onlyLive(found: { live: XeroInvoice[] }): XeroInvoice | null {
  if (found.live.length > 1) {
    throw refusal('validation', 'duplicate_key', 'Xero invoice lookup', `Xero holds ${found.live.length} live invoices for this Breeze invoice`);
  }
  return found.live[0] ?? null;
}

function centsOf(value: number | string | null | undefined): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** A locked (paid-toward) invoice already carries Breeze's money (refinement 7). */
function matchesBreeze(existing: XeroInvoice, invoice: AccountingInvoicePayload): boolean {
  return (existing.CurrencyCode ?? '').toUpperCase() === invoice.currencyCode.toUpperCase()
    && existing.Contact?.ContactID === invoice.customerRef.id
    && centsOf(existing.SubTotal) !== null && centsOf(existing.SubTotal) === centsOf(invoice.subtotal)
    && centsOf(existing.TotalTax) === centsOf(invoice.taxTotal)
    && centsOf(existing.Total) === centsOf(invoice.total);
}

function moneyApplied(existing: XeroInvoice): boolean {
  return (existing.AmountPaid ?? 0) > 0 || (existing.AmountCredited ?? 0) > 0;
}

type ItemLoader = () => Promise<ReadonlyMap<string, XeroItemRef>>;

/** Reads the price list at most once, and only if some line has a mapped item. */
function itemLoader(ctx: XeroCallContext, lineMappings: readonly AccountingInvoiceLineMapping[]): ItemLoader {
  let pending: Promise<ReadonlyMap<string, XeroItemRef>> | null = null;
  const needed = lineMappings.some((m) => m.remoteItemRef);
  return () => {
    if (!needed) return Promise.resolve(new Map());
    pending ??= readXeroItemRefs(ctx);
    return pending;
  };
}

interface PushContext {
  ctx: XeroCallContext;
  conn: XeroInvoiceSettings;
  invoice: AccountingInvoicePayload;
  lineMappings: readonly AccountingInvoiceLineMapping[];
  loadItems: ItemLoader;
}

/** An invoice that already exists in Xero (mapped, or adopted by Reference): resend, accept, or refuse. */
async function settleExisting(p: PushContext, existing: XeroInvoice): Promise<InvoicePushResult> {
  const operation = 'Xero invoice update';
  const id = existing.InvoiceID as string;
  const status = existing.Status ?? '';
  if (GONE_STATUSES.has(status)) throw remoteMissing(operation);
  if (status === 'PAID' || moneyApplied(existing)) {
    // Xero will not edit the lines now; accept them only if they carry Breeze's money.
    if (matchesBreeze(existing, p.invoice)) return toXeroPushResult(existing, 'Xero invoice read');
    throw remoteLocked(operation);
  }
  // InvoiceNumber is never sent on an update (refinement 1): Xero keeps its own.
  const body = { ...buildXeroInvoice(p.invoice, p.lineMappings, await p.loadItems(), p.conn, { includeNumber: false }), InvoiceID: id };
  try {
    const res = requireXeroBody(
      await xeroApiWrite<InvoicesBody | null>(p.ctx, 'POST', `Invoices/${encodeURIComponent(id)}${WRITE_QUERY}`, { Invoices: [body] }, operation),
      operation,
    );
    return toXeroPushResult(xeroArray<XeroInvoice>(res.Invoices)[0], operation);
  } catch (err) {
    // A payment applied between our read and this write: Xero refuses the line edit.
    if (providerErrorKindOf(err) === 'payment_linked') throw remoteLocked(operation, err);
    throw err;
  }
}

async function createInvoice(p: PushContext, variant: CreateVariant, supersededIds: readonly string[]): Promise<InvoicePushResult> {
  const operation = 'Xero invoice create';
  const payload = {
    Invoices: [buildXeroInvoice(p.invoice, p.lineMappings, await p.loadItems(), p.conn, { includeNumber: variant === 'with-number' })],
  };
  const res = requireXeroBody(
    await xeroApiWrite<InvoicesBody | null>(p.ctx, 'PUT', `Invoices${WRITE_QUERY}`, payload, operation, {
      idempotencyKey: xeroInvoiceIdempotencyKey(p.ctx.tenantId, p.invoice.invoiceId, variant, supersededIds),
    }),
    operation,
  );
  return toXeroPushResult(xeroArray<XeroInvoice>(res.Invoices)[0], operation);
}

async function createAdopting(p: PushContext, initialSupersededIds: readonly string[]): Promise<InvoicePushResult> {
  let supersededIds = initialSupersededIds;
  /** After an outcome our create (or a peer's) may have survived: adopt what landed, or null. */
  const lookAgain = async (): Promise<InvoicePushResult | null> => {
    const found = await findXeroInvoicesByReference(p.ctx, p.invoice.invoiceId);
    supersededIds = found.supersededIds; // the LATEST view keys the next create (quorum finding 2)
    const live = onlyLive(found);
    return live ? settleExisting(p, live) : null;
  };

  try {
    return await createInvoice(p, 'with-number', supersededIds);
  } catch (err) {
    const kind = providerErrorKindOf(err);
    if (kind !== 'transient' && kind !== 'duplicate_doc_number') throw err;
    const adopted = await lookAgain();
    if (adopted) return adopted;
    if (kind !== 'duplicate_doc_number') throw err;
  }
  // Refinement 9: the number belongs to a document that is not ours. One retry
  // without it, under the without-number key.
  try {
    return await createInvoice(p, 'without-number', supersededIds);
  } catch (err) {
    if (providerErrorKindOf(err) !== 'transient') throw err;
    const adopted = await lookAgain();
    if (adopted) return adopted;
    throw err;
  }
}

/**
 * Push one Breeze invoice. Mapped → read and settle. Unmapped → adoption
 * lookup by Reference, then create (with adoption after an uncertain outcome
 * and the duplicate-number fallback). Named so the call-site contract test
 * (M10) never mistakes it for `AccountingProvider.pushInvoice`.
 */
export async function pushXeroInvoice(
  ctx: XeroCallContext,
  conn: XeroInvoiceSettings,
  invoice: AccountingInvoicePayload,
  lineMappings: readonly AccountingInvoiceLineMapping[],
): Promise<InvoicePushResult> {
  const p: PushContext = { ctx, conn, invoice, lineMappings, loadItems: itemLoader(ctx, lineMappings) };
  if (invoice.mapping) {
    const existing = await readXeroInvoice(ctx, invoice.mapping.remoteEntityId);
    if (!existing) throw remoteMissing('Xero invoice read');
    return settleExisting(p, existing);
  }
  const found = await findXeroInvoicesByReference(ctx, invoice.invoiceId);
  const adopted = onlyLive(found);
  if (adopted) return settleExisting(p, adopted);
  return createAdopting(p, found.supersededIds);
}

/** Refinement 22: the live invoice a push of this Breeze invoice created, or null. */
export async function findPushedXeroInvoice(ctx: XeroCallContext, invoiceId: string): Promise<{ id: string; remoteVersion?: string } | null> {
  const live = onlyLive(await findXeroInvoicesByReference(ctx, invoiceId));
  if (!live) return null;
  const remoteVersion = parseXeroDate(live.UpdatedDateUTC);
  return { id: live.InvoiceID as string, ...(remoteVersion ? { remoteVersion } : {}) };
}
```

Add a test for `findPushedXeroInvoice` to the same file:

```ts
describe('findPushedXeroInvoice (refinement 22)', () => {
  it('returns the single live invoice with its version, or null', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [remote(), remote({ InvoiceID: 'xi-v', Status: 'VOIDED' })] }))
      .mockResolvedValueOnce(json({ Invoices: [remote({ Status: 'VOIDED' })] }));
    await expect(findPushedXeroInvoice(ctx, INVOICE)).resolves.toEqual({ id: 'xi-1', remoteVersion: new Date(1790000000000).toISOString() });
    await expect(findPushedXeroInvoice(ctx, INVOICE)).resolves.toBeNull();
  });
});
```

(add `findPushedXeroInvoice` to the import).

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroInvoices.test.ts src/services/accounting/accountingInvoicePushCallSites.test.ts && npx tsc --noEmit -p .`
Expected: PASS; the call-site contract still counts only the coordinator's calls.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/accounting/xeroInvoices.ts apps/api/src/services/accounting/xeroInvoices.test.ts
git commit -m "feat(accounting): Xero invoice push with reference adoption, duplicate-number fallback and read-first re-push (Xero W04)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `xeroInvoices.ts` void; provider wiring

**Files:**
- Modify: `apps/api/src/services/accounting/xeroInvoices.ts` (append `voidXeroInvoice`)
- Modify: `apps/api/src/services/accounting/xeroProvider.ts` (`pushInvoice`, `voidInvoice`, `invoicePushPreflight`)
- Test: `xeroInvoices.test.ts`, `xeroProvider.test.ts`

**Interfaces:**
- Consumes: Task 6 (`readXeroInvoice`, `LIVE_STATUSES`, `GONE_STATUSES`, `moneyApplied`), Task 5 (`xeroInvoicePreflight`), A2, A4.
- Produces:
  ```ts
  export async function voidXeroInvoice(ctx: XeroCallContext, remoteInvoiceId: string): Promise<InvoiceVoidResult>;
  // XeroProvider: pushInvoice / voidInvoice implemented; invoicePushPreflight(conn, invoice) and findRemoteInvoice(conn, invoiceId) declared.
  // capabilities unchanged (invoicePush: false until Task 10).
  ```

- [ ] **Step 1: Write the failing tests**

Append to `xeroInvoices.test.ts` (add `voidXeroInvoice` to the import):

```ts
describe('voidXeroInvoice (refinement 8)', () => {
  const VOID_URL = 'https://api.xero.com/api.xro/2.0/Invoices/xi-1?unitdp=4&summarizeErrors=true';

  it.each<[string, string]>([['AUTHORISED', 'VOIDED'], ['DRAFT', 'DELETED'], ['SUBMITTED', 'DELETED']])(
    '%s → POST Status %s, returning the new version',
    async (Status, target) => {
      const fetchMock = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(json({ Invoices: [remote({ Status })] }))
        .mockResolvedValueOnce(json({ Invoices: [remote({ Status: target, UpdatedDateUTC: '/Date(1790000100000+0000)/' })] }));
      await expect(voidXeroInvoice(ctx, 'xi-1')).resolves.toEqual({ remoteVersion: new Date(1790000100000).toISOString() });
      const post = callsOf(fetchMock)[1]!;
      expect(post).toMatchObject({ url: VOID_URL, method: 'POST' });
      expect(bodyOf(post.init)).toEqual({ Invoices: [{ InvoiceID: 'xi-1', Status: target }] });
      expect(post.init.headers).not.toHaveProperty('Idempotency-Key');
    },
  );

  it.each(['VOIDED', 'DELETED'])('already %s → success, no write', async (Status) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Invoices: [remote({ Status })] }));
    await expect(voidXeroInvoice(ctx, 'xi-1')).resolves.toEqual({ remoteVersion: new Date(1790000000000).toISOString() });
    expect(callsOf(fetchMock)).toHaveLength(1);
  });

  it('absent in Xero (404) → success with no version, no write', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(voidXeroInvoice(ctx, 'xi-1')).resolves.toEqual({ remoteVersion: null });
    expect(callsOf(fetchMock)).toHaveLength(1);
  });

  it.each([{ Status: 'PAID', AmountPaid: 120 }, { AmountPaid: 10 }, { AmountCredited: 5 }])(
    'money applied (%o) → payment_linked, no write (Review Focus 5)',
    async (over) => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Invoices: [remote(over)] }));
      await expect(voidXeroInvoice(ctx, 'xi-1')).rejects.toMatchObject({ kind: 'payment_linked', provider: 'xero' });
      expect(callsOf(fetchMock)).toHaveLength(1);
    },
  );

  it('a payment applied between the read and the void → payment_linked from Xero\'s 400', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [remote()] }))
      .mockResolvedValueOnce(failing400('The status VOIDED cannot be applied to the invoice because it has payments or credit notes allocated to it.'));
    await expect(voidXeroInvoice(ctx, 'xi-1')).rejects.toMatchObject({ kind: 'payment_linked' });
  });

  it('an unknown status is transient (never guessed)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Invoices: [remote({ Status: 'SOMETHING_NEW' })] }));
    await expect(voidXeroInvoice(ctx, 'xi-1')).rejects.toMatchObject({ kind: 'transient' });
  });
});
```

In `xeroProvider.test.ts`: remove the `pushInvoice` and `voidInvoice` rows from the `describe('methods behind later waves')` `it.each` table (A4), and append (use the file's `conn()` factory and `json()` helper; pass the three settings as overrides):

```ts
describe('invoice push and void (Xero W04)', () => {
  const settings = { defaultIncomeAccountRef: '200', defaultTaxCodeRef: 'OUTPUT2', defaultExemptTaxCodeRef: 'EXEMPTOUTPUT' };
  const payload = {
    invoiceId: 'inv-1', docNumber: 'INV-1', txnDate: '2026-09-01', dueDate: null, customerRef: { id: 'xc-1' }, currencyCode: 'GBP',
    subtotal: '100.00', taxTotal: '20.00', total: '120.00', mapping: null,
    lines: [{ invoiceLineId: 'l1', description: 'Support', quantity: '1.00', unitPrice: '100.00', lineTotal: '100.00', taxable: true }],
  };

  it('pushInvoice runs the Xero flow against the connection\'s tenant', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(json({ Invoices: [{ InvoiceID: 'xi-1', InvoiceNumber: 'INV-1', TotalTax: 20, Total: 120 }] }));
    const c = conn(settings);
    await expect(xeroProvider.pushInvoice(c, payload, [])).resolves.toMatchObject({ id: 'xi-1', remoteTotal: '120.00' });
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).headers).toMatchObject({ 'xero-tenant-id': c.realmId });
    }
  });

  it('voidInvoice reads, then voids by the mapping\'s remote id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [{ InvoiceID: 'xi-1', Status: 'AUTHORISED' }] }))
      .mockResolvedValueOnce(json({ Invoices: [{ InvoiceID: 'xi-1', Status: 'VOIDED' }] }));
    await xeroProvider.voidInvoice(conn(settings), { invoiceId: 'inv-1', docNumber: 'INV-1', currencyCode: 'GBP' }, { remoteEntityId: 'xi-1', remoteSyncToken: null });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.xero.com/api.xro/2.0/Invoices/xi-1?unitdp=4',
      'https://api.xero.com/api.xro/2.0/Invoices/xi-1?unitdp=4&summarizeErrors=true',
    ]);
  });

  it('invoicePushPreflight is the Xero pre-flight', () => {
    expect(xeroProvider.invoicePushPreflight(conn({ ...settings, defaultTaxCodeRef: null }), payload)).toEqual({
      reason: 'settings', message: 'Choose a tax rate for taxable lines in Integrations → Accounting → Xero, then push again',
    });
  });

  it('findRemoteInvoice looks the invoice up by its Breeze reference', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Invoices: [{ InvoiceID: 'xi-1', Type: 'ACCREC', Reference: 'breeze:inv-1', Status: 'AUTHORISED' }] }));
    await expect(xeroProvider.findRemoteInvoice(conn(settings), 'inv-1')).resolves.toEqual({ id: 'xi-1' });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.xero.com/api.xro/2.0/Invoices?where=Reference%3D%3D%22breeze%3Ainv-1%22&unitdp=4');
  });

  it('still does not declare invoicePush through W04a', () => {
    expect(xeroProvider.capabilities.invoicePush).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroInvoices.test.ts src/services/accounting/xeroProvider.test.ts`
Expected: FAIL — `voidXeroInvoice` is not exported; the provider methods still throw `capability_unavailable`; `invoicePushPreflight` is undefined.

- [ ] **Step 3: Implement**

Append to `xeroInvoices.ts`:

```ts
/**
 * Void one Xero invoice (refinement 8). Reads first: absent or already
 * VOIDED/DELETED is success (the desired end state holds); money applied is
 * `payment_linked` (the core's void-with-payments flow, #5180); DRAFT and
 * SUBMITTED are DELETED (Xero cannot void them); AUTHORISED is VOIDED.
 */
export async function voidXeroInvoice(ctx: XeroCallContext, remoteInvoiceId: string): Promise<InvoiceVoidResult> {
  const operation = 'Xero invoice void';
  const existing = await readXeroInvoice(ctx, remoteInvoiceId);
  if (!existing) return { remoteVersion: null };
  const status = existing.Status ?? '';
  if (GONE_STATUSES.has(status)) return { remoteVersion: parseXeroDate(existing.UpdatedDateUTC) };
  if (status === 'PAID' || moneyApplied(existing)) {
    throw new AccountingProviderError({
      kind: 'payment_linked', provider: 'xero', operation, message: `${operation} refused: a payment or credit is applied in Xero`,
    });
  }
  if (!LIVE_STATUSES.has(status)) {
    throw new AccountingProviderError({ kind: 'transient', provider: 'xero', operation, message: `${operation} found an unknown invoice status` });
  }
  const target = status === 'AUTHORISED' ? 'VOIDED' : 'DELETED';
  const res = requireXeroBody(
    await xeroApiWrite<InvoicesBody | null>(
      ctx, 'POST', `Invoices/${encodeURIComponent(remoteInvoiceId)}${WRITE_QUERY}`, { Invoices: [{ InvoiceID: remoteInvoiceId, Status: target }] }, operation,
    ),
    operation,
  );
  const updated = xeroArray<XeroInvoice>(res.Invoices)[0];
  if (updated?.HasErrors) {
    throw validation(operation, `${operation} was rejected by Xero`, updated.ValidationErrors?.find((v) => v?.Message)?.Message);
  }
  return { remoteVersion: parseXeroDate(updated?.UpdatedDateUTC) };
}
```

Add `InvoiceVoidResult` to the `./types` type import.

In `xeroProvider.ts`:

1. Import: `import { findPushedXeroInvoice, pushXeroInvoice, voidXeroInvoice, xeroInvoicePreflight } from './xeroInvoices';` and add `AccountingInvoicePreflightRefusal` to the `./types` import.
2. Update the file-header comment: "W04 ships invoice push and void (capability flipped in W04b)".
3. Replace the two stubs, and add the pre-flight right above them:

```ts
  invoicePushPreflight(
    conn: AccountingConnection,
    invoice: Pick<AccountingInvoicePayload, 'currencyCode' | 'taxTotal' | 'lines'>,
  ): AccountingInvoicePreflightRefusal | null {
    return xeroInvoicePreflight(conn, invoice);
  }

  async pushInvoice(
    conn: AccountingConnection,
    invoice: AccountingInvoicePayload,
    lineMappings: readonly AccountingInvoiceLineMapping[],
  ): Promise<InvoicePushResult> {
    return pushXeroInvoice(callContext(conn), conn, invoice, lineMappings);
  }

  async voidInvoice(
    conn: AccountingConnection,
    _invoice: AccountingVoidInvoicePayload,
    mapping: AccountingEntityMapping,
  ): Promise<InvoiceVoidResult> {
    return voidXeroInvoice(callContext(conn), mapping.remoteEntityId);
  }

  /** Refinement 22: lets a Breeze void reach a create whose response was lost. */
  async findRemoteInvoice(conn: AccountingConnection, invoiceId: string): Promise<{ id: string; remoteVersion?: string } | null> {
    return findPushedXeroInvoice(callContext(conn), invoiceId);
  }
```

4. Move the `// --- later waves …` comment below these two methods so it still heads only the W05 stubs.

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroInvoices.test.ts src/services/accounting/xeroProvider.test.ts src/services/accounting/providerRegistry.test.ts src/services/accounting/accountingInvoicePushCallSites.test.ts src/services/accounting/neutralCore.guard.test.ts && npx tsc --noEmit -p .`
Expected: PASS. (`xeroProvider.pushInvoice` is a method *definition*, not a call expression; the provider calls `pushXeroInvoice`, which the call-site contract does not count.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/accounting/xeroInvoices.ts apps/api/src/services/accounting/xeroInvoices.test.ts apps/api/src/services/accounting/xeroProvider.ts apps/api/src/services/accounting/xeroProvider.test.ts
git commit -m "feat(accounting): Xero invoice void and provider wiring, capability still off (Xero W04)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: W04a gate and PR

**Files:** none new.

- [ ] **Step 1: Full W04a gate**

```bash
git diff --stat origin/main -- 'apps/api/src/services/accounting/quickbooks*'   # expect: empty
git diff origin/main -- '*.test.ts' | grep '^-' | grep -c "QuickBooks"          # expect: 0 (no QuickBooks assertion edited)
cd apps/api && npx vitest run 2>&1 | tail -5 && npx tsc --noEmit -p .
wc -l src/routes/accounting/index.ts                                             # expect: ≤ Task 0 count
cd ../.. && pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/accounting src/__tests__/integration/tenantCascade 2>&1 | tail -5
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage 2>&1 | tail -3
cd ../.. && pnpm test-stack down
```

Expected: all green; the stack is down.

- [ ] **Step 2: Open PR W04a**

Push the branch. Title: `feat(accounting): Xero W04a — invoice push and void (server; capability off)`, body with `Part of #7171`. The body must include:
- Xero's capabilities after merge: unchanged from W03 (`connect, mapping, customerImport`); `invoicePush` flips in W04b;
- "QuickBooks byte-identical": the empty `quickbooks*` diff, the 11 relabelled messages (pinned by `accountingInvoicePushMessages.test.ts`), `quickbooksIdempotency.test.ts` unedited;
- the Task 0 differences from the assumption table, if any;
- the manual-mode bulk-push issue number from Task 0 Step 4;
- refinements 2, 3, 4, 5, 7, 12 in one line each (they change what the spec literally says).

Run `/pr-review-toolkit:review-pr`, fix confirmed findings in one round, post the summary. Merge through the queue when green (`gh pr merge <N>`).

---
# PR W04b — Web, capability flip, lab

### Task 9: The payment sync badge names its own provider (W01d deferral)

**Files:**
- Modify: `apps/api/src/services/invoiceService.ts` (`listPayments`, the `accountingSync` object at `:2153`)
- Modify: `apps/web/src/components/billing/invoiceTypes.ts` (`InvoicePayment.accountingSync`)
- Modify: `apps/web/src/components/billing/InvoiceDetail.tsx` (payment badge, `:713-727`)
- Test: `apps/api/src/services/invoiceService.test.ts`, `apps/web/src/components/billing/InvoiceDetail.test.tsx`

**Interfaces:**
- Consumes: M13, M14.
- Produces: payment rows' `accountingSync` is `{ status, lastError, provider: AccountingProviderId } | null` (API); the web type gains `provider?: AccountingProviderId` (optional: older API responses lack it).

- [ ] **Step 1: Write the failing tests**

`invoiceService.test.ts`, next to "classifies a BREEZE-ORIGIN mapped payment as manual, with its sync state attached" (reuse `queueListPayments`, `mapping`, `svc`, `actor`):

```ts
it("a Breeze-origin payment's sync state names the provider it was pushed to (Xero W04)", async () => {
  queueListPayments([{ id: 'pay1', method: 'check' }], [], [mapping({ syncStatus: 'synced', provider: 'xero' })]);

  const rows = await svc.listPayments('i1', actor);

  expect(rows[0]!.accountingSync).toEqual({ status: 'synced', lastError: null, provider: 'xero' });
});
```

`InvoiceDetail.test.tsx`, next to "badges a synced Breeze-origin payment and STILL offers the void button" (reuse its `fetchMock`, `json`, `issued`):

```ts
// W01d deferral "Invoice badge": the invoice-level sync read can fail
// transiently (the API returns accountingSync: null), and a user without
// accounting:manage never resolves a push provider — the badge used to read "In ".
it("names the payment's own provider when the invoice-level provider is unknown (Xero W04)", async () => {
  fetchMock.mockImplementation(async (input: string) => {
    if (input.endsWith('/payments')) return json({ data: [
      { id: 'p9', invoiceId: 'inv-1', amount: '120.00', method: 'cash', reference: null, receivedAt: '2026-06-18', note: null, createdAt: '', source: 'manual', accountingSync: { status: 'synced', lastError: null, provider: 'xero' } },
    ] });
    return json({ data: {} });
  });
  render(<InvoiceDetail detail={{ ...issued, accountingSync: null }} onChanged={vi.fn()} />);
  await waitFor(() => expect(screen.getByTestId('invoice-payment-p9')).toBeInTheDocument());

  expect(screen.getByTestId('invoice-payment-qbosync-p9')).toHaveTextContent('In Xero');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/invoiceService.test.ts` and `cd apps/web && npx vitest run src/components/billing/InvoiceDetail.test.tsx`
Expected: FAIL — the API row has no `provider`; the badge reads "In " (or the QuickBooks name from a stale fixture), not "In Xero".

- [ ] **Step 3: Implement**

`invoiceService.ts` (`listPayments`):

```ts
      accountingSync: mapping && mapping.breezeOrigin
        ? { status: mapping.syncStatus, lastError: mapping.lastError, provider: mapping.provider as AccountingProviderId }
        : null,
```

`invoiceTypes.ts`:

```ts
  accountingSync?: {
    status: 'pending' | 'synced' | 'error' | 'synced_with_tax_variance';
    lastError: string | null;
    /** The provider this payment was pushed to (its mapping's own connection). Absent on older API responses. */
    provider?: AccountingProviderId;
  } | null;
```

`InvoiceDetail.tsx`: directly below the `syncProviderName` declaration (`:78`), add

```tsx
  // A pushed payment's badge names the provider it was pushed to (W01d "Invoice
  // badge" deferral); the invoice-level name only for an older API response.
  const paymentBadgeProvider = (p: InvoicePayment): string =>
    p.accountingSync?.provider ? ACCOUNTING_PROVIDER_NAMES[p.accountingSync.provider] : syncProviderName;
```

and in the payment badge (`:723-727`) replace `{ provider: syncProviderName }` with `{ provider: paymentBadgeProvider(p) }` in all three calls (`providerSyncFailed`, `syncingToProvider`, `inProvider`). Import `InvoicePayment` from `./invoiceTypes` if the file does not already. The badge markup, class names and `data-testid` stay byte-identical.

- [ ] **Step 4: Run to verify they pass**

Run the two files again, then `cd apps/web && npx vitest run src/components/billing` and `npx astro check 2>&1 | tail -3` in `apps/web`.
Expected: PASS; every existing "In QuickBooks" assertion passes unedited.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/invoiceService.ts apps/api/src/services/invoiceService.test.ts apps/web/src/components/billing/invoiceTypes.ts apps/web/src/components/billing/InvoiceDetail.tsx apps/web/src/components/billing/InvoiceDetail.test.tsx
git commit -m "fix(billing): payment sync badge names the provider it was pushed to (Xero W04)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Flip `invoicePush`; real-DB proof

**Gate:** lab steps **X32**, **X34/X35** and **X38** (Task 11) have passed on this branch's `worktree-stack` with the flip applied locally. If X34/X35 show Xero rejecting a `TaxAmount` override, first commit `XERO_SEND_LINE_TAX_AMOUNT = false` (refinement 5; its unit test already covers that mode) and re-run X32–X35. If X32 or X38 fail, **stop**: do not flip; report the raw Xero response.

**Files:**
- Modify: `apps/api/src/services/accounting/xeroProvider.ts` (`capabilities`)
- Test: `xeroProvider.test.ts`, `providerRegistry.test.ts`
- Create: `apps/api/src/__tests__/integration/accountingXeroInvoicePush.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7; B1, B2; the seeding pattern of `accountingInvoicePushCurrency.integration.test.ts` (M-file on `main`).
- Produces: `xeroProvider.capabilities = { connect: true, mapping: true, customerImport: true, invoicePush: true, paymentPull: false, paymentPush: false }`.

- [ ] **Step 1: Write the failing tests**

`xeroProvider.test.ts` — replace W03's capability test and Task 7's "still does not declare invoicePush through W04a" with:

```ts
it('declares connect, mapping, customerImport and invoicePush (Xero W04)', () => {
  expect(xeroProvider.capabilities).toEqual({
    connect: true, mapping: true, customerImport: true, invoicePush: true, paymentPull: false, paymentPush: false,
  });
});
```

`providerRegistry.test.ts` — change W03's Xero assertion to:

```ts
it('Xero supports connect, mapping, customerImport and invoicePush only (Xero W04)', () => {
  expect(ACCOUNTING_CAPABILITIES.filter((cap) => providerSupports('xero', cap))).toEqual(['connect', 'mapping', 'customerImport', 'invoicePush']);
});
```

(Use the file's capability-list constant, as W03 did.)

`accountingXeroInvoicePush.integration.test.ts`:

```ts
/**
 * Real-DB proof of Xero invoice push and void (Xero W04). Xero's HTTP API is
 * mocked at the fetch boundary; everything else — the coordinator's phases,
 * the mapping row, RLS under a partner context, the unique index — is real.
 * setup.ts truncates tenant tables between tests, so every test seeds its own.
 */
import './setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { accountingConnections, accountingEntityMappings, invoiceLines, invoicePayments, invoices } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { upsertConnection } from '../../services/accounting/accountingConnectionService';
import { pushInvoiceToAccounting, voidInvoiceInAccounting } from '../../services/accounting/accountingInvoicePush';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const FAR_FUTURE_ACCESS = new Date(Date.now() + 60 * 60 * 1000);
const FAR_FUTURE_REFRESH = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

interface Fixture { partnerId: string; orgId: string; connectionId: string }

function partnerCtx(fx: Fixture): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: [fx.orgId], accessiblePartnerIds: [fx.partnerId], userId: null };
}
const runner = (fx: Fixture) => <T>(fn: () => Promise<T>) => withDbAccessContext(partnerCtx(fx), fn);

async function seed(settings: { exempt?: string | null } = {}): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id, currencyCode: 'GBP' });
    const conn = await upsertConnection(db, partner.id, 'xero', {
      realmId: 'ten-A', accessToken: 'live-access-token', refreshToken: 'live-refresh-token',
      accessTokenExpiresAt: FAR_FUTURE_ACCESS, refreshTokenExpiresAt: FAR_FUTURE_REFRESH,
      environment: 'production', homeCurrency: 'GBP',
    });
    await db.update(accountingConnections).set({
      defaultIncomeAccountRef: '200', defaultTaxCodeRef: 'OUTPUT2',
      defaultExemptTaxCodeRef: settings.exempt === undefined ? 'EXEMPTOUTPUT' : settings.exempt,
    }).where(eq(accountingConnections.id, conn.id));
    await db.insert(accountingEntityMappings).values({
      integrationId: conn.id, partnerId: partner.id, breezeEntityType: 'org', breezeEntityId: org.id,
      remoteEntityType: 'Customer', remoteEntityId: 'xc-1', remoteSyncToken: null, remoteCurrencyCode: 'GBP',
      linkStatus: 'confirmed', syncStatus: 'synced',
    });
    return { partnerId: partner.id, orgId: org.id, connectionId: conn.id };
  });
}

async function seedInvoice(fx: Fixture, opts: { taxable: boolean; taxTotal: string }): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const total = (Number('100.00') + Number(opts.taxTotal)).toFixed(2);
    const [inv] = await db.insert(invoices).values({
      partnerId: fx.partnerId, orgId: fx.orgId, invoiceNumber: 'INV-2026-0001', status: 'sent', currencyCode: 'GBP',
      issueDate: '2026-09-01', dueDate: '2026-10-01', subtotal: '100.00', taxTotal: opts.taxTotal, total,
    }).returning({ id: invoices.id });
    await db.insert(invoiceLines).values({
      invoiceId: inv!.id, orgId: fx.orgId, sourceType: 'manual', name: 'Managed support', description: 'Managed support',
      quantity: '1.00', unitPrice: '100.00', taxable: opts.taxable, lineTotal: '100.00', sortOrder: 0,
    });
    return inv!.id;
  });
}

async function invoiceMapping(fx: Fixture, invoiceId: string) {
  const rows = await withSystemDbAccessContext(() => db.select().from(accountingEntityMappings).where(and(
    eq(accountingEntityMappings.integrationId, fx.connectionId),
    eq(accountingEntityMappings.breezeEntityType, 'invoice'),
    eq(accountingEntityMappings.breezeEntityId, invoiceId),
  )));
  return rows;
}

const remote = (invoiceId: string, over: Record<string, unknown> = {}) => ({
  InvoiceID: 'xi-1', Type: 'ACCREC', InvoiceNumber: 'INV-2026-0001', Reference: `breeze:${invoiceId}`, Status: 'AUTHORISED',
  Contact: { ContactID: 'xc-1' }, CurrencyCode: 'GBP', SubTotal: 100, TotalTax: 20, Total: 120, AmountPaid: 0, AmountCredited: 0,
  UpdatedDateUTC: '/Date(1790000000000+0000)/', ...over,
});

describe('Xero invoice push and void — real Postgres (Xero W04)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  runDb('pushes an issued invoice: one lookup, one PUT; the mapping is synced with the Xero id and ISO version', async () => {
    const fx = await seed();
    const invoiceId = await seedInvoice(fx, { taxable: true, taxTotal: '20.00' });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(json({ Invoices: [remote(invoiceId)] }));

    await expect(pushInvoiceToAccounting(invoiceId, fx.partnerId, runner(fx))).resolves.toMatchObject({ remoteEntityId: 'xi-1', syncStatus: 'synced' });

    expect(fetchMock.mock.calls.map(([, init]) => (init as RequestInit).method)).toEqual(['GET', 'PUT']);
    const rows = await invoiceMapping(fx, invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      remoteEntityType: 'Invoice', remoteEntityId: 'xi-1', remoteSyncToken: new Date(1790000000000).toISOString(),
      remoteDocNumber: null, linkStatus: 'confirmed', syncStatus: 'synced', lastError: null,
    });
  });

  runDb('a lost create response is adopted in the same push; a later push resends by POST, never a second PUT', async () => {
    const fx = await seed();
    const invoiceId = await seedInvoice(fx, { taxable: true, taxTotal: '20.00' });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockRejectedValueOnce(new DOMException('t', 'TimeoutError'))
      .mockResolvedValueOnce(json({ Invoices: [remote(invoiceId)] }))
      .mockResolvedValueOnce(json({ Invoices: [remote(invoiceId)] }));
    await expect(pushInvoiceToAccounting(invoiceId, fx.partnerId, runner(fx))).resolves.toMatchObject({ remoteEntityId: 'xi-1' });

    vi.restoreAllMocks();
    const second = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [remote(invoiceId)] }))
      .mockResolvedValueOnce(json({ Invoices: [remote(invoiceId)] }));
    await expect(pushInvoiceToAccounting(invoiceId, fx.partnerId, runner(fx))).resolves.toMatchObject({ remoteEntityId: 'xi-1', syncStatus: 'synced' });
    expect(second.mock.calls.map(([url, init]) => [(init as RequestInit).method, url])).toEqual([
      ['GET', 'https://api.xero.com/api.xro/2.0/Invoices/xi-1?unitdp=4'],
      ['POST', 'https://api.xero.com/api.xro/2.0/Invoices/xi-1?unitdp=4&summarizeErrors=true'],
    ]);
    expect(await invoiceMapping(fx, invoiceId)).toHaveLength(1);
  });

  runDb('a missing exempt tax rate refuses before any Xero call and persists the reason (Review Focus 4)', async () => {
    const fx = await seed({ exempt: null });
    const invoiceId = await seedInvoice(fx, { taxable: false, taxTotal: '0.00' });
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(pushInvoiceToAccounting(invoiceId, fx.partnerId, runner(fx))).rejects.toMatchObject({ code: 'push_settings_incomplete', status: 409 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await invoiceMapping(fx, invoiceId)).toEqual([expect.objectContaining({
      syncStatus: 'error', remoteEntityId: null,
      lastError: 'Choose a tax rate for non-taxable lines in Integrations → Accounting → Xero, then push again',
    })]);
  });

  runDb('void: reads, voids, and stores the new remote version', async () => {
    const fx = await seed();
    const invoiceId = await seedInvoice(fx, { taxable: true, taxTotal: '20.00' });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(json({ Invoices: [remote(invoiceId)] }));
    await pushInvoiceToAccounting(invoiceId, fx.partnerId, runner(fx));
    vi.restoreAllMocks();

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [remote(invoiceId)] }))
      .mockResolvedValueOnce(json({ Invoices: [remote(invoiceId, { Status: 'VOIDED', UpdatedDateUTC: '/Date(1790000100000+0000)/' })] }));
    await voidInvoiceInAccounting(invoiceId, fx.partnerId, runner(fx));

    expect((await invoiceMapping(fx, invoiceId))[0]).toMatchObject({ remoteSyncToken: new Date(1790000100000).toISOString(), syncStatus: 'synced' });
  });

  runDb('creates no payment mapping for a Xero invoice until W05 (refinement 18)', async () => {
    const fx = await seed();
    const invoiceId = await seedInvoice(fx, { taxable: true, taxTotal: '20.00' });
    // Copy the invoice_payments insert from accountingPaymentPush.integration.test.ts (its required
    // columns); one 50.00 manual payment on this invoice, received today.
    await withSystemDbAccessContext(() => db.insert(invoicePayments).values({
      invoiceId, orgId: fx.orgId, amount: '50.00', method: 'cash', receivedAt: new Date().toISOString().slice(0, 10),
    }));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(json({ Invoices: [remote(invoiceId)] }));
    await pushInvoiceToAccounting(invoiceId, fx.partnerId, runner(fx));

    const paymentRows = await withSystemDbAccessContext(() => db.select().from(accountingEntityMappings).where(and(
      eq(accountingEntityMappings.integrationId, fx.connectionId),
      eq(accountingEntityMappings.breezeEntityType, 'payment'),
    )));
    expect(paymentRows).toEqual([]);
  });
});
```

(`upsertConnection` requires `provider` values the enum accepts — W02b made `'xero'` valid. If `invoicePayments` needs more NOT NULL columns than shown, copy them from `accountingPaymentPush.integration.test.ts`; the assertion is fixed.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroProvider.test.ts src/services/accounting/providerRegistry.test.ts` → FAIL (capability still false). `pnpm test-stack up`, then `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/accountingXeroInvoicePush.integration.test.ts` → the coordinator itself does not check capabilities, so these **pass already** (they prove the W04a code against Postgres); the capability pins are the red for this task. Record that in the PR body rather than inventing a red.

- [ ] **Step 3: Flip the capability**

```ts
  readonly capabilities = {
    connect: true,
    mapping: true,
    customerImport: true,
    // Xero W04: ACCREC invoice push and void.
    invoicePush: true,
    paymentPull: false,
    paymentPush: false,
  } as const;
```

- [ ] **Step 4: Run to verify they pass**

Run the two unit files and the integration file again; then `cd apps/api && npx vitest run src/routes/accounting src/jobs/accountingSyncWorker.test.ts src/services/invoiceService.test.ts`; then `pnpm test-stack down`.
Expected: PASS. Routes (`providerGateResponse(…,'invoicePush')`), producers (`resolveActiveConnectionFor(…,'invoicePush')` in `invoiceService`/`quoteAcceptService`) and the worker gate now admit Xero; nothing else changes.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/accounting/xeroProvider.ts apps/api/src/services/accounting/xeroProvider.test.ts apps/api/src/services/accounting/providerRegistry.test.ts apps/api/src/__tests__/integration/accountingXeroInvoicePush.integration.test.ts
git commit -m "feat(accounting): Xero declares invoicePush; real-DB proof of push, adoption, refusal, void (Xero W04)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Lab checklist section 4, W04b gate and PR

**Files:**
- Modify: `docs/integrations/xero-demo-verification.md` (append section 4 before `## Change log`; add a change-log line)

- [ ] **Step 1: Append the W04 checklist**

Insert before `## Change log`:

````markdown
## 4. W04 checklist — invoice push and void

Run on a `worktree-stack` of the W04b branch **with Task 10's capability flip applied locally** (it is committed only after X32, X34/X35 and X38 pass). Connected to the Demo Company, with sections 2–3 done: the settings step has a revenue account, a taxable tax rate (e.g. 20% VAT on Income) and an exempt one (e.g. No VAT), and at least one org and one catalog item are mapped. Record each result, with Xero's raw text where asked, in the table below.

| # | Step | Expected |
|---|---|---|
| X32 | Issue a Breeze invoice (2 lines: one taxable 100.00, one non-taxable 50.00; 20% tax) with **Push mode = manual**, then **Push to Xero** | One AUTHORISED sales invoice in Xero: same number, contact, dates, currency; lines on the chosen revenue account; tax types VAT / No VAT; **Subtotal 150.00, Tax 20.00, Total 170.00**. Card: "Synced". **GATE** — if this fails, stop and record the raw response |
| X33 | Push mode = auto; issue another invoice, then record a 50.00 payment on it | Invoice appears in Xero without a click. **No** payment appears in Xero, and the payment row shows **no** sync badge (paymentPush is off until W05) |
| X34 | An invoice whose tax does not split evenly: three taxable lines of 1.00, tax 0.10 at a 3.333% rate typed into the invoice | Xero shows line tax 0.04 / 0.03 / 0.03 and Tax 0.10; no "tax adjusted" warning blocks approval. **GATE** (open item 1). Record whether Xero shows a "tax adjusted" note |
| X35 | A taxable line of **10 × 0.50** (line total 5.00) at 20% → line tax 1.00, which exceeds the unit price | Accepted with TaxAmount 1.00. **GATE**. If Xero refuses ("TaxAmount specified cannot be greater than the UnitAmount"), set `XERO_SEND_LINE_TAX_AMOUNT = false`, re-run X32–X35, and record the drift result instead |
| X36 | A line of **1.50 h × 10.95** (Breeze total 16.43) | Xero shows quantity 1, unit 16.43, description ending "(1.50 × 10.95)"; totals equal Breeze. Separately in Postman, `PUT` a DRAFT with Quantity 1.5 × UnitAmount 10.95 and record Xero's LineAmount (16.42 or 16.43 → its rounding mode) |
| X37 | API log of X32's push | The first call is `GET Invoices?where=Reference=="breeze:<id>"` and returns 200 (record the time taken). If Xero rejects `==`, record the error and try the documented single `=` |
| X38 | Create a Xero invoice by hand numbered like the next Breeze invoice (e.g. INV-2026-0042); then issue and push that Breeze invoice | Pushed **without** the number; Xero assigns its own (e.g. INV-0012); the card shows "Xero document INV-0012". **GATE**. Record the raw duplicate-number message |
| X39 | In Xero, apply a payment to X32's invoice; then **Void** it in Breeze | Card: "Xero will not void this invoice because a payment is applied to it there — remove or unapply that payment in Xero, then void the invoice again"; no retries in the worker log. Then, in Postman, `POST {Status:'VOIDED'}` on that invoice and record Xero's raw message |
| X40 | Void an unpaid pushed invoice in Breeze; then void it again (re-enqueue from the worker or repeat the void). Then: create a DRAFT in Postman, point a pushed Breeze invoice's mapping at it (`update accounting_entity_mappings set remote_entity_id = '<DraftInvoiceID>' where …`), and void that Breeze invoice | Xero: VOIDED; the second void makes no write (API log: one GET). The DRAFT ends **DELETED**, not VOIDED (Xero cannot void a draft) |
| X41 | Postman: `POST /Invoices` (collection URL, no id) with an existing InvoiceNumber and different lines, on a throwaway DRAFT | Record whether Xero edits that invoice (refinement 1). Breeze never does this — it creates with PUT and updates by InvoiceID |
| X42 | Postman: create an AUTHORISED invoice with Reference `breeze:<id>` for a Breeze invoice that has not been pushed, matching its totals; then push it from Breeze. Then: with Breeze's mapping row set back to `error` and `remote_entity_id` null (psql), void that Breeze invoice | No second invoice: API log shows the lookup GET and a POST resend, no PUT; card "Synced". The void finds the invoice by Reference and voids it; the mapping now holds its InvoiceID (refinement 22) |
| X43 | A tax-exempt organisation's invoice (tax 0.00, lines flagged taxable) | Every line on the exempt tax type; Tax 0.00 |
| X44 | Postman: `PUT /Invoices` of an invalid invoice (bad AccountCode) **without** `summarizeErrors` | Record the status code (200 with HasErrors, or 400) — the real default (refinement 13) |
| X45 | Clear the exempt tax rate in the settings step; push an invoice with a non-taxable line | Card: "Choose a tax rate for non-taxable lines in Integrations → Accounting → Xero, then push again"; API log: **no** Xero call for this push |
| X46 | Open X32's invoice as PDF and as the online invoice (default branding theme) | Record whether "breeze:<id>" appears as the Reference (refinement 11) |

### W04 Results

| # | Result | Notes / raw Xero text |
|---|---|---|
| X32 | | |
| X33 | | |
| X34 | | |
| X35 | | |
| X36 | | |
| X37 | | |
| X38 | | |
| X39 | | |
| X40 | | |
| X41 | | |
| X42 | | |
| X43 | | |
| X44 | | |
| X45 | | |
| X46 | | |
````

Append to `## Change log`: `- W04 — invoice push and void (X32–X46); X32, X34/X35 and X38 gate the invoicePush capability flip.`

- [ ] **Step 2: Full W04b gate**

```bash
git diff --stat origin/main -- 'apps/api/src/services/accounting/quickbooks*'   # expect: empty
cd apps/api && npx vitest run 2>&1 | tail -5 && npx tsc --noEmit -p .
wc -l src/routes/accounting/index.ts                                             # expect: ≤ Task 0 count
cd ../web && npx vitest run 2>&1 | tail -5 && npx astro check 2>&1 | tail -3
cd ../.. && pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/accounting src/__tests__/integration/tenantCascade 2>&1 | tail -5
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage 2>&1 | tail -3
cd ../.. && pnpm test-stack down
```

Expected: all green; the stack is down.

- [ ] **Step 3: Commit, then open PR W04b**

```bash
git add docs/integrations/xero-demo-verification.md
git commit -m "docs(accounting): Xero W04 lab checklist (X32–X46)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Title: `feat(accounting): Xero W04b — invoice push capability flip, payment badge, lab`, with `Closes #7171`. The body must include:
- the Xero capabilities after merge: `connect, mapping, customerImport, invoicePush`;
- "No QuickBooks-visible change" (refinement 16; the `quickbooks*` diff is empty);
- X32–X46 results, **or** "lab pending" with the owner named. **X32, X34/X35 and X38 block merge** (they gate the flip); if X35 forced `XERO_SEND_LINE_TAX_AMOUNT = false`, say so;
- the note that Task 10's integration suite was green before the flip (the coordinator does not read capabilities; the pins were the red).

Run `/pr-review-toolkit:review-pr`, fix confirmed findings in one round, post the summary. After merge, run `complete_wave` for #7171.

---

## Advisor quorum (2026-09-27)

Fable draft, then an independent Codex review (`codex exec -s read-only -c model_reasoning_effort=high`, model `gpt-6-astra`) against this plan, the spec, the seam files on `main` (`accountingInvoicePush.ts`, `accountingInvoicePushErrors.ts`, `accountingInvoiceTotals.ts`, `types.ts`, `quickbooksProvider.ts`, `accountingSyncWorker.ts`, `routes/accounting/index.ts`, `invoiceService.ts`, `accountingPaymentPush.ts`), W02a's `xeroHttp.ts`/`xeroProvider.ts` and the W03 plan. Codex raised 8 findings (3 P1, 4 P2, 1 P3). Each was checked against the code; all 8 are real. 7 are adopted in full; finding 5 is adopted as a corrected claim instead of a change to the shared tolerance. The Xero facts were verified separately against Xero's own documentation (URLs in "Where this plan refines the spec").

| # | Finding | Disposition |
|---|---|---|
| 1 | Request-derived keys (W03's `xeroIdempotencyKey`) hash mutable settings and item accounts; Phase 1b re-claims a `pending` row (`accountingInvoicePush.ts:478`), so two concurrent pushes with different bodies both miss adoption and, with the number taken, both create numberless invoices | **Adopted.** Key per request identity, `xeroInvoiceIdempotencyKey(tenant, invoiceId, variant, supersededIds)` (the spec's own shape); Xero's "used with a different request" 400 is `transient` → look again → adopt (refinement 2; Task 4 classification; Task 6 "a concurrent push with a different body…") |
| 2 | The numberless fallback reused the first lookup's `supersededIds`, so a predecessor voided in between could replay its cached response | **Adopted.** `lookAgain` refreshes the superseded ids and the next create keys on them (Task 6 "keys on the superseded ids of the LATEST lookup") |
| 3 | A create whose response and recovery lookup both fail leaves `error` with no remote id; `voidInvoiceInAccounting` then no-ops (`:995`) and a live Xero invoice survives a Breeze void | **Adopted.** Optional `findRemoteInvoice`; the void looks the invoice up by Reference outside any DB context, voids it and records the id (refinement 22; Tasks 1, 2, 6, 7; lab X42). QuickBooks declares none — unchanged |
| 4 | Equal totals do not prove identical content; a no-op would keep a wrong due date, account or tax type | **Adopted.** An unpaid invoice is always resent; only a locked (paid-toward) invoice is compared, and accepted only with Breeze's amounts (refinement 7; Task 6 re-push tests; Task 10 integration expects GET + POST) |
| 5 | `computeRemoteVariance` tolerates 1¢, so Review Focus 3's "never plain synced" was false | **Adopted as a corrected claim.** The tolerance is a shared contract with QuickBooks and stays; Review Focus 3 now says so, the amounts are exact by construction (refinements 3, 5), and lab X34–X36 check exact totals. Listed under "Deliberately not in W04" |
| 6 | Task 10 (bulk push 404) changed a shared QuickBooks route and dropped its audit row | **Adopted.** The task is removed; W01d R14 stays parked (refinement 16); W04 now has no QuickBooks-visible change |
| 7 | `ReturnType<typeof vi.spyOn>` leaves the destructured call tuple `any` (TS7031) | **Adopted.** `callsOf` takes `{ mock: { calls: unknown[][] } }` and casts each call (Task 6) |
| 8 | Lab X40 expected an adopted-then-approved DRAFT to end DELETED; it is AUTHORISED by then, so VOIDED is right | **Adopted.** X40 now points a mapping at a still-DRAFT invoice to prove DELETED |

## Self-review (done while writing; kept for the executor)

**Spec coverage (§W04):** `PUT/POST /Invoices?unitdp=4` (Tasks 6–7; `summarizeErrors=true` added, refinement 13). The spec's field table: `Type ACCREC`, `Contact.ContactID`, `Date`/`DueDate` (fallback to `txnDate`), `InvoiceNumber`, `CurrencyCode`, `Status AUTHORISED`, `LineAmountTypes Exclusive`, `Reference breeze:<invoiceId>`, line `Description`/`Quantity`/`UnitAmount`, `ItemCode`, `AccountCode` (item's account → default), `TaxType` (taxed ? taxable : exempt), `TaxAmount` (allocated) — all in Task 5's `buildXeroInvoice` and its table test; `Quantity`/`UnitAmount` refined for exactness (refinement 3), "taxable" refined to "taxed" (refinement 4). Tax allocation pro rata, largest remainder, cents sum exactly (Task 3, with the property test the spec's Testing section asks for; minor units for JPY). `TotalTax`/`Total` feed `remoteTaxTotal`/`remoteTotal` and the existing drift check (Task 5 `toXeroPushResult`; `computeRemoteVariance` unchanged). Idempotency: one key per request variant, keyed on the request's identity rather than its bytes (refinement 2, Task 6 key tests), adoption by `Reference` before every create and after every uncertain outcome (Task 6). Duplicate invoice number: adoption look, then a single numberless retry under its own key, recorded as `remote_doc_number` (refinement 9, Task 6; lab X38). Push preconditions fail fast with a persisted message (refinement 6; Tasks 1, 2, 5). Void: AUTHORISED → VOIDED, DRAFT → DELETED, payments → `payment_linked` → the existing void-with-payments flow, returned `UpdatedDateUTC` persisted as remote version (Task 7; `voidInvoiceInAccounting`'s existing persist). Re-push updates the adopted invoice — refined to read first, resend when unpaid, accept or refuse when locked (refinement 7, Task 6). A void also reaches a create Breeze never recorded (refinement 22, Tasks 1, 2, 6, 7). Capability `+ invoicePush` (Task 10). Totals invariant: pre-push line sum (existing `assertPushedLinesMatchSubtotal`, now joined by Xero's allocation pre-flight) and post-push tax **and** total compare (existing `computeRemoteVariance`, fed by Task 5). Open items 1–2 settled in the lab (X34/X35, X38), both gating the flip. Cross-wave: QuickBooks byte-identical (Global Constraints; Tasks 1–2 pins), capabilities gate every layer (unchanged gates; flip in Task 11), no new tables (refinement 19). W01d deferrals taken: invoice push/void and the QuickBooks-worded coordinator messages (Tasks 1–2), the invoice badge (Task 9); bulk push R14 was considered and stays parked (refinement 16).

**Placeholder scan:** no TBD or "similar to". Two test bodies name helpers from existing test files whose exact names this author could not see (`jobs/accountingSyncWorker.test.ts`'s mocked coordinator and one-job runner; the `invoicePayments` NOT NULL columns in Task 10): each gives fixed assertions and says to use the file's real names — the same convention the W02/W03 plans used.

**Type consistency:** `invoicePushMessages` (Task 1) is used by Task 2 only. `AccountingInvoicePreflightRefusal` / `invoicePushPreflight?` (Task 1) are produced by `xeroInvoicePreflight` (Task 5), wired in Task 7, consumed in Task 2's Phase 1. `findRemoteInvoice?` (Task 1) is implemented by `findPushedXeroInvoice` (Task 6), wired in Task 7 and called by the void in Task 2. The five `AccountingInvoicePushErrorCode`s (Task 1) are thrown in Task 2 and listed in `TERMINAL_CODES` / `INVOICE_USER_RESOLVABLE_CODES` (Task 2). `remote_locked` (Task 1) is thrown by Task 6 and mapped by Task 2's `invoicePushRefusal`. `allocateInvoiceTax` / `isZeroAmount` (Task 3) are used by Task 5. `classifyXeroInvoiceKind` (Task 4; its `transient` verdict for key reuse) and `readXeroItemRefs` / `XeroItemRef` (Task 4) are used by Task 6. `xeroInvoiceIdempotencyKey` (Task 6) is the only key an invoice create sends. `XeroInvoice`, `buildXeroInvoice`, `toXeroPushResult`, `xeroInvoiceReference` (Task 5) are used by Tasks 6–7. `pushXeroInvoice` / `voidXeroInvoice` (Tasks 6–7) are called only by `xeroProvider.ts` (Task 7). `InvoicePayment.accountingSync.provider` (Task 9) is produced by `listPayments` and read by `paymentBadgeProvider`.

**Review Focus → tests:** 1 → Task 6 "a second push adopts instead of creating" / "adopts after a timed-out create" / "a concurrent push with a different body gets the key-reuse 400 and adopts" / the key tests; Task 4 key-reuse → `transient`; Task 10 "a lost create response is adopted…". 2 → Task 4 classification; Task 6 "duplicate number owned by our own lost create is adopted" / "numberless retry under its own key"; lab X38. 3 → Task 3 property + large-invoice tests; Task 5 `xeroLineAmounts` table; Task 5 `toXeroPushResult` totals; lab X34–X36. 4 → Task 2 "a preflight settings refusal is persisted and stops before…"; Task 5 preflight table; Task 10 "a missing exempt tax rate refuses before any Xero call"; lab X45. 5 → Task 7 void table (money applied, already VOIDED/DELETED, 404, DRAFT → DELETED); Task 2 void pins; lab X39–X40.

**Deliberately not in W04:**
- payment push/pull and the Xero webhook (W05) — `paymentPush` stays false, so the invoice fan-out creates nothing (refinement 18);
- detecting a Xero-side void of a pushed invoice before the next push (W05's reconcile; until then a re-push reports `remote_missing`);
- tracking categories, branding themes, `RoundingAmount`, `CurrencyRate` (Xero uses its day rate; the currency guard already refuses non-home currencies unless multi-currency is enabled);
- changing the `Reference` adoption key (refinement 11 — a cross-wave contract);
- fixing manual-mode bulk push (filed in Task 0 Step 4; QuickBooks behaviour), and bulk push without a connection (W01d R14, refinement 16);
- the same "void of an unrecorded create" gap for QuickBooks (it has no invoice adoption key; its `requestid` replay only protects the push) — a candidate follow-up for the QuickBooks provider;
- a provider-specific variance tolerance: 1¢ stays `synced` for both providers (quorum finding 5);
- classifying Xero's "approve limit reached" plan refusal (Starter orgs) — it surfaces as the generic "Xero rejected the invoice sync (HTTP 400: …)" with Xero's own text; a candidate follow-up;
- the Xero apps/docs feature page (spec "Rollout").
