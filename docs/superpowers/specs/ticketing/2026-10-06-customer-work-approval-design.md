# Customer approval for over-budget and after-hours ticket work: design

**Date:** 2026-10-06
**Status:** Draft. Advisor quorum (Fable/Opus + Codex `gpt-6-astra` xhigh) folded in §3. Awaiting Todd's review of §11 Open Decisions.
**Tracking issue:** LanternOps/breeze#4617
**Plan:** `docs/superpowers/plans/ticketing/2026-10-06-customer-work-approval.md`
**Builds on (shipped):** billing profiles + work types (#4628, `docs/superpowers/specs/billing/2026-09-17-billing-profiles-work-types-spec.md`), quote accept-on-behalf (`docs/superpowers/specs/billing/2026-09-21-quote-accept-on-behalf-design.md`), the portal ticket surface, and the billing/ticketing settings audit (`docs/superpowers/specs/web-ui/2026-09-17-billing-ticketing-settings-audit.md`)
**Sibling (approved, unmerged):** block hours #4547 (`origin/spec/4547-block-hours`, `docs/superpowers/specs/billing/2026-09-02-block-hours-spec.md`). See §9.

## 1. Problem

Some MSP engagements are time-and-materials with a cap: "fix the printer, up to two
hours". Others carry an after-hours premium the customer has to agree to. In both
cases the MSP wants the customer to consent before the extra work is billed, and the
customer wants to see the consent request rather than discover it on the invoice.

Breeze has no way to express either today:

- Tickets carry no budget or estimate. `tickets` lives in
  `apps/api/src/db/schema/portal.ts:130-200`, and it has no budget, estimate or
  hours column. The only hours-shaped value on a category is
  `ticket_categories.default_time_entry_minutes`, which pre-fills AI time proposals.
- After-hours exists only as a label. Work types (`apps/api/src/db/schema/workTypes.ts:6-24`)
  are partner-owned labels, and "After-hours" is named as an example. Nothing reads
  the clock. The billing-profiles spec put "auto-selecting After-hours from the clock"
  out of scope (§8 of that spec).
- There is no customer-decision primitive except quotes. `approval_requests`
  (`apps/api/src/db/schema/approvals.ts`) is the staff AI/PAM step-up system: it is
  keyed on `users`, risk tiers and tool calls. `quote_acceptances`
  (`apps/api/src/db/schema/quotes.ts:239-295`) is the only customer-signed record, and
  it is specific to quotes.
- Billing has no hold state. `time_entries.billing_status` is
  `not_billed | billed | no_charge | contract` (`apps/api/src/db/schema/timeTracking.ts:13`).
  The invoice gatherers bill every `is_billable AND billing_status = 'not_billed'`
  entry (`apps/api/src/services/invoiceAssembly.ts:189,228`), whether or not anyone
  has approved it.

## 2. The design in six sentences

1. A ticket may carry a **budget** in hours, money, or both. An org's policy may also
   require approval for any **after-hours work type**.
2. Every time entry is written through one service, `timeEntryService.ts`. That
   service runs a **gate** after stamping the entry and before committing it.
3. An entry that crosses the ticket's ceiling, or uses an after-hours work type
   without covering consent, is **recorded but held**. Its `billing_status` becomes
   `awaiting_approval`, so no invoice, block drawdown or export can bill it.
4. A held entry joins the ticket's **pending approval request** for that trigger, or
   creates one. Staff can also raise a request **before** the work. The request
   names the extension or time window being asked for.
5. A designated customer approver (a billing contact) **approves or denies** the request
   in the portal. Alternatively, a tech records a phone or email decision on the
   customer's behalf, with method and reference, as for quotes. Approval releases the
   entries the consent covers. Denial leaves them held until staff write them off or
   ask again.
6. Whether the feature is on, which triggers fire, and how strictly it enforces is
   **one settings concept** with a partner default and an org override, resolved by
   one function.

What the gate does **not** do: refuse to record work that already happened. Software
cannot stop a person working; it can only decide what is logged and what is billed.
Refusing a time entry for past work loses the record, and the work still happened.

## 3. Soft vs hard: the advisor quorum

Todd's ruling on the issue (2026-09-22) was that the soft-vs-hard default needed a
Fable + Codex quorum before any spec. This section records it.

**Fable/Opus position.** The default is **soft**. A crossing entry is recorded and
held, and the server enforces the hold in billing (§5). An org may opt into **hard**
mode. In hard mode, **starting a billable timer** on a ticket that is at or over its
ceiling, or on an after-hours work type without covering consent, is refused with
`409 APPROVAL_REQUIRED`. Non-billable logging is never refused, and neither is
recording work that has finished: a create with an `endedAt`, a timer stop, or an
edit. Those always degrade to a hold. That keeps the "gate must actually block"
lesson, the manual Remediate path ignoring `enforceMode`, honest. The block lands
where software has leverage (the money and the timer), and it is enforced in the
service rather than the UI.

**Codex position (gpt-6-astra, xhigh, read-only, 2026-10-06).** Codex also chose
**soft by default, with mandatory server-enforced billing holds**. On hard mode it
agreed: refuse prospective billable timer starts, but record and hold
completed-work submissions. Rejecting completed work cannot undo it and creates
reconciliation problems. The mobile offline queue treats a `409` as a permanent
refusal (`apps/mobile/src/services/timeEntryQueue.ts:669`), so a refused replay
would strand real time on a phone. Codex disagreed with four parts of the first
draft, and each was resolved on the merits:

| # | Codex objection | Resolution |
|---|---|---|
| Q-a | A denial should not write held time off automatically. A whole-entry hold can include minutes that fit the budget, and "no" should leave a rejected hold that staff resolve explicitly. | **Adopted.** Denied entries stay `awaiting_approval` on a `denied` request. Staff explicitly **write off** (`no_charge`) or **re-ask** (a new request means fresh consent). There is no "bill anyway" path in v1 (§5.6, D2). |
| Q-b | A requester or after-hours responder has no inherent spending authority. Designate approvers explicitly and send everyone else a notification only, as quotes split signers from CCs (`services/quoteLifecycle.ts:610`). | **Adopted.** `approver_emails` are org contacts with the `billing` role, frozen per request. The requester and `after_hours` contacts go in `notify_emails` (§6.1). The no-billing-contact fallback is D8. |
| Q-c | One entry can need both budget and after-hours consent, so link entries to requests through an association table. | **Not adopted (tie-break below).** |
| Q-d | Money ceilings must not count a missing rate as zero. | **Adopted.** On a ticket with an amount budget, an entry with no stamped rate is held (§5.3). |

**Tie-break on Q-c.** The association table would let one held entry wait on two
requests at once. The single `approval_request_id` link with sequential evaluation
(§5.4: after-hours first, and a release re-runs the gate) reaches the same end
state: an entry is released only when every requirement clears. It costs one extra
customer round trip in the rare case that needs both. In exchange it saves a
seventh tenancy registration surface: a new org-cascade, export, merge and
ticket-move table that would also need entries in both movers' lock-order lists.
Each request also keeps exactly one frozen scope, which is what the customer reads.
This is recorded as D7 so Todd can overrule it.

**Other Codex risks folded in:** decisions bind to frozen terms (`revision`), and
release re-evaluates rather than releasing everything linked (§5.6). Edits, stops and
the timer auto-stop take the ticket lock (§5.2). Repricing in `updateTimeEntry`
cannot clear a hold (§5.7). Invoice issuance already re-checks `not_billed` under
lock (`invoiceService.ts:1466`), so a draft assembled before an entry was held cannot
be issued with it. Every non-gatherer `billing_status` reader is audited explicitly
rather than trusting enum exhaustiveness (§5.7).

**Outcome: quorum agrees.**
- **Default: soft.** Crossing work is recorded and held. The hold is server-enforced
  in billing.
- **Opt-in: hard.** In addition, refuse to start a billable timer on an over-ceiling
  ticket or an uncovered after-hours work type. Never refuse recording completed
  work; hold it instead.

## 4. Data model

All migrations follow CLAUDE.md naming and must sort after the newest committed
migration, which is `2026-12-13-110200-org-erasure-fk-child-actions.sql` as of this
spec. The plan names exact files.

### 4.1 `ticket_approval_settings`: the policy (new, dual-axis config table)

There is one row per partner (the default) and at most one per org (the override). The
template is `billing_payment_settings`
(`apps/api/migrations/2026-12-03-110100-billing-payment-settings.sql`, resolver
`apps/api/src/services/autopay/billingPaymentSettings.ts:44`).

| column | type | meaning (NULL means inherit) |
|---|---|---|
| `id` | uuid pk | |
| `partner_id` | uuid null → partners | owner when partner-wide |
| `org_id` | uuid null → organizations | owner when org override |
| `enabled` | boolean null | master switch; default `false` |
| `budget_trigger` | boolean null | budget crossing raises requests; default `true` |
| `after_hours_trigger` | boolean null | after-hours work types raise requests; default `true` |
| `enforcement` | text null, CHECK `soft`/`hard` | default `soft` (§3) |
| `request_ttl_hours` | integer null, CHECK 1..720 | pending request lifetime; default `72` |
| `created_at`, `updated_at` | timestamptz | |

The table also carries `ticket_approval_settings_one_owner_chk` `((org_id IS NULL) <> (partner_id IS NULL))`,
a partial unique index per owner, and the dual-axis RLS shape from the CLAUDE.md
playbook: one `FOR ALL` policy (`system OR org-access OR partner-access`) plus a
separate `FOR SELECT` partner-wide branch
(template `2026-10-05-110000-config-policy-partner-wide-select.sql`).

The resolver is `resolveTicketApprovalSettings(db, { partnerId, orgId })` in
`apps/api/src/services/ticketApproval/settings.ts`. For each field it returns
`{ value, source: 'org' | 'partner' | 'default' }`, the same `Effective<T>` shape as
`resolveBillingPaymentSettings`. Every reader uses it: the gate, the settings UI, the
ticket UI and the sweep. No code reads the table directly.

### 4.2 `tickets`: three new columns (budget lives on the document)

| column | type | rule |
|---|---|---|
| `budget_minutes` | integer null, CHECK > 0 | labour ceiling in billable minutes |
| `budget_amount` | numeric(12,2) null, CHECK > 0 | labour ceiling in money |
| `budget_currency_code` | char(3) null | stamped from the org currency when `budget_amount` is set. CHECK: `(budget_amount IS NULL) = (budget_currency_code IS NULL)` |

The budget is per ticket on purpose. It is the agreed scope of one job, not a policy,
so it has no partner or org default in v1 (see Open Decision D4). A ticket with no
budget never raises a budget request.

### 4.3 `ticket_approval_requests`: the request and its decision (new, Shape 1)

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `org_id` | uuid not null | Shape 1, `breeze_has_org_access(org_id)` |
| `ticket_id` | uuid not null | composite FK `(ticket_id, org_id) → tickets(id, org_id)` `ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`, named `ticket_approval_requests_ticket_org_fk` |
| `trigger` | text CHECK `budget`/`after_hours` | |
| `origin` | text CHECK `auto`/`staff` | `auto` = raised by the gate; `staff` = raised ahead of work |
| `status` | text CHECK `pending`/`approved`/`denied`/`expired`/`cancelled` | |
| `revision` | integer not null default 1 | bumped every time the ask changes while pending |
| `enforcement` | text CHECK `soft`/`hard` | snapshot of the resolved policy at creation |
| `requested_by_user_id` | uuid null → users `ON DELETE SET NULL` | null for `auto` |
| `requested_at`, `expires_at` | timestamptz not null | |
| `message` | text null | the tech's note to the customer |
| `budget_minutes_at_request`, `consumed_minutes_at_request` | integer null | budget trigger snapshot |
| `budget_amount_at_request`, `consumed_amount_at_request` | numeric(12,2) null | |
| `currency_code` | char(3) null | |
| `requested_extension_minutes` | integer null | budget trigger: the extension asked for |
| `requested_extension_amount` | numeric(12,2) null | |
| `coverage_starts_at`, `coverage_ends_at` | timestamptz null | after-hours trigger with `origin='staff'`: the window asked for |
| `approver_emails` | text[] not null default `'{}'` | lower-cased and frozen at creation; who may decide (§6.1) |
| `notify_emails` | text[] not null default `'{}'` | lower-cased and frozen; informational recipients |
| `after_hours_work_type_id` | uuid null | after-hours trigger: the work type whose flag raised it (snapshot; later flag edits do not rewrite the request) |
| `decided_at` | timestamptz null | |
| `decision_origin` | text null CHECK `customer`/`on_behalf` | |
| `decided_by_portal_user_id` | uuid null → portal_users `ON DELETE SET NULL` | |
| `decided_by_user_id` | uuid null → users `ON DELETE SET NULL` | staff on behalf |
| `signer_name`, `signer_email` | text null | durable even if the login is deleted |
| `decision_method` | text null CHECK `verbal`/`email`/`signed_document`/`other` | on behalf only. The vocabulary is reused from quote accept-on-behalf |
| `decision_reference` | text null | required when `on_behalf` |
| `decision_note` | text null | the customer's or tech's reason |
| `decided_revision` | integer null | the revision the decider saw |
| `approved_extension_minutes`, `approved_extension_amount` | integer / numeric(12,2) null | copied from the request at `decided_revision` |
| `ip_address`, `user_agent` | text null | customer decisions; trusted IP helper as `routes/portal/quotes.ts` |
| `created_at`, `updated_at` | timestamptz | |

Indexes and constraints:
- Unique `(id, ticket_id)`. This is the target of the `time_entries` composite FK.
- Partial unique `(ticket_id, trigger) WHERE status = 'pending'`: at most one open
  request per trigger per ticket.
- Index `(org_id, status, expires_at)` for the sweep.
- `ticket_approval_requests_decision_shape_chk`. When `status IN ('approved','denied')`,
  `decided_at`, `decision_origin` and `decided_revision` must be set. `on_behalf`
  requires `decision_method` and a non-blank `decision_reference`. `customer` requires
  `signer_email`. The CHECK does not require the `decided_by_*` ids, because
  `ON DELETE SET NULL` may null them later. The service always sets them.
- A trigger, `ticket_approval_requests_decided_immutable`, rejects an UPDATE to a row
  whose `OLD.status` is terminal. The exceptions are `org_id` (org move and merge),
  `updated_at`, and the three `*_user_id` columns going to NULL (FK `SET NULL`).
  Rows remain deletable, so tenant erasure works without `AUDIT_ADMIN_REQUIRED_TABLES`.

Typed snapshot columns replace the issue's proposed `context` jsonb. A jsonb column
would land in `excludedOpen` and disappear from the tenant export. These figures are
the customer's own commercial record.

### 4.4 `time_entries`: hold state

- New enum value: `billing_status` gains `awaiting_approval`. `ALTER TYPE … ADD VALUE`
  cannot be used in the transaction that adds it, and `autoMigrate` wraps each file
  in one, so this is its own migration file. That rule is spelled out in
  `2026-10-05-100000-contract-line-type-per-device-role.sql:3-8`.
- New column: `approval_request_id uuid null`, with composite FK
  `(approval_request_id, ticket_id) → ticket_approval_requests(id, ticket_id) ON DELETE SET NULL (approval_request_id)`,
  named `time_entries_approval_request_fk`. The FK is keyed on `ticket_id`, not
  `org_id`, so neither org mover has to defer it: a ticket's id never changes when its
  org does.
- The FK must be `SET NULL`, not `RESTRICT`. The org cascade deletes
  `ticket_approval_requests` before `time_entries`, because `'tic' < 'tim'`.
- `ticket_parts` shares the `billing_status` type (`timeTracking.ts:120`). A CHECK,
  `ticket_parts_billing_status_not_held_chk`, forbids `awaiting_approval` there. Parts
  are out of scope (§10).
- Invariant: `billing_status = 'awaiting_approval'` implies `approval_request_id IS NOT NULL`.
  The service enforces it and an integration test pins it. It is not a CHECK, because
  `ON DELETE SET NULL` on a hard ticket delete would trip a CHECK and abort the delete.

### 4.5 `work_types`: one new column

`is_after_hours boolean not null default false`. `work_types` is partner-axis
(Shape 3) with no `org_id`, so no org cascade or export-policy list changes. It is edited
where work types already live: Billing → Rates → `WorkTypesCard`, the home the
settings registry test pins.

### 4.6 Registration checklist (every list, by name)

| table / change | lists |
|---|---|
| `ticket_approval_settings` (new, has `org_id`) | `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical); `orgMergeRegistry` `keep-survivor`, as `billing_payment_settings` (`orgMergeRegistry.ts:137`); `CORE_TENANT_EXPORT_POLICY`, all columns `included`; `DUAL_AXIS_TENANT_TABLES` in `rls-coverage.integration.test.ts`; new `ticketApprovalSettingsPartnerRls.integration.test.ts` |
| `ticket_approval_requests` (new, `org_id` + `ticket_id`) | `CORE_ORG_CASCADE_DELETE_ORDER` (sorts before `tickets` and `time_entries`); `orgMergeRegistry` `repoint`; `CORE_TENANT_EXPORT_POLICY` (`approver_emails`, `notify_emails`, `ip_address` and `user_agent` are `included` as customer data; no secret columns); `TICKET_ORG_DENORMALIZED_TABLES` (`services/ticketOrgMoveLockOrder.ts`) **and** `CUSTOM_ORG_REWRITE_TABLES` (`routes/devices/core.ts:442`) **and** `TICKET_CHILD_ORG_REWRITE_LOCK_ORDER`, appended last on all three; constraint `ticket_approval_requests_ticket_org_fk` added to **both** `SET CONSTRAINTS … DEFERRED` statements (`ticketService.ts:3144`, `deviceOrgMove/moveDeviceOrgInTransaction.ts:178`) |
| `tickets` + 3 columns | `CORE_TENANT_EXPORT_POLICY` row for `tickets` (`included`) |
| `time_entries` + `approval_request_id` | `CORE_TENANT_EXPORT_POLICY` row for `time_entries` (`included`) |
| `work_types` + `is_after_hours` | none (no `org_id`) |

## 5. The gate

### 5.1 Where it runs

The single choke point is `apps/api/src/services/timeEntryService.ts`. The only
application-code writers of `time_entries` are `createTimeEntry` (`:644`),
`startTimer` (`:834`), `stopTimer` → `stopRunningEntry` (`:764`/`:929`) and
`updateTimeEntry` (`:1001`). `updateTimeEntry` also covers the mobile stop-replay
`PATCH {endedAt}`. Every caller goes through these: REST (`routes/timeEntries/timeEntries.ts`),
the Office add-in (`routes/officeAddin/time.ts`), the AI tool `manage_tickets`
(`services/aiToolsTicketing.ts:1270,1306,1336`), AI create-ticket (`routes/ai.ts:755`)
and session suggestions (`services/timeSuggestionService.ts:533`). The gate is one
function, `evaluateApprovalGate(...)`, called from each of the four after billing is
stamped and before the row is written. The plan adds a source-scan contract test
that fails if a new `insert(timeEntries)` or `update(timeEntries)` appears outside the
service or the allowlisted invoice and mover paths.

The gate only ever runs on entries that have a `ticket_id`, are `is_billable`, and
whose coverage is `billable`. Included, non-billable and ticketless entries are never
held.

### 5.2 Locking

The existing creation barrier is `organizations FOR SHARE → tickets FOR UPDATE → time/part INSERT`
(`timeEntryService.ts:523-545`). The gate runs inside it, so two technicians stopping
timers at the same moment serialise on the ticket row and cannot both slip under the
ceiling. The canonical order with requests is:

`organizations SHARE → tickets FOR UPDATE → ticket_approval_requests FOR UPDATE → time_entries FOR UPDATE`

`stopRunningEntry` locks the entry first today (`:783`), and `updateTimeEntry` locks
the entry without its ticket (`getEntryOr404`, `:983`). Both change to read the entry
unlocked, lock the ticket, then lock the entry and re-check it. A re-check that finds
the entry changed or relinked retries once. `startTimer` auto-stops the user's
running timer (`:857`), which may be on another ticket. It locks both tickets in
ascending id order before either write, so two users crossing timers between the same
two tickets cannot deadlock. The decide, cancel and expiry paths take the same order. The plan includes
a concurrency integration test for each pair.

### 5.3 Budget evaluation

The gate computes these figures under the ticket lock, excluding the entry being
written:

- `consumedMinutes` = Σ `COALESCE(billable_minutes, duration_minutes)` over the
  ticket's entries where `is_billable`, `coverage = 'billable'`, `ended_at IS NOT NULL`
  and `billing_status IN ('not_billed','billed','contract')`. Held entries are not
  consumed. They are the overage the open request asks about.
- `consumedAmount` = Σ `multiplyToCurrency(minutes/60, hourly_rate)` over the same
  set, accumulated in cents (`packages/shared/src/utils/currency.ts:169`).
- `ceilingMinutes` = `budget_minutes` + Σ `approved_extension_minutes` of approved
  budget requests. `ceilingAmount` is computed the same way.

Null budget means no ceiling on that axis, and zero is rejected by CHECK. Either
ceiling triggers. Money means labour only: time entries at their stamped rate, before
tax, with no parts. If the ticket has an amount budget and the entry has no stamped
`hourly_rate`, the entry is held. An unknown price cannot be shown to fit.

If `consumed + this entry` exceeds either ceiling, the entry is held. The whole entry
is held, not split at the boundary: the invoice shows the entry as the tech wrote it.
A running timer has no duration, so it is evaluated at stop.

### 5.4 After-hours evaluation

An entry whose work type has `is_after_hours = true` is covered when either of these
holds:
- an approved `after_hours` request on the ticket has a coverage window containing the
  entry's `started_at`, or
- the entry was released by an approved `auto` request (its `approval_request_id`
  points at it).

Otherwise the entry is held. An entry can need both triggers. It is linked to one
request at a time, and after-hours is evaluated first. When an after-hours approval
releases it, the gate runs again and may hold it under budget.

### 5.5 Outcomes

| situation | soft | hard |
|---|---|---|
| billable entry fits | written `not_billed` | same |
| finished entry crosses (create with `endedAt`, stop, edit) | written `awaiting_approval`, linked to the pending request (created if none, `revision` bumped, extension recomputed) | same; past work is never refused |
| **start** a billable timer at or over the ceiling, or on an uncovered after-hours work type | allowed; held at stop | `409 APPROVAL_REQUIRED` with `{ trigger, requestId? }`. The UI offers "Request approval" or "Log as non-billable" |
| edit an entry that is `awaiting_approval` | re-evaluated as if new; may be released, which unlinks it, and a pending `auto` request with no held entries left is `cancelled` | same |
| edit an entry that is `billed` | unchanged (existing lock) | same |

The AI tool and the add-in receive the same result. A held entry returns
`billingStatus: 'awaiting_approval'`, and the tool text says so. The `409` surfaces as a
tool error.

### 5.6 Decisions and their effect

All of these run in one transaction under the §5.2 lock order:

- **Approve.** The request is stamped as decided, and every entry linked to it is
  re-evaluated. Under the new ceiling or coverage each one normally becomes
  `not_billed`. A ticket comment (public, `system`) records it, and
  `ticket.approval_decided` is emitted.
- **Approve releases only what the consent covers.** Each linked entry is
  re-evaluated against the new ceiling. An entry added after the decided revision
  could not have been seen. It cannot join a decided request anyway, because the
  partial unique index lets new holds attach only to a `pending` request. An entry
  still over the extended ceiling stays held and opens a new request.
- **Deny.** Linked entries stay `awaiting_approval`, and the ticket shows "Customer
  denied: N entries to resolve". Staff resolve each entry with **Write off**, which
  sets `no_charge` and is audited (`time_entry.approval_written_off`), or **Ask
  again**, which creates a new request with a fresh revision and moves the entries
  to it. v1 has no "bill without consent" action (D2).
- **Expire.** The `ticketSlaWorker` sweep marks the request `expired`. Its entries stay
  held. Staff re-send, which creates a new request, moves the entries and cancels the
  old one, or staff mark them `no_charge`.
- **Cancel.** Staff withdraw a request, and its entries return to the gate.
- A decision is accepted only if `decided_revision = revision`. A stale page gets a
  `409 REQUEST_CHANGED`, so the customer always approves the amount they saw.

### 5.7 Every other reader of `billing_status`

A new enum value is fail-closed for the invoice gatherers, which select `= 'not_billed'`.
It is not fail-closed for readers that use `ne(...)` or count "unbilled". The plan
audits each of the 25 files that read `billing_status`, as of
`grep -rln billing_status apps/*/src packages/shared/src`. The known non-trivial ones:

| reader | required behaviour |
|---|---|
| `ticketMoveCurrencyGuard.ts:105` | counts `not_billed` entries to block a currency-crossing move; must count `awaiting_approval` too (it carries a stamped currency) |
| `orgCurrencyService.ts` | currency-change guard: same |
| `portal/supportUsage.ts:89,124-135` | `ne('no_charge')`; held time must show as "awaiting your approval", not as billed or included |
| `invoiceAssembly.ts:61` `isMissingRateGap` | no change; held entries never reach it |
| `timeEntryService.listBillables` (`:1755`) → `routes/tickets/export.ts` | export held entries with their status, not as billable |
| `businessReports/technicianTimeReport.ts`, `packages/shared/src/reportPdf/technicianTimePdf.ts` | new status label |
| `apps/mobile/src/screens/time/entryLock.ts`, `apps/web/src/components/time/TimesheetPage.tsx` | status label; held entries stay editable |
| `packages/shared/src/validators/timeEntries.ts`, `types/officeAddin.ts` | enum widened; clients may not set `awaiting_approval` directly |
| `timeEntryService.updateTimeEntry` reprice (`:1049-1060`) | a reprice re-derives the billing stamp. It must not move an entry out of `awaiting_approval`; the gate is the only writer of that transition |
| `invoiceService.ts:1466` issue-time re-check | already refuses non-`not_billed` sources; give held sources their own error (`SOURCE_AWAITING_APPROVAL`) instead of "already billed" |
| `invoiceService.ts:2365` void | flips `billed → not_billed`; unaffected (held entries were never billed) |

## 6. Who decides, and how

### 6.1 Recipients

The portal has no roles (`routes/portal/schemas.ts:19-58`). Quotes solve "who may
accept" with a list frozen at send time (`quote_recipients`,
`routes/portal/quotes.ts:249-254`) and separate signers from CCs. This design does
the same:

- **`approver_emails`**: active org contacts whose `roles` contains `billing`
  (`apps/api/src/db/schema/contacts.ts:55-58`; the role exists and is unused today).
  A billing contact is the org's statement of who commits spend.
- **`notify_emails`**: the ticket requester (`requester_contact_id` → contact email,
  else `submitter_email`), plus `after_hours` contacts for that trigger, minus anyone
  already an approver. They see the request but cannot decide it.

With no approver, the request is still created. Staff see "No approver on file: add a
billing contact or record the decision on behalf", and the requester is notified. D8
covers whether the requester should be the fallback approver.

### 6.2 Portal

- `GET /portal/approvals` lists requests where the caller's normalised email is in
  `approver_emails` or `notify_emails` and `org_id` matches. Only approvers get
  actions. Ticket subject, number, the ask and the
  snapshot figures are shown, but not the whole ticket: a billing contact may not own
  the ticket under `ticketOwnership.ts`.
- `POST /portal/approvals/:id/approve|deny` takes `{ revision, signerName, note? }`.
  It runs the §5.6 transaction and records IP and user agent. It is CSRF-protected like
  the other portal mutations and audited with `writePortalAudit`.
- UI: an "Approvals" page in the portal nav, with a count badge, and a banner on
  `TicketDetails.tsx` when the viewer is a recipient of a pending request on that
  ticket. The quote accept panel (`components/lifecycle/QuoteDetailView.tsx`) is the
  visual precedent: typed name, an explicit Approve or Deny, and the amount stated in
  words.

### 6.3 Staff

- Ticket detail gets a **Budget** field (hours and/or amount), a progress bar
  (consumed vs ceiling, held time shaded), and an **Approvals** panel: request, cancel,
  re-send, and record a decision on behalf.
- `POST /tickets/:id/approval-requests` (staff-raised ask), `POST /ticket-approval-requests/:id/cancel`,
  `POST /ticket-approval-requests/:id/decide-on-behalf` `{ decision, revision, method, reference, signerName, signerEmail?, note? }`.
- Held entries show an "Awaiting customer approval" chip in the ticket time list and
  in the timesheet.

### 6.4 Notifications

`services/ticketEvents.ts` gains `ticket.approval_requested` and `ticket.approval_decided`.
`jobs/ticketNotifyWorker.ts` emails `approver_emails` and `notify_emails` on request (separate copy: approvers get the Approve/Deny link). Today it only emails
`submitterEmail` (`:356-366`), so this is a new recipient branch. It uses
`renderPartnerEmail` with a new template id, so partner template overrides apply. On a
decision it notifies the assignee and the requesting user through `user_notifications`.
Ticket watchers do not exist (no `ticket_watchers` table), so they are out of scope.

### 6.5 Permissions

| action | permission |
|---|---|
| set a ticket budget, raise or cancel a request | `tickets:write` |
| record a decision on behalf | new `tickets:record_approval`, back-filled to every role holding `tickets:manage`, as `quotes:accept` was (`2026-10-27-100100-quotes-accept-permission.sql`) |
| write off a held entry (`no_charge`) | `manage_billing`, via the existing `assertManageBilling` (`timeEntryService.ts:1048`) |
| edit `ticket_approval_settings` (partner row) | `canManagePartnerWidePolicies(auth)` (`services/partnerWideAccess.ts`) |
| edit the org override | the permission that already guards org Ticketing settings (`OrgTicketSettingsEditor.tsx`) |
| AI tools | may read request status. They may not decide, record on behalf, or set budgets (money-committing, human-only, the same stance as quote accept-on-behalf §3) |

## 7. Settings (CLAUDE.md rule 9 statement)

- **Concept:** "customer approval for over-budget and after-hours work".
- **Home:** Settings → Ticketing → **Time capture** tab (`TicketingSettingsTabs.tsx:36`,
  `TimeTrackingSettingsCard.tsx`) for the partner default. Org settings → **Ticketing**
  (`OrgTicketSettingsEditor.tsx`) for the org override.
- **Level:** partner default → org override. Blank means inherit, and the inherited
  value and its source are shown (`InheritedField`). Enforcement is snapshotted on the
  request when it is created, which is the document moment, so a policy change never
  re-judges an open request.
- **Resolver:** `resolveTicketApprovalSettings`, the only reader.
- **Places configured, before → after:** 0 → 1. A new concept; the audit's §2 named a
  "require-approval-before-billing switch" as a thing that must not be added in more
  than one place. The per-ticket budget is a document value, not a setting. The work
  type `is_after_hours` flag is an attribute of a label that already exists and lives
  in its existing home.
- Same-screen save pattern: the Time capture card is a form, saved with the page
  Save. Mixing in an autosave toggle would break rule 7.

## 8. Rollout

The feature is off by default (`enabled` defaults to `false`), so nothing changes for
any partner until they turn it on. The enum value and columns ship dark in the first
wave.

## 9. Contracts with other work

- **Block hours (#4547, unmerged):** its period-close drawdown claims
  `billing_status = 'not_billed'` entries. Held entries are therefore not drawn down
  until approved. That is the intended behaviour, and the block-hours plan should say
  so. This design counts `contract` entries as consumed toward a ticket budget (§5.3),
  because the budget is the customer's labour consent for the ticket however it is
  paid. See D5.
- **Invoices:** no change to `gatherOrgTimeEntries`/`gatherTicketBillables`. The
  existing `= 'not_billed'` predicate is the hold.
- **Billing profiles (#4628):** the gate runs after `resolveEntryBilling`, so it sees
  the stamped coverage and rate. Included coverage is never held.

## 10. Out of scope

Capping invoice lines at the approved amount is out of scope. Staff can already edit
a draft invoice line's quantity or rate (`invoiceService.ts:535`) after any entry is
gathered. That is an explicit, audited staff act on the MSP's own document, and it is
true with or without this feature. The gate governs which captured time is billable,
not what a tech types on a draft. (Codex raised this; it is recorded as a known limit,
not a gap.)

Clock-based after-hours detection. It needs a business-hours resolver that does not
exist; `partners.settings.businessHours` is UI-only (`routes/orgs.ts:720`) (D3). Also
out of scope: unauthenticated email-link approval (D1), ticket parts and expenses
budgets, per-category default budgets (D4), budget warning notifications before the
ceiling, ticket watchers, and approval by AI tools.

## 11. Open Decisions

Each one has a recommendation. Work proceeds on the recommendation unless Todd
overrides it.

- **D1: Unauthenticated email-link approval.**
  - (a) Portal login only, plus on-behalf recording (v1).
  - (b) Add a signed public token link, like `quotesPublic.ts`, so recipients without
    a portal login can decide.

  **Recommend (a)** for v1, with (b) as a follow-up wave. The link is a new
  unauthenticated money-committing surface and deserves its own review.
- **D2: What a denial does to held time.**
  - (a) Mark it `no_charge` automatically.
  - (b) Leave it held, and require staff to explicitly write off or ask again. There
    is no bill-without-consent action.

  **Recommend (b)** (quorum). A whole-entry hold can contain in-budget minutes, so an
  automatic write-off would zero work the customer already consented to. The ticket
  surfaces the unresolved count, so (b) does not leave time unnoticed.
- **D3: After-hours detection.**
  - (a) Work type flag only (v1).
  - (b) A clock-based classifier on a new business-hours and holiday resolver.

  **Recommend (a).** (b) is a separate feature: a business-hours calendar, with its own
  settings home, that SLA would also want.
- **D4: Budget defaults.**
  - (a) Per-ticket only.
  - (b) A per-category default budget copied onto new tickets.

  **Recommend (a)** for v1. (b) adds a second place the concept is configured, which
  rule 9 requires to be justified.
- **D5: Does block-hours (`contract`) time count toward a ticket budget?**
  - (a) Yes.
  - (b) No.

  **Recommend (a).** Whether an entry is drawn from a block is only known at period
  close, so (b) cannot be evaluated when the entry is written.
- **D6: Default enforcement mode.**
  - (a) Soft: hold.
  - (b) Hard: also refuse billable timer starts.

  **Recommend (a)**, the quorum outcome (§3), with (b) as the org opt-in. Todd asked
  for the quorum; this item is here so he can confirm it.
- **D7: Entry-to-request link.**
  - (a) A single `approval_request_id` with sequential evaluation.
  - (b) An association table, so an entry can wait on budget and after-hours requests
    at once.

  **Recommend (a)** (tie-break in §3). (b) costs a seventh registration surface in
  exchange for saving one customer round trip in a rare case.
- **D8: No billing contact on the org.**
  - (a) No fallback: staff record on behalf or add a billing contact.
  - (b) The ticket requester becomes the approver.

  **Recommend (a)** (quorum Q-b). A requester has no inherent spending authority.
  Staff see the gap the moment the request is raised.
