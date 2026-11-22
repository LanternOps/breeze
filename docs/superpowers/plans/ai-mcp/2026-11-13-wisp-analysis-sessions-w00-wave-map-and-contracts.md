---
spec: docs/superpowers/specs/ai-mcp/2026-11-13-wisp-analysis-sessions-design.md
tracking_issue: LanternOps/breeze#11844
---

# Wisp Analysis Sessions — Wave Map and Cross-Wave Contracts

> **For agentic workers:** this is the orchestrator document. Each wave has its own plan (`2026-11-13-wisp-analysis-sessions-wNN-*.md`) in the `superpowers:writing-plans` format. Where a wave plan and this document disagree on a **name, signature, column, limit or refusal code**, this document wins and the wave plan is corrected. Where they disagree on behaviour, the spec wins.

**Goal:** Let a technician run a long, steered fleet investigation with Wisp: analysis results return to chat, each analysis run can continue from the last with its files, a run can cover a whole customer, and `export_dataset` covers reliability data.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-11-13-wisp-analysis-sessions-design.md` (approved 2026-11-13).

## Wave numbering differs from the spec

The spec's §6 lists W01, W02, W02b, W03, W04, W05. Handle re-validation in the continuation wave needs the frozen dataset permissions, so the scope-and-permissions wave moves ahead of it. Plans use this numbering:

| Plan wave | Spec wave | Name | Depends on | Rigor |
|---|---|---|---|---|
| **W01** | W01 | Results return to chat | — | high (artifact read authz) |
| **W02** | W02b | Scope frame and frozen export grants | — | high (authority, device scope) |
| **W03** | W02 | Continuation and chain bounds | W01, W02 | high (migration, tenancy, spend) |
| **W04** | W03 | Datasets 1: reliability, boot, hardware, service checks | W02 | medium |
| **W05** | W04 | Datasets 2: alerts, patches, change log | W04 | high (sensitive text) |
| **W06** | W05 | Surfaces, guidance, docs, eval | W03 | low–medium |

W01 and W02 can run in parallel. W04 can start as soon as W02 merges.

## Global constraints (every wave)

- **No new flag.** Everything sits behind the existing `aiWorkspaceEnabled()` and `wispEnabled()` (`apps/api/src/config/env.ts`). With either off, nothing changes.
- **Decision D-B stands.** No sandbox state survives a run. No wave adds persistence to `SandboxBackend`.
- **The chat model never supplies an artifact handle to stage.** No launch parameter, tool input or schema accepts one.
- **A run principal has no RBAC role.** Never add a permission check that evaluates the `ai_agent` principal; authority is frozen at admission from the live grant ceiling.
- **Untrusted text is fenced.** Anything that originated in a run or a customer file reaches a model only inside `wrapUntrustedData(...)` (`services/aiInputSanitizer.ts`).
- **Site axis is not enforced by RLS.** Every export adapter narrows through the run's frozen device set; an empty set returns nothing and never means unrestricted.
- **Migrations:** hand-written SQL, idempotent, no inner `BEGIN`/`COMMIT`, named to sort after the newest on `origin/main`. At plan time that is `2027-01-24-170000-portal-access-requests-google-hosted-domain.sql`; **re-check `git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -1` before committing**. Read `apps/api/migrations/README.md` and `docs/agents/tenancy-rls.md` first. Composite FKs to `org_id` are `DEFERRABLE INITIALLY IMMEDIATE`. New columns on `ai_agent_runs` / `ai_run_artifacts` need an export-policy classification. Run `pnpm db:check-drift`.
- **Status/kind columns are `text` + CHECK, never `pgEnum`.**
- **Tests:** Vitest beside source. Run one file with `cd apps/api && npx vitest run <path>`; never `pnpm --filter <pkg> test -- --run <path>`. Red first. Contract suites (org cascade, export policy) run only under Integration Tests: see `docs/agents/testing.md`.
- **Typecheck:** local `tsc` for the API needs a 12 GB heap; check the exit code, do not pipe to `tail`.
- **New `apps/api/src/services` files** must be classified in the parked-fanout / area-gating contract lists (the contract test names the list).
- **Line-keyed contract tests:** `SAFE_WRITE_SITES` in the AI-tool contract tests is keyed by line number; re-run them after editing any `aiTools*.ts` file.
- **Web:** mutations through `runAction`; a new `en` locale key is added to all 8 locales.
- **No internal hosts, IPs or tokens** in code, tests or docs.

## Cross-wave contracts

### C1. Launch parameters (W02 adds `scope`, W03 adds `continueFromRunId`)

`apps/api/src/services/wisp/specialistLaunchers.ts`:

```ts
export const analysisParamsSchema = z.strictObject({
  goal: z.string().trim().min(1).max(2000),
  scope: z.enum(['devices', 'site', 'org']).optional(),   // W02
  deviceIds: z.array(z.uuid()).min(1).max(200).optional(), // W02 raises 25 -> 200
  siteId: z.uuid().optional(),
  continueFromRunId: z.uuid().optional(),                  // W03
});
```

Scope resolution (W02): `scope` omitted with `deviceIds` present means `devices`; omitted with only `siteId` means `site`; omitted with neither is refused `scope_required`. `devices` requires `deviceIds`; `site` requires `siteId`; `org` forbids both.

### C2. Frozen run inputs (`AiAgentRunStagedInputs`, `apps/api/src/db/schema/aiAgents.ts`)

```ts
export type AnalysisSensitiveGate = 'security_events' | 'user_account_changes';
export interface AiRunExportGrants { datasets: string[]; sensitiveGates: AnalysisSensitiveGate[] }
export interface AiAgentRunStagedInputs {
  handles: string[];
  deviceIds: string[];
  region: 'eu' | 'us';
  scope?: { kind: 'devices' | 'site' | 'org'; siteId: string | null; deviceCount: number }; // W02
  exportGrants?: AiRunExportGrants;                                                         // W02
}
```

Both new fields are optional so a run admitted before W02 still executes. **Absent `exportGrants` means legacy:** the original seven datasets are allowed and no sensitive gate is held.

### C3. Limits (`AiAgentLimits`, `packages/shared/src/types/aiAgents.ts` + `validators/aiAgents.ts`)

| Field | Default | Validator | Wave |
|---|---|---|---|
| `analysisMaxFrameDevices` | 1000 | int 50–5000 | W02 |
| `analysisMaxChainDepth` | 8 | int 1–20 | W03 |
| `analysisMaxChainRuns` | 12 | int 1–40 | W03 |
| `analysisMaxChainBudgetCents` | 600 | int 50–5000 | W03 |

Every read uses `limits.x ?? AI_AGENT_LIMIT_DEFAULTS.x` (snapshots taken before the field existed lack it). Follow whatever the existing `analysis*` fields do for the policy-snapshot version bump and settings UI exposure.

### C4. Columns (W03 migration `2027-01-25-100000-ai-analysis-run-lineage.sql`)

`ai_agent_runs`:
- `continued_from_run_id uuid null`
- `chain_root_run_id uuid null`
- `chain_depth smallint not null default 0`
- FKs `(continued_from_run_id, org_id)` and `(chain_root_run_id, org_id)` → `ai_agent_runs (id, org_id)`, `ON DELETE SET NULL (<pointer column>)`, `DEFERRABLE INITIALLY IMMEDIATE`.
- Partial index `ai_agent_runs_chain_root_idx` on `(org_id, chain_root_run_id) WHERE chain_root_run_id IS NOT NULL`.
- Partial index `ai_agent_runs_continued_from_idx` on `(continued_from_run_id) WHERE continued_from_run_id IS NOT NULL` (so the FK's set-null on delete does not scan the table).
- CHECK `ai_agent_runs_chain_chk`: `chain_depth >= 0 AND (chain_depth > 0 OR (continued_from_run_id IS NULL AND chain_root_run_id IS NULL))`. One direction only: `ON DELETE SET NULL` clears each pointer independently, so a two-way check would make deleting an ancestor fail (the same lesson as `ai_agent_runs_depth_chk` in `2027-01-05-100400-wisp-specialist-lineage.sql`).

`ai_run_artifacts`:
- `dataset text null` — set by `export_dataset` to the dataset name; null for every other artifact.

Drizzle names: `continuedFromRunId`, `chainRootRunId`, `chainDepth`, `dataset`.

### C5. `trigger_ref` keys on an analysis run

`source: 'chat_analysis'` (unchanged), plus:
- `originSessionId: string | null` — W01. The chat session that launched the run; null on the assessment path.
- `continuation: { fromRunId: string; seed: string; dropped: { handle: string; reason: ChainHandleDropReason }[] }` — W03.

### C6. Shared functions

| Function | File | Wave | Signature |
|---|---|---|---|
| `renderAnalysisRunResult` | `services/workspace/analysisResultRender.ts` | W01 | `(input: { outcome: AnalysisOutcome \| null; summary: string \| null; artifacts: AiRunResultArtifactRef[]; chain?: { depth: number } }) => string` — returns the fenced body, capped at 8192 bytes |
| `EXPORT_DATASET_REQUIREMENTS` | `services/aiToolsExportPermissions.ts` (zero-import leaf) | W02 | `Readonly<Record<ExportDataset, { permission: { resource: string; action: string }; sensitiveGate?: { gate: AnalysisSensitiveGate; permission: { resource: string; action: string } } }>>` |
| `resolveExportGrants` | `services/aiToolsExportPermissions.ts` | W02 | `(has: (resource: string, action: string) => boolean) => AiRunExportGrants` |
| `resolveAnalysisFrame` | `services/aiAgents/analysisFrame.ts` | W02 | `(input: { orgId: string; scope: 'devices' \| 'site' \| 'org'; deviceIds: string[]; siteId: string \| null; allowedSiteIds: string[] \| null; maxInputDevices: number; maxFrameDevices: number }) => Promise<{ ok: true; deviceIds: string[]; scope: NonNullable<AiAgentRunStagedInputs['scope']> } \| { ok: false; refusal: AnalysisFrameRefusal }>` |
| `analysisContinuationOf` | `services/aiAgents/analysisContinuation.ts` | W03 | `(input: { orgId: string; runId: string; grantId?: string }) => Promise<{ ok: true; prior: AnalysisChainPrior } \| { ok: false; refusal: AnalysisContinuationRefusal }>` |
| `deriveChainHandles` | `services/aiAgents/analysisContinuation.ts` | W03 | `(input: { orgId: string; prior: AnalysisChainPrior; grantId: string; exportGrants: AiRunExportGrants }) => Promise<{ handles: string[]; dropped: { handle: string; reason: ChainHandleDropReason }[] }>` |
| `chainCommittedCents` | `services/aiAgents/analysisContinuation.ts` | W03 | `(tx, input: { orgId: string; chainRootRunId: string }) => Promise<{ committedCents: number; runCount: number }>` |
| `timeRangeFromFilters` | `services/aiToolsExportShared.ts` | W04 | `(filters: Record<string, unknown>) => { start: Date; end: Date }` — default last 30 days, max span 180 days, throws `ExportFilterError('invalid_time_range')` |

`AnalysisChainPrior = { id: string; orgId: string; grantId: string; chainRootRunId: string | null; chainDepth: number; stagedInputs: AiAgentRunStagedInputs | null; goal: string; originSessionId: string | null }`. A run with no grant can never be continued.

### C7. Refusal codes

| Code | Raised by | Meaning |
|---|---|---|
| `scope_required` | W02 | no scope and no devices |
| `frame_empty` | W02 | site/org frame resolves to zero devices (an empty frozen list must never be stored: downstream reads it as "no frame") |
| `frame_too_large` | W02 | site/org frame exceeds `analysisMaxFrameDevices` |
| `site_not_in_scope` | W02 | site not in org, or outside the grant's site restriction |
| `too_many_input_devices` | existing | explicit list exceeds `analysisMaxInputDevicesPerRun` |
| `dataset_not_permitted` | W02 (handler) | dataset outside the run's frozen `exportGrants` |
| `analysis_continuation_not_found` | W03 | prior run missing **or in another org** (same answer) |
| `analysis_continuation_wrong_kind` | W03 | prior is not an `analysis` run |
| `analysis_continuation_other_grant` | W03 | prior is under a different grant |
| `analysis_continuation_not_settled` | W03 | prior still running |
| `analysis_chain_too_long` | W03 | depth or run-count bound |
| `analysis_chain_budget_exceeded` | W03 | chain budget bound |

Launch refusals get a technician-readable message in `services/wisp/specialistRefusalMessages.ts` that names the setting to change. The `analysis_continuation_*` codes travel as the `detail` of the existing `continuation_refused` refusal and the chain and frame codes as the `detail` of `admission_skipped`, matching how refusals work today. `dataset_not_permitted` is a tool error the run's own model sees, so its message lives in the `export_dataset` handler. `ChainHandleDropReason = 'expired' | 'kind' | 'outside_chain' | 'other_grant' | 'dataset_not_permitted' | 'over_cap'`.

### C7a. Rules settled during planning

- **Thread rule (spec §4.2).** Continuation and chat reads of output files require the same live grant; there is no session-ancestry check and no `resolveSessionAncestry`. Result delivery (`specialistResultsTurn.ts`) keeps matching the exact origin session.
- **Where things resolve.** The device frame resolves **inside admission** (`createAndEnqueueAgentRun`, which already holds the live ceiling and the limits snapshot). Export grants are evaluated **in the launcher** against `ctx.ceiling` and passed to admission as trusted internal input.
- **Policy snapshot version:** W02 bumps to 17, W03 bumps once more.
- **`launch_specialist` text budget.** Tool description ≤ 300 chars, each parameter ≤ 160 (`aiTools.descriptionBudget.contract.test.ts`). W02 writes the params text with `scope`; **W06 owns the final wording** (it adds `continueFromRunId` and moves guidance to an `analysisLaunchMessage` returned on admission). W03 does not edit the tool text.
- **Chain step in chat results.** W03 passes `chain: { depth }` into W01's `renderAnalysisRunResult` at the results-turn call site, with a test.
- **Decommissioned devices** are left out of site and org frames and kept when listed explicitly.

### C8. Datasets (W04, W05)

W04: `reliability_scores`, `reliability_history`, `reliability_events`, `boot_performance`, `hardware_events`, `service_checks`.
W05: `alerts`, `patch_state`, `patch_attempts`, `change_log`.

- `EXPORT_DATASETS` is the single list. W04 moves it to a zero-import leaf, `services/aiToolsExportDatasetNames.ts`, re-exported from `aiToolsExportDatasets.ts` (importing the hub into `aiToolSchemas.ts` would close an import cycle through `aiTools.ts` and crash at module load). Both Zod enums derive from the leaf; W04 adds the drift test.
- **Adapter request fields (W02 creates, W04/W05 use):** `DatasetRequest.exportGrants: AiRunExportGrants` (the run's frozen grants) and `DatasetRequest.notes: string[]` (adapter notes the handler copies into the tool result, for example withheld sensitive rows or an unapplied time range).
- **Current-state datasets** (`reliability_scores`, `patch_state`) validate `timeRange` but do not apply it, and say so in a note.
- **`service_checks` exports non-running checks only** in v1 (the table is large and has no usable index; a partial index on non-running rows backs it). The tool description and a result note say so.
- **`reliability_events` may repeat an event** (agents re-send overlapping windows). Each row carries the dedup key reliability scoring uses and a note tells the model to dedupe on it.
- **Migrations:** W04 `2027-01-25-110000-*`, W05 `2027-01-25-120000-*`, after W03's `2027-01-25-100000-*`. Whichever wave merges later re-checks the newest migration on `origin/main` and renames its own unshipped file if needed; never rename a shipped one.
- New adapters live in `services/aiToolsExportDatasets/` (`reliability.ts`, `hardware.ts`, `serviceChecks.ts`, `boot.ts`, `alerts.ts`, `patches.ts`, `changes.ts`); `aiToolsExportDatasets.ts` stays the hub that assembles `DATASET_ADAPTERS`.
- Every new adapter is set-based (one keyset query filtered by the device set), tier 1, uses `timeRangeFromFilters`, and redacts its free-text columns explicitly.
- Every dataset has an entry in `EXPORT_DATASET_REQUIREMENTS` (W02 creates the record for the seven existing datasets; W04/W05 extend it). A test asserts the record's keys equal `EXPORT_DATASETS`.

## Wave plans

| Wave | Plan |
|---|---|
| W01 | `2026-11-13-wisp-analysis-sessions-w01-results-return.md` |
| W02 | `2026-11-13-wisp-analysis-sessions-w02-scope-frame-export-grants.md` |
| W03 | `2026-11-13-wisp-analysis-sessions-w03-continuation.md` |
| W04 | `2026-11-13-wisp-analysis-sessions-w04-datasets-reliability.md` |
| W05 | `2026-11-13-wisp-analysis-sessions-w05-datasets-alerts-patches-changes.md` |
| W06 | `2026-11-13-wisp-analysis-sessions-w06-surfaces.md` |
