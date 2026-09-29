---
title: Partner API Tickets Surface
status: approved
date: 2026-09-27
revised: 2026-09-29
owner: Lennon Fiuza
area: api-platform
tracking_issue: LanternOps/breeze#7181
related:
  - docs/superpowers/specs/api-platform/2026-09-07-partner-api-execute-scope-design.md
  - docs/superpowers/plans/integrations/2026-07-13-breeze-partner-integration-api.md
  - docs/superpowers/plans/2026-08-08-partner-api-provisioning-writes.md
  - docs/superpowers/specs/installer-enrollment/2026-08-02-enrollment-idempotency-design.md
  - docs/superpowers/plans/ai-mcp/2026-08-28-ai-agents-wave6-3-ticket-shadow.md
  - docs/superpowers/specs/security-auth/2026-07-11-security-review-wave-08-ticket-financial-audit-design.md
---

# Partner API Tickets Surface

> Revision 2 (2026-09-28) addresses the #7246 review: §3 (typed actor union, attribution to the
> principal), §4 (claim bound to the ticket, org moves, own retention sweep, no 503 branch), §5
> (removals on the feed, feed-only invalidation via a `ticket_comments` trigger, comment edits and
> deletes), §6 (external ids namespaced by principal, two write ceilings), §2 corrections, and the §8
> answers folded in.
>
> Revision 3 (2026-09-29) — design approved in #7246; this revision applies the corrections from that
> approval: the mover placement and the third lock-order list (§2 F9, §4.2, §6), the restamp
> trigger's rationale and security mode (§5.2), the `ticket_external_refs` foreign keys (§6), the
> audit-log rendering of principal rows and the `ai_agent` origin principal (§3.2), a risks section
> (§9), and three refinements found while reworking the reference branches (the `portal_user` actor
> kind in §3.2, no external id on webhook payloads in §5.6, cross-partner device moves in §4.2/§6).

## 1. Summary

