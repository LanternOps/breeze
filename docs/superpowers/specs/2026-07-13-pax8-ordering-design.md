# Pax8 Ordering — Design

**Date:** 2026-07-13
**Status:** Approved, pending implementation plan
**Epic:** Pax8 + invoicing, next phase

## Summary

Breeze can read Pax8 but cannot buy from it. This phase adds the write path: a technician can place, change, and cancel Pax8 subscriptions from inside Breeze, either directly on a customer record or as the fulfillment step of a quote the customer approved.

The central design commitment is that **Breeze is the source of truth for licensing and billing, and Pax8 is not.** We never read a seat count back from Pax8 to bill from. We know what the customer has because every change went through us.

## Background

### What exists today

`pax8Client.ts` is structurally read-only — `requestJson()` never sets a method, so every call is a GET. The integration authenticates per-partner via OAuth client-credentials, runs a nightly sync at 04:15, and persists:

| Table | Purpose |
|---|---|
| `pax8_integrations` | Per-partner credentials (encrypted), one active row per partner |
| `pax8_company_mappings` | Pax8 company ↔ Breeze org |
| `pax8_subscription_snapshots` | Nightly snapshot of Pax8 subscriptions |
| `pax8_product_mappings` | Pax8 product ↔ `catalog_items` |
| `pax8_contract_line_links` | Subscription ↔ `contract_lines`, with a `sync_enabled` quantity push |

All five are partner-axis (RLS shape 3), with `org_id` present on three as a linkage column explicitly excluded from org auto-discovery.

Quotes are fully built: block-composed documents whose lines snapshot `catalog_item_id`, `sku`, `unit_cost`, and a `recurrence` of `one_time`/`monthly`/`annual`. A customer approves via a single-use JWT link or the portal; `acceptQuote()` then, in one transaction, issues an invoice from the one-time lines, creates draft contracts from the recurring lines, and marks the quote `converted`.

Nothing anywhere calls Pax8 to buy anything.

### The billing-truth problem (discovered during design)

Pax8's API `Subscription.quantity` **does not reliably match the seat counts Pax8 actually invoices the partner for.** The API value lags or goes stale; the invoice is correct.

This is not a hypothetical. `applyEnabledPax8ContractLineLinks()` (`pax8SyncService.ts:232-265`) currently pushes `pax8_subscription_snapshots.quantity` into `contract_lines.manual_quantity` every night for every `sync_enabled` link, and the daily contract billing sweep invoices the MSP's customer from that column. **Shipped code is billing customers off a number Pax8 itself does not bill from.** Under-count and the MSP absorbs the margin; over-count and they overbill their customer.

This design fixes the cause rather than chasing the symptom: Breeze stops deriving billable quantities from Pax8 entirely.

## Pax8 API contract

Confirmed against Pax8's OpenAPI (`devx.pax8.com`; appending `.md` to any reference page returns raw OpenAPI JSON).

| Action | Call |
|---|---|
| Create subscriptions | `POST /v1/orders` — one order, many `lineItems` |
| Change quantity | `PUT /v1/subscriptions/{id}` |
| Cancel | `DELETE /v1/subscriptions/{id}` (optional `cancelDate` query param) |
| Discover provisioning fields | `GET /v1/products/{id}/provision-details` |
| Discover commitment rules | `GET /v1/products/{id}/dependencies` |
| Dry-run validate | `POST /v1/orders?isMock=true` |

Load-bearing facts, each of which shapes the design:

**There is no suspend.** The complete set of subscription writes is `PUT` and `DELETE`. There is no documented endpoint to reactivate a cancelled subscription — `Resurrect` exists only as a webhook event type. Treat cancel as terminal and one-way.

**Provisioning-detail requiredness is not machine-discoverable.** `provision-details` returns each field's `key`, `label`, `valueType` (`Input` | `Single-Value` | `Multi-Value`), and `possibleValues` — enough to generate a form and validate enum values. It does **not** return which fields are required, nor the conditional logic between them. Pax8's own docs prove the gap: discovery for Microsoft 365 E3 returns ten fields, while their official order example sends nine, because answering "no existing Microsoft account" makes the tenant-ID field moot. That branch logic exists nowhere in the API. `isMock=true` is therefore the only machine-checkable oracle for payload completeness.

**There is no idempotency key, and orders have no status field.** `POST /v1/orders` accepts exactly one parameter (`isMock`) and zero headers. The `Order` schema is `{id, companyId, createdDate, orderedBy, orderedByUserId, orderedByUserEmail, isScheduled, lineItems}` — no state, no reason, no stuck-detection. `createdDate` is a **date, not a timestamp**, so two orders placed the same day cannot be distinguished after the fact. A retried POST creates a second real, billable order that we cannot cheaply detect.

