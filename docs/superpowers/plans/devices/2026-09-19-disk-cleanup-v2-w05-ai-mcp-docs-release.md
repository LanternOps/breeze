---
tracking_issue: LanternOps/breeze#6326
---
# Disk Cleanup v2 W05: AI and MCP Tools, Docs, Lab Proof, Release Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the AI surfaces the same disk-cleanup contract the routes and the UI already have — a new Tier-1/Tier-3 `system_cleanup` tool, a path-aware `analyze_disk_usage`, a `cleanupRunId`-pinned `disk_cleanup execute` — register it in every one of the fourteen places a tool has to be registered, rewrite the five documentation pages that describe it, prove the W04 native cleaners on two real lab rigs, and leave the agent release *unblocked*.

**Architecture:** One tool registry feeds three surfaces. `services/aiTools.ts` is the core registry; the in-app chat, the headless AI agents, and the Breeze MCP server (`routes/mcpServer.ts`, which derives `tools/list` from `getToolDefinitions()` and tiers from `getToolTier` + `TIER3_ACTIONS`) all read it, and a second SDK-side registry (`aiAgentSdkTools.ts`: `TOOL_TIERS` + one `tool(...)` declaration per tool) mirrors it under contract test. W05 adds exactly one new tool name, `system_cleanup`, whose thin handler lives in `aiToolsFilesystem.ts` and whose body reuses the W04 route service functions in `services/systemCleanup.ts` — there is no second implementation of list/run, and the AI lane threads `aiOrigin` through that service so device work stays attributable. Nothing in this wave touches the database schema, the Go agent, or a migration.

**Tech Stack:** TypeScript (Hono API, Vitest), React + Vitest/jsdom (web), Vitest (`packages/shared`, `apps/mobile`), Astro/Starlight MDX (`apps/docs`), `tsx` for the docs-index generator. No migration, no Drizzle schema change, no Go.

**Spec:** `docs/superpowers/specs/2026-09-19-disk-cleanup-v2-design.md` — §3 row W05, §9 in full (9.1 tool changes, 9.2 MCP behaviour, 9.3 the fourteen-item registration checklist), §11 the Lab bullet and the Docs bullet, §10 items 7–9 (the safety properties the AI lane must preserve).

**Branch:** `feature/<parent#>-disk-cleanup-v2/wave-<subissue#>`

---

## Global Constraints

- **No schema, no migration, no Go.** W05 adds no table, no column, no `apps/api/migrations/*.sql` file and no `agent/**` change. Task 15 Step 4 proves it with `git diff --stat`. The migration-naming rule, the `SELECT set_config('breeze.scope','system',true)` rule and `pnpm db:check-drift` are therefore **not** exercised by this wave; they belong to W02.
- **`go test -race ./...` is not run by this wave** — no Go source changes. The Go suites that gate the agent release were already run by W01 and W04; Task 14 re-verifies their *behaviour* on real hardware instead.
- **Test files live alongside source** — `services/aiToolsFilesystem.ts` → `services/aiToolsFilesystem.systemCleanup.test.ts`, never a separate `__tests__` directory.
- **Test command form:** `cd apps/api && npx vitest run <path>` / `cd apps/web && npx vitest run <path>` / `cd packages/shared && npx vitest run <path>` / `cd apps/mobile && npx vitest run <path>`. **Never** `pnpm --filter <pkg> test -- --run <path>` — pnpm forwards the literal `--` and vitest swallows `--run`, which runs the whole suite in watch mode (CLAUDE.md "Two traps").
- **Vitest path filters are plain substrings, not globs and not directory prefixes.** List sibling files explicitly and check the reported file count.
- **Typecheck command (what CI runs, from the repo root):** `pnpm exec tsc --noEmit --project apps/api/tsconfig.json`. `apps/api/tsconfig.json` has `"include": ["src/**/*"]`, so test files are type-checked too.
- **Web mutations go through `runAction`** — W05 adds no web mutation handler (the Disk Cleanup tab is W03/W04); the only web files it touches are the dependency-free data module `components/ai-risk/tierConfig.ts`, the `TIER3_TOOLS` label set in `ApprovalHistoryFeed.tsx`, and the eight locale catalogs.
- **i18n in all 8 locales.** Three new keys land in `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/settings.json` with **real translations** — `translationCoverage.test.ts` caps exact-English duplicates per namespace and an untranslated key eats that headroom.
- **File-size guideline (soft, 500 lines).** `aiToolsFilesystem.ts` is 376 lines today. The `system_cleanup` handler is kept THIN (registration + access check + delegation) and its body lives in `services/systemCleanup.ts`, so the file lands around 500 rather than 620.
- **Every registry this wave touches gets its own step naming the exact file, the exact line, and the exact contract test that goes red.** The cascade-registration history in this repo is contract tests 5/5, code review 0/5; the AI-tool registration history (#2605, #2814, #3300) is identical.
- **Rigor:** medium. Red first on every task, typecheck, the affected suites, then the full `apps/api` unit suite before the PR. W05 adds no tenant-scoped table and no DB context change, so no RLS or integration contract suite is required — but Task 15 runs `rls-coverage` and `tenantCascade` anyway because the wave sits inside a feature that does touch them.
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. PR body contains `Closes #<subissue#>`. `get_feature_status` before starting, `start_wave` on the sub-issue.

**Why this task order.** Tasks 1–7 build `system_cleanup` from the inside out: the service seam first (so the tool has something to call), then the registration checklist in dependency order — a tool with a definition but no `TOOL_TIERS` entry fails `aiAgentSdkTools.registryParity.contract.test.ts`, and a tool in `TOOL_TIERS` with no `tool()` declaration fails `aiAgentSdkTools.mcpCoverage.test.ts`, so both land in the same task rather than leaving one red. Tasks 8–10 finish the mirrors (web, shared/mobile, the MCP surface). Tasks 11–13 are documentation and release notes, which are only writable once the tier tables are final — `aiGuardrailsAiDocs.parity.test.ts` compares the published page against the live guardrail tables, so a docs edit before Task 4 would be red by construction. Task 14 is the lab gate for W04. Task 15 closes the wave and states what "the agent release is unblocked" means. The `disk_cleanup` act/AI pinning tasks that used to sit between Task 7 and the mirrors are gone — see amendment B8.

---

## Plan amendments

Every claim this wave depends on, verified against the worktree on 2026-09-19 (`main` at `e4525ea7e8`, branch `spec/disk-cleanup-v2`). Where the spec is wrong or under-specified, the plan records the verified fact and what it does instead.

### A. What W01–W04 are assumed to have merged (Consumes)

W05 is not independent (spec §3: "release wave"). It consumes, by exact name:

| Name | Where W04/W02/W03 puts it | W05 uses it in |
|---|---|---|
| `SYSTEM_CLEANUP_ACTION_IDS` | `packages/shared/src/validators/systemCleanup.ts` | Task 3 (Zod enum), Task 5 (SDK shape) |
| `MIN_AGENT_VERSION_SYSTEM_CLEANUP` (value `'0.115.0'`) | `apps/api/src/services/systemCleanup.ts` | Task 1, Task 2 (409 shape) |
| `SYSTEM_CLEANUP_RUN_TIMEOUT_MS` (2 h) | **`apps/api/src/services/commandTimeouts.ts`** (not `systemCleanup.ts` — see amendment A2) | Task 1, Task 6 (`toolTimeouts.ts`) |
| `systemCleanupAgentGate(device)` | `apps/api/src/services/systemCleanup.ts` | Task 1, Task 2 |
| `queueSystemCleanupList(args)` | `apps/api/src/services/systemCleanup.ts` | Task 1, Task 2 |
| `startSystemCleanupRun(args)` | `apps/api/src/services/systemCleanup.ts` | Task 1, Task 2 |
| command types `system_cleanup_list`, `system_cleanup_run` | `services/commandQueue.ts` `CommandTypes`, `services/commandOfflinePolicy.ts`, `services/partnerTrust.ts`, agent `heartbeat/handlers.go` | Task 1 (dispatch), Task 14 (lab) |
| routes `POST /devices/:id/filesystem/system-cleanup/{list,run}` (+ the two W04-owned poll routes) | `apps/api/src/routes/devices/filesystemSystemCleanup.ts` (a sibling module, **not** `filesystem.ts` — W04 File Structure) | Tasks 11/12 (docs), Task 14 (lab) |
| `normalizeScanPath(osType, path)` | `packages/shared/src/utils/scanPath.ts` (W02) | Task 12 (docs only) |
| `getLatestFilesystemCleanupSnapshot(deviceId, scanPath)` | `apps/api/src/services/filesystemAnalysis.ts` (W02 adds the second parameter) | Task 12 (docs only) |
| route `POST /filesystem/cleanup-execute` requires `cleanupRunId` | `apps/api/src/routes/devices/filesystem.ts` (W03) | Tasks 11/12 (docs), Task 14 (lab) |
| AI tool `disk_cleanup` requires `cleanupRunId` on `execute` and carries it from its own `preview`; `path` + `cleanupRunId` added to `aiToolsFilesystem.ts`'s definition, `toolInputSchemas.disk_cleanup` and the SDK `tool()` shape | `apps/api/src/services/aiToolsFilesystem.ts`, `aiToolSchemas.ts`, `aiAgentSdkTools.ts` (**W03** — amendment B8) | Task 10 (asserted), Tasks 11/12 (documented) |
| `ActTarget` variant `{ kind: 'disk_cleanup'; cleanupRunId: string; paths: string[] }`; `pinDiskCleanup` reads the run BY ID; `actTargetSummary` unchanged | `apps/api/src/services/aiAgents/actManifest.ts`, `actRevalidation.ts`, `actVerify.ts` (**W03**) | — (W05 asserts nothing here) |
| built-in `Disk Cleanup` playbook passes `cleanupRunId`; `playbookActExecutor.ts` variable-ordering fix | `apps/api/src/services/builtInPlaybooks.ts`, `aiAgents/playbookActExecutor.ts` (**W03**) | Task 11 (`playbooks.mdx` only) |

**Amendment A1 — the four service functions are W04 deliverables, and W05 only extends them (resolved 2026-09-19).** `systemCleanupAgentGate`, `queueSystemCleanupList` and `startSystemCleanupRun` ship from `apps/api/src/services/systemCleanup.ts` in **W04 Task 11b Step 3a** (W04 amendment 17): its two route handlers call them and no longer import `CommandTypes`/`queueCommandForExecution` at all. The earlier conditional "W05 extracts them if W04 inlined them" is **withdrawn** — Task 1 performs no extraction and adds no route edit. Task 1 does exactly two things: it threads an optional `aiOrigin` through both argument types into `queueCommandForExecution`, and it adds `awaitSystemCleanupResult`. If the three exports are missing when you get here, W04 has not merged — stop and rebase; do not re-create them, because a second copy of the agent-version gate and the `device_filesystem_cleanup_runs` insert is exactly the two-call-site drift W01 spent a task deleting on the file engine. **Type-name reservation:** W04 already exports `SystemCleanupRunResult` from this module (its Zod-parsed *agent payload*, Task 11a), so the queue/start discriminated union is named `SystemCleanupStartResult`.

**Amendment A3 — cross-wave alignment pass (2026-09-19): four seams corrected against the producing waves.** The five plans were authored in parallel from one spec; where this plan's assumption disagreed with an earlier wave's actual output, the earlier wave wins and this plan was edited. (1) **The W04 service seam is not conditional** — see A1 as rewritten. (2) **`SystemCleanupRunResult` was already taken** by W04 Task 11a (the parsed agent payload) in the same module, so Task 1's queue/start union is `SystemCleanupStartResult`. (3) **`disk_cleanup execute` keeps W01's shared execution path** — W01 Task 11b already routed the AI lane through `runCleanupExecution` with `CLEANUP_EXECUTE_BUDGET_MS`, the rule re-filter, the rule-derived `contentsOnly` and the five-token status vocabulary, and persists the `{ partial, budgetMs, actions }` envelope (W01 amendment 8). Task 8 originally re-wrote that loop by hand, which would have silently re-opened defect 1 on the AI lane; it now swaps only the *candidate source* (the pinned run's stored plan) and keeps W01's response fields, adding `scanPath`. (4) **`agents/commands.mdx` belongs to W04 Task 16**, which documents both command types in full; Task 14 Step 4 now verifies rather than re-authors. Also corrected: the system-cleanup routes live in `routes/devices/filesystemSystemCleanup.ts`, not `filesystem.ts`, and the panel polls W04's own two routes, not `GET /devices/:id/commands/:commandId`.

**Amendment A2 — cross-checked against the W04 plan (`docs/superpowers/plans/devices/2026-09-19-disk-cleanup-v2-w04-native-cleaners.md`, 2026-09-19).** Three of the names in the table above resolve differently from the spec's wording, and one resolves better:

- `SYSTEM_CLEANUP_RUN_TIMEOUT_MS` is exported from **`apps/api/src/services/commandTimeouts.ts`**, not from the system-cleanup module. W04 puts it there deliberately: `getCommandTimeoutMs` falls through to a 30-minute default for an unregistered type, and the stale-command reaper (`jobs/staleCommandReaper.ts`) uses that value — so a 90-minute DISM run would be terminalised at 30 minutes while the agent was still working. Exporting the constant from the same module the reaper reads is what stops the route's timeout and the reaper's clock drifting apart. Task 1 and Task 6 import it from there.
- `MIN_AGENT_VERSION_SYSTEM_CLEANUP` is `'0.115.0'` (W04 amendment 11: the newest tag on this checkout is `v0.114.0`, so W04 ships in the next minor). Task 16 Step 2 still greps for the literal rather than hard-coding it, because W04's own plan says to bump it if a release lands first.
- `SYSTEM_CLEANUP_ACTION_IDS` is a **27-entry `as const` tuple** — 7 top-level ids plus 20 `win_cleanmgr:<slug>` sub-ids, because cleanmgr's registry key names are never accepted from a client (W04 amendment 12). That means `z.enum(SYSTEM_CLEANUP_ACTION_IDS)` type-checks with no cast, and a bare `win_cleanmgr` id means "every allowlisted handler present on this device". Tasks 3 and 5 use it directly.
- W04 ships `packages/shared/src/validators/systemCleanup.ts`'s `systemCleanupRunBodySchema` for the route body. W05 does **not** reuse it for `toolInputSchemas.system_cleanup`: the tool's schema has to carry `deviceId` and `action` as well (the route takes the device from the path and the action from the URL), and it must stay a plain `z.object` for `toolActionEnum` (amendment B10). The two overlap on `actionIds`/`params` only, and both derive their bounds from the same shared constants, so there is no second source of truth for what a valid action id is.

### B. Verified corrections to §9

**Amendment B1 — `deviceArgs` is an ARRAY, and omitting it fails OPEN, not with `-32602`.** Spec §9.2 says "`system_cleanup` declares `deviceArgs: 'deviceId'` or MCP calls fail with `-32602`". Verified: the field is `deviceArgs?: readonly string[]` (`apps/api/src/services/aiTools.ts:140`), so the declaration is `deviceArgs: ['deviceId']`. And `collectSuppliedDeviceIds` (`apps/api/src/routes/mcpExecutionOrg.ts:114-131`) returns `[]` for a tool with **no** `deviceArgs`, which makes `resolveMcpExecutionContext` fall through to `resolveMcpExecutionOrgId` — `auth.orgId` or `accessibleOrgIds[0]`. So a missing declaration does not error: it silently attributes the ledger and the audit row to the *caller's* first accessible org rather than the device's own org. `-32602` is only returned when `McpExecutionOrgError` is thrown (mixed-org array, malformed id, inaccessible device). The consequence of forgetting the declaration is therefore a cross-tenant **misattribution**, which is worse than an error and is exactly why `aiTools.deviceArgsCoverage.contract.test.ts` exists. Task 2 declares it and Task 10 pins it.

**Amendment B2 — the API rate-limit table is `TOOL_RATE_LIMITS`, not `RATE_LIMIT_CONFIGS`.** Spec §9.3 item 4 names `RATE_LIMIT_CONFIGS` as an `aiGuardrails.ts` table. Verified: `aiGuardrails.ts:1527` declares `const TOOL_RATE_LIMITS: Record<string, { limit: number; windowSeconds: number }>` — module-private, read only by `checkToolRateLimit` at `:2521`. `RATE_LIMIT_CONFIGS` is the **web** mirror, `apps/web/src/components/ai-risk/tierConfig.ts:299`, and is item 12's concern. Task 4 edits `TOOL_RATE_LIMITS`; Task 8 edits `RATE_LIMIT_CONFIGS`.

**Amendment B3 — "both guardrail tables" means `TIER3_ACTIONS` + `TIER3_SUPERVISED_ACTIONS`, and the test that goes red is `aiGuardrails.approvalScope.contract.test.ts`.** Spec §9.3 item 4 names `aiToolPermissionsCatalogParity.contract.test.ts` and `aiGuardrails.agentPrincipal.contract.test.ts`. Verified: neither of those checks scope classification. `aiGuardrails.approvalScope.contract.test.ts:63-75` asserts "every per-action tier-3 pair is in exactly one scope table" — a `TIER3_ACTIONS.system_cleanup = ['run']` with no matching `TIER3_SUPERVISED_ACTIONS` (or `TIER3_FOUR_EYES_ACTIONS`) entry fails there, and only there. `aiToolPermissionsCatalogParity` checks that every `{resource, action}` pair exists in `PERMISSION_GRANTS` (both `devices:read` and `devices:execute` already do). Task 4 runs all three.

**Amendment B4 — `system_cleanup` does NOT need a whole-tool scope-set entry.** `aiGuardrails.approvalScope.contract.test.ts:118-158` enumerates every action of tools that are members of `TIER3_SUPERVISED_TOOLS`/`TIER3_FOUR_EYES_TOOLS`, and pins that enumerated list to exactly `['manage_ai_agents', 'manage_services', 'manage_startup_items', 's1_threat_action', 'security_scan']`. Those sets admit only base-tier-3 tools (`for (const tool of TIER3_SUPERVISED_TOOLS) expect(getToolTier(tool)).toBe(3)`). `system_cleanup` is base tier 1, so adding it to either whole-tool set would fail that assertion. Per-action classification only.

**Amendment B5 — the Tier-3 MCP deny is real, and it sits after `checkGuardrails` but before scope/RBAC/rate-limit/ledger/execution.** Spec §9.2's claim verified at `apps/api/src/routes/mcpServer.ts:1312-1320`: `isMcpApprovalRequired(toolName, Math.max(baseTier, guardrailCheck.tier))` returns `MCP_APPROVAL_REQUIRED` before the `hasExecute` scope gates (`:1327-1338`), the production allowlist (`:1341`), `checkToolPermission` (`:1346`), `checkToolRateLimit` (`:1356`), `resolveMcpExecutionContext` (`:1382`) and the ledger. The one ordering nuance the spec omits: `checkGuardrails` itself runs *first* (`:1284`) and its `!allowed` branch returns a plain tool error, so the deny is "before scope checks, RBAC, ledger or execution" but not before guardrails.

**Amendment B6 — both tools stay listed, and the appended sentence is exact.** `isToolWhollyGatedOverMcp` (`mcpServer.ts:1014-1032`) suppresses a tool only when its base tier is ≥3 or when *every* value of its `action` enum is in `TIER3_ACTIONS`. `disk_cleanup` (enum `['preview','execute']`, `TIER3_ACTIONS = ['execute']`) and `system_cleanup` (enum `['list','run']`, `TIER3_ACTIONS = ['run']`) are both mixed multiplexers and both stay listed. `analyze_disk_usage` has no `action` enum at all, so `gatedActionsForTool` returns `[]` and its description is unchanged. The note `tools/list` appends (`mcpServer.ts:1163-1166`) is literally:
`(Actions "run" require interactive approval and are not available over MCP — use the Breeze web app AI assistant for those.)`
— not the spec's paraphrase "Actions "execute"/"run" require interactive approval". Task 11 quotes the real string in `mcp-server.mdx`.

**Amendment B7 — `MCP_TOOL_COUNT_APPROX` has headroom but is not unconditional.** `mcpGuidance.ts:8` hard-codes `200`; `mcpGuidancePromptTools.test.ts:63` asserts `Math.abs(registered.size - 200) <= 10`, i.e. the live registry must stay in `[190, 210]`. A static count of distinct tool-name literals under `services/aiTools*.ts` + `services/workspace/` gives 188 today, so the live figure (which also includes the session-aware M365/Google tables) is near the top of that band. Task 2 Step 6 runs the test; **if it reports a count of 211, bump `MCP_TOOL_COUNT_APPROX` from `200` to `210`** (the test's own instruction: "bump to the nearest ten"). That is the only edit permitted to `mcpGuidance.ts` in this wave — §9.2's "no prompt changes" is otherwise correct: verified, none of the five `MCP_PROMPTS` (fleet-triage, device-investigate, patch-remediate, incident-kickoff, turnkey-setup) mentions disk cleanup.

**Amendment B8 — SCOPE CHANGE: every `disk_cleanup` act/AI pinning task moves to W03 (Codex quorum, spec §13 table row 16).** The spec puts §9.1's `disk_cleanup` changes in W05, and the previous revision of this plan implemented them here as Tasks 8, 9 and 10. The quorum moved them to W03 so that the route requirement and every consumer of it land in one reviewable change — which is the right call: the AI tool, the act manifest and the built-in playbook are all *consumers* of "execute is pinned to a previewed run", and splitting a contract from its consumers across two waves leaves the act path briefly unable to run the one built-in playbook that most needs it. **Deleted from W05:** the `disk_cleanup` definition/Zod/SDK-shape change (`path` + required `cleanupRunId`, the pinned-plan re-filter, `rejectedPaths`, the 200-path cap, the execute-budget cut-off and the AI-lane execute audit); the `ActTarget` + `pinDiskCleanup` + `actVerify` fixes; the `builtInPlaybooks.ts` step change and the `playbookActExecutor.ts` variable-ordering fix. All are now Consumes (table above). **No `path` finalisation remains for W05 either** — `analyze_disk_usage` already carries `path` today (`aiToolsFilesystem.ts:139`, `aiToolSchemas.ts:988`, `aiAgentSdkTools.ts:1748`); W02 owns its normalisation and path-keyed snapshot read, W03 owns `disk_cleanup`'s copy. W05 therefore touches `aiToolsFilesystem.ts` only to ADD the `system_cleanup` registration, and touches `aiToolSchemas.ts`/`aiAgentSdkTools.ts` only to add that tool's schema and declaration.

Four facts verified while the work was still in scope, recorded so W03 does not re-derive them and so this plan's docs tasks describe the real end state: (a) `safePath` blocks `C:\Users\*\AppData` (`aiToolSchemas.ts:44`), which volume roots never hit but a deep `path` would; (b) `aiToolsFilesystem.diskCleanupRequestedBy.test.ts`'s `vi.mock('./filesystemAnalysis', …)` factory (`:53-65`) exports exactly six names and must gain `readPlanPreviewCandidates` when W03's handler imports it, or the suite dies with `No "readPlanPreviewCandidates" export is defined on the mock`; (c) `pinDiskCleanup` (`actRevalidation.ts:137-173`) reads "the newest `previewed` run for this device+org", and `resolvePlaybookSteps` (`playbookActExecutor.ts:352-368`) substitutes every `{{token}}` once BEFORE the step loop — so the built-in playbook's execute step cannot see the id its own preview step returns; (d) §2 defect 5 (the AI lane storing an empty snapshot on unparseable stdout, `aiToolsFilesystem.ts:185-186`, versus the guarded agent lane at `routes/agents/helpers.ts:1608-1615`) is W01's, and no W05 task touches that handler.

**Amendment B9 — `disk_cleanup`'s Zod schema is a `ZodEffects`, so `system_cleanup`'s must not be.** `toolInputSchemas.disk_cleanup` ends in `.refine(...)` (`aiToolSchemas.ts:1004-1007`), which produces a `ZodEffects` with no `.shape`. `toolActionEnum` (`services/aiToolActions.ts:52-54`) reads `toolInputSchemas[tool].shape[key].options` and silently contributes nothing for such a tool — it survives today only because the Anthropic `input_schema` enum is the other half of the union. Task 3 keeps `system_cleanup`'s schema a plain `z.object` (action-id membership is expressed as `z.enum(SYSTEM_CLEANUP_ACTION_IDS)`, and "actionIds required for run" is enforced in the handler exactly as `disk_cleanup`'s handler already enforces "paths required for execute" at `aiToolsFilesystem.ts:310-312`), so both enum sources stay live.

**Amendment B10 — no `ActOperation` for `system_cleanup` needs no derivation change.** Spec §9.3 item 8 says "the contract test's `unreachableTools`/`actEligible` derivation is updated accordingly". Verified: `actEligible` is derived from `ACT_MANIFEST` membership (`agentToolCatalog.contract.test.ts:106-127`), so a tool with no manifest entry is `actEligible: false` for free; and `listUnreachableRegisteredTools()` (snapshotted at `agentToolCatalog.contract.test.ts:54`) lists registered tools that are *not* reachable — `system_cleanup` becomes reachable the moment it has a `TOOL_TIERS` entry, so it never enters that snapshot and the `.snap` file needs no regeneration. Task 7 adds positive assertions instead of "updating a derivation".

**Amendment B11 — the AI lane must carry `aiOrigin` into the W04 service.** Spec §9 does not mention it. Verified: `services/aiDispatch.ts` is the only door AI code may use to reach a device, and `aiDispatch.contract.test.ts:73` restricts its `AI_FILE` scan to `^apps/api/src/services/(aiTools[^/]*\.ts|aiAgents/.*\.ts)$`. `services/systemCleanup.ts` is outside that regex, so it can call `queueCommandForExecution` directly **without tripping any test** — which would put an AI-decided `system_cleanup run` on a device with no origin, the exact attribution hole #5022 W01 closed. Task 1 adds an optional `aiOrigin?: AiOriginRef` to both service functions and forwards it; Task 2's handler passes `requireAiOrigin(auth, 'system_cleanup')`, which throws when absent.

**Amendment B12 — the `dev-*` agent version passes the 409 gate, which is what makes the lab run possible.** `parseComparableVersion` (`agentEditionCompat.ts:26-46`) returns `null` for `dev-1789…` (core token `dev` is not digits), and `compareAgentVersions` returns `0` for an unparseable side (`:48-52`). So `compareAgentVersions(device.agentVersion, MIN_AGENT_VERSION_SYSTEM_CLEANUP) < 0` is false and a `make dev-push` build is **not** blocked by the W04 gate. This is consistent with every other version gate in the repo (they all fail open on an unparseable version) and is recorded here as a verified fact, not a defect: Task 14 depends on it.

**Amendment B13 — `aiToolLabel('system_cleanup', …, { action: 'list' })` renders "Checked cleanup", colliding with `disk_cleanup preview`.** Spec §9.3 item 14 says the label "derives to a sensible label". Verified against `packages/shared/src/utils/aiToolLabels.ts:129-145`: a read-only `action` forces `VERB_FORMS.get` regardless of the tool's own leading verb, and the subject is `words.slice(1)` — so `system_cleanup` + `list` → "Checked cleanup" and `disk_cleanup` + `preview` → "Checked cleanup" as well. Two different tools rendering an identical chat caption is a real defect, not a cosmetic one. Task 9 makes the one-line fix (fall back to `titleCaseToolName` when the read-only override applies to a tool whose own leading verb is unmapped), which yields "System cleanup" and "Disk cleanup" and changes nothing for the mapped-verb tools the existing tests pin. The `apps/mobile` mirror (`screens/chat/components/toolIndicatorLogic.ts:232-234`) gets the same edit.

**Amendment B14 — `mcp-server.mdx` carries pre-2026-08-02 text about Tier 3 over MCP.** Lines 368-369 ("Tier 3+ tools are included if the key has `ai:execute`" / the `ai:execute_admin` sentence) and the "Production allowlist for destructive tools" section (:479-491) describe the model that the hard deny replaced: a wholly-Tier-3 tool is no longer listed at all, and a Tier-3 *action* is denied before the scope gate, the allowlist and the step-up check ever run. Task 11 corrects the numbered list and adds the hard-deny subsection. Rewriting the step-up and production-allowlist sections is out of this wave's scope and is called out in the PR body as a follow-up.


---

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `apps/api/src/services/systemCleanup.ts` | W04 service seam; gains `aiOrigin` + `requestedBy` params and `awaitSystemCleanupResult` | 1 |
| `apps/api/src/services/systemCleanup.aiOrigin.test.ts` (Create) | the origin is forwarded to the command queue | 1 |
| `apps/api/src/services/aiToolsFilesystem.ts` | `system_cleanup` registration + thin handler (ADD ONLY — `disk_cleanup` is W03's, amendment B8) | 2 |
| `apps/api/src/services/aiToolsFilesystem.systemCleanup.test.ts` (Create) | list/run happy paths, 409, validation, origin | 2 |
| `apps/api/src/services/aiToolSchemas.ts` | `system_cleanup` Zod entry | 3 |
| `apps/api/src/services/aiGuardrails.ts` | `TIER3_ACTIONS`, `TIER3_SUPERVISED_ACTIONS`, `TOOL_PERMISSIONS`, `TOOL_RATE_LIMITS` | 4 |
| `apps/api/src/services/aiGuardrails.systemCleanup.test.ts` (Create) | tier, scope, RBAC | 4 |
| `apps/api/src/services/aiAgentSdkTools.ts` | `TOOL_TIERS` entry + `tool('system_cleanup', …)` | 5 |
| `apps/api/src/services/toolTimeouts.ts`, `aiToolOutput.ts`, `aiAgentSystemPrompt.ts` | 2 h timeout, catalog/run compaction, "Files & Disk" prompt line | 6 |
| `apps/api/src/services/aiToolOutput.systemCleanup.test.ts` (Create) | compaction branch | 6 |
| `apps/api/src/services/aiAgents/agentToolCatalog.ts` | `system_cleanup: 'files_disk'` | 7 |
| `apps/api/src/services/aiAgents/actManifest.test.ts`, `impactFixTools.contract.test.ts`, `helperToolFilter.test.ts` | negative pins (no act op, not a fix tool, denied to the Helper) | 7 |
| `apps/web/src/components/ai-risk/tierConfig.ts`, `ApprovalHistoryFeed.tsx`, `locales/*/settings.json` | web mirrors + 3 keys × 8 locales | 8 |
| `apps/web/src/components/ai-risk/tierConfig.systemCleanup.test.ts` (Create) | presence in the explainer + real translations | 8 |
| `packages/shared/src/utils/aiToolLabels.ts`, `apps/mobile/src/screens/chat/components/toolIndicatorLogic.ts` | label derivation fix + mirror | 9 |
| `apps/api/src/services/aiToolsFilesystem.mcpSurface.contract.test.ts` (Create) | §9.2 as a contract, for all three disk tools | 10 |
| `apps/docs/src/content/docs/features/ai.mdx`, `mcp-server.mdx`, `playbooks.mdx` | tier/rate tables, hard-deny, playbook (`agents/commands.mdx` is W04's — alignment A3) | 11 |
| `apps/docs/src/content/docs/features/filesystem-analysis.mdx` | full rewrite | 12 |
| `apps/api/src/data/docsIndex.json` | regenerated | 12 |
| `docs/release-notes/next-release-draft.md` | release entry incl. the W02 rolling-deploy note | 13 |
| (no file — GitHub) W05 sub-issue | lab results | 14 |

**Not in W05 (moved to W03 by the Codex quorum — amendment B8):** `aiToolsFilesystem.diskCleanupRunPin.test.ts`, the `disk_cleanup` edits to `aiToolsFilesystem.ts` / `aiToolSchemas.ts` / `aiAgentSdkTools.ts`, `aiAgents/actManifest.ts`, `aiAgents/actRevalidation.ts`, `aiAgents/actVerify.ts`, `builtInPlaybooks.ts`, `aiAgents/playbookActExecutor.ts`.

---

### Task 1: The W04 service seam carries an AI origin

**Files:**
- Modify: `apps/api/src/services/systemCleanup.ts` (the module W04 ships; see amendment A1 if it is not there yet)
- Create: `apps/api/src/services/systemCleanup.aiOrigin.test.ts` (Test)

**Interfaces:**
- Consumes: `queueCommandForExecution`, `CommandTypes` (`./commandQueue`); `AiOriginRef` (`@breeze/shared`); `MIN_AGENT_VERSION_SYSTEM_CLEANUP`, `SYSTEM_CLEANUP_RUN_TIMEOUT_MS`, `systemCleanupAgentGate` (W04, same module).
- Produces:
  ```ts
  // W04 ships these three types and the two functions; this wave adds ONLY the
  // `aiOrigin` field and `awaitSystemCleanupResult` (amendment A1).
  export interface QueueSystemCleanupListArgs {
    device: { id: string; orgId: string; agentVersion: string | null; status: string };
    requestedBy: string | null;
    /** #5022 W01 — set by the AI lane, absent on the human route. NEW in W05. */
    aiOrigin?: AiOriginRef;
  }
  export interface StartSystemCleanupRunArgs extends QueueSystemCleanupListArgs {
    actionIds: string[];
    params?: { journalVacuumBytes?: number };
  }
  export type SystemCleanupQueueResult =
    | { ok: true; commandId: string }
    | { ok: false; status: 409; error: 'agent_update_required'; minAgentVersion: string }
    | { ok: false; status: 400 | 503; error: string };
  // NB: `SystemCleanupRunResult` is already taken in this module by W04's
  // parsed agent payload (W04 Task 11a), hence `…StartResult` (amendment A1).
  export type SystemCleanupStartResult =
    | { ok: true; commandId: string; cleanupRunId: string }
    | Exclude<SystemCleanupQueueResult, { ok: true }>;
  export async function awaitSystemCleanupResult(
    commandId: string,
    timeoutMs: number,
  ): Promise<{ status: 'completed' | 'failed' | 'timeout'; result?: unknown; error?: string }>;
  ```

- [ ] **Step 1: Write the failing test** — create `apps/api/src/services/systemCleanup.aiOrigin.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #5022 W01 contract, applied to the W04 system-cleanup seam (W05 amendment B11).
 *
 * `services/aiDispatch.contract.test.ts` scans only
 * `services/aiTools*.ts` and `services/aiAgents/**`, so THIS module can reach
 * `queueCommandForExecution` with no origin and no suite notices. The AI lane
 * decides a `system_cleanup run` — a destructive, unattended device mutation —
 * so the origin has to survive the hop into the shared service, or the
 * `ai.command.executed` attribution row is never written.
 */

const queueState = vi.hoisted(() => ({
  calls: [] as Array<{ type: string; payload: Record<string, unknown>; options: Record<string, unknown> }>,
}));

vi.mock('./commandQueue', () => ({
  queueCommandForExecution: vi.fn(async (
    _deviceId: string,
    type: string,
    payload: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => {
    queueState.calls.push({ type, payload, options });
    return { command: { id: `cmd-${queueState.calls.length}` }, delivery: 'delivered' };
  }),
  CommandTypes: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

const dbState = vi.hoisted(() => ({ insertedRuns: [] as Record<string, unknown>[] }));

vi.mock('../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => ({
        returning: vi.fn(async () => {
          const id = `run-${dbState.insertedRuns.length + 1}`;
          dbState.insertedRuns.push({ ...row, id });
          return [{ id, ...row }];
        }),
      })),
    })),
  },
}));

