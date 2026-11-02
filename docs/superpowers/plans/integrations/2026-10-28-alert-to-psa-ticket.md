---
title: Alert → PSA ticket (ConnectWise Manage) — implementation plan
issue: 10499
spec: docs/superpowers/specs/integrations/2026-10-28-alert-to-psa-ticket-spec.md
folds_in: [10500]
status: draft
date: 2026-10-28
base: main @ bd22427dfe
tracking_issue: LanternOps/breeze#10528
---

# Alert → PSA ticket Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MSP can turn Breeze alerts into PSA tickets: through partner-wide webhooks with a documented v2 alert payload and durable retries (W1), through Partner API write-back (W1b), and natively for ConnectWise Manage with close-on-resolve (W2).

**Architecture:** W1 enriches alert events once at webhook fan-out, persists each delivery's wire identity, and moves retries from a Redis list to Postgres state woken by BullMQ delayed jobs; then `webhooks` becomes org XOR partner. W1b adds `alerts:write`, principal attribution and a principal-namespaced `alert_external_refs` table. W2 treats `psa_ticket_mappings` as a ledger: a subscriber and a 2-minute reconciler admit alerts, and a leased BullMQ worker reconciles each mapping toward the committed alert row.

**Tech stack:** Hono, Drizzle (queries only), hand-written SQL migrations, BullMQ + Redis, Zod (`packages/shared`), Vitest, Astro + React islands.

**Spec:** `docs/superpowers/specs/integrations/2026-10-28-alert-to-psa-ticket-spec.md`. Gate A (2026-10-28) ruled every **Recommend** line for OD1–OD9. Executors read both.

Evidence: **verified** = read or grepped at `bd22427dfe` while writing this plan; **inferred** = reasoned, not run. Line numbers are hints; re-grep before editing.

## Wave map