**`PUT /v1/subscriptions/{id}` is a partial update despite the verb**, and `price`, `partnerCost`, `currencyCode`, `startDate`, and `endDate` are all writable. A read-modify-write round-trip would re-send pricing and can overwrite the customer's rate.

**`GET /v1/products/{id}/dependencies`** returns per-commitment `allowForQuantityIncrease`, `allowForQuantityDecrease`, `allowForEarlyCancellation`, and `cancellationFeeApplied`. These *are* discoverable and should gate the UI.

**Rate limit:** 1000 successful calls/minute.

**Pax8's own OpenAPI is unreliable.** The create-order reference alone contains four defects: a `required` list naming a `companyId` property the schema doesn't define, an example sending `commitmentTermID` where the schema says `commitmentTermId`, an example sending a response-only `subscriptionId` on a create, and a malformed UUID. Treat the spec as a hint and `isMock` as the truth.

### Unverified — must be confirmed against live credentials before implementation

- **Does `POST /v1/orders` return `lineItems[].subscriptionId` populated synchronously, or is it null until provisioning completes?** Two research passes disagreed. The submit pipeline's linking step depends on this. If it can be null, the order line records `subscription_id_pending` and the nightly sync fills it in by matching product + company.
- Whether failed calls count against the rate limit, and whether `Retry-After` is returned.
- Whether write permission on an API key is granted separately in the Pax8 partner portal (a documented `403 "insufficient permissions"` exists). Worth confirming with the Pax8 rep before build, since it's the difference between working in test and 403ing in prod.

## Design

### 1. The order is a staged intent ledger

Because Pax8 offers no idempotency key and no order status, **our row is the record of whether money was spent, and Pax8 is not.** The table is a claim ticket punched exactly once, not a receipt.

**`pax8_orders`** — header. Partner-axis.

| Column | Notes |
|---|---|
| `id` | uuid pk |
| `partner_id` | NOT NULL — tenancy axis |
| `org_id` | linkage column, NOT NULL, composite FK `(org_id, partner_id) → organizations(id, partner_id)` |
| `integration_id` | composite FK `(integration_id, partner_id) → pax8_integrations(id, partner_id)` |
| `pax8_company_id` | the mapped Pax8 company |
| `status` | `draft` \| `awaiting_details` \| `ready` \| `submitting` \| `completed` \| `partially_failed` \| `failed` \| `cancelled` |
| `source` | `direct` \| `quote` |
| `source_quote_id` | nullable FK → `quotes` |
| `dedupe_key` | UNIQUE — the idempotency guard |
| `pax8_order_id` | returned by Pax8 on success |
| `created_by`, `submitted_by`, `submitted_at` | |

**`pax8_order_lines`** — one row per *action*, because Pax8 splits the three verbs across three endpoints.

| Column | Notes |
|---|---|
| `id`, `order_id`, `partner_id`, `org_id` | |
| `action` | `new_subscription` \| `change_quantity` \| `cancel` |
| `submit_state` | `pending` → `in_flight` → `succeeded` \| `failed` \| `needs_reconcile` |
| `pax8_product_id`, `catalog_item_id` | `new_subscription` only |
| `billing_term` | `Monthly` \| `Annual` \| `2-Year` \| `3-Year` \| `One-Time` \| `Trial` \| `Activation` |
| `commitment_term_id` | required iff the product's `requiresCommitment` |
| `quantity` | new quantity (for `change_quantity`, the absolute target — not a delta) |
| `provisioning_details` | jsonb, `[{key, values[]}]` |
| `target_subscription_id` | `change_quantity` / `cancel` |
| `cancel_date` | `cancel` only, optional |
| `result_subscription_id` | populated on success |
| `contract_line_id` | the line this order bills through |
| `source_quote_line_id` | nullable |
| `error` | raw Pax8 `details[]`, verbatim |

Per-line state is not overengineering. One order can batch a new purchase, a seat bump, and a cancel; the POST can succeed while a PUT 422s. A single order-level status would either lie or discard the successful half.

**Why Pax8-specific tables and not a generic `distributor_orders`.** Commitment terms, the provisioning-details key/value model, and the three-endpoint split are Pax8-shaped. TD SYNNEX — today lookup-and-pricing only — orders nothing like this. Generalizing now would buy a wrong abstraction. If TD SYNNEX ordering ships, extract then.

