---
title: Microsoft 365 tenant sync foundation (read manifest v3 + posture snapshots)
date: 2026-09-08
status: Draft — pending advisor quorum and Todd review
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
| 5 | Later, separate specs: CA templates (partner-wide config + `Policy.ReadWrite.ConditionalAccess` on the actions app), Intune actions, Exchange message trace | 1, 2 |

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

## 1. Goals and non-goals

**Goals**

1. Persist a per-org snapshot of the tenant's users, Intune devices, CA
   policies, license SKUs, and Secure Score, refreshed on a schedule, with a
   daily posture rollup per org.
2. Bump the `customer-graph-read` permission manifest once (v2 → v3) with every
   scope the whole program needs, so customers re-consent once.
3. Keep the control plane's existing guarantees: executor holds the only
   credential, projection allowlists are the only fields that leave it,
   fail-closed budgets, RLS on every table.
4. Scale to many partners × many orgs × several syncs per day without a
   thundering herd, without unbounded DB write load, and with linear scale-out
   of both the API worker and the executor.

**Non-goals (v1)**

- Any UI beyond the existing Integrations card additions (sub-project 2).
- Alerts on change (sub-project 3). The tables carry what alerts need
  (`definition_hash`, `is_stale`, daily rollups) but no diffing runs here.
- Unified audit log queries (sub-project 4). The scope is granted here only.
- Named locations, authentication strengths, and any CA write path.
- Graph delta queries. A later optimisation for users/devices only.
- Per-user license assignment as its own table; `assigned_sku_ids` on the user
  row covers reports and licensing views.

## 2. Manifest v3 and re-consent

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
`AuditLog.Read.All`. Users, Intune devices, and SKUs need no new scopes.

