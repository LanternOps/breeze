# Recurring Contracts — Design Spec

**Billing program sub-project 3 of 4.** Builds on sub-project 1 (Product Catalog,
`2026-06-14-product-catalog-design.md`, merged #1365) and sub-project 2 (Invoice
Engine, `2026-06-14-invoice-engine-design.md`). Program frame:
`2026-06-14-billing-architecture-overview.md`.

**Goal:** Let an MSP define a recurring billing agreement with a customer (org) that
automatically generates invoices on a cadence — assembled from flat fees, auto-quantity
per-device / per-seat lines, and manual fixed-quantity lines — with a
`draft → active → paused → cancelled / expired` lifecycle and guaranteed
once-per-period billing.

**Core principle:** Contracts are a *producer* for the Invoice Engine, not a second
invoicing system. Contract generation creates ordinary draft invoices through the
existing `invoiceService`, prices through the catalog's `resolvePrice`, and reuses the
engine's issue/send/PDF/portal lifecycle wholesale. Contracts never touch invoice
internals; the engine never knows contracts exist beyond the reserved
`source_type = 'contract'` line source and `contract.*` event family.

---

## 1. Scope (v1)

**In scope**
- Contract line types: `flat`, `per_device` (auto-qty), `per_seat` (auto-qty),
  `manual` (fixed qty).
- Cadence as `interval_months` (1 = monthly, 3 = quarterly, 12 = annual, N = custom).
- Per-contract billing timing: `advance` (bill at period start) or `arrears`
  (bill at period end). Quantities are counted as-of generation time.
- Per-contract `auto_issue` toggle; default is draft-for-review.
- Optional `end_date`; otherwise open-ended. Lifecycle states
  `draft · active · paused · cancelled · expired`.
- Auto-quantity scope: org-wide, with one optional `site_id` filter per `per_device`
  line. `per_seat` counts active org users (no filter).
- Daily BullMQ sweep that generates one invoice per due period, idempotently.
- Web UI: contracts list, editor, detail (+ period history), org "Contracts" tab.
- Read-only AI tools (`list_contracts`, `get_contract`).

**Explicitly deferred (v2+)**
- **Proration.** No mid-period proration and no prorated first/last periods. Every
  period bills the full amount at the quantity counted at generation time. Adding a
  device on the 15th is billed in full the next cycle.
- **Hour allowances / overage.** Time entries with `billing_status = 'contract'` are
  bundled into the recurring fee and never separately invoiced. They surface only as an
  informational "hours under contract this period" stat on the contract detail page. No
  hour-bank accounting.
- **Fixed-term + auto-renew** with renewal windows/notices. v1 is open-ended with an
  optional hard `end_date`.
- **Rich quantity filters** (device group / OS / tag). v1 has only the optional
  per-device `site_id`.
- **Contract-line `customer_visible` flag.** All v1 contract lines are customer-visible.
- **AI/MCP write or generate tools.** Money mutations stay human- or worker-driven.

---

## 2. Data model

Three new tables, all RLS **shape 1** (direct, denormalized `org_id`) mirroring
`invoices` — a contract belongs to exactly one org under one partner. No partner-axis
sequence table is needed (contracts own no number sequence).

### 2.1 `contracts`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `partner_id` | uuid NOT NULL → partners(id) | |
| `org_id` | uuid NOT NULL → organizations(id) | RLS axis |
| `name` | varchar(255) NOT NULL | e.g. "Acme Managed Services" |
| `status` | `contract_status` NOT NULL default `draft` | `draft·active·paused·cancelled·expired` |
| `billing_timing` | `contract_billing_timing` NOT NULL | `advance·arrears` |
| `interval_months` | integer NOT NULL CHECK (> 0) | 1 / 3 / 12 / N |
| `start_date` | date NOT NULL | anchors all period math |
| `end_date` | date NULL | optional; null = open-ended |
| `next_billing_at` | date NULL | sweep pointer; null unless active |
| `auto_issue` | boolean NOT NULL default false | else draft-for-review |
| `currency_code` | char(3) NOT NULL default 'USD' | |
| `notes` | text NULL | carried onto generated invoices |
| `terms` | text NULL | carried onto generated invoices |
| `created_by` | uuid NULL → users(id) | |
| `created_at` / `updated_at` | timestamp NOT NULL default now() | |

Indexes: `(org_id, status)`, `(partner_id, status)`, and a partial
`(next_billing_at) WHERE status = 'active'` for the sweep.

### 2.2 `contract_lines`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `contract_id` | uuid NOT NULL → contracts(id) ON DELETE CASCADE | |
| `org_id` | uuid NOT NULL → organizations(id) | RLS axis (denormalized) |
| `line_type` | `contract_line_type` NOT NULL | `flat·per_device·per_seat·manual` |
| `description` | text NOT NULL | |
| `catalog_item_id` | uuid NULL → catalog_items(id) ON DELETE SET NULL | optional; price via `resolvePrice` |
| `unit_price` | numeric(12,2) NOT NULL | snapshot/override |
| `manual_quantity` | numeric(12,2) NULL | required for `manual`, else null |
| `site_id` | uuid NULL → sites(id) ON DELETE SET NULL | optional filter for `per_device` |
| `taxable` | boolean NOT NULL default false | |
| `sort_order` | integer NOT NULL default 0 | |
| `created_at` | timestamp NOT NULL default now() | |