**Tenancy: partner-axis (shape 3),** matching the five existing `pax8_*` tables. Policies on `breeze_has_partner_access(partner_id)`; `org_id` excluded from org auto-discovery; integrity via composite FKs. Ordering is an MSP-side act — an org-scoped token must never see it. Register in `PARTNER_TENANT_TABLES` and add the `org_id` exclusions in `rls-coverage.integration.test.ts` in the same PR.

### 2. Authoring path A — direct, on the org page

A **Pax8 tab on the org record**, showing three things:

- The company mapping, with an inline mapper and a clear empty state when the org isn't mapped.
- Breeze's ledger-derived seat counts — what we believe the customer has.
- The Pax8 snapshot alongside them, with a **drift badge** wherever the two disagree.

Actions accumulate into a single open draft order for that org:

- **Add product** → picker over Pax8-mapped catalog items → term, commitment, quantity → a provisioning form generated from `GET /products/{id}/provision-details`, rendering `Input` as free text, `Single-Value` as a select over `possibleValues`, `Multi-Value` as a multiselect.
- **Inline seat +/-** on an existing subscription → a `change_quantity` line. Gated on `allowForQuantityIncrease` / `allowForQuantityDecrease`.
- **Cancel** → a `cancel` line. Gated on `allowForEarlyCancellation`, warning when `cancellationFeeApplied`.

Then one **Review & Submit** screen for the whole order.

Two preconditions enforced up front rather than eaten as a 422: the org must have a `pax8_company_mappings` row, and Pax8 requires the company be Active with primary admin, billing, and technical contacts on file.

### 3. Authoring path B — quote acceptance stages an order

Quote lines already snapshot `catalog_item_id`, and `pax8_product_mappings` resolves a catalog item to a Pax8 product — so a Pax8-backed quote line is identifiable at accept time **with no schema change to quotes**.

Staging happens **inside the accept transaction**, as a new Phase 5 immediately after Phase 4 (which already creates the draft contracts via `createContractWithLines`). Breeze builds a `pax8_orders` row with `source='quote'` and one `new_subscription` line per Pax8-backed quote line, each carrying the `contract_line_id` that Phase 4 just created. It lands in `awaiting_details`: the customer bought it, the contract exists, and the only thing outstanding is provisioning input the customer could never have supplied.

It is deliberately **not** in the post-commit tail. That tail exists only for Redis/BullMQ side effects (`invoice.issued`, the PDF enqueue, the accept-token revoke) which must not fire if the transaction rolls back. Staging is a plain DB write with no external effect, and it must be atomic with the contracts it references — a staged order pointing at contract lines that were rolled back would be unfixable.

`createContractWithLines()` returns only the contract, not its lines, so Phase 5 re-reads `contract_lines` for the contracts Phase 4 created and matches them to Pax8-backed quote lines on `catalog_item_id`, claiming each contract line at most once. A Pax8 quote line with `recurrence = 'one_time'` produces no contract line at all (it bills on the invoice), so its order line carries a null `contract_line_id` and performs no billing write on success.

**A customer's approval never places a vendor order.** It stages one. A technician reviews and submits.

The quote path only produces `new_subscription` lines. Changes and cancels are servicing actions, not sales, and belong on the direct path.

**Discoverability** needs no new machinery: the accepted quote's detail page shows the order it staged and links to it, and the org's Pax8 tab shows it pending. Both are places a tech working the account already looks. No notification system, no queue page. The customer is not waiting on this — the MSP technician is the user.

### 4. Submit pipeline

Lines are grouped by action. All `new_subscription` lines batch into **one** `POST /v1/orders` (`parentLineItemNumber` lets dependent items reference siblings within the same order). Each `change_quantity` and each `cancel` fires its own `PUT` / `DELETE`.

**`isMock=true` is a hard gate on every submit.** Since Pax8 won't tell us which provisioning fields are required or how they branch, the mock call is the only machine-checkable oracle for completeness. On 422 we surface Pax8's raw `details[]` verbatim next to the offending line rather than pre-judging validity from a spec we have already caught lying four times.

**The `PUT` sends only `quantity`.** Nothing else, ever — `price`, `partnerCost`, and `currencyCode` are writable and a read-modify-write would overwrite the customer's rate. This gets a dedicated unit test asserting the request body has exactly one key.

### 5. Money-safety rules

**Claim before you fire.** The line flips to `in_flight` in a committed transaction *before* the HTTP call, guarded by the unique `dedupe_key`. A concurrent submit loses the race and is rejected.

**Never blind-retry.** A timeout or 5xx does not mean the order failed — it means we do not know. The line goes to `needs_reconcile`, never `failed`, and nothing automatic re-sends it. A human sees "we may have already ordered this" and clicks **Reconcile**, which pulls `GET /v1/orders?companyId=` and `GET /v1/subscriptions?companyId=`, matches on product + quantity, and establishes what actually landed. Auto-retry here is how you buy 200 licenses instead of 100.

