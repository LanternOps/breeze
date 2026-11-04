---
title: ServiceNow linkage for Breeze tickets — generic external references, a customer-owned ServiceNow connection, push and status/comment sync
issue: 11019
related: [10499, 10528, 7181, 8313]
status: draft
date: 2026-11-04
base: main @ 36f9d9ca53
area: integrations (ticketing aspects in §3.1, §3.4 and §4)
---

# ServiceNow linkage for Breeze tickets

Evidence labels: **verified** = read in code at `36f9d9ca53`; **inferred** = reasoned, or ServiceNow behaviour taken from its public API model, not run against an instance. Line numbers are at that SHA. Paths are relative to `apps/api/src/` unless they start with `apps/` or `packages/`.

## 1. Problem

Some enterprise customers of an MSP require every piece of work to exist in **their own** ServiceNow instance, with a reference id. A design-partner MSP's technicians currently enter each job twice: a Breeze ticket and a ServiceNow incident or task, then they copy the ServiceNow number back by hand. Breeze has most of the parts, but nothing connects them for this case:

1. **The ticket's external-reference table is owned by Partner API principals only.** `ticket_external_refs` (#7181) has `partner_service_principal_id NOT NULL`, and its two unique indexes are keyed on the principal (verified: `db/schema/ticketExternalRefs.ts:17-53`). The only writers are the Partner API ticket routes and the ticket import writer, and both act as a principal (verified: `routes/partnerApi/ticketWrites.ts:75-76,319-384`, `services/ticketImport/importWriter.ts:323-329`). A technician cannot record "this is INC0012345" in the UI, and a native integration cannot own a ref either.
2. **The staff UI does not show refs.** The only web reference is a count in the merge dialog (verified: `apps/web/src/locales/en/tickets.json:528`, `components/tickets/MergeTicketDialog.tsx`). The portal shows none. Search already finds a ticket by any ref's `external_number` (verified: `services/ticketSearch.ts:15-31`).
3. **Legacy single-slot columns are dormant.** `tickets.external_ticket_id` and `external_ticket_url` (verified: `db/schema/portal.ts:204-205`) have no writer left in `apps/api/src` (verified by grep). The Partner API explicitly stopped writing them (`ticketWrites.ts:75-76`). This design does not revive them.
4. **A ServiceNow adapter exists but has never been used against a live system.** `ServiceNowProvider` has Basic auth only, `createTicket`/`updateTicket`/`getTicket` on a configurable `incidentTable`, and it throws a plain `Error` that contains the raw response body (verified: `services/psa/servicenow.ts:15-24,67-88,167-223`). The #10499 W2 alert path introduced structured `PsaAdapterError` classes and an optional capability interface (verified: `services/psa/types.ts:150-292`). Only ConnectWise implements that capability.
5. **Org-owned connections already exist.** `psa_connections` is org XOR partner. The org arm is documented as "a customer's own Jira/Zendesk in a co-managed engagement" (verified: `db/schema/integrations.ts:163-171`). Creating one needs `orgs:write`, MFA and org-wide integration access (verified: `routes/psa.ts:543-600`). That is the right owner for a customer's ServiceNow. Nothing uses org-owned connections yet beyond test and company import.

#10499 / feature #10528 covers the outbound **alert → MSP PSA** direction. All of its waves are closed (verified: #10529–#10537), and it provides the ledger, lease and error-class patterns this spec reuses. This spec covers a different relationship: a **Breeze ticket ↔ the customer's ITSM record**, for the life of the ticket.

## 2. Users and scope

| Wave | Who configures | Level | Who sees the result |
|---|---|---|---|
| W1 generic external references | Any technician with `tickets:write` on the ticket's org | **Per ticket** (data, not a setting) | Staff who can read the ticket. Portal users see refs marked portal-visible. |
| W2 ServiceNow connection and "Send to ServiceNow" | Partner or org users with `orgs:write` + MFA + org-wide integration access (the existing connection gate) | **Org.** The connection is **org-owned**: the customer's instance holds the customer's credentials. No partner default in W2 (OD3). | Staff on the ticket see the ServiceNow number, link and sync state. Portal users see the number and link. |
| W3 inbound sync | Same card as W2 | Org | Inbound comments and state changes appear in the ticket feed |
| W4 auto-send rules | Same card | Org | As W2 |

**In scope for W2 to W4:** org-owned ServiceNow connections only. A partner-owned ServiceNow connection (an MSP that runs ServiceNow as its own PSA) needs company mapping through `organization_external_links` and is the #10499 shape, not this one (OD2).

**Service-management mode.** Linkage works whenever Breeze tickets exist, so in `native` and `external` modes. In `off` mode no new tickets are created (verified: `db/schema/orgs.ts:180-192`), and the UI hides the card. This needs no code gate beyond that.

## 3. Proposed design

### 3.1 W1 — generic external references on tickets (the issue's minimum viable fallback)

W1 is useful on its own: a technician types the ServiceNow number into the ticket, search finds it, and the portal shows it. W1 also gives W2 the identity model it builds on.

**Generalize `ticket_external_refs` rather than add a second ref table.** The table already carries search (`external_number`), merge repoint (`origin_ticket_id`, `services/ticketMerge/repoint.ts`), both org movers (`services/ticketOrgMoveLockOrder.ts:88-97,197`, `routes/devices/core.ts:532-537`), erasure, merge and export. A second table would have to repeat all of that, and every reader would need a union. The change:

- `partner_service_principal_id` becomes **nullable**. Existing rows all have it, so no backfill is needed.
- New `psa_connection_id uuid NULL` → `psa_connections(id) ON DELETE SET NULL`. When a connection is deleted, its refs survive as plain references, so the number stays on the ticket.
- New `label varchar(60) NULL`, the system name shown on the chip ("ServiceNow", "Vendor case"). It is required when the principal is NULL. A connection-owned ref stores the provider's display name, so it still reads correctly after a `SET NULL`.
- New `portal_visible boolean NOT NULL DEFAULT false`.
- CHECK `num_nonnulls(partner_service_principal_id, psa_connection_id) <= 1`. CHECK `partner_service_principal_id IS NOT NULL OR label IS NOT NULL`.
- **Kind is derived, not stored:** a set principal makes a `principal` ref, a set connection makes a `connection` ref, and neither makes a `manual` ref. A derived kind cannot disagree with the columns, and `ON DELETE SET NULL` turns a connection ref into a manual one without breaking a CHECK.
- Partial unique indexes: `(psa_connection_id, ticket_id) WHERE psa_connection_id IS NOT NULL` (one link per connection per ticket) and `(psa_connection_id, external_id) WHERE psa_connection_id IS NOT NULL` (one Breeze ticket per remote record).
- **Manual refs have no database unique index.** The service refuses a duplicate `(label, number)` on add and caps a ticket at 10. Duplicates that a detach or a merge creates are allowed, and the read model collapses identical `(label, number)` pairs. A unique index here would make detach (a `SET NULL` from connection deletion, unlink, or a move) and ticket merge fail whenever an equal manual ref already exists. The current merge conflict handling compares principals only (Codex; `services/ticketMerge/repoint.ts:153`).
- **Owner invariant trigger** (`BEFORE INSERT OR UPDATE OF org_id, psa_connection_id`): when `psa_connection_id` is set, the connection must be org-owned by `NEW.org_id`. In W2 a partner-owned connection is rejected. The trigger **fails closed**: if a mover forgets the detach step below, the move aborts instead of leaving org B's ticket linked to org A's ServiceNow.

**Service** (`services/ticketExternalRefs.ts`): add `addManualRef`, `updateManualRef`, `removeManualRef` and `listRefsForTicket(ticketId, { audience: 'staff' | 'portal' })`. The ticket row lock comes first, and a merged tombstone is read-only, as the existing upsert does (`:63-84`). The existing principal-keyed functions keep filtering on the principal (`:152-161`). Partner API output therefore does not change: connection and manual refs never appear in a principal's `externalTicketId`.

**API.** `GET/POST/PATCH/DELETE /tickets/:id/external-refs` under `routes/tickets/`. Reads need ticket read access. Writes need `tickets:write` and run through `runAction` on the web. A connection ref cannot be edited or removed here; it changes only through W2's unlink action. `external_url` must be https: reuse `externalTicketUrlSchema` (`packages/shared/src/validators/tickets.ts:56`, which accepts http today; verified) with an https-only refinement for these routes. The portal ticket route (`routes/portal/tickets.ts`) adds `externalRefs: [{label, number, url}]`, filtered to `portal_visible`. The portal has its own `ticketReadAccess.ts`, so the plan adds the field there and not in the staff serializer.

