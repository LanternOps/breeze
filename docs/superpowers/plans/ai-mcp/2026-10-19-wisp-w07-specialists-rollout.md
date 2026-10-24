---
spec: docs/superpowers/specs/ai-mcp/2026-10-19-wisp-orchestrator-design.md
orchestrator: docs/superpowers/plans/ai-mcp/2026-10-19-wisp-w00-wave-map-and-contracts.md
wave: W07
depends_on: [W02, W05]
tracking_issue: LanternOps/breeze#9906
---

# Wisp W07 — Specialist Requests, Rollout, Private Gap-Finder: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an assessment (W05) or a human Wisp chat turn hand bounded work to the existing specialist agents through one deterministic coordinator that pins every child to the grant revision at depth 1, splits auto-admitted kinds from approval-card kinds, and ship the observability, docs, rollout checklist and Todd's system-scope gap-finder that make Wisp operable.

**Architecture:** `services/wisp/coordinator.ts` is the only code that creates specialist work (runs, Operator tasks, sandbox analysis). It is reached three ways — the `request_specialist` outcome tool (recorded during an assessment, dispatched post-run by a finalizer), the Tier-2 chat tool `launch_specialist` (human session under a grant), and the release of a `wisp_specialist_request` carrier intent (the approval card, modelled on `operator_plan`). No model-callable tool launches a run; the deny on `workspace_launch_analysis` in `aiToolExposure.ts` is untouched. Lineage lives in three new columns on `ai_agent_runs` and `ai_operator_tasks`; admission refuses a grant-bearing child that is itself a child.

