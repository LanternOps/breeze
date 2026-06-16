# Invoice Engine — Design Spec

**Status:** Design accepted 2026-06-14.
**Program:** Billing & Invoicing (sub-project 2 of 4). See
`2026-06-14-billing-architecture-overview.md` for cross-cutting conventions and
`2026-06-14-product-catalog-design.md` (sub-project 1, the pricing foundation this
engine consumes).

## 1. Purpose & scope

The Invoice Engine is the **core** of the billing program: it turns billable work
(time entries, ticket parts) and catalog items/bundles into **invoices** that MSPs
send to their customers, tracks payment against them, and renders them as PDFs /
portal views. Recurring Contracts (sub-project 3) and Stripe Payments (sub-project 4)
both build on the `invoices` / `invoice_lines` / `invoice_payments` model defined here.

This is **MSP-bills-their-customer** invoicing (partner → organization). It is distinct
from platform-bills-the-MSP subscription billing (the existing `partners.stripeCustomerId`
surface), which is unrelated and untouched.

### In scope
- `invoices`, `invoice_lines`, `invoice_payments`, `partner_invoice_sequences` tables
  (+ tax/billing-identity columns on `organizations`, billing-config columns on `partners`).
- **Two assembly modes:** org-run batch (pick org + optional site + date range over
  unbilled billable work) and per-ticket (manual "Create invoice from this ticket"
  action). Plus manual line entry and ad-hoc catalog/bundle lines on any draft.
- All five line sources: `time_entry`, `part`, `catalog`, `bundle`, `manual` (the
  `contract` source is reserved for sub-project 3; not produced here).
- Pricing exclusively via `catalogService.resolvePrice` / `computeBundleEconomics`.
- Tax (single tax line from per-line `taxable` flags × an effective rate), partner-scoped
  invoice numbering, the `draft → sent → partially_paid → overdue → paid → void`
  lifecycle, immutable snapshots on issue.
- **Manual payment recording with partial payments** (running `amount_paid` / `balance`),
  pre-Stripe.
- Async PDF rendering (BullMQ, stored artifact), email delivery, and a read-only
  customer **portal** invoice view.
- Service layer (`invoiceService.ts`), routes, settings/UI, light AI tools, tests, RLS.

### Out of scope (documented; additive later)
- **Online payment** (pay-invoice-in-portal, Stripe Connect) — sub-project 4. The
  `invoice_payments` shape is designed so Stripe writes rows here with **zero** core
  schema change; the Stripe↔invoice link lives in a mapping table, never a column.
- **Recurring / auto-generated invoices** — sub-project 3 (generates invoices *through*
  this engine; the `contract` line source is reserved for it).
- **Credit notes / refund documents.** Post-issue correction is **void + reissue** in v1
  (issued invoices are immutable; a credit-note document type is a documented later add).
- QB/Xero accounting sync (deferred, separate spec; the accounting view + mapping-table
  rule already make this a zero-core-change add).
- Multi-currency per row (partner-level default only, per the program frame).
- Nested bundles (cycle-rejected in the catalog; the line hierarchy is single-level
  parent→child).
- Dunning/automated reminders beyond the overdue-status sweep (later).

## 2. Data model

All new tenant-scoped tables get RLS enabled + forced + policies **in the creating
migration** (idempotent), added to the `rls-coverage` allowlist in the same PR, with a
functional `breeze_app` cross-tenant forge test. Money is `numeric(12,2)` throughout
(the engine standardizes on `12,2`; values snapshotted from legacy `numeric(10,2)`
ticketing columns widen losslessly).

