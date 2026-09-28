---
spec: docs/superpowers/specs/billing/2026-09-26-xero-accounting-integration-design.md
index: docs/superpowers/plans/billing/2026-09-26-xero-accounting-integration-index.md
tracking_issue: LanternOps/breeze#7167
wave_issue: LanternOps/breeze#7172
---

# Xero W05: Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Payments flow both ways between Breeze and a connected Xero organisation. A payment recorded in Xero against an invoice Breeze pushed appears in Breeze. It arrives through a signed `/webhooks/xero` doorbell and an `If-Modified-Since` pull, with the 15-minute sweep as the backstop. A payment recorded in Breeze is created in Xero against the chosen bank account, and a Breeze void deletes it there. After this wave Xero declares `paymentPull` and `paymentPush`.

**Architecture:** The provider-neutral pieces already exist, with QuickBooks as the reference: the reconcile worker and applier (`accountingReconcileWorker.ts`, `accountingPaymentPull.ts`), the outbox coordinator (`accountingPaymentPush.ts`), the webhook router (`accountingWebhookRouting.ts`) and the sync worker. W05 fills the five Xero stubs W02a left: `reconcileChanges`, `createPayment`, `deletePayment`, `verifyWebhook` and `paymentMarker`. The Xero wire logic goes in one new module, `xeroPayments.ts`, built on W03's `xeroApiWrite` and W04's refusal classification. The new public route `routes/webhooks/xero.ts` checks the HMAC over the raw body before it parses anything or looks up any tenant. It then hands each signed `INVOICE` event's tenant id to the shared router, which enqueues a *delayed*, deduplicated reconcile job. The webhook is only a doorbell. The pull decides what changed, and it is idempotent, so W05 needs no event ledger. The core gains only neutral pieces:

- an optional enqueue delay;
- a daily-budget deferral for webhook-triggered runs;
- an optional synchronous `paymentPushPreflight` hook (a missing bank account parks the payment without any Xero call);
- seven payment refusal codes that are terminal (all but one quiet);
- provider-labelled payment operator text (QuickBooks byte-identical);
- the two renames W01d deferred.

The capabilities flip in the last PR, after the lab proves the webhook handshake, a real pull, a real push and the reference round-trip against the Xero Demo Company.

**Tech Stack:** TypeScript, Hono, Drizzle ORM on PostgreSQL (partner-axis RLS), BullMQ + ioredis, Vitest, React (Astro islands) + react-i18next.

**Spec:** `docs/superpowers/specs/billing/2026-09-26-xero-accounting-integration-design.md`. W05 uses these sections: "W05 — Payments", "Webhooks" (W01), "Rate limiting", "Scope boundaries" (overpayments, prepayments, credit notes out), and the cross-wave adoption rule. Upstream contracts:

- W01: `2026-09-26-xero-w01-core-neutralization.md`
- W02: `2026-09-26-xero-w02-connection.md`
- W03: `2026-09-27-xero-w03-contacts-items-import.md` (on `main`, PR #7236)
- W04: `2026-09-27-xero-w04-invoice-push-void.md` (PR #7248, branch `docs/xero-w04-plan`; **not merged** when this plan was written)

---

## Preconditions (hard gates, check before Task 0)

1. **W02 (a, b, c), W03 (a, b) and W04 (a, b) are merged to `main`.** W05a builds on these:
   - W02a's `xeroHttp.ts` / `xeroProvider.ts` / `xeroWebhookKey()`
   - W02b's registration of Xero and its realm fingerprint on connect
   - W03a's `xeroApiWrite`, `parseXeroDate`, `xeroQuery`, `requireXeroBody`, `xeroArray`, `classifyXeroValidation` and refusal codes
   - W04a's `remote_locked` refusal code, `classifyXeroInvoiceKind` (key reuse → `transient`), `accountingInvoicePushMessages.ts` pattern and `INVOICE_USER_RESOLVABLE_CODES`
   - W04b's capability flip. Xero must already declare `invoicePush`: payments are only created against pushed invoices, and the lab needs one.

   W05 does **not** stack on any of them.
2. **W02c's lab document exists** (`docs/integrations/xero-demo-verification.md`) with W03's section 3 and W04's section 4 appended (rows X1–X46). W05c appends section 5 (X47–X64).
3. **Feature-lifecycle:** run `get_feature_status` for #7167. Branch `feature/7167-xero/wave-7172-a-pull`, then `…-b-push`, then `…-c-web`. Run `start_wave` for #7172 when W05a starts, **not before**. This plan's author did not start the wave.
4. **The hosted Xero app has a webhook signing key.** In the Xero developer portal, open the app's Webhooks page and subscribe to **Invoices** (Contacts is not needed). The delivery URL is `https://<region-host>/api/v1/webhooks/xero`. `XERO_WEBHOOK_KEY` must be set on the lab stack (W02a registered the variable; it has never been read). This is an owner action for EU/US and a lab setup step for W05c. It does not block W05a/W05b: until the flip, the route answers but routes nothing.

```bash
git fetch origin main
git log origin/main --oneline | grep -iE 'xero w0[234]|#716[9]|#717[01]' | head -20
git ls-tree --name-only origin/main apps/api/src/services/accounting/ | grep -E '/(xeroHttp|xeroProvider|xeroContacts|xeroItems|xeroInvoices|retryAfter)\.ts$'
```

Expected: the W02a/b/c, W03a/b and W04a/b squash commits are listed, and all six files exist on `main`. If anything is missing, stop: the premise does not hold.

## Interface assumptions (re-verify every line in Task 0)

W05 calls these by the exact names below. The row prefix says where each was read:

- **M** rows were read from `main` at `9b92349aa1` on 2026-09-27. W01 and W02a were merged.
- **B** rows come from the W02 plan text for W02b/W02c. Those parts were being implemented and were not on `main`.
- **C** rows come from the W03 plan text (on `main` as a doc; its code was not merged).
- **D** rows come from the W04 plan text (PR #7248, not merged).

If a name or shape differs on `main`, follow `main`. Adapt the task that uses it and record the difference in the PR body. Never rename the upstream symbol back.

| # | Symbol (file) | Shape W05 relies on | Source |
|---|---|---|---|
| M1 | `AccountingProvider.reconcileChanges(conn, sinceCursor)`, `.createPayment(conn, payment)`, `.deletePayment(conn, payment)`, `.verifyWebhook(sig, rawBody, key)`, `.paymentMarker`, `.limits` (`services/accounting/types.ts`) | as quoted in Tasks 3, 4, 9; obligations 1–4 in the interface doc comment (only `AccountingProviderError`; `already_absent` absorbed; `extract(embed(ref, marker))` recovers the id for any `ref`; `paymentRefMax` caps the RAW reference) | main |
| M2 | `ChangeSet { cursor, payments, deletedPayments, unappliedPayments, deletedInvoices, overflowed }`, `ChangeSetPaymentLine { remoteInvoiceId, remotePaymentId, amountMinor, currency, txnDate, remotePaymentVersion, paymentMethodName, method, paymentRefNum, breezePaymentId }`, `AccountingPaymentPayload { invoicePaymentId, remoteCustomerId, remoteInvoiceId, amount, currencyCode, txnDate, reference, marker, pushGeneration }`, `AccountingDeletePaymentPayload { remotePaymentId, remoteVersion }`, `PaymentDeleteResult` | as named | main |
| M3 | `routeWebhookToConnection(provider, realmFingerprint)` → `'enqueued' \| 'enqueue_failed' \| 'no_connection' \| 'capability_unavailable'` (`accountingWebhookRouting.ts`) | system-scoped lookup via `findConnectionByRealmFingerprint`; checks `providerSupports(…, 'paymentPull')`; must be called with no ambient DB context | main |
| M4 | `enqueueAccountingReconcile(connectionId, partnerId, trigger)` + `ENQUEUE_OPTS` (`jobs/accountingReconcileWorker.ts:742-777`) | jobId `accounting-reconcile-<connectionId>`; `{ attempts: 5, backoff: exponential 5000, removeOnComplete: true, removeOnFail: true }` | main |
| M5 | `processReconcileConnectionJob(data, ctx?)`, `classifyReconcileSkip`, `ReconcileSkipReason`, `logReconcileSkip`, the `overflowed` `runError` literal and Sentry text (`accountingReconcileWorker.ts:293-520`) | as quoted in Task 1 | main |
| M6 | `shouldDeferBackgroundWork(provider, spec, connectionId)` (`accountingRateLimit.ts:329`) | `false` when `spec.dailyPerConnection` is null (QuickBooks) | main |
| M7 | `routes/webhooks/quickbooks.ts` | the shape the Xero route mirrors: IP limiter, raw body first, missing-key 503 with throttled `captureMessage`, signature 401, parse 400, dedupe + cap 50, per-realm `routeWebhookToConnection`, any enqueue failure 503 | main |
| M8 | Public-route registries: `EXEMPT` in `__tests__/routerAuthGate.contract.test.ts`, `ROUTE_MCP_COVERAGE`-style map in `services/mcpCoverage.ts` (`'webhooks/quickbooks.ts': { exempt: 'inbound_integration' }`), `routes/webhooks.mountOrder.test.ts` `buildApp()`, `scripts/docs-review/mapping.json` | as named | main |
| M9 | `bodyLimitForPath(path)` (`middleware/bodyLimit.ts`) | an unlisted path → `{ rule: 'default', maxSize: 1 MB }` | main |
| M10 | `SENTRY_EVENT_CODES` list (`services/sentryEventCodes.ts`, integrations block) | `'accounting_webhook_verifier_token_missing'` exists; `captureMessage(msg, { eventCode })` | main |
| M11 | `hmacFingerprint(value)` (`services/secretCrypto.ts:148`) | `fp1:<keyId>:<hex>` | main |
| M12 | `accountingPaymentPush.ts`: `pushPaymentToAccounting` Phase 1 order (lease → connection → payment/invoice → `invoice_void` → `invoice_not_synced` → `customer_not_mapped` → currency guard → payload, `:1612-1746`); `reference.slice(0, limits.paymentRefMax)` (`:1736`); the create `catch` (`:1758-1776`); the delete `catch` (`:2119-2150`); `markPaymentMappingError(mappingId, partnerId, message, { clearPendingOp, countAttempt? })` (`:964`); `markPaymentMappingErrorInOwnContext(run, …)` (`:1099`); `AccountingPaymentPushErrorCode` (`:237-252`); `AccountingPaymentPushError(code, status, message, opts)` (`:254`); `logProviderFault` | as named. **The coordinator never branches on `err.kind`** except `rate_limited`; every other provider error is a retryable 502 `provider_error` with Sentry | main |
| M13 | The 13 QuickBooks-worded operator strings in `accountingPaymentPush.ts` (`:122`, `:134-135`, `:195-197`, `:202-203`, `:208`, `:218`, `:381`, `:1636`, `:1680`, `:1703`, `:1901`, `:1992`, `:2163`) | Task 6 rebuilds each from the provider label | main |
| M14 | `jobs/accountingSyncWorker.ts`: `PAYMENT_TERMINAL_CODES` (`:164-173`), the payment-job `catch` (`:365-381`, terminal → `console.error` + `captureException`), capability `paymentPush` gate for `push-payment`/`delete-payment` | as quoted in Task 6 | main |
| M15 | `accountingPaymentPull.ts`: `applyAccountingPayment`, `reverseAccountingPayment`, `reverseStaleAllocations`, `markInvoiceDeletedRemotely`; replay by exact string equality of `remoteSyncToken === line.remotePaymentVersion` (`:558`, `:721`); adoption needs `line.breezePaymentId` plus a pending/orphaned Breeze-origin row on the same invoice for the same minor amount (`:806-903`); `invoice_payments.reference` is `varchar(255)` | as named | main |
| M16 | `buildPaymentPrivateNote(id)` = `'Breeze payment ' + id`; `parseBreezePaymentMarker(text)` (anchored whole-string, lowercase uuid) (`accountingPaymentMarker.ts`) | as named | main |
| M17 | `invoiceService.voidPayment`: `QUICKBOOKS_OWNED_PAYMENT` 409 (`:1979`), `quickbooksRecordUntouched` (`:1951-2046`), audit action `invoice.payment.voided_quickbooks_untouched`; `routes/invoices/payments.ts:52-57`; `invoiceTypes.ts:97`; web `InvoiceDetail.tsx:270-283` | Task 7 renames | main |
| M18 | `toMinorUnits(amount, currency)` from `@breeze/shared`; `PAYMENT_METHODS = ['cash','check','bank_transfer','card','other']` | as named | main |
| M19 | `xeroApiGet<T>(ctx, path, operation)`, `XeroCallContext { connectionId, tenantId, accessToken, rate, timeoutMs? }`, `xeroApiError(operation, status, headers, text)`, `XERO_API_BASE` (`xeroHttp.ts:353`) | as named; `response.ok` false → error | main (W02a) |
| M20 | `xeroProvider.ts`: `callContext(conn, timeoutMs?)`, `XERO_RATE_LIMIT`, stubs `createPayment`/`deletePayment`/`reconcileChanges` calling `notYet(…, 'W05')`, `verifyWebhook` returning `false`, `paymentMarker` throwing, `limits = { paymentRefMax: 255, rate }` | as named | main (W02a) |
| M21 | `xeroWebhookKey(): string` (`config/env.ts:379`) | `''` when unset | main (W02a) |
| B1 | `providerRegistry.ts` registers `xero: xeroProvider`; after W04b, `providerRegistry.test.ts` pins Xero's capabilities as `['connect','mapping','customerImport','invoicePush']` | W05c edits the pin | W02b Task 10 + W04b |
| B2 | A Xero row's `realm_id_fingerprint = hmacFingerprint(tenantId)`, **unnormalised**. On `main`, `upsertConnection` fingerprints the raw `realmId` (`fingerprintField`, `accountingConnectionService.ts:132-136`, `:451`). W02b's pending-tenant claim must write the same, with the `tenantId` string exactly as `GET /connections` returned it | the webhook looks the connection up by `hmacFingerprint(event.tenantId)`; lab X50 proves the two strings match | main + W02b Task 6/7 |
| B3 | `AccountingConnection.defaultPaymentAccountRef` holds a Xero bank **`AccountID`** (the settings step's `bankAccounts` options use `ref = AccountID`) | `Account: { AccountID }` | W02a + W02c Task 12 |
| B4 | Web `AccountingSettingsStep` (`apps/web/src/components/integrations/AccountingSettingsStep.tsx`), props include the connection status; field row `{ field: "defaultPaymentAccountRef", labelKey: "paymentAccount", source: "bankAccounts" }`; i18n namespace `integrations`, key prefix `accountingSettings.*`; save test id `xero-settings-save` | W05c adds one warning | W02c Task 12 |
| B5 | `AccountingConnectionPanel.tsx` gates the `${provider}-pullpayments` / `${provider}-pushpayments` switches on `caps.paymentPull` / `caps.paymentPush` | unchanged; the flip makes them appear | W02c Task 11 |
| C1 | `xeroApiWrite<T>(ctx, method: 'PUT' \| 'POST', path, body, operation, opts?: { idempotencyKey?: string })`; a `PUT` without an explicit key gets a request-derived key | W05 always passes an explicit key on a payment `PUT` | W03 Task 2 |
| C2 | `parseXeroDate(value): string \| null` (`/Date(ms±zzzz)/` → ISO-8601), `xeroQuery(params: Record<string, string \| number \| boolean \| undefined>): string` (returns `''` or `'?a=1&b=…'`, so a path is `Payments${xeroQuery(…)}`), `requireXeroBody(body, operation)`, `xeroArray<T>(value): T[]` (`xeroHttp.ts`) | as named | W03 Task 2 |
| C3 | `classifyXeroValidation(text)` returns a refusal code for a 400 (`duplicate_name`, `duplicate_key`); `xeroApiError` sets `providerCode` only when `kind === 'validation'`; private `allValidationMessages(text)` | Task 8 extends `classifyXeroValidation` | W03 Task 2 |
| C4 | `ACCOUNTING_REFUSAL_CODES` / `AccountingRefusalCode` (`accountingProviderError.ts`), `refusalCodeOf(err)` (kinds `validation` and `not_found` only), `providerPermissionMessage(label)` | Task 6 appends `amount_exceeds_due` | W03 Tasks 1, 5 |
| D1 | `ACCOUNTING_REFUSAL_CODES` includes `remote_locked` | used for a reconciled payment | W04 Task 1 |
| D2 | `apiKindFor(status, headers, text)` consults `classifyXeroInvoiceKind(text)` for a 400: `Idempotency Key: … is used with a different request.` → `transient` | a payment create relies on it | W04 Task 4 |
| D3 | `xeroInvoiceReference(invoiceId)` = `'breeze:' + invoiceId`; invoice mappings hold the Xero `InvoiceID` as `remote_entity_id` | payments look up by that id | W04 Task 5 |
| D4 | `INVOICE_USER_RESOLVABLE_CODES` in `jobs/accountingSyncWorker.ts` (terminal, no Sentry) | Task 6 adds the payment twin next to it | W04 Task 2 |
| D5 | `accountingInvoicePushMessages.ts` pattern: a function of the display label per string, with a table test proving `fn('QuickBooks')` equals the pre-change literal | Task 6 copies it | W04 Task 1 |
| D6 | `docs/integrations/xero-demo-verification.md` sections 0–4, rows X1–X46, `## Change log` | Task 13 appends section 5 | W02c + W03b + W04b |

**That is 21 main, 5 W02b/c, 4 W03 and 6 W04 assumptions (36).**

## Where this plan refines the spec (read before implementing)

Each item was checked against the code on `main` or against Xero's published documentation on 2026-09-27. developer.xero.com renders client-side, so those pages were read through a text reader, and every fact was cross-checked against the OpenAPI files. Xero sources:

- Payments: <https://developer.xero.com/documentation/api/accounting/payments>
- Invoices: <https://developer.xero.com/documentation/api/accounting/invoices>
- Overpayments: <https://developer.xero.com/documentation/api/accounting/overpayments>
- Types: <https://developer.xero.com/documentation/api/accounting/types>
- Requests and responses: <https://developer.xero.com/documentation/api/accounting/requests-and-responses>
- Response codes: <https://developer.xero.com/documentation/api/accounting/responsecodes>
- Webhooks: <https://developer.xero.com/documentation/guides/webhooks/overview>
- Limits: <https://developer.xero.com/documentation/guides/oauth2/limits>
- Idempotency: <https://developer.xero.com/documentation/guides/idempotent-requests/idempotency>
- Accounting OpenAPI: <https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero_accounting.yaml>
- Webhooks OpenAPI: <https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero-webhooks.yaml>
- SDK model: <https://raw.githubusercontent.com/XeroAPI/xero-node/master/src/gen/model/accounting/payment.ts>

1. **Signed deliveries get `200` with an empty body, and bad signatures get `401` with an empty body.** Xero asks for "2xx … for all correctly signed payloads and status: 401 Unauthorized for all incorrectly signed" within 5 seconds, over HTTPS on 443, and with "no cookies in the response headers". The spec says "exactly 200", and the route answers exactly `200` (QuickBooks answers `202`). A signed body that fails to parse gets `400`. A signed delivery whose enqueue failed gets `503`, and so does an instance without `XERO_WEBHOOK_KEY`. Xero retries a non-2xx "immediately … then … every 15 minutes", and disables the subscription after 24 hours of failure. A `503` for a brief outage is therefore safe, and the 15-minute sweep backstops the gap. No global middleware may add `Set-Cookie` to this path (Task 4 pins it; lab X48).
2. **Order of operations is the security contract:** IP limiter, raw body, key present, signature (constant time), then `JSON.parse`, then tenant lookup. A request with a bad or missing signature never reaches `JSON.parse`, never computes a fingerprint and never opens a DB context (Task 4 proves each with spies). **That includes the global middleware in front of the route (quorum finding 10).** `partnerGuard` (`index.ts:781-784`) verifies any `Authorization: Bearer` JWT, reads `partners` in system scope and may write an activation, and all of that happens *before* the route. A caller holding any valid Breeze token could therefore trigger DB work on this path with a bad Xero signature, or get a JSON 403 instead of the empty 401. Task 4 adds `/api/v1/webhooks/xero` to `isPartnerGuardExemptPath` (`middleware/partnerGuard.ts:16`), with a test. The QuickBooks webhook has the same pre-existing exposure; it is left byte-identical and noted for a follow-up issue. `verifyWebhook` is `base64(HMAC-SHA256(rawBody, XERO_WEBHOOK_KEY))`, compared with `timingSafeEqual` on equal-length buffers, like QuickBooks.
3. **Only `INVOICE` events on an `ORGANISATION` tenant ring the doorbell.** Xero's event categories are exactly `CONTACT`, `INVOICE`, `SUBSCRIPTION`, `CREDITNOTE`, `PREPAYMENT` and `OVERPAYMENT`, and **there is no `PAYMENT` category** (Webhooks OpenAPI). The spec's "an `INVOICE` UPDATE event is the doorbell" is the only signal for a payment, and it is an inference: Xero does not document that applying a payment fires an invoice `UPDATE`. Lab **X50** settles it. If it does not fire, the 15-minute sweep is the only path. That is slower, but correct. Contact, credit-note, prepayment and overpayment events are ignored (they are out of scope), and so are `SUBSCRIPTION` events (`tenantType: 'APPLICATION'`). Event payloads carry ids only. The route never reads `resourceId`/`resourceUrl`; it logs category counts, never ids.
4. **No event ledger, and no new table.** Xero says consumers "must ensure they implement idempotency logic and support message replayability", and it replays failed events for up to 31 days. Breeze's webhook has exactly one effect: it enqueues `reconcile-connection` for a connection that already exists, under the deterministic jobId `accounting-reconcile-<connectionId>`. BullMQ drops an `add()` whose jobId is waiting, delayed or active. The reconcile itself is idempotent:
   - the cursor overlaps by 5 minutes;
   - replays match the stored version by exact string equality;
   - adoption is a compare-and-set;
   - mapping claims are unique on `(integration_id, remote_entity_type, remote_entity_id)`.

   A duplicate or replayed delivery therefore costs at most one extra reconcile run, and never a double-applied payment. A ledger would only add storage (the index forbids a new table). A Redis replay cache keyed on the body hash would dedupe nothing the jobId does not already dedupe, and it would be a new failure point inside Xero's 5-second budget. The remaining cost of a replay is **Xero API budget**, and refinements 5–6 bound it.
5. **Webhook reconciles are delayed 30 s and coalesce.** A payment applied in Xero can fire several events (invoice updated, maybe contact updated), and Breeze's own pushes also fire invoice events. `routeWebhookToConnection` gains an optional `{ delayMs }`, and the Xero route passes `30_000`. While the delayed job waits, every other webhook, sweep or **Sync now** enqueue for that connection is dropped by the jobId, so a burst costs one run. That run starts after the burst, and so reads its changes. QuickBooks passes nothing, so its `add()` arguments are byte-identical (a pinned test). The trade-off: a **Sync now** clicked in those 30 s runs when the delayed job runs, not at once. That job is already queued, so the route's "queued" answer stays true. The coalesced job keeps `trigger: 'webhook'`, so under refinement 6's low-budget rule it defers; a **Sync now** clicked after it runs is not deferred.
6. **Webhook runs defer when the daily budget is low.** The sweep already skips connections under 20% of their daily budget (`shouldDeferBackgroundWork`, spec "Rate limiting"). A webhook-triggered run did not check, so a burst of signed deliveries could spend the Starter tier's 1,000 calls a day on pulls. `processReconcileConnectionJob` now returns the new skip reason `daily_budget_low` for `trigger === 'webhook'` under the same rule. Manual **Sync now** never defers. QuickBooks declares `dailyPerConnection: null`, so the ratio is null and it never defers. **Exception (quorum finding 3):** a connection that owes a payment delete still waiting for its remote id is never deferred, by the sweep or by the webhook rule. That delete sits in `awaiting_remote_ref` (a create whose response was lost, then a Breeze void), and only a pull can adopt its id before the 24-hour grace window drops the row and orphans the Xero payment. The check runs only after the budget says "defer", so QuickBooks never issues the query. What remains is a connection in `reauth_required` for more than 24 hours: no pull can run, and the grace window drops the row loudly (Sentry plus a `delete_unresolved` audit). That behaviour is pre-existing and shared with QuickBooks.
7. **The tenant id is looked up in system scope. It cannot be partner-axis.** An unauthenticated webhook has no partner, so under partner-axis RLS the connection row is invisible and the lookup would always miss. The shared router (M3) already runs `findConnectionByRealmFingerprint` in its own short `withSystemDbAccessContext`, after the signature is proven. It returns only the connection id, partner id and provider, and it enqueues **outside** any DB context. The payload's `tenantId` selects which connection to reconcile and nothing else. The reconcile job loads the connection by id and partner, and calls Xero with that row's own token and its own stored tenant id (`xero-tenant-id` from `realm_id_encrypted`, never from the payload). The worst a signed-but-forged tenant id can do is trigger a reconcile of the connection that really owns that tenant. `provider_connection_ref` is not used: Xero events carry no connection id. The route is **not** in `SELF_MANAGED_DB_CONTEXT_ROUTES`, because an unauthenticated route has no ambient auth transaction to opt out of. The QuickBooks route has the same comment. Tenant ids are validated as GUIDs before they are fingerprinted, and at most 50 distinct tenants are routed per delivery.
8. **Body size: the global 1 MB gate already covers the route.** `bodyLimitForPath('/api/v1/webhooks/xero')` returns the `default` rule (1 MB), enforced by `createGlobalBodyLimitMiddleware` before routing and before the HMAC. Xero documents no payload size. A signed batch comes from Xero's own event sequence, so 1 MB (thousands of events) is ample. Task 4 pins the rule for this path. The route also stops scanning after 1,000 events: the tenant set is capped anyway, and past that point the sweep is the backstop.
9. **The pull reads two lists with `If-Modified-Since`, paging by *seek*, not by offset (quorum finding 1).**
   - `GET Payments?where=PaymentType=="ACCRECPAYMENT"&order=UpdatedDateUTC ASC&page=1&pageSize=1000`
   - `GET Invoices?Statuses=VOIDED,DELETED&where=Type=="ACCREC"&order=UpdatedDateUTC ASC&page=1&pageSize=1000`

   Both send `If-Modified-Since: yyyy-mm-ddThh:mm:ss` in UTC ("accurate to the second"). Xero documents:
   - that `PaymentType` is an optimised `where` filter (the docs write a single `=`; W04 settled on `==` with a lab fallback, lab **X60**);
   - that the default Payments order is `UpdatedDateUTC ASC, PaymentId ASC`;
   - that the page size can be up to 1,000;
   - that "when you retrieve invoices by querying by Statuses, pagination is enforced by default".

   **Why not `page=2, 3, …`:** offset paging over a list ordered by a *mutable* timestamp can lose rows. If a row on page 1 is updated between two requests, it moves to the end, every later row shifts one place left, and the row that was first on page 2 lands on the already-read page 1. The cursor would then advance past it for good. So every request asks for **page 1**, and a full page is followed by another request with `If-Modified-Since = (last row's UpdatedDateUTC − 1 s)`. A row updated mid-read reappears later, with its new timestamp, instead of pushing another row out of view. Rows read twice are deduplicated by id, and the later read wins. If a full page ends no later than the previous page ended (1,000 rows inside one second), there is no progress: that list is `stalled`. Refinement 11 explains how a stalled list is handled.

   A normal run costs **2 calls**. A `304 Not Modified` answer is read as an empty page (undocumented for this API; lab **X59**).
10. **`AROVERPAYMENTPAYMENT`/`ARPREPAYMENTPAYMENT` are refunds, not receipts.** The Types page reads "Accounts Receivable Overpayment Payment (Refund)". Customer overpayments and prepayments are created as BankTransactions, and applying one to an invoice is an **allocation**, not a Payment. So the pull keeps only `ACCRECPAYMENT` rows whose `Invoice.Type` is `ACCREC` (or absent) and that carry an `Invoice.InvoiceID`. Credit-note, overpayment and prepayment allocations reduce `AmountDue` without a Payment and are **not observed**. That is the spec's documented v1 limitation, and lab **X64** records it. A later Breeze push against such an invoice meets Xero's "must be less than or equal to the outstanding amount" refusal. Refinement 16 turns that into a terminal, explained error instead of a retry loop.
11. **The cursor is the newest `UpdatedDateUTC` actually read, and it only moves forward.**
    - `windowStart = max(sinceCursor, conn.createdAt)`. A first run has no cursor and reads from the connection's creation: Breeze cannot have pushed anything before it connected.
    - The read starts at `windowStart − 5 min`, because Xero does not say whether `If-Modified-Since` is inclusive.
    - The new cursor is the largest `UpdatedDateUTC` seen across both lists, never below `windowStart`. With nothing seen, it is `windowStart`.
    - Seek paging reads a list completely up to its last row. So a list that hits the **request cap** has read every row up to that row's second. The cap is 10 requests beyond `windowStart`, plus up to 10 more spent inside the 5-minute overlap. Pages that end at or before `windowStart` do not count against the 10, which is how a dense overlap window cannot stall the pull (quorum finding 7). When a list hits the cap, the cursor stops at the **earliest** capped list's last-row time instead of holding the whole window. The next run continues from there, and the overlap re-reads the boundary.
    - `overflowed` is set only when there is no progress: a list `stalled` (1,000 rows in one second), or a capped list's last row is not newer than `windowStart` (more than 10,000 changes inside the 5-minute overlap). The worker then holds the cursor and surfaces a run error. Both cases need a genuinely degenerate change burst, and both are loud.
    - QuickBooks' 30-day CDC floor and `/query` backfill do not exist here.
    - Xero warns that "not all changes will trigger a change of the UpdatedDateUTC field". The sweep cannot see those either, and lab **X51** proves the one that matters: a **deleted** payment is returned with `Status: DELETED` and a newer `UpdatedDateUTC`. That row is a **gate**. If it fails, stop: a Xero-side deletion would never reach Breeze, and the plan needs an invoice-level allocation diff instead.
12. **Xero payments are delete-only, and `unappliedPayments` is always empty.** "Payments cannot be modified, only created and deleted", and each Payment applies to exactly one invoice (`Invoice` is one identifier object). An edit in Xero's UI is therefore a delete plus a new payment. The worker already applies deletions before additions, and the multi-invoice paths (`reverseStaleAllocations`, split-note guards) stay correct but idle for Xero. The mapping id stays `"<PaymentID>/<InvoiceID>"`.
13. **The remote version is the ISO form of `UpdatedDateUTC`, normalised once.** Replay detection compares strings exactly (M15). The create response, the pull and the adoption lookup all pass `UpdatedDateUTC` through `parseXeroDate`, so one payment always yields one string. Reconciling a payment in Xero bumps its `UpdatedDateUTC`. For a Breeze-origin row that is a version change with the same amount (`replayed`, new version stored). For a Xero-origin row it is the existing `updated` rewrite with identical values. Both are harmless.
14. **The marker goes first in `Reference`, and the reference field is capped at 64 characters.**
    - Xero documents **no maximum length** for `Payment.Reference` (docs, OpenAPI and SDK all silent; only NZ BatchPayments caps at 255). Breeze stores `invoice_payments.reference` as `varchar(255)`.
    - The marker is `Breeze payment <uuid>` (51 characters). `embed` writes `<marker>` or `<marker> | <reference>`. `extract` reads the text before the first ` | ` with the existing anchored grammar (`parseBreezePaymentMarker`), so a hand-typed reference that merely *mentions* a Breeze id never claims a row. Putting the marker first means that if Xero ever truncated the field, it would cut the human reference, never the ownership key.
    - `limits.paymentRefMax = 64` (the core truncates the raw reference before `embed`, M12). That caps the field at 118 characters, well under any plausible limit, while a 27-character Stripe `pi_…` id and any cheque number fit.
    - Lab **X58** records Xero's real limit, and it is a **gate**. If Xero ever alters a 118-character reference, a lost-response create could no longer be adopted, and the pull would mirror Breeze's own payment back into Breeze as a second receipt.
    - Pulled references are clamped to 255 characters before they reach `invoice_payments.reference`, so an over-long Xero reference can never poison a reconcile window.
15. **Payment creates are keyed on the request's identity, and adoption runs before every create.** W04's lesson applies: a payment body carries a mutable setting (the bank account), so W03's request-derived key could split one payment into two keys. The key is `'breeze-pay-' + sha256(tenantId, invoicePaymentId, pushGeneration)[0..64]` (75 characters, under Xero's 128). It has the same identity inputs as QuickBooks' `requestid` (`invoicePaymentId[:g<n>]`), so a fan-out re-own (a bumped `push_generation`) gets a new key. Xero keeps a key for **6 minutes**, not QuickBooks' 24 hours, so the key only protects fast retries. **Adoption is the guard:**
    - Before every `PUT`, the provider lists the invoice's payments (`GET Payments?where=Invoice.InvoiceID==guid("<id>")`, an optimised filter).
    - It keeps `ACCRECPAYMENT`/`AUTHORISED` rows whose `extract(Reference)` is this Breeze payment id.
    - One live hit **with the same amount and currency** is adopted, and nothing is created. Two live hits, or a hit with another amount, refuse with `duplicate_key` → terminal `remote_ambiguous` ("never guess"; quorum finding 6: pull adoption already checks the amount, and push adoption now does too).
    - Only a `DELETED` hit, on a first-generation push (`pushGeneration === 0`), refuses with the new refusal code `remote_deleted` (quorum finding 4). This is a create whose response was lost and which a person then deleted in Xero before Breeze adopted it. Re-creating it would resurrect a payment the bookkeeper removed. After a re-own (the operator pushes the invoice again, so `push_generation > 0`), the push creates anew. That matches QuickBooks' rule that a hand deletion is respected until the invoice is pushed again.
    - The lookup fails closed when the invoice's payments do not fit in one 1,000-row page (quorum finding 5). "No hit" must mean "none exists".
    - A `transient` outcome (a timeout, a 5xx, or Xero's "used with a different request" 400, which W04 classifies as `transient`) looks once more before it rethrows.

    This also makes the core's 24-hour assumptions (M12: `PAYMENT_RECORD_FAILED_MAX_SWEEPS`, the delete grace window) safe for Xero. A retry after a lost `record_failed` write adopts instead of duplicating, whatever the time.
16. **Xero payment refusals are terminal and quiet. The coordinator gains the refusal branch it never had.** Today every non-throttle provider error from `createPayment`/`deletePayment` is a retryable 502 with Sentry (M12), so a permanent Xero refusal would burn up to 100 attempts and page Sentry each time. W05 adds `paymentPushRefusal(err, label, op)`, which maps W03/W04 refusal codes, exactly as W04's `invoicePushRefusal` does:

    | Xero situation (400 text) | Refusal code | Payment error code | Persisted | Where |
    |---|---|---|---|---|
    | "Payment amount exceeds the amount outstanding on this document" (third-party text; docs: "must be less than or equal to the outstanding amount") | `amount_exceeds_due` (new) | `amount_exceeds_due` | `pending_op` cleared | create |
    | "Payments can only be made against Authorised documents" (third-party text; docs: "apply payments to approved AR and AP invoices") | `remote_missing` | `remote_missing` | `pending_op` cleared | create |
    | Two live Xero payments carry this Breeze marker | `duplicate_key` | `remote_ambiguous` | `pending_op` cleared, **with Sentry** | create |
    | Deleting a bank-reconciled payment (undocumented; lab **X55**) | `remote_locked` | `remote_locked` | `pending_op` cleared, the remote id kept | delete |
    | A Xero payment Breeze created (marker) was deleted there before Breeze recorded it; first-generation push | `remote_deleted` (new) | `remote_deleted` | `pending_op` cleared | create |
    | Missing scope | `insufficient_scope` | `provider_permission` | `pending_op` cleared | both |

    Each is 409, persisted as the mapping's `last_error`, terminal in the worker, and not sent to Sentry, except `remote_ambiguous`. **The stamp is conditional (quorum finding 2).** The provider call runs with no lock held, so by the time a refusal returns, a pull may have adopted the payment or a void may have turned the owed push into an owed delete. `markPaymentRefusedIfStillOwed` therefore clears `pending_op` only while the row still owes the refused operation (a push also needs the same `push_generation` and no remote id). Otherwise it writes nothing, and the newer obligation survives. A cleared create is re-armed by the next invoice push to Xero (the fan-out's re-own, with a new `push_generation`), and the message says so. A reconciled payment's delete is handed to the bookkeeper: once they unreconcile and delete it in Xero, the pull sees `DELETED` and clears the mapping. QuickBooks never sets these refusal codes (its `providerCode` holds QBO fault numbers), so its errors keep their current handling. A pinned test proves that a QuickBooks `6000` fault is still the retryable 502 with Sentry.
17. **A missing bank account parks the payment without any Xero call, and heals itself.** The spec says "`default_payment_account_ref` null → payment push disabled with a settings warning". Refusing at the producers would create no mapping row, so nothing would show and nothing would retry once the account is chosen. Instead, `AccountingProvider` gains an **optional, synchronous** `paymentPushPreflight(conn): string | null`, the payment twin of W04's `invoicePushPreflight`. The coordinator calls it in Phase 1, after the currency guard and before the token refresh. A refusal stamps the operator message with `pending_op` **kept**, the lease released and `countAttempt: 'never'`, then throws terminal `push_settings_incomplete` (409, quiet). The 15-minute sweep re-offers the row; it costs no Xero call and no attempt. When the account is chosen, the next sweep pushes. The settings step shows a warning while payment push is on and no account is chosen (Task 11). QuickBooks declares no preflight.
18. **Delete reads first.** `deleteXeroPayment` runs `GET Payments/{id}`, then:
    - `404` or `Status: DELETED` → `already_absent`, no write (the desired end state, obligation 2);
    - `IsReconciled: true` → `remote_locked`, without writing;
    - otherwise `POST Payments/{id}` `{ Status: 'DELETED' }`, with no idempotency key (deleting is naturally idempotent, and a key could replay a cached error for 6 minutes).

    A `404` on the POST is `already_absent`, and a 400 naming reconciliation is `remote_locked` (the race between the read and the write). The stored remote version is ignored: Xero has no optimistic concurrency.
19. **A create sends only home-currency money.** The coordinator's currency guard already refuses a payment whose invoice currency differs from the connection's home currency (M12), so no `CurrencyRate`/`BankAmount` is sent. `Amount` is the 2-dp decimal string converted to a JSON number at the wire. `Date` is `txnDate`. The body is `{ Payments: [ { Invoice: { InvoiceID }, Account: { AccountID }, Date, Amount, Reference } ] }` on `PUT Payments?summarizeErrors=true`, the same explicit-errors rule as W04 refinement 13. A 2xx element that carries `HasValidationErrors`/`ValidationErrors` is still a `validation` failure. The account must be `BANK` or have "enable payments to this account" (docs). Lab **X61** records Xero's text for a non-bank account. It is left as a generic, retryable `validation` in W05 (see "Deliberately not in W05").
20. **Pulled Xero-origin payments get `method: 'other'`.** Xero has no payment-method field. `ChangeSetPaymentLine.method` says unknown rails are `other`, "never inferred", so `bank_transfer` is not guessed. `paymentMethodName` is `null`, and `paymentRefNum` is the `Reference`, with the Breeze marker stripped for our own payments, clamped to 255 characters, and `null` when empty.
21. **W01d's deferred renames land here, and the persisted audit strings do not change.**
    - `QUICKBOOKS_OWNED_PAYMENT` becomes `PROVIDER_OWNED_PAYMENT`. `apps/web` does not branch on the code (it reads the message), and `apps/docs` does not mention it. It is the one intended QuickBooks-visible string change; list it in the W05b PR body.
    - `quickbooksRecordUntouched` becomes `providerRecordUntouched` in code and in the `DELETE …/payments/:pid` response. The response **also** keeps the old key for one release as a deprecated alias, so a browser tab loaded before the deploy still shows the warning. The web reads the new key first.
    - The **persisted** audit action `invoice.payment.voided_quickbooks_untouched` and the route-audit `details.quickbooksRecordUntouched` key stay byte-identical. They are history that operators already search, and the entries carry `provider`.
22. **Operator messages are labelled by provider.** W01d deferred these: the 13 QuickBooks-worded strings in `accountingPaymentPush.ts` (M13), the reconcile worker's `overflowed` run error and its Sentry text, and the pull's four throw texts (`accountingPaymentPull.ts:417`, `:513`, `:578`, `:649`). They move to `accountingPaymentMessages.ts` (and label parameters) as functions of the display name. With `'QuickBooks'` each returns the exact pre-W05 literal, and a table test pins all of them. The deprecated `BREEZE_ORIGIN_*` constants stay.
23. **Bulk push (#7251) and payment fan-out interact only through the invoice.** `requestPaymentPush` enqueues nothing in manual push mode (`accountingPaymentPush.ts:673`). In manual mode, payments reach Xero only through `fanOutOwedPayments` after a successful invoice push. So while #7251 is open, a manual-mode partner's bulk push sends neither invoices nor their payments. That is not a W05 defect: the single-invoice **Push to Xero** route works, and the fan-out after it pushes the payments. When #7251's fix lands, a bulk push in manual mode fans out every owed payment at once. Each costs 2 Xero calls (lookup + `PUT`), and the per-connection limiter paces them as `rate_limited` delays. A 200-invoice bulk push with payments is about 800 calls, close to the Starter tier's 1,000. Pushes keep priority over background work by design (spec "Rate limiting"). W05 changes nothing here, and the W05c PR body notes the budget. The lab uses **auto** mode or the single-invoice route.
24. **Export, erasure and RLS registries: nothing to add.** W05 adds no table, column, index or migration, no env var (`XERO_WEBHOOK_KEY` is W02a's) and no scope (`accounting.payments` is W02's). Payment mappings keep `remote_entity_type = 'Payment'` (spec D6). `invoice_payments` has no `source` column (the web derives the provider from the mapping row), so a Xero-origin payment needs no enum change. If an executor finds a column is needed after all, stop and amend the plan first.

## Global Constraints

- Xero's capabilities after W05 are exactly `{ connect: true, mapping: true, customerImport: true, invoicePush: true, paymentPull: true, paymentPush: true }`. They are flipped **only** in Task 12 (W05c). Through W05a/W05b they stay W04's (`paymentPull: false, paymentPush: false`).
- **QuickBooks is byte-identical, and the tests pin it:**
  - `git diff origin/main -- apps/api/src/services/accounting/quickbooks*.ts apps/api/src/routes/webhooks/quickbooks.ts` is empty at the end of every PR.
  - `quickbooksIdempotency.test.ts`, `quickbooksProvider*.test.ts` and `routes/webhooks/quickbooks.test.ts` pass **without edits**. So do the QuickBooks message assertions in `accountingPaymentPush.test.ts`, `accountingPaymentPull.test.ts`, `jobs/accountingReconcileWorker.test.ts` and `jobs/accountingSyncWorker.test.ts`.
  - New pins: the QuickBooks webhook's `enqueueAccountingReconcile` call has exactly three arguments (Task 1); `paymentPushMessages('QuickBooks')` equals every pre-W05 literal (Task 6); a QuickBooks provider fault on `createPayment` is still the retryable 502 with Sentry (Task 6).
  - The only intended QuickBooks-visible change is the error code rename in refinement 21.
- Webhook order: IP limiter → raw body → key present → signature (`timingSafeEqual`) → `JSON.parse` → shape check → tenant lookup (refinement 2). Valid → `200`, empty body. Invalid or missing signature → `401`, empty body. No `Set-Cookie` header.
- Payment ownership marker: `Reference = 'Breeze payment <uuid>'` or `'Breeze payment <uuid> | <reference>'`. `limits.paymentRefMax = 64`. `extract` uses the existing anchored grammar on the text before the first `' | '`.
- Idempotency: payment creates (`PUT`) carry `xeroPaymentIdempotencyKey(tenantId, invoicePaymentId, pushGeneration)`. Deletes (`POST`) carry none. Adoption lookup runs before every create and after every `transient` outcome.
- Cursor: newest `UpdatedDateUTC` read, never below `max(sinceCursor, conn.createdAt)`. The read starts 5 minutes earlier. Paging is by seek (page 1, `If-Modified-Since` = last row − 1 s), never by offset. The page size is 1,000. Each list per run is capped at 10 requests beyond the window start, plus 10 within the overlap.
- No Xero module calls `fetch` directly except `xeroHttp.ts`. No new function may be *named* `createPayment`/`deletePayment` outside the provider classes (`accountingInvoicePushCallSites.test.ts`). The Xero helpers are `createXeroPayment`/`deleteXeroPayment`.
- The neutral-core guard stays green. New Xero wire logic lives only in `xeroHttp.ts`, `xeroPayments.ts` and `xeroProvider.ts`. The Xero route file is `routes/webhooks/xero.ts`, which is outside the guard's scope, but it still contains no QuickBooks symbol. New core files contain no `'quickbooks'` or `'xero'` literal.
- No new tables, columns, migrations, env vars, scopes, Sentry **tags** or `SELF_MANAGED_DB_CONTEXT_ROUTES` entries. One new Sentry **event code**, `accounting_webhook_signing_key_missing`, is registered in `sentryEventCodes.ts`.
- `routes/accounting/index.ts` must not grow: `wc -l` at the end of each PR must be ≤ its Task 0 count. W05 does not touch it.
- Every provider HTTP call runs with no held DB context (the existing `runOutsideDbContext` contract). The webhook route opens no DB context itself; only the shared router does, per tenant, in system scope.
- Web: every mutation goes through `runAction`. Every QuickBooks `data-testid` and English string stays byte-identical. New i18n keys land in all 8 locales (`de-DE en es-419 fr-CA fr-FR it-IT pt-BR tr-TR`).
- Tests: run one file with `cd apps/api && npx vitest run <path>`, never `pnpm … test -- --run`. Integration: `pnpm test-stack up`, then `cd apps/api && npx vitest run -c vitest.integration.config.ts <path>`, then `pnpm test-stack down`.
- Every PR runs these before opening:
  - the full API unit suite;
  - `npx tsc --noEmit -p apps/api`;
  - the accounting integration set (`src/__tests__/integration/accounting*` + `tenantCascade`);
  - `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`.

  W05b and W05c also run `cd apps/web && npx vitest run` and `npx astro check` in `apps/web`.

## Review Focus

These are the failure modes most likely to bite a real partner that no single task tests by itself, most likely first. Each has a pinned test in the task that owns the code.

1. **A Breeze payment whose Xero create response is lost, while a webhook-triggered pull runs at the same moment.** Expected: exactly one Xero payment and one Breeze receipt, never a mirrored second one.
   - Whichever side sees the Xero payment first adopts it. The pull matches the marker to the pending Breeze-origin row. The push retry finds it with the pre-create lookup.
   - The other side then finds the row already adopted: the push reports `already_adopted`, and the pull reports `replayed` or `skipped_breeze_origin`.
   - The pull never inserts an `invoice_payments` row for a payment whose `Reference` carries our marker.

   *(Task 3 marker round-trip incl. the 64-character reference; Task 9 "adopts instead of creating" / "a timed-out create looks again and adopts" / "two live hits refuse"; Task 12 real-DB "lost create: pull adopts, retry adopts nothing twice".)*
2. **A payment deleted in Xero.** Expected: if Xero recorded it (Xero-origin), the Breeze receipt is reversed and the invoice balance restored. If Breeze created it, the mapping reads "removed in Xero" and nothing is re-pushed. Both happen through the next pull, whether rung by a webhook or the sweep. *(Task 3 `DELETED` → `deletedPayments`; Task 12 real-DB reversal; lab X51 gate.)*
3. **A signed webhook storm, or a replay of a captured delivery.** Expected:
   - every delivery answers `200` fast;
   - one reconcile run per connection per 30 s at most;
   - under 20% of the daily budget, webhook runs skip with `daily_budget_low` and the sweep catches up;
   - no event is double-applied;
   - an unsigned flood is refused `401` before any JSON parse or DB work.

   *(Task 1 delay + deferral; Task 4 route matrix + spies; Task 12 real-DB idempotent replay.)*
4. **Payment push switched on with no bank account chosen.** Expected:
   - the payment row shows "Choose a bank account for payments in Integrations → Accounting → Xero; Breeze will send this payment when one is chosen";
   - no Xero call and no token refresh;
   - no attempt counted and no Sentry event;
   - once an account is chosen, the next 15-minute sweep pushes it with no click.

   *(Task 6 "preflight parks"; Task 9 preflight; Task 12 real-DB "parks, then pushes after the setting"; lab X61.)*
5. **Voiding in Breeze a payment the bookkeeper already reconciled in Xero.** Expected: the Breeze void succeeds. The mapping shows "Xero will not delete this payment because it is reconciled to a bank transaction — unreconcile it in Xero and delete it there". There are no retries and no Sentry event. After the bookkeeper deletes it in Xero, the next pull clears the mapping. *(Task 9 delete table; Task 6 refusal mapping; lab X55.)*

---

## PR split

| PR | Branch | Tasks | What ships | Stands alone because |
|---|---|---|---|---|
| **W05a** Webhook + pull | `feature/7167-xero/wave-7172-a-pull` | 0–5 | Neutral reconcile seams (delay, webhook deferral, labelled run error); `If-Modified-Since` reads; `xeroPayments.ts` pull + marker; `verifyWebhook`; `POST /webhooks/xero` + registries; provider wiring of `reconcileChanges`/`paymentMarker`/`paymentRefMax` | `paymentPull` stays false, so `routeWebhookToConnection` answers `capability_unavailable` (route → 200, nothing enqueued), the sweep filters Xero out, and the worker skips `capability_unavailable`. The route going live early lets the owner pass Xero's intent-to-receive before the flip. QuickBooks is byte-identical. |
| **W05b** Push + delete | `feature/7167-xero/wave-7172-b-push` | 6–10 | Labelled payment messages; `paymentPushPreflight?`; refusal branch + 7 codes; worker terminal/quiet sets; renames (API + web); Xero payment refusal classification; `createXeroPayment`/`deleteXeroPayment`; provider wiring | `paymentPush` stays false, so `loadConnectedConnection` returns null for Xero (no mapping rows), and the worker drops payment jobs for Xero. The QuickBooks outputs are pinned. |
| **W05c** Web, flip, lab | `feature/7167-xero/wave-7172-c-web` | 11–13 | Settings-step warning (8 locales), `.env.example` webhook note; capability flip + real-DB proof; lab section 5 | The server contract is complete and proven. The flip is gated on lab X47, X50, X51, X52 and X58. |

Merge order is a → b → c. Each targets `main`, and each later PR is rebased after the previous one merges. **Do not stack:** a stacked PR runs no CI.

**Settings rule 9 (W05c touches a `*Settings*` component):** W05 adds no setting and moves none. The bank account (`default_payment_account_ref`) is W02c's. Its home is Integrations → Accounting → Xero settings step, at connection level, with the connection row as its resolver. It is configured in 1 place before and after. W05c adds only a warning beside it.

---

## File structure

**Created**

| File | Responsibility | PR |
|---|---|---|
| `apps/api/src/routes/webhooks/xero.ts` (+ `.test.ts`) | `POST /webhooks/xero`: limiter, raw-body HMAC, event filter, per-tenant routing | a |
| `apps/api/src/services/accounting/xeroPayments.ts` (+ `.test.ts`) | Xero payment wire logic: marker grammar, pull (`readXeroPaymentChanges`), idempotency key, adoption lookup, create, delete, preflight | a (pull, marker), b (push) |
| `apps/api/src/services/accounting/accountingPaymentMessages.ts` (+ `.test.ts`) | Provider-labelled operator text of the payment coordinator and reconcile worker; QuickBooks byte-identical | a (reconcile), b (push) |
| `apps/api/src/__tests__/integration/accountingXeroPayments.integration.test.ts` | Real-DB proof: webhook → lookup → enqueue; pull apply/replay/reverse; push adopt; park then push; delete; QuickBooks untouched | c |

**Modified:** see each task's **Files** block.

---

## Task 0: Baseline and interface re-verification (every PR starts here)

**Files:** none.

- [ ] **Step 1: Confirm the branch and preconditions**

```bash
cd <worktree>
git fetch origin main && git status -sb
git log origin/main --oneline | grep -iE 'xero w0[1234]|#716[89]|#717[01]' | head -30
```

Expected: a clean tree on the W05 branch, based on current `origin/main`, with W01 (4 PRs), W02 (a, b, c), W03 (a, b) and W04 (a, b) listed.

- [ ] **Step 2: Re-verify every assumption (M1–D6)**

```bash
cd apps/api/src
grep -n "reconcileChanges(\|createPayment(\|deletePayment(\|verifyWebhook(\|readonly paymentMarker\|readonly limits\|paymentPushPreflight\|invoicePushPreflight" services/accounting/types.ts
grep -n "export async function routeWebhookToConnection" -A14 services/accounting/accountingWebhookRouting.ts
grep -n "const ENQUEUE_OPTS\|export async function enqueueAccountingReconcile\|type ReconcileSkipReason\|function classifyReconcileSkip\|truncated the last change window" jobs/accountingReconcileWorker.ts
grep -n "export async function shouldDeferBackgroundWork" services/accounting/accountingRateLimit.ts
grep -n "QuickBooks" services/accounting/accountingPaymentPush.ts | grep -v "^\s*[0-9]*:\s*//\|^\s*[0-9]*:\s*\*"
grep -n "QuickBooks" services/accounting/accountingPaymentPull.ts | grep -v "^\s*[0-9]*:\s*//\|^\s*[0-9]*:\s*\*"
grep -n "async function markPaymentMappingError\b\|async function markPaymentMappingErrorInOwnContext\|export type AccountingPaymentPushErrorCode\|limits.paymentRefMax\|async function loadConnectedConnection" services/accounting/accountingPaymentPush.ts
grep -n "const PAYMENT_TERMINAL_CODES\|INVOICE_USER_RESOLVABLE_CODES\|MAPPING_USER_RESOLVABLE_CODES\|terminal payment failure" jobs/accountingSyncWorker.ts
grep -n "QUICKBOOKS_OWNED_PAYMENT\|quickbooksRecordUntouched" services/invoiceService.ts services/invoiceTypes.ts routes/invoices/payments.ts ../../web/src/components/billing/InvoiceDetail.tsx
grep -n "export async function xeroApiGet\|export async function xeroApiWrite\|export function parseXeroDate\|export function xeroQuery\|export function requireXeroBody\|export function xeroArray\|export function classifyXeroValidation\|export function classifyXeroInvoiceKind\|function apiKindFor\|function allValidationMessages" services/accounting/xeroHttp.ts
grep -n "export const ACCOUNTING_REFUSAL_CODES\|export function refusalCodeOf\|export function providerPermissionMessage" -A2 services/accounting/accountingProviderError.ts
grep -n "notYet('payment\|verifyWebhook\|paymentRefMax\|readonly capabilities" -A1 services/accounting/xeroProvider.ts
grep -n "xero: xeroProvider" services/accounting/providerRegistry.ts; grep -n "'xero'" services/accounting/providerRegistry.test.ts
grep -n "hmacFingerprint(" routes/accounting/*.ts services/accounting/accountingConnectionService.ts services/accounting/accountingTenantSelection.ts 2>/dev/null
grep -n "export function xeroWebhookKey" config/env.ts
grep -n "webhooks/quickbooks.ts\|quickbooksWebhookRoutes" services/mcpCoverage.ts __tests__/routerAuthGate.contract.test.ts routes/webhooks.mountOrder.test.ts
cd ../../web/src
grep -rn "defaultPaymentAccountRef\|paymentAccount" components/integrations/AccountingSettingsStep.tsx | head
grep -n "caps.paymentPull\|caps.paymentPush" components/integrations/AccountingConnectionPanel.tsx
ls ../../../docs/integrations/xero-demo-verification.md && grep -n "^## \|X46" ../../../docs/integrations/xero-demo-verification.md
```

Expected:
- Every symbol is found.
- The `accountingPaymentPush.ts` QuickBooks grep lists at least the 13 lines of M13. Log-only and Sentry-only lines are listed too. Write the full set into the PR body.
- `hmacFingerprint(` appears where W02b persists a Xero tenant (B2). If W02b normalises the tenant id (for example with `.toLowerCase()`), the webhook route must apply the **same** normalisation before fingerprinting. Update Task 4's `tenantFingerprint` and its test.
- `loadConnectedConnection` contains `providerSupports(…, 'paymentPush')`. If it does not, stop: W05b would create Xero payment rows before the flip.
- For every other difference, note it in the PR body and adapt the task that uses it.

- [ ] **Step 3: Record the baseline**

```bash
cd apps/api && npx vitest run src/services/accounting src/jobs src/routes/accounting src/routes/webhooks src/routes/invoices src/services/invoiceService.test.ts 2>&1 | tail -4
wc -l src/routes/accounting/index.ts src/services/accounting/accountingPaymentPush.ts src/jobs/accountingReconcileWorker.ts src/services/accounting/xeroProvider.ts
```

Expected: all pass. Write down the `Test Files` count and the four line counts. `index.ts` must never exceed its count.

---

# PR W05a — Webhook and pull (Xero `paymentPull` stays false)

### Task 1: Neutral reconcile seams — enqueue delay, webhook budget deferral, labelled run error

**Files:**
- Create: `apps/api/src/services/accounting/accountingPaymentMessages.ts` (+ `accountingPaymentMessages.test.ts`)
- Modify: `apps/api/src/jobs/accountingReconcileWorker.ts` (`enqueueAccountingReconcile`, `ReconcileSkipReason`, `processReconcileConnectionJob`)
- Modify: `apps/api/src/services/accounting/accountingWebhookRouting.ts`
- Modify: `apps/api/src/services/accounting/accountingPaymentPush.ts` (new read helper `connectionOwesUnresolvedPaymentDelete`)
- Test: `jobs/accountingReconcileWorker.test.ts`, `services/accounting/accountingWebhookRouting.test.ts`, `services/accounting/accountingPaymentPush.test.ts`

**Interfaces:**
- Consumes: M3, M4, M5, M6; `accountingProviderDisplayName(provider)` (`providerRegistry.ts`).
- Produces:
  ```ts
  // accountingReconcileWorker.ts
  export interface ReconcileEnqueueOptions { delayMs?: number }
  export async function enqueueAccountingReconcile(connectionId: string, partnerId: string,
    trigger: ReconcileConnectionJobData['trigger'], opts?: ReconcileEnqueueOptions): Promise<boolean>;
  // ReconcileSkipReason gains 'daily_budget_low' (trigger === 'webhook' only)
  // accountingWebhookRouting.ts
  export async function routeWebhookToConnection(provider: AccountingProviderId, realmFingerprint: string,
    opts?: ReconcileEnqueueOptions): Promise<WebhookRouteOutcome>;
  // accountingPaymentPush.ts — quorum finding 3: a connection that owes a delete whose
  // remote id only a PULL can recover must never have its pulls deferred for budget.
  export async function connectionOwesUnresolvedPaymentDelete(dbc: DbExecutor, connectionId: string, partnerId: string): Promise<boolean>;
  // accountingPaymentMessages.ts (W05b Task 6 appends the push strings)
  export function reconcileWindowTruncatedMessage(label: string): string;
  export function reconcileWindowTruncatedError(connectionId: string, label: string): string;
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/accounting/accountingPaymentMessages.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { reconcileWindowTruncatedError, reconcileWindowTruncatedMessage } from './accountingPaymentMessages';

// Every function below must return, for 'QuickBooks', the EXACT literal the
// code held before Xero W05. These strings are persisted (last_error) and
// asserted by operators' saved searches; a drift is a QuickBooks regression.
describe('payment and reconcile operator text — QuickBooks byte-identical (Xero W05)', () => {
  it('reconcile truncated-window run error', () => {
    expect(reconcileWindowTruncatedMessage('QuickBooks')).toBe(
      'QuickBooks truncated the last change window and the backfill did not complete; payments may be missing',
    );
  });
  it('reconcile truncated-window Sentry/throw text', () => {
    expect(reconcileWindowTruncatedError('c-1', 'QuickBooks')).toBe(
      'accounting reconcile for connection c-1 could not be fully enumerated '
      + '(QuickBooks truncated the change window and the /query backfill did not complete)',
    );
  });
  it('labels Xero', () => {
    expect(reconcileWindowTruncatedMessage('Xero')).toBe(
      'Xero truncated the last change window and the backfill did not complete; payments may be missing',
    );
  });
});
```

In `jobs/accountingReconcileWorker.test.ts`, extend the `enqueueAccountingReconcile` describe (reuse `queueAddMock`):

```ts
  it('adds a delay only when asked, and keeps the jobId (Xero W05 refinement 5)', async () => {
    await expect(enqueueAccountingReconcile('c1', 'p1', 'webhook', { delayMs: 30_000 })).resolves.toBe(true);
    const [, , opts] = queueAddMock.mock.calls.at(-1)!;
    expect(opts).toEqual({
      jobId: 'accounting-reconcile-c1',
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: true,
      delay: 30_000,
    });
  });

  it('a zero or absent delay leaves the add() options byte-identical to pre-W05 (QuickBooks pin)', async () => {
    await enqueueAccountingReconcile('c1', 'p1', 'webhook', { delayMs: 0 });
    await enqueueAccountingReconcile('c1', 'p1', 'webhook');
    for (const call of queueAddMock.mock.calls.slice(-2)) {
      expect(call[2]).not.toHaveProperty('delay');
    }
  });
```

First, fix the file's mocks (quorum finding 9). The worker now calls `accountingProviderDisplayName`, and the `../services/accounting/providerRegistry` mock at `:154-158` does not export it, so every successful-run test would throw. Add `accountingProviderDisplayName: (id: string) => ({ quickbooks: 'QuickBooks', xero: 'Xero' } as Record<string, string>)[id] ?? `UNKNOWN_PROVIDER:${id}`` to that mock. Then add `owesDeleteMock: vi.fn(async () => false)` to a `vi.hoisted` block, and `connectionOwesUnresolvedPaymentDelete: owesDeleteMock` to the `../services/accounting/accountingPaymentPush` mock (`:167`).

Add to the `processReconcileConnectionJob: gating` describe. Reuse `JOB`, `connectionRow`, `getConnectionMock` (the `getConnectionById` mock), `shouldDeferMock`, `reconcileChangesMock` and `resolveConnectionAndTokenMock`:

```ts
  it('defers a WEBHOOK run when the provider daily budget is low, before any token work (Xero W05 refinement 6)', async () => {
    getConnectionMock.mockResolvedValue(connectionRow({ provider: 'xero' }));
    shouldDeferMock.mockResolvedValueOnce(true);
    const log = vi.spyOn(console, 'log');

    await expect(processReconcileConnectionJob({ ...JOB, trigger: 'webhook' })).resolves.toBeNull();

    expect(shouldDeferMock).toHaveBeenCalledWith('xero', expect.anything(), JOB.connectionId);
    expect(resolveConnectionAndTokenMock).not.toHaveBeenCalled();
    expect(reconcileChangesMock).not.toHaveBeenCalled();
    expect(log.mock.calls.some((c) => c.includes('reason=daily_budget_low'))).toBe(true);
  });

  it('does NOT defer a webhook run while the connection owes a delete only a pull can resolve (quorum finding 3)', async () => {
    getConnectionMock.mockResolvedValue(connectionRow({ provider: 'xero' }));
    shouldDeferMock.mockResolvedValueOnce(true);
    owesDeleteMock.mockResolvedValueOnce(true);
    await processReconcileConnectionJob({ ...JOB, trigger: 'webhook' });
    expect(reconcileChangesMock).toHaveBeenCalledTimes(1);
  });

  it.each(['sweep', 'manual'] as const)('never consults the budget for a %s run (the sweep deferred at enqueue; Sync now is interactive)', async (trigger) => {
    shouldDeferMock.mockResolvedValue(true);
    await processReconcileConnectionJob({ ...JOB, trigger });
    expect(shouldDeferMock).not.toHaveBeenCalled();
    expect(reconcileChangesMock).toHaveBeenCalledTimes(1);
    shouldDeferMock.mockResolvedValue(false);
  });
```

Add to the `processReconcileSweep` describe:

```ts
  it('a low-budget connection that owes an unresolved payment delete is still enqueued (quorum finding 3)', async () => {
    // Arrange the sweep exactly as the file's first sweep test does, with ONE reconcilable connection.
    shouldDeferMock.mockResolvedValue(true);
    owesDeleteMock.mockResolvedValue(true);
    const result = await processReconcileSweep();
    expect(result.deferred).toBe(0);
    expect(result.enqueued).toBe(1);
    shouldDeferMock.mockResolvedValue(false);
    owesDeleteMock.mockResolvedValue(false);
  });
```

In `accountingPaymentPush.test.ts`, add:

```ts
describe('connectionOwesUnresolvedPaymentDelete (Xero W05, quorum finding 3)', () => {
  it('is true only for a delete-pending payment row with no remote id on THIS connection', async () => {
    currentMappings = [paymentMapRow({ pendingOp: 'delete', remoteEntityId: null })];
    await expect(runCtx(() => connectionOwesUnresolvedPaymentDelete(db, CONN_ID, PARTNER))).resolves.toBe(true);
    currentMappings = [paymentMapRow({ pendingOp: 'delete', remoteEntityId: '181/145' })];
    await expect(runCtx(() => connectionOwesUnresolvedPaymentDelete(db, CONN_ID, PARTNER))).resolves.toBe(false);
    currentMappings = [paymentMapRow({ pendingOp: 'push', remoteEntityId: null })];
    await expect(runCtx(() => connectionOwesUnresolvedPaymentDelete(db, CONN_ID, PARTNER))).resolves.toBe(false);
    currentMappings = [paymentMapRow({ pendingOp: 'delete', remoteEntityId: null, integrationId: 'other-conn' })];
    await expect(runCtx(() => connectionOwesUnresolvedPaymentDelete(db, CONN_ID, PARTNER))).resolves.toBe(false);
  });
});
```

(If the file's `mappingMatches` fake cannot evaluate `isNull(remote_entity_id)`, extend it the way it already handles the other `IS NULL` predicates in `listOwedPaymentMappings`' tests.)

In the existing test `'stamps a truncated-window one-liner when the CDC window overflowed (finding H)'`, **add** a stricter assertion after the existing regex. The old assertion stays:

```ts
    expect(stampReconcileRunErrorMock.mock.calls.at(-1)![3]).toBe(
      'QuickBooks truncated the last change window and the backfill did not complete; payments may be missing',
    );
```

(`connectionRow()` defaults to `provider: 'quickbooks'`. Confirm this in Task 0, and pass `{ provider: 'quickbooks' }` explicitly if it does not.)

In `services/accounting/accountingWebhookRouting.test.ts`, append:

```ts
  it('passes the enqueue options through (Xero W05 delay)', async () => {
    m.find.mockResolvedValue({ id: 'c1', partnerId: 'p1', provider: 'xero' });
    m.enqueue.mockResolvedValue(true);
    const { routeWebhookToConnection } = await import('./accountingWebhookRouting');
    await expect(routeWebhookToConnection('xero', 'fp', { delayMs: 30_000 })).resolves.toBe('enqueued');
    expect(m.enqueue).toHaveBeenCalledWith('c1', 'p1', 'webhook', { delayMs: 30_000 });
  });

  it('calls enqueue with EXACTLY three arguments when no options are given (QuickBooks pin)', async () => {
    m.find.mockResolvedValue({ id: 'c1', partnerId: 'p1', provider: 'quickbooks' });
    m.enqueue.mockResolvedValue(true);
    const { routeWebhookToConnection } = await import('./accountingWebhookRouting');
    await routeWebhookToConnection('quickbooks', 'fp');
    expect(m.enqueue.mock.calls.at(-1)).toHaveLength(3);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingPaymentMessages.test.ts src/jobs/accountingReconcileWorker.test.ts src/services/accounting/accountingWebhookRouting.test.ts`
Expected: FAIL:
- the messages module does not exist;
- `delay` is never set;
- there is no `daily_budget_low` skip;
- the router drops the options.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/accounting/accountingPaymentMessages.ts`:

```ts
/**
 * Provider-labelled operator text for payment pull, payment push and the
 * reconcile worker (Xero W05; W01d deferral R3). `label` is the provider's
 * display name (`accountingProviderDisplayName`). With 'QuickBooks' every
 * function returns the exact literal the code held before W05 — these strings
 * are persisted in `last_error` / `accounting_connections.last_error`, and
 * `accountingPaymentMessages.test.ts` pins each one.
 *
 * No provider-id literal lives here (neutral-core guard).
 */

/** The reconcile worker's connection-level run error when a change window could not be fully enumerated. */
export function reconcileWindowTruncatedMessage(label: string): string {
  return `${label} truncated the last change window and the backfill did not complete; payments may be missing`;
}

/** The matching thrown/Sentry text. */
export function reconcileWindowTruncatedError(connectionId: string, label: string): string {
  return `accounting reconcile for connection ${connectionId} could not be fully enumerated `
    + `(${label} truncated the change window and the /query backfill did not complete)`;
}
```

In `jobs/accountingReconcileWorker.ts`:

1. Next to `ReconcileConnectionJobData`, add:

```ts
/** Xero W05 (refinement 5): a webhook burst coalesces into one delayed run. */
export interface ReconcileEnqueueOptions {
  /** Milliseconds before the job becomes runnable. Absent or 0 = run now (the pre-W05 add() options, byte-identical). */
  delayMs?: number;
}
```

2. `ReconcileSkipReason` gains `| 'daily_budget_low'`. Its doc comment gains a bullet: "`daily_budget_low` (Xero W05, webhook trigger only): the provider's daily call budget is under 20%; the sweep catches up (refinement 6)."

3. In `processReconcileConnectionJob`, directly **after** the `if (skipReason) { … return null; }` block:

```ts
    // Xero W05 (refinement 6): a webhook-triggered run is background work too.
    // The sweep defers at enqueue; this is the same rule for the doorbell, so a
    // signed-delivery storm cannot spend the tenant's daily budget. QuickBooks
    // declares no daily budget, so the ratio is null and this never fires.
    // Sync now ('manual') is interactive and never defers.
    if (data.trigger === 'webhook' && conn) {
      const budgetProvider = findAccountingProvider(conn.provider);
      if (
        budgetProvider
        && await shouldDeferBackgroundWork(conn.provider, budgetProvider.limits.rate, conn.id)
        // Quorum finding 3: a lost create whose Breeze payment was voided waits
        // (delete `awaiting_remote_ref`, 24 h grace) for THIS pull to adopt its
        // remote id. Deferring it for budget could outlast the grace window and
        // orphan the provider payment. Checked only after the budget says defer,
        // so QuickBooks (no daily budget) never reaches this query.
        && !(await runInDbContext(() => connectionOwesUnresolvedPaymentDelete(db, conn.id, data.partnerId)))
      ) {
        logReconcileSkip(data, 'daily_budget_low', conn);
        return null;
      }
    }
```

   In `processReconcileSweep` pass 1, apply the same exemption. Replace:

```ts
      if (provider && await shouldDeferBackgroundWork(connection.provider, provider.limits.rate, connection.id)) {
```

   with:

```ts
      if (
        provider
        && await shouldDeferBackgroundWork(connection.provider, provider.limits.rate, connection.id)
        && !(await withSystemDbAccessContext(
          () => connectionOwesUnresolvedPaymentDelete(db, connection.id, connection.partnerId),
          'accountingReconcile.sweep.owedDelete',
        ))
      ) {
```

   Import `connectionOwesUnresolvedPaymentDelete` from `../services/accounting/accountingPaymentPush`. The file already imports `listOwedPaymentMappings` from there.

   In `services/accounting/accountingPaymentPush.ts`, next to `listOwedPaymentMappings`:

```ts
/**
 * Does this connection owe a payment DELETE whose remote id only a pull can
 * recover? That is the `awaiting_remote_ref` park: a create whose response was
 * lost, then a Breeze void (Xero W05, quorum finding 3). The reconcile worker
 * and sweep never budget-defer such a connection. One indexed read, no lock.
 */
export async function connectionOwesUnresolvedPaymentDelete(
  dbc: DbExecutor,
  connectionId: string,
  partnerId: string,
): Promise<boolean> {
  const [row] = await dbc
    .select({ id: accountingEntityMappings.id })
    .from(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.integrationId, connectionId),
      eq(accountingEntityMappings.partnerId, partnerId),
      eq(accountingEntityMappings.breezeEntityType, 'payment'),
      eq(accountingEntityMappings.pendingOp, 'delete'),
      isNull(accountingEntityMappings.remoteEntityId),
    ))
    .limit(1);
  return !!row;
}
```

   (Use the executor type the neighbouring `listOwedPaymentMappings(dbc, …)` uses.)

4. Replace the two QuickBooks literals in the `overflowed` branch:

```ts
    const label = accountingProviderDisplayName(fresh.provider);
    const runError = changes.overflowed
      ? reconcileWindowTruncatedMessage(label)
      : summary.failed > 0
        ? `${summary.failed} item(s) failed in the last reconcile run`
        : null;
```

   In the `if (changes.overflowed)` block, use `const err = new Error(reconcileWindowTruncatedError(fresh.id, label));`. `accountingProviderDisplayName` comes from `../services/accounting/providerRegistry`, which the file already imports for `findAccountingProvider`, so extend that import. Import the two message functions from `../services/accounting/accountingPaymentMessages`.

5. `enqueueAccountingReconcile`:

```ts
export async function enqueueAccountingReconcile(
  connectionId: string,
  partnerId: string,
  trigger: ReconcileConnectionJobData['trigger'],
  opts?: ReconcileEnqueueOptions,
): Promise<boolean> {
  try {
    const jobId = `accounting-reconcile-${connectionId}`;
    // A delayed job still holds its jobId, so every enqueue for this connection
    // during the delay (another webhook, a sweep tick, Sync now) is dropped by
    // BullMQ and the one run starts AFTER the burst (Xero W05 refinement 5).
    const jobOpts = opts?.delayMs && opts.delayMs > 0
      ? { jobId, ...ENQUEUE_OPTS, delay: opts.delayMs }
      : { jobId, ...ENQUEUE_OPTS };
    await getAccountingReconcileQueue().add(
      'reconcile-connection',
      { type: 'reconcile-connection', connectionId, partnerId, trigger },
      jobOpts,
    );
    return true;
  } catch (err) {
    // …unchanged…
  }
}
```

In `services/accounting/accountingWebhookRouting.ts`:

```ts
import { enqueueAccountingReconcile, type ReconcileEnqueueOptions } from '../../jobs/accountingReconcileWorker';

/** Must be called with NO ambient DB context; opens its own short system context for the lookup. */
export async function routeWebhookToConnection(
  provider: AccountingProviderId,
  realmFingerprint: string,
  opts?: ReconcileEnqueueOptions,
): Promise<WebhookRouteOutcome> {
  assertNoAmbientDbContext('routeWebhookToConnection');
  const conn = await withSystemDbAccessContext(
    () => findConnectionByRealmFingerprint(db, provider, realmFingerprint),
  );
  if (!conn) return 'no_connection';
  if (!providerSupports(conn.provider, 'paymentPull')) return 'capability_unavailable';
  // Three arguments exactly when no options were given: the QuickBooks route's
  // enqueue call stays byte-identical (a pinned test).
  const ok = await runOutsideDbContext(() => (opts === undefined
    ? enqueueAccountingReconcile(conn.id, conn.partnerId, 'webhook')
    : enqueueAccountingReconcile(conn.id, conn.partnerId, 'webhook', opts)));
  return ok ? 'enqueued' : 'enqueue_failed';
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingPaymentMessages.test.ts src/jobs/accountingReconcileWorker.test.ts src/services/accounting/accountingWebhookRouting.test.ts src/services/accounting/accountingPaymentPush.test.ts src/routes/webhooks/quickbooks.test.ts src/services/accounting/neutralCore.guard.test.ts && npx tsc --noEmit -p .`
Expected: PASS, with `quickbooks.test.ts` untouched and green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/accounting/accountingPaymentMessages.ts apps/api/src/services/accounting/accountingPaymentMessages.test.ts \
  apps/api/src/jobs/accountingReconcileWorker.ts apps/api/src/jobs/accountingReconcileWorker.test.ts \
  apps/api/src/services/accounting/accountingWebhookRouting.ts apps/api/src/services/accounting/accountingWebhookRouting.test.ts \
  apps/api/src/services/accounting/accountingPaymentPush.ts apps/api/src/services/accounting/accountingPaymentPush.test.ts
git commit -m "feat(accounting): reconcile enqueue delay, webhook budget deferral, labelled run error (Xero W05)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `xeroHttp.ts` — `If-Modified-Since` reads

**Files:**
- Modify: `apps/api/src/services/accounting/xeroHttp.ts` (`xeroApiGet`, private `xeroApiCall`, new `formatXeroIfModifiedSince`)
- Test: `apps/api/src/services/accounting/xeroHttp.test.ts`

**Interfaces:**
- Consumes: M19, C1–C2 (`xeroApiCall` is W03's private shared caller).
- Produces:
  ```ts
  export function formatXeroIfModifiedSince(at: Date): string;            // 'yyyy-mm-ddThh:mm:ss' (UTC, whole seconds)
  export interface XeroGetOptions { ifModifiedSince?: Date }
  export async function xeroApiGet<T>(ctx: XeroCallContext, path: string, operation: string, opts?: XeroGetOptions): Promise<T>;
  // With opts.ifModifiedSince set, a 304 Not Modified resolves to null (callers type T as `X | null`).
  ```

- [ ] **Step 1: Write the failing tests**

Append to `xeroHttp.test.ts`. Reuse its `json`, `SPEC` and slot/note mocks, and add `formatXeroIfModifiedSince` to the existing `./xeroHttp` import:

```ts
describe('If-Modified-Since reads (Xero W05)', () => {
  const ctx = { connectionId: 'c1', tenantId: 'ten-A', accessToken: 'at', rate: SPEC };

  it('formats UTC to the second, no zone suffix (Xero: "yyyy-mm-ddThh:mm:ss")', () => {
    expect(formatXeroIfModifiedSince(new Date('2026-09-27T08:05:09.987Z'))).toBe('2026-09-27T08:05:09');
  });

  it('sends the header only when asked', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Payments: [] }))
      .mockResolvedValueOnce(json({ Payments: [] }));
    await xeroApiGet(ctx, 'Payments', 'op', { ifModifiedSince: new Date('2026-09-27T08:05:09Z') });
    await xeroApiGet(ctx, 'Payments', 'op');
    const headersOf = (i: number) => new Headers((fetchMock.mock.calls[i]![1] as RequestInit).headers);
    expect(headersOf(0).get('if-modified-since')).toBe('2026-09-27T08:05:09');
    expect(headersOf(1).get('if-modified-since')).toBeNull();
  });

  it('a 304 to a conditional read is "nothing changed" (null), never an error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 304 }));
    await expect(xeroApiGet(ctx, 'Payments', 'op', { ifModifiedSince: new Date() })).resolves.toBeNull();
  });

  it('a 304 to an UNconditional read is still an error (transient)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 304 }));
    await expect(xeroApiGet(ctx, 'Payments', 'op')).rejects.toMatchObject({ kind: 'transient', httpStatus: 304 });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroHttp.test.ts`
Expected: FAIL: `formatXeroIfModifiedSince` is not exported, the header is never sent, and the 304 throws.

- [ ] **Step 3: Implement**

In `xeroHttp.ts`:

```ts
/**
 * Xero's If-Modified-Since format: "A UTC timestamp (yyyy-mm-ddThh:mm:ss)",
 * "accurate to the second" (Requests and responses). No zone suffix.
 */
export function formatXeroIfModifiedSince(at: Date): string {
  return at.toISOString().slice(0, 19);
}

export interface XeroGetOptions {
  /** Only rows created or modified since this instant (Xero W05 payment pull). */
  ifModifiedSince?: Date;
}
```

Give `xeroApiCall` a fifth parameter, `read?: XeroGetOptions`:
- after the headers are built: `if (read?.ifModifiedSince) headers['If-Modified-Since'] = formatXeroIfModifiedSince(read.ifModifiedSince);`
- before the `!response.ok` check: `if (response.status === 304 && read?.ifModifiedSince) return null as T; // nothing changed since the cursor (lab X59)`

Then change `xeroApiGet`:

```ts
/** A tenant-scoped Accounting API GET through the rate-limit slot. With `ifModifiedSince`, a 304 resolves to null. */
export async function xeroApiGet<T>(ctx: XeroCallContext, path: string, operation: string, opts: XeroGetOptions = {}): Promise<T> {
  return xeroApiCall<T>(ctx, 'GET', path, operation, undefined, opts);
}
```

The day-remaining note still runs on a 304, because it comes before the status check.

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroHttp.test.ts src/services/accounting/xeroProvider.test.ts src/services/accounting/xeroContacts.test.ts src/services/accounting/xeroItems.test.ts src/services/accounting/xeroInvoices.test.ts && npx tsc --noEmit -p .`
Expected: PASS. Existing callers pass no options.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/accounting/xeroHttp.ts apps/api/src/services/accounting/xeroHttp.test.ts
git commit -m "feat(accounting): If-Modified-Since reads for the Xero API (Xero W05)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `xeroPayments.ts` — marker grammar and the change pull

**Files:**
- Create: `apps/api/src/services/accounting/xeroPayments.ts`
- Test: `apps/api/src/services/accounting/xeroPayments.test.ts`

**Interfaces:**
- Consumes: Task 2 (`xeroApiGet` + `ifModifiedSince`), C2 (`parseXeroDate`, `xeroQuery`, `xeroArray`), M2, M16, M18.
- Produces:
  ```ts
  export const XERO_PAYMENT_REF_MAX = 64;
  export const XERO_PULLED_REFERENCE_MAX = 255;
  export const XERO_RECONCILE_OVERLAP_MS = 300_000;
  export const XERO_RECONCILE_PAGE_SIZE = 1000;
  export const XERO_RECONCILE_MAX_REQUESTS = 10;          // per list per run, beyond the window start
  export const XERO_RECONCILE_MAX_OVERLAP_REQUESTS = 10;  // per list per run, inside the 5-minute overlap
  export function embedXeroPaymentMarker(reference: string | null, marker: string): string;
  export function extractXeroPaymentMarker(text: string | null | undefined): string | null;
  export function xeroPaymentHumanReference(text: string | null | undefined): string | null;
  export interface XeroPayment { PaymentID?; PaymentType?; Status?; Date?; Amount?; Reference?; IsReconciled?; UpdatedDateUTC?;
    Invoice?: { InvoiceID?; Type?; CurrencyCode? }; HasValidationErrors?; ValidationErrors? }
  export function xeroPaymentVersion(p: Pick<XeroPayment, 'UpdatedDateUTC'>): string | null;
  export function toChangeSetPaymentLine(p: XeroPayment, conn: Pick<AccountingConnection, 'homeCurrency'>): ChangeSetPaymentLine | null;
  export async function readXeroPaymentChanges(ctx: XeroCallContext, conn: AccountingConnection, sinceCursor: Date | null): Promise<ChangeSet>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/accounting/xeroPayments.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./accountingRateLimit', () => ({
  withProviderCallSlot: (_p: string, _s: unknown, _c: string, fn: () => unknown) => fn(),
  noteDailyRemaining: vi.fn(async () => {}),
}));

