---
tracking_issue: LanternOps/breeze#5449
---

# Wave 02 — API: GC Sweep Reclaims Retired and Orphaned Prefixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `sweepUnreferencedBackupObjects` (name unchanged — W01 owns the worker call site and expects this exact export) actually reclaim the objects of retired/expired snapshots and abandoned orphan uploads — today it only ever protects, never deletes anything beyond the pre-existing 48h loose-object grace and 9-day manifest-less-prefix rule.

**Architecture:** `backupRetention.ts`'s mark-and-sweep GC gains three new root-set inputs — `backup_snapshots.storage_identity` (nullable, denormalized identity stamped at dispatch/publication, all backup types, not just `file`, self-healed by the sweep when NULL), `backup_snapshot_retirements` (a durable tombstone written whenever retention deletes a row), and a widened `ORPHAN_WINDOW = max(9d default, base lease + grace)` — plus a new per-prefix classification (rooted / retired-or-old-orphan / manifest-less) that deletes retired/orphaned prefixes in two phases (non-manifest objects, then the manifest only when **no deletable non-manifest key remains** — none failed, none capped, none skip-set-excluded), a Redis-backed skip-set for cap fairness, a helper-version capability gate, and an unresolved-NULL-identity gate, both of which defer the new deletion behavior on an identity to "rooted-prefix rule only" until satisfied. Per Codex v2 P1 (§3.7), the whole sweep is restructured to run its DB reads/writes in short per-identity system contexts with every storage call at depth 0 — never inside the worker's blanket per-job transaction.

**Tech Stack:** TypeScript, Drizzle ORM, Vitest (unit + `vitest.integration.config.ts` real-DB), ioredis (shared client via `services/redis.ts`), local-filesystem backup provider for the integration test.

**Spec:** `docs/superpowers/specs/backup/2026-09-09-backup-gc-reclamation-design.md` (v3) (§3.4 sweep rules, §3.6 storage identity, §3.7 transaction boundaries, §6 verification)

**Depends on:** Wave 01 (server-owned dedupe base + retirements table). This plan assumes W01 has already shipped and merged the following, and treats them as read-only consumed interfaces — **do not re-implement them here**:
- `backup_jobs.base_snapshot_id varchar(255) NULL`, `backup_jobs.publish_lease_expires_at timestamptz NULL` (renamed from `base_lease_expires_at`) (+ partial index).
- `backup_jobs.storage_identity text NULL` — stamped **at dispatch** from the `providerConfig` placed in the payload (the bucket the helper will actually write to, regardless of later config edits).
- `backup_snapshots.storage_identity text NULL` — **nullable** (not `NOT NULL`): copied from the job at publication (reconcile copies it from the adoptable job too). The migration backfills it from the current config only when `backup_configs.updated_at <= backup_snapshots.timestamp`; everything else stays `NULL` and is self-healed by this wave's sweep (§3.6).
- Table `backup_snapshot_retirements` (migration `2026-10-15-150003-backup-snapshot-retirements.sql`), Drizzle export `backupSnapshotRetirements` from `apps/api/src/db/schema/backup.ts`, columns `id uuid pk`, `orgId uuid not null`, `configId uuid` (FK `backup_configs` ON DELETE CASCADE), `deviceId uuid` (nullable, FK SET NULL), `snapshotId varchar(255)`, `storageIdentity text`, `backupType`, `reason` (`expired`|`max_versions`|`manual`), `retiredAt timestamptz`, `sweptAt timestamptz` (nullable), unique `(storageIdentity, snapshotId)`. RLS shape 1, already registered in every cascade/export registry by W01.
- Module `apps/api/src/services/backupGcKnobs.ts` exporting `resolveMsKnob(name: string, defaultMs: number, productionFloorMs?: number): number` (same env-override / production-floor / warn-log convention as today's `resolveBackupGcGraceMs`), `resolveBackupBaseLeaseMs()` (default 7d), `resolveBackupOrphanManifestMaxAgeMs()` (default 9d = `9 * 24 * 60 * 60 * 1000`), and `resolveBackupPublishMarginMs()` (default 1h) — the last is consumed by W01's agent-publish lease check, not directly by this wave's sweep, but is part of the same module surface; note it exists so an import-list diff doesn't surprise anyone.
- `cleanupExpiredSnapshots`/`tryDeleteSnapshotRow` (`apps/api/src/jobs/backupRetention.ts:189-231`) already insert a `backup_snapshot_retirements` row (reason `expired`/`max_versions`) durably — per §3.7, W01 restructures this into **one short system context per candidate row** (`SELECT FOR UPDATE` → pin checks → insert retirement → delete row → commit) so each retirement commits before GC could ever act on it. This wave only **reads** `backup_snapshot_retirements`, never writes a retirement row itself, and never writes `backup_jobs`/`backup_snapshots`' pin/lease columns — it only ever writes `backup_snapshot_retirements.swept_at` and `backup_snapshots.storage_identity` (self-heal).
- Reconcile (`services/backupSnapshotReconcile.ts`, W01-owned) refuses to adopt a retired `snapshotId` and only adopts an orphan younger than half of `ORPHAN_WINDOW` — nothing to implement here, but this wave's orphan-window tests must independently prove "younger than window = root, older = swept" since reconcile's own half-window boundary is out of scope.
- **`backupWorker.ts`'s `cleanup-expired-snapshots` handler runs OUTSIDE the blanket `runWithSystemDbAccess` transaction — W01 owns this, not W02.** Concretely: W01 restructures `processCleanupExpiredSnapshots` and the `createBackupWorker` job-dispatch switch (spec §3.7) so the `cleanup-expired-snapshots` case is carved out of the blanket wrap the same way `dispatch-backup` already is (mirroring the `#1105` fix), runs retention's per-row short contexts, and then calls `await sweepUnreferencedBackupObjects()` at depth 0 (no active DB context). This wave does **not** touch `backupWorker.ts`'s dispatch switch (Task 8 is scoped to `processCleanupExpiredSnapshots`'s logging only) and does **not** rename `sweepUnreferencedBackupObjects` — W01's call site depends on that exact export name and signature. This wave's own defense against a violation of this assumption is a runtime guard (`assertOutsideHeldDbContext`, Task 7), not a restructure.

If any of these interfaces differ from what W01 actually shipped, treat that as a blocking discrepancy — re-verify against the real file before starting Task 1.

## Global Constraints

**Standing rule — `selectQueue` push order compounds across tasks.** `backupRetention.test.ts`'s mock (`chainable`/`selectQueue`, see Ground Truth) requires one `selectQueue.push([...])` per `db.select(...)` call **in the exact order the source code issues them**. Because `sweepUnreferencedBackupObjects` gains new run-level and per-identity queries incrementally across Tasks 3-7 (Task 4 adds a run-level `identityUsage` query, Task 5's per-identity retained-rows query is unaffected, Task 7 adds per-identity NULL-identity-rows and capability-gate queries), **a task that inserts a new query earlier in the call sequence invalidates every already-written test after it in the file**, not just its own new tests. Concretely: Task 4's `identityUsage` push lands as the 3rd run-level push (after `unattributedRows`, `destinations`) — go back and insert a matching `selectQueue.push([...])` at that position in every per-identity test Task 3 already wrote, immediately after landing Task 4, and re-run the full file (not just the new `describe` block) before moving on. Do this same check after every task from here through Task 7: run `cd apps/api && npx vitest run src/jobs/backupRetention.test.ts` at the end of **every** task's Step 4, not just the newest test's `-t` filter, and fix any prior test whose mock queue is now off by one. Task 7's own header note calls this out again for its specific (larger) reordering, but the rule applies starting at Task 4.

- Knobs (all resolved **per run**, not at module load): `BACKUP_GC_GRACE_MS` (default 48h = `172800000`, production floor 1h = `3600000`); `BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS` (default 9d = `BACKUP_GC_AGENT_JOURNAL_MAX_AGE_MS + BACKUP_GC_GRACE_MS_DEFAULT`, production floor = `BACKUP_GC_AGENT_JOURNAL_MAX_AGE_MS + 1`ms — must stay strictly larger than the agent's 7-day `journalMaxAge`); `BACKUP_GC_ORPHAN_MANIFEST_MAX_AGE_MS` (W01's `resolveBackupOrphanManifestMaxAgeMs()`, default 9d); `BACKUP_BASE_LEASE_MS` (W01's `resolveBackupBaseLeaseMs()`, default 7d) — consumed here only to compute `ORPHAN_WINDOW`, never written.
- `ORPHAN_WINDOW = Math.max(resolveBackupOrphanManifestMaxAgeMs(), resolveBackupBaseLeaseMs() + resolveBackupGcGraceMs())`, computed once per run (spec §3.4) — with today's defaults (9d vs 7d+48h=9d) the two arms are numerically equal, but an operator override of either knob can make either arm the binding one, so the `max()` must be computed from the resolved values every run, never hardcoded to "9 days".
- `BACKUP_GC_AGENT_JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000` **must remain a literal in `apps/api/src/jobs/backupRetention.ts`** — `apps/api/src/services/backupAgentContract.test.ts:29-40` greps this file's source text for that exact expression and must keep passing unmodified.
- New constant `BACKUP_SERVER_BASE_MIN_HELPER_VERSION = '0.112.0'` in `apps/api/src/services/backupHelperCapabilities.ts`.
- New function `backupHelperSupportsServerBase(version: string | null | undefined): boolean` in the same file, mirroring `backupHelperSupportsQueue`.
- Redis skip-set key: `backup-gc:failed:<sha1(identity.key)>` (a Redis SET of object keys), TTL 7 days (`604800` seconds).
- `BackupGcResult` gains `retiredSwept: number`, `orphansSwept: number`, `deferredIdentities: number`, `unreachableIdentities: number` alongside the existing `deleted`, `skippedIdentities`, `blockedIdentities`.
- Retirement pruning window: 30 days after `sweptAt`.
- Manifest-last rule (spec v3, stronger than "zero failedKeys"): `manifest.json` is deleted only when **no deletable non-manifest key remains** in the prefix — none failed, none excluded by the per-run delete cap, none in the Redis skip set. A capped-out or skip-set-excluded (not just a failed) non-manifest key must also block the manifest this run.
- Capability-gate device criteria (spec v3): devices considered for an identity = those with a `backup_jobs` row on that identity (via `backupJobs.storageIdentity = identity.key`, OR `backupJobs.storageIdentity IS NULL AND backupJobs.configId IN identity.configIds` for legacy jobs predating the column) whose status is `pending`/`running` (**any age**) **or** whose `createdAt` is within the last 30 days.
- Unresolved-NULL-identity gate (spec §3.4/§3.6, new): while any `backup_snapshots` row with `storageIdentity IS NULL` maps to identity `I` (via `configId IN I.configIds`) and its `snapshots/<id>/manifest.json` is **not found** in `I`'s current listing, `I` runs the rooted-prefix rule only this run, logging `identity deferred: <n> unresolved rows`. A NULL row whose manifest **is** found in the listing is self-healed (`UPDATE backup_snapshots SET storage_identity = I`) and treated as rooted, independent of whether other NULL rows on the same identity remain unresolved.
- No migrations in this wave — W01 owns all schema/registry changes. This wave's only writes are `UPDATE backup_snapshots SET storage_identity = ...` (self-heal) and `UPDATE backup_snapshot_retirements SET swept_at = ...` / the 30-day prune `DELETE`.
- Transaction boundaries (spec §3.7): every DB read/write this wave performs runs inside its own **short** `withSystemDbAccessContext` call; every storage call (list/fetch/delete against S3 or local) runs at depth 0, never nested inside a DB context. **W01 owns moving the `cleanup-expired-snapshots` worker call site out of the blanket `runWithSystemDbAccess` wrap** (consumed interface — see "Depends on"); this wave's `sweepUnreferencedBackupObjects` only defends that assumption with a runtime guard (`assertOutsideHeldDbContext`, Task 7) rather than restructuring the worker itself (Task 8 no longer touches `backupWorker.ts`'s dispatch switch).

## 0. Ground truth

