# Partner billing toggle (`billingEnabled`) — Design Spec

**Status:** Revised for maintainer re-review. Factual corrections verified on `e274f6825` (2026-10-20); Q7/Q8 decided by @ToddHebebrand on 2026-10-20. Final spec approval is pending.
**Discussion:** LanternOps/breeze#8807 ("Add a Native RMM + Ticketing Mode Without Billing").
**Maintainer decisions:** Discussion #8807 (2026-10-15); PR #8916 reviews (2026-10-17, 2026-10-18, 2026-10-20) and [Q7/Q8 decision](https://github.com/LanternOps/breeze/pull/8916#issuecomment-6302493661) (2026-10-20).

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

3.11. Customer `POST /autopay/stop` remains available with billing off; the 2026-10-20 review confirmed that this is the actual portal route, and Q8 keeps `autopay_stopped` notices.

3.12. `tenantCascade` forced PSA un-wires must **not** change `billing_enabled`. Automatic re-enabling was ruled
out (PR #8916, 2026-10-18, §9.2).

3.13. Q7 (2026-10-20): skipped contract billing periods are persisted in a small org-scoped ledger with forced
RLS, cascade/merge/export coverage, a unique (contract, period start) constraint, and **no automatic billing**
from ledger rows. Manual resolution is flag + note only (§6.1).

3.14. Q8 (2026-10-20): stop new money movement while Billing is off, keep existing obligations visible and
communicated, and split safe state work from blocked customer messages. Renewal's absence of financial side
effects must be **tested in the implementation PR**, not noted for later (§6 and §6.2).

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

5.7. The separate, **org-scoped skipped-period ledger** approved in Q7 is specified in §6.1. Unlike the partner flag column, it requires its own RLS, organization cascade/merge/export registrations, and integration tests. Its SQL migration follows `apps/api/migrations/README.md` and `docs/agents/tenancy-rls.md`; no existing shipped migration is edited.

## 6. Scheduled jobs

**Approved principle (Q8, 2026-10-20): no new money movement while billing is off; obligations that already
exist stay visible and communicated.** Gate new billing work **per partner inside each job's due-rows query**,
following `buildAutomationEligibleOrgPredicate`, rather than stopping a worker for all partners. Recheck the
current flag at the service/side-effect boundary so work queued before disablement cannot create an invoice,
send a new quote, or initiate a charge afterward. Keep reconciliation, previously issued invoice collection
through public payment links, and existing-obligation notices available. Where a worker mixes bookkeeping and
customer messages, split the effects; do not disable the entire worker. Behaviour with `billing_enabled = false`:

| Job | Behaviour with billing off |
|---|---|
| `invoiceWorker` → `render-pdf` | **Keep.** PDFs of existing documents. |
| `invoiceWorker` → `overdue-sweep` | **Keep.** Status of existing invoices. |
| `contractWorker` → `billing-sweep`, billing step | **Stop.** No new contract periods are billed, invoiced or emailed. |
| `contractWorker` → `billing-sweep`, renewal step | **Keep only without financial side effects.** The implementation PR **must test** that renewal under billing-off never creates an invoice, a charge, or another billable output; this is an acceptance gate, not a later verification note. |
| `contractWorker` → `billing-sweep`, hour-block close-out | **Keep only non-billing state work.** `runHourBlockCloseOutSweep` currently can call `createManualInvoice` for block-hour overage. The implementation must separate or defer that invoice-producing path while billing is off; do not silently mark work completed or create a draft invoice. |
| `contractWorker` → `billing-sweep`, alerts | **Keep**, if the alert is internal and does not trigger financial work. |
| `autopayWorker` → `collection-run` | **Stop.** No charges, including work already queued. |
| `autopayWorker` → `control-reconcile` | **Keep.** Reconciles existing state. |
| `autopayWorker` → `notice-dispatch`, per notice kind | See §6.2. |
| `autopayWorker` → `notice-dispatch`, payment-method detaches | **Keep.** Drains detaches already requested. |
| `autopayWorker` → `reminder-sweep` | **Keep.** `runInvoiceReminderSweep` sends `payment_reminder` / `payment_overdue` for already-issued unpaid invoices (§3.8). |
| `autopayWorker` → `card-expiry-check` | **Stop** `card_expiring` notice creation (§6.2). Current `checkExpiringAutopayCards` checks dates and enqueues this notice; it has **no independent stored-card status update** to preserve. Any separately existing card-state maintenance remains available, not this send path. |
| `quoteSendQueue` | **Stop.** Queued sends are not delivered. |
| `quoteExpiryReaper` | **Keep.** Maintainer. |
| `stripeReconcileSweep.ts` | **Keep.** Maintainer. |
| Cleanup jobs | **Keep.** |

**Decision trace:** the Keep/Stop policy and notice matrix were accepted by the maintainer in Q8. The
`runHourBlockCloseOutSweep` draft-invoice path and `checkExpiringAutopayCards` behaviour above are confirmed
from current code and constrain implementation to the accepted no-new-billing rule; they do not add product
scope. Tests must prove mixed-effect workers preserve safe state changes without an invoice, charge or
blocked notice.

### 6.1 Re-enabling billing — skipped periods (Q1 and Q7, decided)

A contract with `nextBillingAt` in the past is eligible for the next billing sweep when Billing is re-enabled.
Simply turning the flag back on would allow old periods to be charged. **No automatic catch-up** is permitted:

- On a partner transition from `billing_enabled = false` to `true`, capture the switch time `T`. Under the
  existing contract billing-period arithmetic, identify only genuinely eligible skipped periods of active
  contracts. Paused, cancelled or otherwise ineligible periods are **not** invented as billing obligations.
- **Persist each eligible skipped period before advancing the contract pointer.** For an eligible contract with
  `nextBillingAt` before `T`, advance it to the first contractual period boundary at or after `T`; the
  ledger insertion and pointer update must be coordinated transactionally with the billing gate to prevent a
  concurrent sweep from invoicing the backlog.
- The skipped-period ledger is a **small persistent org-owned table**, not a view over mutable contracts.
  Minimal stored facts: `contract_id`, `org_id`, `period_start`, `period_end`, the `billing_disabled`
  reason and manual resolution as a **boolean flag and optional note**. The partner is derived through the
  contract/organization relationship; no duplicate partner configuration or second billing engine.
  Uniqueness is enforced on `(contract_id, period_start)` and period boundaries must be valid.
- The creating migration provides **RLS enabled and forced**, org-access policies, and same-org referential
  integrity to the contract. It registers the table in `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`),
  `services/orgMergeRegistry.ts`, and `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`) according to
  `docs/agents/tenancy-rls.md`. Composite org FKs follow the project's
  `DEFERRABLE INITIALLY IMMEDIATE` merge convention. The table is operational customer history, **not**
  a partner-wide configuration table; the partner flag itself still needs no org-cascade registration (§5).