import {
  embedXeroPaymentMarker, extractXeroPaymentMarker, readXeroPaymentChanges, toChangeSetPaymentLine,
  xeroPaymentHumanReference, XERO_PAYMENT_REF_MAX, XERO_RECONCILE_PAGE_SIZE,
} from './xeroPayments';
import { buildPaymentPrivateNote } from './accountingPaymentMarker';
import { XERO_RATE_LIMIT } from './xeroProvider';
import type { AccountingConnection } from './accountingConnectionService';

const PAY_ID = '0f3c6f4e-5a1b-4c2d-9e8f-7a6b5c4d3e2f';
const MARKER = buildPaymentPrivateNote(PAY_ID);
const TENANT = '11111111-2222-3333-4444-555555555555';
const INV = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ctx = { connectionId: 'conn-1', tenantId: TENANT, accessToken: 'at', rate: XERO_RATE_LIMIT };
const conn = (over: Partial<AccountingConnection> = {}) => ({
  id: 'conn-1', partnerId: 'p1', provider: 'xero', realmId: TENANT, accessToken: 'at',
  homeCurrency: 'GBP', createdAt: new Date('2026-09-01T00:00:00Z'), ...over,
}) as AccountingConnection;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const msDate = (iso: string) => `/Date(${Date.parse(iso)}+0000)/`;
const payment = (over: Record<string, unknown> = {}) => ({
  PaymentID: 'xp-1', PaymentType: 'ACCRECPAYMENT', Status: 'AUTHORISED', Date: msDate('2026-09-20T00:00:00Z'),
  Amount: 150.5, Reference: 'CHQ 1001', IsReconciled: false, UpdatedDateUTC: msDate('2026-09-20T10:00:00Z'),
  Invoice: { InvoiceID: INV, Type: 'ACCREC', CurrencyCode: 'GBP' }, ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('payment marker (refinement 14)', () => {
  it.each([
    [null, MARKER],
    ['', MARKER],
    ['  ', MARKER],
    ['pi_3PqRsT0123456789abcdefgh', `${MARKER} | pi_3PqRsT0123456789abcdefgh`],
  ])('embed(%j) → %j and extract recovers the id', (ref, embedded) => {
    expect(embedXeroPaymentMarker(ref, MARKER)).toBe(embedded);
    expect(extractXeroPaymentMarker(embedded)).toBe(PAY_ID);
  });

  it('recovers the id for a max-length reference, and caps the field (obligation 3)', () => {
    const ref = 'R'.repeat(XERO_PAYMENT_REF_MAX + 40);
    const embedded = embedXeroPaymentMarker(ref, MARKER);
    expect(embedded.length).toBe(MARKER.length + 3 + XERO_PAYMENT_REF_MAX);
    expect(extractXeroPaymentMarker(embedded)).toBe(PAY_ID);
  });

  it('a reference that itself contains the separator or another marker cannot move ownership', () => {
    const other = buildPaymentPrivateNote('99999999-8888-7777-6666-555555555555');
    expect(extractXeroPaymentMarker(embedXeroPaymentMarker(`a | ${other}`, MARKER))).toBe(PAY_ID);
  });

  it.each([
    [`Paid via ${MARKER}`],                               // mentions, does not start with, the marker
    [MARKER.toUpperCase()],                               // grammar is lowercase-uuid only
    [`${MARKER}x`],                                       // not followed by the separator
    ['CHQ 1001'],
    [null],
  ])('%j carries no Breeze claim', (text) => {
    expect(extractXeroPaymentMarker(text)).toBeNull();
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(extractXeroPaymentMarker(`  ${MARKER} | x \n`)).toBe(PAY_ID);
  });

  it('the human reference strips our marker, keeps a foreign reference whole, and clamps to 255', () => {
    expect(xeroPaymentHumanReference(`${MARKER} | pi_1`)).toBe('pi_1');
    expect(xeroPaymentHumanReference(MARKER)).toBeNull();
    expect(xeroPaymentHumanReference('CHQ 1001')).toBe('CHQ 1001');
    expect(xeroPaymentHumanReference('X'.repeat(300))).toHaveLength(255);
    expect(xeroPaymentHumanReference('   ')).toBeNull();
  });
});

describe('toChangeSetPaymentLine (refinements 10, 12, 13, 20)', () => {
  it('maps an AR payment to one neutral line', () => {
    expect(toChangeSetPaymentLine(payment({ Reference: `${MARKER} | pi_1` }), conn())).toEqual({
      remoteInvoiceId: INV,
      remotePaymentId: 'xp-1',
      amountMinor: 15050,
      currency: 'GBP',
      txnDate: '2026-09-20',
      remotePaymentVersion: '2026-09-20T10:00:00.000Z',
      paymentMethodName: null,
      method: 'other',
      paymentRefNum: 'pi_1',
      breezePaymentId: PAY_ID,
    });
  });

  it('falls back to the connection home currency when the nested invoice omits it', () => {
    expect(toChangeSetPaymentLine(payment({ Invoice: { InvoiceID: INV } }), conn())?.currency).toBe('GBP');
  });

  it.each([
    ['a refund (AROVERPAYMENTPAYMENT)', { PaymentType: 'AROVERPAYMENTPAYMENT' }],
    ['a bill payment', { PaymentType: 'ACCPAYPAYMENT' }],
    ['a payment on a non-ACCREC document', { Invoice: { InvoiceID: INV, Type: 'ACCPAY' } }],
    ['a payment with no invoice', { Invoice: undefined }],
    ['a deleted payment (handled as a deletion, not a line)', { Status: 'DELETED' }],
    ['a payment with no id', { PaymentID: undefined }],
    ['a non-numeric amount', { Amount: 'abc' }],
  ])('skips %s', (_label, over) => {
    expect(toChangeSetPaymentLine(payment(over), conn())).toBeNull();
  });
});

describe('readXeroPaymentChanges (refinements 9, 11)', () => {
  const since = new Date('2026-09-20T09:00:00Z');
  let fetchMock: ReturnType<typeof vi.spyOn>;
  const urlOf = (i: number) => String(fetchMock.mock.calls[i]![0]);
  const headerOf = (i: number, h: string) => new Headers((fetchMock.mock.calls[i]![1] as RequestInit).headers).get(h);

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, 'fetch');
  });

  it('reads AR payments and voided/deleted AR invoices since cursor − 5 min, in two calls', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [payment(), payment({ PaymentID: 'xp-2', Status: 'DELETED', UpdatedDateUTC: msDate('2026-09-20T11:00:00Z') })] }))
      .mockResolvedValueOnce(json({ Invoices: [{ InvoiceID: 'inv-v', Type: 'ACCREC', Status: 'VOIDED', UpdatedDateUTC: msDate('2026-09-20T10:30:00Z') }] }));

    const changes = await readXeroPaymentChanges(ctx, conn(), since);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(0)).toBe('https://api.xero.com/api.xro/2.0/Payments?where=PaymentType%3D%3D%22ACCRECPAYMENT%22&order=UpdatedDateUTC+ASC&page=1&pageSize=1000');
    expect(urlOf(1)).toBe('https://api.xero.com/api.xro/2.0/Invoices?Statuses=VOIDED%2CDELETED&where=Type%3D%3D%22ACCREC%22&order=UpdatedDateUTC+ASC&page=1&pageSize=1000');
    expect(headerOf(0, 'if-modified-since')).toBe('2026-09-20T08:55:00');
    expect(headerOf(1, 'if-modified-since')).toBe('2026-09-20T08:55:00');
    expect(changes.payments.map((l) => l.remotePaymentId)).toEqual(['xp-1']);
    expect(changes.deletedPayments).toEqual(['xp-2']);
    expect(changes.unappliedPayments).toEqual([]);
    expect(changes.deletedInvoices).toEqual(['inv-v']);
    expect(changes.cursor.toISOString()).toBe('2026-09-20T11:00:00.000Z'); // newest UpdatedDateUTC read
    expect(changes.overflowed).toBe(false);
  });

  it('a first run (no cursor) reads from the connection creation', async () => {
    fetchMock.mockResolvedValueOnce(json({ Payments: [] })).mockResolvedValueOnce(json({ Invoices: [] }));
    const changes = await readXeroPaymentChanges(ctx, conn(), null);
    expect(headerOf(0, 'if-modified-since')).toBe('2026-08-31T23:55:00');
    expect(changes.cursor.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('nothing changed (304 or empty) leaves the cursor where it was — never moves it backwards', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 304 })).mockResolvedValueOnce(json({ Invoices: [] }));
    const changes = await readXeroPaymentChanges(ctx, conn(), since);
    expect(changes.cursor.toISOString()).toBe(since.toISOString());
    expect(changes.payments).toEqual([]);
  });

  it('seeks: a full page is followed by page 1 again, from its last row − 1 s (never page=2)', async () => {
    const full = Array.from({ length: XERO_RECONCILE_PAGE_SIZE }, (_, i) =>
      payment({ PaymentID: `xp-${i}`, UpdatedDateUTC: msDate(`2026-09-20T10:00:${String(i % 60).padStart(2, '0')}Z`) }));
    full[full.length - 1] = payment({ PaymentID: 'xp-end', UpdatedDateUTC: msDate('2026-09-20T10:30:00Z') });
    fetchMock
      .mockResolvedValueOnce(json({ Payments: full }))
      .mockResolvedValueOnce(json({ Payments: [payment({ PaymentID: 'last', UpdatedDateUTC: msDate('2026-09-20T12:00:00Z') })] }))
      .mockResolvedValueOnce(json({ Invoices: [] }));
    const changes = await readXeroPaymentChanges(ctx, conn(), since);
    expect(urlOf(1)).toContain('page=1');
    expect(urlOf(1)).not.toContain('page=2');
    expect(headerOf(1, 'if-modified-since')).toBe('2026-09-20T10:29:59');
    expect(changes.payments).toHaveLength(XERO_RECONCILE_PAGE_SIZE + 1);
    expect(changes.cursor.toISOString()).toBe('2026-09-20T12:00:00.000Z');
  });

  it('a row updated between two requests is not lost, and its later read wins (quorum finding 1)', async () => {
    const full = Array.from({ length: XERO_RECONCILE_PAGE_SIZE }, (_, i) =>
      payment({ PaymentID: `xp-${i}`, UpdatedDateUTC: msDate('2026-09-20T10:00:00Z') }));
    full[full.length - 1] = payment({ PaymentID: 'xp-end', UpdatedDateUTC: msDate('2026-09-20T10:10:00Z') });
    fetchMock
      .mockResolvedValueOnce(json({ Payments: full }))
      // xp-0 was deleted after the first read; 'unseen' was the row offset paging would have skipped.
      .mockResolvedValueOnce(json({ Payments: [
        payment({ PaymentID: 'unseen', UpdatedDateUTC: msDate('2026-09-20T10:11:00Z') }),
        payment({ PaymentID: 'xp-0', Status: 'DELETED', UpdatedDateUTC: msDate('2026-09-20T10:12:00Z') }),
      ] }))
      .mockResolvedValueOnce(json({ Invoices: [] }));
    const changes = await readXeroPaymentChanges(ctx, conn(), since);
    expect(changes.payments.map((l) => l.remotePaymentId)).toContain('unseen');
    expect(changes.payments.map((l) => l.remotePaymentId)).not.toContain('xp-0');
    expect(changes.deletedPayments).toEqual(['xp-0']);
  });

  it('pages inside the 5-minute overlap do not use up the progress budget (quorum finding 7)', async () => {
    let minute = 55;                                   // 08:55, 08:56, … are all ≤ windowStart (09:00)
    fetchMock.mockImplementation(async (input) => {
      if (String(input).includes('/Invoices')) return json({ Invoices: [] });
      if (minute > 58) return json({ Payments: [payment({ PaymentID: 'fresh', UpdatedDateUTC: msDate('2026-09-20T09:10:00Z') })] });
      const at = msDate(`2026-09-20T08:${minute}:00Z`);
      const rows = Array.from({ length: XERO_RECONCILE_PAGE_SIZE }, (_, i) => payment({ PaymentID: `o${minute}-${i}`, UpdatedDateUTC: at }));
      minute += 1;
      return json({ Payments: rows });
    });
    const changes = await readXeroPaymentChanges(ctx, conn(), since);
    expect(changes.overflowed).toBe(false);
    expect(changes.cursor.toISOString()).toBe('2026-09-20T09:10:00.000Z');
  });

  it('a list that hits the request cap moves the cursor only to its last row, not to the other list\'s newest', async () => {
    let t = Date.parse('2026-09-20T09:30:00Z');
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/Invoices')) return json({ Invoices: [{ InvoiceID: 'v', Type: 'ACCREC', Status: 'VOIDED', UpdatedDateUTC: msDate('2026-09-20T23:00:00Z') }] });
      const rows = Array.from({ length: XERO_RECONCILE_PAGE_SIZE }, (_, i) => payment({ PaymentID: `p${t}-${i}`, UpdatedDateUTC: `/Date(${t}+0000)/` }));
      t += 60_000;
      return json({ Payments: rows });
    });
    const changes = await readXeroPaymentChanges(ctx, conn(), since);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/Payments'))).toHaveLength(10); // cap
    expect(changes.overflowed).toBe(false);
    expect(changes.cursor.toISOString()).toBe(new Date(Date.parse('2026-09-20T09:30:00Z') + 9 * 60_000).toISOString());
  });

  it('1,000 rows inside one second stall the list: overflowed, cursor held (the worker surfaces it)', async () => {
    fetchMock.mockImplementation(async (input) => String(input).includes('/Invoices')
      ? json({ Invoices: [] })
      : json({ Payments: Array.from({ length: XERO_RECONCILE_PAGE_SIZE }, (_, i) => payment({ PaymentID: `p-${i}`, UpdatedDateUTC: msDate('2026-09-20T10:00:00Z') })) }));
    const changes = await readXeroPaymentChanges(ctx, conn(), since);
    expect(changes.overflowed).toBe(true);
    expect(changes.cursor.toISOString()).toBe(since.toISOString());
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/Payments'))).toHaveLength(2); // stopped, no spin
  });

  it('keeps DELETED ids unique and drops payments on bills and credit notes', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [
        payment({ PaymentID: 'd', Status: 'DELETED' }),
        payment({ PaymentID: 'd', Status: 'DELETED' }),
        payment({ PaymentID: 'bill', Invoice: { InvoiceID: INV, Type: 'ACCPAY' } }),
      ] }))
      .mockResolvedValueOnce(json({ Invoices: [{ InvoiceID: 'bill-v', Type: 'ACCPAY', Status: 'VOIDED' }] }));
    const changes = await readXeroPaymentChanges(ctx, conn(), since);
    expect(changes.deletedPayments).toEqual(['d']);
    expect(changes.payments).toEqual([]);
    expect(changes.deletedInvoices).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroPayments.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/accounting/xeroPayments.ts`:

```ts
/**
 * Xero payments (spec W05). Pure Xero wire logic behind the neutral payment
 * core: the ownership marker in `Payment.Reference`, the If-Modified-Since
 * change pull, and (W05b) create / delete with adoption.
 *
 * Xero payments are delete-only ("Payments cannot be modified, only created and
 * deleted") and each applies to exactly ONE invoice, so a ChangeSet from here
 * never carries `unappliedPayments`, and the mapping id stays
 * `<PaymentID>/<InvoiceID>` (paymentMappingRemoteId).
 *
 * No function here is named createPayment/deletePayment (the call-site guard in
 * accountingInvoicePushCallSites.test.ts); the provider class wires them.
 */
