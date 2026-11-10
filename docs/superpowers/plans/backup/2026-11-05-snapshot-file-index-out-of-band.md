---
anchor_issue: 11026
related: [3001, 6464, 8230, 11014, 11040, 11109]
baseline_commit: c9ee81b574
tracking_issue: LanternOps/breeze#11156 (from #11026)
---

# Snapshot File Index Out of Band Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every snapshot with files can be browsed and selectively restored, with no false "browsing is unavailable" warning, and a wrong listing is never shown.

**Architecture:** `snapshots/<id>/manifest.json` already is the out-of-band file index. The helper uploads it on every run, the snapshot attestation records its digest, and the W09 hydrator already turns it into `backup_snapshot_files` rows. This plan closes the gaps around that path: browse never asks for an index, readers ignore index state, the warning is written before the outcome is known, the hydrator buffers the whole manifest, and the attestation verifier treats a large manifest as an integrity failure. It adds no index object, no result field, no table and no column. The only agent work is a server-requested manifest upload for destinations the API cannot read.

**Tech Stack:** Hono, Drizzle, BullMQ, Vitest, Astro + React, Go. One new npm dependency: a streaming JSON parser (W02 T1).

**Spec:** None (`track:plan`). The requirements are issue #11026, and the decisions are in this document.

## Findings that changed the design

Each claim is labelled **verified** (read in code or measured), **inferred**, or **not checked**.

1. **Verified:** the issue's premise that the index has no out-of-band home is out of date. `publishSnapshotManifest` (`agent/internal/backup/snapshot.go:1793`) uploads every entry, and `hydrateSnapshotFileIndex` (`apps/api/src/services/backupSnapshotFileIndex.ts:659`) reads it back.
2. **Verified:** the warning is unconditional. `emptySnapshotFiles` (`agent/cmd/breeze-backup/result_bounds.go:589`) says browsing is unavailable before the server has tried, and persistence stores the text as the job's `error_log` (`backupResultPersistence.ts:1064`) whatever hydration later does.
3. **Verified:** `GET /snapshots/:id/browse` neither requests hydration nor reads index state (`routes/backup/snapshots.ts:278-297`). Snapshots persisted before eager hydration, and snapshots whose request or job failed, stay empty until an unrelated restore asks.
4. **Verified:** `RestoreWizard` ignores `manifestUnavailable` and reports "No files available" (`RestoreWizard.tsx:683`).
5. **Verified:** browse and selective restore read rows whatever the index state, including a snapshot whose attestation failed (`backupSnapshotBrowse.ts:108`, `routes/backup/restore.ts:245`).
6. **Verified:** a hydration write is one transaction. `withSystemDbAccessContext` opens it (`db/index.ts:929`) and the nested `db.transaction` calls are savepoints, so readers never see a partial batch. The comment at `backupSnapshotFileIndex.ts:582` claiming per-batch transactions is wrong.
7. **Verified:** the attestation verifier finishes a manifest over `MANIFEST_FETCH_MAX_BYTES` (200 MiB) as `mismatch` (`backupAttestationVerify.ts:218`), and terminal outcomes are immutable (`2026-11-08-110000-backup-snapshot-attestations.sql:200`). A legitimate snapshot of about 400k files therefore fails integrity permanently, which blocks both its index and its restore.
8. **Verified:** directory selection expands to files and refuses more than 10,000 (`backupSelectedPaths.ts:34`), even though the agent already matches directory prefixes on both separators (`agent/internal/backup/restore.go:617`).
9. **Verified:** the API cannot read a device-local destination. `fetchLocalObjectBytes` reads the API host's disk, so a local snapshot over the inline budget has no index at all, and hydration reports `manifest_missing`.
10. **Measured** (synthetic Windows entries, laptop, idle Postgres 16; treat as ratios, not production figures):
    - A manifest entry is about 500 bytes, so the inline budget drops the index near **10k entries**, not 18k. The 17,950 in the issue is one instance of a much lower threshold, which makes this ordinary-sized servers' problem.
    - 400k entries is 201 MB, which is the current cap. `JSON.parse` takes about 260 ms, but process RSS reaches about 1.2 GB. Memory is the constraint, not CPU.
    - 1.1M rows cost about 578 bytes each including indexes, about 635 MB per snapshot.
    - The current browse SQL at 1.1M rows takes 1.9 s at the root and 0.45 s at depth. A substring search miss takes 1.6 s. These are acceptable for a rare operation, so no tree table is planned.
