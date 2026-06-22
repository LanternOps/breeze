# Ticketing Phase 6a — Editing Affordances (Design)

**Date:** 2026-06-21
**Status:** Approved design → ready for implementation plan.
**Program:** `2026-06-21-ticketing-phase6-program.md` (sub-phase 6a).
**Worktree/branch:** `feat/ticketing-phase6` (off `origin/main` @ `684e78f2e`).

## Goal

Let staff (and, narrowly, portal customers) correct tickets after creation:

1. **Comment edit & delete** — fully greenfield.
2. **Ticket field editing UI** — the API already supports these fields via `PATCH /tickets/:id`;
   only the web affordances are missing.
3. **Org reassign** — move a ticket to another customer org within the same partner.

Non-goals (deferred to later sub-phases): business-hours SLA, configurable status transitions,
automation/escalation rules.

## Current state (verified)

- **`PATCH /tickets/:id`** (`apps/api/src/routes/tickets/tickets.ts:588`) → `updateTicketFields`
  (`apps/api/src/services/ticketService.ts:544`) already edits **subject, description, categoryId,
  priority, dueDate, response/resolutionSlaMinutes, deviceId, tags**, writing a `system` feed row +
  `audit_logs` (`ticket.update`) + `ticket.updated` event. Validator:
  `packages/shared/src/validators/tickets.ts:20`. `status`/`assignee` are excluded (dedicated routes).
- **Workbench UI** (`apps/web/src/components/tickets/TicketWorkbench.tsx`) exposes inline edit only for
  priority, category, status, assignee. Subject is read-only; description, due date, tags, device are
  not surfaced.
- **`ticket_comments`** (`apps/api/src/db/schema/portal.ts:99`) has `deleted_at timestamptz` already,
  **no `edited_at`**, no edit/delete route or service fn. Detail GET filters `isNull(deletedAt)`
  (`routes/tickets/tickets.ts:443`); portal GET filters it too (`routes/portal/tickets.ts:187`).
  RLS today: `breeze_ticket_parent_select` (2026-06-10-a, parent-org SELECT) +
  `breeze_ticket_parent_portal_insert` (2026-06-10-b). **No UPDATE/DELETE policy.**
- **Permissions** (`packages/shared/src/constants/permissions.ts`): only `tickets:read` /
  `tickets:write`. Precedents: `contracts:manage` exists; `ADMIN_ALL` is `*:*`. Device cross-org move
  (`apps/api/src/routes/devices/moveOrg.ts:60`) gates `requireScope('partner','system')` +
  `devices:write` + `organizations:write`, and re-stamps `org_id` via `CUSTOM_ORG_REWRITE_TABLES` /
  detaches via `DEVICE_DETACH_DEVICE_ID_TABLES` (`apps/api/src/routes/devices/core.ts`).
- **Feed** (`apps/web/src/components/tickets/TicketFeed.tsx`): `SYSTEM_TYPES =
  {status_change, assignment, system, time_entry}`; user comments render as standalone blocks with an
  "Internal" badge when not public. No edited/deleted markers.

## Component 1 — Comment edit & delete (backend)

### Migration (`<implementation-date>-ticket-comment-edit.sql`, date-prefixed at write time, idempotent)
- `ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS edited_at timestamptz;` (`deleted_at` exists).
- Add RLS **UPDATE** and **DELETE** policies, `FOR ... TO breeze_app`, mirroring the canonical
  parent-org form of `breeze_ticket_parent_select` (EXISTS join to `tickets` via
  `breeze_has_org_access(tickets.org_id)`, with the system-scope short-circuit honored by the helper).
  Per [[rls_is_system_flag_write_policy_hole]], the policy gates **only** on parent-ticket tenant
  access — author identity and role checks live in the service layer, never in `WITH CHECK`.

### Permission
- Add `TICKETS_MANAGE: { resource: 'tickets', action: 'manage' }` to the canonical registry, mirroring
  `CONTRACTS_MANAGE`. Wire it into `permissionsCatalog` and `RESOURCE_LABELS` (watch the dual-map drift
  trap noted for prior ticket-permission work). Used for the admin override only; self-edits need just
  `tickets:write` + ownership.

### Service (`ticketService.ts`, routed through the existing dispatch point)
- `editTicketComment(commentId, { content }, actor)`:
  - Reject if the target comment's `commentType` is a system type (`status_change`/`assignment`/
    `time_entry`/`system`) — those are machine-authored. Reject if already soft-deleted.
  - **Authorization:** actor is the comment's author (matching `userId` for staff, or `portalUserId`
    for portal) **OR** holds `tickets:manage`. Portal authors additionally require the *until-first-
    staff-reply* window to be open (see below).
  - Overwrite `content`, set `edited_at = now()`. Write `audit_logs` action `ticket.comment.edit` with
    `details: { commentId, ticketId, previousContent }` (forensic trail; no new table). Emit a
    `ticket.commented`-class event so notify/feed paths stay consistent.
- `deleteTicketComment(commentId, actor)`:
  - Same gating. **Soft-delete**: set `deleted_at = now()` (idempotent; second delete is a no-op).
    Audit `ticket.comment.delete` with `details.previousContent`. Emit the same event class.
- **Portal window helper** `portalCommentMutable(comment, ticket)`: true iff no comment with
  `authorType IN ('internal','technician')` (or a `status_change`/`assignment`/`time_entry`/`system`
  row) exists with `created_at > comment.created_at`. (Staff "reply" = any later staff-authored or
  system feed activity.) Staff actors are not subject to the window.