import { toMinorUnits } from '@breeze/shared';
import { parseBreezePaymentMarker } from './accountingPaymentMarker';
import { parseXeroDate, xeroApiGet, xeroArray, xeroQuery, type XeroCallContext } from './xeroHttp';
import type { AccountingConnection } from './accountingConnectionService';
import type { ChangeSet, ChangeSetPaymentLine } from './types';

/** `limits.paymentRefMax`: the RAW human reference the core may pass (refinement 14). */
export const XERO_PAYMENT_REF_MAX = 64;
/** `invoice_payments.reference` is varchar(255); a pulled reference is clamped to it. */
export const XERO_PULLED_REFERENCE_MAX = 255;
export const XERO_RECONCILE_OVERLAP_MS = 5 * 60 * 1000;
export const XERO_RECONCILE_PAGE_SIZE = 1000;
/** Seek requests per list per run that move past the window start (refinement 11). */
export const XERO_RECONCILE_MAX_REQUESTS = 10;
/** Seek requests per list per run spent re-reading the overlap before the window start. */
export const XERO_RECONCILE_MAX_OVERLAP_REQUESTS = 10;
const MARKER_SEPARATOR = ' | ';

export interface XeroPayment {
  PaymentID?: string;
  PaymentType?: string;
  Status?: string;
  Date?: string;
  Amount?: number;
  Reference?: string;
  IsReconciled?: boolean;
  UpdatedDateUTC?: string;
  Invoice?: { InvoiceID?: string; Type?: string; CurrencyCode?: string };
  HasValidationErrors?: boolean;
  ValidationErrors?: Array<{ Message?: string }>;
}

interface XeroInvoiceRow { InvoiceID?: string; Type?: string; Status?: string; UpdatedDateUTC?: string }

// ---------------------------------------------------------------------------
// Ownership marker
// ---------------------------------------------------------------------------

/**
 * The marker FIRST, then the human reference: if Xero ever truncated the
 * field, it would cut the reference, never the ownership key. The core has
 * already cut the reference to XERO_PAYMENT_REF_MAX; the slice here is a
 * second, defensive cap.
 */
export function embedXeroPaymentMarker(reference: string | null, marker: string): string {
  const ref = reference?.trim() ?? '';
  return ref ? `${marker}${MARKER_SEPARATOR}${ref.slice(0, XERO_PAYMENT_REF_MAX)}` : marker;
}

function markerHead(trimmed: string): string {
  const at = trimmed.indexOf(MARKER_SEPARATOR);
  return at === -1 ? trimmed : trimmed.slice(0, at);
}

/**
 * The Breeze payment id this Reference claims, or null. Reuses the anchored
 * QuickBooks grammar on the text BEFORE the first separator, so a Reference
 * that merely mentions a Breeze id never claims a row. A claim is still not an
 * authorisation: the pull adopts only a pending Breeze-origin row on the same
 * invoice for the same amount (accountingPaymentPull adoptBreezeOriginPayment).
 */
export function extractXeroPaymentMarker(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  return parseBreezePaymentMarker(markerHead(text.trim()));
}

/** The human part of a Reference: after our marker, or the whole Reference when it carries none; ≤255; null when empty. */
export function xeroPaymentHumanReference(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  let human = trimmed;
  if (extractXeroPaymentMarker(trimmed) !== null) {
    const at = trimmed.indexOf(MARKER_SEPARATOR);
    human = at === -1 ? '' : trimmed.slice(at + MARKER_SEPARATOR.length).trim();
  }
  return human ? human.slice(0, XERO_PULLED_REFERENCE_MAX) : null;
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

/** The ONE normalisation of a payment's version (refinement 13): ISO UpdatedDateUTC. */
export function xeroPaymentVersion(p: Pick<XeroPayment, 'UpdatedDateUTC'>): string | null {
  return parseXeroDate(p.UpdatedDateUTC);
}

function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function isReceivable(p: XeroPayment): boolean {
  return p.PaymentType === 'ACCRECPAYMENT'
    && typeof p.PaymentID === 'string' && p.PaymentID !== ''
    && typeof p.Invoice?.InvoiceID === 'string' && p.Invoice.InvoiceID !== ''
    && (p.Invoice.Type === undefined || p.Invoice.Type === 'ACCREC');
}

/**
 * One AUTHORISED receivable payment → one neutral line; anything else → null.
 * Overpayment/prepayment "payments" are REFUNDS and never reach here
 * (refinement 10). Xero has no payment-method field, so `method` is `other`
 * (never inferred, refinement 20).
 */
export function toChangeSetPaymentLine(
  p: XeroPayment,
  conn: Pick<AccountingConnection, 'homeCurrency'>,
): ChangeSetPaymentLine | null {
  if (!isReceivable(p) || p.Status !== 'AUTHORISED') return null;
  if (typeof p.Amount !== 'number' || !Number.isFinite(p.Amount)) return null;
  const currency = normalizeCurrency(p.Invoice?.CurrencyCode) ?? conn.homeCurrency ?? '';
  return {
    remoteInvoiceId: p.Invoice!.InvoiceID!,
    remotePaymentId: p.PaymentID!,
    amountMinor: toMinorUnits(p.Amount, currency),
    currency,
    txnDate: parseXeroDate(p.Date)?.slice(0, 10) ?? '',
    remotePaymentVersion: xeroPaymentVersion(p),
    paymentMethodName: null,
    method: 'other',
    paymentRefNum: xeroPaymentHumanReference(p.Reference),
    breezePaymentId: extractXeroPaymentMarker(p.Reference),
  };
}

interface SeekRead<T> {
  rows: T[];
  /** The request cap was hit: rows newer than `newest` may remain. */
  capped: boolean;
  /** A full page made no progress (1,000 rows inside one second). */
  stalled: boolean;
  newest: Date | null;
}

function dateOf(value: unknown): Date | null {
  const iso = parseXeroDate(value);
  return iso ? new Date(iso) : null;
}

function newestOf(rows: ReadonlyArray<{ UpdatedDateUTC?: string }>): Date | null {
  let newest: Date | null = null;
  for (const row of rows) {
    const at = dateOf(row.UpdatedDateUTC);
    if (at && (!newest || at > newest)) newest = at;
  }
  return newest;
}

/**
 * Every row of one list modified since `readFrom`, by SEEK paging (refinement 9):
 * each request is page 1, and a full page is followed by a request from
 * (its last row's UpdatedDateUTC − 1 s). Offset paging would lose a row whenever
 * a row on an earlier page is updated mid-read (quorum finding 1). Rows read
 * twice are de-duplicated by id; the later read wins.
 *
 * Pages that end at or before `windowStart` (the 5-minute overlap) do not count
 * against XERO_RECONCILE_MAX_REQUESTS, so a dense overlap cannot stall the pull
 * (quorum finding 7); they have their own XERO_RECONCILE_MAX_OVERLAP_REQUESTS.
 */
async function readSeek<T extends { UpdatedDateUTC?: string }>(
  ctx: XeroCallContext,
  path: 'Payments' | 'Invoices',
  params: Record<string, string>,
  idOf: (row: T) => string | undefined,
  readFrom: Date,
  windowStart: Date,
  operation: string,
): Promise<SeekRead<T>> {
  const byId = new Map<string, T>();
  let since = readFrom;
  let lastEnd: number | null = null;
  let progressRequests = 0;
  let overlapRequests = 0;
  const done = (capped: boolean, stalled: boolean, newest?: Date): SeekRead<T> => {
    const rows = [...byId.values()];
    return { rows, capped, stalled, newest: newest ?? newestOf(rows) };
  };
  for (;;) {
    const body = await xeroApiGet<Record<string, unknown> | null>(
      ctx,
      `${path}${xeroQuery({ ...params, page: 1, pageSize: XERO_RECONCILE_PAGE_SIZE })}`,
      operation,
      { ifModifiedSince: since },
    );
    const pageRows = body === null ? [] : xeroArray<T>(body[path]);
    for (const row of pageRows) {
      const id = idOf(row);
      if (!id) continue;
      byId.delete(id);          // re-insert so iteration order follows the latest read
      byId.set(id, row);
    }
    if (pageRows.length < XERO_RECONCILE_PAGE_SIZE) return done(false, false);

    const end = dateOf(pageRows[pageRows.length - 1]!.UpdatedDateUTC)?.getTime() ?? null;
    if (end === null || (lastEnd !== null && end <= lastEnd)) return done(true, true);
    lastEnd = end;
    if (end <= windowStart.getTime()) overlapRequests += 1; else progressRequests += 1;
    if (progressRequests >= XERO_RECONCILE_MAX_REQUESTS || overlapRequests >= XERO_RECONCILE_MAX_OVERLAP_REQUESTS) {
      return done(true, false, new Date(end));
    }
    since = new Date(end - 1000);
  }
}

/**
 * `reconcileChanges` for Xero (refinements 9–13). Two paged, conditional reads:
 * AR payments (AUTHORISED → lines, DELETED → deletions) and voided/deleted AR
 * invoices. The cursor is the newest UpdatedDateUTC actually read, never below
 * the window start; a list that hit the page cap limits it to that list's last
 * row; a capped list with no progress at all is `overflowed`.
 *
 * Assumes `conn.accessToken` is valid (the worker resolves it first); issues no
 * DB queries.
 */
export async function readXeroPaymentChanges(
  ctx: XeroCallContext,
  conn: AccountingConnection,
  sinceCursor: Date | null,
): Promise<ChangeSet> {
  const windowStart = new Date(Math.max(sinceCursor?.getTime() ?? 0, conn.createdAt?.getTime() ?? 0));
  const readFrom = new Date(windowStart.getTime() - XERO_RECONCILE_OVERLAP_MS);

  const payments = await readSeek<XeroPayment>(
    ctx, 'Payments', { where: 'PaymentType=="ACCRECPAYMENT"', order: 'UpdatedDateUTC ASC' },
    (p) => p.PaymentID, readFrom, windowStart, 'Xero payment changes',
  );
  const invoices = await readSeek<XeroInvoiceRow>(
    ctx, 'Invoices', { Statuses: 'VOIDED,DELETED', where: 'Type=="ACCREC"', order: 'UpdatedDateUTC ASC' },
    (i) => i.InvoiceID, readFrom, windowStart, 'Xero invoice void changes',
  );

  const lines = new Map<string, ChangeSetPaymentLine>();
  const deleted = new Set<string>();
  for (const p of payments.rows) {
    if (!isReceivable(p)) continue;
    if (p.Status === 'DELETED') { deleted.add(p.PaymentID!); lines.delete(p.PaymentID!); continue; }
    const line = toChangeSetPaymentLine(p, conn);
    if (line && !deleted.has(line.remotePaymentId)) lines.set(line.remotePaymentId, line);
  }
  const deletedInvoices = [...new Set(invoices.rows
    .filter((i) => typeof i.InvoiceID === 'string' && (i.Type ?? 'ACCREC') === 'ACCREC' && (i.Status === 'VOIDED' || i.Status === 'DELETED'))
    .map((i) => i.InvoiceID!))];

  let cursor = windowStart;
  let overflowed = false;
  const capped = [payments, invoices].filter((r) => r.capped);
  if (capped.some((r) => r.stalled)) {
    overflowed = true; // no progress possible: the worker holds the cursor and surfaces it
  } else if (capped.length > 0) {
    const earliest = Math.min(...capped.map((r) => r.newest?.getTime() ?? -Infinity));
    if (earliest <= windowStart.getTime()) overflowed = true;
    else cursor = new Date(earliest);
  } else {
    const newest = Math.max(payments.newest?.getTime() ?? -Infinity, invoices.newest?.getTime() ?? -Infinity);
    if (newest > windowStart.getTime()) cursor = new Date(newest);
  }

  return {
    cursor,
    payments: [...lines.values()],
    deletedPayments: [...deleted],
    unappliedPayments: [],
    deletedInvoices,
    overflowed,
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroPayments.test.ts src/services/accounting/neutralCore.guard.test.ts && npx tsc --noEmit -p .`
Expected: PASS. W03's `xeroQuery` may encode spaces and commas differently from the URL literals above (`+`/`%20`, `%2C`). If so, change **only the test literals** to W03's real encoding (Xero decodes both), and note it in the PR body.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/accounting/xeroPayments.ts apps/api/src/services/accounting/xeroPayments.test.ts
git commit -m "feat(accounting): Xero payment marker and If-Modified-Since change pull (Xero W05)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `POST /webhooks/xero` — signature, events, routing, registries

**Files:**
- Create: `apps/api/src/routes/webhooks/xero.ts`
- Test: `apps/api/src/routes/webhooks/xero.test.ts`
- Modify: `apps/api/src/services/accounting/xeroProvider.ts` (`verifyWebhook`) + `xeroProvider.test.ts`
- Modify: `apps/api/src/index.ts` (import + mount after `quickbooksWebhookRoutes`)
- Modify: `apps/api/src/__tests__/routerAuthGate.contract.test.ts` (`EXEMPT`), `apps/api/src/routes/webhooks.mountOrder.test.ts`, `apps/api/src/services/mcpCoverage.ts`, `apps/api/src/middleware/bodyLimit.test.ts`, `apps/api/src/services/sentryEventCodes.ts`, `scripts/docs-review/mapping.json`
- Modify: `apps/api/src/middleware/partnerGuard.ts` (`isPartnerGuardExemptPath`) + its test (quorum finding 10)

**Interfaces:**
- Consumes: Task 1 (`routeWebhookToConnection(…, { delayMs })`), M7–M11, M21, B2.
- Produces:
  ```ts
  // routes/webhooks/xero.ts
  export const xeroWebhookRoutes: Hono;
  export const XERO_WEBHOOK_RECONCILE_DELAY_MS = 30_000;
  export const MAX_TENANTS_PER_PAYLOAD = 50;
  export const MAX_EVENTS_SCANNED = 1000;
  export function tenantFingerprint(tenantId: string): string; // hmacFingerprint, same bytes W02b stored (B2)
  // xeroProvider.verifyWebhook(signatureHeader, rawBody, signingKey): boolean — base64 HMAC-SHA256, timingSafeEqual
  ```

- [ ] **Step 1: Write the failing tests**

In `xeroProvider.test.ts`, remove `verifyWebhook` from the "methods behind later waves" table (it asserted `false`), add `import { createHmac } from 'node:crypto';`, and append:

```ts
describe('verifyWebhook (Xero W05 refinement 2)', () => {
  const KEY = 'test-signing-key';
  const body = '{"events":[],"firstEventSequence":0,"lastEventSequence":0,"entropy":"ABC"}';
  const sign = (raw: string, key = KEY) => createHmac('sha256', key).update(raw, 'utf8').digest('base64');

  it('accepts base64(HMAC-SHA256(raw body, key))', () => {
    expect(xeroProvider.verifyWebhook(sign(body), body, KEY)).toBe(true);
  });
  it.each([
    ['a different key', () => sign(body, 'other')],
    ['a different body', () => sign(`${body} `)],
    ['a same-length wrong signature', () => sign(body).replace(/^./, (c) => (c === 'A' ? 'B' : 'A'))],
    ['a truncated signature', () => sign(body).slice(0, 10)],
    ['an empty signature', () => ''],
  ])('rejects %s', (_l, sig) => {
    expect(xeroProvider.verifyWebhook(sig(), body, KEY)).toBe(false);
  });
  it('rejects everything when no key is configured', () => {
    expect(xeroProvider.verifyWebhook(sign(body, ''), body, '')).toBe(false);
  });
});
```

Create `apps/api/src/routes/webhooks/xero.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// UNAUTHENTICATED route, Xero-signed. The REAL provider verifier runs (so the
// test proves HMAC-before-parse with real signatures); the limiter, client IP,
// router and fingerprint are mocked.
const m = vi.hoisted(() => ({
  rateLimiter: vi.fn(async () => ({ allowed: true })),
  route: vi.fn(async () => 'enqueued' as string),
  fingerprint: vi.fn((t: string) => `fp:${t}`),
  captureMessage: vi.fn(),
}));
vi.mock('../../services/rate-limit', () => ({ rateLimiter: m.rateLimiter }));
vi.mock('../../services/redis', () => ({ getRedis: () => ({}) }));
vi.mock('../../services/clientIp', async (orig) => ({
  rateLimitIpKey: (await orig<typeof import('../../services/clientIp')>()).rateLimitIpKey,
  getTrustedClientIp: () => '1.2.3.4',
}));
vi.mock('../../services/accounting/providerRegistry', async () => {
  const { xeroProvider } = await vi.importActual<typeof import('../../services/accounting/xeroProvider')>('../../services/accounting/xeroProvider');
  return { getAccountingProvider: () => xeroProvider };
});
vi.mock('../../services/accounting/accountingWebhookRouting', () => ({ routeWebhookToConnection: m.route }));
vi.mock('../../services/secretCrypto', () => ({ hmacFingerprint: m.fingerprint }));
vi.mock('../../services/sentry', () => ({ captureMessage: m.captureMessage }));

import { MAX_TENANTS_PER_PAYLOAD, XERO_WEBHOOK_RECONCILE_DELAY_MS, xeroWebhookRoutes } from './xero';

const KEY = 'test-signing-key';
const T1 = '11111111-2222-3333-4444-555555555555';
const T2 = '66666666-7777-8888-9999-000000000000';
const sign = (raw: string) => createHmac('sha256', KEY).update(raw, 'utf8').digest('base64');
const event = (over: Record<string, unknown> = {}) => ({
  resourceUrl: 'https://api.xero.com/api.xro/2.0/Invoices/abc', resourceId: 'abc', eventDateUtc: '2026-09-27T08:00:00.000',
  eventType: 'UPDATE', eventCategory: 'INVOICE', tenantId: T1, tenantType: 'ORGANISATION', ...over,
});
const payload = (events: unknown[]) => JSON.stringify({ events, firstEventSequence: 1, lastEventSequence: events.length, entropy: 'XYZ' });
function post(body: string, sig: string | null = sign(body)) {
  return xeroWebhookRoutes.request('/xero', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(sig === null ? {} : { 'x-xero-signature': sig }) },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.XERO_WEBHOOK_KEY = KEY;
  m.route.mockResolvedValue('enqueued');
  m.rateLimiter.mockResolvedValue({ allowed: true });
});
afterEach(() => {
  delete process.env.XERO_WEBHOOK_KEY;
  vi.restoreAllMocks();
});

describe('POST /webhooks/xero', () => {
  it('intent to receive: a signed empty batch → exactly 200, empty body, no cookie, no lookup', async () => {
    const res = await post(payload([]));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(m.route).not.toHaveBeenCalled();
  });

  it('intent to receive: a badly signed batch → 401, empty body', async () => {
    const res = await post(payload([]), 'bm90LXRoZS1zaWduYXR1cmU=');
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
  });

  it('checks the signature BEFORE parsing or looking anything up (malformed body + bad sig → 401, not 400)', async () => {
    const parse = vi.spyOn(JSON, 'parse');
    const res = await post('{not json', 'AAAA');
    expect(res.status).toBe(401);
    expect(parse).not.toHaveBeenCalled();
    expect(m.fingerprint).not.toHaveBeenCalled();
    expect(m.route).not.toHaveBeenCalled();
  });

  it('a missing signature header is 401', async () => {
    expect((await post(payload([event()]), null)).status).toBe(401);
    expect(m.route).not.toHaveBeenCalled();
  });

  it('a signed but unparseable body is 400; a signed body without events[] is 400', async () => {
    expect((await post('{not json')).status).toBe(400);
    expect((await post('{"foo":1}')).status).toBe(400);
  });

  it('without XERO_WEBHOOK_KEY: 503 (never 200), one throttled Sentry message, no lookup', async () => {
    delete process.env.XERO_WEBHOOK_KEY;
    const body = payload([event()]);
    expect((await post(body)).status).toBe(503);
    expect((await post(body)).status).toBe(503);
    expect(m.captureMessage).toHaveBeenCalledTimes(1);
    expect(m.captureMessage).toHaveBeenCalledWith(expect.any(String), { eventCode: 'accounting_webhook_signing_key_missing' });
    expect(m.route).not.toHaveBeenCalled();
  });

  it('the IP limiter refusing (incl. a Redis outage) is 429 before any verification', async () => {
    m.rateLimiter.mockResolvedValueOnce({ allowed: false });
    expect((await post(payload([event()]))).status).toBe(429);
    expect(m.route).not.toHaveBeenCalled();
  });

  it('routes each distinct ORGANISATION tenant with an INVOICE event once, delayed', async () => {
    const res = await post(payload([event(), event({ eventType: 'CREATE' }), event({ tenantId: T2 })]));
    expect(res.status).toBe(200);
    expect(m.route.mock.calls).toEqual([
      ['xero', `fp:${T1}`, { delayMs: XERO_WEBHOOK_RECONCILE_DELAY_MS }],
      ['xero', `fp:${T2}`, { delayMs: XERO_WEBHOOK_RECONCILE_DELAY_MS }],
    ]);
  });

  it.each([
    ['a CONTACT event', { eventCategory: 'CONTACT' }],
    ['a CREDITNOTE event', { eventCategory: 'CREDITNOTE' }],
    ['a SUBSCRIPTION (APPLICATION) event', { eventCategory: 'SUBSCRIPTION', tenantType: 'APPLICATION' }],
    ['a non-GUID tenant id', { tenantId: "x' OR 1=1" }],
    ['a missing tenant id', { tenantId: undefined }],
  ])('ignores %s (200, no lookup)', async (_l, over) => {
    const res = await post(payload([event(over)]));
    expect(res.status).toBe(200);
    expect(m.route).not.toHaveBeenCalled();
  });

  it('caps distinct tenants per delivery', async () => {
    const tenants = Array.from({ length: MAX_TENANTS_PER_PAYLOAD + 5 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
    await post(payload(tenants.map((tenantId) => event({ tenantId }))));
    expect(m.route).toHaveBeenCalledTimes(MAX_TENANTS_PER_PAYLOAD);
  });

  it.each(['no_connection', 'capability_unavailable'])('a %s tenant is dropped and still answers 200', async (outcome) => {
    m.route.mockResolvedValueOnce(outcome);
    expect((await post(payload([event()]))).status).toBe(200);
  });

  it('ANY failed enqueue answers 503 so Xero retries (jobId dedupe makes the retry free)', async () => {
    m.route.mockResolvedValueOnce('enqueued').mockResolvedValueOnce('enqueue_failed');
    expect((await post(payload([event(), event({ tenantId: T2 })]))).status).toBe(503);
  });

  it('a thrown lookup answers 503, never a bare 500', async () => {
    m.route.mockRejectedValueOnce(new Error('db down'));
    expect((await post(payload([event()]))).status).toBe(503);
  });

  it('never logs tenant or resource ids', async () => {
    const info = vi.spyOn(console, 'info');
    await post(payload([event()]));
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain(T1);
    expect(logged).not.toContain('"abc"');
  });
});
```

In `routes/webhooks.mountOrder.test.ts`, import `xeroWebhookRoutes` next to `quickbooksWebhookRoutes`, add `app.route('/webhooks', xeroWebhookRoutes);` to `buildApp()` after QuickBooks, and add:

```ts
  it('Xero webhook reaches the signature handler, not session auth (no sig → empty 401)', async () => {
    process.env.XERO_WEBHOOK_KEY = 'k';
    const res = await buildApp().request('/webhooks/xero', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(''); // session auth answers JSON "Missing or invalid authorization header"
    delete process.env.XERO_WEBHOOK_KEY;
  });
```

(If that file mocks `../services/accounting/providerRegistry`, extend its `getAccountingProvider` mock so `'xero'` returns `{ verifyWebhook: () => false }`.)

In the partner-guard test (`ls apps/api/src/middleware/partnerGuard*.test.ts`; add a describe if none covers `isPartnerGuardExemptPath`):

```ts
describe('isPartnerGuardExemptPath — signature-authenticated webhooks (Xero W05, quorum finding 10)', () => {
  it('exempts exactly the Xero webhook path, so a bearer token cannot trigger partner reads before the HMAC', () => {
    expect(isPartnerGuardExemptPath('/api/v1/webhooks/xero')).toBe(true);
    expect(isPartnerGuardExemptPath('/api/v1/webhooks/xero/')).toBe(false);
    expect(isPartnerGuardExemptPath('/api/v1/webhooks')).toBe(false);          // the CRUD webhook router stays guarded
    expect(isPartnerGuardExemptPath('/api/v1/webhooks/quickbooks')).toBe(false); // QuickBooks byte-identical (follow-up issue)
  });
});
```

In `middleware/bodyLimit.test.ts`, inside `describe('bodyLimitForPath')`:

```ts
  it('keeps the 1MB default on the public Xero webhook (Xero W05 refinement 8)', () => {
    expect(bodyLimitForPath('/api/v1/webhooks/xero')).toMatchObject({ rule: 'default', maxSize: 1024 * 1024 });
  });
```

(If the file's first test compares against a constant other than `1024 * 1024`, use that constant.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/webhooks/xero.test.ts src/services/accounting/xeroProvider.test.ts src/routes/webhooks.mountOrder.test.ts src/middleware/bodyLimit.test.ts`
Expected: FAIL, because the route module does not exist and `verifyWebhook` returns `false`. The body-limit test already passes: it pins today's behaviour for this path.

- [ ] **Step 3: Implement**

In `xeroProvider.ts`, add `import { createHmac, timingSafeEqual } from 'node:crypto';` and replace the stub:

```ts
  /**
   * `x-xero-signature` = base64(HMAC-SHA256(raw body, XERO_WEBHOOK_KEY))
   * (Webhooks guide). Constant-time on equal-length buffers; a length mismatch
   * is false without comparing. Never throws.
   */
  verifyWebhook(signatureHeader: string, rawBody: string, signingKey: string): boolean {
    if (!signatureHeader || !signingKey) return false;
    const expected = createHmac('sha256', signingKey).update(rawBody, 'utf8').digest('base64');
    const left = Buffer.from(signatureHeader.trim(), 'utf8');
    const right = Buffer.from(expected, 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
  }
```

In `services/sentryEventCodes.ts`, after `'accounting_webhook_verifier_token_missing',`:

```ts
  /** The Xero webhook route was reached with XERO_WEBHOOK_KEY unset. */
  'accounting_webhook_signing_key_missing',
```

Create `apps/api/src/routes/webhooks/xero.ts`:

```ts
// apps/api/src/routes/webhooks/xero.ts
//
// Xero webhook route (spec W05).
//
// POST /api/v1/webhooks/xero
//
// Intentionally unauthenticated: security is ONLY the HMAC of the raw body
// against XERO_WEBHOOK_KEY. Mounted outside the auth chain (index.ts), like
// the QuickBooks route. A doorbell, not a data source: it never reads event
// resource ids; the reconcile job re-reads Xero with the connection's own token
// and stored tenant id.
//
// Order (the security contract, refinement 2): IP limiter -> raw body -> key
// present -> signature (constant time) -> JSON.parse -> shape -> per-tenant
// routing through the shared system-scoped router (refinement 7).
//
// Status matrix (Xero retries a non-2xx immediately, then every 15 min, and
// disables the subscription after 24 h of failures):
//   429 — IP limiter denies (fails closed on a Redis outage)              -> retried
//   503 — XERO_WEBHOOK_KEY unset (never 200: nothing was verified)        -> retried
//   401 — missing or bad x-xero-signature, EMPTY body (intent to receive) -> not retried
//   400 — signed body is not JSON / has no events[]                       -> retried
//   503 — ANY enqueue failed, or a lookup threw                           -> retried (jobId dedupe)
//   200 — handled, EMPTY body, incl. intent-to-receive (events: []) and
//         tenants with no connection / no payment pull yet
//
// NOT in SELF_MANAGED_DB_CONTEXT_ROUTES: there is no ambient auth transaction
// on an unauthenticated route. The route itself opens no DB context.
import { Hono } from 'hono';
import { getTrustedClientIp, rateLimitIpKey } from '../../services/clientIp';
import { rateLimiter } from '../../services/rate-limit';
import { getRedis } from '../../services/redis';
import { getAccountingProvider } from '../../services/accounting/providerRegistry';
import { routeWebhookToConnection } from '../../services/accounting/accountingWebhookRouting';
import { hmacFingerprint } from '../../services/secretCrypto';
import { xeroWebhookKey } from '../../config/env';
import { captureMessage } from '../../services/sentry';

export const xeroWebhookRoutes = new Hono();

const RATE_LIMIT = 240;
const RATE_WINDOW_SECONDS = 60;
/** Distinct tenants routed per delivery; the rest wait for the 15-minute sweep. */
export const MAX_TENANTS_PER_PAYLOAD = 50;
/** Events inspected per delivery (the tenant set is capped anyway). */
export const MAX_EVENTS_SCANNED = 1000;
/** A burst of events for one tenant coalesces into one reconcile (refinement 5). */
export const XERO_WEBHOOK_RECONCILE_DELAY_MS = 30_000;
const TENANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KEY_MISSING_CAPTURE_THROTTLE_MS = 10 * 60 * 1000;
let lastKeyMissingCaptureAtMs: number | null = null;

// Any anonymous POST reaches this before a signature is checked, so the Sentry
// capture is throttled (same rationale as the QuickBooks route).
function reportMissingKey(): void {
  const now = Date.now();
  if (lastKeyMissingCaptureAtMs !== null && now - lastKeyMissingCaptureAtMs < KEY_MISSING_CAPTURE_THROTTLE_MS) {
    console.warn('[xeroWebhook] XERO_WEBHOOK_KEY unset (Sentry capture throttled)');
    return;
  }
  lastKeyMissingCaptureAtMs = now;
  captureMessage('Xero webhook received but XERO_WEBHOOK_KEY is unset', {
    eventCode: 'accounting_webhook_signing_key_missing',
  });
}

/** The same bytes W02b fingerprinted when it stored the tenant (assumption B2). */
export function tenantFingerprint(tenantId: string): string {
  return hmacFingerprint(tenantId);
}

interface XeroWebhookEvent {
  eventCategory?: unknown;
  tenantId?: unknown;
  tenantType?: unknown;
}

// Signed, but not schema-validated: clamp categories to a known set so a
// crafted payload cannot inject strings into structured logs.
type LoggedCategory = 'INVOICE' | 'CONTACT' | 'other';

xeroWebhookRoutes.post('/xero', async (c) => {
  const ip = getTrustedClientIp(c, 'unknown');
  const rate = await rateLimiter(getRedis(), `xero-webhook:${rateLimitIpKey(ip)}`, RATE_LIMIT, RATE_WINDOW_SECONDS);
  if (!rate.allowed) return c.body(null, 429);

  // The HMAC is over the exact bytes Xero sent: read them before anything else.
  const raw = await c.req.text();

  const key = xeroWebhookKey();
  if (!key) {
    reportMissingKey();
    return c.body(null, 503);
  }

  const signature = c.req.header('x-xero-signature');
  if (!signature || !getAccountingProvider('xero').verifyWebhook(signature, raw, key)) {
    return c.body(null, 401);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return c.body(null, 400);
  }
  const events = (parsed as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return c.body(null, 400);

  const tenants = new Set<string>();
  const categories: Record<LoggedCategory, number> = { INVOICE: 0, CONTACT: 0, other: 0 };
  let ignored = 0;
  const scanned = events.slice(0, MAX_EVENTS_SCANNED) as XeroWebhookEvent[];
  for (const event of scanned) {
    const category: LoggedCategory = event?.eventCategory === 'INVOICE' || event?.eventCategory === 'CONTACT'
      ? event.eventCategory
      : 'other';
    categories[category] += 1;
    // Xero has no PAYMENT category; an invoice change is the only payment signal (refinement 3).
    if (
      category !== 'INVOICE'
      || event.tenantType !== 'ORGANISATION'
      || typeof event.tenantId !== 'string'
      || !TENANT_ID_RE.test(event.tenantId)
    ) {
      ignored += 1;
      continue;
    }
    tenants.add(event.tenantId);
  }

  const allTenants = [...tenants];
  const routed = allTenants.slice(0, MAX_TENANTS_PER_PAYLOAD);
  const tenantsCapped = allTenants.length - routed.length;

  let matched = 0;
  let dropped = tenantsCapped;
  let enqueued = 0;
  let failed = 0;
  try {
    for (const tenantId of routed) {
      const outcome = await routeWebhookToConnection('xero', tenantFingerprint(tenantId), {
        delayMs: XERO_WEBHOOK_RECONCILE_DELAY_MS,
      });
      if (outcome === 'no_connection' || outcome === 'capability_unavailable') { dropped += 1; continue; }
      matched += 1;
      if (outcome === 'enqueued') enqueued += 1; else failed += 1;
    }
  } catch (err) {
    console.error('[xeroWebhook] tenant lookup failed', err instanceof Error ? err.message : err);
    return c.body(null, 503);
  }

  // Counts and clamped categories only — never tenant or resource ids.
  console.info('[xeroWebhook] processed webhook delivery', {
    events: events.length, scanned: scanned.length, ignored, categories, tenantsCapped, matched, dropped, enqueued, failed,
  });

  if (failed > 0) return c.body(null, 503);
  return c.body(null, 200);
});
```

In `apps/api/src/index.ts`, import the route next to the QuickBooks route and mount it directly after it:

```ts
import { xeroWebhookRoutes } from './routes/webhooks/xero';
// …
// Xero webhook (W05) — no session auth, HMAC-gated with XERO_WEBHOOK_KEY.
// partnerGuard passes through (no Authorization header); the route reads the
// raw body itself via c.req.text(), so no body-consuming middleware may sit in
// front of it. NOT in SELF_MANAGED_DB_CONTEXT_ROUTES: there is no ambient auth
// transaction to opt out of on an unauthenticated route.
api.route('/webhooks', xeroWebhookRoutes);
```

In `middleware/partnerGuard.ts` `isPartnerGuardExemptPath`, before `return false;`:

```ts
  // Xero W05: signature-authenticated, unauthenticated webhook. partnerGuard must
  // not verify a bearer token, read `partners` or activate a partner on this
  // path BEFORE the route has checked the Xero HMAC (quorum finding 10). Exact
  // match only; no partner is ever acted for here.
  if (path === '/api/v1/webhooks/xero') return true;
```

File a follow-up issue for the same exposure on `/api/v1/webhooks/quickbooks` (left byte-identical here): `gh issue create --title "partnerGuard runs before the QuickBooks webhook signature check" --label security --body "Found by the Xero W05 plan quorum (finding 10). A request with any valid Breeze bearer token reaches partnerGuard's system-scoped partners read and activation path before quickbooks.ts verifies intuit-signature. Xero W05 exempts /api/v1/webhooks/xero in isPartnerGuardExemptPath; apply the same to QuickBooks."`. Link it in the W05a PR body.

Registries:
- `__tests__/routerAuthGate.contract.test.ts` `EXEMPT`: add `xeroWebhookRoutes: 'Xero webhook authenticates provider signatures.',` after `quickbooksWebhookRoutes`.
- `services/mcpCoverage.ts`: add `'webhooks/xero.ts': { exempt: 'inbound_integration' },` after `'webhooks/stripe.ts'`.
- `scripts/docs-review/mapping.json`: add a new entry after the QuickBooks one:

```json
    {
      "pattern": "apps/api/src/routes/webhooks/xero.ts",
      "docs": [
        "features/accounting-integrations.mdx",
        "deploy/environment.mdx",
        "reference/api.mdx"
      ]
    },
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/webhooks src/routes/webhooks.mountOrder.test.ts src/__tests__/routerAuthGate.contract.test.ts src/middleware/bodyLimit.test.ts src/middleware/partnerGuard src/services/sentryEventCodes.test.ts src/services/accounting/xeroProvider.test.ts && npx tsc --noEmit -p .`

Also run the `mcpCoverage` suite: `ls src/services/mcpCoverage*` for its name.

Expected: PASS, with `routes/webhooks/quickbooks.test.ts` untouched and green. Then confirm that no global middleware sets a cookie on this path:

```bash
grep -rn "setCookie\|Set-Cookie" apps/api/src/middleware apps/api/src/index.ts | grep -v test
```

Every hit must be route-scoped (auth or session routes), not an `app.use('*')`. If a global one exists, add `/api/v1/webhooks/xero` to its skip list with a test, and record it in the PR body (lab X48).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/webhooks/xero.ts apps/api/src/routes/webhooks/xero.test.ts apps/api/src/index.ts \
  apps/api/src/services/accounting/xeroProvider.ts apps/api/src/services/accounting/xeroProvider.test.ts \
  apps/api/src/__tests__/routerAuthGate.contract.test.ts apps/api/src/routes/webhooks.mountOrder.test.ts \
  apps/api/src/services/mcpCoverage.ts apps/api/src/middleware/bodyLimit.test.ts apps/api/src/services/sentryEventCodes.ts \
  apps/api/src/middleware/partnerGuard.ts apps/api/src/middleware/partnerGuard*.test.ts scripts/docs-review/mapping.json
git commit -m "feat(accounting): signed POST /webhooks/xero doorbell (Xero W05)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Wire the pull into the provider; W05a gate and PR

**Files:**
- Modify: `apps/api/src/services/accounting/xeroProvider.ts` (`limits.paymentRefMax`, `paymentMarker`, `reconcileChanges`)
- Test: `apps/api/src/services/accounting/xeroProvider.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces:
  - `xeroProvider.limits.paymentRefMax === 64`;
  - `xeroProvider.paymentMarker = { embed: embedXeroPaymentMarker, extract: extractXeroPaymentMarker }`;
  - `xeroProvider.reconcileChanges(conn, since)` → `readXeroPaymentChanges(callContext(conn), conn, since)`.

  Capabilities are unchanged (`paymentPull: false`).

- [ ] **Step 1: Write the failing tests**

In `xeroProvider.test.ts`, remove `reconcileChanges` from the "methods behind later waves" `it.each` table. Keep `createPayment`/`deletePayment` there until W05b. Add:

```ts
describe('payment pull wiring (Xero W05a)', () => {
  it('pins the reference cap and the marker grammar', () => {
    expect(xeroProvider.limits.paymentRefMax).toBe(64);
    const marker = 'Breeze payment 0f3c6f4e-5a1b-4c2d-9e8f-7a6b5c4d3e2f';
    expect(xeroProvider.paymentMarker.extract(xeroProvider.paymentMarker.embed('pi_1', marker)))
      .toBe('0f3c6f4e-5a1b-4c2d-9e8f-7a6b5c4d3e2f');
  });

  it("reconcileChanges reads with the connection's own tenant id and token", async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Payments: [] }))
      .mockResolvedValueOnce(json({ Invoices: [] }));
    await xeroProvider.reconcileChanges(conn({ realmId: 'tenant-A', accessToken: 'tok' }), null);
    const headers = new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers);
    expect(headers.get('xero-tenant-id')).toBe('tenant-A');
    expect(headers.get('authorization')).toBe('Bearer tok');
  });

  it('still declares paymentPull and paymentPush false until W05c', () => {
    expect(xeroProvider.capabilities.paymentPull).toBe(false);
    expect(xeroProvider.capabilities.paymentPush).toBe(false);
  });
});
```

(`conn()` and `json()` are the file's existing factories, W03 assumption A6.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroProvider.test.ts`
Expected: FAIL: `paymentRefMax` is 255, the marker throws, and `reconcileChanges` throws `capability_unavailable`.

