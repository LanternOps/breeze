# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.109.0** (2026-09-01).

---

## QuickBooks payment pull-back (#4531, sandbox-verified in #4537)

**Self-Hosting / Upgrade Notes**

- New optional env var `QBO_WEBHOOK_VERIFIER_TOKEN` (Intuit app → Webhooks →
  verifier token). Map it in the `api` service's compose `environment:` block
  as well as `.env`. Without it, `POST /api/v1/webhooks/quickbooks` answers
  `503` on every delivery so Intuit keeps retrying; nothing else breaks.
- New route `POST /api/v1/webhooks/quickbooks` (Intuit-signed, rate-limited);
  register it as the app's webhook endpoint with the Invoice and Payment
  event groups. Intuit allows one endpoint per app.
- New BullMQ worker `accounting-reconcile` with a 15-minute repeatable sweep;
  it is the guaranteed path (webhook is only a latency optimisation). Worker
  count goes up by one.
- New per-connection setting `pull_payments` (default **on**) and a
  "Payment sync / Sync now" control on the QuickBooks integration card;
  requires `invoices:write`.
- Migration `2026-10-01-quickbooks-payment-pullback.sql` (adds
  `realm_id_fingerprint`, `cdc_cursor`, `pull_payments` to
  `accounting_connections`; boot-time fingerprint backfill).

**Hosted rollout TODO (Step 6, after `up -d api` in each region)** — one-off,
delete once done:

- [ ] US: the production verifier token, production `QBO_*` keys and
      `QBO_ENVIRONMENT=production` were pre-staged in `.env` + compose on
      2026-09-02 and take effect on this deploy. Verify the token mapped
      through: `curl -s -o /dev/null -w '%{http_code}' -X POST
      https://us.2breeze.app/api/v1/webhooks/quickbooks -H
      'intuit-signature: bogus' -d '{}'` must print **401** (503 = token not
      mapped, 404 = old image still running).
- [ ] EU: production `QBO_*` keys pre-staged the same day; no webhook token
      by design (one endpoint per app, EU relies on the sweep). Expect
      **503** from the same curl against `eu.2breeze.app`.
- [ ] Both regions: confirm `[AccountingReconcileWorker] Accounting reconcile
      worker initialized` and the realm fingerprint backfill line in the API
      log after boot.
- [ ] The first partner to connect QuickBooks in prod is the first OAuth
      against the production keys and the Production redirect URIs
      (registered 2026-09-02) — watch that callback.

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
- Migration `2026-10-05-100000-quickbooks-payment-push.sql` adds
  `accounting_connections.push_payments` and four columns on
  `accounting_entity_mappings` (`breeze_origin`, `pending_op`, `claimed_at`,
  `sync_attempts`), one CHECK constraint and one partial index. It backfills `breeze_origin = true`
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
- A payment push that keeps failing now GIVES UP after 20 attempts (about five
  hours of 15-minute sweeps) instead of retrying forever: the mapping reads
  `QuickBooks payment push gave up after 20 attempts: <reason>. Fix the cause and
  push the invoice again.`, and the invoice's "Push to QuickBooks" button clears
  the counter and tries again. A pending DELETE is never capped — once Breeze
  created a Payment in QuickBooks it owns the removal.
- The reconcile sweep's gate widened from `pull_payments` to
  `pull_payments OR push_payments`, so a realm with pull off and push on now
  runs the CDC pass (it suppresses new QuickBooks-origin imports, logging
  `skipped_pull_disabled` once per run).
- Fixes #4542: `invoices.paid_at` is now cleared whenever an invoice falls out
  of `paid` (a voided payment, a QuickBooks reversal, a refund) and on void.
  Existing rows are NOT retro-corrected; the next recompute of an affected
  invoice fixes it.
- **Rollout note:** the sandbox walkthrough for this feature has NOT been run.
  `docs/integrations/quickbooks-sandbox-verification.md` carries a
  `### Phase D2 checklist (payment push)` section, items 27-40, all PENDING;
  item 27 (re-register the Intuit Development webhook, #4545) gates the rest.
  Treat the first production realm to record a payment as the live walk.
