---
title: Partner API Tickets Surface
status: draft
date: 2026-09-27
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
resulting surface, §7 the waves. A reference implementation exists as four stacked branches on a
fork (§7); it is offered as evidence that the shape works end to end, not as a fait accompli — every
decision below is open to review.

## 2. Repo facts this design is built on (verified 2026-09-26 against `main`)

| # | Fact | Evidence |
|---|---|---|
| F1 | Staff ticket routes mount `authMiddleware` only (JWT); `actorFrom(c)` builds the ticket actor from `auth.user`. Org `brz_` keys reach tickets only through the MCP `manage_tickets` tool, credited to the key's creator (`auth.user.id = createdBy`). Neither scope list has a ticket scope. | `routes/tickets/index.ts`; `routes/tickets/tickets.ts:90`; `routes/mcpServer.ts` `buildAuthFromApiKey`; `services/apiKeyScopes.ts`; `services/partnerServicePrincipalScopes.ts` |
| F2 | Partner API non-GET handlers get **no ambient DB context** and open their own bounded `withDbAccessContext` (`scope:'partner'`, `accessibleOrgIds`, `userId:null`); GET runs inside the middleware's held partner snapshot. Non-GET routes must be allowlisted in `writeSurface.test.ts`. Write budget is `min(key.rateLimit, 120)`/h per principal+key. | `middleware/partnerApiAuth.ts:302-353,402`; `routes/partnerApi/contracts.ts:46`; `routes/partnerApi/writeSurface.test.ts` |
| F3 | `TicketActor.userId` is required; `actorUserFk` nulls users(id)-FK columns only for `principalKind:'system'` (inbound email's `SYSTEM_ACTOR`). `updateTicketFields`, `assignTicket`, `addTicketComment` and `revalidateTicketAssignee` write `userId: actor.userId` directly; every `createAuditLogAsync` omits `actorType` (defaults `'user'`). | `services/ticketService.ts:83-120`; `services/inboundEmail/inboundEmailService.ts:43`; `services/auditService.ts:26,91` |
| F4 | `ticket_comments.origin_principal_kind` CHECK admits `('user','ai_agent','system','unknown')`; `breeze_user_isolation_insert` admits `user_id IS NULL` only under scope `system`; three permissive INSERT policies exist for portal, email and ai_agent authors, each gated on `breeze_has_org_access(t.org_id)` of the parent ticket. The helpdesk loop guard treats any `origin_principal_kind <> 'user'` as agent activity. | migrations `2026-09-19-ai-agents-ticket-shadow.sql:132`, `2026-06-13-b-fk-child-rls-backstop.sql:232`, `2026-09-25-b-ai-agents-ticket-triage-ai-note-rls.sql`; `services/ticketHelpdeskSubscriber.ts:129-150` |
| F5 | `tickets.external_ticket_id` / `external_ticket_url` exist, are in the export policy, and have no reader, writer or index. `tickets.updated_at` is not bumped by `addTicketComment` unless it stamps `firstResponseAt`. | `db/schema/portal.ts:159`; `services/ticketService.ts` (`addTicketComment`) |
| F6 | The alerts feed is the house pattern for a machine change feed: `alerts.partner_feed_xid xid8` stamped by a `BEFORE INSERT OR UPDATE` trigger with `pg_current_xact_id()`, traversal bounded by `pg_snapshot_xmin(pg_current_snapshot())`, signed page/checkpoint tokens bound to partner + filters + org set + database epoch, `409 …_resync_required`. Deliberately outside the per-org advisory-lock protocol (hot table, #6671). | migrations `2026-10-30-130000/130100-partner-api-alerts-*.sql`; `routes/partnerApi/alerts.ts`; `routes/partnerApi/alertsFeedToken.ts` |
| F7 | `ticket_outbox` is written in the mutation transaction and drained to the event bus by `ticketOutboxPublisher`; only `ticket.created`, `ticket.commented`, `ticket.status_changed` are published (`updated`/`assigned`/`restored` are drained unpublished). Payloads are id-only. Webhooks are per org; `webhooks.events` is a free-form string array. | `db/schema/ticketOutbox.ts`; `jobs/ticketOutboxPublisher.ts:57`; `db/schema/integrations.ts:62`; `routes/webhooks.ts:264` |
| F8 | Idempotency precedent: `X-Idempotency-Key` (1–128 printable ASCII), claim table `partner_enrollment_key_idempotency` — **shape 1** (`org_id NOT NULL`, policies `breeze_has_org_access(org_id)`), `enrollment_key_id` FK, unique `(principal, key)`, sha256 fingerprint, claim-then-link in one transaction, 409 on mismatch/race, reaped by `enrollmentKeyCleanup`. Registered in `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry` (repoint) and `CORE_TENANT_EXPORT_POLICY`. | `routes/partnerApi/provisioning.ts:545-826`; migration `2026-10-08-101600-enrollment-keys-scope.sql:55-117`; `services/tenantCascade.ts:664`; `services/orgMergeRegistry.ts:935`; `services/tenantExportPolicyRegistry.ts:497` |
| F9 | `field_provenance` CAS in `applyAiFieldUpdates` and the SLA restamp treat only `'user'` as human authority; AI never overwrites a `'user'` stamp. | `services/ticketService.ts` (`applyAiFieldUpdates`, `computeSlaRestamp`) |

## 3. Actor and attribution (#7181, point 1)

### 3.1 Rule

Two kinds of API credential, two rules — settled with the product owner of the requesting MSP and
consistent with how MCP already behaves:

- A **human-owned org `brz_` key** (including MCP `manage_tickets`) is *delegation*. Everything it
  does is credited to the user who owns the key; only the internal audit row (`mcp.*`,
  `actor_type='api_key'`) distinguishes it. **Unchanged by this design.**
- A **partner service principal** (`brz_sp_`) has no human owner and **acts as itself**.

### 3.2 Mechanics

A new `TicketActor.principalKind = 'service_principal'` (alongside `'user' | 'ai_agent' | 'system'`),
built by the Partner API route as
`{ userId: <keyId>, name: <principal name>, principalKind: 'service_principal', servicePrincipal: { keyId, partnerServicePrincipalId, principalName } }`.
`userId` is the key id — a real UUID that is not a `users` row, the same trick `SYSTEM_ACTOR` uses —
so the existing `TicketActor.userId: string` contract holds. Three service-level helpers make the
kind observable everywhere a write is recorded:

| Concern | Behaviour for `'service_principal'` | Where |
|---|---|---|
| users(id) FK columns (`ticket_comments.user_id`, `tickets.closed_by`, event `actorUserId`, `ml_feedback_events.actor_user_id`) | `null`, via `actorUserFk` — extended from `'system'` only to both machine kinds. The four direct `userId: actor.userId` writers in F3 are routed through it (behaviour for `'user'` unchanged). | `ticketService.ts` |
| Feed/comment author columns | `authorName` = principal name, `authorType = 'internal'` (portal and the comment edit-window branch on `!== 'portal'`), **`origin_principal_kind = 'service_principal'`** | `commentAuthorFields()` |
| Audit rows (`ticket.create/update/status_change/assign/comment`) | `actorType: 'api_key'` (existing enum value), `actorId: <keyId>`, `initiatedBy: 'integration'`, details `{ partnerServicePrincipalId, partnerServicePrincipalName }` — never the key. Every other actor keeps the `'user'` default. | `ticketAuditActor()` |
| RLS | `ticket_comments` CHECK widened with `'service_principal'`; a **fourth permissive INSERT policy** `breeze_ticket_parent_service_principal_insert` (`user_id IS NULL AND portal_user_id IS NULL AND origin_principal_kind='service_principal' AND parent ticket org-accessible`) — the same shape as portal/email/ai_agent (F4). Needed because Partner API writes run partner-scoped, never system. | migration |
| `field_provenance` | stamped `'service_principal'`; treated as **human-authoritative** by the AI triage CAS and the SLA restamp (`NOT IN ('user','service_principal')`): an external system of record is not overwritten by AI. | `applyAiFieldUpdates`, `computeSlaRestamp` |
| Helpdesk AI loop guard | A service-principal comment counts as agent activity (F4): it never triggers an automatic helpdesk reply and suppresses a pending one. Intended, fail-closed — an external system must not be able to drive AI spend. | unchanged code, documented in the migration header |
| Surface-level audit | The middleware's `partner_api.request` row (method/path/status, `actorType:'api_key'`) plus the service's domain row above; no third per-route audit. | `partnerApiAuth.ts` |

The value is `'service_principal'`, not `'api_key'`, on purpose: the human `brz_` key path keeps
`'user'`, so the vocabulary names *who acted* (an ownerless principal), not the credential type.
`audit_logs.actor_type` keeps using its existing `'api_key'` value.

### 3.3 Human-only transitions

These stay closed to any machine principal (403 `HUMAN_SESSION_REQUIRED` at the service, and no
route on the surface): soft delete / restore (`deleted_by` is a users FK, and delete is
`tickets:manage`), move-org (step-up + currency guard), bulk actions, attachments (upload uses
`auth.user.id` for the claim and pending cap; **read** could follow later), time entries and parts
(wave-08 financial audit contract), applying an AI draft (`ticket_drafts.consumed_by` is a users
FK), the mailbox, comment edit/delete (author-or-manage semantics do not map to a principal),
`/requesters`, `/stats`, triage-suggestion apply/reject. Assigning is allowed (`assertAssigneeEligible`
already enforces same-partner + `tickets:read` + org access for the assignee).

### 3.4 Alternatives rejected

- *Credit the human who minted the principal.* A principal outlives its minter and is rotated
  independently; the audit trail would name someone who did nothing. This is exactly what the
  `brz_` key avoids by construction (it dies with its owner) and what a principal must not inherit.
- *A synthetic `users` row per principal.* Would make every users-FK column "work" but pollute
  assignee pickers, notifications and RBAC with non-humans; `SYSTEM_ACTOR` chose the null-FK route
  for the same reason.
- *Widening org `brz_` keys with `tickets:*` scopes instead.* One org per key, tied to the creator's
  lifecycle, no source CIDRs, no per-request audit, and `requirePermission`/`userRateLimit` assume a
  human. Kept as a v1.1 follow-up for the single-customer case; the actor work above makes it cheap.

## 4. Idempotency store (#7181, point 2)

### 4.1 Table

`partner_api_idempotency_keys` — the enrollment-key claim table (F8) generalised with a `route`
discriminator so one table serves every resource-creating Partner API write (v1: `tickets.create`,
`tickets.comment`):

```
id uuid PK
partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE
partner_service_principal_id uuid NOT NULL
org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE
route varchar(64) NOT NULL
idempotency_key varchar(128) NOT NULL
request_fingerprint varchar(64) NOT NULL          -- sha256 of canonical JSON {route, body}
resource_id uuid                                  -- no FK: the route decides the table
created_at timestamptz NOT NULL DEFAULT now()
UNIQUE (partner_service_principal_id, route, idempotency_key)
FK (partner_service_principal_id, partner_id) → partner_service_principals(id, partner_id) ON DELETE CASCADE
FK (org_id, partner_id) → organizations(id, partner_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
indexes: partner_id, org_id, created_at
```

### 4.2 Tenancy shape and registrations

**Shape 1 (`org_id`)**, deliberately not partner-axis: a claim protects a resource that lives in one
organization, so it must follow that organization through erasure (GDPR delete must not strand a
row naming the org) and through merge (the claim repoints with the ticket it names). The composite
`(org_id, partner_id)` FK is `DEFERRABLE INITIALLY IMMEDIATE` per the merge contract. RLS is
enabled + forced with the four `breeze_has_org_access(org_id)` policies, so a claim is visible only
to a principal that can reach its org. Registrations, all in the same PR as the migration:

| Contract | Entry |
|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`) | `partner_api_idempotency_keys`, alphabetical (before `partner_enrollment_key_idempotency`); no FK children |
| `orgMergeRegistry.ts` | `repoint` |
| `CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts`) | all columns `included`, `request_fingerprint` as `reviewedIncluded` (mirrors the enrollment table) |
| `rls-coverage` | auto-discovered (shape 1) |
| Retention | reaped by the existing enrollment-key cleanup sweep with the same 7-day retention (`created_at` index is the scan path) |
| Device-side lists | not applicable (no `device_id`) |

### 4.3 Protocol

Same as provisioning: validate the header before any I/O; look up `(principal, route, key)` in the
handler's partner context **after** the ticket-level authorization (an unknown or foreign ticket is
a 404 before any claim state is read, so a key cannot probe existence); a matching fingerprint with a
linked resource replays (`200` + `idempotencyReplay: true`, resource re-read through the same
partner-bound lookup); a different fingerprint is `409 …_key_reused`; a claim with no resource is
`503 …_state_invalid` (first attempt died between claim and commit). Otherwise claim with
`ON CONFLICT DO NOTHING` (null → `409 …_in_flight`), create through `ticketService`, link the resource
id — all inside the handler's `withDbAccessContext`, so claim, resource and link commit or roll back
together. The fingerprint is key-order independent (canonical JSON) and JSON round-trips the
validated body first (zod coerces `dueDate` to a `Date`).

### 4.4 Alternatives rejected

- *Reuse `partner_enrollment_key_idempotency`.* Its `enrollment_key_id` is an FK to
  `enrollment_keys`; a ticket claim cannot use it. Folding provisioning into the generic table is an
  additive follow-up, not a prerequisite.
- *Partner-axis table.* Simpler RLS, but a claim would survive the erasure of the org it names.
- *Redis-only claims.* Loses the "claim + resource commit together" property that makes a retry safe
  across a crash between insert and response.

## 5. Change feed, cursors, and the webhook outbox (#7181, point 3)

### 5.1 Feed

`GET /partner-api/tickets` is a **latest-state change feed**, mechanically identical to the alerts
feed (F6): `tickets.partner_feed_xid xid8` stamped by a `BEFORE INSERT OR UPDATE` trigger, a
`(partner_feed_xid, id)` index built `CONCURRENTLY`, traversal over the fixed window
`[lower, horizon)` where `horizon = pg_snapshot_xmin(pg_current_snapshot())` at the first page. A
transaction that commits after a later-started one is therefore never skipped behind a checkpoint
the poller already holds; a row rewritten mid-traversal moves above `horizon` and arrives next time;
several changes between polls coalesce into the current row. Like alerts, the trigger is **not** part
of the per-org advisory-lock protocol (ticket writes are hot), and it is registered as merge-benign
(it only stamps; a repoint restamps and correctly re-delivers).

Because a comment only touches `ticket_comments`, `addTicketComment` now bumps `tickets.updated_at`
on every comment (previously only when stamping `firstResponseAt`), so comment-only activity
re-delivers the ticket; the comments route (`GET /tickets/:id/comments`) is how the consumer reads
what changed.

### 5.2 Tokens

The alerts token module becomes a factory, `createPartnerFeedTokens(spec)`, with **one HMAC domain
per feed** (`breeze-partner-tickets-feed-v1`), so an alerts token can never be replayed against the
tickets feed or vice versa; `alertsFeedToken.ts` becomes a thin binding with identical behaviour.
Three kinds:

- `page` — continues one traversal: `[lower, horizon)` + last `(xid, id)`; expires after 24 h.
- `checkpoint` — returned on the last page; its `horizon` is the next traversal's inclusive lower
  bound. Bound to partner, exact filter set (`orgId`, `status`, `priority`, `assigneeId`,
  `externalId`), org-set hash and database epoch. A different filter set is `400`; a different org
  set or epoch is `409 partner_tickets_resync_required` (orgs that became reachable later hold rows
  below the horizon).
- `keyset` — for the bounded per-ticket comments list: `(created_at::text, id)` with the
  microsecond-exact database rendering (an ISO cursor repeats the boundary row), bound to the partner
  and a hash of `{ticketId, since}`.

### 5.3 Relation to the outbox and webhooks

The outbox tells an integration **that** something changed; the feed (and `GET /tickets/:id`) is
how it reads **what** changed. They are complementary, not redundant:

| | `ticket_outbox` → event bus → webhooks | Partner API feed |
|---|---|---|
| Trigger | push, per mutation, delivered by `webhookDelivery` with HMAC signing | pull, per poll |
| Scope | per organization webhook | per partner principal, across its org set |
| Payload | ids and enum labels only, never text | full DTO through the export secret scanner |
| Consistency | at-least-once, unordered | exactly-once per committed change, ordered by xid |

This design extends the outbox side minimally: `ticket.updated` and `ticket.assigned` are bridged
onto the bus (F7), and payloads stay id-only but say more — `ticket.created` gains `internalNumber`,
`source`, `assigneeId`, `externalTicketId`; `ticket.updated` carries the changed field **names**;
`ticket.status_changed` gains `statusId`; every `ticket.commented` writer carries
`originPrincipalKind`, so a mirror can skip the comments it authored itself. Partner-wide webhook
subscriptions (`webhooks.org_id XOR partner_id`) are a follow-up, not part of v1.

### 5.4 Alternative rejected

An `updated_at` watermark: simpler, but reintroduces the commit-order gap the alerts feed was built to
close, and would need either an overlap window (duplicates) or the advisory-lock protocol (which the
alerts migration header rules out for hot tables).

## 6. Surface

| Route | Scope | Notes |
|---|---|---|
| `GET /partner-api/tickets` | `tickets:read` | feed (§5); audited as an export resource (`partner_api.export`, `recordCount`); `tickets` is `customer-authored` for the structural secret layer |
| `GET /partner-api/tickets/:id` | `tickets:read` | `404` outside the partner/org set or soft-deleted; `422 partner_export_record_blocked` when the scanner fires |
| `GET /partner-api/tickets/:id/comments` | `tickets:read` | creation order, keyset-paged, deleted excluded |
| `POST /partner-api/tickets` | `tickets:write` | `source` fixed to `api`; `orgId ∉ accessibleOrgIds` → `403`; `X-Idempotency-Key`; `409 EXTERNAL_ID_CONFLICT` |
| `PATCH /partner-api/tickets/:id` | `tickets:write` | fields only (not status/assignee, never SLA targets or the portal login); strict schema |
| `POST /partner-api/tickets/:id/status` | `tickets:write` | shared coherence rules, no `aiDraftId` |
| `POST /partner-api/tickets/:id/assign` | `tickets:write` | `assigneeId` or `null` |
| `POST /partner-api/tickets/:id/comments` | `tickets:write` | `isPublic` **required** (a public comment emails the requester); `X-Idempotency-Key` |

Schemas are derived from the shared staff validators (`createTicketBaseSchema` minus intake form and
portal login, `updateTicketSchema` minus SLA targets/portal login, `changeTicketStatusBaseSchema`
minus `aiDraftId`), all `.strict()`, with control characters rejected in free text. Every write calls
the same `ticketService` functions the staff routes use — tenancy checks (device/contact/portal user
in the org, assignee/category in the partner, Service Management gate, status FSM) are never
re-implemented. Both scopes are opt-in and never join the Weavestream default (`tickets:read`
exposes customer-authored text). Ticket writes get their own hourly bucket
(`PARTNER_API_TICKET_WRITE_RATE_LIMIT_PER_HOUR`, default 1200, capped by the key's own limit) so a
PSA mirror can neither starve nor be starved by the 120/h provisioning budget.

`externalTicketId` / `externalTicketUrl` become the correlation key: settable on create and update,
filterable (`?externalId=`), unique per partner among live tickets (partial unique index on
`(partner_id, external_ticket_id) WHERE external_ticket_id IS NOT NULL AND deleted_at IS NULL`),
duplicates answered with `409 EXTERNAL_ID_CONFLICT` whose `existingTicketId` is looked up in the
caller's own context (null when RLS hides it), never through a system-scope escape.

## 7. Waves and reference implementation

| Wave | Contents | Branch (fork, stacked) |
|---|---|---|
| 1 | scopes (TS + SQL CHECK), `service_principal` actor + `ticket_comments` policy, external-id index | `feature/partner-api-tickets/wave-1` |
| 2 | `partner_feed_xid` + trigger + index, token factory, three GET routes, `tickets` export resource | `feature/partner-api-tickets/wave-2` |
| 3 | five write routes, `partner_api_idempotency_keys` + registrations, ticket write rate bucket | `feature/partner-api-tickets/wave-3` |
| 4 | `ticket.updated`/`ticket.assigned` on the bus, richer id-only payloads, webhook UI events | `feature/partner-api-tickets/wave-4` |

Each wave is green locally on typecheck, lint, the full API/web unit suites, `check:migrations` on a
fresh database, `test:rls-coverage`, `db:check-drift`, and the RLS/cascade/merge/export/erasure
integration contracts. None will be opened as a PR until this document is reviewed; if the shape
changes here, the branches change first.

## 8. Open questions for review

1. Scope names `tickets:read` / `tickets:write` (vs. a single `tickets:manage`, or a separate
   `tickets:comments:write`)? The proposal keeps two, matching `alerts:read` / `contracts:write`.
2. Should `external_ticket_id` uniqueness be partner-wide (proposed) or per organization? Partner-wide
   matches how a PSA numbers tickets; per-org would let two orgs mirror the same PSA id.
3. Is `1200/h` the right default for the ticket write family, and should it be per principal only
   (proposed, `min(key.rateLimit, …)`) or also carry a partner-wide ceiling like enrollment-key
   minting?
4. `field_provenance = 'service_principal'` as human-authoritative for AI triage (proposed): an ITSM
   is a system of record. The alternative is to let AI overwrite integration-set category/priority.
5. Attachments: v1 offers none. Would a read-only `GET /tickets/:id/attachments/:id/content` be
   acceptable now, with upload deferred until `uploaded_by_api_key_id` exists?
