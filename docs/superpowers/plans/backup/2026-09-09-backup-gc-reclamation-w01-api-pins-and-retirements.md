# Wave 01 — API: server-chosen base, pins, leases, retirements, storage identity, lineage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the server a durable, lease-fenced pin on the incremental-dedupe base it hands the agent, a durable retirement tombstone for every row retention deletes, a per-job/per-snapshot storage identity stamped at dispatch, full lineage (parent/incremental/late-result) plumbing, and a transaction-boundary fix so retention's retirements commit per row instead of inside one giant ambient transaction — the data-model half of D18. The GC sweep rewrite (§3.4) and the agent (§3.5) are W02/W03.

**Architecture:** `backup_jobs` gains `base_snapshot_id`, `publish_lease_expires_at` (set for every dispatched file/system_image job, fixed at dispatch, never renewed), and `storage_identity` (stamped at dispatch from the payload's `providerConfig`). `backup_snapshots` gains a nullable `storage_identity`, copied from the job at publication. A new `backup_snapshot_retirements` table is the durable tombstone retention writes instead of a bare delete. Dispatch acquires the base pin in a job→snapshot lock-ordered transaction; retention is restructured so each candidate row commits in its own system-DB context instead of sharing the worker's blanket transaction (§3.7); a new reaper rule fails commandless pending restores after 1h; lineage fields are threaded through both live results and reconcile-adopted manifests, gated by a late-result fence.

**Tech Stack:** Hono + Drizzle ORM + PostgreSQL (RLS), Vitest (unit + `vitest.integration.config.ts`), zod.

**Spec:** `docs/superpowers/specs/backup/2026-09-09-backup-gc-reclamation-design.md` v3 (§3.1 base pin/lease, §3.2 retention pin checks, §3.3 retirements table, §3.6 storage identity, §3.7 transaction boundaries, §4 migrations/registries — NOT §3.4 sweep rules or §3.5 agent-side, which are W02/W03).

**Depends on:** none (first wave). W02 (GC sweep rewrite) and W03 (agent) depend on this wave's schema + `backupGcKnobs.ts`.

## Global Constraints

- Migration files (next free slot after shipped `2026-10-15-140004`, confirmed via `ls apps/api/migrations/*.sql | sort | tail -1`):
  - `apps/api/migrations/2026-10-15-140005-backup-jobs-base-pin-and-storage-identity.sql`
  - `apps/api/migrations/2026-10-15-140006-backup-snapshot-retirements.sql`
- New columns: `backup_jobs.base_snapshot_id varchar(255)` NULL, `backup_jobs.publish_lease_expires_at timestamptz` NULL (set for **every** dispatched file/system_image job, base or not; fixed at dispatch — never renewed on progress), `backup_jobs.storage_identity text` NULL (stamped at dispatch), `backup_snapshots.storage_identity text` NULL (**forever** nullable — no follow-up `SET NOT NULL` migration; self-healing is W02's sweep job).
- New table: `backup_snapshot_retirements` (columns per spec §3.3, shape-1 RLS, unique `(storage_identity, snapshot_id)`).
- New env knobs, all resolved **per call** (never module-load-cached) via one shared `resolveMsKnob` helper in new file `apps/api/src/services/backupGcKnobs.ts`:
  - `BACKUP_BASE_LEASE_MS` — default 7 d (`604_800_000`), production floor 1 h.
  - `BACKUP_RESTORE_PIN_LINGER_MS` — default 7 d, production floor 1 h.
  - `BACKUP_PUBLISH_MARGIN_MS` — default 1 h (`3_600_000`), production floor 5 min.
- `normalizeStorageIdentity(provider, providerConfig)` (exported, `apps/api/src/jobs/backupRetention.ts:661`) is the ONE identity function for live TypeScript code paths. The migration's backfill replicates its logic in PL/pgSQL for a **guarded** subset of rows only (spec §3.6) — see Task 1's open question on fidelity.
- Registries to touch: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`), `apps/api/src/routes/devices/core.ts` (`CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES`), `apps/api/src/services/tenantExportPolicyRegistry.ts` (`CORE_TENANT_EXPORT_POLICY`). `rls-coverage.integration.test.ts` needs NO new allowlist entry (shape 1 = plain `org_id` column = auto-discovered).
- Lock order for the base pin is **job, then snapshot** (mirrors `routes/devices/moveOrg.ts:248-253`'s "lock parents in a fixed order as the transaction's first statements" pattern).

## 0. Ground truth

All of the below was verified directly against the worktree at `/Users/toddhebebrand/.herdr/worktrees/breeze/backup-gc-5429` on 2026-09-09; every citation was re-opened, not copied from the spec.

- `apps/api/src/db/schema/backup.ts:207-278` (`backupJobs`) — no `baseSnapshotId`/`publishLeaseExpiresAt`/`storageIdentity` columns exist yet. `:247` `snapshotId varchar(BACKUP_SNAPSHOT_ID_MAX_LENGTH)`.
- `apps/api/src/db/schema/backup.ts:280-337` (`backupSnapshots`) — `:300` `isIncremental boolean default(false)` and `:305-308` `parentSnapshotId` self-FK `ON DELETE SET NULL` already exist (D17, migration `2026-10-15-140004`) and are never written by the live write path. No `storageIdentity` column yet.
- `apps/api/src/db/schema/backup.ts:62` — `IN_FLIGHT_BACKUP_JOB_STATUSES = ['pending', 'running'] as const`, exported from this module.
- `apps/api/migrations/2026-10-15-140004-backup-snapshot-lineage-fk-set-null.sql` (full file read) — the newest shipped migration; confirmed via `ls apps/api/migrations/*.sql | sort | tail -1` that no later-sorting file exists, so `140005`/`140006` are free, correctly-ordered slots.
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
- `apps/api/src/jobs/backupRetention.ts:982` — `sweepUnreferencedBackupObjects` has **no internal `withSystemDbAccessContext`/`withDbAccessContext` call of its own** — it relies entirely on the ambient context the caller already opened. Pulling `cleanup-expired-snapshots` out of the blanket wrap (as this wave must) would leave it running with NO context at all unless its call site is separately wrapped — Task 8 wraps the call site (not its internals; internal per-identity context splitting is W02's §3.4/§3.7-item-2 job).
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

## File structure

- **Create** `apps/api/migrations/2026-10-15-140005-backup-jobs-base-pin-and-storage-identity.sql` — new `backup_jobs` columns + partial index; nullable `backup_snapshots.storage_identity` + guarded SQL backfill.
- **Create** `apps/api/migrations/2026-10-15-140006-backup-snapshot-retirements.sql` — new table + shape-1 RLS.
- **Create** `apps/api/src/services/backupGcKnobs.ts` + `apps/api/src/services/backupGcKnobs.test.ts` — shared per-run env-knob resolver.
- **Modify** `apps/api/src/db/schema/backup.ts` — add columns to `backupJobs`/`backupSnapshots`, new `backupSnapshotRetirements` table.
- **Modify** `apps/api/src/services/tenantCascade.ts`, `apps/api/src/routes/devices/core.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts` — registries.
- **Modify** `apps/api/src/jobs/backupWorker.ts` — carve `cleanup-expired-snapshots` out of the blanket wrap; base selection + pin acquisition + storage-identity stamping in `prepareBackupDispatchTargets`.
- **Modify** `apps/api/src/jobs/staleCommandReaper.ts` — new `reapCommandlessPendingRestores` domain.
- **Modify** `apps/api/src/jobs/backupRetention.ts` — per-row system-context retention with pin checks + retirement insert.
- **Modify** `apps/api/src/routes/backup/resultSchemas.ts` — lineage fields on `backupSnapshotResultSchema`.
- **Modify** `apps/api/src/services/backupResultPersistence.ts` — lineage on write + late-result fence.
- **Modify** `apps/api/src/services/backupSnapshotReconcile.ts` — forward lineage, refuse retired/too-old/base-missing adoption.
- **Modify** `apps/api/src/routes/backup/configs.ts` — `warnings: ['storage_identity_changed']` on PATCH.
- **Test (modify)** `apps/api/src/jobs/backupWorker.test.ts`, `apps/api/src/jobs/backupRetention.test.ts`, `apps/api/src/jobs/staleCommandReaper.test.ts`, `apps/api/src/services/backupResultPersistence.test.ts`, `apps/api/src/services/backupSnapshotReconcile.test.ts`, `apps/api/src/routes/backup/configs.test.ts`.
- **Test (new)** `apps/api/src/__tests__/integration/backupRetentionPins.integration.test.ts`, `apps/api/src/__tests__/integration/backupSnapshotRetirementsRls.integration.test.ts`.

---

### Task 1: Migration 140005 — `backup_jobs` pin/identity columns + guarded SQL backfill for `backup_snapshots.storage_identity`

**Files:** Create `apps/api/migrations/2026-10-15-140005-backup-jobs-base-pin-and-storage-identity.sql`.

**Decision (backfill mechanism):** the spec (§3.6/§4) is explicit that this must be a SQL backfill inside the migration, guarded to only touch rows whose config was **not** edited after the snapshot (`backup_configs.updated_at <= backup_snapshots.timestamp`) — everything else, including every NULL-`config_id` row, stays NULL and is self-healed later by the GC sweep (W02) from the storage listing. This supersedes a TS-script approach an earlier draft of this plan used; the guard exists precisely so the fidelity gap between `normalizeStorageIdentity`'s `path.resolve()`/`new URL()` semantics and a hand-written SQL equivalent only matters for the *unguarded* (self-healing) rows, not the ones this migration commits. See the open question below for what's still imperfect even inside the guard.

- [ ] Step 1: Write the failing test — this migration has no unit-testable TS surface; the "red" step is observing the column/table absence against a real DB.
  Command: `docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "\d backup_jobs"` → confirm `base_snapshot_id`/`publish_lease_expires_at`/`storage_identity` are absent.

- [ ] Step 2: Run it, expect FAIL (columns absent) — already true, this is the baseline.

- [ ] Step 3: Implement

```sql
-- apps/api/migrations/2026-10-15-140005-backup-jobs-base-pin-and-storage-identity.sql
-- D18 W01 (#5429 family, spec v3 §3.1/§3.6): server-chosen incremental-dedupe
-- base pin with a fixed publish-lease deadline, plus a per-job/per-snapshot
-- storage identity that survives a backup_configs destination edit.
--
-- publish_lease_expires_at is set for EVERY dispatched file/system_image job
-- (base or not) at DISPATCH time only — it is never renewed (no delivery
-- channel exists to renew it; see backupWorker.ts's stampDispatchPinAndIdentity
-- docstring). storage_identity on backup_snapshots is nullable FOREVER: no
-- follow-up NOT NULL migration exists for it. Rows this migration cannot
-- confidently attribute (config edited after the snapshot, or no config_id at
-- all) are left NULL and self-healed later by the GC sweep (W02) from the live
-- storage listing.
--
-- Idempotent: IF NOT EXISTS on every column/index; the backfill only touches
-- rows where storage_identity IS NULL, so re-running is a no-op once the
-- eligible set has already been filled.

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
  RAISE NOTICE 'backup_snapshots: storage_identity ensured (nullable, no NOT NULL — self-healed by the W02 GC sweep)';
END $$;

-- Guarded backfill (§3.6): only for rows whose config was NOT edited after the
-- snapshot was taken, so the config's CURRENT provider/provider_config is
-- known to be the same one the snapshot was actually written under. This is a
-- best-effort PL/pgSQL port of normalizeStorageIdentity
-- (apps/api/src/jobs/backupRetention.ts:661-672) — see the open question below
-- for where it can diverge from the TS function.
DO $$
DECLARE
  backfilled_count integer := 0;
  left_null_count integer := 0;
BEGIN
  WITH candidates AS (
    SELECT s.id,
           c.provider,
           c.provider_config
    FROM backup_snapshots s
    JOIN backup_configs c ON c.id = s.config_id
    WHERE s.storage_identity IS NULL
      AND c.updated_at <= s."timestamp"
  ),
  computed AS (
    SELECT
      id,
      CASE
        WHEN provider = 'local' THEN
          'local::' || regexp_replace(
            COALESCE(provider_config->>'path', provider_config->>'basePath', ''),
            '/+$', ''
          )
        ELSE
          provider || '::' ||
          CASE
            WHEN provider_config->>'endpoint' IS NULL OR btrim(provider_config->>'endpoint') = '' THEN ''
            WHEN lower(regexp_replace(regexp_replace(provider_config->>'endpoint', '^[a-zA-Z]+://', ''), '/.*$', ''))
                 ~ '^s3(\.dualstack)?([.-][a-z0-9-]+)?\.amazonaws\.com(:[0-9]+)?$'
              THEN ''
            ELSE lower(regexp_replace(regexp_replace(provider_config->>'endpoint', '^[a-zA-Z]+://', ''), '/.*$', ''))
          END
          || '::' ||
          btrim(COALESCE(provider_config->>'bucket', provider_config->>'bucketName', ''))
      END AS identity
    FROM candidates
  )
  UPDATE backup_snapshots s
  SET storage_identity = computed.identity
  FROM computed
  WHERE s.id = computed.id;

  GET DIAGNOSTICS backfilled_count = ROW_COUNT;
  IF backfilled_count > 0 THEN
    RAISE WARNING 'backup_snapshots storage_identity backfill: % row(s) backfilled from an unedited-since-snapshot config', backfilled_count;
  END IF;

  SELECT count(*) INTO left_null_count FROM backup_snapshots WHERE storage_identity IS NULL;
  IF left_null_count > 0 THEN
    RAISE WARNING 'backup_snapshots storage_identity backfill: % row(s) left NULL (config edited after the snapshot, or config_id NULL) — the W02 GC sweep self-heals these from the storage listing per spec §3.6', left_null_count;
  END IF;
END $$;
```

- [ ] Step 4: Run, expect PASS
  Commands:
  - `pnpm db:migrate`
  - `docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "\d backup_jobs"` — confirm all three columns present.
  - `docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "SELECT count(*) FROM backup_snapshots WHERE storage_identity IS NOT NULL;"` — non-zero if any pre-existing rows had an unedited config.

- [ ] Step 5: Commit
  `git add apps/api/migrations/2026-10-15-140005-backup-jobs-base-pin-and-storage-identity.sql && git commit -m "feat(backup): base-pin/storage-identity columns + guarded backfill (D18 W01)"`

---

### Task 2: Drizzle schema edits — `backup.ts` new columns + `backupSnapshotRetirements` table

**Files:** Modify `apps/api/src/db/schema/backup.ts` (add to `backupJobs` after `snapshotId` ~:247, `backupSnapshots` after `backupType` ~:322, new table after `backupSnapshotFiles` ~:356).

**Interfaces:** Produces `backupSnapshotRetirements` Drizzle table export, `backupJobs.baseSnapshotId`/`.publishLeaseExpiresAt`/`.storageIdentity`, `backupSnapshots.storageIdentity`.

- [ ] Step 1: Write the failing test (schema drift is the mechanical gate here — no unit framework exercises schema files directly per repo convention)
  Command: `pnpm db:check-drift` — expect FAIL once Task 1's migration is applied but the schema hasn't caught up (or vice versa if this task lands first).

- [ ] Step 2: Confirm the FAIL is the expected drift (missing columns/table), not a pre-existing unrelated one.

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

  (`text` and `pgEnum` are already imported at the top of `backup.ts` — confirmed at lines 1-15.)

- [ ] Step 4: Run, expect PASS
  Command: `pnpm db:check-drift`

- [ ] Step 5: Commit
  `git add apps/api/src/db/schema/backup.ts && git commit -m "feat(backup): add base-pin/storage-identity columns and backupSnapshotRetirements schema (D18 W01)"`

---

### Task 3: `backup_snapshot_retirements` table + RLS migration

**Files:** Create `apps/api/migrations/2026-10-15-140006-backup-snapshot-retirements.sql`.

- [ ] Step 1: Write the failing test
  Command: `docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "SELECT * FROM backup_snapshot_retirements LIMIT 1;"` → expect `ERROR: relation "backup_snapshot_retirements" does not exist`.

- [ ] Step 2: Run it, expect FAIL (as above).

- [ ] Step 3: Implement

```sql
-- apps/api/migrations/2026-10-15-140006-backup-snapshot-retirements.sql
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
  snapshot_id varchar(255) NOT NULL,
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

  Note: `varchar(255)` here (not `BACKUP_SNAPSHOT_ID_MAX_LENGTH`'s literal value) matches the width already used for `backup_jobs.base_snapshot_id` in Task 1 — confirm both stay in sync with the constant if it ever changes.

- [ ] Step 4: Run, expect PASS
  Commands:
  - `pnpm db:migrate`
  - `docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "SELECT * FROM backup_snapshot_retirements LIMIT 1;"` → `0 rows`, no error.
  - `pnpm db:check-drift`

- [ ] Step 5: Commit
  `git add apps/api/migrations/2026-10-15-140006-backup-snapshot-retirements.sql && git commit -m "feat(backup): backup_snapshot_retirements table + RLS (D18 W01)"`

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
- Produces: new function `stampDispatchPinAndIdentity(params): Promise<{ baseSnapshotId: string; publishLeaseExpiresAt: Date }>`; payload fields `baseSnapshotId: string` (`""` = full run) and `publishLeaseExpiresAt: string` (RFC3339) added to every `backup_run` command's payload.

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
    // First select in the transaction is the base-candidate lookup; second
    // (inside the `.for('share')` chain) is the re-check lock. Both return a
    // matching row so the base is pinned.
    let selectCall = 0;
    mockDb.select.mockImplementation(() => {
      selectCall += 1;
      return {
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        leftJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(
          selectCall === 1 ? [{ id: 'base-row-id', snapshotId: 'base-snap-1' }] : [{ id: 'base-row-id' }],
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
// apps/api/src/jobs/backupWorker.ts — new imports
import { resolveBackupBaseLeaseMs } from '../services/backupGcKnobs';
import { normalizeStorageIdentity } from './backupRetention';
import { backupSnapshotRetirements } from '../db/schema/backup';
```

```ts
// apps/api/src/jobs/backupWorker.ts — new function, placed just above prepareBackupDispatchTargets (before line 609)

/**
 * D18 §3.1/§3.6: stamps this job's storage_identity (from the providerConfig
 * actually placed in the dispatch payload) and a FIXED publish-lease deadline
 * — for EVERY dispatched file/system_image target, base found or not — and,
 * when an eligible incremental-dedupe base exists, pins it.
 *
 * Lock order is JOB then SNAPSHOT (mirrors the parent-rows-first pattern at
 * routes/devices/moveOrg.ts:248-253): the UPDATE on backup_jobs below takes
 * the job row's lock first; the FOR SHARE re-check on backup_snapshots takes
 * the candidate's lock second. Retention's per-row delete (backupRetention.ts)
 * takes FOR UPDATE on the snapshot row — whichever side gets there first wins:
 * the other either sees the live pin (and skips) or finds the row already
 * gone (and this function falls back to a full run). No FK-column write
 * happens while a lock from the other table is held (cf. #3911's key-share
 * deadlock).
 */
async function stampDispatchPinAndIdentity(params: {
  deviceId: string;
  configId: string;
  jobId: string;
  mode: 'file' | 'system_image';
  provider: string;
  providerConfig: Record<string, unknown>;
}): Promise<{ baseSnapshotId: string; publishLeaseExpiresAt: Date }> {
  const leaseMs = resolveBackupBaseLeaseMs();
  const publishLeaseExpiresAt = new Date(Date.now() + leaseMs);
  const storageIdentity = normalizeStorageIdentity(params.provider, params.providerConfig);

  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: backupSnapshots.id, snapshotId: backupSnapshots.snapshotId })
      .from(backupSnapshots)
      .innerJoin(backupJobs, eq(backupSnapshots.jobId, backupJobs.id))
      .where(
        and(
          eq(backupSnapshots.deviceId, params.deviceId),
          eq(backupSnapshots.configId, params.configId),
          params.mode === 'system_image'
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

    // SNAPSHOT row second: FOR SHARE re-check that the candidate is still
    // present and unretired. A concurrent retention delete either already
    // removed the row (this SELECT returns nothing) or is blocked behind
    // this lock until commit (its own FOR UPDATE on the same row).
    const [locked] = await tx
      .select({ id: backupSnapshots.id })
      .from(backupSnapshots)
      .leftJoin(
        backupSnapshotRetirements,
        and(
          eq(backupSnapshotRetirements.storageIdentity, storageIdentity),
          eq(backupSnapshotRetirements.snapshotId, candidate.snapshotId),
        ),
      )
      .where(and(eq(backupSnapshots.id, candidate.id), isNull(backupSnapshotRetirements.id)))
      .for('share');

    if (!locked) {
      await tx.update(backupJobs).set({ baseSnapshotId: null }).where(eq(backupJobs.id, params.jobId));
      return { baseSnapshotId: '', publishLeaseExpiresAt };
    }

    return { baseSnapshotId: candidate.snapshotId, publishLeaseExpiresAt };
  });
}
```

```ts
// apps/api/src/jobs/backupWorker.ts — inside prepareBackupDispatchTargets's per-target loop,
// right before `const command: AgentCommand = {` (~:742):

    let dispatchPin: { baseSnapshotId: string; publishLeaseExpiresAt: Date } | null = null;
    if (target.commandType === 'backup_run') {
      dispatchPin = await stampDispatchPinAndIdentity({
        deviceId: data.deviceId,
        configId: data.configId,
        jobId: commandJobId,
        mode: (target.payload as Record<string, unknown>).systemImage === true ? 'system_image' : 'file',
        provider: config.provider,
        providerConfig: commandProviderConfig,
      });
    }

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
        ...(dispatchPin
          ? {
              baseSnapshotId: dispatchPin.baseSnapshotId,
              publishLeaseExpiresAt: dispatchPin.publishLeaseExpiresAt.toISOString(),
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

**Why this task must land before Task 9:** Task 9 restructures `cleanupExpiredSnapshots` (in `backupRetention.ts`) to open its own real per-row transaction via `withSystemDbAccessContext`. That only works if the call arrives with NO ambient context already open — today it's nested inside the blanket `runWithSystemDbAccess(async () => { switch(...) {...} })` at `backupWorker.ts:101`, where a nested `withSystemDbAccessContext` call is a no-op passthrough (same outer transaction, no new commit boundary). This task removes that ambient wrap for `cleanup-expired-snapshots` the same way `dispatch-backup` is already excluded from it (`:89-99`), and gives the GC sweep call its own separate context so a sweep failure can never roll back a retirement Task 9 already committed.

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
    // Its own context, separate from every retention row's — a GC failure
    // must never roll back a retirement that has already committed.
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
- Consumes: `withSystemDbAccessContext` from `../db`; `resolveBackupRestorePinLingerMs`/`resolveBackupPublishMarginMs` from `../services/backupGcKnobs`; `restoreJobs`, `backupSnapshotRetirements`, `IN_FLIGHT_BACKUP_JOB_STATUSES` from `../db/schema/backup`; `recoveryTokens` from `../db/schema/recoveryTokens`; `gt` added to the `drizzle-orm` import.
- Produces: `RetentionCleanupResult` gains `skippedPinned: number`. `tryDeleteSnapshotRow` now returns `'deleted' | 'pinned' | 'failed'` (was `boolean`) and opens its own `withSystemDbAccessContext` per call — one real top-level transaction per candidate row, per §3.7.

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
    }]); // candidate select
    selectQueue.push([{ id: 'snap-1' }]); // FOR UPDATE lock
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
    }]); // candidate select
    selectQueue.push([{ id: 'snap-2' }]); // FOR UPDATE lock
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
});
```

- [ ] Step 2: Run it, expect FAIL — `result.skippedPinned` is `undefined` (field doesn't exist yet); `insertedRows` stays empty in the second case (no retirement is written today).
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
} from '../db/schema/backup';
import { recoveryTokens } from '../db/schema/recoveryTokens';
import { eq, and, or, lt, gt, desc, inArray, isNull } from 'drizzle-orm';
import { resolveBackupRestorePinLingerMs, resolveBackupPublishMarginMs } from '../services/backupGcKnobs';
```

  (`configPolicyBackupSettings`/`backupConfigs`/`backupPolicies`/`backupSnapshots`/`backupJobs` were previously imported from `'../db/schema'` (the barrel) — switching `restoreJobs`/`backupSnapshotRetirements`/`IN_FLIGHT_BACKUP_JOB_STATUSES` to the concrete `'../db/schema/backup'` module avoids a barrel/mock mismatch in `backupRetention.test.ts`'s `vi.mock('../db/schema', ...)` if one exists — confirm during implementation whether the file's existing imports already come from `'../db/schema'` or `'../db/schema/backup'` and match that convention exactly rather than mixing styles.)

