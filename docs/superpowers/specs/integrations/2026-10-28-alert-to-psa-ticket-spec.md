---
title: Alert → PSA ticket (ConnectWise Manage) — partner-wide webhooks, payload contract, Partner API write-back, native ticket creation
issue: 10499
folds_in: [10500]
status: draft
date: 2026-10-28
base: main @ bd22427dfe
---

# Alert → PSA ticket (ConnectWise Manage)

Evidence labels: **verified** = read in code at `bd22427dfe`; **inferred** = reasoned, not run or not read end-to-end. Line numbers are at that SHA.

## 1. Problem

An MSP prospect migrating from ConnectWise Automate, with ConnectWise Manage as its PSA, named "generate a Manage ticket from an alert, by API or webhook" as its top blocker. Automate's Manage plugin does this natively; Breeze cannot, and the pieces a partner would need to build it with middleware are incomplete:

1. **No automatic alert → PSA ticket, and no close-on-resolve.** The PSA adapters have `createTicket`/`updateTicket` but nothing calls them (verified: `services/psa/connectwise.ts:153,167`; `createPSAProvider` is reached only from test-connection and company import, `routes/psa.ts:906,1346`). `psa_ticket_mappings` exists but is never written outside tests (verified: `db/schema/integrations.ts:162-173`). `POST /psa/connections/:id/sync` is an honest 501 (verified: `routes/psa.ts:971-981`).
2. **No partner-wide outbound webhook.** `webhooks.org_id` is NOT NULL (verified: `schema/integrations.ts:62`) and fan-out matches the event's org only (verified: `services/webhookFanoutDeps.ts:29-43`). An MSP with 200 customers needs 200 webhooks.
3. **Thin, undocumented alert payloads.** `alert.triggered` carries `alertId, ruleId, deviceId, severity, title, message`, monitor fields, `subjectKey` and `responsesOwner` (verified: `services/alertService.ts:344-362`). `alert.resolved` carries no severity or title (verified: `:935-948`). `alert.acknowledged` carries ids and `acknowledgedBy` only (verified: `routes/alerts/alerts.ts:973-983`). None of them carries a hostname, site, org name or PSA company id. At least ten producers publish alert events (verified by grep: `alertService.ts`, `subjectAlertOutbox.ts`, `offlineTransitionEffects.ts`, `topology/monitoringAlerts.ts`, `hardwareHealth/retirementOutbox.ts`, `metricAnomalyEpisodeActions.ts`, `routes/alerts/alerts.ts`, `routes/alerts/correlations.ts`, `routes/mobile.ts`, `aiToolsAlerts.ts`). `alert.escalated` is documented (`apps/docs/.../features/webhooks.mdx:92`) and is in `EVENT_TYPES` (`eventBus.ts:676`), so the API accepts a subscription to it, but nothing publishes it (verified, #10500).
4. **No write-back.** The Partner API has `alerts:read` (a partner-wide cursor feed, verified: `routes/partnerApi/alerts.ts:31-48`) but no `alerts:write`. Ticket create takes no `alertId`, and the org export omits `organization_external_links` (verified: `partnerApi/schemas.ts:107-111`).
5. **About 30 s of retries, then a Redis DLQ** (verified: `workers/webhookDelivery.ts:29-33`, 1 s doubling, 5 tries; DLQ push at `:653-666`). Every failed attempt writes the row as `failed` (`webhookDeliveryRecord.ts:181-182`), so the pending retry exists only in Redis. A Manage maintenance window loses every alert raised during it.

**Delivery is not durable by default** (verified). `EVENT_DISPATCH_MODE` defaults to `off` (`config/env.ts:695-701`; `docker-compose.yml:220`, `deploy/docker-compose.prod.yml:369`). In that mode registered subscribers run as local handlers, and a thrown error is logged and dropped (`eventBus.ts:531-536`). Any design that relies on "the subscriber throws, so the dispatcher retries" holds only when a host sets `enforce` and lists the subscriber.

## 2. Users and scope

| Wave | Who configures | Level | Who sees the result |
|---|---|---|---|
| W1 partner-wide webhooks | Partner users with `orgAccess = 'all'` (`canManagePartnerWidePolicies`, `services/partnerWideAccess.ts:25-29`) | **Partner.** Org-owned webhooks are unchanged. | Partner admins only. Org users and restricted partner users never see a partner webhook or its deliveries, which carry other orgs' events. The org's tenant export is the one stated exception (§4). |
| W1b Partner API write-back | A partner service principal granted `alerts:write` (opt-in) | **Partner** (principal), acting on alerts in the orgs the principal can reach | Anyone who can read the alert sees the external ticket reference |
| W2 native alert → PSA ticket | Partner admins on the partner's bound PSA connection | **Partner.** Per-org effect comes from the org's PSA company link. There is no org-level override in W2, and the UI says so. | Org and partner users who can read the alert see the PSA ticket number, link and state |

Org-owned PSA connections (a co-managed customer's own Jira or Zendesk) do not auto-ticket in W2.

## 3. Proposed design

### W1 — partner-wide webhooks and the alert payload contract (M; two PRs)

**PR 1: payload v2, docs, durable retries.** Migration: new columns on `webhooks` and `webhook_deliveries` (§4).

*Versioning (OD2).* Each webhook gets `payload_version`. Existing rows stay at **1**, which keeps today's serializer byte-for-byte. New webhooks, and every partner webhook, default to **2**. An owner can upgrade an existing webhook in the edit form. Downgrading is allowed while v1 is supported. A deprecation policy for v1 is a later decision. Each delivery pins the version that was current when it was recorded.

*Enrichment at fan-out, not at the producers.* Editing ten producers would drift. Instead, `handleWebhookFanoutEvent` (`workers/webhookDelivery.ts:873`) builds the v2 `data` once per event and only after at least one v2 webhook has matched. The event types come from an explicit allowlist: `alert.triggered`, `alert.acknowledged`, `alert.resolved` and `alert.suppressed`. A prefix match on `alert.*` would also catch `alert.correlation_group.created`, which has no single-alert status (`eventBus.ts:678`).

The builder returns two separate, immutable projections: an **org** projection, and a **partner** projection that adds `orgExternalIds`. Each target gets its own copy, so a partner-only field can never leak into an org webhook through a shared object; a test covers both processing orders.

The enriched fields are an **enrichment-time snapshot** taken under the event's tenancy. They are not event-time facts. Values on the event payload take precedence: `status` is derived from the event type, and `resolvedAt` and `triggeredAt` come from the payload. The row is never re-read for state, because the auto-resolve sweep publishes before its transaction commits (verified: `eventBus.ts:23-34`).

If enrichment fails, the builder **degrades rather than throws**. In the default `off` dispatch mode a throw drops the whole fan-out with no recovery path (`webhookDelivery.ts:878-900`). So the missing fields become `null`, the payload carries `enrichmentIncomplete: true`, and the failure is logged with an `errorId` and sent to Sentry.

*Alert `data`, payload v2.* A ✚ marks a field that is new. Every field v1 carries today is kept, including `subjectKey`, `responsesOwner`, `resolutionNote`, `resolvedBy` and `resolutionReason`.

| Field | Type | Notes |
|---|---|---|
| `alertId`, `ruleId`, `monitorId`, `deviceId`, `episodeId` | uuid \| null | ✚ on the events that lack them today |
| ✚ `status` | `active` \| `acknowledged` \| `resolved` \| `suppressed` | derived from the event type |
| `severity`, `title`, `message` | | ✚ on acknowledged and resolved |
| ✚ `triggeredAt`, `acknowledgedAt`, `resolvedAt` | ISO \| null | |
| ✚ `deviceHostname`, `siteId`, `siteName`, `orgName` | string \| null | same `deviceHostname` meaning as the Partner API feed (`partnerApi/schemas.ts:645`) |
| ✚ `alertUrl` | string | deep link to the alert page |
| ✚ `orgExternalIds` | `[{system, externalId}]` | **partner projection only**; the links are partner-owned (`schema/orgExternalLinks.ts:18-39`) |
| ✚ `externalTickets` | `[{source, externalId, externalUrl, externalNumber}]` | refs written by W1b or W2 that existed at enrichment time. A ref written later is **not** in an earlier payload, so middleware must look it up (W1b `GET …/external-tickets`) and must not assume the payload is complete. |
| ✚ `acknowledgedByPrincipalId`, `resolvedByPrincipalId` | uuid \| null | added in W1b; lets middleware skip its own writes |

The v2 envelope is `{id, type, timestamp, orgId, schemaVersion: 2, replayOf, data}`. The v1 envelope is unchanged (verified: `webhookDelivery.ts:268-274`). The HMAC input (`:161-164`, `:288-293`) is unchanged for both.

Tests freeze the v2 contract on keys, types, and null-versus-absent, and fail if anything is removed or retyped. v1 is frozen with golden fixtures captured from today's producers.

*Persisted wire identity.* `webhook_deliveries` stores what is needed to reproduce the envelope:
- `payload_version` and `event_timestamp`. Recovery currently substitutes `created_at` (`webhookDeliveryRecovery.ts:417-423`).
- `replay_root_event_id`. A manual retry mints a new event id (`routes/webhooks.ts:999`), because `(webhook_id, event_id)` is unique. The delivery therefore carries `X-Breeze-Replay-Of: <root>`, and a replay of a replay keeps the root.

The docs tell consumers to dedupe transport on the root event id. Ticket dedupe is a separate concern: it keys on `alertId` plus the consumer's own ticket state, never on `alertId + type`, because a suppressed alert can come back to `active` and be acknowledged again (`routes/alerts/alerts.ts:1243-1250`).

*Durable retries (OD4).*
- **Schedule.** One fixed schedule for every webhook: 1 m, 5 m, 30 m, 2 h, 6 h and 12 h, about 21 h in total, with ±20 % jitter. After that the delivery is terminal `failed`.
- **Source of truth.** Postgres. A failed attempt writes a **new** enum value, `scheduled`, together with `next_retry_at` and `attempts`; only the final attempt writes `failed`. A new value is needed because `retrying` already means "claimed and in flight". The recovery sweep resolves an abandoned `retrying` row **terminally** to avoid a duplicate POST (verified: `webhookDeliveryRecovery.ts:77-87`), and that meaning must not change.
- **Wake-up.** A BullMQ delayed job carries ids only: `deliveryId`, `webhookId`, `generation`. Every attempt, not just the first, claims the row by CAS (`status IN ('pending','scheduled') AND next_retry_at <= now()`, moving it to `retrying`) and checks lifecycle: the webhook is active, the generation matches, and for a partner webhook the event org still belongs to the partner and is live.
- **Erasure.** Erasing an org deletes its rows. A delayed job that wakes up after that finds no row and drops, so it cannot POST erased data. Today a retry with `attempts > 0` skips the claim (verified: `webhookDelivery.ts:563-570`).
- **Recovery sweep.** It also re-drives `scheduled` rows that are past due. This is safe, because nothing is in flight for them.
- **Retired.** The Redis list queue and the DLQ (`breeze:webhooks:dlq`) go. The DLQ has no route callers (verified by grep), its entries hold org payloads that erasure cannot reach (inferred), and a terminal `failed` row already supports manual replay (`routes/webhooks.ts:956-1070`).
- **Cut-over.** Drain list entries that were queued before the deploy, and log their count. Ingest the DLQ entries once into `failed` rows that still have a backing webhook, and drop the rest.
- **`retry_policy`.** The jsonb column stays unused; no API exposes it (`routes/webhooks.ts:395-416`).

*`alert.escalated` (OD3).*
- Add a `NEVER_PUBLISHED` deny-list beside `PUBLISHED_EVENT_TYPES` (`routes/webhooks.ts:366-370`), so creating or updating a subscription to it returns 400. Today it slips through because that set is built from all of `EVENT_TYPES`. `webhookEventOptions.contract.test.ts` guards the deny-list.
- Values already stored are not silently stripped. The UI shows a "never delivered" chip, and the value is dropped the next time the webhook is saved.
- A webhook subscribed **only** to `alert.escalated` gets a warning banner.
- A follow-up issue implements the event.

*Web.* Add `alert.acknowledged` and `alert.suppressed` to `webhookEventOptions`. Today only triggered and resolved are offered (verified: `components/webhooks/WebhookForm.tsx:61-62`). Add a version selector.

*Docs* (`features/webhooks.mdx`; closes #10500):
- a per-event v1 and v2 `data` table, and the versioning rule;
- the retry schedule, replacing `:253-299`;
- replay and dedupe guidance;
- the HMAC recipe (`:323-360`, which exists today), checked to name `X-Breeze-Signature-Timestamp` as the signed timestamp;
- a worked example, alert → ConnectWise Manage through middleware.

**PR 2: partner-owned webhooks (migration).** The Partner-Wide First playbook (`docs/agents/tenancy-rls.md`), step by step:

1. *Migration.*
   - `webhooks.partner_id` FK; drop NOT NULL on `org_id`; `webhooks_one_owner_chk` (exactly one owner); a partial index on `(partner_id) WHERE status='active'`. No backfill is needed: every existing row already satisfies the XOR.
   - One `webhooks_isolation` policy (system OR `breeze_has_org_access(org_id)` OR `breeze_has_partner_access(partner_id)`) replaces the generic per-command org policies. This copies `2026-08-17-psa-connections-partner-ownership.sql`.
   - **No partner-wide SELECT branch (OD1).**
   - The `webhook_deliveries` changes are in §4.
2. *Writes.*
   - Create takes `ownerScope`; `partner` requires `canManagePartnerWidePolicies`. The update schema omits `ownerScope`.
   - Org rows keep the `canMutateOrgWideGovernance` gate (`routes/webhooks.ts:528`).
   - Audit uses `auditOwnerFields` (org_id NULL, partner id set; `routes/psa.ts:206-215`).
3. *Reads.*
   - Partner rows, and their deliveries, tests and retries, require partner or system scope **and** `canManagePartnerWidePolicies`.
   - This is enforced in the app layer, because RLS cannot express `org_access='selected'`. The same limit is documented in `2026-08-17-psa-connections-partner-ownership.sql`.
4. *Config-policy linkage.* Not applicable.
5. *Fan-out by the event org's partner.*
   - `getWebhooksForEvent` matches `org_id = :org OR (org_id IS NULL AND partner_id IN (SELECT partner_id FROM organizations WHERE id = :org AND partnerFanoutOrgCondition()))`. This is the partner-wide flow-trigger predicate (verified: `services/flows/eventTrigger.ts:155-167`; `services/partnerFanoutOrgs.ts:2-50`). Holding, quick-support, soft-deleted and non-live orgs never reach a partner webhook.
   - **There is no per-org filter on a partner webhook in W1; this is settled.** Receivers filter on `orgId`.
   - **An org that leaves its partner** stops at the next event, because fan-out resolves the partner when each event is processed. The send-time lifecycle check also drops retries that are already queued.
6. *Tests and UI.* Covered in §7. The UI gets a create-only owner selector and an "All organizations" badge (`components/software/PolicyForm.tsx`).
7. *Repo-wide `webhooks.orgId` sweep.* Verified call sites:
   - `routes/webhooks.ts`: the list at `:449-517`, `getWebhookWithOrgCheck` at `:269-285`, and the test and retry event rebuild at `:880-905`.
   - `services/webhookFanoutDeps.ts:29-43`, `services/webhookConfig.ts:12,76`, `workers/webhookDelivery.ts` (`WebhookConfig.orgId`), and `services/webhookDeliveryRecord.ts`.
   - `jobs/webhookDeliveryRecovery.ts:277,426`, which rebuilds `event.orgId` from `webhooks.org_id`. That value is NULL for a partner webhook, so it must use `webhook_deliveries.org_id`.
   - `jobs/webhookDeliveryRetention.ts`.
   - `services/connectionHealth/sources/webhook.ts:124-131`: `JOIN organizations ON o.id = w.org_id` silently drops partner webhooks. Make it a LEFT JOIN, take the partner from `w.partner_id`, and set the incident's `orgId: null`, the pattern `sources/accounting.ts:31-32` already uses.
   - `services/aiToolsIntegrations.ts:126,300`.
   - Web: `components/webhooks/*`. The plan confirms whether `components/integrations/Webhook*.tsx` is dead code.
   - Test sends from a partner webhook carry `orgId: null`.

### W1b — Partner API write-back (S–M; migration)

- **Scope `alerts:write`.** Opt-in, appended to `PARTNER_SERVICE_PRINCIPAL_WRITE_SCOPES` (`partnerServicePrincipalScopes.ts:21-36`). It is never part of a default scope set.
- **`POST /partner-api/alerts/:id/acknowledge` and `/resolve`** (`{ note? }`).
  - Both are CAS state transitions, so repeating one returns 200 with the current state.
  - One shared service: extract `acknowledgeAlert(alertId, actor)` from `routes/alerts/alerts.ts:921-1000`, and give `resolveAlert` (`alertService.ts:815`) an actor parameter.
  - **Settled: new columns `acknowledged_by_principal_id` and `resolved_by_principal_id`** (FK to `partner_service_principals`, ON DELETE SET NULL), published on the events. This is a correctness requirement. `acknowledged_by` and `resolved_by` are FKs to `users`, so they stay NULL for a principal. But `alertVerdictSubscriber.ts:48` treats `resolvedBy === null` as a system auto-resolve and starts a paid AI verdict run. A non-null `resolvedByPrincipalId` must therefore count as a human-equivalent resolve.
  - The resolve carries `resolution_reason='manual'`, because `fixMemory/outcomeWatcher.ts:83-85` reads `resolutionReason` once `resolvedBy` is null.
- **External ticket reference on an alert (OD5).** A new table `alert_external_refs`, mirroring `ticket_external_refs` (`schema/ticketExternalRefs.ts:1-53`, #7181).
  - Namespaced by principal: one ref per (principal, alert).
  - Written by `PUT` and `DELETE /partner-api/alerts/:id/external-ticket`. `externalUrl` must be https, and the plan reuses the #7181 validator.
  - Read by `GET /partner-api/alerts/:id/external-tickets`, which also returns W2 PSA mappings. Middleware uses it whenever a payload's `externalTickets` is stale.
  - Anyone who can read the alert sees the ref.
- **`alertId` on `POST /partner-api/tickets`** (`ticketWrites.ts:104-112`). The alert must be in the ticket's org and reachable by the principal. Creating the ticket writes `ticket_alert_links` (`created_from`, `schema/tickets.ts:41-52`) in the same transaction. `alertId` is part of the `X-Idempotency-Key` fingerprint (`partnerApi/idempotency.ts`).
- **Org export.** The record gains `externalLinks` (`partnerApi/schemas.ts:107-111`). Its watermark is `organizations.partner_export_updated_at` (`partnerApi/organizations.ts:272`), so link writes must bump it through a trigger (inferred; check the `breeze_partner_export_*` trigger family).
- **Docs.** `docs/integrations/partner-api.md` (`:497`, `:705`) and `reference/api.mdx:196-240`. `openapi.ts` does not cover `/partner-api` (`:26`).

### W2 — native alert → PSA ticket (L; migration)

**Model: Postgres is the ledger, events and BullMQ only wake it.** Correctness never depends on how an event was dispatched or in what order (§1). The worker always reconciles toward the **committed** alert row:
- an alert that has resolved, and committed, is closed;
- an alert row that has disappeared means the trigger was rolled back.

**Activation (OD7).**
- Only the partner's **bound** connection is used (`partners.service_management_psa_connection_id`, verified: `schema/orgs.ts:180-211`, #5075 W04), and only in `external` mode with ticketing enabled.
- A mapping **pins** its `connection_id` and a `config_rev` when it is admitted. Unbinding, rebinding or disabling the connection stops **new** admissions. Mappings that already exist still close on their own connection, following their own snapshot. If the rebind goes to a different PSA **instance**, existing company links are treated as unverified until a partner admin confirms them. Company links key on provider, not instance (`psa/companyImport.ts:15-25`).
- This fills the gap documented in the comment at `AlertDetailPage.tsx:346-358`.

**Provider surface (settled).**
- A generic orchestration over a new optional capability, `PSAAlertTicketing`: create with board/status/priority **ids** and a marker, `closeTicket(statusId)`, `addNote`, `findTicketsByMarker`, and pickers for boards, statuses and priorities.
- Errors are **structured** at the adapter boundary: HTTP status, `Retry-After`, a scrubbed and truncated body, and a class of `auth`, `rate_limited`, `transient`, `rejected` or `unknown_outcome`. `connectwise.ts:77-80` currently throws a plain Error that contains the raw body.
- Only `ConnectWiseProvider` implements the capability in W2. Five adapters already have `createTicket`/`updateTicket` (`autotask.ts:183,203`, `freshservice.ts:142,163`, `servicenow.ts:167,187`, `zendesk.ts:164,187`, `psa/index.ts:58,69`), but none has been tested against a live system. The UI shows the card only for a capable provider.
- The ConnectWise adapter switches from names to ids (`connectwise.ts:156-160`), and `externalUrl` changes from the API URL to the Manage UI ticket URL (`:89-95`; inferred).

**Settings (rule 9; OD6).**
- *Home*: Integrations → PSA → (connection) → "Alert tickets" card (`/integrations#psa`).
- *Level*: partner. No org override.
- *Resolver*: a single `resolveAlertTicketingConfig(connection)`, used by admission, the worker and the card's preview.
- *Count*: the alert → PSA ticket concept is configured in **0** places today. The only related setting is the API-only `ConnectWiseSettings.defaultBoardId` (`connectwise.ts:23-25`), and nothing calls the code that would read it. After W2 the concept is configured in **1** place. `defaultBoardId` is migrated into the card and removed, so the board is also configured in 1 place.
- *Storage*: `psa_connections.alert_ticketing jsonb` (NULL = off), validated by a per-provider Zod schema in `packages/shared/src/validators`, plus a `rev` bumped on every edit. It holds no credentials, because the `psa_connections` partner-wide SELECT branch exposes it to org sessions. Fields:
  - `enabled`, `boardId`, `openStatusId`, `closedStatusId`, `typeId?`
  - `priorityBySeverity`
  - `minSeverity`, `ruleIds?`, `monitorIds?`
  - `closeOnResolve` (default **off**, as #5238 proposes), `noteOnAcknowledge` (default off)
  - `hourlyCreateCap` (default 100)
  - `lookbackHours` (default 24)

**Admission.** This is the only place filters are applied.
- **Fast path.** A subscriber, `psa-alert-ticketing`, listens for `alert.triggered` (registered in `eventSubscribers.ts`, `EVENT_SUBSCRIBER_IDS` and its contract test, with a lazy import). It resolves partner → bound connection → config → filters, against the committed row. It inserts a mapping with `ON CONFLICT (connection_id, alert_id) DO NOTHING`, then enqueues a wake-up.
- **Repair path (correctness).** `jobs/psaTicketingReconciler.ts` runs every 2 min.
  - (a) It admits alerts that pass the filters, are `active` or `acknowledged`, were triggered after the later of `enabledAt` and `now - lookbackHours`, and have no mapping. This covers dropped events in `off` mode, or when the API was down.
  - (b) It wakes non-terminal mappings that are due, including those whose alert has since resolved or been acknowledged.
  - (c) It re-checks `skipped_no_company` rows whose org now has a link and whose alert is still open.
- **Other events.** `alert.acknowledged` and `alert.resolved` do **not** admit. They only wake an existing mapping, because their payloads lack the fields the filters need.
- **Manual.** In `external` mode, the alert page shows **"Create <PSA> ticket"** where the native button is hidden. It admits with `source='manual'`, bypasses the filters, requires `tickets:write`, and runs through `runAction`.

**Worker** (`psa-ticketing`, BullMQ; registered in `jobs/workerReadinessManifest.ts`). Jobs carry ids only, and close and note work runs at a higher priority than create.
- *Claim.* A short transaction CAS-claims the mapping with a lease token. The PSA call happens **outside** any transaction (#1105). `psaFetch` already applies `safeFetch` and a 20 s timeout (`psa/http.ts:5,48-56`). The result is written back by CAS on the lease token.
- *Create states*: `never_attempted`, then `create_in_flight`, then `created` or `create_outcome_unknown` or `rejected`.
  - Before the POST, the worker writes `create_in_flight` and a `create_snapshot`: the summary, description, company, board, status and priority, taken from the committed alert row and the pinned config.
  - The summary is `[SEV] title — hostname`, truncated to Manage's limit (inferred: 100 characters).
  - The description holds the message, device, site, org, the alert link and a marker line.
- *Resolve before create.* A skip (`skipped_resolved_before_create`) is allowed **only** from `never_attempted`. From `create_outcome_unknown` the worker first resolves the uncertainty, then closes whatever ticket it adopts.
- *Unknown outcome* (a timeout or crash after the POST).
  - The worker never re-POSTs on its own. It retries `findTicketsByMarker` with backoff for up to 2 h. For ConnectWise the marker is `externalXRef = breeze-alert:<alertId>`, an inferred field the plan verifies in a lab: is the field searchable, how soon, and is it unique?
  - One match: the worker adopts it.
  - Several matches: it adopts the oldest and records the rest for a human.
  - No match before the deadline: the mapping goes to `needs_attention`, with "Create anyway" and "Mark handled" actions.
  - The CAS fences database writes, not remote side effects. That is why a negative lookup is not treated as proof that the ticket was never created.
- *Close and note.* These are separate operations, each with its own `*_state`, attempts and deadline.
  - The acknowledgement note is posted at most once per mapping. A note whose outcome is unknown is never re-posted, and a late duplicate `alert.acknowledged` is a no-op.
  - If `closeOnResolve` is off, resolving the alert posts a note instead (no email to the customer).
- *Failure classes.*
  - `rate_limited` and `transient`: back off, honouring `Retry-After`. Create and note give up after about 24 h, close after 72 h.
  - `rejected` (validation 4xx): terminal, with the reason shown.
  - `auth` (401/403): **pauses** ticketing for the connection, recording `paused_reason`. A successful test-connection resumes it, and rows that were waiting resume too.
  - Every retry checks `next_attempt_at <= now()`.
  - After an outage longer than the deadlines, rows are `failed` and can be re-driven in bulk from the card.
- *Concurrency.* One call per connection at a time (a Redis lease). The hourly create cap is atomic across replicas (`INCR` on a Redis key per connection and hour). Above the cap, creates wait while closes continue, and one connection-health incident opens.
- *Company.*
  - The company comes from `organization_external_links` (the org, the connection's partner, `system = provider`), the key that company import writes (verified: `companyImport.ts:8-25`, `routes/psa.ts:1303-1323`).
  - No link gives `skipped_no_company` (**OD8**), which can be re-driven.
  - More than one link gives `skipped_ambiguous_company`.

**Surfacing.**
- *Connection health.* A new source, `psaTicketing` (`connectionHealth/sources/`; check `coverage.contract.test.ts`), opens a **partner** incident (`orgId: null`) on terminal failures, a pause, or a cap trip. Partner incidents do **not** emit `integration.health_opened` today (verified: `connectionHealth/events.ts:40-48` requires `orgId`). W2 does not promise a webhook for them; follow-up issue.
- *Card.* Counts by state, a failure list, and re-drive. It reuses `GET /psa/tickets` (`routes/psa.ts:1032-1098`) and renames the "Synced Tickets" card (#9947).
- *Alert page.* A chip shows the state, the PSA ticket number and a link, plus any W1b refs, through one read model, `GET /alerts/:id/external-tickets`.
- *Sentry.* `errorId` values (`PSA_ALERT_TICKET_CREATE_FAILED`, `…_OUTCOME_UNKNOWN`, `…_CLOSE_FAILED`, `…_AUTH_PAUSED`), tagged with connection, provider and partner, and never a PSA response body.
- *Audit.* Config changes, manual creates, re-drives, "Create anyway" and pause or resume.

**Granularity (settled).** One ticket per alert, plus the storm cap. Kept from #5238: one ticket per open alert; the ticket belongs to the alert's org; close-on-resolve defaults to off; a resolve adds a note, not an email. Its in-transaction advisory lock is replaced here by the unique index and the lease CAS, because the remote create cannot be part of a transaction. Aggregation and split are deferred.

## 4. Tenancy and data model impact

| Change | Wave | Shape | Registries (grep, don't judge) |
|---|---|---|---|
| `webhooks.payload_version` | W1 PR1 | unchanged | Export `included` (`tenantExportPolicyRegistry.ts:1116`) |
| `webhook_deliveries.payload_version`, `event_timestamp`, `replay_root_event_id`; new enum value `scheduled` on `webhook_delivery_status`, with `next_retry_at` authoritative | W1 PR1 | unchanged (no `org_id` yet) | none. The partial indexes (`schema/integrations.ts:118-128`) must cover `scheduled` too. `ALTER TYPE … ADD VALUE` cannot be used in the transaction that adds it (inferred), so the plan splits the migration. |
| `webhooks.partner_id` + XOR + one dual-axis policy, **no** partner-wide SELECT branch | W1 PR2 | dual-axis XOR | Add to `DUAL_AXIS_TENANT_TABLES` (`rls-coverage.integration.test.ts:565`). **Not** in `XOR_OWNERSHIP_DUAL_AXIS_TABLES`; add a rationale line to its exclusion comment, as `reports` did (`:1031-1037`). `PARTNER_WIDE_SELECT_BRANCH_EXEMPT` is shrink-only with ceiling 0 (`:1164-1176`). Export: `partner_id` → `included`. It is already in the cascade list (`tenantCascade.ts:1171`) and `REPOINT_TABLES` (`orgMergeRegistry.ts:1389`), which touch org rows only. Partner erasure reaches partner rows through the partner_id sweep, which already orders by FK (Codex, `tenantCascade.ts:2899`), and deliveries follow by `ON DELETE CASCADE`. |
| `webhook_deliveries.org_id` = the event's org | W1 PR2 | FK-child policy on the **parent's** ownership (org arm `w.org_id`, partner arm `w.partner_id`). `org_id` exists for erasure, merge and export, never for read authority. | **New** in `CORE_ORG_CASCADE_DELETE_ORDER` (`webhook_deliveries` sorts before `webhooks`, so children come first). `orgMergeRegistry`: `repoint`, which keeps an org webhook's deliveries on its owner; the stored payload stays a send-time snapshot. **Mandatory** entry in `ORG_AXIS_POLICY_EXCLUDED_TABLES` (`rls-coverage…:139`), keeping the FK-child entry (`:1244`), with behavioural tests of both parent arms. Export: `payload` → `excludedOpen`; `webhook_id` and `recovery_attempts` → `reviewedIncluded` (they match `webhook` and `recovery` in `SUSPICIOUS_NAME_PARTS`, `tenantExportPolicy.ts:42-62`); `response_body` and `error_message` → `excludedSensitive` (text supplied by the receiver); the rest `included`. **Write invariant**, a `BEFORE INSERT` trigger that also binds the system scope fan-out writes in: for an org webhook, `org_id = webhooks.org_id`; for a partner webhook, the org belongs to that partner; NULL only when `event_type = 'webhook.test'`. Backfill in ctid batches, with system scope and a ROW_COUNT warning. |
| `alerts.acknowledged_by_principal_id`, `resolved_by_principal_id` | W1b | Shape 1 table, new columns | `CORE_TENANT_EXPORT_POLICY.alerts` → `included`. A nullable column with no default is metadata-only (inferred). |
| `alert_external_refs` (`org_id`, `partner_id`, `partner_service_principal_id`, `alert_id`, `external_*`) | W1b | Shape 1; composite `(org_id, partner_id) → organizations` and `(principal_id, partner_id) → partner_service_principals`, both `DEFERRABLE INITIALLY IMMEDIATE` | Cascade list, `REPOINT_TABLES`, export (`all included`), RLS auto-discovered. **Device move within a partner**: the ref follows its alert's org (alerts are restamped: `CORE_DEVICE_ORG_DENORMALIZED_TABLES`, `routes/devices/core.ts:318-331`). Do this with a composite `(alert_id, org_id) → alerts(id, org_id) ON UPDATE CASCADE ON DELETE CASCADE`, which needs a new unique index on `alerts(id, org_id)` built `CONCURRENTLY` (there is none: `schema/alerts.ts:186-200`). **Cross-partner device move** (system scope only, `routes/devices/moveOrg.ts:165-170`): the device's refs are **deleted** before the restamp, because the principal belongs to the old partner. The plan registers this against `moveOrg.coverage.test.ts` and the merge contract. |
| `organization_external_links` export-watermark trigger | W1b | unchanged | none |
| `psa_connections.alert_ticketing jsonb` | W2 | dual-axis XOR, unchanged | Export `excludedOpen` (`tenantExportPolicyRegistry.ts:771`) |
| `psa_ticket_mappings`: `source`, `config_rev`, `create_state`, `close_state`, `note_state`, `attempts`, `next_attempt_at`, `deadline_at`, `lease_token`, `lease_until`, `last_error`, `last_error_class`, `create_snapshot jsonb`, `external_company_id`, `closed_at`; unique `(connection_id, alert_id) WHERE alert_id IS NOT NULL`; recreate the `alert_id` FK as `ON DELETE CASCADE` | W2 | **unchanged: follows its parent, no `org_id` (settled)** | Nothing new. It stays in `FOLLOWS_PARENT_NOTES` (`orgMergeRegistry.ts:76`) and in the erasure pre-clear (`tenantCascade.ts:1301-1320`). **The `ON DELETE CASCADE` change is required.** `alertService.ts:162` (publish rollback) and `subjectAlertOutbox.ts:126` delete alerts with no pre-clear, and would raise 23503 once W2 writes mappings (inferred from the FK having no `ON DELETE`, `schema/integrations.ts:165`). **Cross-partner device move**: delete the device's mappings, because the connection is partner-private; the remote ticket stays open in the old partner's PSA. **Deleting a connection** that has non-terminal mappings is blocked; terminal mappings are deleted with it (inferred: today the `connection_id` FK has no `ON DELETE`). Dedupe defensively, with a ROW_COUNT warning, before the unique index. |

**Why `psa_ticket_mappings` gets no `org_id`.**
- Its write anchor is the connection, and its read arms already cover the org of the alert and of the device (`2026-08-17-psa-connections-partner-ownership.sql`, step 3).
- Adding `org_id` next to `device_id` would make it a device-org-denormalized table, which brings an org-move disposition (#8634), the device lists and export classification.
- That is a lot of machinery for partner bookkeeping that holds no customer content. The read model filters to the mapping connection's partner, so org users never see another partner's mapping.

**Secrets.**
- Partner webhooks reuse `encryptSecret` (`routes/webhooks.ts:570-575`) and are decrypted only at send time (`webhookDelivery.ts:189-230`).
- No partner-wide SELECT branch means an org session cannot read the row at all.
- **Stated exception**: an org's tenant export includes partner-webhook delivery **metadata** about that org's own events, with `payload` excluded and response text excluded. Exports run by `org_id` in system context (Codex: `tenantExport.ts:144`). This is the org's own data, so it is allowed, and it is documented.

## 5. Out of scope

- Inbound PSA → Breeze sync. Middleware can resolve alerts through W1b. The `/sync` route stays 501. No Manage configuration linking.
- Auto-ticketing for Autotask, Halo, Jira, ServiceNow, Freshservice or Zendesk. Each needs its own lab run.
- Aggregation and split (#5238 items 5–6), and one ticket per correlation group.
- The native `ticket` notification channel and the `create_ticket` action (#5238 itself).
- Webhook payload templates, and resolve events for the notification-channel webhook sender.
- Implementing `alert.escalated`, and routing partner connection-health events (both follow-ups).
- Automatic company import (#7709).
- A fallback company (OD8).

## 6. Open Decisions

**OD1 — Can org sessions see partner webhooks?**
- (a) No partner-wide SELECT branch; the table is excluded with a rationale, following the `reports` precedent.
- (b) Add the branch and split `url`, `secret` and `headers` into a child table, following `notification_channel_configs` (#6379). Even then, delivery history stays exposed.

**Recommend (a).** Partner webhooks carry cross-org plumbing that belongs to the partner.

**OD2 — Payload versioning.**
- (a) Change payloads in place by adding fields, plus `schemaVersion`. Cheap, but a strict consumer breaks once.
- (b) A per-webhook `payload_version`: existing webhooks keep v1, new ones get v2, and owners upgrade on purpose.
- (c) New event names, which split subscriptions.

**Recommend (b).** Changed from (a) after the quorum: a webhook payload is a public contract, and the cost is one serializer branch.

**OD3 — `alert.escalated`.**
- (a) Reject new subscriptions and show a "never delivered" chip on stored ones. Follow-up issue to implement it.
- (b) Implement it now. There is no single publish point for it; escalation fires per channel and per user (`notificationDispatcher.ts:283-347,464-468`).

**Recommend (a).**

**OD4 — Retries.**
- (a) One fixed schedule of about 21 h with jitter, using Postgres-authoritative state and BullMQ delayed wake-ups.
- (b) A schedule configurable per webhook.

**Recommend (a).** The window is a product choice; Todd may pick its length.

**OD5 — Where an alert's external ticket ref lives.**
- (a) A principal-namespaced `alert_external_refs` table.
- (b) Two columns on `alerts`: one slot, so the last writer wins, and every write bumps the alerts feed.

**Recommend (a).**

**OD6 — Where W2 settings live.**
- (a) A `psa_connections.alert_ticketing` jsonb column with a `rev` and a per-provider schema.
- (b) A new typed table, one row per connection.

**Recommend (a).** The ids are provider-specific anyway.

**OD7 — Which connections may auto-ticket.**
- (a) Only the partner's bound connection, in `external` mode, with each mapping pinned when it is admitted.
- (b) Any partner-wide connection.

**Recommend (a).** There is one system of record, and pinning keeps a rebind from creating duplicates.

**OD8 — Org with no PSA company link.**
- (a) Skip and flag it. The row can be re-driven, and the reconciler re-checks it once a link appears.
- (b) Also offer an opt-in fallback company.

**Recommend (a) only; defer (b).** Changed after the quorum: a ticket on the wrong company can expose one customer's details to another.

**OD9 — Wave order.**
- (a) W1 → W1b → W2, as #10499 proposed. W1 is the literal "webhook or API" ask and works with any PSA.
- (b) W2 first, as a narrow native ConnectWise path, with W1 and W1b in parallel. This is Codex's suggestion; W2 has no runtime dependency on W1.

**Recommend (a) for release order, with W2 allowed to start in parallel.** The alert-page read model moves into whichever of W1b and W2 lands first.

## 7. Test and rollout notes

- **Red first** in every wave. Assert **remote side effects** (count the adapter's POSTs), not only rows.
- **W1 PR1**:
  - golden fixtures for v1, which must stay unchanged;
  - a v2 key, type and null contract;
  - the projection-isolation test (`orgExternalIds` is never sent to an org webhook, in either order);
  - enrichment failure degrades the payload instead of dropping it;
  - every retry claims its row, and an erased row stops a delayed job;
  - recovery re-drives `scheduled` rows that are past due, and still resolves an abandoned `retrying` row terminally;
  - draining the old list and ingesting the DLQ;
  - replay root survives a replay of a replay;
  - `webhookEventOptions.contract.test.ts` (adds `acknowledged` and `suppressed`; `escalated` returns 400).
- **W1 PR2**:
  - `webhooksPartnerRls.integration.test.ts`: a cross-partner forge fails with 42501, an XOR violation with 23514, an org session SELECTs 0 rows, and a restricted partner user is refused;
  - the delivery `org_id` trigger rejects a foreign org;
  - real-Postgres fan-out: the org event fires, holding and suspended orgs do not, and a departed org's queued retry is dropped;
  - the health source sees partner webhooks;
  - the `tenantCascade`, export-policy and `orgMergeRegistry` suites. These fail **only** under Integration Tests; a stacked PR must run `gh workflow run CI --ref <branch>`;
  - the full `orgMerge.test.ts` unit suite.
- **W1b**:
  - a 403 without the scope, and a 404 for an alert under another partner or out of reach;
  - acknowledge and resolve are idempotent;
  - **a principal resolve starts no verdict run** (red first);
  - `alertId` links the ticket in the same transaction;
  - the export-watermark trigger;
  - `alert_external_refs`: RLS, the device move within a partner, deletion on a cross-partner move, and merge.
- **W2**:
  - admission: filters, deduplication, the reconciler admits with dispatch `off`, and acknowledge and resolve never admit;
  - a fake adapter covering timeout → resolve → adopt; a slow POST that outlives its lease; a negative lookup ending in `needs_attention` with exactly one POST; a trigger rolled back; rebind or disable; a duplicate acknowledge after the note was sent; a resolve that lands while a job is completing; Redis loss; 429 `Retry-After`; an auth pause; the cap across two workers;
  - deleting an alert that has a mapping succeeds;
  - ConnectWise fixture tests;
  - **a lab run against a ConnectWise Manage developer instance before any partner enables it** (owed by Todd: needs credentials). It checks `externalXRef` search and consistency, status and priority ids, the UI URL, and the summary limit.
- **Rollout**:
  - W1 needs no env change for existing webhooks: v1 is unchanged, and the release notes cover v2 and the retry schedule. No wave depends on `EVENT_DISPATCH_MODE`.
  - W1b is opt-in by scope.
  - W2 is off per connection. The `psa-integrations.mdx:10-12,150-152` caution is rewritten (ConnectWise only).
  - Migration names sort after the newest on `origin/main` when the plan is written (`apps/api/migrations/README.md`).

## 8. Advisor quorum

Independent review: `codex exec`, model `gpt-6-astra`, effort xhigh, read-only. It ran against the first draft. Its verdict was "request changes before implementation". The full output is in the session scratchpad (`codex-10499.md`).

**Agreed, and accepted into this revision** (the load-bearing claims were re-verified in code):
- Dispatch is `off` by default and swallows handler errors. W2 now uses a ledger, a reconciler that reads committed state, and events only to wake it. Enrichment degrades instead of throwing. The "no env change" claim was corrected.
- Retries need state held durably in Postgres and a claim on every attempt (`webhookDeliveryRecord.ts:181`, `webhookDelivery.ts:565`). Erasure must stop delayed retries. Queue jobs carry ids only. A refinement from re-reading the code: Codex asked for a durable retry-wait state, and reusing `retrying` for it would be wrong, because that status already means "in flight, resolve terminally" (`webhookDeliveryRecovery.ts:77-87`). This revision therefore adds a new `scheduled` status.
- `webhook_deliveries` needs `ORG_AXIS_POLICY_EXCLUDED_TABLES`, a write-invariant trigger, and the correct export buckets (`webhook` and `recovery` are suspicious names).
- Org and partner projections are separate. Event types come from an allowlist. Enriched fields are an enrichment-time snapshot.
- Event time and the replay root are stored. Transport dedupe and ticket dedupe are kept separate.
- `externalTickets` cannot make middleware stateless, so a lookup endpoint was added.
- Unknown-outcome states, no automatic re-POST, separate operation states for close and note, and per-phase deadlines. An auth failure pauses the connection, and the cap is atomic.
- Partner health incidents publish no event (`connectionHealth/events.ts:40-48`), so that promise was removed.
- A cross-partner device move deletes refs and mappings. A mapping is pinned at admission. A rebind to a different instance needs company links re-confirmed.

**Disagreed: changed recommendations.** OD2 moved from (a) to (b): versioning is now per webhook. OD8 dropped the opt-in fallback company.

**Disagreed: still open.** OD9, wave order. Codex suggests shipping the native ConnectWise path first. This spec keeps W1 → W1b → W2 for release order and lets W2 start in parallel.

**Agreed as drafted:** OD1(a), OD3(a), OD4(a), OD5(a), OD6(a), OD7(a).