| PR | Title | Size | Depends on | Migration | PR title / closes |
|---|---|---|---|---|---|
| W1-A | Alert payload v2, versioning, `alert.escalated` guard, docs (#10500) | M | — | yes | `feat(webhooks): alert payload v2 + per-webhook payload version (#10499)` / `Closes #<W1-A sub-issue>`, `Closes #10500` |
| W1-B | Durable webhook retries (~21 h, Postgres-authoritative) | M | W1-A | yes (enum split) | `feat(webhooks): durable retries over ~21 h, retire the Redis DLQ (#10499)` / `Closes #<W1-B sub-issue>` |
| W1-C | Partner-owned webhooks (Partner-Wide First) | L | W1-B | yes | `feat(webhooks): partner-wide webhooks (#10499)` / `Closes #<W1-C sub-issue>` |
| W1b-A | `alerts:write`: acknowledge/resolve with principal attribution | S | W1-A (soft) | yes | `feat(partner-api): alerts:write acknowledge and resolve (#10499)` / `Closes #<W1b-A sub-issue>` |
| W1b-B | `alert_external_refs`, `alertId` on ticket create, org external links in export | M | W1b-A | yes | `feat(partner-api): alert external ticket refs + alertId on ticket create (#10499)` / `Closes #<W1b-B sub-issue>` |
| LAB | ConnectWise Manage developer-instance lab | gate | owner creds | no | records results on #10499; no PR |
| W2-A | PSA alert-ticketing data model, ConnectWise capability, config API | M | LAB (before merge) | yes | `feat(psa): alert ticketing config + ConnectWise ticket capability (#10499)` / `Closes #<W2-A sub-issue>` |
| W2-B | Admission, reconciler, leased worker, health source | L | W2-A | no | `feat(psa): native alert → ConnectWise ticket worker (#10499)` / `Closes #<W2-B sub-issue>` |
| W2-C | Alert-tickets card, alert-page chip, manual create, docs | M | W2-B; W1b-B or its Task E3 | no | `feat(psa): alert tickets card and alert-page ticket chip (#10499)` / `Closes #<W2-C sub-issue>` |

Release order is W1 → W1b → W2 (OD9). W2 may be built in parallel from W2-A onward; W2-A only merges after LAB. Each PR targets `main` and is mergeable alone: W1-A ships v2 to org webhooks; W1-B changes only retry behaviour; W1-C adds a new owner; W1b-A/B are opt-in by scope; W2-A is dark (nothing admits); W2-B auto-tickets only for a connection whose config was set through the W2-A API.

## Global constraints

- Migrations: hand-written, idempotent, no inner `BEGIN;`/`COMMIT;`; any file that writes rows starts with `SELECT set_config('breeze.scope', 'system', true);` (inside the `DO` block in a `-- @no-transaction` file); cleanup writes report `ROW_COUNT` via `RAISE WARNING`; never edit or rename a shipped migration. Then `pnpm db:migrate && pnpm db:check-drift`.
- Slots (verified: newest on `origin/main` is `2027-01-10-110000-pam-user-notify-capability.sql`; `2027-01-09`–`01-11` reserved for other work). If a later migration lands on `main` first, the pre-push hook fails: rename **your unshipped** file to sort last, never a shipped one.
- RLS ships in the same file that creates or re-shapes a tenant table. Composite FKs referencing `org_id` are `DEFERRABLE INITIALLY IMMEDIATE`.
- No partner-wide SELECT branch on `webhooks` (OD1). Partner rows are readable only with `canManagePartnerWidePolicies` (`services/partnerWideAccess.ts:25`, verified).
- v1 webhook payloads stay byte-for-byte identical (OD2). Existing webhooks stay `payload_version = 1`; new and partner webhooks default to 2.
- Retry schedule (OD4): 1 m, 5 m, 30 m, 2 h, 6 h, 12 h, ±20 % jitter, then terminal `failed`. `retry_policy` stays unused.
- `alerts:write` is opt-in and never in a default scope set.
- W2: only the partner's bound connection in `external` mode (OD7); no company link → `skipped_no_company`, no fallback company (OD8); `closeOnResolve` and `noteOnAcknowledge` default off; `hourlyCreateCap` 100; `lookbackHours` 24.
- Web mutations go through `runAction`; new `en` keys go to all 8 locales (`en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`); Sentry tags never carry a PSA or receiver response body.

## Review focus

These five are implied by the spec but no spec test covers them. Each has a test in the task named.

1. **An alert with no device** (topology or monitor alerts): `deviceHostname`, `siteId` and `siteName` are `null` in v2, and the W2 summary is `[SEV] title` with no trailing ` — `. Tests: W1-A Task A2, W2-A Task F4.
2. **`DASHBOARD_URL` unset** on a self-hosted install: `alertUrl` is still a string, the relative `/alerts/<id>`, and one warning is logged per process. It is never `"undefined/alerts/…"`. Test: W1-A Task A2.
3. **Summary truncation on non-ASCII titles**: the summary is cut by code point to the LAB-recorded limit (default 100), never splits a surrogate pair, and ends with `…`. Test: W2-A Task F4.
4. **The webhook version changes while retries are pending**: a `scheduled` delivery recorded at v1 is retried as v1 after the owner upgrades to v2, because the version is pinned per delivery. Test: W1-B Task B2.
5. **A BullMQ wake-up that runs early** (clock skew between worker and DB, or a manual promote): the CAS rejects it (`next_retry_at > now()`), the job re-enqueues itself for the remaining delay, and the row is never left without a wake-up. Test: W1-B Task B2.

## Spec deviations (spec unchanged; recorded here)

1. **Verdict subscriber path.** The spec cites `alertVerdictSubscriber.ts:48` at the services root. The file is `apps/api/src/services/aiAgents/alertVerdictSubscriber.ts` (verified).
2. **https-only external URL.** The #7181 validator `externalTicketUrlSchema` (`packages/shared/src/validators/tickets.ts:56`) accepts `http` or `https` (verified). The spec requires https and says "reuse". W1b-B adds `alertExternalTicketUrlSchema = externalTicketUrlSchema.refine(https)` and leaves ticket refs unchanged.
3. **A static shared-secret header already exists.** Webhooks already support `authType: 'bearer'`, stored as an encrypted `Authorization` header, plus encrypted custom headers (#9652; `routes/webhooks.bearerAuth.test.ts`, `WebhookForm.tsx:16-20`, verified). W1-A therefore adds no new auth mechanism. The Rewst check (Task A0) only decides what the docs recommend.
4. **The webhook health source must follow the new schedule.** `connectionHealth/sources/webhook.ts:39,56-59` defines "terminal" as `attempts >= retry_policy.maxRetries` (default 5) (verified). After W1-B only the final attempt writes `failed`, so the predicate becomes `status = 'failed'`. The spec does not mention this. It is in W1-B.
5. **v2 keys are complete from W1-A.** `externalTickets` (always `[]`) and `acknowledgedByPrincipalId`/`resolvedByPrincipalId` (always `null`) ship in W1-A so the frozen key set never changes. W1b and W2 then fill them in. The spec says the principal fields are "added in W1b". This plan reads that as "populated in W1b".
6. **W2 runtime state lives in columns.** The spec stores `rev` with the `alert_ticketing` jsonb. This plan uses columns: `alert_ticketing_rev` (for CAS), `alert_ticketing_enabled_at` (the reconciler's lookback floor), and `alert_ticketing_paused_reason`/`_paused_at` (the auth pause), so runtime state never lives in the user-edited jsonb. Config pinning: a mapping records `config_rev` at admission. The create uses the config current at create time and writes it into `create_snapshot` (including `closedStatusId`, `closeOnResolve`, `noteOnAcknowledge`). Close and note then follow the snapshot. Old revisions are not stored.
7. **The W1 PR split.** The spec has two W1 PRs. Its PR1 (payload v2 plus durable retries) is larger than L, so it is split into W1-A and W1-B. W1b and W2 are split for the same reason.
8. **Dead web code.** The spec asks the plan to check `apps/web/src/components/integrations/Webhook{Editor,List,TestPanel}.tsx`. The only reference is `components/integrations/index.ts`, a barrel that nothing imports (verified by `rg`). W1-C deletes the three files and their barrel lines.
9. **`alert_external_refs` cannot be registered in `moveOrg.coverage.test.ts`.** The spec asks for it, but that test discovers device-scoped tables, and this table has no `device_id` (verified, header of `routes/devices/moveOrg.coverage.test.ts`). The move behaviour is proven instead by `alertExternalRefsOrgMove.integration.test.ts` (precedent: `ticketExternalRefsOrgMove.integration.test.ts`) and by the merge contract (`orgLifecycleFoundations.integration`).

## CI traps (apply to every PR)

- A stacked PR (base ≠ `main`) runs **no** CI. Before merging, run `gh workflow run CI --ref <branch>`.
- `pnpm test` skips the contract suites. Bring up `pnpm test-stack up` (and run `pnpm test-stack down` afterwards), then run:
  - integration: `cd apps/api && npx vitest run --config vitest.integration.config.ts <file>`
  - RLS coverage: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`
  - session-context: `pnpm --filter=@breeze/api test:rls`
  - never `pnpm --filter … test -- --run`; vitest path filters are substring matches.
- Which job catches what (verified in `.github/workflows/ci.yml`):
  - **Test API:** `orgMerge.test.ts` (full suite only), `moveOrg.coverage`, `cascadeDelete`, `migrationRlsScope`, `autoMigrate`, `migrationPartnerExportLocks`, `partnerServicePrincipalScopes` (TS↔SQL scope parity), `eventSubscribers.contract`, `workerReadinessManifest`, `parkedFanout.contract`, `connectionHealth/sources/coverage.contract`, and the integration-suite coverage contract (every new `*.integration.test.ts` must be in the config).
  - **Integration Tests (16 shards):** `tenantCascade*`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `orgMergeRegistry`, `orgLifecycleFoundations` (deferrable FKs), `rls-coverage`.
  - **Lint:** `pnpm db:check-drift`, and `.github/scripts/ci-area-gating.test.mjs`. That second check needs any new test that reads another area's files (for example an API test reading `apps/docs/**`) listed in its cross-area scan.
- New `apps/api/src/services/**` or `jobs/**` files: run `parkedFanout.contract.test.ts`, and classify any file it discovers.
- Partner API changes update `docs/integrations/partner-api.md` and `apps/docs/src/content/docs/reference/api.mdx`. `openapi.ts` does not cover `/partner-api` (verified, `:26`), so there is no OpenAPI work for those routes.
- Local API `tsc` OOMs. CI runs `pnpm exec tsc --build apps/api/tsconfig.tests.json` (Typecheck job). Locally use `NODE_OPTIONS=--max-old-space-size=12288` and check the exit code; do not pipe to `tail`. Web: `cd apps/web && pnpm exec astro check`.
- Locale keys: add to all 8 locales. `apps/web/src/lib/i18n/localeParity.test.ts` and `apps/api/src/i18n/localeParity.test.ts` enforce parity. After adding or removing keys, re-run `apps/web/src/locales/humanizedKeyRegression.test.ts` and update `humanizedKeyBaseline.json` only for removed keys.
- Web mutations use `runAction` (`apps/web/src/lib/runAction.ts`), enforced by `no-silent-mutations.test.ts`.
- `docs/release-notes/next-release-draft.md` is a merge-queue conflict hot spot. Append under one heading, `### Alert → PSA ticket (#10499)`, and never edit other entries.

## Registry checklist (grep, don't judge)

| Table / column | PR | `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts:257`) | `orgMergeRegistry.ts` | `CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts`) | RLS lists (`rls-coverage.integration.test.ts`) | Device / ticket lists |
|---|---|---|---|---|---|---|
| `webhooks.payload_version` | W1-A | already (`:1171`) | already `REPOINT_TABLES` (`:1389`) | `included` (`:1116`) | — | — |
| `webhook_deliveries.payload_version`, `event_timestamp`, `replay_root_event_id`; `scheduled` | W1-A/B | n/a (no `org_id` yet) | n/a | n/a | — | — |
| `webhooks.partner_id` + XOR | W1-C | unchanged | unchanged | `partner_id` → `included` | add to `DUAL_AXIS_TENANT_TABLES` (`:565`). **Not** in `XOR_OWNERSHIP_DUAL_AXIS_TABLES` (`:1038`); add a rationale paragraph to its exclusion comment next to `reports` (`:1030-1036`) | — |
| `webhook_deliveries.org_id` | W1-C | **add** `'webhook_deliveries'` (sorts before `'webhooks'`) | **add** to `REPOINT_TABLES` | **new** entry. `included`: `id, org_id, event_type, event_id, status, attempts, next_retry_at, response_status, response_time_ms, created_at, delivered_at, payload_version, event_timestamp, replay_root_event_id`; `reviewedIncluded`: `webhook_id, recovery_attempts`; `excludedSensitive`: `response_body, error_message`; `excludedOpen`: `payload` | **add** to `ORG_AXIS_POLICY_EXCLUDED_TABLES` (`:139`), keeping the FK-child entry (`:1244`) | — |
| `alerts.acknowledged_by_principal_id`, `resolved_by_principal_id` | W1b-A | already | already | both `included` (`"alerts"` at `:213`) | — | — |
| `alert_external_refs` | W1b-B | **add** (alphabetical) | **add** to `REPOINT_TABLES` | **new** entry, all columns `included` | Shape 1 (auto-discovered) | no `device_id`, so no device list; delete-on-cross-partner in `moveDeviceOrgInTransaction.ts` (deviation 9) |
| `psa_connections.alert_ticketing` (+ `_rev`, `_enabled_at`, `_paused_reason`, `_paused_at`) | W2-A | already | already | `alert_ticketing` → `excludedOpen`; the four scalars → `included` (`:771`) | unchanged | — |
| `psa_ticket_mappings` columns, unique, FK | W2-A | none (no `org_id`; pre-clear stays at `tenantCascade.ts:1313`) | stays in `FOLLOWS_PARENT_NOTES` (`:76`) | none | unchanged | stays in `INTENTIONALLY_NO_ORG_ID` (`moveOrg.coverage.test.ts:99`) |

---

## W1-A — Alert payload v2, versioning, `alert.escalated` guard, docs

**Migration** `apps/api/migrations/2027-01-12-100000-webhook-payload-version.sql` (writes no rows):
- `webhooks.payload_version smallint NOT NULL DEFAULT 1` plus `CHECK (payload_version IN (1,2))`, then `ALTER COLUMN payload_version SET DEFAULT 2`. Existing rows read 1 and new rows get 2, with no backfill.
- `webhook_deliveries.payload_version smallint NOT NULL DEFAULT 1`, `event_timestamp timestamptz NULL`, `replay_root_event_id varchar(100) NULL`.

Mirror all of it in `db/schema/integrations.ts`.

### Task A0: Rewst consumer check (owner question)
- [ ] Ask Todd on #10499: **"Can the prospect's Rewst webhook trigger verify `X-Breeze-Signature: sha256=HMAC(secret, X-Breeze-Signature-Timestamp + "." + body)`? If not, can it check a static header value (`Authorization: Bearer …` or a named custom header)?"**
- [ ] Record the answer on the issue. HMAC works → the Task A5 worked example uses HMAC. Static header only → it uses the existing bearer auth (deviation 3) and nothing new is built. Neither → open a follow-up issue; do not block W1-A.

### Task A1: v1 golden fixtures (red-first guard)
**Files:** create `apps/api/src/workers/__fixtures__/webhookV1/*.json`, `apps/api/src/workers/webhookEnvelope.v1.golden.test.ts`.
- [ ] Capture `data` exactly as today's producers emit it:
  - `alert.triggered` (`services/alertService.ts:344-362`)
  - `alert.resolved` (`:935-948`)
  - `alert.acknowledged` (`routes/alerts/alerts.ts:973-983`)
  - `alert.suppressed` (`:1190`)
  - one non-alert event
- [ ] Assert that `buildWebhookEnvelope({version:1,…})` output is byte-identical to the JSON today's `deliverWebhook` builds (`workers/webhookDelivery.ts:268-274`). It fails until A3 exists.

### Task A2: v2 contract and enrichment
**Files:** create `apps/api/src/services/webhookPayload/alertV2.ts`, `alertEnrichment.ts`, `alertEnrichment.test.ts`, `alertV2.contract.test.ts`.

**Interfaces (produces):**
- `ALERT_V2_EVENT_TYPES = ['alert.triggered','alert.acknowledged','alert.resolved','alert.suppressed'] as const` (an allowlist, never a prefix match)
- `alertWebhookDataV2Schema` (strict Zod) and `type AlertWebhookDataV2`
- `type AlertWebhookDataV2Partner = AlertWebhookDataV2 & { orgExternalIds: { system: string; externalId: string }[] }`
- `buildAlertWebhookProjections(event: BreezeEvent): Promise<{ org: Readonly<AlertWebhookDataV2>; partner: Readonly<AlertWebhookDataV2Partner> }>`, which never throws
- `alertWebhookUrl(alertId: string): string`

- [ ] **Red: `alertV2.contract.test.ts`.**
  - Freezes every key in spec §3's table, plus every v1 key (`subjectKey`, `responsesOwner`, `resolutionNote`, `resolvedBy`, `resolutionReason`, the monitor fields), with its type and its nullability (null vs absent).
  - Fails on any removal or retype.
  - `externalTickets` is `[]` and both principal ids are `null` (deviation 5).
- [ ] **Red: `alertEnrichment.test.ts`.**
  - `status` comes from the event type.
  - `resolvedAt`/`triggeredAt` come from the payload over the row; the row is never re-read for state.
  - A device-less alert gives `deviceHostname/siteId/siteName = null` (Review 1).
  - With `DASHBOARD_URL` unset, `alertUrl === '/alerts/<id>'` and exactly one `console.warn` (Review 2).
  - A DB throw gives `enrichmentIncomplete: true`, nulls in the enriched fields, Sentry called with `errorId: 'WEBHOOK_ALERT_ENRICHMENT_FAILED'`, and no throw.
  - `org` has no `orgExternalIds` key.
  - Mutating `partner` never changes `org`, in either build order.
- [ ] **Green.**
  - One read under `runWithSystemDbAccess`: alert ⋈ device ⋈ site ⋈ org, filtered by `event.orgId`.
  - `organization_external_links` filtered by `(org_id, partner_id = org's partner)` for the partner projection.
  - `Object.freeze` both projections.
- [ ] Run both test files in `apps/api` → PASS. Commit.

### Task A3: Envelope, fan-out branch, persisted wire identity
**Files:** create `apps/api/src/services/webhookPayload/envelope.ts`, `envelope.test.ts`. Modify `workers/webhookDelivery.ts` (`handleWebhookFanoutEvent` `:873`, `deliverWebhook` `:233-293`), `services/webhookDeliveryRecord.ts` (`recordWebhookDelivery` `:94`), `services/webhookFanoutDeps.ts` (select `payloadVersion`), `services/webhookConfig.ts`, `jobs/webhookDeliveryRecovery.ts` (`:417-423`), `routes/webhooks.ts` (manual retry `~:999`).

**Interfaces:**
- `buildWebhookEnvelope(input: { version: 1 | 2; id: string; type: string; orgId: string | null; timestamp: string; data: unknown; replayOf: string | null }): string`
- v2 is `{id,type,timestamp,orgId,schemaVersion:2,replayOf,data}`. The HMAC input is unchanged.

- [ ] **Red: `envelope.test.ts`.** The v2 key order and `schemaVersion: 2`; the v1 path equals the A1 golden fixtures.
- [ ] **Red: `webhookDelivery.test.ts`, `webhookDeliveryRecovery.test.ts`, `routes/webhooks.test.ts`.**
  - Enrichment runs only after at least one v2 target matched, and only for `ALERT_V2_EVENT_TYPES` (`alert.correlation_group.created` is never enriched).
  - The delivery row stores `payload_version`, the version's `data` as `payload`, `event_timestamp` and `replay_root_event_id`.
  - Recovery rebuilds `metadata.timestamp` from `event_timestamp`, falling back to `created_at` only for legacy NULL rows.
  - A manual retry sends `X-Breeze-Replay-Of: <root>`, and a retry of a retry keeps the original root.
- [ ] **Green.** Enrichment happens once per event. Retries and recovery send the stored `payload` and never re-enrich. Run the tests → PASS. Commit.

### Task A4: `alert.escalated` deny-list, event options, version selector
**Files:**
- `routes/webhooks.ts`: `NEVER_PUBLISHED` next to `PUBLISHED_EVENT_TYPES` at `:370`; create and update return 400; the update schema accepts `payloadVersion: 1 | 2`.
- `routes/webhookEventOptions.contract.test.ts`
- `apps/web/src/components/webhooks/WebhookForm.tsx` (`:61-62`) and `WebhooksPage.tsx`
- web tests in `components/webhooks/`
- locales ×8

- [ ] **Red.**
  - The contract test asserts the form offers `alert.acknowledged` and `alert.suppressed`.
  - `alert.escalated` ∈ `NEVER_PUBLISHED`, and create/update with it → 400.
  - A stored `alert.escalated` renders a "never delivered" chip, and saving the form drops it.
  - A webhook subscribed **only** to it shows a warning banner.
  - The version selector defaults to v2 on create and shows the current value on edit.
- [ ] **Green.** Mutations go through the existing `runAction` calls. Run the API contract test and `cd apps/web && npx vitest run src/components/webhooks` → PASS. Commit.
- [ ] Open the follow-up issue "implement `alert.escalated`", referencing `notificationDispatcher.ts:283-347`.

### Task A5: Docs (closes #10500) and release note
**Files:**
- `apps/docs/src/content/docs/features/webhooks.mdx`:
  - remove `alert.escalated` from the examples (`:27`, `:42`) and from the table (`:92`);
  - add per-event v1/v2 `data` tables and the versioning rule;
  - add replay and dedupe guidance (dedupe transport on the root event id; tickets on `alertId` plus the consumer's own state);
  - check that the HMAC section (`:323-360`) names `X-Breeze-Signature-Timestamp` as the signed timestamp;
  - add the worked example "alert → ConnectWise Manage via middleware", in the shape Task A0 decided.
- `docs/release-notes/next-release-draft.md`
- [ ] Commit.

**W1-A exit:** the golden, contract, enrichment, envelope and webhook route/web tests pass; drift is clean; the API typecheck (tests config) and `astro check` are green. **CI:** Test API, Test Web, Lint (drift), Typecheck.

---

## W1-B — Durable webhook retries

**Migrations:**
- `2027-01-12-110000-webhook-delivery-scheduled-enum.sql`: only `ALTER TYPE webhook_delivery_status ADD VALUE IF NOT EXISTS 'scheduled'`, guarded the way `2027-01-10-100000-pam-elevation-withdrawn-enum.sql` is. It writes no rows.
- `2027-01-12-110100-webhook-delivery-scheduled-indexes.sql`, starting with `-- @no-transaction` (the precedent is `2026-12-30-120100-connection-health-w4-indexes.sql`):
  - `CREATE INDEX CONCURRENTLY IF NOT EXISTS webhook_deliveries_unresolved_v2_idx ON webhook_deliveries (created_at) WHERE status IN ('pending','retrying','scheduled')`, then drop the old `webhook_deliveries_unresolved_idx`;
  - `webhook_deliveries_scheduled_due_idx ON (next_retry_at) WHERE status = 'scheduled'`.
  - Update both index definitions in `schema/integrations.ts:118-128`.

### Task B1: Schedule
**Files:** create `apps/api/src/services/webhookRetrySchedule.ts` and its `.test.ts`.

**Interface:**
- `WEBHOOK_RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000]`
- `WEBHOOK_MAX_ATTEMPTS = 7`
- `nextWebhookRetryAt(attemptsMade: number, now: Date, random: () => number = Math.random): Date | null`, where `null` means terminal

- [ ] **Red.** Attempt 1 → now + 60 s ±20 %, and so on through attempt 6; attempt 7 → `null`; the jitter bounds hold at `random = 0` and `random = 1`; `retry_policy` is ignored.
- [ ] **Green.** Run → PASS. Commit.

### Task B2: Claim every attempt, BullMQ wake-ups, recovery
**Files:**
- create `apps/api/src/jobs/webhookDeliveryQueue.ts` (BullMQ queue `webhook-delivery`; follow the `Queue`/`Worker` pattern in `jobs/webhookDeliveryRecovery.ts:504`) and its test;
- modify `workers/webhookDelivery.ts` (drop the `job.attempts === 0` claim guard at `:563-570`, drop `brpop`/`lpush`), `services/webhookDeliveryRecord.ts` (`buildExecutionClaimCas` `:56`, `recordDeliveryOutcome` `:180`), `jobs/webhookDeliveryRecovery.ts`, `services/workerRegistry.ts`, `jobs/workerReadinessManifest.ts` (`:69`).

**Interface:** `enqueueWebhookAttempt(job: { deliveryId: string; webhookId: string; generation: number }, runAt: Date): Promise<void>`. The jobId is `${deliveryId}:${attemptsMade}`; payloads carry ids only.

- [ ] **Red: `webhookDelivery.claim.test.ts`, `.lifecycle.test.ts`, `webhookDeliveryRecord.sql.test.ts`, `webhookDeliveryRecovery.sql.test.ts`.**
  - The claim SQL is `status IN ('pending','scheduled') AND (next_retry_at IS NULL OR next_retry_at <= now())` → `retrying`, applied on every attempt.
  - A failed non-final attempt writes `scheduled`, `attempts` and `next_retry_at`, and enqueues a wake-up. Only attempt 7 writes `failed`.
  - The lifecycle check drops the job when the webhook is inactive or the generation changed.
  - A missing row (erased org) → drop, no POST.
  - An early wake (`next_retry_at` in the future) → re-enqueue for the remaining delay with no claim (Review 5).
  - A `scheduled` row pinned to v1 is sent as v1 after the webhook moved to v2 (Review 4).
  - Recovery re-drives past-due `scheduled` rows and still resolves abandoned `retrying` rows terminally (`webhookDeliveryRecovery.ts:77-87`).
- [ ] **Green.** Run the five files → PASS.
- [ ] Integration: `__tests__/integration/webhookDeliveryRecovery.integration.test.ts` gains "a past-due scheduled row is re-driven exactly once". Commit.

### Task B3: Cut-over, health predicate, docs
**Files:**
- create `apps/api/src/jobs/webhookLegacyQueueCutover.ts` + test: `drainLegacyWebhookQueues(): Promise<{ drained: number; dlqIngested: number; dlqDropped: number }>`, run once from `initializeWebhookDelivery` (`webhookDelivery.ts:978`);
- remove `WEBHOOK_DLQ`, `getDeadLetterQueue`, `retryFromDLQ` and `clearDLQ` (`:37`, `:713-760`; no route callers, verified);
- `services/connectionHealth/sources/webhook.ts` and `webhook.test.ts` (deviation 4);
- `webhooks.mdx` (`## Retry Logic` `:253`, `### Custom Retry Policy` `:281`, `### Dead Letter Queue` `:294`);
- release-notes draft.

- [ ] **Red.**
  - Cut-over: legacy list entries are re-driven through `enqueueWebhookAttempt` by delivery id.
  - DLQ entries with a backing webhook become `failed` rows (manual retry works); the rest are dropped; counts are logged.
  - Running it twice is a no-op.
  - Health: one `scheduled` failure opens no incident, and a `failed` row does.
- [ ] **Green.** Release note: no env change; retries now span about 21 h; the old Redis keys are drained on first boot. Run → PASS. Commit.

**W1-B exit:** all of the above pass, and a manual retry (`routes/webhooks.ts:956-1070`) still works on a `failed` row. **CI:** Test API, Integration Tests (recovery), Lint.

---

## W1-C — Partner-owned webhooks (Partner-Wide First)

**Migrations:**
- `2027-01-13-100000-webhooks-partner-ownership.sql`. The template is `2026-08-17-psa-connections-partner-ownership.sql`, and this file writes no rows.
  - `webhooks.partner_id uuid REFERENCES partners(id)`
  - `org_id DROP NOT NULL`
  - `webhooks_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL))`
  - `webhooks_partner_active_idx ON (partner_id) WHERE status = 'active'`
  - Drop the per-command org policies and create one `webhooks_isolation`: `system OR (org_id IS NOT NULL AND breeze_has_org_access(org_id)) OR (partner_id IS NOT NULL AND breeze_has_partner_access(partner_id))`. There is no SELECT-only branch.
  - `webhook_deliveries.org_id uuid NULL REFERENCES organizations(id)`.
  - Rewrite the `webhook_deliveries` policy as an `EXISTS` over `webhooks w` with both arms (`w.org_id` / `w.partner_id`).
  - Add the `BEFORE INSERT` trigger `webhook_deliveries_org_guard`, `SECURITY DEFINER`, which reads `webhooks` past RLS:
    - org webhook → `NEW.org_id = w.org_id`;
    - partner webhook → `NEW.org_id IN (SELECT id FROM organizations WHERE partner_id = w.partner_id)`;
    - `NULL` only when `NEW.event_type = 'webhook.test'`;
    - anything else → `RAISE EXCEPTION … USING ERRCODE = '23514'`.
- `2027-01-13-100100-webhook-deliveries-org-id-backfill.sql`:
  - `set_config` first;
  - a `DO` loop of `UPDATE … SET org_id = w.org_id FROM webhooks w WHERE ctid IN (SELECT ctid … WHERE org_id IS NULL LIMIT 10000)`, accumulating `ROW_COUNT` into a `RAISE WARNING`;
  - then `CHECK (org_id IS NOT NULL OR event_type = 'webhook.test') NOT VALID` and `VALIDATE CONSTRAINT`.
  - Check `migrationPartnerExportLocks.test.ts`; `webhook_deliveries` carries no export triggers (inferred).
- `2027-01-13-100200-webhook-deliveries-org-id-index.sql`: `-- @no-transaction`, `CREATE INDEX CONCURRENTLY IF NOT EXISTS webhook_deliveries_org_idx ON webhook_deliveries (org_id)`, for erasure by `org_id`.

**Playbook mapping** (`docs/agents/tenancy-rls.md`):

| Step | Where |
|---|---|
| 1 Migration | the files above + Task C1 |
| 2 Writes: `ownerScope`; `partner` needs `canManagePartnerWidePolicies`; org rows keep `canMutateOrgWideGovernance` (`routes/webhooks.ts:528,639`); update `.omit({ ownerScope: true })`; audit via an `auditOwnerFields`-style helper (`routes/psa.ts:210`) | Task C2 |
| 3 Reads: app layer only (no SELECT branch, OD1); partner rows and their deliveries/test/retry need partner or system scope **and** `canManagePartnerWidePolicies` | Task C2 |
| 4 Config-policy linkage | not applicable |
| 5 Fan-out by the event org's partner via `partnerFanoutOrgCondition()` (`services/partnerFanoutOrgs.ts:50`; precedent `services/flows/eventTrigger.ts:155-167`) | Task C3 |
| 6 Tests + UI (`webhooksPartnerRls.integration.test.ts`, create-only owner selector, "All organizations" badge, pattern `components/software/PolicyForm.tsx`) | Tasks C1, C5 |
| 7 Repo-wide `webhooks.orgId` sweep | Task C4 |

### Task C1: Migration + RLS + registries
**Files:** the three migrations; `db/schema/integrations.ts`; `services/tenantCascade.ts`, `services/orgMergeRegistry.ts`, `services/tenantExportPolicyRegistry.ts` and `__tests__/integration/rls-coverage.integration.test.ts`, as the registry checklist says; create `__tests__/integration/webhooksPartnerRls.integration.test.ts` (template: `reportsPartnerRls.integration.test.ts`).
- [ ] **Red: `webhooksPartnerRls`.**
  - A cross-partner insert forge → 42501.
  - Both or neither owner → 23514.
  - An org session SELECTs 0 partner webhooks and 0 of their deliveries.
  - A partner session sees its own and never another partner's.
  - The delivery trigger rejects a foreign org (23514) and accepts a `webhook.test` NULL.
  - Org erasure deletes that org's rows on a partner webhook and leaves other orgs' rows. Partner erasure removes partner webhooks and, by `ON DELETE CASCADE`, their deliveries (extend `tenantCascadePartner.integration.test.ts`).
- [ ] **Green.** Run it plus `rls-coverage`, `tenantCascade.integration`, `tenant-export-policy.integration`, `tenantExportErasureRoundtrip.integration`, `orgMergeRegistry.integration`, and the full `cd apps/api && npx vitest run src/services/orgMerge.test.ts src/jobs/orgMerge.test.ts src/routes/orgMerge.test.ts`. Commit.

### Task C2: Routes
**Files:** `routes/webhooks.ts`: rename `getWebhookWithOrgCheck` (`:269-285`) to `getWebhookWithOwnerCheck(auth, id)`; list (`:449-517`); create (`:533-588`); update; deliveries/test/retry (`:784-1068`). Tests: `routes/webhooks.partnerOwner.test.ts`.
- [ ] **Red.**
  - A partner create without `orgAccess = 'all'` → 403 with `PARTNER_WIDE_WRITE_DENIED_MESSAGE`.
  - A partner webhook defaults to `payload_version = 2`.
  - An org user and a restricted partner user get 404 on GET, deliveries, test and retry of a partner webhook, and it is absent from their list.
  - `ownerScope` on PATCH → 400.
  - A partner test send carries `orgId: null`.
  - The audit row has `org_id` NULL and the partner id set.
- [ ] **Green.** Secrets reuse `encryptSecret` (`:572-573`). Run → PASS. Commit.

### Task C3: Fan-out, projection, send-time lifecycle
**Files:** `services/webhookFanoutDeps.ts` (`:29-62`), `workers/webhookDelivery.ts` (`WebhookFanoutTarget` gains `partnerId: string | null`; `orgId: string | null`), and the claim lifecycle check from B2. Create `__tests__/integration/webhookPartnerFanout.integration.test.ts`.
- [ ] **Red (real Postgres).**
  - The predicate is `org_id = :org OR (org_id IS NULL AND partner_id IN (SELECT partner_id FROM organizations WHERE id = :org AND <partnerFanoutOrgCondition>))`.
  - An active org's event reaches the partner webhook; holding, quick-support, soft-deleted and suspended orgs do not.
  - The partner target gets the partner projection (`orgExternalIds`), and the org target in the same fan-out does not.
  - A queued retry for an org that has since moved to another partner is dropped at claim.
- [ ] **Green.** Delivery rows are written with `org_id = event.orgId`. Run → PASS. Commit.

### Task C4: `webhooks.orgId` sweep (verified call sites)
- [ ] `jobs/webhookDeliveryRecovery.ts:277,426`: take `orgId` from `webhook_deliveries.org_id`, not `webhooks.org_id`.
- [ ] `jobs/webhookDeliveryRetention.ts:103`: check the `webhooks w` semi-join holds for partner rows; add a test with a partner webhook.
- [ ] `services/connectionHealth/sources/webhook.ts:105-131`:
  - `LEFT JOIN organizations o ON o.id = w.org_id`;
  - `COALESCE(w.partner_id, o.partner_id)`;
  - the observation's `orgId: w.org_id`, which is `null` for partner webhooks (pattern: `sources/accounting.ts:31-32`);
  - a test that a broken partner webhook opens a partner incident.
- [ ] `services/aiToolsIntegrations.ts:109,295`: include partner webhooks only when `canManagePartnerWidePolicies(auth)`; add a test.
- [ ] `services/webhookConfig.ts:12,76`, `services/webhookDeliveryRecord.ts`: `orgId: string | null`.
- [ ] Final grep: `rg -n "webhooks\.orgId|webhooksTable\.orgId|FROM webhooks|JOIN webhooks" apps/api/src ee` → every hit is handled. Commit.

### Task C5: Web
**Files:** `apps/web/src/components/webhooks/WebhooksPage.tsx` (`:306-308` create payload), `WebhookForm.tsx` (create-only `ownerScope` selector, shown only when the session can manage partner-wide state), `WebhookList.tsx` ("All organizations" badge), `WebhookDeliveryHistory.tsx` (org column for partner rows); delete `components/integrations/WebhookEditor.tsx`, `WebhookList.tsx`, `WebhookTestPanel.tsx` and their lines in `components/integrations/index.ts` (deviation 8); locales ×8.
- [ ] **Red.** The selector appears on create only; the badge renders for `partnerId` rows; the create payload sends `ownerScope: 'partner'` with no `orgId`.
- [ ] **Green.** Docs: `webhooks.mdx` `### Organization Scoping` (`:59`) gains partner webhooks, plus the org-export exception (spec §4 Secrets). Release note. Commit.

**W1-C exit:** all of the above pass, including the full `orgMerge` unit suite and every listed integration suite run locally. **CI:** Test API, Test Web, Integration Tests (cascade/export/merge/rls-coverage), Lint (drift).

---

## W1b-A — `alerts:write`: acknowledge/resolve with principal attribution

**Migrations:**
- `2027-01-14-100000-partner-api-alerts-write-scope.sql`: `CREATE OR REPLACE FUNCTION public.breeze_valid_partner_service_principal_scopes`. Copy the latest definition (`2026-12-16-100000-partner-api-device-status-read.sql`, verified as the latest) and append `'alerts:write'`. It writes no rows.
- `2027-01-14-100100-alerts-principal-attribution.sql`: `alerts.acknowledged_by_principal_id uuid NULL`, `resolved_by_principal_id uuid NULL`; FKs to `partner_service_principals(id) ON DELETE SET NULL`, added `NOT VALID` then `VALIDATE` (inferred: lighter lock on a hot table).

### Task D1: Scope
**Files:** `packages/shared/src/constants/partnerServicePrincipalScopes.ts` (append to `PARTNER_SERVICE_PRINCIPAL_WRITE_SCOPES` with an opt-in comment); `packages/shared/src/constants/partnerServicePrincipalScopes.test.ts`; `apps/api/src/services/partnerServicePrincipalScopes.test.ts` (SQL parity).
- [ ] **Red.** `alerts:write` is grantable, is in no preset or default set, and SQL parity fails until the migration exists.
- [ ] **Green.** The web grid picks it up from the registry (`PartnerServicePrincipalsPage.tsx:9-18`). Run → PASS. Commit.

### Task D2: Shared actions and attribution
**Files:** create `apps/api/src/services/alertActions.ts` + test. Modify `routes/alerts/alerts.ts:922-1000` (call the extracted function), `services/alertService.ts:815` (`resolveAlert(alertId, resolutionNote?, resolvedBy?, deferSubjectEffects = false, resolutionReason?, resolvedByPrincipalId?: string)`), `services/aiAgents/alertVerdictSubscriber.ts`, `services/fixMemory/outcomeWatcher.ts` (`:83`), `services/webhookPayload/alertEnrichment.ts`.

**Interfaces:**
- `type AlertActor = { kind: 'user'; userId: string } | { kind: 'partner_service_principal'; principalId: string }`
- `acknowledgeAlert(alertId: string, actor: AlertActor): Promise<{ changed: boolean; status: string }>`, a CAS on `status = 'active'`
- Events gain `acknowledgedByPrincipalId` / `resolvedByPrincipalId`.

- [ ] **Red.**
  - **A principal resolve starts no verdict run**: the `alert.resolved` payload has `resolvedBy: null` and `resolvedByPrincipalId` set, and `enqueueVerdictRunForAlert` is not called.
  - The principal resolve writes `resolution_reason = 'manual'`.
  - `readingFromAlert` treats `resolvedByPrincipalId` like a human resolve.
  - The staff acknowledge route behaves as before (existing `alerts.ackSuppressCas.test.ts` stays green).
  - v2 payloads carry the principal ids.
- [ ] **Green.** Run → PASS. Commit.

### Task D3: Partner API routes
**Files:** create `apps/api/src/routes/partnerApi/alertWrites.ts` (`partnerAlertWriteRoutes`: `POST /alerts/:id/acknowledge` and `POST /alerts/:id/resolve` with `{ note?: string ≤ 2000 }`, both `requirePartnerApiScope('alerts:write')`) and `alertWrites.test.ts`; modify `routes/partnerApi/index.ts`, `writeSurface.test.ts`, `docs/integrations/partner-api.md` (`:497`, `:705`), `apps/docs/src/content/docs/reference/api.mdx` (`:196-240`).
- [ ] **Red.**
  - 403 without the scope.
  - 404 for an alert in another partner's org or outside `accessibleOrgIds`.
  - A repeat → 200 with the current state.
  - Resolving an already-resolved alert → 200 and no second event.
  - `writeSurface.test.ts` lists both new mutating routes.
- [ ] **Green.** Run → PASS. Commit with the release note ("opt-in scope `alerts:write`").

**W1b-A exit:** tests pass, including scope parity. **CI:** Test API, Test Shared, Integration Tests (export: alerts columns), Lint.

---

## W1b-B — External ticket refs, `alertId` on ticket create, org external links

**Migrations:**
- `2027-01-14-110000-alerts-id-org-unique.sql`: `-- @no-transaction`, `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS alerts_id_org_uq ON alerts (id, org_id)` (none exists; `schema/alerts.ts:180-200`, verified).
- `2027-01-14-110100-alert-external-refs.sql`, modelled on `2026-12-04-101300-ticket-external-refs.sql`:
  - `alert_external_refs(id, alert_id, org_id, partner_id NOT NULL, partner_service_principal_id NOT NULL, external_id varchar(255) NOT NULL, external_url text, external_number varchar(255), created_at, updated_at)`
  - unique `(partner_service_principal_id, alert_id)`
  - composite FKs `(org_id, partner_id) → organizations(id, partner_id)` and `(partner_service_principal_id, partner_id) → partner_service_principals(id, partner_id)`, both `DEFERRABLE INITIALLY IMMEDIATE ON DELETE CASCADE`
  - `(alert_id, org_id) → alerts(id, org_id) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`
  - RLS enable + force + `breeze_has_org_access(org_id)` policies (Shape 1)
- `2027-01-14-110200-org-external-links-export-watermark.sql`:
  - AFTER INSERT/UPDATE/DELETE statement triggers on `organization_external_links` that advance `organizations.partner_export_updated_at` through `breeze_partner_export_next_timestamp`, taking locks the way `breeze_partner_export_hardware_delete` does (`2026-07-19-partner-export-consistency-completion.sql:122-138`).
  - Check that `migrationPartnerExportLocks.test.ts` still passes, and whether the new trigger family makes `organization_external_links` a material table (then `routes/psa.ts:1303-1323` company-import writes need nothing new; it is app code, not a migration) (inferred).

### Task E1: Table, registries, moves
**Files:** create `apps/api/src/db/schema/alertExternalRefs.ts` (export it from `schema/index.ts`); the registries per the checklist; `services/deviceOrgMove/moveDeviceOrgInTransaction.ts` (beside the `ticket_external_refs` delete at `:1196-1204`, delete the device's alerts' refs when `partner_id IS DISTINCT FROM` the target partner; the within-partner restamp follows through `ON UPDATE CASCADE`; add `alert_external_refs_alert_org_fk` to the `SET CONSTRAINTS … DEFERRED` list at `:213` only if the move test reds with 23503); create `__tests__/integration/alertExternalRefsRls.integration.test.ts` and `alertExternalRefsOrgMove.integration.test.ts`.
- [ ] **Red.**
  - Cross-tenant forge → 42501.
  - A device move within a partner restamps the ref's `org_id` (through the FK cascade).
  - A cross-partner move deletes it.
  - Org merge repoints it.
  - Org erasure removes it.
- [ ] **Green.** Run both, plus the cascade, export, merge and `orgLifecycleFoundations` integration suites → PASS. Commit.

### Task E2: Ref routes + https validator
**Files:**
- create `packages/shared/src/validators/alertExternalRefs.ts` (`alertExternalTicketUrlSchema`, `alertExternalTicketPutSchema = { externalId, externalUrl?, externalNumber? }`) + test;
- `routes/partnerApi/alertWrites.ts`: `PUT` and `DELETE /alerts/:id/external-ticket` (`alerts:write`), `GET /alerts/:id/external-tickets` (`alerts:read`).
- [ ] **Red.**
  - An `http://` URL → 400.
  - PUT is an upsert for the caller's principal only.
  - Principal B cannot read-modify A's ref, but GET lists both.
  - DELETE is idempotent.
  - GET also returns `source: 'psa'` rows from `psa_ticket_mappings`, filtered to connections of the principal's partner (empty until W2 writes mappings).
- [ ] **Green.** Run → PASS. Commit.

### Task E3: Alert-page read model (OD9: in whichever of W1b-B and W2-C lands first)
**Files:**
- create `apps/api/src/services/alertExternalTickets.ts`: `listAlertExternalTickets(alertId: string, viewerPartnerId: string | null): Promise<AlertExternalTicket[]>`, where `AlertExternalTicket = { source: 'partner_api' | 'psa'; externalId: string; externalUrl: string | null; externalNumber: string | null; state: string | null }`;
- create `routes/alerts/alertExternalTickets.ts`: staff `GET /alerts/:id/external-tickets`, mounted in `routes/alerts/index.ts`;
- `alertEnrichment.ts` fills `externalTickets`;
- `apps/web/src/components/alerts/AlertDetailPage.tsx` gets a read-only chip list; locales ×8.
- [ ] **Red.**
  - A viewer who can read the alert sees refs.
  - PSA rows are filtered to the mapping connection's partner.
  - The v2 payload `externalTickets` lists refs that existed at enrichment.
  - The web chip renders the number and link.
- [ ] **Green.** Run → PASS. Commit.

### Task E4: `alertId` on ticket create; org export links
**Files:** `routes/partnerApi/ticketWrites.ts` (`partnerCreateTicketSchema` `:104-112`; write `ticket_alert_links` with `link_type = 'created_from'` in the create transaction); the idempotency fingerprint input; `routes/partnerApi/schemas.ts:107-111` (`externalLinks: { system: string; externalId: string; label: string | null }[]`); `routes/partnerApi/organizations.ts`; `exportSafety.classification.ts` (classify the new field); docs.
- [ ] **Red.**
  - An alert from another org → 422.
  - An alert out of the principal's reach → 404.
  - Success writes the link in the same transaction (a forced failure after the ticket insert leaves neither row).
  - The same `X-Idempotency-Key` with a different `alertId` → 409.
  - The org export includes `externalLinks`.
  - Inserting a link advances the org's export watermark and the org reappears for a poller with `since`.
- [ ] **Green.** Run → PASS. Commit with the release note.

**W1b-B exit:** all pass. **CI:** Test API, Test Shared, Test Web, Integration Tests, Lint.

---

## LAB — ConnectWise Manage developer-instance lab (precondition for W2-A merge)

Owner: Todd, who supplies the developer-instance credentials. The fixer runs a scratch script under `internal/` (gitignored) against the instance and posts a results comment on #10499. **W2-A may be coded against fixtures, but it is not enqueued for merge until this comment exists.**

- [ ] Is `externalXRef` writable on `POST /service/tickets`, and searchable with `GET /service/tickets?conditions=externalXRef="breeze-alert:<uuid>"`? How many seconds after the create does it become findable (poll every 2 s, up to 120 s)? Is it unique: does a second ticket with the same value succeed? Record yes/no and the latency. If it is not searchable, test the fallback marker `summary contains "[breeze-alert:<first 8 of uuid>]"` and record that instead.
- [ ] What is the maximum `summary` length: what does a 101-character and a 255-character summary return? Record the limit and the error body shape.
- [ ] Status and priority ids: list `GET /service/boards/{id}/statuses` and `GET /system/priorities` (or the instance's priority endpoint). Record whether closing needs the board's "closed" status id, and whether `closedFlag` is exposed.
- [ ] What is the ticket UI URL shape? Record the URL the Manage UI opens for a ticket (for example `…/v4_6_release/services/system_io/Service/fv_sr100_request.rails?service_recid=<id>`). Then decide whether `externalUrl` is built from the connection's site URL or a separate setting.
- [ ] Notes and errors: does a `POST /service/tickets/{id}/notes` internal note send any customer email? What does a 401 look like, and does a 429 come with `Retry-After`?
- [ ] The fixer records the results in the W2-A PR description and as constants in `services/psa/connectwise.ts` (`CW_SUMMARY_MAX`, the marker strategy and the URL builder), each with a comment citing the lab date.

---

## W2-A — Data model, ConnectWise capability, config API (dark)

**Migration** `2027-01-15-100000-psa-alert-ticketing.sql`. `set_config` comes first because the file writes rows.
- `psa_connections` gains `alert_ticketing jsonb NULL`, `alert_ticketing_rev integer NOT NULL DEFAULT 0`, `alert_ticketing_enabled_at timestamptz NULL`, `alert_ticketing_paused_reason text NULL` and `alert_ticketing_paused_at timestamptz NULL`.
- `psa_ticket_mappings` gains `source text NOT NULL DEFAULT 'auto' CHECK IN ('auto','manual')`, `config_rev`, `create_state text NOT NULL DEFAULT 'never_attempted'`, `close_state`, `note_state`, `attempts`, `next_attempt_at`, `deadline_at`, `lease_token uuid`, `lease_until`, `last_error`, `last_error_class`, `create_snapshot jsonb`, `external_company_id`, `external_ticket_number` and `closed_at`. The states are `text` with `CHECK`s, never enums, so no enum split is needed.
- Dedupe `(connection_id, alert_id)` first, keeping the oldest, with a `ROW_COUNT` warning. Then `CREATE UNIQUE INDEX IF NOT EXISTS psa_ticket_mappings_connection_alert_uq ON (connection_id, alert_id) WHERE alert_id IS NOT NULL`. The table is tiny: never written outside tests (verified).
- Drop `psa_ticket_mappings_alert_id_alerts_id_fk` and re-add it `ON DELETE CASCADE` (baseline name, verified).
- Due index `ON (next_attempt_at) WHERE create_state NOT IN (<terminal>) OR close_state IN ('pending','in_flight','outcome_unknown') OR note_state IN (…)`.
- Carry over `settings->>'defaultBoardId'` for ConnectWise rows: `alert_ticketing = jsonb_build_object('enabled', false, 'boardId', …)`, then `settings = settings - 'defaultBoardId'`, with a `ROW_COUNT` warning.

### Task F1: Validator + resolver
**Files:** create `packages/shared/src/validators/psaAlertTicketing.ts` (+ test; export it from `validators/index.ts`): `connectwiseAlertTicketingSchema`, `alertTicketingSchemaFor(provider: PsaProviderId): z.ZodTypeAny | null`. Create `apps/api/src/services/psaAlertTicketing/config.ts` (+ test): `resolveAlertTicketingConfig(connection: PsaConnectionRow, partner: { serviceManagementMode: 'native' | 'external' | 'off'; serviceManagementPsaConnectionId: string | null }): { active: true; config: ConnectwiseAlertTicketing; rev: number } | { active: false; reason: 'not_bound' | 'not_external' | 'disabled' | 'paused' | 'unsupported_provider' }`.
- [ ] **Red.**
  - With `enabled: false`, a partial config validates; with `enabled: true`, it needs `boardId`, `openStatusId` and `closedStatusId`.
  - The defaults are `closeOnResolve: false`, `noteOnAcknowledge: false`, `hourlyCreateCap: 100` and `lookbackHours: 24`.
  - Any key named like a credential is rejected (strict schema).
  - The resolver returns each inactive reason, including `company_links_unverified`. Spec §3: after a rebind to a different PSA instance, company links are unverified until an admin confirms them. Enabling stores `companyLinksConfirmedFor = instanceKey(connection)`, where `instanceKey` is the provider plus the base-URL host plus the company id (inferred). A changed base URL or company makes the resolver inactive until the admin re-confirms. Existing mappings still close.
- [ ] **Green.** Run → PASS. Commit.

### Task F2: Capability + structured errors
**Files:** `services/psa/types.ts`:
- `PSAAlertTicketing`: `createAlertTicket`, `closeTicket(id, statusId)`, `addNote(id, text)`, `findTicketsByMarker(marker)`, `listBoards`, `listStatuses(boardId)`, `listPriorities`;
- `PsaAdapterError { errorClass: 'auth' | 'rate_limited' | 'transient' | 'rejected' | 'unknown_outcome'; httpStatus: number | null; retryAfterMs: number | null; bodySnippet: string }`, where the body is scrubbed and at most 500 chars;
- `supportsAlertTicketing(p): p is PSAProvider & PSAAlertTicketing`.

`services/psa/connectwise.ts`: the error path (`:77-80`); ids instead of names (`:153-160`); remove `defaultBoardId` (`:23-25`); `externalUrl` uses the LAB shape (`:89-95`). Create `services/psa/connectwise.test.ts` with fixture responses.
- [ ] **Red.**
  - 401/403 → `auth`; 429 → `rate_limited` with `retryAfterMs`; 5xx and network errors → `transient`; other 4xx → `rejected`; an abort after the request was sent → `unknown_outcome`.
  - The body snippet has no `Authorization` value and is ≤ 500 chars.
  - The create body carries `board.id`, `status.id`, `priority.id` and the marker.
- [ ] **Green.** Run → PASS. Commit.

### Task F3: Config API + connection-delete guard
**Files:** create `apps/api/src/routes/psaAlertTicketing.ts` (`psaAlertTicketingRoutes`, mounted from `routes/psa.ts`) + test:
- `GET` and `PUT /psa/connections/:id/alert-ticketing` (`PUT` body `{ config, expectedRev }`: a CAS on `alert_ticketing_rev`; it sets `enabled_at` when `enabled` flips on);
- `GET /psa/connections/:id/alert-ticketing/options?boardId=` (pickers).
- In `routes/psa.ts`, the `DELETE /connections/:id` handler (`:822`) refuses (409) while non-terminal mappings exist, and otherwise deletes the terminal mappings in the same transaction.
- [ ] **Red.**
  - Every write requires a partner-owned connection and `canManagePartnerWidePolicies` (403 otherwise).
  - A stale `expectedRev` → 409.
  - The audit row is written.
  - The options call goes through the adapter.
  - The connection delete is blocked by a `create_in_flight` mapping.
  - Enabling without `confirmCompanyLinks: true` → 422 when the instance key differs from `companyLinksConfirmedFor`.
- [ ] **Green.** Classify the new service files in `parkedFanout.contract.test.ts` if they are discovered. Run → PASS. Commit.

### Task F4: Summary and description builder
**Files:** create `apps/api/src/services/psaAlertTicketing/summary.ts` (+ test): `buildTicketSummary(input: { severity: string; title: string; hostname: string | null }, maxCodePoints: number): string` and `buildTicketDescription(…): string` (message, device, site, org, alert link, marker line).
- [ ] **Red.**
  - `[CRITICAL] Disk full — HOST01`.
  - A null hostname gives no ` — ` (Review 1).
  - A 300-code-point emoji title is cut to `maxCodePoints` without a lone surrogate and ends with `…` (Review 3).
- [ ] **Green.** Run → PASS. Commit.

**W2-A exit:** all pass and LAB is recorded. **CI:** Test API, Test Shared, Integration Tests (export: `psa_connections`), Lint (drift).

---

## W2-B — Admission, reconciler, leased worker, health source

### Task G1: Admission + subscriber + reconciler
**Files:**
- create `apps/api/src/services/psaAlertTicketing/admission.ts`: `admitAlert(alertId: string, source: 'auto' | 'manual', opts?: { bypassFilters?: boolean }): Promise<'admitted' | 'exists' | 'filtered' | 'inactive'>`, which reads the committed row and does `INSERT … ON CONFLICT (connection_id, alert_id) DO NOTHING`;
- create `services/psaAlertTicketing/subscriber.ts`;
- register `'psa-alert-ticketing'` in `services/eventSubscriberIds.ts` (between `'policy-alert-bridge'` and `'webhook-delivery'`), `services/eventSubscribers.ts` (lazy import) and `eventSubscribers.contract.test.ts`;
- create `apps/api/src/jobs/psaTicketingReconciler.ts` (every 2 min, sub-hourly so no `scheduleRegistry` slot), registered in `services/workerRegistry.ts` and `jobs/workerReadinessManifest.ts`.
- [ ] **Red.**
  - The filters hold (`minSeverity`, `ruleIds`, `monitorIds`).
  - A duplicate `alert.triggered` admits once.
  - `alert.acknowledged` and `alert.resolved` never admit; they only wake an existing mapping.
  - With `EVENT_DISPATCH_MODE=off` and the event dropped, the reconciler admits an alert triggered after `max(enabled_at, now - lookbackHours)`.
  - The reconciler wakes due mappings, and re-checks `skipped_no_company` once a link exists and the alert is still open.
  - An unbound, disabled or non-`external` connection admits nothing new.
- [ ] **Green.** Run → PASS. Commit.

### Task G2: Worker state machine
**Files:**
- create `apps/api/src/services/psaAlertTicketing/stateMachine.ts`, a pure function `nextOperation(mapping, alert | null, now): 'create' | 'adopt_lookup' | 'close' | 'note' | 'skip_resolved' | 'none'`;
- create `apps/api/src/jobs/psaTicketingWorker.ts`: BullMQ queue `psa-ticketing`, job `{ mappingId: string; op: 'create' | 'close' | 'note' }`, close/note at a higher priority; registered in `services/workerRegistry.ts` and `workerReadinessManifest.ts`;
- tests with a fake `PSAAlertTicketing` adapter that counts calls.
- [ ] **Red (assert remote side effects: count adapter calls).**
  - Timeout → `create_outcome_unknown` → `findTicketsByMarker` one match → adopt → resolve → close: **exactly one create call**.
  - Several matches → adopt the oldest and record the rest.
  - No match by the 2 h deadline → `needs_attention`, **exactly one create call**.
  - A slow create that outlives its lease: the second worker's CAS fails and there is one create call.
  - The alert row was deleted (trigger rolled back) → the mapping is gone through the FK cascade and the worker no-ops.
  - Resolve before create from `never_attempted` → `skipped_resolved_before_create`, 0 calls. From `create_outcome_unknown` it looks up first.
  - A duplicate acknowledge after the note → one note call; a note with an unknown outcome is never re-posted.
  - With `closeOnResolve` off, the resolve posts a note and never closes.
  - 429 with `Retry-After: 30` → `next_attempt_at` ≥ now + 30 s.
  - `auth` → the connection is paused (`alert_ticketing_paused_reason = 'auth'`) and the remaining jobs wait.
  - Rebind or disable mid-flight → the existing mapping still closes on its pinned connection.
  - The create/note deadline is 24 h and the close deadline is 72 h, after which → `failed`.
- [ ] **Green.**
  - Claim: a short transaction CAS with `lease_token`. The adapter call runs outside any transaction. The write-back is a CAS on `lease_token`.
  - `create_in_flight` and `create_snapshot` are written before the POST.
  - Company: `organization_external_links (org, connection.partner_id, system = provider)`. None → `skipped_no_company`; several → `skipped_ambiguous_company`.
- [ ] Run → PASS. Commit.

### Task G3: Concurrency, cap, pause/resume
**Files:** `psaTicketingWorker.ts`; `routes/psa.ts` test-connection (`:870`): on success, clear the pause and wake the paused mappings.
- [ ] **Red.**
  - The per-connection Redis lease allows one in-flight call.
  - The hourly cap is enforced with `INCR` on `psa:alert-ticketing:cap:<connectionId>:<yyyymmddhh>`, with 2 simulated workers and the cap at 3 → 3 creates.
  - Over the cap, creates wait and closes continue.
  - When Redis is lost, the reconciler re-drives from Postgres and nothing is double-posted.
  - A successful test-connection resumes the connection. Pause and resume are audited.
- [ ] **Green.** Run → PASS. Commit.

### Task G4: Moves, deletion, health, Sentry
**Files:**
- `services/deviceOrgMove/moveDeviceOrgInTransaction.ts`: on a cross-partner move, delete the device's mappings (by `device_id`, or by `alert_id` among the device's alerts) whose connection's `partner_id` differs from the target partner;
- create `services/connectionHealth/sources/psaTicketing.ts`: partner incident with `orgId: null`, opened on terminal failures, a pause or a cap trip; register it in `sources/index.ts` and `coverage.contract.test.ts`;
- the Sentry `errorId`s `PSA_ALERT_TICKET_CREATE_FAILED`, `PSA_ALERT_TICKET_OUTCOME_UNKNOWN`, `PSA_ALERT_TICKET_CLOSE_FAILED` and `PSA_ALERT_TICKET_AUTH_PAUSED`, tagged connection, provider and partner.
- [ ] **Red.**
  - Deleting an alert that has a mapping succeeds (`alertService.ts:162` rollback path; `subjectAlertOutbox.ts:126`).
  - A cross-partner move removes the mapping and a within-partner move keeps it (integration: extend `psaTicketMappingOrgScoping.integration.test.ts`).
  - A pause opens one partner incident.
  - The Sentry payload has no response body.
- [ ] **Green.** Run → PASS. Commit.

**W2-B exit:** all pass. **CI:** Test API (subscriber, readiness and health contracts), Integration Tests, Lint.

---

## W2-C — Card, alert-page chip, manual create, docs

### Task H1: Re-drive, manual create, human actions
**Files:**
- `routes/psaAlertTicketing.ts` + test:
  - `POST /psa/connections/:id/alert-ticketing/redrive` with `{ states: ('failed'|'skipped_no_company')[] }`;
  - `POST /psa/ticket-mappings/:id/create-anyway` and `/mark-handled`;
  - all gated as in Task F3 and audited.
- `routes/alerts/alerts.ts` (or the new `routes/alerts/alertPsaTicket.ts`): `POST /alerts/:id/psa-ticket`, which is `tickets:write`, `external` mode only, and `admitAlert(id, 'manual', { bypassFilters: true })`.
- [ ] **Red.**
  - Manual create works in `external` mode and → 409 in `native` mode.
  - "Create anyway" from `needs_attention` → a second create is allowed exactly once.
  - Re-drive moves only the named states.
- [ ] **Green.** Run → PASS. Commit.

### Task H2: Web
**Files:**
- create `apps/web/src/components/psa/PsaAlertTicketingCard.tsx` + test (pickers, severity → priority map, filters, toggles, counts by state, failure list, re-drive), mounted in `PsaConnectionsPage.tsx` for a capable provider on the bound connection;
- the card states "Partner-wide; no per-organization override" (spec §2);
- rename "Synced Tickets" (`locales/en/common.json:1295`; `PsaTicketList.tsx`) to "Alert tickets" (#9947);
- `AlertDetailPage.tsx:346-358`: the **"Create <PSA> ticket"** button in `external` mode with `can('tickets','write')`, plus the PSA rows in the E3 chip (or carry Task E3 here if W1b-B has not merged);
- locales ×8; all mutations through `runAction`.
- [ ] **Red.**
  - The card is hidden for a non-capable provider.
  - Save sends `expectedRev`; a 409 shows a reload toast.
  - The alert-page button shows only in `external` mode.
  - The chip shows the number and link.
- [ ] **Green.** Counts and the failure list reuse `GET /psa/tickets` (`routes/psa.ts:1032`), extended with the state columns; the enable form has a "Company links match this instance" checkbox. Run `cd apps/web && npx vitest run src/components/psa src/components/alerts`, `astro check` and the locale parity tests → PASS. Commit.

### Task H3: Docs + release note
- [ ] `apps/docs/src/content/docs/features/psa-integrations.mdx`: rewrite the caution at `:10-12` and `:150-152` (ConnectWise only), add an "Alert tickets" section (activation, company links, states, re-drive), and link the W1/W1b middleware path for other PSAs.
- [ ] Release note: off per connection; ConnectWise only; the lab was run.
- [ ] Commit.

**W2-C exit:** all pass. **CI:** Test API, Test Web, Lint. Before any partner enables it in production, run one live create/close against the LAB developer instance with the merged build.

---

## Settings rule 9 (W2 alert ticketing; goes in the W2-A and W2-C PR descriptions)

- **Home:** Integrations → PSA → (bound connection) → "Alert tickets" card (`/integrations#psa`, `PsaConnectionsPage` under `IntegrationsPage.tsx:816`). No new URL, so `settingsPageRegistry.test.ts` is unaffected (inferred).
- **Level:** partner, with no org override; the card says so.
- **Resolver:** `resolveAlertTicketingConfig` (Task F1), used by admission, the worker and the card preview.
- **Count:** the alert → PSA ticket concept is configured in 0 places before and 1 after. The ConnectWise board is configured in 1 place before (API-only `ConnectWiseSettings.defaultBoardId`, `connectwise.ts:24`, read only by `createTicket`, which has no callers) and 1 after: it moves into the card and is removed from `settings` by the W2-A migration.

## Rollout

- W1-A/B need no env change. v1 is unchanged, and the old Redis keys are drained on first boot. No wave depends on `EVENT_DISPATCH_MODE`.
- W1b is opt-in by scope.
- W2 is off per connection.
- After each merge, run `complete_wave` for that PR's sub-issue. After plan approval, `register_feature` creates the sub-issues and fills `tracking_issue:`.

## Post-approval requirements (2026-10-28)

Recorded on #10499 and in spec §6.1 after Gate B; no wave split changes:

- **W2-A** must add the per-monitor board override (settings map keyed by monitor definition id,
  partner-owned monitors only; see spec §6.1) and its UI on the ticketing settings card, and the
  severity filter default must include `warning`.
- **W2-B** reads the override when it admits an alert (monitor id is on the alert row).
- **W2 soft dependency:** #10538 (event_log clearing event) for alerts that must close when a
  recovery event arrives. W2 ships without it; the docs say so until it lands.
- **W1-A docs task:** add a Rewst worked example (webhook trigger → ConnectWise Manage action)
  after the HMAC/static-header question is answered.

