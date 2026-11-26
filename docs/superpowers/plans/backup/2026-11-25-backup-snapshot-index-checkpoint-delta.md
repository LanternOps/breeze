---
title: Backup snapshot file index, checkpoint plus delta (#11736 step 2, waves W2 to W5)
anchor_issue: 11736
related: [11745, 11743, 11733, 11209, 11235, 6488, 6464]
baseline_commit: 03c87b9794
status: plan-draft
---

# Backup Snapshot File Index: Checkpoint Plus Delta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An incremental snapshot's file index stores only its differences from one shared full index of its lineage, so a run with K changed files writes about K rows instead of the whole tree. Every reader still sees each retained snapshot's complete, exact tree.

**Architecture:**
- A **checkpoint** is a full entry set owned by a backup lineage, not by a snapshot. It is a small header row (`backup_tree_checkpoints`, with `org_id`) plus its entries (`backup_tree_checkpoint_entries`, parent-join RLS through the header).
- A snapshot in `delta` format points at one checkpoint. Its own `backup_snapshot_files` rows are the entries the checkpoint lacks (adds) and one tombstone row per checkpoint entry its tree lacks. The depth is always 1.
- The one read layer from step 1 (`snapshotIndexEntries`, `apps/api/src/services/backupSnapshotIndexEntries.ts:38`) becomes the effective tree: checkpoint entries not tombstoned by this snapshot, plus this snapshot's adds. No reader changes.
- The hydrator still verifies the whole manifest. When enabled, it loads the entries into a temp table, diffs them against the lineage's newest checkpoint in SQL, and writes either the delta or, past 5% drift, a new checkpoint.
- Legacy `rows` snapshots are read exactly as today, permanently. The agent does not change.

**Tech stack:** TypeScript, Hono, Drizzle (queries only), PostgreSQL 16 with forced RLS (18 also blocking in migration and RLS-coverage jobs), BullMQ cleanup worker, Vitest unit and integration suites.

**Spec:** issue #11736, specifically the design comment (option 4, "checkpoint plus delta") and the decision comment that chose it ("checkpoint plus differences … a new checkpoint is written when the differences reach 5% of the tree"). The step-2 design review's eight recommendations were accepted before this plan and are restated as R1 to R8 below. Step 1 is merged as #11745.

**Baseline.** Written against `origin/main` `03c87b9794`. Every file:line cited was read on that tree. **Each wave's Step 0:** `git fetch origin main`, then check state, not commit subjects:
- `git show origin/main:apps/api/src/services/backupSnapshotIndexEntries.ts | grep -c snapshotIndexEntries` is non-zero (step 1 is in).
- W3, W4 and W5: `git show origin/main:apps/api/src/db/schema/backup.ts | grep -c backupTreeCheckpoints` is non-zero (W2 merged).
- W5: `git show origin/main:apps/api/src/services/backupSnapshotIndexPublish.ts` exists (W4 merged).
- List `apps/api/migrations/` and confirm this plan's migration names still sort last (see Migration slot).

If a check disagrees with what the wave expects, stop and report.

## Accepted recommendations (R1 to R8)

Each is followed by where this plan implements it, or where the code forced a change.

- **R1.** `org_id` lives on a small checkpoint header. Entries sit under it with parent-join RLS, the shape `backup_snapshot_files` has today. Org merge restamps one header row, not 180k entry rows. → W2, Task 1.
- **R2.** Register the header for org cascade, merge and export like `backup_snapshots`. Delete disposition on org move. → W2, Tasks 1 and 3b. The contract tests only admit a delete disposition with an outbound composite org FK, and the code needs five pieces to represent it. See D6.
- **R3.** A delta snapshot is readable only when its checkpoint header is visible and matches the snapshot's org and device. A hidden or mismatched header yields an empty tree, never a partial one. → W3, Task 1.
- **R4.** A `RESTRICT` foreign key from `backup_snapshots` keeps a checkpoint alive. There is no reference count. → W2, Task 1. GC in W4, Task 4.
- **R5.** Lineage key = (org, device, storage identity, config, backup type, key root). Any NULL keeps today's full `rows` format. → W4, Task 1.
- **R6.** The current reader of legacy rows stays permanently. No re-hydrate sweep. → W3, Task 1 (the `rows` leg).
- **R7.** EXPLAIN contract tests cover the keyset page and both authorization reads before the writer is switched on. → W3, Task 3, a W5 prerequisite.
- **R8.** Drop the duplicate `backup_snapshot_files_snapshot_idx` (`apps/api/src/db/schema/backup.ts:533`), whose column leads `backup_snapshot_files_snapshot_source_idx` (`:534`). → W2, Task 2.

## Tenancy shape

- **`backup_tree_checkpoints`: Shape 1, direct `org_id NOT NULL`.** It is auto-discovered by `rls-coverage.integration.test.ts`. Policies use `breeze_has_org_access(org_id)` for all four commands, enabled and forced in the creating migration.
  - **Why `org_id NOT NULL` and not partner-wide.** The partner-wide-first rule (`docs/agents/tenancy-rls.md`) covers config tables: policies, templates, rules, windows, baselines. A checkpoint is none of those. It is derived data, a materialized copy of one device's backup manifest, and is rebuildable from that manifest. It always belongs to exactly one device of exactly one org, like `backup_snapshots`. A partner-owned checkpoint has no meaning.
- **`backup_tree_checkpoint_entries`: parent-join.** RLS is `EXISTS (SELECT 1 FROM backup_tree_checkpoints c WHERE c.id = backup_tree_checkpoint_entries.checkpoint_id AND public.breeze_has_org_access(c.org_id))` for each command. It copies the `backup_snapshot_files` block in `2026-06-23-sec-review-1-fk-child-rls-backstop.sql:166-185`. Register it in `PARENT_FK_JOIN_POLICY_TABLES` (`rls-coverage.integration.test.ts:1271`, next to `:1352`). That test requires the literal `FROM backup_tree_checkpoints` and `breeze_has_org_access` in each policy.
- **`backup_snapshot_files`: unchanged shape.** It gains one nullable column. It has no `org_id` and is in no cascade, merge or export registry, so it needs no export classification. Verified: it appears in none of them.
- **The database enforces org and device coherence, not only the reader.**
  - A snapshot points at its checkpoint through a composite FK, `(file_index_checkpoint_id, org_id, device_id) → backup_tree_checkpoints(id, org_id, device_id)`. A snapshot can therefore never reference, or pin, another org's or another device's checkpoint.
  - This matters because a pin would block that org's erasure under `RESTRICT`, and snapshot UPDATE RLS checks only the snapshot's own `org_id` (`2026-04-11-bucket-a-rls-policies.sql:67-75`).
  - `orgCascadeFkOnDelete.integration.test.ts:76` notes that the catalog test cannot see cross-tenant rows, so W2, Task 1 tests a forged reference directly.
- **Writers run in system context.** The hydrator's publish runs in `withSystemDbAccessContext` (`backupSnapshotFileIndex.ts:686`). GC runs in the cleanup worker's system context. Readers run in the caller's context, so RLS on both new tables is what R3 relies on.

## Global Constraints

- **Rigor: high for W2, W3 and W4** (tenancy tables, migrations, restore-authorization reads). Each task writes its test first and watches it fail. Each wave gets one independent review round. W5 is medium.
- **One PR per wave, base `main`, never stacked.** A PR whose base is not `main` runs no CI. If one is stacked anyway, run `gh workflow run CI --ref <branch>`.
- **The agent does not change.** No file under `agent/` is touched in any wave.
- **Tests.**
  - API unit: `cd apps/api && npx vitest run <exact files…>`. Never `pnpm --filter <pkg> test -- --run <path>`. Path filters are substring matches. A run that reports 0 files did not run.
  - Integration: `pnpm test-stack up` once, then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/<file>`. Afterwards `pnpm test-stack down`, and say so.
  - RLS coverage (own config): `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`.
  - The org-cascade, merge-registry and export-policy suites fail only under **Integration Tests**, never Test API. Run them locally in any wave that touches tenancy.
- **Typecheck.** From the repo root: `NODE_OPTIONS=--max-old-space-size=12288 pnpm exec tsc --build apps/api/tsconfig.tests.json; echo "exit=$?"`. Read the exit code. Never pipe it to `tail`. An OOM is not a pass.
- **Migrations** (`apps/api/migrations/README.md`):
  - Hand-written, idempotent, no inner `BEGIN`/`COMMIT`.
  - Named to sort after the newest committed file.
  - Any file that writes rows elects `SELECT set_config('breeze.scope', 'system', true);` first. W2's files write no rows.
  - After each migration: `pnpm db:migrate && pnpm db:check-drift`, then `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`.
- **DB context.**
  - Never a bare pool in request code.
  - A catch around a query wraps the query in `withDbTransaction`, with the catch outside it.
  - Never start `withDbTransaction` beside siblings in a `Promise.all`.
  - Foreign-key refusals are matched with `isPgForeignKeyViolation` (`@breeze/shared/pgErrors`). PG 18 raises `23001` for `RESTRICT`.
- **Read layer is the only reader.** `backupSnapshotIndexReadPath.contract.test.ts` fails on any read of `backup_snapshot_files` outside `backupSnapshotIndexEntries.ts`. W3 extends it to cover the entries table too.
- **New service files.** Run `src/__tests__/parkedFanout.contract.test.ts`. If it names a new file, classify it as its message says.
- **Public text.** No hostnames, IPs, regions, customer or tenant names. Numbers below are labelled **[issue]** (measured, from the public issue), **[measured-lab]** (from the 2026-11-05 plan's synthetic run), **[derived]** or **[guessed]**.
- **Release notes.** W5 appends one entry under the backup section of `docs/release-notes/next-release-draft.md`. Append only, and rebase just before opening the PR: it is a merge-queue hot spot.

## Verified facts this plan rests on

The design review's "not checked" list, resolved on `03c87b9794`:

1. **`source_path` is not unique within a snapshot.**
   - There is no unique index (`schema/backup.ts:532-539`: three plain indexes).
   - The hydrator's validation pass checks each entry's schema, key and origin but not duplicate paths (`backupSnapshotFileIndex.ts:577-603`).
   - So the delta cannot key on path alone. Tombstones name a checkpoint entry by number, and the diff pairs exact duplicates by ordinal. See D1.
2. **How the org-cascade test treats the FK direction.**
   - `tenantCascade.integration.test.ts:111-155` reads live `pg_constraint` and requires the referencing table to come before the referenced one.
   - `topologicalCascadeOrder()` (`tenantCascade.ts:1641`) computes the real order at runtime. The static list must still be `localeCompare`-sorted with `organizations` last (`:49-58`).
   - `backup_snapshots` references `backup_tree_checkpoints`, which alphabetical order already satisfies. `orgCascadeFkOnDelete.integration.test.ts` rule (d) accepts a `RESTRICT` edge when both ends are in the cascade set.
   - **Device** deletion is an explicit ordered list (`deviceCascadeTables.ts:125`), so the header must be listed after `backup_snapshots` (`:162`).
3. **The 2x disagreement in bytes per row.** It is **not resolved.**
   - The issue's 1.35 GB/day over "~1M rows/day" gives about 1.35 KB/row **[derived]**. The issue's own per-device rates give 1.2 to 1.6M rows/day **[issue]**, which gives 0.84 to 1.1 KB/row **[derived]**.
   - The code comment's "about 145 MB or more per … snapshot" at 250k entries (`backupResultPersistence.ts:894-897`) is 580 B/row. That figure comes from the 2026-11-05 plan: "1.1M rows cost about 578 bytes each including indexes", from synthetic Windows paths on an idle laptop database **[measured-lab]**.
   - Plausible causes, none checked: real paths are longer than synthetic ones; delete-and-reinsert re-hydration leaves dead tuples until autovacuum; the redundant index (R8); and the issue's daily total may include TOAST or WAL.
   - Gate G2 measures it. Nothing in this plan depends on which figure is right: both shrink by the same factor.
4. **Object GC is not affected.**
   - GC marks live keys from each retained snapshot's `manifest.json` (`jobs/backupRetention.ts:1496-1531`), never from this table.
   - Full restore and BMR do not read `backup_snapshot_files` (grep of `routes/backup/bmr.ts` and `dbRestoreJob.ts`).
   - The manifest stays a synthetic full manifest, because the agent is unchanged.
5. **The post-backup verify path reaches the authorization read.**
   - `backup_verify` and `backup_test_restore` are brokered read commands (`services/backupStorageSessions.ts:125-139`).
   - `mint()` calls `countIndexedFiles` (`:883`), and `resolveStorageSessionObjects()` calls `filterIndexedKeys` (`:1175`).
   - The verify worker itself was not traced.
6. **The inline agent-row writer can run on a snapshot that is not `complete`** (`backupResultPersistence.ts:1807`). It deletes the snapshot's rows, inserts agent rows and sets status `agent` (`:1815-1849`).
   - On a `delta` snapshot that an org move reset to `none`, that would leave `delta` format with agent rows treated as adds: a wrong tree. W4, Task 3 resets the format in the same update.
7. **The device org move restamps before it deletes** (`deviceOrgMove/moveDeviceOrgInTransaction.ts:997` restamp loop, `:1090` move-delete loop).
   - A move-delete table must carry an outbound composite `(x, org_id)` FK to a non-device row, or `moveOrg.coverage.test.ts:390-414` fails ("Move them to CORE_DEVICE_ORG_DENORMALIZED_TABLES (restamp)").
   - The database-side restamp (`breeze_device_child_orgid_tables()`, last defined in `2026-12-27-170000-pam-org-move-unactuated-elevation-restamp.sql:44-99`) auto-discovers every public table with both `device_id` and `org_id` columns, minus a name list. See D6.
   - `backup_configs` has no unique key on `(id, org_id)` today. The only `(id, org_id)` mention is a trigger column list in `2026-07-27-a-feature-policy-reference-ownership.sql:525`.
8. **`breeze_app` holds `TEMPORARY`** (`db/ensureAppRole.ts:72-82`). `services/aiChargeback/chargeRun.ts` is the precedent for a temp table inside a request-free transaction.
9. **The newest migration is `2027-01-30-170000-group-membership-log-group-device-index.sql`.**
10. **`breeze_app` does not own the tables, so it cannot ANALYZE them.** Statistics go through a `SECURITY DEFINER` function (`2027-01-22-210200-backup-snapshot-files-analyze.sql`, `backupSnapshotFileIndexStatistics.ts:79`). The entries table needs its own function.

## Decisions taken in this plan

- **D1. Tombstones name a checkpoint entry, not a path.**
  - Each entry has `entry_no`, unique within its checkpoint. A tombstone is a `backup_snapshot_files` row with `checkpoint_entry_no` set to that number.
    - Its `source_path` is copied from the entry, so the anti-join can use the existing `(snapshot_db_id, source_path)` index.
    - Its `backup_path` is `''` and `size`, `modified_at` and `kind` are NULL. A tombstone therefore names no object even if a reader's `checkpoint_entry_no IS NULL` filter were lost: every membership read already excludes `''` (`backupStorageSessionStore.ts:143,215`, `recoveryDownloadService.ts:105`).
  - **A changed file costs two rows:** a tombstone for the old entry plus an add for the new version. Deleted and added files cost one row each.
  - This holds whatever path multiplicity the manifest has (fact 1). It also makes "an overwritten checkpoint key is never authorized" structural: the old entry is excluded by number before any `backup_path` filter applies.
  - It refines the decision comment's "a tombstone row for each checkpoint path that is absent". The read semantics are the same.
  - **Cost:** under churn on disjoint files, the delta reaches 5% about twice as fast as a one-row-per-change design, so checkpoints are rebuilt about twice as often (see Numbers used).
  - **Rejected alternative:** a single "replacement" row that both hides entry N and carries the new version. It needs a further column to tell a pure tombstone from a replacement, and pairing logic in the diff. Revisit it if G2's measured drift shows rebases dominating the rows written.
- **D2. The diff pairs rows by exact tuple and ordinal.**
  - Both sides are numbered with `row_number() OVER (PARTITION BY source_path, backup_path, size, modified_at, kind)` (window partitions treat NULLs as equal).
  - Adds are incoming rows with no checkpoint row of equal tuple and ordinal. Tombstones are checkpoint entries with no incoming row of equal tuple and ordinal.
  - Both are anti-joins (`NOT EXISTS`) keyed on `source_path`, `backup_path` and ordinal, with `IS NOT DISTINCT FROM` on the nullable columns as a join filter. Do not use `FULL JOIN`: Postgres refuses a `FULL JOIN` with a non-hashable condition.
- **D3. The read layer stays one derived table, `UNION ALL` of two legs.** The format is dispatched in SQL, in the same statement as each reader's own state gate, never by a TypeScript pre-read. The checkpoint id is resolved by an **uncorrelated scalar subquery** when `snapshotDbId` is a value. Postgres then runs it once as an InitPlan, and the entries index scan has a constant leading key, so it is ordered by `source_path` without a Sort. A join to the header would give the planner no ordering to use. W3, Task 1 has the shape.
- **D4. Rebase rule.** A new checkpoint is written when the lineage has none, or when `adds + tombstones > ceil(CHECKPOINT_REBASE_RATIO × checkpoint.entry_count)`, where `CHECKPOINT_REBASE_RATIO = 0.05` (from the decision comment). The diff is always against the lineage's newest checkpoint. There is no search for a better one.
- **D5. The writer is behind a flag. The reader is never flagged.**
  - `BACKUP_INDEX_DELTA_PUBLISH` takes `off` (the default until W5), `canary` (only orgs listed in `BACKUP_INDEX_DELTA_PUBLISH_ORG_IDS`) or `on`.
  - With the flag off, the hydrator's pass 2 is today's code path, byte for byte.
  - The reader always understands `delta`, so turning the flag off never strands a snapshot that was already published as a delta.
- **D6. Org-move disposition: delete (R2), made representable.** On a device move, the checkpoint stays behind and is deleted, and the moved snapshots fall back to re-hydration. Five pieces, all in W2:
  1. **A unique key on `backup_configs (id, org_id)`.** The table is small; this is a new unique index.
  2. **The header's config FK is composite:** `(config_id, org_id) → backup_configs(id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`. A backup config is org-owned and stays in the source org, so this FK is what makes a restamp unrepresentable. It is the FK `moveOrg.coverage.test.ts:390-414` asks for. The lineage includes the config anyway (R5).
  3. **The snapshot's pointer FK is composite** (see Tenancy shape): `ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE`, with `UNIQUE (id, org_id, device_id)` on the header.
  4. **The existing tenancy trigger is extended** (`breeze_backup_snapshot_file_index_tenancy_reset()`, `2026-10-31-100700-…-org-move-reset.sql:29`). When a `delta` snapshot's `org_id` or `device_id` changes, the trigger, in the same row update:
     - sets `file_index_format := 'rows'` and `file_index_checkpoint_id := NULL`;
     - deletes that snapshot's `backup_snapshot_files` rows through a new `SECURITY DEFINER` helper, `breeze_backup_snapshot_drop_delta_rows(uuid)`. Without the checkpoint those rows (adds and tombstones) would read as a partial tree.

     Because the new row's pointer is NULL, the composite FK is never checked mid-move (MATCH SIMPLE). Status is already reset to `none` by the same trigger, so the snapshot re-hydrates on its next use, which browse, selection, brokered reads and recovery preflight each request (`backupResultPersistence.ts:892-897`). A `rows` snapshot keeps today's behaviour exactly.
  5. **The header is excluded from the database-side restamp:** `CREATE OR REPLACE` `breeze_device_child_orgid_tables()` with `'backup_tree_checkpoints'` added to its `NOT IN` list. Otherwise a raw `UPDATE devices SET org_id` would restamp it and fail the config FK.
     - **W2 Step 0:** first read how the existing move-delete tables (`topology_device_presence`, `CORE_DEVICE_ORG_MOVE_DELETE_TABLES` in `routes/devices/core.ts:409`) avoid that path, and follow the same mechanism if it differs.
     - On the raw path the header then stays in the source org, unreferenced. GC collects it at once (D8).

  **App move order** (`moveDeviceOrgInTransaction.ts:997` then `:1090`):
  - the restamp loop updates `backup_snapshots`, and the trigger clears the pointers;
  - the move-delete loop then deletes the device's headers, and `RESTRICT` no longer applies;
  - entries go by `ON DELETE CASCADE`.

  **Org merge** repoints headers, configs and snapshots under `SET CONSTRAINTS ALL DEFERRED`. The trigger clears the snapshots' pointers, as it already resets their status. Merged delta snapshots re-hydrate, and they can reuse the repointed header, whose lineage now matches the survivor.

  **Cost against restamp:** a moved device's delta snapshots list as empty until they re-hydrate, where `rows` snapshots keep listing their rows. Restamp was considered first and rejected, because it cannot have the composite pointer FK. A restamped header and its snapshots are updated in separate statements, so an immediate composite FK fails on whichever goes first. That would also break the raw device-move path.
- **D7. Checkpoints are built only from server-verified manifests.**
  - Inline agent rows (status `agent`) always stay in `rows` format. A checkpoint is shared by later snapshots, so unverified agent-reported entries must never reach one.
  - This supersedes the design comment's "Wave 3 routes [inline rows] through the same publisher". Inline rows are bounded at about 9.5k entries **[issue design comment]**, so the saving is small.
- **D8. GC rule.** The GC deletes a header when no snapshot references it **and** one of these holds:
  - it is not the newest header of its lineage; or
  - its `last_referenced_at` is older than `CHECKPOINT_ORPHAN_TTL_MS = 7 days` **[guessed]**. This covers dead lineages: moved devices and replaced configs.

  Other rules:
  - A third case is collectable at once: the header's device no longer exists, or the device's current `org_id` differs from the header's. These are raw-path leftovers (D6).
  - The newest unreferenced header is otherwise kept, so a lineage whose snapshots all retired can still reuse it.
  - **One header per transaction.** Each iteration is its own system transaction: select one candidate `FOR UPDATE SKIP LOCKED LIMIT 1`, delete it, commit. The row lock is held from selection to delete, so no reference can commit in between. A publisher holds `FOR KEY SHARE` on the header it diffs against, and `SKIP LOCKED` passes over it.
  - **The FK-violation catch** sits outside each iteration's transaction. It is defensive: a writer that sets a pointer without the publisher's lock is refused by `RESTRICT` at its own statement, or GC's delete is refused. Either way GC counts it as `refused` and moves on.
- **D9. The delta invariant is checked before publish.** `checkpoint.entry_count − tombstones + adds` must equal the manifest's `eligibleEntries`. A mismatch throws inside the publish transaction, so the previous rows stay, as the current row-count check does (`backupSnapshotFileIndex.ts:837-840`).
- **D10. Moving data between formats is never a migration.** Legacy rows age out through retention, and kept snapshots (legal hold, immutable, pinned, chain base: `backupRetention.ts:330-425`) keep `rows` format forever (R6). A re-hydration (`force`) of a legacy snapshot publishes it in whatever format the flag selects.

## Review Focus

Five conditions no single happy-path test covers, most likely first. Each is pinned to a named test in its owning task.

1. **The header is hidden or mismatched.** RLS hides it from the caller, or its org/device differs after a move that missed it. Expected: browse, search, selection and count see an empty tree, and both authorization reads refuse every key. Never only the delta's adds. Tests: W3 Task 1 `a delta snapshot whose checkpoint is not visible reads as empty, never as its adds`, and `… whose checkpoint names another device …`.
2. **A key the delta replaced is asked for.** Expected: `filterIndexedKeys` and `authorizeExternalReference` refuse the checkpoint's old object for this snapshot. They still grant it for an older snapshot that holds it. Test: W3 Task 2 chain contract in `delta` mode (`brokered key grants … never a replaced, deleted or other-lineage one`), and W4 Task 2 in `publisher` mode.
3. **The manifest has two entries with the same path, or two identical entries.** Expected: the effective tree has the same multiset of rows as a `rows` publish of that manifest. Test: W4 Task 1 `duplicate paths and identical entries round-trip exactly`.
4. **An agent result arrives for a `delta` snapshot that is not `complete`** (fact 6). Expected: the snapshot reads exactly the agent rows (`rows` format, no checkpoint pointer). Test: W4 Task 3 `inline agent rows on a delta snapshot reset it to rows format`.
5. **A device with delta snapshots moves to another org,** through the app route, a raw `UPDATE devices`, or an org merge. Expected:
   - no FK error;
   - the source org keeps no checkpoint of that device;
   - each moved delta snapshot reads as empty (never partial) until it re-hydrates, then reads its full tree;
   - `rows` snapshots read as before.

   Tests: W2 Task 4 `a device org move deletes its checkpoints and resets its delta snapshots`, `a raw UPDATE devices SET org_id leaves no checkpoint readable in either org`, `org merge repoints checkpoints and resets delta snapshots`.

   The GC and publisher race (D8) is pinned in W4 Task 4: `a header held by a publisher survives the sweep`.

## Migration slot

W2 is the only wave with migrations. It adds two files, named to sort after `2027-01-30-170000-…` (the newest on the baseline):
- `2027-01-31-100000-backup-tree-checkpoints.sql`, which is transactional;
- `2027-01-31-100100-backup-index-concurrent-indexes.sql`, which starts with `-- @no-transaction`.

Re-check at W2's Step 0. If newer files exist, move both names past the newest and keep their relative order. W3, W4 and W5 state `Migration slot: none`. Any part that finds it needs one stops and raises it.

## Wave map

| Wave | Ships | Depends on | Migration | Runs parallel with |
|---|---|---|---|---|
| W2 | Tables, RLS, registrations, snapshot and tombstone columns, index changes. No writers. | step 1 (merged) | yes (2 files) | nothing |
| W3 | Delta leg in the read layer, chain fixtures, EXPLAIN contract tests | W2 merged | none | W4 (file-disjoint) |
| W4 | Publisher, inline-writer reset, GC sweep, `BACKUP_INDEX_DELTA_PUBLISH` (off) | W2 merged. Its last task needs W3 merged. | none | W3 |
| W5 | Default `on` (with kill switch), metrics, 1M-entry perf acceptance, docs and release note | W3 and W4 merged, gates G2 to G4 | none | nothing |

---

## W2: Schema, RLS and registrations

**Goal:** The tables and columns exist, are tenant-isolated, are registered in every cascade, merge, move and export list, and carry nothing: no code writes them yet. The redundant index is gone.

### File ownership (W2)

- Create: `apps/api/migrations/2027-01-31-100000-backup-tree-checkpoints.sql`
- Create: `apps/api/migrations/2027-01-31-100100-backup-index-concurrent-indexes.sql`
- Modify: `apps/api/src/db/schema/backup.ts` (new tables, two `backup_snapshots` columns, one `backup_snapshot_files` column, `backup_configs (id, org_id)` unique, composite FKs, remove `snapshotIdx`)
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`, `:262`)
- Modify: `apps/api/src/services/orgMergeRegistry.ts` (repoint block, `:941-945`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`backup_snapshots` at `:288`, plus a new header entry)
- Modify: `apps/api/src/services/deviceCascadeTables.ts` (`:160-162`)
- Modify: `apps/api/src/routes/devices/core.ts` (`DEVICE_ORG_DENORMALIZED_TABLES` at `:261`, `CORE_DEVICE_ORG_MOVE_DELETE_TABLES` at `:409`)
- Modify: `apps/api/src/services/deviceInstallBoundary/classification.ts` (`:133`)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`PARENT_FK_JOIN_POLICY_TABLES`, `:1352`)
- Create: `apps/api/src/__tests__/integration/backupTreeCheckpointsTenancy.integration.test.ts`

