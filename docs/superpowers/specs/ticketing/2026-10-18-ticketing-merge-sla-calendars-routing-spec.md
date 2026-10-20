# Ticketing: merge tickets, business-hours SLA calendars, routing rules, portal updates

**Date:** 2026-10-18
**Tracking issues:** LanternOps/breeze#8883 (epic), #8972 (merge), #8973 (business-hours SLA calendars). Routing rules are tracked in the #8883 umbrella.
**Status:** Draft for maintainer review. Advisor quorum (Opus + Codex `gpt-6-astra` xhigh, read-only) is folded in (§9). Open Decisions are in §10, with the ones Todd must settle listed first.
**Code base:** `origin/main` at `d49876c54d`.
**Deliverable of this PR:** specification only. No code and no migration. Plans are written per wave after approval.
**Builds on (shipped):**
- Native ticketing: `2026-06-09-native-ticketing-design.md`.
- SLA engine: plan `docs/superpowers/plans/ticketing/2026-06-11-ticketing-sla-engine.md`, decisions D1–D7 and the #6691 D2 amendment.
- Ticket types and links (#7900): plan `2026-10-12-ticket-types-and-links.md`.
- Customer work approval (#4617): `2026-10-06-customer-work-approval-design.md`.

**Siblings:** service catalog (`2026-10-10-service-catalog-design.md`, #8325) and email-first ticketing (`2026-10-14-email-first-ticketing-design.md`, #8758). Both are drafts and are not duplicated here.

---

## 1. Problem

A self-hosted partner runs Breeze ticketing as its helpdesk. They listed five everyday gaps (#8883). Triage split them up:
- Merge and business-hours SLAs need a spec first (#8972, #8973).
- Routing rules stay in the umbrella and are specified here.
- Portal uploads go straight to a plan, because the attachment pipeline exists.
- The satisfaction survey stays in the umbrella.

This spec covers merge, calendars, routing and the portal parts of those three. It does **not** cover uploads or the survey (§7).

### 1.1 Merge (#8972)

Two tickets for one problem cannot become one record. Typical cases are a portal submission followed by an email, or two people reporting one outage. #7900 shipped `duplicate_of` as a link type (`apps/api/migrations/2026-12-27-040000-ticket-links.sql:35`). A link moves nothing: comments, time, parts, the SLA clock and email threading all stay on both tickets. A later reply lands on the closed ticket, or spawns a continuation ticket, because `findClosedTicketInPartner` (`apps/api/src/services/inboundEmail/threadMatcher.ts:254`) matches it. No merge code exists. A grep for "merge" in `ticketService.ts` finds only org merge.

### 1.2 Business hours (#8973)

SLA deadlines are wall-clock, by design (plan D1: "Calendars change breach math retroactively — defer until a partner asks"). This is that ask. The issue names three wall-clock calculations. There are **six**, and each has its own copy of the formula `created_at + (target + sla_paused_minutes) minutes` with an 80% at-risk ratio:

| # | Site | Kind |
|---|---|---|
| 1 | `apps/api/src/jobs/ticketSlaWorker.ts:84-94` (breach sweep, every 60s) | SQL |
| 2 | `apps/api/src/routes/tickets/tickets.ts:75-90` (`SLA_AT_RISK` / `SLA_BREACHED`, queue filter, triage sort, stats) | SQL |
| 3 | `apps/api/src/services/businessReports/ticketSlaReport.ts:96-137` (attainment `outcomesCte`) | SQL |
| 4 | `apps/api/src/services/portal/ticketReadModel.ts:28-107` (`ticketSla`) | API JS |
| 5 | `apps/web/src/components/tickets/ticketConfig.ts:114-147` (`slaState`, feeding `SlaChip` and `TicketWorkbench`) | browser JS |
| 6 | `apps/web/src/components/tickets/SlaTimers.tsx:19-33` (`timerState`) | browser JS |

The six already disagree in small ways:
- The portal read model falls back to `PRIORITY_SLA_DEFAULTS` for a ticket whose stamped target is null. The staff SQL treats a null target as "no SLA".
- `SlaTimers` marks any completed target as met, even when it was met late.
- The report admits that lifetime pause minutes flatter response attainment (`ticketSlaReport.ts:42`).

A partner `businessHours` preset is stored at `partners.settings.businessHours` (`apps/api/src/routes/orgs.ts:752-755`, edited in `apps/web/src/components/settings/PartnerRegionalTab.tsx`). No server code reads it. The customer-approval spec deferred clock-based after-hours detection to "a business-hours calendar, with its own settings home, that SLA would also want" (approval spec §11 D3). This spec builds that calendar.

### 1.3 Routing

`createTicket` (`apps/api/src/services/ticketService.ts:1067`) is the single insert for every source: email, portal, staff, Partner API, Office add-in, AI, alert, vulnerabilities, planned work and import. Nothing routes a ticket. Inbound mail gets a default assignee after creation (`services/inboundEmail/defaultAssignee.ts`, applied at `services/inboundEmail/inboundEmailService.ts:949`) and an unknown-sender mode (`resolveOrg.ts:208-247`). It gets no category. Everything else is triaged by hand. No queue or team concept exists. The only owner is `tickets.assigned_to`.

## 2. Users and scope

| Actor | Merge | Calendars | Routing rules | Sees |
|---|---|---|---|---|
| **Partner technician / admin** (partner scope) | Any two tickets in one org they can access, with `tickets:write` | Partner-wide calendars only when `canManagePartnerWidePolicies(auth)` (`services/partnerWideAccess.ts:25`; partner scope with `partnerOrgAccess = 'all'`, or system). Org-owned calendars and the org override for orgs they can access. | Same split as calendars | All of it |
| **Org-scoped staff user** (org-scope token, e.g. an internal-IT tenant) | Within their own org, with `tickets:write` | Reads its own org rows plus inherited partner-wide rows, through the partner-wide SELECT branch. Writes nothing in v1: ticket configuration routes are `requireScope('partner','system')` today (`routes/ticketConfig.ts:31`), and this spec keeps that. | Same as calendars | Inherited rows carry an "All orgs" badge and are read-only |
| **Portal customer** (portal user) | Never merges | Never configures | Never configures | A merged-ticket banner (§6.1) and SLA status computed on business hours (§6.2) |
| **AI / MCP** | `manage_tickets` action `merge` at tier 3 (approval), `merge_preview` at tier 1 | Read-only tools (§5.7) | Read and dry-run tools at tier 1, writes at tier 3 | |

Merge is **same-org only**, and therefore same-partner. Cross-org duplicates are moved first with the existing move-org action (`routes/tickets/moveOrg.ts`), then merged. A merge never changes a ticket's org.

## 3. Merge design (#8972)

### 3.1 Terms and eligibility

- **Source:** the ticket being merged away. **Survivor:** the ticket that remains.
- The technician starts from the source's header ("Merge into…") and picks the survivor. The picker suggests the **older** ticket first, because its SLA clock and number are the ones the customer has been watching (§3.6).
- The source may be in any status, including resolved or closed, but it must not be soft-deleted or already merged.
- The survivor must not be closed, soft-deleted or merged. The thread matcher only attaches replies to non-closed tickets (`threadMatcher.ts:173-247`), so a closed survivor would strand replies.
- **Refused on either side** (409, typed codes):
  - The ticket is pinned to a service deliverable. Reuse `assertTicketNotPinnedToDeliverable`, the move-org guard.
  - The ticket belongs to an open migration import window (`tickets.migration_window_id`).
  - The ticket has **any** `ticket_approval_requests` row or a budget (`budget_minutes` / `budget_amount`): `MERGE_APPROVAL_STATE`. This guard is on **both** sides. Time moved onto a budgeted survivor would skip the approval gate, which runs only inside `timeEntryService` (approval spec §5.1). Terminal requests cannot move either: the `ticket_approval_requests_decided_immutable` trigger rejects a `ticket_id` change, and `time_entries.approval_request_id` is a composite FK on `(id, ticket_id)`. See D3.
  - Different `work_kind`s. A planned-work ticket (deliverable or project task) does not merge into a support ticket (`MERGE_WORK_KIND_MISMATCH`).
  - The source has pending `action_intents` scoped to it (`MERGE_PENDING_INTENTS`). Approving one after the merge would act on a tombstone. Re-pointing it would change the context the approver saw.
  - The org's status is `merging` (`ORG_MERGING`), matching the movers.
- The acting user needs `tickets:write` and access to the org. The site/device restriction that already gates both tickets (`assertAssigneeEligible` / `isEligibleTicketRecipient` semantics) must pass for **both** tickets, not only the one in the URL.

### 3.2 Tombstone, not deletion

The source row stays as a **tombstone**, so its number, its staff URL, its portal URL, its Partner API external id and its invoice references keep resolving. Three new columns go on `tickets`:

| column | type | rule |
|---|---|---|
| `merged_into_ticket_id` | uuid null | composite FK `(merged_into_ticket_id, org_id) → tickets(id, org_id)`, named `tickets_merged_into_org_fk`, `DEFERRABLE INITIALLY IMMEDIATE`, `ON DELETE NO ACTION`. CHECK `merged_into_ticket_id <> id`. |
| `merged_at` | `timestamp` null (matches sibling columns) | CHECK `(merged_into_ticket_id IS NULL) = (merged_at IS NULL)` |
| `merged_by_user_id` | uuid null → users `ON DELETE SET NULL` | null when the actor is a machine principal (AI tool on approval, Partner API). The actor identity also goes into the audit row using `actorAuditIdentity`. |

There is also a partial index `tickets_merged_into_idx ON tickets(merged_into_ticket_id) WHERE merged_into_ticket_id IS NOT NULL`.

The tombstone stays a tombstone:
- **One hop (path compression).** When A merges into B, every ticket whose `merged_into_ticket_id = A` is re-pointed to B in the same transaction. `merged_into_ticket_id` therefore always names a live, non-merged ticket, and no reader walks a chain.
- **Status.** The source moves to core status `closed`. That sets `status_id` to the partner's system closed status, `closed_at` / `closed_by` and `resolved_at` (backfilled the way close does), and `resolution_note = "Merged into T-…"`. The pause is folded first: if `sla_paused_at` is set, its minutes are added and it is cleared, as any exit from pause does (`ticketService.ts:1638-1647`). This runs as a dedicated merge transition, not as `changeTicketStatus`, so no "resolved" customer mail is sent.
- **Tombstones are read-only.** Every ticket write refuses a tombstone with 409 `TICKET_MERGED`, and the check runs **under the ticket row lock**. That covers comment, status change or reopen, field update, assign, time entry and part writes (the `timeEntryService` choke points), link add, alert link, checklist, draft, approval request, move-org and restore. Today some writers read the ticket before they open their transaction (for example `addTicketComment`, `ticketService.ts:2370`). An unlocked pre-check races with merge, so each writer re-checks under its lock (§3.5).
- **The survivor cannot be hard-deleted while tombstones point at it.** `NO ACTION` on the FK enforces this. Soft-deleting a survivor is allowed: its tombstones then redirect to a deleted ticket and show "merged into a deleted ticket". Restoring the survivor restores the redirect. A tombstone cannot be restored.
- **Org cascade** deletes tombstones and survivors in the same `tickets` pass. The FK is self-referencing inside one org, so a whole-org delete is unaffected (§8.2).

### 3.3 What moves, and what stays

All re-pointing happens in one transaction (§3.5). Tables are walked in the canonical child order of `TICKET_CHILD_ORG_REWRITE_LOCK_ORDER` (`services/ticketOrgMoveLockOrder.ts:61`). Every row keeps its own `org_id`, because merge is same-org.

| Data | Disposition |
|---|---|
| `ticket_comments` | Re-point `ticket_id`. They interleave on the survivor's timeline by `created_at`. A new column, `ticket_comments.merged_from_ticket_id` (uuid null, plain FK → tickets `ON DELETE SET NULL`), is set to the source **only when it is null**, so a comment merged twice keeps its earliest origin. The UI shows "from T-…". The re-point does not fire the feed trigger `breeze_ticket_comments_touch_parent_feed`, which fires only on content, visibility, delete and edit columns (`2026-12-13-120000-tickets-partner-feed-xid.sql:69-84`). The survivor's feed is touched once, explicitly. |
| Source description + intake snapshot (`tickets.description`, `custom_fields`) | Copied into one **internal** system comment on the survivor: "Merged T-… : subject, description, intake answers". It is internal because a description can hold text the survivor's requester never saw (D1). |
| `ticket_attachments` | Re-point `ticket_id`. `comment_id` follows its comment. |
| `time_entries` (all, including `billed`, `contract`, block-drawn and running timers) | Re-point `ticket_id`. Merge is an **allowlisted writer** exempt from `BILLED_LOCKED_ENTRY_FIELDS` (`timeEntryService.ts:645`) and from the block-drawn guard (`isBlockDrawn`, `ENTRY_DRAWN_BY_BLOCK`, `:1440`). A block draw is per org and contract line, so a same-org move does not change it. This is the same exemption the invoice and mover paths have in the time-entry source-scan contract test. The billing amount, rate and status are unchanged. `invoice_lines` keep `ticket_id = source` and their frozen `ticket_label` / `ticket_subject` (`db/schema/invoices.ts:168-178`), so issued history is untouched. A running timer keeps running on the survivor. |
| `ticket_parts` (all, including billed) | Re-point. Same exemption as time entries, through `BILLED_LOCKED_PART_FIELDS`. |
| `ticket_checklist_items` | Re-point, with `sort_order` offset past the survivor's last item. |
| `ticket_alert_links` | Re-point. Where both tickets link the same alert (`UNIQUE(ticket_id, alert_id)`), the survivor's row wins and the source's row is deleted. |
| `ticket_email_links` | Re-point every row. The source's own `email_message_id` and `email_thread_key` live on the `tickets` row, not on link rows, and they **stay on the tombstone**. The header matcher finds them there and follows `merged_into_ticket_id` (§3.8). No synthetic link rows are written, so `ticket_email_links_origin_chk` is unchanged. |
| `ticket_external_refs` | Re-point, unless the survivor already has a ref from the same service principal (`UNIQUE(partner_service_principal_id, ticket_id)`). In that case the source's ref **stays on the tombstone**. A Partner API read of that external id returns the tombstone with `mergedIntoTicketId`, so the PSA can reconcile (§3.7). |
| `ticket_links` | Re-point both legs. Then:<br>• Delete links between source and survivor.<br>• Re-canonicalise `related` links (`source_ticket_id < target_ticket_id`, `ticket_links_related_canonical_chk`).<br>• Drop any link that would break pair-uniqueness, the self-link CHECK, the single-canonical `duplicate_of` index, the cycle rule or `TICKET_LINK_LIMIT`.<br>Tickets that were `duplicate_of` the source become `duplicate_of` the survivor where the rules allow it. Every dropped link is listed in the internal merge comment. |
| `device_vulnerabilities.ticket_id`, `organization_key_dates.reminder_ticket_id`, `service_deliverable_occurrences.ticket_id` | Re-point. These are live work pointers. A deliverable-pinned ticket was already refused in §3.1. |
| `ai_operator_task_targets.ticket_id` | Re-point. `humanWorkService.ts:139` returns the stored ticket, and a tombstone there would send an operator to a dead ticket. |
| `tickets.device_id` | The survivor keeps its device, or takes the source's if it has none. The tombstone's `device_id` is **set to NULL** either way, with the original kept in the audit details. Otherwise the device org mover, which moves a device's tickets, would carry a tombstone away from its survivor and break `tickets_merged_into_org_fk` (`moveDeviceOrgInTransaction.ts:946`). |
| `tickets.tags` | The survivor takes the union. |
| `ticket_drafts` of the source | Deleted, as in the move-org precedent (`ticketService.ts:3694`). |
| Stays on the tombstone | `ticket_outbox` history, `ai_agent_runs`, `action_intents.scope_ticket_id`, `partner_api_idempotency_keys`, `ticket_email_inbound`, `invoice_lines`, the source's own system comments written by the merge, colliding external refs, and its SLA stamps (§3.6). |

**Partner API idempotency replay.** A replayed create or comment request whose stored key points at a tombstone, or at a comment that moved, must replay the original response. It must not throw (`routes/partnerApi/ticketWrites.ts:460`). The replay path resolves a tombstone through `merged_into_ticket_id`, and a moved comment by id.

### 3.4 Preview, confirm, no undo

- `GET /tickets/:id/merge-preview?into=<survivorId>` is read-only. It returns eligibility errors, move counts per table, the links that would be dropped, external refs that stay behind, device and requester differences, and whether the source requester gains survivor access (§6.1).
- `POST /tickets/:id/merge` with body `{ intoTicketId, notifyRequester? }` **revalidates everything under the locks**. The preview is advisory only.
- **No undo** in v1. Merge is irreversible, and the preview and confirm dialog say so (D4).

### 3.5 Locking

This is one request transaction. Writes to child rows are ordered so they cannot form a cycle with any existing writer:

Merge follows the **global ticket lock order** that `moveTicketOrg` documents (#3778, `ticketService.ts:3594-3598`). It does not invent its own order:

1. `lockOrgTicketLinks(tx, orgId, 'exclusive')`, **first**, holding no row lock (`services/ticketLinkLock.ts`). Merge rewrites `ticket_links`, so it is a link writer.
2. `organizations` row `FOR SHARE`. This matches the time-entry creation barrier `organizations SHARE → tickets FOR UPDATE` (`timeEntryService.ts:541-575`, `lockTicketsInOrder`). Merge also refuses an org whose status is `merging` (the org-merge fence), as the movers do.
3. The pre-ticket children, **before** any ticket row and in the #3778 order: `action_intents` (the source's pending intents, refused in §3.1), then `ticket_drafts` (the source's drafts, to be deleted), then `ai_agent_runs`, then `ai_operator_task_targets`. Draft send (`sendTicketDraft`, `ticketService.ts:2991`) locks the draft before writing the ticket, which already fits this order.
4. Source, survivor and every ticket currently merged into the source `FOR UPDATE`, in **ascending id** order. Then re-validate §3.1.
5. `ticket_comments`, then the child tables in `TICKET_CHILD_ORG_REWRITE_LOCK_ORDER` (`ticketOrgMoveLockOrder.ts:61`).

**Invariant adopted by this spec:** every writer of a step-5 child row locks its ticket row first. The quorum found one writer that breaks this today: a comment edit locks the comment row, then the ticket through the feed trigger. The merge plan's first task is a lock-order audit of every ticket-child writer, reconciled against the #3778 comment and `ticketOrgMoveLockOrder.ts`. Each writer that violates the invariant changes to the read-unlocked → lock ticket → lock child → re-check pattern (approval spec §5.2). Each pair gets a concurrency integration test: merge against draft send, comment edit, comment add, timer stop, link add, move-org, device move and the SLA sweep. As a backstop only, the merge route retries once on `40P01`.

Outbox rows are written inside the transaction. Events are emitted after the outer commit (#1105).

### 3.6 SLA state on merge

- **The survivor keeps its own targets, deadlines, pause state and breach stamps, unchanged.** Picking the older ticket as survivor (the default suggestion) keeps the earliest customer commitment. The alternative "adopt the earlier of the two deadlines" is D5.
- The tombstone keeps its stamps as history.
- Merged tombstones are **excluded** from SLA attainment, the queue, the stats and the sweep (`merged_into_ticket_id IS NULL` in sites 1–3).
- **Other staff lists and reports.** The staff ticket list, search and the closed filter hide tombstones by default, and a "Show merged" filter brings them back. Resolution-time analytics (business reports that read `resolved_at`) exclude them, because their close stamps are merge stamps, not resolutions. The plan lists each reader. The sweep already skips them because they are closed. This changes historical attainment denominators: a merged source that had breached stops counting as missed. The report notes say so, and the change is listed as an intentional correction in §8.5.

### 3.7 Events, webhooks, audit, notifications

**Outbox.** Add `ticket.merged` to `ticketOutboxEventEnum` (`db/schema/ticketOutbox.ts:37-44`, a text column, so no enum migration is needed). Bridge it in `jobs/ticketOutboxPublisher.ts` to the eventBus `ticket.merged` type, so webhooks and automations receive it. The payload carries ids and numbers only: `{ sourceTicketId, targetTicketId, sourceInternalNumber, targetInternalNumber }`, following the id-only rule at `ticketService.ts:1311`.

**Other outbox rows:**
- `ticket.status_changed` for the source, **only if** its status actually changed.
- `ticket.updated` for the survivor, with `changed: ['merge']`.

**Not written.** Moved comments do not produce per-row `ticket.commented` events or notifications.

**TicketEvent.** The `ticket.merged` variant (`services/ticketEvents.ts`) feeds `ticketNotifyWorker`:
- The survivor's assignee gets an in-app notice if they are not the actor.
- The source's requester gets one email, "Your request T-… was merged into T-…", when `notifyRequester` is set. The dialog defaults it on when the two requesters differ. Replies to that email thread to the survivor. See D6.

**Audit.** Two rows, `ticket.merge.source` and `ticket.merge.target`, follow the `ticket.move_org.source|target` precedent. Details: counts moved per table, dropped links, the original device, the actor details, and `notifyRequester`.

**Partner API.** `GET` of a tombstone returns `mergedIntoTicketId` and `mergedAt`. The feed bumps both tickets. `ticket.merged` is added to the Partner API event docs.

### 3.8 Inbound email after a merge

- **Header match.** `findTicketInPartner` matches the re-pointed link rows directly to the survivor. A match on a tombstone's own `email_thread_key` / `email_message_id` resolves through `merged_into_ticket_id`.
- **Subject token.** `T-YYYY-NNNN` or the customer token for the source matches the tombstone.
- **One rule for both.** For header and subject-token matches alike, the matcher follows `merged_into_ticket_id` (one hop) **before** it applies its `status != 'closed'` filter. `findClosedTicketInPartner` therefore never spawns a continuation from a tombstone.
- **Sender binding.** `senderIsBoundToTicket` (`:89`) and `senderIsThreadParticipant` (`:125`) also accept a sender bound to any tombstone merged into the survivor. They also check retained inbound history (`ticket_email_inbound` rows of those tombstones), not only the matched ticket. The stricter subject-token binding rule and the current-org check are unchanged.

### 3.9 Org moves of merged tickets

- **Moving a tombstone is refused** (`TICKET_MERGED`).
- **Moving a survivor carries its tombstones.** This applies to `moveTicketOrg`, the device mover and org merge. Each tombstone gets the **full** per-ticket move routine in the same transaction: intents, drafts, outbox, idempotency, external refs, comments and links (`moveTicketOrg`, `ticketService.ts:3516-3966`). Tombstones are not "empty"; the quorum listed what they keep.
- `tickets_merged_into_org_fk` is added to **both** movers' `SET CONSTRAINTS … DEFERRED` statements (`ticketService.ts:3587`, `moveDeviceOrgInTransaction.ts:207`).
- The device mover never reaches a tombstone directly, because §3.3 nulls the tombstone's `device_id`. It reaches tombstones through their survivor.
- Org merge re-points `tickets` wholesale (`orgMergeRegistry`), so self-references stay inside the surviving org.

## 4. Business-hours calendars (#8973)

### 4.1 Data model: calendars with immutable revisions

Calendars are a config table, so they are **partner-wide first** (`docs/agents/tenancy-rls.md:76-87`).

| table | owner | columns |
|---|---|---|
| `business_calendars` | `partner_id` XOR `org_id` (`business_calendars_one_owner_chk`) | `id`, `name`, `is_partner_default bool` (partial unique: one per partner, partner rows only), `archived_at`, timestamps. There is **no** `current_revision_id` pointer, which would create an FK cycle with revisions. The current revision is the highest `revision` for the calendar. |
| `business_calendar_revisions` | owner pair denormalised from the parent | `id`, `calendar_id` (→ calendars `ON DELETE CASCADE`), `revision int` (unique per calendar), `timezone` (IANA, validated like `partnerSettingsSchema.timezone`), `created_by_user_id`, `created_at`. **Immutable on UPDATE**: a trigger rejects changes except `created_by_user_id` going to NULL through FK `SET NULL`. DELETE stays granted, so tenant erasure works. This is the `ticket_approval_requests_decided_immutable` precedent, which also governs UPDATE only. |
| `business_calendar_intervals` | owner pair denormalised | `revision_id` (→ revisions `ON DELETE CASCADE`), `weekday smallint 0-6`, `start_minute smallint 0-1439`, `end_minute smallint 1-1440`, CHECK `start < end`. Several per day are allowed, for split shifts. Overlaps are refused **when the revision is created**: by the service, with a constraint trigger as backstop. There is no `EXCLUDE` constraint, because that would need `btree_gist`, which no migration uses and a self-hosted role may not be able to create. Revisions are immutable, so checking at insert is enough. |
| `business_calendar_holidays` | owner pair denormalised | `calendar_id`, `holiday_date date`, `name`. Unique per `(calendar_id, holiday_date)`. All-day only in v1. |

- **Owner guard.** The children copy `(partner_id, org_id)` from the parent and a constraint trigger keeps the two equal. This follows the `tool_source_tools_owner_guard_trg` and `ticket_checklist_template_items` precedent. The per-ticket resolver then stays one indexed query, and each child has the same dual-axis RLS policy as its parent.
- **No jsonb, deliberately.** A jsonb schedule would be `excludedOpen` and missing from the tenant export.
- **Why revisions.** The weekly hours and the time zone are frozen per revision. A ticket snapshots the revision it was opened under (§4.3). An edit to hours or time zone creates a new revision, which applies to **new** tickets only. Re-reading the hours of an old ticket under a new schedule would reinterpret its aggregate pause minutes, which cannot be done correctly (quorum C4).
- **Holidays sit on the calendar, not on a revision.** They are dated, so a holiday added for next month should apply to tickets already open (§4.5).
- **Archive, do not delete.** Archiving a calendar that tickets reference sets `archived_at`. Revisions remain. The service refuses a hard delete while any ticket references one of its revisions. This is an app-layer check, not an FK `RESTRICT`, because the referencing FKs must be `SET NULL` to satisfy cascade ordering (§8.1). A partner default cannot be archived.
- **Validation at save:**
  - At least one interval per week.
  - Holidays are bounded data. They cannot remove all future time, because the weekly time is positive and the calculator skips whole weeks (§4.4).
  - An org-owned calendar is selectable only for its own org.
  - A partner-owned calendar is selectable only by that partner's orgs. A same-partner check is enforced in the service and by a trigger on `org_ticket_settings`.

### 4.2 Resolution and settings (Rule 9)

**Resolver.** `resolveBusinessCalendar(db, { partnerId, orgId })` in `apps/api/src/services/businessCalendars/resolve.ts` is the **only** reader. It returns `{ revisionId | null, calendarId, source: 'org' | 'partner' | 'none' }`. The order is:
1. The org override: a new typed column `org_ticket_settings.business_calendar_id`, uuid null. It may name an org-owned calendar or a calendar owned by the org's partner.
2. The partner's `is_partner_default` calendar.
3. **None**, meaning 24×7. This is today's behaviour.

Per-priority or per-category calendars (e.g. "urgent runs 24×7") are deferred (D9). Per-site calendars are deferred too (D10).

**Caller context.** The resolver must not depend on the caller's RLS context. Generic portal routes run with `currentPartnerId: null` and do not get the partner-wide SELECT branch (`routes/portal/auth.ts:425-433`). A portal-created ticket would therefore silently resolve to "none". So `resolveBusinessCalendar` and the routing evaluator (§5.2) read configuration with an **explicit `partner_id` / `org_id` filter**, taken from the ticket's org row, inside `runOutsideDbContext(() => withSystemDbAccessContext(...))`. This is a read-only system read of non-secret configuration. Real-Postgres tests cover a ticket created from each context (portal, inbound email, Partner API, staff, org-scope token) under a partner-default calendar and a partner-wide rule.

**Rule 9 statement:**
- **Concept:** "the hours the SLA clock counts".
- **Home:**
  - Partner default: Settings → Ticketing → **Priorities & SLAs** tab (`TicketingSettingsTabs.tsx:42`), in a new "Business hours" card that manages calendars, holidays and the default.
  - Org override: Org settings → Ticketing (`OrgTicketSettingsEditor.tsx`), as a calendar picker. Blank means inherit, and the field shows the inherited calendar and its source.
- **Level:** partner default → org override → snapshot on the ticket (the revision id at create).
- **Resolver:** `resolveBusinessCalendar`.
- **Places configured, before → after:** 1 → 1 per level.
  - Before: Partner → Regional → Business hours, stored but read by nothing.
  - After: Ticketing → Priorities & SLAs (partner) and Org → Ticketing (org).
  - Removal plan: the calendars wave backfills the blob into a calendar (§4.6), then removes the Regional card and the `businessHours` key from `partnerSettingsSchema` in the same PR. That PR also touches `packages/shared/src/types/index.ts`, `PartnerSettingsPage.tsx`, the `businessHours` keys in every web locale and the regional-settings docs page. The home itself is D2.

### 4.3 Stored deadlines replace the six calculations

New `tickets` columns:

| column | type | meaning |
|---|---|---|
| `sla_calendar_revision_id` | uuid null → `business_calendar_revisions` `ON DELETE SET NULL` (a cascade-order edge break, §8.1) | snapshot at create. Null means 24×7. |
| `sla_paused_business_minutes` | integer not null default 0 | business minutes spent paused. Accrued when a pause ends. |
| `response_due_at`, `resolution_due_at` | `timestamp` (without time zone, UTC) null | deadline per target. Null when the target is null. The type matches `created_at`, `first_response_at` and `sla_paused_at` (`db/schema/portal.ts:201-231`), so comparisons and the backfill do not depend on the session time zone. |
| `response_warn_at`, `resolution_warn_at` | `timestamp` null | the 80% "breaching soon" point per target |

**One formula, one calculator.** The calculator is the pure function `addBusinessMinutes(revision, holidays, start, minutes)` / `businessMinutesBetween(...)` in `packages/shared/src/utils/businessTime.ts`. It uses `Intl` time-zone math (the API has no tz library; see `patchSchedulerWorker.ts:123-132` for the existing pattern) and is tested across DST transitions in both hemispheres.

```
due  = add(created_at, target       + sla_paused_business_minutes)
warn = add(created_at, 0.8 * target + sla_paused_business_minutes)
```

The calculator works in seconds, so `0.8 * target` stays fractional, exactly like today's SQL (`routes/tickets/tickets.ts:83-87`). The backfill therefore reproduces today's at-risk set exactly.

Pauses never overlap and are counted in business minutes, so `businessMinutesBetween(created_at, due) − paused = target`. With a null revision, `add` is plain minute addition and `sla_paused_business_minutes = sla_paused_minutes`. The result is then exactly today's wall-clock rule.

**Write points.** Deadlines are recomputed at these points, all inside the ticket row lock:

| Event | Where today | Effect |
|---|---|---|
| Create | `createTicket` `:1248` | resolve the calendar, snapshot the revision, compute due/warn for both targets |
| Restamp before first response (#6691) | `updateTicketFields` `:2083-2098`, `applyAiFieldUpdates` `:2901-2914` | recompute from the new target |
| Explicit SLA override in a PATCH | `updateTicketFields` `:2099-2116` (explicit fields through `changed`) | recompute from the override |
| Pause end (any exit from `pending`/`on_hold`, including to resolved/closed) | `:1638-1647` | `sla_paused_business_minutes += businessMinutesBetween(sla_paused_at, now)`, then recompute unfrozen targets |
| First response, from **every** writer of `first_response_at` | `addTicketComment` `:2422`, `sendTicketDraft` `:3039-3041`, import `:2416`, plus any others the plan's `grep firstResponseAt` finds | All go through one `freezeResponse(tx, ticket)` helper. When the ticket is paused, the helper computes the frozen response deadline with a **transient** accrual: `add(created_at, target + sla_paused_business_minutes + businessMinutesBetween(sla_paused_at, now))`. It does **not** persist that into `sla_paused_business_minutes`, which is accrued once, when the pause ends. Persisting it would count the same span twice in the resolution deadline. |
| Resolve / close while paused | `:1608-1620` | accrue the open pause first, then freeze resolution |
| Future holiday edit | new recompute job (§4.5) | recompute unfrozen targets |
| Move-org (ticket, device, org merge) | movers | re-resolve the calendar for the target org, and recompute unfrozen targets with the new revision. An org-owned calendar of the old org must not stay referenced. |

**Freeze rule.** A target's `*_due_at` and `*_warn_at` are not recomputed once it has an outcome:
- Response is frozen when `first_response_at` is set or `response` is in `sla_breach_reason`.
- Resolution is frozen when `resolved_at` is set or `resolution` is in `sla_breach_reason`.

Reopening clears `resolved_at` (`:1621-1626`), which **unfreezes** resolution. Its deadline then follows the same formula as before. This matches today: a resolved interval is not a pause, so the clock ran while the ticket was resolved. The one-shot breach rule (D3) is unchanged: a stamped breach is never un-stamped and never re-fires.

**The six readers after this change:**

| # | Site | New predicate |
|---|---|---|
| 1 | Sweep | `status IN ('new','open') AND work_kind='support' AND sla_paused_at IS NULL AND merged_into_ticket_id IS NULL AND first_response_at IS NULL AND response_due_at IS NOT NULL AND now() >= response_due_at AND NOT already-stamped`, and the same for resolution. Backed by two new partial indexes on `(response_due_at)` / `(resolution_due_at)` with the same WHERE. This replaces the `created_at` scan of `tickets_sla_sweep_idx` with an index range scan. |
| 2 | Staff queue | `SLA_AT_RISK` becomes `now() >= *_warn_at` per unfrozen arm. `SLA_BREACHED` is unchanged. |
| 3 | Report | `met` = completion `<= *_due_at`. `missed` = completion after it, or `now() > *_due_at` while unmet. Frozen deadlines mean pauses after the first response no longer move the response deadline, which fixes the caveat at `ticketSlaReport.ts:42`. |
| 4 | Portal read model | Reads the stored columns. A null target is `not_configured`, with no priority-default fallback. |
| 5, 6 | Web chip and timers | The list and detail payloads gain `responseDueAt`, `resolutionDueAt`, `responseWarnAt`, `resolutionWarnAt` and, when a calendar applies, `slaBusinessMinutesRemaining`, computed server-side so a countdown is honest across nights. The client keeps only formatting. `SlaTimers` shows "met" only when completion was not after the due time. |

Mobile reads only `slaBreachedAt` (`apps/mobile/src/screens/tickets/ticketCopy.ts:74-75`) and is unaffected. The Partner API gains the four due/warn fields, read-only and additive.

### 4.4 Calculator cost and bounds

- Targets can be up to 525,600 minutes (`packages/shared/src/validators/ticketConfig.ts:22`). That is more than four business years at 40 h/week, so a "search N days" cap would reject valid configurations.
- The calculator therefore jumps **whole weeks** in O(1) using the revision's weekly open minutes, and subtracts the holidays inside each jump from the sorted holiday list. Only the first and last partial weeks are walked by interval. Cost is O(intervals + holidays in range).
- No per-sweep computation happens. The sweep is pure SQL over stored timestamps, and the calculator runs only at the write points in §4.3. At 10k+ agents the 60s sweep gets cheaper than today.

### 4.5 Tickets already open when hours change

- **Hours or time-zone edit:** creates a new revision. Open tickets keep their revision, and new tickets get the new one. This is deterministic and needs no recompute. Fixing a typo for tickets already open (for example a long-target ticket opened under the wrong time zone) is D12.
- **Changing which calendar an org uses** (override or partner default): affects new tickets only.
- **Holiday added or removed with `holiday_date` > today** (in the calendar's time zone): enqueues `business-calendar-recompute` for open tickets with an unfrozen target on a revision of that calendar.
  - It runs in chunks of 500 under `withSystemDbAccessContext`, with `FOR UPDATE SKIP LOCKED` per ticket. Skipped rows retry on the next chunk.
  - The edit touches only time strictly after now, so every affected deadline is still in the future. The recompute cannot race the breach sweep into stamping an obsolete deadline (quorum C4).
  - Past pauses are unaffected for the same reason.
- **Holiday edits dated today or earlier:** accepted for the record, but they never recompute open tickets. The editor says so.
- **Worker contract.** The new consumer gets a `workerReadinessManifest.ts` entry and is covered by `workerReadinessCoverage.test.ts`. It is a **one-shot** job queued by the edit, not a repeatable job.

### 4.6 Backfill and rollout

1. **Columns migration.** Add the five `tickets` columns. Backfill in batches (`ctid` loops, per `tenancy-rls.md`):
   - `response_due_at = created_at + (response_sla_minutes + sla_paused_minutes) min`, and the same for resolution.
   - `*_warn_at = created_at + (0.8*target + sla_paused_minutes) min`, keeping the fraction, as today's SQL does.
   - `sla_paused_business_minutes = sla_paused_minutes`.
   - `sla_calendar_revision_id = NULL`.

   This reproduces today's stored arithmetic exactly. It does not reconstruct the "deadline used" of historical tickets, because lifetime pauses already inflated response. The six readers switch in the same wave. `pnpm db:check-drift`, and the migration elects system scope (`SELECT set_config('breeze.scope','system',true)`).
2. **Calendar tables migration.** RLS, the partner-wide SELECT branch and the registrations (§8). Then a backfill: for each partner whose `settings.businessHours.preset` is not `24/7`, create a **non-default** partner calendar from the preset or custom schedule, in the partner's time zone:
   - `business` = Mon–Fri 09:00–17:00
   - `extended` = Mon–Fri 07:00–19:00 plus Sat 09:00–13:00 (the definitions in the en locale copy)

   Nothing changes for any partner until they mark a calendar as default. The blob is removed in the same wave (§4.2).

## 5. Routing rules

### 5.1 Data model

`ticket_routing_rules` is a config table, **dual-axis** (`partner_id` XOR `org_id`, `ticket_routing_rules_one_owner_chk`). Columns:
- Identity and order: `id`, `name`, `enabled`, `position int`. Order is `(position, id)`, deterministic.
- **Conditions.** These are typed columns. AND across columns, OR within a list, and an empty or null column means "any".
  - `match_sources ticket_source[]`
  - `match_priorities ticket_priority[]`
  - `match_category_id uuid null`, a composite FK to the partner's `ticket_categories`, `ON DELETE RESTRICT` so a deleted category cannot turn a rule into a catch-all
  - `match_subject_keywords text[]`: case-insensitive substring, any of them. Stored lower-cased, at most 20, each 2–100 chars.
  - `match_requester_domains text[]`: lower-cased, exact or `*.sub` suffix.
  - A rule with no conditions is allowed as an explicit catch-all, and the UI warns about it.
- **Actions.** At least one must be set (CHECK).
  - `set_assignee_user_id → users ON DELETE SET NULL`. A deleted user leaves an action that does nothing, not a broader rule.
  - `set_priority`
  - `set_category_id`: composite same-partner FK, `RESTRICT`
  - `set_status_id → ticket_statuses`: same partner, `RESTRICT`, core status limited to `new`, `open`, `pending` or `on_hold` by service validation
  - `add_tags text[]`
- **Org targeting for partner-wide rules.** A child table `ticket_routing_rule_org_links (rule_id, org_id)` limits a rule to listed orgs, following the `ticket_form_org_links` precedent. A real FK means org erasure and org merge rewrite it. A `uuid[]` column would go stale silently (quorum).

There are **no hit counters on the rule row**: every ticket create would update one hot partner row. Hits are recorded on the ticket (§5.4).

### 5.2 Evaluation

- **Where.** Inside `createTicket`, after the org resolve, the Service-Management gate, intake-form or catalog resolution and requester resolution, and **before** assignee eligibility, SLA target resolution and number allocation. A rule's priority and category therefore drive the SLA stamp (`resolveEffectiveSlaTargetsForTicket`, `:1248`). Requester identity is resolved first, so the domain condition sees the final `submitterEmail`.
- **Which rules.** The ticket org's own rules in order, then the partner-wide rules whose org-link set is empty or contains the org. **First match wins** over that combined list. Org-before-partner follows settings rule 3 ("the org always wins") and is D7. Partner-wide rows are fetched by the **ticket org's partner**, never by `eq(table.orgId, ticket.orgId)` alone (playbook step 5).
- **What a rule may set.** A rule fills only fields the caller did **not** choose explicitly. Staff create always sends `priority` today (`apps/web/src/components/tickets/CreateTicketPage.tsx:231`), so presence is not a usable signal. Create inputs instead gain explicit-choice provenance:
  - The web form sends only fields the user touched.
  - API and validator schemas stop defaulting `priority` before the service sees it.
  - Each caller is listed in the plan.
- **Precedence**, per field:
  1. An explicit caller choice.
  2. The intake form or service-catalog item (its category and default priority are configured choices).
  3. The routing rule.
  4. The category's own default priority and the SLA chain's defaults.

  A rule category feeds `resolveEffectiveSlaTargetsForTicket` exactly as a caller category does.
- **Initial status.** A rule-assigned ticket starts at core `open`, by the same derivation an explicit assignee uses (`initialCoreStatus`, `ticketService.ts:1237`). A rule's `set_status_id` then overrides that derivation.
- **Events.** A rule's assignment is part of the insert. The `ticket.created` outbox row carries the final `assigneeId`, as it does for a create with an assignee today, and no separate `ticket.assigned` row is written.
- **Validation.** An explicitly supplied assignee that fails eligibility still errors, as today.
- **Skipped entirely** for import mode (`isImportWrite`), for continuation tickets (they copy their predecessor) and for tickets created by merge (none are).
- **Status actions.** `set_status_id` to a `pending` or `on_hold` core status also sets `sla_paused_at = created_at`, so the clock starts paused.
- **References are re-validated at evaluation**: category and status ownership, and assignee eligibility (`assertAssigneeEligible`). A failing action is **skipped** and recorded, and the rest of the rule's actions still apply.

### 5.3 Fallback

The existing default inbound assignee (`applyDefaultInboundAssignee`) is still applied **after** `createTicket` for email tickets. It does nothing when a rule already assigned someone. So it is the fallback whenever no rule assigns, including when a matched rule set only a priority or category, or when its assignee was skipped. Its **editor** moves from the Inbound email card to the bottom of the new Routing tab ("If no rule assigns an email ticket"). Storage (`settings.ticketing.inbound.defaultAssigneeUserId`) is unchanged, so the concept keeps one home (D8).

### 5.4 Audit, dry run, UI

- **Audit on the ticket.** `tickets.routing_rule_id` (uuid null, `SET NULL`) records the matched rule for reporting. An **internal system comment** records the rule name, the actions applied and the actions skipped with reasons. It is a snapshot, so renaming or deleting the rule does not erase the explanation. The `ticket.create` audit details gain `routingRuleId` and `routingActions`.
- **Dry run.** `POST /ticket-routing-rules/test` takes `{ orgId, source, subject, requesterEmail, categoryId?, priority? }` and returns the matched rule, the would-be actions and any skip reasons. It is read-only, uses the same evaluator, and is shown in the editor as "Test a ticket".
- **UI.** Settings → Ticketing → new **Routing** tab: an ordered list with drag reorder, an enable toggle, an ownerScope selector at create only, and an "All orgs" badge, following `apps/web/src/components/software/PolicyForm.tsx`. Selected-rule state lives in `window.location.hash`.
- **Web UI contracts (all three features).** These apply to the Routing tab, the Business-hours card, the org calendar picker, and the merge dialog and preview:
  - Every mutation goes through `runAction`.
  - Every control has a `data-testid`.
  - Every new string is in all eight web locales (`apps/web/src/locales/*`, `localeParity.test.ts`).
  - The portal has no locale files today, so the portal merge banner follows the portal's existing plain-English convention.
- **Rule 9 statement.**
  - Concept: "who and what a new ticket is routed to".
  - Home: Ticketing → Routing. Partner-wide and org-owned rules are on one page.
  - Level: partner rules and org rules, with org evaluated first.
  - Resolver: `evaluateRoutingRules`.
  - Places, before → after: 0 → 1, and the inbound fallback editor moves into the same tab.

### 5.5 Routes and writes

- `routes/tickets/routingRules.ts`: `GET`, `POST` (with `ownerScope: 'organization' | 'partner'`), `PATCH` (schema `.omit({ ownerScope })`), `DELETE`, reorder, and `test`.
- Writes to partner-wide rows require `canManagePartnerWidePolicies(auth)`. This is checked **in the service** as well as the route, so the AI tool path cannot skip it.
- App-layer dual-axis read conditions are gated on `auth.scope === 'partner'`.

### 5.6 What routing does not do

It has no queues or teams (none exist). It does not re-route on later updates: rules run at create only. It sends no notifications: the shared-mailbox queue notice is #8758. It does not round-robin or balance load.

### 5.7 MCP / AI tools (all three features)

| Tool / action | Tier | Notes |
|---|---|---|
| `manage_tickets` `merge_preview` | 1 | added to the read-action list (`aiGuardrails.ts:314`) |
| `manage_tickets` `merge` | 3 | approval required, irreversible |
| `list_ticket_routing_rules`, `test_ticket_routing_rule` | 1 | |
| `manage_ticket_routing_rules` (create, update, reorder, delete) | 3 | partner-wide gate enforced in the service |
| `list_business_calendars` | 1 | writes stay human-only in v1. `routes/businessCalendars.ts` maps to the read tool plus a documented exemption note, **not** a new `gap`, because `mcp-coverage.test.ts` rejects new gaps |

Schemas avoid `z.undefined()`.

## 6. Portal updates

### 6.1 Merged tickets

- `GET /portal/tickets/:id` for a tombstone the user owns returns `{ merged: true, mergedInto: { id, internalNumber } | null, mergedAt }`. `mergedInto` is non-null only when the user may read the survivor. The portal `apps/portal/src/components/portal/TicketDetails.tsx` shows a banner, "This request was merged into T-…", with a link when one is allowed.
- The portal list (`apps/portal/src/components/portal/TicketList.tsx`) **hides** tombstones and shows the survivor when the user can read it. The banner covers bookmarked URLs.
- **Survivor access for the source's requester** is the disclosure decision D1 (Todd-gated). Whatever is chosen, a new read predicate `portalTicketReadAccess(user)` is added **beside** `portalTicketOwnership` (`routes/portal/ticketOwnership.ts:31`).
  - Ownership keeps authorising every portal **write** (`routes/portal/tickets.ts:471` comment POST, approvals).
  - Read-sharing never widens writes unless D1 says so explicitly.
  - The recommendation, D1(b), is read access to the survivor's **public** thread for requesters of tombstones merged into it, plus public reply. The merge dialog warns when the requesters differ.
- Internal comments, including the merge copy of the source description, are never visible in the portal.

### 6.2 SLA status on a business-hours basis

The portal read model reads the stored deadlines (§4.3). Status values are unchanged: `on_track`, `at_risk`, `breached`, `paused`, `met`, `not_configured`. So the portal UI (`apps/portal/src/components/portal/ticketMarks.ts:84-120`) does not change. Showing a due time ("Response expected by Mon 10:00") is D11. The recommendation is status only in v1.

### 6.3 Not in this spec

Portal uploads have their own plan, per the #8883 triage, because the pipeline exists. The satisfaction survey stays in the umbrella.

## 7. Out of scope

- **Portal uploads** (#8883 item 4) and the **satisfaction survey** (item 5). Both stay in the umbrella; uploads go straight to a plan.
- **#7901** change records, **#7902** multi-approver CAB, **#8325** service catalog. The catalog stamps `response_sla_minutes` and the category at create. Routing runs after it (§5.2), and calendars apply to whatever targets it stamps, so neither blocks the other.
- **#8758** shared-mailbox queue notice and the public reply in the email. Routing does not notify.
- **#8759** one-time secret link.
- **#6831** immutable per-target outcome stamps. This spec stores and freezes the deadline (§4.3), which makes attainment deterministic with respect to later configuration edits. Reopen still unfreezes resolution, so #6831 stays open for explicit outcome stamps.
- Clock-based after-hours detection for customer approval (approval spec D3(b)). It can consume `resolveBusinessCalendar` later and is not built here.
- Undo of a merge. Bulk N-into-1 merge (the API takes one source; the UI may loop). Cross-org merge.
- Queues and teams, round-robin, re-routing on update, and routing on alert severity or device attributes.
- Per-priority, per-category and per-site calendars (D9, D10). Partial-day holidays. Per-custom-status "pauses SLA" flags: pause stays on core `pending`/`on_hold` (plan D4).
- At-risk notifications (plan D7 unchanged).

## 8. Tenancy and data model impact

### 8.1 New tables

| Table | Shape | RLS | Registrations |
|---|---|---|---|
| `business_calendars` | dual-axis XOR, `_one_owner_chk`, partner index, partial unique default | enabled + forced; one `FOR ALL` policy (`system OR breeze_has_org_access(org_id) OR breeze_has_partner_access(partner_id)`) + the partner-wide `FOR SELECT` branch (`org_id IS NULL AND partner_id = breeze_current_partner_id()`, template `2026-10-05-110000-config-policy-partner-wide-select.sql`), all in the creating migration | `CORE_ORG_CASCADE_DELETE_ORDER`; `orgMergeRegistry` `repoint` (org-owned calendars follow their org); `CORE_TENANT_EXPORT_POLICY` all columns `included`; `DUAL_AXIS_TENANT_TABLES` + `XOR_OWNERSHIP_DUAL_AXIS_TABLES`; `businessCalendarsPartnerRls.integration.test.ts` |
| `business_calendar_revisions`, `business_calendar_intervals`, `business_calendar_holidays` | dual-axis, owner pair denormalised from the parent, with an owner-guard constraint trigger | same policy pair as the parent | same four lists as the parent. The revisions immutability trigger is UPDATE-only and DELETE stays granted, so erasure needs no `AUDIT_ADMIN_REQUIRED_TABLES` entry |
| `ticket_routing_rules` | dual-axis XOR | same policy pair | `CORE_ORG_CASCADE_DELETE_ORDER`; `orgMergeRegistry` `repoint`; export policy all `included` (typed arrays, no jsonb); `DUAL_AXIS_TENANT_TABLES` + `XOR_OWNERSHIP_DUAL_AXIS_TABLES`; `ticketRoutingRulesPartnerRls.integration.test.ts` |
| `ticket_routing_rule_org_links` | FK child of the dual-axis parent; its `org_id` is the allowlisted target, not the tenancy axis | parent-join policy | `PARENT_FK_JOIN_POLICY_TABLES` and the exclusion beside `ticket_form_org_links` in `rls-coverage.integration.test.ts`; `CORE_ORG_CASCADE_DELETE_ORDER`; `orgMergeRegistry` `repoint-dedupe` on `(rule_id, org_id)`; export policy |

**Cascade ordering (`tenantCascade.integration.test.ts`: alphabetical, and FK children before parents).**
- Satisfied by name:
  - Revisions, intervals and holidays all sort before `business_calendars`, because `business_calendar_…` sorts before `business_calendars` under `localeCompare`. Intervals sort before revisions.
  - `ticket_routing_rule_org_links` sorts before `ticket_routing_rules`.
- Edges that point from a later-sorting child to an earlier parent:
  - `tickets.sla_calendar_revision_id` → revisions
  - `tickets.routing_rule_id` → rules
  - `org_ticket_settings.business_calendar_id` → calendars

  Each is `ON DELETE SET NULL` and registered in `CASCADE_ORDER_SET_NULL_EDGE_BREAKS`. "Do not hard-delete a referenced calendar" is therefore enforced in the service (§4.1), not by `RESTRICT`.
- There is no `current_revision_id` pointer, so the calendar/revision pair has no cycle.
- Routing-rule actions (`set_category_id`, `set_status_id`, `match_category_id`) reference partner-axis tables (`ticket_categories`, `ticket_statuses`) that are not in the org list, so `RESTRICT` is safe there.

### 8.2 New columns on registered tables

| Column(s) | Table | Export classification | Other |
|---|---|---|---|
| `merged_into_ticket_id`, `merged_at`, `merged_by_user_id`, `routing_rule_id`, `sla_calendar_revision_id`, `sla_paused_business_minutes`, `response_due_at`, `resolution_due_at`, `response_warn_at`, `resolution_warn_at` | `tickets` (`tenantExportPolicyRegistry.ts:960`) | `included` | `tickets_merged_into_org_fk` composite `DEFERRABLE INITIALLY IMMEDIATE`, added to both movers' `SET CONSTRAINTS … DEFERRED`; org merge re-points tickets wholesale (self-FK stays in-org); tombstones carried by movers (§3.9) |
| `merged_from_ticket_id` | `ticket_comments` | not org-cascade itself (no `org_id`; RLS via parent) | plain FK `SET NULL` |
| `business_calendar_id` | `org_ticket_settings` (export `tenantExportPolicyRegistry.ts:677`; `keep-survivor` at `orgMergeRegistry.ts:531`) | `included` | FK → `business_calendars` `ON DELETE SET NULL` (edge break, §8.1); same-partner trigger (§4.1). On org merge the survivor's setting is kept, and the loser's org-owned calendars are re-pointed to the survivor org. |

`ticket_outbox.event_type` is text, so `ticket.merged` needs no migration. It does need the TS union, the publisher bridge and the eventBus `EventType`. No new table has a `device_id`, so `CORE_DEVICE_CASCADE_DELETE_TABLES` is unaffected. No new table has `ticket_id` together with a denormalised `org_id`, so `TICKET_ORG_DENORMALIZED_TABLES` and `CUSTOM_ORG_REWRITE_TABLES` are unaffected.

### 8.3 Why no `org_id NOT NULL` table

All three new config tables are partner-wide first. The only org-scoped addition is a column on the existing `org_ticket_settings`. A merge record table was considered and rejected: the tombstone columns plus two audit rows carry the same facts with one fewer registration surface.

### 8.4 Migrations

Names are chosen at plan time and must sort after the newest committed migration (`2026-12-31-170000-m365-consent-sessions-v2-only.sql` at this base). Rules:
- Idempotent (`IF NOT EXISTS` / `DO $$`), with no inner `BEGIN`/`COMMIT`.
- Every row-writing file (the backfills) elects system scope first.
- The `tickets` backfill is batched.
- Roughly one migration per wave: merge columns; SLA columns + backfill; calendar tables + backfill; routing tables.

### 8.5 Intentional behaviour corrections (not a pure refactor)

Switching the six readers to stored deadlines fixes three existing disagreements on purpose. Each is listed in release notes:
1. The portal stops inventing priority-default targets for null-target tickets.
2. `SlaTimers` stops calling a late completion "met".
3. Response attainment stops counting post-response pauses.

Merged tombstones also leave attainment denominators (§3.6).

## 9. Advisor quorum outcome

Opus wrote the position first. Codex `gpt-6-astra` at xhigh (read-only) reviewed it point by point and **agreed** on 12 of 24 points: M1, M2, M5, M7, M10, C1, C5, C6, R1, R3, R4 and R5. It **disagreed** on 12. Every disagreement was resolved on the merits by adopting Codex's correction:

| Point | Codex objection | Resolution in this spec |
|---|---|---|
| M3 | Inventory incomplete: `ai_operator_task_targets`, idempotency replay, earliest provenance, related re-canonicalisation | §3.3 rows added |
| M4 | A budgeted or approval-bearing **survivor** also bypasses the gate | guard on both sides (§3.1) |
| M6 | Draft send and comment edit lock child → ticket and will deadlock | "ticket row first" invariant + lock-order audit + concurrency tests (§3.5) |
| M8 | `portalTicketOwnership` also authorises writes; header participant check too narrow | separate read predicate; tombstone inbound history counted (§3.8, §6.1) |
| M9 | Tombstones keep many children; device mover breaks the FK | full move routine for tombstones; tombstone `device_id` nulled; FK deferred in both movers (§3.9) |
| C2 | Write points missing: explicit override, first response while paused, resolve while paused | added to the write-point table (§4.3) |
| C3 | "#6831 for free" is false: reopen clears `resolved_at` | freeze defined per target; #6831 stays open (§4.3, §7) |
| C4 | Retroactive recompute reinterprets pause minutes and races the sweep | immutable revisions; only future-dated holiday edits recompute (§4.1, §4.5) |
| C7 | A 400-day horizon rejects valid 525,600-minute targets | week-skipping calculator, no horizon cap (§4.4) |
| R2 | Staff create always sends `priority`, so presence is not a usable signal | explicit-choice provenance (§5.2) |
| W3 | Not a pure refactor | intentional corrections listed (§8.5) |

No disagreement is left unresolved. The Todd-gated items below are product calls, not design-quality splits.

## 10. Open Decisions

Each decision has a recommendation, and work proceeds on it unless Todd overrides. **D1–D3 are Todd-gated**: each is a product, disclosure or settings-home call with no precedent.

- **D1 (Todd): What may the source's requester see after a merge?**
  - (a) Nothing new: the tombstone banner shows the survivor number with no link.
  - (b) Read the survivor's public thread and reply publicly, through a separate read predicate. Writes stay explicit.
  - (c) Read-only access.

  **Recommend (b).** The two requesters are in the same customer org, and the technician merged deliberately after a preview that warns when the requesters differ. Email replies from that requester already thread to the survivor (§3.8), so (a) or (c) would make the portal stricter than email. The disclosure risk (requester B reads A's public replies) is why this is Todd's call.
- **D2 (Todd): Where do business hours live?**
  - (a) Ticketing → Priorities & SLAs, with the Regional card removed.
  - (b) Partner → Regional, as a cross-domain calendar.

  **Recommend (a).** Settings rule 2 puts ticketing settings under Ticketing, and SLA is the only consumer in v1. When after-hours approvals adopt calendars, they read the same resolver and do not add a second editor.
- **D3 (Todd): Approvals and budgets on merge.**
  - (a) Refuse when either ticket has any approval request or a budget.
  - (b) Move the time and re-run the approval gate on the survivor.

  **Recommend (a)** for v1. Approvals are off by default and rare. (b) needs a trigger exception on immutable decided requests and a re-gating path. Revisit when a partner hits the 409.
- **D4: Undo.**
  - (a) None. Preview plus confirm.
  - (b) A short undo window backed by a merge journal.

  **Recommend (a).** An undo has to un-move invoiced-time references, email links and dropped links. A journal adds a new tenant table and registrations for a rare correction.
- **D5: Survivor SLA.**
  - (a) The survivor keeps its own clock, and the UI suggests the older ticket as survivor.
  - (b) The survivor adopts the earlier of the two deadlines.

  **Recommend (a).** It is simpler, it never back-dates a deadline the survivor's requester saw, and the older-survivor default already keeps the earliest commitment.
- **D6: Notify the source requester on merge.**
  - (a) An opt-out checkbox, defaulted on when the requesters differ.
  - (b) Always.
  - (c) Never.

  **Recommend (a).**
- **D7: Rule order across axes.**
  - (a) Org rules, then partner-wide rules, first match wins.
  - (b) Partner-wide rules first.

  **Recommend (a).** This is settings rule 3: the org is more specific.
- **D8: Default inbound assignee.**
  - (a) Keep it as the fallback and move its editor into Routing.
  - (b) Convert it into a system catch-all rule.

  **Recommend (a).** Under first-match-wins, a catch-all would stop applying whenever an earlier rule matched without assigning. That would change today's guarantee.
- **D9: Per-priority or per-category calendar** (for example "urgent is 24×7").
  - (a) Defer.
  - (b) A nullable calendar on `ticket_priority_settings`.

  **Recommend (a).** (b) adds a second place the concept is configured, which needs a Rule 9 justification. Revisit on a partner ask.
- **D10: Per-site calendar or time zone.**
  - (a) Defer. One calendar per org, with its own time zone.
  - (b) Resolve by the ticket device's site.

  **Recommend (a).** Tickets have no site of their own, and `device_id` is optional.
- **D11: Portal due time.**
  - (a) Status only, as today.
  - (b) Also show "expected by".

  **Recommend (a).** A shown time becomes a customer-facing commitment that changes when a holiday is added.
- **D12: Correcting a calendar for tickets already open.** Revisions apply to new tickets only (§4.5), so a time-zone or hours typo stays wrong for every open ticket.
  - (a) New tickets only, with no correction path.
  - (b) An explicit admin "apply this revision to open tickets" action. It recomputes all unfrozen targets and accepts the caveat that past pause minutes are reinterpreted.
  - (c) The same action, limited to open tickets with **no pause history** (`sla_paused_business_minutes = 0` and not paused). Their deadlines recompute exactly.

  **Recommend (c)**, behind a preview that shows how many tickets would move and how many would become immediately breached. Tickets with pauses keep their revision, and the preview counts them.

## 11. Waves (sketch; plans are written after approval)

| Wave | Content | Track | Depends on |
|---|---|---|---|
| W1 | Merge backend: tombstone columns, merge service and route, preview, lock-order audit and the writer fixes, threadMatcher and sender binding, Partner API exposure, the portal read predicate and tombstone write guards, movers carrying tombstones, AI tool actions | plan (high blast radius: data movement, locking, billing rows) | — |
| W2 | Merge UI: header action, preview dialog, banners in web and portal, list hiding | plan | W1 |
| W3 | Stored SLA deadlines with **no calendar**: columns + batched backfill, the shared calculator (24×7 path plus full business-time tests), the six readers switched, the §8.5 corrections | plan (migration over every ticket, six readers) | — (parallel with W1) |
| W4 | Calendars: four tables + RLS + registrations, resolver, revisions, holiday recompute job, settings card, org override, blob backfill, Regional card removal | plan | W3 |
| W5 | Routing rules: tables, evaluator in `createTicket`, explicit-choice provenance on create inputs, Routing tab, dry run, fallback editor move, AI tools | plan | — (independent; lands after W3 if both touch `createTicket` at once) |

Portal SLA display rides W3. Portal merge banners ride W1/W2. There is no separate portal wave. Nothing here is a fast-track.

## 12. Test and rollout notes

- **Cascade ordering.** `tenantCascade.integration.test.ts` must pass with the three `SET NULL` edge breaks registered (§8.1). A test also proves that the service refuses a hard delete of a referenced calendar.
- **Caller contexts.** A ticket is created from portal, inbound email, Partner API, staff and an org-scope token, each under a partner-default calendar and a partner-wide routing rule. Each must resolve the same calendar and rule (§4.2).
- **Contract suites** that must go green, all in **Integration Tests** except where marked:
  - `rls-coverage.integration.test.ts`, the three new `*PartnerRls.integration.test.ts` files, `tenantCascade.integration.test.ts`, `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`, `orgMergeRegistry.integration.test.ts`, `orgLifecycleFoundations.integration.test.ts` (deferrable FK).
  - `orgMerge.test.ts` and `ticketOrgMoveLockOrder.test.ts` run in Test API.
  - `mcp-coverage.test.ts`, `workerReadinessCoverage.test.ts`, `localeParity.test.ts`, `no-silent-mutations.test.ts` and `migrationRlsScope.test.ts`.
- **Merge:**
  - A real-Postgres test per row of the §3.3 table.
  - Path compression (A→B, then B→C leaves A pointing at C).
  - Tombstone write refusal on every writer, checked under lock.
  - Concurrency pairs (§3.5).
  - Inbound: a header reply to the source thread, a subject token for the source number, and a sender bound only to the source. Each lands on the survivor.
  - Partner API idempotent replay after a merge.
  - Invoice lines still render the source label after a billed entry moves.
  - A survivor move carries its tombstones, including the device mover path.
- **Calculator:**
  - Property tests: `businessMinutesBetween(start, add(start, n)) = n`.
  - DST forward and back in America/* and Europe/* and a southern-hemisphere zone.
  - Split shifts, holidays at week boundaries, and a 525,600-minute target.
  - A null calendar is identical to today's formula. A golden test compares the W3 readers to the pre-W3 SQL on a fixture set.
- **SLA:**
  - Each write point in §4.3, including first response while paused and resolve while paused.
  - The freeze rule and reopen.
  - A future-holiday recompute versus the sweep.
  - The backfill reproduces today's breach and at-risk sets exactly, on a fixture copy.
- **Routing:**
  - Order determinism, AND/OR semantics, the org-then-partner order.
  - Partner-wide rows evaluated by the ticket org's partner.
  - An ineligible assignee is skipped and the fallback applies.
  - A routed status of `pending` starts the clock paused.
  - Import mode is skipped.
  - Explicit staff priority is not overridden.
- **Rollout.** Every behaviour is dark by default:
  - Merge is a new action.
  - W3 reproduces the current arithmetic.
  - Calendars apply only once a partner marks a default.
  - Rules apply only once one exists.

  W3's corrections (§8.5) are the only visible change on deploy, and the release notes say so.
