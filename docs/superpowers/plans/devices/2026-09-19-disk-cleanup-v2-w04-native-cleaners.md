---
tracking_issue: LanternOps/breeze#6326
---
# Disk Cleanup v2 W04: OS-Native Cleaners — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second, opaque cleanup engine — a fixed, vetted catalog of platform maintenance actions (Windows `cleanmgr` handlers and DISM component cleanup, macOS local snapshots and Homebrew, Linux package caches and journal vacuum) — reachable from the Disk Cleanup tab as `system_cleanup_list` / `system_cleanup_run`, recorded as `device_filesystem_cleanup_runs` rows with `kind='system'`, and reporting **measured** free-space deltas rather than estimates.

**Architecture:** A new Go package `agent/internal/syscleanup/` owns an `Action` interface and one common runner (absolute binaries, no shell, `exec.CommandContext`, per-action timeouts, 16 KiB output caps, process-tree kill via a Windows job object or a POSIX process group, `LC_ALL=C LANG=C` child env, `dism /English`). Every argv builder and every output parser is a **pure function in an untagged file**, so `go test -race ./internal/syscleanup/...` runs the whole catalog's logic on the Linux CI runner; only the syscalls live behind `_windows.go` / `_darwin.go` / `_linux.go`. The API adds two command types, four routes (queue + poll for each of list and run), an agent-result handler registered in the **shared** `commandResultHandlers` registry so both transports close the run, and a `409 agent_update_required` gate driven by `compareAgentVersions`. The web adds one `SystemCleanupPanel` mounted into the W03 `DeviceFilesystemTab` composer. Client input is action ids from a closed shared list plus one bounded integer; nothing else ever reaches an argv.

**Tech Stack:** Go 1.x (`agent/`, stdlib + `golang.org/x/sys/windows/registry` + `github.com/shirou/gopsutil/v3/disk`), TypeScript/Hono + Drizzle (`apps/api`), Zod (`packages/shared`), React + Vitest/jsdom (`apps/web`), Astro Starlight MDX (`apps/docs`). No migration, no schema change, no new env var.

**Spec:** `docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md` — §3 (W04 row), §5.3 in full, §7 in full, §8 (the **SystemCleanupPanel** bullet, its mount into `DeviceFilesystemTab`, the `409 agent_update_required` banner, `runAction`, 8 locales), §10 items 7 and 9, §11 (the Go / API / Web bullets that name this wave's surfaces, plus the `agents/commands.mdx` and native-catalog docs), and §11's lab bullet reproduced verbatim as this plan's exit gate (executed by W05).

**Branch:** `feature/<parent#>-disk-cleanup-v2/wave-<subissue#>`

---

## Global Constraints

- **Closed catalog.** Client input is action ids drawn from `SYSTEM_CLEANUP_ACTION_IDS` plus one bounded integer (`journalVacuumBytes`, 64 MiB – 4 GiB). Argv is built from Go constants; binaries are absolute; no shell; timeouts and output caps on every process (spec §10 item 7).
- **Never `/ResetBase`**, never `DownloadsFolder`, never `Windows ESD installation files`, never `Language Pack`, never a per-user cleanmgr handler. Excluded **in code, not config** (spec §7.2, §10 item 7).
- **No test executes a real cleaner.** Every parser is exercised on a fixture string; every argv builder is a pure table test (spec §11).
- **`isRecursiveDeleteBoundaryFor` is untouched** by this wave — it is the W01 file-engine seam, and the native engine never calls it (spec §11).
- **Go:** `cd agent && go test -race ./internal/<pkg>/...`; test files sit alongside source (`x.go` → `x_test.go`). Platform code behind `_windows.go` / `_darwin.go` / `_linux.go`; pure argv builders and parsers in untagged files so the Linux `Test Agent` job (`go test ./...`) covers them. `go vet` runs for linux, and cross-compiled for windows (`scripts/check-windows-vet.sh`) and darwin — both gates must pass.
- **API test command:** `cd apps/api && npx vitest run <path>`. **Web:** `cd apps/web && npx vitest run <path>`. **Shared:** `cd packages/shared && npx vitest run <path>`. Never `pnpm --filter <pkg> test -- --run <path>` — pnpm forwards the literal `--`, vitest swallows `--run`, and the whole suite runs in watch mode (CLAUDE.md "Two traps"). Vitest path filters are plain substrings, not globs: list dotted sibling files explicitly.
- **Typecheck:** `pnpm exec tsc --noEmit --project apps/api/tsconfig.json` (repo root — this is what CI's `typecheck` job runs; `apps/api/tsconfig.json` includes `src/**/*`, so test files are type-checked). Shared: `pnpm --filter @breeze/shared typecheck`. Web: `cd apps/web && pnpm exec astro check`.
- **No migration in this wave.** W04 consumes the W02 columns (`device_filesystem_cleanup_runs.kind`, `.command_id`, `.scan_path`) and the W02 enum label `running`. Nothing is added to `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES`, `CORE_TENANT_EXPORT_POLICY` or `rls-coverage.integration.test.ts` — no table and no column is created here (spec §4: all three filesystem tables are already registered everywhere, and W02 classifies its own new columns). `pnpm db:check-drift` must stay clean, which it does because `db/schema/filesystem.ts` is not edited.
- **Gating is unchanged** (spec §5): `authMiddleware` + `requireScope('organization','partner','system')` + `requirePermission(DEVICES_EXECUTE)` + `requireMfa()` on both mutations; `DEVICES_READ` on both polls.
- **Web mutations go through `runAction`** (`apps/web/src/lib/runAction.ts`); the new panel is added to `TARGET_GLOBS` in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` so the guard has teeth on it.
- **i18n in all 8 locales** (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`) with real translations, not English copies — `apps/web/src/lib/i18n/localeParity.test.ts` and `translationCoverage.test.ts` enforce it.
- **File-size guideline:** aim under 500 lines. `routes/devices/filesystem.ts` is 471 lines today and W02/W03 grow it, so the four new routes live in their own sibling module; `routes/agents/helpers.ts` is 3367 lines, so the result handler lives in the shared registry module instead (see amendment 5).
- **Audit:** `device.filesystem.system_cleanup.run` carries action ids, per-action status and measured bytes (spec §9 of the safety model, item 9).
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Rigor is **high** for the agent half (ships to customer machines, spawns privileged processes) and **medium** for the API/web half. Red first on every task.

---

## Plan amendments

Every spec claim this wave depends on was re-verified against the working tree on 2026-09-19 (`spec/disk-cleanup-v2`, base `5809cad7c0`). Where the spec is wrong or silent, the verified fact and the plan's response are recorded here.

1. **`CommandTypes` is defined in `services/commandTypes.ts`, not `commandQueue.ts`.** The spec's §5.3 registry list says "`CommandTypes` in `services/commandQueue.ts`". Verified: `apps/api/src/services/commandTypes.ts:14` holds `export const CommandTypes = { … } as const`; `commandQueue.ts:60` re-exports it (`export { CommandTypes, type CommandType } from './commandTypes';`). The module header states why: #5128 moved the table into a **leaf** module because `commandOfflinePolicy.ts` builds its fail-closed registry from it at load time, and leaving it in `commandQueue.ts` was a genuine ESM initialisation cycle. The two new types are therefore added to `commandTypes.ts`.

2. **`COMMAND_OFFLINE_POLICY_REGISTRY` has no "long class used by patch/backup jobs".** The spec asks for `system_cleanup_run` in that class. Verified: the classes are exactly `live | standard | short | power_state` (`commandOfflinePolicy.ts:12`), and `standard` (7 days, `DEVICE_COMMAND_QUEUE_TTL_HOURS`, default 168) is the longest. `FILESYSTEM_ANALYSIS`, `INSTALL_PATCHES`, `SOFTWARE_INSTALL` and `SCRIPT` are all in `STANDARD_REVIEWED` (`:219-249`); backup/restore types are deliberately `live` (reject). So **both** new types go into `STANDARD_REVIEWED` — `system_cleanup_list` lands in the same class as `filesystem_analysis` exactly as the spec asks, and `system_cleanup_run` lands in the same class as patch installs, which is what the spec's phrase describes. A `CommandTypes` value listed in none of the arrays still resolves to `standard`, but `commandOfflinePolicy.test.ts:81` ("every CommandTypes value is EXPLICITLY classified, never left to the fallback") fails — that is the red this task hangs on.

3. **A ninth registry the spec does not name: `services/commandTimeouts.ts`.** `getCommandTimeoutMs` (`:134`) falls through to `DEFAULT_TIMEOUT_MS` = 30 minutes for an unregistered type and logs `[commandTimeouts] Unknown command type "…"`. The stale reaper (`jobs/staleCommandReaper.ts:428`) uses that value, so a 90-minute DISM run would be terminalised at 30 minutes while the agent was still working. `system_cleanup_run` gets an explicit three-hour branch and **`SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS` is exported from that same module** as the reaper's ceiling (amendment 23 replaced the fixed budget with a per-selection one stored on the row). `system_cleanup_list` goes into `MEDIUM_TIMEOUT_TYPES` (30 minutes), matching `FILESYSTEM_ANALYSIS`; the agent's own estimation cap is 3 minutes, so the server clock is pure backstop.

4. **A tenth and eleventh registry, both Go-adjacent.** (a) `agent/internal/heartbeat/handlers_test.go:14` `allCommandTypes` — `TestHandlerRegistryNoExtraEntries` fails for any `handlerRegistry` key not listed there. (b) `apps/api/src/services/partnerTrust.test.ts:122` `agentDispatcherCommandTypes()` parses `agent/internal/heartbeat/handlers*.go` **and** `agent/internal/remote/tools/types.go` for `Cmd… = "…"` constants and registry entries, then asserts every discovered type is in **exactly one** of `LIFECYCLE_COMMAND_TYPES` / `GATED_COMMAND_TYPES`. So the moment the Go constants land, that API suite goes red until `partnerTrust.ts`'s `GATED_COMMAND_TYPES` gains both ids — which is the cross-language red this plan uses. `privilege.RequiresElevation` (`agent/internal/privilege/check.go:7`) is a twelfth, warn-only list; `system_cleanup_run` is added to it because cleanmgr, DISM, `apt-get` and `journalctl --vacuum-size` all need root/SYSTEM.

5. **The agent-result handler belongs in the shared registry, not in `routes/agents/helpers.ts`.** The spec says to mirror `handleFilesystemAnalysisCommandResult`. Verified: that function (`helpers.ts:1593`) is dispatched from **one** place — `routes/agents/commands.ts:523`, the HTTP leg. The WebSocket leg (`routes/agentWs.ts:2310`) dispatches only `services/commandResultHandlers.ts`. Mirroring it literally would mean a `system_cleanup_run` result delivered over the live socket never closes the run, leaving the row `running` until the 2 h lazy timeout — a silent, transport-dependent failure. W04 therefore registers `system_cleanup_run: handleSystemCleanupRunResult` in `commandResultHandlers` (`:897`), which **both** transports dispatch, and adds the type to `REGISTRY_DISPATCHED_COMMAND_TYPES` (`commands.ts:89`) so the HTTP leg reaches it too. Fixing `filesystem_analysis`'s own transport gap is out of W04's scope and is recorded here as a follow-up. This also keeps `helpers.ts` (3367 lines) from growing.

6. **The catalog cannot be read through `GET /devices/:id/commands/:commandId`.** The spec's §5.3 says the client polls that route and reads the catalog off `deviceCommands.result`. Verified, two independent blockers: (a) `buildStoredCommandResult` (`routes/agents/commands.ts:112`, twin at `routes/agentWs.ts:716`) persists only `{status, exitCode, stdout, stderr, durationMs, error}` — the agent's structured `result` field is **dropped**; (b) `sanitizeCommandResultForHistory` (`services/commandAudit.ts:93-110`) replaces `stdout` with `"[REDACTED]: stdout omitted from command history"` for every type outside `RAW_STDOUT_COMMAND_TYPES`, which contains only `capture_pprof`. And the spec's own defensive requirement — "a command result whose `error` starts with `unknown command type:` also resolves to the same 409 shape **on poll**" — cannot be met by that route at all, since it always answers 200 with the row. W04 therefore adds two W04-owned poll routes that read the command row server-side (unredacted, from the DB), parse and Zod-validate the agent JSON, and own the 409 branch. `RAW_STDOUT_COMMAND_TYPES` is deliberately **not** widened: `isRawStdoutArtifactCommand` also disables `redactSecretsFromOutput` at ingest, and that is not a trade this feature needs.

7. **The run poll is a W04 route, not W03's `GET …/cleanup-runs/:runId`.** Spec §5.2 gives W03 a generic per-run route. W04 needs a *system* projection (per-action status, per-volume `freeBefore`/`freeAfter`, the same `unknown command type:` → 409 branch, and the lazy 2 h `running → failed ('timed out')` transition), and must not pin its UI to the response shape of a route another wave authors. `GET /devices/:id/filesystem/system-cleanup/run/:cleanupRunId` is therefore W04-owned. W03's history route still lists system runs; nothing is duplicated except the row lookup.

8. **`patching`'s exec-with-limits helpers are unexported and do not kill process trees.** `agent/internal/patching/command_limits.go` exposes `commandOutputWithTimeout`, `runCmdCombinedOutputWithTimeout`, `truncatePatchOutput` etc. — all lower-case, package-private, and none of them contains the child's descendants. `syscleanup` therefore carries its own runner, modelled on the repo's existing containment pair: `runInstallerCommand` (`agent/internal/remote/tools/software_install.go:652` — Start/Wait rather than `CombinedOutput`, `lockedBuffer`, `WaitDelay`, adopt-then-wait) and `installerProcessTree` (`software_install_process_tree.go` interface, `_windows.go` job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, `_unix.go` `Setpgid` + `Kill(-pid)`).

9. **`procoutput.ApplyEnv` must not be used for the parsed cleaners.** Verified `agent/internal/procoutput/env.go:8`: it appends `LANG=C.UTF-8 / LC_ALL=C.UTF-8 / LC_CTYPE=C.UTF-8` **only when the inherited env has no UTF-8 locale already**. On a host with `LC_ALL=fr_FR.UTF-8` it returns the env unchanged, apt/dnf/journalctl emit French, every parser misses, and (per spec §7.1) the action reports `estimateKnown:false` — a silent, locale-dependent degradation. `syscleanup` builds the child env with its own pure `cLocaleEnv(base []string) []string`, which **removes then re-adds** `LANG`, `LC_ALL`, `LC_CTYPE`, `LC_MESSAGES`, `LC_NUMERIC` as `C`. `procoutput.BytesToUTF8` is still used to decode Windows console bytes.

10. **`compareAgentVersions` returns 0 for an unparseable version.** Verified `services/agentEditionCompat.ts:48-52`: `if (!left || !right) return 0`. A device whose `agent_version` is `''` or garbage would therefore compare "equal to the minimum" and **pass** the gate. `devices.agentVersion` is `varchar(50) NOT NULL` (`db/schema/devices.ts:90`), so `''` is reachable. The route parses with `parseComparableVersion` first and treats `null` as unsupported (409), and compares only the **core** (`raw.split('-')[0]`) so a `0.115.0-rc1` lab build is not gated out — which is what the spec's phrase "core semver" means.

11. **`MIN_AGENT_VERSION_SYSTEM_CLEANUP = '0.115.0'.`** The spec defers the value to plan time. Newest tag on this checkout is `v0.114.0` (verified `git tag --list 'v0.11*' | sort -V | tail -1`, 2026-09-19), so W04 ships in the next minor. If a release lands before W04 merges, bump the constant to the next unreleased minor in the same PR; its only assertion is the pin in Task 11.

12. **cleanmgr sub-actions need ids of their own, or the closed-catalog rule leaks.** Spec §7.2 selects cleanmgr work "per selected handler sub-id" while §5.3 says `actionIds` must be a subset of `SYSTEM_CLEANUP_ACTION_IDS`. Registry key names are never accepted from the client. `SYSTEM_CLEANUP_ACTION_IDS` therefore carries **7 top-level ids + 20 `win_cleanmgr:<slug>` sub-ids = 27**, and the slug → registry-key-name map is a Go constant (`winCleanmgrHandlers`). A bare `win_cleanmgr` with no sub-ids means "every allowlisted handler present on this device".

13. **`writeRouteAudit` cannot be called from the result path.** It requires a Hono auth context (`services/auditEvents.ts:144`, `c.get('auth')`), and the result handler has none. The audit uses `writeAuditEvent(requestLikeFromSnapshot({}), { …, actorId: run.requestedBy })` — the pattern already used by `jobs/quoteSendQueue.ts:231` with the same rationale in its comment ("No request here, so attribute the actor who scheduled the send explicitly").

14. **`apps/web/src/components/devices/filesystem/` does not exist yet.** Verified. W03 creates it (spec §8) and rewrites `apps/web/src/components/devices/DeviceFilesystemTab.tsx` **at its current path** — it is imported at `DeviceDetails.tsx:60` (`import DeviceFilesystemTab from "./DeviceFilesystemTab";`, rendered at `:831`) and listed in `runActionAllowlist.ts:17`, so moving it would be a separate change W03 has no reason to make. W04 consumes `export default function DeviceFilesystemTab(props: { deviceId: string; osType: OSType; onOpenFiles?: () => void })` at that path and mounts `SystemCleanupPanel` into it. **The panel owns its own poll loop** rather than consuming W03's `useCommandPoll`: it polls W04 routes with a 409 branch rather than the generic command endpoint, and a cross-wave hook signature is not something this plan can pin without inventing it. If W03 landed the composer elsewhere, change only the import path in Task 14 and record it as an amendment.

15. **`syscleanup` may import `agent/internal/patching`.** Verified: `patching`'s only internal imports are `internal/config`, `internal/logging`, `internal/patching/linuxsession` — no cycle. `homebrew.go` is `//go:build darwin`, so the exported `BrewCleanup` is reachable only from `syscleanup`'s darwin file, which is exactly where it is needed. `runBrewCleanup` is at `homebrew.go:319` (spec's line number is correct); `brewCleanupArgs()` at `:280` already returns `[]string{"cleanup", "--prune=all"}` and is table-tested at `homebrew_test.go:488`.

16. **`NewSuccessResult` writes only `Stdout`.** `agent/internal/remote/tools/types.go:291` JSON-marshals the payload into `Stdout` and leaves `Result` nil. Because the API drops `result` anyway (amendment 6) and the W04 poll routes read the stored `stdout`, the handlers use `tools.NewSuccessResult` unchanged — no new result-envelope mechanics. The 5 MB `stdout` cap in `commandResultSchema` (`routes/agents/schemas.ts:491`) bounds the catalog comfortably: 27 actions × a few hundred bytes.

17. **Cross-wave alignment pass (2026-09-19): `list`/`run` are a SERVICE, not a route body.** The five plans were written in parallel, and W05 assumed `apps/api/src/services/systemCleanup.ts` exports `systemCleanupAgentGate`, `queueSystemCleanupList` and `startSystemCleanupRun` (its amendment A1 offered to extract them itself if W04 had inlined them). That conditional is now resolved in W04's favour, because W04 is the producing wave: Task 11a's Produces gains `systemCleanupAgentGate`, Task 11b gains **Step 3a** which implements the two queue/start functions in that module, and both route handlers were rewritten to call them and to stop importing `CommandTypes`/`queueCommandForExecution` at all. W05 Task 1 then only *adds* an optional `aiOrigin` parameter and the `awaitSystemCleanupResult` poller. Note the type-name reservation: `SystemCleanupRunResult` in this module is **W04's parsed agent payload** (Task 11a), so the queue/start discriminated union is `SystemCleanupStartResult` — W05 was renamed to match. Also aligned: `no-silent-mutations`'s count assertion is a running total across waves (W01 147, W03 148), so Task 14 Step 5 bumps it to 149 rather than leaving it untouched.

### Amendments from the Codex `gpt-6-astra` xhigh quorum (spec §13, 2026-09-19)

Numbering continues from 17 rather than restarting: amendments 1–17 are cross-referenced by number throughout the tasks below, and renumbering them would silently invalidate every one of those references. Spec §13 findings 4, 5, 6, 11, 12, 13, 14 and 15 name W04 as the owning wave; each is applied in place in the tasks listed.

18. **The self-managed-context registry is `middleware/selfManagedDbContextRoutes.ts`, not `db/index.ts`.** Spec §13 #5 says "`db/index.ts` registry". Verified: `db/index.ts` exports the context helpers (`withDbAccessContext:642`, `withSystemDbAccessContext:734`, `runOutsideDbContext:939`) but holds no route registry. The opt-out list is `SELF_MANAGED_DB_CONTEXT_ROUTES` (`middleware/selfManagedDbContextRoutes.ts:30`), an array of `{ method, pattern: RegExp }` matched against the **full** path including the `/api/v1` mount prefix, consulted by `isSelfManagedDbContextRoute` (`:280`) from `middleware/auth.ts`. (Task 11b)

19. **There is no offline TTL class ≤ 15 minutes to reuse.** Spec §13 #6 asks for "the shortest offline TTL class (or a new `LIVE_ONLY` class if none is ≤ 15 min)". Verified `commandOfflinePolicy.ts:12,46-58`: the classes are `live` (which is `{kind:'reject'}` — it does not queue at all, so it cannot express "deliver within 15 minutes"), `standard` (168 h), `short` (24 h) and `power_state` (24 h). The shortest *queueing* class is therefore 24 h, 96× the ceiling this finding sets. W04 adds a `live_only` class at 15 minutes (env-tunable via `DEVICE_COMMAND_QUEUE_LIVE_ONLY_TTL_MINUTES`, floor 1 minute) and puts both new command types in it. W01 needs the same class for `file_delete` under `cleanupGuard` (spec §13 #6 names both waves): whichever lands first adds the class body, the other adds only its registry entries — the class body in Task 10 is the canonical text for both.

20. **`apt-get -s autoremove` prints no "After this operation" line.** The plan's original parser (and the spec's §7.2 table) assumed it did. Spec §13 #14 records this as verified against the APT source: that summary is emitted by the interactive install path, not by `-s`. A parser looking for it matches nothing and — under this plan's own "unknown, never 0" rule — every Debian/Ubuntu endpoint would report `estimateKnown:false` for the one action whose size a tech most wants to know. The estimate becomes Σ `dpkg-query -W -f='${Installed-Size}\n' <pkg>…` over the packages named by the simulation's `Remv <pkg>` lines. `Installed-Size` is **KiB**, so the sum is multiplied by 1024. It is a *heuristic*, not an upper bound: unpacked footprint over-counts shared files. (Task 4)

21. **`tmutil deletelocalsnapshots <date>` is machine-wide.** Spec §13 #11: a bare date deletes the snapshot with that timestamp on **every** mounted APFS volume, including a Time Machine destination or an attached backup disk carrying a snapshot of the same instant. The mount-point form `tmutil deletelocalsnapshots /` deletes only the startup volume's, and `tmutil listlocalsnapshots /` is already scoped that way. The per-date loop is replaced by a single mount-point invocation. (Task 5)

22. **A `maintenance` lock package does not exist and must be created.** Spec §13 #4/#12 require one process-wide lock shared by `system_cleanup_run`, DISM and the `patching` Homebrew cleanup. Verified: the agent has `HomebrewProvider.brewMutateMu` (an *instance* mutex, `homebrew.go:52`) and `executor`'s per-execution containment, but nothing process-wide and nothing shared across packages. `agent/internal/maintenance` is new and must be a LEAF — it is imported by both `syscleanup` and `patching`, so it may import neither. (New Task 2b; consumed by 5, 6, 7)

23. **`SYSTEM_CLEANUP_RUN_TIMEOUT_MS` becomes a function of the selection.** Spec §13 #14's aggregate-budget rule makes a single constant wrong in both directions: a lone `linux_pkg_cache_clean` would get two hours for five minutes of work, while `win_cleanmgr` (60 min) + `win_dism_component_cleanup` (90 min) needs 150 and would be reaped at 120 mid-DISM. The budget is Σ the selected actions' own timeouts + 10 minutes, capped at 3 h. The per-run deadline is **stored on the row** (`plan.deadlineAt`) so the route's lazy timeout and the reaper read one number instead of each recomputing it from a selection they would have to re-parse. `commandTimeouts.ts` keeps a constant only as the command row's ceiling: `SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS = 3 h`. (Tasks 7, 10, 11a, 11b)

24. **The 16 KiB output cap must preserve the TAIL, not the head.** As originally written `capOutput` kept the first 16 KiB. Every parser in this package reads a *trailing* summary line (`Freed space:`, `This operation would free approximately`, `Archived and active journals take up`), and the failure a human reads in `outputTail` is at the end too. A head-preserving cap silently truncates exactly the bytes that matter on any verbose run. (Task 2)

25. **`Component Store Cleanup Recommended : No` is not a zero.** Spec §13 #14: the two DISM fields are component-store *overhead*, and a direct `/StartComponentCleanup` has no 30-day grace period (that applies to the scheduled task, not the explicit invocation). "Recommended: No" means Windows does not think it is worth doing, not that nothing would be freed. The estimate reports the summed fields in both cases, flagged, and is labelled `heuristic`; the plan's original "Recommended: No → a KNOWN zero" behaviour and its "30-day grace" wording are both withdrawn. (Task 6)

26. **The Delivery Optimization cache is not under `%SystemRoot%\SoftwareDistribution`,** and the `Temporary Files` handler covers more than `%SystemRoot%\Temp` (spec §13 #14). The DO cache default is `%SystemDrive%\Windows\ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache`, policy-overridable via `HKLM\SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization\DOModifyCacheDrive`; the `Temporary Files` estimate is marked unknown rather than under-reported. (Task 6)

---

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `agent/internal/syscleanup/types.go` (+ `types_test.go`) | `Action`, `ActionInfo`, `ActionResult`, `Params`, `CatalogVersion`, `ActionIDs`, risk-flag constants | 1 |
| `agent/internal/syscleanup/shared_ids_test.go` | Go↔TS parity: the ids in `packages/shared/src/validators/systemCleanup.ts` equal the Go catalog's | 1 |
| `agent/internal/syscleanup/runner.go` (+ `runner_test.go`) | `cLocaleEnv`, tail-preserving `capOutput`, `runProcess`, `ProcResult` | 2 |
| `agent/internal/maintenance/lock.go` (+ `lock_test.go`) | process-wide `TryAcquire`/`Acquire`/`ErrBusy`, shared with `patching` | 2b |
| `agent/internal/syscleanup/process_tree.go`, `_windows.go`, `_unix.go` (+ `process_tree_test.go`) | job object / process group containment | 2 |
| `agent/internal/syscleanup/volumes.go` (+ `volumes_test.go`) | `VolumeFree`, `measureFreed`, `usageFn` seam | 3 |
| `agent/internal/syscleanup/linux.go`, `linux_probe_linux.go`, `linux_probe_other.go` (+ `linux_test.go`) | three Linux actions, argv builders, four parsers, `Available()` probes | 4 |
| `agent/internal/syscleanup/darwin.go`, `darwin_actions_darwin.go`, `darwin_actions_other.go` (+ `darwin_test.go`) | tmutil + brew actions, parsers | 5 |
| `agent/internal/patching/homebrew.go` (+ `homebrew_test.go`) | exported `BrewCleanup(ctx, dryRun)`; `runBrewCleanup` becomes its swallow-and-log wrapper | 5 |
| `agent/internal/syscleanup/windows.go`, `windows_registry_windows.go`, `windows_registry_other.go` (+ `windows_test.go`) | handler allowlist, friendly names, `StateFlags5555`, cleanmgr + DISM argv, DISM analyze parser | 6 |
| `agent/internal/syscleanup/catalog.go` (+ `catalog_test.go`) | per-GOOS registry, `List`, `Run`, sequential ordering, estimate fan-out with a 3-minute cap | 7 |
| `agent/internal/remote/tools/types.go`, `agent/internal/heartbeat/handlers.go`, `handlers_syscleanup.go`, `handlers_test.go`, `agent/internal/privilege/check.go` (+ `check_test.go`) | command consts, registry entries, handlers, elevation list | 8 |
| `packages/shared/src/validators/systemCleanup.ts` (+ `.test.ts`), `packages/shared/src/validators/index.ts` | `SYSTEM_CLEANUP_ACTION_IDS`, `systemCleanupRunBodySchema`, `JOURNAL_VACUUM_*` bounds | 9 |
| `apps/api/src/services/commandTypes.ts`, `commandOfflinePolicy.ts`, `commandTimeouts.ts` (+ `.test.ts`), `partnerTrust.ts` | four command-type registries + the `live_only` TTL class + `SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS` | 10 |
| `apps/api/src/routes/devices/filesystemSystemCleanup.ts` (+ `.test.ts`), `routes/devices/index.ts` | four routes, agent-version gate, audit, lazy timeout | 11 |
| `apps/api/src/services/systemCleanupResultPayload.ts` (+ `.test.ts`) | shared Zod shapes for the two agent payloads (route + result handler) | 11 |
| `apps/api/src/services/commandResultHandlers.ts` (+ `commandResultHandlers.systemCleanup.test.ts`), `routes/agents/commands.ts` | `handleSystemCleanupRunResult`, late-result recording, registry entry, `REGISTRY_DISPATCHED_COMMAND_TYPES` | 12 |
| `apps/api/src/services/commandCancelPropagation.ts` (+ `commandCancelPropagation.systemCleanup.test.ts`) | terminalise a system run whose command was cancelled | 12b |
| `apps/api/src/middleware/selfManagedDbContextRoutes.ts` (+ `.test.ts`) | both POSTs opt out of the ambient request transaction | 11b |
| `apps/web/src/components/devices/filesystem/SystemCleanupPanel.tsx` (+ `.test.tsx`) | list → rows → Run → destructive confirm → running → result; 409 banner | 13 |
| `apps/web/src/components/devices/DeviceFilesystemTab.tsx` (+ `DeviceFilesystemTab.systemCleanup.test.tsx`), `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` | MOUNT + page-level proof + guard coverage | 14 |
| `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/devices.json` | 8-locale strings | 15 |
| `apps/docs/src/content/docs/agents/commands.mdx`, `features/filesystem-analysis.mdx`, `apps/api/src/data/docsIndex.json` | two command types + native catalog section | 16 |
| this file | W04 exit gate (lab acceptance criteria, executed by W05) | 17 |

**Why this task order.** The agent package is built bottom-up (types → runner → volumes → per-OS actions → catalog → heartbeat wiring) so every task compiles and tests green on its own. The Go command constants deliberately land in Task 8, **after** the package works, because they are what turns `partnerTrust.test.ts` red across the language boundary — Task 10 then closes it. The shared validator (Task 9) sits between the two so the Go↔TS id parity test written in Task 1 has something to compare against by the time it is wired in Task 8. API routes (11–12) precede the web (13–15) so the panel is written against a real response shape.

---

### Task 1: `syscleanup` action contract and the id catalogue

**Files:**
- Create: `agent/internal/syscleanup/types.go`
- Create: `agent/internal/syscleanup/types_test.go` (Test)
- Create: `agent/internal/syscleanup/shared_ids_test.go` (Test)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```go
  const CatalogVersion = 1
  type RiskFlag = string
  const (
      RiskLongRunning          RiskFlag = "long_running"
      RiskMayRequireReboot     RiskFlag = "may_require_reboot"
      RiskMayRequireRebootFree RiskFlag = "may_require_reboot_free_state"
      RiskRemovesDriverRollback RiskFlag = "removes_driver_rollback"
      RiskRemovesPackages      RiskFlag = "removes_packages"
  )
  type ActionInfo struct {
      ID, Label, Description, OS string
      RiskFlags       []string
      AffectsVolumes  []string
  }
  type SubActionInfo struct {
      ID, Label     string
      EstimateBytes int64
      EstimateKnown bool
  }
  type Params struct{ JournalVacuumBytes int64 }
  type ActionStatus = string
  const (
      StatusCompleted   ActionStatus = "completed"
      StatusFailed      ActionStatus = "failed"
      StatusTimedOut    ActionStatus = "timed_out"
      StatusUnavailable ActionStatus = "unavailable"
  )
  type ActionResult struct {
      ID          string          `json:"id"`
      SubActions  []SubActionRun  `json:"subActions,omitempty"`
      Status      string          `json:"status"`
      ExitCode    int             `json:"exitCode"`
      DurationMs  int64           `json:"durationMs"`
      OutputTail  string          `json:"outputTail,omitempty"`
      Error       string          `json:"error,omitempty"`
  }
  type SubActionRun struct {
      ID     string `json:"id"`
      Status string `json:"status"`
  }
  type Action interface {
      ID() string
      Describe() ActionInfo
      Available(ctx context.Context) (bool, string)
      Estimate(ctx context.Context) (int64, bool, string)
      Run(ctx context.Context, params Params) ActionResult
  }
  // Every id the server may send, in catalog order. 7 top-level + 20 cleanmgr sub-ids.
  var ActionIDs = []string{ … }
  func IsKnownActionID(id string) bool
  ```

- [ ] **Step 1: Write the failing test** — create `agent/internal/syscleanup/types_test.go`:

```go
package syscleanup

import (
	"strings"
	"testing"
)

// The closed catalogue (spec §5.3, §7.2 + plan amendment 12). Registry key
// names are NEVER accepted from the client: a cleanmgr handler is addressed by
// a `win_cleanmgr:<slug>` id whose slug maps to a key name through a Go
// constant. This test pins the exact id set so widening it is a deliberate,
// reviewable edit rather than a drive-by.
func TestActionIDsIsTheClosedCatalogue(t *testing.T) {
	want := []string{
		"win_cleanmgr",
		"win_cleanmgr:update_cleanup",
		"win_cleanmgr:delivery_optimization_files",
		"win_cleanmgr:device_driver_packages",
		"win_cleanmgr:previous_installations",
		"win_cleanmgr:upgrade_discarded_files",
		"win_cleanmgr:windows_upgrade_log_files",
		"win_cleanmgr:setup_log_files",
		"win_cleanmgr:temporary_setup_files",
		"win_cleanmgr:service_pack_cleanup",
		"win_cleanmgr:system_error_memory_dump_files",
		"win_cleanmgr:system_error_minidump_files",
		"win_cleanmgr:windows_error_reporting_files",
		"win_cleanmgr:windows_error_reporting_system_archive_files",
		"win_cleanmgr:windows_error_reporting_system_queue_files",
		"win_cleanmgr:temporary_files",
		"win_cleanmgr:windows_defender",
		"win_cleanmgr:old_chkdsk_files",
		"win_cleanmgr:diagnostic_data_viewer_database_files",
		"win_cleanmgr:branchcache",
		"win_cleanmgr:content_indexer_cleaner",
		"win_dism_component_cleanup",
		"mac_tm_local_snapshots",
		"mac_brew_cleanup",
		"linux_pkg_cache_clean",
		"linux_pkg_autoremove",
		"linux_journal_vacuum",
	}
	if len(ActionIDs) != len(want) {
		t.Fatalf("ActionIDs has %d entries, want %d", len(ActionIDs), len(want))
	}
	for i := range want {
		if ActionIDs[i] != want[i] {
			t.Fatalf("ActionIDs[%d] = %q, want %q", i, ActionIDs[i], want[i])
		}
	}
}

// Excluded in code, not config (spec §7.2, §10 item 7).
func TestActionIDsExcludeTheForbiddenHandlers(t *testing.T) {
	for _, forbidden := range []string{
		"downloadsfolder", "windows esd", "language pack",
		"recycle bin", "thumbnail cache", "temporary internet files",
		"internet cache files", "active setup temp folders",
		"gamenewsfiles", "gamestatisticsfiles", "gameupdatefiles",
		"resetbase",
	} {
		for _, id := range ActionIDs {
			if strings.Contains(strings.ToLower(id), strings.ReplaceAll(forbidden, " ", "_")) {
				t.Fatalf("forbidden handler %q is reachable as action id %q", forbidden, id)
			}
		}
	}
}

func TestIsKnownActionIDRejectsAnythingElse(t *testing.T) {
	if !IsKnownActionID("linux_journal_vacuum") {
		t.Fatal("a catalogue id must be known")
	}
	for _, id := range []string{
		"", "LINUX_JOURNAL_VACUUM", "win_cleanmgr:DownloadsFolder",
		"win_cleanmgr:../../etc/passwd", "linux_journal_vacuum; rm -rf /",
	} {
		if IsKnownActionID(id) {
			t.Fatalf("IsKnownActionID(%q) = true, want false", id)
		}
	}
}

func TestCatalogVersionIsPinned(t *testing.T) {
	if CatalogVersion != 1 {
		t.Fatalf("CatalogVersion = %d, want 1 (bump deliberately; the server records it on every run)", CatalogVersion)
	}
}

// Spec §13 #4/#14/#15: two statuses and two risk flags the original catalogue
// did not have. They are pinned here because the shared TS validator, the run
// projection and eight locale catalogues all mirror these exact strings.
func TestStatusAndRiskFlagStringsArePinned(t *testing.T) {
	for _, pair := range [][2]string{
		{StatusCompleted, "completed"},
		{StatusFailed, "failed"},
		{StatusTimedOut, "timed_out"},
		{StatusUnavailable, "unavailable"},
		{StatusBusy, "busy"},
		{StatusNotStarted, "not_started"},
		{RiskLongRunning, "long_running"},
		{RiskMayRequireReboot, "may_require_reboot"},
		{RiskMayRequireRebootFree, "may_require_reboot_free_state"},
		{RiskRemovesDriverRollback, "removes_driver_rollback"},
		{RiskRemovesPackages, "removes_packages"},
		{RiskRemovesOSRollback, "removes_os_rollback"},
		{RiskRemovesRecoveryPoints, "removes_recovery_points"},
	} {
		if pair[0] != pair[1] {
			t.Errorf("constant = %q, want %q", pair[0], pair[1])
		}
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd agent && go test -race ./internal/syscleanup/...
```

Expected failure: a build failure, not an assertion —
`internal/syscleanup/types_test.go:20:9: undefined: ActionIDs` … `FAIL github.com/breeze-rmm/agent/internal/syscleanup [build failed]`.

- [ ] **Step 3: Implement** — create `agent/internal/syscleanup/types.go`:

```go
// Package syscleanup runs a FIXED, VETTED catalogue of OS-native maintenance
// actions (Disk Cleanup v2, spec §7). It is deliberately the opposite of the
// file engine in internal/remote/tools: nothing here is itemised, nothing is
// previewed path-by-path, and every estimate is an UPPER BOUND. What it
// guarantees instead is that the set of things it can do is closed.
//
// Safety model (spec §10 item 7), enforced structurally rather than by review:
//
//   - The only client input is an id drawn from ActionIDs and one bounded
//     integer (Params.JournalVacuumBytes). No string from the wire is ever
//     concatenated into an argv.
//   - Binaries are absolute paths resolved from a fixed candidate list, never
//     a $PATH lookup, and never through a shell.
//   - Every process gets a context deadline, a 16 KiB per-stream output cap,
//     and process-TREE containment so a timeout reaches the real worker rather
//     than the wrapper that spawned it.
//   - Argv builders and output parsers are PURE functions in untagged files,
//     so `go test -race ./internal/syscleanup/...` exercises the entire
//     catalogue's logic on the Linux CI runner. Only syscalls sit behind
//     _windows.go / _darwin.go / _linux.go.
package syscleanup

import "context"

// CatalogVersion is recorded on every cleanup run row. Bump it when the
// meaning of an existing id changes, not when one is added.
const CatalogVersion = 1

// RiskFlag values are rendered as badges by the web panel; removes_packages
// additionally gates the confirm dialog's second checkbox (spec §8).
type RiskFlag = string

const (
	RiskLongRunning           RiskFlag = "long_running"
	RiskMayRequireReboot      RiskFlag = "may_require_reboot"
	RiskMayRequireRebootFree  RiskFlag = "may_require_reboot_free_state"
	RiskRemovesDriverRollback RiskFlag = "removes_driver_rollback"
	RiskRemovesPackages       RiskFlag = "removes_packages"
	// Spec §13 #15. Two disclosures the original catalogue left implicit and
	// that a tech cannot recover from afterwards: deleting Windows.old ends
	// the 10-day "go back to the previous version" window, and deleting the
	// local APFS snapshots removes the only on-disk restore points a Mac has
	// when its Time Machine destination is not attached.
	RiskRemovesOSRollback      RiskFlag = "removes_os_rollback"
	RiskRemovesRecoveryPoints  RiskFlag = "removes_recovery_points"
)

// ActionStatus values as they appear in the run result (spec §7.3, §13 #4/#14).
type ActionStatus = string

const (
	StatusCompleted   ActionStatus = "completed"
	StatusFailed      ActionStatus = "failed"
	StatusTimedOut    ActionStatus = "timed_out"
	StatusUnavailable ActionStatus = "unavailable"
	// Another maintenance operation (a concurrent run, a patch job's Homebrew
	// cleanup, DISM) held the process-wide lock. Distinct from `failed`
	// because nothing was attempted and a retry is the right next step.
	StatusBusy ActionStatus = "busy"
	// The aggregate run budget expired before this action's turn. Distinct
	// from `timed_out`, which means THIS action ran and overran its own cap.
	StatusNotStarted ActionStatus = "not_started"
)

// ActionInfo is the static half of an action: everything the catalogue can
// state without touching the machine.
type ActionInfo struct {
	ID             string   `json:"id"`
	Label          string   `json:"label"`
	Description    string   `json:"description"`
	OS             string   `json:"os"`
	RiskFlags      []string `json:"riskFlags"`
	AffectsVolumes []string `json:"affectsVolumes"`
}

// SubActionInfo is one selectable unit inside a composite action — today only
// a cleanmgr handler.
type SubActionInfo struct {
	ID            string `json:"id"`
	Label         string `json:"label"`
	EstimateBytes int64  `json:"estimateBytes,omitempty"`
	EstimateKnown bool   `json:"estimateKnown"`
}

// Params carries the one bounded integer the client may influence. Bounds are
// enforced server-side (packages/shared/src/validators/systemCleanup.ts) AND
// again in linuxJournalVacuumArgs, so a forged payload cannot widen it.
type Params struct {
	JournalVacuumBytes int64 `json:"journalVacuumBytes,omitempty"`
}

// SubActionRun is one sub-action's outcome inside an ActionResult.
type SubActionRun struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

// ActionResult is one action's outcome (spec §7.3). OutputTail is already
// capped by the runner; Error is set for every non-completed status.
type ActionResult struct {
	ID         string         `json:"id"`
	SubActions []SubActionRun `json:"subActions,omitempty"`
	Status     string         `json:"status"`
	ExitCode   int            `json:"exitCode"`
	DurationMs int64          `json:"durationMs"`
	OutputTail string         `json:"outputTail,omitempty"`
	Error      string         `json:"error,omitempty"`
}

// Action is the contract every catalogue entry implements (spec §7.1).
//
// Estimate returns (bytes, known, detail). `known == false` is the honest
// answer for "the parser did not match its fixture shape" and MUST be used in
// preference to reporting 0 with known == true — a confident zero reads as
// "nothing to reclaim" in the UI, which is the exact lie this contract exists
// to prevent.
type Action interface {
	ID() string
	Describe() ActionInfo
	Available(ctx context.Context) (ok bool, reason string)
	Estimate(ctx context.Context) (bytes int64, known bool, detail string)
	Run(ctx context.Context, params Params) ActionResult
}

// winCleanmgrSubIDs are the cleanmgr handler sub-ids in catalogue order. The
// slug -> registry key name mapping lives in windows.go; this list exists here
// so ActionIDs (and therefore the shared TS validator) can be derived from one
// place.
var winCleanmgrSubIDs = []string{
	"win_cleanmgr:update_cleanup",
	"win_cleanmgr:delivery_optimization_files",
	"win_cleanmgr:device_driver_packages",
	"win_cleanmgr:previous_installations",
	"win_cleanmgr:upgrade_discarded_files",
	"win_cleanmgr:windows_upgrade_log_files",
	"win_cleanmgr:setup_log_files",
	"win_cleanmgr:temporary_setup_files",
	"win_cleanmgr:service_pack_cleanup",
	"win_cleanmgr:system_error_memory_dump_files",
	"win_cleanmgr:system_error_minidump_files",
	"win_cleanmgr:windows_error_reporting_files",
	"win_cleanmgr:windows_error_reporting_system_archive_files",
	"win_cleanmgr:windows_error_reporting_system_queue_files",
	"win_cleanmgr:temporary_files",
	"win_cleanmgr:windows_defender",
	"win_cleanmgr:old_chkdsk_files",
	"win_cleanmgr:diagnostic_data_viewer_database_files",
	"win_cleanmgr:branchcache",
	"win_cleanmgr:content_indexer_cleaner",
}

// ActionIDs is every id the server may send, in catalogue (execution) order.
// Mirrored by SYSTEM_CLEANUP_ACTION_IDS in
// packages/shared/src/validators/systemCleanup.ts; shared_ids_test.go proves
// the two lists are identical.
var ActionIDs = func() []string {
	ids := make([]string, 0, 1+len(winCleanmgrSubIDs)+6)
	ids = append(ids, "win_cleanmgr")
	ids = append(ids, winCleanmgrSubIDs...)
	return append(ids,
		"win_dism_component_cleanup",
		"mac_tm_local_snapshots",
		"mac_brew_cleanup",
		"linux_pkg_cache_clean",
		"linux_pkg_autoremove",
		"linux_journal_vacuum",
	)
}()

var knownActionIDs = func() map[string]bool {
	m := make(map[string]bool, len(ActionIDs))
	for _, id := range ActionIDs {
		m[id] = true
	}
	return m
}()

// IsKnownActionID is the agent-side half of the closed-catalogue rule. The
// server validates too (spec §5.3); this is the defence in depth that makes a
// forged command payload inert.
func IsKnownActionID(id string) bool { return knownActionIDs[id] }
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd agent && go test -race ./internal/syscleanup/...
```

Expected: `ok github.com/breeze-rmm/agent/internal/syscleanup` with 4 tests passing.

- [ ] **Step 5: Add the Go↔TS parity test** — create `agent/internal/syscleanup/shared_ids_test.go`:

```go
package syscleanup

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// The agent catalogue and the shared TS validator are two copies of one list.
// Keeping them in step by review has never worked in this repo (the cascade
// registries are the canonical example: contract tests 5/5, review 0/5), so
// this test reads the TypeScript source directly — the same technique
// apps/api/src/services/partnerTrust.test.ts uses in the other direction.
//
// It is skipped rather than failed when the file is absent so the Go package
// stays independently testable before the shared validator lands (Task 9);
// once it exists, drift is a hard failure.
func TestSharedValidatorIDsMatchTheCatalogue(t *testing.T) {
	// internal/syscleanup -> internal -> agent -> repo root
	path := filepath.Join("..", "..", "..", "packages", "shared", "src", "validators", "systemCleanup.ts")
	source, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("shared validator not present yet (%v) — Task 9 adds it", err)
	}

	block := regexp.MustCompile(`(?s)SYSTEM_CLEANUP_ACTION_IDS\s*=\s*\[(.*?)\]\s*as const`).FindSubmatch(source)
	if block == nil {
		t.Fatalf("could not find `SYSTEM_CLEANUP_ACTION_IDS = [ … ] as const` in %s", path)
	}
	found := regexp.MustCompile(`'([a-z0-9_:]+)'`).FindAllSubmatch(block[1], -1)
	if len(found) != len(ActionIDs) {
		t.Fatalf("shared validator lists %d ids, Go catalogue has %d", len(found), len(ActionIDs))
	}
	for i, match := range found {
		if got := string(match[1]); got != ActionIDs[i] {
			t.Fatalf("id %d: shared validator has %q, Go catalogue has %q", i, got, ActionIDs[i])
		}
	}
}
```

- [ ] **Step 6: Run it and watch it skip (not fail)**

```bash
cd agent && go test -race -run TestSharedValidatorIDsMatchTheCatalogue -v ./internal/syscleanup/...
```

Expected: `--- SKIP: TestSharedValidatorIDsMatchTheCatalogue` with `shared validator not present yet` — the file arrives in Task 9, and Task 9's last step re-runs this as a real assertion.

- [ ] **Step 7: Commit**

```bash
git add agent/internal/syscleanup/types.go agent/internal/syscleanup/types_test.go agent/internal/syscleanup/shared_ids_test.go
git commit -m "$(cat <<'MSG'
feat(agent): syscleanup action contract and closed id catalogue (W04)

The Action interface from spec §7.1 plus the 27-entry closed catalogue: 7
top-level ids and 20 win_cleanmgr:<slug> sub-ids. Registry key names are never
accepted from the client — the slug maps to a key name through a Go constant,
so no wire string reaches an argv.

Tests pin the exact id list, assert every forbidden handler (DownloadsFolder,
ESD, Language Pack, per-user bins, /ResetBase) is unreachable, and compare the
list against the shared TS validator (skipped until that lands in Task 9).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
)"
```

---

### Task 2: The common runner — no shell, absolute binaries, C locale, capped output, process-tree kill

**Files:**
- Create: `agent/internal/syscleanup/runner.go`
- Create: `agent/internal/syscleanup/runner_test.go` (Test)
- Create: `agent/internal/syscleanup/process_tree.go`
- Create: `agent/internal/syscleanup/process_tree_windows.go`
- Create: `agent/internal/syscleanup/process_tree_unix.go`
- Create: `agent/internal/syscleanup/log.go`

**Interfaces:**
- Consumes: `agent/internal/logging` (`logging.L`), `agent/internal/procoutput` (`BytesToUTF8`), `os/exec`, `golang.org/x/sys/windows` (windows file only).
- Produces:
  ```go
  const maxOutputBytes = 16 * 1024
  func cLocaleEnv(base []string) []string
  func capOutput(b []byte) string
  func resolveBinary(candidates ...string) (string, bool)
  type ProcResult struct {
      Path     string
      Args     []string
      Stdout   string
      Stderr   string
      ExitCode int
      Duration time.Duration
      TimedOut bool
      Err      error
  }
  func runProcess(ctx context.Context, timeout time.Duration, path string, args ...string) ProcResult
  ```

- [ ] **Step 1: Write the failing test** — create `agent/internal/syscleanup/runner_test.go`:

```go
package syscleanup

import (
	"context"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Plan amendment 9: procoutput.ApplyEnv only sets a C locale when the
// inherited env has NO UTF-8 locale, so on a host with LC_ALL=fr_FR.UTF-8 it
// is a no-op and every parser in this package silently misses. cLocaleEnv must
// OVERRIDE, not append-if-absent.
func TestCLocaleEnvOverridesAnInheritedLocale(t *testing.T) {
	got := cLocaleEnv([]string{
		"PATH=/usr/bin",
		"LC_ALL=fr_FR.UTF-8",
		"LANG=de_DE.UTF-8",
		"LC_MESSAGES=ja_JP.UTF-8",
		"LC_NUMERIC=nl_NL.UTF-8",
		"LC_CTYPE=pt_BR.UTF-8",
		"HOME=/root",
	})
	joined := strings.Join(got, "\n")
	for _, want := range []string{"LC_ALL=C", "LANG=C", "LC_MESSAGES=C", "LC_NUMERIC=C", "LC_CTYPE=C"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("cLocaleEnv() missing %q; got %v", want, got)
		}
	}
	for _, unwanted := range []string{"fr_FR", "de_DE", "ja_JP", "nl_NL", "pt_BR"} {
		if strings.Contains(joined, unwanted) {
			t.Fatalf("cLocaleEnv() kept the inherited locale %q; got %v", unwanted, got)
		}
	}
	// Non-locale entries survive untouched.
	for _, want := range []string{"PATH=/usr/bin", "HOME=/root"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("cLocaleEnv() dropped %q; got %v", want, got)
		}
	}
}

func TestCLocaleEnvAddsTheVariablesWhenAbsent(t *testing.T) {
	got := cLocaleEnv([]string{"PATH=/usr/bin"})
	if len(got) != 6 {
		t.Fatalf("cLocaleEnv() = %v, want PATH plus the five locale variables", got)
	}
}

// Plan amendment 24 (spec §13 #14): the cap keeps the TAIL. Every parser in
// this package reads a trailing summary line, and the error a human reads in
// outputTail is at the end too — a head-preserving cap throws away exactly the
// bytes that matter on a verbose run.
func TestCapOutputKeepsTheTail(t *testing.T) {
	noise := strings.Repeat("a", maxOutputBytes+5000)
	got := capOutput([]byte(noise + "\nFreed space: 1.2 G"))

	if !strings.HasSuffix(got, "Freed space: 1.2 G") {
		t.Fatalf("capped output must END with the trailing summary; got %q", got[max(0, len(got)-40):])
	}
	if !strings.HasPrefix(got, "[truncated] ") {
		t.Fatalf("a truncated capture must say so at the start; got %q", got[:32])
	}
	if strings.Count(got, "a") > maxOutputBytes {
		t.Fatalf("capped output kept %d payload bytes, want at most %d", strings.Count(got, "a"), maxOutputBytes)
	}
}

func TestCapOutputLeavesShortOutputAlone(t *testing.T) {
	if got := capOutput([]byte("  Freed space: 1.2 G\n")); got != "Freed space: 1.2 G" {
		t.Fatalf("capOutput() = %q, want the trimmed original", got)
	}
}

func TestResolveBinaryPicksTheFirstExistingAbsolutePath(t *testing.T) {
	dir := t.TempDir()
	present := dir + "/present"
	if err := os.WriteFile(present, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	got, ok := resolveBinary(dir+"/missing-one", present, dir+"/missing-two")
	if !ok || got != present {
		t.Fatalf("resolveBinary() = (%q, %v), want (%q, true)", got, ok, present)
	}
	if _, ok := resolveBinary(dir + "/nope"); ok {
		t.Fatal("resolveBinary() found a binary that does not exist")
	}
	// A directory is never a binary.
	if _, ok := resolveBinary(dir); ok {
		t.Fatal("resolveBinary() accepted a directory")
	}
}

func TestRunProcessCapturesExitCodeAndOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell fixture")
	}
	sh, ok := resolveBinary("/bin/sh")
	if !ok {
		t.Skip("/bin/sh not present")
	}
	res := runProcess(context.Background(), 10*time.Second, sh, "-c", "printf out; printf err 1>&2; exit 3")
	if res.ExitCode != 3 {
		t.Fatalf("ExitCode = %d, want 3", res.ExitCode)
	}
	if res.Stdout != "out" || res.Stderr != "err" {
		t.Fatalf("Stdout/Stderr = %q/%q, want \"out\"/\"err\"", res.Stdout, res.Stderr)
	}
	if res.TimedOut {
		t.Fatal("TimedOut set for a process that exited on its own")
	}
}

// A timeout must reach the whole tree, not just the wrapper. The child here
// outlives its parent deliberately; containment is what makes TimedOut
// truthful.
func TestRunProcessTimesOutAndReportsIt(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell fixture")
	}
	sh, ok := resolveBinary("/bin/sh")
	if !ok {
		t.Skip("/bin/sh not present")
	}
	start := time.Now()
	res := runProcess(context.Background(), 200*time.Millisecond, sh, "-c", "sleep 30 & sleep 30")
	if !res.TimedOut {
		t.Fatal("TimedOut = false, want true")
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("runProcess blocked for %s past its 200ms deadline", elapsed)
	}
	if res.Err == nil {
		t.Fatal("a timed-out run must carry an error")
	}
}

func TestRunProcessRefusesARelativeBinary(t *testing.T) {
	res := runProcess(context.Background(), time.Second, "sh", "-c", "true")
	if res.Err == nil {
		t.Fatal("runProcess must refuse a non-absolute binary path")
	}
	if !strings.Contains(res.Err.Error(), "absolute") {
		t.Fatalf("error = %q, want it to name the absolute-path rule", res.Err)
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd agent && go test -race ./internal/syscleanup/...
```

Expected failure: `internal/syscleanup/runner_test.go:18:9: undefined: cLocaleEnv` (and `capOutput`, `maxOutputBytes`, `resolveBinary`, `runProcess`) … `[build failed]`.

- [ ] **Step 3: Implement the logger and the portable tree contract** — create `agent/internal/syscleanup/log.go`:

```go
package syscleanup

import "github.com/breeze-rmm/agent/internal/logging"

// Package logger. Untagged on purpose: runner.go and catalog.go log on every
// platform, so declaring it in a build-tagged file would break the other two
// builds (the mistake internal/patching/log.go documents).
var log = logging.L("syscleanup")
```

Create `agent/internal/syscleanup/process_tree.go`:

```go
package syscleanup

import "os/exec"

// processTree groups a cleaner with the descendants it spawns so a deadline
// terminates the REAL worker rather than only the wrapper that launched it.
// cleanmgr.exe in session 0 is the case that forces this: it hands its work to
// a hidden progress UI and is documented to return early or hang, so the
// runner waits on the whole job object and the leader's exit code is
// informational only (spec §7.2).
//
// Every method is best-effort by contract, exactly as the installer twin in
// internal/remote/tools/software_install_process_tree.go states: a platform
// that cannot contain the tree degrades to killing the direct child rather
// than failing an otherwise healthy cleanup.
type processTree interface {
	// prepare mutates cmd before Start.
	prepare(cmd *exec.Cmd)
	// adopt takes ownership of the process immediately after Start.
	adopt(cmd *exec.Cmd)
	// kill terminates every process in the tree.
	kill(cmd *exec.Cmd)
	// release drops the tree's OS resources WITHOUT terminating anything.
	release()
}
```

Create `agent/internal/syscleanup/process_tree_unix.go`:

```go
//go:build !windows

package syscleanup

import (
	"errors"
	"os/exec"
	"syscall"
)

// unixProcessTree puts the cleaner in its own process group. A descendant that
// reparents to init is unreachable by pid but stays in the group it was born
// into, so signalling the group is what actually reaches it.
type unixProcessTree struct{}

func newProcessTree() processTree { return unixProcessTree{} }

func (unixProcessTree) prepare(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

func (unixProcessTree) adopt(*exec.Cmd) {}

func (unixProcessTree) kill(cmd *exec.Cmd) {
	if cmd.Process == nil || cmd.Process.Pid <= 0 {
		return
	}
	// Setpgid makes the child its own group leader, so its pid IS the group
	// id. SIGKILL rather than a graceful term: the deadline has already
	// elapsed. ESRCH just means the group drained first.
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		log.Warn("failed to terminate cleaner process group after timeout",
			"pid", cmd.Process.Pid, "error", err.Error())
	}
}

func (unixProcessTree) release() {}
```

Create `agent/internal/syscleanup/process_tree_windows.go`:

```go
//go:build windows

package syscleanup

import (
	"os/exec"
	"unsafe"

	"golang.org/x/sys/windows"
)

// windowsProcessTree owns one Job Object per cleaner run. Descendants of a job
// member join the job automatically, so terminating the job on a deadline
// reaches the real worker — which for cleanmgr.exe under the SYSTEM account is
// never the process we started.
//
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is the kernel-enforced backstop the
// installer twin uses: the tree cannot outlive the agent if the agent dies
// mid-cleanup. It is cleared again before the handle is closed on every
// non-timeout path — see release.
type windowsProcessTree struct {
	handle windows.Handle
}

func newProcessTree() processTree {
	handle, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		log.Warn("cleaner job object unavailable; a timeout will terminate the leader only",
			"error", err.Error())
		return &windowsProcessTree{}
	}
	if err := setJobKillOnClose(handle, true); err != nil {
		_ = windows.CloseHandle(handle)
		log.Warn("cleaner job object could not be configured; a timeout will terminate the leader only",
			"error", err.Error())
		return &windowsProcessTree{}
	}
	return &windowsProcessTree{handle: handle}
}

func setJobKillOnClose(handle windows.Handle, kill bool) error {
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	if kill {
		info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	}
	_, err := windows.SetInformationJobObject(
		handle,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	)
	return err
}

func (t *windowsProcessTree) prepare(*exec.Cmd) {}

func (t *windowsProcessTree) adopt(cmd *exec.Cmd) {
	if t.handle == 0 || cmd.Process == nil {
		return
	}
	// os/exec does not expose the child's handle, so it is reopened by pid.
	process, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		log.Warn("could not open cleaner process for job assignment; a timeout will terminate the leader only",
			"pid", cmd.Process.Pid, "error", err.Error())
		return
	}
	defer func() { _ = windows.CloseHandle(process) }()

	if err := windows.AssignProcessToJobObject(t.handle, process); err != nil {
		// A process already inside a job that forbids breakaway cannot join a
		// second one — the RDS constraint #2536 documents. Degrading costs the
		// tree kill; failing would cost the cleanup itself on every such host.
		log.Warn("cleaner not assigned to job object; a timeout will terminate the leader only",
			"pid", cmd.Process.Pid, "error", err.Error())
	}
}

func (t *windowsProcessTree) kill(*exec.Cmd) {
	if t.handle == 0 {
		return
	}
	if err := windows.TerminateJobObject(t.handle, 1); err != nil {
		log.Warn("failed to terminate cleaner job object after timeout", "error", err.Error())
	}
}

// release relinquishes ownership WITHOUT signalling. KILL_ON_JOB_CLOSE is
// cleared FIRST, and that order is the whole point: closing the handle with
// the flag still set would kill exactly the descendants a normally-completed
// cleanup legitimately left running. If the flag cannot be cleared we LEAK the
// handle rather than close it — one kernel handle versus taking those
// descendants down.
func (t *windowsProcessTree) release() {
	if t.handle == 0 {
		return
	}
	if err := setJobKillOnClose(t.handle, false); err != nil {
		log.Warn("could not clear cleaner job kill-on-close; retaining the handle", "error", err.Error())
		t.handle = 0
		return
	}
	_ = windows.CloseHandle(t.handle)
	t.handle = 0
}
```

- [ ] **Step 4: Implement the runner** — create `agent/internal/syscleanup/runner.go`:

```go
package syscleanup

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/breeze-rmm/agent/internal/procoutput"
)

// maxOutputBytes caps each captured stream. Cleaner output is a few lines of
// summary; anything larger is a runaway that must not ride a command result
// back to the API (spec §7.1).
const maxOutputBytes = 16 * 1024

// localeVariables are stripped and re-set to C before every parsed cleaner
// runs. DISM gets /English instead (its output ignores the POSIX locale).
var localeVariables = []string{"LC_ALL", "LANG", "LC_CTYPE", "LC_MESSAGES", "LC_NUMERIC"}

// cLocaleEnv pins the child's output locale to C.
//
// NOT procoutput.ApplyEnv: that helper only APPENDS a C.UTF-8 locale when the
// inherited environment has no UTF-8 locale at all, so on a host with
// LC_ALL=fr_FR.UTF-8 it is a no-op, apt/dnf/journalctl emit French, and every
// parser in this package falls back to estimateKnown:false with no visible
// cause. Overriding is the only behaviour that makes the parsers deterministic.
func cLocaleEnv(base []string) []string {
	out := make([]string, 0, len(base)+len(localeVariables))
	for _, entry := range base {
		key, _, ok := strings.Cut(entry, "=")
		if ok && containsFold(localeVariables, key) {
			continue
		}
		out = append(out, entry)
	}
	for _, name := range localeVariables {
		out = append(out, name+"=C")
	}
	return out
}

func containsFold(list []string, value string) bool {
	for _, entry := range list {
		if strings.EqualFold(entry, value) {
			return true
		}
	}
	return false
}

// capOutput trims and caps one stream, keeping the TAIL and marking truncation
// so a parser (and a human reading outputTail) can tell a short answer from a
// clipped one.
//
// Tail, not head (spec §13 #14): every parser in this package matches a
// trailing summary line — `Freed space:`, `This operation would free
// approximately`, `Archived and active journals take up` — and a failing
// cleaner puts its error last as well. Keeping the first 16 KiB of a chatty
// `apt-get clean` or a DISM progress bar discards precisely the bytes the
// estimate and the diagnosis depend on, and does it silently.
func capOutput(b []byte) string {
	text := strings.TrimSpace(procoutput.BytesToUTF8(b))
	if len(text) <= maxOutputBytes {
		return text
	}
	// Cut on a rune boundary so the kept tail is valid UTF-8.
	tail := text[len(text)-maxOutputBytes:]
	for len(tail) > 0 && !utf8.RuneStart(tail[0]) {
		tail = tail[1:]
	}
	return "[truncated] " + strings.TrimSpace(tail)
}

// resolveBinary returns the first candidate that exists and is a regular file.
// Candidates are ABSOLUTE paths from a fixed list — never an exec.LookPath,
// which would let a $PATH entry decide which binary root runs (spec §7.1).
func resolveBinary(candidates ...string) (string, bool) {
	for _, candidate := range candidates {
		if candidate == "" || !filepath.IsAbs(candidate) {
			continue
		}
		info, err := os.Stat(candidate)
		if err != nil || info.IsDir() {
			continue
		}
		return candidate, true
	}
	return "", false
}

// ProcResult is one process invocation's outcome.
type ProcResult struct {
	Path     string
	Args     []string
	Stdout   string
	Stderr   string
	ExitCode int
	Duration time.Duration
	TimedOut bool
	Err      error
}

// lockedBuffer collects a stream safely across the copy goroutines os/exec
// leaves running when Wait returns early. Same reason as the installer twin's.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) Bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]byte(nil), b.buf.Bytes()...)
}

// runProcess executes one cleaner with a deadline, a C locale, capped streams
// and process-TREE containment.
//
// It never uses a shell, never resolves through $PATH, and refuses a
// non-absolute path outright — the last line of defence behind the closed
// catalogue and the server-side id validation.
func runProcess(ctx context.Context, timeout time.Duration, path string, args ...string) ProcResult {
	started := time.Now()
	result := ProcResult{Path: path, Args: args}
	if !filepath.IsAbs(path) {
		result.Err = fmt.Errorf("refusing to run %q: cleaner binaries must be an absolute path", path)
		result.ExitCode = 1
		result.Duration = time.Since(started)
		return result
	}

	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, path, args...)
	cmd.Env = cLocaleEnv(os.Environ())

	var stdout, stderr lockedBuffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	// Without WaitDelay, Wait blocks on pipe EOF until every descendant exits
	// — which for cleanmgr's hidden session-0 UI can be well past the deadline.
	cmd.WaitDelay = 30 * time.Second

	tree := newProcessTree()
	defer tree.release()
	tree.prepare(cmd)

	if err := cmd.Start(); err != nil {
		result.Err = err
		result.ExitCode = 1
		result.Duration = time.Since(started)
		return result
	}
	tree.adopt(cmd)
	waitErr := cmd.Wait()

	result.Stdout = capOutput(stdout.Bytes())
	result.Stderr = capOutput(stderr.Bytes())
	result.Duration = time.Since(started)

	var exitErr *exec.ExitError
	switch {
	case waitErr == nil:
		result.ExitCode = 0
	case errors.As(waitErr, &exitErr):
		result.ExitCode = exitErr.ExitCode()
	case errors.Is(waitErr, exec.ErrWaitDelay):
		// The leader exited; only abandoned descendants held the pipes.
		if cmd.ProcessState != nil {
			result.ExitCode = cmd.ProcessState.ExitCode()
		}
	default:
		result.ExitCode = 1
		result.Err = waitErr
	}

	if runCtx.Err() == context.DeadlineExceeded {
		result.TimedOut = true
		tree.kill(cmd)
		result.Err = fmt.Errorf("%s timed out after %s and its process tree was terminated",
			filepath.Base(path), timeout)
	}
	return result
}
```

- [ ] **Step 5: Run it and watch it pass**

```bash
cd agent && go test -race ./internal/syscleanup/...
```

Expected: `ok github.com/breeze-rmm/agent/internal/syscleanup` — 12 tests.

- [ ] **Step 6: Prove the Windows and macOS builds compile and vet clean**

```bash
cd agent && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go vet ./internal/syscleanup/... \
  && GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go vet ./internal/syscleanup/...
```

Expected: no output from either (both are hard CI gates — `scripts/check-windows-vet.sh` and the darwin cross-vet step in `.github/workflows/ci.yml`).

- [ ] **Step 7: Commit**

```bash
git add agent/internal/syscleanup/runner.go agent/internal/syscleanup/runner_test.go agent/internal/syscleanup/process_tree.go agent/internal/syscleanup/process_tree_windows.go agent/internal/syscleanup/process_tree_unix.go agent/internal/syscleanup/log.go
git commit -m "$(cat <<'MSG'
feat(agent): syscleanup common runner with tree containment and a pinned locale

Absolute binaries only (a relative path is refused outright), no shell,
exec.CommandContext with a per-action deadline, 16 KiB per-stream caps, and
process-TREE containment — a Windows job object with KILL_ON_JOB_CLOSE, a POSIX
process group — so a deadline reaches cleanmgr's hidden session-0 worker rather
than the wrapper we started.

cLocaleEnv OVERRIDES the inherited locale instead of appending one when absent,
which is what procoutput.ApplyEnv does: on a host with LC_ALL=fr_FR.UTF-8 that
helper is a no-op and every parser here would silently miss.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
)"
```

---

### Task 2b: The process-wide maintenance lock

Spec §13 #4/#12. Two `system_cleanup_run` commands, or one of them and a patch job's debounced `brew cleanup`, can otherwise interleave: on Windows the second run rewrites `StateFlags5555` under the first one's feet and `/sagerun:5555` then executes the *other* run's selection; on macOS two `brew cleanup --prune=all` processes mutate the Cellar concurrently, which Homebrew does not promise is safe.

**Files:**
- Create: `agent/internal/maintenance/lock.go`
- Create: `agent/internal/maintenance/lock_test.go` (Test)

**Interfaces:**
- Consumes: nothing. A LEAF package by requirement — both `syscleanup` and `patching` import it, so it may import neither (plan amendment 22).
- Produces:
  ```go
  var ErrBusy = errors.New("another maintenance operation is already running")
  func TryAcquire(owner string) (release func(), err error)
  func Acquire(ctx context.Context, owner string) (release func(), err error)
  func CurrentOwner() string
  ```

- [ ] **Step 1: Write the failing test** — create `agent/internal/maintenance/lock_test.go`:

```go
package maintenance

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestTryAcquireIsExclusiveAndReleasable(t *testing.T) {
	release, err := TryAcquire("system_cleanup_run")
	if err != nil {
		t.Fatalf("first TryAcquire failed: %v", err)
	}
	if got := CurrentOwner(); got != "system_cleanup_run" {
		t.Fatalf("CurrentOwner() = %q", got)
	}

	if _, err := TryAcquire("brew_cleanup"); !errors.Is(err, ErrBusy) {
		t.Fatalf("second TryAcquire err = %v, want ErrBusy", err)
	}

	release()
	if got := CurrentOwner(); got != "" {
		t.Fatalf("CurrentOwner() after release = %q, want empty", got)
	}
	second, err := TryAcquire("brew_cleanup")
	if err != nil {
		t.Fatalf("TryAcquire after release failed: %v", err)
	}
	second()
}

// Double release must be harmless: every caller uses `defer release()` and
// some also release early on a branch.
func TestReleaseIsIdempotent(t *testing.T) {
	release, err := TryAcquire("a")
	if err != nil {
		t.Fatal(err)
	}
	release()
	release()
	other, err := TryAcquire("b")
	if err != nil {
		t.Fatalf("lock was not free after a double release: %v", err)
	}
	other()
}

// The patch-job path WAITS (its cleanup is best-effort background work);
// the command path does not (a tech is watching a spinner).
func TestAcquireWaitsAndHonoursContextCancellation(t *testing.T) {
	release, err := TryAcquire("holder")
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := Acquire(ctx, "waiter"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Acquire err = %v, want context.DeadlineExceeded", err)
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		got, err := Acquire(context.Background(), "waiter")
		if err != nil {
			t.Errorf("Acquire after release failed: %v", err)
			return
		}
		got()
	}()
	release()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Acquire did not proceed after the holder released")
	}
}

func TestConcurrentTryAcquireAdmitsExactlyOne(t *testing.T) {
	var wg sync.WaitGroup
	var mu sync.Mutex
	admitted := 0
	releases := make([]func(), 0, 8)

	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			release, err := TryAcquire("racer")
			if err != nil {
				return
			}
			mu.Lock()
			admitted++
			releases = append(releases, release)
			mu.Unlock()
		}()
	}
	wg.Wait()
	if admitted != 1 {
		t.Fatalf("%d goroutines acquired the lock, want exactly 1", admitted)
	}
	for _, release := range releases {
		release()
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd agent && go test -race ./internal/maintenance/...
```

Expected failure: `internal/maintenance/lock_test.go:12:19: undefined: TryAcquire` … `[build failed]`.

- [ ] **Step 3: Implement** — create `agent/internal/maintenance/lock.go`:

```go
// Package maintenance holds the agent's single process-wide lock for
// long-running OS maintenance (Disk Cleanup v2, spec §13 #4/#12).
//
// It exists because the operations it guards are not merely slow, they
// interfere:
//
//   - Windows Disk Cleanup is driven by a SHARED registry profile
//     (StateFlags5555). Two concurrent runs both rewrite it before invoking
//     `cleanmgr /sagerun:5555`, and whichever wrote last decides what BOTH
//     runs execute — a tech who selected "Setup Log Files" can silently get
//     "Previous Installations" because another session started a run a second
//     earlier.
//   - DISM refuses to service the same image twice and returns an unhelpful
//     error, so the second run looks like a failure rather than a conflict.
//   - Homebrew does not guarantee that `brew cleanup --prune=all` is safe
//     concurrently with another cleanup or with an in-flight upgrade.
//
// A LEAF package with no internal imports: both internal/syscleanup and
// internal/patching depend on it, so any import back into either would be a
// cycle.
package maintenance

import (
	"context"
	"errors"
	"sync"
)

// ErrBusy is returned by TryAcquire when another operation holds the lock.
// Callers surface it as a `busy` action status rather than a failure: nothing
// was attempted, and a retry is the right next step.
var ErrBusy = errors.New("another maintenance operation is already running")

var (
	mu     sync.Mutex
	locked bool
	owner  string
	// waiters is signalled on every release so Acquire can re-check without
	// polling. A condition variable rather than a channel because the lock is
	// held by a plain bool under `mu` and Cond is the shape that fits.
	waiters = sync.NewCond(&mu)
)

// TryAcquire takes the lock or fails immediately with ErrBusy.
//
// The command path uses this: a tech is watching a spinner, and "something
// else is running maintenance, try again shortly" is a better answer than an
// unbounded wait inside a two-hour command budget.
//
// The returned release is idempotent — callers `defer release()` and some also
// release early on a branch.
func TryAcquire(ownerName string) (func(), error) {
	mu.Lock()
	defer mu.Unlock()
	if locked {
		return nil, ErrBusy
	}
	locked = true
	owner = ownerName
	return releaser(), nil
}

// Acquire waits for the lock, or for ctx to be done.
//
// The patch-job Homebrew cleanup uses this: it is debounced background work
// with no user waiting on it, so queueing behind a cleanup run is strictly
// better than skipping the cleanup entirely.
func Acquire(ctx context.Context, ownerName string) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	// Wake the Cond when ctx is done so a waiter cannot block past its
	// deadline; the re-check below then observes ctx.Err().
	stop := context.AfterFunc(ctx, func() {
		mu.Lock()
		waiters.Broadcast()
		mu.Unlock()
	})
	defer stop()

	mu.Lock()
	defer mu.Unlock()
	for locked {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		waiters.Wait()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	locked = true
	owner = ownerName
	return releaser(), nil
}

// CurrentOwner names the holder, or "" when the lock is free. For log lines
// and the `busy` status's reason string — never for control flow, since it is
// stale the instant it returns.
func CurrentOwner() string {
	mu.Lock()
	defer mu.Unlock()
	return owner
}

func releaser() func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			mu.Lock()
			locked = false
			owner = ""
			waiters.Broadcast()
			mu.Unlock()
		})
	}
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd agent && go test -race ./internal/maintenance/...
```

Expected: `ok github.com/breeze-rmm/agent/internal/maintenance` — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/maintenance/lock.go agent/internal/maintenance/lock_test.go
git commit -m "$(cat <<'MSG'
feat(agent): process-wide maintenance lock for OS cleanup and brew cleanup

The operations this guards do not merely contend, they interfere. Windows Disk
Cleanup is driven by a SHARED registry profile: two concurrent runs both
rewrite StateFlags5555 before invoking /sagerun:5555, and whichever wrote last
decides what BOTH runs execute — a tech who selected "Setup Log Files" can
silently get "Previous Installations".

TryAcquire for the command path (a tech is watching a spinner, so `busy` beats
an unbounded wait inside the run budget) and Acquire for the debounced patch-job
brew cleanup (background work with nobody waiting, so queueing beats skipping).

A leaf package: syscleanup and patching both import it, so it imports neither.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
)"
```

---

### Task 3: Measured free-space deltas

**Files:**
- Create: `agent/internal/syscleanup/volumes.go`
- Create: `agent/internal/syscleanup/volumes_test.go` (Test)

**Interfaces:**
- Consumes: `github.com/shirou/gopsutil/v3/disk` (`disk.Usage`, `disk.Partitions`) — already in `agent/go.mod` (`v3.24.5`) and used the same way at `agent/internal/collectors/inventory.go:78`.
- Produces:
  ```go
  type VolumeFree struct {
      Mount     string `json:"mount"`
      FreeBytes int64  `json:"freeBytes"`
  }
  type VolumeDelta struct {
      Mount      string `json:"mount"`
      FreeBefore int64  `json:"freeBefore"`
      FreeAfter  int64  `json:"freeAfter"`
  }
  var usageFreeFn = func(mount string) (int64, error) { … }   // test seam
  func fixedVolumes() []string
  func sampleVolumes(mounts []string) []VolumeFree
  func measureFreed(before, after []VolumeFree) ([]VolumeDelta, int64)
  ```

- [ ] **Step 1: Write the failing test** — create `agent/internal/syscleanup/volumes_test.go`:

```go
package syscleanup

import (
	"errors"
	"testing"
)

// Freed bytes are MEASURED, never estimated (spec §7.1): the sum over affected
// volumes of free-after minus free-before, floored at 0.
func TestMeasureFreedSumsPositiveDeltasOnly(t *testing.T) {
	before := []VolumeFree{{Mount: "/", FreeBytes: 1_000}, {Mount: "/data", FreeBytes: 500}}
	after := []VolumeFree{{Mount: "/", FreeBytes: 4_000}, {Mount: "/data", FreeBytes: 500}}

	deltas, freed := measureFreed(before, after)
	if freed != 3_000 {
		t.Fatalf("freed = %d, want 3000", freed)
	}
	if len(deltas) != 2 {
		t.Fatalf("len(deltas) = %d, want 2", len(deltas))
	}
	if deltas[0] != (VolumeDelta{Mount: "/", FreeBefore: 1_000, FreeAfter: 4_000}) {
		t.Fatalf("deltas[0] = %+v", deltas[0])
	}
}

// A volume that LOST space during the run (a concurrent download, a log burst)
// must not subtract from the reported total — that would understate the real
// reclamation and, with a large enough write, report a negative number.
func TestMeasureFreedFloorsANegativeDeltaAtZero(t *testing.T) {
	before := []VolumeFree{{Mount: "/", FreeBytes: 1_000}, {Mount: "/data", FreeBytes: 9_000}}
	after := []VolumeFree{{Mount: "/", FreeBytes: 3_000}, {Mount: "/data", FreeBytes: 1_000}}

	deltas, freed := measureFreed(before, after)
	if freed != 2_000 {
		t.Fatalf("freed = %d, want 2000 (the /data regression contributes 0, not -8000)", freed)
	}
	if deltas[1].FreeAfter != 1_000 {
		t.Fatalf("the regression must still be REPORTED per volume; deltas[1] = %+v", deltas[1])
	}
}

// A volume present in one sample and not the other is dropped rather than
// treated as a delta against zero — unmounting a disk mid-run would otherwise
// be reported as reclaiming its entire free space.
func TestMeasureFreedIgnoresAVolumeMissingFromEitherSample(t *testing.T) {
	before := []VolumeFree{{Mount: "/", FreeBytes: 1_000}, {Mount: "/media", FreeBytes: 800_000}}
	after := []VolumeFree{{Mount: "/", FreeBytes: 1_500}}

	deltas, freed := measureFreed(before, after)
	if freed != 500 {
		t.Fatalf("freed = %d, want 500", freed)
	}
	if len(deltas) != 1 || deltas[0].Mount != "/" {
		t.Fatalf("deltas = %+v, want only the volume present in both samples", deltas)
	}
}

func TestSampleVolumesSkipsUnreadableMounts(t *testing.T) {
	original := usageFreeFn
	t.Cleanup(func() { usageFreeFn = original })
	usageFreeFn = func(mount string) (int64, error) {
		if mount == "/broken" {
			return 0, errors.New("permission denied")
		}
		return 42, nil
	}

	got := sampleVolumes([]string{"/", "/broken", "/data"})
	if len(got) != 2 {
		t.Fatalf("sampleVolumes() = %+v, want the two readable mounts", got)
	}
	if got[0].Mount != "/" || got[1].Mount != "/data" || got[0].FreeBytes != 42 {
		t.Fatalf("sampleVolumes() = %+v", got)
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd agent && go test -race ./internal/syscleanup/...
```

Expected failure: `internal/syscleanup/volumes_test.go:11:12: undefined: VolumeFree` … `[build failed]`.

- [ ] **Step 3: Implement** — create `agent/internal/syscleanup/volumes.go`:

```go
package syscleanup

import (
	"sort"
	"strings"

	"github.com/shirou/gopsutil/v3/disk"
)

// VolumeFree is one volume's free space at a point in time.
type VolumeFree struct {
	Mount     string `json:"mount"`
	FreeBytes int64  `json:"freeBytes"`
}

// VolumeDelta is one volume's free space either side of a run (spec §7.3).
type VolumeDelta struct {
	Mount      string `json:"mount"`
	FreeBefore int64  `json:"freeBefore"`
	FreeAfter  int64  `json:"freeAfter"`
}

// usageFreeFn is disk.Usage's free field, indirected so measurement can be
// tested without a real filesystem. Mirrors the partitionsFn seam in
// internal/collectors/inventory.go.
var usageFreeFn = func(mount string) (int64, error) {
	usage, err := disk.Usage(mount)
	if err != nil {
		return 0, err
	}
	return int64(usage.Free), nil
}

var partitionsFn = disk.Partitions

// nonMeasurableFsTypes never carry reclaimable space, and sampling them costs
// a syscall per action. Kept deliberately short: a volume wrongly included only
// contributes a zero delta, while one wrongly excluded silently under-reports.
var nonMeasurableFsTypes = []string{
	"squashfs", "tmpfs", "devtmpfs", "devfs", "overlay", "iso9660", "udf", "cdfs", "proc", "sysfs", "autofs",
}

// fixedVolumes lists the mount points worth measuring on this host.
//
// Errors are swallowed to a partial list on purpose: gopsutil's Windows
// implementation returns the drives it DID enumerate alongside a non-fatal
// warnings aggregate (an empty card reader is enough to populate it), so
// treating any error as fatal would report zero volumes on a healthy machine —
// the same trap CollectDisks documents.
func fixedVolumes() []string {
	partitions, err := partitionsFn(false)
	if err != nil && len(partitions) == 0 {
		log.Warn("could not enumerate volumes for cleanup measurement", "error", err.Error())
		return nil
	}
	seen := make(map[string]bool, len(partitions))
	mounts := make([]string, 0, len(partitions))
	for _, partition := range partitions {
		if partition.Mountpoint == "" || seen[partition.Mountpoint] {
			continue
		}
		skip := false
		for _, fsType := range nonMeasurableFsTypes {
			if strings.HasPrefix(strings.ToLower(partition.Fstype), fsType) {
				skip = true
				break
			}
		}
		if skip {
			continue
		}
		seen[partition.Mountpoint] = true
		mounts = append(mounts, partition.Mountpoint)
	}
	sort.Strings(mounts)
	return mounts
}

// sampleVolumes reads free space for each mount, skipping the ones that cannot
// be read rather than failing the whole measurement.
func sampleVolumes(mounts []string) []VolumeFree {
	out := make([]VolumeFree, 0, len(mounts))
	for _, mount := range mounts {
		free, err := usageFreeFn(mount)
		if err != nil {
			log.Debug("volume unreadable during cleanup measurement", "mount", mount, "error", err.Error())
			continue
		}
		out = append(out, VolumeFree{Mount: mount, FreeBytes: free})
	}
	return out
}

// measureFreed pairs two samples by mount point.
//
// Two deliberate asymmetries:
//   - a NEGATIVE delta contributes 0 to the total but is still reported per
//     volume. A concurrent download during a 90-minute DISM run must not turn
//     a real reclamation into a smaller — or negative — headline number, and
//     hiding the regression entirely would make the headline unexplainable.
//   - a mount present in only one sample is dropped. Unmounting a disk
//     mid-run would otherwise read as reclaiming all of its free space.
func measureFreed(before, after []VolumeFree) ([]VolumeDelta, int64) {
	afterByMount := make(map[string]int64, len(after))
	for _, volume := range after {
		afterByMount[volume.Mount] = volume.FreeBytes
	}

	deltas := make([]VolumeDelta, 0, len(before))
	var freed int64
	for _, volume := range before {
		freeAfter, ok := afterByMount[volume.Mount]
		if !ok {
			continue
		}
		deltas = append(deltas, VolumeDelta{
			Mount:      volume.Mount,
			FreeBefore: volume.FreeBytes,
			FreeAfter:  freeAfter,
		})
		if delta := freeAfter - volume.FreeBytes; delta > 0 {
			freed += delta
		}
	}
	return deltas, freed
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd agent && go test -race ./internal/syscleanup/...
```

Expected: `ok github.com/breeze-rmm/agent/internal/syscleanup` — 16 tests.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/syscleanup/volumes.go agent/internal/syscleanup/volumes_test.go
git commit -m "$(cat <<'MSG'
feat(agent): measured free-space deltas for system cleanup runs

Freed bytes are the sum over affected volumes of free-after minus free-before,
floored at 0 (spec §7.1) — not an estimate. A volume that LOST space during a
90-minute DISM run contributes 0 rather than a negative number, but its
regression is still reported per volume so the headline stays explainable; a
mount missing from either sample is dropped so an unmount is never read as
reclaiming the whole disk.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
)"
```

---

### Task 4: Linux actions — package caches, autoremove, journal vacuum

**Files:**
- Create: `agent/internal/syscleanup/sizes.go`
- Create: `agent/internal/syscleanup/sizes_test.go` (Test)
- Create: `agent/internal/syscleanup/linux.go`
- Create: `agent/internal/syscleanup/linux_test.go` (Test)
- Create: `agent/internal/syscleanup/linux_probe_linux.go`
- Create: `agent/internal/syscleanup/linux_probe_other.go`

**Interfaces:**
- Consumes: `runProcess`, `resolveBinary`, `capOutput` (Task 2); `Action`, `ActionInfo`, `ActionResult`, `Params`, risk/status constants (Task 1).
- Produces:
  ```go
  func parseDecimalSize(text string) (int64, bool)   // apt: "12.3 MB" = 10^6
  func parseBinarySize(text string) (int64, bool)    // dnf/journalctl: "1.2G" = 2^30
  type linuxPackageManager struct{ name, binary string }
  func detectPackageManager() (linuxPackageManager, bool)
  func aptAutoremoveSimulateArgs() []string
  func dnfAutoremoveSimulateArgs() []string
  func packageCleanArgs(pm linuxPackageManager) []string
  func packageAutoremoveArgs(pm linuxPackageManager) []string
  func journalDiskUsageArgs() []string
  func journalVacuumArgs(bytes int64) []string
  func parseAptAutoremovePackages(stdout string) ([]string, bool)
  func dpkgQueryInstalledSizeArgs(packages []string) []string
  func parseDpkgInstalledSizes(stdout string) (int64, bool)
  func parseDnfAutoremoveFreed(stdout string, exitCode int) (int64, bool)
  func parseJournalDiskUsage(stdout string) (int64, bool)
  func linuxActions() []Action   // linux_pkg_cache_clean, linux_pkg_autoremove, linux_journal_vacuum
  func probeWritable(path string) (bool, string)   // real on linux, always-true stub elsewhere
  ```

- [ ] **Step 1: Write the failing size-parser test** — create `agent/internal/syscleanup/sizes_test.go`:

```go
package syscleanup

import "testing"

// apt reports 1000-based units with a two-character suffix ("12.3 MB"); dnf
// and journalctl report 1024-based units with a single letter ("1.2G"). Using
// one parser for both is wrong by 7% at MB and 10% at GB — enough to turn a
// truthful "up to 4.0 GB" into "up to 4.3 GB" on a estimate the UI already
// labels an upper bound.
func TestParseDecimalSizeUsesThousandBasedUnits(t *testing.T) {
	cases := []struct {
		in   string
		want int64
		ok   bool
	}{
		{"0 B", 0, true},
		{"512 B", 512, true},
		{"12.3 kB", 12_300, true},
		{"12.3 MB", 12_300_000, true},
		{"1.5 GB", 1_500_000_000, true},
		{"2 TB", 2_000_000_000_000, true},
		{"12.3MB", 12_300_000, true},
		{"", 0, false},
		{"lots", 0, false},
		{"12.3 QB", 0, false},
		{"MB", 0, false},
	}
	for _, tc := range cases {
		got, ok := parseDecimalSize(tc.in)
		if ok != tc.ok || got != tc.want {
			t.Errorf("parseDecimalSize(%q) = (%d, %v), want (%d, %v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestParseBinarySizeUses1024BasedUnits(t *testing.T) {
	cases := []struct {
		in   string
		want int64
		ok   bool
	}{
		{"0B", 0, true},
		{"512", 512, true},
		{"1.2G", 1_288_490_188, true},
		{"1.2GiB", 1_288_490_188, true},
		{"256M", 268_435_456, true},
		{"4.0K", 4_096, true},
		{"1T", 1_099_511_627_776, true},
		{"", 0, false},
		{"some", 0, false},
		{"1.2Q", 0, false},
	}
	for _, tc := range cases {
		got, ok := parseBinarySize(tc.in)
		if ok != tc.ok || got != tc.want {
			t.Errorf("parseBinarySize(%q) = (%d, %v), want (%d, %v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd agent && go test -race -run 'TestParse(Decimal|Binary)Size' ./internal/syscleanup/...
```

Expected failure: `internal/syscleanup/sizes_test.go:36:13: undefined: parseDecimalSize` … `[build failed]`.

- [ ] **Step 3: Implement the size parsers** — create `agent/internal/syscleanup/sizes.go`:

```go
package syscleanup

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Two size grammars, because the tools genuinely differ:
//
//   - apt's SizeToStr emits 1000-based units with a two-character suffix
//     ("After this operation, 12.3 MB disk space will be freed.").
//   - dnf's and journalctl's formatters emit 1024-based units with a single
//     letter, optionally followed by i/B ("Freed space: 1.2 G",
//     "…take up 1.2G in the file system.").
//
// Parsing one with the other's base is a silent 7% error at MB and 10% at GB.

var decimalSizePattern = regexp.MustCompile(`^([0-9]+(?:[.,][0-9]+)?)\s*([kKMGTP]?B)$`)
var binarySizePattern = regexp.MustCompile(`^([0-9]+(?:[.,][0-9]+)?)\s*([KkMGTP]?)(?:i?B?)$`)

var decimalUnitFactor = map[string]float64{
	"B": 1, "kB": 1e3, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12, "PB": 1e15,
}

var binaryUnitFactor = map[string]float64{
	"": 1, "K": 1 << 10, "k": 1 << 10, "M": 1 << 20, "G": 1 << 30, "T": 1 << 40, "P": 1 << 50,
}

func parseSizeWith(text string, pattern *regexp.Regexp, factors map[string]float64, unitGroup int) (int64, bool) {
	match := pattern.FindStringSubmatch(strings.TrimSpace(text))
	if match == nil {
		return 0, false
	}
	amount, err := strconv.ParseFloat(strings.Replace(match[1], ",", ".", 1), 64)
	if err != nil || math.IsNaN(amount) || math.IsInf(amount, 0) || amount < 0 {
		return 0, false
	}
	factor, ok := factors[match[unitGroup]]
	if !ok {
		return 0, false
	}
	bytes := amount * factor
	if bytes > float64(math.MaxInt64) {
		return 0, false
	}
	return int64(math.Round(bytes)), true
}

// parseDecimalSize reads apt's 1000-based sizes ("12.3 MB").
func parseDecimalSize(text string) (int64, bool) {
	return parseSizeWith(text, decimalSizePattern, decimalUnitFactor, 2)
}

// parseBinarySize reads dnf's and journalctl's 1024-based sizes ("1.2G").
func parseBinarySize(text string) (int64, bool) {
	return parseSizeWith(text, binarySizePattern, binaryUnitFactor, 2)
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd agent && go test -race -run 'TestParse(Decimal|Binary)Size' ./internal/syscleanup/...
```

Expected: `ok github.com/breeze-rmm/agent/internal/syscleanup`.

- [ ] **Step 5: Write the failing Linux action test** — create `agent/internal/syscleanup/linux_test.go`:

```go
package syscleanup

import (
	"strings"
	"testing"
)

// Argv is built from constants. These table tests are the proof that no client
// string can reach one (spec §10 item 7).

func TestPackageCleanArgsPerManager(t *testing.T) {
	cases := []struct {
		pm   linuxPackageManager
		want []string
	}{
		{linuxPackageManager{name: "apt", binary: "/usr/bin/apt-get"}, []string{"clean"}},
		{linuxPackageManager{name: "dnf", binary: "/usr/bin/dnf"}, []string{"clean", "all"}},
		{linuxPackageManager{name: "yum", binary: "/usr/bin/yum"}, []string{"clean", "all"}},
	}
	for _, tc := range cases {
		got := packageCleanArgs(tc.pm)
		if strings.Join(got, " ") != strings.Join(tc.want, " ") {
			t.Errorf("packageCleanArgs(%s) = %v, want %v", tc.pm.name, got, tc.want)
		}
	}
}

func TestPackageAutoremoveArgsPerManager(t *testing.T) {
	cases := []struct {
		pm   linuxPackageManager
		want []string
	}{
		{linuxPackageManager{name: "apt", binary: "/usr/bin/apt-get"}, []string{"-y", "autoremove"}},
		{linuxPackageManager{name: "dnf", binary: "/usr/bin/dnf"}, []string{"-y", "autoremove"}},
		{linuxPackageManager{name: "yum", binary: "/usr/bin/yum"}, []string{"-y", "autoremove"}},
	}
	for _, tc := range cases {
		got := packageAutoremoveArgs(tc.pm)
		if strings.Join(got, " ") != strings.Join(tc.want, " ") {
			t.Errorf("packageAutoremoveArgs(%s) = %v, want %v", tc.pm.name, got, tc.want)
		}
	}
}

func TestAutoremoveSimulationIsNonMutating(t *testing.T) {
	if got := strings.Join(aptAutoremoveSimulateArgs(), " "); got != "-s autoremove" {
		t.Fatalf("aptAutoremoveSimulateArgs() = %q, want \"-s autoremove\"", got)
	}
	if got := strings.Join(dnfAutoremoveSimulateArgs(), " "); got != "--assumeno autoremove" {
		t.Fatalf("dnfAutoremoveSimulateArgs() = %q, want \"--assumeno autoremove\"", got)
	}
	// An estimator that could delete a package would be a catastrophic bug in a
	// LIST call, which the UI presents as read-only.
	for _, args := range [][]string{aptAutoremoveSimulateArgs(), dnfAutoremoveSimulateArgs()} {
		for _, arg := range args {
			if arg == "-y" || arg == "--assumeyes" {
				t.Fatalf("simulation args %v contain an assume-yes flag", args)
			}
		}
	}
}

// The one bounded integer the client influences is clamped AGAIN here, so a
// forged command payload that bypassed the server's Zod bounds still cannot
// widen it (spec §5.3).
func TestJournalVacuumArgsClampTheRequestedSize(t *testing.T) {
	cases := []struct {
		in   int64
		want string
	}{
		{0, "--vacuum-size=268435456"},                 // default 256 MiB
		{-1, "--vacuum-size=268435456"},
		{64 << 20, "--vacuum-size=67108864"},           // lower bound, allowed
		{(64 << 20) - 1, "--vacuum-size=67108864"},     // clamped up
		{1 << 30, "--vacuum-size=1073741824"},
		{4 << 30, "--vacuum-size=4294967296"},          // upper bound, allowed
		{1 << 60, "--vacuum-size=4294967296"},          // clamped down
	}
	for _, tc := range cases {
		got := journalVacuumArgs(tc.in)
		if len(got) != 1 || got[0] != tc.want {
			t.Errorf("journalVacuumArgs(%d) = %v, want [%q]", tc.in, got, tc.want)
		}
	}
	if got := strings.Join(journalDiskUsageArgs(), " "); got != "--disk-usage" {
		t.Fatalf("journalDiskUsageArgs() = %q", got)
	}
}

// Plan amendment 20 (spec §13 #14): `apt-get -s autoremove` prints NO
// "After this operation" line — that summary belongs to the interactive
// install path. The simulation names the packages on `Remv` lines and the
// size comes from dpkg.
func TestParseAptAutoremovePackages(t *testing.T) {
	const fixture = `NOTE: This is only a simulation!
      apt-get needs root privileges for real execution.
Reading package lists...
Building dependency tree...
The following packages will be REMOVED:
  linux-image-6.1.0-13-amd64 linux-headers-6.1.0-13-amd64
0 upgraded, 0 newly installed, 2 to remove and 0 not upgraded.
Remv linux-image-6.1.0-13-amd64 [6.1.55-1]
Remv linux-headers-6.1.0-13-amd64 [6.1.55-1]
`
	got, ok := parseAptAutoremovePackages(fixture)
	if !ok {
		t.Fatal("the documented -s autoremove shape must parse")
	}
	if strings.Join(got, ",") != "linux-image-6.1.0-13-amd64,linux-headers-6.1.0-13-amd64" {
		t.Fatalf("parseAptAutoremovePackages() = %v", got)
	}
}

// Nothing to remove: a KNOWN empty plan, which the caller turns into a known 0.
func TestParseAptAutoremovePackagesOnAnEmptyPlan(t *testing.T) {
	const fixture = `Reading package lists...
Building dependency tree...
0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.
`
	got, ok := parseAptAutoremovePackages(fixture)
	if !ok || len(got) != 0 {
		t.Fatalf("parseAptAutoremovePackages() = (%v, %v), want ([], true)", got, ok)
	}
}

// A shape the parser does not recognise must be UNKNOWN, never 0 (spec §7.1).
func TestParseAptAutoremovePackagesOnUnparseableOutput(t *testing.T) {
	if _, ok := parseAptAutoremovePackages("E: Could not open lock file\n"); ok {
		t.Fatal("unparseable apt output must be estimateKnown:false, not an empty plan")
	}
}

// A package name is passed straight back as an argv token to dpkg-query, so
// anything that is not a valid Debian package name is dropped rather than
// escaped.
func TestParseAptAutoremovePackagesRejectsHostileNames(t *testing.T) {
	const hostile = `Remv good-package [1.0]
Remv ../../etc/passwd [1.0]
Remv ; rm -rf / [1.0]
Remv --force-all [1.0]
`
	got, _ := parseAptAutoremovePackages(hostile)
	if strings.Join(got, ",") != "good-package" {
		t.Fatalf("parseAptAutoremovePackages() = %v, want only the well-formed name", got)
	}
}

// dpkg reports Installed-Size in KiB.
func TestParseDpkgInstalledSizes(t *testing.T) {
	got, ok := parseDpkgInstalledSizes("402000\n10240\n\n")
	if !ok || got != (402_000+10_240)*1024 {
		t.Fatalf("parseDpkgInstalledSizes() = (%d, %v), want (%d, true)", got, ok, (402_000+10_240)*1024)
	}
	if _, ok := parseDpkgInstalledSizes("dpkg-query: no packages found\n"); ok {
		t.Fatal("a dpkg error body must be unknown, not 0")
	}
	if got, ok := parseDpkgInstalledSizes(""); !ok || got != 0 {
		t.Fatalf("empty output for an empty package list = (%d, %v), want (0, true)", got, ok)
	}
}

func TestDpkgQueryArgs(t *testing.T) {
	got := dpkgQueryInstalledSizeArgs([]string{"a", "b"})
	want := []string{"-W", "-f=${Installed-Size}\n", "a", "b"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("dpkgQueryInstalledSizeArgs() = %v, want %v", got, want)
	}
}

// dnf exits NON-ZERO when it aborts under --assumeno. The estimator accepts
// exit 1 as long as the summary parses (spec §7.2).
func TestParseDnfAutoremoveFreedAcceptsTheAbortExit(t *testing.T) {
	const fixture = `Dependencies resolved.
================================================================================
 Package          Arch     Version              Repository            Size
================================================================================
Removing:
 kernel-core      x86_64   6.5.6-200.fc38       @updates             112 M
Transaction Summary
================================================================================
Remove  1 Package

Freed space: 1.2 G
Operation aborted.
`
	got, ok := parseDnfAutoremoveFreed(fixture, 1)
	if !ok || got != 1_288_490_188 {
		t.Fatalf("parseDnfAutoremoveFreed(exit 1) = (%d, %v), want (1288490188, true)", got, ok)
	}
	if _, ok := parseDnfAutoremoveFreed(fixture, 0); !ok {
		t.Fatal("exit 0 with a parsable summary must also be accepted")
	}
}

// dnf5 (Fedora 41+) changed the summary shape. Until a fixture is added it is
// honestly unknown (spec §7.2) — not silently zero.
func TestParseDnfAutoremoveFreedOnDnf5Output(t *testing.T) {
	const dnf5 = `Remove 3 Packages
Total size of inbound packages is 0 B. Need to download 0 B.
After this operation 145 MiB extra will be freed.
`
	if _, ok := parseDnfAutoremoveFreed(dnf5, 1); ok {
		t.Fatal("the dnf5 summary shape must report estimateKnown:false until a fixture is added")
	}
}

func TestParseJournalDiskUsage(t *testing.T) {
	cases := []struct {
		in   string
		want int64
		ok   bool
	}{
		{"Archived and active journals take up 1.2G in the file system.\n", 1_288_490_188, true},
		{"Archived and active journals take up 984.0M in the file system.\n", 1_031_798_784, true},
		{"Journals take up 512M in the file system.\n", 536_870_912, true},
		{"Failed to determine disk usage: Permission denied\n", 0, false},
		{"", 0, false},
	}
	for _, tc := range cases {
		got, ok := parseJournalDiskUsage(tc.in)
		if ok != tc.ok || got != tc.want {
			t.Errorf("parseJournalDiskUsage(%q) = (%d, %v), want (%d, %v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

// The journal estimate is current usage MINUS the vacuum target, floored at 0
// — and it is an UPPER bound because only ARCHIVED journals are vacuumed
// (spec §7.2).
func TestJournalVacuumEstimateIsTheFlooredDifference(t *testing.T) {
	cases := []struct{ usage, target, want int64 }{
		{1_288_490_188, 268_435_456, 1_020_054_732},
		{100_000, 268_435_456, 0},
		{268_435_456, 268_435_456, 0},
	}
	for _, tc := range cases {
		if got := journalVacuumEstimate(tc.usage, tc.target); got != tc.want {
			t.Errorf("journalVacuumEstimate(%d, %d) = %d, want %d", tc.usage, tc.target, got, tc.want)
		}
	}
}

func TestLinuxActionsDeclareTheirRiskFlags(t *testing.T) {
	byID := map[string]ActionInfo{}
	for _, action := range linuxActions() {
		byID[action.ID()] = action.Describe()
	}
	for _, id := range []string{"linux_pkg_cache_clean", "linux_pkg_autoremove", "linux_journal_vacuum"} {
		info, ok := byID[id]
		if !ok {
			t.Fatalf("linuxActions() is missing %q", id)
		}
		if info.OS != "linux" {
			t.Errorf("%s: OS = %q, want linux", id, info.OS)
		}
		if info.Label == "" || info.Description == "" {
			t.Errorf("%s: label/description must be non-empty", id)
		}
	}
	// removes_packages is what gates the confirm dialog's second checkbox
	// (spec §7.2, §8). Only autoremove carries it.
	if !containsFold(byID["linux_pkg_autoremove"].RiskFlags, RiskRemovesPackages) {
		t.Error("linux_pkg_autoremove must carry the removes_packages risk flag")
	}
	for _, id := range []string{"linux_pkg_cache_clean", "linux_journal_vacuum"} {
		if containsFold(byID[id].RiskFlags, RiskRemovesPackages) {
			t.Errorf("%s must not carry removes_packages", id)
		}
	}
}
```

- [ ] **Step 6: Run it and watch it fail**

```bash
cd agent && go test -race ./internal/syscleanup/...
```

Expected failure: `internal/syscleanup/linux_test.go:16:8: undefined: linuxPackageManager` … `[build failed]`.

- [ ] **Step 7: Implement the Linux write probe (two builds)** — create `agent/internal/syscleanup/linux_probe_linux.go`:

```go
//go:build linux

package syscleanup

import (
	"fmt"
	"golang.org/x/sys/unix"
)

// probeWritable reports whether this process can write inside path.
//
// Spec §7.2: defence in depth for self-hosters who harden the systemd unit
// themselves. Verified 2026-09-19 that the shipped agent unit
// (agent/internal/agentapp/systemd_unit.go, agent/service/systemd/
// breeze-agent.service) carries no ProtectSystem / ReadWritePaths — only the
// WATCHDOG unit is ProtectSystem=strict — so this is not a known blocker, and
// reporting the reason is more useful than failing mid-run with EROFS.
func probeWritable(path string) (bool, string) {
	if err := unix.Access(path, unix.W_OK); err != nil {
		return false, fmt.Sprintf("sandbox denies write to %s", path)
	}
	return true, ""
}
```

Create `agent/internal/syscleanup/linux_probe_other.go`:

```go
//go:build !linux

package syscleanup

// probeWritable is Linux-only; the Linux actions are never constructed
// elsewhere, so this stub exists purely so linux.go stays untagged and its
// argv builders and parsers are exercised by `go test ./...` on every runner.
func probeWritable(string) (bool, string) { return true, "" }
```

- [ ] **Step 8: Implement the Linux actions** — create `agent/internal/syscleanup/linux.go`:

```go
package syscleanup

import (
	"context"
	"fmt"
	"io/fs"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Bounds for the one client-influenced integer. Mirrored by
// packages/shared/src/validators/systemCleanup.ts; clamped again here so a
// forged command payload cannot widen them (spec §5.3, §10 item 7).
const (
	journalVacuumDefaultBytes int64 = 256 << 20
	journalVacuumMinBytes     int64 = 64 << 20
	journalVacuumMaxBytes     int64 = 4 << 30
)

const (
	linuxPkgCleanTimeout      = 5 * time.Minute
	linuxAutoremoveTimeout    = 15 * time.Minute
	linuxJournalVacuumTimeout = 5 * time.Minute
	linuxEstimateTimeout      = 60 * time.Second
)

// linuxPackageManager is the first supported manager present on the host.
type linuxPackageManager struct {
	name   string // apt | dnf | yum
	binary string // absolute path
	cache  string // cache directory, used for the estimate and the write probe
}

var linuxPackageManagerCandidates = []linuxPackageManager{
	{name: "apt", binary: "/usr/bin/apt-get", cache: "/var/cache/apt/archives"},
	{name: "dnf", binary: "/usr/bin/dnf", cache: "/var/cache/dnf"},
	{name: "yum", binary: "/usr/bin/yum", cache: "/var/cache/yum"},
}

const journalctlBinary = "/usr/bin/journalctl"
const journalDirectory = "/var/log/journal"
const dpkgQueryBinary = "/usr/bin/dpkg-query"

// detectPackageManager returns the first candidate whose binary exists. Order
// is apt, dnf, yum — the spec's "first present" (§7.2).
func detectPackageManager() (linuxPackageManager, bool) {
	for _, candidate := range linuxPackageManagerCandidates {
		if path, ok := resolveBinary(candidate.binary); ok {
			candidate.binary = path
			return candidate, true
		}
	}
	return linuxPackageManager{}, false
}

func packageCleanArgs(pm linuxPackageManager) []string {
	if pm.name == "apt" {
		return []string{"clean"}
	}
	return []string{"clean", "all"}
}

func packageAutoremoveArgs(linuxPackageManager) []string { return []string{"-y", "autoremove"} }

func aptAutoremoveSimulateArgs() []string { return []string{"-s", "autoremove"} }

func dnfAutoremoveSimulateArgs() []string { return []string{"--assumeno", "autoremove"} }

func journalDiskUsageArgs() []string { return []string{"--disk-usage"} }

// clampJournalVacuumBytes is the agent-side half of the bound.
func clampJournalVacuumBytes(requested int64) int64 {
	if requested <= 0 {
		return journalVacuumDefaultBytes
	}
	if requested < journalVacuumMinBytes {
		return journalVacuumMinBytes
	}
	if requested > journalVacuumMaxBytes {
		return journalVacuumMaxBytes
	}
	return requested
}

func journalVacuumArgs(requested int64) []string {
	return []string{fmt.Sprintf("--vacuum-size=%d", clampJournalVacuumBytes(requested))}
}

// journalVacuumEstimate is a HEURISTIC, not an upper bound (spec §13 #14):
// journalctl vacuums ARCHIVED files only and rotates on file boundaries, so
// usage-minus-target can be either high (the active journal's share is not
// reclaimable) or low (a rotation during the run frees more). The action
// labels it `heuristic` rather than "up to".
func journalVacuumEstimate(currentUsage, target int64) int64 {
	if delta := currentUsage - target; delta > 0 {
		return delta
	}
	return 0
}

var aptRemvPattern = regexp.MustCompile(`(?m)^Remv\s+(\S+)`)
var aptPlanPattern = regexp.MustCompile(`(?m)^\d+ upgraded, \d+ newly installed, (\d+) to remove`)
// Debian policy §5.6.1. The captured name is handed straight back to
// dpkg-query as an argv token, so anything else is dropped rather than quoted.
var debianPackageNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9+.-]{1,127}$`)
var dnfFreedPattern = regexp.MustCompile(`(?m)^Freed space:\s*([0-9.,]+\s*[KkMGTP]?i?B?)\s*$`)
var journalUsagePattern = regexp.MustCompile(`journals take up ([0-9.,]+\s*[KkMGTP]?i?B?) in the file system`)

// parseAptAutoremovePackages reads the package names from
// `apt-get -s autoremove`.
//
// It does NOT look for "After this operation, X disk space will be freed":
// verified against the APT source (spec §13 #14), that line is emitted by the
// interactive install path and never by `-s`. The original parser looked for
// it, matched nothing on every Debian/Ubuntu endpoint, and — correctly, under
// this package's own "unknown, never 0" rule — would have reported
// estimateKnown:false for the one action whose size a tech most wants to see.
//
// Three distinguishable outcomes:
//   - `Remv` lines -> (names, true)
//   - a plan that removes 0 packages -> ([], true): a KNOWN empty plan
//   - anything else (a lock error, a future format) -> (nil, false)
func parseAptAutoremovePackages(stdout string) ([]string, bool) {
	matches := aptRemvPattern.FindAllStringSubmatch(stdout, -1)
	if len(matches) == 0 {
		if plan := aptPlanPattern.FindStringSubmatch(stdout); plan != nil && plan[1] == "0" {
			return []string{}, true
		}
		return nil, false
	}
	names := make([]string, 0, len(matches))
	for _, match := range matches {
		if debianPackageNamePattern.MatchString(match[1]) {
			names = append(names, match[1])
		}
	}
	return names, true
}

func dpkgQueryInstalledSizeArgs(packages []string) []string {
	return append([]string{"-W", "-f=${Installed-Size}\n"}, packages...)
}

// parseDpkgInstalledSizes sums `dpkg-query -W -f='${Installed-Size}\n'`.
//
// Installed-Size is in KiB (Debian policy §5.6.20), hence the ×1024. The
// result is a HEURISTIC, not an upper bound: unpacked footprint over-counts
// files shared with packages that stay installed, and dpkg rounds to whole
// KiB. The action labels it as such rather than presenting it as "up to".
func parseDpkgInstalledSizes(stdout string) (int64, bool) {
	var total int64
	saw := false
	for _, line := range strings.Split(stdout, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		kib, err := strconv.ParseInt(trimmed, 10, 64)
		if err != nil || kib < 0 {
			return 0, false
		}
		total += kib * 1024
		saw = true
	}
	// No lines at all is only honest for an empty package list; the caller
	// short-circuits that case and never reaches here with real packages.
	_ = saw
	return total, true
}

// parseDnfAutoremoveFreed reads `dnf --assumeno autoremove`'s summary.
//
// dnf exits NON-ZERO when it aborts under --assumeno, so a non-zero exit with
// a parsable summary is success (spec §7.2). dnf5 (Fedora 41+) changed the
// summary shape and is deliberately left unknown until a fixture is added,
// rather than pattern-matched speculatively.
func parseDnfAutoremoveFreed(stdout string, exitCode int) (int64, bool) {
	if exitCode != 0 && exitCode != 1 {
		return 0, false
	}
	match := dnfFreedPattern.FindStringSubmatch(stdout)
	if match == nil {
		if strings.Contains(stdout, "Nothing to do") {
			return 0, true
		}
		return 0, false
	}
	return parseBinarySize(match[1])
}

func parseJournalDiskUsage(stdout string) (int64, bool) {
	match := journalUsagePattern.FindStringSubmatch(stdout)
	if match == nil {
		return 0, false
	}
	return parseBinarySize(match[1])
}

// directorySize sums regular-file sizes under root. Permission errors are
// skipped rather than aborting: a partial figure is still an upper-bound
// estimate, and the estimate is labelled "up to" regardless.
func directorySize(root string) (int64, bool) {
	var total int64
	seen := false
	err := filepath.WalkDir(root, func(_ string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil //nolint:nilerr // unreadable subtree: skip, do not abort
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil //nolint:nilerr
		}
		seen = true
		total += info.Size()
		return nil
	})
	if err != nil {
		return 0, false
	}
	return total, seen || total == 0
}

// ---------------------------------------------------------------------------
// linux_pkg_cache_clean
// ---------------------------------------------------------------------------

type linuxPkgCacheCleanAction struct{}

func (linuxPkgCacheCleanAction) ID() string { return "linux_pkg_cache_clean" }

func (a linuxPkgCacheCleanAction) Describe() ActionInfo {
	return ActionInfo{
		ID:             a.ID(),
		Label:          "Package manager cache",
		Description:    "Removes downloaded package archives that apt, dnf or yum keep after installing. Packages already installed are untouched; anything removed is re-downloadable.",
		OS:             "linux",
		RiskFlags:      []string{},
		AffectsVolumes: []string{"/"},
	}
}

func (linuxPkgCacheCleanAction) Available(context.Context) (bool, string) {
	pm, ok := detectPackageManager()
	if !ok {
		return false, "no supported package manager (apt, dnf, yum) found"
	}
	return probeWritable(pm.cache)
}

func (linuxPkgCacheCleanAction) Estimate(context.Context) (int64, bool, string) {
	pm, ok := detectPackageManager()
	if !ok {
		return 0, false, ""
	}
	size, known := directorySize(pm.cache)
	if !known {
		return 0, false, ""
	}
	return size, true, fmt.Sprintf("size of %s", pm.cache)
}

func (a linuxPkgCacheCleanAction) Run(ctx context.Context, _ Params) ActionResult {
	pm, ok := detectPackageManager()
	if !ok {
		return ActionResult{ID: a.ID(), Status: StatusUnavailable, ExitCode: 1,
			Error: "no supported package manager (apt, dnf, yum) found"}
	}
	return resultFromProc(a.ID(), runProcess(ctx, linuxPkgCleanTimeout, pm.binary, packageCleanArgs(pm)...))
}

// ---------------------------------------------------------------------------
// linux_pkg_autoremove
// ---------------------------------------------------------------------------

type linuxPkgAutoremoveAction struct{}

func (linuxPkgAutoremoveAction) ID() string { return "linux_pkg_autoremove" }

func (a linuxPkgAutoremoveAction) Describe() ActionInfo {
	return ActionInfo{
		ID:             a.ID(),
		Label:          "Remove orphaned packages",
		Description:    "Removes packages that were installed only as dependencies and are no longer required — most often superseded kernels. This uninstalls software.",
		OS:             "linux",
		RiskFlags:      []string{RiskRemovesPackages},
		AffectsVolumes: []string{"/"},
	}
}

func (linuxPkgAutoremoveAction) Available(context.Context) (bool, string) {
	pm, ok := detectPackageManager()
	if !ok {
		return false, "no supported package manager (apt, dnf, yum) found"
	}
	if pm.name == "yum" {
		// `yum autoremove` exists but has no non-mutating simulation mode with
		// a machine-readable summary, so it is offered without an estimate
		// rather than with a fabricated one.
		return true, ""
	}
	return probeWritable(pm.cache)
}

func (linuxPkgAutoremoveAction) Estimate(ctx context.Context) (int64, bool, string) {
	pm, ok := detectPackageManager()
	if !ok {
		return 0, false, ""
	}
	switch pm.name {
	case "apt":
		proc := runProcess(ctx, linuxEstimateTimeout, pm.binary, aptAutoremoveSimulateArgs()...)
		packages, known := parseAptAutoremovePackages(proc.Stdout)
		if !known {
			return 0, false, ""
		}
		if len(packages) == 0 {
			return 0, true, "apt-get -s autoremove: nothing to remove"
		}
		dpkg, ok := resolveBinary(dpkgQueryBinary)
		if !ok {
			return 0, false, ""
		}
		sizes := runProcess(ctx, linuxEstimateTimeout, dpkg, dpkgQueryInstalledSizeArgs(packages)...)
		bytes, sizesKnown := parseDpkgInstalledSizes(sizes.Stdout)
		if !sizesKnown {
			return 0, false, ""
		}
		return bytes, true, fmt.Sprintf("heuristic: installed size of %d package(s) apt would remove", len(packages))
	case "dnf":
		proc := runProcess(ctx, linuxEstimateTimeout, pm.binary, dnfAutoremoveSimulateArgs()...)
		bytes, known := parseDnfAutoremoveFreed(proc.Stdout, proc.ExitCode)
		if !known {
			return 0, false, ""
		}
		return bytes, true, "dnf --assumeno autoremove"
	default:
		return 0, false, ""
	}
}

func (a linuxPkgAutoremoveAction) Run(ctx context.Context, _ Params) ActionResult {
	pm, ok := detectPackageManager()
	if !ok {
		return ActionResult{ID: a.ID(), Status: StatusUnavailable, ExitCode: 1,
			Error: "no supported package manager (apt, dnf, yum) found"}
	}
	return resultFromProc(a.ID(), runProcess(ctx, linuxAutoremoveTimeout, pm.binary, packageAutoremoveArgs(pm)...))
}

// ---------------------------------------------------------------------------
// linux_journal_vacuum
// ---------------------------------------------------------------------------

type linuxJournalVacuumAction struct{}

func (linuxJournalVacuumAction) ID() string { return "linux_journal_vacuum" }

func (a linuxJournalVacuumAction) Describe() ActionInfo {
	return ActionInfo{
		ID:             a.ID(),
		Label:          "Trim systemd journal",
		Description:    "Vacuums archived systemd journal files down to the selected size. The active journal is never touched, so recent logs are preserved.",
		OS:             "linux",
		RiskFlags:      []string{},
		AffectsVolumes: []string{"/"},
	}
}

func (linuxJournalVacuumAction) Available(context.Context) (bool, string) {
	if _, ok := resolveBinary(journalctlBinary); !ok {
		return false, "journalctl not present"
	}
	return probeWritable(journalDirectory)
}

func (linuxJournalVacuumAction) Estimate(ctx context.Context) (int64, bool, string) {
	binary, ok := resolveBinary(journalctlBinary)
	if !ok {
		return 0, false, ""
	}
	proc := runProcess(ctx, linuxEstimateTimeout, binary, journalDiskUsageArgs()...)
	// journalctl writes the usage line to stdout, but some builds put it on
	// stderr; check both rather than depending on which.
	usage, known := parseJournalDiskUsage(proc.Stdout)
	if !known {
		usage, known = parseJournalDiskUsage(proc.Stderr)
	}
	if !known {
		return 0, false, ""
	}
	return journalVacuumEstimate(usage, journalVacuumDefaultBytes), true,
		"heuristic: journalctl --disk-usage minus the vacuum target; only archived journals are vacuumed"
}

func (a linuxJournalVacuumAction) Run(ctx context.Context, params Params) ActionResult {
	binary, ok := resolveBinary(journalctlBinary)
	if !ok {
		return ActionResult{ID: a.ID(), Status: StatusUnavailable, ExitCode: 1, Error: "journalctl not present"}
	}
	return resultFromProc(a.ID(), runProcess(ctx, linuxJournalVacuumTimeout, binary, journalVacuumArgs(params.JournalVacuumBytes)...))
}

// linuxActions is the linux half of the catalogue, in execution order.
func linuxActions() []Action {
	return []Action{
		linuxPkgCacheCleanAction{},
		linuxPkgAutoremoveAction{},
		linuxJournalVacuumAction{},
	}
}

// resultFromProc turns one process invocation into an ActionResult. Shared by
// every single-process action on all three platforms.
func resultFromProc(id string, proc ProcResult) ActionResult {
	result := ActionResult{
		ID:         id,
		ExitCode:   proc.ExitCode,
		DurationMs: proc.Duration.Milliseconds(),
		OutputTail: strings.TrimSpace(proc.Stdout + "\n" + proc.Stderr),
	}
	switch {
	case proc.TimedOut:
		result.Status = StatusTimedOut
		result.Error = proc.Err.Error()
	case proc.Err != nil:
		result.Status = StatusFailed
		result.Error = proc.Err.Error()
	case proc.ExitCode != 0:
		result.Status = StatusFailed
		result.Error = fmt.Sprintf("%s exited with code %d", filepath.Base(proc.Path), proc.ExitCode)
	default:
		result.Status = StatusCompleted
	}
	return result
}
```

- [ ] **Step 9: Run it and watch it pass**

```bash
cd agent && go test -race ./internal/syscleanup/...
```

Expected: `ok github.com/breeze-rmm/agent/internal/syscleanup` — 30 tests.

- [ ] **Step 10: Confirm the Windows and macOS builds still vet clean**

```bash
cd agent && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go vet ./internal/syscleanup/... \
  && GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go vet ./internal/syscleanup/...
```

Expected: no output.

- [ ] **Step 11: Commit**

```bash
git add agent/internal/syscleanup/sizes.go agent/internal/syscleanup/sizes_test.go agent/internal/syscleanup/linux.go agent/internal/syscleanup/linux_test.go agent/internal/syscleanup/linux_probe_linux.go agent/internal/syscleanup/linux_probe_other.go
git commit -m "$(cat <<'MSG'
feat(agent): Linux system-cleanup actions (package cache, autoremove, journal)

Three actions from spec §7.2 with pure argv builders and fixture-driven
parsers, so the whole catalogue's logic runs on the Linux CI runner and no test
executes a real cleaner.

Two size grammars, because the tools differ: apt emits 1000-based units
("12.3 MB"), dnf and journalctl 1024-based ("1.2G"). One parser for both would
be silently wrong by 7-10%.

dnf exits non-zero when it aborts under --assumeno, so the estimator accepts
exit 1 with a parsable summary; dnf5's changed summary shape reports
estimateKnown:false rather than a confident zero. journalVacuumArgs clamps the
one client-influenced integer AGAIN (64 MiB - 4 GiB), so a forged payload that
bypassed the server's Zod bounds still cannot widen it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
)"
```

---

### Task 5: macOS actions — local snapshots and Homebrew (with `patching.BrewCleanup` extracted)

**Files:**
- Modify: `agent/internal/patching/homebrew.go` (`runBrewCleanup` at `:319`; `brewCleanupArgs` at `:280`)
- Modify: `agent/internal/patching/homebrew_test.go` (Test — the cleanup block at `:488-670`)
- Create: `agent/internal/syscleanup/darwin.go`
- Create: `agent/internal/syscleanup/darwin_test.go` (Test)
- Create: `agent/internal/syscleanup/darwin_brew_darwin.go`
- Create: `agent/internal/syscleanup/darwin_brew_other.go`

**Interfaces:**
- Consumes: `runProcess`, `resolveBinary`, `resultFromProc`, `parseDecimalSize`, `parseBinarySize`.
- Produces:
  ```go
  // agent/internal/patching (darwin only)
  func BrewCleanup(ctx context.Context, dryRun bool) (output string, err error)
  func brewCleanupDryRunArgs() []string   // {"cleanup", "--prune=all", "-n"}
  // agent/internal/syscleanup
  func tmutilListSnapshotsArgs() []string
  func tmutilDeleteSnapshotsArgs() []string
  func parseTmutilSnapshots(stdout string) []string
  func parseBrewCleanupDryRun(output string) (int64, bool)
  func darwinActions() []Action
  func brewCleanupRun(ctx context.Context, dryRun bool) (string, error)   // real on darwin, ErrUnsupported stub elsewhere
  ```

- [ ] **Step 1: Write the failing test for the extracted `BrewCleanup`** — append to `agent/internal/patching/homebrew_test.go`:

```go
// --- W04: BrewCleanup is exported so the system-cleanup catalogue can run it
// as a first-class action and REPORT its outcome. runBrewCleanup keeps the
// swallow-and-log behaviour its patch-job caller depends on (spec §7.2). ---

func TestBrewCleanupDryRunArgsAreNonMutating(t *testing.T) {
	got := brewCleanupDryRunArgs()
	want := []string{"cleanup", "--prune=all", "-n"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("brewCleanupDryRunArgs() = %v, want %v", got, want)
	}
}

// The exported entry point must SURFACE failures. runBrewCleanup swallowing
// them is correct for a post-install maintenance hook and wrong for an action
// a tech explicitly asked for and is watching a spinner on.
func TestBrewCleanupReturnsItsErrorWhenBrewIsAbsent(t *testing.T) {
	if _, err := exec.LookPath("brew"); err == nil {
		t.Skip("brew is installed; this case needs the absent-binary path")
	}
	if _, err := BrewCleanup(context.Background(), true); err == nil {
		t.Fatal("BrewCleanup must return an error when brew is not installed")
	}
}

// The swallow-and-log wrapper still exists and still swallows — the patch job
// must never be failed by a maintenance cleanup (#4912).
func TestRunBrewCleanupStillSwallowsErrors(t *testing.T) {
	h := &HomebrewProvider{}
	h.runBrewCleanup() // must not panic and must not propagate anything
}
```

- [ ] **Step 2: Run it and watch it fail** (macOS host required; on Linux the file is excluded by its `//go:build darwin` tag, so run this step on a Mac or accept the cross-vet in Step 4 as the gate)

```bash
cd agent && go test -race -run 'TestBrewCleanup|TestRunBrewCleanupStillSwallows' ./internal/patching/...
```

Expected failure on macOS: `internal/patching/homebrew_test.go:…: undefined: brewCleanupDryRunArgs` … `[build failed]`. On Linux the package builds with those tests excluded, so the real gate is Step 4's darwin cross-vet, which fails with the same `undefined` error.

- [ ] **Step 3: Implement the extraction** — in `agent/internal/patching/homebrew.go`, add `"context"`, `"os/exec"`, `"unicode/utf8"` and `"github.com/breeze-rmm/agent/internal/maintenance"` to the import block (`"strings"` and `"fmt"` are already there), add `brewCleanupDryRunArgs` next to `brewCleanupArgs` (`:280`), and replace the body of `runBrewCleanup` (`:319`):

```go
// brewCleanupDryRunArgs builds the non-mutating estimate invocation. Pure and
// table-testable, matching brewCleanupArgs/ensureBrewArgs in this file.
func brewCleanupDryRunArgs() []string {
	return []string{"cleanup", "--prune=all", "-n"}
}

// brewCleanupTailLimit caps a captured cleanup stream, keeping the TAIL: the
// only line the estimator reads ("This operation would free approximately …")
// is the last one, and truncatePatchOutput keeps the head.
const brewCleanupTailLimit = 16 * 1024

func truncateBrewOutputTail(output []byte) string {
	text := strings.TrimSpace(string(output))
	if len(text) <= brewCleanupTailLimit {
		return text
	}
	tail := text[len(text)-brewCleanupTailLimit:]
	for len(tail) > 0 && !utf8.RuneStart(tail[0]) {
		tail = tail[1:]
	}
	return "[truncated] " + strings.TrimSpace(tail)
}

// RunBrewCleanupBounded runs `brew cleanup --prune=all` (or `-n`) under the
// caller's context, with a tail-preserving 16 KiB output cap, and returns both
// the output and the error.
//
// It takes NO lock. Two callers need this invocation and they hold the
// maintenance lock at different levels: `BrewCleanup` below (the patch-job
// entry point) acquires it around this call, while the system-cleanup
// catalogue's `mac_brew_cleanup` action runs underneath a lock its whole run
// already holds — locking here as well would deadlock that path.
//
// It lives in `patching` rather than in `syscleanup` because this is where the
// brew binary lookup and the console-user `sudo -n -H -u` handling already
// live (`brewCommand`), and `syscleanup` may import `patching` while the
// reverse would be a cycle. `syscleanup` calls it directly rather than
// reimplementing the sudo dance, which is exactly the duplication spec §13's
// narrative warns against.
//
// NOT runCmdCombinedOutputWithTimeout: that helper builds its own
// context.WithTimeout and ignores the caller's, so a cancelled cleanup run
// would leave brew running for up to patchMutateTimeout (30 minutes) after the
// command it belonged to was already reported.
func RunBrewCleanupBounded(ctx context.Context, dryRun bool) (string, error) {
	args := brewCleanupArgs()
	if dryRun {
		args = brewCleanupDryRunArgs()
	}
	provider := &HomebrewProvider{}
	built, err := provider.brewCommand(args...)
	if err != nil {
		return "", fmt.Errorf("brew cleanup: could not build command: %w", err)
	}

	cmd := exec.CommandContext(ctx, built.Path, built.Args[1:]...)
	cmd.Env = built.Env
	cmd.Dir = built.Dir
	output, err := cmd.CombinedOutput()
	text := truncateBrewOutputTail(output)
	if ctxErr := ctx.Err(); ctxErr != nil {
		return text, fmt.Errorf("brew cleanup cancelled: %w", ctxErr)
	}
	if err != nil {
		return text, fmt.Errorf("brew cleanup failed: %w: %s", err, text)
	}
	return text, nil
}

// BrewCleanup is the exported, LOCKED entry point.
//
// Exported for the system-cleanup catalogue (Disk Cleanup v2 §7.2), which
// needs both halves this function's unexported predecessor could not provide:
// the command output (for the dry-run estimate) and the error (so a failed
// action is reported as failed instead of vanishing into a warn log).
//
// The lock is the process-wide maintenance lock (spec §13 #4/#12), not the
// provider's instance mutex: a `brew cleanup` firing on its debounce timer
// while a `system_cleanup_run` is mid-flight is exactly the interleaving that
// mutex cannot see, since the two live in different packages. Acquire (not
// TryAcquire) because this path is background work with nobody waiting —
// queueing behind a cleanup run is strictly better than skipping the cleanup.
func BrewCleanup(ctx context.Context, dryRun bool) (string, error) {
	release, err := maintenance.Acquire(ctx, "brew_cleanup")
	if err != nil {
		return "", fmt.Errorf("brew cleanup: %w", err)
	}
	defer release()
	return RunBrewCleanupBounded(ctx, dryRun)
}

// runBrewCleanup is the patch-job path: best-effort maintenance whose failures
// are logged (warn) and swallowed, never surfaced to the job that triggered it.
//
// The 30-minute ceiling replaces the one runCmdCombinedOutputWithTimeout used
// to impose internally; it is now the caller's, which is what lets the
// maintenance lock's wait be bounded too.
func (h *HomebrewProvider) runBrewCleanup() {
	ctx, cancel := context.WithTimeout(context.Background(), patchMutateTimeout)
	defer cancel()

	h.brewMutateMu.Lock()
	output, err := BrewCleanup(ctx, false)
	h.brewMutateMu.Unlock()
	if err != nil {
		log.Warn("brew cleanup failed", "error", err.Error(), "output", output)
		return
	}
	log.Info("brew cleanup completed", "output", output)
}
```

- [ ] **Step 4: Write the failing syscleanup darwin test** — create `agent/internal/syscleanup/darwin_test.go`:

```go
package syscleanup

import (
	"regexp"
	"strings"
	"testing"
)

// Two independent constraints, and the second is the one plan amendment 21
// (spec §13 #11) added:
//   - `thinlocalsnapshots` is OPPORTUNISTIC and may delete nothing, so it is
//     never used;
//   - `deletelocalsnapshots <date>` deletes that timestamp's snapshot on EVERY
//     mounted APFS volume, which on a Mac with its Time Machine disk attached
//     reaches the backup destination. The MOUNT-POINT form is scoped to the
//     startup volume, and is also what `listlocalsnapshots /` enumerates.
func TestTmutilArgsAreMountPointScoped(t *testing.T) {
	if got := strings.Join(tmutilListSnapshotsArgs(), " "); got != "listlocalsnapshots /" {
		t.Fatalf("tmutilListSnapshotsArgs() = %q", got)
	}
	if got := strings.Join(tmutilDeleteSnapshotsArgs(), " "); got != "deletelocalsnapshots /" {
		t.Fatalf("tmutilDeleteSnapshotsArgs() = %q, want the mount-point form", got)
	}
	for _, args := range [][]string{tmutilListSnapshotsArgs(), tmutilDeleteSnapshotsArgs()} {
		for _, arg := range args {
			if arg == "thinlocalsnapshots" {
				t.Fatalf("args %v use the opportunistic thinning command", args)
			}
			// A bare date would be machine-wide. The only argument either
			// invocation may carry is the mount point.
			if regexp.MustCompile(`^\d{4}-\d{2}-\d{2}-\d{6}$`).MatchString(arg) {
				t.Fatalf("args %v pass a bare snapshot date, which deletes on every mounted volume", args)
			}
		}
	}
}

func TestParseTmutilSnapshots(t *testing.T) {
	const fixture = `Snapshots for volume group containing disk /:
com.apple.TimeMachine.2026-09-17-031500.local
com.apple.TimeMachine.2026-09-18-084500.local
com.apple.TimeMachine.2026-09-19-104500.local
`
	got := parseTmutilSnapshots(fixture)
	want := []string{"2026-09-17-031500", "2026-09-18-084500", "2026-09-19-104500"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("parseTmutilSnapshots() = %v, want %v", got, want)
	}
}

// Only the date is extracted, and only in the exact shape tmutil emits — the
// value is passed straight back as an argv token, so anything else is dropped.
func TestParseTmutilSnapshotsRejectsAnythingUnexpected(t *testing.T) {
	const hostile = `Snapshots for disk /:
com.apple.TimeMachine.2026-09-19-104500.local
com.apple.TimeMachine.; rm -rf /.local
com.apple.TimeMachine.../../etc.local
not a snapshot line
`
	got := parseTmutilSnapshots(hostile)
	if len(got) != 1 || got[0] != "2026-09-19-104500" {
		t.Fatalf("parseTmutilSnapshots() = %v, want only the well-formed date", got)
	}
}

func TestParseTmutilSnapshotsOnNoSnapshots(t *testing.T) {
	if got := parseTmutilSnapshots("Snapshots for volume group containing disk /:\n"); len(got) != 0 {
		t.Fatalf("parseTmutilSnapshots() = %v, want empty", got)
	}
}

// `brew cleanup -n` prints one line per file it WOULD remove and a single
// trailing summary; only the summary is parsed (spec §7.2, Codex correction).
func TestParseBrewCleanupDryRun(t *testing.T) {
	const fixture = `Would remove: /Users/t/Library/Caches/Homebrew/node--21.7.1.bottle.tar.gz (48.6MB)
Would remove: /opt/homebrew/Cellar/ripgrep/14.1.0 (5.2MB)
==> This operation would free approximately 1.2GB of disk space.
`
	got, ok := parseBrewCleanupDryRun(fixture)
	if !ok || got != 1_200_000_000 {
		t.Fatalf("parseBrewCleanupDryRun() = (%d, %v), want (1200000000, true)", got, ok)
	}
}

func TestParseBrewCleanupDryRunOnNothingToDo(t *testing.T) {
	got, ok := parseBrewCleanupDryRun("")
	if !ok || got != 0 {
		t.Fatalf("parseBrewCleanupDryRun(\"\") = (%d, %v), want (0, true) — brew prints nothing when there is nothing to remove", got, ok)
	}
	if _, ok := parseBrewCleanupDryRun("Error: Another active Homebrew process is already running.\n"); ok {
		t.Fatal("an error body must be estimateKnown:false, not 0")
	}
}

func TestDarwinActionsShape(t *testing.T) {
	byID := map[string]ActionInfo{}
	for _, action := range darwinActions() {
		byID[action.ID()] = action.Describe()
	}
	for _, id := range []string{"mac_tm_local_snapshots", "mac_brew_cleanup"} {
		info, ok := byID[id]
		if !ok {
			t.Fatalf("darwinActions() is missing %q", id)
		}
		if info.OS != "darwin" || info.Label == "" || info.Description == "" {
			t.Errorf("%s: %+v", id, info)
		}
		if containsFold(info.RiskFlags, RiskRemovesPackages) {
			t.Errorf("%s must not carry removes_packages", id)
		}
	}
}
```

- [ ] **Step 5: Run it and watch it fail**

```bash
cd agent && go test -race ./internal/syscleanup/...
```

Expected failure: `internal/syscleanup/darwin_test.go:11:24: undefined: tmutilListSnapshotsArgs` … `[build failed]`.

- [ ] **Step 6: Implement the brew seam (two builds)** — create `agent/internal/syscleanup/darwin_brew_darwin.go`:

```go
//go:build darwin

package syscleanup

import (
	"context"

	"github.com/breeze-rmm/agent/internal/patching"
)

// brewCleanupRun delegates to patching's BOUNDED, UNLOCKED entry point.
//
// Unlocked on purpose: `syscleanup.Run` already holds the process-wide
// maintenance lock for the whole run (spec §13 #4/#12), so calling
// `patching.BrewCleanup` — which acquires it — would deadlock against
// ourselves. `RunBrewCleanupBounded` is the same invocation both callers use;
// only the locking level differs.
//
// Delegating rather than reimplementing is the point: the console-user
// `sudo -n -H -u` dance Homebrew requires when the agent runs as root lives in
// `patching.brewCommand`, and there is exactly one brew invocation path in the
// agent.
func brewCleanupRun(ctx context.Context, dryRun bool) (string, error) {
	return patching.RunBrewCleanupBounded(ctx, dryRun)
}
```

Create `agent/internal/syscleanup/darwin_brew_other.go`:

```go
//go:build !darwin

package syscleanup

import (
	"context"
	"errors"
)

// brewCleanupRun is darwin-only; the stub exists so darwin.go stays untagged
// and its argv builders and parsers run under `go test ./...` on the Linux CI
// runner. internal/patching/homebrew.go is //go:build darwin, so importing it
// from an untagged file would not compile anywhere else.
func brewCleanupRun(context.Context, bool) (string, error) {
	return "", errors.New("Homebrew cleanup is only available on macOS")
}
```

- [ ] **Step 7: Implement the darwin actions** — create `agent/internal/syscleanup/darwin.go`:

```go
package syscleanup

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"
)

const (
	tmutilBinary          = "/usr/bin/tmutil"
	darwinSnapshotTimeout = 10 * time.Minute
	darwinBrewTimeout     = 10 * time.Minute
	darwinEstimateTimeout = 60 * time.Second
)

// startupVolumeMountPoint is the ONLY argument either tmutil invocation takes.
const startupVolumeMountPoint = "/"

func tmutilListSnapshotsArgs() []string {
	return []string{"listlocalsnapshots", startupVolumeMountPoint}
}

// tmutilDeleteSnapshotsArgs uses the MOUNT-POINT form.
//
// `tmutil deletelocalsnapshots <date>` deletes the snapshot bearing that
// timestamp on EVERY mounted APFS volume (spec §13 #11) — on a Mac with its
// Time Machine destination or a cloned backup disk attached, that reaches
// volumes this action was never asked to touch. The mount-point form is
// confined to the startup volume, takes no date at all, and therefore also
// removes the only path by which a parsed string could become an argv token.
func tmutilDeleteSnapshotsArgs() []string {
	return []string{"deletelocalsnapshots", startupVolumeMountPoint}
}

// snapshotDatePattern is deliberately exact: the captured value is passed
// straight back as an argv token, so a line that does not match this shape is
// dropped rather than sanitised.
var snapshotDatePattern = regexp.MustCompile(`^com\.apple\.TimeMachine\.(\d{4}-\d{2}-\d{2}-\d{6})(?:\.local)?$`)

func parseTmutilSnapshots(stdout string) []string {
	dates := make([]string, 0, 8)
	for _, line := range strings.Split(stdout, "\n") {
		if match := snapshotDatePattern.FindStringSubmatch(strings.TrimSpace(line)); match != nil {
			dates = append(dates, match[1])
		}
	}
	return dates
}

var brewFreedPattern = regexp.MustCompile(`This operation would free approximately ([0-9.,]+\s*[kKMGTP]?B) of disk space`)

// parseBrewCleanupDryRun reads the single trailing summary line of
// `brew cleanup --prune=all -n`. brew prints NOTHING at all when there is
// nothing to remove, which is a known zero; an error body is unknown.
func parseBrewCleanupDryRun(output string) (int64, bool) {
	trimmed := strings.TrimSpace(output)
	if trimmed == "" {
		return 0, true
	}
	if match := brewFreedPattern.FindStringSubmatch(trimmed); match != nil {
		return parseDecimalSize(match[1])
	}
	if strings.HasPrefix(trimmed, "Error:") || strings.Contains(trimmed, "Error: ") {
		return 0, false
	}
	// "Would remove:" lines with no summary means brew removed nothing
	// measurable it was willing to total; honest answer is unknown.
	return 0, false
}

// ---------------------------------------------------------------------------
// mac_tm_local_snapshots
// ---------------------------------------------------------------------------

type macSnapshotsAction struct{}

func (macSnapshotsAction) ID() string { return "mac_tm_local_snapshots" }

func (a macSnapshotsAction) Describe() ActionInfo {
	return ActionInfo{
		ID:             a.ID(),
		Label:       "Time Machine local snapshots",
		Description: "Deletes the local APFS snapshots Time Machine keeps on the startup volume. Backups on the Time Machine destination are untouched.",
		OS:          "darwin",
		// Spec §13 #15: on a Mac whose Time Machine destination is not
		// attached, these snapshots are the ONLY on-disk restore points. The
		// original catalogue left that undisclosed.
		RiskFlags:      []string{RiskRemovesRecoveryPoints},
		AffectsVolumes: []string{"/"},
	}
}

func (macSnapshotsAction) Available(context.Context) (bool, string) {
	if _, ok := resolveBinary(tmutilBinary); !ok {
		return false, "tmutil not present"
	}
	return true, ""
}

// Estimate reports the snapshot COUNT in the detail string and leaves bytes
// unknown: macOS exposes no per-snapshot size, and Time Machine's own thinning
// is opportunistic, so any byte figure here would be invented (spec §7.2).
func (macSnapshotsAction) Estimate(ctx context.Context) (int64, bool, string) {
	binary, ok := resolveBinary(tmutilBinary)
	if !ok {
		return 0, false, ""
	}
	proc := runProcess(ctx, darwinEstimateTimeout, binary, tmutilListSnapshotsArgs()...)
	if proc.ExitCode != 0 && proc.Stdout == "" {
		return 0, false, ""
	}
	count := len(parseTmutilSnapshots(proc.Stdout))
	return 0, false, fmt.Sprintf("%d local snapshot(s); macOS does not report their size", count)
}

// Run deletes the startup volume's local snapshots in ONE mount-point-scoped
// invocation.
//
// The per-date loop this replaces was both slower and wrong: each iteration
// passed a bare timestamp, which tmutil applies to every mounted APFS volume
// (spec §13 #11). Listing first is kept only so the result can say how many
// snapshots were present, and so an empty volume is `completed` rather than a
// tmutil error.
func (a macSnapshotsAction) Run(ctx context.Context, _ Params) ActionResult {
	started := time.Now()
	binary, ok := resolveBinary(tmutilBinary)
	if !ok {
		return ActionResult{ID: a.ID(), Status: StatusUnavailable, ExitCode: 1, Error: "tmutil not present"}
	}

	listing := runProcess(ctx, darwinEstimateTimeout, binary, tmutilListSnapshotsArgs()...)
	before := len(parseTmutilSnapshots(listing.Stdout))
	if before == 0 {
		return ActionResult{ID: a.ID(), Status: StatusCompleted, ExitCode: 0,
			DurationMs: time.Since(started).Milliseconds(), OutputTail: "no local snapshots on the startup volume"}
	}

	proc := runProcess(ctx, darwinSnapshotTimeout, binary, tmutilDeleteSnapshotsArgs()...)
	result := resultFromProc(a.ID(), proc)
	result.DurationMs = time.Since(started).Milliseconds()
	if result.Status == StatusCompleted {
		after := runProcess(ctx, darwinEstimateTimeout, binary, tmutilListSnapshotsArgs()...)
		result.OutputTail = capOutput([]byte(fmt.Sprintf(
			"%d local snapshot(s) before, %d after\n%s",
			before, len(parseTmutilSnapshots(after.Stdout)), proc.Stdout,
		)))
	}
	return result
}

// ---------------------------------------------------------------------------
// mac_brew_cleanup
// ---------------------------------------------------------------------------

type macBrewCleanupAction struct{}

func (macBrewCleanupAction) ID() string { return "mac_brew_cleanup" }

func (a macBrewCleanupAction) Describe() ActionInfo {
	return ActionInfo{
		ID:             a.ID(),
		Label:          "Homebrew cache and old versions",
		Description:    "Runs `brew cleanup --prune=all`: removes downloaded bottles and superseded versions of installed formulae and casks. Installed software stays at its current version.",
		OS:             "darwin",
		RiskFlags:      []string{},
		AffectsVolumes: []string{"/"},
	}
}

func (macBrewCleanupAction) Available(ctx context.Context) (bool, string) {
	if _, err := brewCleanupRun(ctx, true); err != nil {
		return false, "Homebrew is not installed or is not runnable as the console user"
	}
	return true, ""
}

func (macBrewCleanupAction) Estimate(ctx context.Context) (int64, bool, string) {
	output, err := brewCleanupRun(ctx, true)
	if err != nil {
		return 0, false, ""
	}
	bytes, known := parseBrewCleanupDryRun(output)
	if !known {
		return 0, false, ""
	}
	return bytes, true, "brew cleanup --prune=all -n"
}

func (a macBrewCleanupAction) Run(ctx context.Context, _ Params) ActionResult {
	started := time.Now()
	runCtx, cancel := context.WithTimeout(ctx, darwinBrewTimeout)
	defer cancel()

	output, err := brewCleanupRun(runCtx, false)
	result := ActionResult{
		ID:         a.ID(),
		DurationMs: time.Since(started).Milliseconds(),
		OutputTail: capOutput([]byte(output)),
	}
	switch {
	case err != nil && runCtx.Err() == context.DeadlineExceeded:
		result.Status, result.ExitCode, result.Error = StatusTimedOut, 1, err.Error()
	case err != nil:
		result.Status, result.ExitCode, result.Error = StatusFailed, 1, err.Error()
	default:
		result.Status, result.ExitCode = StatusCompleted, 0
	}
	return result
}

func darwinActions() []Action {
	return []Action{macSnapshotsAction{}, macBrewCleanupAction{}}
}
```

- [ ] **Step 8: Run both packages and watch them pass**

```bash
cd agent && go test -race ./internal/syscleanup/... ./internal/patching/...
```

Expected: `ok github.com/breeze-rmm/agent/internal/syscleanup` (37 tests) and `ok github.com/breeze-rmm/agent/internal/patching`.

- [ ] **Step 9: Prove the darwin build compiles and vets** (this is the only gate for the darwin-tagged files on a Linux host, and it is a required CI step)

```bash
cd agent && GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go vet ./internal/syscleanup/... ./internal/patching/... \
  && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go vet ./internal/syscleanup/...
```

Expected: no output.

- [ ] **Step 10: Commit**

```bash
git add agent/internal/patching/homebrew.go agent/internal/patching/homebrew_test.go agent/internal/syscleanup/darwin.go agent/internal/syscleanup/darwin_test.go agent/internal/syscleanup/darwin_brew_darwin.go agent/internal/syscleanup/darwin_brew_other.go
git commit -m "$(cat <<'MSG'
feat(agent): macOS system-cleanup actions; export patching.BrewCleanup

Time Machine local snapshots are enumerated and deleted BY DATE
(`deletelocalsnapshots`), not thinned: `thinlocalsnapshots` is opportunistic and
may delete nothing, which would report a successful action that freed no space.
The date comes only from a strict `com.apple.TimeMachine.YYYY-MM-DD-HHMMSS`
match, because it is passed straight back as an argv token.

BrewCleanup(ctx, dryRun) is extracted out of the unexported, error-swallowing
runBrewCleanup so the catalogue gets both halves it needs — the dry-run output
for the estimate and the error for a truthful failed status — while the
patch-job caller keeps its swallow-and-log wrapper (#4912).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
)"
```

---

### Task 6: Windows actions — cleanmgr handler allowlist and DISM component cleanup

**Files:**
- Create: `agent/internal/syscleanup/windows.go`
- Create: `agent/internal/syscleanup/windows_test.go` (Test)
- Create: `agent/internal/syscleanup/windows_registry_windows.go`
- Create: `agent/internal/syscleanup/windows_registry_other.go`

**Interfaces:**
- Consumes: `runProcess`, `resolveBinary`, `resultFromProc`, `capOutput`, `winCleanmgrSubIDs` (Task 1); `golang.org/x/sys/windows/registry` (windows file only — the same import `agent/internal/collectors/hardware_windows.go:11` uses).
- Produces:
  ```go
  const volumeCachesKey = `SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\VolumeCaches`
  const stateFlagsValue = "StateFlags5555"
  var winCleanmgrHandlers []winCleanmgrHandler   // slug, registry key name, friendly label, risk flags, estimate paths
  func winCleanmgrHandlerBySubID(subID string) (winCleanmgrHandler, bool)
  func cleanmgrArgs() []string                   // {"/sagerun:5555"}
  func dismAnalyzeArgs() []string                // {"/English","/Online","/Cleanup-Image","/AnalyzeComponentStore"}
  func dismCleanupArgs() []string                // {"/English","/Online","/Cleanup-Image","/StartComponentCleanup"}
  func parseDismAnalyze(stdout string) (bytes int64, known bool, recommended bool)
  func deliveryOptimizationCachePath(policyValue string) string
  func parseDismSize(text string) (int64, bool)
  func windowsActions() []Action
  // windows-only seam, stubbed elsewhere:
  func presentVolumeCaches() ([]string, error)
  func setStateFlags(keyName string, value uint32) error
  func handlerDisplayName(keyName string) string
  func expandWindowsPath(path string) string
  ```

- [ ] **Step 1: Write the failing test** — create `agent/internal/syscleanup/windows_test.go`:

```go
package syscleanup

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// Spec §7.2's allowlist, verbatim, plus the exclusions. This is the single
// most safety-critical list in the wave: a per-user handler under the SYSTEM
// service account operates on the SYSTEM profile rather than the logged-in
// user, DownloadsFolder deletes user data, ESD breaks Reset this PC, and
// Language Pack uninstalls installed languages.
func TestCleanmgrHandlerAllowlistIsExactlyTheSpecSet(t *testing.T) {
	want := map[string]string{
		"update_cleanup":                             "Update Cleanup",
		"delivery_optimization_files":                "Delivery Optimization Files",
		"device_driver_packages":                     "Device Driver Packages",
		"previous_installations":                     "Previous Installations",
		"upgrade_discarded_files":                    "Upgrade Discarded Files",
		"windows_upgrade_log_files":                  "Windows Upgrade Log Files",
		"setup_log_files":                            "Setup Log Files",
		"temporary_setup_files":                      "Temporary Setup Files",
		"service_pack_cleanup":                       "Service Pack Cleanup",
		"system_error_memory_dump_files":             "System error memory dump files",
		"system_error_minidump_files":                "System error minidump files",
		"windows_error_reporting_files":              "Windows Error Reporting Files",
		"windows_error_reporting_system_archive_files": "Windows Error Reporting System Archive Files",
		"windows_error_reporting_system_queue_files":   "Windows Error Reporting System Queue Files",
		"temporary_files":                            "Temporary Files",
		"windows_defender":                           "Windows Defender",
		"old_chkdsk_files":                           "Old ChkDsk Files",
		"diagnostic_data_viewer_database_files":      "Diagnostic Data Viewer database files",
		"branchcache":                                "BranchCache",
		"content_indexer_cleaner":                    "Content Indexer Cleaner",
	}
	if len(winCleanmgrHandlers) != len(want) {
		t.Fatalf("winCleanmgrHandlers has %d entries, want %d", len(winCleanmgrHandlers), len(want))
	}
	for _, handler := range winCleanmgrHandlers {
		keyName, ok := want[handler.slug]
		if !ok {
			t.Fatalf("unexpected handler slug %q", handler.slug)
		}
		if handler.keyName != keyName {
			t.Fatalf("slug %q maps to registry key %q, want %q", handler.slug, handler.keyName, keyName)
		}
		if handler.label == "" {
			t.Fatalf("slug %q has no fallback friendly label", handler.slug)
		}
	}
	// Every sub-id in the shared catalogue resolves to exactly one handler.
	for _, subID := range winCleanmgrSubIDs {
		if _, ok := winCleanmgrHandlerBySubID(subID); !ok {
			t.Fatalf("catalogue sub-id %q has no handler", subID)
		}
	}
}

func TestCleanmgrHandlersExcludeUserDataAndRecoveryHandlers(t *testing.T) {
	forbidden := []string{
		"DownloadsFolder", "Windows ESD installation files", "Language Pack",
		"Recycle Bin", "Thumbnail Cache", "Temporary Internet Files",
		"Internet Cache Files", "Active Setup Temp Folders",
		"GameNewsFiles", "GameStatisticsFiles", "GameUpdateFiles",
	}
	for _, handler := range winCleanmgrHandlers {
		for _, name := range forbidden {
			if strings.EqualFold(handler.keyName, name) {
				t.Fatalf("forbidden cleanmgr handler %q is in the allowlist", name)
			}
		}
	}
}

// Risk flags the spec assigns per handler (§7.2). These drive the UI badges;
// getting them wrong means a tech restarts a machine they were not warned
// about, or loses driver rollback without being told.
func TestCleanmgrHandlerRiskFlags(t *testing.T) {
	byslug := map[string]winCleanmgrHandler{}
	for _, handler := range winCleanmgrHandlers {
		byslug[handler.slug] = handler
	}
	if !containsFold(byslug["update_cleanup"].riskFlags, RiskMayRequireReboot) {
		t.Error("Update Cleanup must carry may_require_reboot — the space is released after restart")
	}
	if !containsFold(byslug["device_driver_packages"].riskFlags, RiskRemovesDriverRollback) {
		t.Error("Device Driver Packages must carry removes_driver_rollback")
	}
	// Spec §13 #15: deleting Windows.old / $WINDOWS.~BT ends the "go back to
	// the previous version" window, which no later action can restore.
	for _, slug := range []string{"previous_installations", "upgrade_discarded_files"} {
		if !containsFold(byslug[slug].riskFlags, RiskRemovesOSRollback) {
			t.Errorf("%s must carry removes_os_rollback", slug)
		}
	}
	if containsFold(byslug["setup_log_files"].riskFlags, RiskRemovesOSRollback) {
		t.Error("Setup Log Files must not claim to remove OS rollback")
	}
	if len(byslug["setup_log_files"].riskFlags) != 0 {
		t.Error("Setup Log Files carries no risk flag")
	}
}

// Argv from constants only; /d is not supported with /sagerun, so all volumes
// are processed (spec §7.2) and no volume string is ever interpolated.
func TestCleanmgrAndDismArgs(t *testing.T) {
	if got := strings.Join(cleanmgrArgs(), " "); got != "/sagerun:5555" {
		t.Fatalf("cleanmgrArgs() = %q", got)
	}
	analyze := strings.Join(dismAnalyzeArgs(), " ")
	if analyze != "/English /Online /Cleanup-Image /AnalyzeComponentStore" {
		t.Fatalf("dismAnalyzeArgs() = %q", analyze)
	}
	cleanup := strings.Join(dismCleanupArgs(), " ")
	if cleanup != "/English /Online /Cleanup-Image /StartComponentCleanup" {
		t.Fatalf("dismCleanupArgs() = %q", cleanup)
	}
	// /ResetBase is never reachable: it makes every installed update
	// permanent and unremovable (spec §10 item 7, out of scope in §1).
	for _, args := range [][]string{cleanmgrArgs(), dismAnalyzeArgs(), dismCleanupArgs()} {
		for _, arg := range args {
			if strings.Contains(strings.ToLower(arg), "resetbase") {
				t.Fatalf("args %v contain /ResetBase", args)
			}
			if strings.Contains(arg, "/d") && strings.Contains(arg, "sagerun") {
				t.Fatalf("args %v combine /d with /sagerun", args)
			}
		}
	}
	// /English is what makes parseDismAnalyze deterministic on a non-English
	// endpoint (spec §7.1).
	if !strings.HasPrefix(analyze, "/English") {
		t.Fatal("DISM must be invoked with /English before anything else")
	}
}

// DISM reports 1024-based sizes with a two-character suffix ("1.64 GB"),
// which is neither of the two grammars in sizes.go.
func TestParseDismSize(t *testing.T) {
	cases := []struct {
		in   string
		want int64
		ok   bool
	}{
		{"1.64 GB", 1_760_936_755, true},
		{"389.51 MB", 408_431_493, true},
		{"512 KB", 524_288, true},
		{"0 bytes", 0, true},
		{"", 0, false},
		{"unknown", 0, false},
	}
	for _, tc := range cases {
		got, ok := parseDismSize(tc.in)
		if ok != tc.ok || got != tc.want {
			t.Errorf("parseDismSize(%q) = (%d, %v), want (%d, %v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestParseDismAnalyzeSumsBackupsAndCache(t *testing.T) {
	const fixture = `Deployment Image Servicing and Management tool
Version: 10.0.22621.2792

Image Version: 10.0.22621.2861

[===========================99.0%========================= ]

Component Store (WinSxS) information:

Windows Explorer Reported Size of Component Store : 8.63 GB

Actual Size of Component Store : 8.21 GB

    Shared with Windows : 6.18 GB
    Backups and Disabled Features : 1.64 GB
    Cache and Temporary Data :  389.51 MB

Date of Last Cleanup : 2026-08-01 03:00:11

Number of Reclaimable Packages : 12
Component Store Cleanup Recommended : Yes

The operation completed successfully.
`
	got, ok, recommended := parseDismAnalyze(fixture)
	if !ok {
		t.Fatal("the documented AnalyzeComponentStore shape must parse")
	}
	if want := int64(1_760_936_755 + 408_431_493); got != want {
		t.Fatalf("parseDismAnalyze() = %d, want %d", got, want)
	}
	if !recommended {
		t.Fatal("recommended must be true for this fixture")
	}
}

// Plan amendment 25 (spec §13 #14): "Cleanup Recommended : No" is NOT a zero.
// The two fields are component-store overhead and a direct
// /StartComponentCleanup has no 30-day grace period, so Windows saying "not
// worth it" is not the same as "nothing would be freed". The sum is still
// reported; only the recommendation flag changes.
func TestParseDismAnalyzeReportsTheSumEvenWhenNotRecommended(t *testing.T) {
	const fixture = `Component Store (WinSxS) information:

Actual Size of Component Store : 6.10 GB

    Shared with Windows : 5.90 GB
    Backups and Disabled Features : 180.00 MB
    Cache and Temporary Data : 20.00 MB

Number of Reclaimable Packages : 0
Component Store Cleanup Recommended : No

The operation completed successfully.
`
	got, ok, recommended := parseDismAnalyze(fixture)
	if !ok {
		t.Fatal("the shape must parse")
	}
	if want := int64(180*(1<<20) + 20*(1<<20)); got != want {
		t.Fatalf("parseDismAnalyze() = %d, want %d — a 'No' recommendation does not zero the estimate", got, want)
	}
	if recommended {
		t.Fatal("recommended must be false for this fixture")
	}
}

func TestParseDismAnalyzeOnAnErrorBody(t *testing.T) {
	const fixture = `Error: 1392

The file or directory is corrupted and unreadable.

The DISM log file can be found at C:\Windows\Logs\DISM\dism.log
`
	if _, ok, _ := parseDismAnalyze(fixture); ok {
		t.Fatal("an error body must be estimateKnown:false, never 0")
	}
}

// Plan amendment 26 (spec §13 #14). The Delivery Optimization cache is NOT
// under SoftwareDistribution — it lives in the NetworkService profile and is
// policy-overridable — and the Temporary Files handler covers more than
// %SystemRoot%\Temp, so sizing it from that one directory under-reports.
func TestDeliveryOptimizationAndTemporaryFilesEstimatePaths(t *testing.T) {
	byslug := map[string]winCleanmgrHandler{}
	for _, handler := range winCleanmgrHandlers {
		byslug[handler.slug] = handler
	}

	do := byslug["delivery_optimization_files"]
	if len(do.estimatePaths) != 0 {
		t.Fatalf("Delivery Optimization must resolve its cache at runtime (policy override), not from a static path list; got %v", do.estimatePaths)
	}
	if do.estimatePathsFn == nil {
		t.Fatal("Delivery Optimization needs a runtime path resolver")
	}
	if got := deliveryOptimizationCachePath(""); got != `%SystemDrive%\Windows\ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache` {
		t.Fatalf("default DO cache path = %q", got)
	}
	// DOModifyCacheDrive names a drive or a folder; the default tail is
	// appended to a bare drive letter.
	if got := deliveryOptimizationCachePath("E:"); !strings.HasPrefix(got, `E:\`) {
		t.Fatalf("policy-overridden DO cache path = %q, want it on E:", got)
	}
	if got := deliveryOptimizationCachePath(`D:\DOCache`); got != `D:\DOCache` {
		t.Fatalf("an explicit policy folder must be used verbatim; got %q", got)
	}

	if len(byslug["temporary_files"].estimatePaths) != 0 {
		t.Fatal("Temporary Files must report an UNKNOWN estimate: the handler covers more than %SystemRoot%\\Temp")
	}
}

// --- Profile hygiene (spec §13 #4) -----------------------------------------
//
// These are the most safety-critical assertions in the wave, and the Windows
// `go test` job does not run internal/syscleanup at all — so the registry seam
// is a function variable and this fake is the only place the rules execute.

func withFakeVolumeCaches(t *testing.T, present []string, failOn string) map[string]uint32 {
	t.Helper()
	written := map[string]uint32{}
	originalPresent, originalSet := presentVolumeCaches, setStateFlags
	t.Cleanup(func() { presentVolumeCaches, setStateFlags = originalPresent, originalSet })

	presentVolumeCaches = func() ([]string, error) { return present, nil }
	setStateFlags = func(keyName string, value uint32) error {
		if keyName == failOn {
			return errors.New("access is denied")
		}
		written[keyName] = value
		return nil
	}
	return written
}

// The whole point: /sagerun:5555 runs EVERY handler flagged 2, wherever that 2
// came from. A third-party or excluded handler that already carries one must
// be zeroed, or it executes alongside the selection with no trace in the
// result.
func TestCleanmgrRunZeroesEveryNonSelectedHandlerIncludingUnallowlistedOnes(t *testing.T) {
	written := withFakeVolumeCaches(t, []string{
		"Setup Log Files",
		"Update Cleanup",
		"DownloadsFolder",          // excluded built-in
		"Contoso Disk Helper",      // third-party
		"Windows ESD installation files",
	}, "")

	action := winCleanmgrAction{selectedSlugs: []string{"setup_log_files"}}
	_ = action.Run(context.Background(), Params{})

	if written["Setup Log Files"] != 2 {
		t.Fatalf("the selected handler was flagged %d, want 2", written["Setup Log Files"])
	}
	for _, keyName := range []string{"Update Cleanup", "DownloadsFolder", "Contoso Disk Helper", "Windows ESD installation files"} {
		value, seen := written[keyName]
		if !seen {
			t.Errorf("%q was never written; a stale StateFlags5555=2 would run it", keyName)
			continue
		}
		if value != 0 {
			t.Errorf("%q was flagged %d, want 0", keyName, value)
		}
	}
}

// A half-written profile executes an arbitrary subset that matches neither the
// selection nor the reported result, so the action fails before cleanmgr runs.
func TestCleanmgrRunAbortsBeforeCleanmgrWhenAProfileWriteFails(t *testing.T) {
	written := withFakeVolumeCaches(t,
		[]string{"Setup Log Files", "Contoso Disk Helper"}, "Contoso Disk Helper")

	got := winCleanmgrAction{selectedSlugs: []string{"setup_log_files"}}.Run(context.Background(), Params{})

	if got.Status != StatusFailed {
		t.Fatalf("status = %q, want failed", got.Status)
	}
	if !strings.Contains(got.Error, "aborted before running cleanmgr") {
		t.Fatalf("error = %q, want it to say the run was aborted before cleanmgr", got.Error)
	}
	if _, ran := written["__cleanmgr_started__"]; ran {
		t.Fatal("cleanmgr must not have been started")
	}
}

func TestWindowsActionsShape(t *testing.T) {
	byID := map[string]ActionInfo{}
	for _, action := range windowsActions() {
		byID[action.ID()] = action.Describe()
	}
	for _, id := range []string{"win_cleanmgr", "win_dism_component_cleanup"} {
		info, ok := byID[id]
		if !ok {
			t.Fatalf("windowsActions() is missing %q", id)
		}
		if info.OS != "windows" || info.Label == "" || info.Description == "" {
			t.Errorf("%s: %+v", id, info)
		}
		if !containsFold(info.RiskFlags, RiskLongRunning) {
			t.Errorf("%s must carry long_running — both can run for the best part of an hour", id)
		}
	}
	if !containsFold(byID["win_dism_component_cleanup"].RiskFlags, RiskMayRequireRebootFree) {
		t.Error("DISM component cleanup must carry may_require_reboot_free_state")
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd agent && go test -race ./internal/syscleanup/...
```

Expected failure: `internal/syscleanup/windows_test.go:37:5: undefined: winCleanmgrHandlers` … `[build failed]`.

- [ ] **Step 3: Implement the registry seam (windows build)** — create `agent/internal/syscleanup/windows_registry_windows.go`:

```go
//go:build windows

package syscleanup

import (
	"os"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows/registry"
)

// presentVolumeCaches lists the handler key names this Windows build actually
// has under VolumeCaches. Key names vary by build — the Windows Error
// Reporting handlers were consolidated in 10 1809+ — so the allowlist is
// intersected with whatever is present and missing names are simply not
// offered (spec §7.2).
func presentVolumeCachesImpl() ([]string, error) {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, volumeCachesKey, registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		return nil, err
	}
	defer key.Close()
	return key.ReadSubKeyNames(-1)
}

// setStateFlags writes StateFlags5555 on one handler. cleanmgr /sagerun:5555
// then runs exactly the handlers flagged 2 — which is why every allowlisted
// handler NOT selected is explicitly written 0 rather than left alone: a stale
// 2 from an earlier run would silently widen the current one.
func setStateFlagsImpl(keyName string, value uint32) error {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, volumeCachesKey+`\`+keyName, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	return key.SetDWordValue(stateFlagsValue, value)
}

var (
	shlwapi                 = syscall.NewLazyDLL("shlwapi.dll")
	procSHLoadIndirectString = shlwapi.NewProc("SHLoadIndirectString")
)

// handlerDisplayName resolves a handler's localised label.
//
// Best-effort by contract (spec §7.2): the registry `Display` value is an
// indirect resource string ("@%SystemRoot%\System32\foo.dll,-123") that only
// SHLoadIndirectString can expand, the export is absent on some SKUs, and a
// failed expansion must not cost the handler its row in the UI. Callers fall
// back to the fixed friendly-name table, then to the key name.
func handlerDisplayNameImpl(keyName string) string {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, volumeCachesKey+`\`+keyName, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer key.Close()

	raw, _, err := key.GetStringValue("Display")
	if err != nil || raw == "" {
		return ""
	}
	if raw[0] != '@' {
		return raw
	}
	if err := procSHLoadIndirectString.Find(); err != nil {
		return ""
	}
	source, err := syscall.UTF16PtrFromString(raw)
	if err != nil {
		return ""
	}
	buffer := make([]uint16, 512)
	ret, _, _ := procSHLoadIndirectString.Call(
		uintptr(unsafe.Pointer(source)),
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(len(buffer)),
		0,
	)
	if ret != 0 { // non-zero HRESULT is a failure
		return ""
	}
	return syscall.UTF16ToString(buffer)
}

func expandWindowsPathImpl(path string) string { return os.ExpandEnv(expandPercentVars(path)) }

// readDOCachePolicyImpl reads DOModifyCacheDrive. Absent policy -> "", which
// deliveryOptimizationCachePath turns into the NetworkService default.
func readDOCachePolicyImpl() string {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, doPolicyKey, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer key.Close()
	value, _, err := key.GetStringValue(doPolicyValue)
	if err != nil {
		return ""
	}
	return value
}
```

Create `agent/internal/syscleanup/windows_registry_other.go`:

```go
//go:build !windows

package syscleanup

import "errors"

// Windows-only seam. The stubs exist so windows.go — which holds the handler
// allowlist, every argv builder and the DISM parser — stays untagged and is
// therefore exercised by `go test ./...` on the Linux CI runner, where the
// Windows job does not run internal/syscleanup at all.
func presentVolumeCachesImpl() ([]string, error) { return nil, errors.New("not windows") }

func setStateFlagsImpl(string, uint32) error { return errors.New("not windows") }

func handlerDisplayNameImpl(string) string { return "" }

func expandWindowsPathImpl(path string) string { return path }

func readDOCachePolicyImpl() string { return "" }
```

- [ ] **Step 4: Implement the Windows actions** — create `agent/internal/syscleanup/windows.go`:

```go
package syscleanup

import (
	"context"
	"fmt"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// The Windows-only seam, indirected through function VARIABLES so the profile
// hygiene rules (spec §13 #4) are testable on the Linux CI runner — the
// Windows `go test` job does not run internal/syscleanup at all, so a
// registry-shaped fake here is the only place those rules are ever executed.
var (
	presentVolumeCaches = presentVolumeCachesImpl
	setStateFlags       = setStateFlagsImpl
	handlerDisplayName  = handlerDisplayNameImpl
	expandWindowsPath   = expandWindowsPathImpl
	readDOCachePolicy   = readDOCachePolicyImpl
)

const (
	volumeCachesKey = `SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\VolumeCaches`
	doPolicyKey     = `SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization`
	doPolicyValue   = "DOModifyCacheDrive"
	stateFlagsValue = "StateFlags5555"

	cleanmgrBinaryRelative = `\System32\cleanmgr.exe`
	dismBinaryRelative     = `\System32\dism.exe`

	cleanmgrTimeout      = 60 * time.Minute
	dismCleanupTimeout   = 90 * time.Minute
	windowsEstimateLimit = 3 * time.Minute
)

// winCleanmgrHandler is one allowlisted cleanmgr handler.
//
// `slug` is the only token the server and the UI ever see; `keyName` is the
// registry sub-key, which is NEVER accepted from the wire. `estimatePaths` are
// the directories whose size stands in for the handler's reclaimable space
// where one is known (spec §7.2); an empty list means the handler is opaque
// and reports estimateKnown:false.
type winCleanmgrHandler struct {
	slug      string
	keyName   string
	label     string
	riskFlags []string
	// estimatePaths are static, environment-expanded directories.
	estimatePaths []string
	// estimatePathsFn resolves paths that depend on machine state — today only
	// the Delivery Optimization cache, whose location is policy-overridable
	// (spec §13 #14). Nil for every other handler.
	estimatePathsFn func() []string
}

// The allowlist from spec §7.2, verbatim. Anything else under VolumeCaches is
// never offered. The four deliberate exclusions — DownloadsFolder (user data),
// Windows ESD installation files (breaks Reset this PC), Language Pack
// (uninstalls languages) and every per-user handler (under the SYSTEM service
// account they operate on the SYSTEM profile, and the file engine already
// covers user bins) — are absent by construction and asserted absent by test.
var winCleanmgrHandlers = []winCleanmgrHandler{
	{slug: "update_cleanup", keyName: "Update Cleanup", label: "Windows Update cleanup",
		riskFlags: []string{RiskMayRequireReboot}},
	{slug: "delivery_optimization_files", keyName: "Delivery Optimization Files", label: "Delivery Optimization files",
		estimatePathsFn: func() []string { return []string{deliveryOptimizationCachePath(readDOCachePolicy())} }},
	{slug: "device_driver_packages", keyName: "Device Driver Packages", label: "Device driver packages",
		riskFlags: []string{RiskRemovesDriverRollback}},
	{slug: "previous_installations", keyName: "Previous Installations", label: "Previous Windows installations",
		riskFlags:     []string{RiskRemovesOSRollback},
		estimatePaths: []string{`%SystemDrive%\Windows.old`}},
	{slug: "upgrade_discarded_files", keyName: "Upgrade Discarded Files", label: "Discarded upgrade files",
		riskFlags:     []string{RiskRemovesOSRollback},
		estimatePaths: []string{`%SystemDrive%\$WINDOWS.~BT`, `%SystemDrive%\$WINDOWS.~WS`}},
	{slug: "windows_upgrade_log_files", keyName: "Windows Upgrade Log Files", label: "Windows upgrade log files",
		estimatePaths: []string{`%SystemDrive%\$Windows.~BT\Sources\Panther`, `%SystemRoot%\Panther`}},
	{slug: "setup_log_files", keyName: "Setup Log Files", label: "Setup log files",
		estimatePaths: []string{`%SystemRoot%\Logs`}},
	{slug: "temporary_setup_files", keyName: "Temporary Setup Files", label: "Temporary setup files"},
	{slug: "service_pack_cleanup", keyName: "Service Pack Cleanup", label: "Service pack backup files"},
	{slug: "system_error_memory_dump_files", keyName: "System error memory dump files", label: "System error memory dumps",
		estimatePaths: []string{`%SystemRoot%\MEMORY.DMP`}},
	{slug: "system_error_minidump_files", keyName: "System error minidump files", label: "System error minidumps",
		estimatePaths: []string{`%SystemRoot%\Minidump`}},
	{slug: "windows_error_reporting_files", keyName: "Windows Error Reporting Files", label: "Error reporting files"},
	{slug: "windows_error_reporting_system_archive_files", keyName: "Windows Error Reporting System Archive Files", label: "Error reporting archive"},
	{slug: "windows_error_reporting_system_queue_files", keyName: "Windows Error Reporting System Queue Files", label: "Error reporting queue"},
	// No estimatePaths on purpose (spec §13 #14): under the SYSTEM account the
	// handler covers %SystemRoot%\Temp AND the service profiles' temp
	// directories, so sizing it from one directory under-reports. An honest
	// "size unknown" beats a confidently low number.
	{slug: "temporary_files", keyName: "Temporary Files", label: "Temporary files"},
	{slug: "windows_defender", keyName: "Windows Defender", label: "Microsoft Defender scan history",
		estimatePaths: []string{`%ProgramData%\Microsoft\Windows Defender\Scans\History`}},
	{slug: "old_chkdsk_files", keyName: "Old ChkDsk Files", label: "Old ChkDsk fragments"},
	{slug: "diagnostic_data_viewer_database_files", keyName: "Diagnostic Data Viewer database files", label: "Diagnostic Data Viewer database"},
	{slug: "branchcache", keyName: "BranchCache", label: "BranchCache"},
	{slug: "content_indexer_cleaner", keyName: "Content Indexer Cleaner", label: "Search index fragments"},
}

// paths returns the directories whose size stands in for this handler, static
// and runtime-resolved alike. Empty means "opaque" — the handler reports
// estimateKnown:false rather than a number it cannot stand behind.
func (h winCleanmgrHandler) paths() []string {
	if h.estimatePathsFn != nil {
		return h.estimatePathsFn()
	}
	return h.estimatePaths
}

func winCleanmgrHandlerBySubID(subID string) (winCleanmgrHandler, bool) {
	slug := strings.TrimPrefix(subID, "win_cleanmgr:")
	if slug == subID {
		return winCleanmgrHandler{}, false
	}
	for _, handler := range winCleanmgrHandlers {
		if handler.slug == slug {
			return handler, true
		}
	}
	return winCleanmgrHandler{}, false
}

// defaultDOCachePath is where Delivery Optimization keeps its cache when no
// policy moves it (spec §13 #14). NOT under SoftwareDistribution, which is
// where the original plan looked and where nothing DO-related lives.
const defaultDOCachePath = `%SystemDrive%\Windows\ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache`

// deliveryOptimizationCachePath applies the DOModifyCacheDrive policy value.
//
// The policy accepts either a bare drive ("E:") or an explicit folder
// ("D:\DOCache"). A drive letter keeps the default tail; a folder is used
// verbatim. Pure, so the three cases are table-tested on any host.
func deliveryOptimizationCachePath(policyValue string) string {
	trimmed := strings.TrimSpace(policyValue)
	if trimmed == "" {
		return defaultDOCachePath
	}
	if regexp.MustCompile(`^[A-Za-z]:\\?$`).MatchString(trimmed) {
		drive := strings.TrimSuffix(trimmed, `\`)
		return drive + `\Windows\ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache`
	}
	return strings.TrimSuffix(trimmed, `\`)
}

func cleanmgrArgs() []string { return []string{"/sagerun:5555"} }

// /English FIRST: DISM's output is localised, and every field
// parseDismAnalyze looks for is an English literal (spec §7.1).
func dismAnalyzeArgs() []string {
	return []string{"/English", "/Online", "/Cleanup-Image", "/AnalyzeComponentStore"}
}

// StartComponentCleanup only. /ResetBase makes every installed update
// permanent and is out of scope by design (spec §1, §10 item 7).
func dismCleanupArgs() []string {
	return []string{"/English", "/Online", "/Cleanup-Image", "/StartComponentCleanup"}
}

func systemRoot() string {
	if root := os.Getenv("SystemRoot"); root != "" {
		return root
	}
	return `C:\Windows`
}

func expandPercentVars(path string) string {
	expanded := path
	for _, name := range []string{"SystemRoot", "SystemDrive", "ProgramData", "windir"} {
		if value := os.Getenv(name); value != "" {
			expanded = strings.ReplaceAll(expanded, "%"+name+"%", value)
		}
	}
	return expanded
}

// DISM reports 1024-based sizes with a two-character suffix ("1.64 GB"), which
// matches neither apt's 1000-based grammar nor dnf's single-letter one.
var dismSizePattern = regexp.MustCompile(`^([0-9]+(?:\.[0-9]+)?)\s*(bytes|KB|MB|GB|TB)$`)

var dismUnitFactor = map[string]float64{
	"bytes": 1, "KB": 1 << 10, "MB": 1 << 20, "GB": 1 << 30, "TB": 1 << 40,
}

func parseDismSize(text string) (int64, bool) {
	match := dismSizePattern.FindStringSubmatch(strings.TrimSpace(text))
	if match == nil {
		return 0, false
	}
	amount, err := strconv.ParseFloat(match[1], 64)
	if err != nil || amount < 0 {
		return 0, false
	}
	bytes := amount * dismUnitFactor[match[2]]
	if bytes > float64(math.MaxInt64) {
		return 0, false
	}
	return int64(math.Round(bytes)), true
}

var dismBackupsPattern = regexp.MustCompile(`Backups and Disabled Features\s*:\s*([0-9.]+\s*(?:bytes|KB|MB|GB|TB))`)
var dismCachePattern = regexp.MustCompile(`Cache and Temporary Data\s*:\s*([0-9.]+\s*(?:bytes|KB|MB|GB|TB))`)
var dismRecommendedNoPattern = regexp.MustCompile(`Component Store Cleanup Recommended\s*:\s*No`)

// parseDismAnalyze sums the two reclaimable fields of AnalyzeComponentStore
// and reports whether Windows recommends the cleanup.
//
// The figure is a HEURISTIC, not an upper bound (spec §13 #14). The original
// plan called it an upper bound on the strength of a 30-day grace period that
// does not apply here: that grace belongs to the SCHEDULED
// StartComponentCleanup task, not to the explicit invocation this action
// makes. The two fields are component-store *overhead*, which can be more or
// less than what the run actually frees.
//
// `Component Store Cleanup Recommended : No` is NOT a zero either — it means
// Windows does not think the cleanup is worth doing, which is a different
// claim from "nothing would be freed". The sum is reported in both cases and
// the recommendation rides alongside it so the UI can say so.
//
// An unrecognised body is unknown, never 0.
func parseDismAnalyze(stdout string) (bytes int64, known bool, recommended bool) {
	backups := dismBackupsPattern.FindStringSubmatch(stdout)
	cache := dismCachePattern.FindStringSubmatch(stdout)
	if backups == nil || cache == nil {
		return 0, false, false
	}
	backupBytes, backupOK := parseDismSize(backups[1])
	cacheBytes, cacheOK := parseDismSize(cache[1])
	if !backupOK || !cacheOK {
		return 0, false, false
	}
	return backupBytes + cacheBytes, true, !dismRecommendedNoPattern.MatchString(stdout)
}

// ---------------------------------------------------------------------------
// win_cleanmgr
// ---------------------------------------------------------------------------

type winCleanmgrAction struct {
	// selectedSlugs is empty for the catalogue listing and for a bare
	// `win_cleanmgr` selection, which means "every allowlisted handler present
	// on this device".
	selectedSlugs []string
}

func (winCleanmgrAction) ID() string { return "win_cleanmgr" }

func (a winCleanmgrAction) Describe() ActionInfo {
	return ActionInfo{
		ID:             a.ID(),
		Label:          "Windows Disk Cleanup",
		Description:    "Runs the built-in Disk Cleanup handlers you select. Downloads, per-user caches, recovery images and language packs are never offered.",
		OS:             "windows",
		RiskFlags:      []string{RiskLongRunning},
		AffectsVolumes: []string{},
	}
}

func (winCleanmgrAction) Available(context.Context) (bool, string) {
	if _, ok := resolveBinary(systemRoot() + cleanmgrBinaryRelative); !ok {
		return false, "cleanmgr.exe not present"
	}
	if _, err := presentVolumeCaches(); err != nil {
		return false, "Disk Cleanup handlers are not registered on this build"
	}
	return true, ""
}

// Estimate is the sum of the known handler directories; handlers with no known
// directory (Update Cleanup above all) contribute nothing, so the total is a
// lower bound on an upper bound and is presented as "up to".
func (a winCleanmgrAction) Estimate(context.Context) (int64, bool, string) {
	var total int64
	known := false
	for _, handler := range a.availableHandlers() {
		for _, path := range handler.paths() {
			size, ok := directorySize(expandWindowsPath(path))
			if !ok {
				continue
			}
			total += size
			known = true
		}
	}
	if !known {
		return 0, false, ""
	}
	return total, true, "sum of the handler directories whose location is known; opaque handlers are not counted"
}

// availableHandlers intersects the allowlist with the handlers this build
// actually registers.
func (a winCleanmgrAction) availableHandlers() []winCleanmgrHandler {
	present, err := presentVolumeCaches()
	if err != nil {
		return nil
	}
	presentSet := make(map[string]bool, len(present))
	for _, name := range present {
		presentSet[strings.ToLower(name)] = true
	}
	selected := make(map[string]bool, len(a.selectedSlugs))
	for _, slug := range a.selectedSlugs {
		selected[slug] = true
	}

	out := make([]winCleanmgrHandler, 0, len(winCleanmgrHandlers))
	for _, handler := range winCleanmgrHandlers {
		if !presentSet[strings.ToLower(handler.keyName)] {
			continue
		}
		if len(selected) > 0 && !selected[handler.slug] {
			continue
		}
		out = append(out, handler)
	}
	return out
}

// SubActions is the catalogue's per-handler listing, with the localised label
// where SHLoadIndirectString could resolve one and the fixed friendly label
// otherwise.
func (a winCleanmgrAction) SubActions() []SubActionInfo {
	all := winCleanmgrAction{}.availableHandlers()
	out := make([]SubActionInfo, 0, len(all))
	for _, handler := range all {
		label := handlerDisplayName(handler.keyName)
		if label == "" {
			label = handler.label
		}
		info := SubActionInfo{ID: "win_cleanmgr:" + handler.slug, Label: label}
		for _, path := range handler.paths() {
			if size, ok := directorySize(expandWindowsPath(path)); ok {
				info.EstimateBytes += size
				info.EstimateKnown = true
			}
		}
		out = append(out, info)
	}
	return out
}

// Run rewrites the ENTIRE StateFlags5555 profile, then runs cleanmgr
// /sagerun:5555.
//
// Profile hygiene (spec §13 #4) is the safety-critical part, and it is why
// this writes 0 to **every** VolumeCaches subkey rather than only to the
// allowlisted ones it did not select:
//
//   - `/sagerun:5555` executes every handler whose StateFlags5555 is 2,
//     wherever that value came from. A third-party cleanup handler, an OEM
//     one, or an excluded built-in (DownloadsFolder) that already carries a 2
//     — set by another tool, by a prior Breeze run, or by a user who once ran
//     `cleanmgr /sageset:5555` — would run alongside the selection with no
//     trace in the result. The allowlist constrains what Breeze may SELECT; it
//     cannot constrain what the shared profile already says.
//   - Any write failure aborts BEFORE cleanmgr starts. A half-written profile
//     is worse than no run: it executes an arbitrary subset that matches
//     neither what the tech chose nor what the result will claim.
//   - Nothing is restored afterwards. Profile 5555 is Breeze-owned by
//     convention, the next run rewrites it wholesale, and "restoring" a
//     profile another tool may have edited concurrently would be a second
//     guess at state we do not own.
//
// HKLM\SOFTWARE\...\VolumeCaches is trusted as admin-only: a caller who can
// write there can already run cleanmgr directly. Handler key names are treated
// as LABELS, not as authenticity — the allowlist is a list of things Breeze
// offers, not proof that a key of that name is the Microsoft handler.
//
// Session-0 caveat (spec §7.2): under the SYSTEM account cleanmgr renders a
// hidden progress UI and is documented to return before its work finishes or
// to hang outright. The runner therefore waits on the whole process tree (the
// job object in process_tree_windows.go), treats the exit code as
// INFORMATIONAL ONLY, and reports timed_out with partial status at the 60
// minute cap. The acceptance criterion for this action is the W05 lab run
// (Task 17), not a unit test — nothing here can prove session-0 behaviour.
//
// The process-wide maintenance lock is held by the RUN (catalog.go), not
// acquired here: two runs rewriting this one shared profile is exactly the
// interleaving that lock exists to prevent.
func (a winCleanmgrAction) Run(ctx context.Context, _ Params) ActionResult {
	started := time.Now()
	binary, ok := resolveBinary(systemRoot() + cleanmgrBinaryRelative)
	if !ok {
		return ActionResult{ID: a.ID(), Status: StatusUnavailable, ExitCode: 1, Error: "cleanmgr.exe not present"}
	}

	selected := a.availableHandlers()
	if len(selected) == 0 {
		return ActionResult{ID: a.ID(), Status: StatusUnavailable, ExitCode: 1,
			Error: "none of the selected Disk Cleanup handlers are registered on this build"}
	}
	selectedSet := make(map[string]bool, len(selected))
	for _, handler := range selected {
		selectedSet[handler.keyName] = true
	}

	present, err := presentVolumeCaches()
	if err != nil {
		return ActionResult{ID: a.ID(), Status: StatusFailed, ExitCode: 1,
			DurationMs: time.Since(started).Milliseconds(),
			Error:      fmt.Sprintf("could not enumerate the Disk Cleanup handlers: %v", err)}
	}

	// Pass 1: write the whole profile. EVERY subkey on the machine, not just
	// the allowlisted ones.
	zeroed := 0
	for _, keyName := range present {
		value := uint32(0)
		if selectedSet[keyName] {
			value = 2
		}
		if err := setStateFlags(keyName, value); err != nil {
			// Abort before cleanmgr runs. See the profile-hygiene note above:
			// a partially written profile executes an arbitrary subset.
			return ActionResult{
				ID:         a.ID(),
				Status:     StatusFailed,
				ExitCode:   1,
				DurationMs: time.Since(started).Milliseconds(),
				Error: fmt.Sprintf(
					"could not set %s on %q (%v); aborted before running cleanmgr so no unintended handler could execute",
					stateFlagsValue, keyName, err),
			}
		}
		if value == 0 {
			zeroed++
		}
	}

	subResults := make([]SubActionRun, 0, len(selected))
	for _, handler := range selected {
		subResults = append(subResults, SubActionRun{ID: "win_cleanmgr:" + handler.slug, Status: StatusCompleted})
	}
	notes := []string{fmt.Sprintf("profile %s: %d handler(s) enabled, %d zeroed", stateFlagsValue, len(selected), zeroed)}

	proc := runProcess(ctx, cleanmgrTimeout, binary, cleanmgrArgs()...)
	result := ActionResult{
		ID:         a.ID(),
		SubActions: subResults,
		ExitCode:   proc.ExitCode,
		DurationMs: time.Since(started).Milliseconds(),
		OutputTail: capOutput([]byte(strings.Join(append(notes, proc.Stdout, proc.Stderr), "\n"))),
	}
	switch {
	case proc.TimedOut:
		result.Status = StatusTimedOut
		result.Error = proc.Err.Error()
	case proc.Err != nil:
		result.Status = StatusFailed
		result.Error = proc.Err.Error()
	default:
		// Exit code is informational only — see the session-0 caveat above.
		result.Status = StatusCompleted
	}
	return result
}

// ---------------------------------------------------------------------------
// win_dism_component_cleanup
// ---------------------------------------------------------------------------

type winDismCleanupAction struct{}

func (winDismCleanupAction) ID() string { return "win_dism_component_cleanup" }

func (a winDismCleanupAction) Describe() ActionInfo {
	return ActionInfo{
		ID:    a.ID(),
		Label: "Component store cleanup (DISM)",
		Description: "Removes superseded components from the WinSxS store. Installed updates stay removable — this never runs /ResetBase. " +
			"Some of the space is only released after the next restart.",
		OS:             "windows",
		RiskFlags:      []string{RiskLongRunning, RiskMayRequireRebootFree},
		AffectsVolumes: []string{},
	}
}

func (winDismCleanupAction) Available(context.Context) (bool, string) {
	if _, ok := resolveBinary(systemRoot() + dismBinaryRelative); !ok {
		return false, "dism.exe not present"
	}
	return true, ""
}

func (winDismCleanupAction) Estimate(ctx context.Context) (int64, bool, string) {
	binary, ok := resolveBinary(systemRoot() + dismBinaryRelative)
	if !ok {
		return 0, false, ""
	}
	proc := runProcess(ctx, windowsEstimateLimit, binary, dismAnalyzeArgs()...)
	bytes, known, recommended := parseDismAnalyze(proc.Stdout)
	if !known {
		return 0, false, ""
	}
	detail := "heuristic: DISM /AnalyzeComponentStore reports component-store overhead, which is not the same as what the cleanup frees"
	if !recommended {
		detail += "; Windows does not currently recommend this cleanup"
	}
	return bytes, true, detail
}

func (a winDismCleanupAction) Run(ctx context.Context, _ Params) ActionResult {
	binary, ok := resolveBinary(systemRoot() + dismBinaryRelative)
	if !ok {
		return ActionResult{ID: a.ID(), Status: StatusUnavailable, ExitCode: 1, Error: "dism.exe not present"}
	}
	return resultFromProc(a.ID(), runProcess(ctx, dismCleanupTimeout, binary, dismCleanupArgs()...))
}

func windowsActions() []Action {
	return []Action{winCleanmgrAction{}, winDismCleanupAction{}}
}
```

- [ ] **Step 5: Run it and watch it pass**

```bash
cd agent && go test -race ./internal/syscleanup/...
```

Expected: `ok github.com/breeze-rmm/agent/internal/syscleanup` — 46 tests.

- [ ] **Step 6: Cross-vet both non-Linux builds**

```bash
cd agent && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go vet ./internal/syscleanup/... \
  && GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go vet ./internal/syscleanup/...
```

Expected: no output. (`scripts/check-windows-vet.sh` baselines `unsafeptr` per file; `handlerDisplayName`'s `unsafe.Pointer` use passes `go vet` because the pointers are to live locals — if the script reports a new `unsafeptr` finding, add the file to its baseline with the reason, do not silence the analyser.)

- [ ] **Step 7: Commit**

```bash
git add agent/internal/syscleanup/windows.go agent/internal/syscleanup/windows_test.go agent/internal/syscleanup/windows_registry_windows.go agent/internal/syscleanup/windows_registry_other.go
git commit -m "$(cat <<'MSG'
feat(agent): Windows system-cleanup actions (cleanmgr allowlist, DISM cleanup)

The 20-handler allowlist from spec §7.2 with its four deliberate exclusions —
DownloadsFolder, Windows ESD installation files, Language Pack, and every
per-user handler — absent by construction and asserted absent by test. Registry
key names are never accepted from the wire: a handler is addressed by slug and
the slug maps to a key name through a Go constant.

Every allowlisted handler NOT selected is explicitly written StateFlags5555=0,
because a stale 2 from an earlier run would silently widen the current one.
DISM is /English-first so the analyze parser is deterministic on a non-English
endpoint, and /ResetBase is unreachable.

cleanmgr's exit code is informational only and the runner waits on the whole
job object: under the SYSTEM account it renders a hidden progress UI and is
documented to return early or hang. That behaviour is gated by the W05 lab run,
not by a unit test.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
)"
```

---

### Task 7: `List` and `Run` — the catalogue orchestration

**Files:**
- Create: `agent/internal/syscleanup/catalog.go`
- Create: `agent/internal/syscleanup/catalog_test.go` (Test)

**Interfaces:**
- Consumes: `linuxActions`, `darwinActions`, `windowsActions`, `sampleVolumes`, `fixedVolumes`, `measureFreed`, `IsKnownActionID`, `winCleanmgrHandlerBySubID`.
- Produces:
  ```go
  type CatalogAction struct {
      ID, Label, Description, OS string   `json:"…"`
      SubActions       []SubActionInfo    `json:"subActions,omitempty"`
      Available        bool               `json:"available"`
      UnavailableReason string            `json:"unavailableReason,omitempty"`
      EstimateBytes    int64              `json:"estimateBytes,omitempty"`
      EstimateKnown    bool               `json:"estimateKnown"`
      EstimateDetail   string             `json:"estimateDetail,omitempty"`
      RiskFlags        []string           `json:"riskFlags"`
      AffectsVolumes   []string           `json:"affectsVolumes"`
  }
  type ListResult struct {
      CatalogVersion int             `json:"catalogVersion"`
      Actions        []CatalogAction `json:"actions"`
      VolumesBefore  []VolumeFree    `json:"volumesBefore"`
  }
  type RunResult struct {
      RunID      string         `json:"runId"`
      Actions    []ActionResult `json:"actions"`
      Volumes    []VolumeDelta  `json:"volumes"`
      FreedBytes int64          `json:"freedBytes"`
  }
  const estimateBudget = 3 * time.Minute
  func platformActions() []Action
  func List(ctx context.Context) ListResult
  func Run(ctx context.Context, runID string, actionIDs []string, params Params) RunResult
  func RunBudget(actionIDs []string) time.Duration
  func ActionTimeout(id string) time.Duration
  ```

- [ ] **Step 1: Write the failing test** — create `agent/internal/syscleanup/catalog_test.go`:

```go
package syscleanup

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/maintenance"
)

type fakeAction struct {
	id        string
	available bool
	reason    string
	estimate  int64
	known     bool
	estimateDelay time.Duration
	runDelay  time.Duration
	status    string
	ran       *int32
	order     *[]string
}

func (f fakeAction) ID() string { return f.id }
func (f fakeAction) Describe() ActionInfo {
	return ActionInfo{ID: f.id, Label: "L " + f.id, Description: "D " + f.id, OS: "linux",
		RiskFlags: []string{}, AffectsVolumes: []string{"/"}}
}
func (f fakeAction) Available(context.Context) (bool, string) { return f.available, f.reason }
func (f fakeAction) Estimate(ctx context.Context) (int64, bool, string) {
	if f.estimateDelay > 0 {
		select {
		case <-time.After(f.estimateDelay):
		case <-ctx.Done():
			return 0, false, ""
		}
	}
	return f.estimate, f.known, "detail " + f.id
}
func (f fakeAction) Run(ctx context.Context, _ Params) ActionResult {
	if f.order != nil {
		*f.order = append(*f.order, f.id)
	}
	if f.ran != nil {
		atomic.AddInt32(f.ran, 1)
	}
	if f.runDelay > 0 {
		select {
		case <-time.After(f.runDelay):
		case <-ctx.Done():
		}
	}
	status := f.status
	if status == "" {
		status = StatusCompleted
	}
	return ActionResult{ID: f.id, Status: status, ExitCode: 0}
}

func withActions(t *testing.T, actions []Action) {
	t.Helper()
	original := platformActionsFn
	t.Cleanup(func() { platformActionsFn = original })
	platformActionsFn = func() []Action { return actions }
}

func withVolumes(t *testing.T, before, after []VolumeFree) {
	t.Helper()
	originalMounts, originalUsage := fixedVolumesFn, usageFreeFn
	t.Cleanup(func() { fixedVolumesFn, usageFreeFn = originalMounts, originalUsage })

	mounts := make([]string, 0, len(before))
	for _, volume := range before {
		mounts = append(mounts, volume.Mount)
	}
	fixedVolumesFn = func() []string { return mounts }

	var call int32
	afterByMount := map[string]int64{}
	for _, volume := range after {
		afterByMount[volume.Mount] = volume.FreeBytes
	}
	beforeByMount := map[string]int64{}
	for _, volume := range before {
		beforeByMount[volume.Mount] = volume.FreeBytes
	}
	usageFreeFn = func(mount string) (int64, error) {
		if atomic.LoadInt32(&call) == 0 {
			return beforeByMount[mount], nil
		}
		value, ok := afterByMount[mount]
		if !ok {
			return 0, errors.New("gone")
		}
		return value, nil
	}
	t.Cleanup(func() { atomic.StoreInt32(&call, 0) })
	// Flip to the "after" sample once Run has taken its first reading.
	t.Cleanup(func() {})
	advanceVolumeSample = func() { atomic.StoreInt32(&call, 1) }
}

func TestListReportsEveryActionWithItsAvailability(t *testing.T) {
	withActions(t, []Action{
		fakeAction{id: "a", available: true, estimate: 100, known: true},
		fakeAction{id: "b", available: false, reason: "dism.exe not present"},
	})
	withVolumes(t, []VolumeFree{{Mount: "/", FreeBytes: 10}}, []VolumeFree{{Mount: "/", FreeBytes: 10}})

	got := List(context.Background())
	if got.CatalogVersion != CatalogVersion {
		t.Fatalf("CatalogVersion = %d", got.CatalogVersion)
	}
	if len(got.Actions) != 2 {
		t.Fatalf("len(Actions) = %d, want 2", len(got.Actions))
	}
	if !got.Actions[0].Available || got.Actions[0].EstimateBytes != 100 || !got.Actions[0].EstimateKnown {
		t.Fatalf("Actions[0] = %+v", got.Actions[0])
	}
	if got.Actions[1].Available || got.Actions[1].UnavailableReason != "dism.exe not present" {
		t.Fatalf("Actions[1] = %+v", got.Actions[1])
	}
	// An unavailable action is never estimated — running dism to price an
	// action the device cannot perform is pure cost.
	if got.Actions[1].EstimateKnown {
		t.Error("an unavailable action must not report a known estimate")
	}
	if len(got.VolumesBefore) != 1 || got.VolumesBefore[0].Mount != "/" {
		t.Fatalf("VolumesBefore = %+v", got.VolumesBefore)
	}
}

// Estimation is concurrent with an overall 3-minute cap; an action whose
// estimate times out reports estimateKnown:false rather than stalling the
// whole list (spec §7.3).
func TestListCapsTheOverallEstimateBudget(t *testing.T) {
	withActions(t, []Action{
		fakeAction{id: "fast", available: true, estimate: 7, known: true},
		fakeAction{id: "slow", available: true, estimate: 9, known: true, estimateDelay: 5 * time.Second},
	})
	withVolumes(t, nil, nil)

	original := estimateBudget
	t.Cleanup(func() { estimateBudget = original })
	estimateBudget = 150 * time.Millisecond

	started := time.Now()
	got := List(context.Background())
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("List blocked for %s past its %s budget", elapsed, estimateBudget)
	}
	byID := map[string]CatalogAction{}
	for _, action := range got.Actions {
		byID[action.ID] = action
	}
	if !byID["fast"].EstimateKnown || byID["fast"].EstimateBytes != 7 {
		t.Fatalf("fast = %+v", byID["fast"])
	}
	if byID["slow"].EstimateKnown {
		t.Fatalf("slow must report estimateKnown:false after the budget expires; got %+v", byID["slow"])
	}
}

// Sequential, in catalogue order — cleanmgr and DISM must never overlap
// (spec §7.3).
func TestRunExecutesSequentiallyInCatalogueOrder(t *testing.T) {
	var order []string
	withActions(t, []Action{
		fakeAction{id: "first", available: true, order: &order},
		fakeAction{id: "second", available: true, order: &order},
		fakeAction{id: "third", available: true, order: &order},
	})
	withVolumes(t, []VolumeFree{{Mount: "/", FreeBytes: 1_000}}, []VolumeFree{{Mount: "/", FreeBytes: 4_000}})

	got := Run(context.Background(), "run-1", []string{"third", "first"}, Params{})
	if strings.Join(order, ",") != "first,third" {
		t.Fatalf("execution order = %v, want catalogue order [first third] regardless of request order", order)
	}
	if got.RunID != "run-1" || len(got.Actions) != 2 {
		t.Fatalf("RunResult = %+v", got)
	}
	if got.FreedBytes != 3_000 {
		t.Fatalf("FreedBytes = %d, want the measured 3000", got.FreedBytes)
	}
}

// One failing action does not stop the next (spec §7.3).
func TestRunContinuesAfterAFailure() {}

func TestRunContinuesPastAFailedAction(t *testing.T) {
	var ran int32
	withActions(t, []Action{
		fakeAction{id: "boom", available: true, status: StatusFailed, ran: &ran},
		fakeAction{id: "after", available: true, ran: &ran},
	})
	withVolumes(t, nil, nil)

	got := Run(context.Background(), "run-2", []string{"boom", "after"}, Params{})
	if atomic.LoadInt32(&ran) != 2 {
		t.Fatalf("ran %d actions, want 2 — a failure must not stop the run", ran)
	}
	if got.Actions[0].Status != StatusFailed || got.Actions[1].Status != StatusCompleted {
		t.Fatalf("Actions = %+v", got.Actions)
	}
}

// An unavailable action is reported, not attempted.
func TestRunReportsUnavailableWithoutExecuting(t *testing.T) {
	var ran int32
	withActions(t, []Action{fakeAction{id: "nope", available: false, reason: "tmutil not present", ran: &ran}})
	withVolumes(t, nil, nil)

	got := Run(context.Background(), "run-3", []string{"nope"}, Params{})
	if atomic.LoadInt32(&ran) != 0 {
		t.Fatal("an unavailable action must not be executed")
	}
	if got.Actions[0].Status != StatusUnavailable || got.Actions[0].Error != "tmutil not present" {
		t.Fatalf("Actions[0] = %+v", got.Actions[0])
	}
}

// Spec §13 #14: Σ the selected actions' own timeouts + 10 min, capped at 3 h.
func TestRunBudgetIsTheSumOfSelectedTimeoutsPlusSlack(t *testing.T) {
	cases := []struct {
		ids  []string
		want time.Duration
	}{
		{[]string{"linux_pkg_cache_clean"}, 5*time.Minute + 10*time.Minute},
		{[]string{"linux_pkg_cache_clean", "linux_journal_vacuum"}, 5*time.Minute + 5*time.Minute + 10*time.Minute},
		// cleanmgr 60 + DISM 90 + 10 = 160 min. A flat two-hour constant
		// would have reaped this mid-DISM.
		{[]string{"win_cleanmgr", "win_dism_component_cleanup"}, 160 * time.Minute},
		// A bare win_cleanmgr and its sub-ids are ONE execution, counted once.
		{[]string{"win_cleanmgr", "win_cleanmgr:update_cleanup", "win_cleanmgr:setup_log_files"}, 70 * time.Minute},
		// Unknown ids contribute nothing.
		{[]string{"linux_pkg_cache_clean", "not_an_action"}, 15 * time.Minute},
		{nil, 10 * time.Minute},
	}
	for _, tc := range cases {
		if got := RunBudget(tc.ids); got != tc.want {
			t.Errorf("RunBudget(%v) = %s, want %s", tc.ids, got, tc.want)
		}
	}
	// Cap: every action at once still cannot exceed three hours.
	if got := RunBudget(ActionIDs); got != 3*time.Hour {
		t.Fatalf("RunBudget(everything) = %s, want the 3h cap", got)
	}
}

// Spec §13 #4/#12: a second run while another maintenance operation holds the
// lock touches NOTHING and says `busy` — not `failed`, because nothing was
// attempted and a retry is the right next step.
func TestRunReportsBusyWithoutTouchingAnythingWhenTheLockIsHeld(t *testing.T) {
	var ran int32
	withActions(t, []Action{fakeAction{id: "linux_pkg_cache_clean", available: true, ran: &ran}})
	withVolumes(t, nil, nil)

	release, err := maintenance.TryAcquire("brew_cleanup")
	if err != nil {
		t.Fatal(err)
	}
	defer release()

	got := Run(context.Background(), "run-5", []string{"linux_pkg_cache_clean"}, Params{})
	if atomic.LoadInt32(&ran) != 0 {
		t.Fatal("no action may execute while the maintenance lock is held")
	}
	if len(got.Actions) != 1 || got.Actions[0].Status != StatusBusy {
		t.Fatalf("Actions = %+v, want a single busy entry", got.Actions)
	}
	if !strings.Contains(got.Actions[0].Error, "brew_cleanup") {
		t.Fatalf("the busy error should name the holder; got %q", got.Actions[0].Error)
	}
}

// Spec §13 #14: an action the aggregate budget never reached is `not_started`,
// which is a different fact from `timed_out` (that one ran and overran).
func TestRunReportsNotStartedForActionsTheBudgetNeverReached(t *testing.T) {
	var ran int32
	withActions(t, []Action{
		fakeAction{id: "first", available: true, runDelay: 400 * time.Millisecond, ran: &ran},
		fakeAction{id: "second", available: true, ran: &ran},
	})
	withVolumes(t, []VolumeFree{{Mount: "/", FreeBytes: 1}}, []VolumeFree{{Mount: "/", FreeBytes: 2}})

	original := runBudgetForTests
	t.Cleanup(func() { runBudgetForTests = original })
	runBudgetForTests = 150 * time.Millisecond

	got := Run(context.Background(), "run-6", []string{"first", "second"}, Params{})
	if len(got.Actions) != 2 {
		t.Fatalf("Actions = %+v", got.Actions)
	}
	if got.Actions[1].Status != StatusNotStarted {
		t.Fatalf("Actions[1].Status = %q, want not_started", got.Actions[1].Status)
	}
	// The measurement still runs after a budget expiry, or a timed-out run
	// would report zero bytes for work it really did.
	if got.FreedBytes != 1 {
		t.Fatalf("FreedBytes = %d, want the measured 1 even after the budget expired", got.FreedBytes)
	}
}

// The closed catalogue, enforced agent-side as defence in depth behind the
// server's own validation (spec §5.3, §10 item 7).
func TestRunDropsAnyIDOutsideTheCatalogue(t *testing.T) {
	var ran int32
	withActions(t, []Action{fakeAction{id: "linux_journal_vacuum", available: true, ran: &ran}})
	withVolumes(t, nil, nil)

	got := Run(context.Background(), "run-4", []string{"linux_journal_vacuum", "rm -rf /", "win_cleanmgr:DownloadsFolder"}, Params{})
	if len(got.Actions) != 1 || got.Actions[0].ID != "linux_journal_vacuum" {
		t.Fatalf("Actions = %+v, want only the catalogue id", got.Actions)
	}
	if atomic.LoadInt32(&ran) != 1 {
		t.Fatalf("ran = %d, want 1", ran)
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd agent && go test -race ./internal/syscleanup/...
```

Expected failure: `internal/syscleanup/catalog_test.go:…: undefined: platformActionsFn` … `[build failed]`. (Also delete the stray empty `TestRunContinuesAfterAFailure` helper if `go vet` flags it — it is listed above only to make the intent explicit; remove it before committing.)

- [ ] **Step 3: Implement** — create `agent/internal/syscleanup/catalog.go`:

```go
package syscleanup

import (
	"context"
	"fmt"
	"runtime"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/maintenance"
)

// estimateBudget caps the WHOLE list call's estimation phase (spec §7.3).
// Estimates run concurrently; whatever has not answered when the budget
// expires reports estimateKnown:false. A var so tests can shrink it.
var estimateBudget = 3 * time.Minute

// CatalogAction is one row of the list result (spec §7.3).
type CatalogAction struct {
	ID                string          `json:"id"`
	Label             string          `json:"label"`
	Description       string          `json:"description"`
	OS                string          `json:"os"`
	SubActions        []SubActionInfo `json:"subActions,omitempty"`
	Available         bool            `json:"available"`
	UnavailableReason string          `json:"unavailableReason,omitempty"`
	EstimateBytes     int64           `json:"estimateBytes,omitempty"`
	EstimateKnown     bool            `json:"estimateKnown"`
	EstimateDetail    string          `json:"estimateDetail,omitempty"`
	RiskFlags         []string        `json:"riskFlags"`
	AffectsVolumes    []string        `json:"affectsVolumes"`
}

// ListResult is the system_cleanup_list command result (spec §7.3).
type ListResult struct {
	CatalogVersion int             `json:"catalogVersion"`
	Actions        []CatalogAction `json:"actions"`
	VolumesBefore  []VolumeFree    `json:"volumesBefore"`
}

// RunResult is the system_cleanup_run command result (spec §7.3).
type RunResult struct {
	RunID      string         `json:"runId"`
	Actions    []ActionResult `json:"actions"`
	Volumes    []VolumeDelta  `json:"volumes"`
	FreedBytes int64          `json:"freedBytes"`
}

// subActionProvider is implemented only by win_cleanmgr today. Kept as an
// optional interface rather than a method on Action so the other five actions
// do not carry an empty implementation.
type subActionProvider interface {
	SubActions() []SubActionInfo
}

// platformActionsFn and fixedVolumesFn are the two seams the catalogue tests
// replace. Everything else in this file is real.
var platformActionsFn = platformActions
var fixedVolumesFn = fixedVolumes

// advanceVolumeSample is a test hook, called between the two volume readings
// of a Run. It is a no-op in production.
var advanceVolumeSample = func() {}

// runBudgetForTests overrides RunBudget when positive, so the not_started
// branch can be exercised in milliseconds. Zero in production.
var runBudgetForTests time.Duration

func platformActions() []Action {
	switch runtime.GOOS {
	case "windows":
		return windowsActions()
	case "darwin":
		return darwinActions()
	case "linux":
		return linuxActions()
	default:
		return nil
	}
}

// List builds the catalogue for this device: availability first, then a
// concurrent estimation pass bounded by estimateBudget, then a free-space
// baseline the UI can show next to each estimate.
func List(ctx context.Context) ListResult {
	actions := platformActionsFn()
	rows := make([]CatalogAction, len(actions))

	estimateCtx, cancel := context.WithTimeout(ctx, estimateBudget)
	defer cancel()

	var wg sync.WaitGroup
	for i, action := range actions {
		info := action.Describe()
		available, reason := action.Available(ctx)
		rows[i] = CatalogAction{
			ID:                info.ID,
			Label:             info.Label,
			Description:       info.Description,
			OS:                info.OS,
			Available:         available,
			UnavailableReason: reason,
			RiskFlags:         info.RiskFlags,
			AffectsVolumes:    info.AffectsVolumes,
		}
		if provider, ok := action.(subActionProvider); ok {
			rows[i].SubActions = provider.SubActions()
		}
		if !available {
			// Never price an action the device cannot perform: running DISM
			// or apt to estimate something that will report `unavailable`
			// anyway is pure cost on the endpoint.
			continue
		}

		wg.Add(1)
		go func(index int, action Action) {
			defer wg.Done()
			bytes, known, detail := action.Estimate(estimateCtx)
			if estimateCtx.Err() != nil {
				known = false
			}
			rows[index].EstimateBytes = bytes
			rows[index].EstimateKnown = known
			rows[index].EstimateDetail = detail
			if !known {
				rows[index].EstimateBytes = 0
			}
		}(i, action)
	}

	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-estimateCtx.Done():
		// Budget spent. The goroutines still running observe the cancelled
		// context; their rows keep estimateKnown:false, which is the honest
		// answer (spec §7.1) rather than a confident zero.
	}

	return ListResult{
		CatalogVersion: CatalogVersion,
		Actions:        rows,
		VolumesBefore:  sampleVolumes(fixedVolumesFn()),
	}
}

// selectionFor resolves the requested ids into the actions to run, in
// CATALOGUE order regardless of the order they were requested in.
//
// Two rules the closed catalogue depends on:
//   - an id outside ActionIDs is DROPPED silently here. The server validates
//     first; this is the defence in depth that makes a forged command payload
//     inert (spec §10 item 7).
//   - `win_cleanmgr:<slug>` sub-ids collapse into ONE win_cleanmgr execution
//     carrying those slugs. A bare `win_cleanmgr` means every allowlisted
//     handler present on the device.
func selectionFor(actionIDs []string) []Action {
	requested := make(map[string]bool, len(actionIDs))
	var cleanmgrSlugs []string
	cleanmgrRequested := false
	for _, id := range actionIDs {
		if !IsKnownActionID(id) {
			continue
		}
		if handler, ok := winCleanmgrHandlerBySubID(id); ok {
			cleanmgrRequested = true
			cleanmgrSlugs = append(cleanmgrSlugs, handler.slug)
			continue
		}
		if id == "win_cleanmgr" {
			cleanmgrRequested = true
			cleanmgrSlugs = nil // bare id wins: every allowlisted handler
			continue
		}
		requested[id] = true
	}

	var selected []Action
	for _, action := range platformActionsFn() {
		if action.ID() == "win_cleanmgr" {
			if !cleanmgrRequested {
				continue
			}
			if concrete, ok := action.(winCleanmgrAction); ok {
				concrete.selectedSlugs = cleanmgrSlugs
				selected = append(selected, concrete)
				continue
			}
			selected = append(selected, action)
			continue
		}
		if requested[action.ID()] {
			selected = append(selected, action)
		}
	}
	return selected
}

// actionTimeouts is the per-action wall-clock cap, and — summed — the input to
// the aggregate run budget (spec §13 #14). Mirrored by
// SYSTEM_CLEANUP_ACTION_TIMEOUT_SECONDS in
// packages/shared/src/validators/systemCleanup.ts so the server can size the
// same budget before it queues; shared_ids_test.go compares the two.
var actionTimeouts = map[string]time.Duration{
	"win_cleanmgr":               cleanmgrTimeout,
	"win_dism_component_cleanup": dismCleanupTimeout,
	"mac_tm_local_snapshots":     darwinSnapshotTimeout,
	"mac_brew_cleanup":           darwinBrewTimeout,
	"linux_pkg_cache_clean":      linuxPkgCleanTimeout,
	"linux_pkg_autoremove":       linuxAutoremoveTimeout,
	"linux_journal_vacuum":       linuxJournalVacuumTimeout,
}

// Budget shape (spec §13 #14). Slack covers the probes, the two volume
// samples and process teardown; the cap stops a pathological selection from
// reserving a whole shift.
const (
	runBudgetSlack = 10 * time.Minute
	runBudgetMax   = 3 * time.Hour
)

// ActionTimeout is the wall-clock cap for one action; 0 for an unknown id.
func ActionTimeout(id string) time.Duration {
	if handler, ok := winCleanmgrHandlerBySubID(id); ok {
		_ = handler
		id = "win_cleanmgr"
	}
	return actionTimeouts[id]
}

// RunBudget sizes one run: Σ the selected actions' own timeouts + 10 minutes,
// capped at 3 h.
//
// A single constant was wrong in both directions: a lone
// `linux_pkg_cache_clean` would hold a two-hour budget for five minutes of
// work, while cleanmgr (60 min) plus DISM (90 min) needs 150 and would have
// been reaped at 120 — mid-DISM, on a component store that is then left
// half-serviced.
//
// Duplicate ids (a bare `win_cleanmgr` alongside its sub-ids) are counted
// once: they collapse into one execution.
func RunBudget(actionIDs []string) time.Duration {
	counted := map[string]bool{}
	total := time.Duration(0)
	for _, id := range actionIDs {
		if !IsKnownActionID(id) {
			continue
		}
		key := id
		if _, ok := winCleanmgrHandlerBySubID(id); ok {
			key = "win_cleanmgr"
		}
		if counted[key] {
			continue
		}
		counted[key] = true
		total += actionTimeouts[key]
	}
	total += runBudgetSlack
	if total > runBudgetMax {
		return runBudgetMax
	}
	return total
}

// Run executes the selected actions SEQUENTIALLY in catalogue order — cleanmgr
// and DISM must not overlap (spec §7.3) — under the process-wide maintenance
// lock and one aggregate budget, and measures the free-space delta across the
// whole run.
//
// Three outcomes that are deliberately distinguishable:
//   - `busy`: another maintenance operation holds the lock. Nothing was
//     attempted, so this is not a failure and a retry is the right next step
//     (spec §13 #4/#12). TryAcquire, not Acquire: a tech is watching a
//     spinner, and blocking inside the run budget would spend it waiting.
//   - `not_started`: the aggregate budget expired before this action's turn.
//     Distinct from `timed_out`, which means the action ran and overran its
//     own cap — the two call for different next steps (re-run the rest vs
//     investigate this one).
//   - `unavailable`: reported without being attempted.
//
// One action failing never stops the next: a tech who selected four things
// wants the other three to happen, and the per-action status is what tells
// them which one did not.
func Run(ctx context.Context, runID string, actionIDs []string, params Params) RunResult {
	selected := selectionFor(actionIDs)

	release, err := maintenance.TryAcquire("system_cleanup_run")
	if err != nil {
		results := make([]ActionResult, 0, len(selected))
		for _, action := range selected {
			results = append(results, ActionResult{
				ID: action.ID(), Status: StatusBusy, ExitCode: 1,
				Error: fmt.Sprintf("%v (holder: %s)", err, maintenance.CurrentOwner()),
			})
		}
		return RunResult{RunID: runID, Actions: results, Volumes: []VolumeDelta{}, FreedBytes: 0}
	}
	defer release()

	budget := RunBudget(actionIDs)
	if runBudgetForTests > 0 {
		budget = runBudgetForTests
	}
	budgetCtx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()

	mounts := fixedVolumesFn()
	before := sampleVolumes(mounts)

	results := make([]ActionResult, 0, len(selected))
	for _, action := range selected {
		if budgetCtx.Err() != nil {
			results = append(results, ActionResult{
				ID: action.ID(), Status: StatusNotStarted, ExitCode: 1,
				Error: "the run budget expired before this action started",
			})
			continue
		}
		if available, reason := action.Available(budgetCtx); !available {
			results = append(results, ActionResult{
				ID: action.ID(), Status: StatusUnavailable, ExitCode: 1, Error: reason,
			})
			continue
		}
		results = append(results, action.Run(budgetCtx, params))
	}

	advanceVolumeSample()
	// The measurement uses the PARENT context's lifetime, not budgetCtx: two
	// disk.Usage calls must still happen after a budget expiry, or a run that
	// timed out would report zero freed bytes for work it really did.
	after := sampleVolumes(mounts)
	volumes, freed := measureFreed(before, after)

	return RunResult{RunID: runID, Actions: results, Volumes: volumes, FreedBytes: freed}
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd agent && go test -race ./internal/syscleanup/...
```

Expected: `ok github.com/breeze-rmm/agent/internal/syscleanup` — 52 tests. If `TestListCapsTheOverallEstimateBudget` is flaky on a loaded runner, widen the injected budget (150 ms → 400 ms) and the slow action's delay proportionally; do not remove the assertion.

- [ ] **Step 5: Cross-vet and commit**

```bash
cd agent && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go vet ./internal/syscleanup/... \
  && GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go vet ./internal/syscleanup/...
git add agent/internal/syscleanup/catalog.go agent/internal/syscleanup/catalog_test.go
git commit -m "$(cat <<'MSG'
feat(agent): syscleanup List and Run orchestration

List runs availability first, then estimates CONCURRENTLY under one 3-minute
budget; anything still running when the budget expires reports
estimateKnown:false rather than a confident zero, and an unavailable action is
never priced at all.

Run executes SEQUENTIALLY in catalogue order — cleanmgr and DISM must not
overlap — regardless of the order ids were requested in, continues past a
failed action, reports an unavailable one without attempting it, and measures
the free-space delta across the whole run. Any id outside the catalogue is
dropped: the server validates first, this is what makes a forged payload inert.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
)"
```

---

### Task 8: Register the two command types with the agent

**Files:**
- Modify: `agent/internal/remote/tools/types.go` (command const block, after the File-operations group at `:129-141`)
- Modify: `agent/internal/heartbeat/handlers.go` (registry map, after `tools.CmdFileListDrives` at `:88`)
- Create: `agent/internal/heartbeat/handlers_syscleanup.go`
- Modify: `agent/internal/heartbeat/handlers_test.go` (`allCommandTypes`, the File-operations group at `:35-38`)
- Modify: `agent/internal/privilege/check.go` (`elevatedCommandTypes` at `:7`)
- Modify: `agent/internal/privilege/check_test.go` (Test)

**Interfaces:**
- Consumes: `syscleanup.List`, `syscleanup.Run`, `syscleanup.Params`, `tools.NewSuccessResult`, `tools.NewErrorResult`, `tools.GetPayloadString`, `tools.GetPayloadStringSlice`, `tools.GetPayloadInt`.
- Produces: `tools.CmdSystemCleanupList = "system_cleanup_list"`, `tools.CmdSystemCleanupRun = "system_cleanup_run"`, `handleSystemCleanupList`, `handleSystemCleanupRun`.

- [ ] **Step 1: Write the failing test** — in `agent/internal/heartbeat/handlers_test.go`, add `"strings"` to the import block (it currently imports `encoding/json`, `testing`, `…/remote/desktop` and `…/remote/tools`; `encoding/json` is already there and is used below), add the two constants to `allCommandTypes` in the File-operations group:

```go
	tools.CmdFilesystemAnalysis,
	tools.CmdSystemCleanupList, tools.CmdSystemCleanupRun,
```

then append:

```go
// Disk Cleanup v2 W04. The registry-completeness tests above already fail if
// either type is unregistered; these pin the wire strings, which the API's
// CommandTypes table, COMMAND_OFFLINE_POLICY_REGISTRY, partnerTrust
// GATED_COMMAND_TYPES and commandTimeouts all mirror.
func TestSystemCleanupCommandTypeStrings(t *testing.T) {
	if tools.CmdSystemCleanupList != "system_cleanup_list" {
		t.Fatalf("CmdSystemCleanupList = %q", tools.CmdSystemCleanupList)
	}
	if tools.CmdSystemCleanupRun != "system_cleanup_run" {
		t.Fatalf("CmdSystemCleanupRun = %q", tools.CmdSystemCleanupRun)
	}
}

func TestSystemCleanupListReturnsAParseableCatalogue(t *testing.T) {
	h := &Heartbeat{}
	result, handled := h.dispatchCommand(Command{ID: "c1", Type: tools.CmdSystemCleanupList, Payload: map[string]any{}})
	if !handled {
		t.Fatal("system_cleanup_list has no handler")
	}
	if result.Status != "completed" {
		t.Fatalf("status = %q, error = %q", result.Status, result.Error)
	}
	var payload struct {
		CatalogVersion int `json:"catalogVersion"`
		Actions        []struct {
			ID            string `json:"id"`
			EstimateKnown bool   `json:"estimateKnown"`
		} `json:"actions"`
		VolumesBefore []struct {
			Mount string `json:"mount"`
		} `json:"volumesBefore"`
	}
	if err := json.Unmarshal([]byte(result.Stdout), &payload); err != nil {
		t.Fatalf("catalogue stdout is not JSON: %v", err)
	}
	if payload.CatalogVersion != 1 {
		t.Fatalf("catalogVersion = %d, want 1", payload.CatalogVersion)
	}
}

// A run with no runId is a programming error on the server, not something to
// execute against a customer's machine with an unattributable result.
func TestSystemCleanupRunRequiresARunID(t *testing.T) {
	h := &Heartbeat{}
	result, handled := h.dispatchCommand(Command{
		ID:      "c2",
		Type:    tools.CmdSystemCleanupRun,
		Payload: map[string]any{"actionIds": []any{"linux_journal_vacuum"}},
	})
	if !handled {
		t.Fatal("system_cleanup_run has no handler")
	}
	if result.Status != "failed" || !strings.Contains(result.Error, "runId") {
		t.Fatalf("result = %+v, want a failure naming runId", result)
	}
}

// An empty selection must not be treated as "run everything".
func TestSystemCleanupRunRejectsAnEmptySelection(t *testing.T) {
	h := &Heartbeat{}
	result, _ := h.dispatchCommand(Command{
		ID:      "c3",
		Type:    tools.CmdSystemCleanupRun,
		Payload: map[string]any{"runId": "11111111-1111-4111-8111-111111111111", "actionIds": []any{}},
	})
	if result.Status != "failed" || !strings.Contains(result.Error, "actionIds") {
		t.Fatalf("result = %+v, want a failure naming actionIds", result)
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd agent && go test -race -run 'TestSystemCleanup|TestHandlerRegistry' ./internal/heartbeat/...
```

Expected failure: `internal/heartbeat/handlers_test.go:…: undefined: tools.CmdSystemCleanupList` … `[build failed]`.

- [ ] **Step 3: Implement the constants** — in `agent/internal/remote/tools/types.go`, immediately after `CmdFileListDrives     = "file_list_drives"` (`:141`):

```go
	// OS-native disk cleanup (Disk Cleanup v2 §7). A SECOND cleanup engine
	// beside filesystem_analysis / file_delete: opaque, non-itemised platform
	// maintenance (cleanmgr handlers, DISM component cleanup, Time Machine
	// local snapshots, brew cleanup, package caches, journal vacuum) that the
	// file scanner structurally cannot see. Its safety model is a CLOSED
	// catalogue rather than a previewed path list — see internal/syscleanup.
	CmdSystemCleanupList = "system_cleanup_list"
	CmdSystemCleanupRun  = "system_cleanup_run"
```

- [ ] **Step 4: Implement the handlers** — create `agent/internal/heartbeat/handlers_syscleanup.go`:

```go
package heartbeat

import (
	"context"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/syscleanup"
)

// handleSystemCleanupList returns the device's native-cleanup catalogue
// (Disk Cleanup v2 §7.3). Read-only: it probes binary presence, sandbox write
// access and — for the actions that have a non-mutating simulation mode — an
// estimate. It never removes anything.
func handleSystemCleanupList(_ *Heartbeat, _ Command) tools.CommandResult {
	start := time.Now()
	// The package's own 3-minute estimate budget is the binding limit; this
	// outer context is the backstop for a probe that ignores it.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	return tools.NewSuccessResult(syscleanup.List(ctx), time.Since(start).Milliseconds())
}

// handleSystemCleanupRun executes the selected catalogue actions.
//
// Both payload fields are REQUIRED and validated here rather than defaulted:
// a missing runId would produce a result the server cannot attribute to a
// cleanup run row, and an empty actionIds must never be read as "run
// everything" on a customer's machine.
func handleSystemCleanupRun(_ *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	runID := tools.GetPayloadString(cmd.Payload, "runId", "")
	if runID == "" {
		return tools.NewErrorResult(fmt.Errorf("system_cleanup_run requires a runId"), time.Since(start).Milliseconds())
	}
	actionIDs := tools.GetPayloadStringSlice(cmd.Payload, "actionIds")
	if len(actionIDs) == 0 {
		return tools.NewErrorResult(fmt.Errorf("system_cleanup_run requires a non-empty actionIds"), time.Since(start).Milliseconds())
	}

	params := syscleanup.Params{}
	if raw, ok := cmd.Payload["params"].(map[string]any); ok {
		params.JournalVacuumBytes = int64(tools.GetPayloadInt(raw, "journalVacuumBytes", 0))
	}

	// No outer deadline here: syscleanup.Run derives the AGGREGATE budget from
	// the selection itself (RunBudget, spec §13 #14) and the server stores the
	// same figure on the run row. A second, flat ceiling at this level could
	// only disagree with it — and would cut a legitimate 160-minute
	// cleanmgr+DISM selection short at whatever number was hard-coded here.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	return tools.NewSuccessResult(
		syscleanup.Run(ctx, runID, actionIDs, params),
		time.Since(start).Milliseconds(),
	)
}
```

- [ ] **Step 5: Register them** — in `agent/internal/heartbeat/handlers.go`, in the File-operations group of `handlerRegistry` immediately after `tools.CmdFileListDrives: handleFileListDrives,` (`:88`):

```go
	// OS-native disk cleanup (Disk Cleanup v2 W04)
	tools.CmdSystemCleanupList: handleSystemCleanupList,
	tools.CmdSystemCleanupRun:  handleSystemCleanupRun,
```

- [ ] **Step 6: Add the elevation entry** — in `agent/internal/privilege/check.go`, inside `elevatedCommandTypes`:

```go
	tools.CmdSystemCleanupRun: true,
```

and append to `agent/internal/privilege/check_test.go`:

```go
// cleanmgr, DISM, apt-get and journalctl --vacuum-size all need root/SYSTEM.
// The check is warn-only, but a warning in the agent log is how a
// mis-provisioned endpoint gets diagnosed instead of silently doing nothing.
func TestSystemCleanupRunRequiresElevation(t *testing.T) {
	if !RequiresElevation(tools.CmdSystemCleanupRun) {
		t.Fatal("system_cleanup_run must be in elevatedCommandTypes")
	}
	// Listing is a read: probes and simulations only.
	if RequiresElevation(tools.CmdSystemCleanupList) {
		t.Fatal("system_cleanup_list must not require elevation")
	}
}
```

- [ ] **Step 7: Run the agent tests and watch them pass**

```bash
cd agent && go test -race ./internal/heartbeat/... ./internal/privilege/... ./internal/syscleanup/... ./internal/maintenance/...
```

Expected: `ok` for all three packages.

- [ ] **Step 8: Watch the API side go RED across the language boundary** (this is the point of doing the constants here)

```bash
cd apps/api && npx vitest run src/services/partnerTrust.test.ts
```

Expected failure: `expected system_cleanup_list in exactly one command classification: expected 0 to be 1` (and the same for `system_cleanup_run`) in `command allowlist > classifies every known command type exactly once`. Leave it red — Task 10 closes it.

- [ ] **Step 9: Cross-vet and commit**

```bash
cd agent && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go vet ./... && GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go vet ./...
git add agent/internal/remote/tools/types.go agent/internal/heartbeat/handlers.go agent/internal/heartbeat/handlers_syscleanup.go agent/internal/heartbeat/handlers_test.go agent/internal/privilege/check.go agent/internal/privilege/check_test.go
git commit -m "$(cat <<'MSG'
feat(agent): register system_cleanup_list and system_cleanup_run

Both handlers validate their payload rather than defaulting it: a missing runId
gives a result the server cannot attribute to a cleanup run row, and an empty
actionIds must never read as "run everything" on a customer's machine.

The run's agent-side deadline is 110 minutes — strictly inside the server's 2 h
the AGGREGATE budget syscleanup.Run derives from the selection — so a
160-minute cleanmgr+DISM run is not cut short by a flat constant.

system_cleanup_run joins the (warn-only) elevation list; listing does not, since
it only probes and simulates.

NOTE: apps/api's partnerTrust.test.ts is RED after this commit by design — it
parses these Go files and requires every command type to be classified. The
next commit adds both ids to the four API registries.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
)"
```

---

### Task 9: The shared `SYSTEM_CLEANUP_ACTION_IDS` validator

**Files:**
- Create: `packages/shared/src/validators/systemCleanup.ts`
- Create: `packages/shared/src/validators/systemCleanup.test.ts` (Test)
- Modify: `packages/shared/src/validators/index.ts` (the `export *` block at `:22-47`)

**Interfaces:**
- Consumes: `zod`.
- Produces:
  ```ts
  export const SYSTEM_CLEANUP_ACTION_IDS: readonly [...27 ids];
  export type SystemCleanupActionId = (typeof SYSTEM_CLEANUP_ACTION_IDS)[number];
  export function isSystemCleanupActionId(value: unknown): value is SystemCleanupActionId;
  export const JOURNAL_VACUUM_MIN_BYTES = 64 * 1024 * 1024;
  export const JOURNAL_VACUUM_MAX_BYTES = 4 * 1024 * 1024 * 1024;
  export const JOURNAL_VACUUM_DEFAULT_BYTES = 256 * 1024 * 1024;
  export const systemCleanupParamsSchema: z.ZodType<{ journalVacuumBytes?: number }>;
  export const systemCleanupRunBodySchema: z.ZodType<{ actionIds: SystemCleanupActionId[]; params?: { journalVacuumBytes?: number } }>;
  export const SYSTEM_CLEANUP_ACTION_TIMEOUT_SECONDS: Readonly<Record<string, number>>;
  export const SYSTEM_CLEANUP_RUN_BUDGET_SLACK_MS: number;
  export const SYSTEM_CLEANUP_RUN_BUDGET_MAX_MS: number;
  export function systemCleanupRunBudgetMs(actionIds: readonly string[]): number;
  export const SYSTEM_CLEANUP_RISK_FLAGS: readonly ['long_running','may_require_reboot','may_require_reboot_free_state','removes_driver_rollback','removes_packages'];
  ```

- [ ] **Step 1: Write the failing test** — create `packages/shared/src/validators/systemCleanup.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  JOURNAL_VACUUM_DEFAULT_BYTES,
  JOURNAL_VACUUM_MAX_BYTES,
  JOURNAL_VACUUM_MIN_BYTES,
  SYSTEM_CLEANUP_ACTION_IDS,
  SYSTEM_CLEANUP_ACTION_TIMEOUT_SECONDS,
  SYSTEM_CLEANUP_RISK_FLAGS,
  SYSTEM_CLEANUP_RUN_BUDGET_MAX_MS,
  SYSTEM_CLEANUP_RUN_BUDGET_SLACK_MS,
  isSystemCleanupActionId,
  systemCleanupRunBodySchema,
  systemCleanupRunBudgetMs,
} from './systemCleanup';

describe('SYSTEM_CLEANUP_ACTION_IDS (spec §5.3, §7.2)', () => {
  it('is the closed 27-entry catalogue in agent order', () => {
    expect(SYSTEM_CLEANUP_ACTION_IDS).toEqual([
      'win_cleanmgr',
      'win_cleanmgr:update_cleanup',
      'win_cleanmgr:delivery_optimization_files',
      'win_cleanmgr:device_driver_packages',
      'win_cleanmgr:previous_installations',
      'win_cleanmgr:upgrade_discarded_files',
      'win_cleanmgr:windows_upgrade_log_files',
      'win_cleanmgr:setup_log_files',
      'win_cleanmgr:temporary_setup_files',
      'win_cleanmgr:service_pack_cleanup',
      'win_cleanmgr:system_error_memory_dump_files',
      'win_cleanmgr:system_error_minidump_files',
      'win_cleanmgr:windows_error_reporting_files',
      'win_cleanmgr:windows_error_reporting_system_archive_files',
      'win_cleanmgr:windows_error_reporting_system_queue_files',
      'win_cleanmgr:temporary_files',
      'win_cleanmgr:windows_defender',
      'win_cleanmgr:old_chkdsk_files',
      'win_cleanmgr:diagnostic_data_viewer_database_files',
      'win_cleanmgr:branchcache',
      'win_cleanmgr:content_indexer_cleaner',
      'win_dism_component_cleanup',
      'mac_tm_local_snapshots',
      'mac_brew_cleanup',
      'linux_pkg_cache_clean',
      'linux_pkg_autoremove',
      'linux_journal_vacuum',
    ]);
  });

  it('never offers a handler that touches user data or recovery state', () => {
    const joined = SYSTEM_CLEANUP_ACTION_IDS.join(' ').toLowerCase();
    for (const forbidden of [
      'downloads', 'esd', 'language_pack', 'recycle', 'thumbnail',
      'internet_cache', 'active_setup', 'game', 'resetbase',
    ]) {
      expect(joined).not.toContain(forbidden);
    }
  });

  it('isSystemCleanupActionId is exact, not a prefix or case-insensitive match', () => {
    expect(isSystemCleanupActionId('linux_journal_vacuum')).toBe(true);
    for (const value of [
      '', 'LINUX_JOURNAL_VACUUM', 'linux_journal_vacuum ', 'win_cleanmgr:',
      'win_cleanmgr:DownloadsFolder', 'linux_journal_vacuum; rm -rf /', 42, null, undefined, {},
    ]) {
      expect(isSystemCleanupActionId(value)).toBe(false);
    }
  });
});

describe('systemCleanupRunBodySchema', () => {
  it('accepts a subset of the catalogue', () => {
    const parsed = systemCleanupRunBodySchema.parse({
      actionIds: ['linux_pkg_cache_clean', 'linux_journal_vacuum'],
      params: { journalVacuumBytes: JOURNAL_VACUUM_DEFAULT_BYTES },
    });
    expect(parsed.actionIds).toEqual(['linux_pkg_cache_clean', 'linux_journal_vacuum']);
    expect(parsed.params?.journalVacuumBytes).toBe(JOURNAL_VACUUM_DEFAULT_BYTES);
  });

  it('rejects an empty selection — it must never read as "run everything"', () => {
    expect(systemCleanupRunBodySchema.safeParse({ actionIds: [] }).success).toBe(false);
  });

  it('rejects any id outside the catalogue', () => {
    for (const actionIds of [
      ['not_an_action'],
      ['linux_pkg_cache_clean', 'not_an_action'],
      ['win_cleanmgr:DownloadsFolder'],
      ['../../etc/passwd'],
    ]) {
      expect(systemCleanupRunBodySchema.safeParse({ actionIds }).success).toBe(false);
    }
  });

  it('bounds journalVacuumBytes to 64 MiB - 4 GiB and rejects non-integers', () => {
    expect(JOURNAL_VACUUM_MIN_BYTES).toBe(64 * 1024 * 1024);
    expect(JOURNAL_VACUUM_MAX_BYTES).toBe(4 * 1024 * 1024 * 1024);
    const ok = (bytes: number) =>
      systemCleanupRunBodySchema.safeParse({
        actionIds: ['linux_journal_vacuum'],
        params: { journalVacuumBytes: bytes },
      }).success;
    expect(ok(JOURNAL_VACUUM_MIN_BYTES)).toBe(true);
    expect(ok(JOURNAL_VACUUM_MAX_BYTES)).toBe(true);
    expect(ok(JOURNAL_VACUUM_MIN_BYTES - 1)).toBe(false);
    expect(ok(JOURNAL_VACUUM_MAX_BYTES + 1)).toBe(false);
    expect(ok(0)).toBe(false);
    expect(ok(-1)).toBe(false);
    expect(ok(1.5)).toBe(false);
    expect(ok(Number.NaN)).toBe(false);
  });

  it('caps the selection length so one call cannot enumerate an unbounded list', () => {
    const tooMany = Array.from({ length: 64 }, () => 'linux_pkg_cache_clean');
    expect(systemCleanupRunBodySchema.safeParse({ actionIds: tooMany }).success).toBe(false);
  });

  it('exposes the risk flags the UI renders as badges', () => {
    expect(SYSTEM_CLEANUP_RISK_FLAGS).toEqual([
      'long_running',
      'may_require_reboot',
      'may_require_reboot_free_state',
      'removes_driver_rollback',
      'removes_packages',
      'removes_os_rollback',
      'removes_recovery_points',
    ]);
  });
});

describe('systemCleanupRunBudgetMs (spec §13 #14)', () => {
  const minutes = (n: number) => n * 60 * 1000;

  it('sums the selected actions timeouts plus slack', () => {
    expect(systemCleanupRunBudgetMs(['linux_pkg_cache_clean'])).toBe(minutes(15));
    expect(systemCleanupRunBudgetMs(['linux_pkg_cache_clean', 'linux_journal_vacuum'])).toBe(minutes(20));
    // 60 + 90 + 10. A flat two-hour constant would have reaped this mid-DISM.
    expect(systemCleanupRunBudgetMs(['win_cleanmgr', 'win_dism_component_cleanup'])).toBe(minutes(160));
  });

  it('counts a bare win_cleanmgr and its sub-ids once — they are one execution', () => {
    expect(systemCleanupRunBudgetMs([
      'win_cleanmgr', 'win_cleanmgr:update_cleanup', 'win_cleanmgr:setup_log_files',
    ])).toBe(minutes(70));
  });

  it('caps at three hours and ignores unknown ids', () => {
    expect(systemCleanupRunBudgetMs([...SYSTEM_CLEANUP_ACTION_IDS])).toBe(SYSTEM_CLEANUP_RUN_BUDGET_MAX_MS);
    expect(systemCleanupRunBudgetMs(['not_an_action'])).toBe(SYSTEM_CLEANUP_RUN_BUDGET_SLACK_MS);
    expect(systemCleanupRunBudgetMs([])).toBe(SYSTEM_CLEANUP_RUN_BUDGET_SLACK_MS);
  });

  it('covers every top-level catalogue id, so no selection is budgeted at zero', () => {
    const topLevel = SYSTEM_CLEANUP_ACTION_IDS.filter((id) => !id.startsWith('win_cleanmgr:'));
    for (const id of topLevel) {
      expect(SYSTEM_CLEANUP_ACTION_TIMEOUT_SECONDS[id]).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd packages/shared && npx vitest run src/validators/systemCleanup.test.ts
```

Expected failure: `Failed to load .../systemCleanup.test.ts` … `Cannot find module './systemCleanup'`.

- [ ] **Step 3: Implement** — create `packages/shared/src/validators/systemCleanup.ts`:

```ts
/**
 * The OS-native cleanup catalogue, shared by the API route, the web panel and
 * (via a parity test) the Go agent (Disk Cleanup v2 §5.3, §7.2).
 *
 * This list IS the safety model. The native engine has no itemised preview to
 * check a selection against — it hands a fixed set of ids to a Go catalogue
 * that turns each one into an argv built entirely from constants. So the only
 * thing standing between a request body and a privileged process on a
 * customer's machine is "is this id in this list", which is why the list is
 * `as const`, exact-matched, and pinned by tests on both sides of the
 * language boundary (agent/internal/syscleanup/shared_ids_test.go reads THIS
 * file and fails on drift).
 *
 * Deliberately absent, and never to be added without the spec being amended:
 * DownloadsFolder (user data), Windows ESD installation files (breaks Reset
 * this PC), Language Pack (uninstalls installed languages), every per-user
 * cleanmgr handler (under the SYSTEM service account they operate on the
 * SYSTEM profile, and the file engine already covers user bins), and DISM
 * /ResetBase (makes every installed update permanent).
 */

import { z } from 'zod';

export const SYSTEM_CLEANUP_ACTION_IDS = [
  // Windows — cleanmgr. The bare id means "every allowlisted handler present
  // on this device"; each `:slug` selects one handler. The slug maps to a
  // registry key name inside the agent, never here and never on the wire.
  'win_cleanmgr',
  'win_cleanmgr:update_cleanup',
  'win_cleanmgr:delivery_optimization_files',
  'win_cleanmgr:device_driver_packages',
  'win_cleanmgr:previous_installations',
  'win_cleanmgr:upgrade_discarded_files',
  'win_cleanmgr:windows_upgrade_log_files',
  'win_cleanmgr:setup_log_files',
  'win_cleanmgr:temporary_setup_files',
  'win_cleanmgr:service_pack_cleanup',
  'win_cleanmgr:system_error_memory_dump_files',
  'win_cleanmgr:system_error_minidump_files',
  'win_cleanmgr:windows_error_reporting_files',
  'win_cleanmgr:windows_error_reporting_system_archive_files',
  'win_cleanmgr:windows_error_reporting_system_queue_files',
  'win_cleanmgr:temporary_files',
  'win_cleanmgr:windows_defender',
  'win_cleanmgr:old_chkdsk_files',
  'win_cleanmgr:diagnostic_data_viewer_database_files',
  'win_cleanmgr:branchcache',
  'win_cleanmgr:content_indexer_cleaner',
  // Windows — component store.
  'win_dism_component_cleanup',
  // macOS.
  'mac_tm_local_snapshots',
  'mac_brew_cleanup',
  // Linux.
  'linux_pkg_cache_clean',
  'linux_pkg_autoremove',
  'linux_journal_vacuum',
] as const;

export type SystemCleanupActionId = (typeof SYSTEM_CLEANUP_ACTION_IDS)[number];

const actionIdSet: ReadonlySet<string> = new Set<string>(SYSTEM_CLEANUP_ACTION_IDS);

/** Exact membership. No trimming, no case folding, no prefix matching. */
export function isSystemCleanupActionId(value: unknown): value is SystemCleanupActionId {
  return typeof value === 'string' && actionIdSet.has(value);
}

/** Risk flags an action may declare; rendered as badges by the web panel. */
export const SYSTEM_CLEANUP_RISK_FLAGS = [
  'long_running',
  'may_require_reboot',
  'may_require_reboot_free_state',
  'removes_driver_rollback',
  'removes_packages',
  // Spec §13 #15. Two losses a later action cannot undo and that the original
  // catalogue left undisclosed: deleting Windows.old / $WINDOWS.~BT ends the
  // "go back to the previous version" window, and deleting the local APFS
  // snapshots removes the only on-disk restore points a Mac has when its Time
  // Machine destination is not attached.
  'removes_os_rollback',
  'removes_recovery_points',
] as const;

export type SystemCleanupRiskFlag = (typeof SYSTEM_CLEANUP_RISK_FLAGS)[number];

/**
 * Per-action wall-clock caps, mirroring `actionTimeouts` in
 * `agent/internal/syscleanup/catalog.go`. The agent's `shared_ids_test.go`
 * reads this table and fails on drift.
 *
 * The server needs them because it sizes the run's deadline BEFORE queuing
 * (spec §13 #14) — the reaper and the route's lazy timeout both read the
 * stored deadline rather than recomputing it.
 */
export const SYSTEM_CLEANUP_ACTION_TIMEOUT_SECONDS: Readonly<Record<string, number>> = {
  win_cleanmgr: 60 * 60,
  win_dism_component_cleanup: 90 * 60,
  mac_tm_local_snapshots: 10 * 60,
  mac_brew_cleanup: 10 * 60,
  linux_pkg_cache_clean: 5 * 60,
  linux_pkg_autoremove: 15 * 60,
  linux_journal_vacuum: 5 * 60,
};

/** Slack for probes, the two volume samples and process teardown. */
export const SYSTEM_CLEANUP_RUN_BUDGET_SLACK_MS = 10 * 60 * 1000;
/** Nothing a single run may exceed, whatever was selected. */
export const SYSTEM_CLEANUP_RUN_BUDGET_MAX_MS = 3 * 60 * 60 * 1000;

/**
 * Σ the selected actions' own timeouts + slack, capped.
 *
 * A single constant was wrong in both directions (spec §13 #14): a lone
 * `linux_pkg_cache_clean` would hold a two-hour budget for five minutes of
 * work, while cleanmgr (60 min) + DISM (90 min) needs 150 and would have been
 * reaped at 120 — mid-DISM.
 *
 * Duplicates collapse: a bare `win_cleanmgr` and its `:slug` sub-ids are ONE
 * execution on the agent, so they are counted once here too or the budget
 * drifts from the thing it is budgeting.
 */
export function systemCleanupRunBudgetMs(actionIds: readonly string[]): number {
  const counted = new Set<string>();
  let total = 0;
  for (const id of actionIds) {
    const key = id.startsWith('win_cleanmgr:') ? 'win_cleanmgr' : id;
    if (counted.has(key)) continue;
    const seconds = SYSTEM_CLEANUP_ACTION_TIMEOUT_SECONDS[key];
    if (seconds === undefined) continue;
    counted.add(key);
    total += seconds * 1000;
  }
  return Math.min(total + SYSTEM_CLEANUP_RUN_BUDGET_SLACK_MS, SYSTEM_CLEANUP_RUN_BUDGET_MAX_MS);
}

/**
 * The ONE client-influenced integer in the whole feature (spec §5.3). Bounds
 * are mirrored in the agent (clampJournalVacuumBytes) so a request that
 * bypassed this schema still cannot widen them.
 */
export const JOURNAL_VACUUM_MIN_BYTES = 64 * 1024 * 1024;
export const JOURNAL_VACUUM_MAX_BYTES = 4 * 1024 * 1024 * 1024;
export const JOURNAL_VACUUM_DEFAULT_BYTES = 256 * 1024 * 1024;

export const systemCleanupParamsSchema = z.object({
  journalVacuumBytes: z
    .number()
    .int()
    .min(JOURNAL_VACUUM_MIN_BYTES)
    .max(JOURNAL_VACUUM_MAX_BYTES)
    .optional(),
});

/**
 * `.max(SYSTEM_CLEANUP_ACTION_IDS.length)` rather than an arbitrary cap: the
 * catalogue is closed, so no honest request can name more ids than it has,
 * and an oversized array is a client bug or an attempt to make the agent do
 * needless work.
 */
export const systemCleanupRunBodySchema = z.object({
  actionIds: z
    .array(z.enum(SYSTEM_CLEANUP_ACTION_IDS))
    .min(1)
    .max(SYSTEM_CLEANUP_ACTION_IDS.length),
  params: systemCleanupParamsSchema.optional(),
});

export type SystemCleanupRunBody = z.infer<typeof systemCleanupRunBodySchema>;
```

- [ ] **Step 4: Export it** — in `packages/shared/src/validators/index.ts`, add to the `export *` block (alphabetically after `./softwareDownloadPolicy`):

```ts
export * from './systemCleanup';
```

- [ ] **Step 5: Run it and watch it pass**

```bash
cd packages/shared && npx vitest run src/validators/systemCleanup.test.ts && pnpm --filter @breeze/shared typecheck
```

Expected: 8 tests pass; typecheck silent.

- [ ] **Step 6: Turn the Go parity test from a skip into a real assertion**

```bash
cd agent && go test -race -run TestSharedValidatorIDsMatchTheCatalogue -v ./internal/syscleanup/...
```

Expected: `--- PASS: TestSharedValidatorIDsMatchTheCatalogue` (it skipped in Task 1 because the file did not exist; it now reads the 27 ids and compares them position by position).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/validators/systemCleanup.ts packages/shared/src/validators/systemCleanup.test.ts packages/shared/src/validators/index.ts
git commit -m "$(cat <<'MSG'
feat(shared): SYSTEM_CLEANUP_ACTION_IDS and the run-body validator

This list IS the native engine's safety model: unlike the file engine there is
no itemised preview to check a selection against, so "is this id in this list"
is the only thing between a request body and a privileged process. It is
`as const`, exact-matched (no trim, no case fold, no prefix), and pinned by
tests on both sides of the language boundary — the agent's
shared_ids_test.go reads this file and fails on drift.

journalVacuumBytes is the one client-influenced integer; its 64 MiB - 4 GiB
bound is mirrored in the agent so a request that bypassed this schema still
cannot widen it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
)"
```

---

### Task 10: The four API command-type registries

**Files:**
- Modify: `apps/api/src/services/commandTypes.ts` (File-operations group, after `FILE_LIST_DRIVES` at `:61`)
- Modify: `apps/api/src/services/commandOfflinePolicy.ts` (`STANDARD_REVIEWED` at `:219-249`)
- Modify: `apps/api/src/services/commandTimeouts.ts` (`MEDIUM_TIMEOUT_TYPES` at `:73`, `LONG_TIMEOUT_TYPES` at `:100`)
- Modify: `apps/api/src/services/commandTimeouts.test.ts` (Test)
- Modify: `apps/api/src/services/partnerTrust.ts` (`GATED_COMMAND_TYPES`, alphabetical, after `'system_state_collect'` at `:159`)

**Interfaces:**
- Consumes: the Go constants from Task 8.
- Produces: `CommandTypes.SYSTEM_CLEANUP_LIST`, `CommandTypes.SYSTEM_CLEANUP_RUN`, the `live_only` `DeliveryTtlClass`, `SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS`.

- [ ] **Step 1: Confirm the cross-language red is still there** (it is the failing test for this task — no new test file is needed for the registries that already have completeness contracts)

```bash
cd apps/api && npx vitest run src/services/partnerTrust.test.ts src/services/commandOfflinePolicy.test.ts
```

Expected failures, both pre-existing from Task 8:
- `partnerTrust.test.ts` → `expected system_cleanup_list in exactly one command classification: expected 0 to be 1`.
- `commandOfflinePolicy.test.ts` → currently still GREEN, because `CommandTypes` does not have the two entries yet. It goes red in Step 2 and green in Step 3 — that ordering is deliberate and is called out below.

- [ ] **Step 2: Add the command types and watch a second suite go red** — in `apps/api/src/services/commandTypes.ts`, after `FILE_LIST_DRIVES: 'file_list_drives',` (`:61`):

```ts
  // OS-native disk cleanup (Disk Cleanup v2 §5.3). A SECOND cleanup engine
  // beside FILESYSTEM_ANALYSIS: opaque platform maintenance (cleanmgr
  // handlers, DISM component cleanup, Time Machine local snapshots, brew
  // cleanup, package caches, journal vacuum) whose safety model is a closed
  // catalogue of action ids rather than a previewed path list.
  //
  // Defined HERE and not in commandQueue.ts: #5128 moved this table into a
  // leaf module precisely because commandOfflinePolicy.ts builds its
  // fail-closed registry from it at load time, and the round trip through
  // commandQueue was a real ESM initialisation cycle.
  SYSTEM_CLEANUP_LIST: 'system_cleanup_list',
  SYSTEM_CLEANUP_RUN: 'system_cleanup_run',
```

then:

```bash
cd apps/api && npx vitest run src/services/commandOfflinePolicy.test.ts
```

Expected failure: `every CommandTypes value is EXPLICITLY classified, never left to the fallback` — `expected [ 'system_cleanup_list', 'system_cleanup_run' ] to deeply equal []`. The fallback would have silently made both queueable; failing here is what keeps it a decision.

- [ ] **Step 3: Add the `live_only` TTL class and classify both types into it** — in `apps/api/src/services/commandOfflinePolicy.ts`.

Plan amendment 19 (spec §13 #6): `standard` would deliver for **168 hours**. A run the UI already marked failed at its 2 h budget, whose row the tech has closed and moved on from, could still be claimed by the device days later and would then delete things nobody is watching for. The shortest *queueing* class today is `short` at 24 h — 96× the ceiling this finding sets — so the class has to be new.

Extend `DeliveryTtlClass` (`:12`) and `deliveryTtlMs` (`:46`):

```ts
/** TTL class = how long a queued row may wait for the device (OD-1). */
export type DeliveryTtlClass = 'live' | 'live_only' | 'standard' | 'short' | 'power_state';
```

```ts
function envMinutes(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined || raw === '' ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}
```

```ts
    case 'live_only':
      // Disk Cleanup v2 (spec §13 #6). Destructive maintenance whose OWNING
      // ROW has its own clock: a cleanup run is marked failed at its budget,
      // and a command that outlives that row deletes things with nobody
      // watching for the result. Fifteen minutes is "the device is here now,
      // or this never happens" — long enough to survive a reconnect, far
      // short of the 24 h `short` class, which is the shortest thing that
      // existed before this.
      return envMinutes('DEVICE_COMMAND_QUEUE_LIVE_ONLY_TTL_MINUTES', 15) * 60 * 1000;
```

Then add the class list next to `SHORT` and register both types in it (they are NOT added to `STANDARD_REVIEWED`):

```ts
/**
 * Destructive OS maintenance. Queueable — a device that reconnects inside the
 * window should still get the work — but only just: the owning
 * `device_filesystem_cleanup_runs` row is finalised on its own budget, and a
 * command delivered after that finalisation would act on a run the operator
 * has already been told failed.
 */
const LIVE_ONLY: readonly string[] = [
  C.SYSTEM_CLEANUP_LIST,
  C.SYSTEM_CLEANUP_RUN,
];
```

```ts
for (const type of LIVE_ONLY) registry[type] = 'live_only';
```

and include it in the explicit-classification set:

```ts
export const EXPLICITLY_CLASSIFIED_COMMAND_TYPES: ReadonlySet<string> = Object.freeze(
  new Set<string>([...LIVE, ...LIVE_ONLY, ...BACKUP_AND_RESTORE, ...SHORT, ...POWER_STATE_TTL_TYPES, ...STANDARD_REVIEWED]),
) as ReadonlySet<string>;
```

W01 needs the same class for `file_delete` under `cleanupGuard` (spec §13 #6 names both waves). Whichever wave lands first adds the class body above; the other adds only its registry entries.

Append to `apps/api/src/services/commandOfflinePolicy.test.ts`:

```ts
  it('delivers destructive cleanup commands live-only, not for a week', () => {
    expect(COMMAND_OFFLINE_POLICY_REGISTRY.system_cleanup_list).toBe('live_only');
    expect(COMMAND_OFFLINE_POLICY_REGISTRY.system_cleanup_run).toBe('live_only');
    expect(deliveryTtlMs('live_only')).toBe(15 * 60 * 1000);
    // The point of the class: strictly shorter than everything that existed.
    expect(deliveryTtlMs('live_only')).toBeLessThan(deliveryTtlMs('short'));
    expect(deliveryTtlMs('live_only')).toBeLessThan(deliveryTtlMs('standard'));
    // Still QUEUEABLE — a device that reconnects inside the window gets it.
    expect(defaultOfflinePolicy('system_cleanup_run')).toEqual({ kind: 'queue', deliverWithinMs: 15 * 60 * 1000 });
  });

  it('live_only TTL is env-tunable with a one-minute floor', () => {
    vi.stubEnv('DEVICE_COMMAND_QUEUE_LIVE_ONLY_TTL_MINUTES', '5');
    expect(deliveryTtlMs('live_only')).toBe(5 * 60 * 1000);
    vi.stubEnv('DEVICE_COMMAND_QUEUE_LIVE_ONLY_TTL_MINUTES', '0');
    expect(deliveryTtlMs('live_only')).toBe(15 * 60 * 1000);
  });
```

- [ ] **Step 4: Classify them in the timeout registry** — in `apps/api/src/services/commandTimeouts.ts`, add `CommandTypes.SYSTEM_CLEANUP_LIST,` to `MEDIUM_TIMEOUT_TYPES` next to `CommandTypes.FILESYSTEM_ANALYSIS`, and export the ceiling at the end of the file:

```ts
/**
 * The CEILING for one native cleanup run's command row (Disk Cleanup v2 §5.3,
 * §13 #14).
 *
 * It is not the run's budget. The budget is a function of the SELECTION —
 * `systemCleanupRunBudgetMs` in `@breeze/shared/validators`, Σ the chosen
 * actions' own timeouts + 10 minutes — and is computed once at queue time and
 * **stored on the row** as `plan.deadlineAt`. Both clocks that matter read
 * that stored value: the route's lazy `running → failed ('timed out')`
 * transition and, through it, the operator's view.
 *
 * This constant exists only because `getCommandTimeoutMs` is keyed by TYPE and
 * cannot see a selection. Three hours is the same cap the budget function
 * applies, so the reaper can never terminalise a command row while its run is
 * still legitimately inside its own budget.
 */
export const SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS = THREE_HOURS;
```

`THREE_HOURS` joins the tier constants at the top of the file, and `LONG_TIMEOUT_TYPES` cannot express it (it is `TWO_HOURS`), so `getCommandTimeoutMs` gains one branch before the `LONG_TIMEOUT_TYPES` check:

```ts
const THREE_HOURS = 3 * 60 * 60 * 1000;
```

```ts
  // Disk Cleanup v2: a native run's real budget is per-selection and lives on
  // the row; this is the ceiling that keeps the reaper from terminalising a
  // command whose run is still inside it.
  if (commandType === CommandTypes.SYSTEM_CLEANUP_RUN) return THREE_HOURS;
```

- [ ] **Step 5: Pin the timeout classes** — append to `apps/api/src/services/commandTimeouts.test.ts`:

```ts
  it('caps a native cleanup run at three hours and a list at the medium tier', () => {
    // The CEILING, not the budget: the real budget is per-selection
    // (systemCleanupRunBudgetMs) and is stored on the run row. This only has
    // to be >= the largest budget the function can return, or the reaper
    // would terminalise a command whose run is still inside its own budget.
    expect(getCommandTimeoutMs('system_cleanup_run')).toBe(3 * 60 * 60 * 1000);
    expect(SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS).toBe(getCommandTimeoutMs('system_cleanup_run'));
    expect(SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS).toBeGreaterThanOrEqual(
      systemCleanupRunBudgetMs([...SYSTEM_CLEANUP_ACTION_IDS]),
    );
    // 30 minutes: the agent caps its own estimation phase at 3, so this is a
    // pure backstop rather than a working budget.
    expect(getCommandTimeoutMs('system_cleanup_list')).toBe(30 * 60 * 1000);
  });
```

(add `SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS` to the file's existing import from `./commandTimeouts`, and `SYSTEM_CLEANUP_ACTION_IDS` + `systemCleanupRunBudgetMs` from `@breeze/shared/validators`).

- [ ] **Step 6: Classify them in the partner-trust allowlist** — in `apps/api/src/services/partnerTrust.ts`, in `GATED_COMMAND_TYPES` alphabetically between `'software_update',` and `'start_desktop',`:

```ts
  'system_cleanup_list',
  'system_cleanup_run',
```

(gated, not lifecycle: both are operator-directed, and `system_cleanup_run` deletes things — exactly what a probationary partner must not be able to do to a device they enrolled.)

- [ ] **Step 7: Run all four suites and watch them pass**

```bash
cd apps/api && npx vitest run src/services/partnerTrust.test.ts src/services/commandOfflinePolicy.test.ts src/services/commandTimeouts.test.ts src/services/scriptCancellation.registration.test.ts
```

Expected: all four green.

- [ ] **Step 8: Typecheck and commit**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
git add apps/api/src/services/commandTypes.ts apps/api/src/services/commandOfflinePolicy.ts apps/api/src/services/commandTimeouts.ts apps/api/src/services/commandTimeouts.test.ts apps/api/src/services/partnerTrust.ts
git commit -m "$(cat <<'MSG'
feat(api): register system_cleanup_list/run in the four command-type registries

CommandTypes (commandTypes.ts, the leaf module — #5128 moved it out of
commandQueue.ts precisely so commandOfflinePolicy can read it at load without
an ESM cycle), COMMAND_OFFLINE_POLICY_REGISTRY's STANDARD_REVIEWED,
commandTimeouts, and partnerTrust's GATED_COMMAND_TYPES.

`standard` is that registry's longest class — there is no separate "long" one;
patch installs and filesystem_analysis live there too.

A new live_only TTL class (15 min) replaces standard (168 h) for both types:
a run the UI marked failed at its budget must not be claimable days later.
SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS is the reaper's ceiling; the real budget is
per-selection and stored on the run row.

Closes the cross-language red the previous commit opened in partnerTrust.test.ts.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
)"
```

---

### Task 11a: The agent-payload contract and the agent-version gate

**Files:**
- Create: `apps/api/src/services/systemCleanup.ts`
- Create: `apps/api/src/services/systemCleanup.test.ts` (Test)

**Interfaces:**
- Consumes: `compareAgentVersions`, `parseComparableVersion` (`services/agentEditionCompat.ts:26,48`), `SYSTEM_CLEANUP_ACTION_IDS` (Task 9), `zod`.
- Produces:
  ```ts
  export const MIN_AGENT_VERSION_SYSTEM_CLEANUP = '0.115.0';
  export const AGENT_UPDATE_REQUIRED_ERROR = 'agent_update_required';
  export const UNKNOWN_COMMAND_TYPE_PREFIX = 'unknown command type:';
  export function agentSupportsSystemCleanup(agentVersion: string | null | undefined): boolean;
  /** The 409-or-go decision, shaped so the route and the W05 AI lane share it. */
  export function systemCleanupAgentGate(device: { agentVersion: string | null }):
    | { ok: true }
    | { ok: false; status: 409; error: 'agent_update_required'; minAgentVersion: string };
  export function isUnknownCommandTypeError(error: string | null | undefined): boolean;
  export const systemCleanupCatalogSchema: z.ZodType<SystemCleanupCatalog>;
  export const systemCleanupRunResultSchema: z.ZodType<SystemCleanupRunResult>;
  export function parseAgentJson<T>(schema: z.ZodType<T>, stdout: string | null | undefined): T | null;
  export type SystemCleanupCatalog = …; export type SystemCleanupRunResult = …;
  ```

- [ ] **Step 1: Write the failing test** — create `apps/api/src/services/systemCleanup.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  AGENT_UPDATE_REQUIRED_ERROR,
  MIN_AGENT_VERSION_SYSTEM_CLEANUP,
  agentSupportsSystemCleanup,
  isUnknownCommandTypeError,
  parseAgentJson,
  systemCleanupCatalogSchema,
  systemCleanupRunResultSchema,
} from './systemCleanup';

describe('agentSupportsSystemCleanup (spec §5.3)', () => {
  // Plan amendment 11: the newest tag on this branch is v0.114.0, so W04 ships
  // in 0.115.0. Bump this in the same PR if a release lands first.
  it('pins the minimum version W04 ships in', () => {
    expect(MIN_AGENT_VERSION_SYSTEM_CLEANUP).toBe('0.115.0');
    expect(AGENT_UPDATE_REQUIRED_ERROR).toBe('agent_update_required');
  });

  it('accepts the minimum and anything above it', () => {
    for (const version of ['0.115.0', '0.115.1', '0.116.0', '1.0.0', 'v0.115.0']) {
      expect(agentSupportsSystemCleanup(version)).toBe(true);
    }
  });

  it('rejects anything below it', () => {
    for (const version of ['0.114.0', '0.113.9', '0.99.0', '0.114.99']) {
      expect(agentSupportsSystemCleanup(version)).toBe(false);
    }
  });

  // Plan amendment 10: compareAgentVersions returns 0 for an unparseable
  // input, so a naive `>= 0` comparison would let '' through as "equal to the
  // minimum". devices.agent_version is NOT NULL, so '' is reachable.
  it('fails CLOSED on a missing or unparseable version', () => {
    for (const version of ['', '   ', 'dev', 'latest', 'v', null, undefined]) {
      expect(agentSupportsSystemCleanup(version)).toBe(false);
    }
  });

  // "core semver" (spec §5.3): a prerelease of the shipping version is the
  // lab build W05 runs the acceptance gate on. Gating it out would make the
  // gate untestable.
  it('compares the core only, so an rc of the shipping version passes', () => {
    expect(agentSupportsSystemCleanup('0.115.0-rc1')).toBe(true);
    expect(agentSupportsSystemCleanup('0.114.0-rc1')).toBe(false);
  });
});

describe('isUnknownCommandTypeError', () => {
  // The agent's fallback for a type it has no handler for
  // (heartbeat.go:6475). It is the defensive half of the 409: a device that
  // reports a version above the minimum but genuinely lacks the handler
  // (a hand-built binary, a botched update) still gets "update the agent"
  // instead of a bare failure with no next step.
  it('matches the agent fallback and nothing else', () => {
    expect(isUnknownCommandTypeError('unknown command type: system_cleanup_list')).toBe(true);
    expect(isUnknownCommandTypeError('  unknown command type: system_cleanup_run')).toBe(true);
    expect(isUnknownCommandTypeError('cleanmgr.exe not present')).toBe(false);
    expect(isUnknownCommandTypeError('the agent said unknown command type: later on')).toBe(false);
    expect(isUnknownCommandTypeError(null)).toBe(false);
    expect(isUnknownCommandTypeError(undefined)).toBe(false);
  });
});

const catalogFixture = {
  catalogVersion: 1,
  actions: [
    {
      id: 'linux_pkg_cache_clean',
      label: 'Package manager cache',
      description: 'Removes downloaded package archives.',
      os: 'linux',
      available: true,
      estimateBytes: 412_000_000,
      estimateKnown: true,
      estimateDetail: 'size of /var/cache/apt/archives',
      riskFlags: [],
      affectsVolumes: ['/'],
    },
    {
      id: 'linux_pkg_autoremove',
      label: 'Remove orphaned packages',
      description: 'Removes dependency-only packages.',
      os: 'linux',
      available: false,
      unavailableReason: 'sandbox denies write to /var/cache/apt',
      estimateKnown: false,
      riskFlags: ['removes_packages'],
      affectsVolumes: ['/'],
    },
  ],
  volumesBefore: [{ mount: '/', freeBytes: 9_000_000_000 }],
};

describe('systemCleanupCatalogSchema', () => {
  it('accepts the agent §7.3 shape', () => {
    const parsed = systemCleanupCatalogSchema.parse(catalogFixture);
    expect(parsed.actions).toHaveLength(2);
    expect(parsed.actions[1]?.unavailableReason).toBe('sandbox denies write to /var/cache/apt');
  });

  it('accepts cleanmgr sub-actions', () => {
    const parsed = systemCleanupCatalogSchema.parse({
      ...catalogFixture,
      actions: [{
        id: 'win_cleanmgr',
        label: 'Windows Disk Cleanup',
        description: 'Runs the built-in handlers you select.',
        os: 'windows',
        available: true,
        estimateKnown: false,
        riskFlags: ['long_running'],
        affectsVolumes: [],
        subActions: [
          { id: 'win_cleanmgr:update_cleanup', label: 'Windows Update cleanup', estimateKnown: false },
          { id: 'win_cleanmgr:temporary_files', label: 'Temporary files', estimateBytes: 1_024, estimateKnown: true },
        ],
      }],
    });
    expect(parsed.actions[0]?.subActions).toHaveLength(2);
  });

  // The server never trusts an agent-supplied id: a compromised or buggy agent
  // must not be able to put an arbitrary string into a row the UI then sends
  // straight back in a run request.
  it('rejects an action id outside the shared catalogue', () => {
    const hostile = {
      ...catalogFixture,
      actions: [{ ...catalogFixture.actions[0], id: 'win_cleanmgr:DownloadsFolder' }],
    };
    expect(systemCleanupCatalogSchema.safeParse(hostile).success).toBe(false);
  });

  it('rejects a risk flag outside the shared list', () => {
    const hostile = {
      ...catalogFixture,
      actions: [{ ...catalogFixture.actions[0], riskFlags: ['<img src=x onerror=1>'] }],
    };
    expect(systemCleanupCatalogSchema.safeParse(hostile).success).toBe(false);
  });
});

describe('systemCleanupRunResultSchema', () => {
  it('accepts the agent §7.3 run shape', () => {
    const parsed = systemCleanupRunResultSchema.parse({
      runId: '11111111-1111-4111-8111-111111111111',
      actions: [
        { id: 'linux_pkg_cache_clean', status: 'completed', exitCode: 0, durationMs: 812, outputTail: 'Done' },
        { id: 'linux_journal_vacuum', status: 'failed', exitCode: 1, durationMs: 90, error: 'permission denied' },
      ],
      volumes: [{ mount: '/', freeBefore: 1_000, freeAfter: 4_000 }],
      freedBytes: 3_000,
    });
    expect(parsed.freedBytes).toBe(3_000);
    expect(parsed.actions[1]?.status).toBe('failed');
  });

  it('rejects an unknown per-action status', () => {
    expect(systemCleanupRunResultSchema.safeParse({
      runId: '11111111-1111-4111-8111-111111111111',
      actions: [{ id: 'linux_pkg_cache_clean', status: 'sort-of', exitCode: 0, durationMs: 1 }],
      volumes: [],
      freedBytes: 0,
    }).success).toBe(false);
  });

  it('rejects a negative freedBytes — measurement is floored at 0 agent-side', () => {
    expect(systemCleanupRunResultSchema.safeParse({
      runId: '11111111-1111-4111-8111-111111111111',
      actions: [],
      volumes: [],
      freedBytes: -1,
    }).success).toBe(false);
  });
});

describe('parseAgentJson', () => {
  it('returns the parsed value for valid stdout', () => {
    expect(parseAgentJson(systemCleanupCatalogSchema, JSON.stringify(catalogFixture))?.catalogVersion).toBe(1);
  });

  // The W01 lesson from the AI lane (spec defect 5): an unparseable agent
  // payload must produce NOTHING, never an empty-but-valid record.
  it('returns null for empty, non-JSON or schema-invalid stdout', () => {
    for (const stdout of ['', '   ', 'not json', '{}', '[]', null, undefined]) {
      expect(parseAgentJson(systemCleanupCatalogSchema, stdout)).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/systemCleanup.test.ts
```

Expected failure: `Failed to load .../systemCleanup.test.ts` … `Cannot find module './systemCleanup'`.

- [ ] **Step 3: Implement** — create `apps/api/src/services/systemCleanup.ts`:

```ts
/**
 * Server-side contract for the OS-native cleanup engine (Disk Cleanup v2 §5.3).
 *
 * Two jobs, both about not trusting things:
 *   1. the agent-version gate, which fails CLOSED, and
 *   2. Zod shapes for the two agent payloads, so nothing the agent sends
 *      reaches the UI (and therefore a subsequent run request) unvalidated.
 */

import { z } from 'zod';
import { SYSTEM_CLEANUP_ACTION_IDS, SYSTEM_CLEANUP_RISK_FLAGS } from '@breeze/shared/validators';
import { compareAgentVersions, parseComparableVersion } from './agentEditionCompat';

/**
 * The agent release that introduced system_cleanup_list / system_cleanup_run.
 *
 * Newest tag on the branch this wave was planned from is v0.114.0 (verified
 * 2026-09-19), so W04 ships in the next minor. If a release lands before this
 * merges, bump it here in the same PR — the pin in systemCleanup.test.ts is
 * its only other mention.
 */
export const MIN_AGENT_VERSION_SYSTEM_CLEANUP = '0.115.0';

/** Machine token both system-cleanup routes answer a stale agent with. */
export const AGENT_UPDATE_REQUIRED_ERROR = 'agent_update_required';

/** The agent's fallback for a command type it has no handler for. */
export const UNKNOWN_COMMAND_TYPE_PREFIX = 'unknown command type:';

/**
 * Does this device's agent understand the two command types?
 *
 * Fails CLOSED on anything unparseable. That is not defensive padding:
 * `compareAgentVersions` returns 0 when either side fails to parse, so the
 * obvious `compareAgentVersions(device.agentVersion, MIN) >= 0` lets '' and
 * 'dev' through as "equal to the minimum" — and `devices.agent_version` is
 * `varchar(50) NOT NULL`, so '' is a real value.
 *
 * Only the CORE is compared (spec §5.3's "core semver"): `0.115.0-rc1` is the
 * lab build W05 runs the acceptance gate on, and a prerelease-aware comparison
 * would rank it below `0.115.0` and gate the gate out.
 */
export function agentSupportsSystemCleanup(agentVersion: string | null | undefined): boolean {
  if (typeof agentVersion !== 'string') return false;
  const core = agentVersion.trim().split('-', 1)[0] ?? '';
  if (!parseComparableVersion(core)) return false;
  return compareAgentVersions(core, MIN_AGENT_VERSION_SYSTEM_CLEANUP) >= 0;
}

/**
 * Defensive half of the 409 (spec §5.3). A device can report a new-enough
 * version and still lack the handler — a hand-built binary, an update that
 * reported success and rolled back. Matching the agent's own fallback string
 * turns "the command failed for an unreadable reason" into "update the agent",
 * which is the only action that helps.
 *
 * Prefix-anchored on the TRIMMED string: the phrase appearing mid-message in
 * some other error is not this condition.
 */
export function isUnknownCommandTypeError(error: string | null | undefined): boolean {
  return typeof error === 'string' && error.trimStart().startsWith(UNKNOWN_COMMAND_TYPE_PREFIX);
}

const actionIdSchema = z.enum(SYSTEM_CLEANUP_ACTION_IDS);
const riskFlagSchema = z.enum(SYSTEM_CLEANUP_RISK_FLAGS);

const subActionSchema = z.object({
  id: actionIdSchema,
  label: z.string().max(200),
  estimateBytes: z.number().int().min(0).optional(),
  estimateKnown: z.boolean(),
});

const catalogActionSchema = z.object({
  id: actionIdSchema,
  label: z.string().max(200),
  description: z.string().max(1000),
  os: z.enum(['windows', 'darwin', 'linux']),
  subActions: z.array(subActionSchema).max(SYSTEM_CLEANUP_ACTION_IDS.length).optional(),
  available: z.boolean(),
  unavailableReason: z.string().max(500).optional(),
  estimateBytes: z.number().int().min(0).optional(),
  estimateKnown: z.boolean(),
  estimateDetail: z.string().max(500).optional(),
  riskFlags: z.array(riskFlagSchema).max(SYSTEM_CLEANUP_RISK_FLAGS.length),
  affectsVolumes: z.array(z.string().max(500)).max(64),
});

/** system_cleanup_list's result (spec §7.3). */
export const systemCleanupCatalogSchema = z.object({
  catalogVersion: z.number().int().min(1),
  actions: z.array(catalogActionSchema).max(SYSTEM_CLEANUP_ACTION_IDS.length),
  volumesBefore: z.array(z.object({
    mount: z.string().max(500),
    freeBytes: z.number().int().min(0),
  })).max(64),
});

export type SystemCleanupCatalog = z.infer<typeof systemCleanupCatalogSchema>;

/** system_cleanup_run's result (spec §7.3). */
export const systemCleanupRunResultSchema = z.object({
  runId: z.string().max(64),
  actions: z.array(z.object({
    id: actionIdSchema,
    subActions: z.array(z.object({
      id: actionIdSchema,
      status: z.enum(['completed', 'failed', 'timed_out', 'unavailable']),
    })).max(SYSTEM_CLEANUP_ACTION_IDS.length).optional(),
    status: z.enum(['completed', 'failed', 'timed_out', 'unavailable']),
    exitCode: z.number().int(),
    durationMs: z.number().int().min(0).optional(),
    outputTail: z.string().max(64_000).optional(),
    error: z.string().max(4_000).optional(),
  })).max(SYSTEM_CLEANUP_ACTION_IDS.length),
  volumes: z.array(z.object({
    mount: z.string().max(500),
    freeBefore: z.number().int().min(0),
    freeAfter: z.number().int().min(0),
  })).max(64),
  freedBytes: z.number().int().min(0),
});

export type SystemCleanupRunResult = z.infer<typeof systemCleanupRunResultSchema>;

/**
 * Parse an agent stdout payload, or null.
 *
 * NULL, not an empty object. The W01 lesson (spec defect 5) is that a blank
 * record written on unparseable output becomes the "latest" answer and zeroes
 * everything downstream; here it would present an empty catalogue as "this
 * device has no cleanup actions", which is indistinguishable from the truth
 * and wrong.
 */
export function parseAgentJson<T>(schema: z.ZodType<T>, stdout: string | null | undefined): T | null {
  if (typeof stdout !== 'string' || stdout.trim() === '') return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/api && npx vitest run src/services/systemCleanup.test.ts
```

Expected: 14 tests pass.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
git add apps/api/src/services/systemCleanup.ts apps/api/src/services/systemCleanup.test.ts
git commit -m "$(cat <<'MSG'
feat(api): system-cleanup agent-version gate and agent-payload schemas

agentSupportsSystemCleanup fails CLOSED. compareAgentVersions returns 0 for an
unparseable input, so the obvious `>= 0` comparison lets '' through as "equal
to the minimum" — and devices.agent_version is NOT NULL, so '' is a real value.
Only the core is compared, so the 0.115.0-rc1 lab build W05 runs the acceptance
gate on is not gated out by its own prerelease tag.

Both agent payloads are Zod-validated against the SHARED id and risk-flag
lists, so a compromised or buggy agent cannot put an arbitrary string into a
row the UI sends straight back in a run request. Unparseable stdout yields
null, never an empty-but-valid record — the W01 blank-snapshot lesson.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
)"
```

---

### Task 11b: The four system-cleanup routes

**Files:**
- Create: `apps/api/src/routes/devices/filesystemSystemCleanup.ts`
- Create: `apps/api/src/routes/devices/filesystemSystemCleanup.test.ts` (Test)
- Modify: `apps/api/src/services/systemCleanup.ts` (Task 11a's module) — add the **queue/start seam** the routes call (Step 3a)
- Modify: `apps/api/src/services/systemCleanup.test.ts` (Test — append the seam's cases)
- Modify: `apps/api/src/routes/devices/index.ts` (mount, next to `filesystemRoutes` at `:81`)

**Interfaces:**
- Consumes (post-W02 schema — stated as a dependency): `deviceFilesystemCleanupRuns` with `kind: text NOT NULL DEFAULT 'files'`, `commandId: uuid`, `scanPath: text`, and the `filesystem_cleanup_run_status` enum carrying `'running'` (spec §4, delivered by W02). Also `getDeviceWithOrgAndSiteCheck`, `SITE_ACCESS_DENIED` (`routes/devices/helpers.ts:188`), `queueCommandForExecution` + `CommandTypes` (`services/commandQueue.ts`), `writeRouteAudit` (`services/auditEvents.ts:144`), `SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS` (Task 10), `systemCleanupRunBudgetMs` (Task 9), everything from Task 11a, `systemCleanupRunBodySchema` (Task 9).
- Produces: `export const filesystemSystemCleanupRoutes: Hono`, and — in `services/systemCleanup.ts` — the **queue/start seam W05 reuses** (alignment 17), so `list`/`run` are implemented exactly once for both the human route and the AI tool:
  ```ts
  export interface QueueSystemCleanupListArgs {
    device: { id: string; orgId: string; agentVersion: string | null; status: string };
    requestedBy: string | null;
  }
  export interface StartSystemCleanupRunArgs extends QueueSystemCleanupListArgs {
    actionIds: string[];
    params?: { journalVacuumBytes?: number };
  }
  export type SystemCleanupQueueResult =
    | { ok: true; commandId: string }
    | { ok: false; status: 409; error: 'agent_update_required'; minAgentVersion: string }
    | { ok: false; status: 400 | 503; error: string };
  export type SystemCleanupStartResult =
    | { ok: true; commandId: string; cleanupRunId: string }
    | Exclude<SystemCleanupQueueResult, { ok: true }>;
  export function queueSystemCleanupList(args: QueueSystemCleanupListArgs): Promise<SystemCleanupQueueResult>;
  export function startSystemCleanupRun(args: StartSystemCleanupRunArgs): Promise<SystemCleanupStartResult>;  // 409 'run_in_progress' | 409 agent gate
  export function failSystemCleanupRunAndCancelCommand(args: { runId: string; deviceId: string; orgId: string; error: string }): Promise<boolean>;
  ```
  **These live in the service, not inline in the route.** W05's `system_cleanup` AI tool calls the same two functions (and adds an optional `aiOrigin` to both) — if the bodies stayed in the handler, the AI lane would have to re-implement the agent-version gate, the action-id validation and the `device_filesystem_cleanup_runs` insert, which is exactly the two-call-site drift W01 spent a task deleting on the file engine.

Routes:

| Method | Path | Permission | Answer |
|---|---|---|---|
| POST | `/:id/filesystem/system-cleanup/list` | `DEVICES_EXECUTE` + `requireMfa` | `202 { success, data: { commandId, status } }` · `409 { success:false, error:'agent_update_required', minAgentVersion }` |
| GET | `/:id/filesystem/system-cleanup/list/:commandId` | `DEVICES_READ` | `200 { success, data: { status: 'running'\|'completed'\|'failed', catalog?, error? } }` · `409 agent_update_required` · `502` on unreadable agent output |
| POST | `/:id/filesystem/system-cleanup/run` | `DEVICES_EXECUTE` + `requireMfa` | `202 { success, data: { cleanupRunId, commandId } }` · `409 agent_update_required` · `409 run_in_progress` (one native run per device, spec §13 #4) · `500` |
| GET | `/:id/filesystem/system-cleanup/run/:cleanupRunId` | `DEVICES_READ` | `200 { success, data: { status, actions, volumes, freedBytes, error, requestedAt } }` · `409` |

- [ ] **Step 1: Write the failing test** — create `apps/api/src/routes/devices/filesystemSystemCleanup.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  selectMock, insertMock, updateMock,
  queueCommandForExecutionMock, getDeviceWithOrgAndSiteCheckMock, writeRouteAuditMock,
  failRunAndCancelMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  insertMock: vi.fn(),
  updateMock: vi.fn(),
  queueCommandForExecutionMock: vi.fn(),
  getDeviceWithOrgAndSiteCheckMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
  failRunAndCancelMock: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ type: 'and', conditions }),
  eq: (left: unknown, right: unknown) => ({ type: 'eq', left, right }),
}));

vi.mock('../../db', () => ({ db: { select: selectMock, insert: insertMock, update: updateMock } }));

vi.mock('../../db/schema', () => ({
  deviceCommands: { id: 'deviceCommands.id', deviceId: 'deviceCommands.deviceId', type: 'deviceCommands.type' },
  deviceFilesystemCleanupRuns: {
    id: 'runs.id', deviceId: 'runs.deviceId', orgId: 'runs.orgId', kind: 'runs.kind',
    status: 'runs.status', commandId: 'runs.commandId', requestedAt: 'runs.requestedAt',
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', { user: { id: 'user-1', email: 't@example.com' }, orgId: 'org-1', scope: 'organization' });
    return next();
  }),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: { DEVICES_READ: { resource: 'devices', action: 'read' }, DEVICES_EXECUTE: { resource: 'devices', action: 'execute' } },
}));

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: { SYSTEM_CLEANUP_LIST: 'system_cleanup_list', SYSTEM_CLEANUP_RUN: 'system_cleanup_run' },
  queueCommandForExecution: queueCommandForExecutionMock,
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));

// Partial mock: the gate, the schemas and the queue/start seam run for real
// against the mocked db above, but `failSystemCleanupRunAndCancelCommand`
// opens its own transaction and is asserted on directly.
vi.mock('../../services/systemCleanup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/systemCleanup')>()),
  failSystemCleanupRunAndCancelCommand: (...args: unknown[]) => failRunAndCancelMock(...(args as [never])),
}));

vi.mock('./helpers', () => ({
  SITE_ACCESS_DENIED: Symbol.for('site-access-denied'),
  getDeviceWithOrgAndSiteCheck: getDeviceWithOrgAndSiteCheckMock,
}));

import { filesystemSystemCleanupRoutes } from './filesystemSystemCleanup';
import { MIN_AGENT_VERSION_SYSTEM_CLEANUP } from '../../services/systemCleanup';

const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const COMMAND_ID = '33333333-3333-4333-8333-333333333333';
const RUN_ID = '44444444-4444-4444-8444-444444444444';

const modernDevice = { id: DEVICE_ID, orgId: 'org-1', hostname: 'LAB-1', agentVersion: '0.115.0' };

function app() {
  const instance = new Hono();
  instance.route('/devices', filesystemSystemCleanupRoutes);
  return instance;
}

function selectReturning(rows: unknown[]) {
  return { from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) };
}

const catalog = {
  catalogVersion: 1,
  actions: [{
    id: 'linux_pkg_cache_clean', label: 'Package manager cache', description: 'Removes archives.',
    os: 'linux', available: true, estimateBytes: 412_000_000, estimateKnown: true,
    riskFlags: [], affectsVolumes: ['/'],
  }],
  volumesBefore: [{ mount: '/', freeBytes: 9_000_000_000 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  getDeviceWithOrgAndSiteCheckMock.mockResolvedValue(modernDevice);
  queueCommandForExecutionMock.mockResolvedValue({ command: { id: COMMAND_ID, status: 'pending', createdAt: new Date('2026-09-19T10:00:00Z') } });
});

describe('POST /devices/:id/filesystem/system-cleanup/list', () => {
  it('queues the list command and audits it', async () => {
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/list`, { method: 'POST' });
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({ success: true, data: { commandId: COMMAND_ID } });
    expect(queueCommandForExecutionMock).toHaveBeenCalledWith(DEVICE_ID, 'system_cleanup_list', {}, { userId: 'user-1' });
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'device.filesystem.system_cleanup.list',
    }));
  });

  // Spec §5.3: the gate runs BEFORE queuing, so a stale agent never gets a
  // command it will answer with a bare failure.
  it('refuses an agent below the minimum with 409 agent_update_required', async () => {
    getDeviceWithOrgAndSiteCheckMock.mockResolvedValue({ ...modernDevice, agentVersion: '0.114.0' });
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/list`, { method: 'POST' });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      success: false, error: 'agent_update_required', minAgentVersion: MIN_AGENT_VERSION_SYSTEM_CLEANUP,
    });
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });

  it('refuses a device with no usable agent version (fail closed)', async () => {
    getDeviceWithOrgAndSiteCheckMock.mockResolvedValue({ ...modernDevice, agentVersion: '' });
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/list`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });
});

describe('GET /devices/:id/filesystem/system-cleanup/list/:commandId', () => {
  it('reports running while the command is pending', async () => {
    selectMock.mockReturnValue(selectReturning([{ id: COMMAND_ID, deviceId: DEVICE_ID, type: 'system_cleanup_list', status: 'pending', result: null }]));
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/list/${COMMAND_ID}`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: true, data: { status: 'running' } });
  });

  // Plan amendment 6: the generic GET /devices/:id/commands/:commandId
  // redacts stdout for every type but capture_pprof, so the catalogue has to
  // be read off the row server-side.
  it('returns the validated catalogue once the command completes', async () => {
    selectMock.mockReturnValue(selectReturning([{
      id: COMMAND_ID, deviceId: DEVICE_ID, type: 'system_cleanup_list', status: 'completed',
      result: { status: 'completed', exitCode: 0, stdout: JSON.stringify(catalog) },
    }]));
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/list/${COMMAND_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe('completed');
    expect(body.data.catalog.actions[0].id).toBe('linux_pkg_cache_clean');
  });

  // Spec §5.3's defensive fallback. It can only live on a route we own — the
  // generic command GET always answers 200 with the row.
  it('turns the agent "unknown command type:" failure into the same 409', async () => {
    selectMock.mockReturnValue(selectReturning([{
      id: COMMAND_ID, deviceId: DEVICE_ID, type: 'system_cleanup_list', status: 'failed',
      result: { status: 'failed', exitCode: 1, error: 'unknown command type: system_cleanup_list' },
    }]));
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/list/${COMMAND_ID}`);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      success: false, error: 'agent_update_required', minAgentVersion: MIN_AGENT_VERSION_SYSTEM_CLEANUP,
    });
  });

  it('answers 502 rather than an empty catalogue when the agent output is unreadable', async () => {
    selectMock.mockReturnValue(selectReturning([{
      id: COMMAND_ID, deviceId: DEVICE_ID, type: 'system_cleanup_list', status: 'completed',
      result: { status: 'completed', exitCode: 0, stdout: 'not json' },
    }]));
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/list/${COMMAND_ID}`);
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ success: false });
  });

  it('404s a command of another type or another device', async () => {
    selectMock.mockReturnValue(selectReturning([]));
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/list/${COMMAND_ID}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /devices/:id/filesystem/system-cleanup/run', () => {
  beforeEach(() => {
    insertMock.mockReturnValue({ values: () => ({ returning: () => Promise.resolve([{ id: RUN_ID }]) }) });
    updateMock.mockReturnValue({ set: () => ({ where: () => Promise.resolve([{ id: RUN_ID }]) }) });
  });

  it('records a running system run, queues the command and links the two', async () => {
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionIds: ['linux_pkg_cache_clean'], params: { journalVacuumBytes: 268435456 } }),
    });
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({ success: true, data: { cleanupRunId: RUN_ID, commandId: COMMAND_ID } });
    expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
      DEVICE_ID, 'system_cleanup_run',
      { runId: RUN_ID, actionIds: ['linux_pkg_cache_clean'], params: { journalVacuumBytes: 268435456 } },
      { userId: 'user-1' },
    );
    // The row exists BEFORE the command is queued, so a result that arrives
    // before this handler returns still has a row to close.
    expect(insertMock.mock.invocationCallOrder[0]).toBeLessThan(queueCommandForExecutionMock.mock.invocationCallOrder[0]);
  });

  it('rejects an id outside the shared catalogue with 400', async () => {
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionIds: ['win_cleanmgr:DownloadsFolder'] }),
    });
    expect(res.status).toBe(400);
    expect(insertMock).not.toHaveBeenCalled();
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });

  // Spec §13 #4: one native run per device. The claim's committed transaction
  // is what makes this check see a row a concurrent request just wrote.
  it('refuses a second run while one is already running on the device', async () => {
    selectMock.mockReturnValue(selectReturning([{ id: RUN_ID }])); // an in-flight system run
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionIds: ['linux_pkg_cache_clean'] }),
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ success: false, error: 'run_in_progress', cleanupRunId: RUN_ID });
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });

  // Spec §13 #14: the deadline is derived from the SELECTION and stored, so
  // the poll route never recomputes it. cleanmgr (60) + DISM (90) + 10 = 160.
  it('stores a per-selection deadline on the run row', async () => {
    const valuesSpy = vi.fn(() => ({ returning: () => Promise.resolve([{ id: RUN_ID }]) }));
    insertMock.mockReturnValue({ values: valuesSpy });
    await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionIds: ['win_cleanmgr', 'win_dism_component_cleanup'] }),
    });
    const written = valuesSpy.mock.calls[0]?.[0] as { plan: { deadlineAt: string } };
    const budgetMs = new Date(written.plan.deadlineAt).getTime() - Date.now();
    expect(budgetMs).toBeGreaterThan(159 * 60 * 1000);
    expect(budgetMs).toBeLessThanOrEqual(160 * 60 * 1000);
  });

  it('marks the run failed when the command cannot be queued', async () => {
    queueCommandForExecutionMock.mockResolvedValue({ error: 'Device is offline' });
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionIds: ['linux_pkg_cache_clean'] }),
    });
    expect(res.status).toBe(500);
    // A `running` row nobody will ever close is worse than no row at all.
    expect(updateMock).toHaveBeenCalled();
  });
});

describe('GET /devices/:id/filesystem/system-cleanup/run/:cleanupRunId', () => {
  it('returns the executed run projection', async () => {
    selectMock.mockReturnValue(selectReturning([{
      id: RUN_ID, deviceId: DEVICE_ID, kind: 'system', status: 'executed', error: null,
      bytesReclaimed: 3_000, requestedAt: new Date('2026-09-19T10:00:00Z'),
      executedActions: { actions: [{ id: 'linux_pkg_cache_clean', status: 'completed', exitCode: 0 }], volumes: [{ mount: '/', freeBefore: 1_000, freeAfter: 4_000 }] },
    }]));
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run/${RUN_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe('executed');
    expect(body.data.freedBytes).toBe(3_000);
    expect(body.data.volumes[0].freeAfter).toBe(4_000);
  });

  // The lazy timeout reads the deadline STORED on the row (spec §13 #14) and
  // cancels the command in the same transaction (spec §13 #6/#13) — telling
  // the operator a run failed while its command is still deliverable is the
  // hazard the live_only TTL narrows but does not close.
  it('fails a running row past its STORED deadline and cancels its command atomically', async () => {
    selectMock.mockReturnValue(selectReturning([{
      id: RUN_ID, deviceId: DEVICE_ID, kind: 'system', status: 'running', error: null,
      bytesReclaimed: 0, requestedAt: new Date(Date.now() - 20 * 60 * 1000),
      plan: { actionIds: ['linux_pkg_cache_clean'], deadlineAt: new Date(Date.now() - 60_000).toISOString() },
      executedActions: [],
    }]));
    failRunAndCancelMock.mockResolvedValue(true);

    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run/${RUN_ID}`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ data: { status: 'failed', error: 'timed out' } });
    expect(failRunAndCancelMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID, deviceId: DEVICE_ID, error: 'timed out' }),
    );
  });

  // The deadline is per-selection: a 20-minute-old run of a 160-minute
  // selection is NOT late, which a flat two-hour constant could not express
  // in the other direction either.
  it('leaves a running row inside its stored deadline alone', async () => {
    selectMock.mockReturnValue(selectReturning([{
      id: RUN_ID, deviceId: DEVICE_ID, kind: 'system', status: 'running', error: null,
      bytesReclaimed: 0, requestedAt: new Date(Date.now() - 20 * 60 * 1000),
      plan: { actionIds: ['win_cleanmgr', 'win_dism_component_cleanup'], deadlineAt: new Date(Date.now() + 140 * 60 * 1000).toISOString() },
      executedActions: [],
    }]));
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run/${RUN_ID}`);
    await expect(res.json()).resolves.toMatchObject({ data: { status: 'running' } });
    expect(failRunAndCancelMock).not.toHaveBeenCalled();
  });

  // A row written before plan.deadlineAt existed falls back to the ceiling,
  // which is the conservative direction — it waits longer, never less.
  it('falls back to the three-hour ceiling when the row carries no stored deadline', async () => {
    selectMock.mockReturnValue(selectReturning([{
      id: RUN_ID, deviceId: DEVICE_ID, kind: 'system', status: 'running', error: null,
      bytesReclaimed: 0, requestedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      plan: { actionIds: ['linux_pkg_cache_clean'] }, executedActions: [],
    }]));
    await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run/${RUN_ID}`);
    expect(failRunAndCancelMock).not.toHaveBeenCalled();
  });

  it('404s a file-kind run — this projection is for system runs only', async () => {
    selectMock.mockReturnValue(selectReturning([]));
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run/${RUN_ID}`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/routes/devices/filesystemSystemCleanup.test.ts
```

Expected failure: `Failed to load .../filesystemSystemCleanup.test.ts` … `Cannot find module './filesystemSystemCleanup'`.

- [ ] **Step 3a: Implement the queue/start seam in the service, not the route** (alignment 17) — append to `apps/api/src/services/systemCleanup.ts` (the module Task 11a created):

```ts
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { deviceFilesystemCleanupRuns } from '../db/schema';
import { queueCommandForExecution, CommandTypes } from './commandQueue';

export interface QueueSystemCleanupListArgs {
  device: { id: string; orgId: string; agentVersion: string | null; status: string };
  requestedBy: string | null;
}
export interface StartSystemCleanupRunArgs extends QueueSystemCleanupListArgs {
  actionIds: string[];
  params?: { journalVacuumBytes?: number };
}
export type SystemCleanupQueueResult =
  | { ok: true; commandId: string }
  | { ok: false; status: 409; error: 'agent_update_required'; minAgentVersion: string }
  | { ok: false; status: 400 | 503; error: string };
export type SystemCleanupStartResult =
  | { ok: true; commandId: string; cleanupRunId: string }
  | Exclude<SystemCleanupQueueResult, { ok: true }>;

/**
 * The 409-or-go decision in one place. `agentSupportsSystemCleanup` stays the
 * predicate; this is the shape both callers branch on.
 */
export function systemCleanupAgentGate(
  device: { agentVersion: string | null },
): { ok: true } | { ok: false; status: 409; error: 'agent_update_required'; minAgentVersion: string } {
  if (agentSupportsSystemCleanup(device.agentVersion)) return { ok: true };
  return {
    ok: false,
    status: 409,
    error: AGENT_UPDATE_REQUIRED_ERROR,
    minAgentVersion: MIN_AGENT_VERSION_SYSTEM_CLEANUP,
  };
}

export async function queueSystemCleanupList(
  args: QueueSystemCleanupListArgs,
): Promise<SystemCleanupQueueResult> {
  // Gate BEFORE queuing: a stale agent must never receive a command it can
  // only answer with a bare failure the UI cannot explain.
  const gate = systemCleanupAgentGate(args.device);
  if (!gate.ok) return gate;

  const queued = await queueCommandForExecution(
    args.device.id,
    CommandTypes.SYSTEM_CLEANUP_LIST,
    {},
    { userId: args.requestedBy ?? undefined },
  );
  if (!queued.command) {
    return { ok: false, status: 503, error: queued.error || 'Failed to queue the cleanup catalog request' };
  }
  return { ok: true, commandId: queued.command.id };
}

export async function startSystemCleanupRun(
  args: StartSystemCleanupRunArgs,
): Promise<SystemCleanupStartResult> {
  const gate = systemCleanupAgentGate(args.device);
  if (!gate.ok) return gate;

  const deadlineAt = new Date(Date.now() + systemCleanupRunBudgetMs(args.actionIds));

  // CLAIM in a short COMMITTED transaction, then dispatch outside it
  // (spec §13 #5). Three things this buys that the ambient request
  // transaction did not:
  //
  //   1. the single-run-per-device rule is actually enforced. Inside the
  //      request transaction the `running` row a concurrent request had just
  //      written was invisible, so two techs clicking Run a second apart both
  //      passed the check and both queued;
  //   2. a crash after the agent started deleting cannot roll the row away —
  //      the claim is committed before anything is dispatched;
  //   3. the WebSocket push in `queueCommandForExecution` cannot beat the
  //      commit, so the result handler can never arrive at a row that does
  //      not exist yet.
  //
  // This is why the two POST routes are registered in
  // SELF_MANAGED_DB_CONTEXT_ROUTES: the auth middleware must NOT have an
  // ambient transaction open around any of it.
  const claim = await withDbAccessContext(dbContextFor(args.device), async () =>
    db.transaction(async (tx) => {
      // Single run per device (spec §13 #4): a second run would rewrite the
      // StateFlags5555 profile the first one is executing from. The agent's
      // maintenance lock catches it too, but reporting `run_in_progress`
      // here is the answer a tech can act on; `busy` from the agent arrives
      // minutes later attached to a run row that should not exist.
      const [inFlight] = await tx
        .select({ id: deviceFilesystemCleanupRuns.id })
        .from(deviceFilesystemCleanupRuns)
        .where(and(
          eq(deviceFilesystemCleanupRuns.deviceId, args.device.id),
          eq(deviceFilesystemCleanupRuns.kind, 'system'),
          eq(deviceFilesystemCleanupRuns.status, 'running'),
        ))
        .limit(1);
      if (inFlight) return { conflict: inFlight.id } as const;

      const [row] = await tx
        .insert(deviceFilesystemCleanupRuns)
        .values({
          deviceId: args.device.id,
          orgId: args.device.orgId,
          requestedBy: args.requestedBy,
          kind: 'system',
          status: 'running',
          plan: {
            actionIds: args.actionIds,
            params: args.params ?? {},
            catalogVersion: null,
            // Stored, not recomputed: the poll route's lazy timeout and any
            // future reaper read THIS number, so neither has to re-derive a
            // budget from a selection it would have to re-parse (§13 #14).
            deadlineAt: deadlineAt.toISOString(),
          },
        })
        .returning({ id: deviceFilesystemCleanupRuns.id });
      return { runId: row?.id ?? null } as const;
    }),
  );

  if ('conflict' in claim) {
    return {
      ok: false,
      status: 409,
      error: 'run_in_progress',
      cleanupRunId: claim.conflict,
    };
  }
  if (!claim.runId) return { ok: false, status: 503, error: 'Failed to record the cleanup run' };
  const runId = claim.runId;

  // Dispatch OUTSIDE any transaction. queueCommandForExecution pushes over the
  // websocket, and a push inside a held transaction is both the #1105
  // connection hold and a message the agent can answer before the row commits.
  const queued = await queueCommandForExecution(
    args.device.id,
    CommandTypes.SYSTEM_CLEANUP_RUN,
    { runId, actionIds: args.actionIds, params: args.params ?? {} },
    { userId: args.requestedBy ?? undefined },
  );

  // Finalise in a SEPARATE short transaction, either way.
  if (!queued.command) {
    // A `running` row nobody will ever close is worse than no row: the panel
    // would spin until the stored deadline caught it.
    await withDbAccessContext(dbContextFor(args.device), async () =>
      db
        .update(deviceFilesystemCleanupRuns)
        .set({ status: 'failed', error: queued.error || 'Failed to queue the cleanup run', updatedAt: new Date() })
        .where(and(
          eq(deviceFilesystemCleanupRuns.id, runId),
          eq(deviceFilesystemCleanupRuns.status, 'running'),
        )),
    );
    return { ok: false, status: 503, error: queued.error || 'Failed to queue the cleanup run' };
  }

  await withDbAccessContext(dbContextFor(args.device), async () =>
    db
      .update(deviceFilesystemCleanupRuns)
      .set({ commandId: queued.command!.id, updatedAt: new Date() })
      .where(eq(deviceFilesystemCleanupRuns.id, runId)),
  );

  return { ok: true, commandId: queued.command.id, cleanupRunId: runId };
}

/**
 * Cancel a run's pending command and mark the run failed, ATOMICALLY
 * (spec §13 #6, #13).
 *
 * The two halves must not be separable. Marking the run failed while its
 * command is still deliverable is the exact hazard the `live_only` TTL class
 * narrows but does not close: the operator is told the run failed, and the
 * device then claims the command and starts deleting. Cancelling the command
 * without failing the run leaves a row spinning forever.
 *
 * Shared by the poll route's lazy timeout and by the org-move cancel branch
 * (Task 12b), so there is one implementation of "this run is over".
 */
export async function failSystemCleanupRunAndCancelCommand(args: {
  runId: string;
  deviceId: string;
  orgId: string;
  error: string;
}): Promise<boolean> {
  return withDbAccessContext(dbContextFor({ orgId: args.orgId }), async () =>
    db.transaction(async (tx) => {
      const [run] = await tx
        .update(deviceFilesystemCleanupRuns)
        .set({ status: 'failed', error: args.error, updatedAt: new Date() })
        .where(and(
          eq(deviceFilesystemCleanupRuns.id, args.runId),
          // CAS: a real result that landed first must win.
          eq(deviceFilesystemCleanupRuns.status, 'running'),
        ))
        .returning({ id: deviceFilesystemCleanupRuns.id, commandId: deviceFilesystemCleanupRuns.commandId });
      if (!run) return false;

      if (run.commandId) {
        const completedAt = new Date();
        const [cancelled] = await tx
          .update(deviceCommands)
          .set({
            status: 'cancelled',
            completedAt,
            result: { status: 'cancelled', reason: 'cleanup_run_finalised' },
          })
          .where(and(
            eq(deviceCommands.id, run.commandId),
            eq(deviceCommands.deviceId, args.deviceId),
            eq(deviceCommands.status, 'pending'),
          ))
          .returning({ id: deviceCommands.id });
        // Losing this CAS is fine and expected: the agent already claimed it,
        // so a real result is on its way and the late-result branch in the
        // handler records it without flipping the status back.
        void cancelled;
      }
      return true;
    }),
  );
}
```

Append the matching cases to `apps/api/src/services/systemCleanup.test.ts`: a stale `agentVersion` returns `{ ok: false, status: 409 }` from both functions and **never** touches `db.insert`; a queue failure inside `startSystemCleanupRun` flips the row to `failed` before returning. W05 Task 1 adds an optional `aiOrigin` to both argument types and forwards it to `queueCommandForExecution` — leave room for it, do not add it here.

- [ ] **Step 3: Implement** — create `apps/api/src/routes/devices/filesystemSystemCleanup.ts`:

```ts
/**
 * OS-native cleanup routes (Disk Cleanup v2 §5.3).
 *
 * A sibling module rather than more of routes/devices/filesystem.ts: that file
 * is already at the 500-line guideline and W02/W03 both grow it, and these four
 * routes share no state with the file engine beyond the run table.
 *
 * Both POLL routes exist because the generic
 * `GET /devices/:id/commands/:commandId` cannot serve this feature:
 * `buildStoredCommandResult` drops the agent's structured `result`, and
 * `sanitizeCommandResultForHistory` replaces `stdout` with a redaction marker
 * for every type outside RAW_STDOUT_COMMAND_TYPES (capture_pprof alone). It
 * also always answers 200, so the spec's "`unknown command type:` resolves to
 * the same 409 on poll" has nowhere else to live.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { deviceCommands, deviceFilesystemCleanupRuns } from '../../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS } from '../../services/commandTimeouts';
import { writeRouteAudit } from '../../services/auditEvents';
import { systemCleanupRunBodySchema } from '@breeze/shared/validators';
// Queueing lives in the service (Step 3a / alignment 17) — this route file
// never names a command type, which is what keeps the AI lane from growing a
// second copy of the gate and the run insert.
import {
  AGENT_UPDATE_REQUIRED_ERROR,
  MIN_AGENT_VERSION_SYSTEM_CLEANUP,
  isUnknownCommandTypeError,
  parseAgentJson,
  failSystemCleanupRunAndCancelCommand,
  queueSystemCleanupList,
  startSystemCleanupRun,
  systemCleanupCatalogSchema,
} from '../../services/systemCleanup';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';

export const filesystemSystemCleanupRoutes = new Hono();

filesystemSystemCleanupRoutes.use('*', authMiddleware);

const deviceIdParamSchema = z.object({ id: z.string().guid() });
const commandPollParamSchema = z.object({ id: z.string().guid(), commandId: z.string().guid() });
const runPollParamSchema = z.object({ id: z.string().guid(), cleanupRunId: z.string().guid() });

function agentUpdateRequired(c: Parameters<typeof writeRouteAudit>[0] & { json: (b: unknown, s: 409) => Response }) {
  return c.json(
    { success: false, error: AGENT_UPDATE_REQUIRED_ERROR, minAgentVersion: MIN_AGENT_VERSION_SYSTEM_CLEANUP },
    409,
  );
}

function readCommandResult(result: unknown): { error?: string; stdout?: string } {
  if (!result || typeof result !== 'object') return {};
  const record = result as Record<string, unknown>;
  return {
    error: typeof record.error === 'string' ? record.error : undefined,
    stdout: typeof record.stdout === 'string' ? record.stdout : undefined,
  };
}

// --- POST /:id/filesystem/system-cleanup/list -------------------------------

filesystemSystemCleanupRoutes.post(
  '/:id/filesystem/system-cleanup/list',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) return c.json({ success: false, error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ success: false, error: 'Device not found' }, 404);

    // The gate and the queue live in `services/systemCleanup.ts` so the W05 AI
    // lane runs the SAME code (alignment 17). The route keeps only HTTP
    // concerns: device resolution, status codes and the audit row.
    const queued = await queueSystemCleanupList({ device, requestedBy: auth.user.id });
    if (!queued.ok) {
      if (queued.status === 409) return agentUpdateRequired(c);
      // 500 rather than 502: Cloudflare replaces an origin 502 body with its
      // own page, which would blank the reason on hosted deployments.
      return c.json({ success: false, error: queued.error, code: 'agent_execution_failed' }, 500);
    }

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.filesystem.system_cleanup.list',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: { commandId: queued.commandId },
      result: 'success',
    });

    return c.json({ success: true, data: { commandId: queued.commandId, status: 'pending' } }, 202);
  },
);

// --- GET /:id/filesystem/system-cleanup/list/:commandId ---------------------

filesystemSystemCleanupRoutes.get(
  '/:id/filesystem/system-cleanup/list/:commandId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', commandPollParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId, commandId } = c.req.valid('param');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) return c.json({ success: false, error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ success: false, error: 'Device not found' }, 404);

    const [command] = await db
      .select()
      .from(deviceCommands)
      .where(and(
        eq(deviceCommands.id, commandId),
        eq(deviceCommands.deviceId, deviceId),
        eq(deviceCommands.type, CommandTypes.SYSTEM_CLEANUP_LIST),
      ))
      .limit(1);
    if (!command) return c.json({ success: false, error: 'Command not found' }, 404);

    const { error, stdout } = readCommandResult(command.result);
    if (isUnknownCommandTypeError(error)) return agentUpdateRequired(c);

    if (command.status !== 'completed' && command.status !== 'failed' && command.status !== 'timeout') {
      return c.json({ success: true, data: { status: 'running' as const } });
    }
    if (command.status !== 'completed') {
      return c.json({ success: true, data: { status: 'failed' as const, error: error || 'The cleanup catalog request failed' } });
    }

    const catalog = parseAgentJson(systemCleanupCatalogSchema, stdout);
    if (!catalog) {
      // NOT an empty catalogue: "this device has no cleanup actions" is
      // indistinguishable from the truth and wrong (spec defect 5's lesson).
      return c.json({ success: false, error: 'The agent returned an unreadable cleanup catalog' }, 502);
    }
    return c.json({ success: true, data: { status: 'completed' as const, catalog } });
  },
);

// --- POST /:id/filesystem/system-cleanup/run --------------------------------

filesystemSystemCleanupRoutes.post(
  '/:id/filesystem/system-cleanup/run',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', systemCleanupRunBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');
    const { actionIds, params } = c.req.valid('json');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) return c.json({ success: false, error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ success: false, error: 'Device not found' }, 404);
    // Gate + `device_filesystem_cleanup_runs` insert + queue + the failed-queue
    // rollback all live in `startSystemCleanupRun` (alignment 17). W05's AI
    // tool calls the same function, so there is exactly one place that can
    // leave a `running` row behind.
    const started = await startSystemCleanupRun({ device, requestedBy: auth.user.id, actionIds, params });
    if (!started.ok) {
      if (started.status === 409 && started.error === 'run_in_progress') {
        // Spec §13 #4: one native run per device. The agent's maintenance lock
        // catches a race that slips past this, but it answers `busy` minutes
        // later attached to a run row that should never have been created —
        // this is the answer a tech can act on.
        return c.json({
          success: false,
          error: 'run_in_progress',
          cleanupRunId: started.cleanupRunId ?? null,
        }, 409);
      }
      if (started.status === 409) return agentUpdateRequired(c);
      return c.json({ success: false, error: started.error, code: 'agent_execution_failed' }, started.status === 400 ? 400 : 500);
    }

    // The "who asked, and for what" record. The measured-bytes audit
    // (device.filesystem.system_cleanup.run) is written by the result handler;
    // this one survives a run that never reports at all.
    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.filesystem.system_cleanup.queue',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: { cleanupRunId: started.cleanupRunId, commandId: started.commandId, actionIds },
      result: 'success',
    });

    return c.json({ success: true, data: { cleanupRunId: started.cleanupRunId, commandId: started.commandId } }, 202);
  },
);

// --- GET /:id/filesystem/system-cleanup/run/:cleanupRunId -------------------

filesystemSystemCleanupRoutes.get(
  '/:id/filesystem/system-cleanup/run/:cleanupRunId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', runPollParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId, cleanupRunId } = c.req.valid('param');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) return c.json({ success: false, error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ success: false, error: 'Device not found' }, 404);

    const [run] = await db
      .select()
      .from(deviceFilesystemCleanupRuns)
      .where(and(
        eq(deviceFilesystemCleanupRuns.id, cleanupRunId),
        eq(deviceFilesystemCleanupRuns.deviceId, deviceId),
        eq(deviceFilesystemCleanupRuns.kind, 'system'),
      ))
      .limit(1);
    if (!run) return c.json({ success: false, error: 'Cleanup run not found' }, 404);

    let status = run.status;
    let error = run.error;

    // Lazy timeout. Nothing else transitions a `running` system run: the stale
    // command reaper terminalises the COMMAND, not this row, so a device that
    // never answers would otherwise leave the panel spinning indefinitely.
    //
    // The deadline is the one STORED on the row at claim time (spec §13 #14),
    // not a constant and not a recomputation: the budget depends on what was
    // selected, and two places deriving it independently is how they drift.
    // A row written before this field existed falls back to the maximum,
    // which is the conservative direction.
    const plan = (run.plan ?? {}) as { deadlineAt?: unknown };
    const deadlineAt = typeof plan.deadlineAt === 'string'
      ? new Date(plan.deadlineAt).getTime()
      : new Date(run.requestedAt).getTime() + SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS;

    if (status === 'running' && Number.isFinite(deadlineAt) && Date.now() > deadlineAt) {
      // Cancelling the command and failing the row are ONE transaction
      // (spec §13 #6/#13): telling the operator a run failed while its command
      // is still deliverable is the hazard the live_only TTL narrows but does
      // not close.
      const finalised = await failSystemCleanupRunAndCancelCommand({
        runId: run.id, deviceId, orgId: device.orgId, error: 'timed out',
      });
      if (finalised) {
        status = 'failed';
        error = 'timed out';
      }
    }

    const executed = (run.executedActions ?? {}) as { actions?: unknown[]; volumes?: unknown[] };
    return c.json({
      success: true,
      data: {
        cleanupRunId: run.id,
        status,
        error: error ?? null,
        freedBytes: run.bytesReclaimed ?? 0,
        actions: Array.isArray(executed.actions) ? executed.actions : [],
        volumes: Array.isArray(executed.volumes) ? executed.volumes : [],
        requestedAt: run.requestedAt,
      },
    });
  },
);
```

- [ ] **Step 3b: Register both POST routes as self-managed-context routes** (spec §13 #5, plan amendment 18) — in `apps/api/src/middleware/selfManagedDbContextRoutes.ts`, append to `SELF_MANAGED_DB_CONTEXT_ROUTES`:

```ts
  // Disk Cleanup v2 W04 (spec §13 #5). `startSystemCleanupRun` claims the run
  // in a SHORT COMMITTED transaction, dispatches the command outside any
  // transaction, and finalises in a second one. Under the auth middleware's
  // ambient request transaction none of that works: the `running` row a
  // concurrent request just wrote is invisible (so the single-run-per-device
  // check passes twice), a crash after the agent began deleting rolls the
  // claim away, and the websocket push happens before the commit — the agent
  // can answer a run row that does not exist yet.
  { method: 'POST', pattern: /^\/api\/v1\/devices\/[^/]+\/filesystem\/system-cleanup\/run\/?$/ },
  // Same reasoning, smaller blast radius: the list route queues a command
  // (and therefore pushes over the socket) and writes only an audit, which
  // manages its own context.
  { method: 'POST', pattern: /^\/api\/v1\/devices\/[^/]+\/filesystem\/system-cleanup\/list\/?$/ },
```

Note the pattern must NOT also match the two GET poll routes (`…/list/:commandId`, `…/run/:cleanupRunId`): those are ordinary reads that want the ambient transaction. The `\/?$` anchor after the action segment is what keeps them out, and the test below pins it.

Append to `apps/api/src/middleware/selfManagedDbContextRoutes.test.ts`:

```ts
  it('opts the two system-cleanup POSTs out of the ambient transaction, and nothing else', () => {
    expect(isSelfManagedDbContextRoute('POST', '/api/v1/devices/22222222-2222-4222-8222-222222222222/filesystem/system-cleanup/run')).toBe(true);
    expect(isSelfManagedDbContextRoute('POST', '/api/v1/devices/22222222-2222-4222-8222-222222222222/filesystem/system-cleanup/list')).toBe(true);
    // The polls are plain reads — they must keep the request transaction.
    expect(isSelfManagedDbContextRoute('GET', '/api/v1/devices/22222222-2222-4222-8222-222222222222/filesystem/system-cleanup/run/44444444-4444-4444-8444-444444444444')).toBe(false);
    expect(isSelfManagedDbContextRoute('GET', '/api/v1/devices/22222222-2222-4222-8222-222222222222/filesystem/system-cleanup/list/33333333-3333-4333-8333-333333333333')).toBe(false);
    // And the file engine's routes are untouched.
    expect(isSelfManagedDbContextRoute('POST', '/api/v1/devices/22222222-2222-4222-8222-222222222222/filesystem/scan')).toBe(false);
  });
```

- [ ] **Step 4: Mount it** — in `apps/api/src/routes/devices/index.ts`, add the import next to the filesystem one (`:16`) and mount it immediately BEFORE `filesystemRoutes` (`:81`):

```ts
import { filesystemSystemCleanupRoutes } from './filesystemSystemCleanup';
```

```ts
// Mount the native-cleanup routes before the file-engine filesystem routes and
// before core: all of these are `/:id/filesystem/...` static paths that must
// not be eaten by the `/:id` matcher in coreRoutes. Order between the two
// filesystem modules does not matter — their paths are disjoint — but keeping
// them adjacent is how a future `/:id/filesystem/*` wildcard stays reviewable.
deviceRoutes.route('/', filesystemSystemCleanupRoutes);
```

- [ ] **Step 5: Run it and watch it pass**

```bash
cd apps/api && npx vitest run src/routes/devices/filesystemSystemCleanup.test.ts
```

Expected: 14 tests pass.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
git add apps/api/src/routes/devices/filesystemSystemCleanup.ts apps/api/src/routes/devices/filesystemSystemCleanup.test.ts apps/api/src/routes/devices/index.ts
git commit -m "$(cat <<'MSG'
feat(api): system-cleanup list/run routes with their own poll endpoints

Four routes, all under /:id/filesystem/system-cleanup. The two POLL routes are
ours rather than the generic GET /devices/:id/commands/:commandId because that
route cannot serve this feature: buildStoredCommandResult drops the agent's
structured result, sanitizeCommandResultForHistory redacts stdout for every
type but capture_pprof, and it always answers 200 — so the spec's
"unknown command type: resolves to the same 409 on poll" has nowhere else to
live. RAW_STDOUT_COMMAND_TYPES is deliberately not widened: it also disables
secret redaction at ingest.

The agent-version gate runs BEFORE queuing. The run row is written before the
command is queued so an early result has something to close, and a queue
failure marks it failed immediately rather than leaving a `running` row the
panel spins on for two hours.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
)"
```

---

### Task 12: Close the run when the agent reports — on BOTH transports

**Files:**
- Modify: `apps/api/src/services/commandResultHandlers.ts` (imports; new handler; `commandResultHandlers` map at `:897`)
- Create: `apps/api/src/services/commandResultHandlers.systemCleanup.test.ts` (Test)
- Modify: `apps/api/src/routes/agents/commands.ts` (`REGISTRY_DISPATCHED_COMMAND_TYPES` at `:89`)
- Modify: `apps/api/src/routes/agents/commands.test.ts` (Test — the registry mock at `:147`)

**Interfaces:**
- Consumes: `CommandResultHandler` (`commandResultHandlers.ts:62`), `systemCleanupRunResultSchema`, `parseAgentJson`, `isUnknownCommandTypeError` (Task 11a), `writeAuditEvent` + `requestLikeFromSnapshot` (`services/auditEvents.ts:62,20`).
- Produces: `handleSystemCleanupRunResult`, registry key `system_cleanup_run`.

Why the registry and not `routes/agents/helpers.ts` (plan amendment 5): `handleFilesystemAnalysisCommandResult` is dispatched **only** from `routes/agents/commands.ts:523`, the HTTP leg. `routes/agentWs.ts:2310` dispatches this registry and nothing else. A `system_cleanup_run` result delivered over the live socket would therefore never close its run — a silent, transport-dependent failure the panel would show as a two-hour spinner.

- [ ] **Step 1: Write the failing test** — create `apps/api/src/services/commandResultHandlers.systemCleanup.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectMock, updateMock, writeAuditEventMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  writeAuditEventMock: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ type: 'and', conditions }),
  eq: (left: unknown, right: unknown) => ({ type: 'eq', left, right }),
  inArray: (column: unknown, values: unknown[]) => ({ type: 'inArray', column, values }),
  isNull: (column: unknown) => ({ type: 'isNull', column }),
  sql: Object.assign(() => ({ type: 'sql' }), { raw: () => ({ type: 'sql.raw' }) }),
}));

vi.mock('../db', () => ({
  db: { select: selectMock, update: updateMock },
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));

vi.mock('./auditEvents', () => ({
  writeAuditEvent: writeAuditEventMock,
  requestLikeFromSnapshot: () => ({ req: { header: () => undefined } }),
  ANONYMOUS_ACTOR_ID: '00000000-0000-0000-0000-000000000000',
}));

import { handleSystemCleanupRunResult } from './commandResultHandlers';

const RUN_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';

const runRow = {
  id: RUN_ID, deviceId: DEVICE_ID, orgId: 'org-1', requestedBy: 'user-1', status: 'running',
};

function params(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'agent-1',
    command: { id: 'cmd-1', deviceId: DEVICE_ID, type: 'system_cleanup_run', payload: { runId: RUN_ID } },
    commandId: 'cmd-1',
    result: { status: 'completed', exitCode: 0 },
    resolvedDeviceId: DEVICE_ID,
    stdout: JSON.stringify({
      runId: RUN_ID,
      actions: [
        { id: 'linux_pkg_cache_clean', status: 'completed', exitCode: 0, durationMs: 800 },
        { id: 'linux_journal_vacuum', status: 'failed', exitCode: 1, durationMs: 40, error: 'permission denied' },
      ],
      volumes: [{ mount: '/', freeBefore: 1_000, freeAfter: 4_000 }],
      freedBytes: 3_000,
    }),
    ...overrides,
  } as never;
}

let setSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  selectMock.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([runRow]) }) }) });
  setSpy = vi.fn(() => ({ where: () => Promise.resolve([{ id: RUN_ID }]) }));
  updateMock.mockReturnValue({ set: setSpy });
});

describe('handleSystemCleanupRunResult (spec §5.3)', () => {
  it('records executed when at least one action succeeded, with the MEASURED bytes', async () => {
    await handleSystemCleanupRunResult(params());
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({
      status: 'executed',
      bytesReclaimed: 3_000,
      approvedAt: expect.any(Date),
    }));
    const written = setSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.executedActions).toMatchObject({ freedBytes: 3_000 });
  });

  it('records failed when EVERY action failed', async () => {
    await handleSystemCleanupRunResult(params({
      stdout: JSON.stringify({
        runId: RUN_ID,
        actions: [{ id: 'linux_pkg_cache_clean', status: 'failed', exitCode: 1, durationMs: 5, error: 'boom' }],
        volumes: [], freedBytes: 0,
      }),
    }));
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  // "unavailable" is not success: the tech asked for something the device
  // could not do, and reporting `executed` would claim work that never ran.
  it('records failed when every action was unavailable', async () => {
    await handleSystemCleanupRunResult(params({
      stdout: JSON.stringify({
        runId: RUN_ID,
        actions: [{ id: 'mac_brew_cleanup', status: 'unavailable', exitCode: 1, error: 'Homebrew is not installed' }],
        volumes: [], freedBytes: 0,
      }),
    }));
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('writes the measured-bytes audit with per-action status', async () => {
    await handleSystemCleanupRunResult(params());
    expect(writeAuditEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'device.filesystem.system_cleanup.run',
      orgId: 'org-1',
      resourceType: 'device',
      resourceId: DEVICE_ID,
      actorId: 'user-1',
      details: expect.objectContaining({
        cleanupRunId: RUN_ID,
        bytesReclaimed: 3_000,
        actions: [
          { id: 'linux_pkg_cache_clean', status: 'completed' },
          { id: 'linux_journal_vacuum', status: 'failed' },
        ],
      }),
    }));
  });

  it('marks the run failed when the agent reports a non-completed command', async () => {
    await handleSystemCleanupRunResult(params({
      result: { status: 'timeout', exitCode: 1, error: 'command timed out' },
      stdout: undefined,
    }));
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', error: 'command timed out' }));
  });

  it('marks the run failed — never executed — when the payload is unreadable', async () => {
    await handleSystemCleanupRunResult(params({ stdout: 'not json' }));
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    const written = setSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.bytesReclaimed).toBeUndefined();
  });

  it('records the agent-update case with a recognisable error', async () => {
    await handleSystemCleanupRunResult(params({
      result: { status: 'failed', exitCode: 1, error: 'unknown command type: system_cleanup_run' },
      stdout: undefined,
    }));
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed', error: 'agent_update_required',
    }));
  });

  // Replays and a result whose runId does not match the payload must be inert.
  it('is a no-op when the payload carries no runId', async () => {
    await handleSystemCleanupRunResult(params({
      command: { id: 'cmd-1', deviceId: DEVICE_ID, type: 'system_cleanup_run', payload: {} },
    }));
    expect(updateMock).not.toHaveBeenCalled();
  });

  // Spec §13 #13: a late result is RECORDED, not applied. Flipping a failed
  // row back to executed would contradict what the operator was told; dropping
  // it would erase the only evidence that the work actually happened.
  it('records a result for a finalised run as lateResult without flipping its status', async () => {
    selectMock.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ ...runRow, status: 'failed' }]) }) }) });
    await handleSystemCleanupRunResult(params());

    expect(setSpy).toHaveBeenCalledTimes(1);
    const written = setSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.status).toBeUndefined();
    expect(written.bytesReclaimed).toBeUndefined();
    expect(String(written.executedActions)).toContain('lateResult');
    // The audit belongs to the run that completed, not to one already closed.
    expect(writeAuditEventMock).not.toHaveBeenCalled();
  });

  it('records an UNREADABLE late result too, flagged', async () => {
    selectMock.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ ...runRow, status: 'executed' }]) }) }) });
    await handleSystemCleanupRunResult(params({ stdout: 'not json' }));
    const written = setSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(String(written.executedActions)).toContain('unreadable');
  });

  it('is a no-op when the run belongs to another device', async () => {
    selectMock.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) });
    await handleSystemCleanupRunResult(params());
    expect(updateMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/commandResultHandlers.systemCleanup.test.ts
```

Expected failure: `TypeError: handleSystemCleanupRunResult is not a function` (the module loads; the export does not exist).

- [ ] **Step 3: Implement** — in `apps/api/src/services/commandResultHandlers.ts`, add `deviceFilesystemCleanupRuns` to the `../db/schema` import, add

```ts
import { requestLikeFromSnapshot, writeAuditEvent } from './auditEvents';
import {
  AGENT_UPDATE_REQUIRED_ERROR,
  isUnknownCommandTypeError,
  parseAgentJson,
  systemCleanupRunResultSchema,
} from './systemCleanup';
```

then add the handler above the registry and register it:

```ts
/**
 * Close an OS-native cleanup run (Disk Cleanup v2 §5.3).
 *
 * Registered HERE rather than mirrored off handleFilesystemAnalysisCommandResult
 * in routes/agents/helpers.ts, which is dispatched only by the HTTP leg
 * (routes/agents/commands.ts). agentWs.ts dispatches this registry and nothing
 * else, so a run whose result arrives over the live socket would otherwise
 * stay `running` until the two-hour lazy timeout — a failure that depends on
 * which transport the device happened to be using.
 */
export async function handleSystemCleanupRunResult(
  { command, result, resolvedDeviceId, stdout }: Parameters<CommandResultHandler>[0],
): Promise<void> {
  const payload = (command.payload ?? {}) as Record<string, unknown>;
  const runId = typeof payload.runId === 'string' ? payload.runId : null;
  if (!runId || !PG_UUID_REGEX.test(runId)) {
    console.warn(`[commandResultHandlers] system_cleanup_run ${command.id} has no usable runId; nothing to close`);
    return;
  }

  const [run] = await db
    .select({
      id: deviceFilesystemCleanupRuns.id,
      orgId: deviceFilesystemCleanupRuns.orgId,
      requestedBy: deviceFilesystemCleanupRuns.requestedBy,
      status: deviceFilesystemCleanupRuns.status,
    })
    .from(deviceFilesystemCleanupRuns)
    .where(and(
      eq(deviceFilesystemCleanupRuns.id, runId),
      eq(deviceFilesystemCleanupRuns.deviceId, resolvedDeviceId),
      eq(deviceFilesystemCleanupRuns.kind, 'system'),
    ))
    .limit(1);

  if (!run) return;

  // LATE RESULT (spec §13 #13). The run is already terminal — closed by the
  // lazy timeout, by an org-move cancel, or by a racing duplicate. The answer
  // is recorded, not applied: flipping a `failed` row back to `executed`
  // would contradict what the operator was already told and what the audit
  // already says, while dropping it silently would erase the only evidence
  // that the work DID happen (which matters when the freed bytes show up on
  // the next scan and nobody can explain them).
  if (run.status !== 'running') {
    const late = parseAgentJson(systemCleanupRunResultSchema, stdout);
    await db
      .update(deviceFilesystemCleanupRuns)
      .set({
        executedActions: sql`jsonb_set(
          COALESCE(${deviceFilesystemCleanupRuns.executedActions}, '{}'::jsonb),
          '{lateResult}',
          ${JSON.stringify({
            receivedAt: new Date().toISOString(),
            commandId: command.id,
            commandStatus: result.status,
            ...(late ? { actions: late.actions, volumes: late.volumes, freedBytes: late.freedBytes } : { unreadable: true }),
          })}::jsonb,
          true
        )`,
        updatedAt: new Date(),
      })
      .where(eq(deviceFilesystemCleanupRuns.id, runId));
    console.warn(
      `[commandResultHandlers] system_cleanup_run ${command.id} answered a ${run.status} run ${runId}; recorded as lateResult without changing its status`,
    );
    return;
  }

  const now = new Date();
  const finish = async (fields: Record<string, unknown>) => {
    await db
      .update(deviceFilesystemCleanupRuns)
      .set({ ...fields, updatedAt: now })
      .where(and(
        eq(deviceFilesystemCleanupRuns.id, runId),
        eq(deviceFilesystemCleanupRuns.status, 'running'),
      ));
  };

  if (result.status !== 'completed') {
    const agentError = result.error ?? result.stderr ?? null;
    await finish({
      status: 'failed',
      error: isUnknownCommandTypeError(agentError) ? AGENT_UPDATE_REQUIRED_ERROR : (agentError ?? 'the cleanup run failed'),
    });
    return;
  }

  const parsed = parseAgentJson(systemCleanupRunResultSchema, stdout);
  if (!parsed) {
    // Never `executed`: claiming a successful cleanup on output we could not
    // read is the one outcome a tech cannot act on.
    await finish({ status: 'failed', error: 'the agent returned an unreadable cleanup result' });
    return;
  }

  const succeeded = parsed.actions.filter((action) => action.status === 'completed').length;
  const status = succeeded > 0 ? 'executed' : 'failed';
  const failedCount = parsed.actions.length - succeeded;

  await finish({
    status,
    approvedAt: now,
    bytesReclaimed: parsed.freedBytes,
    executedActions: parsed,
    error: failedCount > 0 ? `${failedCount} cleanup action(s) did not complete` : null,
  });

  // No Hono context on this path, so the actor is attributed explicitly —
  // the pattern jobs/quoteSendQueue.ts uses for the same reason.
  writeAuditEvent(requestLikeFromSnapshot({}), {
    orgId: run.orgId,
    action: 'device.filesystem.system_cleanup.run',
    resourceType: 'device',
    resourceId: resolvedDeviceId,
    actorId: run.requestedBy,
    details: {
      cleanupRunId: runId,
      commandId: command.id,
      bytesReclaimed: parsed.freedBytes,
      actions: parsed.actions.map((action) => ({ id: action.id, status: action.status })),
      volumes: parsed.volumes,
    },
    result: status === 'executed' ? 'success' : 'failure',
  });
}
```

and in the `commandResultHandlers` map (`:897`), after `install_patches: handleInstallPatchesResult,`:

```ts
  system_cleanup_run: handleSystemCleanupRunResult,
```

- [ ] **Step 4: Dispatch it on the HTTP leg too** — in `apps/api/src/routes/agents/commands.ts`, add to `REGISTRY_DISPATCHED_COMMAND_TYPES` (`:89`):

```ts
  // Disk Cleanup v2 W04. Listed here because this route has NO inline block
  // for it — the handler is registry-only precisely so both transports run
  // exactly the same code.
  'system_cleanup_run',
```

and in `apps/api/src/routes/agents/commands.test.ts`, add to the `services/commandResultHandlers` mock (`:147`):

```ts
    system_cleanup_run: (...args: unknown[]) => systemCleanupRegistryHandlerMock(...(args as [])),
```

declaring `const systemCleanupRegistryHandlerMock = vi.fn().mockResolvedValue(undefined);` next to the other registry mocks, and append a case proving the dispatch:

```ts
  it('dispatches a system_cleanup_run result to the shared registry', async () => {
    // The whole point of registering it there rather than inline: agentWs.ts
    // dispatches the same map, so a socket-delivered result closes the run too.
    await submitResultFor('system_cleanup_run');
    expect(systemCleanupRegistryHandlerMock).toHaveBeenCalledTimes(1);
  });
```

(use the file's existing helper for submitting a result for a command of a given type; if it is inlined in each case, copy the nearest `script` case's body and change the type.)

- [ ] **Step 5: Run it and watch it pass**

```bash
cd apps/api && npx vitest run src/services/commandResultHandlers.systemCleanup.test.ts src/routes/agents/commands.test.ts
```

Expected: both green.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
git add apps/api/src/services/commandResultHandlers.ts apps/api/src/services/commandResultHandlers.systemCleanup.test.ts apps/api/src/routes/agents/commands.ts apps/api/src/routes/agents/commands.test.ts
git commit -m "$(cat <<'MSG'
feat(api): close system cleanup runs from the SHARED result registry

handleFilesystemAnalysisCommandResult, which the spec said to mirror, is
dispatched only from routes/agents/commands.ts — the HTTP leg. agentWs.ts
dispatches services/commandResultHandlers and nothing else, so mirroring it
literally would leave a run whose result arrived over the live socket stuck at
`running` until the two-hour lazy timeout, depending on nothing but which
transport the device happened to be using.

The handler is CAS-guarded on status='running' so a late duplicate cannot
replace the answer the user already saw, refuses to record `executed` on
unreadable output, treats an all-unavailable run as failed (the tech asked for
work that never ran), and maps the agent's "unknown command type:" fallback to
agent_update_required so the UI has an action to offer.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
)"
```

---

### Task 12b: Cancel propagation for system runs

Spec §13 #13. A device org-move, a decommission, or a user cancel terminalises the *command* (`propagateCancelledDeviceCommands`, called from `routes/devices/moveOrg.ts:7`, `routes/devices/core.ts:24` and `routes/devices/commands.ts:29` inside their own transactions). Without a branch, the `device_filesystem_cleanup_runs` row it belonged to stays `running` until its deadline — on a device that has just moved to another org, where the poll route that would notice is no longer reachable from the tech who started it.

**Files:**
- Modify: `apps/api/src/services/commandCancelPropagation.ts` (`propagateCancelledDeviceCommand`, the branch chain at `:76-126`)
- Create: `apps/api/src/services/commandCancelPropagation.systemCleanup.test.ts` (Test)

**Interfaces:**
- Consumes: `DbExecutor` (`commandCancelPropagation.ts:30`), `deviceFilesystemCleanupRuns`.
- Produces: no new export — one branch inside the existing function.

- [ ] **Step 1: Write the failing test** — create `apps/api/src/services/commandCancelPropagation.systemCleanup.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateMock, setSpy } = vi.hoisted(() => {
  const setSpy = vi.fn(() => ({ where: () => Promise.resolve([{ id: 'run-1' }]) }));
  return { updateMock: vi.fn(() => ({ set: setSpy })), setSpy };
});

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ type: 'and', conditions }),
  eq: (left: unknown, right: unknown) => ({ type: 'eq', left, right }),
}));
vi.mock('../db', () => ({ db: { update: updateMock, select: vi.fn(), insert: vi.fn() } }));
vi.mock('../db/schema', () => ({
  deploymentResults: { deviceCommandId: 'dr.deviceCommandId', status: 'dr.status' },
  deviceFilesystemCleanupRuns: { id: 'runs.id', status: 'runs.status', commandId: 'runs.commandId' },
}));
vi.mock('./automationActionResults', () => ({ applyAutomationActionTerminal: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./scriptExecutionTerminal', () => ({
  batchIdFromPayload: () => null,
  finalizeScriptExecutionTerminal: vi.fn(),
}));

import { propagateCancelledDeviceCommand } from './commandCancelPropagation';

const completedAt = new Date('2026-09-19T12:00:00Z');

beforeEach(() => { vi.clearAllMocks(); });

describe('system_cleanup_run cancel propagation (spec §13 #13)', () => {
  it('fails the owning run so it does not sit running on a moved device', async () => {
    const tx = { update: updateMock, select: vi.fn(), insert: vi.fn() } as never;
    await propagateCancelledDeviceCommand({
      commandId: 'cmd-1',
      type: 'system_cleanup_run',
      payload: { runId: 'run-1' },
      completedAt,
      executor: tx,
    });

    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      error: 'Cancelled before the device received it',
    }));
  });

  // The caller's transaction is the org flip itself; joining it is the whole
  // point, so the branch must use `executor`, never the ambient db.
  it('writes through the caller transaction, not the ambient db', async () => {
    const txUpdate = vi.fn(() => ({ set: () => ({ where: () => Promise.resolve([]) }) }));
    await propagateCancelledDeviceCommand({
      commandId: 'cmd-1', type: 'system_cleanup_run', payload: { runId: 'run-1' }, completedAt,
      executor: { update: txUpdate, select: vi.fn(), insert: vi.fn() } as never,
    });
    expect(txUpdate).toHaveBeenCalled();
  });

  it('is inert without a usable runId', async () => {
    await propagateCancelledDeviceCommand({
      commandId: 'cmd-1', type: 'system_cleanup_run', payload: {}, completedAt,
      executor: { update: updateMock, select: vi.fn(), insert: vi.fn() } as never,
    });
    for (const call of setSpy.mock.calls) {
      expect((call[0] as Record<string, unknown>).status).not.toBe('failed');
    }
  });

  it('leaves other command types alone', async () => {
    await propagateCancelledDeviceCommand({
      commandId: 'cmd-1', type: 'file_delete', payload: { runId: 'run-1' }, completedAt,
      executor: { update: updateMock, select: vi.fn(), insert: vi.fn() } as never,
    });
    for (const call of setSpy.mock.calls) {
      expect((call[0] as Record<string, unknown>).error).not.toBe('Cancelled before the device received it');
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/commandCancelPropagation.systemCleanup.test.ts
```

Expected failure: `expected "spy" to be called with arguments: [ ObjectContaining{status: 'failed'} ]` — the branch does not exist, so only the `deploymentResults` update runs.

- [ ] **Step 3: Implement** — in `apps/api/src/services/commandCancelPropagation.ts`, add `deviceFilesystemCleanupRuns` to the `../db/schema` import and insert the branch after the `install_patches` one (`:126`), before the `deploymentResults` update:

```ts
  // Disk Cleanup v2 (spec §13 #13). A cancelled native cleanup command leaves
  // its `device_filesystem_cleanup_runs` row `running` — on a device that has
  // just moved org or been decommissioned, nothing will ever revisit it: the
  // poll route that applies the lazy deadline is no longer reachable from the
  // tech who started the run, and the reaper terminalises COMMANDS, not this
  // row.
  //
  // In the caller's transaction (the org flip, the decommission write) for the
  // same reason every branch above is: a rollback must not leave a cancelled
  // command beside a run row that still claims to be executing.
  //
  // CAS on `running` so a real result that landed first keeps its outcome.
  if (type === 'system_cleanup_run') {
    const runId =
      payload && typeof payload.runId === 'string' && payload.runId.trim().length > 0
        ? payload.runId
        : null;
    if (runId) {
      await executor
        .update(deviceFilesystemCleanupRuns)
        .set({ status: 'failed', error: errorMessage, updatedAt: completedAt })
        .where(
          and(
            eq(deviceFilesystemCleanupRuns.id, runId),
            eq(deviceFilesystemCleanupRuns.status, 'running'),
          ),
        );
    }
  }
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/api && npx vitest run src/services/commandCancelPropagation.systemCleanup.test.ts src/services/commandCancelPropagation.test.ts
```

Expected: both green.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
git add apps/api/src/services/commandCancelPropagation.ts apps/api/src/services/commandCancelPropagation.systemCleanup.test.ts
git commit -m "$(cat <<'MSG'
feat(api): terminalise a system cleanup run when its command is cancelled

Without this branch, an org-move or decommission cancels the command and
leaves the run row `running` on a device nothing will revisit: the poll route
that applies the lazy deadline is no longer reachable from the tech who started
it, and the stale reaper terminalises commands, not this row.

Runs in the CALLER's transaction, like every other branch in this function — a
rollback must not leave a cancelled command beside a run that still claims to
be executing — and CAS on `running` so a real result that landed first keeps
its outcome.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
)"
```

---

### Task 13: `SystemCleanupPanel`

**Files:**
- Create: `apps/web/src/components/devices/filesystem/SystemCleanupPanel.tsx`
- Create: `apps/web/src/components/devices/filesystem/SystemCleanupPanel.test.tsx` (Test)

**Interfaces:**
- Consumes: `runAction`, `ActionError` (`apps/web/src/lib/runAction.ts`), `fetchWithAuth` (`apps/web/src/stores/auth.ts`), `ConfirmDialog` (`apps/web/src/components/shared/ConfirmDialog.tsx` — `variant="destructive"`, `confirmDisabled`, `children`), `formatBytes` (`apps/web/src/lib/utils.ts:22`), `useTranslation('devices')`.
- Produces: `export default function SystemCleanupPanel({ deviceId }: { deviceId: string }): JSX.Element`.

Deliberately **not** consumed: W03's `useCommandPoll` hook (plan amendment 14). This panel polls W04-owned routes that answer `409 agent_update_required`, not the generic command endpoint, and a cross-wave hook signature is not something this plan can pin.

- [ ] **Step 1: Write the failing test** — create `apps/web/src/components/devices/filesystem/SystemCleanupPanel.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SystemCleanupPanel from './SystemCleanupPanel';
import { fetchWithAuth } from '../../../stores/auth';

const showToast = vi.fn();

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

vi.mock('../../shared/Toast', () => ({ showToast: (input: unknown) => showToast(input) }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, statusText: 'x', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const DEVICE = 'dev-1';
const CMD = 'cmd-1';
const RUN = 'run-1';

const catalog = {
  catalogVersion: 1,
  actions: [
    {
      id: 'linux_pkg_cache_clean', label: 'Package manager cache', description: 'Removes downloaded archives.',
      os: 'linux', available: true, estimateBytes: 412_000_000, estimateKnown: true,
      riskFlags: [], affectsVolumes: ['/'],
    },
    {
      id: 'linux_pkg_autoremove', label: 'Remove orphaned packages', description: 'Uninstalls dependency-only packages.',
      os: 'linux', available: true, estimateKnown: false,
      riskFlags: ['removes_packages'], affectsVolumes: ['/'],
    },
    {
      id: 'linux_journal_vacuum', label: 'Trim systemd journal', description: 'Vacuums archived journals.',
      os: 'linux', available: false, unavailableReason: 'journalctl not present', estimateKnown: false,
      riskFlags: [], affectsVolumes: ['/'],
    },
  ],
  volumesBefore: [{ mount: '/', freeBytes: 9_000_000_000 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  showToast.mockReset();
});

function listFlow() {
  fetchWithAuthMock.mockImplementation((input, init) => {
    const url = String(input);
    if (url.endsWith('/filesystem/system-cleanup/list') && init?.method === 'POST') {
      return Promise.resolve(json({ success: true, data: { commandId: CMD, status: 'pending' } }, 202));
    }
    if (url.endsWith(`/filesystem/system-cleanup/list/${CMD}`)) {
      return Promise.resolve(json({ success: true, data: { status: 'completed', catalog } }));
    }
    throw new Error(`unexpected request ${url}`);
  });
}

describe('SystemCleanupPanel', () => {
  it('lists actions with "up to" estimates, unknown sizes and unavailable reasons', async () => {
    listFlow();
    render(<SystemCleanupPanel deviceId={DEVICE} />);

    fireEvent.click(screen.getByTestId('system-cleanup-check'));

    expect(await screen.findByText('Package manager cache')).toBeInTheDocument();
    // Every estimate is an upper bound and must READ like one (spec §7.1).
    expect(screen.getByTestId('system-cleanup-estimate-linux_pkg_cache_clean')).toHaveTextContent(/up to/i);
    expect(screen.getByTestId('system-cleanup-estimate-linux_pkg_autoremove')).toHaveTextContent(/unknown/i);
    expect(screen.getByTestId('system-cleanup-row-linux_journal_vacuum')).toHaveTextContent('journalctl not present');
    expect(screen.getByTestId('system-cleanup-check-linux_journal_vacuum')).toBeDisabled();
    expect(screen.getByTestId('system-cleanup-risk-linux_pkg_autoremove-removes_packages')).toBeInTheDocument();
  });

  it('requires the extra acknowledgement, and names the loss, for an irreversible action', async () => {
    listFlow();
    render(<SystemCleanupPanel deviceId={DEVICE} />);
    fireEvent.click(screen.getByTestId('system-cleanup-check'));
    await screen.findByText('Remove orphaned packages');

    fireEvent.click(screen.getByTestId('system-cleanup-check-linux_pkg_autoremove'));
    fireEvent.click(screen.getByTestId('system-cleanup-run'));

    const confirm = await screen.findByTestId('system-cleanup-confirm');
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByTestId('system-cleanup-ack-irreversible'));
    expect(screen.getByTestId('system-cleanup-confirm')).toBeEnabled();
    // The dialog must name WHICH loss is about to happen — a generic
    // "are you sure" is the failure mode spec §13 #15 is about.
    expect(screen.getByTestId('system-cleanup-consequence-removes_packages')).toBeInTheDocument();
  });

  it('arms the same gate for an action that removes OS rollback', async () => {
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/filesystem/system-cleanup/list') && init?.method === 'POST') {
        return Promise.resolve(json({ success: true, data: { commandId: CMD, status: 'pending' } }, 202));
      }
      return Promise.resolve(json({
        success: true,
        data: {
          status: 'completed',
          catalog: {
            catalogVersion: 1,
            volumesBefore: [],
            actions: [{
              id: 'win_cleanmgr:previous_installations', label: 'Previous Windows installations',
              description: 'Removes Windows.old.', os: 'windows', available: true, estimateKnown: false,
              riskFlags: ['removes_os_rollback'], affectsVolumes: [],
            }],
          },
        },
      }));
    });

    render(<SystemCleanupPanel deviceId={DEVICE} />);
    fireEvent.click(screen.getByTestId('system-cleanup-check'));
    await screen.findByText('Previous Windows installations');
    fireEvent.click(screen.getByTestId('system-cleanup-check-win_cleanmgr:previous_installations'));
    fireEvent.click(screen.getByTestId('system-cleanup-run'));

    expect(await screen.findByTestId('system-cleanup-confirm')).toBeDisabled();
    expect(screen.getByTestId('system-cleanup-consequence-removes_os_rollback')).toBeInTheDocument();
  });

  // Spec §13 #4: one native run per device. 409 run_in_progress is a distinct
  // answer from the agent-update 409 and must not raise the update banner.
  it('surfaces run_in_progress without claiming the agent needs an update', async () => {
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/filesystem/system-cleanup/list') && init?.method === 'POST') {
        return Promise.resolve(json({ success: true, data: { commandId: CMD, status: 'pending' } }, 202));
      }
      if (url.endsWith(`/filesystem/system-cleanup/list/${CMD}`)) {
        return Promise.resolve(json({ success: true, data: { status: 'completed', catalog } }));
      }
      return Promise.resolve(json({ success: false, error: 'run_in_progress', cleanupRunId: RUN }, 409));
    });

    render(<SystemCleanupPanel deviceId={DEVICE} />);
    fireEvent.click(screen.getByTestId('system-cleanup-check'));
    await screen.findByText('Package manager cache');
    fireEvent.click(screen.getByTestId('system-cleanup-check-linux_pkg_cache_clean'));
    fireEvent.click(screen.getByTestId('system-cleanup-run'));
    fireEvent.click(await screen.findByTestId('system-cleanup-confirm'));

    expect(await screen.findByTestId('system-cleanup-error')).toHaveTextContent(/already running/i);
    expect(screen.queryByTestId('system-cleanup-agent-update')).toBeNull();
  });

  it('does not show the extra acknowledgement when nothing is irreversible', async () => {
    listFlow();
    render(<SystemCleanupPanel deviceId={DEVICE} />);
    fireEvent.click(screen.getByTestId('system-cleanup-check'));
    await screen.findByText('Package manager cache');

    fireEvent.click(screen.getByTestId('system-cleanup-check-linux_pkg_cache_clean'));
    fireEvent.click(screen.getByTestId('system-cleanup-run'));

    await screen.findByTestId('system-cleanup-confirm');
    expect(screen.queryByTestId('system-cleanup-ack-irreversible')).toBeNull();
    expect(screen.getByTestId('system-cleanup-confirm')).toBeEnabled();
  });

  it('posts only the checked ids and renders the measured result', async () => {
    let runPolls = 0;
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/filesystem/system-cleanup/list') && init?.method === 'POST') {
        return Promise.resolve(json({ success: true, data: { commandId: CMD, status: 'pending' } }, 202));
      }
      if (url.endsWith(`/filesystem/system-cleanup/list/${CMD}`)) {
        return Promise.resolve(json({ success: true, data: { status: 'completed', catalog } }));
      }
      if (url.endsWith('/filesystem/system-cleanup/run') && init?.method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual({ actionIds: ['linux_pkg_cache_clean'] });
        return Promise.resolve(json({ success: true, data: { cleanupRunId: RUN, commandId: CMD } }, 202));
      }
      if (url.endsWith(`/filesystem/system-cleanup/run/${RUN}`)) {
        runPolls += 1;
        if (runPolls === 1) {
          return Promise.resolve(json({ success: true, data: { cleanupRunId: RUN, status: 'running', actions: [], volumes: [], freedBytes: 0, error: null } }));
        }
        return Promise.resolve(json({
          success: true,
          data: {
            cleanupRunId: RUN, status: 'executed', error: null, freedBytes: 3_221_225_472,
            actions: [{ id: 'linux_pkg_cache_clean', status: 'completed', exitCode: 0 }],
            volumes: [{ mount: '/', freeBefore: 1_000, freeAfter: 3_221_226_472 }],
          },
        }));
      }
      throw new Error(`unexpected request ${url}`);
    });

    render(<SystemCleanupPanel deviceId={DEVICE} />);
    fireEvent.click(screen.getByTestId('system-cleanup-check'));
    await screen.findByText('Package manager cache');
    fireEvent.click(screen.getByTestId('system-cleanup-check-linux_pkg_cache_clean'));
    fireEvent.click(screen.getByTestId('system-cleanup-run'));
    fireEvent.click(await screen.findByTestId('system-cleanup-confirm'));

    expect(await screen.findByTestId('system-cleanup-running')).toBeInTheDocument();
    const result = await screen.findByTestId('system-cleanup-result', {}, { timeout: 5_000 });
    expect(result).toHaveTextContent('3 GB');
    expect(screen.getByTestId('system-cleanup-volume-/')).toBeInTheDocument();
  });

  // Spec §8: a 409 on either call renders the banner and disables Run.
  it('renders the agent-update banner on a 409 and disables Run', async () => {
    fetchWithAuthMock.mockResolvedValue(
      json({ success: false, error: 'agent_update_required', minAgentVersion: '0.115.0' }, 409),
    );
    render(<SystemCleanupPanel deviceId={DEVICE} />);
    fireEvent.click(screen.getByTestId('system-cleanup-check'));

    const banner = await screen.findByTestId('system-cleanup-agent-update');
    expect(banner).toHaveTextContent('0.115.0');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('system-cleanup-run')).toBeDisabled();
  });

  // runAction toasts every non-401 failure; the panel must not swallow it.
  it('surfaces a failed list request', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ success: false, error: 'Device is offline' }, 500));
    render(<SystemCleanupPanel deviceId={DEVICE} />);
    fireEvent.click(screen.getByTestId('system-cleanup-check'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(await screen.findByTestId('system-cleanup-error')).toHaveAttribute('role', 'alert');
  });

  // Defect 9 in the spec's current-state table: the old tab's poll loop
  // survived unmount. Nothing may be fetched after the component is gone.
  it('stops polling on unmount', async () => {
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/filesystem/system-cleanup/list') && init?.method === 'POST') {
        return Promise.resolve(json({ success: true, data: { commandId: CMD, status: 'pending' } }, 202));
      }
      return Promise.resolve(json({ success: true, data: { status: 'running' } }));
    });

    const { unmount } = render(<SystemCleanupPanel deviceId={DEVICE} />);
    fireEvent.click(screen.getByTestId('system-cleanup-check'));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    unmount();

    const callsAtUnmount = fetchWithAuthMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(fetchWithAuthMock.mock.calls.length).toBe(callsAtUnmount);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/filesystem/SystemCleanupPanel.test.tsx
```

Expected failure: `Failed to resolve import "./SystemCleanupPanel"`.

- [ ] **Step 3: Implement** — create `apps/web/src/components/devices/filesystem/SystemCleanupPanel.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Loader2, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { ActionError, runAction } from "../../../lib/runAction";
import { fetchWithAuth } from "../../../stores/auth";
import { formatBytes } from "../../../lib/utils";
import "../../../lib/i18n";

type RiskFlag =
  | "long_running"
  | "may_require_reboot"
  | "may_require_reboot_free_state"
  | "removes_driver_rollback"
  | "removes_packages";

type SubAction = { id: string; label: string; estimateBytes?: number; estimateKnown: boolean };

type CatalogAction = {
  id: string;
  label: string;
  description: string;
  os: string;
  subActions?: SubAction[];
  available: boolean;
  unavailableReason?: string;
  estimateBytes?: number;
  estimateKnown: boolean;
  estimateDetail?: string;
  riskFlags: RiskFlag[];
  affectsVolumes: string[];
};

type Catalog = { catalogVersion: number; actions: CatalogAction[]; volumesBefore: Array<{ mount: string; freeBytes: number }> };

type RunProjection = {
  cleanupRunId: string;
  status: "running" | "executed" | "failed";
  error: string | null;
  freedBytes: number;
  actions: Array<{ id: string; status: string; exitCode?: number; error?: string }>;
  volumes: Array<{ mount: string; freeBefore: number; freeAfter: number }>;
};

const POLL_INTERVAL_MS = 2_000;
const LIST_POLL_TIMEOUT_MS = 6 * 60 * 1000;
const RUN_POLL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * OS-native cleanup (Disk Cleanup v2 §8).
 *
 * The panel owns its own polling rather than the tab's shared command-poll
 * hook: it polls W04's own endpoints, which answer `409 agent_update_required`
 * — a branch the generic command poll has no concept of. Every loop is tied
 * to an AbortController AND a mounted ref, because the defect this whole spec
 * was written against included a poll loop that outlived its component.
 */
export default function SystemCleanupPanel({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation("devices");

  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<null | "list" | "run">(null);
  const [error, setError] = useState<string | null>(null);
  const [minAgentVersion, setMinAgentVersion] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [run, setRun] = useState<RunProjection | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const mounted = useRef(true);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);

  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); }, { once: true });
    });

  const readAgentUpdate = (err: unknown): string | null => {
    if (!(err instanceof ActionError) || err.status !== 409) return null;
    const body = err.body as { error?: string; minAgentVersion?: string } | undefined;
    return body?.error === "agent_update_required" ? (body.minAgentVersion ?? "") : null;
  };

  const handleFailure = useCallback((err: unknown, fallback: string) => {
    // Two different 409s share a status code and must not share an answer:
    // `agent_update_required` raises the update banner and disables Run
    // permanently; `run_in_progress` (spec §13 #4) is transient and the right
    // advice is "wait for the one that is running".
    if (err instanceof ActionError && err.status === 409) {
      const body = err.body as { error?: string } | undefined;
      if (body?.error === 'run_in_progress') {
        setError(t("systemCleanupPanel.runInProgress"));
        return;
      }
    }
    const version = readAgentUpdate(err);
    if (version !== null) {
      setMinAgentVersion(version);
      setError(null);
      return;
    }
    if (err instanceof ActionError && err.status === 401) return; // the auth redirect owns this
    setError(err instanceof Error ? err.message : fallback);
  }, [t]);

  const checkActions = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setBusy("list");
    setError(null);
    setMinAgentVersion(null);
    setRun(null);
    try {
      const queued = await runAction<{ data: { commandId: string } }>({
        request: () => fetchWithAuth(`/devices/${deviceId}/filesystem/system-cleanup/list`, { method: "POST" }),
        errorFallback: t("systemCleanupPanel.listFailed"),
      });

      const startedAt = Date.now();
      while (Date.now() - startedAt < LIST_POLL_TIMEOUT_MS) {
        if (!mounted.current) return;
        const response = await fetchWithAuth(
          `/devices/${deviceId}/filesystem/system-cleanup/list/${queued.data.commandId}`,
          { signal: controller.signal },
        );
        const body = await response.json();
        if (response.status === 409) {
          setMinAgentVersion(body?.minAgentVersion ?? "");
          return;
        }
        if (!response.ok) throw new Error(body?.error || t("systemCleanupPanel.listFailed"));

        if (body.data.status === "completed") {
          if (!mounted.current) return;
          setCatalog(body.data.catalog as Catalog);
          setSelected(new Set());
          return;
        }
        if (body.data.status === "failed") throw new Error(body.data.error || t("systemCleanupPanel.listFailed"));
        await sleep(POLL_INTERVAL_MS, controller.signal);
      }
      throw new Error(t("systemCleanupPanel.listTimedOut"));
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (!mounted.current) return;
      handleFailure(err, t("systemCleanupPanel.listFailed"));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, [deviceId, handleFailure, t]);

  const selectedActions = useMemo(
    () => (catalog?.actions ?? []).filter((action) => selected.has(action.id)),
    [catalog, selected],
  );

  // Spec §13 #15. Three losses no later action can undo, each with its own
  // sentence in the dialog: uninstalled packages, the Windows "go back"
  // window, and a Mac's only on-disk restore points. Any of them arms the
  // second checkbox — one generic "are you sure" cannot say WHICH thing is
  // about to become unrecoverable, and that is the whole value of the step.
  const ACKNOWLEDGED_RISKS: RiskFlag[] = [
    "removes_packages",
    "removes_os_rollback",
    "removes_recovery_points",
  ];
  const consequences = ACKNOWLEDGED_RISKS.filter((flag) =>
    selectedActions.some((action) => action.riskFlags.includes(flag)),
  );
  const needsAcknowledgement = consequences.length > 0;

  const executeRun = useCallback(async () => {
    setConfirmOpen(false);
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setBusy("run");
    setError(null);
    setElapsedMs(0);
    const startedAt = Date.now();
    try {
      const queued = await runAction<{ data: { cleanupRunId: string } }>({
        request: () => fetchWithAuth(`/devices/${deviceId}/filesystem/system-cleanup/run`, {
          method: "POST",
          body: JSON.stringify({ actionIds: selectedActions.map((action) => action.id) }),
        }),
        errorFallback: t("systemCleanupPanel.runFailed"),
      });

      setRun({ cleanupRunId: queued.data.cleanupRunId, status: "running", error: null, freedBytes: 0, actions: [], volumes: [] });

      while (Date.now() - startedAt < RUN_POLL_TIMEOUT_MS) {
        if (!mounted.current) return;
        setElapsedMs(Date.now() - startedAt);
        const response = await fetchWithAuth(
          `/devices/${deviceId}/filesystem/system-cleanup/run/${queued.data.cleanupRunId}`,
          { signal: controller.signal },
        );
        const body = await response.json();
        if (response.status === 409) {
          setMinAgentVersion(body?.minAgentVersion ?? "");
          return;
        }
        if (!response.ok) throw new Error(body?.error || t("systemCleanupPanel.runFailed"));

        if (!mounted.current) return;
        setRun(body.data as RunProjection);
        if (body.data.status !== "running") return;
        await sleep(POLL_INTERVAL_MS, controller.signal);
      }
      throw new Error(t("systemCleanupPanel.runTimedOut"));
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (!mounted.current) return;
      handleFailure(err, t("systemCleanupPanel.runFailed"));
    } finally {
      if (mounted.current) { setBusy(null); setAcknowledged(false); }
    }
  }, [deviceId, handleFailure, selectedActions, t]);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const estimateLabel = (action: CatalogAction) =>
    action.estimateKnown
      ? t("systemCleanupPanel.estimateUpTo", { size: formatBytes(action.estimateBytes ?? 0) })
      : t("systemCleanupPanel.estimateUnknown");

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            <Wrench className="h-4 w-4" aria-hidden="true" />
            {t("systemCleanupPanel.title")}
          </h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t("systemCleanupPanel.description")}</p>
        </div>
        <button
          type="button"
          data-testid="system-cleanup-check"
          onClick={() => void checkActions()}
          disabled={busy !== null || minAgentVersion !== null}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium disabled:opacity-50 dark:border-slate-600"
        >
          {busy === "list" ? t("systemCleanupPanel.checking") : t("systemCleanupPanel.checkActions")}
        </button>
      </header>

      {minAgentVersion !== null && (
        <div data-testid="system-cleanup-agent-update" role="alert" className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          {t("systemCleanupPanel.agentUpdateRequired", { version: minAgentVersion })}
        </div>
      )}

      {error && (
        <div data-testid="system-cleanup-error" role="alert" className="mb-3 flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {catalog && catalog.actions.length === 0 && (
        <p className="text-xs text-slate-500 dark:text-slate-400">{t("systemCleanupPanel.noActions")}</p>
      )}

      {catalog && catalog.actions.length > 0 && (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {catalog.actions.map((action) => (
            <li key={action.id} data-testid={`system-cleanup-row-${action.id}`} className="flex items-start gap-3 py-2">
              <input
                type="checkbox"
                className="mt-1"
                data-testid={`system-cleanup-check-${action.id}`}
                checked={selected.has(action.id)}
                disabled={!action.available || busy !== null}
                onChange={() => toggle(action.id)}
                aria-label={action.label}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`text-xs font-medium ${action.available ? "text-slate-900 dark:text-slate-100" : "text-slate-400 dark:text-slate-500"}`}>
                    {action.label}
                  </span>
                  {action.riskFlags.map((flag) => (
                    <span
                      key={flag}
                      data-testid={`system-cleanup-risk-${action.id}-${flag}`}
                      className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-100"
                    >
                      {t(/* i18n-dynamic */ `systemCleanupPanel.risk.${flag}`)}
                    </span>
                  ))}
                </div>
                <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{action.description}</p>
                {!action.available && action.unavailableReason && (
                  <p className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">{action.unavailableReason}</p>
                )}
              </div>
              <span data-testid={`system-cleanup-estimate-${action.id}`} className="shrink-0 text-[11px] text-slate-500 dark:text-slate-400">
                {estimateLabel(action)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {catalog && catalog.actions.length > 0 && (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            data-testid="system-cleanup-run"
            onClick={() => { setAcknowledged(false); setConfirmOpen(true); }}
            disabled={busy !== null || selected.size === 0 || minAgentVersion !== null}
            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {t("systemCleanupPanel.run")}
          </button>
        </div>
      )}

      {busy === "run" && run?.status === "running" && (
        <p data-testid="system-cleanup-running" className="mt-3 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          {t("systemCleanupPanel.running", { minutes: Math.floor(elapsedMs / 60_000), seconds: Math.floor((elapsedMs % 60_000) / 1_000) })}
        </p>
      )}

      {run && run.status !== "running" && (
        <div data-testid="system-cleanup-result" className="mt-3 rounded-md border border-slate-200 p-3 text-xs dark:border-slate-700">
          <p className="font-medium">{t("systemCleanupPanel.freed", { size: formatBytes(run.freedBytes) })}</p>
          <ul className="mt-1 space-y-0.5 text-slate-600 dark:text-slate-300">
            {run.volumes.map((volume) => (
              <li key={volume.mount} data-testid={`system-cleanup-volume-${volume.mount}`}>
                {t("systemCleanupPanel.volumeFreed", { mount: volume.mount, size: formatBytes(Math.max(0, volume.freeAfter - volume.freeBefore)) })}
              </li>
            ))}
          </ul>
          <ul className="mt-2 space-y-0.5">
            {run.actions.map((action) => (
              <li key={action.id} data-testid={`system-cleanup-result-${action.id}`} className={action.status === "completed" ? "text-slate-600 dark:text-slate-300" : "text-amber-700 dark:text-amber-300"}>
                {`${action.id}: ${t(/* i18n-dynamic */ `systemCleanupPanel.status.${action.status}`)}`}
                {action.error ? ` — ${action.error}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void executeRun()}
        variant="destructive"
        title={t("systemCleanupPanel.confirmTitle")}
        message={t("systemCleanupPanel.confirmMessage", { count: selectedActions.length })}
        confirmLabel={t("systemCleanupPanel.run")}
        confirmTestId="system-cleanup-confirm"
        dialogTestId="system-cleanup-confirm-dialog"
        confirmDisabled={needsAcknowledgement && !acknowledged}
      >
        {needsAcknowledgement && (
          <>
            <ul data-testid="system-cleanup-consequences" className="mt-2 list-disc space-y-1 pl-5 text-xs">
              {consequences.map((flag) => (
                <li key={flag} data-testid={`system-cleanup-consequence-${flag}`}>
                  {t(/* i18n-dynamic */ `systemCleanupPanel.consequence.${flag}`)}
                </li>
              ))}
            </ul>
            <label className="mt-2 flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                data-testid="system-cleanup-ack-irreversible"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>{t("systemCleanupPanel.confirmIrreversible")}</span>
            </label>
          </>
        )}
      </ConfirmDialog>
    </section>
  );
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/web && npx vitest run src/components/devices/filesystem/SystemCleanupPanel.test.tsx
```

Expected: 7 tests pass. (The i18n keys land in Task 15; until then `t()` returns the key string, which every assertion above tolerates except the "up to"/"unknown" and version ones — run Task 15 first if those two fail on key echo, or assert on `data-testid` presence only. The final gate is Task 15's re-run of this file.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices/filesystem/SystemCleanupPanel.tsx apps/web/src/components/devices/filesystem/SystemCleanupPanel.test.tsx
git commit -m "$(cat <<'MSG'
feat(web): SystemCleanupPanel for OS-native cleanup actions

List -> rows with label, "up to" estimate or "unknown", risk badges and a
greyed unavailable reason -> Run -> destructive confirm (with a SECOND
checkbox whenever a selected action carries removes_packages) -> running state
with elapsed time -> result with the measured freed bytes per volume.

Both mutations go through runAction, so an HTTP-200 {success:false} is a
failure rather than a silent no-op, and a 409 renders the agent-update banner
(role="alert") and disables Run.

Every poll owns an AbortController AND a mounted ref: the defect this spec was
written against included a poll loop that outlived its component, and there is
a test that unmounts mid-poll and asserts no further fetch.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
)"
```

---

### Task 14: MOUNT the panel into the tab (and give the silent-mutation guard teeth on it)

This is the task past waves have skipped: W05 of a previous feature built 13 green components and never wired the page (memory `codex_wave_plans_need_explicit_mount_task`). Nothing in Task 13 renders anywhere until this lands.

**Files:**
- Modify: `apps/web/src/components/devices/DeviceFilesystemTab.tsx` (the W03 composer — see plan amendment 14)
- Create: `apps/web/src/components/devices/DeviceFilesystemTab.systemCleanup.test.tsx` (Test)
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (`TARGET_GLOBS`)

**Interfaces:**
- Consumes: `export default function DeviceFilesystemTab({ deviceId, osType, onOpenFiles }: DeviceFilesystemTabProps)` at `apps/web/src/components/devices/DeviceFilesystemTab.tsx` — the path is unchanged by W03 because `DeviceDetails.tsx:60` imports it there and `runActionAllowlist.ts:17` names it. If W03 landed the composer elsewhere, change only the import in the test below and record an amendment.
- Produces: `<SystemCleanupPanel deviceId={deviceId} />` rendered between the file-engine cleanup panel and the run history (spec §8's layout order).

- [ ] **Step 1: Write the failing page-level test** — create `apps/web/src/components/devices/DeviceFilesystemTab.systemCleanup.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import DeviceFilesystemTab from './DeviceFilesystemTab';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn().mockResolvedValue({
    ok: false, status: 404, statusText: 'Not Found',
    json: vi.fn().mockResolvedValue({ error: 'No filesystem analysis available yet' }),
  }),
  registerOrgIdProvider: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

// The panel is stubbed so this test proves ONE thing and stays immune to the
// panel's own behaviour: that the tab actually renders it. The panel's
// behaviour is covered by SystemCleanupPanel.test.tsx.
vi.mock('./filesystem/SystemCleanupPanel', () => ({
  default: ({ deviceId }: { deviceId: string }) => (
    <div data-testid="system-cleanup-panel-mounted">{deviceId}</div>
  ),
}));

describe('DeviceFilesystemTab — system cleanup mount', () => {
  it('renders SystemCleanupPanel with the device id', async () => {
    render(<DeviceFilesystemTab deviceId="dev-42" osType="linux" />);
    const mounted = await screen.findByTestId('system-cleanup-panel-mounted');
    expect(mounted).toHaveTextContent('dev-42');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/DeviceFilesystemTab.systemCleanup.test.tsx
```

Expected failure: `Unable to find an element by: [data-testid="system-cleanup-panel-mounted"]` — the component exists but nothing renders it.

- [ ] **Step 3: Mount it** — in `apps/web/src/components/devices/DeviceFilesystemTab.tsx`, add the import beside the other panel imports:

```tsx
import SystemCleanupPanel from "./filesystem/SystemCleanupPanel";
```

and render it in the composer's panel stack, after the file-engine cleanup panel and before the run history (spec §8's top-to-bottom order: volume chips → scan controls → snapshot panels → cleanup panel → **system cleanup panel** → run history):

```tsx
      {/* OS-native cleaners (Disk Cleanup v2 §8). A SECOND engine on the same
          surface: it is not path-scoped, so it deliberately sits below the
          volume-scoped panels and does not react to the volume chips. */}
      <SystemCleanupPanel deviceId={deviceId} />
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/web && npx vitest run src/components/devices/DeviceFilesystemTab
```

Expected: the mount test passes; every other `DeviceFilesystemTab*` file in the substring match stays green. (Note the substring, not a trailing slash — a trailing `/` would skip the dotted siblings entirely; CLAUDE.md "Two traps".)

- [ ] **Step 5: Put the panel under the silent-mutation guard** — in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`, add to `TARGET_GLOBS`:

```ts
  // Disk Cleanup v2 W04: both native-cleanup mutations (queue the catalog,
  // queue the run) go through runAction. This file is in the targeted set
  // from birth rather than added to the migration backlog — a silent failure
  // here is a tech believing a 90-minute DISM run started when it never did.
  'src/components/devices/filesystem/SystemCleanupPanel.tsx',
```

and bump the count assertion at `:693` from `148` (W03's value — W01 took it to 147 with the tab, W03 to 148 with `CleanupPanel.tsx`) to `149`, appending to the comment block above it:

```ts
    // Disk Cleanup v2 W04 adds filesystem/SystemCleanupPanel.tsx: 148 → 149.
```

- [ ] **Step 6: Run the guard and watch it pass**

```bash
cd apps/web && npx vitest run src/lib/__tests__/no-silent-mutations.test.ts
```

Expected: green. If it reports a bare mutation, the offender is a `fetchWithAuth(..., { method: 'POST' })` that escaped `runAction` — fix the call, do not add an exemption.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/devices/DeviceFilesystemTab.tsx apps/web/src/components/devices/DeviceFilesystemTab.systemCleanup.test.tsx apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "$(cat <<'MSG'
feat(web): mount SystemCleanupPanel in the Disk Cleanup tab

The mount task, with a page-level test that stubs the panel and asserts only
that the tab renders it — a previous wave shipped 13 green components that were
never wired to a page, and a test of the panel alone cannot catch that.

The panel joins no-silent-mutations' targeted set from birth rather than the
migration backlog: a silent failure here is a tech believing a 90-minute DISM
run started when it never did.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
)"
```

---

### Task 15: Strings in all 8 locales

**Files:**
- Modify: `apps/web/src/locales/en/devices.json`
- Modify: `apps/web/src/locales/de-DE/devices.json`
- Modify: `apps/web/src/locales/es-419/devices.json`
- Modify: `apps/web/src/locales/fr-CA/devices.json`
- Modify: `apps/web/src/locales/fr-FR/devices.json`
- Modify: `apps/web/src/locales/it-IT/devices.json`
- Modify: `apps/web/src/locales/pt-BR/devices.json`
- Modify: `apps/web/src/locales/tr-TR/devices.json`

**Interfaces:**
- Consumes: the key paths used in Task 13 (`systemCleanupPanel.*`, including the two dynamic groups `risk.*` and `status.*`, both marked `/* i18n-dynamic */` at the call sites).
- Produces: a `systemCleanupPanel` object in each catalogue. Real translations, not English copies — `translationCoverage.test.ts` caps exact-English duplicates per namespace and `localeParity.test.ts` requires identical key sets.

- [ ] **Step 1: Write the failing test** — append to `apps/web/src/components/devices/filesystem/SystemCleanupPanel.test.tsx`:

```tsx
  it('renders localised copy, not raw key paths', async () => {
    listFlow();
    render(<SystemCleanupPanel deviceId={DEVICE} />);
    // A missing key echoes its own path, which is the failure mode this catches.
    expect(screen.getByTestId('system-cleanup-check').textContent).not.toContain('systemCleanupPanel.');
    fireEvent.click(screen.getByTestId('system-cleanup-check'));
    await screen.findByText('Package manager cache');
    expect(screen.getByTestId('system-cleanup-estimate-linux_pkg_cache_clean')).toHaveTextContent(/up to 412/i);
    expect(screen.getByTestId('system-cleanup-estimate-linux_pkg_autoremove')).toHaveTextContent(/unknown/i);
    expect(screen.getByTestId('system-cleanup-risk-linux_pkg_autoremove-removes_packages').textContent)
      .not.toContain('systemCleanupPanel.');
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/filesystem/SystemCleanupPanel.test.tsx
```

Expected failure: `expected 'systemCleanupPanel.checkActions' not to contain 'systemCleanupPanel.'`.

- [ ] **Step 3: Add the English catalogue** — in `apps/web/src/locales/en/devices.json`, add a sibling of `deviceFilesystemTab`:

```json
  "systemCleanupPanel": {
    "title": "OS cleanup actions",
    "description": "Built-in maintenance tools that reclaim space the file scan cannot see. Every estimate is an upper bound.",
    "checkActions": "Check available actions",
    "checking": "Checking…",
    "run": "Run selected",
    "running": "Running… {{minutes}}m {{seconds}}s elapsed",
    "noActions": "No OS cleanup actions are available on this device.",
    "estimateUpTo": "up to {{size}}",
    "estimateUnknown": "size unknown",
    "listFailed": "Could not read the cleanup actions available on this device.",
    "listTimedOut": "The device did not answer in time. Try again in a few minutes.",
    "runFailed": "The cleanup run could not be completed.",
    "runTimedOut": "The cleanup run is still going. Reopen this tab later to see the result.",
    "agentUpdateRequired": "Update this device's agent to version {{version}} or later to run OS cleanup actions.",
    "confirmTitle": "Run OS cleanup actions?",
    "confirmMessage": "{{count}} action(s) will run on this device. Some can take up to 90 minutes and cannot be undone.",
    "confirmIrreversible": "I understand this uninstalls packages that are no longer required.",
    "freed": "Freed {{size}}",
    "volumeFreed": "{{mount}}: {{size}} freed",
    "risk": {
      "long_running": "can take a while",
      "may_require_reboot": "space freed after restart",
      "may_require_reboot_free_state": "some space freed after restart",
      "removes_driver_rollback": "removes driver rollback",
      "removes_packages": "uninstalls packages"
    },
    "status": {
      "completed": "completed",
      "failed": "failed",
      "timed_out": "timed out",
      "unavailable": "not available"
    }
  },
```

- [ ] **Step 4: Add the seven translations** — the same object, translated, in each catalogue. Placeholders (`{{size}}`, `{{count}}`, `{{minutes}}`, `{{seconds}}`, `{{mount}}`, `{{version}}`) are copied verbatim.

`de-DE`:

```json
  "systemCleanupPanel": {
    "title": "Systembereinigung",
    "description": "Integrierte Wartungswerkzeuge, die Speicher freigeben, den die Dateiprüfung nicht sieht. Jede Schätzung ist eine Obergrenze.",
    "checkActions": "Verfügbare Aktionen prüfen",
    "checking": "Wird geprüft…",
    "run": "Auswahl ausführen",
    "running": "Läuft… {{minutes}} Min. {{seconds}} Sek. vergangen",
    "noActions": "Für dieses Gerät sind keine Systembereinigungsaktionen verfügbar.",
    "estimateUpTo": "bis zu {{size}}",
    "estimateUnknown": "Größe unbekannt",
    "listFailed": "Die verfügbaren Bereinigungsaktionen konnten nicht gelesen werden.",
    "listTimedOut": "Das Gerät hat nicht rechtzeitig geantwortet. Bitte in einigen Minuten erneut versuchen.",
    "runFailed": "Die Bereinigung konnte nicht abgeschlossen werden.",
    "runTimedOut": "Die Bereinigung läuft noch. Öffnen Sie diesen Tab später erneut, um das Ergebnis zu sehen.",
    "agentUpdateRequired": "Aktualisieren Sie den Agenten dieses Geräts auf Version {{version}} oder neuer, um Systembereinigungen auszuführen.",
    "confirmTitle": "Systembereinigung ausführen?",
    "confirmMessage": "{{count}} Aktion(en) werden auf diesem Gerät ausgeführt. Einige dauern bis zu 90 Minuten und lassen sich nicht rückgängig machen.",
    "confirmIrreversible": "Mir ist bewusst, dass dabei nicht mehr benötigte Pakete deinstalliert werden.",
    "freed": "{{size}} freigegeben",
    "volumeFreed": "{{mount}}: {{size}} freigegeben",
    "risk": {
      "long_running": "kann lange dauern",
      "may_require_reboot": "Speicher wird nach Neustart frei",
      "may_require_reboot_free_state": "Teil des Speichers wird nach Neustart frei",
      "removes_driver_rollback": "entfernt Treiber-Rollback",
      "removes_packages": "deinstalliert Pakete"
    },
    "status": {
      "completed": "abgeschlossen",
      "failed": "fehlgeschlagen",
      "timed_out": "Zeitüberschreitung",
      "unavailable": "nicht verfügbar"
    }
  },
```

`es-419`:

```json
  "systemCleanupPanel": {
    "title": "Limpieza del sistema",
    "description": "Herramientas de mantenimiento integradas que recuperan espacio que el análisis de archivos no puede ver. Cada estimación es un máximo.",
    "checkActions": "Ver acciones disponibles",
    "checking": "Consultando…",
    "run": "Ejecutar selección",
    "running": "Ejecutando… {{minutes}} min {{seconds}} s transcurridos",
    "noActions": "No hay acciones de limpieza del sistema disponibles en este dispositivo.",
    "estimateUpTo": "hasta {{size}}",
    "estimateUnknown": "tamaño desconocido",
    "listFailed": "No se pudieron leer las acciones de limpieza disponibles en este dispositivo.",
    "listTimedOut": "El dispositivo no respondió a tiempo. Vuelva a intentarlo en unos minutos.",
    "runFailed": "No se pudo completar la limpieza.",
    "runTimedOut": "La limpieza sigue en curso. Vuelva a abrir esta pestaña más tarde para ver el resultado.",
    "agentUpdateRequired": "Actualice el agente de este dispositivo a la versión {{version}} o posterior para ejecutar acciones de limpieza del sistema.",
    "confirmTitle": "¿Ejecutar la limpieza del sistema?",
    "confirmMessage": "Se ejecutarán {{count}} acción(es) en este dispositivo. Algunas pueden tardar hasta 90 minutos y no se pueden deshacer.",
    "confirmIrreversible": "Entiendo que esto desinstala paquetes que ya no se necesitan.",
    "freed": "Se liberaron {{size}}",
    "volumeFreed": "{{mount}}: {{size}} liberados",
    "risk": {
      "long_running": "puede tardar",
      "may_require_reboot": "el espacio se libera tras reiniciar",
      "may_require_reboot_free_state": "parte del espacio se libera tras reiniciar",
      "removes_driver_rollback": "elimina la reversión de controladores",
      "removes_packages": "desinstala paquetes"
    },
    "status": {
      "completed": "completada",
      "failed": "con error",
      "timed_out": "tiempo agotado",
      "unavailable": "no disponible"
    }
  },
```

`fr-FR`:

```json
  "systemCleanupPanel": {
    "title": "Nettoyage du système",
    "description": "Outils de maintenance intégrés qui récupèrent l'espace que l'analyse de fichiers ne voit pas. Chaque estimation est un maximum.",
    "checkActions": "Voir les actions disponibles",
    "checking": "Vérification…",
    "run": "Exécuter la sélection",
    "running": "En cours… {{minutes}} min {{seconds}} s écoulées",
    "noActions": "Aucune action de nettoyage système n'est disponible sur cet appareil.",
    "estimateUpTo": "jusqu'à {{size}}",
    "estimateUnknown": "taille inconnue",
    "listFailed": "Impossible de lire les actions de nettoyage disponibles sur cet appareil.",
    "listTimedOut": "L'appareil n'a pas répondu à temps. Réessayez dans quelques minutes.",
    "runFailed": "Le nettoyage n'a pas pu être terminé.",
    "runTimedOut": "Le nettoyage est toujours en cours. Rouvrez cet onglet plus tard pour voir le résultat.",
    "agentUpdateRequired": "Mettez à jour l'agent de cet appareil vers la version {{version}} ou ultérieure pour exécuter des nettoyages système.",
    "confirmTitle": "Exécuter le nettoyage du système ?",
    "confirmMessage": "{{count}} action(s) vont s'exécuter sur cet appareil. Certaines peuvent durer jusqu'à 90 minutes et sont irréversibles.",
    "confirmIrreversible": "Je comprends que cela désinstalle des paquets qui ne sont plus nécessaires.",
    "freed": "{{size}} libérés",
    "volumeFreed": "{{mount}} : {{size}} libérés",
    "risk": {
      "long_running": "peut être long",
      "may_require_reboot": "espace libéré après redémarrage",
      "may_require_reboot_free_state": "une partie de l'espace est libérée après redémarrage",
      "removes_driver_rollback": "supprime la restauration des pilotes",
      "removes_packages": "désinstalle des paquets"
    },
    "status": {
      "completed": "terminée",
      "failed": "échouée",
      "timed_out": "délai dépassé",
      "unavailable": "indisponible"
    }
  },
```

`fr-CA` — the same French copy with the Canadian spacing convention (no space before `?` and `:`) and `Réessayer` phrasing:

```json
  "systemCleanupPanel": {
    "title": "Nettoyage du système",
    "description": "Outils de maintenance intégrés qui récupèrent l'espace que l'analyse de fichiers ne voit pas. Chaque estimation est un maximum.",
    "checkActions": "Voir les actions disponibles",
    "checking": "Vérification…",
    "run": "Exécuter la sélection",
    "running": "En cours… {{minutes}} min {{seconds}} s écoulées",
    "noActions": "Aucune action de nettoyage système n'est offerte sur cet appareil.",
    "estimateUpTo": "jusqu'à {{size}}",
    "estimateUnknown": "taille inconnue",
    "listFailed": "Impossible de lire les actions de nettoyage offertes sur cet appareil.",
    "listTimedOut": "L'appareil n'a pas répondu à temps. Réessayez dans quelques minutes.",
    "runFailed": "Le nettoyage n'a pas pu être terminé.",
    "runTimedOut": "Le nettoyage est toujours en cours. Revenez à cet onglet plus tard pour voir le résultat.",
    "agentUpdateRequired": "Mettez à jour l'agent de cet appareil vers la version {{version}} ou ultérieure pour exécuter des nettoyages système.",
    "confirmTitle": "Exécuter le nettoyage du système?",
    "confirmMessage": "{{count}} action(s) vont s'exécuter sur cet appareil. Certaines peuvent durer jusqu'à 90 minutes et sont irréversibles.",
    "confirmIrreversible": "Je comprends que cela désinstalle des paquets qui ne sont plus nécessaires.",
    "freed": "{{size}} libérés",
    "volumeFreed": "{{mount}}: {{size}} libérés",
    "risk": {
      "long_running": "peut être long",
      "may_require_reboot": "espace libéré après redémarrage",
      "may_require_reboot_free_state": "une partie de l'espace est libérée après redémarrage",
      "removes_driver_rollback": "supprime la restauration des pilotes",
      "removes_packages": "désinstalle des paquets"
    },
    "status": {
      "completed": "terminée",
      "failed": "échouée",
      "timed_out": "délai dépassé",
      "unavailable": "non offerte"
    }
  },
```

`it-IT`:

```json
  "systemCleanupPanel": {
    "title": "Pulizia del sistema",
    "description": "Strumenti di manutenzione integrati che recuperano spazio che la scansione dei file non può vedere. Ogni stima è un limite massimo.",
    "checkActions": "Verifica le azioni disponibili",
    "checking": "Verifica in corso…",
    "run": "Esegui selezione",
    "running": "In esecuzione… {{minutes}} min {{seconds}} s trascorsi",
    "noActions": "Nessuna azione di pulizia del sistema è disponibile su questo dispositivo.",
    "estimateUpTo": "fino a {{size}}",
    "estimateUnknown": "dimensione sconosciuta",
    "listFailed": "Impossibile leggere le azioni di pulizia disponibili su questo dispositivo.",
    "listTimedOut": "Il dispositivo non ha risposto in tempo. Riprova tra qualche minuto.",
    "runFailed": "Non è stato possibile completare la pulizia.",
    "runTimedOut": "La pulizia è ancora in corso. Riapri questa scheda più tardi per vedere il risultato.",
    "agentUpdateRequired": "Aggiorna l'agente di questo dispositivo alla versione {{version}} o successiva per eseguire le pulizie di sistema.",
    "confirmTitle": "Eseguire la pulizia del sistema?",
    "confirmMessage": "Verranno eseguite {{count}} azione/i su questo dispositivo. Alcune possono richiedere fino a 90 minuti e non sono reversibili.",
    "confirmIrreversible": "Ho capito che questa operazione disinstalla pacchetti non più necessari.",
    "freed": "Liberati {{size}}",
    "volumeFreed": "{{mount}}: {{size}} liberati",
    "risk": {
      "long_running": "può richiedere tempo",
      "may_require_reboot": "spazio liberato dopo il riavvio",
      "may_require_reboot_free_state": "parte dello spazio è liberata dopo il riavvio",
      "removes_driver_rollback": "rimuove il ripristino dei driver",
      "removes_packages": "disinstalla pacchetti"
    },
    "status": {
      "completed": "completata",
      "failed": "non riuscita",
      "timed_out": "tempo scaduto",
      "unavailable": "non disponibile"
    }
  },
```

`pt-BR`:

```json
  "systemCleanupPanel": {
    "title": "Limpeza do sistema",
    "description": "Ferramentas de manutenção integradas que recuperam espaço que a varredura de arquivos não enxerga. Cada estimativa é um limite máximo.",
    "checkActions": "Ver ações disponíveis",
    "checking": "Consultando…",
    "run": "Executar seleção",
    "running": "Executando… {{minutes}} min {{seconds}} s decorridos",
    "noActions": "Nenhuma ação de limpeza do sistema está disponível neste dispositivo.",
    "estimateUpTo": "até {{size}}",
    "estimateUnknown": "tamanho desconhecido",
    "listFailed": "Não foi possível ler as ações de limpeza disponíveis neste dispositivo.",
    "listTimedOut": "O dispositivo não respondeu a tempo. Tente novamente em alguns minutos.",
    "runFailed": "Não foi possível concluir a limpeza.",
    "runTimedOut": "A limpeza ainda está em andamento. Reabra esta aba mais tarde para ver o resultado.",
    "agentUpdateRequired": "Atualize o agente deste dispositivo para a versão {{version}} ou posterior para executar limpezas do sistema.",
    "confirmTitle": "Executar a limpeza do sistema?",
    "confirmMessage": "{{count}} ação(ões) serão executadas neste dispositivo. Algumas podem levar até 90 minutos e não podem ser desfeitas.",
    "confirmIrreversible": "Entendo que isso desinstala pacotes que não são mais necessários.",
    "freed": "{{size}} liberados",
    "volumeFreed": "{{mount}}: {{size}} liberados",
    "risk": {
      "long_running": "pode demorar",
      "may_require_reboot": "espaço liberado após reiniciar",
      "may_require_reboot_free_state": "parte do espaço é liberada após reiniciar",
      "removes_driver_rollback": "remove a reversão de drivers",
      "removes_packages": "desinstala pacotes"
    },
    "status": {
      "completed": "concluída",
      "failed": "com falha",
      "timed_out": "tempo esgotado",
      "unavailable": "indisponível"
    }
  },
```

`tr-TR`:

```json
  "systemCleanupPanel": {
    "title": "Sistem temizliği",
    "description": "Dosya taramasının göremediği alanı geri kazanan yerleşik bakım araçları. Her tahmin bir üst sınırdır.",
    "checkActions": "Kullanılabilir işlemleri denetle",
    "checking": "Denetleniyor…",
    "run": "Seçilenleri çalıştır",
    "running": "Çalışıyor… {{minutes}} dk {{seconds}} sn geçti",
    "noActions": "Bu cihazda kullanılabilir sistem temizliği işlemi yok.",
    "estimateUpTo": "en çok {{size}}",
    "estimateUnknown": "boyut bilinmiyor",
    "listFailed": "Bu cihazdaki temizlik işlemleri okunamadı.",
    "listTimedOut": "Cihaz zamanında yanıt vermedi. Birkaç dakika sonra yeniden deneyin.",
    "runFailed": "Temizlik tamamlanamadı.",
    "runTimedOut": "Temizlik hâlâ sürüyor. Sonucu görmek için bu sekmeyi daha sonra yeniden açın.",
    "agentUpdateRequired": "Sistem temizliği çalıştırmak için bu cihazın aracısını {{version}} veya sonraki bir sürüme güncelleyin.",
    "confirmTitle": "Sistem temizliği çalıştırılsın mı?",
    "confirmMessage": "Bu cihazda {{count}} işlem çalıştırılacak. Bazıları 90 dakikaya kadar sürebilir ve geri alınamaz.",
    "confirmIrreversible": "Bunun artık gerekmeyen paketleri kaldıracağını anlıyorum.",
    "freed": "{{size}} boşaltıldı",
    "volumeFreed": "{{mount}}: {{size}} boşaltıldı",
    "risk": {
      "long_running": "uzun sürebilir",
      "may_require_reboot": "alan yeniden başlatmadan sonra boşalır",
      "may_require_reboot_free_state": "alanın bir kısmı yeniden başlatmadan sonra boşalır",
      "removes_driver_rollback": "sürücü geri almayı kaldırır",
      "removes_packages": "paketleri kaldırır"
    },
    "status": {
      "completed": "tamamlandı",
      "failed": "başarısız",
      "timed_out": "zaman aşımı",
      "unavailable": "kullanılamıyor"
    }
  },
```

- [ ] **Step 4b: Apply the quorum delta to all eight catalogues** (spec §13 #4, #14, #15). `confirmRemovesPackages` is **renamed** to `confirmIrreversible` — the gate now covers three losses, not one — and eight keys are added. Placeholders are copied verbatim.

| Key | en | de-DE | es-419 | fr-FR | fr-CA | it-IT | pt-BR | tr-TR |
|---|---|---|---|---|---|---|---|---|
| `runInProgress` | An OS cleanup is already running on this device. Wait for it to finish, then try again. | Auf diesem Gerät läuft bereits eine Systembereinigung. Warten Sie, bis sie beendet ist. | Ya hay una limpieza del sistema en curso en este dispositivo. Espere a que termine. | Un nettoyage système est déjà en cours sur cet appareil. Attendez qu'il se termine. | Un nettoyage système est déjà en cours sur cet appareil. Attendez qu'il se termine. | Una pulizia del sistema è già in corso su questo dispositivo. Attendi che finisca. | Já há uma limpeza do sistema em andamento neste dispositivo. Aguarde a conclusão. | Bu cihazda zaten bir sistem temizliği çalışıyor. Bitmesini bekleyin. |
| `confirmIrreversible` | I understand these changes cannot be undone. | Mir ist bewusst, dass diese Änderungen nicht rückgängig gemacht werden können. | Entiendo que estos cambios no se pueden deshacer. | Je comprends que ces changements sont irréversibles. | Je comprends que ces changements sont irréversibles. | Ho capito che queste modifiche non sono reversibili. | Entendo que estas alterações não podem ser desfeitas. | Bu değişikliklerin geri alınamayacağını anlıyorum. |
| `consequence.removes_packages` | Packages that are no longer required will be uninstalled. | Nicht mehr benötigte Pakete werden deinstalliert. | Se desinstalarán los paquetes que ya no se necesitan. | Les paquets qui ne sont plus nécessaires seront désinstallés. | Les paquets qui ne sont plus nécessaires seront désinstallés. | I pacchetti non più necessari verranno disinstallati. | Os pacotes que não são mais necessários serão desinstalados. | Artık gerekmeyen paketler kaldırılacak. |
| `consequence.removes_os_rollback` | This device will no longer be able to roll back to its previous Windows version. | Dieses Gerät kann danach nicht mehr zur vorherigen Windows-Version zurückkehren. | Este dispositivo ya no podrá volver a su versión anterior de Windows. | Cet appareil ne pourra plus revenir à sa version précédente de Windows. | Cet appareil ne pourra plus revenir à sa version précédente de Windows. | Questo dispositivo non potrà più tornare alla versione precedente di Windows. | Este dispositivo não poderá mais voltar à versão anterior do Windows. | Bu cihaz artık önceki Windows sürümüne geri dönemeyecek. |
| `consequence.removes_recovery_points` | Local snapshots are deleted. If the Time Machine disk is not connected, this device has no other restore points. | Lokale Snapshots werden gelöscht. Ohne angeschlossene Time-Machine-Festplatte hat dieses Gerät keine weiteren Wiederherstellungspunkte. | Se eliminan las instantáneas locales. Si el disco de Time Machine no está conectado, este dispositivo no tiene otros puntos de restauración. | Les instantanés locaux sont supprimés. Si le disque Time Machine n'est pas connecté, cet appareil n'a aucun autre point de restauration. | Les instantanés locaux sont supprimés. Si le disque Time Machine n'est pas branché, cet appareil n'a aucun autre point de restauration. | Le istantanee locali vengono eliminate. Se il disco Time Machine non è collegato, questo dispositivo non ha altri punti di ripristino. | Os instantâneos locais são excluídos. Se o disco do Time Machine não estiver conectado, este dispositivo não terá outros pontos de restauração. | Yerel anlık görüntüler silinir. Time Machine diski bağlı değilse bu cihazın başka geri yükleme noktası kalmaz. |
| `risk.removes_os_rollback` | ends Windows rollback | beendet Windows-Rollback | fin de la reversión de Windows | fin de la restauration Windows | fin de la restauration Windows | fine del rollback di Windows | encerra a reversão do Windows | Windows geri almayı bitirir |
| `risk.removes_recovery_points` | removes restore points | entfernt Wiederherstellungspunkte | elimina puntos de restauración | supprime les points de restauration | supprime les points de restauration | rimuove i punti di ripristino | remove pontos de restauração | geri yükleme noktalarını kaldırır |
| `status.busy` | not started — the device was busy | nicht gestartet – Gerät war beschäftigt | no se inició: el dispositivo estaba ocupado | non démarrée — appareil occupé | non démarrée — appareil occupé | non avviata — dispositivo occupato | não iniciada — o dispositivo estava ocupado | başlatılmadı — cihaz meşguldü |
| `status.not_started` | not started — the run ran out of time | nicht gestartet – Zeitbudget aufgebraucht | no se inició: se agotó el tiempo | non démarrée — temps épuisé | non démarrée — temps épuisé | non avviata — tempo esaurito | não iniciada — o tempo acabou | başlatılmadı — süre doldu |

Two notes the translator must keep: `status.busy` and `status.not_started` both read "not started" on purpose — from the tech's point of view they are the same outcome with different causes, and the cause is what the rest of the sentence carries. And `runInProgress` is deliberately NOT phrased as an error with the device: it is an ordinary scheduling collision.

- [ ] **Step 5: Run the panel test and the whole i18n suite**

```bash
cd apps/web && npx vitest run src/components/devices/filesystem/SystemCleanupPanel.test.tsx src/lib/i18n
```

Expected: the panel's 8 tests pass and `localeParity`, `translationCoverage`, `keyUsage`, `extractionQuality` and `terminologyQuality` all stay green. If `translationCoverage` reports new exact-English duplicates, the offender is a locale where a word genuinely spells the same (e.g. `BranchCache`); raise that namespace's baseline **with the reason in a comment**, as every existing entry in that file does.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/locales/en/devices.json apps/web/src/locales/de-DE/devices.json apps/web/src/locales/es-419/devices.json apps/web/src/locales/fr-CA/devices.json apps/web/src/locales/fr-FR/devices.json apps/web/src/locales/it-IT/devices.json apps/web/src/locales/pt-BR/devices.json apps/web/src/locales/tr-TR/devices.json apps/web/src/components/devices/filesystem/SystemCleanupPanel.test.tsx
git commit -m "$(cat <<'MSG'
feat(web): system-cleanup panel strings in all 8 locales

Real translations, not English copies. Every estimate string carries the
"up to" framing in its own language, because the number really is an upper
bound and a localised catalogue that drops that qualifier would be the one
place the honesty is lost.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
)"
```

---

### Task 16: Documentation

**Files:**
- Modify: `apps/docs/src/content/docs/agents/commands.mdx` (File Operations table at `:315-322`; new subsections after `### filesystem_analysis` at `:377-403`)
- Modify: `apps/docs/src/content/docs/features/filesystem-analysis.mdx` (a new `## OS Cleanup Actions` section after `## Cleanup Targets` at `:373-431`; the API Reference table at `:494-505`)
- Modify: `apps/api/src/data/docsIndex.json` (regenerated)

W05 owns the full rewrite of `filesystem-analysis.mdx` for volumes and the finished tab (spec §11). W04 adds only the native-catalogue section and the four routes, so the page is never wrong about a shipped feature between the two waves.

- [ ] **Step 1: Extend the File Operations table** — in `apps/docs/src/content/docs/agents/commands.mdx`, add two rows after the `filesystem_analysis` row (`:322`):

```md
| `system_cleanup_list` | List the OS-native cleanup actions available on the device | *(none)* |
| `system_cleanup_run` | Run selected OS-native cleanup actions | `runId`, `actionIds`, `params` |
```

- [ ] **Step 2: Document both command types** — after the `### filesystem_analysis` subsection (`:403`, immediately before the `---` that precedes `## Terminal`):

```md
### `system_cleanup_list`

Returns the catalog of OS-native cleanup actions this device can perform. Read-only: it probes for the presence of each tool, checks write access where relevant, and — for the actions that have a non-mutating simulation mode — produces a size estimate. It removes nothing.

Takes no parameters.

The response contains `catalogVersion`, `volumesBefore` (per-volume free space at the time of the check), and an `actions[]` array. Each action carries `id`, `label`, `description`, `os`, `available`, an optional `unavailableReason`, `estimateBytes` / `estimateKnown` / `estimateDetail`, `riskFlags[]` and `affectsVolumes[]`. The Windows `win_cleanmgr` action also carries `subActions[]`, one per Disk Cleanup handler registered on that build.

<Aside type="caution">
  **Every estimate is an upper bound.** DISM's two reclaimable fields exceed what `StartComponentCleanup` actually frees (a 30-day grace period applies and the most recent backup is retained), `journalctl` vacuums archived journals only, and Time Machine thinning is opportunistic. When a parser cannot read a tool's output, the action reports `estimateKnown: false` rather than `0` — "unknown" and "nothing to reclaim" are different answers.
</Aside>

Estimation runs concurrently with an overall three-minute cap; an action whose estimate does not finish inside it reports `estimateKnown: false`.

### `system_cleanup_run`

Runs the selected catalog actions **sequentially**, in catalog order, and measures the result.

| Param | Type | Required | Description |
|---|---|---|---|
| `runId` | string | Yes | The `device_filesystem_cleanup_runs` row this result closes |
| `actionIds` | string[] | Yes | A non-empty subset of the catalog's ids |
| `params.journalVacuumBytes` | int | No | Target size for `linux_journal_vacuum` (64 MiB – 4 GiB, default 256 MiB) |

The response contains `runId`, an `actions[]` array (`id`, optional `subActions[]`, `status`, `exitCode`, `durationMs`, `outputTail`, `error`), `volumes[]` (`mount`, `freeBefore`, `freeAfter`) and `freedBytes`.

Per-action `status` values:

| Status | Meaning |
|---|---|
| `completed` | The tool ran and exited cleanly |
| `failed` | The tool ran and reported a problem |
| `timed_out` | This action overran its own cap and its process tree was terminated |
| `unavailable` | The tool is not present, or the agent cannot write where it needs to. Never attempted |
| `busy` | Another maintenance operation (a concurrent run, a patch job's package cleanup) held the agent's maintenance lock. Nothing was attempted; retry |
| `not_started` | The run's aggregate budget expired before this action's turn |

`freedBytes` is **measured**, not estimated: it is the sum over affected volumes of free-space-after minus free-space-before, floored at zero. One action failing does not stop the next.

The run is bounded by an aggregate budget — the sum of the selected actions' own timeouts plus ten minutes, capped at three hours — computed when the run is queued and recorded on it. Actions run **sequentially**, serialised across the whole agent process against each other and against package-manager maintenance, so two runs can never rewrite one another's Disk Cleanup selection.

Both command types are delivered **live-only**: a queued command expires after fifteen minutes rather than waiting days for a device to come back, because the cleanup run it belongs to is closed out on its own budget and a command that outlives it would act with nobody watching.

<Aside>
  The action catalog is closed. The only input the server accepts is a set of ids from a fixed list plus one bounded integer; every command line the agent runs is built from constants, with absolute binary paths, no shell, a per-action timeout and a 16 KiB output cap. `cleanmgr` handlers that touch user data or recovery state — Downloads, the recovery image, language packs, and all per-user caches — are excluded in code, and DISM is never invoked with `/ResetBase`.
</Aside>

Both command types require agent **0.115.0** or later. Older agents answer with `unknown command type:`, which the API surfaces as `409 agent_update_required`.
```

- [ ] **Step 3: Document the catalog and the routes** — in `apps/docs/src/content/docs/features/filesystem-analysis.mdx`, add after the `### Additional Detected Items (Not Auto-Cleaned)` block (`:431`, before the `---` that precedes `## Database Schema`):

```md
---

## OS Cleanup Actions

The file scanner can only reclaim what it can enumerate. A component store, a Windows Update backup, an APFS local snapshot and a systemd journal are all invisible to it — they are managed by the operating system through its own tools. Breeze runs those tools directly as a **second cleanup engine** on the same tab.

The two engines are deliberately separate. The file engine previews every path before it deletes anything; the native engine cannot, because the tools it drives report a summary rather than a file list. So instead of a preview it is constrained by a **closed catalog**: a fixed list of vetted actions, with every command line built from constants inside the agent.

### Catalog

| Action | Platform | What it does | Risk |
|---|---|---|---|
| Windows Disk Cleanup | Windows | Runs the selected built-in Disk Cleanup handlers (Update Cleanup, Delivery Optimization, previous installations, setup and error-reporting logs, memory dumps, Defender scan history, BranchCache and others) | Update Cleanup releases its space after a restart; Device Driver Packages removes driver rollback |
| Component store cleanup | Windows | `DISM /Online /Cleanup-Image /StartComponentCleanup` — removes superseded components from WinSxS | Long-running; some space is released after the next restart. Never `/ResetBase`, so installed updates stay removable |
| Time Machine local snapshots | macOS | Deletes the local APFS snapshots on the startup volume | Backups on the Time Machine destination are untouched |
| Homebrew cache and old versions | macOS | `brew cleanup --prune=all` | Installed software stays at its current version |
| Package manager cache | Linux | `apt-get clean` / `dnf clean all` / `yum clean all` | Removed archives are re-downloadable |
| Remove orphaned packages | Linux | `apt-get -y autoremove` / `dnf -y autoremove` | **Uninstalls packages.** Requires a second confirmation in the UI |
| Trim systemd journal | Linux | `journalctl --vacuum-size=<target>` (64 MiB – 4 GiB, default 256 MiB) | Archived journals only; the active journal is preserved |

Never offered, by design: the Downloads folder, the Windows recovery image (`Windows ESD installation files`), language packs, per-user caches and recycle bins (the file engine already covers those), and DISM `/ResetBase`.

### What you lose, stated before you run it

Three of these actions remove something no later action can bring back, and the confirmation dialog names which one rather than asking a generic "are you sure":

- **Remove orphaned packages** uninstalls software.
- **Previous Windows installations** and **Discarded upgrade files** end this device's ability to roll back to its previous Windows version.
- **Time Machine local snapshots** deletes the only on-disk restore points a Mac has when its backup disk is not connected.

Selecting any of them requires a second, explicit acknowledgement.

### Estimates are approximate — and say which kind

Sizes are labelled, not just shown:

- **"up to X"** — a genuine upper bound, such as a cache directory's current size.
- **heuristic** — a figure derived indirectly and reliable only to an order of magnitude: the DISM component-store fields (which are store *overhead*, and a direct `StartComponentCleanup` frees an amount related to but not equal to them), the journal's usage-minus-target (only archived journals are vacuumed), and the installed size of the packages `autoremove` would take (unpacked footprint over-counts shared files).
- **size unknown** — the tool reported nothing the agent can read, or the handler's footprint is not confined to a directory we can measure (Windows `Temporary Files`, Time Machine snapshots). *Unknown* is never rendered as *0*: a confident zero reads as "nothing to reclaim", which is a different and possibly wrong claim.

After a run, the panel reports **measured** free-space deltas per volume, taken either side of the whole run. That figure, not the estimate, is what the run actually achieved.

### One run at a time

A device runs one OS cleanup at a time. Starting a second while one is in flight is refused with *an OS cleanup is already running on this device* — Windows Disk Cleanup is driven by a shared on-disk selection profile, so two overlapping runs would each execute whatever the other wrote last.

### Requirements

OS cleanup actions need agent **0.115.0** or later. On an older agent the panel shows an update banner and the Run button stays disabled.

Running actions requires `devices.execute` and an MFA-verified session, exactly like file cleanup, and every run is audited as `device.filesystem.system_cleanup.run` with the action ids, each action's status, and the measured bytes.
```

and add the four routes to the API Reference table (`:505`):

```md
| `POST` | `/devices/:id/filesystem/system-cleanup/list` | Queue a catalog request; returns a `commandId` | `devices.execute` |
| `GET` | `/devices/:id/filesystem/system-cleanup/list/:commandId` | Poll the catalog request | `devices.read` |
| `POST` | `/devices/:id/filesystem/system-cleanup/run` | Run selected actions; returns a `cleanupRunId`, or `409 run_in_progress` | `devices.execute` |
| `GET` | `/devices/:id/filesystem/system-cleanup/run/:cleanupRunId` | Poll the run | `devices.read` |
```

- [ ] **Step 4: Regenerate the docs index** (both pages gained headings, and the API's in-product docs search reads this file)

```bash
npx tsx scripts/build-docs-index.ts
git diff --stat apps/api/src/data/docsIndex.json
```

Expected: `apps/api/src/data/docsIndex.json` changes, with the two pages' `headings` arrays gaining the new sections.

- [ ] **Step 5: Run the docs gate** (this is CI's `docs-check` job)

```bash
cd apps/docs && pnpm exec astro check && pnpm exec astro build
```

Expected: no errors. A `<Aside>` used without its import in the frontmatter block is the usual failure — both pages already import `Aside` (`commands.mdx:9`, `filesystem-analysis.mdx:6`).

- [ ] **Step 6: Commit**

```bash
git add apps/docs/src/content/docs/agents/commands.mdx apps/docs/src/content/docs/features/filesystem-analysis.mdx apps/api/src/data/docsIndex.json
git commit -m "$(cat <<'MSG'
docs: OS-native cleanup command types and action catalog

agents/commands.mdx gains system_cleanup_list and system_cleanup_run;
features/filesystem-analysis.mdx gains the catalog, the four routes, and the
two things a reader has to understand to trust the numbers: estimates are
upper bounds and are labelled "up to", while the post-run figure is a measured
free-space delta.

W05 still owns the page's full rewrite for volumes and the finished tab; this
adds only what W04 ships, so the page is never wrong in between.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
)"
```

---

### Task 17: Wave verification and the W04 exit gate

**Files:** none created. This task runs the suites the wave touches and records the lab criteria W05 must execute before the agent release.

- [ ] **Step 1: Full agent suite with the race detector**

```bash
cd agent && CGO_ENABLED=0 go test -race ./...
```

Expected: `ok` throughout. This is the `Test Agent` job.

- [ ] **Step 2: Cross-compile vet for both non-Linux targets** (both are required CI steps and neither runs during `go test` on Linux)

```bash
cd agent && GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go vet ./...
bash scripts/check-windows-vet.sh
```

Expected: no output from the first; the script prints its baseline summary and exits 0.

- [ ] **Step 3: Go lint** (CI runs `golangci-lint` in `--new-from-rev` mode, so only this wave's lines are judged)

```bash
cd agent && golangci-lint run --new-from-rev=origin/main ./internal/syscleanup/... ./internal/maintenance/... ./internal/heartbeat/... ./internal/patching/... ./internal/privilege/...
```

Expected: no findings. `//nolint:nilerr` on `directorySize`'s walk callbacks is intentional and carries its reason inline.

- [ ] **Step 4: Every API and shared suite this wave touched**

```bash
cd packages/shared && npx vitest run src/validators/systemCleanup.test.ts
cd apps/api && npx vitest run \
  src/services/systemCleanup.test.ts \
  src/services/commandResultHandlers.systemCleanup.test.ts \
  src/services/commandCancelPropagation.systemCleanup.test.ts \
  src/services/commandCancelPropagation.test.ts \
  src/middleware/selfManagedDbContextRoutes.test.ts \
  src/services/commandOfflinePolicy.test.ts \
  src/services/commandTimeouts.test.ts \
  src/services/partnerTrust.test.ts \
  src/services/scriptCancellation.registration.test.ts \
  src/routes/devices/filesystemSystemCleanup.test.ts \
  src/routes/agents/commands.test.ts
```

Expected: all green. Note each path is listed explicitly — a directory filter with a trailing slash silently skips dotted siblings, and `src/services/commandResultHandlers` as a bare substring would pull in six unrelated files.

- [ ] **Step 5: Web suites**

```bash
cd apps/web && npx vitest run \
  src/components/devices/filesystem/SystemCleanupPanel.test.tsx \
  src/components/devices/DeviceFilesystemTab \
  src/lib/__tests__/no-silent-mutations.test.ts \
  src/lib/i18n
```

Expected: all green.

- [ ] **Step 6: Typechecks**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
pnpm --filter @breeze/shared typecheck
cd apps/web && pnpm exec astro check
```

Expected: silent.

- [ ] **Step 7: Confirm no schema drift** (W04 adds no migration and edits no Drizzle schema; this proves it)

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:check-drift
```

Expected: clean. If it reports a diff, something in this wave touched `db/schema/` — it should not have; the `kind`, `command_id` and `running` it consumes are all W02's.

- [ ] **Step 8: Verify the contracts that only fail with a live database** (required because this wave writes to `device_filesystem_cleanup_runs`; no column was added, so both should be unchanged — running them is how that claim is checked rather than assumed)

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts
cd ../.. && pnpm test-stack down   # nothing reaps this for you
```

Expected: green and unchanged. `rls-coverage.integration.test.ts` and the cascade suites need no edit — all three filesystem tables are already registered in every list (spec §4).

- [ ] **Step 9: Record the W04 exit gate on the wave's PR.** Copy the block below into the PR description under a `## W04 exit gate (executed by W05)` heading. **W04 is mergeable without it; the AGENT RELEASE is not.** These are spec §11's lab criteria verbatim, with the pass/fail wording made explicit.

```md
## W04 exit gate — lab acceptance, executed by W05 before the agent release

Recorded on the W05 sub-issue with the raw command output attached.

**Windows rig `WIN-IMDR2GAIDMV`** (agent running as the SYSTEM service, not an interactive session — the whole point of the test is session 0):

1. Scan `C:\` and a second volume, and empty that volume's recycle bin through the file engine. PASS = both volumes produce snapshots and the bin reclaim reports non-zero bytes.
2. Run `win_cleanmgr` with `Update Cleanup` selected, plus `win_dism_component_cleanup`, as the SYSTEM service.
   - (a) PASS = the runner observes the **whole cleanmgr process tree** exiting in session 0 without hanging. FAIL = the action reports `timed_out` at the 60-minute cap, or the agent process is still holding a job-object handle afterwards. This is the criterion that cannot be unit-tested (spec §7.2) and is the reason the gate exists.
   - (b) PASS = after the flagged restart, the **measured free-space delta** on `C:` is non-zero. A zero delta with a `completed` status means the measurement is being taken at the wrong moment and the action is lying about its outcome.
3. Confirm `DownloadsFolder` is not offered in the catalog on a machine that has one, and that `%SystemDrive%\Windows.old` is untouched when `Previous Installations` is not selected.
3a. **Profile hygiene (spec §13 #4).** Before the run, set `StateFlags5555 = 2` by hand on `DownloadsFolder` and on one non-Microsoft `VolumeCaches` subkey. PASS = after the run both read `0`, the Downloads folder is intact, and the third-party handler did not execute. FAIL = either still reads `2`, which means a stale flag from any source can ride along with a Breeze selection.
3b. **Single run per device.** Start a run, then start a second from another browser session. PASS = the second is refused with `409 run_in_progress` and no second `device_filesystem_cleanup_runs` row is created.
3c. **Budget.** Select `Update Cleanup` + DISM. PASS = the run row's `plan.deadlineAt` is ~160 minutes out, and the run is not marked `timed out` at 120.

**KIT rig `lab-ubuntu-src`:**

4. `linux_pkg_cache_clean` — PASS = `/var/cache/apt/archives` shrinks and the measured delta matches within the noise of concurrent writes.
5. `linux_journal_vacuum` at the default 256 MiB — PASS = `journalctl --disk-usage` afterwards is at or below the target, and the active journal still contains the current boot.
6. `linux_pkg_autoremove` — PASS = the catalog's figure equals Σ `dpkg-query -W -f='${Installed-Size}\n'` over exactly the packages `apt-get -s autoremove` listed on its `Remv` lines at the time of the check, × 1024. (Spec §13 #14: `-s` prints no "After this operation" line, so an estimate that *does* come from such a line means a parser matched something it should not have.)
6a. **Maintenance lock.** Start a `system_cleanup_run`, and while it is in flight trigger a patch install that ends in a `brew`/package cleanup. PASS = the second operation waits or reports `busy`; neither runs concurrently, and nothing reports `completed` for work it did not do.
6b. **tmutil scope** (macOS rig, with a second APFS volume carrying a local snapshot of the same timestamp). PASS = only the startup volume's snapshots are gone.

**Cross-cutting:**

7. On an agent below `0.115.0`, both routes answer `409 agent_update_required` and the panel shows the banner with the Run button disabled.
8. No test or lab step ran a cleaner the catalog does not contain, and no argv in the agent log contains a string that came from a request body.
```

- [ ] **Step 10: Commit the gate record**

```bash
git commit --allow-empty -m "$(cat <<'MSG'
chore(disk-cleanup): record the W04 exit gate for W05

W04 is mergeable on its unit and contract coverage. The AGENT RELEASE is not:
cleanmgr's behaviour under the SYSTEM account in session 0 cannot be proven by
a unit test, and neither can "the measured delta is non-zero after the flagged
restart". Both are lab criteria, listed in the PR description and executed by
W05 on WIN-IMDR2GAIDMV and lab-ubuntu-src.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
)"
```

---

## Self-review

### Spec coverage

| Spec requirement (this wave) | Task |
|---|---|
| §3 W04 row — no schema, agent release, old agents get "agent update required" | Global Constraints; 11a, 11b, 17 |
| §5.3 `POST /filesystem/system-cleanup/list` → `202 { commandId }` | 11b |
| §5.3 client poll for the catalog (see amendment 6 — W04 owns the poll route) | 11b |
| §5.3 `POST /filesystem/system-cleanup/run` → run row `kind='system'`, `status='running'`, queued command, `202 { cleanupRunId, commandId }` | 11b |
| §5.3 agent result handler mirroring `filesystem_analysis` (see amendment 5 — shared registry, both transports) | 12 |
| §5.3 run status `executed` if ≥1 succeeded else `failed`; `executedActions`; measured `bytesReclaimed`; `approvedAt` | 12 |
| §5.3 audit `device.filesystem.system_cleanup.run` with ids, per-action status, bytes | 12 |
| §5.3 run timeout; a timeout marks the run `failed` with `error: 'timed out'` — superseded by §13 #14's per-selection budget | 9 (budget fn), 10 (ceiling), 11b (stored deadline + atomic cancel) |
| §5.3 old-agent 409 via `compareAgentVersions` vs `MIN_AGENT_VERSION_SYSTEM_CLEANUP` | 11a, 11b |
| §5.3 `unknown command type:` fallback → same 409 on poll | 11a, 11b, 12 |
| §5.3 `SYSTEM_CLEANUP_ACTION_IDS` shared validator; `journalVacuumBytes` bounds | 9 (+ agent-side clamp in 4) |
| §5.3 `COMMAND_OFFLINE_POLICY_REGISTRY` | 10 |
| §5.3 `partnerTrust.ts` allowlist | 10 |
| §5.3 `CommandTypes` (amendment 1: `commandTypes.ts`) | 10 |
| §7 package `agent/internal/syscleanup/`, `Action` interface | 1 |
| §7.1 absolute binaries, no shell, `exec.CommandContext`, per-action timeouts, 16 KiB caps | 2 |
| §7.1 process-tree kill (job object / process group) | 2 |
| §7.1 `LC_ALL=C LANG=C`; `dism /English` | 2 (`cLocaleEnv`), 6 (`/English`) |
| §7.1 measured free-space delta, floored at 0 | 3 |
| §7.1 "upper bound" estimates; `estimateKnown:false` on unparsable output | 4, 5, 6 (parsers), 13/15 ("up to" copy), 16 (docs) |
| §7.2 catalogue v1 exactly as tabled, incl. Windows handler allowlist and exclusions | 6 (Windows), 5 (macOS), 4 (Linux) |
| §7.2 `StateFlags5555`; `cleanmgr.exe` absent → unavailable; exit code informational | 6 |
| §7.2 `SHLoadIndirectString` best-effort labels | 6 |
| §7.2 DISM analyze parsing; never `/ResetBase` | 6 |
| §7.2 `tmutil listlocalsnapshots` → `deletelocalsnapshots <date>` | 5 |
| §7.2 exported `patching.BrewCleanup(ctx, dryRun)`; caller keeps its swallow-and-log wrapper | 5 |
| §7.2 apt/dnf/yum detection; `apt-get -s autoremove` and `dnf --assumeno autoremove` parsers (dnf non-zero exit accepted); `journalctl --disk-usage` parser | 4 |
| §7.2 Linux `Available()` probes `/var/cache/<pm>` and `/var/log/journal` write access | 4 |
| §7 command types registered in `heartbeat/handlers.go` and `remote/tools/types.go` | 8 |
| §7.3 payload/result shapes | 1, 7 (Go), 11a (server-side Zod) |
| §7.3 actions run sequentially, in catalogue order, one failure does not stop the next | 7 |
| §7.3 estimation concurrent with a 3-minute cap | 7 |
| §8 SystemCleanupPanel: list → rows (label/"up to" estimate/risk badges/unavailable reason) → Run → destructive confirm + `removes_packages` checkbox → running with elapsed → result with measured bytes per volume | 13 |
| §8 MOUNT into the W03 `DeviceFilesystemTab` composer + a page-level test | 14 |
| §8 `409 agent_update_required` banner; Run disabled | 13 |
| §8 `runAction` for both mutations | 13, 14 (guard) |
| §8 i18n in all 8 locales | 15 |
| §10 item 7 — native actions are a closed catalog | 1, 4, 6, 7, 9 |
| §10 item 9 — audited with ids, per-item status, bytes | 12 |
| §11 Go: fixtures for every parser; no test executes a real cleaner; `isRecursiveDeleteBoundaryFor` untouched | 4, 5, 6, 7; Global Constraints |
| §11 API: 409 agent gate, system-cleanup list/run route tests | 11a, 11b |
| §11 Web: 409 renders the update banner; `no-silent-mutations` passes | 13, 14 |
| §11 docs: `agents/commands.mdx`, native-catalogue part of `filesystem-analysis.mdx` | 16 |
| §11 lab criteria as the W04 exit gate, executed by W05 | 17 |
| §13 #4 zero **every** `VolumeCaches` subkey; any write failure aborts before cleanmgr; nothing restored; HKLM trusted as admin-only | 6 |
| §13 #4/#12 process-wide `maintenance.Lock` shared by the run, DISM and Homebrew cleanup; API single-run-per-device (`409 run_in_progress`) | 2b, 5, 7, 11b, 13 |
| §13 #5 claim in a short committed transaction → dispatch outside → finalise separately; self-managed-context registration | 11b (Step 3a, 3b) |
| §13 #6 destructive cleanup commands are live-only; timing a run out cancels its command atomically | 10 (`live_only`), 11b (`failSystemCleanupRunAndCancelCommand`) |
| §13 #11 `tmutil` mount-point form for both list and delete | 5 |
| §13 #13 cancel propagation branch; a late result is recorded without flipping status | 12b, 12 |
| §13 #14 apt estimate via `dpkg-query`; DISM + journal labelled heuristic; "Recommended: No" still reports the sum; brew no-`Would remove` → 0; DO cache from policy; `Temporary Files` unknown; aggregate budget with `not_started` | 4, 5, 6, 7, 9, 10, 11b |
| §13 #15 `removes_os_rollback` / `removes_recovery_points` + confirm-dialog copy in 8 locales | 1, 5, 6, 9, 13, 15 |
| §13 narrative: Homebrew uses the bounded runner with the console-user `sudo`, `BrewCleanup` a thin wrapper | 5 |

### Quorum application (spec §13)

Every §13 finding that names W04 is applied in place, with its own amendment (18-26) recording the verified fact behind it. Two findings changed a contract the plan had already written and were rewritten rather than appended to: the fixed `SYSTEM_CLEANUP_RUN_TIMEOUT_MS` became a per-selection budget stored on the row, and `parseAptAutoremoveFreed` became `parseAptAutoremovePackages` + `dpkg-query` because the line it parsed does not exist. Three tests changed polarity and say so in their own comments: `Component Store Cleanup Recommended : No` is no longer a known zero, `capOutput` keeps the tail rather than the head, and the cleanmgr run now zeroes handlers outside the allowlist too.

### Placeholder scan

`grep -nE 'TODO|TBD|FIXME|XXX|similar to Task|handle edge cases|add validation|\.\.\.$'` over this document returns only:
- the single permitted branch placeholder `feature/<parent#>-disk-cleanup-v2/wave-<subissue#>` in the header, and the matching `tracking_issue: LanternOps/breeze#6326` frontmatter the plan contract requires;
- `catalogVersion: null` in the run row's `plan` (Task 11b) — a real value, meaning "the catalogue version is recorded on the result, not guessed at queue time";
- `... [truncated]` inside the output-cap marker string and `[===…99.0%===]` inside the DISM fixture, both literal test data.

No task cross-references another for its content; every code step carries a full code block, and code repeated across tasks (e.g. `resultFromProc` usage) is written out rather than referenced.

### Type-consistency check

- Agent → API: `ListResult` / `RunResult` JSON tags (Task 1, 7) match `systemCleanupCatalogSchema` / `systemCleanupRunResultSchema` field-for-field (Task 11a), including the optional `subActions`, `unavailableReason`, `estimateDetail`, `outputTail` and `error`. Enum values (`completed|failed|timed_out|unavailable`, `windows|darwin|linux`) match the Go constants in Task 1.
- Go ↔ shared: `ActionIDs` (Task 1) and `SYSTEM_CLEANUP_ACTION_IDS` (Task 9) are compared position-by-position by `shared_ids_test.go`, which is written in Task 1 as a skip and becomes a hard assertion in Task 9 Step 6. `SYSTEM_CLEANUP_RISK_FLAGS` matches the five Go `RiskFlag` constants.
- API → web: the four route response shapes (Task 11b) match the panel's `Catalog` / `RunProjection` types (Task 13), including `freedBytes`, `volumes[].freeBefore/freeAfter` and the `409 { error, minAgentVersion }` body the panel reads off `ActionError.body`.
- Bounds appear three times and agree: `systemCleanupParamsSchema` (64 MiB – 4 GiB, Task 9), `clampJournalVacuumBytes` (Task 4), and `journalVacuumDefaultBytes = 256 MiB` used by both `journalVacuumArgs` and `journalVacuumEstimate`.
- Timeouts nest correctly: each action's own cap (5-90 min) < the aggregate budget `RunBudget`/`systemCleanupRunBudgetMs` computes from the SAME per-action table on both sides (Tasks 7, 9) = `plan.deadlineAt` stored at claim time (Task 11b) <= `SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS` = 3 h = the reaper's ceiling for the command row (Task 10) = the panel's `RUN_POLL_TIMEOUT_MS` (Task 13). The agent sets no second flat deadline of its own (Task 8).
- Schema fields consumed from W02 and used nowhere else: `deviceFilesystemCleanupRuns.kind`, `.commandId`, and the `running` enum label. `scanPath` is read by neither task — system runs are not path-scoped (spec §4's "nullable: system runs are not path-scoped"), and the insert in Task 11b correctly omits it.
