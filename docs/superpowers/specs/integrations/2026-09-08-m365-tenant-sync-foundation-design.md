---
title: Microsoft 365 tenant sync foundation (read manifest v3 + posture snapshots)
date: 2026-09-08
status: Approved 2026-09-08 (Todd) — advisor quorum applied (Fable + Codex xhigh)
tracking_issue: LanternOps/breeze#5327
program: M365 posture & security expansion, sub-project 1 of 5
related:
  - docs/superpowers/specs/integrations/2026-07-13-breeze-m365-control-plane-design.md
  - docs/superpowers/specs/integrations/2026-07-14-breeze-m365-customer-graph-read-consent-design.md
  - docs/superpowers/specs/ai-mcp/2026-07-18-m365-typed-graph-read-tools-design.md
---

# Microsoft 365 tenant sync foundation

## 0. Program context

Breeze's M365 integration today is live-query only: the `customer-graph-read`
executor answers typed read actions on demand for AI tools, and nothing about a
customer tenant is persisted. Todd's direction (2026-09-07) is to expand into
Intune, Conditional Access (CA), Entra, and security posture, surfaced in
reports, the org record, AI tools, and the customer portal, with licensing,
Secure Score, and unified-audit-log access, leading to CA templates later.

The program is decomposed into five sub-projects. Each gets its own spec, plan,
and `feature-lifecycle` issue:

| # | Sub-project | Depends on |
|---|---|---|
| **1** | **This spec.** Read manifest v3, executor sync actions, sync worker, snapshot tables | — |
| 2 | Surfacing: org tab, AI tools over the tables, `m365_posture` report type, portal security section, device-page Intune link | 1 |
| 3 | Change alerts: diff each sync against the last (new admin, CA edit, compliance drop, score drop) | 1 |
| 4 | Unified audit log AI tool (async query, live-only, attached to session/ticket) | 1 (scope only) |
| 5 | Later, separate specs: CA templates (partner-wide config + `Policy.ReadWrite.ConditionalAccess` on the actions app), Intune actions, Exchange message trace, PIM-eligible admins | 1, 2 |

The communications-delegated executor (technician mailbox) is **parked**: Plan 3
of that design is not being finished. Nothing here depends on it.

Decisions taken during brainstorming, recorded so they are not relitigated:

- **Hybrid persistence.** Entities for users, Intune devices, CA policies,
  license SKUs, and Secure Score; live-only for sign-in logs, unified audit log,
  and Exchange trace. Reason: Breeze reports read only synced Postgres tables
  (`reportGenerationService.ts`), and trends, cross-org rollups, change alerts,
  device-page joins, and portal reliability all need a stored snapshot. A single
  org point-in-time report could be live-queried; nothing else could.
- **v1 adds no write scopes.** Only the read app's manifest bumps.
- **Portal shows full drill-down** (per-user, per-device rows), gated by a
  fail-closed portal feature flag. Portal users have no roles, so every portal
  user of the org sees the same rows; a per-user gate is a later concern.
- **Executor snapshot actions** (whole-domain pull inside the executor) rather
  than API-side paging or Graph delta queries. See §4.
- **Scale-out is designed in now**, not retrofitted: due-time ticker, change-only
  writes, stateless executor replicas, per-domain cadence. See §5.

### 0.1 Advisor quorum (2026-09-08)

Codex (gpt-6-astra, xhigh, read-only against the repo) reviewed draft v1 and
returned PROCEED WITH CHANGES with 20 findings. All were verified against code
or Microsoft documentation and accepted; the material ones and where they
landed:

| Finding | Change |
|---|---|
| `signInActivity` is throttled at 10 requests/min **per app across all tenants**, 500 per page (Graph throttling-limits doc) | Sign-in activity is its own resumable domain with an app-wide limiter (§4.1, §5.7) |
| Claim advanced `next_sync_at` before enqueue, so a failed handoff could not recover; no fencing against overlapping runs | Claim/lease/generation protocol; `next_sync_at` advances on completion (§5.2) |
| BullMQ custom ids may not contain `:`; retained jobs block re-adds; `prioritized` and `delayed` were not counted for backpressure | §5.2 |
| A by-org helper mirrored from the write path does its lookup under ambient RLS, which `runOutsideDbContext` removes | Three-phase flow with a DB-free executor call helper (§5.1, §5.3) |
| Stale marking needs a complete primary enumeration; `last_seen_at` on unchanged rows is not "observed" | `last_complete_snapshot_at`; freshness contract (§5.4) |
| Partial enrichment (roles, MFA) must not produce false "absent" | Nullable enrichment fields updated per source; `mfa_registered NULL` = unknown (§3.2, §5.5) |
| Role assignments via role-assignable groups were missed; `lastSignInDateTime` includes failed attempts | Group expansion; `last_successful_sign_in_at` (§4.1) |
| Shape-1 RLS does not enforce that a referenced connection/device belongs to the same org | Composite deferrable FKs with column-specific `SET NULL` (§3.4) |
| Device link must be reconciled independently of Graph row changes; serials live in `device_hardware` | Set-based link reconciliation each device run (§5.6) |
| Disconnect sets `revoked` and clears the tenant; it does not delete the row, so an FK cascade never fires | Explicit disconnect hook; `tenant_id` on history tables; persist fencing (§5.8) |
| Org merge: `m365_connections` uses repoint-dedupe by profile | Merge policies per table (§3.5) |
| Re-consent needs a transition that keeps the old connection executable until the new consent completes; DTO hard-codes manifest v2 | Upgrade-consent flow (§2.2) |
| Executor wire contract: route is `/v1/read-action`, client cap 256 KiB, Graph client budget 512 KiB / 20 pages, strict result schemas | `/v1/sync-action` contract end to end (§4.2, §4.3) |
| Secure Score must be keyed by Graph's own date; CA hash must include `state` | §3.3, §3.2 |
| `mfa*` and `*_hash` columns must be `reviewedIncluded` | §3.6 |
| Flag must gate every entry point; existing connections need idempotent seeding | §10 |
| Ticker arithmetic left no headroom; rollup queries per run were excessive | Counts computed in memory, ≤50 % slot target, realistic benchmark (§5.9) |

Codex agreed with the executor-side paging choice and with the manifest v3
scope set (no missing scope, none over-broad; `AuditLogsQuery.Read.All` is a
deliberate one-re-consent tradeoff).

