---
tracking_issue: LanternOps/breeze#5449
---

# Wave 01 — API: server-chosen base, pins, leases, retirements, storage identity, lineage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the server a durable, lease-fenced pin on the incremental-dedupe base it hands the agent, a durable retirement tombstone for every row retention deletes, a per-job/per-snapshot storage identity stamped at dispatch, full lineage (parent/incremental/late-result) plumbing, and a transaction-boundary fix so retention's retirements commit per row instead of inside one giant ambient transaction — the data-model half of D18. The GC sweep rewrite (§3.4) and the agent (§3.5) are W02/W03.

**Architecture:** `backup_jobs` gains `base_snapshot_id`, `publish_lease_expires_at` (set for every dispatched file/system_image job, fixed at dispatch, never renewed), and `storage_identity` (stamped at dispatch from the payload's `providerConfig`). `backup_snapshots` gains a nullable `storage_identity`, copied from the job at publication. A new `backup_snapshot_retirements` table is the durable tombstone retention writes instead of a bare delete. Dispatch acquires the base pin in a job→snapshot lock-ordered transaction; retention is restructured so each candidate row commits in its own system-DB context instead of sharing the worker's blanket transaction (§3.7); a new reaper rule fails commandless pending restores after 1h; lineage fields are threaded through both live results and reconcile-adopted manifests, gated by a late-result fence.

**Tech Stack:** Hono + Drizzle ORM + PostgreSQL (RLS), Vitest (unit + `vitest.integration.config.ts`), zod.

**Spec:** `docs/superpowers/specs/backup/2026-09-09-backup-gc-reclamation-design.md` v3 (§3.1 base pin/lease, §3.2 retention pin checks, §3.3 retirements table, §3.6 storage identity, §3.7 transaction boundaries, §4 migrations/registries — NOT §3.4 sweep rules or §3.5 agent-side, which are W02/W03).

**Depends on:** none (first wave). W02 (GC sweep rewrite) and W03 (agent) depend on this wave's schema + `backupGcKnobs.ts`.

## Global Constraints

- Migration files (next free slot after shipped `2026-10-15-140004`, confirmed via `ls apps/api/migrations/*.sql | sort | tail -1`):
  - `apps/api/migrations/2026-10-15-160011-backup-jobs-base-pin-and-storage-identity.sql`
  - `apps/api/migrations/2026-10-15-160012-backup-snapshot-retirements.sql`
- New columns: `backup_jobs.base_snapshot_id varchar(255)` NULL, `backup_jobs.publish_lease_expires_at timestamptz` NULL (set for **every** dispatched file/system_image job, base or not; fixed at dispatch — never renewed on progress), `backup_jobs.storage_identity text` NULL (stamped at dispatch), `backup_snapshots.storage_identity text` NULL (**forever** nullable — no follow-up `SET NOT NULL` migration; self-healing is W02's sweep job).
- New table: `backup_snapshot_retirements` (columns per spec §3.3, shape-1 RLS, unique `(storage_identity, snapshot_id)`).
- New env knobs, all resolved **per call** (never module-load-cached) via one shared `resolveMsKnob` helper in new file `apps/api/src/services/backupGcKnobs.ts`:
  - `BACKUP_BASE_LEASE_MS` — default 7 d (`604_800_000`), production floor 1 h.
  - `BACKUP_RESTORE_PIN_LINGER_MS` — default 7 d, production floor 1 h.
  - `BACKUP_PUBLISH_MARGIN_MS` — default 1 h (`3_600_000`), production floor 5 min.
- `normalizeStorageIdentity(provider, providerConfig)` (exported, `apps/api/src/jobs/backupRetention.ts:661`) is the ONE identity function for live TypeScript code paths. Migration `160011` does NOT replicate it in SQL and does not backfill `backup_snapshots.storage_identity` at all (coordinator decision, spec §3.6/§4 amended) — every row starts NULL and is self-healed later by the W02 GC sweep from a live bucket listing.
- Registries to touch: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`), `apps/api/src/routes/devices/core.ts` (`CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES`), `apps/api/src/services/tenantExportPolicyRegistry.ts` (`CORE_TENANT_EXPORT_POLICY`). `rls-coverage.integration.test.ts` needs NO new allowlist entry (shape 1 = plain `org_id` column = auto-discovered).
- Lock order for the base pin is **job, then snapshot** (mirrors `routes/devices/moveOrg.ts:248-253`'s "lock parents in a fixed order as the transaction's first statements" pattern).

## 0. Ground truth

All of the below was verified directly against the worktree at `/Users/toddhebebrand/.herdr/worktrees/breeze/backup-gc-5429` on 2026-09-09; every citation was re-opened, not copied from the spec.

- `apps/api/src/db/schema/backup.ts:207-278` (`backupJobs`) — no `baseSnapshotId`/`publishLeaseExpiresAt`/`storageIdentity` columns exist yet. `:247` `snapshotId varchar(BACKUP_SNAPSHOT_ID_MAX_LENGTH)`.
- `apps/api/src/db/schema/backup.ts:280-337` (`backupSnapshots`) — `:300` `isIncremental boolean default(false)` and `:305-308` `parentSnapshotId` self-FK `ON DELETE SET NULL` already exist (D17, migration `2026-10-15-140004`) and are never written by the live write path. No `storageIdentity` column yet.
- `apps/api/src/db/schema/backup.ts:330-332` — `snapshotIdIdx: index('backup_snapshots_snapshot_id_idx').on(table.snapshotId)` is a PLAIN, NON-UNIQUE index — `backup_snapshots.snapshot_id` (the agent-supplied string) carries no uniqueness constraint of any kind at the DB level. Review fix implication: every lookup in this plan that matches a row by a bare `snapshotId` string (dispatch's base-candidate re-check, retention's backup-pin check, the late-result fence's base lookup, reconcile's base-existence check) must ALSO be scoped by `storageIdentity`, or it is not guaranteed to identify one specific row.
- `apps/api/src/db/schema/backup.ts:62` — `IN_FLIGHT_BACKUP_JOB_STATUSES = ['pending', 'running'] as const`, exported from this module.
- `apps/api/migrations/2026-10-15-140004-backup-snapshot-lineage-fk-set-null.sql` (full file read) — the newest shipped migration; confirmed via `ls apps/api/migrations/*.sql | sort | tail -1` that no later-sorting file exists, so `160011`/`160012` are free, correctly-ordered slots.
- `apps/api/src/jobs/backupRetention.ts:661-672` — `normalizeStorageIdentity` verbatim:
  ```ts
  export function normalizeStorageIdentity(provider: string, providerConfig: Record<string, unknown>): string {
    if (provider === 'local') {
      const rawPath = getStringValue(providerConfig, 'path') || getStringValue(providerConfig, 'basePath') || '';
      const normalizedPath = rawPath ? resolveLocalPath(rawPath) : '';
      return `local::${normalizedPath}`;
    }
    const endpoint = normalizeS3Endpoint(getStringValue(providerConfig, 'endpoint'));
    const bucket = (getStringValue(providerConfig, 'bucket') || getStringValue(providerConfig, 'bucketName') || '').trim();
    return `${provider}::${endpoint}::${bucket}`;
  }
  ```
  `resolveLocalPath = require('node:path').resolve` (import at `:9`) — resolves relative to the **calling process's cwd**. `normalizeS3Endpoint` (`:631-642`) strips scheme, lowercases the host, canonicalizes a blank endpoint and AWS's own default endpoints (`DEFAULT_AWS_S3_ENDPOINT_PATTERN`, `:617`, `/^s3(\.dualstack)?([.-][a-z0-9-]+)?\.amazonaws\.com$/`) to `''`, and keeps `host:port` when a port is present. Bucket names are trimmed but never lowercased (case-sensitive per S3 spec).
- `apps/api/src/jobs/backupRetention.ts:494-539` — `BACKUP_GC_GRACE_MS` is resolved via `resolveBackupGcGraceMs()` but frozen at module load (`export const BACKUP_GC_GRACE_MS = resolveBackupGcGraceMs();`) — the defect this wave's `resolveMsKnob` must not repeat (never captured into a module-level `const`; call it fresh at each use site).
- `apps/api/src/jobs/backupRetention.ts:159-387` (full read) — current `RetentionCleanupResult`, `deleteSnapshotRow` (`:189-193`, today a bare `db.delete(...)`, no lock, no pin check), `tryDeleteSnapshotRow` (`:205-221`, try/catch around the delete, returns boolean), and `cleanupExpiredSnapshots` (`:231-387`, two passes: `expired` — a single bulk SELECT then a JS loop calling `tryDeleteSnapshotRow` per row — and `versionBoundSnapshots`, grouped by `(deviceId, configId)` for the `maxVersions` prune). **No transaction of any kind exists today** — both passes run under whatever ambient context the caller already opened.
- `apps/api/src/jobs/backupWorker.ts:60-64` — `const { db } = dbModule;` and `runWithSystemDbAccess = (fn) => typeof dbModule.withSystemDbAccessContext === 'function' ? dbModule.withSystemDbAccessContext(fn) : fn()`.
- `apps/api/src/jobs/backupWorker.ts:77-130` (`createBackupWorker`, full read) — the BullMQ processor. `dispatch-backup` is special-cased **outside** the blanket wrap at `:89-99` (comment `:82-88` explains why: Redis/WS I/O via `agentCommandRelay` must not pin a pooled connection idle-in-transaction). Every other job type — including `cleanup-expired-snapshots` at `:109-111` — runs inside `return runWithSystemDbAccess(async () => { switch (data.type) { ... } })` at `:101`. `withDbAccessContext`/`withSystemDbAccessContext` (`apps/api/src/db/index.ts:525-554,610`) open exactly one real Postgres transaction (`baseDb.transaction(...)`) when no ambient context is already active, and are a no-op passthrough when nested inside one that already is. **This is the bug §3.7 fixes**: today, every retirement insert + row delete `cleanupExpiredSnapshots` performs, across every org and every candidate row, plus the entire GC sweep that follows it, all share the ONE transaction opened at `:101` — a later `failed > 0` throw or any savepoint rollback undoes retirements that already "committed" from the caller's point of view.
- `apps/api/src/jobs/backupWorker.ts:325-395` — `processCleanupExpiredSnapshots` verbatim: loops `db.selectDistinct({ orgId }).from(backupSnapshots)`, calls `cleanupExpiredSnapshots(orgId)` per org, then `sweepUnreferencedBackupObjects()` once (try/catch, GC failure never fails the job), then the deliberate D17 `if (failed > 0) throw ...` **last**, after the sweep has already run.
- `apps/api/src/jobs/backupRetention.ts:982` — `sweepUnreferencedBackupObjects` has **no internal `withSystemDbAccessContext`/`withDbAccessContext` call of its own** — it relies entirely on the ambient context the caller already opened. Pulling `cleanup-expired-snapshots` out of the blanket wrap (as this wave must) would leave this function's DB reads running with NO context at all unless Task 8's call site compensates. Per the coordinator's authoritative call-shape contract, Task 8 wraps the sweep call in exactly ONE `runWithSystemDbAccess`/`withSystemDbAccessContext` call (matching today's shape, so the function's existing GUC-dependent reads keep working) — internal per-identity context splitting is left entirely to W02 (§3.4/§3.7 item 2).
- `apps/api/src/jobs/backupWorker.ts:609-778` (`prepareBackupDispatchTargets`, full read) — builds `targets` (`:652`), loops `for (let i = 0; i < targets.length; i++)` (`:703`), creates a child `backup_jobs` row via `.insert(backupJobs)...returning()` for `i > 0` (`:713-733`, reusing `data.jobId` for `i === 0`), then builds `command.payload` at `:742-762`: `{ jobId, configId, provider, providerConfig: commandProviderConfig, storageEncryption, ...target.payload }` — no base/lease/identity fields today. This is the exact insertion point.
- `apps/api/src/jobs/backupWorker.ts:399-431` — `resolveBackupTargets`: `case 'file'` and `case 'system_image'` both return `commandType: 'backup_run'`; hyperv/mssql return `hyperv_backup`/`mssql_backup` — never base-pinned. `system_image` payload is `{ systemImage: true }`; `file` payload is `{ paths, excludes? }`.
- `apps/api/src/jobs/backupWorker.ts:26` — drizzle-orm import is `eq, ne, and, sql, isNull, lt, inArray` — `desc`, `or`, `gt` are NOT yet imported and must be added.
- `apps/api/src/services/orgCurrencyCore.ts:68,102`, `apps/api/src/jobs/softwareRemediationWorker.ts:248`, `apps/api/src/jobs/sensitiveDataJobs.ts:301,330,340` — confirmed directly: `.for('share')` and `.for('update')` (optionally `.for('update', { of: table })`) are established Drizzle patterns already in production code in this repo.
- `apps/api/src/routes/devices/moveOrg.ts:248-253` — the actual lock-order precedent (the spec's `:656` citation was stale): both parent org rows are locked `FOR SHARE`, in a fixed (ascending id) order, as the **first** statements of the transaction, before any dependent row is touched. Mirrored here as job-row-then-snapshot-row.
- `apps/api/src/jobs/staleCommandReaper.ts:97-100` — `BACKUP_STALL_TIMEOUT_MS = 15*60*1000`, `BACKUP_OFFLINE_GRACE_MS = 10*60*1000`, `BACKUP_ABSOLUTE_TIMEOUT_MS = 24*60*60*1000`, `BACKUP_PENDING_TIMEOUT_MS = 60*60*1000`. `:150-240` (`propagateTimedOutDeviceCommand`) matches `restoreJobs` **only by `commandId`** (`:220-240`, `WHERE command_id = $1 AND status IN ('pending','running')`) — a restore row created before its command row exists (`routes/backup/restore.ts:281,361`) is never reached by this function. `:1343-1482` (`reapStaleBackupJobs`) and `:1291` (`reapBackupJobRow`) are the exact per-domain reap pattern to mirror. `:1496-1505` `REAPER_DOMAINS` is the exported, module-scope array of `[name, fn]` pairs the BullMQ worker iterates, each wrapped individually in `runWithSystemDbAccess` (`:1517-1524`) — the new domain is added here.
- `apps/api/src/routes/backup/resultSchemas.ts:27-32` — `backupSnapshotResultSchema` today: `{ id, timestamp?, size?, files? }` only. No `baseSnapshotId`/`formatVersion`/`backupIdentity`.
- `apps/api/src/services/backupResultPersistence.ts:972-981` — the terminal-job guard: `terminalJobGuard` (source `'agent'` branch) = `status='failed' AND errorLog LIKE '%[stale-backup-reaper]%'` (`STALE_BACKUP_REAP_MARKER`, imported from `../db/schema/backup` at `:11`). `:1041-1051` — `updatedJob` is `.returning({ id, orgId, configId, backupType, backupMode })` from the job UPDATE — must widen to also return `baseSnapshotId`, `publishLeaseExpiresAt`, `storageIdentity`. `:1143-1162` — `snapshotValues` object is where `parentSnapshotId`/`isIncremental`/`storageIdentity` must be added.
- `apps/api/src/services/backupSnapshotReconcile.ts:135-155` — `ReconcileSkipReason` union (must widen with `'retired' | 'orphan-too-old-for-adoption' | 'base-missing'`). `:234-240` — `reconcileManifestSchema` (zod `.passthrough()`) already parses `formatVersion`/`baseSnapshotId` off the manifest. `:538-585` (`manifestToCommandResult`) builds its returned `snapshot: {...}` **without** forwarding either field — the exact gap Task 11 closes. `:592-973` (`reconcileOrphanedBackupSnapshots`, full read) — `writtenAt` is computed per candidate at `:705`, immediately followed by a `skip(reason)` closure (`:706-719`) and the `restorableOwner`/`foreignClaimed`/`claimingJob` checks (`:721-774`) — this is where the retired/orphan-age refusals are inserted. The manifest is only fetched and parsed later, in the adoption loop, at `:864-874` (`manifestToCommandResult` call) — the base-existence refusal belongs right after that, before `:882`.
- `apps/api/src/routes/backup/configs.ts:354-469` (PATCH handler, full read) — `current` read at `:376-380`; `nextProviderConfig` computed at `:393-395`; the write transaction at `:440-452`; response built via `toConfigResponse(row)` at `:467`.
- `apps/api/src/db/schema/recoveryTokens.ts:20-57` (full file read) — `recoveryTokens.snapshotId` is a `uuid` FK to `backupSnapshots.id` (`ON DELETE SET NULL`), `status varchar(20) default('active')`, `completedAt timestamp` nullable, `expiresAt timestamp` NOT NULL. No `session_status` column.
- `apps/api/migrations/2026-04-11-bucket-a-rls-policies.sql:12-32` — exact shape-1 RLS pattern (four `DROP POLICY IF EXISTS`, `ENABLE`+`FORCE ROW LEVEL SECURITY`, four `CREATE POLICY breeze_org_isolation_{select,insert,update,delete}` using `public.breeze_has_org_access(org_id)`), copied verbatim in Task 3's migration.
- `apps/api/src/services/tenantCascade.ts:169-179` — `CORE_ORG_CASCADE_DELETE_ORDER` reads `..., 'backup_chains', 'backup_configs', 'backup_jobs', 'backup_policies', 'backup_profiles', 'backup_sla_configs', 'backup_sla_events', 'backup_snapshots', 'backup_verifications', ...` at exactly those lines. `'backup_snapshot_retirements'.localeCompare('backup_snapshots')` is negative (`'_r' < '_s'` after the shared `backup_snapshot` prefix), so the new entry sorts between `'backup_sla_events'` and `'backup_snapshots'`.
- `apps/api/src/routes/devices/core.ts:257-270` — `CORE_DEVICE_ORG_DENORMALIZED_TABLES` reads `'backup_chains', 'backup_jobs', 'backup_sla_events', 'backup_snapshots', 'backup_verifications', ...` — same insertion point.
- `apps/api/src/routes/devices/core.ts:463-478` — `CORE_DEVICE_CASCADE_DELETE_TABLES` is explicitly children-before-parents ORDERED (comment `:475-478`): `'recovery_tokens', 'backup_chains', 'restore_jobs', 'backup_verifications', 'backup_snapshots', 'backup_jobs', ...`. `backup_snapshot_retirements.device_id` is nullable `ON DELETE SET NULL` — SET NULL never raises an FK violation regardless of position, so it can be added anywhere; placed right after `'backup_jobs'` for readability.
- `apps/api/src/services/tenantExportPolicyRegistry.ts:118-125` — exact `tablePolicy("org_id", {...})` shape; `backup_jobs`'s current `included` list and `backup_snapshots`'s current `included` list quoted verbatim in Task 4.
- `apps/api/vitest.integration.config.ts` (full read) — `include` contains `'src/__tests__/integration/**/*.test.ts'` as a standing glob entry — new files under that directory need **no config edit**.
- `apps/api/package.json:26` — `"test": "vitest"` (bare, watch-mode by default — the `--` trap applies). No `typecheck` script exists; use `pnpm --filter @breeze/api exec tsc --noEmit` per CLAUDE.md.
- `apps/api/src/jobs/backupRetention.test.ts:1-75` (full read) — the `chainable(rows)` mock helper (`from/where/leftJoin/innerJoin/orderBy/limit` all return `obj`, `.then()` resolves `rows`), a FIFO `selectQueue` consumed by `mockDb.select`, `vi.mock('../db', () => ({ db: mockDb }))`. **No `.for()` method on `chainable`, no `insert`, no `withSystemDbAccessContext` export from the mock today** — Task 9's test setup must add all three.
- `apps/api/src/jobs/backupWorker.test.ts:1-59` (full read) — `mockDb` with `select/from/where/limit` chainable via `mockReturnThis()`, `vi.mock('../db', () => ({ db: mockDb, withSystemDbAccessContext: undefined, runOutsideDbContext: (fn) => fn(), SYSTEM_DB_ACCESS_CONTEXT: {...} }))`, `cleanupExpiredSnapshots`/`sweepUnreferencedBackupObjects` mocked wholesale from `./backupRetention`, `__testOnly` exported from `backupWorker.ts` for driving `processDispatchBackup` directly. No `mockDb.transaction` today — Task 6's test adds one.
- `apps/api/src/__tests__/integration/staleBackupReaper.integration.test.ts` (full read) — the real-DB integration-test convention this wave's new suites mirror: `import './setup'`, `it.runIf(!!process.env.DATABASE_URL)`, seed via `withSystemDbAccessContext(async () => { ... insert partner/org/site/device/config/job ... })`, exercise the real function, assert via a second `withSystemDbAccessContext` read.
- **Round-2 review findings, independently re-verified:**
  - `apps/api/src/db/index.ts:124-129` — the REAL `DbAccessContext` interface: `{ scope: DbAccessScope; orgId: string | null; accessibleOrgIds: string[] | null; accessiblePartnerIds?: string[] | null; userId?: string | null; currentPartnerId?: string | null; ... }`. There is NO `partnerId` field — an earlier draft's `{ scope, orgId, partnerId: null }` in the RLS forge test was simply a no-op extra property, not a real context value.
  - `apps/api/src/__tests__/integration/agentRollbackRls.integration.test.ts:12-13` — the established `orgContext(orgId)` helper convention: `{ scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null }`. `:105` confirms a Drizzle `.insert(...)` rejection wraps the real Postgres error under `.cause` (`rejects.toMatchObject({ cause: { code: '23505' } })`), while `:128`'s raw `db.execute(sql\`...\`)` rejection carries `.code` at the top level instead — the two are NOT interchangeable.
  - `apps/api/src/__tests__/integration/db-utils.ts:59,106,146` — `createUser`/`createPartner`/`createOrganization` are the established seed helpers this suite's integration tests use in preference to hand-rolled inserts; no `createDevice` helper exists there (device rows are inserted directly, as `staleBackupReaper.integration.test.ts` and this plan's own tests already do).
  - `apps/api/scripts/check-drift.ts:1-31` (header) — `db:check-drift` verifies ONLY that the hand-written migration set applies cleanly and that `breeze_migrations` has one row per file; its own comment block is explicit that "Schema-vs-live-DB structural drift" is deliberately NOT checked here (drizzle-kit's introspect/generate round-trip produces too many false positives in this repo) — that is covered instead by the real-DB integration tests and PR review. It CANNOT fail or pass based on a Drizzle schema TypeScript change alone.
  - `apps/api/src/testUtils/integrationDatabaseSafety.ts` — `assertTestDatabaseUrlSafe` REFUSES any connection whose database name doesn't match `/^breeze_test(_[a-z0-9]+)?$/`, whose host isn't in a local allowlist, or whose port is `5432` (the dev/prod default) — the dev-DB URL used elsewhere in this repo's docs (`postgresql://breeze:breeze@localhost:5432/breeze`) is exactly the shape this rejects. `apps/api/src/__tests__/integration/setup.ts:32-33` defaults `DATABASE_URL`/`DATABASE_URL_APP` to `postgresql://breeze_test:breeze_test@localhost:5433/breeze_test` when unset, and `docker-compose.test.yml:27-33` provisions exactly that database on port 5433 — the integration runner needs NO `DATABASE_URL` override at all locally as long as that compose service is up.
  - `apps/api/src/jobs/queueSchemas.ts` — `backupSnapshotSummarySchema` (the block starting `const backupSnapshotSummarySchema = z.object({`) is `.strict()` and today declares only `id`/`timestamp`/`size`/`files` — none of this wave's `baseSnapshotId`/`formatVersion`/`backupIdentity` fields. `apps/api/src/jobs/backupEnqueue.ts:79-117` — `ProcessResultsResult` is a plain (non-Zod) TS interface with the same gap at its `snapshot?: {...}` sub-type (`:105-115`). `enqueueBackupResults` (`:161-187`) parses its `result` argument through `backupQueueJobDataSchema.parse(...)` — the same schema `backupWorker.ts`'s `parseQueueJobData` uses at `:81` — so a `.strict()` mismatch either throws at enqueue time or silently strips the fields, and either way the lineage data added in `resultSchemas.ts` (the WS-ingress schema) never reaches `backupResultPersistence.ts`.

## File structure

- **Create** `apps/api/migrations/2026-10-15-160011-backup-jobs-base-pin-and-storage-identity.sql` — new `backup_jobs` columns + partial index; nullable `backup_snapshots.storage_identity` column, DDL only, no backfill.
- **Create** `apps/api/migrations/2026-10-15-160012-backup-snapshot-retirements.sql` — new table + shape-1 RLS.
- **Create** `apps/api/src/services/backupGcKnobs.ts` + `apps/api/src/services/backupGcKnobs.test.ts` — shared per-run env-knob resolver.
- **Modify** `apps/api/src/db/schema/backup.ts` — add columns to `backupJobs`/`backupSnapshots`, new `backupSnapshotRetirements` table.
- **Modify** `apps/api/src/services/tenantCascade.ts`, `apps/api/src/routes/devices/core.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts` — registries.
- **Modify** `apps/api/src/jobs/backupWorker.ts` — carve `cleanup-expired-snapshots` out of the blanket wrap; base selection + pin acquisition + storage-identity stamping in `prepareBackupDispatchTargets`.
- **Modify** `apps/api/src/jobs/staleCommandReaper.ts` — new `reapCommandlessPendingRestores` domain.
- **Modify** `apps/api/src/jobs/backupRetention.ts` — per-row system-context retention with pin checks + retirement insert.
- **Modify** `apps/api/src/routes/backup/resultSchemas.ts` — lineage fields on `backupSnapshotResultSchema`.
- **Modify** `apps/api/src/services/backupResultPersistence.ts` — lineage on write + late-result fence (device-scoped, `FOR UPDATE`-atomic, identity-scoped).
- **Modify** `apps/api/src/jobs/queueSchemas.ts`, `apps/api/src/jobs/backupEnqueue.ts` — propagate the new lineage fields through the BullMQ queue schema and `ProcessResultsResult` interface (review fix — otherwise stripped/rejected before persistence ever sees them).
- **Modify** `apps/api/src/services/backupSnapshotReconcile.ts` — forward lineage, refuse retired/too-old/base-missing/late-result-fenced adoption; scope the base-existence lookup by `storageIdentity`.
- **Modify** `apps/api/src/routes/backup/configs.ts` — `warnings: string[]` (always present) on PATCH.
- **Test (modify)** `apps/api/src/jobs/backupWorker.test.ts`, `apps/api/src/jobs/backupRetention.test.ts`, `apps/api/src/jobs/staleCommandReaper.test.ts`, `apps/api/src/services/backupResultPersistence.test.ts`, `apps/api/src/services/backupSnapshotReconcile.test.ts`, `apps/api/src/routes/backup/configs.test.ts`, `apps/api/src/jobs/backupEnqueue.test.ts` (new queue round-trip case).
- **Test (new)** `apps/api/src/__tests__/integration/backupRetentionPins.integration.test.ts`, `apps/api/src/__tests__/integration/backupSnapshotRetirementsRls.integration.test.ts`.

---

### Task 1: Migration 160011 — `backup_jobs` pin/identity columns + nullable `backup_snapshots.storage_identity` (DDL only)

**Files:** Create `apps/api/migrations/2026-10-15-160011-backup-jobs-base-pin-and-storage-identity.sql`.

**Decision (no backfill — coordinator directive, spec §3.6/§4 amended):** this migration is DDL only. `backup_snapshots.storage_identity` is added nullable with **no UPDATE and no `breeze.scope` elevation** — every existing row is simply left NULL. W02's sweep self-heals each NULL row by matching it against a live bucket listing (per row id), so no SQL or TS backfill of any kind is needed here. This replaces an earlier draft of this task that ported `normalizeStorageIdentity` into PL/pgSQL for a guarded subset of rows — dropped entirely, not merely deferred.

- [ ] Step 1: Write the failing test — this migration has no unit-testable TS surface; the "red" step is observing the column/table absence against a real DB.
  Command: `docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "\d backup_jobs"` → confirm `base_snapshot_id`/`publish_lease_expires_at`/`storage_identity` are absent.

- [ ] Step 2: Run it, expect FAIL (columns absent) — already true, this is the baseline.

- [ ] Step 3: Implement

```sql
-- apps/api/migrations/2026-10-15-160011-backup-jobs-base-pin-and-storage-identity.sql
-- D18 W01 (#5429 family, spec v3 §3.1/§3.6): server-chosen incremental-dedupe
-- base pin with a fixed publish-lease deadline, plus a per-job/per-snapshot
-- storage identity that survives a backup_configs destination edit.
--
-- publish_lease_expires_at is set for EVERY dispatched file/system_image job
-- (base or not) at DISPATCH time only — it is never renewed (no delivery
-- channel exists to renew it; see backupWorker.ts's stampDispatchPinAndIdentity
-- docstring). storage_identity on backup_snapshots is nullable FOREVER: no
-- follow-up NOT NULL migration exists for it, and this migration does NOT
-- backfill it — every existing row is left NULL. The W02 GC sweep self-heals
-- each NULL row by matching it (by row id) against a live bucket listing; no
-- SQL or TS backfill of any kind is required or attempted here.
--
-- DDL only — no UPDATE, no breeze.scope elevation needed. Idempotent:
-- IF NOT EXISTS on every column/index.

DO $$
BEGIN
  ALTER TABLE backup_jobs ADD COLUMN IF NOT EXISTS base_snapshot_id varchar(255);
  ALTER TABLE backup_jobs ADD COLUMN IF NOT EXISTS publish_lease_expires_at timestamptz;
  ALTER TABLE backup_jobs ADD COLUMN IF NOT EXISTS storage_identity text;
  RAISE NOTICE 'backup_jobs: base_snapshot_id / publish_lease_expires_at / storage_identity ensured';
END $$;

CREATE INDEX IF NOT EXISTS backup_jobs_base_snapshot_id_idx
  ON backup_jobs (base_snapshot_id)
  WHERE base_snapshot_id IS NOT NULL;

DO $$
BEGIN
  ALTER TABLE backup_snapshots ADD COLUMN IF NOT EXISTS storage_identity text;
  RAISE NOTICE 'backup_snapshots: storage_identity ensured (nullable, no NOT NULL, no backfill — every row starts NULL and is self-healed by the W02 GC sweep from a live bucket listing)';
END $$;
```

- [ ] Step 4: Run, expect PASS
  Commands:
  - `pnpm db:migrate`
  - `docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "\d backup_jobs"` — confirm all three columns present.
  - `docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "SELECT count(*) FROM backup_snapshots WHERE storage_identity IS NOT NULL;"` — expect `0` (no backfill).

- [ ] Step 5: Commit
  `git add apps/api/migrations/2026-10-15-160011-backup-jobs-base-pin-and-storage-identity.sql && git commit -m "feat(backup): base-pin/storage-identity columns, DDL only, no backfill (D18 W01)"`

---

### Task 2: Drizzle schema edits — `backup.ts` new columns + `backupSnapshotRetirements` table

**Files:** Modify `apps/api/src/db/schema/backup.ts` (add to `backupJobs` after `snapshotId` ~:247, `backupSnapshots` after `backupType` ~:322, new table after `backupSnapshotFiles` ~:356).

**Interfaces:** Produces `backupSnapshotRetirements` Drizzle table export, `backupJobs.baseSnapshotId`/`.publishLeaseExpiresAt`/`.storageIdentity` (+ a matching partial index), `backupSnapshots.storageIdentity`.

- [ ] Step 1: There is no automated red/green test for this task. **Correction (review fix):** `pnpm db:check-drift` does NOT compare the Drizzle schema against a live database at all — it verifies migration-ledger parity (every file in `apps/api/migrations/` has exactly one `breeze_migrations` row after a fresh apply; see `scripts/check-drift.ts:17-24`'s own header comment: "What is intentionally NOT checked here. Schema-vs-live-DB drift..."). It cannot fail or pass based on anything in this task. The actual verification for a Drizzle schema change is: (a) `pnpm db:migrate` applies cleanly against a fresh DB, (b) running it a SECOND time is a true no-op (idempotency), and (c) the integration tests written in Task 13 actually insert/query through these Drizzle table objects against real Postgres — that is what proves the TypeScript column definitions match the real column types/names.
  Command (idempotency check, run against a disposable local DB): `pnpm db:migrate && pnpm db:migrate` — second run must report zero newly-applied migrations.

- [ ] Step 2: (No FAIL step — see Step 1's correction. Proceed directly to Step 3.)

- [ ] Step 3: Implement

```ts
// apps/api/src/db/schema/backup.ts — inside backupJobs' column object, after `snapshotId` (~:247)
    // D18 W01 (#5429/§3.1): server-chosen incremental-dedupe base for this
    // run. Deliberately NOT a FK — a pin must survive independent of the base
    // row's own lifecycle; retention checks this column directly.
    baseSnapshotId: varchar('base_snapshot_id', { length: 255 }),
    // Fixed publish deadline, set once at dispatch for EVERY dispatched
    // file/system_image job (base or not) — never renewed (no delivery
    // channel exists to renew it on progress). A pin is live while
    // status IN ('pending','running') OR
    // publish_lease_expires_at + BACKUP_PUBLISH_MARGIN_MS > now().
    publishLeaseExpiresAt: timestamp('publish_lease_expires_at', { withTimezone: true }),
    // D18 W01 (#5429/§3.6): the identity of the providerConfig actually
    // placed in the DISPATCH payload — stamped once, at dispatch, regardless
    // of whether a base was found. Copied onto backup_snapshots.storageIdentity
    // at publication so GC groups by write-time identity, not the config's
    // possibly-since-edited current one.
    storageIdentity: text('storage_identity'),
```

```ts
// apps/api/src/db/schema/backup.ts — inside backupSnapshots' column object, after `backupType` (~:322)
    // D18 W01 (#5429/§3.6): copied from the owning job's storageIdentity at
    // publication (or by reconcile from the adoptable job). Nullable FOREVER
    // — the W02 sweep self-heals a NULL row from the storage listing; there
    // is no follow-up NOT NULL migration.
    storageIdentity: text('storage_identity'),
```

```ts
// apps/api/src/db/schema/backup.ts — new table, placed after backupSnapshotFiles (~:356)
export const backupSnapshotRetirementReasonEnum = pgEnum('backup_snapshot_retirement_reason', [
  'expired',
  'max_versions',
  'manual',
]);

// D18 W01 (#5429/§3.3): a durable tombstone written the instant retention
// deletes a backup_snapshots row. Age alone cannot distinguish "expired" from
// "orphan" and cannot stop reconcile re-adopting an expired prefix mid-sweep
// — see the design doc's "why" note. Shape 1 (plain org_id) tenancy.
export const backupSnapshotRetirements = pgTable(
  'backup_snapshot_retirements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    configId: uuid('config_id').references(() => backupConfigs.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    snapshotId: varchar('snapshot_id', { length: BACKUP_SNAPSHOT_ID_MAX_LENGTH }).notNull(),
    storageIdentity: text('storage_identity').notNull(),
    backupType: backupTypeEnum('backup_type'),
    reason: backupSnapshotRetirementReasonEnum('reason').notNull(),
    retiredAt: timestamp('retired_at', { withTimezone: true }).defaultNow().notNull(),
    // Set by the GC sweep (W02) once the prefix is confirmed empty. NULL =
    // not yet swept. Rows are pruned 30d after this is set.
    sweptAt: timestamp('swept_at', { withTimezone: true }),
  },
  (table) => ({
    orgIdIdx: index('backup_snapshot_retirements_org_id_idx').on(table.orgId),
    storageIdentitySnapshotUq: uniqueIndex('backup_snapshot_retirements_identity_snapshot_uq').on(
      table.storageIdentity,
      table.snapshotId
    ),
    identitySweptIdx: index('backup_snapshot_retirements_identity_swept_idx').on(
      table.storageIdentity,
      table.sweptAt
    ),
  })
);
```

```ts
// apps/api/src/db/schema/backup.ts — inside backupJobs' (table) => ({...}) index block
// (alongside the existing snapshotIdIdx/statusIdx/etc.): a Drizzle-side partial
// index matching the migration's backup_jobs_base_snapshot_id_idx (Task 1).
    baseSnapshotIdIdx: index('backup_jobs_base_snapshot_id_idx')
      .on(table.baseSnapshotId)
      .where(sql`base_snapshot_id IS NOT NULL`),
```

  (`text` and `pgEnum` are already imported at the top of `backup.ts` — confirmed at lines 1-15. `sql` from `drizzle-orm` is already imported in this file, used by the existing `orgDefaultUq`/`snapshotIdIdx` partial-index definitions.)

- [ ] Step 4: Run, expect PASS
  Commands:
  - `pnpm db:migrate && pnpm db:migrate` (idempotency — second run is a no-op)
  - `docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "\d backup_jobs"` — confirm `backup_jobs_base_snapshot_id_idx` exists.

- [ ] Step 5: Commit
  `git add apps/api/src/db/schema/backup.ts && git commit -m "feat(backup): add base-pin/storage-identity columns and backupSnapshotRetirements schema (D18 W01)"`

---

### Task 3: `backup_snapshot_retirements` table + RLS migration

**Files:** Create `apps/api/migrations/2026-10-15-160012-backup-snapshot-retirements.sql`.

- [ ] Step 1: Write the failing test
  Command: `docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "SELECT * FROM backup_snapshot_retirements LIMIT 1;"` → expect `ERROR: relation "backup_snapshot_retirements" does not exist`.

- [ ] Step 2: Run it, expect FAIL (as above).

- [ ] Step 3: Implement

```sql
-- apps/api/migrations/2026-10-15-160012-backup-snapshot-retirements.sql
-- D18 W01 (#5429/§3.3): backup_snapshot_retirements — durable tombstone
-- written by retention the instant it deletes an expired/pruned
-- backup_snapshots row (see backupRetention.ts's cleanupExpiredSnapshots).
--
-- Shape 1 tenancy (plain org_id column), same RLS pattern as
-- 2026-04-11-bucket-a-rls-policies.sql:12-32. config_id cascades (a config's
-- deletion should not orphan its retirement ledger); device_id is SET NULL
-- (retirement history must survive the device being deleted).
--
-- Idempotent: IF NOT EXISTS throughout; DROP POLICY IF EXISTS before create.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'backup_snapshot_retirement_reason') THEN
    CREATE TYPE backup_snapshot_retirement_reason AS ENUM ('expired', 'max_versions', 'manual');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS backup_snapshot_retirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  config_id uuid REFERENCES backup_configs(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  snapshot_id varchar(200) NOT NULL,
  storage_identity text NOT NULL,
  backup_type backup_type,
  reason backup_snapshot_retirement_reason NOT NULL,
  retired_at timestamptz NOT NULL DEFAULT now(),
  swept_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS backup_snapshot_retirements_identity_snapshot_uq
  ON backup_snapshot_retirements (storage_identity, snapshot_id);

CREATE INDEX IF NOT EXISTS backup_snapshot_retirements_identity_swept_idx
  ON backup_snapshot_retirements (storage_identity, swept_at);

CREATE INDEX IF NOT EXISTS backup_snapshot_retirements_org_id_idx
  ON backup_snapshot_retirements (org_id);

DROP POLICY IF EXISTS breeze_org_isolation_select ON backup_snapshot_retirements;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON backup_snapshot_retirements;
DROP POLICY IF EXISTS breeze_org_isolation_update ON backup_snapshot_retirements;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON backup_snapshot_retirements;

ALTER TABLE backup_snapshot_retirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_snapshot_retirements FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON backup_snapshot_retirements
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON backup_snapshot_retirements
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON backup_snapshot_retirements
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON backup_snapshot_retirements
  FOR DELETE USING (public.breeze_has_org_access(org_id));
```

  Note: `varchar(200)` matches `BACKUP_SNAPSHOT_ID_MAX_LENGTH` (`apps/api/src/db/schema/backupConstants.ts`, confirmed value `200`) and `backup_jobs.snapshot_id`'s existing width (`apps/api/src/db/schema/backup.ts:247`) — this is deliberately narrower than `backup_jobs.base_snapshot_id`'s `varchar(255)` (Task 1, an explicit spec choice for that column); the two widths are independent and this one is pinned to the constant, not to the other.

- [ ] Step 4: Run, expect PASS
  Commands:
  - `pnpm db:migrate`
  - `docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "SELECT * FROM backup_snapshot_retirements LIMIT 1;"` → `0 rows`, no error.
  - `pnpm db:check-drift`

- [ ] Step 5: Commit
  `git add apps/api/migrations/2026-10-15-160012-backup-snapshot-retirements.sql && git commit -m "feat(backup): backup_snapshot_retirements table + RLS (D18 W01)"`

---

### Task 4: Registries — `tenantCascade.ts`, `devices/core.ts`, `tenantExportPolicyRegistry.ts`

**Files:** Modify `apps/api/src/services/tenantCascade.ts` (insert between the verified `'backup_sla_events'`/`'backup_snapshots'` lines), `apps/api/src/routes/devices/core.ts` (both lists), `apps/api/src/services/tenantExportPolicyRegistry.ts` (widen two entries + one new entry).

- [ ] Step 1: Write the failing test (these are existing contract tests — run them first to establish red/green)
  Commands:
  - `find apps/api/src -iname "tenantCascade*integration*"` to confirm the exact path, then `cd apps/api && npx vitest run <that path>`
  - `ls apps/api/src/routes/devices/*.test.ts | grep -iE "cascade|moveorg"` to confirm exact filenames, then run both
  - `grep -n check-tenant-export-policy apps/api/package.json` to confirm the invocation, then run it

- [ ] Step 2: Run against Task 2/3's new schema with NO registry edits yet, expect FAIL:
  - cascade test: `backup_snapshot_retirements has an org_id column but is missing from CORE_ORG_CASCADE_DELETE_ORDER`
  - device cascade tests: `backup_snapshot_retirements has a device_id column but is missing from CORE_DEVICE_CASCADE_DELETE_TABLES` / `...CORE_DEVICE_ORG_DENORMALIZED_TABLES`
  - export-policy check: `backup_jobs.base_snapshot_id`/`.publish_lease_expires_at`/`.storage_identity: unclassified`, `backup_snapshots.storage_identity: unclassified`, every `backup_snapshot_retirements.*` column unclassified.

- [ ] Step 3: Implement

```ts
// apps/api/src/services/tenantCascade.ts — insert between the verified 'backup_sla_events' and 'backup_snapshots' lines
  'backup_sla_configs',
  'backup_sla_events',
  'backup_snapshot_retirements',
  'backup_snapshots',
```

```ts
// apps/api/src/routes/devices/core.ts — CORE_DEVICE_ORG_DENORMALIZED_TABLES, same insertion point
  'backup_chains', 'backup_jobs', 'backup_sla_events', 'backup_snapshot_retirements',
  'backup_snapshots', 'backup_verifications',
```

```ts
// apps/api/src/routes/devices/core.ts — CORE_DEVICE_CASCADE_DELETE_TABLES
// (device_id is nullable ON DELETE SET NULL — no FK-direction ordering
// constraint against backup_snapshots/backup_jobs; added alongside them)
  'recovery_tokens', 'backup_chains',
  'restore_jobs', 'backup_verifications', 'backup_snapshots', 'backup_jobs', 'backup_snapshot_retirements',
```

```ts
// apps/api/src/services/tenantExportPolicyRegistry.ts — widen backup_jobs (verified current line)
  "backup_jobs": tablePolicy("org_id", {"included":["id","org_id","config_id","policy_id","feature_link_id","device_id","status","type","backup_mode","started_at","completed_at","total_size","transferred_size","file_count","error_count","error_log","snapshot_id","backup_type","last_progress_at","total_files","referenced_size","referenced_files","base_snapshot_id","publish_lease_expires_at","storage_identity","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["mode_targets","vss_metadata"]}),
```

```ts
// apps/api/src/services/tenantExportPolicyRegistry.ts — widen backup_snapshots (verified current line)
  "backup_snapshots": tablePolicy("org_id", {"included":["id","org_id","job_id","device_id","config_id","snapshot_id","label","location","timestamp","size","file_count","is_incremental","parent_snapshot_id","expires_at","storage_tier","is_immutable","immutable_until","legal_hold","legal_hold_reason","immutability_enforcement","requested_immutability_enforcement","immutability_fallback_reason","checksum_sha256","backup_type","storage_identity"],"reviewedIncluded":["encryption_key_id"],"excludedSensitive":[],"excludedOpen":["metadata","gfs_tags","hardware_profile","system_state_manifest"]}),
```

```ts
// apps/api/src/services/tenantExportPolicyRegistry.ts — new entry, alphabetically between backup_sla_events and backup_snapshots
  "backup_snapshot_retirements": tablePolicy("org_id", {"included":["id","org_id","config_id","device_id","snapshot_id","storage_identity","backup_type","reason","retired_at","swept_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

- [ ] Step 4: Run, expect PASS (same commands as Step 1)

- [ ] Step 5: Commit
  `git add apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts apps/api/src/services/tenantExportPolicyRegistry.ts && git commit -m "chore(backup): register backup_snapshot_retirements + new columns in cascade/export-policy registries (D18 W01)"`

---

### Task 5: `backupGcKnobs.ts` — shared per-run env-knob resolver

**Files:** Create `apps/api/src/services/backupGcKnobs.ts`, `apps/api/src/services/backupGcKnobs.test.ts`.

**Interfaces:** Produces `resolveMsKnob(envVarName: string, defaultMs: number, floorMs: number): number`, `resolveBackupBaseLeaseMs(): number`, `resolveBackupRestorePinLingerMs(): number`, `resolveBackupPublishMarginMs(): number`.

- [ ] Step 1: Write the failing test

```ts
// apps/api/src/services/backupGcKnobs.test.ts
import { describe, expect, it, afterEach } from 'vitest';
import {
  resolveMsKnob,
  resolveBackupBaseLeaseMs,
  resolveBackupRestorePinLingerMs,
  resolveBackupPublishMarginMs,
  BACKUP_BASE_LEASE_MS_DEFAULT,
  BACKUP_RESTORE_PIN_LINGER_MS_DEFAULT,
  BACKUP_PUBLISH_MARGIN_MS_DEFAULT,
} from './backupGcKnobs';

const ENV_VAR = 'BACKUP_TEST_KNOB_MS';

afterEach(() => {
  delete process.env[ENV_VAR];
  delete process.env.NODE_ENV;
});

describe('resolveMsKnob', () => {
  it('returns the default when unset', () => {
    expect(resolveMsKnob(ENV_VAR, 1000, 100)).toBe(1000);
  });

  it('returns the override when set to a valid positive number above the floor', () => {
    process.env[ENV_VAR] = '5000';
    expect(resolveMsKnob(ENV_VAR, 1000, 100)).toBe(5000);
  });

  it('ignores a non-numeric override and falls back to default', () => {
    process.env[ENV_VAR] = 'not-a-number';
    expect(resolveMsKnob(ENV_VAR, 1000, 100)).toBe(1000);
  });

  it('enforces the production floor', () => {
    process.env.NODE_ENV = 'production';
    process.env[ENV_VAR] = '10';
    expect(resolveMsKnob(ENV_VAR, 1000, 100)).toBe(100);
  });

  it('is resolved fresh on every call — not cached at module load', () => {
    expect(resolveMsKnob(ENV_VAR, 1000, 100)).toBe(1000);
    process.env[ENV_VAR] = '2000';
    expect(resolveMsKnob(ENV_VAR, 1000, 100)).toBe(2000);
  });
});

describe('per-knob defaults', () => {
  it('BACKUP_BASE_LEASE_MS / BACKUP_RESTORE_PIN_LINGER_MS default to 7 days, BACKUP_PUBLISH_MARGIN_MS to 1 hour', () => {
    expect(resolveBackupBaseLeaseMs()).toBe(BACKUP_BASE_LEASE_MS_DEFAULT);
    expect(resolveBackupRestorePinLingerMs()).toBe(BACKUP_RESTORE_PIN_LINGER_MS_DEFAULT);
    expect(resolveBackupPublishMarginMs()).toBe(BACKUP_PUBLISH_MARGIN_MS_DEFAULT);
    expect(BACKUP_BASE_LEASE_MS_DEFAULT).toBe(7 * 24 * 60 * 60 * 1000);
    expect(BACKUP_PUBLISH_MARGIN_MS_DEFAULT).toBe(60 * 60 * 1000);
  });
});
```

- [ ] Step 2: Run it, expect FAIL with `Cannot find module './backupGcKnobs'`
  Command: `cd apps/api && npx vitest run src/services/backupGcKnobs.test.ts`

- [ ] Step 3: Implement

```ts
// apps/api/src/services/backupGcKnobs.ts
/**
 * Shared per-run env-knob resolver for backup GC/retention timing constants.
 *
 * D18 (#5429): backupRetention.ts's existing BACKUP_GC_GRACE_MS is resolved
 * once at module load (`export const BACKUP_GC_GRACE_MS = resolve...()`),
 * so an env var change requires a process restart to take effect — a defect
 * called out in the design doc's ground truth. Every knob added here (and
 * every existing one W02 migrates here) is resolved FRESH on each call —
 * never captured into a module-level `const`.
 */
function resolveMsKnob(envVarName: string, defaultMs: number, floorMs: number): number {
  const raw = process.env[envVarName];
  if (raw === undefined || raw.trim() === '') return defaultMs;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      `[BackupGcKnobs] Ignoring ${envVarName}=${JSON.stringify(raw)} (not a positive number); using default ${defaultMs} ms`,
    );
    return defaultMs;
  }
  if (process.env.NODE_ENV === 'production' && n < floorMs) {
    console.warn(
      `[BackupGcKnobs] ${envVarName}=${n} is below the production floor; using ${floorMs} ms instead`,
    );
    return floorMs;
  }
  if (n !== defaultMs) {
    console.warn(`[BackupGcKnobs] ${envVarName} override active: ${n} ms (default ${defaultMs} ms)`);
  }
  return n;
}

export { resolveMsKnob };

/**
 * How long a base-snapshot pin (backup_jobs.base_snapshot_id) stays valid
 * after dispatch. Matches the agent's journal max-age (7 days) — a run
 * longer than this cannot resume anyway, so "must publish within the lease"
 * is the existing envelope made explicit (spec §3.1, §8 decision 2).
 */
export const BACKUP_BASE_LEASE_MS_DEFAULT = 7 * 24 * 60 * 60 * 1000;
const BACKUP_BASE_LEASE_MS_PRODUCTION_FLOOR = 60 * 60 * 1000;
export function resolveBackupBaseLeaseMs(): number {
  return resolveMsKnob('BACKUP_BASE_LEASE_MS', BACKUP_BASE_LEASE_MS_DEFAULT, BACKUP_BASE_LEASE_MS_PRODUCTION_FLOOR);
}

/**
 * How long a restore_jobs row keeps pinning its snapshot AFTER creation,
 * covering commandless/crashed restores (never reach a terminal status until
 * staleCommandReaper's own 1h rule fires) and helpers that keep reading past
 * the server's restore timeout.
 */
export const BACKUP_RESTORE_PIN_LINGER_MS_DEFAULT = 7 * 24 * 60 * 60 * 1000;
const BACKUP_RESTORE_PIN_LINGER_MS_PRODUCTION_FLOOR = 60 * 60 * 1000;
export function resolveBackupRestorePinLingerMs(): number {
  return resolveMsKnob(
    'BACKUP_RESTORE_PIN_LINGER_MS',
    BACKUP_RESTORE_PIN_LINGER_MS_DEFAULT,
    BACKUP_RESTORE_PIN_LINGER_MS_PRODUCTION_FLOOR,
  );
}

/**
 * Grace window added on top of publish_lease_expires_at before retention
 * treats a base pin as released (spec §3.1: "the margin is what turns the
 * pre-PUT check into a fence — the server keeps the pin for lease + margin,
 * so a PUT that starts inside the margin completes before the pin lapses").
 */
export const BACKUP_PUBLISH_MARGIN_MS_DEFAULT = 60 * 60 * 1000;
const BACKUP_PUBLISH_MARGIN_MS_PRODUCTION_FLOOR = 5 * 60 * 1000;
export function resolveBackupPublishMarginMs(): number {
  return resolveMsKnob(
    'BACKUP_PUBLISH_MARGIN_MS',
    BACKUP_PUBLISH_MARGIN_MS_DEFAULT,
    BACKUP_PUBLISH_MARGIN_MS_PRODUCTION_FLOOR,
  );
}
```

- [ ] Step 4: Run, expect PASS
  Command: `cd apps/api && npx vitest run src/services/backupGcKnobs.test.ts`

- [ ] Step 5: Commit
  `git add apps/api/src/services/backupGcKnobs.ts apps/api/src/services/backupGcKnobs.test.ts && git commit -m "feat(backup): add per-run env-knob resolver for GC/retention timing (D18 W01)"`

---

### Task 6: Dispatch — base selection, lease + storage-identity stamping, lock order job→snapshot

**Files:** Modify `apps/api/src/jobs/backupWorker.ts:26` (imports), new function placed just above `prepareBackupDispatchTargets` (before line 609), and the per-target loop body (`:742` insertion point). Test: `apps/api/src/jobs/backupWorker.test.ts`.

**Interfaces:**
- Consumes: `resolveBackupBaseLeaseMs()` from `./services/backupGcKnobs`; `normalizeStorageIdentity` from `./backupRetention`; `backupSnapshotRetirements` schema; `desc`/`or`/`gt` added to the `drizzle-orm` import.
- Produces: new function `stampDispatchPinAndIdentity(params): Promise<{ baseSnapshotId: string; publishLeaseExpiresAt: Date | null }>`, called for **every** dispatched target regardless of `commandType`. `storage_identity` is stamped on `backup_jobs` for every target, including `hyperv_backup`/`mssql_backup` (review fix — GC must be able to group those rows by identity too), but `publish_lease_expires_at` and `base_snapshot_id` are set/attempted only when `mode` is `'file'`/`'system_image'` (`mode: null` for hyperv/mssql skips the pin/lease logic entirely). Payload fields `baseSnapshotId: string` (`""` = full run) and `publishLeaseExpiresAt: string` (RFC3339) are added only to `backup_run` commands' payloads (unchanged — pins/leases stay file/system_image-only at the wire-protocol level per spec).

- [ ] Step 1: Write the failing test

```ts
// apps/api/src/jobs/backupWorker.test.ts — new describe block; add `transaction` to mockDb first:
//   const mockDb = { ..., transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(mockDb)) };
describe('prepareBackupDispatchTargets — base pin + storage identity (D18 W01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockReturnThis();
    mockDb.limit.mockResolvedValue([]);
    mockDb.transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(mockDb));
  });

  it('pins a base snapshot and includes baseSnapshotId/publishLeaseExpiresAt in the backup_run payload', async () => {
    let capturedCommand: { payload?: Record<string, unknown> } | undefined;
    agentRelayMock.dispatchCommandToAgent.mockImplementation(async (_agentId: string, command: any) => {
      capturedCommand = command;
      return { status: 'sent', via: 'local' };
    });
    // Three selects in the transaction, in order: (1) the base-candidate
    // lookup (.limit(1)), (2) the FOR SHARE lock on backup_snapshots ALONE
    // (.for('share') — no leftJoin, per the Postgres outer-join fix), and
    // (3) the plain, unlocked retirement-existence check (.limit(1),
    // returns [] = "not retired"). All three must resolve for the base to
    // be pinned.
    let selectCall = 0;
    mockDb.select.mockImplementation(() => {
      selectCall += 1;
      return {
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(
          selectCall === 1 ? [{ id: 'base-row-id', snapshotId: 'base-snap-1' }] : [],
        ),
        for: vi.fn().mockResolvedValue([{ id: 'base-row-id' }]),
      };
    });

    await __testOnly.processDispatchBackup(DATA as any);

    expect(capturedCommand?.payload?.baseSnapshotId).toBe('base-snap-1');
    expect(typeof capturedCommand?.payload?.publishLeaseExpiresAt).toBe('string');
  });

  it('sends baseSnapshotId "" and still sets publishLeaseExpiresAt when no eligible base exists', async () => {
    let capturedCommand: { payload?: Record<string, unknown> } | undefined;
    agentRelayMock.dispatchCommandToAgent.mockImplementation(async (_agentId: string, command: any) => {
      capturedCommand = command;
      return { status: 'sent', via: 'local' };
    });
    mockDb.select.mockImplementation(() => ({
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
      for: vi.fn().mockResolvedValue([]),
    }));

    await __testOnly.processDispatchBackup(DATA as any);

    expect(capturedCommand?.payload?.baseSnapshotId).toBe('');
    expect(typeof capturedCommand?.payload?.publishLeaseExpiresAt).toBe('string');
  });

  it('stamps storage_identity (but no lease/pin) on a hyperv_backup target', async () => {
    // Arrange DATA/resolveBackupTargets so this fan-out includes a hyperv
    // target (commandType: 'hyperv_backup'). Capture the backupJobs UPDATE
    // call for that target's job row.
    let capturedUpdateSet: Record<string, unknown> | undefined;
    mockDb.update.mockImplementation(() => ({
      set: (values: Record<string, unknown>) => {
        capturedUpdateSet = values;
        return { where: vi.fn().mockResolvedValue(undefined) };
      },
    }));

    await __testOnly.processDispatchBackup(DATA_WITH_HYPERV_TARGET as any);

    expect(capturedUpdateSet?.storageIdentity).toBeDefined();
    expect(capturedUpdateSet?.publishLeaseExpiresAt).toBeUndefined();
    expect(capturedUpdateSet?.baseSnapshotId).toBeUndefined();
  });
});
```

  (Adapt the exact chain shape to whatever `wireSelects()`-style helper this file already uses elsewhere in its suite — read the surrounding `describe('processDispatchBackup ...')` block before writing, and mirror its existing convention for routing `db.select({...})` calls by column-selector shape; the assertions above are the exact contract regardless of mock plumbing.)

- [ ] Step 2: Run it, expect FAIL with `capturedCommand?.payload?.baseSnapshotId` being `undefined`
  Command: `cd apps/api && npx vitest run src/jobs/backupWorker.test.ts`

- [ ] Step 3: Implement

```ts
// apps/api/src/jobs/backupWorker.ts:26 — widen the drizzle-orm import
import { eq, ne, and, or, desc, gt, sql, isNull, lt, inArray } from 'drizzle-orm';
```

```ts
// apps/api/src/jobs/backupWorker.ts — new imports. backupSnapshotRetirements
// is added to the EXISTING barrel import (`import { backupJobs,
// backupSnapshotFiles, backupSnapshots, backupConfigs, ... } from
// '../db/schema';`, confirmed at :11-23) rather than a separate line — this
// file already imports backupJobs/backupSnapshots from that same barrel.
import { resolveBackupBaseLeaseMs } from '../services/backupGcKnobs';
import { normalizeStorageIdentity } from './backupRetention';
```

```ts
// apps/api/src/jobs/backupWorker.ts:11-23 — add backupSnapshotRetirements to the existing barrel import
import {
  backupJobs,
  backupSnapshotFiles,
  backupSnapshots,
  backupSnapshotRetirements,
  backupConfigs,
  devices,
  configurationPolicies,
  organizations,
  configPolicyEffectiveFeatureLinks,
  configPolicyBackupSettings,
  hypervVms,
  sqlInstances,
} from '../db/schema';
```

```ts
// apps/api/src/jobs/backupWorker.ts — new function, placed just above prepareBackupDispatchTargets (before line 609)