- [ ] **Step 3: Implement**

In `xeroProvider.ts`:

```ts
import { embedXeroPaymentMarker, extractXeroPaymentMarker, readXeroPaymentChanges, XERO_PAYMENT_REF_MAX } from './xeroPayments';
// …
  // Refinement 14: the raw human reference the core may pass; the marker goes first.
  readonly limits = { paymentRefMax: XERO_PAYMENT_REF_MAX, rate: XERO_RATE_LIMIT };
  readonly paymentMarker = { embed: embedXeroPaymentMarker, extract: extractXeroPaymentMarker };
// …
  // Assumes conn.accessToken is valid (the reconcile worker resolves it first); issues no DB queries.
  async reconcileChanges(conn: AccountingConnection, since: Date | null): Promise<ChangeSet> {
    return readXeroPaymentChanges(callContext(conn), conn, since);
  }
```

Delete the old `reconcileChanges` stub and the "PROVISIONAL" comment. In the file header's list, change "W05 paymentPull/paymentPush" to "W05 payments (pull wired in W05a, push in W05b; capabilities flip in W05c)".

- [ ] **Step 4: Run to verify they pass, then the W05a gate**

```bash
cd apps/api && npx vitest run src/services/accounting/xeroProvider.test.ts src/services/accounting/types.markers.test.ts src/services/accounting/types.test.ts
git diff --stat origin/main -- 'src/services/accounting/quickbooks*' src/routes/webhooks/quickbooks.ts   # expect: empty
npx vitest run 2>&1 | tail -5 && npx tsc --noEmit -p .
wc -l src/routes/accounting/index.ts                                              # expect: ≤ Task 0 count
cd ../.. && pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/accounting src/__tests__/integration/tenantCascade 2>&1 | tail -5
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage 2>&1 | tail -3
cd ../.. && pnpm test-stack down
```

Expected: all green, and the stack is down.

- [ ] **Step 5: Commit, then open PR W05a**

```bash
git add apps/api/src/services/accounting/xeroProvider.ts apps/api/src/services/accounting/xeroProvider.test.ts
git commit -m "feat(accounting): wire Xero payment pull and marker into the provider (Xero W05)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Title: `feat(accounting): Xero W05a — /webhooks/xero and If-Modified-Since payment pull`. Body: `Part of #7172`. The body must state:
- Xero capabilities are unchanged (`paymentPull`/`paymentPush` false);
- the route is live but inert (it answers 200 and routes nothing), so the owner can register the Xero webhook and pass intent-to-receive before W05c;
- QuickBooks is byte-identical (the diff is empty, plus the webhook enqueue arity pin);
- the Task 0 QuickBooks-string inventory;
- any Task 0 interface differences.

Run `/pr-review-toolkit:review-pr`, fix confirmed findings in one round, and post the summary.

---

# PR W05b — Push and delete (Xero `paymentPush` stays false)

### Task 6: Neutral payment seams — labelled messages, preflight hook, refusal branch, worker sets

**Files:**
- Modify: `apps/api/src/services/accounting/accountingPaymentMessages.ts` (+ test)
- Modify: `apps/api/src/services/accounting/types.ts` (`paymentPushPreflight?`)
- Modify: `apps/api/src/services/accounting/accountingProviderError.ts` (`ACCOUNTING_REFUSAL_CODES` gains `amount_exceeds_due`)
- Modify: `apps/api/src/services/accounting/accountingPaymentPush.ts` (labels, Phase 1 preflight, `paymentPushRefusal`, `markPaymentRefusedIfStillOwed`, seven codes)
- Modify: `apps/api/src/services/accounting/accountingPaymentPull.ts` (four throw texts labelled)
- Modify: `apps/api/src/jobs/accountingSyncWorker.ts` (`PAYMENT_TERMINAL_CODES`, new `PAYMENT_USER_RESOLVABLE_CODES`)
- Test: `accountingPaymentMessages.test.ts`, `accountingPaymentPush.test.ts`, `jobs/accountingSyncWorker.test.ts`

**Interfaces:**
- Consumes: M12–M15, C4 (`refusalCodeOf`, `providerPermissionMessage`), D1, D4, D5.
- Produces:
  ```ts
  // types.ts — AccountingProvider
  /** Synchronous settings check before any token refresh or network call (Xero W05). A message = park the payment. Absent = none (QuickBooks). */
  paymentPushPreflight?(conn: AccountingConnection): string | null;
  // accountingProviderError.ts
  ACCOUNTING_REFUSAL_CODES = [...W03/W04's, 'amount_exceeds_due', 'remote_deleted']
  // accountingPaymentPush.ts
  type AccountingPaymentPushErrorCode = … | 'push_settings_incomplete' | 'remote_missing' | 'remote_locked'
    | 'remote_ambiguous' | 'provider_permission' | 'amount_exceeds_due' | 'remote_deleted';
  // accountingPaymentMessages.ts (all take the provider display label)
  paymentPushDisabledMessage(label), paymentInvoiceNotSyncedMessage(label), paymentRecordFailedOrphanMessage(label),
  paymentRecordFailedRetryMessage(remoteId, label), paymentNotConnectedMessage(label), paymentPushGaveUpMessage(previous, label),
  paymentCurrencyMismatchSuffix(home, label), paymentSyncInProgressMessage(label, op: 'sync' | 'delete'),
  paymentInvoiceVoidMessage(label), paymentCustomerNotMappedMessage(label), paymentRecordConflictRetryMessage(label),
  paymentDeleteRecordFailedMessage(remoteId, label),
  paymentRemoteMissingMessage(label), paymentAmountExceedsDueMessage(label), paymentRemoteAmbiguousMessage(label),
  paymentRemoteLockedMessage(label), paymentRemoteDeletedMessage(label)
  ```

- [ ] **Step 1: Write the failing tests**

Append to `accountingPaymentMessages.test.ts` (extend the import):

```ts
describe('payment push operator text — QuickBooks byte-identical (Xero W05 refinement 22)', () => {
  const Q = 'QuickBooks';
  it.each<[string, string, string]>([
    ['push disabled', paymentPushDisabledMessage(Q), 'Payment push is disabled for this QuickBooks connection'],
    ['invoice not synced', paymentInvoiceNotSyncedMessage(Q), 'The invoice is not synced to QuickBooks yet; push the invoice first'],
    ['record failed orphan', paymentRecordFailedOrphanMessage(Q),
      'QuickBooks accepted the payment but Breeze could not record it; the QuickBooks Payment may be orphaned — contact support'],
    ['record failed retry', paymentRecordFailedRetryMessage('181', Q),
      'QuickBooks accepted the payment (remote id 181) but Breeze could not record it yet; '
      + 'Breeze is retrying briefly and will stop rather than create a second payment'],
    ['not connected', paymentNotConnectedMessage(Q), 'QuickBooks is not connected'],
    ['gave up', paymentPushGaveUpMessage('boom', Q),
      'QuickBooks payment push gave up after 100 attempts: boom. Fix the cause and push the invoice again.'],
    ['currency suffix', paymentCurrencyMismatchSuffix('USD', Q), ' Record this payment in USD or reconcile it in QuickBooks by hand.'],
    ['currency suffix, no home', paymentCurrencyMismatchSuffix(null, Q),
      ' Record this payment in the connected home currency or reconcile it in QuickBooks by hand.'],
    ['sync in progress', paymentSyncInProgressMessage(Q, 'sync'),
      'Another QuickBooks payment sync for this payment is already in flight; it will be retried'],
    ['delete in progress', paymentSyncInProgressMessage(Q, 'delete'),
      'Another QuickBooks payment delete for this payment is already in flight; it will be retried'],
    ['invoice void', paymentInvoiceVoidMessage(Q), 'Invoice was voided in Breeze; QuickBooks payments are not pushed to a void invoice'],
    ['customer not mapped', paymentCustomerNotMappedMessage(Q),
      'This organization is not mapped to a QuickBooks customer yet — confirm or create a mapping first'],
    ['record conflict retry', paymentRecordConflictRetryMessage(Q),
      'A database conflict interrupted recording the QuickBooks payment; it will be retried'],
    ['delete record failed', paymentDeleteRecordFailedMessage('181', Q),
      'QuickBooks removed the payment (remote id 181) but Breeze could not clear its mapping; the reconcile sweep will retry'],
  ])('%s', (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('the new refusal texts name the provider and the fix', () => {
    expect(paymentRemoteMissingMessage('Xero')).toBe(
      'The Xero invoice this payment belongs to is no longer approved there (voided, deleted or back to draft), '
      + 'so the payment cannot be recorded against it — check the invoice in Xero');
    expect(paymentAmountExceedsDueMessage('Xero')).toBe(
      'Xero refused the payment because it is more than the amount still due on the invoice there — '
      + 'check for a payment or credit already recorded in Xero, then push the invoice to Xero again');
    expect(paymentRemoteAmbiguousMessage('Xero')).toBe(
      'Xero holds a payment for this Breeze payment that Breeze cannot match (a duplicate, or a different amount) — '
      + 'delete the wrong one in Xero, then push the invoice to Xero again');
    expect(paymentRemoteDeletedMessage('Xero')).toBe(
      'This payment was deleted in Xero after Breeze sent it — push the invoice to Xero again to send it again');
    expect(paymentRemoteLockedMessage('Xero')).toBe(
      'Xero will not delete this payment because it is reconciled to a bank transaction — unreconcile it in Xero and delete it there');
  });
});
```

**Before implementing,** diff each expected literal above against the current source lines listed in M13. The source wins: if a literal here differs, fix the test to the source text.

In `accountingPaymentPush.test.ts`:

1. Make the mocked provider extensible, as W04 Task 2 did for invoices. In the first `vi.hoisted` block, add `providerExtras: {} as Record<string, unknown>` to the returned object and to its destructured names. Change the `./providerRegistry` mock's `getAccountingProvider` to `() => ({ createPayment: createPaymentMock, deletePayment: deletePaymentMock, limits: { paymentRefMax: 21 }, ...providerExtras })`. In the top-level `beforeEach`, add `for (const k of Object.keys(providerExtras)) delete providerExtras[k];`.

2. Append:

```ts
describe('Xero W05: preflight park, provider refusals, labels', () => {
  const xeroRefusal = (providerCode: string, kind: 'validation' | 'not_found' = 'validation') =>
    new AccountingProviderError({ kind, provider: 'xero', operation: 'Xero payment create', httpStatus: kind === 'not_found' ? 404 : 400, providerCode });

  beforeEach(() => {
    currentConns = [connRow({ provider: 'xero' })];
    resolveConnectionMock.mockImplementation(async () => ({ ...currentConns[0], provider: 'xero' }));
  });

  it('a preflight refusal PARKS the payment: pending_op kept, lease released, no attempt counted, no token, no provider call', async () => {
    providerExtras.paymentPushPreflight = vi.fn(() => 'Choose a bank account for payments in Integrations → Accounting → Xero; Breeze will send this payment when one is chosen');

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).rejects.toMatchObject({ code: 'push_settings_incomplete', status: 409 });

    expect(resolveLiveConnectionMock).not.toHaveBeenCalled();
    expect(createPaymentMock).not.toHaveBeenCalled();
    expect(mapping()).toMatchObject({
      pendingOp: 'push', claimedAt: null, syncStatus: 'error', syncAttempts: 0,
      lastError: 'Choose a bank account for payments in Integrations → Accounting → Xero; Breeze will send this payment when one is chosen',
    });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('a provider without a preflight still pushes (QuickBooks regression guard)', async () => {
    currentConns = [connRow()];
    resolveConnectionMock.mockImplementation(async () => ({ ...currentConns[0], provider: 'quickbooks' }));
    createPaymentMock.mockResolvedValueOnce({ id: '181', remoteVersion: '0' });
    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('pushed');
  });

  it.each<[string, 'validation' | 'not_found', string, string]>([
    ['remote_missing', 'validation', 'remote_missing',
      'The Xero invoice this payment belongs to is no longer approved there (voided, deleted or back to draft), so the payment cannot be recorded against it — check the invoice in Xero'],
    ['amount_exceeds_due', 'validation', 'amount_exceeds_due',
      'Xero refused the payment because it is more than the amount still due on the invoice there — check for a payment or credit already recorded in Xero, then push the invoice to Xero again'],
    ['insufficient_scope', 'validation', 'provider_permission',
      'Xero did not grant Breeze access to this data — reconnect Xero and approve every requested permission'],
  ])('create refusal %s → terminal %s, pending_op cleared, persisted, no Sentry', async (providerCode, kind, code, message) => {
    createPaymentMock.mockRejectedValueOnce(xeroRefusal(providerCode, kind));
    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).rejects.toMatchObject({ code, status: 409, message });
    expect(mapping()).toMatchObject({ pendingOp: null, syncStatus: 'error', lastError: message });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('remote_deleted → terminal, pending_op cleared, no Sentry (our create was deleted in Xero; quorum finding 4)', async () => {
    createPaymentMock.mockRejectedValueOnce(xeroRefusal('remote_deleted'));
    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).rejects.toMatchObject({
      code: 'remote_deleted', status: 409,
      message: 'This payment was deleted in Xero after Breeze sent it — push the invoice to Xero again to send it again',
    });
    expect(mapping()).toMatchObject({ pendingOp: null, syncStatus: 'error' });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('a late create refusal does NOT erase a delete a concurrent void put on the row (quorum finding 2)', async () => {
    createPaymentMock.mockImplementationOnce(async () => {
      // While the provider call is in flight: the pull adopted the payment and a void owes its delete.
      Object.assign(mapping()!, { remoteEntityId: 'xp-1/xi-1', pendingOp: 'delete', claimedAt: null, syncStatus: 'pending' });
      throw xeroRefusal('amount_exceeds_due');
    });
    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).rejects.toMatchObject({ code: 'amount_exceeds_due' });
    expect(mapping()).toMatchObject({ pendingOp: 'delete', remoteEntityId: 'xp-1/xi-1', syncStatus: 'pending' });
  });

  it('duplicate_key → remote_ambiguous, terminal, and it DOES reach Sentry (should never happen)', async () => {
    createPaymentMock.mockRejectedValueOnce(xeroRefusal('duplicate_key'));
    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).rejects.toMatchObject({ code: 'remote_ambiguous', status: 409 });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it('delete refusal remote_locked → terminal, pending_op cleared, the remote id KEPT, no Sentry', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
      remoteEntityId: 'xp-1/xi-1', remoteSyncToken: '2026-09-20T10:00:00.000Z', pendingOp: 'delete', syncStatus: 'pending',
    })];
    deletePaymentMock.mockRejectedValueOnce(new AccountingProviderError({
      kind: 'validation', provider: 'xero', operation: 'Xero payment delete', httpStatus: 400, providerCode: 'remote_locked',
    }));
    await expect(deletePaymentInAccounting(MAPPING, PARTNER, runCtx)).rejects.toMatchObject({
      code: 'remote_locked', status: 409,
      message: 'Xero will not delete this payment because it is reconciled to a bank transaction — unreconcile it in Xero and delete it there',
    });
    expect(mapping()).toMatchObject({ pendingOp: null, remoteEntityId: 'xp-1/xi-1', syncStatus: 'error' });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('a QuickBooks validation fault is still the retryable 502 with Sentry — QuickBooks unchanged (refinement 16)', async () => {
    currentConns = [connRow()];
    resolveConnectionMock.mockImplementation(async () => ({ ...currentConns[0], provider: 'quickbooks' }));
    createPaymentMock.mockRejectedValueOnce(new AccountingProviderError({
      kind: 'validation', provider: 'quickbooks', operation: 'QuickBooks payment create', httpStatus: 400, providerCode: '6000',
    }));
    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).rejects.toMatchObject({ code: 'provider_error', status: 502 });
    expect(mapping()!.pendingOp).toBe('push');
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it('labels coordinator refusals with the connection provider', async () => {
    currentMappings = [invoiceMapRow(), paymentMapRow()]; // no org mapping
    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).rejects.toMatchObject({
      code: 'customer_not_mapped',
      message: 'This organization is not mapped to a Xero customer yet — confirm or create a mapping first',
    });
  });
});
```

