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
- Partial unique indexes: `(psa_connection_id, ticket_id) WHERE psa_connection_id IS NOT NULL` (one link per connection per ticket) and `(psa_connection_id, external_id) WHERE psa_connection_id IS NOT NULL` (one Breeze ticket per remote record). Manual refs: unique `(ticket_id, lower(label), external_id) WHERE partner_service_principal_id IS NULL AND psa_connection_id IS NULL`, with at most 10 per ticket, enforced in the service.
- **Owner invariant trigger** (`BEFORE INSERT OR UPDATE OF org_id, psa_connection_id`): when `psa_connection_id` is set, the connection must be org-owned by `NEW.org_id`. In W2 a partner-owned connection is rejected. The trigger **fails closed**: if a mover forgets the detach step below, the move aborts instead of leaving org B's ticket linked to org A's ServiceNow.

**Service** (`services/ticketExternalRefs.ts`): add `addManualRef`, `updateManualRef`, `removeManualRef` and `listRefsForTicket(ticketId, { audience: 'staff' | 'portal' })`. The ticket row lock comes first, and a merged tombstone is read-only, as the existing upsert does (`:63-84`). The existing principal-keyed functions keep filtering on the principal (`:152-161`). Partner API output therefore does not change: connection and manual refs never appear in a principal's `externalTicketId`.

**API.** `GET/POST/PATCH/DELETE /tickets/:id/external-refs` under `routes/tickets/`. Reads need ticket read access. Writes need `tickets:write` and run through `runAction` on the web. A connection ref cannot be edited or removed here; it changes only through W2's unlink action. `external_url` must be https: reuse `externalTicketUrlSchema` (`packages/shared/src/validators/tickets.ts:56`, which accepts http today; verified) with an https-only refinement for these routes. The portal ticket route (`routes/portal/tickets.ts`) adds `externalRefs: [{label, number, url}]`, filtered to `portal_visible`. The portal has its own `ticketReadAccess.ts`, so the plan adds the field there and not in the staff serializer.