### Execution split and parallelism (W2)

- **Group A (serial, Opus):** Tasks 1, 1b and 2. All of them own `schema/backup.ts`, and every later task needs the schema.
- **Group B (parallel after A, file-disjoint):**
  - Task 3a (Sonnet, mechanical): `tenantCascade.ts`, `orgMergeRegistry.ts`, `tenantExportPolicyRegistry.ts`.
  - Task 3b (Sonnet, mechanical): `deviceCascadeTables.ts`, `routes/devices/core.ts`, `deviceInstallBoundary/classification.ts`.
  - Task 4 (Opus): `rls-coverage.integration.test.ts` and the new tenancy integration test.
- **Group C (serial):** Task 5, the full contract run and the PR.

### Task 1: Tables, columns and RLS (transactional migration)

**Files:** `apps/api/migrations/2027-01-31-100000-backup-tree-checkpoints.sql`, `apps/api/src/db/schema/backup.ts`. Test: `backupTreeCheckpointsTenancy.integration.test.ts` (its RLS cases; Task 4 completes the file).

**Interfaces (produces):**
- `backupTreeCheckpoints` (`backup_tree_checkpoints`) columns:
  - `id uuid PK default gen_random_uuid()`
  - `org_id uuid NOT NULL → organizations(id)`
  - `device_id uuid NOT NULL → devices(id)`
  - `config_id uuid NOT NULL`, with the composite `backup_tree_checkpoints_config_org_fk (config_id, org_id) → backup_configs(id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE` (Task 1b)
  - `storage_identity text NOT NULL`
  - `backup_type backup_type NOT NULL` (the existing enum)
  - `key_layout text NOT NULL`
  - `key_prefix text NULL`
  - `entry_count integer NOT NULL CHECK (entry_count >= 0)`
  - `source_snapshot_db_id uuid NULL`: provenance, a plain uuid, not an FK, because the source snapshot retires independently
  - `source_manifest_sha256 text NOT NULL`
  - `created_at timestamptz NOT NULL default now()`
  - `last_referenced_at timestamptz NOT NULL default now()`
  - Index `backup_tree_checkpoints_lineage_idx ON (device_id, config_id, storage_identity, created_at DESC)`, plus `backup_tree_checkpoints_org_id_idx`. Unique `backup_tree_checkpoints_id_org_device_uq (id, org_id, device_id)` is the target of the snapshot pointer FK.