/**
 * D18 §3.1/§3.6: stamps this job's storage_identity (from the providerConfig
 * actually placed in the dispatch payload) on EVERY dispatched target —
 * including `hyperv_backup`/`mssql_backup` (review fix: GC must be able to
 * group those rows by identity too, even though they never carry a base pin)
 * — and, only when `mode` is `'file'`/`'system_image'`, a FIXED publish-lease
 * deadline plus, when an eligible incremental-dedupe base exists, a pin on it.
 * `mode: null` (hyperv/mssql) stamps identity only and returns immediately.
 *
 * Lock order is JOB then SNAPSHOT (mirrors the parent-rows-first pattern at
 * routes/devices/moveOrg.ts:248-253): the UPDATE on backup_jobs below takes
 * the job row's lock first. The snapshot-row re-check is then done as TWO
 * separate statements, not one outer-joined `FOR SHARE` — Postgres rejects
 * `FOR UPDATE`/`FOR SHARE` on the nullable side of an outer join (review
 * fix: the original draft's `leftJoin(backupSnapshotRetirements, ...)` inside
 * a `.for('share')` chain is exactly that and would raise `0A000` at
 * runtime). First, `FOR SHARE` locks `backup_snapshots` ALONE; only once that
 * lock is held is `backup_snapshot_retirements` checked with a second, plain
 * (unlocked) SELECT — safe because by the time the FOR SHARE lock is granted,
 * any concurrent retention transaction that already inserted a retirement row
 * for this snapshot has either fully committed (so its retirement row is
 * visible here) or is blocked behind this same lock (so no retirement can
 * appear between the two selects). Retention's per-row delete
 * (backupRetention.ts) takes `FOR UPDATE` on the same snapshot row —
 * whichever side gets there first wins: the other either sees the live pin
 * (and skips) or finds the row already gone (and this function falls back to
 * a full run). No FK-column write happens while a lock from the other table
 * is held (cf. #3911's key-share deadlock).
 */
