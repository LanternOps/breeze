---
tracking_issue: LanternOps/breeze#6754
wave: W17 (#6788)
spec: docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md
triage: docs/superpowers/plans/ai-mcp/2026-09-23-ai-full-control-w05-gap-triage.md
depends_on: W03 (#6757, PR #10117) and W19 (#10087) merged to main; independent of W16 (#6786) and W18 (#6789)
branch: feature/6754-ai-full-control/wave-6788
---
# AI full control W17: backup verification, VSS, C2C configs, bare-metal recovery reads — class review and plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** expose the W05 rows tagged `W17` to chat, agents and MCP, each with a class that survives the spec's class review **before** the tool is reachable (spec D2).

**Architecture:** thin tool handlers over the code the routes already run. `runBackupVerification`, `listBackupVerifications`, `getBackupHealthSummary`, `listRecoveryReadiness` and `listBackupHealthRows` are already exported services. C2C config writes move out of the route into one new service that the route and the tool both call. Every tool's output is an allow-list projection.

**Tech Stack:** Hono services, Drizzle, Vitest (unit + `pnpm test-stack` integration).

**Verified against** `origin/main` `36f9d9ca53` (2026-11-04). Paths are under `apps/api/src/` unless stated; line numbers drift, so re-grep.

## Global Constraints

- **One PR, base `main`, never stacked.** A stacked PR gets no CI. `Closes #6788`, `Part of #6754`.
- **No migration, no new table, no new column.** Nothing under `apps/api/migrations` is touched, so no RLS shape, no `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`, `CORE_TENANT_EXPORT_POLICY` or device/ticket list entry. If implementation finds it needs one, stop and raise it: the slot would be `2027-01-21-100000-<slug>.sql`, sorted after the newest committed file at that moment (today `2027-01-20-120000-m365-mailbox-connect-baseline.sql`; open PRs hold `130000` / `140000` / `160000`, so re-check).
- **No new setting, so settings rule 9 counts are unchanged:** C2C config stays edited on its existing surface; the tool is another door to the same row (W14 precedent). No `pages/settings/**` or `*Settings*` component is touched. `c2c_backup_configs` stays `org_id NOT NULL`: partner-wide-first applies to new tables, and this wave adds none.
- **The tool never asks for less than the route.** Permission, MFA and scope mirror the REST twin. `aiGuardrails.routeBinding.contract` pins permission, `MFA_GATED_TOOL_ACTIONS` pins MFA.
- **Tier-1 read actions never write.** The `refresh` query flag on `GET /backup/health` and `GET /backup/recovery-readiness` calls `recalculateReadinessScores`, which writes. No tool input maps to it.
- **Outputs are allow-listed.** `recoveryTokenId`, `target`, `plan` and `result` never reach the model from `list_bmr_recoveries`. Those three JSON columns are console-reported and accept any JSON up to 768 KiB (`bmrProgressSchema`).
- **`z.undefined()` is banned in tool schemas** (one unrepresentable field empties `tools/list`). Use `z.never().optional()`.
- Tool description ≤ 300 chars, param description ≤ 160 (`aiTools.descriptionBudget`; the baseline only shrinks).

## Review Focus

1. **A device-bound agent run asks for verification history.** The services filter by org and site and read under system context (`verificationService.ts`, `listBackupVerificationsFromDb`), so an exact-device run must not see a sibling device → T1 `device-bound: health refused, list needs an allowed deviceId, sibling device id refused`.
2. **`orgId` in the input names another tenant.** System-context reads mean the app predicate is the only gate → T1 `foreign orgId refused before any service call`; T8 integration case.
3. **`get_vss_status` on a macOS or Linux device, or an offline device.** A clean coded error, not a raw agent failure → T2 `non-Windows refused without a command`, `offline device surfaces the coded error`.
4. **`manage_c2c_configs:delete` on a config that has jobs or items.** `c2c_backup_jobs.config_id` and `c2c_backup_items.config_id` have no `ON DELETE` (`0079-c2c-backup.sql:43,64`), so today it is an uncaught 23503. The caller gets `CONFIG_HAS_HISTORY` and history survives → T3 and T8.
5. **A hostile recovery console writes a forged delimiter into `failureReason` / `warnings`, or a 700 KiB `result`.** Fenced, clipped, and `result` absent → T4 `byte scan: no target/plan/result/recoveryTokenId`; `forged closing delimiter does not survive`.

---

## Premises

| # | Check | Result |
|---|---|---|
| 0.1 | The four W05 modules are still `{ gap: '#6788' }` in `mcpCoverage.ts` | yes: `backup/bmrRecoveries.ts`, `backup/verification.ts`, `backup/vss.ts`, `c2c/configs.ts` (`:348,387,389,399`). W03 and W14 absorbed none |
| 0.2 | None of the proposed tool names is registered | yes |
| 0.3 | No `wave-6788` branch or PR | yes |
| 0.4 | #6788 and #6754 open | yes |
| 0.5 | W16 disjoint | yes: see below |

### Already covered (not in this wave)

| Surface | Covered by |
|---|---|
| `backup/bmr.ts` (triage row 14 DEFER) | `exempt: human_only_trust_material` (#6792) |
| `backup/encryption.ts`, `backup/reconcile.ts` | `exempt` (#6793, #6794) |
| `c2c/connections.ts`, `c2c/items.ts`, `c2c/jobs.ts` | W03: `query_c2c_connections`, `search_c2c_items`, `restore_c2c_items`, `query_c2c_jobs`, `trigger_c2c_sync` |
| SQL Server backup verify | W03: `verify_mssql_backup`. Different table and command from `POST /backup/verify` |
| Backup config, profile, job, snapshot, vault, SLA, DR, Hyper-V surfaces | W03 / W01 |

### W16 boundary

PR #10273 was **W10 (#6780), the read half**. It moved `aiAgentSchedules.ts`, `aiOperatorTasks.ts` and `fleetDesign.ts` to `{ tools }` with reads only. **No W16 write is on `main`, and no W16 plan or PR exists.** W16 still owes `manage_ai_agent_schedules`, `create_operator_task` (workflows and drafts per the `mcpCoverage.ts:310` note), `manage_fleet_designs` (run, apply, rollback, document) and `run_patch_plan` (`patchPlan.ts` is its remaining `{ gap: '#6786' }`). W17 touches none of those route modules or handler files. The overlap is only the registry hot files, so whichever lands second rebases, re-keys golden ids and re-measures.

## Facts the triage did not have

1. **`backup/health.ts` is a fifth gap with no owner.** It landed after W05 (#6008 W03), still says `{ gap: '#6141' }`, and #6141 is closed. No wave owns it (Decision 1).
2. **VSS status is not a stored read.** `GET /backup/vss/status/:deviceId` runs `VSS_WRITER_LIST` on the machine and waits 30 s, behind `devices:execute` + `requireMfa()`. Triage called it "read" (Decision 3).
3. **Verification reads are `organizations:read`, the run is `devices:execute` + MFA.** Other backup reads use `backup:read`. The tool mirrors the route.
4. **`runBackupVerification` always queues a device command** (`backup_verify` or `backup_test_restore`), except that an `attestation_failed` snapshot records a failed row and sends nothing. `test_restore` needs a snapshot. Validation errors are plain `Error`s with message matching in the route.
5. **C2C schedules are live config.** `check-schedules` (`jobs/c2cBackupWorker.ts`) polls active configs every 5 minutes. Sync itself still fails `c2c_sync_not_implemented` (`c2cQueuedAuthorization.ts`), the same stub W03 classed `trigger_c2c_sync` for what it will do. `targetUsers` is a list of email addresses and chooses whose mail is copied.
6. **BMR rows carry console-reported JSON.** See Global Constraints. The one-time code is stored only as a hash and never appears in `toRecoverySummary`.
7. **`auth.allowedDeviceIds` is the device-bound axis.** Agent runs are always `scope: 'organization'`, and a device-less run pins `allowedSiteIds` to the empty set (`aiAgents/agentAuthContext.ts`), so its org-wide reads are empty, not wide.

## Tools and per-action class review

Q1 reversible in a minute? Q2 leaves the tenant / reaches a person / touches a machine? Q3 blast radius? Q4 can an agent grant itself authority?

| Tool:action | Q1 | Q2 | Q3 | Q4 | Triage | **W17** | RBAC / MFA (= route) |
|---|---|---|---|---|---|---|---|
| `manage_backup_verification:health` | read | none | caller's sites | no | read | **t1** | `organizations:read` |
| `…:list` | read | none | caller's sites | no | read | **t1** | `organizations:read` |
| `…:readiness` | read | none | caller's sites | no | read | **t1** | `organizations:read` |
| `…:run` (integrity, test_restore) | job runs; cannot be unsent | **machine:** queues a device command | one device | no | sup | **sup** | `devices:execute`, MFA |
| `get_vss_status` | read | **machine:** read-only command, no state change | one device | no | read | **t2 read-only** (`TIER2_READONLY_TOOLS`), Decision 3 | `devices:execute`, MFA `*` |
| `list_bmr_recoveries:list` / `get` | read | none | caller's sites | no | read | **t1** | `backup:read` |
| `manage_c2c_configs:list` | read | none | one org | no | read | **t1** | `organizations:read` |
| `…:create` / `update` | yes by edit, but copied data and elapsed schedule are not | **by intent:** chooses whose mail is copied, to which storage, on what schedule | one org | no | t2 | **sup**, Decision 2 | `organizations:write`, MFA |
| `…:delete` | no | none today | one config (refused when history exists) | no | sup | **sup** | `organizations:write`, MFA |
| `get_backup_health` (Decision 1) | read | none | caller's orgs and sites | no | n/a | **t1** | `backup:read` |

No four-eyes in this wave: nothing here is irreversible **and** tenant-leaving or partner-wide. Create and cancel of a bare-metal recovery stay human (the code goes to a person at the machine; triage row 15).

### Agent (headless) exposure (spec D4)

| Tool | Agent reachable | Why |
|---|---|---|
| `manage_backup_verification` | reads yes; `run` a proposal | Device axis enforced in the handler. `health` refused to device-bound runs (W07-D5) |
| `get_vss_status` | yes | `deviceArgs: ['deviceId']`; `TIER2_READONLY_TOOLS` is read-only for the allowlist, like `manage_services:list` |
| `list_bmr_recoveries` | yes | Device axis; output is scalars only |
| `get_backup_health` | yes, refused to device-bound runs | Rows span devices |
| `manage_c2c_configs` | **no**, `AGENT_HUMAN_ONLY_TOOLS` | `list` returns target mailboxes (the `search_c2c_items` / `query_c2c_jobs` reasoning) and writes choose what is copied. Needs sign-off (Decision 4) |

`run` passes `requestedBy: await verifiedUserIdOrNull(auth)` (`aiToolsSoftwareShared.ts:31`), so an approver-released agent call never writes an agent id into a user reference; no `USER_OWNED_RELEASE_ACTIONS` entry.

## Decisions surfaced while planning

1. **Include `backup/health.ts` (`get_backup_health`) in W17?** It is outside the issue title and the W05 allocation.
   - **A: include (recommended).** One read, one task, burns the last unowned backup gap, and adds provider-sourced rows, which `get_backup_status` does not see.
   - B: re-point the gap to a new issue. No scope growth, but it leaves the only `{ gap }` citing a closed issue.
   - If B, drop `get_backup_health` from T4 and the g126 row and subtract 19 B from the backup block; everything else stands.
2. **`manage_c2c_configs:create/update` is supervised, not the triage's t2.**
   - **A: supervised (recommended).** "Nothing that leaves the tenant may be tier 2", because `auto_approve` runs tier 2 without a prompt. W03 classed the sync stub for its intent; a config is that sync's input.
   - B: t2 until sync is implemented. Cheaper today, but it needs a reclassification the day sync ships, and nothing would force it.
3. **`get_vss_status` is registry tier 2 + `TIER2_READONLY_TOOLS`, not the triage's tier 1.**
   - **A: t2 read-only (recommended).** It runs a command on the machine, so tier 1 is wrong, and a supervised card per lookup repeats the approval noise the Wisp review complained about. Exact precedents: `browse_device_event_log:list_logs`, `manage_services:list`.
   - B: supervised, the literal reading of "touches a customer machine → supervised at minimum". Quorum agreed with A.
4. **Sign-off: `manage_c2c_configs` in `AGENT_HUMAN_ONLY_TOOLS`** (the registry says entries are added only with sign-off).
   - **A: whole tool (recommended).**
   - B: agents get `list` with `targetUsers` reduced to a count. Extra projection path for no known agent need.
5. **`list_bmr_recoveries` omits `target`, `plan` and `result`, returning `hasTarget` / `hasPlan` / `hasResult` booleans.** Tighter than REST, which returns them for the wizard. Recommended: omit until someone needs a named field, then add that field, not the blob.

The quorum raised no disagreement with the structure; its three W17 changes are in the plan (below).

## Wiring

| Map | Change |
|---|---|
| `TOOL_TIERS` (`aiAgentSdkTools.ts`) | `manage_backup_verification: 1`, `list_bmr_recoveries: 1`, `get_backup_health: 1`, `manage_c2c_configs: 1`, `get_vss_status: 2` |
| `TIER1_READ_ACTIONS` | `manage_backup_verification: health, list, readiness`; `list_bmr_recoveries: list, get`; `manage_c2c_configs: list` |
| `TIER3_ACTIONS` + `TIER3_SUPERVISED_ACTIONS` | `manage_backup_verification: run`; `manage_c2c_configs: create, update, delete` |
| `TIER2_READONLY_TOOLS` | `get_vss_status` |
| `TOOL_ACTION_INPUT_KEYS` / `TIER_DECIDING_INPUT_KEYS` | unchanged unless a contract requires it (no input-aware class) |
| `MFA_GATED_TOOL_ACTIONS` | `manage_backup_verification: ['run']`, `get_vss_status: '*'`, `manage_c2c_configs: ['create','update','delete']` |
| `TOOL_PERMISSIONS` | per the table, per action |
| `TOOL_RATE_LIMITS` (keyed by tool) | `manage_backup_verification` 30/300 s, `get_vss_status` 15/300 s, `manage_c2c_configs` 20/300 s, `list_bmr_recoveries` 40/300 s, `get_backup_health` 30/300 s |
| `AGENT_HUMAN_ONLY_TOOLS` | `manage_c2c_configs` |
| `agentToolCatalog.ts` `TOOL_CAPABILITY` | `backup_recovery` for the four reachable tools; `__snapshots__/agentToolCatalog.contract.test.ts.snap` gains `manage_c2c_configs` in the unreachable set |
| `aiTools.deviceWaitContext.contract` `DEVICE_WAIT_TOOLS` | `get_vss_status: { file: 'aiToolsBackupVerification.ts', disposition: 'bounded', maxWaitMs: 30_000, why: ONE_30S_COMMAND }` |
| `RAW_TEXT_FIELDS_BY_TOOL` (`aiToolOutput.ts`) | device names, verification reasons, VSS writer names, BMR `failureReason` / `warnings`, C2C `name` / `targetUsers`, health-row labels |
| `mcpCoverage.ts` | five entries → `{ tools }`; `bmrRecoveries` carries a comment naming the human-only create/cancel/reissue. `FROZEN_GAPS` −5 |
| `WISP_NON_FOCAL_TOOLS` (`wisp/toolSubjects.ts`) | all five. The contract pins fourteen focal names; device-targeted reads such as `get_device_health` and `browse_device_event_log` are already non-focal |
| `DOMAIN_VOCABULARY.backup` | append `, VSS, verification` |

Domains: `backup` for all except `manage_c2c_configs` (`integrations`, beside its siblings).

### Locale labels (8 locales: en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR)

`agentToolCatalog.labels.contract` requires a label for every catalog tool and operation in `en`; `apps/web/src/lib/i18n/localeParity.test.ts` holds the other seven to the same keys; `translationCoverage.test.ts` caps exact-English duplicates, so translate. In `apps/web/src/locales/*/settings.json`:

- `aiAgentsPage.catalog.tools`: `manage_backup_verification`, `get_vss_status`, `list_bmr_recoveries`, `get_backup_health`.
- `aiAgentsPage.catalog.actions`: `manage_backup_verification.{health,list,readiness,run}`, `list_bmr_recoveries.{list,get}`.
- **Not** `manage_c2c_configs`: it is not agent-reachable, so it is not in the catalog.

## Budget

Measured on `36f9d9ca53` with a registry probe over `listChatSurfaceToolNames()`; "after" is computed from the rendered entry strings. T6 re-measures and replaces these.

| Measure | Bound | Before | After W17 |
|---|---|---|---|
| Always-on (lazy) | B1 < 2,560 | 2,507 | 2,526 (+19, vocabulary) |
| `backup` block | B2 < 2,048 | 959 | 1,082 (+123) |
| `integrations` block | B2 < 2,048 | 620 | 668 (+48) |
| Largest block | B2 < 2,048 | `devices` 1,720 | unchanged |
| Worst page turn (alert) | B3 < 7,040 | 5,298 | 5,317 (backup is not page-expanded; only B1 moves) |
| Whole index (`AI_TOOL_INDEX=full`) | none since W19 | 11,496 | 11,667 (+171, informational) |

- **+128 B step rule:** a wave that exceeds a bound raises it by exactly +128 B in its own commit, bytes stated in the PR body, never above 7,680 B. No bound is exceeded here, so no step. The whole-index ceiling was retired by W19; `full` is informational.
- **`aiToolIndex.test.ts` pins always-on at exactly 2,507 B** (the flow-tools test, near `:431`), so the vocabulary change must update that number, not just stay under the ceiling. `aiToolIndex.w15-budget.test.ts` stays green: its deltas (B1 ≤ 128 over 2,507; B3 ≤ 128 over 5,270) hold.
- **W18 wants 25 B of always-on too.** Together they reach 2,551, leaving 9 B. If T6 measures B1 ≥ 2,550, drop `, verification` (14 B) and record it.
- `MCP_TOOL_COUNT_APPROX` stays 350 (registry 351 → 356, inside ± 10). W18 will need the bump.

## Golden prompts (`llm/toolEval/goldenPrompts.ts`)

Ids continue from the current maximum; `goldenPrompts.test.ts` pins the count (119 → 126). Re-key on rebase if another wave lands first.

| Id | Prompt | Expect |
|---|---|---|
| g120 | "Did the last backup verification on FIN-LAPTOP-07 pass?" | `manage_backup_verification:list`, `resolve_device_context` |
| g121 | "Which devices are we least confident we could recover?" | `manage_backup_verification:readiness` |
| g122 | "Run an integrity check on WS-01's latest backup." | `manage_backup_verification:run` |
| g123 | "Are the VSS writers healthy on SQL-02?" | `get_vss_status`, `resolve_device_context` |
| g124 | "Set up a daily cloud-to-cloud mailbox backup for the finance team." | `manage_c2c_configs:create`, `query_c2c_connections` |
| g125 | "Where did the bare-metal recovery of DC-01 get to?" | `list_bmr_recoveries:list` |
| g126 | "Which devices have failing backups across all customers, including Cove?" | `get_backup_health` |

## Quorum (codex `exec`, read-only, xhigh, gpt-6-astra): AGREE WITH CHANGES

One round across W17 and W18. W17 findings, each verified by reading the cited code before accepting:

- **Exact-device enforcement is not in the shared backup services:** accepted, T1 enforces it in the handler.
- **VSS needs `DEVICE_WAIT_TOOLS` registration:** accepted. The tool calls `aiExecuteCommand` directly rather than through an extracted helper, so the contract's static scan sees the wait.
- **The exact-byte always-on pin:** accepted, T6.

## Execution split and parallelism

No API/web seam issue: the only web change is `tierConfig.ts` plus locale JSON, driven by final tool names.

- **PARALLEL GROUP A (file-disjoint handler modules, each with its own test file; no hub edits):** T1, T2, T3, T4. Each exports a `registerXTools` function that T5 wires. T1 and T2 share `aiToolsBackupVerification.ts`, so run them in one agent.
- **SERIAL (hot files, one agent, after Group A):** T5 wiring and classes → T6 index and golden → T7 copy and coverage.
- **PARALLEL GROUP B (after T5):** T7's web/locale half and docs half are file-disjoint.
- **SERIAL last:** T8 integration, merge `main`, PR.
- **Sonnet-eligible:** T7 (`tierConfig.ts`, 8-locale labels, docs) and T6's golden rows. Opus for T1–T5 and T8: projections and guard classes are where a wrong call ships.

## Tasks

Test commands: from `apps/api`, `pnpm exec vitest run <file>`. Never `pnpm --filter <pkg> test -- --run <path>`. TS: `tsc --build tsconfig.tests.json` with a 20 GB heap, and check the exit code, not `| tail`. Integration suites need `pnpm test-stack up` and do not run under `pnpm test`; tear down with `pnpm test-stack down`.

### Task 1: verification reads and `run`

**Files:** Create `services/aiToolsBackupVerification.ts`, `services/aiToolsBackupVerification.test.ts`, `services/aiToolSchemasBackupVerification.ts`. Modify `routes/backup/verification.ts` only to export the error classifier below.

**Interfaces — Produces:**
- `registerBackupVerificationTools(aiTools: Map<string, AiTool>): void`.
- `backupVerificationToolSchemas` (spread into `aiToolSchemas.ts` by T5). T3 and T4 each add their own schema file the same way, so Group A stays file-disjoint.
- `manage_backup_verification` input (`.strict()`): `action: 'health'|'list'|'readiness'|'run'`, `orgId?: uuid`, `deviceId?: uuid`, `backupJobId?: uuid`, `snapshotId?: uuid`, `verificationType?: 'integrity'|'test_restore'`, `status?`, `from?`, `to?`, `limit?: 1–100` (default 25). `deviceArgs: ['deviceId']`.
- `classifyVerificationRunError(err: unknown): { message: string; code: 'VALIDATION'|'DISPATCH'|'INTERNAL'; status: number }`, extracted from the route's catch and used by both.

- [ ] Step 1: write the failing tests:
  - `foreign orgId refused before any service call`;
  - `device-bound: health refused, list needs an allowed deviceId, sibling device id refused`;
  - `site ceiling: health and readiness pass allowedSiteIds; empty ceiling returns status unknown and coveragePercent null`;
  - `no input reaches recalculateReadinessScores`;
  - `run requires deviceId; test_restore without a snapshot returns the validation error`;
  - `run maps BackupVerificationDispatchError to a coded error`;
  - `run passes verifiedUserIdOrNull as requestedBy` (agent id → null);
  - `run refuses a site-denied device (deviceSiteDenied), and refuses without MFA`;
  - `list output has exactly the allow-listed keys` (no `details`; `reason` lifted out and fenced);
  - `run writes a backup.verification.run audit event`.
- [ ] Step 2: run `pnpm exec vitest run src/services/aiToolsBackupVerification.test.ts`. Expect FAIL (module missing).
- [ ] Step 3: implement over `getBackupHealthSummary`, `listBackupVerifications`, `listRecoveryReadiness`, `runBackupVerification`, and `attachDeviceNames`. Re-run `routes/backup/verification.test.ts` if present, plus `__tests__/integration/backupVerificationSiteScope.integration.test.ts` in T8.
- [ ] Step 4: re-run, expect PASS. Commit `feat(ai-tools): W17 backup verification tool (#6788)`.

### Task 2: `get_vss_status`

**Files:** Modify `services/aiToolsBackupVerification.ts`, its test, and `services/aiToolSchemasBackupVerification.ts`.

**Interfaces — Produces:** `get_vss_status` input `{ deviceId: uuid }` (`.strict()`); output `{ deviceId, writers: Array<{ name, state, lastError }> | null, raw?: string }` (the agent's `WriterStatus`, `agent/internal/backup/vss/types.go`, without `id`), with `raw` clipped to 4 KB and fenced when stdout has no `writers` array.

- [ ] Step 1: failing tests:
  - `calls aiExecuteCommand with VSS_WRITER_LIST and timeoutMs 30000`;
  - `non-Windows refused without a command` (`devices.osType !== 'windows'`, code `UNSUPPORTED_OS`);
  - `offline device surfaces the coded error`;
  - `unparseable stdout is clipped and fenced, not thrown`;
  - `foreign or hidden-site device: one identical not-found`;
  - `refused without MFA`.
- [ ] Step 2: run, expect FAIL.
- [ ] Step 3: implement. Call `aiExecuteCommand(auth, 'get_vss_status', deviceId, CommandTypes.VSS_WRITER_LIST, {}, { timeoutMs: 30000 })`; check the argument order against `aiDispatch.ts:93`. It applies `checkAiRemoteToolsPolicy`, so if `VSS_WRITER_LIST` is a remote-tools type a policy denial comes back as a failed result; surface its error verbatim. Leave the route unchanged.
- [ ] Step 4: re-run, expect PASS. Commit `feat(ai-tools): W17 VSS status tool (#6788)`.

### Task 3: `manage_c2c_configs` and its service

**Files:** Create `services/c2cConfigService.ts`, `services/c2cConfigService.test.ts`, `services/aiToolsC2CConfigs.ts`, `services/aiToolsC2CConfigs.test.ts`, `services/aiToolSchemasC2CConfigs.ts`. Modify `routes/c2c/configs.ts` to call the service. (`aiToolsC2C.ts` is already 464 lines.)

**Interfaces — Produces:**
- `listC2cConfigs(orgId)`, `createC2cConfig(orgId, input)`, `updateC2cConfig(orgId, id, input)`, `deleteC2cConfig(orgId, id)`.
- Result type `C2cConfigResult<T> = { ok: true; value: T } | { ok: false; code: 'NOT_FOUND'|'CONNECTION_NOT_FOUND'|'STORAGE_NOT_FOUND'|'PROTECTED_ORG'|'CONFIG_HAS_HISTORY' }`.
- Tool input fields reuse `createC2cConfigSchema` / `updateC2cConfigSchema` shapes; `connectionId` is not updatable, as at REST.

- [ ] Step 1: failing tests:
  - `service: a connection in another org → CONNECTION_NOT_FOUND`;
  - `service: storage config in another org → STORAGE_NOT_FOUND`;
  - `service: holding org refused on create`;
  - `service: delete with jobs or items → CONFIG_HAS_HISTORY` (23503 mapped via `isPgForeignKeyViolation`);
  - `route: delete with history answers 409, not 500`, with the existing route suite otherwise green unchanged;
  - `tool: device-bound run refused`; `tool: site-restricted caller refused on writes`;
  - `tool: MFA refused on writes; list unaffected`;
  - `tool: audit actions match the route` (`c2c.config.create|update|delete`);
  - `tool: action enum is exact`.
- [ ] Step 2: run both, expect FAIL.
- [ ] Step 3: implement; the route becomes validate → service → HTTP mapping. Tool gates reuse `orgWideWriteDenied` and `deviceBoundDenied` (`aiToolsSecurityPolicyShared.ts`).
- [ ] Step 4: re-run including the C2C route suites, expect PASS. Commit `feat(ai-tools): W17 C2C config tool over a shared service (#6788)`.

### Task 4: `list_bmr_recoveries` and `get_backup_health`

**Files:** Create `services/aiToolsBackupRecoveryReads.ts`, its test, `services/aiToolSchemasBackupRecoveryReads.ts`. Modify `routes/backup/health.ts` to export `resolveUnmappedDevices`.

**Interfaces — Produces:**
- `registerBackupRecoveryReadTools(aiTools)`.
- `list_bmr_recoveries` input: `action: 'list'|'get'`, `orgId?`, `deviceId?`, `recoveryId?` (required for `get`), `limit?: 1–50`.
- Output row, exact keys: `id, deviceId, snapshotId, identity, status, platform, overdue, codeExpiresAt, codeUsedAt, failureReason, warnings, hasTarget, hasPlan, hasResult, fileIndexStatus, createdAt, updatedAt, mediaBootedAt, plannedAt, restoringAt, validatedAt, rebootedAt, checkedInAt, completedAt`.
- `get_backup_health` input: `orgId?`, `source?: ('breeze'|'provider')[]`, `health?`, `status?`, `withBackup?`, `search?`, `cursor?`, `limit?`, arrays rather than the route's CSV strings. System scope without `orgId` is refused, as at REST.

- [ ] Step 1: failing tests:
  - `byte scan: no target/plan/result/recoveryTokenId` (fixture row with a sentinel in each);
  - `forged closing delimiter does not survive` in `failureReason`, with a control;
  - `warnings clipped to 10 entries of 500 chars`;
  - `site-restricted caller: hidden-site recovery is the same not-found as a missing one`;
  - `device-bound run: only its device`;
  - `get_backup_health: device-bound refused; foreign orgId refused; empty scope returns the all-zero summary, not healthy`.
- [ ] Step 2: run, expect FAIL.
- [ ] Step 3: implement. Site lineage via `authorizeResilienceResources` (`resilienceSiteAuthorization.ts`), the helper the route's `loadAuthorizedRecovery` wraps.
- [ ] Step 4: re-run, expect PASS. Commit `feat(ai-tools): W17 bare-metal recovery and backup health reads (#6788)`.

### Task 5: wiring and classes

**Files:** Modify every row of the Wiring table except locale, index and `mcpCoverage`; `services/aiTools.ts`, `services/aiToolSchemas.ts`, SDK registrations in `services/aiAgentSdkTools.ts`. Tests: add `W17_EXPECTED` to `aiGuardrails.approvalScope.contract.test.ts` (W13/W14 style), rows in `aiGuardrails.routeBinding.contract.test.ts` for all twelve route bindings (verification 4, VSS 1, BMR 2, C2C 4, health 1), and `aiToolSchemas.backupCompleteness.test.ts` (registry keys == Zod keys, enums equal).

- [ ] Step 1: write the failing contract rows, including `W17 every write is MFA-gated`, `no W17 read action is in TIER2_ACTIONS or TIER3_ACTIONS`, and `manage_c2c_configs is never agent-reachable`.
- [ ] Step 2: run `aiGuardrails.approvalScope.contract`, `aiGuardrails.routeBinding.contract`, `aiAgentSdkTools.registryParity.contract`, `aiToolPermissionsCatalogParity.contract`. Expect red on the new names.
- [ ] Step 3: add the entries.
- [ ] Step 4: re-run those plus: `aiGuardrails.tier1WriteActions`, `aiGuardrails.routeParity`, `aiGuardrails.agentPrincipal`, `aiGuardrails.mcpTier3ActionDowngrades`, `aiGuardrails.tierDecidingKeys`, `aiAgentSdkTools.handlerCoverage`, `aiTools.descriptionBudget`, `aiTools.outputBudget`, `aiTools.domainMetadata`, `aiTools.deviceTextFence`, `aiTools.deviceWaitContext`, `aiTools.userOwnedRelease`, `mcpToolPresentation.guardrailParity`, `wisp/toolSubjects.contract`, `__tests__/parkedFanout.contract`. All PASS. Commit `feat(ai-tools): W17 guard classes and wiring (#6788)`.

### Task 6: index and golden prompts

**Files:** Modify `services/aiToolIndex.ts`, `services/aiToolIndex.test.ts` (the exact-byte pin), `services/llm/toolEval/goldenPrompts.ts`, `goldenPrompts.test.ts`.

- [ ] Step 1: bump the golden count and pin first, expect FAIL.
- [ ] Step 2: add the vocabulary and the golden rows.
- [ ] Step 3: measure B1, B2, B3 and full on the branch and on `main`; replace the Budget table with the measured values and put them in the PR body.
- [ ] Step 4: run `aiToolIndex.test`, `aiToolIndex.w15-budget.test`, `aiAgent.toolIndexPrompt.test`, `goldenPrompts.test`, `lazyIndexCases.test`. PASS. Commit.

### Task 7: copy, coverage, web, docs

**Files:** `services/aiGuardrails.ts` (`buildApprovalDescription`), `services/actionIntents/intentService.ts`, `services/actionIntents/actionLabel.ts`, `services/mcpCoverage.ts`, `__tests__/mcp-coverage.test.ts`, `apps/web/src/components/ai-risk/tierConfig.ts`, `apps/web/src/locales/*/settings.json`, `apps/docs/src/content/docs/features/ai.mdx`, `.../mcp-server.mdx`.

Approval copy (exact):
- `run`: "Run a backup {verificationType} check on {device}. Queues a command on the machine."
- `create`: "Create cloud-to-cloud backup config {name}: {scope} for {n} users, schedule {frequency}."
- `update`: "Update cloud-to-cloud backup config {name}: {changedFields}."
- `delete`: "Delete cloud-to-cloud backup config {name}. Refused if it has backup history."

- [ ] Step 1: run `mcp-coverage`, `approvalLabels.contract`, `aiGuardrailsTierConfig.parity`, `aiGuardrailsAiDocs.parity`, `agentToolCatalog.labels.contract`, and web `localeParity`, `translationCoverage`. Expect red on the new names.
- [ ] Step 2: add the entries and labels; delete the five `FROZEN_GAPS` rows.
- [ ] Step 3: re-run, expect PASS. Commit `feat(ai-tools): W17 approval copy, coverage, labels and docs (#6788)`.

### Task 8: integration, merge `main`, PR

**Files:** Create `__tests__/integration/aiToolsBackupCompleteness.integration.test.ts`.

Cases, as `breeze_app` on a per-worktree test stack:
- `manage_backup_verification:list` for org A never returns org B rows (the read runs under system context, so this proves the app predicate), with a control that lifts the predicate and goes red.
- A site-restricted caller sees only allowed-site rows.
- `manage_c2c_configs:delete` with a job row returns `CONFIG_HAS_HISTORY` and the row survives.
- `list_bmr_recoveries` on a recovery with a sentinel in `result`: the serialized output has no sentinel.

- [ ] Step 1: `pnpm test-stack up`, write and run the suite, expect PASS. Run `__tests__/integration/backupVerificationSiteScope.integration.test.ts`. `pnpm test-stack down`.
- [ ] Step 2: TS check (20 GB heap, exit code checked), and `tsc --noEmit` in `apps/web`. Merge `origin/main`; re-run T5's contract sweep and T6's measure.
- [ ] Step 3: open the PR: tool/class table, Decisions as resolved, measured budget, Merge Danger (two-way; no data change; REST behaviour changes only as C2C delete with history 500 → 409), chat smoke prompts. `Closes #6788`, `Part of #6754`. Integration runs only in CI's `integration-test`, so wait for it.

## Follow-ups (not filed)

- Expose verification `refresh` as a t2 action if stale readiness proves a problem; the scheduled job recalculates today.
- When C2C sync ships, re-review `trigger_c2c_sync` and these writes together.