import { queueSystemCleanupList, startSystemCleanupRun } from './systemCleanup';

const DEVICE = {
  id: '33333333-3333-3333-3333-333333333333',
  orgId: '11111111-1111-1111-1111-111111111111',
  agentVersion: '9.9.9',
  status: 'online',
};

const AI_ORIGIN = { kind: 'ai_assistant', sessionId: 'sess-1' } as const;

describe('systemCleanup service — AI origin passthrough', () => {
  beforeEach(() => {
    queueState.calls = [];
    dbState.insertedRuns = [];
  });

  it('forwards aiOrigin to the command queue for system_cleanup_list', async () => {
    const result = await queueSystemCleanupList({
      device: DEVICE,
      requestedBy: null,
      aiOrigin: AI_ORIGIN,
    });

    expect(result).toMatchObject({ ok: true });
    expect(queueState.calls).toHaveLength(1);
    expect(queueState.calls[0]!.type).toBe('system_cleanup_list');
    expect(queueState.calls[0]!.options.aiOrigin).toEqual(AI_ORIGIN);
  });

  it('forwards aiOrigin to the command queue for system_cleanup_run', async () => {
    const result = await startSystemCleanupRun({
      device: DEVICE,
      requestedBy: null,
      actionIds: ['linux_pkg_cache_clean'],
      aiOrigin: AI_ORIGIN,
    });

    expect(result).toMatchObject({ ok: true });
    expect(queueState.calls).toHaveLength(1);
    expect(queueState.calls[0]!.type).toBe('system_cleanup_run');
    expect(queueState.calls[0]!.options.aiOrigin).toEqual(AI_ORIGIN);
    // The run row is created by THIS function, not by the caller — one
    // implementation of the insert, shared by the route and the AI tool.
    expect(dbState.insertedRuns).toHaveLength(1);
    expect(dbState.insertedRuns[0]).toMatchObject({ kind: 'system', status: 'running' });
  });

  it('omits aiOrigin entirely on the human route path (no synthetic origin)', async () => {
    await queueSystemCleanupList({ device: DEVICE, requestedBy: 'user-1' });
    expect(queueState.calls[0]!.options.aiOrigin).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/systemCleanup.aiOrigin.test.ts
```

Expected failure, one of two shapes depending on what W04 shipped: `Failed to load .../systemCleanup.aiOrigin.test.ts` … `Cannot find module './systemCleanup'` (the module is still inline in the route — do the extraction in Step 3), or `expected undefined to equal { kind: 'ai_assistant', … }` on the first two cases (the module exists but drops the origin).

- [ ] **Step 3: Implement** — in `apps/api/src/services/systemCleanup.ts`, add the optional origin to both argument types and forward it. If the bodies are still inline in `apps/api/src/routes/devices/filesystem.ts`, move them here verbatim first and re-point the route (`git grep -n "system_cleanup_run" apps/api/src` finds every site). The forwarding edit:

```ts
import type { AiOriginRef } from '@breeze/shared';
import { queueCommandForExecution, CommandTypes } from './commandQueue';

export interface QueueSystemCleanupListArgs {
  device: { id: string; orgId: string; agentVersion: string | null; status: string };
  requestedBy: string | null;
  /**
   * #5022 W01 — who DECIDED this command, when an AI surface did. Absent on
   * the human route path; REQUIRED on the AI path, where
   * `requireAiOrigin(auth, 'system_cleanup')` throws rather than letting an
   * unattributed device command through. This module sits outside
   * `aiDispatch.contract.test.ts`'s AI_FILE scan, so nothing else enforces it.
   */
  aiOrigin?: AiOriginRef;
}

// W04's function, with ONE added spread. Do not re-write the body.
export async function queueSystemCleanupList(
  args: QueueSystemCleanupListArgs,
): Promise<SystemCleanupQueueResult> {
  const gate = systemCleanupAgentGate(args.device);
  if (!gate.ok) return gate;

  const queued = await queueCommandForExecution(
    args.device.id,
    CommandTypes.SYSTEM_CLEANUP_LIST,
    {},
    { userId: args.requestedBy ?? undefined, ...(args.aiOrigin ? { aiOrigin: args.aiOrigin } : {}) },
  );
  if (!queued.command) {
    return { ok: false, status: 503, error: queued.error || 'Failed to queue the cleanup catalog request' };
  }
  return { ok: true, commandId: queued.command.id };
}
```

and the same `...(args.aiOrigin ? { aiOrigin: args.aiOrigin } : {})` spread on the `queueCommandForExecution` call inside `startSystemCleanupRun`, after its `device_filesystem_cleanup_runs` insert.

- [ ] **Step 4: Add the shared await helper** — still in `apps/api/src/services/systemCleanup.ts`:

```ts
/**
 * The AI lane needs a RESULT, not a 202. The routes stay async (the web panel
 * polls W04's own `GET /devices/:id/filesystem/system-cleanup/list/:commandId`
 * and `.../run/:cleanupRunId` — the generic `GET /devices/:id/commands/:id`
 * cannot serve this, W04 amendment 6); this helper is the one place that
 * waits, so list/run themselves are still implemented exactly once.
 *
 * Polls the command row rather than holding a socket waiter: a DISM run can
 * take 90 minutes and `SYSTEM_CLEANUP_RUN_TIMEOUT_MS` is 2 h, far beyond any
 * in-memory waiter's lifetime across an API restart.
 */
export async function awaitSystemCleanupResult(
  commandId: string,
  timeoutMs: number,
): Promise<{ status: 'completed' | 'failed' | 'timeout'; result?: unknown; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  const intervalMs = 5_000;
  while (Date.now() < deadline) {
    const [row] = await db
      .select({ status: deviceCommands.status, result: deviceCommands.result, error: deviceCommands.error })
      .from(deviceCommands)
      .where(eq(deviceCommands.id, commandId))
      .limit(1);
    if (row && (row.status === 'completed' || row.status === 'failed')) {
      // Defensive fallback from spec §5.3: an agent that does not know the
      // command type answers with this exact prefix, which must resolve to the
      // same 409 the version gate produces rather than an opaque failure.
      const error = typeof row.error === 'string' ? row.error : undefined;
      if (error?.startsWith('unknown command type:')) {
        return { status: 'failed', error: 'agent_update_required' };
      }
      return { status: row.status, result: row.result, error };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { status: 'timeout', error: 'timed out' };
}
```

- [ ] **Step 5: Run it and watch it pass**

```bash
cd apps/api && npx vitest run src/services/systemCleanup.aiOrigin.test.ts
```

Expected: 3 passed. Then re-run W04's own route suite so the extraction (if any) is proved non-breaking:

```bash
cd apps/api && npx vitest run src/routes/devices/filesystem
```

Expected: every `filesystem*` route suite green; check the reported file count is the same as before the edit.

- [ ] **Step 6: Typecheck**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/systemCleanup.ts apps/api/src/services/systemCleanup.aiOrigin.test.ts apps/api/src/routes/devices/filesystem.ts
git commit -m "$(cat <<'EOF'
feat(api): carry aiOrigin through the system-cleanup service seam

The AI lane decides system_cleanup run, a destructive unattended device
mutation, but services/systemCleanup.ts sits outside aiDispatch's AI_FILE
scan — so an origin-less dispatch from there would pass every suite. Both
queue helpers now take an optional aiOrigin and forward it, and
awaitSystemCleanupResult gives the AI lane a result without a second
implementation of list/run.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `system_cleanup` tool — definition, `deviceArgs`, thin handler

**Files:**
- Modify: `apps/api/src/services/aiToolsFilesystem.ts` (append a third `registerTool(...)` block inside `registerFilesystemTools`, after the `disk_cleanup` block that ends at `:375`)
- Create: `apps/api/src/services/aiToolsFilesystem.systemCleanup.test.ts` (Test)

**Interfaces:**
- Consumes: `queueSystemCleanupList`, `startSystemCleanupRun`, `awaitSystemCleanupResult`, `SYSTEM_CLEANUP_RUN_TIMEOUT_MS`, `MIN_AGENT_VERSION_SYSTEM_CLEANUP` (`./systemCleanup`, Task 1); `requireAiOrigin` (`./aiDispatch`); the file-local `verifyDeviceAccess` (`aiToolsFilesystem.ts:31`); `createAuditLogAsync`, `ANONYMOUS_ACTOR_ID` (`./auditService`, `./auditEvents`).
- Produces: registry entry `system_cleanup` with `tier: 1`, `deviceArgs: ['deviceId']`, `input_schema.properties` = `{ deviceId, action, actionIds, params }`, `required: ['deviceId','action']`.

- [ ] **Step 1: Write the failing test** — create `apps/api/src/services/aiToolsFilesystem.systemCleanup.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const ORG_ID = '11111111-1111-1111-1111-111111111111';

const dbMockState = vi.hoisted(() => ({
  deviceRows: [] as unknown[],
  userRows: [] as unknown[],
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const chain: Record<string, unknown> = {};
        const tableName = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() =>
          Promise.resolve(tableName === 'users' ? dbMockState.userRows : dbMockState.deviceRows));
        return chain;
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 'run-1' }]) })),
    })),
  },
}));

