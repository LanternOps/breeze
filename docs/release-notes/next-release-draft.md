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

## Contract lines billed by device role (#3205)

**Self-Hosting / Upgrade Notes**

- Migration `2026-10-05-100100-contract-lines-device-roles.sql` replaces the
  `contract_lines.site_id` foreign key with a composite one to `sites(id, org_id)`.
  Before adding it, it **clears `site_id` on any contract line whose site belongs
  to a different organization** (such lines silently counted zero devices before).
  The count is logged as a Postgres `WARNING` (`cleaned N contract_lines rows whose
  site belonged to another org`); if N > 0, re-scope those lines in the contract
  editor before the next billing run.
- Adding a contract line with a site from another organization now returns
  `400 SITE_NOT_IN_ORG` instead of being accepted.
- New billing-worker log line
  `[contract-billing] uncovered devices: contract <id> has N billable device(s) no line bills — {...}`
  fires on every sweep for role-billed contracts that have unclassified (`unknown`)
  devices or roles no line covers. Informational: classify the devices or add a line.

**Behaviour**

- New contract line type **Per device role** bills a set of device roles (e.g.
  switch + router + firewall). `unknown` is never billable. Contract estimates and
  generated invoices now report how many devices no line bills, by role.
- New contract line type **Per device group** bills the members of a device group. Dynamic groups are evaluated live at estimate and invoice time; a group billed by a draft, active or paused contract cannot be deleted until the line is removed; a group deleted after a contract ended stays on that contract's lines by name.

### Contract line editing (W03)

**Behaviour**

- Contract lines are now **editable in place** on draft and active contracts
  (`PATCH /api/v1/contracts/:id/lines/:lineId`, and the AI `manage_contracts`
  action `update_line`). The line keeps its id, so an already-generated draft
  invoice stays linked to it — deleting and re-adding a line used to wedge that
  invoice with `SOURCE_NOT_FOUND` on issue. The **line type** cannot be changed;
  remove the line and add a new one.
- All three line mutations now write audit events: `contract.line.added`,
  `contract.line.updated`, `contract.line.removed` (resource type `contract`,
  resource id the contract). The payload carries the line id, the line type, the
  names of the changed columns and, for a price change, the old and new unit
  price — no descriptions, site names or group names.

**Self-Hosting / Upgrade Notes** — four deliberate behaviour changes, no migration:

- Generated invoice lines now use deterministic `(sortOrder, createdAt, id)` ordering; lines tied on `sortOrder` may appear in a different order.
- `DELETE /api/v1/contracts/:id/lines/:lineId` now returns **404
  `LINE_NOT_FOUND`** for a line that does not exist (previously a silent 200),
  and its success body is `{"data":{"ok":true}}` (previously `{}`).
- `unitPrice`, `manualQuantity` (max 10 digits before the decimal point) and
  `sortOrder` (max 2147483647) bounds now apply on line **create** as well as
  update. Input that previously reached Postgres and returned a 500 is now a 400.
- A stale or foreign `catalogItemId` when **adding** a line is now
  `400 CATALOG_ITEM_NOT_FOUND` instead of a 500.

## Partner trust probation (hosted abuse control) — breeze #4567 → #4588 → #4599 → #4603 → #4602 → #4604, breeze-billing #16 + #17

Only fold this in once the whole chain above is merged. It is one feature in
seven stacked PRs; a partial merge ships columns and a flag with nothing
reading them, which is safe but not worth announcing.

**Summary (operator-facing)**

New hosted self-serve partners start in **probation**: they can enrol up to 5
devices and see inventory, patching and alerts, but remote control, script and
command execution, and installer distribution (links, short-links, onboarding
tokens, Quick Support codes, third-party remote launch) are refused until a
settled 3DS card payment has aged 24 hours or a platform admin approves them
from an evidence-card email or the new **Admin → Trust queue** page. Existing
partners are grandfathered (`trust_state` defaults to `trusted`). Suspicious
signups (Tor, card fingerprint or fraudulent-refund identity match, shared
network **plus** a corroborating axis) are auto-restricted, never
auto-suspended.

