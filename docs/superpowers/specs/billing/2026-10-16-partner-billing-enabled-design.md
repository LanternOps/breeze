# Partner billing toggle (`billingEnabled`) — Design Spec

**Status:** Revised after second maintainer review (CHANGES_REQUESTED on PR #8916, 2026-10-18), with the corrections of the 2026-10-20 review. Awaiting re-review.
**Discussion:** LanternOps/breeze#8807 ("Add a Native RMM + Ticketing Mode Without Billing").
**Maintainer decisions:** Discussion #8807 comment (2026-10-15) and PR #8916 reviews by @ToddHebebrand (2026-10-17, 2026-10-18).

---

## 1. Summary

Partners can run Breeze for RMM and ticketing without Breeze billing, and bill through Breeze without
Breeze tickets. A partner-level `billing_enabled` flag controls billing independently of
`service_management_mode`. The mode decides only where tickets live.

## 2. Background

`service_management_mode` (`native`, `external`, `off`) decides where tickets live. Today the web UI also
uses it to hide billing, and the billing backend does not check it at all. So hiding in the UI does not stop
billing work:

- `apps/web/src/lib/navGates.ts`: the `requiresModule: 'service_management'` key is shared by the Service Desk
  and Billing entries and shows them only when the mode is `native`.
- `apps/web/src/components/layout/Sidebar.tsx`: the Billing section carries the same `requiresModule`, and the
  section-level gate hides it unless the mode is `native`.
- `apps/web/src/components/organizations/record/orgRecordTabs.ts`: the org Billing tab is part of the
  service-management tab derivation.
- `apps/api/src/routes/orgAccountReadiness.ts`: `invoices` and `contracts` readiness use `native`; `tickets`
  also uses `native` and stays that way.
- `apps/api/src/services/tenantCascade.ts`: forced PSA un-wires reset `service_management_mode` to `native`.

## 3. Maintainer decisions

These are the maintainer's answers. They are not proposals from this spec.

3.1. A partner-level flag, no fourth value in `service_management_mode`, default on for new rows, no
organisation override (#8807, 2026-10-15).

3.2. Billing is allowed under every mode: all six combinations of mode × `billing_enabled` are valid (PR #8916, Q1).

3.3. Gating is on `billing_enabled` alone, never on mode, for billing routes and billing UI (PR #8916, Q3).

3.4. Existing partners are backfilled, not given a plain default (PR #8916, Q2). See §5.

3.5. No automatic re-coupling of billing to mode. The earlier §4.1 rule for `off` is removed (PR #8916, Q4).
The two settings sit side by side so the state is visible when the mode changes.

3.6. Setting home: Partner Settings → Modules, next to the mode selector in `PartnerModulesCard.tsx`, saved on
change like the rest of that card. There is no "Service Management" tab.

3.7. Scheduled work must stop, not just be hidden. A route 404 does not stop invoices being generated, sent or
charged (PR #8916, 2026-10-17, must-fix).

3.8. Issued invoices stay payable through public pay links, the Stripe webhook keeps reconciling, PDF rendering
for existing documents keeps running, and the portal keeps read-only history. The MSP's own Breeze subscription
is out of scope (PR #8916, 2026-10-17).

3.9. `/tickets/:id/invoice` creates invoices, so it is gated, not exempted (PR #8916, 2026-10-17).

3.10. Turning billing off must not turn off staff's ability to stop autopay. The turn-off direction of
`PATCH` on autopay stays open (PR #8916, 2026-10-18).

3.11. Proposal, not a maintainer decision: customers can always stop autopay, even with billing off. Confirm in review.

3.12. `tenantCascade` forced PSA un-wires must **not** change `billing_enabled`. Automatic re-enabling was ruled
out (PR #8916, 2026-10-18, §9.2).

## 4. Configuration (CLAUDE.md rule 9)

- **Home:** Partner Settings → Modules (`apps/web/src/components/settings/PartnerModulesCard.tsx`).
- **Level:** partner only. No organisation override.
- **Resolver:** the partner value. No cascade.
- **Places the billing concept is configured, before / after:** 1 → 1 (count as stated by the maintainer, PR #8916, 2026-10-18).

## 5. Migration

Order matters so that a re-run keeps an admin's change (PR #8916, 2026-10-18):

5.1. Add `partners.billing_enabled boolean` as **nullable**.

5.2. Backfill, only rows where the value is still NULL:

- `true` when `service_management_mode = 'native'`, **or** the partner has live billing: active contracts,
  unpaid invoices, or autopay enrolments.
- `false` for every other partner.

5.3. Set `DEFAULT true` and `NOT NULL`.

5.4. The backfill writes rows, so the migration sets `SELECT set_config('breeze.scope', 'system', true);` before
its DML, as the other data migrations in `apps/api/migrations/` do.

5.5. `partners` has no `org_id`, so it needs no `tenantCascade` or export-policy entry of its own.

5.6. A column, not a JSON field in `partners.settings`, because the gates and the job predicates query it.

## 6. Scheduled jobs

Gating happens **per partner inside each job's due-rows query**, the same way
`buildAutomationEligibleOrgPredicate` does, not by stopping the whole job. Behaviour with `billing_enabled = false`:

| Job | Behaviour with billing off |
|---|---|
| `invoiceWorker` → `render-pdf` | **Keep.** PDFs of existing documents. |
| `invoiceWorker` → `overdue-sweep` | **Keep.** Status of existing invoices. |
| `contractWorker` → `billing-sweep`, billing step | **Stop.** No new contract periods are billed, invoiced or emailed. |
| `contractWorker` → `billing-sweep`, renewal step | **Keep** (proposal). Contract lifecycle, creates no invoice. |
| `contractWorker` → `billing-sweep`, hour-block close-out | **Keep** (proposal). Internal bookkeeping. |
| `contractWorker` → `billing-sweep`, alerts | **Keep** (proposal). Internal alerts. |
| `autopayWorker` → `collection-run` | **Stop.** No charges, including work already queued. |
| `autopayWorker` → `control-reconcile` | **Keep.** Reconciles existing state. |
| `autopayWorker` → `notice-dispatch`, per notice kind | See §6.2. |
| `autopayWorker` → `notice-dispatch`, payment-method detaches | **Keep.** Drains detaches already requested. |
| `autopayWorker` → `reminder-sweep` | **Keep** (proposal). Payment reminder and overdue emails for existing unpaid invoices (§3.8). |
| `autopayWorker` → `card-expiry-check`, status update | **Keep** (proposal). Marks saved cards as expiring. |
| `autopayWorker` → `card-expiry-check`, `card_expiring` notice | **Stop** (proposal). See §6.2. |
| `quoteSendQueue` | **Stop.** Queued sends are not delivered. |
| `quoteExpiryReaper` | **Keep.** Maintainer. |
| `stripeReconcileSweep.ts` | **Keep.** Maintainer. |
| Cleanup jobs | **Keep.** |

Items marked "proposal" are our suggestions and need the maintainer's confirmation.

### 6.2 Notice kinds in `notice-dispatch` (per kind, with billing off)

Kinds from `apps/api/src/services/autopay/enrollmentNotices.ts` and `renderBillingNotice.ts`.

| Notice kind | Behaviour with billing off |
|---|---|
| `payment_receipt` | **Keep.** Receipt for a payment already made. |
| `payment_failed` | **Keep** (proposal). Outcome of a charge attempted before the switch. |
| `autopay_stopped` | **Keep.** Tells the client that autopay stopped. |
| `autopay_request` | **Stop** (proposal). New enrolment is blocked (§7.1). |
| `autopay_enrolled` | **Keep** (proposal). Confirms an enrolment already completed. |
| `autopay_paused`, `autopay_resumed` | **Keep** (proposal). Describes the state of existing autopay. |
| `card_expiring` | **Stop** (proposal). Asks the client to update a card for autopay that is off. |

### 6.1 Re-enabling billing (proposal, needs confirmation)

Contracts whose `nextBillingAt` is in the past would be billed on the next sweep. Without a rule, re-enabling
could bill several periods at once. Proposed mechanism:

- When `billing_enabled` changes from `false` to `true`, record the switch time `T`.
- For each contract with `nextBillingAt < T`, advance `nextBillingAt` to the first period boundary at or after `T`.
- Each skipped period is listed on the org Billing tab for the admin to bill manually. Nothing is billed automatically.
- No autopay charge is created for a skipped period.
- Invoices already issued before `T` remain collectable.

Where the list is stored (derived from contracts, or a small table) is open: Q7.

## 7. Enforcement points

The rule is enforced in the **services**, the way `assertTicketCreationAllowed` works in
`apps/api/src/services/serviceManagement.ts`. Routes call the same services, so every entry point inherits the
check. The list below is what the tests check (PR #8916, 2026-10-18).

### 7.1 HTTP routes, blocked with billing off (404)

| Family (file) | Operations |
|---|---|
| Invoices (`routes/invoices/invoices.ts`, `invoices/bulk.ts`) | create, edit, delete, add/edit/delete lines (incl. catalog and bundle), currency, due date, refresh time lines; bulk delete / issue / void |
| Invoice lifecycle (`invoices/lifecycle.ts`) | issue, send, resend, void, `public-link`, `reset-link` |
| Invoice pay link (`invoices/stripe.ts`) | `POST /:id/pay-link` |
| Invoice assembly (`invoices/assembly.ts`) | `POST /orgs/:orgId/invoices/assemble`, `POST /tickets/:ticketId/invoice` |
| Invoice autopay (`invoices/autopay.ts`) | `POST /:id/autopay/charge-now`; `PATCH /:id/autopay` **only when enabling** |
| Autopay, org and staff (`routes/autopay/index.ts`) | `POST /billing/autopay/requests`; `PATCH /orgs/:orgId/autopay` **only when enabling** |
| Autopay, customer (`routes/autopay/public.ts`) | `setup-session`, `setup-return` (new enrolment); `POST /:token/confirm` |
| Contracts (`routes/contracts/*.ts`) | create, edit, delete, currency, bulk delete / cancel, `generate`, add/edit/delete lines |
| Quotes (`routes/quotes/quotes.ts`, `quotes/bulk.ts`) | create, clone, revise, edit, delete, blocks and lines, currency, orders (create and edit), bulk delete / send |
| Quote send and acceptance (`quotes/lifecycle.ts`, `quotes/acceptanceEvidence.ts`) | send, schedule-send and its delete, resend, share-link, `accept-on-behalf`, images upload, acceptance evidence upload |
| Public quote acceptance (`quotesPublic`) | `POST /quotes/public/:token/accept` |
| Contract activate (`routes/contracts/lifecycle.ts`) | `POST /:id/activate` |

### 7.2 HTTP routes, kept

| Family | Operations | Why |
|---|---|---|
| Public issued invoices (`invoicesPublic`) | view, `/pdf`, `/pay`, `/settle-return` | §3.8 |
| Invoice reads and PDF (`invoices/payments.ts` GET, `invoices/pdf.ts`) | list, get, payments list, PDF | §3.8 |
| Recording a payment (`invoices/payments.ts` POST, DELETE) | record and remove a payment on an issued invoice | Reconciliation of money already received (our proposal) |
| Stripe, QuickBooks, Xero webhooks | all | §3.8 |
| Quote reads and PDF (`quotes/quotes.ts` GET), quote images and contract-file reads | reads | No new billing |
| Quote decline (`quotesPublic` `/decline`, `decline-on-behalf`) | decline | Creates nothing |
| Contract reads, hour periods, deliverables, documents | reads | No money movement |
| Contract pause, resume, cancel (`routes/contracts/lifecycle.ts`) | `POST /:id/pause`, `/:id/resume`, `/:id/cancel` | Lifecycle of existing contracts (review of 2026-10-20) |
| Contract templates (`contracts/templates.ts`) | reads **and writes** | Configuration (Q5, Q3 rule) |
| Billing reporting reads (`invoices/settings.ts`) | `/billing/reporting-totals`, currency impact | Reads |
| Billing profiles (`routes/billingProfiles.ts`, `orgBillingProfile.ts`) | reads **and writes** | Configuration (Q3) |
| Billing settings writes (`invoices/settings.ts`) | `PATCH /partner/billing-settings`, `PATCH /orgs/:orgId/billing-settings` | Configuration, same rule as Q3 |
| Billing payment settings reads | GET | Reads |
| Autopay turn-off (`PATCH` autopay) | disabling | §3.10 |
| Customer stops autopay (`autopay/public.ts`) | `GET` and `POST /:token/stop` | §3.11 |
| Customer skip (`autopay/public.ts`) | `POST /:token/skip` | Q6 |
| Partner Stripe Connect (`/partner/stripe-connect`) | connection management | Needed to re-enable billing (Q4) |
| Portal read-only history | reads | §3.8 |
| MSP's own Breeze subscription | all | §3.8 |

### 7.3 Surfaces without an HTTP route

| Surface | Rule |
|---|---|
| AI tools `manage_invoices` (`services/aiToolsBilling.ts`), `manage_quotes` (`services/aiToolsQuotes.ts`), `manage_contracts` (`services/aiToolsContracts.ts`) | Block writes. Reads kept. Checked in the services, not the tool wrapper. |
| Partner API contract writes (`routes/partnerApi/contracts.ts`) | Block writes. Reads kept. |
| Portal quote acceptance and pay (`routes/portal/quotes.ts`) | Block. Decline kept. |
| Portal autopay setup (`routes/portal/paymentMethods.ts`) | Block `setup-session` and `setup-return` (new enrolment). `POST /autopay/stop` kept. No payment-method removal route exists. |

Portal and public routes return the same 404 body as any other gated route, so the UI shows one message.

## 8. Gates (web)

8.1. Billing gets its own gate key. `requiresModule: 'service_management'` (`navGates.ts`) keeps covering Service
Desk only. The gate type is widened to add a billing key.

8.2. The Billing section gate in `Sidebar.tsx` uses the billing key, not the mode.

8.3. The org Billing tab (`orgRecordTabs.ts`) is shown from `billing_enabled`. The test that pins the
service-management tabs for `external` mode is updated, because `external` no longer hides Billing.

8.4. Tickets stay on `service_management_mode`.

Anchors in this spec use file and symbol names, not line numbers, because line numbers move.

## 9. Readiness and cascades (API)

9.1. `orgAccountReadiness.ts`: `invoices` and `contracts` use `billing_enabled`. `tickets` keeps the mode check.

9.2. `tenantCascade.ts` forced PSA un-wires (merge and reset): **do not change `billing_enabled`**. Test that the
flag is untouched in both paths (§3.12).

## 10. Open questions

Answered by the maintainer (PR #8916, 2026-10-18, second review). Recorded here for traceability:

- Q1, catch-up: accepted as a manual list of missed periods, no bulk automatic billing on re-enable.
- Q2, public quote acceptance: blocked while billing is off.
- Q3, billing profiles: configuration, reads and writes open, same rule as templates.
- Q4, Stripe Connect: open.
- Q5, contract templates: editable.
- Q6, autopay: keep customer `skip`, block `confirm`.

Still open:

- **Q7, re-enable list (§6.1):** store the skipped-period list as a derived view over contracts, or as a small table?
- **Q8, job proposals (§6):** confirm the rows marked "proposal".

## 11. Testing

- Nav gate and Sidebar: billing visible or hidden for each combination of mode and `billing_enabled`.
- Routes and services: each blocked operation in §7 returns 404 with `billing_enabled = false` and succeeds with `true`.
  Each kept operation in §7.2 is unaffected in both states.
- Jobs: each row in §6 behaves as stated in both states. Reconciliation and webhooks run in both states.
- Migration: nullable → backfill → `DEFAULT`/`NOT NULL` order; backfill matches §5 for native, external and off, with
  and without live billing; a re-run keeps an admin's changed value.
- Cascades: forced PSA un-wires leave `billing_enabled` unchanged.
- Re-enable: contracts with `nextBillingAt` in the past are advanced and listed, not billed (§6.1).

## 12. Out of scope

- Any change to `service_management_mode` values or their CHECK constraints.
- Per-organisation overrides.
- Changes to the Service Desk gate or to ticket routing.
- Bulk catch-up of missed billing periods.