Verified against `backup-gc-5429` worktree, current `main`-based state (i.e. **before** W01 lands — line numbers below are pre-W01 and will shift slightly once W01's columns/imports land; re-check before editing):

- `apps/api/src/jobs/backupRetention.ts` is 1110 lines. Key line numbers (`grep -n "^function \|^export function\|^async function\|^export async function\|^const BACKUP_GC\|^export const BACKUP_GC"`):
  - `189` `deleteSnapshotRow`, `205` `tryDeleteSnapshotRow`, `231` `cleanupExpiredSnapshots` (W01's territory — do not touch).
  - `494` `BACKUP_GC_GRACE_MS_DEFAULT`, `501` `BACKUP_GC_GRACE_MS_PRODUCTION_FLOOR`, `503` `resolveBackupGcGraceMs()`, `524` `export const BACKUP_GC_GRACE_MS = resolveBackupGcGraceMs();` (module-load — this is what Task 1 removes).
  - `537` `BACKUP_GC_AGENT_JOURNAL_MAX_AGE_MS` (**keep this line's literal exactly**, see Global Constraints), `538-539` `export const BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS = ...` (module-load — Task 1 removes the `export const`, keeps the journal-age literal above it).
  - `546` `BACKUP_GC_SUPPORTED_PROVIDERS`.
  - `572` `resolveBackupGcMaxDeletesPerRun()` — already per-run-resolved; **pattern to copy** for the new knobs' call sites.
  - `582` `parseBackupGcManifest`, `631` `normalizeS3Endpoint`, `661` `normalizeStorageIdentity` (exported, pure function — reused verbatim, not modified), `674` `groupBackupConfigsByStorageIdentity`, `709` `detectSuspiciousStorageIdentityCollisions`, `761` `groupListingBySnapshotId` (returns `Map<string, BackupGcSnapshotGroup>`, `BackupGcSnapshotGroup = { items: BackupObjectListing[]; manifestItem: BackupObjectListing | null }`, both defined `730-763`).
  - `805` `listedManifestSnapshotIds` (17 lines, `805-816`) — **replaced** by `orphanManifestSnapshotIds` (Task 3).
  - `817` `markLiveBackupObjects` (`817-871`) — unchanged signature, only its caller changes which ids it's given.
  - `873` `sweepStorageIdentity` (`873-981`) — rewritten by Task 7 into a pure storage/compute function (no DB calls) per §3.7.
  - `982` `sweepUnreferencedBackupObjects` (`982-1110`, exported) — **name kept exactly as-is** (W01's `backupWorker.ts` call site depends on this export name) but restructured internally into phased short DB contexts by Task 7.
  - `export type BackupGcResult = { deleted: number; skippedIdentities: number; blockedIdentities: number };` at line 550.
  - Imports at top (`9-30`): `db`, `{ backupSnapshots, backupPolicies, backupJobs, configPolicyBackupSettings, backupConfigs }` from `../db/schema`, `{ eq, and, or, lt, desc, inArray, isNull }` from `drizzle-orm`, storage helpers from `../services/backupSnapshotStorage`, `{ asRecord, getStringValue }` from `../services/recoveryBootstrap`, `{ captureException }` from `../services/sentry`, `{ pgErrorCode, pgErrorConstraint }` from `../utils/pgErrors`. Task 7 additionally imports `withSystemDbAccessContext` from `../db` (grep confirms `db/index.ts` exports it — same import already used by `staleBackupReaper.integration.test.ts`).
  - The retained-rows query inside the current `sweepUnreferencedBackupObjects` (`~1017-1027`) filters `or(eq(backupSnapshots.backupType, 'file'), isNull(backupSnapshots.backupType))` against `inArray(backupSnapshots.configId, identity.configIds)` — the comment directly above it (`~1005-1016`) is the one the spec calls out as factually wrong (claims non-file types use a different manifest layout; ground truth in the spec confirms every mode writes `snapshots/<id>/manifest.json`). Task 3 deletes this filter and rewrites the comment; Task 7 further replaces the `configId IN (...)` scoping with `storageIdentity = I` (all rows) `∪` a separate NULL-identity self-heal query.
- `apps/api/src/jobs/backupWorker.ts`: `processCleanupExpiredSnapshots` is `324-390` (`export async function processCleanupExpiredSnapshots(): Promise<{...}>`); it calls `sweepUnreferencedBackupObjects()` at `~366` inside a try/catch and destructures `gcResult.deleted/skippedIdentities/blockedIdentities` at `~367-369`; the returned object shape is built at the final `return` (`~390`). Today the `cleanup-expired-snapshots` job-type case (`~109-111`) is dispatched from **inside** the worker's blanket `runWithSystemDbAccess(async () => { switch (...) { ... } })` wrap (`101-118`) — this is exactly the Codex v2 P1 hazard (spec §3.7): that wrap is one Postgres transaction, confirmed a single-transaction context by the `#1105` comment already present at `~505-520` describing the identical hazard for `dispatch-backup`, which was fixed by carving that case out to run **before** the blanket wrap (`~99-100,104`). **W01 owns carving `cleanup-expired-snapshots` out the same way and calling `sweepUnreferencedBackupObjects()` at depth 0** (consumed interface, see "Depends on") — this plan's Task 8 does not touch the dispatch switch, only the logging inside `processCleanupExpiredSnapshots` itself.
- `apps/api/src/services/backupHelperCapabilities.ts` (23 lines) — existing pattern to mirror exactly: `BACKUP_QUEUE_MIN_HELPER_VERSION = '0.110.0'`, `backupHelperSupportsQueue(version)` uses `parseComparableVersion`/`compareAgentVersions` from `./agentEditionCompat`, returns `false` for null/unparseable, `compareAgentVersions(version, MIN) >= 0`. Its test `backupHelperCapabilities.test.ts` (18 lines) is the pattern for the new test — confirms `'0.110.0-rc.1'` (prerelease of the introducing version) is correctly rejected by the existing `compareAgentVersions` prerelease-ordering rule (`agentEditionCompat.ts:62-65`: a prerelease always compares less than the same-or-higher non-prerelease core), so no extra prerelease-handling logic is needed in `backupHelperSupportsServerBase` — it's a pure mirror.
- `apps/api/src/db/schema/backup.ts`: `backupJobs` (`207-278`, has `configId`, `deviceId`, `createdAt`, no `storageIdentity`), `backupSnapshots` (`280-...`, has `orgId`, `jobId`, `deviceId`, `configId`, `snapshotId`, `backupType`, `expiresAt`, etc. — W01 adds `storageIdentity`). `apps/api/src/db/schema/devices.ts:175` `backupVersion: varchar('backup_version', { length: 50 })`.
- `apps/api/src/services/redis.ts`: `getRedis(): Redis | null` (`110-152`, shared non-blocking lazy client, auto-reconnect) and `isRedisAvailable(): boolean` (`153-155`) are the pair to use — **not** `getBullMQConnection`/`createBlockingRedisConnection`, which are for BullMQ and blocking commands respectively (a blocking command on the shared connection stalls unrelated enqueues elsewhere in the app). Usage pattern mirrored from `apps/api/src/services/alertCooldown.ts:61-72`: check `isRedisAvailable()`, get the client, null-check it, fail closed/degrade on either failure — never throw.
- `apps/api/src/services/backupSnapshotStorage.ts`: local-provider layout confirmed — `listLocalObjectsWithLastModified` (`213-256`) walks `providerConfig.path`/`providerConfig.basePath` recursively, using each file's `stat().mtime` as `lastModified`, keyed by the relative path (e.g. `snapshots/<id>/manifest.json`, `snapshots/<id>/files/<name>`). `deleteLocalObjectKeys` (`365-388`) does `rm(targetPath, { force: true })` per key inside `deleteBackupObjectKeys` (`398-407`), never a prefix-wide delete. `backupSnapshotRootPrefix()` returns `'snapshots'`, `backupSnapshotManifestKey(id)` returns `` `snapshots/${id}/manifest.json` ``. For the integration test: write real files under a temp dir, then use `fs.promises.utimes(path, mtime, mtime)` to age them, since `lastModified` is derived from `stat().mtime`, not from any DB column.
- `apps/api/src/__tests__/integration/staleBackupReaper.integration.test.ts` (86 lines) is the pattern for the new integration test: `import './setup'`, `const runDb = it.runIf(!!process.env.DATABASE_URL)`, `withSystemDbAccessContext` wraps both the fixture inserts and the assertions, fixtures inserted in order `partners → organizations → sites → devices → backupConfigs → backupJobs` (then this wave adds `→ backupSnapshots → backupSnapshotRetirements`), unique suffix `` `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` `` on every named/slugged value to avoid cross-run collisions on the shared dev DB.
- `apps/api/vitest.integration.config.ts` `include` already contains `'src/__tests__/integration/**/*.test.ts'` — a new file at `apps/api/src/__tests__/integration/backupGcReclamation.integration.test.ts` is picked up with no config change.
- `apps/api/src/jobs/backupRetention.test.ts` (1041 lines) mocking style: a hand-rolled chainable Drizzle mock (`chainable(rows)`, `1-22`) fed by a shared `selectQueue: unknown[][]` array that `mockDb.select` shifts from FIFO (`24-30`) — every `db.select(...)` call in source order must have a matching `selectQueue.push([...])` in the test. `vi.mock('../services/backupSnapshotStorage', ...)` (`36-45`) replaces `fetchBackupObjectText`/`listBackupObjectsUnderPrefix`/`deleteBackupObjectKeys` with mocks while keeping the real (pure) exports like `normalizeStorageIdentity`. `vi.mock('../services/sentry', ...)` (`48-49`) captures `captureException` calls. Exact line numbers of the two blocks this wave must remove/rewrite (re-verified, NOT the spec's `~665`/`~699-752` — actual):
  - `665-698`: `it('keeps a listed manifest\'s exclusive objects live even though no backup_snapshots row retains it', ...)` — rewritten into an "orphan younger than the window is a root" case.
  - `699-752`: `describe('marks every listed manifest, not just the newest (FIX 5)', ...)` (one `it` inside) — this behavior (every listed manifest is live forever) is **removed** under the new design; the underlying dedup-source race it protected against is now closed by W01's base pin/lease, not by an unbounded listing heuristic. Replaced with orphan-window boundary tests (young orphan protected, old orphan swept).
  - `753-813`: `describe('non-file snapshots no longer wedge the file-backup sweep (FIX 6)', ...)` (two `it`s) — this entire block tests the `backupType='file'` filter Task 2 deletes; rewritten to prove ALL backup types are now included in the retained set via `storage_identity`, and that a genuinely unfetchable manifest (any type) still fail-closes the identity.
  - `497-540`: the `BACKUP_GC_GRACE_MS` module-load re-import tests (`await import('./backupRetention')` with fresh env — module-reset gymnastics) — these must be rewritten to call the per-run resolver directly instead, since the constant is no longer resolved at module load.
- `apps/docs/src/content/docs/backup/storage.mdx:53-61` — the `<Aside type="note" title="What retention removes today">` block (9 lines) explicitly states objects are *not yet* reclaimed and links issue #5429. `apps/docs/src/content/docs/backup/monitoring.mdx:119` — one sentence repeating the same "not yet reclaimed" claim, linking back to the storage page.

## File structure

- Modify `apps/api/src/jobs/backupRetention.ts` — per-run knob resolution, all-type root set via `storage_identity`, orphan-window root function, retirement-aware two-phase sweep, Redis skip-set, capability gate, unreachable-identity logging, extended `BackupGcResult`.
- Modify `apps/api/src/services/backupHelperCapabilities.ts` — add `BACKUP_SERVER_BASE_MIN_HELPER_VERSION` + `backupHelperSupportsServerBase`.
- Modify `apps/api/src/services/backupHelperCapabilities.test.ts` — add a `describe('backupHelperSupportsServerBase', ...)` block mirroring the existing one.
- Modify `apps/api/src/jobs/backupWorker.ts` — extend `processCleanupExpiredSnapshots`'s return shape and log line with the four new `BackupGcResult` fields.
- Modify `apps/api/src/jobs/backupRetention.test.ts` — remove/rewrite the three blocks in Ground Truth, add new unit coverage for every new rule.
- Create `apps/api/src/__tests__/integration/backupGcReclamation.integration.test.ts` — real-DB + real-local-filesystem proof of spec §6 scenarios (1)-(5) plus this wave's own NULL-identity self-heal/unresolved-gate scenario (6).
- Modify `apps/docs/src/content/docs/backup/storage.mdx` — rewrite the "What retention removes today" aside.
- Modify `apps/docs/src/content/docs/backup/monitoring.mdx` — rewrite the storage-growth sentence.

### Task 1: Per-run knob resolution via `backupGcKnobs`

**Files:** Modify `apps/api/src/jobs/backupRetention.ts:494-541` (the `BACKUP_GC_GRACE_MS_DEFAULT`/`_PRODUCTION_FLOOR`/`resolveBackupGcGraceMs`/`export const BACKUP_GC_GRACE_MS` block and the `BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS` block). Test: `apps/api/src/jobs/backupRetention.test.ts:497-540`.

**Interfaces:**
- Consumes: `resolveMsKnob(name: string, defaultMs: number, productionFloorMs?: number): number` from `../services/backupGcKnobs` (W01).
- Produces: `resolveBackupGcGraceMs(): number` (kept, now a thin wrapper), removes the module-load `export const BACKUP_GC_GRACE_MS` and `export const BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS`; adds `resolveBackupManifestlessPrefixMaxAgeMs(): number` (exported, per-run).

- [ ] Step 0: Extend the test mock harness up front — every later task (through Task 7) needs DB primitives the current `chainable`/`mockDb` (`backupRetention.test.ts:1-34`) doesn't provide (`selectDistinct`, `.groupBy()`, `.set()`, `.returning()`) and two new `../db` exports (`withSystemDbAccessContext`, `assertOutsideHeldDbContext`) the current `vi.mock('../db', () => ({ db: mockDb }))` doesn't stub. Doing this once, now, avoids re-touching the mock setup piecemeal in Tasks 4/7. Replace the top-of-file mock block:

```typescript
function chainable(rows: unknown[]) {
  const obj: Record<string, unknown> = {
    from: () => obj,
    where: () => obj,
    leftJoin: () => obj,
    innerJoin: () => obj,
    orderBy: () => obj,
    groupBy: () => obj,
    limit: () => obj,
    set: () => obj, // db.update(...).set({...}) — returns itself so .where()/.returning() still chain
    returning: () => obj, // db.delete(...).returning() / db.update(...).returning()
    then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return obj;
}

const selectQueue: unknown[][] = [];

const mockDb = {
  select: vi.fn(() => chainable(selectQueue.shift() ?? [])),
  // selectDistinct shares the SAME selectQueue as select — from the test's
  // perspective they're both just "the next db read in source order"; Task 7's
  // capability-gate query is the only selectDistinct call site.
  selectDistinct: vi.fn(() => chainable(selectQueue.shift() ?? [])),
  delete: vi.fn(() => chainable([])),
  update: vi.fn(() => chainable([])),
};

vi.mock('../db', () => ({ db: mockDb }));
```

  Note this REPLACES the plain `db: mockDb` mock with the same shape (no `withSystemDbAccessContext`/`assertOutsideHeldDbContext` yet — those are added in the SAME `vi.mock('../db', ...)` call, but wait until Task 7 needs them; add both exports here anyway so this task's edit is the only place the mock's shape changes):

```typescript
const assertOutsideHeldDbContextMock = vi.fn();
vi.mock('../db', () => ({
  db: mockDb,
  withSystemDbAccessContext: (fn: () => unknown) => fn(), // pass-through under the mock — no real context to open
  assertOutsideHeldDbContext: assertOutsideHeldDbContextMock,
}));
```

  Also fix the age-fixture helpers at `:67-70` (`JUST_PAST_MANIFESTLESS_THRESHOLD`/`EVEN_FURTHER_PAST_MANIFESTLESS_THRESHOLD`), which currently read the module-load `BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS` export this task removes:

```typescript
// BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS is no longer a module-load export
// (Task 1) — its default (9 days) is a fixture constant here, independent of
// the real per-run resolver under test. The frozen-time boundary tests later
// in this file exercise the resolver's actual output directly; these two
// helpers only need "comfortably past the default" for tests that don't care
// about the exact boundary.
const MANIFESTLESS_WINDOW_MS_DEFAULT = 9 * DAY_MS;
const JUST_PAST_MANIFESTLESS_THRESHOLD = () =>
  new Date(Date.now() - MANIFESTLESS_WINDOW_MS_DEFAULT - DAY_MS);
const EVEN_FURTHER_PAST_MANIFESTLESS_THRESHOLD = () =>
  new Date(Date.now() - MANIFESTLESS_WINDOW_MS_DEFAULT - 2 * DAY_MS);
```

  Run `cd apps/api && npx vitest run src/jobs/backupRetention.test.ts` after this step alone to confirm the existing (unmodified) tests still pass against the extended mock before continuing to Step 1 — this step is pure test-infra, no source change yet.

- [ ] Step 1: Write the failing test — replace the module-reset tests at `backupRetention.test.ts:497-540` (they `await import('./backupRetention')` with mutated `process.env` to catch a module-load constant; that pattern breaks once resolution moves off module load):

```typescript
// Replaces the BACKUP_GC_GRACE_MS module-reset describe block (was 497-540).
import { resolveBackupGcGraceMs, resolveBackupManifestlessPrefixMaxAgeMs } from './backupRetention';

describe('resolveBackupGcGraceMs (per-run)', () => {
  const prev = process.env.BACKUP_GC_GRACE_MS;
  const prevEnv = process.env.NODE_ENV;
  afterEach(() => {
    if (prev === undefined) delete process.env.BACKUP_GC_GRACE_MS; else process.env.BACKUP_GC_GRACE_MS = prev;
    process.env.NODE_ENV = prevEnv;
  });

  it('defaults to 48h when unset', () => {
    delete process.env.BACKUP_GC_GRACE_MS;
    expect(resolveBackupGcGraceMs()).toBe(48 * 60 * 60 * 1000);
  });

  it('honors a positive override outside production', () => {
    process.env.NODE_ENV = 'test';
    process.env.BACKUP_GC_GRACE_MS = '1000';
    expect(resolveBackupGcGraceMs()).toBe(1000);
  });

  it('floors an override below 1h in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.BACKUP_GC_GRACE_MS = '1000';
    expect(resolveBackupGcGraceMs()).toBe(60 * 60 * 1000);
  });

  it('re-resolves on every call (no module-load caching)', () => {
    process.env.NODE_ENV = 'test';
    process.env.BACKUP_GC_GRACE_MS = '5000';
    expect(resolveBackupGcGraceMs()).toBe(5000);
    process.env.BACKUP_GC_GRACE_MS = '9000';
    expect(resolveBackupGcGraceMs()).toBe(9000);
  });
});

describe('resolveBackupManifestlessPrefixMaxAgeMs (per-run)', () => {
  const AGENT_JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const prev = process.env.BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS;
  afterEach(() => {
    if (prev === undefined) delete process.env.BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS;
    else process.env.BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS = prev;
  });

  it('defaults to 9 days (journalMaxAge + 48h), strictly greater than journalMaxAge', () => {
    delete process.env.BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS;
    const resolved = resolveBackupManifestlessPrefixMaxAgeMs();
    expect(resolved).toBe(9 * 24 * 60 * 60 * 1000);
    expect(resolved).toBeGreaterThan(AGENT_JOURNAL_MAX_AGE_MS);
  });

  it('never allows an override at or below journalMaxAge (production floor holds even outside prod - see step 3)', () => {
    process.env.BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS = String(AGENT_JOURNAL_MAX_AGE_MS);
    expect(resolveBackupManifestlessPrefixMaxAgeMs()).toBeGreaterThan(AGENT_JOURNAL_MAX_AGE_MS);
  });
});
```

- [ ] Step 2: Run it, expect FAIL (both new functions don't exist / old exports removed): `cd apps/api && npx vitest run src/jobs/backupRetention.test.ts` — TypeError `resolveBackupManifestlessPrefixMaxAgeMs is not a function` (or a compile error if run through `tsc`).

- [ ] Step 3: Implement — replace `backupRetention.ts:494-541`:

```typescript
import { resolveMsKnob } from '../services/backupGcKnobs';

const BACKUP_GC_GRACE_MS_DEFAULT = 48 * 60 * 60 * 1000;
// Test/lab knob only (2026-09-09 assurance campaign, cell R1/R4): the grace is a
// production safety margin and must never be lowered on a real deployment.
const BACKUP_GC_GRACE_MS_PRODUCTION_FLOOR = 60 * 60 * 1000;

/** Resolved fresh on every GC run — see resolveMsKnob for the override/floor/warn contract. */
export function resolveBackupGcGraceMs(): number {
  return resolveMsKnob('BACKUP_GC_GRACE_MS', BACKUP_GC_GRACE_MS_DEFAULT, BACKUP_GC_GRACE_MS_PRODUCTION_FLOOR);
}

// Must stay STRICTLY LARGER than agent/internal/backup/journal.go's
// journalMaxAge (7 days) — see apps/api/src/services/backupAgentContract.test.ts,
// which greps THIS FILE's source text for this exact literal. Do not move it,
// rename it, or change its RHS expression without updating that contract test.
const BACKUP_GC_AGENT_JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // must equal the agent's journalMaxAge
const BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS_DEFAULT =
  BACKUP_GC_AGENT_JOURNAL_MAX_AGE_MS + BACKUP_GC_GRACE_MS_DEFAULT; // 9 days
// Floor is journalMaxAge + 1ms (not a round number): the invariant is STRICT
// inequality against journalMaxAge, not "at least 7 days" — an override of
// exactly 7 days would race a resume opened just inside day 7 (see the
// resume-headroom comment this constant used to carry).
const BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS_PRODUCTION_FLOOR = BACKUP_GC_AGENT_JOURNAL_MAX_AGE_MS + 1;

/** Resolved fresh on every GC run. Replaces the old module-load export. */
export function resolveBackupManifestlessPrefixMaxAgeMs(): number {
  return resolveMsKnob(
    'BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS',
    BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS_DEFAULT,
    BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS_PRODUCTION_FLOOR,
  );
}
```

  Every other reference to `BACKUP_GC_GRACE_MS`/`BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS` inside `backupRetention.ts` (only inside `sweepStorageIdentity`, rewritten in Task 6) switches to calling `resolveBackupGcGraceMs()`/`resolveBackupManifestlessPrefixMaxAgeMs()` once per `sweepUnreferencedBackupObjects()` run and threading the resulting numbers down as parameters (not re-resolving per identity — keeps one run internally consistent even if env changes mid-run).

- [ ] Step 4: Run, expect PASS: `cd apps/api && npx vitest run src/jobs/backupRetention.test.ts src/services/backupAgentContract.test.ts`

- [ ] Step 5: Commit: `git add apps/api/src/jobs/backupRetention.ts apps/api/src/jobs/backupRetention.test.ts && git commit -m "refactor(backup-gc): resolve GC grace/manifestless-window knobs per run"`

### Task 2: Capability constant + `backupHelperSupportsServerBase`

**Files:** Modify `apps/api/src/services/backupHelperCapabilities.ts` (append). Modify `apps/api/src/services/backupHelperCapabilities.test.ts` (append a describe block).

**Interfaces:**
- Produces: `export const BACKUP_SERVER_BASE_MIN_HELPER_VERSION = '0.112.0';`, `export function backupHelperSupportsServerBase(version: string | null | undefined): boolean`.

- [ ] Step 1: Write the failing test — append to `backupHelperCapabilities.test.ts`:

```typescript
import {
  BACKUP_SERVER_BASE_MIN_HELPER_VERSION,
  backupHelperSupportsQueue,
  backupHelperSupportsServerBase,
} from './backupHelperCapabilities';

describe('backupHelperSupportsServerBase', () => {
  it('accepts the introducing release and anything newer', () => {
    expect(backupHelperSupportsServerBase(BACKUP_SERVER_BASE_MIN_HELPER_VERSION)).toBe(true);
    expect(backupHelperSupportsServerBase('v0.112.0')).toBe(true);
    expect(backupHelperSupportsServerBase('0.112.1')).toBe(true);
    expect(backupHelperSupportsServerBase('0.113.0')).toBe(true);
    expect(backupHelperSupportsServerBase('1.0.0')).toBe(true);
  });

  it('rejects older helpers, pre-releases of the introducing version, dev builds, and unknowns', () => {
    expect(backupHelperSupportsServerBase('0.111.0')).toBe(false);
    expect(backupHelperSupportsServerBase('0.111.99')).toBe(false);
    expect(backupHelperSupportsServerBase('0.112.0-rc.1')).toBe(false);
    expect(backupHelperSupportsServerBase(null)).toBe(false);
    expect(backupHelperSupportsServerBase(undefined)).toBe(false);
    expect(backupHelperSupportsServerBase('')).toBe(false);
    expect(backupHelperSupportsServerBase('dev')).toBe(false);
    expect(backupHelperSupportsServerBase('unknown')).toBe(false);
  });
});
```

- [ ] Step 2: Run it, expect FAIL: `cd apps/api && npx vitest run src/services/backupHelperCapabilities.test.ts` — `backupHelperSupportsServerBase is not exported`.

- [ ] Step 3: Implement — append to `backupHelperCapabilities.ts`:

```typescript
/**
 * First breeze-backup helper release that supports server-owned dedupe base
 * selection (D18 W01/W02): the server picks and leases the incremental base,
 * the agent downloads it by id, and the agent itself never deletes remote
 * objects. Older helpers still list the bucket to choose a base and still
 * prune remotely on retention, so GC's new unrooted-prefix reclamation
 * (retired + orphan-past-window deletion) must stay disabled on any identity
 * still serving a helper below this version — see
 * apps/api/src/jobs/backupRetention.ts's capability gate.
 */
export const BACKUP_SERVER_BASE_MIN_HELPER_VERSION = '0.112.0';

/**
 * True when `devices.backup_version` reports a helper new enough to trust
 * with unrooted-prefix GC reclamation. Unknown, unparseable, or missing
 * versions are treated as NOT capable (conservative: legacy behavior).
 */
export function backupHelperSupportsServerBase(version: string | null | undefined): boolean {
  if (!version) return false;
  if (!parseComparableVersion(version)) return false;
  return compareAgentVersions(version, BACKUP_SERVER_BASE_MIN_HELPER_VERSION) >= 0;
}
```

- [ ] Step 4: Run, expect PASS: `cd apps/api && npx vitest run src/services/backupHelperCapabilities.test.ts`

- [ ] Step 5: Commit: `git add apps/api/src/services/backupHelperCapabilities.ts apps/api/src/services/backupHelperCapabilities.test.ts && git commit -m "feat(backup-gc): add backupHelperSupportsServerBase capability gate"`

### Task 3: All-type root set via `storage_identity` (drop the `backupType='file'` filter)

**Files:** Modify `apps/api/src/jobs/backupRetention.ts` (the retained-rows query, currently inside `sweepUnreferencedBackupObjects`'s per-identity loop, `~1005-1027`, plus its wrong comment at `~1057-1065`/`~1066-1074` per the spec — re-verify exact lines against Task 1's edited file before touching). Test: `apps/api/src/jobs/backupRetention.test.ts:753-813` (the FIX 6 block).

**Interfaces:**
- Produces: a helper `async function retainedSnapshotIdsForIdentity(identityKey: string): Promise<string[]>` querying `backupSnapshots.snapshotId` `WHERE storageIdentity = identityKey` (no `backupType` filter, no `configId` filter — `storage_identity` already scopes it precisely, including across a config whose `providerConfig` was edited after some rows were written).

- [ ] Step 1: Write the failing test — replace `backupRetention.test.ts:753-813` (the `describe('non-file snapshots no longer wedge the file-backup sweep (FIX 6)', ...)` block, which tested the now-deleted filter) with:

```typescript
describe('all backup types share one retained set via storage_identity (no more backupType filter)', () => {
  it('includes a system_image row in the retained set alongside a file row on the same identity', async () => {
    selectQueue.push([]); // unattributedRows
    selectQueue.push([destination]); // destinations
    // Retained-rows query is no longer filtered by backupType — both rows come back.
    selectQueue.push([{ snapshotId: 'FILE1' }, { snapshotId: 'IMG1' }]);

    fetchBackupObjectTextMock.mockImplementation(async (input: { key: string }) => {
      if (input.key === 'snapshots/FILE1/manifest.json') return manifestJson([]);
      if (input.key === 'snapshots/IMG1/manifest.json') return manifestJson([]);
      throw new Error(`unexpected manifest fetch: ${input.key}`);
    });

    const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/FILE1/manifest.json', lastModified: old },
      { key: 'snapshots/IMG1/manifest.json', lastModified: old },
    ]);

    const result = await sweepUnreferencedBackupObjects();

    expect(fetchBackupObjectTextMock).toHaveBeenCalledWith(expect.objectContaining({ key: 'snapshots/FILE1/manifest.json' }));
    expect(fetchBackupObjectTextMock).toHaveBeenCalledWith(expect.objectContaining({ key: 'snapshots/IMG1/manifest.json' }));
    expect(result.blockedIdentities).toBe(0);
    expect(result.skippedIdentities).toBe(0);
  });

  it('still fail-closes AND increments blockedIdentities when ANY retained type\'s manifest is unfetchable', async () => {
    selectQueue.push([]); // unattributedRows
    selectQueue.push([destination]); // destinations
    selectQueue.push([{ snapshotId: 'IMG1' }]); // a system_image row, now equally retained

    fetchBackupObjectTextMock.mockRejectedValueOnce(new Error('S3 500 fetching manifest'));

    const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/IMG1/manifest.json', lastModified: old },
      { key: 'snapshots/ORPHAN/files/x.dat', lastModified: old },
    ]);

    const result = await sweepUnreferencedBackupObjects();

    expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
    expect(result.skippedIdentities).toBe(1);
    expect(result.blockedIdentities).toBe(1);
  });
});
```

- [ ] Step 2: Run it, expect FAIL: `cd apps/api && npx vitest run src/jobs/backupRetention.test.ts` — the current query still filters `backupType`, so with the mocked chainable `.where()` being a no-op this particular mock-level test may actually pass spuriously today (the mock can't enforce the real SQL filter); the REAL assertion of the filter removal is in the integration test (Task 9). This unit test instead pins the *behavioral contract* (all types flow into the same retained/fetched set) so it fails once Task 9's integration proof is added and would fail if the filter were mistakenly reintroduced. Run and confirm current code still passes this one (expected — proceed to Step 3 to also remove the SQL-level filter for real, then re-verify with the integration test in Task 9).

- [ ] Step 3: Implement — in `sweepUnreferencedBackupObjects`, replace the per-identity retained-rows query:

```typescript
// Storage-identity-scoped retained set — deliberately NOT filtered by
// backupType (every mode publishes snapshots/<id>/manifest.json, see
// docs/superpowers/specs/backup/2026-09-09-backup-gc-reclamation-design.md
// §1 ground truth) and NOT filtered by configId (storage_identity is
// denormalized onto the row at publish time, so it survives a later
// providerConfig edit that would otherwise misattribute historical rows —
// see normalizeStorageIdentity / §3.6).
const retainedRows = await db
  .select({ snapshotId: backupSnapshots.snapshotId })
  .from(backupSnapshots)
  .where(eq(backupSnapshots.storageIdentity, identity.key));
const retainedSnapshotIds = retainedRows.map((row) => row.snapshotId);
```

  `storage_identity` is **nullable** (W01 v3 — corrected from an earlier NOT NULL assumption), so `eq(backupSnapshots.storageIdentity, identity.key)` correctly excludes NULL rows via ordinary SQL three-valued-logic (`NULL = 'x'` is unknown, never true) — this query only ever returns rows that already carry the identity string. Rows still `storage_identity IS NULL` (never dispatched with the column, or backfill skipped them because their config was edited after publication) are a **separate** root-set input handled entirely in Task 7's `identityHasUnresolvedNullRows`/self-heal logic — do not fold NULL-row handling into this query.

  Remove the now-unused `or(eq(backupSnapshots.backupType, 'file'), isNull(backupSnapshots.backupType))` clause and its preceding comment block entirely (the comment claimed different backup types use a different manifest layout — confirmed factually wrong per the spec's ground truth). Remove the `BACKUP_GC_SUPPORTED_PROVIDERS`-adjacent `or`/`isNull` imports if now unused elsewhere in the file (re-check — `isNull` is still used by the `unattributedRows` query at the top of `sweepUnreferencedBackupObjects`, so keep it; drop `or` only if nothing else in the file uses it — grep first).

- [ ] Step 4: Run, expect PASS: `cd apps/api && npx vitest run src/jobs/backupRetention.test.ts`

- [ ] Step 5: Commit: `git add apps/api/src/jobs/backupRetention.ts apps/api/src/jobs/backupRetention.test.ts && git commit -m "fix(backup-gc): root ALL backup types via storage_identity, not just file"`

### Task 4: Unreachable-identity detection and logging

**Files:** Modify `apps/api/src/jobs/backupRetention.ts` (add a helper + call site inside `sweepUnreferencedBackupObjects`, after the `identities` map is built and before the per-identity loop).

**Interfaces:**
- Produces: `async function logUnreachableStorageIdentities(identities: Map<string, BackupGcStorageIdentity>): Promise<number>` — returns the count of *identities* (not rows) with no matching current config.

**This task inserts a new run-level query (`identityUsage`, the 3rd `db.select(...)` overall, right after `unattributedRows` and `destinations`) that every earlier test in the file assumed didn't exist.** Per the standing rule in Global Constraints: after Step 3 below, go back to every test Task 3 added (`describe('all backup types share one retained set via storage_identity ...')`) and insert `selectQueue.push([{ storageIdentity: normalizeStorageIdentity(destination.provider, destination.providerConfig), count: 1 }]);` as the 3rd push (between `destinations` and the per-identity `retained` push) in each of its two `it`s, then re-run the whole file.

- [ ] Step 1: Write the failing test — add to `backupRetention.test.ts` (new `describe`):

```typescript
describe('unreachable storage identities (no config points at them any more)', () => {
  it('logs and counts a storage_identity with rows but no matching current config, without touching it', async () => {
    selectQueue.push([]); // unattributedRows
    selectQueue.push([destination]); // destinations — only ONE identity is listable
    // groupBy query: identity usage across ALL backup_snapshots rows, including
    // one identity no config currently produces.
    selectQueue.push([
      { storageIdentity: normalizeStorageIdentity(destination.provider, destination.providerConfig), count: 2 },
      { storageIdentity: 'local::/var/orphaned-bucket-nobody-points-at', count: 5 },
    ]);
    selectQueue.push([]); // retained rows for the one real identity

    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([]);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await sweepUnreferencedBackupObjects();
      expect(result.unreachableIdentities).toBe(1);
      expect(warn.mock.calls.some(([msg]) => String(msg).includes('unreachable identity local::/var/orphaned-bucket-nobody-points-at: 5 rows'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
```

- [ ] Step 2: Run it, expect FAIL: `cd apps/api && npx vitest run src/jobs/backupRetention.test.ts` — `result.unreachableIdentities` is `undefined`.

- [ ] Step 3: Implement — add near the top of `sweepUnreferencedBackupObjects`, right after `const identities = groupBackupConfigsByStorageIdentity(destinations);`:

```typescript
import { sql } from 'drizzle-orm';
// ... (add to the existing drizzle-orm import line)

/**
 * §3.6: rows carry the identity string they were PUBLISHED under, which
 * survives a later providerConfig edit. An identity with rows but no current
 * config producing that exact key is unreachable — it is never listed (no
 * config = no provider/providerConfig to list with), so it leaks silently
 * unless logged here. This is visibility only; reclaiming an unreachable
 * identity needs manual tooling (spec §7, deferred).
 */
async function logUnreachableStorageIdentities(
  identities: Map<string, BackupGcStorageIdentity>,
): Promise<number> {
  const usage = await db
    .select({
      storageIdentity: backupSnapshots.storageIdentity,
      count: sql<number>`count(*)`,
    })
    .from(backupSnapshots)
    .groupBy(backupSnapshots.storageIdentity);

  let unreachable = 0;
  for (const row of usage) {
    // A NULL storage_identity is not "unreachable" — it's an unresolved row
    // the self-heal path (Task 7) owns, and `row.storageIdentity` is
    // `string | null` here, so a naive `identities.has(null)` would be a type
    // error and — if coerced — could misreport "unreachable identity null".
    if (row.storageIdentity === null) continue;
    if (identities.has(row.storageIdentity)) continue;
    unreachable++;
    console.warn(`[BackupGC] unreachable identity ${row.storageIdentity}: ${row.count} rows`);
  }
  return unreachable;
}
```

  Call it once per run: `const unreachableIdentities = await logUnreachableStorageIdentities(identities);` placed after `identities` is built and before the unattributed-rows early-return (so it still logs even on a fully-blocked run — visibility should not depend on whether the run could otherwise proceed). Thread `unreachableIdentities` into every `return` statement of `sweepUnreferencedBackupObjects` (Task 6 finalizes the full result shape).

- [ ] Step 4: Run, expect PASS: `cd apps/api && npx vitest run src/jobs/backupRetention.test.ts`

- [ ] Step 5: Commit: `git add apps/api/src/jobs/backupRetention.ts apps/api/src/jobs/backupRetention.test.ts && git commit -m "feat(backup-gc): log unreachable storage identities (rows with no matching config)"`

### Task 5: `orphanManifestSnapshotIds` replaces `listedManifestSnapshotIds`

**Files:** Modify `apps/api/src/jobs/backupRetention.ts:805-816` (delete `listedManifestSnapshotIds`, add `orphanManifestSnapshotIds`). Test: `apps/api/src/jobs/backupRetention.test.ts:665-698` and `:699-752`.

**Interfaces:**
- Produces: `function orphanManifestSnapshotIds(groups: Map<string, BackupGcSnapshotGroup>, retainedSnapshotIds: Set<string>, retiredSnapshotIds: Map<string, string>, nowMs: number, windowMs: number): string[]`.

**Per the standing rule in Global Constraints, this task's full-run tests below already include the `identityUsage` push (3rd position, right after `destinations`) that Task 4 introduced** — write them exactly as shown.

- [ ] Step 1: Write the failing test — replace `backupRetention.test.ts:665-752` (both the standalone `it` and the FIX 5 `describe`) with:

```typescript
describe('orphan manifest root set (replaces the old "mark every listed manifest forever" rule)', () => {
  it('protects a young orphan manifest (no row, no retirement) as a root', async () => {
    selectQueue.push([]); // unattributedRows
    selectQueue.push([destination]); // destinations
    selectQueue.push([{ storageIdentity: normalizeStorageIdentity(destination.provider, destination.providerConfig), count: 1 }]); // identityUsage
    selectQueue.push([]); // retained snapshots — none (row never persisted yet)
    selectQueue.push([]); // retirements for this identity — none

    fetchBackupObjectTextMock.mockResolvedValueOnce(
      manifestJson([{ backupPath: 'snapshots/OLD/files/base.dat' }]),
    );

    const recent = new Date(Date.now() - 1 * DAY_MS); // well within the 9-day default orphan window
    const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/NEW/manifest.json', lastModified: recent },
      { key: 'snapshots/OLD/files/base.dat', lastModified: old }, // referenced by NEW — must survive
    ]);

    const result = await sweepUnreferencedBackupObjects();

    expect(fetchBackupObjectTextMock).toHaveBeenCalledWith(expect.objectContaining({ key: 'snapshots/NEW/manifest.json' }));
    expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
  });

  it('reclaims an orphan manifest once its manifest object clears the orphan window (default 9 days), with no retirement row', async () => {
    selectQueue.push([]); // unattributedRows
    selectQueue.push([destination]); // destinations
    selectQueue.push([{ storageIdentity: normalizeStorageIdentity(destination.provider, destination.providerConfig), count: 1 }]); // identityUsage
    selectQueue.push([]); // retained snapshots — none
    selectQueue.push([]); // retirements — none

    const pastWindow = new Date(Date.now() - 10 * DAY_MS); // past the 9-day default
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/ABANDONED/manifest.json', lastModified: pastWindow },
      { key: 'snapshots/ABANDONED/files/x.dat', lastModified: pastWindow },
    ]);
    deleteBackupObjectKeysMock.mockResolvedValueOnce({ deletedKeys: ['snapshots/ABANDONED/files/x.dat'], failedKeys: [] });
    deleteBackupObjectKeysMock.mockResolvedValueOnce({ deletedKeys: ['snapshots/ABANDONED/manifest.json'], failedKeys: [] });

    const result = await sweepUnreferencedBackupObjects();

    // Old orphan is never fetched for its manifest content (it's garbage, not a root).
    expect(fetchBackupObjectTextMock).not.toHaveBeenCalled();
    expect(result.deleted).toBe(2);
    expect(result.orphansSwept).toBe(1);
  });

  it('a manifest object with unknown last-modified is treated as young (fail-closed protect)', async () => {
    selectQueue.push([]); // unattributedRows
    selectQueue.push([destination]); // destinations
    selectQueue.push([{ storageIdentity: normalizeStorageIdentity(destination.provider, destination.providerConfig), count: 1 }]); // identityUsage
    selectQueue.push([]); // retained
    selectQueue.push([]); // retirements

    fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/UNKNOWNAGE/manifest.json', lastModified: null },
    ]);

    const result = await sweepUnreferencedBackupObjects();

    expect(fetchBackupObjectTextMock).toHaveBeenCalledWith(expect.objectContaining({ key: 'snapshots/UNKNOWNAGE/manifest.json' }));
    expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
  });
});
```

  (This test drives Task 6's `sweepStorageIdentity` rewrite too — `orphanManifestSnapshotIds` alone is a pure function; write a narrower direct unit test for it as well since it's exported for testability:)

```typescript
import { orphanManifestSnapshotIds } from './backupRetention'; // add to the existing import list

describe('orphanManifestSnapshotIds (pure)', () => {
  const groups = new Map([
    ['young', { items: [], manifestItem: { key: 'snapshots/young/manifest.json', lastModified: new Date(Date.now() - DAY_MS) } }],
    ['old', { items: [], manifestItem: { key: 'snapshots/old/manifest.json', lastModified: new Date(Date.now() - 20 * DAY_MS) } }],
    ['retained', { items: [], manifestItem: { key: 'snapshots/retained/manifest.json', lastModified: new Date(Date.now() - 20 * DAY_MS) } }],
    ['retired', { items: [], manifestItem: { key: 'snapshots/retired/manifest.json', lastModified: new Date(Date.now() - DAY_MS) } }],
    ['nomanifest', { items: [{ key: 'snapshots/nomanifest/files/a', lastModified: new Date() }], manifestItem: null }],
  ]);

  it('returns only young, unretained, unretired manifest-bearing ids', () => {
    const ids = orphanManifestSnapshotIds(
      groups as any,
      new Set(['retained']),
      new Map([['retired', 'retirement-row-id']]),
      Date.now(),
      9 * DAY_MS,
    );
    expect(ids.sort()).toEqual(['young']);
  });
});
```

- [ ] Step 2: Run it, expect FAIL: `cd apps/api && npx vitest run src/jobs/backupRetention.test.ts` — `orphanManifestSnapshotIds is not exported`, `result.orphansSwept` undefined.

- [ ] Step 3: Implement — replace `backupRetention.ts:805-816`:

```typescript
/**
 * §3.4 orphan root set: a listed manifest-bearing prefix with no
 * backup_snapshots row and no retirement row is a root ONLY while its
 * manifest object is younger than the orphan window — giving reconcile
 * (backupSnapshotReconcile.ts) time to adopt a completed-but-unpersisted
 * snapshot into a real row before GC would otherwise reclaim it. A manifest
 * object with no last-modified data cannot have its age disproven, so it is
 * fail-closed treated as YOUNG (protected), never as old.
 *
 * Replaces the old listedManifestSnapshotIds, which marked EVERY listed
 * manifest live FOREVER to guard the agent's listing-based dedup-base
 * selection race. That race no longer exists: the server now picks and
 * LEASES the incremental base itself (base_snapshot_id / publish_lease_expires_at,
 * W01) — an in-flight backup's base is protected by its own retained DB row
 * and lease, not by an unbounded listing heuristic, so an orphan manifest
 * past the window really is garbage (or a retirement will already exist).
 */
function orphanManifestSnapshotIds(
  groups: Map<string, BackupGcSnapshotGroup>,
  retainedSnapshotIds: Set<string>,
  retiredSnapshotIds: Map<string, string>,
  nowMs: number,
  windowMs: number,
): string[] {
  const ids: string[] = [];
  const threshold = nowMs - windowMs;
  for (const [snapshotId, group] of groups) {
    if (!group.manifestItem) continue;
    if (retainedSnapshotIds.has(snapshotId)) continue; // already a root via its DB row
    if (retiredSnapshotIds.has(snapshotId)) continue; // retired -> never a root, regardless of age
    const lm = group.manifestItem.lastModified;
    if (!lm || lm.getTime() > threshold) ids.push(snapshotId);
  }
  return ids;
}
```

  Export it (`export function orphanManifestSnapshotIds`) for the direct unit test. Wiring into `sweepStorageIdentity`/`sweepUnreferencedBackupObjects` (including `orphansSwept` accounting and the retired-set plumbing) happens in Task 6 — this task only needs the pure function to exist and be independently correct; the full-run tests above will stay red until Task 6 lands. Note that in-file ordering matters: keep this function right where `listedManifestSnapshotIds` was (between `groupListingBySnapshotId` and `markLiveBackupObjects`), since `sweepStorageIdentity` right below it is what calls it next.

- [ ] Step 4: Run, expect the pure-function test to PASS and the full-run tests to remain red (expected until Task 6): `cd apps/api && npx vitest run src/jobs/backupRetention.test.ts -t "orphanManifestSnapshotIds (pure)"`

- [ ] Step 5: Commit: `git add apps/api/src/jobs/backupRetention.ts apps/api/src/jobs/backupRetention.test.ts && git commit -m "feat(backup-gc): add orphanManifestSnapshotIds (age-windowed), remove unbounded listedManifestSnapshotIds"`

### Task 6: Redis skip-set for delete-cap fairness

**Files:** Modify `apps/api/src/jobs/backupRetention.ts` (add helpers near the top, after imports).

**Per the standing rule in Global Constraints, this task's tests below already include the `identityUsage` push (3rd position) that Task 4 introduced** — write them exactly as shown.

**Interfaces:**
- Consumes: `getRedis(): Redis | null`, `isRedisAvailable(): boolean` from `../services/redis`.
- Produces: `async function loadGcFailedKeySkipSet(identityKey: string): Promise<Set<string>>`, `async function recordGcFailedKeys(identityKey: string, failedKeys: { key: string; error: string }[]): Promise<void>`.

- [ ] Step 1: Write the failing test — add to `backupRetention.test.ts` a new mock + describe block. First add the Redis mock alongside the existing `vi.mock` calls near the top of the file:

```typescript
const redisSaddMock = vi.fn();
const redisExpireMock = vi.fn();
const redisSmembersMock = vi.fn();
let redisAvailableForTest = true;
vi.mock('../services/redis', () => ({
  isRedisAvailable: () => redisAvailableForTest,
  getRedis: () => (redisAvailableForTest ? { sadd: redisSaddMock, expire: redisExpireMock, smembers: redisSmembersMock } : null),
}));
```

  Then:

```typescript
describe('GC failed-key skip set (cap fairness)', () => {
  beforeEach(() => {
    redisAvailableForTest = true;
    redisSmembersMock.mockResolvedValue([]);
  });

  it('excludes a previously-failed key from candidates on a later run without re-attempting it', async () => {
    redisSmembersMock.mockResolvedValueOnce(['snapshots/ABANDONED/files/locked.dat']);

    selectQueue.push([]); // unattributedRows
    selectQueue.push([destination]); // destinations
    selectQueue.push([{ storageIdentity: normalizeStorageIdentity(destination.provider, destination.providerConfig), count: 1 }]); // identityUsage
    selectQueue.push([]); // retained
    selectQueue.push([]); // retirements

    const pastWindow = new Date(Date.now() - 10 * DAY_MS);
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/ABANDONED/manifest.json', lastModified: pastWindow },
      { key: 'snapshots/ABANDONED/files/locked.dat', lastModified: pastWindow }, // in the skip set — never attempted
      { key: 'snapshots/ABANDONED/files/free.dat', lastModified: pastWindow },
    ]);
    deleteBackupObjectKeysMock.mockResolvedValueOnce({ deletedKeys: ['snapshots/ABANDONED/files/free.dat'], failedKeys: [] });

    await sweepUnreferencedBackupObjects();

    expect(deleteBackupObjectKeysMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ keys: expect.arrayContaining(['snapshots/ABANDONED/files/locked.dat']) }),
    );
  });

  it('records a failed key with a 7-day TTL after deleteBackupObjectKeys reports it', async () => {
    selectQueue.push([]);
    selectQueue.push([destination]);
    selectQueue.push([{ storageIdentity: normalizeStorageIdentity(destination.provider, destination.providerConfig), count: 1 }]); // identityUsage
    selectQueue.push([]);
    selectQueue.push([]);

    const pastWindow = new Date(Date.now() - 10 * DAY_MS);
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/ABANDONED/manifest.json', lastModified: pastWindow },
      { key: 'snapshots/ABANDONED/files/locked.dat', lastModified: pastWindow },
    ]);
    deleteBackupObjectKeysMock.mockResolvedValueOnce({
      deletedKeys: [],
      failedKeys: [{ key: 'snapshots/ABANDONED/files/locked.dat', error: 'object-lock' }],
    });

    await sweepUnreferencedBackupObjects();

    expect(redisSaddMock).toHaveBeenCalledWith(expect.stringMatching(/^backup-gc:failed:/), 'snapshots/ABANDONED/files/locked.dat');
    expect(redisExpireMock).toHaveBeenCalledWith(expect.stringMatching(/^backup-gc:failed:/), 7 * 24 * 60 * 60);
  });

  it('degrades to no skip set (proceeds normally) when Redis is unavailable', async () => {
    redisAvailableForTest = false;
    selectQueue.push([]);
    selectQueue.push([destination]);
    selectQueue.push([{ storageIdentity: normalizeStorageIdentity(destination.provider, destination.providerConfig), count: 1 }]); // identityUsage
    selectQueue.push([]);
    selectQueue.push([]);
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([]);
    const result = await sweepUnreferencedBackupObjects();
    expect(result.deleted).toBe(0);
  });
});
```

- [ ] Step 2: Run it, expect FAIL: `cd apps/api && npx vitest run src/jobs/backupRetention.test.ts` — no skip-set behavior exists yet, `redisSaddMock` never called.

- [ ] Step 3: Implement — add near the top of `backupRetention.ts`, after the existing imports:

```typescript
import { createHash } from 'node:crypto';
import { getRedis, isRedisAvailable } from '../services/redis';

const BACKUP_GC_FAILED_KEY_TTL_SECONDS = 7 * 24 * 60 * 60;

function backupGcFailedKeySetName(identityKey: string): string {
  return `backup-gc:failed:${createHash('sha1').update(identityKey).digest('hex')}`;
}

/** Fails open to an empty set (never blocks the sweep) if Redis is unavailable or errors. */
async function loadGcFailedKeySkipSet(identityKey: string): Promise<Set<string>> {
  if (!isRedisAvailable()) return new Set();
  const redis = getRedis();
  if (!redis) return new Set();
  try {
    const members = await redis.smembers(backupGcFailedKeySetName(identityKey));
    return new Set(members);
  } catch (error) {
    console.warn(`[BackupGC] Failed to load skip-set for identity ${identityKey} — proceeding without it:`, error);
    return new Set();
  }
}

/**
 * Best-effort; a Redis failure here must never fail the sweep that already
 * ran. Called from EVERY delete branch (rooted, manifest-less, retired/orphan
 * non-manifest phase, retired/orphan manifest phase) — see Task 7 — not just
 * the retired/orphan path, so a persistently-locked object anywhere stops
 * burning cap budget on repeat attempts every run.
 *
 * ACCEPTED APPROXIMATION (documented, not fixed): `EXPIRE` sets a TTL on the
 * whole per-identity SET, refreshed to a full 7 days on every call that adds
 * a new key — Redis SETs have no native per-member TTL. On a busy identity
 * that keeps failing DIFFERENT keys, an older failed key can therefore stay
 * excluded from the cap for longer than 7 days. This is accepted because it
 * only ever makes the sweep MORE conservative (skips more, never deletes
 * something it shouldn't); a precise per-member TTL would need a Redis hash
 * of `key -> expiresAt` plus a separate pruning pass, which is unwarranted
 * complexity for a purely advisory cap-fairness mechanism.
 */
async function recordGcFailedKeys(
  identityKey: string,
  failedKeys: { key: string; error: string }[],
): Promise<void> {
  if (failedKeys.length === 0 || !isRedisAvailable()) return;
  const redis = getRedis();
  if (!redis) return;
  const setKey = backupGcFailedKeySetName(identityKey);
  try {
    await redis.sadd(setKey, ...failedKeys.map((f) => f.key));
    await redis.expire(setKey, BACKUP_GC_FAILED_KEY_TTL_SECONDS);
  } catch (error) {
    console.warn(`[BackupGC] Failed to record skip-set entries for identity ${identityKey}:`, error);
  }
}
```

  Wiring `loadGcFailedKeySkipSet`/`recordGcFailedKeys` into `sweepStorageIdentity`'s candidate filtering and post-delete bookkeeping happens in Task 7 (the full rewrite) — this task only needs the two functions to exist and behave correctly in isolation; use `vi.mock` at the file level as shown so Task 6's own tests exercise them end-to-end once Task 7 wires them in. If these tests are still red after this step alone (expected, since nothing calls them yet), that's fine — proceed to Task 7 before re-running.

- [ ] Step 4: Run, expect PASS (after Task 7 wires the call sites — mark this step's real verification as deferred to Task 7's Step 4, but confirm no syntax/type errors now): `cd apps/api && npx tsc --noEmit -p apps/api/tsconfig.json` (or the project's equivalent noEmit check) to confirm the new helpers compile cleanly before Task 7 wires them in.

- [ ] Step 5: Commit: `git add apps/api/src/jobs/backupRetention.ts apps/api/src/jobs/backupRetention.test.ts && git commit -m "feat(backup-gc): add Redis-backed failed-key skip set for delete-cap fairness"`

### Task 7: Rewrite `sweepStorageIdentity` + `sweepUnreferencedBackupObjects` — NULL rows always roots, deferral runs today's algorithm, cap/skip-set correctness, §3.7 transaction-boundary split

**Spec amendment applied (re-read spec §3.4 "Capability gate" / "Unknown-identity rows" before implementing):** deferral (legacy helper OR any unresolved NULL-identity row) does **not** mean "rooted rule only" — it means run **exactly today's (pre-D18) algorithm**: every listed manifest (rooted or not, retired or not) is marked live via the pre-existing mark path, so only loose objects under a manifest-bearing prefix (48h grace) and manifest-less prefixes (9-day rule) are ever touched. No retired/orphan reclamation runs at all while deferred. Separately, **every** `backup_snapshots` row with `storage_identity IS NULL` mapped to identity `I` (via `configId`) is a root of `I` unconditionally (its manifest is fetched by the mark phase; a fetch failure aborts `I` fail-closed like any other root) — "resolved" (self-healed) is a narrower, independent signal (its manifest was found in *this run's listing*) that only gates (a) whether `storage_identity` gets backfilled and (b) whether that row counts toward the identity being deferred.

**IMPORTANT — supersedes earlier tasks' test scaffolding.** Tasks 3-6 added tests against an interim shape of `sweepUnreferencedBackupObjects` that queried the DB with a fixed, flat sequence of `db.select(...)` calls (matched 1:1 by `selectQueue.push(...)` in test order). This task changes that sequence for real (see the finalized per-identity query order below) **and** splits every DB access into its own short `withSystemDbAccessContext` call per §3.7 (mocked as a transparent pass-through since Task 1, Step 0). This step's implementation, once done, requires going back through every `selectQueue.push(...)` sequence added in Tasks 3-6 and updating it to match the **finalized per-identity read order**:
1. `unattributedRows` (run-level, once).
2. `destinations` (run-level, once).
3. `identityUsage` — the `GROUP BY storageIdentity` query for `logUnreachableStorageIdentities` (run-level, once).
4. Per identity, in this order: (a) `retainedRows` (`storageIdentity = I`), (b) `nullIdentityRows` — `{id, snapshotId}` pairs, `storageIdentity IS NULL AND configId IN I.configIds` (note: **two columns**, not just `snapshotId` — the self-heal write-back needs the primary key, see the P1 fix below), (c) `retirementRows` (`storageIdentity = I AND sweptAt IS NULL`), (d) `capabilityRows` (the legacy-helper job/device join).

Do this fix-up as part of this task's Step 1: go back and add the missing `selectQueue.push([])` calls for the NULL-identity-rows query (step 4b above) to every test from Tasks 3, 5, and 6 that currently pushes only 4 per-identity-adjacent items instead of 5, then re-run the full suite (`cd apps/api && npx vitest run src/jobs/backupRetention.test.ts`) and fix whatever mismatch the run reveals — given how many tasks compound this ordering, treat "run and fix" as mandatory, not optional, before moving to Step 2 below.

**Files:** Modify `apps/api/src/jobs/backupRetention.ts:873-1110` (full rewrite of both functions plus the `BackupGcResult` type at `~550`).

**Interfaces:**
- Consumes: `backupSnapshotRetirements` from `../db/schema` (W01), `devices` from `../db/schema`, `backupHelperSupportsServerBase` from `../services/backupHelperCapabilities`, `withSystemDbAccessContext`, `assertOutsideHeldDbContext` from `../db`, `resolveBackupBaseLeaseMs` from `../services/backupGcKnobs`, everything from Tasks 1-6.
- Produces: `export type BackupGcResult = { deleted: number; skippedIdentities: number; blockedIdentities: number; retiredSwept: number; orphansSwept: number; deferredIdentities: number; unreachableIdentities: number };`, a `sweepStorageIdentity` that is now a **pure storage-and-compute function with zero DB calls** (all DB reads/writes happen in its caller, split into short contexts), and the same `export async function sweepUnreferencedBackupObjects(): Promise<BackupGcResult>` — internally phase-split per §3.7, but its name and signature are unchanged so W01's `backupWorker.ts` call site (`const gcResult = await sweepUnreferencedBackupObjects();`) needs no edit.

**Two accepted-and-stated approximations (per review — pick, don't leave ambiguous):**
1. **Redis skip-set TTL is per-identity-SET, not per-member.** `EXPIRE` on `backup-gc:failed:<hash>` is refreshed to a full 7 days every time ANY new key is added to that set (Redis `SET`s have no native per-member TTL). A busy identity accumulating new failures can therefore keep an OLDER failed key excluded from the cap for longer than 7 days. Accepted: this only ever makes the sweep MORE conservative (skips more, never deletes something it shouldn't) — a per-member-TTL design (a Redis hash of `key -> expiresAt` plus a separate pruning pass) would be more precise but adds real complexity for a purely advisory cap-fairness mechanism. Not implemented; documented in code.
2. **`orphansSwept` is a best-effort per-run metric, not a durable "confirmed swept" count** (unlike `retiredSwept`, which is durable via `swept_at` and therefore held to the stricter "confirmed absent from a fresh listing" bar below). An orphan has no DB row to mark, so there is nothing to protect against double-counting or a stale confirmation — it is purely observability. Counted here when at least one object was actually deleted for that old-orphan prefix this run.

**P1 fix — `swept_at` is never inferred from this run's own delete bookkeeping.** The previous draft of this task computed "prefix empty" from `this run's items minus this run's deletedKeys` and set `swept_at` in the SAME pass as the deletes. That's fragile (a delete provider that lies, a concurrent write, a missed edge) and conflates two different questions. Corrected rule: a retirement's `swept_at` is set **only when this run's fresh `listBackupObjectsUnderPrefix` listing has NO group at all for that `snapshotId`** — i.e., the prefix is confirmed **already** gone (covers a retirement whose objects were already fully removed by an earlier run, or that were never fully written) or, on a **later** run, confirmed gone **after** an earlier run's real deletes landed. This decouples "did I just delete some stuff" from "is the prefix actually empty" — the latter always comes from an independent, fresh listing.

- [ ] Step 1: Write the failing test — the `../db` mock (`withSystemDbAccessContext`, `assertOutsideHeldDbContext`, `selectDistinct`, `.groupBy()`/`.set()`/`.returning()` on `chainable`) was already extended in Task 1, Step 0; nothing further to add to the mock here. First add a small tripwire test proving the guard is wired (mirrors `apps/api/src/services/urlSafety.tripwire.test.ts`'s pattern — spy on the guard, assert it fires before the storage call):

```typescript
describe('§3.7 held-context tripwire', () => {
  beforeEach(() => assertOutsideHeldDbContextMock.mockClear());

  it('calls assertOutsideHeldDbContext before any storage call in sweepStorageIdentity', async () => {
    selectQueue.push([]); // unattributedRows
    selectQueue.push([destination]); // destinations
    selectQueue.push([{ storageIdentity: normalizeStorageIdentity(destination.provider, destination.providerConfig), count: 1 }]); // identityUsage
    selectQueue.push([]); // retained
    selectQueue.push([]); // NULL-identity rows
    selectQueue.push([]); // retirements
    selectQueue.push([]); // capability check
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([]);

    await sweepUnreferencedBackupObjects();

    expect(assertOutsideHeldDbContextMock).toHaveBeenCalledWith('backupGC.sweepStorageIdentity');
  });
});
```

  Now add the scenarios below (the earlier tasks' tests already exercise the pieces unaffected by this task's changes — orphan-window boundaries, Redis skip-set exclusion itself, etc.). These close the P1/P2 gaps: NULL rows are ALWAYS roots (not just resolved ones), deferral runs today's full algorithm (not "rooted only"), self-heal by row `id`, cap accounting charges failed attempts, skip-set is fed from every branch, and `swept_at` is a two-pass, listing-confirmed fact:

```typescript
describe('NULL-identity rows are ALWAYS roots of I, resolved or not (§3.6 v3 P1)', () => {
  it('fetches (and requires) the manifest of an UNRESOLVED NULL row too, and defers the whole identity if it is not found in the listing', async () => {
    selectQueue.push([]); // unattributedRows
    selectQueue.push([destination]); // destinations
    selectQueue.push([{ storageIdentity: normalizeStorageIdentity(destination.provider, destination.providerConfig), count: 1 }]); // identityUsage
    selectQueue.push([]); // retained — none
    selectQueue.push([{ id: 'row-neverwritten', snapshotId: 'NEVERWRITTEN' }]); // NULL-identity row mapped here
    selectQueue.push([{ id: 'retirement-5', snapshotId: 'RETIRED5' }]); // a genuine retirement, different snapshot
    selectQueue.push([]); // capability check

    // NEVERWRITTEN never appears in the listing at all — its manifest fetch is
    // therefore never attempted (markLiveBackupObjects only fetches ids it's
    // given; a NULL-identity root whose object plainly isn't in this bucket
    // would 404 if fetched, but here it simply never shows up — the "not
    // found in the listing" signal, not a fetch failure).
    const t = new Date(Date.now() - 1000);
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/RETIRED5/manifest.json', lastModified: t },
      { key: 'snapshots/RETIRED5/files/x.dat', lastModified: t },
    ]);
    // Deferred (today's algorithm): RETIRED5's manifest IS listed, so it's
    // marked live via the "every listed manifest" path, and fetched.
    fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await sweepUnreferencedBackupObjects();
      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled(); // today's algorithm: nothing unrooted is touched
      expect(result.retiredSwept).toBe(0); // never confirmed gone — it's still fully listed
      expect(warn.mock.calls.some(([msg]) => String(msg).includes('identity deferred: 1 unresolved rows'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('fetch failure for an UNRESOLVED NULL row still aborts the identity fail-closed (it is a root regardless of resolution)', async () => {
    selectQueue.push([]);
    selectQueue.push([destination]);
    selectQueue.push([{ storageIdentity: normalizeStorageIdentity(destination.provider, destination.providerConfig), count: 1 }]);
    selectQueue.push([]); // retained
    selectQueue.push([{ id: 'row-badfetch', snapshotId: 'BADFETCH' }]); // NULL row, and its manifest IS listed
    selectQueue.push([]); // retirements
    selectQueue.push([]); // capability check

    const t = new Date(Date.now() - 1000);
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/BADFETCH/manifest.json', lastModified: t },
    ]);
    // BADFETCH resolves (found in listing) but its manifest fetch fails —
    // markLiveBackupObjects fetches every rooted id regardless of resolution.
    fetchBackupObjectTextMock.mockRejectedValueOnce(new Error('S3 500'));

    const result = await sweepUnreferencedBackupObjects();
    expect(result.blockedIdentities).toBe(1);
    expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
  });
});

describe('deferral runs EXACTLY today\'s algorithm, not "rooted only" (§3.4 v3 P1)', () => {
  it('legacy-helper deferral marks EVERY listed manifest live (including a retired one) and only reclaims loose/manifest-less objects', async () => {
    selectQueue.push([]); // unattributedRows
    selectQueue.push([destination]);
    selectQueue.push([{ storageIdentity: normalizeStorageIdentity(destination.provider, destination.providerConfig), count: 1 }]);
    selectQueue.push([]); // retained
    selectQueue.push([]); // NULL-identity rows
    selectQueue.push([{ id: 'retirement-3', snapshotId: 'RETIRED3' }]); // a retirement exists...
    selectQueue.push([{ deviceId: 'device-legacy', backupVersion: '0.109.0' }]); // ...but a legacy helper defers the identity

    const t = new Date(Date.now() - 1000);
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/RETIRED3/manifest.json', lastModified: t },
      { key: 'snapshots/RETIRED3/files/x.dat', lastModified: t },
    ]);
    // Deferred path fetches EVERY listed manifest, including RETIRED3's —
    // without this mock, the mark phase 404s and fail-closes the identity.
    fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await sweepUnreferencedBackupObjects();
      expect(fetchBackupObjectTextMock).toHaveBeenCalledWith(expect.objectContaining({ key: 'snapshots/RETIRED3/manifest.json' }));
      expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled(); // both objects are 1s old — inside the 48h rooted grace
      expect(result.deferredIdentities).toBe(1);
      expect(result.retiredSwept).toBe(0);
      expect(warn.mock.calls.some(([msg]) => String(msg).includes('reclamation deferred: legacy helper device-legacy 0.109.0'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('a deferred identity STILL reclaims a manifest-less prefix older than 9 days (that rule is unconditional)', async () => {
    selectQueue.push([]);
    selectQueue.push([destination]);
    selectQueue.push([{ storageIdentity: normalizeStorageIdentity(destination.provider, destination.providerConfig), count: 1 }]);
    selectQueue.push([]); // retained
    selectQueue.push([]); // NULL-identity rows
    selectQueue.push([]); // retirements
    selectQueue.push([{ deviceId: 'device-legacy', backupVersion: '0.109.0' }]); // legacy helper -> deferred

    const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/ORPHANPARTIAL/files/partial.dat', lastModified: old }, // no manifest.json at all
    ]);
    deleteBackupObjectKeysMock.mockResolvedValueOnce({ deletedKeys: ['snapshots/ORPHANPARTIAL/files/partial.dat'], failedKeys: [] });

    const result = await sweepUnreferencedBackupObjects();
    expect(result.deleted).toBe(1);
    expect(result.deferredIdentities).toBe(1);
  });
});

describe('self-heal writes by row id, guarded by storage_identity IS NULL (§3.6 v3 P1)', () => {
  it('resolves a NULL row (found in listing) and reclaims a co-located retirement in the SAME run once nothing is unresolved', async () => {
    selectQueue.push([]); // unattributedRows
    selectQueue.push([destination]);
    selectQueue.push([{ storageIdentity: normalizeStorageIdentity(destination.provider, destination.providerConfig), count: 1 }]);
    selectQueue.push([]); // retained
    selectQueue.push([{ id: 'row-healme', snapshotId: 'HEALME' }]); // resolves this run
    selectQueue.push([{ id: 'retirement-6', snapshotId: 'RETIRED6' }]); // retired, same identity
    selectQueue.push([]); // capability check

    fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([])); // HEALME's manifest, fetched as a root
    const t = new Date(Date.now() - 1000);
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/HEALME/manifest.json', lastModified: t }, // found -> resolves
      { key: 'snapshots/RETIRED6/manifest.json', lastModified: t },
      { key: 'snapshots/RETIRED6/files/r.dat', lastModified: t },
    ]);
    deleteBackupObjectKeysMock.mockResolvedValueOnce({ deletedKeys: ['snapshots/RETIRED6/files/r.dat'], failedKeys: [] });
    deleteBackupObjectKeysMock.mockResolvedValueOnce({ deletedKeys: ['snapshots/RETIRED6/manifest.json'], failedKeys: [] });

    const result = await sweepUnreferencedBackupObjects();

    // Not deferred (HEALME resolved, no unresolved rows left) -> normal
    // retired reclaim runs against RETIRED6.
    expect(result.deleted).toBe(2);
    expect(mockDb.update).toHaveBeenCalledWith(backupSnapshots);
    // Self-heal write targets the ROW ID, not the snapshot id.
    // (Assert via the update/.set/.where mock call chain if the chainable mock
    // records call args — otherwise assert indirectly via a second run's
    // retainedRows push showing HEALME now returns from the storageIdentity=I
    // query; either is acceptable, pick one and document which.)
    expect(result.retiredSwept).toBe(0); // NOT yet confirmed by a fresh listing — see the two-pass test below
  });
});

describe('swept_at is set only once a FRESH listing confirms the prefix is gone (two-pass, §3.4 v3 P2)', () => {
  it('does not set swept_at in the same pass as the deletes, but does on a later run once the listing shows it gone', async () => {
    // Pass 1: RETIRED1 is fully listed; both its objects get deleted.
    selectQueue.push([]); selectQueue.push([destination]);
    selectQueue.push([{ storageIdentity: normalizeStorageIdentity(destination.provider, destination.providerConfig), count: 1 }]);
    selectQueue.push([]); selectQueue.push([]); // retained, NULL rows
    selectQueue.push([{ id: 'retirement-1', snapshotId: 'RETIRED1' }]);
    selectQueue.push([]); // capability

    const t = new Date(Date.now() - 1000);
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/RETIRED1/manifest.json', lastModified: t },
      { key: 'snapshots/RETIRED1/files/x.dat', lastModified: t },
    ]);
    deleteBackupObjectKeysMock.mockResolvedValueOnce({ deletedKeys: ['snapshots/RETIRED1/files/x.dat'], failedKeys: [] });
    deleteBackupObjectKeysMock.mockResolvedValueOnce({ deletedKeys: ['snapshots/RETIRED1/manifest.json'], failedKeys: [] });

    const firstRun = await sweepUnreferencedBackupObjects();
    expect(firstRun.deleted).toBe(2);
    expect(firstRun.retiredSwept).toBe(0); // NOT confirmed this pass, even though everything was just deleted

    // Pass 2: a fresh listing (real deletes from pass 1 already landed) shows
    // NOTHING at all for RETIRED1's prefix — confirmed gone.
    selectQueue.push([]); selectQueue.push([destination]);
    selectQueue.push([{ storageIdentity: normalizeStorageIdentity(destination.provider, destination.providerConfig), count: 1 }]);
    selectQueue.push([]); selectQueue.push([]);
    selectQueue.push([{ id: 'retirement-1', snapshotId: 'RETIRED1' }]); // still unswept in the DB
    selectQueue.push([]);
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([]); // RETIRED1 not present at all

    const secondRun = await sweepUnreferencedBackupObjects();
    expect(secondRun.deleted).toBe(0);
    expect(secondRun.retiredSwept).toBe(1);
  });

  it('confirms swept_at IMMEDIATELY (first time it is ever swept) when a retirement is already fully absent from the listing', async () => {
    selectQueue.push([]); selectQueue.push([destination]);
    selectQueue.push([{ storageIdentity: normalizeStorageIdentity(destination.provider, destination.providerConfig), count: 1 }]);
    selectQueue.push([]); selectQueue.push([]);
    selectQueue.push([{ id: 'retirement-7', snapshotId: 'RETIRED7' }]);
    selectQueue.push([]);
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([]); // never had objects, or a manual cleanup already removed them

    const result = await sweepUnreferencedBackupObjects();
    expect(deleteBackupObjectKeysMock).not.toHaveBeenCalled();
    expect(result.retiredSwept).toBe(1);
  });

  it('a manifest-less "retired remnant" (manifest already gone from a prior run) is reclaimed immediately, with no 9-day wait', async () => {
    selectQueue.push([]); selectQueue.push([destination]);
    selectQueue.push([{ storageIdentity: normalizeStorageIdentity(destination.provider, destination.providerConfig), count: 1 }]);
    selectQueue.push([]); selectQueue.push([]);
    selectQueue.push([{ id: 'retirement-8', snapshotId: 'RETIRED8' }]);
    selectQueue.push([]);

    const veryRecent = new Date(Date.now() - 1000); // would be fully protected under the ordinary 9-day manifest-less rule
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/RETIRED8/files/remnant.dat', lastModified: veryRecent }, // no manifest.json — already deleted
    ]);
    deleteBackupObjectKeysMock.mockResolvedValueOnce({ deletedKeys: ['snapshots/RETIRED8/files/remnant.dat'], failedKeys: [] });

    const result = await sweepUnreferencedBackupObjects();
    expect(result.deleted).toBe(1); // reclaimed despite being 1 second old — retired status has no age gate
  });
});

describe('delete-cap accounting and skip-set feeding (§3.4 v3 P2)', () => {
  it('a FAILED delete attempt consumes the per-run cap, not just successful deletes', async () => {
    selectQueue.push([]); selectQueue.push([destination]);
    selectQueue.push([{ storageIdentity: normalizeStorageIdentity(destination.provider, destination.providerConfig), count: 1 }]);
    selectQueue.push([{ snapshotId: 'B' }]); // retained (rooted)
    selectQueue.push([]); selectQueue.push([]); selectQueue.push([]);

    fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));
    const prevCap = process.env.BACKUP_GC_MAX_DELETES_PER_RUN;
    process.env.BACKUP_GC_MAX_DELETES_PER_RUN = '1';
    try {
      const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
      listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
        { key: 'snapshots/B/manifest.json', lastModified: old },
        { key: 'snapshots/B/files/a.dat', lastModified: old }, // this one "fails" to delete
        { key: 'snapshots/B/files/b.dat', lastModified: old }, // never attempted — cap already spent on a.dat's ATTEMPT
      ]);
      deleteBackupObjectKeysMock.mockResolvedValueOnce({
        deletedKeys: [],
        failedKeys: [{ key: 'snapshots/B/files/a.dat', error: 'object-lock' }],
      });

      await sweepUnreferencedBackupObjects();
      // Only ONE deleteBackupObjectKeys call happened at all — the cap was
      // exhausted by the FAILED attempt, so b.dat was never even tried.
      expect(deleteBackupObjectKeysMock).toHaveBeenCalledTimes(1);
    } finally {
      if (prevCap === undefined) delete process.env.BACKUP_GC_MAX_DELETES_PER_RUN; else process.env.BACKUP_GC_MAX_DELETES_PER_RUN = prevCap;
    }
  });

  it('a rooted-branch delete failure is recorded into the Redis skip set too (not just the retired/orphan branch)', async () => {
    selectQueue.push([]); selectQueue.push([destination]);
    selectQueue.push([{ storageIdentity: normalizeStorageIdentity(destination.provider, destination.providerConfig), count: 1 }]);
    selectQueue.push([{ snapshotId: 'B' }]);
    selectQueue.push([]); selectQueue.push([]); selectQueue.push([]);

    fetchBackupObjectTextMock.mockResolvedValueOnce(manifestJson([]));
    const old = JUST_PAST_MANIFESTLESS_THRESHOLD();
    listBackupObjectsUnderPrefixMock.mockResolvedValueOnce([
      { key: 'snapshots/B/manifest.json', lastModified: old },
      { key: 'snapshots/B/files/locked.dat', lastModified: old },
    ]);
    deleteBackupObjectKeysMock.mockResolvedValueOnce({
      deletedKeys: [],
      failedKeys: [{ key: 'snapshots/B/files/locked.dat', error: 'object-lock' }],
    });

    await sweepUnreferencedBackupObjects();
    expect(redisSaddMock).toHaveBeenCalledWith(expect.stringMatching(/^backup-gc:failed:/), 'snapshots/B/files/locked.dat');
  });
});
```

- [ ] Step 2: Run it, expect FAIL: `cd apps/api && npx vitest run src/jobs/backupRetention.test.ts` — every new assertion above fails against the pre-Task-7 implementation (wrong deferral semantics, `retiredSwept` computed same-pass, cap counting successes only, skip-set fed from one branch).

- [ ] Step 3: Implement — full replacement of `backupRetention.ts:550` (type) and `:873-1110` (both functions):

```typescript
export type BackupGcResult = {
  deleted: number;
  skippedIdentities: number;
  blockedIdentities: number;
  retiredSwept: number;
  orphansSwept: number;
  deferredIdentities: number;
  unreachableIdentities: number;
};
```

```typescript
async function deleteCandidatesWithCap(
  identity: { provider: string; providerConfig: unknown },
  candidates: BackupObjectListing[],
  cap: number,
  skipSet: Set<string>,
): Promise<{ deletedKeys: string[]; failedKeys: { key: string; error: string }[]; attempted: number }> {
  const eligible = candidates.filter((c) => !skipSet.has(c.key));
  if (eligible.length === 0 || cap <= 0) return { deletedKeys: [], failedKeys: [], attempted: 0 };
  eligible.sort((a, b) => (a.lastModified?.getTime() ?? 0) - (b.lastModified?.getTime() ?? 0));
  const toDelete = eligible.slice(0, cap).map((c) => c.key);
  const result = await deleteBackupObjectKeys({ provider: identity.provider, providerConfig: identity.providerConfig, keys: toDelete });
  // `attempted` (not `deletedKeys.length`) is what the caller charges against
  // the per-run cap — a failed attempt still cost a real provider call this
  // run and must not be retried unboundedly within the same run (review item).
  return { ...result, attempted: toDelete.length };
}

function manifestOlderThanWindow(item: BackupObjectListing, nowMs: number, windowMs: number): boolean {
  if (!item.lastModified) return false;
  return item.lastModified.getTime() <= nowMs - windowMs;
}

/**
 * §3.7: pure storage-and-compute — every DB read this needs is gathered by
 * the caller in a short DB context BEFORE this runs; every DB write this
 * produces (self-heal, retirement-swept) is applied by the caller in a short
 * DB context AFTER this returns. Never touches `db` itself.
 */
async function sweepStorageIdentity(
  identity: { key: string; provider: string; providerConfig: unknown },
  retainedSnapshotIds: string[],
  nullIdentityRows: { id: string; snapshotId: string }[], // storage_identity IS NULL, configId maps to this identity
  retiredSnapshotIds: Map<string, string>, // snapshotId -> retirement row id, sweptAt IS NULL only
  nowMs: number,
  deletesRemaining: number,
  graceMs: number,
  orphanWindowMs: number,
  manifestlessWindowMs: number,
  legacyHelperDeferred: boolean,
): Promise<{
  deleted: number;
  retiredSweptIds: string[]; // retirement row ids CONFIRMED fully gone from THIS run's fresh listing
  orphansSwept: number; // best-effort metric — see the accepted-approximation note above
  selfHealRowIds: string[]; // backup_snapshots.id values to self-heal
  unresolvedNullIdentityCount: number;
  deletesUsed: number;
}> {
  assertOutsideHeldDbContext('backupGC.sweepStorageIdentity');

  const listing = await listBackupObjectsUnderPrefix({
    provider: identity.provider,
    providerConfig: identity.providerConfig,
    prefix: backupSnapshotRootPrefix(),
  });
  const groups = groupListingBySnapshotId(listing);

  // §3.4/§3.6 P1: every NULL-identity row mapped to this identity is a root,
  // unconditionally. "Resolved" is the narrower, independent question of
  // whether THIS run's listing actually shows its manifest — that only
  // decides self-heal eligibility and the deferral gate below, never whether
  // the row counts as a root for the mark phase.
  const nullIdentitySnapshotIds = nullIdentityRows.map((r) => r.snapshotId);
  const alwaysRootedIds = new Set([...retainedSnapshotIds, ...nullIdentitySnapshotIds]);
  const selfHealRowIds = nullIdentityRows.filter((r) => groups.get(r.snapshotId)?.manifestItem).map((r) => r.id);
  const unresolvedNullIdentityCount = nullIdentityRows.length - selfHealRowIds.length;

  // §3.4: EITHER condition defers the WHOLE identity to exactly today's
  // (pre-D18) algorithm — no retired/orphan reclamation at all this run.
  const deferred = legacyHelperDeferred || unresolvedNullIdentityCount > 0;

  const graceThreshold = nowMs - graceMs;
  const manifestlessThreshold = nowMs - manifestlessWindowMs;
  const skipSet = await loadGcFailedKeySkipSet(identity.key);
  let deleted = 0;
  let orphansSwept = 0;
  let remaining = deletesRemaining;

  async function sweepRootedLoose(group: BackupGcSnapshotGroup, liveSet: Set<string>): Promise<void> {
    const candidates = group.items.filter(
      (item) => !liveSet.has(item.key) && item.lastModified && item.lastModified.getTime() <= graceThreshold,
    );
    const result = await deleteCandidatesWithCap(identity, candidates, remaining, skipSet);
    deleted += result.deletedKeys.length;
    remaining -= result.attempted;
    if (result.failedKeys.length > 0) await recordGcFailedKeys(identity.key, result.failedKeys); // review: fed from EVERY branch now
  }

  async function sweepManifestless(group: BackupGcSnapshotGroup, liveSet: Set<string>): Promise<void> {
    let newestMs: number | null = null;
    let hasUnknownAge = false;
    for (const item of group.items) {
      if (!item.lastModified) { hasUnknownAge = true; break; }
      const ms = item.lastModified.getTime();
      if (newestMs === null || ms > newestMs) newestMs = ms;
    }
    if (hasUnknownAge || newestMs === null || newestMs > manifestlessThreshold) return;
    const candidates = group.items.filter((item) => !liveSet.has(item.key));
    const result = await deleteCandidatesWithCap(identity, candidates, remaining, skipSet);
    deleted += result.deletedKeys.length;
    remaining -= result.attempted;
    if (result.failedKeys.length > 0) await recordGcFailedKeys(identity.key, result.failedKeys);
  }

  // Retired (any age) OR old-orphan two-phase reclaim. Handles a
  // "manifest-less retired remnant" too (manifest already gone from a prior
  // run) — in that case there is no manifest-gating to do, just delete
  // everything non-live in one phase. Never sets swept_at itself.
  async function reclaimUnrooted(group: BackupGcSnapshotGroup, liveSet: Set<string>): Promise<void> {
    const manifestKey = group.manifestItem?.key;
    const nonManifestNonLive = group.items.filter((item) => !liveSet.has(item.key) && item.key !== manifestKey);
    const nonManifestResult = await deleteCandidatesWithCap(identity, nonManifestNonLive, remaining, skipSet);
    deleted += nonManifestResult.deletedKeys.length;
    remaining -= nonManifestResult.attempted;
    if (nonManifestResult.failedKeys.length > 0) await recordGcFailedKeys(identity.key, nonManifestResult.failedKeys);

    if (!group.manifestItem) return; // manifest-less remnant — nothing further to gate

    // v3 manifest-last rule: candidate only when NO deletable non-manifest
    // key remains — none failed, none capped, none skip-set-excluded.
    const remainingNonManifest = nonManifestNonLive.filter((item) => !nonManifestResult.deletedKeys.includes(item.key));
    if (remainingNonManifest.length === 0 && !liveSet.has(manifestKey!) && remaining > 0) {
      const manifestResult = await deleteCandidatesWithCap(identity, [group.manifestItem], remaining, skipSet);
      deleted += manifestResult.deletedKeys.length;
      remaining -= manifestResult.attempted;
      if (manifestResult.failedKeys.length > 0) await recordGcFailedKeys(identity.key, manifestResult.failedKeys);
    }
  }

  if (deferred) {
    // §3.4 amendment: exactly today's algorithm. EVERY listed manifest is a
    // root, not just DB-rooted ids.
    const everyListedManifestIds: string[] = [];
    for (const [snapshotId, group] of groups) if (group.manifestItem) everyListedManifestIds.push(snapshotId);
    const rootsForMark = new Set([...alwaysRootedIds, ...everyListedManifestIds]);
    const liveSet = await markLiveBackupObjects(identity, rootsForMark);
    if (liveSet === null) throw new Error('mark phase failed — see prior log line for the specific snapshot/manifest');

    for (const [, group] of groups) {
      if (remaining <= 0) break;
      if (group.manifestItem) await sweepRootedLoose(group, liveSet);
      else await sweepManifestless(group, liveSet);
    }
  } else {
    const orphanIds = orphanManifestSnapshotIds(groups, alwaysRootedIds, retiredSnapshotIds, nowMs, orphanWindowMs);
    const rootsForMark = new Set([...alwaysRootedIds, ...orphanIds]);
    const liveSet = await markLiveBackupObjects(identity, rootsForMark);
    if (liveSet === null) throw new Error('mark phase failed — see prior log line for the specific snapshot/manifest');

    for (const [snapshotId, group] of groups) {
      if (remaining <= 0) break;
      if (rootsForMark.has(snapshotId)) { await sweepRootedLoose(group, liveSet); continue; }
      if (retiredSnapshotIds.has(snapshotId)) { await reclaimUnrooted(group, liveSet); continue; }
      if (!group.manifestItem) { await sweepManifestless(group, liveSet); continue; }
      if (!manifestOlderThanWindow(group.manifestItem, nowMs, orphanWindowMs)) continue; // defensive; unreachable given rootsForMark
      const before = deleted;
      await reclaimUnrooted(group, liveSet);
      if (deleted > before) orphansSwept++; // best-effort metric — see accepted approximation
    }
  }

  // swept_at confirmation — independent of `deferred`, and independent of
  // whatever this run deleted: a retirement is confirmed gone ONLY when
  // THIS run's fresh listing has NO group at all for its snapshotId.
  const retiredSweptIds: string[] = [];
  for (const [snapshotId, retirementId] of retiredSnapshotIds) {
    if (!groups.has(snapshotId)) retiredSweptIds.push(retirementId);
  }

  return { deleted, retiredSweptIds, orphansSwept, selfHealRowIds, unresolvedNullIdentityCount, deletesUsed: deletesRemaining - remaining };
}

async function identityHasLegacyHelper(
  identity: { key: string; configIds: string[] },
  nowMs: number,
): Promise<{ deferred: boolean; deviceId?: string; version?: string | null }> {
  const cutoff = new Date(nowMs - 30 * 24 * 60 * 60 * 1000);
  const rows = await db
    .selectDistinct({ deviceId: backupJobs.deviceId, backupVersion: devices.backupVersion })
    .from(backupJobs)
    .innerJoin(devices, eq(backupJobs.deviceId, devices.id))
    .where(and(
      or(
        eq(backupJobs.storageIdentity, identity.key),
        and(isNull(backupJobs.storageIdentity), inArray(backupJobs.configId, identity.configIds)),
      ),
      or(inArray(backupJobs.status, ['pending', 'running']), gte(backupJobs.createdAt, cutoff)),
    ));

  for (const row of rows) {
    if (!backupHelperSupportsServerBase(row.backupVersion)) {
      return { deferred: true, deviceId: row.deviceId, version: row.backupVersion };
    }
  }
  return { deferred: false };
}

/** Per-identity DB reads gathered in ONE short system context, per §3.7. */
async function loadIdentityGcState(
  identity: BackupGcStorageIdentity,
  nowMs: number,
): Promise<{
  retainedSnapshotIds: string[];
  nullIdentityRows: { id: string; snapshotId: string }[];
  retiredSnapshotIds: Map<string, string>;
  legacyHelper: { deferred: boolean; deviceId?: string; version?: string | null };
}> {
  return withSystemDbAccessContext(async () => {
    const retainedRows = await db
      .select({ snapshotId: backupSnapshots.snapshotId })
      .from(backupSnapshots)
      .where(eq(backupSnapshots.storageIdentity, identity.key));

    // P1 fix: fetch the primary key `id`, not just `snapshotId` — snapshot_id
    // is NOT unique across identities (schema/backup.ts:330's index is a
    // plain, non-unique index), so the self-heal write-back below must never
    // match on snapshot_id alone.
    const nullIdentityRows = await db
      .select({ id: backupSnapshots.id, snapshotId: backupSnapshots.snapshotId })
      .from(backupSnapshots)
      .where(and(isNull(backupSnapshots.storageIdentity), inArray(backupSnapshots.configId, identity.configIds)));

    const retirementRows = await db
      .select({ id: backupSnapshotRetirements.id, snapshotId: backupSnapshotRetirements.snapshotId })
      .from(backupSnapshotRetirements)
      .where(and(eq(backupSnapshotRetirements.storageIdentity, identity.key), isNull(backupSnapshotRetirements.sweptAt)));

    const legacyHelper = await identityHasLegacyHelper(identity, nowMs);

    return {
      retainedSnapshotIds: retainedRows.map((r) => r.snapshotId),
      nullIdentityRows,
      retiredSnapshotIds: new Map(retirementRows.map((r) => [r.snapshotId, r.id])),
      legacyHelper,
    };
  });
}

/** Per-identity DB writes applied in ONE short system context, per §3.7 — always AFTER every storage call for this identity has already returned. */
async function applyIdentityGcWriteBacks(
  identity: { key: string },
  writeBacks: { retiredSweptIds: string[]; selfHealRowIds: string[] },
): Promise<void> {
  if (writeBacks.retiredSweptIds.length === 0 && writeBacks.selfHealRowIds.length === 0) return;
  await withSystemDbAccessContext(async () => {
    for (const retirementId of writeBacks.retiredSweptIds) {
      await db.update(backupSnapshotRetirements).set({ sweptAt: new Date() }).where(eq(backupSnapshotRetirements.id, retirementId));
    }
    if (writeBacks.selfHealRowIds.length > 0) {
      // P1 fix: heal by PRIMARY ROW ID, guarded by storage_identity IS NULL —
      // matching on snapshot_id alone could re-stamp a DIFFERENT identity's
      // row sharing the same agent-generated snapshot id; the IS NULL guard
      // also protects against re-stamping a row a concurrent run just healed.
      await db
        .update(backupSnapshots)
        .set({ storageIdentity: identity.key })
        .where(and(inArray(backupSnapshots.id, writeBacks.selfHealRowIds), isNull(backupSnapshots.storageIdentity)));
    }
  });
}

async function pruneSweptRetirements(nowMs: number): Promise<void> {
  await withSystemDbAccessContext(async () => {
    const cutoff = new Date(nowMs - 30 * 24 * 60 * 60 * 1000);
    const deleted = await db
      .delete(backupSnapshotRetirements)
      .where(and(isNotNull(backupSnapshotRetirements.sweptAt), lt(backupSnapshotRetirements.sweptAt, cutoff)))
      .returning({ id: backupSnapshotRetirements.id });
    if (deleted.length > 0) console.log(`[BackupGC] Pruned ${deleted.length} swept retirement row(s) older than 30 days`);
  });
}

export async function sweepUnreferencedBackupObjects(): Promise<BackupGcResult> {
  const nowMs = Date.now();
  const graceMs = resolveBackupGcGraceMs();
  const orphanWindowMs = Math.max(resolveBackupOrphanManifestMaxAgeMs(), resolveBackupBaseLeaseMs() + graceMs);
  const manifestlessWindowMs = resolveBackupManifestlessPrefixMaxAgeMs();

  const { unattributedCount, identities, unreachableIdentities } = await withSystemDbAccessContext(async () => {
    const unattributedRows = await db.select({ id: backupSnapshots.id }).from(backupSnapshots).where(isNull(backupSnapshots.configId));
    const destinations = await db
      .select({ id: backupConfigs.id, provider: backupConfigs.provider, providerConfig: backupConfigs.providerConfig })
      .from(backupConfigs);
    const identitiesInner = groupBackupConfigsByStorageIdentity(destinations);
    const unreachable = await logUnreachableStorageIdentities(identitiesInner);
    return { unattributedCount: unattributedRows.length, identities: identitiesInner, unreachableIdentities: unreachable };
  });

  await pruneSweptRetirements(nowMs);

  if (unattributedCount > 0) {
    const wedgeMessage =
      `[BackupGC] ${unattributedCount} backup_snapshots row(s) have no config_id — cannot attribute to a ` +
      `storage identity, so their objects could live in ANY bucket. Blocking ALL ${identities.size} identity ` +
      `sweep(s) this run (fail-closed). REMEDIATION REQUIRED: this does not self-heal — attribute the affected ` +
      `row(s) to the correct backup_configs.id, or confirm they're orphaned and delete the row(s), then GC will ` +
      `resume on its next run.`;
    console.error(wedgeMessage);
    captureException(new Error(wedgeMessage));
    return {
      deleted: 0, skippedIdentities: identities.size, blockedIdentities: 0,
      retiredSwept: 0, orphansSwept: 0, deferredIdentities: 0, unreachableIdentities,
    };
  }

  const suspiciousIdentityKeys = detectSuspiciousStorageIdentityCollisions(identities);
  if (suspiciousIdentityKeys.size > 0) {
    captureException(new Error(
      `[BackupGC] ${suspiciousIdentityKeys.size} storage identity/identities excluded this run: a cruder ` +
      `bucket+host comparison collapses identities normalizeStorageIdentity kept apart.`,
    ));
  }

  let deleted = 0, skippedIdentities = 0, blockedIdentities = 0, retiredSwept = 0, orphansSwept = 0, deferredIdentities = 0;
  let deletesRemaining = resolveBackupGcMaxDeletesPerRun();

  for (const identity of identities.values()) {
    if (deletesRemaining <= 0) { console.log('[BackupGC] Deletion cap reached — stopping cleanly'); break; }
    if (suspiciousIdentityKeys.has(identity.key)) { skippedIdentities++; continue; }
    if (!BACKUP_GC_SUPPORTED_PROVIDERS.has(identity.provider)) {
      skippedIdentities++;
      console.warn(`[BackupGC] Identity ${identity.key}: provider '${identity.provider}' has no GC listing support — skipping`);
      continue;
    }

    try {
      const state = await loadIdentityGcState(identity, nowMs);
      if (state.legacyHelper.deferred) {
        deferredIdentities++;
        console.warn(`[BackupGC] reclamation deferred: legacy helper ${state.legacyHelper.deviceId} ${state.legacyHelper.version}`);
      }

      const identityResult = await sweepStorageIdentity(
        identity, state.retainedSnapshotIds, state.nullIdentityRows, state.retiredSnapshotIds,
        nowMs, deletesRemaining, graceMs, orphanWindowMs, manifestlessWindowMs,
        state.legacyHelper.deferred,
      );

      if (identityResult.unresolvedNullIdentityCount > 0) {
        console.warn(`[BackupGC] identity deferred: ${identityResult.unresolvedNullIdentityCount} unresolved rows`);
        if (!state.legacyHelper.deferred) deferredIdentities++; // avoid double-counting one identity for both reasons
      }

      deleted += identityResult.deleted;
      retiredSwept += identityResult.retiredSweptIds.length;
      orphansSwept += identityResult.orphansSwept;
      deletesRemaining -= identityResult.deletesUsed;

      await applyIdentityGcWriteBacks(identity, {
        retiredSweptIds: identityResult.retiredSweptIds,
        selfHealRowIds: identityResult.selfHealRowIds,
      });

      if (identityResult.deleted > 0) console.log(`[BackupGC] Identity ${identity.key}: deleted ${identityResult.deleted} object(s)`);
    } catch (error) {
      skippedIdentities++; blockedIdentities++;
      console.error(`[BackupGC] Identity ${identity.key}: sweep failed — isolated, other identities proceed:`, error);
      captureException(error instanceof Error ? error : new Error(String(error)));
    }
  }

  console.log(
    `[BackupGC] Run complete: deleted ${deleted} object(s), ${retiredSwept} retirement(s) confirmed swept, ` +
    `${orphansSwept} orphan(s) swept, ${skippedIdentities} identity/identities skipped, ${deferredIdentities} deferred, ` +
    `${unreachableIdentities} unreachable` + (blockedIdentities > 0 ? ` (${blockedIdentities} blocked)` : ''),
  );

  return { deleted, skippedIdentities, blockedIdentities, retiredSwept, orphansSwept, deferredIdentities, unreachableIdentities };
}
```

  Add to the top imports: `backupSnapshotRetirements`, `devices` to the `../db/schema` import list; `gte`, `isNotNull` to the `drizzle-orm` import list; `withSystemDbAccessContext`, `assertOutsideHeldDbContext` from `../db`; `resolveBackupOrphanManifestMaxAgeMs`, `resolveBackupBaseLeaseMs` from `../services/backupGcKnobs`; `backupHelperSupportsServerBase` from `../services/backupHelperCapabilities`.

  **Honesty note for the implementer:** the exact `selectQueue` push sequence in every test above was hand-derived against the finalized query order, not verified by actually running vitest — given how many tasks compound this file's mock ordering, treat a mismatch as expected friction, not a sign the design is wrong. Run the suite, read the first failure's actual vs. expected call, and fix the test's push order (never the source) unless the source itself is what's wrong per this task's stated algorithm.

- [ ] Step 4: Run, expect PASS (fix up `selectQueue` push counts per the note above as needed): `cd apps/api && npx vitest run src/jobs/backupRetention.test.ts`

- [ ] Step 5: Commit: `git add apps/api/src/jobs/backupRetention.ts apps/api/src/jobs/backupRetention.test.ts && git commit -m "feat(backup-gc): NULL rows always roots, deferral runs today's algorithm, cap/skip-set/swept_at correctness (D18 §3.4/§3.6 v3)"`

### Task 8: `backupWorker.ts` — remove the sweep's wrapping DB context and log the four new result fields

**Scope correction (read before starting):** W01, not this wave, owns moving `cleanup-expired-snapshots` out of `createBackupWorker`'s blanket `runWithSystemDbAccess` wrap (spec §3.7 point 2 — the job-dispatch-side half of the transaction-boundary fix), and this task does **not** touch `createBackupWorker`'s job-dispatch switch (`~99-118`) at all. But per spec §3.7's last paragraph, W01's `processCleanupExpiredSnapshots` calls the sweep as `await withSystemDbAccessContext(() => sweepUnreferencedBackupObjects())` — ONE system context wrapping the ENTIRE sweep call, opened after retention has committed per row (today's read shape, kept so the sweep's reads still had working GUCs at the point W01 hands off). This task's actual code change is to **remove that wrapper** so the call becomes bare (`await sweepUnreferencedBackupObjects();`) at depth 0 — Task 7's sweep now opens its own short per-identity contexts internally and does every storage call outside them, so a context still wrapping the whole call would defeat that split. This task also does **not** rename `sweepUnreferencedBackupObjects` — its exact export name and signature stay unchanged, which is why Task 7 keeps the name as-is throughout. This wave's own defense of the depth-0 assumption is both this wrapper removal AND the `assertOutsideHeldDbContext` tripwire added inside `sweepStorageIdentity` in Task 7.

**Files:** Modify `apps/api/src/jobs/backupWorker.ts:324-390` (`processCleanupExpiredSnapshots` only — its return type, its `try` block around the `sweepUnreferencedBackupObjects()` call, and its `return`). No other part of `backupWorker.ts` is touched by this task.

**Interfaces:**
- Consumes: the extended `BackupGcResult` from Task 7, and W01's `processCleanupExpiredSnapshots` shape — per spec §3.7's last paragraph, W01 calls the sweep as `await withSystemDbAccessContext(() => sweepUnreferencedBackupObjects())` (ONE system context wrapping the whole sweep call, opened after retention has committed per row — today's read shape, kept so the sweep's DB reads still have working GUCs at the call site W01 hands off from).
- Produces: that same call site with the `withSystemDbAccessContext(...)` wrapper REMOVED — `await sweepUnreferencedBackupObjects();` bare, at depth 0 — since Task 7's `sweepUnreferencedBackupObjects` now opens its own short per-identity contexts internally and does every storage call outside them; plus the extended return type `{ deleted, skipped, prunedByMaxVersions, failed, gcDeleted, gcSkippedIdentities, gcBlockedIdentities, gcRetiredSwept, gcOrphansSwept, gcDeferredIdentities, gcUnreachableIdentities }`.

**Cross-wave coordination note:** W01 restructures `processCleanupExpiredSnapshots`'s retention half (per-row short contexts) and moves its own call site out of the blanket wrap. This task's diff is scoped to the `try`/`return` around the `sweepUnreferencedBackupObjects()` call inside that same function — a small, easily-mergeable hunk, but still touching a function W01 is also editing. Whichever branch merges second should rebase onto the other's version of `processCleanupExpiredSnapshots` rather than blindly overwriting it (flagged in the PR checklist below), though the surface area of overlap is now much smaller than a full dispatch-switch restructure.

- [ ] Step 1: Write the failing test — find or add `apps/api/src/jobs/backupWorker.test.ts`'s test for `processCleanupExpiredSnapshots` (grep first: `grep -n "processCleanupExpiredSnapshots" apps/api/src/jobs/backupWorker.test.ts`) and extend its mock return value + assertion:

```typescript
// Extend the existing sweepUnreferencedBackupObjects mock in whatever
// describe block already covers processCleanupExpiredSnapshots:
sweepUnreferencedBackupObjectsMock.mockResolvedValueOnce({
  deleted: 3, skippedIdentities: 0, blockedIdentities: 0,
  retiredSwept: 1, orphansSwept: 2, deferredIdentities: 0, unreachableIdentities: 0,
});

const result = await processCleanupExpiredSnapshots();
expect(result.gcRetiredSwept).toBe(1);
expect(result.gcOrphansSwept).toBe(2);
expect(result.gcDeferredIdentities).toBe(0);
expect(result.gcUnreachableIdentities).toBe(0);
```

  (If no existing test file/mock covers this function, write the full test scaffold mirroring the mocking style already used elsewhere in `backupWorker.test.ts` for `db`/`sweepUnreferencedBackupObjects` — grep the file first for the established pattern before adding a new one. Do NOT add a test asserting anything about `runWithSystemDbAccess`/the job-dispatch switch — that boundary is W01's to prove.)

- [ ] Step 2: Run it, expect FAIL: `cd apps/api && npx vitest run src/jobs/backupWorker.test.ts` — `result.gcRetiredSwept` is undefined.

- [ ] Step 3: Implement — in `processCleanupExpiredSnapshots`, extend the return type annotation and the try block (this is the ONLY code change in this task):

```typescript
export async function processCleanupExpiredSnapshots(): Promise<{
  deleted: number;
  skipped: number;
  prunedByMaxVersions: number;
  failed: number;
  gcDeleted: number;
  gcSkippedIdentities: number;
  gcBlockedIdentities: number;
  gcRetiredSwept: number;
  gcOrphansSwept: number;
  gcDeferredIdentities: number;
  gcUnreachableIdentities: number;
}> {
  // ... unchanged org loop (and unchanged short-context restructuring, whatever
  // shape W01 lands it in) ...

  let gcDeleted = 0;
  let gcSkippedIdentities = 0;
  let gcBlockedIdentities = 0;
  let gcRetiredSwept = 0;
  let gcOrphansSwept = 0;
  let gcDeferredIdentities = 0;
  let gcUnreachableIdentities = 0;
  try {
    // W01 hands this off as `await withSystemDbAccessContext(() =>
    // sweepUnreferencedBackupObjects())` — remove that wrapper here. The
    // sweep (Task 7) now opens its own short per-identity contexts and does
    // every storage call outside them, so wrapping the whole call in one
    // context would defeat that split (§3.7) — the call must be bare, depth 0.
    const gcResult = await sweepUnreferencedBackupObjects();
    gcDeleted = gcResult.deleted;
    gcSkippedIdentities = gcResult.skippedIdentities;
    gcBlockedIdentities = gcResult.blockedIdentities;
    gcRetiredSwept = gcResult.retiredSwept;
    gcOrphansSwept = gcResult.orphansSwept;
    gcDeferredIdentities = gcResult.deferredIdentities;
    gcUnreachableIdentities = gcResult.unreachableIdentities;
  } catch (err) {
    console.error('[BackupWorker] Backup object GC sweep failed — retention run still succeeded:', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }

  // ... unchanged failed>0 throw ...

  return {
    deleted, skipped, prunedByMaxVersions, failed,
    gcDeleted, gcSkippedIdentities, gcBlockedIdentities,
    gcRetiredSwept, gcOrphansSwept, gcDeferredIdentities, gcUnreachableIdentities,
  };
}
```

- [ ] Step 4: Run, expect PASS: `cd apps/api && npx vitest run src/jobs/backupWorker.test.ts`

- [ ] Step 4b: Add the depth-0 regression to the existing real-depth harness — `apps/api/src/jobs/backupWorker.dbcontext.test.ts` (review item: "the depth harness is `backupWorker.dbcontext.test.ts`"). This file already mocks `../db`'s `withSystemDbAccessContext` with REAL enter/exit depth tracking (`ctxState`, see its header comment) and already stubs `./backupRetention`'s `cleanupExpiredSnapshots`/`sweepUnreferencedBackupObjects` as plain `vi.fn()`s — replace those two stubs with implementations that record `ctxState.depth` when called, and add a describe block exercising `processCleanupExpiredSnapshots` (already exported, unchanged by this task's Step 3 beyond its return shape) directly:

```typescript
// Replace the existing blanket stub:
//   vi.mock('./backupRetention', () => ({
//     cleanupExpiredSnapshots: vi.fn(),
//     sweepUnreferencedBackupObjects: vi.fn(),
//   }));
// with recording versions so this file's real ctxState can prove WHERE each
// call happens, mirroring how it already does this for dispatchCommandToAgent.
const cleanupExpiredSnapshotsMock = vi.fn(async () => {
  ctxState.events.push(`cleanupExpiredSnapshots@depth${ctxState.depth}`);
  return { deleted: 0, skippedLegalHold: 0, skippedImmutable: 0, prunedByMaxVersions: 0, failed: 0 };
});
const sweepUnreferencedBackupObjectsMock = vi.fn(async () => {
  ctxState.events.push(`sweepUnreferencedBackupObjects@depth${ctxState.depth}`);
  return {
    deleted: 0, skippedIdentities: 0, blockedIdentities: 0,
    retiredSwept: 0, orphansSwept: 0, deferredIdentities: 0, unreachableIdentities: 0,
  };
});
vi.mock('./backupRetention', () => ({
  cleanupExpiredSnapshots: cleanupExpiredSnapshotsMock,
  sweepUnreferencedBackupObjects: sweepUnreferencedBackupObjectsMock,
}));

describe('processCleanupExpiredSnapshots DB-context scoping (D18 §3.7)', () => {
  beforeEach(() => {
    ctxState.depth = 0;
    ctxState.events = [];
    mockDb.select.mockReturnValue({
      from: () => ({ then: (resolve: (v: unknown[]) => unknown) => Promise.resolve([]).then(resolve) }),
    });
  });

  it('calls sweepUnreferencedBackupObjects at depth 0 — never nested inside a held DB context', async () => {
    const { processCleanupExpiredSnapshots } = await import('./backupWorker');
    await processCleanupExpiredSnapshots();

    expect(sweepUnreferencedBackupObjectsMock).toHaveBeenCalledTimes(1);
    const sweepEvent = ctxState.events.find((e) => e.startsWith('sweepUnreferencedBackupObjects@'));
    expect(sweepEvent).toBe('sweepUnreferencedBackupObjects@depth0');
  });
});
```

  Note this test exercises `processCleanupExpiredSnapshots` directly — it does NOT invoke it through `createBackupWorker`'s job-dispatch switch (that carve-out is W01's to author and test; this file's existing `mockDb.select.mockReturnValue(...)` for the org-loop query may need adjusting to match whatever shape W01's actual per-org retention loop takes — treat the exact mock as illustrative and adapt to W01's real `processCleanupExpiredSnapshots` internals once merged, the way this task's Step 1/3 already do for the same reason).

- [ ] Step 5: Commit: `git add apps/api/src/jobs/backupWorker.ts apps/api/src/jobs/backupWorker.test.ts apps/api/src/jobs/backupWorker.dbcontext.test.ts && git commit -m "feat(backup-gc): surface retirement/orphan/deferred/unreachable counts from the worker; assert depth-0 invocation"`

### Task 9: Integration test — real DB + real local filesystem, spec §6 scenarios (1)-(5) + self-heal scenarios (6a/6b)

**Files:** Create `apps/api/src/__tests__/integration/backupGcReclamation.integration.test.ts`.

**Interfaces:**
- Consumes: `withSystemDbAccessContext`, `db` from `../../db`; `partners, organizations, sites, devices, backupConfigs, backupJobs, backupSnapshots, backupSnapshotRetirements` from `../../db/schema`; `sweepUnreferencedBackupObjects` from `../../jobs/backupRetention`.
- Runs against: `providerConfig.path` pointing at `fs.mkdtempSync` temp dirs (provider `'local'`), real files written and aged via `fs.promises.utimes`.

**Test database (P2 review — do not point this at the dev DB).** This suite runs against the **dedicated integration test database**, never `postgresql://breeze:breeze@localhost:5432/breeze` (that's the dev/wt-stack DB). `apps/api/src/__tests__/integration/setup.ts` (imported via `import './setup'`, same as `staleBackupReaper.integration.test.ts`) already resolves `DATABASE_URL`/`DATABASE_URL_APP` from `.env.test` (defaults: `postgresql://breeze_test:breeze_test@localhost:5433/breeze_test` — port **5433**, not 5432 — and the `breeze_app`-equivalent role) and calls `assertTestDatabaseUrlSafe` (`apps/api/src/testUtils/integrationDatabaseSafety.ts`) before opening any pool, which hard-refuses a non-`breeze_test(_*)`-named database, a non-allowlisted host, or the default port 5432. **Never pass an explicit `DATABASE_URL=...` override on the command line for this suite** — let `setup.ts` resolve it from `.env.test`, and stand up the test containers first with `pnpm test-stack up` (repo root) if they aren't already running, matching `setup.ts`'s own docstring.

**Out of scope for this file (say so explicitly, per review) — these are W01's suite, not this wave's:** lease expiry / renewal (`base_lease_expires_at`/`publish_lease_expires_at`), the restore-pin linger window, and the concurrent-dispatch-vs-retention row-lock race. This wave's "pinned" scenario below only proves that a still-RETAINED row (one retention hasn't deleted — because W01's pin check blocked it, which is W01's own concern) is protected by the sweep like any other rooted row; it does not exercise or assert anything about how or when a row becomes pinned.

- [ ] Step 1: Write the failing test (this whole file is new — "failing" means it doesn't exist / fails to compile until Task 7 is fully landed):

```typescript
import './setup';

import { mkdtemp, mkdir, writeFile, utimes, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
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
import { sweepUnreferencedBackupObjects } from '../../jobs/backupRetention';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function writeAged(root: string, relPath: string, ageMs: number, contents = 'x'): Promise<void> {
  const full = join(root, relPath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, contents);
  const t = new Date(Date.now() - ageMs);
  await utimes(full, t, t);
}

async function listAll(root: string, prefix = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listAll(root, rel)));
    else out.push(rel);
  }
  return out;
}

async function seedOrgDeviceConfig(unique: string, rootPath: string, backupVersion = '0.112.0') {
  const [partner] = await db.insert(partners).values({
    name: `GC Partner ${unique}`, slug: `gc-partner-${unique}`, type: 'msp', plan: 'pro', status: 'active',
  }).returning({ id: partners.id });
  const [org] = await db.insert(organizations).values({
    currencyCode: 'USD', partnerId: partner!.id, name: `GC Org ${unique}`, slug: `gc-org-${unique}`, type: 'customer', status: 'active',
  }).returning({ id: organizations.id });
  const [site] = await db.insert(sites).values({ orgId: org!.id, name: `GC Site ${unique}` }).returning({ id: sites.id });
  const [device] = await db.insert(devices).values({
    orgId: org!.id, siteId: site!.id, agentId: `gc-agent-${unique}`, hostname: `gc-host-${unique}`,
    osType: 'linux', osVersion: '1', architecture: 'x86_64', agentVersion: '0.0.0-test',
    backupVersion, status: 'online',
  }).returning({ id: devices.id });
  const [config] = await db.insert(backupConfigs).values({
    orgId: org!.id, name: `GC Config ${unique}`, type: 'file', provider: 'local', providerConfig: { path: rootPath },
  }).returning({ id: backupConfigs.id });
  const identity = `local::${rootPath}`;
  return { orgId: org!.id, deviceId: device!.id, configId: config!.id, identity };
}

async function insertSnapshotRow(params: {
  orgId: string; deviceId: string; configId: string; snapshotId: string; identity: string;
  expiresAt?: Date | null; backupType?: 'file' | 'system_image' | 'hyperv' | 'mssql';
}) {
  const [job] = await db.insert(backupJobs).values({
    orgId: params.orgId, configId: params.configId, deviceId: params.deviceId, status: 'completed', snapshotId: params.snapshotId,
  }).returning({ id: backupJobs.id });
  await db.insert(backupSnapshots).values({
    orgId: params.orgId, jobId: job!.id, deviceId: params.deviceId, configId: params.configId,
    snapshotId: params.snapshotId, storageIdentity: params.identity, expiresAt: params.expiresAt ?? null,
    backupType: params.backupType ?? 'file',
  });
}

runDb('scenario 1: expiring a base with an incremental child reclaims ONLY the base-exclusive object, keeping every shared backupPath the incremental references', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = await mkdtemp(join(tmpdir(), 'breeze-gc-'));

  const seed = await withSystemDbAccessContext(async () => {
    const seed = await seedOrgDeviceConfig(unique, root);

    // Base B has an object exclusively its own (only-in-b.dat) AND a
    // separately-tracked shared object (shared.dat) that C's manifest ALSO
    // references. Retiring B must reclaim only-in-b.dat and B's manifest,
    // never shared.dat — the previous draft of this scenario wrongly listed
    // shared.dat as B's own exclusive object while ALSO having C reference
    // it, then asserted it gone (a real data-loss bug in the TEST, not the
    // implementation — fixed here per review).
    await writeAged(root, 'snapshots/B/manifest.json', 1000, JSON.stringify({ files: [
      { backupPath: 'snapshots/B/files/only-in-b.dat' },
      { backupPath: 'snapshots/B/files/shared.dat' },
    ] }));
    await writeAged(root, 'snapshots/B/files/only-in-b.dat', 1000); // B-exclusive — must be deleted
    await writeAged(root, 'snapshots/B/files/shared.dat', 1000); // referenced by C too — must survive
    await writeAged(root, 'snapshots/C/manifest.json', 1000, JSON.stringify({ files: [
      { backupPath: 'snapshots/B/files/shared.dat' },
      { backupPath: 'snapshots/C/files/c.dat' },
    ] }));
    await writeAged(root, 'snapshots/C/files/c.dat', 1000);

    await insertSnapshotRow({ ...seed, snapshotId: 'C' }); // C stays retained
    await db.insert(backupSnapshotRetirements).values({
      orgId: seed.orgId, configId: seed.configId, deviceId: seed.deviceId,
      snapshotId: 'B', storageIdentity: seed.identity, backupType: 'file', reason: 'expired', retiredAt: new Date(),
    });
    return seed;
  });

  await sweepUnreferencedBackupObjects();

  const afterFirstRun = await listAll(root);
  expect(afterFirstRun).not.toContain('snapshots/B/files/only-in-b.dat');
  expect(afterFirstRun).toContain('snapshots/B/files/shared.dat'); // still shared with C — must survive
  expect(afterFirstRun).toContain('snapshots/C/manifest.json');
  expect(afterFirstRun).toContain('snapshots/C/files/c.dat');
  // B's manifest is only removable once nothing non-manifest remains under
  // B's prefix; shared.dat is LIVE (referenced by C), so it is never a
  // candidate — B's prefix therefore never reaches "everything non-manifest
  // gone", and per the v3 manifest-last rule B's manifest is retained too.
  // (This is intentional and matches spec §5's dedup-sharing row: a bucket
  // holding a still-referenced object is not incorrectly reclaimed.)
  expect(afterFirstRun).toContain('snapshots/B/manifest.json');

  // swept_at is NEVER set in the same pass as the deletes (P2 review) — and
  // in this case it will never be set at all while shared.dat stays live.
  const [retirementRow] = await withSystemDbAccessContext(() =>
    db.select().from(backupSnapshotRetirements).where(eq(backupSnapshotRetirements.storageIdentity, seed.identity)),
  );
  expect(retirementRow!.sweptAt).toBeNull();
});

runDb('scenario 2: a still-retained (non-expired) row is protected regardless of age — including one referenced by an in-progress base pin', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = await mkdtemp(join(tmpdir(), 'breeze-gc-'));

  await withSystemDbAccessContext(async () => {
    const seed = await seedOrgDeviceConfig(unique, root);
    await writeAged(root, 'snapshots/PINNED/manifest.json', 30 * 24 * 60 * 60 * 1000, JSON.stringify({ files: [] })); // 30 days old
    await writeAged(root, 'snapshots/PINNED/files/p.dat', 30 * 24 * 60 * 60 * 1000);
    await insertSnapshotRow({ ...seed, snapshotId: 'PINNED' }); // retention has NOT deleted this row

    // Realistic fixture for what W01's pin looks like on disk — an in-progress
    // dispatch that picked PINNED as its dedupe base. Requires W01's
    // `backup_jobs.base_snapshot_id`/`publish_lease_expires_at` columns; this
    // integration suite is authored to run AFTER W01 merges, so they exist.
    // This test does not exercise the LEASE mechanism itself (expiry,
    // renewal) — that is W01's own suite; it only proves the sweep leaves a
    // still-retained row alone regardless of how old its objects are.
    await db.insert(backupJobs).values({
      orgId: seed.orgId, configId: seed.configId, deviceId: seed.deviceId, status: 'running',
      baseSnapshotId: 'PINNED', publishLeaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
  });

  await sweepUnreferencedBackupObjects();

  const remaining = await listAll(root);
  expect(remaining.sort()).toEqual(['snapshots/PINNED/files/p.dat', 'snapshots/PINNED/manifest.json'].sort());
});

runDb('scenario 3: an orphan manifest past ORPHAN_WINDOW with no row and no retirement is reclaimed; younger than the window it is a root', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = await mkdtemp(join(tmpdir(), 'breeze-gc-'));
  const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;

  await withSystemDbAccessContext(async () => {
    await seedOrgDeviceConfig(unique, root);
    await writeAged(root, 'snapshots/ABANDONED/manifest.json', TEN_DAYS_MS, JSON.stringify({ files: [] }));
    await writeAged(root, 'snapshots/ABANDONED/files/a.dat', TEN_DAYS_MS);
  });

  await sweepUnreferencedBackupObjects();
  expect(await listAll(root)).toEqual([]);
});

runDb('scenario 3b: ORPHAN_WINDOW\'s lease-derived arm (BACKUP_BASE_LEASE_MS + BACKUP_GC_GRACE_MS) protects an orphan the 9-day default alone would already have swept', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = await mkdtemp(join(tmpdir(), 'breeze-gc-'));
  const NINE_DAYS_PLUS_MS = 9 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000; // just past the 9-day default arm...

  await withSystemDbAccessContext(async () => {
    await seedOrgDeviceConfig(unique, root);
    await writeAged(root, 'snapshots/LEASEWINDOW/manifest.json', NINE_DAYS_PLUS_MS, JSON.stringify({ files: [] }));
  });

  const prevLease = process.env.BACKUP_BASE_LEASE_MS;
  process.env.BACKUP_BASE_LEASE_MS = String(9 * 24 * 60 * 60 * 1000); // ...but a widened lease makes the OTHER arm bigger
  try {
    await sweepUnreferencedBackupObjects();
    // Still protected: max(9d default, 9d lease + 48h grace) > this object's age.
    expect(await listAll(root)).toContain('snapshots/LEASEWINDOW/manifest.json');
  } finally {
    if (prevLease === undefined) delete process.env.BACKUP_BASE_LEASE_MS; else process.env.BACKUP_BASE_LEASE_MS = prevLease;
  }
});

runDb('scenario 4: a legacy helper on the identity defers to EXACTLY today\'s algorithm — the retired prefix is fully protected, not just its manifest', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = await mkdtemp(join(tmpdir(), 'breeze-gc-'));

  await withSystemDbAccessContext(async () => {
    const seed = await seedOrgDeviceConfig(unique, root, '0.109.0'); // pre-server-base helper
    await writeAged(root, 'snapshots/RETIREDLEGACY/manifest.json', 1000, JSON.stringify({ files: [] }));
    await writeAged(root, 'snapshots/RETIREDLEGACY/files/r.dat', 1000);
    await db.insert(backupSnapshotRetirements).values({
      orgId: seed.orgId, configId: seed.configId, deviceId: seed.deviceId,
      snapshotId: 'RETIREDLEGACY', storageIdentity: seed.identity, backupType: 'file', reason: 'expired', retiredAt: new Date(),
    });
    await db.insert(backupJobs).values({ orgId: seed.orgId, configId: seed.configId, deviceId: seed.deviceId, status: 'completed' });
  });

  await sweepUnreferencedBackupObjects();

  const remaining = await listAll(root);
  expect(remaining.sort()).toEqual(['snapshots/RETIREDLEGACY/files/r.dat', 'snapshots/RETIREDLEGACY/manifest.json'].sort());
});

runDb('scenario 5: an undeletable object blocks only that prefix\'s manifest, not other prefixes', async () => {
  // Local-provider delete is `rm(path, { force: true })`, which swallows
  // ENOENT — an empty/missing FILE never fails. A DIRECTORY placed where a
  // file key is expected also does NOT reach deletion: listLocalObjectsWithLastModified
  // (backupSnapshotStorage.ts:213-256) RECURSES into directories, so an empty
  // `blocked.dat/` dir simply contributes zero listed files — it's invisible
  // to the sweep entirely, never a delete candidate (this was a fixture bug
  // in the previous draft, per review). Induce a REAL, permanent delete
  // failure instead: chmod the parent directory read+execute-only (0500)
  // during the delete phase, so `unlink` inside it gets EACCES; restore
  // permissions in `afterEach` so the temp dir can still be cleaned up.
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = await mkdtemp(join(tmpdir(), 'breeze-gc-'));
  const blockedDir = join(root, 'snapshots/RETIREDBLOCKED/files');

  await withSystemDbAccessContext(async () => {
    const seed = await seedOrgDeviceConfig(unique, root);
    await writeAged(root, 'snapshots/RETIREDBLOCKED/manifest.json', 1000, JSON.stringify({ files: [] }));
    await writeAged(root, 'snapshots/RETIREDBLOCKED/files/locked.dat', 1000);
    await db.insert(backupSnapshotRetirements).values({
      orgId: seed.orgId, configId: seed.configId, deviceId: seed.deviceId,
      snapshotId: 'RETIREDBLOCKED', storageIdentity: seed.identity, backupType: 'file', reason: 'expired', retiredAt: new Date(),
    });
  });

  await chmod(blockedDir, 0o500); // read+execute only — unlink() inside it fails EACCES
  try {
    await sweepUnreferencedBackupObjects();
  } finally {
    await chmod(blockedDir, 0o700); // restore before the temp-dir cleanup / next test
  }

  // Manifest survives because the non-manifest phase had a failure.
  expect(await listAll(root)).toContain('snapshots/RETIREDBLOCKED/manifest.json');
});

runDb('scenario 6a: a NULL-identity row whose manifest IS found resolves in this run and its identity reclaims normally (no longer deferred)', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = await mkdtemp(join(tmpdir(), 'breeze-gc-'));

  const seed = await withSystemDbAccessContext(async () => {
    const seed = await seedOrgDeviceConfig(unique, root);

    await writeAged(root, 'snapshots/HEALME/manifest.json', 1000, JSON.stringify({ files: [] }));
    const [job] = await db.insert(backupJobs).values({
      orgId: seed.orgId, configId: seed.configId, deviceId: seed.deviceId, status: 'completed', snapshotId: 'HEALME',
    }).returning({ id: backupJobs.id });
    await db.insert(backupSnapshots).values({
      orgId: seed.orgId, jobId: job!.id, deviceId: seed.deviceId, configId: seed.configId,
      snapshotId: 'HEALME', storageIdentity: null, // deliberately unresolved
    });

    await writeAged(root, 'snapshots/RETIRED6A/manifest.json', 1000, JSON.stringify({ files: [] }));
    await writeAged(root, 'snapshots/RETIRED6A/files/r.dat', 1000);
    await db.insert(backupSnapshotRetirements).values({
      orgId: seed.orgId, configId: seed.configId, deviceId: seed.deviceId,
      snapshotId: 'RETIRED6A', storageIdentity: seed.identity, backupType: 'file', reason: 'expired', retiredAt: new Date(),
    });
    return seed;
  });

  // HEALME's manifest IS present in this run's listing -> resolves; with no
  // unresolved rows left and no legacy helper, this identity is NOT deferred,
  // so RETIRED6A reclaims its non-manifest objects in the SAME run (its
  // swept_at confirmation still waits for the NEXT run's fresh listing, per
  // the two-pass rule — asserted separately in the unit suite, Task 7).
  await sweepUnreferencedBackupObjects();

  const remaining = await listAll(root);
  expect(remaining).not.toContain('snapshots/RETIRED6A/files/r.dat');
  expect(remaining).toContain('snapshots/HEALME/manifest.json');

  const [healedRow] = await withSystemDbAccessContext(() =>
    db.select().from(backupSnapshots).where(eq(backupSnapshots.snapshotId, 'HEALME')),
  );
  expect(healedRow!.storageIdentity).toBe(seed.identity);
});

runDb('scenario 6b: a NULL-identity row whose manifest is NOT found defers the WHOLE identity to today\'s algorithm — nothing unrooted is deleted', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = await mkdtemp(join(tmpdir(), 'breeze-gc-'));

  await withSystemDbAccessContext(async () => {
    const seed = await seedOrgDeviceConfig(unique, root);

    // NEVERWRITTEN's row exists (mapped to this identity's config) but its
    // object was never actually written to THIS bucket — never appears in
    // the listing, so it can never resolve.
    const [job] = await db.insert(backupJobs).values({
      orgId: seed.orgId, configId: seed.configId, deviceId: seed.deviceId, status: 'completed', snapshotId: 'NEVERWRITTEN',
    }).returning({ id: backupJobs.id });
    await db.insert(backupSnapshots).values({
      orgId: seed.orgId, jobId: job!.id, deviceId: seed.deviceId, configId: seed.configId,
      snapshotId: 'NEVERWRITTEN', storageIdentity: null,
    });

    await writeAged(root, 'snapshots/RETIRED6B/manifest.json', 1000, JSON.stringify({ files: [] }));
    await writeAged(root, 'snapshots/RETIRED6B/files/r.dat', 1000);
    await db.insert(backupSnapshotRetirements).values({
      orgId: seed.orgId, configId: seed.configId, deviceId: seed.deviceId,
      snapshotId: 'RETIRED6B', storageIdentity: seed.identity, backupType: 'file', reason: 'expired', retiredAt: new Date(),
    });
  });

  await sweepUnreferencedBackupObjects();

  // Deferred (unresolved NULL row) -> today's algorithm -> RETIRED6B's
  // manifest is marked live (it's listed) and its loose object is only 1s
  // old, well inside the 48h grace -> nothing deleted at all.
  const remaining = await listAll(root);
  expect(remaining.sort()).toEqual(['snapshots/RETIRED6B/files/r.dat', 'snapshots/RETIRED6B/manifest.json'].sort());
});

runDb('scenario 7: system_image, hyperv, and mssql rows are roots exactly like file rows (no backupType filter)', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = await mkdtemp(join(tmpdir(), 'breeze-gc-'));

  const seed = await withSystemDbAccessContext(async () => {
    const seed = await seedOrgDeviceConfig(unique, root);
    for (const [snapshotId, backupType] of [
      ['IMG1', 'system_image'], ['HV1', 'hyperv'], ['SQL1', 'mssql'],
    ] as const) {
      await writeAged(root, `snapshots/${snapshotId}/manifest.json`, 20 * 24 * 60 * 60 * 1000, JSON.stringify({ files: [] }));
      await insertSnapshotRow({ ...seed, snapshotId, backupType });
    }
    return seed;
  });

  await sweepUnreferencedBackupObjects();

  // All three survive despite being 20 days old — they're rooted DB rows,
  // never filtered out by backupType (Task 3's fix), and their manifest
  // fetch must succeed (proving the mark phase doesn't 404 on a non-file
  // manifest key, since every mode publishes the same snapshots/<id>/manifest.json).
  const remaining = await listAll(root);
  expect(remaining.sort()).toEqual([
    'snapshots/IMG1/manifest.json', 'snapshots/HV1/manifest.json', 'snapshots/SQL1/manifest.json',
  ].sort());
});
```

- [ ] Step 2: Run it, expect FAIL until Task 7 lands: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/backupGcReclamation.integration.test.ts` (ensure the dedicated test stack is up first — `pnpm test-stack up` at the repo root, or `docker compose -f docker-compose.test.yml up -d` per `setup.ts`'s docstring; do **not** set `DATABASE_URL` on the command line — `setup.ts` resolves it from `.env.test`).

- [ ] Step 3: Implement — no production code changes in this step; this task exists to prove Task 7's implementation against a real database and real filesystem. If any scenario fails, fix `backupRetention.ts` (not the test) unless the test itself has a bug — re-derive from spec §6 rather than loosening an assertion.

- [ ] Step 4: Run, expect PASS: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/backupGcReclamation.integration.test.ts` (the `pnpm --filter @breeze/api run test:integration -- <path>` form is the CLAUDE.md `--` trap — it runs the WHOLE integration suite, not this one file; the direct `npx vitest run --config ...` form above sidesteps it entirely).

- [ ] Step 5: Commit: `git add apps/api/src/__tests__/integration/backupGcReclamation.integration.test.ts && git commit -m "test(backup-gc): integration coverage for retirement/orphan/pin/legacy-helper/self-heal/cross-type sweep rules"`

### Task 10: Docs — storage.mdx and monitoring.mdx no longer say "not reclaimed"

**Files:** Modify `apps/docs/src/content/docs/backup/storage.mdx:53-61`. Modify `apps/docs/src/content/docs/backup/monitoring.mdx:119`.

**Interfaces:** None (prose only).

- [ ] Step 1: Write the failing test — this is a docs-only change; there is no automated assertion, so the "test" is a manual content diff review. Skip the red/green cycle per the repo's low-blast-radius carve-out (CLAUDE.md: "CRUD, copy, renames, docs, config" proceed directly). Confirm the exact old text first: `grep -n "not yet reclaim\|not yet reclaimed" apps/docs/src/content/docs/backup/*.mdx`.

- [ ] Step 2: N/A (docs).

- [ ] Step 3: Implement — replace `storage.mdx`'s aside (lines `53-61`):

```mdx
  <Aside type="note" title="What retention removes today">
    When a restore point passes its retention window, Breeze removes it from the snapshot list — it can no
    longer be restored or verified — and marks its data for reclamation. A background storage sweep then
    deletes the restore point's exclusive data from the storage target on its next scheduled run, after a
    short safety grace period (48 hours by default) that protects any object still mid-upload. Data another
    surviving restore point still depends on (for example, a file shared with an incremental backup) is never
    deleted, no matter how old it is. An upload that never finished, or whose record could not be reconciled,
    is reclaimed once it has sat idle for about 9 days — giving Breeze time to recognize and finish adopting
    it first.

    If a device's Breeze backup helper predates version 0.112.0, storage reclamation beyond an expired
    snapshot's own row stays deferred on that device's destination until every device sharing it has
    upgraded — update the agent to enable full reclamation.
  </Aside>
```

  Replace `monitoring.mdx:119`:

```mdx
If storage is growing faster than expected, check whether large datasets were recently added to backup scope. Expired restore points are removed from Breeze immediately and their storage is reclaimed by the periodic reclamation sweep (see the [storage page](/backup/storage/) for timing and safety windows) — allow for the grace period and the next scheduled sweep before usage reflects the drop.
```

- [ ] Step 4: N/A (docs) — sanity-check the build: `pnpm --filter @breeze/docs build` if time allows, otherwise a visual proofread of the rendered MDX is sufficient for a prose-only change.

- [ ] Step 5: Commit: `git add apps/docs/src/content/docs/backup/storage.mdx apps/docs/src/content/docs/backup/monitoring.mdx && git commit -m "docs(backup): storage reclamation is now implemented (closes the #5429 caveat)"`

### Task 11: Wave verification

- [ ] Full targeted unit run: `cd apps/api && npx vitest run src/jobs/backupRetention.test.ts src/jobs/backupWorker.test.ts src/jobs/backupWorker.dbcontext.test.ts src/services/backupHelperCapabilities.test.ts src/services/backupAgentContract.test.ts`
- [ ] Typecheck: `pnpm --filter @breeze/api exec tsc --noEmit` (no dedicated typecheck script in `apps/api/package.json` — confirmed via `grep -n '"test"\|"typecheck"\|"build"' apps/api/package.json`, which shows only `"build": "tsup"` and `"test": "vitest"`).
- [ ] Integration suite (needs the dedicated test stack up — `pnpm test-stack up` at the repo root — and resolves `DATABASE_URL`/`DATABASE_URL_APP` from `.env.test` automatically via `setup.ts`; **do not** pass an explicit `DATABASE_URL=...` override, and never point this at port 5432): `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/backupGcReclamation.integration.test.ts src/__tests__/integration/staleBackupReaper.integration.test.ts`
- [ ] No schema changes in this wave, so `pnpm db:check-drift` is not expected to show new drift — run it anyway as a sanity check since W01 may have just landed: `pnpm db:check-drift`
- [ ] Full API unit suite once the above are green: `pnpm --filter @breeze/api test --run` (NOT `-- --run`, see the CLAUDE.md `--` trap)
- [ ] `pnpm lint`
- [ ] PR body checklist:
  - [ ] Links the spec (`docs/superpowers/specs/backup/2026-09-09-backup-gc-reclamation-design.md`, v3) and this plan.
  - [ ] States the dependency on W01 explicitly and confirms W01's actual shipped shape (table/column names — especially `publish_lease_expires_at` vs the earlier `base_lease_expires_at`, `backup_jobs.storage_identity`, `backup_snapshots.storage_identity` nullability, `backupGcKnobs.ts` signatures) matched what this plan assumed — flag any drift found during implementation.
  - [ ] Confirms `backupAgentContract.test.ts` is green (the 7-day journal literal contract).
  - [ ] Confirms the Redis skip-set uses the shared non-blocking client (`getRedis()`), never a blocking command on it.
  - [ ] Confirms the capability gate and the unresolved-NULL-rows gate each independently suppress ONLY the retired/orphan reclamation, never the pre-existing rooted-grace or manifest-less-prefix rules.
  - [ ] Confirms no code path calls `sweepUnreferencedBackupObjects()` (or anything it calls) from inside another open `withSystemDbAccessContext`/`withDbAccessContext` — verified two ways: `backupWorker.dbcontext.test.ts`'s new depth assertion (Task 8) proving THIS wave's `processCleanupExpiredSnapshots` edit calls it at depth 0, and confirming W01 actually landed the `cleanup-expired-snapshots` carve-out out of the blanket `runWithSystemDbAccess` wrap (consumed interface, not re-verified by this wave's own tests beyond the depth-0 assertion above).
  - [ ] No production migration in this PR (W01 owns migrations); `db:check-drift` clean.
  - [ ] Docs PR note: storage.mdx/monitoring.mdx no longer claim reclamation is unimplemented.

## Open questions / contradictions

- **`backupWorker.ts` ownership is now cleanly split (resolved).** Per coordinator decision, W01 owns the ENTIRE `cleanup-expired-snapshots` dispatch-switch carve-out; this wave's Task 8 only edits `processCleanupExpiredSnapshots`'s return type/logging, a small hunk inside a function W01 also touches. A rebase may still be needed if both waves land near-simultaneously, but the overlap is now small and well-scoped rather than a full dispatch-switch collision — no longer flagging this as unresolved, just noting the small-overlap merge risk in the PR checklist.
- **"Prefix found empty"/`swept_at` timing (resolved by review, restated for traceability).** The corrected design (Task 7) never infers `swept_at` from the same run's own delete bookkeeping — it is set only when a FRESH listing shows no group at all for that `snapshotId`, which naturally handles both "already gone" (same run, zero storage calls needed) and "gone after this run's real deletes" (confirmed on the NEXT run). A snapshot still holding a live, shared object simply never reaches this state, indefinitely — which is correct, not a bug: the object is legitimately still needed elsewhere.
- **`orphansSwept` is an explicitly accepted best-effort approximation (resolved by review — documented, not fixed).** See the "Two accepted-and-stated approximations" callout at the top of Task 7. Unlike `retiredSwept` (durable, DB-tracked, listing-confirmed), an orphan has no row to protect from double-counting, so this counter is observability-only.
- **Redis skip-set TTL is a per-identity-SET approximation, not per-member (resolved by review — documented, not fixed).** See the same callout and the updated `recordGcFailedKeys` doc comment in Task 6/7. Accepted because it only ever makes the sweep MORE conservative.
- **Deferred-identity double-counting in `deferredIdentities`.** When BOTH the legacy-helper gate and the unresolved-NULL-rows gate fire for the same identity in the same run, Task 7's caller increments `deferredIdentities` only once (`if (!state.legacyHelper.deferred) deferredIdentities++` guards the second increment) — but it still logs BOTH `reclamation deferred: legacy helper ...` and `identity deferred: N unresolved rows` as separate lines. This is a deliberate choice (both facts are independently true and operationally useful to know) but means the deferred-identity COUNT and the deferred-identity LOG LINE COUNT can differ for a doubly-deferred identity — flag for confirmation if a stricter 1:1 correspondence between the metric and the logs was expected.
- **W01 interface drift risk.** This plan was written against the *assumed* W01 v3 deliverables listed under "Depends on" above, since W01 has not landed in this worktree at plan-authoring time. Every exact name (`resolveMsKnob`, `resolveBackupBaseLeaseMs`, `resolveBackupOrphanManifestMaxAgeMs`, `resolveBackupPublishMarginMs`, `backupSnapshotRetirements` column names, `backup_jobs.storage_identity`/`backup_snapshots.storage_identity` nullability and exact naming) **must be re-verified against W01's actual merged code before Task 1 starts** — if any signature differs, this plan's Task 1/6/7/9 code blocks need matching edits before they'll compile.
- **Migration backfill predicate is untested by this wave.** Spec §3.6 says the migration backfills `backup_snapshots.storage_identity` "only when `backup_configs.updated_at <= backup_snapshots.timestamp`" — that's W01's migration, not this wave's code, but this wave's self-heal logic (Task 7) is the safety net for every row the backfill predicate deliberately leaves NULL. This plan's integration scenarios 6a/6b prove the self-heal mechanism works in isolation (a NULL row inserted directly) but do NOT exercise the actual migration/backfill predicate end-to-end — that boundary is W01's to test, flagged here only so it isn't assumed covered by this wave's suite.
- **`backupRetention.test.ts` exact line numbers and `selectQueue` push counts will drift as Tasks 1-7 compound.** The Ground Truth section's line numbers were re-verified against the current (pre-Task-1) file; each subsequent task's edits shift later line numbers, and Task 7 changes the per-identity query count/order from what Tasks 3/5/6 assumed (see Task 7's header note). Re-grep before each task and re-run the full suite after Task 7 to catch any stale `selectQueue` sequence, rather than trusting a fixed count once Tasks 1-7 start compounding edits within one PR branch.
