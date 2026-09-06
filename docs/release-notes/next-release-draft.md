# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.110.0** (2026-09-05).

---

## QuickBooks payment push (#4624)

Payments recorded in Breeze against an invoice that is already in QuickBooks are
now created in QuickBooks automatically, and deleted there when the Breeze
payment is voided or fully refunded. Breeze stays the system of record for its
own payments: a payment edited in QuickBooks is flagged as diverged rather than
silently overwritten in Breeze, and a partial Stripe refund is flagged for the
bookkeeper instead of rewriting a QuickBooks receipt.

**Self-Hosting / Upgrade Notes**

- **This turns ON outbound writes to QuickBooks for every connected realm at
  deploy time.** The new `accounting_connections.push_payments` column defaults
  to `true`, so a realm that is connected and in `push_mode = auto` starts
  creating QuickBooks Payments as soon as the API restarts — no operator action
  required to switch it on, and no per-realm opt-in. Set it to `false` first
  (Integrations → QuickBooks → "Push payments to QuickBooks") on any realm whose
  books you are not ready to have Breeze write into.
- Deleting a payment propagates regardless of BOTH `push_mode` and
  `push_payments`: once Breeze created a Payment in QuickBooks it owns its
  removal, so switching the feature off cannot strand money in the books.
- Migration `2026-10-12-100000-quickbooks-payment-push.sql` adds
  `accounting_connections.push_payments` and five columns on
  `accounting_entity_mappings` (`breeze_origin`, `pending_op`, `claimed_at`,
  `sync_attempts`, `push_generation`), one CHECK constraint and one partial index. It backfills `breeze_origin = true`
  for existing invoice mappings under `set_config('breeze.scope','system', true)`
  and logs the row count as a `WARNING`. No new tables, no RLS changes.
- New per-connection setting `push_payments` (default **on**) beside the
  existing `pull_payments` toggle on the QuickBooks integration card, and an
  "In QuickBooks" / "QuickBooks sync failed" / "Syncing…" badge on each payment
  row of an invoice.
- **No new worker and no new queue.** Two job types (`push-payment`,
  `delete-payment`) ride the existing `accounting-sync` queue, so the worker
  count is unchanged. The mapping row itself is the outbox: `pending_op` is
  written in the SAME transaction as the payment insert/delete, and the existing
  15-minute `accounting-reconcile` sweep gained a second pass that re-enqueues
  any mapping still owing QuickBooks work. A Redis outage therefore delays a
  push by at most one sweep — it never loses one.
- A payment push that keeps failing now GIVES UP after 100 attempts instead of
  retrying forever: the mapping reads `QuickBooks payment push gave up after 100
  attempts: <reason>. Fix the cause and push the invoice again.`, and the
  invoice's "Push to QuickBooks" button clears the counter and tries again. An
  attempt is one job try, not one sweep — the queue retries a failure five times
  per enqueue and the reconcile sweep re-enqueues every 15 minutes — so the
  practical horizon is about 20 sweeps, roughly five hours. A pending DELETE is
  never capped: once Breeze created a Payment in QuickBooks it owns the removal.
- Re-pushing a payment after somebody **deleted the QuickBooks Payment by hand**
  now actually creates a new one. QuickBooks replays a create's original
  response for a repeated `requestid` for 24 hours, so the retry key can no
  longer be the payment id alone: each time the invoice fan-out re-owns a
  mapping for a fresh create it bumps `push_generation` and the key becomes
  `<payment id>:g<n>`. It still never changes across retries of the same push,
  so a lost response cannot double-book the customer. Previously the re-push
  reported success and re-linked the mapping to the deleted Payment, leaving the
  invoice balance wrong in QuickBooks with no error shown.
- The reconcile sweep's gate widened from `pull_payments` to
  `pull_payments OR push_payments`, so a realm with pull off and push on now
  runs the CDC pass (it suppresses new QuickBooks-origin imports, logging
  `skipped_pull_disabled` once per run).
- Re-pushing an invoice after payment activity no longer fails with a stale
  SyncToken. QuickBooks bumps an Invoice's `SyncToken` every time a payment is
  applied to it or removed, so the token Breeze stored at push time went stale
  without Breeze ever writing the invoice again — "Push to QuickBooks" then
  failed with `QuickBooks rejected the invoice sync (HTTP 400)` and parked the
  mapping in `error`, which in turn blocked the payment fan-out with
  `invoice_not_synced`. Breeze now re-reads the live revision on a QuickBooks
  `Stale Object` fault and retries the update once. Pre-existing since Phase C,
  so this also fixes it on v0.110.0.
- Fixes #4542: `invoices.paid_at` is now cleared whenever an invoice falls out
  of `paid` (a voided payment, a QuickBooks reversal, a refund) and on void.
  Existing rows are NOT retro-corrected; the next recompute of an affected
  invoice fixes it.
- **Rollout note:** the sandbox walkthrough for this feature has NOT been run.
  `docs/integrations/quickbooks-sandbox-verification.md` carries a
  `### Phase D2 checklist (payment push)` section, items 27-42, all PENDING;
  item 27 (re-register the Intuit Development webhook, #4545) gates the rest.
  Treat the first production realm to record a payment as the live walk.