- `backupTreeCheckpointEntries` (`backup_tree_checkpoint_entries`) columns:
  - `checkpoint_id uuid NOT NULL → backup_tree_checkpoints(id) ON DELETE CASCADE`
  - `entry_no integer NOT NULL`
  - `source_path text NOT NULL`
  - `backup_path text NOT NULL`
  - `size bigint NULL`
  - `modified_at timestamp NULL` (without time zone, as `backup_snapshot_files.modified_at`)
  - `kind text NULL`, typed `SnapshotEntryKind`
  - PK `(checkpoint_id, entry_no)`. Indexes `backup_tree_checkpoint_entries_checkpoint_source_idx (checkpoint_id, source_path)` and `backup_tree_checkpoint_entries_checkpoint_backup_path_idx (checkpoint_id, backup_path)`.
  - No `id`, no `created_at`: fewer bytes per entry.
- `backup_snapshots` gains:
  - `file_index_format text NOT NULL DEFAULT 'rows'`, with `backup_snapshots_file_index_format_chk CHECK (file_index_format IN ('rows','delta'))`;
  - `file_index_checkpoint_id uuid NULL`, with `backup_snapshots_file_index_checkpoint_fk FOREIGN KEY (file_index_checkpoint_id, org_id, device_id) REFERENCES backup_tree_checkpoints(id, org_id, device_id) ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE`. It is composite so that a snapshot can only reference its own org's and device's checkpoint (Tenancy shape). It is `MATCH SIMPLE`, so a NULL pointer is never checked;
  - `backup_snapshots_file_index_checkpoint_chk CHECK ((file_index_format = 'delta') = (file_index_checkpoint_id IS NOT NULL))`.
