---
tracking_issue: LanternOps/breeze#6326
---
# Disk Cleanup v2 — Plan Index

**Spec:** `docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md` (approved by Todd 2026-09-19 as written; approach A "two engines, one surface"). The amendments below were found by the five plan authors while verifying the spec against the tree and are applied by these plans. Where a plan and the spec disagree, the plan wins (spec §12).

One plan document per wave. Each wave is one PR on its own branch `feature/<parent#>-disk-cleanup-v2/wave-<sub-issue#>` with `Closes #<sub-issue#>` in the PR body. State lives on GitHub (feature-lifecycle); the wave issue is the source of truth for status, never this index. `get_feature_status` before starting any wave.

| Wave | Plan | Depends on | Agent release |
|---|---|---|---|
| W01 | [Correctness and hardening: permanent deletes for both lanes, per-volume Recycle Bin, rooted rule table shared by Go and TS, `cleanupGuard`/`contentsOnly`, accumulator caps, execution service with `rejectedPaths` + budget, AI empty-snapshot guard, web `runAction`/poll/ARIA/i18n fixes, File Manager pins `cleanupRunId`](2026-09-19-disk-cleanup-v2-w01-correctness-hardening.md) | — | yes |
| W02 | [Multi-volume: `normalizeScanPath`, two migrations (`scan_path` nullable on snapshots/state/runs + unique `(device_id, scan_path)` index, `scan_generation`, `kind`/`command_id`, `running` enum in its own file), export-policy entries, scan state keyed by `(deviceId, scanPath)`, `GET /filesystem/volumes`, `?path=` reads, root detection against volumes, disk-percent fix, `path` on the two AI tools, `useFilesystemVolumes` + `VolumePicker` mounted in the tab](2026-09-19-disk-cleanup-v2-w02-multi-volume.md) | W01 | no |
| W03 | [Tab completion: required `cleanupRunId` (route + AI tool + act pinning), `scan_path` NOT NULL + composite PK contraction migration, self-managed claim/dispatch/finalise transactions, 24 h preview expiry, run claimed in place (`previewed→running→executed/failed`, 409 on replay), run-history routes + retention job (four worker registries), tab split into `components/devices/filesystem/*`, CleanupPanel select→execute→result, run history, File Manager consolidated to a link, i18n, page-level mount test](2026-09-19-disk-cleanup-v2-w03-tab-completion.md) | W02 | no |
| W04 | [OS-native cleaners: `agent/internal/syscleanup` closed catalog (cleanmgr handlers, DISM, Time Machine snapshots, Homebrew, apt/dnf/yum, journal), `system_cleanup_list`/`system_cleanup_run` commands, `services/systemCleanup.ts`, two poll routes, shared result handler, version gate, every command-type registry, SystemCleanupPanel mounted in the tab](2026-09-19-disk-cleanup-v2-w04-native-cleaners.md) | W02, W03 | yes |
| W05 | [AI and MCP tools, docs, lab proof, release gate: `system_cleanup` tool (list Tier 1 / run Tier 3), `path` + required `cleanupRunId` on `disk_cleanup`, all tool registries + contract tests, act-mode fixes, docs parity tables, `filesystem-analysis.mdx` rewrite, lab run on the Windows and Ubuntu rigs, agent-release unblock](2026-09-19-disk-cleanup-v2-w05-ai-mcp-docs-release.md) | W04 | no (gates the release) |

W01 → W02 → W03 → W04 → W05 are serial. W01 and W04 change agent code and ship in the next agent release; W01's API half is safe against old agents (spec §3), W04's is gated on `MIN_AGENT_VERSION_SYSTEM_CLEANUP`. Advisor quorum (spec §13): an adversarial Opus pass and a Codex `gpt-6-astra` xhigh pass are both recorded. Codex agreed with the structure and the state key and raised 16 safety/rollout contracts, all adopted; the table in spec §13 maps each to its owning wave and the wave plans carry them as their final amendments (handle-based deletion via `os.OpenRoot`, live type/age/mtime checks and 24 h preview expiry, permanent mode gated on `MIN_AGENT_VERSION_CLEANUP_GUARD`, cleanmgr profile hygiene + agent-wide maintenance lock, self-managed transactions for claim/dispatch/finalise, live-only delivery TTL, expand/contract for `scan_path`, legacy checkpoint reset, `scan_generation`, WebSocket result persistence for `filesystem_analysis`, per-OS path normalisation, volume-scoped trash and snapshots, cancellation/late-result reconciliation, estimate corrections, rollback/recovery risk flags, AI/act pinning moved into W03).

## Spec amendments these plans apply

Numbered per wave; each is verified at file:line in the wave plan's own "Plan amendments" section.