- Show these records on the org Billing tab for **manual review and resolution** (flag + note only in this
  delivery). A skipped-period record **never** generates an invoice, charge or autopay attempt, whether
  unresolved, marked resolved, or later reprocessed. It is not an automatic or bulk catch-up queue.
- Previously issued invoices remain payable and reconcilable after the switch (§3.8). Multiple enable/disable
  cycles and retries must not duplicate ledger rows or revive skipped-period collections.

The existing contract date/billing-period helpers are the source for period boundaries; do not derive history
from the current `nextBillingAt` after it is advanced. This records the approved decision, not permission to
add a new manual invoicing workflow or a second billing-period calculator.

### 6.2 Notice kinds in `notice-dispatch` (Q8, decided)

The maintainer accepted the per-kind matrix on 2026-10-20. The dispatcher stays running; check eligibility
by notice kind and partner **before sending**, including notices queued before Billing was switched off.
Existing obligations stay communicated, but an obsolete offer to initiate new billing must not be sent.

| Notice kind | Behaviour with billing off |
|---|---|
| `payment_receipt` | **Keep.** Receipt for a completed payment. |
| `payment_failed` | **Keep only for attempts initiated before disablement.** No new collection attempts. |
| `autopay_stopped` | **Keep.** The customer must be able to stop autopay. |
| `autopay_request` | **Stop.** No new enrollment requests. |
| `autopay_enrolled` | **Keep for a previously completed enrollment.** |
| `autopay_paused`, `autopay_resumed` | **Keep for valid existing-state changes.** |
| `card_expiring` | **Stop.** Suppress the client-facing request to update a card for disabled autopay. |

**Full-dispatcher coverage (implementation mapping, not an additional product decision):**
`BILLING_NOTICE_KINDS` also includes `payment_reminder` and `payment_overdue` (keep for existing unpaid
issued invoices, §6 `reminder-sweep`) and `invoice_autopay` (do not send a pre-charge notice for a new
automatic charge that Billing-off now forbids). The implementation must cover every defined notice kind,
including queued work, without silencing allowed reminders, receipts, failure outcomes or stop notices.
Where a job mixes a safe internal state update with a blocked notice, preserve the state update and suppress
only the notice.

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
| Recording a payment (`invoices/payments.ts` POST, DELETE) | record and remove a payment on an issued invoice | Reconciliation of money already received; does not initiate a new automatic collection (§3.8) |
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