const serviceState = vi.hoisted(() => ({
  listResult: { ok: true, commandId: 'cmd-list-1' } as Record<string, unknown>,
  runResult: { ok: true, commandId: 'cmd-run-1', cleanupRunId: 'run-9' } as Record<string, unknown>,
  awaited: { status: 'completed', result: { catalogVersion: 1, actions: [] } } as Record<string, unknown>,
  listArgs: [] as Record<string, unknown>[],
  runArgs: [] as Record<string, unknown>[],
}));

vi.mock('./systemCleanup', () => ({
  MIN_AGENT_VERSION_SYSTEM_CLEANUP: '0.115.0',
  SYSTEM_CLEANUP_RUN_TIMEOUT_MS: 7_200_000,
  queueSystemCleanupList: vi.fn(async (args: Record<string, unknown>) => {
    serviceState.listArgs.push(args);
    return serviceState.listResult;
  }),
  startSystemCleanupRun: vi.fn(async (args: Record<string, unknown>) => {
    serviceState.runArgs.push(args);
    return serviceState.runResult;
  }),
  awaitSystemCleanupResult: vi.fn(async () => serviceState.awaited),
}));

vi.mock('./commandQueue', () => ({
  executeCommand: vi.fn(async () => ({ status: 'completed', stdout: '{}' })),
  CommandTypes: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

vi.mock('./filesystemAnalysis', () => ({
  buildCleanupPreview: vi.fn(() => ({ candidates: [], estimatedBytes: 0, candidateCount: 0, categories: [] })),
  getLatestFilesystemSnapshot: vi.fn(),
  getLatestFilesystemCleanupSnapshot: vi.fn(async () => null),
  parseFilesystemAnalysisStdout: vi.fn(),
  readPlanPreviewCandidates: vi.fn(() => []),
  saveFilesystemSnapshot: vi.fn(),
  safeCleanupCategories: ['temp_files'],
}));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerFilesystemTools } from './aiToolsFilesystem';

function getTool(name: string): AiTool {
  const aiTools = new Map<string, AiTool>();
  registerFilesystemTools(aiTools);
  const tool = aiTools.get(name);
  if (!tool) throw new Error(`${name} tool not registered`);
  return tool;
}

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    user: { id: 'user-1', email: 'tech@example.com', name: 'Tech' },
    token: {} as unknown,
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    orgCondition: vi.fn(() => undefined),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'sess-1' },
    ...overrides,
  } as unknown as AuthContext;
}

