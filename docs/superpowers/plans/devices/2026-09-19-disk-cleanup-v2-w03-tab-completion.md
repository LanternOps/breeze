---
tracking_issue: LanternOps/breeze#TBD-REGISTERED-AFTER-PLANS
---
# Disk Cleanup v2 W03: Tab Completion and Consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Disk Cleanup tab so a tech can go select → execute → result → history without leaving it, make `cleanupRunId` mandatory on `cleanup-execute` so nothing is ever deleted that was not previewed, add the paginated cleanup-run history endpoints plus a daily retention sweep that stops the run table growing forever, and delete the duplicate disk-cleanup surface from File Manager so the concept has exactly one home.

**Architecture:** No schema, no agent change. On the API, `cleanup-execute` stops inserting a second run row and instead *claims* the pinned `previewed` run (`status='running'`, W02's enum label) and finalises it in place, which makes one row the whole lifecycle of one cleanup; two new read routes (`GET /filesystem/cleanup-runs`, `GET /filesystem/cleanup-runs/:runId`) are thin Hono glue over a new `services/filesystemCleanupRuns.ts` that owns the keyset query and the cursor codec; a new daily BullMQ worker (`jobs/filesystemCleanupRunRetention.ts`) deletes abandoned previews at 7 days and trims the candidates blob out of finished runs at 90 days. On the web, the 958-line `DeviceFilesystemTab.tsx` is split into `components/devices/filesystem/` — pure utils, two data hooks that each own an `AbortController`, and three presentational panels — and the tab becomes a composer that mounts VolumePicker (W02) → scan controls → snapshot panels → cleanup panel → run history. File Manager keeps a button that navigates to `/devices/:id#filesystem` and nothing else.

**Tech Stack:** TypeScript (Hono API, Drizzle ORM over postgres-js, BullMQ), React 19 islands under Astro, Vitest (API unit + web jsdom), i18next with 8 locale catalogs, Starlight MDX docs.

**Spec:** `docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md` — §2 defect 4 and the preview-row-retention half of defect 10; §3 row W03; §5.2 (required `cleanupRunId`, `GET /filesystem/cleanup-runs?limit=&cursor=`, `GET /filesystem/cleanup-runs/:runId`, the daily retention job); §8 in full **except** the VolumePicker / `useFilesystemVolumes` (W02) and `SystemCleanupPanel.tsx` (W04); §11's web + API bullets for those items; §11's docs bullet, limited to the "finished tab" and run-history parts of `apps/docs/src/content/docs/features/filesystem-analysis.mdx`.

**Branch:** `feature/<parent#>-disk-cleanup-v2/wave-<subissue#>`

---

## Plan amendments

Every spec claim this wave leans on was re-verified against the working tree on 2026-09-19 (branch `spec/disk-cleanup-v2`, `git log -1` = `502c736be5`). Where the spec is wrong or silent, the amendment below states the verified fact and what the plan does instead.

1. **W01 and W02 are assumed merged; this plan states exactly what it expects from them and fails loudly if it is absent.** Neither wave is on this branch yet (`apps/web/src/components/devices/filesystem/` does not exist; `apps/api/src/db/schema/filesystem.ts:18` still declares `filesystemCleanupRunStatusEnum` as `['previewed','executed','failed']` with no `'running'`; `deviceFilesystemCleanupRuns` has no `scanPath`, `kind` or `commandId` column; `routes/devices/filesystem.ts:399-405` still dispatches `{ path, recursive: true }`). The contracts this plan consumes are named in each task's **Interfaces → Consumes** block. All of them are TypeScript-visible, so if a wave has not landed the failure is a compile error at the typecheck step of the task that first needs it — never a silent behaviour change.

2. **The spec's retention rule ("trims `plan.candidates`") does not match the stored JSON shape.** The preview route writes `plan = { snapshotId, categories, preview }` (`routes/devices/filesystem.ts:298-302`) and `readPlanPreviewCandidates` reads `plan.preview.candidates` (`services/filesystemAnalysis.ts:384-391`). There is no `plan.candidates`. The retention job therefore trims the JSON path `{preview,candidates}`.

3. **`cleanup-execute` is changed from INSERT-a-second-row to claim-and-finalise the pinned run.** Today preview inserts one row (`filesystem.ts:292-305`) and execute inserts *another* (`filesystem.ts:423-441`), so one cleanup leaves two rows and the executed row's `plan` carries no candidates at all — which makes the spec's own 90-day trim a no-op and makes defect 10's "preview rows never pruned" strictly worse (the candidates blob would be stored twice if the executed row copied it). Claiming the pinned row instead gives: one row per cleanup, a meaningful trim, replay protection (`WHERE status='previewed'` is an atomic claim, so a double-submitted Execute cannot delete twice), and the same insert-then-update lifecycle §5.3 specifies for W04's system runs — which is what "record into the same run table" (§1) is supposed to mean. This is the only behaviour in this wave the spec does not literally state; it is recorded here rather than done silently.

4. **The claim uses W02's `'running'` enum label, and the retention job ages stale `kind='files'` runs out of it.** A `running` row whose API process died mid-dispatch would otherwise sit in the history forever (retention only deletes `previewed` and only trims `executed`/`failed`). The retention job therefore also fails `kind='files'` runs stuck in `running` for more than 24 h to `failed` with `error: 'interrupted'`. It is scoped to `kind='files'` on purpose: W04's `system_cleanup_run` legitimately stays `running` for up to its 2 h timeout and owns its own terminal transition.

5. **`upsertJobScheduler` is used, but `services/warrantyWorker.ts` is NOT the template the spec claims.** `warrantyWorker.ts:86-94` uses the legacy `queue.add(name, data, { repeat: { pattern } })` API after `getRepeatableJobs()`/`removeRepeatableByKey()`, not `upsertJobScheduler`. The only `upsertJobScheduler` production call site is `jobs/fleetRemediationDispatch.ts:80-87`, and `jobs/scheduleRegistry.contract.test.ts:20-23` says the codebase is migrating toward it. The retention job therefore uses `upsertJobScheduler` with `fleetRemediationDispatch.ts`'s argument shape and takes its retention/batching body from the nearest real sibling, `jobs/changeLogRetention.ts` (which is a daily, ctid-batched, `recordRetentionRun`-instrumented sweeper — `warrantyWorker.ts` is none of those things).

6. **A repeatable schedule cannot use a bare interval: it needs an allocated slot.** `jobs/scheduleRegistry.contract.test.ts` expands every coarse `repeat` option with the real cron parser and fails on any coarse `every:` and on any two coarse schedules that share a minute. `'3 22 * * *'` is free: hour 22 holds only `user-risk-scan` at minute 57 (`scheduleRegistry.ts:190`), and minute 3 is in the daily ≡3 (mod 5) lane.

7. **A new BullMQ Worker drags four other registries with it, none of which the spec names.** Verified: `services/workerRegistry.ts` (the lazily-loaded entry; `workerRegistry.test.ts:87` pins the exact name list *in order* and `:91`, `:133`, `:140`, `:148` pin the count at 142); `jobs/workerReadinessManifest.ts` (`jobs/workerReadinessCoverage.test.ts:136-146` asserts every `attachWorkerObservability` name is declared there exactly once); `attachWorkerObservability` itself (`workerReadinessCoverage.test.ts:129-134` fails any `new Worker(...)` without exactly one attach in the same file); and `services/retentionMetrics.ts`'s `RETENTION_JOB_NAMES`, which `retentionMetrics.test.ts:219-220` asserts is deduplicated and sorted. Task 5 does all four in one commit.

8. **`runActionAllowlist.ts` lists `DeviceFilesystemTab.tsx`, not `FileManager.tsx`.** The brief asks for allowlist cleanup "for FileManager if it is listed for a now-absent reason" — it is not listed anywhere (`grep -n FileManager apps/web/src/lib/runActionAllowlist.ts apps/web/src/lib/__tests__/no-silent-mutations.test.ts` returns nothing), so there is nothing to clean up there and FileManager's remaining `fetchWithAuth` calls are all reads or already-typed helpers. What *is* listed is `apps/web/src/components/devices/DeviceFilesystemTab.tsx` in `RUN_ACTION_MIGRATION_BACKLOG` — but **W01 Task 12 removes it and puts the tab in `TARGET_GLOBS` (count `146 → 147`)**, so Task 13 here only adds `filesystem/CleanupPanel.tsx` and bumps `147 → 148` (alignment 18).

9. **`FileManager.test.tsx` has no disk-cleanup coverage,** so removing the section breaks no existing test (`grep -in 'disk\|cleanup' apps/web/src/components/remote/FileManager.test.tsx` returns nothing; its 271 lines cover downloads and uploads only). Task 14 adds a test that pins the *replacement* instead.

10. **The AI lane is untouched by the required-`cleanupRunId` change and must not be "fixed" here.** `services/aiToolsFilesystem.ts:255-370` does not call the route: it builds its own preview with `buildCleanupPreview`, dispatches `file_delete` through `aiExecuteCommand`, and inserts its own run rows. Making the route's `cleanupRunId` required therefore cannot break it. Aligning it (and the double-insert it also does) is spec §9/W05 work; this wave leaves it alone.

11. **The existing route test at `routes/devices/filesystem.test.ts:216-232` posts `{ paths: ['/tmp/a.tmp'] }` with no `cleanupRunId` and expects 200.** It has to change in the same commit that makes the field required, or the suite goes red. Task 1 rewrites that case into the 400-on-missing-`cleanupRunId` case.

12. **The list endpoint omits `executedActions` as well as the candidates blob.** §5.2 only says "without the `plan.candidates` blob", but `executedActions` is up to 200 objects per row and 20 rows per page. The list returns `actionCount`, `candidateCount` and `estimatedBytes` computed in SQL (so the blobs never cross the wire at all) and the detail route returns the full row, which is exactly the split §5.2 intends.

13. **Web tests run against the real English catalogs.** `apps/web/vitest.config.ts` sets `setupFiles: ['src/__tests__/setup.ts']`, whose entire body is `import '@testing-library/jest-dom'; import '@/lib/i18n';`, and `lib/i18n/index.ts:20-36` eagerly bundles `locales/en/*.json`. So component tests assert on real English strings, and the locale keys must exist *before* the component tests that render them — which is why Task 7 (additive i18n) precedes every component task.

14. **Removing `deviceFilesystemTab.be1DiskCleanupIntelligence` / `.text` and re-valuing `.scanRunning` must land in the same commit as the tab rewrite.** `lib/i18n/localeParity.test.ts` requires identical key sets across all 8 catalogs, and `lib/i18n/extractionQuality.test.ts:186-205` fails any bare `t('key')` whose English value contains an unfilled `{{token}}` — so giving `scanRunning` the value `"Scan running ({{status}})"` while the old bare call site still exists is an immediate red. Task 7 is purely additive; Task 13 does the re-value and the two deletions together with the call sites.

15. **The `>=` prefix on an estimated directory size becomes a literal, not a translation key.** `deviceFilesystemTab.text` (`">="`) is a codemod artefact; a symbol has no translation, so putting it back as a key would add 8 exact-English duplicates and push `devices.json` toward its `translationCoverage.test.ts` baseline for no benefit. `FileManager.tsx:1342` already renders the same thing as a bare literal (`{dir.estimated ? '>=' : ''}`), so the new `SnapshotPanels.tsx` renders `≥` inline.

16. **`filesystem.ts` grows by ~60 lines, not ~200, because the query layer moves to a service.** `routes/devices/filesystem.ts` is 471 lines today; putting the keyset query, the cursor codec and the row serialisers in `services/filesystemCleanupRuns.ts` keeps the route file at ~530 and gives the pagination its own unit tests without a Hono harness — the same split `routes/monitorDefinitions.ts:679-686` uses over `services/monitors/episodeQueries.ts`. No new router is mounted, so `routes/devices/index.ts:81` is untouched and no mount-order test is needed.

17. **The cursor is `"<ISO8601>|<uuid>"`, and a malformed one is a 400.** `services/monitors/episodeQueries.ts:143-149` uses a bare ISO timestamp and *silently ignores* an unparseable cursor. Silently restarting a list from the top is the same class of invisible failure `runAction` exists to prevent, and a bare timestamp is not a stable keyset (two runs can share `requested_at`). This plan uses a composite `(requested_at, id)` tuple and answers 400 `invalid_cursor` on anything malformed.

18. **Cross-wave alignment pass (2026-09-19): this plan was corrected to the names W01 and W02 actually produce.** Four seams had drifted because the five plans were written in parallel. (a) **W01's execute contract**: the route holds `outcome` from `runCleanupExecution`, persists `executedActions` as the envelope `{ partial, budgetMs, actions }` (W01 amendment 8) and answers through `okJson`/`failJson` with `counts`, `partial` and `budgetMs` in `data` — Task 1's Step 5 previously wrote a bare `actions` array and dropped all three fields, which would have blanked FileManager's amber panel and the result panel's truncation notice. `CleanupExecuteResult` (Task 6) gains `partial`/`budgetMs`/`counts` to match. (b) **W02's volume seam**: `useFilesystemVolumes(deviceId)` returns `{ volumes, loading, error?, reload }` and holds **no** selection, and `VolumePicker` takes `selectedScanPath: string` + `loading` + `error` — not `{ selected, select }`. Task 13's composer therefore owns `selectedScanPath` state seeded from `osRootScanPath(osType)`, exactly as W02's own mount did before the split. (c) **`runActionAllowlist.ts`**: W01 Task 12 removes the tab from `RUN_ACTION_MIGRATION_BACKLOG` and bumps the count `146 → 147`; this wave only adds `filesystem/CleanupPanel.tsx` (`147 → 148`). (d) **Locales**: W01 Task 13 deletes `be1DiskCleanupIntelligence` and `text`; Task 13 here only re-values `scanRunning`. (e) **`actionCount` reads both shapes** — Task 2's SQL counted only a bare `jsonb` array, so every post-W01 run would have reported `0`; it now also unwraps the envelope's `actions` key. (f) **W02 Task 10's `scanPath` on the execute response** is preserved by the rewritten handler — it now comes from the claimed row rather than being re-derived.

---

## Global Constraints

- **No schema, no migration, no agent change.** Spec §3 row W03: Schema = none, Agent release = no. Nothing in this wave may touch `apps/api/migrations/`, `apps/api/src/db/schema/`, or `agent/`. `pnpm db:check-drift` must stay clean because nothing moved.
- **No new tenant-scoped table**, so no `rls-coverage.integration.test.ts` allowlist change, no `CORE_ORG_CASCADE_DELETE_ORDER` entry, and no `CORE_TENANT_EXPORT_POLICY` entry. Those contracts fire on a new table or a new **column**; this wave adds neither. (`device_filesystem_cleanup_runs` is already registered in all of them.)
- **Every web mutation goes through `runAction`** (`apps/web/src/lib/runAction.ts`), with the documented catch shape: `if (err instanceof ActionError && err.status === 401) return;` then `if (!(err instanceof ActionError)) showToast({ type: 'error', … })`. `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` must pass with the tab in `TARGET_GLOBS` and out of `RUN_ACTION_MIGRATION_BACKLOG` — W01 did that move; this wave adds `filesystem/CleanupPanel.tsx` (alignment 18).
- **Every poll owns an `AbortController` tied to unmount** (spec §8; defect 9 is "poll loop survives unmount"). No `setTimeout` chain may outlive the component that started it.
- **`key=` props use a stable id**, never an optional `path` (spec §8).
- **All new strings exist in all 8 locales** — `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/` — with real translations, not English copies: `lib/i18n/localeParity.test.ts` pins the key sets and `lib/i18n/translationCoverage.test.ts` fails on exact-English duplicates past each namespace's reviewed baseline.
- **File-size guideline:** each new file under `components/devices/filesystem/` stays under ~300 lines; `DeviceFilesystemTab.tsx` ends the wave as a composer, not a 958-line component.
- **Test placement is alongside source** (`Foo.tsx` → `Foo.test.tsx`, `foo.ts` → `foo.test.ts`).
- **Test commands:** API `cd apps/api && npx vitest run <path>`; web `cd apps/web && npx vitest run <path>`. **Never** `pnpm --filter <pkg> test -- --run <path>` — pnpm forwards the literal `--`, vitest stops flag parsing there, and the whole suite runs in watch mode. Vitest path filters are plain substrings, so sibling files are listed explicitly.
- **Typecheck commands** (exactly what CI's `typecheck` job runs): API — `pnpm exec tsc --noEmit --project apps/api/tsconfig.json` from the repo root; Web — `cd apps/web && pnpm exec astro check`.
- **Rigor is medium.** This wave touches a destructive device action (`file_delete` dispatch) but adds no table, no RLS surface and no migration: red-first on every task, typecheck, the affected suites per task, then the full `apps/api` and `apps/web` unit suites before the PR. No RLS or integration contract suite is required — but the four registry/contract suites named in Task 5 are, because a new BullMQ Worker trips all of them.
- Branch `feature/<parent#>-disk-cleanup-v2/wave-<subissue#>`; PR body contains `Closes #<subissue#>`. `get_feature_status` before starting the wave, `start_wave` when the branch exists.
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

**Why this task order.** The API contract comes first (Tasks 1–5) so the web work has something real to type against and so the wave can be reviewed in two halves. Inside the web half, the leaves come before the trunk: pure utils (6), then the locale keys every component renders (7), then the two hooks (8, 9), then the three panels (10, 11, 12), then the MOUNT task (13) that wires them into the page and proves the composition renders — past waves shipped green components that were never mounted, so 13 is not optional and its page-level test is the acceptance criterion for §8. File Manager consolidation (14) comes after the tab is real, so the link it adds points at something finished. Docs (15) come last. The repo compiles and its suites pass after every task.

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/api/src/routes/devices/filesystem.ts` | `cleanup-execute` claim/finalise (Task 1); the two `cleanup-runs` GET routes (Task 3) |
| `apps/api/src/routes/devices/filesystem.test.ts` | required `cleanupRunId`, 409 replay guard, update-in-place, both GET routes (Tasks 1, 3) |
| `apps/api/src/services/filesystemCleanupRuns.ts` (+ `.test.ts`) | cursor codec, keyset list query, row serialisers (Task 2) |
| `apps/api/src/jobs/filesystemCleanupRunRetention.ts` (+ `.test.ts`) | daily sweep: delete previews at 7 d, trim candidates at 90 d, age stale `running` at 24 h (Task 4) |
| `apps/api/src/jobs/scheduleRegistry.ts`, `services/retentionMetrics.ts`, `services/workerRegistry.ts`, `jobs/workerReadinessManifest.ts` | the four registrations a new Worker needs (Task 5) |
| `apps/web/src/components/devices/filesystem/filesystemTabUtils.ts` (+ `.test.ts`) | `formatBytes`, `normalizeHierarchyPath`, `isDescendantPath`, `collapseAncestorDirectories`, `readThresholdEvents`, shared types (Task 6) |
| `apps/web/src/locales/*/devices.json` | 40 additive `deviceFilesystemTab.*` leaves (Task 7); `scanRunning` re-value + 2 deletions (Task 13) |
| `apps/web/src/components/devices/filesystem/useFilesystemSnapshot.ts` (+ `.test.ts`) | path-scoped snapshot + threshold events, one `AbortController` (Task 8) |
| `apps/web/src/components/devices/filesystem/useCommandPoll.ts` (+ `.test.ts`) | backoff poll of `/devices/:id/commands/:commandId`, aborts on unmount (Task 9) |
| `apps/web/src/components/devices/filesystem/SnapshotPanels.tsx` (+ `.test.tsx`) | summary tiles, scan summary, collected signals, temp accumulation, threshold triggers, largest files/dirs (Task 10) |
| `apps/web/src/components/devices/filesystem/CleanupPanel.tsx` (+ `.test.tsx`) | category cards, size-sorted candidate table, select-all-in-category, Execute → destructive confirm → result panel (Task 11) |
| `apps/web/src/components/devices/filesystem/CleanupRunHistory.tsx` (+ `.test.tsx`) | paginated run history, both kinds (Task 12) |
| `apps/web/src/components/devices/DeviceFilesystemTab.tsx` (+ `.test.tsx`) | the composer + page-level mount proof (Task 13) |
| `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` | `TARGET_GLOBS` += `filesystem/CleanupPanel.tsx`, count `147 → 148` (Task 13; the backlog removal is W01's) |
| `apps/web/src/components/remote/FileManager.tsx` (+ `.test.tsx`), `apps/web/src/locales/*/remote.json` | disk section removed, "Open Disk Cleanup" link added, `fileManager.disk.*` reduced to 3 keys (Task 14) |
| `apps/docs/src/content/docs/features/filesystem-analysis.mdx`, `apps/api/src/data/docsIndex.json` | finished-tab + run-history docs, index regenerated (Task 15) |

---

### Task 1: `cleanupRunId` becomes required, and execute claims the pinned run

**Files:**
- Modify: `apps/api/src/routes/devices/filesystem.ts` (schema `:48-54`; execute handler `:331-471`)
- Modify (Test): `apps/api/src/routes/devices/filesystem.test.ts` (`:190-232` is the case that must change; new cases appended before the site-scope cases at `:344`)

**Interfaces:**
- Consumes (from W01, assumed merged, **with these exact names**): the execute handler calls `runCleanupExecution` (`services/filesystemCleanupExecution.ts`) with `budgetMs: CLEANUP_EXECUTE_BUDGET_MS` and holds its result in a local `outcome` — `outcome.actions` (per-path `status ∈ 'completed' | 'failed' | 'skipped_locked' | 'rejected' | 'skipped_budget'`), `outcome.rejectedPaths`, `outcome.bytesReclaimed`, `outcome.partial`, `outcome.budgetMs` — plus the derived `counts` record and `dispatchedPaths` array, and the `okJson`/`failJson` envelope helpers W01 Task 10 introduced in this file. It persists `executedActions` as W01's **envelope** `{ partial, budgetMs, actions }` (W01 amendment 8), never a bare array. This task changes **only** three things in that handler — the body schema, the pinned-run lookup, and the persistence call — and leaves W01's dispatch, budget, counts and response fields exactly as they stand.
- Consumes (from W02, assumed merged): `filesystemCleanupRunStatusEnum` includes `'running'`; `deviceFilesystemCleanupRuns` has `scanPath` and `kind` columns.
- Consumes (unchanged): `readPlanPreviewCandidates(plan: unknown): FilesystemCleanupCandidate[]` from `services/filesystemAnalysis.ts`.
- Produces: `POST /devices/:id/filesystem/cleanup-execute` with `cleanupRunId` required; `409 { success:false, error:'cleanup_run_not_previewable', data:{ cleanupRunId, status } }` when the pinned run is not `previewed`; the pinned row updated in place to `executed`/`failed`.

- [ ] **Step 1: Write the failing tests** — in `apps/api/src/routes/devices/filesystem.test.ts`, replace the whole `it('executes cleanup...')` case that currently posts without a `cleanupRunId` with the five cases below, and keep every other case as-is:

```ts
  it('rejects cleanup-execute with no cleanupRunId (W03: pinning is mandatory)', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1' } as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/tmp/a.tmp'] }),
    });

    expect(res.status).toBe(400);
    // The fallback branch is gone: no snapshot may be consulted, and nothing
    // may be deleted, when the caller did not pin a previewed run.
    expect(getLatestFilesystemCleanupSnapshot).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('claims the pinned run before dispatching and finalises the SAME row', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1' } as never);
    const runId = '22222222-2222-2222-2222-222222222222';

    // The claim is an UPDATE ... WHERE status='previewed' RETURNING, so the
    // route reads the plan off the claim, not off a prior SELECT.
    const claimReturning = vi.fn().mockResolvedValue([
      { id: runId, plan: { preview: { candidates: [] } }, scanPath: 'C:\\' },
    ]);
    const finalReturning = vi.fn().mockResolvedValue([{ id: runId }]);
    const setMock = vi.fn()
      .mockReturnValueOnce({ where: vi.fn().mockReturnValue({ returning: claimReturning }) })
      .mockReturnValueOnce({ where: vi.fn().mockReturnValue({ returning: finalReturning }) });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as never);

    vi.mocked(readPlanPreviewCandidates).mockReturnValue([
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true },
    ] as never);
    vi.mocked(executeCommand).mockResolvedValue({ status: 'completed' } as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/tmp/a.tmp'], cleanupRunId: runId }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // The pinned id comes back — NOT a freshly inserted second run.
    expect(body.data.cleanupRunId).toBe(runId);
    expect(body.data.bytesReclaimed).toBe(4096);
    expect(db.insert).not.toHaveBeenCalled();
    // Claim first (status running), finalise second (status executed).
    expect(setMock.mock.calls[0][0]).toMatchObject({ status: 'running' });
    expect(setMock.mock.calls[1][0]).toMatchObject({ status: 'executed', bytesReclaimed: 4096 });
    expect(setMock.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(executeCommand).mock.invocationCallOrder[0],
    );
  });

  it('answers 409 and deletes nothing when the pinned run is no longer previewed', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1' } as never);
    const runId = '22222222-2222-2222-2222-222222222222';

    // The claim matches no row (already executed, or a concurrent submit won).
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
      }),
    } as never);
    // The follow-up read that explains WHY finds the row in a terminal state.
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ status: 'executed' }]) }),
      }),
    } as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/tmp/a.tmp'], cleanupRunId: runId }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('cleanup_run_not_previewable');
    expect(body.data).toMatchObject({ cleanupRunId: runId, status: 'executed' });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('answers 404 when the pinned run does not exist for this device', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1' } as never);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
      }),
    } as never);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    } as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paths: ['/tmp/a.tmp'],
        cleanupRunId: '33333333-3333-3333-3333-333333333333',
      }),
    });

    expect(res.status).toBe(404);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('releases the claim back to failed when every action fails', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1' } as never);
    const runId = '22222222-2222-2222-2222-222222222222';
    const claimReturning = vi.fn().mockResolvedValue([
      { id: runId, plan: { preview: { candidates: [] } }, scanPath: '/' },
    ]);
    const setMock = vi.fn()
      .mockReturnValueOnce({ where: vi.fn().mockReturnValue({ returning: claimReturning }) })
      .mockReturnValueOnce({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: runId }]) }) });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as never);
    vi.mocked(readPlanPreviewCandidates).mockReturnValue([
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true },
    ] as never);
    vi.mocked(executeCommand).mockResolvedValue({ status: 'failed', error: 'boom' } as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/tmp/a.tmp'], cleanupRunId: runId }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('all cleanup actions failed');
    expect(setMock.mock.calls[1][0]).toMatchObject({ status: 'failed' });
  });
```

Also extend the `db` mock at the top of the file so `update` exists — change `apps/api/src/routes/devices/filesystem.test.ts:4-12` to:

```ts
vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  }
}));
```

and the schema mock at `:14-24` so the new columns the claim reads are present:

```ts
vi.mock('../../db/schema', () => ({
  deviceDisks: {
    deviceId: 'deviceId',
    usedPercent: 'usedPercent',
  },
  deviceFilesystemCleanupRuns: {
    id: 'id',
    deviceId: 'deviceId',
    plan: 'plan',
    status: 'status',
    scanPath: 'scanPath',
    kind: 'kind',
  },
}));
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/api && npx vitest run src/routes/devices/filesystem.test.ts
```

Expected failure: `rejects cleanup-execute with no cleanupRunId` fails with `expected 200 to be 400`, and the four new cases fail with `TypeError: db.update is not a function` (the route still inserts).

- [ ] **Step 3: Make `cleanupRunId` required** — in `apps/api/src/routes/devices/filesystem.ts`, replace the schema at `:48-54`:

```ts
const cleanupExecuteBodySchema = z.object({
  paths: z.array(z.string().min(1).max(4096)).min(1).max(200),
  // W03 (spec §5.2, §10.1): REQUIRED. Deleting from "whatever snapshot is now
  // latest" is exactly the race the pinning exists to prevent, and both real
  // callers hold an id from their own preview — the tab (W03) and the AI tool
  // (its own lane, W05). There is no caller left that needs the fallback, so
  // the fallback is gone rather than merely discouraged.
  cleanupRunId: z.string().guid(),
});
```

- [ ] **Step 4: Replace the candidate resolution with an atomic claim** — in the same file, replace the whole `let candidates …` block (currently `:351-384`, ending with the `} else { … }` fallback) with:

```ts
    // Atomic claim. `WHERE status = 'previewed'` is what makes a double-
    // submitted Execute safe: the second request matches zero rows and never
    // reaches a dispatch, instead of deleting the same paths twice. The claim
    // also returns the pinned plan, so no separate SELECT can observe a
    // different row than the one we just moved.
    const [claimed] = await db
      .update(deviceFilesystemCleanupRuns)
      .set({
        status: 'running',
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(deviceFilesystemCleanupRuns.id, cleanupRunId),
        eq(deviceFilesystemCleanupRuns.deviceId, deviceId),
        eq(deviceFilesystemCleanupRuns.status, 'previewed'),
      ))
      .returning({
        id: deviceFilesystemCleanupRuns.id,
        plan: deviceFilesystemCleanupRuns.plan,
        scanPath: deviceFilesystemCleanupRuns.scanPath,
      });

    if (!claimed) {
      // Distinguish "no such run for this device" (404) from "that run is not
      // previewable any more" (409). A bare 404 on the second case reads as a
      // bug in the client; the operator needs to know the run already ran.
      const [existing] = await db
        .select({ status: deviceFilesystemCleanupRuns.status })
        .from(deviceFilesystemCleanupRuns)
        .where(and(
          eq(deviceFilesystemCleanupRuns.id, cleanupRunId),
          eq(deviceFilesystemCleanupRuns.deviceId, deviceId),
        ))
        .limit(1);
      if (!existing) {
        return c.json({ success: false, error: 'Cleanup run not found' }, 404);
      }
      return c.json({
        success: false,
        error: 'cleanup_run_not_previewable',
        data: { cleanupRunId, status: existing.status },
      }, 409);
    }

    const candidates = readPlanPreviewCandidates(claimed.plan);
    if (candidates.length === 0) {
      // The pinned run carries no previewable candidates (a corrupt or
      // hand-edited plan). Put it back where it was rather than leaving it
      // stuck in `running` with nothing ever finalising it.
      await db
        .update(deviceFilesystemCleanupRuns)
        .set({ status: 'previewed', approvedAt: null, updatedAt: new Date() })
        .where(eq(deviceFilesystemCleanupRuns.id, cleanupRunId));
      return c.json({
        success: false,
        error: 'Pinned cleanup run has no previewable candidates (its stored preview is unavailable). Re-run the cleanup preview.',
      }, 400);
    }