async function stampDispatchPinAndIdentity(params: {
  deviceId: string;
  configId: string;
  jobId: string;
  mode: 'file' | 'system_image' | null;
  provider: string;
  providerConfig: Record<string, unknown>;
}): Promise<{ baseSnapshotId: string; publishLeaseExpiresAt: Date | null }> {
  const storageIdentity = normalizeStorageIdentity(params.provider, params.providerConfig);

  if (params.mode === null) {
    // hyperv/mssql: identity only — no lease, no pin (spec: pins/leases are
    // file/system_image only; storage_identity stamping is not).
    await db.update(backupJobs).set({ storageIdentity }).where(eq(backupJobs.id, params.jobId));
    return { baseSnapshotId: '', publishLeaseExpiresAt: null };
  }
  const mode = params.mode;

  const leaseMs = resolveBackupBaseLeaseMs();
  const publishLeaseExpiresAt = new Date(Date.now() + leaseMs);

  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: backupSnapshots.id, snapshotId: backupSnapshots.snapshotId })
      .from(backupSnapshots)
      .innerJoin(backupJobs, eq(backupSnapshots.jobId, backupJobs.id))
      .where(
        and(
          eq(backupSnapshots.deviceId, params.deviceId),
          eq(backupSnapshots.configId, params.configId),
          mode === 'system_image'
            ? eq(backupSnapshots.backupType, 'system_image')
            : or(eq(backupSnapshots.backupType, 'file'), isNull(backupSnapshots.backupType)),
          or(isNull(backupSnapshots.expiresAt), gt(backupSnapshots.expiresAt, publishLeaseExpiresAt)),
          eq(backupJobs.status, 'completed'),
        ),
      )
      .orderBy(desc(backupSnapshots.timestamp))
      .limit(1);

    // Lock order: JOB row first (this UPDATE stamps identity/lease/tentative
    // pin unconditionally — every dispatched backup_run job gets these).
    await tx
      .update(backupJobs)
      .set({
        storageIdentity,
        publishLeaseExpiresAt,
        baseSnapshotId: candidate?.snapshotId ?? null,
      })
      .where(eq(backupJobs.id, params.jobId));

    if (!candidate) {
      return { baseSnapshotId: '', publishLeaseExpiresAt };
    }

    // SNAPSHOT row second, locked ALONE (see docstring for why the retirement
    // check cannot share this statement).
    const [locked] = await tx
      .select({ id: backupSnapshots.id })
      .from(backupSnapshots)
      .where(eq(backupSnapshots.id, candidate.id))
      .for('share');

    if (!locked) {
      // Row already gone — a concurrent retention delete won the race.
      await tx.update(backupJobs).set({ baseSnapshotId: null }).where(eq(backupJobs.id, params.jobId));
      return { baseSnapshotId: '', publishLeaseExpiresAt };
    }

    const [retirement] = await tx
      .select({ id: backupSnapshotRetirements.id })
      .from(backupSnapshotRetirements)
      .where(
        and(
          eq(backupSnapshotRetirements.storageIdentity, storageIdentity),
          eq(backupSnapshotRetirements.snapshotId, candidate.snapshotId),
        ),
      )
      .limit(1);

    if (retirement) {
      await tx.update(backupJobs).set({ baseSnapshotId: null }).where(eq(backupJobs.id, params.jobId));
      return { baseSnapshotId: '', publishLeaseExpiresAt };
    }

    return { baseSnapshotId: candidate.snapshotId, publishLeaseExpiresAt };
  });
}
```

```ts
// apps/api/src/jobs/backupWorker.ts — inside prepareBackupDispatchTargets's per-target loop,
// right before `const command: AgentCommand = {` (~:742). Called for EVERY
// target (review fix — identity stamping must cover hyperv/mssql too):

    const dispatchPin = await stampDispatchPinAndIdentity({
      deviceId: data.deviceId,
      configId: data.configId,
      jobId: commandJobId,
      mode:
        target.commandType === 'backup_run'
          ? ((target.payload as Record<string, unknown>).systemImage === true ? 'system_image' : 'file')
          : null,
      provider: config.provider,
      providerConfig: commandProviderConfig,
    });

    const command: AgentCommand = {
      id: commandJobId,
      type: target.commandType,
      payload: {
        jobId: commandJobId,
        configId: data.configId,
        provider: config.provider,
        providerConfig: commandProviderConfig,
        storageEncryption: encryptionPlan.required
          ? {
              required: true,
              mode: encryptionPlan.mode,
              keyReference: encryptionPlan.keyReference,
            }
          : {
              required: false,
              mode: 'disabled',
            },
        // Payload fields stay file/system_image-only (spec §3.1) even though
        // storage_identity is now stamped for every target above.
        ...(target.commandType === 'backup_run'
          ? {
              baseSnapshotId: dispatchPin.baseSnapshotId,
              publishLeaseExpiresAt: dispatchPin.publishLeaseExpiresAt!.toISOString(),
            }
          : {}),
        ...target.payload,
      },
    };
```

- [ ] Step 4: Run, expect PASS
  Command: `cd apps/api && npx vitest run src/jobs/backupWorker.test.ts`

- [ ] Step 5: Commit
  `git add apps/api/src/jobs/backupWorker.ts apps/api/src/jobs/backupWorker.test.ts && git commit -m "feat(backup): stamp storage identity + publish lease and pin the dedupe base at dispatch (D18 W01 §3.1/§3.6)"`

---

### Task 7: `staleCommandReaper.ts` — reap commandless pending restores after 1h

**Files:** Modify `apps/api/src/jobs/staleCommandReaper.ts` (new function + `REAPER_DOMAINS` entry, near `reapStaleBackupJobs` ~:1343-1482 and `:1496-1505`). Test: `apps/api/src/jobs/staleCommandReaper.test.ts`.

**Interfaces:** Produces `reapCommandlessPendingRestores(): Promise<number>`, registered as `['commandlessRestores', reapCommandlessPendingRestores]` in `REAPER_DOMAINS`.

- [ ] Step 1: Write the failing test

```ts
// apps/api/src/jobs/staleCommandReaper.test.ts — new case (mirror this file's existing db-mocking style for reapStaleBackupJobs)
  it('fails a commandless pending restore_jobs row older than 1h (D18 W01 §3.2 F8)', async () => {
    // Arrange: mockDb.update chain returns one row from .returning() for a
    // restore_jobs row with command_id NULL, status 'pending', created_at
    // 2h ago; a second row created 10 minutes ago must NOT match.
    const reaped = await reapCommandlessPendingRestores();
    expect(reaped).toBe(1);
    // Assert the update's `.set()` argument had status: 'failed'.
  });

  it('does not touch a restore that already has a command_id', async () => {
    // Arrange the same mocked update chain to return 0 rows when the WHERE
    // includes `command_id IS NULL` and the seeded row has a commandId set.
    const reaped = await reapCommandlessPendingRestores();
    expect(reaped).toBe(0);
  });
