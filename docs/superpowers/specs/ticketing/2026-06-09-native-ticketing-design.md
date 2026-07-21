# Native Ticketing — Design Spec

**Date:** 2026-06-09
**Status:** Approved design, pre-implementation
**Scope decision:** Build ticketing natively in Breeze rather than integrating with LanternOps. LanternOps (Django) code is not portable, but its production-tested data model and business logic serve as the blueprint.

## Background / Current State (verified 2026-06-09)

- `tickets` + `ticket_comments` tables exist in `apps/api/src/db/schema/portal.ts` with status enum (`new/open/pending/on_hold/resolved/closed`), priority enum (`low/normal/high/urgent`), assignment, device linking, `firstResponseAt`/`resolvedAt`, RLS (org-scoped, shape 1).
- The **only** API surface is `apps/api/src/routes/portal/tickets.ts` — portal-auth scoped, list filtered to `submittedBy = current portal user`. There is **no admin/technician API at all**: no org-wide list, no status change route, no technician comment route. The lifecycle has never advanced past `new` in practice.
- `apps/portal` has working end-user ticket pages (list/create/detail/comments). `apps/web/src/components/portal/{TicketList,TicketDetail,CreateTicketForm}.tsx` are **orphaned duplicates** that drift from the schema (use `priority: 'medium'`, omit `new`/`on_hold`) — delete in Phase 1, do not reuse.
- PSA integration (`psa_connections`, `psa_ticket_mappings`) maps **alerts** to external PSA tickets. This is a separate feature and stays untouched.
- `apps/docs` `portal.mdx` over-promises a technician workflow; being softened in a separate change. Re-update when Phase 1 ships.
- Reusable infra: email service (Resend/SMTP/Mailgun, `services/email.ts`), notification channels + routing rules + escalation policies (`schema/alerts.ts`), in-app notifications (`user_notifications`), BullMQ, AI tools registry (`services/aiTools*.ts`), RBAC.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| v1 scope | Core tech ticketing + SLA engine + time tracking & parts + email-to-ticket (phased) |
| Queue scope | Partner-wide technician queue (tickets stay org-scoped; partner-scope RLS already spans orgs), filterable by org/site |
| Inbound email | Provider webhook (Mailgun Routes / Resend Inbound), abstracted like outbound email |
| Alert linkage | Manual create-from-alert AND alert-rule `createTicket` action with dedup |
| PSA coexistence | Keep both; partner picks native and/or external PSA. Native↔PSA sync out of scope |
| Billing depth | Time entries with rates/billing status + parts (qty, unit price, cost basis). No invoice generation. CSV export of billables |
| Workflow customization | Fixed status enum + per-partner custom categories (with SLA/billing defaults). Custom statuses deferred |
| Schema approach | Extend existing `tickets`/`ticket_comments` in place (Approach A). No new ticket store, no data migration, portal keeps working |

## 1. Data Model

### Changed: `tickets`

Add columns (all nullable / defaulted — idempotent migration):

- `category_id` FK → `ticket_categories`
- `pending_reason` text — why a ticket is `pending`/`on_hold` (e.g. waiting on customer vs vendor); avoids new enum values
- `due_date` timestamptz
- SLA: `response_sla_minutes` int, `resolution_sla_minutes` int, `sla_breached_at` timestamptz, `sla_breach_reason` text, `sla_paused_at` timestamptz, `sla_paused_minutes` int (accumulated pause time)
- `source` enum `ticket_source` = `portal | email | alert | manual | api | ai` (default `portal` for existing rows)
- `internal_number` text — per-partner sequential, format `T-{YYYY}-{seq:04d}`, unique per partner
- `email_message_id` text, `email_thread_key` text — inbound threading
- `closed_by` FK → users, `resolution_note` text

### Changed: `ticket_comments`

- `comment_type` enum `ticket_comment_type` = `comment | internal | status_change | assignment | time_entry | system` (default `comment`)
- `old_value` text, `new_value` text — for change-tracking entries
- Becomes the unified activity feed: status changes and assignments are written as feed entries.

### New tables

All created with RLS enabled+forced+policies **in the same migration**; allowlists updated in `rls-coverage.integration.test.ts` in the same PR.

