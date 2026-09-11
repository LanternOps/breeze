# Service deliverables, org documents and key dates — design

Status: **approved by Todd 2026-09-10** (after the D12–D14 additions).
Advisor quorum: Fable position formed, codex gpt-6-astra xhigh read-only review
received; two disagreements resolved in codex's favour on the evidence, one split
resolved by tie-break. See "Quorum record" (§17).
Tracking: to be registered via feature-lifecycle after approval.
Plan: to be written with `writing-plans` after approval.

## 1. Problem and goal

MSPs sell service tiers whose value is scheduled human work, not tooling: "monthly
sign-in log review", "quarterly configuration audit against the baseline", "annual
tabletop". Breeze contracts (`apps/api/src/db/schema/contracts.ts`) bill money and
count devices, but cannot record those obligations, open the work when it falls
due, capture the artifact that proves it was done, or show the customer what they
received. Today that lives in a spreadsheet, a calendar and a Drive folder per
client, so it does not scale past one client and the customer sees nothing.

Three adjacent gaps surface with it:

- No org-level document library. Bytes exist only as `contract_documents`,
  `invoice_documents` and `ticket_attachments`; a runbook, a firewall rule export
  or an onboarding baseline has nowhere to live and no portal exposure.
- No org-level key dates. Custom fields are device-only
  (`customFields.ts`, `deviceCustomFieldValues.ts`); an insurance renewal date or a
  vendor contract end date cannot be recorded, let alone drive a reminder.
- No recurring or scheduled ticket creation of any kind (grep for "recurring" in
  the ticket routes, services and schema is empty).

Goal: an organization carries a **service deliverables schedule**, normally attached
to a contract; a daily job **opens the work as tickets** when due; delivery is
**recorded explicitly with evidence**; the customer portal shows a **service
scorecard** (what was delivered, when, with what evidence, what is next) and a
**documents** page; the MSP sees the same on the contract and the org record. The
first paying use is a law firm on a "Best" tier with eight deliverables
(a fictional "Northwind Law P.C." stands in for the real firm throughout this document).

## 2. Decisions

