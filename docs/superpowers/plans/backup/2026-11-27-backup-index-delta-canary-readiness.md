---
title: Snapshot file index delta format, canary readiness (#12741, plan W5)
parent_plan: 2026-11-25-backup-snapshot-index-checkpoint-delta.md
tracking_issue: 12737
wave_issue: 12741
status: measured; canary not started (owner decision)
---

# Snapshot File Index Delta Format: Canary Readiness

What the owner needs to turn `BACKUP_INDEX_DELTA_PUBLISH` on for one organization, watch it, roll it back and decide on `on`. The measurements behind it are in the plan's W5 section ("W5 measurement") and in PR #12815. Nothing here has been done in any hosted region.

## Prerequisites

1. **The build includes the W5 fixes.** Without them a canary slows every org's snapshot index reads on that database, not only the canary org's:
   - Readers run with JIT off (`disableJitForIndexReads`, `services/backupSnapshotIndexEntries.ts`). Without it, once any checkpoint exists, a server with JIT support compiles every index read: a 5,000-row selection page went from about 3 ms to about 110 ms (about 1 s past `jit_optimize_above_cost`), for rows-format snapshots too.
   - The publisher's content check is linear (`treeDigestQuery`). Without it, the first delta publishes on a database whose file-index statistics were taken while the tables were nearly empty can take seconds to hours inside the publish transaction, holding the snapshot and lineage locks.
2. **The Postgres major is one that was measured:** 16 (the shipped default), 17 or 18. Plans matched on all three (W5 measurement).
3. **Both variables reach the api and the worker.** The shipped compose files map them already (`docker-compose.yml` and `deploy/docker-compose.prod.yml`, in the shared api environment block). A deployment that maintains its own compose file must add both to the `api` and `worker` services:

   ```yaml
   BACKUP_INDEX_DELTA_PUBLISH: ${BACKUP_INDEX_DELTA_PUBLISH:-off}
   BACKUP_INDEX_DELTA_PUBLISH_ORG_IDS: ${BACKUP_INDEX_DELTA_PUBLISH_ORG_IDS:-}
   ```

   The api hydrates on reads; the worker hydrates in the background and runs checkpoint GC. A flag set on one service only gives mixed formats for one org, which is safe (the reader is never flagged) but is not a canary.
4. **The W2 migrations are applied** (they are in the release that ships W2; the deploy caution is in the release notes).
5. **A baseline is taken** for the canary org before the flag changes (the queries under "What to watch"), so growth can be compared.

## Turning it on for one organization

```text
BACKUP_INDEX_DELTA_PUBLISH=canary
BACKUP_INDEX_DELTA_PUBLISH_ORG_IDS=<the canary org's uuid>
```

Set both on the api and the worker, then recreate both containers (the value is read on every call, but a container's environment changes only when it is recreated). Each process logs once if the value is not `off`, `canary` or `on` (`[backup-index] BACKUP_INDEX_DELTA_PUBLISH=… is not one of off, canary, on; treating it as off`) or if `canary` lists no valid org (`… lists no valid org; every org publishes rows`). Either line means the canary is not running. A third, `[backup-index] BACKUP_INDEX_DELTA_PUBLISH_ORG_IDS entry "…" is not a UUID; ignoring it`, means that entry is not in the canary.

Only new hydrations change format. Existing snapshots keep `rows` until they re-hydrate. A snapshot publishes `delta` only when its config id, storage identity and backup type are all known (R5); others stay `rows`.

## What to watch, and for how long

**How long:** one retention cycle of the canary org (plan gate G5): long enough for its oldest delta snapshots to be retired by retention and their checkpoints collected by GC at least once. With 30 daily restore points, about 30 days.

**Log lines (api and worker):**

| Line | Meaning | Expected |
|---|---|---|
| `[BackupSnapshotIndexPublish] The backup lineage of org …, device …, config … has N unreferenced checkpoints (bound 3); snapshot … publishes its file index as rows until checkpoint GC collects them` | The per-lineage bound tripped; that snapshot was published as `rows` | Never in daily use (measured: at most 1 unreferenced checkpoint per lineage before GC, 0 trips in 30 steady days for every churn model). Expected in bursts after an org merge or a device move followed by re-hydration of many old snapshots (measured: 25 of 30 re-hydrations at 1% daily churn). Investigate any other occurrence. |
| A hydration failing with `snapshot index delta does not reproduce the manifest: …` | The D9 count or content check refused a publish; it rolled back and the previous index stayed | Never. Any occurrence is a bug: stop the canary (flag off) and keep the snapshot id. |
| `[BackupTreeCheckpointGc] Deleting checkpoint … passed its statement timeout; skipped for this run` | A checkpoint delete took more than 60 s | Never (a 1M-entry delete measured well under a second). Repeats mean storage or lock trouble. |
| `[BackupTreeCheckpointGc] Deleting checkpoint … failed; skipped for this run` (also in error tracking) | Any other delete error | Never. |
| `[BackupTreeCheckpointGc] Checkpoint … is still referenced by a snapshot …` | A pointer was set without the publisher's lock | Never. |
| `[BackupSnapshotCleanupWorker] File-index checkpoint GC failed; the next run tries again` | Candidate selection failed | Never. |
| A device org move failing with `deadlock detected` (`40P01`), or a hydration recorded as a retryable `provider_error` with that message | A publish that wrote a new checkpoint met a device org move (reproduced in W5, both orders) | Rare: only when a move of the canary org's device coincides with a checkpoint publish of that device. A lost publish retries on the next read; a lost move must be repeated by the user. |

**GC outcomes:** the snapshot cleanup job's return value carries `checkpointGc: { deleted, refused, timedOut, failed }` (or `'error'`). Expected: `refused`, `timedOut` and `failed` always 0; `deleted` roughly the canary org's checkpoint creation rate.

**Database (read-only, system scope), daily:**

```sql
-- Formats of the canary org's snapshots.
SELECT file_index_format, file_index_status, count(*)
  FROM backup_snapshots WHERE org_id = :canary GROUP BY 1, 2;

-- Its checkpoints: how many, how many entries, how many no snapshot uses.
SELECT count(*) AS headers, sum(entry_count) AS entries,
       count(*) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM backup_snapshots s WHERE s.file_index_checkpoint_id = c.id)) AS unreferenced
  FROM backup_tree_checkpoints c WHERE c.org_id = :canary;

-- Lineages at or near the bound (more than one unreferenced header).
SELECT device_id, config_id, count(*) AS unreferenced
  FROM backup_tree_checkpoints c
 WHERE org_id = :canary
   AND NOT EXISTS (SELECT 1 FROM backup_snapshots s WHERE s.file_index_checkpoint_id = c.id)
 GROUP BY 1, 2 HAVING count(*) > 1;

-- Table sizes (whole database: the tables are shared).
SELECT relname, pg_size_pretty(pg_total_relation_size(oid))
  FROM pg_class WHERE relname IN ('backup_snapshot_files', 'backup_tree_checkpoint_entries', 'backup_tree_checkpoints');

-- Dead space in the checkpoint tables (GC deletes whole checkpoints; autovacuum reclaims them).
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze
  FROM pg_stat_all_tables WHERE relname IN ('backup_tree_checkpoint_entries', 'backup_tree_checkpoints');
```

`n_dead_tup` on the entries table should fall back after each autovacuum. A steady climb means autovacuum is not keeping up with checkpoint GC (measured: VACUUM of the table after a 1M-entry delete took 1.4 s).

**Readers:** browse, search, count and key checks for the canary org's delta snapshots should answer within about 1.5x of its rows snapshots (measured after the W5 fixes: equal at low drift). A selective-restore walk of a delta snapshot near the rebase threshold is slower: about 1.5x at 2% drift and 1.9x to 2.8x at 5% (6.9 to 9.3 s for 1M entries, inside the 30 s deadline), and on a database with thousands of small checkpoints a 1M-entry walk took 11.5 to 16.4 s. Stop if a walk times out, or if a ratio is clearly worse than these (the threshold itself is gate G4).

## Rollback

1. Set `BACKUP_INDEX_DELTA_PUBLISH=off` (or remove the org from the list) on the api and the worker, and recreate both.
2. New hydrations publish `rows` again. **Snapshots already published as `delta` stay readable in every reader**: the reader is never flagged. Pinned by `backupSnapshotIndexPublish.integration.test.ts`: `flag off after deltas exist: …` and `rollback: with the flag off, a delta with tombstones and adds reads its manifest in every reader, and GC collects only after the deltas retire`.
3. Checkpoint GC keeps running whatever the flag says and never deletes a checkpoint a snapshot still uses. As retention retires the delta snapshots, their checkpoints are collected.
4. Optional, only to retire every delta at once: set those snapshots' `file_index_status` to `none` in system scope; each re-hydrates as `rows` on its next use, and GC then collects the unreferenced checkpoints (the newest of each lineage after the 7-day orphan TTL). Run it batched with a row-count warning. It is a production write and needs its own owner approval (plan W5 rollback).
5. Do not revert the W3 or W4 code once a `delta` snapshot exists: the read layer must stay.

## From canary to `on`

All of these, over the full retention cycle:

- Zero D9 refusals (`does not reproduce the manifest`).
- GC: `refused`, `timedOut` and `failed` always 0, and the canary org's unreferenced headers at most one per lineage after each cleanup run.
- Bound warnings only after an org merge or device move, if any.
- The canary org's file-index storage (its snapshots' `backup_snapshot_files` rows plus its checkpoint entries) below what the same restore points cost in `rows`, by the ratio the W5 lineage model predicts for its churn (measured over a 30-snapshot lineage of 100,000 entries: about 3x smaller at 1% daily churn over different files, about 19x smaller when the same 1% changes every day, no gain at 5% daily churn or more).
- No reader regression on the canary org (above), and none on other orgs of the same database.
- No new device-move failures beyond the rare deadlock described above.

Then: `BACKUP_INDEX_DELTA_PUBLISH=on` on the hosted edition first, one region at a time. Changing the code default to `on` for self-hosters is plan W5 Task 3, a separate change after that soak.
