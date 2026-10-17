# Partner billing toggle (`billingEnabled`) — Design Spec

**Status:** Revised after maintainer review (CHANGES_REQUESTED on PR #8916, 2026-10-17). Awaiting re-review.
**Discussion:** LanternOps/breeze#8807 ("Add a Native RMM + Ticketing Mode Without Billing").
**Maintainer decisions:** https://github.com/LanternOps/breeze/discussions/8807#discussioncomment-18955440 (2026-10-15) and the PR #8916 review by @ToddHebebrand (2026-10-17).

---

## 1. Summary

Partners can run Breeze for RMM and ticketing without Breeze billing, and bill through Breeze
without Breeze tickets. A partner-level `billingEnabled` flag controls billing independently of
`service_management_mode`. The mode keeps deciding only where tickets live.

## 2. Background

`service_management_mode` (`native`, `external`, `off`) decides where tickets live. Today the
web and the API also use it to hide billing:

- `apps/web/src/lib/navGates.ts:31,57`: the `requiresModule: 'service_management'` key is shared by
  the Service Desk and Billing entries and shows them only when the mode is `native`.
- `apps/web/src/components/layout/Sidebar.tsx:379,400` and `:1046`: the Billing section carries the
  same `requiresModule`, and the section-level gate hides the whole section unless the mode is `native`.
- `apps/web/src/components/organizations/record/orgRecordTabs.ts`: the org Billing tab is part of
  the service-management tab derivation.
- `apps/api/src/routes/orgAccountReadiness.ts:229-238`: `invoices` and `contracts` readiness use
  `native`; `tickets` also uses `native` and stays that way.
- `apps/api/src/services/tenantCascade.ts:1212,2596`: merge and reset set `service_management_mode`
  back to `native`.

The billing API routes do not check the mode at all today. The UI hides billing; the routes do not.
That is why hiding is not enough for billing: a route 404 is not the same as stopping scheduled work.

## 3. Maintainer decisions (approved)

These are the maintainer's answers and are not proposals from this spec.

3.1. A partner-level flag, no fourth value in `service_management_mode`, default on for new rows, no
organisation override (#8807 review, 2026-10-15).

3.2. **Billing is allowed under every mode.** `external` and `off` can both run with billing on.
The spec covers all six combinations of mode × `billing_enabled`, not four (PR #8916 review, Q1).

3.3. **Gating is on `billing_enabled` alone, never on mode,** for billing routes and billing UI
(PR #8916 review, Q3). This is new server-side gating.

3.4. **Backfill, not a plain default,** for existing partners (PR #8916 review, Q2). See §5.

3.5. **No automatic re-coupling on mode change** (PR #8916 review, Q4). The `off` rule proposed in the
earlier draft is removed. The two settings are shown side by side so the state is visible when the mode changes.

3.6. **Setting home:** Partner Settings → Modules, next to the mode selector in `PartnerModulesCard.tsx`.
Saved on change, like the rest of that card. There is no "Service Management" tab.

## 4. Configuration (CLAUDE.md, rule 9)

- **Home:** Partner Settings → Modules (`apps/web/src/components/settings/PartnerModulesCard.tsx`).
- **Level:** partner only. No organisation override.
- **Resolver:** the partner value. No cascade.
- **Places the concept is configured, before / after:** before: 1 (mode selector). After: 2 (mode
  selector and `billingEnabled` switch).

## 5. Migration

5.1. Add `partners.billing_enabled boolean NOT NULL DEFAULT true`.

5.2. **Backfill** (runs once, then never overwrites an admin's later choice):

- `billing_enabled = true` when `service_management_mode = 'native'`, **or** the partner already has live billing:
  active contracts, unpaid invoices, or autopay enrolments.
- `billing_enabled = false` for every other partner (for example `external` or `off` with no billing in use).

Basing this on the mode alone would stop invoicing for an `external` or `off` partner that bills through
Breeze today. The backfill is written so a re-run keeps any value an admin has changed.

5.3. The backfill writes rows, so the migration sets `SELECT set_config('breeze.scope', 'system', true);`
before its DML, as the other data migrations in `apps/api/migrations/` do.

5.4. `partners` has no `org_id`, so it needs no `tenantCascade` or export-policy entry of its own. The
`service_management_psa_connection_id` foreign key is already handled by the existing `partners` pre-clear.

5.5. Keep the column rather than a JSON field in `partners.settings`: the value is queried by the gates
and by the backfill.

## 6. Scheduled jobs

These run regardless of mode today and must respect `billing_enabled`:

| Job | With billing off |
|---|---|
| `contractWorker.ts` | Stops generating contract periods. |
| `invoiceWorker.ts` | Stops generating and emailing invoices. |
| `autopayWorker.ts` | Stops charging. Work already queued is not charged. |
| `quoteSendQueue.ts` | Stops sending quotes. Queued sends are not delivered. |

These keep running, because they reconcile or clean up existing data:

- Payment reconciliation and Stripe webhook processing.
- PDF rendering for documents already issued.
- `quoteExpiryReaper.ts` and the cleanup jobs.

**Re-enabling billing (our proposal, to confirm with the maintainer):** only future periods are
generated. Periods that were missed while billing was off are listed for the admin to bill manually.
Automatic catch-up is not proposed, because re-enabling could issue invoices and autopay charges for
several periods at once, with amounts the client did not expect. Catch-up in bulk would need a separate
decision about duplicate charges and autopay consent.

## 7. Billing routes

With `billing_enabled = false`, every route that **creates, changes, sends, charges or issues** money-related
documents returns 404 with one shared body. Reads stay open. Operations are grouped by family, from the
route files under `apps/api/src/routes/` (contracts/, invoices/, quotes/, autopay/).

### 7.1 Blocked (404)

| Family | Operations |
|---|---|
| Invoices (`invoices/invoices.ts`, `invoices/bulk.ts`) | create, edit, delete, add/edit/delete lines (catalog and bundle too), currency change, due-date change, refresh time lines, bulk delete / issue / void |
| Invoice lifecycle (`invoices/lifecycle.ts`) | issue, send, resend, void, `public-link`, `reset-link` |
| Invoice pay link (`invoices/stripe.ts`) | `POST /:id/pay-link` (staff creates a pay link) |
| Invoice assembly (`invoices/assembly.ts`) | `POST /orgs/:orgId/invoices/assemble`, `POST /tickets/:ticketId/invoice` (maintainer: gated, not exempted) |
| Autopay on invoices (`invoices/autopay.ts`) | `PATCH /:id/autopay`, `POST /:id/autopay/charge-now` |
| Autopay, org and staff (`autopay/index.ts`) | `POST /billing/autopay/requests`, `PATCH /orgs/:orgId/autopay` |
| Autopay, customer setup (`autopay/public.ts`) | `setup-session`, `setup-return` (new enrolment) |
| Contracts (`contracts/*.ts`) | create, edit, delete, currency, bulk delete / cancel, `generate`, add/edit/delete lines |
| Quotes (`quotes/quotes.ts`, `quotes/bulk.ts`) | create, clone, revise, edit, delete, blocks and lines (incl. catalog and device-count refresh), currency, orders (create and edit), bulk delete / send |
| Quote send and acceptance (`quotes/lifecycle.ts`, `quotes/acceptanceEvidence.ts`) | send, schedule-send and its delete, resend, share-link, `accept-on-behalf`, images upload, acceptance evidence upload |
| Public quote acceptance (`quotesPublic`) | `POST /quotes/public/:token/accept` |
| Billing settings writes (`invoices/settings.ts`) | `PATCH /partner/billing-settings`, `PATCH /orgs/:orgId/billing-settings` (our proposal) |

### 7.2 Kept

| Family | Operations | Why |
|---|---|---|
| Issued invoices, public (`invoicesPublic`) | view, `/pdf`, `/pay`, `/settle-return` | Maintainer: issued invoices stay payable through public pay links. |
| Invoice reads and PDF (`invoices/payments.ts` GET, `invoices/pdf.ts`) | list, get, payments list, PDF | Maintainer: PDF rendering of existing documents keeps running. |
| Recording a payment (`invoices/payments.ts` POST, DELETE) | record and remove a payment on an issued invoice | Our proposal: reconciliation of money already received. |
| Stripe webhooks (`webhooks`) | Stripe, QuickBooks, Xero | Maintainer: reconciliation keeps running. |
| Quote reads and PDF (`quotes/quotes.ts` GET), quote images and contract-file reads | reads | No new billing. |
| Quote decline (`quotesPublic` `/decline`, `decline-on-behalf`) | decline | Creates nothing; the client can always decline. |
| Contract reads, templates, hour periods, deliverables, documents | reads | No money movement. |
| Contract templates (`contracts/templates.ts`) writes | create, archive | Our proposal: templates are configuration, not billing. Open question Q5. |
| Billing reporting reads (`invoices/settings.ts`) | `/billing/reporting-totals`, currency impact | Reads only. |
| Billing profiles and billing settings reads | `/billing-profiles` GET, `/orgs/:orgId/billing-profile` GET, billing-settings GET | Reads only. Writes to billing profiles: Q3. |
| **Customer stops autopay** (`autopay/public.ts`) | `GET` and `POST /:token/stop` | **Must stay open.** A client can always stop autopay, even with billing off. |
| Partner Stripe Connect (`/partner/stripe-connect`) | connection management | Needed to re-enable billing. Our proposal. |
| MSP's own Breeze subscription | all | Maintainer: out of scope. |
| Portal read-only history | reads | Maintainer. |

### 7.3 To decide with the maintainer

| Operation | Question |
|---|---|
| `autopay/public.ts` `skip` and `confirm` | Customer actions on a due invoice. Keep (they pay existing invoices) or block? Q6. |
| Billing profile writes (`/billing-profiles` POST, PATCH, PUT, DELETE, clone) | Block, or keep as configuration? Q3. |

Portal and public routes return the same 404 body as any other gated route, so the UI can show one message.

## 8. Gates (web)

8.1. Billing gets its own gate key. Today `requiresModule: 'service_management'` covers both Service
Desk and Billing (`navGates.ts:31,57`). The gate type is widened to add a billing key, which the Billing
entries and the Billing section use.

8.2. The Billing section gate in `Sidebar.tsx:1046` uses the billing key, not the mode.

8.3. The org Billing tab (`orgRecordTabs.ts`) is shown from `billing_enabled`, not from the mode. The
existing test that pins the service-management tabs for `external` mode is updated: `external` no longer hides the Billing tab.

8.4. Tickets stay on `service_management_mode`.

## 9. Readiness and cascades (API)

9.1. `orgAccountReadiness.ts:229-238`: `invoices` and `contracts` capabilities use `billing_enabled`.
`tickets` keeps the mode check.

9.2. `tenantCascade.ts:1212,2596`: merge and reset also set `billing_enabled` to the value they restore
(`true` for `native`; the same backfill rule otherwise).

## 10. Open questions

Q1. **Catch-up** (§6): confirm the manual-list approach, or the maintainer's preference.

Q2. **Quote acceptance** (§7): confirm that `POST /quotes/public/:token/accept` is blocked while billing is off.

Q3. **Billing profiles and billing settings reads** (§7): confirm that reads stay open and writes are blocked.

Q4. **Stripe Connect** (§7): confirm that connection management stays open so billing can be re-enabled.

Q5. **Contract templates** (§7.2): confirm that templates stay editable while billing is off.

Q6. **Autopay skip and confirm** (§7.3): keep or block.

## 11. Testing

- Nav gate and Sidebar: billing visible or hidden for each combination of mode and `billing_enabled`.
- Routes: 404 for each blocked operation when `billing_enabled = false`; unchanged response when `true`;
  public pay and Stripe webhook unaffected in both states.
- Jobs: each billing job does nothing with billing off; reconciliation still runs.
- Migration: idempotent; backfill matches §5 for native, external, off, with and without live billing; a
  re-run keeps an admin's changed value.
- Cascades: merge and reset set `billing_enabled`.

## 12. Out of scope

- Any change to `service_management_mode` values or their CHECK constraints.
- Per-organisation overrides.
- Changes to the Service Desk gate or to ticket routing.
- Bulk catch-up of missed billing periods (see §6 and Q1).