**UI.**
- The ticket workbench (`components/tickets/TicketWorkbench.tsx`) gets a "References" chip row in the header: label, number, link, and a sync-state dot for connection refs.
- A drawer adds or edits manual refs: label (free text, suggested from the org's connections), number, optional URL, and a "Show in portal" checkbox, default on.
- The portal ticket page shows the chips.
- New locale keys go into all 8 locales.

**Move, merge and delete semantics (shared helper, used by both movers and merge).**
- *Ticket org move or device org move:* before restamping, `detachConnectionRefsForOrgMove(ticketIds, targetOrgId)` runs the lifecycle fence (§3.2), deletes the W2 sync rows, sets `psa_connection_id = NULL` on refs whose connection the target org does not own, and writes a feed note: "ServiceNow sync stopped: the ticket moved to another organization." The remote record is not touched.
- *Cross-partner move* (system scope only): today the device mover deletes **every** ref whose `partner_id` differs from the target's (verified: `services/deviceOrgMove/moveDeviceOrgInTransaction.ts:1219-1224`). That predicate narrows to **principal** refs only, which still cannot follow because their principal belongs to the old partner. Manual and detached refs belong to the ticket, so they are restamped with the new `org_id` **and** `partner_id`; the composite `(org_id, partner_id)` FK requires both. `moveTicketOrg` gets the same rule.
- *Org merge:* the org's connections repoint with it (`psa_connections` is in `REPOINT_TABLES`, `services/orgMergeRegistry.ts:1223`), so links stay consistent and nothing detaches.
- *Ticket merge:* refs move to the survivor (existing repoint). `ticket_sync_links` rows move through the ticket-merge machinery explicitly (`services/ticketMerge/repoint.ts`, `movers.ts`); registering for org merge and the movers is not enough. If the survivor already has a link to the **same** connection, the loser's link is detached to a manual ref and its sync row is deleted, so one remote record keeps one live Breeze ticket. A moved sync row keeps its **original marker** (§3.2), including a row whose create outcome is unknown. Otherwise recovery would search for the survivor's marker, not the one that was submitted.
- *Ticket delete:* refs and sync rows cascade. The remote record is untouched.

**Legacy columns.** `tickets.external_ticket_id/url` stay dormant. The plan counts non-null rows in production. If there are any, a follow-up backfills them into manual refs labelled "External" and drops the columns. Not in W1.

### 3.2 W2 — org-owned ServiceNow connection, "Send to ServiceNow", outbound push

**Connection (reuses `psa_connections`, org arm).**
- *Auth.* Basic auth (exists) **and** OAuth 2.0 client credentials. The adapter exchanges the client id and secret at `/oauth_token.do` and caches the access token in memory per connection until shortly before expiry. The client-credentials grant is **off by default** on an instance: it needs a system property and an OAuth application user (Codex, citing ServiceNow docs; the lab confirms it). The connection form says so. `REQUIRED_CREDENTIAL_KEYS.servicenow` requires `username`/`password` today (verified: `services/psa/credentials.ts:94`), so it becomes auth-mode groups, the way Jira's modes already are. Both kinds of secret live in the encrypted `credentials` column (`services/psa/credentials.ts:27-29`). The connection form recommends a dedicated integration user with web-service-only access and the least role that can write the target table.
- *Base URL.* Any https host. It is not pinned to `*.service-now.com`, because customers use custom and government domains. `validatePsaBaseUrl` and `psaFetch`'s SSRF guard and 20 s timeout already apply (`services/psa/http.ts`).
- *Errors.* `ServiceNowProvider.request` throws `PsaAdapterError` with the class rules in `types.ts:150-176`. The message never includes the body. That fixes the raw-body leak at `servicenow.ts:78-81`.

**New optional capability `PSATicketLinkage`** (`services/psa/types.ts`, next to `PSAAlertTicketing`):
- `createLinkedRecord`, `updateLinkedRecord` (state, priority, short description), `addJournalEntry(kind: 'comments' | 'work_notes')`, `getLinkedRecord`, `findByNumber`, `findByMarker(ticketId)`, `listChangedSince(cursor, sysIds)` and `listJournalSince(cursor, sysIds)` (W3), plus pickers for states, assignment groups and the integration user.
- Only `ServiceNowProvider` implements it. `supportsTicketLinkage(provider)` gates the card, the same way `supportsAlertTicketing` does (`types.ts:269-278`).
- *Marker:* the task-family `correlation_id = breeze-ticket:<ticketId>`, and `correlation_display = <Breeze ticket number>`. The marker is stored on the sync row at admission as an **immutable** `marker` column and is never recomputed. `correlation_id` is a plain string field, not a remote idempotency guarantee, so lookups handle several matches (adopt the oldest, record the rest for a human). On link-existing, the marker is written only if the remote field is empty. A foreign correlation value is never overwritten, and the link is still tracked by its `sys_id` (inferred; the lab checks it).
- *Target table:* **`incident` only in W2.** `sc_task` and other `task`-derived tables come later, once their required fields and state transitions are modelled and lab-checked (Codex). The `table` setting exists from W2 so a later wave only widens its enum.
- *Resolve and close:* a state-only PATCH is not a general contract. Resolving an incident usually needs a resolution code and notes, and an instance can enforce more through data policies. Resolving and closing can also need different roles (inferred; Codex). The config models `resolution: { closeCode, closeNotesTemplate }`. A `rejected` resolve is shown on the chip, and it never retries in a loop.

**Linkage settings (settings rule 9).**
- *Home:* Integrations → PSA → (the org's ServiceNow connection) → "Ticket linkage" card (`/integrations#psa`, `components/psa/PsaConnectionsPage.tsx`).
- *Level:* org (the connection's owner). No partner default (OD3).
- *Resolver:* one `resolveTicketLinkageConfig(connection)`, used by the send action, the worker, the reconciler and the card preview.
- *Count:* ServiceNow-linkage configuration exists in **0** places today. The only related value is the API-only `ServiceNowSettings.incidentTable` in `psa_connections.settings` (verified: `servicenow.ts:21-24,51-53`), which nothing outside the adapter reads. After W2 the concept is configured in **1** place. `incidentTable` is migrated into the card and removed from `settings`, so the target table is also configured in 1 place.
- *Storage:* `psa_connections.ticket_linkage jsonb` (NULL = off) plus `ticket_linkage_rev`. This is the same shape as the accepted #10499 OD6 `alert_ticketing` column (verified: `db/schema/integrations.ts:187-209`), validated by a per-provider Zod schema in `packages/shared/src/validators`. It holds no credentials. Fields:
  - `enabled`, `table`, `callerSysId?`, `assignmentGroupSysId?`
  - `fieldDefaults` (at most 20 `field → string` pairs; names match `^[a-z_][a-z0-9_]{0,79}$`; the fields Breeze sets itself are rejected)
  - `stateMap` (Breeze core status → remote state value) and `priorityMap` (Breeze priority → remote priority or impact/urgency pair)
  - `pushPublicComments` (default on, to `comments`), `pushInternalNotes` (default **off**; to `work_notes` when on)
  - W3: `inbound: { comments: 'internal' | 'public' | 'off', closeAction: 'note' | 'resolve' }`, defaults `internal` and `note`
  - W4: `autoSend: { enabled, categoryIds?, formIds?, minPriority? }`
  - `isDefaultForNewSends` (a column, `ticket_linkage_default`, not in the jsonb). A partial unique index keeps **one default connection per org**, so "Send to ServiceNow" never has to ask which one. Other enabled connections keep servicing the links they already hold. **Org merge:** `psa_connections` repoints as a plain row (`orgMergeRegistry.ts:1223`), so two orgs that both have a default would collide. The merge policy clears the absorbed org's default flag before the repoint. Both connections keep syncing their existing links, and the survivor's default handles new sends.

**Ledger: `ticket_sync_links`** (new; one row per connection-linked ticket). This is the #10499 W2 model: Postgres is the ledger, and events and BullMQ only wake it (verified pattern: `services/psaAlertTicketing/*`, `jobs/psaTicketingWorker.ts`, `jobs/psaTicketingReconciler.ts`).
- *Columns:* `id`, `org_id`, `ticket_id`, `psa_connection_id`, `marker` (immutable), `generation` (bumped by every detach, unlink or move), `config_rev`, `source` (`manual` | `linked_existing` | `auto`), `create_state` (`never_attempted` → `create_in_flight` → `created` | `create_outcome_unknown` | `rejected` | `needs_attention`), `create_snapshot jsonb`, `push_state` (`idle` | `dirty` | `in_flight` | `failed`), `pushed_status`, `pushed_priority`, `pushed_subject_hash`, `pushed_through_at`, `comment_watermark_at` and `comment_watermark_id`, `comment_attempt_id` and `comment_attempt_state` (the one comment append in flight), `remote_sys_id`, `remote_state` and `remote_updated_on` (W3), `attempts`, `next_attempt_at`, `deadline_at`, `lease_token`, `lease_until`, `last_error`, `last_error_class`, `paused_reason`, `created_at`, `updated_at`.
- *Constraints:* unique `(psa_connection_id, ticket_id)`. The ref in `ticket_external_refs` is written **when the remote record is known**: on create success, on adopt, or on link-existing. Before that, a ref would need `external_id NULL`, which would weaken the column every existing reader relies on.

**Send to ServiceNow (manual).** A ticket action, shown when the org has an enabled linkage connection and the ticket has no live link.
- *Create* admits a ledger row (`ON CONFLICT DO NOTHING`), then wakes the worker. It needs `tickets:write` and runs through `runAction`.
- *Link existing:* the technician enters a number, the adapter looks it up (`findByNumber`), and Breeze links the record and starts pushing. If the remote record already has another ticket's marker, the request is refused.
- *Unlink* deletes the sync row and turns the ref manual. It needs `tickets:write` and is audited.

**Worker `ticket-sync`** (BullMQ, registered in `jobs/workerReadinessManifest.ts`). Jobs carry ids only.
- *Claim:* a CAS claim with a lease token in a short transaction. The remote call runs outside any transaction (#1105). The write-back is a CAS on the lease token. This is the same mechanics as `psaAlertTicketing/execution.ts`. The plan extracts the shared lease and backoff code instead of copying it.
- *Lifecycle fence (claim-time checks alone do not fence remote writes; Codex, `psaAlertTicketing/execution.ts:246`).* Before **each** remote call, a short transaction re-reads the row and checks four things: the lease token and `generation` are unchanged, the connection is enabled and not paused, `ticket.org_id = connection.org_id`, and the ticket is not a merged tombstone. Any mismatch ends the job without a call. On the other side, a detach (from a move, merge, unlink or connection delete) locks the sync row. If a lease is live (`lease_until > now()`, at most 30 s because `psaFetch` times out at 20 s), it waits for the lease to clear or lapse, then bumps `generation` and detaches. This leaves at most the one request already issued as a race, and it was issued while the ticket still belonged to the connection's org. **OD10** asks whether a move should wait for the lease or refuse with 409.
- *Create:* the worker writes `create_in_flight` with a snapshot, then POSTs: `short_description` = subject, `description` = the Breeze ticket description, number and a deep link; then the marker, caller, assignment group and `fieldDefaults`. On an **unknown outcome** it never re-POSTs. It retries `findByMarker` with backoff for up to 2 h, then moves to `needs_attention` with "Create anyway" and "Mark handled". This is the accepted #10499 rule.
- *Push (state-reconciling, not event-replaying):* the worker computes the desired remote state from the **committed** ticket: the mapped status, the mapped priority and the subject. It PATCHes only the fields that differ from `pushed_*`. Then it appends, in order, the Breeze comments after the watermark that pass the push filters and do **not** originate from this connection (`origin_principal_kind = 'integration' AND origin_principal_id = connection id`, §3.3). **At most once, durably:** before each append, the worker commits `comment_attempt_id = <comment id>, comment_attempt_state = 'in_flight'`. After the call it advances the watermark and clears the attempt in one CAS. A row found with an `in_flight` attempt (a crash after the append, before the CAS) treats that comment as `outcome_unknown`. It never re-sends it, advances past it, and the feed shows "may not have reached ServiceNow". This is the alert worker's note rule (`psaAlertTicketing/execution.ts:187`).
- *Wake-ups:* an event subscriber on `ticket.status_changed`, `ticket.commented`, `ticket.updated` and `ticket.assigned` (verified: `services/eventBus.ts:150-161`) marks the link `dirty` and enqueues work, registered in `EVENT_SUBSCRIBER_IDS` with its contract test. The **reconciler** (every 2 min) does not trust `dirty` alone: if the subscriber never ran, the row never became dirty. It derives outstanding work from **committed state**, the way the alert reconciler does (`psaAlertTicketing/storage.ts:204`). A link is due when `tickets.updated_at > pushed_through_at`, or when a pushable comment exists after the watermark, or when an operation is overdue. A dropped event in the default `off` dispatch mode, which silently drops subscriber errors (#10499 §1), therefore costs latency, not correctness.
- *Failure classes* (from `PsaAdapterError`): `rate_limited` and `transient` back off and honour `Retry-After`. `rejected` is terminal for that operation, with the reason shown. `auth` **pauses** linkage for the connection until a successful test-connection. Each connection makes one call at a time (a Redis lease).

**Surfacing.**
- *Ticket header chip:* the number, a link, and the sync state (synced, pending, needs attention, paused) with a retry action.
- *Connection health:* a new source `ticketLinkage` in `services/connectionHealth/sources/`, registered in `coverage.contract.test.ts`. The connection is org-owned, so the incident carries `orgId` and does emit `integration.health_opened`. Partner incidents do not (verified, #10499 §3: `connectionHealth/events.ts:40-48`).
- *Card:* counts by state, a failure list, and bulk re-drive.
- *Sentry `errorId`s:* `TICKET_SYNC_CREATE_FAILED`, `…_OUTCOME_UNKNOWN`, `…_PUSH_FAILED`, `…_AUTH_PAUSED`. They are tagged with connection and provider and never include a response body.
- *Audit:* config changes, send, link-existing, unlink, "Create anyway" and pause/resume.

### 3.3 W3 — inbound sync (poll)

**Poll, not webhook, first (OD5).** A poll needs nothing configured on the customer's instance, and it works through a customer firewall that allows only outbound calls from Breeze.

- *Cadence:* every 3 min, for each enabled linkage connection (a BullMQ repeatable job with a per-connection lease).
- *Customer setup is not zero* (Codex). Reading journal entries needs an ACL on `sys_journal_field` that incident access does not imply, and OAuth needs the grant enabled. The card checks journal access when linkage is turned on. Without it, inbound comments are **disabled**; there is no display-value fallback, because that loses journal ids and authors and so breaks dedupe.
- *Records:* poll by the **locally bound** `remote_sys_id`s, never by marker prefix, so a linked-existing record with a foreign `correlation_id` is still seen. The query is `sys_idIN<chunk>^sys_updated_on>=<cursor>`, selecting `sys_id, number, state, sys_updated_on`, in chunks of 100 (inferred query shape). The cursor is per connection and overlaps by 60 s.
- *Journal:* `sys_journal_field` filtered by `element_id IN (<changed sys_ids>)`, `element IN (comments, work_notes)` and `sys_created_on >= <cursor>` (inferred).
- *State dedupe:* the row stores `remote_state` and `remote_updated_on`. A state note is written only when the remote state **differs** from the stored one, so the overlap window and comment-only updates never add repeated notes.
- *Loop guard:*
  - An entry created by the connection's own integration user (`sys_created_by`) is skipped.
  - An inbound comment is written with `origin_principal_kind = 'integration'`, `origin_principal_id = <connection id>` and `import_source_id = <journal sys_id>`. The existing partial unique index `ticket_comments_import_source_uq (origin_principal_id, import_source_id)` makes replays no-ops (verified: `migrations/2026-12-25-120100-migration-window-ticket-indexes.sql:21-22`). That index is the reason `origin_principal_id` carries the connection id.
  - The outbound push skips these comments.
  - The helpdesk loop guard already treats every kind other than `user` as suspect (verified: `db/schema/portal.ts:341-354`).
  - Adding `'integration'` to `ticket_comments_origin_principal_kind_chk` (current list `'user','ai_agent','system','service_principal','unknown'`, verified: `migrations/2026-12-04-101100-…:57-59`) is a migration. The plan sweeps every reader of that column.
- *State:* a remote close or cancel applies `closeAction`: `note` (default) adds an internal note. `resolve` resolves the Breeze ticket as the integration actor, through the normal ticket service, so SLA, billing and notifications behave exactly as for a manual resolve. Other remote state changes add an internal note only. **Breeze stays the system of record for MSP work state.** Two-way status mirroring ping-pongs, and the customer's state model is not the MSP's (OD6).
- *Visibility:* remote `work_notes` always become **internal** notes, whatever `inbound.comments` says. Only remote `comments` (additional comments) follow the setting. Inbound comments default to `internal`, so a customer comment made in ServiceNow does not email the same customer back through Breeze's requester notifications. With `public`, the normal public-comment path runs.
- *New live-write contract (a W3 prerequisite).* Today `TicketActor` has no integration kind (verified: `services/ticketService.ts:147-160`). Live comments reject imported authorship, and `import_source_id` is stamped only in import mode (Codex: `ticketService.ts:2709,2795`). W3 adds `{ kind: 'integration', connectionId, remoteAuthor }` and one service entry, `addIntegrationComment`. It inserts with `ON CONFLICT` on the import-source index, and side effects (events, notifications, SLA) run **only when a row was inserted**. An integration comment is **requester-side**: it never satisfies first-response SLA. Today any first live public comment does (Codex: `ticketService.ts:2795`), so that rule gains an actor check.

### 3.4 W4a — auto-send rules; W4b — wake-up webhook (independent)

- **Admission** happens at `ticket.created`, plus a reconciler arm that admits tickets created after `autoSend.enabledAt` that match and have no link (the #10499 W2 repair-path pattern).
- **Filters:** category, intake form, minimum priority. The source (portal, email, alert, manual) is not a filter in W4.
- **Optional inbound webhook** (OD5 b): a per-connection HMAC endpoint that a customer's Business Rule or Flow can call to wake the poll early. It only **wakes** the poll and never carries data that Breeze trusts, so it adds no new trust path.

## 4. Tenancy and data-model impact

| Change | Wave | Shape | Registries (grep, don't judge) |
|---|---|---|---|
| `ticket_external_refs`: `partner_service_principal_id` → nullable; new `psa_connection_id` (FK `ON DELETE SET NULL`), `label`, `portal_visible`; CHECKs; partial unique indexes for connection refs only; owner-invariant trigger; the cross-partner move predicate narrows to principal refs | W1 (columns, trigger) | Shape 1, unchanged. `partner_id` stays NOT NULL = the org's partner, and the composite `(org_id, partner_id)` FK is unchanged. The `(principal, partner)` composite FK is MATCH SIMPLE, so a NULL principal skips it (inferred; test it). | **Export:** `psa_connection_id`, `label`, `portal_visible` → `included` (`services/tenantExportPolicyRegistry.ts:1000`). Cascade, merge and both movers: already registered (`tenantCascade.ts:1072`, `orgMergeRegistry.ts:1325`, `ticketOrgMoveLockOrder.ts:94,197`, `routes/devices/core.ts:537`). **FK direction:** `psa_connections` sorts before `ticket_external_refs`. Because the new FK is `ON DELETE SET NULL`, erasure of the connection first only nulls the column. Confirm that `tenantCascade.integration.test.ts`'s FK-order property ignores SET NULL edges, or add the pre-clear next to the existing `psa_ticket_mappings` one (`tenantCascade.ts:1323-1373`). The plan must also re-check the `ticketMerge/repoint.ts` conflict handling against the new partial unique indexes. |
| `ticket_sync_links` (new) | W2 | Shape 1 on `org_id`. Composite `(ticket_id, org_id) → tickets(id, org_id)` `DEFERRABLE INITIALLY IMMEDIATE`. FK `psa_connection_id → psa_connections(id) ON DELETE CASCADE`. The same owner-invariant trigger as the ref. RLS enabled, forced, and `breeze_has_org_access(org_id)` in the creating migration. | `CORE_ORG_CASCADE_DELETE_ORDER`: the list is alphabetical, but erasure executes in FK-topological order (Codex: `tenantCascade.ts:1591`), so position alone needs no pre-clear; the integration test still proves it. `orgMergeRegistry` `repoint`. `CORE_TENANT_EXPORT_POLICY`: `create_snapshot` → `excludedOpen`; `last_error` → `excludedSensitive`, because it holds receiver text; `lease_token` and `pushed_subject_hash` → `reviewedIncluded`, because they match `token` and `hash`; the rest `included`. **Ticket merge:** explicit repoint in `services/ticketMerge/` (§3.1). It is a ticket-linked table with a denormalized `org_id`, so it goes in `TICKET_ORG_DENORMALIZED_TABLES` **and** `CUSTOM_ORG_REWRITE_TABLES`, in the same relative order. Completeness is now schema-derived: `routes/devices/moveOrg.coverage.test.ts:805-815` fails a ticket-child table with `ticket_id` + `org_id` that is missing from the list. The "runtime only" line in `docs/agents/tenancy-rls.md` is stale, and the plan corrects it. Its composite FK name joins both movers' `SET CONSTRAINTS … DEFERRED` statements (`ticketService.ts:4143`). The detach helper deletes the rows before the restamp, so the rewrite normally touches none. Registration still has to happen for the merge and lock-order contracts. No `device_id`, so no device-move disposition. |
| `psa_connections.ticket_linkage jsonb`, `ticket_linkage_rev`, `ticket_linkage_default`, `ticket_linkage_enabled_at`, `ticket_linkage_paused_reason/_at`; partial unique "one default per org" | W2 | Dual-axis XOR, unchanged | Export: `ticket_linkage` → `excludedOpen`; the rest `included`. **Org-merge policy:** `psa_connections` changes from plain repoint to repoint with a pre-step that clears the absorbed org's `ticket_linkage_default` (`orgMergeRegistry.ts:1223`; `orgMerge.test.ts` unit suite plus `orgMergeRegistry.integration.test.ts`). The partner-wide SELECT branch on `psa_connections` lets org sessions read partner-owned rows. A linkage connection is org-owned, so only that org's sessions and its partner's sessions can read it. |
| `ticket_comments_origin_principal_kind_chk` gains `'integration'`; `TicketActor` gains `integration` | W3 | unchanged | none. Sweep the readers of `origin_principal_kind` (the helpdesk loop guard, the AI shadow gating, first-response SLA). |

**Why the connection must be org-owned in W2.** A partner-owned connection would be visible to every org under the partner, through the partner-wide SELECT branch. Pushing to it would also need a company per org. The owner-invariant trigger makes "org A's ticket can only sync to org A's connection" a database fact and not only an app-layer check. This is the cross-tenant risk in this feature: a moved ticket that keeps syncing would send org B's work into org A's ServiceNow.

**Secrets.** Credentials stay in `psa_connections.credentials`, encrypted (`encryptSecret`). An OAuth access token is cached only in memory. `last_error` holds a scrubbed snippet, never a body that could echo credentials.

## 5. Out of scope

- A partner-owned ServiceNow connection (an MSP using ServiceNow as its PSA). That is #10499's company-mapped shape (OD2).
- Other ITSMs (Jira Service Management, Freshservice, Zendesk). The capability interface allows them later, and each needs its own lab run.
- Attachments, in either direction.
- `sc_task` and other `task`-derived target tables, until their required fields and transitions are modelled (a later wave).
- Mirroring the remote state model into Breeze statuses (OD6). Remote changes become notes; only close/cancel can optionally resolve.
- Reviving or dropping `tickets.external_ticket_id/url` (a follow-up after a production count).
- AI tool exposure of refs. If added later, budget the tool index (+128 B per tool wave) and classify the tool in `WISP_TOOL_SUBJECTS`.
- Exposing connection and manual refs on the Partner API.

## 6. Open Decisions

**OD1 — Where a ticket's ServiceNow reference lives.**
- (a) Generalize `ticket_external_refs` (nullable principal, connection, manual), plus a separate `ticket_sync_links` ledger.
- (b) One new table that holds both the ref and the sync state. Search, merge, movers and display would all need unions.
- (c) Revive `tickets.external_ticket_id/url`: one slot, last writer wins, nothing to search beyond it.

**Recommend (a).** It reuses five contracts that already work, and the ref keeps `external_id NOT NULL`.

**OD2 — Which connections can link tickets.**
- (a) Org-owned ServiceNow only in W2–W4, enforced by a database trigger.
- (b) Also partner-owned, with company mapping through `organization_external_links`.

**Recommend (a).** The issue's case is the customer's own instance. (b) is the #10499 shape and can come later as its own wave.

**OD3 — Partner default for linkage settings.**
- (a) No partner default. Each org's card is the only home.
- (b) A partner-level template (state map, push rules) that orgs inherit.

**Recommend (a).** The values are instance-specific (table, sys_ids, state values), so a partner default would mostly be overridden. Rule 3 allows a concept with one level. Revisit if partners link many orgs.

**OD4 — ServiceNow auth.**
- (a) Basic and OAuth client credentials.
- (b) OAuth only.
- (c) Basic only (today).

**Recommend (a).** Some instances do not enable client-credentials grants, and Basic with a web-service-only user is a common, accepted setup. The form recommends OAuth.

**OD5 — How inbound changes arrive.**
- (a) Poll every 3 min (W3), with an optional HMAC wake-up webhook in W4.
- (b) A webhook only, pushed by a customer Business Rule.
- (c) Poll only, never a webhook.

**Recommend (a).** A poll needs no inbound path to Breeze. A webhook that only wakes the poll keeps a single trust path. Codex agrees with (a) but corrects the draft's "no customer setup" claim: journal-table ACLs and the OAuth grant can need instance configuration. That correction is now in §3.3.

**OD6 — Status direction.**
- (a) Breeze → ServiceNow mapped push. Inbound changes become notes, and close/cancel may resolve (opt-in).
- (b) Full two-way state sync with last-writer-wins.

**Recommend (a).** Two-way sync ping-pongs, and the customer's state model is not the MSP's.

**OD7 — Duplicate risk on an unknown create outcome.**
- (a) Never re-POST. Look up by `correlation_id` for 2 h, then `needs_attention` (the #10499 rule).
- (b) Re-POST after a negative lookup.

**Recommend (a).** A duplicate incident in a customer's ITSM is worse than a short delay.

**OD8 — Comments whose push outcome is unknown.**
- (a) At most once: never re-send, and flag it in the feed.
- (b) At least once: re-send, and accept a possible duplicate.

**Recommend (a).** A duplicated customer-visible comment is a visible defect. A missing one is flagged and can be re-sent by hand. Codex agrees, but noted that the first draft's watermark-only ledger could not actually guarantee it. §3.2 now persists the attempt before the call.

**OD10 — A ticket or device move that meets a live sync lease.**
- (a) Wait up to 30 s for the lease to clear or lapse, then detach.
- (b) Refuse with 409 ("sync in progress, retry").
- (c) Detach immediately, and accept that the request already issued may land.

**Recommend (a).** Moves are rare and admin-driven, a lease lasts at most 30 s, and (b) breaks bulk device moves. Whichever option is chosen, the per-call fence means no new request starts after the detach. Raised by Codex's fencing finding; not yet reviewed by it.

**OD9 — Default for inbound comments.**
- (a) Internal note.
- (b) Public comment.

**Recommend (a).** A public comment re-emails the customer who wrote it.

## 7. Test and rollout notes

- **Red first** in every wave. Assert **remote side effects**, by counting the fake adapter's POSTs, PATCHes and journal appends, not only rows.
- **W1:**
  - CHECK and unique-index behaviour for the three kinds;
  - a principal's Partner API output is unchanged (connection and manual refs are invisible to it);
  - search by a manual ref's number;
  - portal shows only `portal_visible` refs;
  - ticket org move and device org move detach connection refs (with a hand-inserted connection ref), and the owner trigger rejects a forged cross-org link with the correct error;
  - ticket merge with two links to the same connection, and with identical manual refs on both tickets;
  - a cross-partner device move deletes principal refs and restamps manual refs (`org_id` + `partner_id`);
  - connection deletion when an equal manual ref already exists;
  - erasure with a connection ref (FK order);
  - export classification.
  - The cascade, export and merge suites run **only** under Integration Tests (not `pnpm test`). A stacked PR gets no CI: `gh workflow run CI --ref <branch>`. The full `orgMerge.test.ts` unit suite is also required.
- **LAB gate (before W2 merges):** a ServiceNow personal developer instance (owner creates it). Verify:
  - `correlation_id` search and its consistency;
  - incident and `sc_task` state values, and what resolving needs over the API (close code and notes);
  - whether the client-credentials grant is enabled;
  - least-privilege role ACLs for the table and `sys_journal_field`;
  - 429 behaviour;
  - the UI URL shape.
  - Record the results in the plan.
- **W2:**
  - `ticketSyncLinksRls.integration.test.ts` (forge 42501, org isolation, owner trigger);
  - fake-adapter state machine: timeout → lookup → adopt, a negative lookup → `needs_attention` with exactly one POST, a lease outliving a slow PATCH, a comment with an unknown outcome is not re-sent, an auth pause and resume;
  - the reconciler pushes with dispatch `off`;
  - the per-call fence: the ticket's org changes between claim and send, so no call is made; a move waits for a live lease (OD10);
  - a crash between the journal append and the watermark CAS, so the comment is not re-sent;
  - the reconciler pushes a status change whose event never ran (no `dirty` flag);
  - an org merge where both orgs have a default linkage connection;
  - `PsaAdapterError` scrubbing for ServiceNow;
  - settings resolver plus the `incidentTable` migration (concept count stays 1).
- **W3:**
  - inbound replay is a no-op (import-source index);
  - own-user entries are skipped;
  - no echo in either direction across two cycles;
  - `closeAction: resolve` runs the normal resolve path;
  - `work_notes` stay internal under `inbound.comments: 'public'`;
  - an integration comment does not satisfy first-response SLA, and a replayed one fires no notification;
  - repeated polls over an unchanged remote state add no notes;
  - cursor overlap;
  - the `'integration'` CHECK migration, plus a reader sweep test.
- **W4:** admission filters; the reconciler admits a ticket whose event was dropped.
- **Waves:**

  | Wave | Size | Depends on | Migration |
  |---|---|---|---|
  | W1 (ships alone: includes collision-safe detach and merge, and the cross-partner rule) | M | none | yes |
  | LAB (before W2-A's capability and config contract is final) | gate | owner | no |
  | W2-A adapter, auth modes, capability, config, card (no sends) | M | W1, LAB | yes |
  | W2-B ledger, durable attempts, committed-state reconciler, lifecycle fence, send, link, unlink, health source | L | W2-A | yes |
  | W3 integration actor and comment contract, inbound poll, loop guards | L | W2-B | yes |
  | W4a auto-send | S | W2-B | no |
  | W4b wake-up webhook | S | W3 | small |

- **Migrations** are named to sort after the newest on `origin/main` when the plan is written (today that is `2027-01-20-120000`; see `apps/api/migrations/README.md`). Every migration that writes rows elects system scope first. Run `pnpm db:check-drift` after each.
- **Rollout:** W1 needs no configuration. W2–W4 are off per connection (`ticket_linkage` NULL). The docs (`apps/docs/…/psa-integrations.mdx`) get a ServiceNow section: integration user, roles, OAuth setup, and the state map.

## 8. Advisor quorum

Independent review: `codex exec`, model `gpt-6-astra`, effort xhigh, read-only, against the first draft at `301a3a41c2`. Its verdict was "the direction is sound, but I would not approve the draft unchanged." The full output is in the session scratchpad (`codex-11019.md`). The load-bearing citations were re-checked in code: `moveDeviceOrgInTransaction.ts:1219-1224`, `ticketService.ts:147-160`, `credentials.ts:94`, `moveOrg.coverage.test.ts:805-815`.

**Agreed, and accepted into this revision:**
- Org merge collides with "one enabled connection per org". The fix is a default-for-new-sends flag that merge clears (§3.2, §4).
- A unique index on manual refs would break detach and merge. The fix is to dedupe in the service and collapse duplicates on read (§3.1).
- `ticket_sync_links` repoints explicitly in ticket merge, and the marker is immutable (§3.1, §3.2).
- A dirty-only reconciler does not repair dropped events. The fix is a committed-state divergence scan (§3.2).
- Claim-time checks do not fence remote writes. The fix is a re-check before each call, plus `generation` and a lease wait on detach (§3.2, OD10).
- Comments are at most once only if the attempt is persisted before the call (§3.2, OD8).
- `work_notes` are always internal (§3.3).
- W3 needs an integration `TicketActor`, insert-gated side effects, and requester-side SLA semantics (§3.3).
- Inbound polling uses bound `sys_id`s, the link-existing marker rule, and state dedupe (§3.2, §3.3).
- Cross-partner moves keep manual refs. Only principal refs are deleted (§3.1).
- Registration corrections: FK-topological erasure, schema-derived ticket-child completeness, and export buckets for `create_snapshot` and `pushed_subject_hash` (§4).
- ServiceNow: `correlation_id` is not an idempotency guarantee; journal ACLs are required, with no display-value fallback; client credentials are off by default and the credential validator needs auth-mode groups; resolve needs a resolution code and notes, so W2 supports `incident` only (§3.2, §3.3).
- Wave order: LAB before W2-A, durable attempts in W2-B, the actor contract in W3, and W4 split into W4a and W4b (§7).

**Agreed as drafted:** OD1–OD4, OD6, OD7, OD9. OD5 and OD8 are agreed with the corrections above.

**Disagreed, still open:** none. OD10 is new in this revision; Codex raised the problem but did not review the proposed fix.