### 2.1 `invoices` — RLS shape 1 (direct `org_id`)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `partner_id` | uuid NOT NULL | FK → partners; numbering scope + source of tax/currency/terms defaults |
| `org_id` | uuid NOT NULL | FK → organizations; RLS axis (`breeze_has_org_access`) |
| `site_id` | uuid | nullable FK → sites; optional per-site billing |
| `invoice_number` | varchar(40) | NULL while `draft`; assigned at issue. `UNIQUE(partner_id, invoice_number)` |
| `status` | enum NOT NULL | `invoice_status` (see §2.5); default `draft` |
| `currency_code` | char(3) NOT NULL | snapshot of partner default at issue (draft uses partner current) |
| `issue_date` | date | set at issue |
| `due_date` | date | set at issue = `issue_date + partner.invoice_terms_days` |
| `subtotal` | numeric(12,2) NOT NULL | Σ customer-visible line totals; default `0` |
| `tax_rate` | numeric(6,3) | effective rate snapshot at issue (see §5) |
| `tax_total` | numeric(12,2) NOT NULL | default `0` |
| `total` | numeric(12,2) NOT NULL | `subtotal + tax_total`; default `0` |
| `amount_paid` | numeric(12,2) NOT NULL | Σ `invoice_payments.amount`; default `0` |
| `balance` | numeric(12,2) NOT NULL | `total − amount_paid` (maintained on write); default `0` |
| `bill_to_name` | varchar(255) | snapshot at issue |
| `bill_to_address` | jsonb | snapshot at issue (`{line1,line2,city,region,postal_code,country}`) |
| `bill_to_tax_id` | varchar(100) | snapshot at issue |
| `bill_to_tax_exempt` | boolean NOT NULL | snapshot at issue; default `false` |
| `notes` | text | customer-facing note (editable while draft) |
| `terms` | text | snapshot of `partner.invoice_footer` at issue |
| `sent_at` | timestamptz | |
| `first_viewed_at` | timestamptz | first portal/email open |
| `viewed_at` | timestamptz | most-recent view |
| `paid_at` | timestamptz | when `balance` first reached 0 |
| `marked_overdue_at` | timestamptz | set by the overdue sweep |
| `voided_at` | timestamptz | |
| `void_reason` | text | |
| `replaces_invoice_id` | uuid | self-FK; this invoice reissues a voided one |
| `replaced_by_invoice_id` | uuid | self-FK; the reissue that supersedes this one |
| `pdf_document_ref` | text | pointer to the stored PDF artifact (see §8); sha256 alongside |
| `pdf_sha256` | char(64) | integrity check for the stored artifact |
| `created_by` | uuid | FK → users, nullable |
| `created_at` / `updated_at` | timestamptz | |

Indexes: `(org_id, status)`, `(partner_id, status)`, `(org_id, issue_date)`,
`(due_date) WHERE status IN ('sent','partially_paid')` (overdue sweep), partial unique
`(partner_id, invoice_number) WHERE invoice_number IS NOT NULL`.

### 2.2 `invoice_lines` — RLS shape 1 (denormalized `org_id`)