| # | Decision | Chosen | Rejected | Why |
|---|---|---|---|---|
| D1 | Owner of a deliverable | **Organization**, with optional `contract_id` and its own `effective_from` / `effective_until` | Contract-owned, `contract_id NOT NULL` (Fable's first position) | Codex showed the contract status is a *billing* state machine: `generateDueInvoice` sets `status='expired'` as soon as the next billing period is past `end_date` (`contractService.ts` ~line 2013), so an annual-advance contract is `expired` the day after its one invoice while service runs 12 more months. Service life must not be read off billing state. `contract_documents.contract_id` is already nullable for the same reason. |
| D2 | Occurrences | **Materialized rows**, one per period, with a name snapshot | Compute due dates from cadence + anchor on read | Each occurrence carries state (ticket, evidence, delivered/missed/waived, lateness). Mirrors `contract_billing_periods`: `UNIQUE (parent, period_start)` plus an explicit transaction around claim + ticket creation. |
| D3 | Work item | **Reuse tickets**, discriminated by a new typed `tickets.work_kind` | New task table; a `deliverable` tag | Tickets already have `due_date`, assignee, comments, public attachments, portal visibility, notification and time entries. Deliverable tickets are created with **no SLA** (planned work; the SLA worker clocks from `created_at`, so a 7-day lead ticket would breach before the work is due). A typed column, not a tag string, so a future Projects module reuses the same discriminator (`project_task`) for SLA suppression, list filters and portal rules. |
| D4 | What records delivery | **Explicit delivery with a completion policy**; ticket resolution alone never marks delivered when an artifact is required | "Ticket resolved ⇒ delivered" (Fable's first position) | Closing a ticket requires neither an artifact nor a note (`changeTicketStatus`, `ticketService.ts` ~line 942), which contradicts `artifact_required`. Resolution moves the occurrence to `awaiting_evidence` when evidence is missing, to `delivered` when it is present or not required. |
| D5 | Document bytes | `s3 \| db` dual backend via a generic blob helper extracted from `ticketAttachmentStorage.ts`; keys carry no tenant id | Inline `bytea` like `contract_documents` | Runbooks and exports are larger and more numerous than signed PDFs; the ticket-attachment shape already solves backend selection, upload compensation, 503 on storage fault and no presigned URLs. The erasure S3 pre-clear (`tenantCascade.ts` ~line 1111) is extended to `org_documents`. |
| D6 | Evidence | **Join table** `service_deliverable_evidence`, many per occurrence, DB-enforced ownership | Two nullable FK columns on the occurrence | A monthly review commonly produces a findings document and an export. `report_runs` has no `org_id`, so ownership is enforced through `reports(id, org_id)`. |
| D7 | Key dates | **Typed table** `organization_key_dates` | Extend `custom_field_definitions` with an org entity type | Dates drive scheduler behaviour (reminders, annual roll-over) and need typing; custom field values are structurally device-bound. Contract end dates stay on `contracts` and are unioned into the view. |
| D8 | Recurrence model | **Cadence enum + anchor date**; no `continuous` | `recurrence_rule` jsonb like `maintenance_windows`; a `continuous` cadence | Sold cadences are monthly, quarterly, semiannual, annual, one-time. `maintenance_windows.custom` is not reusable RRULE code (it advances weekly). "Continuous" work has no due date and therefore no delivery record; it is modelled as a monthly checkpoint with `artifact_required=false`. |
| D9 | Templates | **Partner-wide sets** (`org_id XOR partner_id`), applied by copying rows; last wave | Contract-only authoring; or defer out of v1 (codex) | CLAUDE.md "Partner-Wide First": a tier is defined once and applied to every customer, which is the reason this feature exists. Copy-on-apply keeps a customer's schedule stable when the template later changes. Kept in v1 as W05 because W01–W04 do not depend on it. |
| D10 | Portal exposure | Two new **strict** flags `enable_service`, `enable_documents` on `portal_branding`, fail closed; curated delivery records only, never internal tickets | Reuse `enable_reports`; link tickets | Same shape as the five Wave-1 flags. Sweep-created tickets have no portal requester and are internal; the portal shows the delivery record and portal-visible evidence, not the ticket. |
| D11 | ICS feed | **Out of v1** | In W02 (Fable's first position) | The portal replaces the customer calendar; the MSP gets an upcoming view in the web app. No ICS code exists in the repo; a feed is a follow-up issue. |
| D12 | System-produced evidence | Optional `auto_evidence_report_id` on a deliverable; the sweep generates a report run on the due date and attaches it as evidence | Human-only evidence | Backup verification, patch compliance and vulnerability review are things Breeze can prove itself. The technician reviews a report Breeze already made instead of assembling one; the portal gets a real artifact every period. |
| D13 | Recurrence code placement | Pure module `services/recurrence.ts` (period math, materialization plan) consumed by the worker | Inline in `deliverableWorker.ts` | Recurring project tasks and other future schedules reuse it without importing the worker. |
| D14 | Projects-forward boundaries | Occurrences stay flat: no dependencies, phases or estimates; `one_time` means a contractual one-off; evidence join tables are per subject type; template sets are deliverable-specific | Generic polymorphic work/evidence/template tables now | Keeps composite-FK tenancy enforcement and stops deliverables becoming a half-project system. Projects adds its own tables against the same document library, ticket `work_kind` and portal grouping. |

## 3. Scope

In:

- Tables: `service_deliverables`, `service_deliverable_occurrences`,
  `service_deliverable_evidence`, `org_documents`, `organization_key_dates`,
  `deliverable_template_sets`, `deliverable_template_items`, plus two
  `portal_branding` columns and one `tickets.work_kind` column.
- Daily sweep: materialize occurrences, open tickets, mark missed, key-date
  reminders and annual roll-over. Event subscriber: ticket status changes move the
  occurrence per the completion policy.
- Explicit deliver / waive / reopen actions with evidence upload or linking.
- Web (MSP): contract detail "Deliverables" tab; org record "Service" tab (all
  deliverables incl. those with no contract, upcoming view) and "Documents" tab; key
  dates card on the org overview; template sets under settings; portal flags.
- Portal: `/service`, `/documents`, a dashboard tile, downloads.
- REST + MCP tools.
- Backfill of the first customer's deliverables from its existing tracking tickets (W05).

Out (v1):

- ICS / calendar feed (follow-up issue).
- Deliverable SLAs, penalties or credits.
- Customer sign-off on a delivered occurrence; portal is read-only.
- Byte upload over MCP (metadata and evidence linking only).
- Full-text search or preview over documents.
- Moving a deliverable ticket to another org (blocked, see §6).

## 4. Data model

Every composite FK that references an `org_id` column is `DEFERRABLE INITIALLY
IMMEDIATE` (org merge contract, CLAUDE.md). Dates are calendar dates; "today" in
the sweep is computed in the partner's configured timezone, falling back to UTC,
exactly as the billing sweep does (the plan pins the helper).

### 4.1 `service_deliverables` — shape 1 (direct `org_id`)

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| org_id | uuid not null | FK organizations |
| contract_id | uuid null | composite FK `(contract_id, org_id) → contracts(id, org_id)` deferrable, `ON DELETE SET NULL (contract_id)` |
| name | varchar(200) not null | |
| description | text | customer-facing sentence |
| cadence | enum `deliverable_cadence` | `monthly \| quarterly \| semiannual \| annual \| one_time` |
| anchor_due_date | date not null | first due date; the n-th due date is `addMonthsClamped(anchor, n × months)` (`contractMath.ts`), so a 31st anchor clamps to month end |
| effective_from | date not null | default: contract `start_date` when attached, else today |
| effective_until | date null | set by the MSP, or by the contract-cancelled hook (§5.4) |
| lead_days | int not null default 7 | occurrence opens this many days before due |
| grace_days | int not null default 14 | occurrence becomes `missed` this many days after due without delivery |
| artifact_required | bool not null default true | |
| completion_mode | enum `deliverable_completion_mode` | `explicit \| on_ticket_resolve`, default `on_ticket_resolve` (§6) |
| auto_evidence_report_id | uuid null | composite FK `(auto_evidence_report_id, org_id) → reports(id, org_id)` deferrable, `ON DELETE SET NULL`; when set, the sweep generates a run of this report on the due date and attaches it as evidence (§5.3 step 3, D12) |
| owner_user_id | uuid null | FK users; ticket assignee; must hold access to the org (validated in the service) |
| ticket_category_id | uuid null | FK ticket_categories; must belong to the partner (validated) |
| portal_visible | bool not null default true | |
| active | bool not null default true | soft off-switch, history kept |
| sort_order | int not null default 0 | |
| created_by, created_at, updated_at | | |

Unique `(org_id, contract_id, name)` with `contract_id` coalesced to the nil uuid in
a unique index expression, so two contracts may each have a "Monthly report".

Covered period of an occurrence due on D with cadence of m months: `(D − m months,
D]`, clamped. `one_time` has exactly one occurrence at `anchor_due_date`.

### 4.2 `service_deliverable_occurrences` — shape 1

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| org_id | uuid not null | |
| deliverable_id | uuid not null | composite FK `(deliverable_id, org_id) → service_deliverables(id, org_id)` deferrable |
| name_snapshot | varchar(200) not null | deliverable name at materialization; later renames do not rewrite history |
| period_start, period_end | date not null | |
| due_at | date not null | editable (reschedule); `original_due_at` keeps the first value |
| original_due_at | date not null | |
| status | enum `deliverable_occurrence_status` | `scheduled \| open \| awaiting_evidence \| delivered \| missed \| waived` |
| ticket_id | uuid null | composite FK `(ticket_id, org_id) → tickets(id, org_id)` deferrable, `ON DELETE SET NULL (ticket_id)` |
| delivered_at | timestamptz null | |
| delivered_by_user_id | uuid null | |
| delivery_note | text null | shown in the portal |
| waived_at, waived_by_user_id, waived_reason | | all three set together |
| created_at, updated_at | | |

`UNIQUE (deliverable_id, period_start)` is the sweep's idempotency claim. `late` is
derived (`delivered_at::date > due_at`), never stored. `missed` is not terminal.

State machine:

```
scheduled ──(sweep: due_at − lead_days ≤ today)──▶ open
open ──(deliver: evidence ok)──▶ delivered
open ──(ticket resolved/closed, artifact_required, no evidence)──▶ awaiting_evidence
awaiting_evidence ──(evidence added)──▶ delivered
open | awaiting_evidence ──(sweep: due_at + grace_days < today)──▶ missed
missed ──(deliver)──▶ delivered            (shown as late)
open | awaiting_evidence | missed ──(waive: reason)──▶ waived
delivered | waived ──(reopen)──▶ open      (clears delivery/waiver fields; ticket untouched)
```

### 4.3 `service_deliverable_evidence` — shape 1

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| org_id | uuid not null | |
| occurrence_id | uuid not null | composite FK to occurrences deferrable, `ON DELETE CASCADE` |
| kind | enum `deliverable_evidence_kind` | `document \| report_run` |
| document_id | uuid null | composite FK `(document_id, org_id) → org_documents(id, org_id)` deferrable, `ON DELETE CASCADE` |
| report_id | uuid null | composite FK `(report_id, org_id) → reports(id, org_id)` deferrable (`reports_id_org_id_uniq` exists) |
| report_run_id | uuid null | composite FK `(report_run_id, report_id) → report_runs(id, report_id)` `ON DELETE CASCADE`; the migration adds `UNIQUE (id, report_id)` on `report_runs` |
| created_by_user_id, created_at | | |

CHECK: `kind='document'` ⇔ `document_id IS NOT NULL AND report_id IS NULL`;
`kind='report_run'` ⇔ both report columns set. Erasure pre-deletes `report_runs`
(`tenantCascade.ts` ~line 853); `ON DELETE CASCADE` keeps that path clear.

### 4.4 `org_documents` — shape 1

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| org_id | uuid not null | |
| title | varchar(200) not null | |
| description | text | |
| category | enum `org_document_category` | `baseline \| runbook \| policy \| evidence \| report \| export \| other` |
| storage_backend | text not null | `s3 \| db`, chosen once at upload |
| storage_key | text null | `org-documents/<documentId>`; no tenant id in the key, the row is the authority (same reasoning as ticket attachments) |
| data | bytea null | when backend is `db` |
| content_type | varchar(255) not null | |
| byte_size | int not null | |
| sha256 | char(64) not null | |
| original_filename | varchar(255) not null | |
| uploaded_by_user_id | uuid null | |
| portal_visible | bool not null default false | fail closed |
| supersedes_document_id | uuid null | composite self-FK `(supersedes_document_id, org_id)` deferrable; `UNIQUE (supersedes_document_id)` forbids branching; replace requires the target to be a head, which with the unique key rules out cycles |
| deleted_at, deleted_by | | soft delete; erasure clears objects before rows |
| created_at | | |

Library listings and the portal show chain heads. Evidence rows point at a specific
document id, so delivery history keeps the exact version even after replacement.
Size cap and MIME allowlist follow `ticket_attachments`. The blob helper is
extracted from `services/ticketAttachmentStorage.ts` into `services/blobStorage.ts`
with the key prefix as a parameter; the ticket helper becomes a thin wrapper so its
tests still pin behaviour (upload compensation, object-before-row deletion, 503
`STORAGE_UNAVAILABLE`).

### 4.5 `organization_key_dates` — shape 1

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| org_id | uuid not null | |
| label | varchar(200) not null | |
| kind | enum `org_key_date_kind` | `insurance_renewal \| vendor_contract_end \| compliance_deadline \| audit \| other` |
| date | date not null | |
| recurs_annually | bool not null default false | |
| remind_days_before | int null | null = no reminder |
| owner_user_id | uuid null | reminder ticket assignee |
| reminded_for_date | date null | dedupe by identity **and** the date the reminder was for |
| reminder_ticket_id | uuid null | composite FK to tickets deferrable, `ON DELETE SET NULL` |
| portal_visible | bool not null default false | |
| notes | text | |
| created_at, updated_at | | |

Contract end dates are not copied; the read model unions `contracts.end_date` for
contracts whose `end_date >= today` and status not in (`draft`, `cancelled`).

### 4.6 `deliverable_template_sets`, `deliverable_template_items` — dual-axis, `org_id XOR partner_id`

Sets: `id, org_id null, partner_id null, name, description, created_by, timestamps`,
`<table>_one_owner_chk`, unique `(partner_id, name)` and `(org_id, name)`. Items:
`id, set_id (composite with owner columns), org_id null, partner_id null (copied
from the set, same XOR check), name, description, cadence, lead_days, grace_days,
artifact_required, completion_mode, sort_order`. One dual-axis `FOR ALL` policy per
table plus the separate SELECT-only partner-wide branch (template
`2026-10-05-110000-config-policy-partner-wide-select.sql`). Writes to partner-wide
rows gate on `canManagePartnerWidePolicies(auth)`. "Apply set" targets an org (and
optionally a contract) and copies items into `service_deliverables` with
`anchor_due_date` = end of the first full period after `effective_from`.

### 4.7 `portal_branding` columns

`enable_service boolean NOT NULL DEFAULT false`, `enable_documents boolean NOT NULL
DEFAULT false`; added to `PORTAL_VISIBILITY_FLAG_KEYS`
(`services/portal/portalFlags.ts`), gated with `createPortalFeatureGateStrict`,
and classified `included` in `portal_branding`'s export-policy entry (the column
rule).

### 4.8 `tickets.work_kind`

`work_kind ticket_work_kind NOT NULL DEFAULT 'support'`, enum `support \|
deliverable \| project_task` (the third value reserved for Projects, unused in this
feature). Set to `deliverable` by the sweep and by the key-date reminder. Consumers
in this feature: SLA defaults are not applied when `work_kind <> 'support'`; the
ticket list gains a filter; portal ticket lists exclude non-`support` kinds (the
portal shows delivery records, not the tickets behind them). Classified `included`
in `tickets`' export-policy entry (column rule).

### 4.9 Registration checklist (mechanical, same PR as each migration)

For every table in 4.1 to 4.6:

- RLS enabled + forced + policy in the creating migration. Shape 1 tables are
  auto-discovered; the two template tables go in `DUAL_AXIS_TENANT_TABLES` and
  `XOR_OWNERSHIP_DUAL_AXIS_TABLES` in `rls-coverage.integration.test.ts`.
- `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`), alphabetical by
  `localeCompare`, children before parents: `service_deliverable_evidence` before
  `service_deliverable_occurrences` before `service_deliverables`; evidence before
  `org_documents`; `deliverable_template_items` before `deliverable_template_sets`.
  Verify the order the comparator actually produces for each prefix pair (the
  file's own warning near line 368).
- S3 pre-clear in erasure extended from ticket attachments to `org_documents`.
- `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`): every
  column classified; `org_documents.data` → `excludedOpen`; `storage_key` →
  `included`; `sha256` → `reviewedIncluded`; the two new `portal_branding`
  columns and `tickets.work_kind` added to their existing entries.
- `services/orgMergeRegistry.ts`: every new `org_id` table in the plain `repoint`
  list; `deliverable_template_sets` and `service_deliverables` use
  `repoint-dedupe` on their org-scoped unique names.
- No `device_id` anywhere, so no device cascade lists apply.
- Migration filenames sort after the newest committed migration (as of 2026-09-10
  that is `2026-10-15-160010-backup-snapshots-layout-manifest.sql`); re-check with
  `ls apps/api/migrations | sort | tail -1` before committing.

## 5. Scheduler

### 5.1 Job

`deliverable-sweep`, daily, in a new `jobs/deliverableWorker.ts` (same singleton
Queue/Worker/schedule/initialize shape as `contractWorker.ts`). All date arithmetic
and the "which occurrences should exist as of today" plan live in a pure module
`services/recurrence.ts` (D13) with no database or queue imports; the worker only
applies the plan. Cron allocated in
`jobs/scheduleRegistry.ts` on the daily-tier lane (minute ≡ 3 mod 5; the plan picks
a free slot and `scheduleRegistry.contract.test.ts` enforces it). Runs under
`withSystemDbAccessContext`, honours `buildAutomationEligibleOrgPredicate`, one
transaction per deliverable, failures logged with ids and skipped.

### 5.2 Eligibility

A deliverable is swept when `active` and `effective_from <= today` and
(`effective_until IS NULL OR effective_until >= today`). Contract status is **not**
consulted; the contract lifecycle writes `effective_until` instead (§5.4).

### 5.3 Steps per deliverable

1. **Materialize.** Compute every due date `d` from the anchor with `d <= today +
   lead_days`, `d >= effective_from`, and `d > latest materialized due_at`. Insert
   each missing occurrence as `scheduled` (`UNIQUE (deliverable_id, period_start)`
   makes re-runs no-ops), capped at 12 per run. Occurrences whose `d + grace_days <
   today` are inserted directly as `missed`, with no ticket: a sweep that was down
   for weeks produces an honest history, not a burst of tickets.
2. **Open.** For each `scheduled` occurrence with `due_at − lead_days <= today`, in
   one transaction: create the ticket through `ticketService.createTicket`
   (`source='api'`, `work_kind='deliverable'`, subject `"<name_snapshot> — <period
   label>"`, description from the deliverable, `due_date = due_at`, `assigned_to =
   owner_user_id`, `category_id = ticket_category_id`, SLA minutes explicitly
   null), set `ticket_id`, set status `open`. If ticket creation is refused
   (Service Management mode `off`) the occurrence still becomes `open` with
   `ticket_id NULL` and is fulfilled manually; one warning per org per day.
3. **Auto-evidence.** For each `open` occurrence whose deliverable has
   `auto_evidence_report_id`, `due_at <= today`, and no evidence row of kind
   `report_run` created by the sweep: generate a run of that report for the org
   through the existing report runner (`requested_by_kind = 'system'`, added to the
   enum if absent), insert the evidence row, and post an internal ticket comment
   "Report attached, review and resolve". Generation failure logs and leaves the
   occurrence untouched for the next run; the technician can still deliver
   manually. Never generated more than once per occurrence.
4. **Miss.** `open` or `awaiting_evidence` with `due_at + grace_days < today` →
   `missed`. Ticket left alone.
5. **Key dates.** Rows with `remind_days_before` set, `date − remind_days_before <=
   today` and `reminded_for_date IS DISTINCT FROM date`: create a reminder ticket
   (no SLA, assignee `owner_user_id`) and stamp `reminded_for_date`,
   `reminder_ticket_id`. Rows with `recurs_annually` and `date < today`: `date +=
   1 year`.

### 5.4 Contract lifecycle hook

On `contract.cancelled` (existing contract event) every deliverable with that
`contract_id` and `effective_until IS NULL` gets `effective_until = cancellation
date`. `paused` does not touch deliverables (billing pause is not a service pause;
the MSP edits `effective_until` or `active` if it is). `expired` is ignored (D1).

## 6. Ticket integration

- **Creation**: only through `ticketService.createTicket`, so numbering, events,
  the Service Management `off` refusal and outbox publication apply.
- **Status subscriber**: `deliverable-status` registered in
  `services/eventSubscribers.ts` for `ticket.status_changed` (lazy import, same
  pattern as `ai-agent-ticket-helpdesk`). If an occurrence has that `ticket_id`:
  - `to ∈ {resolved, closed}` and `completion_mode = on_ticket_resolve`: if
    `artifact_required` and no evidence row → `awaiting_evidence`; else →
    `delivered` (`delivered_by` = actor when present, `delivery_note` = the
    ticket's resolution note when present).
  - `to ∈ {resolved, closed}` and `completion_mode = explicit`: no change; the MSP
    must press Deliver. The occurrence drawer shows "ticket resolved, delivery not
    recorded".
  - `to ∈ {new, open, pending, on_hold}` from `delivered` reached via the ticket:
    → `open`, delivery fields cleared. An explicit UI delivery is never undone by
    a ticket reopen.
  - Idempotent; the same event twice is a no-op.
- **Ticket move between orgs** (`move_org`): blocked with 409
  `DELIVERABLE_TICKET_PINNED` when the ticket is linked to an occurrence; the guard
  sits next to the existing move-org checks (`ticketOrgMoveLockOrder.ts`).
- **Ticket soft delete** leaves the occurrence and its link; hard delete nulls
  `ticket_id`.

## 7. Delivery and evidence

Actions (REST + MCP + UI):

- **Deliver** `{ note?, evidence?: [{documentUpload | documentId | reportRunId}] }`:
  when `artifact_required` and the occurrence has no evidence after this call →
  400 `EVIDENCE_REQUIRED`. Uploaded evidence creates an `org_documents` row with
  `category='evidence'` and `portal_visible` copied from the deliverable.
- **Add evidence** on any non-waived occurrence; on `awaiting_evidence` this
  completes delivery.
- **Waive** `{ reason }` records actor and reason.
- **Reopen** clears delivery or waiver fields.
- **Reschedule** `{ dueAt }` moves `due_at`; `original_due_at` is kept and the
  portal shows "rescheduled".

Effort is not stored on occurrences. Time spent on a deliverable is the time logged
against its ticket (`ticket_time_entries`), which is the same source a future
Projects module will use for budget vs actual. No separate effort field, ever.

## 8. Portal surface

Flags fail closed. Routes follow the portal auth, CSRF, ETag and
`private, max-age=30` pattern of `dashboard.ts`.

- `GET /portal/service` → `{ groups: [{ source: 'contract' | 'standalone',
  contract: {id, name} | null, deliverables: [{ id, name, description, cadence,
  artifactRequired, lastDelivered: { at, late, note, evidence: [...] } | null,
  nextDue: date | null, status: 'on_track' | 'due_soon' | 'late' | 'missed' }] }],
  keyDates: [{ source: 'key_date' | 'contract_end', ... }] }` for `portal_visible`
  deliverables in their effective window plus `portal_visible` key dates and
  contract end dates. The `source` discriminators exist so a Projects module can add
  `'project'` and `'project_milestone'` arms to the same page rather than a second
  one.
- `GET /portal/service/:deliverableId/occurrences` → last 24 occurrences: status,
  dates, note, evidence links.
- `GET /portal/documents` → chain heads with `portal_visible = true`, grouped by
  category. `GET /portal/documents/:id/content` streams bytes with
  `contentDispositionFor`; never a presigned URL.
- Dashboard tile `serviceTile`: delivered on time / late / missed over the last 90
  days and the next due item; added to `dashboardForOrg`'s `Promise.all`.

Publication rules (D10):

- The portal never shows or links a ticket. It shows the delivery record (date,
  lateness, note) and evidence.
- Document evidence appears under `enable_service` when the document is
  `portal_visible`, regardless of `enable_documents` (which governs the library
  page only).
- Report-run evidence appears only when `enable_reports` is on and the report
  definition is `portal_self_service`; otherwise the record reads "Delivered" with
  the note.
- A delivered occurrence with `artifact_required` and no portal-visible evidence
  shows "Delivered (artifact held by the MSP)". Nothing pretends evidence exists.

Pages: `apps/portal/src/pages/service/index.astro`,
`apps/portal/src/pages/documents/index.astro`, nav entries gated by the flags.
All new tables are shape 1, so `breeze_has_org_access(org_id)` is the only policy
exercised by portal reads. `portalServiceRls.integration.test.ts` forges a
cross-org read of each route.

## 9. Web UI (MSP)

- Contract detail (`components/contracts/ContractDetail.tsx`): "Deliverables" tab
  (hash state): table with cadence, next due, last delivered, portal toggle; edit,
  deactivate, "Apply template set"; occurrence drawer with Deliver (evidence
  upload or pick), Waive, Reopen, Reschedule, open-ticket link.
- Org record (`components/organizations/record/`): new `service` tab (every
  deliverable for the org, contract or not, plus a 90-day upcoming list) and
  `documents` tab (upload, replace as a superseding version, portal toggle,
  download), both in `ORG_RECORD_TABS` with `TAB_PERMISSION` entries; key dates
  card on the overview.
- Settings: "Deliverable templates" page, partner-wide sets with the "All orgs"
  badge and create-only ownerScope selector (pattern
  `components/software/PolicyForm.tsx`); portal settings gain the two toggles.
- All mutation handlers via `runAction`; new i18n keys in every locale with real
  translations.

## 10. API surface and MCP tools

REST (Hono):

- `routes/serviceDeliverables.ts`: `GET/POST /orgs/:orgId/deliverables`,
  `PATCH/DELETE /orgs/:orgId/deliverables/:id`, `POST
  /orgs/:orgId/deliverables/apply-template`, `GET
  /orgs/:orgId/deliverables/:id/occurrences`, `POST
  /orgs/:orgId/deliverables/occurrences/:oId/{deliver|waive|reopen|reschedule}`,
  `POST/DELETE .../occurrences/:oId/evidence[/:eId]` (multipart or
  `{ documentId } | { reportRunId }`). `GET /contracts/:id/deliverables` is a
  filtered view of the org route for the contract tab.
- `routes/orgs/documents.ts`: `GET/POST /orgs/:orgId/documents` (multipart), `GET
  .../:id/content`, `PATCH .../:id`, `POST .../:id/replace`, `DELETE .../:id`.
- `routes/orgs/keyDates.ts`: `GET/POST/PATCH/DELETE /orgs/:orgId/key-dates`.
- `routes/deliverableTemplates.ts`: sets and items CRUD.

Permissions: deliverables and templates reuse the `contracts` resource; documents
and key dates get a new `documents` resource (`read`, `write`) in the canonical
registry `packages/shared/src/constants/permissions.ts` and the role matrix,
defaulting on for admin and technician roles. The org record tabs gate on
`contracts:read` (service) and `documents:read` (documents).

MCP tools (`services/aiToolsDeliverables.ts`, registered in the `aiTools.ts` hub):
`list_deliverables`, `manage_deliverables` (create, update, deactivate,
apply_template, deliver, waive, reopen, reschedule, link_evidence by document or
report-run id), `list_org_documents`, `manage_org_documents` (metadata, portal
visibility, supersede-by-id; no byte upload), `manage_key_dates`. `apply_template`
is approval-gated (it arms unattended ticket creation); the rest are not.

## 11. Tenancy contract

- Shape 1 for 4.1 to 4.5; dual-axis XOR with the SELECT-only partner branch for 4.6.
- Every FK to a tenant row is composite with `org_id` and deferrable; `report_runs`
  is reached through `reports(id, org_id)`.
- Sweep and subscriber run under `withSystemDbAccessContext` (via
  `runOutsideDbContext` when reached from a request); worker-created tickets,
  occurrences and evidence always take the **deliverable's** org.
- `owner_user_id` and `ticket_category_id` are validated for partner/org access at
  write time in the service layer.
- Portal routes run as the portal session's org; no system escalation in any
  portal read model.
- Documents stream through the API under RLS; no presigned URLs.

## 12. Error handling

- Sweep: per-deliverable transaction; a failure logs ids and continues (billing
  sweep pattern); a refused ticket leaves the occurrence `open` without a ticket.
- Deliver without required evidence → 400 `EVIDENCE_REQUIRED`.
- Upload over the size cap or outside the MIME allowlist → 413 / 415 with a
  translated message; storage fault → 503 `STORAGE_UNAVAILABLE`, no row written.
- Evidence link to a document or report run of another org → 404, never 403.
- Apply template set where a deliverable name already exists on the target → 409
  listing the collisions, nothing written.
- Replace a document that already has a successor → 409 `NOT_HEAD`.
- Move a deliverable ticket to another org → 409 `DELIVERABLE_TICKET_PINNED`.

## 13. Testing

- Unit (`services/recurrence.ts`): due-date arithmetic (clamped month ends, anchor
  on the 31st, `one_time`), covered-period boundaries, catch-up materialization
  plan (cap 12, direct `missed`); worker: auto-evidence once-only,
  state machine transitions incl. `awaiting_evidence`, subscriber idempotency,
  evidence badge derivation, template apply anchor computation.
- Route tests (Vitest + Drizzle mocks) for every new route, including 404-not-403
  on cross-org ids and `EVIDENCE_REQUIRED`.
- Integration (real Postgres): `serviceDeliverablesRls.integration.test.ts`
  (cross-org forge 42501, deferrable re-point under `SET CONSTRAINTS ALL DEFERRED`,
  template XOR 23514, evidence ownership chain rejects a foreign report run),
  `deliverableSweep.integration.test.ts` (materialize → open → resolved →
  `awaiting_evidence` → delivered via a real `ticket.status_changed`; miss after
  grace; idempotent re-run; downtime catch-up; `off` mode opens without a ticket;
  cancelled-contract hook; auto-evidence run generated on due date and attached), `portalServiceRls.integration.test.ts`, plus the
  standing contract suites: `rls-coverage`, `tenantCascade`, `tenant-export-policy`,
  `tenantExportErasureRoundtrip` (with an S3-backed document),
  `orgLifecycleFoundations` (merge), `scheduleRegistry.contract.test.ts`.
- Web: component tests for the tabs and drawer; `no-silent-mutations`; locale
  coverage. Portal: page tests alongside the existing `*/index.test.ts`.

## 14. Wave split (one PR each)

| Wave | Content | Depends on |
|---|---|---|
| W01 | Migrations + schema + registrations for 4.1, 4.2, 4.3 (without `document` kind), 4.5, 4.8 (`tickets.work_kind`); `services/recurrence.ts`; services; REST for deliverables, occurrences (deliver with report-run evidence, waive, reopen, reschedule), key dates; contract Deliverables tab; org record Service tab; key dates card | — |
| W02 | `deliverableWorker` sweep incl. auto-evidence report generation, `deliverable-status` subscriber, contract-cancelled hook, move-org guard, key-date reminders and roll-over, SLA suppression for non-`support` work kinds, MCP tools for deliverables and key dates | W01 |
| W03 | `org_documents` migration + blob helper extraction + erasure pre-clear + REST + org record Documents tab + `document` evidence kind + upload-on-deliver + MCP document tools | W01 |
| W04 | Portal: flags, `/service`, `/documents`, dashboard tile, downloads, publication rules, portal RLS test | W02, W03 |
| W05 | Template sets (4.6), settings page, apply-to-org/contract, first-customer backfill script (eight deliverables on the Northwind Law org and its Best-plan contract, seeded from its existing tracking tickets; ids supplied at run time, never committed) | W01 |

W03 and W05 run in parallel with W02.

## 15. First use: Northwind Law P.C. (fictional name)

The eight Best deliverables map as: sign-in log review (monthly, artifact
required), threat detection review (monthly, required), Intune management (monthly
checkpoint, artifact optional), vulnerability management (monthly, required),
documentation and configuration audit (quarterly, required), firewall rule review
(quarterly, required), VPN and access policy management (monthly checkpoint,
optional), IR runbooks and tabletop (annual, required). `effective_from` = contract
start (provisional), owner = the account technician, `completion_mode = on_ticket_resolve`.
Vulnerability management carries `auto_evidence_report_id` pointing at the org's
vulnerability report definition so each monthly occurrence arrives with the scan
result attached; a backup-verification deliverable would do the same with the
backup SLA report.
Key dates: cyber-insurance renewal, incumbent email-security vendor end date,
contract term end (from the contract). Portal flags `enable_service` and
`enable_documents` on after the onboarding documentation set is uploaded.

## 16. Non-goals and known limits

- No customer acknowledgement of delivery; portal read-only.
- No ICS feed, no full-text search, no document preview.
- Cadence or anchor changes do not rewrite existing occurrences.
- Occurrences have no dependencies, phases, estimates or sub-tasks. `one_time` is
  a contractual one-off (a tabletop, a baseline handover), not project work; when
  Projects lands, project tasks get their own tables and reuse `org_documents`,
  `tickets.work_kind`, `services/recurrence.ts` and the portal `source` arms (D14).
- No generic polymorphic evidence or template tables; one join table per subject
  type keeps composite-FK tenancy enforcement.
- Checkpoint deliverables (former "continuous") have a due date but usually no
  artifact; their on-time metric is the checkpoint, not the underlying work.

## 17. Quorum record (2026-09-10)

Codex gpt-6-astra, `xhigh`, read-only, twelve findings against the Fable draft.

| Codex finding | Verified | Resolution |
|---|---|---|
| 1. Contract `active` cannot gate service; `expired` is set right after the final invoice | Yes, `contractService.ts` ~2013 | Adopted: eligibility by `effective_from/until`, contract status ignored (D1, §5.2). |
| 2. Org-own deliverables, nullable `contract_id` | Yes, `contract_documents.contract_id` nullable precedent | Adopted (D1); renamed `service_deliverables`. |
| 3. Occurrences justified; snapshot + explicit transaction | Yes | Adopted: `name_snapshot`, one transaction per claim + ticket (§5.3). |
| 4. Reuse tickets; hook at `changeTicketStatus` | Yes, ~999 | Tickets reused. Hook kept on the event bus subscriber (repo precedent, retried, decoupled) rather than inside `changeTicketStatus`; acceptable because D4 makes the transition advisory, not the record of delivery. Tie-break: Fable. |
| 5. Closure ≠ delivery; waiver actor; `missed` not terminal | Yes, ~942/967 | Adopted: `completion_mode`, `awaiting_evidence`, waiver fields, `missed → delivered` (D4, §4.2, §6). |
| 6. SLA clock from `created_at`; `off` mode; occurrences must survive no ticket | Yes, `ticketSlaWorker.ts` ~74 | Adopted: SLA null on sweep tickets; `open` without ticket allowed (§5.3). |
| 7. Extract storage, org-free keys, extend erasure pre-clear, multi-evidence, exact-version history, chain integrity | Yes, `tenantCascade.ts` ~1111 | Adopted: evidence join table (D6), `UNIQUE (supersedes_document_id)`, pre-clear extended (§4.4, §4.8). |
| 8. Typed key dates; dedupe by identity + date | Yes | Already `reminded_for_date`; added `owner_user_id`. |
| 9. Simple cadence; drop undefined `continuous`; define boundaries | Yes, `maintenance.ts` route ~281 | Adopted: `continuous` removed, checkpoint pattern, period/timezone/catch-up defined (D8, §4.1, §5.3). |
| 10. Secondary refs need `org_id`; ticket move; `report_runs` has no `org_id`; erasure FK | Yes, `reports.ts` ~96, `tenantCascade.ts` ~853 | Adopted: composite FKs everywhere, move blocked, evidence chain through `reports(id, org_id)` with `ON DELETE CASCADE` (§4.3, §6). |
| 11. Register merge policies; classify new branding columns | Yes | Adopted (§4.7, §4.8). |
| 12. Portal publication rules; report evidence needs `portal_self_service` | Yes, `reportsSelfService.ts` ~174 | Adopted (D10, §8). |
| Recommendation: defer ICS and templates | — | ICS deferred (D11). Templates kept as the last wave (D9) because they are the stated reason for the feature and no earlier wave depends on them. |

Post-quorum additions 2026-09-10 (Todd's review): D12 auto-evidence, D13 recurrence
module, D14 Projects-forward boundaries and `tickets.work_kind` replacing the tag
(codex finding 4 had flagged the missing discriminator).