```ts
// apps/api/src/jobs/backupRetention.ts:159-171 — RetentionCleanupResult gains a field
export type RetentionCleanupResult = {
  deleted: number;
  skippedLegalHold: number;
  skippedImmutable: number;
  skippedPinned: number;
  prunedByMaxVersions: number;
  failed: number;
};
```

```ts
// apps/api/src/jobs/backupRetention.ts:189-221 — replace deleteSnapshotRow + tryDeleteSnapshotRow
/**
 * Deletes a `backup_snapshots` ROW ONLY, after checking every pin type (D18
 * §3.2: backup-job base pin via publish_lease_expires_at + margin, restore-job
 * pin, recovery-token pin — legal hold/immutability are checked by the caller
 * before this is ever invoked) and writing a durable retirement tombstone
 * (backup_snapshot_retirements) in the SAME per-row system context as the
 * delete. The caller (`tryDeleteSnapshotRow`) wraps this whole function in its
 * own `withSystemDbAccessContext` call — since `cleanupExpiredSnapshots` is no
 * longer invoked from inside any ambient transaction (D18 §3.7,
 * jobs/backupWorker.ts), that call opens a REAL top-level Postgres
 * transaction distinct from every other row's, so a retirement written here
 * commits durably before the next candidate row is even considered.
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
 *
 * Returns 'pinned' (left alone, a pin is still live) or 'deleted' (row
 * removed and retirement written, or the row was already gone — a no-op
 * treated as success).
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
}): Promise<'pinned' | 'deleted'> {
  const restoreLingerMs = resolveBackupRestorePinLingerMs();
  const restoreLingerCutoff = new Date(Date.now() - restoreLingerMs);
  const publishMarginMs = resolveBackupPublishMarginMs();
  const publishMarginCutoff = new Date(Date.now() - publishMarginMs);

  const [locked] = await db
    .select({ id: backupSnapshots.id })
    .from(backupSnapshots)
    .where(eq(backupSnapshots.id, params.id))
    .for('update');

  if (!locked) {
    // Already gone (concurrent delete/adoption) — nothing to do.
    return 'deleted';
  }

  // Backup pin (§3.1/§3.2): a backup_jobs row still building on this snapshot
  // as its base. status IN (pending, running) covers an in-flight run;
  // publish_lease_expires_at > now() - margin covers a reaped-but-still-
  // uploading helper (the same lease+margin the helper itself enforces
  // before publishing — see spec §3.1's "publish margin").
  const [backupPin] = await db
    .select({ id: backupJobs.id })
    .from(backupJobs)
    .where(
      and(
        eq(backupJobs.baseSnapshotId, params.snapshotId),
        or(
          inArray(backupJobs.status, IN_FLIGHT_BACKUP_JOB_STATUSES),
          gt(backupJobs.publishLeaseExpiresAt, publishMarginCutoff),
        ),
      ),
    )
    .limit(1);
  if (backupPin) return 'pinned';

  // Restore pin (§3.2, F8): the in-flight status check only counts once a
  // command exists (a commandless pending row is reaped by
  // staleCommandReaper's own 1h rule, Task 7, instead of pinning forever);
  // the linger separately covers both that crash window and a helper reading
  // past the server's restore timeout.
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

  // Recovery pin (§3.2): active/authenticated token, or one not yet
  // completed and still within its expiry + the same linger (covers a BMR
  // session mid-download).
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
    storageIdentity: params.storageIdentity ?? `unknown::${params.id}`,
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
}): Promise<'deleted' | 'pinned' | 'failed'> {
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
// wrapped in their own context, both delete loops updated to the new outcome type
export async function cleanupExpiredSnapshots(
  orgId: string
): Promise<RetentionCleanupResult> {
  const now = new Date();
  const result: RetentionCleanupResult = {
    deleted: 0,
    skippedLegalHold: 0,
    skippedImmutable: 0,
    skippedPinned: 0,
    prunedByMaxVersions: 0,
    failed: 0,
  };

  // D18 §3.7: this read runs with no ambient context (cleanupExpiredSnapshots
  // is no longer called from inside one) — a snapshot-in-time read is fine
  // here since every candidate is independently re-verified with FOR UPDATE
  // inside its own per-row commit below.
  const expired = await withSystemDbAccessContext(() =>
    db
      .select({
        id: backupSnapshots.id,
        snapshotId: backupSnapshots.snapshotId,
        metadata: backupSnapshots.metadata,
        legalHold: backupSnapshots.legalHold,
        isImmutable: backupSnapshots.isImmutable,
        immutableUntil: backupSnapshots.immutableUntil,
        provider: backupConfigs.provider,
        providerConfig: backupConfigs.providerConfig,
        deviceId: backupSnapshots.deviceId,
        configId: backupSnapshots.configId,
        storageIdentity: backupSnapshots.storageIdentity,
        backupType: backupSnapshots.backupType,
      })
      .from(backupSnapshots)
      .leftJoin(backupConfigs, eq(backupSnapshots.configId, backupConfigs.id))
      .where(
        and(
          eq(backupSnapshots.orgId, orgId),
          lt(backupSnapshots.expiresAt, now)
        )
      )
  );

  for (const snap of expired) {
    if (snap.legalHold) {
      result.skippedLegalHold++;
      console.warn(`[BackupRetention] Snapshot ${snap.snapshotId} held by legal hold — skipping deletion`);
      continue;
    }
    if (snap.isImmutable && snap.immutableUntil && snap.immutableUntil > now) {
      result.skippedImmutable++;
      console.warn(`[BackupRetention] Snapshot ${snap.snapshotId} immutable until ${snap.immutableUntil.toISOString()} — skipping deletion`);
      continue;
    }

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
    if (outcome === 'deleted') result.deleted++;
    else if (outcome === 'pinned') result.skippedPinned++;
    else result.failed++;
  }

  const versionBoundSnapshots = await withSystemDbAccessContext(() =>
    db
      .select({
        id: backupSnapshots.id,
        snapshotId: backupSnapshots.snapshotId,
        timestamp: backupSnapshots.timestamp,
        deviceId: backupSnapshots.deviceId,
        configId: backupSnapshots.configId,
        metadata: backupSnapshots.metadata,
        legalHold: backupSnapshots.legalHold,
        isImmutable: backupSnapshots.isImmutable,
        immutableUntil: backupSnapshots.immutableUntil,
        provider: backupConfigs.provider,
        providerConfig: backupConfigs.providerConfig,
        storageIdentity: backupSnapshots.storageIdentity,
        backupType: backupSnapshots.backupType,
        retention: configPolicyBackupSettings.retention,
      })
      .from(backupSnapshots)
      .innerJoin(backupJobs, eq(backupSnapshots.jobId, backupJobs.id))
      .leftJoin(backupConfigs, eq(backupSnapshots.configId, backupConfigs.id))
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
      if (snap.legalHold) {
        result.skippedLegalHold++;
        continue;
      }
      if (snap.isImmutable && snap.immutableUntil && snap.immutableUntil > now) {
        result.skippedImmutable++;
        continue;
      }

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
      if (outcome === 'deleted') {
        result.deleted++;
        result.prunedByMaxVersions++;
      } else if (outcome === 'pinned') {
        result.skippedPinned++;
      } else {
        result.failed++;
      }
    }
  }

  if (
    result.deleted > 0 || result.skippedLegalHold > 0 || result.skippedImmutable > 0 ||
    result.skippedPinned > 0 || result.prunedByMaxVersions > 0 || result.failed > 0
  ) {
    console.log(
      `[BackupRetention] Org ${orgId}: deleted ${result.deleted}, ` +
      `skipped ${result.skippedLegalHold} (legal hold), ${result.skippedImmutable} (immutable), ` +
      `${result.skippedPinned} (pinned), pruned ${result.prunedByMaxVersions} by maxVersions` +
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

- [ ] Step 4: Run, expect PASS
  Command: `cd apps/api && npx vitest run src/jobs/backupRetention.test.ts`

- [ ] Step 5: Commit
  `git add apps/api/src/jobs/backupRetention.ts apps/api/src/jobs/backupRetention.test.ts && git commit -m "feat(backup): retention checks base/restore/recovery pins and writes a retirement row per committed row (D18 W01 §3.2/§3.3/§3.7)"`

---

### Task 10: Lineage on write — `resultSchemas.ts` + `backupResultPersistence.ts` + late-result fence

**Files:** Modify `apps/api/src/routes/backup/resultSchemas.ts:27-32`, `apps/api/src/services/backupResultPersistence.ts:1041-1051` (widen `updatedJob` select), `:972-981` area (new pre-check before the main UPDATE), `:1143-1162` (`snapshotValues`). Test: `apps/api/src/services/backupResultPersistence.test.ts`.

**Interfaces:**
- Produces: `backupSnapshotResultSchema` gains `baseSnapshotId?: string`, `formatVersion?: number`, `backupIdentity?: string`.
- Produces: `backupSnapshots.parentSnapshotId`/`.isIncremental`/`.storageIdentity` are now set on every successful write; `storageIdentity` is **copied from the job's own stamped `storageIdentity`** (Task 6), never recomputed from the config.
- Produces: a late result for a reaped-terminal job is rejected with `errorLog` containing `publish_lease_expired` or `base_retired` when the fence fails.

- [ ] Step 1: Write the failing test

```ts
// apps/api/src/services/backupResultPersistence.test.ts — new cases (mirror this file's existing mocking style)
  it('sets parentSnapshotId/isIncremental/storageIdentity from the job and result (D18 W01)', async () => {
    // Arrange: updatedJob's widened .returning() resolves { id, orgId, configId,
    // backupType, backupMode, baseSnapshotId: 'snap-1', publishLeaseExpiresAt: <future>,
    // storageIdentity: 's3::e::b' }; a lookup for the base row by
    // (configId, snapshotId='snap-1') returns { id: 'base-db-id' }.
    const result = await applyBackupCommandResultToJob({
      jobId: 'job-1', orgId: 'org-1', deviceId: 'device-1', resultStatus: 'completed',
      result: {
        snapshotId: 'snap-2', snapshot: { id: 'snap-2', baseSnapshotId: 'snap-1', formatVersion: 2, files: [] },
        filesBackedUp: 0, bytesBackedUp: 0, referencedFiles: 5,
      } as any,
      source: 'agent',
    });

    expect(result.applied).toBe(true);
    // Assert the values passed to the backup_snapshots insert/update carried
    // parentSnapshotId = 'base-db-id', isIncremental = true, and
    // storageIdentity = 's3::e::b' (copied straight from the job row, no
    // config re-lookup) — via this file's existing capture mechanism.
  });

  it('fails a late result with publish_lease_expired when the job is reaped-terminal and its lease has passed', async () => {
    // Arrange: job row is 'failed' with STALE_BACKUP_REAP_MARKER,
    // publishLeaseExpiresAt in the past.
    const result = await applyBackupCommandResultToJob({
      jobId: 'job-2', orgId: 'org-1', deviceId: 'device-1', resultStatus: 'completed',
      result: { snapshotId: 'snap-3', snapshot: { id: 'snap-3' }, filesBackedUp: 1, bytesBackedUp: 1 } as any,
      source: 'agent',
    });

    expect(result.applied).toBe(true);
    // The job's own row should have been updated to status 'failed' with
    // errorLog containing 'publish_lease_expired', NOT flipped to completed.
  });

  it('fails a late result with base_retired when the lease is live but the base row is gone', async () => {
    // Arrange: job row is 'failed' with STALE_BACKUP_REAP_MARKER,
    // publishLeaseExpiresAt in the future, baseSnapshotId set, and the
    // lookup for that snapshotId finds NO row (retired + swept, or never
    // existed).
    const result = await applyBackupCommandResultToJob({
      jobId: 'job-3', orgId: 'org-1', deviceId: 'device-1', resultStatus: 'completed',
      result: { snapshotId: 'snap-4', snapshot: { id: 'snap-4' }, filesBackedUp: 1, bytesBackedUp: 1 } as any,
      source: 'agent',
    });

    expect(result.applied).toBe(true);
    // errorLog should contain 'base_retired'.
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
 * 'failed' terminal status (STALE_BACKUP_REAP_MARKER) is accepted only if
 * its publish_lease_expires_at has not yet passed AND (it has no base pin,
 * or its base row still exists and is not retired). Otherwise the caller
 * must record the result as failed with a distinguishing reason instead of
 * flipping the job to completed — the manifest the agent uploaded may
 * reference storage GC has already started reclaiming.
 */
async function checkLateResultBaseFence(job: {
  baseSnapshotId: string | null;
  publishLeaseExpiresAt: Date | null;
}): Promise<{ ok: true } | { ok: false; reason: 'publish_lease_expired' | 'base_retired' }> {
  if (job.publishLeaseExpiresAt && job.publishLeaseExpiresAt.getTime() < Date.now()) {
    return { ok: false, reason: 'publish_lease_expired' };
  }
  if (!job.baseSnapshotId) return { ok: true };

  const [baseRow] = await db
    .select({ id: backupSnapshots.id, storageIdentity: backupSnapshots.storageIdentity })
    .from(backupSnapshots)
    .where(eq(backupSnapshots.snapshotId, job.baseSnapshotId))
    .limit(1);
  if (!baseRow) return { ok: false, reason: 'base_retired' };

  const [retirement] = await db
    .select({ id: backupSnapshotRetirements.id })
    .from(backupSnapshotRetirements)
    .where(
      and(
        eq(backupSnapshotRetirements.storageIdentity, baseRow.storageIdentity ?? ''),
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
    const [currentJob] = await db
      .select({
        status: backupJobs.status,
        errorLog: backupJobs.errorLog,
        baseSnapshotId: backupJobs.baseSnapshotId,
        publishLeaseExpiresAt: backupJobs.publishLeaseExpiresAt,
      })
      .from(backupJobs)
      .where(eq(backupJobs.id, jobId))
      .limit(1);

    const isReapedTerminal =
      currentJob?.status === 'failed' &&
      typeof currentJob.errorLog === 'string' &&
      currentJob.errorLog.includes(STALE_BACKUP_REAP_MARKER);

    if (isReapedTerminal) {
      const fence = await checkLateResultBaseFence(currentJob);
      if (!fence.ok) {
        const detail =
          fence.reason === 'publish_lease_expired'
            ? 'its publish lease had already expired'
            : 'its dedupe base was reclaimed';
        await db
          .update(backupJobs)
          .set({
            status: 'failed',
            completedAt: new Date(),
            updatedAt: new Date(),
            errorLog: `${fence.reason}: late result rejected — ${detail} before this result arrived`,
          })
          .where(eq(backupJobs.id, jobId));
        return { applied: true, snapshotDbId: null, providerSnapshotId };
      }
    }
  }
```

```ts
// apps/api/src/services/backupResultPersistence.ts:1143-1162 — snapshotValues gains lineage fields
  let parentSnapshotId: string | null = null;
  const baseSnapshotId = result.snapshot?.baseSnapshotId;
  if (updatedJob.configId && baseSnapshotId) {
    const [baseRow] = await db
      .select({ id: backupSnapshots.id })
      .from(backupSnapshots)
      .where(and(eq(backupSnapshots.configId, updatedJob.configId), eq(backupSnapshots.snapshotId, baseSnapshotId)))
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

  Add `backupSnapshotRetirements` to this file's imports (`import { backupSnapshotRetirements } from '../db/schema/backup';`); `STALE_BACKUP_REAP_MARKER` is already imported (`:11`).

- [ ] Step 4: Run, expect PASS
  Command: `cd apps/api && npx vitest run src/services/backupResultPersistence.test.ts`

- [ ] Step 5: Commit
  `git add apps/api/src/routes/backup/resultSchemas.ts apps/api/src/services/backupResultPersistence.ts apps/api/src/services/backupResultPersistence.test.ts && git commit -m "feat(backup): lineage fields on write + publish-lease/base-retirement late-result fence (D18 W01 §3.1)"`

---

### Task 11: Reconcile — forward lineage, refuse retired/too-old/base-missing adoption

**Files:** Modify `apps/api/src/services/backupSnapshotReconcile.ts:135-155` (`ReconcileSkipReason`), `:538-585` (`manifestToCommandResult`), `:669-720` (new pre-loop retired-id lookup + in-loop checks), `:864-882` (new base-existence check after the manifest parses). Test: `apps/api/src/services/backupSnapshotReconcile.test.ts`.

**Interfaces:** Consumes `backupSnapshotRetirements` schema. `RECONCILE_ORPHAN_HALF_WINDOW_MS` is a local literal (half of the 9-day default `BACKUP_GC_ORPHAN_MANIFEST_MAX_AGE_MS`, which doesn't exist as a named knob until W02) with a `TODO(W02)` to replace it once `backupGcKnobs.ts` grows that export.

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
  | 'base-missing';
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
// apps/api/src/services/backupSnapshotReconcile.ts — new import + constant near the top of the file
import { backupSnapshotRetirements } from '../db/schema/backup';

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
          .where(and(eq(backupSnapshots.snapshotId, declaredBase), isNull(backupSnapshotRetirements.id)))
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

  Add `inArray`/`isNull` to this file's `drizzle-orm` import if not already present (confirm during implementation — several are already used elsewhere in the file for the claims lookups).

- [ ] Step 4: Run, expect PASS
  Command: `cd apps/api && npx vitest run src/services/backupSnapshotReconcile.test.ts`

- [ ] Step 5: Commit
  `git add apps/api/src/services/backupSnapshotReconcile.ts apps/api/src/services/backupSnapshotReconcile.test.ts && git commit -m "feat(backup): reconcile forwards lineage and refuses retired/stale/base-missing adoption (D18 W01 §3.4)"`

---

### Task 12: `PATCH /backup/configs/:id` — warn when the edit changes storage identity

**Files:** Modify `apps/api/src/routes/backup/configs.ts:440-467`. Test: `apps/api/src/routes/backup/configs.test.ts`.

**Interfaces:** Response from `PATCH /backup/configs/:id` gains an optional `warnings: string[]` field, populated with `'storage_identity_changed'` when the edit changes `normalizeStorageIdentity(provider, providerConfig)` for a config that has at least one `backup_snapshots` row. Never blocks the write.

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

  it('does not warn when the edit does not change storage identity', async () => {
    // Same config, PATCH body only changes `name`.
    const res = await app.request('/backup/configs/config-1?orgId=org-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    const body = await res.json();
    expect(body.warnings ?? []).toEqual([]);
  });
```

- [ ] Step 2: Run it, expect FAIL — `body.warnings` is `undefined`.
  Command: `cd apps/api && npx vitest run src/routes/backup/configs.test.ts`

- [ ] Step 3: Implement

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

    return c.json(warnings.length > 0 ? { ...toConfigResponse(row), warnings } : toConfigResponse(row));
```

  `backupSnapshots` must already be imported in this route file (it is used elsewhere for other backup routes in this module tree — confirm and add if missing).

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
  devices,
  organizations,
  partners,
  sites,
} from '../../db/schema';
import { cleanupExpiredSnapshots } from '../../jobs/backupRetention';

const runDb = it.runIf(!!process.env.DATABASE_URL);

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
```

```ts
// apps/api/src/__tests__/integration/backupSnapshotRetirementsRls.integration.test.ts
import './setup';

import { expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { backupConfigs, backupSnapshotRetirements, devices, organizations, partners, sites } from '../../db/schema';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// D18 §3.3: shape-1 RLS forge — an org-scoped context for org B must not be
// able to insert (or read) a retirement row stamped with org A's id.
runDb('forges a cross-tenant insert on backup_snapshot_retirements and gets 42501', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { orgAId, orgBId, configId, deviceId } = await withSystemDbAccessContext(async () => {
    const [partner] = await db.insert(partners).values({ name: `RLSP ${unique}`, slug: `rlsp-${unique}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [orgA] = await db.insert(organizations).values({ currencyCode: 'USD', partnerId: partner!.id, name: `RLSA ${unique}`, slug: `rlsa-${unique}`, type: 'customer', status: 'active' }).returning({ id: organizations.id });
    const [orgB] = await db.insert(organizations).values({ currencyCode: 'USD', partnerId: partner!.id, name: `RLSB ${unique}`, slug: `rlsb-${unique}`, type: 'customer', status: 'active' }).returning({ id: organizations.id });
    const [site] = await db.insert(sites).values({ orgId: orgA!.id, name: `RLSS ${unique}` }).returning({ id: sites.id });
    const [device] = await db.insert(devices).values({ orgId: orgA!.id, siteId: site!.id, agentId: `rlsa-agent-${unique}`, hostname: `rlsa-host-${unique}`, osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online' }).returning({ id: devices.id });
    const [config] = await db.insert(backupConfigs).values({ orgId: orgA!.id, name: `RLSC ${unique}`, type: 'file', provider: 'local', providerConfig: {} }).returning({ id: backupConfigs.id });
    return { orgAId: orgA!.id, orgBId: orgB!.id, configId: config!.id, deviceId: device!.id };
  });

  await expect(
    withDbAccessContext({ scope: 'organization', orgId: orgBId, partnerId: null }, () =>
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
  ).rejects.toMatchObject({ code: '42501' });
});
```

  Confirm `withDbAccessContext`'s exact parameter shape (`{ scope, orgId, partnerId }` or similar) against `apps/api/src/db/index.ts:525-554` before finalizing — mirror whatever an existing RLS-forge integration test in this repo already uses (e.g. search `rejects.toMatchObject({ code: '42501' })` across `__tests__/integration/`) rather than guessing the context-object shape from scratch.

- [ ] Step 2: Run it, expect FAIL against the current code (before Tasks 1-9 land) or PASS trivially once run after — this task is naturally the LAST implementation task, so by the time it's written Tasks 1-11 should already be in place; if any of these tests fail unexpectedly at this point, that's a real defect in an earlier task, not a sequencing artifact.
  Command: `cd apps/api && DATABASE_URL=postgresql://breeze:breeze@localhost:5432/breeze npx vitest run --config vitest.integration.config.ts src/__tests__/integration/backupRetentionPins.integration.test.ts src/__tests__/integration/backupSnapshotRetirementsRls.integration.test.ts`

- [ ] Step 3: (No separate implement step — these tests exercise Tasks 1-11's already-implemented code.)

- [ ] Step 4: Run, expect PASS
  Command: same as Step 2.

- [ ] Step 5: Commit
  `git add apps/api/src/__tests__/integration/backupRetentionPins.integration.test.ts apps/api/src/__tests__/integration/backupSnapshotRetirementsRls.integration.test.ts && git commit -m "test(backup): integration coverage for base pins, retirements, per-row commit, and RLS forge (D18 W01)"`

---

### Task 14: Wave verification

- [ ] `cd apps/api && npx tsc --noEmit` (or `pnpm --filter @breeze/api exec tsc --noEmit` — no dedicated `typecheck` script exists in `apps/api/package.json`, confirmed).
- [ ] `cd apps/api && npx vitest run src/services/backupGcKnobs.test.ts src/jobs/backupWorker.test.ts src/jobs/staleCommandReaper.test.ts src/jobs/backupRetention.test.ts src/services/backupResultPersistence.test.ts src/services/backupSnapshotReconcile.test.ts src/routes/backup/configs.test.ts`.
- [ ] `pnpm db:check-drift`
- [ ] `cd apps/api && DATABASE_URL=postgresql://breeze:breeze@localhost:5432/breeze npx vitest run --config vitest.integration.config.ts src/__tests__/integration/backupRetentionPins.integration.test.ts src/__tests__/integration/backupSnapshotRetirementsRls.integration.test.ts`
- [ ] Contract suites this wave's registry edits are graded against (tenancy/cascade code was touched — run these before PR per CLAUDE.md):
  - `find apps/api/src -iname "tenantCascade*integration*"` then `npx vitest run <path>` against a real DB.
  - `apps/api/src/routes/devices/*.test.ts` matching `cascade`/`moveOrg` (both device-side lists fail in the unit job since they read the Drizzle schema statically — no live DB required).
  - `apps/api/src/services/tenantExportPolicyRegistry`'s check script/integration test (`grep -n check-tenant-export-policy apps/api/package.json` for the exact invocation) and `tenant-export-policy.integration.test.ts` + `tenantExportErasureRoundtrip.integration.test.ts` (only fail under Integration Tests — run against a real DB before PR).
  - `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — confirm it still passes with no new allowlist entry needed for shape-1 auto-discovery.
- [ ] `pnpm lint`
- [ ] PR body checklist:
  - [ ] Migrations `140005`/`140006` applied and idempotent-verified (`pnpm db:migrate` run twice locally, second run a no-op).
  - [ ] `pnpm db:check-drift` clean.
  - [ ] Tenancy contract suites (cascade order, device cascade/denormalized lists, export-policy, rls-coverage) all green against a real DB, not just the unit job.
  - [ ] `Closes #<W01 sub-issue>` once this feature is registered via `feature-lifecycle` (per CLAUDE.md's Feature Lifecycle Tracking section, if this plan is executed as a tracked wave).
  - [ ] Note for W02/W03 reviewers: `backupGcKnobs.ts` currently exports `BACKUP_BASE_LEASE_MS`, `BACKUP_RESTORE_PIN_LINGER_MS`, `BACKUP_PUBLISH_MARGIN_MS` — W02 is expected to migrate `BACKUP_GC_GRACE_MS`/`BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS`/a real `BACKUP_GC_ORPHAN_MANIFEST_MAX_AGE_MS` into this same module and delete the `RECONCILE_ORPHAN_HALF_WINDOW_MS` local literal in `backupSnapshotReconcile.ts` (Task 11).

## Open questions / contradictions

1. **SQL backfill fidelity vs. `normalizeStorageIdentity` (Task 1).** The PL/pgSQL replica in the migration is a best-effort port, not a proven-identical one: (a) the `local` branch strips only a trailing slash, it does not replicate `path.resolve()`'s handling of `.`/`..` segments or resolving a genuinely relative path against a cwd (impossible to replicate in SQL at all — flagged in the migration's own comment); (b) the S3 branch's endpoint canonicalization strips a leading scheme and anything from the first `/` onward, but does not replicate the TS function's `new URL(...)` parsing exactly for atypical inputs (e.g. userinfo in the URL, IPv6 hosts). Both divergences are bounded to the *guarded* backfill set (config unedited since the snapshot) — a mismatch here means a row is left with a technically-wrong-but-internally-consistent identity, never crossed with a different bucket's rows, and W02's sweep only ever compares against the *live* `normalizeStorageIdentity` output for a listing, so a divergent backfilled identity would show as an "unreachable identity" leak (logged, not silently merged) rather than a cross-tenant/cross-bucket deletion. Still, this was not proven byte-for-byte against real data before landing — recommend a one-off comparison script (SQL backfill's computed identities vs. `normalizeStorageIdentity(row)` in TS) run against a copy of production data before the migration ships, similar in spirit to the Go↔TS contract-test pattern this repo already uses elsewhere (`backupAgentContract.test.ts`), even though no such automated cross-check exists here.
2. **`RESTORE_COMMANDLESS_PENDING_TIMEOUT_MS` (Task 7) vs. `BACKUP_RESTORE_PIN_LINGER_MS` (Task 9/backupGcKnobs.ts).** The spec's reaper rule is a fixed 1 hour, independent of the (env-tunable) 7-day-default linger retention's own pin check uses. This is intentional per the spec's plain reading (§3.2: "a new reaper rule in staleCommandReaper.ts: commandless pending restore_jobs older than 1h → failed"), but it does mean an operator who raises `BACKUP_RESTORE_PIN_LINGER_MS` well above 1h still gets commandless rows reaped at the fixed 1h mark while status-based pins linger far longer — not a bug, but worth confirming this asymmetry is the intended operator-facing behavior rather than an oversight in the spec itself.
3. **Task 9's import path for `restoreJobs`/`backupSnapshotRetirements`/`IN_FLIGHT_BACKUP_JOB_STATUSES`.** The plan imports these from the concrete `'../db/schema/backup'` module rather than the `'../db/schema'` barrel that `backupRetention.ts`'s other imports currently use. This needs to be reconciled against whatever `backupRetention.test.ts`'s `vi.mock(...)` setup actually targets (the barrel or the concrete module) during implementation — mixing the two in one file's imports is a code-smell the implementing agent should resolve one way or the other, not leave split.
4. **Task 11's base-existence check re-queries the DB per adopted candidate inside a loop already doing per-candidate manifest fetches.** This mirrors the existing per-candidate DB-read pattern in `reconcileOrphanedBackupSnapshots` (which already does one write per adopted candidate), so it is consistent with the file's existing performance envelope, but it is an N+1-shaped query pattern that could matter if reconcile is ever run over a very large orphan backlog. Not fixed here — flagged for W02/a future pass if reconcile's throughput becomes a real bottleneck.
5. **`backup_snapshot_retirements.snapshot_id` width is `varchar(255)`** (Task 3's migration) while `BACKUP_SNAPSHOT_ID_MAX_LENGTH`'s actual numeric value was not independently re-verified in this pass — only that the constant exists and is imported elsewhere. Confirm `BACKUP_SNAPSHOT_ID_MAX_LENGTH`'s actual value during implementation and either use the constant directly in both the migration's hand-written SQL and the Drizzle schema, or confirm `255` matches it, so the two never silently drift.
6. **Task 6's multi-target dispatch and sequential base selection.** When a profile fans out to multiple targets in one dispatch call (`prepareBackupDispatchTargets`'s per-target loop), each `backup_run` target calls `stampDispatchPinAndIdentity` independently, in its own transaction. Two sibling targets for the SAME `(deviceId, configId, mode)` pair (not a scenario the current profile model appears to produce, since distinct targets carry distinct modes/paths, but not verified as structurally impossible) could theoretically select the same base snapshot and both pin it — harmless (both dispatch fine, retention just sees two pins on the same snapshot instead of one) but not something this plan explicitly proves against. Not treated as a defect; flagged as unverified.
7. **Task 12's `backupSnapshots` import in `configs.ts`.** The plan assumes `backupSnapshots` needs adding to this route file's imports; whether it's already imported (for an unrelated existing route in the same file) was not independently confirmed — a two-second `grep` during implementation resolves this, called out so it isn't silently skipped.
8. **PATCH `/backup/configs/:id`'s response-shape change.** Returning `{ ...toConfigResponse(row), warnings }` only when `warnings.length > 0` (rather than always including an empty `warnings: []`) avoids widening every existing PATCH response body, but means callers must treat `warnings` as always-optional. If the web UI consuming this endpoint expects a stable shape, this may need `warnings: []` unconditionally instead — a product/UI-contract decision this plan defers to whoever wires up the frontend warning banner (out of scope for W01, which is API-only).