```

- [ ] Step 2: Run it, expect FAIL with `Cannot find name 'reapCommandlessPendingRestores'` (not exported yet)
  Command: `cd apps/api && npx vitest run src/jobs/staleCommandReaper.test.ts`

- [ ] Step 3: Implement

```ts
// apps/api/src/jobs/staleCommandReaper.ts — new constant, placed alongside the other Backup thresholds (~:97-100)
const RESTORE_COMMANDLESS_PENDING_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
```

```ts
// apps/api/src/jobs/staleCommandReaper.ts — new function, placed near reapStaleBackupJobs (~after :1482)

/**
 * D18 §3.2 (Codex F8): a restore_jobs row is created `pending` BEFORE its
 * command_id exists (routes/backup/restore.ts:281,361) — a crash between
 * those two statements leaves a row propagateTimedOutDeviceCommand can never
 * reach, because that path matches restores ONLY by command_id
 * (:220-240, `WHERE command_id = $1`). Without this reaper, such a row keeps
 * retention's restore pin alive past its linger only by luck of the linger
 * window, then pins forever with no path to a terminal status. This rule is
 * independent of that linger: any commandless pending row older than one
 * hour is failed outright, regardless of the (separately configurable)
 * BACKUP_RESTORE_PIN_LINGER_MS retention uses for its own pin check.
 */
export async function reapCommandlessPendingRestores(): Promise<number> {
  const cutoff = new Date(Date.now() - RESTORE_COMMANDLESS_PENDING_TIMEOUT_MS);
  const completedAt = new Date();
  const reapedRows = await db
    .update(restoreJobs)
    .set({
      status: 'failed',
      completedAt,
      updatedAt: completedAt,
      targetConfig: sql`coalesce(${restoreJobs.targetConfig}, '{}'::jsonb) || jsonb_build_object(
        'error', 'Restore never received a command (crashed before dispatch)'
      )`,
    })
    .where(
      and(
        isNull(restoreJobs.commandId),
        eq(restoreJobs.status, 'pending'),
        lt(restoreJobs.createdAt, cutoff),
      ),
    )
    .returning({ id: restoreJobs.id });

  if (reapedRows.length > 0) {
    console.log(`[StaleCommandReaper] Reaped ${reapedRows.length} commandless pending restore(s)`);
  }
  return reapedRows.length;
}
```

```ts
// apps/api/src/jobs/staleCommandReaper.ts — REAPER_DOMAINS (~:1496-1505), new entry
export const REAPER_DOMAINS = [
  ['deviceCommands', reapStaleDeviceCommands],
  ['scriptExecutions', reapStaleScriptExecutions],
  ['scriptCancellations', reapStaleCancellations],
  ['patchJobResults', reapStalePatchJobResults],
  ['deploymentDevices', reapStaleDeploymentDevices],
  ['softwareDeploymentResults', reapStaleSoftwareDeploymentResults],
  ['remoteSessions', reapStaleRemoteSessions],
  ['backupJobs', reapStaleBackupJobs],
  ['commandlessRestores', reapCommandlessPendingRestores],
] as const;
```

  `restoreJobs`, `sql`, `and`, `eq`, `lt`, `isNull` are already imported in this file (confirmed at the top-of-file `drizzle-orm` import and the existing `restoreJobs` usage in `propagateTimedOutDeviceCommand`).

- [ ] Step 4: Run, expect PASS
  Command: `cd apps/api && npx vitest run src/jobs/staleCommandReaper.test.ts`

- [ ] Step 5: Commit
  `git add apps/api/src/jobs/staleCommandReaper.ts apps/api/src/jobs/staleCommandReaper.test.ts && git commit -m "feat(backup): reap commandless pending restores after 1h (D18 W01 §3.2 F8)"`

---

### Task 8: Transaction boundaries (§3.7) — carve `cleanup-expired-snapshots` out of the worker's blanket wrap

**Files:** Modify `apps/api/src/jobs/backupWorker.ts:77-130` (`createBackupWorker`), `:325-395` (`processCleanupExpiredSnapshots`). Test: `apps/api/src/jobs/backupWorker.test.ts`.

**Interfaces — authoritative call shape for W02 (corrected per coordinator's second review pass):** this task's restructure of `processCleanupExpiredSnapshots` is the contract W02 builds on. After row-level retention has committed per row (Task 9), the handler wraps the sweep in exactly **ONE** shared context — `await runWithSystemDbAccess(() => sweepUnreferencedBackupObjects())` — matching today's read shape so `sweepUnreferencedBackupObjects`'s existing internal `db.select(...)` calls keep the working GUCs they rely on today (they have no context management of their own — Ground Truth, `backupRetention.ts:982`). This is deliberately ONE context for the whole sweep, not per-identity — W02 is expected to replace this single wrap with genuinely separate per-identity contexts internally (spec §3.7 item 2: "a separate system context per identity for the DB reads, with every storage call at depth 0"), at which point this call site's wrap is removed and the per-identity splitting moves inside `sweepUnreferencedBackupObjects` itself. This task adds no new fields to `processCleanupExpiredSnapshots`'s returned/logged result shape (`gcDeleted`/`gcSkippedIdentities`/`gcBlockedIdentities` only) — W02 is the one expected to add fields there as its own internal restructuring surfaces more detail.

**Why this task must land before Task 9:** Task 9 restructures `cleanupExpiredSnapshots` (in `backupRetention.ts`) to open its own real per-row transaction via `withSystemDbAccessContext`. That only works if the call arrives with NO ambient context already open — today it's nested inside the blanket `runWithSystemDbAccess(async () => { switch(...) {...} })` at `backupWorker.ts:101`, where a nested `withSystemDbAccessContext` call is a no-op passthrough (same outer transaction, no new commit boundary). This task removes that ambient wrap for `cleanup-expired-snapshots` the same way `dispatch-backup` is already excluded from it (`:89-99`), while the sweep call — which runs strictly AFTER every row's retention has already committed independently — gets its own single, separate context (see Interfaces above), so a sweep failure can never roll back a retirement that already committed.

- [ ] Step 1: Write the failing test — a source-text contract test, mirroring the style of `backupAgentContract.test.ts`'s cross-file literal checks, since this is a structural wiring invariant rather than a behavior a mock can observe.

```ts
// apps/api/src/jobs/backupWorker.test.ts — new case
  it('handles cleanup-expired-snapshots OUTSIDE the blanket runWithSystemDbAccess wrap (D18 W01 §3.7)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(path.resolve(__dirname, './backupWorker.ts'), 'utf-8');

    const cleanupBranchIndex = source.indexOf("data.type === 'cleanup-expired-snapshots'");
    const blanketWrapIndex = source.indexOf('return runWithSystemDbAccess(async () => {');
    const switchCleanupCaseIndex = source.indexOf("case 'cleanup-expired-snapshots':");

    expect(cleanupBranchIndex).toBeGreaterThan(-1);
    expect(blanketWrapIndex).toBeGreaterThan(-1);
    // The special-cased branch must appear BEFORE the blanket wrap.
    expect(cleanupBranchIndex).toBeLessThan(blanketWrapIndex);
    // The switch inside the blanket wrap must no longer have its own
    // 'cleanup-expired-snapshots' case.
    expect(switchCleanupCaseIndex).toBe(-1);
  });
