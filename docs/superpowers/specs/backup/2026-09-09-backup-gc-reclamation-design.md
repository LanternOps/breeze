---
title: Backup storage reclamation — server-owned dedupe base, durable pins and retirements, rows-only GC roots (D18)
status: v3 after two Codex review rounds (xhigh + high confirmation); ready for planning
date: 2026-09-09
source: docs/testing/backup-assurance/2026-09-09-backup-assurance-campaign.md (D18, R1/R4, §9 decision 6); issue #5429
author: Claude (Fable); code map by Explore subagents; adversarial review by Codex gpt-6-astra xhigh (read-only)
---

# Backup Storage Reclamation (D18) — Design v3

## 0. Problem, in one paragraph

Retention deletes `backup_snapshots` rows (D17, #5419) but the storage sweep in
`apps/api/src/jobs/backupRetention.ts` marks **every prefix that still has a
`manifest.json`** as a live root (`listedManifestSnapshotIds`, ~:805), and nothing ever
deletes a manifest object. Once a snapshot is published, its manifest, every object it lists,
and every object it references in older prefixes are immortal. Retention is purely logical;
bucket usage only grows (campaign cell R4: three expired rows deleted, `0 objects deleted`,
expired base still holds all 10,048 objects, six manifest-bearing prefixes with no row). The
protection exists because the **agent** picks its incremental dedupe base by listing bucket
manifests (`agent/internal/backup/incremental.go:53 previousManifest`), so the server cannot
know which base an in-flight run depends on and must keep them all.

## 1. Ground truth (verified on main `24c3e2ad81`, 2026-09-09)

- **No pin of any kind exists.** `backup_jobs` has `snapshot_id` (the child) and no base
  column (`apps/api/src/db/schema/backup.ts:207-278`). `restore_jobs.snapshot_id` is
  `ON DELETE SET NULL` (`:363`), so retention can delete the row of a snapshot being restored
  right now; the restore survives today only because every listed manifest is a root. The only
  in-flight protections are the 48 h object grace (`BACKUP_GC_GRACE_MS`, `:494-524`, resolved
  once at module load) and the 9-day manifest-less-prefix rule
  (`BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS` = agent journal max age 7 d + grace,
  `:537-538`, source-text-contract-tested in `services/backupAgentContract.test.ts:33,42`).
- **The manifest already records the base** (`agent/internal/backup/snapshot.go:69
  baseSnapshotId`, set `:378-388`) but the result parser strips it
  (`routes/backup/resultSchemas.ts:27 backupSnapshotResultSchema` has no `baseSnapshotId` /
  `formatVersion`) and reconcile discards it (`services/backupSnapshotReconcile.ts:576`).
  `backup_snapshots.parent_snapshot_id` (self-FK `ON DELETE SET NULL`, `:305`) and
  `is_incremental` (`:300`) exist and are never written.
- **Dispatch payload** (`jobs/backupWorker.ts:471-490`):
  `{jobId, configId, provider, providerConfig, storageEncryption, paths|systemImage|...}` —
  no base field. Multi-target dispatch creates one `backup_jobs` row per extra target with no
  parent linkage (`:713-739`).
- **Two writers of snapshot rows:** `services/backupResultPersistence.ts:1144
  applyBackupCommandResultToJob` (normal; also accepts a late result for an already-reaped job,
  `:972`) and `services/backupSnapshotReconcile.ts:592 reconcileOrphanedBackupSnapshots`
  (adopts any manifest-bearing prefix whose completed job lacks a snapshot row — including one
  retention deliberately deleted, `:754`; never checks the objects exist, `:865`).
- **Every mode writes `snapshots/<id>/manifest.json`** with a `files[].backupPath` manifest the
  GC parser accepts: file (`snapshot.go:390,819`), system_image (same manager; today its
  state artifacts go through the ordinary `files/` loop, `backup.go:518`, `snapshot.go:594`;
  the `system-state/` sub-prefix is D15's *target*), hyperv
  (`agent/cmd/breeze-backup/exec_hyperv.go:240,421-422`), mssql (`exec_hyperv.go:78-81,532`).
  The retention comment at `backupRetention.ts:1057-1065` claiming otherwise is wrong; the
  `backupType='file'` root filter (`:1066-1074`) means those rows are protected **only** by the
  every-listed-manifest rule this design removes. Vault replication (`local_vaults`, agent
  `vault_path`) is a device-local directory, not a `backup_configs` identity — never listed.
- **Agent deletes remotely in two places**: the retention prune branch (`backup.go:780-806`,
  suppressed only by `incrementalDedupeActive`) and **stale-journal cleanup**
  (`backup.go:738` → `snapshot.go:884`), which deletes the journal's remote prefix even if that
  prefix was already published (crash between manifest publish and journal completion). A
  resumed journal also reuses the published snapshot id and re-uploads over it
  (`snapshot.go:375,784`). Journal age is checked only at open (`journal.go:155`).
- **No agent-local scheduler** (`backup.go:172-174`, #2452); every run is a server
  `backup_run`. The helper falls back to an agent.yaml-built manager when the payload lacks
  `provider`/`providerConfig` (`main.go:729-737`, `exec_backup.go:117-119`).
- **Reaper** (`jobs/staleCommandReaper.ts:1343`): 15 min without progress, 1 h pending, and
  24 h absolute **only when `lastProgressAt` is NULL** (`:1390`) — a progressing job runs
  indefinitely. Reaping queues a best-effort `backup_stop` and skips it for offline devices
  (`:1402`); a disconnected helper keeps uploading. Restore commands time out server-side after
  30 min (`services/commandTimeouts.ts:89`) while the helper has no deadline (`main.go:80`).
  Restores are created `pending` **before** their command row exists
  (`routes/backup/restore.ts:281,361`); the reaper matches restores only by `commandId`
  (`:237`), so a crash leaves a commandless `pending` restore forever.
- **Destination identity is mutable**: `PATCH /backup/configs/:id` edits `providerConfig` in
  place (`routes/backup/configs.ts:392`) and GC attributes rows to identities through the
  config's *current* `providerConfig` (`backupRetention.ts:990`).
- **GC cadence** 6-hourly (`scheduleRegistry.ts:151`); delete cap 2000/run oldest-first, failed
  keys only logged (`:950-959`); `deleteBackupObjectKeys` batches and continues past failures
  (`backupSnapshotStorage.ts:329`). A NULL `config_id` row wedges the whole run (`:985-1017`).
- **`devices.backup_version`** (`schema/devices.ts:175`) carries the helper version;
  `services/backupHelperCapabilities.ts` already gates a feature on it (#4925 pattern).
- **Tests locking in removed behaviour:** `backupRetention.test.ts:665` and `:699-752` (FIX 5).
- **No GC integration test**; MinIO is dev-compose only; the sweep supports the `local`
  provider, enough for a real-DB + real-filesystem proof in CI.

## 2. Goals / non-goals

**Goals**
1. Expired snapshots' exclusive objects and manifests are reclaimed on the next GC cycle.
2. No object referenced by a retained snapshot is ever deleted; no snapshot under restore,
   bare-metal recovery, or in use as a dedupe base loses its row or objects.
3. An in-flight or late-publishing backup never ends up with dangling references.
4. The server chooses the dedupe base; the agent never lists the bucket to choose one and
   **never deletes a remote object**.
5. Every state transition GC depends on is durable in Postgres and provable against a real
   database and real storage in CI.

**Non-goals**
- Changing key layout, `providerConfig.prefix` handling, or object-lock semantics.
- MSSQL/Hyper-V chain-consistent retention (#5421) beyond keeping their objects safe.
- Reclaiming identities no config points at any more (they leak, logged — see §3.6).

## 3. Contract

### 3.1 Server-chosen base, pinned with a lease

- **Columns on `backup_jobs`:** `base_snapshot_id varchar(255) NULL` (storage snapshot id,
  deliberately not a FK — a pin must never be nulled by a cascade),
  `publish_lease_expires_at timestamptz NULL` (set for **every** dispatched file/system_image
  job, base or not — it fences late results, §3.1 last bullet) and `storage_identity text NULL`
  (the identity of the `providerConfig` actually placed in the payload, §3.6). Partial index on
  `base_snapshot_id`.
- **Selection** (`prepareBackupDispatchTargets`, per dispatched file/system_image target
  including multi-target child rows): newest `backup_snapshots` row with the same
  `(device_id, config_id)`, `backup_type IN ('file','system_image')` or NULL, same mode as the
  target, `expires_at IS NULL OR expires_at > now() + lease`, owning job `completed`, and no
  retirement row (§3.3). None → full run.
- **Acquisition is serialised against retention** (Codex F1) with lock order **job → snapshot**
  (the same order `routes/devices/moveOrg.ts:656` uses, so no inversion): in one transaction
  `UPDATE backup_jobs SET base_snapshot_id = $base, publish_lease_expires_at = now() + lease,
  storage_identity = $identity WHERE id = $job` (locks J), then `SELECT id FROM
  backup_snapshots WHERE id = $baseRow FOR SHARE` (locks B) and check no retirement row exists;
  if the row is gone, `SET base_snapshot_id = NULL` in the same transaction and dispatch a full
  run. Retention's per-row delete takes `FOR UPDATE` on B and re-checks pins in a fresh
  statement (§3.2). Either the pin is visible to retention or the row is already gone and
  dispatch falls back. No FK-column write inside the locked section (no key-share deadlock,
  cf. #3911).
- **Pin definition:** a `backup_jobs` row pins `base_snapshot_id` while
  `status IN ('pending','running') OR publish_lease_expires_at + BACKUP_PUBLISH_MARGIN_MS >
  now()`. The lease (default `BACKUP_BASE_LEASE_MS` = 7 d, matching the agent journal max age)
  answers Codex F3: a reaped job's helper may still be uploading, so terminal status alone never
  releases the pin; the lease does. The helper enforces the same lease at publish time with the
  margin (below), so no manifest referencing the base can land after the server stops pinning
  it. The lease is **fixed at dispatch — not renewed**: there is no progress-ack channel to
  deliver a renewal to the helper (`routes/agentWs.ts:2723`), and a run longer than the lease
  already cannot resume (journal max age 7 d), so "a run must publish within 7 d of dispatch" is
  the existing envelope made explicit. Operators with slow initial seeds raise
  `BACKUP_BASE_LEASE_MS`; the orphan window follows it (§3.4).
- **Payload:** `backup_run` gains `baseSnapshotId: string` ("" = full run) and
  `publishLeaseExpiresAt: RFC3339`. Presence of `baseSnapshotId` is the protocol switch.
- **Agent**: with the field present → server-owned mode: non-empty → download
  `snapshots/<id>/manifest.json`, require `backupIdentity == runBackupIdentity()` (D6 guard),
  use as `prevSnapshot`; "" or 404 or mismatch → full run, logged. Before **publishing** the
  manifest the agent checks `now + publishMargin (1 h) < publishLeaseExpiresAt` (and, for
  resumed runs, journal age < `journalMaxAge` — Codex F6); if either fails it does not publish
  and fails the run with a distinct error class. The margin is what turns the pre-PUT check into
  a fence: the server keeps the pin for lease + margin, so a PUT that starts inside the margin
  completes before the pin lapses. Without the field (older server) → legacy listing, unchanged.
- **Publication / lineage:** `backupSnapshotResultSchema` gains `baseSnapshotId` and
  `formatVersion`; `applyBackupCommandResultToJob` sets `parent_snapshot_id` (row uuid of the
  base under the same config, NULL if absent) and `is_incremental = referencedFiles > 0 ||
  formatVersion >= 2`. Reconcile adoption does the same from the manifest.
- **Late results** (Codex F2b): a result for a job already in a terminal reaped status is
  accepted only if `publish_lease_expires_at > now()` **and** (`base_snapshot_id IS NULL` or the
  base row exists and is not retired); otherwise the result is recorded as `failed` (reason
  `publish_lease_expired` / `base_retired`) and the manifest is left for GC as an orphan. The
  lease fences full backups too: an orphan is never swept before its job's lease has expired
  (window ≥ lease + grace, §3.4), so an accepted late result always refers to objects that
  still exist.

### 3.2 Retention refuses pinned rows and writes a retirement

`cleanupExpiredSnapshots` (both passes) processes each candidate in its own transaction:
`SELECT … FOR UPDATE` on the row, then skip if any of:
- backup pin (§3.1);
- restore pin: `EXISTS restore_jobs WHERE snapshot_id = row.id AND ((status IN
  ('pending','running') AND command_id IS NOT NULL) OR created_at > now() -
  BACKUP_RESTORE_PIN_LINGER_MS)` — the linger (default 7 d) covers helpers that keep reading
  after the 30-min server timeout (F3); a commandless `pending` restore (crash between
  `restore.ts:281` and `:361`) pins only for the linger and is additionally failed by a new
  reaper rule after 1 h (F8). A helper restore running longer than the linger is out of scope
  (§7, agent restore deadline);
- recovery pin: `EXISTS recovery_tokens WHERE snapshot_id = row.id AND (status IN
  ('active','authenticated') OR completed_at IS NULL AND expires_at > now() - linger)`
  (columns per `schema/recoveryTokens.ts:10-16`; no `session_status` column exists);
- `legal_hold` / immutability, **re-read under the row lock** (a hold set after candidate
  enumeration must win);
- `storage_identity IS NULL` (§3.6): the row cannot be tombstoned on an identity, so it is
  skipped (`skippedUnresolved`) until the sweep self-heals it — never retired blind.

Otherwise, in the same transaction: insert `backup_snapshot_retirements` (§3.3) and delete
the row. Every lookup of a base or retired snapshot by storage `snapshot_id` is scoped by
`storage_identity` (the id is not unique across identities, `schema/backup.ts:330`). Counts gain `skippedPinned`. `deleteSnapshotRow`'s docstring is rewritten to this.

### 3.3 Durable retirement (DB tombstone) — new table `backup_snapshot_retirements`

Columns: `id`, `org_id` (NOT NULL), `config_id` (FK `backup_configs` ON DELETE CASCADE),
`device_id` (nullable, FK SET NULL), `snapshot_id varchar(255)`, `storage_identity text`
(§3.6), `backup_type`, `reason` (`expired` | `max_versions` | `manual`), `retired_at`,
`swept_at` (nullable; set when the sweep finds the prefix empty), unique
`(storage_identity, snapshot_id)`. Tenancy shape 1 (`breeze_has_org_access(org_id)`), RLS in
the creating migration, registered in `CORE_ORG_CASCADE_DELETE_ORDER`,
`CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES`,
`CORE_TENANT_EXPORT_POLICY` (all columns `included`). Rows are pruned 30 d after `swept_at`.
Deleting a device or org cascades its retirement rows *and* its snapshot rows; the prefixes
then fall under the orphan rule and are reclaimed after the window — a deliberate behaviour
change (today a deleted device's objects were immortal), called out in §9 for Todd.

Why (Codex choice 1): age alone cannot tell "expired" from "orphan", cannot stop reconcile from
re-adopting an expired prefix mid-sweep, and delays reclamation of young `maxVersions` prunes
by the orphan window. A retirement row is authoritative and visible to every writer:
- reconcile refuses to adopt a retired `snapshot_id` (and prunes nothing itself);
- dispatch never selects a retired base;
- late results check it (§3.1);
- the sweep treats a retired prefix as garbage immediately, no window.

### 3.4 GC roots and sweep rules

Per storage identity (§3.6):

```
roots   = { snapshot_id of EVERY backup_snapshots row with storage_identity = I }   (all types)
        ∪ { snapshot_id of rows with storage_identity NULL whose config currently maps to I }
        ∪ { listed manifest-bearing prefixes with no row and no retirement whose
            manifest.json lastModified is newer than ORPHAN_WINDOW }
ORPHAN_WINDOW = max(BACKUP_GC_ORPHAN_MANIFEST_MAX_AGE_MS (9 d), BACKUP_BASE_LEASE_MS + BACKUP_GC_GRACE_MS)
live    = ⋃ roots { manifest key } ∪ { files[].backupPath }
retired = { snapshot_id of backup_snapshot_retirements with storage_identity = I, swept_at IS NULL }
```

Per listed prefix group:
- **Rooted:** unchanged — delete objects not in `live` and older than `BACKUP_GC_GRACE_MS`.
- **Retired, or orphan older than the window:** delete every object not in `live`. Two
  phases per prefix (Codex F9b): all non-manifest keys first; `manifest.json` is deleted only
  when **no deletable non-manifest key remains** in the prefix (none failed, none skipped by the
  cap or the Redis skip set); when the listing later shows the prefix empty, set `swept_at`.
- **Manifest-less:** unchanged 9-day rule (in-progress upload protection). The agent
  additionally refreshes `snapshots/<id>/upload.lease` (tiny object) every
  `uploadLeaseInterval` (15 min) while uploading, so a multi-day single-object upload keeps the
  prefix's newest object fresh (Codex F6).
- **Reconcile boundary:** reconcile adopts an orphan only while its manifest is younger than
  half the window, so adoption and sweeping are disjoint by age; and only if the manifest's
  `baseSnapshotId` (when present) has a live, unretired row — a manifest whose base is gone is
  refused (its references may already dangle).
- **Cap fairness (Codex F9a):** keys whose delete failed are remembered in Redis
  (`backup-gc:failed:<identity-hash>`, TTL 7 d) and skipped from the cap for that period.
- **Capability gate (Codex F4):** unrooted-prefix deletion (retired + orphan rules) on an
  identity is enabled only when every device that has a `backup_jobs` row on that identity
  that is `pending`/`running` (any age) **or** was created in the last 30 d reports
  `devices.backup_version >= BACKUP_SERVER_BASE_MIN_HELPER_VERSION`
  (`backupHelperCapabilities.ts`, the release carrying W03). Otherwise that identity logs
  `reclamation deferred: legacy helper <device>` and runs **exactly today's algorithm**: every
  listed manifest (rooted or not, retired or not) is marked live, so a base a legacy helper
  chose by listing keeps its cross-prefix references protected; only loose objects under a
  manifest-bearing prefix and manifest-less prefixes older than 9 d are reclaimed. A helper upgrade kills any run in progress, so the current version attests the
  running helper. The gate is removed one release after every supported helper carries W03.
- **Unknown-identity rows:** every row mapped to I with `storage_identity IS NULL` is a root
  of I (its manifest is fetched; a fetch failure aborts I fail-closed like any root). While any
  such row's manifest is not found in I's listing, I runs today's algorithm as for a deferred
  identity (§3.6). Self-heal updates by row **id** (`snapshot_id` is not unique across
  identities, `schema/backup.ts:330`) and only where `storage_identity IS NULL`.

All knobs are resolved **per run** with the existing production-floor/warn pattern:
`BACKUP_GC_GRACE_MS`, `BACKUP_GC_ORPHAN_MANIFEST_MAX_AGE_MS` (default 9 d),
`BACKUP_BASE_LEASE_MS` (7 d), `BACKUP_PUBLISH_MARGIN_MS` (1 h), `BACKUP_RESTORE_PIN_LINGER_MS` (7 d).

### 3.5 The agent never deletes

- Remove the retention prune branch (`backup.go:780-806`); `BackupConfig.Retention` no longer
  drives deletion anywhere (agent.yaml manager fallback keeps uploading, cannot reclaim).
- Stale-journal cleanup no longer deletes the remote prefix (`backup.go:738`,
  `snapshot.go:884`): a discarded journal is simply dropped; GC's manifest-less rule reclaims
  an unpublished prefix, and a published one is a root. (Codex F5.)
- On resume, if `snapshots/<id>/manifest.json` already exists the run is treated as already
  published: no re-upload, no overwrite; report the existing manifest as the result.
- `DeleteSnapshot`/`DeleteSnapshotContext` are removed (`backup_cleanup` is local-only).
  **Sole exceptions**, because they can never touch anything another manifest references: the
  helper may delete objects under its **own current run prefix before its manifest is
  published** (the journal-less abort paths at `snapshot.go:499` and `:544`, kept as-is) and
  its own `upload.lease` after publication. Vault retention operates on the device-local vault
  directory, not on a GC-managed identity, and is unchanged.

### 3.6 Snapshots carry their storage identity (Codex F7)

`backup_jobs.storage_identity` is stamped **at dispatch** from the `providerConfig` placed in
the payload (that is the bucket the helper will write to, whatever the config says later);
`backup_snapshots.storage_identity text NULL` is copied from the job at publication (reconcile
copies it from the adoptable job too). GC groups rows by this column, not by the config's
current `providerConfig`, so editing a destination cannot un-root snapshots already written to
the old bucket.

Historical rows: **no SQL backfill** — replicating `normalizeStorageIdentity` in PL/pgSQL is
a fidelity risk with no payoff. The sweep self-heals a NULL row when it finds
`snapshots/<id>/manifest.json` in the listing of the config's current identity
(`UPDATE … SET storage_identity = I WHERE id = row.id AND storage_identity IS NULL`), which
resolves every resolvable row on the first GC run after deploy; until every NULL row mapped to
an identity has been resolved, that identity runs today's algorithm (§3.4). A row still NULL
after 30 d is logged (`unresolved storage identity <row>`) for operator attention. Rows with
NULL `config_id` stay NULL and keep wedging the run as today. No `NOT NULL` constraint.

An identity no config points at any more is never listed and therefore leaks; the sweep logs
`unreachable identity <I>: <n> rows`. `PATCH /backup/configs/:id` warns (does not block) when
the edit changes the identity of a config that has snapshot rows.

### 3.7 Transaction boundaries (Codex v2 P1)

`processCleanupExpiredSnapshots` (`jobs/backupWorker.ts:325-390`) runs today inside the
worker's blanket `runWithSystemDbAccess`, which is a **single transaction** (see the #1105
comment at `:508-520`): every per-row retention "transaction" would be a savepoint, object
deletes would happen before the row deletes commit, and the deliberate D17 throw at `:387`
would roll all retirements back after the bucket was already swept — resurrecting rows whose
objects are gone. Required shape:

1. Retention: one short system context **per candidate row** (`SELECT FOR UPDATE` → pin checks
   → insert retirement → delete row → commit), so each retirement is durable before the next.
2. Sweep: a separate system context per identity for the DB reads, with every storage call at
   depth 0 (outside any transaction), mirroring the dispatch phase split at `:508-528`.
3. The D17 `failed > 0` throw stays last and can no longer undo anything.

W01 delivers 1 and 3 and calls the sweep under one system context (today's shape, so
`sweepUnreferencedBackupObjects` keeps working reads); W02 replaces that with 2.

Retirement rows therefore commit strictly before any object they cover is deleted, and an
object is deleted only for a snapshot whose retirement is already durable.

## 4. Data model & registries

| Migration (slots after newest shipped `2026-10-15-140004`) | Content |
|---|---|
| `2026-10-15-160011-backup-jobs-base-pin-and-storage-identity.sql` | `backup_jobs.base_snapshot_id`, `publish_lease_expires_at`, `storage_identity`, partial index; `backup_snapshots.storage_identity` (nullable, no backfill — §3.6 self-heal); DDL only, no `breeze.scope` needed |
| `2026-10-15-160012-backup-snapshot-retirements.sql` | table + RLS (shape 1, enable+force, four policies) + indexes |

Registries: `tenantExportPolicyRegistry.ts` (`backup_jobs` + 3 cols, `backup_snapshots` + 1
col, new table), `tenantCascade.ts` `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical: after
`backup_snapshot_files`? — verify `localeCompare` order in the test), `routes/devices/core.ts`
device lists, `orgMergeRegistry` if applicable. `pnpm db:check-drift`.

## 5. Failure modes

| Scenario | Outcome |
|---|---|
| Dispatch selects B while retention deletes B | Lock order job→snapshot; retention sees the pin and skips, or dispatch sees no row and runs full. |
| Retention run throws after the sweep | Per-row commits (§3.7): nothing already swept can be rolled back. |
| Config edited A→B while a run uploads to A | Job stamped A at dispatch; row inherits A; still rooted on A. |
| Backfilled identity uncertain (config edited after snapshot) | Row stays NULL; identity runs rooted-only until self-healed from the listing. |
| Late full-backup result after its orphan prefix was swept | Lease expired → `failed(publish_lease_expired)`; window ≥ lease + grace guarantees the converse. |
| Manifest PUT straddles lease expiry | 1 h publish margin on both sides. |
| Legacy helper with a >30-day running job | Gate includes active jobs of any age. |
| Job reaped while helper offline, still uploading | Lease keeps B pinned 7 d + margin; helper refuses to publish inside the margin; late result after lease → `failed`, manifest becomes orphan → swept after window. |
| Crash after publish, before journal completion; stale journal later | Agent no longer deletes; prefix is rooted (if row) or orphan/adoptable. |
| Resume reuses published id | Detected via existing manifest; no overwrite. |
| Restore/BMR in flight, snapshot expires | Restore/recovery pin (status or linger). |
| Legacy helper on identity | Identity's unrooted-prefix reclamation deferred; rooted-prefix rule only. |
| Config bucket edited | Rows keep `storage_identity`; old bucket still swept iff some config lists it; else leak logged. |
| Cap hit mid-prefix | Manifest deleted only after all other keys succeed; partial prefix retried next run. |
| Object-lock refuses deletes | Failed keys skipped for 7 d; other garbage still progresses. |
| Reconcile vs sweep | Retired ids refused; orphans adoptable only below half-window; sweep only above window. |
| NULL `config_id` row | Still wedges the run (unchanged). |
| Hyper-V/MSSQL/system_image rows | Roots like any other row; manifests parse. |

## 6. Verification

- **Unit:** retention pin/retirement/skip counts; dispatch selection + lock protocol (mocked
  chain) + payload fields; result-apply lineage + late-result fence; reconcile refusals; sweep
  root set (all types), retired-immediate, orphan window, two-phase manifest delete, Redis skip
  set, capability gate, per-run knobs. Replace `backupRetention.test.ts:665,699-752`.
- **Integration (real DB, `local` provider, CI shard):** (1) base B + incremental C referencing
  B + B-exclusive X; expire B → retirement row, X and B's manifest gone, C intact and every
  `backupPath` present; (2) pinned B (running job) → nothing reclaimed; (3) lease expired,
  job reaped → reclaimed; (4) restore pin; (5) legacy helper version on identity → deferred;
  (6) concurrent dispatch/retention on the same row (two transactions) → no dangling pin;
  (6b) retention run with one failing row after a sweep → earlier retirements still committed;
  (6c) NULL-identity row self-healed from listing, identity deferred until then;
  (7) RLS forge on the retirements table (42501) + cascade/export contract suites.
- **Agent (`go test -race`):** server-owned mode (valid / mismatch / "" / 404), lease refusal at
  publish, resume-with-existing-manifest, no remote delete on stale journal, upload lease
  refresh, legacy mode unchanged; `backupAgentContract.test.ts` for payload names and the
  lease/journal constants.
- **Lab (manual, campaign harness, MinIO):** cell R4 with `BACKUP_GC_ORPHAN_MANIFEST_MAX_AGE_MS`
  and lease knobs shortened — expired base reclaimed; retained incremental restores
  byte-identical (F2 hashes); Hyper-V/MSSQL manifests untouched.

## 7. Deferred

- Drop the agent's legacy listing path and the capability gate one release after ship.
- Agent-side restore deadline (helper has none today) — separate issue.
- Reclaiming unreachable identities (no config) — manual tooling, separate issue.
- D15 `system-state/` prefix must extend `markLiveBackupObjects` — already in its plan.
- Storage accounting UI.

## 8. Decisions for Todd (defaults applied)

1. **Deleted device/org → its backups are reclaimed after the orphan window** (§3.3). Default:
   yes (matches "delete means delete"; today they leaked forever). Alternative: keep a
   retirement-free hold for N days.
2. **Runs longer than `BACKUP_BASE_LEASE_MS` (7 d) fail to publish** (§3.1). Default: yes —
   journal resume already caps a run at 7 d; knob is env-tunable per deployment.

## 9. Review log

- [x] Hyper-V / MSSQL layout confirmed 2026-09-09 (Explore subagent): system_image
  `bmr.go:222`/`snapshot.go:819`; hyperv `exec_hyperv.go:240,421-422,437`; mssql
  `exec_hyperv.go:78-81,514,532-533`; `backupType` stamping `backupResultPersistence.ts:1127-1133`;
  vault `vault.go:77-78` + `routes/backup/vault.ts:92` (`local_vaults`).
- [x] Codex gpt-6-astra **high** confirmation review of v2 (2026-09-09): 2 CLOSED / 6 PARTIAL /
  1 OPEN + 5 P1 + 4 P2 new. Folded into v3: ambient-transaction rollback (§3.7, verified
  `backupWorker.ts:61,101,508-520`); identity stamped at dispatch + guarded backfill +
  self-heal + nullable (§3.6); gate includes active jobs of any age (§3.4); publish margin
  (§3.1); lease fences full backups and orphan window ≥ lease + grace (§3.1/§3.4); lock order
  job→snapshot (§3.1); reconcile refuses manifests whose base is gone (§3.4); manifest deleted
  only when no deletable key remains (§3.4); commandless restores pin only for the linger and
  are reaped (§3.2). Not adopted: server-side lease renewal (no delivery channel; fixed lease
  instead, §3.1); helper restores longer than the linger (deferred, §7).
- [x] Codex gpt-6-astra xhigh read-only review 2026-09-09 of v1: 7×P1 + 2×P2 + 3 factual
  corrections, all folded into v2 (F1 lock protocol §3.1; F2 retirement table §3.3 + late-result
  fence; F3 leases §3.1/§3.2; F4 capability gate §3.4; F5 agent never deletes §3.5; F6 lease at
  publish + upload lease object; F7 storage identity §3.6; F8 restore linger §3.2; F9 two-phase
  manifest delete + Redis skip set §3.4). Codex agreed with retention-time pin enforcement given
  atomic acquisition/retirement, and rejected age-only retirement — both adopted.