(`AccountingProviderError` import: add `import { AccountingProviderError } from './accountingProviderError';` if the file lacks it. If `connRow`'s `provider` type is a literal union, widen the fixture type to `AccountingProviderId`.)

In `jobs/accountingSyncWorker.test.ts`, extend the payment-jobs describe:

```ts
  it.each<AccountingPaymentPushErrorCode>([
    'push_settings_incomplete', 'remote_missing', 'remote_locked', 'provider_permission', 'amount_exceeds_due', 'remote_deleted',
  ])('treats %s as TERMINAL and QUIET — no retry, no Sentry (Xero W05 refinement 16)', async (code) => {
    pushPaymentMock.mockRejectedValueOnce(new AccountingPaymentPushError(code, 409, 'resolve it'));
    await expect(processAccountingSyncJob({ type: 'push-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID }))
      .resolves.toBeUndefined();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('remote_ambiguous is terminal but still reported', async () => {
    pushPaymentMock.mockRejectedValueOnce(new AccountingPaymentPushError('remote_ambiguous', 409, 'two'));
    await expect(processAccountingSyncJob({ type: 'push-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID }))
      .resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingPaymentMessages.test.ts src/services/accounting/accountingPaymentPush.test.ts src/jobs/accountingSyncWorker.test.ts`
Expected: FAIL:
- the message functions are missing;
- no preflight is consulted;
- a Xero refusal comes back as a 502 `provider_error`;
- the new codes do not exist.

- [ ] **Step 3: Implement**

1. **`accountingPaymentMessages.ts`**: append one function per string. Each body is the M13 source literal with `QuickBooks` replaced by `${label}`, for example:

```ts
export function paymentPushDisabledMessage(label: string): string {
  return `Payment push is disabled for this ${label} connection`;
}
export function paymentPushGaveUpMessage(previous: string, label: string): string {
  return `${label} payment push gave up after ${PAYMENT_PUSH_MAX_ATTEMPTS} attempts: ${previous}. `
    + 'Fix the cause and push the invoice again.';
}
export function paymentCurrencyMismatchSuffix(home: string | null, label: string): string {
  return ` Record this payment in ${home ?? 'the connected home currency'} or reconcile it in ${label} by hand.`;
}
export function paymentSyncInProgressMessage(label: string, op: 'sync' | 'delete'): string {
  return `Another ${label} payment ${op} for this payment is already in flight; it will be retried`;
}
export function paymentRemoteMissingMessage(label: string): string {
  return `The ${label} invoice this payment belongs to is no longer approved there (voided, deleted or back to draft), `
    + `so the payment cannot be recorded against it — check the invoice in ${label}`;
}
export function paymentAmountExceedsDueMessage(label: string): string {
  return `${label} refused the payment because it is more than the amount still due on the invoice there — `
    + `check for a payment or credit already recorded in ${label}, then push the invoice to ${label} again`;
}
export function paymentRemoteAmbiguousMessage(label: string): string {
  return `${label} holds a payment for this Breeze payment that Breeze cannot match (a duplicate, or a different amount) — `
    + `delete the wrong one in ${label}, then push the invoice to ${label} again`;
}
export function paymentRemoteDeletedMessage(label: string): string {
  return `This payment was deleted in ${label} after Breeze sent it — push the invoice to ${label} again to send it again`;
}
export function paymentRemoteLockedMessage(label: string): string {
  return `${label} will not delete this payment because it is reconciled to a bank transaction — unreconcile it in ${label} and delete it there`;
}
```

   `PAYMENT_PUSH_MAX_ATTEMPTS` moves into this module. `accountingPaymentPush.ts` re-exports it, so its importers are unaffected. Write the other functions the same way, from their M13 literals.

2. **`accountingPaymentPush.ts`**:
   - Keep the exported constants (`PAYMENT_PUSH_DISABLED_MESSAGE`, `PAYMENT_INVOICE_NOT_SYNCED_MESSAGE`, `PAYMENT_RECORD_FAILED_ORPHAN_MESSAGE`, `PAYMENT_NOT_CONNECTED_MESSAGE`) as `/** @deprecated QuickBooks text; use the labelled function. */` aliases of `fn('QuickBooks')`. Existing tests import them.
   - `paymentPushGaveUpMessage(previous)` becomes `paymentPushGaveUpMessage(previous, label)`. Update its callers to pass `accountingProviderDisplayName(provider)`. The row's provider is already read where the give-up is stamped; if it is not in scope, add the provider to that helper's parameters, like W03 refinement 21.
   - Replace each M13 literal with its function, called with `accountingProviderDisplayName(conn.provider)` (the connection is in scope at every refusal after `resolveConnection`).
   - Where no connection exists (`not_connected` before any resolve), keep `PAYMENT_NOT_CONNECTED_MESSAGE`.
   - Label the log-only and Sentry-only QuickBooks lines listed in Task 0 inline with the same label.
   - Add the seven codes to `AccountingPaymentPushErrorCode`.
   - In `pushPaymentToAccounting` Phase 1, immediately after the currency-guard `try/catch`, and before the `return { kind: 'ready', … }`:

```ts
    // Xero W05 (refinement 17): a provider setting the push needs (Xero: the bank
    // account) is missing. PARK, don't fail: pending_op stays 'push', the lease
    // is released, no attempt is counted, and the sweep re-offers the row every
    // 15 minutes at no provider cost — the first sweep after the setting is
    // chosen pushes it. Checked before any token refresh or network call.
    const settingsRefusal = getAccountingProvider(conn.provider).paymentPushPreflight?.(conn) ?? null;
    if (settingsRefusal) {
      await markPaymentMappingError(mappingId, partnerId, settingsRefusal, { clearPendingOp: false, countAttempt: 'never' });
      return {
        kind: 'refused',
        error: new AccountingPaymentPushError('push_settings_incomplete', 409, settingsRefusal),
      } as const;
    }
```

   - Add, near `sanitizePaymentSyncErrorMessage`:

```ts
/**
 * A provider REFUSAL an operator must resolve (Xero W05 refinement 16) → a
 * terminal 409 with an explained message. Only codes a provider sets on
 * purpose (ACCOUNTING_REFUSAL_CODES via refusalCodeOf) qualify — QuickBooks
 * sets none on a payment, so its errors keep the retryable 502 path.
 */
function paymentPushRefusal(
  err: unknown,
  label: string,
  op: 'create' | 'delete',
): { code: AccountingPaymentPushErrorCode; message: string } | null {
  switch (refusalCodeOf(err)) {
    case 'insufficient_scope': return { code: 'provider_permission', message: providerPermissionMessage(label) };
    case 'remote_locked': return op === 'delete' ? { code: 'remote_locked', message: paymentRemoteLockedMessage(label) } : null;
    case 'remote_missing': return op === 'create' ? { code: 'remote_missing', message: paymentRemoteMissingMessage(label) } : null;
    case 'amount_exceeds_due': return op === 'create' ? { code: 'amount_exceeds_due', message: paymentAmountExceedsDueMessage(label) } : null;
    case 'duplicate_key': return op === 'create' ? { code: 'remote_ambiguous', message: paymentRemoteAmbiguousMessage(label) } : null;
    case 'remote_deleted': return op === 'create' ? { code: 'remote_deleted', message: paymentRemoteDeletedMessage(label) } : null;
    default: return null;
  }
}
```

   - In the **create** `catch`, after the throttle branch and before `sanitizePaymentSyncErrorMessage`:

```ts
    const refusal = paymentPushRefusal(err, accountingProviderDisplayName(prep.conn.provider), 'create');
    if (refusal) {
      logProviderFault('createPayment', mappingId, err);
      if (refusal.code === 'remote_ambiguous') {
        captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
          ...providerTelemetryTags(err),
          service: 'accountingPaymentPush',
          accounting_mapping_id: mappingId,
          invoice_payment_id: prep.payload.invoicePaymentId,
        });
      }
      // Terminal: the owed push is cleared. The next invoice push re-owns the row
      // (fanOutOwedPayments, new push_generation), which is what the message asks for.
      // CONDITIONAL (quorum finding 2): only while the row still owes THIS push.
      await markPaymentRefusedIfStillOwed(runInDbContext, mappingId, partnerId, refusal.message, {
        op: 'push', pushGeneration: prep.payload.pushGeneration,
      });
      throw new AccountingPaymentPushError(refusal.code, 409, refusal.message);
    }
```

   - The same block in the **delete** `catch`, with `'delete'`, `logProviderFault('deletePayment', …)` and `markPaymentRefusedIfStillOwed(…, { op: 'delete' })`. The stamp leaves `remote_entity_id` untouched. That is refinement 16: the bookkeeper deletes the payment in Xero, and the pull then sees `DELETED`.
   - The conditional stamp helper, next to `markPaymentMappingErrorInOwnContext`:

```ts
/**
 * The terminal stamp for a provider refusal (Xero W05), applied ONLY while the
 * row still owes the operation that was refused (quorum finding 2). The
 * provider call ran with no lock held; in that time a pull may have adopted the
 * payment, or a void may have turned the owed push into an owed delete. An
 * unconditional `pending_op = NULL` would then erase that newer obligation, and
 * a Xero payment Breeze has reversed would stay in the books. When the row has
 * moved on, nothing is written: the job still ends with the refusal, and the
 * newer state belongs to its own worker. Own short context, so the stamp
 * commits before the throw.
 */
async function markPaymentRefusedIfStillOwed(
  runInDbContext: DbContextRunner,
  mappingId: string,
  partnerId: string,
  message: string,
  expected: { op: 'push'; pushGeneration: number } | { op: 'delete' },
): Promise<boolean> {
  const rows = await runInDbContext(() => db
    .update(accountingEntityMappings)
    .set({ syncStatus: 'error', lastError: message, claimedAt: null, pendingOp: null, updatedAt: new Date() })
    .where(and(
      eq(accountingEntityMappings.id, mappingId),
      eq(accountingEntityMappings.partnerId, partnerId),
      eq(accountingEntityMappings.pendingOp, expected.op),
      ...(expected.op === 'push'
        ? [isNull(accountingEntityMappings.remoteEntityId), eq(accountingEntityMappings.pushGeneration, expected.pushGeneration)]
        : []),
    ))
    .returning({ id: accountingEntityMappings.id }));
  const landed = (rows as unknown[]).length > 0;
  if (!landed) {
    console.warn('[accountingPaymentPush] refusal not stamped — the mapping moved on during the provider call', `mappingId=${mappingId}`, `op=${expected.op}`);
  }
  return landed;
}
```

   (Add `isNull` to the file's `drizzle-orm` import if it is not there.)

3. **`types.ts`**: add `paymentPushPreflight?` to `AccountingProvider` (doc comment as in Interfaces). Extend obligation 2's list with "`paymentPushPreflight` must be pure and synchronous (no network, no DB)".

4. **`accountingProviderError.ts`**: append `'amount_exceeds_due'` and `'remote_deleted'` to `ACCOUNTING_REFUSAL_CODES`. Then check the two refusal switches: `grep -n "function providerRefusal\|function invoicePushRefusal" -A20 services/accounting/accountingMappingService.ts services/accounting/accountingInvoicePush.ts`. If either is exhaustive (`assertNever` / `: never`), add `case 'amount_exceeds_due': case 'remote_deleted': return null;` with a comment saying only a payment create sets them.

5. **`accountingPaymentPull.ts`**: rebuild the four throw texts (`:417`, `:513`, `:578`, `:649`) from `accountingProviderDisplayName(conn.provider)`. They are thrown and logged only, never persisted, so no pin is needed.

6. **`jobs/accountingSyncWorker.ts`**:

```ts
const PAYMENT_TERMINAL_CODES: ReadonlySet<AccountingPaymentPushErrorCode> = new Set([
  'push_disabled', 'customer_not_mapped', 'home_currency_unknown', 'currency_mismatch', 'invoice_void',
  'record_failed', 'not_connected', 'reauth_required',
  // Xero W05 (refinements 16–17): provider refusals and a parked setting.
  'push_settings_incomplete', 'remote_missing', 'remote_locked', 'remote_ambiguous', 'provider_permission', 'amount_exceeds_due',
  'remote_deleted',
]);

/**
 * Terminal payment codes the OPERATOR resolves (a setting, a Xero-side record):
 * logged, never sent to Sentry. `remote_ambiguous` is deliberately absent — it
 * should never happen and is reported. The pre-W05 terminal codes keep their
 * capture, so QuickBooks telemetry is unchanged.
 */
const PAYMENT_USER_RESOLVABLE_CODES: ReadonlySet<AccountingPaymentPushErrorCode> = new Set([
  'push_settings_incomplete', 'remote_missing', 'remote_locked', 'provider_permission', 'amount_exceeds_due', 'remote_deleted',
]);
```

   In the payment-job terminal branch, wrap the `captureException(…)` in `if (!PAYMENT_USER_RESOLVABLE_CODES.has(err.code)) { … }`. For resolvable codes, log with `console.warn` instead of `console.error`, using the same arguments.

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/services/accounting src/jobs && npx tsc --noEmit -p .`
Expected: PASS. Every QuickBooks assertion in `accountingPaymentPush.test.ts` and `accountingPaymentPull.test.ts` is unedited and green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/accounting/accountingPaymentMessages.ts apps/api/src/services/accounting/accountingPaymentMessages.test.ts \
  apps/api/src/services/accounting/types.ts apps/api/src/services/accounting/accountingProviderError.ts \
  apps/api/src/services/accounting/accountingPaymentPush.ts apps/api/src/services/accounting/accountingPaymentPush.test.ts \
  apps/api/src/services/accounting/accountingPaymentPull.ts apps/api/src/jobs/accountingSyncWorker.ts apps/api/src/jobs/accountingSyncWorker.test.ts \
  apps/api/src/services/accounting/accountingMappingService.ts apps/api/src/services/accounting/accountingInvoicePush.ts
git commit -m "feat(accounting): payment preflight park, provider refusals, labelled payment text (Xero W05)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Only stage `accountingMappingService.ts`/`accountingInvoicePush.ts` if Step 3.4 changed them.)

---

### Task 7: The W01d renames — `PROVIDER_OWNED_PAYMENT`, `providerRecordUntouched`

**Files:**
- Modify: `apps/api/src/services/invoiceTypes.ts`, `apps/api/src/services/invoiceService.ts`, `apps/api/src/routes/invoices/payments.ts`
- Modify: `apps/web/src/components/billing/InvoiceDetail.tsx`
- Test: `apps/api/src/services/invoiceService.test.ts`, `apps/api/src/routes/invoices/payments.test.ts`, `apps/web/src/components/billing/InvoiceDetail.test.tsx`, `apps/api/src/__tests__/integration/accountingPaymentPull.integration.test.ts`, `apps/api/src/__tests__/integration/accountingPaymentPush.integration.test.ts`

**Interfaces:**
- Consumes: M17.
- Produces:
  - `InvoiceServiceErrorCode` has `'PROVIDER_OWNED_PAYMENT'`, not `'QUICKBOOKS_OWNED_PAYMENT'`;
  - `voidPayment` returns `audit.providerRecordUntouched`;
  - `DELETE /invoices/:id/payments/:pid` → `{ data, providerRecordUntouched: boolean, quickbooksRecordUntouched: boolean /* deprecated alias */ }`.

  The persisted audit action `invoice.payment.voided_quickbooks_untouched` and the route-audit `details.quickbooksRecordUntouched` key are **unchanged** (refinement 21).

- [ ] **Step 1: Write the failing tests**

- `invoiceService.test.ts`: change every `code: 'QUICKBOOKS_OWNED_PAYMENT'` expectation to `code: 'PROVIDER_OWNED_PAYMENT'`, and every `audit` expectation of `quickbooksRecordUntouched` to `providerRecordUntouched`. Keep the durable audit assertion unchanged, and add one:

```ts
  it('keeps the persisted audit action and names the provider (Xero W05 refinement 21)', async () => {
    // Reuse the setup of the existing "writes its own durable audit" test for a remote-origin void with pull off.
    expect(writeAuditEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'invoice.payment.voided_quickbooks_untouched',
      details: expect.objectContaining({ provider: 'quickbooks' }),
    }));
  });
```

  Model this on the existing durable-audit test near `:2541-2559`: copy its arrange block and replace only the assertions.
- `routes/invoices/payments.test.ts`: the untouched case expects `{ data: { id: INV_ID }, providerRecordUntouched: true, quickbooksRecordUntouched: true }`; the ordinary case expects both `false`. The route-audit assertion keeps `quickbooksRecordUntouched: true` in `details`.
- The two integration suites: `code: 'QUICKBOOKS_OWNED_PAYMENT'` → `'PROVIDER_OWNED_PAYMENT'`.
- `InvoiceDetail.test.tsx`: in the `it.each([true, false])` reversal test, make the DELETE mock return `{ data: issued.invoice, providerRecordUntouched: flag }` (no old key). Add one case returning **only** `quickbooksRecordUntouched: true` that still shows the warning toast (a stale-server compatibility case). The 409 case's `code` becomes `'PROVIDER_OWNED_PAYMENT'`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/invoiceService.test.ts src/routes/invoices/payments.test.ts` and `cd apps/web && npx vitest run src/components/billing/InvoiceDetail.test.tsx`
Expected: FAIL on the new code and key names.

- [ ] **Step 3: Implement**

- `invoiceTypes.ts`: rename the union member to `'PROVIDER_OWNED_PAYMENT'`. Rewrite its comment from "QuickBooks Phase D2" to "the payment came from the connected accounting provider, which is its system of record".
- `invoiceService.ts`:
  - rename `quickbooksRecordUntouched` to `providerRecordUntouched`, and the pre-check field `quickbooksWillReimport` to `providerWillReimport` (`grep -rn quickbooksWillReimport apps/api/src` for every producer and reader);
  - the thrown code becomes `'PROVIDER_OWNED_PAYMENT'`, and the comment "The code keeps its QuickBooks name: apps/web reads it" becomes "apps/web reads the message, not the code (Xero W05 refinement 21)";
  - the `audit` object carries `providerRecordUntouched`;
  - the durable `writeAuditEvent` keeps `action: 'invoice.payment.voided_quickbooks_untouched'`, with a comment "persisted action string — kept byte-identical; `details.provider` names the provider".
- `routes/invoices/payments.ts`:

```ts
        // Persisted audit key — kept byte-identical (refinement 21); details carry no provider-neutral twin.
        ...(audit.providerRecordUntouched
          ? { quickbooksRecordUntouched: true, untouchedReason: audit.untouchedReason }
          : {}),
      }
    });
    const untouched = audit.providerRecordUntouched === true;
    // `quickbooksRecordUntouched` is a deprecated alias for one release, so a
    // browser tab loaded before this deploy still shows its warning. Remove it
    // in the follow-up issue filed by Xero W05 Task 7.
    return c.json({ data: invoice, providerRecordUntouched: untouched, quickbooksRecordUntouched: untouched });
```

- `InvoiceDetail.tsx`:

```ts
      const result = await runAction<{ providerRecordUntouched?: boolean; quickbooksRecordUntouched?: boolean }>({ … });
      // …
      const untouched = result.providerRecordUntouched ?? result.quickbooksRecordUntouched ?? false;
      showToast(untouched
        ? { type: 'warning', message: t('invoiceDetail.payments.reverseInProviderToo', { provider: reversalProviderName }) }
        : { type: 'success', message: t('invoiceDetail.payments.reverseSuccess') });
```