**Tech Stack:** Hono/TypeScript API, Drizzle (queries only) + hand-written SQL migration, BullMQ (existing run/sweep/release workers), prom-client, Astro + React (web), Starlight (docs), Vitest.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-10-19-wisp-orchestrator-design.md` — §3 (autonomy line), §4.5 (sub-agents, depth one), §4.6 (`workspace_*` landmine), §7.5 (specialist requests), §11 (private gap-finder paragraph only), §13–§15. Names and signatures come from the orchestrator doc (w00), which wins over this plan on any name/signature/table/flag disagreement.

## Execution split and parallelism (orchestrator, 2026-10-23)

W07 is split into two sub-issues that run **in parallel**:
- **W07a — Specialists API** (sub-issue #9913, branch `feature/9906-wisp/wave-9913`): Tasks 1 (+ edits), 2, 3, 4, 5, 6, 8, 10 (+ edit), 12. Owns `packages/shared`, `apps/api/**`, the CLI gap-finder.
- **W07b — Specialists web, admin page, docs** (sub-issue #9920, branch `feature/9906-wisp/wave-9920`): Tasks 7 (web half; the API DTO half stays in W07a Task 7-API), 9, 11. Owns `apps/web/**`, `apps/docs/**`, release-notes draft, env sweep.

PARALLEL GROUPS (W07a): G1 = Task 1 ∥ Task 8-metrics-registry. G2 = Task 2 ∥ Task 3 ∥ Task 12 (depth guard, coordinator, bulk reply — bulk reply is its own specialist file). G3 = Task 4 ∥ Task 5 ∥ Task 6 ∥ Task 7-API. Task 10 last.
PARALLEL GROUPS (W07b): G1 = Task 7-web ∥ Task 9 ∥ Task 11-docs. Task 11-rollout-checklist last.
**Sonnet:** Task 7 DTO plumbing + locales, Task 9 admin page scaffold + locales, Task 11 docs/release-notes/env sweep, Task 8 metric registration boilerplate.
**Rules for every sub-issue and parallel group**
- Every part bases on `origin/main` and targets `main` (never a stacked PR). The w00 contracts are the oracle, so parts can be built against each other's interfaces before they merge; web/mobile tests mock the API.
- **Shared-package ownership:** the API part owns `packages/shared` additions. A web/mobile part that needs a type not yet on main copies the file **verbatim** from the API part's branch (`git show origin/feature/9906-wisp/wave-<api#>:<path>`) into the same path; whichever PR lands second rebases, and byte-identical files resolve cleanly. Never re-type a contract.
- **In-wave fan-out:** tasks inside one PARALLEL GROUP are file-disjoint and may run as concurrent subagents in the same worktree. Concurrent subagents never run `git commit`; the fixer commits once per group after all members pass. Groups run in the listed order.
- **Model routing:** the session and every tenancy/auth/permission/migration task are Opus. Tasks marked **Sonnet** are mechanical (locale fan-out, page scaffolds, pure helpers, docs, DTO plumbing) and run on Sonnet subagents with an Opus reviewer.
- The part that lands last owns the whole-wave verification task and the PR-body statement that covers both parts.

## Global Constraints

- **Dark by default.** Every new route, tool handler, finalizer and job short-circuits when `wispEnabled()` (`apps/api/src/config/env.ts`, W02) is false. With `BREEZE_WISP_ENABLED` unset nothing in this wave changes runtime behaviour; the registration-only changes (tool maps, schema columns) are inert.
- **Entitlement is the commercial switch, never a kill-switch override.** The coordinator re-checks the `wisp` entitlement at claim time (W01 service read); it never bypasses `BREEZE_AI_AGENTS_ENABLED`, `readAiKillState`, or `aiWorkspaceEnabled()`.
- **Authority is structural.** Every coordinator decision passes `resolveGrantCeiling` + `assertWithinCeiling` (W02). The `ai_agent` principal stays; no synthetic user, no impersonation. The approval path rebuilds the *approver's* authority with `buildApproverAuthContextForIntent` (`services/actionIntents/actorContext.ts:203`), never the grantor's.
- **No model-callable tool launches a run** (spec §7.5). `workspace_launch_analysis` stays in `AGENT_HUMAN_ONLY_TOOLS` (`services/aiToolExposure.ts:76`) and `services/workspace/workspaceLaunchTool.registration.test.ts` keeps passing unchanged. `launch_analysis` is a coordinator code path, not a registered tool (w00 "Specialists (W07)").
- **Depth is one.** Children carry `depth = 1`; admission refuses `grant` input whose requesting run has `depth >= 1` or is not an `assessment` run.
- **Migration** `apps/api/migrations/2027-01-04-100600-wisp-specialist-lineage.sql`; re-check `ls apps/api/migrations/*.sql | sort | tail -1` before committing (newest at plan time: `2027-01-03-140000-report-type-client-profitability.sql`; W02–W06 take `100100`–`100500`). Idempotent, no inner `BEGIN`/`COMMIT`, DDL only (no `set_config` needed — the file writes no rows).
- **Export policy:** every new column on `ai_agent_runs` / `ai_operator_tasks` is classified in `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts:114`); the three are plain uuid/smallint → `included`. Run `tenant-export-policy.integration.test.ts` + `tenantCascade.integration.test.ts` under **Integration Tests** before the PR.
- **Six registries** for the two new tool names: `aiTools` map, `TOOL_TIERS` (`aiAgentSdkTools.ts:191`; *not* for the human-only carrier — see Task 4), `TOOL_CAPABILITY` (`aiAgents/agentToolCatalog.ts:97`), MCP `tool()` in `createBreezeMcpServer` (`launch_specialist` only), `toolInputSchemas` (`aiToolSchemas.ts:192`), `TOOL_PERMISSIONS` (`aiGuardrails.ts:911`). Deny-list changes are limited to adding `launch_specialist` to `AGENT_HUMAN_ONLY_TOOLS` and `wisp_specialist_request` to `HUMAN_ONLY_TOOLS`; spec §7.5 is the sign-off.
- **Status/kind values are `text` + CHECK**, never `pgEnum`.
- **Web mutations** go through `runAction`; every new `en` locale key is added to all seven other locale directories (`apps/web/src/locales/{de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}`); admin nav entries use `platformAdminOnly: true` in `apps/web/src/components/layout/Sidebar.tsx`.
- **Tests** beside source; run one file with `cd apps/api && npx vitest run <path>`; never `pnpm --filter <pkg> test -- --run <path>`. Red first.
- **No internal hosts/IPs/tokens** anywhere, including the gap-finder's prompt, report template and the rollout doc. Gap-finder output goes only under `internal/` (gitignored by `/internal/*`).
- **Copy:** product name **Wisp**; identifiers `wisp_*` / `wisp*`.

## Review Focus

1. **Grant paused or revoked between approval and release.** A `wisp_specialist_request` card approved at 09:00 and released at 09:05 after the grantor was suspended must *not* admit a child; the release terminalizes `failed` with `grant_inactive`. Pinned in Task 4.
2. **Approver without the kind's permission.** Any org member holding the carrier's RBAC mapping (`ai_sessions:use`, w00 A1) can be an eligible approver of an agent-minted card (`resolveAgentIntentApprovers`), but every kind needs `ai_agents:write` and an `analysis` request also needs `ai_workspace:execute`; release re-checks the *approver's* permissions (coordinator gate 8) and refuses `permission_missing` / `workspace_execute_required` rather than admitting under the grantor's. Pinned in Task 4.
3. **Duplicate dispatch of one request id** (finalizer retried, release job redelivered): exactly one child row exists afterwards, and the second call returns `admitted` with the same `runId`/`taskId`. Pinned in Task 3.
4. **Specialist for an org outside the ceiling** (an assessment anchored on org A naming org B, or a one-org grant naming another org): `refused: 'org_out_of_ceiling'` before any admission call. Pinned in Task 3.
5. **Exhausted grant budget.** No specialist is admitted while `chargeableUnderGrant` says `budget_exhausted`, even for auto-admit kinds; the refusal is recorded on the assessment outcome so the digest can say why. Pinned in Task 3.

## Reconciliation notes (w00 ↔ spec ↔ code)

- **"Partner's auto-approved T2 set" does not exist in code.** The only durable pre-authorization list is `ai_agents.actAssets.supervisedActionKeys` (per-org agent, `POLICY_DECIDABLE_TIER3` keys, four-eyes graduated — `aiAgents/supervisedKeyGrant.ts`), and agent-minted Tier-2 intents are *always* `supervised` (`intentService.ts:1458`). `auto_approve` at `db/schema/ai.ts:19` is a per-chat-session approval mode. W07 therefore ships a **code-owned registry** `SPECIALIST_KIND_POLICY` (Task 1) with `autoAdmit: true` for exactly the kinds spec §3 lists under "acts alone" (`sweep`, `analysis`); a partner-configurable override is a follow-up, not this wave.
- **Approval card minting.** `operator_plan` is minted under the task *requester* (a human, `buildTaskActorAuthContext`), which makes the requester ineligible to approve it. Wisp's card must be one-tap for the grantor, so `wisp_specialist_request` is minted under the **assessment run's agent principal** (`source: 'ai_agent'`), decided by `resolveAgentIntentApprovers` (org/partner members holding the tool's RBAC mapping). The grantor qualifies whenever `ai_agents:write` is in their ceiling.
- **`launch_analysis`** is listed as a registered tool in spec §14 but as a coordinator-only path in w00; w00 wins. The registered chat tool is `launch_specialist` (kind-multiplexed).
- **Partner Admin backfill is unnecessary.** The seeded Partner Admin role holds `'*:*'` (`db/seed.ts:343`), `partnerCreate.ts:159` copies that row, and `permissionMatching.ts:20` matches `resource === '*'`. The rollout checklist carries a verification query instead of a migration.
- **Depth guard input.** W02 ships `grant.requestedByRunId` and a **thrown** `GrantDepthExceededError` (code `grant_depth_exceeded`, w00 A11 — not a skip reason) whose W02 predicate is "requesting run under the same grant and org". W07 tightens that predicate with the lineage columns (`depth === 0 && profile === 'assessment'`) and stamps lineage (Task 2). The coordinator checks depth itself before admission, so reaching the throw is a caller bug.
- **Permissions (w00 A1).** Every Wisp tool gates on `ai_sessions:use` in `TOOL_PERMISSIONS`; the per-kind `requiredPermissions` in `SPECIALIST_KIND_POLICY` are *ceiling* terms the coordinator checks against the grantor's (and approver's) concrete permission keys, not route/tool gates.

---

### Task 1: Specialist kind policy, lineage columns, export classification

**Files:**
- Create: `apps/api/src/services/wisp/specialistPolicy.ts`
- Create: `apps/api/src/services/wisp/specialistPolicy.test.ts`
- Create: `apps/api/migrations/2027-01-04-100600-wisp-specialist-lineage.sql`
- Modify: `apps/api/src/db/schema/aiAgents.ts` (after `taskAttemptOrdinal`, ~line 196)
- Modify: `apps/api/src/db/schema/aiOperatorTasks.ts` (after `requesterUserId`, line 150)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:114` (`ai_agent_runs`) and the `ai_operator_tasks` entry
- Test: `apps/api/src/db/autoMigrate.test.ts`, `apps/api/src/db/migrationRlsScope.test.ts`, `apps/api/src/__tests__/integration/tenant-export-policy.integration.test.ts`

**Interfaces:**
- Consumes: w00 `SpecialistKind`.
- Produces:
  ```ts
  // specialistPolicy.ts — leaf module, NO imports
  export type SpecialistKind = 'sweep' | 'analysis' | 'operator_recipe' | 'patch_plan' | 'remediation_research';
  export const SPECIALIST_KINDS: readonly SpecialistKind[];
  export interface SpecialistKindPolicy {
    kind: SpecialistKind;
    operationKey: `launch_specialist:${SpecialistKind}`;
    autoAdmit: boolean;              // true ⇔ spec §3 "acts alone"
    requiredPermissions: readonly string[]; // 'ai_agents:write' always; analysis adds 'ai_workspace:execute'
    estimateCents: number;           // grant-budget pre-check (Task 3)
    requiresDevice: boolean;         // remediation_research only
  }
  export const SPECIALIST_KIND_POLICY: Readonly<Record<SpecialistKind, SpecialistKindPolicy>>;
  export const MAX_SPECIALIST_REQUESTS_PER_ASSESSMENT = 3;
  export function isSpecialistKind(value: unknown): value is SpecialistKind;
  ```
  Values: `sweep { autoAdmit: true, estimateCents: 25 }`, `analysis { autoAdmit: true, requiredPermissions: ['ai_agents:write','ai_workspace:execute'], estimateCents: 100 }`, `operator_recipe { autoAdmit: false, estimateCents: 50 }`, `patch_plan { autoAdmit: false, estimateCents: 50 }`, `remediation_research { autoAdmit: false, estimateCents: 50, requiresDevice: true }`.
- New columns (both tables): `requested_by_run_id uuid NULL`, `parent_grant_revision_id uuid NULL`, `depth smallint NOT NULL DEFAULT 0`. Drizzle names `requestedByRunId`, `parentGrantRevisionId`, `depth`.

- [ ] **Step 1: Write the failing policy test**

```ts
// specialistPolicy.test.ts
import { readFileSync } from 'node:fs';
import { SPECIALIST_KINDS, SPECIALIST_KIND_POLICY, isSpecialistKind } from './specialistPolicy';

it('auto-admits exactly the "acts alone" kinds of spec §3', () => {
  const auto = SPECIALIST_KINDS.filter((k) => SPECIALIST_KIND_POLICY[k].autoAdmit);
  expect(auto).toEqual(['sweep', 'analysis']);
});
it('every kind requires ai_agents:write; analysis also requires ai_workspace:execute', () => {
  for (const k of SPECIALIST_KINDS) expect(SPECIALIST_KIND_POLICY[k].requiredPermissions).toContain('ai_agents:write');
  expect(SPECIALIST_KIND_POLICY.analysis.requiredPermissions).toContain('ai_workspace:execute');
});
it('operation keys are launch_specialist:<kind>', () => {
  for (const k of SPECIALIST_KINDS) expect(SPECIALIST_KIND_POLICY[k].operationKey).toBe(`launch_specialist:${k}`);
});
it('is a leaf module', () => {
  expect(readFileSync(new URL('./specialistPolicy.ts', import.meta.url), 'utf8')).not.toMatch(/^import /m);
});
it('rejects unknown kinds', () => { expect(isSpecialistKind('run_script')).toBe(false); });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/wisp/specialistPolicy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `specialistPolicy.ts`** with the exports and values above.

- [ ] **Step 4: Write the migration**

`2027-01-04-100600-wisp-specialist-lineage.sql`, idempotent `ADD COLUMN IF NOT EXISTS` ×3 on each table, then (in `DO $$ … EXCEPTION WHEN duplicate_object` blocks):
- `ai_agent_runs_requested_by_run_fk FOREIGN KEY (requested_by_run_id, org_id) REFERENCES ai_agent_runs(id, org_id) ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE` (the `(id, org_id)` unique exists: `ai_agent_runs_id_org_id_key`, migration `2026-09-05-a-agent-originated-intents.sql:47`).
- `ai_operator_tasks_requested_by_run_fk FOREIGN KEY (requested_by_run_id, org_id) REFERENCES ai_agent_runs(id, org_id) ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE`.
- `…_parent_grant_revision_fk FOREIGN KEY (parent_grant_revision_id) REFERENCES wisp_grant_revisions(id) ON DELETE SET NULL` on both (SQL-only, like `task_id`; no Drizzle `references()` — avoids an import cycle into W02's schema file).
- `…_depth_chk CHECK (depth IN (0, 1) AND (depth = 0 OR parent_grant_revision_id IS NOT NULL))` on both.
- Partial index `ai_agent_runs_requested_by_run_idx ON ai_agent_runs (requested_by_run_id) WHERE requested_by_run_id IS NOT NULL` (the admin page and the finalizer query by it).

- [ ] **Step 5: Drizzle schema + export policy**

Add the three columns to both schema files (plain `uuid()`/`smallint()`, no `references()`), and append `requested_by_run_id`, `parent_grant_revision_id`, `depth` to the `included` list of both `tablePolicy` entries in `tenantExportPolicyRegistry.ts`.

- [ ] **Step 6: Verify**

Run: `cd apps/api && npx vitest run src/services/wisp/specialistPolicy.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`
Expected: PASS.
Run: `pnpm test-stack up && cd apps/api && pnpm db:migrate && pnpm db:migrate && pnpm db:check-drift` (second migrate proves idempotency; drift clean).
Run: `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/wisp/specialistPolicy.ts apps/api/src/services/wisp/specialistPolicy.test.ts apps/api/migrations/2027-01-04-100600-wisp-specialist-lineage.sql apps/api/src/db/schema/aiAgents.ts apps/api/src/db/schema/aiOperatorTasks.ts apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "feat(wisp): specialist kind policy and run/task lineage columns (W07)"
```

---

### Task 2: Admission depth guard and lineage stamping

**Files:**
- Modify: `apps/api/src/services/aiAgents/runService.ts` (`CreateAgentRunInput` ~235, `AgentRunSkipReason` ~396, admission step 1d (W02), insert ~1795/1881)
- Modify: `apps/api/src/services/aiAgents/analysisAdmission.ts` (`AdmitAnalysisRunInput`, `SKIP_REASON_REFUSALS`)
- Modify: `apps/api/src/services/aiOperator/taskService.ts` (`AdmitServiceRecoveryTaskInput`, insert ~302)
- Test: `apps/api/src/services/aiAgents/runService.test.ts`, `apps/api/src/services/aiAgents/analysisAdmission.test.ts`, `apps/api/src/services/aiOperator/taskService.recipeAdmission.test.ts`, `apps/api/src/__tests__/integration/agentRunAdmission.integration.test.ts`

**Interfaces:**
- Consumes (W02): `CreateAgentRunInput.grant?: { grantId: string; grantRevisionId: string; requestedByRunId?: string | null }`, admission step 1d, skips `grant_inactive | grant_org_out_of_ceiling`, thrown `GrantDepthExceededError` (code `grant_depth_exceeded`); `ai_operator_tasks.grant_id/grant_revision_id`; `AdmitServiceRecoveryTaskInput.grant?: { grantId; grantRevisionId }`.
- Produces:
  ```ts
  // runService.ts — the W02 depth-guard predicate is tightened (no new field, no new skip reason — w00 A11)
  //   throw GrantDepthExceededError unless requesting run has depth === 0 && profile === 'assessment' && grantId === grant.grantId && orgId === input.orgId
  // taskService.ts — additive
  grant?: { grantId: string; grantRevisionId: string; requestedByRunId?: string | null };
  // analysisAdmission.ts
  AdmitAnalysisRunInput.grant?: CreateAgentRunInput['grant'];
  AnalysisAdmissionRefusal gains 'grant_refused'  // grant_inactive + grant_org_out_of_ceiling skips map onto it; a GrantDepthExceededError is caught and mapped onto it too
  ```
- Stamping rule (both inserts): when `grant.requestedByRunId` is set → `requested_by_run_id = it`, `parent_grant_revision_id = grant.grantRevisionId`, `depth = 1`; when `grant` is set without a requesting run → `depth = 0`, lineage NULL (an assessment).

- [ ] **Step 1: Write the failing unit tests**

```ts
// runService.test.ts (uses the file's existing db mock helpers)
it('throws GrantDepthExceededError when the requesting run is itself a child', async () => {
  mockRunRow({ id: 'child', depth: 1, profile: 'sweep', grantId: 'g' });
  await expect(createAndEnqueueAgentRun(baseInput({ grant: { grantId: 'g', grantRevisionId: 'rev', requestedByRunId: 'child' } }))).rejects.toMatchObject({ code: 'grant_depth_exceeded' });
});
it('throws GrantDepthExceededError when the requesting run is grant-bearing but not an assessment', async () => {
  mockRunRow({ id: 'r', depth: 0, profile: 'sweep', grantId: 'g' });
  await expect(createAndEnqueueAgentRun(baseInput({ grant: { grantId: 'g', grantRevisionId: 'rev', requestedByRunId: 'r' } }))).rejects.toMatchObject({ code: 'grant_depth_exceeded' });
});
it('stamps depth 1 + lineage for a child and depth 0 for an assessment', async () => { /* assert the insert values */ });
```
```ts
// analysisAdmission.test.ts
it('maps the grant_* skips onto grant_refused and catches GrantDepthExceededError as grant_refused', () => {
  expect(SKIP_REASON_REFUSALS.grant_inactive).toBe('grant_refused');
  expect(SKIP_REASON_REFUSALS.grant_org_out_of_ceiling).toBe('grant_refused');
  /* createAndEnqueueAgentRun mocked to throw GrantDepthExceededError → { refused: 'grant_refused' } */
});
it('forwards grant to createAndEnqueueAgentRun', async () => { /* spy on createAndEnqueueAgentRun; expect grant in the call */ });
```
```ts
// taskService.recipeAdmission.test.ts
it('writes grant lineage columns on the task row', async () => { /* expect insert values grantId, grantRevisionId, requestedByRunId, parentGrantRevisionId, depth: 1 */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiAgents/runService.test.ts src/services/aiAgents/analysisAdmission.test.ts src/services/aiOperator/taskService.recipeAdmission.test.ts`
Expected: FAIL (the W02 guard admits a same-grant `sweep` requester; lineage columns not stamped; `grant_refused` absent).

- [ ] **Step 3: Implement**

In `runService.ts`, inside W02's depth guard (step 1d): extend the loaded row to `{ depth, profile, grantId, orgId }` and throw `GrantDepthExceededError` unless `depth === 0 && profile === 'assessment' && grantId === grant.grantId && orgId === input.orgId`. Stamp the three columns in both insert sites. In `analysisAdmission.ts` add the two map entries, catch `GrantDepthExceededError` → `grant_refused`, and forward `input.grant`. In `taskService.ts` thread `grant` to the insert.

- [ ] **Step 4: Integration case**

Append to `agentRunAdmission.integration.test.ts`: create an `assessment` run row with `grant_id`, then admit a `sweep` child with `grant.requestedByRunId` → created, `depth = 1`, `parent_grant_revision_id` set; then admit a grandchild naming the child → rejects with `GrantDepthExceededError` and no row.

- [ ] **Step 5: Verify**

Run: `cd apps/api && npx vitest run src/services/aiAgents/runService.test.ts src/services/aiAgents/analysisAdmission.test.ts src/services/aiOperator/taskService.recipeAdmission.test.ts && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/agentRunAdmission.integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/aiAgents/runService.ts apps/api/src/services/aiAgents/runService.test.ts apps/api/src/services/aiAgents/analysisAdmission.ts apps/api/src/services/aiAgents/analysisAdmission.test.ts apps/api/src/services/aiOperator/taskService.ts apps/api/src/services/aiOperator/taskService.recipeAdmission.test.ts apps/api/src/__tests__/integration/agentRunAdmission.integration.test.ts
git commit -m "feat(wisp): admission depth guard and lineage stamping for specialist children (W07)"
```

---

### Task 3: The Wisp coordinator — `requestSpecialist`

**Files:**
- Create: `apps/api/src/services/wisp/coordinator.ts`
- Create: `apps/api/src/services/wisp/specialistLaunchers.ts`
- Create: `apps/api/src/services/wisp/coordinator.test.ts`
- Create: `apps/api/src/services/wisp/specialistLaunchers.test.ts`
- Modify: `apps/api/src/jobs/aiAgentSweepScheduler.ts` (`SweepJobData`, `buildAdmission()` ~710–760)

**Interfaces:**
- Consumes: W02 `resolveGrantCeiling`, `assertWithinCeiling`, `GrantCeiling` (incl. `grantorUserId`, `partnerId`), `GrantInactiveError`, `CeilingViolationError`; W05 `chargeableUnderGrant(grantId, estimateCents)`; W01 `hasEntitlement(partnerId, 'wisp')` (`services/entitlements.ts`); `createAndEnqueueAgentRun` (Task 2 shape); `admitAnalysisRun`; `admitServiceRecoveryTask`; `resolveEffectiveAgentSystem(orgId, kind)` (`aiAgents/effectivePolicy.ts`); `getRecipe(workflowKey, workflowVersion)` (`aiOperator/recipes/index.ts:59`); `getAiAgentSweepQueue`, `loadEnabledBaselineCadences`/`resolveEffectiveSchedulesForPartner` (`aiAgents/scheduleService.ts:839/892`).
- Produces (w00-exact first parameter and return; second parameter additive):
  ```ts
  export type SpecialistRequester =
    | { kind: 'run' }                                   // default: requestedByRunId must be set
    | { kind: 'user'; auth: AuthContext }                // launch_specialist chat turn
    | { kind: 'approval'; intentId: string; auth: AuthContext }; // carrier release, approver's authority
  export type SpecialistRefusal =
    | 'wisp_disabled' | 'not_entitled' | 'grant_inactive' | 'org_out_of_ceiling' | 'depth_exceeded'
    | 'budget_exhausted' | 'permission_missing' | 'workspace_execute_required' | 'unknown_kind'
    | 'invalid_params' | 'device_not_in_org' | 'no_sweep_schedule' | 'no_effective_agent'
    | 'admission_skipped' | 'too_many_requests';
  export async function requestSpecialist(
    input: { grantId: string; grantRevisionId: string; orgId: string; kind: SpecialistKind; params: Record<string, unknown>; requestedByRunId: string | null },
    opts?: { requester?: SpecialistRequester; requestId?: string },
  ): Promise<{ admitted: true; runId?: string; taskId?: string } | { needsApproval: true; intentId: string } | { refused: string }>;
  export function specialistDedupeKey(requestId: string): string;      // `wisp-specialist-${requestId}`
  export function deriveRequestId(runId: string, ordinal: number): string; // uuid v5 over `${runId}:${ordinal}`, fixed namespace WISP_REQUEST_NS
  // specialistLaunchers.ts
  export type LaunchResult = { admitted: true; runId?: string; taskId?: string } | { refused: SpecialistRefusal; detail?: string };
  export async function launchSweep(ctx: LaunchContext): Promise<LaunchResult>;
  export async function launchAnalysis(ctx: LaunchContext): Promise<LaunchResult>;
  export async function launchOperatorRecipe(ctx: LaunchContext): Promise<LaunchResult>;
  export async function launchPatchPlan(ctx: LaunchContext): Promise<LaunchResult>;
  export async function launchRemediationResearch(ctx: LaunchContext): Promise<LaunchResult>;
  export interface LaunchContext { orgId: string; partnerId: string; grantorUserId: string; grant: { grantId: string; grantRevisionId: string; requestedByRunId: string | null }; requestId: string; params: Record<string, unknown> }
  ```
  `raiseSpecialistIntent` (approval path) is defined in Task 4 and imported lazily by the coordinator (`await import('./specialistIntent')`) to keep the coordinator free of the intent graph on the chat path.
- `SweepJobData` gains `grant?: CreateAgentRunInput['grant']`; `buildAdmission()`'s `sweep` branch forwards it.

**Gating order (the one body this plan writes; every gate is a unit case):**

```
1. wispEnabled()                                  else refused 'wisp_disabled'
2. hasEntitlement(partnerId, 'wisp')              else refused 'not_entitled'   (partnerId from the grant row)
3. ceiling = resolveGrantCeiling(grantId, rev)    GrantInactiveError → 'grant_inactive'
4. orgId ∈ ceiling.orgIds                         else 'org_out_of_ceiling'
5. requester 'run' ⇒ requestedByRunId required; requesting run must be depth 0 + profile 'assessment' + same grant (else 'depth_exceeded')
6. kind ∈ SPECIALIST_KINDS; params parse (zod per kind) else 'unknown_kind' / 'invalid_params'
7. chargeableUnderGrant(grantId, policy.estimateCents).ok   else 'budget_exhausted'
8. policy.requiredPermissions ⊆ ceiling.permissionKeys      else 'permission_missing' ('workspace_execute_required' when the missing key is ai_workspace:execute)
   requester 'user' | 'approval' ⇒ the same keys must also be held by requester.auth (userHasPermission) — same refusals
9. decision matrix:
                          requester 'run'      requester 'user'   requester 'approval'
   sweep                  launch               launch             launch
   analysis               launch               launch             launch
   operator_recipe        raise intent         launch             launch
   patch_plan             raise intent         launch             launch
   remediation_research   raise intent         launch             launch
   ("raise intent" = Task 4's raiseSpecialistIntent → { needsApproval, intentId }; idempotent on requestId)
10. launcher refusal → { refused }; admission skip → { refused: 'admission_skipped' } with the skip name in detail; wispMetrics.incSpecialistRequest(kind, outcome)
```

Launcher contracts (`specialistLaunchers.ts`):
- `launchSweep`: find the partner's enabled `sweep` baseline covering `orgId` (`resolveEffectiveSchedulesForPartner`); none → `no_sweep_schedule`; else `getAiAgentSweepQueue().add('occurrence', { scheduleId, occurrenceKey: \`wisp-${requestId}\`, orgIds: [orgId], grant }, { jobId: getSweepOccurrenceJobId(scheduleId, occurrenceKey) })`; returns `admitted` with no `runId` (the run is admitted by `processSweepOccurrence`, dedupe `sweep-<scheduleId>-<orgId>-wisp-<requestId>`). Going through the queue keeps the system-collected evidence step a sweep run depends on (`aiAgentSweepScheduler.ts:19–60`).
- `launchAnalysis`: `admitAnalysisRun({ orgId, requestedByUserId: grantorUserId, sessionId: null, goal: params.goal, deviceIds: params.deviceIds ?? [], siteId: params.siteId ?? null, stagedHandles: [], dedupeKey: specialistDedupeKey(requestId), grant })`; refusal → `admission_skipped` with the `AnalysisAdmissionRefusal` as detail.
- `launchOperatorRecipe`: `getRecipe(params.workflowKey, params.workflowVersion)` null → `invalid_params`; `resolveEffectiveAgentSystem(orgId, recipe.agentKind)` null → `no_effective_agent`; `admitServiceRecoveryTask({ orgId, agentId, objective: params.objective, originKind: 'chat', requesterUserId: grantorUserId, recipeInput: params.recipeInput, workflowKey, workflowVersion, clientIdempotencyKey: specialistDedupeKey(requestId), grant })` → `admitted { taskId }` (a `replayed: true` result is still `admitted`).
- `launchPatchPlan`: `resolveEffectiveAgentSystem(orgId, 'patch')`; `createAndEnqueueAgentRun({ orgId, kind: 'patch', triggerKind: 'manual', deviceId: null, profile: 'patch', dedupeKey: specialistDedupeKey(requestId), triggerRef: { source: 'wisp_specialist', requestId, requestedByUserId: grantorUserId, agentId }, grant })` — same shape as `routes/patchPlan.ts:66`.
- `launchRemediationResearch`: `params.deviceId` required; device must belong to `orgId` (system read) else `device_not_in_org`; `resolveEffectiveAgentSystem(orgId, 'research')`; `createAndEnqueueAgentRun({ orgId, kind: 'research', triggerKind: 'manual', deviceId, alertId: params.alertId ?? null, profile: 'remediation_research', dedupeKey, triggerRef: { source: 'wisp_specialist', requestId, requestedByUserId: grantorUserId }, grant })` (pins at `runService.ts:1264/1736`).
- Every launcher treats a `duplicate` skip on `specialistDedupeKey(requestId)` as success and resolves the existing row's id by `(org_id, dedupe_key)` — this is the idempotency the Review Focus item 3 pins.

- [ ] **Step 1: Write the failing coordinator tests** (mock `grantAuthority`, `budget`, the entitlement read, `specialistLaunchers`, `./specialistIntent`)

```ts
describe('requestSpecialist gating matrix', () => {
  it.each([
    ['sweep', 'run', 'admitted'], ['analysis', 'run', 'admitted'],
    ['operator_recipe', 'run', 'needsApproval'], ['patch_plan', 'run', 'needsApproval'], ['remediation_research', 'run', 'needsApproval'],
    ['operator_recipe', 'user', 'admitted'], ['patch_plan', 'approval', 'admitted'],
  ])('%s from %s → %s', async (kind, requester, expected) => {
    const r = await requestSpecialist(base({ kind }), { requester: requesterOf(requester) });
    expect(Object.keys(r)[0]).toBe(expected === 'admitted' ? 'admitted' : 'needsApproval');
  });
  it('refuses wisp_disabled when the flag is off and calls nothing', ...);
  it('refuses not_entitled before touching the grant', ...);
  it('refuses grant_inactive on GrantInactiveError', ...);
  it('refuses org_out_of_ceiling before any launcher call', ...);          // Review Focus 4
  it('refuses depth_exceeded when the requesting run is depth 1 or not an assessment', ...);
  it('refuses budget_exhausted for an auto-admit kind and records the metric', ...); // Review Focus 5
  it('refuses workspace_execute_required for analysis when the grantor lacks ai_workspace:execute', ...);
  it('refuses workspace_execute_required for analysis when the approver lacks it even though the grantor holds it', ...); // Review Focus 2
  it('is idempotent by requestId: the second call returns admitted with the same runId', ...);   // Review Focus 3
  it('deriveRequestId is stable for (runId, ordinal)', () => expect(deriveRequestId('r', 0)).toBe(deriveRequestId('r', 0)));
});
```
Launcher tests (`specialistLaunchers.test.ts`): sweep enqueues one job with `grant` in its data and the deterministic job id; analysis forwards `grant` and `requestedByUserId = grantorUserId`; operator_recipe uses `originKind: 'chat'`, `requesterUserId = grantorUserId`, `clientIdempotencyKey = wisp-specialist-<requestId>`; patch_plan `deviceId: null`; remediation_research refuses `device_not_in_org`.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/wisp/coordinator.test.ts src/services/wisp/specialistLaunchers.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `coordinator.ts`, `specialistLaunchers.ts`, and the `SweepJobData.grant` passthrough.** Params schemas per kind live in `specialistLaunchers.ts` as zod objects (`sweepParamsSchema` `{ sweepKinds?: AiSweepKind[] }`, `analysisParamsSchema` `{ goal: string.max(2000), deviceIds?: uuid[].max(25), siteId?: uuid }`, `operatorRecipeParamsSchema` `{ workflowKey, workflowVersion: int, objective: string.max(500), recipeInput: unknown }`, `patchPlanParamsSchema` `{}`, `researchParamsSchema` `{ deviceId: uuid, alertId?: uuid }`).

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/wisp/coordinator.test.ts src/services/wisp/specialistLaunchers.test.ts src/jobs/aiAgentSweepScheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/wisp/coordinator.ts apps/api/src/services/wisp/coordinator.test.ts apps/api/src/services/wisp/specialistLaunchers.ts apps/api/src/services/wisp/specialistLaunchers.test.ts apps/api/src/jobs/aiAgentSweepScheduler.ts
git commit -m "feat(wisp): specialist coordinator with auto-admit vs approval split and depth-1 pinning (W07)"
```

---

### Task 4: The approval card — `wisp_specialist_request` carrier intent

**Files:**
- Create: `apps/api/src/services/wisp/specialistIntent.ts`
- Create: `apps/api/src/services/wisp/specialistIntent.test.ts`
- Create: `apps/api/src/services/aiToolsWisp.ts` (registers the carrier in `aiTools`; pattern `services/aiToolsAiOperator.ts:65`)
- Create: `apps/api/src/services/aiToolsWisp.test.ts`
- Modify: `apps/api/src/services/aiTools.ts` (call `registerWispTools(aiTools)` beside `registerAiOperatorTools`)
- Modify: `apps/api/src/services/aiToolExposure.ts:15` (`HUMAN_ONLY_TOOLS` entry)
- Modify: `apps/api/src/services/aiGuardrails.ts` (`TIER3_SUPERVISED_TOOLS` :664, `TOOL_PERMISSIONS` :911, `buildApprovalDescription` :3060)
- Modify: `apps/api/src/services/aiToolSchemas.ts:192`, `apps/api/src/services/aiAgents/agentToolCatalog.ts:97`
- Modify: W05 `apps/api/src/services/aiAgents/assessmentProfile.ts` — add `export const ASSESSMENT_CARRIER_TOOLS = [WISP_SPECIALIST_REQUEST_TOOL] as const` and union it into `assessmentToolAllowlist(...)`'s result (release authority re-checks the run's snapshot allowlist, `agentReleaseAuthority.ts`). Keep it out of `ASSESSMENT_TOOL_ALLOWLIST` itself: W05's test asserts every name in that list has a Tier-1 `TOOL_TIERS` entry, and the carrier is untiered.
- Test: `apps/api/src/services/aiAgentSdkTools.registryParity.contract.test.ts` (human-only rule), `apps/api/src/services/actionIntents/effectDigestCoverage.contract.test.ts` (unaffected — supervised, not four_eyes), `apps/api/src/jobs/intentReleaseWorker.durable.contract.test.ts`

**Interfaces:**
- Consumes: `createActionIntent(auth, input)` (`intentService.ts:1193`) with `source: 'ai_agent'`; `buildAgentAuthContext(agent, run, org)` (`agentAuthContext.ts:86`); `buildApproverAuthContextForIntent(intent)` (`actorContext.ts:203`); W02 `agentReleaseAuthority` grant check; `requestSpecialist` (Task 3).
- Produces:
  ```ts
  export const WISP_SPECIALIST_REQUEST_TOOL = 'wisp_specialist_request';
  export interface WispSpecialistRequestArguments { requestId: string; kind: SpecialistKind; orgId: string; grantId: string; grantRevisionId: string; params: Record<string, unknown>; reason: string }
  export async function raiseSpecialistIntent(input: { requestedByRunId: string } & WispSpecialistRequestArguments): Promise<{ intentId: string }>;
  // aiToolsWisp.ts
  export async function wispSpecialistRequestHandler(input: Record<string, unknown>, auth: AuthContext, context?: { actionIntentId?: string }): Promise<string>;
  export function registerWispTools(aiTools: Map<string, AiTool>): void;
  ```
- Registry decisions: `HUMAN_ONLY_TOOLS.set('wisp_specialist_request', 'Approval carrier minted only by the Wisp coordinator under an assessment run; releasing it admits one specialist under the approver\'s authority, so it is never declared to chat, Helper or agents (Wisp spec §7.5).')`; `TIER3_SUPERVISED_TOOLS.add(...)` (one approver, no four-eyes, no effect-digest pin); `TOOL_PERMISSIONS.wisp_specialist_request = { resource: 'ai_sessions', action: 'use' }` (w00 A1; the kind's `requiredPermissions` are re-checked against the approver in coordinator gate 8); `TOOL_CAPABILITY.wisp_specialist_request = 'ai'` with the same "mapped for completeness, never reachable" comment as `operator_plan` (`agentToolCatalog.ts:386`); `toolInputSchemas.wisp_specialist_request = z.strictObject({ requestId: uuid, kind: enum(SPECIALIST_KINDS), orgId: uuid, grantId: uuid, grantRevisionId: uuid, params: record, reason: string.max(500) })`; **no** `TOOL_TIERS` entry and **no** MCP `tool()` (human-only means never tiered — `registryParity.contract.test.ts:humanOnlyProblems`). Not added to `AGENT_HUMAN_ONLY_TOOLS` (creation and release run under the assessment run's agent principal).
- `buildApprovalDescription` case: `Wisp wants to run ${kind label} at ${org name or id}: ${reason}`.

- [ ] **Step 1: Write the failing tests**

```ts
// specialistIntent.test.ts
it('mints under the assessment run agent principal with source ai_agent and the request arguments', async () => { /* spy createActionIntent; expect auth.principal.kind 'ai_agent', input.source 'ai_agent', input.toolName WISP_SPECIALIST_REQUEST_TOOL, input.input.requestId */ });
it('converges on the same intent when called twice with one requestId', async () => { /* second call returns the first intentId; createActionIntent called once or returns existing */ });
// aiToolsWisp.test.ts
it('refuses without actionIntentId: "runs only as the release of its own approved intent"', ...);
it('refuses when the intent is not approved/executing or decidedByUserId is null', ...);
it('refuses grant_inactive when the grant was paused after approval', ...);               // Review Focus 1
it('calls requestSpecialist with requester approval + the approver auth from buildApproverAuthContextForIntent', ...);
it('returns the same admitted result on a redelivered release', ...);
// registration contract (in aiToolsWisp.test.ts)
it('is human-only: in aiTools, in HUMAN_ONLY_TOOLS, in TIER3_SUPERVISED_TOOLS, not in TOOL_TIERS, no MCP declaration', () => {
  expect(aiTools.has(WISP_SPECIALIST_REQUEST_TOOL)).toBe(true);
  expect(HUMAN_ONLY_TOOLS.has(WISP_SPECIALIST_REQUEST_TOOL)).toBe(true);
  expect(TIER3_SUPERVISED_TOOLS.has(WISP_SPECIALIST_REQUEST_TOOL)).toBe(true);
  expect(TOOL_TIERS[WISP_SPECIALIST_REQUEST_TOOL]).toBeUndefined();
  expect(readFileSync(join(__dirname, 'aiAgentSdkTools.ts'), 'utf8')).not.toContain(WISP_SPECIALIST_REQUEST_TOOL);
  expect(AGENT_HUMAN_ONLY_TOOLS.has('workspace_launch_analysis')).toBe(true); // the landmine deny stays
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/wisp/specialistIntent.test.ts src/services/aiToolsWisp.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `specialistIntent.ts` (load agent/run/org system-scoped exactly as `checkAgentReleaseAuthority` does, build the agent auth, call `createActionIntent` with `actionLabel`, `reason`, `orgId`; catch the duplicate-idempotency path and return the live intent id), `aiToolsWisp.ts` (handler: require `context.actionIntentId`; load the intent system-scoped; require `actionName === WISP_SPECIALIST_REQUEST_TOOL`, `arguments.requestId === input.requestId`, `decidedByUserId`; `buildApproverAuthContextForIntent(intent)` null → error `approver_invalid`; call `requestSpecialist(args, { requester: { kind: 'approval', intentId, auth }, requestId })`; `{ refused }` → `JSON.stringify({ error: refused })`, else the admitted JSON), the registry entries, and `ASSESSMENT_CARRIER_TOOLS` in `assessmentProfile.ts`.

- [ ] **Step 4: Verify contracts still hold**

Run: `cd apps/api && npx vitest run src/services/wisp/specialistIntent.test.ts src/services/aiToolsWisp.test.ts src/services/aiAgentSdkTools.registryParity.contract.test.ts src/services/actionIntents/effectDigestCoverage.contract.test.ts src/jobs/intentReleaseWorker.durable.contract.test.ts src/services/aiAgents/agentToolCatalog.contract.test.ts src/services/aiToolPermissionsCatalogParity.contract.test.ts src/services/workspace/workspaceLaunchTool.registration.test.ts`
Expected: PASS (the last file byte-for-byte unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/wisp/specialistIntent.ts apps/api/src/services/wisp/specialistIntent.test.ts apps/api/src/services/aiToolsWisp.ts apps/api/src/services/aiToolsWisp.test.ts apps/api/src/services/aiTools.ts apps/api/src/services/aiToolExposure.ts apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiToolSchemas.ts apps/api/src/services/aiAgents/agentToolCatalog.ts apps/api/src/services/aiAgents/assessmentProfile.ts
git commit -m "feat(wisp): wisp_specialist_request approval carrier released under the approver's authority (W07)"
```

---

### Task 5: `request_specialist` outcome tool body and post-run dispatch

**Files:**
- Modify: W05 `apps/api/src/services/aiAgents/outcomeTools.ts` — the `request_specialist` arm of `buildOutcomeSdkTools` (replace the `{ refused: 'not_available_until_w07' }` stub body; the SDK handler lives here in W05, not in `assessmentProfile.ts`) and its description string
- Modify: W05 `packages/shared/src/types/wispConcerns.ts` (`AssessmentOutcome.specialistRequests` item type gains `reason`; add `specialistResults`) and `packages/shared/src/validators/wispConcerns.ts` (`requestSpecialistSchema` already carries `kind`, `params`, `reason` 10–500 after reconciliation — export `validateRequestSpecialist` beside it)
- Create: `apps/api/src/services/wisp/specialistDispatch.ts`
- Create: `apps/api/src/services/wisp/specialistDispatch.test.ts`
- Modify: `apps/api/src/services/aiAgents/runLoop.ts` (finalizer block ~3045–3095: call `dispatchSpecialistRequests` after W05's `finalizeAssessment`)
- Test: `apps/api/src/services/aiAgents/outcomeTools.test.ts` (W05 file; extend)

**Interfaces:**
- Consumes: W05 outcome-tool capture (validate-only handler, post-hook capture into `outcome.assessment.specialistRequests` — the `submit_task_step` posture, `aiAgents/tools/submitTaskStep.ts` header); `RunContext`, `LoopResult` (`runLoopTypes.ts:413/536`); `requestSpecialist`, `deriveRequestId`, `MAX_SPECIALIST_REQUESTS_PER_ASSESSMENT`.
- Produces:
  ```ts
  // request_specialist SDK shape (model-facing) = W05's requestSpecialistSchema
  { kind: z.enum(SPECIALIST_KINDS), params: z.record(z.unknown()), reason: z.string().min(10).max(500) }
  export function validateRequestSpecialist(input: unknown): SpecialistRequest;   // packages/shared validators, beside requestSpecialistSchema
  export interface SpecialistRequest { kind: SpecialistKind; params: Record<string, unknown>; reason: string }
  // AssessmentOutcome (W05 shared type) — specialistRequests: SpecialistRequest[] (captured, in call order; W05's item type widened with `reason`); gains
  specialistResults?: Array<{ requestId: string; kind: SpecialistKind } & ({ admitted: true; runId?: string; taskId?: string } | { needsApproval: true; intentId: string } | { refused: string })>;
  // specialistDispatch.ts
  export async function dispatchSpecialistRequests(ctx: RunContext, result: LoopResult): Promise<void>; // no-op unless run.profile === 'assessment' && run.grantId; caps at MAX_SPECIALIST_REQUESTS_PER_ASSESSMENT (extra → refused 'too_many_requests'); requestId = deriveRequestId(run.id, ordinal); writes outcome.assessment.specialistResults onto the persisted outcome
  ```
- The handler stays validate-only and returns `{ status: 'recorded' }`; it never calls the coordinator (spec §7.5: the deterministic coordinator admits, after the model's turn).

- [ ] **Step 1: Write the failing tests**

```ts
// outcomeTools.test.ts (W05 file)
it('request_specialist validates kind/params/reason and no longer returns not_available_until_w07', async () => {
  const out = await handlerFor(buildOutcomeSdkTools(['request_specialist'], …), 'request_specialist')({ kind: 'sweep', params: {}, reason: 'Backups failed twice at Greenwood' });
  expect(JSON.parse(out.content[0].text)).toEqual({ status: 'recorded' });
  await expect(handlerFor(…)({ kind: 'run_script', params: {}, reason: 'x' })).rejects.toThrow();
});
// specialistDispatch.test.ts
it('dispatches captured requests in order with deterministic request ids', async () => { /* 2 requests → requestSpecialist called with deriveRequestId(run.id, 0) and (run.id, 1), requestedByRunId run.id, grantId/revision from the run */ });
it('caps at MAX_SPECIALIST_REQUESTS_PER_ASSESSMENT and records too_many_requests for the rest', ...);
it('is a no-op for a non-assessment or grant-less run', ...);
it('persists specialistResults on the outcome, including refusals', ...);
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/aiAgents/outcomeTools.test.ts src/services/wisp/specialistDispatch.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the validator export, the handler body (the capture into `outcome.assessment.specialistRequests` is W05's and stays), `dispatchSpecialistRequests`, and the one call in `runLoop.ts` after `finalizeAssessment` (errors are caught and recorded as `refused: 'dispatch_failed'`; a dispatch failure never fails the assessment run).

- [ ] **Step 4: Verify**

Run: `cd apps/api && npx vitest run src/services/aiAgents/outcomeTools.test.ts src/services/wisp/specialistDispatch.test.ts src/services/aiAgents/runLoop.test.ts src/services/aiAgents/assessmentProfile.test.ts src/services/aiAgents/runFinalizers.assessment.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiAgents/outcomeTools.ts apps/api/src/services/aiAgents/outcomeTools.test.ts packages/shared/src/types/wispConcerns.ts packages/shared/src/validators/wispConcerns.ts apps/api/src/services/wisp/specialistDispatch.ts apps/api/src/services/wisp/specialistDispatch.test.ts apps/api/src/services/aiAgents/runLoop.ts
git commit -m "feat(wisp): request_specialist outcome tool body with post-run coordinator dispatch (W07)"
```

---

### Task 6: `launch_specialist` — the Tier-2 chat tool under a grant

**Files:**
- Modify: `apps/api/src/services/aiToolsWisp.ts` (add the handler + `aiTools.set('launch_specialist', …)`)
- Modify: `apps/api/src/services/aiAgentSdkTools.ts` (`TOOL_TIERS` :191 → `launch_specialist: 2`; MCP `tool()` in `createBreezeMcpServer` beside `send_endpoint_message` ~:2453; `SESSION_TOOL_DESCRIPTIONS`)
- Modify: `apps/api/src/services/aiToolSchemas.ts:192`, `apps/api/src/services/aiAgents/agentToolCatalog.ts:97` (`'ai'`), `apps/api/src/services/aiGuardrails.ts:911` (`{ resource: 'ai_sessions', action: 'use' }`, w00 A1), `apps/api/src/services/aiToolExposure.ts:40` (`AGENT_HUMAN_ONLY_TOOLS.add('launch_specialist')` with a comment citing spec §7.5)
- Test: `apps/api/src/services/aiToolsWisp.test.ts` (extend), `apps/api/src/services/aiGuardrails.agentPrincipal.contract.test.ts`, `apps/api/src/services/aiAgentSdkTools.registryParity.contract.test.ts`

**Interfaces:**
- Consumes: `AuthContext.wispGrant?: { grantId; grantRevisionId }` (W03 type; W04 stamps it on every chat turn under a grant — w00 A2); `requestSpecialist` with `requester: { kind: 'user', auth }`.
- Produces:
  ```ts
  export async function launchSpecialistHandler(input: { orgId: string; kind: SpecialistKind; params?: Record<string, unknown>; reason: string }, auth: AuthContext): Promise<string>;
  // resolution: auth.wispGrant absent → '{"error":"wisp_grant_required"}' (W03's string; the tool only works inside a Wisp session — spec §7.5 "a human chat turn under a grant"); else requestSpecialist({ grantId, grantRevisionId, orgId: input.orgId, kind, params, requestedByRunId: null }, { requester: { kind: 'user', auth }, requestId })
  // requestId = randomUUID() (a human asking twice means twice — routes/patchPlan.ts:74 posture)
  ```
- Input schema: `z.strictObject({ orgId: uuid, kind: enum(SPECIALIST_KINDS), params: record.optional(), reason: string.min(5).max(500) })`. Rate limit: add `launch_specialist: { limit: 10, windowSeconds: 3600 }` to `TOOL_RATE_LIMITS` (`services/aiToolRateLimits.ts:45`).

- [ ] **Step 1: Write the failing tests**

```ts
it('launch_specialist is tiered 2, agent-denied, permissioned ai_sessions:use, declared to MCP, schema present', () => {
  expect(TOOL_TIERS.launch_specialist).toBe(2);
  expect(AGENT_HUMAN_ONLY_TOOLS.has('launch_specialist')).toBe(true);
  expect(TOOL_PERMISSIONS.launch_specialist).toEqual({ resource: 'ai_sessions', action: 'use' });
  expect(toolInputSchemas.launch_specialist).toBeDefined();
  expect(TOOL_CAPABILITY.launch_specialist).toBe('ai');
  const server = createBreezeMcpServer(() => ({}) as never);
  expect((server.instance as any)._registeredTools.launch_specialist).toBeDefined();
});
it('returns {"error":"wisp_grant_required"} and calls nothing when auth.wispGrant is absent', ...);
it('passes auth.wispGrant\'s grantId/grantRevisionId, requester user + the session auth, requestedByRunId null to requestSpecialist', ...);
it('checkAgentGuardrails denies launch_specialist to an ai_agent principal above the allowlist', ...); // in agentPrincipal.contract.test
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/aiToolsWisp.test.ts src/services/aiGuardrails.agentPrincipal.contract.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the handler, the six registry entries, the deny-list entry, the rate limit, and a `SESSION_TOOL_DESCRIPTIONS` entry: "Ask Wisp to hand bounded work to a specialist agent (sweep, sandbox analysis, Operator recipe, patch plan, remediation research) under your active Wisp grant. Effects inside the specialist still need their own approval."

- [ ] **Step 4: Verify**

Run: `cd apps/api && npx vitest run src/services/aiToolsWisp.test.ts src/services/aiGuardrails.agentPrincipal.contract.test.ts src/services/aiAgentSdkTools.registryParity.contract.test.ts src/services/aiGuardrailsTierConfig.parity.test.ts src/services/aiToolPermissionsCatalogParity.contract.test.ts src/services/workspace/workspaceLaunchTool.registration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiToolsWisp.ts apps/api/src/services/aiToolsWisp.test.ts apps/api/src/services/aiAgentSdkTools.ts apps/api/src/services/aiToolSchemas.ts apps/api/src/services/aiAgents/agentToolCatalog.ts apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiToolExposure.ts apps/api/src/services/aiGuardrails.agentPrincipal.contract.test.ts
git commit -m "feat(wisp): launch_specialist Tier-2 chat tool routed through the coordinator (W07)"
```

---

### Task 7: "Wisp for <user>" provenance on run and task detail

**Files:**
- Modify: `packages/shared/src/types/aiAgents.ts` (`AiAgentRunDetailDto`), `packages/shared/src/types/aiOperator.ts` (`AiOperatorTaskListItemDto`)
- Modify: `apps/api/src/routes/aiAgents.ts` (run detail select ~1370–1400 + DTO assembly), `apps/api/src/services/aiOperator/taskReadService.ts` (`OperatorTaskRowInput` :113, projection :221)
- Modify: `apps/web/src/components/aiAgents/RunDetailPage.tsx` (meta `<dl>` at ~1845), `apps/web/src/components/aiOperator/OperatorTaskDetail.tsx` (origin `<dl>` at ~245)
- Modify: `apps/web/src/locales/en/settings.json` (`aiAgentsPage.runs.detail.labels.wispFor`), `apps/web/src/locales/en/aiOperator.json` (`operatorTaskDetail.wispFor`), plus the same keys in the seven other locale directories
- Test: `apps/api/src/routes/aiAgents.test.ts`, `apps/api/src/services/aiOperator/taskReadService.test.ts`, `apps/web/src/components/aiAgents/RunDetailPage.test.tsx`, `apps/web/src/components/aiOperator/OperatorTaskDetail.test.tsx`, `apps/web/src/lib/i18n/localeParity*.test.ts`

**Interfaces:**
- Produces (additive; `AI_OPERATOR_TASK_DTO_SCHEMA_VERSION` stays 1):
  ```ts
  export interface WispProvenanceDto { grantId: string; grantorUserId: string; grantorName: string | null; depth: 0 | 1; requestedByRunId: string | null }
  AiAgentRunDetailDto.wisp: WispProvenanceDto | null;
  AiOperatorTaskListItemDto.wisp: WispProvenanceDto | null;
  ```
- API: left-join `wisp_grants` (W02 table) → `users.name` under the request context (the partner SELECT branch admits the partner's own users). Web copy: `"wispFor": "Wisp for {{name}}"`; when `grantorName` is null render the uuid prefix the page already uses for bare ids (`RunDetailPage.tsx:906` convention).

- [ ] **Step 1: Write the failing tests**

```ts
// aiAgents.test.ts
it('GET /runs/:id returns wisp provenance for a grant-bearing run and null otherwise', ...);
// taskReadService.test.ts
it('projects wisp provenance from grant_id + grantor', ...);
// RunDetailPage.test.tsx
it('renders "Wisp for Todd" in the meta grid when run.wisp is set', () => { render(…); expect(screen.getByTestId('run-detail-wisp')).toHaveTextContent('Wisp for Todd'); });
it('renders nothing wisp-related when run.wisp is null', ...);
// OperatorTaskDetail.test.tsx — same pair with data-testid 'operator-task-wisp'
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/routes/aiAgents.test.ts src/services/aiOperator/taskReadService.test.ts; cd ../web && npx vitest run src/components/aiAgents/RunDetailPage.test.tsx src/components/aiOperator/OperatorTaskDetail.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** the DTO fields, the joins, the two `<div><dt/><dd data-testid=…/></div>` rows, and the locale keys in all eight locale directories.

- [ ] **Step 4: Verify**

Run the four files above plus `cd apps/web && npx vitest run src/lib/i18n`.
Expected: PASS (locale parity green).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/aiAgents.ts packages/shared/src/types/aiOperator.ts apps/api/src/routes/aiAgents.ts apps/api/src/routes/aiAgents.test.ts apps/api/src/services/aiOperator/taskReadService.ts apps/api/src/services/aiOperator/taskReadService.test.ts apps/web/src/components/aiAgents/RunDetailPage.tsx apps/web/src/components/aiAgents/RunDetailPage.test.tsx apps/web/src/components/aiOperator/OperatorTaskDetail.tsx apps/web/src/components/aiOperator/OperatorTaskDetail.test.tsx apps/web/src/locales
git commit -m "feat(wisp): 'Wisp for <user>' provenance on run and task detail (W07)"
```

---

### Task 8: Metrics

**Files:**
- Create: `apps/api/src/services/wispMetrics.ts` (leaf: imports only `./metricsRegistry`, like `aiWorkspaceMetrics.ts`)
- Create: `apps/api/src/services/wispMetrics.test.ts`
- Modify (one `inc*` call each): W02 `services/wisp/grants.ts` `pauseGrant`; W05 `services/wisp/assessment.ts` `enqueueAssessment`, `services/wisp/budget.ts` `chargeableUnderGrant`, `services/wisp/concerns.ts` `upsertConcern`/`resolveConcern`, `jobs/wispWakeScheduler.ts` `processWakeTick` (`setWispGrantsActive`); W06 `services/wisp/notifyUser.ts`; Task 3 `coordinator.ts`

**Interfaces:**
```ts
export function incWispAssessment(outcome: 'admitted' | 'skipped_budget' | 'skipped_grant' | 'skipped_admission'): void;   // wisp_assessments_total{outcome}
export function incWispNudge(result: 'sent' | 'suppressed_quiet_hours' | 'suppressed_prefs' | 'suppressed_backoff'): void; // wisp_nudges_total{result}
export function incWispConcern(transition: 'opened' | 'updated' | 'resolved' | 'dismissed' | 'snoozed'): void;             // wisp_concerns_total{transition}
export function incWispGrantPause(reason: 'grantor_access_lost' | 'grantor_suspended' | 'factor_expired' | 'entitlement_lost' | 'budget_exhausted'): void; // wisp_grant_pauses_total{reason}
export function incWispBudgetExhausted(): void;                                                                             // wisp_budget_exhausted_total
export function incSpecialistRequest(kind: SpecialistKind, outcome: 'admitted' | 'needs_approval' | 'refused'): void;       // wisp_specialist_requests_total{kind,outcome}
export function setWispGrantsActive(count: number): void;                                                                    // wisp_grants_active (gauge; set by the W05 tick)
```
No partner label on any series (cardinality); per-partner "assessments today" is served by Task 9's admin API from `ai_agent_runs` instead.

- [ ] **Step 1: Write the failing test**

```ts
it('registers the seven wisp_* series on metricsRegistry with the documented label sets', async () => {
  incSpecialistRequest('sweep', 'admitted'); incWispGrantPause('budget_exhausted');
  const text = await metricsRegistry.metrics();
  expect(text).toMatch(/wisp_specialist_requests_total\{kind="sweep",outcome="admitted"\} 1/);
  expect(text).toMatch(/wisp_grant_pauses_total\{reason="budget_exhausted"\} 1/);
  for (const n of ['wisp_assessments_total','wisp_nudges_total','wisp_concerns_total','wisp_budget_exhausted_total','wisp_grants_active']) expect(text).toContain(`# HELP ${n}`);
});
it('is a leaf module (imports only metricsRegistry)', () => { expect(readFileSync(…'wispMetrics.ts').match(/^import .* from '(.*)'/gm)).toEqual([expect.stringContaining("'./metricsRegistry'")]); });
```

- [ ] **Step 2: Run to verify failure** — `cd apps/api && npx vitest run src/services/wispMetrics.test.ts` → FAIL.

- [ ] **Step 3: Implement** the module and the instrumentation calls (each W02/W05/W06 call site gets one line; add a case to each module's existing unit test asserting the counter function was called).

- [ ] **Step 4: Verify** — `cd apps/api && npx vitest run src/services/wispMetrics.test.ts src/services/wisp src/services/workerEntrypointClosure.contract.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/wispMetrics.ts apps/api/src/services/wispMetrics.test.ts apps/api/src/services/wisp
git commit -m "feat(wisp): prometheus series for assessments, nudges, concerns, grant pauses, budget and specialists (W07)"
```

---

### Task 9: Platform-admin Wisp overview page

**Files:**
- Create: `apps/api/src/routes/admin/wisp.ts`, `apps/api/src/routes/admin/wisp.test.ts`
- Create: `apps/api/src/services/wisp/adminOverview.ts`, `apps/api/src/services/wisp/adminOverview.test.ts`
- Modify: `apps/api/src/routes/admin/index.ts` (`adminRoutes.route('/wisp', wispAdminRoutes)`)
- Create: `apps/web/src/pages/admin/wisp.astro`, `apps/web/src/components/admin/WispAdminPage.tsx`, `apps/web/src/components/admin/WispAdminPage.test.tsx`
- Modify: `apps/web/src/components/layout/Sidebar.tsx` (~:467, after AI Kill Switch: `{ name: 'Wisp', labelKey: 'nav.wisp', href: '/admin/wisp', icon: Sparkles, platformAdminOnly: true }`), `apps/web/src/locales/en/common.json` (`nav.wisp`), `apps/web/src/locales/en/pages.json` (`titles.adminWisp`), `apps/web/src/locales/en/admin.json` (`wisp.*` block) + the seven other locales

**Interfaces:**
```ts
// adminOverview.ts — read-only, caller wraps in runOutsideDbContext(withSystemDbAccessContext) exactly as routes/admin/aiToolUsage.ts:16 does
export interface WispPartnerOverviewRow { partnerId: string; partnerName: string; plan: string; activeGrants: number; pausedGrants: Record<string, number>; assessmentsToday: number; specialistRequestsToday: number; openConcerns: number; budgetExhaustedGrantsToday: number }
export async function buildWispOverview(): Promise<WispPartnerOverviewRow[]>;
export interface WispGrantAdminRow { id: string; orgId: string | null; grantorUserId: string; grantorName: string | null; status: WispGrantStatus; pausedReason: string | null; expiresAt: string; budgetCentsPerDay: number; floorTickMinutes: number; currentRevisionId: string; assessmentsToday: number }
export async function listGrantsForPartner(partnerId: string): Promise<WispGrantAdminRow[]>;
// routes: GET /api/v1/admin/wisp/overview → { partners: WispPartnerOverviewRow[] }; GET /api/v1/admin/wisp/grants?partnerId=<uuid> → { grants: WispGrantAdminRow[] } (zod query; 400 otherwise)
```
Both routes 404 when `!wispEnabled()` (same posture as W02's `wispRoutes`); read-only, so no MFA.

- [ ] **Step 1: Write the failing tests**

```ts
// wisp.test.ts (route)
it('403s a non-platform-admin (platformAdminMiddleware)', ...);
it('404s when wispEnabled() is false', ...);
it('returns the overview rows under a system read', ...);
it('400s /grants without a uuid partnerId', ...);
// adminOverview.test.ts — counts assessmentsToday from ai_agent_runs (profile assessment, grant_id in partner grants, queued_at ≥ UTC midnight)
// WispAdminPage.test.tsx
it('renders one row per partner and expands a partner to list its grants', ...);
it('shows the platform-admin lock state on 403 like AiKillSwitch', ...);
```

- [ ] **Step 2: Run to verify failure** → FAIL (modules missing).

- [ ] **Step 3: Implement** service, routes, mount, astro page (`<DashboardLayout titleKey="titles.adminWisp"><WispAdminPage client:load /></DashboardLayout>`), component (fetch via `fetchWithAuth`; no mutations, so no `runAction`), sidebar entry, locale keys ×8.

- [ ] **Step 4: Verify**

Run: `cd apps/api && npx vitest run src/routes/admin/wisp.test.ts src/services/wisp/adminOverview.test.ts; cd ../web && npx vitest run src/components/admin/WispAdminPage.test.tsx src/lib/i18n`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/admin/wisp.ts apps/api/src/routes/admin/wisp.test.ts apps/api/src/routes/admin/index.ts apps/api/src/services/wisp/adminOverview.ts apps/api/src/services/wisp/adminOverview.test.ts apps/web/src/pages/admin/wisp.astro apps/web/src/components/admin/WispAdminPage.tsx apps/web/src/components/admin/WispAdminPage.test.tsx apps/web/src/components/layout/Sidebar.tsx apps/web/src/locales
git commit -m "feat(wisp): platform-admin overview of active grants per partner (W07)"
```

---

### Task 10: Todd's private gap-finder (system scope, CLI only)

**Files:**
- Create: `apps/api/scripts/wisp-gap-finder.ts` (entrypoint; pattern `scripts/recover-stuck-agents.ts`)
- Create: `apps/api/scripts/wisp-gap-finder.lib.ts` (pure: snapshot → prompt; model JSON → markdown)
- Create: `apps/api/scripts/wisp-gap-finder.lib.test.ts`
- Create: `apps/api/scripts/wisp-gap-finder.registration.test.ts`
- Modify: `apps/api/package.json` (`"wisp:gap-finder": "tsx scripts/wisp-gap-finder.ts"`)

**Interfaces:**
```ts
// wisp-gap-finder.lib.ts
export interface PartnerSnapshot { partner: { id: string; name: string; plan: string }; orgs: Array<{ id; name; deviceCount; siteCount; monitorCount; alertRuleCount; ticketRuleCount; policyCount; integrationKinds: string[]; portalEnabled: boolean; contactCount: number }>; collectedAt: string }
export function buildGapFinderPrompt(snapshot: PartnerSnapshot): { system: string; user: string }; // setup-designer framing (spec §11): "set this partner up to manage its customers; report what Breeze itself is missing"; wraps the snapshot with wrapUntrustedData (`services/aiInputSanitizer.ts:286`)
export interface GapFinding { area: 'monitors' | 'alert_routing' | 'ticket_rules' | 'deliverables' | 'portals' | 'contacts' | 'sites' | 'other'; title: string; evidence: string; suggestion: string; severity: 'low' | 'medium' | 'high' }
export function parseGapFindings(modelText: string): GapFinding[];      // strict JSON; throws on drift
export function renderGapReport(snapshot: PartnerSnapshot, findings: GapFinding[]): string; // markdown, no hostnames/IPs/tokens
export function resolveReportPath(repoRoot: string, partnerId: string, now: Date): string;  // `${repoRoot}/internal/wisp-gap-reports/${YYYY-MM-DD}-${partnerId}.md`; throws unless under `${repoRoot}/internal/`
```
Entrypoint: `pnpm --filter @breeze/api wisp:gap-finder --partner <uuid> [--dry-run]`. Reads under `withSystemDbAccessContext` only (read-only queries, no writes), builds the snapshot, calls the Agent SDK `query()` once (`allowedTools: []`, `maxTurns: 1`, model from the partner's resolved registry role via `agentModelRole.ts`, the same client `runLoop.ts` uses), parses, renders, writes the report, exits 0; `--dry-run` prints the prompt and writes nothing. Exits 2 without `--partner`. It is never imported from `src/`, never registered as a tool, and never mounted as a route.

- [ ] **Step 1: Write the failing tests**

```ts
// wisp-gap-finder.lib.test.ts
it('prompt wraps the snapshot as untrusted data and names the eight gap areas', ...);
it('parseGapFindings rejects non-JSON and unknown areas', ...);
it('renderGapReport contains no IPv4 literal, hostname-like token or secret-looking string', () => { expect(md).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/); expect(md).not.toMatch(/sk-[A-Za-z0-9]{10,}/); });
it('resolveReportPath refuses a path outside internal/', () => expect(() => resolveReportPath('/repo', '../x', d)).toThrow());
// wisp-gap-finder.registration.test.ts
it('is not a tool, route or import of src/', () => {
  expect([...aiTools.keys()].some((n) => /gap_finder|gap-finder/.test(n))).toBe(false);
  expect(TOOL_TIERS).not.toHaveProperty('wisp_gap_finder');
  expect(execSync("grep -rl 'wisp-gap-finder' src || true", { cwd: apiRoot }).toString().trim()).toBe('');
});
```

- [ ] **Step 2: Run to verify failure** — `cd apps/api && npx vitest run scripts/wisp-gap-finder.lib.test.ts scripts/wisp-gap-finder.registration.test.ts` → FAIL.

- [ ] **Step 3: Implement** lib + entrypoint + package script.

- [ ] **Step 4: Verify** — same command → PASS; `pnpm --filter @breeze/api wisp:gap-finder --dry-run --partner 00000000-0000-0000-0000-000000000000` against the test stack prints a prompt and writes nothing.

- [ ] **Step 5: Commit**

```bash
git add apps/api/scripts/wisp-gap-finder.ts apps/api/scripts/wisp-gap-finder.lib.ts apps/api/scripts/wisp-gap-finder.lib.test.ts apps/api/scripts/wisp-gap-finder.registration.test.ts apps/api/package.json
git commit -m "chore(wisp): system-scope gap-finder CLI writing reports under internal/ (W07)"
```

---

### Task 11: Docs, release-notes draft, env sweep, rollout checklist

**Files:**
- Create: `apps/docs/src/content/docs/features/wisp.mdx`
- Modify: `apps/docs/astro.config.mjs` (add `{ slug: 'features/wisp' }` after `features/ai-analysis-runs`, line 66)
- Modify: `packages/shared/src/utils/docsMapping.ts` (`{ pattern: '/ai/wisp', docsPath: '/features/wisp/', label: 'Wisp' }` before the `/ai-agents` entries ~:241) and `docsMapping.test.ts`
- Modify: `scripts/docs-review/mapping.json` (`apps/api/src/services/wisp/**` → `features/wisp.mdx`; `apps/api/src/routes/admin/wisp.ts` → `features/wisp.mdx`)
- Modify: `docs/release-notes/next-release-draft.md` (one entry under "Features / API", one under "Self-Hosting / Upgrade Notes", the migration under "Migrations")
- Create: `docs/deploy/wisp-rollout.md`
- Modify: `.env.example` (~:1453) and `deploy/.env.example` (~:529): verify W02's `BREEZE_WISP_ENABLED` block sits beside `BREEZE_AI_WORKSPACE_ENABLED`; add it if W02 missed either file
- Regenerate: `apps/api/src/data/docsIndex.json` via `npx tsx scripts/build-docs-index.ts`
- Test: `packages/shared/src/utils/docsMapping.test.ts`, `apps/api/src/config/envReadComposeCoverage.test.ts`, `apps/api/src/config/validate.test.ts`

**Content decisions:**
- `features/wisp.mdx` sections (admin voice per `update-breeze-docs`): What Wisp is · Turning it on (plan availability — Pro/Enterprise/Unlimited; `FeatureLock` copy for others; step-up when creating a grant) · Grants (self-only, scope, expiry, refresh, pause reasons, revoke) · What Wisp does alone vs asks first (the spec §3 table in product language) · Nudges and quiet hours · Memory (confirm/retract) · Budgets (defaults 200/500/1000 ¢ per day by plan, raise to 5×, what happens when exhausted) · Specialists (what a request is, which kinds need a yes, where provenance shows) · Self-hosted: an `<Aside type="caution">` stating the capability is absent, not locked (D-I), mirroring `ai-analysis-runs.mdx:14`.
- `docs/deploy/wisp-rollout.md` checklist (no hosts/IPs): 1) env on hosted API+worker: `BREEZE_AI_AGENTS_ENABLED=true`, `BREEZE_WISP_ENABLED=true`, `IS_HOSTED=true`; `BREEZE_AI_WORKSPACE_ENABLED` + Vercel vars only if `analysis` specialists are wanted; 2) migrations `2027-01-04-100100` … `100600` applied on both regions; 3) entitlement defaults from `ENTITLEMENT_KEYS.wisp` verified via `GET /partner/me/entitlements` on a Pro partner; Community partners get a manual grant (spec §16); 4) permission check — run `SELECT p.partner_id FROM roles r JOIN role_permissions rp ON rp.role_id = r.id JOIN permissions pm ON pm.id = rp.permission_id JOIN partners p ON p.id = r.partner_id WHERE r.name = 'Partner Admin' AND r.is_system AND pm.resource = '*' AND pm.action = '*'` and compare against `SELECT id FROM partners`; any partner missing the wildcard row gets `ai_workspace:execute` granted through the Roles UI (no migration — `*:*` covers the rest); 5) kill-switch rehearsal: `BREEZE_WISP_ENABLED=false` → routes 404, assessments skip, grants untouched; 6) alert rules on `wisp_grant_pauses_total{reason="budget_exhausted"}` and `wisp_specialist_requests_total{outcome="refused"}`; 7) flag-flip order: EU first, watch `/admin/wisp` for 24 h, then US; 8) rollback: flag off (data stays), never a migration revert.
- Release-notes draft entries (operator-facing, per `update-breeze-release-notes` tone): "Wisp (hosted, paid plans) — a continuous triage companion … dark unless `BREEZE_WISP_ENABLED=true`" ; upgrade note naming the six migrations and that nothing changes with the flag unset; migration list line for `2027-01-04-100600-wisp-specialist-lineage.sql` ("three nullable/defaulted columns on `ai_agent_runs` and `ai_operator_tasks`; DDL only").

- [ ] **Step 1: Write the failing test** — add to `docsMapping.test.ts`: `it('maps /ai/wisp/thread/:id to the Wisp feature page', () => expect(getDocsForPath('/ai/wisp/thread/abc').url).toContain('/features/wisp/'))` (`getDocsForPath(pathname, hash?)` at `docsMapping.ts:272`).

- [ ] **Step 2: Run to verify failure** — `cd packages/shared && npx vitest run src/utils/docsMapping.test.ts` → FAIL.

- [ ] **Step 3: Write** the docs page, sidebar, mapping entries, rollout doc, release-notes draft entries, env-example sweep, and regenerate the docs index.

- [ ] **Step 4: Verify**

Run: `cd packages/shared && npx vitest run src/utils/docsMapping.test.ts; cd ../../apps/docs && pnpm build 2>&1 | tail -5; cd ../api && npx vitest run src/config/envReadComposeCoverage.test.ts src/config/validate.test.ts`
Expected: PASS; docs build clean; `grep -c BREEZE_WISP_ENABLED .env.example deploy/.env.example` → ≥1 each.

- [ ] **Step 5: Commit**

```bash
git add apps/docs/src/content/docs/features/wisp.mdx apps/docs/astro.config.mjs packages/shared/src/utils/docsMapping.ts packages/shared/src/utils/docsMapping.test.ts scripts/docs-review/mapping.json docs/release-notes/next-release-draft.md docs/deploy/wisp-rollout.md .env.example deploy/.env.example apps/api/src/data/docsIndex.json
git commit -m "docs(wisp): feature page, rollout checklist, release-notes draft and env sweep (W07)"
```

---

## Pre-PR verification (whole wave)

- [ ] `cd apps/api && npx vitest run src/services/wisp src/services/aiToolsWisp.test.ts src/services/wispMetrics.test.ts src/routes/admin/wisp.test.ts scripts/wisp-gap-finder` → PASS.
- [ ] Contract set: `npx vitest run src/services/aiAgentSdkTools.registryParity.contract.test.ts src/services/aiGuardrails.agentPrincipal.contract.test.ts src/services/aiGuardrails.workspaceToolSurface.contract.test.ts src/services/workspace/workspaceLaunchTool.registration.test.ts src/services/actionIntents/effectDigestCoverage.contract.test.ts src/jobs/intentReleaseWorker.durable.contract.test.ts src/services/aiAgents/agentToolCatalog.contract.test.ts src/services/aiToolPermissionsCatalogParity.contract.test.ts src/services/workerEntrypointClosure.contract.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts` → PASS.
- [ ] Integration (test stack up): `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/agentRunAdmission.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts` and `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage` → PASS.
- [ ] Integration case this wave owns (add to `agentRunAdmission.integration.test.ts` in Task 2 or a new `wispSpecialists.integration.test.ts`): a grant-bearing `assessment` run requesting `analysis` whose grantor's ceiling lacks `ai_workspace:execute` → `refused: 'workspace_execute_required'` and **no** `ai_agent_runs` row with `dedupe_key = wisp-specialist-<id>`.
- [ ] `pnpm test-stack down`; `pnpm db:check-drift` clean.
- [ ] PR body states: flag off = no behaviour change; tenancy registrations (export-policy columns on `ai_agent_runs`/`ai_operator_tasks`; no new tables); contract names consumed (W02 grants/ceiling/`grant` admission input/`GrantDepthExceededError`, W03 `AuthContext.wispGrant`, W05 `assessment` profile + `chargeableUnderGrant` + `requestSpecialistSchema`, W06 `notifyUser`) and introduced (`requestSpecialist`, `SpecialistKind`, `wisp_specialist_request`, `launch_specialist`, `ASSESSMENT_CARRIER_TOOLS`, the three lineage columns); settings rule 9 — this wave adds no setting (the auto-admit set is code-owned; count of places configured: 0 → 0).

## Calls made by the planner

1. **Auto-admit set is code-owned** (`SPECIALIST_KIND_POLICY`: `sweep`, `analysis`), because no partner-level auto-approved T2 set exists in code; a partner override is a named follow-up.
2. **Approval card = agent-minted supervised Tier-3 carrier** (`wisp_specialist_request`, modelled on `operator_plan` but minted under the assessment run's agent principal) so the grantor can one-tap it; release rebuilds the *approver's* authority and re-runs every coordinator gate.
3. **"Under the approver's session"** is implemented as "under the approver's authority" (`buildApproverAuthContextForIntent`); the durable release worker has no chat session.
4. **Human chat turns admit every kind directly** (the human is present and the session's own approval mode applies to the Tier-2 tool); the specialist's internal effects still mint their own intents.
5. **Lineage as columns** (`requested_by_run_id`, `parent_grant_revision_id`, `depth`) on both `ai_agent_runs` and `ai_operator_tasks`; `ai_agent_runs` has no metadata column and `trigger_ref` is caller-forwarded jsonb, so columns are the only trustworthy, exportable home.
6. **Depth guard input** is W02's `grant.requestedByRunId` with W02's thrown `GrantDepthExceededError` (w00 A11); W07 only tightens the predicate with the lineage columns.
7. **Sweep specialists go through the sweep queue** (one-off occurrence with `grant` in the job data) rather than a bare run admission, so system-collected evidence still precedes the run.
8. **No Partner Admin backfill migration**: the seeded role is `*:*`; the rollout doc carries the verification query.
9. **No partner label on Prometheus series**; per-partner counts live on the platform-admin page.
10. **Release-notes draft goes to `docs/release-notes/next-release-draft.md`** (the in-repo file `/release` reads); the marketing-site file lives in another repository and is written at release time.
11. **Gap-finder is a CLI** (`apps/api/scripts/wisp-gap-finder.ts`), one Agent SDK `query()` with no tools, reports under `internal/wisp-gap-reports/`; never a route or a tool.
12. **Specialist budget estimates** (25/100/50/50/50 ¢) and `MAX_SPECIALIST_REQUESTS_PER_ASSESSMENT = 3` are planner defaults; admission's own reservations remain the real meter.

### Reconciliation edits (reviewer)

- Depth guard: W02 already ships `grant.requestedByRunId` and throws `GrantDepthExceededError` (w00 A11); Task 2 no longer adds a `grant_depth_exceeded` skip reason — it tightens W02's predicate, catches the error in `analysisAdmission` as `grant_refused`, and the integration case expects a rejection.
- `request_specialist` body lives in W05's `outcomeTools.ts` `buildOutcomeSdkTools` arm (not `assessmentProfile.ts`); the capture target is W05's existing `outcome.assessment.specialistRequests`; the Zod shape is W05's `requestSpecialistSchema` (reason 10–500) rather than a second `REQUEST_SPECIALIST_SHAPE`; test moved to `outcomeTools.test.ts`.
- The carrier joins the assessment allowlist through a separate `ASSESSMENT_CARRIER_TOOLS` constant so W05's "every allowlisted name is Tier 1" test keeps passing.
- `TOOL_PERMISSIONS` for `launch_specialist` and `wisp_specialist_request` → `ai_sessions:use` (w00 A1); per-kind `requiredPermissions` remain ceiling terms (gate 8). Review Focus 2 reworded.
- `launch_specialist` reads `AuthContext.wispGrant` (w00 A2; stamped by W04) instead of `getActiveGrantForUser`, returning W03's `wisp_grant_required` outside a Wisp session; tests rewritten.
- Task 3 consumes W01's `hasEntitlement(partnerId, 'wisp')` by name; `getActiveGrantForUser` dropped from its consumes list.
- Task 8 adds the `setWispGrantsActive` call site (W05's wake tick) that the gauge's comment promised.

## 2026-10-23 amendments (w00 A30, A33) — tasks added by the orchestrator

### Task 1 edits (`specialistPolicy.ts`)

`SpecialistKind` gains `'bulk_ticket_reply'` with `{ autoAdmit: false, requiredPermissions: ['ai_agents:write', 'tickets:write'], estimateCents: 50, requiresDevice: false }`. The leaf-module and "auto-admits exactly sweep + analysis" tests stay true.

### Task 12: `bulk_ticket_reply` — the pinned batch (w00 A30; Grok IncidentSweep)

**Files:**
- Create: `apps/api/src/services/wisp/specialists/bulkTicketReply.ts` (+ `.test.ts`), `apps/api/src/services/aiOperator/recipes/bulkTicketReply.ts` (+ test) if the Operator recipe registry is the executor (preferred) — otherwise a dedicated worker job
- Modify: Task 3's coordinator (`requestSpecialist` switch), Task 4's carrier intent (card body = ticket list + exact message + digest), Task 6's `launch_specialist` schema (`params` for this kind), `packages/shared/src/validators/wisp.ts`

**Interfaces:**
```ts
export const bulkTicketReplyParamsSchema = z.strictObject({ concernId: z.string().uuid().nullable(), ticketIds: z.array(z.string().uuid()).min(1).max(250), message: z.string().min(1).max(4000), holdTickets: z.boolean().default(false), internalNote: z.string().max(1000).optional() });
export function bulkReplyDigest(p: { ticketIds: string[]; message: string }): string;   // sha256 of sorted ticketIds joined by ',' + '\n' + message — the intent's resource digest; the executor recomputes it from the stored params and refuses on mismatch
export async function executeBulkTicketReply(input: { taskId: string; grantId: string; grantRevisionId: string; orgId: string; params: BulkTicketReplyParams; pinnedDigest: string }): Promise<{ sent: string[]; skipped: Array<{ ticketId: string; reason: 'not_in_set' | 'not_in_org' | 'closed' | 'out_of_ceiling' }>; stoppedAt: { ticketId: string; error: string } | null }>;
//   every ticket must be in params.ticketIds (the pinned set), belong to orgId, be non-closed and pass assertWithinCeiling({ orgId, permission: 'tickets:write' }); batches of 10; one audit row per ticket ('ticket.reply.sent', details { taskId, grantId, concernId }); holdTickets ⇒ status 'pending' + internalNote before sending; the FIRST failure stops the batch and the task finishes 'partial' with the report; nothing is ever added after approval.
```
- Partner-level incident concerns (W05 A30) propose this kind with `ticketIds` = the union of child evidence; the card is minted under the **assessment run's** agent principal in the incident's **first** org (an org is required for an intent) and lists tickets across orgs grouped by org; execution fans out one Operator task per org with that org's subset and the same digest input (the digest covers the full set; each task carries the full set and its own `orgId`, and skips the other orgs' tickets as `not_in_org`). Document this in the card body.
- [ ] **Step 1: Failing tests** — digest is order-independent on ticketIds and sensitive to the message; a ticket outside the pinned set is skipped `not_in_set` and audited; a closed ticket is skipped; the third ticket failing stops the batch, `sent` has two ids, state `partial`; `holdTickets` sets pending + note before any send; a tampered params row (digest mismatch) refuses before the first send.
- [ ] **Step 2–4:** run → FAIL, implement, run with Tasks 3/4/6 suites — PASS. Commit `feat(wisp): bulk_ticket_reply specialist — pinned set, batched, stop-on-first-failure (W07 T12, w00 A30)`.

### Task 10 edit (gap-finder, w00 A33)

The gap-finder's first context block is `readinessInventory` (W05 Task 15) for the lab partner; gaps it reports distinguish "Breeze lacks the integration" from "this partner has not configured it".