## 1. Goals and non-goals

**Goals**

1. Persist a per-org snapshot of the tenant's users, Intune devices, CA
   policies, license SKUs, and Secure Score, refreshed on a schedule, with a
   daily posture rollup per org.
2. Bump the `customer-graph-read` permission manifest once (v2 → v3) with every
   scope the whole program needs, so customers re-consent once, without
   interrupting reads on existing connections.
3. Keep the control plane's existing guarantees: executor holds the only
   credential, projection allowlists are the only fields that leave it,
   fail-closed budgets, RLS on every table, tenant-consistent references.
4. Scale to many partners × many orgs × several syncs per day without a
   thundering herd, without unbounded DB write load, with linear scale-out of
   the API worker and the executor, and with app-wide Graph limits respected.

**Non-goals (v1)**

- Any UI beyond the Integrations card changes in §2.2 (sub-project 2).
- Alerts on change (sub-project 3). The tables carry what alerts need
  (`definition_hash`, `is_stale`, daily rollups) but no diffing runs here.
- Unified audit log queries (sub-project 4). The scope is granted here only.
- Named locations, authentication strengths, and any CA write path.
- PIM-eligible role assignments (sub-project 5). v1 stores **active**
  assignments only and says so in the UI.
- Graph delta queries. A later optimisation for `/users` only; Intune
  `managedDevice` has no delta.
- Per-user license assignment as its own table; `assigned_sku_ids` on the user
  row covers reports and licensing views.

## 2. Manifest v3 and re-consent

### 2.1 Scopes

`packages/shared/src/m365/profiles.ts`, profile `customer-graph-read`: `version`
2 → 3. Four application permissions are added to `applicationPermissions` and
`applicationPermissionAssignments`:

| Scope | Unlocks | Why this one |
|---|---|---|
| `Policy.Read.All` | `/identity/conditionalAccess/policies`, named locations, auth strengths | Chosen over `Policy.Read.ConditionalAccess`: named locations are required for CA templates (sub-project 5) and would otherwise force a second re-consent |
| `RoleManagement.Read.Directory` | `/roleManagement/directory/roleAssignments`, `/directoryRoles` | Admin role membership per user, admin counts |
| `SecurityEvents.Read.All` | `/security/secureScores`, `/security/secureScoreControlProfiles` | Secure Score |
| `AuditLogsQuery.Read.All` | `/security/auditLog/queries` | Sub-project 4. Granted now so there is one re-consent wave |

MFA registration state comes from
`/reports/authenticationMethods/userRegistrationDetails`, covered by the existing
`AuditLog.Read.All`. Role-assignable group expansion uses the existing
`Group.Read.All`. Users, Intune devices, and SKUs need no new scopes.