- `backup_snapshot_files` gains `checkpoint_entry_no integer NULL`. NULL means an entry of this snapshot; non-NULL means a tombstone of that checkpoint entry.
- `public.breeze_analyze_backup_tree_checkpoint_entries()`: `SECURITY DEFINER`, pinned `search_path`, `EXECUTE` granted to `breeze_app` and revoked from `PUBLIC`. Copy the body and grants of `breeze_analyze_backup_snapshot_files()` from `2027-01-22-210200-backup-snapshot-files-analyze.sql`.
- RLS: header Shape 1 (copy the `backup_snapshots` policy names and shape); entries parent-join (see Tenancy shape). Both `ENABLE` and `FORCE`.

- [ ] **Step 1: Write the failing tests** in `backupTreeCheckpointsTenancy.integration.test.ts`:
  - `an org-scoped caller sees only its own checkpoints and their entries`: seed headers plus entries in orgs A and B as admin. In `withDbAccessContext` for A, select both tables. Expect only A's rows.
  - `breeze_app cannot insert a checkpoint or an entry under another org`: forge as A an insert of a header with `org_id = B`, and an entry under B's header. Expect `new row violates row-level security policy`.
  - `a snapshot cannot point at a missing checkpoint`: set `file_index_checkpoint_id` to a random uuid. Expect an FK violation (`isPgForeignKeyViolation`).
  - `a referenced checkpoint cannot be deleted`: delete a header that a snapshot references. Expect an FK violation (23503 on PG 16, 23001 on PG 18; match through `FOREIGN_KEY_VIOLATION_SQLSTATES`).
  - `format and pointer agree`: setting `file_index_format = 'delta'` with a NULL pointer, or `'rows'` with a pointer, fails `backup_snapshots_file_index_checkpoint_chk`.
  - `deleting a config deletes its unreferenced checkpoints and their entries`.
  - `a snapshot cannot point at another org's or another device's checkpoint`: as admin, set a snapshot in org A to point at org B's header, then at a header of another device in org A. Expect FK violations both times.
  - `org B's erasure is never blocked by a reference from org A`: follows from the previous test. Run the org-B cascade after the refused forge and expect success.
- [ ] **Step 2: Run them and see them fail** (`relation "backup_tree_checkpoints" does not exist`):
  `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/backupTreeCheckpointsTenancy.integration.test.ts`
- [ ] **Step 3: Write the migration and the Drizzle schema.**
  - Every object is idempotent: `IF NOT EXISTS`, `DROP POLICY IF EXISTS` then `CREATE`, and constraints added in `DO $$ … IF NOT EXISTS (SELECT 1 FROM pg_constraint …) $$`.
  - Grants follow the newest table-creating migration's pattern.
  - Composite FKs are declared in the table's extra config with `foreignKey({ columns, foreignColumns }).onDelete(...)`. `moveOrg.coverage.test.ts` reads them from Drizzle, so they must be declared there, not only in SQL. The CHECKs go there too, so `db:check-drift` agrees.