```

- [ ] **Step 5: Finalise the claimed row instead of inserting a new one** — replace the `const [cleanupRun] = await db.insert(deviceFilesystemCleanupRuns)…returning();` block (currently `:423-441`) with:

```ts
    const planRecord =
      claimed.plan && typeof claimed.plan === 'object' && !Array.isArray(claimed.plan)
        ? (claimed.plan as Record<string, unknown>)
        : {};

    await db
      .update(deviceFilesystemCleanupRuns)
      .set({
        status: runStatus,
        // W01 amendment 8: the envelope, not a bare array — `partial` is how a
        // budget-truncated run tells the history it stopped early.
        executedActions: {
          partial: outcome.partial,
          budgetMs: outcome.budgetMs,
          actions: outcome.actions,
        },
        bytesReclaimed: outcome.bytesReclaimed,
        error: runError,
        updatedAt: new Date(),
        // The pinned preview STAYS in `plan` — it is what the 90-day retention
        // trim later removes, and what `GET /cleanup-runs/:runId` renders.
        plan: {
          ...planRecord,
          executedBy: auth.user.id,
          requestedPaths: requested,
          selectedPaths: dispatchedPaths,
          rejectedPaths: outcome.rejectedPaths,
        },
      })
      .where(eq(deviceFilesystemCleanupRuns.id, cleanupRunId))
      .returning({ id: deviceFilesystemCleanupRuns.id });
```

Then update the audit call and the response so both carry the pinned id (the local `cleanupRun` variable no longer exists):

```ts
    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.filesystem.cleanup.execute',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        cleanupRunId,
        scanPath: claimed.scanPath,
        requestedCount: requested.length,
        selectedCount: dispatchedPaths.length,
        failedCount: counts.failed,
        rejectedCount: counts.rejected,
        skippedLockedCount: counts.skipped_locked,
        skippedBudgetCount: counts.skipped_budget,
        rejectedPaths: outcome.rejectedPaths,
        partial: outcome.partial,
        bytesReclaimed: outcome.bytesReclaimed,
      },
      result: runStatus === 'executed' ? 'success' : 'failure',
    });

    // Same field set W01 Task 10 shipped, with the pinned id replacing the
    // freshly-inserted one. Dropping `counts`, `partial` or `budgetMs` here
    // would silently blind FileManager's amber panel and the result panel.
    const responseData = {
      cleanupRunId,
      // W02 Task 10's contract: every cleanup response carries the volume it
      // acted on. The pinned row is the authority now that execute claims it.
      scanPath: claimed.scanPath,
      status: runStatus,
      bytesReclaimed: outcome.bytesReclaimed,
      selectedCount: dispatchedPaths.length,
      failedCount: counts.failed,
      counts,
      rejectedPaths: outcome.rejectedPaths,
      partial: outcome.partial,
      budgetMs: outcome.budgetMs,
      actions: outcome.actions,
    };

    if (runStatus !== 'executed') {
      return failJson(c, 'all cleanup actions failed', 500, responseData);
    }

    return okJson(c, responseData);
```

- [ ] **Step 6: Run the tests and watch them pass**

```bash
cd apps/api && npx vitest run src/routes/devices/filesystem.test.ts
```

Expected: all cases PASS, including the pre-existing pinned-run, rejected-path and site-scope cases.

- [ ] **Step 7: Typecheck**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

Expected: no errors. A `Type '"running"' is not assignable` error here means W02 has not merged — stop and rebase rather than widening the enum in this wave.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/devices/filesystem.ts apps/api/src/routes/devices/filesystem.test.ts
git commit -m "$(cat <<'EOF'
feat(filesystem): require cleanupRunId and claim the pinned run on execute

cleanup-execute no longer falls back to "whatever snapshot is newest": the
pinned run id is required, and the route claims that row with an atomic
UPDATE ... WHERE status='previewed' before dispatching a single file_delete.
A double-submitted Execute now matches zero rows and answers 409 instead of
deleting the same paths twice, and one cleanup is one row for its whole
lifecycle (previewed -> running -> executed/failed) instead of two.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §5.2, §10.1

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The cleanup-run query service and its cursor

**Files:**
- Create: `apps/api/src/services/filesystemCleanupRuns.ts`
- Create: `apps/api/src/services/filesystemCleanupRuns.test.ts` (Test)

**Interfaces:**
- Consumes: `db` from `../db`; `deviceFilesystemCleanupRuns` from `../db/schema` (with W02's `scanPath` and `kind` columns); `and`, `desc`, `eq`, `lt`, `or`, `sql` from `drizzle-orm`.
- Produces:
  ```ts
  export const CLEANUP_RUNS_DEFAULT_LIMIT = 20;
  export const CLEANUP_RUNS_MAX_LIMIT = 100;
  export interface CleanupRunCursor { requestedAt: string; id: string }
  export function encodeCleanupRunCursor(row: { requestedAt: Date | string; id: string }): string;
  export function decodeCleanupRunCursor(token: string): CleanupRunCursor | null;
  export interface CleanupRunListItem {
    id: string; kind: string; status: string; scanPath: string | null;
    requestedAt: string; approvedAt: string | null;
    bytesReclaimed: number; error: string | null;
    candidateCount: number; estimatedBytes: number; actionCount: number;
  }
  export function listCleanupRuns(
    deviceId: string,
    opts: { limit: number; cursor?: string },
  ): Promise<{ runs: CleanupRunListItem[]; nextCursor: string | null }>;
  export function getCleanupRun(deviceId: string, runId: string): Promise<Record<string, unknown> | null>;
  ```

- [ ] **Step 1: Write the failing test** — create `apps/api/src/services/filesystemCleanupRuns.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));

vi.mock('../db/schema', () => ({
  deviceFilesystemCleanupRuns: {
    id: 'id',
    deviceId: 'device_id',
    kind: 'kind',
    status: 'status',
    scanPath: 'scan_path',
    requestedAt: 'requested_at',
    approvedAt: 'approved_at',
    bytesReclaimed: 'bytes_reclaimed',
    error: 'error',
    plan: 'plan',
    executedActions: 'executed_actions',
  },
}));

import { db } from '../db';
import {
  CLEANUP_RUNS_DEFAULT_LIMIT,
  CLEANUP_RUNS_MAX_LIMIT,
  decodeCleanupRunCursor,
  encodeCleanupRunCursor,
  getCleanupRun,
  listCleanupRuns,
} from './filesystemCleanupRuns';

const RUN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function mockRows(rows: unknown[]): void {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  } as never);
}

const row = (id: string, requestedAt: string, overrides: Record<string, unknown> = {}) => ({
  id,
  kind: 'files',
  status: 'executed',
  scanPath: 'C:\\',
  requestedAt: new Date(requestedAt),
  approvedAt: new Date(requestedAt),
  bytesReclaimed: 4096,
  error: null,
  candidateCount: 3,
  estimatedBytes: 12288,
  actionCount: 2,
  ...overrides,
});

describe('cleanup-run cursor codec', () => {
  it('round-trips a (requestedAt, id) keyset', () => {
    const token = encodeCleanupRunCursor({ requestedAt: new Date('2026-09-19T10:00:00.000Z'), id: RUN_A });
    expect(decodeCleanupRunCursor(token)).toEqual({
      requestedAt: '2026-09-19T10:00:00.000Z',
      id: RUN_A,
    });
  });

  it('accepts an ISO string as well as a Date', () => {
    const token = encodeCleanupRunCursor({ requestedAt: '2026-09-19T10:00:00.000Z', id: RUN_A });
    expect(token).toBe(`2026-09-19T10:00:00.000Z|${RUN_A}`);
  });

  it('rejects malformed tokens rather than silently restarting the walk', () => {
    // A cursor that cannot be parsed must be a visible 400 at the route, not a
    // silent "page 1 again" — which is how a paginated list loops forever.
    expect(decodeCleanupRunCursor('')).toBeNull();
    expect(decodeCleanupRunCursor('nonsense')).toBeNull();
    expect(decodeCleanupRunCursor(`not-a-date|${RUN_A}`)).toBeNull();
    expect(decodeCleanupRunCursor('2026-09-19T10:00:00.000Z|not-a-uuid')).toBeNull();
    expect(decodeCleanupRunCursor(`2026-09-19T10:00:00.000Z|${RUN_A}|extra`)).toBeNull();
  });
});

describe('listCleanupRuns', () => {
  beforeEach(() => vi.clearAllMocks());

  it('over-fetches by one and returns a nextCursor built from the last kept row', async () => {
    mockRows([
      row(RUN_A, '2026-09-19T10:00:00.000Z'),
      row(RUN_B, '2026-09-19T09:00:00.000Z'),
    ]);

    const result = await listCleanupRuns(DEVICE, { limit: 1 });

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].id).toBe(RUN_A);
    expect(result.nextCursor).toBe(`2026-09-19T10:00:00.000Z|${RUN_A}`);
  });

  it('returns a null nextCursor on a short page', async () => {
    mockRows([row(RUN_A, '2026-09-19T10:00:00.000Z')]);
    const result = await listCleanupRuns(DEVICE, { limit: 20 });
    expect(result.runs).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  it('serialises timestamps as ISO strings and never leaks the blobs', async () => {
    mockRows([row(RUN_A, '2026-09-19T10:00:00.000Z')]);
    const result = await listCleanupRuns(DEVICE, { limit: 20 });
    expect(result.runs[0]).toEqual({
      id: RUN_A,
      kind: 'files',
      status: 'executed',
      scanPath: 'C:\\',
      requestedAt: '2026-09-19T10:00:00.000Z',
      approvedAt: '2026-09-19T10:00:00.000Z',
      bytesReclaimed: 4096,
      error: null,
      candidateCount: 3,
      estimatedBytes: 12288,
      actionCount: 2,
    });
    expect(result.runs[0]).not.toHaveProperty('plan');
    expect(result.runs[0]).not.toHaveProperty('executedActions');
  });

  it('clamps the limit to the hard maximum', async () => {
    const limitFn = vi.fn().mockResolvedValue([]);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({ limit: limitFn }),
        }),
      }),
    } as never);

    await listCleanupRuns(DEVICE, { limit: 10_000 });
    expect(limitFn).toHaveBeenCalledWith(CLEANUP_RUNS_MAX_LIMIT + 1);
  });

  it('falls back to the default limit for a non-positive value', async () => {
    const limitFn = vi.fn().mockResolvedValue([]);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({ limit: limitFn }),
        }),
      }),
    } as never);

    await listCleanupRuns(DEVICE, { limit: 0 });
    expect(limitFn).toHaveBeenCalledWith(CLEANUP_RUNS_DEFAULT_LIMIT + 1);
  });
});