**App-role GUIDs are verified at implementation** by reading the Microsoft
Graph service principal's `appRoles` (`GET /servicePrincipals?$filter=appId eq
'00000003-0000-0000-c000-000000000000'&$select=appRoles`), never typed from
memory. The migration/manifest test asserts the four values are present.

### 2.2 Re-consent without interruption ("upgrade consent")

Today `deriveGrantHealth` (`connectionService.ts:119`) returns
`manifest-stale` when the stored `permissionManifestVersion` lags the current
manifest, but the DTO (`m365CustomerGraphRead.ts:87`) forwards stored status
only and hard-codes `manifestVersion: 2`, and initiating consent on an existing
connection moves it to `pending-consent`, which stops reads if the admin
abandons the flow. Three changes:

1. **DTO exposes derived health.** `grantHealth` (`active | degraded |
   manifest-stale | missing | unexpected | both`) and `manifestVersion:
   number` (stored) plus `currentManifestVersion: number` are returned for both
   read and actions profiles. Web types follow.
2. **Upgrade-consent transition.** `POST /m365/connections/:id/upgrade-consent`
   (MFA-gated) creates an `admin_consent` consent session bound to the
   **existing** connection id and attempt, without changing the connection's
   status. The callback, on success, runs the existing verification path and,
   if the observed grants satisfy v3, promotes `permissionManifestVersion` to 3
   in place and bumps `consentGeneration`. On failure or abandonment nothing
   changes and the connection keeps executing on v2 grants. The existing
   "initiate consent" route stays for first-time connections only.
3. **Card presentation.** `manifest-stale` renders as an amber banner: "New
   Microsoft 365 permissions are required for Conditional Access, Secure
   Score, and admin role visibility. A Global Administrator must approve them."
   with an "Approve new permissions" button that starts the upgrade flow.
   Missing grants after a retest render the existing degraded state. Reads and
   sync keep working on old grants throughout; domains that need new scopes
   show `needs_consent` (§6).

Self-hosters with their own read-app registration must add the four app roles
before their admins can approve. Deploy doc
`docs/deploy/m365-customer-graph-read-executor.md` and the release notes carry
the instruction.

## 3. Data model

All tables are tenancy shape 1: direct `org_id NOT NULL` referencing
`organizations(id)`, RLS enabled + forced, policy
`USING (public.breeze_has_org_access(org_id))` for all commands, created in the
same migration. References to other org-owned rows use composite FKs on
`(x, org_id)` so a row can never point at another tenant's object (§3.4).
Entity tables are keyed on the Graph object id per org so a re-sync is an
upsert.

### 3.1 `m365_sync_state` — one row per (org, domain)

| Column | Type | Notes |
|---|---|---|
| `org_id` | uuid FK | |
| `connection_id` | uuid | composite FK `(connection_id, org_id) → m365_connections(id, org_id)` ON DELETE CASCADE, deferrable |
| `domain` | enum `m365_sync_domain`: `users`, `signin_activity`, `intune_devices`, `ca_policies`, `skus`, `secure_score` | |
| `next_sync_at` | timestamptz | ticker due time; NULL = unscheduled |
| `interval_seconds` | int | current cadence, adaptive (§5.7) |
| `run_generation` | int | incremented on every claim; fences persistence (§5.2) |
| `lease_until` | timestamptz | in-flight guard |
| `continuation` | text | opaque executor continuation for resumable domains (§4.1), NULL otherwise |
| `last_run_at`, `last_success_at` | timestamptz | |
| `last_complete_snapshot_at` | timestamptz | last **untruncated, primary-source-successful** run; gates stale marking (§5.4) |
| `last_status` | enum `m365_sync_status`: `success`, `partial`, `needs_consent`, `throttled`, `error` | |
| `last_error` | text | sanitized code + message, never row content |
| `last_item_count` | int | |
| `truncated` | boolean | |
| `sources` | jsonb | executor `sources` map from the last run (§4.3) |
| `last_counts` | jsonb | per-domain counters computed in memory during the run, feeds the rollup (§5.9) |
| `created_at`, `updated_at` | | |

Unique `(org_id, domain)`. Partial index `(next_sync_at) WHERE next_sync_at IS
NOT NULL` for the ticker.

### 3.2 Entity tables

Common columns: `id uuid PK`, `org_id`, `graph_id` (Graph object id; `sku_id`
for SKUs), `core_hash char(64)` (SHA-256 of the canonical **primary-source**
projection, arrays sorted, §5.4), `first_seen_at`, `last_changed_at`,
`is_stale boolean default false`, `stale_since timestamptz`. Unique
`(org_id, graph_id)`. Indexes `(org_id, is_stale)` and a partial
`(stale_since) WHERE is_stale` for retention.

**`m365_users`** — primary source `/users`: `user_principal_name`,
`display_name`, `mail`, `account_enabled`, `job_title`, `department`,
`usage_location`, `on_premises_sync_enabled`, `graph_created_at`,
`assigned_sku_ids jsonb`. Enrichment columns, each nullable where NULL means
"unknown / source unavailable", updated only when their source succeeded:
`mfa_registered`, `mfa_capable`, `default_mfa_method` (source: registration
report); `admin_roles jsonb` (array of `{roleTemplateId, displayName,
viaGroupId?}`, active assignments only) and `is_admin boolean` (source: role
assignments); `last_successful_sign_in_at` (source: `signin_activity`
domain). Index `(org_id, user_principal_name)`.

**`m365_intune_devices`** — `device_name`, `operating_system`, `os_version`,
`compliance_state` (varchar, Graph values pass through), `last_intune_sync_at`,
`user_principal_name`, `owner_type`, `enrolled_at`, `model`, `manufacturer`,
`serial_number`, `azure_ad_device_id`, `management_agent`, `jail_broken`,
`breeze_device_id uuid NULL` with composite FK
`(breeze_device_id, org_id) → devices(id, org_id)` `ON DELETE SET NULL
(breeze_device_id)` (column-specific, PG 15+; CI and prod run PG 16),
deferrable. Indexes `(org_id, serial_number)`, `(org_id, breeze_device_id)`.
`last_intune_sync_at` is part of the hash: device rows churn every run by
nature, bounded by device count.

**`m365_ca_policies`** — `display_name`, `state` (`enabled`, `disabled`,
`enabledForReportingButNotEnforced`), `graph_created_at`,
`graph_modified_at`, `conditions jsonb`, `grant_controls jsonb`,
`session_controls jsonb`, `definition_hash char(64)` = hash of `state` +
conditions + grant + session (a rename is not a policy change; disabling is).

**`m365_license_skus`** — `sku_id` (uuid, the key), `sku_part_number`,
`consumed_units int`, `prepaid_enabled int`, `prepaid_suspended int`,
`prepaid_warning int`, `capability_status`, `applies_to`.

### 3.3 Time series

Both carry `tenant_id uuid NOT NULL` (the verified M365 tenant the row came
from) so history survives a disconnect and is filtered to the current
connection's tenant at read time rather than mixing tenants after a rebind.

**`m365_secure_score_snapshots`** — `org_id`, `tenant_id`, `score_date date`
(= date of Graph's `createdDateTime` on the score, **not** fetch day),
`current_score numeric(8,2)`, `max_score numeric(8,2)`,
`active_user_count int`, `licensed_user_count int`, `control_scores jsonb`
(array of `{controlName, score, maxScore, implementationStatus}` taken from
`secureScore.controlScores[]` joined to control profiles for `maxScore` and
`title`), `created_at`. Unique `(org_id, score_date)`. The first run fetches
`$top=90` scores to backfill three months of history for free; later runs
fetch `$top=3` and upsert (Graph can revise the last day or two). Partial
index `(score_date) WHERE control_scores IS NOT NULL` for retention.

**`m365_posture_rollups`** — `org_id`, `tenant_id`, `rollup_date date`,
`users_total`, `users_enabled`, `users_mfa_registered`, `users_mfa_unknown`,
`users_admin`, `admins_without_mfa`, `admins_mfa_unknown`, `devices_total`,
`devices_compliant`, `devices_noncompliant`, `devices_in_grace`,
`devices_unknown`, `ca_policies_enabled`, `ca_policies_report_only`,
`ca_policies_disabled`, `seats_purchased`, `seats_consumed`,
`secure_score numeric(8,2)`, `secure_score_max numeric(8,2)`,
`domains_fresh jsonb` (per domain: `{asOf, complete}`), `computed_at`. Unique
`(org_id, rollup_date)`. Kept indefinitely. "Unknown" counters exist so partial
enrichment is never reported as "not registered".

### 3.4 Tenant-consistent references

- `m365_connections` gains `UNIQUE (id, org_id)` (idempotent
  `CREATE UNIQUE INDEX IF NOT EXISTS`) as the composite-FK target. The existing
  `(id, org_id, profile, consent_attempt_id)` index does not serve.
- `devices(id, org_id)` is already unique (`devices_id_org_id_uniq`).
- Both composite FKs are `DEFERRABLE INITIALLY IMMEDIATE` (CLAUDE.md, org
  merge runs `SET CONSTRAINTS ALL DEFERRED`).
- **Device org move** (`routes/devices/moveOrg.ts`): the move re-points
  `devices.org_id`, which would violate the composite FK. The move service
  detaches: `UPDATE m365_intune_devices SET breeze_device_id = NULL WHERE
  breeze_device_id = $device`. The next Intune run in the new org re-links if
  the device is Intune-managed there.
- `m365_intune_devices` is **not** added to `CORE_DEVICE_CASCADE_DELETE_TABLES`:
  that list executes `DELETE … WHERE device_id = …`, and this table links
  rather than belongs (`SET NULL`, column name `breeze_device_id`). If the
  static contract test flags the FK, the exemption is recorded in the test's
  allowlist with this reason.

### 3.5 Registration (mechanical, contract-test enforced)

- `CORE_ORG_CASCADE_DELETE_ORDER`: all seven tables, alphabetised;
  `m365_sync_state` before `m365_connections` is satisfied alphabetically
  (`m365_s…` > `m365_c…` — verify against the FK-children-first assertion, do
  not assume; if it fails, the deferrable FK still lets erasure succeed but the
  test is the contract).
- `CORE_TENANT_EXPORT_POLICY`: jsonb columns (`sources`, `last_counts`,
  `assigned_sku_ids`, `admin_roles`, `conditions`, `grant_controls`,
  `session_controls`, `control_scores`, `domains_fresh`) are `excludedOpen`;
  every column whose name contains `mfa` or `hash` (`mfa_registered`,
  `mfa_capable`, `default_mfa_method`, `users_mfa_registered`,
  `users_mfa_unknown`, `admins_without_mfa`, `admins_mfa_unknown`,
  `core_hash`, `definition_hash`) is `reviewedIncluded` (verified:
  `SUSPICIOUS_NAME_PARTS` in `tenantExportPolicy.ts` contains both); all other
  columns `included`. User rows are customer data about the customer's own
  tenant and are exported and erased with the org.
- `orgMergeRegistry.ts`: `m365_connections` already uses repoint-dedupe by
  profile (a source connection moves only when the destination lacks that
  profile). Policies here: `m365_sync_state`, `m365_users`,
  `m365_intune_devices`, `m365_ca_policies`, `m365_license_skus` → **delete
  source rows**; the reconciliation in §10 re-seeds state for whichever
  connection survives and the next sync repopulates. `m365_secure_score_snapshots`,
  `m365_posture_rollups` → **repoint-dedupe on `(org_id, date)`**, destination
  wins on collision; history cannot be regenerated so it is never deleted.
- `rls-coverage.integration.test.ts`: shape 1 is auto-discovered.

### 3.6 Migration

One file, named to sort after the newest committed migration (currently
`2026-10-14-100500-…`; re-check at implementation — shipped names run ahead of
real time). Idempotent (`CREATE TABLE IF NOT EXISTS`, `DO $$` for enums,
policies, and constraints), no inner transaction, RLS + policies in the same
file, the `m365_connections (id, org_id)` unique index included. It creates no
rows and needs no `breeze.scope` setting.

### 3.7 Retention

Daily-tier job `m365-sync-retention` (registered in `scheduleRegistry.ts`,
minute ≡ 3 mod 5), system DB context, bounded batches with a per-batch
transaction: delete entity rows `WHERE is_stale AND stale_since < now() -
interval '30 days'` in batches of 10k via the partial index; set
`control_scores = NULL` on score rows `WHERE score_date < current_date - 90 AND
control_scores IS NOT NULL` in batches, via the partial index, so the job never
rescans already-pruned history.

## 4. Executor: sync actions

### 4.1 Actions

Six new ids in `M365_READ_ACTION_IDS` (`packages/shared/src/m365/readActions.ts`),
each with a strict Zod branch, a `M365_READ_ACTION_FIELDS` projection list,
and a `case` in `apps/m365-graph-read-executor/src/microsoft/readActions.ts`.

| Action | Graph calls | Page / cap | Graph limit that matters |
|---|---|---|---|
| `m365.sync.users` | `/users?$select=…&$top=999`; `/reports/authenticationMethods/userRegistrationDetails?$top=999`; `/roleManagement/directory/roleAssignments?$expand=roleDefinition($select=id,templateId,displayName)`; for each assignment whose principal is a group, `/groups/{id}/members?$select=id` (role-assignable groups, cap 50 groups) | 999 / 25 000 | registration report 5 req/10 s per tenant |
| `m365.sync.signin_activity` | `/users?$select=id,signInActivity&$top=500`, **resumable**: input `continuation?`, at most `M365_SIGNIN_PAGES_PER_CALL` (default 5) pages per call, returns `continuation` when more remain | 500 / 25 000 | **10 req/min per app across all tenants** |
| `m365.sync.intune_devices` | `/deviceManagement/managedDevices?$select=…&$top=999` | 999 / 25 000 | 2 000 req/20 s per app per tenant (ample) |
| `m365.sync.ca_policies` | `/identity/conditionalAccess/policies` | — / 500 | 1 req/s per tenant, **no Retry-After on 429**: fixed 2 s backoff |
| `m365.sync.skus` | `/subscribedSkus` (no `$top`) | — / 200 | resource-unit quota (ample) |
| `m365.sync.secure_score` | `/security/secureScores?$top=N` (N = 90 on `backfill: true`, else 3); `/security/secureScoreControlProfiles?$select=id,title,maxScore,controlCategory` | — / 90 scores, 500 controls | none documented |

`m365.sync.users` merges by user object id into one record with computed
fields `mfaRegistered`, `mfaCapable`, `defaultMfaMethod`, `adminRoles[]`
(`{roleTemplateId, displayName, viaGroupId?}`), `assignedLicenses[]` (sku ids).
Users present in the registration report but absent from `/users` are dropped.
Users absent from the registration report get `mfaRegistered: null`, never
`false` (the report excludes some accounts and lags). Role assignments whose
principal is a group are expanded to members; nested groups are not followed
(cap and documented).

`m365.sync.signin_activity` returns `{ userId, lastSuccessfulSignInAt }` only.
`lastSignInDateTime` (which counts failed interactive attempts) is not
projected. The `continuation` is the whole Graph `@odata.nextLink` sealed by
the executor (AES-256-GCM, `tenantId` and action id in the AAD, 1 hour expiry,
base64url) so the API stores an opaque blob and cannot forge or replay it
against another tenant; resume re-validates the link through the existing
host/path guard. The key is `M365_SYNC_CONTINUATION_KEY` (optional, 32-byte
base64). The executor holds only the public verification JWK, so nothing can
be derived from a signing key; when the variable is absent an ephemeral
per-process key is used, continuations die on restart, and the API restarts
the walk on `continuation_invalid` (never a Sentry event).

Projection lists remain the only fields that leave the executor; computed
fields are listed explicitly.

### 4.2 Route and limits

Sync actions are served on `POST /v1/sync-action` in
`apps/m365-graph-read-executor/src/app.ts`, a fourth operation next to
`complete-consent`, `retest`, `read-action`.

- Same `internalAuth` signed-JWT scheme (EdDSA, 60 s, `bodySha256`,
  operation-bound claim as the other three routes use). `/v1/read-action`
  rejects `m365.sync.*` ids with `400 action_not_allowed`; `/v1/sync-action`
  rejects everything else.
- **Graph client sync profile**: `maxPageCount` 60, `maxItemCount` 25 000,
  `maxResponseBytes` 64 MiB cumulative, per-call deadline 110 s via
  `AbortController` that cancels in-flight Graph requests on expiry. The
  interactive profile (20 pages / 1 000 items / 512 KiB) is unchanged.
- **Capacity**: per-instance sync in-flight cap `M365_SYNC_MAX_IN_FLIGHT`
  (default 4) and a per-instance **total** in-flight cap
  `M365_MAX_IN_FLIGHT` (default 32) of which sync may use at most the sync
  cap, so interactive calls always have reserved headroom. Beyond the sync cap
  the route returns `503 { code: 'sync_capacity', retryAfterSeconds: 30 }` with
  a `Retry-After` header. No queueing inside the executor.
- **App-wide sign-in limiter**: a token bucket for `m365.sync.signin_activity`
  Graph requests, `M365_SIGNIN_ACTIVITY_RPM` (default 4, leaving headroom
  under Graph's 10/min and allowing two regions to share one app registration
  at 4 + 4). Per instance; if replicas > 1 the operator divides the value.
  When the bucket is empty the call returns whatever pages it completed plus a
  `continuation`, never blocks.
- Graph `429`/`503` honor `Retry-After` inside the call, up to 3 attempts and
  60 s cumulative, then surface as `graph_throttled` with `retryAfterSeconds`.

Reason for the split route: bulk pulls must never sit in front of, or starve,
an AI tool call; the two get independent caps, timeouts, and metrics.
"Never starve" is a soft guarantee under shared CPU and heap. A sync-only
replica pool behind a second executor URL is the escalation if it must be
hard; it is not in v1. Memory is measured under 4 concurrent maximum-size
snapshots as a plan task and the deploy doc records the result.

### 4.3 Wire contract, API side

`graphReadExecutorClient.ts` gains operation `'sync-action'` →
`/v1/sync-action` with `timeoutMs` 130 000 and `maxResponseBytes` 32 MiB
(the existing read-action cap is 256 KiB and stays). Result schema:

```
{
  success: true,
  kind: 'sync',
  items: [...],
  truncated: boolean,
  continuation?: string,
  fetchedAt: ISO timestamp,
  sources: { <subSource>: 'ok' | 'unlicensed' | 'permission_missing' | 'throttled' | 'error' }
}
```

Non-2xx handling is extended: `503 sync_capacity` and `graph_throttled`
map to typed results carrying `retryAfterSeconds` instead of collapsing into
`executor_unavailable`. `permission_missing` on a domain's **primary** source
is the existing `graph_permission_missing` error; on a secondary source it is
a `sources` entry and the domain is `partial`.

### 4.4 Tests

Recorded Graph fixtures per action; users with a group-principal role
assignment; a user missing from the registration report yields `null`;
sign-in continuation round trip, expiry, and tenant-mismatch rejection;
truncated paging; `/v1/read-action` refusing a sync id; sync cap 503;
total-cap reservation; app-wide limiter returning early with continuation;
throttle retry honoring `Retry-After`; CA fixed backoff; deadline cancellation.

## 5. API: sync worker

New files: `apps/api/src/services/m365Sync/` (claim protocol, domain
persisters, link reconciliation, rollup, lifecycle hooks) and
`apps/api/src/jobs/m365SyncWorker.ts` (ticker + `sync-domain` processor).
Modeled on `jobs/huntressSync.ts` for phase discipline.

### 5.1 Executor call helper

`readActionService.ts` is refactored to extract
`callGraphReadExecutor(snapshot, action, opts)`: budget check, executor
client call, metrics, audit event. It takes an immutable
**connection snapshot** (`id`, `orgId`, `tenantId`, `consentGeneration`,
`vaultRef`, `credentialVersion`, `status`, `permissionManifestVersion`) and
touches no database. The request-path `executeM365ReadAction` becomes a thin
wrapper that loads the snapshot under the request's context and calls it.
The sync worker calls the same helper with `opts.route = 'sync'` and the sync
budget family (§5.10). There is no by-org helper that does its own lookup
under ambient context: that shape cannot be wrapped in `runOutsideDbContext`
(contextless DB access is a denial), and wrapping it in a system context
would hold a transaction across Graph paging.

### 5.2 Scheduling: claim, lease, generation

No global cron. `m365_sync_state` is the schedule.

**Ticker** `m365-sync-tick`: BullMQ repeat every 60 s, unique job id, single
instance. Under a short system DB transaction it:

1. Reads queue depth as `waiting + prioritized + delayed + active`. If above
   `M365_SYNC_MAX_BACKLOG` (default 500) it records a metric and exits. Due
   rows keep their past `next_sync_at` and are picked up next tick.
2. Reconciles eligibility (§10): inserts missing state rows for executable
   connections, `ON CONFLICT DO NOTHING`.
3. Claims up to `BATCH` (default 200) rows: `SELECT … FROM m365_sync_state s
   JOIN m365_connections c ON (c.id, c.org_id) = (s.connection_id, s.org_id)
   WHERE s.next_sync_at <= now() AND (s.lease_until IS NULL OR s.lease_until <
   now()) AND c.status IN ('active','degraded') ORDER BY s.next_sync_at FOR
   UPDATE OF s SKIP LOCKED LIMIT $1`, then `UPDATE … SET lease_until = now() +
   interval '20 minutes', run_generation = run_generation + 1`. **`next_sync_at`
   is not touched by the claim.**
4. After commit, enqueues one `sync-domain { orgId, domain, generation,
   connectionId, tenantId, consentGeneration }` per claimed row with job id
   `m365-sync-<orgId>-<domain>-<generation>` (no colons; BullMQ forbids them),
   `removeOnComplete: true`, `removeOnFail: { count: 100 }`, priority 10.

**Recovery.** If enqueue fails after commit, or a worker dies mid-run, the row
still has a past `next_sync_at` and its lease expires in 20 minutes, so the
next tick reclaims it with a new generation. A late job from the old generation
finds `run_generation` mismatched at persist time and discards its result.
Retry eligibility is therefore separate from cadence: only a **completed** run
(success, partial, needs_consent, or terminal error) advances `next_sync_at`.

**Priority lanes.** On-demand sync and post-consent seeding use the same claim
function (they set `next_sync_at = now()` and call `claimAndEnqueue(orgId)`
directly) with priority 1. Because the generation is in the job id a new
high-priority job is never blocked by a retained lower-priority one.

**Intervals** (stored per row, adaptive within bounds §5.7): `users`,
`intune_devices` 6 h; `signin_activity`, `ca_policies`, `skus`, `secure_score`
24 h.

**On-demand.** `POST /m365/connections/:id/sync` (MFA-gated like retest):
Redis-limited to one call per org per 15 min; sets `next_sync_at = now()` on
the five non-sign-in domains and claims them at priority 1. Sign-in activity
is excluded from on-demand (app-wide budget).

### 5.3 `sync-domain` job, three phases

Concurrency per API instance: `M365_SYNC_CONCURRENCY` (default 4).

**Phase A — snapshot (short system transaction, then commit).** Load the
connection snapshot and the sync-state row. Exit as a no-op, clearing the
lease, if: the state row is gone; `run_generation` ≠ the job's generation; the
connection is not executable; or `connection.id`/`tenantId`/`consentGeneration`
differ from the job's. For entity domains also read the org's existing
`(graph_id, core_hash, is_stale)` set (one indexed query, ≈2 MB at 25k rows).

**Phase B — fetch (no DB context held).** `callGraphReadExecutor(snapshot,
action)` inside `runOutsideDbContext`. For `signin_activity`, pass the stored
`continuation`.

**Phase C — persist (short system transactions).** Re-read the sync-state row
and the connection `FOR UPDATE`; if generation, connection id, tenant, or
consent generation changed since Phase A, discard and exit (fencing against
disconnect/rebind during the fetch). Then per domain:

- Compute the canonical projection and `core_hash` for each item. Partition
  into `insert` (unknown id), `update` (hash differs or row was stale), and,
  only when the run is **complete** (§5.4), `stale` (known, not stale, not in
  the fetched set).
- Write inserts/updates in chunks of 1 000, **one short transaction per
  chunk** (idempotent upserts; a failure mid-way leaves a consistent partial
  state that the next run finishes). Unchanged rows are not written.
- Final transaction: stale marking (`UPDATE … SET is_stale = true, stale_since
  = now() WHERE org_id = $1 AND graph_id = ANY($2)`), the sync-state
  completion (`last_*`, `truncated`, `sources`, `last_counts`, `continuation`,
  `lease_until = NULL`, `next_sync_at = now() + interval + jitter`), the
  `m365.sync.run` audit event, and one structured log line.
- After that transaction commits: the post-persist hook runs in its own short
  system context — rollup upsert (§5.9) and, for `intune_devices`, link
  reconciliation (§5.6). It reads the committed `last_counts`; a failure there
  is logged and counted, never rolls back the completion.

### 5.4 Freshness contract and change-only writes

- `core_hash` covers primary-source fields only, arrays sorted, keys ordered,
  so enrichment availability never flips the hash.
- **Complete run** = the domain's primary source returned `ok` and
  `truncated = false`. Only a complete run marks stale rows and sets
  `last_complete_snapshot_at`. A truncated or partial run persists what it got
  and never marks stale. Known limitation: a tenant permanently over the cap
  never has vanished rows marked stale; the UI shows "partial, tenant exceeds
  cap" and the remedy is raising the cap (an executor env var), documented in
  the runbook.
- `last_changed_at` is exactly that; "observed" is expressed by
  `m365_sync_state.last_complete_snapshot_at` per domain, which is what the
  UI, reports, and `domains_fresh` use. Rows are not touched to record
  observation.

### 5.5 Enrichment (users domain)

Enrichment columns are updated by explicit column sets only when their source
was `ok` in `sources`; otherwise they are left as they were. `is_admin` is
derived in the same statement as `admin_roles` so the two never disagree. A
user missing from a successful registration report gets `mfa_registered =
NULL`. The rollup counts `mfa_unknown` separately from `not registered`.
`signin_activity` runs as its own domain and updates
`last_successful_sign_in_at` field-wise by `graph_id` for the users in the
page set; users not yet in `m365_users` are ignored (the next users run picks
them up, the next sign-in run fills them).

### 5.6 Device link reconciliation (intune_devices domain)

After the upsert, one set-based pass over **all** unlinked, non-stale rows of
the org (not only changed rows), so a Breeze agent enrolled after the Intune
snapshot links on the next run:

1. Serial: join `device_hardware.serial_number` (`devices.ts:277`;
   `devices.mtls_cert_serial_number` is not a hardware serial) to
   `m365_intune_devices.serial_number`, both trimmed and case-folded, non-empty,
   within the org. Accept only 1:1 matches; ambiguous serials (duplicated on
   either side) are skipped and counted.
2. Hostname: for rows still unlinked, `lower(devices.hostname) =
   lower(device_name)`, 1:1 only.
3. Rows whose linked `breeze_device_id` no longer exists are already nulled by
   the FK; rows whose linked device now has a different serial are re-linked by
   step 1 next run because the pass considers "unlinked OR link mismatch".

Batched via a single `UPDATE … FROM (…) AS m` per step.

### 5.7 Adaptive cadence

After each completed run the service adjusts `interval_seconds` within
`[1 h, 48 h]` (`signin_activity`: `[24 h, 7 d]`):

- `truncated`, or executor latency > 60 s: interval × 2.
- `throttled`, or `sync_capacity`: interval × 1.5; the job itself retries via
  BullMQ backoff (30 s, 2 min, 8 min, 3 attempts) before counting as
  throttled.
- `success` after a stretch: decay toward the default by 25 % per run.
- `needs_consent` or connection auth failure: `next_sync_at = NULL`
  (unscheduled). A successful upgrade-consent or retest re-seeds
  `next_sync_at = now()` for unscheduled domains.

Sign-in activity is additionally governed by the executor's app-wide limiter:
a run that returns a `continuation` stores it, finishes as the control-flow
result `partial-continue` (never persisted as a status), and re-claims itself
immediately at priority 10 (new generation) until the continuation is
exhausted, then completes.
**Hard ceiling, stated honestly:** at Graph's 10 requests/min the whole
installation can fetch ≈14 400 pages/day; with two regions at 4/min each,
≈5 760 pages/day/region. At one page per tenant that bounds daily sign-in
freshness to ≈5 700 tenants per region; larger fleets get proportionally
longer sign-in cadence via the adaptive rule and the UI shows the "as of"
date. Every other domain is bounded per tenant, not per app.

### 5.8 Connection lifecycle hooks

`connectionService.ts` disconnect (sets `revoked`, clears the tenant, keeps
the row) and consent-callback promotion gain hooks in `m365Sync/lifecycle.ts`:

- **Disconnect**: delete the org's `m365_sync_state` rows and entity rows
  (`m365_users`, `m365_intune_devices`, `m365_ca_policies`,
  `m365_license_skus`); keep history rows (they carry `tenant_id`). Any
  in-flight job discards at Phase C fencing.
- **Consent success** (`active` **or** `degraded` after verification): seed
  state rows for all six domains with `next_sync_at = now()` (the first
  `secure_score` run passes `backfill: true`) and claim at priority 1.
  Re-consent to a **different** tenant (a rebind) is a disconnect followed by a
  consent success, so old entities are gone before new ones arrive.
- **Upgrade-consent success**: re-seed `next_sync_at = now()` for domains
  currently unscheduled with `needs_consent`.

### 5.9 Rollup and capacity

Counts are computed **in memory** from the fetched items during Phase C and
stored in `m365_sync_state.last_counts`; the rollup upsert assembles today's
row from the six `last_counts` values and `last_complete_snapshot_at` per
domain (one read, one upsert, zero count queries).

Per completed run the DB cost is: one claim update (ticker, batched), one
state read, one entity-hash read, N chunk transactions where N = changed
rows / 1 000 (0 for an unchanged tenant), one completion transaction, one
audit-event insert. Capacity rule: the ticker's `BATCH × 1 440` slots per day
must run at ≤ 50 % utilisation at the fleet's default cadences; the ops
dashboard exposes `m365_sync_due_backlog` and the utilisation ratio, and
`BATCH` is the dial. The claim of "steady-state writes ≈ 0" is only for
`users`, `ca_policies`, `skus`, `secure_score`; `intune_devices` churns by
design and `signin_activity` writes only changed timestamps.

### 5.10 Budget

`readActionBudget.ts` gains `consumeM365SyncBudget(connectionId)`: 12 sync
calls per hour per connection (continuation calls included), fail-closed on
Redis error, same TTL discipline. The interactive 30/min and 2 000/day pools
are untouched.

### 5.11 Scale-out summary

| Layer | How it scales | Bound |
|---|---|---|
| Ticker | one instance, `BATCH` rows per tick, `SKIP LOCKED` | ≤ 50 % of `BATCH × 1 440` runs/day; at `BATCH` 200 and 12 runs/org/day ≈ 12 000 orgs/region, raise `BATCH` beyond |
| Worker | `M365_SYNC_CONCURRENCY` × API replicas | fetch holds no DB connection; persist is short transactions |
| Executor | stateless replicas | sync cap per replica, 503 + Retry-After above; optional sync-only pool |
| Graph, per tenant | per app per tenant limits | far above 6 calls per 6 h |
| Graph, app-wide | `signInActivity` 10/min across all tenants | ≈ 5 700 one-page tenants/day/region at daily cadence; adaptive beyond |
| Postgres | change-only writes, chunked short transactions, in-memory counts | worst case first sync of a 25k tenant: 25 chunks |
| Regions | independent ticker, worker, executor per region | orgs never cross regions; sign-in RPM split by config |

Numbers are design targets. The plan includes a benchmark against a real
Postgres sized like production (1 vCPU managed class) with 1 000 orgs at
realistic entity counts (median 60 users / 40 devices, p95 2 000 / 1 500, two
at 25k), measuring WAL, pool occupancy, foreground p95 latency of an
unrelated endpoint, and ticker drain time. Pass criteria are written before
the run.

## 6. Error handling

| Condition | Handling | Sync state | Surfaced |
|---|---|---|---|
| Primary source scope not granted (`graph_permission_missing`) | Domain unscheduled; others continue | `needs_consent` | Card banner: approve new permissions |
| Secondary source `permission_missing` / `error` (roles, registration report) | Persist primary; enrichment columns untouched; `sources` recorded | `partial` | Org tab "as of" per fact |
| Sub-source `unlicensed` (sign-in activity on a non-P1 tenant) | Domain completes with zero updates; interval → max | `success`, `sources.signInActivity = unlicensed` | Org tab: "last sign-in needs Entra P1" |
| Result truncated | Persist; no stale marking; interval ×2 | `partial`, `truncated` | "partial, tenant exceeds cap" |
| Continuation returned (sign-in) | Persist page set; re-claim immediately | unchanged until exhausted | |
| Graph throttled / executor `sync_capacity` | BullMQ backoff, 3 attempts; then interval ×1.5 | `throttled` | Next run proceeds |
| Connection auth failure (cert/tenant revoked) | Run records the terminal state and RETURNS (never throws: the worker observability wrapper reports every thrown failure to Sentry); connection health left to retest | `error`, unscheduled | Existing degraded card + retest |
| `continuation_invalid` (executor restarted, key rotated, expired) | Clear `continuation`, re-claim, restart the walk; not a Sentry event | unchanged | |
| Executor unreachable / bad signature | Run fails; Sentry, deduped per org per hour | `error` | |
| Persist failure | Chunk transaction rolls back; job error; lease expires; next tick reclaims | `error` | |
| Generation / connection / tenant mismatch at Phase C | Result discarded silently, metric incremented | unchanged | |
| Worker died mid-run | Lease expiry; ticker reclaims with new generation | | |

A domain error never affects another domain or blocks the rollup. Budget
denial without a Redis signal is a denial (fail-closed), retried next tick.

## 7. Observability

- Prometheus (pattern: `readActionMetrics.ts`):
  `m365_sync_runs_total{domain,outcome}`,
  `m365_sync_items{domain,kind=insert|update|stale|unchanged}`, histogram
  `m365_sync_executor_seconds{domain}`, gauges `m365_sync_due_backlog`,
  `m365_sync_queue_depth`, `m365_sync_ticker_utilisation`, counters
  `m365_sync_ticker_skipped_total` (backpressure), `m365_sync_fenced_total`,
  `m365_sync_link_ambiguous_total`.
- Executor: `m365_sync_actions_total{action,outcome}`, in-flight gauges (sync,
  total), `503` counter, sign-in limiter tokens gauge.
- One audit event per `sync-domain` run: org, domain, generation, outcome,
  counts, `truncated`, correlation id. Never row content.
- Structured logs carry `orgId`, `domain`, `connectionId`, `generation`,
  `correlationId`.

## 8. Security and privacy

- No new credential anywhere in the API; the executor still holds the only
  cert. Sync responses pass through the same projection allowlist.
  Continuations are executor-encrypted and tenant-bound.
- Tables are RLS shape 1 with tenant-consistent composite FKs; the worker runs
  under a system DB context by design (cross-org scheduler), and every read or
  write is filtered by the `org_id` it was enqueued with plus generation
  fencing. The ticker's claim select is the only cross-org query.
- `m365_users` contains personal data of the customer's end users (UPN, name,
  mail, job title, department, last successful sign-in). It is customer data
  of the customer's own tenant: exported and erased with the org, deleted on
  disconnect, purged 30 days after the user disappears from the tenant. No
  sign-in history, IPs, or audit rows are stored.
- `conditions`/`grant_controls`/`session_controls` can name users, groups, and
  apps by id; stored as `excludedOpen` jsonb, never exported.
- Portal exposure is sub-project 2 and fail-closed by feature flag.

## 9. Testing

- **Contract suites** (Integration Tests job): `rls-coverage`,
  `tenantCascade`, `tenant-export-policy` + `tenantExportErasureRoundtrip`,
  `orgLifecycleFoundations` (merge contract incl. deferrable composite FKs),
  device cascade static test (Test API) with the documented exemption.
  Cross-tenant forge as `breeze_app` must fail with 42501 on every table, and
  a forged `(breeze_device_id, org_id)` pointing at another org's device must
  fail with 23503.
- **Migration test**: replays the file, asserts tables, enums, unique keys,
  composite FKs deferrable, policies, `rowsecurity` + `relforcerowsecurity`,
  the `m365_connections (id, org_id)` index, and the manifest pin.
- **Sync service unit tests** (stubbed executor helper): change-only writes
  (second identical run issues zero entity writes); stale marking only on
  complete runs; per-domain isolation; enrichment preserved when a secondary
  source fails; `mfa_registered NULL` for users missing from the report;
  `is_admin` always consistent with `admin_roles`; rollup unknown counters;
  link reconciliation over unlinked rows, ambiguous serial skipped; adaptive
  interval bounds; generation fencing discards.
- **Claim protocol tests** (real Postgres): due selection, `next_sync_at`
  untouched by claim, lease expiry reclaim, generation increment, two
  concurrent tickers with `SKIP LOCKED`, backpressure counts `prioritized` and
  `delayed`, job id has no colon, priority-1 claim not blocked by a retained
  job.
- **Lifecycle tests**: disconnect deletes entities/state and keeps history;
  consent success on `degraded` seeds; upgrade-consent keeps the connection
  executable and promotes in place; rebind = disconnect + seed; device org
  move detaches the link.
- **Budget tests**: sync family independent of interactive; fail-closed.
- **Executor tests**: §4.4.
- **End-to-end integration** (`m365TenantSync.integration.test.ts`, real
  Postgres, fake executor HTTP server): seed a connection, run all six domains
  (sign-in with a continuation), assert rows, sync state, rollup, 90-day score
  backfill keyed by Graph dates; run again with one changed user and assert
  exactly one entity write; run truncated and assert no stale marks.
- **Re-consent tests**: v2 row derives `manifest-stale`, DTO exposes it, sync
  still runs; simulated upgrade callback promotes to v3; abandoned upgrade
  leaves v2 executing.
- **Benchmark** (plan task, not CI): §5.11.
- **Runbook**: `docs/runbooks/m365-customer-graph-read-real-tenant.md` gains a
  sync acceptance checklist (v3 consent on a fresh tenant, upgrade-consent on
  an existing one, first sync populates all domains, on-demand sync, unlicensed
  sign-in on a non-P1 tenant, a role assigned via a role-assignable group).

## 10. Rollout

1. One release ships: migration, manifest v3, DTO/card changes, executor
   `/v1/sync-action`, worker. **Every** sync entry point (ticker, consent
   seeding, upgrade re-seeding, on-demand route) is gated by
   `M365_TENANT_SYNC_ENABLED` (default `false`, boot-validated). The disconnect
   hook's erasure side is deliberately ungated: rows that exist must go when
   the connection goes. The executor accepts sync actions unconditionally (only
   reachable by the API). The retention job is ungated (a sweep over empty
   tables is a no-op).
2. With the flag on, the ticker's reconciliation step inserts state rows for
   every existing executable connection (`active` or `degraded`) that lacks
   them, `next_sync_at = now()` staggered over the first hour, `backfill:
   true` for the first score run. Turning the flag on is therefore the only
   step; no manual seeding.
3. Hosted: enable on one region, watch backlog, utilisation, executor 503s,
   and DB latency for a cadence window, then the other region.
4. Existing v2 connections show the upgrade banner from the moment the API
   deploys, independent of the sync flag. Reads keep working on v2 grants;
   domains needing new scopes stay `needs_consent` until approval.
5. Self-hosters: release notes list the four app roles and the env vars
   (`M365_TENANT_SYNC_ENABLED`, `M365_SYNC_CONCURRENCY`,
   `M365_SYNC_MAX_BACKLOG`, `M365_SYNC_TICK_BATCH`; executor
   `M365_SYNC_MAX_IN_FLIGHT`, `M365_MAX_IN_FLIGHT`, `M365_SIGNIN_ACTIVITY_RPM`,
   `M365_SIGNIN_PAGES_PER_CALL`, optional `M365_SYNC_CONTINUATION_KEY`).

## 11. Open questions

None blocking. Deferred by design: whether hosted US and EU share one read-app
registration (determines the sign-in RPM split; check before setting the
default in `.env`); portal per-user visibility roles (sub-project 2); PIM
eligibility (sub-project 5).