```

- [ ] Step 2: Run it, expect FAIL — `cleanupBranchIndex` is `-1` and `switchCleanupCaseIndex` is still found inside the switch.
  Command: `cd apps/api && npx vitest run src/jobs/backupWorker.test.ts`

- [ ] Step 3: Implement

```ts
// apps/api/src/jobs/backupWorker.ts:77-130 — createBackupWorker, restructured
function createBackupWorker(): Worker<BackupQueueJobData> {
  return new Worker<BackupQueueJobData>(
    BACKUP_QUEUE,
    async (job: Job<BackupQueueJobData>) => {
      const data = parseQueueJobData(BACKUP_QUEUE, job, backupQueueJobDataSchema);
      // dispatch-backup is handled OUTSIDE the blanket context below (#1105):
      // it does Redis/WS I/O via the agentCommandRelay facade ...
      if (data.type === 'dispatch-backup') {
        assertQueueJobName(BACKUP_QUEUE, job, 'dispatch-backup');
        return await processDispatchBackup(data, { redelivered: job.attemptsStarted > 1 });
      }
      // cleanup-expired-snapshots is ALSO handled outside the blanket
      // context (D18 §3.7): its own retention pass must open one real
      // system-DB transaction PER CANDIDATE ROW so a retirement commits
      // durably before the next row is even considered, and the GC sweep
      // that follows must run in its own separate context so a sweep
      // failure can never roll back a retirement already committed.
      // processCleanupExpiredSnapshots (below) manages both of those
      // contexts itself — nesting it inside runWithSystemDbAccess here would
      // silently collapse every one of those into the single ambient
      // transaction this task exists to eliminate.
      if (data.type === 'cleanup-expired-snapshots') {
        assertQueueJobName(BACKUP_QUEUE, job, 'cleanup-expired-snapshots');
        return await processCleanupExpiredSnapshots();
      }
      return runWithSystemDbAccess(async () => {
        switch (data.type) {
          case 'check-schedules':
            assertQueueJobName(BACKUP_QUEUE, job, 'check-schedules');
            return await processCheckSchedules();
          case 'expire-recovery-tokens':
            assertQueueJobName(BACKUP_QUEUE, job, 'expire-recovery-tokens');
            return await processExpireRecoveryTokens();
          case 'process-results':
            assertQueueJobName(BACKUP_QUEUE, job, 'process-results');
            return await processResults(data);
          default:
            throw new Error(
              `Unknown job type: ${(data as { type: string }).type}`
            );
        }
      });
    },
    {
      connection: getBullMQConnection(),
      concurrency: 5,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    }
  );
}
```

```ts
// apps/api/src/jobs/backupWorker.ts:325-395 — processCleanupExpiredSnapshots, only the wrapping changes
export async function processCleanupExpiredSnapshots(): Promise<{
  deleted: number;
  skipped: number;
  prunedByMaxVersions: number;
  failed: number;
  gcDeleted: number;
  gcSkippedIdentities: number;
  gcBlockedIdentities: number;
}> {
  // D18 §3.7: this whole function now runs with NO ambient DB context (it is
  // called directly from the worker, no longer inside the blanket wrap) — the
  // read below and cleanupExpiredSnapshots's own per-row work each open their
  // OWN context explicitly.
  const orgRows = await runWithSystemDbAccess(() =>
    db.selectDistinct({ orgId: backupSnapshots.orgId }).from(backupSnapshots)
  );

  let deleted = 0;
  let skipped = 0;
  let prunedByMaxVersions = 0;
  let failed = 0;

  for (const { orgId } of orgRows) {
    // cleanupExpiredSnapshots (backupRetention.ts) opens its OWN per-
    // candidate-row system context internally — deliberately NOT wrapped
    // here, so each row's retirement-insert + delete commits independently
    // of every other row and of the sweep below.
    const result = await cleanupExpiredSnapshots(orgId);
    deleted += result.deleted;
    skipped += result.skippedLegalHold + result.skippedImmutable;
    prunedByMaxVersions += result.prunedByMaxVersions;
    failed += result.failed;
  }

  let gcDeleted = 0;
  let gcSkippedIdentities = 0;
  let gcBlockedIdentities = 0;
  try {
    // D18 §3.7 (authoritative shape for W02, corrected): ONE shared context
    // for the whole sweep — matches today's read shape, so
    // sweepUnreferencedBackupObjects's existing internal db.select(...) calls
    // keep the working GUCs they rely on (it has no context management of
    // its own). This runs strictly AFTER every row's retention has already
    // committed independently (Task 9), so a GC failure here can never roll
    // back a retirement that already committed, and a GC failure never fails
    // this job. W02 replaces this single wrap with genuinely separate
    // per-identity contexts managed inside sweepUnreferencedBackupObjects
    // itself.
    const gcResult = await runWithSystemDbAccess(() => sweepUnreferencedBackupObjects());
    gcDeleted = gcResult.deleted;
    gcSkippedIdentities = gcResult.skippedIdentities;
    gcBlockedIdentities = gcResult.blockedIdentities;
  } catch (err) {
    console.error('[BackupWorker] Backup object GC sweep failed — retention run still succeeded:', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }

  if (failed > 0) {
    throw new Error(
      `[BackupWorker] cleanup-expired-snapshots: ${failed} snapshot row delete(s) failed this run — ` +
      'see prior [BackupRetention] per-row error logs for detail; rows will be retried next run.'
    );
  }

  return { deleted, skipped, prunedByMaxVersions, failed, gcDeleted, gcSkippedIdentities, gcBlockedIdentities };
}
```

- [ ] Step 4: Run, expect PASS
  Command: `cd apps/api && npx vitest run src/jobs/backupWorker.test.ts`

- [ ] Step 5: Commit
  `git add apps/api/src/jobs/backupWorker.ts apps/api/src/jobs/backupWorker.test.ts && git commit -m "fix(backup): carve cleanup-expired-snapshots out of the blanket transaction wrap (D18 W01 §3.7)"`

---

### Task 9: Retention — per-row commits, pin checks (backup/restore/recovery), retirement insert

**Files:** Modify `apps/api/src/jobs/backupRetention.ts:9-31` (imports), `:159-171` (`RetentionCleanupResult`), `:189-221` (`deleteSnapshotRow`/`tryDeleteSnapshotRow`, rewritten), `:231-387` (`cleanupExpiredSnapshots`, read/pin/delete phases re-wrapped). Test: `apps/api/src/jobs/backupRetention.test.ts`.

**Interfaces:**
- Consumes: `withSystemDbAccessContext` from `../db`; `resolveBackupRestorePinLingerMs`/`resolveBackupPublishMarginMs` from `../services/backupGcKnobs`; `restoreJobs`, `backupSnapshotRetirements`, `IN_FLIGHT_BACKUP_JOB_STATUSES` from `../db/schema` (the barrel — resolved open question 3: `backupRetention.test.ts:34` mocks `'../db'` only, not `'../db/schema'`, and this file's existing imports already pull `backupSnapshots`/`backupPolicies`/`backupJobs`/`configPolicyBackupSettings`/`backupConfigs` from that same barrel, so the new symbols join that one import statement rather than a separate `'../db/schema/backup'` line); `recoveryTokens` from `../db/schema/recoveryTokens` (a direct, non-barrel import — the same convention `backupWorker.ts:24` already uses for this specific table); `gt` and `sql` added to the `drizzle-orm` import.
- Produces: `RetentionCleanupResult` gains `skippedPinned: number` AND `skippedUnresolved: number` (review fix). `tryDeleteSnapshotRow` now returns `'deleted' | 'pinned' | 'legalHold' | 'immutable' | 'unresolved' | 'failed'` (was `boolean`) and opens its own `withSystemDbAccessContext` per call — one real top-level transaction per candidate row, per §3.7. Legal-hold and immutability are now decided ONLY inside `deleteSnapshotRow`, re-read under the `FOR UPDATE` lock — the caller's enumeration-pass copy of those columns is no longer trusted (review fix). A row whose `storageIdentity` is `NULL` is skipped (not retired with an invented identity — the `unknown::<uuid>` fallback is removed entirely) and counted as `skippedUnresolved`; it is retried on a later run once identity resolves. Every lookup that matches a snapshot by its bare (agent-supplied) `snapshotId` string is scoped by `storageIdentity` too, since `backup_snapshots.snapshot_id` carries no uniqueness constraint (`schema/backup.ts:330`, `snapshotIdIdx` is a plain, non-unique index) — a bare `snapshotId` match alone is not guaranteed to identify one row.

- [ ] Step 1: Write the failing test — update the shared `chainable`/`mockDb` fixture first (it currently has no `.for()`, no `insert`, and the `'../db'` mock exports only `db`):

```ts
// apps/api/src/jobs/backupRetention.test.ts — fixture changes near the top of the file
function chainable(rows: unknown[]) {
  const obj: Record<string, unknown> = {
    from: () => obj,
    where: () => obj,
    leftJoin: () => obj,
    innerJoin: () => obj,
    orderBy: () => obj,
    limit: () => obj,
    for: () => obj,
    then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return obj;
}

const selectQueue: unknown[][] = [];
const insertedRows: unknown[] = [];

const mockDb = {
  select: vi.fn(() => chainable(selectQueue.shift() ?? [])),
  delete: vi.fn(() => chainable([])),
  update: vi.fn(() => chainable([])),
  insert: vi.fn((table: unknown) => ({
    values: (v: unknown) => {
      insertedRows.push(v);
      return chainable([]);
    },
  })),
};

vi.mock('../db', () => ({
  db: mockDb,
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
```

```ts
// apps/api/src/jobs/backupRetention.test.ts — new describe block
describe('cleanupExpiredSnapshots — pins + retirement (D18 W01 §3.2/§3.3/§3.7)', () => {
  beforeEach(() => {
    selectQueue.length = 0;
    insertedRows.length = 0;
  });

  it('skips a row pinned by an in-flight backup_jobs base pin and counts it as skippedPinned', async () => {
    selectQueue.push([{
      id: 'snap-1', snapshotId: 'snap-1-provider', metadata: null, legalHold: false,
      isImmutable: false, immutableUntil: null, provider: 's3', providerConfig: {},
      orgId: 'org-1', configId: 'config-1', deviceId: 'device-1', storageIdentity: 's3::e::b', backupType: 'file',
    }]); // candidate select (enumeration pass)
    selectQueue.push([{ id: 'snap-1', legalHold: false, isImmutable: false, immutableUntil: null }]); // FOR UPDATE lock, re-reads legal hold/immutability
    selectQueue.push([{ id: 'job-1' }]); // backup pin — found, short-circuits
    selectQueue.push([]); // versionBoundSnapshots pass (empty)

    const result = await cleanupExpiredSnapshots('org-1');

    expect(result.skippedPinned).toBe(1);
    expect(result.deleted).toBe(0);
    expect(insertedRows.length).toBe(0);
  });

  it('writes a retirement row and deletes the snapshot row when unpinned', async () => {
    selectQueue.push([{
      id: 'snap-2', snapshotId: 'snap-2-provider', metadata: null, legalHold: false,
      isImmutable: false, immutableUntil: null, provider: 's3', providerConfig: { bucket: 'b', endpoint: 'e' },
      orgId: 'org-1', configId: 'config-1', deviceId: 'device-1', storageIdentity: 's3::e::b', backupType: 'file',
    }]); // candidate select (enumeration pass)
    selectQueue.push([{ id: 'snap-2', legalHold: false, isImmutable: false, immutableUntil: null }]); // FOR UPDATE lock
    selectQueue.push([]); // backup pin — none
    selectQueue.push([]); // restore pin — none
    selectQueue.push([]); // recovery pin — none
    selectQueue.push([]); // versionBoundSnapshots pass (empty)

    const result = await cleanupExpiredSnapshots('org-1');

    expect(result.deleted).toBe(1);
    expect(result.skippedPinned).toBe(0);
    expect(insertedRows).toEqual([
      expect.objectContaining({ snapshotId: 'snap-2-provider', storageIdentity: 's3::e::b', reason: 'expired' }),
    ]);
  });

  it('re-reads legal hold under the FOR UPDATE lock, ignoring the (stale) enumeration-pass value', async () => {
    // Enumeration pass saw legalHold: false — the row was placed under hold
    // AFTER enumeration but BEFORE this row's turn. The lock re-read must win.
    selectQueue.push([{
      id: 'snap-3', snapshotId: 'snap-3-provider', metadata: null, legalHold: false,
      isImmutable: false, immutableUntil: null, provider: 's3', providerConfig: {},
      orgId: 'org-1', configId: 'config-1', deviceId: 'device-1', storageIdentity: 's3::e::b', backupType: 'file',
    }]);
    selectQueue.push([{ id: 'snap-3', legalHold: true, isImmutable: false, immutableUntil: null }]); // FOR UPDATE lock — now held
    selectQueue.push([]); // versionBoundSnapshots pass (empty)

    const result = await cleanupExpiredSnapshots('org-1');

    expect(result.skippedLegalHold).toBe(1);
    expect(result.deleted).toBe(0);
    expect(insertedRows.length).toBe(0);
  });

  it('skips (does not retire) a row with an unresolved storage_identity and counts it as skippedUnresolved', async () => {
    selectQueue.push([{
      id: 'snap-4', snapshotId: 'snap-4-provider', metadata: null, legalHold: false,
      isImmutable: false, immutableUntil: null, provider: 's3', providerConfig: {},
      orgId: 'org-1', configId: null, deviceId: 'device-1', storageIdentity: null, backupType: 'file',
    }]);
    selectQueue.push([{ id: 'snap-4', legalHold: false, isImmutable: false, immutableUntil: null }]); // FOR UPDATE lock
    selectQueue.push([]); // versionBoundSnapshots pass (empty)

    const result = await cleanupExpiredSnapshots('org-1');

    expect(result.skippedUnresolved).toBe(1);
    expect(result.deleted).toBe(0);
    expect(insertedRows.length).toBe(0); // no invented 'unknown::<uuid>' retirement is ever written
  });
});
```

- [ ] Step 2: Run it, expect FAIL — `result.skippedPinned`/`result.skippedUnresolved` are `undefined` (fields don't exist yet); `insertedRows` stays empty in the second case (no retirement is written today); the legal-hold re-read case fails because today's code decides legal hold from the enumeration pass, before the FOR UPDATE lock select is even issued.
  Command: `cd apps/api && npx vitest run src/jobs/backupRetention.test.ts`

- [ ] Step 3: Implement

```ts
// apps/api/src/jobs/backupRetention.ts:9-18 — widen imports
import { resolve as resolveLocalPath } from 'node:path';
import { db, withSystemDbAccessContext } from '../db';
import {
  backupSnapshots,
  backupPolicies,
  backupJobs,
  configPolicyBackupSettings,
  backupConfigs,
  restoreJobs,
  backupSnapshotRetirements,
  IN_FLIGHT_BACKUP_JOB_STATUSES,
} from '../db/schema';
import { recoveryTokens } from '../db/schema/recoveryTokens';
import { eq, and, or, lt, gt, desc, inArray, isNull, sql } from 'drizzle-orm';
import { resolveBackupRestorePinLingerMs, resolveBackupPublishMarginMs } from '../services/backupGcKnobs';
```

  (Resolved: `backupRetention.test.ts:34` only mocks `vi.mock('../db', () => ({ db: mockDb }))` — there is no `vi.mock('../db/schema', ...)` in this file at all, so real schema symbols always flow through regardless of which schema path they're imported from. The existing imports (`backupSnapshots`/`backupPolicies`/`backupJobs`/`configPolicyBackupSettings`/`backupConfigs`) already come from the barrel `'../db/schema'`, so `restoreJobs`/`backupSnapshotRetirements`/`IN_FLIGHT_BACKUP_JOB_STATUSES` join that same statement rather than introducing a second, `'../db/schema/backup'`-rooted import for the same underlying module.)

```ts
// apps/api/src/jobs/backupRetention.ts:159-171 — RetentionCleanupResult gains fields
export type RetentionCleanupResult = {
  deleted: number;
  skippedLegalHold: number;
  skippedImmutable: number;
  skippedPinned: number;
  // D18 review fix: a row whose storage_identity is unresolved (NULL) is
  // never retired with an invented identity — it is retried on a later run
  // once identity resolves (a live write stamping it, or W02's sweep
  // self-heal). Counted separately from skippedPinned so operators can see
  // "how many rows are stuck on identity resolution" distinctly.
  skippedUnresolved: number;
  prunedByMaxVersions: number;
  failed: number;
};
```

```ts
// apps/api/src/jobs/backupRetention.ts:189-221 — replace deleteSnapshotRow + tryDeleteSnapshotRow
type DeleteSnapshotOutcome = 'deleted' | 'pinned' | 'legalHold' | 'immutable' | 'unresolved';

/**
 * Deletes a `backup_snapshots` ROW ONLY, after RE-READING legal hold /
 * immutability under the row's own `FOR UPDATE` lock (review fix — the
 * caller's enumeration-pass copy of those columns can be stale by the time
 * this row's turn comes up: a hold set or cleared in between must be honored
 * NOW, not then), checking every pin type (D18 §3.2: backup-job base pin via
 * publish_lease_expires_at + margin, restore-job pin, recovery-token pin),
 * and writing a durable retirement tombstone (backup_snapshot_retirements) in
 * the SAME per-row system context as the delete. The caller
 * (`tryDeleteSnapshotRow`) wraps this whole function in its own
 * `withSystemDbAccessContext` call — since `cleanupExpiredSnapshots` is no
 * longer invoked from inside any ambient transaction (D18 §3.7,
 * jobs/backupWorker.ts), that call opens a REAL top-level Postgres
 * transaction distinct from every other row's, so a retirement written here
 * commits durably before the next candidate row is even considered.
 *
 * A row whose `storage_identity` is NULL is never retired with an invented
 * identity (review fix — the earlier `unknown::<uuid>` fallback is removed
 * entirely): a retirement's uniqueness and every lookup against it is keyed
 * on `(storage_identity, snapshot_id)`, and a fabricated identity would let
 * two genuinely different unresolved rows collide, or hand GC an identity it
 * can never match against a real bucket listing. Such a row is left alone
 * (`'unresolved'`) and retried on a later run once identity resolves.
 *
 * Every lookup that matches a row by the bare (agent-supplied) `snapshotId`
 * string is additionally scoped by `storageIdentity`, since
 * `backup_snapshots.snapshot_id` carries no uniqueness constraint
 * (`schema/backup.ts:330` — `snapshotIdIdx` is a plain, non-unique index): a
 * bare string match alone is not guaranteed to identify the row this
 * function is actually retiring.
 *
 * Deliberately does NOT touch object storage — under the incremental/
 * synthetic-full manifest model, an incremental snapshot's unchanged files
 * are references whose backupPath points into an OLDER snapshot's prefix, so
 * eagerly nuking this snapshot's whole storage prefix the instant its row
 * expires would delete objects a still-retained sibling snapshot's manifest
 * still points at. Object deletion is the mark-and-sweep GC's exclusive job
 * (sweepUnreferencedBackupObjects, W02): the retirement row this function
 * writes is what lets that sweep treat this snapshot's exclusive objects as
 * garbage immediately, with no age-based ambiguity between "expired" and
 * merely "orphaned".
 */
async function deleteSnapshotRow(params: {
  id: string;
  snapshotId: string;
  orgId: string;
  configId: string | null;
  deviceId: string | null;
  storageIdentity: string | null;
  backupType: (typeof backupSnapshots.$inferSelect)['backupType'];
  reason: 'expired' | 'max_versions';
}): Promise<DeleteSnapshotOutcome> {
  const now = new Date();
  const restoreLingerMs = resolveBackupRestorePinLingerMs();
  const restoreLingerCutoff = new Date(Date.now() - restoreLingerMs);
  const publishMarginMs = resolveBackupPublishMarginMs();
  const publishMarginCutoff = new Date(Date.now() - publishMarginMs);

  const [locked] = await db
    .select({
      id: backupSnapshots.id,
      legalHold: backupSnapshots.legalHold,
      isImmutable: backupSnapshots.isImmutable,
      immutableUntil: backupSnapshots.immutableUntil,
    })
    .from(backupSnapshots)
    .where(eq(backupSnapshots.id, params.id))
    .for('update');

  if (!locked) {
    // Already gone (concurrent delete/adoption) — nothing to do.
    return 'deleted';
  }

  // Re-read under the lock — authoritative, not the enumeration pass's copy.
  if (locked.legalHold) return 'legalHold';
  if (locked.isImmutable && locked.immutableUntil && locked.immutableUntil > now) return 'immutable';

  if (!params.storageIdentity) return 'unresolved';
  const storageIdentity = params.storageIdentity;

  // Backup pin (§3.1/§3.2): a backup_jobs row still building on this snapshot
  // as its base, SCOPED BY storageIdentity (a bare snapshotId match is not
  // enough — see docstring). status IN (pending, running) covers an
  // in-flight run; publish_lease_expires_at > now() - margin covers a
  // reaped-but-still-uploading helper (the same lease+margin the helper
  // itself enforces before publishing — see spec §3.1's "publish margin").
  const [backupPin] = await db
    .select({ id: backupJobs.id })
    .from(backupJobs)
    .where(
      and(
        eq(backupJobs.baseSnapshotId, params.snapshotId),
        eq(backupJobs.storageIdentity, storageIdentity),
        or(
          inArray(backupJobs.status, IN_FLIGHT_BACKUP_JOB_STATUSES),
          gt(backupJobs.publishLeaseExpiresAt, publishMarginCutoff),
        ),
      ),
    )
    .limit(1);
  if (backupPin) return 'pinned';

  // Restore pin (§3.2, F8): scoped by the row's own uuid (backupSnapshots.id)
  // — unambiguous already, no storageIdentity scoping needed here. The
  // in-flight status check only counts once a command exists (a commandless
  // pending row is reaped by staleCommandReaper's own 1h rule, Task 7,
  // instead of pinning forever); the linger separately covers both that
  // crash window and a helper reading past the server's restore timeout.
  const [restorePin] = await db
    .select({ id: restoreJobs.id })
    .from(restoreJobs)
    .where(
      and(
        eq(restoreJobs.snapshotId, params.id),
        or(
          and(inArray(restoreJobs.status, ['pending', 'running']), sql`${restoreJobs.commandId} IS NOT NULL`),
          gt(restoreJobs.createdAt, restoreLingerCutoff),
        ),
      ),
    )
    .limit(1);
  if (restorePin) return 'pinned';

  // Recovery pin (§3.2): also scoped by the row's own uuid — unambiguous.
  // Active/authenticated token, or one not yet completed and still within
  // its expiry + the same linger (covers a BMR session mid-download).
  const [recoveryPin] = await db
    .select({ id: recoveryTokens.id })
    .from(recoveryTokens)
    .where(
      and(
        eq(recoveryTokens.snapshotId, params.id),
        or(
          inArray(recoveryTokens.status, ['active', 'authenticated']),
          and(isNull(recoveryTokens.completedAt), gt(recoveryTokens.expiresAt, restoreLingerCutoff)),
        ),
      ),
    )
    .limit(1);
  if (recoveryPin) return 'pinned';

  await db.insert(backupSnapshotRetirements).values({
    orgId: params.orgId,
    configId: params.configId,
    deviceId: params.deviceId,
    snapshotId: params.snapshotId,
    storageIdentity,
    backupType: params.backupType,
    reason: params.reason,
  });

  await db.delete(backupSnapshots).where(eq(backupSnapshots.id, params.id));
  return 'deleted';
}

/**
 * D18 §3.7: opens ONE real top-level Postgres transaction per candidate row
 * (`withSystemDbAccessContext`, called with no ambient context already open
 * — see Task 8) so a `deleteSnapshotRow` outcome (retirement insert + row
 * delete) for THIS row commits independently of every other row's outcome
 * and of the D17 `failed > 0` throw at the end of `cleanupExpiredSnapshots`.
 * An unexpected DB error (lock timeout, connection blip, an
 * as-yet-unregistered referencing table) is caught here rather than aborting
 * the whole cleanup pass — logged with the PG SQLSTATE/constraint when the
 * driver surfaces one, and the row is simply retried on the next run.
 */
async function tryDeleteSnapshotRow(snap: {
  id: string;
  snapshotId: string;
  orgId: string;
  configId: string | null;
  deviceId: string | null;
  storageIdentity: string | null;
  backupType: (typeof backupSnapshots.$inferSelect)['backupType'];
  reason: 'expired' | 'max_versions';
}): Promise<DeleteSnapshotOutcome | 'failed'> {
  try {
    return await withSystemDbAccessContext(() => deleteSnapshotRow(snap));
  } catch (error) {
    const code = pgErrorCode(error);
    const constraint = pgErrorConstraint(error);
    console.error(
      `[BackupRetention] Failed to delete snapshot ${snap.snapshotId} (id ${snap.id})` +
      (code ? ` — PG ${code}` : ' — no PG SQLSTATE on the error') +
      (constraint ? ` (constraint ${constraint})` : '') +
      ' — skipping this row; will retry next run:',
      error,
    );
    return 'failed';
  }
}
```

```ts
// apps/api/src/jobs/backupRetention.ts:231-387 — cleanupExpiredSnapshots, both read phases
// wrapped in their own context, both delete loops route through the same
// outcome-to-counter mapping. Legal hold / immutability are NO LONGER decided
// here (review fix) — the enumeration selects below still fetch those columns
// only because groupRows/versionBoundSnapshots still needs other row fields;
// the authoritative decision is made inside deleteSnapshotRow, under the lock.
function applyDeleteOutcome(result: RetentionCleanupResult, outcome: DeleteSnapshotOutcome | 'failed'): void {
  switch (outcome) {
    case 'deleted': result.deleted++; break;
    case 'pinned': result.skippedPinned++; break;
    case 'legalHold': result.skippedLegalHold++; break;
    case 'immutable': result.skippedImmutable++; break;
    case 'unresolved': result.skippedUnresolved++; break;
    case 'failed': result.failed++; break;
  }
}

export async function cleanupExpiredSnapshots(
  orgId: string
): Promise<RetentionCleanupResult> {
  const now = new Date();
  const result: RetentionCleanupResult = {
    deleted: 0,
    skippedLegalHold: 0,
    skippedImmutable: 0,
    skippedPinned: 0,
    skippedUnresolved: 0,
    prunedByMaxVersions: 0,
    failed: 0,
  };

  // D18 §3.7: this read runs with no ambient context (cleanupExpiredSnapshots
  // is no longer called from inside one) — a snapshot-in-time read is fine
  // here since every candidate is independently re-verified (legal hold,
  // immutability, storage identity, every pin) with FOR UPDATE inside its own
  // per-row commit below.
  const expired = await withSystemDbAccessContext(() =>
    db
      .select({
        id: backupSnapshots.id,
        snapshotId: backupSnapshots.snapshotId,
        deviceId: backupSnapshots.deviceId,
        configId: backupSnapshots.configId,
        storageIdentity: backupSnapshots.storageIdentity,
        backupType: backupSnapshots.backupType,
      })
      .from(backupSnapshots)
      .where(
        and(
          eq(backupSnapshots.orgId, orgId),
          lt(backupSnapshots.expiresAt, now)
        )
      )
  );

  for (const snap of expired) {
    const outcome = await tryDeleteSnapshotRow({
      id: snap.id,
      snapshotId: snap.snapshotId,
      orgId,
      configId: snap.configId,
      deviceId: snap.deviceId,
      storageIdentity: snap.storageIdentity,
      backupType: snap.backupType,
      reason: 'expired',
    });
    applyDeleteOutcome(result, outcome);
  }

  const versionBoundSnapshots = await withSystemDbAccessContext(() =>
    db
      .select({
        id: backupSnapshots.id,
        snapshotId: backupSnapshots.snapshotId,
        timestamp: backupSnapshots.timestamp,
        deviceId: backupSnapshots.deviceId,
        configId: backupSnapshots.configId,
        storageIdentity: backupSnapshots.storageIdentity,
        backupType: backupSnapshots.backupType,
        retention: configPolicyBackupSettings.retention,
      })
      .from(backupSnapshots)
      .innerJoin(backupJobs, eq(backupSnapshots.jobId, backupJobs.id))
      .leftJoin(
        configPolicyBackupSettings,
        eq(backupJobs.featureLinkId, configPolicyBackupSettings.featureLinkId),
      )
      .where(eq(backupSnapshots.orgId, orgId))
      .orderBy(
        backupSnapshots.deviceId,
        backupSnapshots.configId,
        desc(backupSnapshots.timestamp),
      )
  );

  const snapshotsByGroup = new Map<string, typeof versionBoundSnapshots>();
  for (const row of versionBoundSnapshots) {
    const groupKey = `${row.deviceId}:${row.configId ?? 'none'}`;
    const existing = snapshotsByGroup.get(groupKey);
    if (existing) existing.push(row);
    else snapshotsByGroup.set(groupKey, [row]);
  }

  for (const groupRows of snapshotsByGroup.values()) {
    const retention = groupRows[0]?.retention as Record<string, unknown> | null | undefined;
    const maxVersions = typeof retention?.maxVersions === 'number' ? retention.maxVersions : null;
    if (!maxVersions || maxVersions < 1 || groupRows.length <= maxVersions) continue;

    for (const snap of groupRows.slice(maxVersions)) {
      const outcome = await tryDeleteSnapshotRow({
        id: snap.id,
        snapshotId: snap.snapshotId,
        orgId,
        configId: snap.configId,
        deviceId: snap.deviceId,
        storageIdentity: snap.storageIdentity,
        backupType: snap.backupType,
        reason: 'max_versions',
      });
      if (outcome === 'deleted') result.prunedByMaxVersions++;
      applyDeleteOutcome(result, outcome);
    }
  }

  if (
    result.deleted > 0 || result.skippedLegalHold > 0 || result.skippedImmutable > 0 ||
    result.skippedPinned > 0 || result.skippedUnresolved > 0 || result.prunedByMaxVersions > 0 || result.failed > 0
  ) {
    console.log(
      `[BackupRetention] Org ${orgId}: deleted ${result.deleted}, ` +
      `skipped ${result.skippedLegalHold} (legal hold), ${result.skippedImmutable} (immutable), ` +
      `${result.skippedPinned} (pinned), ${result.skippedUnresolved} (unresolved identity), ` +
      `pruned ${result.prunedByMaxVersions} by maxVersions` +
      (result.failed > 0 ? `, FAILED ${result.failed} delete(s) (see prior per-row errors — will retry next run)` : '')
    );
  }

  if (result.failed > 0) {
    const summary =
      `[BackupRetention] Org ${orgId}: ${result.failed} snapshot row delete(s) failed this run — ` +
      'see prior per-row error logs for the specific snapshot id(s) and PG error; will retry next run.';
    console.error(summary);
    captureException(new Error(summary));
  }

  return result;
}
```

  Note: `applyDeleteOutcome` double-counts `'deleted'` into `prunedByMaxVersions` deliberately in the max-versions loop (increment `prunedByMaxVersions` first, then call the shared helper which ALSO increments `deleted`) — this mirrors the pre-existing behavior where a max-versions prune counts as both a deletion and a prune, unchanged from before this task.

- [ ] Step 4: Run, expect PASS
  Command: `cd apps/api && npx vitest run src/jobs/backupRetention.test.ts`

- [ ] Step 5: Commit
  `git add apps/api/src/jobs/backupRetention.ts apps/api/src/jobs/backupRetention.test.ts && git commit -m "feat(backup): retention checks base/restore/recovery pins and writes a retirement row per committed row (D18 W01 §3.2/§3.3/§3.7)"`

---

### Task 10: Lineage on write — `resultSchemas.ts` + `backupResultPersistence.ts` + late-result fence

**Files:** Modify `apps/api/src/routes/backup/resultSchemas.ts:27-32`, `apps/api/src/services/backupResultPersistence.ts:1041-1051` (widen `updatedJob` select), `:972-981` area (new pre-check before the main UPDATE), `:1143-1162` (`snapshotValues`); `apps/api/src/jobs/queueSchemas.ts` (`backupSnapshotSummarySchema`, `.strict()`); `apps/api/src/jobs/backupEnqueue.ts` (`ProcessResultsResult.snapshot` interface). Test: `apps/api/src/services/backupResultPersistence.test.ts`, plus a new queue-round-trip regression test.

**Interfaces:**
- Produces: `backupSnapshotResultSchema` gains `baseSnapshotId?: string`, `formatVersion?: number`, `backupIdentity?: string`.
- Produces: `backupSnapshots.parentSnapshotId`/`.isIncremental`/`.storageIdentity` are now set on every successful write; `storageIdentity` is **copied from the job's own stamped `storageIdentity`** (Task 6), never recomputed from the config; the base-row lookup for `parentSnapshotId` is scoped by `(storageIdentity, snapshotId)`, not `(configId, snapshotId)` — `snapshot_id` carries no uniqueness constraint (review fix, `schema/backup.ts:330`).
- Produces: a late result for a reaped-terminal job is rejected with `errorLog` containing `publish_lease_expired` (also fires when the lease is NULL — review fix, no implicit pass) or `base_retired` when the fence fails. The whole check-and-write happens inside one `db.transaction` with `FOR UPDATE` on the job row, scoped by `(id, deviceId)` matching the file's own #3036 tenant-scoping convention (review fix — atomic against a concurrently running `staleCommandReaper` pass, and never keyed on job id alone).
- **P1 queue-schema propagation (review finding):** `apps/api/src/jobs/queueSchemas.ts`'s `backupSnapshotSummarySchema` is `.strict()` and does not yet declare `baseSnapshotId`/`formatVersion`/`backupIdentity` — every one of this task's new fields is silently stripped (or the whole `.strict()` parse throws) before `backupWorker.ts`'s `process-results` handler (`parseQueueJobData` at `:81`) or the earlier `enqueueBackupResults` call in `backupEnqueue.ts` ever sees them, making the lineage fields dead on arrival end to end. This task widens `backupSnapshotSummarySchema` (queue ingress/egress validation) AND the plain TS interface `ProcessResultsResult.snapshot` (`backupEnqueue.ts:105-115`, which has no `baseSnapshotId`/`formatVersion` fields today either) to match `resultSchemas.ts`'s `backupSnapshotResultSchema` shape, and adds a regression test proving a result carrying these fields survives an `enqueueBackupResults` → `parseQueueJobData` round trip.

- [ ] Step 1: Write the failing test

```ts
// apps/api/src/services/backupResultPersistence.test.ts — new cases (mirror this file's existing mocking style;
// capture the object passed to db.insert(backupSnapshots).values(...) / db.update(backupSnapshots).set(...) via
// this file's existing insert/update capture mechanism — read the file's current tests for the exact spy shape
// before writing, since it wasn't fully quoted in Ground Truth)
  it('sets parentSnapshotId/isIncremental/storageIdentity from the job and result (D18 W01)', async () => {
    // Arrange: updatedJob's widened .returning() resolves { id, orgId, configId,
    // backupType, backupMode, baseSnapshotId: 'snap-1', publishLeaseExpiresAt: <future>,
    // storageIdentity: 's3::e::b' }; a lookup for the base row by
    // (storageIdentity='s3::e::b', snapshotId='snap-1') returns { id: 'base-db-id' }.
    let capturedSnapshotValues: Record<string, unknown> | undefined;
    // Wire this file's backupSnapshots insert/update mock to capture its argument:
    //   mockDb.insert.mockImplementation((table) => table === backupSnapshots
    //     ? { values: (v: Record<string, unknown>) => { capturedSnapshotValues = v; return chainable([{ id: 'new-snap-db-id' }]); } }
    //     : defaultInsertChain(table));

    const result = await applyBackupCommandResultToJob({
      jobId: 'job-1', orgId: 'org-1', deviceId: 'device-1', resultStatus: 'completed',
      result: {
        snapshotId: 'snap-2', snapshot: { id: 'snap-2', baseSnapshotId: 'snap-1', formatVersion: 2, files: [] },
        filesBackedUp: 0, bytesBackedUp: 0, referencedFiles: 5,
      } as any,
      source: 'agent',
    });

    expect(result.applied).toBe(true);
    // Discriminating assertions (review fix — applied===true alone proves
    // nothing about lineage correctness):
    expect(capturedSnapshotValues?.parentSnapshotId).toBe('base-db-id');
    expect(capturedSnapshotValues?.isIncremental).toBe(true);
    expect(capturedSnapshotValues?.storageIdentity).toBe('s3::e::b');
  });

  it('fails a late result with publish_lease_expired when the job is reaped-terminal and its lease has passed', async () => {
    // Arrange: job row (returned by the FOR UPDATE select mock) is 'failed'
    // with STALE_BACKUP_REAP_MARKER, publishLeaseExpiresAt in the past.
    let capturedUpdateSet: Record<string, unknown> | undefined;
    // Wire mockDb.update(backupJobs).set(...) to capture its argument.

    const result = await applyBackupCommandResultToJob({
      jobId: 'job-2', orgId: 'org-1', deviceId: 'device-1', resultStatus: 'completed',
      result: { snapshotId: 'snap-3', snapshot: { id: 'snap-3' }, filesBackedUp: 1, bytesBackedUp: 1 } as any,
      source: 'agent',
    });

    expect(result.applied).toBe(true);
    expect(result.snapshotDbId).toBeNull();
    expect(capturedUpdateSet?.status).toBe('failed');
    expect(capturedUpdateSet?.errorLog).toContain('publish_lease_expired');
  });

  it('fails a late result with publish_lease_expired when the lease is NULL (review fix: no implicit pass)', async () => {
    // Arrange: job row is 'failed' with STALE_BACKUP_REAP_MARKER,
    // publishLeaseExpiresAt: null (anomalous/legacy — must fail closed, not
    // be treated as "no fence applies").
    let capturedUpdateSet: Record<string, unknown> | undefined;

    const result = await applyBackupCommandResultToJob({
      jobId: 'job-2b', orgId: 'org-1', deviceId: 'device-1', resultStatus: 'completed',
      result: { snapshotId: 'snap-3b', snapshot: { id: 'snap-3b' }, filesBackedUp: 1, bytesBackedUp: 1 } as any,
      source: 'agent',
    });

    expect(result.applied).toBe(true);
    expect(capturedUpdateSet?.errorLog).toContain('publish_lease_expired');
  });

  it('fails a late result with base_retired when the lease is live but the base row is gone', async () => {
    // Arrange: job row is 'failed' with STALE_BACKUP_REAP_MARKER,
    // publishLeaseExpiresAt in the future, baseSnapshotId set, storageIdentity
    // set, and the (storageIdentity, snapshotId)-scoped lookup finds NO row
    // (retired + swept, or never existed).
    let capturedUpdateSet: Record<string, unknown> | undefined;

    const result = await applyBackupCommandResultToJob({
      jobId: 'job-3', orgId: 'org-1', deviceId: 'device-1', resultStatus: 'completed',
      result: { snapshotId: 'snap-4', snapshot: { id: 'snap-4' }, filesBackedUp: 1, bytesBackedUp: 1 } as any,
      source: 'agent',
    });

    expect(result.applied).toBe(true);
    expect(capturedUpdateSet?.errorLog).toContain('base_retired');
  });

  it('does not fence a late result for a DIFFERENT device carrying the same job id (device predicate, review fix)', async () => {
    // Arrange: no row matches (id=jobId AND deviceId='device-1') because the
    // real job row belongs to a different device — the FOR UPDATE select
    // returns undefined, so the fence must not fire at all (falls through
    // to the pre-existing terminalJobGuard/statusGuard behavior on the main
    // UPDATE, unrelated to this fence).
    const result = await applyBackupCommandResultToJob({
      jobId: 'job-4', orgId: 'org-1', deviceId: 'device-1', resultStatus: 'completed',
      result: { snapshotId: 'snap-5', snapshot: { id: 'snap-5' }, filesBackedUp: 1, bytesBackedUp: 1 } as any,
      source: 'agent',
    });
    // No fence-triggered update should have happened; whatever `result`
    // ultimately is depends on the main UPDATE's own device-scoped guard,
    // not on this fence firing.
    expect(result.applied).toBe(false);
  });
```

  (Read this file's existing mock plumbing before writing — it wasn't fully quoted in Ground Truth — and mirror its exact `mockDb`/`vi.mock('../db', ...)` shape.)

- [ ] Step 2: Run it, expect FAIL — `storageIdentity`/`parentSnapshotId` absent from the write; both late-result cases flip to `completed` instead of `failed`.
  Command: `cd apps/api && npx vitest run src/services/backupResultPersistence.test.ts`

- [ ] Step 3: Implement

```ts
// apps/api/src/routes/backup/resultSchemas.ts:27-32
export const backupSnapshotResultSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }).optional(),
  size: z.number().int().nonnegative().optional(),
  files: z.array(backupSnapshotFileResultSchema).optional(),
  // D18 (#5429/§3.1): server-chosen dedupe base, echoed back by the agent so
  // lineage can be recorded. Absent = full run or a legacy agent.
  baseSnapshotId: z.string().optional(),
  formatVersion: z.number().int().nonnegative().optional(),
  backupIdentity: z.string().optional(),
});
```

```ts
// apps/api/src/services/backupResultPersistence.ts:1041-1051 — widen updatedJob's returning()
    .returning({
      id: backupJobs.id,
      orgId: backupJobs.orgId,
      configId: backupJobs.configId,
      backupType: backupJobs.backupType,
      backupMode: backupJobs.backupMode,
      baseSnapshotId: backupJobs.baseSnapshotId,
      publishLeaseExpiresAt: backupJobs.publishLeaseExpiresAt,
      storageIdentity: backupJobs.storageIdentity,
    });
```

```ts
// apps/api/src/services/backupResultPersistence.ts — new helper, placed above applyBackupCommandResultToJob
/**
 * D18 §3.1 late-result fence: a result for a job already in the reaped
 * 'failed' terminal status (STALE_BACKUP_REAP_MARKER) is accepted only if its
 * publish_lease_expires_at is STRICTLY IN THE FUTURE (review fix: a NULL
 * lease is now a REJECT, not an implicit pass — every job this wave dispatches
 * always carries one, so NULL on a reaped-terminal job is anomalous/legacy
 * and must fail closed) AND (it has no base pin, or its base row still
 * exists — scoped by the JOB's own storage_identity, since
 * backup_snapshots.snapshot_id carries no uniqueness constraint,
 * schema/backup.ts:330 — and is not retired). Otherwise the caller must
 * record the result as failed with a distinguishing reason instead of
 * flipping the job to completed.
 */
async function checkLateResultBaseFence(job: {
  baseSnapshotId: string | null;
  publishLeaseExpiresAt: Date | null;
  storageIdentity: string | null;
}): Promise<{ ok: true } | { ok: false; reason: 'publish_lease_expired' | 'base_retired' }> {
  if (!job.publishLeaseExpiresAt || job.publishLeaseExpiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'publish_lease_expired' };
  }
  if (!job.baseSnapshotId) return { ok: true };

  const [baseRow] = await db
    .select({ id: backupSnapshots.id })
    .from(backupSnapshots)
    .where(
      and(
        eq(backupSnapshots.snapshotId, job.baseSnapshotId),
        eq(backupSnapshots.storageIdentity, job.storageIdentity ?? ''),
      ),
    )
    .limit(1);
  if (!baseRow) return { ok: false, reason: 'base_retired' };

  const [retirement] = await db
    .select({ id: backupSnapshotRetirements.id })
    .from(backupSnapshotRetirements)
    .where(
      and(
        eq(backupSnapshotRetirements.storageIdentity, job.storageIdentity ?? ''),
        eq(backupSnapshotRetirements.snapshotId, job.baseSnapshotId),
      ),
    )
    .limit(1);
  return retirement ? { ok: false, reason: 'base_retired' } : { ok: true };
}
```

```ts
// apps/api/src/services/backupResultPersistence.ts — inside applyBackupCommandResultToJob,
// BEFORE the main `db.update(backupJobs)...` (before :1041), when source === 'agent' and isSuccessResult:

  if (source === 'agent' && isSuccessResult) {
    // Review fix: the whole read-decide-write sequence runs inside ONE
    // transaction with a FOR UPDATE lock on the job row, so the status check,
    // fence evaluation, and (on failure) the write are atomic against a
    // concurrently running staleCommandReaper pass — without the lock, the
    // reaper could re-decide the job's terminal state between this read and
    // this write. The predicate mirrors the file's own #3036 tenant-scoping
    // convention (eq(id) AND eq(deviceId) — see the main UPDATE at :1044):
    // job id alone is not trusted as a sufficient key anywhere else in this
    // file, and this new code must not be the one exception.
    const fenceOutcome = await db.transaction(async (tx) => {
      const [currentJob] = await tx
        .select({
          status: backupJobs.status,
          errorLog: backupJobs.errorLog,
          baseSnapshotId: backupJobs.baseSnapshotId,
          publishLeaseExpiresAt: backupJobs.publishLeaseExpiresAt,
          storageIdentity: backupJobs.storageIdentity,
        })
        .from(backupJobs)
        .where(and(eq(backupJobs.id, jobId), eq(backupJobs.deviceId, deviceId)))
        .for('update');

      const isReapedTerminal =
        currentJob?.status === 'failed' &&
        typeof currentJob.errorLog === 'string' &&
        currentJob.errorLog.includes(STALE_BACKUP_REAP_MARKER);

      if (!isReapedTerminal) return null;

      const fence = await checkLateResultBaseFence(currentJob);
      if (fence.ok) return null;

      const detail =
        fence.reason === 'publish_lease_expired'
          ? 'its publish lease had already expired'
          : 'its dedupe base was reclaimed';
      await tx
        .update(backupJobs)
        .set({
          status: 'failed',
          completedAt: new Date(),
          updatedAt: new Date(),
          errorLog: `${fence.reason}: late result rejected — ${detail} before this result arrived`,
        })
        .where(and(eq(backupJobs.id, jobId), eq(backupJobs.deviceId, deviceId)));
      return fence.reason;
    });

    if (fenceOutcome) {
      return { applied: true, snapshotDbId: null, providerSnapshotId };
    }
  }
