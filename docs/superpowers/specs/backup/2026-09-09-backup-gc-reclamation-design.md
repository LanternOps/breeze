---
title: Backup storage reclamation — server-owned dedupe base, pins, and a rows-only GC root set (D18)
status: draft, pending advisor review
date: 2026-09-09
source: docs/testing/backup-assurance/2026-09-09-backup-assurance-campaign.md (D18, R1/R4, §9 decision 6); issue #5429
author: Claude (Fable), code map by an Explore subagent
---

# Backup Storage Reclamation (D18) — Design

## 0. Problem, in one paragraph

Retention deletes `backup_snapshots` rows (D17, #5419) but the storage sweep in
`apps/api/src/jobs/backupRetention.ts` marks **every prefix that still has a
`manifest.json`** as a live root (`listedManifestSnapshotIds`, ~:805), and nothing ever
deletes a manifest object. So once a snapshot is published, its manifest, every object it
lists, and every object it references in older prefixes are immortal. Retention is purely
logical; bucket usage only grows (campaign cell R4: three expired rows deleted, `0 objects
deleted`, expired base still holds all 10,048 objects, six manifest-bearing prefixes with no
row). The protection exists because the **agent** picks its incremental dedupe base by
listing bucket manifests (`agent/internal/backup/incremental.go:53 previousManifest`), so
the server cannot know which base an in-flight run depends on and must keep them all.

## 1. Ground truth (verified on main `24c3e2ad81`, 2026-09-09)

- **No pin of any kind exists.** `backup_jobs` has `snapshot_id` (the child) and no base
  column (`apps/api/src/db/schema/backup.ts:207-278`). `restore_jobs.snapshot_id` is
  `ON DELETE SET NULL` (`:363`), so retention can delete the row of a snapshot that is being
  restored right now; the restore survives today only because every listed manifest is a
  root. "Active restore pins" and "active upload prefixes" in the campaign quorum text do not
  exist in code — the only in-flight protections are the 48 h object grace
  (`BACKUP_GC_GRACE_MS`, `:494-524`, resolved once at module load) and the 9-day
  manifest-less-prefix rule (`BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS` = agent journal
  max age 7 d + grace, `:537-538`, source-text-contract-tested against the agent in
  `services/backupAgentContract.test.ts:33,42`).
- **The manifest already records the base** (`agent/internal/backup/snapshot.go:69
  baseSnapshotId`, set at `:378-388`), the reconcile parser already models it
  (`services/backupSnapshotReconcile.ts:240`), and `backup_snapshots.parent_snapshot_id`
  (self-FK `ON DELETE SET NULL`, `:305`) and `is_incremental` (`:300`) exist — **none of
  them is ever written**. Persistence is the missing piece, not information.
- **The dispatch payload** (`jobs/backupWorker.ts:471-490`) is
  `{jobId, configId, provider, providerConfig, storageEncryption, paths|systemImage|...}` —
  no base field. Multi-target dispatch creates one `backup_jobs` row per extra target with no
  parent linkage (`:713-739`).
- **Two writers of snapshot rows:** `services/backupResultPersistence.ts:1144
  applyBackupCommandResultToJob` (normal) and `services/backupSnapshotReconcile.ts:592
  reconcileOrphanedBackupSnapshots` (adopts manifest-bearing prefixes with no row; on-demand
  route, not scheduled).
- **There is no agent-local scheduler** (`agent/internal/backup/backup.go:172-174`, #2452);
  every run is a server `backup_run` command. But the helper falls back to an
  **agent.yaml-built manager** when the payload lacks `provider`/`providerConfig`
  (`agent/cmd/breeze-backup/main.go:729-737`, `exec_backup.go:117-119`); that manager carries
  `Retention = cfg.BackupRetention || 7` and the agent's prefix-wide, reference-blind
  `DeleteSnapshotContext` (`snapshot.go:977`) is suppressed **only** by
  `incrementalDedupeActive` (`backup.go:780-806`). That is the real shape of the quorum's
  "legacy writers" concern.
- **Abandonment:** `jobs/staleCommandReaper.ts:1343 reapStaleBackupJobs` flips
  `pending|running` rows after 15 min stall / 24 h absolute / 1 h pending, CAS on status.
  GC runs 6-hourly (`scheduleRegistry.ts:151`, `27 2,8,14,20 * * *`).
- **Root-set filter today** is `backupType = 'file' OR NULL` (`backupRetention.ts:1066-1074`)
  on the claim that other modes never share `snapshots/`. That claim is **wrong for every
  mode** — system_image, Hyper-V and MSSQL all publish `snapshots/<id>/manifest.json` (§3.4).
- **A NULL `config_id` row wedges the whole GC run** (`:985-1017`); `backup_configs` is read
  unfiltered (`:990-996`); `providerConfig.prefix` is ignored by both agent and API
  (`backupSnapshotStorage.ts:136-161`) so keys are always `snapshots/<id>/...`.
- **Tests that lock in the behaviour being removed:** `backupRetention.test.ts:665` ("keeps
  a listed manifest's exclusive objects live even though no row retains it") and `:699-752`
  ("marks every listed manifest, not just the newest (FIX 5)"). Both were data-loss review
  fixes; §3 states what replaces their guarantee.
- **No GC integration test exists**; MinIO is dev-compose only. The sweep already supports
  the `local` provider, which is enough for a real-DB + real-filesystem proof in CI.

## 2. Goals / non-goals

**Goals**
1. An expired snapshot's exclusive objects (and its manifest) are reclaimed, bounded in time.
2. Every retained snapshot restores completely at all times: no object referenced by a
   retained manifest is ever deleted, and no snapshot under active restore loses its row or
   objects.
3. An in-flight backup never ends up with dangling references, whatever base it used.
4. The server, not the agent, decides the dedupe base; the agent never lists the bucket to
   choose one and never deletes anything.
5. Behaviour is provable against a real database and real object storage in CI.

**Non-goals**
- Prompt (sub-day) reclamation of *young* snapshots pruned by `maxVersions`. Bounded by the
  unrooted-manifest window (§3.3). A tombstone object could shorten it; deferred (§7).
- Changing the object key layout, `providerConfig.prefix` handling, or object-lock semantics.
- MSSQL/Hyper-V chain retention semantics (#5421) beyond keeping their objects safe.

## 3. Contract

Roots and reachability are computed per storage identity, as today. Three changes.

### 3.1 The server chooses the dedupe base and pins it

- **New column** `backup_jobs.base_snapshot_id varchar(255) NULL` — the storage snapshot id
  (same domain as `backup_jobs.snapshot_id` / `backup_snapshots.snapshot_id`), deliberately
  **not** a FK: a pin must never be silently nulled by a cascade, and the reaper, not the DB,
  releases it. Indexed partially `WHERE base_snapshot_id IS NOT NULL`.
- **Selection** (in `prepareBackupDispatchTargets`, per dispatched file/system_image target,
  including multi-target child rows): newest `backup_snapshots` row for
  `(device_id, config_id)` with `backup_type IN ('file','system_image')` (or NULL) and the
  same mode as the target, `expires_at IS NULL OR expires_at > now()`, whose owning job
  `status = 'completed'`. Ties → newest `timestamp`. No candidate → no base (full run).
- **Pin semantics:** a `backup_jobs` row with `status IN ('pending','running')` and a
  non-null `base_snapshot_id` pins that snapshot. Retention (§3.2) refuses to delete a
  pinned row. The pin is released by the job reaching any terminal status (result applied,
  cancelled, or reaped by `reapStaleBackupJobs`). Worst-case hold by a dead job = 24 h
  absolute timeout + reaper cadence; the column is never cleared, only made inert.
- **Payload:** `backup_run` gains `baseSnapshotId: string` (empty string = "server chose no
  base; run full"). Presence of the field, not its value, is the protocol switch.
- **Agent** (`backup.go:683-691`): if the payload carries `baseSnapshotId`, the agent is in
  *server-owned base* mode: non-empty → download `snapshots/<id>/manifest.json`, require
  `backupIdentity == runBackupIdentity()` (same D6 guard as today; mismatch → log + full
  run), use it as `prevSnapshot`; empty → full run. Payload without the field (older server)
  → legacy `previousManifest` listing, unchanged. Log the decision in both modes.
- **Agent never deletes:** remove the `Retention > 0 && !incrementalDedupeActive` prune
  branch (`backup.go:780-806`) and stop honouring `BackupConfig.Retention` for deletion
  anywhere in the run path. The agent.yaml manager fallback keeps working for uploads but can
  no longer reclaim anything. Closes the "legacy writer" hole from the quorum.
- **Publication:** `applyBackupCommandResultToJob` persists `parent_snapshot_id` (uuid of the
  row whose `snapshot_id = result.snapshot.baseSnapshotId`, same config; NULL if absent) and
  `is_incremental = referencedFiles > 0 || formatVersion >= 2`. Reconcile adoption does the
  same from the manifest's `baseSnapshotId`. Informational only — reachability is by
  `backupPath`, not by parent links — but it makes the chain visible and testable.

### 3.2 Retention refuses to delete pinned rows

`cleanupExpiredSnapshots` (both the `expiresAt` pass and the `maxVersions` pass) excludes a
row when either holds:
- `EXISTS backup_jobs WHERE base_snapshot_id = row.snapshot_id AND status IN
  ('pending','running')` (backup pin), or
- `EXISTS restore_jobs WHERE snapshot_id = row.id AND status IN ('pending','running')`
  (restore pin), or
- `EXISTS recovery_tokens WHERE snapshot_id = row.id AND expires_at > now() AND
  session_status <> 'completed'` (bare-metal recovery pin — a BMR session downloads the
  manifest and every object over minutes to hours; verify the exact status/expiry columns
  in `schema` before implementing).

Skipped rows are counted (`skippedPinned`) and retried next run. Because the row survives,
its manifest and everything it references stay in the root set (§3.3) — the pin is enforced
once, upstream, instead of being re-derived inside the sweep. The `deleteSnapshotRow`
docstring is rewritten to state this contract.

`restore_jobs` that never finish do not pin forever: `staleCommandReaper.ts:220-239` already
flips `pending|running` restores to `failed` when their `device_commands` row is reaped.
Recovery tokens are bounded by their own `expires_at`.

### 3.3 GC roots = retained rows + young unrooted manifests; old unrooted prefixes are garbage

`sweepStorageIdentity` mark set becomes:

```
roots = { snapshot_id of EVERY backup_snapshots row on this identity }        (all types, §3.4)
      ∪ { listed manifest-bearing prefixes with no row whose manifest.json
          lastModified is newer than BACKUP_GC_UNROOTED_MANIFEST_MAX_AGE_MS }
live  = ⋃ over roots of { manifest key } ∪ { files[].backupPath }
```

Sweep rules per listed prefix group:
- **Rooted prefix** (in `roots`): unchanged — delete only objects not in `live` and older
  than `BACKUP_GC_GRACE_MS`.
- **Unrooted, manifest-bearing, manifest older than the window:** delete every object in
  the prefix that is not in `live` (objects a retained child still references stay), the
  manifest **last** within the prefix so a cap-truncated sweep leaves a still-legible prefix.
- **Manifest-less prefix:** unchanged 9-day rule (in-progress upload protection, coupled to
  the agent journal age).

`BACKUP_GC_UNROOTED_MANIFEST_MAX_AGE_MS` defaults to `BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS`
(9 d), env-overridable with the same production floor/warn pattern as `BACKUP_GC_GRACE_MS`,
and resolved **per run** (not at module load) so the lab and the integration test can set it.

Why this replaces the FIX 5 guarantee without a tombstone:
- A base chosen by the server is pinned → its row survives → it is a root. The "listed
  manifest with no row" case that FIX 5 protected can now only be (i) an expired snapshot
  (reclaim it — that is the point), (ii) a run that published but whose result the server
  never applied (reaped; adoptable via reconcile for 9 days, then garbage), or (iii) a base
  chosen by a **legacy helper** that still lists the bucket. For (iii) the newest
  identity-matching manifest is, by construction of retention, the newest retained
  snapshot except in degenerate configs (`maxVersions`=0-ish); residual risk accepted and
  documented, removed when the legacy listing path is dropped one release later.
- Reclamation lag for an expired snapshot is one GC cycle when it is older than the window
  (the normal case — retention periods are days to years), and at most the window for a
  young `maxVersions` prune.

### 3.4 Every row is a root, whatever its `backup_type`

Verified (subagent, file:line in §8): **all four modes write `snapshots/<id>/manifest.json`
with a `files[].backupPath` manifest** the GC parser already accepts — file
(`snapshot.go:390,819`), system_image (same manager; state artifacts additionally under
`snapshots/<id>/system-state/`), hyperv (`agent/cmd/breeze-backup/exec_hyperv.go:240,421`),
mssql (`exec_hyperv.go:78-81,532`, literally a `backup.Snapshot`). The retention comment at
`backupRetention.ts:1057-1065` is wrong; those rows are protected today only by the
every-listed-manifest rule that this design removes. Therefore:

- `retainedSnapshotIds` = **every** `backup_snapshots` row whose `config_id` is on the
  identity, no `backup_type` filter. Dropping the filter is a hard prerequisite of §3.3 —
  with it, every Hyper-V/MSSQL/system-image snapshot older than the window would be swept.
- Manifest fetch/parse failure for any root aborts the identity, uniformly (fail-closed, as
  today). Hyper-V's manifest is a distinct Go type but structurally `files[].backupPath`.
- Non-file modes never reference other prefixes (no dedupe), so their reachability is
  self-contained; chains (`backup_chains`) are one pointer row per database, and each
  differential/log run is its own `backup_snapshots` row, so chain members are roots by
  the same rule. Chain-consistency of *retention* (expiring a full while its diffs live)
  is #5421, not this spec.
- Vault replication (`local_vaults`, agent `vault_path`) is a device-local directory, not a
  `backup_configs` identity; GC never lists it. Unaffected.

## 4. Data model & registries

- Migration `apps/api/migrations/2026-10-15-140005-backup-jobs-base-snapshot-pin.sql`
  (newest shipped is `2026-10-15-140004-…`; the date ceiling is ahead of real time, so a
  today-dated file would replay first): `ALTER TABLE backup_jobs ADD COLUMN IF NOT EXISTS
  base_snapshot_id varchar(255)`, partial index `WHERE base_snapshot_id IS NOT NULL`. DDL
  only, no `breeze.scope` needed.
- `services/tenantExportPolicyRegistry.ts:119` `backup_jobs` → add `base_snapshot_id` to
  `included` (tenant identifier, not secret). No new table → no cascade-list change.
- Drizzle schema + `pnpm db:check-drift`.

## 5. Failure modes considered

| Scenario | Outcome under this contract |
|---|---|
| Run in flight, base row expires | Row pinned → skipped by retention → still a root. |
| Run reaped (stall/24 h) after publishing manifest, result lost | Pin released; child is an unrooted young manifest → root for 9 d (reconcile can adopt); after that its exclusive objects are garbage; objects a later retained child references stay live. |
| Restore in flight, snapshot expires | Restore pin → row kept → root. |
| Legacy helper lists bucket for base | Picks newest identity-matching manifest = newest retained row in practice; documented residual risk. |
| Agent.yaml manager fallback | Uploads fine; can no longer delete (prune branch removed). |
| Base manifest 404 at agent | Full run (logged). Server pin harmless. |
| Object-lock refuses manifest delete | `failedKeys` logged as today; prefix retried each run. |
| Cap hit mid-prefix | Manifest deleted last; partial prefix is either still manifest-bearing (retried) or manifest-less-old (retried). |
| NULL `config_id` row | Still wedges the run (unchanged, fail-closed). |
| Multi-target job | Each dispatched child row carries its own pin. |

## 6. Verification

- **Unit** (`backupRetention.test.ts`): replace `:665` and `:699-752` with (a) "unrooted
  manifest older than window → prefix swept, manifest last, live-referenced objects kept",
  (b) "unrooted manifest younger than window → root", (c) "pinned row skipped by both
  retention passes", (d) "restore-pinned row skipped", (e) hyperv/mssql/system_image rows are roots and their
  manifests parse, (f) window knob resolution per run. Worker/dispatch tests for base selection
  and payload field; persistence tests for `parent_snapshot_id`/`is_incremental`; reaper test
  that a reaped job releases the pin.
- **Integration (real DB + `local` provider, CI shard):** seed identity with base B and
  incremental child C referencing B's objects plus B-exclusive object X; expire B; run
  retention + sweep with window=0 → X and B's manifest gone, C's manifest and every
  `backupPath` it lists present, B's row gone, C's row intact. Second case: pin B via a
  running job → nothing reclaimed. Third: restore pin.
- **Agent** (`incremental_test.go`): server-owned mode with valid base, identity mismatch,
  empty base, 404; legacy mode unchanged; prune branch gone (`snapshot_lifecycle_test.go`).
  `backupAgentContract.test.ts` extended for the payload field name.
- **Lab (manual, campaign harness, MinIO):** repeat cell R4 with
  `BACKUP_GC_UNROOTED_MANIFEST_MAX_AGE_MS=1000` — expired base reclaimed, retained
  incremental restores byte-identical (cell F2 hashes).

## 7. Deferred / follow-ups

- Tombstone object (`snapshots/<id>/expired.json`) for prompt reclamation of young prunes.
- Drop the agent's legacy bucket-listing base path one release after this ships.
- Helper capability gate (`backupHelperCapabilities.ts`) is **not** needed: unknown payload
  fields are ignored by old helpers.
- D15 (`system-state/` prefix) must extend `markLiveBackupObjects` — already in its plan.
- Storage accounting UI ("reclaimed bytes") — out of scope.

## 8. Verification log

- [x] Hyper-V / MSSQL layout confirmed 2026-09-09 (Explore subagent): system_image `bmr.go:222`/`snapshot.go:819`; hyperv `exec_hyperv.go:240,421-422,437`; mssql `exec_hyperv.go:78-81,514,532-533`; `backupType` stamping `backupResultPersistence.ts:1127-1133`; vault `vault.go:77-78` + `routes/backup/vault.ts:92` (`local_vaults`).
- [ ] Codex `xhigh` read-only review of this spec.
