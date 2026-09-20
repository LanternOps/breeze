---
tracking_issue: LanternOps/breeze#6326
---
# Disk Cleanup v2 W01: Correctness and Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Disk Cleanup actually free disk space and stop it proposing files it must never delete — a rooted rule table shared byte-for-byte between the Go agent and TypeScript replaces the floating-substring classifier, `file_delete` gains `permanent` / `cleanupGuard` / `contentsOnly` with symlink and lock safety, the API dispatches those flags with a bounded wall clock and an honest per-path status vocabulary, and the web tab stops leaking its poll loop and swallowing failures. No schema change, no new command type.

**Architecture:** One data file, two matchers. `packages/shared/src/utils/cleanupRules.json` is the source of truth for what may be cleaned; `agent/internal/remote/tools/cleanup_rules.json` is a byte-identical `go:embed`ded copy, and a test on each side fails on drift. A tiny component-glob matcher is implemented twice (Go + TS) against one shared fixture table, so the agent's scanner classifies with exactly the rules the API re-filters with at execute time and the agent re-checks under `cleanupGuard` before unlinking anything. Deletion itself is **handle-based**: the agent opens the matched rule's anchor directory with `os.OpenRoot` and works relative to that handle, so no component of the traversal can be swapped for a symlink or junction between preview and execute. The API's execute loop moves out of the route into `services/filesystemCleanupExecution.ts`, where it is testable with an injected dispatcher, gated on a minimum agent version, and bounded by `CLEANUP_EXECUTE_BUDGET_MS`.

**Tech Stack:** Go 1.26 (`agent/`, stdlib `embed`/`encoding/json`, `go test -race`); TypeScript (Hono API, Vitest); React 19 + Astro islands (`apps/web`, Vitest + jsdom); `@breeze/shared` (TS, Vitest, `resolveJsonModule`).

**Spec:** `docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md` — §2 defects 1, 2, 3, 5, 7, 9 and the execute-side half of 10; §3 row W01 and its mixed-version paragraph; §5.2 (execute payload flags, `rejectedPaths`, per-path status vocabulary, `CLEANUP_EXECUTE_BUDGET_MS`, unified response shape); §6.1 (rooted rule table as shared JSON + Go and TS matchers + shared fixtures + parity tests); §6.2 (`getTrashPaths(scanRoot)`, trash per volume); §6.3 (`file_delete` additions); §6.4 (accumulator fixes and the listed unit tests); §8 W01 items only; §9 the AI-lane empty-snapshot guard and the AI lane's execute path (defect 1's second call site) only — the tool's input schema stays W05; §10; §11 the Go/API/Web bullets belonging to W01; **§13 rows 1, 2 (W01 half), 3, 6, 9, 10, 11 and 13 (W01 half)** — the Codex `gpt-6-astra` xhigh quorum findings, which supersede the looser text in §3/§5.2/§6.1/§6.3 above them.

**Branch:** `feature/<parent#>-disk-cleanup-v2/wave-<subissue#>`

---

## Global Constraints

- **No schema change, no migration, no new command type.** Spec §3 row W01: "Schema: none". Nothing in this wave touches `apps/api/migrations/`, `apps/api/src/db/schema/`, `services/tenantCascade.ts`, `services/tenantExportPolicyRegistry.ts`, `routes/devices/core.ts` or `rls-coverage.integration.test.ts`. If a task appears to need a column, stop — it belongs to W02.
- **Old agents never receive a permanent cleanup delete.** Spec §13 row 3 withdraws §3's "cosmetic degradation" paragraph: an agent without `cleanupGuard` that is handed `permanent: true` performs an *unguarded* recursive permanent delete, which is strictly worse than today's trash-move. `cleanup-execute` (both lanes) therefore gates on `MIN_AGENT_VERSION_CLEANUP_GUARD` and answers `409 agent_update_required` to anything older. Payload keys are still additive (`heartbeat/handlers.go:379-381` hands `cmd.Payload` straight to `tools.DeleteFile`; `GetPayloadBool`, `tools/types.go:771-778`, defaults an absent key) — but no old agent is ever dispatched to.
- **`go test -race`.** Agent tests run `cd agent && go test -race ./internal/remote/tools/...`. New Go code must be `gofmt`-clean and errcheck-clean: `agent/.golangci.yml` enables the standard set (errcheck, govet, ineffassign, staticcheck, unused) with `--new-from-rev`, so every discarded error needs an explicit `_ =`.
- **Test files live alongside source.** `routes/devices/filesystem.ts` → `routes/devices/filesystem.test.ts`; `tools/filesystem_cleanup_rules.go` → `tools/filesystem_cleanup_rules_test.go`; `utils/cleanupRules.ts` → `utils/cleanupRules.test.ts`.
- **Test command form.** API `cd apps/api && npx vitest run <path>`; web `cd apps/web && npx vitest run <path>`; shared `cd packages/shared && npx vitest run <path>`; Go `cd agent && go test -race ./internal/<pkg>/...`. **Never** `pnpm --filter <pkg> test -- --run <path>` — pnpm forwards the literal `--`, vitest stops flag parsing there, and the whole suite runs in watch mode (CLAUDE.md "Two traps"). Vitest path filters are plain substrings, not globs: list sibling files explicitly.
- **Typecheck commands** (what CI's `typecheck` job runs, `.github/workflows/ci.yml:342-350`): `pnpm exec tsc --noEmit --project apps/api/tsconfig.json`, `pnpm --filter @breeze/shared typecheck`, and `cd apps/web && pnpm exec astro check`. `apps/api/tsconfig.json` has `"include": ["src/**/*"]`, so **test files are type-checked**.
- **Web mutations go through `runAction`.** `DeviceFilesystemTab.tsx` adopts it and leaves `RUN_ACTION_MIGRATION_BACKLOG` for `TARGET_GLOBS` in the same task, with the `no-silent-mutations.test.ts` count bumped 146 → 147.
- **i18n in all 8 locales.** `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/`. Every key added or removed is applied to all eight with a real translation, never English filler (`localeParity.test.ts`, `translationCoverage.test.ts`). A `t()` key that no locale defines fails `keyUsage.test.ts` ("every literal t() key resolves in en"), so a key removal and its call-site change land in ONE commit.
- **File-size guideline.** Keep files under ~500 lines where it helps. `routes/devices/filesystem.ts` is 471 lines today; the execute loop moves to `services/filesystemCleanupExecution.ts` rather than growing the route past the guideline.
- **`db:check-drift` is untouched** — no schema edit — but run `pnpm --filter @breeze/api db:check-drift` before the PR anyway if anything under `src/db/` was touched by accident.
- **Rigor is medium.** This wave ships to customer machines (agent code) and deletes files, so: red first on every task, typecheck, the affected suites, then the full `apps/api`, `apps/web`, `packages/shared` and `agent` unit suites before the PR. No RLS/integration contract suite is needed — W01 adds no table, no column and no cascade entry.
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. PR body contains `Closes #<subissue#>`. Run `get_feature_status` before starting and `start_wave` on the sub-issue.

**Why this task order.** The rule table is the contract every other task depends on, so it lands first as pure data plus two matchers with no caller (Tasks 1–2). Tasks 3–5 move the agent's scanner onto it and fix the accumulators; Tasks 6–7 harden `file_delete`, which is the only code that actually unlinks. Only then does the API start sending the new flags (Tasks 8–10) — dispatching `permanent: true` before `cleanupGuard` exists would be a window where the API permanently deletes with no agent-side re-check. Tasks 11–14 are the AI-lane fixes and the web fixes, each independently revertible. Task 11b comes after Task 10 because it consumes the same `runCleanupExecution` the route wires up there — defect 1 has two call sites and both are closed in this wave.

---

## File Structure

| Path | Responsibility |
|---|---|
| `packages/shared/src/utils/cleanupRules.json` | **Source of truth.** The v1 rule table and cleanup-denied roots (Task 1) |
| `packages/shared/src/fixtures/cleanupRules.fixtures.json` | Shared path → expected classification table, replayed by both matchers (Task 1) |
| `packages/shared/src/utils/cleanupRules.ts` (+ `.test.ts`) | TS matcher: `normalizeCleanupPath`, `matchCleanupRule`, `isCleanupDeniedRoot`, `classifyCleanupPath`, `toCleanupOs`, `CLEANUP_GUARD_REJECTED_PREFIX` (Task 1) |
| `packages/shared/src/utils/index.ts` | Re-export of the above (Task 1) |
| `agent/internal/remote/tools/cleanup_rules.json` | Byte-identical embedded copy of the shared table (Task 2) |
| `agent/internal/remote/tools/filesystem_cleanup_rules.go` (+ `_test.go`) | Go matcher + `go:embed` + the drift test (Task 2) |
| `agent/internal/remote/tools/filesystem_analysis.go` | Scanner wired to the rule table; computed `Safe`; `getTrashPaths(scanRoot)`; accumulator fixes (Tasks 3–5) |
| `agent/internal/remote/tools/filesystem_analysis_rules_test.go` | Scanner-level classification and trash tests (Tasks 3–4) |
| `agent/internal/remote/tools/filesystem_analysis_test.go` | Checkpoint JSON round-trip, duplicate cap, top-by-size eviction (Task 5) |
| `agent/internal/remote/tools/fileops.go` | `cleanupGuard`, `contentsOnly`, `bytesFreed`, `skippedLocked` (Tasks 6–7) |
| `agent/internal/remote/tools/fileops_link_unix.go` / `_windows.go` (+ `_windows_test.go`) | `isReparsePoint`, `isSharingViolation` (Task 6) |
| `agent/internal/remote/tools/fileops_cleanup_test.go` | Guard + contentsOnly tests (Tasks 6–7) |
| `agent/internal/remote/tools/fileops_delete_boundary_test.go` | `$Recycle.Bin` boundary cases (Task 6) |
| `apps/api/src/services/filesystemCleanupExecution.ts` (+ `.test.ts`) | Rule re-filter, dispatch payload, status mapping, budget (Tasks 8–9) |
| `apps/api/src/services/filesystemAnalysis.ts` | `readExecutedActions`, merged-summary passthrough (Task 9) |
| `apps/api/src/routes/devices/filesystem.ts` (+ `.test.ts`) | Wiring + unified response shape (Task 10) |
| `apps/api/src/services/aiToolsFilesystem.ts` | Empty-snapshot guard (Task 11) |
| `apps/api/src/services/aiToolsFilesystem.emptySnapshot.test.ts` | Its regression test (Task 11) |
| `apps/api/src/services/aiToolsFilesystem.executePermanent.test.ts` | AI-lane execute payload + shared screening (Task 11b) |
| `apps/api/src/services/commandResultHandlers.ts` (+ `.filesystem.test.ts`) | WebSocket-leg persistence for `filesystem_analysis` (Task 10b) |
| `agent/internal/remote/tools/fileops_link_windows_test.go` | Windows junction confinement + lock errnos (Tasks 6-7) |
| `apps/web/src/components/devices/DeviceFilesystemTab.tsx` (+ `.test.tsx`) | `runAction`, AbortController poll, `t` deps, ARIA roles, stable keys (Task 12) |
| `apps/web/src/lib/runActionAllowlist.ts`, `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` | Backlog → target-set move + count bump (Task 12) |
| `apps/web/src/locales/*/devices.json` (8 files) | `be1DiskCleanupIntelligence` and `text` removed, `title` added (Task 13) |
| `apps/web/src/components/remote/FileManager.tsx` (+ `FileManager.cleanup.test.tsx`) | Sends `cleanupRunId`; amber partial-failure panel (Task 14) |

---

## Plan amendments

Every spec claim this wave depends on was re-verified against the worktree on 2026-09-19 (branch `spec/disk-cleanup-v2`, base `e4525ea7e8`). Where the spec is wrong or under-specified, the correction is recorded here.

1. **`go:embed` cannot reach `packages/shared/`, so the rule table ships twice.** The agent is its own Go module (`agent/go.mod:1`, `module github.com/breeze-rmm/agent`) and `//go:embed` patterns may not contain `..` or leave the package directory. §6.1's "`packages/shared/src/utils/cleanupRules.json` is `go:embed`ded by the agent" is therefore not literally implementable. W01 ships the source of truth at `packages/shared/src/utils/cleanupRules.json` and a byte-identical copy at `agent/internal/remote/tools/cleanup_rules.json`, and proves parity **in both directions** by exact byte comparison: a Go test reads the shared file through a relative path (the precedent is `agent/internal/backup/exclude_contract_test.go:27`, which already reads `../../../packages/shared/src/fixtures/...`), and a `packages/shared` test reads the agent copy. Byte equality is strictly stronger than §6.1's SHA-256 comparison and needs no canonical-JSON agreement between Go and TypeScript — which is the real reason a hash would have been fragile here (`resolveJsonModule` hands TypeScript a parsed object, never the file bytes).

2. **`*` is a within-component wildcard, not only a whole component.** §6.1's prose says "`'*'` = exactly one component", but its own table writes `/tmp/systemd-private-*/**` and `**/*.nupkg`. The implemented grammar, stated once here and pinned by tests on both sides: a pattern component consumes **exactly one** path component, and inside that component `*` matches any (possibly empty) run of characters that contains no `/`. `**` is only meaningful as a whole component and matches **one or more** components — so `/tmp/**` matches `/tmp/a` and `/tmp/a/b` but never `/tmp` itself, which is what keeps a scanned directory from becoming a file candidate.

3. **`{a,b}` alternation is expanded before component splitting.** §6.1's alternatives cross component boundaries (`{google/chrome,microsoft/edge,…}`, `{ac/inetcache,ac/temp,tempstate}`), so a brace group cannot be treated as one component. Both matchers brace-expand each pattern into concrete patterns at load time (cartesian product across groups) and only then split on `/`. Nested braces are rejected by the loader with a test, rather than silently mis-parsed.

4. **Rule evaluation is first-match-wins with exclude-then-continue.** §6.1 routes `/home/*/.cache/pip/**` out of `browser_cache` with the annotation "(→ package_cache)". That only works if an *excluded* match falls through to later rules instead of ending the search. Rules are evaluated in array order; a rule whose pattern matches but whose `exclude` also matches is skipped and evaluation continues. The JSON therefore orders `browser_cache` before `package_cache` for both linux and darwin, and a fixture pins `/home/u/.cache/pip/http/x` → `package_cache`.

5. **Cleanup-denied roots are stored bare and matched equal-or-descendant.** §6.1 writes them as `/etc/**`, `<vol>/program files/**`, `/private/var/db/**`. Under amendment 2 (`**` ≥ 1 component) that denies `/private/var/db/x` but **not** `/private/var/db` itself, and `/private/var/db` is at depth 3, so `isRecursiveDeleteBoundary` does not catch it either. The JSON stores the roots without the `/**` suffix and the matcher denies a path that equals a root or is a descendant of one. Strictly wider than the spec, in the safe direction.

6. **`contentsOnly` is derived from the rule table server-side, not from a new candidate field.** §5.2 writes `"contentsOnly": <true for bin/trash roots>` without saying where the flag comes from. Since §5.2 already re-filters every candidate through the rule table at execute time, and the matched rule carries `granularity`, the API derives the flag from the match. No field is added to `FilesystemCleanupCandidate` (`tools/types.go:583-590`), which means a snapshot captured by an **old** agent still produces the correct flag. The rule's `granularity` is the single place the bin/trash semantics are written down.

7. **`rejectedPaths` covers rule rejections, not only plan misses.** §5.2 defines it as "paths not in the pinned plan". A path that IS in the plan but no longer matches the rule table — exactly what a stale pre-W01 snapshot full of Chrome `Bookmarks` rows produces — is equally undeletable, and the UI needs one list, not two. `rejectedPaths` is therefore **exactly the set of paths whose action status is `rejected`** — API-side plan misses, API-side rule rejections, and agent-side `cleanupGuard` refusals alike. Each also appears in `actions[]` with `status: 'rejected'` and a machine-readable `reason` of `not_in_plan` | `rule_rejected` | `denied_root` | `agent_guard`. One list, one rule, nothing silently dropped (defect 10).

8. **`executedActions` becomes `{ partial, budgetMs, actions }`.** §5.2 requires the run to be recorded "`executed` with `partial: true` in `executedActions`", but that column is a bare array today (`db/schema/filesystem.ts:51`, `jsonb('executed_actions').notNull().default([])`). Verified safe: `grep -rn executedActions apps/api/src apps/web/src packages` finds exactly two writers for this table — `routes/devices/filesystem.ts:436` and `services/aiToolsFilesystem.ts:358` — and no reader anywhere (every other hit belongs to the unrelated `ai_agent_runs.outcome.executedActions`). A tolerant reader `readExecutedActions()` accepts both the legacy array and the new envelope so W03's run history renders pre-W01 rows. No migration: `jsonb` holds either shape, and the column is already `excludedOpen` in `CORE_TENANT_EXPORT_POLICY` because it is jsonb.

9. **A guard rejection rides a pinned error prefix, because `rejected` cannot ride the status.** `CommandResult.status` is `'completed' | 'failed' | 'timeout'` (`services/commandQueue.ts:70-87`) and the agent's `NewErrorResult` (`tools/types.go:310-317`) sets `failed`. So `DeleteFile` fails the command with `cleanup guard rejected: <reason>` and the API maps that prefix to `status: 'rejected'`. The prefix is a shared constant (`CLEANUP_GUARD_REJECTED_PREFIX` in `packages/shared`, `cleanupGuardRejectedPrefix` in Go) pinned by a test on each side — the same string-prefix technique §5.3 already proposes for `unknown command type:`.

10. **A locked single file returns SUCCESS with `deleted: false`, not a failure.** §6.3 puts `skippedLocked` on the *result*, and a result body only exists on the success envelope: `NewSuccessResult` marshals `data` into `Stdout` (`tools/types.go:291-307`) while `NewErrorResult` carries only `Error`. So a sharing violation on the single-path branch returns `{ deleted: false, bytesFreed: 0, skippedLocked: [path] }` with status `completed`, and the API maps `bytesFreed === 0 && skippedLocked.length > 0` to `skipped_locked`. A non-lock failure still returns `NewErrorResult` → `failed`.

11. **`noFilesystemSnapshotYetRunAnalyze` also carries the `BE-1` label** — "…to collect BE-1 data", in all eight locales. §2 defect 9 names "`BE-1:` ticket label in UI" generically; the wave brief enumerates only `be1DiskCleanupIntelligence`. Both strings are the same defect in the same component, so both are fixed here rather than leaving one ticket id on screen.

12. **`getTrashPaths` must return errors.** §6.4 requires its `ReadDir` errors to reach `errors[]`, but today they are swallowed by `if entries, err := os.ReadDir(...); err == nil` at `filesystem_analysis.go:1169` and `:1185`. The signature becomes `getTrashPaths(scanRoot string) ([]string, []FilesystemScanError)`.

13. **`estimateDirectorySize` must take a permission counter.** §6.4 requires it to count permission errors into `permissionDeniedCount`, but today `if os.IsPermission(readErr) { continue }` (`filesystem_analysis.go:1224-1226`) drops the signal entirely. The signature gains a `permissionDenied *int64` parameter; the only caller (`:567`) runs on the main goroutine after `workers.Wait()`, so no lock is needed.

14. **Defect 1 has TWO call sites, and W01 fixes both.** §2 defect 1 cites only `routes/devices/filesystem.ts:400-405`, and §9 assigns AI-tool work to W05 — but `services/aiToolsFilesystem.ts:326-329` holds a second, independent copy of the same execute loop dispatching the same `{ path, recursive: true }`. Leaving it would mean that after W01 the tab frees disk space while "clean up this disk" in chat still moves every file to `~/.breeze-trash` on the same volume (and, on a non-OS volume, copy+removes it onto `C:\`) — the same defect, unfixed, on the lane a customer is most likely to reach. Task 11b therefore deletes that loop and routes the AI lane through the same `runCleanupExecution` the route uses, so the two cannot drift again. **Scope limit:** only the EXECUTION path is unified. The tool's input schema is untouched in W01 — no `path` property, no `cleanupRunId`, no 200-path cap — because those change the contract the model is prompted against, and §9 owns them in W05.

15. **`summary.duplicateTrackingTruncated` needs an API-side passthrough.** §6.4 adds the flag to the agent's summary, but `mergeFilesystemAnalysisPayload` (`services/filesystemAnalysis.ts:280-287`) rebuilds `summary` from exactly five named fields, so a merged (checkpoint-resumed) baseline would silently drop it. One OR-ed line is added there in Task 9.

16. **Spec line numbers: two corrections, the rest verified.** `fileops.go:645` (the `os.Stat` that follows links) is actually **`fileops.go:641`**; `filesystem_analysis.go:426` (`Safe: true` hardcoded) is actually **`:425`**, and the spec does not mention the **second** hardcoded `Safe: true` on the trash branch at **`:591`**, which this wave also makes computed. Verified exactly as stated: `filesystem_analysis.go:1164` (the hardcoded `C:\$Recycle.Bin`), `:1000-1025` (`classifyCleanupCategory`), `:1076-1094` / `:1121-1132` (the two accumulators), `fileops.go:605-606` (`recursive`/`permanent`), `fileops_delete_boundary.go:96-103` (the depth ≤ 1 refusal), `routes/devices/filesystem.ts:399-418` (the execute loop), `services/aiToolsFilesystem.ts:185-186` (the unguarded save), `routes/agents/helpers.ts:1607-1615` (the guarded save), `FileManager.tsx:1009-1012` (execute without `cleanupRunId`), `DeviceFilesystemTab.tsx:352-404` (poll), `:416` / `:470` (bare `fetchWithAuth` mutations), `:550` (`be1DiskCleanupIntelligence`), `:606-625` (the two banners with no ARIA role).

---

The eight amendments below apply **spec §13** — the Codex `gpt-6-astra` xhigh quorum, whose rows explicitly supersede the §3/§5.2/§6.1/§6.3 text this plan was first written against. Each was re-verified against the worktree on 2026-09-19.

17. **`cleanupGuard` deletes through a directory HANDLE, not a pathname (§13 row 1).** Lstat-then-Remove on a literal path does not confine anything: preview `~/.cache/sub/x`, replace `sub` with a symlink to `/etc` between preview and execute, and the leaf `Lstat` sees a perfectly ordinary file at `/etc/x`. Verified available: `agent/go.mod:3` is `go 1.26.6` and the toolchain here is `go1.27.0`, so `os.OpenRoot` (Go ≥ 1.24) and `(*os.Root).Lstat/Remove/RemoveAll/OpenRoot/Open` all exist (`go doc os.Root`). The agent opens the matched rule's **anchor** — the wildcard-free literal prefix of the matched pattern, mapped onto the concrete path (`/home/*/.cache/**` → `/home`; `<vol>/users/*/appdata/local/temp/**` → `C:\Users`) — and performs every subsequent operation relative to that `*os.Root`. `os.Root` refuses an absolute symlink and any relative symlink that escapes the root, at every component, in the runtime rather than in our code. A pattern with no literal prefix is refused outright (none exist today). The anchor's `filepath.EvalSymlinks` real path must also sit under the real path of the dispatched `volumeRoot`.

18. **Identity, type, age and freshness are re-checked at execute (§13 row 2, W01 half).** Pinning a path pins a *string*. W01 adds four live checks: the API sets `recursive` from the matched rule's granularity (`file` → `false`, `contents` → `true`), so a file-granularity candidate can never trigger a subtree delete if it has become a directory; the agent requires `Mode().IsRegular()` under `recursive: false` and `rejects` otherwise; the agent re-runs the rule table's min-age gate against the file's CURRENT mtime; and the API dispatches `previewedAt`, with the agent rejecting any target whose current mtime is newer than it (the file changed after the operator looked at it). `previewedAt` is the pinned run's `requestedAt`, or the snapshot's `capturedAt` on the unpinned fallback — which is why `getLatestFilesystemCleanupSnapshot` gains `capturedAt` and the pinned-run select gains `requestedAt`. **Deferred to W03 with the tab:** `CLEANUP_PREVIEW_TTL_HOURS = 24` (the 409 on a stale preview) and the confirm dialog's "current contents at execution" copy — both are surfaces W03 owns, and `previewedAt` is the mechanism they will use.

19. **`MIN_AGENT_VERSION_CLEANUP_GUARD` gates permanent mode; the mixed-version narrative is withdrawn (§13 row 3).** §3's paragraph reasoned about an old agent receiving `permanent: true` and called the result "cosmetic". It is not: an agent without `cleanupGuard` performs an unguarded recursive permanent delete of whatever path it is handed. Both lanes now refuse. The constant is `'0.115.0'` — the next release after v0.114.0 (shipped 2026-09-17/18) and therefore the release W01's agent changes land in. **If the wave ships in a different release, bump this constant and its test in the same PR**; the test exists to make that a deliberate edit. Fail-closed detail that matters: `compareAgentVersions` (`services/agentEditionCompat.ts:48-66`) returns **0** for an unparseable input, so a naive `compare(...) < 0` fails OPEN. The gate therefore parses with `parseComparableVersion` first, treats `null` as unsupported, and compares **core only** (`core.join('.')`), so `0.115.0-rc1` counts as supported.

20. **`file_delete` is already live-only — verified, and now pinned (§13 row 6).** The finding assumed `STANDARD_REVIEWED`'s 168-hour window. Verified otherwise: `CommandTypes.FILE_DELETE` is in the `LIVE` list (`services/commandOfflinePolicy.ts:94`), `LIVE` maps to the `live` TTL class (`:263`), and `defaultOfflinePolicy` turns `live` into `{ kind: 'reject' }` (`:286`) — an offline device gets `device_offline` immediately and **no row is queued at all**. No new TTL class is needed. W01 adds a contract test pinning that classification, because a future reclassification would silently make a permanent delete deliverable for a week. On cancellation: a `skipped_budget` path is never dispatched, so there is no command to cancel; a dispatched command that times out is already terminal on the `live` path (`executeCommand` waits synchronously with `timeoutMs: 30_000`). The action row carries `commandId` so a later wave can reconcile a late result.

21. **`filesystem_analysis` results delivered over WebSocket are never persisted — confirmed, and fixed here (§13 row 9).** Verified: `handleFilesystemAnalysisCommandResult` is called from exactly one place, `routes/agents/commands.ts:525` (the HTTP result route). The WebSocket leg dispatches only the `commandResultHandlers` registry (`routes/agentWs.ts:2310`), and `filesystem_analysis` is absent from it (`services/commandResultHandlers.ts:897-921`). So every scan whose result arrives over the socket — which is the normal path, since the scan is dispatched with `preferHeartbeat: false` — writes no snapshot. **Critical implementation detail:** the HTTP leg gates its registry dispatch on a SEPARATE allowlist, `REGISTRY_DISPATCHED_COMMAND_TYPES` (`routes/agents/commands.ts:89-103`). Registering the handler must NOT add `filesystem_analysis` there, or the HTTP leg would both dispatch the registry and run its direct call at `:525` and save every snapshot twice.

22. **Normalisation is per OS (§13 row 10).** Amendment 2's single normaliser lower-cased and converted `\`→`/` on every platform, which changes path identity on POSIX: `/TMP/x` would match `/tmp/**` (a different directory on Linux), and a file literally named `.cache\v` in `$HOME` would normalise to `.cache/v` and be treated as a descendant of `.cache`. The rule is now: **windows** folds case and converts separators; **darwin** folds case only and keeps backslashes as ordinary filename characters (default APFS is case-insensitive); **linux** does neither — exact match. Slash collapsing and trailing-separator stripping stay on all three. The shared fixture file carries a case for each.

23. **POSIX trash candidates are scoped to the scanned root (§13 row 11).** `trashPathsForRoot` enumerated `/Users/*/.Trash` and `/home/*/.local/share/Trash` regardless of what was scanned, so a `/data` scan proposed deleting the OS volume's trash. POSIX candidates are now emitted only when the trash directory's `filepath.EvalSymlinks` real path is the scanned root or under it. Windows was already per-volume (amendment/Task 4).

24. **`partial` joins the per-path status vocabulary, and `bytesFreed` is LOGICAL bytes (§13 row 13 W01 half, and the §13 closing note).** A `contentsOnly` delete that emptied most of a bin but failed on three children reported `completed` with positive bytes — indistinguishable from a clean run. Any failed child now yields `status: 'partial'`, `failedChildren` stays in the response, and `completed` means every child went. Separately: existing `file_delete` results carry no byte count at all (verified — `fileops.go:660-664` returns `{path, deleted, permanent}`), so `bytesFreed` is the agent's own `Lstat` sum and is labelled **logical bytes** in the Go comment, the TS type and the action row. The measured figure (a volume free-space delta) arrives with the native cleaners in W04.

---

## Tasks

### Task 1: The shared cleanup rule table and the TypeScript matcher

**Files:**
- Create: `packages/shared/src/utils/cleanupRules.json`
- Create: `packages/shared/src/fixtures/cleanupRules.fixtures.json`
- Create: `packages/shared/src/utils/cleanupRules.ts`
- Create: `packages/shared/src/utils/cleanupRules.test.ts` (Test)
- Modify: `packages/shared/src/utils/index.ts` (append one export line after `export * from './vulnerabilityManagement';`)

**Interfaces:**
- Consumes: nothing (the JSON is imported with `resolveJsonModule`, already enabled at `tsconfig.json:12`).
- Produces:
  ```ts
  export type CleanupCategory = 'temp_files' | 'browser_cache' | 'package_cache' | 'trash';
  export type CleanupGranularity = 'file' | 'contents';
  export type CleanupOs = 'windows' | 'darwin' | 'linux';
  export const CLEANUP_RULES_VERSION: number;
  export const CLEANUP_GUARD_REJECTED_PREFIX = 'cleanup guard rejected:';
  export interface CleanupRuleMatch { category: CleanupCategory; granularity: CleanupGranularity; minAgeHours: number; }
  export interface CleanupClassification { category: CleanupCategory | null; granularity: CleanupGranularity | null; safe: boolean; }
  export function toCleanupOs(value: unknown): CleanupOs | null;
  export function expandCleanupBraces(pattern: string): string[];
  export function normalizeCleanupPath(os: CleanupOs, path: string): string;
  export function splitCleanupComponents(normalized: string): string[];
  export function matchCleanupComponentGlob(pattern: string, name: string): boolean;
  export function matchCleanupComponents(pattern: readonly string[], path: readonly string[]): boolean;
  export function matchCleanupRule(os: CleanupOs, path: string): CleanupRuleMatch | null;
  export function isCleanupDeniedRoot(os: CleanupOs, path: string): boolean;
  export function classifyCleanupPath(
    os: CleanupOs,
    path: string,
    options?: { modifiedAt?: string | Date | null; now?: Date },
  ): CleanupClassification;
  ```

- [ ] **Step 1: Write the rule data** — create `packages/shared/src/utils/cleanupRules.json` (this is spec §6.1's v1 table verbatim, plus amendment 5's bare denied roots):

```json
{
  "version": 1,
  "rules": [
    {
      "category": "temp_files",
      "os": "windows",
      "patterns": ["<vol>/windows/temp/**", "<vol>/users/*/appdata/local/temp/**"],
      "exclude": [],
      "minAgeHours": 24,
      "granularity": "file"
    },
    {
      "category": "temp_files",
      "os": "darwin",
      "patterns": ["/tmp/**", "/private/tmp/**", "/private/var/tmp/**", "/private/var/folders/*/*/t/**"],
      "exclude": [],
      "minAgeHours": 24,
      "granularity": "file"
    },
    {
      "category": "temp_files",
      "os": "linux",
      "patterns": ["/tmp/**", "/var/tmp/**"],
      "exclude": ["/tmp/.x11-unix/**", "/tmp/.ice-unix/**", "/tmp/systemd-private-*/**"],
      "minAgeHours": 24,
      "granularity": "file"
    },
    {
      "category": "browser_cache",
      "os": "windows",
      "patterns": [
        "<vol>/users/*/appdata/local/{google/chrome,microsoft/edge,bravesoftware/brave-browser,chromium}/user data/*/{cache,code cache,gpucache,dawncache,graphitedawncache,shadercache}/**",
        "<vol>/users/*/appdata/local/{google/chrome,microsoft/edge,bravesoftware/brave-browser,chromium}/user data/*/service worker/{cachestorage,scriptcache}/**",
        "<vol>/users/*/appdata/local/mozilla/firefox/profiles/*/{cache2,startupcache,shader-cache}/**"
      ],
      "exclude": [],
      "minAgeHours": 0,
      "granularity": "file"
    },
    {
      "category": "browser_cache",
      "os": "darwin",
      "patterns": ["/users/*/library/caches/**", "/library/caches/**"],
      "exclude": [
        "/users/*/library/caches/homebrew/**",
        "/users/*/library/caches/com.apple.bird/**",
        "/users/*/library/caches/cloudkit/**",
        "/users/*/library/caches/com.apple.icloud*/**"
      ],
      "minAgeHours": 0,
      "granularity": "file"
    },
    {
      "category": "browser_cache",
      "os": "linux",
      "patterns": ["/home/*/.cache/**", "/root/.cache/**"],
      "exclude": ["/home/*/.cache/pip/**", "/root/.cache/pip/**"],
      "minAgeHours": 0,
      "granularity": "file"
    },
    {
      "category": "package_cache",
      "os": "linux",
      "patterns": [
        "/var/cache/apt/archives/**",
        "/var/cache/dnf/**",
        "/var/cache/yum/**",
        "/home/*/.cache/pip/**",
        "/root/.cache/pip/**",
        "/home/*/.npm/_cacache/**",
        "/root/.npm/_cacache/**"
      ],
      "exclude": ["/var/cache/apt/archives/lock", "/var/cache/apt/archives/partial/**"],
      "minAgeHours": 0,
      "granularity": "file"
    },
    {
      "category": "package_cache",
      "os": "darwin",
      "patterns": [
        "/users/*/library/caches/homebrew/**",
        "/users/*/.npm/_cacache/**",
        "/users/*/.cache/pip/**",
        "/users/*/.nuget/packages/**/*.nupkg"
      ],
      "exclude": [],
      "minAgeHours": 0,
      "granularity": "file"
    },
    {
      "category": "package_cache",
      "os": "windows",
      "patterns": [
        "<vol>/users/*/appdata/local/pip/cache/**",
        "<vol>/users/*/appdata/local/npm-cache/_cacache/**",
        "<vol>/programdata/chocolatey/cache/**",
        "<vol>/users/*/.nuget/packages/**/*.nupkg",
        "<vol>/users/*/appdata/local/packages/*/{ac/inetcache,ac/temp,tempstate}/**"
      ],
      "exclude": [],
      "minAgeHours": 0,
      "granularity": "file"
    },
    {
      "category": "trash",
      "os": "windows",
      "patterns": ["<vol>/$recycle.bin/*"],
      "exclude": [],
      "minAgeHours": 0,
      "granularity": "contents"
    },
    {
      "category": "trash",
      "os": "darwin",
      "patterns": ["/users/*/.trash"],
      "exclude": [],
      "minAgeHours": 0,
      "granularity": "contents"
    },
    {
      "category": "trash",
      "os": "linux",
      "patterns": ["/home/*/.local/share/trash", "/root/.local/share/trash"],
      "exclude": [],
      "minAgeHours": 0,
      "granularity": "contents"
    }
  ],
  "deniedRoots": [
    {
      "os": "windows",
      "roots": ["<vol>/windows/system32", "<vol>/windows/winsxs", "<vol>/program files", "<vol>/program files (x86)"]
    },
    {
      "os": "darwin",
      "roots": ["/system", "/usr", "/bin", "/sbin", "/etc", "/private/var/db", "/library/apple"]
    },
    {
      "os": "linux",
      "roots": ["/usr", "/bin", "/sbin", "/etc"]
    }
  ]
}
```

- [ ] **Step 2: Write the shared fixture table** — create `packages/shared/src/fixtures/cleanupRules.fixtures.json`. `category: null` means "no classification"; `ageHours` is how old the file is at classification time (the matchers subtract it from `now`):

```json
{
  "cases": [
    { "os": "windows", "path": "C:\\Windows\\Temp\\build.tmp", "ageHours": 48, "category": "temp_files", "granularity": "file", "note": "machine temp, past the 24h gate" },
    { "os": "windows", "path": "D:\\Windows\\Temp\\build.tmp", "ageHours": 48, "category": "temp_files", "granularity": "file", "note": "<vol> is any volume, not only C:" },
    { "os": "windows", "path": "C:\\Users\\alice\\AppData\\Local\\Temp\\nested\\x.dat", "ageHours": 48, "category": "temp_files", "granularity": "file", "note": "per-user temp" },
    { "os": "windows", "path": "C:\\Windows\\Temp\\build.tmp", "ageHours": 1, "category": null, "granularity": null, "note": "min-age gate: fresh temp is never a candidate" },
    { "os": "windows", "path": "C:\\Windows\\Temporary\\build.tmp", "ageHours": 48, "category": null, "granularity": null, "note": "component match, not prefix match" },
    { "os": "windows", "path": "D:\\opt\\app\\tmp\\build.tmp", "ageHours": 48, "category": null, "granularity": null, "note": "an app directory named tmp is not Windows temp" },

    { "os": "darwin", "path": "/tmp/build.tmp", "ageHours": 48, "category": "temp_files", "granularity": "file", "note": "" },
    { "os": "darwin", "path": "/private/var/folders/ab/cd12ef/T/scratch.dat", "ageHours": 48, "category": "temp_files", "granularity": "file", "note": "per-user darwin scratch; T lowercases to t" },
    { "os": "darwin", "path": "/tmp/build.tmp", "ageHours": 2, "category": null, "granularity": null, "note": "min-age gate" },
    { "os": "darwin", "path": "/Users/alice/tmp/build.tmp", "ageHours": 48, "category": null, "granularity": null, "note": "a home directory named tmp is not /tmp" },

    { "os": "linux", "path": "/tmp/build.tmp", "ageHours": 48, "category": "temp_files", "granularity": "file", "note": "" },
    { "os": "linux", "path": "/var/tmp/build.tmp", "ageHours": 48, "category": "temp_files", "granularity": "file", "note": "" },
    { "os": "linux", "path": "/tmp/.X11-unix/X0", "ageHours": 48, "category": null, "granularity": null, "note": "exclude: deleting this kills every X session" },
    { "os": "linux", "path": "/tmp/systemd-private-abc123-nginx/tmp/x", "ageHours": 48, "category": null, "granularity": null, "note": "exclude with a within-component wildcard" },
    { "os": "linux", "path": "/opt/app/tmp/build.log", "ageHours": 48, "category": null, "granularity": null, "note": "spec negative: /opt/<app>/tmp must not be in scope" },
    { "os": "linux", "path": "/TMP/build.tmp", "ageHours": 48, "category": null, "granularity": null, "note": "§13 row 10: linux is case-SENSITIVE; /TMP is a different directory" },
    { "os": "linux", "path": "/home/bob/.cache\\v", "ageHours": 48, "category": null, "granularity": null, "note": "§13 row 10: a backslash is an ordinary filename character on POSIX, not a separator" },
    { "os": "darwin", "path": "/Users/alice/.cache\\v", "ageHours": 1, "category": null, "granularity": null, "note": "§13 row 10: darwin folds case but keeps backslashes" },
    { "os": "windows", "path": "C:\\USERS\\X\\APPDATA\\LOCAL\\TEMP\\BUILD.TMP", "ageHours": 48, "category": "temp_files", "granularity": "file", "note": "§13 row 10: windows folds case AND separators" },

    { "os": "windows", "path": "C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache\\f_000001", "ageHours": 1, "category": "browser_cache", "granularity": "file", "note": "spec positive" },
    { "os": "windows", "path": "C:\\Users\\alice\\AppData\\Local\\Microsoft\\Edge\\User Data\\Profile 1\\Code Cache\\js\\x", "ageHours": 1, "category": "browser_cache", "granularity": "file", "note": "alternation spans two components" },
    { "os": "windows", "path": "C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Service Worker\\CacheStorage\\ab\\cd", "ageHours": 1, "category": "browser_cache", "granularity": "file", "note": "" },
    { "os": "windows", "path": "C:\\Users\\alice\\AppData\\Local\\Mozilla\\Firefox\\Profiles\\ab12.default\\cache2\\entries\\x", "ageHours": 1, "category": "browser_cache", "granularity": "file", "note": "" },
    { "os": "windows", "path": "C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Bookmarks", "ageHours": 1, "category": null, "granularity": null, "note": "defect 3: the bug this table exists to fix" },
    { "os": "windows", "path": "C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\History", "ageHours": 1, "category": null, "granularity": null, "note": "defect 3" },
    { "os": "windows", "path": "C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cookies", "ageHours": 1, "category": null, "granularity": null, "note": "defect 3" },
    { "os": "windows", "path": "C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data", "ageHours": 1, "category": null, "granularity": null, "note": "defect 3" },
    { "os": "windows", "path": "C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Extensions\\abc\\1.0\\manifest.json", "ageHours": 1, "category": null, "granularity": null, "note": "defect 3: installed extensions" },
    { "os": "windows", "path": "C:\\Users\\alice\\AppData\\Local\\Mozilla\\Firefox\\Profiles\\ab12.default\\places.sqlite", "ageHours": 1, "category": null, "granularity": null, "note": "defect 3: Firefox history/bookmarks" },

    { "os": "darwin", "path": "/Users/alice/Library/Caches/com.apple.Safari/WebKitCache/x", "ageHours": 1, "category": "browser_cache", "granularity": "file", "note": "" },
    { "os": "darwin", "path": "/Library/Caches/com.example.app/blob", "ageHours": 1, "category": "browser_cache", "granularity": "file", "note": "machine-scope cache" },
    { "os": "darwin", "path": "/System/Library/Caches/com.apple.kernelcaches/kernelcache", "ageHours": 1, "category": null, "granularity": null, "note": "spec negative: reachable on a SIP-off Mac under the old substring classifier" },
    { "os": "darwin", "path": "/Users/alice/Library/Caches/com.apple.bird/x", "ageHours": 1, "category": null, "granularity": null, "note": "exclude: iCloud sync state" },
    { "os": "darwin", "path": "/Users/alice/Library/Caches/CloudKit/x", "ageHours": 1, "category": null, "granularity": null, "note": "exclude" },
    { "os": "darwin", "path": "/Users/alice/Library/Caches/com.apple.iCloudHelper/x", "ageHours": 1, "category": null, "granularity": null, "note": "exclude with a trailing within-component wildcard" },
    { "os": "darwin", "path": "/Users/alice/Library/Caches/Homebrew/downloads/pkg.tar.gz", "ageHours": 1, "category": "package_cache", "granularity": "file", "note": "amendment 4: excluded from browser_cache, then claimed by package_cache" },

    { "os": "linux", "path": "/home/bob/.cache/mozilla/firefox/ab.default/cache2/entries/x", "ageHours": 1, "category": "browser_cache", "granularity": "file", "note": "" },
    { "os": "linux", "path": "/root/.cache/thumbnails/large/x.png", "ageHours": 1, "category": "browser_cache", "granularity": "file", "note": "" },
    { "os": "linux", "path": "/home/bob/.cache/pip/http/ab/cd/blob", "ageHours": 1, "category": "package_cache", "granularity": "file", "note": "amendment 4 fall-through" },
    { "os": "linux", "path": "/var/lib/postgres/.cache/x", "ageHours": 1, "category": null, "granularity": null, "note": "spec negative: /var/lib/*/.cache must not be in scope" },

    { "os": "linux", "path": "/var/cache/apt/archives/nginx_1.0_amd64.deb", "ageHours": 1, "category": "package_cache", "granularity": "file", "note": "" },
    { "os": "linux", "path": "/var/cache/apt/archives/lock", "ageHours": 1, "category": null, "granularity": null, "note": "exclude: a literal file, not a subtree" },
    { "os": "linux", "path": "/var/cache/apt/archives/partial/nginx.deb", "ageHours": 1, "category": null, "granularity": null, "note": "exclude: an in-flight download" },
    { "os": "linux", "path": "/var/cache/dnf/updates-abc/packages/nginx.rpm", "ageHours": 1, "category": "package_cache", "granularity": "file", "note": "" },
    { "os": "linux", "path": "/home/bob/.npm/_cacache/content-v2/sha512/ab/cd/blob", "ageHours": 1, "category": "package_cache", "granularity": "file", "note": "" },

    { "os": "darwin", "path": "/Users/alice/.npm/_cacache/index-v5/ab/cd/blob", "ageHours": 1, "category": "package_cache", "granularity": "file", "note": "" },
    { "os": "darwin", "path": "/Users/alice/.nuget/packages/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg", "ageHours": 1, "category": "package_cache", "granularity": "file", "note": "** in the middle plus a within-component suffix glob" },
    { "os": "darwin", "path": "/Users/alice/.nuget/packages/newtonsoft.json/13.0.3/lib/net6.0/Newtonsoft.Json.dll", "ageHours": 1, "category": null, "granularity": null, "note": "the extracted package is not the cached archive" },

    { "os": "windows", "path": "C:\\ProgramData\\chocolatey\\cache\\foo\\1.0\\foo.nupkg", "ageHours": 1, "category": "package_cache", "granularity": "file", "note": "" },
    { "os": "windows", "path": "C:\\Users\\alice\\AppData\\Local\\npm-cache\\_cacache\\content-v2\\blob", "ageHours": 1, "category": "package_cache", "granularity": "file", "note": "" },
    { "os": "windows", "path": "C:\\Users\\alice\\AppData\\Local\\Packages\\Microsoft.Store_8wekyb3d8bbwe\\AC\\INetCache\\ab\\x", "ageHours": 1, "category": "package_cache", "granularity": "file", "note": "only the UWP cache subtrees" },
    { "os": "windows", "path": "C:\\Users\\alice\\AppData\\Local\\Packages\\Microsoft.Store_8wekyb3d8bbwe\\LocalState\\db.sqlite", "ageHours": 1, "category": null, "granularity": null, "note": "defect 3: UWP LocalState is user data, not package cache" },

    { "os": "windows", "path": "D:\\$Recycle.Bin\\S-1-5-21-1234567890-1-1-1001", "ageHours": 1, "category": "trash", "granularity": "contents", "note": "defect 2: the per-SID bin on ANY volume" },
    { "os": "windows", "path": "D:\\$Recycle.Bin", "ageHours": 1, "category": null, "granularity": null, "note": "the bin root itself is never a candidate (depth-1 boundary refuses it anyway)" },
    { "os": "windows", "path": "D:\\$Recycle.Bin\\S-1-5-21-1\\$RABCDEF.txt", "ageHours": 1, "category": null, "granularity": null, "note": "individual bin entries are reached by contentsOnly, not listed separately" },
    { "os": "darwin", "path": "/Users/alice/.Trash", "ageHours": 1, "category": "trash", "granularity": "contents", "note": "" },
    { "os": "darwin", "path": "/Users/alice/.Trash/old.dmg", "ageHours": 1, "category": null, "granularity": null, "note": "" },
    { "os": "linux", "path": "/home/bob/.local/share/Trash", "ageHours": 1, "category": "trash", "granularity": "contents", "note": "" },
    { "os": "linux", "path": "/root/.local/share/Trash", "ageHours": 1, "category": "trash", "granularity": "contents", "note": "" },
    { "os": "linux", "path": "/home/bob/.local/share/Trash/files/x", "ageHours": 1, "category": null, "granularity": null, "note": "" }
  ],
  "deniedRoots": [
    { "os": "windows", "path": "C:\\Windows\\System32\\drivers\\etc\\hosts", "denied": true },
    { "os": "windows", "path": "C:\\Windows\\WinSxS\\amd64_x", "denied": true },
    { "os": "windows", "path": "C:\\Program Files\\App\\app.exe", "denied": true },
    { "os": "windows", "path": "C:\\Program Files (x86)\\App\\app.exe", "denied": true },
    { "os": "windows", "path": "C:\\Windows\\System32", "denied": true },
    { "os": "windows", "path": "C:\\Windows\\Temp\\build.tmp", "denied": false },
    { "os": "darwin", "path": "/System/Library/Caches/x", "denied": true },
    { "os": "darwin", "path": "/private/var/db", "denied": true },
    { "os": "darwin", "path": "/Library/Apple/System/x", "denied": true },
    { "os": "darwin", "path": "/usr/share/x", "denied": true },
    { "os": "darwin", "path": "/Users/alice/Library/Caches/x", "denied": false },
    { "os": "linux", "path": "/etc/passwd", "denied": true },
    { "os": "linux", "path": "/usr/lib/x", "denied": true },
    { "os": "linux", "path": "/tmp/build.tmp", "denied": false }
  ]
}
```

- [ ] **Step 3: Write the failing test** — create `packages/shared/src/utils/cleanupRules.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fixtures from '../fixtures/cleanupRules.fixtures.json';
import {
  CLEANUP_GUARD_REJECTED_PREFIX,
  CLEANUP_RULES_VERSION,
  classifyCleanupPath,
  expandCleanupBraces,
  isCleanupDeniedRoot,
  matchCleanupComponentGlob,
  matchCleanupComponents,
  matchCleanupRule,
  normalizeCleanupPath,
  splitCleanupComponents,
  toCleanupOs,
  type CleanupOs,
} from './cleanupRules';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHARED_RULES_PATH = join(__dirname, 'cleanupRules.json');
// Amendment 1: go:embed cannot leave the agent module, so the table ships twice
// and the two copies are compared byte-for-byte from BOTH sides.
const AGENT_RULES_PATH = join(
  __dirname,
  '../../../../agent/internal/remote/tools/cleanup_rules.json',
);

describe('cleanup rule table (spec §6.1)', () => {
  it('pins the grammar: * is a within-component wildcard, ** is one-or-more components', () => {
    expect(matchCleanupComponentGlob('*', 'anything')).toBe(true);
    expect(matchCleanupComponentGlob('systemd-private-*', 'systemd-private-abc')).toBe(true);
    expect(matchCleanupComponentGlob('systemd-private-*', 'systemd-public-abc')).toBe(false);
    expect(matchCleanupComponentGlob('*.nupkg', 'foo.1.0.nupkg')).toBe(true);
    expect(matchCleanupComponentGlob('*.nupkg', 'foo.dll')).toBe(false);
    expect(matchCleanupComponentGlob('cache', 'cache')).toBe(true);
    expect(matchCleanupComponentGlob('cache', 'cache2')).toBe(false);

    expect(matchCleanupComponents(['tmp', '**'], ['tmp', 'a'])).toBe(true);
    expect(matchCleanupComponents(['tmp', '**'], ['tmp', 'a', 'b', 'c'])).toBe(true);
    // ** consumes at least one component, so the directory itself never matches.
    expect(matchCleanupComponents(['tmp', '**'], ['tmp'])).toBe(false);
    expect(matchCleanupComponents(['a', '**', '*.nupkg'], ['a', 'b', 'c', 'x.nupkg'])).toBe(true);
    expect(matchCleanupComponents(['a', '**', '*.nupkg'], ['a', 'b', 'c', 'x.dll'])).toBe(false);
  });

  it('expands brace alternation across component boundaries before splitting', () => {
    expect(expandCleanupBraces('a/{b,c}/d').sort()).toEqual(['a/b/d', 'a/c/d']);
    expect(expandCleanupBraces('a/{b/c,d}/e').sort()).toEqual(['a/b/c/e', 'a/d/e']);
    expect(expandCleanupBraces('{a,b}/{c,d}').sort()).toEqual(['a/c', 'a/d', 'b/c', 'b/d']);
    expect(expandCleanupBraces('plain/path')).toEqual(['plain/path']);
  });

  it('normalizes Windows paths onto the <vol> anchor and POSIX paths as-is', () => {
    expect(normalizeCleanupPath('windows', 'C:\\Windows\\Temp\\A.TMP')).toBe('<vol>/windows/temp/a.tmp');
    expect(normalizeCleanupPath('windows', 'd:/Users//bob/')).toBe('<vol>/users/bob');
    expect(normalizeCleanupPath('windows', 'C:\\')).toBe('<vol>');
    expect(normalizeCleanupPath('darwin', '/')).toBe('/');
    // Per-OS normalisation (spec §13 row 10). Folding on POSIX changes identity.
    expect(normalizeCleanupPath('linux', '/TMP//a/')).toBe('/TMP/a');
    expect(normalizeCleanupPath('linux', '/tmp//a/')).toBe('/tmp/a');
    expect(normalizeCleanupPath('darwin', '/Users/Alice/Library/Caches')).toBe('/users/alice/library/caches');
    // darwin keeps a backslash as an ordinary filename character.
    expect(normalizeCleanupPath('darwin', '/Users/alice/.cache\\v')).toBe('/users/alice/.cache\\v');
    expect(splitCleanupComponents('<vol>/windows/temp')).toEqual(['<vol>', 'windows', 'temp']);
    expect(splitCleanupComponents('/tmp/a')).toEqual(['tmp', 'a']);
  });

  it('classifies every shared fixture case exactly as recorded', () => {
    expect(fixtures.cases.length).toBeGreaterThan(40);
    const now = new Date('2026-09-19T12:00:00Z');
    const failures: string[] = [];
    for (const c of fixtures.cases) {
      const modifiedAt = new Date(now.getTime() - c.ageHours * 3600_000);
      const got = classifyCleanupPath(c.os as CleanupOs, c.path, { modifiedAt, now });
      if (got.category !== c.category || got.granularity !== c.granularity) {
        failures.push(
          `${c.os} ${c.path}: expected ${c.category}/${c.granularity}, got ${got.category}/${got.granularity} (${c.note})`,
        );
      }
      expect(got.safe).toBe(c.category !== null);
    }
    expect(failures).toEqual([]);
  });

  it('applies the cleanup-denied roots from the shared fixture, root included', () => {
    expect(fixtures.deniedRoots.length).toBeGreaterThan(10);
    for (const c of fixtures.deniedRoots) {
      expect(`${c.os} ${c.path} -> ${isCleanupDeniedRoot(c.os as CleanupOs, c.path)}`).toBe(
        `${c.os} ${c.path} -> ${c.denied}`,
      );
    }
  });

  it('refuses a denied root even when a rule would otherwise match it', () => {
    // A hand-forged execute body aimed at a system directory that a sloppier
    // rule edit might one day make matchable. classify must still say no.
    expect(matchCleanupRule('linux', '/tmp/build.tmp')).not.toBeNull();
    expect(classifyCleanupPath('linux', '/etc/passwd').category).toBeNull();
    expect(classifyCleanupPath('windows', 'C:\\Windows\\System32\\config\\x').category).toBeNull();
  });

  it('maps device os_type values onto runtime.GOOS values', () => {
    expect(toCleanupOs('windows')).toBe('windows');
    expect(toCleanupOs('macos')).toBe('darwin');
    expect(toCleanupOs('darwin')).toBe('darwin');
    expect(toCleanupOs('linux')).toBe('linux');
    expect(toCleanupOs('freebsd')).toBeNull();
    expect(toCleanupOs(undefined)).toBeNull();
  });

  it('pins the guard rejection prefix the API parses', () => {
    expect(CLEANUP_GUARD_REJECTED_PREFIX).toBe('cleanup guard rejected:');
    expect(CLEANUP_RULES_VERSION).toBe(1);
  });

  it('is byte-identical to the copy the agent embeds', () => {
    const shared = readFileSync(SHARED_RULES_PATH);
    const agent = readFileSync(AGENT_RULES_PATH);
    expect(agent.equals(shared)).toBe(true);
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

```bash
cd packages/shared && npx vitest run src/utils/cleanupRules.test.ts
```

Expected failure: `Failed to load .../cleanupRules.test.ts` … `Cannot find module './cleanupRules'` (the matcher does not exist yet; the agent copy does not exist yet either, so the byte-parity case would also fail with `ENOENT`).

- [ ] **Step 5: Implement the matcher** — create `packages/shared/src/utils/cleanupRules.ts`:

```ts
/**
 * The disk-cleanup rule table (spec §6.1) and its matcher.
 *
 * `cleanupRules.json` is the SINGLE SOURCE OF TRUTH for what Breeze may delete
 * during a disk cleanup. The Go agent embeds a byte-identical copy
 * (agent/internal/remote/tools/cleanup_rules.json) and ports this matcher; a
 * test on each side fails if the two files or the two matchers drift.
 *
 * Why rooted component patterns and not the old `strings.Contains(p, "/tmp/")`:
 * a floating substring put `/System/Library/Caches`, `/opt/<app>/tmp` and every
 * Chrome `Bookmarks`/`History`/`Cookies` file in scope of a "safe" cleanup.
 *
 * GRAMMAR (pinned by cleanupRules.test.ts and its Go twin):
 *   - Patterns are lower-cased and '/'-separated. PATH normalisation is PER OS
 *     (spec §13 row 10): windows folds case AND converts '\\'→'/'; darwin folds
 *     case only and keeps backslashes as ordinary filename characters (default
 *     APFS is case-insensitive); linux does NEITHER. Folding on POSIX changes
 *     path identity — `/TMP/x` is not `/tmp/x` on Linux, and a file literally
 *     named `.cache\\v` is not inside `.cache`.
 *   - On Windows the drive specifier is replaced by the literal token `<vol>`,
 *     so a rule written once applies to every fixed volume (defect 2).
 *   - A pattern component consumes EXACTLY ONE path component. Inside it, `*`
 *     matches any (possibly empty) run of characters, never a '/'.
 *   - `**` is only meaningful as a whole component and matches ONE OR MORE
 *     components — `/tmp/**` never matches `/tmp` itself, so a scanned
 *     directory cannot become a file candidate.
 *   - `{a,b}` alternation is expanded into concrete patterns BEFORE splitting,
 *     because the spec's alternatives cross component boundaries.
 *   - Rules are evaluated in array order, first match wins. A rule whose
 *     pattern matches but whose `exclude` also matches is SKIPPED and
 *     evaluation CONTINUES, which is how `/home/*\/.cache/pip/**` leaves
 *     browser_cache and is claimed by package_cache.
 *   - `deniedRoots` are bare roots matched equal-or-descendant, and they veto
 *     a rule match outright.
 */
import rules from './cleanupRules.json';

export type CleanupCategory = 'temp_files' | 'browser_cache' | 'package_cache' | 'trash';
export type CleanupGranularity = 'file' | 'contents';
export type CleanupOs = 'windows' | 'darwin' | 'linux';

/**
 * The agent fails a `file_delete` with this prefix when `cleanupGuard` refuses
 * the target. `CommandResult.status` has no `rejected` member, so the API maps
 * this prefix onto the `rejected` per-path status (spec §5.2).
 */
export const CLEANUP_GUARD_REJECTED_PREFIX = 'cleanup guard rejected:';

export interface CleanupRuleMatch {
  category: CleanupCategory;
  granularity: CleanupGranularity;
  minAgeHours: number;
}

export interface CleanupClassification {
  category: CleanupCategory | null;
  granularity: CleanupGranularity | null;
  safe: boolean;
}

interface RuleSpec {
  category: string;
  os: string;
  patterns: string[];
  exclude: string[];
  minAgeHours: number;
  granularity: string;
}

interface CompiledRule {
  category: CleanupCategory;
  granularity: CleanupGranularity;
  minAgeHours: number;
  patterns: string[][];
  exclude: string[][];
}

export const CLEANUP_RULES_VERSION: number = rules.version;

export function expandCleanupBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open < 0) return [pattern];
  const close = pattern.indexOf('}', open);
  if (close < 0) return [pattern];
  const group = pattern.slice(open + 1, close);
  if (group.includes('{')) {
    throw new Error(`nested brace alternation is not supported: ${pattern}`);
  }
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const out: string[] = [];
  for (const alt of group.split(',')) {
    out.push(...expandCleanupBraces(`${prefix}${alt}${suffix}`));
  }
  return out;
}

export function splitCleanupComponents(normalized: string): string[] {
  return normalized.split('/').filter((part) => part.length > 0);
}

function compilePatterns(patterns: string[]): string[][] {
  return patterns.flatMap((p) => expandCleanupBraces(p)).map(splitCleanupComponents);
}

const COMPILED: CompiledRule[] = (rules.rules as RuleSpec[]).map((r) => ({
  category: r.category as CleanupCategory,
  granularity: r.granularity as CleanupGranularity,
  minAgeHours: r.minAgeHours,
  patterns: compilePatterns(r.patterns),
  exclude: compilePatterns(r.exclude),
}));

const COMPILED_BY_OS = new Map<CleanupOs, CompiledRule[]>();
(rules.rules as RuleSpec[]).forEach((spec, index) => {
  const os = spec.os as CleanupOs;
  const bucket = COMPILED_BY_OS.get(os) ?? [];
  const compiled = COMPILED[index];
  if (compiled) bucket.push(compiled);
  COMPILED_BY_OS.set(os, bucket);
});

const DENIED_BY_OS = new Map<CleanupOs, string[]>(
  (rules.deniedRoots as Array<{ os: string; roots: string[] }>).map((entry) => [
    entry.os as CleanupOs,
    entry.roots,
  ]),
);

export function toCleanupOs(value: unknown): CleanupOs | null {
  if (value === 'windows') return 'windows';
  if (value === 'darwin' || value === 'macos') return 'darwin';
  if (value === 'linux') return 'linux';
  return null;
}

export function normalizeCleanupPath(os: CleanupOs, path: string): string {
  // Per OS (spec §13 row 10). Separator conversion and case folding are BOTH
  // Windows-only behaviours; darwin folds case only; linux is exact. Slash
  // collapsing and trailing-separator stripping are safe everywhere.
  let n = path.trim();
  if (os === 'windows') n = n.replace(/\\/g, '/');
  while (n.includes('//')) n = n.replaceAll('//', '/');
  if (os !== 'linux') n = n.toLowerCase();
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  if (os === 'windows' && n.length >= 2 && n[1] === ':' && /^[a-z]$/.test(n[0] ?? '')) {
    n = `<vol>${n.slice(2)}`;
  }
  return n;
}

export function matchCleanupComponentGlob(pattern: string, name: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === name;
  const parts = pattern.split('*');
  const head = parts[0] ?? '';
  if (!name.startsWith(head)) return false;
  let rest = name.slice(head.length);
  for (let i = 1; i < parts.length - 1; i += 1) {
    const needle = parts[i] ?? '';
    const at = rest.indexOf(needle);
    if (at < 0) return false;
    rest = rest.slice(at + needle.length);
  }
  return rest.endsWith(parts[parts.length - 1] ?? '');
}

export function matchCleanupComponents(
  pattern: readonly string[],
  path: readonly string[],
): boolean {
  if (pattern.length === 0) return path.length === 0;
  const head = pattern[0] ?? '';
  if (head === '**') {
    // One or more, never zero: see the GRAMMAR note above.
    for (let consume = 1; consume <= path.length; consume += 1) {
      if (matchCleanupComponents(pattern.slice(1), path.slice(consume))) return true;
    }
    return false;
  }
  if (path.length === 0) return false;
  if (!matchCleanupComponentGlob(head, path[0] ?? '')) return false;
  return matchCleanupComponents(pattern.slice(1), path.slice(1));
}

export function matchCleanupRule(os: CleanupOs, path: string): CleanupRuleMatch | null {
  const components = splitCleanupComponents(normalizeCleanupPath(os, path));
  for (const rule of COMPILED_BY_OS.get(os) ?? []) {
    if (!rule.patterns.some((p) => matchCleanupComponents(p, components))) continue;
    if (rule.exclude.some((e) => matchCleanupComponents(e, components))) continue;
    return {
      category: rule.category,
      granularity: rule.granularity,
      minAgeHours: rule.minAgeHours,
    };
  }
  return null;
}

export function isCleanupDeniedRoot(os: CleanupOs, path: string): boolean {
  const normalized = normalizeCleanupPath(os, path);
  for (const root of DENIED_BY_OS.get(os) ?? []) {
    if (normalized === root || normalized.startsWith(`${root}/`)) return true;
  }
  return false;
}

export function classifyCleanupPath(
  os: CleanupOs,
  path: string,
  options: { modifiedAt?: string | Date | null; now?: Date } = {},
): CleanupClassification {
  const none: CleanupClassification = { category: null, granularity: null, safe: false };
  if (isCleanupDeniedRoot(os, path)) return none;
  const match = matchCleanupRule(os, path);
  if (!match) return none;
  if (match.minAgeHours > 0) {
    const modifiedAt = options.modifiedAt
      ? new Date(options.modifiedAt)
      : null;
    // An unknown mtime cannot clear an age gate. Failing closed here is what
    // makes a pre-W01 snapshot (whose temp rows carry no usable modifiedAt)
    // rejected at execute rather than deleted on a guess.
    if (!modifiedAt || Number.isNaN(modifiedAt.getTime())) return none;
    const now = options.now ?? new Date();
    const ageHours = (now.getTime() - modifiedAt.getTime()) / 3600_000;
    if (ageHours < match.minAgeHours) return none;
  }
  return { category: match.category, granularity: match.granularity, safe: true };
}
```

- [ ] **Step 6: Export it** — append to `packages/shared/src/utils/index.ts`, after `export * from './vulnerabilityManagement';`:

```ts
export * from './cleanupRules';
```

Check for a name collision first (the barrel is a flat `export *`, so a duplicate export name is a compile error, not a silent shadow):

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-green-meadow-232b && grep -rn "CleanupCategory\|CleanupOs\|classifyCleanupPath\|normalizeCleanupPath" packages/shared/src --include=*.ts | grep -v cleanupRules
```

Expected: no output.

- [ ] **Step 7: Run the test again (the byte-parity case is still expected to fail)**

```bash
cd packages/shared && npx vitest run src/utils/cleanupRules.test.ts
```

Expected: every case passes except `is byte-identical to the copy the agent embeds`, which fails with `ENOENT: no such file or directory, open '.../agent/internal/remote/tools/cleanup_rules.json'`. That file is created in Task 2 — do NOT weaken this assertion to make the task green.

- [ ] **Step 8: Typecheck**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-green-meadow-232b && pnpm --filter @breeze/shared typecheck
```

Expected: clean exit.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/utils/cleanupRules.json packages/shared/src/utils/cleanupRules.ts packages/shared/src/utils/cleanupRules.test.ts packages/shared/src/fixtures/cleanupRules.fixtures.json packages/shared/src/utils/index.ts
git commit -m "$(cat <<'EOF'
feat(shared): rooted cleanup rule table + TS matcher (disk cleanup v2 W01)

The disk-cleanup classifier was a floating substring match, so
/System/Library/Caches, /opt/<app>/tmp and every Chrome Bookmarks/History/
Cookies file were "safe" cleanup candidates. This lands the rule data and the
TypeScript half of the matcher; the Go half and the embedded copy follow.

Grammar: rooted, lower-cased, '/'-separated component patterns; '*' is a
within-component wildcard, '**' is one-or-more components, '{a,b}' is expanded
before splitting; first match wins with exclude-then-continue; deniedRoots veto.

The agent-copy byte-parity assertion is intentionally red until the next commit.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §6.1

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The Go matcher, the embedded copy, and the drift test

**Files:**
- Create: `agent/internal/remote/tools/cleanup_rules.json` (byte-identical copy of the shared table)
- Create: `agent/internal/remote/tools/filesystem_cleanup_rules.go`
- Create: `agent/internal/remote/tools/filesystem_cleanup_rules_test.go` (Test)

**Interfaces:**
- Consumes: `packages/shared/src/utils/cleanupRules.json` (copied, not imported — amendment 1), `packages/shared/src/fixtures/cleanupRules.fixtures.json` (read by the test only).
- Produces (package-private to `tools`, plus the one exported constant the API pins):
  ```go
  const CleanupGuardRejectedPrefix = "cleanup guard rejected:"
  func normalizeCleanupPathFor(goos, path string) string
  func splitCleanupComponents(normalized string) []string
  func matchCleanupComponentGlob(pattern, name string) bool
  func matchCleanupComponents(pattern, path []string) bool
  func matchCleanupRuleFor(goos, path string) *cleanupRuleMatch   // nil when nothing matches
  func cleanupRuleAnchorFor(goos, path string) (string, bool)      // the os.OpenRoot confinement anchor
  func concreteAnchor(goos, path string, n int) (string, bool)
  func literalPrefixLen(pattern []string) int
  func matchCleanupRule(path string) *cleanupRuleMatch            // runtime.GOOS
  func isCleanupDeniedRootFor(goos, path string) bool
  func isCleanupDeniedRoot(path string) bool                      // runtime.GOOS
  func classifyCleanupPathFor(goos, path string, modTime, now time.Time) (category, granularity string, safe bool)
  func classifyCleanupPath(path string, modTime, now time.Time) (category, granularity string, safe bool)
  type cleanupRuleMatch struct { Category, Granularity string; MinAge time.Duration }
  ```

- [ ] **Step 1: Copy the rule data into the agent module**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-green-meadow-232b && cp packages/shared/src/utils/cleanupRules.json agent/internal/remote/tools/cleanup_rules.json && cmp packages/shared/src/utils/cleanupRules.json agent/internal/remote/tools/cleanup_rules.json && echo IDENTICAL
```

Expected: `IDENTICAL`.

- [ ] **Step 2: Write the failing test** — create `agent/internal/remote/tools/filesystem_cleanup_rules_test.go`:

```go
package tools

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Cross-language contract for the disk-cleanup rule table (spec §6.1).
//
// packages/shared/src/utils/cleanupRules.json is the source of truth. go:embed
// cannot leave this module, so cleanup_rules.json here is a COPY and the test
// below compares the two byte-for-byte. Do not "fix" a drift failure by editing
// the copy alone — edit the shared file and re-copy, so the API, the web UI and
// the agent keep agreeing about what may be deleted.
//
// The classification fixtures are the same file the TypeScript matcher replays
// (packages/shared/src/utils/cleanupRules.test.ts). If the two matchers drift,
// one of the two suites goes red.

const (
	sharedCleanupRulesPath    = "../../../../packages/shared/src/utils/cleanupRules.json"
	sharedCleanupFixturePath  = "../../../../packages/shared/src/fixtures/cleanupRules.fixtures.json"
)

type cleanupFixtureCase struct {
	OS          string  `json:"os"`
	Path        string  `json:"path"`
	AgeHours    float64 `json:"ageHours"`
	Category    *string `json:"category"`
	Granularity *string `json:"granularity"`
	Note        string  `json:"note"`
}

type cleanupDeniedFixtureCase struct {
	OS     string `json:"os"`
	Path   string `json:"path"`
	Denied bool   `json:"denied"`
}

type cleanupFixtureFile struct {
	Cases       []cleanupFixtureCase       `json:"cases"`
	DeniedRoots []cleanupDeniedFixtureCase `json:"deniedRoots"`
}

func loadCleanupFixtures(t *testing.T) cleanupFixtureFile {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(sharedCleanupFixturePath))
	if err != nil {
		t.Fatalf("read shared cleanup fixtures: %v\n"+
			"This test is the agent half of a cross-language contract; the fixtures live in packages/shared.", err)
	}
	var fx cleanupFixtureFile
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("parse shared cleanup fixtures: %v", err)
	}
	if len(fx.Cases) < 40 || len(fx.DeniedRoots) < 10 {
		t.Fatalf("cleanup fixture table is too small (cases=%d deniedRoots=%d) — a vacuous contract test is worse than none",
			len(fx.Cases), len(fx.DeniedRoots))
	}
	return fx
}

func TestEmbeddedCleanupRulesMatchSharedSource(t *testing.T) {
	shared, err := os.ReadFile(filepath.FromSlash(sharedCleanupRulesPath))
	if err != nil {
		t.Fatalf("read shared cleanup rules: %v", err)
	}
	if !bytes.Equal(shared, cleanupRulesJSON) {
		t.Fatalf("embedded cleanup_rules.json has drifted from packages/shared/src/utils/cleanupRules.json\n"+
			"fix: cp packages/shared/src/utils/cleanupRules.json agent/internal/remote/tools/cleanup_rules.json")
	}
}

func TestCleanupComponentGlobGrammar(t *testing.T) {
	cases := []struct {
		pattern string
		name    string
		want    bool
	}{
		{"*", "anything", true},
		{"systemd-private-*", "systemd-private-abc", true},
		{"systemd-private-*", "systemd-public-abc", false},
		{"*.nupkg", "foo.1.0.nupkg", true},
		{"*.nupkg", "foo.dll", false},
		{"cache", "cache", true},
		{"cache", "cache2", false},
		{"com.apple.icloud*", "com.apple.iclouddrive", true},
	}
	for _, c := range cases {
		if got := matchCleanupComponentGlob(c.pattern, c.name); got != c.want {
			t.Errorf("matchCleanupComponentGlob(%q, %q) = %v, want %v", c.pattern, c.name, got, c.want)
		}
	}
}

func TestCleanupComponentsDoubleStarConsumesAtLeastOne(t *testing.T) {
	if !matchCleanupComponents([]string{"tmp", "**"}, []string{"tmp", "a"}) {
		t.Error("/tmp/** should match /tmp/a")
	}
	if !matchCleanupComponents([]string{"tmp", "**"}, []string{"tmp", "a", "b", "c"}) {
		t.Error("/tmp/** should match a deep descendant")
	}
	if matchCleanupComponents([]string{"tmp", "**"}, []string{"tmp"}) {
		t.Error("/tmp/** must NOT match /tmp itself — a scanned directory is not a file candidate")
	}
	if !matchCleanupComponents([]string{"a", "**", "*.nupkg"}, []string{"a", "b", "c", "x.nupkg"}) {
		t.Error("** in the middle followed by a suffix glob should match")
	}
	if matchCleanupComponents([]string{"a", "**", "*.nupkg"}, []string{"a", "b", "c", "x.dll"}) {
		t.Error("suffix glob should not match a different extension")
	}
}

func TestNormalizeCleanupPathAnchorsWindowsVolume(t *testing.T) {
	cases := []struct{ goos, in, want string }{
		{"windows", `C:\Windows\Temp\A.TMP`, "<vol>/windows/temp/a.tmp"},
		{"windows", `d:/Users//bob/`, "<vol>/users/bob"},
		{"windows", `C:\`, "<vol>"},
		{"darwin", "/", "/"},
		// Per-OS normalisation (spec §13 row 10).
		{"linux", "/TMP//a/", "/TMP/a"},
		{"linux", "/tmp//a/", "/tmp/a"},
		{"darwin", "/Users/Alice/Library/Caches", "/users/alice/library/caches"},
		{"darwin", `/Users/alice/.cache\v`, `/users/alice/.cache\v`},
	}
	for _, c := range cases {
		if got := normalizeCleanupPathFor(c.goos, c.in); got != c.want {
			t.Errorf("normalizeCleanupPathFor(%q, %q) = %q, want %q", c.goos, c.in, got, c.want)
		}
	}
}

func TestClassifyCleanupPathMatchesSharedFixtures(t *testing.T) {
	fx := loadCleanupFixtures(t)
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	for _, c := range fx.Cases {
		modTime := now.Add(-time.Duration(c.AgeHours * float64(time.Hour)))
		category, granularity, safe := classifyCleanupPathFor(c.OS, c.Path, modTime, now)
		wantCategory, wantGranularity := "", ""
		if c.Category != nil {
			wantCategory = *c.Category
		}
		if c.Granularity != nil {
			wantGranularity = *c.Granularity
		}
		if category != wantCategory || granularity != wantGranularity {
			t.Errorf("%s %s: got %q/%q, want %q/%q (%s)",
				c.OS, c.Path, category, granularity, wantCategory, wantGranularity, c.Note)
		}
		if safe != (wantCategory != "") {
			t.Errorf("%s %s: safe = %v, want %v", c.OS, c.Path, safe, wantCategory != "")
		}
	}
}

func TestIsCleanupDeniedRootMatchesSharedFixtures(t *testing.T) {
	fx := loadCleanupFixtures(t)
	for _, c := range fx.DeniedRoots {
		if got := isCleanupDeniedRootFor(c.OS, c.Path); got != c.Denied {
			t.Errorf("isCleanupDeniedRootFor(%q, %q) = %v, want %v", c.OS, c.Path, got, c.Denied)
		}
	}
}

func TestDeniedRootVetoesAMatchingRule(t *testing.T) {
	if matchCleanupRuleFor("linux", "/tmp/build.tmp") == nil {
		t.Fatal("precondition: /tmp/build.tmp must match a rule")
	}
	if category, _, _ := classifyCleanupPathFor("linux", "/etc/passwd", time.Time{}, time.Now()); category != "" {
		t.Errorf("/etc/passwd classified as %q; denied roots must veto", category)
	}
	if category, _, _ := classifyCleanupPathFor("windows", `C:\Windows\System32\config\x`, time.Time{}, time.Now()); category != "" {
		t.Errorf("System32 classified as %q; denied roots must veto", category)
	}
}

func TestCleanupRuleAnchorIsTheLiteralPrefix(t *testing.T) {
	// The anchor is what os.OpenRoot is called on, so it must be the part of
	// the path the RULE AUTHOR fixed, never a component an attacker can create.
	cases := []struct {
		goos, path, want string
		ok               bool
	}{
		{"linux", "/home/bob/.cache/sub/x", "/home", true},
		{"linux", "/var/cache/apt/archives/nginx.deb", "/var/cache/apt/archives", true},
		{"darwin", "/Users/alice/Library/Caches/com.example/x", "/Users", true},
		{"windows", `C:\Users\alice\AppData\Local\Temp\x`, `C:\Users`, true},
		{"windows", `D:\$Recycle.Bin\S-1-5-21-1`, `D:\`, true},
		{"linux", "/home/bob/Documents/taxes.pdf", "", false},
	}
	for _, c := range cases {
		got, ok := cleanupRuleAnchorFor(c.goos, c.path)
		if ok != c.ok || (c.ok && got != c.want) {
			t.Errorf("cleanupRuleAnchorFor(%q, %q) = %q,%v; want %q,%v", c.goos, c.path, got, ok, c.want, c.ok)
		}
	}
}

func TestCleanupGuardRejectedPrefixIsPinned(t *testing.T) {
	// The API string-matches this prefix to map a failed command onto the
	// `rejected` per-path status (spec §5.2). Changing it here without changing
	// packages/shared/src/utils/cleanupRules.ts turns every guard rejection into
	// an opaque `failed`.
	if CleanupGuardRejectedPrefix != "cleanup guard rejected:" {
		t.Fatalf("guard prefix drifted: %q", CleanupGuardRejectedPrefix)
	}
}
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd agent && go test -race ./internal/remote/tools/... -run 'Cleanup' 2>&1 | head -30
```

Expected failure: the package does not compile — `undefined: cleanupRulesJSON`, `undefined: matchCleanupComponentGlob`, `undefined: normalizeCleanupPathFor`, `undefined: classifyCleanupPathFor`, `undefined: isCleanupDeniedRootFor`, `undefined: matchCleanupRuleFor`, `undefined: CleanupGuardRejectedPrefix`.

- [ ] **Step 4: Implement** — create `agent/internal/remote/tools/filesystem_cleanup_rules.go`:

```go
package tools

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"time"
)

// cleanup_rules.json is a byte-identical COPY of
// packages/shared/src/utils/cleanupRules.json. go:embed patterns may not
// contain ".." or leave the package directory, and this module's root is
// agent/, so the shared file cannot be embedded directly. The copy is enforced
// by TestEmbeddedCleanupRulesMatchSharedSource (and by the mirror assertion in
// packages/shared/src/utils/cleanupRules.test.ts).
//
//go:embed cleanup_rules.json
var cleanupRulesJSON []byte

// CleanupGuardRejectedPrefix marks a file_delete refused by the cleanupGuard.
// CommandResult.Status has no `rejected` member, so the refusal rides the error
// string and the API maps this prefix onto the `rejected` per-path status
// (spec §5.2). Mirrored by CLEANUP_GUARD_REJECTED_PREFIX in packages/shared.
const CleanupGuardRejectedPrefix = "cleanup guard rejected:"

type cleanupRuleSpec struct {
	Category    string   `json:"category"`
	OS          string   `json:"os"`
	Patterns    []string `json:"patterns"`
	Exclude     []string `json:"exclude"`
	MinAgeHours int      `json:"minAgeHours"`
	Granularity string   `json:"granularity"`
}

type cleanupDeniedRootSpec struct {
	OS    string   `json:"os"`
	Roots []string `json:"roots"`
}

type cleanupRuleFile struct {
	Version     int                     `json:"version"`
	Rules       []cleanupRuleSpec       `json:"rules"`
	DeniedRoots []cleanupDeniedRootSpec `json:"deniedRoots"`
}

type compiledCleanupRule struct {
	category    string
	granularity string
	minAge      time.Duration
	patterns    [][]string
	exclude     [][]string
}

type cleanupRuleMatch struct {
	Category    string
	Granularity string
	MinAge      time.Duration
	// Number of leading WILDCARD-FREE components in the pattern that matched.
	// This is the confinement anchor (spec §13 row 1): everything from here
	// down is traversed through an os.Root handle, never by pathname.
	LiteralPrefix int
}

type cleanupRuleTable struct {
	byOS   map[string][]compiledCleanupRule
	denied map[string][]string
}

var (
	cleanupRulesOnce  sync.Once
	cleanupRuleTables *cleanupRuleTable
	cleanupRulesErr   error
)

// loadCleanupRules parses and compiles the embedded table exactly once. A
// malformed table is a build-time authoring error, not a runtime condition: the
// scanner treats a load failure as "nothing is classifiable", which is the
// fail-closed direction (no candidates rather than wrong candidates).
func loadCleanupRules() (*cleanupRuleTable, error) {
	cleanupRulesOnce.Do(func() {
		var file cleanupRuleFile
		if err := json.Unmarshal(cleanupRulesJSON, &file); err != nil {
			cleanupRulesErr = fmt.Errorf("parse cleanup rules: %w", err)
			return
		}
		table := &cleanupRuleTable{
			byOS:   map[string][]compiledCleanupRule{},
			denied: map[string][]string{},
		}
		for _, spec := range file.Rules {
			patterns, err := compileCleanupPatterns(spec.Patterns)
			if err != nil {
				cleanupRulesErr = err
				return
			}
			exclude, err := compileCleanupPatterns(spec.Exclude)
			if err != nil {
				cleanupRulesErr = err
				return
			}
			table.byOS[spec.OS] = append(table.byOS[spec.OS], compiledCleanupRule{
				category:    spec.Category,
				granularity: spec.Granularity,
				minAge:      time.Duration(spec.MinAgeHours) * time.Hour,
				patterns:    patterns,
				exclude:     exclude,
			})
		}
		for _, spec := range file.DeniedRoots {
			table.denied[spec.OS] = append(table.denied[spec.OS], spec.Roots...)
		}
		cleanupRuleTables = table
	})
	return cleanupRuleTables, cleanupRulesErr
}

func compileCleanupPatterns(patterns []string) ([][]string, error) {
	out := make([][]string, 0, len(patterns))
	for _, pattern := range patterns {
		expanded, err := expandCleanupBraces(pattern)
		if err != nil {
			return nil, err
		}
		for _, concrete := range expanded {
			out = append(out, splitCleanupComponents(concrete))
		}
	}
	return out, nil
}

// expandCleanupBraces turns `a/{b/c,d}/e` into [a/b/c/e a/d/e]. Alternation is
// expanded BEFORE component splitting because the spec's alternatives cross
// component boundaries ({google/chrome,microsoft/edge}).
func expandCleanupBraces(pattern string) ([]string, error) {
	open := strings.IndexByte(pattern, '{')
	if open < 0 {
		return []string{pattern}, nil
	}
	rel := strings.IndexByte(pattern[open:], '}')
	if rel < 0 {
		return nil, fmt.Errorf("unbalanced brace in cleanup pattern %q", pattern)
	}
	closeAt := open + rel
	group := pattern[open+1 : closeAt]
	if strings.Contains(group, "{") {
		return nil, fmt.Errorf("nested brace alternation is not supported: %q", pattern)
	}
	prefix := pattern[:open]
	suffix := pattern[closeAt+1:]
	out := []string{}
	for _, alt := range strings.Split(group, ",") {
		expanded, err := expandCleanupBraces(prefix + alt + suffix)
		if err != nil {
			return nil, err
		}
		out = append(out, expanded...)
	}
	return out, nil
}

func splitCleanupComponents(normalized string) []string {
	parts := strings.Split(normalized, "/")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

// normalizeCleanupPathFor normalises a path for matching. Normalisation is PER
// OS (spec §13 row 10): windows folds case and converts '\\'→'/'; darwin folds
// case only (default APFS is case-insensitive) and keeps backslashes as
// ordinary filename characters; linux does neither. Folding on POSIX changes
// path identity — `/TMP/x` is a DIFFERENT directory from `/tmp/x` on Linux, and
// a file literally named `.cache\\v` is not inside `.cache`.
//
// On Windows the drive specifier becomes the `<vol>` token, so one rule covers
// every fixed volume — the fix for defect 2's `C:\$Recycle.Bin` hardcode.
func normalizeCleanupPathFor(goos, path string) string {
	n := strings.TrimSpace(path)
	if goos == "windows" {
		n = strings.ReplaceAll(n, "\\", "/")
	}
	for strings.Contains(n, "//") {
		n = strings.ReplaceAll(n, "//", "/")
	}
	if goos != "linux" {
		n = strings.ToLower(n)
	}
	if len(n) > 1 && strings.HasSuffix(n, "/") {
		n = strings.TrimSuffix(n, "/")
	}
	if goos == "windows" && len(n) >= 2 && n[1] == ':' && n[0] >= 'a' && n[0] <= 'z' {
		n = "<vol>" + n[2:]
	}
	return n
}

// matchCleanupComponentGlob matches ONE path component. `*` matches any
// (possibly empty) run of characters within that component; it never spans '/'.
func matchCleanupComponentGlob(pattern, name string) bool {
	if pattern == "*" {
		return true
	}
	if !strings.Contains(pattern, "*") {
		return pattern == name
	}
	parts := strings.Split(pattern, "*")
	if !strings.HasPrefix(name, parts[0]) {
		return false
	}
	rest := name[len(parts[0]):]
	for i := 1; i < len(parts)-1; i++ {
		idx := strings.Index(rest, parts[i])
		if idx < 0 {
			return false
		}
		rest = rest[idx+len(parts[i]):]
	}
	return strings.HasSuffix(rest, parts[len(parts)-1])
}

// matchCleanupComponents walks a component pattern against a component path.
// `**` matches ONE OR MORE components. Recursion is bounded by the path depth
// (the scanner caps depth at maxFSMaxDepth = 64) and patterns carry at most one
// `**`, so the search never blows up.
func matchCleanupComponents(pattern, path []string) bool {
	if len(pattern) == 0 {
		return len(path) == 0
	}
	if pattern[0] == "**" {
		for consume := 1; consume <= len(path); consume++ {
			if matchCleanupComponents(pattern[1:], path[consume:]) {
				return true
			}
		}
		return false
	}
	if len(path) == 0 {
		return false
	}
	if !matchCleanupComponentGlob(pattern[0], path[0]) {
		return false
	}
	return matchCleanupComponents(pattern[1:], path[1:])
}

// matchCleanupRuleFor returns the first rule whose pattern matches and whose
// exclude list does not. An excluded match CONTINUES to the next rule rather
// than terminating: that is how /home/*/.cache/pip/** leaves browser_cache and
// is claimed by package_cache.
func matchCleanupRuleFor(goos, path string) *cleanupRuleMatch {
	table, err := loadCleanupRules()
	if err != nil || table == nil {
		return nil
	}
	components := splitCleanupComponents(normalizeCleanupPathFor(goos, path))
	for _, rule := range table.byOS[goos] {
		var matchedPattern []string
		for _, pattern := range rule.patterns {
			if matchCleanupComponents(pattern, components) {
				matchedPattern = pattern
				break
			}
		}
		if matchedPattern == nil {
			continue
		}
		excluded := false
		for _, pattern := range rule.exclude {
			if matchCleanupComponents(pattern, components) {
				excluded = true
				break
			}
		}
		if excluded {
			continue
		}
		return &cleanupRuleMatch{
			Category:      rule.category,
			Granularity:   rule.granularity,
			MinAge:        rule.minAge,
			LiteralPrefix: literalPrefixLen(matchedPattern),
		}
	}
	return nil
}

// literalPrefixLen counts the leading pattern components that contain no
// wildcard. Those components are fixed by the RULE AUTHOR, so the directory
// they name is a trustworthy place to anchor a confined traversal.
func literalPrefixLen(pattern []string) int {
	n := 0
	for _, component := range pattern {
		if component == "**" || strings.Contains(component, "*") {
			break
		}
		n++
	}
	return n
}

// cleanupRuleAnchorFor maps a matched rule's literal prefix back onto the
// CONCRETE path, producing the directory the agent opens with os.OpenRoot
// before it touches anything (`/home/*/.cache/**` → `/home`;
// `<vol>/users/*/appdata/local/temp/**` → `C:\Users`).
//
// Everything below the anchor is then resolved by the runtime through that
// handle, so an ancestor swapped for a symlink or a junction between preview
// and execute is refused rather than followed (spec §13 row 1).
func cleanupRuleAnchorFor(goos, path string) (string, bool) {
	match := matchCleanupRuleFor(goos, path)
	if match == nil || match.LiteralPrefix == 0 {
		return "", false
	}
	return concreteAnchor(goos, path, match.LiteralPrefix)
}

// concreteAnchor rebuilds the first n normalised components of path as a real,
// platform-shaped path. On Windows the first component is the `<vol>` token,
// which maps to the volume specifier rather than to a directory.
func concreteAnchor(goos, path string, n int) (string, bool) {
	clean := filepath.Clean(path)
	isSep := func(r rune) bool { return r == '/' || (goos == "windows" && r == '\\') }
	if goos == "windows" {
		volume := filepath.VolumeName(clean)
		if volume == "" {
			return "", false
		}
		rest := strings.FieldsFunc(clean[len(volume):], isSep)
		if n-1 > len(rest) {
			return "", false
		}
		return volume + string(filepath.Separator) + filepath.Join(rest[:n-1]...), true
	}
	rest := strings.FieldsFunc(clean, isSep)
	if n > len(rest) {
		return "", false
	}
	return string(filepath.Separator) + filepath.Join(rest[:n]...), true
}

func matchCleanupRule(path string) *cleanupRuleMatch {
	return matchCleanupRuleFor(runtime.GOOS, path)
}

// isCleanupDeniedRootFor reports whether path IS a cleanup-denied root or lives
// under one. Roots are stored bare (no `/**`) precisely so the root node itself
// is denied: /private/var/db sits at depth 3, below isRecursiveDeleteBoundary's
// reach.
func isCleanupDeniedRootFor(goos, path string) bool {
	table, err := loadCleanupRules()
	if err != nil || table == nil {
		// Fail closed: with no table we cannot prove a path is safe.
		return true
	}
	normalized := normalizeCleanupPathFor(goos, path)
	for _, root := range table.denied[goos] {
		if normalized == root || strings.HasPrefix(normalized, root+"/") {
			return true
		}
	}
	return false
}

func isCleanupDeniedRoot(path string) bool {
	return isCleanupDeniedRootFor(runtime.GOOS, path)
}

// classifyCleanupPathFor is the single place `Safe` is decided (spec §6.1:
// "Safe is true only when a rule matched, no Exclude matched, and the min-age
// check passed"). It replaces the hardcoded `Safe: true` at
// filesystem_analysis.go:425 and :591.
func classifyCleanupPathFor(goos, path string, modTime, now time.Time) (string, string, bool) {
	if isCleanupDeniedRootFor(goos, path) {
		return "", "", false
	}
	match := matchCleanupRuleFor(goos, path)
	if match == nil {
		return "", "", false
	}
	if match.MinAge > 0 && now.Sub(modTime) < match.MinAge {
		return "", "", false
	}
	return match.Category, match.Granularity, true
}

func classifyCleanupPath(path string, modTime, now time.Time) (string, string, bool) {
	return classifyCleanupPathFor(runtime.GOOS, path, modTime, now)
}
```

- [ ] **Step 5: Run it and watch it pass**

```bash
cd agent && gofmt -l internal/remote/tools/filesystem_cleanup_rules.go internal/remote/tools/filesystem_cleanup_rules_test.go && go test -race ./internal/remote/tools/... -run 'Cleanup'
```

Expected: `gofmt -l` prints nothing, then `ok github.com/breeze-rmm/agent/internal/remote/tools`.

- [ ] **Step 6: Close the TypeScript side of the contract**

```bash
cd packages/shared && npx vitest run src/utils/cleanupRules.test.ts
```

Expected: all cases pass, including `is byte-identical to the copy the agent embeds`.

- [ ] **Step 7: Commit**

```bash
git add agent/internal/remote/tools/cleanup_rules.json agent/internal/remote/tools/filesystem_cleanup_rules.go agent/internal/remote/tools/filesystem_cleanup_rules_test.go
git commit -m "$(cat <<'EOF'
feat(agent): Go cleanup rule matcher + embedded rule table (disk cleanup v2 W01)

Ports the shared component-glob matcher to Go and embeds a byte-identical copy
of packages/shared/src/utils/cleanupRules.json. Both sides replay one shared
fixture table, and each side asserts the two JSON files are byte-equal, so a
rule edit that reaches only one language turns a suite red instead of letting
the API and the agent disagree about what may be deleted.

go:embed cannot leave the agent module, which is why the table ships twice.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §6.1

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Wire the scanner onto the rule table (defect 3)

**Files:**
- Modify: `agent/internal/remote/tools/filesystem_analysis.go` — delete `classifyCleanupCategory` (`:1000-1025`); change the file-classification call site (`:380-429`)
- Create: `agent/internal/remote/tools/filesystem_analysis_rules_test.go` (Test)

**Interfaces:**
- Consumes: `classifyCleanupPathFor` / `classifyCleanupPath` (Task 2).
- Produces: no new exported surface. `classifyCleanupCategory(path string) string` is **removed**; `AnalyzeFilesystem` now emits `FilesystemCleanupCandidate.Safe` computed from the rule match.

- [ ] **Step 1: Write the failing test** — create `agent/internal/remote/tools/filesystem_analysis_rules_test.go`:

```go
package tools

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// writeAgedFile creates a file whose mtime is `age` in the past, so the
// scanner's min-age gate (temp_files, 24h) can be driven deterministically.
func writeAgedFile(t *testing.T, path string, size int, age time.Duration) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	when := time.Now().Add(-age)
	if err := os.Chtimes(path, when, when); err != nil {
		t.Fatalf("chtimes %s: %v", path, err)
	}
}

func runAnalyzeFilesystem(t *testing.T, root string) FilesystemAnalysisResponse {
	t.Helper()
	result := AnalyzeFilesystem(map[string]any{
		"path":           root,
		"maxDepth":       12,
		"timeoutSeconds": 30,
		"maxEntries":     100000,
		"workers":        2,
	})
	if result.Status != "completed" {
		t.Fatalf("AnalyzeFilesystem failed: %s", result.Error)
	}
	var response FilesystemAnalysisResponse
	if err := json.Unmarshal([]byte(result.Stdout), &response); err != nil {
		t.Fatalf("decode analysis response: %v", err)
	}
	return response
}

// The scanner must classify through the rooted rule table, not the old
// substring classifier. A temp directory named "tmp" that is NOT /tmp is the
// regression the old `strings.Contains(n, "/tmp/")` shipped.
func TestAnalyzeFilesystemClassifiesThroughTheRuleTable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX path fixture; the Windows rules are covered by the shared fixture table")
	}
	root := t.TempDir()
	// An app directory that merely CONTAINS a component called tmp.
	writeAgedFile(t, filepath.Join(root, "opt", "app", "tmp", "build.log"), 4096, 72*time.Hour)
	// A directory that merely CONTAINS a component called .cache.
	writeAgedFile(t, filepath.Join(root, "var", "lib", "postgres", ".cache", "blob"), 4096, 72*time.Hour)

	response := runAnalyzeFilesystem(t, root)
	for _, candidate := range response.CleanupCandidates {
		t.Errorf("no file under a scratch root should be a cleanup candidate, got %+v", candidate)
	}
	if len(response.TempAccumulation) != 0 {
		t.Errorf("tempAccumulation should be empty, got %+v", response.TempAccumulation)
	}
}

func TestClassifyCleanupPathComputesSafeAndGranularity(t *testing.T) {
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	old := now.Add(-48 * time.Hour)
	fresh := now.Add(-1 * time.Hour)

	category, granularity, safe := classifyCleanupPathFor("linux", "/tmp/build.tmp", old, now)
	if category != "temp_files" || granularity != "file" || !safe {
		t.Errorf("aged /tmp file: got %q/%q safe=%v", category, granularity, safe)
	}

	category, _, safe = classifyCleanupPathFor("linux", "/tmp/build.tmp", fresh, now)
	if category != "" || safe {
		t.Errorf("fresh /tmp file must not be a candidate: got %q safe=%v", category, safe)
	}

	category, granularity, safe = classifyCleanupPathFor("darwin", "/Users/alice/.Trash", now, now)
	if category != "trash" || granularity != "contents" || !safe {
		t.Errorf("trash root: got %q/%q safe=%v", category, granularity, safe)
	}

	category, _, safe = classifyCleanupPathFor("windows",
		`C:\Users\alice\AppData\Local\Google\Chrome\User Data\Default\Bookmarks`, now, now)
	if category != "" || safe {
		t.Errorf("Chrome Bookmarks must never be a candidate: got %q safe=%v", category, safe)
	}
}

// The old classifier is gone. This keeps a later refactor from quietly
// resurrecting a substring path next to the rule table.
func TestNoSubstringClassifierRemains(t *testing.T) {
	source, err := os.ReadFile("filesystem_analysis.go")
	if err != nil {
		t.Fatalf("read filesystem_analysis.go: %v", err)
	}
	for _, banned := range []string{`"/tmp/"`, `"/library/caches/"`, `"/.cache/"`, `"/appdata/local/packages/"`} {
		if idx := indexOfCleanupSubstring(string(source), banned); idx >= 0 {
			t.Errorf("filesystem_analysis.go still contains the substring classifier fragment %s at offset %d", banned, idx)
		}
	}
}

func indexOfCleanupSubstring(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
```

Note: `isOldDownload` (`filesystem_analysis.go:1035-1038`) legitimately uses `"/library/caches/"` and `"/.cache/"` as *negative* guards. Move those two checks to `matchCleanupRuleFor(runtime.GOOS, path) != nil` in Step 2 so this scan stays honest — a download inside a cache directory is exactly "already covered by a cleanup rule".

- [ ] **Step 2: Run it and watch it fail**

```bash
cd agent && go test -race ./internal/remote/tools/... -run 'TestAnalyzeFilesystemClassifiesThroughTheRuleTable|TestClassifyCleanupPathComputesSafeAndGranularity|TestNoSubstringClassifierRemains'
```

Expected failure: `TestNoSubstringClassifierRemains` reports the four fragments; `TestAnalyzeFilesystemClassifiesThroughTheRuleTable` fails with candidates for `opt/app/tmp/build.log` and `var/lib/postgres/.cache/blob` (the old classifier's floating substrings still match under a `t.TempDir()` root).

- [ ] **Step 3: Implement** — in `agent/internal/remote/tools/filesystem_analysis.go`:

Delete `classifyCleanupCategory` entirely (lines 1000-1025) and replace the file-classification block at `:380` and the candidate append at `:419-429`:

```go
			// Classification is pure (touches no shared state), so run it before
			// taking the lock instead of holding every other worker off while we do.
			category, _, categorySafe := classifyCleanupPath(entryPath, info.ModTime(), now)
			oldDownload := isOldDownload(entryPath, fileSize, info.ModTime(), oldDownloadsThreshold)
			unrotated := isUnrotatedLog(entryPath, fileSize)
```

```go
			if category != "" {
				tempBytes[category] += fileSize
				addCleanupCandidate(cleanupByPath, FilesystemCleanupCandidate{
					Path:       entryPath,
					Category:   category,
					SizeBytes:  fileSize,
					Safe:       categorySafe,
					Reason:     "temporary/cache file",
					ModifiedAt: resolveModTime(),
				}, maxFSCleanupCandidates)
			}
```

And replace `isOldDownload`'s substring guards (`:1035-1039`) with a rule-table query, so "already a cleanup candidate" is expressed once:

```go
func isOldDownload(path string, sizeBytes int64, modifiedAt time.Time, threshold time.Time) bool {
	if sizeBytes <= 0 {
		return false
	}
	if modifiedAt.After(threshold) {
		return false
	}
	// A file that a cleanup rule already claims is reported there, not twice.
	// This replaces three floating substring guards ("/library/caches/",
	// "/.cache/", "/appdata/local/temp/") with the one table that decides scope.
	if matchCleanupRule(path) != nil {
		return false
	}

	n := normalizePathForChecks(path)
	segments := strings.Split(strings.Trim(n, "/"), "/")
	for i, segment := range segments {
		if segment != "downloads" {
			continue
		}

		// macOS/Linux user download roots.
		if i >= 2 && (segments[0] == "users" || segments[0] == "home") {
			return true
		}

		// Windows path roots after slash normalization: c:/users/<user>/downloads
		if i >= 3 && strings.HasSuffix(segments[0], ":") && segments[1] == "users" {
			return true
		}
	}

	return false
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd agent && gofmt -l internal/remote/tools/ && go test -race ./internal/remote/tools/...
```

Expected: `gofmt -l` prints nothing and the whole `tools` package is green. If `TestAnalyzeFilesystemEndToEnd` (`filesystem_analysis_opt_test.go:169`) now reports zero cleanup candidates where it previously expected some, that is the rule table working — update the fixture to create a file under a real rule anchor rather than relaxing the rules.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/remote/tools/filesystem_analysis.go agent/internal/remote/tools/filesystem_analysis_rules_test.go agent/internal/remote/tools/filesystem_analysis_opt_test.go
git commit -m "$(cat <<'EOF'
fix(agent): classify cleanup candidates with the rooted rule table (defect 3)

The scanner marked Chrome Bookmarks/History/Cookies/extensions, Firefox
places.sqlite, UWP LocalState, /System/Library/Caches and any directory merely
NAMED tmp or .cache as "safe" cleanup candidates, because the classifier was a
floating substring match over the whole path. It now asks the shared rule table,
and `Safe` is computed from the match instead of hardcoded true.

isOldDownload's three substring guards collapse into one rule-table query, so
"already claimed by a cleanup rule" is written down once.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §2 defect 3, §6.1

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Trash per volume — `getTrashPaths(scanRoot)` (defect 2)

**Files:**
- Modify: `agent/internal/remote/tools/filesystem_analysis.go` — `getTrashPaths` (`:1146-1200`) and its call site (`:565-594`)
- Modify: `agent/internal/remote/tools/filesystem_analysis_rules_test.go` (Test — append)

**Interfaces:**
- Consumes: `normalizeCleanupPathFor`, `classifyCleanupPath` (Task 2).
- Produces:
  ```go
  func isWindowsVolumeRoot(path string) bool
  func enumerateWindowsRecycleBins(volumeRoot string) ([]string, []FilesystemScanError)
  func trashPathsForRoot(goos, scanRoot, home string) ([]string, []FilesystemScanError)
  func getTrashPaths(scanRoot string) ([]string, []FilesystemScanError)   // signature CHANGED
  func isRealPathUnderRoot(scanRoot, candidate string) bool               // §13 row 11
  ```

- [ ] **Step 1: Write the failing test** — append to `agent/internal/remote/tools/filesystem_analysis_rules_test.go`:

```go
func TestIsWindowsVolumeRoot(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{`C:\`, true},
		{`c:/`, true},
		{`D:\`, true},
		{`C:`, true},
		{`C:\Users`, false},
		{`C:\$Recycle.Bin`, false},
		{`\\server\share`, false},
	}
	for _, c := range cases {
		if got := isWindowsVolumeRoot(c.path); got != c.want {
			t.Errorf("isWindowsVolumeRoot(%q) = %v, want %v", c.path, got, c.want)
		}
	}
}

// Defect 2: the only Windows trash path was the literal C:\$Recycle.Bin, which
// is depth 1 and therefore refused by isRecursiveDeleteBoundary — Windows bin
// reclaim was dead on arrival, and no other volume's bin was ever seen. The bin
// is now enumerated per SID, one level down, on whatever volume was scanned.
func TestEnumerateWindowsRecycleBinsListsSidDirectories(t *testing.T) {
	volumeRoot := t.TempDir()
	binRoot := filepath.Join(volumeRoot, "$Recycle.Bin")
	for _, sid := range []string{"S-1-5-21-1111111111-1-1-1001", "S-1-5-18"} {
		if err := os.MkdirAll(filepath.Join(binRoot, sid), 0o700); err != nil {
			t.Fatalf("mkdir sid dir: %v", err)
		}
	}
	if err := os.MkdirAll(filepath.Join(binRoot, "notasid"), 0o700); err != nil {
		t.Fatalf("mkdir decoy dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(binRoot, "desktop.ini"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write desktop.ini: %v", err)
	}

	paths, scanErrors := enumerateWindowsRecycleBins(volumeRoot)
	if len(scanErrors) != 0 {
		t.Fatalf("unexpected scan errors: %+v", scanErrors)
	}
	got := map[string]bool{}
	for _, p := range paths {
		got[filepath.Base(p)] = true
	}
	if len(got) != 2 || !got["S-1-5-21-1111111111-1-1-1001"] || !got["S-1-5-18"] {
		t.Fatalf("expected exactly the two SID directories, got %v", got)
	}
}

func TestEnumerateWindowsRecycleBinsReportsReadErrors(t *testing.T) {
	volumeRoot := t.TempDir()
	// $Recycle.Bin exists but is a FILE, so ReadDir fails with something other
	// than IsNotExist. Defect: that error used to be swallowed entirely.
	if err := os.WriteFile(filepath.Join(volumeRoot, "$Recycle.Bin"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write decoy: %v", err)
	}
	paths, scanErrors := enumerateWindowsRecycleBins(volumeRoot)
	if len(paths) != 0 {
		t.Errorf("expected no paths, got %v", paths)
	}
	if len(scanErrors) != 1 {
		t.Fatalf("expected the ReadDir error to be reported, got %+v", scanErrors)
	}
}

func TestTrashPathsForRootIsVolumeScopedOnWindows(t *testing.T) {
	paths, scanErrors := trashPathsForRoot("windows", `C:\Users\alice`, "")
	if len(paths) != 0 || len(scanErrors) != 0 {
		t.Fatalf("a scan rooted below the volume root must emit no bin candidates, got %v / %+v", paths, scanErrors)
	}
}

func TestTrashPathsForRootPosixSkipsTrashOutsideTheScannedRoot(t *testing.T) {
	// §13 row 11: a /data scan must not propose deleting the OS volume's trash.
	home := t.TempDir()
	elsewhere := t.TempDir()
	paths, _ := trashPathsForRoot("linux", elsewhere, home)
	for _, path := range paths {
		if strings.HasPrefix(path, home) {
			t.Fatalf("trash under %s must not be offered for a scan rooted at %s (got %v)", home, elsewhere, paths)
		}
	}
}

func TestTrashPathsForRootPosixUsesHome(t *testing.T) {
	home := t.TempDir()
	paths, _ := trashPathsForRoot("linux", "/", home)
	want := filepath.Join(home, ".local", "share", "Trash")
	found := false
	for _, p := range paths {
		if p == want {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected %s in %v", want, paths)
	}

	paths, _ = trashPathsForRoot("darwin", "/", home)
	want = filepath.Join(home, ".Trash")
	found = false
	for _, p := range paths {
		if p == want {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected %s in %v", want, paths)
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd agent && go test -race ./internal/remote/tools/... -run 'WindowsVolumeRoot|RecycleBins|TrashPathsForRoot'
```

Expected failure: compile error — `undefined: isWindowsVolumeRoot`, `undefined: enumerateWindowsRecycleBins`, `undefined: trashPathsForRoot`, plus `not enough arguments in call to getTrashPaths` once the signature changes.

- [ ] **Step 3: Implement** — replace `getTrashPaths` (`filesystem_analysis.go:1146-1200`) with:

```go
// isWindowsVolumeRoot reports whether path names a volume root (C:\, d:/, C:).
// Recycle bins only exist there, so a scan rooted deeper emits none.
func isWindowsVolumeRoot(path string) bool {
	return normalizeCleanupPathFor("windows", path) == "<vol>"
}

// enumerateWindowsRecycleBins lists <volumeRoot>\$Recycle.Bin\S-* — one
// directory per SID. Each is a `contents`-granularity candidate: the bin ROOT
// sits at depth 1 and isRecursiveDeleteBoundary refuses it (which is why the
// old C:\$Recycle.Bin candidate could never be deleted), while a SID directory
// is depth 2 and its contents are reachable.
//
// ReadDir errors are RETURNED rather than swallowed: a bin that cannot be read
// is a scan error an operator needs to see, not silence.
func enumerateWindowsRecycleBins(volumeRoot string) ([]string, []FilesystemScanError) {
	binRoot := filepath.Join(volumeRoot, "$Recycle.Bin")
	entries, err := os.ReadDir(binRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, []FilesystemScanError{{Path: binRoot, Error: err.Error()}}
	}
	paths := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if !strings.HasPrefix(strings.ToUpper(entry.Name()), "S-") {
			continue
		}
		paths = append(paths, filepath.Join(binRoot, entry.Name()))
	}
	return paths, nil
}

// trashPathsForRoot is getTrashPaths with the platform and home directory
// passed in, so both grammars are testable from any host.
func trashPathsForRoot(goos, scanRoot, home string) ([]string, []FilesystemScanError) {
	paths := make([]string, 0, 12)
	scanErrors := make([]FilesystemScanError, 0, 2)
	seen := make(map[string]struct{})
	addPath := func(p string) {
		if p == "" {
			return
		}
		clean := filepath.Clean(p)
		// POSIX trash enumeration used to ignore the scan root entirely, so a
		// /data scan proposed deleting the OS volume's trash (spec §13 row 11).
		// Windows is already volume-scoped by isWindowsVolumeRoot above.
		if goos != "windows" && !isRealPathUnderRoot(scanRoot, clean) {
			return
		}
		if _, ok := seen[clean]; ok {
			return
		}
		seen[clean] = struct{}{}
		paths = append(paths, clean)
	}
	addDirErr := func(dir string, err error) {
		if err == nil || os.IsNotExist(err) {
			return
		}
		scanErrors = append(scanErrors, FilesystemScanError{Path: dir, Error: err.Error()})
	}

	switch goos {
	case "windows":
		if !isWindowsVolumeRoot(scanRoot) {
			return paths, scanErrors
		}
		binPaths, binErrors := enumerateWindowsRecycleBins(scanRoot)
		for _, p := range binPaths {
			addPath(p)
		}
		scanErrors = append(scanErrors, binErrors...)
	case "darwin":
		if home != "" {
			addPath(filepath.Join(home, ".Trash"))
		}
		entries, err := os.ReadDir("/Users")
		addDirErr("/Users", err)
		for _, entry := range entries {
			if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			addPath(filepath.Join("/Users", entry.Name(), ".Trash"))
		}
	case "linux":
		if home != "" {
			addPath(filepath.Join(home, ".local", "share", "Trash"))
		}
		entries, err := os.ReadDir("/home")
		addDirErr("/home", err)
		for _, entry := range entries {
			if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			addPath(filepath.Join("/home", entry.Name(), ".local", "share", "Trash"))
		}
		addPath(filepath.Join("/root", ".local", "share", "Trash"))
	}
	return paths, scanErrors
}

func getTrashPaths(scanRoot string) ([]string, []FilesystemScanError) {
	home, _ := os.UserHomeDir()
	return trashPathsForRoot(runtime.GOOS, scanRoot, home)
}

// isRealPathUnderRoot reports whether candidate's REAL path (symlinks resolved)
// is scanRoot's real path or below it. Resolving both sides is the point: a
// trash directory reached through a symlink out of the scanned tree is not in
// scope, and a candidate that cannot be resolved at all is refused rather than
// guessed at (spec §13 row 11).
func isRealPathUnderRoot(scanRoot, candidate string) bool {
	realRoot, err := filepath.EvalSymlinks(scanRoot)
	if err != nil {
		return false
	}
	realCandidate, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		// A trash directory that does not exist is not a candidate anyway —
		// estimateDirectorySize would drop it a moment later.
		return false
	}
	if realCandidate == realRoot {
		return true
	}
	prefix := strings.TrimSuffix(realRoot, string(filepath.Separator)) + string(filepath.Separator)
	return strings.HasPrefix(realCandidate, prefix)
}
```

Then replace the trash block at `filesystem_analysis.go:565-594`:

```go
	// Trash usage is calculated separately from known locations, scoped to the
	// volume that was scanned (defect 2: the bin was hardcoded to C:\).
	trashPaths, trashScanErrors := getTrashPaths(cleanRoot)
	for _, trashScanError := range trashScanErrors {
		if len(scanErrors) >= maxFSErrors {
			break
		}
		scanErrors = append(scanErrors, trashScanError)
	}
	for _, trashPath := range trashPaths {
		size, _, timedOut, trashErr := estimateDirectorySize(trashPath, deadline, maxEntries/2, &permissionDeniedCount)
		if trashErr != nil {
			if !os.IsNotExist(trashErr) {
				appendScanError(&scanErrors, trashPath, trashErr, &permissionDeniedCount)
			}
			continue
		}
		if timedOut {
			partial = true
			if reason == "" {
				reason = "timeout reached while scanning trash"
			}
		}
		if size <= 0 {
			continue
		}
		trashUsage = append(trashUsage, FilesystemTrashUsage{
			Path:      trashPath,
			SizeBytes: size,
		})
		// Safe is COMPUTED (spec §6.1): a trash location the rule table does
		// not recognise is still reported in trashUsage, but is emitted with
		// Safe=false so buildCleanupPreview never offers it for deletion.
		trashCategory, _, trashSafe := classifyCleanupPath(trashPath, now, now)
		if trashCategory == "" {
			trashCategory = "trash"
		}
		cleanupSet.Add(FilesystemCleanupCandidate{
			Path:      trashPath,
			Category:  trashCategory,
			SizeBytes: size,
			Safe:      trashSafe,
			Reason:    "trash/recycle bin cleanup",
		})
	}
```

Note `cleanupSet.Add` and the fourth `estimateDirectorySize` argument arrive in Task 5. Until then, keep `addCleanupCandidate(cleanupByPath, ..., maxFSCleanupCandidates)` and the three-argument `estimateDirectorySize` here, and change both call shapes in Task 5. Do not leave the package uncompilable between tasks.

- [ ] **Step 4: Run it and watch it pass**

```bash
cd agent && gofmt -l internal/remote/tools/ && go test -race ./internal/remote/tools/...
```

Expected: `gofmt -l` silent, package green.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/remote/tools/filesystem_analysis.go agent/internal/remote/tools/filesystem_analysis_rules_test.go
git commit -m "$(cat <<'EOF'
fix(agent): enumerate recycle bins per volume and per SID (defect 2)

getTrashPaths hardcoded C:\$Recycle.Bin, so no other volume's bin was ever
seen — and that path is depth 1, which isRecursiveDeleteBoundary refuses, so
Windows bin reclaim could never have worked. It now takes the scan root,
enumerates <root>\$Recycle.Bin\S-* when the root IS a volume root, and emits
nothing when it is not. ReadDir errors are returned instead of swallowed.

Trash candidates carry a COMPUTED Safe: an unrecognised trash location is still
reported in trashUsage but is never offered for deletion.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §2 defect 2, §6.2

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Accumulator fixes — bounded duplicates, top-by-size candidates, counted permission errors (defect 7)

**Files:**
- Modify: `agent/internal/remote/tools/filesystem_analysis.go` — `maxFSDuplicateGroups` const, `addDuplicateCandidate` (`:1076-1094`), `addCleanupCandidate` + `mapCleanupCandidates` (`:1121-1144`, replaced by a heap-backed set), `estimateDirectorySize` (`:1202-1259`), the `AnalyzeFilesystem` wiring
- Modify: `agent/internal/remote/tools/types.go` — `FilesystemAnalysisSummary` gains `DuplicateTrackingTruncated`
- Modify: `agent/internal/remote/tools/filesystem_analysis_test.go` — replace the `[]map[string]any` assertion with a JSON round-trip; add the accumulator tests
- Modify: `agent/internal/remote/tools/filesystem_analysis_opt_test.go` — add the `collapseAncestorDirectories` estimated-ratio case

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```go
  const maxFSDuplicateGroups = 50_000
  func addDuplicateCandidate(groups map[string]*duplicateGroup, path string, sizeBytes int64) (dropped bool)   // signature CHANGED
  type cleanupCandidateSet struct{ /* min-heap by SizeBytes + path index */ }
  func newCleanupCandidateSet(limit int) *cleanupCandidateSet
  func (s *cleanupCandidateSet) Add(candidate FilesystemCleanupCandidate)
  func (s *cleanupCandidateSet) Sorted() []FilesystemCleanupCandidate
  func estimateDirectorySize(root string, deadline time.Time, maxEntries int, permissionDenied *int64) (int64, int64, bool, error)  // signature CHANGED
  // types.go
  type FilesystemAnalysisSummary struct { ...; DuplicateTrackingTruncated bool `json:"duplicateTrackingTruncated,omitempty"` }
  ```
  `addCleanupCandidate` and `mapCleanupCandidates` are **removed**.

- [ ] **Step 1: Write the failing tests** — append to `agent/internal/remote/tools/filesystem_analysis_test.go`:

```go
// Defect 7a: the duplicate map was unbounded. A 10M-file scan with mostly
// distinct basenames grew one entry per file.
func TestAddDuplicateCandidateIsBounded(t *testing.T) {
	groups := map[string]*duplicateGroup{}
	for i := 0; i < maxFSDuplicateGroups; i++ {
		if dropped := addDuplicateCandidate(groups, fmt.Sprintf("/data/file-%d.bin", i), int64(i+1)); dropped {
			t.Fatalf("unexpected drop at i=%d (below the cap)", i)
		}
	}
	if len(groups) != maxFSDuplicateGroups {
		t.Fatalf("expected %d groups, got %d", maxFSDuplicateGroups, len(groups))
	}
	if dropped := addDuplicateCandidate(groups, "/data/one-too-many.bin", 999); !dropped {
		t.Fatal("expected a NEW key past the cap to be dropped and reported")
	}
	if len(groups) != maxFSDuplicateGroups {
		t.Fatalf("cap breached: %d groups", len(groups))
	}
	// An EXISTING key must still accumulate — the cap bounds keys, not members.
	if dropped := addDuplicateCandidate(groups, "/other/file-1.bin", 2); dropped {
		t.Fatal("an existing key must not be reported as dropped")
	}
}

// Defect 7b: the candidate cap was insertion-ordered, so a late 40 GB candidate
// could not displace an early 1 KB one while the UI advertised "biggest wins".
func TestCleanupCandidateSetKeepsTopBySize(t *testing.T) {
	set := newCleanupCandidateSet(3)
	for i := 1; i <= 3; i++ {
		set.Add(FilesystemCleanupCandidate{Path: fmt.Sprintf("/tmp/small-%d", i), Category: "temp_files", SizeBytes: int64(i)})
	}
	set.Add(FilesystemCleanupCandidate{Path: "/tmp/huge", Category: "temp_files", SizeBytes: 40 << 30})

	sorted := set.Sorted()
	if len(sorted) != 3 {
		t.Fatalf("expected the limit to hold at 3, got %d", len(sorted))
	}
	if sorted[0].Path != "/tmp/huge" {
		t.Fatalf("largest candidate was evicted or not admitted: %+v", sorted)
	}
	for _, candidate := range sorted {
		if candidate.Path == "/tmp/small-1" {
			t.Fatal("the smallest candidate should have been evicted")
		}
	}
	// Descending by size.
	for i := 1; i < len(sorted); i++ {
		if sorted[i-1].SizeBytes < sorted[i].SizeBytes {
			t.Fatalf("Sorted() is not descending: %+v", sorted)
		}
	}
}

func TestCleanupCandidateSetDedupesByPathKeepingLargest(t *testing.T) {
	set := newCleanupCandidateSet(10)
	set.Add(FilesystemCleanupCandidate{Path: "/tmp/a", Category: "temp_files", SizeBytes: 10})
	set.Add(FilesystemCleanupCandidate{Path: "/tmp/a", Category: "temp_files", SizeBytes: 99})
	set.Add(FilesystemCleanupCandidate{Path: "/tmp/a", Category: "temp_files", SizeBytes: 5})
	set.Add(FilesystemCleanupCandidate{Path: "", Category: "temp_files", SizeBytes: 5})
	set.Add(FilesystemCleanupCandidate{Path: "/tmp/b", Category: "temp_files", SizeBytes: 0})

	sorted := set.Sorted()
	if len(sorted) != 1 || sorted[0].SizeBytes != 99 {
		t.Fatalf("expected one /tmp/a at 99 bytes, got %+v", sorted)
	}
}

// Replaces the []map[string]any assertion, which asserted the Go value shape
// rather than the JSON the API actually receives.
func TestBuildCheckpointPayloadRoundTripsThroughJSON(t *testing.T) {
	frames := []scanDirFrame{
		{path: "/tmp/one", depth: 1},
		{path: "/tmp/two", depth: 2},
		{path: "/tmp/three", depth: 3},
	}
	raw, err := json.Marshal(buildCheckpointPayload(frames, 2))
	if err != nil {
		t.Fatalf("marshal checkpoint payload: %v", err)
	}
	var decoded struct {
		PendingDirs []struct {
			Path  string `json:"path"`
			Depth int    `json:"depth"`
		} `json:"pendingDirs"`
		Truncated      bool `json:"truncated"`
		RemainingCount int  `json:"remainingCount"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal checkpoint payload: %v", err)
	}
	if len(decoded.PendingDirs) != 2 {
		t.Fatalf("expected 2 pending dirs, got %d", len(decoded.PendingDirs))
	}
	if decoded.PendingDirs[0].Path != "/tmp/one" || decoded.PendingDirs[0].Depth != 1 {
		t.Fatalf("first pending dir round-tripped wrong: %+v", decoded.PendingDirs[0])
	}
	if !decoded.Truncated || decoded.RemainingCount != 3 {
		t.Fatalf("truncation metadata lost: truncated=%v remaining=%d", decoded.Truncated, decoded.RemainingCount)
	}
}

func TestIsUnrotatedLog(t *testing.T) {
	if !isUnrotatedLog("/var/log/app.log", unrotatedLogMinBytes) {
		t.Error("a .log at the threshold should count")
	}
	if isUnrotatedLog("/var/log/app.log", unrotatedLogMinBytes-1) {
		t.Error("below the threshold should not count")
	}
	if isUnrotatedLog("/var/log/app.log.1", unrotatedLogMinBytes) {
		t.Error("a rotated file is not an unrotated log")
	}
	if isUnrotatedLog("/var/log/app.txt", unrotatedLogMinBytes) {
		t.Error("only .log qualifies")
	}
}

func TestIsOldDownloadIgnoresRuleTableClaims(t *testing.T) {
	threshold := time.Now().Add(-30 * 24 * time.Hour)
	old := threshold.Add(-24 * time.Hour)
	if !isOldDownload("/home/bob/Downloads/installer.iso", 1<<30, old, threshold) {
		t.Error("an aged user download should count")
	}
	if isOldDownload("/home/bob/Downloads/installer.iso", 1<<30, time.Now(), threshold) {
		t.Error("a fresh download should not count")
	}
	if isOldDownload("/home/bob/.cache/pip/http/Downloads/blob", 1<<30, old, threshold) {
		t.Error("a path a cleanup rule already claims must not double-report as an old download")
	}
	if isOldDownload("/srv/Downloads/x.iso", 1<<30, old, threshold) {
		t.Error("only user download roots count")
	}
}

func TestEstimateDirectorySizeCountsPermissionDenials(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX mode bits")
	}
	if os.Geteuid() == 0 {
		t.Skip("root ignores the mode bits this test relies on")
	}
	root := t.TempDir()
	locked := filepath.Join(root, "locked")
	if err := os.MkdirAll(locked, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(locked, "x"), make([]byte, 16), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.Chmod(locked, 0o000); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o700) })

	var permissionDenied int64
	if _, _, _, err := estimateDirectorySize(root, time.Now().Add(time.Minute), 1000, &permissionDenied); err != nil {
		t.Fatalf("estimateDirectorySize: %v", err)
	}
	if permissionDenied == 0 {
		t.Fatal("a permission-denied directory must be counted, not silently skipped")
	}
}
```

Append the imports `"encoding/json"`, `"fmt"`, `"os"`, `"path/filepath"`, `"runtime"`, `"time"` to that file as needed, and append to `agent/internal/remote/tools/filesystem_analysis_opt_test.go`:

```go
// An ESTIMATED ancestor is collapsed by a MEASURED child at a lower ratio
// (0.45), because the ancestor's own number is a lower bound and the child's
// is not. The plain 0.70 ratio would have kept both rows.
func TestCollapseAncestorDirectoriesUsesEstimatedRatios(t *testing.T) {
	candidates := []FilesystemLargestDirectory{
		{Path: "/data", SizeBytes: 1000, Estimated: true},
		{Path: "/data/child", SizeBytes: 500, Estimated: false},
	}
	result := collapseAncestorDirectories(candidates, 10, 0.70)
	if len(result) != 1 || result[0].Path != "/data/child" {
		t.Fatalf("estimated ancestor should collapse into its measured child, got %+v", result)
	}

	// The reverse: a MEASURED ancestor is only collapsed by an ESTIMATED child
	// at 0.85, so a 500/1000 pair keeps both rows.
	candidates = []FilesystemLargestDirectory{
		{Path: "/data", SizeBytes: 1000, Estimated: false},
		{Path: "/data/child", SizeBytes: 500, Estimated: true},
	}
	result = collapseAncestorDirectories(candidates, 10, 0.70)
	if len(result) != 2 {
		t.Fatalf("measured ancestor must survive an estimated child at 50%%, got %+v", result)
	}
}

// maxEntries is a hard stop: the scan must come back PARTIAL with a reason, not
// silently short.
func TestAnalyzeFilesystemMaxEntriesProducesPartial(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 50; i++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("f-%d", i)), make([]byte, 8), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	result := AnalyzeFilesystem(map[string]any{
		"path":           root,
		"maxEntries":     1000,
		"timeoutSeconds": 30,
		"workers":        1,
	})
	if result.Status != "completed" {
		t.Fatalf("scan failed: %s", result.Error)
	}
	var response FilesystemAnalysisResponse
	if err := json.Unmarshal([]byte(result.Stdout), &response); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if response.Partial {
		t.Fatalf("a 50-entry tree under a 1000-entry cap must not be partial: %q", response.Reason)
	}
	if response.Summary.FilesScanned != 50 {
		t.Fatalf("expected 50 files scanned, got %d", response.Summary.FilesScanned)
	}
}

// A checkpoint resumes from its pendingDirs rather than re-walking the root.
func TestAnalyzeFilesystemResumesFromCheckpoint(t *testing.T) {
	root := t.TempDir()
	resumeDir := filepath.Join(root, "resume")
	otherDir := filepath.Join(root, "other")
	for _, dir := range []string{resumeDir, otherDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(filepath.Join(dir, "f"), make([]byte, 1024), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	result := AnalyzeFilesystem(map[string]any{
		"path":           root,
		"timeoutSeconds": 30,
		"workers":        1,
		"checkpoint": map[string]any{
			"pendingDirs": []any{map[string]any{"path": resumeDir, "depth": 1}},
		},
	})
	if result.Status != "completed" {
		t.Fatalf("scan failed: %s", result.Error)
	}
	var response FilesystemAnalysisResponse
	if err := json.Unmarshal([]byte(result.Stdout), &response); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if response.Summary.FilesScanned != 1 {
		t.Fatalf("a resumed scan must visit only the checkpointed directory, saw %d files", response.Summary.FilesScanned)
	}
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd agent && go test -race ./internal/remote/tools/... -run 'Duplicate|CleanupCandidateSet|Checkpoint|UnrotatedLog|OldDownload|EstimateDirectorySize|CollapseAncestorDirectoriesUsesEstimated|MaxEntries|ResumesFromCheckpoint'
```

Expected failure: compile errors — `undefined: maxFSDuplicateGroups`, `undefined: newCleanupCandidateSet`, `addDuplicateCandidate(...) used as value`, `too many arguments in call to estimateDirectorySize`.

- [ ] **Step 3: Implement the bounded duplicate map** — in `filesystem_analysis.go`, add to the `const` block at `:15-31`:

```go
	maxFSDuplicateGroups         = 50_000
```

and replace `addDuplicateCandidate` (`:1076-1094`):

```go
// addDuplicateCandidate records path under its size|basename key, bounded to
// maxFSDuplicateGroups DISTINCT keys. It reports whether a NEW key had to be
// dropped, which the caller surfaces as summary.duplicateTrackingTruncated —
// an unbounded map grew one entry per distinct basename on a 10M-file scan.
// Existing keys keep accumulating members (up to 50 paths each) regardless.
func addDuplicateCandidate(groups map[string]*duplicateGroup, path string, sizeBytes int64) bool {
	base := normalizeDuplicateName(filepath.Base(path))
	if base == "" || sizeBytes <= 0 {
		return false
	}
	key := fmt.Sprintf("%d|%s", sizeBytes, base)
	group, ok := groups[key]
	if !ok {
		if len(groups) >= maxFSDuplicateGroups {
			return true
		}
		groups[key] = &duplicateGroup{
			Key:       key,
			SizeBytes: sizeBytes,
			Paths:     []string{path},
		}
		return false
	}
	if len(group.Paths) < 50 {
		group.Paths = append(group.Paths, path)
	}
	return false
}
```

- [ ] **Step 4: Implement the top-by-size candidate set** — replace `addCleanupCandidate` and `mapCleanupCandidates` (`:1121-1144`) with:

```go
// cleanupCandidateSet keeps the top-N cleanup candidates BY SIZE.
//
// The previous cap was insertion-ordered (`if len(existing) >= maxItems {
// return }`), so once 1000 candidates had been seen a late 40 GB directory
// could not displace an early 1 KB file — while the UI presents the list as
// "biggest wins". A min-heap keyed on SizeBytes makes the eviction correct:
// the smallest member is always at the root, so admitting a larger newcomer is
// O(log n) instead of an O(n) scan on every file of a multi-million-file walk.
//
// Not safe for concurrent use; every caller holds statsMu (or runs after
// workers.Wait()), exactly as the map it replaces did.
type cleanupCandidateSet struct {
	limit int
	heap  cleanupCandidateHeap
}

type cleanupCandidateHeap struct {
	items []FilesystemCleanupCandidate
	index map[string]int
}

func (h cleanupCandidateHeap) Len() int { return len(h.items) }

func (h cleanupCandidateHeap) Less(i, j int) bool {
	return h.items[i].SizeBytes < h.items[j].SizeBytes
}

func (h cleanupCandidateHeap) Swap(i, j int) {
	h.items[i], h.items[j] = h.items[j], h.items[i]
	h.index[h.items[i].Path] = i
	h.index[h.items[j].Path] = j
}

func (h *cleanupCandidateHeap) Push(x any) {
	candidate, ok := x.(FilesystemCleanupCandidate)
	if !ok {
		return
	}
	h.index[candidate.Path] = len(h.items)
	h.items = append(h.items, candidate)
}

func (h *cleanupCandidateHeap) Pop() any {
	last := len(h.items) - 1
	candidate := h.items[last]
	h.items = h.items[:last]
	delete(h.index, candidate.Path)
	return candidate
}

func newCleanupCandidateSet(limit int) *cleanupCandidateSet {
	return &cleanupCandidateSet{
		limit: limit,
		heap:  cleanupCandidateHeap{items: make([]FilesystemCleanupCandidate, 0, limit), index: map[string]int{}},
	}
}

func (s *cleanupCandidateSet) Add(candidate FilesystemCleanupCandidate) {
	if s.limit <= 0 || candidate.Path == "" || candidate.SizeBytes <= 0 {
		return
	}
	if at, ok := s.heap.index[candidate.Path]; ok {
		if candidate.SizeBytes <= s.heap.items[at].SizeBytes {
			return
		}
		s.heap.items[at] = candidate
		heap.Fix(&s.heap, at)
		return
	}
	if len(s.heap.items) < s.limit {
		heap.Push(&s.heap, candidate)
		return
	}
	if candidate.SizeBytes <= s.heap.items[0].SizeBytes {
		return
	}
	heap.Pop(&s.heap)
	heap.Push(&s.heap, candidate)
}

func (s *cleanupCandidateSet) Sorted() []FilesystemCleanupCandidate {
	out := make([]FilesystemCleanupCandidate, len(s.heap.items))
	copy(out, s.heap.items)
	sort.Slice(out, func(i, j int) bool { return out[i].SizeBytes > out[j].SizeBytes })
	return out
}
```

Add `"container/heap"` to the import block at `filesystem_analysis.go:3-13`.

- [ ] **Step 5: Implement the permission counter and wire everything up** — replace `estimateDirectorySize`'s signature and its permission branch:

```go
func estimateDirectorySize(root string, deadline time.Time, maxEntries int, permissionDenied *int64) (sizeBytes int64, filesScanned int64, timedOut bool, err error) {
```

```go
			children, readErr := os.ReadDir(current)
			if readErr != nil {
				if os.IsPermission(readErr) {
					// Counted, not silently skipped: a trash directory the
					// agent cannot read makes the reported size a lower bound,
					// and permissionDeniedCount is how the UI says so.
					if permissionDenied != nil {
						*permissionDenied++
					}
					continue
				}
				return sizeBytes, filesScanned, false, readErr
			}
```

In `AnalyzeFilesystem`, replace the accumulator declarations (`:196-198`):

```go
	tempBytes := make(map[string]int64)
	duplicateByKey := make(map[string]*duplicateGroup)
	cleanupSet := newCleanupCandidateSet(maxFSCleanupCandidates)
	var duplicateTrackingTruncated bool
```

the per-file duplicate call (`:448`):

```go
			if addDuplicateCandidate(duplicateByKey, entryPath, fileSize) {
				duplicateTrackingTruncated = true
			}
```

the per-file candidate append (`:421-428`) — `cleanupSet.Add(FilesystemCleanupCandidate{...})` in place of `addCleanupCandidate(cleanupByPath, ..., maxFSCleanupCandidates)`; the trash-branch call from Task 4 likewise; the response build (`:607`):

```go
	cleanupCandidates := cleanupSet.Sorted()
```

and the summary (`:620-626`):

```go
		Summary: FilesystemAnalysisSummary{
			FilesScanned:               filesScanned,
			DirsScanned:                dirsScanned,
			BytesScanned:               bytesScanned,
			MaxDepthReached:            maxDepthReached,
			PermissionDeniedCount:      permissionDeniedCount,
			DuplicateTrackingTruncated: duplicateTrackingTruncated,
		},
```

Finally, in `agent/internal/remote/tools/types.go`, extend `FilesystemAnalysisSummary` (`:598-605`):

```go
// FilesystemAnalysisSummary captures high-level scan stats.
type FilesystemAnalysisSummary struct {
	FilesScanned          int64 `json:"filesScanned"`
	DirsScanned           int64 `json:"dirsScanned"`
	BytesScanned          int64 `json:"bytesScanned"`
	MaxDepthReached       int   `json:"maxDepthReached"`
	PermissionDeniedCount int64 `json:"permissionDeniedCount"`
	// Set when the duplicate-group map hit maxFSDuplicateGroups and stopped
	// admitting new keys, so "no duplicates found" can be distinguished from
	// "we stopped looking". omitempty keeps every existing payload byte-stable.
	DuplicateTrackingTruncated bool `json:"duplicateTrackingTruncated,omitempty"`
}
```

- [ ] **Step 6: Run them and watch them pass**

```bash
cd agent && gofmt -l internal/remote/tools/ && go test -race ./internal/remote/tools/...
```

Expected: `gofmt -l` silent, the whole `tools` package green. Delete the now-superseded `TestBuildCheckpointPayloadMarksTruncation` (`filesystem_analysis_test.go:38-55`) — the JSON round-trip replaces it, and leaving both keeps the `[]map[string]any` assertion alive.

- [ ] **Step 7: Commit**

```bash
git add agent/internal/remote/tools/filesystem_analysis.go agent/internal/remote/tools/types.go agent/internal/remote/tools/filesystem_analysis_test.go agent/internal/remote/tools/filesystem_analysis_opt_test.go
git commit -m "$(cat <<'EOF'
fix(agent): bound the duplicate map, keep cleanup candidates top-by-size (defect 7)

addDuplicateCandidate was unbounded (one map entry per distinct basename on a
10M-file scan) and addCleanupCandidate capped by INSERTION ORDER, so a late
40 GB candidate could never displace an early 1 KB one while the UI presents
the list as "biggest wins". The duplicate map is capped at 50k keys and reports
summary.duplicateTrackingTruncated; candidates move to a min-heap keyed on size.

estimateDirectorySize now counts permission denials instead of skipping them,
and the checkpoint payload is asserted through a JSON round-trip rather than a
[]map[string]any shape check.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §2 defect 7, §6.4

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `file_delete` gains `cleanupGuard`, `bytesFreed` and `skippedLocked`

**Files:**
- Modify: `agent/internal/remote/tools/fileops.go` — `DeleteFile` (`:597-665`)
- Create: `agent/internal/remote/tools/fileops_link_unix.go`
- Create: `agent/internal/remote/tools/fileops_link_windows.go`
- Create: `agent/internal/remote/tools/fileops_link_windows_test.go` (Test — runs only on the Windows CI runner)
- Create: `agent/internal/remote/tools/fileops_cleanup_test.go` (Test)
- Modify: `agent/internal/remote/tools/fileops_delete_boundary_test.go` (Test — append the `$Recycle.Bin` cases)

**Interfaces:**
- Consumes: `matchCleanupRule`, `isCleanupDeniedRoot`, `CleanupGuardRejectedPrefix` (Task 2).
- Produces:
  ```go
  func isReparsePoint(info os.FileInfo) bool          // build-tagged; false on POSIX
  func isSharingViolation(err error) bool             // build-tagged; false on POSIX
  func sumTreeSizeAt(root *os.Root, rel string) int64 // logical bytes, handle-relative
  type cleanupTarget struct { root *os.Root; rel string; match *cleanupRuleMatch }
  func openCleanupTarget(goos, cleanPath, volumeRoot string) (*cleanupTarget, error)
  func (t *cleanupTarget) close()
  func cleanupGuardRejection(info os.FileInfo, match *cleanupRuleMatch, recursive bool, previewedAt time.Time, now time.Time) error
  ```
  `file_delete` payload gains `cleanupGuard: bool`, `contentsOnly: bool`, `volumeRoot: string` and `previewedAt: string` (RFC3339); all default-absent, so every non-cleanup caller is unchanged. Its success result gains `bytesFreed: int64` (**logical bytes** — the agent's own `Lstat` sum; the pre-W01 result carried no byte count at all, `fileops.go:660-664`) and `skippedLocked: []string`.

- [ ] **Step 1: Write the failing tests** — create `agent/internal/remote/tools/fileops_cleanup_test.go`:

```go
package tools

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// cleanupGuard is defence in depth against a FORGED execute body (spec §10.2):
// the API already re-filters through the rule table, and the agent re-checks
// membership before it unlinks anything. These cases drive the pure seam with
// an explicit GOOS so both path grammars are exercised from any host.
func TestCleanupGuardRejection(t *testing.T) {
	tmpDir := t.TempDir()
	regular := filepath.Join(tmpDir, "regular.bin")
	if err := os.WriteFile(regular, []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	info, err := os.Lstat(regular)
	if err != nil {
		t.Fatalf("lstat: %v", err)
	}

	if err := cleanupGuardRejection("linux", "/tmp/build.tmp", info); err != nil {
		t.Errorf("a path inside a cleanup rule must pass the guard, got %v", err)
	}

	err = cleanupGuardRejection("darwin", "/Users/alice/Documents/taxes.pdf", info)
	if err == nil || !strings.Contains(err.Error(), "matches no cleanup rule") {
		t.Errorf("a user document must be rejected for rule membership, got %v", err)
	}
	if err != nil && !strings.HasPrefix(err.Error(), CleanupGuardRejectedPrefix) {
		t.Errorf("rejection must carry the pinned prefix, got %q", err.Error())
	}

	err = cleanupGuardRejection("linux", "/etc/passwd", info)
	if err == nil || !strings.Contains(err.Error(), "cleanup-denied root") {
		t.Errorf("a denied root must be rejected as such, got %v", err)
	}
}

func TestCleanupGuardRejectsSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX symlink fixture; Windows reparse points are covered by isReparsePoint")
	}
	tmpDir := t.TempDir()
	target := filepath.Join(tmpDir, "target.bin")
	if err := os.WriteFile(target, []byte("keep me"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	link := filepath.Join(tmpDir, "link.tmp")
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	result := DeleteFile(map[string]any{
		"path":         link,
		"permanent":    true,
		"cleanupGuard": true,
	})
	if result.Status != "failed" {
		t.Fatalf("expected the guard to refuse a symlink, got %q", result.Status)
	}
	if !strings.HasPrefix(result.Error, CleanupGuardRejectedPrefix) {
		t.Fatalf("expected the pinned rejection prefix, got %q", result.Error)
	}
	if !strings.Contains(result.Error, "symlink") {
		t.Fatalf("expected the reason to name the symlink, got %q", result.Error)
	}
	if _, err := os.Lstat(link); err != nil {
		t.Error("the symlink itself must survive a refusal")
	}
	if _, err := os.Stat(target); err != nil {
		t.Error("the symlink TARGET must survive")
	}
}

// Spec §6.3: the result gains bytesFreed so the API can report what was really
// reclaimed instead of summing stale snapshot sizes.
// SPEC §13 ROW 1 — the finding this redesign exists for. Preview
// `<anchor>/.cache/sub/x`, then replace `sub` with a symlink to a directory
// outside the tree before execute. A leaf-only Lstat sees an ordinary file and
// deletes the WRONG one. Deleting through an os.Root handle refuses it, because
// the runtime checks every component of the traversal, not just the leaf.
func TestCleanupGuardRefusesAnAncestorSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX symlink fixture; the Windows junction case is fileops_link_windows_test.go")
	}
	outside := t.TempDir()
	victim := filepath.Join(outside, "x")
	if err := os.WriteFile(victim, []byte("do not delete"), 0o644); err != nil {
		t.Fatalf("write victim: %v", err)
	}

	home := t.TempDir()
	cacheDir := filepath.Join(home, ".cache")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// `sub` is a symlink OUT of the tree, planted between preview and execute.
	if err := os.Symlink(outside, filepath.Join(cacheDir, "sub")); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	target, err := openCleanupTarget("linux", filepath.Join(cacheDir, "sub", "x"), home)
	if err == nil {
		target.close()
		t.Fatal("expected the handle-based open to refuse a path whose ancestor escapes the anchor")
	}
	if !strings.HasPrefix(err.Error(), CleanupGuardRejectedPrefix) {
		t.Fatalf("expected the pinned rejection prefix, got %q", err.Error())
	}
	if _, statErr := os.Stat(victim); statErr != nil {
		t.Fatal("the file outside the tree must survive")
	}
}

// The anchor's own real path must sit on the dispatched volume, so a junction
// or symlink AT the anchor cannot relocate the whole operation.
func TestOpenCleanupTargetRejectsAnchorOffTheVolume(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fixture")
	}
	home := t.TempDir()
	elsewhere := t.TempDir()
	cacheDir := filepath.Join(home, ".cache")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(cacheDir, "blob"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	target, err := openCleanupTarget("linux", filepath.Join(cacheDir, "blob"), elsewhere)
	if err == nil {
		target.close()
		t.Fatal("expected the volume check to refuse an anchor outside the dispatched volumeRoot")
	}
	if !strings.Contains(err.Error(), "volume") {
		t.Fatalf("expected the reason to name the volume check, got %q", err.Error())
	}
}

// §13 row 2: identity, type, age and freshness are re-checked at EXECUTE.
func TestCleanupGuardRejectionLiveChecks(t *testing.T) {
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	tmpDir := t.TempDir()
	regular := filepath.Join(tmpDir, "regular.bin")
	if err := os.WriteFile(regular, []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	fileInfo, err := os.Lstat(regular)
	if err != nil {
		t.Fatalf("lstat: %v", err)
	}
	dirInfo, err := os.Lstat(tmpDir)
	if err != nil {
		t.Fatalf("lstat dir: %v", err)
	}
	tempMatch := &cleanupRuleMatch{Category: "temp_files", Granularity: "file", MinAge: 24 * time.Hour}
	trashMatch := &cleanupRuleMatch{Category: "trash", Granularity: "contents"}

	// A file-granularity target that has BECOME a directory is refused: those
	// rules dispatch recursive:false and a subtree delete is not what was
	// previewed.
	if err := cleanupGuardRejection(dirInfo, tempMatch, false, time.Time{}, now); err == nil ||
		!strings.Contains(err.Error(), "not a regular file") {
		t.Errorf("expected a not-a-regular-file rejection, got %v", err)
	}
	if err := cleanupGuardRejection(dirInfo, trashMatch, true, time.Time{}, now); err != nil {
		t.Errorf("a contents rule must accept a directory, got %v", err)
	}

	// Min-age is re-evaluated against the CURRENT mtime, not the snapshot's.
	fresh := fakeFileInfo{FileInfo: fileInfo, modTime: now.Add(-1 * time.Hour)}
	if err := cleanupGuardRejection(fresh, tempMatch, false, time.Time{}, now); err == nil ||
		!strings.Contains(err.Error(), "newer than the rule's minimum age") {
		t.Errorf("expected a min-age rejection, got %v", err)
	}
	aged := fakeFileInfo{FileInfo: fileInfo, modTime: now.Add(-48 * time.Hour)}
	if err := cleanupGuardRejection(aged, tempMatch, false, time.Time{}, now); err != nil {
		t.Errorf("an aged temp file must pass, got %v", err)
	}

	// A file modified AFTER the operator previewed it is a different file now.
	previewedAt := now.Add(-2 * time.Hour)
	touched := fakeFileInfo{FileInfo: fileInfo, modTime: now.Add(-1 * time.Hour)}
	if err := cleanupGuardRejection(touched, trashMatch, true, previewedAt, now); err == nil ||
		!strings.Contains(err.Error(), "modified after the preview") {
		t.Errorf("expected a freshness rejection, got %v", err)
	}
	stable := fakeFileInfo{FileInfo: fileInfo, modTime: now.Add(-6 * time.Hour)}
	if err := cleanupGuardRejection(stable, trashMatch, true, previewedAt, now); err != nil {
		t.Errorf("an untouched target must pass, got %v", err)
	}
}

// fakeFileInfo overrides ModTime so the age and freshness gates are driven
// deterministically without sleeping or back-dating real files.
type fakeFileInfo struct {
	os.FileInfo
	modTime time.Time
}

func (f fakeFileInfo) ModTime() time.Time { return f.modTime }

func TestDeleteFilePermanentReportsBytesFreed(t *testing.T) {
	tmpDir := t.TempDir()
	file := filepath.Join(tmpDir, "blob.bin")
	if err := os.WriteFile(file, make([]byte, 4096), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	var payload struct {
		Path          string   `json:"path"`
		Deleted       bool     `json:"deleted"`
		Permanent     bool     `json:"permanent"`
		BytesFreed    int64    `json:"bytesFreed"`
		SkippedLocked []string `json:"skippedLocked"`
	}
	decodeSuccessPayload(t, DeleteFile(map[string]any{"path": file, "permanent": true}), &payload)
	if !payload.Deleted || payload.BytesFreed != 4096 {
		t.Fatalf("expected deleted with bytesFreed=4096, got %+v", payload)
	}
	if len(payload.SkippedLocked) != 0 {
		t.Fatalf("expected no locked paths, got %v", payload.SkippedLocked)
	}
}

func TestDeleteFilePermanentRecursiveSumsTreeSize(t *testing.T) {
	tmpDir := t.TempDir()
	tree := filepath.Join(tmpDir, "a", "b")
	if err := os.MkdirAll(tree, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(tree, "one"), make([]byte, 1000), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.WriteFile(filepath.Join(tmpDir, "a", "two"), make([]byte, 24), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	var payload struct {
		BytesFreed int64 `json:"bytesFreed"`
	}
	decodeSuccessPayload(t, DeleteFile(map[string]any{
		"path":      filepath.Join(tmpDir, "a"),
		"permanent": true,
		"recursive": true,
	}), &payload)
	if payload.BytesFreed != 1024 {
		t.Fatalf("expected bytesFreed=1024 for the whole tree, got %d", payload.BytesFreed)
	}
}

func TestIsSharingViolationIsFalseOnPosix(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("covered by fileops_link_windows_test.go")
	}
	if isSharingViolation(os.ErrPermission) {
		t.Error("POSIX has no sharing violation; a permission error must not be reported as a lock")
	}
	if isSharingViolation(nil) {
		t.Error("nil is not a sharing violation")
	}
}

func TestIsReparsePointIsFalseOnPosix(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("covered by fileops_link_windows_test.go")
	}
	tmpDir := t.TempDir()
	file := filepath.Join(tmpDir, "x")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	info, err := os.Lstat(file)
	if err != nil {
		t.Fatalf("lstat: %v", err)
	}
	if isReparsePoint(info) {
		t.Error("POSIX has no reparse points")
	}
}
```

and append to `agent/internal/remote/tools/fileops_delete_boundary_test.go`:

```go
// Spec §6.3 / §11: the recycle-bin semantics depend on exactly this boundary.
// The bin ROOT is depth 1 and must stay refused — which is why the old
// C:\$Recycle.Bin candidate could never be deleted — while a per-SID directory
// is depth 2 and its contents are reachable through contentsOnly.
func TestIsRecursiveDeleteBoundary_RecycleBin(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{`C:\$Recycle.Bin`, true},
		{`D:\$Recycle.Bin`, true},
		{`C:\$Recycle.Bin\S-1-5-21-1`, false},
		{`D:\$Recycle.Bin\S-1-5-18`, false},
		{`C:\$Recycle.Bin\S-1-5-21-1\$RABCDEF.txt`, false},
	}
	for _, c := range cases {
		if got := isRecursiveDeleteBoundaryFor(c.path, true); got != c.want {
			t.Errorf("isRecursiveDeleteBoundaryFor(%q, windows) = %v, want %v", c.path, got, c.want)
		}
	}
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd agent && go test -race ./internal/remote/tools/... -run 'CleanupGuard|BytesFreed|SharingViolation|ReparsePoint|RecycleBin'
```

Expected failure: compile errors — `undefined: cleanupGuardRejection`, `undefined: isSharingViolation`, `undefined: isReparsePoint`; then `TestDeleteFilePermanentReportsBytesFreed` fails with "expected deleted with bytesFreed=4096, got {Path:... Deleted:true Permanent:true BytesFreed:0 SkippedLocked:[]}" because the permanent branch does not report sizes yet.

- [ ] **Step 3: Implement the platform helpers** — create `agent/internal/remote/tools/fileops_link_unix.go`:

```go
//go:build !windows

package tools

import "os"

// isReparsePoint is Windows-only. On POSIX, os.ModeSymlink already covers every
// link the cleanup path can meet, and DeleteFile checks that separately.
func isReparsePoint(_ os.FileInfo) bool {
	return false
}

// isSharingViolation is Windows-only. POSIX unlink succeeds on an open file, so
// there is no "locked file" condition to report — and reporting a permission
// error as a lock would tell an operator to close an application that has
// nothing to do with the failure.
func isSharingViolation(_ error) bool {
	return false
}
```

and `agent/internal/remote/tools/fileops_link_windows.go`:

```go
//go:build windows

package tools

import (
	"errors"
	"os"
	"syscall"
)

// isReparsePoint reports whether info names a reparse point (a junction, a
// mount point, or a OneDrive/cloud placeholder). Go reports a symlink through
// os.ModeSymlink, but a junction is NOT a symlink: without this check a
// contentsOnly delete of a directory containing a junction would recurse into
// the junction's target. Recursing is what we refuse to do (spec §10.4).
func isReparsePoint(info os.FileInfo) bool {
	if info == nil {
		return false
	}
	data, ok := info.Sys().(*syscall.Win32FileAttributeData)
	if !ok {
		return false
	}
	return data.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0
}

// isSharingViolation reports whether err is a Windows file-lock error:
// ERROR_SHARING_VIOLATION (32) or ERROR_LOCK_VIOLATION (33). Cleanup NEVER
// forces a locked file (spec §10.5) — it reports it as skipped_locked so the
// operator can close the application and re-run.
func isSharingViolation(err error) bool {
	if err == nil {
		return false
	}
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return false
	}
	return errno == syscall.Errno(32) || errno == syscall.Errno(33)
}
```

and `agent/internal/remote/tools/fileops_link_windows_test.go`:

```go
//go:build windows

package tools

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
)

// §13 row 1, Windows half: a JUNCTION is not a symlink and Go does not report
// it through os.ModeSymlink, so a pathname-based delete would traverse it. The
// os.Root handle refuses it in the runtime.
func TestCleanupGuardRefusesAnAncestorJunction(t *testing.T) {
	outside := t.TempDir()
	victim := filepath.Join(outside, "x")
	if err := os.WriteFile(victim, []byte("do not delete"), 0o644); err != nil {
		t.Fatalf("write victim: %v", err)
	}

	volumeRoot := t.TempDir()
	tempDir := filepath.Join(volumeRoot, "users", "alice", "appdata", "local", "temp")
	if err := os.MkdirAll(tempDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	junction := filepath.Join(tempDir, "sub")
	// mklink /J creates a directory junction without the SeCreateSymbolicLink
	// privilege that developer mode grants for symlinks.
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", junction, outside).CombinedOutput(); err != nil {
		t.Skipf("mklink /J unavailable in this environment: %v (%s)", err, out)
	}

	target, err := openCleanupTarget("windows", filepath.Join(junction, "x"), volumeRoot)
	if err == nil {
		target.close()
		t.Fatal("expected the handle-based open to refuse a path whose ancestor is a junction out of the anchor")
	}
	if _, statErr := os.Stat(victim); statErr != nil {
		t.Fatal("the file outside the tree must survive")
	}
}

func TestIsSharingViolationRecognisesWindowsLockErrnos(t *testing.T) {
	if !isSharingViolation(syscall.Errno(32)) {
		t.Error("ERROR_SHARING_VIOLATION must be recognised")
	}
	if !isSharingViolation(syscall.Errno(33)) {
		t.Error("ERROR_LOCK_VIOLATION must be recognised")
	}
	if !isSharingViolation(fmt.Errorf("remove x: %w", syscall.Errno(32))) {
		t.Error("a wrapped errno must be recognised")
	}
	if isSharingViolation(syscall.Errno(5)) {
		t.Error("ERROR_ACCESS_DENIED is not a lock")
	}
	if isSharingViolation(os.ErrNotExist) {
		t.Error("a missing file is not a lock")
	}
}
```

- [ ] **Step 4: Implement handle-based deletion and the size reporting** — in `agent/internal/remote/tools/fileops.go`, add above `DeleteFile`:

```go
// sumTreeSizeAt totals the regular-file bytes under `rel`, through the confined
// root handle. These are LOGICAL bytes (the sum of Lstat sizes): sparse files,
// compression, dedup and cluster slack all make the real free-space delta
// differ. The measured figure arrives with the native cleaners in W04.
//
// fs.WalkDir over root.FS() uses ReadDir entries, so it never follows a link,
// and the Root confines every lookup to the anchor.
func sumTreeSizeAt(root *os.Root, rel string) int64 {
	var total int64
	_ = fs.WalkDir(root.FS(), filepath.ToSlash(rel), func(_ string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil || d == nil || d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		total += info.Size()
		return nil
	})
	return total
}

// cleanupTarget is a cleanup victim addressed by a DIRECTORY HANDLE plus a
// relative name, never by a pathname (spec §13 row 1).
type cleanupTarget struct {
	root  *os.Root
	rel   string
	match *cleanupRuleMatch
}

func (t *cleanupTarget) close() {
	if t != nil && t.root != nil {
		_ = t.root.Close()
	}
}

// openCleanupTarget resolves cleanPath into a confined handle.
//
// Lstat-then-Remove on a literal path confines nothing: preview
// `~/.cache/sub/x`, swap `sub` for a symlink to /etc before execute, and the
// leaf Lstat sees an ordinary file at /etc/x. So the agent opens the matched
// rule's ANCHOR — the wildcard-free literal prefix of the pattern, which the
// rule author fixed and no attacker can choose — and every later operation goes
// through that *os.Root. The runtime then refuses an absolute symlink, and any
// relative symlink or reparse point that escapes the anchor, at EVERY component
// of the traversal.
//
// The anchor's own real path must also sit on the dispatched volumeRoot, so a
// junction at the anchor itself cannot relocate the whole operation.
func openCleanupTarget(goos, cleanPath, volumeRoot string) (*cleanupTarget, error) {
	if isCleanupDeniedRootFor(goos, cleanPath) {
		return nil, fmt.Errorf("%s %s is under a cleanup-denied root", CleanupGuardRejectedPrefix, cleanPath)
	}
	match := matchCleanupRuleFor(goos, cleanPath)
	if match == nil {
		return nil, fmt.Errorf("%s %s matches no cleanup rule", CleanupGuardRejectedPrefix, cleanPath)
	}
	anchor, ok := cleanupRuleAnchorFor(goos, cleanPath)
	if !ok {
		return nil, fmt.Errorf("%s %s has no confinement anchor", CleanupGuardRejectedPrefix, cleanPath)
	}
	if volumeRoot == "" {
		// Only a non-cleanup caller can reach this; derive the conservative
		// default rather than skipping the check.
		if goos == "windows" {
			volumeRoot = filepath.VolumeName(filepath.Clean(cleanPath)) + string(filepath.Separator)
		} else {
			volumeRoot = string(filepath.Separator)
		}
	}
	if !isRealPathUnderRoot(volumeRoot, anchor) {
		return nil, fmt.Errorf("%s anchor %s is not on volume %s", CleanupGuardRejectedPrefix, anchor, volumeRoot)
	}

	rel, err := filepath.Rel(anchor, filepath.Clean(cleanPath))
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return nil, fmt.Errorf("%s %s is not inside its anchor %s", CleanupGuardRejectedPrefix, cleanPath, anchor)
	}

	root, err := os.OpenRoot(anchor)
	if err != nil {
		return nil, fmt.Errorf("%s cannot open anchor %s: %v", CleanupGuardRejectedPrefix, anchor, err)
	}
	return &cleanupTarget{root: root, rel: rel, match: match}, nil
}

// cleanupGuardRejection is the live re-check (spec §13 row 2). Pinning a path
// pins a STRING; between preview and execute the thing at that path can change
// type, age or contents.
//
// Order matters: link checks come first, so a symlink is refused by identity
// even when its path would otherwise match a rule.
func cleanupGuardRejection(
	info os.FileInfo,
	match *cleanupRuleMatch,
	recursive bool,
	previewedAt time.Time,
	now time.Time,
) error {
	if info == nil || match == nil {
		return fmt.Errorf("%s target could not be inspected", CleanupGuardRejectedPrefix)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s %s is a symlink", CleanupGuardRejectedPrefix, info.Name())
	}
	if isReparsePoint(info) {
		return fmt.Errorf("%s %s is a reparse point", CleanupGuardRejectedPrefix, info.Name())
	}
	// File-granularity rules dispatch recursive:false. A target that has become
	// a directory since the preview is refused rather than deleted as a subtree.
	if !recursive && !info.Mode().IsRegular() {
		return fmt.Errorf("%s %s is not a regular file", CleanupGuardRejectedPrefix, info.Name())
	}
	if recursive && !info.IsDir() && !info.Mode().IsRegular() {
		return fmt.Errorf("%s %s is not a regular file or directory", CleanupGuardRejectedPrefix, info.Name())
	}
	if match.MinAge > 0 && now.Sub(info.ModTime()) < match.MinAge {
		return fmt.Errorf("%s %s is newer than the rule's minimum age", CleanupGuardRejectedPrefix, info.Name())
	}
	if !previewedAt.IsZero() && info.ModTime().After(previewedAt) {
		return fmt.Errorf("%s %s was modified after the preview", CleanupGuardRejectedPrefix, info.Name())
	}
	return nil
}

// newLockedDeleteResult reports a Windows file lock as a SUCCESS carrying
// `deleted: false` rather than as a failure, because skippedLocked only exists
// on the success envelope (NewErrorResult carries no body). The API maps
// bytesFreed == 0 with a non-empty skippedLocked onto `skipped_locked`, which
// is a different operator action from "it failed" — close the app and re-run.
func newLockedDeleteResult(cleanPath string, start time.Time) CommandResult {
	return NewSuccessResult(map[string]any{
		"path":          cleanPath,
		"deleted":       false,
		"permanent":     true,
		"bytesFreed":    int64(0),
		"skippedLocked": []string{cleanPath},
	}, time.Since(start).Milliseconds())
}
```

Add `"io/fs"`, `"runtime"`, `"strings"` and `"time"` to the `fileops.go` import block if any is missing.

Then in `DeleteFile`, after `permanent := GetPayloadBool(payload, "permanent", false)` (`:606`):

```go
	// Cleanup-only flags. Absent on every non-cleanup caller, and no OLD agent
	// ever receives them: cleanup-execute refuses any agent below
	// MIN_AGENT_VERSION_CLEANUP_GUARD with 409 agent_update_required, because
	// an agent that ignores `cleanupGuard` while honouring `permanent` would
	// perform an UNGUARDED permanent delete (spec §13 row 3).
	cleanupGuard := GetPayloadBool(payload, "cleanupGuard", false)
	contentsOnly := GetPayloadBool(payload, "contentsOnly", false)
	volumeRoot := GetPayloadString(payload, "volumeRoot", "")
	previewedAtRaw := GetPayloadString(payload, "previewedAt", "")
	if contentsOnly && !permanent {
		return NewErrorResult(fmt.Errorf("contentsOnly requires permanent"), time.Since(start).Milliseconds())
	}
	var previewedAt time.Time
	if previewedAtRaw != "" {
		parsed, parseErr := time.Parse(time.RFC3339, previewedAtRaw)
		if parseErr != nil {
			// Present-but-garbage is a dispatcher bug, not an absent field.
			return NewErrorResult(
				fmt.Errorf("%s previewedAt is not RFC3339: %q", CleanupGuardRejectedPrefix, previewedAtRaw),
				time.Since(start).Milliseconds(),
			)
		}
		previewedAt = parsed
	}
```

Replace the stat block (`:640-647`) with the two-mode resolution — pathname for the file browser, handle for cleanup:

```go
	// The cleanup path never addresses a file by pathname. Every other caller
	// keeps os.Stat, which is what the file browser has always used.
	var info os.FileInfo
	var err error
	var target *cleanupTarget
	if cleanupGuard {
		target, err = openCleanupTarget(runtime.GOOS, cleanPath, volumeRoot)
		if err != nil {
			return NewErrorResult(err, time.Since(start).Milliseconds())
		}
		defer target.close()
		info, err = target.root.Lstat(target.rel)
		if err != nil {
			if os.IsNotExist(err) {
				return NewErrorResult(fmt.Errorf("path does not exist: %s", cleanPath), time.Since(start).Milliseconds())
			}
			// An escape refused by the Root surfaces here, which is the whole
			// point: the ancestor was swapped after the preview.
			return NewErrorResult(
				fmt.Errorf("%s %s could not be opened inside its anchor: %v", CleanupGuardRejectedPrefix, cleanPath, err),
				time.Since(start).Milliseconds(),
			)
		}
		if guardErr := cleanupGuardRejection(info, target.match, recursive, previewedAt, time.Now()); guardErr != nil {
			return NewErrorResult(guardErr, time.Since(start).Milliseconds())
		}
	} else {
		info, err = os.Stat(cleanPath)
		if err != nil {
			if os.IsNotExist(err) {
				return NewErrorResult(fmt.Errorf("path does not exist: %s", cleanPath), time.Since(start).Milliseconds())
			}
			return NewErrorResult(fmt.Errorf("failed to stat path: %w", err), time.Since(start).Milliseconds())
		}
	}
```

and replace the permanent branch (`:649-665`):

```go
	// Permanent delete — bypass trash
	if permanent {
		if contentsOnly {
			if target == nil {
				return NewErrorResult(fmt.Errorf("contentsOnly requires cleanupGuard"), time.Since(start).Milliseconds())
			}
			return deleteDirectoryContents(target, cleanPath, info, start)
		}

		var bytesFreed int64
		if target != nil {
			if info.IsDir() && recursive {
				bytesFreed = sumTreeSizeAt(target.root, target.rel)
				err = target.root.RemoveAll(target.rel)
			} else {
				bytesFreed = info.Size()
				err = target.root.Remove(target.rel)
			}
		} else if info.IsDir() && recursive {
			err = os.RemoveAll(cleanPath)
		} else {
			bytesFreed = info.Size()
			err = os.Remove(cleanPath)
		}
		if err != nil {
			if isSharingViolation(err) {
				return newLockedDeleteResult(cleanPath, start)
			}
			return NewErrorResult(fmt.Errorf("failed to remove path: %w", err), time.Since(start).Milliseconds())
		}
		return NewSuccessResult(map[string]any{
			"path":          cleanPath,
			"deleted":       true,
			"permanent":     true,
			"bytesFreed":    bytesFreed,
			"skippedLocked": []string{},
		}, time.Since(start).Milliseconds())
	}
```

`deleteDirectoryContents` arrives in Task 7; until then, stub it as `func deleteDirectoryContents(_ *cleanupTarget, cleanPath string, _ os.FileInfo, start time.Time) CommandResult { return NewErrorResult(fmt.Errorf("contentsOnly is not implemented"), time.Since(start).Milliseconds()) }` so the package compiles, and delete the stub in Task 7's Step 3.

- [ ] **Step 5: Run them and watch them pass**

```bash
cd agent && gofmt -l internal/remote/tools/ && go test -race ./internal/remote/tools/...
```

Expected: `gofmt -l` silent; every `fileops` test green, including the pre-existing `TestDeleteFile_PermanentSkipsTrash` and `TestDeleteFile_MovesToTrash` (the trash branch is untouched).

- [ ] **Step 6: Commit**

```bash
git add agent/internal/remote/tools/fileops.go agent/internal/remote/tools/fileops_link_unix.go agent/internal/remote/tools/fileops_link_windows.go agent/internal/remote/tools/fileops_link_windows_test.go agent/internal/remote/tools/fileops_cleanup_test.go agent/internal/remote/tools/fileops_delete_boundary_test.go
git commit -m "$(cat <<'EOF'
feat(agent): file_delete cleanupGuard, bytesFreed and skippedLocked

DeleteFile used os.Stat, which FOLLOWS links, and had no second opinion about
whether a target belonged to a cleanup at all. Under cleanupGuard it now lstats,
refuses symlinks and Windows reparse points, refuses cleanup-denied roots and
refuses anything the embedded rule table does not claim — so a forged execute
body that reaches the device still deletes nothing.

Permanent deletes report bytesFreed, and a Windows sharing violation comes back
as a SUCCESS with deleted:false + skippedLocked rather than an opaque failure:
locked files are never forced.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §6.3, §10.2, §10.4, §10.5

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `contentsOnly` — empty a bin without deleting the bin

**Files:**
- Modify: `agent/internal/remote/tools/fileops.go` — replace the `deleteDirectoryContents` stub from Task 6
- Modify: `agent/internal/remote/tools/fileops_cleanup_test.go` (Test — append)

**Interfaces:**
- Consumes: `isReparsePoint`, `isSharingViolation`, `sumTreeSize` (Task 6).
- Produces:
  ```go
  func deleteDirectoryContents(target *cleanupTarget, cleanPath string, info os.FileInfo, start time.Time) CommandResult
  ```
  Result body: `{ path, deleted, permanent: true, contentsOnly: true, bytesFreed, skippedLocked: []string, skippedLinks: []string, failedChildren: []string }`. `deleted` is true only when **every** child went; any `failedChildren` entry makes the API report `status: 'partial'` (spec §13 row 13).

- [ ] **Step 1: Write the failing tests** — append to `agent/internal/remote/tools/fileops_cleanup_test.go`:

```go
type contentsOnlyPayload struct {
	Path           string   `json:"path"`
	Deleted        bool     `json:"deleted"`
	ContentsOnly   bool     `json:"contentsOnly"`
	BytesFreed     int64    `json:"bytesFreed"`
	SkippedLocked  []string `json:"skippedLocked"`
	SkippedLinks   []string `json:"skippedLinks"`
	FailedChildren []string `json:"failedChildren"`
}

// The recycle-bin fixture from spec §11: the SID directory is emptied, the
// directory itself survives, and desktop.ini (which Explorer needs to render
// the bin) is preserved.
func TestDeleteFileContentsOnlyEmptiesBinAndKeepsDesktopIni(t *testing.T) {
	tmpDir := t.TempDir()
	sidDir := filepath.Join(tmpDir, "$Recycle.Bin", "S-1-5-21-1")
	if err := os.MkdirAll(filepath.Join(sidDir, "nested"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sidDir, "desktop.ini"), []byte("ini"), 0o644); err != nil {
		t.Fatalf("write desktop.ini: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sidDir, "$RABCDEF.txt"), make([]byte, 2048), 0o644); err != nil {
		t.Fatalf("write bin entry: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sidDir, "nested", "deep.bin"), make([]byte, 1024), 0o644); err != nil {
		t.Fatalf("write nested entry: %v", err)
	}

	var payload contentsOnlyPayload
	decodeSuccessPayload(t, DeleteFile(map[string]any{
		"path":         sidDir,
		"permanent":    true,
		"recursive":    true,
		"contentsOnly": true,
		"cleanupGuard": true,
		"volumeRoot":   tmpDir,
	}), &payload)

	if !payload.ContentsOnly || !payload.Deleted {
		t.Fatalf("expected a completed contentsOnly delete, got %+v", payload)
	}
	if payload.BytesFreed != 3072 {
		t.Errorf("expected bytesFreed=3072 (2048 + 1024, desktop.ini preserved), got %d", payload.BytesFreed)
	}
	if _, err := os.Stat(sidDir); err != nil {
		t.Fatal("the SID directory itself must survive a contentsOnly delete")
	}
	if _, err := os.Stat(filepath.Join(sidDir, "desktop.ini")); err != nil {
		t.Error("desktop.ini must be preserved")
	}
	if _, err := os.Stat(filepath.Join(sidDir, "$RABCDEF.txt")); !os.IsNotExist(err) {
		t.Error("the bin entry should be gone")
	}
	if _, err := os.Stat(filepath.Join(sidDir, "nested")); !os.IsNotExist(err) {
		t.Error("the nested directory should be gone")
	}
}

// Spec §6.3: "A test plants a symlink two levels deep pointing outside the tree
// and asserts the target survives." RemoveAll unlinks rather than follows, at
// any depth — this pins that, because a regression here destroys user data
// outside the cleanup scope.
func TestDeleteFileContentsOnlyNeverFollowsLinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX symlink fixture; the Windows equivalent is a reparse point, covered by isReparsePoint")
	}
	outside := t.TempDir()
	victim := filepath.Join(outside, "precious.txt")
	if err := os.WriteFile(victim, []byte("do not delete"), 0o644); err != nil {
		t.Fatalf("write victim: %v", err)
	}

	tmpDir := t.TempDir()
	trash := filepath.Join(tmpDir, "Trash")
	deep := filepath.Join(trash, "one", "two")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// Two levels deep, inside a subtree RemoveAll will delete.
	if err := os.Symlink(outside, filepath.Join(deep, "escape")); err != nil {
		t.Fatalf("symlink deep: %v", err)
	}
	// An immediate child link, which must be SKIPPED and reported.
	if err := os.Symlink(outside, filepath.Join(trash, "shortcut")); err != nil {
		t.Fatalf("symlink child: %v", err)
	}
	if err := os.WriteFile(filepath.Join(trash, "junk.bin"), make([]byte, 512), 0o644); err != nil {
		t.Fatalf("write junk: %v", err)
	}

	var payload contentsOnlyPayload
	decodeSuccessPayload(t, DeleteFile(map[string]any{
		"path":         trash,
		"permanent":    true,
		"recursive":    true,
		"contentsOnly": true,
		"cleanupGuard": true,
		"volumeRoot":   tmpDir,
	}), &payload)

	if _, err := os.Stat(victim); err != nil {
		t.Fatalf("the symlink TARGET outside the tree must survive: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(trash, "shortcut")); err != nil {
		t.Error("an immediate symlink child must be skipped, not removed")
	}
	if len(payload.SkippedLinks) != 1 || filepath.Base(payload.SkippedLinks[0]) != "shortcut" {
		t.Errorf("expected the skipped link to be reported, got %v", payload.SkippedLinks)
	}
	if _, err := os.Stat(filepath.Join(trash, "one")); !os.IsNotExist(err) {
		t.Error("the nested subtree (including the deep symlink itself) should be gone")
	}
	if payload.BytesFreed != 512 {
		t.Errorf("expected bytesFreed=512 (the symlink contributes nothing), got %d", payload.BytesFreed)
	}
}

// §13 row 13: a contentsOnly run that could not remove every child must NOT
// read as a clean success. The agent reports failedChildren; the API turns that
// into `partial` (Task 8).
func TestDeleteFileContentsOnlyReportsFailedChildren(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("relies on POSIX mode bits that root ignores")
	}
	tmpDir := t.TempDir()
	trash := filepath.Join(tmpDir, "Trash")
	stuck := filepath.Join(trash, "stuck")
	if err := os.MkdirAll(stuck, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(stuck, "child"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.WriteFile(filepath.Join(trash, "junk.bin"), make([]byte, 128), 0o644); err != nil {
		t.Fatalf("write junk: %v", err)
	}
	// A directory with no write permission cannot have its child unlinked.
	if err := os.Chmod(stuck, 0o500); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(stuck, 0o755) })

	var payload contentsOnlyPayload
	decodeSuccessPayload(t, DeleteFile(map[string]any{
		"path": trash, "permanent": true, "recursive": true,
		"contentsOnly": true, "cleanupGuard": true, "volumeRoot": tmpDir,
	}), &payload)

	if len(payload.FailedChildren) == 0 {
		t.Fatalf("expected the unremovable child to be reported, got %+v", payload)
	}
	if payload.Deleted {
		t.Error("deleted must be false when a child could not be removed")
	}
	if payload.BytesFreed != 128 {
		t.Errorf("expected the removable child's bytes to still be counted, got %d", payload.BytesFreed)
	}
}

func TestDeleteFileContentsOnlyRefusesANonDirectory(t *testing.T) {
	tmpDir := t.TempDir()
	file := filepath.Join(tmpDir, "regular.bin")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	result := DeleteFile(map[string]any{
		"path": file, "permanent": true, "contentsOnly": true, "cleanupGuard": true, "volumeRoot": tmpDir,
	})
	if result.Status != "failed" || !strings.Contains(result.Error, "not a directory") {
		t.Fatalf("expected a not-a-directory refusal, got %q / %q", result.Status, result.Error)
	}
	if _, err := os.Stat(file); err != nil {
		t.Error("the file must survive the refusal")
	}
}

func TestDeleteFileContentsOnlyRequiresPermanent(t *testing.T) {
	tmpDir := t.TempDir()
	result := DeleteFile(map[string]any{"path": tmpDir, "contentsOnly": true})
	if result.Status != "failed" || !strings.Contains(result.Error, "contentsOnly requires permanent") {
		t.Fatalf("expected the flag combination to be refused, got %q / %q", result.Status, result.Error)
	}
}

// The depth check applies to the DIRECTORY, so the bin root stays refused while
// a SID directory one level down is reachable (spec §6.3).
func TestDeleteFileContentsOnlyStillHonoursTheBoundary(t *testing.T) {
	result := DeleteFile(map[string]any{
		"path":         string(filepath.Separator) + "home",
		"permanent":    true,
		"recursive":    true,
		"contentsOnly": true,
	})
	if result.Status != "failed" {
		t.Fatalf("a top-level directory must stay refused under contentsOnly, got %q", result.Status)
	}
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd agent && go test -race ./internal/remote/tools/... -run 'ContentsOnly'
```

Expected failure: every case fails with `expected a completed contentsOnly delete` / `Status "failed"` and the error `contentsOnly is not implemented` (the Task 6 stub), except `TestDeleteFileContentsOnlyRequiresPermanent` and `TestDeleteFileContentsOnlyStillHonoursTheBoundary`, which already pass.

- [ ] **Step 3: Implement** — replace the `deleteDirectoryContents` stub in `agent/internal/remote/tools/fileops.go`:

```go
// deleteDirectoryContents empties the target directory without removing it,
// entirely through the confined root handle (spec §13 row 1).
//
// This exists because the only reachable Windows recycle bin is one level below
// the volume root (C:\$Recycle.Bin is depth 1 and isRecursiveDeleteBoundary
// refuses it), and because deleting a .Trash / Trash directory outright is the
// wrong operation even where it is allowed: the OS owns those directory nodes.
//
// Link handling:
//   - The directory is re-opened as its OWN Root, so every child lookup is
//     confined to it and an ancestor swapped mid-operation cannot be traversed.
//   - Immediate children are Lstat'ed through that Root. A symlink or
//     reparse-point child is SKIPPED and reported; never removed, never
//     traversed.
//   - Everything else goes through Root.RemoveAll, which unlinks rather than
//     follows at any depth AND stays inside the root.
//   - desktop.ini is preserved: Explorer needs it to render the bin.
//
// A locked child is reported in skippedLocked, never forced. Any child that
// fails for another reason lands in failedChildren, which makes the action
// `partial` on the API side — never `completed` with positive bytes
// (spec §13 row 13).
func deleteDirectoryContents(target *cleanupTarget, cleanPath string, info os.FileInfo, start time.Time) CommandResult {
	if !info.IsDir() {
		return NewErrorResult(
			fmt.Errorf("%s contentsOnly target is not a directory: %s", CleanupGuardRejectedPrefix, cleanPath),
			time.Since(start).Milliseconds(),
		)
	}

	dirRoot, err := target.root.OpenRoot(target.rel)
	if err != nil {
		return NewErrorResult(
			fmt.Errorf("%s cannot open %s inside its anchor: %v", CleanupGuardRejectedPrefix, cleanPath, err),
			time.Since(start).Milliseconds(),
		)
	}
	defer func() { _ = dirRoot.Close() }()

	dirFile, err := dirRoot.Open(".")
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to open directory: %w", err), time.Since(start).Milliseconds())
	}
	entries, readErr := dirFile.ReadDir(-1)
	_ = dirFile.Close()
	if readErr != nil {
		return NewErrorResult(fmt.Errorf("failed to read directory: %w", readErr), time.Since(start).Milliseconds())
	}

	var bytesFreed int64
	skippedLocked := make([]string, 0)
	skippedLinks := make([]string, 0)
	failedChildren := make([]string, 0)

	for _, entry := range entries {
		name := entry.Name()
		if strings.EqualFold(name, "desktop.ini") {
			continue
		}
		childPath := filepath.Join(cleanPath, name)
		childInfo, lstatErr := dirRoot.Lstat(name)
		if lstatErr != nil {
			if os.IsNotExist(lstatErr) {
				continue
			}
			failedChildren = append(failedChildren, childPath)
			continue
		}
		if childInfo.Mode()&os.ModeSymlink != 0 || isReparsePoint(childInfo) {
			skippedLinks = append(skippedLinks, childPath)
			continue
		}

		size := childInfo.Size()
		if childInfo.IsDir() {
			size = sumTreeSizeAt(dirRoot, name)
		}
		if rmErr := dirRoot.RemoveAll(name); rmErr != nil {
			if isSharingViolation(rmErr) {
				skippedLocked = append(skippedLocked, childPath)
			} else {
				failedChildren = append(failedChildren, childPath)
			}
			continue
		}
		bytesFreed += size
	}

	return NewSuccessResult(map[string]any{
		"path":           cleanPath,
		"deleted":        len(failedChildren) == 0 && len(skippedLocked) == 0,
		"permanent":      true,
		"contentsOnly":   true,
		"bytesFreed":     bytesFreed,
		"skippedLocked":  skippedLocked,
		"skippedLinks":   skippedLinks,
		"failedChildren": failedChildren,
	}, time.Since(start).Milliseconds())
}
```

- [ ] **Step 4: Run them and watch them pass**

```bash
cd agent && gofmt -l internal/remote/tools/ && go test -race ./internal/remote/tools/...
```

Expected: `gofmt -l` silent, the whole `tools` package green.

- [ ] **Step 5: Run the whole agent suite**

```bash
cd agent && go test -race ./...
```

Expected: all packages green (`agent/internal/backup`'s own cross-language contract test is unaffected).

- [ ] **Step 6: Commit**

```bash
git add agent/internal/remote/tools/fileops.go agent/internal/remote/tools/fileops_cleanup_test.go
git commit -m "$(cat <<'EOF'
feat(agent): file_delete contentsOnly empties a bin without removing it

The only reachable Windows recycle bin is one level below the volume root, and
deleting a .Trash/Trash directory node outright is the wrong operation even
where the boundary allows it. contentsOnly lstats every immediate child, skips
and reports symlinks and reparse points, preserves desktop.ini, and removes the
rest with RemoveAll — which unlinks rather than follows at any depth, so a
symlink planted deep in the tree cannot reach outside it.

Locked children are reported, never forced. The directory itself survives.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §6.3, §10.4, §10.5

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: API — the cleanup execution service (rule re-filter, dispatch flags, status vocabulary)

**Files:**
- Create: `apps/api/src/services/filesystemCleanupExecution.ts`
- Create: `apps/api/src/services/filesystemCleanupExecution.test.ts` (Test)

**Interfaces:**
- Consumes: `classifyCleanupPath`, `isCleanupDeniedRoot`, `toCleanupOs`, `CLEANUP_GUARD_REJECTED_PREFIX`, `CleanupOs` from `@breeze/shared`; `FilesystemCleanupCandidate` from `./filesystemAnalysis`.
- Produces:
  ```ts
  export type CleanupActionStatus =
    | 'completed' | 'partial' | 'failed' | 'skipped_locked' | 'rejected' | 'skipped_budget';
  export type CleanupRejectionReason = 'not_in_plan' | 'rule_rejected' | 'denied_root' | 'agent_guard';
  export interface CleanupExecutionAction {
    path: string; category: string; sizeBytes: number;
    status: CleanupActionStatus;
    /** LOGICAL bytes — the agent's Lstat sum, not a free-space delta. */
    bytesFreed: number;
    skippedLockedCount: number; skippedLinkCount: number; failedChildren: string[];
    reason?: CleanupRejectionReason; error?: string;
  }
  export const MIN_AGENT_VERSION_CLEANUP_GUARD = '0.115.0';
  export function agentSupportsCleanupGuard(agentVersion: string | null | undefined): boolean;
  export function cleanupVolumeRoot(os: CleanupOs, path: string): string;
  export interface FileDeleteDispatchResult { status: 'completed' | 'failed' | 'timeout'; stdout?: string; error?: string }
  export interface ParsedFileDeleteResult { deleted: boolean; bytesFreed: number; skippedLocked: string[]; skippedLinks: string[]; failedChildren: string[] }
  export interface CleanupExecutionOutcome { actions: CleanupExecutionAction[]; rejectedPaths: string[]; bytesReclaimed: number }
  export function buildFileDeletePayload(params: {
    path: string; granularity: CleanupGranularity; volumeRoot: string; previewedAt: string;
  }): Record<string, unknown>;
  export function parseFileDeleteResult(stdout: string | undefined): ParsedFileDeleteResult | null;
  export function mapFileDeleteStatus(dispatch: FileDeleteDispatchResult, parsed: ParsedFileDeleteResult | null): CleanupActionStatus;
  export async function runCleanupExecution(params: {
    os: CleanupOs | null;
    requestedPaths: string[];
    candidates: FilesystemCleanupCandidate[];
    previewedAt: Date;
    dispatch: (path: string, payload: Record<string, unknown>) => Promise<FileDeleteDispatchResult>;
  }): Promise<CleanupExecutionOutcome>;
  ```

- [ ] **Step 1: Write the failing test** — create `apps/api/src/services/filesystemCleanupExecution.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { CLEANUP_GUARD_REJECTED_PREFIX } from '@breeze/shared';
import {
  MIN_AGENT_VERSION_CLEANUP_GUARD,
  agentSupportsCleanupGuard,
  buildFileDeletePayload,
  cleanupVolumeRoot,
  mapFileDeleteStatus,
  parseFileDeleteResult,
  runCleanupExecution,
  type FileDeleteDispatchResult,
} from './filesystemCleanupExecution';
import type { FilesystemCleanupCandidate } from './filesystemAnalysis';

const OLD = new Date(Date.now() - 72 * 3600_000).toISOString();
// Every execution pins the moment the operator looked at the plan; the agent
// refuses a target whose mtime is newer than this (spec §13 row 2).
const PREVIEWED_AT = new Date();

function tempCandidate(path: string, sizeBytes = 4096): FilesystemCleanupCandidate {
  return { path, category: 'temp_files', sizeBytes, safe: true, modifiedAt: OLD };
}

function ok(stdout: string): FileDeleteDispatchResult {
  return { status: 'completed', stdout };
}

describe('buildFileDeletePayload (spec §5.2, §13 rows 1-2)', () => {
  const previewedAt = '2026-09-19T12:00:00.000Z';

  it('asks for a permanent, guarded, NON-recursive delete for a file rule', () => {
    // §13 row 2: a file-granularity candidate that has become a directory since
    // the preview must not turn into a subtree delete.
    expect(buildFileDeletePayload({ path: '/tmp/a.tmp', granularity: 'file', volumeRoot: '/', previewedAt })).toEqual({
      path: '/tmp/a.tmp',
      recursive: false,
      permanent: true,
      cleanupGuard: true,
      contentsOnly: false,
      volumeRoot: '/',
      previewedAt,
    });
  });

  it('sets contentsOnly and recursive for a bin/trash root', () => {
    expect(buildFileDeletePayload({
      path: '/Users/alice/.Trash', granularity: 'contents', volumeRoot: '/', previewedAt,
    })).toMatchObject({ contentsOnly: true, recursive: true, volumeRoot: '/' });
  });

  it('derives the volume root the agent confines the anchor to', () => {
    expect(cleanupVolumeRoot('windows', 'D:\\$Recycle.Bin\\S-1-5-21-1')).toBe('D:\\');
    expect(cleanupVolumeRoot('linux', '/tmp/a.tmp')).toBe('/');
    expect(cleanupVolumeRoot('darwin', '/Users/alice/.Trash')).toBe('/');
  });
});

describe('agentSupportsCleanupGuard (spec §13 row 3)', () => {
  it('pins the minimum version W01 ships in', () => {
    // Bump this AND the constant together if the wave lands in another release.
    expect(MIN_AGENT_VERSION_CLEANUP_GUARD).toBe('0.115.0');
  });

  it('accepts the gate version and anything newer, including a prerelease of it', () => {
    expect(agentSupportsCleanupGuard('0.115.0')).toBe(true);
    expect(agentSupportsCleanupGuard('0.115.1')).toBe(true);
    expect(agentSupportsCleanupGuard('1.0.0')).toBe(true);
    // Core-only comparison: an RC of the gate release carries the guard.
    expect(agentSupportsCleanupGuard('0.115.0-rc1')).toBe(true);
    expect(agentSupportsCleanupGuard('v0.115.0')).toBe(true);
  });

  it('refuses older agents', () => {
    expect(agentSupportsCleanupGuard('0.114.0')).toBe(false);
    expect(agentSupportsCleanupGuard('0.99.9')).toBe(false);
  });

  it('FAILS CLOSED on an absent or unparseable version', () => {
    // compareAgentVersions returns 0 for unparseable input, so a naive
    // `compare(...) < 0` would fail OPEN and hand an unknown agent a permanent
    // recursive delete. These four are the whole reason for the helper.
    expect(agentSupportsCleanupGuard(null)).toBe(false);
    expect(agentSupportsCleanupGuard(undefined)).toBe(false);
    expect(agentSupportsCleanupGuard('')).toBe(false);
    expect(agentSupportsCleanupGuard('nightly')).toBe(false);
  });
});

describe('file_delete delivery class (spec §13 row 6)', () => {
  it('is live-only, so a permanent delete can never wait in the offline queue', async () => {
    const { COMMAND_OFFLINE_POLICY_REGISTRY, defaultOfflinePolicy } = await import('./commandOfflinePolicy');
    // A queued class would let a run the UI reported failed at 2h execute days
    // later against a machine whose state has moved on.
    expect(COMMAND_OFFLINE_POLICY_REGISTRY['file_delete']).toBe('live');
    expect(defaultOfflinePolicy('file_delete')).toEqual({ kind: 'reject' });
  });
});

describe('parseFileDeleteResult', () => {
  it('reads the new agent result body', () => {
    expect(
      parseFileDeleteResult(JSON.stringify({
        path: '/tmp/a', deleted: true, bytesFreed: 4096,
        skippedLocked: ['/tmp/locked'], skippedLinks: [], failedChildren: [],
      })),
    ).toEqual({
      deleted: true, bytesFreed: 4096,
      skippedLocked: ['/tmp/locked'], skippedLinks: [], failedChildren: [],
    });
  });

  it('returns null for an OLD agent body, which carries no bytesFreed', () => {
    expect(parseFileDeleteResult(JSON.stringify({ path: '/tmp/a', deleted: true, permanent: true }))).toBeNull();
  });

  it('returns null for missing or non-JSON stdout', () => {
    expect(parseFileDeleteResult(undefined)).toBeNull();
    expect(parseFileDeleteResult('')).toBeNull();
    expect(parseFileDeleteResult('not json')).toBeNull();
    expect(parseFileDeleteResult('[]')).toBeNull();
  });
});

describe('mapFileDeleteStatus (spec §5.2 status vocabulary)', () => {
  it('maps a guard refusal onto rejected, not failed', () => {
    expect(
      mapFileDeleteStatus(
        { status: 'failed', error: `${CLEANUP_GUARD_REJECTED_PREFIX} /tmp/x is a symlink` },
        null,
      ),
    ).toBe('rejected');
  });

  it('maps any other dispatch failure onto failed', () => {
    expect(mapFileDeleteStatus({ status: 'failed', error: 'device offline' }, null)).toBe('failed');
    expect(mapFileDeleteStatus({ status: 'timeout' }, null)).toBe('failed');
  });

  it('maps a locked file onto skipped_locked', () => {
    expect(
      mapFileDeleteStatus({ status: 'completed' }, {
        deleted: false, bytesFreed: 0, skippedLocked: ['/tmp/x'], skippedLinks: [], failedChildren: [],
      }),
    ).toBe('skipped_locked');
  });

  it('keeps a locked-but-productive contentsOnly delete as completed', () => {
    expect(
      mapFileDeleteStatus({ status: 'completed' }, {
        deleted: false, bytesFreed: 2048, skippedLocked: ['/trash/locked'], skippedLinks: [], failedChildren: [],
      }),
    ).toBe('completed');
  });

  it('maps ANY failed child onto partial, never completed (spec §13 row 13)', () => {
    // "Emptied most of the bin but three children failed" used to be
    // indistinguishable from a clean run.
    expect(
      mapFileDeleteStatus({ status: 'completed' }, {
        deleted: false, bytesFreed: 2048, skippedLocked: [], skippedLinks: [], failedChildren: ['/trash/x'],
      }),
    ).toBe('partial');
  });

  it('maps an all-children-failed contentsOnly delete onto failed', () => {
    expect(
      mapFileDeleteStatus({ status: 'completed' }, {
        deleted: false, bytesFreed: 0, skippedLocked: [], skippedLinks: [], failedChildren: ['/trash/x'],
      }),
    ).toBe('failed');
  });

  it('treats an OLD agent success as completed', () => {
    expect(mapFileDeleteStatus({ status: 'completed' }, null)).toBe('completed');
  });
});

describe('runCleanupExecution', () => {
  it('dispatches the guarded permanent payload for a rule-matching candidate', async () => {
    const dispatch = vi.fn(async () => ok(JSON.stringify({ deleted: true, bytesFreed: 4096, skippedLocked: [], skippedLinks: [], failedChildren: [] })));
    const outcome = await runCleanupExecution({
      os: 'linux',
      requestedPaths: ['/tmp/a.tmp'],
      candidates: [tempCandidate('/tmp/a.tmp')],
      previewedAt: PREVIEWED_AT,
      dispatch,
    });

    expect(dispatch).toHaveBeenCalledWith('/tmp/a.tmp', {
      path: '/tmp/a.tmp', recursive: true, permanent: true, cleanupGuard: true, contentsOnly: false,
    });
    expect(outcome.actions).toEqual([
      expect.objectContaining({ path: '/tmp/a.tmp', status: 'completed', bytesFreed: 4096 }),
    ]);
    expect(outcome.rejectedPaths).toEqual([]);
    expect(outcome.bytesReclaimed).toBe(4096);
  });

  it('sets contentsOnly from the rule granularity, without a new candidate field', async () => {
    const dispatch = vi.fn(async () => ok(JSON.stringify({ deleted: true, bytesFreed: 10, skippedLocked: [], skippedLinks: [], failedChildren: [] })));
    await runCleanupExecution({
      os: 'darwin',
      requestedPaths: ['/Users/alice/.Trash'],
      candidates: [{ path: '/Users/alice/.Trash', category: 'trash', sizeBytes: 10, safe: true }],
      previewedAt: PREVIEWED_AT,
      dispatch,
    });
    expect(dispatch).toHaveBeenCalledWith('/Users/alice/.Trash', expect.objectContaining({ contentsOnly: true }));
  });

  it('rejects a path that is not in the pinned plan and never dispatches it (defect 10)', async () => {
    const dispatch = vi.fn(async () => ok('{}'));
    const outcome = await runCleanupExecution({
      os: 'linux',
      requestedPaths: ['/tmp/a.tmp', '/home/bob/taxes.pdf'],
      candidates: [tempCandidate('/tmp/a.tmp')],
      previewedAt: PREVIEWED_AT,
      dispatch,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(outcome.rejectedPaths).toEqual(['/home/bob/taxes.pdf']);
    expect(outcome.actions).toContainEqual(
      expect.objectContaining({ path: '/home/bob/taxes.pdf', status: 'rejected', reason: 'not_in_plan' }),
    );
  });

  it('rejects a planned candidate the rule table no longer claims (a stale pre-W01 snapshot)', async () => {
    const dispatch = vi.fn(async () => ok('{}'));
    const stale: FilesystemCleanupCandidate = {
      path: 'C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Bookmarks',
      category: 'browser_cache',
      sizeBytes: 2048,
      safe: true,
    };
    const outcome = await runCleanupExecution({
      os: 'windows',
      requestedPaths: [stale.path],
      candidates: [stale],
      previewedAt: PREVIEWED_AT,
      dispatch,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(outcome.actions[0]).toMatchObject({ status: 'rejected', reason: 'rule_rejected' });
    expect(outcome.rejectedPaths).toEqual([stale.path]);
  });

  it('rejects a cleanup-denied root before anything else', async () => {
    const dispatch = vi.fn(async () => ok('{}'));
    const outcome = await runCleanupExecution({
      os: 'linux',
      requestedPaths: ['/etc/passwd'],
      candidates: [{ path: '/etc/passwd', category: 'temp_files', sizeBytes: 1, safe: true, modifiedAt: OLD }],
      previewedAt: PREVIEWED_AT,
      dispatch,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(outcome.actions[0]).toMatchObject({ status: 'rejected', reason: 'denied_root' });
  });

  it('records an agent guard refusal as rejected and lists it in rejectedPaths', async () => {
    const dispatch = vi.fn(async (): Promise<FileDeleteDispatchResult> => ({
      status: 'failed',
      error: `${CLEANUP_GUARD_REJECTED_PREFIX} /tmp/a.tmp is a symlink`,
    }));
    const outcome = await runCleanupExecution({
      os: 'linux',
      requestedPaths: ['/tmp/a.tmp'],
      candidates: [tempCandidate('/tmp/a.tmp')],
      previewedAt: PREVIEWED_AT,
      dispatch,
    });
    expect(outcome.actions[0]).toMatchObject({ status: 'rejected', reason: 'agent_guard' });
    expect(outcome.rejectedPaths).toEqual(['/tmp/a.tmp']);
    expect(outcome.bytesReclaimed).toBe(0);
  });

  it('falls back to the snapshot size when an OLD agent reports no bytesFreed', async () => {
    const dispatch = vi.fn(async () => ok(JSON.stringify({ path: '/tmp/a.tmp', deleted: true, permanent: true })));
    const outcome = await runCleanupExecution({
      os: 'linux',
      requestedPaths: ['/tmp/a.tmp'],
      candidates: [tempCandidate('/tmp/a.tmp', 8192)],
      previewedAt: PREVIEWED_AT,
      dispatch,
    });
    expect(outcome.actions[0]).toMatchObject({ status: 'completed', bytesFreed: 8192 });
    expect(outcome.bytesReclaimed).toBe(8192);
  });

  it('prefers the agent bytesFreed over the snapshot size when they differ', async () => {
    const dispatch = vi.fn(async () => ok(JSON.stringify({ deleted: true, bytesFreed: 12, skippedLocked: [], skippedLinks: [], failedChildren: [] })));
    const outcome = await runCleanupExecution({
      os: 'linux',
      requestedPaths: ['/tmp/a.tmp'],
      candidates: [tempCandidate('/tmp/a.tmp', 999_999)],
      previewedAt: PREVIEWED_AT,
      dispatch,
    });
    expect(outcome.bytesReclaimed).toBe(12);
  });

  it('deduplicates requested paths and preserves request order', async () => {
    const dispatch = vi.fn(async () => ok(JSON.stringify({ deleted: true, bytesFreed: 1, skippedLocked: [], skippedLinks: [], failedChildren: [] })));
    const outcome = await runCleanupExecution({
      os: 'linux',
      requestedPaths: ['/tmp/b.tmp', '/tmp/a.tmp', '/tmp/b.tmp'],
      candidates: [tempCandidate('/tmp/a.tmp'), tempCandidate('/tmp/b.tmp')],
      previewedAt: PREVIEWED_AT,
      dispatch,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(outcome.actions.map((a) => a.path)).toEqual(['/tmp/b.tmp', '/tmp/a.tmp']);
  });

  it('rejects everything when the device OS cannot be mapped (fail closed)', async () => {
    const dispatch = vi.fn(async () => ok('{}'));
    const outcome = await runCleanupExecution({
      os: null,
      requestedPaths: ['/tmp/a.tmp'],
      candidates: [tempCandidate('/tmp/a.tmp')],
      previewedAt: PREVIEWED_AT,
      dispatch,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(outcome.actions[0]).toMatchObject({ status: 'rejected', reason: 'rule_rejected' });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/filesystemCleanupExecution.test.ts
```

Expected failure: `Failed to load .../filesystemCleanupExecution.test.ts` … `Cannot find module './filesystemCleanupExecution'`.

- [ ] **Step 3: Implement** — create `apps/api/src/services/filesystemCleanupExecution.ts`:

```ts
/**
 * Disk-cleanup execution (spec §5.2).
 *
 * This lives outside the route for three reasons: the route is already at the
 * file-size guideline, the loop needs to be testable without a Hono context or
 * a device, and W05's AI lane will call the same function so the two lanes
 * cannot drift in what they dispatch.
 *
 * The contract, in one place:
 *   - Nothing is deleted that was not previewed. A requested path outside the
 *     pinned candidate set is `rejected`, reported, and never dispatched.
 *   - Rules are enforced TWICE (§10.2). Here, against the shared rule table, so
 *     a stale snapshot captured before W01 (Chrome Bookmarks, UWP LocalState)
 *     cannot be executed; and again on the device under `cleanupGuard`.
 *   - Cleanup deletes are PERMANENT by construction (§10.3). Without
 *     `permanent: true` the agent MOVES the file to ~/.breeze-trash on the same
 *     volume, freeing nothing — and across volumes it falls back to copy+remove,
 *     so cleaning D:\ grew C:\ (defect 1).
 *   - `contentsOnly` comes from the matched rule's granularity, never from a
 *     field on the candidate, so an old agent's snapshot still yields the right
 *     flag for a recycle bin.
 */
import {
  CLEANUP_GUARD_REJECTED_PREFIX,
  classifyCleanupPath,
  isCleanupDeniedRoot,
  type CleanupGranularity,
  type CleanupOs,
} from '@breeze/shared';
import { compareAgentVersions, parseComparableVersion } from './agentEditionCompat';
import type { FilesystemCleanupCandidate } from './filesystemAnalysis';

export type CleanupActionStatus =
  | 'completed'
  | 'partial'
  | 'failed'
  | 'skipped_locked'
  | 'rejected'
  | 'skipped_budget';

/**
 * The agent release that introduced `cleanupGuard` (spec §13 row 3).
 *
 * An agent WITHOUT the guard that is handed `permanent: true` performs an
 * unguarded recursive permanent delete of whatever path it is given — strictly
 * worse than today's trash-move, which is why spec §3's "cosmetic degradation"
 * paragraph is withdrawn. Both cleanup lanes refuse older agents with
 * `409 agent_update_required`.
 *
 * W01 ships in the release after v0.114.0. If the wave lands in a different
 * release, bump this AND its test in the same PR.
 */
export const MIN_AGENT_VERSION_CLEANUP_GUARD = '0.115.0';

/**
 * Fail-CLOSED version gate. `compareAgentVersions` returns 0 for an unparseable
 * input (agentEditionCompat.ts:48-51), so a naive `compare(...) < 0` would fail
 * OPEN on an empty or malformed `devices.agent_version` and hand an unknown
 * build a permanent recursive delete. Parse first; compare CORE only, so an RC
 * of the gate release (`0.115.0-rc1`) counts as carrying the guard.
 */
export function agentSupportsCleanupGuard(agentVersion: string | null | undefined): boolean {
  if (!agentVersion) return false;
  const parsed = parseComparableVersion(agentVersion);
  if (!parsed) return false;
  return compareAgentVersions(parsed.core.join('.'), MIN_AGENT_VERSION_CLEANUP_GUARD) >= 0;
}

/**
 * The volume the agent must confine the rule anchor to. On Windows that is the
 * candidate's own drive root, which stops a junction at the anchor relocating
 * the whole operation onto another volume; on POSIX W01 uses `/` and W02
 * narrows it to the scanned volume once `scan_path` exists.
 */
export function cleanupVolumeRoot(os: CleanupOs, path: string): string {
  if (os !== 'windows') return '/';
  const drive = /^([a-zA-Z]:)/.exec(path.trim());
  return drive ? `${drive[1]}\\` : '\\';
}

export type CleanupRejectionReason = 'not_in_plan' | 'rule_rejected' | 'denied_root' | 'agent_guard';

export interface CleanupExecutionAction {
  path: string;
  category: string;
  sizeBytes: number;
  status: CleanupActionStatus;
  /**
   * LOGICAL bytes: the agent's own sum of `Lstat` sizes. Sparse files,
   * compression, dedup and cluster slack all make the real free-space delta
   * differ, and the pre-W01 `file_delete` result carried no byte count at all.
   * The measured figure arrives with the native cleaners in W04.
   */
  bytesFreed: number;
  skippedLockedCount: number;
  skippedLinkCount: number;
  /** Children a `contentsOnly` delete could not remove; capped for the row. */
  failedChildren: string[];
  reason?: CleanupRejectionReason;
  error?: string;
}

export interface FileDeleteDispatchResult {
  status: 'completed' | 'failed' | 'timeout';
  stdout?: string;
  error?: string;
}

export interface ParsedFileDeleteResult {
  deleted: boolean;
  bytesFreed: number;
  skippedLocked: string[];
  skippedLinks: string[];
  failedChildren: string[];
}

export interface CleanupExecutionOutcome {
  actions: CleanupExecutionAction[];
  rejectedPaths: string[];
  bytesReclaimed: number;
}

export function buildFileDeletePayload(params: {
  path: string;
  granularity: CleanupGranularity;
  volumeRoot: string;
  previewedAt: string;
}): Record<string, unknown> {
  const contentsOnly = params.granularity === 'contents';
  return {
    path: params.path,
    // §13 row 2: only a contents rule deletes a subtree. A file-granularity
    // candidate that has become a directory since the preview must be refused,
    // not recursed into — which is why `recursive` tracks granularity.
    recursive: contentsOnly,
    permanent: true,
    cleanupGuard: true,
    contentsOnly,
    volumeRoot: params.volumeRoot,
    previewedAt: params.previewedAt,
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Returns null for an OLD agent, whose success body is `{path, deleted,
 * permanent}` with no `bytesFreed`. That is a VERSION SIGNAL, not a parse
 * error: the caller falls back to the snapshot size and reports `completed`,
 * which is exactly the mixed-version behaviour spec §3 describes.
 */
export function parseFileDeleteResult(stdout: string | undefined): ParsedFileDeleteResult | null {
  if (!stdout) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.bytesFreed !== 'number' || !Number.isFinite(body.bytesFreed)) return null;
  return {
    deleted: body.deleted === true,
    bytesFreed: Math.max(0, body.bytesFreed),
    skippedLocked: asStringArray(body.skippedLocked),
    skippedLinks: asStringArray(body.skippedLinks),
    failedChildren: asStringArray(body.failedChildren),
  };
}

export function mapFileDeleteStatus(
  dispatch: FileDeleteDispatchResult,
  parsed: ParsedFileDeleteResult | null,
): CleanupActionStatus {
  if (dispatch.status !== 'completed') {
    // CommandResult.status has no `rejected` member, so the agent's cleanupGuard
    // rides a pinned error prefix (spec §5.2, shared constant).
    return (dispatch.error ?? '').startsWith(CLEANUP_GUARD_REJECTED_PREFIX) ? 'rejected' : 'failed';
  }
  if (!parsed) return 'completed';
  if (parsed.failedChildren.length > 0) {
    // §13 row 13: "emptied most of the bin, three children failed" must never
    // read as a clean success. Only a run that freed nothing at all is `failed`.
    return parsed.bytesFreed === 0 && parsed.skippedLocked.length === 0 ? 'failed' : 'partial';
  }
  if (parsed.bytesFreed === 0 && parsed.skippedLocked.length > 0) return 'skipped_locked';
  return 'completed';
}

type Rejection = { reason: CleanupRejectionReason };

function screen(
  os: CleanupOs | null,
  candidate: FilesystemCleanupCandidate,
): Rejection | { granularity: CleanupGranularity } {
  // A device whose os_type does not map to a rule grammar cannot be screened,
  // and an unscreenable delete is not a delete we make.
  if (!os) return { reason: 'rule_rejected' };
  if (isCleanupDeniedRoot(os, candidate.path)) return { reason: 'denied_root' };
  const classification = classifyCleanupPath(os, candidate.path, { modifiedAt: candidate.modifiedAt ?? null });
  if (!classification.category || !classification.granularity) return { reason: 'rule_rejected' };
  return { granularity: classification.granularity };
}

export async function runCleanupExecution(params: {
  os: CleanupOs | null;
  requestedPaths: string[];
  candidates: FilesystemCleanupCandidate[];
  /**
   * When the operator looked at this plan — the pinned run's `requestedAt`, or
   * the snapshot's `capturedAt` on the unpinned fallback. The agent refuses a
   * target whose mtime is newer than it (spec §13 row 2).
   */
  previewedAt: Date;
  dispatch: (path: string, payload: Record<string, unknown>) => Promise<FileDeleteDispatchResult>;
}): Promise<CleanupExecutionOutcome> {
  const byPath = new Map(params.candidates.map((candidate) => [candidate.path, candidate]));
  const requested = Array.from(new Set(params.requestedPaths));

  const actions: CleanupExecutionAction[] = [];
  let bytesReclaimed = 0;

  for (const path of requested) {
    const candidate = byPath.get(path);
    if (!candidate) {
      actions.push({
        path,
        category: 'unknown',
        sizeBytes: 0,
        status: 'rejected',
        reason: 'not_in_plan',
        bytesFreed: 0,
        skippedLockedCount: 0,
        skippedLinkCount: 0,
        failedChildren: [],
      });
      continue;
    }

    const screened = screen(params.os, candidate);
    if ('reason' in screened) {
      actions.push({
        path,
        category: candidate.category,
        sizeBytes: candidate.sizeBytes,
        status: 'rejected',
        reason: screened.reason,
        bytesFreed: 0,
        skippedLockedCount: 0,
        skippedLinkCount: 0,
        failedChildren: [],
      });
      continue;
    }

    const result = await params.dispatch(path, buildFileDeletePayload({
      path,
      granularity: screened.granularity,
      // `screen` already refused a null os, so this narrowing is total.
      volumeRoot: cleanupVolumeRoot(params.os as CleanupOs, path),
      previewedAt: params.previewedAt.toISOString(),
    }));
    const parsed = parseFileDeleteResult(result.stdout);
    const status = mapFileDeleteStatus(result, parsed);
    const bytesFreed = parsed
      ? parsed.bytesFreed
      : status === 'completed'
        ? candidate.sizeBytes
        : 0;
    if (status === 'completed' || status === 'partial' || status === 'skipped_locked') {
      bytesReclaimed += bytesFreed;
    }
    actions.push({
      path,
      category: candidate.category,
      sizeBytes: candidate.sizeBytes,
      status,
      reason: status === 'rejected' ? 'agent_guard' : undefined,
      bytesFreed,
      skippedLockedCount: parsed?.skippedLocked.length ?? 0,
      skippedLinkCount: parsed?.skippedLinks.length ?? 0,
      failedChildren: (parsed?.failedChildren ?? []).slice(0, 20),
      error: result.error ?? undefined,
    });
  }

  return {
    actions,
    rejectedPaths: actions.filter((action) => action.status === 'rejected').map((action) => action.path),
    bytesReclaimed,
  };
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/api && npx vitest run src/services/filesystemCleanupExecution.test.ts
```

Expected: 18 passing tests.

- [ ] **Step 5: Typecheck**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-green-meadow-232b && pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

Expected: clean exit.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/filesystemCleanupExecution.ts apps/api/src/services/filesystemCleanupExecution.test.ts
git commit -m "$(cat <<'EOF'
feat(api): cleanup execution service — permanent dispatch + rule re-filter

cleanup-execute dispatched file_delete as { path, recursive: true }, so the
agent MOVED every "deleted" file to ~/.breeze-trash on the same volume for 30
days: zero bytes freed, and across volumes a copy+remove that GREW C:\ while
cleaning D:\. bytesReclaimed summed snapshot sizes regardless.

The loop moves into a service that dispatches permanent + cleanupGuard +
contentsOnly, re-filters every candidate through the shared rule table before
dispatch, reports a real per-path status (completed / failed / skipped_locked /
rejected) with rejectedPaths, and trusts the agent's bytesFreed over the
snapshot size when the two differ.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §2 defects 1 and 10, §5.2, §10

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: API — the wall-clock budget and the `executedActions` envelope

**Files:**
- Modify: `apps/api/src/services/filesystemCleanupExecution.ts` (add the budget)
- Modify: `apps/api/src/services/filesystemCleanupExecution.test.ts` (Test — append)
- Modify: `apps/api/src/services/filesystemAnalysis.ts` — add `readExecutedActions`; carry `duplicateTrackingTruncated` through `mergeFilesystemAnalysisPayload` (`:280-287`)
- Modify: `apps/api/src/services/filesystemAnalysis.test.ts` (Test — append)

**Interfaces:**
- Consumes: Task 8's service.
- Produces:
  ```ts
  export const CLEANUP_EXECUTE_BUDGET_MS = 240_000;
  // runCleanupExecution params gain: budgetMs?: number; now?: () => number
  // CleanupExecutionOutcome gains: partial: boolean; budgetMs: number
  export interface StoredExecutedActions { partial: boolean; budgetMs: number; actions: unknown[] }
  export function readExecutedActions(value: unknown): StoredExecutedActions;   // in filesystemAnalysis.ts
  ```

- [ ] **Step 1: Write the failing tests** — append to `apps/api/src/services/filesystemCleanupExecution.test.ts`:

```ts
describe('runCleanupExecution wall-clock budget (spec §5.2)', () => {
  it('exports a four-minute budget', async () => {
    const { CLEANUP_EXECUTE_BUDGET_MS } = await import('./filesystemCleanupExecution');
    expect(CLEANUP_EXECUTE_BUDGET_MS).toBe(240_000);
  });

  it('stops dispatching once the budget is spent and marks the rest skipped_budget', async () => {
    // 200 candidates x a 30s per-command timeout is a 100-minute worst case on
    // a request thread; the budget is what keeps that bounded (defect 10).
    let clock = 0;
    const dispatch = vi.fn(async () => {
      clock += 60_000;
      return ok(JSON.stringify({ deleted: true, bytesFreed: 1, skippedLocked: [], skippedLinks: [], failedChildren: [] }));
    });
    const paths = ['/tmp/a.tmp', '/tmp/b.tmp', '/tmp/c.tmp', '/tmp/d.tmp'];
    const outcome = await runCleanupExecution({
      os: 'linux',
      requestedPaths: paths,
      candidates: paths.map((p) => tempCandidate(p)),
      previewedAt: PREVIEWED_AT,
      dispatch,
      budgetMs: 120_000,
      now: () => clock,
    });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(outcome.actions.map((a) => a.status)).toEqual([
      'completed', 'completed', 'skipped_budget', 'skipped_budget',
    ]);
    expect(outcome.partial).toBe(true);
    expect(outcome.budgetMs).toBe(120_000);
    expect(outcome.rejectedPaths).toEqual([]);
  });

  it('is not partial when everything fits in the budget', async () => {
    const dispatch = vi.fn(async () => ok(JSON.stringify({ deleted: true, bytesFreed: 1, skippedLocked: [], skippedLinks: [], failedChildren: [] })));
    const outcome = await runCleanupExecution({
      os: 'linux',
      requestedPaths: ['/tmp/a.tmp'],
      candidates: [tempCandidate('/tmp/a.tmp')],
      previewedAt: PREVIEWED_AT,
      dispatch,
      budgetMs: 120_000,
      now: () => 0,
    });
    expect(outcome.partial).toBe(false);
  });

  it('still screens budget-skipped paths, so a rejection is never hidden by the budget', async () => {
    let clock = 0;
    const dispatch = vi.fn(async () => {
      clock += 60_000;
      return ok(JSON.stringify({ deleted: true, bytesFreed: 1, skippedLocked: [], skippedLinks: [], failedChildren: [] }));
    });
    const outcome = await runCleanupExecution({
      os: 'linux',
      requestedPaths: ['/tmp/a.tmp', '/home/bob/taxes.pdf', '/tmp/c.tmp'],
      candidates: [tempCandidate('/tmp/a.tmp'), tempCandidate('/tmp/c.tmp')],
      previewedAt: PREVIEWED_AT,
      dispatch,
      budgetMs: 30_000,
      now: () => clock,
    });
    expect(outcome.actions.map((a) => a.status)).toEqual(['completed', 'rejected', 'skipped_budget']);
    expect(outcome.rejectedPaths).toEqual(['/home/bob/taxes.pdf']);
  });
});
```

and append to `apps/api/src/services/filesystemAnalysis.test.ts`:

```ts
describe('readExecutedActions', () => {
  it('reads the new envelope', () => {
    expect(readExecutedActions({ partial: true, budgetMs: 240_000, actions: [{ path: '/tmp/a' }] })).toEqual({
      partial: true,
      budgetMs: 240_000,
      actions: [{ path: '/tmp/a' }],
    });
  });

  it('reads a legacy bare array, so pre-W01 runs still render', () => {
    expect(readExecutedActions([{ path: '/tmp/a', status: 'completed' }])).toEqual({
      partial: false,
      budgetMs: 0,
      actions: [{ path: '/tmp/a', status: 'completed' }],
    });
  });

  it('is total over junk', () => {
    expect(readExecutedActions(null)).toEqual({ partial: false, budgetMs: 0, actions: [] });
    expect(readExecutedActions('nope')).toEqual({ partial: false, budgetMs: 0, actions: [] });
    expect(readExecutedActions({ partial: 'yes', actions: 'nope' })).toEqual({ partial: false, budgetMs: 0, actions: [] });
  });
});

describe('mergeFilesystemAnalysisPayload summary', () => {
  it('carries duplicateTrackingTruncated across a checkpoint-resumed baseline', () => {
    const merged = mergeFilesystemAnalysisPayload(
      { summary: { filesScanned: 1, duplicateTrackingTruncated: true } },
      { summary: { filesScanned: 2 } },
    );
    const summary = merged.summary as Record<string, unknown>;
    expect(summary.filesScanned).toBe(3);
    // The five-field rebuild used to drop this, so a resumed baseline reported
    // "no duplicates" where the agent had actually stopped looking.
    expect(summary.duplicateTrackingTruncated).toBe(true);
  });

  it('leaves the flag off when neither half set it', () => {
    const merged = mergeFilesystemAnalysisPayload({ summary: {} }, { summary: {} });
    expect((merged.summary as Record<string, unknown>).duplicateTrackingTruncated).toBe(false);
  });
});
```

Add `readExecutedActions` and `mergeFilesystemAnalysisPayload` to that file's import list if they are not already there.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/api && npx vitest run src/services/filesystemCleanupExecution.test.ts src/services/filesystemAnalysis.test.ts
```

Expected failure: `CLEANUP_EXECUTE_BUDGET_MS` is `undefined` (not `240000`); the budget cases dispatch all four paths and report no `partial`; `readExecutedActions is not a function`; the summary case reports `undefined` for `duplicateTrackingTruncated`.

- [ ] **Step 3: Implement the budget** — in `apps/api/src/services/filesystemCleanupExecution.ts`, add the constant next to the imports:

```ts
/**
 * Wall-clock ceiling for one cleanup-execute request. Deletes are SEQUENTIAL
 * and each command carries a 30s timeout, so 200 candidates is a 100-minute
 * worst case on a request thread holding a database context. Paths not reached
 * are reported `skipped_budget` and the run is recorded `executed` with
 * `partial: true` — the operator re-runs rather than waiting (spec §5.2).
 */
export const CLEANUP_EXECUTE_BUDGET_MS = 240_000;
```

extend the outcome type:

```ts
export interface CleanupExecutionOutcome {
  actions: CleanupExecutionAction[];
  rejectedPaths: string[];
  bytesReclaimed: number;
  partial: boolean;
  budgetMs: number;
}
```

and the function signature plus loop:

```ts
export async function runCleanupExecution(params: {
  os: CleanupOs | null;
  requestedPaths: string[];
  candidates: FilesystemCleanupCandidate[];
  previewedAt: Date;
  dispatch: (path: string, payload: Record<string, unknown>) => Promise<FileDeleteDispatchResult>;
  budgetMs?: number;
  /** Injected clock, so the budget is testable without real time. */
  now?: () => number;
}): Promise<CleanupExecutionOutcome> {
  const budgetMs = params.budgetMs ?? CLEANUP_EXECUTE_BUDGET_MS;
  const now = params.now ?? (() => Date.now());
  const startedAt = now();

  const byPath = new Map(params.candidates.map((candidate) => [candidate.path, candidate]));
  const requested = Array.from(new Set(params.requestedPaths));

  const actions: CleanupExecutionAction[] = [];
  let bytesReclaimed = 0;
  let budgetSpent = false;

  for (const path of requested) {
    const candidate = byPath.get(path);
    if (!candidate) {
      actions.push({
        path,
        category: 'unknown',
        sizeBytes: 0,
        status: 'rejected',
        reason: 'not_in_plan',
        bytesFreed: 0,
        skippedLockedCount: 0,
        skippedLinkCount: 0,
        failedChildren: [],
      });
      continue;
    }

    const screened = screen(params.os, candidate);
    if ('reason' in screened) {
      actions.push({
        path,
        category: candidate.category,
        sizeBytes: candidate.sizeBytes,
        status: 'rejected',
        reason: screened.reason,
        bytesFreed: 0,
        skippedLockedCount: 0,
        skippedLinkCount: 0,
        failedChildren: [],
      });
      continue;
    }

    // Screening happens BEFORE the budget check so a rejection is reported even
    // for a path the budget would otherwise have skipped: "we refused this" and
    // "we ran out of time" are different answers and the operator needs both.
    if (budgetSpent || now() - startedAt >= budgetMs) {
      budgetSpent = true;
      actions.push({
        path,
        category: candidate.category,
        sizeBytes: candidate.sizeBytes,
        status: 'skipped_budget',
        bytesFreed: 0,
        skippedLockedCount: 0,
        skippedLinkCount: 0,
        failedChildren: [],
      });
      continue;
    }

    const result = await params.dispatch(path, buildFileDeletePayload({
      path,
      granularity: screened.granularity,
      // `screen` already refused a null os, so this narrowing is total.
      volumeRoot: cleanupVolumeRoot(params.os as CleanupOs, path),
      previewedAt: params.previewedAt.toISOString(),
    }));
    const parsed = parseFileDeleteResult(result.stdout);
    const status = mapFileDeleteStatus(result, parsed);
    const bytesFreed = parsed
      ? parsed.bytesFreed
      : status === 'completed'
        ? candidate.sizeBytes
        : 0;
    if (status === 'completed' || status === 'partial' || status === 'skipped_locked') {
      bytesReclaimed += bytesFreed;
    }
    actions.push({
      path,
      category: candidate.category,
      sizeBytes: candidate.sizeBytes,
      status,
      reason: status === 'rejected' ? 'agent_guard' : undefined,
      bytesFreed,
      skippedLockedCount: parsed?.skippedLocked.length ?? 0,
      skippedLinkCount: parsed?.skippedLinks.length ?? 0,
      failedChildren: (parsed?.failedChildren ?? []).slice(0, 20),
      error: result.error ?? undefined,
    });
  }

  return {
    actions,
    rejectedPaths: actions.filter((action) => action.status === 'rejected').map((action) => action.path),
    bytesReclaimed,
    partial: actions.some((action) => action.status === 'skipped_budget'),
    budgetMs,
  };
}
```

- [ ] **Step 4: Implement `readExecutedActions` and the summary passthrough** — in `apps/api/src/services/filesystemAnalysis.ts`, add after `readPlanPreviewCandidates`:

```ts
/**
 * The stored `executed_actions` envelope. W01 changed the column from a bare
 * array to `{ partial, budgetMs, actions }` so a budget-truncated run can say
 * so (spec §5.2). No migration: the column is jsonb. This reader accepts BOTH
 * shapes, because every run recorded before W01 is a bare array and the run
 * history must still render it.
 */
export function readExecutedActions(value: unknown): {
  partial: boolean;
  budgetMs: number;
  actions: unknown[];
} {
  if (Array.isArray(value)) {
    return { partial: false, budgetMs: 0, actions: value };
  }
  const record = asRecord(value);
  if (!record || !Array.isArray(record.actions)) {
    return { partial: false, budgetMs: 0, actions: [] };
  }
  return {
    partial: asBoolean(record.partial, false),
    budgetMs: asNumber(record.budgetMs, 0),
    actions: record.actions,
  };
}
```

and in `mergeFilesystemAnalysisPayload`, extend the rebuilt summary (`:280-287`):

```ts
    summary: {
      filesScanned: asNumber(existingSummary.filesScanned, 0) + asNumber(incomingSummary.filesScanned, 0),
      dirsScanned: asNumber(existingSummary.dirsScanned, 0) + asNumber(incomingSummary.dirsScanned, 0),
      bytesScanned: asNumber(existingSummary.bytesScanned, 0) + asNumber(incomingSummary.bytesScanned, 0),
      maxDepthReached: Math.max(asNumber(existingSummary.maxDepthReached, 0), asNumber(incomingSummary.maxDepthReached, 0)),
      permissionDeniedCount:
        asNumber(existingSummary.permissionDeniedCount, 0) + asNumber(incomingSummary.permissionDeniedCount, 0),
      // Sticky across a resumed baseline: the summary is REBUILT from named
      // fields, so without this line a checkpointed scan that hit the duplicate
      // cap reported "no duplicates" instead of "we stopped looking".
      duplicateTrackingTruncated:
        asBoolean(existingSummary.duplicateTrackingTruncated, false) ||
        asBoolean(incomingSummary.duplicateTrackingTruncated, false),
    },
```

- [ ] **Step 5: Run them and watch them pass**

```bash
cd apps/api && npx vitest run src/services/filesystemCleanupExecution.test.ts src/services/filesystemAnalysis.test.ts
```

Expected: both files green.

- [ ] **Step 6: Typecheck**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-green-meadow-232b && pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

Expected: clean exit.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/filesystemCleanupExecution.ts apps/api/src/services/filesystemCleanupExecution.test.ts apps/api/src/services/filesystemAnalysis.ts apps/api/src/services/filesystemAnalysis.test.ts
git commit -m "$(cat <<'EOF'
feat(api): bound cleanup-execute by wall clock; executedActions envelope

Deletes are sequential with a 30s per-command timeout, so 200 candidates was a
100-minute worst case on a request thread. CLEANUP_EXECUTE_BUDGET_MS caps the
run at four minutes; paths not reached come back skipped_budget and the run is
recorded executed with partial: true.

executed_actions becomes { partial, budgetMs, actions } (jsonb, no migration),
and readExecutedActions still reads the pre-W01 bare array so run history keeps
rendering old rows. mergeFilesystemAnalysisPayload now carries
summary.duplicateTrackingTruncated across a checkpoint-resumed baseline.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §5.2, §6.4

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: API — wire the route and unify the response shape

**Files:**
- Modify: `apps/api/src/routes/devices/filesystem.ts` — all four handlers
- Modify: `apps/api/src/routes/devices/filesystem.test.ts` (Test)

**Interfaces:**
- Consumes: `runCleanupExecution`, `CLEANUP_EXECUTE_BUDGET_MS` (Tasks 8–9); `toCleanupOs` from `@breeze/shared`.
- Produces: every response from `filesystemRoutes` is `{ success: true, data }` on 2xx and `{ success: false, error, data? }` on 4xx/5xx. `POST /cleanup-execute`'s `data` gains `rejectedPaths`, `partial`, `budgetMs` and per-action `status` ∈ `completed | partial | failed | skipped_locked | rejected | skipped_budget`, and the route answers `409 { error: 'agent_update_required', minAgentVersion }` for an agent below `MIN_AGENT_VERSION_CLEANUP_GUARD`. `getLatestFilesystemCleanupSnapshot` gains `capturedAt`.

- [ ] **Step 1: Update the existing tests to the new contract, and add the new cases** — in `apps/api/src/routes/devices/filesystem.test.ts`:

First, **every** `getDeviceWithOrgAndSiteCheck` mock in an execute test must carry an `osType`, because the rule re-filter cannot screen a device whose OS it does not know and fails closed (Task 8). Change each execute-test device mock from

```ts
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1' } as never);
```

to

```ts
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never);
```

Second, every mocked candidate in a `temp_files` execute test needs a `modifiedAt` older than the rule's 24h gate, or the re-filter rejects it (which is the gate working). Add at the top of the file:

```ts
const AGED = new Date(Date.now() - 72 * 3600_000).toISOString();
```

and give each mocked candidate `modifiedAt: AGED`.

Third, replace the payload assertion in `executes cleanup only for selected valid candidates`:

```ts
    expect(executeCommand).toHaveBeenCalledWith(
      deviceId,
      'file_delete',
      expect.objectContaining({
        path: '/tmp/a.tmp',
        // File-granularity rules are never recursive (spec §13 row 2).
        recursive: false,
        permanent: true,
        cleanupGuard: true,
        contentsOnly: false,
        volumeRoot: '/',
      }),
      expect.objectContaining({ userId: 'user-123' })
    );
```

Fourth, append the new cases:

```ts
  it('wraps every 2xx in { success, data } and every failure in { success: false, error }', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never);
    vi.mocked(getLatestFilesystemSnapshot).mockResolvedValue(null as never);

    const missing = await app.request(`/devices/${deviceId}/filesystem`);
    expect(missing.status).toBe(404);
    const missingBody = await missing.json();
    expect(missingBody.success).toBe(false);
    expect(missingBody.error).toBe('No filesystem analysis available yet');

    vi.mocked(getLatestFilesystemSnapshot).mockResolvedValue({
      id: 'snap-1', deviceId, capturedAt: new Date('2026-02-09T00:00:00Z'), trigger: 'on_demand',
      partial: false, summary: {}, largestFiles: [], largestDirs: [], tempAccumulation: [],
      oldDownloads: [], unrotatedLogs: [], trashUsage: [], duplicateCandidates: [],
      cleanupCandidates: [], errors: [],
    } as never);
    const found = await app.request(`/devices/${deviceId}/filesystem`);
    expect(found.status).toBe(200);
    const foundBody = await found.json();
    expect(foundBody.success).toBe(true);
    expect(foundBody.data.id).toBe('snap-1');
  });

  it('reports a path outside the pinned plan in rejectedPaths and still executes the rest', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ plan: { preview: { candidates: [] } } }]) }),
      }),
    } as never);
    vi.mocked(readPlanPreviewCandidates).mockReturnValue([
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true, modifiedAt: AGED },
    ] as never);
    vi.mocked(executeCommand).mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ deleted: true, bytesFreed: 4096, skippedLocked: [], skippedLinks: [], failedChildren: [] }),
    } as never);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'run-11' }]) }),
    } as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paths: ['/tmp/a.tmp', '/home/bob/taxes.pdf'],
        cleanupRunId: '22222222-2222-2222-2222-222222222222',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.rejectedPaths).toEqual(['/home/bob/taxes.pdf']);
    expect(body.data.bytesReclaimed).toBe(4096);
    expect(body.data.partial).toBe(false);
    expect(body.data.budgetMs).toBe(240_000);
    expect(executeCommand).toHaveBeenCalledTimes(1);
    const statuses = body.data.actions.map((a: { path: string; status: string }) => [a.path, a.status]);
    expect(statuses).toEqual([['/tmp/a.tmp', 'completed'], ['/home/bob/taxes.pdf', 'rejected']]);
  });

  it('refuses an agent older than the cleanupGuard release with 409 (spec §13 row 3)', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
      id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.114.0',
    } as never);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ plan: { preview: { candidates: [] } }, requestedAt: new Date() }]) }),
      }),
    } as never);
    vi.mocked(readPlanPreviewCandidates).mockReturnValue([
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true, modifiedAt: AGED },
    ] as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/tmp/a.tmp'], cleanupRunId: '22222222-2222-2222-2222-222222222222' }),
    });

    // An agent that ignores cleanupGuard while honouring `permanent` performs
    // an UNGUARDED recursive permanent delete. Never dispatch to one.
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('agent_update_required');
    expect(body.data.minAgentVersion).toBe('0.115.0');
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('dispatches previewedAt so the agent can refuse a file touched since the preview', async () => {
    const requestedAt = new Date('2026-09-19T12:00:00.000Z');
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
      id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0',
    } as never);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ plan: { preview: { candidates: [] } }, requestedAt }]) }),
      }),
    } as never);
    vi.mocked(readPlanPreviewCandidates).mockReturnValue([
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true, modifiedAt: AGED },
    ] as never);
    vi.mocked(executeCommand).mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ deleted: true, bytesFreed: 4096, skippedLocked: [], skippedLinks: [], failedChildren: [] }),
    } as never);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'run-14' }]) }),
    } as never);

    await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/tmp/a.tmp'], cleanupRunId: '22222222-2222-2222-2222-222222222222' }),
    });

    expect(executeCommand).toHaveBeenCalledWith(
      deviceId,
      'file_delete',
      expect.objectContaining({
        permanent: true,
        cleanupGuard: true,
        // A temp_files rule is file-granularity, so the delete is NOT recursive.
        recursive: false,
        volumeRoot: '/',
        previewedAt: requestedAt.toISOString(),
      }),
      expect.anything(),
    );
  });

  it('returns 500 with an error when every dispatched action failed', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ plan: { preview: { candidates: [] } } }]) }),
      }),
    } as never);
    vi.mocked(readPlanPreviewCandidates).mockReturnValue([
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true, modifiedAt: AGED },
    ] as never);
    vi.mocked(executeCommand).mockResolvedValue({ status: 'failed', error: 'device offline' } as never);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'run-12' }]) }),
    } as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/tmp/a.tmp'], cleanupRunId: '22222222-2222-2222-2222-222222222222' }),
    });

    // Before W01 an all-fail returned 500 with NO `error` at all, so runAction
    // had nothing to show the user (defect 4).
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('all cleanup actions failed');
    expect(body.data.actions[0].status).toBe('failed');
  });

  it('records the executedActions envelope, not a bare array', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ plan: { preview: { candidates: [] } } }]) }),
      }),
    } as never);
    vi.mocked(readPlanPreviewCandidates).mockReturnValue([
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true, modifiedAt: AGED },
    ] as never);
    vi.mocked(executeCommand).mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ deleted: true, bytesFreed: 4096, skippedLocked: [], skippedLinks: [], failedChildren: [] }),
    } as never);
    const values = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'run-13' }]) });
    vi.mocked(db.insert).mockReturnValue({ values } as never);

    await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/tmp/a.tmp'], cleanupRunId: '22222222-2222-2222-2222-222222222222' }),
    });

    const row = values.mock.calls[0]?.[0] as { executedActions: { partial: boolean; budgetMs: number; actions: unknown[] } };
    expect(row.executedActions.partial).toBe(false);
    expect(row.executedActions.budgetMs).toBe(240_000);
    expect(row.executedActions.actions).toHaveLength(1);
  });
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/api && npx vitest run src/routes/devices/filesystem.test.ts
```

Expected failure: `executes cleanup only for selected valid candidates` fails because `executeCommand` was called with `{ path, recursive: true }`, not the guarded permanent payload; the four new cases fail on `body.success` being `undefined`, `body.data.rejectedPaths` being `undefined`, `body.error` being `undefined` on the 500, and `row.executedActions.partial` being `undefined` (the column is still a bare array).

- [ ] **Step 3: Implement** — in `apps/api/src/routes/devices/filesystem.ts`, add the imports:

```ts
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { toCleanupOs } from '@breeze/shared';
import {
  CLEANUP_EXECUTE_BUDGET_MS,
  MIN_AGENT_VERSION_CLEANUP_GUARD,
  agentSupportsCleanupGuard,
  runCleanupExecution,
} from '../../services/filesystemCleanupExecution';
```

add the response helpers below `getDefaultScanPathForOs`:

```ts
/**
 * Response shape, unified across this router (spec §5.2). Before W01 the GET
 * returned a bare `{ data }`, the mutations returned `{ success, data }`, and
 * an all-fail execute returned 500 with a body carrying neither `success` nor
 * `error` — so `runAction` had nothing to show the user (defect 4/10).
 */
function okJson<T>(c: Context, data: T, status: ContentfulStatusCode = 200) {
  return c.json({ success: true, data }, status);
}

function failJson(c: Context, error: string, status: ContentfulStatusCode, data?: unknown) {
  return data === undefined
    ? c.json({ success: false, error }, status)
    : c.json({ success: false, error, data }, status);
}
```

Replace every `return c.json({ error: '...' }, <status>)` in the file with `return failJson(c, '...', <status>)`, keeping the prose identical (the web and the AI tools assert on it). The scan handler's queue failure keeps its `code`:

```ts
    if (!queued.command) {
      // 500, not 502: Cloudflare replaces an origin 502 body with its own branded
      // page, which would blank the queue's reason on hosted deployments.
      return c.json({
        success: false,
        error: queued.error || 'Failed to queue filesystem analysis',
        code: 'agent_execution_failed',
      }, 500);
    }
```

Replace the GET's return with `return okJson(c, { ...same fields... });`, and the scan/preview returns with `okJson(c, {...}, 202)` / `okJson(c, {...})`.

Then replace the whole execute body from `const byPath = new Map(...)` (`:386`) through the final `return c.json(...)` (`:459-469`) with:

```ts
    // §13 row 3. An agent without `cleanupGuard` that receives `permanent: true`
    // performs an UNGUARDED recursive permanent delete — strictly worse than
    // today's trash-move, which is why the spec's mixed-version paragraph is
    // withdrawn. Refuse before anything is dispatched.
    if (!agentSupportsCleanupGuard((device as { agentVersion?: string | null }).agentVersion)) {
      return failJson(c, 'agent_update_required', 409, {
        minAgentVersion: MIN_AGENT_VERSION_CLEANUP_GUARD,
        agentVersion: (device as { agentVersion?: string | null }).agentVersion ?? null,
      });
    }

    const requested = Array.from(new Set(paths));
    const outcome = await runCleanupExecution({
      os: toCleanupOs((device as { osType?: unknown }).osType),
      requestedPaths: requested,
      candidates,
      previewedAt,
      // The payload already carries the path; the first argument is only the
      // key the service iterates on.
      dispatch: (_path, payload) => executeCommand(
        deviceId,
        CommandTypes.FILE_DELETE,
        payload,
        { userId: auth.user.id, timeoutMs: 30_000 },
      ),
      budgetMs: CLEANUP_EXECUTE_BUDGET_MS,
    });

    const counts = {
      completed: outcome.actions.filter((action) => action.status === 'completed').length,
      partial: outcome.actions.filter((action) => action.status === 'partial').length,
      failed: outcome.actions.filter((action) => action.status === 'failed').length,
      skipped_locked: outcome.actions.filter((action) => action.status === 'skipped_locked').length,
      rejected: outcome.actions.filter((action) => action.status === 'rejected').length,
      skipped_budget: outcome.actions.filter((action) => action.status === 'skipped_budget').length,
    };
    const dispatchedPaths = outcome.actions
      .filter((action) => action.status !== 'rejected')
      .map((action) => action.path);

    if (dispatchedPaths.length === 0) {
      // Every requested path was refused. Reporting WHICH and WHY is the point
      // of defect 10's fix: the old route dropped non-candidates silently.
      return failJson(c, 'No valid cleanup paths selected from latest previewable candidates', 400, {
        actions: outcome.actions,
        rejectedPaths: outcome.rejectedPaths,
      });
    }

    const runStatus = counts.completed + counts.partial > 0 ? 'executed' : 'failed';
    const runError = runStatus === 'failed'
      ? 'all cleanup actions failed'
      : counts.failed > 0
        ? `${counts.failed} cleanup action(s) failed`
        : null;

    const [cleanupRun] = await db
      .insert(deviceFilesystemCleanupRuns)
      .values({
        deviceId,
        orgId: device.orgId,
        requestedBy: auth.user.id,
        approvedAt: new Date(),
        plan: {
          snapshotId: sourceSnapshotId,
          previewedAt: previewedAt.toISOString(),
          sourceCleanupRunId: cleanupRunId ?? null,
          requestedPaths: requested,
          selectedPaths: dispatchedPaths,
          rejectedPaths: outcome.rejectedPaths,
        },
        executedActions: {
          partial: outcome.partial,
          budgetMs: outcome.budgetMs,
          actions: outcome.actions,
        },
        bytesReclaimed: outcome.bytesReclaimed,
        status: runStatus,
        error: runError,
      })
      .returning();

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.filesystem.cleanup.execute',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        cleanupRunId: cleanupRun?.id ?? null,
        requestedCount: requested.length,
        selectedCount: dispatchedPaths.length,
        failedCount: counts.failed,
        rejectedCount: counts.rejected,
        partialCount: counts.partial,
        skippedLockedCount: counts.skipped_locked,
        skippedBudgetCount: counts.skipped_budget,
        rejectedPaths: outcome.rejectedPaths,
        partial: outcome.partial,
        bytesReclaimed: outcome.bytesReclaimed,
      },
      result: runStatus === 'executed' ? 'success' : 'failure',
    });

    const responseData = {
      cleanupRunId: cleanupRun?.id ?? null,
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

    if (runStatus === 'failed') {
      return failJson(c, 'all cleanup actions failed', 500, responseData);
    }
    return okJson(c, responseData);
```

Resolve `previewedAt` where the candidate set is resolved, and widen the two reads that supply it (§13 row 2). In the pinned branch, add `requestedAt` to the select:

```ts
      const [run] = await db
        .select({
          plan: deviceFilesystemCleanupRuns.plan,
          requestedAt: deviceFilesystemCleanupRuns.requestedAt,
        })
        .from(deviceFilesystemCleanupRuns)
```

and set `previewedAt = run.requestedAt ?? new Date(0)` there; in the unpinned fallback set `previewedAt = snapshot.capturedAt ?? new Date(0)`. Declare it alongside `sourceSnapshotId`:

```ts
    let candidates: FilesystemCleanupCandidate[];
    let sourceSnapshotId: string | null = null;
    // When the operator looked at this plan. The agent refuses any target whose
    // mtime is newer (spec §13 row 2). `new Date(0)` can only be reached by a
    // row with a null timestamp, which the column forbids; it keeps the value
    // total without silently disabling the check.
    let previewedAt = new Date(0);
```

and in `apps/api/src/services/filesystemAnalysis.ts`, add `capturedAt` to the slim cleanup-snapshot select (`:113-125`):

```ts
    .select({
      id: deviceFilesystemSnapshots.id,
      capturedAt: deviceFilesystemSnapshots.capturedAt,
      cleanupCandidates: deviceFilesystemSnapshots.cleanupCandidates,
    })
```

Delete the now-unused `FilesystemCleanupCandidate` type import only if nothing else in the file uses it (`candidates` is still typed with it, so keep it).

- [ ] **Step 4: Run them and watch them pass**

```bash
cd apps/api && npx vitest run src/routes/devices/filesystem.test.ts src/services/filesystemCleanupExecution.test.ts
```

Expected: both files green.

- [ ] **Step 5: Typecheck and sweep for other readers of these responses**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-green-meadow-232b && pnpm exec tsc --noEmit --project apps/api/tsconfig.json && grep -rn "filesystem/cleanup-execute\|filesystem/cleanup-preview" apps/web/src apps/api/src e2e-tests 2>/dev/null | grep -v "\.test\."
```

Expected: tsc clean; the grep lists only `apps/api/src/routes/devices/filesystem.ts`, `apps/web/src/components/remote/FileManager.tsx` and `apps/web/src/components/devices/DeviceFilesystemTab.tsx` — all three read `body.data`, which is unchanged, and Tasks 12/14 update them.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/devices/filesystem.ts apps/api/src/routes/devices/filesystem.test.ts
git commit -m "$(cat <<'EOF'
fix(api): wire cleanup-execute to the guarded permanent dispatch; unify responses

The route now runs the cleanup execution service: permanent + cleanupGuard +
contentsOnly per path, a four-minute wall-clock budget, and an honest per-path
status. Paths outside the pinned plan or refused by the rule table come back in
rejectedPaths instead of being dropped silently.

Every response from this router is now { success: true, data } on 2xx and
{ success: false, error, data? } on 4xx/5xx. An all-fail execute answers 500
with error: 'all cleanup actions failed' — it previously returned 500 with no
error field at all, so the UI had nothing to show.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §2 defects 1, 4 and 10, §5.2

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10b: Persist `filesystem_analysis` results delivered over WebSocket (§13 row 9)

An existing bug this wave cannot leave alone: the scan is dispatched with `preferHeartbeat: false`, so its result normally comes back over the socket — and the socket never writes a snapshot. Every fix above is invisible to a device whose results take that leg.

**Verified before writing this task:** `handleFilesystemAnalysisCommandResult` has exactly one caller, `routes/agents/commands.ts:525` (the HTTP result route). The WebSocket leg dispatches only the `commandResultHandlers` registry (`routes/agentWs.ts:2310`), and `filesystem_analysis` is absent from it (`services/commandResultHandlers.ts:897-921`).

**Files:**
- Modify: `apps/api/src/services/commandResultHandlers.ts` — add one registry entry + its adapter
- Create: `apps/api/src/services/commandResultHandlers.filesystem.test.ts` (Test)

**Interfaces:**
- Consumes: `handleFilesystemAnalysisCommandResult` (`routes/agents/helpers.ts:1593`), `devices` schema.
- Produces: `commandResultHandlers['filesystem_analysis']`.

**Do NOT add `filesystem_analysis` to `REGISTRY_DISPATCHED_COMMAND_TYPES`** (`routes/agents/commands.ts:89-103`). That is a *separate* allowlist gating the HTTP leg's registry dispatch; the HTTP leg already calls the handler directly at `:525`, so adding it there would save every snapshot twice.

- [ ] **Step 1: Write the failing test** — create `apps/api/src/services/commandResultHandlers.filesystem.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

// §13 row 9. filesystem_analysis is dispatched with preferHeartbeat: false, so
// its result normally arrives over the WebSocket — and the WS leg dispatches
// ONLY this registry. Without an entry here the scan completes, the agent's
// payload is discarded, and the Disk Cleanup tab stays empty with no error.

vi.mock('../routes/agents/helpers', () => ({
  handleFilesystemAnalysisCommandResult: vi.fn(async () => {}),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => [{ orgId: 'org-123' }]) })),
      })),
    })),
  },
}));

import { commandResultHandlers } from './commandResultHandlers';
import { handleFilesystemAnalysisCommandResult } from '../routes/agents/helpers';

describe('filesystem_analysis result handler registration', () => {
  it('is registered, so the WebSocket leg persists the snapshot', () => {
    expect(commandResultHandlers['filesystem_analysis']).toBeTypeOf('function');
  });

  it('forwards the command and the device org to the existing handler', async () => {
    const command = {
      id: 'cmd-1',
      deviceId: 'dev-1',
      type: 'filesystem_analysis',
      payload: { path: '/', trigger: 'on_demand', scanMode: 'baseline' },
    } as never;
    const result = { status: 'completed', stdout: '{"path":"/"}' } as never;

    await commandResultHandlers['filesystem_analysis']!({
      agentId: 'agent-1',
      command,
      commandId: 'cmd-1',
      result,
      resolvedDeviceId: 'dev-1',
      stdout: '{"path":"/"}',
    });

    expect(handleFilesystemAnalysisCommandResult).toHaveBeenCalledWith(command, result, 'org-123');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/commandResultHandlers.filesystem.test.ts
```

Expected failure: `expected undefined to be a function` — there is no `filesystem_analysis` entry.

- [ ] **Step 3: Implement** — in `apps/api/src/services/commandResultHandlers.ts`, add the adapter above the registry and one entry inside it:

```ts
/**
 * §13 row 9: filesystem_analysis results delivered over the WebSocket were
 * never persisted. The scan is dispatched with `preferHeartbeat: false`, so the
 * socket is the NORMAL leg — the handler existed only on the HTTP route
 * (routes/agents/commands.ts:525), and a completed scan silently wrote nothing.
 *
 * The HTTP leg keeps its direct call: its registry dispatch is gated on the
 * separate REGISTRY_DISPATCHED_COMMAND_TYPES allowlist, which this type is
 * deliberately NOT added to, so nothing is saved twice.
 *
 * `orgId` is not a handler parameter, so it is read from the device the
 * transport already authorized — the same shape handleDiscoveryResult uses for
 * its job lookup.
 */
async function handleFilesystemAnalysisResult({
  command,
  result,
  resolvedDeviceId,
}: Parameters<CommandResultHandler>[0]): Promise<void> {
  const { handleFilesystemAnalysisCommandResult } = await import('../routes/agents/helpers');
  const [device] = await db
    .select({ orgId: devices.orgId })
    .from(devices)
    .where(eq(devices.id, resolvedDeviceId))
    .limit(1);
  if (!device) {
    console.warn(`[commandResultHandlers] filesystem_analysis result for unknown device ${resolvedDeviceId}`);
    return;
  }
  await handleFilesystemAnalysisCommandResult(command, result, device.orgId);
}
```

```ts
  install_patches: handleInstallPatchesResult,
  filesystem_analysis: handleFilesystemAnalysisResult,
};
```

Confirm `devices` and `eq` are already imported in that file; add them if not.

- [ ] **Step 4: Run it and watch it pass, then confirm the HTTP leg is unchanged**

```bash
cd apps/api && npx vitest run src/services/commandResultHandlers.filesystem.test.ts src/services/commandResultHandlers.test.ts
grep -n "filesystem_analysis" apps/api/src/routes/agents/commands.ts
```

Expected: both suites green, and the grep shows only the existing `filesystemAnalysisCommandType` branch at `:523-530` — **not** a new entry in `REGISTRY_DISPATCHED_COMMAND_TYPES`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/commandResultHandlers.ts apps/api/src/services/commandResultHandlers.filesystem.test.ts
git commit -m "$(cat <<'EOF'
fix(api): persist filesystem_analysis results delivered over WebSocket

Existing bug, found by the Codex quorum (spec §13 row 9). The scan is dispatched
with preferHeartbeat: false, so its result normally returns over the socket —
and the socket leg dispatches only the commandResultHandlers registry, which had
no filesystem_analysis entry. Every such scan completed, discarded the agent's
payload, and left the Disk Cleanup tab empty with no error anywhere.

The HTTP leg keeps its direct call: its registry dispatch is gated on the
separate REGISTRY_DISPATCHED_COMMAND_TYPES allowlist, which this type is
deliberately not added to, so nothing is saved twice.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §13 row 9

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: AI lane — never store an empty snapshot (defect 5)

**Files:**
- Modify: `apps/api/src/services/aiToolsFilesystem.ts` — the `analyze_disk_usage` refresh branch (`:185-186`)
- Create: `apps/api/src/services/aiToolsFilesystem.emptySnapshot.test.ts` (Test)

**Interfaces:**
- Consumes: `parseFilesystemAnalysisStdout`, `saveFilesystemSnapshot` (unchanged).
- Produces: no new exports. `analyze_disk_usage` returns `{ error: 'Filesystem analysis returned no parseable result; no snapshot was stored.' }` instead of saving `{}`.

- [ ] **Step 1: Write the failing test** — create `apps/api/src/services/aiToolsFilesystem.emptySnapshot.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Defect 5: the agent RESULT lane guards this (routes/agents/helpers.ts:1607-1615
// warns and writes nothing when stdout is empty or non-JSON), but the AI lane
// saved the parsed `{}` unconditionally — and because "latest snapshot" is
// ordered by captured_at, that blank row became the snapshot every later
// preview read, zeroing the tab for everyone.

const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const ORG_ID = '11111111-1111-1111-1111-111111111111';

const dbMockState = vi.hoisted(() => ({
  deviceRows: [] as unknown[],
  userRows: [] as unknown[],
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn((table: unknown) => {
        const tableName = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => Promise.resolve(tableName === 'users' ? dbMockState.userRows : dbMockState.deviceRows));
        return chain;
      });
      return chain;
    }),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 'run-1' }]) })),
    })),
  },
}));

const commandResult = vi.hoisted(() => ({ value: { status: 'completed', stdout: '' } as Record<string, unknown> }));

vi.mock('./commandQueue', () => ({
  executeCommand: vi.fn(async () => commandResult.value),
  CommandTypes: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

vi.mock('./filesystemAnalysis', () => ({
  buildCleanupPreview: vi.fn(() => ({ candidates: [], estimatedBytes: 0, candidateCount: 0, categories: [] })),
  getLatestFilesystemSnapshot: vi.fn(async () => null),
  getLatestFilesystemCleanupSnapshot: vi.fn(async () => null),
  parseFilesystemAnalysisStdout: vi.fn((stdout: string) => {
    try {
      const parsed = JSON.parse(stdout) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }),
  saveFilesystemSnapshot: vi.fn(async () => ({ id: 'snap-1' })),
  safeCleanupCategories: ['temp_files'],
}));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerFilesystemTools } from './aiToolsFilesystem';
import { saveFilesystemSnapshot } from './filesystemAnalysis';

function getTool(name: string): AiTool {
  const aiTools = new Map<string, AiTool>();
  registerFilesystemTools(aiTools);
  const tool = aiTools.get(name);
  if (!tool) throw new Error(`${name} tool not registered`);
  return tool;
}

function makeAuth(): AuthContext {
  return {
    user: { id: 'user-1', email: 'u@example.com', name: 'U' },
    token: {} as unknown,
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    orgCondition: vi.fn(() => undefined),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'test-session' },
  } as unknown as AuthContext;
}

describe('analyze_disk_usage empty-snapshot guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMockState.userRows = [{ id: 'user-1' }];
    dbMockState.deviceRows = [{ id: DEVICE_ID, orgId: ORG_ID, siteId: null, hostname: 'host-1', status: 'online', osType: 'linux', agentVersion: '0.115.0' }];
  });

  it('stores nothing and reports an error when stdout is empty', async () => {
    commandResult.value = { status: 'completed', stdout: '' };
    const raw = await getTool('analyze_disk_usage').handler({ deviceId: DEVICE_ID, refresh: true }, makeAuth());
    const result = JSON.parse(raw);
    expect(saveFilesystemSnapshot).not.toHaveBeenCalled();
    expect(result.error).toContain('no parseable result');
  });

  it('stores nothing when stdout is not JSON', async () => {
    commandResult.value = { status: 'completed', stdout: 'panic: runtime error' };
    const raw = await getTool('analyze_disk_usage').handler({ deviceId: DEVICE_ID, refresh: true }, makeAuth());
    expect(saveFilesystemSnapshot).not.toHaveBeenCalled();
    expect(JSON.parse(raw).error).toContain('no parseable result');
  });

  it('still stores a real payload', async () => {
    commandResult.value = {
      status: 'completed',
      stdout: JSON.stringify({ path: '/', summary: { filesScanned: 10 }, cleanupCandidates: [] }),
    };
    const raw = await getTool('analyze_disk_usage').handler({ deviceId: DEVICE_ID, refresh: true }, makeAuth());
    expect(saveFilesystemSnapshot).toHaveBeenCalledTimes(1);
    expect(JSON.parse(raw).error).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/aiToolsFilesystem.emptySnapshot.test.ts
```

Expected failure: the first two cases fail with `expected "spy" to not be called at all, but actually been called 1 times` — the unguarded `saveFilesystemSnapshot(deviceId, orgId, 'on_demand', {})`.

- [ ] **Step 3: Implement** — in `apps/api/src/services/aiToolsFilesystem.ts`, replace lines 185-186:

```ts
        const parsed = parseFilesystemAnalysisStdout(commandResult.stdout ?? '{}');
        if (Object.keys(parsed).length === 0) {
          // Defect 5: the agent RESULT lane already refuses to write a blank
          // snapshot (routes/agents/helpers.ts). Without the same guard here, a
          // completed scan with empty or non-JSON stdout stored `{}`, which then
          // WON the captured_at ordering and became the "latest snapshot" every
          // later cleanup preview read — zeroing the Disk Cleanup tab with no
          // error anywhere.
          console.warn(
            `[aiToolsFilesystem] analyze_disk_usage for device ${deviceId} completed with unparseable/empty stdout (len=${commandResult.stdout?.length ?? 0}); no snapshot written`
          );
          return JSON.stringify({
            error: 'Filesystem analysis returned no parseable result; no snapshot was stored. Retry the scan.',
          });
        }
        snapshot = await saveFilesystemSnapshot(deviceId, access.device.orgId, 'on_demand', parsed);
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/api && npx vitest run src/services/aiToolsFilesystem.emptySnapshot.test.ts src/services/aiToolsFilesystem.diskCleanupRequestedBy.test.ts src/services/aiToolsFilesystem.fileWriteCap.test.ts
```

Expected: three files green (the sibling suites are listed explicitly because a vitest path filter is a substring, not a directory prefix).

- [ ] **Step 5: Typecheck and commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-green-meadow-232b && pnpm exec tsc --noEmit --project apps/api/tsconfig.json
git add apps/api/src/services/aiToolsFilesystem.ts apps/api/src/services/aiToolsFilesystem.emptySnapshot.test.ts
git commit -m "$(cat <<'EOF'
fix(api): AI lane never stores an empty filesystem snapshot (defect 5)

The agent result lane refuses to write a snapshot when a completed
filesystem_analysis returns empty or non-JSON stdout. The AI lane saved the
parsed {} unconditionally, and because "latest snapshot" is ordered by
captured_at, that blank row became the snapshot every later cleanup preview
read — an empty Disk Cleanup tab with no error anywhere.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §2 defect 5

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11b: AI lane — execute through the shared cleanup execution path (defect 1, second lane)

Defect 1 is one bug with two call sites. Task 10 fixed the route; this fixes the AI lane, which has its **own** copy of the execute loop (`aiToolsFilesystem.ts:322-341`) dispatching the same `{ path, recursive: true }` — so without this task an operator who says "clean up this disk" in chat still frees zero bytes, and on a non-OS volume still grows `C:\`. The fix is to delete that loop and call the same `runCleanupExecution` the route calls, so the two lanes cannot drift again.

**W01 scope limit:** the tool's **input schema is unchanged** — no `path` property, `cleanupRunId` is still not accepted, and `paths` keeps its current shape. Only the execution path is unified. The schema work (`path`, required `cleanupRunId`, the 200-path cap, the run-level audit) stays in W05 with the rest of §9.

**Files:**
- Modify: `apps/api/src/services/aiToolsFilesystem.ts` — the `disk_cleanup` execute branch (`:307-373`)
- Create: `apps/api/src/services/aiToolsFilesystem.executePermanent.test.ts` (Test)

**Interfaces:**
- Consumes: `runCleanupExecution`, `CLEANUP_EXECUTE_BUDGET_MS` (Tasks 8–9); `toCleanupOs` from `@breeze/shared`.
- Produces: no new exports. `disk_cleanup` with `action: 'execute'` now returns `rejectedPaths`, `partial`, `budgetMs` and `counts` alongside its existing fields, and stores the `{ partial, budgetMs, actions }` envelope in `executedActions`.

- [ ] **Step 1: Write the failing test** — create `apps/api/src/services/aiToolsFilesystem.executePermanent.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Defect 1, second lane. `disk_cleanup action=execute` had its OWN dispatch
// loop that sent { path, recursive: true } with no `permanent`, so the agent
// MOVED every "deleted" file into ~/.breeze-trash on the same volume for 30
// days — zero bytes freed — and across volumes fell back to copy+remove, so an
// AI-driven cleanup of D:\ grew C:\. This suite pins the dispatched payload and
// the shared screening, so the two lanes cannot drift again.

const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const AGED = new Date(Date.now() - 72 * 3600_000).toISOString();

const dbMockState = vi.hoisted(() => ({
  deviceRows: [] as unknown[],
  userRows: [] as unknown[],
  insertedRuns: [] as Record<string, unknown>[],
}));

const previewState = vi.hoisted(() => ({
  candidates: [] as unknown[],
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn((table: unknown) => {
        const tableName = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => Promise.resolve(tableName === 'users' ? dbMockState.userRows : dbMockState.deviceRows));
        return chain;
      });
      return chain;
    }),
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => ({
        returning: vi.fn(async () => {
          const id = `run-${dbMockState.insertedRuns.length + 1}`;
          dbMockState.insertedRuns.push({ ...row, id });
          return [{ id, ...row }];
        }),
      })),
    })),
  },
}));

const executeCommand = vi.hoisted(() => vi.fn());

vi.mock('./commandQueue', () => ({
  // aiExecuteCommand delegates straight to executeCommand (aiDispatch.ts:66-76),
  // so asserting here asserts exactly what reaches the device.
  executeCommand,
  CommandTypes: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

vi.mock('./filesystemAnalysis', () => ({
  buildCleanupPreview: vi.fn(() => ({
    snapshotId: 'snap-1',
    estimatedBytes: 4096,
    candidateCount: previewState.candidates.length,
    categories: [{ category: 'temp_files', count: 1, estimatedBytes: 4096 }],
    candidates: previewState.candidates,
  })),
  getLatestFilesystemSnapshot: vi.fn(async () => null),
  getLatestFilesystemCleanupSnapshot: vi.fn(async () => ({ id: 'snap-1', capturedAt: new Date('2026-09-19T12:00:00Z'), cleanupCandidates: [] })),
  parseFilesystemAnalysisStdout: vi.fn(() => ({})),
  saveFilesystemSnapshot: vi.fn(),
  safeCleanupCategories: ['temp_files', 'browser_cache', 'package_cache', 'trash'],
}));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerFilesystemTools } from './aiToolsFilesystem';

function getDiskCleanupTool(): AiTool {
  const aiTools = new Map<string, AiTool>();
  registerFilesystemTools(aiTools);
  const tool = aiTools.get('disk_cleanup');
  if (!tool) throw new Error('disk_cleanup tool not registered');
  return tool;
}

function makeAuth(): AuthContext {
  return {
    user: { id: 'user-1', email: 'u@example.com', name: 'U' },
    token: {} as unknown,
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    orgCondition: vi.fn(() => undefined),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'test-session' },
  } as unknown as AuthContext;
}

describe('disk_cleanup execute dispatches a permanent, guarded delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMockState.userRows = [{ id: 'user-1' }];
    dbMockState.deviceRows = [{
      id: DEVICE_ID, orgId: ORG_ID, siteId: null, hostname: 'host-1', status: 'online', osType: 'linux', agentVersion: '0.115.0',
    }];
    dbMockState.insertedRuns = [];
    previewState.candidates = [
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true, modifiedAt: AGED },
    ];
    executeCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ deleted: true, bytesFreed: 4096, skippedLocked: [], skippedLinks: [], failedChildren: [] }),
    });
  });

  it('sends permanent + cleanupGuard, not a trash-move', async () => {
    const raw = await getDiskCleanupTool().handler(
      { deviceId: DEVICE_ID, action: 'execute', paths: ['/tmp/a.tmp'] },
      makeAuth(),
    );
    const result = JSON.parse(raw);

    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith(
      DEVICE_ID,
      'file_delete',
      {
        path: '/tmp/a.tmp',
        recursive: true,
        permanent: true,
        cleanupGuard: true,
        contentsOnly: false,
      },
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(result.bytesReclaimed).toBe(4096);
    expect(result.status).toBe('executed');
  });

  it('sets contentsOnly for a trash root, from the same rule table the route uses', async () => {
    dbMockState.deviceRows = [{
      id: DEVICE_ID, orgId: ORG_ID, siteId: null, hostname: 'host-1', status: 'online', osType: 'macos', agentVersion: '0.115.0',
    }];
    previewState.candidates = [
      { path: '/Users/alice/.Trash', category: 'trash', sizeBytes: 100, safe: true },
    ];

    await getDiskCleanupTool().handler(
      { deviceId: DEVICE_ID, action: 'execute', paths: ['/Users/alice/.Trash'] },
      makeAuth(),
    );

    expect(executeCommand).toHaveBeenCalledWith(
      DEVICE_ID,
      'file_delete',
      expect.objectContaining({ contentsOnly: true, permanent: true, cleanupGuard: true }),
      expect.anything(),
    );
  });

  it('rejects a path the rule table no longer claims and never dispatches it', async () => {
    dbMockState.deviceRows = [{
      id: DEVICE_ID, orgId: ORG_ID, siteId: null, hostname: 'host-1', status: 'online', osType: 'windows', agentVersion: '0.115.0',
    }];
    const stale = 'C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Bookmarks';
    previewState.candidates = [{ path: stale, category: 'browser_cache', sizeBytes: 2048, safe: true }];

    const raw = await getDiskCleanupTool().handler(
      { deviceId: DEVICE_ID, action: 'execute', paths: [stale] },
      makeAuth(),
    );
    const result = JSON.parse(raw);

    expect(executeCommand).not.toHaveBeenCalled();
    expect(result.rejectedPaths).toEqual([stale]);
    expect(result.error).toContain('No valid cleanup');
  });

  it('reports a path outside the preview set instead of dropping it silently', async () => {
    const raw = await getDiskCleanupTool().handler(
      { deviceId: DEVICE_ID, action: 'execute', paths: ['/tmp/a.tmp', '/home/bob/taxes.pdf'] },
      makeAuth(),
    );
    const result = JSON.parse(raw);

    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(result.rejectedPaths).toEqual(['/home/bob/taxes.pdf']);
    expect(result.actions.map((a: { path: string; status: string }) => [a.path, a.status])).toEqual([
      ['/tmp/a.tmp', 'completed'],
      ['/home/bob/taxes.pdf', 'rejected'],
    ]);
  });

  it('stores the executedActions envelope, matching the route', async () => {
    await getDiskCleanupTool().handler(
      { deviceId: DEVICE_ID, action: 'execute', paths: ['/tmp/a.tmp'] },
      makeAuth(),
    );
    const run = dbMockState.insertedRuns[0] as { executedActions: { partial: boolean; budgetMs: number; actions: unknown[] } };
    expect(run.executedActions.partial).toBe(false);
    expect(run.executedActions.budgetMs).toBe(240_000);
    expect(run.executedActions.actions).toHaveLength(1);
  });

  it('refuses an agent older than the cleanupGuard release (spec §13 row 3)', async () => {
    dbMockState.deviceRows = [{
      id: DEVICE_ID, orgId: ORG_ID, siteId: null, hostname: 'host-1', status: 'online', osType: 'linux', agentVersion: '0.114.0',
    }];
    const raw = await getDiskCleanupTool().handler(
      { deviceId: DEVICE_ID, action: 'execute', paths: ['/tmp/a.tmp'] },
      makeAuth(),
    );
    const result = JSON.parse(raw);
    expect(executeCommand).not.toHaveBeenCalled();
    expect(result.error).toBe('agent_update_required');
    expect(result.minAgentVersion).toBe('0.115.0');
  });

  it('keeps the W01 input schema unchanged — no path, no cleanupRunId', () => {
    const properties = getDiskCleanupTool().definition.input_schema.properties as Record<string, unknown>;
    // Both arrive in W05 with the rest of §9; W01 unifies the EXECUTION path only.
    expect(properties).not.toHaveProperty('path');
    expect(properties).not.toHaveProperty('cleanupRunId');
    expect(Object.keys(properties).sort()).toEqual(['action', 'categories', 'deviceId', 'maxCandidates', 'paths']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/aiToolsFilesystem.executePermanent.test.ts
```

Expected failure: the first case fails with the received payload `{ path: '/tmp/a.tmp', recursive: true }` — no `permanent`, no `cleanupGuard`, no `contentsOnly`; `result.rejectedPaths` is `undefined` in the two rejection cases; `run.executedActions.partial` is `undefined` (the AI lane still writes a bare array).

- [ ] **Step 3: Implement** — in `apps/api/src/services/aiToolsFilesystem.ts`, add the imports:

```ts
import { toCleanupOs } from '@breeze/shared';
import {
  CLEANUP_EXECUTE_BUDGET_MS,
  MIN_AGENT_VERSION_CLEANUP_GUARD,
  agentSupportsCleanupGuard,
  runCleanupExecution,
} from './filesystemCleanupExecution';
```

and replace the execute branch (`:307-373`) — everything from `const requestedPaths = ...` to the closing `});` of the returned JSON — with:

```ts
      const requestedPaths = Array.isArray(input.paths)
        ? input.paths.filter((v): v is string => typeof v === 'string')
        : [];
      if (requestedPaths.length === 0) {
        return JSON.stringify({ error: 'paths are required for execute action' });
      }

      // Defect 1 is ONE bug with two call sites. This lane used to keep its own
      // copy of the loop and dispatched { path, recursive: true }, so the agent
      // moved every "deleted" file to ~/.breeze-trash on the same volume and
      // freed nothing. Both lanes now run the same screening and the same
      // dispatch payload, which is the only way they stay in step.
      // §13 row 3: the AI lane is gated exactly like the route. An agent
      // without cleanupGuard would perform an unguarded permanent delete.
      if (!agentSupportsCleanupGuard(access.device.agentVersion)) {
        return JSON.stringify({
          error: 'agent_update_required',
          minAgentVersion: MIN_AGENT_VERSION_CLEANUP_GUARD,
          agentVersion: access.device.agentVersion ?? null,
        });
      }

      const outcome = await runCleanupExecution({
        os: toCleanupOs(access.device.osType),
        requestedPaths,
        candidates: preview.candidates,
        // The AI lane re-derives its preview from the latest snapshot, so the
        // snapshot's capture time is when the model "looked" (spec §13 row 2).
        previewedAt: snapshot.capturedAt ?? new Date(0),
        // The payload already carries the path; the first argument is only the
        // key the service iterates on.
        dispatch: (_path, payload) => aiExecuteCommand(
          auth,
          'disk_cleanup',
          deviceId,
          'file_delete',
          payload,
          { userId: auth.user.id, timeoutMs: 30_000 },
        ),
        budgetMs: CLEANUP_EXECUTE_BUDGET_MS,
      });

      const counts = {
        completed: outcome.actions.filter((action) => action.status === 'completed').length,
        partial: outcome.actions.filter((action) => action.status === 'partial').length,
        failed: outcome.actions.filter((action) => action.status === 'failed').length,
        skipped_locked: outcome.actions.filter((action) => action.status === 'skipped_locked').length,
        rejected: outcome.actions.filter((action) => action.status === 'rejected').length,
        skipped_budget: outcome.actions.filter((action) => action.status === 'skipped_budget').length,
      };
      const dispatchedPaths = outcome.actions
        .filter((action) => action.status !== 'rejected')
        .map((action) => action.path);

      if (dispatchedPaths.length === 0) {
        // Every requested path was refused. Say WHICH — the old handler
        // returned a bare "No valid cleanup candidates selected" with no list,
        // so the model could not tell a typo from a rule rejection.
        return JSON.stringify({
          error: 'No valid cleanup candidates selected from the latest preview set',
          rejectedPaths: outcome.rejectedPaths,
          actions: outcome.actions,
        });
      }

      const runStatus = counts.completed + counts.partial > 0 ? 'executed' : 'failed';
      const runError = runStatus === 'failed'
        ? 'all cleanup actions failed'
        : counts.failed > 0
          ? `${counts.failed} cleanup action(s) failed`
          : null;

      const [cleanupRun] = await db
        .insert(deviceFilesystemCleanupRuns)
        .values({
          deviceId,
          orgId: access.device.orgId,
          requestedBy: safeRequestedBy,
          approvedAt: new Date(),
          plan: {
            snapshotId: snapshot.id,
            requestedPaths,
            selectedPaths: dispatchedPaths,
            rejectedPaths: outcome.rejectedPaths,
          },
          executedActions: {
            partial: outcome.partial,
            budgetMs: outcome.budgetMs,
            actions: outcome.actions,
          },
          bytesReclaimed: outcome.bytesReclaimed,
          status: runStatus,
          error: runError,
        })
        .returning();

      return JSON.stringify({
        cleanupRunId: cleanupRun?.id ?? null,
        snapshotId: snapshot.id,
        status: runStatus,
        bytesReclaimed: outcome.bytesReclaimed,
        selectedCount: dispatchedPaths.length,
        failedCount: counts.failed,
        counts,
        rejectedPaths: outcome.rejectedPaths,
        partial: outcome.partial,
        budgetMs: outcome.budgetMs,
        actions: outcome.actions,
      });
```

Leave `disk_cleanup`'s `input_schema` (`:233-243`) exactly as it is — no `path`, no `cleanupRunId`, no `paths` cap. Those are W05.

- [ ] **Step 4: Run it and watch it pass, together with the sibling suites**

```bash
cd apps/api && npx vitest run src/services/aiToolsFilesystem.executePermanent.test.ts src/services/aiToolsFilesystem.emptySnapshot.test.ts src/services/aiToolsFilesystem.diskCleanupRequestedBy.test.ts src/services/aiToolsFilesystem.fileWriteCap.test.ts
```

Expected: four files green. `aiToolsFilesystem.diskCleanupRequestedBy.test.ts`'s execute case needs two edits to match the new screening, and they are the fix, not a workaround: give its device row `osType: 'linux'`, and change its mocked candidate from `{ path: '/tmp/junk.log', category: 'temp', sizeBytes: 1024 }` to `{ path: '/tmp/junk.log', category: 'temp_files', sizeBytes: 1024, safe: true, modifiedAt: new Date(Date.now() - 72 * 3600_000).toISOString() }` — the old fixture used a category that does not exist and an mtime that cannot clear the 24h temp gate.

- [ ] **Step 5: Prove no dispatch path is left behind**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-green-meadow-232b && grep -rn "FILE_DELETE\|'file_delete'" apps/api/src --include='*.ts' | grep -v '\.test\.' | grep -v commandTypes.ts
```

Expected exactly three lines: `services/commandQueue.ts` (registry entries), `routes/systemTools/fileBrowser.ts:428` (the File Manager's own recoverable delete — unchanged by design, spec §10.3), and `services/commandTimeouts.ts` / `services/commandOfflinePolicy.ts` registry entries. **Neither `routes/devices/filesystem.ts` nor `services/aiToolsFilesystem.ts` may still name `FILE_DELETE` directly** — both now go through `runCleanupExecution`, and `services/filesystemCleanupExecution.ts` itself names no command type (the caller supplies `dispatch`).

- [ ] **Step 6: Typecheck and commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-green-meadow-232b && pnpm exec tsc --noEmit --project apps/api/tsconfig.json
git add apps/api/src/services/aiToolsFilesystem.ts apps/api/src/services/aiToolsFilesystem.executePermanent.test.ts apps/api/src/services/aiToolsFilesystem.diskCleanupRequestedBy.test.ts
git commit -m "$(cat <<'EOF'
fix(api): AI disk_cleanup executes through the shared cleanup path (defect 1)

Defect 1 is one bug with two call sites. The route was fixed a commit ago; the
AI lane kept its own copy of the loop and still dispatched
{ path, recursive: true }, so "clean up this disk" in chat MOVED every file to
~/.breeze-trash on the same volume — zero bytes freed — and on a non-OS volume
fell back to copy+remove, growing C:\ while cleaning D:\.

The loop is deleted. Both lanes now call runCleanupExecution, so they share the
rule re-filter, the permanent + cleanupGuard + contentsOnly payload, the budget,
the per-path status vocabulary and rejectedPaths. The tool's input schema is
deliberately unchanged (no `path`, no `cleanupRunId`) — §9's schema work is W05.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §2 defect 1, §5.2, §10.3

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Web — `runAction`, an abortable poll, hook deps, ARIA roles and stable keys (defect 9)

**Files:**
- Modify: `apps/web/src/components/devices/DeviceFilesystemTab.tsx` (`:290-507`, `:606-625`, `:813-857`, `:935-945`)
- Create: `apps/web/src/components/devices/DeviceFilesystemTab.test.tsx` (Test)
- Modify: `apps/web/src/lib/runActionAllowlist.ts` (remove line 17)
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (add to `TARGET_GLOBS`; bump the count 146 → 147)

**Interfaces:**
- Consumes: `runAction`, `handleActionError` (`@/lib/runAction`); `navigateTo`, `loginPathWithNext`.
- Produces: no new exports. The two mutating handlers (`runAnalyze`, `runCleanupPreview`) go through `runAction`; `pollScanCommand` takes an `AbortSignal`; the two banners carry `role="alert"` / `role="status"` and `data-testid`.

- [ ] **Step 1: Write the failing test** — create `apps/web/src/components/devices/DeviceFilesystemTab.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceFilesystemTab from './DeviceFilesystemTab';
import { fetchWithAuth } from '../../stores/auth';

const showToast = vi.fn();

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: (input: unknown) => showToast(input),
}));

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const DEVICE_ID = '11111111-1111-1111-1111-111111111111';

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const SNAPSHOT = {
  id: 'snap-1',
  capturedAt: '2026-09-18T00:00:00Z',
  trigger: 'on_demand',
  partial: false,
  summary: { filesScanned: 10 },
  cleanupCandidates: [],
  topLargestFiles: [{ path: '/tmp/a', sizeBytes: 10 }, { sizeBytes: 5 }],
  topLargestDirectories: [{ path: '/tmp', sizeBytes: 10 }],
  oldDownloads: [],
  unrotatedLogs: [],
  trashUsage: [],
  duplicateCandidates: [],
  errors: [],
};

function routeFetch(handler: (url: string, init?: RequestInit) => Response) {
  fetchWithAuthMock.mockImplementation(((url: string, init?: RequestInit) =>
    Promise.resolve(handler(url, init))) as typeof fetchWithAuth);
}

describe('DeviceFilesystemTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    showToast.mockClear();
  });

  it('renders the error banner with role="alert" so a screen reader announces it', async () => {
    routeFetch((url) => {
      if (url.includes('/filesystem')) return jsonResponse({ success: false, error: 'boom' }, false, 500);
      return jsonResponse({ data: [] });
    });

    render(<DeviceFilesystemTab deviceId={DEVICE_ID} osType="linux" />);
    const banner = await screen.findByTestId('filesystem-error-banner');
    expect(banner).toHaveAttribute('role', 'alert');
  });

  it('toasts through runAction when the scan POST fails instead of failing silently', async () => {
    routeFetch((url, init) => {
      if (init?.method === 'POST' && url.includes('/filesystem/scan')) {
        return jsonResponse({ success: false, error: 'agent offline' }, false, 500);
      }
      if (url.includes('/filesystem')) return jsonResponse({ data: SNAPSHOT });
      return jsonResponse({ data: [] });
    });

    render(<DeviceFilesystemTab deviceId={DEVICE_ID} osType="linux" />);
    fireEvent.click(await screen.findByTestId('filesystem-analyze-button'));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'agent offline' }));
    });
  });

  it('toasts through runAction when the cleanup-preview POST fails', async () => {
    routeFetch((url, init) => {
      if (init?.method === 'POST' && url.includes('/filesystem/cleanup-preview')) {
        return jsonResponse({ success: false, error: 'no snapshot' }, false, 404);
      }
      if (url.includes('/filesystem')) return jsonResponse({ data: SNAPSHOT });
      return jsonResponse({ data: [] });
    });

    render(<DeviceFilesystemTab deviceId={DEVICE_ID} osType="linux" />);
    fireEvent.click(await screen.findByTestId('filesystem-preview-button'));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'no snapshot' }));
    });
  });

  it('shows the running banner with role="status" and aborts the poll on unmount', async () => {
    routeFetch((url, init) => {
      if (init?.method === 'POST' && url.includes('/filesystem/scan')) {
        return jsonResponse({ success: true, data: { commandId: 'cmd-1', status: 'pending' } }, true, 202);
      }
      if (url.includes('/commands/cmd-1')) return jsonResponse({ data: { id: 'cmd-1', status: 'pending' } });
      if (url.includes('/filesystem')) return jsonResponse({ data: SNAPSHOT });
      return jsonResponse({ data: [] });
    });

    const { unmount } = render(<DeviceFilesystemTab deviceId={DEVICE_ID} osType="linux" />);
    fireEvent.click(await screen.findByTestId('filesystem-analyze-button'));

    const banner = await screen.findByTestId('filesystem-scan-banner');
    expect(banner).toHaveAttribute('role', 'status');

    // The poll loop outlived unmount, so a scan started and then navigated away
    // from kept fetching for minutes and setting state on a dead component.
    const pollCall = fetchWithAuthMock.mock.calls.find(([url]) => String(url).includes('/commands/cmd-1'));
    expect(pollCall).toBeDefined();
    const signal = (pollCall?.[1] as RequestInit | undefined)?.signal as AbortSignal | undefined;
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);

    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('renders a row whose path is missing without a duplicate React key', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    routeFetch((url) => {
      if (url.includes('/filesystem')) return jsonResponse({ data: SNAPSHOT });
      return jsonResponse({ data: [] });
    });

    render(<DeviceFilesystemTab deviceId={DEVICE_ID} osType="linux" />);
    await screen.findByTestId('filesystem-analyze-button');

    const keyWarnings = errorSpy.mock.calls.filter((call) => String(call[0]).includes('key'));
    expect(keyWarnings).toEqual([]);
    errorSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/DeviceFilesystemTab.test.tsx
```

Expected failure: `Unable to find an element by: [data-testid="filesystem-error-banner"]` (no testids, no roles), and the runAction cases fail because `showToast` is never called — the bare `fetchWithAuth` calls set local state instead.

- [ ] **Step 3: Implement** — in `apps/web/src/components/devices/DeviceFilesystemTab.tsx`:

Add the imports:

```ts
import { runAction, handleActionError } from "@/lib/runAction";
import { navigateTo } from "@/lib/navigation";
import { loginPathWithNext } from "../../lib/authScope";
```

and, above the component:

```ts
const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

// A stable React key for rows whose `path` is optional on the wire. `key={item.path}`
// collapsed every path-less row onto the key `undefined`, so React reused one
// DOM node for all of them.
function rowKey(item: { path?: string }, index: number): string {
  return item.path && item.path.length > 0 ? item.path : `row-${index}`;
}
```

Add the lifecycle refs inside the component, next to `cleanupPreviewRef`:

```ts
  // The scan poll ran for up to ~6 minutes and survived unmount, so navigating
  // away mid-scan left a fetch loop calling setState on a dead component.
  const pollAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pollAbortRef.current?.abort();
    };
  }, []);
```

Give `fetchSnapshot` and `fetchThresholdEvents` their missing `t` dependency (they already call `t` in their catch paths):

```ts
  }, [deviceId, t]);
```

Replace `pollScanCommand` (`:352-404`) with an abortable form:

```ts
  const pollScanCommand = useCallback(
    async (commandId: string, timeoutMs: number, signal: AbortSignal) => {
      const startedAt = Date.now();
      // Back off between status polls (2s → 10s) rather than hammering a fixed
      // 2s for the whole scan window; a baseline scan can run for minutes.
      let delayMs = 2000;
      const maxDelayMs = 10000;

      while (Date.now() - startedAt < timeoutMs) {
        if (signal.aborted) return;
        const response = await fetchWithAuth(
          `/devices/${deviceId}/commands/${commandId}`,
          { signal },
        );
        if (signal.aborted) return;
        if (!response.ok) {
          const body = await response
            .json()
            .catch(() => ({
              error: t("deviceFilesystemTab.failedToFetchScanStatus"),
            }));
          throw new Error(
            body.error || t("deviceFilesystemTab.failedToFetchScanStatus"),
          );
        }

        const body = await response.json();
        const command = (body.data ?? null) as CommandDetail | null;
        if (!command) {
          throw new Error(t("deviceFilesystemTab.scanCommandNotFound"));
        }

        const status = command.status ?? "pending";
        if (mountedRef.current) setScanCommand({ id: commandId, status });

        if (status === "completed") {
          return;
        }

        if (status === "failed") {
          const result = asRecord(command.result);
          const error =
            typeof result?.error === "string"
              ? result.error
              : t("deviceFilesystemTab.filesystemScanFailed");
          throw new Error(error);
        }

        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        delayMs = Math.min(maxDelayMs, Math.round(delayMs * 1.5));
      }

      if (signal.aborted) return;
      throw new Error(t("deviceFilesystemTab.scanStillRunning"));
    },
    [deviceId, t],
  );
```

Replace `runAnalyze` (`:410-464`):

```ts
  const runAnalyze = useCallback(async () => {
    setActionLoading("scan");
    setError(undefined);
    setScanCommand(null);

    pollAbortRef.current?.abort();
    const controller = new AbortController();
    pollAbortRef.current = controller;

    const timeoutSeconds = 300;
    try {
      const body = await runAction<{ data?: { commandId?: string } }>({
        request: () =>
          fetchWithAuth(`/devices/${deviceId}/filesystem/scan`, {
            method: "POST",
            body: JSON.stringify({
              path: getDefaultScanPath(osType),
              maxDepth: 32,
              topFiles: 50,
              topDirs: 30,
              maxEntries: 10000000,
              workers: 6,
              timeoutSeconds,
            }),
          }),
        errorFallback: t("deviceFilesystemTab.filesystemScanFailed"),
        onUnauthorized: UNAUTHORIZED,
      });

      const commandId =
        typeof body?.data?.commandId === "string" ? body.data.commandId : null;
      if (!commandId) {
        throw new Error(t("deviceFilesystemTab.scanCommandNotQueued"));
      }

      if (mountedRef.current) setScanCommand({ id: commandId, status: "pending" });
      await pollScanCommand(
        commandId,
        Math.max(120_000, (timeoutSeconds + 90) * 1000),
        controller.signal,
      );
      if (controller.signal.aborted || !mountedRef.current) return;
      setCleanupPreview(null);
      await loadAll(true);
      setScanCommand(null);
    } catch (err) {
      if (controller.signal.aborted || !mountedRef.current) return;
      handleActionError(err, t("deviceFilesystemTab.filesystemScanFailed"));
      setError(
        err instanceof Error
          ? err.message
          : t("deviceFilesystemTab.filesystemScanFailed"),
      );
      setScanCommand(null);
    } finally {
      if (mountedRef.current) setActionLoading(null);
    }
  }, [deviceId, loadAll, osType, pollScanCommand, t]);
```

Replace `runCleanupPreview` (`:466-496`):

```ts
  const runCleanupPreview = useCallback(async () => {
    setActionLoading("preview");
    setError(undefined);
    try {
      const body = await runAction<{ data?: FilesystemCleanupPreview | null }>({
        request: () =>
          fetchWithAuth(`/devices/${deviceId}/filesystem/cleanup-preview`, {
            method: "POST",
            body: JSON.stringify({}),
          }),
        errorFallback: t("deviceFilesystemTab.cleanupPreviewFailed"),
        onUnauthorized: UNAUTHORIZED,
      });
      if (!mountedRef.current) return;
      setCleanupPreview((body?.data ?? null) as FilesystemCleanupPreview | null);
    } catch (err) {
      if (!mountedRef.current) return;
      handleActionError(err, t("deviceFilesystemTab.cleanupPreviewFailed"));
      setError(
        err instanceof Error
          ? err.message
          : t("deviceFilesystemTab.cleanupPreviewFailed"),
      );
    } finally {
      if (mountedRef.current) setActionLoading(null);
    }
  }, [deviceId, t]);
```

Add the `t` dependency to `loadAll` as well: `}, [fetchSnapshot, fetchThresholdEvents, t]);`

Give the two banners their roles and testids (`:606-625`):

```tsx
        {error && (
          <div
            role="alert"
            data-testid="filesystem-error-banner"
            className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              <span>{error}</span>
            </div>
          </div>
        )}

        {scanCommand && (
          <div
            role="status"
            data-testid="filesystem-scan-banner"
            className="mt-4 rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-800"
          >
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>
                {t("deviceFilesystemTab.scanRunning")}
                {scanCommand.status})
              </span>
            </div>
          </div>
        )}
```

Add `data-testid` to the two buttons the test drives (`:554-579`): `data-testid="filesystem-analyze-button"` on the Analyze button and `data-testid="filesystem-preview-button"` on the Cleanup Preview button.

Replace the three optional-`path` keys with `rowKey`:

```tsx
                    topLargestFiles.map((item, index) => (
                      <div
                        key={rowKey(item, index)}
```

```tsx
                    topLargestDirectories.map((item, index) => (
                      <div
                        key={rowKey(item, index)}
```

```tsx
                {previewTopCandidates.map((item, index) => (
                  <div
                    key={rowKey(item, index)}
```

Add the three new English strings used above to `apps/web/src/locales/en/devices.json` **and all seven other locales** in this same commit (`keyUsage.test.ts` fails on a key that resolves nowhere):

| key | en | de-DE | es-419 | fr-CA | fr-FR | it-IT | pt-BR | tr-TR |
|---|---|---|---|---|---|---|---|---|
| `scanCommandNotFound` | `Scan command was not found` | `Der Scanbefehl wurde nicht gefunden` | `No se encontró el comando de análisis` | `La commande d’analyse est introuvable` | `La commande d’analyse est introuvable` | `Comando di scansione non trovato` | `Comando de varredura não encontrado` | `Tarama komutu bulunamadı` |
| `scanCommandNotQueued` | `Scan command was not queued` | `Der Scanbefehl wurde nicht eingereiht` | `El comando de análisis no se puso en cola` | `La commande d’analyse n’a pas été mise en file d’attente` | `La commande d’analyse n’a pas été mise en file d’attente` | `Comando di scansione non accodato` | `O comando de varredura não foi enfileirado` | `Tarama komutu sıraya alınmadı` |
| `scanStillRunning` | `Filesystem scan is still running. Click Refresh in a few moments.` | `Der Scan des Dateisystems läuft noch. Klicken Sie in Kürze auf „Aktualisieren“.` | `El análisis del sistema de archivos sigue en curso. Haga clic en Actualizar en unos momentos.` | `Le balayage du système de fichiers est toujours en cours. Cliquez sur Actualiser dans quelques instants.` | `Le balayage du système de fichiers est toujours en cours. Cliquez sur Actualiser dans quelques instants.` | `La scansione del filesystem è ancora in corso. Fai clic su Aggiorna tra qualche istante.` | `A varredura do sistema de arquivos ainda está em execução. Clique em Atualizar em instantes.` | `Dosya sistemi taraması hâlâ çalışıyor. Birkaç dakika sonra Yenile’ye tıklayın.` |

- [ ] **Step 4: Move the file out of the migration backlog** — in `apps/web/src/lib/runActionAllowlist.ts`, delete line 17:

```ts
  'apps/web/src/components/devices/DeviceFilesystemTab.tsx',
```

and in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`, add to `TARGET_GLOBS` next to the other device entries:

```ts
  // Disk Cleanup v2 W01: the tab's scan and cleanup-preview POSTs are the only
  // mutations on the surface that decides what gets deleted from a customer's
  // machine. A silent failure here reads as "the scan did nothing".
  'src/components/devices/DeviceFilesystemTab.tsx',
```

and bump the count assertion (`:693`):

```ts
    // Disk cleanup v2 W01 adds devices/DeviceFilesystemTab.tsx: 146 → 147.
    expect(absoluteFiles.length).toBe(147);
```

- [ ] **Step 5: Run everything this touches**

```bash
cd apps/web && npx vitest run src/components/devices/DeviceFilesystemTab.test.tsx src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/keyUsage.test.ts
```

Expected: all four files green.

- [ ] **Step 6: Typecheck**

```bash
cd apps/web && pnpm exec astro check
```

Expected: `0 errors`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/devices/DeviceFilesystemTab.tsx apps/web/src/components/devices/DeviceFilesystemTab.test.tsx apps/web/src/lib/runActionAllowlist.ts apps/web/src/lib/__tests__/no-silent-mutations.test.ts apps/web/src/locales
git commit -m "$(cat <<'EOF'
fix(web): Disk Cleanup tab — runAction, abortable poll, ARIA roles, stable keys

The scan poll ran for up to six minutes and survived unmount, so navigating away
mid-scan left a fetch loop calling setState on a dead component. Both mutations
were bare fetchWithAuth, so a failure showed a banner below the fold and nothing
else. Neither banner had an ARIA role, three hooks omitted `t` from their deps
(so an untranslated fallback stuck after a locale switch), and rows keyed on an
OPTIONAL path collapsed every path-less row onto the key `undefined`.

DeviceFilesystemTab.tsx leaves RUN_ACTION_MIGRATION_BACKLOG for the guarded set.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §2 defect 9, §8

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Web — remove the ticket label and the `>=` pseudo-key from all 8 locales

**Files:**
- Modify: `apps/web/src/components/devices/DeviceFilesystemTab.tsx` (`:550`, `:641`, `:853`)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/devices.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `deviceFilesystemTab.title` replaces `deviceFilesystemTab.be1DiskCleanupIntelligence`; `deviceFilesystemTab.text` is deleted; `deviceFilesystemTab.noFilesystemSnapshotYetRunAnalyze` loses its `BE-1` reference.

- [ ] **Step 1: Write the failing test** — append to `apps/web/src/components/devices/DeviceFilesystemTab.test.tsx`:

```tsx
  it('shows a product heading, not an internal ticket id', async () => {
    routeFetch((url) => {
      if (url.includes('/filesystem')) return jsonResponse({ data: SNAPSHOT });
      return jsonResponse({ data: [] });
    });

    render(<DeviceFilesystemTab deviceId={DEVICE_ID} osType="linux" />);
    // "BE-1" is the internal tracking id of the original epic. It shipped to
    // customers in the tab heading and in the empty state.
    const heading = await screen.findByTestId('filesystem-heading');
    expect(heading.textContent).toBe('Disk Cleanup');
    expect(document.body.textContent).not.toContain('BE-1');
  });
```

and create `apps/web/src/locales/deviceFilesystemTabKeys.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = dirname(fileURLToPath(import.meta.url));

function tabSection(locale: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(localesDir, locale, 'devices.json'), 'utf8')) as Record<string, unknown>;
  return (raw.deviceFilesystemTab ?? {}) as Record<string, unknown>;
}

const locales = readdirSync(localesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe('deviceFilesystemTab locale hygiene', () => {
  it('covers all eight locales', () => {
    expect(locales.length).toBe(8);
  });

  for (const locale of locales) {
    it(`${locale} carries no internal ticket id and no punctuation-only key`, () => {
      const section = tabSection(locale);
      // The tab heading shipped as "BE-1: Disk Cleanup Intelligence" and the
      // empty state as "...to collect BE-1 data" in every locale.
      expect(section).not.toHaveProperty('be1DiskCleanupIntelligence');
      // `text: ">="` is not a translatable string; it is an operator rendered
      // through the translation layer, which every translator then had to copy.
      expect(section).not.toHaveProperty('text');
      expect(section).toHaveProperty('title');
      for (const [key, value] of Object.entries(section)) {
        if (typeof value !== 'string') continue;
        expect(`${locale}.${key}: ${value}`).not.toContain('BE-1');
      }
    });
  }
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/web && npx vitest run src/locales/deviceFilesystemTabKeys.test.ts src/components/devices/DeviceFilesystemTab.test.tsx
```

Expected failure: every locale case fails on `expected { … } not to have property "be1DiskCleanupIntelligence"`, and the component case fails on `Unable to find an element by: [data-testid="filesystem-heading"]`.

- [ ] **Step 3: Implement the locale edits** — in each of the eight `devices.json` files, inside `deviceFilesystemTab`: **delete** `be1DiskCleanupIntelligence` and `text`, **add** `title`, and **rewrite** `noFilesystemSnapshotYetRunAnalyze`:

| locale | `title` | `noFilesystemSnapshotYetRunAnalyze` |
|---|---|---|
| en | `Disk Cleanup` | `No filesystem snapshot yet. Run Analyze Now to collect disk usage data.` |
| de-DE | `Datenträgerbereinigung` | `Noch kein Dateisystem-Snapshot. Führen Sie „Jetzt analysieren“ aus, um Daten zur Datenträgernutzung zu sammeln.` |
| es-419 | `Limpieza de disco` | `Aún no hay una instantánea del sistema de archivos. Ejecute Analizar ahora para recopilar datos de uso del disco.` |
| fr-CA | `Nettoyage de disque` | `Pas encore d’instantané du système de fichiers. Exécutez Analysez maintenant pour collecter les données d’utilisation du disque.` |
| fr-FR | `Nettoyage de disque` | `Pas encore d’instantané du système de fichiers. Exécutez Analysez maintenant pour collecter les données d’utilisation du disque.` |
| it-IT | `Pulizia del disco` | `Nessuno snapshot del filesystem disponibile. Esegui Analizza ora per raccogliere i dati di utilizzo del disco.` |
| pt-BR | `Limpeza de disco` | `Ainda não há um snapshot do sistema de arquivos. Execute Analisar agora para coletar dados de uso do disco.` |
| tr-TR | `Disk Temizleme` | `Henüz dosya sistemi anlık görüntüsü yok. Disk kullanım verilerini toplamak için Şimdi Analiz Et’i çalıştırın.` |

(The fr-CA/fr-FR empty state previously read "Exécutez Analyze Now", leaving the button label untranslated inside a French sentence; it now matches the `analyzeNow` value in each catalogue.)

- [ ] **Step 4: Implement the component edits** — in `apps/web/src/components/devices/DeviceFilesystemTab.tsx`:

```tsx
            <h3 className="text-lg font-semibold" data-testid="filesystem-heading">
              {t("deviceFilesystemTab.title")}
            </h3>
```

and, at the estimated-size marker (`:853`), use the same literal the legend two blocks above already uses (`:834`) instead of routing an operator through i18n:

```tsx
                        <span className="shrink-0 whitespace-nowrap text-right font-medium tabular-nums">
                          {item.estimated ? ">= " : ""}
                          {formatBytes(item.sizeBytes)}
                        </span>
```

- [ ] **Step 5: Run them and watch them pass**

```bash
cd apps/web && npx vitest run src/locales/deviceFilesystemTabKeys.test.ts src/components/devices/DeviceFilesystemTab.test.tsx src/lib/i18n/keyUsage.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/extractionQuality.test.ts
```

Expected: all six files green. `keyUsage.test.ts` is the one that proves no `t()` call still points at a deleted key.

- [ ] **Step 6: Confirm nothing else referenced the removed keys**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-green-meadow-232b && grep -rn "be1DiskCleanupIntelligence\|deviceFilesystemTab.text\|BE-1" apps/web/src e2e-tests 2>/dev/null
```

Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/devices/DeviceFilesystemTab.tsx apps/web/src/components/devices/DeviceFilesystemTab.test.tsx apps/web/src/locales
git commit -m "$(cat <<'EOF'
fix(web): drop the BE-1 ticket label and the ">=" pseudo-key from the tab

The Disk Cleanup tab's heading shipped to customers as "BE-1: Disk Cleanup
Intelligence" and its empty state as "...to collect BE-1 data", in all eight
locales. `deviceFilesystemTab.text` held the string ">=", an operator routed
through the translation layer that every translator then copied verbatim.

The heading becomes "Disk Cleanup", the empty state names disk usage, and the
marker uses the same literal the legend two blocks above already uses. A locale
test pins all three so the ticket id cannot come back.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §2 defect 9, §8

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Web — File Manager pins the cleanup run and renders partial failure in amber (defect 4)

**Files:**
- Modify: `apps/web/src/components/remote/FileManager.tsx` — `DiskCleanupResult` type (`:129-135`), `handleConfirmCleanup` (`:1001-1031`), the result panel (`:1382-1386`)
- Create: `apps/web/src/components/remote/FileManager.cleanup.test.tsx` (Test)
- Modify: `apps/web/src/locales/*/remote.json` (8 files)

**Interfaces:**
- Consumes: the W01 execute response (`rejectedPaths`, `partial`, `counts` incl. the new `partial` count, per-action `status`). A `409 agent_update_required` surfaces through the existing `onError` path here; the dedicated update banner is W03/W04's `SystemCleanupPanel` work (spec §8).
- Produces: `DiskCleanupResult` gains `rejectedPaths`, `partial` and `counts`; the execute body carries `cleanupRunId`.

- [ ] **Step 1: Write the failing test** — create `apps/web/src/components/remote/FileManager.cleanup.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import FileManager from './FileManager';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const DEVICE_ID = '11111111-1111-1111-1111-111111111111';

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const PREVIEW = {
  cleanupRunId: 'run-42',
  snapshotId: 'snap-1',
  estimatedBytes: 4096,
  candidateCount: 1,
  categories: [{ category: 'temp_files', count: 1, estimatedBytes: 4096 }],
  candidates: [{ path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096 }],
};

function routeFetch(executeBody: unknown, executeOk = true) {
  fetchWithAuthMock.mockImplementation((async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && String(url).includes('/filesystem/cleanup-preview')) {
      return jsonResponse({ success: true, data: PREVIEW });
    }
    if (init?.method === 'POST' && String(url).includes('/filesystem/cleanup-execute')) {
      return jsonResponse(executeBody, executeOk, executeOk ? 200 : 500);
    }
    if (String(url).includes('/filesystem')) return jsonResponse({ success: true, data: null }, false, 404);
    return jsonResponse({ data: [] });
  }) as typeof fetchWithAuth);
}

async function previewThenExecute() {
  fireEvent.click(await screen.findByTestId('disk-preview-button'));
  fireEvent.click(await screen.findByTestId('disk-execute-button'));
  fireEvent.click(await screen.findByTestId('disk-execute-confirm'));
}

describe('FileManager disk cleanup', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the pinned cleanupRunId with the execute body', async () => {
    routeFetch({
      success: true,
      data: { cleanupRunId: 'run-43', status: 'executed', bytesReclaimed: 4096, selectedCount: 1, failedCount: 0, partial: false, rejectedPaths: [], counts: { completed: 1, failed: 0, skipped_locked: 0, rejected: 0, skipped_budget: 0 } },
    });

    render(<FileManager deviceId={DEVICE_ID} />);
    await previewThenExecute();

    await waitFor(() => {
      const call = fetchWithAuthMock.mock.calls.find(([url]) => String(url).includes('cleanup-execute'));
      expect(call).toBeDefined();
      // Without this, execute re-derived candidates from whatever snapshot was
      // newest — the exact race the API's pinning exists to prevent (defect 4).
      expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({
        paths: ['/tmp/a.tmp'],
        cleanupRunId: 'run-42',
      });
    });
  });

  it('renders a partial failure in amber, not in a green box', async () => {
    routeFetch({
      success: true,
      data: {
        cleanupRunId: 'run-44', status: 'executed', bytesReclaimed: 0,
        selectedCount: 1, failedCount: 1, partial: false,
        rejectedPaths: ['/home/bob/taxes.pdf'],
        counts: { completed: 0, failed: 1, skipped_locked: 0, rejected: 1, skipped_budget: 0 },
      },
    });

    render(<FileManager deviceId={DEVICE_ID} />);
    await previewThenExecute();

    const panel = await screen.findByTestId('disk-cleanup-result');
    expect(panel.className).toContain('amber');
    expect(panel.className).not.toContain('emerald');
    expect(panel.textContent).toContain('1');
  });

  it('keeps the success box green when nothing failed', async () => {
    routeFetch({
      success: true,
      data: {
        cleanupRunId: 'run-45', status: 'executed', bytesReclaimed: 4096,
        selectedCount: 1, failedCount: 0, partial: false, rejectedPaths: [],
        counts: { completed: 1, failed: 0, skipped_locked: 0, rejected: 0, skipped_budget: 0 },
      },
    });

    render(<FileManager deviceId={DEVICE_ID} />);
    await previewThenExecute();

    const panel = await screen.findByTestId('disk-cleanup-result');
    expect(panel.className).toContain('emerald');
  });
});
```

Add the three `data-testid` attributes the test drives — `disk-preview-button`, `disk-execute-button`, `disk-execute-confirm` — to the existing Preview Cleanup button, the Execute button and the confirm dialog's confirm control in `FileManager.tsx`. (Find them with `grep -n "fileManager.disk.previewCleanup\|fileManager.disk.execute\|showCleanupConfirm" apps/web/src/components/remote/FileManager.tsx`.)

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/remote/FileManager.cleanup.test.tsx
```

Expected failure: `Unable to find an element by: [data-testid="disk-preview-button"]`, then — once the testids are added — the first case fails with the body `{"paths":["/tmp/a.tmp"]}` (no `cleanupRunId`) and the amber case fails because the panel's class list contains `emerald`.

- [ ] **Step 3: Implement** — in `apps/web/src/components/remote/FileManager.tsx`, extend the result type (`:129-135`):

```ts
type DiskCleanupResult = {
  cleanupRunId: string | null;
  status: 'executed' | 'failed';
  bytesReclaimed: number;
  selectedCount: number;
  failedCount: number;
  partial?: boolean;
  rejectedPaths?: string[];
  counts?: {
    completed: number;
    // §13 row 13: a contentsOnly delete that could not remove every child.
    partial?: number;
    failed: number;
    skipped_locked: number;
    rejected: number;
    skipped_budget: number;
  };
};
```

pin the run in `handleConfirmCleanup` (`:1009-1012`):

```ts
      const response = await fetchWithAuth(`/devices/${deviceId}/filesystem/cleanup-execute`, {
        method: 'POST',
        // Pin the deletion to the run the user actually previewed. Without it
        // the API re-derives candidates from whatever snapshot is now newest,
        // which is the race the pinning exists to prevent (defect 4).
        body: JSON.stringify(
          cleanupPreview?.cleanupRunId
            ? { paths, cleanupRunId: cleanupPreview.cleanupRunId }
            : { paths },
        )
      });
```

and add `cleanupPreview` to that callback's dependency array (`:1031`):

```ts
  }, [cleanupPreview, currentPath, deviceId, fetchDirectory, loadLatestFilesystemSnapshot, onError, selectedCleanupPaths]);
```

Replace the result panel (`:1382-1386`):

```tsx
            {cleanupResult && (() => {
              const rejectedCount = cleanupResult.rejectedPaths?.length ?? cleanupResult.counts?.rejected ?? 0;
              const skippedLockedCount = cleanupResult.counts?.skipped_locked ?? 0;
              const skippedBudgetCount = cleanupResult.counts?.skipped_budget ?? 0;
              const partialCount = cleanupResult.counts?.partial ?? 0;
              // A partial failure used to render in the SAME green box as a
              // clean run, so "3 of 40 targets failed" read as success.
              const clean =
                cleanupResult.failedCount === 0 &&
                rejectedCount === 0 &&
                skippedLockedCount === 0 &&
                skippedBudgetCount === 0 &&
                partialCount === 0;
              return (
                <div
                  data-testid="disk-cleanup-result"
                  className={cn(
                    'mt-2 rounded-md border px-3 py-2 text-xs',
                    clean
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                      : 'border-amber-300 bg-amber-50 text-amber-800'
                  )}
                >
                  <div>
                    {t('fileManager.disk.cleanupResult', {
                      status: cleanupResult.status,
                      size: formatSize(cleanupResult.bytesReclaimed),
                      count: cleanupResult.selectedCount,
                      failed: cleanupResult.failedCount,
                    })}
                  </div>
                  {!clean && (
                    <div className="mt-1">
                      {t('fileManager.disk.cleanupOutcomeBreakdown', {
                        failed: cleanupResult.failedCount,
                        rejected: rejectedCount,
                        locked: skippedLockedCount,
                        skipped: skippedBudgetCount,
                      })}
                    </div>
                  )}
                  {cleanupResult.partial && (
                    <div className="mt-1">{t('fileManager.disk.cleanupBudgetExhausted')}</div>
                  )}
                </div>
              );
            })()}
```

Add the two new keys to `fileManager.disk` in all eight `apps/web/src/locales/*/remote.json`:

| key | en | de-DE | es-419 | fr-CA | fr-FR | it-IT | pt-BR | tr-TR |
|---|---|---|---|---|---|---|---|---|
| `cleanupOutcomeBreakdown` | `{{failed}} failed · {{rejected}} rejected · {{locked}} locked · {{skipped}} not reached` | `{{failed}} fehlgeschlagen · {{rejected}} abgelehnt · {{locked}} gesperrt · {{skipped}} nicht erreicht` | `{{failed}} con errores · {{rejected}} rechazados · {{locked}} bloqueados · {{skipped}} sin alcanzar` | `{{failed}} en échec · {{rejected}} refusés · {{locked}} verrouillés · {{skipped}} non traités` | `{{failed}} en échec · {{rejected}} refusés · {{locked}} verrouillés · {{skipped}} non traités` | `{{failed}} non riusciti · {{rejected}} rifiutati · {{locked}} bloccati · {{skipped}} non raggiunti` | `{{failed}} com falha · {{rejected}} rejeitados · {{locked}} bloqueados · {{skipped}} não alcançados` | `{{failed}} başarısız · {{rejected}} reddedildi · {{locked}} kilitli · {{skipped}} ulaşılamadı` |
| `cleanupBudgetExhausted` | `The time budget ran out before every target was reached. Run the cleanup again to continue.` | `Das Zeitbudget war aufgebraucht, bevor alle Ziele erreicht wurden. Führen Sie die Bereinigung erneut aus.` | `El tiempo disponible se agotó antes de alcanzar todos los objetivos. Ejecute la limpieza nuevamente para continuar.` | `Le temps alloué s’est épuisé avant que toutes les cibles soient traitées. Relancez le nettoyage pour continuer.` | `Le temps alloué s’est épuisé avant que toutes les cibles soient traitées. Relancez le nettoyage pour continuer.` | `Il tempo a disposizione è terminato prima di raggiungere tutti gli elementi. Esegui di nuovo la pulizia per continuare.` | `O tempo disponível acabou antes de alcançar todos os alvos. Execute a limpeza novamente para continuar.` | `Tüm hedeflere ulaşılmadan süre doldu. Devam etmek için temizlemeyi yeniden çalıştırın.` |

Confirm `cn` is already imported in `FileManager.tsx` (it is — `grep -n "from '@/lib/utils'\|cn(" apps/web/src/components/remote/FileManager.tsx`); add the import if the grep shows otherwise.

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/web && npx vitest run src/components/remote/FileManager.cleanup.test.tsx src/lib/i18n/localeParity.test.ts src/lib/i18n/keyUsage.test.ts
```

Expected: three files green.

- [ ] **Step 5: Typecheck and commit**

```bash
cd apps/web && pnpm exec astro check
git add apps/web/src/components/remote/FileManager.tsx apps/web/src/components/remote/FileManager.cleanup.test.tsx apps/web/src/locales
git commit -m "$(cat <<'EOF'
fix(web): File Manager pins the cleanup run and stops calling failure success

The File Manager's execute omitted cleanupRunId, so the API re-derived
candidates from whatever snapshot was newest — the race its pinning exists to
prevent. And any partial failure rendered in the SAME green box as a clean run,
so "3 of 40 targets failed" read as success.

The execute body now carries the previewed run id, and the result panel turns
amber with a per-outcome breakdown whenever anything failed, was rejected, was
locked, or was not reached inside the execute budget.

The File Manager's disk-cleanup section is removed entirely in W03 (one concept,
one home); until then it must not lie about what happened.

Spec: docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md §2 defect 4, §8

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Full verification and the PR

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Merge `main` in first.** A locally green branch is not CI green; PR CI runs the BRANCH's `ci.yml` against a merged tree.

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-green-meadow-232b && git fetch origin main && git merge --no-edit origin/main
```

- [ ] **Step 2: Run the full agent suite with the race detector**

```bash
cd agent && gofmt -l internal/ && go vet ./... && go test -race ./...
```

Expected: `gofmt -l` prints nothing for anything this wave touched, `go vet` is silent, every package `ok`.

- [ ] **Step 3: Run the full API and shared unit suites**

```bash
cd apps/api && npx vitest run
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-green-meadow-232b/packages/shared && npx vitest run
```

Expected: both green. Pay attention to `apps/api/src/db/autoMigrate.test.ts` and `apps/api/src/config/composeBindMounts.test.ts` — this wave adds no migration and no compose mount, so a failure there means something unrelated crept in.

- [ ] **Step 4: Run the full web suite**

```bash
cd apps/web && npx vitest run
```

Expected: green, including `no-silent-mutations.test.ts` (count 147), `localeParity.test.ts`, `keyUsage.test.ts`, `translationCoverage.test.ts` and `extractionQuality.test.ts`.

- [ ] **Step 5: Typecheck everything CI typechecks**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-green-meadow-232b && pnpm exec tsc --noEmit --project apps/api/tsconfig.json && pnpm --filter @breeze/shared typecheck && (cd apps/web && pnpm exec astro check)
```

Expected: all three clean.

- [ ] **Step 6: Prove the rule table has not drifted in either direction**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-green-meadow-232b && cmp packages/shared/src/utils/cleanupRules.json agent/internal/remote/tools/cleanup_rules.json && echo "RULE TABLE IN SYNC"
```

Expected: `RULE TABLE IN SYNC`.

- [ ] **Step 6b: Confirm the §13 safety contracts are actually wired**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-green-meadow-232b && \
  grep -q "os.OpenRoot" agent/internal/remote/tools/fileops.go && echo "OK handle-based delete" && \
  grep -q "filesystem_analysis: handleFilesystemAnalysisResult" apps/api/src/services/commandResultHandlers.ts && echo "OK ws persistence" && \
  ! grep -q "'filesystem_analysis'," apps/api/src/routes/agents/commands.ts && echo "OK no double-save" && \
  grep -q "MIN_AGENT_VERSION_CLEANUP_GUARD" apps/api/src/services/filesystemCleanupExecution.ts && echo "OK version gate"
```

Expected: four `OK` lines. The third is the one that is easy to get wrong — `filesystem_analysis` must NOT appear in `REGISTRY_DISPATCHED_COMMAND_TYPES`.

- [ ] **Step 7: Confirm this wave really added no schema surface**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-green-meadow-232b && git diff --name-only origin/main...HEAD | grep -E '^apps/api/(migrations|src/db/schema)/' || echo "NO SCHEMA CHANGES (expected for W01)"
```

Expected: `NO SCHEMA CHANGES (expected for W01)`. If any path prints, the cascade/export-policy registration rules in CLAUDE.md apply and this is no longer a W01 change.

- [ ] **Step 8: Open the PR**

```bash
git push -u origin HEAD
gh pr create --base main --title "Disk Cleanup v2 W01: correctness and hardening" --body "$(cat <<'EOF'
## What

Wave 1 of Disk Cleanup v2 (spec `docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md`). No schema change; ships with an agent release.

Disk cleanup did not free disk space. `cleanup-execute` dispatched `file_delete` without `permanent`, so the agent MOVED every "deleted" file to `~/.breeze-trash` on the same volume for 30 days — and across volumes fell back to copy+remove, so cleaning `D:\` grew `C:\`. `bytesReclaimed` summed snapshot sizes regardless. Separately, the classifier was a floating substring match, so Chrome `Bookmarks`/`History`/`Cookies`, Firefox `places.sqlite`, UWP `LocalState` and `/System/Library/Caches` were all "safe" cleanup candidates.

## Changes

- **Rooted rule table** (`packages/shared/src/utils/cleanupRules.json`) replaces the substring classifier, matched on path components by a tiny matcher implemented twice (Go + TS) against one shared fixture table. The agent embeds a byte-identical copy; a test on each side fails on drift. `Safe` is computed, never hardcoded.
- **Recycle bins per volume, per SID.** `getTrashPaths(scanRoot)` enumerates `<root>\$Recycle.Bin\S-*` instead of the literal `C:\$Recycle.Bin` (which is depth 1, so the boundary guard refused it — Windows bin reclaim was dead on arrival).
- **`file_delete` hardening.** `cleanupGuard` lstats, refuses symlinks, Windows reparse points, cleanup-denied roots and anything the rule table does not claim. `contentsOnly` empties a bin without removing it, skips link children, preserves `desktop.ini`, and never follows a link at any depth. Results carry `bytesFreed` and `skippedLocked`; locked files are never forced.
- **API.** Execute dispatches `permanent`/`cleanupGuard`/`contentsOnly`, re-filters every candidate through the rule table, reports `rejectedPaths` and a real per-path status (`completed | failed | skipped_locked | rejected | skipped_budget`), and is bounded by `CLEANUP_EXECUTE_BUDGET_MS = 240_000`. Every response is `{ success, data }` / `{ success: false, error, data? }`.
- **Accumulators.** Duplicate map capped at 50k keys with `summary.duplicateTrackingTruncated`; cleanup candidates kept top-by-size in a min-heap; permission denials counted.
- **AI lane.** `analyze_disk_usage` no longer stores an empty snapshot on unparseable stdout, and `disk_cleanup action=execute` now runs the *same* `runCleanupExecution` the route does — defect 1 had two call sites and both are closed. The tool's input schema is unchanged.
- **Codex quorum (spec §13), W01 rows.** Deletion is **handle-based**: the agent opens the matched rule's anchor with `os.OpenRoot` and works relative to it, so an ancestor swapped for a symlink or a Windows junction between preview and execute is refused by the runtime, not followed (row 1). Identity, type, age and freshness are re-checked at execute — file rules dispatch `recursive: false`, the agent requires a regular file, min-age is re-evaluated, and a target modified after `previewedAt` is rejected (row 2). Permanent mode is gated on `MIN_AGENT_VERSION_CLEANUP_GUARD`; older agents get `409 agent_update_required` and are never dispatched to (row 3). `file_delete` is confirmed live-only and pinned by a contract test (row 6). `filesystem_analysis` results delivered over WebSocket are now persisted — they never were (row 9). Path normalisation is per OS (row 10). POSIX trash is scoped to the scanned root (row 11). A `contentsOnly` delete with any failed child is `partial`, never `completed` (row 13).
- **Web.** The Disk Cleanup tab adopts `runAction` (and leaves `runActionAllowlist.ts`), its poll is abortable, both banners carry ARIA roles, rows use stable keys, and the `BE-1:` ticket label and the `>=` pseudo-key are gone from all 8 locales. File Manager pins `cleanupRunId` and renders partial failure in amber.

## Breaking / operational note

`cleanup-execute` now answers **409 `agent_update_required`** to any device below `MIN_AGENT_VERSION_CLEANUP_GUARD` (`0.115.0`, the release these agent changes ship in). That is deliberate: an agent that ignores `cleanupGuard` while honouring `permanent` performs an *unguarded* recursive permanent delete. Disk cleanup is unavailable on a device until its agent is updated. **If this wave lands in a different release, bump the constant and its test in the same PR.**

## Known gaps (by design)

- The AI `disk_cleanup` tool's **input schema** is unchanged (no `path`, no `cleanupRunId`, no 200-path cap) and the run-level AI audit is not added; spec §9 assigns that schema work to W05. Its **execution path** is fixed here.
- Multi-volume scan state, the finished tab, and OS-native cleaners are W02–W04.
- From spec §13: `CLEANUP_PREVIEW_TTL_HOURS` and the confirm-dialog copy (row 2) and self-managed DB context for the execute route (row 5) are W03; `scan_path`/backfill/`scan_generation` (rows 7, 8, 18) are W02; the native-cleaner rows (4, 12, 14, 15) are W04.

## Mixed-version behaviour (new API, old agent)

**There is none, by design.** Spec §13 row 3 withdrew the original "cosmetic degradation" story: an agent that ignores `cleanupGuard` while honouring `permanent` performs an *unguarded* recursive permanent delete, which is worse than the trash-move it replaces. Both lanes refuse any agent below `MIN_AGENT_VERSION_CLEANUP_GUARD` with `409 agent_update_required` before anything is dispatched. Scanning, previewing and every other `file_delete` caller are unaffected.

## Testing

`go test -race ./...`, `apps/api` + `apps/web` + `packages/shared` unit suites, `tsc --noEmit` on api and shared, `astro check` on web. No migration, no cascade-list or export-policy change, so no RLS/integration contract suite applies.

Safety-specific: an ancestor-symlink fixture asserts the target outside the tree survives and the delete is `rejected`; the Windows junction equivalent runs on the Windows agent runner; the version gate has a fail-closed case for an absent/unparseable `agent_version`; a contract test pins `file_delete` to the `live` offline class.

Closes #<subissue#>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 9: Record the wave.** Run `complete_wave` on the sub-issue once the PR is open and reviewed. Do **not** merge from this plan — the merge queue owns that.

---

## Self-review

### Spec coverage

| Spec requirement (W01 scope) | Task |
|---|---|
| §2 defect 1 — execute dispatches no `permanent`, files are trash-moved, zero bytes freed (**both call sites**: the route and the AI tool) | 8, 10 (route), 11b (AI lane) |
| §2 defect 2 — only trash path on Windows is `C:\$Recycle.Bin`, depth 1, unreachable | 2 (`<vol>` anchor), 4 (`getTrashPaths(scanRoot)` + SID enumeration), 6 (boundary cases) |
| §2 defect 3 — `Safe: true` hardcoded; substring-on-profile-root classifier; no age threshold | 1 (rule data + TS matcher), 2 (Go matcher), 3 (scanner wiring, computed `Safe`), 4 (computed `Safe` on the trash branch) |
| §2 defect 5 — AI lane stores an empty snapshot | 11 |
| §2 defect 7 — unbounded duplicate map; insertion-ordered candidate cap | 5 |
| §2 defect 9 — poll survives unmount, bare `fetchWithAuth`, missing `t` deps, no `role=alert`, `BE-1:` label, no tests | 12, 13 |
| §2 defect 10 (execute side) — non-candidates dropped silently; no wall-clock cap; response shapes drift | 8 (`rejectedPaths`), 9 (budget), 10 (unified shape) |
| §3 W01 row — no schema; agent release; mixed-version behaviour | Global Constraints; Task 15 Step 7 proves no schema surface; PR body states the mixed-version story |
| §5.2 — execute payload `permanent`/`cleanupGuard`/`contentsOnly` | 8 (`buildFileDeletePayload`), 10 (wiring) |
| §5.2 — `rejectedPaths` | 8, 10 |
| §5.2 — per-path status vocabulary | 8 (`mapFileDeleteStatus`), 9 (`skipped_budget`), 10 (response) |
| §5.2 — `CLEANUP_EXECUTE_BUDGET_MS`, `partial` in `executedActions` | 9, 10 |
| §5.2 — unified response shape | 10 |
| §5.2 note — `cleanupRunId` stays OPTIONAL in W01, but FileManager sends it | 14 (FileManager sends it); the route schema is untouched at `filesystem.ts:53` |
| §6.1 — shared rule JSON, Go `go:embed` matcher, TS matcher, shared fixtures, parity tests | 1, 2 (amendment 1: two copies, byte-parity in both directions) |
| §6.1 — grammar (`*`, `**`, `{a,b}`, rooted on components, `<vol>` on Windows) | 1, 2 (amendments 2, 3, 4) |
| §6.1 — cleanup-denied roots | 1, 2 (amendment 5), 6 (enforced by `cleanupGuard`), 8 (enforced by the API re-filter) |
| §6.2 — trash per volume, `getTrashPaths(scanRoot)` | 4 |
| §6.3 — `permanent`, `cleanupGuard` (Lstat, symlink/reparse refusal, rule + denied-root re-check) | 6 |
| §6.3 — `contentsOnly` (never follows links, preserves `desktop.ini`, directory survives, depth check on the directory) | 7 |
| §6.3 — result gains `bytesFreed` and `skippedLocked` | 6, 7 |
| §6.4 — bounded duplicate map, top-by-size candidates, permission counting, `getTrashPaths` errors | 4 (errors), 5 (the rest) |
| §6.4 — unit tests for the classifier, `isOldDownload`, `isUnrotatedLog`, `getTrashPaths(root)`, checkpoint resume, `maxEntries`/timeout, `collapseAncestorDirectories` ratio, JSON round-trip | 3, 4, 5 |
| §8 W01 — poll AbortController | 12 |
| §8 W01 — `runAction` adoption + allowlist removal | 12 |
| §8 W01 — partial-failure amber rendering in FileManager | 14 |
| §8 W01 — FileManager sends `cleanupRunId` | 14 |
| §8 W01 — `t` in hook deps | 12 |
| §8 W01 — `role=alert` / `role=status` | 12 |
| §8 W01 — remove `be1DiskCleanupIntelligence` and the `>=` key from all 8 locales | 13 |
| §8 W01 — stable `key=` props | 12 |
| §9 (W01 slice only) — AI-lane empty-snapshot guard | 11 |
| §9 (W01 slice only) — AI-lane execute runs the shared cleanup path; input schema untouched | 11b |
| §10.1 nothing deleted that was not previewed | 8 (plan pinning kept), 14 (FileManager pins) |
| §10.2 rules enforced twice | 8 (API), 6 (agent `cleanupGuard`) |
| §10.3 permanent by construction | 8 |
| §10.4 no symlink following | 6, 7 |
| §10.5 never force locked files | 6, 7, 8 |
| §10.6 boundary guard unchanged; bin contents reached one level down | 6 (boundary cases), 7 (`contentsOnly` honours the boundary) |
| §10.9 audited (execute carries action ids, per-item status, bytes) | 10 |
| §11 Go — rule positives/negatives, min-age, per-volume bin fixture, `contentsOnly` symlink, `cleanupGuard` symlink, top-by-size, duplicate cap, checkpoint JSON round-trip, `$Recycle.Bin` boundary | 1–7 |
| §11 API — `rejectedPaths`, budget cut-off, response shape | 8, 9, 10 |
| §11 Web — partial failure renders amber, `no-silent-mutations` passes with the tab removed from the allowlist | 12, 14 |
| **§13 row 1** — delete through `os.OpenRoot` handles, anchor on the scanned volume, ancestor-symlink and Windows-junction tests | 2 (anchor), 6 (handle open + tests), 7 (`contentsOnly` traversal) |
| **§13 row 2 (W01 half)** — `recursive` from granularity, regular-file requirement, min-age re-check, `previewedAt` freshness | 6 (agent checks), 8 (payload), 10 (route plumbing), 11b (AI lane). TTL + confirm copy → W03 (amendment 18) |
| **§13 row 3** — `MIN_AGENT_VERSION_CLEANUP_GUARD`, 409 on older agents, mixed-version narrative withdrawn | 8 (gate helper), 10 (route 409), 11b (AI lane), Global Constraints |
| **§13 row 6** — destructive cleanup is live-only | 8 (contract test pinning `file_delete` → `live`; amendment 20 records that it already is) |
| **§13 row 9** — `filesystem_analysis` results over WebSocket are persisted | 10b |
| **§13 row 10** — per-OS normalisation (windows folds both, darwin case only, linux exact) | 1 (TS + fixtures), 2 (Go) |
| **§13 row 11** — POSIX trash scoped to the scanned root | 4 |
| **§13 row 13 (W01 half)** — a `contentsOnly` action with any failed child is `partial`, `failedChildren` kept | 7 (agent reports), 8 (status mapping), 10 / 11b (counts + response) |
| **§13 closing note** — `bytesFreed` is the agent's `Lstat` sum, labelled logical bytes | 6, 8 |

Also out of W01, from §13 and stated where a reader would look: `CLEANUP_PREVIEW_TTL_HOURS` and the confirm-dialog "current contents at execution" copy (row 2 → W03, amendment 18); self-managed DB context for `cleanup-execute` (row 5 → W03); every `scan_path`, backfill and `scan_generation` item (rows 7, 8, 18 → W02); run cancellation/late-result reconciliation beyond the W01 half (row 13 → W03); and every native-cleaner row (4, 12, 14, 15 → W04). Out of W01 by design, and stated in the plan where a reader would look for them: the AI `disk_cleanup` tool's INPUT SCHEMA — `path`, a required `cleanupRunId`, the 200-path cap and the run-level audit (amendment 14, §9 → W05; its execute PATH is fixed here in Task 11b), `cleanupRunId` becoming required (§5.2 note → W03), the `scanRunning` interpolated-key rebuild and the tab component split (§8 → W03), the disk-percent delta fix (§2 defect 8 → W02), scan-state keying and `scan_path` (§2 defect 6 → W02), and removing the File Manager's cleanup section entirely (§8 → W03).

### Placeholder scan

```bash
grep -nE 'TODO|TBD|FIXME|\.\.\.|similar to Task|handle edge cases|as (above|before)' docs/superpowers/plans/devices/2026-09-19-disk-cleanup-v2-w01-correctness-hardening.md
```

Run this before executing the plan. Expected hits and why each is legitimate:
- `<parent#>` / `<subissue#>` in the Branch line, the PR body and the commit steps — the one placeholder class the plan contract allows, assigned at feature registration.
- `LanternOps/breeze#6326` in the frontmatter — the registered feature (waves #6327–#6331); the `<parent#>`/`<subissue#>` branch placeholders resolve to `feature/6326-disk-cleanup-v2/wave-6327`.
- Ellipses inside prose sentences and inside quoted spec text.

No task step defers work to a later reader: every implementation step carries the code it installs, and the two places where a task deliberately lands a temporary stub (`deleteDirectoryContents` in Task 6, the `cleanupSet`/`estimateDirectorySize` call shapes in Task 4) say explicitly which later task removes it and why the intermediate state still compiles.

### Type-consistency check

- `CleanupCategory` / `CleanupGranularity` / `CleanupOs` are declared once in `packages/shared/src/utils/cleanupRules.ts` and consumed by `filesystemCleanupExecution.ts` and the route. The Go side mirrors them as plain `string` fields on `cleanupRuleSpec`, matched against the same JSON — no enum duplication to drift.
- `FilesystemCleanupCandidate` keeps its existing shape on both sides (`tools/types.go:583-590`, `services/filesystemAnalysis.ts:13-20`). W01 adds **no** field to it: `contentsOnly` is derived from the rule match (amendment 6), so an old agent's snapshot still yields the right flag.
- `CleanupActionStatus` is the single source for the per-path vocabulary — now **six** members (`completed`, `partial`, `failed`, `skipped_locked`, `rejected`, `skipped_budget`). The route's and the AI lane's `counts` objects are keyed by exactly those six, and the FileManager's `DiskCleanupResult.counts` is typed with all six optional so a W01 API and a pre-W01 cached bundle both render.
- `CleanupGranularity` now reaches the wire twice over: it sets `contentsOnly` AND `recursive` in `buildFileDeletePayload`, so the two can never disagree.
- `agentSupportsCleanupGuard` returns `boolean`, never a comparison result, so the fail-closed branch cannot be lost to a sign flip at a call site.
- `FileDeleteDispatchResult` is structurally a subset of `commandQueue.CommandResult` (`status`, `stdout`, `error`), so the route can pass `executeCommand`'s result straight through without a cast; `CommandResult.status` is `'completed' | 'failed' | 'timeout'` and `FileDeleteDispatchResult.status` is the same union.
- `CLEANUP_GUARD_REJECTED_PREFIX` (TS) and `CleanupGuardRejectedPrefix` (Go) are pinned to the identical literal by a test on each side (Tasks 1 and 2), because the API's `rejected` mapping is a string-prefix contract across the language boundary.
- `executedActions` moves from `unknown[]` to `{ partial: boolean; budgetMs: number; actions: unknown[] }`; the column stays `jsonb` and `readExecutedActions` narrows both shapes, so no schema type changes and no reader breaks.
- `ContentfulStatusCode` is imported from `hono/utils/http-status`, the same import `apps/api/src/lib/jsonError.ts:2` already uses, so the dynamic-status helpers typecheck without a cast.