**App-role GUIDs are verified at implementation** by reading the Microsoft
Graph service principal's `appRoles` (`GET /servicePrincipals?$filter=appId eq
'00000003-0000-0000-c000-000000000000'&$select=appRoles`), never typed from
memory. The migration test that pins the manifest (`migration-m365-…`) asserts
the four values are present.

**Behaviour on bump**

- `deriveGrantHealth` (`connectionService.ts:119`) already returns
  `manifest-stale` when `permissionManifestVersion !== currentManifest.version`,
  and the card renders that as degraded with a Retest prompt. Degraded
  connections remain executable (`EXECUTABLE_STATUSES = ['active','degraded']`).
- Card copy for `manifest-stale` changes to: "New Microsoft 365 permissions are
  required. A Global Administrator must re-consent." with the admin-consent
  link (the existing initiate-consent route), because a plain retest cannot
  grant scopes. Retest after consent promotes the row to v3.
- The sync runs against degraded connections. Domains whose scope is missing
  report `needs_consent` (§6) and the rest keep syncing on old grants.
- New tenants consent at v3 directly.
- Self-hosters with their own read-app registration must add the four app
  roles. Deploy doc `docs/deploy/m365-customer-graph-read-executor.md` and the
  release notes carry the instruction.

## 3. Data model

All tables are tenancy shape 1: direct `org_id NOT NULL` referencing
`organizations(id)`, RLS enabled + forced, policy
`USING (public.breeze_has_org_access(org_id))` for all commands, created in the
same migration. No composite FKs on `org_id`. Keyed on the Graph object id per
org so a re-sync is an upsert.

### 3.1 `m365_sync_state` — one row per (org, domain)

| Column | Type | Notes |
|---|---|---|
| `org_id` | uuid FK | |
| `connection_id` | uuid FK `m365_connections` ON DELETE CASCADE | |
| `domain` | enum `m365_sync_domain`: `users`, `intune_devices`, `ca_policies`, `skus`, `secure_score` | |
| `next_sync_at` | timestamptz | ticker due time; null = unscheduled |
| `interval_seconds` | int | current cadence, adaptive (§5.5) |
| `last_run_at`, `last_success_at` | timestamptz | |
| `last_status` | enum `m365_sync_status`: `success`, `partial`, `needs_consent`, `throttled`, `error` | |
| `last_error` | text | sanitized, never row content |
| `last_item_count` | int | |
| `truncated` | boolean | last result hit the cap |
| `sources` | jsonb | executor `sources` map from last run (§4.3) |
| `lease_until` | timestamptz | in-flight guard, see §5.2 |
| `created_at`, `updated_at` | | |

Unique `(org_id, domain)`. Index `(next_sync_at) WHERE next_sync_at IS NOT NULL`
for the ticker.

### 3.2 Entity tables

Common columns on every entity table: `id uuid PK`, `org_id`, `graph_id`
(Graph object id; `sku_id` for SKUs), `row_hash char(64)` (SHA-256 of the
canonical projected record, §5.3), `first_seen_at`, `last_seen_at`,
`is_stale boolean default false`, `stale_since timestamptz`. Unique
`(org_id, graph_id)`. Index `(org_id, is_stale)`.

**`m365_users`**: `user_principal_name`, `display_name`, `mail`,
`account_enabled`, `job_title`, `department`, `usage_location`,
`on_premises_sync_enabled`, `graph_created_at`, `last_sign_in_at` (nullable,
needs Entra P1), `mfa_registered`, `mfa_capable`, `default_mfa_method`,
`admin_roles jsonb` (array of role display names), `assigned_sku_ids jsonb`
(array of uuid strings), `is_admin boolean` (denormalised from `admin_roles`
for cheap counts). Index `(org_id, user_principal_name)`.

**`m365_intune_devices`**: `device_name`, `operating_system`, `os_version`,
`compliance_state` (varchar; Graph values pass through), `last_intune_sync_at`,
`user_principal_name`, `owner_type`, `enrolled_at`, `model`, `manufacturer`,
`serial_number`, `azure_ad_device_id`, `management_agent`, `jail_broken`,
`breeze_device_id uuid NULL` FK `devices(id) ON DELETE SET NULL`. Index
`(org_id, serial_number)`, `(org_id, breeze_device_id)`.

**`m365_ca_policies`**: `display_name`, `state` (`enabled`, `disabled`,
`enabledForReportingButNotEnforced`), `graph_created_at`,
`graph_modified_at`, `conditions jsonb`, `grant_controls jsonb`,
`session_controls jsonb`, `definition_hash char(64)` (hash of conditions +
grant + session only, so a rename does not read as a policy change).

**`m365_license_skus`**: `sku_id` (uuid, the key), `sku_part_number`,
`consumed_units int`, `prepaid_enabled int`, `prepaid_suspended int`,
`prepaid_warning int`, `capability_status`, `applies_to`.

### 3.3 Time series

**`m365_secure_score_snapshots`**: `org_id`, `score_date date`,
`current_score numeric(8,2)`, `max_score numeric(8,2)`,
`active_user_count int`, `licensed_user_count int`, `control_scores jsonb`
(array of `{controlName, score, maxScore, implementationStatus}`),
`created_at`. Unique `(org_id, score_date)`. `control_scores` is set to NULL
after 90 days by the retention job; score columns are kept.

**`m365_posture_rollups`**: `org_id`, `rollup_date date`, `users_total`,
`users_enabled`, `users_mfa_registered`, `users_admin`,
`admins_without_mfa`, `devices_total`, `devices_compliant`,
`devices_noncompliant`, `devices_in_grace`, `devices_unknown`,
`ca_policies_enabled`, `ca_policies_report_only`, `ca_policies_disabled`,
`seats_purchased`, `seats_consumed`, `secure_score numeric(8,2)`,
`secure_score_max numeric(8,2)`, `domains_fresh jsonb` (which domains were
within their interval when computed), `computed_at`. Unique
`(org_id, rollup_date)`. Kept indefinitely (one small row per org per day).

### 3.4 Registration (mechanical, contract-test enforced)

- `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`): all seven
  tables, alphabetised. `m365_sync_state` references `m365_connections`, and
  `m365_intune_devices` references `devices`; both FKs carry an explicit
  `ON DELETE`, but ordering is verified against the FK-children-first assertion
  anyway.
- `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`): every
  jsonb column (`sources`, `admin_roles`, `assigned_sku_ids`, `conditions`,
  `grant_controls`, `session_controls`, `control_scores`, `domains_fresh`) is
  `excludedOpen`; `row_hash` and `definition_hash` are `reviewedIncluded`
  (name matches `hash`, non-secret); all other columns `included`. User rows
  are customer data about the customer's own tenant and are exported and
  erased with the org.
- `orgMergeRegistry.ts`: a policy per table. Entities re-point `org_id`; the
  unique `(org_id, graph_id)` can collide when two orgs mapped the same tenant,
  so the merge policy for entity tables is "delete source rows, let the next
  sync repopulate" and for `m365_sync_state` "delete source rows" (the surviving
  org's connection wins, matching the existing `m365_connections` policy).
- `CORE_DEVICE_CASCADE_DELETE_TABLES` (`routes/devices/core.ts`):
  `m365_intune_devices` if the static test flags the `breeze_device_id` FK;
  the FK is `SET NULL`, so registration is for the test's completeness, not
  for correctness.
- `rls-coverage.integration.test.ts`: shape 1 is auto-discovered; nothing to
  allowlist.

### 3.5 Migration

One file, named to sort after the newest committed migration (currently
`2026-10-14-100500-…`; check again at implementation — shipped names run ahead
of real time). Idempotent (`CREATE TABLE IF NOT EXISTS`, `DO $$` for enums and
policies), no inner transaction, RLS + policies in the same file. It creates no
rows and needs no `breeze.scope` setting.

### 3.6 Retention

Daily-tier job `m365-sync-retention` (registered in `scheduleRegistry.ts`,
minute ≡ 3 mod 5): delete entity rows with `is_stale AND stale_since < now() -
30 days` in batches of 10k; null `control_scores` on score snapshots older
than 90 days. Runs under a system DB context.

## 4. Executor: sync actions

### 4.1 Actions

Five new ids in `M365_READ_ACTION_IDS` (`packages/shared/src/m365/readActions.ts`),
each with a strict Zod branch (no parameters beyond `type`), a
`M365_READ_ACTION_FIELDS` projection list, and a `case` in
`apps/m365-graph-read-executor/src/microsoft/readActions.ts`.

| Action | Graph calls | Page size / cap |
|---|---|---|
| `m365.sync.users` | `/users?$select=…&$top=999` (pass 1); `/users?$select=id,signInActivity&$top=999` (pass 2, skipped on 403); `/reports/authenticationMethods/userRegistrationDetails?$top=999`; `/roleManagement/directory/roleAssignments?$expand=roleDefinition($select=displayName)` merged by `principalId` | 999 / 25 000 users |
| `m365.sync.intune_devices` | `/deviceManagement/managedDevices?$select=…&$top=999` | 999 / 25 000 |
| `m365.sync.ca_policies` | `/identity/conditionalAccess/policies` | default / 500 |
| `m365.sync.skus` | `/subscribedSkus` (no `$top`) | — / 200 |
| `m365.sync.secure_score` | `/security/secureScores?$top=1`; `/security/secureScoreControlProfiles?$select=id,title,maxScore,controlCategory` | 1 score / 500 controls |

`m365.sync.users` returns one record per user with computed fields
`mfaRegistered`, `mfaCapable`, `defaultMfaMethod`, `adminRoles[]`,
`lastSignInAt`, `assignedLicenses[]` (sku ids only). The merge is by user
object id; users that appear in the registration report but not in `/users`
(deleted between calls) are dropped.

Projection lists remain the only fields that leave the executor. Computed
fields are listed explicitly. `signInActivity.lastSignInDateTime` is projected
to `lastSignInAt`; no other sign-in detail is returned.

### 4.2 Separate route

Sync actions are served on `POST /sync-actions`, not `POST /read-actions`.

- Same `internalAuth` signed-JWT scheme (EdDSA, 60 s, `bodySha256`), same
  audience. The JWT carries no new claim; the route decides by action id.
  `/read-actions` rejects `m365.sync.*` ids with `400 action_not_allowed`;
  `/sync-actions` rejects everything else.
- Route timeout 120 s (interactive stays at its current value).
- Per-instance in-flight cap, default 4, env `M365_SYNC_MAX_IN_FLIGHT`. Beyond
  it the route returns `503` with `Retry-After: 30` and a
  `{ code: 'sync_capacity' }` body. No queueing inside the executor.
- Graph `429` and `503` are retried inside the call honoring `Retry-After`,
  up to 3 attempts and 60 s cumulative wait, then surfaced as
  `graph_throttled` with the last `Retry-After`.

Reason for the split: bulk pulls must never sit in front of, or starve, an AI
tool call; the two routes get independent caps, timeouts, and metrics, and can
be scaled separately if ever run on distinct replica pools.

### 4.3 Response shape

```
{
  success: true,
  kind: 'sync',
  items: [...projected records...],
  truncated: boolean,
  fetchedAt: ISO timestamp,
  sources: {
    users: 'ok' | 'error',
    signInActivity: 'ok' | 'unlicensed' | 'error',
    mfaRegistration: 'ok' | 'error',
    roleAssignments: 'ok' | 'permission_missing' | 'error'
  }
}
```

`sources` is per sub-query and is the mechanism for partial results. A
`permission_missing` on the primary source of a domain (for example
`/identity/conditionalAccess/policies` without `Policy.Read.All`) is the
existing `graph_permission_missing` error, not a partial.

Memory bound per call: 25 000 users × ~600 bytes projected ≈ 15 MB. The
deploy doc gains a line recommending 512 MB per executor replica for tenants
near the cap.

### 4.4 Tests

Recorded Graph fixtures per action; the unlicensed `signInActivity` case; a
truncated paging case; `/read-actions` refusing a sync id; the in-flight cap
returning 503; throttle retry honouring `Retry-After`.

## 5. API: sync worker

New files under `apps/api/src/services/m365Sync/` (service) and
`apps/api/src/jobs/m365SyncWorker.ts` (BullMQ). Modeled on
`jobs/huntressSync.ts` for phase discipline and `services/unifi/unifiTelemetryService.ts`
for stale marking.

### 5.1 Entry point

`executeM365ReadActionByOrg(orgId, action, opts)` in
`services/m365ControlPlane/readActionService.ts`, a line-for-line mirror of
`executeM365WriteActionByOrg` (`writeActionService.ts:98`): load the org's
`customer-graph-read` connection under the caller's ambient DB context, check
readiness, consume budget, call the executor client, record the metric/audit
event. Sync actions consume the **sync budget family** (§5.4), interactive
actions the existing one. `opts.route: 'read' | 'sync'` selects the executor
route in `graphReadExecutorClient.ts`.

### 5.2 Scheduling: due-time ticker

No global `sync-all` cron. Instead:

- **Ticker** job `m365-sync-tick`, BullMQ repeat every 60 s, single instance
  (unique job id). Under a system DB context it selects up to `BATCH` (default
  200) `m365_sync_state` rows with `next_sync_at <= now()` and
  `(lease_until IS NULL OR lease_until < now())`, ordered by `next_sync_at`,
  whose connection is `active` or `degraded`, using
  `FOR UPDATE SKIP LOCKED`. For each it sets `lease_until = now() + 20 min`,
  `next_sync_at = now() + interval_seconds + jitter(±10 %)`, and enqueues
  `sync-domain { orgId, domain }` with job id `m365-sync:<orgId>:<domain>`.
- **Backpressure.** Before selecting, the ticker reads the queue's waiting +
  active count. If it exceeds `M365_SYNC_MAX_BACKLOG` (default 500) it enqueues
  nothing this tick and increments a metric. Due rows simply wait; nothing is
  lost because `next_sync_at` is already in the past.
- **Priority lanes.** BullMQ priority: 1 for on-demand and first-after-consent
  runs, 10 for ticker runs.
- **Seeding.** When a consent callback moves a connection to `active`
  (`m365ConsentCallback.ts` around line 594), the service inserts five
  `m365_sync_state` rows with `next_sync_at = now()` and enqueues the five
  domain jobs at priority 1. Disconnect deletes the rows (FK cascade). Retest
  that returns the connection to `active` from `revoked`/`suspended` re-seeds.
- **On-demand.** `POST /m365/connections/:id/sync` (MFA-gated like retest)
  sets `next_sync_at = now()` on all five rows and enqueues at priority 1, rate
  limited to one call per org per 15 min via Redis.

Default intervals: `users` and `intune_devices` 6 h; `ca_policies`, `skus`,
`secure_score` 24 h. Stored per row so they can differ per org or per plan
later without code changes.

### 5.3 `sync-domain` job

Concurrency per API instance: `M365_SYNC_CONCURRENCY` (default 4). Steps:

1. **Load** (system DB context): connection row, sync-state row. If the
   state row is gone (disconnected) or the connection is not executable, exit
   as a no-op and clear the lease. Duplicate runs are prevented by the unique
   job id; the lease only exists so a run whose worker died is re-enqueued.
2. **Fetch** via `executeM365ReadActionByOrg` with `runOutsideDbContext` so no
   pool slot is held while the executor pages Graph (up to 120 s).
3. **Diff** in memory. Read `(graph_id, row_hash, is_stale)` for the org from
   the entity table (one indexed query; 25k rows ≈ 2 MB). Compute the canonical
   projected record and its SHA-256 for each fetched item. Partition into
   `insert` (unknown id), `update` (hash differs, or previously stale), and,
   only if `truncated` is false, `stale` (known, not stale, not fetched).
4. **Persist** in one transaction, chunks of 1 000: `INSERT … ON CONFLICT
   (org_id, graph_id) DO UPDATE` for insert + update rows (setting
   `last_seen_at`, `row_hash`, `is_stale = false`, `stale_since = NULL`);
   `UPDATE … SET is_stale = true, stale_since = now() WHERE org_id = $1 AND
   graph_id = ANY($2)` for stale rows; upsert the sync-state row (`last_*`,
   `truncated`, `sources`, `lease_until = NULL`). Unchanged rows are **not
   written**: `last_seen_at` is not touched for them. "Seen" for an unchanged
   row is implied by it not being marked stale.
5. **Domain-specific extras**, same transaction:
   - `intune_devices`: match to Breeze devices in the same org by
     `serial_number` (case-insensitive, non-empty), then by
     `device_name = devices.hostname` (case-insensitive); set
     `breeze_device_id`. Only rows in the insert/update set are matched.
   - `secure_score`: upsert today's snapshot row.
6. **Rollup**: after any domain succeeds, upsert today's `m365_posture_rollups`
   row from the current tables, stamping `domains_fresh`. Cheap (five counted
   queries per org), idempotent.

Steady state for a stable tenant is one read query and one sync-state update
per domain per run. This is the main lever on Postgres write load; the
managed DB is small (memories: `us_sluggish_2026_09_06`, rollup CTE at 150 % of
a 1-vCPU DB).

### 5.4 Budget

`readActionBudget.ts` gains a second key family,
`consumeM365SyncBudget(connectionId)`: 12 sync calls per hour per connection,
fail-closed on Redis error, same TTL discipline. The interactive 30/min and
2 000/day pools are untouched. Five domains at the default cadences need ≈ 11
calls per day; the hourly cap exists to bound retries and on-demand storms.

### 5.5 Adaptive cadence

After each run the service adjusts `interval_seconds` within
`[min, max] = [1 h, 48 h]`:

- `truncated` or executor latency > 60 s: interval × 2 (large tenant).
- `throttled`: interval × 1.5.
- `success` after a stretch: decay back toward the default by 25 % per run.
- `needs_consent` or connection auth failure: `next_sync_at = NULL`
  (unscheduled). Retest success re-seeds `next_sync_at = now()`.

### 5.6 Scale-out summary

| Layer | How it scales | Bound |
|---|---|---|
| Ticker | one instance, 200 rows per tick, `SKIP LOCKED` | 12 000 domain runs per hour ≈ 288 000 per day; at the default cadences an org needs 11 runs per day, so ≈ 26 000 orgs per region before `BATCH` needs raising |
| Worker | `M365_SYNC_CONCURRENCY` × API replicas | fetch holds no DB connection; persist is one short transaction |
| Executor | stateless replicas behind the existing LB | `M365_SYNC_MAX_IN_FLIGHT` per replica; 503 + Retry-After above it |
| Graph | throttling is per app **per customer tenant** | does not accumulate across customers; per-tenant limits are far above 5 calls per 6 h |
| Postgres | change-only writes, chunked upserts, one rollup row per org per day | steady-state writes ≈ 0; worst case (first sync of a 25k tenant) 25 chunks of 1 000 |
| Regions | US and EU each run their own ticker, worker, executor | orgs never cross regions |

Numbers above are design targets, not measurements. The plan includes a load
test seeding 1 000 orgs × 5 domains against a fake executor and asserting
the ticker drains within one cadence window with backlog under the threshold.

## 6. Error handling

| Condition | Handling | Sync state | Surfaced |
|---|---|---|---|
| Domain scope not granted (`graph_permission_missing`) | Domain unscheduled; others continue | `needs_consent` | Card: "Re-consent required for CA policies and Secure Score" |
| Result truncated | Persist; no stale marking; interval ×2 | `partial`, `truncated = true` | Card/org tab: "partial, tenant exceeds cap" |
| Sub-source unlicensed (`signInActivity`) | Field null; `sources` recorded | `success` with `sources` | Org tab note: "last sign-in needs Entra P1" |
| Sub-source `permission_missing` (role assignments) | Users persist without roles; `is_admin` untouched from prior run | `partial` | Card as above |
| Graph throttled / executor 503 | BullMQ backoff (30 s, 2 min, 8 min), 3 attempts, then error | `throttled` | Next run proceeds |
| Connection auth failure (cert/tenant revoked) | Run stops; not sent to Sentry (Huntress rule); connection health left to retest | `error`, unscheduled | Existing degraded card + retest |
| Executor unreachable / bad signature | Run fails; Sentry, deduped per org per hour | `error` | |
| Persist failure | Transaction rolls back; job error; retry next run | `error` | |
| Lease expired mid-run (worker died) | Ticker re-enqueues after `lease_until`; upsert semantics make the rerun safe | | |

A domain error never affects another domain or blocks the rollup. Budget
denial without a Redis signal is a denial (fail-closed), retried next tick.

## 7. Observability

- Prometheus (pattern: `readActionMetrics.ts`): `m365_sync_runs_total{domain,outcome}`,
  `m365_sync_items{domain,kind=insert|update|stale}`, histogram
  `m365_sync_executor_seconds{domain}`, gauges `m365_sync_due_backlog`
  (rows with `next_sync_at <= now()`), `m365_sync_queue_depth`,
  `m365_sync_ticker_skipped_total` (backpressure).
- Executor: `m365_sync_actions_total{action,outcome}`, in-flight gauge,
  `503` counter.
- One audit event per `sync-domain` run: org, domain, outcome, counts,
  `truncated`, correlation id. Never row content.
- Structured logs carry `orgId`, `domain`, `connectionId`, `correlationId`.

## 8. Security and privacy

- No new credential anywhere in the API; the executor still holds the only
  cert. Sync responses pass through the same projection allowlist.
- Tables are RLS shape 1; worker runs under a system DB context by design
  (cross-org scheduler), reads/writes are always filtered by the `org_id` it
  was enqueued with. The ticker's `FOR UPDATE SKIP LOCKED` select is the only
  cross-org query.
- `m365_users` contains personal data of the customer's end users (UPN, name,
  mail, job title, department, last sign-in). It is customer data of the
  customer's own tenant: exported and erased with the org, purged 30 days after
  the user disappears from the tenant. No sign-in history, IPs, or audit rows
  are stored.
- `conditions`/`grant_controls`/`session_controls` can name users, groups,
  and apps by id; stored as `excludedOpen` jsonb, never exported.
- Portal exposure is sub-project 2 and fail-closed by feature flag.

## 9. Testing

- **Contract suites** (Integration Tests job): `rls-coverage`,
  `tenantCascade`, `tenant-export-policy` + `tenantExportErasureRoundtrip`,
  `orgLifecycleFoundations` (merge contract), device cascade (Test API).
  Cross-tenant forge as `breeze_app` must fail with 42501 on every table.
- **Migration test** `db/migration-m365-tenant-sync.test.ts`: replays the
  file, asserts tables, enums, unique keys, policies, `rowsecurity` +
  `relforcerowsecurity`, and that the manifest pin contains the four new roles.
- **Sync service unit tests** (stubbed by-org entry point): change-only writes
  (second run of identical data issues zero entity writes); stale marking on
  full vs truncated; per-domain isolation; `needs_consent` unschedules;
  rollup with partial freshness; device matching serial-then-hostname;
  adaptive interval bounds; lease handling.
- **Ticker tests**: due selection, jitter range, backpressure skip, priority
  values, one in-flight per (org, domain), `SKIP LOCKED` under two concurrent
  tickers (integration).
- **Budget tests**: sync family independent of interactive; fail-closed.
- **Executor tests**: §4.4.
- **End-to-end integration** (`m365TenantSync.integration.test.ts`, real
  Postgres, fake executor HTTP server): seed a connection, run all five domain
  jobs, assert rows, sync state, rollup; run again with one changed user and
  assert exactly one entity write; run truncated and assert no stale marks.
- **Manifest bump test**: a v2 row derives `manifest-stale` and still
  executes a sync; after a simulated retest at v3 it derives `active`.
- **Load test** (plan task, not CI): 1 000 orgs × 5 domains, fake executor
  with 200 ms latency, assert drain time and backlog metric.
- **Runbook**: `docs/runbooks/m365-customer-graph-read-real-tenant.md` gains a
  sync acceptance checklist (consent at v3, first sync populates all five
  domains, on-demand sync, unlicensed sign-in case on a non-P1 tenant).

## 10. Rollout

1. Ship migration + manifest v3 + executor sync route in one release. The
   ticker is gated by `M365_TENANT_SYNC_ENABLED` (default `false`), validated
   at boot like the other `M365_*` flags. Executor accepts sync actions
   unconditionally (it is only reachable by the API).
2. Hosted: enable on one region, seed a handful of consented orgs, watch
   metrics for a cadence window, then enable broadly.
3. Existing v2 connections show the re-consent prompt from the moment the API
   deploys, independent of the sync flag. That is intentional: the card copy
   explains why, and reads keep working on old grants.
4. Self-hosters: release notes list the four app roles and the new env vars
   (`M365_TENANT_SYNC_ENABLED`, `M365_SYNC_CONCURRENCY`,
   `M365_SYNC_MAX_BACKLOG`; executor `M365_SYNC_MAX_IN_FLIGHT`).

## 11. Open questions

None blocking. Two items deferred to sub-project 2 by design: which portal
roles, if any ever exist, may see per-user rows; and whether the org tab shows
`sources` detail or only a summary line.