Index: `(contract_id, sort_order)`, `(org_id)`.

### 2.3 `contract_billing_periods` (idempotency ledger / history)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `contract_id` | uuid NOT NULL → contracts(id) ON DELETE CASCADE | |
| `org_id` | uuid NOT NULL → organizations(id) | RLS axis |
| `period_start` | date NOT NULL | |
| `period_end` | date NOT NULL | exclusive |
| `invoice_id` | uuid NULL → invoices(id) ON DELETE SET NULL | the generated invoice |
| `generated_at` | timestamp NOT NULL default now() | |
| **UNIQUE** | `(contract_id, period_start)` | the double-bill guard |

The unique constraint is the idempotency backbone: generation inserts the ledger row
with `ON CONFLICT (contract_id, period_start) DO NOTHING`, so a retried or concurrent
sweep can never bill the same period twice. This table is also the data source for the
contract detail page's billing history.

### 2.4 New enums

- `contract_status`: `draft · active · paused · cancelled · expired`
- `contract_billing_timing`: `advance · arrears`
- `contract_line_type`: `flat · per_device · per_seat · manual`

---

## 3. Period math & generation logic

All period/quantity/line math lives in pure, DB-free helpers (fast unit tests, TDD),
mirroring `invoiceMath.ts`. The only impure pieces are the two quantity resolvers and
the generation orchestration.

### 3.1 Period boundaries

Periods are anchored on `start_date` and stepped by `interval_months`:

```
period N:  start = start_date + N · interval_months
           end   = start_date + (N+1) · interval_months   (end exclusive)
```

`computePeriod(startDate, intervalMonths, periodIndex) → { periodStart, periodEnd }`.
Day-of-month is preserved from `start_date`; month-overflow clamps to the last valid day
(start Jan 31 + 1 month → Feb 28/29).

### 3.2 `next_billing_at`

Derived from `billing_timing`:
- `advance` → fires **at** `period_start` (customer pays for the period ahead).
- `arrears` → fires **at** `period_end` (customer pays for the period just completed).

### 3.3 The daily sweep (`contractWorker`)