MSPs run Breeze next to a PSA/ITSM and automation platforms, and need those systems to open, read
and work Breeze tickets unattended. Today no ticket route accepts an API key (#7181). This design
adds a **tickets surface to the existing Partner API** (`partner_service_principals` +
`X-API-Key: brz_sp_…`) under two opt-in scopes, `tickets:read` and `tickets:write` — not to the
org-scoped `brz_…` keys, for the same reasons the execute-scope design gave: one credential,
partner-wide org discovery, partner RLS scope, source-CIDR pinning, principal expiry, per-principal
rate limits, per-request audit.

This document settles the three things #7181 asked to see before code: **(§3)** what actor a
service principal writes as, **(§4)** the idempotency store's tenancy shape and registrations, and
**(§5)** the change-feed/cursor contract and how it relates to the webhook outbox. §6 lists the
resulting surface, §7 the waves, §9 the risks. A reference implementation exists as four stacked
branches on a fork, reworked to this revision; each wave becomes its own PR.

## 2. Repo facts this design is built on (verified 2026-09-26, re-checked 2026-09-29 against `main` ae0375436)

| # | Fact | Evidence |
|---|---|---|
| F1 | Staff ticket routes mount `authMiddleware` only (JWT); `actorFrom(c)` builds the ticket actor from `auth.user`. Org `brz_` keys reach tickets only through the MCP `manage_tickets` tool, credited to the key's creator (`auth.user.id = createdBy`). Neither scope list has a ticket scope. | `routes/tickets/index.ts`; `routes/tickets/tickets.ts:90`; `routes/mcpServer.ts` `buildAuthFromApiKey`; `services/apiKeyScopes.ts`; `services/partnerServicePrincipalScopes.ts` |
| F2 | Partner API non-GET handlers get **no ambient DB context** and open their own bounded `withDbAccessContext` (`scope:'partner'`, `accessibleOrgIds`, `userId:null`); GET runs inside the middleware's held partner snapshot. Non-GET routes must be allowlisted in `writeSurface.test.ts`. Write budget is `min(key.rateLimit, 120)`/h per principal+key. | `middleware/partnerApiAuth.ts:302-353,402`; `routes/partnerApi/contracts.ts:46`; `routes/partnerApi/writeSurface.test.ts` |
| F3 | `TicketActor` is `{ userId: string; name?; email?; principalKind?: 'user'\|'ai_agent'\|'system' }`; `moveTicketOrg` and `revalidateTicketAssignee` accept an ad-hoc `TicketActor \| { kind:'ai_agent'; agentId }` union on top. `actor.userId` is read in ~50 places in `ticketService.ts` alone: users(id)-FK columns, audit `actorId`, event `actorUserId` (which drives the assignee self-skip in `ticketNotifyWorker.ts:265`), comment authorship (`assertCommentEditable`), attachment ownership (the claim predicate), draft consumption. `actorUserFk` nulls FK columns only for `'system'` (the all-zero `SYSTEM_ACTOR` sentinel). | `services/ticketService.ts:83-120,416,3174`; `services/inboundEmail/inboundEmailService.ts:43`; `jobs/ticketNotifyWorker.ts:265` |
| F4 | `ticket_comments.origin_principal_kind` CHECK admits `('user','ai_agent','system','unknown')`; `breeze_user_isolation_insert` admits `user_id IS NULL` only under scope `system`; **four** supplemental INSERT policies exist (portal, email, ai_agent, and the caller-verification system note), each gated on `breeze_has_org_access(t.org_id)` of the parent ticket. The helpdesk loop guard treats any `origin_principal_kind <> 'user'` as agent activity. `action_intents` already carries an `origin_principal_id` beside its `_kind`. | migrations `2026-09-19-ai-agents-ticket-shadow.sql:132`, `2026-06-13-b-fk-child-rls-backstop.sql:232`, `2026-09-25-b-…-ai-note-rls.sql`, `2026-10-26-170300-caller-verification-ticket-comment-rls.sql`; `services/ticketHelpdeskSubscriber.ts:129-150`; `db/schema/actionIntents.ts:322` |
| F5 | `tickets.external_ticket_id` / `external_ticket_url` exist, are in the export policy and are returned by the staff detail route, but nothing writes them and nothing indexes them. `tickets.partner_id` is nullable. `tickets.updated_at` is user-visible: the Office add-in sorts by it and legacy closed tickets use it as their resolution time. `psa_ticket_mappings` qualifies an external ticket id by `connection_id`. | `db/schema/portal.ts:159,164`; `routes/tickets/tickets.ts:545`; `services/ticketService.ts:453`; `apps/web/src/components/tickets/SlaTimers.tsx:74`; `db/schema/integrations.ts:154` |
| F6 | The alerts feed is the house pattern for a machine change feed: `alerts.partner_feed_xid xid8` stamped by a `BEFORE INSERT OR UPDATE` trigger with `pg_current_xact_id()`, traversal bounded by `pg_snapshot_xmin(pg_current_snapshot())`, signed page/checkpoint tokens bound to partner + filters + org set + database epoch, `409 …_resync_required`. Deliberately outside the per-org advisory-lock protocol (hot table, #6671). Alerts are never deleted, so that feed has no removal representation. | migrations `2026-10-30-130000/130100-partner-api-alerts-*.sql`; `routes/partnerApi/alerts.ts:47`; `routes/partnerApi/alertsFeedToken.ts` |
| F7 | `ticket_outbox` is written in the mutation transaction and drained to the event bus by `ticketOutboxPublisher`; only `ticket.created`, `ticket.commented`, `ticket.status_changed` are published (`updated`/`assigned`/`restored` are drained unpublished). Payloads are id-only. Webhooks are per org; `webhooks.events` is a free-form string array. Comments are written by five paths besides `addTicketComment`: portal, inbound email, AI notes, edit and delete. | `db/schema/ticketOutbox.ts`; `jobs/ticketOutboxPublisher.ts:57`; `routes/portal/tickets.ts:470`; `services/inboundEmail/emailComments.ts:30`; `services/ticketService.ts:2692,2731` |
| F8 | Idempotency precedent: `X-Idempotency-Key` (1–128 printable ASCII), claim table `partner_enrollment_key_idempotency` — **shape 1** (`org_id NOT NULL`, policies `breeze_has_org_access(org_id)`), `enrollment_key_id` FK, unique `(principal, key)`, sha256 fingerprint, claim-then-link in one transaction, 409 on mismatch/race, reaped inside `enrollmentKeyCleanup` (which has its own enable flag). Registered in `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry` (repoint) and `CORE_TENANT_EXPORT_POLICY`. | `routes/partnerApi/provisioning.ts:545-826`; migration `2026-10-08-101600-enrollment-keys-scope.sql:55-117`; `jobs/enrollmentKeyCleanup.ts:97`; `services/tenantCascade.ts:664`; `services/orgMergeRegistry.ts:935`; `services/tenantExportPolicyRegistry.ts:497` |
| F9 | Tables with `ticket_id` and a denormalized `org_id` are rewritten by two movers and re-pointed by org merge, and **three** lists must agree on their relative order: `TICKET_CHILD_ORG_REWRITE_LOCK_ORDER` (the canonical order, which also reorders the org-merge walk), `TICKET_ORG_DENORMALIZED_TABLES` (the ticket mover) — both in `services/ticketOrgMoveLockOrder.ts` — and `CUSTOM_ORG_REWRITE_TABLES` (`routes/devices/core.ts`, the device mover, whose statements live in `services/deviceOrgMove/moveDeviceOrgInTransaction.ts`). The last entry in all three is `ticket_checklist_items` (#5783). `ticketOrgMoveLockOrder.test.ts` checks that the lists agree **with each other**, not that they are complete, so a missed entry does not turn CI red. The ticket mover refuses a cross-partner move; the device mover allows one under system scope and realigns `tickets.partner_id`. | `services/ticketOrgMoveLockOrder.ts:61,80,143`; `routes/devices/core.ts:440`; `services/deviceOrgMove/moveDeviceOrgInTransaction.ts`; `services/ticketService.ts` `moveTicketOrg` |
| F10 | `field_provenance` is read as human authority (`=== 'user'` / `<> 'user'`) in four places: the two CAS conjuncts and the SLA restamp in `ticketService.ts` (`applyAiFieldUpdates`, `computeSlaRestamp`), and `filterEligibleFields` in `services/aiAgents/ticketTriageFindings.ts:180`. | as cited |
| F11 | Keys rotate under a principal (`partner_service_principal_keys.rotated_from_id`); the credential-level audit row `partner_api.request` is keyed by `keyId`. | `db/schema/partnerServicePrincipals.ts:84-100`; `middleware/partnerApiAuth.ts:226` |

## 3. Actor and attribution (#7181, point 1)

### 3.1 Rule

Two kinds of API credential, two rules — consistent with how MCP already behaves:

- A **human-owned org `brz_` key** (including MCP `manage_tickets`) is *delegation*. Everything it
  does is credited to the user who owns the key; only the internal audit row (`mcp.*`,
  `actor_type='api_key'`) distinguishes it. **Unchanged by this design.**
- A **partner service principal** (`brz_sp_`) has no human owner and **acts as itself**, identified
  by the **principal id** (stable across key rotations, F11). The key id is credential detail, not
  identity.

### 3.2 `TicketActor` becomes a discriminated union

The key-id-in-`userId` approach of revision 1 is withdrawn: a sentinel "works" at each of the ~50
readers of `actor.userId` (F3) only by accident, and `SYSTEM_ACTOR` is a single all-zero value, not a
precedent for a second machine kind. Instead, wave 1 replaces the struct with a union so the
compiler finds every consumer, and folds the existing `principalKind` field and the ad-hoc
`{ kind:'ai_agent'; agentId }` union (F3) into it:

```ts
export type TicketActor =
  | { kind: 'user';              userId: string; name?: string; email?: string; triageFeedbackSource?; triageFeedbackMetadata? }
  | { kind: 'ai_agent';          agentId: string; runId?: string; name?: string }
  | { kind: 'portal_user';       portalUserId: string; name?: string; email?: string }
  | { kind: 'system';            source: 'inbound_email' | 'caller_verification' | 'planned_work' | 'ai_operator' | 'scheduler'; name?: string }
  | { kind: 'service_principal'; principalId: string; keyId: string; name: string };
```

No member of the union carries a `userId` except `'user'`, so every site that today reads
`actor.userId` fails to compile until it says what it means through one of these accessors (all in
`ticketService.ts`, each a pure function with a table test per kind):

| Accessor | `user` | `ai_agent` | `system` | `service_principal` | Consumers it replaces |
|---|---|---|---|---|---|
| `actorUserFk(a)` → `string \| null` | `userId` | `null` | `null` | `null` | `ticket_comments.user_id`, `tickets.closed_by`, `deleted_by`, `ml_feedback_events.actor_user_id`, `ticket_alert_links.created_by`, draft `consumed_by` |
| `actorAuditIdentity(a)` → `{ actorId, actorType, initiatedBy, details }` | `{userId,'user','manual'}` | `{agentId,'ai_agent','ai'}` | `{ANONYMOUS,'system','automation',{source}}` | `{principalId,'api_key','integration',{partnerServicePrincipalId, keyId}}` | every `createAuditLogAsync` / direct `auditLogs` insert (F3) |
| `actorEventIdentity(a)` → `{ actorUserId, actorPrincipalId }` | `{userId, null}` | `{null, null}` | `{null, null}` | `{null, principalId}` | `emitTicketEvent(...)`; the notify worker's self-skip compares `assigneeId === actorUserId` and is correct with `null` |
| `actorAuthorFields(a)` → `{ userId, authorName, authorType, originPrincipalKind, originPrincipalId }` | `{userId, name, 'internal', 'user', null}` | `{null, name, 'ai_agent', 'ai_agent', agentId}` | `{null, name, 'internal', 'user' or 'system' per today's rules, null}` | `{null, name, 'internal', 'service_principal', principalId}` | every feed/comment insert |
| `actorOwnsComment(a, row)` | `row.userId === userId` | `false` | `false` | `row.originPrincipalId === principalId` | `assertCommentEditable` (F3) — exact even if edit/delete are ever exposed |
| `humanUserId(a, what)` → `string` | `userId` | 403 | 403 | 403 `HUMAN_SESSION_REQUIRED` | soft delete/restore, AI draft consumption, proposal notes, and the attachment claim predicate (ownership is `uploaded_by_user_id`, so only a human can own an upload in v1) |

`portal_user` was added to the union while reworking wave 1: the portal routes were passing the
portal user's id through `userId`, which is exactly the sentinel pattern this section removes. It
behaves like `system` in every accessor (no users FK, no ownership) except that its audit identity is
the portal user id and its rows keep `authorType: 'portal'`.

For `ai_agent` the origin principal is the **agent id** (`aiAgents.id`), not the run id. That is the
convention `action_intents.origin_principal_id` already follows (F4), and the run is already recorded
beside it in `ticket_comments.agent_run_id`; the principal column names *who*, the run column names
*which execution*. `addAiTriageNote` stamps it the same way.

`authorType` stays `'internal'` for a service principal (the portal and the comment edit-window branch
on `!== 'portal'`); `origin_principal_kind = 'service_principal'` plus the new
**`ticket_comments.origin_principal_id uuid`** (precedent: `action_intents.origin_principal_id`, F4)
name the author. A mirror suppresses its own echo by comparing `originPrincipalId` to its principal
id — exact even with several integrations on one partner. The value is `'service_principal'`, not
`'api_key'`, on purpose: the human `brz_` key path keeps `'user'`, so the vocabulary names *who
acted*, not the credential type. `audit_logs.actor_type` keeps its existing `'api_key'` value with
`actor_id = principalId` and `details.keyId`; the middleware's `partner_api.request` row stays keyed
by `keyId` because that row is about the credential.

The audit log renders `actor_type = 'api_key'` rows as "API Key <id slice>"
(`routes/auditLogs.ts` `resolveActorName`), which would show a principal id under a label that
implies a key id, next to rows that really are keyed by a key id. Wave 1 therefore renders any
`api_key` row whose details name a principal (`partnerServicePrincipalName` /
`partnerServicePrincipalId`, which every domain row written through `actorAuditDetails` carries) as
"Service principal <name>". `partner_api.request` rows do not name a principal in their details and
keep the "API Key" label — correct, since their actor id is the key id.

Migration (wave 1): widen the `ticket_comments` CHECK with `'service_principal'`, add
`origin_principal_id`, and add a **fifth** supplemental INSERT policy
`breeze_ticket_parent_service_principal_insert` (`user_id IS NULL AND portal_user_id IS NULL AND
origin_principal_kind = 'service_principal' AND origin_principal_id IS NOT NULL AND parent ticket
org-accessible`) — the same shape as the four in F4, needed because Partner API writes run
partner-scoped, never system.

### 3.3 What the kind changes elsewhere

- **`field_provenance`** is stamped `'service_principal'` and is **human-authoritative**: an external
  system of record is not overwritten by AI. One shared constant
  (`HUMAN_AUTHORITATIVE_PROVENANCE = ['user','service_principal']`, with a SQL fragment) replaces
  every `=== 'user'` / `<> 'user'` guard — both CAS conjuncts and the SLA restamp in `ticketService`
  and `filterEligibleFields` in `ticketTriageFindings.ts:180` (F10); a unit test asserts no bare
  `'user'` provenance comparison remains.
- **Helpdesk AI loop guard**: a service-principal comment counts as agent activity (F4): it never
  triggers an automatic helpdesk reply and suppresses a pending one. Intended, fail-closed — an
  external system must not be able to drive AI spend.
- **Surface-level audit**: the middleware's `partner_api.request` row plus the service's domain row;
  no third per-route audit.

### 3.4 Human-only transitions

Closed to every machine actor (`requireHumanActor` at the service, and no route on the surface):
soft delete / restore, move-org, bulk actions, attachments (no upload in v1 — `uploaded_by_user_id`
is the ownership column — and no read either), time entries and parts (wave-08 financial audit
contract), applying an AI draft, the mailbox, comment edit/delete, `/requesters`, `/stats`,
triage-suggestion apply/reject. Assigning is allowed (`assertAssigneeEligible` enforces
same-partner + `tickets:read` + org access for the assignee).

### 3.5 Alternatives rejected

- *Credit the human who minted the principal.* A principal outlives its minter and is rotated
  independently; the audit trail would name someone who did nothing.
- *Key id as identity.* One integration would appear as several actors across a rotation (F11).
- *A synthetic `users` row per principal.* Pollutes assignee pickers, notifications and RBAC.
- *Widening org `brz_` keys with `tickets:*` scopes instead.* One org per key, tied to the creator's
  lifecycle, no source CIDRs, no per-request audit. Kept as a v1.1 follow-up.

## 4. Idempotency store (#7181, point 2)

### 4.1 Table

`partner_api_idempotency_keys` — the enrollment-key claim table (F8) generalised with a `route`
discriminator and **bound to the ticket it guards**:

```
id uuid PK
partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE
partner_service_principal_id uuid NOT NULL
org_id uuid NOT NULL                              -- denormalized from the ticket; follows org moves
ticket_id uuid REFERENCES tickets(id) ON DELETE CASCADE   -- the ticket the claim guards (see 4.3)
route varchar(64) NOT NULL                        -- 'tickets.create' | 'tickets.comment'
idempotency_key varchar(128) NOT NULL
request_fingerprint varchar(64) NOT NULL          -- sha256(canonical JSON {route, ticketId, body})
resource_id uuid                                  -- the created ticket or comment id; no FK (route decides the table)
created_at timestamptz NOT NULL DEFAULT now()
UNIQUE (partner_service_principal_id, route, idempotency_key)
FK (partner_service_principal_id, partner_id) → partner_service_principals(id, partner_id) ON DELETE CASCADE
FK (org_id, partner_id) → organizations(id, partner_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
indexes: partner_id, org_id, ticket_id, created_at
```

### 4.2 Tenancy shape and registrations

**Shape 1 (`org_id`)**, deliberately not partner-axis: a claim protects a resource that lives in one
organization, so it follows that organization through erasure and merge. Because the row has a
`ticket_id` **and** a denormalized `org_id`, it is exactly the ticket-linked child case in the
CLAUDE.md cascade table, and it is registered on **both** movers and the org-merge walk so a claim
follows its ticket across an org move instead of being erased with the old org while still guarding a
live ticket:

| Contract | Entry |
|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`) | `partner_api_idempotency_keys`, alphabetical; FK child of `tickets` (ON DELETE CASCADE) |
| `TICKET_CHILD_ORG_REWRITE_LOCK_ORDER` **and** `TICKET_ORG_DENORMALIZED_TABLES` (`services/ticketOrgMoveLockOrder.ts`) **and** `CUSTOM_ORG_REWRITE_TABLES` (`routes/devices/core.ts`) | appended **last in all three lists**, after `ticket_checklist_items` and after `ticket_external_refs` (F9), with the matching hand-written statement in `moveDeviceOrgInTransaction.ts`; no composite `(ticket_id, org_id)` FK, so no `SET CONSTRAINTS` entry is needed |
| Cross-partner device move (system scope, F9) | the composite `(org_id, partner_id)` FK pins the row to the principal's partner, so the device mover **deletes** claims and refs whose partner differs from the target organization's before re-stamping the rest; the principal can never read that ticket again |
| `orgMergeRegistry.ts` | `repoint` |
| `CORE_TENANT_EXPORT_POLICY` | all columns `included`, `request_fingerprint` as `reviewedIncluded` |
| `rls-coverage` | auto-discovered (shape 1); RLS enabled + forced with the four `breeze_has_org_access(org_id)` policies |
| `ticketOrgMoveLockOrder.test.ts` | asserts the three lists agree with each other (not completeness, F9); completeness is proven by an integration suite per table that runs both movers against real Postgres |
| Device-side lists | not applicable (no `device_id`) |

### 4.3 Protocol

Same shape as provisioning, with the ticket in the claim:

1. Validate the header before any I/O (1–128 printable ASCII → else `400`).
2. Authorize first: `POST /tickets` checks `orgId ∈ accessibleOrgIds` (`403`); the comment route
   resolves the ticket through the partner-bound lookup (`404` for unknown, foreign or deleted) —
   **before** any claim state is read, so a key cannot probe existence.
3. Fingerprint = `sha256(canonical JSON { route, ticketId, body })` — `ticketId` is the path id for
   `tickets.comment` and `null` for `tickets.create`; the body is JSON round-tripped first (zod
   coerces `dueDate` to a `Date`). Reusing a key with the same body on a **different ticket** is
   therefore a fingerprint mismatch → `409 partner_tickets_idempotency_key_reused`, never a silent
   replay of the first ticket's comment.
4. Look up `(principal, route, key)` inside the handler's partner context: matching fingerprint →
   replay (`200`, `idempotencyReplay: true`, resource re-read through the same partner-bound lookup,
   and for comments additionally checked to belong to the path ticket); different fingerprint →
   `409 …_key_reused`.
5. Otherwise claim with `ON CONFLICT DO NOTHING` (null → `409 …_in_flight`), setting `ticket_id` and
   `org_id` from the path ticket (comment) — then create through `ticketService` — then link
   `resource_id` (and, for create, `ticket_id` = the new ticket) — all inside the handler's
   `withDbAccessContext`, so claim, resource and link commit or roll back together.

There is **no `503 …_state_invalid` branch**: a claim whose `resource_id` is null cannot be observed
by a later request, because the claim is only visible once the transaction that also linked it has
committed. Finding one is an invariant violation and is answered as a `500`.

### 4.4 Retention

Its own job, `jobs/partnerApiIdempotencyRetention.ts` (daily, `scheduleRegistry` key,
`PARTNER_API_IDEMPOTENCY_RETENTION_DAYS` default 7, `PARTNER_API_IDEMPOTENCY_RETENTION_ENABLED`),
scanning `created_at`. Not folded into `enrollmentKeyCleanup`, whose enable flag is independent (F8).
A claim only has to outlive the window in which a client may retry; after it is reaped, a retry with
the old key is a fresh request, which is the documented contract.

### 4.5 Alternatives rejected

- *Reuse `partner_enrollment_key_idempotency`.* Its `enrollment_key_id` is an FK to
  `enrollment_keys`. Folding provisioning into the generic table is an additive follow-up.
- *Partner-axis table.* A claim would survive the erasure of the org it names.
- *No `ticket_id`, fingerprint only.* Closes the wrong-ticket replay but not the org-move erasure
  case; the column is what lets both movers keep the row with its ticket.
- *Redis-only claims.* Loses "claim + resource commit together".

## 5. Change feed, cursors, and the webhook outbox (#7181, point 3)

### 5.1 Feed

`GET /partner-api/tickets` is a **coalesced latest-state change feed**, mechanically identical to
the alerts feed (F6): `tickets.partner_feed_xid xid8` stamped by a `BEFORE INSERT OR UPDATE`
trigger, a `(partner_feed_xid, id)` index built `CONCURRENTLY`, traversal over the fixed window
`[lower, horizon)` where `horizon = pg_snapshot_xmin(pg_current_snapshot())` at the first page. A
transaction that commits after a later-started one is never skipped behind a checkpoint the poller
already holds; a row rewritten mid-traversal moves above `horizon` and arrives next time; several
changes between polls coalesce into the current row. Delivery is **at-least-once across resyncs**
(a full resync re-delivers everything), and a consumer must treat records as upserts keyed by `id`.
The trigger is **not** part of the per-org advisory-lock protocol (ticket writes are hot), and it
is registered as merge-benign (it only stamps; a repoint restamps and correctly re-delivers).

### 5.2 Invalidation is feed-only, and covers every comment path

`tickets.updated_at` keeps its meaning (F5); the revision-1 bump in `addTicketComment` is withdrawn.
Instead a second trigger, on `ticket_comments` — `AFTER INSERT OR UPDATE OF content, is_public,
deleted_at, edited_at` — restamps the parent: `UPDATE tickets SET partner_feed_xid =
pg_current_xact_id() WHERE id = NEW.ticket_id`. It touches no other column, so no `updated_at` consumer sees it. Comment-only activity
therefore re-delivers the ticket with a new `changeVersion`; `GET /tickets/:id/comments` is how the
consumer reads what changed.

The function is **`SECURITY INVOKER`** (revision 2 said `SECURITY DEFINER`, with the wrong reason).
A definer function does not get past forced RLS: it runs as the table owner, and `FORCE ROW LEVEL
SECURITY` binds the owner too — unless that owner happens to be a superuser, which would make the
restamp's reach depend on how a deployment provisioned its roles. The restamp needs no elevation in
the first place: the `tickets` UPDATE policy is `breeze_has_org_access(org_id)`, and that is the
same check every `ticket_comments` INSERT policy (the base one and the five supplemental ones, F4 and
§3.2) already runs against the parent ticket, as does `breeze_ticket_parent_update`. Whatever context
may write the comment may therefore update its parent. One policy is weaker —
`breeze_user_isolation_update` admits an author editing their own comment without a parent check —
but the service reads the ticket in the same context before any edit or delete, so that path is a
`404` before it is a write. Wave 2 proves the equivalence instead of assuming it: an integration
suite writes a comment **as `breeze_app`** through each writer's context (staff, portal, inbound
email, AI note, system note, service principal, edit, soft delete) and asserts the parent was
restamped and `updated_at` was not.

### 5.3 Removals are representable

The feed's row selection is `partner_id = principal AND org_id IN accessibleOrgIds`, over live and
soft-deleted rows. Each delivered item is one of two shapes, discriminated by `removed`:

| Situation | What the consumer sees |
|---|---|
| Ticket soft-deleted (`deleted_at` set; the row is restamped by the tickets trigger) | a **tombstone** `{ id, orgId, removed: true, reason: 'deleted', deletedAt, changeVersion }` — no other field |
| Ticket restored | a normal record again, with a higher `changeVersion` |
| Ticket moved **into** the org set, or between two orgs in the set | a normal record with the new `orgId` (the move restamps) |
| Ticket moved **out** of the org set | *not* representable on the feed: the row now has an `org_id` the principal cannot read, and emitting a tombstone for it would disclose ids of tickets the consumer may never have seen. Handled by reconciliation (below). |
| Org leaves / joins the principal's accessible set | `409 partner_tickets_resync_required` (org-set hash), as for alerts |

Reconciliation: `GET /partner-api/tickets/ids` (`tickets:read`) returns the **live** ticket ids in
the accessible set with their `changeVersion`, keyset-paged by `id`, audited as an export resource.
A mirror runs it on a schedule (daily is enough) and drops anything it holds that is absent; that is
the only way a move out of the set is observed, and it also self-heals any consumer-side loss.
`GET /tickets/:id` answers `404` for a moved-out ticket, as for a deleted one.

### 5.4 Comments: edits and deletes are in scope

`GET /tickets/:id/comments` lists the ticket's comments in creation order, keyset-paged on
`(created_at::text, id)` (microsecond-exact — an ISO cursor repeats the boundary row), bound to the
partner and a hash of `{ticketId, since}`. Because `created_at` never changes, the keyset stays valid
across edits and deletes, and the list represents both:

- an edited comment carries `editedAt` and a `revision` that changes with `content`;
- a deleted comment is returned as a **tombstone** `{ id, ticketId, orgId, removed: true, deletedAt }`
  with no content;

so a consumer that re-reads the (bounded) list whenever the parent ticket is re-delivered (§5.2
restamps on edit and delete too) converges exactly.

### 5.5 Tokens

The alerts token module becomes a factory, `createPartnerFeedTokens(spec)`, with **one HMAC domain
per feed** (`breeze-partner-tickets-feed-v1`); `alertsFeedToken.ts` becomes a thin binding with
identical behaviour. Three kinds: `page` (one traversal: `[lower, horizon)` + last `(xid, id)`,
24 h), `checkpoint` (last page; next traversal's inclusive lower bound; bound to partner, exact
filter set — `orgId`, `status`, `priority`, `assigneeId`, `externalId` — org-set hash and database
epoch; different filters → `400`, different org set or epoch → `409 …_resync_required`), and
`keyset` (the comments list and the reconciliation list).

### 5.6 Relation to the outbox and webhooks

The outbox tells an integration **that** something changed; the feed is how it reads **what**
changed. Complementary, not redundant:

| | `ticket_outbox` → event bus → webhooks | Partner API feed |
|---|---|---|
| Trigger | push, per mutation, delivered by `webhookDelivery` with HMAC signing | pull, per poll |
| Scope | per organization webhook | per partner principal, across its org set |
| Payload | ids and enum labels only, never text | full DTO through the export secret scanner |
| Consistency | at-least-once, unordered | coalesced latest-state, ordered by xid; at-least-once across resyncs |

The outbox side is extended minimally: `ticket.updated` and `ticket.assigned` are bridged onto the
bus (F7); payloads stay id-only but say more — `ticket.created` gains `internalNumber`, `source`,
`assigneeId` (no external id: that key is per principal, §6, and an org webhook has no single
principal to answer for); `ticket.updated` carries the changed field **names**; `ticket.status_changed` gains
`statusId`; every `ticket.commented` writer carries `originPrincipalKind` **and
`originPrincipalId`**, so a mirror suppresses exactly its own echo. Partner-wide webhook
subscriptions (`webhooks.org_id XOR partner_id`) are a follow-up.

### 5.7 Alternative rejected

An `updated_at` watermark: reintroduces the commit-order gap the alerts feed was built to close, and
would need either an overlap window (duplicates) or the advisory-lock protocol (ruled out for hot
tables).

## 6. Surface

| Route | Scope | Notes |
|---|---|---|
| `GET /partner-api/tickets` | `tickets:read` | feed (§5); audited export resource (`partner_api.export`, `recordCount`); `tickets` is `customer-authored` for the structural secret layer |
| `GET /partner-api/tickets/ids` | `tickets:read` | reconciliation list (§5.3) |
| `GET /partner-api/tickets/:id` | `tickets:read` | `404` outside the partner/org set, moved out, or soft-deleted; `422 partner_export_record_blocked` when the scanner fires |
| `GET /partner-api/tickets/:id/comments` | `tickets:read` | creation order, keyset-paged, edits and tombstones (§5.4) |
| `POST /partner-api/tickets` | `tickets:write` | `source` fixed to `api`; `orgId ∉ accessibleOrgIds` → `403`; `X-Idempotency-Key`; `409 EXTERNAL_ID_CONFLICT` |
| `PATCH /partner-api/tickets/:id` | `tickets:write` | fields only (not status/assignee, never SLA targets or the portal login); strict schema |
| `POST /partner-api/tickets/:id/status` | `tickets:write` | shared coherence rules, no `aiDraftId` |
| `POST /partner-api/tickets/:id/assign` | `tickets:write` | `assigneeId` or `null` |
| `POST /partner-api/tickets/:id/comments` | `tickets:write` | `isPublic` **required** (a public comment emails the requester); `X-Idempotency-Key` |

Schemas derive from the shared staff validators (`createTicketBaseSchema` minus intake form and
portal login, `updateTicketSchema` minus SLA targets/portal login, `changeTicketStatusBaseSchema`
minus `aiDraftId`), all `.strict()`, control characters rejected in free text. Every write calls the
same `ticketService` functions the staff routes use — tenancy checks are never re-implemented. Both
scopes are opt-in and never join the Weavestream default.

**External correlation — namespaced by source.** A bare partner-wide `external_ticket_id` is
withdrawn: two integrations on one partner can legitimately hold the same id, and `tickets.partner_id`
is nullable (F5). Instead, a new table qualifies the id by its source, the way `psa_ticket_mappings`
is qualified by `connection_id`:

```
ticket_external_refs (
  id,
  ticket_id uuid NOT NULL → tickets ON DELETE CASCADE,
  org_id uuid NOT NULL → organizations ON DELETE CASCADE      -- denormalized from the ticket
  partner_id uuid NOT NULL → partners ON DELETE CASCADE,
  partner_service_principal_id uuid NOT NULL,
  external_id varchar(255) NOT NULL, external_url text, created_at, updated_at,
  UNIQUE (partner_service_principal_id, external_id),
  UNIQUE (partner_service_principal_id, ticket_id),
  FK (partner_service_principal_id, partner_id) → partner_service_principals(id, partner_id) ON DELETE CASCADE,
  FK (org_id, partner_id) → organizations(id, partner_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
)
```

`partner_id` is **NOT NULL** (it is the principal's partner, never the nullable `tickets.partner_id`,
F5), and the two composite foreign keys make tenant coherence a database fact: the principal and
the organization both belong to that one partner. The `(org_id, partner_id)` key is **`DEFERRABLE
INITIALLY IMMEDIATE`**, as org merge requires (it runs `SET CONSTRAINTS ALL DEFERRED` and re-points
parent and child in separate statements); the claim table (§4.1) has the same pair.

Shape 1; registered in the org cascade, both movers and the org-merge lock order (`ticket_id` +
denormalized `org_id`, appended last in all three lists after `ticket_checklist_items`, the claim
table after it — F9), merge (`repoint`) and export policy. On a cross-partner device move the ref is
deleted, not re-stamped (§4.2). The unique key covers
soft-deleted tickets too, so a restore can never collide; a create or PATCH whose `externalTicketId`
is already held by the principal answers `409 EXTERNAL_ID_CONFLICT` with `existingTicketId` (looked up
in the caller's own context, null when RLS hides it) and `existingDeleted`, so the integration can
restore-or-relink rather than duplicate. `?externalId=` resolves through the principal's own refs;
the feed record exposes `externalTicketId`/`externalTicketUrl` **as this principal's ref**. The
legacy `tickets.external_ticket_id/url` columns are left untouched (still returned by the staff
detail route, F5); folding them into the ref table is a follow-up.

**Rate limits.** Ticket writes get their own family, provisional defaults, two ceilings charged
narrowest first like enrollment-key minting: per principal+key
`PARTNER_API_TICKET_WRITE_RATE_LIMIT_PER_HOUR` (default 1200, capped by the key's own limit) and
partner-wide `PARTNER_API_TICKET_WRITE_PARTNER_RATE_LIMIT_PER_HOUR` (default 6000), separate from the
120/h provisioning budget.

## 7. Waves and reference implementation

| Wave | Contents | Branch (fork, stacked, reworked to this revision) |
|---|---|---|
| 1 | scopes (TS + SQL CHECK), `TicketActor` union + accessors, `ticket_comments` CHECK/column/policy, provenance constant, `ticket_external_refs` (+ movers, cascade, merge, export), audit-log rendering of principal rows | `feature/partner-api-tickets/wave-1` |
| 2 | `partner_feed_xid` + both triggers + index, the per-writer restamp suite as `breeze_app`, token factory, feed with tombstones, `ids`, `:id`, comments with edits/tombstones | `feature/partner-api-tickets/wave-2` |
| 3 | five write routes, `partner_api_idempotency_keys` (+ both movers, cascade, merge, export), retention job, two write ceilings | `feature/partner-api-tickets/wave-3` |
| 4 | `ticket.updated`/`ticket.assigned` on the bus, richer id-only payloads incl. `originPrincipalId`, webhook UI events | `feature/partner-api-tickets/wave-4` |

## 8. Decisions taken from review (formerly open questions)

1. Scopes stay `tickets:read` / `tickets:write`.
2. External ids are namespaced by the source principal (`ticket_external_refs`, §6), never partner-wide bare.
3. `1200/h` is provisional; both a per-principal and a partner-wide ceiling ship (§6).
4. Integration-set fields are human-authoritative; every provenance guard, including
   `ticketTriageFindings.ts:180`, moves to the shared constant (§3.3).
5. No attachments in v1, neither upload nor read (§3.4).

## 9. Risks and operational notes

- **Every comment write now also locks its parent ticket row.** The restamp (§5.2) is an `UPDATE
  tickets … WHERE id = NEW.ticket_id`, so a comment insert, edit or delete takes a row lock on the
  ticket until its transaction ends, and two transactions commenting on the same ticket serialize on
  it. At ticket scale this is negligible: comments on one ticket are human-paced, and the service
  paths that write a feed entry (status change, assignment, field update) update the ticket first in
  the same transaction, so they already hold this lock, in this order. The new edge is the
  comment-only writers (portal, inbound email, AI notes, comment edit and delete): a transaction
  that comments on several tickets now holds several ticket locks, and a writer that takes them in
  a different order than another could deadlock. Any bulk comment writer should take tickets in id
  order.
- **A silent no-op is the restamp's failure mode.** If a comment policy is ever added that admits a
  write without parent-ticket access, the `SECURITY INVOKER` restamp would match zero rows and the
  feed would miss that comment without an error. The per-writer suite (§5.2) is the guard; a new
  comment writer or policy must add its case there.
- **The xid8 column restamps on every ticket UPDATE**, including the org movers' and org merge's.
  That is intended (the move re-delivers the ticket), and the trigger is classified merge-benign.
- **Cross-partner device moves drop integration state.** Refs and idempotency claims of the old
  partner's principals are deleted (§4.2, §6). The old integration sees the ticket disappear from
  `GET /tickets/ids`; its external id becomes reusable.
- **Rate-limit defaults are provisional** (§6) and will be tuned on real traffic.
- **Webhooks stay per organization.** A partner-wide integration pairing the feed with webhooks
  needs one subscription per organization until partner-wide subscriptions ship (§5.6).