11. **Not checked:** which of these paths the reporting customer actually hit. The read-only production query could not run because production access needs an interactive approval this session cannot complete. W01 T0 is that query. The fix covers every candidate path, but the specific cause stays inferred until T0 runs.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | The manifest is the index. No sidecar object and no result pointer | A sidecar is a second source of truth needing its own attestation role, requires an agent release, and does nothing for existing snapshots. The key is already derivable from the snapshot id, and `manifestSha256` is already the recorded hash |
| D2 | No chunking over the result channel | It adds reassembly, retry and completeness tracking to a channel deliberately bounded so the terminal status always lands (#3001). It also cannot serve existing snapshots |
| D3 | Backfill is lazy: first browse requests hydration. No sweep | A sweep downloads every retained manifest and writes rows for snapshots nobody will open |
| D4 | Keep one write transaction per hydration | It already gives atomic visibility with no new state. A `building` status or generation column would only be needed for separately committed batches, and 1.1M rows inserts in about a minute. Concurrency stays 2 |
| D5 | The write transaction takes the snapshot row lock first, then re-checks claim, tenancy and attestation once | Matches persistence's lock order, removes a deadlock, and stops a stale worker or org move from publishing |
| D6 | Spool the manifest to a private temp file while hashing, validate fully in a first pass, write rows in a second | Keeps today's rule that nothing is written until the bytes are verified, without holding them in memory |
| D7 | New stream cap of 2 GiB (about 4M entries). Other readers keep 200 MiB | Bounds disk use. Over the cap, hydration ends as `manifest_too_large`. The verifier defers rather than deciding, because size is not evidence of tampering |
| D8 | Failure codes only reach clients, never `file_index_error` text | That text can carry storage keys and provider messages |
| D9 | Directory selection sends the stored-form directory prefix | The agent already honours it, it removes the 10,000-file limit, and it keeps command payloads small. Mixed-separator directories fall back to capped expansion |
| D10 | Device-local destinations use a server-requested command that streams the original manifest bytes to a dedicated endpoint | Reuses the same parser and digest binding as S3, works for existing snapshots, and changes no result shape |
| D11 | No schema change in any wave | New failure codes are values in an existing text column, and the drop count lives in `metadata` (already `excludedOpen`). `docs/agents/tenancy-rls.md` registration lists do not apply |

### What the issue asked for, and where it went

| Requirement | Resolution |
|---|---|
| Backward compatibility: old inline results | Unchanged. Inline rows under the budget still persist as `agent` |
| New agent, old server | Results are byte-compatible apart from note wording. An old server never sends the new command |
| Old agent, new server | Fully served by W01 and W02 on S3. On local destinations the unknown command gives an honest "update the agent" state |
| Budget semantics | The result still carries `files` inline up to the budget and `files: []` above it. No new field |
| Hard caps | Manifest 2 GiB. Browse page 1,000. Search 100 per page. Selections 10,000. Expansion fallback 10,000 |
| Integrity | `manifestSha256` from the attestation, checked before any row is written. A mismatch reads as unavailable, never as a listing |
| Unattested snapshots | Structural validation and the manifest id check only, as today |
| Tenancy | Existing `authorizeRouteResilienceResources` plus org check on every route. Storage is read only by the API with server-resolved config. No storage URL reaches a browser |
| Telemetry | Counters in W01 T5 and a before-and-after query in T0 |

## Quorum

Independent `codex exec` (gpt-6-astra, xhigh, read-only), asked to answer from its own reading before critiquing this position. Its claims were re-checked in code before being adopted.

- **Agreed:** the manifest as the index, with sidecar and result chunking rejected. Lazy recovery on browse. State-driven messaging. SQL-side or streamed selection with stored directory prefixes, preserving ambiguity semantics.
- **Changed because of it:**
  - Dropped my planned `building` status. I had claimed readers could see partial batches, and that was wrong: finding 6 was verified after this review.
  - Dropped my "failed rows are always agent rows" rule, since failed rows can be server-built. The reader gate now keys on attestation state.
  - Added the publish fence for stale workers and tenancy moves (D5).
  - The verifier must keep the full-run reference check while streaming, not just the digest.
  - Local upload sends original manifest bytes rather than my proposed paged rows, which preserves digest binding and reuses one parser.
  - GC and reconcile are named as blockers to claiming million-file support, not just follow-ups.
  - Row-count assertions compare against entries with an object, since hydration skips directories and symlinks.
- **Rejected:** nothing outright. Eviction coordination with active restores is recorded under Open Decision 4 rather than designed here.
- **Unresolved:** repairing any existing false `mismatch` rows, because the answer depends on production data. See Open Decision 5.

## Global Constraints

- Branch off fresh `origin/main`. PR base is `main`, never stacked.
- Public repo: no customer names, hosts, IPs or production numbers in code, comments, PRs or docs.
- No migration, table or column in any wave (D11). If a task seems to need one, stop and report.
- `MANIFEST_STREAM_MAX_BYTES = 2 * 1024 * 1024 * 1024`. `MANIFEST_FETCH_MAX_BYTES` stays 200 MiB for every other reader.
- Hydration worker concurrency stays 2.
- Browse `statement_timeout` 15 s, search 10 s, set with `SET LOCAL` inside the request's context.
- Lazy re-request cooldown for retryable failures: 15 minutes, measured from `file_index_hydrated_at`.
- New en locale keys go in all eight locales under `apps/web/src/locales/*/backup.json`.
- Web mutations use `runAction`.
- Typecheck without a pipe and check the exit status. A pipe to `tail` masks a heap OOM as success.

## Review Focus

1. **An org move or a superseded worker during hydration.** It must not publish `complete` over the moved or newer state. Test in W01 T4.
2. **Selection of a folder and a file sharing a name, or POSIX paths containing `\`.** Both must keep today's semantics, including `ambiguous` refusals. Test in W02 T4.
3. **Temp disk full or spool failure mid-download.** It must end as a retryable `provider_error`, leave existing rows intact, and remove the spool. Test in W02 T2.
4. **A truly empty snapshot.** It must read as an empty folder, never "building" forever. Test in W01 T2.
5. **Long paths or non-UTF-8-looking names in search and prefix handling.** Results must match stored paths exactly, and a `%` in the query must be literal. Test in W02 T5.

---

## Waves

| Wave | Delivers | Ships without |
|---|---|---|
| W01 API reader, browse UI, backfill | Every ordinary S3 snapshot browsable, including existing ones. Warning gone. Honest states | Agent release |
| W02 Stress shape | Hydration, verification, selection and search at 1.1M entries | Agent release |
| W03 Helper manifest upload | Device-local destinations over the inline budget | Needs W01 and W02 deployed first |
| W04 Release note and docs | Operator docs, follow-up issues | Written after whichever waves land |

The agent wave moved from first to third on purpose: under D1 the S3 fix needs no agent change, and customers should not wait for a release train.

W01 and W02 touch the same files, so run them serially. W03's API half touches the same hydrator seam, so it follows W02.

---

## W01: API reader, browse UI, backfill

**Brief lines (verbatim):**

- "Open the PR, run `/pr-review-toolkit:review-pr`, post the review summary, STOP. Do not merge, do not close the issue."
- "If the premise does not hold, ABORT and report — do not improvise."
- "Do not start background CI pollers and never `pkill -f`; watching CI is the orchestrator's job."

**Premise to check:** `hydrateSnapshotFileIndex` still reads the manifest, and browse still does not request hydration.

**Execution split.** PARALLEL GROUPS: {T1}, then {T2, T4}, then {T3, T5}, then {T6}. T0 is not fixer work. Sonnet-eligible: T1, T5. Opus: T2, T3, T4, T6.

**Rigor: high.** Backup restore path and integrity state.

### W01 T0: Production diagnostic (orchestrator, needs Todd's prod access)

Read-only. The results stay in private notes, never in the PR.

```sql
-- Index state by destination kind, last 30 days
SELECT split_part(coalesce(storage_identity,'null'),'::',1) kind, file_index_status, count(*)
FROM backup_snapshots WHERE timestamp > now()-interval '30 days' GROUP BY 1,2 ORDER BY 1,2;
-- Failure classes
SELECT split_part(file_index_error,':',1), count(*) FROM backup_snapshots
WHERE file_index_status='failed' GROUP BY 1 ORDER BY 2 DESC;
-- Bounded results: the telemetry baseline
SELECT count(*) FILTER (WHERE error_log LIKE '%snapshot file index omitted%'), count(*)
FROM backup_jobs WHERE created_at > now()-interval '30 days' AND status IN ('completed','completed_with_errors','partial');
-- What happened to bounded snapshots
SELECT s.file_index_status, split_part(coalesce(s.file_index_error,''),':',1),
  split_part(coalesce(s.storage_identity,'null'),'::',1), count(*), max(s.file_count)
FROM backup_jobs j JOIN backup_snapshots s ON s.job_id=j.id
WHERE j.error_log LIKE '%snapshot file index omitted%' GROUP BY 1,2,3 ORDER BY 4 DESC;
-- Row storage, for Open Decision 4
SELECT pg_size_pretty(pg_total_relation_size('backup_snapshot_files'));
-- False integrity failures, for Open Decision 5
SELECT verify_error, count(*) FROM backup_snapshot_attestations
WHERE verify_error LIKE 'manifest%too_large' GROUP BY 1;
```

- [ ] Run against both regions and record which path the reporter hit. If it is none of those in Findings, stop and return to planning before W01 merges.

### W01 T1: Inline-drop note helper

**Files:** Create `packages/shared/src/utils/backupFileIndexNote.ts` and `.test.ts`. Export from the utils barrel.

**Interfaces, produces:** `stripInlineIndexDropNote(warning: string | null | undefined): { warning: string | null; droppedEntries: number | null }`

- [ ] **Step 1: Write the failing tests.** Table-driven:
  - The note alone (`bounded: snapshot file index omitted (17950 entries): the result exceeded the 4934464 byte server result budget, so per-file restore browsing is unavailable for this snapshot`) returns `{ warning: null, droppedEntries: 17950 }`.
  - `vss warning || bounded: <note>` returns `{ warning: 'vss warning', droppedEntries: 17950 }`.
  - `bounded: <note>; detail field(s) omitted (x): …` keeps the other note and its `bounded: ` label.
  - The `agent IPC budget` variant matches.
  - The W03 wording matches: `snapshot file index not sent with the result (17950 entries): the result exceeded the 4934464 byte server result budget; the server reads it from the snapshot manifest`.
  - A warning without the note, and `null`, pass through unchanged with `droppedEntries: null`.
- [ ] **Step 2:** Run `cd packages/shared && npx vitest run src/utils/backupFileIndexNote.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement. Handle the `resultNoteMarker` (` || bounded: `), `resultNoteLabel` (`bounded: `) and `; ` joiner forms from `result_bounds.go:127-131`.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(shared): recognise the snapshot index drop note (#11026)`.

### W01 T2: Reader gate and index view

**Files:** Create `apps/api/src/services/backupSnapshotIndexView.ts` and `.test.ts`. Modify `backupRestoreIntegrity.ts` (add the SQL condition next to `boundIndexCondition`), `backupSnapshotBrowse.ts`, `routes/backup/restore.ts:245`, `aiToolsBackup.ts:771`. Test: `backupSnapshotBrowse.integration.test.ts`, `backupIndexAttestationBinding.integration.test.ts`.

**Interfaces, produces:**
```ts
type SnapshotIndexView =
  | { state: 'ready' }
  | { state: 'building' }
  | { state: 'unavailable'; failure: HydrationFailure | 'never_indexed'; retryable: boolean };
snapshotIndexView(input: {
  status: FileIndexStatus; manifestSha256: string | null; error: string | null;
  integrityStatus: string | null; attestation: IndexAttestation;
  hasRows: boolean; fileCount: number | null;
}): { view: SnapshotIndexView; shouldRequestHydration: boolean }
readableIndexCondition(): SQL  // same-statement predicate over backup_snapshots LEFT JOIN attestations
```

The rule table (`shouldRequestHydration` is `req`). A row marked with an asterisk is cooldown-gated:

| Status | Attestation | Rows | View | req |
|---|---|---|---|---|
| `complete` | bound | any | ready | no |
| `complete` | mismatch or refused | any | unavailable `attestation_failed` | no |
| `complete` | other bytes | any | building | yes |
| `agent` | not failed | any | ready | no |
| `none` | not failed | yes | ready | no |
| `none` | not failed | no, `fileCount` > 0 | building | yes |
| `none` | not failed | no, `fileCount` 0 or null | ready | no |
| `hydrating` | not failed | yes | ready | no |
| `hydrating` | not failed | no | building | no |
| `failed` | attestation failure code | any | unavailable, not retryable | no |
| `failed` | other code | yes | ready | no |
| `failed` | retryable code | no | unavailable, retryable | yes* |
| `failed` | terminal code | no | unavailable, not retryable | no |

Two rules override the table, whatever the status:
- An attestation in `mismatch`, or `integrity_status = 'attestation_failed'`, gives unavailable `attestation_failed` with no request.
- Rows whose recorded `file_index_manifest_sha256` differs from the attestation's digest are never readable. This covers a `hydrating` or `failed` row still holding rows built from other bytes. Inline rows have a null digest and are unaffected.

`readableIndexCondition` is true exactly for rows whose view may be `ready`.

- [ ] **Step 1: Write the failing unit tests.** One case per table row, plus: `failure` is a code and never contains `file_index_error`'s free text; a `failed` retryable row inside the 15-minute cooldown has `shouldRequestHydration: false`.
- [ ] **Step 2: Write the failing integration tests.** A snapshot with rows and a `mismatch` attestation returns no browse entries, and selective restore answers 409. A snapshot at `complete` with rows built from other bytes returns no entries. An `agent` snapshot lists normally.
- [ ] **Step 3:** Run `cd apps/api && npx vitest run src/services/backupSnapshotIndexView.test.ts`. Expected: FAIL. Then run the integration files per `docs/agents/testing.md` (`pnpm test-stack up`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/backupSnapshotBrowse.integration.test.ts`). Expected: FAIL.
- [ ] **Step 4:** Implement the view function and condition. Add `readableIndexCondition` to the listing statement (`listSnapshotDirectory`) and both selective-restore reads, so the check and the rows come from one statement.
- [ ] **Step 5:** Re-run both. Expected: PASS.
- [ ] **Step 6:** Commit: `fix(backup): only list a snapshot's files from a trustworthy index (#11026)`.

### W01 T3: Browse requests hydration, plus rebuild

**Files:** Modify `routes/backup/snapshots.ts`, `jobs/backupSnapshotFileIndexWorker.ts`, `routes/backup/restore.ts`. Test: `routes/backup/snapshots.test.ts`, `jobs/backupSnapshotFileIndexWorker.test.ts`.

**Interfaces:**
- Consumes `snapshotIndexView`.
- Produces on `GET /snapshots/:id/browse`: the existing fields plus `index: SnapshotIndexView`. `manifestUnavailable` is unchanged for older web bundles.
- Produces `POST /snapshots/:id/file-index/rebuild`: `202 { index }`, or `409 { error, code: 'attestation_failed' }`.
- `HydrationJobData.reason` gains `'browse'` (in `FULL_INDEX_REASONS`). Job data gains `force?: boolean`, passed to `hydrateSnapshotFileIndex`.

- [ ] **Step 1: Write the failing route tests.**
  - `none` with `fileCount` 18000 and no rows: `index.state === 'building'`, enqueue called once with `'browse'` after the context exits.
  - Enqueue rejecting still answers 200.
  - `complete`: no enqueue.
  - Another org's snapshot: 404 and no enqueue.
  - A site-restricted caller without access: no enqueue.
  - The response body never contains `file_index_error`'s text.
  - Rebuild: `BACKUP_READ` alone is 403; `BACKUP_WRITE` is 202 with `force: true` and an audit record; an attestation failure is 409.
  - Selective restore on a `none` snapshot answers the existing 409 with `code: 'index_unavailable'` and requests hydration.
- [ ] **Step 2: Write the failing worker test:** `'browse'` hydrates a full snapshot (`includeUnreferenced: true`), and `force` is passed through.
- [ ] **Step 3:** Run `cd apps/api && npx vitest run src/routes/backup/snapshots.test.ts src/jobs/backupSnapshotFileIndexWorker.test.ts`. Expected: FAIL.
- [ ] **Step 4:** Implement. Use `runAfterDbContextExit` as `backupResultPersistence.ts:1818` does, and catch and log enqueue errors. Rebuild uses `requireScope`, `requirePermission(BACKUP_WRITE)` and `writeRouteAudit` as the legal-hold route does, without MFA because it changes derived data only.
- [ ] **Step 5:** Re-run. Expected: PASS.
- [ ] **Step 6:** Commit: `feat(backup): browsing a snapshot builds its file index on demand (#11026)`.

### W01 T4: Publish fence

**Files:** Modify `services/backupSnapshotFileIndex.ts`. Test: `backupSnapshotFileIndex.test.ts`, `backupSnapshotFileIndex.transactionScope.test.ts`, `backupIndexAttestationBinding.integration.test.ts`.

**Interfaces, produces:** `HydrationOutcome`'s `skipped` reason gains `'superseded'`.

- [ ] **Step 1: Write the failing tests.**
  - A claim whose `file_index_hydrated_at` changed before the write phase returns `{ status: 'skipped', reason: 'superseded' }` and writes no rows.
  - An org move during fetch (the trigger resets status to `none`) returns `superseded`, not `complete`.
  - A concurrent reader sees the old rows until publish commits (integration).
  - `failOutsideContext` from a superseded run does not overwrite the newer state.
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/backupSnapshotFileIndex.test.ts src/services/backupSnapshotFileIndex.transactionScope.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Open the write transaction with `SELECT … FOR UPDATE` on the snapshot row. Re-check `status === 'hydrating'`, `fileIndexHydratedAt` equal to the claim time, and org and device unchanged. Then run the attestation refusal check in a later statement, as the existing comment requires. Only then delete and insert. Scope `fail` by the same claim predicate. Correct the batching comment at line 582.
- [ ] **Step 4:** Re-run, plus the integration file. Expected: PASS.
- [ ] **Step 5:** Commit: `fix(backup): a superseded hydration never publishes a file index (#11026)`.

### W01 T5: Persistence and telemetry

**Files:** Modify `services/backupResultPersistence.ts`, `services/backupMetrics.ts`, `routes/metrics.ts`, `services/backupSnapshotFileIndex.ts`. Test: `backupResultPersistence.test.ts`.

**Interfaces, consumes:** `stripInlineIndexDropNote`. **Produces:** `recordSnapshotFileIndex(event: 'inline_dropped' | 'hydration', outcome: string, count?: number)`, exported as `breeze_backup_snapshot_file_index_total{event,outcome}`.

- [ ] **Step 1: Write the failing tests.** A completed result carrying the note persists `errorLog: null`, `metadata.fileIndexInlineDroppedEntries: 17950`, and one `inline_dropped` count. A warning with other text keeps that text. A failed job's `failureParts` (line 1137) also omits the note. A hydration outcome counts by status and failure code.
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/backupResultPersistence.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Strip once, ahead of both uses of `result.warning`. Keep the `outcome` label to the closed set of status and `HydrationFailure` values.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit: `fix(backup): stop reporting recoverable index drops as job warnings (#11026)`.

### W01 T6: Web states

**Files:** Create `apps/web/src/components/backup/snapshotIndexState.ts` and `.test.ts`. Modify `SnapshotBrowser.tsx`, `RestoreWizard.tsx`, `BackupJobList.tsx`, `apps/web/src/locales/*/backup.json`. Test: `SnapshotBrowser.test.tsx`, `RestoreWizard.test.tsx`, `BackupJobList.test.tsx`.

**Interfaces, consumes:** `index` from browse; `POST …/file-index/rebuild`; `stripInlineIndexDropNote`.

Copy (en, exact):
- `fileIndexBuilding`: "Preparing this snapshot's file list. This can take a few minutes for large backups."
- `fileIndexUnavailable` (replaces the current string): "This snapshot's file list isn't available right now. You can still restore the whole snapshot."
- `fileIndexIntegrityFailed`: "This snapshot failed its integrity check, so its files can't be listed."
- `fileIndexDeviceLocal` (W03 uses it too): "This snapshot is stored on the device, and Breeze can't read its file list from there yet."
- `fileIndexRetry`: "Try again"

- [ ] **Step 1: Write the failing tests.** `data-testid`s: `snapshot-index-building`, `snapshot-index-unavailable`, `snapshot-index-retry`.
  - Both components show building and poll. The poll stops on `ready` and reloads the directory. The cached empty response is discarded on `ready`.
  - Polling backs off from 5 s to 30 s and stops after 10 minutes with the building message left in place.
  - An attestation failure shows no retry.
  - A local `manifest_missing` shows `fileIndexDeviceLocal`.
  - A retry goes through `runAction`.
  - `BackupJobList` hides the note on historic rows while keeping other text.
  - A truly empty snapshot shows the existing empty message.
- [ ] **Step 2:** Run `cd apps/web && npx vitest run src/components/backup/SnapshotBrowser.test.tsx src/components/backup/RestoreWizard.test.tsx src/components/backup/BackupJobList.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement. Put the polling state machine in `snapshotIndexState.ts`, and apply the helper in `mapJob` as the reparse notice is at `BackupJobList.tsx:198`. Add all keys to all eight locales.
- [ ] **Step 4:** Re-run. Expected: PASS. `pnpm --filter @breeze/web exec astro check` exits 0.
- [ ] **Step 5:** Commit: `feat(backup): show when a snapshot's file list is being prepared (#11026)`.

### W01 close-out

- [ ] Run `cd apps/api && npx vitest run src/services/backupSnapshot src/routes/backup/snapshots src/routes/backup/restore`, then the integration files above. Typecheck the API with `NODE_OPTIONS=--max-old-space-size=12288 pnpm --filter @breeze/api exec tsc --noEmit` and check the exit status.
- [ ] **Lab leg (`worktree-stack` with MinIO):** a snapshot over 10k files whose job has the note in the agent's result. Expected: no warning on the job; browse shows building, then folders; selective restore of one file succeeds. Then delete its rows, set status to `none`, and confirm a browse rebuilds it (the backfill path).
- [ ] PR: `fix(backup): restore browsing for every S3 snapshot (#11026)`, body `Refs #11026`. Not `Closes` until W03's scope is decided.

**Rollback:** code revert. Rows and statuses written are valid for the old code, and hydration requested by browse is idempotent.

---

## W02: Stress shape

**Brief lines (verbatim):**

- "Open the PR, run `/pr-review-toolkit:review-pr`, post the review summary, STOP. Do not merge, do not close the issue."
- "If the premise does not hold, ABORT and report — do not improvise."
- "Do not start background CI pollers and never `pkill -f`; watching CI is the orchestrator's job."

**Premise to check:** W01 is merged. `fetchManifestBytes` still buffers.

**Execution split.** PARALLEL GROUPS: {T1}, then {T2, T3}, then {T4, T5}, then {T6}. Sonnet-eligible: T5's web half. Opus: the rest. Rigor: high.

**Merge trap:** W02 changes `pnpm-lock.yaml`. Merge it alone, not alongside a dependabot PR. They go UNMERGEABLE against each other in the queue.

### W02 T1: Streaming manifest reader

**Files:** Create `apps/api/src/services/backupManifestScanner.ts` and `.test.ts`. Modify `backupSnapshotStorage.ts`, `apps/api/package.json`, `pnpm-lock.yaml`. Test: `backupSnapshotStorage` tests.

**Dependency:** `stream-json` (BSD-3-Clause, one transitive dependency). Pin an exact version published at least two weeks ago, and check its current API, which changed across majors.

**Interfaces, produces:**
```ts
MANIFEST_STREAM_MAX_BYTES  // 2 GiB, in backupSnapshotStorage.ts
openBackupObjectStream(input: { provider; providerConfig; key; maxBytes: number }):
  Promise<NodeJS.ReadableStream>
  // Rejects BackupObjectTooLargeError from ContentLength or stat before reading;
  // the stream errors with it when bytes exceed maxBytes and no length was declared.
scanManifest(source: NodeJS.ReadableStream, handlers: {
  onEntry: (entry: unknown, index: number) => void | Promise<void>;
}): Promise<{ id: string | null; entries: number; hasFilesKey: boolean }>
  // Throws ManifestScanError on malformed JSON, or on `files` that is not an array.
```

- [ ] **Step 1: Write the failing tests.**
  - `onEntry` fires for the first entry before the source has finished producing, which proves entries are not collected.
  - Key order does not matter (`files` before `id`).
  - `securityDescriptors` and other top-level keys are skipped.
  - Handler backpressure is honoured (an async handler is awaited in order).
  - Malformed JSON, truncated input and `files: {}` throw `ManifestScanError`.
  - No `files` key gives `entries: 0`.
  - A declared length over the cap rejects without reading. An undeclared oversized body errors mid-stream.
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/backupManifestScanner.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `backupManifestScanner.ts`, and add `openBackupObjectStream` for `s3` and `local`.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(backup): stream snapshot manifests instead of buffering them (#11026)`.

### W02 T2: Hydrator uses the stream

**Files:** Modify `services/backupSnapshotFileIndex.ts`. Test: `backupSnapshotFileIndex.test.ts`.

**Interfaces, produces:** `HydrationDeps.openManifest: (args) => Promise<NodeJS.ReadableStream>` replaces `fetchManifestBytes`. W03 passes its own source through this seam. `ParsedManifest` no longer holds `fileRows`: it holds `manifestSha256`, `spoolPath`, `eligibleEntries` and `originCounts`.

Order, replacing `fetchAndParseManifest` and the insert loop:
1. Spool to `mkdtemp(join(tmpdir(), 'breeze-manifest-'))` (mode 0700), hashing as bytes pass, capped by `MANIFEST_STREAM_MAX_BYTES`.
2. Check the attestation refusal.
3. Pass 1: scan the spool, validate each entry with the existing entry schema, check the id and key grammar, count origins and eligible entries. Write nothing.
4. In the fenced transaction (W01 T4): verify origins, delete old rows, then pass 2 inserts 1,000-row batches, then assert the inserted count equals `eligibleEntries`, then publish.
5. Remove the spool in `finally`. On worker start, remove stale `breeze-manifest-*` directories older than 24 hours.

- [ ] **Step 1: Write the failing tests.**
  - A 5,000-entry manifest publishes the same rows and digest as today.
  - A digest mismatch writes nothing and leaves old rows.
  - A bad entry at index 4,999 writes nothing and leaves old rows, naming the entry's path in the message (`summarizeManifestIssues`' behaviour).
  - Over the cap gives `manifest_too_large`, not retryable.
  - A spool write failure (injected `ENOSPC`) gives `provider_error`, retryable, with old rows intact.
  - The spool is removed on every path.
  - A count mismatch rolls back.
  - Directory and symlink entries are skipped and not counted.
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/backupSnapshotFileIndex.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Update every test's `fetchManifestBytes` stub to `openManifest` (mechanical, Sonnet-eligible).
- [ ] **Step 4:** Re-run, plus the `transactionScope` file. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(backup): hydrate a snapshot's file index without buffering its manifest (#11026)`.

### W02 T3: Verifier handles large manifests

**Files:** Modify `services/backupAttestationVerify.ts`. Test: `backupAttestationVerify.test.ts`.

**Interfaces:** `AttestationVerifyDeps` gains `openObject` for the manifest role. `fullRunReferenceProblem` becomes a per-entry check run during the scan, returning the same `manifest_unparseable` and `unexpected_references` reasons.

- [ ] **Step 1: Write the failing tests.**
  - A 300 MiB attested size with matching bytes (stubbed stream) finishes `verified`, not `manifest_too_large`.
  - Over `MANIFEST_STREAM_MAX_BYTES` gives `retry('manifest_over_server_limit')`, and the status stays `pending`.
  - A digest mismatch and a size mismatch still finish `mismatch` as today.
  - A full run with an external reference still finishes `unexpected_references`, including when the digest also matches.
  - A manifest with no `files` key still passes.
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/backupAttestationVerify.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. The verifier needs one pass and no spool, since it writes nothing until the end. Sidecar roles keep their existing buffered path and cap.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit: `fix(backup): a large manifest is not an integrity failure (#11026)`.

### W02 T4: Selection without loading every path

**Files:** Modify `services/backupSelectedPaths.ts`, `routes/backup/restore.ts`, `services/aiToolsBackup.ts`. Test: `backupSelectedPaths.test.ts`, `routes/backup/restore.test.ts`, `backupSnapshotBrowse.integration.test.ts`.

**Interfaces, produces:**
```ts
createSelectionResolver(selected: readonly string[]): {
  add(storedPath: string): void;
  finish(): SelectedSnapshotPathsResolution;
}
resolveSelectedSnapshotPathsInDb(snapshotDbId: string, selected: readonly string[]):
  Promise<SelectedSnapshotPathsResolution>
```

The resolver indexes selections, not stored paths. For each stored path it does a hash lookup on the exact path, on the normalized path, and on each ancestor segment key. `resolveSelectedSnapshotPathsInDb` walks rows by keyset (`source_path > $last ORDER BY source_path LIMIT 5000`, with `readableIndexCondition`), which yields between batches. A directory's result is its stored-form prefix (the first member cut after N segments, using that member's own separators). A later member not under that prefix marks the directory mixed, and it falls back to expansion capped by `MAX_SELECTED_RESTORE_FILES`.

- [ ] **Step 1: Write the failing tests.** Run every existing `backupSelectedPaths.test.ts` case through the new resolver, updating only directory-expansion expectations to prefixes. Add:
  - A 50,000-file folder resolves to one prefix, not `too_many`.
  - A mixed-separator folder of 50,000 gives `too_many`, and of 100 gives expansion.
  - A file and folder sharing a name returns both.
  - POSIX `a\b` and `a/b` give `ambiguous`.
  - A sibling sharing a prefix (`pick.txtx/…`) is never selected.
  - Agent parity: each prefix selects exactly the same set under `pathSelectionMatches`' rules, using fixtures shared with `agent/internal/backup/restore_test.go`.
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/backupSelectedPaths.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Keep `resolveSelectedSnapshotPaths` as a thin wrapper over the resolver for tests only if something still needs it; otherwise delete it. Both call sites use the DB form.
- [ ] **Step 4:** Re-run, plus `src/routes/backup/restore.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(backup): restore a folder of any size without listing every file (#11026)`.

### W02 T5: Search and statement timeouts

**Files:** Modify `services/backupSnapshotBrowse.ts`, `routes/backup/snapshots.ts`, `routes/backup/schemas.ts`, `SnapshotBrowser.tsx`, locales. Test: `backupSnapshotBrowse.integration.test.ts`, `snapshots.test.ts`, `SnapshotBrowser.test.tsx`.

**Interfaces, produces:** `GET /snapshots/:id/search?q=&limit=&cursor=` returns `{ data: BrowseEntry[]; nextCursor: string | null; index }`. `q` is 2–256 characters. `limit` defaults to 50 with a maximum of 100. Same authorization as browse, and `readableIndexCondition` applies. The query uses `position(lower($q) in lower(source_path)) > 0`, ordered by `source_path`, keyset on `source_path`.

- [ ] **Step 1: Write the failing tests.**
  - A substring in a filename and in a directory both match.
  - `%` and `_` are literal.
  - Pagination returns each match once.
  - A statement timeout gives 503 `{ code: 'index_query_timeout' }`, on search and on browse.
  - Another org's snapshot is 404.
  - In the web UI, `snapshot-search-input` and `snapshot-search-results` show results, with a selectable restore link per result.
- [ ] **Step 2:** Run the three test files. Expected: FAIL.
- [ ] **Step 3:** Implement, setting the Global Constraints timeouts with `SET LOCAL`.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(backup): search a snapshot's files (#11026)`.

### W02 T6: Eager threshold and measured acceptance

**Files:** Modify `services/backupResultPersistence.ts:890`. Test: `backupResultPersistence.test.ts`.

**Interfaces:** `snapshotIndexHydrationReason` gains `indexedEntries: number | undefined` (`filesBackedUp + referencedFiles`). Above `EAGER_HYDRATION_MAX_ENTRIES = 250_000` it returns null, subject to Open Decision 3.

- [ ] **Step 1: Write the failing tests:** 250,001 entries on S3 gives null. 250,000 gives `result_brokered_read`. Undefined keeps today's behaviour.
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/backupResultPersistence.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Re-run. Expected: PASS. Commit: `feat(backup): hydrate very large snapshots on first use (#11026)`.
- [ ] **Step 4: Measured acceptance on a `test-stack`:** seed a synthetic 1.1M-entry manifest in the in-memory or MinIO store and hydrate it. Record in the PR: wall time, peak RSS delta, event-loop p99 during the run, row count, browse root and deep times, search miss, selection of the largest folder. Pass: peak RSS delta under 300 MB, event-loop p99 under 200 ms, browse root under 5 s. If any fails, stop and report rather than tuning past the plan.

### W02 close-out

- [ ] Run the W01 close-out commands plus `cd apps/api && npx vitest run src/services/backupManifestScanner src/services/backupSelectedPaths src/services/backupAttestationVerify`.
- [ ] PR: `feat(backup): file index, integrity check and selection at a million files (#11026)`, body `Refs #11026`. State explicitly that GC and reconcile remain limited at 200 MiB (W04 files them), so this is not a claim of full million-file support.

**Rollback:** code revert, plus removing the dependency. A snapshot verified under the larger cap stays verified, and an older server still reads its rows.

---

## W03: Helper manifest upload for device-local destinations

Subject to Open Decision 2.

**Brief lines (verbatim):**

- "Open the PR, run `/pr-review-toolkit:review-pr`, post the review summary, STOP. Do not merge, do not close the issue."
- "If the premise does not hold, ABORT and report — do not improvise."
- "Do not start background CI pollers and never `pkill -f`; watching CI is the orchestrator's job."

**Premise to check:** W01 and W02 are merged and deployed to both regions, and `HydrationDeps.openManifest` exists.

**Execution split.** PARALLEL GROUPS: {T1}, then {T2, T3}. Contract frozen in T1's Interfaces. Sonnet-eligible: T3. Opus: T1, T2. Rigor: high (ships to customer machines).

**Collision check:** does not touch `snapshot.go`, the journal, or the storage session lease (#11040, #11109, #11012).

### W03 T1: API endpoint and dispatch

**Files:** Create `routes/agents/backupManifestUpload.ts` and `.test.ts`. Modify `routes/agents/index.ts`, `routes/agents/parkedRouteClassification.test.ts`, `middleware/bodyLimit.ts`, `services/commandQueue.ts` (`BACKUP_COMMAND_TYPES`), `routes/backup/snapshots.ts`, `services/backupSnapshotFileIndex.ts` (failure codes).

**Interfaces, produces:**
- Command `backup_index_upload`, payload `{ snapshotId: string; snapshotDbId: string; destination: <the same provider payload as backup_restore> }`.
- `POST /api/v1/agents/:id/backup/manifest-upload/:commandId`, agent-authenticated, gzip body of the original manifest bytes, capped at 512 MiB on the wire and `MANIFEST_STREAM_MAX_BYTES` decompressed. Returns `200 { status }`, `404`, `409` or `413`.
- `HydrationFailure` gains `device_upload_unsupported` (terminal) and `device_upload_failed` (retryable).

The endpoint authorizes on the command row itself, so no new token or table is needed: the row must belong to this device, have type `backup_index_upload`, not be terminal, be under one hour old, and name a snapshot belonging to this device and org. It then runs the hydrator on this node with `openManifest` returning the decompressed request body, so a multi-node deployment needs no shared spool. Status ends `complete` only when the attested digest matches, by the same code as S3.

- [ ] **Step 1: Write the failing tests.**
  - A valid upload publishes rows.
  - Another device's agent gets 404.
  - A terminal or over-age command gets 409.
  - A digest differing from the attestation gives `manifest_differs_from_attestation` and no rows.
  - An oversize body gets 413 and a metric.
  - The route is classified `deny` for parked devices.
  - A browse of a `local::` snapshot with no rows and an online device queues exactly one command, and a second browse while it is pending queues none.
  - An offline device gets `unavailable`, with no command.
  - An `unknown backup command` result records `device_upload_unsupported`.
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/routes/agents/backupManifestUpload.test.ts src/routes/agents/parkedRouteClassification.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(backup): accept a snapshot manifest from a device-local destination (#11026)`.

### W03 T2: Helper command

**Files:** Create `agent/cmd/breeze-backup/exec_index_upload.go` and `_test.go`. Modify `agent/cmd/breeze-backup/main.go:1039` (dispatch), `agent/internal/remote/tools/types.go`, `agent/internal/heartbeat/backup_forwarder.go`, and the helper's queue classification.

**Interfaces:** `execIndexUpload(payload []byte) backupipc.BackupCommandResult`. Credentials from `loadStorageSessionCredentials`, HTTP from the helper's existing ECH client.

The command must not join the FIFO that runs `backup_run`. Add it alongside `backup_list` in `execution_queue_test.go`'s immediate list. A command parked behind a long backup is how #11012's lease expired.

- [ ] **Step 1: Write the failing tests.**
  - The uploaded body decompresses to exactly the stored manifest bytes, and memory stays streamed (a test provider serving a 50 MB reader passes with no buffering: assert on read chunk size).
  - The destination comes from the payload via the same provider construction as restore.
  - A missing manifest gives a failure result naming the snapshot.
  - HTTP 413 and 409 are reported in the result.
  - The command runs while a `backup_run` holds the queue.
  - `exceededLimit` never fires for its result.
- [ ] **Step 2:** Run `cd agent && go test -race ./cmd/breeze-backup/ -run 'IndexUpload|ExecutionQueue'`. Expected: FAIL.
- [ ] **Step 3:** Implement with no `exec.Command` and no temp file.
- [ ] **Step 4:** Run `cd agent && go test -race ./cmd/breeze-backup/... ./internal/backup/... ./internal/heartbeat/...` and `GOOS=windows go vet ./cmd/breeze-backup/`. Expected: PASS and clean.
- [ ] **Step 5:** Commit: `feat(backup): helper uploads a snapshot manifest on request (#11026)`.

### W03 T3: Honest helper note

**Files:** Modify `agent/cmd/breeze-backup/result_bounds.go:589`, and the tests pinning the wording in `result_bounds_test.go`, `result_bounds_server_cap_test.go`, `result_warning_preservation_test.go`.

Exact new note: `snapshot file index not sent with the result (%d entries): the result exceeded the %s; the server reads it from the snapshot manifest`. Keep `limitExceededPhrase`. Emptying (not removing) `files` stays as it is: the comment at line 238 explains why.

- [ ] **Step 1:** Update the pinned assertions to the new wording.
- [ ] **Step 2:** Run `cd agent && go test -race ./cmd/breeze-backup/ -run 'ResultBounds|Warning|ServerCap'`. Expected: FAIL.
- [ ] **Step 3:** Implement, and correct the comment block above the marker that calls this note the only signal distinguishing an empty snapshot.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit: `fix(backup): say the index is read from the manifest, not lost (#11026)`.

### W03 close-out

- [ ] **Lab leg:** a Windows device with a local destination and over 10k files, on the new helper. Browse, confirm building then listing, restore one file. Repeat with the previous helper version and confirm the "update the agent" state with no error loop.
- [ ] PR: `feat(backup): file lists for device-local snapshots (#11026)`, body `Closes #11026` if Open Decision 2 made this the last code wave, plus a `## Merge Danger` section (below).

**Merge Danger (for the implementation PR):**
- **Door: two-way at merge, one-way once promoted.** Merging changes nothing on a device until a release is promoted. After promotion a helper is not recalled, and the only correction is a later release.
- **Why the door is narrow:** the wave adds a command the server must ask for, and rewords one note. The result shape does not change, so the older-server concern from the issue does not arise. The server can stop dispatching with an API change alone.
- **Blast radius:** devices with a local destination, only when someone browses a snapshot with no index. Worst case is one failed command per browse cooldown and an unavailable message. No backup or restore path changes.
- **Ordering:** the API must be deployed first. A new helper against an older API never receives the command, and the reworded note is only cosmetic there.
- **Self-hosters:** behaviour arrives with their next API and agent update. A proxy with a body limit under the compressed manifest size yields 413 and an unavailable state, not a failure.
- **Not tested until the lab leg:** real Windows local destinations, and large manifests over real links.

**Rollback:** API side, stop queueing the command. Older helpers answer `unknown backup command`, which maps to an honest state.

---

## W04: Release note, docs and follow-ups

**Brief lines (verbatim):**

- "Open the PR, run `/pr-review-toolkit:review-pr`, post the review summary, STOP. Do not merge, do not close the issue."
- "If the premise does not hold, ABORT and report — do not improvise."
- "Do not start background CI pollers and never `pkill -f`; watching CI is the orchestrator's job."

**Premise to check:** the waves it describes are merged. Describe only what merged.

**Execution split.** All Sonnet-eligible. Rigor: low.

### W04 T1: Docs and release note

**Files:** Modify the backup restore page under `apps/docs/` (use `update-breeze-docs`) and `docs/release-notes/next-release-draft.md`.

- [ ] Document: when a file list is prepared, what each state means, that a whole-snapshot restore does not depend on it, search, and folder restore.
- [ ] Release note: the fix, plus no new env vars and no migration. Do not claim million-file support while the T2 issues are open.
- [ ] Verify rendering: `pnpm --filter @breeze/docs build` exits 0.
- [ ] Merge promptly: the release-notes draft is a merge-queue conflict hot spot.

### W04 T2: File follow-ups

- [ ] File one issue each, `Refs #11026`, labelled `category:backup`:
  1. GC aborts the sweep for a destination holding a manifest over 200 MiB, and holds all live keys in memory (`backupRetention.ts:1417,1425`). Storage stops being reclaimed. Fails closed, so no data is at risk. **Blocks claiming million-file support.**
  2. Reconcile skips adoption of a manifest over 200 MiB (`backupSnapshotReconcile.ts:1106`). **Blocks the same claim.**
  3. Agent restore and verify parse the whole manifest in memory (`restore.go:500`). Relevant to #11014.
  4. Hydrated directories and symlinks are omitted from listings, whereas inline rows include them. Decide whether empty folders should appear.
  5. `backup_snapshot_files` growth, per Open Decision 4.

---

## Telemetry

- **Before:** W01 T0's bounded-results query.
- **After:** `breeze_backup_snapshot_file_index_total{event="inline_dropped"}`, plus `metadata.fileIndexInlineDroppedEntries` for per-snapshot history. The `error_log` query stops counting new rows after W01 because the note is stripped, so use these instead.
- **Health:** `event="hydration"` by outcome. A rise in `manifest_too_large`, `attestation_failed` or `origin_unverifiable` is the signal to look.

## Open Decisions

1. **Accept the manifest as the index, rather than the sidecar object the issue proposed?**
   - **A: Manifest as index.** No agent release for S3, works for existing snapshots, one source of truth. Large snapshots download the full manifest once per hydration.
   - **B: Helper-written sidecar plus result pointer.** A smaller download for huge snapshots. Adds an attestation role and a one-way agent door, and still needs the manifest path for every existing snapshot.
   - **Recommend A.** Quorum agreed. This changes the wave order you asked for: the agent wave becomes W03 and is local-only.
2. **Build W03 (device-local destinations) now?**
   - **A: Build it after W02.** Every snapshot is covered, at the cost of an agent release and a lab leg.
   - **B: Park it.** Local snapshots over about 10k files keep an honest "can't read the list" state, and whole-snapshot restore still works.
   - **Recommend A if W01 T0 finds any such snapshots, otherwise B** with the sub-issue left open.
3. **Hydrate very large snapshots eagerly?**
   - **A: Lazy above 250k entries.** Avoids about 145 MB or more of rows per retained snapshot. The first browse or restore waits for a build, a few minutes at the top end.
   - **B: Keep eager for all S3.** Instant first use, and large rows for every retained snapshot.
   - **Recommend A.**
4. **Bound `backup_snapshot_files` growth now?** Rows cost about 578 bytes each, per file, per retained snapshot, regardless of deduplication.
   - **A: Follow-up issue, decide from W01 T0's size figure.** Eviction interacts with active brokered restores, since a rebuild stops file grants, so it needs its own design.
   - **B: Add eviction of idle snapshots to this plan.** Bounds the table sooner, and adds real risk to restores.
   - **Recommend A,** unless T0 shows the table is already a capacity problem.
5. **If W01 T0 finds attestations falsely marked `mismatch` for size, repair them?** Terminal outcomes are immutable by trigger.
   - **A: Separate reviewed PR with a narrow one-time migration,** limited to the `too_large` reason, returning those rows to `pending` so the verifier decides again. Corrects the record, and needs a controlled exception to an integrity guard.
   - **B: Leave them.** Those snapshots stay unrestorable through the normal path, and later runs are unaffected.
   - **Recommend checking first.** I expect zero rows, since runs that size have rarely finished (inferred). If any exist, A, with your explicit approval.

## Self-review

- **Coverage:** every item in the dispatch maps to a decision or task: design (D1, D2), compatibility and budget semantics (table above), backfill (D3, W01 T3), caps (D7, table), pagination and search (W02 T4, T5), integrity (W01 T2, W02 T2, T3), tenancy (table, W01 T3), rollback (each wave), telemetry (W01 T5), Merge Danger (W03).
- **Review Focus:** each of the five lines has its test in the named task.
- **Interfaces:** `snapshotIndexView`, `readableIndexCondition`, `openManifest`, `scanManifest` and `MANIFEST_STREAM_MAX_BYTES` are defined once and used consistently.
