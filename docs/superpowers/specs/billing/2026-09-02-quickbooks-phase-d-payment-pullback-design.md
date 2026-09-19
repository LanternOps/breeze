# QuickBooks Phase D — Payment Pull-back Design

**Date:** 2026-09-02
**Status:** Approved in brainstorm (Fable + Todd, 2026-09-02); implementation plan follows
**Parent spec:** `docs/superpowers/specs/billing/2026-06-23-quickbooks-accounting-integration-design.md` (§ Pull-back: Payment)
**Hosted registration contract:** `docs/superpowers/specs/integrations/2026-08-29-quickbooks-hosted-production-registration-design.md`
**Builds on:** Phase B (#4372), Phase C (#4492)

## Goal

Reflect payments recorded in QuickBooks Online against invoices Breeze pushed there back onto the Breeze invoice, idempotently, within seconds when Intuit's webhook reaches us and within 15 minutes when it does not. Breeze stays the system of record for the invoice; QuickBooks is the source of truth for QuickBooks-origin payments only.

## Decisions locked in brainstorm

1. **Pull-back only in this slice.** Pushing Breeze-recorded payments (Stripe, manual) to QuickBooks is the immediate next slice. The `payment` mapping row is shaped here so that slice reuses it unchanged.
2. **QBO-origin payment deleted or voided in QBO → mirror it.** Breeze deletes the mirrored payment row and recomputes the invoice, with an audit entry. Manual and Stripe payments are never touched by the pull. A QBO invoice deleted or voided on the QBO side flips the invoice mapping to `error` ("Deleted in QuickBooks") and is never auto-resurrected.
3. **Webhook enqueues, CDC does the work (Approach A).** The webhook verifies, resolves realms to connections, and enqueues one per-connection reconcile job. A 15-minute sweep enqueues the same job for every connected realm. One job type, one applier, one code path for webhook, sweep, replay, and "Sync now".
4. **One Intuit app, one webhook URL.** Intuit allows a single webhook endpoint per app and the hosted contract uses one app for both regions, so only the US deployment receives notifications. The CDC sweep is therefore the guaranteed path in every region; the webhook is a latency optimisation. Cross-region forwarding is out of scope.
5. **Verifier token is app-level.** `QBO_WEBHOOK_VERIFIER_TOKEN` env var (one per Intuit app environment). The per-connection `webhook_verifier_token_encrypted` column stays unused and is documented as such; it is not dropped.
6. **Realm lookup by keyed fingerprint.** `realm_id_encrypted` uses a random IV, so it cannot be queried. A new `realm_id_fingerprint` column holds `hmacFingerprint(realmId)` (`services/secretCrypto.ts`), backfilled under system scope.
7. **Home-currency only, same rule as invoices.** A pulled payment whose currency differs from the invoice's stamped currency records a mapping `error`, never a payment row.
8. **`pull_payments` is a per-connection switch, default on.** Mirrors `push_mode`. It exists because an MSP that double-enters payments (Breeze and QBO) would otherwise double-count until the push slice makes Breeze-origin payments recognisable.

## Data model

One migration: `apps/api/migrations/2026-10-01-quickbooks-payment-pullback.sql` (must sort after `2026-10-01-100000-script-children-rls.sql`, the newest committed at the time of writing; re-check before creating). Idempotent, no inner `BEGIN`/`COMMIT`. It adds columns and an index only; the fingerprint backfill runs in the app (see below).

### `accounting_connections` (partner-axis, already RLS'd; not in the org cascade)

| Column | Type | Notes |
|---|---|---|
| `realm_id_fingerprint` | `text` | `hmacFingerprint(realmId)`. The migration only adds the column: the HMAC key lives in the app, so SQL cannot compute it. Backfill is an idempotent boot-time step in the API (`backfillRealmFingerprints`, `withSystemDbAccessContext`): every connection whose fingerprint is null or carries a stale key-id prefix gets decrypted and re-fingerprinted. That same step self-heals after an encryption-key rotation, since fingerprints are comparable only within one key generation. New rows are written by `upsertConnection`. Partial unique index on `(provider, realm_id_fingerprint) WHERE realm_id_fingerprint IS NOT NULL`. |
| `pull_payments` | `boolean NOT NULL DEFAULT true` | settings-controlled |
| `last_reconcile_at` | `timestamptz` | set only after a clean run |
| `cdc_cursor` | existing `timestamptz` | now read/written; added to `AccountingConnection` + `mapConnection` |

### `accounting_entity_mappings` — no schema change

A pulled payment is one `invoice_payments` row plus one mapping row:

- `breeze_entity_type = 'payment'`, `breeze_entity_id = invoice_payments.id`
- `remote_entity_type = 'Payment'`, `remote_entity_id = '<PaymentId>/<remoteInvoiceId>'`
- `link_status = 'confirmed'`, `sync_status ∈ synced | error`, `remote_sync_token` = Payment `SyncToken`
- `partner_id`, `integration_id` from the connection (composite FK enforces the pair)

The composite remote id lets a single QBO Payment applied across several Breeze invoices satisfy the existing `(integration_id, remote_entity_type, remote_entity_id)` unique index, and it is the exact shape the push slice writes. Reversal looks up `remote_entity_id LIKE '<PaymentId>/%'` scoped to the connection.

The CHECK constraints already admit `payment ↔ Payment`; erasure (`tenantCascade.ts`) and merge (`orgMerge.ts`) arms for `payment` rows already exist. The two live TODOs — `invoiceService.voidPayment` and the Stripe full-refund branch in `stripeReconcile.ts` — gain the inline mapping delete they describe.

### `invoice_payments` — no schema change

`source` stays derived at read time: `listPayments` joins the payment mapping and tags rows `'quickbooks'` the way it tags `'stripe'` today. No external refs on core billing tables.

## Components

```
routes/webhooks/quickbooks.ts          POST /api/v1/webhooks/quickbooks  (unauthenticated, HMAC)
services/accounting/quickbooksProvider.ts   reconcileChanges (CDC) — replaces the Phase D stub
services/accounting/accountingPaymentPull.ts  applyAccountingPayment / reverseAccountingPayment / markInvoiceDeletedRemotely
jobs/accountingReconcileWorker.ts      reconcile-connection job + 15-min sweep
services/accounting/accountingConnectionService.ts   fingerprint, pull_payments, cursor, findConnectionByRealmFingerprint
routes/accounting/index.ts             settings: pullPayments; POST /:provider/reconcile (Sync now)
services/invoiceService.ts             listPayments source='quickbooks'; voidPayment clears payment mapping
web: QuickbooksIntegration.tsx, InvoiceDetail.tsx, AccountingSyncCard.tsx, invoiceTypes.ts, locales/*
```

### Webhook route

- Modeled on `routes/tickets/emailWebhook.ts` (verify → enqueue → 202), not on the Stripe route (which reconciles inline). Mounted with the other `/webhooks` routers; no `authMiddleware`; `partnerGuard` passes it because there is no bearer token. Not in `SELF_MANAGED_DB_CONTEXT_ROUTES` (nothing to opt out of).
- Rate-limited by trusted client IP like the Stripe route. Reads the raw body with `c.req.text()` before anything else.
- `verifyWebhook(intuit-signature header, rawBody, QBO_WEBHOOK_VERIFIER_TOKEN)` — already implemented (HMAC-SHA256, base64, `timingSafeEqual`). Missing env var → 503 with a Sentry breadcrumb, never 200.
- Response codes: 401 bad/missing signature (Intuit does not retry), 400 unparsable body, 202 accepted, 503 when the queue add fails (Intuit retries with backoff for 24h).
- For each `eventNotifications[].realmId`: `hmacFingerprint(realmId)` → `findConnectionByRealmFingerprint` in one short system context → enqueue `reconcile-connection` with jobId `accounting-reconcile-<connectionId>`. Unknown realm → counted and dropped (other region, disconnected). The handler never acts on entity ids in the payload; it only logs counts by entity name.

### CDC pull (`reconcileChanges`)

- `GET /v3/company/{realm}/cdc?entities=Payment,Invoice&changedSince=<ISO of cursor − 5 min>&minorversion=70`, via the existing `qboRequest` helper (sanitized errors, `runOutsideDbContext` around fetch). Follows QBO's CDC paging (`maxResults`/`startPosition` per entity) until exhausted.
- First run: `cursor = max(connection.createdAt, now − 30 days)` (QBO CDC's lookback limit).
- Returns the shipped `ChangeSet` widened with `deletedPayments: string[]` and `deletedInvoices: string[]` (entities with `status: "Deleted"`), and `payments[]` built from each Payment's `Line[].LinkedTxn` where `TxnType === 'Invoice'`: `remoteInvoiceId = TxnId`, `amountMinor = toMinorUnits(Line.Amount)`, `currency = Payment.CurrencyRef.value ?? realm home currency`, `txnDate = Payment.TxnDate`, plus `remotePaymentSyncToken`, `paymentMethodName`, `paymentRefNum`. A Payment with `TotalAmt 0` (voided) is emitted with zero lines and treated as a deletion by the applier.
- Never persists or rethrows raw QBO bodies (Phase C rule).

### Applier (`accountingPaymentPull.ts`)

Entry guard: `assertNoAmbientDbContext` (Phase C `dbContextGuard.ts`); takes a `DbContextRunner`, always `withSystemDbAccessContext` from the worker. One short transaction per payment line:

1. Resolve the Breeze invoice via the `invoice` mapping for `(connection, remoteInvoiceId)`. None → `skipped_unmapped` (an invoice Breeze never pushed); not an error.
2. `SELECT … FOR UPDATE` the invoice row first (the lock order `recordPayment` and `recordStripePayment` use), then read the payment mapping for `'<PaymentId>/<remoteInvoiceId>'`.
3. Mapping present, `synced`, same `remote_sync_token` → no-op (`replayed`). Present with a newer sync token → QBO edited the payment: update the `invoice_payments.amount` / `received_at`, mapping token, recompute (`updated`).
4. Currency guard: `currency !== invoice.currencyCode` → mapping `error` with the sanitized Phase C-style message, no payment row (`currency_mismatch`).
5. Insert `invoice_payments`: `amount = fromMinorUnits(amountMinor)` (exactly once, per `accountingCurrency.ts` item 4), `method` mapped from the QBO PaymentMethod name (`Cash→cash`, `Check→check`, `Credit Card→card`, anything else→`other`), `reference = paymentRefNum ?? PaymentId`, `receivedAt = txnDate`, `recordedBy = null`, `note = "Pulled from QuickBooks"`. Over-payment is allowed (Breeze already tolerates multiple payments past balance). Zero-row insert throws (RLS-context bug, not a no-op).
6. Insert the payment mapping `confirmed / synced` with the sync token, then `recomputeInvoiceStatus(invoiceId, tx)`.
7. Audit `accounting.payment.pulled` (`resourceType: 'invoice'`, details: provider, remotePaymentId, amount, currency).

`reverseAccountingPayment(connection, remotePaymentId)`: find mapping rows `remote_entity_id LIKE '<PaymentId>/%'` for the connection; for each, lock the invoice, delete the `invoice_payments` row **only if the mapping points at it**, delete the mapping, recompute, audit `accounting.payment.reversed`. Rows without a mapping are structurally unreachable.

`markInvoiceDeletedRemotely(connection, remoteInvoiceId)`: invoice mapping → `sync_status='error'`, `last_error='Deleted in QuickBooks'`. Never clears `remote_entity_id`; never re-pushes.

Each step's outcome is one of `applied | updated | replayed | reversed | skipped_unmapped | currency_mismatch | failed`; the worker aggregates them.

### Worker (`accountingReconcileWorker.ts`, placement `global`)

- Queue `accounting-reconcile`. Job `reconcile-connection { connectionId, partnerId, trigger: 'webhook' | 'sweep' | 'manual' }`, jobId `accounting-reconcile-<connectionId>` (no colons), `attempts: 5`, exponential backoff from 5 s, `removeOnComplete: true`, `removeOnFail: true` (Phase C lesson: retained jobs silently swallow re-enqueues). In-flight dedup is the whole point of the shared jobId.
- Job body, with the Phase C no-ambient-context discipline:
  1. Short system context: load the connection by id; return if not `connected` or `pull_payments = false`.
  2. `resolveConnectionAndToken(partnerId, provider, runner)` with nothing open; `reconcileChanges(liveConn, cursor)` outside any context.
  3. Apply every payment line and deletion through the applier (each its own short context). Deletions are processed before additions so a delete-and-recreate in the same window lands in the right order.
  4. Final short context: advance `cdc_cursor` to the ChangeSet cursor and set `last_reconcile_at` **only if no item ended `failed`**; otherwise leave the cursor and rethrow so BullMQ retries. `currency_mismatch` and `skipped_unmapped` count as clean.
- Sweep: repeatable job `sweep` every 15 min (`every:`, like Huntress — sub-hourly ticks are exempt from `scheduleRegistry`), removed-then-re-added on boot so restarts don't stack schedules. Lists `connected` connections with `pull_payments = true` in one short system context and enqueues `reconcile-connection` for each with `trigger: 'sweep'`; the Redis calls happen with no context held.
- Registered in `workerRegistry.ts` as `accountingReconcileWorker`, `global`, verified by `workerEntrypointClosure.contract.test.ts` (no agent-socket reach). The counter tests bump by one.
- Unit-tested contract: worker never calls the provider inside an open context; cursor advances only on a clean run; disconnected/paused connections short-circuit before any QBO call.

### Settings and routes

- `settingsSchema` gains `pullPayments: z.boolean().optional()`; `GET /:provider` returns `pullPayments` and `lastReconcileAt`.
- `POST /:provider/reconcile` ("Sync now"): partnerScopes + `requireMfa()` + `requirePermission(INVOICES_WRITE)`; enqueues the job with `trigger: 'manual'`; returns `{ enqueued: boolean }` honestly (Phase C lesson); audits `accounting.reconcile.requested`. Not in `SELF_MANAGED_DB_CONTEXT_ROUTES` (no outbound call in the handler).
- `upsertConnection` writes `realm_id_fingerprint` on connect/reconnect. Reconnecting the same realm therefore keeps the fingerprint stable and the webhook keeps routing.

### Web

- `QuickbooksIntegration.tsx`: "Pull payments from QuickBooks" toggle beside the push-mode row (`runAction`, PATCH settings), "Last payment sync" line (`lastReconcileAt`, or "Never"), "Sync now" button (`runAction`, POST reconcile, toast on `enqueued: false`). Partner scope + `invoices:write` gate, same as bulk push.
- `InvoiceDetail.tsx` payments list: `source === 'quickbooks'` → "QuickBooks" badge, void button replaced by a "via QuickBooks" label (mirrors the Stripe branch). `invoiceTypes.ts` union widened.
- `AccountingSyncCard.tsx`: renders the `error` state's `lastError`, so "Deleted in QuickBooks" needs no new branch; add a test pinning the copy path.
- All copy through `t(...)`; keys in every locale dir; genuine translations (`translationCoverage.test.ts` caps English duplicates).

## Multi-tenancy / RLS

- No new tables → no cascade, export-policy, or `orgMergeRegistry` registrations. The new columns live on `accounting_connections`, which is partner-axis and outside the org cascade, so the export-policy column rule does not fire.
- The webhook and worker run system context. Partner scoping rests on the code path: a connection is resolved by id or realm fingerprint, and every mapping write carries that connection's `(integration_id, partner_id)`, which the composite FK to `accounting_connections(id, partner_id)` enforces. An integration test forges a mapping across partners and asserts 42501/23503.
- `partner-wide-write-coverage.test.ts` gains one exemption line for `accountingPaymentPull.ts` ("QBO-signed webhook / system-context CDC backstop writes `payment` mapping rows and `invoice_payments`; no tenant caller"), mirroring the Stripe webhook precedent.
- `invoice_payments` is org-axis (shape 1); the applier inserts with the invoice's `org_id`, and the system context is what allows the write.

## Observability

- Audit: `accounting.payment.pulled`, `accounting.payment.reversed`, `accounting.reconcile.requested`.
- Worker log line per run: `connectionId`, trigger, counts by outcome, cursor before/after, duration. Terminal per-item failures go to Sentry with `service: 'accountingPaymentPull'` and no QBO body.
- Webhook: count of notifications, matched realms, dropped realms; never log payload entity ids at info level.

## Testing

- **Unit:** `verifyWebhook` route status matrix (401/400/202/503, missing env); CDC parser (split payment → two lines, deleted entity, voided zero-total payment, paging); applier branches (`skipped_unmapped`, `replayed`, `updated`, `currency_mismatch`, `applied`, reversal touching only mapped rows); worker (no provider call inside a context, cursor advance only on clean run, gating).
- **Integration (real Postgres):** apply the same ChangeSet twice → one `invoice_payments` row, invoice status paid; split payment → two rows, two mappings under one Payment id; reversal deletes the QBO-origin row and leaves a manual payment on the same invoice; cross-partner mapping forge rejected; fingerprint backfill populates existing rows and `findConnectionByRealmFingerprint` finds them; `voidPayment` clears the payment mapping.
- **Contract suites unchanged but run:** `workerRegistry` / `workerEntrypointClosure` counters, `partner-wide-write-coverage`, `rls-coverage`, `db:check-drift`, `autoMigrate.test.ts`, migration-naming guard.
- **Sandbox walkthrough (added to `docs/integrations/quickbooks-sandbox-verification.md`):** register the webhook URL through a tunnel; receive a partial payment in QBO → Breeze partial; final payment → paid; replay the notification → no duplicate; delete the payment in QBO → Breeze reverses; stale-cursor sweep with the webhook disabled → same end state; toggle `pull_payments` off → sweep no-ops.

## Out of scope (named)

- Payment push Breeze → QBO (next slice; reuses the `payment` mapping shape).
- Foreign-currency payments (mapping `error`, same as invoices).
- Credit memos and QBO-originated refunds.
- Cross-region forwarding of webhook notifications; EU relies on the sweep.
- Dropping the unused `webhook_verifier_token_encrypted` column.

## Next step

`writing-plans` for this spec: tasks in dependency order (migration + connection service → provider CDC → applier → worker → webhook route → settings/route → web → docs + sandbox checklist), each red-first, integration suite on real Postgres, one review round, PR, stop.