| Table | Tenancy shape | Key columns |
|---|---|---|
| `ticket_categories` | 3 (partner-axis) | partner_id, name, color, parent_id (self-FK), default_priority, response_sla_minutes, resolution_sla_minutes, default_billable, default_hourly_rate, sort_order, is_active |
| `time_entries` | 3 (partner-axis; org_id and ticket_id **nullable**) | partner_id, org_id nullable, ticket_id nullable, user_id, started_at, ended_at nullable (`NULL` = running timer), duration_minutes, description, is_billable, hourly_rate, billing_status enum (`not_billed/billed/no_charge/contract`), is_approved, approved_by, approved_at. Partial unique index: one running timer per user (`WHERE ended_at IS NULL`). Standalone by design — supports technician timesheets and non-ticket work, not just ticket time |
| `ticket_parts` | 1 | ticket_id, org_id, description, part_number, vendor, quantity numeric, unit_price numeric, cost_basis numeric, is_billable, billing_status, added_by, notes |
| `ticket_alert_links` | 1 | ticket_id, org_id, alert_id, link_type enum (`created_from/attached/auto`), unique (ticket_id, alert_id) |
| `ticket_email_inbound` | 3 (partner-axis) | partner_id, provider_message_id, from_address, to_address, subject, parse_status (`matched/created/failed/ignored`), ticket_id nullable, error text, raw metadata jsonb. Audit trail + dead-letter view |
| `partner_ticket_sequences` | 3 (partner-axis) | partner_id, year, counter. Allocation via `UPDATE … RETURNING` (race-safe) |

Margin on parts is computed (`quantity*unit_price - quantity*cost_basis`), not stored.

## 2. Service Layer & API Surface

**Service layer first (AI-agent/MCP-first structure):** core mutations and queries live in `apps/api/src/services/ticketService.ts` (+ `timeEntryService.ts`), NOT in route handlers. REST routes, AI tools, the MCP server, and future workflow actions all call the same service functions. Route handlers stay thin (auth + validation + call service). This is a hard requirement, not a style preference — logic embedded in Hono handlers is unreachable from AI/automation surfaces.

**Lifecycle events:** the service layer emits ticket events (`ticket.created`, `ticket.status_changed`, `ticket.assigned`, `ticket.commented`, `ticket.sla_breached`) through a single dispatch point (BullMQ + event log), so native workflows/automations can subscribe later without modifying ticket code. Phase 1 consumers: notification fan-out. Future consumers: workflow engine, integration syncs.

New technician-facing routes in `apps/api/src/routes/tickets.ts` (split per File Size Guideline as needed: `tickets.ts`, `timeEntries.ts`, `ticketCategories.ts`, `ticketEmailWebhook.ts`). Portal routes (`routes/portal/tickets.ts`) unchanged.

- `GET /tickets` — partner-wide queue. Filters: status group (open/closed), individual status, org, site, assignee (incl. me/unassigned), category, priority, SLA state (ok/at-risk/breached), text search. Sorts: triage order (priority + SLA urgency), newest, oldest, due date. Paginated.
- `POST /tickets` — manual creation (org required, device optional)
- `GET /tickets/:id` — full detail incl. comments, time entries, parts, alert links
- `PATCH /tickets/:id` — fields incl. category, priority, due date
- `POST /tickets/:id/assign` — assignee (writes assignment feed entry)
- `POST /tickets/:id/status` — enforced transitions; `resolved` requires resolution note and stamps `resolvedAt`; `closed` stamps `closedAt`+`closedBy`; first public technician comment stamps `firstResponseAt`
- `POST /tickets/:id/comments` (`isPublic` flag), `PATCH`/`DELETE /tickets/comments/:id` (soft-delete)
- `GET/POST /time-entries` (filter: user, ticket, org, date range, running), `PATCH/DELETE /time-entries/:id`, `POST /time-entries/:id/stop` (timer stop), `POST /time-entries/bulk-approve`, `GET /time-entries/timesheet` (per-tech week aggregation)
- `GET/POST /tickets/:id/parts`, `PATCH/DELETE /tickets/parts/:id`
- `POST /tickets/:id/alerts` + `DELETE /tickets/:id/alerts/:alertId`; `POST /alerts/:id/create-ticket` (pre-filled, linked `created_from`)
- `GET/POST/PATCH/DELETE /ticket-categories`
- `GET /tickets/stats` — queue counts by status/assignee, SLA at-risk/breached counts (dashboard widget)
- `GET /tickets/export/billables.csv` — date-range billable time + parts export
- `POST /webhooks/tickets/email-inbound` — provider webhook; HMAC signature verification, rate-limited, no session auth

Auth: new RBAC permissions `TICKETS_READ` / `TICKETS_WRITE`; time-entry approval and category management gated to admin roles. All routes `requireScope('organization','partner','system')`.