**Self-Hosting / Upgrade Notes**

- **No action needed for self-hosters.** `PARTNER_TRUST_MODE` resolves to
  `off` unless `IS_HOSTED=true`, regardless of its value; with it off no new
  code path performs a database read, Redis call or network call, and every
  gate is a no-op. The guided-setup smoke job asserts a fresh self-hosted
  stack can still open a remote session.
- Migration `2026-10-03-partner-trust-probation.sql`: adds enums
  `partner_trust_state`, `ip_class`; `partners.trust_state` (default
  `trusted`), `trust_changed_at/by`, `trust_reason`,
  `trust_review_requested_at`, `probation_enrollments`,
  `signup_ip_class/asn/classified_at`; `devices.enrollment_ip_class/asn/
  classified_at`; one partial index. Idempotent, no backfill, no table
  rewrite.
- New **optional** env vars (missing = feature off / fallback; never fail
  boot; map in the `api` compose `environment:` block when set):
  `PARTNER_TRUST_MODE` (`off | shadow | enforce`; hosted default `shadow`),
  `IP_CLASSIFY_PROVIDER` (`ipinfo | ipdata | none`), `IP_CLASSIFY_API_KEY`,
  `TRUST_ACTION_TOKEN_SECRET` (falls back to `JWT_SECRET`),
  `PARTNER_MEETING_URL` (shown on the probation banner).
- New BullMQ jobs on the existing `abuse-signals` queue: `ip-classify`
  (event-driven) and `partner-trust-promote` (every 15 min). The
  `abuse-signals-sweep` cadence changes from hourly to every 15 minutes
  (`22,37,52,7 * * * *`).
- New audit actions: `partner.trust.probation`, `partner.trust.promoted`,
  `partner.trust.restricted`, `partner.trust.review_requested`,
  `partner.trust.capability_denied` (details carry `mode`, `capability`,
  `reason`, `route`).
- New routes: `GET /partner/trust`, `POST /partner/trust/request-review`
  (partner scope); `POST /admin/partners/:id/trust/promote|restrict`,
  `GET /admin/trust/queue`, `GET /admin/trust/act/preview`,
  `POST /admin/trust/act` (platform admin + MFA). Web: `/admin/trust-queue`,
  `/admin/trust/act`.
- Gated 403 bodies use a stable contract
  `{ error: 'TRUST_PROBATION' | 'TRUST_RESTRICTED', capability, reason,
  reviewRequested, meetingUrl }`; the web app turns them into the
  "Verification pending" banner instead of a generic error toast.
- breeze-billing (rebuild the `billing` container on each droplet): signup
  Checkout is now **card-only with 3DS requested** (Link disabled — every
  fraudulent capture to date arrived via Link); two new internal endpoints
  `GET /internal/partners/:id/settled-card-charge` and
  `…/fraudulent-refund-match`; one new idempotent index on `billing_events`.

## Device billing coverage and coverage-notice deep links (#3205 W06)

**Self-Hosting / Upgrade Notes**

- No migration, no schema change, no new env var, no feature flag.
- New route `GET /api/v1/devices/:id/billing`, gated on **partner or system**
  scope plus **both** `devices:read` and `contracts:read`. API keys cannot reach
  it: there is no `contracts:read` API-key scope.

**Behaviour worth naming so it is not read as a bug**

- The device Overview **Billing** card needs Contracts read access and a
  partner-scoped login; organization-scoped users do not see it, matching every
  other contracts screen.
- The card counts **active** contracts only, so a device covered by a *draft*
  contract still reads "no active contract line bills this device" until the
  contract is activated.
- A deep link from a contract's coverage warning carries its organization, so a
  pasted link switches the recipient's org scope to the contract's org.