```

```ts
// apps/api/src/services/backupResultPersistence.ts:1143-1162 — snapshotValues gains lineage fields
  let parentSnapshotId: string | null = null;
  const baseSnapshotId = result.snapshot?.baseSnapshotId;
  if (updatedJob.storageIdentity && baseSnapshotId) {
    // Scoped by storageIdentity, not configId (review fix): snapshot_id
    // carries no uniqueness constraint (schema/backup.ts:330), and identity
    // — not configId — is the authoritative scope GC and every other lookup
    // in this wave use. A config's identity can also drift after the base
    // was written (§3.6), so configId is not even a reliable proxy here.
    const [baseRow] = await db
      .select({ id: backupSnapshots.id })
      .from(backupSnapshots)
      .where(
        and(
          eq(backupSnapshots.storageIdentity, updatedJob.storageIdentity),
          eq(backupSnapshots.snapshotId, baseSnapshotId),
        ),
      )
      .limit(1);
    parentSnapshotId = baseRow?.id ?? null;
  }
  const isIncremental =
    (result.referencedFiles !== undefined && result.referencedFiles > 0) ||
    (result.snapshot?.formatVersion !== undefined && result.snapshot.formatVersion >= 2);

  const snapshotValues = {
    orgId: effectiveOrgId,
    jobId,
    deviceId,
    configId: updatedJob.configId ?? null,
    snapshotId: providerSnapshotId,
    label: snapshotLabel,
    location:
      typeof snapshotMetadata.storagePrefix === 'string'
        ? snapshotMetadata.storagePrefix
        : null,
    size: result.snapshot?.size ?? result.bytesBackedUp ?? null,
    fileCount: result.filesBackedUp ?? result.snapshot?.files?.length ?? null,
    timestamp,
    metadata: snapshotMetadata,
    encryptionKeyId: resolveSnapshotEncryptionKeyId(snapshotMetadata),
    backupType: snapshotBackupType,
    systemStateManifest,
    hardwareProfile,
    parentSnapshotId,
    isIncremental,
    // D18 §3.6: copied straight from the job's own stamped storageIdentity —
    // NOT recomputed from the config — so GC groups by the identity the run
    // actually wrote to, even if the config's destination has since changed.
    storageIdentity: updatedJob.storageIdentity ?? null,
  } as const;
```

  Add `backupSnapshotRetirements` to this file's EXISTING barrel import (`apps/api/src/services/backupResultPersistence.ts:3-12`, which already pulls `backupJobs`/`backupSnapshotFiles`/`backupSnapshots`/`backupPolicies`/`configPolicyBackupSettings`/`backupConfigs`/`IN_FLIGHT_BACKUP_JOB_STATUSES`/`STALE_BACKUP_REAP_MARKER` from `'../db/schema'`) — do not add a second, separate `'../db/schema/backup'` import line for the same table.

**P1 review finding — queue schema propagation.** Everything above is dead on arrival without this: `apps/api/src/jobs/queueSchemas.ts`'s `backupSnapshotSummarySchema` is `.strict()` and `apps/api/src/jobs/backupEnqueue.ts`'s `ProcessResultsResult.snapshot` is a plain TS interface — NEITHER declares `baseSnapshotId`/`formatVersion`/`backupIdentity` today, so the fields this task adds to `resultSchemas.ts`'s WS-ingress schema are stripped (or the whole `.strict()` parse throws) before `backupWorker.ts`'s `process-results` handler ever sees them.

```ts
// apps/api/src/jobs/queueSchemas.ts — widen backupSnapshotSummarySchema (the block starting
// "const backupSnapshotSummarySchema = z.object({")
const backupSnapshotSummarySchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().min(1).optional(),
  size: z.number().nonnegative().optional(),
  files: z.array(backupSnapshotFileSchema).optional(),
  // D18 (#5429/§3.1): mirrors resultSchemas.ts's backupSnapshotResultSchema —
  // must be added here too or `.strict()` drops/rejects these before
  // backupWorker.ts's process-results handler ever sees them.
  baseSnapshotId: z.string().optional(),
  formatVersion: z.number().optional(),
  backupIdentity: z.string().optional(),
}).strict();
```

```ts
// apps/api/src/jobs/backupEnqueue.ts:105-115 — widen the ProcessResultsResult.snapshot interface
  snapshot?: {
    id: string;
    timestamp?: string;
    size?: number;
    files?: Array<{
      sourcePath: string;
      backupPath: string;
      size?: number;
      modTime?: string;
    }>;
    // D18 (#5429/§3.1): must mirror backupSnapshotSummarySchema above, or
    // agentWs.ts's caller can construct a ProcessResultsResult carrying these
    // fields (from the parsed WS ingress payload) that TypeScript happily
    // accepts here, then loses at the very next hop when
    // backupQueueJobDataSchema.parse(...) strict-validates it.
    baseSnapshotId?: string;
    formatVersion?: number;
    backupIdentity?: string;
  };
```

- [ ] Queue-propagation regression test:

```ts
// apps/api/src/jobs/backupEnqueue.test.ts (or co-located queueSchemas.test.ts — confirm which
// file already covers backupQueueJobDataSchema round-trips and add there)
  it('round-trips baseSnapshotId/formatVersion/backupIdentity through enqueueBackupResults (D18 W01)', async () => {
    // Uses backupQueueJobDataSchema.parse directly (the same schema both
    // enqueueBackupResults and backupWorker.ts's parseQueueJobData use) so
    // this test exercises the actual contract without needing a running
    // BullMQ queue.
    const payload = backupQueueJobDataSchema.parse({
      type: 'process-results',
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      result: {
        status: 'completed',
        snapshotId: 'snap-1',
        snapshot: { id: 'snap-1', baseSnapshotId: 'snap-0', formatVersion: 2, backupIdentity: 's3::e::b' },
      },
      actorType: 'agent',
      actorId: null,
      source: 'route:agentWs:backup-result',
    });

    expect(payload.result.snapshot?.baseSnapshotId).toBe('snap-0');
    expect(payload.result.snapshot?.formatVersion).toBe(2);
    expect(payload.result.snapshot?.backupIdentity).toBe('s3::e::b');
  });
```

  Run it BEFORE the widening above to confirm it fails with a Zod `.strict()` "unrecognized key(s)" error, then after to confirm PASS: `cd apps/api && npx vitest run src/jobs/backupEnqueue.test.ts` (adjust path once the exact existing test file covering `backupQueueJobDataSchema` is confirmed).

- [ ] Step 4: Run, expect PASS
  Command: `cd apps/api && npx vitest run src/services/backupResultPersistence.test.ts src/jobs/backupEnqueue.test.ts`

- [ ] Step 5: Commit
  `git add apps/api/src/routes/backup/resultSchemas.ts apps/api/src/services/backupResultPersistence.ts apps/api/src/services/backupResultPersistence.test.ts apps/api/src/jobs/queueSchemas.ts apps/api/src/jobs/backupEnqueue.ts && git commit -m "feat(backup): lineage fields on write + late-result fence + queue-schema propagation (D18 W01 §3.1)"`

---

### Task 11: Reconcile — forward lineage, refuse retired/too-old/base-missing adoption

**Files:** Modify `apps/api/src/services/backupSnapshotReconcile.ts:135-155` (`ReconcileSkipReason`), `:538-585` (`manifestToCommandResult`), `:669-720` (new pre-loop retired-id lookup + in-loop checks), the `ClaimingJob` type + `loadClaimsAndSharing` query + the `claimingJob` branch of the per-candidate loop (new "late-result-fenced" check — locate by searching `ADOPTABLE_JOB_STATUSES.includes` in this file), `:864-882` (new base-existence check after the manifest parses). Test: `apps/api/src/services/backupSnapshotReconcile.test.ts`.

**Interfaces:** Consumes `backupSnapshotRetirements` schema. `RECONCILE_ORPHAN_HALF_WINDOW_MS` is a local literal (half of the 9-day default `BACKUP_GC_ORPHAN_MANIFEST_MAX_AGE_MS`, which doesn't exist as a named knob until W02) with a `TODO(W02)` to replace it once `backupGcKnobs.ts` grows that export. **Review fix:** reconcile must also refuse to adopt a job whose late result was already fenced off by Task 10's late-result fence — such a job is `status: 'failed'` with `errorLog` containing `publish_lease_expired` or `base_retired`; re-adopting it via the write-time-window path would resurrect exactly the state the fence exists to prevent. New skip reason `'late-result-fenced'`.

- [ ] Step 1: Write the failing test

```ts
// apps/api/src/services/backupSnapshotReconcile.test.ts — new cases
  it('manifestToCommandResult forwards baseSnapshotId and formatVersion', () => {
    const result = manifestToCommandResult({
      snapshotId: 'snap-1',
      manifestText: JSON.stringify({ id: 'snap-1', baseSnapshotId: 'snap-0', formatVersion: 2, files: [] }),
      matchedBy: 'job-snapshot-id',
    });
    expect(result.snapshot?.baseSnapshotId).toBe('snap-0');
    expect(result.snapshot?.formatVersion).toBe(2);
  });

  it('refuses to adopt a retired snapshot id', async () => {
    // Arrange listing to include snapshot RETIRED-1; the retirement lookup
    // (mocked select) returns a matching row for (storageIdentity, RETIRED-1).
    const result = await reconcileOrphanedBackupSnapshots({ orgId: 'org-1', configId: 'config-1' });
    const candidate = result.candidates.find((c) => c.snapshotId === 'RETIRED-1');
    expect(candidate?.skipReason).toBe('retired');
    expect(candidate?.adopted).toBe(false);
  });

  it('refuses to adopt a manifest older than half the orphan window', async () => {
    // Arrange listing with a manifest lastModified older than 4.5 days (half
    // the 9-day default) with no retirement row.
    const result = await reconcileOrphanedBackupSnapshots({ orgId: 'org-1', configId: 'config-1' });
    const candidate = result.candidates.find((c) => c.snapshotId === 'OLD-ORPHAN');
    expect(candidate?.skipReason).toBe('orphan-too-old-for-adoption');
  });

  it('refuses to adopt a manifest whose declared base has no live, unretired row', async () => {
    // Arrange a fresh (well within the window), job-snapshot-id-matched
    // manifest declaring baseSnapshotId 'gone-base'; the base-existence
    // lookup (mocked select) returns no row.
    const result = await reconcileOrphanedBackupSnapshots({ orgId: 'org-1', configId: 'config-1' });
    const candidate = result.candidates.find((c) => c.snapshotId === 'HAS-MISSING-BASE');
    expect(candidate?.skipReason).toBe('base-missing');
    expect(candidate?.adopted).toBe(false);
  });

  it('refuses to adopt a job whose late result was already fenced (publish_lease_expired/base_retired)', async () => {
    // Arrange claims.jobs to include a job-snapshot-id match whose status is
    // 'failed' and errorLog contains 'base_retired' (Task 10's late-result
    // fence already fired for this exact job/snapshot pair).
    const result = await reconcileOrphanedBackupSnapshots({ orgId: 'org-1', configId: 'config-1' });
    const candidate = result.candidates.find((c) => c.snapshotId === 'FENCED-JOB-SNAP');
    expect(candidate?.skipReason).toBe('late-result-fenced');
    expect(candidate?.adopted).toBe(false);
  });
```

- [ ] Step 2: Run it, expect FAIL — `manifestToCommandResult`'s result has no `baseSnapshotId` field, and all three refusal cases adopt instead of skipping.
  Command: `cd apps/api && npx vitest run src/services/backupSnapshotReconcile.test.ts`

- [ ] Step 3: Implement

```ts
// apps/api/src/services/backupSnapshotReconcile.ts:135-155 — widen ReconcileSkipReason
export type ReconcileSkipReason =
  | 'already-restorable'
  | 'claimed-by-another-organization'
  | 'shared-destination-ambiguous'
  | 'no-matching-job'
  | 'ambiguous-job-match'
  | 'job-not-adoptable'
  | 'job-on-another-config'
  | 'manifest-unreadable'
  | 'adoption-failed'
  | 'limit-reached'
  /** D18 §3.3/§3.4: the storage identity has a retirement row for this id. */
  | 'retired'
  /** D18 §3.4: the manifest is older than half the orphan window — leave it
   *  for the sweep instead of racing it. */
  | 'orphan-too-old-for-adoption'
  /** D18 §3.1/§3.4: the manifest declares a baseSnapshotId with no live,
   *  unretired backup_snapshots row — its references may already dangle. */
  | 'base-missing'
  /** D18 §3.1 review fix: the claiming job's own late result was already
   *  rejected by backupResultPersistence.ts's late-result fence
   *  (errorLog contains publish_lease_expired or base_retired) — re-adopting
   *  it here would resurrect exactly what that fence exists to prevent. */
  | 'late-result-fenced';
```

```ts
// apps/api/src/services/backupSnapshotReconcile.ts:538-585 — manifestToCommandResult forwards lineage
  return {
    snapshotId: params.snapshotId,
    filesBackedUp: files.length,
    bytesBackedUp: size,
    snapshot: {
      id: params.snapshotId,
      timestamp,
      size,
      files,
      baseSnapshotId: parsed.baseSnapshotId,
      formatVersion: parsed.formatVersion,
    },
    metadata: {
      storagePrefix: `${BACKUP_SNAPSHOT_ROOT_DIR}/${params.snapshotId}`,
      reconciledFromStorage: true,
      reconciledAt: new Date().toISOString(),
      reconcileMatchedBy: params.matchedBy,
    },
  };
```

```ts
// apps/api/src/services/backupSnapshotReconcile.ts — add backupSnapshotRetirements
// to the EXISTING barrel import (this file already pulls backupConfigs/
// backupJobs/backupSnapshots from '../db/schema') rather than a separate line.