**Bill from what succeeded.** In the same transaction that marks a line `succeeded`, Breeze writes the resulting quantity onto the linked `contract_line`. Ordering and billing are one atomic act: we can never provision without billing, or bill without provisioning.

### 6. Breeze is the billing source of truth

The contract line's quantity is written by **our order ledger**, never by a Pax8 sync. We do not read `Subscription.quantity` for any purpose that touches money.

Consequently, `applyEnabledPax8ContractLineLinks()` **stops writing to `contract_lines` entirely.** It is demoted to drift detection: the nightly sync still pulls the snapshot, but only to *compare* against Breeze's ledger and raise a flag when the two disagree. That flag is the signal that someone changed seats directly in the Pax8 portal, bypassing Breeze. Pax8 becomes a check, never a driver.

This is a behavior change to shipped code and must be called out in the release notes — partners with `sync_enabled` links will see contract-line quantities stop auto-updating from Pax8, which is the point.

### 7. Provisioning status: no polling worker

`POST /v1/orders` returns the subscription identifier, which is all we need to link the order to what we bought (see the unverified item above). Beyond that, provisioning status is **not load-bearing** — Breeze is the billing truth, and the Pax8 marketplace *vendor* emails the technician directly on fulfillment (a documented vendor obligation, step 4 of Pax8's provisioning contract).

So the org tab displays a last-known status from the existing nightly sync (`Active`, `PendingAutomated`, `WaitingForDetails`), honestly labeled as up to a day stale. No new polling worker, no backoff logic, no timeout guessed against an SLA Pax8 does not publish.

`WaitingForDetails` means our provisioning payload was incomplete — `isMock` should have caught that pre-submit, and the nightly sync surfacing it is an adequate backstop for something that shouldn't happen.

## Out of scope (deliberately)

**The `PROVISIONING` webhook topic — next phase.** It is the only mechanism in the entire Pax8 partner surface that can tell a technician *why* an order is stuck: Pax8's changelog describes it emitting task creation, status transitions (Ready → Executing → Finished), errors, and cancellations, filterable by client, product, subscription, and status. There is no REST endpoint to query any of it — to have durable, answerable stuck-order state you must persist the webhook stream yourself. (`pax8_integrations.webhook_secret_encrypted` already exists, unused, in anticipation.)

It is deferred for a concrete reason beyond scope: **Pax8 does not publish the topic strings or the status enum.** The changelog says "Finished" in one sentence and "COMPLETED" in the next. The receiver cannot be fully spec'd from documentation — it needs `GET /webhooks/topic-definitions` called with live credentials first. Also note webhook emission is permission-sensitive: if the Pax8 account lacks permission on an object, no event fires at all, silently.

**The Vendor Provisioning API** (`/provision-requests`, `/provision-attempts`, `/provision-results`, `/provisioners`) is **not available to us.** It sits under an OpenAPI title of "Vendor Provisioning Endpoints" and Pax8 defines the audience as marketplace vendors fulfilling orders, with vendor-issued credentials. We are the `Partner`, not the `Provisioner`. Do not build against it.

**Generic distributor ordering.** See §1.

**Scheduled/future-dated orders.** Pax8 explicitly does not support them via API (the sole exception being `cancelDate` on a cancel).

## Testing

- `pax8OrdersPartnerRls.integration.test.ts` — cross-partner forge fails 42501; org-scoped token sees nothing.
- Real-Postgres integration test: a successful order line writes the contract-line quantity **in the same transaction** as `succeeded`.
- Real-Postgres integration test: a second concurrent submit of the same order is rejected by the `dedupe_key` unique constraint.
- Unit test: the `change_quantity` request body contains `quantity` and no other key.
- Unit test: a timeout on submit lands the line in `needs_reconcile`, never `failed`, and no retry is issued.
- Unit test: `isMock` 422 blocks the real submit and surfaces `details[]` verbatim.
- Contract test: register both new tables in `PARTNER_TENANT_TABLES` and the `org_id` auto-discovery exclusion list.

## Follow-up work this design surfaces

1. **File a bug for the shipped billing defect.** `applyEnabledPax8ContractLineLinks()` bills customers off a Pax8 quantity Pax8 does not itself bill from. This design fixes it as a side effect, but partners are exposed *today* and the exposure predates this work.
2. **Confirm with Pax8 whether API write permission is granted separately** on the partner-portal API key, before implementation starts.
3. **`PROVISIONING` webhook receiver** — its own spec, after `topic-definitions` is called with live credentials.