**Hosted rollout TODO (one-off, delete once done)**

- [ ] Deploy billing first (both regions), then the API/web images.
- [ ] Grant `is_platform_admin = true` to the operator account — production
      has none, and the trust queue page and the email action links require
      it.
- [ ] Leave `PARTNER_TRUST_MODE` at its `shadow` default for 7 days; new
      signups enter probation but nothing is denied. Run
      `apps/api/scripts/partner-trust-shadow-report.sql` (as `doadmin`, with
      `SET breeze.scope = 'system'`) and check the acceptance rule in the
      header.
- [ ] Set `PARTNER_TRUST_MODE=enforce` + compose mapping, `up -d api`; then
      run `apps/api/scripts/partner-trust-backfill.sql` (dry-run first) and
      the `partner-trust:backfill-cards` hand-off documented in its header.
- [ ] Optional: set `IP_CLASSIFY_PROVIDER`/`IP_CLASSIFY_API_KEY` so
      auto-promotion can run; without them signups classify as `unknown` and
      promotion is manual only.

## Contract line included quantity and overage (#3205 W04)

**Contracts: included quantity and overage.** A per-device, per-device-role, per-device-group or per-seat contract line can now include a fixed quantity (for example "up to 25 devices included") and either bill the extras at a second rate or flag them for review. A billed overage becomes its own line on the invoice, directly under the line it belongs to, so the customer sees the count and the rate. A flagged overage is never invoiced silently: it shows on the contract estimate, on the result of Generate now, and in the nightly billing log.

## Device-set quote lines (#3205 W05, #4693)

**Billing by a device set on quotes.** A recurring quote line can now price every device, selected device roles, one device group, or active users. Breeze supplies the quantity, including zero for a new customer with nothing enrolled. The customer document labels the number as an estimate and explains that billing uses the actual count each period. Accepting the quote creates the matching auto-quantity contract line and freezes the unit price the customer accepted.

Counts update when a line is added or its device-set or allowance settings are edited, or when an operator refreshes a draft. The estimate endpoint is read-only. Sending reports count drift but does not change the approved quote, and acceptance does not refresh the estimate. A device group priced by a draft, sent, or viewed quote cannot be deleted until the quote line is removed.

**Site deletion now fails loudly (#4693).** From this release, deleting a site used by a site-scoped contract line makes invoice generation refuse with 409 `SITE_DELETED` instead of silently billing every device in the organization. This is intentionally louder than the old behavior. An operator who deletes a site under an active contract now gets a failed generation and a Sentry report where an inflated invoice could previously go unnoticed. Re-scope or remove the affected line before generating again.

There is one accepted residual. A line whose site was deleted before this release has no recoverable site name, so it remains ambiguous and continues billing organization-wide until a technician re-scopes it. Operators who suspect an affected contract can look for a `per_device` line with no site on a contract that used to have one. The migration's `RAISE WARNING` row count records how many existing lines were protected by the site-name backfill.

**Direct API and AI clients.** `PATCH /quotes/:id/lines/:lineId` now returns 400 for an unrecognized key instead of accepting the request while changing nothing.

There is no feature flag and no acceptance-hash backfill. `quote_acceptances.hash_version` defaults to `1`, so every signature already on file continues to verify with the exact algorithm that produced it. New acceptances use hash version 2.
- **Billing evidence per invoice.** Contract-generated invoices now record the exact devices behind every auto-counted line, at generation time, and each billed period records what it did *not* bill (uncovered devices by role, flagged and billed overage totals). Expand any counted line on the invoice detail to see the devices; a device deleted or moved later still appears by hostname. An optional "Billed devices" appendix can be printed on the invoice PDF -- off by default, set per partner or per draft invoice, and frozen once the invoice is issued. Invoices generated before this release have no device detail and say so; there is no backfill, because the device set was never stored to backfill from.