// Half of BACKUP_GC_ORPHAN_MANIFEST_MAX_AGE_MS's 9-day default (spec §3.4:
// "reconcile adopts an orphan only while its manifest is younger than half
// the window, so adoption and sweeping are disjoint by age").
// TODO(W02): replace with backupGcKnobs.ts's real orphan-window export once
// that module grows it — kept as a local literal here so this wave does not
// reach into a not-yet-defined W02 constant.
const RECONCILE_ORPHAN_HALF_WINDOW_MS = (9 * 24 * 60 * 60 * 1000) / 2;
```

```ts
// apps/api/src/services/backupSnapshotReconcile.ts — inside reconcileOrphanedBackupSnapshots,
// right after storageIdentity/coarseIdentity are computed (~:673-674), before loadClaimsAndSharing:

  const retiredRows = await runInDbContext(() =>
    db
      .select({ snapshotId: backupSnapshotRetirements.snapshotId })
      .from(backupSnapshotRetirements)
      .where(
        and(
          eq(backupSnapshotRetirements.storageIdentity, storageIdentity),
          inArray(backupSnapshotRetirements.snapshotId, snapshotIds),
        ),
      )
  );
  const retiredSnapshotIds = new Set(retiredRows.map((r) => r.snapshotId));
```

```ts
// apps/api/src/services/backupSnapshotReconcile.ts — inside the per-snapshotId loop, right
// after the `skip` closure is defined (~:719), before the restorableOwner check (~:721):

    if (retiredSnapshotIds.has(snapshotId)) {
      skip('retired');
      continue;
    }
    if (writtenAt && now.getTime() - writtenAt.getTime() > RECONCILE_ORPHAN_HALF_WINDOW_MS) {
      skip('orphan-too-old-for-adoption');
      continue;
    }
```

```ts
// apps/api/src/services/backupSnapshotReconcile.ts — inside the adoption loop, right after
// `result = manifestToCommandResult({...})` succeeds (~:874), before `candidate.fileCount = ...` (~:882):

    if (result.snapshot?.baseSnapshotId) {
      const declaredBase = result.snapshot.baseSnapshotId;
      // WHERE is scoped by storageIdentity too (review fix), not just the
      // leftJoin condition — backup_snapshots.snapshot_id carries no
      // uniqueness constraint (schema/backup.ts:330), so without this the
      // base row lookup itself (not just the retirement check) could match
      // a same-string snapshot_id belonging to a different identity.
      const [liveBase] = await runInDbContext(() =>
        db
          .select({ id: backupSnapshots.id })
          .from(backupSnapshots)
          .leftJoin(
            backupSnapshotRetirements,
            and(
              eq(backupSnapshotRetirements.storageIdentity, storageIdentity),
              eq(backupSnapshotRetirements.snapshotId, declaredBase),
            ),
          )
          .where(
            and(
              eq(backupSnapshots.snapshotId, declaredBase),
              eq(backupSnapshots.storageIdentity, storageIdentity),
              isNull(backupSnapshotRetirements.id),
            ),
          )
          .limit(1)
      );
      if (!liveBase) {
        candidate.skipReason = 'base-missing';
        candidate.error = `manifest declares base ${declaredBase}, which has no live, unretired row`;
        candidates.push(candidate);
        continue;
      }
    }
```

```ts
// apps/api/src/services/backupSnapshotReconcile.ts — review fix: refuse a job whose
// late result was already fenced. Add `errorLog: backupJobs.errorLog` to whatever
// column-selector `loadClaimsAndSharing` (or its equivalent claims-building query)
// uses to populate `claims.jobs`'s ClaimingJob values, and widen the ClaimingJob
// type with `errorLog: string | null`. Then, inside the per-snapshotId loop's
// `claimingJob` branch — right after the existing
// `if (!ADOPTABLE_JOB_STATUSES.includes(claimingJob.status as ...))` check and
// before `adoptable.push(...)` — add:

      if (
        claimingJob.status === 'failed' &&
        typeof claimingJob.errorLog === 'string' &&
        /publish_lease_expired|base_retired/.test(claimingJob.errorLog)
      ) {
        skip('late-result-fenced');
        continue;
      }