### W01

1. **`go:embed` cannot reach `packages/shared/`** — the agent is its own Go module. The rule table ships twice (`packages/shared/src/utils/cleanupRules.json` and an agent copy) with byte-parity tests in both directions, replacing the spec's SHA-256 idea (`resolveJsonModule` yields a parsed object, not bytes).
2. **Pattern grammar pinned:** `*` is a within-component wildcard, `**` is one-or-more components, `{a,b}` is expanded before splitting, first match wins, exclude-then-continue (which is what makes the spec's "→ package_cache" annotations work).
3. Denied roots are stored bare and matched equal-or-descendant (`/private/var/db` is depth 3, below the boundary guard's reach).
4. `contentsOnly` is derived from the matched rule's `granularity`; no new candidate field, so pre-W01 snapshots still execute.
5. `rejected` cannot ride `CommandResult.status`; the agent uses a pinned error prefix `cleanup guard rejected:`; a locked file returns success with `deleted: false` (result bodies exist only on the success envelope).
6. `executedActions` becomes `{ partial, budgetMs, actions }` (no existing reader; a tolerant reader handles pre-W01 rows).
7. Spec line numbers corrected (`fileops.go:641`, `filesystem_analysis.go:425`) plus a second hardcoded `Safe: true` at `:591` the spec missed.
8. **Defect 1 has two call sites.** The AI lane's `disk_cleanup` execute is routed through the same `runCleanupExecution` in W01 (Task 11b); only the execution path is unified, the tool schema waits for W05.

### W02

1. `normalizeScanPath` is written with zero imports: `packages/shared/src/utils/index.ts` is bundled by `apps/web` and `browserSafeBarrel.test.ts` rejects `node:path`.
2. The devices column is `devices.os_type`, not `devices.os`.
3. The backfill normalises `raw_payload->>'path'` (a verbatim copy would hide every historical snapshot from a normalised read); a dot-segment path is stored verbatim as inert history rather than re-keyed to the OS root.
4. `db:check-drift` does not compare the Drizzle mirror to the database, so the composite PK / index / CHECK shape is proved by a new live replay integration suite.
5. The agent result handler has no OS in scope (`AgentAuthContext` carries none); one indexed `devices.os_type` lookup is added and the handler bails rather than guessing POSIX.
6. Cascade lists verified unchanged with the greps recorded; the export policy is the only list that fires (five new columns, all `included`), and a unit test is added so that failure lands in Test API rather than only Integration Tests.
7. Migration names re-checked against `origin/main` on 2026-09-19 12:10 MDT: two `2026-10-20-150000-*` files landed on main this morning, so the spec's `150000`/`150100` were bumped to `170000`/`170100` (W03's contraction migration is `170200`). Re-check at commit time.
8. `listFilesystemVolumes` issues two bounded queries per volume (max 24) rather than one `DISTINCT ON`, for mockability; swappable later.

### W03

1. The retention job uses `upsertJobScheduler` (shape from `fleetRemediationDispatch.ts`) with `changeLogRetention.ts`'s batching body; `warrantyWorker.ts` uses the legacy `queue.add(..., { repeat })` API and is not a retention sweeper.
2. The stored candidates path is `plan.preview.candidates`, not `plan.candidates`.
3. **Run lifecycle (design call, folded back into spec §5.2):** execute claims the pinned run in place (`UPDATE … WHERE status='previewed'` → `running`) and finalises the same row; a second execute on the same run returns 409; retention ages a `kind='files'` run stuck in `running` for 24 h to `failed`.
4. A new BullMQ worker trips four registries the spec never names: `scheduleRegistry` (slot `3 22 * * *`), `RETENTION_JOB_NAMES`, `WORKER_REGISTRY` (order-pinned, counts 142→143), `WORKER_READINESS_MANIFEST` (+ `attachWorkerObservability`).
5. File Manager is in neither `runActionAllowlist.ts` list; `DeviceFilesystemTab.tsx` is in `RUN_ACTION_MIGRATION_BACKLOG` and moves to `TARGET_GLOBS` together with `CleanupPanel.tsx`.
6. The existing route test that posts without `cleanupRunId` (`filesystem.test.ts:216`) is rewritten, not deleted.

### W04

1. **The spec's poll design does not work.** `buildStoredCommandResult` drops the agent's structured `result` and `sanitizeCommandResultForHistory` redacts `stdout` for every type but `capture_pprof`, so `GET /devices/:id/commands/:id` would return the catalog as `[REDACTED]` and always 200. W04 adds two W04-owned poll routes; `RAW_STDOUT_COMMAND_TYPES` is deliberately not widened (it also disables secret redaction at ingest).
2. **The result handler goes in the shared `services/commandResultHandlers` registry, not `agents/helpers.ts`** — the WebSocket leg dispatches only the registry; mirroring `handleFilesystemAnalysisCommandResult` literally would leave socket-delivered runs stuck `running` for 2 h.
3. `compareAgentVersions` returns 0 on unparseable input, so a `>= 0` gate would let `''` through; the gate fails closed and compares the core version only (lab `-rc` builds pass).
4. `procoutput.ApplyEnv` is a no-op when a UTF-8 locale is already set; `syscleanup` uses its own overriding `cLocaleEnv` (`LC_ALL=C LANG=C`).
5. Registries the spec never names: `services/commandTimeouts.ts` (unregistered → 30 min default would reap a 90-min DISM run), `agent/internal/heartbeat/handlers_test.go` `allCommandTypes`, `agent/internal/privilege/check.go`. `CommandTypes` lives in `commandTypes.ts`; `COMMAND_OFFLINE_POLICY_REGISTRY` has no "long" class, so both types go in `STANDARD_REVIEWED`.
6. cleanmgr sub-actions carry their own ids (`win_cleanmgr:<slug>`) or the closed-catalog rule leaks; `SYSTEM_CLEANUP_ACTION_IDS` has 27 entries (7 + 20).
7. `MIN_AGENT_VERSION_SYSTEM_CLEANUP = '0.115.0'` (newest tag v0.114.0 on 2026-09-19; bump if a release lands first).
8. `partnerTrust.test.ts` parses the Go handler files, so landing the Go constants turns an API suite red across the language boundary until the allowlist entry lands in the same PR.

### W05

1. §9.2 corrected: `deviceArgs` is an array and omitting it fails **open** (folded back into spec §9.2).
2. The API rate table is the module-private `TOOL_RATE_LIMITS`; `RATE_LIMIT_CONFIGS` is the web mirror. "Both tables" means `TIER3_ACTIONS` + `TIER3_SUPERVISED_ACTIONS`; the test that goes red is `aiGuardrails.approvalScope.contract.test.ts`.
3. `services/systemCleanup.ts` sits outside `aiDispatch.contract.test.ts`'s AI-file scan; the plan threads `aiOrigin` so an AI-decided run cannot reach a device unattributed.
4. **Act mode is broken by the required `cleanupRunId`:** `pinDiskCleanup` re-reads "newest previewed run" and playbook variables resolve once before the loop, so the built-in playbook's execute step could never see its own preview's id. Both are fixed.
5. `aiToolLabel('system_cleanup', …, { action: 'list' })` and `disk_cleanup preview` both rendered "Checked cleanup"; one caption per tool, mirrored on mobile.
6. §9.3 items 8 and 11 were no-ops as written; the plan states the real work for each.
7. `mcp-server.mdx` still describes the pre-2026-08-02 model where Tier 3 executed on `ai:execute`; the tool table is corrected here, the production-allowlist prose is flagged as a follow-up.

## Contracts defined across waves (names later waves consume)

- W01: `runCleanupExecution` in `apps/api/src/services/filesystemCleanupExecution.ts`; per-path status `completed | failed | skipped_locked | rejected | skipped_budget`; rule JSON `packages/shared/src/utils/cleanupRules.json`; `file_delete` flags `permanent`, `cleanupGuard`, `contentsOnly`; result fields `bytesFreed`, `skippedLocked`.
- W02: `normalizeScanPath(osType, path)` in `packages/shared/src/utils/scanPath.ts`; `GET /devices/:id/filesystem/volumes`; `useFilesystemVolumes(deviceId)`; `VolumePicker`; `scanPath` on preview/execute; columns `scan_path`, `kind`, `command_id`; enum value `running`.
- W03: `apps/web/src/components/devices/filesystem/*` panels and hooks; `DeviceFilesystemTab` composer; `GET /devices/:id/filesystem/cleanup-runs[/:runId]`; run-claim lifecycle; retention job `filesystem-cleanup-run-retention`.
- W04: `agent/internal/syscleanup`; commands `system_cleanup_list`, `system_cleanup_run`; `services/systemCleanup.ts`; `SYSTEM_CLEANUP_ACTION_IDS`; `MIN_AGENT_VERSION_SYSTEM_CLEANUP`; two poll routes under `/devices/:id/filesystem/system-cleanup/`.
- W05: AI tool `system_cleanup`; `disk_cleanup`/`analyze_disk_usage` `path`; docs parity.

The cross-plan consistency pass (2026-09-19) aligned every Consumes block to the producing wave's names; its findings are recorded as the last amendment in each affected plan.