## 3. Background Jobs (BullMQ)

JobId rule: `-` separators, never odd colon counts.

- **SLA monitor** (repeat ~1 min): sweep open tickets; resolve effective SLA (ticket override → category default → priority default); compute breach/at-risk (at-risk = 80% elapsed). SLA clock pauses while status is `pending`/`on_hold` (`sla_paused_at` set on entry; accumulated into `sla_paused_minutes` on exit). On breach: set `sla_breached_at`/reason, emit notification via existing `notificationRoutingRules`/channels.
- **Alert→ticket worker**: alert rules gain a `createTicket` action (category, priority mapping). Dedup: if an open ticket exists for the same (alert_rule_id, device_id), append a `system` feed entry instead of creating a new ticket.
- **Notification fan-out**: new ticket / public comment / assignment / SLA breach → email via `EmailService` + in-app `user_notifications`. Portal submitters get reply-able emails (Reply-To = inbound address; subject carries `[T-YYYY-NNNN]`).

## 4. Email-to-Ticket

Provider-webhook based (Mailgun Routes or Resend Inbound; provider abstraction mirrors outbound email service).

Pipeline (`POST /webhooks/tickets/email-inbound`):
1. Verify provider HMAC signature; reject otherwise. Rate-limit per source.
2. Log raw envelope to `ticket_email_inbound` (audit + dead-letter).
3. Resolve partner from recipient address (`{partner-slug}@tickets.<domain>` on hosted; per-partner configured address on self-hosted).
4. Thread-match: `In-Reply-To`/`References` → `email_thread_key`; fallback subject token `[T-YYYY-NNNN]`.
5. Matched → append public comment (author resolved by sender email against portal users; unknown senders attributed by raw address). Reopens `resolved` tickets to `open`; `closed` tickets get a new linked ticket instead.
6. Unmatched → create ticket. Org resolution: sender email → `portal_users` lookup → that org; fallback to per-partner configured default triage org. `source = email`.
7. Attachments stored via existing attachment storage; size/type limits enforced.

Sender content is untrusted: sanitized rendering, no HTML execution, header trust only after signature verification.

Outbound technician replies email the requester with proper threading headers, closing the loop.

## 5. Frontend (apps/web)

Follows the Alerts pattern (Astro page + React island, `window.location.hash` for selection — no query params for transient UI state). All mutations wrapped in `runAction`.

- **`/tickets` queue page**: saved-filter tabs (My tickets / Unassigned / All open / Breaching soon / Closed), table with internal number, title, org, priority badge, SLA countdown, assignee, updated-at; bulk assign + bulk status.
- **Ticket detail** (island on same page, hash-selected): header (number, title, org/site/device links, status dropdown, assignee picker), activity feed (public/internal toggle on composer, status/assignment changes inline), right rail (properties, SLA timers, linked alerts, time summary, parts list, billable total). Time-entry quick-add + start/stop timer.
- **Settings → Ticketing**: categories CRUD (with SLA/billing defaults), email-to-ticket address + default triage org, billables export. Alert-rule `createTicket` action added to the existing alert rule form.
- **Time tracking (Phase 3)**: persistent start/stop timer widget in the app header (survives navigation; one running timer per user), `/timesheet` page (per-tech week view, entry edit, approval for admins), time-entry quick-add on ticket detail.
- **Integration points**: Device detail gets a Tickets tab; Alert detail gets Create Ticket; dashboard gets open/breaching widget.
- **Cleanup**: delete orphaned `apps/web/src/components/portal/{TicketList,TicketDetail,CreateTicketForm}.tsx`.
- **apps/portal**: keeps working unchanged; categories surface read-only on submitted tickets. Fix its priority drift (`medium` → `normal`) opportunistically.

## 6. AI Tools

New `services/aiToolsTicketing.ts` registered in the `aiTools.ts` hub: `search_tickets`, `get_ticket`, `create_ticket`, `update_ticket_status`, `assign_ticket`, `add_ticket_comment`, `log_time_entry`, `start_timer`/`stop_timer`. `deviceArgs` gating where a deviceId is accepted. Tier 2 for reads, tier 3 for writes. All tools are thin wrappers over `ticketService`/`timeEntryService` — no tool-only logic. The existing MCP server exposes these automatically via the registry, so external AI agents get full ticketing capability the day Phase 1 ships.

## 7. Security & Tenancy

