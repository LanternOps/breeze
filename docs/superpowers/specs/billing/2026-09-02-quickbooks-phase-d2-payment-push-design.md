# QuickBooks Phase D2 — Payment Push Design

**Date:** 2026-09-02
**Status:** Quorum'd (Fable + Codex xhigh read-only, 2026-09-02); implementation plan follows. Todd authorised the slice end-to-end through "open the PR and stop"; the three points where the quorum overrode the task brief are flagged in § Deviations from the brief.
**Parent spec:** `docs/superpowers/specs/billing/2026-06-23-quickbooks-accounting-integration-design.md`
**Builds on:** Phase C invoice push (#4492), Phase D payment pull-back (#4531, walked in #4537)
**Follow-ups filed from the Phase D walk:** #4542 (paid_at never cleared — fixed here), #4543 (silent pull skip), #4544 (push button on void/deleted invoices), #4545 (dead Development webhook URL — must be re-registered before this slice's sandbox walk)

## Goal

When a payment is recorded in Breeze against an invoice that is already in QuickBooks, create the matching QuickBooks Payment applied to that invoice, and delete it from QuickBooks when the Breeze payment is voided or fully refunded. The push must be idempotent under crashes and retries, must never double-count when its own webhook/CDC echo arrives through the Phase D pull, and must respect the connection's `push_mode` plus a new `push_payments` switch. Breeze is the system of record for Breeze-origin payments; QuickBooks remains the source of truth for QuickBooks-origin payments (Phase D decision 2), so the two directions never fight over one row.

## Decisions (quorum outcome)

1. **The mapping row is the desired-state record and the outbox.** The `payment` mapping row is written *in the same transaction* as the Breeze payment insert/delete, carrying `pending_op = 'push' | 'delete'`. The immediate BullMQ enqueue after the transaction is a latency optimisation; the existing 15-minute reconcile sweep re-enqueues any `pending_op` row older than two minutes, so a lost enqueue (Redis outage, savepoint not yet committed, process death) is recovered without any operator action. Codex's blocker "a delete must survive Redis failure and exhausted retries" is met by never clearing the mapping until QuickBooks confirms.
2. **Exclusive claim by lease, not by upsert.** The worker claims a row with a compare-and-set: `UPDATE … SET claimed_at = now() WHERE id = ? AND pending_op IS NOT NULL AND (claimed_at IS NULL OR claimed_at < now() − 10 min) RETURNING id`. Zero rows → `sync_in_progress`, retryable. Codex correctly noted the Phase C upsert only excludes racing *inserts*; the lease closes the re-entry hole for payments. (Phase C invoices keep their existing shape; not touched.)
3. **Idempotency key = QBO `requestid` + `PrivateNote` marker, adoption by the pull.** Create sends `requestid=<invoice_payments.id>` (QBO dedupes 24 h, as the invoice push does) and `PrivateNote: 'Breeze payment <uuid>'`. `PrivateNote` is not queryable, so there is no recovery query; instead the pull adopts: when CDC delivers a Payment whose note carries a Breeze payment id that matches a `pending` mapping with no remote id, the pull fills in the remote id and token (`adopted`). The CDC sweep runs every 15 minutes, so a crash between create and phase 2 self-heals within one sweep even after the 24-hour `requestid` window. `PaymentRefNum` keeps carrying the real reference (cheque number, Stripe `pi_…`, truncated to QBO's 21 chars) and is never an ownership key.
4. **`breeze_origin` on the mapping row.** New boolean, `true` for every mapping the push creates (payments and, by backfill, invoices); pulled payments stay `false`. The pull needs origin *locally* because a CDC deletion carries no `PrivateNote`.
5. **Pull rules for Breeze-origin rows (the echo).** Never mutate a Breeze-origin `invoice_payments` row from QuickBooks. Same token → `replayed`. Newer token with the same amount and same single invoice allocation → store the token, `replayed`. Newer token with a different amount, or an allocation added/moved to another invoice → store the token anyway (so a later corrective push can supply the right `SyncToken`) and set the mapping to `error` "Edited in QuickBooks; Breeze remains the source of truth for this payment" (`breeze_origin_diverged`). CDC deletion or void of a Breeze-origin payment → **do not delete the Breeze payment** (the money moved, e.g. Stripe); mapping → `error` "Deleted in QuickBooks", `remote_entity_id` cleared so the payment is re-pushable. `reverseStaleAllocations` treats a Breeze-origin mapping as divergence, not as a QuickBooks-origin allocation to reverse, and — unlike a CDC deletion — it NEVER clears the ids: a reallocation means the Payment still exists, so `remote_entity_id` and `remote_sync_token` are kept (`breeze_origin_diverged`). A row that already owes a delete is left completely untouched (`skipped_breeze_origin`, no write at all) so the delete worker keeps its remote ref. Symmetrically, a CDC deletion of a row that already owes a delete SATISFIES it — the mapping is dropped rather than parked on `awaiting_remote_ref` — and a CDC deletion of a row owing nothing clears the ids so `fanOutOwedPayments` can re-own the SAME mapping row for a re-push.
6. **Reconcile runs when `pull_payments OR push_payments`.** Today the worker exits when `pull_payments = false` (Codex blocker). With pull off and push on, the CDC pass still runs but suppresses *new* QuickBooks-origin imports (`skipped_pull_disabled`, counted) while still processing Breeze-origin echoes, adoptions, and remote deletions. The skip is logged per reason (#4543 is fixed in passing for this one reason; the other reasons stay for #4543).
7. **Phase 2 re-reads under the invoice lock.** The QBO round trip is not covered by any lock, so after create the coordinator locks the invoice and re-reads the mapping and the payment: payment row gone (voided/refunded during the call) → keep the mapping, stamp the remote ref, flip `pending_op = 'delete'`, and return `converted_to_delete` so the worker enqueues it (the coordinator never touches Redis); invoice voided mid-flight → stamp the remote ref normally (decision 11: a void never deletes a QuickBooks payment; phase 1 refuses a push against an invoice that is *already* void with terminal `invoice_void`); echo already adopted the row with the same remote id → keep the newer token, do not overwrite; amount changed (partial refund) → stamp the remote ref and set the mapping `error` per decision 9. Job ids are `accounting-payment-<mappingId>-<op>` so a delete enqueued while a push job is still active is never swallowed by a deterministic id.
8. **Stripe pushes gross.** `invoice_payments.amount` is the charge amount and is what settles the invoice; `DepositToAccountRef` is omitted so QuickBooks books it to Undeposited Funds and the bookkeeper records the processor fee at deposit time. Fee expenses are out of scope.
9. **Refunds: full refund mirrors as delete; partial refund is a divergence, not an update.** A Stripe full refund already deletes the Breeze row (`reflectStripeRefund`) → `pending_op = 'delete'` like a void. A partial refund reduces the Breeze amount in place; rewriting a QuickBooks Payment's amount would rewrite receipt history, and Intuit models refunds as separate transactions. The refund path therefore sets the mapping to `error` "Refunded in Stripe, total <X>; record the refund in QuickBooks (this QuickBooks payment still shows the full amount)" and leaves the QuickBooks Payment as-is. `<X>` is the CUMULATIVE total refunded so far, never a single event's delta and never the amount remaining on the payment: Stripe's `amount_refunded` is cumulative, and the coordinator's own mid-flight `diverged` branch derives the same figure as (pushed amount − current payment amount). Both paths call one helper (`partialRefundDivergenceMessage`), and the wording restates the figure as a running total because the original text quoted a bare amount that a bookkeeper who had already recorded an earlier refund read as a second, fresh amount to enter. `RefundReceipt` / credit memos are out of scope. Consequently the push is **create-only**: there is no `updatePayment`.
10. **`push_mode` and `push_payments`.** `push_payments` is a new per-connection boolean mirroring `pull_payments`. Default `true` for new connections (Todd's brief); existing connections (0 in prod as of 2026-09-02, verified) get `true` by the migration default — flagged in the release notes since it enables outbound money writes. `push_mode = 'auto'` and `push_payments = true` → `recordPayment` / `recordStripePayment` write `pending_op = 'push'` and enqueue. `push_mode = 'manual'` → no automatic payment push; the invoice's manual "Push to QuickBooks" and bulk push fan out every payment of that invoice that has no synced mapping *after* the invoice syncs. The same fan-out runs after any successful invoice push in auto mode (catches payments recorded while the invoice push was still pending). Deletes propagate regardless of `push_mode` (like invoice void) and regardless of `push_payments`: once Breeze created a Payment in QuickBooks it owns its removal. `push_payments = false` → no new creates in any mode.
11. **Invoice void does not delete QuickBooks payments** (deviation from the brief; see below). Breeze's own void keeps its `invoice_payments` rows; QuickBooks' void leaves the Payment unapplied as customer credit. The two are symmetric, and deleting the Payment would assert that cash never arrived. The existing void job is unchanged; payment mappings stay valid. The pull's `markInvoiceDeletedRemotely` gains a guard: an invoice that Breeze itself voided is `invoice_void`, not "Deleted in QuickBooks" (Codex finding on the self-echo).
12. **Delete semantics.** `POST payment?operation=delete {Id, SyncToken}`. Exact "Object Not Found" / already-deleted → success. "Stale object" means the Payment still exists with a newer token: read it once, retry the delete once with the fresh token, then fail (retryable). Success removes the mapping row. Delete outcomes: `deleted | already_absent | nothing_owed | awaiting_remote_ref | unresolved_dropped`. The lease CAS and the sweep query are restricted to `breeze_entity_type = 'payment'`.
13. **Home currency only.** The coordinator asserts the invoice currency against the connection's home currency before any network call, exactly as `assertAccountingInvoicePushCurrency`; mismatch → mapping `error`, terminal.
14. **`voidPayment` refuses QuickBooks-origin payments at the service layer** (today only the UI hides the button). `listPayments` classifies `source = 'quickbooks'` only for `breeze_origin = false` mappings; Breeze-origin rows keep `manual` / `stripe` and gain `accountingSync: { status, lastError } | null` for a badge.
15. **#4542 fixed inline.** `recomputeInvoiceStatus` sets `paidAt = null` whenever the derived status is not `paid`; `voidInvoice`'s direct update also clears `paidAt`. `reflectStripeRefund`'s missing invoice lock stays tracked under #3803.

## Deviations from the brief (for Todd)

- **Invoice void leaves QuickBooks payments in place** (decision 11) rather than deleting them. Reason: deleting asserts the cash was never received; QuickBooks' own void leaves the Payment unapplied, which mirrors Breeze keeping its payment rows. Reverting to delete-then-void is a contained change in the void coordinator if Todd disagrees.
- **Partial refunds are flagged, not pushed** (decision 9). The brief left refunds "probably out of scope"; the quorum made it explicit and chose divergence over amount rewriting.
- **`push_payments` defaults on**, as the brief asked, but the release note must say so because it turns on outbound writes for every connected realm at deploy time.

## Data model

One migration, `apps/api/migrations/2026-10-05-100000-quickbooks-payment-push.sql` — renamed from `2026-10-02-110000-…` when `origin/main` gained four later-sorting migrations mid-branch (newest: `2026-10-04-100002-portal-users-contact-composite-fk.sql`). The ceiling moves while a branch is open, so the name is only correct relative to `origin/main` at merge time: re-run `scripts/check-migration-naming.sh --against-ref origin/main` after every fetch, not just before the first commit. Idempotent, no inner transaction, no `org_id` anywhere → no cascade, export-policy, or merge-registry changes. `check-migration-naming.sh` and `autoMigrate.test.ts` gate the name.

### `accounting_connections`

| Column | Type | Notes |
|---|---|---|
| `push_payments` | `boolean NOT NULL DEFAULT true` | settings PATCH (`INVOICES_WRITE` via `requireInvoicePushForSyncSwitches`), UI toggle beside `pull_payments` |

### `accounting_entity_mappings`

| Column | Type | Notes |
|---|---|---|
| `breeze_origin` | `boolean NOT NULL DEFAULT false` | migration backfills `true WHERE breeze_entity_type = 'invoice'`; push sets `true` on insert |
| `pending_op` | `text NULL CHECK (pending_op IN ('push','delete'))` | desired operation; `NULL` = nothing owed. Partial index `(partner_id, pending_op) WHERE pending_op IS NOT NULL` for the sweep |
| `claimed_at` | `timestamptz NULL` | worker lease (decision 2) |

The `payment` row shape is unchanged from Phase D: `breeze_entity_id = invoice_payments.id`, `remote_entity_id = '<PaymentId>/<remoteInvoiceId>'` once known (`NULL` while pending), `remote_sync_token`, `link_status`, `sync_status`. The partner guard trigger only fires on `INSERT` or `UPDATE OF partner_id, breeze_entity_type, breeze_entity_id`, so a row whose `invoice_payments` target has been deleted can legally carry `pending_op = 'delete'` until QuickBooks confirms. The partial unique index on `remote_entity_id` still admits many pending rows.

`invoice_payments` — no change. Payment rows stay free of external refs.

## Components

```
services/accounting/accountingPaymentPush.ts      pushPaymentToAccounting / deletePaymentInAccounting / requestPaymentPush / requestPaymentDelete
services/accounting/accountingPaymentPull.ts      adoption, breeze_origin rules, pull-disabled skip, self-void guard
services/accounting/quickbooksProvider.ts + types.ts   createPayment / deletePayment, PrivateNote on CDC payments
services/accounting/accountingInvoicePush.ts      fan-out of owed payments after a successful invoice push
jobs/accountingSyncWorker.ts                      job types push-payment / delete-payment
jobs/accountingReconcileWorker.ts                 pull||push gating; sweep re-enqueues stale pending_op rows
services/invoiceService.ts                        recordPayment/voidPayment hooks, paid_at fix, listPayments, void guard
services/stripeReconcile.ts                       recordStripePayment hook, full-refund delete, partial-refund divergence
routes/accounting/index.ts                        settings pushPayments; GET exposes it
web: QuickbooksIntegration.tsx, InvoiceDetail.tsx, invoiceTypes.ts, locales/*
docs: quickbooks-sandbox-verification.md (Phase D2 checklist, PENDING), release-notes draft
```

### Requesting a push or delete (inside the caller's transaction)

`requestPaymentPush(tx, { invoicePaymentId, invoiceId, partnerId })` is called by `recordPayment` and `recordStripePayment` **inside their locked transaction** after the payment insert. It is a no-op returning `false` unless the partner has a `connected` connection with `push_payments = true` and the invoice has a `synced` (or `synced_with_tax_variance`) `invoice` mapping with a remote id; in `push_mode = 'manual'` it also returns `false` (the manual fan-out covers it). Otherwise it inserts the `payment` mapping `{ breeze_origin: true, link_status: 'create_new', sync_status: 'pending', pending_op: 'push', remote_entity_id: null }` and returns `true`. The caller enqueues `push-payment { mappingId, partnerId }` after its transaction returns, fire-and-forget through the existing Redis-outage-safe helper. Inside a request context the transaction is a savepoint, so the worker may run before the commit: "mapping not found" is retryable, not terminal.

`requestPaymentDelete(tx, invoicePaymentId)` is called by `voidPayment` and `reflectStripeRefund` (full-refund arm) **before** the payment row is deleted, replacing today's `clearPaymentMappingForInvoicePayment` call for Breeze-origin rows: a Breeze-origin mapping with a remote id flips to `pending_op = 'delete'`, `sync_status = 'pending'`, `claimed_at = null` and is kept; a Breeze-origin mapping still `pending_op = 'push'` with no remote id is ALSO kept and flipped to `delete`, with `claimed_at` left as-is: a live lease means a worker may be between phase 1 and the QuickBooks call, and phase 2 must find the row to convert it (decision 7). The mapping-row INSERT trigger requires a live `invoice_payments` row, so a recovery row cannot be inserted after the fact; keeping the row is the only durable option. The delete worker, on a `delete` row with no remote id, releases the lease and returns `awaiting_remote_ref` (the pull's adoption fills the remote id into delete-pending rows too); if the row is older than 24 hours from its `created_at` (`PAYMENT_DELETE_UNRESOLVED_GRACE_MS`) it is dropped with a Sentry event and an `accounting.payment.delete_unresolved` audit entry (`unresolved_dropped`). QuickBooks-origin mappings are still cleared as Phase D does (the pull's reversal path owns those rows). Returns the mapping id for the post-transaction enqueue.

### Coordinator (`accountingPaymentPush.ts`)

Both entry points take `(mappingId, partnerId, runInDbContext: DbContextRunner)`, call `assertNoAmbientDbContext`, and follow the Phase C phase split.

`pushPaymentToAccounting`:
1. **Phase 1** (one runner call): lease CAS (decision 2) → `sync_in_progress` (retryable) on zero rows; load connection (`connected`, `push_payments` true — else release lease, `push_disabled`, terminal, mapping left pending with `pending_op` cleared and `last_error` "Payment push is disabled"); load the payment and its invoice (payment gone → flip to `delete` if a remote id exists, else delete the mapping, return `payment_gone`); invoice `invoice` mapping must be synced with a remote id (else `invoice_not_synced`, retryable — the fan-out after the invoice push will catch it); org `Customer` mapping must be confirmed (`customer_not_mapped`, terminal); currency assertion (terminal). Build the payload.
2. **Token, then QBO** with nothing held: `resolveLiveConnection`, `runOutsideDbContext(() => provider.createPayment(liveConn, payload))`.
3. **Phase 2** (one runner call, invoice `FOR UPDATE` first): re-read the mapping and the payment row per decision 7; on the normal path stamp `remote_entity_id = '<PaymentId>/<remoteInvoiceId>'`, `remote_sync_token`, `sync_status = 'synced'`, `link_status = 'confirmed'`, `pending_op = null`, `claimed_at = null`, `last_synced_at`. If the echo already adopted (remote id equal) keep the stored token. Audit `accounting.payment.pushed` (`resourceType: 'invoice'`, details: provider, invoicePaymentId, remotePaymentId, amount, currency). Zero rows → `record_failed`, terminal.
4. Any QBO failure → `markPaymentMappingErrorInOwnContext` (sanitized message `QuickBooks rejected the payment sync (HTTP n)`, `claimed_at = null`, `pending_op` kept so the sweep retries) then rethrow as `quickbooks_error` 502.

`deletePaymentInAccounting`: lease CAS → load the mapping. A lost CAS on a row that no longer owes a delete (another worker finished it, or the flip never happened) is `nothing_owed`, not an error; a lost CAS on a row that still owes one is `sync_in_progress`, retryable. A row that owes a delete but has NO remote id is the void-during-an-in-flight-push case: whether a QuickBooks Payment exists is unknowable from here (the create may have succeeded with a response Breeze never saw) and `PrivateNote` is not queryable, so there is no recovery query — the coordinator releases the lease and returns `awaiting_remote_ref`, waiting for the CDC pull to adopt the Payment and fill the id in, after which the sweep re-enqueues this job. Past `PAYMENT_DELETE_UNRESOLVED_GRACE_MS` (24 h, measured on `created_at` — the lease CAS bumps `updated_at` on every attempt, so an age measured on that would never expire) nothing will resolve it: the row is dropped and the loss is made loud with `unresolved_dropped` + `captureException` + an `accounting.payment.delete_unresolved` audit entry, because a QuickBooks Payment may now be orphaned and only a human can reconcile it. With a remote id present: `provider.deletePayment(liveConn, { remotePaymentId, syncToken })` with the stale-token retry of decision 12 → delete the mapping row in its own context → audit `accounting.payment.deleted`. Failure stamps `last_error`, releases the lease, rethrows.

`fanOutOwedPayments(invoiceId, partnerId, runInDbContext)` is called by `pushInvoiceToAccounting` after `persistInvoiceRemoteRef` succeeds (all modes): for every `invoice_payments` row of the invoice with no mapping, insert the pending `push` mapping (respecting `push_payments`) and enqueue. In manual mode this is the only way payments reach QuickBooks.

Payload (`AccountingPaymentPayload`): `invoicePaymentId, remoteCustomerId, remoteInvoiceId, amount (string, 2dp), currencyCode, txnDate (receivedAt), reference (≤ 21 chars), privateNote`. Provider body: `CustomerRef`, `TotalAmt`, `TxnDate`, `PaymentRefNum`, `PrivateNote`, `Line: [{ Amount, LinkedTxn: [{ TxnId, TxnType: 'Invoice' }] }]`; no `CurrencyRef`, no `DepositToAccountRef`, no `PaymentMethodRef` (mapping Breeze methods to QBO PaymentMethod entities needs a PaymentMethod list; out of scope, noted). Over-application (amount above the QuickBooks invoice balance) is rejected by QuickBooks → terminal `quickbooks_error` with the sanitized message; Breeze already tolerates over-payment locally, so the sandbox checklist exercises it.

`accountingInvoicePushCallSites.test.ts` widens to `{ pushInvoice: 1, voidInvoice: 1, createPayment: 1, deletePayment: 1 }`, all inside the two coordinators.

### Pull changes (`accountingPaymentPull.ts`, `quickbooksProvider.ts`)

- `QboRawCdcPayment` gains `PrivateNote`; `ChangeSetPaymentLine` gains `breezePaymentId: string | null`, parsed with an anchored grammar `^Breeze payment ([0-9a-f-]{36})$` (whole-note match only; anything else is `null`).
- `applyAccountingPayment`, under the invoice lock, after the authoritative mapping read:
  - mapping exists and `breeze_origin` → decision 5 (`replayed` / `breeze_origin_diverged`).
  - no mapping by remote id but `breezePaymentId` set → look up the mapping by `(integration_id, 'payment', breezePaymentId)`: pending with `NULL` remote id, `pending_op = 'push'`, payment row exists on *this* locked invoice, amount equal → fill remote id + token, `synced`, `pending_op = null`, `claimed_at = null` → `adopted` (audited). Any guard fails → `skipped_breeze_origin` (no insert; the push or delete job owns the outcome).
  - no mapping, no marker, `pull_payments = false` → `skipped_pull_disabled`.
- `reverseAccountingPayment` / `reverseStaleAllocations`: Breeze-origin rows → mapping `error` "Deleted in QuickBooks" with `remote_entity_id = null`, `remote_sync_token = null`, payment row untouched, outcome `breeze_origin_removed_remotely`; QuickBooks-origin rows unchanged.
- `markInvoiceDeletedRemotely`: invoice already `void` in Breeze → `invoice_void`, no error stamp.
- All new outcomes are added to `PaymentPullOutcome` and the worker's tally; `adopted` and `breeze_origin_removed_remotely` are clean for the cursor, `breeze_origin_diverged` is clean too (it is a recorded error, not a failed step).

### Workers

- `accountingSyncWorker.ts`: job union gains `push-payment { type, mappingId, partnerId }` and `delete-payment { type, mappingId, partnerId }`; jobId `accounting-payment-<mappingId>-push|delete`; same opts (`attempts: 5`, exponential 5 s, `removeOnComplete/Fail: true`). The `pushMode !== 'auto'` gate applies only to `push-invoice` (unchanged); payment jobs are gated by the coordinator. Terminal codes: `push_disabled`, `customer_not_mapped`, `currency_mismatch`, `record_failed`, `payment_gone`. No new worker → `workerRegistry.test.ts` count stays 123.
- `accountingReconcileWorker.ts`: gate becomes `conn.pullPayments || conn.pushPayments`; the sweep additionally enqueues `push-payment` / `delete-payment` for every mapping with `pending_op IS NOT NULL AND (claimed_at IS NULL OR claimed_at < now() − 10 min) AND updated_at < now() − 2 min` (one short system context, then Redis with nothing held). Sweep runs even when both switches are off for `delete` rows (decision 10).

### Settings, routes, web

- `settingsSchema` + `requireInvoicePushForSyncSwitches` gain `pushPayments`; `GET /:provider` returns it.
- `QuickbooksIntegration.tsx`: "Push payments to QuickBooks" toggle (`quickbooks-pushpayments`) beside the pull toggle, `runAction`.
- `InvoiceDetail.tsx`: payment rows show an "In QuickBooks" badge when `accountingSync.status === 'synced'`, a warning badge with `lastError` when `error`, and a muted "Syncing…" when pending. The void button is unchanged: it shows only for `manual` rows. It was already hidden for `stripe` (refunds go through Stripe, never a hand-void) and stays hidden for `quickbooks` (reversing a pulled payment here would not touch the books, and the next reconcile would pull it straight back in). A Breeze-origin `stripe` payment is therefore removed from QuickBooks by a Stripe refund, not by a void button.
- All copy through `t(...)`; keys in every locale dir with genuine translations.

## Multi-tenancy / RLS

No new tables. Both touched tables are partner-axis and already RLS'd; no `org_id` → no cascade, export-policy, or merge-registry changes. `requestPaymentPush` / `requestPaymentDelete` run inside the caller's authed or system transaction; the coordinator and workers run system context, and every mapping write carries the connection's `(integration_id, partner_id)` enforced by the composite FK. `partner-wide-write-coverage.test.ts` gains one exemption line for `accountingPaymentPush.ts` (worker-driven, no tenant caller), mirroring the Phase D line.

## Observability

Audit: `accounting.payment.pushed`, `accounting.payment.deleted`, `accounting.payment.adopted`, `accounting.payment.diverged`. Worker log line per job: mappingId, op, outcome, duration. Sentry on terminal failures with `service: 'accountingPaymentPush'`, never a QBO body. Reconcile summary gains the new outcome counters and the sweep logs how many stale `pending_op` rows it re-enqueued.

## Testing

- **Unit:** provider `createPayment` body and `deletePayment` stale-token retry; coordinator phase matrix (lease contention, push disabled, invoice not synced retryable, customer not mapped terminal, currency mismatch, payment gone before/after the QBO call, echo-adopted before phase 2, amount changed before phase 2); `requestPaymentPush` gating (mode, switch, invoice mapping state); `requestPaymentDelete` (push-pending vs synced vs QuickBooks-origin); pull branches (`adopted`, `replayed` on token bump with equal amount, `breeze_origin_diverged`, `skipped_breeze_origin`, `skipped_pull_disabled`, Breeze-origin reversal leaves the row); `markInvoiceDeletedRemotely` self-void guard; sweep re-enqueue query; `recomputeInvoiceStatus` clears `paid_at`; `voidPayment` refuses QuickBooks-origin.
- **Integration (real Postgres):** record → mapping pending in the same transaction; push phase 2 stamps the composite remote id; echo after phase 2 replays; echo before phase 2 adopts and phase 2 keeps the token; void after push flips to delete-pending and the row survives an enqueue failure; sweep picks it up; cross-partner mapping forge rejected; Breeze-origin CDC delete leaves `invoice_payments` intact; `paid_at` cleared after reversal.
- **Contract suites run:** `workerRegistry`, `workerEntrypointClosure`, `accountingInvoicePushCallSites`, `partner-wide-write-coverage`, `rls-coverage`, `db:check-drift`, `autoMigrate.test.ts`, migration-naming guard, web `no-silent-mutations`, `translationCoverage`.
- **Sandbox walkthrough** (`docs/integrations/quickbooks-sandbox-verification.md`, new `### Phase D2 checklist (payment push)` starting at item 27, left PENDING for Todd): re-register the Development webhook (#4545); manual payment → QBO Payment applied, invoice balance drops; webhook echo → `replayed`, one row; Stripe test payment (gross) → same; void in Breeze → deleted in QBO, mapping gone; delete the QBO Payment by hand → Breeze row intact, mapping error, re-push works; edit the amount in QBO → diverged error; `push_mode = manual` → nothing pushed until the invoice push button, then payments follow; `push_payments` off → no create, but a void still deletes; over-application rejected with a readable error; void a paid invoice → QBO invoice void, Payment left unapplied; kill the API between create and phase 2 → sweep adopts within 15 min.

## Out of scope (named)

- QuickBooks `RefundReceipt` / credit memos; partial refunds are flagged as divergence (decision 9).
- Deleting QuickBooks payments on invoice void (decision 11).
- `PaymentMethodRef` mapping and `DepositToAccountRef` selection.
- Stripe fee expense entries.
- Foreign-currency payments.
- `reflectStripeRefund` invoice lock (#3803), #4543 beyond the pull-disabled reason, #4544.

## Next step

`writing-plans` for this spec: migration + schema → provider methods → request helpers + invoiceService/stripeReconcile hooks + paid_at fix → coordinator → worker job types + reconcile gating/sweep → pull changes → settings/web → docs + release note + sandbox checklist. Red-first per task, integration suite on real Postgres, one review round, PR, stop.