## 10. Maintainer decision log — Q1–Q8 resolved

The choices below are **decisions**, not outstanding proposals. These Q1–Q8 are the **follow-up questions**
from the 2026-10-18 review cycle, distinct from the four original questions answered on 2026-10-17 (§3).
Q1–Q6 were answered in the 2026-10-18 review; Q7–Q8 were decided in the
[2026-10-20 maintainer comment](https://github.com/LanternOps/breeze/pull/8916#issuecomment-6302493661).

| Decision | Maintainer answer | Contract |
|---|---|---|
| Q1 — Catch-up | Manual list; no automatic bulk billing of missed periods on re-enable | §6.1 |
| Q2 — Public quote acceptance | Block while Billing is off | §7.1 |
| Q3 — Billing profiles | Configuration reads and writes remain open | §7.2 |
| Q4 — Stripe Connect | Keep connection management open | §7.2 |
| Q5 — Contract templates | Remain editable | §7.2 |
| Q6 — Customer autopay | Keep `skip`; block `confirm` | §7.1–§7.2 |
| Q7 — Skipped-period storage | **Persistent org-scoped table**, not a derived view; forced RLS/policies, org cascade/merge/export registration, unique (contract, period start); manual resolution **flag + note**; ledger rows never invoice/charge/autopay | §§5.7, 6.1 |
| Q8 — Jobs and notices | **Accepted** the §6 Keep/Stop proposal and §6.2 notice matrix; no new money movement, existing obligations still communicated; test renewal's lack of financial effects and split mixed worker effects | §§6, 6.2, 11 |

**Implementation boundary:** the code-level split needed for a mixed worker (for example the draft-overage
invoice path in `runHourBlockCloseOutSweep`) is a technical acceptance condition of Q8, **not** permission
to introduce a new billing workflow. The spec is awaiting final maintainer approval before an implementation
PR begins.

## 11. Testing

- Nav gate and Sidebar: billing visible or hidden for each combination of mode and `billing_enabled`.
- Routes and services: each blocked operation in §7 returns 404 with `billing_enabled = false` and succeeds with `true`.
  Each kept operation in §7.2 is unaffected in both states.
- Jobs: each row in §6 behaves as specified under both states. Per-partner predicates do not stop unrelated
  partners. Retries and pre-queued work recheck Billing before any invoice, quote send, charge or blocked notice.
  Reconciliation, existing-invoice payment links and webhooks remain operational in both states.
- **Q8 financial side-effect gate:** with Billing off, test that renewal produces **no new invoice, charge or
  other financial side effect**, and that the hour-block close-out does **not** reach `createManualInvoice` or
  mark a period closed as if its financial branch ran. Safe bookkeeping and permitted internal alerts still run.
  Test `card-expiry-check` does not enqueue `card_expiring` even for an existing card; do not assert an
  independent status update that the current function does not perform.
- **Notice matrix:** test each §6.2 kind, including already queued and pre-disablement outcomes; keep
  `payment_reminder`/`payment_overdue` for issued invoices, and prevent `invoice_autopay` from announcing a
  charge suppressed by Billing-off. No silencing of receipts, eligible failures or stop messages.
- Migration: nullable → backfill → `DEFAULT`/`NOT NULL` order; backfill matches §5 for native, external and off,
  with and without live billing; a re-run keeps an admin's changed value.
- **Q7 new table (real PostgreSQL):** RLS enabled + forced with cross-org read/write rejection as `breeze_app`;
  same-org contract FK, period boundary and duplicate-period constraints; idempotent migration; required
  `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts` and `CORE_TENANT_EXPORT_POLICY` coverage; full
  delete, org merge and tenant export/erasure tests. Run the integration suites, not only API unit tests.
- Cascades: forced PSA un-wires leave `billing_enabled` unchanged.
- **Re-enable:** skipped periods of eligible contracts are recorded exactly once and the pointer is advanced
  without automatically billing them; paused/cancelled periods do not become obligations. Test repeat toggles,
  replays, concurrent sweep versus re-enable, and manual flag/note updates that never create charges.

## 12. Out of scope

- Any change to `service_management_mode` values or their CHECK constraints.
- Per-organisation overrides.
- Changes to the Service Desk gate or to ticket routing.
- Bulk catch-up of missed billing periods.
- Automatic invoicing, payment collection or autopay directly from skipped-period ledger rows.
- A new manual skipped-period invoicing workflow; this delivery records and displays the history with a
  resolution flag and note only (§6.1).