`org_id` is denormalized onto the line (copied from the parent invoice at insert,
app-enforced equal) so the RLS policy is a **flat** `breeze_has_org_access(org_id)` —
avoiding the nested-EXISTS bound-param bug seen on `script_execution_batches` (#1016).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `invoice_id` | uuid NOT NULL | FK → invoices, ON DELETE CASCADE |
| `org_id` | uuid NOT NULL | denormalized RLS axis |
| `source_type` | enum NOT NULL | `invoice_line_source_type` = `time_entry \| part \| catalog \| bundle \| manual \| contract` |
| `source_id` | uuid | nullable, FK-by-convention to the originating row (no hard FK — preserves immutability if the source is later deleted) |
| `catalog_item_id` | uuid | nullable snapshot ref (the item the price came from) |
| `parent_line_id` | uuid | nullable self-FK → invoice_lines; bundle child → parent |
| `ticket_id` | uuid | nullable; provenance + grouping for ticket-detail rendering |
| `description` | text NOT NULL | snapshot |
| `quantity` | numeric(12,2) NOT NULL | snapshot |
| `unit_price` | numeric(12,2) NOT NULL | snapshot (0 for descriptive bundle children) |
| `cost_basis` | numeric(12,2) | nullable snapshot; accounting/margin |
| `revenue_allocation` | numeric(12,2) | nullable; bundle child internal revenue split |
| `taxable` | boolean NOT NULL | snapshot |
| `customer_visible` | boolean NOT NULL | default `true`; filters the customer view |
| `line_total` | numeric(12,2) NOT NULL | `round(quantity × unit_price, 2)` snapshot |
| `is_unapproved_time` | boolean NOT NULL | default `false`; set on draft when sourced from an unapproved time entry (the "warn, don't block" flag — §3) |
| `sort_order` | integer NOT NULL | default `0`; stable display order, groups children under parent |
| `created_at` | timestamptz | |

Index: `(invoice_id, sort_order)`, `(org_id)`, `(source_type, source_id)` (re-invoice
guard / provenance lookup).

### 2.3 `invoice_payments` — RLS shape 1 (denormalized `org_id`)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `invoice_id` | uuid NOT NULL | FK → invoices, ON DELETE CASCADE |
| `org_id` | uuid NOT NULL | denormalized RLS axis |
| `amount` | numeric(12,2) NOT NULL | `> 0`; CHECK |
| `method` | enum NOT NULL | `payment_method` = `cash \| check \| bank_transfer \| card \| other` (Stripe adds rows here later) |
| `reference` | varchar(255) | check #, external txn id, memo |
| `received_at` | date NOT NULL | when the money was received |
| `recorded_by` | uuid | FK → users, nullable |
| `note` | text | |
| `created_at` | timestamptz | |

> **Stripe forward-compat:** sub-project 4 records captured payments as rows here and
> links the Stripe object via a mapping table (`psaConnections`-style), **not** a
> `stripe_*` column. `recomputeInvoiceStatus` (§4) is the single reconcile point for
> both manual and Stripe payments.

### 2.4 `partner_invoice_sequences` — RLS shape 3 (partner-axis)

Mirrors `partnerTicketSequences`.

| Column | Type | Notes |
|---|---|---|
| `partner_id` | uuid NOT NULL | RLS axis (`breeze_has_partner_access`) |
| `year` | integer NOT NULL | calendar year of `issue_date` |
| `counter` | integer NOT NULL | last allocated value; default `0` |
| | | PK `(partner_id, year)` |

### 2.5 Enums

- `invoice_status`: `draft | sent | partially_paid | overdue | paid | void`.
- `invoice_line_source_type`: `time_entry | part | catalog | bundle | manual | contract`.
- `payment_method`: `cash | check | bank_transfer | card | other`.

### 2.6 Column additions to existing tables

**`organizations`** (typed billing-identity columns; snapshotted onto the invoice at issue):
- `tax_id varchar(100)` nullable
- `tax_exempt boolean NOT NULL DEFAULT false`
- `tax_rate numeric(6,3)` nullable — **per-org override** of the partner default
- `billing_address_line1/line2 varchar(255)`, `billing_address_city varchar(120)`,
  `billing_address_region varchar(120)`, `billing_address_postal_code varchar(40)`,
  `billing_address_country char(2)` — all nullable. (Discrete typed columns, not JSONB,
  for validation/compliance. Falls back to `sites.address` / existing `billingContact`
  when unset — see §5.)

**`partners`** (billing config / numbering defaults):
- `currency_code char(3) NOT NULL DEFAULT 'USD'`
- `default_tax_rate numeric(6,3)` nullable
- `invoice_number_prefix varchar(12) NOT NULL DEFAULT 'INV'`
- `invoice_terms_days integer NOT NULL DEFAULT 30`
- `invoice_footer text` nullable

All additions are `ADD COLUMN IF NOT EXISTS`, no backfill required.

## 3. Line assembly & pricing

All assembly produces **draft** invoices with materialized snapshot lines (the
"materialize-on-draft" model: source rows are copied in immediately; lines are editable
until issue). Pricing always flows through the catalog resolver — the engine never
derives a price.

### 3.1 Org-run batch assembly
`assembleDraftFromOrg({ orgId, siteId?, from, to }, actor)`:
1. Gather **unbilled, billable** source rows in the window:
   - `time_entries` where `org_id = orgId` (and `site_id` via ticket if `siteId` given),
     `is_billable = true`, `billing_status = 'not_billed'`, `ended_at` within `[from, to]`.
     Line: `quantity = duration_minutes/60` (hours, 2dp), `unit_price = hourly_rate`,
     `taxable = false` (labor is non-taxable by default in v1; a partner-level
     labor-taxable toggle is a trivial documented later add), `source_type = 'time_entry'`.
   - `ticket_parts` where `org_id = orgId`, `is_billable = true`,
     `billing_status = 'not_billed'` (joined through ticket for date/site). Line:
     `quantity`, `unit_price`, `cost_basis`, `taxable` snapshotted; `source_type = 'part'`;
     carry `catalog_item_id` if the part was catalog-picked.
2. One line per source row (**ticket-level detail**), `ticket_id` set, `sort_order`
   grouping lines under their ticket.
3. **Approval handling (warn, don't block):** unapproved time entries are *included* with
   `is_unapproved_time = true`; the draft surfaces a count ("3 lines from unapproved time")
   so the user decides before issuing. Nothing is silently dropped.
4. Returns the draft with totals computed (§3.4).

> Time entries with `billing_status = 'contract'` or `'no_charge'`, and non-billable
> rows, are excluded from org-run assembly. `contract`-status work is owned by
> sub-project 3.

### 3.2 Per-ticket assembly
`assembleDraftFromTicket(ticketId, actor)`: same logic scoped to one ticket, triggered
**manually** from the ticket view ("Create invoice from this ticket"). Reuses the
existing `getTicketBillingSummary` query surface. Already-billed rows are skipped; if all
billable rows are already invoiced, the call returns a typed `NOTHING_TO_INVOICE` error.

### 3.3 Catalog / bundle / manual lines (on any draft)
- `addCatalogLine(invoiceId, catalogItemId, quantity, actor)` → calls
  `resolvePrice(catalogItemId, invoice.org_id, actor)`, snapshots
  `{ description(from item), unit_price, cost_basis, taxable }`, `source_type = 'catalog'`.
- `addBundleLine(invoiceId, bundleId, quantity, actor)` → `computeBundleEconomics(...)` +
  expand: parent line (`source_type='bundle'`, headline `unit_price`,
  `customer_visible=true`) plus one child line per component (`parent_line_id` = parent,
  `customer_visible = component.show_on_invoice`, `unit_price = 0`, carrying snapshot
  `cost_basis` and `revenue_allocation`). All components contribute to cost/margin in the
  accounting view. A bundle with `allocationMatchesHeadline = false` raises a non-blocking
  draft warning.
- `addManualLine(invoiceId, { description, quantity, unitPrice, taxable, costBasis? }, actor)`
  → free-text line, `catalog_item_id = NULL`, `source_type = 'manual'`.

Catalog resolver errors (`ITEM_NOT_FOUND` 404, `NOT_A_BUNDLE` 400, `PARTNER_UNRESOLVABLE`
400, bundle-validation codes) propagate as typed `InvoiceServiceError`s.

### 3.4 Money math
Computed in integer cents (`toCents`/`fromCents`, mirroring `catalogService`), stored as
`numeric(12,2)` strings:
- `line_total = round_half_up(quantity × unit_price)` per line (cents).
- `subtotal = Σ line_total` over **customer-visible** lines (bundle children priced at 0
  contribute nothing; the parent headline carries the charge).
- `tax_total = round_half_up(Σ line_total of taxable customer-visible lines × tax_rate)` —
  one combined tax line.
- `total = subtotal + tax_total`; `balance = total − amount_paid`.

Accounting view additionally reports COGS (`Σ cost_basis × quantity` across **all** lines,
visible or hidden) and margin.

## 4. Lifecycle & state machine

`status` is a **persisted column** and the single function `recomputeInvoiceStatus(id)`
is its only writer (called after issue, every payment, and void), plus a daily BullMQ
**overdue sweep** for the time-based transition. The `amount_paid` / `balance` columns
are the source of truth for payment state; `status` is derived from them:

```
recomputeInvoiceStatus(invoice):
  if voided_at            -> void
  if not issued (no number) -> draft
  if balance <= 0         -> paid        (stamp paid_at once)
  if past_due & balance>0 -> overdue
  if 0 < amount_paid      -> partially_paid
  else                    -> sent
```

```
draft ──issue──▶ sent ──payment(partial)──▶ partially_paid ──payment(full)──▶ paid
   │              │            │                                  ▲
   │              └─ due_date passes, balance>0 (sweep) ─▶ overdue ┘ (payment clears it)
   └─ (drafts can be deleted outright)        any issued ──void──▶ void
```

- **Issue** (`issueInvoice(id, actor)`, txn): assert `status = draft` and ≥1
  customer-visible line; allocate the number via `SELECT … FOR UPDATE` on
  `partner_invoice_sequences` then `counter + 1` (no concurrency-fork class of bug —
  the audit-chain lesson); set `issue_date`, `due_date`, snapshot `currency_code`,
  `tax_rate`, and the `bill_to_*` fields; **freeze** lines (subsequent edits rejected);
  flip every source row's `billing_status` to `billed` (time entries + parts) in the same
  txn; emit `invoice.issued`; enqueue the PDF render job.
  - **Double-bill guard:** re-select each line's source row `FOR UPDATE` inside the txn
    and assert it is still `not_billed` before flipping it. If a source row was already
    billed by another draft that issued first, fail with a typed `SOURCE_ALREADY_BILLED`
    error naming the offending lines so the user removes them and retries — two concurrent
    drafts can never double-bill the same `time_entry`/`ticket_part`.
- **Send** (`sendInvoiceEmail(id, actor)`): issue (if still draft) then email the stored
  PDF; sets/keeps `sent_at`. (Issue and send are separable: you can issue without
  emailing, e.g. to print.)
- **Record payment** (§7) → `recomputeInvoiceStatus`.
- **Overdue sweep** (daily job): for `status IN ('sent','partially_paid')` with
  `due_date < today` and `balance > 0`, set `marked_overdue_at` and recompute → `overdue`;
  emits `invoice.overdue`.
- **Viewed:** portal/email open stamps `viewed_at` (and `first_viewed_at` once); emits
  `invoice.viewed`. Independent of `status`.
- **Void** (`voidInvoice(id, reason, actor)`, txn, requires `invoices:send`): any issued
  status → `void`; set `voided_at` / `void_reason`; **release** its source rows back to
  `billing_status = 'not_billed'` so they can be re-invoiced; optionally clone a fresh
  draft (`reissue`) linked via `replaces/replaced_by`. Issued line snapshots are never
  mutated. Emits `invoice.voided`.

A `draft` invoice can be hard-deleted (no number burned, no source rows touched). Issued
invoices are immutable and can only be voided.

## 5. Tax, numbering, currency

**Tax.** Effective rate resolved at issue: `tax_exempt ? 0 : (org.tax_rate ??
partner.default_tax_rate ?? 0)`, snapshotted to `invoices.tax_rate`. Applied to the sum
of taxable customer-visible line totals, rendered as a single tax line. Per-line
`taxable` (snapshotted from the catalog item or hand-set on manual lines) is honored.

**Numbering.** Partner-scoped sequential, allocated from `partner_invoice_sequences`
keyed `(partner_id, year)`, format `{partner.invoice_number_prefix}-{YYYY}-{counter:04d}`
(e.g. `INV-2026-0001`). Resets each calendar year. Unique within a partner. Allocated
transactionally at issue (drafts have no number).

**Currency.** Single partner-level default (`partners.currency_code`), snapshotted to the
invoice at issue and rendered on the PDF/portal. No per-row currency, no FX. (A per-row
column remains a no-backfill future add per the program frame.)

**Bill-to resolution** (snapshotted at issue, first non-empty wins):
`organizations.billing_address_*` → `sites.address` (if `site_id` set) → existing
`organizations.billingContact` JSONB. Tax id / exempt from the org columns.

## 6. Snapshots & immutability

On issue, every line's `{description, quantity, unit_price, cost_basis, revenue_allocation,
taxable, line_total}` and the header's `{currency_code, tax_rate, bill_to_*, terms}` are
frozen. Later catalog edits, price-override changes, item archival, org-detail edits, or
source-row deletions **never** alter an issued invoice. The PDF is rendered once from the
frozen data. Corrections are void + reissue. This upholds the program's "issued invoices
are immutable snapshots" guarantee.

## 7. Payments (manual, partial)

`recordPayment(invoiceId, { amount, method, reference?, receivedAt, note? }, actor)`
(requires `invoices:send`):
- Validates `amount > 0` and `amount ≤ balance` (overpayment rejected in v1 with a typed
  error; credit handling is deferred with credit notes).
- Inserts an `invoice_payments` row, recomputes `amount_paid = Σ payments` and
  `balance`, calls `recomputeInvoiceStatus` (→ `partially_paid` / `paid`, clearing
  `overdue`), emits `payment.recorded` and, on full settlement, `invoice.paid`.
- Payments are listable/voidable (a mistaken payment is removed by deleting its row +
  recompute; audit-logged). Stripe (sub-project 4) records captured charges through this
  same path.

## 8. PDF / email / portal

**PDF (async, render-once).** On issue, enqueue a BullMQ job that renders the customer
view (`customer_visible = true` lines only, partner/org branding) to HTML and then to PDF
via headless Chromium (Playwright is already a repo dependency; the exact renderer is
finalized in the plan), stores the artifact, and records `pdf_document_ref` + `pdf_sha256`
on the invoice. Storage backend: object storage if configured, else an
`invoice_documents` (bytea) table — decided in the plan; the column contract is a stable
pointer + checksum either way. Because issued invoices are immutable, the PDF is generated
exactly once; downloads stream the stored artifact (no request-time render, no timeout
risk).

**Email.** New `buildInvoiceTemplate` in `EmailService` (`services/email.ts`,
Resend/SMTP/Mailgun). `sendInvoiceEmail` attaches the stored PDF; records `sent_at`.

**Portal.** New `routes/portal/invoices.ts` following the existing portal pattern: a
`portal_user_id` (org-scoped) lists and views their org's **issued** invoices
(`status != draft`), downloads the PDF, and sees status/balance — **read-only**. Online
payment is deferred to sub-project 4. Reuses `OrgBrandingEditor` (logo/colors) for the
portal view and PDF header. Opening an invoice stamps `viewed_at`.

## 9. Service layer — `invoiceService.ts`

All logic here; routes / AI tools / MCP / future workflow actions are thin equal
consumers (typed `InvoiceServiceError`, actor object — mirrors `catalogService` /
`ticketService`). Split per the File Size Guideline (e.g. `invoiceService.ts` for
CRUD/lifecycle, `invoiceAssembly.ts` for the source-gathering queries,
`invoicePdf.ts` for rendering) with a thin re-export hub.

- `assembleDraftFromOrg({ orgId, siteId?, from, to }, actor)` / `assembleDraftFromTicket(ticketId, actor)`
- `createManualInvoice({ orgId, siteId? }, actor)`
- `addManualLine` / `addCatalogLine` / `addBundleLine` / `updateLine` / `removeLine`
  (all **draft-only**; reject on issued invoices)
- `getInvoice(id, actor)` — accounting view (all lines, COGS/margin) ·
  `getCustomerInvoice(id)` — customer view (`customer_visible` only)
- `listInvoices({ orgId?, status?, from?, to?, cursor }, actor)`
- `issueInvoice(id, actor)` · `sendInvoiceEmail(id, actor)` · `voidInvoice(id, reason, actor)`
- `recordPayment(id, input, actor)` · `voidPayment(paymentId, actor)`
- `recomputeInvoiceStatus(id)` (internal) · `runOverdueSweep()` (job entry)
- `renderInvoicePdf(id)` (job entry)
- Emits `invoice.{issued,sent,viewed,overdue,paid,voided}` and
  `payment.{recorded,voided}` via the existing BullMQ lifecycle dispatch point.

## 10. Routes — `routes/invoices/`

Thin Hono handlers (auth + validation + service call), split per resource:
- `invoices.ts` — `GET /invoices`, `POST /invoices` (manual), `GET /invoices/:id`,
  `PATCH /invoices/:id` (draft fields), `DELETE /invoices/:id` (draft), line
  sub-routes (`POST/PATCH/DELETE /invoices/:id/lines/...`).
- `lifecycle.ts` — `POST /invoices/:id/issue`, `/send`, `/void`.
- `payments.ts` — `GET/POST /invoices/:id/payments`, `DELETE …/payments/:pid`.
- `assembly.ts` — `POST /orgs/:orgId/invoices/assemble` (org-run),
  `POST /tickets/:ticketId/invoice` (per-ticket).
- `pdf.ts` — `GET /invoices/:id/pdf` (streams the stored artifact).
- Portal: `routes/portal/invoices.ts` — `GET /portal/invoices`, `GET /portal/invoices/:id`,
  `GET /portal/invoices/:id/pdf`.
- `index.ts` — registration, mounted in the API route hub.

Org-scope enforced in the WHERE via `auth.orgCondition(table.orgId)` (not post-query).
Every mutation audit-logged via `writeRouteAudit`.

## 11. AuthZ / permissions

New `invoices` permission resource with four actions (fine-grained, matching the
`DEVICES_EXECUTE`-separate-from-`WRITE` convention):
- `invoices:read` — view invoices/lines/payments.
- `invoices:write` — create/edit/delete **drafts**, run assembly, manage draft lines.
- `invoices:send` — the financial-action tier: **issue**, **send**, **void**, and
  **record/void payments**.
- `invoices:export` — download PDF / CSV.

Granted to partner-scope system roles (Partner Admin: all; Partner Technician: read +
write + send) via a guarded grant migration (`is_system = true`, `NOT EXISTS` guard — the
report-permissions precedent). `clearPermissionCache(userId)` after role changes. Portal
invoice read is gated by the portal auth context (org-scoped `portal_user_id`), not these
internal permissions.

## 12. UI

MSP app (Astro + React islands, `data-testid`, all mutations via `runAction`):
- **Invoices list** (under Billing): filter by org/status/date; columns number, org,
  issue/due date, total, balance, status badge (overdue highlighted). Org-run assemble
  action (org + optional site + date-range picker over unbilled work).
- **Invoice editor** (draft): line table (add catalog/bundle/manual; edit qty/price;
  remove), live subtotal/tax/total, unapproved-time warning banner, bill-to preview,
  notes; **Issue** / **Issue & Send** actions.
- **Invoice detail** (issued): read-only lines (accounting view toggle showing
  cost/margin + hidden bundle components), payments panel (record partial payment, list),
  PDF download, void (with reason) + reissue.
- **Ticket view:** "Create invoice from this ticket" button (per-ticket assembly).
- **Org settings:** tax id / exempt / per-org tax-rate override, billing address.
- **Partner billing settings:** currency, default tax rate, number prefix, terms days,
  invoice footer.
- **Customer portal:** read-only invoice list + detail + PDF download (branded).

## 13. AI tools (light)

`aiToolsBilling.ts` in the `aiTools` hub: `list_invoices`, `get_invoice` (tier-2 reads),
thin wrappers over `invoiceService`, **org-scope-guarded** at the aiTools layer (the
known aiTools site/org-scope gap — do not rely on the route scanner). Write/issue tools
deferred. The MCP server exposes the reads automatically via the registry.

## 14. Testing

Per `breeze-testing` conventions:
- **`invoiceService` units (pure calc):** money math (cents rounding half-up, subtotal
  over visible lines, single tax line, balance), bundle expansion (parent + children,
  visibility, allocation), `recomputeInvoiceStatus` truth table (all six states +
  overdue precedence + paid stamping), numbering format.
- **Numbering concurrency:** parallel issue within one `(partner, year)` allocates
  gapless, unique numbers (txn + `FOR UPDATE`; assert no fork/dupe — audit-chain lesson).
- **State machine / lifecycle:** issue freezes lines + flips source `billing_status`;
  void releases source rows + reissue links; overdue sweep transitions; draft-only
  guards reject edits on issued invoices.
- **Assembly:** org-run + per-ticket gather only unbilled billable rows; unapproved time
  included-and-flagged (not dropped); `contract`/`no_charge` excluded; `NOTHING_TO_INVOICE`.
- **Payments:** partial → `partially_paid`, full → `paid`, overpayment rejected, payment
  void recomputes.
- **RLS:** `invoices`, `invoice_lines`, `invoice_payments`, `partner_invoice_sequences`
  added to `rls-coverage` allowlists + run against a real DB; **functional `breeze_app`
  cross-tenant forge tests** (re-seed per test; symlink `.env.test`; confirm
  non-`BYPASSRLS` role — the worktree/vacuous-RLS lessons) asserting cross-org
  insert/select fails with `new row violates row-level security policy`.
- **Routes:** Vitest + Drizzle mocks per route file incl. permission gating
  (`read`/`write`/`send`/`export`) and validation.
- **Validators:** Zod schemas (assemble input, manual line, payment, partner/org billing
  settings) in `packages/shared`.
- **Web:** `no-silent-mutations` coverage for all new mutation handlers.
- Migration idempotency via `autoMigrate.test.ts` (ordering) + manual re-apply.

## 15. Migration

Dated migration(s) `2026-06-14-…-invoice-engine.sql` (with `-a-`/`-b-` infixes if
table-then-policy ordering requires it), idempotent throughout (`CREATE TABLE IF NOT
EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DO $$`/`pg_policies` guards, no inner
`BEGIN/COMMIT`):
1. Enums `invoice_status`, `invoice_line_source_type`, `payment_method`.
2. Tables `invoices`, `invoice_lines`, `invoice_payments`, `partner_invoice_sequences`
   with indexes + RLS enable/force/policies.
3. `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS …` (tax/billing-address fields).
4. `ALTER TABLE partners ADD COLUMN IF NOT EXISTS …` (currency/tax/numbering/footer).
5. `invoices` permission rows + guarded grant to partner-scope system roles.

Add the new tables to the `rls-coverage` allowlists in the same PR. Run
`pnpm db:check-drift` after schema edits.

## 16. Events

New `invoice.*` and `payment.*` families through the existing BullMQ + event-log dispatch
point: `invoice.issued`, `invoice.sent`, `invoice.viewed`, `invoice.overdue`,
`invoice.paid`, `invoice.voided`, `payment.recorded`, `payment.voided`. Sub-projects 3
(contracts) and 4 (Stripe) subscribe without touching engine code.

## 17. Build dependency note

The implementation branch must fork off the **catalog branch**
(`docs/2026-06-14-billing-catalog-spec` / PR #1365) — it imports `resolvePrice`,
`computeBundleEconomics`, the `catalog_item_id` snapshot pattern, and the catalog enums.
Cleanest once #1365 merges to `main`; until then, branch from the catalog branch. This
spec doc itself is on `docs/2026-06-14-invoice-engine-spec`, stacked on the catalog
branch so it sits beside the overview and catalog design.

## 18. Defaults taken (flag any to change)

Recorded so they're explicit, not buried: org-run assembly = org + optional site +
date-range picker over unbilled billable work · `partners.currency_code` default `USD` ·
numbering `INV-{YYYY}-{NNNN}`, annual reset, prefix/terms configurable per partner,
30-day terms default · corrections via **void + reissue** (no credit notes in v1) ·
customers get **read-only** portal view + PDF download (no online pay until #4) · branding
reuses `OrgBrandingEditor` · PDF rendered once on issue and cached · labor (time-entry)
lines are non-taxable in v1 (partner labor-taxable toggle deferred).

## 19. References
- Program frame: `2026-06-14-billing-architecture-overview.md`
- Catalog (dependency): `2026-06-14-product-catalog-design.md`,
  `apps/api/src/services/catalogService.ts` (`resolvePrice`, `computeBundleEconomics`)
- Billing source data: `apps/api/src/db/schema/{timeTracking.ts,tickets.ts}`,
  `apps/api/src/services/timeEntryService.ts`,
  `apps/api/src/routes/tickets/{parts.ts,export.ts}` (`listBillables`,
  `getTicketBillingSummary`)
- Infra: `apps/api/src/services/email.ts`, `apps/api/src/routes/portal/`,
  `apps/api/src/services/permissions.ts`, `apps/api/src/middleware/auth.ts`,
  `apps/api/src/db/index.ts`
- RLS: `CLAUDE.md` (six tenancy shapes), `rls-coverage.integration.test.ts`; numbering:
  `partnerTicketSequences`; txn/CAS precedent: `routes/devices/actuateElevation.ts`
- Connection/mapping pattern (for Stripe #4): `apps/api/src/db/schema/integrations.ts`