- New tables ship RLS in the creating migration; same-PR allowlist updates; verified as `breeze_app` with forged cross-tenant inserts.
- `ticket_parts` / `ticket_alert_links` denormalize `org_id` from the parent ticket (avoids the nested-EXISTS bound-param RLS bug). `time_entries` is partner-axis (shape 3) because entries may have no org/ticket; when ticket-linked, `org_id` is denormalized at write time for filtering.
- Email webhook: signature-verified, partner resolved strictly from recipient address, sender data untrusted.
- Internal notes (`isPublic=false` / `comment_type=internal`) must never reach portal responses or outbound email — enforced in queries plus a dedicated leak-regression test on the portal route.
- Site-scoped org users see only tickets whose device/site falls in their `siteIds` (app-layer filter on top of RLS, matching existing patterns).

## 8. Phasing

Each phase is an independently shippable PR chain:

1. **Core** — migration (tickets/comments extensions, categories, alert links, sequences), admin API, queue + detail UI, comments/activity, assignment, manual alert linking + create-from-alert, notifications, AI tools, internal numbering, orphaned-component cleanup.
2. **SLA** — SLA resolution chain, monitor job, pause logic, queue countdown + breaching-soon tab, breach notifications.
3. **Native time tracking + parts** — standalone `time_entries` (ticket-linked or not), start/stop timer widget (persistent across pages), technician timesheet page (week view, approval), parts, billable summary, CSV export.
4. **Email-to-ticket** — inbound webhook + provider abstraction, threading, org resolution, outbound reply loop, settings UI, dead-letter view.

Deferred / out of scope: per-partner custom statuses, escalation-policy wiring for tickets, native↔PSA bidirectional sync, invoice generation, customer satisfaction surveys, work sessions / time-entry templates.

## 8a. Extensibility Guarantees (paths we must NOT cut off)

Explicit checks against the long-term PSA roadmap. Implementation plans must not violate these:

- **AI-agent/MCP-first**: all ticket/time logic in the service layer (`ticketService`, `timeEntryService`); routes, AI tools, and MCP are equal consumers. No handler-only business logic.
- **Native workflows/automations**: every state change flows through the single lifecycle-event dispatch point (Section 2). A future workflow engine subscribes to events and calls service functions — zero ticket-code changes required.
- **Billing/invoicing module (future)**: `time_entries` and `ticket_parts` carry `billing_status`, rates, and `cost_basis` — the exact input surface for invoice generation. A future `invoices`/`invoice_lines` schema FKs into these rows additively. Money columns are `numeric`; currency is assumed partner-level for now and a `currency` column can be added per-row later without backfill pain (default from partner settings).
- **Service catalog (future)**: `ticket_parts` gains a nullable `catalog_item_id` FK when a `catalog_items` table exists (LanternOps pattern: `TicketPart.product` nullable). Parts stay usable free-text forever.
- **Accounting & distributor integrations (QuickBooks, Xero, Sherweb, Pax8, TechData, …)**: follow the existing PSA pattern — per-integration connection tables + external-ref **mapping tables** (like `psa_ticket_mappings`), never columns on core tables. Time entries/parts → accounting invoice lines; catalog/parts → distributor SKUs. Nothing in the core schema needs to change for any of these.
- **Large-scale MSP operations**: per-partner sequences are race-safe; queue queries are index-backed (status, assignee, org, SLA fields — composite indexes in the migration); `assignedTeam` already exists on `tickets` for team-based routing; custom statuses, boards/views, and round-robin assignment layer on without schema breakage.
- **External API consumers**: the technician routes are the public API (same auth/RBAC as the rest of Breeze) — no separate "internal" API to deprecate later.

## 9. Testing

Per `breeze-testing` conventions:
- Route tests alongside each route file (Vitest + Drizzle mocks), incl. status-transition enforcement and `firstResponseAt` stamping.
- Validator tests in `packages/shared`.
- `rls-coverage.integration.test.ts` allowlist additions + local run against real DB.
- Integration tests: email webhook parse pipeline (matched/created/failed paths), sequence allocation under concurrency.
- Internal-note leak regression test on portal routes and outbound email composer.
- Playwright e2e (`data-testid` only): queue → open ticket → comment → assign → resolve happy path.

## References

- LanternOps blueprint: `~/LanternOps/activities/models/ticket_models.py`, `time_tracking_models.py`, `ticket_parts_models.py`, `signals.py` (SLA + timestamp logic), `integrations/models/ticket_sync.py`
- Breeze: `apps/api/src/db/schema/portal.ts`, `routes/portal/tickets.ts`, `schema/alerts.ts` (notification infra), `services/email.ts`, `services/aiTools.ts`