```

  Add `inArray`/`isNull` to this file's `drizzle-orm` import if not already present (confirm during implementation — several are already used elsewhere in the file for the claims lookups). Verify the exact `ClaimingJob` type definition and `loadClaimsAndSharing`'s query column list against the real file before implementing this block — its precise shape was not fully re-quoted here.

- [ ] Step 4: Run, expect PASS
  Command: `cd apps/api && npx vitest run src/services/backupSnapshotReconcile.test.ts`

- [ ] Step 5: Commit
  `git add apps/api/src/services/backupSnapshotReconcile.ts apps/api/src/services/backupSnapshotReconcile.test.ts && git commit -m "feat(backup): reconcile forwards lineage and refuses retired/stale/base-missing adoption (D18 W01 §3.4)"`

---

### Task 12: `PATCH /backup/configs/:id` — warn when the edit changes storage identity

**Files:** Modify `apps/api/src/routes/backup/configs.ts:440-467`. Test: `apps/api/src/routes/backup/configs.test.ts`.

**Interfaces:** Response from `PATCH /backup/configs/:id` gains a `warnings: string[]` field, **always present** (possibly empty — a stable contract for the frontend, per coordinator decision), populated with `'storage_identity_changed'` when the edit changes `normalizeStorageIdentity(provider, providerConfig)` for a config that has at least one `backup_snapshots` row. Never blocks the write.

- [ ] Step 1: Write the failing test

```ts
// apps/api/src/routes/backup/configs.test.ts — new case (mirror this file's existing PATCH test setup)
  it('warns (does not block) when an s3 endpoint edit changes storage identity for a config with snapshots', async () => {
    // Arrange: `current` row is s3 with endpoint 'old.example.com', bucket 'b';
    // a snapshot-exists check for this configId returns a row; PATCH body
    // changes details.endpoint to 'new.example.com'.
    const res = await app.request('/backup/configs/config-1?orgId=org-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({ details: { endpoint: 'new.example.com', bucket: 'b' } }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.warnings).toEqual(['storage_identity_changed']);
  });

  it('always includes warnings (empty) when the edit does not change storage identity', async () => {
    // Same config, PATCH body only changes `name`.
    const res = await app.request('/backup/configs/config-1?orgId=org-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    const body = await res.json();
    expect(body.warnings).toEqual([]);
  });
```

- [ ] Step 2: Run it, expect FAIL — `body.warnings` is `undefined`.
  Command: `cd apps/api && npx vitest run src/routes/backup/configs.test.ts`

- [ ] Step 3: Implement

```ts
// apps/api/src/routes/backup/configs.ts:13 — widen the existing import (confirmed
// today: `import { backupConfigs } from '../../db/schema';` — backupSnapshots is
// NOT currently imported in this file; `eq`/`and` are already imported at :4)
import { backupConfigs, backupSnapshots } from '../../db/schema';
```

```ts
// apps/api/src/routes/backup/configs.ts — new import
import { normalizeStorageIdentity } from '../../jobs/backupRetention';
```

```ts
// apps/api/src/routes/backup/configs.ts — inside the PATCH handler, after the write
// transaction resolves `row` (~:452) and before the response (~:467):

    const warnings: string[] = [];
    const priorIdentity = normalizeStorageIdentity(current.provider, (current.providerConfig ?? {}) as Record<string, unknown>);
    const nextIdentity = normalizeStorageIdentity(row.provider, (row.providerConfig ?? {}) as Record<string, unknown>);
    if (priorIdentity !== nextIdentity) {
      const [existingSnapshot] = await db
        .select({ id: backupSnapshots.id })
        .from(backupSnapshots)
        .where(eq(backupSnapshots.configId, configId))
        .limit(1);
      if (existingSnapshot) {
        warnings.push('storage_identity_changed');
      }
    }

    writeRouteAudit(c, {
      orgId,
      action: 'backup.config.update',
      resourceType: 'backup_config',
      resourceId: row.id,
      resourceName: row.name,
      details: { changedFields: Object.keys(payload) },
    });

    // Always present (possibly empty) — a stable response shape, per
    // coordinator decision, rather than an optional field callers must guard.
    return c.json({ ...toConfigResponse(row), warnings });
```

  (Resolved: `backupSnapshots` was NOT already imported in `configs.ts` — confirmed by reading the file's import block; the widened import above adds it.)

- [ ] Step 4: Run, expect PASS
  Command: `cd apps/api && npx vitest run src/routes/backup/configs.test.ts`

- [ ] Step 5: Commit
  `git add apps/api/src/routes/backup/configs.ts apps/api/src/routes/backup/configs.test.ts && git commit -m "feat(backup): warn on PATCH /backup/configs/:id when the edit changes storage identity (D18 W01 §3.6)"`

---

### Task 13: Integration tests — pins/retirement/race + RLS forge

**Files:** Create `apps/api/src/__tests__/integration/backupRetentionPins.integration.test.ts`, `apps/api/src/__tests__/integration/backupSnapshotRetirementsRls.integration.test.ts`. Both are already covered by `vitest.integration.config.ts`'s standing `'src/__tests__/integration/**/*.test.ts'` glob — no config edit needed.

- [ ] Step 1: Write the failing tests

```ts
// apps/api/src/__tests__/integration/backupRetentionPins.integration.test.ts
import './setup';

import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  backupConfigs,
  backupJobs,
  backupSnapshots,
  backupSnapshotRetirements,
  deviceCommands,
  devices,
  organizations,
  partners,
  recoveryTokens,
  restoreJobs,
  sites,
} from '../../db/schema';
import { cleanupExpiredSnapshots } from '../../jobs/backupRetention';
import { processCleanupExpiredSnapshots, __testOnly } from '../../jobs/backupWorker';
import { applyBackupCommandResultToJob } from '../../services/backupResultPersistence';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// Confirm during implementation whether stampDispatchPinAndIdentity (Task 6)
// needs to be added to backupWorker.ts's existing `__testOnly` export bag —
// it is a private `async function` today, not exported, and this suite's
// concurrent-dispatch-vs-retention test needs to call the REAL function
// (not a hand-rolled copy of its SQL) from outside the module.

async function seedOrgDeviceConfig(unique: string) {
  const [partner] = await db.insert(partners).values({ name: `RP ${unique}`, slug: `rp-${unique}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
  const [org] = await db.insert(organizations).values({ currencyCode: 'USD', partnerId: partner!.id, name: `RO ${unique}`, slug: `ro-${unique}`, type: 'customer', status: 'active' }).returning({ id: organizations.id });
  const [site] = await db.insert(sites).values({ orgId: org!.id, name: `RS ${unique}` }).returning({ id: sites.id });
  const [device] = await db.insert(devices).values({ orgId: org!.id, siteId: site!.id, agentId: `ra-${unique}`, hostname: `rh-${unique}`, osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online' }).returning({ id: devices.id });
  const [config] = await db.insert(backupConfigs).values({ orgId: org!.id, name: `RC ${unique}`, type: 'file', provider: 'local', providerConfig: { path: `/tmp/gc-test-${unique}` } }).returning({ id: backupConfigs.id });
  return { orgId: org!.id, deviceId: device!.id, configId: config!.id };
}

// D18 §3.2: a base-pinned snapshot must survive retention even though its
// expires_at is in the past — the pin, not the expiry, decides.
runDb("skips an expired snapshot pinned as a running job's base and writes no retirement", async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const [baseJob] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    const [baseSnap] = await db.insert(backupSnapshots).values({
      orgId, jobId: baseJob!.id, deviceId, configId,
      snapshotId: `base-snap-${unique}`, backupType: 'file', storageIdentity: `local::/tmp/gc-test-${unique}`,
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    }).returning({ id: backupSnapshots.id });
    await db.insert(backupJobs).values({
      orgId, configId, deviceId, status: 'running', baseSnapshotId: `base-snap-${unique}`,
      publishLeaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }).returning({ id: backupJobs.id });
    return { orgId, baseSnapId: baseSnap!.id };
  });

  const result = await cleanupExpiredSnapshots(ctx.orgId);
  expect(result.skippedPinned).toBeGreaterThanOrEqual(1);

  await withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(backupSnapshots).where(eq(backupSnapshots.id, ctx.baseSnapId));
    expect(row).toBeDefined();
    const retirements = await db.select().from(backupSnapshotRetirements).where(eq(backupSnapshotRetirements.snapshotId, `base-snap-${unique}`));
    expect(retirements.length).toBe(0);
  });
});

// D18 §3.3: an expired, unpinned snapshot is deleted AND its retirement row
// is written in the same commit.
runDb('deletes an unpinned expired snapshot and writes its retirement row', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const [job] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    const [snap] = await db.insert(backupSnapshots).values({
      orgId, jobId: job!.id, deviceId, configId,
      snapshotId: `expired-snap-${unique}`, backupType: 'file', storageIdentity: `local::/tmp/gc-test-${unique}`,
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    }).returning({ id: backupSnapshots.id });
    return { orgId, snapId: snap!.id };
  });

  const result = await cleanupExpiredSnapshots(ctx.orgId);
  expect(result.deleted).toBeGreaterThanOrEqual(1);

  await withSystemDbAccessContext(async () => {
    const rows = await db.select().from(backupSnapshots).where(eq(backupSnapshots.id, ctx.snapId));
    expect(rows.length).toBe(0);
    const retirements = await db.select().from(backupSnapshotRetirements).where(eq(backupSnapshotRetirements.snapshotId, `expired-snap-${unique}`));
    expect(retirements.length).toBe(1);
    expect(retirements[0]!.reason).toBe('expired');
  });
});

// D18 §3.7: proves the per-row-commit restructuring — a later row's failure
// must not undo an earlier row's already-committed retirement. Forced here
// via a duplicate (storage_identity, snapshot_id) unique-constraint
// violation on the SECOND row's retirement insert (a manufactured collision
// against a pre-seeded retirement row) — the first (non-colliding) row's
// delete+retirement must remain committed regardless of the second's failure.
runDb("one row failing on a unique-constraint collision does not undo an earlier row's committed retirement", async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const identity = `local::/tmp/gc-test-${unique}`;
    const [job1] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    const [collideSnap] = await db.insert(backupSnapshots).values({ orgId, jobId: job1!.id, deviceId, configId, snapshotId: `collide-${unique}`, backupType: 'file', storageIdentity: identity, expiresAt: new Date(Date.now() - 60 * 60 * 1000) }).returning({ id: backupSnapshots.id });
    const [job2] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    const [uniqueSnap] = await db.insert(backupSnapshots).values({ orgId, jobId: job2!.id, deviceId, configId, snapshotId: `unique-${unique}`, backupType: 'file', storageIdentity: identity, expiresAt: new Date(Date.now() - 60 * 60 * 1000) }).returning({ id: backupSnapshots.id });
    // Pre-seed the retirement row the colliding row's own insert will violate.
    await db.insert(backupSnapshotRetirements).values({ orgId, configId, deviceId, snapshotId: `collide-${unique}`, storageIdentity: identity, backupType: 'file', reason: 'manual' });
    return { orgId, collideSnapId: collideSnap!.id, uniqueSnapId: uniqueSnap!.id };
  });

  const result = await cleanupExpiredSnapshots(ctx.orgId);
  expect(result.failed).toBeGreaterThanOrEqual(1);
  expect(result.deleted).toBeGreaterThanOrEqual(1);

  await withSystemDbAccessContext(async () => {
    const uniqueRows = await db.select().from(backupSnapshots).where(eq(backupSnapshots.id, ctx.uniqueSnapId));
    expect(uniqueRows.length).toBe(0); // the non-colliding row committed its delete
    const collideRows = await db.select().from(backupSnapshots).where(eq(backupSnapshots.id, ctx.collideSnapId));
    expect(collideRows.length).toBe(1); // the colliding row's delete never happened — retried next run
  });
});

// D18 §3.2 restore pin: WITH a command_id, the in-flight status check pins;
// WITHOUT one, only the linger pins (a commandless pending row is instead
// reaped by Task 7's staleCommandReaper rule, not by this pin lasting forever).
runDb('restore pin holds a snapshot with an in-flight, commanded restore', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const [job] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    const [snap] = await db.insert(backupSnapshots).values({ orgId, jobId: job!.id, deviceId, configId, snapshotId: `restore-pin-${unique}`, backupType: 'file', storageIdentity: `local::/tmp/gc-test-${unique}`, expiresAt: new Date(Date.now() - 60 * 60 * 1000) }).returning({ id: backupSnapshots.id });
    const [command] = await db.insert(deviceCommands).values({ deviceId, type: 'backup_restore', payload: {}, status: 'sent' }).returning({ id: deviceCommands.id });
    await db.insert(restoreJobs).values({ orgId, deviceId, snapshotId: snap!.id, restoreType: 'full', status: 'running', commandId: command!.id });
    return { orgId, snapId: snap!.id };
  });

  const result = await cleanupExpiredSnapshots(ctx.orgId);
  expect(result.skippedPinned).toBeGreaterThanOrEqual(1);

  await withSystemDbAccessContext(async () => {
    const rows = await db.select().from(backupSnapshots).where(eq(backupSnapshots.id, ctx.snapId));
    expect(rows.length).toBe(1);
  });
});

runDb('a COMMANDLESS pending restore pins only for the linger, not indefinitely', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const [job] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    const [snap] = await db.insert(backupSnapshots).values({ orgId, jobId: job!.id, deviceId, configId, snapshotId: `commandless-restore-${unique}`, backupType: 'file', storageIdentity: `local::/tmp/gc-test-${unique}`, expiresAt: new Date(Date.now() - 60 * 60 * 1000) }).returning({ id: backupSnapshots.id });
    // commandId NULL, status pending, created recently — still within the
    // 7-day-default linger, so the row IS pinned (linger, not status).
    await db.insert(restoreJobs).values({ orgId, deviceId, snapshotId: snap!.id, restoreType: 'full', status: 'pending', commandId: null, createdAt: new Date() });
    return { orgId, snapId: snap!.id };
  });

  const result = await cleanupExpiredSnapshots(ctx.orgId);
  expect(result.skippedPinned).toBeGreaterThanOrEqual(1);
});

// D18 §3.2 recovery-token pin: an active/authenticated token, or one not yet
// completed and still within its expiry + linger, pins the snapshot.
runDb('recovery-token pin holds a snapshot with an active BMR token', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const [job] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    const [snap] = await db.insert(backupSnapshots).values({ orgId, jobId: job!.id, deviceId, configId, snapshotId: `recovery-pin-${unique}`, backupType: 'system_image', storageIdentity: `local::/tmp/gc-test-${unique}`, expiresAt: new Date(Date.now() - 60 * 60 * 1000) }).returning({ id: backupSnapshots.id });
    await db.insert(recoveryTokens).values({
      orgId, deviceId, snapshotId: snap!.id, tokenHash: `hash-${unique}`, restoreType: 'bare_metal',
      status: 'active', expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    return { orgId, snapId: snap!.id };
  });

  const result = await cleanupExpiredSnapshots(ctx.orgId);
  expect(result.skippedPinned).toBeGreaterThanOrEqual(1);
});

// D18 §3.2/§4: the maxVersions prune pass must respect the SAME pins as the
// expiry pass — a pinned row over the version cap is skipped, not pruned.
runDb('the max-versions prune pass respects an active base pin', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    // A configPolicyBackupSettings row with retention.maxVersions=1, linked
    // via a job's featureLinkId, is required for the maxVersions branch to
    // fire — construct the minimal chain this test needs; consult
    // resolveGfsConfigForJob / the maxVersions query in backupRetention.ts
    // for the exact featureLinkId wiring before finalizing this fixture.
    const [oldJob] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), completedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }).returning({ id: backupJobs.id });
    const [oldSnap] = await db.insert(backupSnapshots).values({ orgId, jobId: oldJob!.id, deviceId, configId, snapshotId: `mv-old-${unique}`, backupType: 'file', storageIdentity: `local::/tmp/gc-test-${unique}`, timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000) }).returning({ id: backupSnapshots.id });
    // Pin the OLDER (over-cap) snapshot as an in-flight job's base.
    await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'running', baseSnapshotId: `mv-old-${unique}`, publishLeaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000) });
    return { orgId, oldSnapId: oldSnap!.id };
  });

  await cleanupExpiredSnapshots(ctx.orgId);

  await withSystemDbAccessContext(async () => {
    const rows = await db.select().from(backupSnapshots).where(eq(backupSnapshots.id, ctx.oldSnapId));
    expect(rows.length).toBe(1); // pinned — NOT pruned by maxVersions despite being over cap
  });
});

// D18 §3.1 late-result fence, through the real applyBackupCommandResultToJob
// path (not the mocked unit test) — proves the whole chain end to end: a
// result arriving after the job's publish lease has expired is rejected.
runDb('a late result is rejected once its publish lease has expired (real DB)', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const [job] = await db.insert(backupJobs).values({
      orgId, configId, deviceId, status: 'failed',
      errorLog: '[stale-backup-reaper] reaped: no progress',
      publishLeaseExpiresAt: new Date(Date.now() - 60 * 1000), // already expired
      storageIdentity: `local::/tmp/gc-test-${unique}`,
    }).returning({ id: backupJobs.id });
    return { orgId, deviceId, jobId: job!.id };
  });

  const result = await applyBackupCommandResultToJob({
    jobId: ctx.jobId, orgId: ctx.orgId, deviceId: ctx.deviceId, resultStatus: 'completed',
    result: { snapshotId: `late-${unique}`, snapshot: { id: `late-${unique}` }, filesBackedUp: 1, bytesBackedUp: 1 } as any,
    source: 'agent',
  });

  expect(result.applied).toBe(true);
  await withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(backupJobs).where(eq(backupJobs.id, ctx.jobId));
    expect(row!.status).toBe('failed');
    expect(row!.errorLog ?? '').toContain('publish_lease_expired');
    // No backup_snapshots row must have been created for the late result.
    const snaps = await db.select().from(backupSnapshots).where(eq(backupSnapshots.snapshotId, `late-${unique}`));
    expect(snaps.length).toBe(0);
  });
});

// D18 §3.1 concurrent dispatch vs retention, on TWO SEPARATE connections/
// transactions racing the SAME snapshot row — proves the lock order (job then
// snapshot, dispatch side; FOR UPDATE, retention side) leaves no dangling
// pin: either dispatch sees the pin survive (retention skipped it) or
// retention wins and dispatch falls back to a full run, never both "dispatch
// pinned a row retention also deleted."
runDb('concurrent dispatch-vs-retention on the same row never leaves a dangling pin', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const [job] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    const [snap] = await db.insert(backupSnapshots).values({ orgId, jobId: job!.id, deviceId, configId, snapshotId: `race-${unique}`, backupType: 'file', storageIdentity: `local::/tmp/gc-test-${unique}`, expiresAt: new Date(Date.now() - 60 * 60 * 1000) }).returning({ id: backupSnapshots.id });
    const [dispatchJob] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'pending' }).returning({ id: backupJobs.id });
    return { orgId, deviceId, configId, snapId: snap!.id, dispatchJobId: dispatchJob!.id };
  });

  // Race the two real code paths concurrently — NOT two manually-opened raw
  // connections, since the point is to prove the actual functions
  // (stampDispatchPinAndIdentity via a minimal harness, and
  // cleanupExpiredSnapshots) interleave safely under Postgres's real lock
  // semantics, not to hand-roll the SQL twice. Import
  // `stampDispatchPinAndIdentity` — confirm during implementation whether it
  // needs exporting from backupWorker.ts (it is `async function`, not
  // exported today) via `__testOnly`, mirroring the existing
  // `__testOnly.processDispatchBackup` pattern.
  const [dispatchOutcome] = await Promise.all([
    withSystemDbAccessContext(() => __testOnly.stampDispatchPinAndIdentity({
      deviceId: ctx.deviceId, configId: ctx.configId, jobId: ctx.dispatchJobId,
      mode: 'file', provider: 'local', providerConfig: { path: `/tmp/gc-test-${unique}` },
    })),
    cleanupExpiredSnapshots(ctx.orgId),
  ]);

  await withSystemDbAccessContext(async () => {
    if (dispatchOutcome.baseSnapshotId === `race-${unique}`) {
      // Dispatch won: the snapshot row must still exist (retention saw the pin).
      const rows = await db.select().from(backupSnapshots).where(eq(backupSnapshots.id, ctx.snapId));
      expect(rows.length).toBe(1);
    } else {
      // Retention won: dispatch must have fallen back to a full run, and the
      // dispatch job's own base_snapshot_id must be NULL, not dangling.
      expect(dispatchOutcome.baseSnapshotId).toBe('');
      const [dispatchJobRow] = await db.select().from(backupJobs).where(eq(backupJobs.id, ctx.dispatchJobId));
      expect(dispatchJobRow!.baseSnapshotId).toBeNull();
    }
  });
});

// D18 §6(6b) / §3.7 — run through the actual WORKER HANDLER
// (processCleanupExpiredSnapshots: per-org retention loop → sweep → the D17
// final throw), not just cleanupExpiredSnapshots directly, proving the
// worker-level restructuring (Task 8) really does leave earlier retirements
// committed even when the run as a whole ends in the D17 throw.
runDb('processCleanupExpiredSnapshots: an org with a failing row still commits every other retirement, then throws', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const { orgId, deviceId, configId } = await seedOrgDeviceConfig(unique);
    const identity = `local::/tmp/gc-test-${unique}`;
    const [job1] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    const [okSnap] = await db.insert(backupSnapshots).values({ orgId, jobId: job1!.id, deviceId, configId, snapshotId: `worker-ok-${unique}`, backupType: 'file', storageIdentity: identity, expiresAt: new Date(Date.now() - 60 * 60 * 1000) }).returning({ id: backupSnapshots.id });
    const [job2] = await db.insert(backupJobs).values({ orgId, configId, deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date() }).returning({ id: backupJobs.id });
    const [failSnap] = await db.insert(backupSnapshots).values({ orgId, jobId: job2!.id, deviceId, configId, snapshotId: `worker-fail-${unique}`, backupType: 'file', storageIdentity: identity, expiresAt: new Date(Date.now() - 60 * 60 * 1000) }).returning({ id: backupSnapshots.id });
    // Pre-seed the retirement row the second row's own insert will collide on.
    await db.insert(backupSnapshotRetirements).values({ orgId, configId, deviceId, snapshotId: `worker-fail-${unique}`, storageIdentity: identity, backupType: 'file', reason: 'manual' });
    return { orgId, okSnapId: okSnap!.id, failSnapId: failSnap!.id };
  });

  // processCleanupExpiredSnapshots iterates ALL orgs with expired snapshots
  // (module-level, not scoped to ctx.orgId) — the D17 throw at the end is
  // expected given the seeded collision.
  await expect(processCleanupExpiredSnapshots()).rejects.toThrow(/snapshot row delete\(s\) failed/);

  await withSystemDbAccessContext(async () => {
    const okRows = await db.select().from(backupSnapshots).where(eq(backupSnapshots.id, ctx.okSnapId));
    expect(okRows.length).toBe(0); // committed despite the throw happening after it
    const failRows = await db.select().from(backupSnapshots).where(eq(backupSnapshots.id, ctx.failSnapId));
    expect(failRows.length).toBe(1); // this one legitimately failed and is retried next run
  });
});
```

```ts
// apps/api/src/__tests__/integration/backupSnapshotRetirementsRls.integration.test.ts
import './setup';

import { expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { backupConfigs, backupSnapshotRetirements, devices, sites } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// Real DbAccessContext shape (apps/api/src/db/index.ts:124-129) has NO
// `partnerId` field — an earlier draft of this test used
// `{ scope, orgId, partnerId: null }`, which is not a real field on the type
// at all (it would simply be ignored, silently defeating the forge's intent
// to prove RLS, not "TypeScript accepted an object literal"). Mirrors the
// established `orgContext` helper convention used elsewhere in this suite
// (e.g. agentRollbackRls.integration.test.ts:12).
function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

// D18 §3.3: shape-1 RLS forge — an org-scoped context for org B must not be
// able to insert (or read) a retirement row stamped with org A's id.
runDb('forges a cross-tenant insert on backup_snapshot_retirements and gets 42501', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { orgAId, orgBId, configId, deviceId } = await withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const [site] = await db.insert(sites).values({ orgId: orgA.id, name: `RLSS ${unique}` }).returning({ id: sites.id });
    const [device] = await db.insert(devices).values({ orgId: orgA.id, siteId: site!.id, agentId: `rlsa-agent-${unique}`, hostname: `rlsa-host-${unique}`, osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online' }).returning({ id: devices.id });
    const [config] = await db.insert(backupConfigs).values({ orgId: orgA.id, name: `RLSC ${unique}`, type: 'file', provider: 'local', providerConfig: {} }).returning({ id: backupConfigs.id });
    return { orgAId: orgA.id, orgBId: orgB.id, configId: config!.id, deviceId: device!.id };
  });

  await expect(
    withDbAccessContext(orgContext(orgBId), () =>
      db.insert(backupSnapshotRetirements).values({
        orgId: orgAId, // forged: org B's context, org A's row
        configId,
        deviceId,
        snapshotId: `forge-${unique}`,
        storageIdentity: `local::/tmp/forge-${unique}`,
        backupType: 'file',
        reason: 'manual',
      })
    )
    // Review fix (SQLSTATE assertion must read the wrapped cause): a Drizzle
    // `.insert(...)` call's rejection wraps the real Postgres error under
    // `.cause`, NOT a top-level `.code` — confirmed against
    // agentRollbackRls.integration.test.ts:105 (`{ cause: { code: '23505' } }`).
    // A raw `db.execute(sql\`...\`)` call gets `.code` directly instead
    // (same file, :128) — this test uses the Drizzle insert form, so it must
    // use the wrapped form.
  ).rejects.toMatchObject({ cause: { code: '42501' } });
});
```

  Confirm `createOrganization`/`createPartner`'s exact option shape against `apps/api/src/__tests__/integration/db-utils.ts:106,146` before finalizing (both already used by numerous other suites in this directory).

- [ ] Step 2: Run it, expect FAIL against the current code (before Tasks 1-9 land) or PASS trivially once run after — this task is naturally the LAST implementation task, so by the time it's written Tasks 1-11 should already be in place; if any of these tests fail unexpectedly at this point, that's a real defect in an earlier task, not a sequencing artifact.
  Command (NO `DATABASE_URL` override — see Task 14's correction on why the dev DB URL must never be passed to the integration runner): `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/backupRetentionPins.integration.test.ts src/__tests__/integration/backupSnapshotRetirementsRls.integration.test.ts`

- [ ] Step 3: (No separate implement step — these tests exercise Tasks 1-11's already-implemented code.)

- [ ] Step 4: Run, expect PASS
  Command: same as Step 2.

- [ ] Step 5: Commit
  `git add apps/api/src/__tests__/integration/backupRetentionPins.integration.test.ts apps/api/src/__tests__/integration/backupSnapshotRetirementsRls.integration.test.ts && git commit -m "test(backup): integration coverage for base pins, retirements, per-row commit, and RLS forge (D18 W01)"`

---

### Task 14: Wave verification

- [ ] `cd apps/api && npx tsc --noEmit` (or `pnpm --filter @breeze/api exec tsc --noEmit` — no dedicated `typecheck` script exists in `apps/api/package.json`, confirmed).
- [ ] `cd apps/api && npx vitest run src/services/backupGcKnobs.test.ts src/jobs/backupWorker.test.ts src/jobs/staleCommandReaper.test.ts src/jobs/backupRetention.test.ts src/services/backupResultPersistence.test.ts src/services/backupSnapshotReconcile.test.ts src/routes/backup/configs.test.ts src/jobs/backupEnqueue.test.ts`.
- [ ] `pnpm db:migrate && pnpm db:migrate` against a disposable local DB — second run applies zero migrations (idempotency; NOT what `db:check-drift` checks — see Task 2's Step 1 correction).
- [ ] `pnpm db:check-drift` — verifies migration-ledger parity only (every file in `apps/api/migrations/` has one `breeze_migrations` row); run it because it's the standing gate for any new migration file, not because it proves schema correctness.
- [ ] Integration tests — run with NO `DATABASE_URL` override (the safe default in `apps/api/src/__tests__/integration/setup.ts` already points at the dedicated test database, `postgresql://breeze_test:breeze_test@localhost:5433/breeze_test`; `apps/api/src/testUtils/integrationDatabaseSafety.ts` actively REFUSES a connection string on port 5432 or with a database name other than `breeze_test(_*)`, so the dev DB URL used elsewhere in this repo's docs must never be passed here):
  `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/backupRetentionPins.integration.test.ts src/__tests__/integration/backupSnapshotRetirementsRls.integration.test.ts`
- [ ] Contract suites this wave's registry edits are graded against (tenancy/cascade code was touched — run these before PR per CLAUDE.md):
  - `find apps/api/src -iname "tenantCascade*integration*"` then `npx vitest run <path>` against the same test DB (no `DATABASE_URL` override needed).
  - `apps/api/src/routes/devices/*.test.ts` matching `cascade`/`moveOrg` (both device-side lists fail in the unit job since they read the Drizzle schema statically — no live DB required).
  - `apps/api/src/services/tenantExportPolicyRegistry`'s check script/integration test (`grep -n check-tenant-export-policy apps/api/package.json` for the exact invocation) and `tenant-export-policy.integration.test.ts` + `tenantExportErasureRoundtrip.integration.test.ts` (only fail under Integration Tests — run against the test DB before PR).
  - `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — confirm it still passes with no new allowlist entry needed for shape-1 auto-discovery.
- [ ] `pnpm lint`
- [ ] **Explicitly out of scope, handed to W02:** pruning `backup_snapshot_retirements` rows 30 days after `swept_at` is set (spec §3.3: "Rows are pruned 30 d after `swept_at`"). This wave never sets `swept_at` at all (that's the GC sweep's job, §3.4/W02) and adds no pruning job — a pruning task only makes sense once W02's sweep is setting `swept_at` in the first place. W02's plan should include a `swept_at IS NOT NULL AND swept_at < now() - 30d` cleanup pass (a new scheduled job, or folded into the existing GC cadence) as one of its own tasks; it is NOT silently dropped here — call it out in that plan's own Consumes/Produces the same way this note does.
- [ ] PR body checklist:
  - [ ] Migrations `160011`/`160012` applied and idempotent-verified (`pnpm db:migrate` run twice locally, second run a no-op).
  - [ ] `pnpm db:check-drift` clean (ledger parity only — not a schema-correctness proof; see above).
  - [ ] Tenancy contract suites (cascade order, device cascade/denormalized lists, export-policy, rls-coverage) all green against the real test DB, not just the unit job.
  - [ ] `Closes #<W01 sub-issue>` once this feature is registered via `feature-lifecycle` (per CLAUDE.md's Feature Lifecycle Tracking section, if this plan is executed as a tracked wave).
  - [ ] Note for W02/W03 reviewers: `backupGcKnobs.ts` currently exports `BACKUP_BASE_LEASE_MS`, `BACKUP_RESTORE_PIN_LINGER_MS`, `BACKUP_PUBLISH_MARGIN_MS` — W02 is expected to migrate `BACKUP_GC_GRACE_MS`/`BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS`/a real `BACKUP_GC_ORPHAN_MANIFEST_MAX_AGE_MS` into this same module, delete the `RECONCILE_ORPHAN_HALF_WINDOW_MS` local literal in `backupSnapshotReconcile.ts` (Task 11), replace Task 8's single shared `runWithSystemDbAccess` wrap around `sweepUnreferencedBackupObjects()` with genuinely separate per-identity contexts managed inside that function, and add the 30-day `backup_snapshot_retirements` pruning pass noted above.

## Open questions / contradictions — resolved by coordinator 2026-09-09

All eight items below were raised during drafting and have since been resolved by explicit coordinator decision; the plan text above already reflects each resolution. Kept here as a decision log, not as open items.

1. **RESOLVED — no backfill.** Migration `160011` is DDL only (Task 1): no PL/pgSQL port of `normalizeStorageIdentity`, no UPDATE, no `breeze.scope` elevation. Every `backup_snapshots.storage_identity` starts NULL; W02's sweep self-heals each row from a live bucket listing, matched by row id. The SQL-fidelity concerns that motivated the original open question (path/URL parsing divergence) no longer apply, since no SQL normalization is attempted here at all.
2. **CONFIRMED — asymmetry intentional.** `staleCommandReaper.ts`'s `RESTORE_COMMANDLESS_PENDING_TIMEOUT_MS` (Task 7) is a fixed 1 hour, independent of the env-tunable, 7-day-default `BACKUP_RESTORE_PIN_LINGER_MS` (Task 9) retention's own pin check uses. Coordinator confirms this is the intended operator-facing behavior, not an oversight.
3. **RESOLVED — import path.** `backupRetention.test.ts:34` mocks only `vi.mock('../db', () => ({ db: mockDb }))` — there is no mock on `'../db/schema'` in that file. Task 9 now imports `restoreJobs`/`backupSnapshotRetirements`/`IN_FLIGHT_BACKUP_JOB_STATUSES` from the barrel `'../db/schema'` (joining the file's existing barrel import), and `recoveryTokens` from the concrete `'../db/schema/recoveryTokens'` module (matching `backupWorker.ts`'s existing convention for that specific table). Tasks 6/10/11 were also normalized to add `backupSnapshotRetirements` to each file's existing barrel import rather than a separate `'../db/schema/backup'` line.
4. **ACCEPTED — N+1 query shape.** Task 11's base-existence check re-queries the DB per adopted candidate; accepted as consistent with `reconcileOrphanedBackupSnapshots`'s existing per-candidate DB-read pattern. Flagged for a future pass only if reconcile's throughput over a large orphan backlog becomes a real bottleneck — not addressed in this wave.
5. **RESOLVED — width.** `BACKUP_SNAPSHOT_ID_MAX_LENGTH = 200` (confirmed, `apps/api/src/db/schema/backupConstants.ts`), matching `backup_jobs.snapshot_id`'s existing `varchar(200)` (`apps/api/src/db/schema/backup.ts:247`). Task 3's migration now uses `varchar(200)` for `backup_snapshot_retirements.snapshot_id` (was `varchar(255)`); Task 2's Drizzle schema already used the `BACKUP_SNAPSHOT_ID_MAX_LENGTH` constant directly and needed no change. `backup_jobs.base_snapshot_id` (Task 1) deliberately stays `varchar(255)` per the spec's own explicit choice for that column — the two widths are independent.
6. **ACCEPTED — noted, not fixed.** Task 6's sequential per-target base selection in a multi-target dispatch could theoretically let two sibling targets pin the same base snapshot. Coordinator confirms this is fine as-is (harmless: both dispatch normally, retention just sees two pins instead of one) — left as a noted, unverified-as-impossible edge case, not a defect requiring a fix.
7. **RESOLVED — import.** Confirmed by reading `apps/api/src/routes/backup/configs.ts`'s import block directly: `backupSnapshots` was NOT already imported (only `backupConfigs`, from `'../db/schema'` at line 13). Task 12 now widens that same import line.
8. **RESOLVED — always include `warnings`.** Per coordinator decision, `PATCH /backup/configs/:id`'s response always includes `warnings: string[]` (empty array when there's nothing to warn about), not an optional field. Task 12's implementation and tests were updated accordingly.

## Round-2 review findings — all fixed in the plan text above

An independent review pass found the following defects; each is fixed in place (not merely noted) in the tasks above.

9. **FIXED — retention never invents an identity.** `unknown::<uuid>` is removed entirely (Task 9); a row with `storageIdentity IS NULL` is skipped and counted as a new `skippedUnresolved` counter, retried on a later run.
10. **FIXED — legal hold/immutability re-read under the lock.** Moved from the enumeration pass into `deleteSnapshotRow` itself, decided from the `FOR UPDATE`-locked row (Task 9); the enumeration selects no longer fetch or branch on those columns at all.
11. **FIXED — identity-scoped snapshot_id lookups.** `backup_snapshots.snapshot_id` has no uniqueness constraint (`schema/backup.ts:330`). Every lookup that matches a row by that bare string is now also scoped by `storageIdentity`: retention's backup-pin check (Task 9), the late-result fence's base lookup (Task 10), the `parentSnapshotId` lookup (Task 10, also switched from `configId` to `storageIdentity` scoping), and reconcile's base-existence check (Task 11).
12. **FIXED — §3.7 sweep call shape corrected.** Task 8 wraps `sweepUnreferencedBackupObjects()` in exactly ONE `runWithSystemDbAccess` call (not bare/depth-0, superseding an earlier, since-corrected instruction) so its existing GUC-dependent reads keep working; W02 replaces the single wrap with genuine per-identity contexts.
13. **FIXED — queue schema propagation (P1).** `queueSchemas.ts`'s `.strict()` `backupSnapshotSummarySchema` and `backupEnqueue.ts`'s `ProcessResultsResult.snapshot` interface both widened to carry `baseSnapshotId`/`formatVersion`/`backupIdentity`, with a round-trip regression test (Task 10).
14. **FIXED — dispatch lock query (P1).** The outer-joined `FOR SHARE` (rejected by Postgres — `FOR UPDATE`/`FOR SHARE` cannot apply to the nullable side of an outer join) is split into two statements: `FOR SHARE` on `backup_snapshots` alone, then a plain (unlocked) SELECT against `backup_snapshot_retirements` (Task 6).
15. **FIXED — rejection branch device predicate (P1).** The late-result fence's SELECT and UPDATE are both scoped by `(id, deviceId)`, matching the file's own #3036 convention at the main UPDATE (Task 10) — never by job id alone.
16. **FIXED — late-result fence atomicity + NULL lease (P1).** The whole check-and-write sequence runs inside one `db.transaction` with `FOR UPDATE` on the job row (atomic against the reaper); a NULL `publishLeaseExpiresAt` is now a REJECT (`publish_lease_expired`), not an implicit pass (Task 10). Reconcile additionally refuses to adopt a job whose late result was already fenced (new `'late-result-fenced'` skip reason, Task 11).
17. **FIXED — hyperv/mssql identity stamping (P2).** `stampDispatchPinAndIdentity` is now called for every dispatched target; `storage_identity` is stamped unconditionally, while `publish_lease_expires_at`/`base_snapshot_id` remain file/system_image-only (Task 6).
18. **FIXED — discriminating test assertions (P2).** Task 10's tests now assert the actual captured `parentSnapshotId`/`isIncremental`/`storageIdentity`/`errorLog` values, not `applied === true` alone. Task 13 gained: restore pin with/without `command_id`, recovery-token pin, max-versions-respects-pins, a real-DB late-result-lease-expired case, a two-path concurrent dispatch-vs-retention race, and a `processCleanupExpiredSnapshots` (worker-handler-level) proof of §6(6b).
19. **FIXED — compile/setup issues (P2).** `sql` added to `backupRetention.ts`'s widened `drizzle-orm` import (Task 9); the RLS forge test's `DbAccessContext` shape corrected to the real interface (no `partnerId` field) using the established `orgContext` helper convention, with the SQLSTATE assertion corrected to read `.cause.code` for a Drizzle insert (Task 13); all integration-test run commands now use the safe default test DB instead of the dev DB URl, which `testUtils/integrationDatabaseSafety.ts` actively refuses (Tasks 13-14).
20. **FIXED — migration verification claims (P2).** A Drizzle partial index matching migration `160011`'s `backup_jobs_base_snapshot_id_idx` was added to Task 2's schema edit (previously missing). The plan no longer claims `pnpm db:check-drift` compares the Drizzle schema to a live database — `scripts/check-drift.ts` verifies migration-ledger parity only; a `pnpm db:migrate` run-twice idempotency check was added instead (Tasks 2, 14). The 30-day `backup_snapshot_retirements` pruning pass (spec §3.3) is explicitly handed to W02 (Task 14's Produces/handoff note), since this wave never sets `swept_at` in the first place.

## W02 handoff note (§3.7 call-shape contract — corrected by coordinator's second review pass)

Task 8 makes `processCleanupExpiredSnapshots` call `await runWithSystemDbAccess(() => sweepUnreferencedBackupObjects())` — **ONE shared context for the whole sweep**, opened strictly AFTER every row's retention has already committed independently (Task 9). This matches today's read shape exactly, so `sweepUnreferencedBackupObjects`'s existing internal `db.select(...)` calls keep the working GUCs they rely on (it has no context management of its own — Ground Truth, `backupRetention.ts:982`) — no interim regression is introduced. W02 is expected to replace this single shared wrap with genuinely separate per-identity contexts managed INSIDE `sweepUnreferencedBackupObjects` itself (spec §3.7 item 2: "a separate system context per identity for the DB reads, with every storage call at depth 0"), at which point this call site's wrap is removed entirely and W02 should not need to touch `backupWorker.ts` again beyond that one deletion.

An earlier draft of this plan had this call site bare (no context at all) per an initial, since-superseded coordinator instruction; that was corrected back to the single-wrap shape described above after independent review flagged it would leave the sweep's reads genuinely broken (not merely under-optimized) until W02 landed. The single-wrap shape is the final, authoritative one.