A BullMQ scheduled job (reusing the invoice engine's daily-overdue-sweep pattern),
running under `withSystemDbAccessContext`:

1. Select `contracts` where `status = 'active'` AND `next_billing_at <= today` AND
   (`end_date IS NULL` OR `period_start < end_date`).
2. For each due contract, in a single transaction:
   a. Resolve each contract line → an invoice line (§3.4).
   b. Create a **draft** invoice via `invoiceService` (`source_type = 'contract'`,
      contract/period stamped on lines).
   c. Insert the `contract_billing_periods` row with
      `ON CONFLICT (contract_id, period_start) DO NOTHING`. If the insert affected zero
      rows, the period was already billed — roll back and skip.
   d. If `auto_issue`, issue + send the invoice through the engine's existing lifecycle.
   e. Advance `next_billing_at` to the next period's trigger date.
3. If a contract has reached/passed its `end_date`, transition it to `expired` instead
   of billing, and emit `contract.expired`.

A manual `POST /:id/generate` route invokes the same per-contract path for the current
due period (operator "generate now").

### 3.4 Line resolution at generation

Each contract line produces one invoice line (`source_type = 'contract'`,
`customer_visible = true`):

| `line_type` | Quantity at generation |
|---|---|
| `flat` | `1` |
| `manual` | `manual_quantity` |
| `per_device` | live count of devices in `org_id`, filtered by `site_id` if set (`countContractDevices`) |
| `per_seat` | live count of active users in `org_id` (`countContractSeats`) |

Unit price flows through the catalog's `resolvePrice` when `catalog_item_id` is set,
otherwise the line's `unit_price`; the line total is then `computeLineTotal` from the
engine. **Pricing is never re-implemented.** The resolved description/qty/price are
snapshotted onto the invoice line, so later contract edits never mutate an
already-generated invoice (the same immutability contract the overview mandates).

`countContractDevices` and `countContractSeats` are the only impure helpers here — thin
org-scoped (optionally site-scoped) count queries, integration-tested.

---

## 4. Service, API, permissions, events

### 4.1 Service layer

`contractService.ts` is the hub (pure helpers split into `contractMath.ts`), shaped like
`invoiceService`:

- CRUD + line ops; lifecycle transitions `activate` / `pause` / `resume` / `cancel`;
  `generateForPeriod(contractId, period)` (worker + manual route entry point).
- `ContractActor = { userId, partnerId, accessibleOrgIds }` and a typed
  `ContractServiceError(message, status: 400|403|404|409, code?)` mirror the engine.
- Lifecycle rules:
  - Lines editable only while `draft` or `active`.
  - `activate` requires ≥ 1 line; sets `next_billing_at` from `start_date`/timing.
  - `pause` nulls `next_billing_at`; `resume` recomputes it **forward** from today
    (never back-bills skipped periods — consistent with no-proration).
  - `cancel` is terminal; `expired` is set only by the sweep on `end_date`.

### 4.2 REST routes

`routes/contracts/{index,contracts,lines,lifecycle,generate}.ts` — thin consumers:

- `GET /contracts`, `GET /contracts/:id` (with period history), `POST /contracts`,
  `PATCH /contracts/:id`, `DELETE /contracts/:id` (draft only).
- `POST /contracts/:id/lines`, `PATCH /contracts/:id/lines/:lineId`,
  `DELETE /contracts/:id/lines/:lineId`.
- `POST /contracts/:id/activate · /pause · /resume · /cancel`.
- `POST /contracts/:id/generate` — manual generation for the current due period.

### 4.3 Permissions

A new `contracts` resource, granted with the same idiom as `invoices` (auto-granted to
partner-scope system roles already holding `tickets:write`):

- `contracts:read` — view contracts, lines, period history.
- `contracts:write` — create/edit/delete draft contracts and lines.
- `contracts:manage` — activate/pause/resume/cancel/generate (the money-affecting
  actions; parallels invoices' `send`).

### 4.4 Events

`contract.*` family on the reserved BullMQ event bus:
`contract.activated · contract.invoiced · contract.paused · contract.cancelled ·
contract.expired`. `contract.invoiced` carries the generated `invoice_id` so
sub-project 4 (Stripe) and future workflows subscribe without touching contract code.

### 4.5 AI tools

`aiToolsBilling.ts` (extending the engine's) gains read-only `list_contracts` /
`get_contract`, org-scope guarded with `.where(auth.orgCondition(...))` (optional-chained)
as IDOR defense-in-depth atop RLS. No write/generate AI tools in v1.

---

## 5. Web UI

Astro + React islands; mutations wrapped in `runAction`; transient UI state via
`window.location.hash` (repo convention).

- **Contracts list** — table (name, org, status, cadence, next bill date, estimated
  period value), filter by status/org, "New contract" CTA.
- **Contract editor** (draft/active) — header fields (timing, `interval_months`,
  start/end dates, `auto_issue`) + line builder (type picker, optional site filter for
  per-device, catalog-item link, unit price, taxable, sort). Live "estimated this
  period" preview using current device/seat counts.
- **Contract detail** — read-only header + billing-period history (from the ledger, each
  row linking to its generated invoice) + lifecycle buttons + "Generate now" +
  informational "hours under contract this period" stat.
- **Org context** — a "Contracts" tab on the org page. Ticket/labor UI is untouched
  (covered-labor is reporting-only).
- All mutation components registered in the `no-silent-mutations` guard.

---

## 6. Tenancy & testing (non-negotiable)

- **RLS:** all three tables enabled + forced, shape-1
  `breeze_has_org_access(org_id)` SELECT/INSERT/UPDATE/DELETE policies, created **in the
  same migration** that creates the tables. Auto-discovered (direct `org_id`), so no
  allowlist entries are required — but add **functional `breeze_app` cross-org forge
  tests** (insert rejected + select empty) for each table, since the contract-test alone
  cannot catch a missing axis.
- **Cascade contract:** add all three tables to `ORG_CASCADE_DELETE_ORDER` (tenantCascade)
  and the `core.ts` device-delete lists where applicable, so org/device erasure stays
  complete (the dual-cascade contract).
- **Tests:**
  - Pure math (`computePeriod`, line resolution, `next_billing_at`, status transitions)
    → unit tests, TDD.
  - Quantity resolvers, generation, and the sweep → integration tests against a real DB
    (idempotency proven by running the sweep twice and asserting one invoice).
  - Validators in `@breeze/shared` (Zod) with their own tests.
- **Migration:** idempotent throughout; date-prefixed to sort **after** the invoice-engine
  migration (it FKs `invoices`, `catalog_items`, `sites`).

---

## 7. Dependency notes

- **Requires** the Invoice Engine (sub-project 2) merged: `invoiceService.createInvoice`
  / line APIs, `resolvePrice` / `computeLineTotal`, the `source_type = 'contract'` enum
  value, and the `invoices` table for the ledger FK.
- **Feeds** sub-project 4 (Stripe Payments): generated invoices follow the standard
  lifecycle, so Stripe's pay-in-portal + webhook reconcile work unchanged on
  contract-generated invoices. `contract.invoiced` is the subscription seam.

---

## 8. Build shape

One cohesive spec, sized like the invoice engine's six phases:

1. Schema, migration, RLS, permissions, forge tests.
2. Pure period/quantity/line math + Zod validators (TDD).
3. `contractService`: CRUD, lines, lifecycle, generation, quantity resolvers.
4. Routes, permissions, events, AI read tools.
5. BullMQ scheduled sweep worker (idempotent generation + expiry).
6. Web UI: list, editor, detail, org tab.

The implementation plan (`writing-plans`) breaks these into task-by-task steps.