describe('getCleanupRun', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the full row including the plan and executed actions', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: RUN_A,
            kind: 'files',
            status: 'executed',
            scanPath: '/',
            requestedAt: new Date('2026-09-19T10:00:00.000Z'),
            approvedAt: null,
            bytesReclaimed: 0,
            error: null,
            plan: { preview: { candidates: [{ path: '/tmp/a' }] } },
            executedActions: [{ path: '/tmp/a', status: 'completed' }],
          }]),
        }),
      }),
    } as never);

    const run = await getCleanupRun(DEVICE, RUN_A);

    expect(run).toMatchObject({
      id: RUN_A,
      requestedAt: '2026-09-19T10:00:00.000Z',
      approvedAt: null,
      plan: { preview: { candidates: [{ path: '/tmp/a' }] } },
      executedActions: [{ path: '/tmp/a', status: 'completed' }],
    });
  });

  it('returns null when the run belongs to another device', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    } as never);

    expect(await getCleanupRun(DEVICE, RUN_B)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/filesystemCleanupRuns.test.ts
```

Expected failure: `Failed to load .../filesystemCleanupRuns.test.ts` … `Cannot find module './filesystemCleanupRuns'`.

- [ ] **Step 3: Implement** — create `apps/api/src/services/filesystemCleanupRuns.ts`:

```ts
/**
 * Read model for `device_filesystem_cleanup_runs` (Disk Cleanup v2, spec §5.2).
 *
 * The history list and the run detail are split deliberately. A `previewed`
 * run's `plan.preview.candidates` is up to 1000 objects and an executed run's
 * `executedActions` is up to 200 — a 20-row page carrying both would be
 * megabytes of JSON nobody renders. The list therefore computes the three
 * numbers the UI actually shows (candidate count, estimated bytes, action
 * count) IN SQL, so the blobs never leave Postgres, and the detail route is
 * the one place that ships them.
 *
 * Pagination is a keyset on `(requested_at, id)`, both DESC, not an offset:
 * a cleanup running while an operator pages would shift every offset page.
 * The tuple (rather than a bare timestamp) is what makes the walk stable when
 * two runs share a `requested_at` — `requested_at` is `defaultNow()`, so two
 * previews from one click of a bulk action genuinely can collide.
 */

import { and, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { deviceFilesystemCleanupRuns } from '../db/schema';

/** Per-request default when the client passes no `limit`. */
export const CLEANUP_RUNS_DEFAULT_LIMIT = 20;
/** Defensive ceiling; the UI never asks for more than a screenful. */
export const CLEANUP_RUNS_MAX_LIMIT = 100;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface CleanupRunCursor {
  /** ISO-8601, exactly as re-parsed by Postgres on the next round trip. */
  requestedAt: string;
  id: string;
}

export interface CleanupRunListItem {
  id: string;
  kind: string;
  status: string;
  scanPath: string | null;
  requestedAt: string;
  approvedAt: string | null;
  bytesReclaimed: number;
  error: string | null;
  candidateCount: number;
  estimatedBytes: number;
  actionCount: number;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * `"<ISO8601>|<uuid>"`. Readable in a log line and diffable by hand, which a
 * base64url blob is not; there is nothing secret in a page boundary.
 */
export function encodeCleanupRunCursor(row: { requestedAt: Date | string; id: string }): string {
  return `${iso(row.requestedAt)}|${row.id}`;
}

/**
 * Returns null on ANY malformed token. The caller answers 400 rather than
 * ignoring it: silently restarting the walk from the top turns a bad cursor
 * into an infinite "Load more" that re-renders page 1 forever.
 */
export function decodeCleanupRunCursor(token: string): CleanupRunCursor | null {
  if (!token) return null;
  const parts = token.split('|');
  if (parts.length !== 2) return null;
  const [rawDate, id] = parts;
  if (!UUID_RE.test(id)) return null;
  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return null;
  return { requestedAt: parsed.toISOString(), id };
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) return CLEANUP_RUNS_DEFAULT_LIMIT;
  return Math.min(CLEANUP_RUNS_MAX_LIMIT, Math.trunc(limit));
}

/**
 * `jsonb_array_length` raises on a non-array, and a hand-edited or partially
 * trimmed `plan` is exactly where a non-array turns up — so the type is
 * checked first and anything else counts as zero rather than 500ing the page.
 */
const candidateCountSql = sql<number>`
  CASE WHEN jsonb_typeof(${deviceFilesystemCleanupRuns.plan} #> '{preview,candidates}') = 'array'
       THEN jsonb_array_length(${deviceFilesystemCleanupRuns.plan} #> '{preview,candidates}')
       ELSE 0 END
`.mapWith(Number);

const estimatedBytesSql = sql<number>`
  COALESCE((${deviceFilesystemCleanupRuns.plan} #>> '{preview,estimatedBytes}')::bigint, 0)
`.mapWith(Number);

// W01 amendment 8 turned this column into `{ partial, budgetMs, actions }`,
// but pre-W01 rows are still a bare array and `readExecutedActions` tolerates
// both — so the SQL has to as well, or every run the new code writes reports
// `actionCount: 0` in the history while its detail page shows two hundred.
const actionCountSql = sql<number>`
  CASE
    WHEN jsonb_typeof(${deviceFilesystemCleanupRuns.executedActions}) = 'array'
      THEN jsonb_array_length(${deviceFilesystemCleanupRuns.executedActions})
    WHEN jsonb_typeof(${deviceFilesystemCleanupRuns.executedActions} -> 'actions') = 'array'
      THEN jsonb_array_length(${deviceFilesystemCleanupRuns.executedActions} -> 'actions')
    ELSE 0
  END
`.mapWith(Number);

export async function listCleanupRuns(
  deviceId: string,
  opts: { limit: number; cursor?: string },
): Promise<{ runs: CleanupRunListItem[]; nextCursor: string | null }> {
  const limit = clampLimit(opts.limit);

  const conditions: SQL[] = [eq(deviceFilesystemCleanupRuns.deviceId, deviceId)];
  if (opts.cursor) {
    const cursor = decodeCleanupRunCursor(opts.cursor);
    // A cursor that failed to decode never reaches here — the route rejects it
    // — but belt and braces: an undecodable one degrades to "first page".
    if (cursor) {
      const keyset = or(
        sql`${deviceFilesystemCleanupRuns.requestedAt} < ${cursor.requestedAt}::timestamp`,
        and(
          sql`${deviceFilesystemCleanupRuns.requestedAt} = ${cursor.requestedAt}::timestamp`,
          sql`${deviceFilesystemCleanupRuns.id} < ${cursor.id}::uuid`,
        ),
      );
      if (keyset) conditions.push(keyset);
    }
  }

  const rows = await db
    .select({
      id: deviceFilesystemCleanupRuns.id,
      kind: deviceFilesystemCleanupRuns.kind,
      status: deviceFilesystemCleanupRuns.status,
      scanPath: deviceFilesystemCleanupRuns.scanPath,
      requestedAt: deviceFilesystemCleanupRuns.requestedAt,
      approvedAt: deviceFilesystemCleanupRuns.approvedAt,
      bytesReclaimed: deviceFilesystemCleanupRuns.bytesReclaimed,
      error: deviceFilesystemCleanupRuns.error,
      candidateCount: candidateCountSql,
      estimatedBytes: estimatedBytesSql,
      actionCount: actionCountSql,
    })
    .from(deviceFilesystemCleanupRuns)
    .where(and(...conditions))
    .orderBy(desc(deviceFilesystemCleanupRuns.requestedAt), desc(deviceFilesystemCleanupRuns.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCleanupRunCursor(last) : null;

  return {
    runs: page.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      scanPath: row.scanPath,
      requestedAt: iso(row.requestedAt)!,
      approvedAt: iso(row.approvedAt),
      bytesReclaimed: Number(row.bytesReclaimed ?? 0),
      error: row.error,
      candidateCount: Number(row.candidateCount ?? 0),
      estimatedBytes: Number(row.estimatedBytes ?? 0),
      actionCount: Number(row.actionCount ?? 0),
    })),
    nextCursor,
  };
}

/**
 * The full row, blobs included. Scoped by `deviceId` as well as `id` so a run
 * id guessed from another device answers 404 rather than leaking a plan.
 */
export async function getCleanupRun(
  deviceId: string,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const [run] = await db
    .select({
      id: deviceFilesystemCleanupRuns.id,
      kind: deviceFilesystemCleanupRuns.kind,
      status: deviceFilesystemCleanupRuns.status,
      scanPath: deviceFilesystemCleanupRuns.scanPath,
      requestedAt: deviceFilesystemCleanupRuns.requestedAt,
      approvedAt: deviceFilesystemCleanupRuns.approvedAt,
      bytesReclaimed: deviceFilesystemCleanupRuns.bytesReclaimed,
      error: deviceFilesystemCleanupRuns.error,
      plan: deviceFilesystemCleanupRuns.plan,
      executedActions: deviceFilesystemCleanupRuns.executedActions,
    })
    .from(deviceFilesystemCleanupRuns)
    .where(and(
      eq(deviceFilesystemCleanupRuns.id, runId),
      eq(deviceFilesystemCleanupRuns.deviceId, deviceId),
    ))
    .limit(1);

  if (!run) return null;

  return {
    ...run,
    requestedAt: iso(run.requestedAt),
    approvedAt: iso(run.approvedAt),
    bytesReclaimed: Number(run.bytesReclaimed ?? 0),
  };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
cd apps/api && npx vitest run src/services/filesystemCleanupRuns.test.ts
```

Expected: 10 tests PASS.

- [ ] **Step 5: Typecheck**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

Expected: no errors. An error on `deviceFilesystemCleanupRuns.scanPath` or `.kind` means W02 has not merged.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/filesystemCleanupRuns.ts apps/api/src/services/filesystemCleanupRuns.test.ts
git commit -m "$(cat <<'EOF'
feat(filesystem): cleanup-run read model with a stable (requested_at, id) keyset

listCleanupRuns computes candidate count, estimated bytes and action count in
SQL so neither the plan nor the executedActions blob crosses the wire for a
history page; getCleanupRun is the one place that ships them. The cursor is a
(requested_at, id) tuple rather than a bare timestamp, so two runs created in
the same millisecond cannot drop or duplicate a row, and a malformed token
decodes to null so the route can answer 400 instead of silently restarting.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §5.2

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The two cleanup-run GET routes

**Files:**
- Modify: `apps/api/src/routes/devices/filesystem.ts` (imports at `:1-22`; new routes appended after the execute handler, currently ending `:471`)
- Modify (Test): `apps/api/src/routes/devices/filesystem.test.ts` (mock block at `:56-67`; new cases appended)

**Interfaces:**
- Consumes: `listCleanupRuns`, `getCleanupRun`, `decodeCleanupRunCursor`, `CLEANUP_RUNS_DEFAULT_LIMIT`, `CLEANUP_RUNS_MAX_LIMIT` from `../../services/filesystemCleanupRuns`; `getDeviceWithOrgAndSiteCheck`, `SITE_ACCESS_DENIED` from `./helpers`.
- Produces: `GET /devices/:id/filesystem/cleanup-runs?limit=&cursor=` → `{ success: true, data: { runs, nextCursor } }`; `GET /devices/:id/filesystem/cleanup-runs/:runId` → `{ success: true, data: <full row> }`. Both gated by `requireScope('organization','partner','system')` + `requirePermission(DEVICES_READ)`, no `requireMfa` (reads).

- [ ] **Step 1: Write the failing tests** — first extend the service mock in `apps/api/src/routes/devices/filesystem.test.ts` by adding this block next to the existing `vi.mock('../../services/filesystemAnalysis', …)`:

```ts
vi.mock('../../services/filesystemCleanupRuns', () => ({
  CLEANUP_RUNS_DEFAULT_LIMIT: 20,
  CLEANUP_RUNS_MAX_LIMIT: 100,
  decodeCleanupRunCursor: vi.fn(() => ({ requestedAt: '2026-09-19T10:00:00.000Z', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })),
  listCleanupRuns: vi.fn(),
  getCleanupRun: vi.fn(),
}));
```

and the matching import next to the others:

```ts
import {
  decodeCleanupRunCursor,
  getCleanupRun,
  listCleanupRuns,
} from '../../services/filesystemCleanupRuns';
```

Then append these cases inside the `describe('device filesystem routes', …)` block:

```ts
  it('lists cleanup runs with the default limit and returns the nextCursor', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1' } as never);
    vi.mocked(listCleanupRuns).mockResolvedValue({
      runs: [{
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        kind: 'files',
        status: 'executed',
        scanPath: 'C:\\',
        requestedAt: '2026-09-19T10:00:00.000Z',
        approvedAt: '2026-09-19T10:01:00.000Z',
        bytesReclaimed: 4096,
        error: null,
        candidateCount: 3,
        estimatedBytes: 12288,
        actionCount: 2,
      }],
      nextCursor: '2026-09-19T10:00:00.000Z|aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    } as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-runs`, {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.runs).toHaveLength(1);
    expect(body.data.nextCursor).toBe('2026-09-19T10:00:00.000Z|aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(listCleanupRuns).toHaveBeenCalledWith(deviceId, { limit: 20 });
  });

  it('passes a decoded cursor and an explicit limit through', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1' } as never);
    vi.mocked(listCleanupRuns).mockResolvedValue({ runs: [], nextCursor: null } as never);

    const res = await app.request(
      `/devices/${deviceId}/filesystem/cleanup-runs?limit=5&cursor=2026-09-19T10%3A00%3A00.000Z%7Caaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      { headers: { Authorization: 'Bearer token' } },
    );

    expect(res.status).toBe(200);
    expect(listCleanupRuns).toHaveBeenCalledWith(deviceId, {
      limit: 5,
      cursor: '2026-09-19T10:00:00.000Z|aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
  });

  it('answers 400 on a malformed cursor instead of silently restarting the list', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1' } as never);
    vi.mocked(decodeCleanupRunCursor).mockReturnValueOnce(null as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-runs?cursor=nonsense`, {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('invalid_cursor');
    expect(listCleanupRuns).not.toHaveBeenCalled();
  });

  it('returns the full row from the cleanup-run detail route', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1' } as never);
    vi.mocked(getCleanupRun).mockResolvedValue({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      plan: { preview: { candidates: [{ path: '/tmp/a' }] } },
      executedActions: [{ path: '/tmp/a', status: 'completed' }],
    } as never);

    const res = await app.request(
      `/devices/${deviceId}/filesystem/cleanup-runs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      { headers: { Authorization: 'Bearer token' } },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.plan.preview.candidates).toHaveLength(1);
    expect(getCleanupRun).toHaveBeenCalledWith(deviceId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('answers 404 for a cleanup run that is not this device\u2019s', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1' } as never);
    vi.mocked(getCleanupRun).mockResolvedValue(null as never);

    const res = await app.request(
      `/devices/${deviceId}/filesystem/cleanup-runs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      { headers: { Authorization: 'Bearer token' } },
    );

    expect(res.status).toBe(404);
  });

  it('denies the cleanup-run history when site scope excludes the device', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SITE_ACCESS_DENIED as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-runs`, {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    expect(listCleanupRuns).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/api && npx vitest run src/routes/devices/filesystem.test.ts
```

Expected failure: every new case fails with `expected 404 to be 200` (or `to be 400`/`403`) — Hono has no handler registered for `/filesystem/cleanup-runs`.

- [ ] **Step 3: Implement** — in `apps/api/src/routes/devices/filesystem.ts`, add the import next to the existing service imports:

```ts
import {
  CLEANUP_RUNS_DEFAULT_LIMIT,
  CLEANUP_RUNS_MAX_LIMIT,
  decodeCleanupRunCursor,
  getCleanupRun,
  listCleanupRuns,
} from '../../services/filesystemCleanupRuns';
```

then append both routes at the end of the file:

```ts
const cleanupRunParamSchema = z.object({
  id: z.string().guid(),
  runId: z.string().guid(),
});

filesystemRoutes.get(
  '/:id/filesystem/cleanup-runs',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ success: false, error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ success: false, error: 'Device not found' }, 404);
    }

    const rawLimit = Number.parseInt(c.req.query('limit') ?? '', 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(CLEANUP_RUNS_MAX_LIMIT, rawLimit)
      : CLEANUP_RUNS_DEFAULT_LIMIT;

    const rawCursor = c.req.query('cursor');
    if (rawCursor !== undefined && decodeCleanupRunCursor(rawCursor) === null) {
      // Ignoring it would re-serve page 1 forever under a "Load more" button —
      // a silent failure the operator reads as "the history is stuck".
      return c.json({ success: false, error: 'invalid_cursor' }, 400);
    }

    const result = await listCleanupRuns(deviceId, {
      limit,
      ...(rawCursor !== undefined ? { cursor: rawCursor } : {}),
    });

    return c.json({ success: true, data: result });
  }
);

filesystemRoutes.get(
  '/:id/filesystem/cleanup-runs/:runId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', cleanupRunParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId, runId } = c.req.valid('param');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ success: false, error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ success: false, error: 'Device not found' }, 404);
    }

    const run = await getCleanupRun(deviceId, runId);
    if (!run) {
      return c.json({ success: false, error: 'Cleanup run not found' }, 404);
    }

    return c.json({ success: true, data: run });
  }
);
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
cd apps/api && npx vitest run src/routes/devices/filesystem.test.ts src/services/filesystemCleanupRuns.test.ts
```

Expected: both files PASS (the route file's pre-existing cases included).

- [ ] **Step 5: Typecheck**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/devices/filesystem.ts apps/api/src/routes/devices/filesystem.test.ts
git commit -m "$(cat <<'EOF'
feat(filesystem): GET cleanup-runs history and run detail

Two DEVICES_READ routes on the existing filesystem router: a keyset-paginated
history of both run kinds that carries counts instead of the plan and action
blobs, and a detail route that returns the full row. A malformed cursor is a
400 rather than a silent restart of the walk.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §5.2

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The daily cleanup-run retention worker

**Files:**
- Create: `apps/api/src/jobs/filesystemCleanupRunRetention.ts`
- Create: `apps/api/src/jobs/filesystemCleanupRunRetention.test.ts` (Test)

**Interfaces:**
- Consumes: `pruneInCtidBatches`, `parsePositiveIntEnv`, `resolveRetentionDays`, `warnOnRetentionBacklog` from `./retentionBatch`; `db`, `runOutsideDbContext`, `withSystemDbAccessContext` from `../db`; `extractRowCount` from `../db/rowCount`; `getBullMQConnection` from `../services/redis`; `attachWorkerObservability` from `./workerObservability`; `jobSchedule` from `./scheduleRegistry` (Task 5 adds the key); `recordRetentionRun` from `../services/retentionMetrics` (Task 5 adds the name); `captureException` from `../services/sentry`.
- Produces:
  ```ts
  export function getFilesystemCleanupRunRetentionQueue(): Queue;
  export function createFilesystemCleanupRunRetentionWorker(): Worker<RetentionJobData>;
  export async function runFilesystemCleanupRunRetention(job?: RetentionJobData): Promise<{
    previewsDeleted: number; plansTrimmed: number; stuckRunsFailed: number;
    batches: number; hasMore: boolean; durationMs: number;
  }>;
  export async function initializeFilesystemCleanupRunRetention(): Promise<void>;
  export async function shutdownFilesystemCleanupRunRetention(): Promise<void>;
  export const __testOnly: { QUEUE_NAME: string; PREVIEW_RETENTION_DAYS: number; PLAN_RETENTION_DAYS: number; STUCK_RUN_HOURS: number; BATCH_SIZE: number; MAX_BATCHES: number };
  ```

- [ ] **Step 1: Write the failing test** — create `apps/api/src/jobs/filesystemCleanupRunRetention.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const upsertJobSchedulerMock = vi.fn();
const attachMock = vi.fn();

vi.mock('bullmq', () => ({
  Queue: class {
    upsertJobScheduler = upsertJobSchedulerMock;
    close = vi.fn();
  },
  Worker: class {
    constructor(public name: string, public processor: unknown, public opts: unknown) {}
    on = vi.fn();
    close = vi.fn();
  },
}));

vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: attachMock }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const recordRetentionRunMock = vi.fn();
vi.mock('../services/retentionMetrics', () => ({ recordRetentionRun: recordRetentionRunMock }));

const pruneMock = vi.fn();
const warnMock = vi.fn();
vi.mock('./retentionBatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./retentionBatch')>();
  return {
    ...actual,
    pruneInCtidBatches: pruneMock,
    warnOnRetentionBacklog: warnMock,
  };
});

const executeMock = vi.fn();
vi.mock('../db', () => ({
  db: { execute: (...args: unknown[]) => executeMock(...args) },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  __testOnly,
  initializeFilesystemCleanupRunRetention,
  runFilesystemCleanupRunRetention,
} from './filesystemCleanupRunRetention';

/** Flatten a drizzle sql template into readable text for assertions. */
function sqlText(fragment: { queryChunks?: unknown[] } | unknown): string {
  return JSON.stringify(fragment);
}

describe('filesystem cleanup-run retention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pruneMock.mockResolvedValue({ deleted: 0, batches: 1, hasMore: false });
    executeMock.mockResolvedValue({ count: 0 });
  });

  it('deletes only previewed runs, and only past the preview cutoff', async () => {
    pruneMock.mockResolvedValue({ deleted: 7, batches: 1, hasMore: false });

    const result = await runFilesystemCleanupRunRetention();

    expect(result.previewsDeleted).toBe(7);
    expect(pruneMock).toHaveBeenCalledTimes(1);
    const args = pruneMock.mock.calls[0][0];
    expect(args.table).toBe('device_filesystem_cleanup_runs');
    // Status guard and cutoff both present: an executed run must never be
    // deleted by the 7-day sweep, only trimmed by the 90-day one.
    expect(sqlText(args.where)).toContain('previewed');
    expect(args.batchSize).toBe(__testOnly.BATCH_SIZE);
    expect(args.maxBatches).toBe(__testOnly.MAX_BATCHES);
  });

  it('trims the pinned candidates out of finished runs in bounded batches', async () => {
    // Two full batches then a short one: the loop must stop on the short batch.
    executeMock
      .mockResolvedValueOnce({ count: __testOnly.BATCH_SIZE })
      .mockResolvedValueOnce({ count: 3 })
      .mockResolvedValue({ count: 0 });

    const result = await runFilesystemCleanupRunRetention();

    expect(result.plansTrimmed).toBe(__testOnly.BATCH_SIZE + 3);
    const statements = executeMock.mock.calls.map(([fragment]) => sqlText(fragment));
    const trimStatements = statements.filter((s) => s.includes('preview,candidates'));
    expect(trimStatements.length).toBeGreaterThanOrEqual(2);
    // The trim keeps the summary and executedActions — it removes ONE json path.
    expect(trimStatements[0]).not.toContain('executed_actions');
  });

  it('ages a file run stuck in running past the stale window to failed', async () => {
    executeMock.mockResolvedValue({ count: 0 });
    executeMock.mockResolvedValueOnce({ count: 0 });  // trim batch (short, stops)
    executeMock.mockResolvedValueOnce({ count: 2 });  // stuck-run sweep

    const result = await runFilesystemCleanupRunRetention();

    expect(result.stuckRunsFailed).toBe(2);
    const stuck = executeMock.mock.calls.map(([f]) => sqlText(f)).find((s) => s.includes('interrupted'));
    expect(stuck).toBeDefined();
    // Scoped to file runs: W04's system runs legitimately sit in `running`
    // for up to their two-hour timeout and own their own terminal transition.
    expect(stuck).toContain('files');
  });

  it('opens a FRESH system context per batch rather than one around the loop', async () => {
    executeMock.mockResolvedValue({ count: 0 });
    await runFilesystemCleanupRunRetention();

    // Nesting inside one outer context would hold every lock until the last
    // batch committed — strictly worse than the unbounded statement it replaces.
    expect(vi.mocked(runOutsideDbContext).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(withSystemDbAccessContext).mock.calls.length)
      .toBe(vi.mocked(runOutsideDbContext).mock.calls.length);
  });

  it('publishes a retention metric for the run', async () => {
    pruneMock.mockResolvedValue({ deleted: 4, batches: 1, hasMore: false });
    await runFilesystemCleanupRunRetention();

    expect(recordRetentionRunMock).toHaveBeenCalledWith(
      'filesystem_cleanup_run_retention',
      expect.objectContaining({ rowsDeleted: 4, incomplete: false }),
    );
  });

  it('reports a backlog when the prune hit its batch cap', async () => {
    pruneMock.mockResolvedValue({ deleted: 100, batches: __testOnly.MAX_BATCHES, hasMore: true });
    const result = await runFilesystemCleanupRunRetention();

    expect(result.hasMore).toBe(true);
    expect(warnMock).toHaveBeenCalled();
    expect(recordRetentionRunMock).toHaveBeenCalledWith(
      'filesystem_cleanup_run_retention',
      expect.objectContaining({ incomplete: true }),
    );
  });

  it('registers the repeatable through upsertJobScheduler on the allocated slot', async () => {
    await initializeFilesystemCleanupRunRetention();

    expect(attachMock).toHaveBeenCalledWith(expect.anything(), 'filesystemCleanupRunRetention');
    expect(upsertJobSchedulerMock).toHaveBeenCalledTimes(1);
    const [schedulerId, repeat, job] = upsertJobSchedulerMock.mock.calls[0];
    expect(schedulerId).toBe(__testOnly.QUEUE_NAME);
    // A cron pattern, never `every: 24h` — BullMQ anchors `every` to the epoch
    // so every 24h repeatable fires at 00:00:00.000 UTC together.
    expect(repeat).toEqual({ pattern: '3 22 * * *' });
    expect(repeat).not.toHaveProperty('every');
    expect(job).toMatchObject({ name: 'sweep' });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/jobs/filesystemCleanupRunRetention.test.ts
```

Expected failure: `Failed to load .../filesystemCleanupRunRetention.test.ts` … `Cannot find module './filesystemCleanupRunRetention'`.

- [ ] **Step 3: Implement** — create `apps/api/src/jobs/filesystemCleanupRunRetention.ts`:

```ts
/**
 * Disk-cleanup run retention (Disk Cleanup v2, spec §5.2; defect 10).
 *
 * `device_filesystem_cleanup_runs` grew without bound: every Cleanup Preview
 * click writes a row carrying up to 1000 candidate objects in `plan`, and
 * nothing ever removed one. Three sweeps, all bounded and all idempotent:
 *
 *   1. DELETE `previewed` runs older than 7 days. An abandoned preview has no
 *      value after the snapshot it pinned has been superseded, and it is the
 *      single biggest row shape in the table.
 *   2. TRIM `plan.preview.candidates` out of `executed`/`failed` runs older
 *      than 90 days. The run's summary, its status, its byte count and its
 *      `executedActions` stay — what goes is the list of paths that WOULD have
 *      been deleted, which nobody reads a quarter later.
 *   3. FAIL `kind='files'` runs stuck in `running` for more than 24 h. Execute
 *      claims its row before dispatching (routes/devices/filesystem.ts), so an
 *      API process that dies mid-dispatch leaves a row no code path will ever
 *      finalise. Scoped to file runs on purpose: a W04 system run legitimately
 *      stays `running` for up to its two-hour timeout and owns its own
 *      terminal transition.
 *
 * Each batch runs in its OWN transaction (see retentionBatch.ts's header): a
 * loop wrapped in one outer `withSystemDbAccessContext` would hold every lock
 * until the last batch committed, which is worse than the unbounded statement
 * batching was supposed to replace.
 */

import { Queue, Worker, type Job } from 'bullmq';
import { sql } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { extractRowCount } from '../db/rowCount';
import { captureException } from '../services/sentry';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';
import {
  parsePositiveIntEnv,
  pruneInCtidBatches,
  resolveRetentionDays,
  warnOnRetentionBacklog,
} from './retentionBatch';

const LOG_PREFIX = '[FilesystemCleanupRunRetention]';
const QUEUE_NAME = 'filesystem-cleanup-run-retention';
const TABLE = 'device_filesystem_cleanup_runs';

const MAX_PREVIEW_RETENTION_DAYS = 90;
const MAX_PLAN_RETENTION_DAYS = 365;

const PREVIEW_RETENTION_DAYS = resolveRetentionDays(
  process.env.FILESYSTEM_CLEANUP_PREVIEW_RETENTION_DAYS, 7, MAX_PREVIEW_RETENTION_DAYS, LOG_PREFIX,
);
const PLAN_RETENTION_DAYS = resolveRetentionDays(
  process.env.FILESYSTEM_CLEANUP_PLAN_RETENTION_DAYS, 90, MAX_PLAN_RETENTION_DAYS, LOG_PREFIX,
);
/** How long a claimed-but-unfinalised file run may sit in `running`. */
const STUCK_RUN_HOURS = 24;
const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'FILESYSTEM_CLEANUP_RETENTION_BATCH_SIZE', 5000);
const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'FILESYSTEM_CLEANUP_RETENTION_MAX_BATCHES', 50);

export interface RetentionJobData {
  previewRetentionDays?: number;
  planRetentionDays?: number;
  batchSize?: number;
  maxBatches?: number;
}

let retentionQueue: Queue | null = null;
let retentionWorker: Worker<RetentionJobData> | null = null;

export function getFilesystemCleanupRunRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return retentionQueue;
}

/** One statement, one transaction, one released connection. */
function inFreshSystemContext<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

export async function runFilesystemCleanupRunRetention(
  job: RetentionJobData = {},
): Promise<{
  previewsDeleted: number;
  plansTrimmed: number;
  stuckRunsFailed: number;
  batches: number;
  hasMore: boolean;
  durationMs: number;
}> {
  const startedAt = Date.now();
  const previewDays = resolveRetentionDays(job.previewRetentionDays, PREVIEW_RETENTION_DAYS, MAX_PREVIEW_RETENTION_DAYS);
  const planDays = resolveRetentionDays(job.planRetentionDays, PLAN_RETENTION_DAYS, MAX_PLAN_RETENTION_DAYS);
  const batchSize = Math.max(1, job.batchSize ?? BATCH_SIZE);
  const maxBatches = Math.max(1, job.maxBatches ?? MAX_BATCHES);

  // postgres-js does not coerce a JS Date in a template-literal param.
  const previewCutoff = new Date(Date.now() - previewDays * 86_400_000).toISOString();
  const planCutoff = new Date(Date.now() - planDays * 86_400_000).toISOString();
  const stuckCutoff = new Date(Date.now() - STUCK_RUN_HOURS * 3_600_000).toISOString();

  // ---- 1. abandoned previews -------------------------------------------
  const prune = await pruneInCtidBatches({
    table: TABLE,
    where: sql`status = 'previewed' AND requested_at < ${previewCutoff}`,
    batchSize,
    maxBatches,
    label: 'filesystemCleanupRunRetention.prunePreviews',
  });

  // ---- 2. trim the pinned candidate list off finished runs --------------
  let plansTrimmed = 0;
  let trimBatches = 0;
  let lastTrimmed = 0;
  while (trimBatches < maxBatches) {
    const result = await inFreshSystemContext('filesystemCleanupRunRetention.trimPlans', () => db.execute(sql`
      UPDATE device_filesystem_cleanup_runs
      SET plan = jsonb_set(
            plan #- '{preview,candidates}',
            '{preview,candidatesTrimmedAt}',
            to_jsonb(now()),
            true
          ),
          updated_at = now()
      WHERE ctid IN (
        SELECT ctid
        FROM device_filesystem_cleanup_runs
        WHERE status IN ('executed', 'failed')
          AND requested_at < ${planCutoff}
          AND jsonb_typeof(plan #> '{preview,candidates}') = 'array'
        LIMIT ${batchSize}
      )
    `));
    lastTrimmed = extractRowCount(result);
    plansTrimmed += lastTrimmed;
    trimBatches += 1;
    if (lastTrimmed < batchSize) break;
  }

  // ---- 3. stuck claims --------------------------------------------------
  const stuckResult = await inFreshSystemContext('filesystemCleanupRunRetention.failStuck', () => db.execute(sql`
    UPDATE device_filesystem_cleanup_runs
    SET status = 'failed',
        error = 'interrupted',
        updated_at = now()
    WHERE kind = 'files'
      AND status = 'running'
      AND requested_at < ${stuckCutoff}
  `));
  const stuckRunsFailed = extractRowCount(stuckResult);

  const durationMs = Date.now() - startedAt;
  const trimHasMore = trimBatches >= maxBatches && lastTrimmed >= batchSize;
  const hasMore = prune.hasMore || trimHasMore;

  console.log(
    `${LOG_PREFIX} Deleted ${prune.deleted} abandoned previews (>${previewDays}d), ` +
    `trimmed ${plansTrimmed} plans (>${planDays}d), failed ${stuckRunsFailed} stuck file runs in ${durationMs}ms`,
  );
  warnOnRetentionBacklog(LOG_PREFIX, TABLE, {
    deleted: prune.deleted + plansTrimmed,
    batches: prune.batches + trimBatches,
    hasMore,
  });
  recordRetentionRun('filesystem_cleanup_run_retention', {
    rowsDeleted: prune.deleted,
    incomplete: hasMore,
  });

  return {
    previewsDeleted: prune.deleted,
    plansTrimmed,
    stuckRunsFailed,
    batches: prune.batches + trimBatches,
    hasMore,
    durationMs,
  };
}

export function createFilesystemCleanupRunRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    // No context wrapper here: each sweep opens one per batch so every batch
    // commits and releases its locks (see retentionBatch.ts).
    async (job: Job<RetentionJobData>) => runFilesystemCleanupRunRetention(job.data ?? {}),
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeFilesystemCleanupRunRetention(): Promise<void> {
  try {
    retentionWorker = createFilesystemCleanupRunRetentionWorker();
    attachWorkerObservability(retentionWorker, 'filesystemCleanupRunRetention');

    retentionWorker.on('error', (error) => {
      console.error(`${LOG_PREFIX} Worker error:`, error);
      captureException(error);
    });
    retentionWorker.on('failed', (job, error) => {
      console.error(`${LOG_PREFIX} Job ${job?.id} failed:`, error);
      captureException(error);
    });

    // Job Scheduler API (queue.upsertJobScheduler), not the legacy
    // queue.add(..., { repeat }) + getRepeatableJobs()/removeRepeatableByKey()
    // dance: the scheduler is addressed by a caller-chosen id, so re-running
    // the initializer replaces the registration instead of leaking one.
    await getFilesystemCleanupRunRetentionQueue().upsertJobScheduler(
      QUEUE_NAME,
      // Daily at a registry-allocated slot. NOT `every: 24h` — BullMQ anchors
      // `every` to the Unix epoch, so every 24h job fires at 00:00:00.000 UTC
      // together (see jobs/scheduleRegistry.ts).
      { pattern: jobSchedule('filesystem-cleanup-run-retention') },
      {
        name: 'sweep',
        data: {
          previewRetentionDays: PREVIEW_RETENTION_DAYS,
          planRetentionDays: PLAN_RETENTION_DAYS,
          batchSize: BATCH_SIZE,
          maxBatches: MAX_BATCHES,
        },
        opts: { removeOnComplete: { count: 5 }, removeOnFail: { count: 10 } },
      },
    );

    console.log(`${LOG_PREFIX} Retention worker initialized`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to initialize:`, error);
    throw error;
  }
}

export async function shutdownFilesystemCleanupRunRetention(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
  }
  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
  }
}

export const __testOnly = {
  QUEUE_NAME,
  PREVIEW_RETENTION_DAYS,
  PLAN_RETENTION_DAYS,
  STUCK_RUN_HOURS,
  BATCH_SIZE,
  MAX_BATCHES,
};
```

- [ ] **Step 4: Run it — it still fails, on the two registrations Task 5 adds**

```bash
cd apps/api && npx vitest run src/jobs/filesystemCleanupRunRetention.test.ts
```

Expected failure: a TypeScript/runtime error from `jobSchedule('filesystem-cleanup-run-retention')` returning `undefined` (the slot does not exist yet) — the `upsertJobScheduler` case fails with `expected undefined to equal { pattern: '3 22 * * *' }`. Leave it red and do Task 5 next; do **not** inline the cron pattern to go green.

- [ ] **Step 5: Commit the module (still red on the registry)**

```bash
git add apps/api/src/jobs/filesystemCleanupRunRetention.ts apps/api/src/jobs/filesystemCleanupRunRetention.test.ts
git commit -m "$(cat <<'EOF'
feat(filesystem): daily retention sweep for disk-cleanup runs

Three bounded sweeps over device_filesystem_cleanup_runs: delete abandoned
previews past 7 days, trim plan.preview.candidates out of finished runs past
90 days (summary and executedActions stay), and fail file runs stuck in
`running` past 24 hours because their API process died mid-dispatch. Each
batch opens its own system DB context so it commits and releases its locks
before the next begins.

Registry wiring follows in the next commit; the schedule-slot assertion is
deliberately red until then.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §5.2

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Register the worker in all four registries

A new BullMQ Worker is not done when it runs — it is done when the four contracts that know about workers agree it exists. Each bullet below names the exact file, the exact line, and the exact contract test that enforces it.

**Files:**
- Modify: `apps/api/src/jobs/scheduleRegistry.ts` (daily-tier block, after `'sending-domains-daily': '3 21 * * *',` at `:165`)
- Modify: `apps/api/src/services/retentionMetrics.ts` (`RETENTION_JOB_NAMES`, `:28-52`)
- Modify: `apps/api/src/services/workerRegistry.ts` (a new entry next to `changeLogRetention` at `:442-450`)
- Modify: `apps/api/src/jobs/workerReadinessManifest.ts` (a `consumers(...)` row)
- Modify (Test): `apps/api/src/services/workerRegistry.test.ts` (`EXPECTED_WORKER_NAMES` and the four `142` counts at `:91`, `:133`, `:140`, `:148`)

**Interfaces:**
- Consumes: `initializeFilesystemCleanupRunRetention`, `shutdownFilesystemCleanupRunRetention` from `../jobs/filesystemCleanupRunRetention` (Task 4).
- Produces: `jobSchedule('filesystem-cleanup-run-retention') === '3 22 * * *'`; `RETENTION_JOB_NAMES` contains `'filesystem_cleanup_run_retention'`; `WORKER_REGISTRY` contains a `global`-placement `filesystemCleanupRunRetention` entry; `WORKER_READINESS_MANIFEST` declares the consumer `filesystemCleanupRunRetention`.

- [ ] **Step 1: Write the failing test** — append to `apps/api/src/jobs/filesystemCleanupRunRetention.test.ts` a second, un-mocked file is not needed; instead create a small registration test that imports the real registries. Create `apps/api/src/services/workerRegistry.filesystemCleanupRunRetention.test.ts` (mirrors `workerRegistry.sendingDomainsWorker.test.ts`):

```ts
// apps/api/src/services/workerRegistry.filesystemCleanupRunRetention.test.ts
import { describe, expect, it } from 'vitest';
import { WORKER_REGISTRY } from './workerRegistry';
import { RETENTION_JOB_NAMES } from './retentionMetrics';
import { WORKER_READINESS_MANIFEST } from '../jobs/workerReadinessManifest';
import { JOB_SCHEDULES, jobSchedule } from '../jobs/scheduleRegistry';

describe('filesystemCleanupRunRetention registration (Disk Cleanup v2 W03)', () => {
  it('holds an allocated daily slot, not a bare interval', () => {
    // Minute 3 keeps the daily = 3 (mod 5) lane; hour 22 previously held only
    // user-risk-scan at :57, so nothing else in the registry shares the minute.
    expect(jobSchedule('filesystem-cleanup-run-retention')).toBe('3 22 * * *');
    const patterns = Object.values(JOB_SCHEDULES);
    expect(patterns.filter((p) => p === '3 22 * * *')).toHaveLength(1);
  });

  it('is registered in WORKER_REGISTRY as a global-placement, lazily-loaded entry', async () => {
    const entry = WORKER_REGISTRY.find((e) => e.name === 'filesystemCleanupRunRetention');
    expect(entry).toBeDefined();
    expect(entry?.placement).toBe('global');
    const loaded = await entry!.load();
    expect(typeof loaded.init).toBe('function');
    expect(typeof loaded.shutdown).toBe('function');
  });

  it('declares its consumer so /ready waits for it', () => {
    const entry = WORKER_READINESS_MANIFEST.find(
      (e) => e.kind === 'consumers' && e.initializer === 'filesystemCleanupRunRetention',
    );
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      consumers: ['filesystemCleanupRunRetention'],
      requiredWhen: 'redis',
    });
  });

  it('publishes a bounded retention metric name', () => {
    expect(RETENTION_JOB_NAMES).toContain('filesystem_cleanup_run_retention');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/workerRegistry.filesystemCleanupRunRetention.test.ts
```

Expected failure: `expected undefined to be '3 22 * * *'` on the first case (the slot key does not exist), and `expected undefined not to be undefined` on the registry and manifest cases.

- [ ] **Step 3: Allocate the schedule slot** — in `apps/api/src/jobs/scheduleRegistry.ts`, insert immediately after the `'sending-domains-daily': '3 21 * * *',` line:

```ts
  // Disk Cleanup v2 W03 (spec §5.2) — daily sweep of device_filesystem_cleanup_runs:
  // abandoned previews at 7 days, the pinned candidate blob at 90 days, and
  // file runs stuck in `running` at 24 hours. Hour 22 held only the sub-daily
  // `user-risk-scan` at :57; :03 keeps the daily = 3 (mod 5) lane.
  'filesystem-cleanup-run-retention': '3 22 * * *',
```

- [ ] **Step 4: Add the retention metric name** — in `apps/api/src/services/retentionMetrics.ts`, insert into `RETENTION_JOB_NAMES` in sorted position, between `'event_log_retention',` and `'intent_outbox_retention',`:

```ts
  'filesystem_cleanup_run_retention',
```

(`retentionMetrics.test.ts:220` asserts the array equals its own `.sort()`, so position is not optional.)

- [ ] **Step 5: Register the worker** — in `apps/api/src/services/workerRegistry.ts`, insert immediately after the `changeLogRetention` entry:

```ts
  {
    name: 'filesystemCleanupRunRetention',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/filesystemCleanupRunRetention');
      return {
        init: m.initializeFilesystemCleanupRunRetention,
        shutdown: m.shutdownFilesystemCleanupRunRetention,
      };
    },
  },
```

- [ ] **Step 6: Declare the readiness consumer** — in `apps/api/src/jobs/workerReadinessManifest.ts`, insert immediately after `consumers('changeLogRetention'),`:

```ts
  // Disk Cleanup v2 W03. Plain Redis-required consumer: it constructs and
  // attaches unconditionally wherever it is placed, with no feature flag.
  consumers('filesystemCleanupRunRetention'),
```

- [ ] **Step 7: Update the losslessness test** — in `apps/api/src/services/workerRegistry.test.ts`, add `'filesystemCleanupRunRetention',` to `EXPECTED_WORKER_NAMES` in the same position the registry entry occupies (immediately after `'changeLogRetention'`), with the comment:

```ts
  // Disk Cleanup v2 W03 (#<subissue#>) — daily sweep of the cleanup-run table.
  'filesystemCleanupRunRetention',
```

and change all four count assertions from `142` to `143` (`:91`, `:133`, `:140`, `:148`), appending to the comment block above `:91`:

```ts
    // Disk Cleanup v2 W03 adds jobs/filesystemCleanupRunRetention.ts: 142 → 143.
```

- [ ] **Step 8: Run every contract this touched, and watch them pass**

```bash
cd apps/api && npx vitest run \
  src/services/workerRegistry.filesystemCleanupRunRetention.test.ts \
  src/services/workerRegistry.test.ts \
  src/services/retentionMetrics.test.ts \
  src/jobs/scheduleRegistry.contract.test.ts \
  src/jobs/workerReadinessManifest.test.ts \
  src/jobs/workerReadinessCoverage.test.ts \
  src/jobs/filesystemCleanupRunRetention.test.ts
```

Expected: all seven files PASS. `scheduleRegistry.contract.test.ts` proves no coarse `every:` and no minute collision; `workerReadinessCoverage.test.ts` proves the `new Worker(...)` has exactly one `attachWorkerObservability` and that its name is declared in the manifest exactly once.

- [ ] **Step 9: Typecheck**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/jobs/scheduleRegistry.ts apps/api/src/services/retentionMetrics.ts \
  apps/api/src/services/workerRegistry.ts apps/api/src/jobs/workerReadinessManifest.ts \
  apps/api/src/services/workerRegistry.test.ts \
  apps/api/src/services/workerRegistry.filesystemCleanupRunRetention.test.ts
git commit -m "$(cat <<'EOF'
chore(filesystem): register the cleanup-run retention worker in all four registries

A new BullMQ Worker needs four registrations, and missing any one of them
fails a different contract: the scheduleRegistry slot (no coarse `every:`, no
minute collision), RETENTION_JOB_NAMES (bounded, sorted metric label),
WORKER_REGISTRY (lazily-loaded entry plus its pinned order and count), and
WORKER_READINESS_MANIFEST (every attached name declared exactly once).

Slot '3 22 * * *': hour 22 held only the sub-daily user-risk-scan at :57.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Extract the tab's pure helpers into `filesystemTabUtils.ts`

**Files:**
- Create: `apps/web/src/components/devices/filesystem/filesystemTabUtils.ts`
- Create: `apps/web/src/components/devices/filesystem/filesystemTabUtils.test.ts` (Test)

**Interfaces:**
- Consumes: `formatNumber` from `@/lib/i18n/format`; `formatDateTime as formatUserDateTime` from `@/lib/dateTimeFormat`.
- Produces:
  ```ts
  export type FilesystemSummary = { filesScanned?: number; dirsScanned?: number; bytesScanned?: number; maxDepthReached?: number; permissionDeniedCount?: number };
  export type SizedPath = { path?: string; sizeBytes?: number; modifiedAt?: string; estimated?: boolean };
  export type FilesystemSnapshot = { id: string; capturedAt: string; trigger: 'on_demand' | 'threshold'; partial: boolean; reason?: string | null; path?: string | null; scanPath?: string | null; scanMode?: string | null; summary: FilesystemSummary; cleanupCandidates?: SizedPath[]; topLargestFiles?: SizedPath[]; topLargestDirectories?: SizedPath[]; tempAccumulation?: Array<{ category?: string; bytes?: number }>; oldDownloads?: SizedPath[]; unrotatedLogs?: SizedPath[]; trashUsage?: SizedPath[]; duplicateCandidates?: Array<{ key?: string; sizeBytes?: number; count?: number }>; errors?: Array<{ path?: string; error?: string }> };
  export type CleanupCandidate = { path: string; category: string; sizeBytes: number };
  export type FilesystemCleanupPreview = { cleanupRunId: string | null; snapshotId: string; scanPath: string; estimatedBytes: number; candidateCount: number; categories: Array<{ category: string; count: number; estimatedBytes: number }>; candidates: CleanupCandidate[] };
  export type CleanupActionStatus = 'completed' | 'failed' | 'skipped_locked' | 'rejected' | 'skipped_budget';
  export type CleanupAction = { path: string; category: string; sizeBytes: number; status: CleanupActionStatus; error?: string };
  export type CleanupExecuteResult = { cleanupRunId: string; scanPath?: string | null; status: 'executed' | 'failed'; bytesReclaimed: number; selectedCount: number; failedCount: number; rejectedPaths: string[]; partial: boolean; budgetMs: number; counts?: Record<CleanupActionStatus, number>; actions: CleanupAction[] };
  export type CommandRow = { id: string; type?: string; status?: string; createdAt?: string; payload?: unknown };
  export type ThresholdEvent = { id: string; status: string; createdAt: string; path: string };
  export function formatBytes(value: number | undefined): string;
  export function formatDateTime(value: string | undefined): string;
  export function normalizeHierarchyPath(path: string): string;
  export function isDescendantPath(path: string, ancestor: string): boolean;
  export function collapseAncestorDirectories<T extends SizedPath>(directories: T[], limit: number, descendantRatio?: number): T[];
  export function readThresholdEvents(commands: CommandRow[]): ThresholdEvent[];
  export function summariseActionStatuses(actions: CleanupAction[]): Record<CleanupActionStatus, number>;
  export function selectedBytes(candidates: CleanupCandidate[], selected: ReadonlySet<string>): number;
  ```

- [ ] **Step 1: Write the failing test** — create `apps/web/src/components/devices/filesystem/filesystemTabUtils.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  collapseAncestorDirectories,
  formatBytes,
  isDescendantPath,
  normalizeHierarchyPath,
  readThresholdEvents,
  selectedBytes,
  summariseActionStatuses,
  type CleanupAction,
  type CommandRow,
} from './filesystemTabUtils';

describe('formatBytes', () => {
  it('renders a dash for a missing or non-finite value', () => {
    expect(formatBytes(undefined)).toBe('-');
    expect(formatBytes(Number.NaN)).toBe('-');
  });

  it('renders exact bytes below a kibibyte and scales above it', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
    expect(formatBytes(1024 ** 4)).toBe('1.00 TB');
  });
});

describe('normalizeHierarchyPath', () => {
  it('lower-cases, flips separators and collapses doubles', () => {
    expect(normalizeHierarchyPath('C:\\Users\\\\Admin\\')).toBe('c:/users/admin');
  });

  it('keeps the trailing slash on a Windows drive root and on /', () => {
    expect(normalizeHierarchyPath('C:\\')).toBe('c:/');
    expect(normalizeHierarchyPath('/')).toBe('/');
  });
});

describe('isDescendantPath', () => {
  it('is false for the same path and for an unrelated sibling', () => {
    expect(isDescendantPath('/var/log', '/var/log')).toBe(false);
    expect(isDescendantPath('/var/logging', '/var/log')).toBe(false);
  });

  it('is true under a POSIX ancestor, / and a Windows drive root', () => {
    expect(isDescendantPath('/var/log/syslog', '/var/log')).toBe(true);
    expect(isDescendantPath('/var', '/')).toBe(true);
    expect(isDescendantPath('C:\\Windows\\Temp', 'C:\\')).toBe(true);
  });
});

describe('collapseAncestorDirectories', () => {
  it('drops an ancestor whose size is explained by one child', () => {
    const rows = [
      { path: '/data', sizeBytes: 100 },
      { path: '/data/big', sizeBytes: 95 },
      { path: '/other', sizeBytes: 50 },
    ];
    expect(collapseAncestorDirectories(rows, 5).map((r) => r.path)).toEqual(['/data/big', '/other']);
  });

  it('keeps an ancestor whose children are all small', () => {
    const rows = [
      { path: '/data', sizeBytes: 100 },
      { path: '/data/small', sizeBytes: 10 },
    ];
    expect(collapseAncestorDirectories(rows, 5).map((r) => r.path)).toEqual(['/data', '/data/small']);
  });

  it('is stricter when the ancestor is an estimate and the child is measured', () => {
    // An estimated ancestor at 100 with a MEASURED child at 50 is explained by
    // that child (ratio drops to 0.45); the same pair both-measured is not.
    const estimated = [
      { path: '/data', sizeBytes: 100, estimated: true },
      { path: '/data/child', sizeBytes: 50 },
    ];
    expect(collapseAncestorDirectories(estimated, 5).map((r) => r.path)).toEqual(['/data/child']);

    const measured = [
      { path: '/data', sizeBytes: 100 },
      { path: '/data/child', sizeBytes: 50 },
    ];
    expect(collapseAncestorDirectories(measured, 5).map((r) => r.path)).toEqual(['/data', '/data/child']);
  });

  it('returns nothing for a non-positive limit and tolerates missing paths', () => {
    expect(collapseAncestorDirectories([{ path: '/a', sizeBytes: 1 }], 0)).toEqual([]);
    expect(collapseAncestorDirectories([{ sizeBytes: 1 }, { path: '/a', sizeBytes: 2 }], 5))
      .toEqual([{ path: '/a', sizeBytes: 2 }]);
  });
});

describe('readThresholdEvents', () => {
  const cmd = (over: Partial<CommandRow> & { payload?: unknown }): CommandRow => ({
    id: 'c1', type: 'filesystem_analysis', status: 'completed', createdAt: '2026-09-19T10:00:00Z', ...over,
  });

  it('keeps only threshold-triggered filesystem_analysis commands, newest first', () => {
    const events = readThresholdEvents([
      cmd({ id: 'a', createdAt: '2026-09-19T09:00:00Z', payload: { trigger: 'threshold', path: 'C:\\' } }),
      cmd({ id: 'b', createdAt: '2026-09-19T11:00:00Z', payload: { trigger: 'threshold', path: 'D:\\' } }),
      cmd({ id: 'c', payload: { trigger: 'on_demand', path: 'C:\\' } }),
      cmd({ id: 'd', type: 'script_execute', payload: { trigger: 'threshold' } }),
    ]);
    expect(events.map((e) => e.id)).toEqual(['b', 'a']);
    expect(events[0].path).toBe('D:\\');
  });

  it('caps the list at 8 and falls back to a dash for a missing path', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      cmd({ id: `c${i}`, createdAt: `2026-09-${10 + i}T10:00:00Z`, payload: { trigger: 'threshold' } }));
    const events = readThresholdEvents(many);
    expect(events).toHaveLength(8);
    expect(events[0].path).toBe('-');
  });
});

describe('summariseActionStatuses', () => {
  it('counts every outcome bucket, including the ones with no rows', () => {
    const actions: CleanupAction[] = [
      { path: '/a', category: 'temp_files', sizeBytes: 1, status: 'completed' },
      { path: '/b', category: 'temp_files', sizeBytes: 1, status: 'completed' },
      { path: '/c', category: 'trash', sizeBytes: 1, status: 'skipped_locked' },
      { path: '/d', category: 'trash', sizeBytes: 1, status: 'failed', error: 'boom' },
    ];
    expect(summariseActionStatuses(actions)).toEqual({
      completed: 2, failed: 1, skipped_locked: 1, rejected: 0, skipped_budget: 0,
    });
  });
});

describe('selectedBytes', () => {
  it('sums only the checked candidates', () => {
    const candidates = [
      { path: '/a', category: 'temp_files', sizeBytes: 100 },
      { path: '/b', category: 'temp_files', sizeBytes: 200 },
    ];
    expect(selectedBytes(candidates, new Set(['/b']))).toBe(200);
    expect(selectedBytes(candidates, new Set())).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/filesystem/filesystemTabUtils.test.ts
```

Expected failure: `Failed to load .../filesystemTabUtils.test.ts` … `Cannot find module './filesystemTabUtils'`.

- [ ] **Step 3: Implement** — create `apps/web/src/components/devices/filesystem/filesystemTabUtils.ts`. The four path/size helpers are moved verbatim from `DeviceFilesystemTab.tsx:118-263` (only the `export` keyword and the type parameter's bound change), so this is an extraction, not a rewrite:

```ts
/**
 * Pure helpers and wire types for the Disk Cleanup tab (spec §8).
 *
 * Extracted verbatim from the 958-line DeviceFilesystemTab.tsx so they can be
 * unit-tested without jsdom and shared by the panels the tab now composes.
 * Nothing here touches the network, i18next or React — a change that needs any
 * of those belongs in a hook or a component, not in this file.
 */

import { formatDateTime as formatUserDateTime } from '@/lib/dateTimeFormat';
import { formatNumber } from '@/lib/i18n/format';

export type FilesystemSummary = {
  filesScanned?: number;
  dirsScanned?: number;
  bytesScanned?: number;
  maxDepthReached?: number;
  permissionDeniedCount?: number;
};

export type SizedPath = {
  path?: string;
  sizeBytes?: number;
  modifiedAt?: string;
  estimated?: boolean;
};

export type FilesystemSnapshot = {
  id: string;
  capturedAt: string;
  trigger: 'on_demand' | 'threshold';
  partial: boolean;
  reason?: string | null;
  /** Legacy field read off `rawPayload`; W02 adds the first-class `scanPath`. */
  path?: string | null;
  scanPath?: string | null;
  scanMode?: string | null;
  summary: FilesystemSummary;
  cleanupCandidates?: SizedPath[];
  topLargestFiles?: SizedPath[];
  topLargestDirectories?: SizedPath[];
  tempAccumulation?: Array<{ category?: string; bytes?: number }>;
  oldDownloads?: SizedPath[];
  unrotatedLogs?: SizedPath[];
  trashUsage?: SizedPath[];
  duplicateCandidates?: Array<{ key?: string; sizeBytes?: number; count?: number }>;
  errors?: Array<{ path?: string; error?: string }>;
};

export type CleanupCandidate = { path: string; category: string; sizeBytes: number };

export type FilesystemCleanupPreview = {
  cleanupRunId: string | null;
  snapshotId: string;
  scanPath: string;
  estimatedBytes: number;
  candidateCount: number;
  categories: Array<{ category: string; count: number; estimatedBytes: number }>;
  candidates: CleanupCandidate[];
};

/** Per-path outcomes the execute route reports (spec §5.2). */
export type CleanupActionStatus =
  | 'completed'
  | 'failed'
  | 'skipped_locked'
  | 'rejected'
  | 'skipped_budget';

export type CleanupAction = {
  path: string;
  category: string;
  sizeBytes: number;
  status: CleanupActionStatus;
  error?: string;
};

export type CleanupExecuteResult = {
  cleanupRunId: string;
  /** The volume this run acted on (W02 Task 10). */
  scanPath?: string | null;
  status: 'executed' | 'failed';
  bytesReclaimed: number;
  selectedCount: number;
  failedCount: number;
  rejectedPaths: string[];
  /** W01's wall-clock budget stopped the run part-way (W01 Task 9/10). */
  partial: boolean;
  budgetMs: number;
  /** W01 already sends per-status totals; `summariseActionStatuses` stays the
   *  renderer's source so a truncated `actions[]` can never disagree with it. */
  counts?: Record<CleanupActionStatus, number>;
  actions: CleanupAction[];
};

export type CommandRow = {
  id: string;
  type?: string;
  status?: string;
  createdAt?: string;
  payload?: unknown;
};

export type ThresholdEvent = { id: string; status: string; createdAt: string; path: string };

export const CLEANUP_ACTION_STATUSES: readonly CleanupActionStatus[] = [
  'completed',
  'failed',
  'skipped_locked',
  'rejected',
  'skipped_budget',
];

export function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '-';
  if (value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) {
    return `${formatNumber(value / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${formatNumber(value / (1024 * 1024), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
  }
  if (value < 1024 * 1024 * 1024 * 1024) {
    return `${formatNumber(value / (1024 * 1024 * 1024), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GB`;
  }
  return `${formatNumber(value / (1024 * 1024 * 1024 * 1024), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TB`;
}

export function formatDateTime(value: string | undefined): string {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return formatUserDateTime(parsed, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function normalizeHierarchyPath(path: string): string {
  let normalized = path.trim().replace(/\\/g, '/');
  while (normalized.includes('//')) normalized = normalized.replaceAll('//', '/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    const isWindowsDriveRoot =
      normalized.length === 3 && normalized[1] === ':' && normalized[2] === '/';
    if (!isWindowsDriveRoot) {
      normalized = normalized.slice(0, -1);
    }
  }
  return normalized.toLowerCase();
}

export function isDescendantPath(path: string, ancestor: string): boolean {
  const normalizedPath = normalizeHierarchyPath(path);
  const normalizedAncestor = normalizeHierarchyPath(ancestor);
  if (!normalizedPath || !normalizedAncestor || normalizedPath === normalizedAncestor) return false;
  if (normalizedAncestor === '/') return normalizedPath.startsWith('/') && normalizedPath !== '/';
  if (
    normalizedAncestor.length === 3 &&
    normalizedAncestor[1] === ':' &&
    normalizedAncestor[2] === '/'
  ) {
    return normalizedPath.startsWith(normalizedAncestor) && normalizedPath !== normalizedAncestor;
  }
  return normalizedPath.startsWith(`${normalizedAncestor}/`);
}

/**
 * Drop a directory whose reported size is essentially one child's size, so the
 * "largest directories" list shows distinct wins rather than one chain. The
 * ratio tightens when the ancestor is an estimate and the child is measured
 * (a measured child can only be a LOWER bound on an estimated parent) and
 * loosens the other way round.
 */
export function collapseAncestorDirectories<T extends SizedPath>(
  directories: T[],
  limit: number,
  descendantRatio = 0.7,
): T[] {
  if (limit <= 0 || directories.length === 0) return [];
  const items = directories
    .filter((item) => typeof item.path === 'string' && item.path.length > 0)
    .slice()
    .sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));

  const pruned = new Set<number>();
  for (let i = 0; i < items.length; i += 1) {
    if (pruned.has(i)) continue;
    const ancestorPath = items[i].path ?? '';
    const ancestorBytes = items[i].sizeBytes ?? 0;
    if (!ancestorPath || ancestorBytes <= 0) continue;

    for (let j = 0; j < items.length; j += 1) {
      if (i === j || pruned.has(j)) continue;
      const childPath = items[j].path ?? '';
      const childBytes = items[j].sizeBytes ?? 0;
      if (!childPath || childBytes <= 0) continue;
      if (!isDescendantPath(childPath, ancestorPath)) continue;
      const ancestorEstimated = Boolean(items[i].estimated);
      const childEstimated = Boolean(items[j].estimated);
      let effectiveRatio = descendantRatio;
      if (ancestorEstimated && !childEstimated) {
        effectiveRatio = Math.min(effectiveRatio, 0.45);
      } else if (ancestorEstimated && childEstimated) {
        effectiveRatio = Math.min(effectiveRatio, 0.6);
      } else if (!ancestorEstimated && childEstimated) {
        effectiveRatio = Math.max(effectiveRatio, 0.85);
      }
      if (childBytes >= ancestorBytes * effectiveRatio) {
        pruned.add(i);
        break;
      }
    }
  }

  return items.filter((_, index) => !pruned.has(index)).slice(0, limit);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function readThresholdEvents(commands: CommandRow[]): ThresholdEvent[] {
  return commands
    .filter((command) => command.type === 'filesystem_analysis')
    .map((command) => {
      const payload = asRecord(command.payload);
      const trigger = typeof payload?.trigger === 'string' ? payload.trigger : '';
      if (trigger !== 'threshold') return null;
      const path = typeof payload?.path === 'string' ? payload.path : '-';
      return {
        id: command.id,
        status: command.status ?? 'pending',
        createdAt: command.createdAt ?? '',
        path,
      };
    })
    .filter((event): event is ThresholdEvent => event !== null)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 8);
}

/**
 * Every bucket is present even at zero. A result panel that only renders the
 * non-zero counts silently hides "3 rejected" behind an absent row, which is
 * exactly the opaque partial execution defect 10 describes.
 */
export function summariseActionStatuses(
  actions: CleanupAction[],
): Record<CleanupActionStatus, number> {
  const counts = {
    completed: 0,
    failed: 0,
    skipped_locked: 0,
    rejected: 0,
    skipped_budget: 0,
  } as Record<CleanupActionStatus, number>;
  for (const action of actions) {
    if (action.status in counts) counts[action.status] += 1;
  }
  return counts;
}

export function selectedBytes(
  candidates: CleanupCandidate[],
  selected: ReadonlySet<string>,
): number {
  return candidates.reduce(
    (sum, candidate) => (selected.has(candidate.path) ? sum + candidate.sizeBytes : sum),
    0,
  );
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/web && npx vitest run src/components/devices/filesystem/filesystemTabUtils.test.ts
```

Expected: 14 tests PASS.

- [ ] **Step 5: Typecheck**

```bash
cd apps/web && pnpm exec astro check
```

Expected: no errors (the file has no consumers yet, so this only proves it compiles).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/devices/filesystem/filesystemTabUtils.ts \
  apps/web/src/components/devices/filesystem/filesystemTabUtils.test.ts
git commit -m "$(cat <<'EOF'
refactor(devices): extract the Disk Cleanup tab's pure helpers, with tests

formatBytes, the path-hierarchy helpers, collapseAncestorDirectories and
readThresholdEvents move out of the 958-line tab verbatim and gain the unit
tests they never had (spec §2 defect 9: "no tests"). Two new helpers land
alongside them: summariseActionStatuses, which always reports all five
outcome buckets so a zero cannot hide a rejection, and selectedBytes.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §8

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Add every new locale key, in all 8 catalogs

Purely additive: no existing key changes value and none is removed, so nothing goes red between this task and the components that consume the keys. The two deletions and the `scanRunning` re-value happen in Task 13, together with their call sites (`localeParity.test.ts` pins key-set equality and `extractionQuality.test.ts:186-205` fails a bare `t()` on a value carrying an unfilled `{{token}}` — so those three cannot move early).

**Files:**
- Modify: `apps/web/src/locales/en/devices.json`, and the same file under `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR` (8 files; `grep -rl deviceFilesystemTab apps/web/src/locales/` returns exactly these)

**Interfaces:**
- Consumes: nothing.
- Produces: 40 new leaves under `deviceFilesystemTab` in every catalog — 36 scalars plus the nested `categories` (4) and `status` (4) objects, counted as leaves.

- [ ] **Step 1: Write the failing test** — no new test file. The guards already exist and are the contract: `localeParity.test.ts` (identical key sets), `translationCoverage.test.ts` (no exact-English copies past baseline), `keyUsage.test.ts` (every literal `t()` key resolves in `en`). Run them now to establish the green baseline you must preserve:

```bash
cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts
```

Expected: PASS. (If either is already red on your base, stop and rebase — you cannot tell your own regression apart from an inherited one.)

- [ ] **Step 2: Add the English keys** — merge into the existing `deviceFilesystemTab` object in `apps/web/src/locales/en/devices.json`, keeping every key already there:

```json
    "title": "Disk Cleanup",
    "cleanupTitle": "Select what to clean",
    "cleanupPreviewRequired": "Run Cleanup Preview to choose what to delete.",
    "categories": {
      "temp_files": "Temp files",
      "browser_cache": "Browser cache",
      "package_cache": "Package cache",
      "trash": "Trash"
    },
    "selectAllInCategory": "Select all",
    "clearCategory": "Clear",
    "columnPath": "Path",
    "columnSize": "Size",
    "selectionSummary": "{{count}} selected · {{size}}",
    "executeSelected": "Delete selected ({{count}})",
    "confirmTitle": "Permanently delete cleanup targets",
    "confirmMessage": "Delete {{count}} item(s) totalling {{size}} from {{volume}}? This bypasses the recycle bin and cannot be undone.",
    "confirmPathsHeading": "First {{shown}} of {{total}} paths",
    "confirmLabel": "Delete permanently",
    "cleanupFailed": "Cleanup failed",
    "cleanupFinished": "Cleanup finished — {{size}} reclaimed",
    "resultTitle": "Cleanup result",
    "resultReclaimed": "Reclaimed",
    "resultCompleted": "Deleted",
    "resultSkippedLocked": "Locked (skipped)",
    "resultRejected": "Rejected",
    "resultSkippedBudget": "Not reached (time limit)",
    "resultFailures": "Failures",
    "tempAccumulation": "Temp Accumulation",
    "noTempAccumulationData": "No temp accumulation data.",
    "historyTitle": "Cleanup history",
    "historyEmpty": "No cleanup runs recorded yet.",
    "historyLoadMore": "Load more",
    "historyFailed": "Failed to load cleanup history",
    "historyKindFiles": "File cleanup",
    "historyKindSystem": "System cleanup",
    "historyReclaimed": "{{size}} reclaimed",
    "historyCandidates": "{{count}} candidates",
    "status": {
      "previewed": "Previewed",
      "running": "Running",
      "executed": "Executed",
      "failed": "Failed"
    }
```

- [ ] **Step 3: Add the German keys** — merge into `deviceFilesystemTab` in `apps/web/src/locales/de-DE/devices.json`:

```json
    "title": "Datenträgerbereinigung",
    "cleanupTitle": "Auswählen, was bereinigt wird",
    "cleanupPreviewRequired": "Führen Sie zuerst die Bereinigungsvorschau aus, um auszuwählen, was gelöscht wird.",
    "categories": {
      "temp_files": "Temporäre Dateien",
      "browser_cache": "Browser-Cache",
      "package_cache": "Paket-Cache",
      "trash": "Papierkorb"
    },
    "selectAllInCategory": "Alle auswählen",
    "clearCategory": "Auswahl aufheben",
    "columnPath": "Pfad",
    "columnSize": "Größe",
    "selectionSummary": "{{count}} ausgewählt · {{size}}",
    "executeSelected": "Auswahl löschen ({{count}})",
    "confirmTitle": "Bereinigungsziele endgültig löschen",
    "confirmMessage": "{{count}} Element(e) mit insgesamt {{size}} aus {{volume}} löschen? Dies umgeht den Papierkorb und kann nicht rückgängig gemacht werden.",
    "confirmPathsHeading": "Erste {{shown}} von {{total}} Pfaden",
    "confirmLabel": "Endgültig löschen",
    "cleanupFailed": "Bereinigung fehlgeschlagen",
    "cleanupFinished": "Bereinigung abgeschlossen – {{size}} freigegeben",
    "resultTitle": "Bereinigungsergebnis",
    "resultReclaimed": "Freigegeben",
    "resultCompleted": "Gelöscht",
    "resultSkippedLocked": "Gesperrt (übersprungen)",
    "resultRejected": "Abgelehnt",
    "resultSkippedBudget": "Nicht erreicht (Zeitlimit)",
    "resultFailures": "Fehler",
    "tempAccumulation": "Temporäre Ansammlung",
    "noTempAccumulationData": "Keine Daten zu temporären Ansammlungen.",
    "historyTitle": "Bereinigungsverlauf",
    "historyEmpty": "Noch keine Bereinigungsläufe erfasst.",
    "historyLoadMore": "Mehr laden",
    "historyFailed": "Bereinigungsverlauf konnte nicht geladen werden",
    "historyKindFiles": "Dateibereinigung",
    "historyKindSystem": "Systembereinigung",
    "historyReclaimed": "{{size}} freigegeben",
    "historyCandidates": "{{count}} Kandidaten",
    "status": {
      "previewed": "Vorschau",
      "running": "Läuft",
      "executed": "Ausgeführt",
      "failed": "Fehlgeschlagen"
    }
```

- [ ] **Step 4: Add the Latin-American Spanish keys** — merge into `apps/web/src/locales/es-419/devices.json`:

```json
    "title": "Limpieza de disco",
    "cleanupTitle": "Seleccionar qué limpiar",
    "cleanupPreviewRequired": "Ejecute la vista previa de limpieza para elegir qué eliminar.",
    "categories": {
      "temp_files": "Archivos temporales",
      "browser_cache": "Caché del navegador",
      "package_cache": "Caché de paquetes",
      "trash": "Papelera"
    },
    "selectAllInCategory": "Seleccionar todo",
    "clearCategory": "Quitar selección",
    "columnPath": "Ruta",
    "columnSize": "Tamaño",
    "selectionSummary": "{{count}} seleccionados · {{size}}",
    "executeSelected": "Eliminar seleccionados ({{count}})",
    "confirmTitle": "Eliminar permanentemente los objetivos de limpieza",
    "confirmMessage": "¿Eliminar {{count}} elemento(s) que suman {{size}} de {{volume}}? Esto omite la papelera y no se puede deshacer.",
    "confirmPathsHeading": "Primeras {{shown}} rutas de {{total}}",
    "confirmLabel": "Eliminar permanentemente",
    "cleanupFailed": "La limpieza falló",
    "cleanupFinished": "Limpieza finalizada: {{size}} recuperados",
    "resultTitle": "Resultado de la limpieza",
    "resultReclaimed": "Recuperado",
    "resultCompleted": "Eliminado",
    "resultSkippedLocked": "Bloqueado (omitido)",
    "resultRejected": "Rechazado",
    "resultSkippedBudget": "No alcanzado (límite de tiempo)",
    "resultFailures": "Fallos",
    "tempAccumulation": "Acumulación temporal",
    "noTempAccumulationData": "No hay datos de acumulación temporal.",
    "historyTitle": "Historial de limpiezas",
    "historyEmpty": "Aún no se registraron limpiezas.",
    "historyLoadMore": "Cargar más",
    "historyFailed": "No se pudo cargar el historial de limpiezas",
    "historyKindFiles": "Limpieza de archivos",
    "historyKindSystem": "Limpieza del sistema",
    "historyReclaimed": "{{size}} recuperados",
    "historyCandidates": "{{count}} candidatos",
    "status": {
      "previewed": "Vista previa",
      "running": "En ejecución",
      "executed": "Ejecutado",
      "failed": "Fallido"
    }
```

- [ ] **Step 5: Add the French keys** — merge the SAME block into both `apps/web/src/locales/fr-FR/devices.json` and `apps/web/src/locales/fr-CA/devices.json`. (The two catalogs are already byte-identical across every `deviceFilesystemTab` key; the duplicate guard compares each locale against ENGLISH, never against its sibling, so sharing the wording is correct rather than lazy.)

```json
    "title": "Nettoyage du disque",
    "cleanupTitle": "Sélectionner ce qui doit être nettoyé",
    "cleanupPreviewRequired": "Lancez l’aperçu du nettoyage pour choisir ce qui sera supprimé.",
    "categories": {
      "temp_files": "Fichiers temporaires",
      "browser_cache": "Cache du navigateur",
      "package_cache": "Cache de paquets",
      "trash": "Corbeille"
    },
    "selectAllInCategory": "Tout sélectionner",
    "clearCategory": "Effacer la sélection",
    "columnPath": "Chemin",
    "columnSize": "Taille",
    "selectionSummary": "{{count}} sélectionné(s) · {{size}}",
    "executeSelected": "Supprimer la sélection ({{count}})",
    "confirmTitle": "Supprimer définitivement les cibles de nettoyage",
    "confirmMessage": "Supprimer {{count}} élément(s) totalisant {{size}} depuis {{volume}} ? Cette action contourne la corbeille et est irréversible.",
    "confirmPathsHeading": "{{shown}} premiers chemins sur {{total}}",
    "confirmLabel": "Supprimer définitivement",
    "cleanupFailed": "Échec du nettoyage",
    "cleanupFinished": "Nettoyage terminé — {{size}} récupérés",
    "resultTitle": "Résultat du nettoyage",
    "resultReclaimed": "Récupéré",
    "resultCompleted": "Supprimé",
    "resultSkippedLocked": "Verrouillé (ignoré)",
    "resultRejected": "Rejeté",
    "resultSkippedBudget": "Non atteint (limite de temps)",
    "resultFailures": "Échecs",
    "tempAccumulation": "Accumulation temporaire",
    "noTempAccumulationData": "Aucune donnée d’accumulation temporaire.",
    "historyTitle": "Historique des nettoyages",
    "historyEmpty": "Aucun nettoyage enregistré pour l’instant.",
    "historyLoadMore": "Charger plus",
    "historyFailed": "Impossible de charger l’historique des nettoyages",
    "historyKindFiles": "Nettoyage de fichiers",
    "historyKindSystem": "Nettoyage système",
    "historyReclaimed": "{{size}} récupérés",
    "historyCandidates": "{{count}} candidats",
    "status": {
      "previewed": "Aperçu",
      "running": "En cours",
      "executed": "Exécuté",
      "failed": "Échec"
    }
```

- [ ] **Step 6: Add the Italian keys** — merge into `apps/web/src/locales/it-IT/devices.json`:

```json
    "title": "Pulizia disco",
    "cleanupTitle": "Seleziona cosa pulire",
    "cleanupPreviewRequired": "Esegui l'anteprima pulizia per scegliere cosa eliminare.",
    "categories": {
      "temp_files": "File temporanei",
      "browser_cache": "Cache del browser",
      "package_cache": "Cache dei pacchetti",
      "trash": "Cestino"
    },
    "selectAllInCategory": "Seleziona tutto",
    "clearCategory": "Azzera selezione",
    "columnPath": "Percorso",
    "columnSize": "Dimensione",
    "selectionSummary": "{{count}} selezionati · {{size}}",
    "executeSelected": "Elimina selezionati ({{count}})",
    "confirmTitle": "Elimina definitivamente gli elementi di pulizia",
    "confirmMessage": "Eliminare {{count}} elemento/i per un totale di {{size}} da {{volume}}? L'operazione ignora il cestino ed è irreversibile.",
    "confirmPathsHeading": "Primi {{shown}} percorsi su {{total}}",
    "confirmLabel": "Elimina definitivamente",
    "cleanupFailed": "Pulizia non riuscita",
    "cleanupFinished": "Pulizia completata — {{size}} recuperati",
    "resultTitle": "Esito della pulizia",
    "resultReclaimed": "Recuperato",
    "resultCompleted": "Eliminato",
    "resultSkippedLocked": "Bloccato (saltato)",
    "resultRejected": "Rifiutato",
    "resultSkippedBudget": "Non raggiunto (limite di tempo)",
    "resultFailures": "Errori",
    "tempAccumulation": "Accumulo temporaneo",
    "noTempAccumulationData": "Nessun dato di accumulo temporaneo.",
    "historyTitle": "Cronologia pulizie",
    "historyEmpty": "Nessuna pulizia registrata finora.",
    "historyLoadMore": "Carica altro",
    "historyFailed": "Impossibile caricare la cronologia delle pulizie",
    "historyKindFiles": "Pulizia file",
    "historyKindSystem": "Pulizia di sistema",
    "historyReclaimed": "{{size}} recuperati",
    "historyCandidates": "{{count}} candidati",
    "status": {
      "previewed": "Anteprima",
      "running": "In corso",
      "executed": "Eseguita",
      "failed": "Non riuscita"
    }
```

- [ ] **Step 7: Add the Brazilian Portuguese keys** — merge into `apps/web/src/locales/pt-BR/devices.json`:

```json
    "title": "Limpeza de disco",
    "cleanupTitle": "Selecione o que limpar",
    "cleanupPreviewRequired": "Execute a prévia de limpeza para escolher o que excluir.",
    "categories": {
      "temp_files": "Arquivos temporários",
      "browser_cache": "Cache do navegador",
      "package_cache": "Cache de pacotes",
      "trash": "Lixeira"
    },
    "selectAllInCategory": "Selecionar tudo",
    "clearCategory": "Limpar seleção",
    "columnPath": "Caminho",
    "columnSize": "Tamanho",
    "selectionSummary": "{{count}} selecionados · {{size}}",
    "executeSelected": "Excluir selecionados ({{count}})",
    "confirmTitle": "Excluir permanentemente os alvos de limpeza",
    "confirmMessage": "Excluir {{count}} item(ns) somando {{size}} de {{volume}}? Isso ignora a lixeira e não pode ser desfeito.",
    "confirmPathsHeading": "Primeiros {{shown}} de {{total}} caminhos",
    "confirmLabel": "Excluir permanentemente",
    "cleanupFailed": "Falha na limpeza",
    "cleanupFinished": "Limpeza concluída — {{size}} recuperados",
    "resultTitle": "Resultado da limpeza",
    "resultReclaimed": "Recuperado",
    "resultCompleted": "Excluído",
    "resultSkippedLocked": "Bloqueado (ignorado)",
    "resultRejected": "Rejeitado",
    "resultSkippedBudget": "Não alcançado (limite de tempo)",
    "resultFailures": "Falhas",
    "tempAccumulation": "Acúmulo temporário",
    "noTempAccumulationData": "Sem dados de acúmulo temporário.",
    "historyTitle": "Histórico de limpezas",
    "historyEmpty": "Nenhuma limpeza registrada ainda.",
    "historyLoadMore": "Carregar mais",
    "historyFailed": "Não foi possível carregar o histórico de limpezas",
    "historyKindFiles": "Limpeza de arquivos",
    "historyKindSystem": "Limpeza do sistema",
    "historyReclaimed": "{{size}} recuperados",
    "historyCandidates": "{{count}} candidatos",
    "status": {
      "previewed": "Prévia",
      "running": "Em execução",
      "executed": "Executada",
      "failed": "Falhou"
    }
```

- [ ] **Step 8: Add the Turkish keys** — merge into `apps/web/src/locales/tr-TR/devices.json`:

```json
    "title": "Disk Temizleme",
    "cleanupTitle": "Nelerin temizleneceğini seçin",
    "cleanupPreviewRequired": "Neyin silineceğini seçmek için Temizleme Önizlemesi'ni çalıştırın.",
    "categories": {
      "temp_files": "Geçici dosyalar",
      "browser_cache": "Tarayıcı önbelleği",
      "package_cache": "Paket önbelleği",
      "trash": "Çöp kutusu"
    },
    "selectAllInCategory": "Tümünü seç",
    "clearCategory": "Seçimi temizle",
    "columnPath": "Yol",
    "columnSize": "Boyut",
    "selectionSummary": "{{count}} seçildi · {{size}}",
    "executeSelected": "Seçilenleri sil ({{count}})",
    "confirmTitle": "Temizleme hedeflerini kalıcı olarak sil",
    "confirmMessage": "{{volume}} biriminden toplam {{size}} boyutundaki {{count}} öğe silinsin mi? Bu işlem çöp kutusunu atlar ve geri alınamaz.",
    "confirmPathsHeading": "{{total}} yoldan ilk {{shown}} tanesi",
    "confirmLabel": "Kalıcı olarak sil",
    "cleanupFailed": "Temizleme başarısız oldu",
    "cleanupFinished": "Temizleme tamamlandı — {{size}} geri kazanıldı",
    "resultTitle": "Temizleme sonucu",
    "resultReclaimed": "Geri kazanılan",
    "resultCompleted": "Silindi",
    "resultSkippedLocked": "Kilitli (atlandı)",
    "resultRejected": "Reddedildi",
    "resultSkippedBudget": "Ulaşılamadı (süre sınırı)",
    "resultFailures": "Hatalar",
    "tempAccumulation": "Geçici Birikim",
    "noTempAccumulationData": "Geçici birikim verisi yok.",
    "historyTitle": "Temizleme geçmişi",
    "historyEmpty": "Henüz kayıtlı temizleme çalıştırması yok.",
    "historyLoadMore": "Daha fazla yükle",
    "historyFailed": "Temizleme geçmişi yüklenemedi",
    "historyKindFiles": "Dosya temizliği",
    "historyKindSystem": "Sistem temizliği",
    "historyReclaimed": "{{size}} geri kazanıldı",
    "historyCandidates": "{{count}} aday",
    "status": {
      "previewed": "Önizlendi",
      "running": "Çalışıyor",
      "executed": "Yürütüldü",
      "failed": "Başarısız"
    }
```

- [ ] **Step 9: Run the i18n guards and watch them stay green**

```bash
cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts src/lib/i18n/extractionQuality.test.ts src/lib/i18n/terminologyQuality.test.ts
```

Expected: all five PASS. A `devices.json: N exact-English duplicates exceeds baseline` failure means one of the translations above was left in English — fix the translation, never the baseline.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/locales/en/devices.json apps/web/src/locales/de-DE/devices.json \
  apps/web/src/locales/es-419/devices.json apps/web/src/locales/fr-CA/devices.json \
  apps/web/src/locales/fr-FR/devices.json apps/web/src/locales/it-IT/devices.json \
  apps/web/src/locales/pt-BR/devices.json apps/web/src/locales/tr-TR/devices.json
git commit -m "$(cat <<'EOF'
i18n(devices): strings for the finished Disk Cleanup tab, in all 8 locales

40 additive leaves under deviceFilesystemTab covering the cleanup selection
table, the destructive confirm, the five-bucket result panel and the run
history. Purely additive: nothing is re-valued or removed here, so no call
site goes stale between this commit and the components that render them.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `useFilesystemSnapshot` — path-scoped reads that abort on unmount

**Files:**
- Create: `apps/web/src/components/devices/filesystem/useFilesystemSnapshot.ts`
- Create: `apps/web/src/components/devices/filesystem/useFilesystemSnapshot.test.ts` (Test)

**Interfaces:**
- Consumes: `fetchWithAuth` from `@/stores/auth`; `readThresholdEvents`, `FilesystemSnapshot`, `CommandRow`, `ThresholdEvent` from `./filesystemTabUtils`; `useTranslation` from `react-i18next`.
- Consumes (from W02, assumed merged): `GET /devices/:id/filesystem?path=<scanPath>` answers the latest snapshot **for that scan path** (404 when the path has never been scanned), and its `data` carries `scanPath`.
- Produces:
  ```ts
  export function useFilesystemSnapshot(deviceId: string, scanPath: string | null): {
    snapshot: FilesystemSnapshot | null;
    thresholdEvents: ThresholdEvent[];
    loading: boolean;
    error: string | null;
    reload: (options?: { silent?: boolean }) => Promise<void>;
  };
  ```

- [ ] **Step 1: Write the failing test** — create `apps/web/src/components/devices/filesystem/useFilesystemSnapshot.test.ts`:

```ts
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from '@/stores/auth';
import { useFilesystemSnapshot } from './useFilesystemSnapshot';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const snapshot = (over: Record<string, unknown> = {}) => ({
  id: 'snap-1',
  capturedAt: '2026-09-19T10:00:00.000Z',
  trigger: 'on_demand',
  partial: false,
  scanPath: 'C:\\',
  summary: { filesScanned: 10 },
  ...over,
});

function routeByUrl(map: Record<string, Response>): void {
  fetchMock.mockImplementation((url: string) => {
    const key = Object.keys(map).find((k) => url.includes(k));
    return Promise.resolve(key ? map[key] : json({}, 500));
  });
}

describe('useFilesystemSnapshot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requests the snapshot for the selected scan path and returns it', async () => {
    routeByUrl({
      '/filesystem?path=': json({ data: snapshot() }),
      '/commands?limit=': json({ data: [] }),
    });

    const { result } = renderHook(() => useFilesystemSnapshot('dev-1', 'C:\\'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.snapshot?.id).toBe('snap-1');
    const snapshotUrl = fetchMock.mock.calls.map(([u]) => String(u)).find((u) => u.includes('/filesystem?path='));
    // The path must be encoded — a raw `C:\` in a query string is not a URL.
    expect(snapshotUrl).toBe('/devices/dev-1/filesystem?path=C%3A%5C');
  });

  it('treats a 404 as "no snapshot for this path", not as an error', async () => {
    routeByUrl({
      '/filesystem?path=': json({ error: 'No filesystem analysis available yet' }, 404),
      '/commands?limit=': json({ data: [] }),
    });

    const { result } = renderHook(() => useFilesystemSnapshot('dev-1', 'D:\\'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.snapshot).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('derives threshold events from the command list', async () => {
    routeByUrl({
      '/filesystem?path=': json({ data: snapshot() }),
      '/commands?limit=': json({
        data: [
          { id: 'c1', type: 'filesystem_analysis', status: 'completed', createdAt: '2026-09-19T09:00:00Z', payload: { trigger: 'threshold', path: 'C:\\' } },
          { id: 'c2', type: 'filesystem_analysis', status: 'completed', createdAt: '2026-09-19T08:00:00Z', payload: { trigger: 'on_demand' } },
        ],
      }),
    });

    const { result } = renderHook(() => useFilesystemSnapshot('dev-1', 'C:\\'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.thresholdEvents.map((e) => e.id)).toEqual(['c1']);
  });

  it('surfaces a non-404 failure as a localized error string', async () => {
    routeByUrl({
      '/filesystem?path=': json({ error: 'boom' }, 500),
      '/commands?limit=': json({ data: [] }),
    });

    const { result } = renderHook(() => useFilesystemSnapshot('dev-1', 'C:\\'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('boom');
    expect(result.current.snapshot).toBeNull();
  });

  it('re-fetches when the selected scan path changes and never mixes the two', async () => {
    routeByUrl({
      'path=C%3A%5C': json({ data: snapshot({ id: 'snap-c' }) }),
      'path=D%3A%5C': json({ data: snapshot({ id: 'snap-d', scanPath: 'D:\\' }) }),
      '/commands?limit=': json({ data: [] }),
    });

    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => useFilesystemSnapshot('dev-1', path),
      { initialProps: { path: 'C:\\' } },
    );
    await waitFor(() => expect(result.current.snapshot?.id).toBe('snap-c'));

    rerender({ path: 'D:\\' });
    await waitFor(() => expect(result.current.snapshot?.id).toBe('snap-d'));
  });

  it('aborts the in-flight request on unmount instead of setting state afterwards', async () => {
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      // Never resolves: the only way this test can pass is a real abort.
      return new Promise<Response>(() => {});
    });

    const { unmount } = renderHook(() => useFilesystemSnapshot('dev-1', 'C:\\'));
    await waitFor(() => expect(signals.length).toBeGreaterThan(0));
    expect(signals.every((s) => s.aborted)).toBe(false);

    act(() => { unmount(); });

    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it('reload(silent) refreshes without flipping loading back on', async () => {
    routeByUrl({
      '/filesystem?path=': json({ data: snapshot() }),
      '/commands?limit=': json({ data: [] }),
    });

    const { result } = renderHook(() => useFilesystemSnapshot('dev-1', 'C:\\'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchMock.mockClear();
    await act(async () => { await result.current.reload({ silent: true }); });

    expect(result.current.loading).toBe(false);
    expect(fetchMock).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/filesystem/useFilesystemSnapshot.test.ts
```

Expected failure: `Failed to load .../useFilesystemSnapshot.test.ts` … `Cannot find module './useFilesystemSnapshot'`.

- [ ] **Step 3: Implement** — create `apps/web/src/components/devices/filesystem/useFilesystemSnapshot.ts`:

```ts
/**
 * Latest filesystem snapshot for ONE scan path, plus that device's recent
 * threshold-triggered scans (spec §8).
 *
 * Two things the 958-line tab got wrong and this fixes (spec §2 defect 9):
 *   - the fetches outlived the component. Every request here rides one
 *     AbortController that the effect's cleanup aborts, so an unmount — or a
 *     volume switch — cancels the in-flight work instead of resolving into a
 *     dead component.
 *   - `t` was missing from the callbacks' dependency arrays, so a language
 *     switch left the previous language's fallback strings in place. It is
 *     declared here.
 *
 * A 404 is NOT an error: it is the honest answer for a volume that has never
 * been scanned, and the caller renders the "run Analyze" empty state.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '@/stores/auth';
import '@/lib/i18n';
import {
  readThresholdEvents,
  type CommandRow,
  type FilesystemSnapshot,
  type ThresholdEvent,
} from './filesystemTabUtils';

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

export function useFilesystemSnapshot(
  deviceId: string,
  scanPath: string | null,
): {
  snapshot: FilesystemSnapshot | null;
  thresholdEvents: ThresholdEvent[];
  loading: boolean;
  error: string | null;
  reload: (options?: { silent?: boolean }) => Promise<void>;
} {
  const { t } = useTranslation('devices');
  const [snapshot, setSnapshot] = useState<FilesystemSnapshot | null>(null);
  const [thresholdEvents, setThresholdEvents] = useState<ThresholdEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!scanPath) return;
      // One controller per load; aborting the previous one is what stops a
      // slow request for volume A landing after the user picked volume B.
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (!options.silent) setLoading(true);
      setError(null);
      try {
        const [snapshotResponse, commandsResponse] = await Promise.all([
          fetchWithAuth(
            `/devices/${deviceId}/filesystem?path=${encodeURIComponent(scanPath)}`,
            { signal: controller.signal },
          ),
          fetchWithAuth(`/devices/${deviceId}/commands?limit=100`, { signal: controller.signal }),
        ]);

        if (controller.signal.aborted) return;

        if (snapshotResponse.status === 404) {
          setSnapshot(null);
        } else if (!snapshotResponse.ok) {
          const body = await snapshotResponse.json().catch(() => null);
          throw new Error(
            (body && typeof body.error === 'string' && body.error)
            || t('deviceFilesystemTab.failedToFetchFilesystemStatus'),
          );
        } else {
          const body = await snapshotResponse.json();
          setSnapshot((body?.data ?? null) as FilesystemSnapshot | null);
        }

        if (!commandsResponse.ok) {
          const body = await commandsResponse.json().catch(() => null);
          throw new Error(
            (body && typeof body.error === 'string' && body.error)
            || t('deviceFilesystemTab.failedToFetchCommandHistory'),
          );
        }
        const commandsBody = await commandsResponse.json();
        const rows = Array.isArray(commandsBody?.data) ? (commandsBody.data as CommandRow[]) : [];
        if (controller.signal.aborted) return;
        setThresholdEvents(readThresholdEvents(rows));
      } catch (err) {
        if (isAbort(err) || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : t('deviceFilesystemTab.failedToLoadFilesystemStatus'));
        setSnapshot(null);
      } finally {
        if (!controller.signal.aborted && !options.silent) setLoading(false);
      }
    },
    [deviceId, scanPath, t],
  );

  useEffect(() => {
    void load();
    return () => {
      controllerRef.current?.abort();
    };
  }, [load]);

  return { snapshot, thresholdEvents, loading, error, reload: load };
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/web && npx vitest run src/components/devices/filesystem/useFilesystemSnapshot.test.ts
```

Expected: 7 tests PASS.

- [ ] **Step 5: Typecheck**

```bash
cd apps/web && pnpm exec astro check
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/devices/filesystem/useFilesystemSnapshot.ts \
  apps/web/src/components/devices/filesystem/useFilesystemSnapshot.test.ts
git commit -m "$(cat <<'EOF'
feat(devices): path-scoped filesystem snapshot hook that aborts on unmount

One AbortController per load, aborted by the effect cleanup, so neither an
unmount nor a volume switch can land a stale snapshot; a 404 means "this
volume has never been scanned" and is not rendered as an error; `t` is in the
dependency array so a language switch re-renders the fallbacks.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §8, §2 defect 9

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `useCommandPoll` — a backoff poll that dies with its component

**Files:**
- Create: `apps/web/src/components/devices/filesystem/useCommandPoll.ts`
- Create: `apps/web/src/components/devices/filesystem/useCommandPoll.test.ts` (Test)

**Interfaces:**
- Consumes: `fetchWithAuth` from `@/stores/auth`; `useTranslation` from `react-i18next`.
- Produces:
  ```ts
  export class CommandPollAbortedError extends Error {}
  export function useCommandPoll(deviceId: string): {
    status: string | null;
    poll: (commandId: string, timeoutMs: number) => Promise<void>;
    reset: () => void;
  };
  ```
  `poll` resolves when the command reaches `completed`, rejects with the command's own error on `failed`, rejects with a localized timeout message when `timeoutMs` elapses, and rejects with `CommandPollAbortedError` when the component unmounted.

- [ ] **Step 1: Write the failing test** — create `apps/web/src/components/devices/filesystem/useCommandPoll.test.ts`:

```ts
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from '@/stores/auth';
import { CommandPollAbortedError, useCommandPoll } from './useCommandPoll';

const fetchMock = vi.mocked(fetchWithAuth);

const commandResponse = (status: string, result?: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ data: { id: 'cmd-1', status, result } }) }) as unknown as Response;

describe('useCommandPoll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('resolves as soon as the command completes and exposes the last status', async () => {
    fetchMock
      .mockResolvedValueOnce(commandResponse('pending'))
      .mockResolvedValueOnce(commandResponse('completed'));

    const { result } = renderHook(() => useCommandPoll('dev-1'));

    let settled = false;
    await act(async () => {
      const promise = result.current.poll('cmd-1', 60_000).then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(2_500);
      await promise;
    });

    expect(settled).toBe(true);
    expect(result.current.status).toBe('completed');
  });

  it('backs off between polls rather than hammering a fixed interval', async () => {
    fetchMock.mockResolvedValue(commandResponse('running'));

    const { result } = renderHook(() => useCommandPoll('dev-1'));

    act(() => { void result.current.poll('cmd-1', 60_000).catch(() => undefined); });

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 2s, then 3s, then 4.5s — not 2s forever.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects with the command\u2019s own error when it fails', async () => {
    fetchMock.mockResolvedValueOnce(commandResponse('failed', { error: 'scanner exploded' }));

    const { result } = renderHook(() => useCommandPoll('dev-1'));

    await expect(
      act(async () => { await result.current.poll('cmd-1', 60_000); }),
    ).rejects.toThrow('scanner exploded');
  });

  it('rejects once the wall-clock budget is exhausted', async () => {
    fetchMock.mockResolvedValue(commandResponse('running'));

    const { result } = renderHook(() => useCommandPoll('dev-1'));

    let rejection: unknown;
    act(() => { void result.current.poll('cmd-1', 5_000).catch((e) => { rejection = e; }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain('still running');
  });

  it('stops polling and rejects with CommandPollAbortedError on unmount', async () => {
    fetchMock.mockResolvedValue(commandResponse('running'));

    const { result, unmount } = renderHook(() => useCommandPoll('dev-1'));

    let rejection: unknown;
    act(() => { void result.current.poll('cmd-1', 600_000).catch((e) => { rejection = e; }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const callsBeforeUnmount = fetchMock.mock.calls.length;

    act(() => { unmount(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    // The defining assertion (spec §2 defect 9): no request may be issued
    // after the component that started the loop has gone.
    expect(fetchMock.mock.calls.length).toBe(callsBeforeUnmount);
    expect(rejection).toBeInstanceOf(CommandPollAbortedError);
  });

  it('passes an AbortSignal to every request and aborts it on unmount', async () => {
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return Promise.resolve(commandResponse('running'));
    });

    const { result, unmount } = renderHook(() => useCommandPoll('dev-1'));
    act(() => { void result.current.poll('cmd-1', 600_000).catch(() => undefined); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(signals.length).toBeGreaterThan(0);
    act(() => { unmount(); });
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it('reset() clears the exposed status', async () => {
    fetchMock.mockResolvedValueOnce(commandResponse('completed'));
    const { result } = renderHook(() => useCommandPoll('dev-1'));

    await act(async () => { await result.current.poll('cmd-1', 60_000); });
    expect(result.current.status).toBe('completed');

    act(() => { result.current.reset(); });
    await waitFor(() => expect(result.current.status).toBeNull());
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/filesystem/useCommandPoll.test.ts
```

Expected failure: `Failed to load .../useCommandPoll.test.ts` … `Cannot find module './useCommandPoll'`.

- [ ] **Step 3: Implement** — create `apps/web/src/components/devices/filesystem/useCommandPoll.ts`:

```ts
/**
 * Poll one device command to a terminal state (spec §8).
 *
 * The version this replaces (DeviceFilesystemTab.tsx:352-404) ran a `while`
 * loop of `await new Promise(r => setTimeout(r, delay))` with no link to the
 * component's lifetime: navigating away from the tab mid-scan left the loop
 * polling for the rest of the session and then calling setState on a dead
 * component. Here the loop and every request it makes hang off ONE
 * AbortController that the unmount effect aborts, and the pending sleep is a
 * cancellable timer rather than an uninterruptible promise.
 *
 * `poll` REJECTS rather than returning a status because every caller has to
 * branch on failure anyway, and a rejected promise cannot be ignored by
 * accident the way a returned 'failed' can.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '@/stores/auth';
import '@/lib/i18n';

/** Thrown when the component unmounted while a poll was in flight. */
export class CommandPollAbortedError extends Error {
  constructor() {
    super('command poll aborted');
    this.name = 'CommandPollAbortedError';
  }
}

const INITIAL_DELAY_MS = 2_000;
const MAX_DELAY_MS = 10_000;
const BACKOFF_FACTOR = 1.5;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function useCommandPoll(deviceId: string): {
  status: string | null;
  poll: (commandId: string, timeoutMs: number) => Promise<void>;
  reset: () => void;
} {
  const { t } = useTranslation('devices');
  const [status, setStatus] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    controllerRef.current?.abort();
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  const reset = useCallback(() => {
    setStatus(null);
  }, []);

  const poll = useCallback(
    async (commandId: string, timeoutMs: number): Promise<void> => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      const startedAt = Date.now();
      let delayMs = INITIAL_DELAY_MS;

      // A cancellable sleep. `await new Promise(r => setTimeout(r, d))` cannot
      // be interrupted, so an unmount during the sleep still resumed the loop.
      const sleep = (ms: number) =>
        new Promise<void>((resolve, reject) => {
          if (controller.signal.aborted) {
            reject(new CommandPollAbortedError());
            return;
          }
          const timer = setTimeout(() => {
            controller.signal.removeEventListener('abort', onAbort);
            resolve();
          }, ms);
          timerRef.current = timer;
          function onAbort() {
            clearTimeout(timer);
            reject(new CommandPollAbortedError());
          }
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });

      while (Date.now() - startedAt < timeoutMs) {
        if (controller.signal.aborted) throw new CommandPollAbortedError();

        const response = await fetchWithAuth(
          `/devices/${deviceId}/commands/${commandId}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) throw new CommandPollAbortedError();

        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(
            (body && typeof body.error === 'string' && body.error)
            || t('deviceFilesystemTab.failedToFetchScanStatus'),
          );
        }

        const body = await response.json();
        const command = asRecord(body?.data);
        if (!command) throw new Error(t('deviceFilesystemTab.failedToFetchScanStatus'));

        const commandStatus = typeof command.status === 'string' ? command.status : 'pending';
        setStatus(commandStatus);

        if (commandStatus === 'completed') return;
        if (commandStatus === 'failed') {
          const result = asRecord(command.result);
          throw new Error(
            typeof result?.error === 'string' && result.error
              ? result.error
              : t('deviceFilesystemTab.filesystemScanFailed'),
          );
        }

        await sleep(delayMs);
        delayMs = Math.min(MAX_DELAY_MS, Math.round(delayMs * BACKOFF_FACTOR));
      }

      throw new Error(t('deviceFilesystemTab.scanStillRunning'));
    },
    [deviceId, t],
  );

  return { status, poll, reset };
}
```

- [ ] **Step 4: Add the one locale key this hook needs, in all 8 catalogs** — the old timeout message was a hardcoded English string (`DeviceFilesystemTab.tsx:399-401`, "Filesystem scan is still running. Click Refresh in a few moments."), which is exactly the unlocalised fallback spec §2 defect 9 names. Merge `deviceFilesystemTab.scanStillRunning` into each `devices.json`:

| File | Value |
|---|---|
| `en/devices.json` | `"scanStillRunning": "The scan is still running. Use Refresh in a few moments."` |
| `de-DE/devices.json` | `"scanStillRunning": "Der Scan läuft noch. Verwenden Sie in Kürze „Aktualisieren“."` |
| `es-419/devices.json` | `"scanStillRunning": "El escaneo aún está en curso. Use Actualizar en unos momentos."` |
| `fr-FR/devices.json` | `"scanStillRunning": "L’analyse est toujours en cours. Utilisez Actualiser dans quelques instants."` |
| `fr-CA/devices.json` | `"scanStillRunning": "L’analyse est toujours en cours. Utilisez Actualiser dans quelques instants."` |
| `it-IT/devices.json` | `"scanStillRunning": "La scansione è ancora in corso. Usa Aggiorna tra qualche istante."` |
| `pt-BR/devices.json` | `"scanStillRunning": "A varredura ainda está em andamento. Use Atualizar em alguns instantes."` |
| `tr-TR/devices.json` | `"scanStillRunning": "Tarama hâlâ sürüyor. Birkaç dakika sonra Yenile'yi kullanın."` |

- [ ] **Step 5: Run the hook test and the i18n guards, and watch them pass**

```bash
cd apps/web && npx vitest run \
  src/components/devices/filesystem/useCommandPoll.test.ts \
  src/lib/i18n/localeParity.test.ts \
  src/lib/i18n/translationCoverage.test.ts
```

Expected: 7 hook tests PASS and both i18n guards stay green. The unmount case is the one that matters — if `fetchMock.mock.calls.length` grows after `unmount()`, the sleep is not cancellable and the abort listener is missing.

- [ ] **Step 6: Typecheck**

```bash
cd apps/web && pnpm exec astro check
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/devices/filesystem/useCommandPoll.ts \
  apps/web/src/components/devices/filesystem/useCommandPoll.test.ts \
  apps/web/src/locales/en/devices.json apps/web/src/locales/de-DE/devices.json \
  apps/web/src/locales/es-419/devices.json apps/web/src/locales/fr-CA/devices.json \
  apps/web/src/locales/fr-FR/devices.json apps/web/src/locales/it-IT/devices.json \
  apps/web/src/locales/pt-BR/devices.json apps/web/src/locales/tr-TR/devices.json
git commit -m "$(cat <<'EOF'
feat(devices): command poll hook whose loop dies with its component

The scan poll it replaces kept running after the tab unmounted and then set
state on a dead component. Here the loop, every request and the inter-poll
sleep all hang off one AbortController that the unmount effect aborts, and
the sleep is a cancellable timer rather than an uninterruptible promise. The
timeout message is localized in all 8 catalogs instead of hardcoded English.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §8, §2 defect 9

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `SnapshotPanels.tsx` — the read-only half of the tab

**Files:**
- Create: `apps/web/src/components/devices/filesystem/SnapshotPanels.tsx`
- Create: `apps/web/src/components/devices/filesystem/SnapshotPanels.test.tsx` (Test)

**Interfaces:**
- Consumes: `formatBytes`, `formatDateTime`, `collapseAncestorDirectories`, `FilesystemSnapshot`, `ThresholdEvent` from `./filesystemTabUtils`; `formatNumber` from `@/lib/i18n/format`; `useTranslation` from `react-i18next`.
- Produces: `export default function SnapshotPanels({ snapshot, thresholdEvents }: { snapshot: FilesystemSnapshot; thresholdEvents: ThresholdEvent[] }): JSX.Element` — purely presentational; no fetching, no mutation, no state beyond a memo.

- [ ] **Step 1: Write the failing test** — create `apps/web/src/components/devices/filesystem/SnapshotPanels.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import SnapshotPanels from './SnapshotPanels';
import type { FilesystemSnapshot, ThresholdEvent } from './filesystemTabUtils';

const snapshot = (over: Partial<FilesystemSnapshot> = {}): FilesystemSnapshot => ({
  id: 'snap-1',
  capturedAt: '2026-09-19T10:00:00.000Z',
  trigger: 'on_demand',
  partial: false,
  scanPath: 'C:\\',
  scanMode: 'baseline',
  summary: {
    filesScanned: 1250,
    dirsScanned: 85,
    bytesScanned: 1024 * 1024 * 1024,
    maxDepthReached: 24,
    permissionDeniedCount: 12,
  },
  topLargestFiles: [{ path: 'C:\\big.iso', sizeBytes: 5 * 1024 * 1024 }],
  topLargestDirectories: [{ path: 'C:\\Windows', sizeBytes: 4 * 1024 * 1024, estimated: true }],
  tempAccumulation: [{ category: 'browser_cache', bytes: 2 * 1024 * 1024 }],
  oldDownloads: [{ path: 'C:\\old.zip', sizeBytes: 1 }],
  unrotatedLogs: [],
  trashUsage: [{ path: 'C:\\$Recycle.Bin', sizeBytes: 3 * 1024 * 1024 }],
  duplicateCandidates: [{ key: 'abc', sizeBytes: 1, count: 2 }],
  cleanupCandidates: [{ path: 'C:\\Windows\\Temp\\a', sizeBytes: 1 }],
  errors: [{ path: 'C:\\locked', error: 'denied' }],
  ...over,
});

const events: ThresholdEvent[] = [
  { id: 'e1', status: 'completed', createdAt: '2026-09-19T09:00:00.000Z', path: 'C:\\' },
];

describe('SnapshotPanels', () => {
  it('renders the scan summary counters', () => {
    render(<SnapshotPanels snapshot={snapshot()} thresholdEvents={events} />);
    const summary = screen.getByTestId('filesystem-scan-summary');
    expect(within(summary).getByText('Files scanned')).toBeInTheDocument();
    expect(within(summary).getByText('1,250')).toBeInTheDocument();
    expect(within(summary).getByText('24')).toBeInTheDocument();
  });

  it('renders tempAccumulation, which the old tab collected and never showed', () => {
    render(<SnapshotPanels snapshot={snapshot()} thresholdEvents={events} />);
    const panel = screen.getByTestId('filesystem-temp-accumulation');
    expect(within(panel).getByText('Browser cache')).toBeInTheDocument();
    expect(within(panel).getByText('2.0 MB')).toBeInTheDocument();
  });

  it('shows the temp-accumulation empty state when the agent reported none', () => {
    render(<SnapshotPanels snapshot={snapshot({ tempAccumulation: [] })} thresholdEvents={events} />);
    expect(screen.getByText('No temp accumulation data.')).toBeInTheDocument();
  });

  it('marks an estimated directory size with a lower-bound glyph', () => {
    render(<SnapshotPanels snapshot={snapshot()} thresholdEvents={events} />);
    const dirs = screen.getByTestId('filesystem-largest-directories');
    expect(within(dirs).getByText(/≥/)).toBeInTheDocument();
  });

  it('renders the threshold triggers and their empty state', () => {
    const { rerender } = render(<SnapshotPanels snapshot={snapshot()} thresholdEvents={events} />);
    expect(screen.getByTestId('filesystem-threshold-event-e1')).toBeInTheDocument();

    rerender(<SnapshotPanels snapshot={snapshot()} thresholdEvents={[]} />);
    expect(screen.getByText('No recent threshold-triggered scans.')).toBeInTheDocument();
  });

  it('keys every list row on a stable id, never on an optional path', () => {
    // Two directories with no path at all must not collide into one React key.
    const withMissingPaths = snapshot({
      topLargestFiles: [{ sizeBytes: 2 }, { sizeBytes: 1 }],
    });
    expect(() => render(<SnapshotPanels snapshot={withMissingPaths} thresholdEvents={[]} />)).not.toThrow();
    expect(screen.getAllByTestId(/^filesystem-largest-file-/)).toHaveLength(2);
  });

  it('shows the partial-scan reason when the snapshot is partial', () => {
    render(
      <SnapshotPanels snapshot={snapshot({ partial: true, reason: 'max entries reached' })} thresholdEvents={[]} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('max entries reached');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/filesystem/SnapshotPanels.test.tsx
```

Expected failure: `Failed to load .../SnapshotPanels.test.tsx` … `Cannot find module './SnapshotPanels'`.

- [ ] **Step 3: Implement** — create `apps/web/src/components/devices/filesystem/SnapshotPanels.tsx`:

```tsx
/**
 * The read-only half of the Disk Cleanup tab (spec §8): summary tiles, scan
 * summary, collected signals, temp accumulation, recent threshold triggers,
 * and the largest files/directories.
 *
 * Content is unchanged from the tab it was lifted out of, with three fixes:
 * `tempAccumulation` is rendered (the agent has always collected it and the
 * API has always returned it — nothing displayed it), every list row keys on
 * a stable synthetic id rather than an optional `path`, and the partial-scan
 * banner is a `role="status"` live region instead of a silent div.
 */

import { useMemo } from 'react';
import { AlertCircle, Clock, FolderOpen, HardDrive } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '@/lib/i18n/format';
import '@/lib/i18n';
import {
  collapseAncestorDirectories,
  formatBytes,
  formatDateTime,
  type FilesystemSnapshot,
  type ThresholdEvent,
} from './filesystemTabUtils';

const statusBadgeClasses: Record<string, string> = {
  pending: 'bg-gray-500/15 text-gray-700 border-gray-500/30',
  sent: 'bg-blue-500/15 text-blue-700 border-blue-500/30',
  completed: 'bg-green-500/15 text-green-700 border-green-500/30',
  failed: 'bg-red-500/15 text-red-700 border-red-500/30',
};

type Props = {
  snapshot: FilesystemSnapshot;
  thresholdEvents: ThresholdEvent[];
};

export default function SnapshotPanels({ snapshot, thresholdEvents }: Props) {
  const { t } = useTranslation('devices');

  const summary = snapshot.summary ?? {};
  const largestFiles = (snapshot.topLargestFiles ?? []).slice(0, 8);
  // Memoised at the call site, per spec §8 — the collapse is O(n²) over up to
  // 30 directories and re-running it on every keystroke elsewhere is waste.
  const largestDirectories = useMemo(
    () => collapseAncestorDirectories(snapshot.topLargestDirectories ?? [], 8),
    [snapshot.topLargestDirectories],
  );
  const tempAccumulation = snapshot.tempAccumulation ?? [];
  const totalTrashBytes = (snapshot.trashUsage ?? []).reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);

  return (
    <div className="space-y-4" data-testid="filesystem-snapshot-panels">
      {snapshot.partial && (
        <div
          role="status"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            <span>
              {t('deviceFilesystemTab.partialScanResult')}
              {snapshot.reason ? `: ${snapshot.reason}` : '.'}
            </span>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-md border bg-muted/20 p-3">
          <p className="text-xs text-muted-foreground">{t('deviceFilesystemTab.lastScan')}</p>
          <p className="mt-1 text-sm font-medium">{formatDateTime(snapshot.capturedAt)}</p>
        </div>
        <div className="rounded-md border bg-muted/20 p-3">
          <p className="text-xs text-muted-foreground">{t('deviceFilesystemTab.trigger')}</p>
          <p className="mt-1 text-sm font-medium">
            {snapshot.trigger === 'threshold'
              ? t('deviceFilesystemTab.threshold')
              : t('deviceFilesystemTab.onDemand')}
          </p>
        </div>
        <div className="rounded-md border bg-muted/20 p-3">
          <p className="text-xs text-muted-foreground">{t('deviceFilesystemTab.runMode')}</p>
          <p className="mt-1 text-sm font-medium">
            {snapshot.scanMode === 'incremental'
              ? t('deviceFilesystemTab.incremental')
              : t('deviceFilesystemTab.baseline')}
          </p>
        </div>
        <div className="rounded-md border bg-muted/20 p-3">
          <p className="text-xs text-muted-foreground">{t('deviceFilesystemTab.scanPath')}</p>
          <p className="mt-1 truncate text-sm font-medium">
            {snapshot.scanPath ?? snapshot.path ?? '-'}
          </p>
        </div>
        <div className="rounded-md border bg-muted/20 p-3">
          <p className="text-xs text-muted-foreground">{t('deviceFilesystemTab.scannedDataInPath')}</p>
          <p className="mt-1 text-sm font-medium">{formatBytes(summary.bytesScanned)}</p>
        </div>
        <div className="rounded-md border bg-muted/20 p-3">
          <p className="text-xs text-muted-foreground">{t('deviceFilesystemTab.cleanupCandidates')}</p>
          <p className="mt-1 text-sm font-medium">
            {formatNumber(snapshot.cleanupCandidates?.length ?? 0)}
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-md border p-3" data-testid="filesystem-scan-summary">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('deviceFilesystemTab.scanSummary')}
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
            <span className="text-muted-foreground">{t('deviceFilesystemTab.filesScanned')}</span>
            <span className="text-right font-medium">{formatNumber(summary.filesScanned ?? 0)}</span>
            <span className="text-muted-foreground">{t('deviceFilesystemTab.directoriesScanned')}</span>
            <span className="text-right font-medium">{formatNumber(summary.dirsScanned ?? 0)}</span>
            <span className="text-muted-foreground">{t('deviceFilesystemTab.maxDepthReached')}</span>
            <span className="text-right font-medium">{summary.maxDepthReached ?? 0}</span>
            <span className="text-muted-foreground">{t('deviceFilesystemTab.permissionDenials')}</span>
            <span className="text-right font-medium">{summary.permissionDeniedCount ?? 0}</span>
          </div>
        </div>

        <div className="rounded-md border p-3" data-testid="filesystem-collected-signals">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('deviceFilesystemTab.collectedSignals')}
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
            <span className="text-muted-foreground">{t('deviceFilesystemTab.oldDownloads')}</span>
            <span className="text-right font-medium">{formatNumber(snapshot.oldDownloads?.length ?? 0)}</span>
            <span className="text-muted-foreground">{t('deviceFilesystemTab.unrotatedLogs')}</span>
            <span className="text-right font-medium">{formatNumber(snapshot.unrotatedLogs?.length ?? 0)}</span>
            <span className="text-muted-foreground">{t('deviceFilesystemTab.trashSize')}</span>
            <span className="text-right font-medium">{formatBytes(totalTrashBytes)}</span>
            <span className="text-muted-foreground">{t('deviceFilesystemTab.duplicateGroups')}</span>
            <span className="text-right font-medium">{formatNumber(snapshot.duplicateCandidates?.length ?? 0)}</span>
            <span className="text-muted-foreground">{t('deviceFilesystemTab.scanErrors')}</span>
            <span className="text-right font-medium">{formatNumber(snapshot.errors?.length ?? 0)}</span>
          </div>
        </div>

        <div className="rounded-md border p-3" data-testid="filesystem-temp-accumulation">
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <HardDrive className="h-3.5 w-3.5" />
            {t('deviceFilesystemTab.tempAccumulation')}
          </p>
          <div className="mt-2 space-y-1">
            {tempAccumulation.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('deviceFilesystemTab.noTempAccumulationData')}
              </p>
            ) : (
              tempAccumulation.map((item, index) => (
                <div
                  key={`temp-${item.category ?? 'unknown'}-${index}`}
                  data-testid={`filesystem-temp-accumulation-${index}`}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span>
                    {item.category
                      // i18n-dynamic: the category comes from the agent payload.
                      ? t(/* i18n-dynamic */ `deviceFilesystemTab.categories.${item.category}`, {
                          defaultValue: item.category,
                        })
                      : '-'}
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-right font-medium tabular-nums">
                    {formatBytes(item.bytes)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-md border p-3" data-testid="filesystem-threshold-triggers">
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            {t('deviceFilesystemTab.recentThresholdTriggers')}
          </p>
          <div className="mt-2 space-y-2">
            {thresholdEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('deviceFilesystemTab.noRecentThresholdTriggeredScans')}
              </p>
            ) : (
              thresholdEvents.slice(0, 5).map((event) => (
                <div
                  key={event.id}
                  data-testid={`filesystem-threshold-event-${event.id}`}
                  className="flex items-start justify-between gap-2 rounded bg-muted/20 px-2 py-1.5 text-xs"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{event.path}</p>
                    <p className="text-muted-foreground">{formatDateTime(event.createdAt)}</p>
                  </div>
                  <span
                    className={`inline-flex rounded-full border px-2 py-0.5 ${statusBadgeClasses[event.status] ?? 'bg-muted/30 text-muted-foreground border-muted'}`}
                  >
                    {event.status}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-md border p-3" data-testid="filesystem-largest-files">
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <FolderOpen className="h-3.5 w-3.5" />
            {t('deviceFilesystemTab.largestFiles')}
          </p>
          <div className="mt-2 space-y-1">
            {largestFiles.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('deviceFilesystemTab.noFileDataAvailable')}</p>
            ) : (
              largestFiles.map((item, index) => (
                <div
                  key={`file-${index}-${item.path ?? ''}`}
                  data-testid={`filesystem-largest-file-${index}`}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span className="truncate">{item.path ?? '-'}</span>
                  <span className="shrink-0 whitespace-nowrap text-right font-medium tabular-nums">
                    {formatBytes(item.sizeBytes)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-md border p-3" data-testid="filesystem-largest-directories">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('deviceFilesystemTab.largestDirectories')}
          </p>
          {largestDirectories.some((item) => item.estimated) && (
            <p className="mt-1 text-xs text-muted-foreground">
              ≥ {t('deviceFilesystemTab.indicatesLowerBoundSizeFromPartial')}
            </p>
          )}
          <div className="mt-2 space-y-1">
            {largestDirectories.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('deviceFilesystemTab.noDirectoryDataAvailable')}
              </p>
            ) : (
              largestDirectories.map((item, index) => (
                <div
                  key={`dir-${index}-${item.path ?? ''}`}
                  data-testid={`filesystem-largest-directory-${index}`}
                  className="flex items-center justify-between gap-2 rounded bg-muted/20 px-2 py-1.5 text-sm"
                >
                  <span className="truncate">{item.path ?? '-'}</span>
                  <span className="shrink-0 whitespace-nowrap text-right font-medium tabular-nums">
                    {item.estimated ? '≥' : ''}
                    {formatBytes(item.sizeBytes)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/web && npx vitest run src/components/devices/filesystem/SnapshotPanels.test.tsx
```

Expected: 7 tests PASS.

- [ ] **Step 5: Typecheck**

```bash
cd apps/web && pnpm exec astro check
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/devices/filesystem/SnapshotPanels.tsx \
  apps/web/src/components/devices/filesystem/SnapshotPanels.test.tsx
git commit -m "$(cat <<'EOF'
feat(devices): SnapshotPanels, the read-only half of the Disk Cleanup tab

Same content as the monolithic tab, plus the three fixes it needed:
tempAccumulation is finally rendered (collected by the agent and returned by
the API since day one, displayed nowhere), list rows key on a stable
synthetic id instead of an optional path, and the partial-scan banner is a
role="status" live region.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §8

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: `CleanupPanel.tsx` — select, confirm, execute, report

This is the component §2 defect 4 is about: the tab that stops at a preview, and the execute that lived in File Manager without a `cleanupRunId`.

**Files:**
- Create: `apps/web/src/components/devices/filesystem/CleanupPanel.tsx`
- Create: `apps/web/src/components/devices/filesystem/CleanupPanel.test.tsx` (Test)

**Interfaces:**
- Consumes: `runAction`, `ActionError` from `@/lib/runAction`; `showToast` from `@/components/shared/Toast`; `ConfirmDialog` from `@/components/shared/ConfirmDialog`; `fetchWithAuth` from `@/stores/auth`; `formatBytes`, `selectedBytes`, `summariseActionStatuses`, `CleanupCandidate`, `FilesystemCleanupPreview`, `CleanupExecuteResult` from `./filesystemTabUtils`.
- Consumes (API, from W01 + this wave's Task 1): `POST /devices/:id/filesystem/cleanup-execute` with body `{ cleanupRunId: string; paths: string[] }` → `{ success: true, data: CleanupExecuteResult }`.
- Produces:
  ```ts
  export default function CleanupPanel(props: {
    deviceId: string;
    volumeLabel: string;
    preview: FilesystemCleanupPreview | null;
    onExecuted: () => void;
  }): JSX.Element;
  ```
  `onExecuted` is called after a successful execute so the composer can refresh the snapshot and the run history.

- [ ] **Step 1: Write the failing test** — create `apps/web/src/components/devices/filesystem/CleanupPanel.test.tsx`:

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const showToastMock = vi.fn();
vi.mock('@/components/shared/Toast', () => ({ showToast: showToastMock }));

import { fetchWithAuth } from '@/stores/auth';
import CleanupPanel from './CleanupPanel';
import type { FilesystemCleanupPreview } from './filesystemTabUtils';

const fetchMock = vi.mocked(fetchWithAuth);

const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const preview = (over: Partial<FilesystemCleanupPreview> = {}): FilesystemCleanupPreview => ({
  cleanupRunId: RUN_ID,
  snapshotId: 'snap-1',
  scanPath: 'C:\\',
  estimatedBytes: 3072,
  candidateCount: 3,
  categories: [
    { category: 'temp_files', count: 2, estimatedBytes: 2048 },
    { category: 'browser_cache', count: 1, estimatedBytes: 1024 },
  ],
  candidates: [
    { path: 'C:\\Windows\\Temp\\big', category: 'temp_files', sizeBytes: 1536 },
    { path: 'C:\\Windows\\Temp\\small', category: 'temp_files', sizeBytes: 512 },
    { path: 'C:\\Users\\a\\Cache\\c', category: 'browser_cache', sizeBytes: 1024 },
  ],
  ...over,
});

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('CleanupPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prompts for a preview when there is none', () => {
    render(<CleanupPanel deviceId="dev-1" volumeLabel="C:\\" preview={null} onExecuted={vi.fn()} />);
    expect(screen.getByText('Run Cleanup Preview to choose what to delete.')).toBeInTheDocument();
    expect(screen.queryByTestId('cleanup-execute')).not.toBeInTheDocument();
  });

  it('lists candidates sorted by size, largest first', () => {
    render(<CleanupPanel deviceId="dev-1" volumeLabel="C:\\" preview={preview()} onExecuted={vi.fn()} />);
    const rows = screen.getAllByTestId(/^cleanup-candidate-/);
    expect(rows.map((r) => r.getAttribute('data-path'))).toEqual([
      'C:\\Windows\\Temp\\big',
      'C:\\Users\\a\\Cache\\c',
      'C:\\Windows\\Temp\\small',
    ]);
  });

  it('starts with nothing selected and disables Execute', () => {
    render(<CleanupPanel deviceId="dev-1" volumeLabel="C:\\" preview={preview()} onExecuted={vi.fn()} />);
    expect(screen.getByTestId('cleanup-execute')).toBeDisabled();
  });

  it('select-all-in-category checks exactly that category and updates the byte total', async () => {
    render(<CleanupPanel deviceId="dev-1" volumeLabel="C:\\" preview={preview()} onExecuted={vi.fn()} />);

    await userEvent.click(screen.getByTestId('cleanup-category-select-all-temp_files'));

    expect(screen.getByTestId('cleanup-candidate-checkbox-C:\\Windows\\Temp\\big')).toBeChecked();
    expect(screen.getByTestId('cleanup-candidate-checkbox-C:\\Windows\\Temp\\small')).toBeChecked();
    expect(screen.getByTestId('cleanup-candidate-checkbox-C:\\Users\\a\\Cache\\c')).not.toBeChecked();
    expect(screen.getByTestId('cleanup-selection-summary')).toHaveTextContent('2.0 KB');
  });

  it('opens a destructive confirm listing volume, count, bytes and the first 10 paths', async () => {
    render(<CleanupPanel deviceId="dev-1" volumeLabel="C:\\" preview={preview()} onExecuted={vi.fn()} />);
    await userEvent.click(screen.getByTestId('cleanup-category-select-all-temp_files'));
    await userEvent.click(screen.getByTestId('cleanup-execute'));

    const dialog = await screen.findByTestId('cleanup-confirm-dialog');
    expect(within(dialog).getByText(/C:\\/)).toBeInTheDocument();
    expect(within(dialog).getByText(/2 item\(s\)/)).toBeInTheDocument();
    expect(within(dialog).getByText(/2\.0 KB/)).toBeInTheDocument();
    expect(within(dialog).getByText('C:\\Windows\\Temp\\big')).toBeInTheDocument();
    // Nothing is deleted until Confirm is pressed.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caps the confirm path list at 10 and says how many there are', async () => {
    const many = preview({
      candidates: Array.from({ length: 14 }, (_, i) => ({
        path: `C:\\Windows\\Temp\\f${i}`, category: 'temp_files', sizeBytes: 100 - i,
      })),
      categories: [{ category: 'temp_files', count: 14, estimatedBytes: 1000 }],
    });
    render(<CleanupPanel deviceId="dev-1" volumeLabel="C:\\" preview={many} onExecuted={vi.fn()} />);
    await userEvent.click(screen.getByTestId('cleanup-category-select-all-temp_files'));
    await userEvent.click(screen.getByTestId('cleanup-execute'));

    const dialog = await screen.findByTestId('cleanup-confirm-dialog');
    expect(within(dialog).getAllByTestId(/^cleanup-confirm-path-/)).toHaveLength(10);
    expect(within(dialog).getByText('First 10 of 14 paths')).toBeInTheDocument();
  });

  it('posts cleanupRunId and ONLY the checked paths', async () => {
    fetchMock.mockResolvedValue(json({
      success: true,
      data: {
        cleanupRunId: RUN_ID, status: 'executed', bytesReclaimed: 2048,
        selectedCount: 2, failedCount: 0, rejectedPaths: [], partial: false, budgetMs: 240_000,
        actions: [
          { path: 'C:\\Windows\\Temp\\big', category: 'temp_files', sizeBytes: 1536, status: 'completed' },
          { path: 'C:\\Windows\\Temp\\small', category: 'temp_files', sizeBytes: 512, status: 'completed' },
        ],
      },
    }));
    const onExecuted = vi.fn();
    render(<CleanupPanel deviceId="dev-1" volumeLabel="C:\\" preview={preview()} onExecuted={onExecuted} />);

    await userEvent.click(screen.getByTestId('cleanup-category-select-all-temp_files'));
    await userEvent.click(screen.getByTestId('cleanup-execute'));
    await userEvent.click(await screen.findByTestId('cleanup-confirm-button'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/devices/dev-1/filesystem/cleanup-execute');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      cleanupRunId: RUN_ID,
      paths: ['C:\\Windows\\Temp\\big', 'C:\\Windows\\Temp\\small'],
    });
    await waitFor(() => expect(onExecuted).toHaveBeenCalled());
  });

  it('renders all five outcome counts and an amber failure list, never a green box', async () => {
    fetchMock.mockResolvedValue(json({
      success: true,
      data: {
        cleanupRunId: RUN_ID, status: 'executed', bytesReclaimed: 1536,
        selectedCount: 3, failedCount: 1, rejectedPaths: ['C:\\nope'], partial: false, budgetMs: 240_000,
        actions: [
          { path: 'C:\\Windows\\Temp\\big', category: 'temp_files', sizeBytes: 1536, status: 'completed' },
          { path: 'C:\\Windows\\Temp\\small', category: 'temp_files', sizeBytes: 512, status: 'skipped_locked' },
          { path: 'C:\\nope', category: 'temp_files', sizeBytes: 0, status: 'rejected' },
          { path: 'C:\\Users\\a\\Cache\\c', category: 'browser_cache', sizeBytes: 1024, status: 'failed', error: 'denied' },
        ],
      },
    }));
    render(<CleanupPanel deviceId="dev-1" volumeLabel="C:\\" preview={preview()} onExecuted={vi.fn()} />);

    await userEvent.click(screen.getByTestId('cleanup-category-select-all-temp_files'));
    await userEvent.click(screen.getByTestId('cleanup-execute'));
    await userEvent.click(await screen.findByTestId('cleanup-confirm-button'));

    const result = await screen.findByTestId('cleanup-result');
    expect(within(result).getByTestId('cleanup-count-completed')).toHaveTextContent('1');
    expect(within(result).getByTestId('cleanup-count-skipped_locked')).toHaveTextContent('1');
    expect(within(result).getByTestId('cleanup-count-rejected')).toHaveTextContent('1');
    expect(within(result).getByTestId('cleanup-count-skipped_budget')).toHaveTextContent('0');
    const failures = within(result).getByTestId('cleanup-failures');
    expect(failures.className).toContain('amber');
    expect(failures.className).not.toContain('green');
    expect(within(failures).getByText(/denied/)).toBeInTheDocument();
  });

  it('surfaces a failed execute through runAction and keeps the selection', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'all cleanup actions failed' }, 500));
    const onExecuted = vi.fn();
    render(<CleanupPanel deviceId="dev-1" volumeLabel="C:\\" preview={preview()} onExecuted={onExecuted} />);

    await userEvent.click(screen.getByTestId('cleanup-category-select-all-temp_files'));
    await userEvent.click(screen.getByTestId('cleanup-execute'));
    await userEvent.click(await screen.findByTestId('cleanup-confirm-button'));

    // runAction toasts the failure; the panel must not pretend it succeeded.
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    ));
    expect(onExecuted).not.toHaveBeenCalled();
    expect(screen.queryByTestId('cleanup-result')).not.toBeInTheDocument();
    expect(screen.getByTestId('cleanup-candidate-checkbox-C:\\Windows\\Temp\\big')).toBeChecked();
  });

  it('clears the selection when the preview is replaced', () => {
    const { rerender } = render(
      <CleanupPanel deviceId="dev-1" volumeLabel="C:\\" preview={preview()} onExecuted={vi.fn()} />,
    );
    // A new preview pins a NEW run; carrying a stale selection across it would
    // submit paths that belong to a different pinned candidate set.
    rerender(
      <CleanupPanel
        deviceId="dev-1"
        volumeLabel="D:\\"
        preview={preview({ cleanupRunId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', candidates: [] , categories: [] })}
        onExecuted={vi.fn()}
      />,
    );
    expect(screen.getByTestId('cleanup-execute')).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/filesystem/CleanupPanel.test.tsx
```

Expected failure: `Failed to load .../CleanupPanel.test.tsx` … `Cannot find module './CleanupPanel'`.

- [ ] **Step 3: Implement** — create `apps/web/src/components/devices/filesystem/CleanupPanel.tsx`:

```tsx
/**
 * Select → confirm → execute → report, inside the tab (spec §8, §2 defect 4).
 *
 * The behaviour this replaces put Execute in File Manager, where it re-derived
 * candidates from whatever snapshot was newest and posted no `cleanupRunId` —
 * the exact race the API's pinning exists to prevent. Here the pinned run id
 * comes from the preview this panel was handed, and the selection is cleared
 * whenever that run changes, so a click can only ever delete paths from the
 * candidate set the operator actually looked at.
 *
 * The result panel reports all five outcome buckets even at zero and renders
 * failures amber. A partial failure in a green box (the old File Manager
 * behaviour) reads as success at a glance.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { showToast } from '@/components/shared/Toast';
import { ActionError, runAction } from '@/lib/runAction';
import { formatNumber } from '@/lib/i18n/format';
import { fetchWithAuth } from '@/stores/auth';
import '@/lib/i18n';
import {
  CLEANUP_ACTION_STATUSES,
  formatBytes,
  selectedBytes,
  summariseActionStatuses,
  type CleanupCandidate,
  type CleanupExecuteResult,
  type FilesystemCleanupPreview,
} from './filesystemTabUtils';

const CONFIRM_PATH_PREVIEW_LIMIT = 10;

const RESULT_LABEL_KEYS: Record<(typeof CLEANUP_ACTION_STATUSES)[number], string> = {
  completed: 'deviceFilesystemTab.resultCompleted',
  failed: 'deviceFilesystemTab.resultFailures',
  skipped_locked: 'deviceFilesystemTab.resultSkippedLocked',
  rejected: 'deviceFilesystemTab.resultRejected',
  skipped_budget: 'deviceFilesystemTab.resultSkippedBudget',
};

type Props = {
  deviceId: string;
  /** What the confirm dialog names as the target, e.g. `C:\` or `/`. */
  volumeLabel: string;
  preview: FilesystemCleanupPreview | null;
  onExecuted: () => void;
};

export default function CleanupPanel({ deviceId, volumeLabel, preview, onExecuted }: Props) {
  const { t } = useTranslation('devices');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<CleanupExecuteResult | null>(null);

  const pinnedRunId = preview?.cleanupRunId ?? null;

  // A new preview pins a NEW run and a new candidate set. Carrying a stale
  // selection across that would submit paths from a different pinned plan,
  // which the API would reject — but the user would have been shown a
  // confirm dialog listing them as if they were about to be deleted.
  useEffect(() => {
    setSelected(new Set());
    setResult(null);
  }, [pinnedRunId]);

  const sortedCandidates = useMemo<CleanupCandidate[]>(
    () => [...(preview?.candidates ?? [])].sort((a, b) => b.sizeBytes - a.sizeBytes),
    [preview],
  );

  const byCategory = useMemo(() => {
    const map = new Map<string, CleanupCandidate[]>();
    for (const candidate of sortedCandidates) {
      const list = map.get(candidate.category) ?? [];
      list.push(candidate);
      map.set(candidate.category, list);
    }
    return map;
  }, [sortedCandidates]);

  const selectedPaths = useMemo(
    () => sortedCandidates.filter((c) => selected.has(c.path)).map((c) => c.path),
    [sortedCandidates, selected],
  );
  const selectedByteTotal = selectedBytes(sortedCandidates, selected);

  const toggle = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const selectCategory = useCallback((category: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const candidate of byCategory.get(category) ?? []) {
        if (on) next.add(candidate.path);
        else next.delete(candidate.path);
      }
      return next;
    });
  }, [byCategory]);

  const execute = useCallback(async () => {
    if (!pinnedRunId || selectedPaths.length === 0) return;
    setExecuting(true);
    try {
      const data = await runAction<CleanupExecuteResult>({
        request: () => fetchWithAuth(`/devices/${deviceId}/filesystem/cleanup-execute`, {
          method: 'POST',
          body: JSON.stringify({ cleanupRunId: pinnedRunId, paths: selectedPaths }),
        }),
        errorFallback: t('deviceFilesystemTab.cleanupFailed'),
        parseSuccess: (body) => (body as { data: CleanupExecuteResult }).data,
        successMessage: (value) =>
          t('deviceFilesystemTab.cleanupFinished', { size: formatBytes(value.bytesReclaimed) }),
      });
      setConfirmOpen(false);
      setResult(data);
      setSelected(new Set());
      onExecuted();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('deviceFilesystemTab.cleanupFailed') });
      }
      // The dialog stays open on failure so the action is retryable, and the
      // selection is deliberately NOT cleared.
      setConfirmOpen(false);
    } finally {
      setExecuting(false);
    }
  }, [deviceId, onExecuted, pinnedRunId, selectedPaths, t]);

  if (!preview) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-xs" data-testid="cleanup-panel">
        <h4 className="font-semibold">{t('deviceFilesystemTab.cleanupTitle')}</h4>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('deviceFilesystemTab.cleanupPreviewRequired')}
        </p>
      </div>
    );
  }

  const counts = result ? summariseActionStatuses(result.actions) : null;
  const failures = result?.actions.filter((a) => a.status === 'failed') ?? [];

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs" data-testid="cleanup-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="font-semibold">{t('deviceFilesystemTab.cleanupTitle')}</h4>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground" data-testid="cleanup-selection-summary">
            {t('deviceFilesystemTab.selectionSummary', {
              count: selectedPaths.length,
              size: formatBytes(selectedByteTotal),
            })}
          </span>
          <button
            type="button"
            data-testid="cleanup-execute"
            onClick={() => setConfirmOpen(true)}
            disabled={selectedPaths.length === 0 || executing || !pinnedRunId}
            className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50"
          >
            {executing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            {t('deviceFilesystemTab.executeSelected', { count: selectedPaths.length })}
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {preview.categories.map((category) => {
          const rows = byCategory.get(category.category) ?? [];
          const allOn = rows.length > 0 && rows.every((row) => selected.has(row.path));
          return (
            <div
              key={category.category}
              data-testid={`cleanup-category-${category.category}`}
              className="rounded-md border bg-muted/20 p-3"
            >
              <p className="text-sm font-medium">
                {/* i18n-dynamic: the category comes from the agent payload. */}
                {t(/* i18n-dynamic */ `deviceFilesystemTab.categories.${category.category}`, {
                  defaultValue: category.category,
                })}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatNumber(category.count)} · {formatBytes(category.estimatedBytes)}
              </p>
              <button
                type="button"
                data-testid={`cleanup-category-select-all-${category.category}`}
                onClick={() => selectCategory(category.category, !allOn)}
                className="mt-2 text-xs font-medium text-primary hover:underline"
              >
                {allOn
                  ? t('deviceFilesystemTab.clearCategory')
                  : t('deviceFilesystemTab.selectAllInCategory')}
              </button>
            </div>
          );
        })}
      </div>

      <div className="mt-4 overflow-hidden rounded-md border">
        <div className="grid grid-cols-[auto_1fr_auto] gap-2 border-b bg-muted/30 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <span aria-hidden="true" />
          <span>{t('deviceFilesystemTab.columnPath')}</span>
          <span className="text-right">{t('deviceFilesystemTab.columnSize')}</span>
        </div>
        <div className="max-h-96 overflow-auto">
          {sortedCandidates.map((candidate) => (
            <label
              key={candidate.path}
              data-testid={`cleanup-candidate-${candidate.path}`}
              data-path={candidate.path}
              className="grid cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/40"
            >
              <input
                type="checkbox"
                data-testid={`cleanup-candidate-checkbox-${candidate.path}`}
                checked={selected.has(candidate.path)}
                onChange={() => toggle(candidate.path)}
              />
              <span className="truncate">{candidate.path}</span>
              <span className="shrink-0 whitespace-nowrap text-right font-medium tabular-nums">
                {formatBytes(candidate.sizeBytes)}
              </span>
            </label>
          ))}
        </div>
      </div>

      {result && counts && (
        <div className="mt-4 rounded-md border p-3" data-testid="cleanup-result">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('deviceFilesystemTab.resultTitle')}
          </p>
          <p className="mt-1 text-sm font-medium">
            {t('deviceFilesystemTab.resultReclaimed')}: {formatBytes(result.bytesReclaimed)}
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-4">
            {CLEANUP_ACTION_STATUSES.filter((status) => status !== 'failed').map((status) => (
              <div key={status} className="rounded bg-muted/20 px-2 py-1.5 text-xs">
                <span className="text-muted-foreground">{t(RESULT_LABEL_KEYS[status])}</span>
                <span className="ml-1 font-medium" data-testid={`cleanup-count-${status}`}>
                  {formatNumber(counts[status])}
                </span>
              </div>
            ))}
          </div>
          {failures.length > 0 && (
            <div
              data-testid="cleanup-failures"
              className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800"
            >
              <p className="flex items-center gap-1.5 font-medium">
                <AlertTriangle className="h-3.5 w-3.5" />
                {t('deviceFilesystemTab.resultFailures')} ({formatNumber(failures.length)})
              </p>
              <ul className="mt-1 space-y-0.5">
                {failures.map((action) => (
                  <li key={action.path} className="truncate">
                    {action.path}
                    {action.error ? ` — ${action.error}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => { void execute(); }}
        variant="destructive"
        isLoading={executing}
        dialogTestId="cleanup-confirm-dialog"
        confirmTestId="cleanup-confirm-button"
        title={t('deviceFilesystemTab.confirmTitle')}
        message={t('deviceFilesystemTab.confirmMessage', {
          count: selectedPaths.length,
          size: formatBytes(selectedByteTotal),
          volume: volumeLabel,
        })}
        confirmLabel={t('deviceFilesystemTab.confirmLabel')}
      >
        <div className="mt-3 rounded-md border bg-muted/20 p-2 text-xs">
          <p className="font-medium">
            {t('deviceFilesystemTab.confirmPathsHeading', {
              shown: Math.min(CONFIRM_PATH_PREVIEW_LIMIT, selectedPaths.length),
              total: selectedPaths.length,
            })}
          </p>
          <ul className="mt-1 space-y-0.5">
            {selectedPaths.slice(0, CONFIRM_PATH_PREVIEW_LIMIT).map((path) => (
              <li key={path} data-testid={`cleanup-confirm-path-${path}`} className="truncate">
                {path}
              </li>
            ))}
          </ul>
        </div>
      </ConfirmDialog>
    </div>
  );
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/web && npx vitest run src/components/devices/filesystem/CleanupPanel.test.tsx
```

Expected: 10 tests PASS.

- [ ] **Step 5: Typecheck**

```bash
cd apps/web && pnpm exec astro check
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/devices/filesystem/CleanupPanel.tsx \
  apps/web/src/components/devices/filesystem/CleanupPanel.test.tsx
git commit -m "$(cat <<'EOF'
feat(devices): CleanupPanel — select, confirm, execute and report in the tab

Category cards with byte totals and select-all, a size-sorted candidate table
with per-row checkboxes, and an Execute that opens a destructive ConfirmDialog
naming the volume, the count, the bytes and the first 10 paths. The POST goes
through runAction and always carries the pinned cleanupRunId; the selection is
cleared whenever the pinned run changes so a click can never submit paths from
a plan the operator did not look at. The result panel reports all five outcome
buckets even at zero and renders failures amber, never in a green box.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §8, §2 defect 4

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: `CleanupRunHistory.tsx` — paginated history of both run kinds

**Files:**
- Create: `apps/web/src/components/devices/filesystem/CleanupRunHistory.tsx`
- Create: `apps/web/src/components/devices/filesystem/CleanupRunHistory.test.tsx` (Test)

**Interfaces:**
- Consumes: `fetchWithAuth` from `@/stores/auth`; `formatBytes`, `formatDateTime` from `./filesystemTabUtils`; `GET /devices/:id/filesystem/cleanup-runs?limit=&cursor=` (Task 3) → `{ success: true, data: { runs: CleanupRunListItem[]; nextCursor: string | null } }`.
- Produces:
  ```ts
  export type CleanupRunListItem = { id: string; kind: string; status: string; scanPath: string | null; requestedAt: string; approvedAt: string | null; bytesReclaimed: number; error: string | null; candidateCount: number; estimatedBytes: number; actionCount: number };
  export default function CleanupRunHistory({ deviceId, refreshToken }: { deviceId: string; refreshToken: number }): JSX.Element;
  ```
  `refreshToken` is a monotonic counter the composer bumps after a successful execute; changing it restarts the walk from page 1.

- [ ] **Step 1: Write the failing test** — create `apps/web/src/components/devices/filesystem/CleanupRunHistory.test.tsx`:

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from '@/stores/auth';
import CleanupRunHistory from './CleanupRunHistory';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const run = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'files',
  status: 'executed',
  scanPath: 'C:\\',
  requestedAt: '2026-09-19T10:00:00.000Z',
  approvedAt: '2026-09-19T10:01:00.000Z',
  bytesReclaimed: 2048,
  error: null,
  candidateCount: 3,
  estimatedBytes: 4096,
  actionCount: 2,
  ...over,
});

describe('CleanupRunHistory', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the first page and asks for the default limit', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { runs: [run('r1')], nextCursor: null } }));

    render(<CleanupRunHistory deviceId="dev-1" refreshToken={0} />);

    expect(await screen.findByTestId('cleanup-run-r1')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0][0])).toBe('/devices/dev-1/filesystem/cleanup-runs?limit=20');
  });

  it('labels the kind and the status from the catalog, not from the raw token', async () => {
    fetchMock.mockResolvedValue(json({
      success: true,
      data: {
        runs: [run('r1'), run('r2', { kind: 'system', status: 'failed', bytesReclaimed: 0, error: 'timed out' })],
        nextCursor: null,
      },
    }));

    render(<CleanupRunHistory deviceId="dev-1" refreshToken={0} />);

    const first = await screen.findByTestId('cleanup-run-r1');
    expect(within(first).getByText('File cleanup')).toBeInTheDocument();
    expect(within(first).getByText('Executed')).toBeInTheDocument();
    expect(within(first).getByText('2.0 KB reclaimed')).toBeInTheDocument();

    const second = screen.getByTestId('cleanup-run-r2');
    expect(within(second).getByText('System cleanup')).toBeInTheDocument();
    expect(within(second).getByText('Failed')).toBeInTheDocument();
    expect(within(second).getByText(/timed out/)).toBeInTheDocument();
  });

  it('shows the empty state when the device has no runs', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { runs: [], nextCursor: null } }));
    render(<CleanupRunHistory deviceId="dev-1" refreshToken={0} />);
    expect(await screen.findByText('No cleanup runs recorded yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('cleanup-run-history-more')).not.toBeInTheDocument();
  });

  it('appends the next page on Load more and passes the cursor through', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ success: true, data: { runs: [run('r1')], nextCursor: '2026-09-19T10:00:00.000Z|r1' } }))
      .mockResolvedValueOnce(json({ success: true, data: { runs: [run('r2')], nextCursor: null } }));

    render(<CleanupRunHistory deviceId="dev-1" refreshToken={0} />);
    await screen.findByTestId('cleanup-run-r1');

    await userEvent.click(screen.getByTestId('cleanup-run-history-more'));

    await waitFor(() => expect(screen.getByTestId('cleanup-run-r2')).toBeInTheDocument());
    // The first page is still on screen — Load more appends, it does not replace.
    expect(screen.getByTestId('cleanup-run-r1')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[1][0]))
      .toBe('/devices/dev-1/filesystem/cleanup-runs?limit=20&cursor=2026-09-19T10%3A00%3A00.000Z%7Cr1');
    // Nothing left to walk: the button is gone.
    expect(screen.queryByTestId('cleanup-run-history-more')).not.toBeInTheDocument();
  });

  it('restarts the walk when refreshToken changes', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { runs: [run('r1')], nextCursor: 'c1' } }));
    const { rerender } = render(<CleanupRunHistory deviceId="dev-1" refreshToken={0} />);
    await screen.findByTestId('cleanup-run-r1');

    fetchMock.mockResolvedValue(json({ success: true, data: { runs: [run('r9')], nextCursor: null } }));
    rerender(<CleanupRunHistory deviceId="dev-1" refreshToken={1} />);

    await waitFor(() => expect(screen.getByTestId('cleanup-run-r9')).toBeInTheDocument());
    expect(screen.queryByTestId('cleanup-run-r1')).not.toBeInTheDocument();
    // The restart must not carry the previous walk's cursor.
    expect(String(fetchMock.mock.calls.at(-1)![0])).not.toContain('cursor=');
  });

  it('renders an error banner instead of an empty list on a failed page', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'boom' }, 500));
    render(<CleanupRunHistory deviceId="dev-1" refreshToken={0} />);

    const banner = await screen.findByTestId('cleanup-run-history-error');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveTextContent('Failed to load cleanup history');
  });

  it('aborts the in-flight page request on unmount', async () => {
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>(() => {});
    });

    const { unmount } = render(<CleanupRunHistory deviceId="dev-1" refreshToken={0} />);
    await waitFor(() => expect(signals.length).toBeGreaterThan(0));

    unmount();

    expect(signals.every((s) => s.aborted)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/filesystem/CleanupRunHistory.test.tsx
```

Expected failure: `Failed to load .../CleanupRunHistory.test.tsx` … `Cannot find module './CleanupRunHistory'`.

- [ ] **Step 3: Implement** — create `apps/web/src/components/devices/filesystem/CleanupRunHistory.tsx`:

```tsx
/**
 * Cleanup-run history for one device (spec §5.2, §8).
 *
 * Both kinds in one list — the file engine's runs and W04's system runs — in
 * the order they were requested. The list endpoint deliberately does not ship
 * `plan.preview.candidates` or `executedActions`, so this renders the counts
 * it returns; a future detail drawer reads the full row from
 * `GET /filesystem/cleanup-runs/:runId`.
 *
 * `refreshToken` restarts the walk. Appending a freshly executed run to an
 * existing page would place it below rows that are newer than it after a
 * concurrent cleanup, so the honest refresh is to re-walk from the top.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, History, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '@/lib/i18n/format';
import { fetchWithAuth } from '@/stores/auth';
import '@/lib/i18n';
import { formatBytes, formatDateTime } from './filesystemTabUtils';

const PAGE_LIMIT = 20;

export type CleanupRunListItem = {
  id: string;
  kind: string;
  status: string;
  scanPath: string | null;
  requestedAt: string;
  approvedAt: string | null;
  bytesReclaimed: number;
  error: string | null;
  candidateCount: number;
  estimatedBytes: number;
  actionCount: number;
};

const statusClasses: Record<string, string> = {
  previewed: 'bg-gray-500/15 text-gray-700 border-gray-500/30',
  running: 'bg-blue-500/15 text-blue-700 border-blue-500/30',
  executed: 'bg-green-500/15 text-green-700 border-green-500/30',
  failed: 'bg-red-500/15 text-red-700 border-red-500/30',
};

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

type Props = { deviceId: string; refreshToken: number };

export default function CleanupRunHistory({ deviceId, refreshToken }: Props) {
  const { t } = useTranslation('devices');
  const [runs, setRuns] = useState<CleanupRunListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const loadPage = useCallback(
    async (cursor: string | null, append: boolean) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      setLoading(true);
      setError(null);
      try {
        const query = cursor
          ? `?limit=${PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`
          : `?limit=${PAGE_LIMIT}`;
        const response = await fetchWithAuth(
          `/devices/${deviceId}/filesystem/cleanup-runs${query}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error(t('deviceFilesystemTab.historyFailed'));

        const body = await response.json();
        const page = (body?.data?.runs ?? []) as CleanupRunListItem[];
        if (controller.signal.aborted) return;
        setRuns((prev) => (append ? [...prev, ...page] : page));
        setNextCursor((body?.data?.nextCursor ?? null) as string | null);
      } catch (err) {
        if (isAbort(err) || controller.signal.aborted) return;
        setError(t('deviceFilesystemTab.historyFailed'));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [deviceId, t],
  );

  useEffect(() => {
    void loadPage(null, false);
    return () => {
      controllerRef.current?.abort();
    };
  }, [loadPage, refreshToken]);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs" data-testid="cleanup-run-history">
      <h4 className="flex items-center gap-2 font-semibold">
        <History className="h-4 w-4 text-muted-foreground" />
        {t('deviceFilesystemTab.historyTitle')}
      </h4>

      {error && (
        <div
          role="alert"
          data-testid="cleanup-run-history-error"
          className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            <span>{error}</span>
          </div>
        </div>
      )}

      {!error && runs.length === 0 && !loading && (
        <p className="mt-3 text-sm text-muted-foreground">{t('deviceFilesystemTab.historyEmpty')}</p>
      )}

      <div className="mt-3 space-y-2">
        {runs.map((run) => (
          <div
            key={run.id}
            data-testid={`cleanup-run-${run.id}`}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <div className="min-w-0">
              <p className="truncate font-medium">
                {run.kind === 'system'
                  ? t('deviceFilesystemTab.historyKindSystem')
                  : t('deviceFilesystemTab.historyKindFiles')}
                {run.scanPath ? ` · ${run.scanPath}` : ''}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatDateTime(run.requestedAt)} ·{' '}
                {t('deviceFilesystemTab.historyCandidates', { count: run.candidateCount })}
                {run.actionCount > 0 ? ` · ${formatNumber(run.actionCount)}` : ''}
              </p>
              {run.error && <p className="text-xs text-amber-700">{run.error}</p>}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t('deviceFilesystemTab.historyReclaimed', { size: formatBytes(run.bytesReclaimed) })}
              </span>
              <span
                className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${statusClasses[run.status] ?? 'bg-muted/30 text-muted-foreground border-muted'}`}
              >
                {/* i18n-dynamic: the status is a database enum label. */}
                {t(/* i18n-dynamic */ `deviceFilesystemTab.status.${run.status}`, {
                  defaultValue: run.status,
                })}
              </span>
            </div>
          </div>
        ))}
      </div>

      {nextCursor && !error && (
        <button
          type="button"
          data-testid="cleanup-run-history-more"
          onClick={() => { void loadPage(nextCursor, true); }}
          disabled={loading}
          className="mt-3 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
        >
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t('deviceFilesystemTab.historyLoadMore')}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/web && npx vitest run src/components/devices/filesystem/CleanupRunHistory.test.tsx
```

Expected: 7 tests PASS.

- [ ] **Step 5: Typecheck**

```bash
cd apps/web && pnpm exec astro check
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/devices/filesystem/CleanupRunHistory.tsx \
  apps/web/src/components/devices/filesystem/CleanupRunHistory.test.tsx
git commit -m "$(cat <<'EOF'
feat(devices): paginated cleanup-run history for both engines

Walks GET /filesystem/cleanup-runs newest-first, appending on Load more and
restarting from the top when the composer bumps refreshToken after an
execute. The page request rides an AbortController tied to unmount, and a
failed page renders a role="alert" banner rather than an empty list that
reads as "this device has never been cleaned".

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §5.2, §8

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: MOUNT — `DeviceFilesystemTab.tsx` becomes the composer

**This is the task the wave is judged on.** Past waves have shipped green components that were never wired into a page; the page-level test in Step 1 is what proves §8's layout actually renders for a real device.

**Files:**
- Modify (rewrite): `apps/web/src/components/devices/DeviceFilesystemTab.tsx` (all 958 lines; ends at roughly 220)
- Create (Test): `apps/web/src/components/devices/DeviceFilesystemTab.test.tsx`
- Modify: `apps/web/src/locales/*/devices.json` (8 files) — re-value `deviceFilesystemTab.scanRunning` only. **`be1DiskCleanupIntelligence` and `text` were already deleted by W01 Task 13** (alignment 18); if they are still present, W01 has not merged.
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (`TARGET_GLOBS`, count at `:693`) — `runActionAllowlist.ts` is **not** edited here; W01 removed the tab from the backlog (alignment 18)

**Interfaces:**
- Consumes (from W02, assumed merged, with these exact names):
  - `useFilesystemVolumes(deviceId: string)` from `./filesystem/useFilesystemVolumes` → `{ volumes: FilesystemVolume[]; loading: boolean; error?: string; reload: () => Promise<void> }`, where `FilesystemVolume` has at least `{ mountPoint: string; scanPath: string; usedPercent: number | null; freeGb: number | null; totalGb: number | null; isOsRoot: boolean }`. **The hook holds no selection** (alignment 18): the composer owns `selectedScanPath` state exactly as W02's Task 14 mount does, seeded from `osRootScanPath(osType)` and re-pointed by an effect when the volume list arrives.
  - `VolumePicker` (default export) from `./filesystem/VolumePicker`, props `{ volumes: FilesystemVolume[]; selectedScanPath: string; onSelect: (scanPath: string) => void; loading: boolean; error?: string }`.
  - `osRootScanPath(osType)` from `@breeze/shared` (W02 Task 1) — the initial selection before the volume list resolves.
  - `POST /devices/:id/filesystem/scan` accepts `path` (the selected `scanPath`) and answers `202 { data: { commandId } }`.
  - `POST /devices/:id/filesystem/cleanup-preview` accepts `{ path }` and answers `{ data: { cleanupRunId, snapshotId, scanPath, estimatedBytes, candidateCount, categories, candidates } }`.
  - **If either name differs when you get here, do not rename W02's export to match this plan — adapt the import and record it as an amendment in the PR body.**
- Consumes (this wave): `useFilesystemSnapshot` (Task 8), `useCommandPoll` (Task 9), `SnapshotPanels` (Task 10), `CleanupPanel` (Task 11), `CleanupRunHistory` (Task 12), `filesystemTabUtils` (Task 6).
- Produces: `export default function DeviceFilesystemTab({ deviceId, osType, onOpenFiles }: DeviceFilesystemTabProps)` — the same props `DeviceDetails.tsx:830-838` already passes, so no change is needed in `DeviceDetails.tsx`.

- [ ] **Step 1: Write the failing page-level test** — create `apps/web/src/components/devices/DeviceFilesystemTab.test.tsx`:

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));

import { fetchWithAuth } from '@/stores/auth';
import DeviceFilesystemTab from './DeviceFilesystemTab';

const fetchMock = vi.mocked(fetchWithAuth);

const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

/** A Windows device with two fixed volumes, one scanned snapshot and history. */
function windowsFixture(): void {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/filesystem/volumes')) {
      return Promise.resolve(json({ data: [
        { mountPoint: 'C:\\', scanPath: 'C:\\', fsType: 'NTFS', totalGb: 500, usedGb: 400, freeGb: 100, usedPercent: 80, isOsRoot: true, scanState: null, latestSnapshot: { id: 'snap-1', capturedAt: '2026-09-19T10:00:00.000Z', partial: false, cleanupEstimateBytes: 3072 } },
        { mountPoint: 'D:\\', scanPath: 'D:\\', fsType: 'NTFS', totalGb: 1000, usedGb: 200, freeGb: 800, usedPercent: 20, isOsRoot: false, scanState: null, latestSnapshot: null },
      ] }));
    }
    if (url.includes('/filesystem/cleanup-runs')) {
      return Promise.resolve(json({ success: true, data: { runs: [
        { id: 'r1', kind: 'files', status: 'executed', scanPath: 'C:\\', requestedAt: '2026-09-18T10:00:00.000Z', approvedAt: '2026-09-18T10:01:00.000Z', bytesReclaimed: 2048, error: null, candidateCount: 3, estimatedBytes: 4096, actionCount: 2 },
      ], nextCursor: null } }));
    }
    if (url.includes('/filesystem/cleanup-preview') && method === 'POST') {
      return Promise.resolve(json({ success: true, data: {
        cleanupRunId: RUN_ID, snapshotId: 'snap-1', scanPath: 'C:\\',
        estimatedBytes: 3072, candidateCount: 2,
        categories: [{ category: 'temp_files', count: 2, estimatedBytes: 3072 }],
        candidates: [
          { path: 'C:\\Windows\\Temp\\big', category: 'temp_files', sizeBytes: 2048 },
          { path: 'C:\\Windows\\Temp\\small', category: 'temp_files', sizeBytes: 1024 },
        ],
      } }));
    }
    if (url.includes('/filesystem?path=')) {
      return Promise.resolve(json({ data: {
        id: 'snap-1', capturedAt: '2026-09-19T10:00:00.000Z', trigger: 'on_demand',
        partial: false, scanPath: 'C:\\', scanMode: 'baseline',
        summary: { filesScanned: 1250, dirsScanned: 85, bytesScanned: 1024, maxDepthReached: 24, permissionDeniedCount: 0 },
        topLargestFiles: [{ path: 'C:\\big.iso', sizeBytes: 4096 }],
        topLargestDirectories: [{ path: 'C:\\Windows', sizeBytes: 8192 }],
        tempAccumulation: [{ category: 'temp_files', bytes: 3072 }],
        oldDownloads: [], unrotatedLogs: [], trashUsage: [], duplicateCandidates: [],
        cleanupCandidates: [{ path: 'C:\\Windows\\Temp\\big', sizeBytes: 2048 }], errors: [],
      } }));
    }
    if (url.includes('/commands?limit=')) {
      return Promise.resolve(json({ data: [] }));
    }
    return Promise.resolve(json({}, 404));
  });
}

describe('DeviceFilesystemTab (composition)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts the whole §8 layout for a Windows device: picker, panels, cleanup, history', async () => {
    windowsFixture();

    render(<DeviceFilesystemTab deviceId="dev-1" osType="windows" />);

    // Volume picker (W02) — both fixed volumes, OS root badged.
    expect(await screen.findByTestId('filesystem-volume-picker')).toBeInTheDocument();
    // Snapshot panels (Task 10).
    expect(await screen.findByTestId('filesystem-snapshot-panels')).toBeInTheDocument();
    expect(screen.getByTestId('filesystem-temp-accumulation')).toBeInTheDocument();
    // Cleanup panel (Task 11) — present, prompting for a preview.
    expect(screen.getByTestId('cleanup-panel')).toBeInTheDocument();
    expect(screen.getByText('Run Cleanup Preview to choose what to delete.')).toBeInTheDocument();
    // Run history (Task 12).
    expect(await screen.findByTestId('cleanup-run-r1')).toBeInTheDocument();
  });

  it('runs a preview and hands the pinned run to the cleanup panel', async () => {
    windowsFixture();

    render(<DeviceFilesystemTab deviceId="dev-1" osType="windows" />);
    await screen.findByTestId('filesystem-snapshot-panels');

    await userEvent.click(screen.getByTestId('filesystem-cleanup-preview'));

    // The candidate table replaced the "run a preview" prompt.
    const panel = await screen.findByTestId('cleanup-panel');
    expect(within(panel).getByTestId('cleanup-candidate-C:\\Windows\\Temp\\big')).toBeInTheDocument();

    const previewCall = fetchMock.mock.calls.find(([u]) => String(u).includes('cleanup-preview'));
    expect(previewCall).toBeDefined();
    // The preview is scoped to the SELECTED volume, not to a hardcoded C:\.
    expect(JSON.parse(String(previewCall![1]?.body))).toEqual({ path: 'C:\\' });
  });

  it('scopes the snapshot request to the volume the picker selected', async () => {
    windowsFixture();

    render(<DeviceFilesystemTab deviceId="dev-1" osType="windows" />);
    await screen.findByTestId('filesystem-snapshot-panels');

    await userEvent.click(screen.getByTestId('filesystem-volume-D:\\'));

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([u]) => String(u));
      expect(urls.some((u) => u.includes('/filesystem?path=D%3A%5C'))).toBe(true);
    });
  });

  it('shows a role=status banner while a scan is queued and a role=alert banner on failure', async () => {
    windowsFixture();
    render(<DeviceFilesystemTab deviceId="dev-1" osType="windows" />);
    await screen.findByTestId('filesystem-snapshot-panels');

    fetchMock.mockImplementationOnce(() => Promise.resolve(json({ success: false, error: 'agent offline' }, 500)));
    await userEvent.click(screen.getByTestId('filesystem-analyze'));

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('agent offline');
  });

  it('renders the empty state for a volume that has never been scanned', async () => {
    windowsFixture();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/filesystem/volumes')) {
        return Promise.resolve(json({ data: [
          { mountPoint: 'C:\\', scanPath: 'C:\\', fsType: 'NTFS', totalGb: 500, usedGb: 400, freeGb: 100, usedPercent: 80, isOsRoot: true, scanState: null, latestSnapshot: null },
        ] }));
      }
      if (url.includes('/filesystem/cleanup-runs')) {
        return Promise.resolve(json({ success: true, data: { runs: [], nextCursor: null } }));
      }
      if (url.includes('/filesystem?path=')) return Promise.resolve(json({ error: 'none' }, 404));
      if (url.includes('/commands?limit=')) return Promise.resolve(json({ data: [] }));
      return Promise.resolve(json({}, 404));
    });

    render(<DeviceFilesystemTab deviceId="dev-1" osType="windows" />);

    expect(await screen.findByTestId('filesystem-empty-state')).toBeInTheDocument();
    expect(screen.queryByTestId('filesystem-snapshot-panels')).not.toBeInTheDocument();
  });

  it('never renders the retired BE-1 heading', async () => {
    windowsFixture();
    render(<DeviceFilesystemTab deviceId="dev-1" osType="windows" />);
    await screen.findByTestId('filesystem-snapshot-panels');
    expect(screen.queryByText(/BE-1/)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Disk Cleanup' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/DeviceFilesystemTab.test.tsx
```

Expected failure: `Unable to find an element by: [data-testid="filesystem-volume-picker"]` — the tab is still the monolith and mounts none of the new components.

- [ ] **Step 3: Rewrite the tab as a composer** — replace the entire contents of `apps/web/src/components/devices/DeviceFilesystemTab.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, FolderOpen, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { osRootScanPath } from '@breeze/shared';
import { showToast } from '@/components/shared/Toast';
import { ActionError, runAction } from '@/lib/runAction';
import { fetchWithAuth } from '@/stores/auth';
import '../../lib/i18n';
import type { OSType } from './DeviceList';
import VolumePicker from './filesystem/VolumePicker';
import { useFilesystemVolumes } from './filesystem/useFilesystemVolumes';
import { useFilesystemSnapshot } from './filesystem/useFilesystemSnapshot';
import { useCommandPoll } from './filesystem/useCommandPoll';
import SnapshotPanels from './filesystem/SnapshotPanels';
import CleanupPanel from './filesystem/CleanupPanel';
import CleanupRunHistory from './filesystem/CleanupRunHistory';
import type { FilesystemCleanupPreview } from './filesystem/filesystemTabUtils';

/**
 * Disk Cleanup tab (spec §8).
 *
 * This file used to be 958 lines and stopped at a preview: the Execute that
 * finished the job lived in File Manager, re-derived its own candidates, and
 * posted no `cleanupRunId`. It is now a composer over `./filesystem/` —
 * volume picker (W02) → scan controls → snapshot panels → cleanup panel →
 * run history — and every piece is independently tested.
 */

type DeviceFilesystemTabProps = {
  deviceId: string;
  osType: OSType;
  onOpenFiles?: () => void;
};

const SCAN_TIMEOUT_SECONDS = 300;

export default function DeviceFilesystemTab({
  deviceId,
  osType,
  onOpenFiles,
}: DeviceFilesystemTabProps) {
  const { t } = useTranslation('devices');
  const volumes = useFilesystemVolumes(deviceId);
  // W02's hook is stateless about selection, so the composer owns it — the
  // same shape W02's own mount used before the split.
  const [selectedScanPath, setSelectedScanPath] = useState<string>(() => osRootScanPath(osType));
  useEffect(() => {
    if (volumes.volumes.length === 0) return;
    if (volumes.volumes.some((volume) => volume.scanPath === selectedScanPath)) return;
    const osVolume = volumes.volumes.find((volume) => volume.isOsRoot) ?? volumes.volumes[0]!;
    setSelectedScanPath(osVolume.scanPath);
  }, [volumes.volumes, selectedScanPath]);
  const selectedVolume = volumes.volumes.find((volume) => volume.scanPath === selectedScanPath) ?? null;
  const scanPath = selectedScanPath;
  const snapshotState = useFilesystemSnapshot(deviceId, scanPath);
  const scanPoll = useCommandPoll(deviceId);

  const [busy, setBusy] = useState<'scan' | 'preview' | 'refresh' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilesystemCleanupPreview | null>(null);
  const [historyToken, setHistoryToken] = useState(0);

  const runAnalyze = useCallback(async () => {
    if (!scanPath) return;
    setBusy('scan');
    setActionError(null);
    scanPoll.reset();
    try {
      const commandId = await runAction<string>({
        request: () => fetchWithAuth(`/devices/${deviceId}/filesystem/scan`, {
          method: 'POST',
          body: JSON.stringify({
            path: scanPath,
            maxDepth: 32,
            topFiles: 50,
            topDirs: 30,
            maxEntries: 10_000_000,
            workers: 6,
            timeoutSeconds: SCAN_TIMEOUT_SECONDS,
          }),
        }),
        errorFallback: t('deviceFilesystemTab.filesystemScanFailed'),
        parseSuccess: (body) => {
          const id = (body as { data?: { commandId?: unknown } })?.data?.commandId;
          if (typeof id !== 'string' || !id) throw new Error('missing commandId');
          return id;
        },
      });

      await scanPoll.poll(commandId, Math.max(120_000, (SCAN_TIMEOUT_SECONDS + 90) * 1000));
      setPreview(null);
      await snapshotState.reload({ silent: true });
      await volumes.reload();
      scanPoll.reset();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        const message = err instanceof Error ? err.message : t('deviceFilesystemTab.filesystemScanFailed');
        setActionError(message);
        showToast({ type: 'error', message });
      } else {
        setActionError(err.message);
      }
      scanPoll.reset();
    } finally {
      setBusy(null);
    }
  }, [deviceId, scanPath, scanPoll, snapshotState, t, volumes]);

  const runCleanupPreview = useCallback(async () => {
    if (!scanPath) return;
    setBusy('preview');
    setActionError(null);
    try {
      const data = await runAction<FilesystemCleanupPreview>({
        request: () => fetchWithAuth(`/devices/${deviceId}/filesystem/cleanup-preview`, {
          method: 'POST',
          body: JSON.stringify({ path: scanPath }),
        }),
        errorFallback: t('deviceFilesystemTab.cleanupPreviewFailed'),
        parseSuccess: (body) => (body as { data: FilesystemCleanupPreview }).data,
      });
      setPreview(data);
      setHistoryToken((value) => value + 1);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('deviceFilesystemTab.cleanupPreviewFailed') });
      }
      setActionError(
        err instanceof Error ? err.message : t('deviceFilesystemTab.cleanupPreviewFailed'),
      );
    } finally {
      setBusy(null);
    }
  }, [deviceId, scanPath, t]);

  const refresh = useCallback(async () => {
    setBusy('refresh');
    setActionError(null);
    try {
      await Promise.all([snapshotState.reload({ silent: true }), volumes.reload()]);
      setHistoryToken((value) => value + 1);
    } finally {
      setBusy(null);
    }
  }, [snapshotState, volumes]);

  const onExecuted = useCallback(() => {
    setPreview(null);
    setHistoryToken((value) => value + 1);
    void snapshotState.reload({ silent: true });
    void volumes.reload();
  }, [snapshotState, volumes]);

  const bannerError = actionError ?? snapshotState.error ?? volumes.error;

  return (
    <div className="space-y-6" data-testid="device-filesystem-tab">
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-lg font-semibold">{t('deviceFilesystemTab.title')}</h3>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="filesystem-analyze"
              onClick={() => { void runAnalyze(); }}
              disabled={busy !== null || !scanPath}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              {busy === 'scan' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {t('deviceFilesystemTab.analyzeNow')}
            </button>
            <button
              type="button"
              data-testid="filesystem-cleanup-preview"
              onClick={() => { void runCleanupPreview(); }}
              disabled={busy !== null || !snapshotState.snapshot}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              {busy === 'preview' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {t('deviceFilesystemTab.cleanupPreview')}
            </button>
            <button
              type="button"
              data-testid="filesystem-refresh"
              onClick={() => { void refresh(); }}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busy === 'refresh' ? 'animate-spin' : ''}`} />
              {t('deviceFilesystemTab.refresh')}
            </button>
            {onOpenFiles && (
              <button
                type="button"
                data-testid="filesystem-open-files"
                onClick={() => onOpenFiles()}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {t('deviceFilesystemTab.openFileManager')}
              </button>
            )}
          </div>
        </div>

        <div className="mt-4">
          <VolumePicker
            volumes={volumes.volumes}
            selectedScanPath={selectedScanPath}
            onSelect={setSelectedScanPath}
            loading={volumes.loading}
            error={volumes.error}
          />
        </div>

        {bannerError && (
          <div
            role="alert"
            className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              <span>{bannerError}</span>
            </div>
          </div>
        )}

        {scanPoll.status && (
          <div
            role="status"
            className="mt-4 rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-800"
          >
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>{t('deviceFilesystemTab.scanRunning', { status: scanPoll.status })}</span>
            </div>
          </div>
        )}

        {snapshotState.loading ? (
          <div className="mt-4 flex items-center justify-center py-8" data-testid="filesystem-loading">
            <div className="text-center">
              <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
              <p className="mt-3 text-sm text-muted-foreground">
                {t('deviceFilesystemTab.loadingDiskIntelligence')}
              </p>
            </div>
          </div>
        ) : snapshotState.snapshot ? (
          <div className="mt-4">
            <SnapshotPanels
              snapshot={snapshotState.snapshot}
              thresholdEvents={snapshotState.thresholdEvents}
            />
          </div>
        ) : (
          <div
            data-testid="filesystem-empty-state"
            className="mt-4 rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground"
          >
            {t('deviceFilesystemTab.noFilesystemSnapshotYetRunAnalyze')}
          </div>
        )}
      </div>

      <CleanupPanel
        deviceId={deviceId}
        volumeLabel={selectedVolume?.mountPoint ?? scanPath}
        preview={preview}
        onExecuted={onExecuted}
      />

      <CleanupRunHistory deviceId={deviceId} refreshToken={historyToken} />
    </div>
  );
}
```

- [ ] **Step 4: Re-value `scanRunning` and delete the two retired keys, in all 8 catalogs** — in each `apps/web/src/locales/<locale>/devices.json`, inside `deviceFilesystemTab`: DELETE the `be1DiskCleanupIntelligence` and `text` entries entirely, and replace the `scanRunning` value:

| File | New `scanRunning` value |
|---|---|
| `en/devices.json` | `"Scan running ({{status}})"` |
| `de-DE/devices.json` | `"Scan läuft ({{status}})"` |
| `es-419/devices.json` | `"Escaneo en curso ({{status}})"` |
| `fr-FR/devices.json` | `"Analyse en cours ({{status}})"` |
| `fr-CA/devices.json` | `"Analyse en cours ({{status}})"` |
| `it-IT/devices.json` | `"Scansione in corso ({{status}})"` |
| `pt-BR/devices.json` | `"Varredura em andamento ({{status}})"` |
| `tr-TR/devices.json` | `"Tarama çalışıyor ({{status}})"` |

Also update the two stale English strings the rewrite leaves pointing at retired jargon — `noFilesystemSnapshotYetRunAnalyze` still says "collect BE-1 data" in `en`. Replace its value in each catalog:

| File | New `noFilesystemSnapshotYetRunAnalyze` value |
|---|---|
| `en/devices.json` | `"No snapshot for this volume yet. Run Analyze Now to scan it."` |
| `de-DE/devices.json` | `"Noch kein Snapshot für diesen Datenträger. Führen Sie „Jetzt analysieren“ aus."` |
| `es-419/devices.json` | `"Aún no hay una instantánea de este volumen. Ejecute Analizar ahora para escanearlo."` |
| `fr-FR/devices.json` | `"Aucun instantané pour ce volume. Lancez Analysez maintenant pour l’analyser."` |
| `fr-CA/devices.json` | `"Aucun instantané pour ce volume. Lancez Analysez maintenant pour l’analyser."` |
| `it-IT/devices.json` | `"Nessuna istantanea per questo volume. Esegui Analizza ora per scansionarlo."` |
| `pt-BR/devices.json` | `"Ainda não há snapshot deste volume. Use Analisar agora para verificá-lo."` |
| `tr-TR/devices.json` | `"Bu birim için henüz anlık görüntü yok. Taramak için Şimdi Analiz Edin'i çalıştırın."` |

- [ ] **Step 5: Confirm the tab is already off the runAction migration backlog** — **W01 Task 12 Step 4 owns this removal** (alignment 18); do not repeat it. Verify and move on:

```bash
grep -n 'DeviceFilesystemTab' apps/web/src/lib/runActionAllowlist.ts
```

Expected: no output. If the line is still there, W01 has not merged — stop and rebase rather than removing it here, because W01 also bumps the count below.

- [ ] **Step 6: Guard the new mutating file** — the tab itself is already in `TARGET_GLOBS` (W01, count `146 → 147`). This wave adds only the panel that now owns the execute POST. In `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`, add to `TARGET_GLOBS` (immediately after the W01 `'src/components/devices/DeviceFilesystemTab.tsx',` entry):

```ts
  // Disk Cleanup v2 W03: cleanup-execute moved out of the tab into this panel.
  // Execute permanently deletes files on a customer machine — a silent failure
  // here reads as "the disk was cleaned" while nothing was freed, which is
  // exactly the class this guard exists for.
  'src/components/devices/filesystem/CleanupPanel.tsx',
```

and bump the count assertion at `:693` from `147` (W01's value) to `148`, appending to the comment block above it:

```ts
    // Disk Cleanup v2 W03 adds filesystem/CleanupPanel.tsx: 147 → 148.
```

- [ ] **Step 7: Run the page-level test, the guard and the i18n suites, and watch them pass**

```bash
cd apps/web && npx vitest run \
  src/components/devices/DeviceFilesystemTab.test.tsx \
  src/lib/__tests__/no-silent-mutations.test.ts \
  src/lib/i18n/localeParity.test.ts \
  src/lib/i18n/translationCoverage.test.ts \
  src/lib/i18n/keyUsage.test.ts \
  src/lib/i18n/extractionQuality.test.ts
```

Expected: the 6 composition tests PASS, `no silent mutations in targeted set` PASS with 148 files, and all four i18n guards PASS. A `keyUsage` failure naming `be1DiskCleanupIntelligence` means a call site survived the rewrite.

- [ ] **Step 8: Run every filesystem web suite together**

```bash
cd apps/web && npx vitest run src/components/devices/filesystem src/components/devices/DeviceFilesystemTab.test.tsx
```

Expected: all six files (`filesystemTabUtils`, `useFilesystemSnapshot`, `useCommandPoll`, `SnapshotPanels`, `CleanupPanel`, `CleanupRunHistory`) plus the tab PASS. Check the reported file count — a directory filter without a trailing slash is a substring match, so confirm it is 6 + 1 and not fewer.

- [ ] **Step 9: Typecheck**

```bash
cd apps/web && pnpm exec astro check
```

Expected: no errors. An error on `./filesystem/VolumePicker` or `useFilesystemVolumes` means W02 has not merged, or its export names differ — adapt the import (per the Interfaces note) rather than renaming W02's export.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/devices/DeviceFilesystemTab.tsx \
  apps/web/src/components/devices/DeviceFilesystemTab.test.tsx \
  apps/web/src/lib/__tests__/no-silent-mutations.test.ts \
  apps/web/src/locales/en/devices.json apps/web/src/locales/de-DE/devices.json \
  apps/web/src/locales/es-419/devices.json apps/web/src/locales/fr-CA/devices.json \
  apps/web/src/locales/fr-FR/devices.json apps/web/src/locales/it-IT/devices.json \
  apps/web/src/locales/pt-BR/devices.json apps/web/src/locales/tr-TR/devices.json
git commit -m "$(cat <<'EOF'
feat(devices): mount the finished Disk Cleanup tab

DeviceFilesystemTab.tsx goes from 958 lines to a composer: volume picker (W02)
-> scan controls -> snapshot panels -> cleanup panel -> run history. A
page-level test renders the whole layout against a two-volume Windows device
fixture, because a wave that ships green components nobody mounted has shipped
nothing.

Both remaining mutations go through runAction, so the tab leaves
RUN_ACTION_MIGRATION_BACKLOG and joins TARGET_GLOBS alongside CleanupPanel.
The BE-1 heading and the ">=" codemod key are gone from all 8 catalogs and
scanRunning is a single interpolated string instead of a dangling "(".

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §8, §2 defects 4 and 9

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: One concept, one home — File Manager keeps a link and nothing else

**Files:**
- Modify: `apps/web/src/components/remote/FileManager.tsx` — imports `:29-30` and `:48`; types `:80-140`; `cleanupCategoryLabels` `:163-168`; `normalizeHierarchyPath` / `isDescendantPath` / `collapseAncestorDirectories` `:207-268`; state `:306-312`, `:318`, `:324-327`; callbacks `:844-1031`; the snapshot effect `:1038-1040`; `selectedCleanupBytes` `:1061-1063`; the "Disk Intelligence" JSX block `:1249-1389`; the cleanup `ConfirmDialog` `:1725-1734`
- Create (Test): `apps/web/src/components/remote/FileManager.diskCleanupLink.test.tsx`
- Modify: `apps/web/src/locales/*/remote.json` (8 files) — `fileManager.disk` reduced to three keys

**Interfaces:**
- Consumes: `navigateTo` from `@/lib/navigation` (already used across the app for device links, e.g. `RemoteFilesPage.tsx:60`; `getSafeNext` preserves a fragment, so `/devices/:id#filesystem` survives).
- Produces: nothing new is exported. `FileManagerProps` is unchanged, so `RemoteFilesPage.tsx` and `RemoteToolsPage.tsx` need no edit.

- [ ] **Step 1: Write the failing test** — create `apps/web/src/components/remote/FileManager.diskCleanupLink.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigateToMock = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: navigateToMock }));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from '@/stores/auth';
import FileManager from './FileManager';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('FileManager disk-cleanup consolidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(json({ data: [] }));
  });

  it('navigates to the device\u2019s Disk Cleanup tab instead of running cleanup itself', async () => {
    render(<FileManager deviceId="dev-1" deviceHostname="host-1" initialPath="C:\\" />);

    await userEvent.click(await screen.findByTestId('file-manager-disk-cleanup'));

    expect(navigateToMock).toHaveBeenCalledWith('/devices/dev-1#filesystem');
  });

  it('no longer offers analyze, preview or execute here', async () => {
    render(<FileManager deviceId="dev-1" deviceHostname="host-1" initialPath="C:\\" />);
    await screen.findByTestId('file-manager-disk-cleanup');

    expect(screen.queryByText('Analyze')).not.toBeInTheDocument();
    expect(screen.queryByText('Preview Cleanup')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Execute/)).not.toBeInTheDocument();
  });

  it('never calls a filesystem scan, preview or execute endpoint', async () => {
    render(<FileManager deviceId="dev-1" deviceHostname="host-1" initialPath="C:\\" />);
    await screen.findByTestId('file-manager-disk-cleanup');

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    // The race the API's pinning exists to prevent came from THIS component
    // deriving its own candidates; it must not reach these routes at all now.
    expect(urls.some((u) => u.includes('/filesystem'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/remote/FileManager.diskCleanupLink.test.tsx
```

Expected failure: `Unable to find an element by: [data-testid="file-manager-disk-cleanup"]`, and (once that is fixed) the third case fails because `loadLatestFilesystemSnapshot` still calls `/devices/dev-1/filesystem` on mount.

- [ ] **Step 3: Delete the disk-cleanup engine from FileManager** — in `apps/web/src/components/remote/FileManager.tsx`, remove, in this order:

1. The type block `DiskAnalysisSummary` through `DeviceCommandDetail` (`:80-140`) — every one of these is only read by the code being removed. Keep `DriveInfo` (`:142-150`), which the drive bar still uses.
2. `cleanupCategoryLabels` (`:163-168`).
3. `normalizeHierarchyPath`, `isDescendantPath` and `collapseAncestorDirectories` (`:207-268`) — their only caller is `collapsedTopDirectories`. The canonical copies now live in `components/devices/filesystem/filesystemTabUtils.ts` with unit tests; this duplicate never had any.
4. The seven disk state hooks (`:306-312`), `showDiskIntel` (`:318`), `showCleanupConfirm` (`:318`'s neighbour at the `const [showCleanupConfirm, …]` line) and the `collapsedTopDirectories` memo (`:324-327`).
5. `loadLatestFilesystemSnapshot`, `pollScanCommand`, `runFilesystemScan`, `runCleanupPreview`, `toggleCleanupPath`, `executeCleanup` and `handleConfirmCleanup` (`:844-1031`).
6. The `useEffect(() => { loadLatestFilesystemSnapshot(); }, [loadLatestFilesystemSnapshot]);` block (`:1038-1040`).
7. `selectedCleanupBytes` (`:1061-1063`).
8. The whole `{/* Disk Intelligence */}` section (`:1249-1389`).
9. The cleanup `ConfirmDialog` (`:1725-1734`).
10. The now-unused imports: `ChevronDown` and `ChevronUp` from `lucide-react` (`:29-30`), `ConfirmDialog` (`:48`), and `useMemo` from the React import (`:1`) — `collapsedTopDirectories` was its only use. Keep `Sparkles` (the new button uses it), `CheckCircle` (`:1639`), `formatDate` (`:1550`) and `formatSize`.

- [ ] **Step 4: Add the link in its place** — where the "Disk Intelligence" section was (immediately after the activity-toggle row that ends at `:1248`), insert:

```tsx
      {/* Disk Cleanup lives on the device's own tab — one concept, one home.
          This component used to run its own scan/preview/execute against
          whatever snapshot was newest, with no pinned cleanup run, which is
          exactly the race the API's pinning exists to prevent. */}
      <div className="flex items-center justify-between gap-2 border-b bg-muted/20 px-4 py-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-primary">{t('fileManager.disk.title')}</p>
          <p className="truncate text-xs text-muted-foreground">{t('fileManager.disk.openHint')}</p>
        </div>
        <button
          type="button"
          data-testid="file-manager-disk-cleanup"
          onClick={() => { void navigateTo(`/devices/${deviceId}#filesystem`); }}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-muted"
        >
          <Sparkles className="h-4 w-4" />
          {t('fileManager.disk.openTab')}
        </button>
      </div>
```

and add the import next to the other `@/lib` imports:

```tsx
import { navigateTo } from '@/lib/navigation';
```

- [ ] **Step 5: Reduce `fileManager.disk` to three keys, in all 8 catalogs** — in each `apps/web/src/locales/<locale>/remote.json`, replace the whole `fileManager.disk` object (it currently holds 28 leaves, every one of which is now unreferenced — `grep -rn "fileManager\.disk" apps/web/src | grep -v /locales/` must return only the three below after this task):

| File | Replacement `disk` object |
|---|---|
| `en/remote.json` | `{ "title": "Disk Cleanup", "openTab": "Open Disk Cleanup", "openHint": "Scan, preview and reclaim disk space from this device's Disk Cleanup tab." }` |
| `de-DE/remote.json` | `{ "title": "Datenträgerbereinigung", "openTab": "Datenträgerbereinigung öffnen", "openHint": "Scannen, prüfen und Speicherplatz über den Tab „Datenträgerbereinigung“ dieses Geräts freigeben." }` |
| `es-419/remote.json` | `{ "title": "Limpieza de disco", "openTab": "Abrir limpieza de disco", "openHint": "Escanee, previsualice y recupere espacio en disco desde la pestaña Limpieza de disco de este dispositivo." }` |
| `fr-FR/remote.json` | `{ "title": "Nettoyage du disque", "openTab": "Ouvrir le nettoyage du disque", "openHint": "Analysez, prévisualisez et récupérez de l’espace disque depuis l’onglet Nettoyage du disque de cet appareil." }` |
| `fr-CA/remote.json` | `{ "title": "Nettoyage du disque", "openTab": "Ouvrir le nettoyage du disque", "openHint": "Analysez, prévisualisez et récupérez de l’espace disque depuis l’onglet Nettoyage du disque de cet appareil." }` |
| `it-IT/remote.json` | `{ "title": "Pulizia disco", "openTab": "Apri pulizia disco", "openHint": "Analizza, visualizza in anteprima e recupera spazio su disco dalla scheda Pulizia disco di questo dispositivo." }` |
| `pt-BR/remote.json` | `{ "title": "Limpeza de disco", "openTab": "Abrir limpeza de disco", "openHint": "Verifique, pré-visualize e recupere espaço em disco na aba Limpeza de disco deste dispositivo." }` |
| `tr-TR/remote.json` | `{ "title": "Disk Temizleme", "openTab": "Disk Temizleme'yi aç", "openHint": "Bu cihazın Disk Temizleme sekmesinden tarayın, önizleyin ve disk alanı geri kazanın." }` |

- [ ] **Step 6: Run the new test, the pre-existing FileManager suite and the i18n guards**

```bash
cd apps/web && npx vitest run \
  src/components/remote/FileManager.diskCleanupLink.test.tsx \
  src/components/remote/FileManager.test.tsx \
  src/lib/i18n/localeParity.test.ts \
  src/lib/i18n/keyUsage.test.ts \
  src/lib/i18n/translationCoverage.test.ts \
  src/lib/i18n/extractionQuality.test.ts
```

Expected: the 3 new cases PASS; `FileManager.test.tsx`'s 11 download/upload cases still PASS (they never touched the disk section); all four i18n guards PASS. A `keyUsage` failure naming a `fileManager.disk.*` key means a call site survived Step 3.

- [ ] **Step 7: Typecheck and lint**

```bash
cd apps/web && pnpm exec astro check && pnpm exec eslint src/components/remote/FileManager.tsx
```

Expected: no errors. `astro check` reporting an unused import means Step 3 item 10 was incomplete.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/remote/FileManager.tsx \
  apps/web/src/components/remote/FileManager.diskCleanupLink.test.tsx \
  apps/web/src/locales/en/remote.json apps/web/src/locales/de-DE/remote.json \
  apps/web/src/locales/es-419/remote.json apps/web/src/locales/fr-CA/remote.json \
  apps/web/src/locales/fr-FR/remote.json apps/web/src/locales/it-IT/remote.json \
  apps/web/src/locales/pt-BR/remote.json apps/web/src/locales/tr-TR/remote.json
git commit -m "$(cat <<'EOF'
refactor(remote): File Manager links to Disk Cleanup instead of duplicating it

The second disk-cleanup surface is gone: its scan, preview and execute
callbacks, its duplicated path/size helpers, its seven state hooks and its
confirm dialog are removed, and a single button navigates to
/devices/:id#filesystem. That execute was the one that re-derived candidates
from whatever snapshot was newest and posted no cleanupRunId.

fileManager.disk drops from 28 keys to 3 in all 8 catalogs.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §8, §2 defect 4

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Docs, the docs index, and the full verification sweep

**Files:**
- Modify: `apps/docs/src/content/docs/features/filesystem-analysis.mdx` — the "Viewing the Latest Snapshot" area (`:155-196`), "Execute Phase" (`:277-330`), the "API Reference" table (`:494-506`), and the two cleanup troubleshooting entries (`:534-553`); a new "Cleanup Run History" section after "Execute Phase"
- Modify: `apps/api/src/data/docsIndex.json` (regenerated, never hand-edited)

**Interfaces:**
- Consumes: the finished behaviour of Tasks 1, 3, 4 and 13.
- Produces: docs that describe the finished tab and the run-history/retention surface. The multi-volume rewrite of the scanning sections is W02's, and the native-catalog sections are W04/W05's — do not write them here.

- [ ] **Step 1: Write the failing check** — there is no test for prose, so the check is mechanical and runs first so you can see it fail:

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-green-meadow-232b && \
  grep -c 'cleanup-runs' apps/docs/src/content/docs/features/filesystem-analysis.mdx
```

Expected failure: `0` — the history endpoints are undocumented.

- [ ] **Step 2: Correct the Execute Phase** — in `apps/docs/src/content/docs/features/filesystem-analysis.mdx`, replace the request example and the field table under `### Execute Phase` (`:279-296`):

````markdown
After reviewing the preview, submit the id of the cleanup run you previewed together with the specific paths you want to delete. `cleanupRunId` is **required**: cleanup deletes only from the exact candidate set that run pinned, never from whatever snapshot happens to be newest.

```bash
POST /api/v1/devices/:deviceId/filesystem/cleanup-execute
Content-Type: application/json

{
  "cleanupRunId": "run-uuid-from-cleanup-preview",
  "paths": [
    "C:\\Users\\admin\\AppData\\Local\\Temp\\old_installer.exe",
    "C:\\Users\\admin\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache"
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cleanupRunId` | uuid | Yes | The run returned by `cleanup-preview`. Must still be in `previewed` status and belong to this device. |
| `paths` | array | Yes | Paths to delete. Must appear in the pinned run's candidate set. Min 1, max 200 entries. Max 4096 characters per path. |

The API claims the run before dispatching anything: the status moves `previewed → running` in a single conditional update, so a double-submitted Execute matches no row and answers `409 cleanup_run_not_previewable` instead of deleting the same paths twice. When the dispatch finishes, the same row is finalised to `executed` or `failed` — one cleanup is one row, from preview to result.

Paths that are not in the pinned set are reported in `rejectedPaths` and never dispatched. Per-path `status` is one of `completed`, `failed`, `skipped_locked`, `rejected` or `skipped_budget`.
````

- [ ] **Step 3: Add the run-history section** — insert immediately after the Execute Phase's closing text, before `## AI Integration` (`:332`):

````markdown
### Cleanup Run History

Every preview and every execution is recorded in `device_filesystem_cleanup_runs`, and the device's **Disk Cleanup** tab renders that history under the cleanup panel.

```bash
GET /api/v1/devices/:deviceId/filesystem/cleanup-runs?limit=20&cursor=<token>
```

| Field | Type | Description |
|-------|------|-------------|
| `limit` | number | Rows per page. Default 20, maximum 100. |
| `cursor` | string | The `nextCursor` from the previous page. A malformed cursor is rejected with `400 invalid_cursor` rather than silently restarting the walk. |

The list is ordered newest-first on `(requested_at, id)` and deliberately omits the two large JSON blobs: instead of the pinned candidate list and the per-path action list it returns `candidateCount`, `estimatedBytes` and `actionCount`. Fetch one run in full — including `plan` and `executedActions` — from:

```bash
GET /api/v1/devices/:deviceId/filesystem/cleanup-runs/:runId
```

#### Retention

A daily maintenance job keeps the table bounded:

| What | When | Effect |
|------|------|--------|
| Abandoned previews | `previewed` runs older than 7 days | The row is deleted. |
| Finished runs | `executed` / `failed` runs older than 90 days | Only `plan.preview.candidates` is removed; the summary, the status, the reclaimed bytes and `executedActions` stay. A `plan.preview.candidatesTrimmedAt` timestamp records when. |
| Interrupted runs | file runs left in `running` for over 24 hours | Marked `failed` with `error: "interrupted"` (an API process died between claiming the run and finalising it). |

Self-hosters can tune the windows with `FILESYSTEM_CLEANUP_PREVIEW_RETENTION_DAYS` (default 7, max 90) and `FILESYSTEM_CLEANUP_PLAN_RETENTION_DAYS` (default 90, max 365), and the batch bounds with `FILESYSTEM_CLEANUP_RETENTION_BATCH_SIZE` / `FILESYSTEM_CLEANUP_RETENTION_MAX_BATCHES`.
````

- [ ] **Step 4: Describe the finished tab** — in the "Viewing the Latest Snapshot" area, add after the JSON response block (`:194`):

````markdown
#### In the dashboard

The device's **Disk Cleanup** tab is the one place this feature lives. Top to bottom it shows the device's fixed volumes, the scan controls, the snapshot panels for the selected volume, the cleanup panel, and the run history.

The cleanup panel is where a cleanup is completed, not merely previewed: category cards carry per-category counts and byte totals with a select-all control, the candidate table is sorted largest-first with a checkbox per row, and **Delete selected** opens a confirmation naming the volume, the item count, the total bytes and the first ten paths. After it runs, the result panel reports reclaimed bytes and all five outcome counts — deleted, locked (skipped), rejected, not reached (time limit) and failures — with any failures listed in an amber panel rather than folded into a success message.

File Manager no longer runs disk cleanup. It carries an **Open Disk Cleanup** button that takes you to this tab.
````

- [ ] **Step 5: Extend the API reference table** — in the table at `:499-506`, add two rows after the `cleanup-execute` row:

```markdown
| `GET` | `/devices/:id/filesystem/cleanup-runs` | Paginated cleanup-run history (both engines) | `devices.read` |
| `GET` | `/devices/:id/filesystem/cleanup-runs/:runId` | One cleanup run in full, including its plan | `devices.read` |
```

- [ ] **Step 6: Fix the two stale troubleshooting entries** — replace the `### "No valid cleanup paths selected from latest previewable candidates" (400)` heading and body (`:534-543`) with:

````markdown
### `cleanup_run_not_previewable` (409)

The pinned cleanup run has already been executed, is currently running, or was claimed by another request. Run **Cleanup Preview** again to pin a fresh run — a run is single-use by design, so that a resubmitted form cannot delete the same paths twice.

### "No valid cleanup paths selected from the pinned cleanup run" (400)

Every path you submitted was outside the pinned run's candidate set. Paths outside the set are reported in `rejectedPaths` and never dispatched. Re-run the preview: the snapshot it pinned may have been superseded by a newer scan.
````

- [ ] **Step 7: Regenerate the docs index**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-green-meadow-232b && npx tsx scripts/build-docs-index.ts
```

Expected: `apps/api/src/data/docsIndex.json` changes — the `features/filesystem-analysis` entry gains the "Cleanup Run History", "Retention", "In the dashboard" and `cleanup_run_not_previewable` headings. Never hand-edit this file.

- [ ] **Step 8: Verify the docs build**

```bash
cd apps/docs && pnpm exec astro check && pnpm exec astro build
```

Expected: no errors. (This is what CI's `docs-check` job runs.)

- [ ] **Step 9: Run the full affected suites, both sides**

```bash
cd apps/api && npx vitest run src/routes/devices/filesystem.test.ts \
  src/services/filesystemCleanupRuns.test.ts \
  src/jobs/filesystemCleanupRunRetention.test.ts \
  src/services/workerRegistry.test.ts \
  src/services/workerRegistry.filesystemCleanupRunRetention.test.ts \
  src/services/retentionMetrics.test.ts \
  src/jobs/scheduleRegistry.contract.test.ts \
  src/jobs/workerReadinessManifest.test.ts \
  src/jobs/workerReadinessCoverage.test.ts
```

```bash
cd apps/web && npx vitest run src/components/devices/filesystem \
  src/components/devices/DeviceFilesystemTab.test.tsx \
  src/components/remote/FileManager.test.tsx \
  src/components/remote/FileManager.diskCleanupLink.test.tsx \
  src/lib/__tests__/no-silent-mutations.test.ts \
  src/lib/i18n
```

Expected: everything PASS. Check the reported file counts — vitest path filters are plain substrings, so `src/lib/i18n` pulls in the whole directory (that is intended here) while a trailing slash would silently skip sibling files.

- [ ] **Step 10: Run the full unit suites before the PR**

```bash
cd apps/api && npx vitest run
cd apps/web && npx vitest run
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
cd apps/web && pnpm exec astro check
```

Expected: green. This wave adds no migration and no schema, so `pnpm db:check-drift` needs no run for a change of its own — but run it once anyway to prove the claim, and expect "no drift".

- [ ] **Step 11: Commit**

```bash
git add apps/docs/src/content/docs/features/filesystem-analysis.mdx apps/api/src/data/docsIndex.json
git commit -m "$(cat <<'EOF'
docs(filesystem): the finished Disk Cleanup tab, run history and retention

Documents what W03 actually ships: cleanupRunId is required and single-use
(with the 409 that enforces it), the paginated cleanup-run history and its
detail endpoint, the daily retention windows and their env knobs, and the
tab layout now that File Manager only links to it. Docs index regenerated.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §5.2, §8, §11

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

### Spec coverage

| Spec requirement (W03's share) | Task |
|---|---|
| §2 defect 4 — tab has preview only; execute lives in File Manager without `cleanupRunId` | 1, 11, 13, 14 |
| §2 defect 4 — partial failure renders in a green box | 11 (amber failure list, five outcome counts) |
| §2 defect 10 — preview rows never pruned | 4, 5 |
| §2 defect 9 — poll survives unmount | 9 (and 8) |
| §2 defect 9 — bare `fetchWithAuth` on the allowlist backlog | 13 (backlog removal + `TARGET_GLOBS`) |
| §2 defect 9 — `t` missing from hook deps | 8, 9 |
| §2 defect 9 — no `role=alert` | 13 (error banner), 10 (partial-scan `role="status"`), 12 (history error) |
| §2 defect 9 — `BE-1:` ticket label in UI | 13 |
| §2 defect 9 — no tests | 6, 8, 9, 10, 11, 12, 13, 14 |
| §3 row W03 — no schema, no agent release | Global Constraints; no task touches `migrations/`, `db/schema/` or `agent/` |
| §5.2 — `cleanupRunId` becomes required | 1 |
| §5.2 — `GET /filesystem/cleanup-runs?limit=&cursor=` without the candidates blob | 2, 3 |
| §5.2 — `GET /filesystem/cleanup-runs/:runId` full row | 2, 3 |
| §5.2 — daily retention: 7-day previews, 90-day candidate trim, `withSystemDbAccessContext` | 4 |
| §5.2 — `upsertJobScheduler` | 4 (amendment 5 records that `warrantyWorker.ts` is not the template the spec names) |
| §8 — `filesystemTabUtils.ts` with unit tests | 6 |
| §8 — `useFilesystemSnapshot.ts` | 8 |
| §8 — `useCommandPoll.ts`; every poll owns an `AbortController` tied to unmount | 9 |
| §8 — `SnapshotPanels.tsx`; `tempAccumulation` now rendered | 10 |
| §8 — `CleanupPanel.tsx`: category checkboxes, size-sorted table, select-all-in-category | 11 |
| §8 — Execute → `ConfirmDialog variant="destructive"` listing volume/count/bytes/first 10 paths | 11 |
| §8 — result panel with `completed / skipped_locked / rejected / skipped_budget` and amber failures | 11 |
| §8 — `CleanupRunHistory.tsx` | 12 |
| §8 — `DeviceFilesystemTab.tsx` becomes the composer (MOUNT + page-level test) | 13 |
| §8 — every mutation via `runAction`; the tab leaves `runActionAllowlist.ts` | 13 |
| §8 — `key=` props use a stable id, not optional `path` | 10 (asserted), 11, 12 |
| §8 — `scanRunning` rebuilt as one interpolated key; `be1DiskCleanupIntelligence` and the `>=` key removed | 13 (amendments 14, 15) |
| §8 — all new strings in all 8 locales | 7, 9, 13, 14 |
| §8 — File Manager's disk section removed, replaced by a link to `/devices/:id#filesystem` | 14 |
| §11 web bullets — select → execute payload carries `cleanupRunId` and only checked paths; partial failure renders amber; `no-silent-mutations` passes | 11, 13 |
| §11 API bullets — required `cleanupRunId`; the history routes | 1, 3 |
| §11 docs — "finished tab" and run-history parts of `filesystem-analysis.mdx` | 15 |
| **Explicitly out of scope for W03** — VolumePicker / `useFilesystemVolumes` (W02), `SystemCleanupPanel.tsx` and the 409 agent-update banner (W04), AI-tool parity (W05), the multi-volume rewrite of the docs' scanning sections (W02/W05) | consumed, never authored |

### Placeholder scan

`grep -nE 'TBD|TODO|FIXME|\.\.\.$|similar to Task|add validation|handle edge cases|XXX' ` over the plan returns only:
- the frontmatter `tracking_issue: LanternOps/breeze#TBD-REGISTERED-AFTER-PLANS`, which the common brief mandates verbatim;
- `<parent#>` / `<subissue#>` in the Branch line, in the Global Constraints branch/`Closes` line, and in one source comment in Task 5 — which the brief names as the only allowed placeholder.

Every code step carries a complete code block; no step cross-references another task's code, and the two places where the same helper shape recurs (the drizzle mock chains in the API tests) are written out in full rather than referenced.

### Type-consistency check

- `CleanupExecuteResult.cleanupRunId` is `string`, not `string | null`: after Task 1 the route always answers with the pinned id it was given, so the nullable shape the old insert-based route returned is gone. `FilesystemCleanupPreview.cleanupRunId` stays `string | null` because `cleanup-preview` still reports a failed insert as `null`, and `CleanupPanel` disables Execute on that branch.
- `CleanupActionStatus` (web, `filesystemTabUtils.ts`) is exactly the five tokens §5.2 lists, and `CLEANUP_ACTION_STATUSES` is the single source both `summariseActionStatuses` and the result panel iterate — a sixth status added later fails the `summariseActionStatuses` test rather than silently vanishing from the UI.
- `CleanupRunListItem` is declared twice on purpose — `services/filesystemCleanupRuns.ts` (API) and `CleanupRunHistory.tsx` (web) — because there is no shared package on this path today; the field names and types are identical, and Task 12's first test pins the wire shape so a drift shows up as a red web test, not as `undefined` in a badge.
- `requestedAt`/`approvedAt` cross the wire as ISO strings (both `listCleanupRuns` and `getCleanupRun` map `Date → string` before returning), and the web side only ever passes them to `formatDateTime`, which accepts `string | undefined`.
- `bytesReclaimed` is a Drizzle `bigint({ mode: 'number' })`; both service functions re-wrap it in `Number(... ?? 0)` so a driver that hands back a string cannot turn `formatBytes` into `"-"`.
- The retention job's three statements are raw `sql` against literal identifiers, so the `'running'`/`'files'` tokens are strings rather than the Drizzle enum type — the enum is exercised through the route (Task 1), which is where a missing W02 label fails the typecheck loudly.
- `DeviceFilesystemTabProps` is unchanged (`deviceId`, `osType`, `onOpenFiles?`), so `DeviceDetails.tsx:830-838` compiles untouched; `FileManagerProps` is unchanged, so `RemoteFilesPage.tsx` and `RemoteToolsPage.tsx` compile untouched.