describe('system_cleanup AI tool (spec §9.1, §9.3 items 1-2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceState.listArgs = [];
    serviceState.runArgs = [];
    serviceState.listResult = { ok: true, commandId: 'cmd-list-1' };
    serviceState.runResult = { ok: true, commandId: 'cmd-run-1', cleanupRunId: 'run-9' };
    serviceState.awaited = { status: 'completed', result: { catalogVersion: 1, actions: [] } };
    dbMockState.userRows = [{ id: 'user-1' }];
    dbMockState.deviceRows = [
      { id: DEVICE_ID, orgId: ORG_ID, siteId: null, hostname: 'lab-1', status: 'online', osType: 'linux', agentVersion: '0.115.0' },
    ];
  });

  it('registers at tier 1 and declares its device arg for the central gate', () => {
    const tool = getTool('system_cleanup');
    expect(tool.tier).toBe(1);
    // Amendment B1: an ARRAY, and its absence misattributes the MCP ledger to
    // the caller's first accessible org rather than erroring.
    expect(tool.deviceArgs).toEqual(['deviceId']);
    const props = tool.definition.input_schema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['action', 'actionIds', 'deviceId', 'params']);
    expect((props.action as { enum: string[] }).enum).toEqual(['list', 'run']);
  });

  it('list delegates to the shared service and returns the agent catalog', async () => {
    const raw = await getTool('system_cleanup').handler({ deviceId: DEVICE_ID, action: 'list' }, makeAuth());
    const result = JSON.parse(raw);

    expect(result.error).toBeUndefined();
    expect(result.catalog).toEqual({ catalogVersion: 1, actions: [] });
    expect(serviceState.listArgs).toHaveLength(1);
    expect(serviceState.listArgs[0]).toMatchObject({
      device: { id: DEVICE_ID },
      aiOrigin: { kind: 'ai_assistant', sessionId: 'sess-1' },
    });
  });

  it('run requires actionIds', async () => {
    const raw = await getTool('system_cleanup').handler({ deviceId: DEVICE_ID, action: 'run' }, makeAuth());
    expect(JSON.parse(raw).error).toBe('actionIds are required for the run action');
    expect(serviceState.runArgs).toHaveLength(0);
  });

  it('run delegates to the shared service, waits, and reports the measured result', async () => {
    serviceState.awaited = {
      status: 'completed',
      result: { runId: 'run-9', freedBytes: 1234, actions: [{ id: 'linux_pkg_cache_clean', status: 'completed' }] },
    };
    const raw = await getTool('system_cleanup').handler(
      { deviceId: DEVICE_ID, action: 'run', actionIds: ['linux_pkg_cache_clean'] },
      makeAuth(),
    );
    const result = JSON.parse(raw);

    expect(result.error).toBeUndefined();
    expect(result.cleanupRunId).toBe('run-9');
    expect(result.freedBytes).toBe(1234);
    expect(serviceState.runArgs[0]).toMatchObject({ actionIds: ['linux_pkg_cache_clean'] });
  });

  it('surfaces the 409 agent gate verbatim instead of dispatching', async () => {
    serviceState.listResult = {
      ok: false, status: 409, error: 'agent_update_required', minAgentVersion: '0.115.0',
    };
    const raw = await getTool('system_cleanup').handler({ deviceId: DEVICE_ID, action: 'list' }, makeAuth());
    const result = JSON.parse(raw);

    expect(result.error).toBe('agent_update_required');
    expect(result.minAgentVersion).toBe('0.115.0');
  });

  it('refuses a device the caller cannot reach, before any dispatch', async () => {
    dbMockState.deviceRows = [];
    const raw = await getTool('system_cleanup').handler({ deviceId: DEVICE_ID, action: 'list' }, makeAuth());
    expect(JSON.parse(raw).error).toBe('Device not found or access denied');
    expect(serviceState.listArgs).toHaveLength(0);
  });

  it('refuses an AuthContext with no aiOrigin rather than dispatching unattributed', async () => {
    await expect(
      getTool('system_cleanup').handler(
        { deviceId: DEVICE_ID, action: 'list' },
        makeAuth({ aiOrigin: undefined } as Partial<AuthContext>),
      ),
    ).rejects.toThrow(/aiOrigin/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/aiToolsFilesystem.systemCleanup.test.ts
```

Expected failure: `Error: system_cleanup tool not registered` on every case.

- [ ] **Step 3: Implement** — in `apps/api/src/services/aiToolsFilesystem.ts`, extend the import block at the top:

```ts
import { aiExecuteCommand, requireAiOrigin } from './aiDispatch';
import {
  MIN_AGENT_VERSION_SYSTEM_CLEANUP,
  SYSTEM_CLEANUP_RUN_TIMEOUT_MS,
  awaitSystemCleanupResult,
  queueSystemCleanupList,
  startSystemCleanupRun,
} from './systemCleanup';
import { createAuditLogAsync } from './auditService';
```

and append this block inside `registerFilesystemTools`, immediately after the `disk_cleanup` registration:

```ts
  // ============================================
  // system_cleanup - Tier 1 list, Tier 3 run (spec §9.1)
  // ============================================
  //
  // THIN on purpose. Every decision — the MIN_AGENT_VERSION gate, action-id
  // validation, the `device_filesystem_cleanup_runs` row, the queued command —
  // lives in services/systemCleanup.ts, shared verbatim with
  // POST /devices/:id/filesystem/system-cleanup/{list,run}. A second
  // implementation here is how the two lanes drift, and the destructive one is
  // the lane with no human watching it.

  registerTool({
    tier: 1 as AiToolTier, // Base tier; `run` escalates to 3 in guardrails
    deviceArgs: ['deviceId'],
    definition: {
      name: 'system_cleanup',
      description: 'List or run OS-native maintenance cleaners on a device: Windows Disk Cleanup handlers and DISM component cleanup, macOS local snapshots and Homebrew, Linux package caches and journal. These reclaim space the file scanner cannot see. list is read-only and returns the device catalog with per-action "up to" estimates. run executes the selected actions sequentially and requires approval.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
          action: { type: 'string', enum: ['list', 'run'], description: 'list (read-only catalog) or run (execute selected actions)' },
          actionIds: { type: 'array', items: { type: 'string' }, description: 'Catalog action ids to run, from a prior list call (required for run)' },
          params: { type: 'object', description: 'Optional per-action parameters. journalVacuumBytes (67108864-4294967296) bounds journalctl --vacuum-size.' },
        },
        required: ['deviceId', 'action'],
      },
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;
      const action = input.action as 'list' | 'run';

      // Throws (never returns) when the surface minted no origin — an
      // unattributed destructive device command is refused, not degraded.
      const aiOrigin = requireAiOrigin(auth, 'system_cleanup');

      const access = await verifyDeviceAccess(deviceId, auth, true);
      if ('error' in access) return JSON.stringify({ error: access.error });

      // Same probe-degrade as disk_cleanup above: an `ai_agent` principal's
      // auth.user.id is the agent's id, not a users row, and requested_by is an
      // FK onto users.id.
      const [userRow] = await db.select({ id: users.id }).from(users).where(eq(users.id, auth.user.id)).limit(1);
      const requestedBy = userRow ? auth.user.id : null;

      const device = {
        id: access.device.id,
        orgId: access.device.orgId,
        agentVersion: access.device.agentVersion,
        status: access.device.status,
      };

      if (action === 'list') {
        const queued = await queueSystemCleanupList({ device, requestedBy, aiOrigin });
        if (!queued.ok) {
          return JSON.stringify(
            queued.error === 'agent_update_required'
              ? { error: 'agent_update_required', minAgentVersion: MIN_AGENT_VERSION_SYSTEM_CLEANUP }
              : { error: queued.error },
          );
        }
        const awaited = await awaitSystemCleanupResult(queued.commandId, 180_000);
        if (awaited.status !== 'completed') {
          return JSON.stringify(
            awaited.error === 'agent_update_required'
              ? { error: 'agent_update_required', minAgentVersion: MIN_AGENT_VERSION_SYSTEM_CLEANUP }
              : { error: awaited.error ?? 'system cleanup catalog failed' },
          );
        }
        return JSON.stringify({ commandId: queued.commandId, catalog: awaited.result });
      }

      const actionIds = Array.isArray(input.actionIds)
        ? input.actionIds.filter((v): v is string => typeof v === 'string' && v.length > 0)
        : [];
      if (actionIds.length === 0) {
        return JSON.stringify({ error: 'actionIds are required for the run action' });
      }
      const params = (input.params ?? undefined) as { journalVacuumBytes?: number } | undefined;

      const started = await startSystemCleanupRun({ device, requestedBy, actionIds, params, aiOrigin });
      if (!started.ok) {
        return JSON.stringify(
          started.error === 'agent_update_required'
            ? { error: 'agent_update_required', minAgentVersion: MIN_AGENT_VERSION_SYSTEM_CLEANUP }
            : { error: started.error },
        );
      }

      const awaited = await awaitSystemCleanupResult(started.commandId, SYSTEM_CLEANUP_RUN_TIMEOUT_MS);
      const payload = (awaited.result ?? {}) as {
        actions?: unknown[]; volumes?: unknown[]; freedBytes?: number;
      };

      // Spec §10 item 9: the run is audited from this lane too. The agent
      // result handler writes the device.filesystem.system_cleanup.run row for
      // the route path; this one records that an AI surface asked for it.
      void createAuditLogAsync({
        orgId: device.orgId,
        actorType: requestedBy ? 'user' : 'ai_agent',
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'device.filesystem.system_cleanup.run',
        resourceType: 'device',
        resourceId: device.id,
        details: {
          cleanupRunId: started.cleanupRunId,
          commandId: started.commandId,
          actionIds,
          surface: 'ai_tool',
          status: awaited.status,
          freedBytes: typeof payload.freedBytes === 'number' ? payload.freedBytes : null,
        },
        result: awaited.status === 'completed' ? 'success' : 'failure',
      }).catch((error: unknown) => {
        console.error('[system_cleanup] audit write failed (non-fatal)', { deviceId: device.id, error });
      });

      return JSON.stringify({
        cleanupRunId: started.cleanupRunId,
        commandId: started.commandId,
        status: awaited.status,
        freedBytes: payload.freedBytes ?? 0,
        actions: payload.actions ?? [],
        volumes: payload.volumes ?? [],
        error: awaited.error ?? undefined,
      });
    },
  });
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/api && npx vitest run src/services/aiToolsFilesystem.systemCleanup.test.ts
```

Expected: 7 passed.

- [ ] **Step 5: Run the two registration contract tests this step is responsible for** (§9.3 item 2)

```bash
cd apps/api && npx vitest run \
  src/services/aiTools.deviceArgsCoverage.contract.test.ts \
  src/services/aiToolsDeviceGuard.contract.test.ts \
  src/services/aiToolsDeviceScope.contract.test.ts
```

Expected: all green. `aiTools.deviceArgsCoverage.contract.test.ts` is the one that would have failed on a missing `deviceArgs: ['deviceId']` ("These tools expose a device-id input property but do not declare it in deviceArgs"); `aiToolsDeviceGuard` passes because the handler routes through the file's existing `verifyDeviceAccess`, which already checks `auth.allowedDeviceIds` before its first `db.select`.

- [ ] **Step 6: Check the MCP tool-count tolerance** (amendment B7)

```bash
cd apps/api && npx vitest run src/services/mcpGuidancePromptTools.test.ts
```

Expected: green. If "the advertised approximate tool count stays within tolerance of the registry" fails, the live registry has reached 211 — change `MCP_TOOL_COUNT_APPROX = 200` to `210` in `apps/api/src/services/mcpGuidance.ts:8` and re-run. No other edit to that file is in scope.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
git add apps/api/src/services/aiToolsFilesystem.ts apps/api/src/services/aiToolsFilesystem.systemCleanup.test.ts
git commit -m "$(cat <<'EOF'
feat(ai): register the system_cleanup tool (list Tier 1, run Tier 3)

Thin handler in aiToolsFilesystem.ts; the gate, validation, run row and
command dispatch stay in services/systemCleanup.ts, shared verbatim with the
W04 routes. deviceArgs: ['deviceId'] is what makes the MCP execution org
resolve from the targeted device instead of the caller's first accessible org.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `aiToolSchemas.ts` — the enforced Zod entry

**Files:**
- Modify: `apps/api/src/services/aiToolSchemas.ts` (import block at `:11-12`; insert the entry after the `disk_cleanup` entry that ends at `:1007`)
- Test: `apps/api/src/services/aiToolsRegistryParity.test.ts` (existing — it goes red without this entry)

**Interfaces:**
- Consumes: `SYSTEM_CLEANUP_ACTION_IDS` (`@breeze/shared/validators`).
- Produces: `toolInputSchemas.system_cleanup`, a plain `z.ZodObject` (amendment B9).

- [ ] **Step 1: Write the failing test** — append to `apps/api/src/services/aiToolsRegistryParity.test.ts`, inside the existing `describe('aiTools registry parity', …)` block, after the final `it(...)`:

```ts
  // Disk Cleanup v2 W05 (spec §9.3 item 3). The two hand-maintained copies of
  // system_cleanup's shape must agree KEY FOR KEY: `z.object()` STRIPS unknown
  // keys rather than rejecting, so a key the model is told to send but Zod does
  // not know vanishes silently and the tool still reports success. `actionIds`
  // vanishing would turn a targeted run into an empty one.
  it('system_cleanup advertises exactly the keys it validates, and keeps a shape-introspectable schema', () => {
    const advertised = Object.keys(
      aiTools.get('system_cleanup')!.definition.input_schema.properties as Record<string, unknown>,
    ).sort();
    const schema = toolInputSchemas.system_cleanup as { shape?: Record<string, unknown> };
    // Amendment B10: a `.refine()` would make this a ZodEffects with no
    // `.shape`, which silently removes one of the two enum sources
    // `toolActionEnum` unions for the approval-scope contract test.
    expect(schema.shape, 'system_cleanup must stay a plain z.object (no .refine)').toBeDefined();
    expect(Object.keys(schema.shape!).sort()).toEqual(advertised);
    expect(advertised).toEqual(['action', 'actionIds', 'deviceId', 'params']);
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/aiToolsRegistryParity.test.ts
```

Expected failures: "Tools missing from toolInputSchemas: system_cleanup", and on the new case `expected undefined not to be undefined` for `schema.shape`.

- [ ] **Step 3: Implement** — in `apps/api/src/services/aiToolSchemas.ts`, extend the validators import at `:12`:

```ts
import {
  backupProfileSelectionsSchema,
  proposeScriptInputSchema,
  ringAutoApproveSchema,
  SYSTEM_CLEANUP_ACTION_IDS,
} from '@breeze/shared/validators';
```

and insert after the `disk_cleanup` entry:

```ts
  /**
   * OS-native cleaners (Disk Cleanup v2 §5.3, §7.2). Client input that reaches
   * an argv is exactly two things: a membership-checked action id and one
   * bounded integer. Everything else about the command line is a constant in
   * the agent's own catalog.
   *
   * Deliberately NOT `.refine()`d — see the registry-parity test: a ZodEffects
   * has no `.shape`, and `toolActionEnum` reads the action enum out of it. The
   * "actionIds required for run" rule lives in the handler, exactly where
   * disk_cleanup's "paths required for execute" rule also lives.
   */
  system_cleanup: z.object({
    deviceId: uuid,
    action: z.enum(['list', 'run']),
    actionIds: z
      .array(z.enum(SYSTEM_CLEANUP_ACTION_IDS))
      .min(1)
      .max(SYSTEM_CLEANUP_ACTION_IDS.length)
      .optional(),
    params: z
      .object({
        // journalctl --vacuum-size, bounded 64 MiB … 4 GiB (§7.2).
        journalVacuumBytes: z.number().int().min(67_108_864).max(4_294_967_296).optional(),
      })
      .strict()
      .optional(),
  }),
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/api && npx vitest run src/services/aiToolsRegistryParity.test.ts
```

Expected: green except "every registered tool has a TOOL_PERMISSIONS RBAC entry" — that entry lands in Task 4. Note the failure text (`Tools missing from TOOL_PERMISSIONS: system_cleanup`) and continue; it is the next task's red.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
git add apps/api/src/services/aiToolSchemas.ts apps/api/src/services/aiToolsRegistryParity.test.ts
git commit -m "$(cat <<'EOF'
feat(ai): Zod schema for system_cleanup, key-for-key with its tool definition

Action ids are validated as an enum over the shared SYSTEM_CLEANUP_ACTION_IDS
and journalVacuumBytes is bounded 64 MiB-4 GiB, so nothing else from the model
can reach an argv. Kept a plain z.object so toolActionEnum can still read the
action enum from the Zod side.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Guardrails — tier, approval scope, RBAC, rate limit

**Files:**
- Modify: `apps/api/src/services/aiGuardrails.ts` — `TIER3_ACTIONS` (add after `:225`), `TIER3_SUPERVISED_ACTIONS` (add after `:489`), `TOOL_PERMISSIONS` (add after `:900`), `TOOL_RATE_LIMITS` (add after `:1541`)
- Test: `apps/api/src/services/aiGuardrails.approvalScope.contract.test.ts`, `aiToolPermissionsCatalogParity.contract.test.ts`, `aiToolsRegistryParity.test.ts` (all existing)
- Create: `apps/api/src/services/aiGuardrails.systemCleanup.test.ts` (Test)

**Interfaces:**
- Consumes: nothing new.
- Produces: `TIER3_ACTIONS.system_cleanup`, `TIER3_SUPERVISED_ACTIONS.system_cleanup`, `TOOL_PERMISSIONS.system_cleanup`, `TOOL_RATE_LIMITS.system_cleanup` (module-private, observed through `checkToolRateLimit`).

- [ ] **Step 1: Write the failing test** — create `apps/api/src/services/aiGuardrails.systemCleanup.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

/**
 * Disk Cleanup v2 W05, spec §9.3 item 4 and the design constraint
 * "TIER3_ACTIONS.system_cleanup = ['run'] in BOTH guardrail tables".
 *
 * NOTE: no vi.mock — this suite needs the REAL aiTools registry, because the
 * base tier is half of what checkGuardrails resolves.
 */
import {
  TIER3_ACTIONS,
  TIER3_FOUR_EYES_ACTIONS,
  TIER3_SUPERVISED_ACTIONS,
  TOOL_PERMISSIONS,
  checkGuardrails,
} from './aiGuardrails';

describe('system_cleanup guardrails', () => {
  it('escalates run — and only run — to Tier 3', () => {
    expect(TIER3_ACTIONS.system_cleanup).toEqual(['run']);
    expect(checkGuardrails('system_cleanup', { action: 'run' }).tier).toBe(3);
    expect(checkGuardrails('system_cleanup', { action: 'list' }).tier).toBe(1);
  });

  it('classifies run as supervised, not four-eyes', () => {
    // A tech who could open Disk Cleanup on the box by hand can approve the
    // AI doing it; nothing here is externally binding, financial or
    // state-destroying. The contract test in
    // aiGuardrails.approvalScope.contract.test.ts fails if the pair is in
    // NEITHER table or in BOTH.
    expect(TIER3_SUPERVISED_ACTIONS.system_cleanup).toEqual(['run']);
    expect(TIER3_FOUR_EYES_ACTIONS.system_cleanup).toBeUndefined();
    expect(checkGuardrails('system_cleanup', { action: 'run' }).approvalScope).toBe('supervised');
  });

  it('maps RBAC per action: list reads devices, run executes on them', () => {
    expect(TOOL_PERMISSIONS.system_cleanup).toEqual({
      list: { resource: 'devices', action: 'read' },
      run: { resource: 'devices', action: 'execute' },
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/aiGuardrails.systemCleanup.test.ts
```

Expected failure: `expected undefined to deeply equal [ 'run' ]` on the first case.

- [ ] **Step 3: Implement** — four edits in `apps/api/src/services/aiGuardrails.ts`.

In `TIER3_ACTIONS`, immediately after the `disk_cleanup: ['execute'],` line:

```ts
  // OS-native cleaners (Disk Cleanup v2 §7). `list` is a read-only catalog
  // probe; `run` executes vetted maintenance binaries (cleanmgr, DISM,
  // apt-get/dnf, journalctl, tmutil, brew) as root/LocalSystem with a 90-minute
  // ceiling, and some of its handlers cannot be undone (`Previous
  // Installations` deletes Windows.old, which is the rollback path).
  system_cleanup: ['run'],
```

In `TIER3_SUPERVISED_ACTIONS`, immediately after its own `disk_cleanup: ['execute'],` line:

```ts
  // Supervised, not four_eyes: the actions are a closed, vetted catalog of
  // maintenance operations a tech could run by hand on the box, and nothing in
  // it is externally binding or financial. Its irreversibility (Windows.old)
  // is a property of the ACTION the tech picked, not of the approval class.
  system_cleanup: ['run'],
```

In `TOOL_PERMISSIONS`, immediately after the `disk_cleanup: { … }` block:

```ts
  system_cleanup: {
    list: { resource: 'devices', action: 'read' },
    run: { resource: 'devices', action: 'execute' },
  },
```

In `TOOL_RATE_LIMITS`, immediately after `disk_cleanup: { limit: 3, windowSeconds: 600 },`:

```ts
  // 2 per hour (spec §9.1). A single run can hold the device for 90 minutes
  // (DISM) and the reclaimed space does not land until the flagged reboot, so
  // a tighter window than disk_cleanup's is the honest limit: a second call
  // inside the hour is almost always the model retrying a still-running job.
  system_cleanup: { limit: 2, windowSeconds: 3600 },
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/api && npx vitest run src/services/aiGuardrails.systemCleanup.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Run the three registration contract tests** (§9.3 item 4, amendment B3)

```bash
cd apps/api && npx vitest run \
  src/services/aiGuardrails.approvalScope.contract.test.ts \
  src/services/aiToolPermissionsCatalogParity.contract.test.ts \
  src/services/aiToolsRegistryParity.test.ts \
  src/services/aiGuardrails.agentPrincipal.contract.test.ts
```

Expected: all four green. `aiGuardrails.approvalScope.contract.test.ts` is the one that fails on a missing `TIER3_SUPERVISED_ACTIONS` entry ("system_cleanup:run must be in exactly one scope table"); `aiToolsRegistryParity.test.ts`'s TOOL_PERMISSIONS case, red since Task 3, is now green.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
git add apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiGuardrails.systemCleanup.test.ts
git commit -m "$(cat <<'EOF'
feat(ai): guardrails for system_cleanup — run is Tier 3 supervised, 2/hour

TIER3_ACTIONS and TIER3_SUPERVISED_ACTIONS both carry ['run'] (either alone
fails the approval-scope contract test), RBAC is devices.read for list and
devices.execute for run, and the rate limit is 2 per 3600s because one run can
hold the device for 90 minutes.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `aiAgentSdkTools.ts` — the second registry and the SDK declaration

**Files:**
- Modify: `apps/api/src/services/aiAgentSdkTools.ts` — `TOOL_TIERS` (add after `:209`), the `tool(...)` declarations (add after the `disk_cleanup` declaration that ends at `:1772`)
- Test: `apps/api/src/services/aiAgentSdkTools.registryParity.contract.test.ts`, `aiAgentSdkTools.handlerCoverage.contract.test.ts`, `aiAgentSdkTools.mcpCoverage.test.ts` (all existing)

**Interfaces:**
- Consumes: `SYSTEM_CLEANUP_ACTION_IDS` (`@breeze/shared/validators`), `makeHandler`, `uuid`, `z` (in-module).
- Produces: `TOOL_TIERS.system_cleanup = 1`; a `tool('system_cleanup', …, makeHandler('system_cleanup', …))` declaration on the Breeze MCP server.

- [ ] **Step 1: Run the existing contract tests and watch them fail**

These three are the red; no new test file is needed, because the contract they encode is exactly what this task satisfies.

```bash
cd apps/api && npx vitest run \
  src/services/aiAgentSdkTools.registryParity.contract.test.ts \
  src/services/aiAgentSdkTools.handlerCoverage.contract.test.ts \
  src/services/aiAgentSdkTools.mcpCoverage.test.ts
```

Expected failure, from `aiAgentSdkTools.registryParity.contract.test.ts`:

```
These tools are registered but have no TOOL_TIERS entry, so the AI chat will
tell users the capability does not exist. …
- [ 'system_cleanup' ]
```

- [ ] **Step 2: Implement the tier entry** — in `TOOL_TIERS`, immediately after `disk_cleanup: 1,`:

```ts
  system_cleanup: 1, // Base tier; run escalated to 3 in guardrails
```

- [ ] **Step 3: Implement the SDK declaration** — immediately after the `tool('disk_cleanup', …)` declaration, and extend the file's `@breeze/shared/validators` import with `SYSTEM_CLEANUP_ACTION_IDS`:

```ts
    tool(
      'system_cleanup',
      'List or run OS-native maintenance cleaners on a device (Windows Disk Cleanup handlers and DISM component cleanup, macOS local snapshots and Homebrew, Linux package caches and journal). list is read-only. run executes the selected catalog actions and requires approval.',
      {
        deviceId: uuid,
        action: z.enum(['list', 'run']),
        actionIds: z
          .array(z.enum(SYSTEM_CLEANUP_ACTION_IDS))
          .min(1)
          .optional(),
        params: z
          .object({ journalVacuumBytes: z.number().int().min(67_108_864).max(4_294_967_296).optional() })
          .optional(),
      },
      makeHandler('system_cleanup', getAuth, onPreToolUse, onPostToolUse)
    ),
```

- [ ] **Step 4: Run the three contract tests and watch them pass**

```bash
cd apps/api && npx vitest run \
  src/services/aiAgentSdkTools.registryParity.contract.test.ts \
  src/services/aiAgentSdkTools.handlerCoverage.contract.test.ts \
  src/services/aiAgentSdkTools.mcpCoverage.test.ts
```

Expected: all green. Specifically: `registryParity` now finds the tier and agrees it equals the registry's `1`; `handlerCoverage` finds `makeHandler('system_cleanup')` backed by a registered handler; `mcpCoverage`'s "declares every TOOL_TIERS tool except the documented exceptions" finds the `tool('system_cleanup'` literal, and "createBreezeMcpServer constructs" still passes (a malformed zod shape throws at build time).

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
git add apps/api/src/services/aiAgentSdkTools.ts
git commit -m "$(cat <<'EOF'
feat(ai): declare system_cleanup on the Breeze MCP server

TOOL_TIERS gates chat visibility twice over (BREEZE_MCP_TOOL_NAMES is derived
from it, and createSessionPreToolUse rejects an untiered name as "Unknown
tool"), and a tiered tool with no tool() declaration is allowlisted but
uncallable — the #2605 shape. Both land here together.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Timeout, output compaction, system-prompt tool list

**Files:**
- Modify: `apps/api/src/services/toolTimeouts.ts` (add after `:19`)
- Modify: `apps/api/src/services/aiToolOutput.ts` (new compaction helper near `:302`; new branch in `applyToolSpecificCompaction` after `:541`)
- Modify: `apps/api/src/services/aiAgentSystemPrompt.ts:99` (the "Files & Disk" line)
- Create: `apps/api/src/services/aiToolOutput.systemCleanup.test.ts` (Test)

**Interfaces:**
- Consumes: `pruneLargeList`, `isRecord`, `asArray`, `CompactStats` (file-local in `aiToolOutput.ts`).
- Produces: `getToolTimeout('system_cleanup') === 7_200_000`; a `system_cleanup` branch in `applyToolSpecificCompaction`.

- [ ] **Step 1: Write the failing test** — create `apps/api/src/services/aiToolOutput.systemCleanup.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { compactToolResult } from './aiToolOutput';
import { getToolTimeout } from './toolTimeouts';

/**
 * Disk Cleanup v2 W05, spec §9.3 item 6.
 *
 * A `system_cleanup list` catalog carries one row per action with a label, a
 * description, risk flags and sub-actions (the Windows handler allowlist alone
 * is 20 entries), and a `run` result carries a 16 KiB output tail PER ACTION.
 * Unbounded, that is a multi-hundred-kilobyte tool result pasted into the
 * model's context for what is a short answer.
 */
describe('system_cleanup output compaction', () => {
  it('gets the 2h execution budget DISM needs', () => {
    // §5.3: SYSTEM_CLEANUP_RUN_TIMEOUT_MS. The default 60s would abandon every
    // real run at the first action.
    expect(getToolTimeout('system_cleanup')).toBe(7_200_000);
  });

  it('truncates a long action list and says how many it dropped', () => {
    const actions = Array.from({ length: 80 }, (_, i) => ({
      id: `action_${i}`, label: `Action ${i}`, available: true, estimateKnown: false,
    }));
    const compacted = JSON.parse(
      compactToolResult('system_cleanup', JSON.stringify({ catalog: { catalogVersion: 1, actions } })).text,
    );

    expect(compacted.catalog.actions).toHaveLength(40);
    expect(compacted.catalog.returnedActionCount).toBe(40);
    expect(compacted.catalog.totalActionCount).toBe(80);
    expect(compacted.catalog.truncatedActionCount).toBe(40);
  });

  it('caps each run action’s outputTail instead of pasting 16 KiB per action', () => {
    const compacted = JSON.parse(
      compactToolResult('system_cleanup', JSON.stringify({
        cleanupRunId: 'run-1',
        freedBytes: 1024,
        actions: [{ id: 'win_dism_component_cleanup', status: 'completed', outputTail: 'x'.repeat(20_000) }],
      })).text,
    );

    expect(compacted.actions[0].outputTail.length).toBeLessThanOrEqual(2_000);
    expect(compacted.actions[0].outputTailTruncated).toBe(true);
    // The numbers the answer is built from are never dropped.
    expect(compacted.freedBytes).toBe(1024);
    expect(compacted.actions[0].status).toBe('completed');
  });

  it('leaves a small result untouched', () => {
    const payload = { cleanupRunId: 'run-1', freedBytes: 0, actions: [{ id: 'a', status: 'failed', outputTail: 'boom' }] };
    const compacted = JSON.parse(compactToolResult('system_cleanup', JSON.stringify(payload)).text);
    expect(compacted).toEqual(payload);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/aiToolOutput.systemCleanup.test.ts
```

Expected failure: `expected 60000 to be 7200000` on the first case.

- [ ] **Step 3: Implement the timeout** — in `apps/api/src/services/toolTimeouts.ts`, after `disk_cleanup: 90_000,`:

```ts
  // OS-native cleaners (Disk Cleanup v2 §5.3). cleanmgr is capped at 60 min and
  // DISM /StartComponentCleanup at 90 min on the agent side, and they run
  // sequentially, so the outer guard has to sit above the sum of the caps or it
  // cancels a run the device is still executing — leaving a `running` row with
  // no terminal result.
  system_cleanup: 7_200_000,
```

- [ ] **Step 4: Implement the compaction** — in `apps/api/src/services/aiToolOutput.ts`, add the helper next to `compactDiskCleanupPayload`:

```ts
const MAX_SYSTEM_CLEANUP_ACTIONS = 40;
const MAX_SYSTEM_CLEANUP_OUTPUT_TAIL = 2_000;

/**
 * `system_cleanup` has two result shapes behind one tool name: the `list`
 * catalog (`{ catalog: { actions: [...] } }`) and the `run` report
 * (`{ actions: [{ outputTail }], volumes, freedBytes }`). Both are pruned here;
 * the numbers an answer is actually built from — freedBytes, status, exitCode,
 * estimates — are never dropped, only the prose is.
 */
function compactSystemCleanupPayload(payload: Record<string, unknown>, stats: CompactStats): Record<string, unknown> {
  const output = { ...payload };

  const catalog = isRecord(output.catalog) ? { ...output.catalog } : null;
  if (catalog) {
    const actions = asArray(catalog.actions);
    const { items, dropped } = pruneLargeList(actions, MAX_SYSTEM_CLEANUP_ACTIONS);
    catalog.actions = items;
    catalog.returnedActionCount = items.length;
    catalog.totalActionCount = actions.length;
    catalog.truncatedActionCount = Math.max(0, dropped);
    if (dropped > 0) {
      stats.arraysTruncated += 1;
      stats.arrayItemsDropped += dropped;
    }
    output.catalog = catalog;
  }

  const runActions = asArray(output.actions);
  if (runActions.length > 0) {
    output.actions = runActions.map((entry) => {
      if (!isRecord(entry)) return entry;
      const tail = entry.outputTail;
      if (typeof tail !== 'string' || tail.length <= MAX_SYSTEM_CLEANUP_OUTPUT_TAIL) return entry;
      stats.arrayItemsDropped += 1;
      return {
        ...entry,
        outputTail: tail.slice(-MAX_SYSTEM_CLEANUP_OUTPUT_TAIL),
        outputTailTruncated: true,
      };
    });
  }

  return output;
}
```

and the dispatch branch, immediately after the `disk_cleanup` branch in `applyToolSpecificCompaction`:

```ts
  if (toolName === 'system_cleanup') {
    return compactSystemCleanupPayload(parsed, stats);
  }
```

- [ ] **Step 5: Implement the system-prompt line** — in `apps/api/src/services/aiAgentSystemPrompt.ts:99`, replace:

```
- **Files & Disk**: file_operations, analyze_disk_usage, disk_cleanup, registry_operations
```

with:

```
- **Files & Disk**: file_operations, analyze_disk_usage, disk_cleanup, system_cleanup, registry_operations
```

- [ ] **Step 6: Run it and watch it pass**

```bash
cd apps/api && npx vitest run \
  src/services/aiToolOutput.systemCleanup.test.ts \
  src/services/aiToolOutput.test.ts \
  src/services/mcpGuidancePromptTools.test.ts
```

Expected: all three green. `aiToolOutput.test.ts` is listed because the new branch sits in the same dispatch chain as the existing `analyze_disk_usage`/`disk_cleanup` branches; `mcpGuidancePromptTools.test.ts` is listed because `BREEZE_AI_GUARDRAILS_CORE` from the system-prompt module is embedded in `MCP_SERVER_INSTRUCTIONS` and every tool-shaped token there must name a real registry tool.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
git add apps/api/src/services/toolTimeouts.ts apps/api/src/services/aiToolOutput.ts apps/api/src/services/aiToolOutput.systemCleanup.test.ts apps/api/src/services/aiAgentSystemPrompt.ts
git commit -m "$(cat <<'EOF'
feat(ai): 2h budget, result compaction and prompt entry for system_cleanup

The default 60s tool timeout would abandon a DISM run at the first action. The
catalog and the per-action 16 KiB output tails are pruned before they reach the
model's context, keeping every number an answer is built from.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Agent catalog, act manifest, impact-fix and Helper — the four negatives

**Files:**
- Modify: `apps/api/src/services/aiAgents/agentToolCatalog.ts:97-100` (the `files_disk` block of `TOOL_CAPABILITY`)
- Modify: `apps/api/src/services/aiAgents/actManifest.test.ts` (add assertions)
- Modify: `apps/api/src/services/aiAgents/impactFixTools.contract.test.ts` (add one assertion)
- Modify: `apps/api/src/services/helperToolFilter.test.ts` (add one case)
- Test: `apps/api/src/services/aiAgents/agentToolCatalog.contract.test.ts` (existing — it goes red without the capability entry)

**Interfaces:**
- Consumes: nothing new.
- Produces: `TOOL_CAPABILITY.system_cleanup = 'files_disk'`. Deliberately produces **no** `ActOperation`, **no** `IMPACT_FIX_TOOLS` entry, **no** `HELPER_TOOL_SCOPING` entry, and **no** `AGENT_KIND_PRESETS` membership.

- [ ] **Step 1: Write the failing assertions.** Three files.

In `apps/api/src/services/aiAgents/actManifest.test.ts`, inside `describe('ACT_MANIFEST frozen key set', …)`:

```ts
  // Disk Cleanup v2 W05, spec §9.3 item 8. `system_cleanup run` is NEVER
  // unattended-eligible: the catalog contains irreversible handlers (Previous
  // Installations deletes Windows.old, which IS the rollback path) and its
  // postcondition is a free-space delta that only materialises after a reboot,
  // so there is no read-back an act-mode verify could make at dispatch time.
  // This is a decision, recorded as a test, not an omission.
  it('has no entry for system_cleanup', () => {
    expect(ACT_MANIFEST.some((op) => op.toolName === 'system_cleanup')).toBe(false);
    expect(ACT_MANIFEST.some((op) => op.key.startsWith('system_cleanup'))).toBe(false);
    expect(resolveActOperation('system_cleanup', { action: 'run' })).toBeNull();
    expect([...ACT_ELIGIBLE_TOOL_NAMES]).not.toContain('system_cleanup');
  });
```

In `apps/api/src/services/aiAgents/impactFixTools.contract.test.ts`, at the end of its top-level `describe`:

```ts
  // Disk Cleanup v2 W05, spec §9.3 item 9 — recorded as a decision.
  // `system_cleanup` reports MEASURED freed bytes on its own run row; counting
  // it again in the impact rollup would double-count the same reclaimed space
  // against a "fix" the customer never asked to be framed as remediation.
  it('does not count system_cleanup as a fix', () => {
    expect(IMPACT_FIX_TOOLS).not.toContain('system_cleanup');
  });
```

In `apps/api/src/services/helperToolFilter.test.ts`, at the end of its top-level `describe`:

```ts
  // Disk Cleanup v2 W05, spec §9.3 item 10. The Helper runs in front of an END
  // USER, not a technician. `system_cleanup run` executes vetted maintenance
  // binaries as LocalSystem for up to 90 minutes and some handlers are
  // irreversible — that is not an end-user self-service action at any
  // permission level, and it has no HELPER_TOOL_SCOPING entry, so the
  // executeTool gate denies it even if a whitelist later named it.
  it('system_cleanup is denied to the Helper at every level', () => {
    for (const level of ['basic', 'standard', 'extended'] as const) {
      expect(getHelperAllowedTools(level)).not.toContain('system_cleanup');
      expect(validateHelperToolAccess('system_cleanup', level)).toContain('not available');
    }
    expect(HELPER_TOOL_SCOPING.system_cleanup).toBeUndefined();
  });
```

- [ ] **Step 2: Run them and watch the catalog one fail**

```bash
cd apps/api && npx vitest run \
  src/services/aiAgents/agentToolCatalog.contract.test.ts \
  src/services/aiAgents/actManifest.test.ts \
  src/services/aiAgents/impactFixTools.contract.test.ts \
  src/services/helperToolFilter.test.ts
```

Expected: the three negative assertions pass immediately (they pin decisions, and the decision is "do nothing" — that is the point of writing them). `agentToolCatalog.contract.test.ts` fails on "maps EVERY registered headless tool to a capability, and nothing else":

```
- Expected  - 0
+ Received  + 1
+   "system_cleanup",
```

- [ ] **Step 3: Implement** — in `apps/api/src/services/aiAgents/agentToolCatalog.ts`, in the `// ---- files_disk ----` block:

```ts
  // ---- files_disk ----
  file_operations: 'files_disk',
  disk_cleanup: 'files_disk',
  analyze_disk_usage: 'files_disk',
  // Deliberately NOT added to any AGENT_KIND_PRESETS default (spec §9.3 item
  // 7): an operator turns this on per agent, on purpose. `triage` and
  // `helpdesk` ship with `disk_cleanup:execute` because a previewed,
  // path-pinned file delete is rule-equivalent; a native cleaner is not.
  system_cleanup: 'files_disk',
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/api && npx vitest run \
  src/services/aiAgents/agentToolCatalog.contract.test.ts \
  src/services/aiAgents/actManifest.test.ts \
  src/services/aiAgents/impactFixTools.contract.test.ts \
  src/services/helperToolFilter.test.ts
```

Expected: all green, **with no snapshot update**. If `agentToolCatalog.contract.test.ts` reports an obsolete or changed snapshot for "pins the unreachable set", something is wrong: `system_cleanup` is registered AND in `TOOL_TIERS` AND not human-only/blocked/secret-bearing, so it is *reachable* and must never enter `listUnreachableRegisteredTools()` (amendment B10). Do not run with `-u`; find out why it is unreachable instead.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiAgents/agentToolCatalog.ts apps/api/src/services/aiAgents/actManifest.test.ts apps/api/src/services/aiAgents/impactFixTools.contract.test.ts apps/api/src/services/helperToolFilter.test.ts
git commit -m "$(cat <<'EOF'
feat(ai): place system_cleanup under files_disk; pin its three exclusions

Capability mapping is required (the catalog contract test compares TOOL_CAPABILITY
to the registry exactly). The exclusions — no ActOperation, not an impact-fix
tool, denied to the Helper — are decisions, so they are now tests rather than
absences a later author reads as an oversight.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---


### Task 8: Web mirrors — tier explainer, rate-limit table, RBAC map, approval label, 8 locales

**Files:**
- Modify: `apps/web/src/components/ai-risk/tierConfig.ts` — Tier 1 tools (after `:91`), Tier 3 tools (after `:242`), `RATE_LIMIT_CONFIGS` (after `:319`), `RBAC_MAPPINGS` (after `:403`)
- Modify: `apps/web/src/components/ai-risk/ApprovalHistoryFeed.tsx:23-32` (`TIER3_TOOLS`)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/settings.json` — `aiAgentsPage.catalog.tools.system_cleanup` and `aiAgentsPage.catalog.actions.system_cleanup.{list,run}`
- Create: `apps/web/src/components/ai-risk/tierConfig.systemCleanup.test.ts` (Test)
- Test: `apps/api/src/services/aiGuardrailsTierConfig.parity.test.ts` (existing — the cross-package parity gate)

**Interfaces:**
- Consumes: nothing new.
- Produces: three `tierConfig.ts` rows, one `RBAC_MAPPINGS` entry, one `TIER3_TOOLS` member, three locale keys × eight catalogs.

- [ ] **Step 1: Write the failing test** — create `apps/web/src/components/ai-risk/tierConfig.systemCleanup.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RATE_LIMIT_CONFIGS, RBAC_MAPPINGS, TIER_DEFINITIONS } from './tierConfig';

/**
 * Disk Cleanup v2 W05, spec §9.3 item 12.
 *
 * tierConfig.ts is what an MSP SHOWS A CUSTOMER when asked "what can your AI do
 * to my machines without asking?". The cross-package guard
 * (apps/api/src/services/aiGuardrailsTierConfig.parity.test.ts) proves every
 * row's claimed tier is the tier checkGuardrails actually resolves — but it
 * cannot notice a tool that is simply ABSENT from the explainer. This suite is
 * the presence half.
 */
const LOCALES = ['en', 'de-DE', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR'] as const;
const localesDir = join(dirname(fileURLToPath(import.meta.url)), '../../locales');

function toolEntries(tier: number): string[] {
  return TIER_DEFINITIONS.find((t) => t.tier === tier)!.tools.map((entry) => entry.name);
}

describe('tierConfig lists system_cleanup', () => {
  it('shows list as auto-executing and run as approval-gated', () => {
    expect(toolEntries(1)).toContain('system_cleanup (list)');
    expect(toolEntries(3)).toContain('system_cleanup (run)');
  });

  it('advertises the real per-tool rate limit and permission', () => {
    const row = RATE_LIMIT_CONFIGS.find((c) => c.toolName === 'system_cleanup');
    expect(row).toEqual({
      toolName: 'system_cleanup',
      limit: 2,
      windowSeconds: 3600,
      tier: 3,
      permission: 'devices.execute',
      category: 'Files, Disk & Registry',
    });
  });

  it('maps RBAC per action', () => {
    expect(RBAC_MAPPINGS.system_cleanup).toEqual({ list: 'devices.read', run: 'devices.execute' });
  });
});

describe('system_cleanup catalog labels exist in all 8 locales', () => {
  it.each(LOCALES)('%s carries the tool label and both action labels', (locale) => {
    const catalog = JSON.parse(readFileSync(join(localesDir, locale, 'settings.json'), 'utf8'));
    const tools = catalog.aiAgentsPage.catalog.tools;
    const actions = catalog.aiAgentsPage.catalog.actions;

    expect(typeof tools.system_cleanup).toBe('string');
    expect(tools.system_cleanup.length).toBeGreaterThan(0);
    expect(typeof actions.system_cleanup?.list).toBe('string');
    expect(typeof actions.system_cleanup?.run).toBe('string');

    if (locale !== 'en') {
      // translationCoverage.test.ts caps exact-English duplicates per namespace
      // and does not pin keys, so an untranslated string here silently eats
      // another string's headroom. Assert the translation happened.
      const en = JSON.parse(readFileSync(join(localesDir, 'en', 'settings.json'), 'utf8'));
      expect(tools.system_cleanup).not.toBe(en.aiAgentsPage.catalog.tools.system_cleanup);
      expect(actions.system_cleanup.list).not.toBe(en.aiAgentsPage.catalog.actions.system_cleanup.list);
      expect(actions.system_cleanup.run).not.toBe(en.aiAgentsPage.catalog.actions.system_cleanup.run);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/ai-risk/tierConfig.systemCleanup.test.ts
```

Expected failure: `expected [ … ] to include 'system_cleanup (list)'`.

- [ ] **Step 3: Implement the tierConfig rows** — in `apps/web/src/components/ai-risk/tierConfig.ts`.

Tier 1 list, after the `disk_cleanup (preview)` entry:

```ts
      { name: 'system_cleanup (list)', description: 'List OS-native cleaners and their estimated reclaim', category: 'Files, Disk & Registry' },
```

Tier 3 list, after the `disk_cleanup (execute)` entry:

```ts
      { name: 'system_cleanup (run)', description: 'Run OS-native cleaners (Windows Disk Cleanup/DISM, macOS snapshots/Homebrew, Linux caches/journal)', category: 'Files, Disk & Registry' },
```

`RATE_LIMIT_CONFIGS`, after the `disk_cleanup` row:

```ts
  { toolName: 'system_cleanup', limit: 2, windowSeconds: 3600, tier: 3, permission: 'devices.execute', category: 'Files, Disk & Registry' },
```

`RBAC_MAPPINGS`, after the `disk_cleanup` entry:

```ts
  system_cleanup: { list: 'devices.read', run: 'devices.execute' },
```

- [ ] **Step 4: Implement the approval-history label** — in `apps/web/src/components/ai-risk/ApprovalHistoryFeed.tsx`, add to `TIER3_TOOLS` after `"disk_cleanup",`:

```ts
  "system_cleanup",
```

- [ ] **Step 5: Implement the eight locale catalogs.** Keys are alphabetically sorted in these files and `localeParity.test.ts` requires the same key set everywhere. `system_cleanup` sorts **after** `sync_huntress_data` in `aiAgentsPage.catalog.tools` and **after** `security_scan` in `aiAgentsPage.catalog.actions`.

| Locale | `tools.system_cleanup` | `actions.system_cleanup.list` | `actions.system_cleanup.run` |
|---|---|---|---|
| en | `System cleanup` | `List system cleanup actions` | `Run system cleanup` |
| de-DE | `Systembereinigung` | `Systembereinigungsaktionen auflisten` | `Systembereinigung ausführen` |
| es-419 | `Limpieza del sistema` | `Enumerar acciones de limpieza del sistema` | `Ejecutar limpieza del sistema` |
| fr-CA | `Nettoyage du système` | `Lister les actions de nettoyage du système` | `Exécuter le nettoyage du système` |
| fr-FR | `Nettoyage du système` | `Lister les actions de nettoyage du système` | `Exécuter le nettoyage du système` |
| it-IT | `Pulizia di sistema` | `Elenca le azioni di pulizia di sistema` | `Esegui la pulizia di sistema` |
| pt-BR | `Limpeza do sistema` | `Listar ações de limpeza do sistema` | `Executar limpeza do sistema` |
| tr-TR | `Sistem temizliği` | `Sistem temizleme eylemlerini listele` | `Sistem temizliğini çalıştır` |

The `en` shape, for reference:

```json
        "system_cleanup": {
          "list": "List system cleanup actions",
          "run": "Run system cleanup"
        }
```

- [ ] **Step 6: Run the web suites and watch them pass**

```bash
cd apps/web && npx vitest run \
  src/components/ai-risk/tierConfig.systemCleanup.test.ts \
  src/lib/i18n/translationCoverage.test.ts \
  src/lib/i18n/localeParity.test.ts \
  src/lib/i18n/extractionQuality.test.ts
```

Expected: all green. If `translationCoverage.test.ts` reports a namespace over its `settings.json` duplicate baseline, a translation above is an exact-English duplicate — fix the translation, never the baseline.

- [ ] **Step 7: Run the cross-package parity gate** (§9.3 item 12's named test)

```bash
cd apps/api && npx vitest run src/services/aiGuardrailsTierConfig.parity.test.ts
```

Expected: green. Its "every tool/action pair resolves to the tier tierConfig.ts claims" executes `checkGuardrails('system_cleanup', { action: 'list' | 'run' })` against the real registry, and "every RATE_LIMIT_CONFIGS row claims a tier the tool can actually resolve to" accepts `tier: 3` because `TIER3_ACTIONS.system_cleanup` is non-empty.

- [ ] **Step 8: Typecheck and commit**

```bash
cd apps/web && npx tsc --noEmit
git add apps/web/src/components/ai-risk/tierConfig.ts apps/web/src/components/ai-risk/tierConfig.systemCleanup.test.ts apps/web/src/components/ai-risk/ApprovalHistoryFeed.tsx apps/web/src/locales/*/settings.json
git commit -m "$(cat <<'EOF'
feat(web): show system_cleanup in the AI tier explainer, all 8 locales

tierConfig.ts is what an MSP shows a customer when asked what the AI can do
unattended; the cross-package parity test proves the claimed tiers are real but
cannot notice an absent tool, so presence is pinned here.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Chat transcript labels — shared util and the mobile mirror

**Files:**
- Modify: `packages/shared/src/utils/aiToolLabels.ts:138-142`
- Modify: `packages/shared/src/utils/aiToolLabels.test.ts`
- Modify: `apps/mobile/src/screens/chat/components/toolIndicatorLogic.ts:232-234`
- Modify: `apps/mobile/src/screens/chat/components/toolIndicatorLogic.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `aiToolLabel` falls back to `titleCaseToolName` when the read-only-action override applies to a tool whose own leading verb is unmapped.

- [ ] **Step 1: Write the failing test** — append to `packages/shared/src/utils/aiToolLabels.test.ts`, inside the top-level `describe('aiToolLabel', …)`:

```ts
  it('keeps two different cleanup tools distinguishable in the transcript (#W05)', () => {
    // BEFORE: the read-only-action override forced the `get` conjugation on a
    // tool whose own leading verb is unmapped, so BOTH of these rendered
    // "Checked cleanup" — two different tools, one caption, on a transcript a
    // technician reads to find out what the assistant actually did.
    expect(aiToolLabel('system_cleanup', 'completed', { action: 'list' })).toBe('System cleanup');
    expect(aiToolLabel('disk_cleanup', 'completed', { action: 'preview' })).toBe('Disk cleanup');
    expect(aiToolLabel('system_cleanup', 'running', { action: 'run' })).toBe('System cleanup');
    expect(aiToolLabel('system_cleanup', 'completed')).toBe('System cleanup');
  });

  it('still forces the read-only conjugation for a MAPPED leading verb', () => {
    // The #5170 behaviour is untouched — this fallback only reaches tools whose
    // own leading verb VERB_FORMS does not know, which previously produced a
    // caption built from a verb that had nothing to do with the tool.
    expect(aiToolLabel('manage_automations', 'completed', { action: 'list' })).toBe('Checked automations');
    expect(aiToolLabel('manage_services', 'completed', { action: 'status' })).toBe('Checked services');
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd packages/shared && npx vitest run src/utils/aiToolLabels.test.ts
```

Expected failure: `expected 'Checked cleanup' to be 'System cleanup'`.

- [ ] **Step 3: Implement** — in `packages/shared/src/utils/aiToolLabels.ts`, replace the `forms` line and the guard:

```ts
  const ownForms = VERB_FORMS[verb.toLowerCase()];
  // A read-only `action` forces the `get` conjugation (#5170) — but ONLY for a
  // tool whose leading token is a real verb. `disk_cleanup` / `system_cleanup`
  // lead with a NOUN, so the override used to build the caption from a verb
  // the tool never had and a subject that was half its name: both rendered
  // "Checked cleanup". Fall through to the neutral title-case name instead,
  // which is what an unmapped tool already gets for every other action.
  const forms = isReadOnlyAction(input) && ownForms ? VERB_FORMS.get : ownForms;
  const subject = words.slice(1).join(' ');
  // A bare verb ("get_", "run") has no subject to attach, so "Checked" alone
  // would say nothing — fall through to the neutral name instead.
  if (!forms || !subject) return titleCaseToolName(toolName);
```

- [ ] **Step 4: Mirror it into the mobile copy** — in `apps/mobile/src/screens/chat/components/toolIndicatorLogic.ts`, make the identical edit at `:232-234`, and append the same two `it(...)` cases to `apps/mobile/src/screens/chat/components/toolIndicatorLogic.test.ts` (importing `aiToolLabel` from `./toolIndicatorLogic` rather than from `@breeze/shared` — the mobile app has no `@breeze/shared` dependency by design, Metro/RN bundling).

- [ ] **Step 5: Run both and watch them pass**

```bash
cd packages/shared && npx vitest run src/utils/aiToolLabels.test.ts
cd apps/mobile && npx vitest run src/screens/chat/components/toolIndicatorLogic.test.ts src/screens/chat/historyAdapter.test.ts
```

Expected: both green. `historyAdapter.test.ts` is listed because it renders labels through the same helper.

- [ ] **Step 6: Typecheck and commit**

```bash
cd packages/shared && npx tsc --noEmit
cd apps/mobile && npx tsc --noEmit
git add packages/shared/src/utils/aiToolLabels.ts packages/shared/src/utils/aiToolLabels.test.ts apps/mobile/src/screens/chat/components/toolIndicatorLogic.ts apps/mobile/src/screens/chat/components/toolIndicatorLogic.test.ts
git commit -m "$(cat <<'EOF'
fix(shared): noun-led tools keep their own name in the chat transcript

The read-only-action override forced the `get` conjugation regardless of the
tool's own leading token, so disk_cleanup (preview) and system_cleanup (list)
both rendered "Checked cleanup" — one caption for two different tools on the
transcript a tech reads to find out what happened. Mirrored into apps/mobile.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: The MCP surface, as a contract

**Files:**
- Create: `apps/api/src/services/aiToolsFilesystem.mcpSurface.contract.test.ts` (Test)

**Interfaces:**
- Consumes: `aiTools`, `getToolTier` (`./aiTools`); `TIER3_ACTIONS`, `checkGuardrails` (`./aiGuardrails`).
- Produces: nothing — this task is pure verification of §9.2.

- [ ] **Step 1: Write the test** — create `apps/api/src/services/aiToolsFilesystem.mcpSurface.contract.test.ts`. It is red before Tasks 2–5 and green after them; run it now as the wave's §9.2 acceptance check.

```ts
import { describe, expect, it } from 'vitest';
import { aiTools, getToolTier } from './aiTools';
import { TIER3_ACTIONS, checkGuardrails } from './aiGuardrails';

/**
 * Disk Cleanup v2 W05, spec §9.2 — the MCP contract for the three disk tools,
 * pinned where it can actually be asserted.
 *
 * `isToolWhollyGatedOverMcp` and `gatedActionsForTool` are module-private to
 * routes/mcpServer.ts, and `mcpServer.*.test.ts` mocks the tool registry — so
 * only here, against the REAL definitions, can the inputs those two functions
 * consume be compared with TIER3_ACTIONS. Same technique as
 * aiAgentSdkTools.mcpCoverage.test.ts's "manage_organizations is wholly gated
 * over MCP" block, and the same reason: the behaviour is asserted through the
 * real listing path there, the DATA behind it only here.
 *
 * NOTE: no vi.mock — this suite needs the REAL aiTools registry.
 */

function advertisedActions(tool: string): string[] | undefined {
  return (
    aiTools.get(tool)!.definition.input_schema.properties as { action?: { enum?: string[] } }
  ).action?.enum;
}

/** The exact predicate routes/mcpServer.ts:1014-1032 applies. */
function whollyGatedOverMcp(tool: string): boolean {
  const baseTier = getToolTier(tool);
  if (baseTier === undefined) return false;
  if (baseTier >= 3) return true;
  const actions = advertisedActions(tool);
  if (!actions || actions.length === 0) return false;
  const tier3 = TIER3_ACTIONS[tool];
  if (!tier3 || tier3.length === 0) return false;
  return actions.every((action) => tier3.includes(action));
}

describe('§9.2 — the disk tools over MCP', () => {
  it('Tier 3 actions are a HARD DENY over MCP, not an approval flow', () => {
    // tools/call computes max(baseTier, guardrailTier) and answers
    // MCP_APPROVAL_REQUIRED before the scope gates, the production allowlist,
    // RBAC, the rate limit, the execution org and the ledger
    // (mcpServer.ts:1312-1320). So these two are unreachable over MCP by
    // construction — an MCP client diagnoses and hands the destructive step to
    // a tech in the web app.
    expect(Math.max(getToolTier('disk_cleanup')!, checkGuardrails('disk_cleanup', { action: 'execute' }).tier)).toBe(3);
    expect(Math.max(getToolTier('system_cleanup')!, checkGuardrails('system_cleanup', { action: 'run' }).tier)).toBe(3);
  });

  it('their read-only actions stay reachable over MCP', () => {
    expect(Math.max(getToolTier('disk_cleanup')!, checkGuardrails('disk_cleanup', { action: 'preview' }).tier)).toBe(1);
    expect(Math.max(getToolTier('system_cleanup')!, checkGuardrails('system_cleanup', { action: 'list' }).tier)).toBe(1);
    expect(Math.max(getToolTier('analyze_disk_usage')!, checkGuardrails('analyze_disk_usage', {}).tier)).toBe(1);
  });

  it('both stay LISTED — they are mixed multiplexers, not wholly gated tools', () => {
    // A wholly-gated tool is suppressed from tools/list (the
    // advertised-but-dead pattern). These two must NOT be suppressed, or MCP
    // clients lose read-only disk diagnosis entirely.
    expect(advertisedActions('disk_cleanup')).toEqual(['preview', 'execute']);
    expect(advertisedActions('system_cleanup')).toEqual(['list', 'run']);
    expect(whollyGatedOverMcp('disk_cleanup')).toBe(false);
    expect(whollyGatedOverMcp('system_cleanup')).toBe(false);
    // analyze_disk_usage is not action-multiplexed at all, so it is never
    // gated and its listed description gains no note.
    expect(advertisedActions('analyze_disk_usage')).toBeUndefined();
    expect(whollyGatedOverMcp('analyze_disk_usage')).toBe(false);
  });

  it('only the destructive action carries the tools/list approval note', () => {
    expect(TIER3_ACTIONS.disk_cleanup).toEqual(['execute']);
    expect(TIER3_ACTIONS.system_cleanup).toEqual(['run']);
  });

  it('device-scoped org resolution is declared, so the ledger attributes to the DEVICE’s org', () => {
    // Amendment B1: omitting deviceArgs does NOT error — resolveMcpExecutionContext
    // falls through to the caller's first accessible org, which silently
    // misattributes the tool-execution ledger and the audit row. All three
    // declare it.
    for (const tool of ['analyze_disk_usage', 'disk_cleanup', 'system_cleanup']) {
      expect(aiTools.get(tool)!.deviceArgs, `${tool} must declare its device arg`).toEqual(['deviceId']);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it pass**

```bash
cd apps/api && npx vitest run \
  src/services/aiToolsFilesystem.mcpSurface.contract.test.ts \
  src/routes/mcpServer.approvalGate.test.ts
```

Expected: both green. `mcpServer.approvalGate.test.ts` asserts the same contract through the real listing and call paths (with a mocked registry) and is listed so the two halves are run together.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/aiToolsFilesystem.mcpSurface.contract.test.ts
git commit -m "$(cat <<'EOF'
test(ai): pin the MCP contract for the three disk tools

Tier 3 is a hard deny over MCP (denied before scope, RBAC, rate limit and
ledger), both cleanup tools stay listed because they are mixed multiplexers,
and all three declare deviceArgs — without which the execution org silently
falls back to the caller's first accessible org instead of the device's.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Docs — `ai.mdx`, `mcp-server.mdx`, `playbooks.mdx`

**Files:**
- Modify: `apps/docs/src/content/docs/features/ai.mdx` — the Tier 1 row (`:35`), the Tier 3 row (`:37`), the action-level Aside (`:41`), the rate-limit table (after `:127`)
- Modify: `apps/docs/src/content/docs/features/mcp-server.mdx` — "File and disk tools" (`:229-235`), the scope list (`:366-369`), the per-tool rate-limit table (after `:418`)
- ~~`apps/docs/src/content/docs/agents/commands.mdx`~~ — **not edited in this wave**; W04 Task 16 owns both command types on that page (alignment A3). Step 4 only verifies it.
- Modify: `apps/docs/src/content/docs/features/playbooks.mdx` — the Disk Cleanup built-in (`:117-134`)
- Test: `apps/api/src/services/aiGuardrailsAiDocs.parity.test.ts` (existing — it goes red on a wrong tier claim OR an unparseable row)

**Interfaces:**
- Consumes: the final tier tables from Task 4 and the final rate limits from Task 4 (the docs parity test executes `checkGuardrails` against them, so this task cannot precede Task 4).
- Produces: documentation only. No code.

- [ ] **Step 1: Prove the guard is live before editing.** `aiGuardrailsAiDocs.parity.test.ts` recognises exactly two table shapes by header (`| Tier | Execution | Examples |` and `| Tool | Tier | Description |`), requires EVERY body row of a recognised table to parse, and reports any other "Tier"-headed table as unrecognised. Its label grammar is `` `tool` `` or `` `tool` (action/action) `` using **real guardrail action identifiers** — prose in the parentheses fails the suite.

```bash
cd apps/api && npx vitest run src/services/aiGuardrailsAiDocs.parity.test.ts
```

Expected: green (the page is consistent with the tables today). Note this baseline — any failure after the edits below is caused by the edits.

- [ ] **Step 2: Edit `features/ai.mdx`.**

In the Tier 1 examples cell (`:35`), after `` `disk_cleanup` (preview) ``, insert `` `system_cleanup` (list) ``.

In the Tier 3 examples cell (`:37`), after `` `disk_cleanup` (execute) ``, insert `` `system_cleanup` (run) ``.

In the Aside at `:41`, after the sentence "For example, `disk_cleanup` is Tier 1 when previewing and Tier 3 when executing", add:

```
`system_cleanup` follows the same split — listing the OS-native cleaners a device offers is Tier 1, running them is Tier 3.
```

In the rate-limit table, after the `disk_cleanup` row:

```
| `system_cleanup` | 2 requests | 60 min |
```

- [ ] **Step 3: Edit `features/mcp-server.mdx`.**

Replace the "File and disk tools" table body (`:232-235`) with:

```
| `file_operations` | 2/3 | List directory contents (Tier 2, auto-execute + audit). Read, write, delete, mkdir, rename (Tier 3 — reading file contents requires approval because the agent reads as root/LocalSystem). |
| `analyze_disk_usage` | 1 | Filesystem analysis with cleanup candidate detection, for any fixed volume on the device (`path`). Can trigger fresh scans on online devices. |
| `disk_cleanup` | 1/3 | Preview cleanup candidates for a volume (Tier 1). Execute cleanup by deleting selected paths from a previewed run (Tier 3). |
| `system_cleanup` | 1/3 | List the OS-native maintenance cleaners a device offers — Windows Disk Cleanup handlers and DISM component cleanup, macOS local snapshots and Homebrew, Linux package caches and journal — with an "up to" reclaim estimate (Tier 1). Run the selected actions (Tier 3). |
```

and add immediately after that table:

```
<Aside type="caution">
  **Tier 3 actions cannot be executed over MCP at all.** This transport has no interactive approval surface, so `tools/call` answers a Tier 3 action with a structured `MCP_APPROVAL_REQUIRED` error *before* it checks scopes, RBAC, rate limits or the production allowlist — holding `ai:execute` does not change the outcome. `disk_cleanup` and `system_cleanup` stay listed because their read-only actions still work; `tools/list` appends a note to each one's description:

  `(Actions "run" require interactive approval and are not available over MCP — use the Breeze web app AI assistant for those.)`

  A tool whose *every* action is Tier 3 is not listed at all, because advertising a tool that can only ever answer with a refusal is worse than omitting it. The practical contract for an MCP client is therefore: `analyze_disk_usage`, `disk_cleanup` preview and `system_cleanup` list give you a complete read-only diagnosis, and you hand the destructive step to a technician in the Breeze web app AI assistant, where it goes through the approval workflow.
</Aside>
```

Replace items 3 and 4 of the scope list (`:368-369`) with (amendment B14):

```
3. **Tier 3+** tools are included only when *some* action of them is below Tier 3 and the key has `ai:execute`; a wholly Tier 3 tool is never listed.
4. A Tier 3 **action** is refused over MCP regardless of scope — see the caution above. `MCP_REQUIRE_EXECUTE_ADMIN` and `MCP_EXECUTE_TOOL_ALLOWLIST` therefore only affect which *tools* a key may see and reach, never whether a Tier 3 action executes.
```

In the per-tool rate-limit table, after the `disk_cleanup` row:

```
| `system_cleanup` | 2 | 60 min |
```

- [ ] **Step 4: Verify `agents/commands.mdx` — do NOT re-add the two command types.** **W04 Task 16 Step 1/2 owns this page** (alignment A3): it adds the two File Operations rows *and* the `### system_cleanup_list` / `### system_cleanup_run` subsections, with the closed-catalog and upper-bound Asides and the "requires agent 0.115.0" line. W04's version is the complete one; writing a second copy here would produce duplicate headings, which `docsIndex.json` records verbatim. Verify and move on:

```bash
grep -c 'system_cleanup_run' apps/docs/src/content/docs/agents/commands.mdx
```

Expected: `≥ 3` (the table row plus the subsection heading plus its body). If it is `0`, W04 has not merged — stop and rebase rather than authoring the sections here.

- [ ] **Step 5: Edit `features/playbooks.mdx`.** Replace the numbered step list of the Disk Cleanup built-in (`:126-134`) with:

```
1. **Capture baseline disk usage** -- Runs the `analyze_disk_usage` tool to collect current disk utilization and identify cleanup candidates.

2. **Preview safe cleanup candidates** -- Runs `disk_cleanup` in preview mode against safe categories: temporary files, browser cache, package cache, and trash. No files are deleted in this step. The preview returns a `cleanupRunId`, which the executor carries into the next step.

3. **Execute cleanup** -- Runs `disk_cleanup` in execute mode, pinned to the `cleanupRunId` from step 2. Only paths inside that previewed run are deleted; anything else in the request is reported as rejected rather than removed.

4. **Wait for filesystem metrics** -- Pauses for 30 seconds to allow disk metrics to refresh.

5. **Verify disk usage improved** -- Runs `analyze_disk_usage` again and checks that `disk_usage_percent` is below 90%. If verification fails, execution stops.

6. **Report available OS-native cleaners** -- Runs `system_cleanup` in list mode. This step is **reporting only**: it shows what Windows Disk Cleanup, DISM, Homebrew, the package caches or the journal could still reclaim, and never runs any of them. Running a native cleaner is always a separate, explicitly approved action.
```

- [ ] **Step 6: Run the docs guard and the docs build**

```bash
cd apps/api && npx vitest run src/services/aiGuardrailsAiDocs.parity.test.ts
```

Expected: green. If "every row of every recognised tier table is machine-checkable" fails, a label above is not in the `` `tool` (action/action) `` grammar — fix the label, never the test. If "every documented tool/action pair resolves to the tier the docs claim" fails, the page and `aiGuardrails.ts` disagree; the tables are the source of truth.

```bash
cd apps/docs && npx astro check && npx astro build
```

Expected: no errors. (This is what CI's `docs-check` job runs.)

- [ ] **Step 7: Commit**

```bash
git add apps/docs/src/content/docs/features/ai.mdx apps/docs/src/content/docs/features/mcp-server.mdx apps/docs/src/content/docs/features/playbooks.mdx
git commit -m "$(cat <<'EOF'
docs: system_cleanup tiers and limits; the Tier 3 MCP hard-deny contract

ai.mdx's tier and rate tables are test-enforced against aiGuardrails.ts, so
these rows are checked, not asserted. mcp-server.mdx gains the File-and-disk
row plus the hard-deny caution, and its scope list no longer describes the
pre-2026-08-02 model in which a Tier 3 tool executed on ai:execute alone.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: `features/filesystem-analysis.mdx` — the finished-feature rewrite, and the docs index

**Files:**
- Modify: `apps/docs/src/content/docs/features/filesystem-analysis.mdx` (whole file, 564 lines today)
- Modify: `apps/api/src/data/docsIndex.json` (regenerated, never hand-edited)

**Interfaces:**
- Consumes: the W02 data model (§4), the W02/W03 API (§5.1, §5.2), the W03 tab (§8), the W04 catalog (§7.2), and this wave's AI tools (§9.1).
- Produces: documentation only. `docsIndex.json` is what `search_documentation` reads (`services/aiToolsDocs.ts:8`), and it stores each page's `title`, `description` and every `##`/`###` heading — so a rewrite that changes headings and does not regenerate the index leaves the AI answering disk-cleanup questions out of a stale outline.

- [ ] **Step 1: Rewrite the page.** Keep the frontmatter `title` (`Filesystem Analysis & Disk Cleanup`) and update `description` to name volumes and native cleaners. Target outline — every `##`/`###` below lands in the docs index, so they are the page's real search surface:

| Heading | Content that must be there |
|---|---|
| `## Overview` | analysis → cleanup → native cleaners, and the one-home rule: everything happens in the device's **Disk Cleanup** tab (`/devices/:id#filesystem`); the File Manager's old inline cleanup section is gone and its button links here. |
| `## Volumes` | `GET /devices/:id/filesystem/volumes`; a `Volume` is `{ mountPoint, scanPath, fsType, totalGb, usedGb, freeGb, usedPercent, scanState, latestSnapshot, isOsRoot }`; only fixed local volumes are scannable (`NON_SCANNABLE_FS_TYPES` — `cdfs, udf, iso9660, squashfs, tmpfs, devtmpfs, overlay, nfs, nfs4, cifs, smbfs, fuse*, 9p, autofs, proc, sysfs` — and UNC paths are excluded); the OS root is always listed; selecting a volume chip re-keys every panel below it. |
| `### Scan paths are normalised` | Windows: upper-case drive letter, backslashes, a trailing `\` only on a volume root; POSIX: `path.posix.normalize`, no trailing `/` except `/`. The stored `scan_path` and the value sent to the agent are always the normalised form, which is why `c:\` and `C:\` are the same volume and resume the same checkpoint. |
| `## Deep Filesystem Scan` | Keep `baseline` / `incremental` / `auto`; state that scan state is now keyed by **(device, scan path)**, so scanning `D:\` no longer resets the `C:\` baseline, pollutes its hot directories, or becomes the snapshot a `C:\` preview deletes from. |
| `### Resumable state` | Update the table: the primary key is `(deviceId, scanPath)`; `scanPath` is a new column. |
| `### Scan configuration` | Unchanged fields; add that `path` is normalised server-side and that "root-scoped" now means "the normalised path is a volume scan path", not a `C:\` string compare. |
| `## Filesystem Snapshots` | Add the `scanPath` column to the contents table; state that "latest snapshot" is always **per scan path**. |
| `## Disk Cleanup` | The finished flow: select → confirm → execute → result, inside the tab. |
| `### What gets cleaned` | Replace the old four-category prose with the rooted rule table's shape: rules match **path components from the volume root**, never substrings, so a directory merely *named* `tmp` or `Caches` is not in scope; per-category patterns, exclusions and the 24-hour minimum age on temp files; the cleanup-denied roots (`windows/system32`, `winsxs`, `program files`, `/system`, `/usr`, `/bin`, `/sbin`, `/etc`, `/private/var/db`, `/library/apple`). Name the negatives explicitly: Chrome/Firefox `Bookmarks`, `History`, `Cookies`, `Login Data` and `places.sqlite` are never candidates. |
| `### Preview` | `POST /filesystem/cleanup-preview { path?, categories? }` pins both `snapshotId` and `scanPath` into the run's plan and returns a `cleanupRunId`. |
| `### Execute` | `POST /filesystem/cleanup-execute { cleanupRunId, paths }` — `cleanupRunId` is **required**; paths outside the pinned plan come back in `rejectedPaths` and are never dispatched; per-path `status` is `completed | failed | skipped_locked | rejected | skipped_budget`; the 4-minute overall budget; deletion is **permanent** (no trash move — that is what makes the bytes actually free), symlinks and reparse points are refused, locked files are `skipped_locked` and never forced, and recycle-bin/trash candidates delete their *contents*, keeping the directory and `desktop.ini`. |
| `### Run history` | `GET /filesystem/cleanup-runs` (paginated, both kinds) and `GET /filesystem/cleanup-runs/:runId`; retention — `previewed` runs are deleted after 7 days and `plan.candidates` is trimmed from finished runs after 90 days, while the summary and executed actions stay. |
| `## OS-Native Cleaners` | New top-level section: why they exist (they reclaim space the file scanner structurally cannot see), the two-step list → run flow, the `409 agent_update_required` response and its minimum agent version, that estimates are labelled "up to", that `freedBytes` is measured from the free-space delta, and that `Update Cleanup` releases its space only after a reboot. |
| `### Catalog` | The §7.2 table: `win_cleanmgr`, `win_dism_component_cleanup`, `mac_tm_local_snapshots`, `mac_brew_cleanup`, `linux_pkg_cache_clean`, `linux_pkg_autoremove`, `linux_journal_vacuum` — what each runs and its timeout. |
| `### Risk flags` | **Enumerate every flag and what it means for the customer**, not just the flag name: `long_running`, `may_require_reboot`, `may_require_reboot_free_state`, `removes_packages`, `removes_driver_rollback`, **`removes_os_rollback`** (Previous Installations deletes `Windows.old`, which IS the path back to the prior Windows build — irreversible) and **`removes_recovery_points`** (a cleaner that discards restore points or local snapshots leaves no in-place rollback). State which confirmation each one forces in the UI: `removes_packages`, `removes_os_rollback` and `removes_recovery_points` require the destructive dialog's second checkbox. |
| `### What is deliberately excluded` | `/ResetBase`, `DownloadsFolder`, `Windows ESD installation files`, `Language Pack`, every per-user cleanmgr handler, Docker prune, Storage Sense and `snap` revision pruning — excluded **in code, not configuration**. |
| `## AI Integration` | Three tools. `analyze_disk_usage` (Tier 1) gains `path`. `disk_cleanup` (Tier 1 preview / Tier 3 execute) gains `path` and a **required** `cleanupRunId` on execute. `system_cleanup` (Tier 1 list / Tier 3 run) is new, rate-limited 2 per hour, and requires `actionIds` from the shared allowlist. State the MCP contract in one line and link to `/features/mcp-server/`: Tier 3 actions are refused over MCP, so an MCP client diagnoses and a technician executes. |
| `## Database Schema` | Update all three tables: snapshots gain `scan_path` (NOT NULL) and an index on `(device_id, scan_path, captured_at DESC)`; scan state's primary key is `(device_id, scan_path)`; cleanup runs gain `scan_path` (nullable — system runs are not path-scoped), `kind` (`files` \| `system`), `command_id`, and the `running` status. |
| `### Preview expiry and the pinned run` | **State explicitly:** a preview **expires after 24 hours** — an `execute` against an older run is refused and the tech previews again; and an `execute` deletes the **current contents** of a recycle bin or trash directory at the moment it runs, not the contents the preview enumerated, because a bin is live and a preview is a point-in-time read. Both are properties a tech has to know before approving. |
| `### Agent version requirements` | **State explicitly:** permanent cleanup (the `permanent` + `cleanupGuard` payload that makes the bytes actually free) requires an agent at **`MIN_AGENT_VERSION_CLEANUP_GUARD`** or newer; below that, an older agent silently moves files to its own trash directory instead and the result panel shows the agent version next to the outcome. The OS-native cleaners require `MIN_AGENT_VERSION_SYSTEM_CLEANUP` and return `409 agent_update_required` below it. Give both literals, read from the code. |
| `### How to read an estimate` | **State explicitly:** every reclaim figure — the file engine's candidate totals and every native-cleaner estimate — is **heuristic and an upper bound, labelled "up to"**. Name the three reasons: DISM's component-store figures exceed what `StartComponentCleanup` releases (30-day grace, last backup retained), `journalctl --vacuum-size` only removes archived journals, and Time Machine thinning is opportunistic. Contrast with `freedBytes`, which is *measured* from the free-space delta. |
| `## Troubleshooting` | Keep the existing entries, and add: "Cleanup reported success but no space was freed" (pre-fix agents moved files to `~/.breeze-trash`; check the agent version shown next to the result), "Execute returns *No previewed cleanup run with that id*" (the run was consumed, expired or belongs to another device — preview again), and "A native cleaner reports `unavailable`" (the binary is absent, e.g. `cleanmgr.exe` on Server Core, or the unit's sandbox denies writes to the cache path). |

Remove the stale `### "No valid cleanup paths selected from latest previewable candidates" (400)` entry — that error string no longer exists after W03/W05 — and replace it with the pinned-run entry above.

- [ ] **Step 2: Regenerate the docs index**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-green-meadow-232b && pnpm exec tsx scripts/build-docs-index.ts
git diff --stat apps/api/src/data/docsIndex.json
```

Expected: `docsIndex.json` changes. Confirm the new headings are present and that no page vanished:

```bash
python3 -c "
import json
rows = json.load(open('apps/api/src/data/docsIndex.json'))
by_path = {r['path']: r for r in rows}
page = by_path['/features/filesystem-analysis/']
print(page['title']); print(page['description'])
for h in page['headings']: print(' -', h)
print('total pages:', len(rows))
"
```

Expected: `OS-Native Cleaners`, `Volumes` and `Catalog` appear among the headings, and `total pages` is unchanged from before the run (the rewrite adds no page).

- [ ] **Step 3: Build the docs**

```bash
cd apps/docs && npx astro check && npx astro build
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/docs/src/content/docs/features/filesystem-analysis.mdx apps/api/src/data/docsIndex.json
git commit -m "$(cat <<'EOF'
docs: rewrite Filesystem Analysis & Disk Cleanup for the finished feature

Multi-volume scanning and the per-volume scan state, the finished tab, the
rooted rule table (components from the volume root, never substrings), the
required cleanupRunId and rejectedPaths, the OS-native cleaner catalog and what
it deliberately excludes, the three AI tools and the MCP contract, and the new
columns on all three tables. docsIndex.json regenerated so
search_documentation answers from the new outline.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Release notes

**Files:**
- Modify: `docs/release-notes/next-release-draft.md` — the "Self-Hosting / Upgrade Notes" section

**Interfaces:**
- Consumes: the W02 rolling-deploy note (spec §4), the W04 agent gate, this wave's tool surface.
- Produces: one entry `/release` Step 1 folds into the GitHub Release body.

- [ ] **Step 1: Add the entry.** Append to the "Self-Hosting / Upgrade Notes" list in `docs/release-notes/next-release-draft.md`:

```markdown
- **Disk Cleanup v2 — cleanup now actually frees space, and scans any fixed volume.** Cleanup deletes permanently instead of moving files into the agent's own trash directory on the same volume, so reclaimed bytes are real; on Windows the per-volume `$Recycle.Bin` is reached one level down (the volume root itself stays undeletable). Scanning and cleanup are now per volume: scan state, snapshots and cleanup runs are keyed by `(device, scan path)`, so scanning `D:\` no longer resets the `C:\` baseline or becomes the snapshot a `C:\` cleanup deletes from. Executing a cleanup requires the `cleanupRunId` returned by its preview — anything outside that pinned plan is reported as rejected and never deleted. New OS-native cleaners (Windows Disk Cleanup handlers and DISM component cleanup, macOS local snapshots and Homebrew, Linux package caches and journal) are available from the same tab and from the new `system_cleanup` AI tool; they need an agent at **vX.Y.Z** or newer and return `409 agent_update_required` below that. The AI tool surface is `analyze_disk_usage` (Tier 1, now takes a `path`), `disk_cleanup` (Tier 1 preview / Tier 3 execute, now takes a `path` and requires `cleanupRunId`) and `system_cleanup` (Tier 1 list / Tier 3 run, 2 runs per hour). Over MCP the Tier 3 actions are refused — read-only diagnosis works, the destructive step goes to a technician in the web app.
- **Rolling deploys: one brief window where a filesystem scan cannot save its scan state.** The Disk Cleanup v2 migration changes `device_filesystem_scan_state`'s primary key from `(device_id)` to `(device_id, scan_path)`. Hosted Breeze replaces the single API container, so old and new API code never run against the new schema at once. On a **multi-replica self-host**, any old replica still draining after the migration applies will fail its scan-state upsert with `42P10` (the snapshot insert itself still succeeds); re-running the scan once every replica is on the new build repairs the state. Single-replica self-hosts are unaffected.
```

- [ ] **Step 2: Fill in the agent version.** Replace `vX.Y.Z` with the value of `MIN_AGENT_VERSION_SYSTEM_CLEANUP`:

```bash
git grep -n "MIN_AGENT_VERSION_SYSTEM_CLEANUP" apps/api/src/services/systemCleanup.ts
```

Use the literal that grep prints. Leaving `vX.Y.Z` in the file is a failure of this step, not a placeholder the release process resolves.

- [ ] **Step 3: Commit**

```bash
git add docs/release-notes/next-release-draft.md
git commit -m "$(cat <<'EOF'
docs(release): Disk Cleanup v2 notes, including the scan-state rolling window

Covers what operators will notice (space is actually freed, scanning is per
volume, execute is pinned to its preview, native cleaners need a newer agent)
and the one self-host-only upgrade hazard: a multi-replica deploy has a window
where a draining old replica fails its scan-state upsert with 42P10.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Lab proof on two real rigs — the acceptance gate for W04

**Files:** none. This task produces a comment on the **W05 sub-issue** (`#<subissue#>`), which is where the spec (§11) says the results are recorded.

**Interfaces:**
- Consumes: the W04 agent build, the W03/W04 Disk Cleanup tab, `POST /devices/:id/filesystem/system-cleanup/{list,run}`.
- Produces: a PASS/FAIL record with measured numbers. Nothing in CI can produce this: `cleanmgr` under the SYSTEM account in session 0 renders a hidden progress UI and is known to return before its work finishes or to hang (spec §7.2), and no unit test executes a real cleaner. This is why W04's acceptance criterion is a lab run.

**Rigs (non-prod; never touch WIN-DHQNR1F8LO2 or the US Ubuntu KVM rig, both prod-enrolled):**
- **Windows:** `WIN-IMDR2GAIDMV`, `ssh administrator@100.101.28.70` (PowerShell shell, key auth), enrolled to the Mac lab stack over Tailscale.
- **Linux:** KIT `lab-ubuntu-src`, `ssh -o StrictHostKeyChecking=no -J breeze-svc@kit-1 breeze@192.168.10.240` (passwordless sudo; the Mac has no route to KIT's `192.168.10.0/24`, always ProxyJump), enrolled to the Mac lab stack at `http://192.168.0.60:3000`.

- [ ] **Step 1: Put this branch's API and the W04 agent on both rigs.**

Bring the lab stack up on this branch and note the two device ids:

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-green-meadow-232b && pnpm wt-stack up
```

Then push the branch's agent to each rig (amendment B12: the `dev-<epoch>` version is unparseable, so `compareAgentVersions` returns `0` and the `MIN_AGENT_VERSION_SYSTEM_CLEANUP` gate lets it through — this is what makes a dev build testable):

```bash
cd agent && make dev-push DEVICE=<WIN-IMDR2GAIDMV device uuid> AUTH_TOKEN=$BREEZE_API_KEY
cd agent && make dev-push DEVICE=<lab-ubuntu-src device uuid> AUTH_TOKEN=$BREEZE_API_KEY
```

Confirm each agent restarted on the new build:

```bash
ssh administrator@100.101.28.70 'Get-Service breeze-agent | Select-Object Status; (Get-Item "C:\Program Files\Breeze\breeze-agent.exe").LastWriteTime'
ssh -o StrictHostKeyChecking=no -J breeze-svc@kit-1 breeze@192.168.10.240 'systemctl is-active breeze-agent && breeze-agent --version'
```

- [ ] **Step 2: R1 — Windows, multi-volume scan and per-volume bin.** In the browser, open `/devices/<win-device-id>#filesystem`.

1. The **Volume chips** row shows `C:\` with an **OS** badge and at least one second fixed volume. If the rig has only `C:`, attach a second VHD and format it before continuing — a single-volume run does not test the defect this wave fixes.
2. Before scanning, plant a recycle-bin fixture from the rig so the trash candidate is non-trivial:

```powershell
ssh administrator@100.101.28.70 'fsutil file createnew D:\junkfile.bin 536870912; Remove-Item D:\junkfile.bin'
ssh administrator@100.101.28.70 'Get-ChildItem "D:\$Recycle.Bin" -Force -Recurse | Measure-Object -Property Length -Sum'
```

3. Select `C:\`, click **Analyze**, wait for the snapshot. Then select the second volume and **Analyze** again.
4. Re-select `C:\`.

**Acceptance R1:** the `C:\` panels show the `C:\` snapshot, not the second volume's — its scan age, byte totals and candidate list are the ones captured in step 3's first scan. This is defect 6; before this feature the second scan clobbered the first.

- [ ] **Step 3: R2 — Windows, cleanup actually frees space.** Still on the second volume:

1. Note free space before:

```powershell
ssh administrator@100.101.28.70 'Get-PSDrive D | Select-Object Used,Free'
```

2. In the **Cleanup panel**, tick the `trash` category (the `$Recycle.Bin\S-…` candidate planted in R1), click **Execute**, and confirm in the destructive dialog.
3. Note free space after, and confirm nothing was relocated onto `C:`:

```powershell
ssh administrator@100.101.28.70 'Get-PSDrive C,D | Select-Object Name,Used,Free; Test-Path "$env:USERPROFILE\.breeze-trash"'
```

**Acceptance R2:** `D:` free space increases by approximately the reported `bytesReclaimed`; `C:` free space does **not** decrease; `~\.breeze-trash` either does not exist or is unchanged. Also confirm `D:\$Recycle.Bin` itself and its `desktop.ini` still exist — only the contents went (spec §6.3). This is defect 1 plus defect 2.

- [ ] **Step 4: R3 — Windows, native cleaners in session 0.** This is the gate the spec singles out.

1. In the **System cleanup panel**, click **Check available actions**. The catalog must list `win_cleanmgr` (with handler sub-actions) and `win_dism_component_cleanup`. Record each action's estimate and `estimateKnown`.
2. Select `Update Cleanup` under `win_cleanmgr`, plus `win_dism_component_cleanup`. Click **Run**, confirm, and leave the tab open.
3. While it runs, watch the process tree from the rig:

```powershell
ssh administrator@100.101.28.70 'while ($true) { Get-Process cleanmgr,dismhost,TiWorker -ErrorAction SilentlyContinue | Select-Object Name,Id,StartTime; Start-Sleep 30 }'
```

**Acceptance R3(a):** the run reaches a terminal state on its own — every `cleanmgr`/`dismhost`/`TiWorker` process exits and the panel moves off "running" — within the 60- and 90-minute caps, with no operator intervention. A hang, or a result that arrives while `cleanmgr` is still in the process list, is a **FAIL** and blocks the agent release.

4. Reboot the rig, wait for the agent to reconnect, then read the measured delta:

```powershell
ssh administrator@100.101.28.70 'Restart-Computer -Force'
# after it returns:
ssh administrator@100.101.28.70 'Get-PSDrive C | Select-Object Used,Free'
```

**Acceptance R3(b):** free space on `C:` after the reboot is greater than before the run. `Update Cleanup` releases its space at restart, so a zero delta *before* the reboot is expected and is not a failure; a zero delta *after* it is.

- [ ] **Step 5: R4 — Linux cleaners and estimate fidelity.** On `lab-ubuntu-src`, open `/devices/<linux-device-id>#filesystem`.

1. Prime a cache so the run has something to reclaim, and capture the simulated numbers the estimator parses:

```bash
ssh -o StrictHostKeyChecking=no -J breeze-svc@kit-1 breeze@192.168.10.240 \
  'sudo apt-get -y install --reinstall --download-only vim >/dev/null 2>&1; du -sb /var/cache/apt/archives; LC_ALL=C sudo apt-get -s autoremove | tail -3; LC_ALL=C journalctl --disk-usage'
```

2. In the **System cleanup panel**, **Check available actions** and compare: `linux_pkg_cache_clean`'s estimate against `du -sb /var/cache/apt/archives`, `linux_pkg_autoremove`'s against the "After this operation, X will be freed" line, `linux_journal_vacuum`'s against `journalctl --disk-usage` minus the 256 MiB default target.
3. Select `linux_pkg_cache_clean` and `linux_journal_vacuum` and **Run**.

**Acceptance R4:** every estimate matches the simulated output within rounding; the run's measured `freedBytes` is non-zero; and `du -sb /var/cache/apt/archives` after the run is near zero while `/var/cache/apt/archives/lock` still exists (spec §6.1 exclusion).

- [ ] **Step 6: R5 — the AI lane reaches the same code.** In the Breeze AI chat, against the Linux rig, ask:

> List the OS-native cleanup actions available on lab-ubuntu-src and tell me how much each could reclaim.

**Acceptance R5:** the assistant calls `system_cleanup` with `action: 'list'`, it auto-executes (Tier 1, no approval card), and the numbers match R4's catalog. Then ask it to run `linux_pkg_cache_clean`:

**Acceptance R5(b):** an approval card appears (Tier 3, supervised — the tech approves it themselves), and after approval the chat reports measured freed bytes. Confirm the audit trail carries both surfaces:

```bash
psql "$DATABASE_URL" -c "select action, actor_type, details->>'surface', details->>'cleanupRunId' from audit_logs where action like 'device.filesystem.%' order by created_at desc limit 5;"
```

Expected: a `device.filesystem.system_cleanup.run` row with `surface = ai_tool`.

- [ ] **Step 6a: R7 — a non-allowlisted cleanmgr handler is zeroed, not executed.** The closed-catalog rule (spec §10 item 7) says `win_cleanmgr` sets `StateFlags5555 = 2` for the selected handlers **and `0` for every other allowlisted handler**. What no test covers is a handler that is not in the allowlist at all but already carries a stale `StateFlags5555 = 2` on the box — `cleanmgr /sagerun:5555` runs *every* handler whose flag is set, so a stale value is a way for an excluded handler to execute anyway.

Pre-set one of the deliberately-excluded handlers before the run:

```powershell
ssh administrator@100.101.28.70 'New-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\VolumeCaches\DownloadsFolder" -Name StateFlags5555 -Value 2 -PropertyType DWord -Force; New-Item -ItemType File -Path "$env:USERPROFILE\Downloads\canary-do-not-delete.bin" -Force; fsutil file createnew "$env:USERPROFILE\Downloads\canary-do-not-delete.bin" 10485760'
```

Run `win_cleanmgr` with `Update Cleanup` selected (as in R3), then read the flag and the canary back:

```powershell
ssh administrator@100.101.28.70 '(Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\VolumeCaches\DownloadsFolder").StateFlags5555; Test-Path "$env:USERPROFILE\Downloads\canary-do-not-delete.bin"'
```

**Acceptance R7:** `StateFlags5555` reads `0` and the canary file still exists. A `2` (or a deleted canary) means the runner writes flags only for the handlers it selected and leaves every other key as it found it — which lets an excluded handler run on any box with stale flags, and is a **FAIL** that blocks the agent release. Clean up the key afterwards with `Remove-ItemProperty … -Name StateFlags5555`.

- [ ] **Step 6b: R8 — a concurrent second run is refused, not interleaved.** `cleanmgr` and DISM must not overlap (spec §7.3), and the actions of a single run are sequential — but nothing stops a second `system_cleanup_run` being queued while the first is still executing unless the route refuses it.

While the R3 run is still in its "running" state, fire a second one from a shell:

```bash
curl -sS -o /tmp/second-run.json -w '%{http_code}\n' \
  -X POST "$BREEZE_URL/api/v1/devices/<win-device-id>/filesystem/system-cleanup/run" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"actionIds":["win_dism_component_cleanup"]}'
cat /tmp/second-run.json
```

**Acceptance R8:** HTTP **409** with body `{"error":"run_in_progress"}` (or the same shape the W04 route defines — record the literal), the first run is unaffected, and `select id, status from device_filesystem_cleanup_runs where device_id = … order by requested_at desc limit 2;` shows exactly ONE row in `running`. A `202` here means two native cleaners can be in flight on one device, which is the overlap the sequential design exists to prevent. Repeat the same call from the AI chat (`system_cleanup` with `action: 'run'`) and confirm the tool surfaces the same refusal rather than queueing.

- [ ] **Step 6c: R9 — the apt autoremove estimate matches the space actually freed.** R4 compares the estimate against `apt-get -s autoremove`'s own summary, which only proves the parser reads the simulation correctly. This check closes the loop against the disk.

```bash
ssh -o StrictHostKeyChecking=no -J breeze-svc@kit-1 breeze@192.168.10.240 \
  'sudo apt-get -y install linux-headers-generic build-essential >/dev/null 2>&1; \
   LC_ALL=C dpkg-query -W -f="\${Package}\t\${Installed-Size}\n" $(LC_ALL=C apt-get -s autoremove 2>/dev/null | awk "/^Remv /{print \$2}") | awk "{s+=\$2} END {print s*1024}"; \
   df -B1 --output=avail / | tail -1'
```

The first number is the estimate computed from `dpkg-query`'s `Installed-Size` over exactly the packages `apt-get -s autoremove` would remove; the second is free space before. Read the catalog's `linux_pkg_autoremove` estimate, run that one action from the UI, then:

```bash
ssh -o StrictHostKeyChecking=no -J breeze-svc@kit-1 breeze@192.168.10.240 'df -B1 --output=avail / | tail -1'
```

**Acceptance R9:** the catalog estimate, the `dpkg-query` figure and the measured free-space delta agree **within 10%**. A larger gap means the estimator is parsing a different package set from the one apt removes (dnf5's changed summary format is the known case — spec §7.2 — but this rig is apt), and the "up to" label is hiding a real parser bug rather than the expected over-estimate. Record all three numbers.

- [ ] **Step 6d: R10 — an ancestor symlink does not carry a delete outside the tree.** Spec §10 item 4 and §6.3: `contentsOnly` and `cleanupGuard` must `Lstat` at every level, and Go's `RemoveAll` must never traverse a link. The Go suite plants a symlink two levels deep; this is the same property against a real filesystem, with the link in the **ancestor** position that a rule match walks through.

```bash
ssh -o StrictHostKeyChecking=no -J breeze-svc@kit-1 breeze@192.168.10.240 \
  'mkdir -p ~/scratch-target && dd if=/dev/zero of=~/scratch-target/precious.bin bs=1M count=64 2>/dev/null && \
   mkdir -p ~/.cache && rm -rf ~/.cache/sub && ln -s ~/scratch-target ~/.cache/sub && \
   mkdir -p ~/.cache/real && dd if=/dev/zero of=~/.cache/real/junk.bin bs=1M count=64 2>/dev/null && \
   ls -la ~/.cache/ && ls -la ~/scratch-target/'
```

Scan `/`, then in the Cleanup panel select the `browser_cache` candidates under `~/.cache` (which is a `browser_cache` root on Linux, spec §6.1) and Execute. Afterwards:

```bash
ssh -o StrictHostKeyChecking=no -J breeze-svc@kit-1 breeze@192.168.10.240 \
  'ls -la ~/scratch-target/ ; test -f ~/scratch-target/precious.bin && echo TARGET_SURVIVED || echo TARGET_DESTROYED; ls -la ~/.cache/'
```

**Acceptance R10:** `TARGET_SURVIVED`, `~/scratch-target/precious.bin` is still 64 MiB, and the run's per-path statuses show the symlinked child reported as `rejected` (or skipped and reported) rather than silently followed — while `~/.cache/real/junk.bin` was genuinely removed, so the test is not vacuous. A destroyed target is a **FAIL** that blocks the agent release outright: it means cleanup can delete outside the tree it was previewed against. Clean up with `rm -rf ~/scratch-target ~/.cache/sub ~/.cache/real`.

- [ ] **Step 7: R6 — the old-agent gate.** Push a pre-W04 agent to one rig (`make dev-push` from a commit before W04, or stop the agent and start the previously installed binary), then click **Check available actions**.

**Acceptance R6:** the panel renders the *agent update required* banner naming `MIN_AGENT_VERSION_SYSTEM_CLEANUP`, the **Run** button is disabled, and the API answered `409 { error: 'agent_update_required' }`. Restore the W04 build afterwards.

- [ ] **Step 8: Record the results on the W05 sub-issue.** Post one comment on `#<subissue#>` with a row per check:

```
| Check | Rig | Result | Evidence |
|---|---|---|---|
| R1 multi-volume snapshot isolation | WIN-IMDR2GAIDMV | PASS/FAIL | <before/after byte totals per volume> |
| R2 cleanup frees space, nothing lands on C: | WIN-IMDR2GAIDMV | PASS/FAIL | <Get-PSDrive before/after, bytesReclaimed> |
| R3(a) cleanmgr process tree exits in session 0 | WIN-IMDR2GAIDMV | PASS/FAIL | <elapsed, last process-list sample> |
| R3(b) measured free-space delta after reboot | WIN-IMDR2GAIDMV | PASS/FAIL | <Get-PSDrive before/after> |
| R4 Linux cleaners + estimate fidelity | lab-ubuntu-src | PASS/FAIL | <du/apt-get -s/journalctl vs catalog> |
| R5 AI lane list + approved run | lab-ubuntu-src | PASS/FAIL | <audit row> |
| R6 old-agent 409 banner | either | PASS/FAIL | <screenshot / response body> |
| R7 non-allowlisted cleanmgr handler zeroed, canary intact | WIN-IMDR2GAIDMV | PASS/FAIL | <StateFlags5555 value, Test-Path result> |
| R8 concurrent run refused 409 run_in_progress | WIN-IMDR2GAIDMV | PASS/FAIL | <status code, body, run-row statuses> |
| R9 autoremove estimate vs dpkg-query vs measured delta (±10%) | lab-ubuntu-src | PASS/FAIL | <all three numbers> |
| R10 ancestor-symlink target survives | lab-ubuntu-src | PASS/FAIL | <TARGET_SURVIVED, per-path statuses> |
```

State the agent build (`dev-<epoch>` and its commit sha), the stack's commit sha, and both rigs' OS builds. **Any FAIL on R3(a), R3(b), R7 or R10 blocks the agent release** — that is the whole reason this task exists.

- [ ] **Step 9: Tear the lab stack down.** Nothing reaps it for you.

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-green-meadow-232b && pnpm wt-stack down
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```

Expected: no Breeze project left running that this session started. Say in the PR body what, if anything, was left up deliberately.

---

### Task 15: Wave verification and the agent-release gate

**Files:** none (verification only).

- [ ] **Step 1: Run every suite this wave touched**

```bash
cd apps/api && npx vitest run \
  src/services/systemCleanup.aiOrigin.test.ts \
  src/services/aiToolsFilesystem.systemCleanup.test.ts \
  src/services/aiToolsFilesystem.fileWriteCap.test.ts \
  src/services/aiToolsFilesystem.mcpSurface.contract.test.ts \
  src/services/aiToolsRegistryParity.test.ts \
  src/services/aiTools.deviceArgsCoverage.contract.test.ts \
  src/services/aiToolsDeviceScope.contract.test.ts \
  src/services/aiToolsDeviceGuard.contract.test.ts \
  src/services/aiGuardrails.systemCleanup.test.ts \
  src/services/aiGuardrails.approvalScope.contract.test.ts \
  src/services/aiGuardrails.agentPrincipal.contract.test.ts \
  src/services/aiToolPermissionsCatalogParity.contract.test.ts \
  src/services/aiGuardrailsTierConfig.parity.test.ts \
  src/services/aiGuardrailsAiDocs.parity.test.ts \
  src/services/aiAgentSdkTools.registryParity.contract.test.ts \
  src/services/aiAgentSdkTools.handlerCoverage.contract.test.ts \
  src/services/aiAgentSdkTools.mcpCoverage.test.ts \
  src/services/aiToolOutput.systemCleanup.test.ts \
  src/services/aiToolOutput.test.ts \
  src/services/mcpGuidancePromptTools.test.ts \
  src/services/helperToolFilter.test.ts \
  src/services/builtInPlaybooks.test.ts \
  src/services/aiAgents/agentToolCatalog.contract.test.ts \
  src/services/aiAgents/actManifest.test.ts \
  src/services/aiAgents/actRevalidation.test.ts \
  src/services/aiAgents/actVerify.test.ts \
  src/services/aiAgents/impactFixTools.contract.test.ts \
  src/services/aiAgents/playbookActExecutor.test.ts \
  src/services/aiDispatch.contract.test.ts \
  src/routes/mcpServer.approvalGate.test.ts
```

Expected: 30 files, all green. Check the reported file count — every path here is a full filename, because vitest's filter is a plain substring and a directory prefix would silently skip dotted siblings.

```bash
cd apps/web && npx vitest run \
  src/components/ai-risk/tierConfig.systemCleanup.test.ts \
  src/lib/i18n/translationCoverage.test.ts \
  src/lib/i18n/localeParity.test.ts \
  src/lib/i18n/extractionQuality.test.ts \
  src/lib/__tests__/no-silent-mutations.test.ts
cd packages/shared && npx vitest run src/utils/aiToolLabels.test.ts
cd apps/mobile && npx vitest run src/screens/chat/components/toolIndicatorLogic.test.ts src/screens/chat/historyAdapter.test.ts
```

Expected: all green.

- [ ] **Step 2: Run the full unit suites**

```bash
cd apps/api && npx vitest run
cd apps/web && npx vitest run
```

Expected: both green. These are the only runs that catch a mock factory elsewhere in the repo whose `aiTools`/`filesystemAnalysis` stub now disagrees with the real module.

- [ ] **Step 3: Typecheck everything this wave touched**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
cd apps/web && npx tsc --noEmit
cd packages/shared && npx tsc --noEmit
cd apps/mobile && npx tsc --noEmit
cd apps/docs && npx astro check
```

Expected: no errors anywhere.

- [ ] **Step 4: Prove the wave added no schema, no migration and no Go**

```bash
git diff --stat main...HEAD -- apps/api/migrations apps/api/src/db agent .env.example deploy
```

Expected: **no output**. W05 is tools, mirrors and documentation (spec §3 row W05: "Schema: none", "Agent release: no"). Any output here means work from another wave leaked into this branch.

- [ ] **Step 5: Run the contract suites the feature as a whole depends on.** W05 adds no tenant-scoped table, but the feature does, and this is the last wave before the release — so run them once against the merged state. They need a live database:

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-green-meadow-232b && pnpm test-stack up
cd apps/api && pnpm test:rls-coverage
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-green-meadow-232b && pnpm test-stack down
```

Expected: all green. These are the suites that only fail under **Integration Tests**, never in the unit job, so a green local unit run says nothing about them (CLAUDE.md). If `tenant-export-policy` fails on `scan_path`, `kind` or `command_id`, W02's `CORE_TENANT_EXPORT_POLICY` entry is missing — fix it on this branch and say so in the PR body rather than merging a red export contract.

- [ ] **Step 6: Open the PR.** Body must contain `Closes #<subissue#>`, the lab-results table from Task 14 (or a link to that sub-issue comment), and the two follow-ups this wave deliberately did not do:
  - `mcp-server.mdx`'s step-up-approval and production-allowlist sections still describe the pre-2026-08-02 Tier 3 model (amendment B14).
  - `RBAC_MAPPINGS.file_operations.list` in `apps/web/src/components/ai-risk/tierConfig.ts` says `devices.read` while `TOOL_PERMISSIONS` says `devices.execute` — pre-existing drift, untested, not touched here.

Because this is a **settings-adjacent** wave only in the sense that it changes the AI tier explainer, no `pages/settings/**` PR-template section applies; state that explicitly so a reviewer does not go looking.

- [ ] **Step 7: State the agent-release gate — what "done" means for this wave.**

**This wave ends with the agent release UNBLOCKED, not performed.** Every Breeze release builds and registers the full agent family from the tag, and the fleet promote is a standing release step — so "needs an agent release" is never a to-do item. What W05 owes the release is the *evidence* that the W01 and W04 agent changes are safe to ship, and that evidence is Task 17.

Concretely, this wave is done when all of the following hold:

1. Tasks 1–13 are merged and `CI Success` is green on the merge-queue run (not merely on the PR head).
2. Task 14's results comment exists on `#<subissue#>` with **PASS on R3(a), R3(b), R7 and R10** — the four checks no test can make. A FAIL on R3 means the agent-side `cleanmgr` runner is not safe in session 0; a FAIL on R7 means an excluded handler can execute from stale registry flags; a FAIL on R10 means cleanup can delete outside the tree it was previewed against. Any of the three means the agent changes must be fixed or the native cleaners disabled before the tag.
3. `docs/release-notes/next-release-draft.md` carries the Task 13 entry with a real `MIN_AGENT_VERSION_SYSTEM_CLEANUP`, so `/release` Step 1 folds it into the GitHub Release body.
4. The lab stack from Task 14 is torn down.

At that point the release runs normally: `/release` cuts the tag, the agent family builds from it, the fleet is promoted, and `MIN_AGENT_VERSION_SYSTEM_CLEANUP` becomes satisfiable in production. Devices below it keep working exactly as before and surface the *agent update required* banner instead of a broken panel — which is why the rest of the feature could ship independently and this wave could not.

---

## Self-review

**Spec coverage.** §9.1's `disk_cleanup`/`analyze_disk_usage` rows and §9.3 items 8b/11's act-and-playbook halves are **not** W05 requirements any more — the Codex quorum moved them to W03 (amendment B8). They appear below as *consumed*, with the W05 task that asserts or documents them.

| Requirement | Spec | Task |
|---|---|---|
| W05 ships no schema, no migration, no agent code | §3 row W05 | Global Constraints, 15 (Step 4) |
| New `system_cleanup { deviceId, action, actionIds?, params? }`; list Tier 1, run Tier 3 | §9.1 | 2, 3, 4 |
| `run` rate limit 2 / 3600 s | §9.1 | 4 |
| `actionIds ⊆ SYSTEM_CLEANUP_ACTION_IDS` | §9.1, §5.3 | 3 (Zod enum), 2 (handler) |
| Handler queues the SAME commands as the routes — one code path | §9.1 | 1, 2 |
| Polls to completion within `toolTimeouts` (2 h) | §9.1 | 1 (`awaitSystemCleanupResult`), 6 |
| Run-level audit written like the route's | §9.1, §10 item 9 | 2 |
| Denied to the Helper | §9.1, §9.3 item 10 | 7 |
| `analyze_disk_usage` / `disk_cleanup` gain `path`; `execute` requires `cleanupRunId` | §9.1 | **consumed** (W02/W03, amendment B8) — asserted in 10, documented in 11/12 |
| Tier 3 is a hard deny over MCP, verified against `routes/mcpServer.ts` | §9.2 | 10, amendment B5 |
| Both tools stay listed as mixed multiplexers; the appended note quoted exactly | §9.2 | 10, 11, amendment B6 |
| Org resolution via `deviceArgs` | §9.2 | 2, 10, amendment B1 |
| Rate limits are the same per-tool windows as in-app; no MCP-specific limit | §9.2 | 4, 11 |
| No MCP prompt change; `MCP_TOOL_COUNT_APPROX` within tolerance | §9.2 | 2 (Step 6), amendment B7 |
| §9.3 item 1 — definition + handler, module registered | §9.3 | 2 |
| §9.3 item 2 — device-arg / helper-scoping maps | §9.3 | 2 (declare), 7 (Helper exclusion) |
| §9.3 item 3 — Zod entries matching `input_schema.properties` exactly | §9.3 | 3 |
| §9.3 item 4 — `TIER3_ACTIONS` both tables, `TOOL_PERMISSIONS`, rate limits | §9.3 | 4, amendments B2/B3/B4 |
| §9.3 item 5 — `TOOL_TIERS` + `tool(...)` declaration | §9.3 | 5 |
| §9.3 item 6 — `toolTimeouts`, `aiToolOutput`, `aiAgentSystemPrompt` | §9.3 | 6 |
| §9.3 item 7 — capability `files_disk`, no preset | §9.3 | 7 |
| §9.3 item 8 — no `ActOperation` for `system_cleanup` | §9.3 | 7, amendment B10 |
| §9.3 item 8 — `disk_cleanup`'s act path updated for `cleanupRunId` | §9.3 | **consumed** (W03, amendment B8) |
| §9.3 item 9 — not an impact-fix tool, recorded as a decision | §9.3 | 7 |
| §9.3 item 10 — omitted from every Helper whitelist | §9.3 | 7 |
| §9.3 item 11 — built-in playbook passes `cleanupRunId`, gains a `system_cleanup list` step | §9.3 | **consumed** (W03, amendment B8); documented in 11 (`playbooks.mdx`) |
| §9.3 item 12 — `tierConfig.ts`, `RATE_LIMIT_CONFIGS`, permission map, `ApprovalHistoryFeed`, 3 keys × 8 locales | §9.3 | 8 |
| §9.3 item 13 — `ai.mdx` tier and rate tables, `mcp-server.mdx` tables + hard-deny sentence, `docsIndex.json` | §9.3 | 11, 12 |
| §9.3 item 14 — mobile: one added `aiToolLabels` case | §9.3 | 9, amendment B13 |
| §11 Lab — Windows rig and KIT rig, results on the W05 sub-issue | §11 | 14 |
| §13 quorum — non-allowlisted cleanmgr handler zeroed (R7); concurrent run 409 (R8); autoremove estimate vs `dpkg-query` vs measured, ±10% (R9); ancestor-symlink target survives (R10) | §13 | 14 |
| §11 Docs — `filesystem-analysis.mdx` rewrite, `playbooks.mdx`, `docsIndex.json` (`agents/commands.mdx` is W04's, alignment A3) | §11 | 11, 12 |
| §13 quorum — docs state preview expiry (24 h), "current contents at execution", `MIN_AGENT_VERSION_CLEANUP_GUARD`, heuristic/"up to" estimates, and the risk flags incl. `removes_os_rollback` / `removes_recovery_points` | §13 | 12 |
| §11 — release notes entry incl. the W02 rolling-deploy note | §11, §4 | 13 |
| Agent release unblocked, not performed | §3 row W05 | 15 (Step 7) |

**Placeholder scan.** The only placeholders are `<parent#>` and `<subissue#>` in the branch name, `Closes #<subissue#>`, and the `<win-device-id>` / `<lab-ubuntu-src device uuid>` / `$BREEZE_URL` / `$TOKEN` values in the lab task — each with the exact command that produces it. Task 13 Step 2 names the grep that resolves `MIN_AGENT_VERSION_SYSTEM_CLEANUP`, and Task 12's docs table names the two version literals the page must carry. Every code step has a complete code block; no step says "similar to Task N" or "handle edge cases". Task 12's rewrite is specified as a heading-by-heading content contract rather than prose, because the docs-index test and `astro check` are what verify it.

**Type-consistency check.** `AiTool.deviceArgs` is `readonly string[]`, so every declaration here is `['deviceId']` (amendment B1). `toolInputSchemas.system_cleanup` stays a `z.ZodObject` (not `ZodEffects`) so `toolActionEnum`'s `.shape` read keeps working, while `disk_cleanup` stays a `ZodEffects` as it is today and as W03 leaves it. `SYSTEM_CLEANUP_ACTION_IDS` is passed to `z.enum` directly at both sites: W04 declares it `export const SYSTEM_CLEANUP_ACTION_IDS = [ … ] as const` with type `readonly [...27 ids]`, the non-empty tuple `z.enum` requires (amendment A2); if it arrives as a plain `readonly string[]`, add `as unknown as [string, ...string[]]` at both sites rather than widening the shared type. The queue/start discriminated union is named `SystemCleanupStartResult` because W04 already exports `SystemCleanupRunResult` for its Zod-parsed agent payload (amendment A1). `createAuditLogAsync`'s `actorType` accepts `'user' | 'api_key' | 'agent' | 'system' | 'ai_agent'`, which is why Task 2's audit call branches on whether the principal resolved against `users`. `getToolTier` returns `number | undefined`, so Task 10's `Math.max` calls use `!` on tools the same suite has already proved are registered. W05 adds no `ActTarget` variant and no `PlaybookStep` change, so nothing in `aiAgents/**` needs to compile differently because of this wave.
