# Ticketing Phase 3 — Native Time Tracking + Parts (Design)

Date: 2026-06-11
Status: Approved (brainstorm session with Todd)
Parent spec: `2026-06-09-native-ticketing-design.md` (Phase 3 scope; §8a extensibility constraints apply verbatim)
Prior phases: Phase 1 core+UI (#1196/#1223/#1227), operator gaps (#1251), Phase 2 SLA engine (#1250), residuals (#1261)

## 1. Scope & Decisions

Implements the parent spec's Phase 3: `time_entries` + `ticket_parts`, `timeEntryService`, technician routes, timer widget, `/timesheet` page, billables CSV export, AI tools. NO invoicing — these tables are the billing input surface only (§8a).

Decisions made in this session:

- **D1 — Approval: full flow in v1.** `is_approved`/`approved_by`/`approved_at` columns, approve/unapprove + bulk-approve routes, timesheet approval UI for admins, `is_approved` column in the billables CSV.
- **D2 — Rate resolution: category default + manual override.** Ticket-linked entries default `hourly_rate`/`is_billable` from the ticket category's `defaultHourlyRate`/`defaultBillable`; non-ticket entries default to null rate. Per-entry override always allowed. No partner-level or per-technician rate storage in v1.
- **D3 — Timer clash: auto-stop previous.** `startTimer` atomically stops any running entry for the user (folding floored duration) and starts the new one, in one transaction. Retry-once on the partial-unique-index violation race.
- **D4 — Portal/org visibility: internal-only in v1.** Time entries and parts are technician-facing only. No portal RLS policies, no org-scope read surface, nothing in portal API responses. `cost_basis` and margin must never leave the MSP regardless of future changes. Billing transparency arrives with the future invoicing module.
- **D5 — Permissions: new `time_entries` resource.** Seed `time_entries:read`/`time_entries:write` (+ `RESOURCE_LABELS` entry in permissionsCatalog). Holders of `write` manage their OWN entries; managing others' entries, approval, and the partner-wide timesheet require an additional partner-admin check enforced in the service. Parts ride on `tickets:write`. No separate `approve` permission in v1.
- **D6 — Delivery: two-PR chain** (mirrors Phase 1a/1b). PR 1 backend: migration, schema, service, routes, validators, AI tools, export. PR 2 frontend: timer widget, timesheet page, ticket-detail time/parts UI, feed renderer.

## 2. Data Model

One migration `2026-06-12-<x>-ticketing-time-parts.sql` (idempotent, RLS in the same migration, no inner BEGIN/COMMIT). Schema in a new `apps/api/src/db/schema/timeTracking.ts` (tickets.ts is already large).

### `time_entries` — Shape 3 (partner-axis), STANDALONE by design (§8a: timesheets and non-ticket work, not just ticket time)

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| partner_id | uuid NOT NULL | RLS axis: `breeze_has_partner_access(partner_id)` |
| org_id | uuid NULL | denormalized from ticket at write time when ticket-linked (RLS nested-EXISTS rule); filtering only, NOT an RLS axis |
| ticket_id | uuid NULL, FK tickets ON DELETE SET NULL | |
| user_id | uuid NOT NULL | the technician the time belongs to |
| started_at | timestamptz NOT NULL | |
| ended_at | timestamptz NULL | NULL = running timer |
| duration_minutes | integer NULL | stamped on stop / manual create; FLOORED minutes (matches SLA pause-folding convention) |
| description | text | |
| is_billable | boolean NOT NULL default false | defaulted per D2 |
| hourly_rate | numeric(10,2) NULL | stamped per D2; currency is partner-level for now (§8a: per-row currency column addable later without backfill pain) |
| billing_status | `billing_status` enum NOT NULL default 'not_billed' | `not_billed \| billed \| no_charge \| contract` |
| is_approved | boolean NOT NULL default false | |
| approved_by | uuid NULL | |
| approved_at | timestamptz NULL | |
| created_at / updated_at | timestamptz | |

- **Partial unique index:** `UNIQUE (user_id) WHERE ended_at IS NULL` — one running timer per user, DB-enforced.
- Indexes: `(partner_id, started_at)`, `(ticket_id)`, `(user_id, started_at)`.
- RLS: enabled + forced; partner policy only (D4: no portal/org policies). Allowlist: `PARTNER_TENANT_TABLES` in `rls-coverage.integration.test.ts`, same PR.

### `ticket_parts` — Shape 1 (direct org_id, auto-discovered RLS)

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| ticket_id | uuid NOT NULL, FK tickets ON DELETE CASCADE | |
| org_id | uuid NOT NULL | denormalized from parent ticket |
| description | text NOT NULL | parts stay usable free-text forever (§8a; nullable `catalog_item_id` FK arrives with a future `catalog_items` table) |
| part_number / vendor | text NULL | |
| quantity | numeric(10,2) NOT NULL | > 0 |
| unit_price | numeric(10,2) NOT NULL default 0 | ≥ 0 |
| cost_basis | numeric(10,2) NULL | MSP-internal; never exposed outside MSP (D4) |
| is_billable | boolean NOT NULL default true | |
| billing_status | `billing_status` enum NOT NULL default 'not_billed' | shared enum with time_entries |
| added_by | uuid NULL | |
| notes | text NULL | |
| created_at / updated_at | timestamptz | |

- Margin (`quantity*unit_price − quantity*cost_basis`) is computed, never stored.
- Index: `(ticket_id)`.

### Cross-cutting schema work in the same migration/PR

- New enum `billing_status`.
- Permissions seeded: `time_entries:read`, `time_entries:write`; `RESOURCE_LABELS` entry added (Phase 1a lesson).
- **moveOrg:** ticket-linked `time_entries.org_id` and `ticket_parts.org_id` strand on cross-org ticket/device moves — same class as `ticket_alert_links` in #1261. Both tables get `CUSTOM_ORG_REWRITE_TABLES` handling (join through tickets) in PR 1, not as a later review finding.
- Device hard-delete: no device FK on either table — no `DEVICE_DETACH_DEVICE_ID_TABLES` change needed. Ticket CASCADE deletes parts; SET NULL orphans time entries into non-ticket timesheet rows (intended: the time was still worked).

## 3. Service Layer — `apps/api/src/services/timeEntryService.ts`

Mirrors `ticketService.ts`. Routes, AI tools, and MCP are equal consumers; no handler-only logic (§8a).

Mutations:

- `createTimeEntry(input, actor)` — manual entry. Ticket-linked: same-partner ticket validation via **system DB context** read (org-scope RLS hides rows during validation — #1243 lesson), denormalize `org_id`, default `is_billable`/`hourly_rate` from the ticket's category unless explicitly provided (D2).
- `startTimer(input, actor)` — D3 semantics: one transaction stops the user's running entry (stamp `ended_at`, fold floored `duration_minutes`) then inserts the new running row; retry-once on partial-unique violation.
- `stopTimer(actor, opts)` — stamps `ended_at` + duration; error if no running entry (TicketServiceError-style `code`).
- `updateTimeEntry` / `deleteTimeEntry` — **own-vs-all in the service** (D5): `time_entries:write` covers own entries; others' entries require partner-admin. Approved entries are immutable except by an approver; any edit clears `is_approved` (re-approval required).
- `approveTimeEntries(ids, actor)` / `unapproveTimeEntries` — admin-gated, bulk-capable, stamps approver fields, returns per-id `skippedReasons` tally (bulk-tickets pattern).
- `addTicketPart` / `updateTicketPart` / `deleteTicketPart` — same-partner ticket validation, `org_id` denormalized, billable default from category; authz rides on `tickets:write`.

Queries: `listTimeEntries(filters)` (user, ticket, org, date range, running, billing_status, approved), `getRunningTimer(userId)`, `getTimesheet(userId, weekStart)` (per-day aggregation), `listTicketParts(ticketId)`, `getTicketBillingSummary(ticketId)` (time total, billable amount, parts total — detail rail).

**Lifecycle events** through the single dispatch point (`ticketEvents.ts` pattern): `time_entry.created`, `time_entry.updated`, `time_entry.deleted`, `time_entry.approved` as a typed `TimeEntryEvent` union with producer→consumer contract tests. Ticket-linked entries also surface in the ticket activity feed via the existing `commentType='time_entry'` enum stub (renderer added in PR 2).

**Site-scope:** per-ticket routes go through `getScopedTicketOr404` (existing device-derived site gate). The standalone `/time-entries` surface is partner-internal technician data with no device axis — not site-gated. AI tool extensions get the same site-scope treatment as the #1261 `manage_tickets` fix.

## 4. Routes & Validators

New `apps/api/src/routes/tickets/timeEntries.ts` + `parts.ts`, mounted from the `routes/tickets/index.ts` hub (auth middleware applied at the hub — Phase 1a 401 lesson). Literal paths (`/running`, `/start`, `/bulk-approve`, `/timesheet`, `/export/...`) registered before `/:id`.

| Route | Auth | Notes |
|---|---|---|
| `GET /time-entries` | `time_entries:read` (own entries always visible) | filters per §3 |
| `POST /time-entries` | `time_entries:write` | manual entry |
| `GET /time-entries/running` | authed | current user's running timer (widget poll) |
| `POST /time-entries/start` | `time_entries:write` | D3 auto-stop |
| `POST /time-entries/:id/stop` | `time_entries:write` | own only |
| `PATCH /time-entries/:id` / `DELETE` | `time_entries:write` (+admin for others') | |
| `POST /time-entries/bulk-approve` | admin | `skippedReasons` tally |
| `GET /time-entries/timesheet?userId&weekStart` | own; admin for others | |
| `GET /tickets/:id/time-entries` | `tickets:read` | via `getScopedTicketOr404` |
| `GET/POST /tickets/:id/parts` | `tickets:read`/`tickets:write` | via `getScopedTicketOr404` |
| `PATCH/DELETE /tickets/parts/:id` | `tickets:write` | scope via parent ticket |
| `GET /tickets/export/billables.csv?from&to&orgId` | `tickets:read` + `time_entries:read` | billable time + parts rows, includes `is_approved` |

Validators in `packages/shared/src/validators/timeEntries.ts`: `createTimeEntrySchema` (refinements: `ended_at > started_at`, duration consistency, rate ≥ 0, `started_at` not in the future beyond small skew), `updateTimeEntrySchema`, `ticketPartSchema` (quantity > 0, prices ≥ 0), `billablesExportQuerySchema`. Tests alongside.

**AI tools:** extend `services/aiToolsTicketing.ts` with `log_time_entry`, `start_timer`, `stop_timer` (thin wrappers over `timeEntryService`); register in `aiToolSchemas` + `aiGuardrails` `TOOL_PERMISSIONS` (fail-closed registries), writes tier 3.

## 5. Frontend (PR 2)

- **Timer widget** in the app header. Astro MPA: fetch `/time-entries/running` on mount, tick locally, slow poll for cross-tab changes. Start from ticket detail ("Start timer" stamps ticketId). Widget shows elapsed + ticket number; stop opens a description/billable confirm popover.
- **Ticket detail:** right-rail "Time & Billing" card (`getTicketBillingSummary`), time-entry quick-add, parts table (add/edit/delete; cost_basis + margin visible — internal-only UI per D4), `time_entry` renderer in `TicketFeed`.
- **`/timesheet` page:** week navigator, per-day entries, admin tech-selector, inline edit, approval checkboxes + bulk-approve, weekly billable/non-billable totals.
- **Settings → Ticketing:** billables CSV export (date range + org picker) added to the existing page.
- All mutations through `runAction`; bump `no-silent-mutations` `TARGET_GLOBS` count when enrolling files. No client-side permission store — buttons render for everyone, API enforces (established pattern).
- Hash-based URL state for timesheet week/tech selection (project convention; no query params for transient UI state).

## 6. Testing

Per breeze-testing checklist:

- Route tests alongside route files (Drizzle mocks; feed the category-default lookup selects — #1238 contract-test lesson).
- Validator tests in `packages/shared`.
- Real-driver integration tests: cross-partner time-entry/part isolation as `breeze_app` (forged insert must fail), rls-coverage allowlist entries, timer-start concurrency (two racing starts → exactly one running row), approval flow incl. edit-clears-approval, moveOrg org_id rewrite for both tables.
- Producer→consumer event contract tests for `TimeEntryEvent`.
- Component tests: timer widget, timesheet page, parts table.
- Playwright e2e (start timer → resolve with billables) goes to the existing deferred ticketing-e2e backlog item, not this phase.

## 7. Explicitly Out of Scope (v1)

Invoicing/invoices tables; partner-level or per-technician rates (D2); portal/org visibility of time or parts (D4); separate `time_entries:approve` permission (D5); service catalog / `catalog_item_id`; per-row currency; accounting-integration mapping tables; business-hours awareness for timers. All have §8a-compatible extension paths and none require core-table changes later.