- File the alias-removal follow-up: `gh issue create --title "Remove deprecated quickbooksRecordUntouched response alias (Xero W05)" --label chore --body "Added in Xero W05 Task 7 (routes/invoices/payments.ts). Remove one release after it ships, with the InvoiceDetail.tsx fallback."`. Link it in the PR body.

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/services/invoiceService.test.ts src/routes/invoices && npx tsc --noEmit -p .` and `cd apps/web && npx vitest run src/components/billing && npx tsc --noEmit -p .`
Expected: PASS. Then `grep -rn "QUICKBOOKS_OWNED_PAYMENT\|quickbooksWillReimport" apps/ packages/ --include='*.ts' --include='*.tsx' | grep -v node_modules` must print nothing, and `quickbooksRecordUntouched` must remain only in the route's alias, its persisted audit key, the web fallback and their tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/invoiceTypes.ts apps/api/src/services/invoiceService.ts apps/api/src/services/invoiceService.test.ts \
  apps/api/src/routes/invoices/payments.ts apps/api/src/routes/invoices/payments.test.ts \
  apps/api/src/__tests__/integration/accountingPaymentPull.integration.test.ts apps/api/src/__tests__/integration/accountingPaymentPush.integration.test.ts \
  apps/web/src/components/billing/InvoiceDetail.tsx apps/web/src/components/billing/InvoiceDetail.test.tsx
git commit -m "refactor(billing): provider-neutral owned-payment code and untouched flag (Xero W05, W01d deferral)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `xeroHttp.ts` — payment refusal classification

**Files:**
- Modify: `apps/api/src/services/accounting/xeroHttp.ts` (`classifyXeroValidation`)
- Test: `apps/api/src/services/accounting/xeroHttp.test.ts`

**Interfaces:**
- Consumes: C3, D2, Task 6 (`amount_exceeds_due` in `ACCOUNTING_REFUSAL_CODES`).
- Produces: `classifyXeroValidation(text)` also returns `'amount_exceeds_due'`, `'remote_missing'` or `'remote_locked'` for the payment messages below; every earlier verdict is unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `xeroHttp.test.ts` (reuse the `body(...messages)` helper W04 added there, or copy it):

```ts
describe('payment refusals (Xero W05 refinement 16)', () => {
  const body = (...messages: string[]) => JSON.stringify({
    ErrorNumber: 10, Type: 'ValidationException', Message: 'A validation exception occurred',
    Elements: [{ ValidationErrors: messages.map((Message) => ({ Message })) }],
  });
  it.each([
    ['Payment amount exceeds the amount outstanding on this document', 'amount_exceeds_due'],
    ['Payments can only be made against Authorised documents', 'remote_missing'],
    ['Payments can only be made against Authorized documents', 'remote_missing'],
    ['This payment has been reconciled and cannot be deleted', 'remote_locked'],
    ['The contact name Acme is already assigned to another contact.', 'duplicate_name'], // W03 unchanged
    ['Account code 999 is not a valid code for this document.', undefined],
  ] as const)('%s → %s', (message, expected) => {
    expect(classifyXeroValidation(body(message))).toBe(expected);
  });

  it('a create refused for exceeding the amount due reaches the core as validation + amount_exceeds_due', async () => {
    const ctx = { connectionId: 'c1', tenantId: 'ten-A', accessToken: 'at', rate: SPEC };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(
      { Elements: [{ ValidationErrors: [{ Message: 'Payment amount exceeds the amount outstanding on this document' }] }] }, 400));
    await expect(xeroApiWrite(ctx, 'PUT', 'Payments', {}, 'Xero payment create', { idempotencyKey: 'k' }))
      .rejects.toMatchObject({ kind: 'validation', providerCode: 'amount_exceeds_due' });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroHttp.test.ts`
Expected: FAIL — the three payment messages return `undefined`.

- [ ] **Step 3: Implement**

In `classifyXeroValidation`'s loop, after W03's patterns:

```ts
    // Xero W05 (refinement 16). The first two texts are reported by Xero integrators
    // (the docs state the rules, not the words); the reconciled-delete text is
    // undocumented. Lab X55/X56 record the real messages; adjust here if they differ.
    if (/^Payment amount exceeds the amount outstanding/i.test(message)) return 'amount_exceeds_due';
    if (/can only be made against Authori[sz]ed documents/i.test(message)) return 'remote_missing';
    if (/\b(has been|is) reconciled\b|\breconciled (payment|transaction)/i.test(message)) return 'remote_locked';
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroHttp.test.ts src/services/accounting/xeroContacts.test.ts src/services/accounting/xeroItems.test.ts src/services/accounting/xeroInvoices.test.ts && npx tsc --noEmit -p .`
Expected: PASS; W03/W04 classifications unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/accounting/xeroHttp.ts apps/api/src/services/accounting/xeroHttp.test.ts
git commit -m "feat(accounting): classify Xero payment refusals (Xero W05)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `xeroPayments.ts` — create with adoption, delete, preflight; provider wiring

**Files:**
- Modify: `apps/api/src/services/accounting/xeroPayments.ts` (+ test)
- Modify: `apps/api/src/services/accounting/xeroProvider.ts` (+ test)

**Interfaces:**
- Consumes: Task 3 (`XeroPayment`, `extractXeroPaymentMarker`, `xeroPaymentVersion`), C1 (`xeroApiWrite`), C2, Task 8.
- Produces:
  ```ts
  export const XERO_PAYMENT_ACCOUNT_MISSING_MESSAGE: string;
  export function xeroPaymentPreflight(conn: Pick<AccountingConnection, 'defaultPaymentAccountRef'>): string | null;
  export function xeroPaymentIdempotencyKey(tenantId: string, invoicePaymentId: string, pushGeneration: number): string; // 'breeze-pay-' + 64 hex
  export interface XeroMarkerHits { live: XeroPayment[]; deleted: XeroPayment[] }
  export async function lookUpXeroPaymentsByMarker(ctx: XeroCallContext, remoteInvoiceId: string, invoicePaymentId: string): Promise<XeroMarkerHits>;
  export async function createXeroPayment(ctx: XeroCallContext, conn: Pick<AccountingConnection, 'defaultPaymentAccountRef'>,
    payment: AccountingPaymentPayload, reference: string): Promise<RemoteRef>;
  export async function deleteXeroPayment(ctx: XeroCallContext, remotePaymentId: string): Promise<PaymentDeleteResult>;
  // xeroProvider: paymentPushPreflight(conn), createPayment(conn, payment), deletePayment(conn, payment) wired; capabilities unchanged
  ```

- [ ] **Step 1: Write the failing tests**

Append to `xeroPayments.test.ts` (extend the import with the new names, `AccountingProviderError` from `./accountingProviderError`, and `type AccountingPaymentPayload` from `./types`):

```ts
describe('payment create (refinements 15, 17, 19)', () => {
  const XI = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const payload = (over: Partial<AccountingPaymentPayload> = {}): AccountingPaymentPayload => ({
    invoicePaymentId: PAY_ID, remoteCustomerId: 'xc-1', remoteInvoiceId: XI, amount: '107.00', currencyCode: 'GBP',
    txnDate: '2026-09-02', reference: 'pi_1', marker: MARKER, pushGeneration: 0, ...over,
  });
  const reference = `${MARKER} | pi_1`;
  const account = { defaultPaymentAccountRef: 'bank-acc-1' };
  const ours = (over: Record<string, unknown> = {}) => payment({ PaymentID: 'xp-ours', Amount: 107, Reference: reference, Invoice: { InvoiceID: XI, Type: 'ACCREC' }, ...over });
  let fetchMock: ReturnType<typeof vi.spyOn>;
  const callsOf = () => fetchMock.mock.calls.map(([u, init]) => `${(init as RequestInit)?.method ?? 'GET'} ${String(u).replace('https://api.xero.com/api.xro/2.0/', '')}`);

  beforeEach(() => { fetchMock = vi.spyOn(globalThis, 'fetch'); });

  it('the key names the request identity: stable per (tenant, payment, generation), ≤128 chars', () => {
    const k = xeroPaymentIdempotencyKey(TENANT, PAY_ID, 0);
    expect(k).toMatch(/^breeze-pay-[0-9a-f]{64}$/);
    expect(k.length).toBeLessThanOrEqual(128);
    expect(xeroPaymentIdempotencyKey(TENANT, PAY_ID, 0)).toBe(k);
    expect(xeroPaymentIdempotencyKey(TENANT, PAY_ID, 1)).not.toBe(k);
    expect(xeroPaymentIdempotencyKey('other-tenant', PAY_ID, 0)).not.toBe(k);
  });

  it('preflight: no bank account → the operator message; an account → null', () => {
    expect(xeroPaymentPreflight({ defaultPaymentAccountRef: null })).toBe(XERO_PAYMENT_ACCOUNT_MISSING_MESSAGE);
    expect(xeroPaymentPreflight({ defaultPaymentAccountRef: '  ' })).toBe(XERO_PAYMENT_ACCOUNT_MISSING_MESSAGE);
    expect(xeroPaymentPreflight(account)).toBeNull();
  });

  it('looks up by invoice first, then PUTs one payment with the explicit key and the exact body', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [] }))
      .mockResolvedValueOnce(json({ Payments: [ours({ UpdatedDateUTC: msDate('2026-09-27T09:00:00Z') })] }));

    await expect(createXeroPayment(ctx, account, payload(), reference))
      .resolves.toEqual({ id: 'xp-ours', remoteVersion: '2026-09-27T09:00:00.000Z' });

    expect(callsOf()).toEqual([
      `GET Payments?where=Invoice.InvoiceID%3D%3Dguid%28%22${XI}%22%29&page=1&pageSize=1000`,
      'PUT Payments?summarizeErrors=true',
    ]);
    const put = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(new Headers(put.headers).get('idempotency-key')).toBe(xeroPaymentIdempotencyKey(TENANT, PAY_ID, 0));
    expect(JSON.parse(String(put.body))).toEqual({ Payments: [{
      Invoice: { InvoiceID: XI }, Account: { AccountID: 'bank-acc-1' }, Date: '2026-09-02', Amount: 107, Reference: reference,
    }] });
  });

  it('adopts instead of creating when our marker is already on the invoice (lost earlier response)', async () => {
    fetchMock.mockResolvedValueOnce(json({ Payments: [ours()] }));
    await expect(createXeroPayment(ctx, account, payload(), reference)).resolves.toMatchObject({ id: 'xp-ours' });
    expect(callsOf()).toEqual([expect.stringMatching(/^GET Payments\?where=/)]);
  });

  it('ignores foreign and other-invoice payments in the lookup (a re-owned push also ignores its DELETED predecessor)', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [
        ours({ PaymentID: 'gone', Status: 'DELETED' }),
        payment({ PaymentID: 'hand', Reference: 'CHQ 1', Invoice: { InvoiceID: XI } }),
        ours({ PaymentID: 'elsewhere', Invoice: { InvoiceID: 'ffffffff-ffff-ffff-ffff-ffffffffffff' } }),
      ] }))
      .mockResolvedValueOnce(json({ Payments: [ours({ PaymentID: 'new' })] }));
    await expect(createXeroPayment(ctx, account, payload({ pushGeneration: 2 }), reference)).resolves.toMatchObject({ id: 'new' });
  });

  it('two live hits refuse with duplicate_key (never guess)', async () => {
    fetchMock.mockResolvedValueOnce(json({ Payments: [ours({ PaymentID: 'a' }), ours({ PaymentID: 'b' })] }));
    await expect(createXeroPayment(ctx, account, payload(), reference))
      .rejects.toMatchObject({ kind: 'validation', providerCode: 'duplicate_key' });
  });

  it('a live hit with a different amount is never adopted (quorum finding 6)', async () => {
    fetchMock.mockResolvedValueOnce(json({ Payments: [ours({ Amount: 99.99 })] }));
    await expect(createXeroPayment(ctx, account, payload(), reference))
      .rejects.toMatchObject({ kind: 'validation', providerCode: 'duplicate_key' });
    expect(callsOf()).toHaveLength(1); // no PUT
  });

  it('only a DELETED hit on a first push: refuse remote_deleted, never resurrect (quorum finding 4)', async () => {
    fetchMock.mockResolvedValueOnce(json({ Payments: [ours({ Status: 'DELETED' })] }));
    await expect(createXeroPayment(ctx, account, payload(), reference))
      .rejects.toMatchObject({ kind: 'validation', providerCode: 'remote_deleted' });
    expect(callsOf()).toHaveLength(1);
  });

  it('only a DELETED hit on a RE-OWNED push (generation > 0): creates anew', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [ours({ Status: 'DELETED' })] }))
      .mockResolvedValueOnce(json({ Payments: [ours({ PaymentID: 'xp-new' })] }));
    await expect(createXeroPayment(ctx, account, payload({ pushGeneration: 1 }), reference)).resolves.toMatchObject({ id: 'xp-new' });
  });

  it('a lookup that cannot be enumerated in one page fails closed (quorum finding 5)', async () => {
    fetchMock.mockResolvedValueOnce(json({ Payments: Array.from({ length: XERO_RECONCILE_PAGE_SIZE }, (_, i) => payment({ PaymentID: `p${i}`, Invoice: { InvoiceID: XI } })) }));
    await expect(createXeroPayment(ctx, account, payload(), reference))
      .rejects.toMatchObject({ kind: 'validation', providerCode: 'duplicate_key' });
    expect(callsOf()).toHaveLength(1);
  });

  it('a timed-out or 5xx create looks again and adopts what landed', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [] }))
      .mockResolvedValueOnce(json({ Message: 'Service unavailable' }, 503))
      .mockResolvedValueOnce(json({ Payments: [ours()] }));
    await expect(createXeroPayment(ctx, account, payload(), reference)).resolves.toMatchObject({ id: 'xp-ours' });
  });

  it('a key-reuse 400 (transient) looks again and adopts', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [] }))
      .mockResolvedValueOnce(json({ Elements: [{ ValidationErrors: [{ Message: 'Idempotency Key: breeze-pay-x is used with a different request.' }] }] }, 400))
      .mockResolvedValueOnce(json({ Payments: [ours()] }));
    await expect(createXeroPayment(ctx, account, payload(), reference)).resolves.toMatchObject({ id: 'xp-ours' });
  });

  it('a transient outcome with nothing found rethrows the original (retryable) error', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [] }))
      .mockResolvedValueOnce(json({ Message: 'Service unavailable' }, 503))
      .mockResolvedValueOnce(json({ Payments: [] }));
    await expect(createXeroPayment(ctx, account, payload(), reference)).rejects.toMatchObject({ kind: 'transient', httpStatus: 503 });
  });

  it('a 2xx element carrying ValidationErrors is a classified validation failure (refinement 19)', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [] }))
      .mockResolvedValueOnce(json({ Payments: [{ HasValidationErrors: true, ValidationErrors: [{ Message: 'Payment amount exceeds the amount outstanding on this document' }] }] }));
    await expect(createXeroPayment(ctx, account, payload(), reference))
      .rejects.toMatchObject({ kind: 'validation', providerCode: 'amount_exceeds_due' });
  });

  it('a non-GUID invoice id is refused before any call (it is interpolated into a where clause)', async () => {
    await expect(createXeroPayment(ctx, account, payload({ remoteInvoiceId: 'x")||true||("' }), reference))
      .rejects.toMatchObject({ kind: 'validation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses without a bank account, before any call (defence behind the core preflight)', async () => {
    await expect(createXeroPayment(ctx, { defaultPaymentAccountRef: null }, payload(), reference)).rejects.toMatchObject({ kind: 'validation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('payment delete (refinement 18)', () => {
  const XP = '12345678-1234-1234-1234-123456789012';
  let fetchMock: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchMock = vi.spyOn(globalThis, 'fetch'); });

  it('reads, then POSTs Status DELETED without an idempotency key', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [payment({ PaymentID: XP })] }))
      .mockResolvedValueOnce(json({ Payments: [payment({ PaymentID: XP, Status: 'DELETED' })] }));
    await expect(deleteXeroPayment(ctx, XP)).resolves.toBe('deleted');
    const post = fetchMock.mock.calls[1]!;
    expect(String(post[0])).toBe(`https://api.xero.com/api.xro/2.0/Payments/${XP}`);
    expect((post[1] as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ Status: 'DELETED' });
    expect(new Headers((post[1] as RequestInit).headers).get('idempotency-key')).toBeNull();
  });

  it.each([
    ['a 404 on the read', () => fetchMock.mockResolvedValueOnce(json({ Message: 'not found' }, 404))],
    ['an already DELETED payment', () => fetchMock.mockResolvedValueOnce(json({ Payments: [payment({ PaymentID: XP, Status: 'DELETED' })] }))],
  ])('%s is already_absent with no write', async (_l, arrange) => {
    arrange();
    await expect(deleteXeroPayment(ctx, XP)).resolves.toBe('already_absent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a reconciled payment is refused as remote_locked without writing', async () => {
    fetchMock.mockResolvedValueOnce(json({ Payments: [payment({ PaymentID: XP, IsReconciled: true })] }));
    await expect(deleteXeroPayment(ctx, XP)).rejects.toMatchObject({ kind: 'validation', providerCode: 'remote_locked' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 404 on the POST (deleted in between) is already_absent', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [payment({ PaymentID: XP })] }))
      .mockResolvedValueOnce(json({ Message: 'not found' }, 404));
    await expect(deleteXeroPayment(ctx, XP)).resolves.toBe('already_absent');
  });

  it('a non-GUID payment id is refused before any call', async () => {
    await expect(deleteXeroPayment(ctx, '181')).rejects.toMatchObject({ kind: 'validation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

In `xeroProvider.test.ts`, remove `createPayment`/`deletePayment` from the "methods behind later waves" table (it is now empty; delete the describe if nothing remains) and add:

```ts
describe('payment push wiring (Xero W05b)', () => {
  it('declares a preflight that reads the bank account', () => {
    expect(xeroProvider.paymentPushPreflight!(conn({ defaultPaymentAccountRef: null }))).toMatch(/Choose a bank account/);
    expect(xeroProvider.paymentPushPreflight!(conn({ defaultPaymentAccountRef: 'bank-1' }))).toBeNull();
  });
  it('createPayment embeds the marker first in Reference', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Payments: [] }))
      .mockResolvedValueOnce(json({ Payments: [{ PaymentID: 'xp-1' }] }));
    await xeroProvider.createPayment(conn({ defaultPaymentAccountRef: 'bank-1' }), {
      invoicePaymentId: '0f3c6f4e-5a1b-4c2d-9e8f-7a6b5c4d3e2f', remoteCustomerId: 'c', remoteInvoiceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      amount: '10.00', currencyCode: 'GBP', txnDate: '2026-09-02', reference: 'pi_1',
      marker: 'Breeze payment 0f3c6f4e-5a1b-4c2d-9e8f-7a6b5c4d3e2f', pushGeneration: 0,
    });
    const sent = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body));
    expect(sent.Payments[0].Reference).toBe('Breeze payment 0f3c6f4e-5a1b-4c2d-9e8f-7a6b5c4d3e2f | pi_1');
  });
  it('still declares paymentPush false until W05c', () => {
    expect(xeroProvider.capabilities.paymentPush).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroPayments.test.ts src/services/accounting/xeroProvider.test.ts`
Expected: FAIL: the new exports are missing, and the provider still throws `capability_unavailable` on create and delete.

- [ ] **Step 3: Implement**

Append to `xeroPayments.ts` (extend its imports: `createHash` from `node:crypto`; `AccountingProviderError` from `./accountingProviderError`; `classifyXeroValidation`, `requireXeroBody`, `xeroApiWrite` from `./xeroHttp`; `type AccountingPaymentPayload, type PaymentDeleteResult, type RemoteRef` from `./types`):

```ts
// ---------------------------------------------------------------------------
// Push (W05b)
// ---------------------------------------------------------------------------

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Refinement 17: parked, not failed; shown on the payment row and fixed in the settings step. */
export const XERO_PAYMENT_ACCOUNT_MISSING_MESSAGE =
  'Choose a bank account for payments in Integrations → Accounting → Xero; Breeze will send this payment when one is chosen';

export function xeroPaymentPreflight(conn: Pick<AccountingConnection, 'defaultPaymentAccountRef'>): string | null {
  return conn.defaultPaymentAccountRef?.trim() ? null : XERO_PAYMENT_ACCOUNT_MISSING_MESSAGE;
}

/**
 * One key per request IDENTITY, never per request bytes (refinement 15, W04's
 * lesson): the body carries a mutable setting (the bank account). Same inputs as
 * QuickBooks' requestid (`invoicePaymentId[:g<n>]`), so a fan-out re-own gets a
 * new key. 75 chars (Xero's cap is 128). Xero keeps a key only 6 minutes —
 * adoption, not the key, is the duplicate guard.
 */
export function xeroPaymentIdempotencyKey(tenantId: string, invoicePaymentId: string, pushGeneration: number): string {
  return `breeze-pay-${createHash('sha256').update([tenantId, invoicePaymentId, String(pushGeneration)].join('\n')).digest('hex')}`;
}

function paymentError(
  kind: 'validation' | 'transient',
  operation: string,
  message: string,
  providerCode?: string,
): AccountingProviderError {
  return new AccountingProviderError({ kind, provider: 'xero', operation, message, providerCode });
}

/** Xero ids are GUIDs; anything else must never be interpolated into a path or a `where` clause. */
function requireXeroGuid(value: string, operation: string): string {
  if (!GUID_RE.test(value)) throw paymentError('validation', operation, `${operation}: not a Xero id`);
  return value;
}

function toRemoteRef(p: XeroPayment): RemoteRef {
  const version = xeroPaymentVersion(p);
  return version ? { id: p.PaymentID!, remoteVersion: version } : { id: p.PaymentID! };
}

/** Payments on ONE invoice whose Reference carries THIS Breeze payment's marker, split live / deleted. */
export interface XeroMarkerHits { live: XeroPayment[]; deleted: XeroPayment[] }

/**
 * The adoption lookup (refinement 15). Fails CLOSED when the invoice's payment
 * list cannot be enumerated in one page (quorum finding 5): "no hit" must mean
 * "none exists", never "none on page 1". A thousand payments on one invoice is
 * not a real Breeze invoice, so this refuses (duplicate_key → remote_ambiguous)
 * rather than guessing.
 */
export async function lookUpXeroPaymentsByMarker(
  ctx: XeroCallContext,
  remoteInvoiceId: string,
  invoicePaymentId: string,
): Promise<XeroMarkerHits> {
  const operation = 'Xero payment lookup';
  const invoiceId = requireXeroGuid(remoteInvoiceId, operation);
  const body = await xeroApiGet<{ Payments?: unknown } | null>(
    ctx,
    `Payments${xeroQuery({ where: `Invoice.InvoiceID==guid("${invoiceId}")`, page: 1, pageSize: XERO_RECONCILE_PAGE_SIZE })}`,
    operation,
  );
  const all = xeroArray<XeroPayment>(body?.Payments);
  if (all.length >= XERO_RECONCILE_PAGE_SIZE) {
    throw paymentError('validation', operation, 'Xero returned too many payments on this invoice to rule out a duplicate', 'duplicate_key');
  }
  const ours = all.filter((p) =>
    isReceivable(p)
    && p.Invoice!.InvoiceID!.toLowerCase() === invoiceId.toLowerCase()
    && extractXeroPaymentMarker(p.Reference) === invoicePaymentId);
  return {
    live: ours.filter((p) => p.Status === 'AUTHORISED'),
    deleted: ours.filter((p) => p.Status === 'DELETED'),
  };
}

/**
 * Create one Xero payment for one Breeze payment (refinements 15, 19).
 * Adoption lookup BEFORE the create and after any uncertain (`transient`)
 * outcome:
 *  - one live hit with the SAME amount and currency is returned instead of
 *    creating (quorum finding 6: a hit with another amount is not ours to adopt);
 *  - two live hits, or a mismatched one, refuse (duplicate_key → remote_ambiguous);
 *  - no live hit but a DELETED one, on a first-generation push, refuses with
 *    remote_deleted: a human deleted the payment Breeze created (whose response
 *    was lost), and re-creating it would resurrect it (quorum finding 4). A
 *    re-owned push (pushGeneration > 0, i.e. the operator pushed the invoice
 *    again) creates anew.
 * `reference` is `paymentMarker.embed(payment.reference, payment.marker)`.
 */
export async function createXeroPayment(
  ctx: XeroCallContext,
  conn: Pick<AccountingConnection, 'defaultPaymentAccountRef'>,
  payment: AccountingPaymentPayload,
  reference: string,
): Promise<RemoteRef> {
  const op = 'Xero payment create';
  const accountId = conn.defaultPaymentAccountRef?.trim();
  if (!accountId) throw paymentError('validation', op, XERO_PAYMENT_ACCOUNT_MISSING_MESSAGE);
  requireXeroGuid(payment.remoteInvoiceId, op);
  const currency = payment.currencyCode.trim().toUpperCase();
  const wantMinor = toMinorUnits(Number(payment.amount), currency);

  const look = async (): Promise<XeroPayment | null> => {
    const { live, deleted } = await lookUpXeroPaymentsByMarker(ctx, payment.remoteInvoiceId, payment.invoicePaymentId);
    if (live.length > 1) {
      throw paymentError('validation', op, 'Xero holds more than one payment for this Breeze payment', 'duplicate_key');
    }
    const hit = live[0];
    if (hit) {
      const hitCurrency = normalizeCurrency(hit.Invoice?.CurrencyCode) ?? currency;
      const hitMinor = typeof hit.Amount === 'number' ? toMinorUnits(hit.Amount, hitCurrency) : Number.NaN;
      if (hitCurrency !== currency || hitMinor !== wantMinor) {
        throw paymentError('validation', op, 'A Xero payment carries this Breeze payment marker with a different amount or currency', 'duplicate_key');
      }
      return hit;
    }
    if (deleted.length > 0 && payment.pushGeneration === 0) {
      throw paymentError('validation', op, 'The Xero payment Breeze created for this payment was deleted there', 'remote_deleted');
    }
    return null;
  };

  const existing = await look();
  if (existing) return toRemoteRef(existing);

  const body = {
    Payments: [{
      Invoice: { InvoiceID: payment.remoteInvoiceId },
      Account: { AccountID: accountId },
      Date: payment.txnDate,
      // 2dp decimal string → JSON number at the wire only; home currency only (refinement 19).
      Amount: Number(payment.amount),
      Reference: reference,
    }],
  };

  let created: { Payments?: unknown } | null;
  try {
    created = await xeroApiWrite<{ Payments?: unknown } | null>(
      ctx, 'PUT', `Payments${xeroQuery({ summarizeErrors: true })}`, body, op,
      { idempotencyKey: xeroPaymentIdempotencyKey(ctx.tenantId, payment.invoicePaymentId, payment.pushGeneration) },
    );
  } catch (err) {
    // Uncertain: a timeout, a 5xx, or Xero's key-reuse 400 (W04 → transient). Did it land?
    if (err instanceof AccountingProviderError && err.kind === 'transient') {
      const adopted = await look();
      if (adopted) return toRemoteRef(adopted);
    }
    throw err;
  }

  const row = xeroArray<XeroPayment>(requireXeroBody(created, op).Payments)[0];
  if (row?.HasValidationErrors || (row?.ValidationErrors?.length ?? 0) > 0) {
    const text = JSON.stringify({ Elements: [{ ValidationErrors: row!.ValidationErrors ?? [] }] });
    throw paymentError('validation', op, 'Xero rejected the payment', classifyXeroValidation(text));
  }
  if (!row?.PaymentID) throw paymentError('transient', op, `${op} returned no PaymentID`);
  return toRemoteRef(row);
}

/**
 * Delete one Xero payment (refinement 18). Read first: gone or DELETED →
 * already_absent (no write); reconciled → remote_locked (no write); else
 * POST Status DELETED with NO idempotency key (a cached error must not replay).
 */
export async function deleteXeroPayment(ctx: XeroCallContext, remotePaymentId: string): Promise<PaymentDeleteResult> {
  const op = 'Xero payment delete';
  const id = requireXeroGuid(remotePaymentId, op);
  let current: XeroPayment | undefined;
  try {
    const body = await xeroApiGet<{ Payments?: unknown } | null>(ctx, `Payments/${id}`, 'Xero payment read');
    current = xeroArray<XeroPayment>(body?.Payments)[0];
  } catch (err) {
    if (err instanceof AccountingProviderError && err.kind === 'not_found') return 'already_absent';
    throw err;
  }
  if (!current || current.Status === 'DELETED') return 'already_absent';
  if (current.IsReconciled === true) {
    throw paymentError('validation', op, 'Xero will not delete a reconciled payment', 'remote_locked');
  }
  try {
    await xeroApiWrite(ctx, 'POST', `Payments/${id}`, { Status: 'DELETED' }, op);
  } catch (err) {
    if (err instanceof AccountingProviderError && err.kind === 'not_found') return 'already_absent';
    throw err;
  }
  return 'deleted';
}
```

In `xeroProvider.ts` (extend the `./xeroPayments` import), replace the two stubs and add the preflight:

```ts
  /** Refinement 17: a missing bank account parks the payment before any token refresh or call. */
  paymentPushPreflight(conn: AccountingConnection): string | null {
    return xeroPaymentPreflight(conn);
  }

  // Assumes conn.accessToken is valid (the coordinator resolves it first); issues no DB queries.
  async createPayment(conn: AccountingConnection, payment: AccountingPaymentPayload): Promise<RemoteRef> {
    return createXeroPayment(callContext(conn), conn, payment, this.paymentMarker.embed(payment.reference, payment.marker));
  }

  async deletePayment(conn: AccountingConnection, payment: AccountingDeletePaymentPayload): Promise<PaymentDeleteResult> {
    // Xero has no optimistic concurrency: the stored version is not needed (refinement 18).
    return deleteXeroPayment(callContext(conn), payment.remotePaymentId);
  }
```

If `notYet` is now unused, delete it. `accountingInvoicePushCallSites.test.ts` counts *call expressions* named `createPayment`/`deletePayment`, and these are method definitions. Run it to confirm.

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/services/accounting && npx tsc --noEmit -p .`
Expected: PASS. That covers `accountingInvoicePushCallSites.test.ts`, `neutralCore.guard.test.ts` and `quickbooksIdempotency.test.ts`, the last unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/accounting/xeroPayments.ts apps/api/src/services/accounting/xeroPayments.test.ts \
  apps/api/src/services/accounting/xeroProvider.ts apps/api/src/services/accounting/xeroProvider.test.ts
git commit -m "feat(accounting): Xero payment create with adoption, delete, bank-account preflight (Xero W05)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: W05b gate and PR

**Files:** none new.

- [ ] **Step 1: Full W05b gate**

```bash
git diff --stat origin/main -- 'apps/api/src/services/accounting/quickbooks*' apps/api/src/routes/webhooks/quickbooks.ts   # expect: empty
cd apps/api && npx vitest run 2>&1 | tail -5 && npx tsc --noEmit -p .
wc -l src/routes/accounting/index.ts                                                                   # expect: ≤ Task 0 count
cd ../web && npx vitest run 2>&1 | tail -5 && npx astro check 2>&1 | tail -3
cd ../.. && pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/accounting src/__tests__/integration/tenantCascade 2>&1 | tail -5
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage 2>&1 | tail -3
cd ../.. && pnpm test-stack down
```

Expected: all green, and the stack is down.

- [ ] **Step 2: Open PR W05b**

Title: `feat(accounting): Xero W05b — payment push and delete with adoption`. Body: `Part of #7172`. The body must state:
- Xero capabilities are unchanged (`paymentPush` false, so `loadConnectedConnection` creates no Xero rows);
- the one intended QuickBooks-visible change, the `PROVIDER_OWNED_PAYMENT` code (refinement 21), with the alias follow-up issue linked;
- the QuickBooks pins: the messages table and the "QuickBooks fault stays 502";
- the payment refusal table (refinement 16).

Run `/pr-review-toolkit:review-pr`, fix confirmed findings in one round, and post the summary.

---

# PR W05c — Web, capability flip, lab

### Task 11: Settings-step warning; `.env.example` webhook note

**Files:**
- Modify: `apps/web/src/components/integrations/AccountingSettingsStep.tsx` (+ test)
- Modify: `apps/web/src/components/integrations/AccountingConnectionPanel.tsx` (passes one prop)
- Modify: `apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/integrations.json`
- Modify: `.env.example` (the `XERO_WEBHOOK_KEY` comment)

**Interfaces:**
- Consumes: B4, B5.
- Produces:
  - `AccountingSettingsStep` gains an optional prop `paymentPushOn?: boolean`. The panel passes `status.pushPayments === true && caps.paymentPush`.
  - While that prop is true and the draft `defaultPaymentAccountRef` is empty, the step renders `<p role="status" data-testid={`${provider}-payment-account-warning`}>`.
  - New key `accountingConnection.settingsStep.paymentAccountMissing`.

- [ ] **Step 1: Write the failing test**

Append to `AccountingSettingsStep.test.tsx`, reusing its `m`, `ok`, `options` and `empty` fixtures:

```tsx
describe('payment account warning (Xero W05 refinement 17)', () => {
  it('shows while payment push is on and no bank account is chosen, and hides once one is picked', async () => {
    m.fetchWithAuth.mockReturnValueOnce(ok({ data: options }));
    render(<AccountingSettingsStep provider="xero" values={empty} paymentPushOn onSaved={vi.fn()} onUnauthorized={vi.fn()} />);
    expect(await screen.findByTestId('xero-payment-account-warning'))
      .toHaveTextContent('Payments recorded in Breeze are not sent to Xero until you choose a bank account.');
    fireEvent.change(screen.getByTestId('xero-settings-defaultPaymentAccountRef'), { target: { value: 'bank-1' } });
    await waitFor(() => expect(screen.queryByTestId('xero-payment-account-warning')).toBeNull());
  });

  it('stays hidden when payment push is off or the prop is absent', async () => {
    m.fetchWithAuth.mockReturnValueOnce(ok({ data: options }));
    render(<AccountingSettingsStep provider="xero" values={empty} onSaved={vi.fn()} onUnauthorized={vi.fn()} />);
    await screen.findByTestId('xero-settings-step');
    expect(screen.queryByTestId('xero-payment-account-warning')).toBeNull();
  });
});
```

(Use the select's real test id from W02c. The plan assumes `` `${provider}-settings-${field}` ``; Task 0 prints it.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/components/integrations/AccountingSettingsStep.test.tsx`
Expected: FAIL, because there is no warning element.

- [ ] **Step 3: Implement**

In `AccountingSettingsStep.tsx`, add `paymentPushOn?: boolean` to `Props` and to the destructure. Inside the `options &&` fragment, directly after the field list:

```tsx
          {paymentPushOn && !draft.defaultPaymentAccountRef && (
            <p role="status" className="text-sm text-amber-700" data-testid={`${provider}-payment-account-warning`}>
              {t("accountingConnection.settingsStep.paymentAccountMissing", { provider: providerName })}
            </p>
          )}
```

In `AccountingConnectionPanel.tsx`, where `AccountingSettingsStep` is rendered, pass `paymentPushOn={status?.pushPayments === true && caps.paymentPush}`.

Add `accountingConnection.settingsStep.paymentAccountMissing` to each locale:

| Locale | Text |
|---|---|
| en | `Payments recorded in Breeze are not sent to {{provider}} until you choose a bank account.` |
| de-DE | `In Breeze erfasste Zahlungen werden erst an {{provider}} übertragen, wenn Sie ein Bankkonto auswählen.` |
| es-419 | `Los pagos registrados en Breeze no se envían a {{provider}} hasta que elijas una cuenta bancaria.` |
| fr-CA | `Les paiements enregistrés dans Breeze ne sont pas envoyés à {{provider}} tant que vous n'avez pas choisi de compte bancaire.` |
| fr-FR | `Les paiements enregistrés dans Breeze ne sont pas envoyés à {{provider}} tant que vous n'avez pas choisi de compte bancaire.` |
| it-IT | `I pagamenti registrati in Breeze non vengono inviati a {{provider}} finché non scegli un conto bancario.` |
| pt-BR | `Os pagamentos registrados no Breeze não são enviados ao {{provider}} até que você escolha uma conta bancária.` |
| tr-TR | `Bir banka hesabı seçilene kadar Breeze'de kaydedilen ödemeler {{provider}} hizmetine gönderilmez.` |

(The tr-TR text puts `hizmetine` after the provider name, so no Turkish suffix is attached to `{{provider}}` itself. That is the W01d tr-TR caveat.)

In `.env.example`, replace the `XERO_WEBHOOK_KEY` comment lines with:

```
#   XERO_WEBHOOK_KEY   the app's webhook signing key. In the Xero app's Webhooks
#                      page, subscribe to Invoices with delivery URL
#                      https://your-domain.example.com/api/v1/webhooks/xero, then
#                      "Send intent to receive". Without it, Xero payments still
#                      arrive through the 15-minute sweep, just more slowly.
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && npx vitest run src/components/integrations src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts && npx tsc --noEmit -p .`
Then, from the repo root: `cd apps/api && npx vitest run src/config` (for `envComposeParity`; no variable was added, only a comment).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/integrations/AccountingSettingsStep.tsx apps/web/src/components/integrations/AccountingSettingsStep.test.tsx \
  apps/web/src/components/integrations/AccountingConnectionPanel.tsx apps/web/src/locales .env.example
git commit -m "feat(web): warn when Xero payment push has no bank account (Xero W05)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Flip `paymentPull` + `paymentPush`; real-DB proof

**Files:**
- Modify: `apps/api/src/services/accounting/xeroProvider.ts` (capabilities), `xeroProvider.test.ts`, `providerRegistry.test.ts`
- Create: `apps/api/src/__tests__/integration/accountingXeroPayments.integration.test.ts`

**Interfaces:**
- Consumes: everything above; B1, B2.
- Produces: `xeroProvider.capabilities = { connect: true, mapping: true, customerImport: true, invoicePush: true, paymentPull: true, paymentPush: true }`.

- [ ] **Step 1: Write the real-DB suite first (it is green before the flip for every test that calls the coordinators directly, because they do not read capabilities; the capability pins below are the red)**

Create `apps/api/src/__tests__/integration/accountingXeroPayments.integration.test.ts`. Model its imports, `systemRunner`, `seedInvoice`, `seedInvoiceMapping`, `seedOrgMapping`, `loadPaymentMappings`, `loadOnePaymentMapping` and `loadPayments` on `accountingPaymentPush.integration.test.ts` (`:181-330`). Copy them; do not import across test files. **Do not copy `recordAndPush`** (`:339`): it stubs the provider and completes the push. Use this record-only helper instead (quorum finding 8):

```ts
/** Records a Breeze payment; auto push mode + paymentPush make recordPayment create the pending mapping row (enqueue mocked). */
async function recordOnly(fx: XeroFixture, invoiceId: string, amount = 50) {
  const recorded = await withSystemDbAccessContext(() => recordPayment(
    invoiceId, { amount, method: 'check', receivedAt: '2026-09-02' }, fx.actor,
  ));
  const mapping = await loadOnePaymentMapping(fx);
  expect(mapping).toMatchObject({ pendingOp: 'push', remoteEntityId: null });
  return { mappingId: mapping.id, paymentId: recorded.audit.paymentId };
}
```

Then change `seedFixture` to connect **Xero**:

```ts
// A FRESH tenant per fixture: (provider, realm_id_fingerprint) is unique across
// partners, so a shared tenant id would make every later seed a tenant-held 409.
const XI = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';     // the pushed invoice's Xero InvoiceID (unique per connection only)
const XC = 'cccccccc-cccc-cccc-cccc-cccccccccccc';     // the org's Xero ContactID
const XP = '99999999-8888-7777-6666-555555555555';     // a Xero PaymentID

type XeroFixture = Fixture & { tenantId: string };
async function seedFixture(opts: { pushPayments?: boolean; pullPayments?: boolean; paymentAccount?: string | null } = {}): Promise<XeroFixture> {
  const paymentAccount = opts.paymentAccount === undefined ? 'bank-acc-1' : opts.paymentAccount;
  const tenantId = randomUUID();                       // import { randomUUID } from 'node:crypto'
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id, currencyCode: 'GBP' });
    const user = await createUser({ partnerId: partner.id, orgId: org.id });
    const conn = await upsertConnection(db, partner.id, 'xero', {
      realmId: tenantId,
      accessToken: 'live-access-token', refreshToken: 'live-refresh-token',
      accessTokenExpiresAt: FAR_FUTURE_ACCESS, refreshTokenExpiresAt: FAR_FUTURE_REFRESH,
      environment: 'production', homeCurrency: 'GBP', pushMode: 'auto',
      pushPayments: opts.pushPayments ?? true, pullPayments: opts.pullPayments ?? true,
    });
    await db.update(accountingConnections)
      .set({ defaultPaymentAccountRef: paymentAccount })
      .where(eq(accountingConnections.id, conn.id));
    return {
      partnerId: partner.id, orgId: org.id, userId: user.id, tenantId,
      conn: { ...conn, defaultPaymentAccountRef: paymentAccount },
      actor: { userId: user.id, partnerId: partner.id, accessibleOrgIds: [org.id] },
    };
  });
}
```

Seed the invoice mapping with `remoteInvoiceId = XI` and the org mapping with `XC`. Mock `fetch` with one router keyed on `METHOD path`, and record every call:

```ts
// A route answers with a Response (cloned per call, so it can be reused) or a
// function (to throw, or to vary). An array is consumed one entry per call.
type Handler = Response | ((url: URL, init: RequestInit) => Response | Promise<Response>);
function xeroFetch(routes: Record<string, Handler | Handler[]>) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(String(input));
    const key = `${init.method ?? 'GET'} ${url.pathname.replace('/api.xro/2.0/', '')}`;
    calls.push(`${key}${url.search}`);
    const route = routes[key];
    const handler = Array.isArray(route) ? route.shift() : route;
    if (!handler) throw new Error(`unexpected Xero call ${key}`);
    return typeof handler === 'function' ? handler(url, init) : handler.clone();
  });
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const msDate = (iso: string) => `/Date(${Date.parse(iso)}+0000)/`;
const xeroPayment = (over: Record<string, unknown> = {}) => ({
  PaymentID: XP, PaymentType: 'ACCRECPAYMENT', Status: 'AUTHORISED', Date: msDate('2026-09-20T00:00:00Z'),
  Amount: 50, Reference: 'CHQ 1001', IsReconciled: false, UpdatedDateUTC: msDate(new Date().toISOString()),
  Invoice: { InvoiceID: XI, Type: 'ACCREC', CurrencyCode: 'GBP' }, ...over,
});
```

Mock only the enqueue side of the two workers, keeping their processors real:

```ts
vi.mock('../../jobs/accountingReconcileWorker', async (orig) => ({
  ...(await orig<typeof import('../../jobs/accountingReconcileWorker')>()),
  enqueueAccountingReconcile: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../jobs/accountingSyncWorker', async (orig) => ({
  ...(await orig<typeof import('../../jobs/accountingSyncWorker')>()),
  enqueueAccountingPaymentPush: vi.fn().mockResolvedValue(true),
  enqueueAccountingPaymentDelete: vi.fn().mockResolvedValue(true),
}));
```

The tests:

```ts
describe('Xero payments — real Postgres (W05)', () => {
  it('capabilities: Xero declares both payment directions', () => {
    expect(providerSupports('xero', 'paymentPull')).toBe(true);
    expect(providerSupports('xero', 'paymentPush')).toBe(true);
  });

  it('the webhook tenant id finds the connection through the stored fingerprint (system scope) and enqueues delayed', async () => {
    const fx = await seedFixture();
    await expect(runOutsideDbContext(() => routeWebhookToConnection('xero', hmacFingerprint(fx.tenantId), { delayMs: 30_000 })))
      .resolves.toBe('enqueued');
    expect(enqueueAccountingReconcile).toHaveBeenCalledWith(fx.conn.id, fx.partnerId, 'webhook', { delayMs: 30_000 });
  });

  it('pull: a Xero-origin payment is applied once; a replayed window changes nothing; its deletion reverses it', async () => {
    const fx = await seedFixture();
    const invoiceId = await seedInvoice(fx, { currencyCode: 'GBP', total: '150.00' });
    await seedInvoiceMapping(fx, invoiceId, XI);
    const job = { type: 'reconcile-connection' as const, connectionId: fx.conn.id, partnerId: fx.partnerId, trigger: 'manual' as const };

    xeroFetch({ 'GET Payments': json({ Payments: [xeroPayment()] }), 'GET Invoices': json({ Invoices: [] }) });
    await processReconcileConnectionJob(job);
    expect(await loadPayments(invoiceId)).toHaveLength(1);

    vi.restoreAllMocks();
    xeroFetch({ 'GET Payments': json({ Payments: [xeroPayment()] }), 'GET Invoices': json({ Invoices: [] }) });
    await processReconcileConnectionJob(job);
    expect(await loadPayments(invoiceId)).toHaveLength(1);           // replayed, not doubled

    vi.restoreAllMocks();
    xeroFetch({ 'GET Payments': json({ Payments: [xeroPayment({ Status: 'DELETED', UpdatedDateUTC: msDate(new Date(Date.now() + 1000).toISOString()) })] }), 'GET Invoices': json({ Invoices: [] }) });
    await processReconcileConnectionJob(job);
    expect(await loadPayments(invoiceId)).toHaveLength(0);           // reversed
  });

  it('push: a lost create response is adopted, never duplicated (one PUT in all)', async () => {
    const fx = await seedFixture();
    const invoiceId = await seedInvoice(fx, { currencyCode: 'GBP' });
    await seedInvoiceMapping(fx, invoiceId, XI);
    await seedOrgMapping(fx, XC);
    const { mappingId, paymentId } = await recordOnly(fx, invoiceId);
    const ours = () => json({ Payments: [xeroPayment({ Reference: `Breeze payment ${paymentId}` })] });
    const calls = xeroFetch({
      'GET Payments': [() => json({ Payments: [] }), ours],
      'PUT Payments': () => { throw new TypeError('fetch failed'); },   // response lost
    });

    await expect(pushPaymentToAccounting(mappingId, fx.partnerId, systemRunner)).resolves.toBe('pushed');

    expect(calls.filter((c) => c.startsWith('PUT'))).toHaveLength(1);
    expect((await loadOnePaymentMapping(fx)).remoteEntityId).toBe(`${XP}/${XI}`);
  });

  it('pull adopts our own lost create; the owed push then has nothing to do', async () => {
    const fx = await seedFixture();
    const invoiceId = await seedInvoice(fx, { currencyCode: 'GBP' });
    await seedInvoiceMapping(fx, invoiceId, XI);
    await seedOrgMapping(fx, XC);
    const { mappingId, paymentId } = await recordOnly(fx, invoiceId);
    xeroFetch({
      'GET Payments': json({ Payments: [xeroPayment({ Reference: `Breeze payment ${paymentId} | CHQ 1001` })] }),
      'GET Invoices': json({ Invoices: [] }),
    });
    await processReconcileConnectionJob({ type: 'reconcile-connection', connectionId: fx.conn.id, partnerId: fx.partnerId, trigger: 'manual' });
    expect(await loadPayments(invoiceId)).toHaveLength(1);           // no mirrored second receipt
    expect(await loadOnePaymentMapping(fx)).toMatchObject({ remoteEntityId: `${XP}/${XI}`, pendingOp: null });

    vi.restoreAllMocks();
    const calls = xeroFetch({});
    await expect(pushPaymentToAccounting(mappingId, fx.partnerId, systemRunner)).resolves.toBe('nothing_owed');
    expect(calls).toEqual([]);
  });

  it('no bank account: the push parks with no Xero call and no attempt; choosing one lets the next attempt push', async () => {
    const fx = await seedFixture({ paymentAccount: null });
    const invoiceId = await seedInvoice(fx, { currencyCode: 'GBP' });
    await seedInvoiceMapping(fx, invoiceId, XI);
    await seedOrgMapping(fx, XC);
    const { mappingId } = await recordOnly(fx, invoiceId);
    const none = xeroFetch({});

    await expect(pushPaymentToAccounting(mappingId, fx.partnerId, systemRunner)).rejects.toMatchObject({ code: 'push_settings_incomplete' });
    expect(none).toEqual([]);
    expect(await loadOnePaymentMapping(fx)).toMatchObject({ pendingOp: 'push', syncAttempts: 0, claimedAt: null });

    await withSystemDbAccessContext(() => db.update(accountingConnections).set({ defaultPaymentAccountRef: 'bank-acc-1' }).where(eq(accountingConnections.id, fx.conn.id)));
    vi.restoreAllMocks();
    xeroFetch({ 'GET Payments': json({ Payments: [] }), 'PUT Payments': json({ Payments: [xeroPayment()] }) });
    await expect(pushPaymentToAccounting(mappingId, fx.partnerId, systemRunner)).resolves.toBe('pushed');
  });

  it('a Breeze void deletes the Xero payment (read, then POST DELETED) and clears the mapping', async () => {
    const fx = await seedFixture();
    const invoiceId = await seedInvoice(fx, { currencyCode: 'GBP' });
    await seedInvoiceMapping(fx, invoiceId, XI);
    await seedOrgMapping(fx, XC);
    const { mappingId, paymentId } = await recordOnly(fx, invoiceId);
    xeroFetch({ 'GET Payments': json({ Payments: [] }), 'PUT Payments': json({ Payments: [xeroPayment()] }) });
    await pushPaymentToAccounting(mappingId, fx.partnerId, systemRunner);
    await voidPayment(paymentId, { userId: fx.userId, partnerId: fx.partnerId, accessibleOrgIds: [fx.orgId] });

    vi.restoreAllMocks();
    const calls = xeroFetch({
      [`GET Payments/${XP}`]: json({ Payments: [xeroPayment()] }),
      [`POST Payments/${XP}`]: json({ Payments: [xeroPayment({ Status: 'DELETED' })] }),
    });
    await expect(deletePaymentInAccounting(mappingId, fx.partnerId, systemRunner)).resolves.toBe('deleted');
    expect(calls).toEqual([`GET Payments/${XP}`, `POST Payments/${XP}`]);
    expect(await loadPaymentMappings(fx)).toHaveLength(0);
  });
});
```

`voidPayment`'s actor argument follows `invoiceActorFrom`'s shape in the source file; use the shape the copied suite already passes.

- [ ] **Step 2: Flip, and update the pins**

Run the suite first (`pnpm test-stack up`, then `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/accountingXeroPayments.integration.test.ts`). Expected: every test FAILS for capability reasons, not for any other reason (quorum finding 8):
- the capabilities test fails on its assertion;
- `routeWebhookToConnection` answers `capability_unavailable`;
- the reconcile worker skips with `capability_unavailable`;
- `recordPayment` creates no mapping, because `loadConnectedConnection` needs `paymentPush`, so `recordOnly`'s assertion fails.

Read each failure message. Any other failure (SQL, fixture, fetch routing) is a test bug: fix it before flipping.

In `xeroProvider.ts`: `paymentPull: true, paymentPush: true`, with the file header updated to "all capabilities (W05)". In `xeroProvider.test.ts`, the "still declares … false" tests now expect `true`, and are renamed to `'declares both payment directions (W05c)'`. In `providerRegistry.test.ts`, Xero's pin becomes `['connect', 'mapping', 'customerImport', 'invoicePush', 'paymentPull', 'paymentPush']`.

- [ ] **Step 3: Run to verify everything passes**

```bash
cd apps/api && npx vitest run src/services/accounting src/jobs src/routes && npx tsc --noEmit -p .
npx vitest run -c vitest.integration.config.ts src/__tests__/integration/accountingXeroPayments.integration.test.ts src/__tests__/integration/accounting 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Step 4: Commit — only after lab X47, X50, X51, X52 and X58 pass (Task 13)**

```bash
git add apps/api/src/services/accounting/xeroProvider.ts apps/api/src/services/accounting/xeroProvider.test.ts \
  apps/api/src/services/accounting/providerRegistry.test.ts apps/api/src/__tests__/integration/accountingXeroPayments.integration.test.ts
git commit -m "feat(accounting): Xero declares paymentPull and paymentPush (Xero W05)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Lab checklist section 5, W05c gate and PR

**Files:**
- Modify: `docs/integrations/xero-demo-verification.md`: append section 5 before `## Change log`, and add a change-log line.

- [ ] **Step 1: Append the W05 checklist**

Insert before `## Change log`:

````markdown
## 5. W05 checklist — payments

Run on a `worktree-stack` of the W05c branch **with Task 12's capability flip applied locally**; it is committed only after X47, X50, X51, X52 and X58 pass. Set up first:

- The stack must be reachable from the internet over HTTPS on 443, because Xero delivers webhooks. Use a Cloudflare tunnel or the lab host.
- `XERO_WEBHOOK_KEY` must be set.
- Sections 2–4 must be done: the Demo Company is connected, the settings step has a bank account, and an org and an item are mapped.
- Push mode is **auto**: bulk push is a no-op in manual mode until #7251 lands.

Record each result, with Xero's raw text where asked.

| # | Step | Expected |
|---|---|---|
| X47 | Xero app → Webhooks: subscribe to **Invoices**, delivery URL `https://<host>/api/v1/webhooks/xero`, key into `XERO_WEBHOOK_KEY`; press **Send "Intent to receive"** | Xero reports the endpoint OK. **GATE** |
| X48 | `curl -si -X POST https://<host>/api/v1/webhooks/xero -H 'x-xero-signature: AAAA' -d '{"events":[]}'`; then look at Xero's delivery log for X47 | `401`, empty body, **no `Set-Cookie` header**; Xero's log shows a response well under 5 s |
| X49 | Before the flip (W05a/b deployed, capability off): edit a pushed invoice's due date in Xero | Webhook answers 200; API log `[xeroWebhook] processed webhook delivery` with `dropped: 1`; no reconcile run |
| X50 | After the flip: issue + push an invoice from Breeze, then **apply a 50.00 payment to it in Xero** | The payment appears on the Breeze invoice (method "Other", reference as typed in Xero). Record **whether an INVOICE webhook fired for the payment** (API log `categories.INVOICE ≥ 1`, `enqueued: 1`, run ~30 s later) or the payment arrived only with the 15-minute sweep. **GATE** (either path must deliver it; refinement 3) |
| X51 | Delete X50's payment in Xero; press **Sync now** (or wait) | The Breeze payment is reversed and the balance restored. In Postman, `GET Payments` with `If-Modified-Since` a minute before the deletion returns that payment with `Status: DELETED`. **GATE** (refinement 11) |
| X52 | Record a cash payment of 25.00 in Breeze with reference `CHQ 1001` on a pushed invoice | One Xero payment on the chosen bank account, dated as in Breeze, amount 25.00, Reference `Breeze payment <uuid> \| CHQ 1001`; Breeze payment badge "Synced". **GATE** |
| X53 | Reverse (void) X52's payment in Breeze | The Xero payment is DELETED; API log shows `GET Payments/<id>` then `POST Payments/<id>`; mapping gone |
| X54 | Push another payment; then in psql set its mapping back to `pending_op='push', remote_entity_id=null, sync_status='pending'` and wait for the sweep | The mapping is re-adopted with the **same** PaymentID; API log shows the lookup GET and **no** `PUT Payments`; Xero still has one payment |
| X55 | Reconcile a Breeze-pushed payment in the Demo Company's bank reconciliation; then reverse it in Breeze | Payment row: "Xero will not delete this payment because it is reconciled to a bank transaction — unreconcile it in Xero and delete it there"; no retries in the worker log. In Postman, `POST Payments/<id> {"Status":"DELETED"}` and record Xero's raw message (refinement 16). Then unreconcile + delete in Xero → next pull clears the mapping |
| X56 | Turn **pull** off; record a full payment on a pushed invoice **in Xero**; then record the same amount in Breeze | Breeze payment row: "Xero refused the payment because it is more than the amount still due…"; record Xero's raw message |
| X57 | Delete all payments on a pushed invoice in Xero, then **Void** it in Xero | The Breeze invoice's sync card shows "Deleted in Xero" after the next pull |
| X58 | Postman: `PUT Payments` with a Reference of 118 characters (`Breeze payment <uuid> \| ` + 64 × `R`), then 255, then 300 | The 118-character Reference **round-trips unchanged** (`GET Payments/<id>`). **GATE** (refinement 14). Record whether 255/300 are accepted, truncated or refused |
| X59 | Postman: `GET Payments` with `If-Modified-Since` one hour in the future | Record `200` with an empty list, or `304` (refinement 9) |
| X60 | Postman: `GET Payments?where=PaymentType=="ACCRECPAYMENT"` and `?where=Invoice.InvoiceID==guid("<id>")` | Both `200`. If `==` is refused, record the error and retry with the documented single `=` |
| X61 | Clear the bank account in the settings step with payment push on; then record a Breeze payment | The settings step shows "Payments recorded in Breeze are not sent to Xero until you choose a bank account."; the payment row shows "Choose a bank account…"; the API log shows **no** Xero call. Choose the account again → the next sweep (≤ 15 min) pushes it. Also, in Postman, `PUT` a payment to a non-BANK account and record Xero's message |
| X62 | Note `X-DayLimit-Remaining` before and after one **Sync now** with nothing changed; then make five quick edits to pushed invoices in Xero within 30 s | One run costs 2 calls; the five events produce **one** reconcile run (one `[AccountingReconcileWorker]` run line) |
| X63 | Postman: send the same `PUT Payments` body with the same `Idempotency-Key` twice within 6 minutes; then the same key with a different Amount | One payment; the second body gets `400 … is used with a different request.` |
| X64 | Allocate a credit note to a pushed invoice in Xero | Breeze's invoice balance does **not** change (documented v1 limitation, spec "Scope boundaries"); a later Breeze payment for the full amount shows the X56 message |

### W05 Results

| # | Result | Notes / raw Xero text |
|---|---|---|
| X47 | | |
| X48 | | |
| X49 | | |
| X50 | | |
| X51 | | |
| X52 | | |
| X53 | | |
| X54 | | |
| X55 | | |
| X56 | | |
| X57 | | |
| X58 | | |
| X59 | | |
| X60 | | |
| X61 | | |
| X62 | | |
| X63 | | |
| X64 | | |
````

Append to `## Change log`: `- W05 — payments (X47–X64); X47, X50, X51, X52 and X58 gate the paymentPull/paymentPush flip.`

**If X51 fails** (a deleted payment never comes back from `If-Modified-Since`): stop, do not flip, and escalate. The pull would then need an invoice-level allocation diff (the invoice's `Payments[]` against Breeze's mappings), which is a plan change. **If X58 fails** (Xero alters the 118-character Reference): lower `XERO_PAYMENT_REF_MAX` until the round-trip holds, and re-run X52 and X54.

- [ ] **Step 2: Full W05c gate**

```bash
git diff --stat origin/main -- 'apps/api/src/services/accounting/quickbooks*' apps/api/src/routes/webhooks/quickbooks.ts   # expect: empty
cd apps/api && npx vitest run 2>&1 | tail -5 && npx tsc --noEmit -p .
wc -l src/routes/accounting/index.ts                                                                   # expect: ≤ Task 0 count
cd ../web && npx vitest run 2>&1 | tail -5 && npx astro check 2>&1 | tail -3
cd ../.. && pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/accounting src/__tests__/integration/tenantCascade 2>&1 | tail -5
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage 2>&1 | tail -3
cd ../.. && pnpm test-stack down
```

Expected: all green, and the stack is down.

- [ ] **Step 3: Commit, then open PR W05c**

```bash
git add docs/integrations/xero-demo-verification.md
git commit -m "docs(accounting): Xero W05 lab checklist (X47–X64)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Title: `feat(accounting): Xero W05c — payment capabilities flip, bank-account warning, lab`, with `Closes #7172`. The body must include:
- the Xero capabilities after merge: all six;
- the settings-rule-9 statement from "PR split";
- the X47–X64 results, **or** "lab pending" with the owner named. **X47, X50, X51, X52 and X58 block merge**;
- the owner action: register the webhook on the hosted EU/US Xero app (X47) and set `XERO_WEBHOOK_KEY` in `/opt/breeze/.env` **and** the compose `api` `environment:` block. W02 mapped it; verify with `docker exec … printenv XERO_WEBHOOK_KEY`;
- the #7251 budget note (refinement 23).

Run `/pr-review-toolkit:review-pr`, fix confirmed findings in one round, and post the summary. After merge, run `complete_wave` for #7172, and `close_feature` for #7167 if every wave is done.

---

## Advisor quorum (2026-09-27)

Fable draft, then an independent Codex review (`codex exec -s read-only -c model_reasoning_effort=high`, model `gpt-6-astra`). Codex read this plan, the spec, the index, the W03 plan, the W04 plan (from `origin/docs/xero-w04-plan`) and the seam code on `main`:
- `types.ts`
- `accountingPaymentPush.ts`
- `accountingPaymentPull.ts`
- `accountingPaymentMarker.ts`
- `accountingWebhookRouting.ts`
- `accountingRateLimit.ts`
- `accountingConnectionService.ts`
- `xeroHttp.ts`
- `xeroProvider.ts`
- `accountingProviderError.ts`
- `accountingReconcileWorker.ts`
- `accountingSyncWorker.ts`
- `routes/webhooks/quickbooks.ts`
- `invoiceService.ts`
- `index.ts`
- `middleware/bodyLimit.ts`

It raised 10 findings: 4 P1 and 6 P2. Each was checked against the code. All 10 are real. Nine are adopted in full. Finding 3 is adopted with a narrower fix plus a documented residual that already exists and is shared with QuickBooks. The Xero API facts were verified separately against Xero's own documentation and OpenAPI files (URLs in "Where this plan refines the spec").

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | P1 | Offset paging (`page=2…`) over a list ordered by a mutable `UpdatedDateUTC` skips a row whenever an earlier row is updated mid-read. The cursor then advances past it for good. | **Adopted.** Seek paging: always `page=1`, with the next request from the last row's time − 1 s, de-duplicated by id. A no-progress full page is `stalled` → `overflowed` (refinements 9, 11; Task 3 `readSeek`, tests "seeks…" and "a row updated between two requests is not lost"). |
| 2 | P1 | A late create refusal stamped `pending_op = NULL` unconditionally. A concurrent adoption plus void could have made the row owe a DELETE, which the stamp would erase, leaving reversed money in Xero. | **Adopted.** `markPaymentRefusedIfStillOwed` is a compare-and-set on `pending_op` (and on `push_generation` and a null remote id for a push). A row that has moved on is left alone (refinement 16; Task 6, test "a late create refusal does NOT erase a delete…"). |
| 3 | P1 | A delete that is `awaiting_remote_ref` depends on a pull adopting the id within 24 hours, and W05's budget deferral could postpone that pull. | **Adopted, narrowed.** The sweep and webhook deferral never defer a connection that owes an unresolved payment delete (`connectionOwesUnresolvedPaymentDelete`; refinement 6; Task 1). The query runs only after the budget says "defer", so QuickBooks is untouched. **Residual (pre-existing, shared with QuickBooks):** a connection in `reauth_required` for more than 24 hours cannot pull, and the grace window drops the row loudly (Sentry plus a `delete_unresolved` audit). Codex's alternative, a marker lookup inside the delete, needs the invoice id, and the voided payment row no longer holds it. |
| 4 | P1 | A lost-response create that a person deletes in Xero before adoption leaves a tombstone nobody links, and a later retry would re-create (resurrect) it. | **Adopted.** On a first-generation push, the push lookup treats a DELETED marker hit (with no live hit) as `remote_deleted`: terminal, quiet, "push the invoice again to re-send". A re-owned push (`push_generation > 0`) creates anew (refinement 15; Task 9 tests; Task 6 mapping). |
| 5 | P2 | The adoption lookup read only page 1, so a hit on page 2 was missed and a duplicate created. | **Adopted.** It fails closed (`duplicate_key` → `remote_ambiguous`) when the invoice's payments fill a 1,000-row page (Task 9 test). |
| 6 | P2 | Push-side adoption did not check the amount or currency, unlike pull adoption. | **Adopted.** A live marker hit with another amount or currency refuses (`remote_ambiguous`) and is never adopted (refinement 15; Task 9 test; the ambiguous message now names both cases). |
| 7 | P2 | More than 10,000 changes inside the 5-minute overlap re-read the same rows every run and overflow forever. | **Adopted.** Seek requests that end inside the overlap have their own budget, so they do not use up the 10 progress requests (refinement 11; Task 3 test "pages inside the 5-minute overlap…"). Only a burst of more than 10,000 changes within the overlap, or 1,000 within one second, still overflows, and it does so loudly. |
| 8 | P2 | The integration-test sketch passed `Response` values to a router that called them as functions, reused `recordAndPush` (which completes the push), and claimed only one pre-flip failure. | **Adopted.** The router now accepts a `Response` (cloned per call) or a function. A new `recordOnly` helper asserts the pending row. The pre-flip expectation now lists every capability-caused failure (Task 12). |
| 9 | P2 | The worker now calls `accountingProviderDisplayName`, but the reconcile-worker test's registry mock lacks it, so every successful-run test would throw. | **Adopted.** Task 1 Step 1 extends the mock, and adds the owed-delete mock. |
| 10 | P2 | `partnerGuard` runs before the route. With any valid Breeze bearer token plus a bad Xero signature, it reads `partners` in system scope and may write an activation, all before the HMAC, and it can answer a JSON 403 instead of the empty 401. | **Adopted.** `isPartnerGuardExemptPath` exempts exactly `/api/v1/webhooks/xero`, with a test (refinement 2; Task 4). The same pre-existing exposure on the QuickBooks webhook is left byte-identical and filed as a follow-up issue in Task 4. |

## Self-review (done while writing; kept for the executor)

**Spec coverage (§W05):**
- **Webhook.** `POST /webhooks/xero` checks the `x-xero-signature` HMAC (Task 4 `verifyWebhook`) with a constant-time compare. It answers exactly 200 (empty body) when the signature is valid, including intent-to-receive, and 401 with an empty body when it is not (Task 4 route matrix).
  - Each event's `tenantId` is fingerprinted and passed to `routeWebhookToConnection('xero', fp)`. The shared helper gains an optional delay (Task 1).
  - The `INVOICE` event is the doorbell (refinement 3; lab X50).
- **Pull.** `GET /Payments` with `If-Modified-Since`, paged and filtered to `ACCRECPAYMENT`, with statuses AUTHORISED → lines and DELETED → deletions. `GET /Invoices` with `Statuses=VOIDED,DELETED` gives remote voids (Task 3).
  - One invoice per payment, with the `"<paymentId>/<invoiceId>"` id unchanged (refinement 12).
  - The cursor is the newest `UpdatedDateUTC` read, with a 5-minute overlap and no 30-day window or backfill. The spec's "max UpdatedDateUTC seen, minus 5-min overlap" is kept, with the overlap applied at read time and the page-cap progress rule added (refinement 11). The sweep stays the backstop (unchanged).
  - A pushed payment whose version changes goes through the existing echo flow (refinement 13).
  - Allocations are not observed (refinement 10; lab X64).
- **Push.** `PUT /Payments` sends `Invoice.InvoiceID`, `Account.AccountID` (= `default_payment_account_ref`), `Date`, `Amount` and `Reference` (marker + reference, capped). `CurrencyRate` is dropped: home currency only (refinement 19; Task 9).
  - Idempotency uses the key plus an adoption lookup before every create (refinement 15).
- **Delete.** `POST /Payments/{id}` `{Status:'DELETED'}`. A reconciled payment → `validation` (`remote_locked`), surfaced and not retried (refinements 16, 18).
- **Settings.** A null `default_payment_account_ref` means push is disabled with a settings warning. Refined to "parked": a row-level message, plus the settings-step warning, plus self-healing (refinement 17; Tasks 6, 9, 11).
- **Horizon and capabilities.** The `push_payments_since` horizon is unchanged (the coordinator is not touched there). Capabilities gain `paymentPull` and `paymentPush` (Task 12).
- **Testing section.** The webhook 200/401 intent-to-receive is unit-tested in Task 4. The reconcile worker consuming a Xero `ChangeSet` is covered by the Task 12 real-DB suite.
- **Cross-wave contracts:**
  - QuickBooks is byte-identical (Global Constraints and pins);
  - capabilities gate every layer (unchanged gates; the flip is last);
  - no new tables (refinement 24);
  - the adoption rule holds (refinement 15);
  - remote entity type stays `Payment`.
- **W01d deferrals taken:** the two renames (Task 7) and the provider-labelled payment notes (Tasks 1, 6).

**Placeholder scan:** there is no TBD and no "similar to". Test bodies name helpers from existing test files. Their shapes were read, but the tests could not be executed: the copied fixtures of `accountingPaymentPush.integration.test.ts`, `voidPayment`'s actor, W02c's select test id, and the sweep-test arrangement in `accountingReconcileWorker.test.ts`. For each, the plan gives fixed assertions and says to use the file's real names. W02, W03 and W04 used the same convention.

**Type consistency:**
- `ReconcileEnqueueOptions` (Task 1) is used by `routeWebhookToConnection` (Task 1) and the route (Task 4).
- `formatXeroIfModifiedSince` and `XeroGetOptions` (Task 2) are used by `readSeek` (Task 3).
- From Task 3:
  - `XeroPayment`, `isReceivable`, `xeroPaymentVersion` and `extractXeroPaymentMarker` are reused by Task 9;
  - `embedXeroPaymentMarker` and `extractXeroPaymentMarker` are wired as `paymentMarker` in Task 5;
  - `XERO_PAYMENT_REF_MAX` is wired as `limits.paymentRefMax` in Task 5.
- `paymentPushPreflight?` (Task 6) is implemented by `xeroPaymentPreflight` and wired in Task 9.
- `connectionOwesUnresolvedPaymentDelete` (Task 1) is used by the webhook deferral and sweep pass 1 (Task 1).
- `markPaymentRefusedIfStillOwed` (Task 6) is the only stamp for provider refusals after the call.
- `remote_deleted` is added to `ACCOUNTING_REFUSAL_CODES` in Task 6, produced by `createXeroPayment` in Task 9, and mapped by `paymentPushRefusal` in Task 6.
- The seven payment codes (Task 6) are thrown by `paymentPushRefusal` and the preflight branch, and listed in `PAYMENT_TERMINAL_CODES` / `PAYMENT_USER_RESOLVABLE_CODES`.
- `amount_exceeds_due` is added to `ACCOUNTING_REFUSAL_CODES` in Task 6, produced by `classifyXeroValidation` in Task 8, and mapped by `paymentPushRefusal` in Task 6.
- `remote_locked` is produced by Tasks 8 and 9 and mapped in Task 6.
- `duplicate_key` is produced by `createXeroPayment` in Task 9 and mapped to `remote_ambiguous` in Task 6.
- `createXeroPayment` and `deleteXeroPayment` (Task 9) are called only by `xeroProvider.ts`.

**Review Focus → tests:**

| # | Tests |
|---|---|
| 1 | Task 3 marker tests; Task 9 "adopts instead of creating" / "a timed-out … looks again and adopts" / "two live hits" / "different amount" / "only a DELETED hit"; Task 6 "a late create refusal does NOT erase a delete"; Task 12 "lost create response is adopted" / "pull adopts our own lost create" |
| 2 | Task 3 `DELETED` → `deletedPayments` and "a row updated between two requests"; Task 12 pull reversal; lab X51 |
| 3 | Task 1 delay + `daily_budget_low`; Task 4 matrix (signature before parse, cap, 503 on any failure); Task 12 replay |
| 4 | Task 6 "preflight PARKS"; Task 9 preflight; Task 12 "no bank account"; lab X61 |
| 5 | Task 9 delete table; Task 6 "delete refusal remote_locked"; lab X55 |

**Deliberately not in W05:**
- Observing credit-note, overpayment or prepayment allocations. This is the spec's documented v1 limitation for both providers (lab X64). Its follow-up belongs to the spec's "tracked as a follow-up for both providers".
- Classifying Xero's refusal for a non-bank or payment-disabled account. It stays a generic retryable `validation` (the QuickBooks-shared 502 path), and lab X61 records the text for a follow-up.
- An event ledger or a Redis replay cache (refinement 4).
- Refunds out of Xero (`AROVERPAYMENTPAYMENT`/`ARPREPAYMENTPAYMENT`). They are skipped (refinement 10).
- Multi-currency payments. The coordinator's currency guard already refuses them (refinement 19).
- Removing the `quickbooksRecordUntouched` response alias. A follow-up issue is filed in Task 7.
- Fixing manual-mode bulk push (#7251, in progress elsewhere; refinement 23).
- The Xero `apps/docs` page, per the spec's "Rollout". The docs-review mapping entry is added so the docs job flags it.