- [ ] **Step 4: Run** `pnpm db:migrate && pnpm db:check-drift`, then the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): checkpoint header and entry tables for the snapshot file index (#11736)`.

### Task 1b: Move and merge coherence (same migration file)

**Files:** the Task 1 migration and `schema/backup.ts`. Serial after Task 1.

**Interfaces (produces):**
- `backup_configs_id_org_uq UNIQUE (id, org_id)` on `backup_configs`, declared in Drizzle as well.
- The header's composite config FK (Task 1 columns).
- `public.breeze_backup_snapshot_drop_delta_rows(p_snapshot_id uuid) RETURNS void`, with these properties:
  - `SECURITY DEFINER` and a pinned `search_path`;
  - it deletes `backup_snapshot_files` rows of that one snapshot;
  - `EXECUTE` is revoked from `PUBLIC` and not granted to `breeze_app`, because only the trigger calls it.
- `breeze_backup_snapshot_file_index_tenancy_reset()`, replaced with the same body plus one more branch. When `OLD.file_index_format = 'delta'`:
  - set `NEW.file_index_format := 'rows'` and `NEW.file_index_checkpoint_id := NULL`;
  - `PERFORM public.breeze_backup_snapshot_drop_delta_rows(NEW.id)`.

  The trigger definition (`BEFORE UPDATE OF org_id, device_id … WHEN …`) is unchanged.
- `breeze_device_child_orgid_tables()`, replaced with its current body (re-read the newest definition at Step 0; on the baseline it is `2026-12-27-170000-…:44-99`) plus `'backup_tree_checkpoints'` in the `NOT IN` list. The comment in that list says why: the header names a source-org config and is deleted by the app move, or collected by GC on the raw path.

- [ ] **Step 0:** read how `topology_device_presence` and `device_network_isolations` (`routes/devices/core.ts:409-420`) avoid the raw-path restamp. If they use a mechanism other than the `NOT IN` list, follow theirs and say so in the PR.
- [ ] **Step 1: Write the failing tests** (in the tenancy file):
  - `moving a delta snapshot's org resets it to rows and drops its delta rows`;
  - `moving a rows snapshot keeps its rows` (today's behaviour);
  - `backup_tree_checkpoints is not in breeze_device_child_orgid_tables()`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement it in the migration and the schema.**
- [ ] **Step 4:** `pnpm db:migrate && pnpm db:check-drift`, the tenancy file, and `src/__tests__/integration/backupSnapshotOriginsOrgMove.integration.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): checkpoint references stay within one org and device across moves (#11736)`.

### Task 2: Index changes (no-transaction migration)

**Files:** `apps/api/migrations/2027-01-31-100100-backup-index-concurrent-indexes.sql`, `apps/api/src/db/schema/backup.ts` (remove `snapshotIdx` at `:533`; add `fileIndexCheckpointIdx`).

The file's first line is `-- @no-transaction`. Each statement is sent on its own and writes no rows:
- `DROP INDEX CONCURRENTLY IF EXISTS backup_snapshot_files_snapshot_idx;` (R8). The FK cascade from `backup_snapshots` and every reader still have `backup_snapshot_files_snapshot_source_idx`, whose leading column is the same.
- `CREATE INDEX CONCURRENTLY IF NOT EXISTS backup_snapshots_file_index_checkpoint_idx ON backup_snapshots (file_index_checkpoint_id) WHERE file_index_checkpoint_id IS NOT NULL;`. It serves the `RESTRICT` check and GC's "no snapshot references it" probe.
- No new index on `backup_snapshot_files`: the tombstone anti-join uses `(snapshot_db_id, source_path)` (D1).

- [ ] **Step 1: Write the failing test** `the duplicate snapshot index is gone and the checkpoint pointer is indexed` (in the tenancy integration file): query `pg_indexes`. Expect no `backup_snapshot_files_snapshot_idx`, and expect `backup_snapshots_file_index_checkpoint_idx` to be present.
- [ ] **Step 2: Run it and see it fail.**
- [ ] **Step 3: Write the migration and the schema change.**
- [ ] **Step 4:** `pnpm db:migrate && pnpm db:check-drift`, the test, and `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `perf(api): drop the duplicate snapshot-files index; index the checkpoint pointer (#11736)`.

### Task 3a: Org cascade, merge and export registrations (Sonnet)

- `tenantCascade.ts` `CORE_ORG_CASCADE_DELETE_ORDER`: add `'backup_tree_checkpoints'` at its `localeCompare` position, between `'backup_storage_sessions'` and `'backup_verifications'` (`:492-500`). Do not add the entries table: it has no `org_id` and rides `ON DELETE CASCADE`.
- `orgMergeRegistry.ts`: add `"backup_tree_checkpoints"` to the repoint block after `"backup_snapshots"` (`:945`), with the comment `// Derived file-index checkpoint of a device's backups; moves with its snapshots (#11736).`
- `tenantExportPolicyRegistry.ts`:
  - Add `"file_index_format"` and `"file_index_checkpoint_id"` to `backup_snapshots.included`.
  - Add `"backup_tree_checkpoints": tablePolicy("org_id", { included: [every column above], reviewedIncluded: [], excludedSensitive: [], excludedOpen: [] })`.
  - No json or bytea columns exist. `source_manifest_sha256` follows `file_index_manifest_sha256`, which is already `included`. If `SUSPICIOUS_NAME_PARTS` flags either one, move both to `reviewedIncluded`.
- Tests: `cd apps/api && npx vitest run src/services/tenantCascade.test.ts src/services/tenantExportPolicy.test.ts src/services/orgMerge.test.ts`. The integration side runs in Task 5.
- Commit: `chore(api): register the checkpoint header for org cascade, merge and export (#11736)`.

### Task 3b: Device cascade, move and install-boundary registrations (Sonnet)

- `deviceCascadeTables.ts`: insert `'backup_tree_checkpoints'` immediately **after** `'backup_snapshots'` (`:162`). `RESTRICT` means the referencing snapshots must go first.
- `routes/devices/core.ts`: this is the delete disposition (D6).
  - Add `'backup_tree_checkpoints'` to `DEVICE_ORG_DENORMALIZED_TABLES`, the coverage list, next to `'backup_snapshots'` (`:261`).
  - **And** add it to `CORE_DEVICE_ORG_MOVE_DELETE_TABLES` (`:409`), with the comment: `// #11736: (config_id, org_id) names a SOURCE-org backup config, so a restamp would 23503; the device's moved snapshots re-hydrate and build a new checkpoint in the target org.`
  - `moveOrg.coverage.test.ts:390-414` passes because of Task 1b's composite config FK.
- `deviceInstallBoundary/classification.ts`: `backup_tree_checkpoints: history('file-index checkpoint of the device\'s snapshots (#11736)')`, next to `backup_snapshots` (`:133`).
- Tests: `cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts src/services/deviceInstallBoundary/deviceInstallBoundary.test.ts src/services/deviceInstallBoundary/orgMoveParity.test.ts`. Expected: PASS. A red names the list it wants.
- Commit: `chore(api): register the checkpoint header for device delete and move (#11736)`.

### Task 4: RLS coverage entry and tenancy lifecycle tests (Opus)

- `rls-coverage.integration.test.ts`: add `['backup_tree_checkpoint_entries', ['backup_tree_checkpoints']]` after `:1353`.
- Add to `backupTreeCheckpointsTenancy.integration.test.ts`:
  - `org erasure deletes snapshots, their delta rows, checkpoints and entries`: run the org cascade delete for a seeded org whose snapshot points at a checkpoint. Expect no rows left in any of the four tables for that org, and no FK error.
  - `device deletion deletes the device's checkpoints after its snapshots`: run the device cascade, then expect both gone.
  - `a device org move deletes its checkpoints and resets its delta snapshots`. Move through the app route's transaction (`moveDeviceOrgInTransaction`), then check:
    - there is no FK error;
    - no header of that device exists in either org;
    - the snapshots are in the target org with `file_index_format = 'rows'`, a NULL pointer, no rows, and status `none`.
  - `a raw UPDATE devices SET org_id leaves no checkpoint readable in either org`: the DB-side `breeze_device_child_orgid_tables()` path. Expect no 23503. The header stays in the source org, unreferenced, and the moved snapshots are reset as above. W4's GC later deletes the header.
  - `org merge repoints checkpoints and resets delta snapshots`: run the merge engine on two orgs. Expect the header in the survivor and the merged delta snapshots reset.
- Red: run before the `rls-coverage` entry exists, and expect the classification test to fail with the unregistered table:
  `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`. The lifecycle cases are red until Tasks 3a and 3b are merged into the branch.
- Green: the same command, and `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/backupTreeCheckpointsTenancy.integration.test.ts`.
- Commit: `test(api): tenancy contract for the snapshot index checkpoint tables (#11736)`.

### Task 5: Full contract run and PR

- [ ] Run each of these and record the pass lines in the PR:
  - `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/backupSnapshotOriginsOrgMove.integration.test.ts src/__tests__/integration/backupSnapshotIndexChain.integration.test.ts src/__tests__/integration/backupTreeCheckpointsTenancy.integration.test.ts`
  - `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`
  - `cd apps/api && npx vitest run src/__tests__/backupSnapshotIndexReadPath.contract.test.ts src/services/backupSnapshotBrowse.test.ts src/services/backupSnapshotFileIndex.test.ts`. These are unchanged, and nothing should read differently.
  - The typecheck command (Global Constraints).
- [ ] The PR body states: tenancy shape and the `org_id NOT NULL` justification; D6 (delete disposition, composite FKs, trigger extension) with gate G1; `Migration slot: 2 files`; "no writer, no reader change"; `Refs #11736`.

**W2 acceptance:**
- Both migrations apply on a fresh database and re-apply as a no-op.
- `db:check-drift` is clean.
- Every contract suite listed above passes.
- Nothing writes or reads the new tables or columns.

**W2 rollback:**
- Revert the PR's code. The migrations are shipped and immutable, and every object they add is unused, so leaving them is safe.
- If the design is abandoned, a later migration drops the two tables and three columns.
- Re-creating the dropped index, if ever needed, is `CREATE INDEX CONCURRENTLY` in a new `@no-transaction` file.

---

## W3: The delta leg of the read layer, fixtures and plans

**Goal:** Every reader returns the exact tree of a `delta` snapshot, and its plans are index ranges, proven before any writer exists.

### File ownership (W3)

- Modify: `apps/api/src/services/backupSnapshotIndexEntries.ts`
- Modify: `apps/api/src/services/backupStorageSessionStore.ts` (extract and export `indexedKeysQuery`, used by `filterIndexedKeys`)
- Modify: `apps/api/src/services/recoveryDownloadService.ts` (extract and export `referenceMembershipQuery`)
- Modify: `apps/api/src/__tests__/backupSnapshotIndexReadPath.contract.test.ts`
- Modify: `apps/api/src/__tests__/integration/backupSnapshotIndexChain.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/helpers/backupIndexFixtures.ts`
- Create: `apps/api/src/__tests__/integration/backupSnapshotIndexPlans.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/backupSnapshotIndexDeltaGate.integration.test.ts`

No file overlaps W4.

### Execution split and parallelism (W3)

- **Group A (parallel):**
  - Task 2a (Sonnet): `helpers/backupIndexFixtures.ts`.
  - Task 4 (Sonnet, mechanical): read-path contract test extension.
- **Group B (after 2a):**
  - Task 1 (Opus): read layer plus the gate test.
  - Task 2b (Opus): parameterize the chain test. It is file-disjoint from Task 1 and runs red until Task 1 lands.
- **Group C (after Task 1):** Task 3 (Opus): query extraction plus the EXPLAIN contract.
- **Group D:** verification and PR.

### Task 1: `snapshotIndexEntries` reads both formats

**Interfaces:** the signature is unchanged: `snapshotIndexEntries(snapshotDbId: string | AnyPgColumn | SQL)`. It is still aliased `snapshot_index_entries`, with the same six columns. Readers do not change.

The shape, rendered with Drizzle `sql` plus aliased tables. Use `alias(backupSnapshots, 'sie_snapshot')` and `alias(backupSnapshotFiles, 'sie_tombstone')`, because outer statements already join `backup_snapshots` (`backupStorageSessionStore.ts:208`, `recoveryDownloadService.ts:99`):

```sql
( SELECT f.snapshot_db_id, f.source_path, f.backup_path, f.size, f.modified_at, f.kind
    FROM backup_snapshot_files f
   WHERE f.snapshot_db_id = :id
     AND f.checkpoint_entry_no IS NULL
     AND EXISTS (SELECT 1 FROM backup_snapshots g
                  WHERE g.id = :id
                    AND (g.file_index_format = 'rows'
                         OR EXISTS (SELECT 1 FROM backup_tree_checkpoints c
                                     WHERE c.id = g.file_index_checkpoint_id
                                       AND c.org_id = g.org_id AND c.device_id = g.device_id)))
  UNION ALL
  SELECT :id, e.source_path, e.backup_path, e.size, e.modified_at, e.kind
    FROM backup_tree_checkpoint_entries e
   WHERE e.checkpoint_id = (SELECT c.id FROM backup_snapshots g
                              JOIN backup_tree_checkpoints c
                                ON c.id = g.file_index_checkpoint_id
                               AND c.org_id = g.org_id AND c.device_id = g.device_id
                             WHERE g.id = :id AND g.file_index_format = 'delta')
     AND NOT EXISTS (SELECT 1 FROM backup_snapshot_files t
                      WHERE t.snapshot_db_id = :id
                        AND t.source_path = e.source_path
                        AND t.checkpoint_entry_no = e.entry_no)
) AS snapshot_index_entries
```

Notes for the implementer:
- `:id` is the argument, a value or a correlated column. The second leg's `snapshot_db_id` output is `:id` cast to `uuid`, so the readers' `innerJoin(backupSnapshots, eq(backupSnapshots.id, entries.snapshotDbId))` keeps working.
- RLS on the header and entries runs in the caller's context. A header the caller cannot see makes the scalar subquery NULL and the first leg's gate false, so the result is empty (R3).
- Update the file's doc comment. It currently says the source "is a plain filtered select". Name the two legs, R3, and D3's InitPlan reason.

- [ ] **Step 1: Write the failing tests** in `backupSnapshotIndexDeltaGate.integration.test.ts`. Seed with Task 2a's `seedDeltaIndex`:
  - `a delta snapshot reads checkpoint entries it does not tombstone plus its adds`: browse root, search, selection and `countIndexedFiles` all equal the expected tree.
  - `a delta snapshot whose checkpoint is not visible reads as empty, never as its adds`. After W2 the composite FK makes this state unseedable at rest. It does exist inside an org merge, which runs with constraints deferred. Reproduce it the same way, in one transaction that rolls back:
    - `SET CONSTRAINTS ALL DEFERRED`;
    - as admin, move the header to org B;
    - switch to the `breeze_app` request context for org A (the role and context helpers the RLS integration suites use);
    - run every reader. Expect each to be empty, and both authorization reads to refuse an add's key and a checkpoint key.
  - `a delta snapshot whose checkpoint names another device reads as empty`: the same deferred-transaction technique, changing the header's `device_id` to another device of the same org.
  - `a rows snapshot ignores stray tombstone rows`: a `rows` snapshot with a `checkpoint_entry_no` row reads without it.
  - `a tombstone in one snapshot never hides an entry in another snapshot of the same checkpoint`.
- [ ] **Step 2: Run them and see them fail.** The current layer returns the adds and the tombstones as rows:
  `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/backupSnapshotIndexDeltaGate.integration.test.ts`
- [ ] **Step 3: Implement the shape above in `backupSnapshotIndexEntries.ts`.**
- [ ] **Step 4: Run the Step 2 command and `backupSnapshotIndexChain.integration.test.ts`, `backupSnapshotBrowse.integration.test.ts`, `backupSnapshotSearchAndSelection.integration.test.ts`, `backupSnapshotContentlessEntries.integration.test.ts` and `backupIndexAttestationBinding.integration.test.ts`** (same `--config`). Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): the snapshot index read layer resolves checkpoint plus delta (#11736)`.

### Task 2a: Chain fixtures seeded directly (Sonnet)

`helpers/backupIndexFixtures.ts` exports these:
- `type IndexEntry = { sourcePath: string; backupPath: string; size: number | null; modifiedAt: string | null; kind: SnapshotEntryKind | null }`. This is the chain test's `Entry` type, moved here.
- `seedRowsIndex(snapshotDbId: string, entries: IndexEntry[], digest: string): Promise<void>`: today's `publishIndex` body (`backupSnapshotIndexChain.integration.test.ts:74-87`).
- `seedCheckpoint(t: { orgId: string; deviceId: string; configId: string; storageIdentity: string }, entries: IndexEntry[]): Promise<string>`: inserts a header and entries numbered `1…n` in the given order, and returns the header id.
- `seedDeltaIndex(snapshotDbId: string, checkpointId: string, checkpointEntries: IndexEntry[], tree: IndexEntry[], digest: string): Promise<void>`: computes adds and tombstones in TypeScript with D2's multiset rule, writes them, then sets `file_index_format = 'delta'`, the pointer, `complete` and the digest in one statement.

Everything is written with the admin connection, like the existing helper. Unit-test the TypeScript diff in the same PR as `helpers/backupIndexFixtures.test.ts`: duplicates, an identical pair, a changed size, a removal, a re-add. Run it with `cd apps/api && npx vitest run src/__tests__/integration/helpers/backupIndexFixtures.test.ts`. Check the vitest include globs. If unit config excludes `__tests__/integration/**`, run it under `--config vitest.integration.config.ts`.

### Task 2b: The chain contract runs in both formats

- Replace `publishIndex` with a mode switch. Wrap both top-level `describe`s (`:198`, `:307`) in `describe.each(['rows', 'delta'] as const)`.
- In `delta` mode, the first (full) snapshot's tree becomes the lineage checkpoint. Every snapshot, the full one included, is then published with `seedDeltaIndex` against it. The full one's delta is empty.
- Keep every existing assertion unchanged: they are the contract.
- Red: before Task 1 lands, `delta` mode fails (`brokered key grants … never a replaced …` grants a replaced key). Green: after Task 1.
- Command: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/backupSnapshotIndexChain.integration.test.ts`

### Task 3: EXPLAIN contract on the keyset page and both authorization reads (R7)

- Extract the two authorization statements, unexecuted, the way `readableSourcePathPageQuery` already is (`backupSnapshotBrowse.ts:184`):
  - `indexedKeysQuery(snapshotDbId: string, keys: string[], boundManifestSha256: string | null, executor: Executor = db)` in `backupStorageSessionStore.ts`. `filterIndexedKeys` then becomes `(await indexedKeysQuery(...)).map(...)`.
  - `referenceMembershipQuery(snapshotDbId: string, key: string, boundDigest: string | null, executor = db)` in `recoveryDownloadService.ts`, used at `:96`.
  - Behaviour is unchanged. The existing unit tests (`recoveryDownloadService.test.ts`, the storage-session tests) must stay green untouched.
- In `backupSnapshotIndexPlans.integration.test.ts`:
  - Seed one lineage: a checkpoint of **50,000** entries **[guessed: enough for the planner to prefer the index]** under 500 directories, and a delta snapshot with 2% adds and 2% tombstones.
  - Refresh statistics through both analyze functions.
  - Then EXPLAIN (FORMAT JSON) each statement **inside `withDbAccessContext` for the snapshot's org**, so RLS policies are in the plan.
  - `the selection keyset page reads both legs as ordered index ranges`. The plan JSON must have:
    - `"Index Name":"backup_tree_checkpoint_entries_checkpoint_source_idx"` and `"Index Name":"backup_snapshot_files_snapshot_source_idx"`;
    - no `"Node Type":"Seq Scan"` on either table;
    - no `"Node Type":"Sort"` (the Merge Append or Append under Limit must already be ordered). If Postgres chooses Append plus Sort over the small adds leg only, accept a Sort whose subtree reads only `backup_snapshot_files`, and say so in the test.
  - `brokered key membership is an index lookup on both legs`: `indexedKeysQuery` with 100 keys uses `backup_tree_checkpoint_entries_checkpoint_backup_path_idx` and `backup_snapshot_files_snapshot_backup_path_idx`, with no Seq Scan.
  - `recovery-download membership is an index lookup on both legs`: same, for `referenceMembershipQuery`.
  - `the rows format plans are unchanged`: the same three statements on a `rows` snapshot use the step-1 indexes with no Seq Scan.
- Match node types and index names, never cost numbers or text layout (Postgres 16, 17 and 18 differ).
- Red: run before Task 1 is on the branch. The entries index is absent from every plan. Green after.
- Command: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/backupSnapshotIndexPlans.integration.test.ts`

### Task 4: The read-path contract covers the entries table (Sonnet)

- In `backupSnapshotIndexReadPath.contract.test.ts`, generalize the detector to a list of tables: `backupSnapshotFiles`/`backup_snapshot_files` and `backupTreeCheckpointEntries`/`backup_tree_checkpoint_entries`.
  - The read layer and the schema stay allowlisted.
  - Writers stay allowed by the existing write-shape rule.
  - W4's publisher and GC files are not allowlisted. They write with `INSERT INTO … SELECT`, which the rule allows, and any other read they need goes through a reviewed allowlist entry added in W4.
- Add detector cases: a Drizzle select from `backupTreeCheckpointEntries` and a raw `JOIN backup_tree_checkpoint_entries` are reported.
- Red: the new detector cases fail before the change. Command: `cd apps/api && npx vitest run src/__tests__/backupSnapshotIndexReadPath.contract.test.ts`

**W3 acceptance:**
- The chain contract is green in both modes. The gate tests and the EXPLAIN contract are green.
- Every step-1 integration suite is unchanged and green.
- Typecheck exit 0.
- Production reads are unchanged, because no `delta` snapshot exists yet.

**W3 rollback:**
- Revert the PR. This is safe while no snapshot is in `delta` format: `SELECT count(*) FROM backup_snapshots WHERE file_index_format = 'delta'` is 0.
- After W5 has published deltas, W3 must not be reverted. Use W5's rollback instead.

---

## W4: Publisher, inline reset, GC and flag (off)

**Goal:** With the flag on, a verified hydration writes a delta or a new checkpoint whose effective tree equals the manifest. Unused checkpoints are collected. With the flag off, nothing changes.

### File ownership (W4)

- Create: `apps/api/src/services/backupSnapshotIndexPublish.ts` (lineage key, temp-table load, diff, rebase, publish)
- Create: `apps/api/src/services/backupSnapshotIndexPublish.test.ts`
- Create: `apps/api/src/services/backupTreeCheckpointGc.ts`, `apps/api/src/services/backupTreeCheckpointGc.test.ts`
- Create: `apps/api/src/services/backupIndexDeltaFlag.ts` and `.test.ts` (`resolveDeltaPublishMode(orgId: string): 'rows' | 'delta'`)
- Modify: `apps/api/src/services/backupSnapshotFileIndex.ts` (pass 2 at `:798-840`, and the final update at `:850-863`)
- Modify: `apps/api/src/services/backupResultPersistence.ts` (inline writer at `:1807-1849`)
- Modify: `apps/api/src/services/backupSnapshotFileIndexStatistics.ts` (an entries variant)
- Modify: `apps/api/src/jobs/backupSnapshotCleanupWorker.ts` (call GC after `processCleanupExpiredSnapshots`, `:174`)
- Create: `apps/api/src/__tests__/integration/backupSnapshotIndexPublish.integration.test.ts`
- Modify: `.env.example` (the two flag variables, commented, default off)

No file overlaps W3. Task 6 reads W3's fixtures and needs W3 merged.

### Execution split and parallelism (W4)

- **Group A (parallel):**
  - Task 5 (Sonnet): the flag module.
  - Task 3 (Sonnet, small): inline reset in `backupResultPersistence.ts`.
- **Group B (serial, Opus):**
  - Task 1: the publisher.
  - Task 2: the hydrator wiring plus statistics. It depends on Task 1's interface.
- **Group C (parallel with B after Task 1's interface is fixed):** Task 4 (Opus): GC plus worker wiring.
- **Group D:** Task 6, the round trip through the readers. It runs after rebasing on merged W3.

### Task 1: The publisher

**Interfaces (produces), in `backupSnapshotIndexPublish.ts`:**
- `export const CHECKPOINT_REBASE_RATIO = 0.05;`
- `export type LineageKey = { orgId: string; deviceId: string; configId: string; storageIdentity: string; backupType: string; keyLayout: string; keyPrefix: string | null };`
- `export function lineageKeyOf(snapshot: { orgId: string; deviceId: string; configId: string | null; storageIdentity: string | null; backupType: string | null; keyLayout: string; keyPrefix: string | null }): LineageKey | null`. It returns `null` when `configId`, `storageIdentity` or `backupType` is NULL (R5). Any NULL means `rows`.
- `export async function createIncomingIndexTable(tx: Tx): Promise<void>`: `CREATE TEMP TABLE snapshot_index_incoming (source_path text NOT NULL, backup_path text NOT NULL, size bigint, modified_at timestamp, kind text) ON COMMIT DROP`.
- `export async function loadIncomingBatch(tx: Tx, batch: FileRowJson[]): Promise<number>`: the same `json_to_recordset` statement as `backupSnapshotFileIndex.ts:810-815`, into the temp table. Returns the database's row count.
- `export type PublishedIndex = { format: 'delta'; checkpointId: string; checkpointWritten: boolean; adds: number; tombstones: number; checkpointEntries: number }`.
- `export async function publishDeltaIndex(tx: Tx, args: { snapshotDbId: string; lineage: LineageKey; manifestSha256: string; eligibleEntries: number }): Promise<PublishedIndex>`. Precondition: the caller has deleted the snapshot's previous `backup_snapshot_files` rows and filled the temp table.

The algorithm (`publishDeltaIndex`), all on `tx`:
1. `ANALYZE snapshot_index_incoming`. Temp tables are never autovacuumed, and the session owns this one.
2. `SELECT pg_advisory_xact_lock(hashtextextended('backup_tree_lineage:' || <lineage fields joined by '|', NULL as ''>, 0))`. Lock order is snapshot row (taken by the caller at `backupSnapshotFileIndex.ts:686-700`), then lineage.
3. Newest header of the lineage `FOR KEY SHARE`: equality on every lineage field, `key_prefix IS NOT DISTINCT FROM`, `ORDER BY created_at DESC LIMIT 1`.
4. If one exists, count adds and tombstones with D2's two anti-joins, without writing.
5. If there is no header, or `adds + tombstones > ceil(CHECKPOINT_REBASE_RATIO × entry_count)`:
   - insert a new header (`entry_count = eligibleEntries`, `source_snapshot_db_id`, `source_manifest_sha256`);
   - `INSERT INTO backup_tree_checkpoint_entries SELECT <id>, row_number() OVER (ORDER BY source_path, backup_path), … FROM snapshot_index_incoming`;
   - the result is `checkpointWritten: true`, with zero adds and tombstones.
6. Otherwise insert into `backup_snapshot_files` the adds (`checkpoint_entry_no` NULL) and the tombstones (`checkpoint_entry_no = e.entry_no`, `source_path` copied, `backup_path = ''`, other columns NULL, per D1).
7. D9 check: `entry_count − tombstones + adds = eligibleEntries`, or throw `Error('snapshot index delta does not reproduce the manifest: …')`.
8. `UPDATE backup_tree_checkpoints SET last_referenced_at = now()` on the chosen header.

Tests, unit-level with the mocked tx where the repo pattern allows. The SQL-level cases go in Task 6's integration file:
- `lineageKeyOf returns null for any missing key part` (one case per field) and `keys on key root and backup type`.
- `rebase threshold: 5% of 10,000 is 500; 501 changes write a new checkpoint` (a pure helper `exceedsRebase(adds, tombstones, entryCount): boolean`, exported).
- Red: `cd apps/api && npx vitest run src/services/backupSnapshotIndexPublish.test.ts` fails with the module missing.

### Task 2: Hydrator wiring and statistics

- In `verifyOriginsAndWrite`, after the attestation refusal check (`:784-793`):
  - `const lineage = lineageKeyOf(snapshot)`;
  - `const mode = lineage ? resolveDeltaPublishMode(snapshot.orgId) : 'rows'`.
- **`rows`:** today's code path unchanged, plus `fileIndexFormat: 'rows', fileIndexCheckpointId: null` in the final update.
- **`delta`:**
  - delete the snapshot's rows (as now) and `createIncomingIndexTable`;
  - stream pass 2 into `loadIncomingBatch`;
  - check the loaded count equals `eligibleEntries` (the current check, moved);
  - `publishDeltaIndex`;
  - the final update sets `fileIndexFormat: 'delta', fileIndexCheckpointId`. `metadata.fileIndexVersion` stays 3.
  - `HydrationOutcome.entryCount` stays the tree size, `eligibleEntries`, not the rows written. Add `rowsWritten`.
- `ClaimedSnapshot` must carry `configId`, `backupType`, `keyLayout` and `keyPrefix`. Extend `loadSnapshotForHydration` (`:189`) if it lacks them.
- Statistics:
  - `refreshSnapshotFileIndexStatistics(rowsWritten)` (`backupSnapshotFileIndexStatistics.ts:98`) is called with the rows actually written to `backup_snapshot_files`.
  - Add `refreshCheckpointEntriesStatistics(rowsWritten)`, the same shape, calling `breeze_analyze_backup_tree_checkpoint_entries()`, when a checkpoint was written.
  - `STATISTICS_REFRESH_MIN_ROWS` (100,000) applies to both.
- Tests in `backupSnapshotFileIndex.test.ts`:
  - `flag off publishes rows exactly as before`: an assertion on the statements issued, or a seam.
  - `a snapshot with no lineage key publishes rows with the flag on`.
  - `the delta path sets format and pointer in the publishing update`.
- Then run every existing hydrator test: `cd apps/api && npx vitest run src/services/backupSnapshotFileIndex.test.ts src/services/backupSnapshotFileIndex.stream.test.ts src/services/backupSnapshotFileIndex.transactionScope.test.ts src/services/backupSnapshotFileIndexStatistics.test.ts`

### Task 3: Inline agent rows reset the format (Sonnet)

- In `backupResultPersistence.ts:1849`, the status update becomes `.set({ fileIndexStatus: 'agent', fileIndexFormat: 'rows', fileIndexCheckpointId: null })` (D7, fact 6).
- Test, in `backupResultPersistence.test.ts`: `inline agent rows on a delta snapshot reset it to rows format`. The update's `set` includes both fields.
- Integration twin, in Task 6's file: a `delta` snapshot reset to `none`, then given an agent result, reads exactly the agent rows.
- Red first: `cd apps/api && npx vitest run src/services/backupResultPersistence.test.ts`

### Task 4: Checkpoint GC

**Interfaces:** `export async function collectUnreferencedCheckpoints(opts: { deadlineMs: number; now?: Date; maxHeaders?: number }): Promise<{ deleted: number; refused: number }>` in `backupTreeCheckpointGc.ts`. `CHECKPOINT_ORPHAN_TTL_MS = 7 * 24 * 3600 * 1000` **[guessed]**. The default `maxHeaders` is 100 per run.

- **One header per transaction** (D8). Each iteration is `runOutsideDbContext(() => withSystemDbAccessContext(...))`. It selects one candidate `FOR UPDATE SKIP LOCKED LIMIT 1`, deletes it, and commits.
- A candidate is a header with no `backup_snapshots.file_index_checkpoint_id` reference where any of these holds:
  - a newer header of the same lineage exists;
  - `last_referenced_at < now − TTL`;
  - its device is gone, or the device's `org_id` differs from the header's (raw-path leftovers, D6).
- The catch sits outside each iteration. An FK violation (`isPgForeignKeyViolation`) counts as `refused`, and the loop moves on, skipping that id for the rest of the run. Anything else is rethrown.
- The loop stops at `deadlineMs`, at `maxHeaders`, or when no candidate is left.
- Entries go by `ON DELETE CASCADE`. A 180k-entry delete is one statement per header **[derived: bounded by maxHeaders and the deadline]**.
- Wiring: in `backupSnapshotCleanupWorker.ts`, call it after `processCleanupExpiredSnapshots` returns, with `deadlineMs: startedAt + budgetMs`. Add its counts to the job's return value.
  - GC runs whatever the flag says, because it must still collect after the flag is turned off.
  - It never deletes a referenced header, so it is safe while no deltas exist.
- Tests (`backupTreeCheckpointGc.test.ts` for the selection rules with a mocked db; integration cases in Task 6's file):
  - `keeps the newest unreferenced header of a live lineage`;
  - `deletes an older unreferenced header`;
  - `deletes the newest after the orphan TTL`;
  - `never deletes a referenced header`;
  - `deletes an unreferenced header whose device moved org or is gone`;
  - `an FK refusal is counted and the sweep continues`: the mocked delete throws an FK violation for the first candidate, and the second is still deleted;
  - `a header held by a publisher survives the sweep`: integration, two connections. Open a publisher transaction holding `FOR KEY SHARE`, run GC (it skips the header), commit the reference, run GC again (it keeps it).
- Also run `cd apps/api && npx vitest run src/jobs/backupSnapshotCleanupWorker.test.ts src/__tests__/parkedFanout.contract.test.ts`.

### Task 5: The flag (Sonnet)

- `resolveDeltaPublishMode(orgId)` reads `BACKUP_INDEX_DELTA_PUBLISH` on every call: `off` (default, also for any unknown value, with one warning), `canary` or `on`. `canary` returns `delta` only for orgs listed in `BACKUP_INDEX_DELTA_PUBLISH_ORG_IDS` (comma-separated uuids; invalid entries ignored with a warning).
- Tests: every value, whitespace, case, an empty list and a bad uuid. Command: `cd apps/api && npx vitest run src/services/backupIndexDeltaFlag.test.ts`
- `.env.example`: both variables commented out, with one line each saying what they do and that `off` is the default.

### Task 6: Round trip through the readers (after W3 merges)

In `backupSnapshotIndexPublish.integration.test.ts`, drive the real publisher: `hydrateSnapshotFileIndex` with test deps serving a manifest from memory, in the way `backupSnapshotFilesStatistics.integration.test.ts:80` drives it. Set the flag to `on` per test. Cases:
- `the chain contract holds when the publisher writes every snapshot`. Reuse W3's chain scenario: full, replace, delete, re-add, no-change, and another lineage. Compare every reader's output with `seedRowsIndex` of the same trees.
- `duplicate paths and identical entries round-trip exactly`.
- `a delta past 5% writes a new checkpoint and later snapshots diff against it`.
- `hydration out of order still reproduces each tree`: hydrate snapshot 3 before 2.
- `two concurrent hydrations of one lineage write one checkpoint`: advisory lock, two connections.
- `a failed delta invariant leaves the previous rows and format`: force a mismatch through a test seam.
- `flag off after deltas exist: old delta snapshots stay readable; new ones publish rows`.
- The inline-reset twin from Task 3, and the GC race from Task 4.

Command: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/backupSnapshotIndexPublish.integration.test.ts src/__tests__/integration/backupSnapshotIndexChain.integration.test.ts src/__tests__/integration/backupSnapshotFileIndexResultRace.integration.test.ts src/__tests__/integration/backupSnapshotFilesStatistics.integration.test.ts`

**W4 acceptance:**
- With the flag off, every existing hydrator, persistence and statistics test passes unchanged.
- With the flag on, Task 6 passes.
- GC is wired and green.
- `backupSnapshotIndexReadPath.contract.test.ts` passes, with any new allowlist entry reasoned.
- Typecheck exit 0.

**W4 rollback:**
- Set `BACKUP_INDEX_DELTA_PUBLISH=off` (already the default).
- Reverting the PR is safe only while no `delta` snapshot exists. After that, keep the code and keep the flag off.

---

## W5: Turn it on, measure it, document it

**Goal:** New hydrations publish deltas by default. Operators can see rows written and drift. A 1M-entry run proves read latency.

**Preconditions:** gates G2, G3 and G4 are closed.

### File ownership (W5)

- Modify: `apps/api/src/services/backupIndexDeltaFlag.ts` (default `on`; `off` remains the kill switch) and its test
- Modify: `apps/api/src/services/backupMetrics.ts` (`recordSnapshotFileIndex`, `:298`)
- Modify: `apps/api/src/services/backupSnapshotFileIndex.ts` (emit the metrics only)
- Modify: `apps/api/scripts/backup-hydration-rss.ts` and `backup-hydration-rss.lib.ts`. Their `TRUNCATE` and count of `backup_snapshot_files` (`:295`, `:308`) must also clear and count the checkpoint tables, and report rows written by format.
- Create: `apps/api/scripts/backup-index-delta-perf.ts` (the 1M acceptance run)
- Modify: `docs/release-notes/next-release-draft.md`, and the backup docs page for self-hosters (use the `update-breeze-docs` skill; regenerate the docs index if it requires)

### Execution split and parallelism (W5)

- **Group A (parallel):**
  - Task 1 (Sonnet): metrics.
  - Task 2 (Opus): perf script and run.
  - Task 4 (Sonnet): docs and release note.
- **Then** Task 3: flip the default. It is the last commit, after Task 2's numbers are in the PR body.

### Task 1: Metrics

- Extend the closed label set:
  - `recordSnapshotFileIndex('publish', 'rows' | 'delta' | 'checkpoint', rowsWritten)`;
  - a gauge or histogram of `(adds + tombstones) / checkpoint.entry_count` per delta publish, named `backup_snapshot_index_delta_ratio`.
- Labels stay a closed set, with no org or device ids.
- Test in the existing metrics test file: the labels emitted for each publish kind.

### Task 2: 1M-entry perf acceptance

- `backup-index-delta-perf.ts` runs against a local test stack only. It refuses any `DATABASE_URL` whose host is not loopback.
  - It seeds one lineage: a 1,000,000-entry checkpoint **[issue acceptance target]** and snapshots at 1% and 5% drift.
  - It times, as `breeze_app` under RLS: browse root, browse at depth 3, a search miss, a full selection walk, `indexedKeysQuery` for 500 keys, and `referenceMembershipQuery`.
  - It runs the same set on a `rows` snapshot of the same tree, and prints both.
- **Acceptance [guessed thresholds, gate G4]:**
  - every delta reading is within 1.5x of its `rows` twin;
  - membership stays under 50 ms;
  - durable rows written per 1%-drift publish are at most 2% of the tree (2 rows per changed file, D1).
- Paste the output into the PR body. Do not commit results.

### Task 3: Default on

- `resolveDeltaPublishMode` defaults to `on`. `off` and `canary` keep working.
- Update the flag test.
- PR body: rollout order (gate G5) and the rollback below.

### Task 4: Docs and release note

- Release note: one entry. "Incremental backups now store only the files that changed in the server's file index; set `BACKUP_INDEX_DELTA_PUBLISH=off` to keep the previous format." There is no required env var, and the migrations already shipped in W2.
- Self-hoster docs: the env var, the kill switch, and that existing snapshots keep their format.

**W5 acceptance:**
- Metrics are emitted. The perf thresholds are met or explicitly waived at G4.
- Docs and release note are merged in the same PR.
- After deploy, delta publishes appear on the canary org first (G5).

**W5 rollback:**
- Set `BACKUP_INDEX_DELTA_PUBLISH=off`. New hydrations publish `rows`, and existing deltas stay readable (the reader is never flagged).
- To retire all deltas, set their `file_index_status` to `none` in system scope. Each one re-hydrates on its next use (`force`) as `rows`, and GC then collects the unreferenced checkpoints.
  - Run it batched, with a row-count `RAISE WARNING`.
  - It is a production write, so it needs its own owner approval.

---

## Owner gates

- **G1. Accept what the delete disposition costs (before W2 merges).** R2's delete disposition is kept. To make the contract tests admit it, and to stop a snapshot pinning another org's checkpoint, W2 adds:
  - a unique key on `backup_configs (id, org_id)`;
  - two composite FKs;
  - a `SECURITY DEFINER` helper called from the existing tenancy trigger;
  - an exclusion in `breeze_device_child_orgid_tables()`.

  **The visible effect:** after a device move or an org merge, that device's `delta` snapshots list as empty until they re-hydrate on first use. `rows` snapshots are unaffected. **Recommend accepting it:** moves are rare, and every reader already requests the missing index.
- **G2. Production read-only preflight (before W5).** Run read-only, by someone with production access:
  - per-row size: `pg_total_relation_size('backup_snapshot_files') / greatest(reltuples, 1)` and the dead-tuple ratio. This resolves fact 3;
  - the share of snapshots with a NULL lineage-key part (`storage_identity`, `config_id`, `backup_type`). These stay `rows`;
  - the count of `(snapshot_db_id, source_path)` duplicates (informational; D1 handles them);
  - for the largest lineage, the measured drift between consecutive manifests. This confirms the 5% rule gives the expected write cut.
  - The results stay out of the public repo.
- **G3. Lock and timing check on W2's concurrent index statements (before W2 deploys).** `DROP INDEX CONCURRENTLY` on the largest table waits for every transaction that touches it.
  - Confirm that no long-running hydration is in flight at deploy, or accept the wait.
  - autoMigrate runs it at API start.
- **G4. Perf thresholds (W5, Task 2).** Accept or change the guessed thresholds.
- **G5. Rollout (W5).** On the hosted edition, run `canary` on our own tenant for one retention cycle of hydrations before `on`. Self-hosters get the default with the release.

## Not verified

- How the existing move-delete tables (`topology_device_presence`, `device_network_isolations`) survive the raw `UPDATE devices SET org_id` path. They are not in `breeze_device_child_orgid_tables()`'s `NOT IN` list on the baseline. W2 Task 1b Step 0 reads that first, and W2 Task 4's raw-UPDATE test proves the outcome.
- How `breeze_cascade_device_org_id()` orders its per-table restamps inside one trigger statement. D6 does not depend on it: the header is excluded, and each snapshot's pointer is cleared in its own row update.
- **Pre-existing, not introduced:** the selection and search keysets page by `source_path > last` (`backupSnapshotBrowse.ts:171`, `:227`), so two entries with the same path that straddle a page boundary list once. Neither authorization read pages (both are by key), and neither count does. D1 keeps storage exact, so a future keyset on `(source_path, kind, backup_path)` would fix the listing on its own. That is out of scope here.
- The verify worker's own code. Fact 5 rests on command-type registration (`services/backupStorageSessions.ts:125-139`) and the call sites.
- That Postgres pulls the `UNION ALL` derived table up and plans a Merge Append under Limit. W3 Task 3 is the proof. If it does not, the fallback is to dispatch the format in TypeScript inside the same transaction, with each reader's state gate still in its own statement, and to raise it in the PR.
- Production per-row size, duplicate-path frequency, real drift and lineage-key NULL share (G2).
- Whether the agent ever emits two entries with the same path. The server does not prevent it (fact 1), and D1 handles it either way.
- The three nightly perf-gate comments on the issue. Each says the run was invalid. They were not opened.
- Bytes per entry in the new tables. The expectation is fewer than `backup_snapshot_files` (no `id`, no `created_at`) **[derived]**, measured in W5 Task 2.

## Numbers used

| Figure | Value | Label |
|---|---|---|
| Rebase ratio | 5% of checkpoint entries | decision comment |
| Eager hydration ceiling | 250,000 entries (`backupResultPersistence.ts:900`) | code |
| Inline agent-row ceiling | about 9.5k entries | [issue design comment] |
| Bytes per `backup_snapshot_files` row | about 578 B incl. indexes | [measured-lab] |
| Same, from the issue's daily total | 0.84 to 1.35 KB | [derived] |
| Largest device's tree | about 180k entries, 4 to 6 runs a day | [issue] |
| Rows per 1%-drift run, same-file churn | about 2 × 1,800 = 3,600 | [derived, D1] |
| Rows per run, 1% disjoint churn, averaged over a rebase cycle | about 64k (3.6k, 7.2k, then a 180k rebuild every 3rd run), against about 35k for one row per change and 180k today | [derived, guessed churn] |
| Orphan checkpoint TTL | 7 days | [guessed] |
| EXPLAIN fixture size | 50,000 entries | [guessed] |
| Perf acceptance | 1M entries; 1.5x; 50 ms | [issue] for 1M, [guessed] for the rest |
