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
