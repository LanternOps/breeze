---
title: Backup visibility — failure reasons, running backups on the device page, uploaded vs reused bytes
issue: 11027
tracking_issue: LanternOps/breeze#11161 (from #11027)
status: drafted
---

# Backup Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator looking at a backup job can see why it failed (with a plain-language category), see that a backup is running on a device right now (phase, progress, speed, ETA), and see how much data a run uploaded compared with how much it reused, plus why a run was a full upload.

**Architecture:** The failure category is computed when a job is read. A pure classifier in `@breeze/shared` turns `(status, errorLog)` into a category, and the API adds the result to every job response. No column is added, so historical rows are classified too. Running-backup visibility is a read-side addition to the device status endpoint (`activeJobs`), plus a web progress helper pulled out of `BackupJobList` so the org job list and the device tab compute speed, ETA and stall state the same way. Byte accounting is a pure shared derivation over columns that already exist (`total_size`, `transferred_size`, `referenced_size`, `base_snapshot_id`). It needs one new nullable column, `backup_jobs.full_backup_reason`, because the reason a run fell back to a full upload is only logged today (`logFullBackupFallback`, `apps/api/src/jobs/backupWorker.ts:1120`) and is lost once the log line is gone.

**Tech Stack:** Hono + Drizzle + Vitest (API), React islands + react-i18next + Vitest/jsdom (web), `packages/shared` Vitest, Starlight MDX (docs).

**Spec:** none (track:plan). The binding source is issue #11027 plus the Design section below.

## Design

Decisions:

1. **The category is classified when a job is read, not stored.** `classifyBackupFailure({ status, errorLog })` lives in `packages/shared/src/utils/backupFailureCategory.ts`, next to the precedent `backupReparseSkips.ts`, which is also a read-side errorLog parser shared by the API and web. The API calls it in `toJobResponse` (`apps/api/src/routes/backup/jobs.ts:744`), in the dashboard's recent jobs (`dashboard.ts:474`) and in the device status endpoint (`dashboard.ts:535`). It returns `failureCategory`, and the web maps that to i18n copy. *Rejected:* a persisted `failure_category` column. The rules will change as new agent messages appear, a column would need backfills, and history would stay `unknown` until one ran. *Rejected:* structured error codes from the agent. That is agent-shipped code, which is high blast radius, it covers no history, and the reaper and worker messages are all server-side anyway. Revisit it if the `unknown` share stays high after W01 ships (see the W03 verification task).
2. **The last line of `errorLog` decides.** The reaper appends with `\n` (`staleCommandReaper.ts:1502`). The terminal cause is therefore the last line, and earlier lines are dispatch notes such as `Partial dispatch: …`. Lines are tried from last to first. Within a line, rules are tried in a fixed priority order, so the failing `error` part of an `error; warning` join outranks a VSS warning.
3. **Eight categories:** `device_offline`, `timeout`, `storage`, `agent`, `configuration`, `source_access`, `cancelled`, `unknown`. These are the four from the issue (offline / storage / agent / timeout), plus three that real rows need (configuration, unreadable source files on partial runs, user cancel), plus a fallback that still shows the raw text.
4. **The active phase is derived, not persisted.** The agent sends `phase` (`queued`/`starting`/`executing`/`uploading`) but it is not stored. The phases worth showing can be derived from existing columns: `pending` with no keepalive means waiting for the device; `pending` with a keepalive means queued behind another backup on the device (the FIFO from #11012); `running` with no total means scanning; `running` with a total means backing up. A write session with `resumed_at` set means the run resumed an interrupted snapshot (`backup_storage_sessions.resumed_at`). *Rejected:* a `progress_phase` column. It adds nothing over this derivation today. If #11014 adds a resume/verify phase on the agent, that change should add the column.
5. **Byte accounting is derived in one shared function** (`deriveBackupJobDataAccounting`). That way the jobs list, the device tab and the dashboard cannot disagree. `transferred_size` means *processed, reused files included* while a run is in flight, and keeps that meaning on a failed run (`schema/backup.ts:296-301`). The UI therefore never labels it "uploaded" unless the run ended restorable. For restorable runs, uploaded = `total − referenced`, which matches the existing savings line (`BackupJobList.tsx:760-768`).
6. **`full_backup_reason` is stored at dispatch.** It is varchar(64) and nullable, with no CHECK constraint. Its values are the existing `FullBackupFallbackReason` union, which moves to `@breeze/shared` as `BACKUP_FULL_RUN_REASONS` so the web can label it. A CHECK would force a migration for every new reason. The column is validated on read: an unknown value renders as `unrecorded`. Known reasons are stamped inside the dispatch transaction. The `diagnose` reason is stamped after commit with a guarded, best-effort `UPDATE … WHERE full_backup_reason IS NULL`, using the same rule as the existing probe: a diagnosis failure never fails the dispatch.

Out of scope, with owners:
- Lease expiry of queued jobs: #11012 (PR #11016). Resume progress accounting, helper exit, and the scale warning: #11014. Restore browsing of the file index: #11026. This plan only *displays* what those fixes produce. It does not change agent, lease or reaper behaviour.
- Category on AI tool output (`aiToolsBackup.ts:148`) and on dashboard attention items: follow-ups only if asked.
- Filtering the job list by category: not requested.

## Global Constraints

- No new table. One `ADD COLUMN IF NOT EXISTS` on `backup_jobs` (W03), idempotent, with no inner `BEGIN;`/`COMMIT;`. The migration writes no rows, so no `breeze.scope` election is needed.
- Migration name sorts after the newest file in `apps/api/migrations/` **at implementation time**. Run `ls apps/api/migrations | grep -E '^[0-9]{4}-' | sort | tail -1` and pick a later `YYYY-MM-DD-HHMMSS-backup-jobs-full-backup-reason.sql`. Today's newest is `2027-01-20-120000-…`. Re-check before pushing, because the pre-push hook will.
- `backup_jobs` is an org-cascade table. The new column needs a `CORE_TENANT_EXPORT_POLICY` classification (`included`, because it is varchar, not json). Nothing else changes for tenancy: RLS, cascade order and merge policy cover the table, not its columns.
- Every new en locale key goes into all 9 locales: `en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`, plus any locale dir added before implementation (`ls apps/web/src/locales`). Non-en values are the English string until translated, following the repo convention.
- UI copy uses "reused" for referenced bytes ("already in storage from an earlier backup"). It never says "deduplicated" or "referenced".
- Web GETs use `fetchWithAuth`. This plan adds no mutations (Stop reuses the existing cancel handler and its `runAction` path).
- No customer names, hostnames or infra details in code, tests, docs or PR bodies.
- Every new UI element that a test targets gets a `data-testid`.

## Review Focus

1. **A multi-line `errorLog` whose earlier line matches a higher-priority rule** (for example a `Partial dispatch` note, then a reaper "Device went offline" line). Expect the last line to win. Pinned in Task 1 (`last line decides`).
2. **A running job with `transferredSize` 0 for hours after a resume** (#11014). Expect it shown as "Resuming an interrupted backup", with no ETA and no claim that it is stuck unless keepalive is stale. Pinned in Task 4 (`deriveActivePhase resuming`) and Task 5.
3. **A failed run that had processed 1.4 TB.** Expect it never labelled as 1.4 TB *uploaded*. Pinned in Task 7 (`failed run reports processed, not uploaded`).
4. **Rows dispatched before W03 have no `full_backup_reason`.** Expect "Reason not recorded", not a blank or "First backup". Pinned in Task 7 (`legacy full run`).
5. **A device with two in-flight jobs (file + system_image, #11012's shape).** Expect both shown, the running one first and the other as "Waiting for another backup on this device to finish". Pinned in Task 4 (API ordering) and Task 5 (two cards).

---

## Wave W01 — Failure reasons with a plain-language category

Ships alone: API field + UI chips + troubleshooting docs. Owns `packages/shared/src/utils/backupFailureCategory*.ts`, `apps/api/src/routes/backup/jobs.ts` (`toJobResponse` only), `apps/api/src/routes/backup/dashboard.ts` (response mapping only), and the error cells of `BackupJobList.tsx`, `DeviceBackupTab.tsx` and `BackupOverviewContent.tsx`.

### Task 1: Shared failure classifier

**Files:**
- Create: `packages/shared/src/utils/backupFailureCategory.ts`
- Create: `packages/shared/src/utils/backupFailureCategory.test.ts`
- Modify: `packages/shared/src/utils/index.ts` (add `export * from './backupFailureCategory';` after line 55)

**Interfaces:**
- Produces:
  ```ts
  export const BACKUP_FAILURE_CATEGORIES = ['device_offline','timeout','storage','agent','configuration','source_access','cancelled','unknown'] as const;
  export type BackupFailureCategory = (typeof BACKUP_FAILURE_CATEGORIES)[number];
  /** null for pending/running/completed (nothing failed). */
  export function classifyBackupFailure(input: { status: string; errorLog: string | null | undefined }): BackupFailureCategory | null;
  ```

Algorithm (the tests do not fully determine this, so it is spelled out):
- `status === 'cancelled'` returns `'cancelled'`. For any status other than `failed`, `partial` or `completed_with_errors`, return `null`.
- Remove the reparse fragment with `splitReparseSkipNotice(errorLog).diagnostic`. Split on `\n`, then walk the lines from last to first. On each line, strip every leading `[tag] ` prefix (`/^\[[a-z0-9-]+\]\s+/`) and the `RECONCILE_PRIOR_ERROR_PREFIX` text `prior failure: `.
- Test each line against an ordered `RULES: ReadonlyArray<{ category; pattern: RegExp }>`, case-insensitive, first match wins. The order is `device_offline`, `timeout`, `storage`, `agent`, `configuration`, `source_access`.
- If no line matches, return `'source_access'` for `partial`/`completed_with_errors` (those statuses mean file failures by definition, `schema/backup.ts:80-83`) and `'unknown'` for `failed`.

The rule patterns are the implementer's to write. The **corpus below is binding**: every row must classify as shown.

- [ ] **Step 1: Write the failing corpus test** `classifies the production message corpus` as a `it.each` table of `[status, errorLog, expected]`:

| status | errorLog | expected |
|---|---|---|
| failed | `[stale-backup-reaper] Device went offline during backup` | device_offline |
| failed | `[stale-backup-reaper] Backup stalled: no progress reported for 15 minutes` | timeout |
| failed | `[stale-backup-reaper] Backup stalled: no data transferred for 24h while the agent was still responding (limit 24h)` | timeout |
| failed | `[stale-backup-reaper] Backup timed out (no completion after 24h)` | timeout |
| failed | `[stale-backup-reaper] Backup dispatch never completed` | timeout |
| failed | `[stale-backup-reaper] Backup command timed out: Server-side timeout: no response from agent after 60 minutes` | timeout |
| failed | `publish_lease_expired: late result rejected — the publish lease expired before this result arrived` | timeout |
| failed | `could not ask to continue interrupted snapshot snapshot-1: storage session: session is no longer usable: renew rejected with status 410` | storage |
| failed | `failed to upload file to s3 with multipart upload: AccessDenied: Access Denied` | storage |
| failed | `base_retired: late result rejected — the base snapshot was retired before this result arrived` | storage |
| failed | `backup helper exited unexpectedly` | agent |
| failed | `IPC recv error: ipc: read header: EOF` | agent |
| failed | `IPC recv error: ipc: message too large: 2065852772` | agent |
| failed | `The backup reported a different snapshot than it was allowed to write.` | agent |
| failed | `No backup targets resolved (mode=file). Ensure discovery has been run for this device.` | configuration |
| failed | `VSS shadow copy could not be created` | source_access |
| partial | `failed to open source file: open C:\data\x.pst: Access is denied.` | source_access |
| completed_with_errors | `3 files could not be read` | source_access |
| failed | `Partial dispatch: 1 target(s) failed to send (system_image)\n[stale-backup-reaper] Device went offline during backup` | device_offline |
| failed | `something nobody has seen before` | unknown |
| failed | `null` | unknown |
| cancelled | `Cancelled by user` | cancelled |
| completed | `VSS shadow copy could not be created` | null |
| running | `null` | null |

Then **extend the corpus**: grep every `errorLog:` writer and every `reapBackupJobRow(` message in `apps/api/src/jobs/backupWorker.ts`, `apps/api/src/jobs/staleCommandReaper.ts`, `apps/api/src/services/backupResultPersistence.ts` and `apps/api/src/routes/backup/jobs.ts`, plus `BACKUP_HELPER_UNREPORTED_MESSAGE`. Add one row per distinct message with a category other than `unknown`. List the sources you grepped in a comment at the top of the test.

Add two named tests: `last line decides` (the `Partial dispatch` row above, plus a row where line 1 is a storage error and line 2 is a reaper offline line, expecting `device_offline`), and `reparse fragment alone on completed_with_errors is source_access` (use the fragment fixture from `backupReparseSkips.test.ts`).

- [ ] **Step 2: Run and confirm it fails.** Run `cd packages/shared && npx vitest run src/utils/backupFailureCategory.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `classifyBackupFailure` as specified above.
- [ ] **Step 4: Run and confirm it passes.** Same command. Expected: PASS, every row green.
- [ ] **Step 5: Commit.** `feat(shared): classify backup job failures into plain-language categories (#11027)`

### Task 2: API returns `failureCategory`

**Files:**
- Modify: `apps/api/src/routes/backup/jobs.ts:744-769` (`toJobResponse`)
- Modify: `apps/api/src/routes/backup/dashboard.ts:474-488` (recent `latestJobs`) and `:599-627` (status `lastJob`, plus a new `lastFailureCategory` next to `lastFailureError`)
- Test: `apps/api/src/routes/backup/jobs.test.ts`, `apps/api/src/routes/backup/dashboard.test.ts`

**Interfaces:**
- Consumes: `classifyBackupFailure` (Task 1).
- Produces: `failureCategory: BackupFailureCategory | null` on every object returned by `GET /backup/jobs`, `GET /backup/jobs/:id`, `GET /backup/dashboard` `latestJobs[]`, and `GET /backup/status/:deviceId` `data.lastJob`. Also `data.lastFailureCategory: BackupFailureCategory | null`.

- [ ] **Step 1: Write the failing tests.** In `jobs.test.ts`, add `GET /jobs returns failureCategory per row`: one mocked row `{ status: 'failed', errorLog: '[stale-backup-reaper] Device went offline during backup' }` and one `{ status: 'completed', errorLog: null }`. Expect `data[0].failureCategory === 'device_offline'` and `data[1].failureCategory === null`. In `dashboard.test.ts`, add `status lastJob and lastFailure carry failureCategory`: the last job is failed with `backup helper exited unexpectedly`, so expect `lastJob.failureCategory === 'agent'` and `lastFailureCategory === 'agent'`.
- [ ] **Step 2: Run and confirm they fail.** Run `cd apps/api && npx vitest run src/routes/backup/jobs.test.ts src/routes/backup/dashboard.test.ts`. Expected: FAIL, property undefined.
- [ ] **Step 3: Implement.** Add one `failureCategory: classifyBackupFailure({ status: row.status, errorLog: row.errorLog })` per response mapper.
- [ ] **Step 4: Run and confirm they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(api): expose backup failureCategory on job, dashboard and device status responses (#11027)`

### Task 3: Web shows the category and its hint; docs

**Files:**
- Create: `apps/web/src/components/backup/BackupFailureCategoryBadge.tsx`
- Create: `apps/web/src/components/backup/BackupFailureCategoryBadge.test.tsx`
- Modify: `apps/web/src/components/backup/BackupJobList.tsx`: the `BackupJobRaw`/`BackupJob` types (`:39-89`), `mapJob` (`:197`), the Errors cell (`:663-677`) and the details error block (`:771-790`)
- Modify: `apps/web/src/components/backup/DeviceBackupTab.tsx`: the `BackupJob` type (`:52`), the job-history Errors cell (`:590-600`) and the last-run diagnostic banner (`:620-638`)
- Modify: `apps/web/src/components/backup/BackupOverviewContent.tsx` (recent-job diagnostic line `:315-320`)
- Modify: `apps/web/src/locales/*/backup.json` (all locales)
- Modify: `apps/docs/src/content/docs/backup/troubleshooting.mdx`, `apps/docs/src/content/docs/backup/monitoring.mdx`
- Test: `BackupJobList.test.tsx`, `DeviceBackupTab.test.tsx`

**Interfaces:**
- Consumes: `failureCategory` (Task 2); `BackupFailureCategory` type from `@breeze/shared`.
- Produces: `<BackupFailureCategoryBadge category={BackupFailureCategory} showHint?: boolean />`. It renders `data-testid="backup-failure-category"` and `data-category={category}`. The label is always visible. The hint is shown as a `title` and, with `showHint`, also as a muted line below. Returns null for a null category.

Exact en copy, under `backup.failureCategory.<category>.label` and `.hint`:

| category | label | hint |
|---|---|---|
| device_offline | Device offline | The device lost its connection to Breeze during the backup. Keep it powered on and online through the backup window. |
| timeout | Stalled or timed out | The backup stopped making progress or ran past its time limit. Very large backups can need more than one window. Check the device's load and the size of the backup selection. |
| storage | Storage problem | Breeze could not write to the backup destination, or the upload authorization expired. Test the storage configuration and check its credentials and free space. |
| agent | Agent problem | The backup component on the device stopped unexpectedly. Update the agent and run the backup again. If it keeps happening, check the device's agent logs. |
| configuration | Configuration problem | There was nothing valid to back up, or the backup configuration changed while the job was starting. Review the device's backup profile. |
| source_access | Files could not be read | Some files were locked, in use, or not readable by the agent. Check the files listed below and the VSS status. |
| cancelled | Cancelled | Stopped by a user, or by Breeze, before it finished. |
| unknown | Other error | Breeze does not recognise this error yet. The full message is shown below. |

- [ ] **Step 1: Write the failing tests.**
  - `BackupFailureCategoryBadge.test.tsx`: `renders label and hint for every category`. Loop over `BACKUP_FAILURE_CATEGORIES`, assert the en label text, and assert `title` equals the hint.
  - `BackupJobList.test.tsx`: `failed row shows category badge before the error summary`, using a row with `failureCategory: 'storage'`. Assert `getByTestId('backup-failure-category')` has `data-category="storage"` and that `backup-job-error-summary` still renders the raw text.
  - `DeviceBackupTab.test.tsx`: `job history Errors cell shows the category for failed jobs` and `last-run banner title uses the category label`. The banner text is `Last backup failed: Agent problem`, and the hint is shown with `showHint`.
- [ ] **Step 2: Run and confirm they fail.** Run `cd apps/web && npx vitest run src/components/backup/BackupFailureCategoryBadge.test.tsx src/components/backup/BackupJobList.test.tsx src/components/backup/DeviceBackupTab.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the badge component, then wire it into the three surfaces. The device tab Errors cell currently shows only `errorCount`. Make it show the badge plus the first 60 characters of the diagnostic, with the full text in `title`, using `BackupJobList`'s truncation rule. The `lastJobFailed` banner title becomes `t('deviceBackupTab.lastBackupFailedWithCategory', { category: label })`. Add the locale keys to every locale.
- [ ] **Step 4: Run and confirm they pass.** Same command, then `cd apps/web && npx vitest run src/locales`. Expected: PASS, including the locale guard suites.
- [ ] **Step 5: Docs.** In `troubleshooting.mdx`, add a section `## Reading a failed backup's category` with a table of the eight labels → what each one means → the first thing to check. Link each category's first check to the existing section that covers it (helper exited, job fails immediately, VSS writers). In `monitoring.mdx` § Job Lifecycle, add one sentence saying failed, partial and cancelled jobs show a category badge next to the error text.
- [ ] **Step 6: Commit.** `feat(web): show plain-language backup failure categories in job lists and the device tab (#11027)`

**W01 PR gate:** `cd packages/shared && npx vitest run`, `cd apps/api && npx vitest run src/routes/backup`, `cd apps/web && npx vitest run src/components/backup src/locales`, plus web/api typecheck through CI. No integration suite is affected.

---

## Wave W02 — Running backup visible on the device page

Ships alone after W01 (it touches the same two web files, so the waves run in sequence, not in parallel). Owns the device status endpoint's `activeJobs`, `backupJobProgress.ts`, `DeviceBackupActiveJobs.tsx` and `DeviceBackupActivityBadge.tsx`.

### Task 4: `activeJobs` on the device status endpoint, plus a shared progress helper

**Files:**
- Modify: `apps/api/src/routes/backup/dashboard.ts` (`/status/:deviceId`, `:535-640`)
- Test: `apps/api/src/routes/backup/dashboard.test.ts`
- Create: `apps/web/src/components/backup/backupJobProgress.ts`
- Create: `apps/web/src/components/backup/backupJobProgress.test.ts`
- Modify: `apps/web/src/components/backup/BackupJobList.tsx`: replace the inline speed sampler (`:293-321`) and the stall math (`:570-577`) with the helper; add an ETA to the running cell (`:629-660`)

**Interfaces:**
- Produces (API): `data.activeJobs: ActiveBackupJob[]`, where
  ```ts
  type ActiveBackupJob = {
    id: string; status: 'pending' | 'running'; backupMode: string | null; backupType: string | null;
    createdAt: string; startedAt: string | null; totalSize: number | null; transferredSize: number | null;
    fileCount: number | null; totalFiles: number | null; lastProgressAt: string | null; lastKeepaliveAt: string | null;
    resumedAt: string | null; // max(backup_storage_sessions.resumed_at) for this job's snapshot_write sessions
  };
  ```
  Ordering is `running` before `pending`, then `startedAt` ascending, then `createdAt` ascending. Build it from the `jobs` array the handler already loads (filtering `IN_FLIGHT_BACKUP_JOB_STATUSES`). `resumedAt` comes from one grouped query over `backup_storage_sessions`, filtered to `job_id IN (…active ids) AND scope = 'snapshot_write' AND resumed_at IS NOT NULL`, and runs only when there are active jobs.
- Produces (web, `backupJobProgress.ts`):
  ```ts
  export const STALL_MS = 120_000;
  export type ProgressSample = { bytes: number; at: number };
  export function nextSpeedSample(prev: ProgressSample | undefined, job: { transferredSize: number | null; startedAt: string | null }, now: number): { bps: number | undefined; sample: ProgressSample | undefined };
  export function stallState(job: { status: string; lastKeepaliveAt: string | null; lastProgressAt: string | null }, now: number): { stalled: boolean; minutes: number };
  export function estimateRemainingMs(job: { transferredSize: number | null; totalSize: number | null }, bps: number | undefined): number | null; // null unless total>0, bps>0, transferred<total
  export type ActivePhase = 'waiting_for_device' | 'queued_on_device' | 'resuming' | 'scanning' | 'backing_up';
  export function deriveActivePhase(job: Pick<ActiveBackupJob, 'status' | 'lastKeepaliveAt' | 'resumedAt' | 'transferredSize' | 'totalSize'>): ActivePhase;
  export function formatEta(ms: number): string; // "<1m", "45m", "3h 10m", "2d 4h"
  ```
  `deriveActivePhase` works as follows: `pending` + no keepalive → `waiting_for_device`; `pending` + keepalive → `queued_on_device`; `running` + `resumedAt` + transferred 0/null → `resuming`; `running` + no positive total → `scanning`; otherwise `backing_up`.

- [ ] **Step 1: Write the failing tests.**
  - `dashboard.test.ts`, `status returns activeJobs running-first with resumedAt`: mock two in-flight rows (a pending system_image with a keepalive, and a running file job) plus one session row with `resumed_at` for the running job. Assert `activeJobs.map(j => j.id)` equals `[running, pending]` and `activeJobs[0].resumedAt` is set. Add `status returns empty activeJobs and skips the session query when nothing is in flight` and assert the session select mock was not called.
  - `backupJobProgress.test.ts`: `nextSpeedSample first sample uses running average`; `nextSpeedSample stalled delta yields no speed`; `stallState uses keepalive, falls back to lastProgressAt`; `estimateRemainingMs null without total or speed`; `estimateRemainingMs (100 of 400 bytes at 10 B/s) is 30000`; `deriveActivePhase resuming` (running, resumedAt set, transferred 0); the four other phases; `formatEta` boundaries (59_999 → "<1m", 3_600_000 → "1h 0m", 90_000_000 → "1d 1h").
- [ ] **Step 2: Run and confirm they fail.** Run `cd apps/api && npx vitest run src/routes/backup/dashboard.test.ts`, then `cd apps/web && npx vitest run src/components/backup/backupJobProgress.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the API and the helper. Refactor `BackupJobList` to use the helper without changing behaviour, and render `t('backupJobList.etaValue', { value: formatEta(ms) })` (en: `about {{value}} left`) when `estimateRemainingMs` is non-null and the job is not stalled.
- [ ] **Step 4: Run and confirm they pass.** The same two commands plus `npx vitest run src/components/backup/BackupJobList.test.tsx`. Expected: PASS, with the existing stalled and speed tests unchanged.
- [ ] **Step 5: Commit.** `feat(backup): device status lists in-flight jobs; shared progress/ETA helper (#11027)`

### Task 5: "Backup in progress" on the device Backup tab and in the device header

**Files:**
- Create: `apps/web/src/components/backup/DeviceBackupActiveJobs.tsx` (+ `.test.tsx`)
- Create: `apps/web/src/components/backup/DeviceBackupActivityBadge.tsx` (+ `.test.tsx`)
- Modify: `apps/web/src/components/backup/DeviceBackupTab.tsx`: render `<DeviceBackupActiveJobs>` above the Job History card (`:536`), and poll `fetchData` every 5 s while `status.activeJobs.length > 0`
- Modify: `apps/web/src/components/devices/DeviceDetails.tsx`: render `<DeviceBackupActivityBadge deviceId={device.id} />` after `<DeviceIsolationBadge>` (`:948`)
- Modify: `apps/web/src/locales/*/backup.json`, `apps/web/src/locales/*/devices.json` (owns `deviceDetails.*`)
- Modify: `apps/docs/src/content/docs/backup/monitoring.mdx` § Per-Device Backup Status

**Interfaces:**
- Consumes: `ActiveBackupJob` (Task 4) and the `backupJobProgress.ts` helpers.
- Produces: `<DeviceBackupActiveJobs jobs={ActiveBackupJob[]} onStop?={(jobId) => void} />`. It renders one `data-testid="device-backup-active-job"` card per job, each with `data-phase={ActivePhase}`. `<DeviceBackupActivityBadge deviceId />` fetches `GET /backup/jobs?deviceId=<id>&status=running` once on mount, re-polls every 30 s while the result is non-empty, renders `data-testid="device-backup-running-badge"` as a link to the Backup tab (use the hash mechanism DeviceDetails already uses for tab selection), and renders nothing on an empty result, a non-OK response, or a fetch error.

Card content: a phase label; a progress bar (indeterminate when there is no total); `processed of total` using `formatBytes`; files `done of total`; speed; ETA; `Last heard from the device {{relative}}`; a stalled chip from `stallState`; and a Stop button when `onStop` is given. DeviceBackupTab wires Stop to the same `POST /backup/jobs/:id/cancel` + `runAction` pattern that `BackupJobList.handleCancel` uses.

en phase copy (`deviceBackupTab.activePhase.*`):
- `waiting_for_device`: Sent to the device, waiting for it to start
- `queued_on_device`: Waiting for another backup on this device to finish
- `resuming`: Resuming an interrupted backup
- `scanning`: Scanning files
- `backing_up`: Backing up

Header badge en: `Backup running`.

- [ ] **Step 1: Write the failing tests.**
  - `DeviceBackupActiveJobs.test.tsx`: `renders two cards running-first with phases` (Review Focus 5), asserting `data-phase` `backing_up` then `queued_on_device`; `resuming phase shows no ETA and no stalled chip while keepalive is fresh` (Review Focus 2); `stalled chip appears after keepalive older than 2 minutes`.
  - `DeviceBackupActivityBadge.test.tsx`: `renders badge when a running job exists`; `renders nothing on 403` (mock `fetchWithAuth` to return 403).
  - `DeviceBackupTab.test.tsx`: `polls while activeJobs is non-empty and stops when it empties`, using fake timers and asserting the fetch count across two 5 s ticks and then after an empty response.
- [ ] **Step 2: Run and confirm they fail.** Run `cd apps/web && npx vitest run src/components/backup/DeviceBackupActiveJobs.test.tsx src/components/backup/DeviceBackupActivityBadge.test.tsx src/components/backup/DeviceBackupTab.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the components, the tab polling, the header badge and the locale keys in every locale.
- [ ] **Step 4: Run and confirm they pass.** Same command, plus `npx vitest run src/components/devices/DeviceDetails src/locales`. Expected: PASS.
- [ ] **Step 5: Docs.** In `monitoring.mdx` § Per-Device Backup Status, add a **Backup in progress** row covering the five phases (in plain words), the progress, speed and ETA, and the header badge. Add one sentence explaining that "Waiting for another backup on this device to finish" means a device runs its backup modes one at a time.
- [ ] **Step 6: Commit.** `feat(web): show running backups on the device page with phase, progress and ETA (#11027)`

**W02 PR gate:** `cd apps/api && npx vitest run src/routes/backup`; `cd apps/web && npx vitest run src/components/backup src/components/devices src/locales`. The `backup_storage_sessions` read runs in the request's `withDbAccessContext`, which RLS already scopes. Do not add a system-context read.

---

## Wave W03 — Uploaded vs reused bytes, why a run was full, and the incremental model

Ships alone after W02. Owns the migration, `full_backup_reason` stamping in `backupWorker.ts`, `packages/shared/src/utils/backupJobAccounting.ts`, and the new docs page.

### Task 6: Persist `full_backup_reason` at dispatch

**Files:**
- Create: `apps/api/migrations/<YYYY-MM-DD-HHMMSS>-backup-jobs-full-backup-reason.sql` (name per Global Constraints)
- Modify: `apps/api/src/db/schema/backup.ts` (add `fullBackupReason: varchar('full_backup_reason', { length: 64 })` after `storageIdentity`, with a comment pointing at `BACKUP_FULL_RUN_REASONS`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:247` (append `"full_backup_reason"` to `backup_jobs.included`)
- Create: `packages/shared/src/utils/backupJobAccounting.ts` (constants only in this task)
- Modify: `apps/api/src/jobs/backupWorker.ts`: `FullBackupFallbackReason` (`:992`) becomes `= BackupFullRunReason` imported from shared; stamp the reason in `stampDispatchPinAndIdentity` (`:1161-1420`)
- Test: `apps/api/src/jobs/backupWorker.baseFallback.test.ts`, `apps/api/src/__tests__/integration/backupRetentionPins.integration.test.ts`

**Interfaces:**
- Produces (shared):
  ```ts
  export const BACKUP_FULL_RUN_REASONS = ['no_prior_snapshot','base_expired','storage_identity_changed','backup_type_mismatch','base_job_not_completed','base_retired','base_deleted_race','base_retired_race','no_verified_base','key_root_changed','base_key_root_unreadable','invalid_destination_prefix'] as const;
  export type BackupFullRunReason = (typeof BACKUP_FULL_RUN_REASONS)[number];
  export function isBackupFullRunReason(v: unknown): v is BackupFullRunReason;
  ```
- Produces (DB): `backup_jobs.full_backup_reason` is NULL when the run had a base or the mode has no base concept (hyperv/mssql), and otherwise holds a `BackupFullRunReason`.

Migration body:
```sql
ALTER TABLE backup_jobs ADD COLUMN IF NOT EXISTS full_backup_reason varchar(64);
COMMENT ON COLUMN backup_jobs.full_backup_reason IS 'Why dispatch gave this file/system_image run no incremental base (#11027). NULL = had a base, or not applicable.';
```

Stamping: every branch that sets `pendingFallback` to a concrete reason (`:1230`, `:1348` when `requireAttestedBase`, `:1363`, `:1380`) adds `fullBackupReason: <reason>` to the same `tx.update(backupJobs).set({...})` it already issues. The branch that found a base sets `fullBackupReason: null`. In the `diagnose` path (`:1396-1414`), after `classifyMissingBaseReason`, issue `db.update(backupJobs).set({ fullBackupReason: reason }).where(and(eq(backupJobs.id, jobId), isNull(backupJobs.fullBackupReason)))` inside the existing try/catch. A failure there logs and never throws.

- [ ] **Step 1: Write the failing tests.**
  - `backupWorker.baseFallback.test.ts`: `BACKUP_FULL_RUN_REASONS covers every classifyMissingBaseReason output`. Drive the classifier through each probe variant already in the file and assert `isBackupFullRunReason(result)`.
  - `backupRetentionPins.integration.test.ts`, new `describe('full_backup_reason (#11027)')` with three cases: `first dispatch stamps no_prior_snapshot`, `dispatch with an eligible base leaves it NULL`, and `key-root change stamps key_root_changed`. Reuse that file's existing seeding helpers.
- [ ] **Step 2: Run and confirm they fail.** Run `cd apps/api && npx vitest run src/jobs/backupWorker.baseFallback.test.ts`. Then, with `pnpm test-stack up` running, `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/backupRetentionPins.integration.test.ts`. Expected: FAIL (import missing / column missing).
- [ ] **Step 3: Implement** the migration, schema, export-policy entry, shared constants and stamping.
- [ ] **Step 4: Run and confirm they pass.** The same two commands, plus `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts`, plus `pnpm db:check-drift`. Expected: all PASS, no drift. Then `pnpm test-stack down`.
- [ ] **Step 5: Commit.** `feat(backup): record why a dispatched run has no incremental base (#11027)`

### Task 7: Byte accounting in the API and the UI

**Files:**
- Modify: `packages/shared/src/utils/backupJobAccounting.ts` (add the derivation)
- Create: `packages/shared/src/utils/backupJobAccounting.test.ts`
- Modify: `packages/shared/src/utils/index.ts` (export)
- Modify: `apps/api/src/routes/backup/jobs.ts` (`toJobResponse`), `apps/api/src/routes/backup/dashboard.ts` (`latestJobs`, status `lastJob`)
- Modify: `apps/api/src/routes/backup/jobs.ts` `GET /jobs/:id` only: add `resumedAt` using the same session lookup as Task 4. Extract that lookup into `apps/api/src/routes/backup/helpers.ts` as `loadJobResumedAt(jobIds: string[]): Promise<Map<string, Date>>` and switch Task 4's call site to it.
- Create: `apps/web/src/components/backup/BackupJobDataSummary.tsx` (+ `.test.tsx`)
- Modify: `BackupJobList.tsx` (Size cell `:661` and details savings block `:756-769`), `DeviceBackupTab.tsx` (Size cell `:587`), and the locales
- Test: `jobs.test.ts`

**Interfaces:**
- Produces (shared):
  ```ts
  export type BackupRunKind = 'incremental' | 'full';
  export type BackupFullRunDisplayReason = BackupFullRunReason | 'nothing_reused' | 'unrecorded';
  export interface BackupJobDataAccounting {
    protectedBytes: number | null; // restorable runs: total_size
    uploadedBytes: number | null;  // restorable runs only: max(0, total - (referenced ?? 0))
    reusedBytes: number | null;    // restorable runs only: referenced_size ?? 0
    processedBytes: number | null; // in-flight / failed / cancelled: transferred_size (includes reused files)
    runKind: BackupRunKind | null; // null unless backupMode/backupType is file or system_image
    fullRunReason: BackupFullRunDisplayReason | null; // non-null iff runKind === 'full'
  }
  export function deriveBackupJobDataAccounting(row: {
    status: string; backupMode: string | null; backupType: string | null;
    totalSize: number | null; transferredSize: number | null; referencedSize: number | null;
    baseSnapshotId: string | null; fullBackupReason: string | null;
  }): BackupJobDataAccounting;
  ```
  `runKind` rules: no base gives `full`, with the reason `isBackupFullRunReason(fullBackupReason) ? fullBackupReason : 'unrecorded'`. A base plus a restorable status with `reusedBytes === 0` gives `full` / `nothing_reused`. Any other base case gives `incremental`.
- Produces (API): `dataAccounting: BackupJobDataAccounting` on every job response that Task 2 touched, plus `resumedAt: string | null` on `GET /jobs/:id`.
- Produces (web): `<BackupJobDataSummary accounting={BackupJobDataAccounting} variant="cell" | "detail" />`, with `data-testid="backup-job-data-summary"`.

en copy:
- Cell, restorable: `{{uploaded}} uploaded · {{reused}} reused`. Add a `Full` chip (`data-testid="backup-run-full"`) when `runKind === 'full'`, with the reason label as its `title`.
- Cell, failed/cancelled: `{{processed}} processed before it stopped`.
- Detail block heading `What this run stored`, with rows `Protected`, `Uploaded this run`, `Reused from earlier backups`, `Backup type: Incremental | Full — {{reason}}`. After it comes one fixed explainer line: `Only new or changed files are uploaded. Unchanged files are reused from earlier backups made by this device to the same destination.` It links to the Task 8 docs page.
- `resumedAt` set (detail): `This run resumed an interrupted backup at {{time}}.`
- Reason labels (`backup.fullRunReason.*`): no_prior_snapshot "First backup for this device and destination"; base_expired "The previous backup had expired under retention"; storage_identity_changed "The backup destination changed"; backup_type_mismatch "The previous backup was a different type"; base_job_not_completed "No earlier backup finished successfully"; base_retired / base_retired_race / base_deleted_race "The previous backup was removed by retention"; no_verified_base "No earlier backup passed integrity verification"; key_root_changed "The destination folder (prefix) changed"; base_key_root_unreadable "The previous backup's storage location could not be read"; invalid_destination_prefix "The destination prefix is invalid"; nothing_reused "An earlier backup was available, but no unchanged files could be reused"; unrecorded "Reason not recorded (this backup ran before Breeze tracked it)".

- [ ] **Step 1: Write the failing tests.**
  - `backupJobAccounting.test.ts`:
    - `completed incremental`: total 1000, referenced 900, base set. Expect uploaded 100, reused 900, incremental.
    - `failed run reports processed, not uploaded`: status failed, transferred 1.4e12. Expect `uploadedBytes === null` and `processedBytes === 1.4e12` (Review Focus 3).
    - `legacy full run`: no base, `fullBackupReason` null, completed. Expect full / `unrecorded` (Review Focus 4).
    - `stamped reason passes through`.
    - `unknown stored reason becomes unrecorded`.
    - `base but nothing reused is nothing_reused`.
    - `hyperv/mssql runKind null`.
    - `partial counts as restorable`.
  - `jobs.test.ts`: `GET /jobs/:id returns dataAccounting and resumedAt`.
  - `BackupJobDataSummary.test.tsx`: `cell restorable shows uploaded and reused`; `cell failed shows processed before it stopped and no 'uploaded' text`; `full chip title is the reason label`; `detail shows resumed line when resumedAt is set`.
- [ ] **Step 2: Run and confirm they fail.** Run `cd packages/shared && npx vitest run src/utils/backupJobAccounting.test.ts`, then `cd apps/api && npx vitest run src/routes/backup/jobs.test.ts src/routes/backup/dashboard.test.ts`, then `cd apps/web && npx vitest run src/components/backup/BackupJobDataSummary.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the derivation, the API fields, the component, the replacement of the old `backupJobList.savings` line, and the locale keys in every locale. Remove the now-unused `savings` key from every locale in the same commit.
- [ ] **Step 4: Run and confirm they pass.** The same three commands, plus `cd apps/web && npx vitest run src/components/backup src/locales`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(backup): show uploaded vs reused bytes and why a run was a full upload (#11027)`

### Task 8: Docs on the incremental model, and steady-state verification

**Files:**
- Create: `apps/docs/src/content/docs/backup/incremental-backups.mdx` (frontmatter `sidebar.order: 4.5`, label "How Incremental Backups Work")
- Modify: `apps/docs/src/content/docs/backup/monitoring.mdx` (Storage Used row `:29`: link to the new page), `apps/docs/src/content/docs/backup/storage.mdx:104` (link the prefix-change note to the new page)

- [ ] **Step 1: Verify each claim before writing it.** Each statement in the page must be checked against code. In the PR body, cite the file and line that proves it.
  - (a) How a run decides that a file is unchanged: `agent/internal/backup/incremental.go`.
  - (b) What scopes the base: device + backup configuration + storage destination identity + destination prefix + backup type (`backupWorker.ts` `stampDispatchPinAndIdentity` and `classifyMissingBaseReason`).
  - (c) Whether `system_image` runs reuse data, and how.
  - (d) What happens to data already uploaded by a run that fails, and by one that is resumed. Check `agent/internal/backup/journal.go` and `brokered_journal.go` for resume, and `apps/api/src/jobs/backupRetention.ts` for the GC sweep and its grace window of unreferenced objects.
  - (e) Why bucket usage can exceed the Storage Used estimate.
  - If a claim cannot be verified, leave it out and list it in the PR body under "Not documented: unverified".
- [ ] **Step 2: Write the page.** Sections: `What gets uploaded on each run`; `When a run uploads everything again`, as a table of the `fullRunReason` labels from Task 7 with the operator action for each; `Interrupted and failed runs`; `Reading a job's Uploaded and Reused numbers`, mirroring the UI copy; `Why storage in the bucket can be larger than you expect`. Use no customer data and no sizes from real tenants.
- [ ] **Step 3: Build check.** Run `pnpm --filter @breeze/docs build`. Expected: build succeeds, and the page appears in the backup sidebar after Monitoring.
- [ ] **Step 4: Commit.** `docs(backup): explain the incremental model and uploaded vs reused bytes (#11027)`
- [ ] **Step 5: Steady-state verification (this is not code; it is gated on #11012 / PR #11016 and #11014 being merged and deployed, and W03 being deployed).** Seven days after the later of those deploys, run a read-only query with the ops runbook's prod read access. Do not commit it, and do not put hostnames in the issue. For each `(device, backup_mode)` with ≥3 completed or completed_with_errors file/system_image runs in the window, report:
  - the share of runs with `run_kind = incremental`
  - the median `uploaded / protected` ratio
  - the distribution of `full_backup_reason`
  - the share of `failed` rows per `failureCategory` (computed with the shared classifier over exported `error_log` text, or over the API)

  Post the aggregate numbers only, with no tenant identifiers, as a comment on #11027. If steady-state incremental share is below 90%, or `unknown` is above 10% of failures, file a follow-up issue with the top reasons or messages and link it. Close #11027 only after this comment exists.

**W03 PR gate:** shared + api + web scoped runs as above; `tenant-export-policy.integration.test.ts` and `backupRetentionPins.integration.test.ts` locally on a test stack; `pnpm db:check-drift`; the full Integration Tests job in CI (it blocks the PR anyway).

---

## CI traps

- `tenant-export-policy.integration.test.ts` fails only under **Integration Tests**, never in Test API. W03's column must be in `included` before push.
- A migration overtaken by a newer one on `origin/main` fails the pre-push hook and poisons the merge queue. Rename it to sort last right before enqueueing. Never rename it after merge.
- Vitest path filters are substring matches. `src/components/backup` also matches `BackupJobList` and the others, which is intended. Check the reported file count.
- Every new en key goes into all locale dirs, or the locale guard suites under `apps/web/src/locales/*.test.ts` and humanized-key baselines go red.
- `@breeze/shared` changes run in the `test-shared` CI job. A shared-only red does not show in Test API.
- W01 and W02 both edit `DeviceBackupTab.tsx` and `BackupJobList.tsx`. Do not stack them on unmerged parents. Branch W02 from main after W01 merges.

## Wave list

| Wave | Scope | Depends on | Migration |
|---|---|---|---|
| W01 | Failure category: shared classifier, API `failureCategory`, badges in job list / device tab / dashboard, troubleshooting docs | none | none |
| W02 | Running backup on the device page: `activeJobs` on device status, shared progress/ETA helper, active-job cards + polling, header "Backup running" badge, docs | W01 merged | none |
| W03 | Uploaded vs reused bytes: `backup_jobs.full_backup_reason`, shared byte accounting, `dataAccounting` + `resumedAt` in API, UI summary + Full chip, incremental-model docs page, post-#11012/#11014 steady-state verification | W02 merged; Task 8 Step 5 also needs #11012 + #11014 deployed | 1 additive column |