**UI.**
- The ticket workbench (`components/tickets/TicketWorkbench.tsx`) gets a "References" chip row in the header: label, number, link, and a sync-state dot for connection refs.
- A drawer adds or edits manual refs: label (free text, suggested from the org's connections), number, optional URL, and a "Show in portal" checkbox, default on.
- The portal ticket page shows the chips.
- New locale keys go into all 8 locales.

**Move, merge and delete semantics (shared helper, used by both movers and merge).**
- *Ticket org move or device org move:* before restamping, `detachConnectionRefsForOrgMove(ticketIds, targetOrgId)` deletes the W2 sync rows (§3.2), sets `psa_connection_id = NULL` on refs whose connection the target org does not own, and writes a feed note: "ServiceNow sync stopped: the ticket moved to another organization." The remote record is not touched. Manual and principal refs follow the ticket as they do today.
- *Org merge:* the org's connections repoint with it (`psa_connections` is in `REPOINT_TABLES`, `services/orgMergeRegistry.ts:1223`), so links stay consistent and nothing detaches.
- *Ticket merge:* refs move to the survivor (existing repoint). If the survivor already has a link to the **same** connection, the loser's link is detached to a manual ref and its sync row is deleted. One remote record keeps one live Breeze ticket.
- *Ticket delete:* refs and sync rows cascade. The remote record is untouched.

**Legacy columns.** `tickets.external_ticket_id/url` stay dormant. The plan counts non-null rows in production. If there are any, a follow-up backfills them into manual refs labelled "External" and drops the columns. Not in W1.

### 3.2 W2 — org-owned ServiceNow connection, "Send to ServiceNow", outbound push

**Connection (reuses `psa_connections`, org arm).**
- *Auth.* Basic auth (exists) **and** OAuth 2.0 client credentials. The adapter exchanges the client id and secret at `/oauth_token.do` and caches the access token in memory per connection until shortly before expiry (inferred: the grant must be enabled on the instance; the lab checks it). Both kinds of secret live in the encrypted `credentials` column (`services/psa/credentials.ts:27-29`). The connection form recommends a dedicated integration user with web-service-only access and the least role that can write the target table.
- *Base URL.* Any https host. It is not pinned to `*.service-now.com`, because customers use custom and government domains. `validatePsaBaseUrl` and `psaFetch`'s SSRF guard and 20 s timeout already apply (`services/psa/http.ts`).
- *Errors.* `ServiceNowProvider.request` throws `PsaAdapterError` with the class rules in `types.ts:150-176`. The message never includes the body. That fixes the raw-body leak at `servicenow.ts:78-81`.

**New optional capability `PSATicketLinkage`** (`services/psa/types.ts`, next to `PSAAlertTicketing`):
- `createLinkedRecord`, `updateLinkedRecord` (state, priority, short description), `addJournalEntry(kind: 'comments' | 'work_notes')`, `getLinkedRecord`, `findByNumber`, `findByMarker(ticketId)`, `listChangedSince(cursor, sysIds)` and `listJournalSince(cursor, sysIds)` (W3), plus pickers for states, assignment groups and the integration user.
- Only `ServiceNowProvider` implements it. `supportsTicketLinkage(provider)` gates the card, the same way `supportsAlertTicketing` does (`types.ts:269-278`).
- *Marker:* the task-family `correlation_id = breeze-ticket:<ticketId>`, and `correlation_display = <Breeze ticket number>`. Both fields exist on `task` for this purpose (inferred; lab-verified).
- *Target table:* `incident` (default), `sc_task`, or any `task`-derived table the connection names. The state vocabulary is per table, so the state map is too.

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
  - A partial unique index keeps **one linkage-enabled connection per org**, so "Send to ServiceNow" never has to ask which one.

**Ledger: `ticket_sync_links`** (new; one row per connection-linked ticket). This is the #10499 W2 model: Postgres is the ledger, and events and BullMQ only wake it (verified pattern: `services/psaAlertTicketing/*`, `jobs/psaTicketingWorker.ts`, `jobs/psaTicketingReconciler.ts`).
- *Columns:* `id`, `org_id`, `ticket_id`, `psa_connection_id`, `config_rev`, `source` (`manual` | `linked_existing` | `auto`), `create_state` (`never_attempted` → `create_in_flight` → `created` | `create_outcome_unknown` | `rejected` | `needs_attention`), `push_state` (`idle` | `dirty` | `in_flight` | `failed`), `pushed_status`, `pushed_priority`, `pushed_subject_hash`, `comment_watermark_at` and `comment_watermark_id`, `inbound_cursor` (W3), `attempts`, `next_attempt_at`, `deadline_at`, `lease_token`, `lease_until`, `last_error`, `last_error_class`, `paused_reason`, `created_at`, `updated_at`.
- *Constraints:* unique `(psa_connection_id, ticket_id)`. The ref in `ticket_external_refs` is written **when the remote record is known**: on create success, on adopt, or on link-existing. Before that, a ref would need `external_id NULL`, which would weaken the column every existing reader relies on.

**Send to ServiceNow (manual).** A ticket action, shown when the org has an enabled linkage connection and the ticket has no live link.
- *Create* admits a ledger row (`ON CONFLICT DO NOTHING`), then wakes the worker. It needs `tickets:write` and runs through `runAction`.
- *Link existing:* the technician enters a number, the adapter looks it up (`findByNumber`), and Breeze links the record and starts pushing. If the remote record already has another ticket's marker, the request is refused.
- *Unlink* deletes the sync row and turns the ref manual. It needs `tickets:write` and is audited.

**Worker `ticket-sync`** (BullMQ, registered in `jobs/workerReadinessManifest.ts`). Jobs carry ids only.
- *Claim:* a CAS claim with a lease token in a short transaction. The remote call runs outside any transaction (#1105). The write-back is a CAS on the lease token. This is the same mechanics as `psaAlertTicketing/execution.ts`. The plan extracts the shared lease and backoff code instead of copying it.
- *Lifecycle check at every claim:* the connection is enabled and not paused, the ticket still exists, `ticket.org_id = connection.org_id`, and the ticket is not a merged tombstone. A mismatch detaches the link. It never pushes.
- *Create:* the worker writes `create_in_flight` with a snapshot, then POSTs: `short_description` = subject, `description` = the Breeze ticket description, number and a deep link; then the marker, caller, assignment group and `fieldDefaults`. On an **unknown outcome** it never re-POSTs. It retries `findByMarker` with backoff for up to 2 h, then moves to `needs_attention` with "Create anyway" and "Mark handled". This is the accepted #10499 rule.
- *Push (state-reconciling, not event-replaying):* the worker computes the desired remote state from the **committed** ticket: the mapped status, the mapped priority and the subject. It PATCHes only the fields that differ from `pushed_*`. Then it appends, in order, the Breeze comments after the watermark that pass the push filters and do **not** originate from this connection (`origin_principal_kind = 'integration' AND origin_principal_id = connection id`, §3.3). The watermark advances one comment at a time. A journal append whose outcome is unknown is not re-sent, and the feed shows "may not have reached ServiceNow". This avoids a duplicated customer-visible comment, at the cost of possibly losing one.
- *Wake-ups:* an event subscriber on `ticket.status_changed`, `ticket.commented`, `ticket.updated` and `ticket.assigned` (verified: `services/eventBus.ts:150-161`) marks the link `dirty` and enqueues work, registered in `EVENT_SUBSCRIBER_IDS` with its contract test. The **reconciler** (every 2 min) sweeps `dirty` and overdue rows, so a dropped event in the default `off` dispatch mode costs latency, not correctness. That mode silently drops subscriber errors (#10499 §1).
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
- *Records:* `GET /api/now/table/<table>?sysparm_query=correlation_idSTARTSWITHbreeze-ticket:^sys_updated_on>=<cursor>^ORDERBYsys_updated_on`, selecting `sys_id, number, state, sys_updated_on, correlation_id`, in pages (inferred query shape). The cursor is per connection and overlaps by 60 s. Dedupe makes the overlap safe.
- *Journal:* `sys_journal_field` filtered by `element_id IN (<changed sys_ids>)`, `element IN (comments, work_notes)` and `sys_created_on >= <cursor>` (inferred. The lab checks that a least-privilege role can read the table; if it cannot, the fallback is `sysparm_display_value` on the journal fields, which is coarser).
- *Loop guard:*
  - An entry created by the connection's own integration user (`sys_created_by`) is skipped.
  - An inbound comment is written with `origin_principal_kind = 'integration'`, `origin_principal_id = <connection id>` and `import_source_id = <journal sys_id>`. The existing partial unique index `ticket_comments_import_source_uq (origin_principal_id, import_source_id)` makes replays no-ops (verified: `migrations/2026-12-25-120100-migration-window-ticket-indexes.sql:21-22`). That index is the reason `origin_principal_id` carries the connection id.
  - The outbound push skips these comments.
  - The helpdesk loop guard already treats every kind other than `user` as suspect (verified: `db/schema/portal.ts:341-354`).
  - Adding `'integration'` to `ticket_comments_origin_principal_kind_chk` (current list `'user','ai_agent','system','service_principal','unknown'`, verified: `migrations/2026-12-04-101100-…:57-59`) is a migration. The plan sweeps every reader of that column.
- *State:* a remote close or cancel applies `closeAction`: `note` (default) adds an internal note. `resolve` resolves the Breeze ticket as the integration actor, through the normal ticket service, so SLA, billing and notifications behave exactly as for a manual resolve. Other remote state changes add an internal note only. **Breeze stays the system of record for MSP work state.** Two-way status mirroring ping-pongs, and the customer's state model is not the MSP's (OD6).
- *Notifications:* inbound comments default to `internal`, so a customer comment made in ServiceNow does not email the same customer back through Breeze's requester notifications. With `public`, the normal public-comment path runs.

### 3.4 W4 — auto-send rules

- **Admission** happens at `ticket.created`, plus a reconciler arm that admits tickets created after `autoSend.enabledAt` that match and have no link (the #10499 W2 repair-path pattern).
- **Filters:** category, intake form, minimum priority. The source (portal, email, alert, manual) is not a filter in W4.
- **Optional inbound webhook** (OD5 b): a per-connection HMAC endpoint that a customer's Business Rule or Flow can call to wake the poll early. It only **wakes** the poll and never carries data that Breeze trusts, so it adds no new trust path.

## 4. Tenancy and data-model impact

| Change | Wave | Shape | Registries (grep, don't judge) |
|---|---|---|---|
| `ticket_external_refs`: `partner_service_principal_id` → nullable; new `psa_connection_id` (FK `ON DELETE SET NULL`), `label`, `portal_visible`; CHECKs; partial unique indexes; owner-invariant trigger | W1 (columns, trigger) | Shape 1, unchanged. `partner_id` stays NOT NULL = the org's partner, and the composite `(org_id, partner_id)` FK is unchanged. The `(principal, partner)` composite FK is MATCH SIMPLE, so a NULL principal skips it (inferred; test it). | **Export:** `psa_connection_id`, `label`, `portal_visible` → `included` (`services/tenantExportPolicyRegistry.ts:1000`). Cascade, merge and both movers: already registered (`tenantCascade.ts:1072`, `orgMergeRegistry.ts:1325`, `ticketOrgMoveLockOrder.ts:94,197`, `routes/devices/core.ts:537`). **FK direction:** `psa_connections` sorts before `ticket_external_refs`. Because the new FK is `ON DELETE SET NULL`, erasure of the connection first only nulls the column. Confirm that `tenantCascade.integration.test.ts`'s FK-order property ignores SET NULL edges, or add the pre-clear next to the existing `psa_ticket_mappings` one (`tenantCascade.ts:1323-1373`). The plan must also re-check the `ticketMerge/repoint.ts` conflict handling against the new partial unique indexes. |
| `ticket_sync_links` (new) | W2 | Shape 1 on `org_id`. Composite `(ticket_id, org_id) → tickets(id, org_id)` `DEFERRABLE INITIALLY IMMEDIATE`. FK `psa_connection_id → psa_connections(id) ON DELETE CASCADE`. The same owner-invariant trigger as the ref. RLS enabled, forced, and `breeze_has_org_access(org_id)` in the creating migration. | `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical; it sorts after `tickets`, so check the FK order or add a pre-clear), `orgMergeRegistry` `repoint`, `CORE_TENANT_EXPORT_POLICY` (`last_error` → `excludedSensitive`, because it holds receiver text; `lease_token` → `reviewedIncluded`, because it matches `token`; the rest `included`). It is a ticket-linked table with a denormalized `org_id`, so it goes in `TICKET_ORG_DENORMALIZED_TABLES` **and** `CUSTOM_ORG_REWRITE_TABLES`, in the same relative order. That check is runtime-only, with no completeness test, so the plan adds a behavioural move test. Its composite FK name joins both movers' `SET CONSTRAINTS … DEFERRED` statements (`ticketService.ts:4143`). The detach helper deletes the rows before the restamp, so the rewrite normally touches none. Registration still has to happen for the merge and lock-order contracts. No `device_id`, so no device-move disposition. |
| `psa_connections.ticket_linkage jsonb`, `ticket_linkage_rev`, `ticket_linkage_enabled_at`, `ticket_linkage_paused_reason/_at`; partial unique "one enabled linkage per org" | W2 | Dual-axis XOR, unchanged | Export: `ticket_linkage` → `excludedOpen`; the rest `included`. The partner-wide SELECT branch on `psa_connections` lets org sessions read partner-owned rows. A linkage connection is org-owned, so only that org's sessions and its partner's sessions can read it. |
| `ticket_comments_origin_principal_kind_chk` gains `'integration'` | W3 | unchanged | none. Sweep the readers of `origin_principal_kind` (the helpdesk loop guard, the AI shadow gating, billing first-response logic). |

**Why the connection must be org-owned in W2.** A partner-owned connection would be visible to every org under the partner, through the partner-wide SELECT branch. Pushing to it would also need a company per org. The owner-invariant trigger makes "org A's ticket can only sync to org A's connection" a database fact and not only an app-layer check. This is the cross-tenant risk in this feature: a moved ticket that keeps syncing would send org B's work into org A's ServiceNow.

**Secrets.** Credentials stay in `psa_connections.credentials`, encrypted (`encryptSecret`). An OAuth access token is cached only in memory. `last_error` holds a scrubbed snippet, never a body that could echo credentials.

## 5. Out of scope

- A partner-owned ServiceNow connection (an MSP using ServiceNow as its PSA). That is #10499's company-mapped shape (OD2).
- Other ITSMs (Jira Service Management, Freshservice, Zendesk). The capability interface allows them later, and each needs its own lab run.
- Attachments, in either direction.
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

**Recommend (a).** A poll needs nothing set up on the customer's instance. A webhook that only wakes the poll keeps a single trust path.

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

**Recommend (a).** A duplicated customer-visible comment is a visible defect. A missing one is flagged and can be re-sent by hand.

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
  - ticket merge with two links to the same connection;
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
  - the lifecycle check detaches when the ticket's org changes between claim and send;
  - `PsaAdapterError` scrubbing for ServiceNow;
  - settings resolver plus the `incidentTable` migration (concept count stays 1).
- **W3:**
  - inbound replay is a no-op (import-source index);
  - own-user entries are skipped;
  - no echo in either direction across two cycles;
  - `closeAction: resolve` runs the normal resolve path;
  - cursor overlap;
  - the `'integration'` CHECK migration, plus a reader sweep test.
- **W4:** admission filters; the reconciler admits a ticket whose event was dropped.
- **Waves:**

  | Wave | Size | Depends on | Migration |
  |---|---|---|---|
  | W1 | M | none | yes |
  | LAB | gate | owner | no |
  | W2-A adapter, capability, config, card (no sends) | M | W1 | yes |
  | W2-B ledger, worker, reconciler, send, link, unlink, health source | L | W2-A, LAB | yes |
  | W3 inbound poll and loop guards | L | W2-B | yes |
  | W4 auto-send and wake webhook | M | W3 | small |

- **Migrations** are named to sort after the newest on `origin/main` when the plan is written (today that is `2027-01-20-120000`; see `apps/api/migrations/README.md`). Every migration that writes rows elects system scope first. Run `pnpm db:check-drift` after each.
- **Rollout:** W1 needs no configuration. W2–W4 are off per connection (`ticket_linkage` NULL). The docs (`apps/docs/…/psa-integrations.mdx`) get a ServiceNow section: integration user, roles, OAuth setup, and the state map.

## 8. Advisor quorum

_Pending: filled in after the independent review below._
