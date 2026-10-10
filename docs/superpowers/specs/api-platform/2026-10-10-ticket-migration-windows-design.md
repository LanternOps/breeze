---
title: Ticket Migration Windows and Import Mode
status: proposed
date: 2026-10-10
owner: Lennon Fiuza
area: api-platform
tracking_issue: LanternOps/breeze#8313
related:
  - docs/superpowers/specs/api-platform/2026-09-27-partner-api-tickets-design.md
  - docs/agents/tenancy-rls.md
---

# Ticket Migration Windows and Import Mode

> Step 1 of the ticket importers agreed in discussion #8313: migration windows and import mode
> in the service layer. Attachments (step 2) and the module framework, wizard and worker (step 3)
> get their own specs; §8 records what they inherit from this one.

## 1. Summary

An MSP moving its desk to Breeze wants its ticket history to come along, so that Breeze becomes
the single source of truth. The everyday ticket writes are built for live work. Pushing a backfill
through them does five things wrong:

- it emails requesters again;
- it refuses agents who have left;
- it stamps every row "now";
- it starts SLA clocks on five-year-old tickets;
- it fires every webhook and automation once per historic event.

This spec adds two things:

- a **migration window**: an explicit, time-boxed, partner-axis grant that lets one keyless partner
  service principal write in import mode to a chosen set of organizations;
- **import mode**: a mode of the existing `ticketService` write functions, reachable only through
  an internal import writer while a window is open. It accepts historic values, sends no
  notifications, publishes nothing, starts no SLA clock, and marks every row with the window id.

The public write routes, including the Partner API, do not change. Outside a window every write
behaves exactly as it does today.

### Design constraints (from #8313, agreed with the maintainer)

1. **A backfill is repeatable.** Every new channel a desk connects is another backfill, so a
   window is a reusable primitive, not a one-time migration switch.
2. **A module converts into Breeze's model.** Nothing source-shaped reaches `ticketService`. The
   only foreign identity in the model is the source's id and number, kept as an external reference.
3. **Partner-axis data.** A window and the import marker belong to one principal and one partner
   across many orgs. They follow the partner-axis RLS shape and the cascade registrations in
   `docs/agents/tenancy-rls.md`.
4. **Per-tenant fairness from day one.** One partner's migration cannot starve other tenants. Here
   that means a per-window throughput limit and one open window per partner. Step 3 adds a
   per-partner concurrency cap on the import worker (§8).

## 2. Repo facts this design is built on (verified 2026-10-10 against `main` 5fef55610)