### Routes
- Staff (`routes/tickets/tickets.ts`): `PATCH /tickets/:id/comments/:commentId`
  (body `{ content }`, `tickets:write`) and `DELETE /tickets/:id/comments/:commentId`
  (`tickets:write`). Both resolve the ticket via `getScopedTicketOr404` (inherits site-scope gating),
  then call the service (which enforces author-or-`tickets:manage`). A non-author without
  `tickets:manage` → 403.
- Portal (`routes/portal/tickets.ts`): `PATCH`/`DELETE` equivalents scoped to the caller's own
  `portalUserId`, honoring `portalCommentMutable`. Closed window → 409.

## Component 2 — Org reassign (backend, high-privilege)

- Route `POST /tickets/:id/move-org` (mounted BEFORE core `/:id` routes to avoid path collision, per
  the device precedent), gate: `requireScope('partner','system')` + `tickets:write` +
  `organizations:write` (identical bar to device `moveOrg`).
- `moveTicketOrg(ticketId, targetOrgId, actor)` in `ticketService.ts`, one transaction:
  1. Validate `targetOrgId` is in the **same partner** as the ticket (composite-FK invariant; reject
     cross-partner with 400).
  2. Re-stamp `org_id` on the ticket and denormalized child rows: `ticket_comments`, `time_entries`,
     and `ticket_alert_links` — reusing the `CUSTOM_ORG_REWRITE_TABLES` machinery established in #1261.
  3. **Detach `device_id`** (a device belongs to the source org). Null it; record in the move audit.
  4. Write a `system` feed row ("Moved to <org>"), `audit_logs` `ticket.move_org`
     (`details: { fromOrgId, toOrgId, detachedDeviceId }`), emit `ticket.updated`.
- Same-org no-op short-circuits before any write.

## Component 3 — Ticket field edit UI (frontend; API already exists)

In `TicketWorkbench.tsx`, add inline-edit affordances, each PATCHing `/tickets/:id` wrapped in
`runAction` with optimistic `afterMutation`:
- **Subject** — click-to-edit header (save on blur/Enter, cancel on Esc).
- **Description** — edit toggle in the detail body.
- **Due date** — date picker (clearable → `dueDate: null`).
- **Tags** — chip editor (add/remove, max 20 × 50 chars per the validator).
- **Device** — link/unlink control (set/clear `deviceId`).
- **"Move to another org…"** action, rendered only when the client holds `tickets:write` +
  `organizations:write` (the web has no client-side permission store — render best-effort and let the
  API enforce; on 403 surface the `runAction` error). Opens an org picker → Component 2.

## Component 4 — Feed rendering (frontend)

- **Edited badge:** when `edited_at` is set on a user comment, render an "edited" marker next to the
  timestamp.
- **Deleted tombstone:** soft-deleted user comments keep the author/timestamp row but replace the body
  with a "(deleted)" placeholder. To render this, the **staff** detail GET must now **return**
  soft-deleted rows with a `deleted: true` flag (drop the `isNull(deletedAt)` filter for staff, project
  a `deleted` boolean, and null/omit `content` for deleted rows so prior text isn't shipped to the
  client). **Portal** GET continues to exclude deleted rows entirely.
- Edit/delete controls appear on a user comment only for its author or `tickets:manage` holders
  (best-effort client check; API authoritative).

## Component 5 — Testing

- **API unit** (`*.test.ts`, mocked DB): PATCH coverage for newly-wired fields; comment edit/delete
  authz matrix — author / `tickets:manage` / non-author-no-manage (403) / system-type-comment (reject)
  / portal-window-open vs-closed (409); move-org same-partner pass + cross-partner reject + device
  detach.
- **Integration** (`apps/api/src/__tests__/integration/*.integration.test.ts`, real `breeze_app`):
  - `ticket-comments-rls`: extend with **UPDATE/DELETE forge** cases — a cross-tenant connection must
    fail to edit/delete a comment (`new row violates row-level security policy` / 0 rows), re-seeding
    the fixture per test ([[rls-forge-test-memoized-fixture-vacuous]]).
  - `ticket-move-org`: child `org_id` re-stamp on `ticket_comments`/`time_entries`/`ticket_alert_links`
    is complete; cross-partner target rejected; device detached.
  - No new table → `ORG_CASCADE_DELETE_ORDER`/tenantCascade unaffected (assert no churn needed).
- **Web** (`apps/web`, jsdom): workbench inline-edit components (subject/description/due/tags/device);
  feed edited-badge + deleted-tombstone rendering. Stub `ResizeObserver` per-test if any chart mounts
  ([[web_recharts_resizeobserver_jsdom]]).
- **E2E** (`e2e-tests/tests/tickets.spec.ts` + `pages/TicketsPage.ts`, `data-testid` only): edit a
  comment → "edited" badge; delete a comment → tombstone; edit subject and description inline.

## Risks & mitigations

- **Org reassign** is the riskiest piece (multi-tenant data move). Mitigations: same-partner
  validation, single transaction, reuse of the audited `CUSTOM_ORG_REWRITE_TABLES` path, dual-permission
  high-privilege gate, device detach, full integration coverage.
- **Returning soft-deleted rows to staff** widens the detail payload — guard by nulling `content` for
  deleted rows server-side so deleted text never reaches the client; portal path stays unchanged.
- **`tickets:manage` is a new permission** — must be wired into both `permissionsCatalog` and
  `RESOURCE_LABELS` (dual-map drift trap) and granted to appropriate default roles, or admin override
  silently fails closed.
- **RLS UPDATE/DELETE policies** must copy the canonical `FOR ... TO breeze_app` + system-scope form;
  only the Integration Tests job catches a malformed policy (rls-coverage does not).

## Open follow-ups (out of 6a)
- Versioned comment revision history (chose audit_logs trail instead).
- Editing `status`/`assignee` semantics unchanged (dedicated routes already exist).