| # | Fact | Evidence |
|---|---|---|
| F1 | The Partner API ticket writes call `createTicket`, `updateTicketFields`, `changeTicketStatus`, `assignTicket` and `addTicketComment` inside `inPartnerContext`: one `withDbAccessContext` transaction with partner scope, the principal's `accessibleOrgIds`, and `userId` null. The actor is `{ kind: 'service_principal', principalId, keyId: string, name }`. | `routes/partnerApi/ticketWrites.ts` (`actorFrom`, the five routes); `routes/partnerApi/dbContext.ts`; `services/ticketService.ts` (`TicketActor`) |
| F2 | Side effects leave `ticketService` through **two channels**. (a) Inline `emitTicketEvent` puts events on the BullMQ `ticket-events` queue: the requester email on a public comment and on `resolved`, and `ticket.updated`. (b) `writeTicketOutbox` rows are drained by `ticketOutboxPublisher` to the assignee-notification job and to the event bus, where `webhook-delivery`, `automation-worker`, `ai-agent-ticket-helpdesk` and `deliverable-status` subscribe. Per-write audit goes through `createAuditLogAsync`. No outbox consumer assumes every ticket has a `ticket.created` row. | `services/ticketService.ts`; `services/ticketEvents.ts`; `jobs/ticketOutboxPublisher.ts`; `services/eventSubscribers.ts` |
| F3 | `createTicket` always inserts `new` or `open`, stamps SLA targets, and lets `created_at`/`updated_at` default to `now()`. Closing is a separate `changeTicketStatus` call: `closed_at = now`, `resolved_at ??= now`, `closed_by` null for a principal. Resolving requires a `resolutionNote`, and `new → closed` is allowed. A `pending` status stamps `sla_paused_at = new Date()`. | `services/ticketService.ts` (`createTicket`, `changeTicketStatus`, `TICKET_STATUS_TRANSITIONS`) |
| F4 | `tickets.created_at`/`updated_at` are `timestamp` without time zone, defaulted, with no trigger. There is no imported marker on tickets or comments. `ticket_comments` has no `org_id`; its RLS goes through the parent ticket. | `db/schema/portal.ts` |
| F5 | SLA targets live on the ticket row. Non-support `work_kind` gets null targets. The breach sweep scans `status IN ('new','open')` and notifies. The SLA report counts null targets as `no_target`, but a closed ticket with targets and no first response as `missed`. The first public comment from any actor stamps `first_response_at = now`. A priority or category change **restamps** the targets while `first_response_at` is null, the ticket is open, and the field's `field_provenance` is not human-authoritative (`user`, `service_principal`). | `services/ticketSla.ts`; `ticketService.ts` (`resolveSlaTargetsForWorkKind`, the restamp in `updateTicketFields`/`applyAiFieldUpdates`); `services/ticketProvenance.ts`; `jobs/ticketSlaWorker.ts`; `services/businessReports/ticketSlaReport.ts` |
| F6 | `assertAssigneeEligible` rejects a user who is not `active`, belongs to another partner, or fails `isAuthorisedForTicket` (`tickets:read` at the user's **current** role, org access, device site), with `400 ASSIGNEE_NOT_ELIGIBLE`. | `ticketService.ts` (`assertAssigneeEligible`); `services/ticketPush.ts` (`isEligibleTicketRecipient`, `isAuthorisedForTicket`) |
| F7 | Internal numbers come from `allocateInternalTicketNumber(partnerId, now = new Date())`, a `(partner_id, year)` sequence formatted `T-YYYY-NNNN`. The year is `getFullYear()` (server-local). The number is allocated outside the caller's transaction, so a rollback leaves a gap. | `services/ticketNumbers.ts` |
| F8 | `ticket_external_refs` is org-scoped and unique on `(principal, external_id)` and `(principal, ticket_id)`, so one ref per principal per ticket. The staff search box matches only `subject` and `internal_number`. | `db/schema/ticketExternalRefs.ts`; `services/ticketExternalRefs.ts`; `routes/tickets/tickets.ts` (`search`) |
| F9 | `ticket_comments` has `author_name`, `author_type` (varchar), `origin_principal_*` and no author email. The principal INSERT policy requires `user_id IS NULL AND portal_user_id IS NULL`. The customer portal labels a comment as the customer's only when it has a `portal_user_id`. | `db/schema/portal.ts`; migration `2026-12-12-150000-…-partner-check.sql`; `routes/portal/tickets.ts` |
| F10 | Partner service principals are shape 3 (partner-axis), with `UNIQUE (id, partner_id)`. Since #8332, only a principal's **owner** can widen it. Its keys end when the owner's `credential_epoch` or `mfa_epoch` moves, or when the owner stops being active. Any partner-wide admin can narrow it. `organizations` has `UNIQUE (id, partner_id)`. | `db/schema/partnerServicePrincipals.ts`; `services/partnerServicePrincipalCredential.ts`; `routes/partnerServicePrincipals.ts`; `db/schema/orgs.ts` |
| F11 | Partner-axis tables use `breeze_has_partner_access(partner_id)`, register in `PARTNER_TENANT_TABLES`, and are swept by `cascadeDeletePartner` through `partner_id`. A table that also carries an `org_id` that is not its tenancy axis goes in `ORG_AXIS_POLICY_EXCLUDED_TABLES`. It still needs `CORE_ORG_CASCADE_DELETE_ORDER`, an `orgMergeRegistry` policy and per-column `CORE_TENANT_EXPORT_POLICY` classifications. | `docs/agents/tenancy-rls.md`; `__tests__/integration/rls-coverage.integration.test.ts`; `services/tenantCascade.ts`; `services/orgMergeRegistry.ts`; `services/tenantExportPolicyRegistry.ts` |
| F12 | The event bus and webhooks are org-scoped: `publishEvent(type, orgId, …)`, `webhooks.org_id NOT NULL`. There is no partner-level channel. | `services/eventBus.ts`; `db/schema/integrations.ts`; `workers/webhookDelivery.ts` |
| F13 | Partner API write limits are hourly Redis sliding windows: the key's `rateLimit` (default 600), tickets `min(key, 1200)`, partner 6000. `rateLimiter` fails closed, and counts a rejected request unless called with `refundOnReject`. | `middleware/partnerApiAuth.ts`; `services/rate-limit.ts` |
| F14 | Ticket-to-ticket links (#7900) are not on `main`. | `db/schema/tickets.ts` |
| F15 | The Partner API ticket representation validates `source` against a strict six-value enum mirrored in `packages/shared`, and the feed parses every envelope. A new `ticket_source` value would turn the feed into a 500 at the first such row. Adding any field changes every record's `revision`. | `routes/partnerApi/schemas.ts`; `routes/partnerApi/tickets.ts`; `packages/shared/src/validators/tickets.ts` |

## 3. Migration windows

### 3.1 Rules

- A window grants **one** partner service principal import mode, for one time box, on an explicit
  list of the partner's organizations. It grants nothing else.
- **The principal is keyless.** A window opens only for a principal with no active key. No key can
  be issued, rotated or re-enabled for it while the window is open (`409 MIGRATION_WINDOW_ACTIVE`).
  This keeps import mode unreachable through the API. It also keeps an import's rows apart from
  any live integration's rows, which the origin-principal loop guard and the resume rule (§4.6) both
  rely on.
- **Opening is widening, closing is narrowing** (F10). Only one admin may open a window: a
  partner-wide admin (`canManagePartnerWidePolicies`) who owns the principal and holds
  `PERMISSIONS.TICKETS_WRITE` on every listed org. That is the permission #8332's delegation table
  requires for `tickets:write`. Opening needs an interactive session, MFA and a step-up grant. Any
  partner-wide admin can close a window.
- **One open window per partner in V1.** Migrations run one after another, which is also the
  fairness rule step 3's worker relies on.
- A window opens immediately and lasts at most **14 days** (`MIGRATION_WINDOW_MAX_DAYS`). It cannot
  be extended; a longer migration opens a new window.
- **A window ends with whoever it depends on.** It stops accepting writes, and is closed by the
  sweep, as soon as any of these happens:
  - the principal is disabled, expires, or loses `tickets:write`;
  - the opener stops being an active partner-wide admin of the partner;
  - the opener's `credential_epoch` or `mfa_epoch` moves.

  This is the rule #8332 applies to keys.

### 3.2 Data model

```sql
CREATE TABLE IF NOT EXISTS migration_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  partner_service_principal_id uuid NOT NULL,
  source_label varchar(64) NOT NULL,            -- 'zammad', 'whatsapp-2026-09', … for UI and audit
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL,
  writes_per_hour integer NOT NULL CHECK (writes_per_hour BETWEEN 600 AND 100000),
  opened_by uuid NOT NULL REFERENCES users(id),
  opener_credential_epoch integer NOT NULL,      -- snapshot at open (#8332)
  opener_mfa_epoch integer NOT NULL,
  closed_by uuid REFERENCES users(id),
  closed_reason text CHECK (closed_reason IN
    ('expired', 'closed_by_admin', 'principal_inactive', 'opener_inactive')),
  closed_at timestamptz,
  summary jsonb,                                -- per-org counts, written once at close (§3.5)
  summary_published_at timestamptz,             -- set once every org's event is published
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT migration_windows_id_partner_uq UNIQUE (id, partner_id),
  CONSTRAINT migration_windows_principal_fk
    FOREIGN KEY (partner_service_principal_id, partner_id)
    REFERENCES partner_service_principals(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT migration_windows_span_chk CHECK (ends_at > opened_at),
  CONSTRAINT migration_windows_closed_shape_chk CHECK (
    (status = 'closed') = (closed_at IS NOT NULL AND closed_reason IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS migration_windows_one_open_per_partner
  ON migration_windows (partner_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS migration_window_orgs (
  window_id uuid NOT NULL,
  partner_id uuid NOT NULL,
  org_id uuid NOT NULL,
  PRIMARY KEY (window_id, org_id),
  CONSTRAINT migration_window_orgs_window_fk FOREIGN KEY (window_id, partner_id)
    REFERENCES migration_windows(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT migration_window_orgs_org_fk FOREIGN KEY (org_id, partner_id)
    REFERENCES organizations(id, partner_id) ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE
);
```

- **Constraints enforced in the service:** the 14-day span cap
  (`ends_at - opened_at <= MIGRATION_WINDOW_MAX_DAYS`) and the throughput ceiling, so both can change
  through env without a migration.
- **Throughput defaults:** `writes_per_hour` defaults to `MIGRATION_WINDOW_DEFAULT_WRITES_PER_HOUR`
  (6000) and is capped at `MIGRATION_WINDOW_MAX_WRITES_PER_HOUR` (20000). At 6000/h, our Zammad's
  98,439 writes take about 16.5 hours. The floor of 600 keeps every import transaction, which costs
  at most 102 (§4.6), inside one hour's budget.
- **Composite foreign keys** (as in `backup_provider_integration`) make it impossible for a window to
  name another partner's org or principal. RLS alone would not.
- **A child table, not a `uuid[]` column.** An array of org ids escapes every registration list and
  needs hand-written merge and erasure fixups (F11).

**Import marker, original authors and source numbers**:

| Table | Column | Purpose | Registration |
|---|---|---|---|
| `tickets` | `migration_window_id uuid` | The window that created the ticket. FK-less snapshot: it must outlive window retention and never couple an org table to a partner table. Partial index `WHERE migration_window_id IS NOT NULL`. | export: `included` |
| `ticket_comments` | `migration_window_id uuid` | Same, for comments. | none (F4: no `org_id`; RLS through the ticket) |
| `ticket_comments` | `original_author_email varchar(320)`, `original_author_kind text CHECK (… IN ('staff','requester'))` | Display-only "originally by" (#8313 answer 3). `author_name` carries the original name, so every existing reader shows it. No user or contact is created. | none |
| `ticket_comments` | `import_source_id varchar(255)` | The source's comment id. Unique `(origin_principal_id, import_source_id) WHERE import_source_id IS NOT NULL`, so a rerun skips what exists. | none |
| `ticket_external_refs` | `external_number varchar(255)` | The source's human-facing number (Zammad's `#41023` is not its id). Searchable (§5); `external_id` stays the stable resume key. Index `(org_id, lower(external_number))`. | export: `included` |

`ticket_source` does **not** gain a value (F15). The module maps the source channel onto the
existing values (`email`, `portal`, `manual`, `api`), and `migration_window_id` marks the import.

### 3.3 Routes and authorization

Staff routes under `/migration-windows`, mounted like `/partner-service-principals`
(`requireScope('partner','system')`, `requirePermission(ORGS_WRITE)`, `requireMfa()`,
`partnerWideAdminDenial`):

| Route | Who | Notes |
|---|---|---|
| `POST /migration-windows` | Partner-wide admin who owns the principal | Requires `requireInteractiveSession()` and a single-use step-up grant for the new operation `migration_window_open`. The operation goes in `StepUpOperation`/`STEP_UP_OPERATIONS` with a digest builder in `routes/auth/mfa.ts` over `{ partnerId, principalId, sorted orgIds, endsAt, writesPerHour }`.<br>**Checks:** the principal is active, unexpired, holds `tickets:write` and has no active key. The opener has `TICKETS_WRITE` on every org. Every org is an active org of the partner (not `quick_support`, not the unassigned pool). No other open window exists for the partner.<br>The opener's epochs are snapshotted. Audit `migration_window.opened`. |
| `POST /migration-windows/:id/close` | Any partner-wide admin | Closes now with `closed_by_admin`. Audit `migration_window.closed`. |
| `GET /migration-windows`, `GET /migration-windows/:id` | Partner-wide admins | Live counts while open; `summary` once closed. |

- **No update route.** A wrong window is closed and a new one opened.
- **Key routes gain one refusal** (§3.1): issue, rotate and re-enable return `409` while a window is
  open for that principal.
- **`partner-wide-write-coverage.test.ts`:** the routes pass through their
  `canManagePartnerWidePolicies` gate. The window service is listed in
  `ALLOWED_WITHOUT_CAPABILITY_CHECK`, with the reason "system sweep and admin-gated close".
- **No Partner API route in V1.** Whether an external tool may open a window for its own principal
  is left for later (#8313).

### 3.4 Lifecycle job

A repeatable job, `migration-window-sweep`, runs every minute and is registered in
`scheduleRegistry` and `workerRegistry`. It uses one system transaction per window, locking the row
`FOR UPDATE`. Each run:

- closes `expired` windows (`ends_at <= now()`);
- closes `principal_inactive` and `opener_inactive` windows (§3.1);
- retries the summary publication (§3.5) for closed windows whose `summary_published_at` is null.

A write that arrives between a closing condition and the sweep is refused by the write-time check
(§4.4). The sweep's delay never extends a window.

### 3.5 Closing and the summary event

Closing, whether by the sweep or the route, runs in one transaction that locks the window
`FOR UPDATE`. Import writes hold `FOR SHARE` on the same row (§4.4), so a write either commits
before the close or sees the window closed and fails. Inside that transaction it:

1. counts, per org, the tickets carrying the window id, and the comments carrying it with
   `comment_type IN ('comment','internal')`. Feed rows are not counted.
2. writes `summary`, `closed_at`, `closed_by`, `closed_reason` and `status = 'closed'`.
3. writes a partner-level audit row, `migration_window.closed`, with the counts.

After commit it publishes `migration.window_closed` **once per org in the window**, because there
is no partner channel (F12):

- **Event id:** the deterministic `${windowId}:${orgId}`, so a retry never duplicates.
- **Payload** (ids and counts only): `{ windowId, partnerId, sourceLabel, openedAt, endsAt, closedAt,
  closedReason, ticketsImported, commentsImported }`, with that org's counts.
- **Retry:** `summary_published_at` is set when every org's event is out. The sweep retries any window
  where it is still null.
- **Registration:** the type is added to `EventType`/`EVENT_TYPES` and to the webhook form's event
  list.

This is the only event an import produces (#8313 answer 7).

### 3.6 Registrations

| Object | Shape | Registrations |
|---|---|---|
| `migration_windows` | 3 (partner-axis) | Policies in the creating migration: ENABLE + FORCE RLS; `breeze_current_scope()='system' OR breeze_has_partner_access(partner_id)` on SELECT, INSERT, UPDATE and DELETE. `PARTNER_TENANT_TABLES`. Partner erasure through `partner_id`; the GRANT includes DELETE. |
| `migration_window_orgs` | 3, with a non-tenancy `org_id` | The same policies. `PARTNER_TENANT_TABLES` and `ORG_AXIS_POLICY_EXCLUDED_TABLES`. `CORE_ORG_CASCADE_DELETE_ORDER`. `orgMergeRegistry`: `repoint-dedupe` on `['window_id']` (the `report_series_org_targets` precedent). Export: `window_id`, `partner_id`, `org_id` `included`. |
| `tickets.migration_window_id`, `ticket_external_refs.external_number` | 1 | Export classifications above. No new FK, so no cascade, merge or deferrability change. |

- **The import write depends on the UPDATE policy.** It locks the window `FOR SHARE` under the
  partner context (§4.4), which needs both the UPDATE grant and the UPDATE `USING` policy:
  Postgres applies the UPDATE policy to a locking SELECT and silently drops the rows it fails.
  Hardening that policy to system-only would turn every import write into a 409. An integration
  test pins this.
- **Where these are caught:** the contract suites (`rls-coverage`, org-cascade, tenant-export,
  org-merge) run only under **Integration Tests**. The wave runs them before its PR.

### 3.7 Alternatives rejected

- *A flag on the principal ("import principal").* It has no time box, no org list and no record of
  who allowed it. It becomes a state the platform is left in.
- *Org-scoped windows (one per org).* An import is one operator decision across many orgs under one
  principal. Per-org rows would still need a partner-level parent for the summary and for the
  one-open-window rule.
- *A `uuid[]` of org ids.* It escapes the registration lists (§3.2).
- *Letting any partner-wide admin open a window, or allowing keys on the principal.* Import mode
  widens a principal. After #8332, widening belongs to its owner. A keyless principal makes "only
  the import writer" structural rather than a convention.
- *Scheduling a window to open later.* It adds a state and a transition, and the importer can simply
  open the window when it starts.

## 4. Import mode in the service layer

### 4.1 The mode

The write functions in F1 gain an optional last argument, `mode: TicketWriteMode`:

```ts
type TicketWriteMode =
  | { kind: 'live' }                                   // default — today's behaviour
  | { kind: 'import'; window: OpenWindow; at: Date };  // `at` = when the source says it happened

declare const openWindowBrand: unique symbol;
type OpenWindow = {
  readonly [openWindowBrand]: true;                    // only lockOpenWindowForWrite can mint one
  id: string; partnerId: string; principalId: string; orgIds: ReadonlySet<string>;
};
```

- The only producer of an `OpenWindow` is `lockOpenWindowForWrite` (§4.4), and the only caller of
  that is the import writer (§4.6). A source-scan test allows the `kind: 'import'` literal only in
  `services/ticketImport/`.
- The actor of an import write is the window's principal,
  `{ kind: 'service_principal', principalId, keyId: null, name }`. `keyId` becomes
  `string | null` in `TicketActor`, because an import has no key. Attribution, `origin_principal_*`
  and `field_provenance` otherwise work as they do for the Partner API.

### 4.2 What import mode changes, function by function

| Function | Live behaviour (unchanged) | Import mode |
|---|---|---|
| `createTicket` | `new`/`open`; `created_at = updated_at = now()`; SLA targets resolved; number from `now`; `source` as given | `created_at = updated_at = mode.at`. **SLA targets null**, with `field_provenance` for both SLA fields set to `service_principal` so the restamp never fires (§4.3). Number allocated with the **UTC** year of `mode.at`, so a 2021 ticket gets `T-2021-NNNN`. `source` comes from the module's channel mapping (§3.2). `migration_window_id` is stamped. Requester: a contact id (checked to be in the ticket's org, as today), or a display-only `submitter_name`/`submitter_email` with no contact created. |
| `assignTicket` (and `assigneeId` on create) | `assertAssigneeEligible`: active, same partner, authorised now | **Kept:** the user exists, belongs to the window's partner, and `org_id` is null or the ticket's org.<br>**Relaxed:** `status` and the current-role authorisation. The assignment is historic, the role is today's.<br>A deactivated agent can be the assignee. Another partner's user, or another org's customer user, is still `ASSIGNEE_NOT_ELIGIBLE`. Nobody is notified (§4.5). |
| `changeTicketStatus` | Transition table; `resolved` needs a note; `closed_at = now`, `resolved_at ??= now`; `pending` stamps `sla_paused_at` | Same transition table. `resolved` may omit the note. The time comes from `mode.at`. When the source knows both times, the writer calls `resolved` at `resolvedAt` and then `closed` at `closedAt`, so both are kept. SLA pause bookkeeping is skipped: there are no targets to pause. |
| `addTicketComment` | `created_at = now`; author = principal; first public comment stamps `first_response_at = now` | `created_at = mode.at`. `author_name` = the original author's name. `original_author_email`/`original_author_kind` set. `author_type` is `internal` for staff and `email` for requesters. `user_id`/`portal_user_id` stay null, as the principal INSERT policy requires (F9). `import_source_id` stamped. `first_response_at` is stamped only by the first public **staff** comment, at `mode.at`. Internal notes work as today; kept system messages use them (#8313 answer 5). |
| `updateTicketFields` | Diff, SLA restamp, `updated_at = now` | `updated_at` advanced to `mode.at` (below). No SLA restamp. |

**Every write:**
- `updated_at = GREATEST(updated_at, mode.at)`, so it never moves backwards.
- The feed rows these functions write (status change, assignment) are stamped at `mode.at` with the
  window id, so an imported timeline reads in historic order.
- Historic times must be `<= now()` and must not precede the ticket's `created_at`. The writer
  converts source times to UTC (F4).

### 4.3 SLA

Imported tickets carry **null SLA targets, open or closed**. That is the existing "no SLA"
representation (F5), and it buys three things:

- the breach sweep never sees them, so no historic ticket breaches and notifies between the create
  and close calls;
- the SLA report counts them as `no_target`, not `missed`;
- an open imported ticket does not start a clock its source already measured.

The restamp in F5 would otherwise give an open imported ticket targets on its first priority or
category edit, measured from its historic `created_at`, and it would breach at once. Stamping the
two SLA fields' provenance as `service_principal`, which is human-authoritative, makes the restamp
skip them. A technician who wants an SLA on an open imported ticket sets the targets explicitly, as
today.

### 4.4 The write-time window check

Every import transaction does three things, in order:

1. **Before** opening the transaction, it charges the window's throughput bucket (§4.7).
2. Inside the transaction, opened with partner scope and `accessibleOrgIds` = **the window's orgs**
   (so RLS, not just the app, bounds the org list), `lockOpenWindowForWrite(windowId, orgId)` runs
   `SELECT … FROM migration_windows … FOR SHARE` and checks:
   - `status = 'open'` and `now() < ends_at`;
   - `orgId` is in the window's orgs;
   - the principal is active, unexpired, holds `tickets:write` and has no active key;
   - the opener is active and their `credential_epoch`/`mfa_epoch` still match the snapshot.

   It returns the `OpenWindow`. Anything else is `409 MIGRATION_WINDOW_NOT_OPEN` or
   `403 MIGRATION_WINDOW_ORG_NOT_ALLOWED`.
3. It calls the `ticketService` functions with `mode: { kind: 'import', window, at }`.

`FOR SHARE` makes close and write mutually exclusive (§3.5) without serializing the writes against
each other. The opener's role is re-checked by the sweep (§3.4), which is cheaper than doing it per
write; the epochs and statuses are checked per write.

### 4.5 Side effects: suppressed at the source, enforced by a test

In import mode `ticketService` produces **no side effects beyond the rows themselves**:

| Side effect | Channel (F2) | Import mode |
|---|---|---|
| Requester email (public comment, resolved) | inline `emitTicketEvent` | not emitted |
| `ticket.updated` / `status_changed` / `commented` queue events | inline `emitTicketEvent` | not emitted |
| Assignee in-app, email, push and Pushover | outbox, then the assignee job | no outbox row |
| Webhooks, automations, AI triage, time-entry proposals, deliverable status | outbox, then the event bus | no outbox row |
| Per-write audit rows | `createAuditLogAsync` | not written; the window is the audit unit (opened and closed rows with counts), and every row carries the window id and the principal |
| ML triage feedback | `emitTicketTriageFeedback` | not emitted |
| SLA breach notifications | SLA sweep | impossible: null targets (§4.3) |

- **Why not write outbox rows and drain them unpublished:** a 98k-write import would add 98k rows
  whose only purpose is to be skipped. No consumer needs them (F2), and the summary counts come from
  the marker columns.
- **The enforcement.** In the five functions, every side-effect call goes through one mode-aware
  helper, `ticketSideEffects(mode)`: `emitTicketEvent`, `writeTicketOutbox`, a raw
  `insert(ticketOutbox)`, `createAuditLogAsync` and `emitTicketTriageFeedback`. A source-scan test,
  in the style of `no-silent-mutations.test.ts`, fails when one of them is called directly inside
  those functions. A side effect added there later cannot fire during an import by accident.

### 4.6 The import writer

`services/ticketImport/importWriter.ts` is the only caller of import mode. Step 3's modules call it
and never call `ticketService` directly. It takes one ticket, already converted into Breeze's model:

```ts
type ImportedTicket = {
  sourceId: string;                 // stable resume key → ticket_external_refs.external_id
  sourceNumber?: string;            // human-facing number → external_number (searchable, §5)
  sourceUrl?: string;
  orgId: string;
  createdAt: Date; updatedAt: Date;
  subject: string; description: string;
  priority: TicketPriority; categoryId?: string; tags?: string[];
  source: 'email' | 'portal' | 'manual' | 'api';
  requester: { contactId: string } | { name: string; email: string };
  assigneeUserId?: string;
  finalStatus: TicketCoreStatus; resolvedAt?: Date; closedAt?: Date; resolutionNote?: string;
  comments: Array<{ sourceId: string; createdAt: Date; isPublic: boolean;
                    author: { kind: 'staff' | 'requester'; name: string; email?: string };
                    content: string }>;
};
```

`importTicket(windowId, ticket)` works like this:

- **Header transaction** (cost ≤ 3): create, write the external ref, assign.
- **Comment transactions:** in `createdAt` order, in chunks of up to 100 per transaction.
- **Final status:** set in the last transaction (cost ≤ 2).
- **Throughput:** every transaction is charged separately (§4.7). Its cost is one unit per service
  write, the unit #8313's estimate used.

It returns `{ ticketId, created | resumed, commentsWritten, commentsSkipped }`.

**Resume.** A ticket whose `sourceId` already has a ref for this principal is resumed, not
recreated, but only when two conditions hold:
- the existing ticket carries a `migration_window_id`, meaning it was imported and is not a live
  ticket;
- its **current** org is in the window (it may have been moved since).

Otherwise the writer returns `409 MIGRATION_SOURCE_ID_IN_USE`. A resumed ticket gets only the
comments whose `import_source_id` is missing, and then its final status.

A window that closes mid-ticket leaves a ticket that is complete up to its last committed chunk. The
next window resumes it.

### 4.7 Throughput

A third hourly bucket, `migration_window_rate:{windowId}`:
- its limit is the window's `writes_per_hour`;
- the import writer charges it before each transaction with `refundOnReject: true`, so a rejected
  attempt costs nothing;
- it fails closed, like the Partner API buckets.

It is independent of the Partner API buckets. Imports do not consume an integration's live
1200/6000 (F13; #7181 §6 unchanged), and a live integration cannot starve an import.

### 4.8 Alternatives rejected

- *A separate import write path (direct inserts).* That is the parallel write path #8313 rules out.
  Every invariant `ticketService` enforces would have to be re-proven for it: RLS bounds, the
  transition table, provenance and external refs.
- *Import mode through the Partner API routes (historic fields on the public bodies).* It would make
  import mode public contract and reach every key holder. It is left open for later (§3.3).
- *A new `ticket_source` value `import`.* It is a public contract change that breaks the Partner API
  feed (F15), and the marker column already says the same thing.
- *Starting SLA clocks at window close for open tickets.* It needs a new clock-start column and
  still produces "breached on day one" for anything older than its target.
- *One transaction per whole ticket.* A ticket with more comments than the hourly budget could never
  pass the bucket. Chunks plus resume keep both properties: bounded cost and no lost work.

## 5. Visibility

- **Reads.** These gain `migrationWindowId`, an additive field that is null for live rows:
  - the staff ticket and comment representations;
  - the Partner API ticket, feed and comment reads.

  A mirror on the Partner API feed can then skip imported rows. A mirror back to the import's own
  source would otherwise push 17k imported tickets back into it. The new field changes every
  record's `revision` once (F15), which mirrors see as a one-time update of every row; the release
  note says so.
- **Original authors.** Imported comments return `originalAuthor: { name, email, kind }`. The
  customer portal uses `original_author_kind` to label imported requester replies as the
  customer's (F9).
- **Search by source number** (#8313 answer 6). The staff search box adds
  `OR tickets.id IN (SELECT ticket_id FROM ticket_external_refs WHERE org_id = ANY(:visibleOrgIds)
  AND lower(external_number) = lower(:term))`, served by the `(org_id, lower(external_number))`
  index. The match is exact and case-insensitive: source numbers are looked up whole, and a
  substring match over every integration's refs would be unindexable. Breeze still allocates its
  own number; the source number is never the ticket number.

The "Imported" chip, the filter and the window pages come with the step 3 wizard.

## 6. Waves

| Wave | Contents | Tests |
|---|---|---|
| 1a — windows | **Migrations:** the two tables with RLS; the comment, ticket and ref columns; the indexes.<br>**Routes:** §3.3, including the step-up operation and the key-route refusal.<br>**Lifecycle:** the sweep (§3.4), close + summary event with retry (§3.5), audit, all registrations (§3.6), env settings. | **Routes:** owner-only open; keyless check; any-admin close; step-up digest with sorted orgs; one open window per partner; org checks; key routes refused while open.<br>**Sweep:** every closing condition, including the opener's epoch moving.<br>**Integration:** close-vs-write race (two connections); `FOR SHARE` under partner RLS.<br>**Contract suites:** `rls-coverage`, org-cascade, org-merge, tenant-export, `eventBus.types`. |
| 1b — import mode | `TicketWriteMode` and the branded `OpenWindow` through the five functions (§4.1–4.2). Null SLA + provenance (§4.3). `lockOpenWindowForWrite` with narrowed RLS (§4.4). `ticketSideEffects` and its source-scan test (§4.5). The import writer (§4.6). The throughput bucket (§4.7). Read fields, portal label and search (§5). | **Unit, per function:** live behaviour unchanged (the existing suites). Import behaviour: historic times; relaxed eligibility with the partner and org boundary kept; resolve without a note; resolved-then-closed; UTC numbering year; staff-only first response; no restamp on a later edit.<br>**Integration, as `breeze_app`:** an `importTicket` round trip writes no outbox row and no audit row and emits no queue event; a chunked ticket resumes after a mid-import close; resume refuses a live ticket's source id and an org outside the window; another partner's org is refused by RLS.<br>**Search:** by source number. |

1b depends on 1a. Both land before step 3 needs them.

## 7. Decisions to confirm in review

1. **Per-write audit rows are not written in import mode** (§4.5). The window's opened and closed
   rows, with counts, plus the window id on every row, are the audit trail. Writing 98k audit rows
   for one import is the noise #4021 describes.
2. **Imported open tickets get no SLA targets** (§4.3), rather than a clock started at import.
3. **`migrationWindowId` on the Partner API reads and feed** (§5), with the one-time `revision`
   churn, rather than hiding imported rows from the feed.
4. **One `migration.window_closed` per org** (§3.5). This is how "one summary event" maps onto an
   org-scoped bus (F12).
5. **The import principal is keyless** while its window is open (§3.1).
6. **Limits:** one open window per partner; 14 days at most; 6000 writes/h by default, 600 to 20000.
   All but the first are env settings.

## 8. What steps 2 and 3 inherit

**Attachments (step 2)** extend the same mode:
- `ticket_attachments.migration_window_id`;
- writes go only to the S3 backend, and an import refuses to start on a deployment without object
  storage;
- each attachment carries a source id for resume.

**Modules, wizard and worker (step 3):**
- **Windows and writes.** Each module opens its window through the routes above, on a dedicated
  keyless principal it creates. It writes only through the import writer.
- **Per-tenant concurrency cap.** The import worker runs at most one import job per partner at a
  time, using a Redis per-partner slot (the `scriptProposals/reviewConcurrency.ts` pattern), with a
  global concurrency below the worker's total.
- **Source credentials** (answer 1) are stored for re-import on the existing encrypted path
  (`encryptedColumnRegistry`, `aadBinding: 'row'`), with a per-source revoke.
- **System messages** (answer 5) are skipped by default, with an option to keep them as internal
  notes.
- **Historic people without a Breeze account.** A historic assignee or closer is imported
  unassigned, with an internal note naming them. Answer 3's display-only rule covers comment
  authors only.
- **Merged tickets** (answer 4) need the ticket-to-ticket links of #7900, which are not on `main`
  (F14). Until they land, a module imports a merged ticket as closed, with an internal note naming
  the survivor's number, and adds the link once #7900 ships.

## 9. Risks

- **A bug in import mode reaches live data.** The mode is an argument, so a live call that passed it
  by mistake would suppress notifications. Three things guard against that:
  - only `lockOpenWindowForWrite` can mint the branded `OpenWindow`;
  - the `import` literal is confined to `services/ticketImport/`;
  - the source-scan test pins the side-effect helper.
- **The window's dependency on the UPDATE policy** (§3.6). A future hardening of
  `migration_windows` UPDATE to system-only breaks every import write. The integration test makes
  that a red suite rather than a production incident.
- **Number gaps.** Allocation runs outside the transaction (F7), so a failed import leaves gaps in
  historic years, as live creates do today.
- **Time zones.** The ticket columns have no zone (F4). The writer converts source times to UTC, and
  the module tests pin that with recorded source data.
